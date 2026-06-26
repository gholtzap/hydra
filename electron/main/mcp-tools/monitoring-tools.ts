/**
 * MCP tools for monitoring, ephemeral tools, and inbox.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { SessionRecord } from "../../shared-types";
import type { AppControllerHandle } from "../internal-api";
import type { McpActionArgs } from "../mcp-contracts";
import { textResult } from "./result";

type InboxArgs = {
  repoId?: string;
  limit?: number;
};

type ControlOverviewArgs = {
  repoId?: string;
  limit?: number;
};

type InboxSessionSummary = Pick<
  SessionRecord,
  | "id"
  | "title"
  | "repoID"
  | "status"
  | "runtimeState"
  | "startupAgentId"
  | "blocker"
  | "unreadCount"
  | "lastActivityAt"
  | "updatedAt"
> & {
  repoName: string | null;
  reasons: string[];
};

const DEFAULT_INBOX_LIMIT = 25;
const MAX_INBOX_LIMIT = 100;

const EPHEMERAL_TOOL_ID_VALUES = [
  "lazygit",
  "tokscale"
] as const;

function boundedInboxLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_INBOX_LIMIT;
  }
  return Math.max(1, Math.min(MAX_INBOX_LIMIT, Math.trunc(limit)));
}

function sessionActivityTimestamp(session: SessionRecord): string {
  return session.lastActivityAt || session.updatedAt;
}

function inboxReasons(session: SessionRecord): string[] {
  const reasons: string[] = [];
  if (session.status === "blocked" || session.status === "needs_input" || session.blocker) {
    reasons.push("blocked");
  }
  if (session.unreadCount > 0) {
    reasons.push("unread");
  }
  return reasons;
}

function sessionSummary(appController: AppControllerHandle, session: SessionRecord): InboxSessionSummary {
  return {
    id: session.id,
    title: session.title,
    repoID: session.repoID,
    repoName: appController.state.repos.find((repo) => repo.id === session.repoID)?.name ?? null,
    status: session.status,
    runtimeState: session.runtimeState,
    startupAgentId: session.startupAgentId,
    blocker: session.blocker,
    unreadCount: session.unreadCount,
    lastActivityAt: session.lastActivityAt,
    updatedAt: session.updatedAt,
    reasons: inboxReasons(session),
  };
}

function sortedActionableSessions(sessions: SessionRecord[]): SessionRecord[] {
  const blocked = sessions.filter(
    (session) => session.status === "blocked" || session.status === "needs_input" || session.blocker !== null
  );
  const unread = sessions.filter((session) => session.unreadCount > 0);

  return Array.from(new Map([...blocked, ...unread].map((session) => [session.id, session])).values())
    .sort((left, right) => {
      const leftReasons = inboxReasons(left);
      const rightReasons = inboxReasons(right);
      const leftBlocked = leftReasons.includes("blocked");
      const rightBlocked = rightReasons.includes("blocked");
      if (leftBlocked !== rightBlocked) return leftBlocked ? -1 : 1;
      return sessionActivityTimestamp(right).localeCompare(sessionActivityTimestamp(left));
    });
}

export function register(server: McpServer, appController: AppControllerHandle): void {
  server.tool(
    "get_port_status",
    "Get dev port monitoring status",
    {},
    async () => {
      const result = await appController.handleMcpAction("get_port_status", {});
      return textResult(result);
    }
  );

  server.tool(
    "launch_ephemeral_tool",
    "Launch an ephemeral tool (lazygit or tokscale)",
    {
      toolId: z.enum(EPHEMERAL_TOOL_ID_VALUES).describe("Tool ID: lazygit or tokscale"),
      repoId: z.string().describe("Repo ID"),
    },
    async (args: McpActionArgs<"launch_ephemeral_tool">) => {
      const result = await appController.handleMcpAction("launch_ephemeral_tool", args);
      return textResult(result);
    }
  );

  server.tool(
    "close_ephemeral_tool",
    "Close an ephemeral tool session",
    {
      toolId: z.enum(EPHEMERAL_TOOL_ID_VALUES).describe("Tool ID: lazygit or tokscale"),
      sessionId: z.string().describe("Session ID of the ephemeral tool"),
    },
    async (args: McpActionArgs<"close_ephemeral_tool">) => {
      const result = await appController.handleMcpAction("close_ephemeral_tool", args);
      return textResult(result ?? { ok: true });
    }
  );

  server.tool(
    "get_inbox",
    "Get blocked and unread sessions (the inbox)",
    {
      repoId: z.string().optional().describe("Filter inbox sessions by repo ID"),
      limit: z.number().optional().describe("Maximum actionable sessions to return, capped at 100"),
    },
    async (args: InboxArgs) => {
      const limit = boundedInboxLimit(args.limit);
      const sessions = args.repoId
        ? appController.state.sessions.filter((session) => session.repoID === args.repoId)
        : appController.state.sessions;
      const blocked = sessions.filter(
        (session) => session.status === "blocked" || session.status === "needs_input" || session.blocker !== null
      );
      const unread = sessions.filter((session) => session.unreadCount > 0);
      const blockedIds = new Set(blocked.map((session) => session.id));
      const summaryMap = (session: SessionRecord): InboxSessionSummary => sessionSummary(appController, session);
      const actionable = sortedActionableSessions(sessions).slice(0, limit);

      return textResult({
        actionable: actionable.map(summaryMap),
        blocked: blocked.map(summaryMap),
        unread: unread.map(summaryMap),
        counts: {
          actionable: blocked.length + unread.filter((session) => !blockedIds.has(session.id)).length,
          blocked: blocked.length,
          unread: unread.length,
        },
        limit,
      });
    }
  );

  server.tool(
    "get_control_overview",
    "Get a compact control overview with focused, actionable, and session count metadata",
    {
      repoId: z.string().optional().describe("Filter sessions by repo ID"),
      limit: z.number().optional().describe("Maximum actionable sessions to return, capped at 100"),
    },
    async (args: ControlOverviewArgs) => {
      const limit = boundedInboxLimit(args.limit);
      const sessions = args.repoId
        ? appController.state.sessions.filter((session) => session.repoID === args.repoId)
        : appController.state.sessions;
      const blocked = sessions.filter(
        (session) => session.status === "blocked" || session.status === "needs_input" || session.blocker !== null
      );
      const unread = sessions.filter((session) => session.unreadCount > 0);
      const live = sessions.filter((session) => session.runtimeState !== "stopped");
      const focusedSession = appController.focusedSessionId
        ? appController.state.sessions.find((session) => session.id === appController.focusedSessionId) ?? null
        : null;

      return textResult({
        focusedSession: focusedSession ? sessionSummary(appController, focusedSession) : null,
        actionable: sortedActionableSessions(sessions).slice(0, limit).map((session) =>
          sessionSummary(appController, session)
        ),
        counts: {
          workspaces: appController.state.workspaces.length,
          repos: appController.state.repos.length,
          sessions: sessions.length,
          live: live.length,
          stopped: sessions.length - live.length,
          blocked: blocked.length,
          unread: unread.length,
        },
        filter: {
          repoId: args.repoId ?? null,
        },
        limit,
      });
    }
  );
}
