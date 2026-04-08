const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

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
  { id: "warp", label: "Warp", defaultCommand: "warp" }
];
const DEFAULT_AGENT_ID = "claude";
const LEGACY_CLAUDE_EXECUTABLE_PATH = "/opt/homebrew/bin/claude";
const KNOWN_AGENT_IDS = new Set(AGENT_DEFINITIONS.map((agent) => agent.id));
const DEFAULT_AGENT_COMMANDS = Object.fromEntries(
  AGENT_DEFINITIONS.map((agent) => [agent.id, agent.defaultCommand])
);

const DEFAULT_PREFERENCES = {
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

function loadState() {
  const statePath = getStatePath();

  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const migrated = migrateSnapshot(parsed);
    normalizeRestoredSessions(migrated.sessions);
    return migrated;
  } catch {
    return emptyState();
  }
}

function saveState(state) {
  const statePath = getStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function emptyState() {
  return {
    workspaces: [],
    repos: [],
    sessions: [],
    preferences: { ...DEFAULT_PREFERENCES }
  };
}

function migrateSnapshot(snapshot) {
  const preferences = normalizePreferences({
    ...DEFAULT_PREFERENCES,
    ...(snapshot.preferences || {})
  });

  const sessions = Array.isArray(snapshot.sessions)
    ? snapshot.sessions.map((session) => ({
        initialPrompt: "",
        launchesClaudeOnStart: true,
        startupAgentId: null,
        claudeSessionId: null,
        rawTranscript: "",
        transcript: "",
        unreadCount: 0,
        launchCount: 0,
        blocker: null,
        isPinned: false,
        tagColor: null,
        sessionIconPath: null,
        sessionIconUpdatedAt: null,
        ...session
      }))
    : [];

  return {
    workspaces: Array.isArray(snapshot.workspaces) ? snapshot.workspaces : [],
    repos: normalizeRepos(snapshot.repos),
    sessions,
    preferences
  };
}

function normalizePreferences(preferences) {
  const defaultAgentId = normalizeAgentId(preferences.defaultAgentId);
  const nextAgentCommands = { ...DEFAULT_AGENT_COMMANDS };
  const savedOverrides =
    preferences && typeof preferences.agentCommandOverrides === "object"
      ? preferences.agentCommandOverrides
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
    ...preferences,
    defaultAgentId,
    agentCommandOverrides: nextAgentCommands,
    claudeExecutablePath: nextAgentCommands.claude
  };
}

function normalizeRestoredSessions(sessions) {
  const now = new Date().toISOString();

  for (const session of sessions) {
    const startupAgentId = normalizeAgentId(session.startupAgentId, null);
    session.startupAgentId = startupAgentId || (session.launchesClaudeOnStart ? DEFAULT_AGENT_ID : null);
    session.launchesClaudeOnStart = !!session.startupAgentId;
    session.claudeSessionId =
      session.startupAgentId === DEFAULT_AGENT_ID && typeof session.claudeSessionId === "string"
        ? session.claudeSessionId
        : null;
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

function normalizeRepos(repos) {
  if (!Array.isArray(repos)) {
    return [];
  }

  return repos.map((repo) => ({
    wikiEnabled: false,
    ...repo
  }));
}

function normalizeAgentId(value, fallback = DEFAULT_AGENT_ID) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return KNOWN_AGENT_IDS.has(normalized) ? normalized : fallback;
}

function normalizeAgentCommand(value, agentId) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return DEFAULT_AGENT_COMMANDS[agentId] || "";
  }

  if (agentId === DEFAULT_AGENT_ID && normalized === LEGACY_CLAUDE_EXECUTABLE_PATH && !isExecutableFile(normalized)) {
    return DEFAULT_AGENT_COMMANDS.claude;
  }

  return normalized;
}

function isExecutableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeSessionTagColor(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SESSION_TAG_COLORS.has(normalized) ? normalized : null;
}

function normalizeSessionIconPath(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }

  return fs.existsSync(value) ? value : null;
}

function getStatePath() {
  return path.join(app.getPath("userData"), "state.json");
}

module.exports = {
  AGENT_DEFINITIONS,
  DEFAULT_AGENT_COMMANDS,
  DEFAULT_AGENT_ID,
  DEFAULT_PREFERENCES,
  loadState,
  normalizeAgentId,
  normalizePreferences,
  saveState
};
