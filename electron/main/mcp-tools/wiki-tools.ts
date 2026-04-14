/**
 * MCP tools for wiki management.
 */
import { z } from "zod";

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function register(server: any, appController: any) {
  server.tool(
    "get_wiki",
    "Get wiki tree and status for a repo",
    {
      repoId: z.string().describe("Repo ID"),
    },
    async (args: { repoId: string }) => {
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
    async (args: { repoId: string; path: string }) => {
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
    async (args: { repoId: string; enabled: boolean }) => {
      const result = await appController.handleMcpAction("toggle_wiki", args);
      return textResult(result ?? { ok: true });
    }
  );
}
