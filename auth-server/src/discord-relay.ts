import type { Context } from "hono";
import type {
  DurableObjectState,
  IncomingRequestCfProperties,
  WebSocket as CloudflareWebSocket,
} from "@cloudflare/workers-types";
import { createAuth } from "./auth";
import { getAuthRuntimeConfig, type CloudflareBindings } from "./env";

const DISCORD_API = "https://discord.com/api/v10";
const HYDRA_COMMAND_NAME = "hydra";
const RELAY_PROTOCOL_VERSION = 1;
const RELAY_TOKEN_TTL_MS = 5 * 60 * 1000;
const RELAY_COMMAND_TIMEOUT_MS = 25_000;
const DISCORD_EPHEMERAL_FLAG = 1 << 6;
const DISCORD_INTEGRATION_TYPE_GUILD_INSTALL = 0;
const DISCORD_INTERACTION_CONTEXT_GUILD = 0;
const DISCORD_MESSAGE_LIMIT = 2000;
const DISCORD_ID_PATTERN = /^\d{5,30}$/u;
const DISCORD_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;
const DISCORD_LINK_CODE_TTL_MS = 10 * 60 * 1000;
const DISCORD_LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DISCORD_LINK_CODE_PATTERN = /^[A-Z2-9]{8}$/u;

type HydraContext = Context<{ Bindings: CloudflareBindings }>;

type AuthSessionPayload = {
  user?: {
    id?: unknown;
  } | null;
};

type DiscordControlSettings = {
  enabled: boolean;
  guildId: string;
  channelId: string;
  allowedUserIds: string[];
};

type DiscordSettingsRow = {
  enabled: number;
  guild_id: string;
  channel_id: string;
  allowed_user_ids: string;
};

type DiscordLinkCodeRow = {
  user_id: string;
  expires_at: number;
};

type RelayTokenPayload = {
  exp: number;
  nonce: string;
  userId: string;
};

type DiscordInteraction = {
  id?: string;
  application_id?: string;
  token?: string;
  type?: number;
  guild_id?: string;
  channel_id?: string;
  data?: {
    name?: string;
    options?: DiscordInteractionOption[];
  };
  member?: {
    user?: {
      id?: string;
    };
  };
  user?: {
    id?: string;
  };
};

type DiscordInteractionOption = {
  type: number;
  name: string;
  value?: string | number | boolean;
  options?: DiscordInteractionOption[];
};

type DiscordHydraCommandName =
  | "status"
  | "inbox"
  | "sessions"
  | "tail"
  | "prompt"
  | "focused-prompt"
  | "approve"
  | "deny"
  | "focus"
  | "new"
  | "link";

type DiscordHydraCommandPayload = {
  name: DiscordHydraCommandName;
  options: Record<string, string | number | boolean | null>;
  guildId: string;
  channelId: string;
  userId: string;
};

type RelayDispatchRequest = {
  requestId: string;
  command: DiscordHydraCommandPayload;
};

type RelayCommandResult = {
  ok: boolean;
  content?: string;
  error?: string;
};

type PendingRelayCommand = {
  resolve: (result: RelayCommandResult) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type DesktopSocketMessage =
  | {
      type: "hello";
      protocolVersion: number;
    }
  | {
      type: "hydra-command-result";
      requestId: string;
      ok: true;
      content: string;
    }
  | {
      type: "hydra-command-result";
      requestId: string;
      ok: false;
      error: string;
    }
  | {
      type: "pong";
    };

const commandDefinitions = [
  {
    name: HYDRA_COMMAND_NAME,
    description: "Control your active Hydra desktop",
    type: 1,
    integration_types: [DISCORD_INTEGRATION_TYPE_GUILD_INSTALL],
    contexts: [DISCORD_INTERACTION_CONTEXT_GUILD],
    options: [
      {
        type: 1,
        name: "link",
        description: "Link this Discord channel to your signed-in Hydra desktop",
        options: [
          {
            type: 3,
            name: "code",
            description: "Hydra link code",
            required: true,
            min_length: 8,
            max_length: 8,
          },
        ],
      },
      { type: 1, name: "status", description: "Show Hydra status" },
      { type: 1, name: "inbox", description: "Show blocked or unread sessions" },
      {
        type: 1,
        name: "sessions",
        description: "List recent Hydra sessions",
        options: [
          {
            type: 3,
            name: "status",
            description: "Filter by session status",
            required: false,
            choices: ["running", "blocked", "needs_input", "failed", "done", "idle"].map((value) => ({
              name: value,
              value,
            })),
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
          { type: 3, name: "session", description: "Hydra session ID", required: true },
        ],
      },
      {
        type: 1,
        name: "prompt",
        description: "Send a prompt to a session",
        options: [
          { type: 3, name: "session", description: "Hydra session ID", required: true },
          { type: 3, name: "text", description: "Prompt text", required: true, max_length: 2000 },
        ],
      },
      {
        type: 1,
        name: "focused-prompt",
        description: "Send a prompt to the focused session",
        options: [
          { type: 3, name: "text", description: "Prompt text", required: true, max_length: 2000 },
        ],
      },
      {
        type: 1,
        name: "approve",
        description: "Approve a blocked action",
        options: [
          { type: 3, name: "session", description: "Hydra session ID; omit to approve focused session", required: false },
        ],
      },
      {
        type: 1,
        name: "deny",
        description: "Deny a blocked action",
        options: [
          { type: 3, name: "session", description: "Hydra session ID; omit to deny focused session", required: false },
        ],
      },
      {
        type: 1,
        name: "focus",
        description: "Set Hydra's focused session",
        options: [
          { type: 3, name: "session", description: "Hydra session ID", required: true },
        ],
      },
      {
        type: 1,
        name: "new",
        description: "Create a new Hydra agent session",
        options: [
          { type: 3, name: "repo", description: "Hydra repo ID", required: true },
          { type: 3, name: "prompt", description: "Initial prompt", required: true, max_length: 2000 },
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

export async function handleDiscordControlSettings(c: HydraContext): Promise<Response> {
  const userId = await requireAuthUserId(c);
  if (c.req.method === "GET") {
    return c.json(await readDiscordSettings(c.env, userId));
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid Discord settings payload." }, 400);
  }

  const current = await readDiscordSettings(c.env, userId);
  const patch = body as Partial<DiscordControlSettings>;
  const settings = normalizeSettingsPatch(current, patch);
  await writeDiscordSettings(c.env, userId, settings);
  return c.json(settings);
}

export async function handleDiscordRelayToken(c: HydraContext): Promise<Response> {
  const userId = await requireAuthUserId(c);
  const settings = await readDiscordSettings(c.env, userId);
  if (!settings.enabled) {
    return c.json({ error: "Discord control is disabled." }, 400);
  }
  if (!settings.guildId || !settings.channelId) {
    return c.json({ error: "Discord control needs an allowed server and channel." }, 400);
  }

  const exp = Date.now() + RELAY_TOKEN_TTL_MS;
  const token = await signRelayToken(c.env, {
    exp,
    nonce: crypto.randomUUID(),
    userId,
  });
  const websocketUrl = new URL("/api/discord/desktop/connect", c.req.url);
  websocketUrl.protocol = websocketUrl.protocol === "http:" ? "ws:" : "wss:";

  return c.json({
    token,
    websocketUrl: websocketUrl.toString(),
    expiresAt: new Date(exp).toISOString(),
  });
}

export async function handleDiscordInstallInfo(c: HydraContext): Promise<Response> {
  const applicationId = c.env.DISCORD_APPLICATION_ID?.trim();
  if (!applicationId) {
    return c.json({ error: "DISCORD_APPLICATION_ID is required." }, 500);
  }

  assertOptionalDiscordId(applicationId, "Application ID");

  const installUrl = new URL("https://discord.com/oauth2/authorize");
  installUrl.searchParams.set("client_id", applicationId);
  installUrl.searchParams.set("scope", "applications.commands");

  return c.json({
    applicationId,
    installUrl: installUrl.toString(),
  });
}

export async function handleDiscordLinkCode(c: HydraContext): Promise<Response> {
  const userId = await requireAuthUserId(c);
  await deleteExpiredDiscordLinkCodes(c.env);
  await c.env.DATABASE.prepare("DELETE FROM discord_link_codes WHERE user_id = ?").bind(userId).run();

  const expiresAt = Date.now() + DISCORD_LINK_CODE_TTL_MS;
  const code = await createUniqueDiscordLinkCode(c.env);
  await c.env.DATABASE.prepare(
    `INSERT INTO discord_link_codes (code, user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?)`
  ).bind(code, userId, expiresAt, Date.now()).run();

  return c.json({
    code,
    expiresAt: new Date(expiresAt).toISOString(),
  });
}

export async function handleDiscordDesktopConnect(c: HydraContext): Promise<Response> {
  const upgrade = c.req.header("upgrade");
  if (upgrade?.toLowerCase() !== "websocket") {
    return new Response("Expected websocket upgrade.", { status: 426 });
  }

  const requestUrl = new URL(c.req.url);
  const token = requestUrl.searchParams.get("token") || "";
  const payload = await verifyRelayToken(c.env, token);
  if (!payload) {
    return new Response("Invalid relay token.", { status: 401 });
  }

  const settings = await readDiscordSettings(c.env, payload.userId);
  if (!settings.enabled) {
    return new Response("Discord control is disabled.", { status: 403 });
  }

  const id = c.env.DISCORD_RELAY.idFromName(payload.userId);
  const stub = c.env.DISCORD_RELAY.get(id);
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-hydra-user-id", payload.userId);
  return stub.fetch(new Request(new URL("/connect", c.req.url), {
    headers,
    method: "GET",
  }));
}

export async function handleDiscordInteraction(c: HydraContext): Promise<Response> {
  const body = await c.req.text();
  if (!(await verifyDiscordRequest(c, body))) {
    return c.json({ error: "Invalid Discord signature." }, 401);
  }

  const interaction = JSON.parse(body) as DiscordInteraction;
  if (interaction.type === 1) {
    return c.json({ type: 1 });
  }
  if (interaction.type !== 2 || interaction.data?.name !== HYDRA_COMMAND_NAME) {
    return c.json({ type: 4, data: { content: "Unknown Hydra interaction.", flags: DISCORD_EPHEMERAL_FLAG } });
  }

  if (!interaction.id || !interaction.token || !interaction.application_id) {
    return c.json({ error: "Invalid Discord interaction payload." }, 400);
  }

  const command = interactionToCommand(interaction);
  if (!command) {
    return c.json({
      type: 4,
      data: { content: "No Hydra subcommand was provided.", flags: DISCORD_EPHEMERAL_FLAG },
    });
  }

  if (command.name === "link") {
    const content = await redeemDiscordLinkCode(c.env, command);
    return c.json({ type: 4, data: { content, flags: DISCORD_EPHEMERAL_FLAG } });
  }

  const route = await findDiscordRoute(c.env, command);
  if (!route) {
    return c.json({
      type: 4,
      data: {
        content: "No signed-in Hydra desktop is configured for this server, channel, and user.",
        flags: DISCORD_EPHEMERAL_FLAG,
      },
    });
  }

  c.executionCtx.waitUntil(dispatchInteractionCommand(c.env, route.userId, interaction, command));
  return c.json({ type: 5, data: { flags: DISCORD_EPHEMERAL_FLAG } });
}

export async function handleDiscordCommandSync(c: HydraContext): Promise<Response> {
  const secret = c.env.DISCORD_COMMAND_SYNC_SECRET?.trim();
  if (!secret || c.req.header("x-hydra-admin-secret") !== secret) {
    return c.json({ error: "Unauthorized." }, 401);
  }

  const token = c.env.DISCORD_BOT_TOKEN?.trim();
  const applicationId = c.env.DISCORD_APPLICATION_ID?.trim();
  if (!token || !applicationId) {
    return c.json({ error: "DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID are required." }, 500);
  }

  const response = await fetch(
    `${DISCORD_API}/applications/${encodeURIComponent(applicationId)}/commands`,
    {
      body: JSON.stringify(commandDefinitions),
      headers: {
        authorization: `Bot ${token}`,
        "content-type": "application/json",
      },
      method: "PUT",
    }
  );
  const text = await response.text();
  if (!response.ok) {
    return c.json({ error: `Discord command sync failed: HTTP ${response.status}`, details: text }, 502);
  }

  return new Response(text, {
    headers: { "content-type": response.headers.get("content-type") || "application/json" },
    status: 200,
  });
}

export class DiscordRelayHub {
  private readonly state: DurableObjectState;
  private socket: CloudflareWebSocket | null = null;
  private pending = new Map<string, PendingRelayCommand>();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/connect") {
      return this.connectDesktop(request);
    }
    if (url.pathname === "/dispatch") {
      return this.dispatchCommand(request);
    }
    return new Response("Not found.", { status: 404 });
  }

  private connectDesktop(request: Request): Response {
    const userId = request.headers.get("x-hydra-user-id") || "";
    if (!userId) {
      return new Response("Missing user.", { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [CloudflareWebSocket, CloudflareWebSocket];
    server.accept();
    this.socket?.close(1000, "Replaced by a newer Hydra desktop connection.");
    this.socket = server;

    server.addEventListener("message", (event: MessageEvent) => {
      this.handleDesktopMessage(event.data);
    });
    server.addEventListener("close", () => {
      if (this.socket === server) {
        this.socket = null;
      }
      this.rejectPending("Hydra desktop disconnected.");
    });
    server.addEventListener("error", () => {
      if (this.socket === server) {
        this.socket = null;
      }
      this.rejectPending("Hydra desktop websocket failed.");
    });

    server.send(JSON.stringify({ type: "ping" }));
    void this.state.storage.put("lastConnectedAt", Date.now());
    return new Response(null, { status: 101, webSocket: client });
  }

  private async dispatchCommand(request: Request): Promise<Response> {
    if (!this.socket) {
      return Response.json({ ok: false, error: "Hydra desktop is not connected." }, { status: 409 });
    }

    const payload = await request.json().catch(() => null) as RelayDispatchRequest | null;
    if (!payload || typeof payload.requestId !== "string" || !isHydraCommandPayload(payload.command)) {
      return Response.json({ ok: false, error: "Invalid relay dispatch payload." }, { status: 400 });
    }

    const result = await new Promise<RelayCommandResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(payload.requestId);
        resolve({ ok: false, error: "Hydra desktop did not respond before the relay timeout." });
      }, RELAY_COMMAND_TIMEOUT_MS);
      this.pending.set(payload.requestId, { resolve, timeout });
      this.socket?.send(JSON.stringify({
        type: "hydra-command",
        requestId: payload.requestId,
        command: payload.command,
      }));
    });

    return Response.json(result, { status: result.ok ? 200 : 504 });
  }

  private handleDesktopMessage(data: unknown): void {
    if (typeof data !== "string") {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (!isDesktopSocketMessage(parsed)) {
      return;
    }

    if (parsed.type === "hydra-command-result") {
      const pending = this.pending.get(parsed.requestId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(parsed.requestId);
      pending.resolve(parsed.ok
        ? { ok: true, content: parsed.content }
        : { ok: false, error: parsed.error });
    }
  }

  private rejectPending(error: string): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.resolve({ ok: false, error });
      this.pending.delete(requestId);
    }
  }
}

async function requireAuthUserId(c: HydraContext): Promise<string> {
  const config = getAuthRuntimeConfig(c.env);
  const auth = createAuth(c.env, c.req.raw.cf as IncomingRequestCfProperties, config.baseURL);
  const url = new URL("/api/auth/get-session", c.req.url);
  url.searchParams.set("disableCookieCache", "true");
  const response = await auth.handler(new Request(url, {
    headers: c.req.raw.headers,
    method: "GET",
  }));

  if (!response.ok) {
    throw new Error("Sign in before configuring Discord control.");
  }

  const payload = await response.json().catch(() => null) as AuthSessionPayload | null;
  const userId = typeof payload?.user?.id === "string" ? payload.user.id : "";
  if (!userId) {
    throw new Error("Sign in before configuring Discord control.");
  }
  return userId;
}

function normalizeSettingsPatch(
  current: DiscordControlSettings,
  patch: Partial<DiscordControlSettings>
): DiscordControlSettings {
  const guildId = typeof patch.guildId === "string" ? patch.guildId.trim() : current.guildId;
  const channelId = typeof patch.channelId === "string" ? patch.channelId.trim() : current.channelId;
  const allowedUserIds = Array.isArray(patch.allowedUserIds)
    ? patch.allowedUserIds.map((value) => String(value).trim()).filter(Boolean)
    : current.allowedUserIds;

  assertOptionalDiscordId(guildId, "Server ID");
  assertOptionalDiscordId(channelId, "Channel ID");
  for (const userId of allowedUserIds) {
    assertOptionalDiscordId(userId, "User ID");
  }

  return {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    guildId,
    channelId,
    allowedUserIds: [...new Set(allowedUserIds)],
  };
}

async function readDiscordSettings(
  env: CloudflareBindings,
  userId: string
): Promise<DiscordControlSettings> {
  const row = await env.DATABASE.prepare(
    `SELECT enabled, guild_id, channel_id, allowed_user_ids
       FROM discord_control_settings
      WHERE user_id = ?`
  ).bind(userId).first<DiscordSettingsRow>();

  return rowToSettings(row);
}

async function writeDiscordSettings(
  env: CloudflareBindings,
  userId: string,
  settings: DiscordControlSettings
): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT INTO discord_control_settings (
       user_id, enabled, guild_id, channel_id, allowed_user_ids, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       enabled = excluded.enabled,
       guild_id = excluded.guild_id,
       channel_id = excluded.channel_id,
       allowed_user_ids = excluded.allowed_user_ids,
       updated_at = excluded.updated_at`
  ).bind(
    userId,
    settings.enabled ? 1 : 0,
    settings.guildId,
    settings.channelId,
    JSON.stringify(settings.allowedUserIds),
    Date.now()
  ).run();
}

async function deleteExpiredDiscordLinkCodes(env: CloudflareBindings): Promise<void> {
  await env.DATABASE.prepare("DELETE FROM discord_link_codes WHERE expires_at <= ?")
    .bind(Date.now())
    .run();
}

async function createUniqueDiscordLinkCode(env: CloudflareBindings): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateDiscordLinkCode();
    const existing = await env.DATABASE.prepare(
      "SELECT code FROM discord_link_codes WHERE code = ?"
    ).bind(code).first<{ code: string }>();
    if (!existing) {
      return code;
    }
  }

  throw new Error("Unable to create a unique Discord link code.");
}

function generateDiscordLinkCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) {
    code += DISCORD_LINK_CODE_ALPHABET[byte % DISCORD_LINK_CODE_ALPHABET.length];
  }
  return code;
}

function rowToSettings(row: DiscordSettingsRow | null): DiscordControlSettings {
  if (!row) {
    return {
      enabled: false,
      guildId: "",
      channelId: "",
      allowedUserIds: [],
    };
  }

  return {
    enabled: row.enabled === 1,
    guildId: row.guild_id || "",
    channelId: row.channel_id || "",
    allowedUserIds: parseAllowedUsers(row.allowed_user_ids),
  };
}

function parseAllowedUsers(value: string): string[] {
  const parsed = JSON.parse(value || "[]") as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

async function findDiscordRoute(
  env: CloudflareBindings,
  command: DiscordHydraCommandPayload
): Promise<{ userId: string } | null> {
  const rows = await env.DATABASE.prepare(
    `SELECT user_id, allowed_user_ids
       FROM discord_control_settings
      WHERE enabled = 1 AND guild_id = ? AND channel_id = ?
      ORDER BY updated_at DESC`
  ).bind(command.guildId, command.channelId).all<{ user_id: string; allowed_user_ids: string }>();

  const candidates = rows.results || [];
  const exact = candidates.find((row) => parseAllowedUsers(row.allowed_user_ids).includes(command.userId));
  if (exact) {
    return { userId: exact.user_id };
  }

  const open = candidates.find((row) => parseAllowedUsers(row.allowed_user_ids).length === 0);
  return open ? { userId: open.user_id } : null;
}

async function redeemDiscordLinkCode(
  env: CloudflareBindings,
  command: DiscordHydraCommandPayload
): Promise<string> {
  const code = normalizeDiscordLinkCode(command.options.code);
  if (!code) {
    return "Enter the 8-character link code from Hydra settings.";
  }

  await deleteExpiredDiscordLinkCodes(env);
  const row = await env.DATABASE.prepare(
    `SELECT user_id, expires_at
       FROM discord_link_codes
      WHERE code = ?`
  ).bind(code).first<DiscordLinkCodeRow>();

  if (!row || row.expires_at <= Date.now()) {
    return "That Hydra link code is invalid or expired. Generate a new code in Hydra settings.";
  }

  await env.DATABASE.prepare("DELETE FROM discord_link_codes WHERE code = ?").bind(code).run();
  await writeDiscordSettings(env, row.user_id, {
    enabled: true,
    guildId: command.guildId,
    channelId: command.channelId,
    allowedUserIds: [command.userId],
  });

  return "Hydra Discord control is linked to this channel and Discord user. Open Hydra settings and connect the relay.";
}

async function dispatchInteractionCommand(
  env: CloudflareBindings,
  userId: string,
  interaction: DiscordInteraction,
  command: DiscordHydraCommandPayload
): Promise<void> {
  const requestId = crypto.randomUUID();
  const id = env.DISCORD_RELAY.idFromName(userId);
  const stub = env.DISCORD_RELAY.get(id);
  const response = await stub.fetch("https://discord-relay.local/dispatch", {
    body: JSON.stringify({ requestId, command } satisfies RelayDispatchRequest),
    method: "POST",
  });
  const result = await response.json().catch(() => null) as RelayCommandResult | null;
  const content = result?.ok
    ? result.content || "Hydra command completed."
    : `Hydra command failed: ${result?.error || "Unknown relay error."}`;
  await editInteractionResponse(env, interaction, content);
}

async function editInteractionResponse(
  env: CloudflareBindings,
  interaction: DiscordInteraction,
  content: string
): Promise<void> {
  const applicationId = interaction.application_id || env.DISCORD_APPLICATION_ID || "";
  const token = interaction.token || "";
  if (!applicationId || !token) {
    return;
  }

  await fetch(
    `${DISCORD_API}/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(token)}/messages/@original`,
    {
      body: JSON.stringify({ content: limitDiscord(content) }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    }
  );
}

function interactionToCommand(interaction: DiscordInteraction): DiscordHydraCommandPayload | null {
  const subcommand = interaction.data?.options?.find((option) => option.type === 1);
  const name = subcommand?.name;
  const guildId = interaction.guild_id || "";
  const channelId = interaction.channel_id || "";
  const userId = interaction.member?.user?.id || interaction.user?.id || "";
  if (!subcommand || !isHydraCommandName(name) || !guildId || !channelId || !userId) {
    return null;
  }

  return {
    name,
    options: optionsByName(subcommand.options || []),
    guildId,
    channelId,
    userId,
  };
}

function optionsByName(options: DiscordInteractionOption[]): Record<string, string | number | boolean | null> {
  const mapped: Record<string, string | number | boolean | null> = {};
  for (const option of options) {
    mapped[option.name] = option.value ?? null;
  }
  return mapped;
}

function normalizeDiscordLinkCode(value: string | number | boolean | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const code = value.trim().toUpperCase();
  return DISCORD_LINK_CODE_PATTERN.test(code) ? code : null;
}

async function signRelayToken(env: CloudflareBindings, payload: RelayTokenPayload): Promise<string> {
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSha256(env, body);
  return `${body}.${signature}`;
}

async function verifyRelayToken(
  env: CloudflareBindings,
  token: string
): Promise<RelayTokenPayload | null> {
  const [body, signature] = token.split(".");
  if (!body || !signature) {
    return null;
  }

  const expected = await hmacSha256(env, body);
  if (signature !== expected) {
    return null;
  }

  const parsed = JSON.parse(base64UrlDecode(body)) as RelayTokenPayload;
  if (
    typeof parsed.userId !== "string" ||
    typeof parsed.exp !== "number" ||
    parsed.exp < Date.now()
  ) {
    return null;
  }
  return parsed;
}

async function hmacSha256(env: CloudflareBindings, body: string): Promise<string> {
  const secret = getAuthRuntimeConfig(env).secret;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

async function verifyDiscordRequest(c: HydraContext, body: string): Promise<boolean> {
  const publicKey = c.env.DISCORD_PUBLIC_KEY?.trim();
  if (!publicKey) {
    console.error("[discord] DISCORD_PUBLIC_KEY is required to verify interactions.");
    return false;
  }

  const signature = c.req.header("x-signature-ed25519") || "";
  const timestamp = c.req.header("x-signature-timestamp") || "";
  if (!signature || !timestamp) {
    return false;
  }

  const timestampMs = Number.parseInt(timestamp, 10) * 1000;
  if (
    !Number.isFinite(timestampMs) ||
    Math.abs(Date.now() - timestampMs) > DISCORD_SIGNATURE_TOLERANCE_MS
  ) {
    return false;
  }

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKey),
      "Ed25519",
      false,
      ["verify"]
    );
    return crypto.subtle.verify(
      "Ed25519",
      key,
      hexToBytes(signature),
      new TextEncoder().encode(`${timestamp}${body}`)
    );
  } catch {
    return false;
  }
}

function isDesktopSocketMessage(value: unknown): value is DesktopSocketMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const message = value as {
    type?: unknown;
    protocolVersion?: unknown;
    requestId?: unknown;
    ok?: unknown;
    content?: unknown;
    error?: unknown;
  };
  if (message.type === "hello") {
    return message.protocolVersion === RELAY_PROTOCOL_VERSION;
  }
  if (message.type === "pong") {
    return true;
  }
  return (
    message.type === "hydra-command-result" &&
    typeof message.requestId === "string" &&
    typeof message.ok === "boolean" &&
    (message.ok ? typeof message.content === "string" : typeof message.error === "string")
  );
}

function isHydraCommandPayload(value: unknown): value is DiscordHydraCommandPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value as Partial<DiscordHydraCommandPayload>;
  return (
    isHydraCommandName(payload.name) &&
    !!payload.options &&
    typeof payload.options === "object" &&
    typeof payload.guildId === "string" &&
    typeof payload.channelId === "string" &&
    typeof payload.userId === "string"
  );
}

function isHydraCommandName(value: unknown): value is DiscordHydraCommandName {
  return (
    value === "status" ||
    value === "inbox" ||
    value === "sessions" ||
    value === "tail" ||
    value === "prompt" ||
    value === "focused-prompt" ||
    value === "approve" ||
    value === "deny" ||
    value === "focus" ||
    value === "new" ||
    value === "link"
  );
}

function assertOptionalDiscordId(value: string, label: string): void {
  if (value && !DISCORD_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a Discord numeric ID.`);
  }
}

function base64UrlEncode(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "="
  );
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
}

function hexToBytes(value: string): Uint8Array {
  const matches = value.match(/.{1,2}/gu) || [];
  return Uint8Array.from(matches.map((byte) => Number.parseInt(byte, 16)));
}

function limitDiscord(content: string): string {
  if (content.length <= DISCORD_MESSAGE_LIMIT) {
    return content;
  }
  return `${content.slice(0, DISCORD_MESSAGE_LIMIT - 20)}\n...[truncated]`;
}
