import type {
  BrowserWindow as ElectronBrowserWindow,
  Event as ElectronEvent
} from "electron";
import type { ParsedCommandSpec } from "./command-parser";
import type {
  AgentDefinition,
  AgentId,
  AppCommandPayload,
  AppPreferences,
  AppPreferencesPatch,
  AppUpdateCheckResult,
  AppStateSnapshot,
  ClaudeExternalUrlRequest,
  ClaudePathRevealRequest,
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
  SessionRestartRequest,
  SessionRecord,
  SessionSearchSource,
  SessionSearchResponse,
  SessionRuntimeState,
  SessionStatus,
  SessionSummary,
  SessionTagColor,
  StoredAppState,
  TrackedPortStatus,
  WikiContext,
  WikiFileContents
} from "../shared-types";
import type { AppControllerHandle } from "./internal-api";
import type { HydraMcpServer } from "./mcp-server";
import type { AuthSession } from "./auth-client";
import { HydraAuthClient } from "./auth-client";
import {
  extractPreferencesPatch,
  normalizeMarketplaceInstallArgs,
  normalizeMarketplaceSkillDetailsArgs,
  normalizeOrganizeSessionArgs,
  parseMcpActionArgs,
  type McpActionArgs,
  type McpActionName,
  type McpActionResult
} from "./mcp-contracts";

const fs = require("node:fs");
const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
const path = require("node:path");
const { randomUUID, randomBytes } = require("node:crypto");
const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const { autoUpdater } = require("electron-updater");
const { fileURLToPath, pathToFileURL, URL } = require("node:url");
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  powerMonitor,
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
type PendingSessionRestart = {
  requestedAt: string;
};
type QueuedSessionLaunch = {
  title?: string;
  input: string;
};
type UpdaterLogLevel = "debug" | "info" | "warn" | "error";
type AutoUpdateSupport = {
  enabled: boolean;
  reason: string;
};
type AutoUpdaterCheckForUpdatesResult = {
  updateInfo?: {
    version?: string | null;
  } | null;
  downloadPromise?: Promise<unknown> | null;
} | null;
type ResolvedCommandPayload = {
  command: string[];
  env?: Record<string, string>;
};
type PersistStateOptions = {
  throwOnError?: boolean;
};
type PackagedSmokeTestConfig = {
  agentId: AgentId;
  agentCommand: string | null;
  expectedOutput: string;
  resultPath: string | null;
  timeoutMs: number;
  userDataDir: string | null;
  workspacePath: string;
};
type PackagedSmokeTestResult = {
  elapsedMs: number;
  expectedOutput: string;
  message: string;
  ok: boolean;
  runtimeState: SessionRuntimeState | null;
  sessionId: string | null;
  stage: string;
  status: SessionStatus | null;
  transcriptPreview: string;
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
const {
  isPlainObject,
  isPathWithinRoot,
  normalizeSessionTagColor
} = require("./shared-utils") as {
  isPlainObject: <T extends Record<string, unknown> = Record<string, unknown>>(value: unknown) => value is T;
  isPathWithinRoot: (filePath: string, rootPath: string) => boolean;
  normalizeSessionTagColor: (value: unknown) => SessionTagColor | null;
};
const {
  invalidateSessionSearchCache,
  isSessionSearchResultPathForRepo,
  queryProjectSessions
} = require("./session-search") as {
  invalidateSessionSearchCache: (repoPath?: string | null) => void;
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
const { commandSpecToHelperArgs, parseCommandSpec } = require("./command-parser") as {
  commandSpecToHelperArgs: (prefix: "build" | "run", spec: ParsedCommandSpec) => string[];
  parseCommandSpec: (value: unknown) => ParsedCommandSpec | null;
};
const { resolveKeybindings } = require("./keybindings");
const { PtyHostClient } = require("./pty-host-client") as {
  PtyHostClient: PtyHostClientConstructor;
};
const { resolveBundledHelperPath, resolveBundledNodeModulePath } = require("./runtime-paths") as {
  resolveBundledHelperPath: (fileName: string) => string;
  resolveBundledNodeModulePath: (
    packageName: string,
    relativePath: string,
    options?: { unpacked?: boolean }
  ) => string | null;
};
const {
  disableWiki,
  enableWiki,
  getWikiContext,
  invalidateWikiExistsSyncCache,
  readWikiFile,
  wikiDirectoryPath,
  wikiExists,
  wikiExistsSync
} = require("./wiki") as {
  disableWiki: (rootPath: string) => Promise<unknown>;
  enableWiki: (rootPath: string) => Promise<unknown>;
  getWikiContext: (rootPath: string, enabled: boolean) => Promise<WikiContext>;
  invalidateWikiExistsSyncCache: (rootPath?: string) => void;
  readWikiFile: (rootPath: string, relativePath: string) => Promise<WikiFileContents>;
  wikiDirectoryPath: (rootPath: string) => string;
  wikiExists: (rootPath: string) => Promise<boolean>;
  wikiExistsSync: (rootPath: string) => boolean;
};
const { mergeCommandPath, resolveCommandPath, resolveCommandPathSync } = require("./command-path") as {
  mergeCommandPath: (envPath?: string | null) => string;
  resolveCommandPath: (command: string, envPath?: string | null) => Promise<string | null>;
  resolveCommandPathSync: (command: string, envPath?: string | null) => string | null;
};
const { startMcpServer } = require("./mcp-server") as {
  startMcpServer: (
    appController: AppControllerHandle,
    options: { authToken: string }
  ) => Promise<HydraMcpServer>;
};

app.setName("Hydra");

const MCP_SERVER_ENABLE_ENV = "HYDRA_ENABLE_MCP_SERVER";
const MCP_SERVER_TOKEN_ENV = "HYDRA_MCP_AUTH_TOKEN";
const MCP_SERVER_TOKEN_FILE_NAME = "mcp-auth-token";
const SMOKE_TEST_ENABLE_ENV = "HYDRA_SMOKE_TEST";
const SMOKE_TEST_AGENT_ID_ENV = "HYDRA_SMOKE_AGENT_ID";
const SMOKE_TEST_AGENT_COMMAND_ENV = "HYDRA_SMOKE_AGENT_COMMAND";
const SMOKE_TEST_EXPECTED_OUTPUT_ENV = "HYDRA_SMOKE_EXPECTED_OUTPUT";
const SMOKE_TEST_RESULT_PATH_ENV = "HYDRA_SMOKE_RESULT_PATH";
const SMOKE_TEST_TIMEOUT_MS_ENV = "HYDRA_SMOKE_TIMEOUT_MS";
const SMOKE_TEST_USER_DATA_DIR_ENV = "HYDRA_SMOKE_USER_DATA_DIR";
const SMOKE_TEST_WORKSPACE_PATH_ENV = "HYDRA_SMOKE_WORKSPACE_PATH";
const SMOKE_TEST_ENABLE_FLAG = "--hydra-smoke-test";
const SMOKE_TEST_AGENT_ID_FLAG = "--hydra-smoke-agent-id";
const SMOKE_TEST_AGENT_COMMAND_FLAG = "--hydra-smoke-agent-command";
const SMOKE_TEST_EXPECTED_OUTPUT_FLAG = "--hydra-smoke-expected-output";
const SMOKE_TEST_RESULT_PATH_FLAG = "--hydra-smoke-result-path";
const SMOKE_TEST_TIMEOUT_MS_FLAG = "--hydra-smoke-timeout-ms";
const SMOKE_TEST_USER_DATA_DIR_FLAG = "--hydra-smoke-user-data-dir";
const SMOKE_TEST_WORKSPACE_PATH_FLAG = "--hydra-smoke-workspace-path";

const FILE_TREE_IGNORED = new Set([
  ".git", "node_modules", "dist", "build", ".next", "__pycache__",
  ".cache", "coverage", ".mypy_cache", ".pytest_cache", ".turbo",
  ".vercel", "out", ".output", ".nuxt", ".svelte-kit", "storybook-static",
  ".parcel-cache", "target", ".gradle", ".idea", ".vscode"
]);
const SESSION_ICON_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);
const TRUSTED_RENDERER_ENTRY_PATH = path.resolve(path.join(__dirname, "..", "renderer", "index.html"));
const TRUSTED_AUTH_ENTRY_PATH = path.resolve(path.join(__dirname, "..", "renderer", "auth.html"));
const AGENT_LABELS: Record<AgentId, string> = Object.fromEntries(
  AGENT_DEFINITIONS.map((agent) => [agent.id, agent.label])
) as Record<AgentId, string>;
const smokeTestConfig = resolvePackagedSmokeTestConfig();
if (smokeTestConfig?.userDataDir) {
  app.setPath("userData", smokeTestConfig.userDataDir);
}

function formatUpdaterLogMessage(message: unknown): string {
  if (message instanceof Error) {
    return message.stack || message.message;
  }
  if (typeof message === "string") {
    return message;
  }

  try {
    const serialized = JSON.stringify(message);
    return serialized ?? String(message);
  } catch {
    return String(message);
  }
}

function updaterLogFilePath(): string {
  return path.join(app.getPath("userData"), "logs", "updater.log");
}

function logUpdater(level: UpdaterLogLevel, message: unknown): void {
  const text = formatUpdaterLogMessage(message);
  const prefix = `[updater] ${text}`;

  switch (level) {
    case "debug":
    case "info":
      console.log(prefix);
      break;
    case "warn":
      console.warn(prefix);
      break;
    case "error":
      console.error(prefix);
      break;
  }

  try {
    const logPath = updaterLogFilePath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] [${level}] ${text}\n`, "utf8");
  } catch (error: unknown) {
    console.error("[updater] failed to write updater log:", error);
  }
}

const updaterLogger = {
  debug: (message: unknown) => logUpdater("debug", message),
  info: (message: unknown) => logUpdater("info", message),
  warn: (message: unknown) => logUpdater("warn", message),
  error: (message: unknown) => logUpdater("error", message)
};

function resolveMacAutoUpdateSupport(): AutoUpdateSupport {
  if (process.platform !== "darwin") {
    return { enabled: true, reason: "non-macOS build" };
  }

  const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", process.execPath], {
    encoding: "utf8"
  });
  if (result.error) {
    return {
      enabled: false,
      reason: `codesign inspection failed: ${formatUpdaterLogMessage(result.error)}`
    };
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const details = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    return {
      enabled: false,
      reason: `codesign inspection exited with status ${result.status}${details ? `: ${details}` : ""}`
    };
  }

  const details = `${result.stdout || ""}\n${result.stderr || ""}`;
  const teamIdentifier = details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || "";
  if (!teamIdentifier || teamIdentifier === "not set") {
    return {
      enabled: false,
      reason: `macOS bundle is not signed for auto-update (execPath=${process.execPath})`
    };
  }

  return {
    enabled: true,
    reason: `signed macOS bundle detected (team=${teamIdentifier})`
  };
}

function normalizeUpdateVersion(version: unknown): string | null {
  const normalizedVersion = typeof version === "string" ? version.trim() : "";
  return normalizedVersion || null;
}

function normalizeAbsolutePath(input: unknown, label = "path") {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) {
    throw new Error(`${label} is required.`);
  }

  return path.resolve(value);
}

function normalizeFileUrlPath(input: string): string | null {
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "file:") {
      return null;
    }

    return path.resolve(fileURLToPath(parsed));
  } catch {
    return null;
  }
}

function isTrustedRendererUrl(input: string) {
  const normalized = normalizeFileUrlPath(input);
  return normalized === TRUSTED_RENDERER_ENTRY_PATH || normalized === TRUSTED_AUTH_ENTRY_PATH;
}

function assertTrustedGitHubUrl(input: unknown) {
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

function sanitizePreferencesPatch(patch: unknown): AppPreferencesPatch {
  if (!isPlainObject(patch)) {
    return {};
  }

  const nextPatch: AppPreferencesPatch = {};

  if (Object.prototype.hasOwnProperty.call(patch, "defaultAgentId")) {
    nextPatch.defaultAgentId = patch.defaultAgentId as AppPreferencesPatch["defaultAgentId"];
  }
  if (Object.prototype.hasOwnProperty.call(patch, "agentCommandOverrides") && isPlainObject(patch.agentCommandOverrides)) {
    nextPatch.agentCommandOverrides =
      patch.agentCommandOverrides as AppPreferencesPatch["agentCommandOverrides"];
  }
  if (Object.prototype.hasOwnProperty.call(patch, "claudeExecutablePath")) {
    nextPatch.claudeExecutablePath =
      patch.claudeExecutablePath as AppPreferencesPatch["claudeExecutablePath"];
  }
  if (Object.prototype.hasOwnProperty.call(patch, "shellExecutablePath")) {
    nextPatch.shellExecutablePath =
      patch.shellExecutablePath as AppPreferencesPatch["shellExecutablePath"];
  }
  if (Object.prototype.hasOwnProperty.call(patch, "notificationsEnabled")) {
    nextPatch.notificationsEnabled =
      patch.notificationsEnabled as AppPreferencesPatch["notificationsEnabled"];
  }
  if (Object.prototype.hasOwnProperty.call(patch, "showInAppBadges")) {
    nextPatch.showInAppBadges = patch.showInAppBadges as AppPreferencesPatch["showInAppBadges"];
  }
  if (Object.prototype.hasOwnProperty.call(patch, "showNativeNotifications")) {
    nextPatch.showNativeNotifications =
      patch.showNativeNotifications as AppPreferencesPatch["showNativeNotifications"];
  }
  if (Object.prototype.hasOwnProperty.call(patch, "sessionWorkspaceLayout")) {
    nextPatch.sessionWorkspaceLayout =
      patch.sessionWorkspaceLayout as AppPreferencesPatch["sessionWorkspaceLayout"];
  }
  if (Object.prototype.hasOwnProperty.call(patch, "keybindings") && isPlainObject(patch.keybindings)) {
    nextPatch.keybindings = patch.keybindings as AppPreferencesPatch["keybindings"];
  }
  if (Object.prototype.hasOwnProperty.call(patch, "themeAppearance")) {
    nextPatch.themeAppearance = patch.themeAppearance as AppPreferencesPatch["themeAppearance"];
  }
  if (Object.prototype.hasOwnProperty.call(patch, "themeActiveId")) {
    nextPatch.themeActiveId = patch.themeActiveId as AppPreferencesPatch["themeActiveId"];
  }
  if (Object.prototype.hasOwnProperty.call(patch, "themeCustomThemes") && Array.isArray(patch.themeCustomThemes)) {
    nextPatch.themeCustomThemes =
      patch.themeCustomThemes as AppPreferencesPatch["themeCustomThemes"];
  }

  return nextPatch;
}

function tokscaleBinaryPackageName(): string | null {
  const arch = process.arch;

  if (process.platform === "darwin") {
    if (arch === "arm64") return "@tokscale/cli-darwin-arm64";
    if (arch === "x64") return "@tokscale/cli-darwin-x64";
    return null;
  }

  if (process.platform === "linux") {
    if (arch === "arm64") return "@tokscale/cli-linux-arm64-gnu";
    if (arch === "x64") return "@tokscale/cli-linux-x64-gnu";
    return null;
  }

  if (process.platform === "win32") {
    if (arch === "arm64") return "@tokscale/cli-win32-arm64-msvc";
    if (arch === "x64") return "@tokscale/cli-win32-x64-msvc";
    return null;
  }

  return null;
}

function resolveTokscaleBinaryPath(): string | null {
  const packageName = tokscaleBinaryPackageName();
  if (!packageName) {
    return null;
  }

  const binaryName = process.platform === "win32" ? "tokscale.exe" : "tokscale";
  return resolveBundledNodeModulePath(packageName, path.join("bin", binaryName), {
    unpacked: true
  });
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
  downloadedUpdateVersion: string | null;
  downloadedUpdatePromptVisible: boolean;
  downloadedUpdatePromptSuppressedKey: string | null;
  updateInstallWatchdog: NodeJS.Timeout | null;
  updateInstallInProgress: boolean;
  pendingAgentLaunch: Set<string>;
  pendingAgentLaunchTimers: Map<string, NodeJS.Timeout>;
  pendingSessionRestarts: Map<string, PendingSessionRestart>;
  sessionSizes: Map<string, { cols: number; rows: number }>;
  terminalBuffers: Map<string, TerminalTranscriptBufferInstance>;
  signalBuffers: Map<string, string>;
  blockerClearStreaks: Map<string, number>;
  queuedSessionLaunches: Map<string, QueuedSessionLaunch>;
  ptyHost: PtyHostClientInstance;
  ephemeralSessions: Map<string, EphemeralSessionRecord>;
  lazygitPath: string | null;
  tokscalePath: string | null;
  saveChain: Promise<void>;
  shutdownPromise: Promise<void> | null;
  knownPlanFiles: Set<string>;
  plansDirWatcher: ReturnType<typeof fs.watch> | null;
  mcpServer: HydraMcpServer | null;
  authClient: HydraAuthClient | null;
  authMainSetup: Promise<void>;

  constructor() {
    this.state = emptyState();
    this.window = null;
    this.focusedSessionId = null;
    this.saveTimer = null;
    this.allowQuit = false;
    this.downloadedUpdateVersion = null;
    this.downloadedUpdatePromptVisible = false;
    this.downloadedUpdatePromptSuppressedKey = null;
    this.updateInstallWatchdog = null;
    this.updateInstallInProgress = false;
    this.pendingAgentLaunch = new Set();
    this.pendingAgentLaunchTimers = new Map();
    this.pendingSessionRestarts = new Map();
    this.sessionSizes = new Map();
    this.terminalBuffers = new Map();
    this.signalBuffers = new Map();
    this.blockerClearStreaks = new Map();
    this.queuedSessionLaunches = new Map();
    this.ephemeralSessions = new Map();
    this.lazygitPath = null;
    this.tokscalePath = null;
    this.saveChain = Promise.resolve();
    this.shutdownPromise = null;
    this.knownPlanFiles = new Set();
    this.plansDirWatcher = null;
    this.mcpServer = null;
    const authServerUrl = this.resolveAuthServerUrl();
    this.authClient = new HydraAuthClient(authServerUrl, {
      getWindow: () => this.window,
      onSessionChanged: (session) => {
        void this.handleAuthSessionChanged(session);
      }
    });
    this.authMainSetup = this.authClient.setupMain({
      bridges: false,
      csp: true,
      getWindow: () => this.window,
    });
    this.ptyHost = new PtyHostClient();
    this.ptyHost.onMessage((message) => this.handlePtyMessage(message));
  }

  describeDownloadedUpdate(version?: string | null): string {
    const normalizedVersion = normalizeUpdateVersion(version);
    return normalizedVersion ? `Hydra ${normalizedVersion}` : "the downloaded update";
  }

  downloadedUpdatePromptKey(version?: string | null): string {
    return normalizeUpdateVersion(version) || "__unknown_downloaded_update__";
  }

  noteDownloadedUpdate(version?: string | null): void {
    const normalizedVersion = normalizeUpdateVersion(version);
    if (this.downloadedUpdateVersion !== normalizedVersion) {
      this.downloadedUpdatePromptSuppressedKey = null;
    }
    this.downloadedUpdateVersion = normalizedVersion;
    this.updateInstallInProgress = false;
    this.clearUpdateInstallWatchdog();
  }

  async promptToInstallDownloadedUpdate(version?: string | null): Promise<void> {
    const targetVersion = normalizeUpdateVersion(version) || this.downloadedUpdateVersion;
    const promptKey = this.downloadedUpdatePromptKey(targetVersion);
    if (
      this.downloadedUpdatePromptVisible
      || this.downloadedUpdatePromptSuppressedKey === promptKey
    ) {
      return;
    }

    this.downloadedUpdatePromptVisible = true;
    const targetUpdate = this.describeDownloadedUpdate(targetVersion);

    try {
      const { response } = await dialog.showMessageBox({
        type: "info",
        title: "Update ready",
        message: `${targetUpdate} has been downloaded. Restart to install it.`,
        detail: `Current version: ${app.getVersion()}. Updater log: ${updaterLogFilePath()}`,
        buttons: ["Restart now", "Later"]
      });
      this.downloadedUpdatePromptSuppressedKey = promptKey;

      if (response === 0) {
        await this.restartToInstallUpdate(targetVersion);
      }
    } catch (error: unknown) {
      logUpdater("error", `failed to show downloaded update dialog: ${formatUpdaterLogMessage(error)}`);
    } finally {
      this.downloadedUpdatePromptVisible = false;
    }
  }

  clearUpdateInstallWatchdog(): void {
    if (!this.updateInstallWatchdog) {
      return;
    }

    clearTimeout(this.updateInstallWatchdog);
    this.updateInstallWatchdog = null;
  }

  scheduleUpdateInstallWatchdog(version?: string | null): void {
    const targetVersion = typeof version === "string" && version.trim()
      ? version.trim()
      : this.downloadedUpdateVersion;

    this.clearUpdateInstallWatchdog();
    this.updateInstallWatchdog = setTimeout(() => {
      this.updateInstallWatchdog = null;
      this.updateInstallInProgress = false;

      const currentVersion = app.getVersion();
      const targetUpdate = this.describeDownloadedUpdate(targetVersion);
      logUpdater(
        "warn",
        `restart-to-install stalled; current=${currentVersion}, target=${targetVersion || "unknown"}`
      );

      const detailParts = [
        `Hydra is still running on version ${currentVersion}.`,
        "The downloaded update is still staged and may install the next time Hydra fully quits.",
        process.platform === "darwin"
          ? "Unsigned macOS builds do not reliably support auto-update install."
          : "Quit Hydra fully and reopen it to try again.",
        `Updater log: ${updaterLogFilePath()}`
      ];

      void dialog.showMessageBox({
        type: "warning",
        title: "Update restart did not finish",
        message: `Hydra did not restart to install ${targetUpdate}.`,
        detail: detailParts.join(" "),
        buttons: ["Quit Hydra", "Later"],
        defaultId: 0,
        cancelId: 1
      }).then(({ response }) => {
        if (response === 0) {
          this.allowQuit = true;
          app.quit();
        }
      }).catch((error: unknown) => {
        logUpdater("error", `failed to show stalled update dialog: ${formatUpdaterLogMessage(error)}`);
      });
    }, UPDATE_INSTALL_RESTART_TIMEOUT_MS);
    this.updateInstallWatchdog.unref?.();
  }

  async handleUpdaterError(error: unknown, version?: string | null): Promise<void> {
    logUpdater("error", error);

    if (!this.updateInstallInProgress) {
      return;
    }

    this.updateInstallInProgress = false;
    this.clearUpdateInstallWatchdog();

    const currentVersion = app.getVersion();
    const targetUpdate = this.describeDownloadedUpdate(version || this.downloadedUpdateVersion);
    const detailParts = [
      `Hydra is still running on version ${currentVersion}.`,
      process.platform === "darwin"
        ? "Quit Hydra fully and reopen it to try again. Unsigned macOS builds do not reliably support auto-update install."
        : "Quit Hydra fully and reopen it to try again.",
      `Error: ${formatUpdaterLogMessage(error)}`,
      `Updater log: ${updaterLogFilePath()}`
    ];

    await dialog.showMessageBox({
      type: "error",
      title: "Update failed",
      message: `Hydra could not restart to install ${targetUpdate}.`,
      detail: detailParts.join(" "),
      buttons: ["OK"]
    });
  }

  async checkForUpdates(): Promise<AppUpdateCheckResult> {
    const currentVersion = app.getVersion();
    if (!app.isPackaged) {
      return {
        status: "unsupported",
        canUpdate: false,
        currentVersion,
        latestVersion: null,
        message: "This build cannot update itself.",
        detail: `Current version: ${currentVersion}. Hydra is running from a local development build, so self-updates are only available in packaged releases.`
      };
    }

    const support = resolveMacAutoUpdateSupport();
    if (!support.enabled) {
      return {
        status: "unsupported",
        canUpdate: false,
        currentVersion,
        latestVersion: null,
        message: "This build cannot update itself.",
        detail: `Current version: ${currentVersion}. ${support.reason}`
      };
    }

    autoUpdater.logger = updaterLogger;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    if (this.downloadedUpdateVersion) {
      return {
        status: "downloaded",
        canUpdate: true,
        currentVersion,
        latestVersion: this.downloadedUpdateVersion,
        message: `Hydra ${this.downloadedUpdateVersion} is ready to install.`,
        detail: `Current version: ${currentVersion}. Restart Hydra to install the downloaded update.`
      };
    }

    if (updateCheckInFlight) {
      return {
        status: "in-progress",
        canUpdate: true,
        currentVersion,
        latestVersion: null,
        message: "An update check is already in progress.",
        detail: `Current version: ${currentVersion}. Wait for the current check to finish and try again if needed.`
      };
    }

    updateCheckInFlight = true;
    lastUpdateCheckAt = Date.now();
    logUpdater("info", "checking for updates (manual)");

    try {
      const result = await autoUpdater.checkForUpdates() as AutoUpdaterCheckForUpdatesResult;
      const availableVersion = normalizeUpdateVersion(result?.updateInfo?.version);
      const hasDifferentVersion = availableVersion !== null && availableVersion !== currentVersion;

      if (this.downloadedUpdateVersion) {
        return {
          status: "downloaded",
          canUpdate: true,
          currentVersion,
          latestVersion: this.downloadedUpdateVersion,
          message: `Hydra ${this.downloadedUpdateVersion} is ready to install.`,
          detail: `Current version: ${currentVersion}. Restart Hydra to install the downloaded update.`
        };
      }

      if (hasDifferentVersion || result?.downloadPromise) {
        return {
          status: "available",
          canUpdate: true,
          currentVersion,
          latestVersion: availableVersion,
          message: availableVersion
            ? `Hydra ${availableVersion} is available.`
            : "An update is available.",
          detail: `Current version: ${currentVersion}. The update is downloading in the background and Hydra will prompt you to restart when it is ready.`
        };
      }

      return {
        status: "current",
        canUpdate: true,
        currentVersion,
        latestVersion: availableVersion,
        message: "Hydra is up to date.",
        detail: `Current version: ${currentVersion}. ${support.reason}`
      };
    } catch (error: unknown) {
      const detail = formatUpdaterLogMessage(error);
      logUpdater("error", `check failed (manual): ${detail}`);
      return {
        status: "error",
        canUpdate: true,
        currentVersion,
        latestVersion: null,
        message: "The update check failed.",
        detail: `Current version: ${currentVersion}. Error: ${detail}`
      };
    } finally {
      updateCheckInFlight = false;
    }
  }

  async initialize(): Promise<void> {
    const [, state, lazygitPath] = await Promise.all([
      this.authMainSetup,
      loadState(),
      resolveCommandPath("lazygit")
    ]);

    this.state = state;
    this.lazygitPath = lazygitPath;
    this.tokscalePath = resolveTokscaleBinaryPath();
    this.normalizeFolderRepos();
    this.repairStoredTranscripts();
    this.watchPlansDir();
  }

  private resolveAuthServerUrl(): string {
    // 1. Environment variable (set at build time for production)
    if (process.env.AUTH_SERVER_URL) {
      return process.env.AUTH_SERVER_URL;
    }

    // 2. Read from bundled auth-config.json
    try {
      const configPath = path.join(__dirname, "..", "renderer", "auth-config.json");
      const raw = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw);
      if (config?.authServerUrl) return config.authServerUrl;
    } catch {
      // ignore
    }

    // 3. Default to localhost for development
    return "http://localhost:8787";
  }

  createWindow(): void {
    this.window = new BrowserWindow({
      width: 1500,
      height: 960,
      minWidth: 1100,
      minHeight: 720,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#2b2b2b" : "#ede6dc",
      title: "Hydra",
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

    const denyUnexpectedNavigation = (
      event: { preventDefault: () => void },
      navigationUrl: string
    ) => {
      if (!isTrustedRendererUrl(navigationUrl)) {
        event.preventDefault();
      }
    };

    window.webContents.on("will-navigate", denyUnexpectedNavigation);
    window.webContents.on("will-redirect", denyUnexpectedNavigation);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    // Auth gate: check for valid session before loading the main app
    this.loadAuthenticatedPage(window);
  }

  private async loadAuthenticatedPage(window: ElectronBrowserWindow): Promise<void> {
    try {
      const session = await this.authClient?.initialize();
      if (window.isDestroyed()) return;
      if (session) {
        window.loadFile(TRUSTED_RENDERER_ENTRY_PATH);
      } else {
        window.loadFile(TRUSTED_AUTH_ENTRY_PATH);
      }
    } catch {
      if (window.isDestroyed()) return;
      // If auth check fails (e.g. server unreachable), show auth page
      window.loadFile(TRUSTED_AUTH_ENTRY_PATH);
    }
  }

  private async handleAuthSessionChanged(session: AuthSession | null): Promise<void> {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    const currentUrl = this.window.webContents.getURL();
    if (session && currentUrl.endsWith("/auth.html")) {
      await this.window.loadFile(TRUSTED_RENDERER_ENTRY_PATH);
    } else if (!session && !currentUrl.endsWith("/auth.html")) {
      await this.window.loadFile(TRUSTED_AUTH_ENTRY_PATH);
    }
  }

  setupIpc(): void {
    ipcMain.handle("state:get", () => this.snapshot());
    ipcMain.handle("workspace:open", async () => this.openWorkspaceFolder());
    ipcMain.handle("project:create", async () => this.createProjectFolder());
    ipcMain.handle("app:checkForUpdates", async () => this.checkForUpdates());
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
    ipcMain.handle("session:restart", (_event, payload: SessionRestartRequest) =>
      this.restartSession(payload.sessionId)
    );
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
    // ---- Auth IPC handlers ----
    ipcMain.handle("auth:signIn", async (_event, payload) => {
      if (!this.authClient) return { success: false, error: "Auth not initialized." };
      const result = await this.authClient.signIn(payload.email, payload.password);
      if (result.success && this.window) {
        this.window.loadFile(TRUSTED_RENDERER_ENTRY_PATH);
      }
      return result;
    });
    ipcMain.handle("auth:signUp", async (_event, payload) => {
      if (!this.authClient) return { success: false, error: "Auth not initialized." };
      const result = await this.authClient.signUp(payload.name, payload.email, payload.password);
      if (result.success && this.window) {
        this.window.loadFile(TRUSTED_RENDERER_ENTRY_PATH);
      }
      return result;
    });
    ipcMain.handle("auth:signOut", async () => {
      if (!this.authClient) return;
      try {
        await this.authClient.signOut();
      } finally {
        // Always navigate back to auth page, even if signOut throws
        if (this.window && !this.window.isDestroyed()) {
          this.window.loadFile(TRUSTED_AUTH_ENTRY_PATH);
        }
      }
    });
    ipcMain.handle("auth:openPage", async () => {
      if (this.window) {
        await this.window.loadFile(TRUSTED_AUTH_ENTRY_PATH);
      }
    });
    ipcMain.handle("auth:startProvider", async (_event, payload) => {
      if (!this.authClient) return { success: false, error: "Auth not initialized." };
      try {
        await this.authClient.requestAuth({ provider: payload?.provider });
        return { success: true };
      } catch (error: unknown) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unable to start provider sign in."
        };
      }
    });
    ipcMain.handle("auth:signInWithProvider", async (_event, payload) => {
      if (!this.authClient) return { success: false, error: "Auth not initialized." };
      try {
        await this.authClient.requestAuth({ provider: payload?.provider });
        return { success: true };
      } catch (error: unknown) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unable to start provider sign in."
        };
      }
    });
    ipcMain.handle("auth:getSession", async () => {
      if (!this.authClient) return null;
      return this.authClient.getSession();
    });
    ipcMain.handle("auth:resetPassword", async (_event, payload) => {
      if (!this.authClient) return { success: false, error: "Auth not initialized." };
      return this.authClient.requestPasswordReset(payload.email, payload.redirectUrl);
    });
    ipcMain.handle("auth:verifyTotp", async (_event, payload) => {
      if (!this.authClient) return { success: false, error: "Auth not initialized." };
      return this.authClient.verifyTotp(payload.code);
    });

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

  settingsRepoPaths(repoId: string | null | undefined): string[] {
    if (!repoId) {
      return [];
    }

    const repo = this.repoById(repoId);
    return repo?.path ? [repo.path] : [];
  }

  assertRepoFilePath(repoId: string | null | undefined, filePath: string | null | undefined): string {
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

  assertRepoRelativeFilePath(
    repoId: string | null | undefined,
    relativePath: string | null | undefined
  ): string {
    const repo = this.repoById(repoId);
    if (!repo?.path) {
      throw new Error("Project not found.");
    }

    const value = typeof relativePath === "string" ? relativePath.trim() : "";
    if (!value) {
      throw new Error("File path is required.");
    }

    const normalizedRepoPath = path.resolve(repo.path);
    const normalizedRelativePath = value.replace(/^[/\\]+/, "");
    const normalizedFilePath = path.resolve(normalizedRepoPath, normalizedRelativePath);
    if (!isPathWithinRoot(normalizedFilePath, normalizedRepoPath)) {
      throw new Error("File access denied for the requested path.");
    }

    return normalizedFilePath;
  }

  async revealTrustedPath(payload: ClaudePathRevealRequest): Promise<void> {
    switch (payload?.scope) {
      case "repo-file":
        shell.showItemInFolder(this.assertRepoFilePath(payload.repoId, payload.filePath));
        return;
      case "repo-relative-file":
        shell.showItemInFolder(
          this.assertRepoRelativeFilePath(payload.repoId, payload.relativePath)
        );
        return;
      case "settings-file":
        shell.showItemInFolder(
          assertReadableClaudeSettingsFilePath(payload.filePath, this.settingsRepoPaths(payload.repoId))
        );
        return;
      case "session-search-result": {
        const repo = this.repoById(payload.repoId);
        if (
          !repo?.path ||
          !(await isSessionSearchResultPathForRepo(payload.filePath, repo.path))
        ) {
          throw new Error("Session search reveal denied for the requested path.");
        }

        shell.showItemInFolder(normalizeAbsolutePath(payload.filePath, "file path"));
        return;
      }
      default:
        throw new Error("Unsupported reveal request.");
    }
  }

  async openTrustedExternalUrl(payload: ClaudeExternalUrlRequest): Promise<void> {
    switch (payload?.scope) {
      case "github-url":
        await shell.openExternal(assertTrustedGitHubUrl(payload.url));
        return;
      default:
        throw new Error("Unsupported external URL request.");
    }
  }

  setupMenu(): void {
    const kb = resolveKeybindings(this.state.preferences.keybindings);
    const template = [
      {
        label: "Hydra",
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

  /**
   * Dispatch MCP tool mutations to existing controller methods.
   * This avoids duplicating IPC handler logic — every mutation tool
   * routes through here to the same method the renderer uses.
   */
  async handleMcpAction<Action extends McpActionName>(
    action: Action,
    args: McpActionArgs<Action>
  ): Promise<McpActionResult<Action>> {
    const parseArgs = <ExpectedAction extends McpActionName>(
      expectedAction: ExpectedAction
    ): McpActionArgs<ExpectedAction> => parseMcpActionArgs(expectedAction, args);

    switch (action) {
      // Session mutations
      case "create_session": {
        const parsedArgs = parseArgs("create_session");
        return this.createSession(
          parsedArgs.repoId,
          parsedArgs.autoLaunch ?? true
        ) as McpActionResult<Action>;
      }
      case "rename_session": {
        const parsedArgs = parseArgs("rename_session");
        return this.renameSession(parsedArgs.sessionId, parsedArgs.title) as McpActionResult<Action>;
      }
      case "close_session": {
        const parsedArgs = parseArgs("close_session");
        return this.closeSession(parsedArgs.sessionId) as McpActionResult<Action>;
      }
      case "reopen_session": {
        const parsedArgs = parseArgs("reopen_session");
        return this.reopenSession(parsedArgs.sessionId) as McpActionResult<Action>;
      }
      case "organize_session": {
        const parsedArgs = parseArgs("organize_session");
        const organizeArgs = normalizeOrganizeSessionArgs(parsedArgs);
        return this.updateSessionOrganization(organizeArgs.sessionId, {
          isPinned: organizeArgs.isPinned,
          tagColor: organizeArgs.tagColor,
          repoID: organizeArgs.repoId,
        }) as McpActionResult<Action>;
      }
      case "search_sessions": {
        const parsedArgs = parseArgs("search_sessions");
        return await this.querySessionFiles(
          parsedArgs.repoId,
          parsedArgs.query
        ) as McpActionResult<Action>;
      }
      case "resume_session": {
        const parsedArgs = parseArgs("resume_session");
        return this.resumeFromSearchResult(
          parsedArgs.repoId,
          parsedArgs.source || "claude",
          parsedArgs.externalSessionId
        ) as McpActionResult<Action>;
      }

      // Workspace / repo mutations
      case "add_workspace": {
        const parsedArgs = parseArgs("add_workspace");
        return await this.addWorkspace(parsedArgs.path) as McpActionResult<Action>;
      }
      case "rescan_workspace": {
        const parsedArgs = parseArgs("rescan_workspace");
        return await this.rescanWorkspace(parsedArgs.workspaceId) as McpActionResult<Action>;
      }
      case "set_build_run_config": {
        const parsedArgs = parseArgs("set_build_run_config");
        return this.updateRepoAppLaunchConfig(parsedArgs.repoId, {
          buildCommand: parsedArgs.buildCommand,
          runCommand: parsedArgs.runCommand,
        }) as McpActionResult<Action>;
      }
      case "build_and_run_app": {
        const parsedArgs = parseArgs("build_and_run_app");
        return this.buildAndRunApp(parsedArgs.repoId) as McpActionResult<Action>;
      }
      case "list_files": {
        const parsedArgs = parseArgs("list_files");
        const repo = this.repoById(parsedArgs.repoId);
        if (!repo) {
          return null as McpActionResult<Action>;
        }
        return {
          path: repo.path,
          tree: await buildFileTree(repo.path, repo.path, 0)
        } as McpActionResult<Action>;
      }
      case "read_file": {
        const parsedArgs = parseArgs("read_file");
        const filePath = this.assertRepoFilePath(parsedArgs.repoId, parsedArgs.path);
        const stats = await fsp.stat(filePath);
        if (stats.size > 512 * 1024) {
          return {
            content: null,
            tooLarge: true,
            size: stats.size
          } as McpActionResult<Action>;
        }
        const buffer = await fsp.readFile(filePath);
        return {
          content: buffer.toString("utf-8"),
          tooLarge: false
        } as McpActionResult<Action>;
      }

      // Preferences
      case "update_preferences": {
        const parsedArgs = parseArgs("update_preferences");
        return this.updatePreferences(
          extractPreferencesPatch(parsedArgs)
        ) as McpActionResult<Action>;
      }

      // Settings files
      case "get_settings_context": {
        const parsedArgs = parseArgs("get_settings_context");
        return await buildClaudeSettingsContext(
          this.repoById(parsedArgs.repoId) || null
        ) as McpActionResult<Action>;
      }
      case "load_settings_file": {
        const parsedArgs = parseArgs("load_settings_file");
        return await readClaudeSettingsFile(
          parsedArgs.filePath,
          this.settingsRepoPaths(parsedArgs.repoId)
        ) as McpActionResult<Action>;
      }
      case "save_settings_file": {
        const parsedArgs = parseArgs("save_settings_file");
        await writeClaudeSettingsFile(
          parsedArgs.filePath,
          parsedArgs.content,
          this.settingsRepoPaths(parsedArgs.repoId)
        );
        return { ok: true } as McpActionResult<Action>;
      }

      // Wiki
      case "get_wiki": {
        const parsedArgs = parseArgs("get_wiki");
        return await this.projectWikiContext(parsedArgs.repoId) as McpActionResult<Action>;
      }
      case "read_wiki_page": {
        const parsedArgs = parseArgs("read_wiki_page");
        return await this.projectWikiFile(
          parsedArgs.repoId,
          parsedArgs.path
        ) as McpActionResult<Action>;
      }
      case "toggle_wiki": {
        const parsedArgs = parseArgs("toggle_wiki");
        return await this.toggleProjectWiki(
          parsedArgs.repoId,
          parsedArgs.enabled
        ) as McpActionResult<Action>;
      }

      // Marketplace
      case "get_skill_details": {
        const parsedArgs = parseArgs("get_skill_details");
        return await getMarketplaceSkillDetails(
          normalizeMarketplaceSkillDetailsArgs(parsedArgs)
        ) as McpActionResult<Action>;
      }
      case "inspect_skill_url": {
        const parsedArgs = parseArgs("inspect_skill_url");
        return await inspectMarketplaceGitHubUrl(parsedArgs) as McpActionResult<Action>;
      }
      case "install_skill": {
        const parsedArgs = parseArgs("install_skill");
        return await installMarketplaceSkill(
          normalizeMarketplaceInstallArgs(parsedArgs)
        ) as McpActionResult<Action>;
      }

      // Monitoring
      case "get_port_status":
        return await inspectTrackedPorts() as McpActionResult<Action>;
      case "launch_ephemeral_tool": {
        const parsedArgs = parseArgs("launch_ephemeral_tool");
        return this.createEphemeralToolSession(
          parsedArgs.toolId,
          parsedArgs.repoId
        ) as McpActionResult<Action>;
      }
      case "close_ephemeral_tool": {
        const parsedArgs = parseArgs("close_ephemeral_tool");
        return this.closeEphemeralToolSession(
          parsedArgs.toolId,
          parsedArgs.sessionId
        ) as McpActionResult<Action>;
      }
    }

    throw new Error(`Unknown MCP action: ${String(action)}`);
  }

  snapshot(): AppStateSnapshot {
    return structuredClone({
      ...this.state,
      lazygitInstalled: this.lazygitPath !== null,
      tokscaleInstalled: this.tokscalePath !== null,
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

  broadcastState(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send("state:changed", this.snapshot());
    }
    // Notify MCP subscribers
    if (this.mcpServer) {
      this.mcpServer.notifyResourceChanged("hydra://state");
      this.mcpServer.notifyResourceChanged("hydra://sessions");
    }
  }

  sendSessionUpdated(sessionId: string): void {
    const session = this.sessionById(sessionId);
    if (!this.window || this.window.isDestroyed() || !session) {
      return;
    }

    this.window.webContents.send("session:updated", {
      session: summarizeSession(session)
    });
  }

  sendSessionOutput(sessionId: string, data: string): void {
    const session = this.sessionById(sessionId);
    if (this.window && !this.window.isDestroyed() && session) {
      this.window.webContents.send("session:output", {
        sessionId,
        data,
        session: summarizeSession(session)
      });
    }
    // Notify MCP subscribers about session output
    if (this.mcpServer) {
      this.mcpServer.notifyResourceChanged(`hydra://sessions/${sessionId}`);
      this.mcpServer.notifyResourceChanged(`hydra://sessions/${sessionId}/transcript`);
    }
  }

  sendCommand(command: string, payload: Omit<AppCommandPayload, "command"> = {}): void {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    this.window.webContents.send("app:command", { command, ...payload });
  }

  sendEphemeralToolOutput(payload: EphemeralToolOutputPayload): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("ephemeralTool:output", payload);
  }

  sendEphemeralToolExit(payload: EphemeralToolExitPayload): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("ephemeralTool:exit", payload);
  }

  sendPlanDetected(sessionId: string, markdown: string): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send("plan:detected", { sessionId, markdown });
    }
    // Notify MCP subscribers about plan
    if (this.mcpServer) {
      this.mcpServer.notifyResourceChanged(`hydra://sessions/${sessionId}`);
    }
  }

  watchPlansDir(): void {
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

  scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushStateSave();
    }, 200);
  }

  async persistNow(options: PersistStateOptions = {}): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    await this.flushStateSave(options);
  }

  flushStateSave(options: PersistStateOptions = {}): Promise<void> {
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(() => saveState(this.state));

    return this.saveChain.catch((error: unknown) => {
      console.error("Failed to save app state.", error);
      if (options.throwOnError) {
        throw error;
      }
    });
  }

  async openWorkspaceFolder(): Promise<void> {
    const result = await dialog.showOpenDialog(this.window, {
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Open Folder"
    });

    if (result.canceled || result.filePaths.length === 0) {
      return;
    }

    await this.addWorkspace(result.filePaths[0]);
  }

  async createProjectFolder(): Promise<void> {
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

  async addWorkspace(rootPath: string): Promise<void> {
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

  async rescanWorkspace(workspaceId: string): Promise<void> {
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

  createSession(repoId: string, launchesClaudeOnStart?: boolean): string | null {
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
      runtimeState: "launching",
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
    const launchMsg = "Launching opencode...\n";
    this.terminalBuffers.set(session.id, new TerminalTranscriptBuffer(launchMsg));
    session.transcript = launchMsg;
    this.broadcastState();

    if (startupAgentId) {
      invalidateSessionSearchCache(repo.path);
    }

    setImmediate(() => {
      this.launchRuntime(session, repo);
      session.runtimeState = "live";
      this.scheduleSave();
      this.broadcastState();
    });

    return session.id;
  }

  renameSession(sessionId: string, title: string): boolean {
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

  updateSessionOrganization(
    sessionId: string,
    patch: SessionOrganizationPatch | null | undefined
  ): boolean {
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

  async importSessionIcon(sessionId: string): Promise<SessionSummary | null> {
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

  async clearSessionIcon(sessionId: string): Promise<boolean> {
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

  reopenSession(sessionId: string): void {
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

  restartSession(sessionId: string): void {
    const session = this.sessionById(sessionId);
    if (!session) {
      return;
    }

    if (session.runtimeState === "live") {
      if (this.pendingSessionRestarts.has(sessionId)) {
        return;
      }

      this.pendingSessionRestarts.set(sessionId, { requestedAt: now() });
      this.cancelPendingAgentLaunch(sessionId);
      this.queuedSessionLaunches.delete(sessionId);
      this.resetSignalTracking(sessionId);
      this.ptyHost.killSession(sessionId);
      return;
    }

    this.startRestartedSession(sessionId);
  }

  closeSession(sessionId: string): void {
    const session = this.sessionById(sessionId);
    this.pendingSessionRestarts.delete(sessionId);
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

  setFocusedSession(sessionId: string | null): void {
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

  revealRepo(repoId: string): void {
    const repo = this.repoById(repoId);
    if (!repo) {
      return;
    }

    shell.showItemInFolder(repo.path);
  }

  showRepoContextMenu(repoId: string, position: Point | null | undefined): void {
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

    const x = Number.isFinite(position?.x) ? position?.x : undefined;
    const y = Number.isFinite(position?.y) ? position?.y : undefined;

    menu.popup({
      window: this.window,
      x,
      y
    });
  }

  nextUnreadSession(): string | null {
    const next = this.inboxSessions()[0];
    return next ? next.id : null;
  }

  async querySessionFiles(repoId: string | null, query: string): Promise<SessionSearchResponse> {
    const repo = this.repoById(repoId);
    if (!repo) {
      return {
        ok: false,
        error: "Select a project before searching session files.",
        installCommand: process.platform === "win32" ? "scoop install fzf ripgrep" : "brew install fzf ripgrep",
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

  resumeFromClaudeSession(repoId: string, claudeSessionId: string): string | null {
    return this.resumeFromSearchResult(repoId, "claude", claudeSessionId);
  }

  resumeFromSearchResult(
    repoId: string,
    source: SessionSearchSource,
    externalSessionId: string | null
  ): string | null {
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

  normalizeFolderRepos(): void {
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

  updatePreferences(patch: unknown): void {
    const sanitizedPatch = sanitizePreferencesPatch(patch);
    const nextPreferences = normalizePreferences({
      ...this.state.preferences,
      ...sanitizedPatch,
      agentCommandOverrides: {
        ...(this.state.preferences.agentCommandOverrides || {}),
        ...(sanitizedPatch.agentCommandOverrides || {})
      }
    });
    this.state.preferences = nextPreferences;

    if (sanitizedPatch.keybindings) {
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
      throw new Error("Build and run commands must each be a single command with optional quoted arguments.");
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
  ): string | null {
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

  launchRuntime(session: SessionRecord, repo: RepoRecord): void {
    this.cancelPendingAgentLaunch(session.id);
    const appLaunchCommand =
      session.launchProfile === "appLaunch"
        ? resolvedAppLaunchCommand(repo)
        : null;

    if (appLaunchCommand) {
      this.ptyHost.createSession({
        sessionId: session.id,
        cwd: repo.path,
        command: appLaunchCommand.command,
        env: appLaunchCommand.env
      });
      return;
    }

    const agentLaunchCommand =
      session.launchProfile === "agent"
        ? resolvedSessionLaunchCommand(this.state.preferences, session)
        : null;

    if (agentLaunchCommand) {
      this.ptyHost.createSession({
        sessionId: session.id,
        cwd: repo.path,
        command: agentLaunchCommand.command,
        env: agentLaunchCommand.env
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
      return this.tokscalePath ? [this.tokscalePath, "tui"] : null;
    }

    return null;
  }

  createEphemeralToolSession(toolId: EphemeralToolId, repoId: string): string | null {
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

  closeEphemeralToolSession(toolId: EphemeralToolId, sessionId: string): void {
    if (!this.isEphemeralToolSession(sessionId, toolId)) return;
    this.ephemeralSessions.delete(sessionId);
    this.ptyHost.killSession(sessionId);
  }

  handleEphemeralToolInput(toolId: EphemeralToolId, sessionId: string, data: string): void {
    if (this.isEphemeralToolSession(sessionId, toolId)) {
      this.ptyHost.sendInput(sessionId, data);
    }
  }

  handleEphemeralToolResize(
    toolId: EphemeralToolId,
    sessionId: string,
    cols: number,
    rows: number
  ): void {
    if (this.isEphemeralToolSession(sessionId, toolId)) {
      this.ptyHost.resizeSession(sessionId, cols, rows);
    }
  }

  handleSessionInput(sessionId: string, data: string): void {
    this.ptyHost.sendInput(sessionId, data);
    this.resolveInteractiveBlockerFromInput(sessionId, data);
  }

  handlePtyMessage(message: PtyHostMessage): void {
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

  handleHostCreated(sessionId: string): void {
    const session = this.sessionById(sessionId);
    if (!session) {
      return;
    }

    this.flushQueuedSessionLaunch(sessionId);
  }

  handleHostData(sessionId: string, rawChunk: string): void {
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

  handleHostExit(sessionId: string, exitCode: number): void {
    const session = this.sessionById(sessionId);
    if (!session) {
      return;
    }

    if (this.pendingSessionRestarts.delete(sessionId)) {
      this.startRestartedSession(sessionId);
      return;
    }

    this.cancelPendingAgentLaunch(sessionId);
    this.queuedSessionLaunches.delete(sessionId);
    this.resetSignalTracking(sessionId);
    this.sessionSizes.delete(sessionId);

    // Agent/appLaunch sessions fall back to a plain shell instead of blocking
    // the terminal with a "paused" overlay.
    if (session.launchProfile === "agent" || session.launchProfile === "appLaunch") {
      this.fallbackToShell(session, exitCode);
      return;
    }

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

  /** Transition an agent session into a live shell after the agent process exits. */
  private fallbackToShell(session: SessionRecord, exitCode: number): void {
    const repo = this.repoById(session.repoID);
    if (!repo) {
      // No repo — can't launch a shell, fall through to stopped state.
      session.runtimeState = "stopped";
      session.stoppedAt = now();
      session.updatedAt = now();
      session.status = exitCode === 0 ? "done" : "failed";
      session.blocker = null;
      this.scheduleSave();
      this.sendSessionUpdated(session.id);
      return;
    }

    const banner =
      exitCode === 0
        ? `\r\n[Agent exited. Shell is ready.]\r\n`
        : `\r\n[Agent exited with status ${exitCode}. Shell is ready.]\r\n`;

    session.launchProfile = "shell";
    session.launchesClaudeOnStart = false;
    session.status = "running";
    session.blocker = null;
    session.runtimeState = "live";
    session.updatedAt = now();

    session.rawTranscript = trimRawTranscript(`${session.rawTranscript || ""}${banner}`);
    session.transcript = trimTranscript(
      this.terminalBuffer(session.id, session.transcript).consume(banner)
    );

    this.sendSessionOutput(session.id, banner);

    this.ptyHost.createSession({
      sessionId: session.id,
      cwd: repo.path,
      shellPath: resolvedShellPath(this.state.preferences)
    });

    this.scheduleSave();
    this.sendSessionUpdated(session.id);
  }

  startRestartedSession(sessionId: string): void {
    const session = this.sessionById(sessionId);
    const repo = session ? this.repoById(session.repoID) : null;
    if (!session || !repo) {
      return;
    }

    const defaultAgentId = normalizeAgentId(this.state.preferences.defaultAgentId) || DEFAULT_AGENT_ID;
    const defaultAgentLabel = AGENT_LABELS[defaultAgentId] || "Default Agent";
    const banner = `[Session restarted with ${defaultAgentLabel} ${timestampLabel()}]`;
    const bannerChunk = `\r\n${banner}\r\n`;

    this.cancelPendingAgentLaunch(sessionId);
    this.queuedSessionLaunches.delete(sessionId);
    session.launchProfile = "agent";
    session.initialPrompt = "";
    session.launchesClaudeOnStart = true;
    session.startupAgentId = defaultAgentId;
    session.claudeSessionId = defaultAgentId === DEFAULT_AGENT_ID ? session.id : null;
    session.agentSessionId = defaultAgentId === DEFAULT_AGENT_ID ? session.id : null;
    session.runtimeState = "live";
    session.status = "running";
    session.blocker = null;
    session.unreadCount = 0;
    session.lastActivityAt = null;
    session.stoppedAt = null;
    session.launchCount = 1;
    session.updatedAt = now();

    invalidateSessionSearchCache(repo.path);
    session.rawTranscript = trimRawTranscript(`${session.rawTranscript || ""}${bannerChunk}`);
    session.transcript = trimTranscript(this.terminalBuffer(session.id, session.transcript).consume(bannerChunk));
    this.resetSignalTracking(session.id);

    this.launchRuntime(session, repo);
    this.scheduleSave();
    this.broadcastState();
  }

  terminalBuffer(sessionId: string, seedText = ""): TerminalTranscriptBufferInstance {
    let buffer = this.terminalBuffers.get(sessionId);

    if (!buffer) {
      buffer = new TerminalTranscriptBuffer(seedText || "");
      this.terminalBuffers.set(sessionId, buffer);
    }

    return buffer;
  }

  createShellSession(repoId: string, title?: string, queuedInput?: string): string | null {
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

  createAppLaunchSession(repoId: string, title?: string): string | null {
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

  queueSessionLaunch(sessionId: string, input: string, title?: string): void {
    this.queuedSessionLaunches.set(sessionId, {
      input,
      title
    });
  }

  flushQueuedSessionLaunch(sessionId: string): void {
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

  repairStoredTranscripts(): void {
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

  notifyBlocker(session: SessionRecord): void {
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

  appendSignalBuffer(sessionId: string, visibleChunk: string): string {
    const next = `${this.signalBuffers.get(sessionId) || ""}${visibleChunk || ""}`;
    const trimmed = next.length > 1600 ? next.slice(-1600) : next;
    this.signalBuffers.set(sessionId, trimmed);
    return trimmed;
  }

  resolveInteractiveBlockerFromInput(sessionId: string, data: string): void {
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

  resetSignalTracking(sessionId: string): void {
    this.signalBuffers.delete(sessionId);
    this.blockerClearStreaks.delete(sessionId);
  }

  repoById(repoId: string | null | undefined): RepoRecord | null {
    return this.state.repos.find((repo) => repo.id === repoId) || null;
  }

  async projectWikiContext(repoId: string): Promise<WikiContext | null> {
    const repo = this.repoById(repoId);
    if (!repo) {
      return null;
    }

    return getWikiContext(repo.path, repo.wikiEnabled);
  }

  async projectWikiFile(repoId: string, relativePath: string): Promise<WikiFileContents> {
    const repo = this.repoById(repoId);
    if (!repo) {
      throw new Error("Folder not found.");
    }

    return readWikiFile(repo.path, relativePath);
  }

  async toggleProjectWiki(repoId: string, enabled: boolean): Promise<WikiContext | null> {
    const repo = this.repoById(repoId);
    if (!repo) {
      return null;
    }

    if (enabled) {
      await enableWiki(repo.path);
    } else {
      await disableWiki(repo.path);
    }

    invalidateWikiExistsSyncCache(repo.path);
    repo.wikiEnabled = enabled;
    repo.updatedAt = now();
    this.scheduleSave();
    this.broadcastState();
    return this.projectWikiContext(repoId);
  }

  async revealProjectWiki(repoId: string): Promise<void> {
    const repo = this.repoById(repoId);
    if (!repo) {
      return;
    }

    const targetPath = (await wikiExists(repo.path)) ? wikiDirectoryPath(repo.path) : repo.path;
    shell.showItemInFolder(targetPath);
  }

  sessionById(sessionId: string | null | undefined): SessionRecord | null {
    return this.state.sessions.find((session) => session.id === sessionId) || null;
  }

  inboxSessions(): SessionRecord[] {
    return [...this.state.sessions]
      .filter((session) => session.blocker || session.unreadCount > 0)
      .sort(compareInboxSessions);
  }

  async confirmQuit(event: ElectronEvent): Promise<void> {
    if (this.allowQuit) {
      return;
    }

    event.preventDefault();
    if (this.shutdownPromise) {
      return;
    }

    const liveSessions = this.state.sessions.filter((session) => session.runtimeState === "live");
    if (liveSessions.length === 0) {
      try {
        await this.shutdown();
        this.allowQuit = true;
        app.quit();
      } catch (error: unknown) {
        console.error("Failed to shut down Hydra before quit.", error);
        await dialog.showMessageBox({
          type: "error",
          title: "Quit failed",
          message: "Hydra could not quit cleanly.",
          detail: `Hydra kept running because shutdown did not complete. Error: ${formatUpdaterLogMessage(error)}`,
          buttons: ["OK"]
        });
      }
      return;
    }

    const result = dialog.showMessageBoxSync(this.window, {
      type: "warning",
      buttons: ["Cancel", "Quit and Terminate Sessions"],
      defaultId: 1,
      cancelId: 0,
      title: "Quit Hydra",
      message: `Quitting will terminate ${liveSessions.length} running session${liveSessions.length === 1 ? "" : "s"}.`
    });

    if (result === 0) {
      return;
    }

    try {
      await this.shutdown();
      this.allowQuit = true;
      app.quit();
    } catch (error: unknown) {
      console.error("Failed to shut down Hydra before quit.", error);
      await dialog.showMessageBox({
        type: "error",
        title: "Quit failed",
        message: "Hydra could not quit cleanly.",
        detail: `Hydra kept running because shutdown did not complete. Error: ${formatUpdaterLogMessage(error)}`,
        buttons: ["OK"]
      });
    }
  }

  async restartToInstallUpdate(version?: string | null): Promise<void> {
    const liveSessions = this.state.sessions.filter((session) => session.runtimeState === "live");
    if (liveSessions.length > 0) {
      const result = dialog.showMessageBoxSync(this.window, {
        type: "warning",
        buttons: ["Later", "Restart and Install Update"],
        defaultId: 1,
        cancelId: 0,
        title: "Restart Hydra to Update",
        message: `Restarting to install the update will terminate ${liveSessions.length} running session${liveSessions.length === 1 ? "" : "s"}.`
      });

      if (result === 0) {
        return;
      }
    }

    const targetVersion = typeof version === "string" && version.trim()
      ? version.trim()
      : this.downloadedUpdateVersion;

    this.updateInstallInProgress = true;
    try {
      await this.shutdown();
      this.allowQuit = true;
      this.scheduleUpdateInstallWatchdog(targetVersion);
      logUpdater(
        "info",
        `restart requested to install ${this.describeDownloadedUpdate(targetVersion)} from ${app.getVersion()}`
      );
      autoUpdater.quitAndInstall();
    } catch (error: unknown) {
      await this.handleUpdaterError(error, targetVersion);
    }
  }

  async shutdown(): Promise<void> {
    const pendingShutdown = this.shutdownPromise || this.performShutdown();
    this.shutdownPromise = pendingShutdown;

    try {
      await pendingShutdown;
    } finally {
      if (this.shutdownPromise === pendingShutdown) {
        this.shutdownPromise = null;
      }
    }
  }

  async performShutdown(): Promise<void> {
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
    await this.persistNow({ throwOnError: true });
  }

  handleSessionResize(sessionId: string, cols: number, rows: number): void {
    const safeCols = Math.max(1, Number(cols) || 1);
    const safeRows = Math.max(1, Number(rows) || 1);

    this.sessionSizes.set(sessionId, {
      cols: safeCols,
      rows: safeRows
    });
    this.ptyHost.resizeSession(sessionId, safeCols, safeRows);
  }

  cancelPendingAgentLaunch(sessionId: string): void {
    this.pendingAgentLaunch.delete(sessionId);

    const timer = this.pendingAgentLaunchTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.pendingAgentLaunchTimers.delete(sessionId);
    }
  }
}

function summarizeSession(session: SessionRecord): SessionSummary {
  return {
    id: session.id,
    repoID: session.repoID,
    title: session.title,
    launchProfile: session.launchProfile,
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
    transcript: session.transcript,
    rawTranscript: session.rawTranscript
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
  if (candidate) return candidate;
  if (process.platform === "win32") {
    return process.env.COMSPEC || "cmd.exe";
  }
  return process.env.SHELL || "/bin/sh";
}

function resolvedAppLaunchCommand(repo: RepoRecord | null | undefined): ResolvedCommandPayload | null {
  const config = repo?.appLaunchConfig;
  if (!config) {
    return null;
  }

  const buildCommand = parseCommandSpec(config.buildCommand);
  const runCommand = parseCommandSpec(config.runCommand);
  if (!buildCommand || !runCommand) {
    return null;
  }

  const helperArgs = [
    ...commandSpecToHelperArgs("build", buildCommand),
    ...commandSpecToHelperArgs("run", runCommand)
  ];

  if (process.platform === "win32") {
    return {
      command: [
        "powershell.exe",
        "-ExecutionPolicy", "Bypass",
        "-File", appLaunchRunnerPath(),
        ...helperArgs
      ]
    };
  }

  return {
    command: [
      "/usr/bin/env",
      "bash",
      appLaunchRunnerPath(),
      ...helperArgs
    ]
  };
}

function resolvedSessionLaunchCommand(
  preferences: AppPreferences,
  session: SessionRecord
): ResolvedCommandPayload | null {
  const startupAgentId = normalizeAgentId(session?.startupAgentId, null);
  if (!session?.launchesClaudeOnStart || !startupAgentId) {
    return null;
  }

  const commandSpec = resolvedAgentCommand(preferences, startupAgentId);
  const command = [...commandSpec.argv];
  const env = Object.keys(commandSpec.env).length ? { ...commandSpec.env } : undefined;

  if (startupAgentId === "codex" && session.agentSessionId) {
    return {
      command: [...command, "resume", session.agentSessionId],
      env
    };
  }

  if (startupAgentId !== DEFAULT_AGENT_ID) {
    return {
      command,
      env
    };
  }

  if (session.launchCount > 1) {
    if (session.claudeSessionId) {
      return {
        command: [...command, "--resume", session.claudeSessionId],
        env
      };
    }

    return {
      command: [...command, "--continue"],
      env
    };
  }

  if (session.claudeSessionId) {
    return {
      command: [...command, "--session-id", session.claudeSessionId],
      env
    };
  }

  return {
    command,
    env
  };
}

function resolvedAgentCommand(preferences: AppPreferences, agentId: AgentId): ParsedCommandSpec {
  const candidate = preferences?.agentCommandOverrides?.[agentId];
  const normalized = typeof candidate === "string" ? candidate.trim() : "";
  const fallbackCommand = DEFAULT_AGENT_COMMANDS[agentId] || DEFAULT_AGENT_COMMANDS[DEFAULT_AGENT_ID];
  const commandSpec = parseCommandSpec(normalized) || parseCommandSpec(fallbackCommand) || {
    env: {},
    argv: [fallbackCommand]
  };

  const argv = [...commandSpec.argv];
  if (argv.length > 0) {
    const resolvedExecutablePath = resolveCommandPathSync(argv[0], commandSpec.env.PATH);
    if (resolvedExecutablePath) {
      argv[0] = resolvedExecutablePath;
    }
  }

  return {
    env: {
      ...commandSpec.env,
      PATH: mergeCommandPath(commandSpec.env.PATH)
    },
    argv
  };
}

function appLaunchRunnerPath() {
  if (process.platform === "win32") {
    return resolveBundledHelperPath("app-launch-runner.ps1");
  }
  return resolveBundledHelperPath("app-launch-runner.sh");
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

function isEnabledFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function mcpServerTokenPath() {
  return path.join(app.getPath("userData"), MCP_SERVER_TOKEN_FILE_NAME);
}

function ensureWindowsUserOnlyFileAcl(filePath: string): void {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$path = $args[0]",
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl = Get-Acl -LiteralPath $path",
    "$acl.SetAccessRuleProtection($true, $false)",
    "foreach ($accessRule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($accessRule) }",
    "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')",
    "[void]$acl.AddAccessRule($rule)",
    "Set-Acl -LiteralPath $path -AclObject $acl"
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
      filePath
    ],
    {
      encoding: "utf8",
      windowsHide: true
    }
  );

  if (result.error) {
    throw new Error(
      `Failed to secure MCP auth token file ${filePath}: ${formatUpdaterLogMessage(result.error)}`
    );
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(
      `Failed to secure MCP auth token file ${filePath}: ${detail || `powershell exited with status ${result.status}`}`
    );
  }
}

async function ensureMcpServerTokenFilePermissions(tokenPath: string): Promise<void> {
  if (process.platform === "win32") {
    ensureWindowsUserOnlyFileAcl(tokenPath);
    return;
  }

  await fsp.chmod(tokenPath, 0o600);
}

async function resolveMcpServerAuthToken(): Promise<{ token: string; source: "env" | "file"; path?: string }> {
  const configuredToken = process.env[MCP_SERVER_TOKEN_ENV]?.trim();
  if (configuredToken) {
    return { token: configuredToken, source: "env" };
  }

  const tokenPath = mcpServerTokenPath();

  try {
    const existingToken = (await fsp.readFile(tokenPath, "utf8")).trim();
    if (existingToken) {
      await ensureMcpServerTokenFilePermissions(tokenPath);
      return { token: existingToken, source: "file", path: tokenPath };
    }
  } catch {
    // Generate a new token below when no persisted token exists yet.
  }

  const generatedToken = randomBytes(32).toString("hex");
  await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
  await fsp.writeFile(tokenPath, `${generatedToken}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await ensureMcpServerTokenFilePermissions(tokenPath);

  return { token: generatedToken, source: "file", path: tokenPath };
}

async function maybeStartMcpServer(controller: AppController): Promise<void> {
  if (!isEnabledFlag(process.env[MCP_SERVER_ENABLE_ENV])) {
    console.log(`[MCP] Server disabled. Set ${MCP_SERVER_ENABLE_ENV}=1 to enable.`);
    return;
  }

  const auth = await resolveMcpServerAuthToken();
  controller.mcpServer = await startMcpServer(controller, { authToken: auth.token });

  if (auth.source === "env") {
    console.log(`[MCP] Authentication enabled via ${MCP_SERVER_TOKEN_ENV}.`);
    return;
  }

  console.log(`[MCP] Authentication enabled with token file ${auth.path}.`);
}

function delayMs(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function smokeTranscriptPreview(transcript: string | null | undefined): string {
  const normalized = typeof transcript === "string" ? transcript.replace(/\s+/g, " ").trim() : "";
  if (!normalized) {
    return "";
  }

  return normalized.length > 240 ? normalized.slice(-240) : normalized;
}

function resolvePackagedSmokeTestConfig(): PackagedSmokeTestConfig | null {
  if (!hasCommandLineFlag(SMOKE_TEST_ENABLE_FLAG) && !isEnabledFlag(process.env[SMOKE_TEST_ENABLE_ENV])) {
    return null;
  }

  const workspacePath = resolveCommandLineValue(SMOKE_TEST_WORKSPACE_PATH_FLAG) ||
    process.env[SMOKE_TEST_WORKSPACE_PATH_ENV]?.trim() ||
    "";
  if (!workspacePath) {
    throw new Error(`${SMOKE_TEST_WORKSPACE_PATH_ENV} is required when ${SMOKE_TEST_ENABLE_ENV}=1.`);
  }

  const agentId =
    normalizeAgentId(
      resolveCommandLineValue(SMOKE_TEST_AGENT_ID_FLAG) ||
      process.env[SMOKE_TEST_AGENT_ID_ENV],
      null
    ) ||
    normalizeAgentId("codex", null) ||
    DEFAULT_AGENT_ID;
  const agentCommand =
    resolveCommandLineValue(SMOKE_TEST_AGENT_COMMAND_FLAG) ||
    process.env[SMOKE_TEST_AGENT_COMMAND_ENV]?.trim() ||
    null;
  const expectedOutput =
    resolveCommandLineValue(SMOKE_TEST_EXPECTED_OUTPUT_FLAG) ||
    process.env[SMOKE_TEST_EXPECTED_OUTPUT_ENV]?.trim() ||
    "HYDRA_SMOKE_OK";
  const timeoutMsRaw =
    resolveCommandLineValue(SMOKE_TEST_TIMEOUT_MS_FLAG) ||
    process.env[SMOKE_TEST_TIMEOUT_MS_ENV] ||
    "";
  const timeoutMsValue = Number(timeoutMsRaw);
  const timeoutMs =
    Number.isFinite(timeoutMsValue) && timeoutMsValue >= 1000
      ? Math.min(timeoutMsValue, 120_000)
      : 20_000;
  const userDataDir =
    resolveCommandLineValue(SMOKE_TEST_USER_DATA_DIR_FLAG) ||
    process.env[SMOKE_TEST_USER_DATA_DIR_ENV]?.trim() ||
    null;
  const resultPath =
    resolveCommandLineValue(SMOKE_TEST_RESULT_PATH_FLAG) ||
    process.env[SMOKE_TEST_RESULT_PATH_ENV]?.trim() ||
    null;

  return {
    agentId,
    agentCommand,
    expectedOutput,
    resultPath,
    timeoutMs,
    userDataDir,
    workspacePath
  };
}

function hasCommandLineFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function resolveCommandLineValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) {
    return null;
  }

  const value = process.argv[index + 1]?.trim();
  return value || null;
}

function buildPackagedSmokeTestResult(
  ok: boolean,
  stage: string,
  message: string,
  expectedOutput: string,
  startedAtMs: number,
  session: SessionRecord | null
): PackagedSmokeTestResult {
  return {
    elapsedMs: Date.now() - startedAtMs,
    expectedOutput,
    message,
    ok,
    runtimeState: session?.runtimeState || null,
    sessionId: session?.id || null,
    stage,
    status: session?.status || null,
    transcriptPreview: smokeTranscriptPreview(session?.transcript || "")
  };
}

async function runPackagedSmokeTest(
  controller: AppController,
  config: PackagedSmokeTestConfig
): Promise<PackagedSmokeTestResult> {
  const startedAtMs = Date.now();
  const normalizedWorkspacePath = path.resolve(config.workspacePath);

  await fsp.mkdir(normalizedWorkspacePath, { recursive: true });
  await controller.addWorkspace(normalizedWorkspacePath);
  controller.updatePreferences({
    agentCommandOverrides: config.agentCommand
      ? { [config.agentId]: config.agentCommand }
      : undefined,
    defaultAgentId: config.agentId,
    notificationsEnabled: false,
    showInAppBadges: false,
    showNativeNotifications: false
  });

  const repo = controller.state.repos.find(
    (candidate) => path.resolve(candidate.path) === normalizedWorkspacePath
  ) || null;
  if (!repo) {
    return buildPackagedSmokeTestResult(
      false,
      "workspace",
      `Smoke workspace ${normalizedWorkspacePath} was not added as a repo.`,
      config.expectedOutput,
      startedAtMs,
      null
    );
  }

  const sessionId = controller.createSession(repo.id, true);
  if (!sessionId) {
    return buildPackagedSmokeTestResult(
      false,
      "launch",
      `Failed to create a session for repo ${repo.id}.`,
      config.expectedOutput,
      startedAtMs,
      null
    );
  }

  while (Date.now() - startedAtMs < config.timeoutMs) {
    const session = controller.sessionById(sessionId);
    if (!session) {
      return buildPackagedSmokeTestResult(
        false,
        "launch",
        "Smoke session disappeared before producing output.",
        config.expectedOutput,
        startedAtMs,
        null
      );
    }

    if ((session.transcript || "").includes(config.expectedOutput)) {
      return buildPackagedSmokeTestResult(
        true,
        "output",
        `Observed expected session output: ${config.expectedOutput}`,
        config.expectedOutput,
        startedAtMs,
        session
      );
    }

    if (session.runtimeState === "stopped") {
      return buildPackagedSmokeTestResult(
        false,
        "output",
        `Session stopped before expected output appeared (status: ${session.status}).`,
        config.expectedOutput,
        startedAtMs,
        session
      );
    }

    await delayMs(100);
  }

  return buildPackagedSmokeTestResult(
    false,
    "timeout",
    `Timed out waiting ${config.timeoutMs}ms for session output.`,
    config.expectedOutput,
    startedAtMs,
    controller.sessionById(sessionId)
  );
}

async function writePackagedSmokeTestResult(
  config: PackagedSmokeTestConfig,
  result: PackagedSmokeTestResult
): Promise<void> {
  if (!config.resultPath) {
    return;
  }

  const normalizedResultPath = path.resolve(config.resultPath);
  await fsp.mkdir(path.dirname(normalizedResultPath), { recursive: true });
  await fsp.writeFile(`${normalizedResultPath}`, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

async function finalizePackagedSmokeTest(
  controller: AppController,
  config: PackagedSmokeTestConfig,
  result: PackagedSmokeTestResult
): Promise<void> {
  let finalResult = result;

  try {
    await controller.shutdown();
  } catch (error: unknown) {
    finalResult = {
      ...finalResult,
      elapsedMs: finalResult.elapsedMs,
      message: `Smoke test cleanup failed: ${formatUpdaterLogMessage(error)}`,
      ok: false,
      stage: "cleanup"
    };
  }

  try {
    await writePackagedSmokeTestResult(config, finalResult);
  } catch (error: unknown) {
    console.error("[SMOKE] Failed to write result:", error);
    finalResult = {
      ...finalResult,
      message: `Smoke test result write failed: ${formatUpdaterLogMessage(error)}`,
      ok: false,
      stage: "result"
    };
  }

  console.log(`[SMOKE] ${finalResult.ok ? "PASS" : "FAIL"} ${finalResult.stage}: ${finalResult.message}`);
  if (finalResult.transcriptPreview) {
    console.log(`[SMOKE] transcript: ${finalResult.transcriptPreview}`);
  }

  app.exit(finalResult.ok ? 0 : 1);
}

const controller = new AppController();
const UPDATE_CHECK_STARTUP_DELAY_MS = 15_000;
const UPDATE_CHECK_FOLLOW_UP_DELAY_MS = 10 * 60 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const UPDATE_CHECK_MIN_GAP_MS = 5 * 60 * 1000;
const UPDATE_INSTALL_RESTART_TIMEOUT_MS = 15_000;

let updateCheckInFlight = false;
let lastUpdateCheckAt = 0;

function scheduleUpdateCheck(reason: string, delayMs: number): void {
  const timer = setTimeout(() => {
    void maybeCheckForUpdates(reason);
  }, delayMs);
  timer.unref?.();
}

async function maybeCheckForUpdates(reason: string): Promise<void> {
  if (!app.isPackaged || updateCheckInFlight) {
    return;
  }

  const nowMs = Date.now();
  if (nowMs - lastUpdateCheckAt < UPDATE_CHECK_MIN_GAP_MS) {
    return;
  }

  updateCheckInFlight = true;
  lastUpdateCheckAt = nowMs;
  logUpdater("info", `checking for updates (${reason})`);

  try {
    await autoUpdater.checkForUpdates();
  } catch (error: unknown) {
    logUpdater("error", `check failed (${reason}): ${formatUpdaterLogMessage(error)}`);
  } finally {
    updateCheckInFlight = false;
  }
}

function startAutoUpdateChecks(): void {
  if (!app.isPackaged) {
    return;
  }

  const support = resolveMacAutoUpdateSupport();
  if (!support.enabled) {
    logUpdater("warn", `auto-update disabled: ${support.reason}`);
    return;
  }

  logUpdater("info", `auto-update enabled: ${support.reason}`);
  autoUpdater.logger = updaterLogger;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  scheduleUpdateCheck("startup", UPDATE_CHECK_STARTUP_DELAY_MS);
  scheduleUpdateCheck("startup-follow-up", UPDATE_CHECK_FOLLOW_UP_DELAY_MS);

  const interval = setInterval(() => {
    void maybeCheckForUpdates("interval");
  }, UPDATE_CHECK_INTERVAL_MS);
  interval.unref?.();

  app.on("activate", () => {
    void maybeCheckForUpdates("activate");
  });
  powerMonitor.on("resume", () => {
    void maybeCheckForUpdates("resume");
  });
}

app.whenReady().then(async () => {
  try {
    await controller.initialize();

    if (smokeTestConfig) {
      const result = await runPackagedSmokeTest(controller, smokeTestConfig);
      await finalizePackagedSmokeTest(controller, smokeTestConfig, result);
      return;
    }

    controller.setupIpc();
    controller.setupMenu();
    controller.createWindow();
    maybeStartMcpServer(controller).catch((err) =>
      console.error("[MCP] Server failed to start:", err)
    );
    startAutoUpdateChecks();
  } catch (error: unknown) {
    if (smokeTestConfig) {
      const result = buildPackagedSmokeTestResult(
        false,
        "startup",
        `Smoke test failed during startup: ${formatUpdaterLogMessage(error)}`,
        smokeTestConfig.expectedOutput,
        Date.now(),
        null
      );
      await finalizePackagedSmokeTest(controller, smokeTestConfig, result);
      return;
    }

    console.error("Hydra failed to start:", error);
    app.exit(1);
  }
});

autoUpdater.on("update-available", (info: { version?: string }) => {
  logUpdater("info", `update available${info.version ? `: ${info.version}` : ""}`);
});

autoUpdater.on("update-not-available", (info: { version?: string }) => {
  logUpdater("info", `no update available${info.version ? `; current release: ${info.version}` : ""}`);
});

autoUpdater.on("error", (error: unknown) => {
  void controller.handleUpdaterError(error);
});

autoUpdater.on("update-downloaded", (info: { version?: string }) => {
  controller.noteDownloadedUpdate(info.version);
  void controller.promptToInstallDownloadedUpdate(info.version);
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
