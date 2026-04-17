/**
 * MCP tools for workspace and repository management.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppControllerHandle } from "../internal-api";
import type { McpActionArgs } from "../mcp-contracts";

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function register(server: McpServer, appController: AppControllerHandle): void {
  server.tool(
    "list_workspaces",
    "List all workspaces",
    {},
    async () => {
      return textResult(appController.state.workspaces);
    }
  );

  server.tool(
    "add_workspace",
    "Add a workspace folder",
    {
      path: z.string().describe("Absolute path to workspace folder"),
    },
    async (args: McpActionArgs<"add_workspace">) => {
      const result = await appController.handleMcpAction("add_workspace", args);
      return textResult(result);
    }
  );

  server.tool(
    "rescan_workspace",
    "Rescan workspace for new repos",
    {
      workspaceId: z.string().describe("Workspace ID to rescan"),
    },
    async (args: McpActionArgs<"rescan_workspace">) => {
      const result = await appController.handleMcpAction("rescan_workspace", args);
      return textResult(result);
    }
  );

  server.tool(
    "list_repos",
    "List repos, optionally filtered by workspace",
    {
      workspaceId: z.string().optional().describe("Filter by workspace ID"),
    },
    async (args: { workspaceId?: string }) => {
      let repos = [...appController.state.repos];
      if (args.workspaceId) repos = repos.filter((repo) => repo.workspaceID === args.workspaceId);
      return textResult(repos);
    }
  );

  server.tool(
    "get_repo",
    "Get repo details by ID",
    {
      repoId: z.string().describe("Repo ID"),
    },
    async (args: { repoId: string }) => {
      const repo = appController.state.repos.find((candidate) => candidate.id === args.repoId);
      if (!repo) return textResult({ error: "Repo not found" });
      return textResult(repo);
    }
  );

  server.tool(
    "list_files",
    "List file tree of a repo",
    {
      repoId: z.string().describe("Repo ID"),
    },
    async (args: McpActionArgs<"list_files">) => {
      const result = await appController.handleMcpAction("list_files", args);
      return textResult(result);
    }
  );

  server.tool(
    "read_file",
    "Read file content from a repo",
    {
      repoId: z.string().describe("Repo ID"),
      path: z.string().describe("Relative file path within repo"),
    },
    async (args: McpActionArgs<"read_file">) => {
      const result = await appController.handleMcpAction("read_file", args);
      return textResult(result);
    }
  );

  server.tool(
    "set_build_run_config",
    "Set build and run commands for a repo",
    {
      repoId: z.string().describe("Repo ID"),
      buildCommand: z.string().describe("Build command"),
      runCommand: z.string().describe("Run command"),
    },
    async (args: McpActionArgs<"set_build_run_config">) => {
      const result = await appController.handleMcpAction("set_build_run_config", args);
      return textResult(result ?? { ok: true });
    }
  );

  server.tool(
    "build_and_run_app",
    "Execute build and run for a repo",
    {
      repoId: z.string().describe("Repo ID"),
    },
    async (args: McpActionArgs<"build_and_run_app">) => {
      const result = await appController.handleMcpAction("build_and_run_app", args);
      return textResult(result);
    }
  );
}
