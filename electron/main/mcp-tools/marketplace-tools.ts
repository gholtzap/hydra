/**
 * MCP tools for skills marketplace.
 */
import { z } from "zod";

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function register(server: any, appController: any) {
  server.tool(
    "get_skill_details",
    "Get skill details from the marketplace",
    {
      owner: z.string().describe("GitHub owner"),
      repo: z.string().describe("GitHub repo name"),
      path: z.string().describe("Path within repo"),
    },
    async (args: { owner: string; repo: string; path: string }) => {
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
    async (args: { url: string }) => {
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
      scope: z.string().describe("Install scope: user or project"),
    },
    async (args: { owner: string; repo: string; path: string; scope: string }) => {
      const result = await appController.handleMcpAction("install_skill", args);
      return textResult(result);
    }
  );
}
