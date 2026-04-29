import type { D1Database } from "@cloudflare/workers-types";

export interface CloudflareBindings {
  DATABASE: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  AUTH_ALLOWED_ORIGINS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

export const ELECTRON_AUTH_ORIGIN = "app://-";
export const ELECTRON_DEEP_LINK_ORIGIN = "com.gmh.hydra:/";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

type SocialProviderName = "google" | "discord" | "github";

type SocialProviderConfig = {
  clientId: string;
  clientSecret: string;
};

export type AuthSocialProviders = Partial<Record<SocialProviderName, SocialProviderConfig>>;

export type AuthRuntimeConfig = {
  allowedOrigins: string[];
  baseURL: string;
  secret: string;
  socialProviders: AuthSocialProviders;
  trustedOrigins: string[];
  useSecureCookies: boolean;
};

export function getAuthRuntimeConfig(env: CloudflareBindings): AuthRuntimeConfig {
  const secret = requireEnvValue(env.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET");
  const baseURL = normalizeBetterAuthUrl(requireEnvValue(env.BETTER_AUTH_URL, "BETTER_AUTH_URL"));
  const allowedOrigins = normalizeAllowedOrigins(
    requireEnvValue(env.AUTH_ALLOWED_ORIGINS, "AUTH_ALLOWED_ORIGINS")
  );

  return {
    allowedOrigins,
    baseURL,
    secret,
    socialProviders: getSocialProviders(env),
    trustedOrigins: normalizeTrustedOrigins(allowedOrigins),
    useSecureCookies: shouldUseSecureCookies(baseURL),
  };
}

export function normalizeAllowedOrigins(value: string): string[] {
  const normalized = new Set<string>();
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed === ELECTRON_AUTH_ORIGIN) {
      normalized.add(ELECTRON_AUTH_ORIGIN);
      continue;
    }

    const parsed = new URL(trimmed);
    normalized.add(parsed.origin === "null" ? trimmed : parsed.origin);
  }

  normalized.add(ELECTRON_AUTH_ORIGIN);
  return [...normalized];
}

function normalizeTrustedOrigins(allowedOrigins: string[]): string[] {
  return [...new Set([...allowedOrigins, ELECTRON_DEEP_LINK_ORIGIN])];
}

function getSocialProviders(
  env: CloudflareBindings,
): AuthSocialProviders {
  const providers: AuthSocialProviders = {};

  addSocialProvider(providers, "google", env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  addSocialProvider(providers, "discord", env.DISCORD_CLIENT_ID, env.DISCORD_CLIENT_SECRET);
  addSocialProvider(providers, "github", env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET);

  return providers;
}

function addSocialProvider(
  providers: AuthSocialProviders,
  name: SocialProviderName,
  clientId: string | undefined,
  clientSecret: string | undefined,
): void {
  const normalizedClientId = normalizeOptionalEnvValue(clientId);
  const normalizedClientSecret = normalizeOptionalEnvValue(clientSecret);

  if (!normalizedClientId && !normalizedClientSecret) {
    return;
  }

  if (!normalizedClientId || !normalizedClientSecret) {
    throw new Error(
      `${name.toUpperCase()}_CLIENT_ID and ${name.toUpperCase()}_CLIENT_SECRET must both be set when enabling ${name} auth.`,
    );
  }

  providers[name] = {
    clientId: normalizedClientId,
    clientSecret: normalizedClientSecret,
  };
}

function normalizeBetterAuthUrl(value: string): string {
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase();
  const isLocal = LOCAL_HOSTNAMES.has(hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) {
    throw new Error(`BETTER_AUTH_URL must use https unless it points to localhost. Received: ${value}`);
  }

  return parsed.toString().replace(/\/+$/, "");
}

function shouldUseSecureCookies(baseURL: string): boolean {
  return new URL(baseURL).protocol === "https:";
}

function requireEnvValue(value: string | undefined, name: string): string {
  const normalized = normalizeOptionalEnvValue(value);
  if (!normalized) {
    throw new Error(`${name} is required for auth routes.`);
  }

  return normalized;
}

function normalizeOptionalEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
