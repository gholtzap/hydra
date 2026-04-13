/**
 * MCP tools for agent configuration.
 */

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
];

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function register(server: any, appController: any) {
  // ── list_agents ────────────────────────────────────────────────
  server.tool(
    "list_agents",
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

  // ── set_default_agent ──────────────────────────────────────────
  server.tool(
    "set_default_agent",
    {
      agentId: { type: "string", description: "Agent ID to set as default" },
    },
    async (args: { agentId: string }) => {
      const result = await appController.handleMcpAction("update_preferences", {
        patch: { defaultAgentId: args.agentId },
      });
      return textResult(result ?? { ok: true });
    }
  );

  // ── set_agent_command ──────────────────────────────────────────
  server.tool(
    "set_agent_command",
    {
      agentId: { type: "string", description: "Agent ID" },
      command: { type: "string", description: "CLI command override" },
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
