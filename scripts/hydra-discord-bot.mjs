#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DISCORD_API = "https://discord.com/api/v10";
const HYDRA_COMMAND_NAME = "hydra";
const MCP_PROTOCOL_VERSION = "2025-03-26";
const DISCORD_MESSAGE_LIMIT = 2000;
const DEFAULT_MCP_ENDPOINT = "http://127.0.0.1:4141/mcp";
const DEFAULT_MCP_HEALTH_URL = "http://127.0.0.1:4141/health";
const EPHEMERAL_FLAG = 1 << 6;
const INTENT_GUILDS = 1 << 0;
const DISCORD_HEARTBEAT_INTERVAL_MS = 30_000;
const ALLOW_CHANNEL_MEMBERS_ENV = "HYDRA_DISCORD_ALLOW_CHANNEL_MEMBERS";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const commandDefinitions = [
  {
    name: HYDRA_COMMAND_NAME,
    description: "Control local Hydra sessions",
    type: 1,
    options: [
      {
        type: 1,
        name: "status",
        description: "Show Hydra MCP health and session counts",
      },
      {
        type: 1,
        name: "inbox",
        description: "Show blocked or unread sessions",
      },
      {
        type: 1,
        name: "sessions",
        description: "List recent Hydra sessions",
        options: [
          {
            type: 3,
            name: "status",
            description: "Filter by session status",
            choices: [
              "running",
              "blocked",
              "needs_input",
              "failed",
              "done",
              "idle",
            ].map((value) => ({ name: value, value })),
          },
          {
            type: 4,
            name: "limit",
            description: "Maximum sessions to show",
            required: false,
            min_value: 1,
            max_value: 20,
          },
        ],
      },
      {
        type: 1,
        name: "tail",
        description: "Show recent terminal output for a session",
        options: [
          {
            type: 3,
            name: "session",
            description: "Hydra session ID",
            required: true,
          },
          {
            type: 4,
            name: "lines",
            description: "Number of lines to return",
            required: false,
            min_value: 1,
            max_value: 80,
          },
        ],
      },
      {
        type: 1,
        name: "prompt",
        description: "Send a prompt to a session",
        options: [
          {
            type: 3,
            name: "session",
            description: "Hydra session ID",
            required: true,
          },
          {
            type: 3,
            name: "text",
            description: "Prompt text",
            required: true,
            max_length: 2000,
          },
        ],
      },
      {
        type: 1,
        name: "focused-prompt",
        description: "Send a prompt to the focused session",
        options: [
          {
            type: 3,
            name: "text",
            description: "Prompt text",
            required: true,
            max_length: 2000,
          },
        ],
      },
      {
        type: 1,
        name: "approve",
        description: "Approve a blocked action",
        options: [
          {
            type: 3,
            name: "session",
            description: "Hydra session ID; omit to approve focused session",
            required: false,
          },
        ],
      },
      {
        type: 1,
        name: "deny",
        description: "Deny a blocked action",
        options: [
          {
            type: 3,
            name: "session",
            description: "Hydra session ID; omit to deny focused session",
            required: false,
          },
        ],
      },
      {
        type: 1,
        name: "focus",
        description: "Set Hydra's focused session",
        options: [
          {
            type: 3,
            name: "session",
            description: "Hydra session ID",
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "new",
        description: "Create a new Hydra agent session",
        options: [
          {
            type: 3,
            name: "repo",
            description: "Hydra repo ID",
            required: true,
          },
          {
            type: 3,
            name: "prompt",
            description: "Initial prompt",
            required: true,
            max_length: 2000,
          },
          {
            type: 3,
            name: "agent",
            description: "Agent to launch",
            required: false,
            choices: [
              "claude",
              "codex",
              "gemini",
              "aider",
              "opencode",
              "goose",
              "amazon-q",
              "github-copilot",
              "junie",
              "qwen",
              "amp",
              "warp",
            ].map((value) => ({ name: value, value })),
          },
        ],
      },
    ],
  },
];

class HydraMcpClient {
  constructor({ endpoint, healthUrl, token }) {
    this.endpoint = endpoint;
    this.healthUrl = healthUrl;
    this.token = token;
    this.sessionId = null;
    this.nextId = 1;
  }

  async health() {
    const response = await fetch(this.healthUrl, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) {
      throw new Error(`Hydra MCP health check failed: HTTP ${response.status}`);
    }
    return response.json();
  }

  async callTool(name, args) {
    await this.ensureInitialized();
    return this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    }, true);
  }

  async ensureInitialized() {
    if (this.sessionId) return;

    await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "hydra-discord-bot",
          version: "0.1.0",
        },
      },
    }, false);

    if (!this.sessionId) {
      throw new Error("Hydra MCP initialize did not return an mcp-session-id header.");
    }

    await this.post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }, true);
  }

  async post(payload, includeSession) {
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };
    if (includeSession && this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const responseSessionId = response.headers.get("mcp-session-id");
    if (responseSessionId) {
      this.sessionId = responseSessionId;
    }

    if (response.status === 202 || response.status === 204) {
      return null;
    }

    const parsed = await parseRpcResponse(response);
    if (parsed?.error) {
      throw new Error(parsed.error.message || JSON.stringify(parsed.error));
    }
    return parsed?.result ?? parsed;
  }
}

function loadDotEnv() {
  const envPath = process.env.HYDRA_DISCORD_ENV_PATH || path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const contents = fs.readFileSync(envPath, "utf8");
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(trimmed);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = unquoteEnvValue(match[2].trim());
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readMcpToken() {
  if (process.env.HYDRA_MCP_AUTH_TOKEN?.trim()) {
    return process.env.HYDRA_MCP_AUTH_TOKEN.trim();
  }

  const tokenFile = process.env.HYDRA_MCP_AUTH_TOKEN_FILE || defaultHydraMcpTokenPath();
  if (tokenFile && fs.existsSync(tokenFile)) {
    return fs.readFileSync(tokenFile, "utf8").trim();
  }

  throw new Error(
    "Missing Hydra MCP token. Start Hydra with HYDRA_ENABLE_MCP_SERVER=1, then set HYDRA_MCP_AUTH_TOKEN or HYDRA_MCP_AUTH_TOKEN_FILE."
  );
}

function defaultHydraMcpTokenPath() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Hydra", "mcp-auth-token");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Hydra", "mcp-auth-token");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Hydra", "mcp-auth-token");
}

function readConfig({ requireHydra }) {
  loadDotEnv();
  const token = requiredEnv("DISCORD_BOT_TOKEN");
  const applicationId = process.env.DISCORD_CLIENT_ID || process.env.DISCORD_APPLICATION_ID;
  const guildId = process.env.DISCORD_GUILD_ID;
  const channelId = process.env.DISCORD_CHANNEL_ID;

  if (!applicationId) throw new Error("Missing DISCORD_CLIENT_ID.");
  if (!guildId) throw new Error("Missing DISCORD_GUILD_ID.");
  if (!channelId) throw new Error("Missing DISCORD_CHANNEL_ID.");

  return {
    token,
    applicationId,
    guildId,
    channelId,
    allowedUserIds: new Set(splitCsv(process.env.DISCORD_ALLOWED_USER_IDS)),
    channelMemberAccessAllowed: isEnabledFlag(process.env[ALLOW_CHANNEL_MEMBERS_ENV]),
    hydra: requireHydra
      ? new HydraMcpClient({
          endpoint: requireLoopbackHttpUrl(
            process.env.HYDRA_MCP_ENDPOINT || DEFAULT_MCP_ENDPOINT,
            "HYDRA_MCP_ENDPOINT"
          ),
          healthUrl: requireLoopbackHttpUrl(
            process.env.HYDRA_MCP_HEALTH_URL || DEFAULT_MCP_HEALTH_URL,
            "HYDRA_MCP_HEALTH_URL"
          ),
          token: readMcpToken(),
        })
      : null,
  };
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function splitCsv(value) {
  if (!value) return [];
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function isEnabledFlag(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function requireLoopbackHttpUrl(value, name) {
  const text = String(value || "").trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }

  if (url.protocol !== "http:") {
    throw new Error(`${name} must use http://.`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not include credentials.`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${name} must point to localhost, 127.0.0.1, or ::1.`);
  }
  return url.toString();
}

async function discordRequest(config, route, init = {}) {
  const response = await fetch(`${DISCORD_API}${route}`, {
    ...init,
    headers: {
      authorization: `Bot ${config.token}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord API ${route} failed: HTTP ${response.status} ${body}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function registerCommands(config) {
  const applicationId = safeDiscordPathSegment(config.applicationId, "application ID");
  const guildId = safeDiscordPathSegment(config.guildId, "guild ID");
  await discordRequest(
    config,
    `/applications/${applicationId}/guilds/${guildId}/commands`,
    {
      method: "PUT",
      body: JSON.stringify(commandDefinitions),
    }
  );
  console.log(`Registered /${HYDRA_COMMAND_NAME} commands in guild ${config.guildId}.`);
}

async function startBot(config) {
  if (config.allowedUserIds.size === 0 && !config.channelMemberAccessAllowed) {
    throw new Error(
      `Missing DISCORD_ALLOWED_USER_IDS. Set allowed Discord user IDs, or set ${ALLOW_CHANNEL_MEMBERS_ENV}=1 to allow anyone with access to the configured channel.`
    );
  }
  if (config.channelMemberAccessAllowed) {
    console.warn(`${ALLOW_CHANNEL_MEMBERS_ENV}=1; access is restricted only by guild and channel.`);
  }

  if (process.env.HYDRA_DISCORD_SKIP_REGISTER !== "1") {
    await registerCommands(config);
  }

  await config.hydra.health();
  connectGateway(config);
}

async function connectGateway(config) {
  const gateway = await discordRequest(config, "/gateway/bot");
  const socket = new WebSocket(`${gateway.url}/?v=10&encoding=json`);
  let sequence = null;
  let heartbeatTimer = null;

  socket.addEventListener("open", () => {
    console.log("Discord gateway connected.");
  });

  socket.addEventListener("message", async (event) => {
    const packet = JSON.parse(event.data);
    if (packet.s !== null && packet.s !== undefined) sequence = packet.s;

    if (packet.op === 10) {
      heartbeatTimer = setInterval(() => {
        socket.send(JSON.stringify({ op: 1, d: sequence }));
      }, DISCORD_HEARTBEAT_INTERVAL_MS);
      socket.send(JSON.stringify({
        op: 2,
        d: {
          token: config.token,
          intents: INTENT_GUILDS,
          properties: {
            os: process.platform,
            browser: "hydra-discord-bot",
            device: "hydra-discord-bot",
          },
        },
      }));
      return;
    }

    if (packet.t === "READY") {
      console.log(`Logged in as ${packet.d.user.username}#${packet.d.user.discriminator}.`);
      return;
    }

    if (packet.t === "INTERACTION_CREATE") {
      await handleInteraction(config, packet.d).catch((error) => {
        console.error("Interaction failed:", error);
      });
    }
  });

  socket.addEventListener("close", (event) => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    console.warn(`Discord gateway closed (${event.code}). Reconnecting in 5s.`);
    setTimeout(() => connectGateway(config).catch((error) => {
      console.error("Discord gateway reconnect failed:", error);
    }), 5000);
  });

  socket.addEventListener("error", (event) => {
    console.error("Discord gateway error:", event);
  });
}

async function handleInteraction(config, interaction) {
  if (interaction.type !== 2 || interaction.data?.name !== HYDRA_COMMAND_NAME) return;

  const authError = authorizationError(config, interaction);
  if (authError) {
    await respondToInteraction(config, interaction, authError, true);
    return;
  }

  await deferInteraction(config, interaction);

  try {
    const content = await runHydraCommand(config, interaction);
    await editInteractionResponse(config, interaction, content);
  } catch (error) {
    await editInteractionResponse(config, interaction, `Hydra command failed: ${error.message}`);
  }
}

function authorizationError(config, interaction) {
  if (interaction.guild_id !== config.guildId) {
    return "This bot is restricted to its configured guild.";
  }
  if (interaction.channel_id !== config.channelId) {
    return "Use Hydra commands in the configured Hydra control channel.";
  }
  const userId = interaction.member?.user?.id || interaction.user?.id;
  if (config.allowedUserIds.size > 0 && !config.allowedUserIds.has(userId)) {
    return "You are not allowed to control Hydra.";
  }
  return null;
}

async function respondToInteraction(config, interaction, content, ephemeral) {
  const interactionId = safeDiscordPathSegment(interaction.id, "interaction ID");
  const interactionToken = safeDiscordPathSegment(interaction.token, "interaction token");
  await discordRequest(config, `/interactions/${interactionId}/${interactionToken}/callback`, {
    method: "POST",
    body: JSON.stringify({
      type: 4,
      data: {
        content: limitDiscord(content),
        flags: ephemeral ? EPHEMERAL_FLAG : undefined,
      },
    }),
  });
}

async function deferInteraction(config, interaction) {
  const interactionId = safeDiscordPathSegment(interaction.id, "interaction ID");
  const interactionToken = safeDiscordPathSegment(interaction.token, "interaction token");
  await discordRequest(config, `/interactions/${interactionId}/${interactionToken}/callback`, {
    method: "POST",
    body: JSON.stringify({
      type: 5,
      data: { flags: EPHEMERAL_FLAG },
    }),
  });
}

async function editInteractionResponse(config, interaction, content) {
  const applicationId = safeDiscordPathSegment(config.applicationId, "application ID");
  const interactionToken = safeDiscordPathSegment(interaction.token, "interaction token");
  await discordRequest(
    config,
    `/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      body: JSON.stringify({ content: limitDiscord(content) }),
    }
  );
}

function safeDiscordPathSegment(value, name) {
  const text = String(value ?? "");
  if (!text) throw new Error(`Missing Discord ${name}.`);
  if (/[/?#\\]/u.test(text)) {
    throw new Error(`Invalid Discord ${name}.`);
  }
  return encodeURIComponent(text);
}

async function runHydraCommand(config, interaction) {
  const subcommand = interaction.data.options?.find((option) => option.type === 1);
  if (!subcommand) return "No Hydra subcommand was provided.";
  const options = optionsByName(subcommand.options || []);

  switch (subcommand.name) {
    case "status":
      return formatStatus(await toolJson(config, "get_app_state"));
    case "inbox":
      return formatInbox(await toolJson(config, "get_app_state"));
    case "sessions":
      return formatSessions(await toolJson(config, "get_app_state"), {
        status: options.status,
        limit: options.limit || 10,
      });
    case "tail":
      return formatTail(await toolJson(config, "get_session_tail", {
        sessionId: options.session,
        lines: options.lines || 30,
        maxChars: 1500,
      }));
    case "prompt":
      await sendPromptToSession(config, options.session, options.text);
      return `Sent prompt to session \`${options.session}\`.`;
    case "focused-prompt":
      await sendPromptToFocusedSession(config, options.text);
      return "Sent prompt to the focused session.";
    case "approve":
      if (options.session) {
        await toolJson(config, "approve_action", { sessionId: options.session });
        return `Approved blocker in session \`${options.session}\`.`;
      }
      await toolJson(config, "approve_focused_action");
      return "Approved blocker in the focused session.";
    case "deny":
      if (options.session) {
        await toolJson(config, "deny_action", { sessionId: options.session });
        return `Denied blocker in session \`${options.session}\`.`;
      }
      await toolJson(config, "deny_focused_action");
      return "Denied blocker in the focused session.";
    case "focus":
      await toolJson(config, "focus_session", { sessionId: options.session });
      return `Focused session \`${options.session}\`.`;
    case "new": {
      const sessionId = await toolJson(config, "create_session", {
        repoId: options.repo,
        agentId: options.agent,
        prompt: options.prompt,
      });
      return sessionId ? `Created session \`${sessionId}\`.` : "Hydra did not create a session.";
    }
    default:
      return `Unknown Hydra subcommand: ${subcommand.name}`;
  }
}

async function sendPromptToSession(config, sessionId, text) {
  await toolJson(config, "send_text", { sessionId, text });
  await delayMs(75);
  await toolJson(config, "send_key", { sessionId, key: "enter" });
}

async function sendPromptToFocusedSession(config, text) {
  await toolJson(config, "send_focused_text", { text });
  await delayMs(75);
  await toolJson(config, "send_focused_key", { key: "enter" });
}

function delayMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function optionsByName(options) {
  const mapped = {};
  for (const option of options) {
    mapped[option.name] = option.value;
  }
  return mapped;
}

async function toolJson(config, name, args = {}) {
  const result = await config.hydra.callTool(name, args);
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatStatus(snapshot) {
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const counts = countBy(sessions, "status");
  const liveCount = sessions.filter((session) => session.runtimeState === "live").length;
  const blockedCount = sessions.filter((session) => session.blocker).length;
  const unreadCount = sessions.reduce((sum, session) => sum + (session.unreadCount || 0), 0);

  return [
    "**Hydra status**",
    `Repos: ${snapshot.repos?.length || 0}`,
    `Sessions: ${sessions.length} (${liveCount} live)`,
    `Blocked: ${blockedCount}`,
    `Unread lines: ${unreadCount}`,
    `By status: ${formatCounts(counts) || "none"}`,
  ].join("\n");
}

function formatInbox(snapshot) {
  const sessions = (snapshot.sessions || [])
    .filter((session) => session.blocker || session.unreadCount > 0)
    .sort(compareSessionActivity)
    .slice(0, 10);

  if (sessions.length === 0) return "No blocked or unread sessions.";
  const repoNames = repoNamesById(snapshot);
  return [
    "**Hydra inbox**",
    ...sessions.map((session) => formatSessionLine(session, repoNames)),
  ].join("\n");
}

function formatSessions(snapshot, { status, limit }) {
  let sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  if (status) sessions = sessions.filter((session) => session.status === status);
  sessions = [...sessions].sort(compareSessionActivity).slice(0, limit);

  if (sessions.length === 0) return "No matching Hydra sessions.";
  const repoNames = repoNamesById(snapshot);
  return [
    `**Hydra sessions** (${sessions.length})`,
    ...sessions.map((session) => formatSessionLine(session, repoNames)),
  ].join("\n");
}

function formatSessionLine(session, repoNames) {
  const repo = repoNames.get(session.repoID) || session.repoID;
  const unread = session.unreadCount ? ` unread:${session.unreadCount}` : "";
  const blocker = session.blocker ? ` blocker:${session.blocker.kind}` : "";
  return `\`${session.id}\` ${session.status}/${session.runtimeState}${unread}${blocker} - ${repo} - ${session.title}`;
}

function formatTail(result) {
  if (result.error) return result.error;
  const text = result.transcript?.text || "";
  if (!text.trim()) return `No transcript output for session \`${result.sessionId}\`.`;
  return [
    `**${result.title || result.sessionId}** ${result.status}/${result.runtimeState}`,
    codeBlock(text, "text"),
  ].join("\n");
}

function repoNamesById(snapshot) {
  return new Map((snapshot.repos || []).map((repo) => [repo.id, repo.name]));
}

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) {
    const value = item[key] || "unknown";
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}

function formatCounts(counts) {
  return [...counts.entries()].map(([key, value]) => `${key}:${value}`).join(", ");
}

function compareSessionActivity(left, right) {
  const leftTime = left.lastActivityAt || left.updatedAt || "";
  const rightTime = right.lastActivityAt || right.updatedAt || "";
  return rightTime.localeCompare(leftTime);
}

function codeBlock(value, language) {
  return `\`\`\`${language}\n${String(value).replaceAll("```", "`\u200b``")}\n\`\`\``;
}

function limitDiscord(content) {
  if (content.length <= DISCORD_MESSAGE_LIMIT) return content;
  return `${content.slice(0, DISCORD_MESSAGE_LIMIT - 20)}\n...[truncated]`;
}

async function parseRpcResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Hydra MCP HTTP ${response.status}: ${text}`);
  }
  if (!text.trim()) return null;
  if (contentType.includes("text/event-stream")) {
    return parseSseJson(text);
  }
  return JSON.parse(text);
}

function parseSseJson(text) {
  for (const event of text.split(/\n\n+/u)) {
    const data = event
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    return JSON.parse(data);
  }
  return null;
}

async function main() {
  const mode = process.argv[2] || "start";
  const config = readConfig({ requireHydra: mode === "start" });

  if (mode === "register") {
    await registerCommands(config);
    return;
  }

  if (mode === "start") {
    await startBot(config);
    return;
  }

  throw new Error(`Unknown mode: ${mode}. Use "start" or "register".`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
