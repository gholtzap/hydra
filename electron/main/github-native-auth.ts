import type {
  GitHubDeviceAuthPollResult,
  GitHubDeviceAuthStartResult,
  GitHubNativeAuthStatus
} from "../shared-types";

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { app, safeStorage } = require("electron") as typeof import("electron");

type ConfInstance = {
  get: (key: string, defaultValue?: unknown) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
};

type ConfConstructor = new (options: {
  cwd: string;
  projectName: string;
  projectVersion: string;
}) => ConfInstance;

type StoredGitHubNativeAuth = {
  token: string;
  tokenType: string;
  account: string | null;
  scopes: string[];
  createdAt: string;
};

type PendingDeviceAuth = {
  deviceCode: string;
  expiresAtMs: number;
  intervalSeconds: number;
};

type DeviceCodeResponse = {
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  verification_uri_complete?: unknown;
  expires_in?: unknown;
  interval?: unknown;
  error?: unknown;
  error_description?: unknown;
};

type DeviceTokenResponse = {
  access_token?: unknown;
  token_type?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
  interval?: unknown;
};

type GitHubUserResponse = {
  login?: unknown;
};

const AUTH_CONFIG_KEY = "github.nativeAuth";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_DEVICE_SCOPE = "codespace";
const REQUEST_TIMEOUT_MS = 30_000;

let configPromise: Promise<ConfInstance> | null = null;
let pendingDeviceAuth: PendingDeviceAuth | null = null;

async function gitHubNativeAuthStatus(): Promise<GitHubNativeAuthStatus> {
  const clientId = githubOAuthClientId();
  if (!clientId) {
    return {
      configured: false,
      authenticated: false,
      account: null,
      scopes: [],
      error: "Native GitHub sign-in is not configured for this build."
    };
  }

  const stored = await readStoredAuth();
  if (!stored) {
    return {
      configured: true,
      authenticated: false,
      account: null,
      scopes: [],
      error: null
    };
  }

  return {
    configured: true,
    authenticated: true,
    account: stored.account,
    scopes: stored.scopes,
    error: null
  };
}

async function startGitHubDeviceAuth(): Promise<GitHubDeviceAuthStartResult> {
  const clientId = githubOAuthClientId();
  if (!clientId) {
    return {
      ok: false,
      status: await gitHubNativeAuthStatus(),
      verificationUri: null,
      userCode: null,
      expiresAt: null,
      intervalSeconds: null,
      error: "Native GitHub sign-in needs a GitHub OAuth client ID."
    };
  }

  const response = await fetchJson<DeviceCodeResponse>(DEVICE_CODE_URL, {
    method: "POST",
    body: new URLSearchParams({
      client_id: clientId,
      scope: GITHUB_DEVICE_SCOPE
    })
  });

  if (!response.ok) {
    return {
      ok: false,
      status: await gitHubNativeAuthStatus(),
      verificationUri: null,
      userCode: null,
      expiresAt: null,
      intervalSeconds: null,
      error: response.error || "GitHub did not start device sign-in."
    };
  }

  const deviceCode = stringValue(response.data.device_code);
  const userCode = stringValue(response.data.user_code);
  const verificationUri = trustedGitHubDeviceUrl(response.data.verification_uri);
  const expiresInSeconds = numberValue(response.data.expires_in) || 900;
  const intervalSeconds = numberValue(response.data.interval) || 5;
  if (!deviceCode || !userCode || !verificationUri) {
    return {
      ok: false,
      status: await gitHubNativeAuthStatus(),
      verificationUri: null,
      userCode: null,
      expiresAt: null,
      intervalSeconds: null,
      error: "GitHub returned an incomplete device sign-in response."
    };
  }

  const expiresAtMs = Date.now() + expiresInSeconds * 1000;
  pendingDeviceAuth = {
    deviceCode,
    expiresAtMs,
    intervalSeconds
  };

  return {
    ok: true,
    status: await gitHubNativeAuthStatus(),
    verificationUri,
    userCode,
    expiresAt: new Date(expiresAtMs).toISOString(),
    intervalSeconds,
    error: null
  };
}

async function pollGitHubDeviceAuth(): Promise<GitHubDeviceAuthPollResult> {
  const clientId = githubOAuthClientId();
  if (!clientId || !pendingDeviceAuth) {
    return {
      ok: false,
      pending: false,
      status: await gitHubNativeAuthStatus(),
      intervalSeconds: null,
      error: "Start GitHub sign-in before polling."
    };
  }

  if (Date.now() >= pendingDeviceAuth.expiresAtMs) {
    pendingDeviceAuth = null;
    return {
      ok: false,
      pending: false,
      status: await gitHubNativeAuthStatus(),
      intervalSeconds: null,
      error: "GitHub sign-in expired. Start sign-in again."
    };
  }

  const response = await fetchJson<DeviceTokenResponse>(TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      client_id: clientId,
      device_code: pendingDeviceAuth.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code"
    })
  });

  const errorCode = stringValue(response.data?.error);
  if (errorCode === "authorization_pending") {
    return {
      ok: true,
      pending: true,
      status: await gitHubNativeAuthStatus(),
      intervalSeconds: pendingDeviceAuth.intervalSeconds,
      error: null
    };
  }

  if (errorCode === "slow_down") {
    pendingDeviceAuth.intervalSeconds += 5;
    return {
      ok: true,
      pending: true,
      status: await gitHubNativeAuthStatus(),
      intervalSeconds: pendingDeviceAuth.intervalSeconds,
      error: null
    };
  }

  if (!response.ok || errorCode) {
    pendingDeviceAuth = null;
    return {
      ok: false,
      pending: false,
      status: await gitHubNativeAuthStatus(),
      intervalSeconds: null,
      error: stringValue(response.data?.error_description) || response.error || "GitHub sign-in failed."
    };
  }

  const accessToken = stringValue(response.data.access_token);
  if (!accessToken) {
    pendingDeviceAuth = null;
    return {
      ok: false,
      pending: false,
      status: await gitHubNativeAuthStatus(),
      intervalSeconds: null,
      error: "GitHub did not return an access token."
    };
  }

  const scopes = parseScopes(response.data.scope);
  const tokenType = stringValue(response.data.token_type) || "bearer";
  const account = await fetchGitHubAccount(accessToken);
  await storeAuth({
    token: accessToken,
    tokenType,
    account,
    scopes,
    createdAt: new Date().toISOString()
  });
  pendingDeviceAuth = null;

  return {
    ok: true,
    pending: false,
    status: await gitHubNativeAuthStatus(),
    intervalSeconds: null,
    error: null
  };
}

async function disconnectGitHubNativeAuth(): Promise<GitHubNativeAuthStatus> {
  pendingDeviceAuth = null;
  const config = await getConfig();
  config.delete(AUTH_CONFIG_KEY);
  return gitHubNativeAuthStatus();
}

async function gitHubNativeAccessToken(requiredScope?: string): Promise<string | null> {
  const status = await gitHubNativeAuthStatus();
  if (!status.configured || !status.authenticated) {
    return null;
  }
  if (requiredScope && status.scopes.length > 0 && !status.scopes.includes(requiredScope)) {
    return null;
  }
  const stored = await readStoredAuth();
  return stored?.token || null;
}

function githubOAuthClientId(): string | null {
  const envClientId =
    process.env.HYDRA_GITHUB_OAUTH_CLIENT_ID?.trim() ||
    process.env.GITHUB_OAUTH_CLIENT_ID?.trim();
  if (envClientId) {
    return envClientId;
  }

  const configPath = path.join(__dirname, "..", "renderer", "auth-config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const configClientId = typeof config?.githubOAuthClientId === "string"
      ? config.githubOAuthClientId.trim()
      : "";
    return configClientId || null;
  } catch {
    return null;
  }
}

async function fetchGitHubAccount(accessToken: string): Promise<string | null> {
  const response = await fetchGitHubApi<GitHubUserResponse>("/user", accessToken);
  if (!response.ok) {
    return null;
  }
  return stringValue(response.data.login);
}

async function fetchGitHubApi<T>(apiPath: string, accessToken: string): Promise<{ ok: boolean; data: T; error: string | null }> {
  return fetchJson<T>(`${GITHUB_API_URL}${apiPath}`, {
    method: "GET",
    token: accessToken
  });
}

async function fetchJson<T>(
  url: string,
  options: { method: "GET" | "POST"; body?: URLSearchParams; token?: string }
): Promise<{ ok: boolean; data: T; status: number; error: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: options.method,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(options.token ? {
          Authorization: `Bearer ${options.token}`,
          "X-GitHub-Api-Version": GITHUB_API_VERSION
        } : {})
      },
      body: options.body?.toString(),
      signal: controller.signal
    });
    const text = await response.text();
    const data = parseJsonObject<T>(text);
    return {
      ok: response.ok,
      data,
      status: response.status,
      error: response.ok ? null : responseErrorMessage(data, text, response.status)
    };
  } catch (error) {
    return {
      ok: false,
      data: {} as T,
      status: 0,
      error: error instanceof Error ? error.message : "GitHub request failed."
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readStoredAuth(): Promise<StoredGitHubNativeAuth | null> {
  const config = await getConfig();
  const value = config.get(AUTH_CONFIG_KEY, null);
  if (!isRecord(value)) {
    return null;
  }

  const encryptedToken = stringValue(value.token);
  if (!encryptedToken || !safeStorage.isEncryptionAvailable()) {
    return null;
  }

  try {
    const token = safeStorage.decryptString(Buffer.from(encryptedToken, "base64"));
    return {
      token,
      tokenType: stringValue(value.tokenType) || "bearer",
      account: stringValue(value.account),
      scopes: Array.isArray(value.scopes)
        ? value.scopes.map(stringValue).filter((scope): scope is string => !!scope)
        : [],
      createdAt: stringValue(value.createdAt) || new Date(0).toISOString()
    };
  } catch {
    return null;
  }
}

async function storeAuth(auth: StoredGitHubNativeAuth): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Encrypted desktop storage is not available.");
  }

  const config = await getConfig();
  config.set(AUTH_CONFIG_KEY, {
    token: safeStorage.encryptString(auth.token).toString("base64"),
    tokenType: auth.tokenType,
    account: auth.account,
    scopes: auth.scopes,
    createdAt: auth.createdAt
  });
}

async function getConfig(): Promise<ConfInstance> {
  if (!configPromise) {
    configPromise = import("conf").then((mod) => {
      const Conf = mod.default as ConfConstructor;
      return new Conf({
        cwd: app.getPath("userData"),
        projectName: app.getName(),
        projectVersion: app.getVersion()
      });
    });
  }
  return configPromise;
}

function trustedGitHubDeviceUrl(value: unknown): string | null {
  const url = stringValue(value);
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" && (hostname === "github.com" || hostname === "www.github.com")
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function parseScopes(value: unknown): string[] {
  const raw = typeof value === "string" ? value : "";
  return raw.split(",").map((scope) => scope.trim()).filter(Boolean);
}

function responseErrorMessage(value: unknown, text: string, status: number): string {
  if (isRecord(value)) {
    const description = stringValue(value.error_description) || stringValue(value.message);
    if (description) {
      return description;
    }
  }
  return text.trim() || `GitHub request failed with status ${status}.`;
}

function parseJsonObject<T>(text: string): T {
  try {
    const parsed = JSON.parse(text);
    return (parsed && typeof parsed === "object" ? parsed : {}) as T;
  } catch {
    return {} as T;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export {
  disconnectGitHubNativeAuth,
  gitHubNativeAccessToken,
  gitHubNativeAuthStatus,
  pollGitHubDeviceAuth,
  startGitHubDeviceAuth
};
