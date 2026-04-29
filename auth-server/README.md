# Auth Server

Hydra's auth service is a Cloudflare Worker backed by D1 and Better Auth. The server entrypoint is [auth-server/src/index.ts](/Users/omavashia/hydra/auth-server/src/index.ts:1), which mounts Better Auth under `/api/auth/*` with CORS for Electron origins and a `/health` check.

## Architecture

The core Better Auth configuration lives in [auth-server/src/auth.ts](/Users/omavashia/hydra/auth-server/src/auth.ts:49). Each request builds a fresh auth instance because Workers bindings are only available per invocation. The runtime is wired through `better-auth`, `better-auth-cloudflare`, and the Electron plugin:

- `withCloudflare(...)` provides the D1 adapter and Cloudflare request context.
- `plugins: [electron()]` enables the native Electron auth flow.
- `trustedOrigins` allows the Electron app origin (`app://-`) and the deep-link origin (`com.gmh.hydra:/`), with any configured allowed origins merged in.

Session handling is intentionally not the default D1-backed Better Auth flow:

- Live sessions are stored in encrypted secondary storage, not the `session` table.
- A short-lived cookie cache is enabled with JWE and a 5 minute max age.
- Email/password hashes use the Worker-safe WebCrypto PBKDF2 implementation in [auth-server/src/password.ts](/Users/omavashia/hydra/auth-server/src/password.ts:1), avoiding Better Auth's pure-JS scrypt fallback on Cloudflare Workers.
- OAuth account tokens are encrypted, and `idToken` values are scrubbed on create/update to avoid the known Better Auth 1.6.5 persistence path.

## Configuration

Environment validation and runtime normalization live in [auth-server/src/env.ts](/Users/omavashia/hydra/auth-server/src/env.ts:39).

Required variables:

- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `AUTH_ALLOWED_ORIGINS`

Optional OAuth providers:

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`

Rules enforced by the config code:

- `BETTER_AUTH_URL` must be `https:` unless it points at localhost.
- `AUTH_ALLOWED_ORIGINS` is normalized to origins, deduplicated, and always includes `app://-`.
- `trustedOrigins` always includes `com.gmh.hydra:/` in addition to the allowed origins.
- HTTPS bases enable secure cookies automatically.

## Storage Model

The Drizzle schema is in [auth-server/src/db/schema.ts](/Users/omavashia/hydra/auth-server/src/db/schema.ts:4). Better Auth uses four tables:

- `user`
- `session`
- `account`
- `verification`

The schema keeps the standard Better Auth columns, plus indexes on `session.user_id`, `account.user_id`, and `verification.identifier`.

Encrypted secondary storage is implemented in [auth-server/src/secondary-storage.ts](/Users/omavashia/hydra/auth-server/src/secondary-storage.ts:46). It:

- Derives separate HKDF keys for encryption and key hashing from `BETTER_AUTH_SECRET`.
- Stores payloads as `v1:<iv hex>:<ciphertext hex>`.
- Uses AES-GCM with associated data that binds the key hash and expiry.
- Deletes expired or undecryptable rows on read.

The backing table is created by migration [auth-server/migrations/0002_encrypted_secondary_storage.sql](/Users/omavashia/hydra/auth-server/migrations/0002_encrypted_secondary_storage.sql:1). Legacy cleanup is in [auth-server/migrations/0003_cleanup_legacy_plaintext_auth_artifacts.sql](/Users/omavashia/hydra/auth-server/migrations/0003_cleanup_legacy_plaintext_auth_artifacts.sql:1).

## Request Flow

[`auth-server/src/index.ts`](/Users/omavashia/hydra/auth-server/src/index.ts:24) wraps `/api/auth/*` with CORS for the normalized allowed origins, then reconstructs the raw request before delegating to `auth.handler(request)`. The request reconstruction matters because Workers can hand Better Auth a disturbed body stream otherwise.

The Electron OAuth init route (`/api/auth/electron/init-oauth-proxy`) is handled before the Better Auth catch-all and calls `auth.handler()` directly for `/api/auth/sign-in/social`. This avoids the Electron plugin's same-origin HTTP self-fetch, which is brittle in Workers request contexts. Do not monkey-patch `globalThis.fetch` for request logging; Worker isolates can reuse globals across requests.

[`auth-server/src/auth.ts`](/Users/omavashia/hydra/auth-server/src/auth.ts:134) also exports a static `auth` instance for Better Auth CLI schema generation via `npx @better-auth/cli generate`.

## Electron Integration

Hydra's Electron main process owns the auth client wrapper in [electron/main/auth-client.ts](/Users/omavashia/hydra/electron/main/auth-client.ts:155). The important pieces are:

- `setupMain()` must run before `app.whenReady()` when native OAuth is needed, so the custom protocol can be registered.
- The client persists Electron auth state via Better Auth's Electron client and `conf`, using Electron safe storage underneath.
- `initialize()` restores an existing session on startup, retrying briefly if the auth backend is not ready yet.

The app boots that client early in [electron/main/main.ts](/Users/omavashia/hydra/electron/main/main.ts:653) and loads either the main app or the sign-in page based on session state. Auth-related IPC is exposed through [electron/main/main.ts](/Users/omavashia/hydra/electron/main/main.ts:1126) and bridged to the renderer in [electron/main/preload.ts](/Users/omavashia/hydra/electron/main/preload.ts:176).

Renderer auth UI lives in [electron/renderer/auth.html](/Users/omavashia/hydra/electron/renderer/auth.html:1).

## Local Setup

1. Install dependencies once from the repo root: `npm install` and `npm --prefix auth-server install`.
2. Create `auth-server/.dev.vars` from `auth-server/.dev.vars.example` and set `BETTER_AUTH_SECRET`. Add any OAuth provider credentials you need.
3. Start everything from the repo root with `npm run dev`. This runs the auth Worker with local D1 migrations and the desktop app together.

If you only want the auth Worker, run `npm run dev:auth`.
