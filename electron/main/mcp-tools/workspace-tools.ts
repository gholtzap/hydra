/**
 * MCP tools for workspace and repository management.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppControllerHandle } from "../internal-api";
import type { McpActionArgs } from "../mcp-contracts";
import { textResult } from "./result";

type RepoSearchArgs = {
  query: string;
  workspaceId?: string;
  limit?: number;
};

type RepoSearchResult = {
  id: string;
  name: string;
  path: string;
  workspaceID: string;
  matchedFields: string[];
};

type WorkspaceSearchArgs = {
  query: string;
  limit?: number;
};

type WorkspaceSearchResult = {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  matchedFields: string[];
};

const DEFAULT_REPO_SEARCH_LIMIT = 10;
const MAX_REPO_SEARCH_LIMIT = 50;

function boundedSearchLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_REPO_SEARCH_LIMIT;
  }
  return Math.max(1, Math.min(MAX_REPO_SEARCH_LIMIT, Math.trunc(limit)));
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
    "find_workspace",
    "Search known workspaces by name or root path and return matching workspace IDs",
    {
      query: z.string().describe("Case-insensitive search text"),
      limit: z.number().optional().describe("Max results to return, capped at 50"),
    },
    async (args: WorkspaceSearchArgs) => {
      const needle = args.query.trim().toLowerCase();
      if (!needle) return textResult({ query: args.query, matches: [] });

      const limit = boundedSearchLimit(args.limit);
      const matches: WorkspaceSearchResult[] = appController.state.workspaces
        .map((workspace) => {
          const matchedFields: string[] = [];
          if (workspace.name.toLowerCase().includes(needle)) matchedFields.push("name");
          if (workspace.rootPath.toLowerCase().includes(needle)) matchedFields.push("rootPath");

          return {
            id: workspace.id,
            name: workspace.name,
            rootPath: workspace.rootPath,
            createdAt: workspace.createdAt,
            matchedFields,
          };
        })
        .filter((workspace) => workspace.matchedFields.length > 0)
        .sort((left, right) => {
          const leftNameMatch = left.matchedFields.includes("name") ? 0 : 1;
          const rightNameMatch = right.matchedFields.includes("name") ? 0 : 1;
          return leftNameMatch - rightNameMatch || left.name.localeCompare(right.name);
        })
        .slice(0, limit);

      return textResult({ query: args.query, limit, matches });
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
    "find_repo",
    "Search known repos by name or path and return matching repo IDs",
    {
      query: z.string().describe("Case-insensitive search text"),
      workspaceId: z.string().optional().describe("Optional workspace ID to limit results"),
      limit: z.number().optional().describe("Max results to return, capped at 50"),
    },
    async (args: RepoSearchArgs) => {
      const needle = args.query.trim().toLowerCase();
      if (!needle) return textResult({ query: args.query, matches: [] });

      const limit = boundedSearchLimit(args.limit);
      const matches: RepoSearchResult[] = appController.state.repos
        .filter((repo) => !args.workspaceId || repo.workspaceID === args.workspaceId)
        .map((repo) => {
          const matchedFields: string[] = [];
          if (repo.name.toLowerCase().includes(needle)) matchedFields.push("name");
          if (repo.path.toLowerCase().includes(needle)) matchedFields.push("path");

          return {
            id: repo.id,
            name: repo.name,
            path: repo.path,
            workspaceID: repo.workspaceID,
            matchedFields,
          };
        })
        .filter((repo) => repo.matchedFields.length > 0)
        .sort((left, right) => {
          const leftNameMatch = left.matchedFields.includes("name") ? 0 : 1;
          const rightNameMatch = right.matchedFields.includes("name") ? 0 : 1;
          return leftNameMatch - rightNameMatch || left.name.localeCompare(right.name);
        })
        .slice(0, limit);

      return textResult({ query: args.query, limit, matches });
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
