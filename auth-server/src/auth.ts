import type { D1Database, IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { betterAuth } from "better-auth";
import { electron } from "@better-auth/electron";
import { withCloudflare } from "better-auth-cloudflare";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import { hashPassword, verifyPassword } from "./password";
import { createEncryptedSecondaryStorage } from "./secondary-storage";
import {
  ELECTRON_AUTH_ORIGIN,
  ELECTRON_DEEP_LINK_ORIGIN,
  getAuthRuntimeConfig,
  type CloudflareBindings,
} from "./env";

type OAuthAccountRecord = {
  idToken?: string | null;
};

// Better Auth 1.6.5 can still persist raw idToken values on some OAuth paths.
async function scrubAccountIdTokenOnCreate(account: OAuthAccountRecord) {
  if (!Object.prototype.hasOwnProperty.call(account, "idToken")) {
    return;
  }

  return {
    data: {
      idToken: undefined,
    },
  };
}

async function scrubAccountIdTokenOnUpdate(account: OAuthAccountRecord) {
  if (!Object.prototype.hasOwnProperty.call(account, "idToken")) {
    return;
  }

  return {
    data: {
      idToken: null,
    },
  };
}

/**
 * Creates a Better Auth instance per-request.
 * Workers are stateless so bindings are only available per invocation.
 */
function createAuth(
  env?: CloudflareBindings,
  cf?: IncomingRequestCfProperties,
  baseURL?: string
) {
  const db = env ? drizzle(env.DATABASE, { schema }) : ({} as any);
  const runtimeConfig = env ? getAuthRuntimeConfig(env) : null;
  const secondaryStorage =
    env && runtimeConfig
      ? createEncryptedSecondaryStorage(env.DATABASE, runtimeConfig.secret)
      : undefined;
  const session = {
    // Keep live session tokens in secondary storage instead of the D1 session table.
    storeSessionInDatabase: false,
    preserveSessionInDatabase: false,
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5,
      strategy: "jwe" as const,
    },
  };
  const account = {
    encryptOAuthTokens: true,
  };
  const verification = {
    // Hash verification identifiers before storing them in secondary storage.
    storeIdentifier: "hashed" as const,
    storeInDatabase: false,
  };
  const advanced = {
    useSecureCookies: runtimeConfig?.useSecureCookies ?? false,
  };
  const socialProviders =
    runtimeConfig && Object.keys(runtimeConfig.socialProviders).length > 0
      ? runtimeConfig.socialProviders
      : undefined;
  const databaseHooks = {
    account: {
      create: {
        before: scrubAccountIdTokenOnCreate,
      },
      update: {
        before: scrubAccountIdTokenOnUpdate,
      },
    },
  };

  return betterAuth({
    baseURL: baseURL ?? runtimeConfig?.baseURL,
    secret: runtimeConfig?.secret,
    ...withCloudflare(
      {
        d1: env
          ? { db, options: { usePlural: false } }
          : undefined,
        cf: cf || {},
        // The local Drizzle session schema does not include Cloudflare geolocation columns.
        geolocationTracking: false,
      },
      {
        emailAndPassword: {
          enabled: true,
          password: {
            hash: hashPassword,
            verify: verifyPassword,
          },
        },
        // The desktop app now uses the native Better Auth Electron client/plugin flow.
        plugins: [electron()],
        session,
        account,
        verification,
        advanced,
        databaseHooks,
        socialProviders,
      }
    ),
    secondaryStorage,
    trustedOrigins: runtimeConfig?.trustedOrigins ?? [ELECTRON_AUTH_ORIGIN, ELECTRON_DEEP_LINK_ORIGIN],
    // CLI-only: provide a database adapter for schema generation
    ...(env
      ? {}
      : {
          database: drizzleAdapter({} as D1Database, {
            provider: "sqlite",
            usePlural: false,
          }),
        }),
  });
}

// Export static instance for CLI schema generation (`npx @better-auth/cli generate`)
export const auth = createAuth();

// Export factory for runtime usage
export { createAuth };
