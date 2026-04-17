/**
 * MCP tools for skills marketplace.
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
    "get_skill_details",
    "Get skill details from the marketplace",
    {
      owner: z.string().describe("GitHub owner"),
      repo: z.string().describe("GitHub repo name"),
      path: z.string().describe("Path within repo"),
    },
    async (args: McpActionArgs<"get_skill_details">) => {
      const result = await appController.handleMcpAction("get_skill_details", args);
      return textResult(result);
    }
  );

  server.tool(
    "inspect_skill_url",
    "Inspect a GitHub URL for installable skills",
    {
      url: z.string().describe("GitHub URL to inspect"),
    },
    async (args: McpActionArgs<"inspect_skill_url">) => {
      const result = await appController.handleMcpAction("inspect_skill_url", args);
      return textResult(result);
    }
  );

  server.tool(
    "install_skill",
    "Install a skill from the marketplace",
    {
      owner: z.string().describe("GitHub owner"),
      repo: z.string().describe("GitHub repo name"),
      path: z.string().describe("Path within repo"),
      scope: z.enum(["user", "project"]).describe("Install scope: user or project"),
    },
    async (args: McpActionArgs<"install_skill">) => {
      const result = await appController.handleMcpAction("install_skill", args);
      return textResult(result);
    }
  );
}
