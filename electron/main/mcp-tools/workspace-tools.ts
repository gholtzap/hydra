/**
 * MCP tools for workspace and repository management.
 */

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function register(server: any, appController: any) {
  // ── list_workspaces ────────────────────────────────────────────
  server.tool(
    "list_workspaces",
    {},
    async () => {
      return textResult(appController.state.workspaces);
    }
  );

  // ── add_workspace ──────────────────────────────────────────────
  server.tool(
    "add_workspace",
    {
      path: { type: "string", description: "Absolute path to workspace folder" },
    },
    async (args: { path: string }) => {
      const result = await appController.handleMcpAction("add_workspace", args);
      return textResult(result);
    }
  );

  // ── rescan_workspace ───────────────────────────────────────────
  server.tool(
    "rescan_workspace",
    {
      workspaceId: { type: "string", description: "Workspace ID to rescan" },
    },
    async (args: { workspaceId: string }) => {
      const result = await appController.handleMcpAction("rescan_workspace", args);
      return textResult(result);
    }
  );

  // ── list_repos ─────────────────────────────────────────────────
  server.tool(
    "list_repos",
    {
      workspaceId: { type: "string", description: "Filter by workspace ID" },
    },
    async (args: { workspaceId?: string }) => {
      let repos = [...appController.state.repos];
      if (args.workspaceId) repos = repos.filter((r: any) => r.workspaceID === args.workspaceId);
      return textResult(repos);
    }
  );

  // ── get_repo ───────────────────────────────────────────────────
  server.tool(
    "get_repo",
    {
      repoId: { type: "string", description: "Repo ID" },
    },
    async (args: { repoId: string }) => {
      const repo = appController.state.repos.find((r: any) => r.id === args.repoId);
      if (!repo) return textResult({ error: "Repo not found" });
      return textResult(repo);
    }
  );

  // ── list_files ─────────────────────────────────────────────────
  server.tool(
    "list_files",
    {
      repoId: { type: "string", description: "Repo ID" },
    },
    async (args: { repoId: string }) => {
      const result = await appController.handleMcpAction("list_files", args);
      return textResult(result);
    }
  );

  // ── read_file ──────────────────────────────────────────────────
  server.tool(
    "read_file",
    {
      repoId: { type: "string", description: "Repo ID" },
      path: { type: "string", description: "Relative file path within repo" },
    },
    async (args: { repoId: string; path: string }) => {
      const result = await appController.handleMcpAction("read_file", args);
      return textResult(result);
    }
  );

  // ── set_build_run_config ───────────────────────────────────────
  server.tool(
    "set_build_run_config",
    {
      repoId: { type: "string", description: "Repo ID" },
      buildCommand: { type: "string", description: "Build command" },
      runCommand: { type: "string", description: "Run command" },
    },
    async (args: { repoId: string; buildCommand: string; runCommand: string }) => {
      const result = await appController.handleMcpAction("set_build_run_config", args);
      return textResult(result ?? { ok: true });
    }
  );

  // ── build_and_run_app ──────────────────────────────────────────
  server.tool(
    "build_and_run_app",
    {
      repoId: { type: "string", description: "Repo ID" },
    },
    async (args: { repoId: string }) => {
      const result = await appController.handleMcpAction("build_and_run_app", args);
      return textResult(result);
    }
  );
}
