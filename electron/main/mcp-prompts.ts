import { z } from "zod";

export function registerPrompts(server: any, appController: any) {
  // review_blockers — list all blocked sessions with blocker details
  server.registerPrompt(
    "review_blockers",
    {
      title: "Review Blockers",
      description: "Review all blocked sessions and suggest actions to unblock them",
    },
    async () => {
      const blocked = appController.state.sessions.filter(
        (s: any) => s.status === "blocked" || s.status === "needs_input"
      );

      let promptText: string;
      if (blocked.length === 0) {
        promptText = "There are currently no blocked sessions in Hydra. All sessions are running smoothly.";
      } else {
        const lines = blocked.map((s: any, i: number) => {
          const blocker = s.blocker
            ? `[${s.blocker.kind}] ${s.blocker.summary} (since ${s.blocker.detectedAt})`
            : `Status: ${s.status}`;
          return `${i + 1}. Session "${s.title}" (id: ${s.id}, repo: ${s.repoID})\n   ${blocker}`;
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
      argsSchema: z.object({
        sessionId: z.string().describe("The session ID to summarize"),
      }),
    },
    async ({ sessionId }: { sessionId: string }) => {
      const session = appController.state.sessions.find((s: any) => s.id === sessionId);

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
      argsSchema: z.object({
        repoId: z.string().optional().describe("Optional repo ID to filter by"),
      }),
    },
    async ({ repoId }: { repoId?: string }) => {
      const repos: any[] = appController.state.repos;
      const sessions: any[] = appController.state.sessions;

      const filteredRepos = repoId ? repos.filter((r: any) => r.id === repoId) : repos;
      const repoIds = new Set(filteredRepos.map((r: any) => r.id));

      const repoSections = filteredRepos.map((repo: any) => {
        const repoSessions = sessions.filter((s: any) => s.repoID === repo.id);
        if (repoSessions.length === 0) {
          return `## ${repo.name} (${repo.path})\nNo sessions.`;
        }
        const sessionLines = repoSessions.map((s: any) => {
          const blockerInfo = s.blocker ? ` | BLOCKED: [${s.blocker.kind}] ${s.blocker.summary}` : "";
          return `- "${s.title}" — ${s.status} (agent: ${s.startupAgentId || "unknown"})${blockerInfo}`;
        });
        const running = repoSessions.filter((s: any) => s.status === "running").length;
        const blocked = repoSessions.filter((s: any) => s.status === "blocked" || s.status === "needs_input").length;
        return (
          `## ${repo.name} (${repo.path})\n` +
          `${repoSessions.length} session(s): ${running} running, ${blocked} blocked\n` +
          sessionLines.join("\n")
        );
      });

      // Include orphan sessions (sessions whose repoID doesn't match filtered repos, only when not filtering)
      const orphanSessions = repoId
        ? []
        : sessions.filter((s: any) => !repoIds.has(s.repoID));

      if (orphanSessions.length > 0) {
        const orphanLines = orphanSessions.map(
          (s: any) => `- "${s.title}" (repo: ${s.repoID}) — ${s.status}`
        );
        repoSections.push(`## Unmatched Sessions\n${orphanLines.join("\n")}`);
      }

      const totalSessions = sessions.length;
      const totalBlocked = sessions.filter((s: any) => s.status === "blocked" || s.status === "needs_input").length;

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
      argsSchema: z.object({
        taskDescription: z.string().describe("Description of the task you want to accomplish"),
      }),
    },
    async ({ taskDescription }: { taskDescription: string }) => {
      let agents: any[];
      try {
        agents = require("./state-store").AGENT_DEFINITIONS;
      } catch {
        agents = [];
      }

      const prefs = appController.state.preferences;
      const agentList = agents
        .map((a: any) => {
          const override = prefs.agentCommandOverrides?.[a.id];
          const cmd = override || a.defaultCommand;
          const isDefault = a.id === prefs.defaultAgentId ? " (current default)" : "";
          return `- ${a.label} (id: ${a.id}, command: ${cmd})${isDefault}`;
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
