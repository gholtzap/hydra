const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  dialog,
  ipcMain,
  shell
} = require("electron");

const { scanWorkspace } = require("./workspace-scanner");
const { detectSignal, sanitizeVisibleText } = require("./session-signals");
const {
  buildClaudeSettingsContext,
  loadSettingsFile,
  saveSettingsFile
} = require("./claude-settings");
const { loadState, saveState } = require("./state-store");
const { PtyHostClient } = require("./pty-host-client");

app.setName("ClaudeWorkspace");

class AppController {
  constructor() {
    this.state = loadState();
    this.window = null;
    this.focusedSessionId = null;
    this.saveTimer = null;
    this.allowQuit = false;
    this.pendingClaudeLaunch = new Set();
    this.pendingClaudeLaunchTimers = new Map();
    this.sessionSizes = new Map();
    this.ptyHost = new PtyHostClient();
    this.ptyHost.onMessage((message) => this.handlePtyMessage(message));
  }

  createWindow() {
    this.window = new BrowserWindow({
      width: 1500,
      height: 960,
      minWidth: 1100,
      minHeight: 720,
      backgroundColor: "#11161d",
      title: "Claude Workspace",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "preload.js")
      }
    });

    this.window.on("closed", () => {
      this.window = null;
    });

    this.window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }

  setupIpc() {
    ipcMain.handle("state:get", () => this.snapshot());
    ipcMain.handle("workspace:open", async () => this.openWorkspaceFolder());
    ipcMain.handle("project:create", async () => this.createProjectFolder());
    ipcMain.handle("workspace:rescan", (_event, workspaceId) => this.rescanWorkspace(workspaceId));
    ipcMain.handle("session:create", (_event, payload) =>
      this.createSession(payload.repoId, payload.launchesClaudeOnStart)
    );
    ipcMain.handle("session:reopen", (_event, sessionId) => this.reopenSession(sessionId));
    ipcMain.handle("session:close", (_event, sessionId) => this.closeSession(sessionId));
    ipcMain.handle("session:input", (_event, payload) => {
      this.ptyHost.sendInput(payload.sessionId, payload.data);
    });
    ipcMain.handle("session:binaryInput", (_event, payload) => {
      this.ptyHost.sendInput(payload.sessionId, payload.data);
    });
    ipcMain.handle("session:resize", (_event, payload) =>
      this.handleSessionResize(payload.sessionId, payload.cols, payload.rows)
    );
    ipcMain.handle("session:focus", (_event, sessionId) => this.setFocusedSession(sessionId));
    ipcMain.handle("repo:reveal", (_event, repoId) => this.revealRepo(repoId));
    ipcMain.handle("path:reveal", (_event, filePath) => shell.showItemInFolder(filePath));
    ipcMain.handle("session:nextUnread", () => this.nextUnreadSession());
    ipcMain.handle("preferences:update", (_event, patch) => this.updatePreferences(patch));
    ipcMain.handle("settings:context", (_event, repoId) =>
      buildClaudeSettingsContext(this.repoById(repoId) || null)
    );
    ipcMain.handle("settings:loadFile", (_event, filePath) => loadSettingsFile(filePath));
    ipcMain.handle("settings:saveFile", (_event, payload) => {
      saveSettingsFile(payload.filePath, payload.contents);
      return true;
    });
  }

  setupMenu() {
    const template = [
      {
        label: "Claude Workspace",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "quit" }
        ]
      },
      {
        label: "File",
        submenu: [
          {
            label: "Open Workspace",
            accelerator: "CmdOrCtrl+O",
            click: () => this.openWorkspaceFolder()
          },
          {
            label: "Create Project Folder",
            accelerator: "CmdOrCtrl+Shift+N",
            click: () => this.createProjectFolder()
          },
          {
            label: "New Session",
            accelerator: "CmdOrCtrl+N",
            click: () => this.sendCommand("new-session")
          }
        ]
      },
      {
        label: "Navigate",
        submenu: [
          {
            label: "Quick Switcher",
            accelerator: "CmdOrCtrl+K",
            click: () => this.sendCommand("quick-switcher")
          },
          {
            label: "Command Palette",
            accelerator: "CmdOrCtrl+Shift+P",
            click: () => this.sendCommand("command-palette")
          },
          {
            label: "Next Unread Session",
            accelerator: "CmdOrCtrl+]",
            click: () => this.sendCommand("next-unread")
          }
        ]
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" }
        ]
      }
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  snapshot() {
    return structuredClone({
      ...this.state,
      workspaces: [...this.state.workspaces].sort((left, right) =>
        left.name.localeCompare(right.name)
      ),
      repos: [...this.state.repos].sort((left, right) => left.name.localeCompare(right.name)),
      sessions: [...this.state.sessions].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt)
      )
    });
  }

  broadcastState() {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    this.window.webContents.send("state:changed", this.snapshot());
  }

  sendSessionUpdated(sessionId) {
    const session = this.sessionById(sessionId);
    if (!this.window || this.window.isDestroyed() || !session) {
      return;
    }

    this.window.webContents.send("session:updated", {
      session: summarizeSession(session)
    });
  }

  sendSessionOutput(sessionId, data) {
    const session = this.sessionById(sessionId);
    if (!this.window || this.window.isDestroyed() || !session) {
      return;
    }

    this.window.webContents.send("session:output", {
      sessionId,
      data,
      session: summarizeSession(session)
    });
  }

  sendCommand(command) {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    this.window.webContents.send("app:command", { command });
  }

  scheduleSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      saveState(this.state);
    }, 200);
  }

  persistNow() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    saveState(this.state);
  }

  async openWorkspaceFolder() {
    const result = await dialog.showOpenDialog(this.window, {
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Open Workspace"
    });

    if (result.canceled || result.filePaths.length === 0) {
      return;
    }

    this.addWorkspace(result.filePaths[0]);
  }

  async createProjectFolder() {
    const result = await dialog.showSaveDialog(this.window, {
      title: "Create Empty Project Folder",
      buttonLabel: "Create Folder",
      nameFieldLabel: "Folder Name",
      defaultPath: "New Project"
    });

    if (result.canceled || !result.filePath) {
      return;
    }

    fs.mkdirSync(result.filePath, { recursive: true });
    this.addWorkspace(result.filePath);
  }

  addWorkspace(rootPath) {
    const normalizedPath = path.resolve(rootPath);
    const existing = this.state.workspaces.find((workspace) => workspace.rootPath === normalizedPath);

    if (existing) {
      this.rescanWorkspace(existing.id);
      return;
    }

    const workspace = {
      id: randomUUID(),
      name: path.basename(normalizedPath) || normalizedPath,
      rootPath: normalizedPath,
      createdAt: now()
    };

    this.state.workspaces.push(workspace);
    this.rescanWorkspace(workspace.id);
  }

  rescanWorkspace(workspaceId) {
    const workspace = this.state.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) {
      return;
    }

    const scannedRepos = scanWorkspace(workspace.rootPath, workspaceId);
    const existingByPath = new Map(this.state.repos.map((repo) => [repo.path, repo]));
    const mergedRepos = scannedRepos.map((repo) => existingByPath.get(repo.path) || repo);
    const otherRepos = this.state.repos.filter((repo) => repo.workspaceID !== workspaceId);

    this.state.repos = [...otherRepos, ...mergedRepos];
    this.scheduleSave();
    this.broadcastState();
  }

  createSession(repoId, launchesClaudeOnStart) {
    const repo = this.repoById(repoId);
    if (!repo) {
      return null;
    }

    const count = this.state.sessions.filter((session) => session.repoID === repoId).length + 1;
    const session = {
      id: randomUUID(),
      repoID: repoId,
      title: `${launchesClaudeOnStart ? "Claude" : "Shell"} ${count}`,
      initialPrompt: "",
      launchesClaudeOnStart: launchesClaudeOnStart !== false,
      status: "running",
      runtimeState: "live",
      blocker: null,
      unreadCount: 0,
      createdAt: now(),
      updatedAt: now(),
      lastActivityAt: null,
      stoppedAt: null,
      launchCount: 1,
      transcript: "",
      rawTranscript: ""
    };

    this.state.sessions.unshift(session);
    this.launchRuntime(session, repo);
    this.scheduleSave();
    this.broadcastState();
    return session.id;
  }

  reopenSession(sessionId) {
    const session = this.sessionById(sessionId);
    const repo = session ? this.repoById(session.repoID) : null;
    if (!session || !repo) {
      return;
    }

    session.runtimeState = "live";
    session.status = "running";
    session.blocker = null;
    session.stoppedAt = null;
    session.launchCount += 1;
    session.updatedAt = now();

    const banner = `[Session reopened ${timestampLabel()}]`;
    session.transcript += `\n\n${banner}\n\n`;
    session.rawTranscript = trimRawTranscript(`${session.rawTranscript || ""}\r\n${banner}\r\n`);

    this.launchRuntime(session, repo);
    this.scheduleSave();
    this.broadcastState();
  }

  closeSession(sessionId) {
    this.cancelPendingClaudeLaunch(sessionId);
    this.sessionSizes.delete(sessionId);
    this.ptyHost.killSession(sessionId);
    this.focusedSessionId = this.focusedSessionId === sessionId ? null : this.focusedSessionId;
    this.state.sessions = this.state.sessions.filter((session) => session.id !== sessionId);
    this.scheduleSave();
    this.broadcastState();
  }

  setFocusedSession(sessionId) {
    this.focusedSessionId = sessionId || null;

    if (sessionId) {
      const session = this.sessionById(sessionId);
      if (session && session.unreadCount > 0) {
        session.unreadCount = 0;
        session.updatedAt = now();
        this.scheduleSave();
        this.sendSessionUpdated(sessionId);
      }
    }
  }

  revealRepo(repoId) {
    const repo = this.repoById(repoId);
    if (!repo) {
      return;
    }

    shell.showItemInFolder(repo.path);
  }

  nextUnreadSession() {
    const next = this.inboxSessions()[0];
    return next ? next.id : null;
  }

  updatePreferences(patch) {
    this.state.preferences = {
      ...this.state.preferences,
      ...patch
    };

    this.scheduleSave();
    this.broadcastState();
  }

  launchRuntime(session, repo) {
    this.cancelPendingClaudeLaunch(session.id);
    this.ptyHost.createSession({
      sessionId: session.id,
      cwd: repo.path,
      shellPath: resolvedShellPath(this.state.preferences)
    });
  }

  handlePtyMessage(message) {
    switch (message.type) {
      case "created":
        this.handleHostCreated(message.sessionId);
        break;
      case "data":
        this.handleHostData(message.sessionId, message.data);
        break;
      case "exit":
        this.handleHostExit(message.sessionId, message.exitCode);
        break;
      default:
        break;
    }
  }

  handleHostCreated(sessionId) {
    const session = this.sessionById(sessionId);
    if (!session || !session.launchesClaudeOnStart) {
      return;
    }

    this.pendingClaudeLaunch.add(sessionId);
    this.maybeLaunchClaude(sessionId);
  }

  handleHostData(sessionId, rawChunk) {
    const session = this.sessionById(sessionId);
    if (!session) {
      return;
    }

    const visibleChunk = sanitizeVisibleText(rawChunk);
    session.rawTranscript = trimRawTranscript(`${session.rawTranscript || ""}${rawChunk}`);

    if (visibleChunk) {
      session.transcript = trimTranscript(`${session.transcript || ""}${visibleChunk}`);
    }

    session.updatedAt = now();
    session.lastActivityAt = now();

    if (this.focusedSessionId !== sessionId) {
      session.unreadCount += 1;
    }

    const signal = detectSignal(visibleChunk);
    const previousBlockerKey = blockerKey(session.blocker);

    if (signal) {
      session.status = signal.status;
      session.blocker = signal.blocker;
    } else if (!session.blocker) {
      session.status = "running";
    }

    const nextBlockerKey = blockerKey(session.blocker);
    if (
      previousBlockerKey !== nextBlockerKey &&
      session.blocker &&
      this.state.preferences.notificationsEnabled &&
      this.state.preferences.showNativeNotifications
    ) {
      this.notifyBlocker(session);
    }

    this.scheduleSave();
    this.sendSessionOutput(sessionId, rawChunk);
  }

  handleHostExit(sessionId, exitCode) {
    const session = this.sessionById(sessionId);
    if (!session) {
      return;
    }

    this.cancelPendingClaudeLaunch(sessionId);
    this.sessionSizes.delete(sessionId);
    session.runtimeState = "stopped";
    session.stoppedAt = now();
    session.updatedAt = now();

    if (exitCode === 0) {
      if (session.status === "running" || session.status === "idle") {
        session.status = "done";
        session.blocker = null;
      }
    } else {
      session.status = "failed";
      session.blocker = {
        kind: "crashed",
        summary: `The session shell exited with status ${exitCode}.`,
        detectedAt: now()
      };
      this.notifyBlocker(session);
    }

    if (this.focusedSessionId !== sessionId) {
      session.unreadCount += 1;
    }

    this.scheduleSave();
    this.sendSessionUpdated(sessionId);
  }

  notifyBlocker(session) {
    if (!Notification.isSupported()) {
      return;
    }

    const repo = this.repoById(session.repoID);
    const blocker = session.blocker;
    if (!blocker) {
      return;
    }

    const notification = new Notification({
      title: blockerLabel(blocker.kind),
      body: `${repo ? repo.name : session.title}: ${blocker.summary}`,
      silent: false
    });

    notification.show();
  }

  repoById(repoId) {
    return this.state.repos.find((repo) => repo.id === repoId) || null;
  }

  sessionById(sessionId) {
    return this.state.sessions.find((session) => session.id === sessionId) || null;
  }

  inboxSessions() {
    return [...this.state.sessions]
      .filter((session) => session.blocker || session.unreadCount > 0)
      .sort((left, right) => {
        if (!!left.blocker !== !!right.blocker) {
          return left.blocker ? -1 : 1;
        }

        return right.updatedAt.localeCompare(left.updatedAt);
      });
  }

  confirmQuit(event) {
    if (this.allowQuit) {
      return;
    }

    const liveSessions = this.state.sessions.filter((session) => session.runtimeState === "live");
    if (liveSessions.length === 0) {
      this.shutdown();
      return;
    }

    const result = dialog.showMessageBoxSync(this.window, {
      type: "warning",
      buttons: ["Cancel", "Quit and Terminate Sessions"],
      defaultId: 1,
      cancelId: 0,
      title: "Quit Claude Workspace",
      message: `Quitting will terminate ${liveSessions.length} running session${liveSessions.length === 1 ? "" : "s"}.`
    });

    if (result === 0) {
      event.preventDefault();
      return;
    }

    this.shutdown();
  }

  shutdown() {
    this.allowQuit = true;
    for (const session of this.state.sessions) {
      if (session.runtimeState === "live") {
        this.cancelPendingClaudeLaunch(session.id);
        this.sessionSizes.delete(session.id);
        session.runtimeState = "stopped";
        session.stoppedAt = now();
        if (session.status === "running") {
          session.status = "idle";
        }
        this.ptyHost.killSession(session.id);
      }
    }
    this.ptyHost.stop();
    this.persistNow();
  }

  handleSessionResize(sessionId, cols, rows) {
    const safeCols = Math.max(1, Number(cols) || 1);
    const safeRows = Math.max(1, Number(rows) || 1);

    this.sessionSizes.set(sessionId, {
      cols: safeCols,
      rows: safeRows
    });
    this.ptyHost.resizeSession(sessionId, safeCols, safeRows);
    this.maybeLaunchClaude(sessionId);
  }

  maybeLaunchClaude(sessionId) {
    if (!this.pendingClaudeLaunch.has(sessionId) || this.pendingClaudeLaunchTimers.has(sessionId)) {
      return;
    }

    const session = this.sessionById(sessionId);
    const size = this.sessionSizes.get(sessionId);
    if (!session || session.runtimeState !== "live" || !size || size.cols < 2 || size.rows < 2) {
      return;
    }

    const timer = setTimeout(() => {
      this.pendingClaudeLaunchTimers.delete(sessionId);

      const currentSession = this.sessionById(sessionId);
      if (
        !currentSession ||
        currentSession.runtimeState !== "live" ||
        !this.pendingClaudeLaunch.has(sessionId)
      ) {
        return;
      }

      this.pendingClaudeLaunch.delete(sessionId);
      this.ptyHost.sendInput(sessionId, `${resolvedClaudeCommand(this.state.preferences)}\r`);
    }, 120);

    this.pendingClaudeLaunchTimers.set(sessionId, timer);
  }

  cancelPendingClaudeLaunch(sessionId) {
    this.pendingClaudeLaunch.delete(sessionId);

    const timer = this.pendingClaudeLaunchTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.pendingClaudeLaunchTimers.delete(sessionId);
    }
  }
}

function summarizeSession(session) {
  return {
    id: session.id,
    repoID: session.repoID,
    title: session.title,
    initialPrompt: session.initialPrompt,
    launchesClaudeOnStart: session.launchesClaudeOnStart,
    status: session.status,
    runtimeState: session.runtimeState,
    blocker: session.blocker,
    unreadCount: session.unreadCount,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastActivityAt: session.lastActivityAt,
    stoppedAt: session.stoppedAt,
    launchCount: session.launchCount,
    transcript: session.transcript
  };
}

function trimRawTranscript(value) {
  const maxLength = 250000;
  return value.length > maxLength ? value.slice(-maxLength) : value;
}

function trimTranscript(value) {
  const maxLength = 20000;
  return value.length > maxLength ? value.slice(-maxLength) : value;
}

function resolvedShellPath(preferences) {
  const candidate = preferences.shellExecutablePath?.trim();
  return candidate || process.env.SHELL || "/bin/zsh";
}

function resolvedClaudeCommand(preferences) {
  const candidate = preferences.claudeExecutablePath?.trim();
  return candidate || "claude";
}

function blockerKey(blocker) {
  if (!blocker) {
    return "";
  }

  return `${blocker.kind}:${blocker.summary}`;
}

function blockerLabel(kind) {
  switch (kind) {
    case "approval":
      return "Approval";
    case "question":
      return "Question";
    case "toolPermission":
      return "Tool Permission";
    case "gitConflict":
      return "Git Conflict";
    case "crashed":
      return "Crashed";
    case "stuck":
      return "Possibly Stuck";
    default:
      return "Needs Attention";
  }
}

function now() {
  return new Date().toISOString();
}

function timestampLabel() {
  return new Date().toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

const controller = new AppController();

app.whenReady().then(() => {
  controller.setupIpc();
  controller.setupMenu();
  controller.createWindow();
});

app.on("before-quit", (event) => controller.confirmQuit(event));

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    controller.createWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
