# MCP Server for Hydra - Architecture & Tool Mapping Plan

## Context

Hydra is an Electron desktop app ("Discord for coding agents") that orchestrates multiple AI coding agent sessions (Claude, Codex, Gemini, etc.) via PTY terminals. The goal is to wrap Hydra's full functionality in an MCP server, enabling:

1. **Voice agents** - AI agents that connect via MCP to control Hydra hands-free
2. **Discord bot remote control** - Users execute Hydra commands from Discord chat
3. **General programmatic access** - Any MCP-compatible client can drive Hydra

---

## Architecture: How the MCP Server Connects to Hydra

### The Bridge Problem

Hydra's business logic lives in `electron/main/main.ts` (the `AppController` class). All operations are IPC handlers (`ipcMain.handle`). The MCP server needs to call these same operations.

### Recommended Approach: Embedded MCP Server with SSE Transport

```
┌─────────────────────────────────────────────┐
│              Hydra Electron App              │
│                                              │
│  AppController (main.ts)                     │
│    ├── IPC Handlers ←── Renderer (UI)        │
│    └── Internal API ←── MCP Server (new)     │
│                           │                  │
│                      SSE Transport           │
│                      (HTTP :4141)            │
└──────────────────────────┬──────────────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
        Discord Bot              Voice Agent
        (MCP Client)            (MCP Client)
```

**How it works:**

1. **New file: `electron/main/mcp-server.ts`** - MCP server module that imports and calls `AppController` methods directly (no HTTP intermediary, no serialization overhead).

2. **SSE Transport** - The MCP server exposes an HTTP endpoint (e.g., `localhost:4141/mcp`) using the `@modelcontextprotocol/sdk` SSE transport. This allows remote MCP clients (Discord bot, voice agents) to connect.

3. **Internal API Layer** - Refactor `AppController` to expose a clean internal API (public methods) that both IPC handlers and MCP tools call. Currently the logic is inline in `ipcMain.handle` callbacks — extract it into named methods.

**Why this approach:**
- Zero latency — MCP tools call AppController methods directly in-process
- Single source of truth — same code path as the UI
- SSE transport enables remote access without a separate proxy
- MCP SDK handles protocol, serialization, tool dispatch

### Alternative: Standalone MCP Server + HTTP Bridge

If you want the MCP server to run independently of Hydra (e.g., headless server mode):

1. Add an HTTP API to Hydra's main process (`electron/main/http-api.ts`)
2. Build MCP server as a separate Node.js process that calls this HTTP API
3. More decoupled, but adds latency and a second process to manage

---

## Internal API Extraction

The first step is to refactor `AppController` in `main.ts` so its operations are callable outside of IPC. Currently:

```typescript
// Current: logic baked into IPC handler
ipcMain.handle("session:create", async (_e, repoId, launchesClaudeOnStart) => {
  // ... 40 lines of inline logic ...
});
```

Refactor to:

```typescript
// New: clean internal API
class AppController {
  async createSession(repoId: string, options: CreateSessionOptions): Promise<SessionRecord> {
    // ... same logic, now callable from anywhere ...
  }
}

// IPC handler becomes a thin wrapper
ipcMain.handle("session:create", (_e, repoId, opts) => this.createSession(repoId, opts));

// MCP tool handler calls the same method
server.tool("create_session", schema, (args) => this.createSession(args.repoId, args));
```

**Key methods to extract from `main.ts`** (lines reference current inline IPC handlers):

| Current IPC Channel | New Method | Approx Line |
|---------------------|-----------|-------------|
| `session:create` | `createSession()` | ~978 |
| `session:close` | `closeSession()` | ~1050 |
| `session:rename` | `renameSession()` | ~1030 |
| `session:organize` | `organizeSession()` | ~1035 |
| `session:reopen` | `reopenSession()` | ~1045 |
| `session:input` | `sendSessionInput()` | ~1060 |
| `session:resize` | `resizeSession()` | ~1070 |
| `session:focus` | `focusSession()` | ~1075 |
| `workspace:open` | `addWorkspace()` | ~960 |
| `workspace:rescan` | `rescanWorkspace()` | ~970 |
| `repo:updateAppLaunchConfig` | `updateAppLaunchConfig()` | ~1100 |
| `repo:buildAndRunApp` | `buildAndRunApp()` | ~1110 |
| `preferences:update` | `updatePreferences()` | ~1130 |
| `settings:loadFile` | `loadSettingsFile()` | ~1140 |
| `settings:saveFile` | `saveSettingsFile()` | ~1150 |
| `wiki:getContext` | `getWikiContext()` | ~1160 |
| `wiki:readFile` | `readWikiFile()` | ~1170 |
| `wiki:toggle` | `toggleWiki()` | ~1180 |
| `fs:readDir` | `readRepoDirectory()` | ~1200 |
| `fs:readFile` | `readRepoFile()` | ~1210 |
| `state:get` | `getSnapshot()` | ~950 |

---

## Complete MCP Tool Mapping

### Category 1: State & Overview

| MCP Tool | Description | Maps to IPC | Input | Output |
|----------|-------------|-------------|-------|--------|
| `get_app_state` | Full app state snapshot | `state:get` | none | `{workspaces, repos, sessions, preferences}` |
| `get_inbox` | Blocked & unread sessions | (derived from state) | none | `{blocked: Session[], unread: Session[]}` |

### Category 2: Workspace Management

| MCP Tool | Description | Maps to IPC | Input | Output |
|----------|-------------|-------------|-------|--------|
| `list_workspaces` | List all workspaces | (derived from state) | none | `Workspace[]` |
| `add_workspace` | Add workspace folder | `workspace:open` | `{path: string}` | `Workspace` |
| `rescan_workspace` | Re-discover repos | `workspace:rescan` | `{workspaceId: string}` | `Repo[]` |

### Category 3: Repository Management

| MCP Tool | Description | Maps to IPC | Input | Output |
|----------|-------------|-------------|-------|--------|
| `list_repos` | List repos | (derived from state) | `{workspaceId?: string}` | `Repo[]` |
| `get_repo` | Repo details | (derived from state) | `{repoId: string}` | `Repo` |
| `list_files` | File tree of repo | `fs:readDir` | `{repoId: string}` | `FileTreeNode[]` |
| `read_file` | Read file content | `fs:readFile` | `{repoId: string, path: string}` | `{content: string}` |
| `set_build_run_config` | Set build/run commands | `repo:updateAppLaunchConfig` | `{repoId, buildCmd, runCmd}` | `void` |
| `build_and_run_app` | Execute build+run | `repo:buildAndRunApp` | `{repoId: string}` | `{sessionId: string}` |

### Category 4: Session Management (Core)

| MCP Tool | Description | Maps to IPC | Input | Output |
|----------|-------------|-------------|-------|--------|
| `list_sessions` | List sessions with filters | (derived from state) | `{repoId?, status?, limit?}` | `Session[]` |
| `get_session` | Session details + transcript | (derived from state) | `{sessionId: string}` | `Session` (with transcript) |
| `create_session` | Create new session | `session:create` | `{repoId, agentId?, autoLaunch?}` | `{sessionId: string}` |
| `rename_session` | Rename session | `session:rename` | `{sessionId, title}` | `void` |
| `close_session` | Close/delete session | `session:close` | `{sessionId: string}` | `void` |
| `reopen_session` | Reopen stopped session | `session:reopen` | `{sessionId: string}` | `void` |
| `organize_session` | Pin, tag, color, move | `session:organize` | `{sessionId, pin?, tagColor?, repoId?}` | `void` |
| `send_input` | Send text to terminal | `session:input` | `{sessionId, text}` | `void` |
| `approve_action` | Approve session blocker | (special input) | `{sessionId: string}` | `void` |
| `deny_action` | Deny session blocker | (special input) | `{sessionId: string}` | `void` |
| `search_sessions` | Search transcripts | `sessionSearch:query` | `{repoId, query}` | `SearchResult[]` |
| `resume_session` | Resume from Claude/Codex session | `session:resumeFromClaude` | `{repoId, claudeSessionId}` | `{sessionId}` |
| `get_next_unread` | Jump to next unread | `session:nextUnread` | none | `{sessionId?}` |

### Category 5: Agent Configuration

| MCP Tool | Description | Maps to IPC | Input | Output |
|----------|-------------|-------------|-------|--------|
| `list_agents` | Available agent types | (AGENT_DEFINITIONS) | none | `Agent[]` |
| `set_default_agent` | Set default agent | `preferences:update` | `{agentId: string}` | `void` |
| `set_agent_command` | Override agent CLI | `preferences:update` | `{agentId, command}` | `void` |

### Category 6: Preferences & Settings

| MCP Tool | Description | Maps to IPC | Input | Output |
|----------|-------------|-------------|-------|--------|
| `get_preferences` | Get all preferences | (derived from state) | none | `Preferences` |
| `update_preferences` | Update preferences | `preferences:update` | `{patch: object}` | `void` |
| `get_settings_context` | Claude settings for repo | `settings:context` | `{repoId: string}` | `SettingsContext` |
| `load_settings_file` | Read settings file | `settings:loadFile` | `{repoId, filePath}` | `{content: string}` |
| `save_settings_file` | Write settings file | `settings:saveFile` | `{repoId, filePath, content}` | `void` |

### Category 7: Wiki

| MCP Tool | Description | Maps to IPC | Input | Output |
|----------|-------------|-------------|-------|--------|
| `get_wiki` | Wiki tree & status | `wiki:getContext` | `{repoId: string}` | `{enabled, tree}` |
| `read_wiki_page` | Read wiki markdown | `wiki:readFile` | `{repoId, path}` | `{content: string}` |
| `toggle_wiki` | Enable/disable wiki | `wiki:toggle` | `{repoId, enabled}` | `void` |

### Category 8: Skills Marketplace

| MCP Tool | Description | Maps to IPC | Input | Output |
|----------|-------------|-------------|-------|--------|
| `get_skill_details` | Skill info from marketplace | `skillsMarketplace:details` | `{owner, repo, path}` | `SkillDetails` |
| `inspect_skill_url` | Inspect GitHub skill URL | `skillsMarketplace:inspectUrl` | `{url: string}` | `InspectResult` |
| `install_skill` | Install marketplace skill | `skillsMarketplace:install` | `{owner, repo, path, scope}` | `void` |

### Category 9: Monitoring & Tools

| MCP Tool | Description | Maps to IPC | Input | Output |
|----------|-------------|-------------|-------|--------|
| `get_port_status` | Dev port monitoring | `status:ports` | none | `PortStatus[]` |
| `launch_ephemeral_tool` | Launch lazygit/tokscale | `ephemeralTool:launch` | `{toolId, repoId}` | `{sessionId}` |
| `close_ephemeral_tool` | Close ephemeral tool | `ephemeralTool:close` | `{toolId, sessionId}` | `void` |

**Total: ~40 MCP tools covering 100% of Hydra's functionality**

---

## MCP Resources (Read-Only Data)

MCP resources provide read-only access to Hydra data without requiring tool calls:

| Resource URI | Description |
|-------------|-------------|
| `hydra://state` | Full app state snapshot |
| `hydra://sessions` | All sessions list |
| `hydra://sessions/{id}` | Single session with transcript |
| `hydra://sessions/{id}/transcript` | Raw session transcript text |
| `hydra://repos/{id}/files` | File tree for a repo |
| `hydra://repos/{id}/wiki` | Wiki tree for a repo |
| `hydra://agents` | Available agent definitions |
| `hydra://preferences` | Current preferences |

---

## MCP Resource Subscriptions (Real-Time)

For live session output streaming (critical for voice agents and Discord bot):

| Subscription | Trigger | Payload |
|--------------|---------|---------|
| `hydra://sessions/{id}/output` | New terminal output | `{data: string, session: SessionSummary}` |
| `hydra://state` | Any state change | Full `AppStateSnapshot` |
| `hydra://sessions/{id}` | Session status change | `SessionSummary` |
| `hydra://plans/{sessionId}` | Plan detected | `{sessionId, markdown}` |

The MCP server uses `server.notification({ method: "notifications/resources/updated", params: { uri } })` when data changes. Clients call `resources/subscribe` to opt in.

**Implementation:** Hook into existing event emitters:
- `sendSessionOutput()` → emit resource update for `hydra://sessions/{id}/output`
- `broadcastState()` → emit resource update for `hydra://state`
- `sendPlanDetected()` → emit resource update for `hydra://plans/{sessionId}`

---

## MCP Prompts (Reusable Templates)

For voice agents and Discord bot to quickly get contextual summaries:

| Prompt | Description | Arguments |
|--------|-------------|-----------|
| `review_blockers` | "Review all blocked sessions and suggest actions" | none |
| `session_summary` | "Summarize what happened in this session" | `{sessionId}` |
| `project_status` | "Overview of all active work across repos" | `{repoId?}` |
| `agent_recommendation` | "Which agent should I use for this task?" | `{taskDescription}` |

---

## How External Clients Connect

### Discord Bot

```
Discord User (slash command)
    ↓
Discord Bot (Node.js process)
    ↓ (MCP Client SDK, connects to SSE endpoint)
Hydra MCP Server (localhost:4141/mcp)
    ↓
AppController methods
```

Discord slash commands map 1:1 to MCP tools:
- `/hydra session create <repo> <agent>` → `create_session`
- `/hydra session list` → `list_sessions`
- `/hydra send <session> <text>` → `send_input`
- `/hydra approve <session>` → `approve_action`
- `/hydra status` → `get_inbox`

The bot subscribes to session output resources and posts live updates to Discord channels.

### Voice Agent

```
User (speech)
    ↓ (speech-to-text)
AI Agent (Claude/GPT with MCP tools)
    ↓ (MCP tool calls)
Hydra MCP Server
    ↓
AppController methods
    ↓ (session output subscription)
AI Agent reads output
    ↓ (text-to-speech)
User (hears response)
```

The voice agent connects as an MCP client, uses tools to control Hydra, and subscribes to session output for real-time awareness.

---

## Key Technical Details

### Approve/Deny Logic Per Agent

The MCP `approve_action` / `deny_action` tools must handle agent-specific input sequences (from `main.ts` signal handling):

| Agent | Approve | Deny |
|-------|---------|------|
| Claude | Send `"1\r"` | Send `"3\r"` |
| Codex | Send `"\r"` (Enter) | Send `"\x1b[B\r"` (Arrow Down + Enter) |
| Others | Send `"y\r"` | Send `"n\r"` |

### Session Transcript Access

Transcripts are stored in two forms:
- `transcript` — visible text (ANSI stripped, via `TerminalTranscriptBuffer`)
- `rawTranscript` — raw terminal output with escape codes

MCP tools should return `transcript` (clean text) by default, with an option for `rawTranscript`.

### State Persistence

All mutations go through `scheduleSave()` (debounced 1s write to `app-state.json`). MCP tools that mutate state will automatically persist via this mechanism since they call the same internal methods.

### Access Model

- MCP server binds to **localhost only** — no remote binding
- Discord bot runs on the same machine or connects via SSH/Cloudflare Tunnel
- No API key auth needed for localhost (process-level isolation is sufficient)
- File read/write operations are scoped to repo roots (existing validation in AppController)

### Real-Time Delivery

- Use MCP **resource subscriptions** (`notifications/resources/updated`) for live session output
- Clients call `resources/subscribe` with URI `hydra://sessions/{id}/output` to opt in
- On each PTY data event, the MCP server emits a notification with the new chunk
- Discord bot receives notification → posts update to Discord channel

---

## File Structure for Implementation

```
electron/main/
├── mcp-server.ts          # MCP server setup, tool registration, SSE transport
├── mcp-tools/
│   ├── session-tools.ts    # Session CRUD tools
│   ├── workspace-tools.ts  # Workspace/repo tools
│   ├── agent-tools.ts      # Agent config tools
│   ├── settings-tools.ts   # Preferences/settings tools
│   ├── wiki-tools.ts       # Wiki tools
│   ├── marketplace-tools.ts # Skills marketplace tools
│   └── monitoring-tools.ts  # Port status, ephemeral tools
├── mcp-resources.ts        # Resource definitions & subscriptions
├── mcp-prompts.ts          # Prompt templates
└── internal-api.ts         # Extracted AppController methods (shared by IPC + MCP)
```

### Dependencies to Add

```json
{
  "@modelcontextprotocol/sdk": "latest",
  "express": "^4.x"  // or built-in http module for SSE transport
}
```

---

## Summary

The MCP server is an **embedded module** inside Hydra's Electron main process that:
1. Calls `AppController` methods directly (zero overhead)
2. Exposes ~40 tools covering 100% of Hydra's features
3. Serves via SSE transport on a local HTTP port
4. Supports real-time subscriptions for session output streaming
5. Enables Discord bot and voice agents as MCP clients
