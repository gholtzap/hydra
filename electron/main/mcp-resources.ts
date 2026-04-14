import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerResources(server: any, appController: any) {
  // hydra://state — full app state snapshot
  server.registerResource(
    "app-state",
    "hydra://state",
    { title: "App State", description: "Full Hydra app state snapshot", mimeType: "application/json" },
    async (uri: URL) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(appController.snapshot()) }],
    })
  );

  // hydra://sessions — all sessions (without transcripts)
  server.registerResource(
    "sessions-list",
    "hydra://sessions",
    { title: "All Sessions", description: "All sessions without transcript data", mimeType: "application/json" },
    async (uri: URL) => {
      const sessions = appController.state.sessions.map((s: any) => {
        const { transcript, rawTranscript, ...rest } = s;
        return rest;
      });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(sessions) }] };
    }
  );

  // hydra://sessions/{id} — single session with transcript
  server.registerResource(
    "session-detail",
    new ResourceTemplate("hydra://sessions/{id}", {
      list: async () => ({
        resources: appController.state.sessions.map((s: any) => ({
          uri: `hydra://sessions/${s.id}`,
          name: s.title || s.id,
        })),
      }),
    }),
    { title: "Session Detail", description: "Single session with full transcript", mimeType: "application/json" },
    async (uri: URL, { id }: { id: string }) => {
      const session = appController.state.sessions.find((s: any) => s.id === id);
      if (!session) {
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: "Session not found" }) }] };
      }
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(session) }] };
    }
  );

  // hydra://sessions/{id}/transcript — just the transcript text
  server.registerResource(
    "session-transcript",
    new ResourceTemplate("hydra://sessions/{id}/transcript", {
      list: async () => ({
        resources: appController.state.sessions.map((s: any) => ({
          uri: `hydra://sessions/${s.id}/transcript`,
          name: `${s.title || s.id} - Transcript`,
        })),
      }),
    }),
    { title: "Session Transcript", description: "Plain text transcript for a session", mimeType: "text/plain" },
    async (uri: URL, { id }: { id: string }) => {
      const session = appController.state.sessions.find((s: any) => s.id === id);
      if (!session) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "Session not found" }] };
      }
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: session.transcript || "" }] };
    }
  );

  // hydra://repos/{id}/files — file tree placeholder
  server.registerResource(
    "repo-files",
    new ResourceTemplate("hydra://repos/{id}/files", {
      list: async () => ({
        resources: appController.state.repos.map((r: any) => ({
          uri: `hydra://repos/${r.id}/files`,
          name: `${r.name} - Files`,
        })),
      }),
    }),
    { title: "Repo File Tree", description: "File tree for a repository (use list_files tool for full tree)", mimeType: "application/json" },
    async (uri: URL, { id }: { id: string }) => {
      const repo = appController.state.repos.find((r: any) => r.id === id);
      if (!repo) {
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: "Repo not found" }) }] };
      }
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ repoId: id, repoName: repo.name, path: repo.path, description: "Use the list_files tool to retrieve the full file tree." }),
        }],
      };
    }
  );

  // hydra://repos/{id}/wiki — wiki tree for a repo
  server.registerResource(
    "repo-wiki",
    new ResourceTemplate("hydra://repos/{id}/wiki", {
      list: async () => ({
        resources: appController.state.repos.map((r: any) => ({
          uri: `hydra://repos/${r.id}/wiki`,
          name: `${r.name} - Wiki`,
        })),
      }),
    }),
    { title: "Repo Wiki", description: "Wiki tree and content for a repository", mimeType: "application/json" },
    async (uri: URL, { id }: { id: string }) => {
      const result = await appController.handleMcpAction("get_wiki", { repoId: id });
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(result ?? { error: "Wiki not available" }),
        }],
      };
    }
  );

  // hydra://agents — available agent definitions
  server.registerResource(
    "agents",
    "hydra://agents",
    { title: "Agent Definitions", description: "Available AI agent types and their configurations", mimeType: "application/json" },
    async (uri: URL) => {
      // AGENT_DEFINITIONS is loaded in main.ts from state-store; read from require at runtime
      let agents: any[];
      try {
        agents = require("./state-store").AGENT_DEFINITIONS;
      } catch {
        agents = [];
      }
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(agents) }] };
    }
  );

  // hydra://preferences — current preferences
  server.registerResource(
    "preferences",
    "hydra://preferences",
    { title: "Preferences", description: "Current Hydra user preferences", mimeType: "application/json" },
    async (uri: URL) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(appController.state.preferences) }],
    })
  );
}
