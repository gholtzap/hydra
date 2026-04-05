const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const DEFAULT_PREFERENCES = {
  claudeExecutablePath: "/opt/homebrew/bin/claude",
  shellExecutablePath: process.env.SHELL || "/bin/zsh",
  notificationsEnabled: true,
  showInAppBadges: true,
  showNativeNotifications: true
};

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
  const preferences = {
    ...DEFAULT_PREFERENCES,
    ...(snapshot.preferences || {})
  };

  const sessions = Array.isArray(snapshot.sessions)
    ? snapshot.sessions.map((session) => ({
        initialPrompt: "",
        launchesClaudeOnStart: true,
        claudeSessionId: null,
        rawTranscript: "",
        transcript: "",
        unreadCount: 0,
        launchCount: 0,
        blocker: null,
        ...session
      }))
    : [];

  return {
    workspaces: Array.isArray(snapshot.workspaces) ? snapshot.workspaces : [],
    repos: Array.isArray(snapshot.repos) ? snapshot.repos : [],
    sessions,
    preferences
  };
}

function normalizeRestoredSessions(sessions) {
  const now = new Date().toISOString();

  for (const session of sessions) {
    if (session.runtimeState === "live") {
      session.runtimeState = "stopped";
      session.stoppedAt = now;
      if (session.status === "running") {
        session.status = "idle";
      }
    }
  }
}

function getStatePath() {
  return path.join(app.getPath("userData"), "state.json");
}

module.exports = {
  DEFAULT_PREFERENCES,
  loadState,
  saveState
};
