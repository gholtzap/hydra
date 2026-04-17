/**
 * MCP tool registry. Registers all tool categories on the MCP server.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppControllerHandle } from "../internal-api";
import { register as registerSessionTools } from "./session-tools";
import { register as registerWorkspaceTools } from "./workspace-tools";
import { register as registerAgentTools } from "./agent-tools";
import { register as registerSettingsTools } from "./settings-tools";
import { register as registerWikiTools } from "./wiki-tools";
import { register as registerMarketplaceTools } from "./marketplace-tools";
import { register as registerMonitoringTools } from "./monitoring-tools";

export function registerAllTools(server: McpServer, appController: AppControllerHandle): void {
  registerSessionTools(server, appController);
  registerWorkspaceTools(server, appController);
  registerAgentTools(server, appController);
  registerSettingsTools(server, appController);
  registerWikiTools(server, appController);
  registerMarketplaceTools(server, appController);
  registerMonitoringTools(server, appController);
}
