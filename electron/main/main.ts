import type { BrowserWindow as ElectronBrowserWindow } from "electron";

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  shell
} = require("electron");

const { scanWorkspace } = require("./workspace-scanner");
const { detectSignal, sanitizeVisibleText } = require("./session-signals");
const { TerminalTranscriptBuffer } = require("./terminal-transcript-buffer");
const {
  buildClaudeSettingsContext,
  loadSettingsFile,
  saveSettingsFile
} = require("./claude-settings");
const { inspectTrackedPorts } = require("./port-inspector");
const { queryProjectSessions } = require("./session-search");
const { loadState, saveState } = require("./state-store");
const { resolveKeybindings } = require("./keybindings");
const { PtyHostClient } = require("./pty-host-client");
const {
  disableWiki,
  enableWiki,
  getWikiContext,
  readWikiFile,
  wikiDirectoryPath,
  wikiExists
} = require("./wiki");

app.setName("ClaudeWorkspace");

const FILE_TREE_IGNORED = new Set([
  ".git", "node_modules", "dist", "build", ".next", "__pycache__",
  ".cache", "coverage", ".mypy_cache", ".pytest_cache", ".turbo",
  ".vercel", "out", ".output", ".nuxt", ".svelte-kit", "storybook-static",
  ".parcel-cache", "target", ".gradle", ".idea", ".vscode"
]);

function buildFileTree(rootPath: string, currentPath: string, depth: number): any[] {
  if (depth >= 5) return [];

  let entries: any[];
  try {
    entries = fs.readdirSync(currentPath, { withFileTypes: true });
  } catch {
    return [];
  }

  entries.sort((a: any, b: any) => {
    const aDir = a.isDirectory();
    const bDir = b.isDirectory();
    if (aDir && !bDir) return -1;
    if (!aDir && bDir) return 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });

  const nodes: any[] = [];
  for (const entry of entries.slice(0, 400)) {
    const { name } = entry;
    const fullPath = path.join(currentPath, name);
    const relativePath = path.relative(rootPath, fullPath);

    if (entry.isDirectory()) {
      if (FILE_TREE_IGNORED.has(name)) continue;
      nodes.push({
        type: "directory",
        name,
        path: fullPath,
        relativePath,
        children: buildFileTree(rootPath, fullPath, depth + 1)
      });
    } else if (entry.isFile()) {
      nodes.push({ type: "file", name, path: fullPath, relativePath });
    }
  }

  return nodes;
}

class AppController {
  state: any;
  window: ElectronBrowserWindow | null;
  focusedSessionId: string | null;
  saveTimer: NodeJS.Timeout | null;
  allowQuit: boolean;
  pendingClaudeLaunch: Set<string>;
  pendingClaudeLaunchTimers: Map<string, NodeJS.Timeout>;
  sessionSizes: Map<string, { cols: number; rows: number }>;
  terminalBuffers: Map<string, any>;
  signalBuffers: Map<string, string>;
  blockerClearStreaks: Map<string, number>;
  ptyHost: any;
  ephemeralSessions: Map<string, { repoId: string; kind: "lazygit" | "tokscale" }>;
  lazygitPath: string | null;
  npxPath: string | null;

  constructor() {
    this.state = loadState();
    this.window = null;
    this.focusedSessionId = null;
    this.saveTimer = null;
    this.allowQuit = false;
    this.pendingClaudeLaunch = new Set();
    this.pendingClaudeLaunchTimers = new Map();
    this.sessionSizes = new Map();
    this.terminalBuffers = new Map();
    this.signalBuffers = new Map();
    this.blockerClearStreaks = new Map();
    this.ephemeralSessions = new Map();
    this.lazygitPath = resolveCommandPath("lazygit");
    this.npxPath = resolveCommandPath(process.platform === "win32" ? "npx.cmd" : "npx");
    this.normalizeFolderRepos();
    this.repairStoredTranscripts();
    this.ptyHost = new PtyHostClient();
    this.ptyHost.onMessage((message) => this.handlePtyMessage(message));
  }

  createWindow() {
    this.window = new BrowserWindow({
      width: 1500,
      height: 960,
      minWidth: 1100,
      minHeight: 720,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#2b2b2b" : "#ede6dc",
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
    ipcMain.handle("session:rename", (_event, payload) =>
      this.renameSession(payload.sessionId, payload.title)
    );
    ipcMain.handle("session:reopen", (_event, sessionId) => this.reopenSession(sessionId));
    ipcMain.handle("session:close", (_event, sessionId) => this.closeSession(sessionId));
    ipcMain.handle("session:input", (_event, payload) => {
      this.handleSessionInput(payload.sessionId, payload.data);
    });
    ipcMain.handle("session:binaryInput", (_event, payload) => {
      this.ptyHost.sendInput(payload.sessionId, payload.data);
    });
    ipcMain.handle("session:resize", (_event, payload) =>
      this.handleSessionResize(payload.sessionId, payload.cols, payload.rows)
    );
    ipcMain.handle("session:focus", (_event, sessionId) => this.setFocusedSession(sessionId));
    ipcMain.handle("repo:reveal", (_event, repoId) => this.revealRepo(repoId));
    ipcMain.handle("repo:contextMenu", (_event, payload) =>
      this.showRepoContextMenu(payload.repoId, payload.position)
    );
    ipcMain.handle("clipboard:readText", () => clipboard.readText());
    ipcMain.handle("clipboard:writeText", (_event, text) => {
      clipboard.writeText(text || "");
      return true;
    });
    ipcMain.handle("path:reveal", (_event, filePath) => shell.showItemInFolder(filePath));
    ipcMain.handle("session:nextUnread", () => this.nextUnreadSession());
    ipcMain.handle("preferences:update", (_event, patch) => this.updatePreferences(patch));
    ipcMain.handle("status:ports", () => inspectTrackedPorts());
    ipcMain.handle("settings:context", (_event, repoId) =>
      buildClaudeSettingsContext(this.repoById(repoId) || null)
    );
    ipcMain.handle("settings:loadFile", (_event, filePath) => loadSettingsFile(filePath));
    ipcMain.handle("settings:saveFile", (_event, payload) => {
      saveSettingsFile(payload.filePath, payload.contents);
      return true;
    });
    ipcMain.handle("wiki:getContext", (_event, repoId) => this.projectWikiContext(repoId));
    ipcMain.handle("wiki:readFile", (_event, payload) =>
      this.projectWikiFile(payload.repoId, payload.relativePath)
    );
    ipcMain.handle("wiki:toggle", (_event, payload) =>
      this.toggleProjectWiki(payload.repoId, payload.enabled)
    );
    ipcMain.handle("wiki:reveal", (_event, repoId) => this.revealProjectWiki(repoId));
    ipcMain.handle("sessionSearch:query", (_event, payload) =>
      this.querySessionFiles(payload.repoId, payload.query)
    );
    ipcMain.handle("session:resumeFromClaude", (_event, payload) =>
      this.resumeFromClaudeSession(payload.repoId, payload.claudeSessionId)
    );
    ipcMain.handle("fs:readDir", (_event, repoId) => {
      const repo = this.repoById(repoId);
      if (!repo) return null;
      return { path: repo.path, tree: buildFileTree(repo.path, repo.path, 0) };
    });
    ipcMain.handle("lazygit:launch", (_event, p) => this.createLazygitSession(p.repoId));
    ipcMain.handle("lazygit:close", (_event, p) => this.closeLazygitSession(p.sessionId));
    ipcMain.handle("lazygit:input", (_event, p) => {
      if (this.ephemeralSessions.has(p.sessionId)) this.ptyHost.sendInput(p.sessionId, p.data);
    });
    ipcMain.handle("lazygit:binaryInput", (_event, p) => {
      if (this.ephemeralSessions.has(p.sessionId)) this.ptyHost.sendInput(p.sessionId, p.data);
    });
    ipcMain.handle("lazygit:resize", (_event, p) => {
      if (this.ephemeralSessions.has(p.sessionId))
        this.ptyHost.resizeSession(p.sessionId, p.cols, p.rows);
    });
    ipcMain.handle("tokscale:launch", (_event, p) => this.createTokscaleSession(p.repoId));
    ipcMain.handle("tokscale:close", (_event, p) => this.closeTokscaleSession(p.sessionId));
    ipcMain.handle("tokscale:input", (_event, p) => {
      if (this.ephemeralSessions.has(p.sessionId)) this.ptyHost.sendInput(p.sessionId, p.data);
    });
    ipcMain.handle("tokscale:binaryInput", (_event, p) => {
      if (this.ephemeralSessions.has(p.sessionId)) this.ptyHost.sendInput(p.sessionId, p.data);
    });
    ipcMain.handle("tokscale:resize", (_event, p) => {
      if (this.ephemeralSessions.has(p.sessionId))
        this.ptyHost.resizeSession(p.sessionId, p.cols, p.rows);
    });
    ipcMain.handle("fs:readFile", (_event, filePath) => {
      try {
        const buf = fs.readFileSync(filePath);
        if (buf.byteLength > 512 * 1024) {
          return { content: null, tooLarge: true, size: buf.byteLength };
        }
        return { content: buf.toString("utf-8"), tooLarge: false };
      } catch (error: any) {
        return { content: null, error: error?.message || "Failed to read file" };
      }
    });
  }

  setupMenu() {
    const kb = resolveKeybindings(this.state.preferences.keybindings);
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
            label: "Open Folder",
            accelerator: kb["open-folder"],
            click: () => this.openWorkspaceFolder()
          },
          {
            label: "Create Folder",
            accelerator: kb["create-folder"],
            click: () => this.createProjectFolder()
          },
          {
            label: "New Session",
            accelerator: kb["new-session"],
            click: () => this.sendCommand("new-session")
          },
          {
            type: "separator"
          },
          {
            label: "New Session (Cmd+N)",
            accelerator: kb["new-session-alt"],
            click: () => this.sendCommand("new-session")
          }
        ]
      },
      {
        label: "Wiki",
        submenu: [
          {
            label: "Open Wiki",
            accelerator: kb["open-wiki"],
            click: () => this.sendCommand("open-wiki")
          },
          {
            label: "Initialize Wiki",
            click: () => this.sendCommand("initialize-wiki")
          },
          {
            label: "Refresh Wiki",
            click: () => this.sendCommand("refresh-wiki")
          },
          {
            label: "Lint Wiki",
            click: () => this.sendCommand("lint-wiki")
          },
          {
            label: "Ask Wiki",
            click: () => this.sendCommand("ask-wiki")
          },
          {
            label: "Reveal .wiki",
            click: () => this.sendCommand("reveal-wiki")
          }
        ]
      },
      {
        label: "Navigate",
        submenu: [
          {
            label: "Quick Switcher",
            accelerator: kb["quick-switcher"],
            click: () => this.sendCommand("quick-switcher")
          },
          {
            label: "Search Session Files",
            accelerator: "CmdOrCtrl+F",
            click: () => this.sendCommand("search-session-files")
          },
          {
            label: "Command Palette",
            accelerator: kb["command-palette"],
            click: () => this.sendCommand("command-palette")
          },
          {
            label: "Next Unread Session",
            accelerator: kb["next-unread"],
            click: () => this.sendCommand("next-unread")
          },
          {
            label: "Open Lazygit",
            accelerator: kb["open-lazygit"],
            click: () => this.sendCommand("open-lazygit")
          },
          {
            label: "Open Token Usage",
            accelerator: kb["open-tokscale"],
            click: () => this.sendCommand("open-tokscale")
          }
        ]
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" }
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
      lazygitInstalled: this.lazygitPath !== null,
      workspaces: [...this.state.workspaces].sort((left, right) =>
        left.name.localeCompare(right.name)
      ),
      repos: [...this.state.repos]
        .map((repo) => ({
          ...repo,
          wikiExists: wikiExists(repo.path),
          wikiPath: wikiDirectoryPath(repo.path)
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
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

  sendCommand(command, payload = {}) {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    this.window.webContents.send("app:command", { command, ...payload });
  }

  sendLazygitOutput(sessionId, data) {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("lazygit:output", { sessionId, data });
  }

  sendLazygitExit(sessionId) {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("lazygit:exit", { sessionId });
  }

  sendTokscaleOutput(sessionId, data) {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("tokscale:output", { sessionId, data });
  }

  sendTokscaleExit(sessionId) {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("tokscale:exit", { sessionId });
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
      buttonLabel: "Open Folder"
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
    const existingByPath = new Map<string, any>(
      this.state.repos.map((repo) => [repo.path, repo])
    );
    const mergedRepos = scannedRepos.map((repo) => {
      const existing = existingByPath.get(repo.path);
      return existing
        ? {
            ...repo,
            ...existing,
            name: repo.name,
            path: repo.path,
            workspaceID: repo.workspaceID,
            wikiEnabled: existing.wikiEnabled ?? repo.wikiEnabled
          }
        : repo;
    });
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

    const sessionId = randomUUID();
    const session = {
      id: sessionId,
      repoID: repoId,
      title: repo.name,
      initialPrompt: "",
      launchesClaudeOnStart: launchesClaudeOnStart !== false,
      claudeSessionId: launchesClaudeOnStart !== false ? sessionId : null,
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
    this.terminalBuffers.set(session.id, new TerminalTranscriptBuffer(session.transcript));
    this.launchRuntime(session, repo);
    this.scheduleSave();
    this.broadcastState();
    return session.id;
  }

  renameSession(sessionId, title) {
    const session = this.sessionById(sessionId);
    if (!session) {
      return false;
    }

    const nextTitle = typeof title === "string" ? title.trim() : "";
    if (!nextTitle || nextTitle === session.title) {
      return false;
    }

    session.title = nextTitle;
    session.updatedAt = now();
    this.scheduleSave();
    this.broadcastState();
    return true;
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
    const bannerChunk = `\r\n${banner}\r\n`;
    session.rawTranscript = trimRawTranscript(`${session.rawTranscript || ""}${bannerChunk}`);
    session.transcript = trimTranscript(this.terminalBuffer(session.id, session.transcript).consume(bannerChunk));
    this.resetSignalTracking(session.id);

    this.launchRuntime(session, repo);
    this.scheduleSave();
    this.broadcastState();
  }

  closeSession(sessionId) {
    this.cancelPendingClaudeLaunch(sessionId);
    this.sessionSizes.delete(sessionId);
    this.terminalBuffers.delete(sessionId);
    this.resetSignalTracking(sessionId);
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

  showRepoContextMenu(repoId, position) {
    const repo = this.repoById(repoId);
    if (!repo || !this.window || this.window.isDestroyed()) {
      return;
    }

    const menu = Menu.buildFromTemplate([
      {
        label: "Start Claude Code Session",
        click: () => this.sendCommand("new-session", { repoId })
      },
      {
        label: "Open Wiki",
        click: () => this.sendCommand("open-wiki", { repoId })
      },
      {
        label: repo.wikiEnabled ? "Disable Wiki" : "Enable Wiki",
        click: () => this.sendCommand("toggle-wiki", { repoId })
      },
      {
        label: "Reveal Folder",
        click: () => this.revealRepo(repoId)
      },
      {
        label: "Reveal .wiki",
        click: () => this.sendCommand("reveal-wiki", { repoId })
      }
    ]);

    menu.popup({
      window: this.window,
      x: Number.isFinite(position?.x) ? position.x : undefined,
      y: Number.isFinite(position?.y) ? position.y : undefined
    });
  }

  nextUnreadSession() {
    const next = this.inboxSessions()[0];
    return next ? next.id : null;
  }

  querySessionFiles(repoId, query) {
    const repo = this.repoById(repoId);
    if (!repo) {
      return {
        ok: false,
        error: "Select a project before searching session files.",
        installCommand: "brew install fzf ripgrep",
        missingTools: []
      };
    }

    const response = queryProjectSessions(repo.path, query);
    if (!response?.ok) {
      return response;
    }

    return {
      ...response,
      results: response.results.map((result) => ({
        ...result,
        hydraSessionId: this.findHydraSessionIdForSearchResult(repo.id, result.sessionId)
      }))
    };
  }

  resumeFromClaudeSession(repoId, claudeSessionId) {
    const repo = this.repoById(repoId);
    if (!repo || !claudeSessionId) {
      return null;
    }

    const sessionId = randomUUID();
    const session = {
      id: sessionId,
      repoID: repoId,
      title: repo.name,
      initialPrompt: "",
      launchesClaudeOnStart: true,
      claudeSessionId,
      status: "running",
      runtimeState: "live",
      blocker: null,
      unreadCount: 0,
      createdAt: now(),
      updatedAt: now(),
      lastActivityAt: null,
      stoppedAt: null,
      launchCount: 2,
      transcript: "",
      rawTranscript: ""
    };

    this.state.sessions.unshift(session);
    this.terminalBuffers.set(session.id, new TerminalTranscriptBuffer(session.transcript));
    this.launchRuntime(session, repo);
    this.scheduleSave();
    this.broadcastState();
    return session.id;
  }

  normalizeFolderRepos() {
    const reposByWorkspaceId = new Map();

    for (const repo of this.state.repos) {
      if (!reposByWorkspaceId.has(repo.workspaceID)) {
        reposByWorkspaceId.set(repo.workspaceID, []);
      }

      reposByWorkspaceId.get(repo.workspaceID).push({
        wikiEnabled: false,
        ...repo
      });
    }

    const normalizedRepos = [];

    for (const workspace of this.state.workspaces) {
      const workspaceRepos = reposByWorkspaceId.get(workspace.id) || [];
      const rootRepo =
        workspaceRepos.find((repo) => path.resolve(repo.path) === path.resolve(workspace.rootPath)) ||
        workspaceRepos[0] ||
        {
          id: randomUUID(),
          workspaceID: workspace.id,
          name: path.basename(workspace.rootPath) || workspace.rootPath,
          path: path.resolve(workspace.rootPath),
          wikiEnabled: false,
          discoveredAt: now()
        };

      const normalizedRepo = {
        ...rootRepo,
        workspaceID: workspace.id,
        name: path.basename(workspace.rootPath) || workspace.rootPath,
        path: path.resolve(workspace.rootPath),
        wikiEnabled: rootRepo.wikiEnabled ?? false
      };

      for (const repo of workspaceRepos) {
        if (repo.id === normalizedRepo.id) {
          continue;
        }

        for (const session of this.state.sessions) {
          if (session.repoID === repo.id) {
            session.repoID = normalizedRepo.id;
          }
        }
      }

      normalizedRepos.push(normalizedRepo);
    }

    this.state.repos = normalizedRepos;
  }

  updatePreferences(patch) {
    this.state.preferences = {
      ...this.state.preferences,
      ...patch
    };

    if (patch.keybindings) {
      this.setupMenu();
    }

    this.scheduleSave();
    this.broadcastState();
  }

  findHydraSessionIdForSearchResult(repoId, externalSessionId) {
    if (!externalSessionId) {
      return null;
    }

    const match = this.state.sessions.find((session) =>
      session.repoID === repoId &&
      (session.id === externalSessionId || session.claudeSessionId === externalSessionId)
    );

    return match ? match.id : null;
  }

  launchRuntime(session, repo) {
    this.cancelPendingClaudeLaunch(session.id);
    this.ptyHost.createSession({
      sessionId: session.id,
      cwd: repo.path,
      shellPath: resolvedShellPath(this.state.preferences)
    });
  }

  createLazygitSession(repoId) {
    const repo = this.repoById(repoId);
    if (!repo || !this.lazygitPath) return null;
    const sessionId = randomUUID();
    this.ephemeralSessions.set(sessionId, { repoId, kind: "lazygit" });
    this.ptyHost.createSession({
      sessionId,
      cwd: repo.path,
      command: [this.lazygitPath]
    });
    return sessionId;
  }

  closeLazygitSession(sessionId) {
    if (!this.ephemeralSessions.has(sessionId)) return;
    this.ephemeralSessions.delete(sessionId);
    this.ptyHost.killSession(sessionId);
  }

  createTokscaleSession(repoId) {
    const repo = this.repoById(repoId);
    if (!repo || !this.npxPath) return null;
    const sessionId = randomUUID();
    this.ephemeralSessions.set(sessionId, { repoId, kind: "tokscale" });
    this.ptyHost.createSession({
      sessionId,
      cwd: repo.path,
      command: [this.npxPath, "--yes", "tokscale@latest"]
    });
    return sessionId;
  }

  closeTokscaleSession(sessionId) {
    if (!this.ephemeralSessions.has(sessionId)) return;
    this.ephemeralSessions.delete(sessionId);
    this.ptyHost.killSession(sessionId);
  }

  handleSessionInput(sessionId, data) {
    this.ptyHost.sendInput(sessionId, data);
    this.resolveInteractiveBlockerFromInput(sessionId, data);
  }

  handlePtyMessage(message) {
    const ephemeralSession = this.ephemeralSessions.get(message.sessionId);
    if (ephemeralSession) {
      if (message.type === "data") {
        if (ephemeralSession.kind === "lazygit") {
          this.sendLazygitOutput(message.sessionId, message.data);
        } else {
          this.sendTokscaleOutput(message.sessionId, message.data);
        }
      } else if (message.type === "exit") {
        this.ephemeralSessions.delete(message.sessionId);
        if (ephemeralSession.kind === "lazygit") {
          this.sendLazygitExit(message.sessionId);
        } else {
          this.sendTokscaleExit(message.sessionId);
        }
      }
      return;
    }
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
    const signalContext = this.appendSignalBuffer(sessionId, visibleChunk);
    const buffer = this.terminalBuffer(session.id, session.transcript);
    session.rawTranscript = trimRawTranscript(`${session.rawTranscript || ""}${rawChunk}`);
    session.transcript = trimTranscript(buffer.consume(rawChunk));

    session.updatedAt = now();
    session.lastActivityAt = now();

    if (this.focusedSessionId !== sessionId) {
      session.unreadCount += 1;
    }

    const signal = detectSignal(signalContext);
    const previousBlockerKey = blockerKey(session.blocker);

    if (signal) {
      session.status = signal.status;
      session.blocker = signal.blocker;
      this.signalBuffers.delete(sessionId);
      this.blockerClearStreaks.delete(sessionId);
    } else if (session.blocker && hasMeaningfulVisibleOutput(visibleChunk)) {
      const streak = (this.blockerClearStreaks.get(sessionId) || 0) + 1;
      this.blockerClearStreaks.set(sessionId, streak);

      if (streak >= blockerClearThreshold(session.blocker.kind)) {
        session.blocker = null;
        if (session.runtimeState === "live") {
          session.status = "running";
        }
        this.resetSignalTracking(sessionId);
      }
    } else if (!session.blocker) {
      session.status = "running";
      this.blockerClearStreaks.delete(sessionId);
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
    this.resetSignalTracking(sessionId);
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

  terminalBuffer(sessionId, seedText = "") {
    let buffer = this.terminalBuffers.get(sessionId);

    if (!buffer) {
      buffer = new TerminalTranscriptBuffer(seedText || "");
      this.terminalBuffers.set(sessionId, buffer);
    }

    return buffer;
  }

  repairStoredTranscripts() {
    let changed = false;

    for (const session of this.state.sessions) {
      const transcript = rebuildTranscript(session);
      this.terminalBuffers.set(session.id, new TerminalTranscriptBuffer(transcript));

      if ((session.transcript || "") !== transcript) {
        session.transcript = transcript;
        changed = true;
      }
    }

    if (changed) {
      this.scheduleSave();
    }
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

  appendSignalBuffer(sessionId, visibleChunk) {
    const next = `${this.signalBuffers.get(sessionId) || ""}${visibleChunk || ""}`;
    const trimmed = next.length > 1600 ? next.slice(-1600) : next;
    this.signalBuffers.set(sessionId, trimmed);
    return trimmed;
  }

  resolveInteractiveBlockerFromInput(sessionId, data) {
    if (!/[\r\n]/.test(data || "")) {
      return;
    }

    const session = this.sessionById(sessionId);
    if (!session?.blocker || !interactiveBlockerKinds().has(session.blocker.kind)) {
      return;
    }

    session.blocker = null;
    if (session.runtimeState === "live") {
      session.status = "running";
    }
    session.updatedAt = now();
    this.resetSignalTracking(sessionId);
    this.scheduleSave();
    this.sendSessionUpdated(sessionId);
  }

  resetSignalTracking(sessionId) {
    this.signalBuffers.delete(sessionId);
    this.blockerClearStreaks.delete(sessionId);
  }

  repoById(repoId) {
    return this.state.repos.find((repo) => repo.id === repoId) || null;
  }

  projectWikiContext(repoId) {
    const repo = this.repoById(repoId);
    if (!repo) {
      return null;
    }

    return getWikiContext(repo.path, repo.wikiEnabled);
  }

  projectWikiFile(repoId, relativePath) {
    const repo = this.repoById(repoId);
    if (!repo) {
      throw new Error("Folder not found.");
    }

    return readWikiFile(repo.path, relativePath);
  }

  toggleProjectWiki(repoId, enabled) {
    const repo = this.repoById(repoId);
    if (!repo) {
      return null;
    }

    if (enabled) {
      enableWiki(repo.path);
    } else {
      disableWiki(repo.path);
    }

    repo.wikiEnabled = enabled;
    repo.updatedAt = now();
    this.scheduleSave();
    this.broadcastState();
    return this.projectWikiContext(repoId);
  }

  revealProjectWiki(repoId) {
    const repo = this.repoById(repoId);
    if (!repo) {
      return;
    }

    const targetPath = wikiExists(repo.path) ? wikiDirectoryPath(repo.path) : repo.path;
    shell.showItemInFolder(targetPath);
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
      this.ptyHost.sendInput(
        sessionId,
        `${resolvedClaudeCommand(this.state.preferences, currentSession)}\r`
      );
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
    claudeSessionId: session.claudeSessionId,
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

function rebuildTranscript(session) {
  if (session.rawTranscript) {
    return trimTranscript(TerminalTranscriptBuffer.visibleText(session.rawTranscript));
  }

  return trimTranscript(session.transcript || "");
}

function resolvedShellPath(preferences) {
  const candidate = preferences.shellExecutablePath?.trim();
  return candidate || process.env.SHELL || "/bin/zsh";
}

function resolveCommandPath(command) {
  // Electron doesn't inherit the user's shell PATH, so `which` may miss
  // binaries installed via Homebrew or other package managers.
  // Try `which` first, then check well-known paths directly.
  try {
    return execSync(`which ${command}`, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" }).trim();
  } catch {
    // which failed — check well-known paths directly
  }
  const searchPaths = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    path.join(process.env.HOME || "", ".local/bin")
  ];
  for (const dir of searchPaths) {
    const fullPath = path.join(dir, command);
    try {
      fs.accessSync(fullPath, fs.constants.X_OK);
      return fullPath;
    } catch {
      continue;
    }
  }
  return null;
}

function resolvedClaudeCommand(preferences, session) {
  const executable = shellEscape(preferences.claudeExecutablePath?.trim() || "claude");
  if (!session?.launchesClaudeOnStart) {
    return executable;
  }

  if (session.launchCount > 1) {
    if (session.claudeSessionId) {
      return `${executable} --resume ${shellEscape(session.claudeSessionId)}`;
    }

    return `${executable} --continue`;
  }

  if (session.claudeSessionId) {
    return `${executable} --session-id ${shellEscape(session.claudeSessionId)}`;
  }

  return executable;
}

function shellEscape(value) {
  return `'${String(value || "").replace(/'/g, `'\\''`)}'`;
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

function hasMeaningfulVisibleOutput(chunk) {
  return /\S/.test(chunk || "");
}

function blockerClearThreshold(kind) {
  switch (kind) {
    case "approval":
    case "question":
      return 4;
    case "crashed":
      return Number.POSITIVE_INFINITY;
    default:
      return 2;
  }
}

function interactiveBlockerKinds() {
  return new Set(["approval", "question"]);
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
