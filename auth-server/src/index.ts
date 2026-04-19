import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth } from "./auth";
import type { CloudflareBindings } from "./env";

const app = new Hono<{ Bindings: CloudflareBindings }>();

// CORS for auth routes — allow Electron origins
app.use("/api/auth/*", async (c, next) => {
  const origins = c.env.AUTH_ALLOWED_ORIGINS
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return cors({
    origin: origins,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    credentials: true,
  })(c, next);
});

// Catch-all handler — delegates to Better Auth
app.all("/api/auth/*", async (c) => {
  console.log("Origin header:", c.req.header("origin"));
  const auth = createAuth(c.env, c.req.raw.cf as any);
  return auth.handler(c.req.raw);
});

// Health check
app.get("/health", (c) => c.json({ ok: true }));

export default app;
