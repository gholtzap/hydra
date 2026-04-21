/**
 * Main-process authentication client.
 *
 * All auth operations run in the main process so that tokens can be stored
 * in Electron's safeStorage (OS-level encryption) and never leak into the
 * renderer. The module talks to the Better Auth server over HTTP(S), but
 * non-local deployments must use HTTPS.
 */

import { app, safeStorage, BrowserWindow } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

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

interface StoredAuthSession {
  user: AuthUser;
  token: string;
  expiresAt: string;
}

export interface AuthResult {
  success: boolean;
  error?: string;
  twoFactorRedirect?: boolean;
  session?: AuthSession;
}

const AUTH_REQUEST_ORIGIN = "app://-";
const LOCAL_AUTH_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const SESSION_RESTORE_RETRY_DELAYS_MS = [150, 400, 900];

function authHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
  return {
    Origin: AUTH_REQUEST_ORIGIN,
    ...extraHeaders,
  };
}

// ---------------------------------------------------------------------------
// Encrypted token storage
// ---------------------------------------------------------------------------

function getStorePath(): string {
  return path.join(app.getPath("userData"), "auth-store.json");
}

function readStore(): Record<string, string> {
  try {
    const raw = fs.readFileSync(getStorePath(), "utf-8");
    const parsed = JSON.parse(raw);
    const result: Record<string, string> = {};
    for (const [key, encrypted] of Object.entries(parsed)) {
      if (typeof encrypted === "string" && safeStorage.isEncryptionAvailable()) {
        result[key] = safeStorage.decryptString(Buffer.from(encrypted, "base64"));
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeStore(data: Record<string, string>): void {
  const encrypted: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (safeStorage.isEncryptionAvailable()) {
      encrypted[key] = safeStorage.encryptString(value).toString("base64");
    }
  }
  fs.writeFileSync(getStorePath(), JSON.stringify(encrypted, null, 2), "utf-8");
}

function clearStore(): void {
  try {
    fs.unlinkSync(getStorePath());
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Auth client
// ---------------------------------------------------------------------------

export class HydraAuthClient {
  private baseURL: string;
  private cachedSession: StoredAuthSession | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(authServerUrl: string) {
    this.baseURL = HydraAuthClient.normalizeAuthServerUrl(authServerUrl);
  }

  /** Restore session from encrypted storage on startup. */
  async initialize(): Promise<AuthSession | null> {
    const store = readStore();
    const token = store["session_token"];
    if (!token) return null;

    const validation = await this.restoreStoredSession(token);
    if (validation.status === "valid") {
      this.cachedSession = validation.session;
      this.startRefreshTimer();
      return this.toRendererSession(validation.session);
    }

    if (validation.status === "invalid") {
      clearStore();
    }

    return null;
  }

  async signIn(email: string, password: string): Promise<AuthResult> {
    try {
      const res = await fetch(`${this.baseURL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json() as any;

      if (!res.ok) {
        // Check for 2FA redirect
        if (data?.twoFactorRedirect) {
          return { success: false, twoFactorRedirect: true };
        }
        return {
          success: false,
          error: data?.message || data?.error || `Sign in failed (${res.status})`,
        };
      }

      if (data?.token) {
        const session = await this.storeAndCacheSession(data.token, data);
        return { success: true, session };
      }

      // Some BetterAuth versions nest under data.session
      const token = data?.session?.token || data?.token;
      if (token) {
        const session = await this.storeAndCacheSession(token, data);
        return { success: true, session };
      }

      return { success: false, error: "No session token received." };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Network error",
      };
    }
  }

  async signUp(name: string, email: string, password: string): Promise<AuthResult> {
    try {
      const res = await fetch(`${this.baseURL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ name, email, password }),
      });

      const data = await res.json() as any;

      if (!res.ok) {
        return {
          success: false,
          error: data?.message || data?.error || `Sign up failed (${res.status})`,
        };
      }

      const token = data?.token || data?.session?.token;
      if (token) {
        const session = await this.storeAndCacheSession(token, data);
        return { success: true, session };
      }

      return { success: false, error: "No session token received." };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Network error",
      };
    }
  }

  async signOut(): Promise<void> {
    const store = readStore();
    const token = store["session_token"];

    // Try to invalidate server-side
    if (token) {
      try {
        await fetch(`${this.baseURL}/api/auth/sign-out`, {
          method: "POST",
          headers: authHeaders({
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          }),
        });
      } catch {
        // best effort
      }
    }

    this.cachedSession = null;
    this.stopRefreshTimer();
    clearStore();
  }

  async getSession(): Promise<AuthSession | null> {
    if (this.cachedSession) return this.cachedSession;

    const store = readStore();
    const token = store["session_token"];
    if (!token) return null;

    try {
      const validation = await this.restoreStoredSession(token, { retries: 1 });
      if (validation.status === "valid") {
        this.cachedSession = validation.session;
        return this.toRendererSession(validation.session);
      }

      if (validation.status === "invalid") {
        clearStore();
      }
    } catch {
      return null;
    }

    return null;
  }

  async requestPasswordReset(email: string, redirectUrl: string): Promise<AuthResult> {
    const safeRedirectUrl = this.normalizePasswordResetRedirect(redirectUrl);
    if (!safeRedirectUrl) {
      return { success: false, error: "Password reset redirects must stay on Hydra or localhost." };
    }

    try {
      const res = await fetch(`${this.baseURL}/api/auth/forget-password`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ email, redirectTo: safeRedirectUrl }),
      });

      if (!res.ok) {
        const data = await res.json() as any;
        return { success: false, error: data?.message || "Request failed." };
      }

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Network error",
      };
    }
  }

  async verifyTotp(code: string): Promise<AuthResult> {
    const store = readStore();
    const token = store["session_token"];

    try {
      const res = await fetch(`${this.baseURL}/api/auth/two-factor/verify-totp`, {
        method: "POST",
        headers: authHeaders({
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        }),
        body: JSON.stringify({ code }),
      });

      const data = await res.json() as any;

      if (!res.ok) {
        return { success: false, error: data?.message || "Verification failed." };
      }

      const newToken = data?.token || data?.session?.token || token;
      if (newToken) {
        const session = await this.storeAndCacheSession(newToken, data);
        return { success: true, session };
      }

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Network error",
      };
    }
  }

  /** Notify the renderer of auth state changes. */
  broadcastAuthState(session: StoredAuthSession | null): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("auth:stateChanged", this.toRendererSession(session));
    }
  }

  destroy(): void {
    this.stopRefreshTimer();
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private async fetchSession(token: string): Promise<StoredAuthSession | null> {
    let res: Response;
    try {
      res = await fetch(`${this.baseURL}/api/auth/get-session`, {
        method: "GET",
        headers: authHeaders({ Authorization: `Bearer ${token}` }),
      });
    } catch (error) {
      throw new Error(
        `Auth server is unreachable at ${this.baseURL}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (res.status === 401 || res.status === 403) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`Auth server returned ${res.status} while restoring the session.`);
    }

    const data = await res.json() as any;
    if (!data?.session || !data?.user) {
      throw new Error("Auth server returned an incomplete session payload.");
    }

    return {
      user: {
        id: data.user.id,
        email: data.user.email,
        name: data.user.name,
        image: data.user.image ?? null,
        emailVerified: data.user.emailVerified ?? false,
      },
      token: data.session.token ?? token,
      expiresAt:
        typeof data.session.expiresAt === "string"
          ? data.session.expiresAt
          : new Date(data.session.expiresAt).toISOString(),
    };
  }

  private async storeAndCacheSession(
    token: string,
    rawData: any
  ): Promise<AuthSession> {
    writeStore({ session_token: token });

    // Try to fetch the full session from server for canonical data
    let session = await this.fetchSession(token).catch(() => null);

    if (!session) {
      // Fallback: build from sign-in/sign-up response
      const user = rawData?.user ?? {};
      session = {
        user: {
          id: user.id ?? "",
          email: user.email ?? "",
          name: user.name ?? "",
          image: user.image ?? null,
          emailVerified: user.emailVerified ?? false,
        },
        token,
        expiresAt:
          rawData?.session?.expiresAt ??
          new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      };
    }

    this.cachedSession = session;
    this.startRefreshTimer();
    this.broadcastAuthState(session);
    return {
      user: session.user,
      expiresAt: session.expiresAt,
    };
  }

  private startRefreshTimer(): void {
    this.stopRefreshTimer();
    // Revalidate session every 30 minutes
    this.refreshTimer = setInterval(async () => {
      const token = readStore()["session_token"];
      if (!token) {
        this.cachedSession = null;
        this.broadcastAuthState(null);
        return;
      }

      const validation = await this.restoreStoredSession(token, { retries: 1 });
      if (validation.status === "valid") {
        this.cachedSession = validation.session;
        this.broadcastAuthState(validation.session);
        return;
      }

      if (validation.status === "invalid") {
        this.cachedSession = null;
        clearStore();
        this.broadcastAuthState(null);
      }
    }, 30 * 60 * 1000);
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async restoreStoredSession(
    token: string,
    options: { retries?: number } = {}
  ): Promise<
    | { status: "valid"; session: StoredAuthSession }
    | { status: "invalid" }
    | { status: "unreachable" }
  > {
    const retries = Math.max(1, options.retries ?? SESSION_RESTORE_RETRY_DELAYS_MS.length);

    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        const session = await this.fetchSession(token);
        if (!session) {
          return { status: "invalid" };
        }

        return { status: "valid", session };
      } catch {
        if (attempt === retries - 1) {
          return { status: "unreachable" };
        }

        const delayMs =
          SESSION_RESTORE_RETRY_DELAYS_MS[Math.min(attempt, SESSION_RESTORE_RETRY_DELAYS_MS.length - 1)];
        await wait(delayMs);
      }
    }

    return { status: "unreachable" };
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

      const baseUrl = new URL(this.baseURL);
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

  private toRendererSession(session: StoredAuthSession | null): AuthSession | null {
    if (!session) {
      return null;
    }

    return {
      user: session.user,
      expiresAt: session.expiresAt,
    };
  }

  private static normalizeAuthServerUrl(authServerUrl: string): string {
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

    return url.toString().replace(/\/+$/, "");
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
