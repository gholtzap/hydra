# Discord Control

Hydra can be controlled from Discord by running a local Discord bridge next to the Hydra desktop app. Discord commands are accepted only from the configured guild, channel, and optional allowlisted users. The bridge talks to Hydra through the local MCP server at `127.0.0.1:4141`.

Do not expose Hydra's MCP port to the internet. The Discord bridge should run on the same machine as Hydra.

## Discord Developer Portal Setup

1. Open the Discord Developer Portal:
   <https://discord.com/developers/applications>
2. Create a new application.
3. Open the **Bot** page and create a bot.
4. Regenerate and copy the bot token.
5. Keep **Public Bot** disabled for private use.
6. Install the app into a private server using **Guild Install**.
7. Use these OAuth scopes:
   - `bot`
   - `applications.commands`
8. Use these bot permissions:
   - `Send Messages`
   - `Use Slash Commands`
   - `Embed Links` optional
9. Create a private channel such as `#hydra-control`.
10. Copy these IDs:
    - Application/client ID
    - Guild/server ID
    - Hydra control channel ID
    - Discord user ID for each allowed user

## Environment

Create or update `.env` with:

```env
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_application_id
DISCORD_GUILD_ID=your_discord_server_id
DISCORD_CHANNEL_ID=your_hydra_control_channel_id
DISCORD_ALLOWED_USER_IDS=comma,separated,discord,user,ids
```

`DISCORD_ALLOWED_USER_IDS` is required by default. If it is empty, the bridge will not start. To intentionally allow every user who can use slash commands in the configured channel to control Hydra, set:

```env
HYDRA_DISCORD_ALLOW_CHANNEL_MEMBERS=1
```

Hydra must also have its local MCP server enabled:

```sh
HYDRA_ENABLE_MCP_SERVER=1 npm run dev:desktop
```

By default, the Discord bridge reads Hydra's generated MCP token from the app data directory. If needed, override the token or token file:

```env
HYDRA_MCP_AUTH_TOKEN=your_hydra_mcp_token
HYDRA_MCP_AUTH_TOKEN_FILE=/path/to/mcp-auth-token
HYDRA_MCP_ENDPOINT=http://127.0.0.1:4141/mcp
HYDRA_MCP_HEALTH_URL=http://127.0.0.1:4141/health
```

`HYDRA_MCP_ENDPOINT` and `HYDRA_MCP_HEALTH_URL` must use `http://` and point to `localhost`, `127.0.0.1`, or `::1`. The bridge refuses non-loopback URLs so it does not send the Hydra MCP bearer token to another host.

## Running

Start Hydra with MCP enabled:

```sh
HYDRA_ENABLE_MCP_SERVER=1 npm run dev:desktop
```

Register guild slash commands:

```sh
npm run discord:register
```

Start the Discord bridge:

```sh
npm run discord:bot
```

If the `.env` file lives outside the current working directory, pass its path:

```sh
HYDRA_DISCORD_ENV_PATH=/path/to/.env npm run discord:bot
```

## Discord Commands

All commands are under `/hydra`.

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

- Never commit `.env`.
- Never paste bot tokens into chat, logs, issues, or pull requests.
- Regenerate the Discord bot token if it is exposed.
- Keep the control channel private.
- Keep `DISCORD_ALLOWED_USER_IDS` set for personal use.
- Set `HYDRA_DISCORD_ALLOW_CHANNEL_MEMBERS=1` only when every user with access to the configured channel should be able to control Hydra.
- Do not expose `127.0.0.1:4141` through a tunnel or public proxy.
- Keep the MCP endpoint and health URL on loopback addresses.
- Treat approvals from Discord as sensitive because they can allow agents to run tools or modify files.
