/**
 * Main-process authentication client.
 *
 * All auth operations run in the main process so that tokens can be stored
 * in Electron's safeStorage (OS-level encryption) and never leak into the
 * renderer.  The module talks to the Better Auth server over plain HTTP.
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
  private cachedSession: AuthSession | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(authServerUrl: string) {
    this.baseURL = authServerUrl.replace(/\/+$/, "");
  }

  /** Restore session from encrypted storage on startup. */
  async initialize(): Promise<AuthSession | null> {
    const store = readStore();
    const token = store["session_token"];
    if (!token) return null;

    // Validate against server
    try {
      const session = await this.fetchSession(token);
      if (session) {
        this.cachedSession = session;
        this.startRefreshTimer();
        return session;
      }
    } catch {
      // token invalid or server unreachable
    }

    clearStore();
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
      const session = await this.fetchSession(token);
      this.cachedSession = session;
      return session;
    } catch {
      return null;
    }
  }

  async requestPasswordReset(email: string, redirectUrl: string): Promise<AuthResult> {
    try {
      const res = await fetch(`${this.baseURL}/api/auth/forget-password`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ email, redirectTo: redirectUrl }),
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
  broadcastAuthState(session: AuthSession | null): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("auth:stateChanged", session);
    }
  }

  destroy(): void {
    this.stopRefreshTimer();
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private async fetchSession(token: string): Promise<AuthSession | null> {
    const res = await fetch(`${this.baseURL}/api/auth/get-session`, {
      method: "GET",
      headers: authHeaders({ Authorization: `Bearer ${token}` }),
    });

    if (!res.ok) return null;

    const data = await res.json() as any;
    if (!data?.session || !data?.user) return null;

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
    return session;
  }

  private startRefreshTimer(): void {
    this.stopRefreshTimer();
    // Revalidate session every 30 minutes
    this.refreshTimer = setInterval(async () => {
      const session = await this.getSession();
      if (!session) {
        this.cachedSession = null;
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
}
