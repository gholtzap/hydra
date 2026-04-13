/**
 * MCP tools for wiki management.
 */

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function register(server: any, appController: any) {
  // ── get_wiki ───────────────────────────────────────────────────
  server.tool(
    "get_wiki",
    {
      repoId: { type: "string", description: "Repo ID" },
    },
    async (args: { repoId: string }) => {
      const result = await appController.handleMcpAction("get_wiki", args);
      return textResult(result);
    }
  );

  // ── read_wiki_page ─────────────────────────────────────────────
  server.tool(
    "read_wiki_page",
    {
      repoId: { type: "string", description: "Repo ID" },
      path: { type: "string", description: "Relative path to wiki page" },
    },
    async (args: { repoId: string; path: string }) => {
      const result = await appController.handleMcpAction("read_wiki_page", args);
      return textResult(result);
    }
  );

  // ── toggle_wiki ────────────────────────────────────────────────
  server.tool(
    "toggle_wiki",
    {
      repoId: { type: "string", description: "Repo ID" },
      enabled: { type: "boolean", description: "Enable or disable wiki" },
    },
    async (args: { repoId: string; enabled: boolean }) => {
      const result = await appController.handleMcpAction("toggle_wiki", args);
      return textResult(result ?? { ok: true });
    }
  );
}
