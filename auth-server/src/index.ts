import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { createAuth } from "./auth";
import { getAuthRuntimeConfig, type CloudflareBindings } from "./env";

const app = new Hono<{ Bindings: CloudflareBindings }>();

function authConfigOrError(c: Context<{ Bindings: CloudflareBindings }>) {
  try {
    return { config: getAuthRuntimeConfig(c.env) };
  } catch (error) {
    console.error("[auth] invalid configuration:", error);
    return {
      response: c.json(
        {
          error: error instanceof Error ? error.message : "Invalid auth configuration.",
        },
        500
      ),
    };
  }
}

// CORS for auth routes — allow Electron origins
app.use("/api/auth/*", async (c, next) => {
  const result = authConfigOrError(c);
  if ("response" in result) {
    return result.response;
  }

  return cors({
    origin: result.config.allowedOrigins,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    credentials: true,
  })(c, next);
});

// Catch-all handler — delegates to Better Auth
app.all("/api/auth/*", async (c) => {
  const result = authConfigOrError(c);
  if ("response" in result) {
    return result.response;
  }

  const auth = createAuth(c.env, c.req.raw.cf as any, result.config.baseURL);
  return auth.handler(c.req.raw);
});

// Health check
app.get("/health", (c) => c.json({ ok: true }));

export default app;
