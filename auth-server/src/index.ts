import type { IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { createAuth } from "./auth";
import { getAuthRuntimeConfig, type CloudflareBindings } from "./env";
import {
  DiscordRelayHub,
  handleDiscordCommandSync,
  handleDiscordControlSettings,
  handleDiscordDesktopConnect,
  handleDiscordInstallInfo,
  handleDiscordInteraction,
  handleDiscordLinkCode,
  handleDiscordRelayToken,
} from "./discord-relay";

export { DiscordRelayHub };

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

function appendSetCookie(headers: Headers, source: Headers): void {
  const getSetCookie = (source as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof getSetCookie === "function" ? getSetCookie.call(source) : [];
  if (cookies.length > 0) {
    for (const cookie of cookies) {
      headers.append("set-cookie", cookie);
    }
    return;
  }

  const cookie = source.get("set-cookie");
  if (cookie) {
    headers.append("set-cookie", cookie);
  }
}

function requestCfProperties(c: Context<{ Bindings: CloudflareBindings }>): IncomingRequestCfProperties {
  return c.req.raw.cf as IncomingRequestCfProperties;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string {
  return error instanceof Error && error.stack ? error.stack.slice(0, 500) : "none";
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

// Avoid the Electron plugin's HTTP self-fetch on Workers; direct handler calls
// keep the OAuth init flow in the current request context.
app.get("/api/auth/electron/init-oauth-proxy", async (c) => {
  const result = authConfigOrError(c);
  if ("response" in result) {
    return result.response;
  }

  const requestUrl = new URL(c.req.raw.url);
  const provider = requestUrl.searchParams.get("provider");
  const state = requestUrl.searchParams.get("state");
  const codeChallenge = requestUrl.searchParams.get("code_challenge");
  if (!provider || !state || !codeChallenge) {
    return c.json({ message: "Missing OAuth initialization parameters." }, 400);
  }

  const signInUrl = new URL("/api/auth/sign-in/social", requestUrl.origin);
  signInUrl.searchParams.set("client_id", requestUrl.searchParams.get("client_id") || "electron");
  signInUrl.searchParams.set("code_challenge", codeChallenge);
  signInUrl.searchParams.set(
    "code_challenge_method",
    requestUrl.searchParams.get("code_challenge_method") || "plain",
  );
  signInUrl.searchParams.set("state", state);

  const headers = new Headers(c.req.raw.headers);
  headers.set("content-type", "application/json");
  headers.set("origin", new URL(result.config.baseURL).origin);

  const auth = createAuth(c.env, requestCfProperties(c), result.config.baseURL);
  const signInResponse = await auth.handler(
    new Request(signInUrl, {
      body: JSON.stringify({ provider }),
      headers,
      method: "POST",
    }),
  );

  if (!signInResponse.ok) {
    return signInResponse;
  }

  const data = await signInResponse.clone().json().catch(() => null);
  if (!data || typeof data !== "object") {
    return c.json({ message: "Invalid OAuth initialization response." }, 500);
  }

  const responseHeaders = new Headers();
  appendSetCookie(responseHeaders, signInResponse.headers);
  if ("url" in data && typeof data.url === "string" && "redirect" in data && data.redirect) {
    responseHeaders.set("location", data.url);
    return new Response(null, { headers: responseHeaders, status: 302 });
  }

  responseHeaders.set("content-type", "application/json");
  return new Response(JSON.stringify(data), { headers: responseHeaders, status: 200 });
});

app.get("/api/auth/discord/control-settings", async (c) => {
  try {
    return await handleDiscordControlSettings(c);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Unable to load Discord settings." },
      400
    );
  }
});

app.post("/api/auth/discord/control-settings", async (c) => {
  try {
    return await handleDiscordControlSettings(c);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Unable to update Discord settings." },
      400
    );
  }
});

app.post("/api/auth/discord/relay-token", async (c) => {
  try {
    return await handleDiscordRelayToken(c);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Unable to create Discord relay token." },
      400
    );
  }
});

app.get("/api/auth/discord/install-info", async (c) => {
  try {
    return await handleDiscordInstallInfo(c);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Unable to load Discord install info." },
      400
    );
  }
});

app.post("/api/auth/discord/link-code", async (c) => {
  try {
    return await handleDiscordLinkCode(c);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Unable to create Discord link code." },
      400
    );
  }
});

app.get("/api/discord/desktop/connect", async (c) => handleDiscordDesktopConnect(c));
app.post("/api/discord/interactions", async (c) => handleDiscordInteraction(c));
app.post("/api/discord/commands", async (c) => handleDiscordCommandSync(c));

// Catch-all handler — delegates to Better Auth
app.all("/api/auth/*", async (c) => {
  const result = authConfigOrError(c);
  if ("response" in result) {
    return result.response;
  }

  const auth = createAuth(c.env, requestCfProperties(c), result.config.baseURL);

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
  try {
    const response = await auth.handler(request);
    if (response.status >= 400) {
      const url = new URL(request.url);
      console.error(`[auth] ${request.method} ${url.pathname} -> ${response.status}`);
      try {
        const cloned = response.clone();
        const body = await cloned.text();
        console.error(`[auth] body: ${body.slice(0, 500)}`);
      } catch {}
    }
    return response;
  } catch (error) {
    console.error(`[auth] THROWN: ${errorMessage(error)}`);
    console.error(`[auth] stack: ${errorStack(error)}`);
    throw error;
  }
});

// Health check
app.get("/health", (c) => c.json({ ok: true }));

export default app;
