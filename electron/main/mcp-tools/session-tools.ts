/**
 * MCP tools for session management.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { SessionRecord, SessionStatus } from "../../shared-types";
import type { AppControllerHandle } from "../internal-api";
import type { McpActionArgs } from "../mcp-contracts";

const AGENT_APPROVE_MAP: Record<string, string> = {
  claude: "1\r",
  codex: "\r",
};

const AGENT_DENY_MAP: Record<string, string> = {
  claude: "3\r",
  codex: "\x1b[B\r",
};

function defaultApprove(): string {
  return "y\r";
}
function defaultDeny(): string {
  return "n\r";
}

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

type SessionListItem = Omit<SessionRecord, "transcript" | "rawTranscript" | "sessionIconPath">;
type SessionDetailsResult = Omit<SessionRecord, "sessionIconPath" | "rawTranscript"> & {
  rawTranscript?: string;
};

type SessionTailArgs = {
  sessionId: string;
  lines?: number;
  maxChars?: number;
  includeRawTranscript?: boolean;
};

type SessionTailText = {
  text: string;
  totalChars: number;
  totalLines: number;
  returnedChars: number;
  returnedLines: number;
  truncated: boolean;
};

type SessionTextArgs = {
  sessionId: string;
  text: string;
};

type SessionCommandArgs = McpActionArgs<"send_command">;
type CreateShellSessionArgs = McpActionArgs<"create_shell_session">;

type FocusSessionArgs = {
  sessionId?: string | null;
};

const SESSION_STATUS_VALUES = [
  "running",
  "blocked",
  "needs_input",
  "failed",
  "done",
  "idle"
] as const satisfies readonly SessionStatus[];

const SESSION_TAG_COLOR_VALUES = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "gray"
] as const;

const SESSION_SEARCH_SOURCE_VALUES = [
  "claude",
  "codex"
] as const;

const SESSION_TERMINAL_KEY_VALUES = [
  "enter",
  "escape",
  "tab",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "page-up",
  "page-down",
  "ctrl-c",
  "ctrl-d",
  "ctrl-l"
] as const;

type SessionTerminalKey = (typeof SESSION_TERMINAL_KEY_VALUES)[number];

const SESSION_TERMINAL_KEY_INPUTS: Record<SessionTerminalKey, string> = {
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  backspace: "\x7f",
  delete: "\x1b[3~",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  home: "\x1b[H",
  end: "\x1b[F",
  "page-up": "\x1b[5~",
  "page-down": "\x1b[6~",
  "ctrl-c": "\x03",
  "ctrl-d": "\x04",
  "ctrl-l": "\x0c",
};

const SESSION_WAIT_CONDITION_VALUES = [
  "activity",
  "unread",
  "blocked",
  "needs_input",
  "running",
  "idle",
  "done",
  "failed",
  "stopped",
  "quiet"
] as const;

type SessionWaitCondition = (typeof SESSION_WAIT_CONDITION_VALUES)[number];

type SessionWaitArgs = {
  sessionId: string;
  condition: SessionWaitCondition;
  timeoutMs?: number;
  pollIntervalMs?: number;
  afterActivityAt?: string;
  quietMs?: number;
};

type SessionWaitSnapshot = {
  sessionId: string;
  condition: SessionWaitCondition;
  status: SessionStatus;
  runtimeState: SessionRecord["runtimeState"];
  unreadCount: number;
  blocker: SessionRecord["blocker"];
  lastActivityAt: string | null;
  quietForMs: number;
  updatedAt: string;
};

type SessionWaitSuccess = SessionWaitSnapshot & {
  ok: true;
  timedOut: false;
  elapsedMs: number;
  afterActivityAt: string;
  quietMs?: number;
};

type SessionWaitFailure = {
  ok: false;
  timedOut: boolean;
  elapsedMs?: number;
  afterActivityAt: string;
  quietMs?: number;
  sessionId: string;
  condition: SessionWaitCondition;
  error?: string;
  lastSnapshot?: SessionWaitSnapshot | null;
};

type SessionWaitResult = SessionWaitSuccess | SessionWaitFailure;

type RunSessionCommandArgs = SessionCommandArgs & {
  timeoutMs?: number;
  pollIntervalMs?: number;
  quietMs?: number;
  stopOnQuiet?: boolean;
  lines?: number;
  maxChars?: number;
  includeRawTranscript?: boolean;
};

type RunRepoCommandArgs = Omit<RunSessionCommandArgs, "sessionId"> & {
  repoId: string;
  title?: string;
};

const DEFAULT_SESSION_WAIT_TIMEOUT_MS = 30_000;
const MAX_SESSION_WAIT_TIMEOUT_MS = 300_000;
const DEFAULT_SESSION_WAIT_POLL_INTERVAL_MS = 500;
const MIN_SESSION_WAIT_POLL_INTERVAL_MS = 100;
const MAX_SESSION_WAIT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_SESSION_QUIET_MS = 1_000;
const MIN_SESSION_QUIET_MS = 250;
const MAX_SESSION_QUIET_MS = 30_000;
const DEFAULT_SESSION_TAIL_LINES = 80;
const MAX_SESSION_TAIL_LINES = 500;
const DEFAULT_SESSION_TAIL_CHARS = 12_000;
const MAX_SESSION_TAIL_CHARS = 50_000;
const MAX_SESSION_TEXT_CHARS = 20_000;
const MAX_SESSION_PROMPT_CHARS = 20_000;
const MAX_SESSION_TITLE_CHARS = 120;
const MAX_TERMINAL_COLS = 500;
const MAX_TERMINAL_ROWS = 200;
const TERMINAL_TEXT_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

function delayMs(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function sessionActivityTimestamp(session: SessionRecord): string {
  return session.lastActivityAt || session.updatedAt;
}

function sessionQuietDurationMs(session: SessionRecord, nowMs: number): number {
  const activityMs = Date.parse(sessionActivityTimestamp(session));
  if (!Number.isFinite(activityMs)) {
    return 0;
  }
  return Math.max(0, nowMs - activityMs);
}

function sessionSnapshot(
  session: SessionRecord,
  condition: SessionWaitCondition,
  nowMs: number
): SessionWaitSnapshot {
  return {
    sessionId: session.id,
    condition,
    status: session.status,
    runtimeState: session.runtimeState,
    unreadCount: session.unreadCount,
    blocker: session.blocker,
    lastActivityAt: session.lastActivityAt,
    quietForMs: sessionQuietDurationMs(session, nowMs),
    updatedAt: session.updatedAt,
  };
}

function sessionMatchesWaitCondition(
  session: SessionRecord,
  condition: SessionWaitCondition,
  afterActivityAt: string,
  quietMs: number,
  nowMs: number
): boolean {
  switch (condition) {
    case "activity":
      return sessionActivityTimestamp(session) > afterActivityAt;
    case "quiet":
      return (!afterActivityAt || sessionActivityTimestamp(session) > afterActivityAt) &&
        sessionQuietDurationMs(session, nowMs) >= quietMs;
    case "unread":
      return session.unreadCount > 0;
    case "blocked":
      return session.status === "blocked" || session.blocker !== null;
    case "stopped":
      return session.runtimeState === "stopped";
    default:
      return session.status === condition;
  }
}

async function waitForSessionState(
  appController: AppControllerHandle,
  args: SessionWaitArgs
): Promise<SessionWaitResult> {
  const timeoutMs = boundedInteger(
    args.timeoutMs,
    DEFAULT_SESSION_WAIT_TIMEOUT_MS,
    MIN_SESSION_WAIT_POLL_INTERVAL_MS,
    MAX_SESSION_WAIT_TIMEOUT_MS
  );
  const pollIntervalMs = boundedInteger(
    args.pollIntervalMs,
    DEFAULT_SESSION_WAIT_POLL_INTERVAL_MS,
    MIN_SESSION_WAIT_POLL_INTERVAL_MS,
    MAX_SESSION_WAIT_POLL_INTERVAL_MS
  );
  const quietMs = boundedInteger(
    args.quietMs,
    DEFAULT_SESSION_QUIET_MS,
    MIN_SESSION_QUIET_MS,
    MAX_SESSION_QUIET_MS
  );
  const startedAt = new Date();
  const afterActivityAt = args.afterActivityAt || (args.condition === "quiet" ? "" : startedAt.toISOString());
  const deadline = startedAt.getTime() + timeoutMs;
  let lastSnapshot: SessionWaitSnapshot | null = null;

  while (Date.now() <= deadline) {
    const nowMs = Date.now();
    const session = appController.state.sessions.find((candidate) => candidate.id === args.sessionId);
    if (!session) {
      return {
        ok: false,
        timedOut: false,
        afterActivityAt,
        sessionId: args.sessionId,
        condition: args.condition,
        error: "Session not found",
      };
    }

    lastSnapshot = sessionSnapshot(session, args.condition, nowMs);
    if (sessionMatchesWaitCondition(session, args.condition, afterActivityAt, quietMs, nowMs)) {
      return {
        ok: true,
        timedOut: false,
        elapsedMs: nowMs - startedAt.getTime(),
        afterActivityAt,
        quietMs: args.condition === "quiet" ? quietMs : undefined,
        ...lastSnapshot,
      };
    }

    await delayMs(Math.min(pollIntervalMs, Math.max(deadline - Date.now(), 0)));
  }

  return {
    ok: false,
    timedOut: true,
    elapsedMs: Date.now() - startedAt.getTime(),
    afterActivityAt,
    quietMs: args.condition === "quiet" ? quietMs : undefined,
    sessionId: args.sessionId,
    condition: args.condition,
    lastSnapshot,
  };
}

function transcriptTail(text: string, lineLimit: number, charLimit: number): SessionTailText {
  const totalChars = text.length;
  const lines = text.length > 0 ? text.split("\n") : [];
  const totalLines = lines.length;
  const lineTail = lines.slice(-lineLimit).join("\n");
  const charTail = lineTail.length > charLimit ? lineTail.slice(-charLimit) : lineTail;
  const returnedLines = charTail.length > 0 ? charTail.split("\n").length : 0;

  return {
    text: charTail,
    totalChars,
    totalLines,
    returnedChars: charTail.length,
    returnedLines,
    truncated: totalLines > lineLimit || lineTail.length > charLimit,
  };
}

function containsTerminalControlCharacter(text: string): boolean {
  return TERMINAL_TEXT_CONTROL_CHARACTER_PATTERN.test(text);
}

export function register(server: McpServer, appController: AppControllerHandle): void {
  // ── get_app_state ───────────────────────────────────────────────
  server.tool(
    "get_app_state",
    "Get full app state snapshot (workspaces, repos, sessions, preferences)",
    {},
    async () => {
      return textResult(appController.snapshot());
    }
  );

  // ── list_sessions ──────────────────────────────────────────────
  server.tool(
    "list_sessions",
    "List sessions, optionally filtered by repo or status",
    {
      repoId: z.string().optional().describe("Filter by repo ID"),
      status: z.enum(SESSION_STATUS_VALUES).optional().describe("Filter by status (running|blocked|needs_input|failed|done|idle)"),
      limit: z.number().optional().describe("Max results to return"),
    },
    async (args: { repoId?: string; status?: SessionStatus; limit?: number }) => {
      let sessions = [...appController.state.sessions];
      if (args.repoId) sessions = sessions.filter((session) => session.repoID === args.repoId);
      if (args.status) sessions = sessions.filter((session) => session.status === args.status);
      if (args.limit) sessions = sessions.slice(0, args.limit);
      const summaries: SessionListItem[] = sessions.map((session) => {
        const { transcript, rawTranscript, sessionIconPath, ...rest } = session;
        return rest;
      });
      return textResult(summaries);
    }
  );

  // ── get_session ────────────────────────────────────────────────
  server.tool(
    "get_session",
    "Get session details including transcript",
    {
      sessionId: z.string().describe("Session ID"),
      includeRawTranscript: z.boolean().optional().describe("Include raw ANSI transcript"),
    },
    async (args: { sessionId: string; includeRawTranscript?: boolean }) => {
      const session = appController.state.sessions.find((candidate) => candidate.id === args.sessionId);
      if (!session) return textResult({ error: "Session not found" });
      const { sessionIconPath, rawTranscript, ...rest } = session;
      const result: SessionDetailsResult = { ...rest };
      if (args.includeRawTranscript) result.rawTranscript = rawTranscript;
      return textResult(result);
    }
  );

  // ── get_session_tail ───────────────────────────────────────────
  server.tool(
    "get_session_tail",
    "Get bounded recent transcript output for a session",
    {
      sessionId: z.string().describe("Session ID"),
      lines: z.number().optional().describe("Number of recent lines, capped at 500"),
      maxChars: z.number().optional().describe("Maximum returned characters, capped at 50000"),
      includeRawTranscript: z.boolean().optional().describe("Include raw ANSI transcript tail"),
    },
    async (args: SessionTailArgs) => {
      const session = appController.state.sessions.find((candidate) => candidate.id === args.sessionId);
      if (!session) return textResult({ error: "Session not found" });

      const lineLimit = boundedInteger(args.lines, DEFAULT_SESSION_TAIL_LINES, 1, MAX_SESSION_TAIL_LINES);
      const charLimit = boundedInteger(args.maxChars, DEFAULT_SESSION_TAIL_CHARS, 1, MAX_SESSION_TAIL_CHARS);
      const result = {
        sessionId: session.id,
        repoID: session.repoID,
        title: session.title,
        status: session.status,
        runtimeState: session.runtimeState,
        unreadCount: session.unreadCount,
        blocker: session.blocker,
        lastActivityAt: session.lastActivityAt,
        updatedAt: session.updatedAt,
        transcript: transcriptTail(session.transcript, lineLimit, charLimit),
        rawTranscript: args.includeRawTranscript
          ? transcriptTail(session.rawTranscript, lineLimit, charLimit)
          : undefined,
      };

      return textResult(result);
    }
  );

  // ── focus_session ──────────────────────────────────────────────
  server.tool(
    "focus_session",
    "Set or clear the focused session used for unread tracking and agent routing",
    {
      sessionId: z.string().nullable().optional().describe("Session ID to focus, or null to clear focus"),
    },
    async (args: FocusSessionArgs) => {
      if (!args.sessionId) {
        appController.setFocusedSession(null);
        return textResult({ ok: true, focusedSessionId: null });
      }

      const session = appController.state.sessions.find((candidate) => candidate.id === args.sessionId);
      if (!session) return textResult({ ok: false, error: "Session not found" });

      const clearedUnreadCount = session.unreadCount;
      appController.setFocusedSession(args.sessionId);
      return textResult({
        ok: true,
        focusedSessionId: args.sessionId,
        clearedUnreadCount,
        status: session.status,
        runtimeState: session.runtimeState,
      });
    }
  );

  // ── create_session ─────────────────────────────────────────────
  server.tool(
    "create_session",
    "Create a new agent session in a repo",
    {
      repoId: z.string().describe("Repo ID to create session in"),
      agentId: z.string().optional().describe("Agent ID (defaults to user preference)"),
      prompt: z.string().max(MAX_SESSION_PROMPT_CHARS).optional().describe("Initial prompt to send"),
    },
    async (args: McpActionArgs<"create_session">) => {
      const result = await appController.handleMcpAction("create_session", args);
      return textResult(result);
    }
  );

  // ── create_shell_session ───────────────────────────────────────
  server.tool(
    "create_shell_session",
    "Create a plain shell session in a repo",
    {
      repoId: z.string().describe("Repo ID to create a shell session in"),
      title: z.string().max(MAX_SESSION_TITLE_CHARS).optional().describe("Optional session title"),
      command: z.string().max(MAX_SESSION_TEXT_CHARS).optional().describe("Optional printable command to submit after launch"),
    },
    async (args: CreateShellSessionArgs) => {
      if (args.command && containsTerminalControlCharacter(args.command)) {
        return textResult({
          ok: false,
          error: "Command contains terminal control characters; use send_key for special keys.",
        });
      }

      const result = await appController.handleMcpAction("create_shell_session", args);
      return textResult({ sessionId: result, commandQueued: !!args.command });
    }
  );

  // ── rename_session ─────────────────────────────────────────────
  server.tool(
    "rename_session",
    "Rename a session",
    {
      sessionId: z.string().describe("Session ID"),
      title: z.string().describe("New title"),
    },
    async (args: McpActionArgs<"rename_session">) => {
      const result = await appController.handleMcpAction("rename_session", args);
      return textResult(result ?? { ok: true });
    }
  );

  // ── close_session ──────────────────────────────────────────────
  server.tool(
    "close_session",
    "Close and delete a session",
    {
      sessionId: z.string().describe("Session ID to close"),
    },
    async (args: McpActionArgs<"close_session">) => {
      const result = await appController.handleMcpAction("close_session", args);
      return textResult(result ?? { ok: true });
    }
  );

  // ── reopen_session ─────────────────────────────────────────────
  server.tool(
    "reopen_session",
    "Reopen a stopped session",
    {
      sessionId: z.string().describe("Session ID to reopen"),
    },
    async (args: McpActionArgs<"reopen_session">) => {
      const result = await appController.handleMcpAction("reopen_session", args);
      return textResult(result ?? { ok: true });
    }
  );

  // ── restart_session ────────────────────────────────────────────
  server.tool(
    "restart_session",
    "Restart a live or stopped session without deleting it",
    {
      sessionId: z.string().describe("Session ID to restart"),
    },
    async (args: McpActionArgs<"restart_session">) => {
      const session = appController.state.sessions.find((candidate) => candidate.id === args.sessionId);
      if (!session) return textResult({ ok: false, error: "Session not found" });
      const previousRuntimeState = session.runtimeState;
      const result = await appController.handleMcpAction("restart_session", args);
      return textResult({
        ok: true,
        previousRuntimeState,
        restartQueued: previousRuntimeState === "live",
        result: result ?? null,
      });
    }
  );

  // ── stop_session ───────────────────────────────────────────────
  server.tool(
    "stop_session",
    "Stop a session terminal while keeping its history",
    {
      sessionId: z.string().describe("Session ID to stop"),
    },
    async (args: McpActionArgs<"stop_session">) => {
      const session = appController.state.sessions.find((candidate) => candidate.id === args.sessionId);
      if (!session) return textResult({ ok: false, error: "Session not found" });
      const previousRuntimeState = session.runtimeState;
      const result = await appController.handleMcpAction("stop_session", args);
      return textResult({
        ok: true,
        previousRuntimeState,
        stopped: true,
        result: result ?? null,
      });
    }
  );

  // ── resize_session ─────────────────────────────────────────────
  server.tool(
    "resize_session",
    "Resize a session terminal",
    {
      sessionId: z.string().describe("Session ID to resize"),
      cols: z.number().int().min(1).max(MAX_TERMINAL_COLS).describe("Terminal columns"),
      rows: z.number().int().min(1).max(MAX_TERMINAL_ROWS).describe("Terminal rows"),
    },
    async (args: McpActionArgs<"resize_session">) => {
      const session = appController.state.sessions.find((candidate) => candidate.id === args.sessionId);
      if (!session) return textResult({ ok: false, error: "Session not found" });
      const result = await appController.handleMcpAction("resize_session", args);
      return textResult({
        ok: true,
        sessionId: args.sessionId,
        cols: args.cols,
        rows: args.rows,
        result: result ?? null,
      });
    }
  );

  // ── organize_session ───────────────────────────────────────────
  server.tool(
    "organize_session",
    "Update session pin, tag color, or move to another repo",
    {
      sessionId: z.string().describe("Session ID"),
      isPinned: z.boolean().optional().describe("Pin or unpin"),
      tagColor: z.enum(SESSION_TAG_COLOR_VALUES).nullable().optional().describe("Tag color (red|orange|yellow|green|blue|purple|gray) or null"),
      repoId: z.string().optional().describe("Move to different repo"),
    },
    async (args: McpActionArgs<"organize_session">) => {
      const result = await appController.handleMcpAction("organize_session", args);
      return textResult(result ?? { ok: true });
    }
  );

  // ── send_input ─────────────────────────────────────────────────
  server.tool(
    "send_input",
    "Send text input to a session terminal",
    {
      sessionId: z.string().describe("Session ID"),
      text: z.string().describe("Text to send to terminal"),
    },
    async (args: { sessionId: string; text: string }) => {
      const session = appController.state.sessions.find((candidate) => candidate.id === args.sessionId);
      if (!session) return textResult({ ok: false, error: "Session not found" });
      appController.handleSessionInput(args.sessionId, args.text + "\r");
      return textResult({ ok: true });
    }
  );

  // ── send_command ───────────────────────────────────────────────
  server.tool(
    "send_command",
    "Send a printable command to a session terminal and press Enter",
    {
      sessionId: z.string().describe("Session ID"),
      command: z.string().max(MAX_SESSION_TEXT_CHARS).describe("Printable command to submit"),
    },
    async (args: SessionCommandArgs) => {
      const session = appController.state.sessions.find((candidate) => candidate.id === args.sessionId);
      if (!session) return textResult({ ok: false, error: "Session not found" });
      if (containsTerminalControlCharacter(args.command)) {
        return textResult({
          ok: false,
          error: "Command contains terminal control characters; use send_key for special keys.",
        });
      }

      const result = await appController.handleMcpAction("send_command", args);
      return textResult({ ok: true, ...result });
    }
  );

  // ── run_session_command ────────────────────────────────────────
  server.tool(
    "run_session_command",
    "Send a printable command, wait for session output to quiet, and return a transcript tail",
    {
      sessionId: z.string().describe("Session ID"),
      command: z.string().max(MAX_SESSION_TEXT_CHARS).describe("Printable command to submit"),
      timeoutMs: z.number().optional().describe("Maximum wait in milliseconds, capped at 300000"),
      pollIntervalMs: z.number().optional().describe("Polling interval in milliseconds, capped from 100 to 5000"),
      quietMs: z.number().optional().describe("Required no-output window in milliseconds, capped from 250 to 30000"),
      stopOnQuiet: z.boolean().optional().describe("Stop the session after quiet output is reached, preserving transcript"),
      lines: z.number().optional().describe("Number of recent lines to return, capped at 500"),
      maxChars: z.number().optional().describe("Maximum returned transcript characters, capped at 50000"),
      includeRawTranscript: z.boolean().optional().describe("Include raw ANSI transcript tail"),
    },
    async (args: RunSessionCommandArgs) => {
      const session = appController.state.sessions.find((candidate) => candidate.id === args.sessionId);
      if (!session) return textResult({ ok: false, error: "Session not found" });
      if (containsTerminalControlCharacter(args.command)) {
        return textResult({
          ok: false,
          error: "Command contains terminal control characters; use send_key for special keys.",
        });
      }

      const afterActivityAt = new Date().toISOString();
      const commandResult = await appController.handleMcpAction("send_command", {
        sessionId: args.sessionId,
        command: args.command,
      });
      const wait = await waitForSessionState(appController, {
        sessionId: args.sessionId,
        condition: "quiet",
        timeoutMs: args.timeoutMs,
        pollIntervalMs: args.pollIntervalMs,
        afterActivityAt,
        quietMs: args.quietMs,
      });
      const stopped = !!args.stopOnQuiet && wait.ok;
      if (stopped) {
        await appController.handleMcpAction("stop_session", { sessionId: args.sessionId });
      }
      const currentSession = appController.state.sessions.find((candidate) => candidate.id === args.sessionId);
      const lineLimit = boundedInteger(args.lines, DEFAULT_SESSION_TAIL_LINES, 1, MAX_SESSION_TAIL_LINES);
      const charLimit = boundedInteger(args.maxChars, DEFAULT_SESSION_TAIL_CHARS, 1, MAX_SESSION_TAIL_CHARS);

      return textResult({
        ok: wait.ok,
        command: commandResult,
        wait,
        stopped,
        transcript: currentSession ? transcriptTail(currentSession.transcript, lineLimit, charLimit) : null,
        rawTranscript: currentSession && args.includeRawTranscript
          ? transcriptTail(currentSession.rawTranscript, lineLimit, charLimit)
          : undefined,
      });
    }
  );

  // ── run_repo_command ───────────────────────────────────────────
  server.tool(
    "run_repo_command",
    "Create a shell session in a repo, run a printable command, wait for quiet output, and return a transcript tail",
    {
      repoId: z.string().describe("Repo ID to create a shell session in"),
      title: z.string().max(MAX_SESSION_TITLE_CHARS).optional().describe("Optional session title"),
      command: z.string().max(MAX_SESSION_TEXT_CHARS).describe("Printable command to submit"),
      timeoutMs: z.number().optional().describe("Maximum wait in milliseconds, capped at 300000"),
      pollIntervalMs: z.number().optional().describe("Polling interval in milliseconds, capped from 100 to 5000"),
      quietMs: z.number().optional().describe("Required no-output window in milliseconds, capped from 250 to 30000"),
      stopOnQuiet: z.boolean().optional().describe("Stop the session after quiet output is reached, preserving transcript"),
      lines: z.number().optional().describe("Number of recent lines to return, capped at 500"),
      maxChars: z.number().optional().describe("Maximum returned transcript characters, capped at 50000"),
      includeRawTranscript: z.boolean().optional().describe("Include raw ANSI transcript tail"),
    },
    async (args: RunRepoCommandArgs) => {
      const repo = appController.state.repos.find((candidate) => candidate.id === args.repoId);
      if (!repo) return textResult({ ok: false, error: "Repo not found" });
      if (containsTerminalControlCharacter(args.command)) {
        return textResult({
          ok: false,
          error: "Command contains terminal control characters; use send_key for special keys.",
        });
      }

      const afterActivityAt = new Date().toISOString();
      const sessionId = await appController.handleMcpAction("create_shell_session", {
        repoId: args.repoId,
        title: args.title,
        command: args.command,
      });

      if (!sessionId) {
        return textResult({ ok: false, error: "Shell session could not be created" });
      }

      const wait = await waitForSessionState(appController, {
        sessionId,
        condition: "quiet",
        timeoutMs: args.timeoutMs,
        pollIntervalMs: args.pollIntervalMs,
        afterActivityAt,
        quietMs: args.quietMs,
      });
      const stopped = !!args.stopOnQuiet && wait.ok;
      if (stopped) {
        await appController.handleMcpAction("stop_session", { sessionId });
      }
      const session = appController.state.sessions.find((candidate) => candidate.id === sessionId);
      const lineLimit = boundedInteger(args.lines, DEFAULT_SESSION_TAIL_LINES, 1, MAX_SESSION_TAIL_LINES);
      const charLimit = boundedInteger(args.maxChars, DEFAULT_SESSION_TAIL_CHARS, 1, MAX_SESSION_TAIL_CHARS);

      return textResult({
        ok: wait.ok,
        sessionId,
        repoId: args.repoId,
        wait,
        stopped,
        transcript: session ? transcriptTail(session.transcript, lineLimit, charLimit) : null,
        rawTranscript: session && args.includeRawTranscript
          ? transcriptTail(session.rawTranscript, lineLimit, charLimit)
          : undefined,
      });
    }
  );

  // ── send_text ──────────────────────────────────────────────────
  server.tool(
    "send_text",
    "Send literal printable text to a session terminal without pressing Enter",
    {
      sessionId: z.string().describe("Session ID"),
      text: z.string().max(MAX_SESSION_TEXT_CHARS).describe("Printable text to send without Enter"),
    },
    async (args: SessionTextArgs) => {
      const session = appController.state.sessions.find((candidate) => candidate.id === args.sessionId);
      if (!session) return textResult({ ok: false, error: "Session not found" });
      if (containsTerminalControlCharacter(args.text)) {
        return textResult({
          ok: false,
          error: "Text contains terminal control characters; use send_key for special keys.",
        });
      }

      appController.handleSessionInput(args.sessionId, args.text);
      return textResult({ ok: true, sentChars: args.text.length });
    }
  );

  // ── send_key ───────────────────────────────────────────────────
  server.tool(
    "send_key",
    "Send an allowed key press to a session terminal",
    {
      sessionId: z.string().describe("Session ID"),
      key: z.enum(SESSION_TERMINAL_KEY_VALUES).describe("Key to send"),
    },
    async (args: { sessionId: string; key: SessionTerminalKey }) => {
      const session = appController.state.sessions.find((candidate) => candidate.id === args.sessionId);
      if (!session) return textResult({ ok: false, error: "Session not found" });
      appController.handleSessionInput(args.sessionId, SESSION_TERMINAL_KEY_INPUTS[args.key]);
      return textResult({ ok: true, key: args.key });
    }
  );

  // ── approve_action ─────────────────────────────────────────────
  server.tool(
    "approve_action",
    "Approve a session blocker (tool use, plan, permission)",
    {
      sessionId: z.string().describe("Session ID to approve"),
    },
    async (args: { sessionId: string }) => {
      const session = appController.state.sessions.find((candidate) => candidate.id === args.sessionId);
      if (!session) return textResult({ error: "Session not found" });
      const agentId = session.startupAgentId || "claude";
      const input = AGENT_APPROVE_MAP[agentId] ?? defaultApprove();
      appController.handleSessionInput(args.sessionId, input);
      return textResult({ ok: true, agentId });
    }
  );

  // ── deny_action ────────────────────────────────────────────────
  server.tool(
    "deny_action",
    "Deny a session blocker",
    {
      sessionId: z.string().describe("Session ID to deny"),
    },
    async (args: { sessionId: string }) => {
      const session = appController.state.sessions.find((candidate) => candidate.id === args.sessionId);
      if (!session) return textResult({ error: "Session not found" });
      const agentId = session.startupAgentId || "claude";
      const input = AGENT_DENY_MAP[agentId] ?? defaultDeny();
      appController.handleSessionInput(args.sessionId, input);
      return textResult({ ok: true, agentId });
    }
  );

  // ── search_sessions ────────────────────────────────────────────
  server.tool(
    "search_sessions",
    "Search across session transcripts",
    {
      repoId: z.string().describe("Repo ID to search within"),
      query: z.string().describe("Search query"),
    },
    async (args: McpActionArgs<"search_sessions">) => {
      const result = await appController.handleMcpAction("search_sessions", args);
      return textResult(result);
    }
  );

  // ── get_next_unread ────────────────────────────────────────────
  server.tool(
    "get_next_unread",
    "Get the next session with unread output",
    {},
    async () => {
      const unread = appController.state.sessions
        .filter((session) => session.unreadCount > 0)
        .sort((left, right) => {
          const leftTime = left.lastActivityAt || left.updatedAt;
          const rightTime = right.lastActivityAt || right.updatedAt;
          return rightTime.localeCompare(leftTime);
        });
      const next = unread[0] ?? null;
      return textResult({ sessionId: next?.id ?? null, unreadTotal: unread.length });
    }
  );

  // ── wait_for_session ───────────────────────────────────────────
  server.tool(
    "wait_for_session",
    "Wait for a session to reach a bounded actionable state",
    {
      sessionId: z.string().describe("Session ID"),
      condition: z.enum(SESSION_WAIT_CONDITION_VALUES).describe("Condition to wait for"),
      timeoutMs: z.number().optional().describe("Maximum wait in milliseconds, capped at 300000"),
      pollIntervalMs: z.number().optional().describe("Polling interval in milliseconds, capped from 100 to 5000"),
      afterActivityAt: z.string().optional().describe("For activity or quiet waits, require activity after this ISO timestamp"),
      quietMs: z.number().optional().describe("For quiet waits, required no-output window in milliseconds, capped from 250 to 30000"),
    },
    async (args: SessionWaitArgs) => {
      const result = await waitForSessionState(appController, args);
      return textResult(result);
    }
  );

  // ── resume_session ──────────────────────────────────────────────
  server.tool(
    "resume_session",
    "Resume a session from an existing Claude or Codex session",
    {
      repoId: z.string().describe("Repo ID to resume in"),
      source: z.enum(SESSION_SEARCH_SOURCE_VALUES).optional().describe("Source agent: 'claude' or 'codex' (defaults to 'claude')"),
      externalSessionId: z.string().describe("External session ID to resume from"),
    },
    async (args: McpActionArgs<"resume_session">) => {
      const result = await appController.handleMcpAction("resume_session", args);
      return textResult(result);
    }
  );
}
