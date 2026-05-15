# Discord Control

Hydra can be controlled from Discord through the official Hydra Discord app and the Hydra relay service. Discord cannot call a user's `127.0.0.1:4141` MCP server, so the desktop app opens an outbound authenticated websocket to the relay after the user signs in.

```text
Discord official Hydra app
        |
        v
Hydra relay/auth service
        |
outbound authenticated websocket
        |
Hydra desktop
        |
local AppController
```

## User Setup

1. Open Hydra desktop.
2. Sign in.
3. Open Settings, then Integrations.
4. Enable Discord control.
5. Click Install App to add the official Hydra Discord app to the target server.
6. Click Generate Code.
7. Run `/hydra link` with that code in the Discord channel that should control Hydra.
8. Return to Hydra and connect the relay after the link is detected.

Users can still enter the allowed Discord server ID, channel ID, and optional comma-separated user IDs manually.

This setup does not require users to create a Discord Developer Portal application, manage a bot token, register slash commands, or run a sidecar script.

## Cloud Setup

The auth Worker owns the centralized Discord integration:

- `POST /api/discord/interactions` receives Discord interactions.
- `GET /api/discord/desktop/connect` upgrades signed-in desktops to websocket relay connections.
- `POST /api/auth/discord/relay-token` issues short-lived relay tokens to signed-in desktops.
- `GET` and `POST /api/auth/discord/control-settings` store per-user allowed server, channel, and user IDs.
- `GET /api/auth/discord/install-info` returns the official Discord app install URL.
- `POST /api/auth/discord/link-code` creates a short-lived setup code for linking a Discord channel.
- `POST /api/discord/commands` syncs the official `/hydra` commands when called with `x-hydra-admin-secret`.

Required Worker bindings and secrets:

```env
BETTER_AUTH_SECRET=...
BETTER_AUTH_URL=...
AUTH_ALLOWED_ORIGINS=app://-,...
DISCORD_APPLICATION_ID=official_hydra_discord_application_id
DISCORD_BOT_TOKEN=official_hydra_bot_token
DISCORD_COMMAND_SYNC_SECRET=admin_only_sync_secret
DISCORD_PUBLIC_KEY=discord_interactions_public_key
```

The Worker also requires the `DISCORD_RELAY` Durable Object binding and the `discord_control_settings` and `discord_link_codes` D1 migrations.

### Deployment Checklist

1. Create or select the official Hydra application in the Discord Developer Portal.
2. Set the Discord Interactions Endpoint URL to `https://your-hydra-auth-worker.example/api/discord/interactions`.
3. Set the required auth secrets from the block above, then copy the Discord application's ID, public key, and bot token into Worker secrets:

   ```sh
   npm exec --prefix auth-server -- wrangler secret put DISCORD_APPLICATION_ID
   npm exec --prefix auth-server -- wrangler secret put DISCORD_PUBLIC_KEY
   npm exec --prefix auth-server -- wrangler secret put DISCORD_BOT_TOKEN
   npm exec --prefix auth-server -- wrangler secret put DISCORD_COMMAND_SYNC_SECRET
   ```

4. Apply the remote D1 migrations:

   ```sh
   HYDRA_ALLOW_AUTH_REMOTE_MIGRATE=1 \
   npm --prefix auth-server run d1:migrate:remote
   ```

5. Deploy the Worker:

   ```sh
   HYDRA_ALLOW_AUTH_DEPLOY=1 \
   npm --prefix auth-server run deploy
   ```

6. Sync the official slash commands.

After deploying the Worker and setting the official Discord app secrets, sync the global slash commands:

```sh
HYDRA_ALLOW_DISCORD_COMMAND_SYNC=1 \
AUTH_SERVER_URL=https://your-hydra-auth-worker.example \
DISCORD_COMMAND_SYNC_SECRET=... \
npm run discord:sync:centralized
```

## Legacy Local Bridge

The local bridge remains useful for local development, but it is no longer the recommended user setup. It runs a local Discord bot next to Hydra and talks to the loopback MCP server at `127.0.0.1:4141`.

## Discord Commands

All commands are under `/hydra`.

### `/hydra link`

Links the current Discord channel to the signed-in Hydra desktop that generated the setup code.

Options:

- `code`: required 8-character code generated from Hydra Settings, then Integrations

### `/hydra status`

Shows a summary of Hydra's current state:

- repo count
- session count
- live session count
- blocked session count
- unread line count
- session counts by status

### `/hydra inbox`

Shows sessions that are blocked or have unread output.

### `/hydra sessions`

Lists recent Hydra sessions.

Options:

- `status`: optional filter, one of `running`, `blocked`, `needs_input`, `failed`, `done`, or `idle`
- `limit`: optional number of sessions to show, from `1` to `20`

### `/hydra tail`

Shows recent terminal output for a session.

Options:

- `session`: required Hydra session ID
- `lines`: optional number of recent lines to show, from `1` to `80`

### `/hydra prompt`

Sends a prompt to a specific Hydra session.

Options:

- `session`: required Hydra session ID
- `text`: required prompt text

The bridge sends the prompt text and then sends an explicit terminal Enter key.

### `/hydra focused-prompt`

Sends a prompt to Hydra's focused session.

Options:

- `text`: required prompt text

### `/hydra approve`

Approves a blocked action, such as an agent tool permission prompt.

Options:

- `session`: optional Hydra session ID

If `session` is omitted, Hydra approves the focused session's blocker.

### `/hydra deny`

Denies a blocked action.

Options:

- `session`: optional Hydra session ID

If `session` is omitted, Hydra denies the focused session's blocker.

### `/hydra focus`

Sets Hydra's focused session.

Options:

- `session`: required Hydra session ID

### `/hydra new`

Creates a new Hydra agent session in a repo.

Options:

- `repo`: required Hydra repo ID
- `prompt`: required initial prompt
- `agent`: optional agent ID

Supported agent IDs:

- `claude`
- `codex`
- `gemini`
- `aider`
- `opencode`
- `goose`
- `amazon-q`
- `github-copilot`
- `junie`
- `qwen`
- `amp`
- `warp`

## Security Notes

- Never commit Worker secrets or local `.env` files.
- Never paste the official bot token into chat, logs, issues, or pull requests.
- Regenerate the official Discord bot token if it is exposed.
- Keep the control channel private.
- Configure allowed user IDs for personal use.
- Do not expose `127.0.0.1:4141` through a tunnel or public proxy.
- The centralized relay does not require exposing the local MCP server.
- Treat approvals from Discord as sensitive because they can allow agents to run tools or modify files.
