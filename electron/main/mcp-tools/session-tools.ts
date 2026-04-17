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

  // ── create_session ─────────────────────────────────────────────
  server.tool(
    "create_session",
    "Create a new agent session in a repo",
    {
      repoId: z.string().describe("Repo ID to create session in"),
      agentId: z.string().optional().describe("Agent ID (defaults to user preference)"),
      prompt: z.string().optional().describe("Initial prompt to send"),
    },
    async (args: McpActionArgs<"create_session">) => {
      const result = await appController.handleMcpAction("create_session", args);
      return textResult(result);
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
      appController.ptyHost.sendInput(args.sessionId, args.text + "\r");
      return textResult({ ok: true });
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
      appController.ptyHost.sendInput(args.sessionId, input);
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
      appController.ptyHost.sendInput(args.sessionId, input);
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
