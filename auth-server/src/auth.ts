import type { D1Database, IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { electron } from "@better-auth/electron";
import { withCloudflare } from "better-auth-cloudflare";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import {
  ELECTRON_AUTH_ORIGIN,
  getAuthRuntimeConfig,
  type CloudflareBindings,
} from "./env";

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

  return betterAuth({
    baseURL: baseURL ?? runtimeConfig?.baseURL,
    secret: runtimeConfig?.secret,
    ...withCloudflare(
      {
        d1: env
          ? { db, options: { usePlural: false } }
          : undefined,
        cf: cf || {},
      },
      {
        emailAndPassword: { enabled: true },
      }
    ),
    plugins: [electron(), bearer()],
    trustedOrigins: runtimeConfig?.allowedOrigins ?? [ELECTRON_AUTH_ORIGIN],
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
