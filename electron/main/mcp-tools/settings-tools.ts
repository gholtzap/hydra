/**
 * MCP tools for preferences and settings management.
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
    "get_preferences",
    "Get all user preferences",
    {},
    async () => {
      return textResult(appController.state.preferences);
    }
  );

  server.tool(
    "update_preferences",
    "Update user preferences",
    {
      patch: z.record(z.string(), z.unknown()).describe("Partial preferences object to merge"),
    },
    async (args: McpActionArgs<"update_preferences">) => {
      const result = await appController.handleMcpAction("update_preferences", args);
      return textResult(result ?? { ok: true });
    }
  );

  server.tool(
    "get_settings_context",
    "Get Claude settings context for a repo",
    {
      repoId: z.string().describe("Repo ID"),
    },
    async (args: McpActionArgs<"get_settings_context">) => {
      const result = await appController.handleMcpAction("get_settings_context", args);
      return textResult(result);
    }
  );

  server.tool(
    "load_settings_file",
    "Read a settings file (CLAUDE.md, AGENTS.md, etc.)",
    {
      repoId: z.string().describe("Repo ID"),
      filePath: z.string().describe("Settings file path"),
    },
    async (args: McpActionArgs<"load_settings_file">) => {
      const result = await appController.handleMcpAction("load_settings_file", args);
      return textResult(result);
    }
  );

  server.tool(
    "save_settings_file",
    "Write a settings file",
    {
      repoId: z.string().describe("Repo ID"),
      filePath: z.string().describe("Settings file path"),
      content: z.string().describe("File content to write"),
    },
    async (args: McpActionArgs<"save_settings_file">) => {
      const result = await appController.handleMcpAction("save_settings_file", args);
      return textResult(result ?? { ok: true });
    }
  );
}
