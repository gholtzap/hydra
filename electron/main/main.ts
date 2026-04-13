import type { BrowserWindow as ElectronBrowserWindow } from "electron";
import type {
  AgentDefinition,
  AgentId,
  AppCommandPayload,
  AppPreferences,
  AppStateSnapshot,
  ClaudeSettingsContext,
  DirectoryReadResult,
  EphemeralToolExitPayload,
  EphemeralToolId,
  EphemeralToolInputRequest,
  EphemeralToolLaunchRequest,
  EphemeralToolOutputPayload,
  EphemeralToolResizeRequest,
  EphemeralToolSessionRequest,
  FileTreeNode,
  MarketplaceInspectResponse,
  MarketplaceInstallResponse,
  MarketplaceSkillDetails,
  Point,
  PtyCreateSessionPayload,
  PtyHostMessage,
  ReadFileResult,
  RepoAppLaunchConfig,
  RepoRecord,
  SessionBlocker,
  SessionOrganizationPatch,
  SessionRecord,
  SessionSearchSource,
  SessionSearchResponse,
  SessionStatus,
  SessionSummary,
  SessionTagColor,
  StoredAppState,
  TrackedPortStatus,
  WikiContext,
  WikiFileContents
} from "../shared-types";

const fs = require("node:fs");
const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pathToFileURL, URL } = require("node:url");
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

type ClaudeSettingsRepoContext = Pick<RepoRecord, "name" | "path"> | null;
type TerminalTranscriptBufferInstance = {
  consume: (rawText: string) => string;
};
type TerminalTranscriptBufferConstructor = {
  new (seedText?: string, maxLength?: number): TerminalTranscriptBufferInstance;
  visibleText: (rawText: string) => string;
};
type PtyHostClientInstance = {
  onMessage: (listener: (message: PtyHostMessage) => void) => () => void;
  createSession: (payload: PtyCreateSessionPayload) => void;
  sendInput: (sessionId: string, data: string) => void;
  resizeSession: (sessionId: string, cols: number, rows: number) => void;
  killSession: (sessionId: string) => void;
  stop: () => void;
};
type PtyHostClientConstructor = {
  new (): PtyHostClientInstance;
};
type EphemeralSessionRecord = {
  repoId: string;
  toolId: EphemeralToolId;
};
type QueuedSessionLaunch = {
  title?: string;
  input: string;
};

const { scanWorkspace } = require("./workspace-scanner") as {
  scanWorkspace: (rootPath: string, workspaceId: string) => Promise<RepoRecord[]>;
};
const { detectSignal, sanitizeVisibleText } = require("./session-signals") as {
  detectSignal: (chunk: string) => { status: SessionStatus; blocker: SessionBlocker } | null;
  sanitizeVisibleText: (text: string) => string;
};
const { TerminalTranscriptBuffer } = require("./terminal-transcript-buffer") as {
  TerminalTranscriptBuffer: TerminalTranscriptBufferConstructor;
};
const {
  assertEditableClaudeSkillFilePath,
  assertReadableClaudeSettingsFilePath,
  buildClaudeSettingsContext,
  clearSkillIcon,
  importSkillIcon,
  readClaudeSettingsFile,
  writeClaudeSettingsFile
} = require("./claude-settings") as {
  assertEditableClaudeSkillFilePath: (filePath: string, repoPaths?: string[]) => string;
  assertReadableClaudeSettingsFilePath: (filePath: string, repoPaths?: string[]) => string;
  buildClaudeSettingsContext: (repo: ClaudeSettingsRepoContext) => Promise<ClaudeSettingsContext>;
  clearSkillIcon: (skillFilePath: string) => Promise<boolean>;
  importSkillIcon: (skillFilePath: string, sourceFilePath: string) => Promise<string | null>;
  readClaudeSettingsFile: (filePath: string, repoPaths?: string[]) => Promise<string>;
  writeClaudeSettingsFile: (filePath: string, contents: string, repoPaths?: string[]) => Promise<void>;
};
const {
  getMarketplaceSkillDetails,
  inspectMarketplaceGitHubUrl,
  installMarketplaceSkill
} = require("./skills-marketplace") as {
  getMarketplaceSkillDetails: (payload: {
    source: { owner: string; repo: string; ref?: string; path: string; reviewState?: string; tags?: string[] };
  }) => Promise<MarketplaceSkillDetails>;
  inspectMarketplaceGitHubUrl: (payload: { url: string }) => Promise<MarketplaceInspectResponse>;
  installMarketplaceSkill: (payload: {
    source: { owner: string; repo: string; ref?: string; path: string };
    scope: "user" | "project";
    repoPath?: string | null;
  }) => Promise<MarketplaceInstallResponse>;
};
const { inspectTrackedPorts } = require("./port-inspector") as {
  inspectTrackedPorts: () => Promise<TrackedPortStatus>;
};
const { isSessionSearchResultPathForRepo, queryProjectSessions } = require("./session-search") as {
  isSessionSearchResultPathForRepo: (filePath: string, repoPath: string) => Promise<boolean>;
  queryProjectSessions: (repoPath: string, query: string) => Promise<SessionSearchResponse>;
};
const {
  AGENT_DEFINITIONS,
  DEFAULT_AGENT_COMMANDS,
  DEFAULT_AGENT_ID,
  emptyState,
  loadState,
  normalizeAgentId,
  normalizeRepoAppLaunchConfig,
  normalizePreferences,
  saveState
} = require("./state-store") as {
  AGENT_DEFINITIONS: AgentDefinition[];
  DEFAULT_AGENT_COMMANDS: Record<AgentId, string>;
  DEFAULT_AGENT_ID: AgentId;
  emptyState: () => StoredAppState;
  loadState: () => Promise<StoredAppState>;
  normalizeAgentId: (value: unknown, fallback?: AgentId | null) => AgentId | null;
  normalizeRepoAppLaunchConfig: (value: unknown) => RepoAppLaunchConfig | null;
  normalizePreferences: (preferences: Record<string, unknown>) => AppPreferences;
  saveState: (state: StoredAppState) => Promise<void>;
};
const { resolveKeybindings } = require("./keybindings");
const { PtyHostClient } = require("./pty-host-client") as {
  PtyHostClient: PtyHostClientConstructor;
};
const {
  disableWiki,
  enableWiki,
  getWikiContext,
  readWikiFile,
  wikiDirectoryPath,
  wikiExists,
  wikiExistsSync
} = require("./wiki") as {
  disableWiki: (rootPath: string) => Promise<unknown>;
  enableWiki: (rootPath: string) => Promise<unknown>;
  getWikiContext: (rootPath: string, enabled: boolean) => Promise<WikiContext>;
  readWikiFile: (rootPath: string, relativePath: string) => Promise<WikiFileContents>;
  wikiDirectoryPath: (rootPath: string) => string;
  wikiExists: (rootPath: string) => Promise<boolean>;
  wikiExistsSync: (rootPath: string) => boolean;
};
const { resolveCommandPath } = require("./command-path") as {
  resolveCommandPath: (command: string) => Promise<string | null>;
};
const { startMcpServer } = require("./mcp-server") as {
  startMcpServer: (appController: InstanceType<typeof AppController>) => Promise<unknown>;
};

app.setName("ClaudeWorkspace");

const FILE_TREE_IGNORED = new Set([
  ".git", "node_modules", "dist", "build", ".next", "__pycache__",
  ".cache", "coverage", ".mypy_cache", ".pytest_cache", ".turbo",
  ".vercel", "out", ".output", ".nuxt", ".svelte-kit", "storybook-static",
  ".parcel-cache", "target", ".gradle", ".idea", ".vscode"
]);
const SESSION_TAG_COLORS = new Set([
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "gray"
]);
const SESSION_ICON_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);
const AGENT_LABELS: Record<AgentId, string> = Object.fromEntries(
  AGENT_DEFINITIONS.map((agent) => [agent.id, agent.label])
) as Record<AgentId, string>;

function normalizeAbsolutePath(input: unknown, label = "path") {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) {
    throw new Error(`${label} is required.`);
  }

  return path.resolve(value);
}

function isPathWithinRoot(filePath: string, rootPath: string) {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(filePath));
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function assertMarketplaceSourceUrl(input: unknown) {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) {
    throw new Error("URL is required.");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid external URL.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || (hostname !== "github.com" && hostname !== "www.github.com")) {
    throw new Error("Only GitHub HTTPS source URLs may be opened from the renderer.");
  }

  return parsed.toString();
}

async function buildFileTree(rootPath: string, currentPath: string, depth: number): Promise<FileTreeNode[]> {
  if (depth >= 5) {
    return [];
  }

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(currentPath, { withFileTypes: true });
  } catch {
    return [];
  }

  entries.sort((a: import("node:fs").Dirent, b: import("node:fs").Dirent) => {
    const aDir = a.isDirectory();
    const bDir = b.isDirectory();
    if (aDir && !bDir) return -1;
    if (!aDir && bDir) return 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });

  const nodes: FileTreeNode[] = [];
  for (const entry of entries.slice(0, 400)) {
    const { name } = entry;
    const fullPath = path.join(currentPath, name);
    const relativePath = path.relative(rootPath, fullPath);

    if (entry.isDirectory()) {
      if (FILE_TREE_IGNORED.has(name)) {
        continue;
      }

      nodes.push({
        type: "directory",
        name,
        path: fullPath,
        relativePath,
        children: await buildFileTree(rootPath, fullPath, depth + 1)
      });
      continue;
    }

    if (entry.isFile()) {
      nodes.push({ type: "file", name, path: fullPath, relativePath });
    }
  }

  return nodes;
}

class AppController {
  state: StoredAppState;
  window: ElectronBrowserWindow | null;
  focusedSessionId: string | null;
  saveTimer: NodeJS.Timeout | null;
  allowQuit: boolean;
  pendingAgentLaunch: Set<string>;
  pendingAgentLaunchTimers: Map<string, NodeJS.Timeout>;
  sessionSizes: Map<string, { cols: number; rows: number }>;
  terminalBuffers: Map<string, TerminalTranscriptBufferInstance>;
  signalBuffers: Map<string, string>;
  blockerClearStreaks: Map<string, number>;
  queuedSessionLaunches: Map<string, QueuedSessionLaunch>;
  ptyHost: PtyHostClientInstance;
  ephemeralSessions: Map<string, EphemeralSessionRecord>;
  lazygitPath: string | null;
  npxPath: string | null;
  saveChain: Promise<void>;
  knownPlanFiles: Set<string>;
  plansDirWatcher: ReturnType<typeof fs.watch> | null;

  constructor() {
    this.state = emptyState();
    this.window = null;
    this.focusedSessionId = null;
    this.saveTimer = null;
    this.allowQuit = false;
    this.pendingAgentLaunch = new Set();
    this.pendingAgentLaunchTimers = new Map();
    this.sessionSizes = new Map();
    this.terminalBuffers = new Map();
    this.signalBuffers = new Map();
    this.blockerClearStreaks = new Map();
    this.queuedSessionLaunches = new Map();
    this.ephemeralSessions = new Map();
    this.lazygitPath = null;
    this.npxPath = null;
    this.saveChain = Promise.resolve();
    this.knownPlanFiles = new Set();
    this.plansDirWatcher = null;
    this.ptyHost = new PtyHostClient();
    this.ptyHost.onMessage((message) => this.handlePtyMessage(message));
  }

  async initialize() {
    const [state, lazygitPath, npxPath] = await Promise.all([
      loadState(),
      resolveCommandPath("lazygit"),
      resolveCommandPath(process.platform === "win32" ? "npx.cmd" : "npx")
    ]);

    this.state = state;
    this.lazygitPath = lazygitPath;
    this.npxPath = npxPath;
    this.normalizeFolderRepos();
    this.repairStoredTranscripts();
    this.watchPlansDir();
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

    const window = this.window;
    if (!window) {
      return;
    }
    window.on("closed", () => {
      this.window = null;
    });

    window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
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
    ipcMain.handle("session:organize", (_event, payload) =>
      this.updateSessionOrganization(payload.sessionId, payload.patch)
    );
    ipcMain.handle("session:importIcon", async (_event, sessionId) =>
      this.importSessionIcon(sessionId)
    );
    ipcMain.handle("session:clearIcon", (_event, sessionId) =>
      this.clearSessionIcon(sessionId)
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
    ipcMain.handle("path:reveal", (_event, payload) => this.revealTrustedPath(payload || {}));
    ipcMain.handle("path:openExternal", (_event, payload) =>
      this.openTrustedExternalUrl(payload || {})
    );
    ipcMain.handle("session:nextUnread", () => this.nextUnreadSession());
    ipcMain.handle("preferences:update", (_event, patch) => this.updatePreferences(patch));
    ipcMain.handle("repo:updateAppLaunchConfig", (_event, payload) =>
      this.updateRepoAppLaunchConfig(payload?.repoId, payload?.config)
    );
    ipcMain.handle("repo:buildAndRunApp", (_event, repoId) => this.buildAndRunApp(repoId));
    ipcMain.handle("status:ports", () => inspectTrackedPorts());
    ipcMain.handle("settings:context", (_event, repoId) =>
      buildClaudeSettingsContext(this.repoById(repoId) || null)
    );
    ipcMain.handle("settings:loadFile", (_event, payload) =>
      readClaudeSettingsFile(payload?.filePath, this.settingsRepoPaths(payload?.repoId))
    );
    ipcMain.handle("settings:saveFile", async (_event, payload) => {
      await writeClaudeSettingsFile(
        payload?.filePath,
        payload?.contents,
        this.settingsRepoPaths(payload?.repoId)
      );
      return true;
    });
    ipcMain.handle("settings:importSkillIcon", async (_event, payload) => {
      const skillFilePath = assertEditableClaudeSkillFilePath(
        payload?.skillFilePath,
        this.settingsRepoPaths(payload?.repoId)
      );

      const result = await dialog.showOpenDialog(this.window, {
        title: "Choose Skill Icon",
        buttonLabel: "Use Icon",
        properties: ["openFile"],
        filters: [
          {
            name: "Images",
            extensions: ["png", "jpg", "jpeg", "gif", "svg", "webp"]
          }
        ]
      });

      if (result.canceled || !result.filePaths.length) {
        return null;
      }

      return importSkillIcon(skillFilePath, result.filePaths[0]);
    });
    ipcMain.handle("settings:clearSkillIcon", (_event, payload) =>
      clearSkillIcon(
        assertEditableClaudeSkillFilePath(payload?.skillFilePath, this.settingsRepoPaths(payload?.repoId))
      )
    );
    ipcMain.handle("skillsMarketplace:details", (_event, payload) =>
      getMarketplaceSkillDetails(payload || {})
    );
    ipcMain.handle("skillsMarketplace:inspectUrl", (_event, payload) =>
      inspectMarketplaceGitHubUrl(payload || {})
    );
    ipcMain.handle("skillsMarketplace:install", (_event, payload) =>
      installMarketplaceSkill(payload || {})
    );
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
    ipcMain.handle("session:resumeFromSearchResult", (_event, payload) =>
      this.resumeFromSearchResult(payload.repoId, payload.source, payload.sessionId)
    );
    ipcMain.handle("fs:readDir", async (_event, repoId) => {
      const repo = this.repoById(repoId);
      if (!repo) {
        return null;
      }

      return { path: repo.path, tree: await buildFileTree(repo.path, repo.path, 0) };
    });
    ipcMain.handle("ephemeralTool:launch", (_event, payload: EphemeralToolLaunchRequest) =>
      this.createEphemeralToolSession(payload.toolId, payload.repoId)
    );
    ipcMain.handle("ephemeralTool:close", (_event, payload: EphemeralToolSessionRequest) =>
      this.closeEphemeralToolSession(payload.toolId, payload.sessionId)
    );
    ipcMain.handle("ephemeralTool:input", (_event, payload: EphemeralToolInputRequest) =>
      this.handleEphemeralToolInput(payload.toolId, payload.sessionId, payload.data)
    );
    ipcMain.handle("ephemeralTool:binaryInput", (_event, payload: EphemeralToolInputRequest) =>
      this.handleEphemeralToolInput(payload.toolId, payload.sessionId, payload.data)
    );
    ipcMain.handle("ephemeralTool:resize", (_event, payload: EphemeralToolResizeRequest) =>
      this.handleEphemeralToolResize(
        payload.toolId,
        payload.sessionId,
        payload.cols,
        payload.rows
      )
    );
    ipcMain.handle("fs:readFile", async (_event, payload) => {
      try {
        const filePath = this.assertRepoFilePath(payload?.repoId, payload?.filePath);
        const stats = await fsp.stat(filePath);
        if (stats.size > 512 * 1024) {
          return { content: null, tooLarge: true, size: stats.size };
        }

        const buffer = await fsp.readFile(filePath);
        return { content: buffer.toString("utf-8"), tooLarge: false };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Failed to read file";
        return { content: null, error: message };
      }
    });
  }

  settingsRepoPaths(repoId) {
    if (!repoId) {
      return [];
    }

    const repo = this.repoById(repoId);
    return repo?.path ? [repo.path] : [];
  }

  assertRepoFilePath(repoId, filePath) {
    const repo = this.repoById(repoId);
    if (!repo?.path) {
      throw new Error("Project not found.");
    }

    const normalizedRepoPath = path.resolve(repo.path);
    const normalizedFilePath = normalizeAbsolutePath(filePath, "file path");
    if (!isPathWithinRoot(normalizedFilePath, normalizedRepoPath)) {
      throw new Error("File access denied for the requested path.");
    }

    return normalizedFilePath;
  }

  async revealTrustedPath(payload) {
    switch (payload?.scope) {
      case "repo-file":
        return shell.showItemInFolder(this.assertRepoFilePath(payload.repoId, payload.filePath));
      case "settings-file":
        return shell.showItemInFolder(
          assertReadableClaudeSettingsFilePath(payload.filePath, this.settingsRepoPaths(payload.repoId))
        );
      case "session-search-result": {
        const repo = this.repoById(payload.repoId);
        if (
          !repo?.path ||
          !(await isSessionSearchResultPathForRepo(payload.filePath, repo.path))
        ) {
          throw new Error("Session search reveal denied for the requested path.");
        }

        return shell.showItemInFolder(normalizeAbsolutePath(payload.filePath, "file path"));
      }
      default:
        throw new Error("Unsupported reveal request.");
    }
  }

  openTrustedExternalUrl(payload) {
    switch (payload?.scope) {
      case "marketplace-source":
        return shell.openExternal(assertMarketplaceSourceUrl(payload.url));
      default:
        throw new Error("Unsupported external URL request.");
    }
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
          },
          {
            type: "separator"
          },
          {
            label: "Build and Run App",
            accelerator: kb["build-and-run-app"],
            click: () => this.sendCommand("build-and-run-app")
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
            accelerator: kb["search-project-sessions"],
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
          },
          {
            label: "Build and Run App",
            accelerator: kb["build-and-run-app"],
            click: () => this.sendCommand("build-and-run-app")
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
          wikiExists: wikiExistsSync(repo.path),
          wikiPath: wikiDirectoryPath(repo.path)
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      sessions: [...this.state.sessions]
        .sort(compareSessions)
        .map((session) => ({
          ...session,
          isPinned: !!session.isPinned,
          tagColor: normalizeSessionTagColor(session.tagColor),
          sessionIconUrl: sessionIconUrl(session),
          sessionIconUpdatedAt: session.sessionIconUpdatedAt || null
        }))
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

  sendEphemeralToolOutput(payload: EphemeralToolOutputPayload) {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("ephemeralTool:output", payload);
  }

  sendEphemeralToolExit(payload: EphemeralToolExitPayload) {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("ephemeralTool:exit", payload);
  }

  sendPlanDetected(sessionId: string, markdown: string) {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("plan:detected", { sessionId, markdown });
  }

  watchPlansDir() {
    const os = require("node:os");
    const plansDir = path.join(os.homedir(), ".claude", "plans");

    try {
      fs.mkdirSync(plansDir, { recursive: true });
    } catch {}

    try {
      const existing = fs.readdirSync(plansDir);
      for (const f of existing) {
        if (f.endsWith(".md")) this.knownPlanFiles.add(f);
      }
    } catch {}

    try {
      this.plansDirWatcher = fs.watch(plansDir, (_event: string, filename: string | null) => {
        if (!filename || !filename.endsWith(".md")) return;
        if (this.knownPlanFiles.has(filename)) return;
        this.knownPlanFiles.add(filename);

        const sessionId = this.findActiveClaudeSessionId();
        if (!sessionId) return;

        try {
          const markdown = fs.readFileSync(path.join(plansDir, filename), "utf-8");
          if (markdown.trim()) {
            this.sendPlanDetected(sessionId, markdown);
          }
        } catch {}
      });
    } catch {}
  }

  findActiveClaudeSessionId(): string | null {
    const focused = this.focusedSessionId ? this.sessionById(this.focusedSessionId) : null;
    if (focused && isClaudeSession(focused) && focused.runtimeState === "live") {
      return focused.id;
    }
    return (
      this.state.sessions
        .filter((s) => isClaudeSession(s) && s.runtimeState === "live")
        .sort((a, b) => (b.lastActivityAt || "").localeCompare(a.lastActivityAt || ""))
        [0]?.id || null
    );
  }

  scheduleSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushStateSave();
    }, 200);
  }

  async persistNow() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    await this.flushStateSave();
  }

  flushStateSave() {
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(() => saveState(this.state));

    return this.saveChain.catch((error: unknown) => {
      console.error("Failed to save app state.", error);
    });
  }

  async openWorkspaceFolder() {
    const result = await dialog.showOpenDialog(this.window, {
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Open Folder"
    });

    if (result.canceled || result.filePaths.length === 0) {
      return;
    }

    await this.addWorkspace(result.filePaths[0]);
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

    await fsp.mkdir(result.filePath, { recursive: true });
    await this.addWorkspace(result.filePath);
  }

  async addWorkspace(rootPath) {
    const normalizedPath = path.resolve(rootPath);
    const existing = this.state.workspaces.find((workspace) => workspace.rootPath === normalizedPath);

    if (existing) {
      await this.rescanWorkspace(existing.id);
      return;
    }

    const workspace = {
      id: randomUUID(),
      name: path.basename(normalizedPath) || normalizedPath,
      rootPath: normalizedPath,
      createdAt: now()
    };

    this.state.workspaces.push(workspace);
    await this.rescanWorkspace(workspace.id);
  }

  async rescanWorkspace(workspaceId) {
    const workspace = this.state.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) {
      return;
    }

    const scannedRepos = await scanWorkspace(workspace.rootPath, workspaceId);
    const existingByPath = new Map<string, RepoRecord>(
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
            wikiEnabled: existing.wikiEnabled ?? repo.wikiEnabled,
            appLaunchConfig: existing.appLaunchConfig ?? repo.appLaunchConfig
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
    const startupAgentId =
      launchesClaudeOnStart !== false
        ? normalizeAgentId(this.state.preferences.defaultAgentId)
        : null;
    const session: SessionRecord = {
      id: sessionId,
      repoID: repoId,
      title: repo.name,
      launchProfile: "agent",
      initialPrompt: "",
      launchesClaudeOnStart: !!startupAgentId,
      startupAgentId,
      claudeSessionId: startupAgentId === DEFAULT_AGENT_ID ? sessionId : null,
      agentSessionId: startupAgentId === DEFAULT_AGENT_ID ? sessionId : null,
      status: "running",
      runtimeState: "live",
      blocker: null,
      unreadCount: 0,
      createdAt: now(),
      updatedAt: now(),
      lastActivityAt: null,
      stoppedAt: null,
      launchCount: 1,
      isPinned: false,
      tagColor: null,
      sessionIconPath: null,
      sessionIconUpdatedAt: null,
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

  updateSessionOrganization(sessionId, patch) {
    const session = this.sessionById(sessionId);
    if (!session || !patch || typeof patch !== "object") {
      return false;
    }

    let changed = false;

    if (Object.prototype.hasOwnProperty.call(patch, "isPinned")) {
      const nextPinned = !!patch.isPinned;
      if (session.isPinned !== nextPinned) {
        session.isPinned = nextPinned;
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, "tagColor")) {
      const nextTagColor = normalizeSessionTagColor(patch.tagColor);
      if (session.tagColor !== nextTagColor) {
        session.tagColor = nextTagColor;
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, "repoID")) {
      const nextRepoID = typeof patch.repoID === "string" ? patch.repoID : "";
      if (nextRepoID && this.repoById(nextRepoID) && session.repoID !== nextRepoID) {
        session.repoID = nextRepoID;
        changed = true;
      }
    }

    if (!changed) {
      return false;
    }

    this.scheduleSave();
    this.sendSessionUpdated(sessionId);
    this.broadcastState();
    return true;
  }

  async importSessionIcon(sessionId) {
    const session = this.sessionById(sessionId);
    if (!session || !this.window || this.window.isDestroyed()) {
      return null;
    }

    const result = await dialog.showOpenDialog(this.window, {
      title: "Choose Session Icon",
      buttonLabel: "Use Icon",
      properties: ["openFile"],
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "gif", "svg", "webp"]
        }
      ]
    });

    if (result.canceled || !result.filePaths.length) {
      return null;
    }

    const sourceFilePath = result.filePaths[0];
    const extension = path.extname(sourceFilePath).toLowerCase();
    if (!SESSION_ICON_EXTENSIONS.has(extension)) {
      throw new Error("Choose a PNG, JPG, GIF, SVG, or WebP image.");
    }

    const targetDirectoryPath = sessionIconDirectoryPath();
    const targetFilePath = path.join(targetDirectoryPath, `${session.id}${extension}`);
    await fsp.mkdir(targetDirectoryPath, { recursive: true });
    await removeStoredSessionIconFiles(session.id, targetFilePath);
    await fsp.copyFile(sourceFilePath, targetFilePath);

    session.sessionIconPath = targetFilePath;
    session.sessionIconUpdatedAt = now();
    this.scheduleSave();
    this.sendSessionUpdated(sessionId);
    this.broadcastState();
    return summarizeSession(session);
  }

  async clearSessionIcon(sessionId) {
    const session = this.sessionById(sessionId);
    if (!session || !session.sessionIconPath) {
      return false;
    }

    await removeStoredSessionIconFiles(session.id, null);
    session.sessionIconPath = null;
    session.sessionIconUpdatedAt = null;
    this.scheduleSave();
    this.sendSessionUpdated(sessionId);
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
    const session = this.sessionById(sessionId);
    this.cancelPendingAgentLaunch(sessionId);
    this.queuedSessionLaunches.delete(sessionId);
    this.sessionSizes.delete(sessionId);
    this.terminalBuffers.delete(sessionId);
    this.resetSignalTracking(sessionId);
    this.ptyHost.killSession(sessionId);
    this.focusedSessionId = this.focusedSessionId === sessionId ? null : this.focusedSessionId;
    this.state.sessions = this.state.sessions.filter((session) => session.id !== sessionId);
    if (session?.sessionIconPath) {
      removeStoredSessionIconFiles(session.id, null);
    }
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

    const defaultAgentId = normalizeAgentId(this.state.preferences.defaultAgentId) || DEFAULT_AGENT_ID;
    const defaultAgentLabel = AGENT_LABELS[defaultAgentId] || "Default Agent";

    const menu = Menu.buildFromTemplate([
      {
        label: `Start ${defaultAgentLabel} Session`,
        click: () => this.sendCommand("new-session", { repoId })
      },
      {
        label: "Open Wiki",
        click: () => this.sendCommand("open-wiki", { repoId })
      },
      {
        label: "Build and Run App",
        click: () => this.sendCommand("build-and-run-app", { repoId })
      },
      {
        label: "Configure App Launch",
        click: () => this.sendCommand("configure-build-and-run-app", { repoId })
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

  async querySessionFiles(repoId, query): Promise<SessionSearchResponse> {
    const repo = this.repoById(repoId);
    if (!repo) {
      return {
        ok: false,
        error: "Select a project before searching session files.",
        installCommand: "brew install fzf ripgrep",
        missingTools: [],
        results: []
      };
    }

    const response = await queryProjectSessions(repo.path, query);
    if (!response?.ok) {
      return response;
    }

    return {
      ...response,
      results: response.results.map((result) => ({
        ...result,
        hydraSessionId: this.findHydraSessionIdForSearchResult(
          repo.id,
          result.source,
          result.sessionId
        )
      }))
    };
  }

  resumeFromClaudeSession(repoId, claudeSessionId) {
    return this.resumeFromSearchResult(repoId, "claude", claudeSessionId);
  }

  resumeFromSearchResult(
    repoId: string,
    source: SessionSearchSource,
    externalSessionId: string | null
  ) {
    const repo = this.repoById(repoId);
    const startupAgentId = normalizeAgentId(source, null);
    if (!repo || !startupAgentId || !externalSessionId) {
      return null;
    }

    const sessionId = randomUUID();
    const session: SessionRecord = {
      id: sessionId,
      repoID: repoId,
      title: repo.name,
      launchProfile: "agent",
      initialPrompt: "",
      launchesClaudeOnStart: true,
      startupAgentId,
      claudeSessionId: startupAgentId === DEFAULT_AGENT_ID ? externalSessionId : null,
      agentSessionId: externalSessionId,
      status: "running",
      runtimeState: "live",
      blocker: null,
      unreadCount: 0,
      createdAt: now(),
      updatedAt: now(),
      lastActivityAt: null,
      stoppedAt: null,
      launchCount: 2,
      isPinned: false,
      tagColor: null,
      sessionIconPath: null,
      sessionIconUpdatedAt: null,
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
    const reposByWorkspaceId = new Map<string, RepoRecord[]>();

    for (const repo of this.state.repos) {
      if (!reposByWorkspaceId.has(repo.workspaceID)) {
        reposByWorkspaceId.set(repo.workspaceID, []);
      }

      const existingRepos = reposByWorkspaceId.get(repo.workspaceID);
      if (!existingRepos) {
        continue;
      }

      existingRepos.push({ ...repo });
    }

    const normalizedRepos: RepoRecord[] = [];

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
          appLaunchConfig: null,
          discoveredAt: now()
        };

      const normalizedRepo: RepoRecord = {
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
    const nextPreferences = normalizePreferences({
      ...this.state.preferences,
      ...patch,
      agentCommandOverrides: {
        ...(this.state.preferences.agentCommandOverrides || {}),
        ...(patch?.agentCommandOverrides || {})
      }
    });
    this.state.preferences = nextPreferences;

    if (patch.keybindings) {
      this.setupMenu();
    }

    this.scheduleSave();
    this.broadcastState();
  }

  updateRepoAppLaunchConfig(repoId: string, config: unknown): RepoAppLaunchConfig | null {
    const repo = this.repoById(repoId);
    if (!repo) {
      throw new Error("Project not found.");
    }

    const normalizedConfig = normalizeRepoAppLaunchConfig(config);
    if (!normalizedConfig) {
      throw new Error("Build and run commands are required.");
    }

    repo.appLaunchConfig = normalizedConfig;
    repo.updatedAt = now();
    this.scheduleSave();
    this.broadcastState();
    return structuredClone(normalizedConfig);
  }

  buildAndRunApp(repoId: string): string | null {
    const repo = this.repoById(repoId);
    const config = repo?.appLaunchConfig;
    if (!repo) {
      throw new Error("Project not found.");
    }

    if (!config) {
      throw new Error("Set build and run commands for this project first.");
    }

    const reusableSession = this.findReusableAppSession(repoId);
    const sessionId =
      reusableSession?.runtimeState === "stopped"
        ? reusableSession.id
        : this.createAppLaunchSession(repoId, `App: ${repo.name}`);

    if (!sessionId) {
      return null;
    }

    if (reusableSession?.runtimeState === "stopped") {
      this.reopenSession(sessionId);
    } else {
      this.sendSessionUpdated(sessionId);
    }

    return sessionId;
  }

  findReusableAppSession(repoId: string): SessionRecord | null {
    const repo = this.repoById(repoId);
    if (!repo) {
      return null;
    }

    const expectedTitle = `App: ${repo.name}`;
    return (
      this.state.sessions.find(
        (session) =>
          session.repoID === repoId &&
          session.launchProfile === "appLaunch" &&
          !session.startupAgentId &&
          session.title === expectedTitle &&
          session.runtimeState === "stopped"
      ) || null
    );
  }

  findHydraSessionIdForSearchResult(
    repoId: string,
    source: SessionSearchSource,
    externalSessionId: string | null
  ) {
    if (!externalSessionId) {
      return null;
    }

    const startupAgentId = normalizeAgentId(source, null);
    if (!startupAgentId) {
      return null;
    }

    const match = this.state.sessions.find((session) =>
      session.repoID === repoId &&
      (session.id === externalSessionId ||
        (session.startupAgentId === startupAgentId &&
          (session.agentSessionId === externalSessionId ||
            (startupAgentId === DEFAULT_AGENT_ID &&
              session.claudeSessionId === externalSessionId))))
    );

    return match ? match.id : null;
  }

  launchRuntime(session, repo) {
    this.cancelPendingAgentLaunch(session.id);
    const appLaunchCommand =
      session.launchProfile === "appLaunch"
        ? resolvedAppLaunchCommand(this.state.preferences, repo)
        : null;

    if (appLaunchCommand) {
      this.ptyHost.createSession({
        sessionId: session.id,
        cwd: repo.path,
        command: appLaunchCommand
      });
      return;
    }

    this.ptyHost.createSession({
      sessionId: session.id,
      cwd: repo.path,
      shellPath: resolvedShellPath(this.state.preferences)
    });
  }

  ephemeralToolCommand(toolId: EphemeralToolId): string[] | null {
    if (toolId === "lazygit") {
      return this.lazygitPath ? [this.lazygitPath] : null;
    }

    if (toolId === "tokscale") {
      return this.npxPath ? [this.npxPath, "--yes", "tokscale@latest"] : null;
    }

    return null;
  }

  createEphemeralToolSession(toolId: EphemeralToolId, repoId: string) {
    const repo = this.repoById(repoId);
    const command = this.ephemeralToolCommand(toolId);
    if (!repo || !command) return null;
    const sessionId = randomUUID();
    this.ephemeralSessions.set(sessionId, { repoId, toolId });
    this.ptyHost.createSession({
      sessionId,
      cwd: repo.path,
      command
    });
    return sessionId;
  }

  isEphemeralToolSession(sessionId: string, toolId: EphemeralToolId): boolean {
    return this.ephemeralSessions.get(sessionId)?.toolId === toolId;
  }

  closeEphemeralToolSession(toolId: EphemeralToolId, sessionId: string) {
    if (!this.isEphemeralToolSession(sessionId, toolId)) return;
    this.ephemeralSessions.delete(sessionId);
    this.ptyHost.killSession(sessionId);
  }

  handleEphemeralToolInput(toolId: EphemeralToolId, sessionId: string, data: string) {
    if (this.isEphemeralToolSession(sessionId, toolId)) {
      this.ptyHost.sendInput(sessionId, data);
    }
  }

  handleEphemeralToolResize(
    toolId: EphemeralToolId,
    sessionId: string,
    cols: number,
    rows: number
  ) {
    if (this.isEphemeralToolSession(sessionId, toolId)) {
      this.ptyHost.resizeSession(sessionId, cols, rows);
    }
  }

  handleSessionInput(sessionId, data) {
    this.ptyHost.sendInput(sessionId, data);
    this.resolveInteractiveBlockerFromInput(sessionId, data);
  }

  handlePtyMessage(message) {
    const ephemeralSession = this.ephemeralSessions.get(message.sessionId);
    if (ephemeralSession) {
      if (message.type === "data") {
        this.sendEphemeralToolOutput({
          toolId: ephemeralSession.toolId,
          sessionId: message.sessionId,
          data: message.data
        });
      } else if (message.type === "exit") {
        this.ephemeralSessions.delete(message.sessionId);
        this.sendEphemeralToolExit({
          toolId: ephemeralSession.toolId,
          sessionId: message.sessionId
        });
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
    if (!session) {
      return;
    }

    this.flushQueuedSessionLaunch(sessionId);

    if (!session.startupAgentId) {
      return;
    }

    this.pendingAgentLaunch.add(sessionId);
    this.maybeLaunchAgent(sessionId);
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

    this.cancelPendingAgentLaunch(sessionId);
    this.queuedSessionLaunches.delete(sessionId);
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

  createShellSession(repoId: string, title?: string, queuedInput?: string) {
    const repo = this.repoById(repoId);
    if (!repo) {
      return null;
    }

    const sessionId = randomUUID();
    const session: SessionRecord = {
      id: sessionId,
      repoID: repoId,
      title: title || repo.name,
      launchProfile: "shell",
      initialPrompt: "",
      launchesClaudeOnStart: false,
      startupAgentId: null,
      claudeSessionId: null,
      agentSessionId: null,
      status: "running",
      runtimeState: "live",
      blocker: null,
      unreadCount: 0,
      createdAt: now(),
      updatedAt: now(),
      lastActivityAt: null,
      stoppedAt: null,
      launchCount: 1,
      isPinned: false,
      tagColor: null,
      sessionIconPath: null,
      sessionIconUpdatedAt: null,
      transcript: "",
      rawTranscript: ""
    };

    this.state.sessions.unshift(session);
    this.terminalBuffers.set(session.id, new TerminalTranscriptBuffer(session.transcript));
    if (queuedInput) {
      this.queueSessionLaunch(session.id, queuedInput, title);
    }
    this.launchRuntime(session, repo);
    this.scheduleSave();
    this.broadcastState();
    return session.id;
  }

  createAppLaunchSession(repoId: string, title?: string) {
    const repo = this.repoById(repoId);
    if (!repo) {
      return null;
    }

    const sessionId = randomUUID();
    const session: SessionRecord = {
      id: sessionId,
      repoID: repoId,
      title: title || `App: ${repo.name}`,
      launchProfile: "appLaunch",
      initialPrompt: "",
      launchesClaudeOnStart: false,
      startupAgentId: null,
      claudeSessionId: null,
      agentSessionId: null,
      status: "running",
      runtimeState: "live",
      blocker: null,
      unreadCount: 0,
      createdAt: now(),
      updatedAt: now(),
      lastActivityAt: null,
      stoppedAt: null,
      launchCount: 1,
      isPinned: false,
      tagColor: null,
      sessionIconPath: null,
      sessionIconUpdatedAt: null,
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

  queueSessionLaunch(sessionId: string, input: string, title?: string) {
    this.queuedSessionLaunches.set(sessionId, {
      input,
      title
    });
  }

  flushQueuedSessionLaunch(sessionId: string) {
    const queued = this.queuedSessionLaunches.get(sessionId);
    if (!queued) {
      return;
    }

    const session = this.sessionById(sessionId);
    if (session && queued.title && session.title !== queued.title) {
      session.title = queued.title;
      session.updatedAt = now();
      this.scheduleSave();
      this.broadcastState();
    }

    this.queuedSessionLaunches.delete(sessionId);
    this.ptyHost.sendInput(sessionId, queued.input);
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

  async projectWikiContext(repoId) {
    const repo = this.repoById(repoId);
    if (!repo) {
      return null;
    }

    return getWikiContext(repo.path, repo.wikiEnabled);
  }

  async projectWikiFile(repoId, relativePath) {
    const repo = this.repoById(repoId);
    if (!repo) {
      throw new Error("Folder not found.");
    }

    return readWikiFile(repo.path, relativePath);
  }

  async toggleProjectWiki(repoId, enabled) {
    const repo = this.repoById(repoId);
    if (!repo) {
      return null;
    }

    if (enabled) {
      await enableWiki(repo.path);
    } else {
      await disableWiki(repo.path);
    }

    repo.wikiEnabled = enabled;
    repo.updatedAt = now();
    this.scheduleSave();
    this.broadcastState();
    return this.projectWikiContext(repoId);
  }

  async revealProjectWiki(repoId) {
    const repo = this.repoById(repoId);
    if (!repo) {
      return;
    }

    const targetPath = (await wikiExists(repo.path)) ? wikiDirectoryPath(repo.path) : repo.path;
    shell.showItemInFolder(targetPath);
  }

  sessionById(sessionId) {
    return this.state.sessions.find((session) => session.id === sessionId) || null;
  }

  inboxSessions() {
    return [...this.state.sessions]
      .filter((session) => session.blocker || session.unreadCount > 0)
      .sort(compareInboxSessions);
  }

  async confirmQuit(event) {
    if (this.allowQuit) {
      return;
    }

    const liveSessions = this.state.sessions.filter((session) => session.runtimeState === "live");
    if (liveSessions.length === 0) {
      event.preventDefault();
      await this.shutdown();
      app.quit();
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

    event.preventDefault();
    await this.shutdown();
    app.quit();
  }

  async shutdown() {
    this.allowQuit = true;
    for (const session of this.state.sessions) {
      if (session.runtimeState === "live") {
        this.cancelPendingAgentLaunch(session.id);
        this.queuedSessionLaunches.delete(session.id);
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
    await this.persistNow();
  }

  handleSessionResize(sessionId, cols, rows) {
    const safeCols = Math.max(1, Number(cols) || 1);
    const safeRows = Math.max(1, Number(rows) || 1);

    this.sessionSizes.set(sessionId, {
      cols: safeCols,
      rows: safeRows
    });
    this.ptyHost.resizeSession(sessionId, safeCols, safeRows);
    this.maybeLaunchAgent(sessionId);
  }

  maybeLaunchAgent(sessionId) {
    if (!this.pendingAgentLaunch.has(sessionId) || this.pendingAgentLaunchTimers.has(sessionId)) {
      return;
    }

    const session = this.sessionById(sessionId);
    const size = this.sessionSizes.get(sessionId);
    if (!session || session.runtimeState !== "live" || !size || size.cols < 2 || size.rows < 2) {
      return;
    }

    const timer = setTimeout(() => {
      this.pendingAgentLaunchTimers.delete(sessionId);

      const currentSession = this.sessionById(sessionId);
      if (
        !currentSession ||
        currentSession.runtimeState !== "live" ||
        !this.pendingAgentLaunch.has(sessionId)
      ) {
        return;
      }

      const launchCommand = resolvedSessionLaunchCommand(this.state.preferences, currentSession);
      this.pendingAgentLaunch.delete(sessionId);
      if (!launchCommand) {
        return;
      }

      this.ptyHost.sendInput(sessionId, `${launchCommand}\r`);
    }, 120);

    this.pendingAgentLaunchTimers.set(sessionId, timer);
  }

  cancelPendingAgentLaunch(sessionId) {
    this.pendingAgentLaunch.delete(sessionId);

    const timer = this.pendingAgentLaunchTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.pendingAgentLaunchTimers.delete(sessionId);
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
    startupAgentId: session.startupAgentId,
    claudeSessionId: session.claudeSessionId,
    agentSessionId: session.agentSessionId,
    status: session.status,
    runtimeState: session.runtimeState,
    blocker: session.blocker,
    unreadCount: session.unreadCount,
    isPinned: !!session.isPinned,
    tagColor: normalizeSessionTagColor(session.tagColor),
    sessionIconUrl: sessionIconUrl(session),
    sessionIconUpdatedAt: session.sessionIconUpdatedAt || null,
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

function compareSessions(left, right) {
  if (!!left.isPinned !== !!right.isPinned) {
    return left.isPinned ? -1 : 1;
  }

  return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
}

function compareInboxSessions(left, right) {
  const pinOrder = compareSessions(left, right);
  if (pinOrder !== 0) {
    return pinOrder;
  }

  if (!!left.blocker !== !!right.blocker) {
    return left.blocker ? -1 : 1;
  }

  return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
}

function normalizeSessionTagColor(value: unknown): SessionTagColor | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SESSION_TAG_COLORS.has(normalized) ? normalized as SessionTagColor : null;
}

function sessionIconDirectoryPath() {
  return path.join(app.getPath("userData"), "session-icons");
}

async function removeStoredSessionIconFiles(sessionId, keepPath) {
  const directoryPath = sessionIconDirectoryPath();

  let fileNames: string[] = [];
  try {
    fileNames = await fsp.readdir(directoryPath);
  } catch {
    return;
  }

  await Promise.all(fileNames.map(async (fileName) => {
    if (!fileName.startsWith(`${sessionId}.`)) {
      return;
    }

    const filePath = path.join(directoryPath, fileName);
    if (keepPath && path.resolve(filePath) === path.resolve(keepPath)) {
      return;
    }

    try {
      await fsp.unlink(filePath);
    } catch {}
  }));
}

function sessionIconUrl(session) {
  if (!session?.sessionIconPath || !fs.existsSync(session.sessionIconPath)) {
    return "";
  }

  const url = pathToFileURL(session.sessionIconPath).href;
  const version = encodeURIComponent(String(session.sessionIconUpdatedAt || ""));
  return version ? `${url}?v=${version}` : url;
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

function resolvedAppLaunchCommand(preferences, repo) {
  const config = repo?.appLaunchConfig;
  if (!config) {
    return null;
  }

  const shellPath = resolvedShellPath(preferences);
  return [
    shellPath,
    "-lc",
    `${shellEscape(appLaunchRunnerPath())} ${shellEscape(config.buildCommand)} ${shellEscape(config.runCommand)}`
  ];
}

function resolvedSessionLaunchCommand(preferences, session) {
  const startupAgentId = normalizeAgentId(session?.startupAgentId, null);
  if (!session?.launchesClaudeOnStart || !startupAgentId) {
    return "";
  }

  const command = resolvedAgentCommand(preferences, startupAgentId);
  if (startupAgentId === "codex" && session.agentSessionId) {
    return `${command} resume ${shellEscape(session.agentSessionId)}`;
  }

  if (startupAgentId !== DEFAULT_AGENT_ID) {
    return command;
  }

  if (session.launchCount > 1) {
    if (session.claudeSessionId) {
      return `${command} --resume ${shellEscape(session.claudeSessionId)}`;
    }

    return `${command} --continue`;
  }

  if (session.claudeSessionId) {
    return `${command} --session-id ${shellEscape(session.claudeSessionId)}`;
  }

  return command;
}

function resolvedAgentCommand(preferences, agentId) {
  const candidate = preferences?.agentCommandOverrides?.[agentId];
  const normalized = typeof candidate === "string" ? candidate.trim() : "";
  return normalized || DEFAULT_AGENT_COMMANDS[agentId] || DEFAULT_AGENT_COMMANDS[DEFAULT_AGENT_ID];
}

function appLaunchRunnerPath() {
  return path.join(__dirname, "app-launch-runner.sh");
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

function isClaudeSession(session) {
  return !session.startupAgentId || session.startupAgentId === "claude";
}

function blockerClearThreshold(kind) {
  switch (kind) {
    case "approval":
    case "question":
    case "planMode":
      return 4;
    case "crashed":
      return Number.POSITIVE_INFINITY;
    default:
      return 2;
  }
}

function interactiveBlockerKinds() {
  return new Set(["approval", "question", "planMode"]);
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

app.whenReady().then(async () => {
  await controller.initialize();
  controller.setupIpc();
  controller.setupMenu();
  controller.createWindow();
  startMcpServer(controller).catch((err) =>
    console.error("[MCP] Server failed to start:", err)
  );
});

app.on("before-quit", (event) => {
  void controller.confirmQuit(event);
});

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
