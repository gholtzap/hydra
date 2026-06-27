/**
 * MCP tools for agent configuration.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AgentDefinition } from "../../shared-types";
import type { AppControllerHandle } from "../internal-api";
import { textResult } from "./result";

const { AGENT_DEFINITIONS } = require("../state-store") as {
  AGENT_DEFINITIONS: AgentDefinition[];
};

export function register(server: McpServer, appController: AppControllerHandle): void {
  server.tool(
    "list_agents",
    "List available AI coding agents and their configuration",
    {},
    async () => {
      const prefs = appController.state.preferences;
      return textResult(AGENT_DEFINITIONS.map((a) => ({
        ...a,
        isDefault: a.id === prefs.defaultAgentId,
        isHandoffDefault: a.id === prefs.handoffAgentId,
        command: prefs.agentCommandOverrides?.[a.id] ?? a.defaultCommand,
      })));
    }
  );

  server.tool(
    "set_handoff_agent",
    "Set the default agent used when a terminal session continues after another agent exits",
    {
      agentId: z.string().describe("Agent ID to use for continue handoffs"),
    },
    async (args: { agentId: string }) => {
      return textResult(
        (await appController.handleMcpAction("update_preferences", {
          patch: { handoffAgentId: args.agentId },
        })) ?? { ok: true }
      );
    }
  );

  server.tool(
    "set_default_agent",
    "Set the default agent for new sessions",
    {
      agentId: z.string().describe("Agent ID to set as default"),
    },
    async (args: { agentId: string }) => {
      return textResult(
        (await appController.handleMcpAction("update_preferences", {
          patch: { defaultAgentId: args.agentId },
        })) ?? { ok: true }
      );
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
      return textResult(
        (await appController.handleMcpAction("update_preferences", {
          patch: {
            agentCommandOverrides: { ...currentOverrides, [args.agentId]: args.command },
          },
        })) ?? { ok: true }
      );
    }
  );
}
