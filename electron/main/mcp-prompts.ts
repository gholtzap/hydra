import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AgentDefinition, RepoRecord, SessionRecord } from "../shared-types";
import type { AppControllerHandle } from "./internal-api";

export function registerPrompts(server: McpServer, appController: AppControllerHandle): void {
  // review_blockers — list all blocked sessions with blocker details
  server.registerPrompt(
    "review_blockers",
    {
      title: "Review Blockers",
      description: "Review all blocked sessions and suggest actions to unblock them",
    },
    async () => {
      const blocked = appController.state.sessions.filter(
        (session) => session.status === "blocked" || session.status === "needs_input"
      );

      let promptText: string;
      if (blocked.length === 0) {
        promptText = "There are currently no blocked sessions in Hydra. All sessions are running smoothly.";
      } else {
        const lines = blocked.map((session, index) => {
          const blocker = session.blocker
            ? `[${session.blocker.kind}] ${session.blocker.summary} (since ${session.blocker.detectedAt})`
            : `Status: ${session.status}`;
          return `${index + 1}. Session "${session.title}" (id: ${session.id}, repo: ${session.repoID})\n   ${blocker}`;
        });
        promptText =
          `The following ${blocked.length} session(s) in Hydra are currently blocked and need attention:\n\n` +
          lines.join("\n\n") +
          "\n\nPlease review each blocker and suggest what action to take (approve, deny, provide input, or investigate).";
      }

      return {
        messages: [{ role: "user" as const, content: { type: "text" as const, text: promptText } }],
      };
    }
  );

  // session_summary — summarize a specific session's transcript
  server.registerPrompt(
    "session_summary",
    {
      title: "Session Summary",
      description: "Summarize what happened in a specific session",
      argsSchema: {
        sessionId: z.string().describe("The session ID to summarize"),
      },
    },
    async ({ sessionId }: { sessionId: string }) => {
      const session = appController.state.sessions.find((candidate) => candidate.id === sessionId);

      if (!session) {
        return {
          messages: [{ role: "user" as const, content: { type: "text" as const, text: `Session with ID "${sessionId}" was not found.` } }],
        };
      }

      const transcript = session.transcript || "(no transcript available)";
      const promptText =
        `Please summarize the following coding agent session.\n\n` +
        `Session: "${session.title}" (id: ${session.id})\n` +
        `Agent: ${session.startupAgentId || "unknown"}\n` +
        `Status: ${session.status}\n` +
        `Repo: ${session.repoID}\n` +
        `Created: ${session.createdAt}\n` +
        `Last Activity: ${session.lastActivityAt || "N/A"}\n\n` +
        `--- Transcript ---\n${transcript}\n--- End Transcript ---\n\n` +
        `Provide a concise summary of what was accomplished, any issues encountered, and the current state.`;

      return {
        messages: [{ role: "user" as const, content: { type: "text" as const, text: promptText } }],
      };
    }
  );

  // project_status — overview of all active sessions across repos
  server.registerPrompt(
    "project_status",
    {
      title: "Project Status",
      description: "Overview of all active work across repos",
      argsSchema: {
        repoId: z.string().optional().describe("Optional repo ID to filter by"),
      },
    },
    async ({ repoId }: { repoId?: string }) => {
      const repos: RepoRecord[] = appController.state.repos;
      const sessions: SessionRecord[] = appController.state.sessions;

      const filteredRepos = repoId ? repos.filter((repo) => repo.id === repoId) : repos;
      const repoIds = new Set(filteredRepos.map((repo) => repo.id));

      const repoSections = filteredRepos.map((repo) => {
        const repoSessions = sessions.filter((session) => session.repoID === repo.id);
        if (repoSessions.length === 0) {
          return `## ${repo.name} (${repo.path})\nNo sessions.`;
        }
        const sessionLines = repoSessions.map((session) => {
          const blockerInfo = session.blocker ? ` | BLOCKED: [${session.blocker.kind}] ${session.blocker.summary}` : "";
          return `- "${session.title}" — ${session.status} (agent: ${session.startupAgentId || "unknown"})${blockerInfo}`;
        });
        const running = repoSessions.filter((session) => session.status === "running").length;
        const blocked = repoSessions.filter(
          (session) => session.status === "blocked" || session.status === "needs_input"
        ).length;
        return (
          `## ${repo.name} (${repo.path})\n` +
          `${repoSessions.length} session(s): ${running} running, ${blocked} blocked\n` +
          sessionLines.join("\n")
        );
      });

      // Include orphan sessions (sessions whose repoID doesn't match filtered repos, only when not filtering)
      const orphanSessions = repoId
        ? []
        : sessions.filter((session) => !repoIds.has(session.repoID));

      if (orphanSessions.length > 0) {
        const orphanLines = orphanSessions.map(
          (session) => `- "${session.title}" (repo: ${session.repoID}) — ${session.status}`
        );
        repoSections.push(`## Unmatched Sessions\n${orphanLines.join("\n")}`);
      }

      const totalSessions = sessions.length;
      const totalBlocked = sessions.filter(
        (session) => session.status === "blocked" || session.status === "needs_input"
      ).length;

      const promptText =
        `Here is the current project status across Hydra.\n\n` +
        `Total: ${totalSessions} session(s), ${totalBlocked} blocked.\n\n` +
        repoSections.join("\n\n") +
        `\n\nPlease provide a high-level summary of the current state of work and flag any items that need attention.`;

      return {
        messages: [{ role: "user" as const, content: { type: "text" as const, text: promptText } }],
      };
    }
  );

  // agent_recommendation — suggest which agent to use for a task
  server.registerPrompt(
    "agent_recommendation",
    {
      title: "Agent Recommendation",
      description: "Recommend which AI coding agent to use for a given task",
      argsSchema: {
        taskDescription: z.string().describe("Description of the task you want to accomplish"),
      },
    },
    async ({ taskDescription }: { taskDescription: string }) => {
      let agents: AgentDefinition[] = [];
      try {
        ({ AGENT_DEFINITIONS: agents } = require("./state-store") as {
          AGENT_DEFINITIONS: AgentDefinition[];
        });
      } catch {
        agents = [];
      }

      const prefs = appController.state.preferences;
      const agentList = agents
        .map((agent) => {
          const override = prefs.agentCommandOverrides?.[agent.id];
          const cmd = override || agent.defaultCommand;
          const isDefault = agent.id === prefs.defaultAgentId ? " (current default)" : "";
          return `- ${agent.label} (id: ${agent.id}, command: ${cmd})${isDefault}`;
        })
        .join("\n");

      const promptText =
        `I need to choose an AI coding agent for the following task:\n\n` +
        `"${taskDescription}"\n\n` +
        `Available agents in Hydra:\n${agentList}\n\n` +
        `Based on the task description and the available agents, which agent would you recommend and why?`;

      return {
        messages: [{ role: "user" as const, content: { type: "text" as const, text: promptText } }],
      };
    }
  );
}
