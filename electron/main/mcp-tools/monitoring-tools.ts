/**
 * MCP tools for monitoring, ephemeral tools, and inbox.
 */

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function register(server: any, appController: any) {
  // ── get_port_status ────────────────────────────────────────────
  server.tool(
    "get_port_status",
    {},
    async () => {
      const result = await appController.handleMcpAction("get_port_status", {});
      return textResult(result);
    }
  );

  // ── launch_ephemeral_tool ──────────────────────────────────────
  server.tool(
    "launch_ephemeral_tool",
    {
      toolId: { type: "string", description: "Tool ID: lazygit or tokscale" },
      repoId: { type: "string", description: "Repo ID" },
    },
    async (args: { toolId: string; repoId: string }) => {
      const result = await appController.handleMcpAction("launch_ephemeral_tool", args);
      return textResult(result);
    }
  );

  // ── close_ephemeral_tool ───────────────────────────────────────
  server.tool(
    "close_ephemeral_tool",
    {
      toolId: { type: "string", description: "Tool ID: lazygit or tokscale" },
      sessionId: { type: "string", description: "Session ID of the ephemeral tool" },
    },
    async (args: { toolId: string; sessionId: string }) => {
      const result = await appController.handleMcpAction("close_ephemeral_tool", args);
      return textResult(result ?? { ok: true });
    }
  );

  // ── get_inbox ──────────────────────────────────────────────────
  server.tool(
    "get_inbox",
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
