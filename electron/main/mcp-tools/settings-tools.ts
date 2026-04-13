/**
 * MCP tools for preferences and settings management.
 */

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function register(server: any, appController: any) {
  // ── get_preferences ────────────────────────────────────────────
  server.tool(
    "get_preferences",
    {},
    async () => {
      return textResult(appController.state.preferences);
    }
  );

  // ── update_preferences ─────────────────────────────────────────
  server.tool(
    "update_preferences",
    {
      patch: {
        type: "object",
        description: "Partial preferences object to merge",
        additionalProperties: true,
      },
    },
    async (args: { patch: Record<string, unknown> }) => {
      const result = await appController.handleMcpAction("update_preferences", args);
      return textResult(result ?? { ok: true });
    }
  );

  // ── get_settings_context ───────────────────────────────────────
  server.tool(
    "get_settings_context",
    {
      repoId: { type: "string", description: "Repo ID" },
    },
    async (args: { repoId: string }) => {
      const result = await appController.handleMcpAction("get_settings_context", args);
      return textResult(result);
    }
  );

  // ── load_settings_file ─────────────────────────────────────────
  server.tool(
    "load_settings_file",
    {
      repoId: { type: "string", description: "Repo ID" },
      filePath: { type: "string", description: "Settings file path" },
    },
    async (args: { repoId: string; filePath: string }) => {
      const result = await appController.handleMcpAction("load_settings_file", args);
      return textResult(result);
    }
  );

  // ── save_settings_file ─────────────────────────────────────────
  server.tool(
    "save_settings_file",
    {
      repoId: { type: "string", description: "Repo ID" },
      filePath: { type: "string", description: "Settings file path" },
      content: { type: "string", description: "File content to write" },
    },
    async (args: { repoId: string; filePath: string; content: string }) => {
      const result = await appController.handleMcpAction("save_settings_file", args);
      return textResult(result ?? { ok: true });
    }
  );
}
