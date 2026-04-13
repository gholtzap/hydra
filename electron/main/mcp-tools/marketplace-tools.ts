/**
 * MCP tools for skills marketplace.
 */

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function register(server: any, appController: any) {
  // ── get_skill_details ──────────────────────────────────────────
  server.tool(
    "get_skill_details",
    {
      owner: { type: "string", description: "GitHub owner" },
      repo: { type: "string", description: "GitHub repo name" },
      path: { type: "string", description: "Path within repo" },
    },
    async (args: { owner: string; repo: string; path: string }) => {
      const result = await appController.handleMcpAction("get_skill_details", args);
      return textResult(result);
    }
  );

  // ── inspect_skill_url ──────────────────────────────────────────
  server.tool(
    "inspect_skill_url",
    {
      url: { type: "string", description: "GitHub URL to inspect" },
    },
    async (args: { url: string }) => {
      const result = await appController.handleMcpAction("inspect_skill_url", args);
      return textResult(result);
    }
  );

  // ── install_skill ──────────────────────────────────────────────
  server.tool(
    "install_skill",
    {
      owner: { type: "string", description: "GitHub owner" },
      repo: { type: "string", description: "GitHub repo name" },
      path: { type: "string", description: "Path within repo" },
      scope: { type: "string", description: "Install scope: user or project" },
    },
    async (args: { owner: string; repo: string; path: string; scope: string }) => {
      const result = await appController.handleMcpAction("install_skill", args);
      return textResult(result);
    }
  );
}
