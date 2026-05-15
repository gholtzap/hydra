import type {
  DiscordControlSettings,
  DiscordControlSettingsPatch,
  DiscordHydraCommandPayload,
  DiscordInstallInfo,
  DiscordLinkCode,
  DiscordRelayStatus,
  SessionRecord,
  SessionStatus
} from "../shared-types";
import type { HydraAuthClient } from "./auth-client";
import type { AppControllerHandle } from "./internal-api";

const RELAY_PROTOCOL_VERSION = 1;
const DISCORD_MESSAGE_LIMIT = 2000;
const RECONNECT_DELAY_MS = 5000;
const SESSION_TAIL_DEFAULT_LINES = 30;
const SESSION_TAIL_MAX_LINES = 80;
const SESSION_TAIL_MAX_CHARS = 1500;
const AGENT_APPROVE_MAP: Record<string, string> = {
  claude: "1\r",
  codex: "\r",
};
const AGENT_DENY_MAP: Record<string, string> = {
  claude: "3\r",
  codex: "\x1b[B\r",
};

type RelayServerMessage =
  | {
      type: "hydra-command";
      requestId: string;
      command: DiscordHydraCommandPayload;
    }
  | {
      type: "ping";
    };

type RelayClientMessage =
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

type StatusListener = (status: DiscordRelayStatus) => void;

export class DiscordRelayClient {
  private readonly appController: AppControllerHandle;
  private readonly getAuthClient: () => HydraAuthClient | null;
  private readonly onStatusChanged: StatusListener;
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private manualDisconnect = false;
  private status: DiscordRelayStatus = {
    state: "disconnected",
    connected: false,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastError: null,
  };

  constructor(
    appController: AppControllerHandle,
    getAuthClient: () => HydraAuthClient | null,
    onStatusChanged: StatusListener
  ) {
    this.appController = appController;
    this.getAuthClient = getAuthClient;
    this.onStatusChanged = onStatusChanged;
  }

  getStatus(): DiscordRelayStatus {
    return { ...this.status };
  }

  async getSettings(): Promise<DiscordControlSettings> {
    const authClient = this.requireAuthClient();
    return authClient.getDiscordControlSettings();
  }

  async updateSettings(patch: DiscordControlSettingsPatch): Promise<DiscordControlSettings> {
    const authClient = this.requireAuthClient();
    const settings = await authClient.updateDiscordControlSettings(patch);
    if (!settings.enabled) {
      this.disconnect();
    }
    return settings;
  }

  async getInstallInfo(): Promise<DiscordInstallInfo> {
    const authClient = this.requireAuthClient();
    return authClient.getDiscordInstallInfo();
  }

  async createLinkCode(): Promise<DiscordLinkCode> {
    const authClient = this.requireAuthClient();
    return authClient.createDiscordLinkCode();
  }

  async connect(): Promise<DiscordRelayStatus> {
    this.manualDisconnect = false;
    this.clearReconnectTimer();
    this.setStatus({ state: "connecting", connected: false, lastError: null });

    try {
      const authClient = this.requireAuthClient();
      const settings = await authClient.getDiscordControlSettings();
      if (!settings.enabled) {
        throw new Error("Enable Discord control before connecting.");
      }
      if (!settings.guildId || !settings.channelId) {
        throw new Error("Choose an allowed Discord server and channel before connecting.");
      }

      const tokenResponse = await authClient.requestDiscordRelayToken();
      const url = new URL(tokenResponse.websocketUrl);
      if (url.protocol !== "wss:" && url.protocol !== "ws:") {
        throw new Error("Discord relay returned an invalid websocket URL.");
      }
      url.searchParams.set("token", tokenResponse.token);

      this.openSocket(url.toString());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unable to connect Discord relay.";
      this.setStatus({
        state: "error",
        connected: false,
        lastDisconnectedAt: new Date().toISOString(),
        lastError: message,
      });
    }

    return this.getStatus();
  }

  disconnect(): DiscordRelayStatus {
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    if (this.socket) {
      this.socket.close(1000, "Discord relay disabled");
      this.socket = null;
    }
    this.setStatus({
      state: "disconnected",
      connected: false,
      lastDisconnectedAt: new Date().toISOString(),
    });
    return this.getStatus();
  }

  destroy(): void {
    this.disconnect();
  }

  private openSocket(url: string): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.setStatus({
        state: "connected",
        connected: true,
        lastConnectedAt: new Date().toISOString(),
        lastError: null,
      });
      this.send({ type: "hello", protocolVersion: RELAY_PROTOCOL_VERSION });
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      void this.handleSocketMessage(event.data);
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.setStatus({
        state: this.manualDisconnect ? "disconnected" : "error",
        connected: false,
        lastDisconnectedAt: new Date().toISOString(),
        lastError: this.manualDisconnect ? this.status.lastError : "Discord relay connection closed.",
      });
      if (!this.manualDisconnect) {
        this.scheduleReconnect();
      }
    });

    socket.addEventListener("error", () => {
      this.setStatus({
        state: "error",
        connected: false,
        lastError: "Discord relay websocket error.",
      });
    });
  }

  private async handleSocketMessage(data: unknown): Promise<void> {
    const message = parseServerMessage(data);
    if (!message) {
      return;
    }

    if (message.type === "ping") {
      this.send({ type: "pong" });
      return;
    }

    try {
      const content = await this.runHydraCommand(message.command);
      this.send({
        type: "hydra-command-result",
        requestId: message.requestId,
        ok: true,
        content: limitDiscord(content),
      });
    } catch (error: unknown) {
      this.send({
        type: "hydra-command-result",
        requestId: message.requestId,
        ok: false,
        error: error instanceof Error ? error.message : "Hydra command failed.",
      });
    }
  }

  private async runHydraCommand(command: DiscordHydraCommandPayload): Promise<string> {
    const options = command.options;
    switch (command.name) {
      case "status":
        return formatStatus(this.appController.snapshot());
      case "inbox":
        return formatInbox(this.appController.snapshot());
      case "sessions":
        return formatSessions(this.appController.snapshot(), {
          status: stringOption(options.status) as SessionStatus | undefined,
          limit: numberOption(options.limit, 10, 1, 20),
        });
      case "tail":
        return formatTail(this.sessionTail(requiredStringOption(options.session, "session")));
      case "prompt":
        this.sendPromptToSession(
          requiredStringOption(options.session, "session"),
          requiredStringOption(options.text, "text")
        );
        return `Sent prompt to session \`${requiredStringOption(options.session, "session")}\`.`;
      case "focused-prompt":
        this.sendPromptToFocusedSession(requiredStringOption(options.text, "text"));
        return "Sent prompt to the focused session.";
      case "approve":
        return this.approveOrDeny(options.session, true);
      case "deny":
        return this.approveOrDeny(options.session, false);
      case "focus": {
        const sessionId = requiredStringOption(options.session, "session");
        this.appController.setFocusedSession(sessionId);
        this.appController.broadcastState();
        return `Focused session \`${sessionId}\`.`;
      }
      case "new": {
        const sessionId = await this.appController.handleMcpAction("create_session", {
          repoId: requiredStringOption(options.repo, "repo"),
          agentId: stringOption(options.agent),
          prompt: requiredStringOption(options.prompt, "prompt"),
        });
        return sessionId ? `Created session \`${sessionId}\`.` : "Hydra did not create a session.";
      }
    }
  }

  private sendPromptToSession(sessionId: string, text: string): void {
    if (!this.appController.sessionById(sessionId)) {
      throw new Error("Session not found.");
    }
    this.appController.handleSessionInput(sessionId, `${text}\r`);
  }

  private sendPromptToFocusedSession(text: string): void {
    const sessionId = this.appController.focusedSessionId;
    if (!sessionId) {
      throw new Error("No focused session.");
    }
    this.sendPromptToSession(sessionId, text);
  }

  private approveOrDeny(sessionOption: unknown, approve: boolean): string {
    const sessionId = stringOption(sessionOption) || this.appController.focusedSessionId;
    if (!sessionId) {
      throw new Error("No focused session.");
    }

    const session = this.appController.sessionById(sessionId);
    if (!session) {
      throw new Error("Session not found.");
    }

    const agentId = session.startupAgentId || "claude";
    const input = approve
      ? AGENT_APPROVE_MAP[agentId] ?? "y\r"
      : AGENT_DENY_MAP[agentId] ?? "n\r";
    this.appController.handleSessionInput(sessionId, input);
    return `${approve ? "Approved" : "Denied"} blocker in session \`${sessionId}\`.`;
  }

  private sessionTail(sessionId: string): {
    sessionId: string;
    title: string;
    status: SessionStatus;
    runtimeState: SessionRecord["runtimeState"];
    transcript: { text: string };
  } {
    const session = this.appController.sessionById(sessionId);
    if (!session) {
      throw new Error("Session not found.");
    }

    return {
      sessionId,
      title: session.title,
      status: session.status,
      runtimeState: session.runtimeState,
      transcript: {
        text: transcriptTail(session.transcript, SESSION_TAIL_DEFAULT_LINES, SESSION_TAIL_MAX_CHARS),
      },
    };
  }

  private send(message: RelayClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(patch: Partial<DiscordRelayStatus>): void {
    this.status = {
      ...this.status,
      ...patch,
    };
    this.onStatusChanged(this.getStatus());
  }

  private requireAuthClient(): HydraAuthClient {
    const authClient = this.getAuthClient();
    if (!authClient) {
      throw new Error("Sign in to Hydra before using Discord control.");
    }
    return authClient;
  }
}

function parseServerMessage(data: unknown): RelayServerMessage | null {
  const text = typeof data === "string" ? data : null;
  if (!text) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const message = parsed as Partial<RelayServerMessage>;
  if (message.type === "ping") {
    return { type: "ping" };
  }
  if (
    message.type === "hydra-command" &&
    typeof message.requestId === "string" &&
    isDiscordHydraCommandPayload(message.command)
  ) {
    return {
      type: "hydra-command",
      requestId: message.requestId,
      command: message.command,
    };
  }

  return null;
}

function isDiscordHydraCommandPayload(value: unknown): value is DiscordHydraCommandPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as Partial<DiscordHydraCommandPayload>;
  return (
    isCommandName(payload.name) &&
    !!payload.options &&
    typeof payload.options === "object" &&
    typeof payload.guildId === "string" &&
    typeof payload.channelId === "string" &&
    typeof payload.userId === "string"
  );
}

function isCommandName(value: unknown): value is DiscordHydraCommandPayload["name"] {
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
    value === "new"
  );
}

function requiredStringOption(value: unknown, name: string): string {
  const text = stringOption(value);
  if (!text) {
    throw new Error(`Missing Discord command option: ${name}.`);
  }
  return text;
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberOption(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function formatStatus(snapshot: ReturnType<AppControllerHandle["snapshot"]>): string {
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

function formatInbox(snapshot: ReturnType<AppControllerHandle["snapshot"]>): string {
  const sessions = (snapshot.sessions || [])
    .filter((session) => session.blocker || session.unreadCount > 0)
    .sort(compareSessionActivity)
    .slice(0, 10);

  if (sessions.length === 0) {
    return "No blocked or unread sessions.";
  }

  const repoNames = repoNamesById(snapshot);
  return [
    "**Hydra inbox**",
    ...sessions.map((session) => formatSessionLine(session, repoNames)),
  ].join("\n");
}

function formatSessions(
  snapshot: ReturnType<AppControllerHandle["snapshot"]>,
  options: { status?: SessionStatus; limit: number }
): string {
  let sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  if (options.status) {
    sessions = sessions.filter((session) => session.status === options.status);
  }
  sessions = [...sessions].sort(compareSessionActivity).slice(0, options.limit);

  if (sessions.length === 0) {
    return "No matching Hydra sessions.";
  }

  const repoNames = repoNamesById(snapshot);
  return [
    `**Hydra sessions** (${sessions.length})`,
    ...sessions.map((session) => formatSessionLine(session, repoNames)),
  ].join("\n");
}

function formatTail(result: {
  sessionId: string;
  title: string;
  status: SessionStatus;
  runtimeState: SessionRecord["runtimeState"];
  transcript: { text: string };
}): string {
  const text = result.transcript.text || "";
  if (!text.trim()) {
    return `No transcript output for session \`${result.sessionId}\`.`;
  }
  return [
    `**${result.title || result.sessionId}** ${result.status}/${result.runtimeState}`,
    codeBlock(text, "text"),
  ].join("\n");
}

function repoNamesById(snapshot: ReturnType<AppControllerHandle["snapshot"]>): Map<string, string> {
  return new Map((snapshot.repos || []).map((repo) => [repo.id, repo.name]));
}

function formatSessionLine(
  session: ReturnType<AppControllerHandle["snapshot"]>["sessions"][number],
  repoNames: Map<string, string>
): string {
  const repo = repoNames.get(session.repoID) || session.repoID;
  const unread = session.unreadCount ? ` unread:${session.unreadCount}` : "";
  const blocker = session.blocker ? ` blocker:${session.blocker.kind}` : "";
  return `\`${session.id}\` ${session.status}/${session.runtimeState}${unread}${blocker} - ${repo} - ${session.title}`;
}

function countBy<T extends Record<string, unknown>>(items: T[], key: keyof T): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = String(item[key] || "unknown");
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}

function formatCounts(counts: Map<string, number>): string {
  return [...counts.entries()].map(([key, value]) => `${key}:${value}`).join(", ");
}

function compareSessionActivity(
  left: ReturnType<AppControllerHandle["snapshot"]>["sessions"][number],
  right: ReturnType<AppControllerHandle["snapshot"]>["sessions"][number]
): number {
  const leftTime = left.lastActivityAt || left.updatedAt || "";
  const rightTime = right.lastActivityAt || right.updatedAt || "";
  return rightTime.localeCompare(leftTime);
}

function transcriptTail(text: string, lines: number, maxChars: number): string {
  const safeLines = Math.max(1, Math.min(SESSION_TAIL_MAX_LINES, Math.trunc(lines)));
  const lineTail = String(text || "").split(/\r?\n/u).slice(-safeLines).join("\n");
  return lineTail.length > maxChars ? lineTail.slice(-maxChars) : lineTail;
}

function codeBlock(value: string, language: string): string {
  return `\`\`\`${language}\n${String(value).replaceAll("```", "`\u200b``")}\n\`\`\``;
}

function limitDiscord(content: string): string {
  if (content.length <= DISCORD_MESSAGE_LIMIT) {
    return content;
  }
  return `${content.slice(0, DISCORD_MESSAGE_LIMIT - 20)}\n...[truncated]`;
}
