import type { D1Database } from "@cloudflare/workers-types";

export interface CloudflareBindings {
  DATABASE: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  AUTH_ALLOWED_ORIGINS?: string;
}

export const ELECTRON_AUTH_ORIGIN = "app://-";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export type AuthRuntimeConfig = {
  allowedOrigins: string[];
  baseURL: string;
  secret: string;
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
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required for auth routes.`);
  }

  return normalized;
}
