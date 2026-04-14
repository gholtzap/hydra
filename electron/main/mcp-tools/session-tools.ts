/**
 * MCP tools for session management.
 */
import { z } from "zod";

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

export function register(server: any, appController: any) {
  // ── list_sessions ──────────────────────────────────────────────
  server.tool(
    "list_sessions",
    "List sessions, optionally filtered by repo or status",
    {
      repoId: z.string().optional().describe("Filter by repo ID"),
      status: z.string().optional().describe("Filter by status (running|blocked|needs_input|failed|done|idle)"),
      limit: z.number().optional().describe("Max results to return"),
    },
    async (args: { repoId?: string; status?: string; limit?: number }) => {
      let sessions = [...appController.state.sessions];
      if (args.repoId) sessions = sessions.filter((s: any) => s.repoID === args.repoId);
      if (args.status) sessions = sessions.filter((s: any) => s.status === args.status);
      if (args.limit) sessions = sessions.slice(0, args.limit);
      const summaries = sessions.map(({ transcript, rawTranscript, sessionIconPath, ...rest }: any) => rest);
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
      const session = appController.state.sessions.find((s: any) => s.id === args.sessionId);
      if (!session) return textResult({ error: "Session not found" });
      const { sessionIconPath, rawTranscript, ...rest } = session;
      const result: any = { ...rest };
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
    async (args: { repoId: string; agentId?: string; prompt?: string }) => {
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
    async (args: { sessionId: string; title: string }) => {
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
    async (args: { sessionId: string }) => {
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
    async (args: { sessionId: string }) => {
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
      tagColor: z.string().optional().describe("Tag color (red|orange|yellow|green|blue|purple|gray) or null"),
      repoId: z.string().optional().describe("Move to different repo"),
    },
    async (args: { sessionId: string; isPinned?: boolean; tagColor?: string | null; repoId?: string }) => {
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
      const session = appController.state.sessions.find((s: any) => s.id === args.sessionId);
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
      const session = appController.state.sessions.find((s: any) => s.id === args.sessionId);
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
    async (args: { repoId: string; query: string }) => {
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
        .filter((s: any) => s.unreadCount > 0)
        .sort((a: any, b: any) => {
          const aTime = a.lastActivityAt || a.updatedAt;
          const bTime = b.lastActivityAt || b.updatedAt;
          return bTime.localeCompare(aTime);
        });
      const next = unread[0] ?? null;
      return textResult({ sessionId: next?.id ?? null, unreadTotal: unread.length });
    }
  );
}
