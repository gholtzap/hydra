import type {
  AgentDefinition,
  AgentId,
  AppPreferences,
  RepoRecord,
  SessionRecord,
  SessionTagColor,
  StoredAppState
} from "../shared-types";

const fs = require("node:fs");
const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
const path = require("node:path");
const { app } = require("electron");
const { isExecutableFile } = require("./command-path") as {
  isExecutableFile: (filePath: string) => boolean;
};

const AGENT_DEFINITIONS: AgentDefinition[] = [
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
  { id: "warp", label: "Warp", defaultCommand: "warp" }
];
const DEFAULT_AGENT_ID: AgentId = "claude";
const LEGACY_CLAUDE_EXECUTABLE_PATH = "/opt/homebrew/bin/claude";
const KNOWN_AGENT_IDS = new Set(AGENT_DEFINITIONS.map((agent) => agent.id));
const DEFAULT_AGENT_COMMANDS: Record<AgentId, string> = Object.fromEntries(
  AGENT_DEFINITIONS.map((agent) => [agent.id, agent.defaultCommand])
) as Record<AgentId, string>;

const DEFAULT_PREFERENCES: AppPreferences = {
  defaultAgentId: DEFAULT_AGENT_ID,
  agentCommandOverrides: { ...DEFAULT_AGENT_COMMANDS },
  claudeExecutablePath: DEFAULT_AGENT_COMMANDS.claude,
  shellExecutablePath: process.env.SHELL || "/bin/zsh",
  notificationsEnabled: true,
  showInAppBadges: true,
  showNativeNotifications: true,
  sessionWorkspaceLayout: null,
  keybindings: {},
  themeAppearance: "system",
  themeActiveId: "workspace-default",
  themeCustomThemes: []
};
const SESSION_TAG_COLORS = new Set([
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "gray"
]);

async function loadState(): Promise<StoredAppState> {
  const statePath = getStatePath();

  try {
    const parsed = JSON.parse(await fsp.readFile(statePath, "utf8")) as unknown;
    const migrated = migrateSnapshot(parsed);
    normalizeRestoredSessions(migrated.sessions);
    return migrated;
  } catch {
    return emptyState();
  }
}

async function saveState(state: StoredAppState): Promise<void> {
  const statePath = getStatePath();
  const serializedState = JSON.stringify(state, null, 2);
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  await fsp.writeFile(statePath, serializedState, "utf8");
}

function emptyState(): StoredAppState {
  return {
    workspaces: [],
    repos: [],
    sessions: [],
    preferences: { ...DEFAULT_PREFERENCES }
  };
}

function migrateSnapshot(snapshot: unknown): StoredAppState {
  const safeSnapshot = isPlainObject(snapshot) ? snapshot : {};
  const preferences = normalizePreferences({
    ...DEFAULT_PREFERENCES,
    ...(isPlainObject(safeSnapshot.preferences) ? safeSnapshot.preferences : {})
  });

  const sessions = Array.isArray(safeSnapshot.sessions)
    ? safeSnapshot.sessions.map((session) => ({
        initialPrompt: "",
        launchesClaudeOnStart: true,
        startupAgentId: null,
        claudeSessionId: null,
        agentSessionId: null,
        rawTranscript: "",
        transcript: "",
        unreadCount: 0,
        launchCount: 0,
        blocker: null,
        isPinned: false,
        tagColor: null,
        sessionIconPath: null,
        sessionIconUpdatedAt: null,
        ...(isPlainObject(session) ? session : {})
      })) as SessionRecord[]
    : [];

  return {
    workspaces: Array.isArray(safeSnapshot.workspaces)
      ? safeSnapshot.workspaces as StoredAppState["workspaces"]
      : [],
    repos: normalizeRepos(safeSnapshot.repos),
    sessions,
    preferences
  };
}

function normalizePreferences(preferences: Record<string, unknown>): AppPreferences {
  const defaultAgentId = normalizeAgentId(preferences.defaultAgentId);
  const nextAgentCommands: Record<AgentId, string> = { ...DEFAULT_AGENT_COMMANDS };
  const savedOverrides: Record<string, unknown> =
    preferences && typeof preferences.agentCommandOverrides === "object"
      ? preferences.agentCommandOverrides as Record<string, unknown>
      : {};

  for (const agent of AGENT_DEFINITIONS) {
    const savedValue =
      Object.prototype.hasOwnProperty.call(savedOverrides, agent.id)
        ? savedOverrides[agent.id]
        : agent.id === DEFAULT_AGENT_ID
          ? preferences.claudeExecutablePath
          : undefined;

    nextAgentCommands[agent.id] = normalizeAgentCommand(savedValue, agent.id);
  }

  return {
    ...DEFAULT_PREFERENCES,
    ...preferences,
    defaultAgentId: defaultAgentId || DEFAULT_AGENT_ID,
    agentCommandOverrides: nextAgentCommands,
    claudeExecutablePath: nextAgentCommands.claude
  };
}

function normalizeRestoredSessions(sessions: SessionRecord[]): void {
  const now = new Date().toISOString();

  for (const session of sessions) {
    const startupAgentId = normalizeAgentId(session.startupAgentId, null);
    session.startupAgentId = startupAgentId || (session.launchesClaudeOnStart ? DEFAULT_AGENT_ID : null);
    session.launchesClaudeOnStart = !!session.startupAgentId;
    session.claudeSessionId =
      session.startupAgentId === DEFAULT_AGENT_ID && typeof session.claudeSessionId === "string"
        ? session.claudeSessionId
        : null;
    session.agentSessionId =
      typeof session.agentSessionId === "string" && session.agentSessionId
        ? session.agentSessionId
        : session.claudeSessionId;
    session.isPinned = !!session.isPinned;
    session.tagColor = normalizeSessionTagColor(session.tagColor);
    session.sessionIconPath = normalizeSessionIconPath(session.sessionIconPath);
    session.sessionIconUpdatedAt =
      typeof session.sessionIconUpdatedAt === "string" && session.sessionIconUpdatedAt
        ? session.sessionIconUpdatedAt
        : null;

    if (session.runtimeState === "live") {
      session.runtimeState = "stopped";
      session.stoppedAt = now;
      if (session.status === "running") {
        session.status = "idle";
      }
    }
  }
}

function normalizeRepos(repos: unknown): RepoRecord[] {
  if (!Array.isArray(repos)) {
    return [];
  }

  return repos.map((repo) => ({
    wikiEnabled: false,
    ...(isPlainObject(repo) ? repo : {})
  })) as RepoRecord[];
}

function normalizeAgentId(value: unknown, fallback: AgentId | null = DEFAULT_AGENT_ID): AgentId | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return KNOWN_AGENT_IDS.has(normalized as AgentId) ? normalized as AgentId : fallback;
}

function normalizeAgentCommand(value: unknown, agentId: AgentId): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return DEFAULT_AGENT_COMMANDS[agentId] || "";
  }

  if (agentId === DEFAULT_AGENT_ID && normalized === LEGACY_CLAUDE_EXECUTABLE_PATH && !isExecutableFile(normalized)) {
    return DEFAULT_AGENT_COMMANDS.claude;
  }

  return normalized;
}

function normalizeSessionTagColor(value: unknown): SessionTagColor | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SESSION_TAG_COLORS.has(normalized) ? normalized as SessionTagColor : null;
}

function normalizeSessionIconPath(value: unknown): string | null {
  if (typeof value !== "string" || !value) {
    return null;
  }

  return fs.existsSync(value) ? value : null;
}

function getStatePath(): string {
  return path.join(app.getPath("userData"), "state.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  AGENT_DEFINITIONS,
  DEFAULT_AGENT_COMMANDS,
  DEFAULT_AGENT_ID,
  DEFAULT_PREFERENCES,
  emptyState,
  loadState,
  normalizeAgentId,
  normalizePreferences,
  saveState
};
