/**
 * MCP tools for wiki management.
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
    "get_wiki",
    "Get wiki tree and status for a repo",
    {
      repoId: z.string().describe("Repo ID"),
    },
    async (args: McpActionArgs<"get_wiki">) => {
      const result = await appController.handleMcpAction("get_wiki", args);
      return textResult(result);
    }
  );

  server.tool(
    "read_wiki_page",
    "Read a wiki markdown page",
    {
      repoId: z.string().describe("Repo ID"),
      path: z.string().describe("Relative path to wiki page"),
    },
    async (args: McpActionArgs<"read_wiki_page">) => {
      const result = await appController.handleMcpAction("read_wiki_page", args);
      return textResult(result);
    }
  );

  server.tool(
    "toggle_wiki",
    "Enable or disable wiki for a repo",
    {
      repoId: z.string().describe("Repo ID"),
      enabled: z.boolean().describe("Enable or disable wiki"),
    },
    async (args: McpActionArgs<"toggle_wiki">) => {
      const result = await appController.handleMcpAction("toggle_wiki", args);
      return textResult(result ?? { ok: true });
    }
  );
}
