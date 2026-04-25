/**
 * Main-process authentication client.
 *
 * Session and cookie persistence are delegated to Better Auth's Electron client,
 * which stores auth state encrypted via Electron safeStorage. This wrapper keeps
 * the renderer-facing shapes and IPC expectations used by Hydra's main process.
 */

import { app, BrowserWindow } from "electron";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  emailVerified: boolean;
}

export interface AuthSession {
  user: AuthUser;
  expiresAt: string;
}

export interface AuthResult {
  success: boolean;
  error?: string;
  twoFactorRedirect?: boolean;
  session?: AuthSession;
}

export interface HydraAuthClientSetupOptions {
  bridges?: boolean;
  csp?: boolean;
  getWindow?: () => BrowserWindow | null | undefined;
  scheme?: boolean;
}

type HydraAuthClientOptions = {
  getWindow?: () => BrowserWindow | null | undefined;
  onSessionChanged?: (session: AuthSession | null) => void;
};

export interface HydraAuthRequestOptions {
  additionalData?: Record<string, unknown>;
  callbackURL?: string;
  disableRedirect?: boolean;
  errorCallbackURL?: string;
  newUserCallbackURL?: string;
  provider?: string;
  requestSignUp?: boolean;
  scopes?: string[];
}

type BetterAuthError = {
  message?: string;
  status?: number;
  statusText?: string;
} | null;

type BetterAuthResponse<T = unknown> = {
  data: T | null;
  error: BetterAuthError;
};

type BetterAuthSessionPayload = {
  session?: {
    expiresAt?: string | number | Date | null;
  } | null;
  user?: Partial<AuthUser> | null;
};

type BetterAuthSessionState = {
  data?: BetterAuthSessionPayload | null;
  error?: unknown;
  isPending?: boolean;
};

type BetterAuthMainClient = {
  $fetch: (
    path: string,
    options?: Record<string, unknown>
  ) => Promise<BetterAuthResponse<Record<string, unknown>> | Record<string, unknown>>;
  getSession: () => Promise<BetterAuthResponse<BetterAuthSessionPayload> | BetterAuthSessionPayload>;
  requestAuth: (options?: HydraAuthRequestOptions) => Promise<void>;
  setupMain: (cfg?: HydraAuthClientSetupOptions) => void;
  signIn: {
    email: (
      body: Record<string, unknown>
    ) => Promise<BetterAuthResponse<Record<string, unknown>> | Record<string, unknown>>;
  };
  signOut: () => Promise<unknown>;
  signUp: {
    email: (
      body: Record<string, unknown>
    ) => Promise<BetterAuthResponse<Record<string, unknown>> | Record<string, unknown>>;
  };
  useSession: {
    get: () => BetterAuthSessionState;
    subscribe: (listener: (state: BetterAuthSessionState) => void) => () => void;
  };
};

const DEFAULT_AUTH_BASE_PATH = "/api/auth";
const DEFAULT_ELECTRON_PROTOCOL = process.env.AUTH_ELECTRON_PROTOCOL?.trim() || "com.gmh.hydra";
const SESSION_RESTORE_RETRY_DELAYS_MS = [150, 400, 900];
const LOCAL_AUTH_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

type ConfInstance = {
  get: (key: string, defaultValue?: unknown) => unknown;
  set: (key: string, value: unknown) => void;
};

type ConfConstructor = new (options: {
  cwd: string;
  projectName: string;
  projectVersion: string;
}) => ConfInstance;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPersistentStorage(Conf: ConfConstructor) {
  let config: ConfInstance | null = null;

  const getConfig = () => {
    if (!config) {
      config = new Conf({
        cwd: app.getPath("userData"),
        projectName: app.getName(),
        projectVersion: app.getVersion(),
      });
    }
    return config;
  };

  return {
    getItem(name: string): unknown | null {
      return getConfig().get(name, null);
    },
    setItem(name: string, value: unknown): void {
      getConfig().set(name, value);
    },
  };
}

// ---------------------------------------------------------------------------
// Auth client
// ---------------------------------------------------------------------------

export class HydraAuthClient {
  private readonly authBaseURL: string;
  private readonly authBasePath: string;
  private readonly getWindow?: () => BrowserWindow | null | undefined;
  private readonly onSessionChanged?: (session: AuthSession | null) => void;
  private cachedSession: AuthSession | null = null;
  private clientPromise: Promise<BetterAuthMainClient> | null = null;
  private nativeOAuthReady = false;
  private nativeOAuthSetupAttempted = false;
  private nativeOAuthSetupError: string | null = null;
  private unsubscribeSession: (() => void) | null = null;

  constructor(authServerUrl: string, options: HydraAuthClientOptions = {}) {
    const normalized = HydraAuthClient.normalizeAuthServerUrl(authServerUrl);
    this.authBaseURL = normalized.baseURL;
    this.authBasePath = normalized.basePath;
    this.getWindow = options.getWindow;
    this.onSessionChanged = options.onSessionChanged;
  }

  /**
   * Better Auth's Electron protocol registration should happen before
   * `app.whenReady()` when native provider OAuth is required.
   */
  async setupMain(options: HydraAuthClientSetupOptions = {}): Promise<void> {
    if (this.nativeOAuthSetupAttempted) {
      return;
    }

    const wantsScheme = options.scheme ?? true;
    const canRegisterScheme = wantsScheme && !app.isReady();
    if (wantsScheme && !canRegisterScheme) {
      this.nativeOAuthSetupError =
        `Native OAuth requires authClient.setupMain() before app.whenReady() ` +
        `to register the ${DEFAULT_ELECTRON_PROTOCOL}:/ protocol.`;
    }

    const client = await this.ensureClient();
    client.setupMain({
      ...options,
      bridges: options.bridges ?? false,
      csp: options.csp ?? true,
      getWindow: options.getWindow ?? this.getWindow,
      scheme: canRegisterScheme,
    });

    this.nativeOAuthReady = canRegisterScheme;
    this.nativeOAuthSetupAttempted = true;
  }

  /** Restore any existing Better Auth session on startup. */
  async initialize(): Promise<AuthSession | null> {
    for (let attempt = 0; attempt <= SESSION_RESTORE_RETRY_DELAYS_MS.length; attempt += 1) {
      const result = await this.loadSessionState();
      if (result.status !== "error") {
        return result.session;
      }

      if (attempt === SESSION_RESTORE_RETRY_DELAYS_MS.length) {
        break;
      }

      await wait(SESSION_RESTORE_RETRY_DELAYS_MS[attempt]);
    }

    return this.cachedSession;
  }

  async getSession(): Promise<AuthSession | null> {
    if (this.cachedSession) {
      return this.cachedSession;
    }

    const result = await this.loadSessionState();
    return result.session;
  }

  async signIn(email: string, password: string): Promise<AuthResult> {
    try {
      const response = this.normalizeResponse(
        await (await this.ensureClient()).signIn.email({ email, password })
      );

      if (response.data?.twoFactorRedirect) {
        return { success: false, twoFactorRedirect: true };
      }

      if (response.error) {
        return {
          success: false,
          error: this.formatClientError(response.error, "Sign in failed."),
        };
      }

      const session = await this.refreshSession({ broadcast: true });
      if (!session) {
        return { success: false, error: "No active session created." };
      }

      return { success: true, session };
    } catch (error) {
      return {
        success: false,
        error: this.formatThrownError(error, "Sign in failed."),
      };
    }
  }

  async signUp(name: string, email: string, password: string): Promise<AuthResult> {
    try {
      const response = this.normalizeResponse(
        await (await this.ensureClient()).signUp.email({ name, email, password })
      );

      if (response.error) {
        return {
          success: false,
          error: this.formatClientError(response.error, "Sign up failed."),
        };
      }

      const session = await this.refreshSession({ broadcast: true });
      if (!session) {
        return { success: false, error: "No active session created." };
      }

      return { success: true, session };
    } catch (error) {
      return {
        success: false,
        error: this.formatThrownError(error, "Sign up failed."),
      };
    }
  }

  async signOut(): Promise<void> {
    try {
      await (await this.ensureClient()).signOut();
    } finally {
      this.setCachedSession(null, { broadcast: true });
    }
  }

  async requestAuth(options: HydraAuthRequestOptions = {}): Promise<void> {
    if (!this.nativeOAuthReady) {
      throw new Error(
        this.nativeOAuthSetupError ??
          `Native OAuth is not configured. Call authClient.setupMain() before app.whenReady() ` +
            `to register ${DEFAULT_ELECTRON_PROTOCOL}:/ first.`
      );
    }

    const client = await this.ensureClient();
    await client.requestAuth(options);
  }

  async requestPasswordReset(email: string, redirectUrl: string): Promise<AuthResult> {
    const safeRedirectUrl = this.normalizePasswordResetRedirect(redirectUrl);
    if (!safeRedirectUrl) {
      return { success: false, error: "Password reset redirects must stay on Hydra or localhost." };
    }

    try {
      const response = this.normalizeResponse(
        await (await this.ensureClient()).$fetch("/request-password-reset", {
          body: { email, redirectTo: safeRedirectUrl },
          method: "POST",
        })
      );

      if (response.error) {
        return {
          success: false,
          error: this.formatClientError(response.error, "Request failed."),
        };
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: this.formatThrownError(error, "Request failed."),
      };
    }
  }

  async verifyTotp(code: string): Promise<AuthResult> {
    try {
      const response = this.normalizeResponse(
        await (await this.ensureClient()).$fetch("/two-factor/verify-totp", {
          body: { code },
          method: "POST",
        })
      );

      if (response.error) {
        return {
          success: false,
          error: this.formatClientError(response.error, "Verification failed."),
        };
      }

      const session = await this.refreshSession({ broadcast: true });
      return session ? { success: true, session } : { success: true };
    } catch (error) {
      return {
        success: false,
        error: this.formatThrownError(error, "Verification failed."),
      };
    }
  }

  /** Notify the renderer of auth state changes. */
  broadcastAuthState(session: AuthSession | null): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("auth:stateChanged", session);
    }
  }

  destroy(): void {
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private async refreshSession(options: { broadcast?: boolean } = {}): Promise<AuthSession | null> {
    const result = await this.loadSessionState(options);
    return result.session;
  }

  private async loadSessionState(
    options: { broadcast?: boolean } = {}
  ): Promise<
    | { status: "authenticated"; session: AuthSession }
    | { status: "missing"; session: null }
    | { status: "error"; session: AuthSession | null; error: unknown }
  > {
    try {
      const response = this.normalizeResponse(await (await this.ensureClient()).getSession());
      if (response.error) {
        return { status: "error", session: this.cachedSession, error: response.error };
      }

      const session = this.toRendererSession(response.data);
      this.setCachedSession(session, { broadcast: options.broadcast ?? false });
      if (session) {
        return { status: "authenticated", session };
      }

      return { status: "missing", session: null };
    } catch (error) {
      return { status: "error", session: this.cachedSession, error };
    }
  }

  private normalizeResponse<T>(response: BetterAuthResponse<T> | T): BetterAuthResponse<T> {
    if (
      response &&
      typeof response === "object" &&
      "data" in response &&
      "error" in response
    ) {
      return response as BetterAuthResponse<T>;
    }

    return {
      data: response as T,
      error: null,
    };
  }

  private formatClientError(error: BetterAuthError, fallback: string): string {
    if (error?.message) {
      return error.message;
    }

    if (typeof error?.status === "number") {
      return `${fallback} (${error.status}${error.statusText ? ` ${error.statusText}` : ""})`;
    }

    return fallback;
  }

  private formatThrownError(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }

    return fallback;
  }

  private normalizePasswordResetRedirect(redirectUrl: string): string | null {
    const value = redirectUrl.trim();
    if (!value) {
      return null;
    }

    try {
      const target = new URL(value);
      if (target.protocol === "app:" && target.hostname === "-") {
        return target.toString();
      }

      const baseUrl = new URL(this.authBaseURL);
      if (target.origin === baseUrl.origin) {
        return target.toString();
      }

      if (target.protocol === "http:" || target.protocol === "https:") {
        if (LOCAL_AUTH_HOSTNAMES.has(target.hostname)) {
          return target.toString();
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  private toRendererSession(payload: unknown): AuthSession | null {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const session = (payload as BetterAuthSessionPayload).session;
    const user = (payload as BetterAuthSessionPayload).user;
    if (!session || !user) {
      return null;
    }

    const expiresAt = this.toIsoString(session.expiresAt);
    if (!expiresAt) {
      return null;
    }

    return {
      user: {
        email: typeof user.email === "string" ? user.email : "",
        emailVerified: Boolean(user.emailVerified),
        id: typeof user.id === "string" ? user.id : "",
        image: typeof user.image === "string" || user.image === null ? user.image : null,
        name: typeof user.name === "string" ? user.name : "",
      },
      expiresAt,
    };
  }

  private toIsoString(value: unknown): string | null {
    if (typeof value === "string") {
      return value;
    }

    if (typeof value === "number") {
      return new Date(value).toISOString();
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    return null;
  }

  private setCachedSession(
    session: AuthSession | null,
    options: { broadcast?: boolean } = {}
  ): void {
    const changed = !this.sessionsEqual(this.cachedSession, session);
    this.cachedSession = session;

    if (options.broadcast && changed) {
      this.onSessionChanged?.(session);
      this.broadcastAuthState(session);
    }
  }

  private async ensureClient(): Promise<BetterAuthMainClient> {
    if (!this.clientPromise) {
      this.clientPromise = this.createClient();
    }

    return this.clientPromise;
  }

  private async createClient(): Promise<BetterAuthMainClient> {
    const [{ createAuthClient }, { electronClient }, { default: Conf }] = await Promise.all([
      import("better-auth/client"),
      import("@better-auth/electron/client"),
      import("conf"),
    ]);

    const client = createAuthClient({
      basePath: this.authBasePath,
      baseURL: this.authBaseURL,
      plugins: [
        electronClient({
          channelPrefix: "hydra-auth-native",
          protocol: DEFAULT_ELECTRON_PROTOCOL,
          signInURL: new URL("/sign-in", `${this.authBaseURL}/`).toString(),
          storage: createPersistentStorage(Conf as unknown as ConfConstructor),
          storagePrefix: "hydra-auth",
        }),
      ],
      sessionOptions: {
        refetchInterval: 30 * 60,
        refetchOnWindowFocus: false,
      },
    }) as unknown as BetterAuthMainClient;

    if (!this.unsubscribeSession) {
      this.unsubscribeSession = client.useSession.subscribe((state) => {
        if (state.isPending) {
          return;
        }

        this.setCachedSession(this.toRendererSession(state.data), { broadcast: true });
      });
    }

    return client;
  }

  private sessionsEqual(a: AuthSession | null, b: AuthSession | null): boolean {
    if (a === b) {
      return true;
    }

    if (!a || !b) {
      return false;
    }

    return (
      a.expiresAt === b.expiresAt &&
      a.user.id === b.user.id &&
      a.user.email === b.user.email &&
      a.user.name === b.user.name &&
      a.user.image === b.user.image &&
      a.user.emailVerified === b.user.emailVerified
    );
  }

  private static normalizeAuthServerUrl(authServerUrl: string): {
    basePath: string;
    baseURL: string;
  } {
    const value = authServerUrl.trim();
    if (!value) {
      throw new Error("AUTH_SERVER_URL is required.");
    }

    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const isLocal = LOCAL_AUTH_HOSTNAMES.has(hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
      throw new Error(`Refusing insecure auth server URL: ${value}`);
    }

    const basePath = HydraAuthClient.normalizeBasePath(url.pathname || "/");
    url.pathname = "/";
    url.search = "";
    url.hash = "";

    return {
      basePath,
      baseURL: url.toString().replace(/\/+$/, ""),
    };
  }

  private static normalizeBasePath(pathname: string): string {
    const trimmed = pathname.trim();
    if (!trimmed || trimmed === "/") {
      return DEFAULT_AUTH_BASE_PATH;
    }

    const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    return normalized.replace(/\/+$/, "") || DEFAULT_AUTH_BASE_PATH;
  }
}
