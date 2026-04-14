/**
 * MCP tools for monitoring, ephemeral tools, and inbox.
 */
import { z } from "zod";

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function register(server: any, appController: any) {
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
      toolId: z.string().describe("Tool ID: lazygit or tokscale"),
      repoId: z.string().describe("Repo ID"),
    },
    async (args: { toolId: string; repoId: string }) => {
      const result = await appController.handleMcpAction("launch_ephemeral_tool", args);
      return textResult(result);
    }
  );

  server.tool(
    "close_ephemeral_tool",
    "Close an ephemeral tool session",
    {
      toolId: z.string().describe("Tool ID: lazygit or tokscale"),
      sessionId: z.string().describe("Session ID of the ephemeral tool"),
    },
    async (args: { toolId: string; sessionId: string }) => {
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
      const blocked = sessions.filter((s: any) => s.status === "blocked" || s.status === "needs_input");
      const unread = sessions.filter((s: any) => s.unreadCount > 0);
      const summaryMap = (s: any) => ({
        id: s.id,
        title: s.title,
        repoID: s.repoID,
        status: s.status,
        blocker: s.blocker,
        unreadCount: s.unreadCount,
        lastActivityAt: s.lastActivityAt,
      });
      return textResult({
        blocked: blocked.map(summaryMap),
        unread: unread.map(summaryMap),
      });
    }
  );
}
