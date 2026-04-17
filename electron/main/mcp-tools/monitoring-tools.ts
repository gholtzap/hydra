/**
 * MCP tools for monitoring, ephemeral tools, and inbox.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { SessionRecord } from "../../shared-types";
import type { AppControllerHandle } from "../internal-api";
import type { McpActionArgs } from "../mcp-contracts";

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

type InboxSessionSummary = Pick<
  SessionRecord,
  "id" | "title" | "repoID" | "status" | "blocker" | "unreadCount" | "lastActivityAt"
>;

const EPHEMERAL_TOOL_ID_VALUES = [
  "lazygit",
  "tokscale"
] as const;

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
    {},
    async () => {
      const sessions = appController.state.sessions;
      const blocked = sessions.filter((session) => session.status === "blocked" || session.status === "needs_input");
      const unread = sessions.filter((session) => session.unreadCount > 0);
      const summaryMap = (session: SessionRecord): InboxSessionSummary => ({
        id: session.id,
        title: session.title,
        repoID: session.repoID,
        status: session.status,
        blocker: session.blocker,
        unreadCount: session.unreadCount,
        lastActivityAt: session.lastActivityAt,
      });
      return textResult({
        blocked: blocked.map(summaryMap),
        unread: unread.map(summaryMap),
      });
    }
  );
}
