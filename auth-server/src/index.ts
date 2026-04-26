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

  // Reconstruct the request so the body stream is guaranteed to be fresh.
  // Passing c.req.raw directly can hand better-call a body ReadableStream
  // that the Workers runtime has already locked/disturbed, which causes
  // "SyntaxError: Unexpected end of JSON input" inside getBody().
  const raw = c.req.raw;
  const hasBody = raw.method !== "GET" && raw.method !== "HEAD" && raw.body;
  const request = new Request(raw.url, {
    method: raw.method,
    headers: raw.headers,
    body: hasBody ? await raw.arrayBuffer() : undefined,
  });
  console.log(`[auth] incoming: ${request.method} ${request.url}`);
  // Monkey-patch global fetch to log the self-fetch from init-oauth-proxy
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const fetchUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input?.url;
    console.log(`[auth] sub-fetch: ${init?.method || "GET"} ${fetchUrl}`);
    try {
      const r = await origFetch(input, init);
      console.log(`[auth] sub-fetch result: ${r.status}`);
      return r;
    } catch (err: any) {
      console.error(`[auth] sub-fetch FAILED: ${err?.message}`);
      throw err;
    } finally {
      globalThis.fetch = origFetch;
    }
  };
  try {
    const response = await auth.handler(request);
    if (response.status >= 400) {
      const url = new URL(request.url);
      console.error(`[auth] ${request.method} ${url.pathname} → ${response.status}`);
      try {
        const cloned = response.clone();
        const body = await cloned.text();
        console.error(`[auth] body: ${body.slice(0, 500)}`);
      } catch {}
    }
    return response;
  } catch (err: any) {
    console.error(`[auth] THROWN: ${err?.message || err}`);
    console.error(`[auth] stack: ${err?.stack?.slice(0, 500) || "none"}`);
    throw err;
  }
});

// Health check
app.get("/health", (c) => c.json({ ok: true }));

export default app;
