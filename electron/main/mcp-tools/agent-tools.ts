/**
 * MCP tools for agent configuration.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AgentDefinition } from "../../shared-types";
import type { AppControllerHandle } from "../internal-api";

const AGENT_DEFINITIONS = [
  { id: "claude", label: "Claude Code", defaultCommand: "claude" },
  { id: "codex", label: "Codex CLI", defaultCommand: "codex" },
  { id: "gemini", label: "Gemini CLI", defaultCommand: "gemini" },
  { id: "aider", label: "Aider", defaultCommand: "aider" },
  { id: "opencode", label: "OpenCode", defaultCommand: "opencode" },
  { id: "goose", label: "Goose", defaultCommand: "goose" },
  { id: "amazon-q", label: "Amazon Q Developer CLI", defaultCommand: "q chat" },
  { id: "github-copilot", label: "GitHub Copilot CLI", defaultCommand: "gh copilot" },
  { id: "junie", label: "Junie CLI", defaultCommand: "junie" },
  { id: "qwen", label: "Qwen Code", defaultCommand: "qwen-code" },
  { id: "amp", label: "Amp", defaultCommand: "amp" },
  { id: "warp", label: "Warp", defaultCommand: "warp" },
] as const satisfies readonly AgentDefinition[];

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function register(server: McpServer, appController: AppControllerHandle): void {
  server.tool(
    "list_agents",
    "List available AI coding agents and their configuration",
    {},
    async () => {
      const prefs = appController.state.preferences;
      const agents = AGENT_DEFINITIONS.map((a) => ({
        ...a,
        isDefault: a.id === prefs.defaultAgentId,
        command: prefs.agentCommandOverrides?.[a.id] ?? a.defaultCommand,
      }));
      return textResult(agents);
    }
  );

  server.tool(
    "set_default_agent",
    "Set the default agent for new sessions",
    {
      agentId: z.string().describe("Agent ID to set as default"),
    },
    async (args: { agentId: string }) => {
      const result = await appController.handleMcpAction("update_preferences", {
        patch: { defaultAgentId: args.agentId },
      });
      return textResult(result ?? { ok: true });
    }
  );

  server.tool(
    "set_agent_command",
    "Override the CLI command for an agent",
    {
      agentId: z.string().describe("Agent ID"),
      command: z.string().describe("CLI command override"),
    },
    async (args: { agentId: string; command: string }) => {
      const currentOverrides = appController.state.preferences.agentCommandOverrides || {};
      const result = await appController.handleMcpAction("update_preferences", {
        patch: {
          agentCommandOverrides: { ...currentOverrides, [args.agentId]: args.command },
        },
      });
      return textResult(result ?? { ok: true });
    }
  );
}
