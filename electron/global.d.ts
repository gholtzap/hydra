import type {
  AppCommandPayload,
  AppPreferences,
  AppStateSnapshot,
  ClaudeSettingsContext,
  DirectoryReadResult,
  MarketplaceInspectResponse,
  MarketplaceInstallResponse,
  MarketplaceSkillDetails,
  Point,
  ReadFileResult,
  SessionOrganizationPatch,
  SessionOutputPayload,
  SessionSearchResponse,
  SessionSummary,
  SessionUpdatedPayload,
  TrackedPortStatus,
  WikiContext,
  WikiFileContents
} from "./shared-types";

type Unsubscribe = () => void;

type ClaudePathRevealRequest =
  | { scope: "repo-file"; repoId: string; filePath: string }
  | { scope: "settings-file"; repoId: string | null; filePath: string }
  | { scope: "session-search-result"; repoId: string; filePath: string };

type ClaudeExternalUrlRequest = {
  scope: "marketplace-source";
  url: string;
};

type ClaudeSettingsFileRequest = {
  repoId: string | null;
  filePath: string;
};

type ClaudeSettingsSaveRequest = ClaudeSettingsFileRequest & {
  contents: string;
};

type ClaudeSkillFileRequest = {
  repoId: string | null;
  skillFilePath: string;
};

type ClaudeRepoFileRequest = {
  repoId: string;
  filePath: string;
};

interface ClaudeWorkspaceApi {
  getState: () => Promise<AppStateSnapshot>;
  openWorkspaceFolder: () => Promise<void>;
  createProjectFolder: () => Promise<void>;
  rescanWorkspace: (workspaceId: string) => Promise<void>;
  createSession: (repoId: string, launchesClaudeOnStart: boolean) => Promise<string | null>;
  reopenSession: (sessionId: string) => Promise<void>;
  closeSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<boolean>;
  updateSessionOrganization: (
    sessionId: string,
    patch: SessionOrganizationPatch
  ) => Promise<boolean>;
  importSessionIcon: (sessionId: string) => Promise<SessionSummary | null>;
  clearSessionIcon: (sessionId: string) => Promise<boolean>;
  sendInput: (sessionId: string, data: string) => Promise<void>;
  sendBinaryInput: (sessionId: string, data: string) => Promise<void>;
  resizeSession: (sessionId: string, cols: number, rows: number) => Promise<void>;
  setFocusedSession: (sessionId: string | null) => Promise<void>;
  openRepoInFinder: (repoId: string) => Promise<void>;
  showRepoContextMenu: (
    repoId: string,
    position: Point
  ) => Promise<void>;
  readClipboardText: () => Promise<string>;
  writeClipboardText: (text: string) => Promise<void>;
  revealPath: (payload: ClaudePathRevealRequest) => Promise<void>;
  openExternalUrl: (payload: ClaudeExternalUrlRequest) => Promise<void>;
  nextUnreadSession: () => Promise<string | null>;
  updatePreferences: (patch: Partial<AppPreferences>) => Promise<void>;
  getTrackedPortStatus: () => Promise<TrackedPortStatus>;
  getClaudeSettingsContext: (repoId: string | null) => Promise<ClaudeSettingsContext>;
  loadSettingsFile: (payload: ClaudeSettingsFileRequest) => Promise<string>;
  saveSettingsFile: (payload: ClaudeSettingsSaveRequest) => Promise<void>;
  importSkillIcon: (payload: ClaudeSkillFileRequest) => Promise<string | null>;
  clearSkillIcon: (payload: ClaudeSkillFileRequest) => Promise<boolean>;
  getMarketplaceSkillDetails: (payload: {
    source: {
      owner: string;
      repo: string;
      ref?: string;
      path: string;
      reviewState?: string;
      tags?: string[];
    };
  }) => Promise<MarketplaceSkillDetails>;
  inspectMarketplaceUrl: (payload: { url: string }) => Promise<MarketplaceInspectResponse>;
  installMarketplaceSkill: (payload: {
    source: { owner: string; repo: string; ref?: string; path: string };
    scope: "user" | "project";
    repoPath?: string | null;
  }) => Promise<MarketplaceInstallResponse>;
  getWikiContext: (repoId: string) => Promise<WikiContext | null>;
  readWikiFile: (repoId: string, relativePath: string) => Promise<WikiFileContents>;
  toggleWiki: (repoId: string, enabled: boolean) => Promise<WikiContext | null>;
  revealWiki: (repoId: string) => Promise<void>;
  querySessionSearch: (repoId: string | null, query: string) => Promise<SessionSearchResponse>;
  resumeFromClaudeSession: (repoId: string, claudeSessionId: string) => Promise<string | null>;
  readDirectory: (repoId: string) => Promise<DirectoryReadResult>;
  readFile: (payload: ClaudeRepoFileRequest) => Promise<ReadFileResult>;
  onStateChanged: (callback: (payload: AppStateSnapshot) => void) => Unsubscribe;
  onSessionOutput: (callback: (payload: SessionOutputPayload) => void) => Unsubscribe;
  onSessionUpdated: (callback: (payload: SessionUpdatedPayload) => void) => Unsubscribe;
  onCommand: (callback: (payload: AppCommandPayload) => void) => Unsubscribe;
  launchLazygit: (repoId: string) => Promise<string | null>;
  closeLazygit: (sessionId: string) => Promise<void>;
  sendLazygitInput: (sessionId: string, data: string) => Promise<void>;
  sendLazygitBinaryInput: (sessionId: string, data: string) => Promise<void>;
  resizeLazygit: (sessionId: string, cols: number, rows: number) => Promise<void>;
  onLazygitOutput: (callback: (payload: { sessionId: string; data: string }) => void) => Unsubscribe;
  onLazygitExit: (callback: (payload: { sessionId: string }) => void) => Unsubscribe;
  launchTokscale: (repoId: string) => Promise<string | null>;
  closeTokscale: (sessionId: string) => Promise<void>;
  sendTokscaleInput: (sessionId: string, data: string) => Promise<void>;
  sendTokscaleBinaryInput: (sessionId: string, data: string) => Promise<void>;
  resizeTokscale: (sessionId: string, cols: number, rows: number) => Promise<void>;
  onTokscaleOutput: (callback: (payload: { sessionId: string; data: string }) => void) => Unsubscribe;
  onTokscaleExit: (callback: (payload: { sessionId: string }) => void) => Unsubscribe;
}

interface ClaudeTerminalOptions {
  disableStdin?: boolean;
  theme?: Record<string, string>;
  [key: string]: unknown;
}

interface ClaudeTerminalResizePayload {
  cols: number;
  rows: number;
}

interface ClaudeTerminalLike {
  cols: number;
  rows: number;
  options: ClaudeTerminalOptions;
  loadAddon: (addon: ClaudeFitAddonLike) => void;
  open: (element: HTMLElement) => void;
  attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => void;
  onData: (listener: (data: string) => void) => void;
  onBinary: (listener: (data: string) => void) => void;
  onResize: (listener: (size: ClaudeTerminalResizePayload) => void) => void;
  reset: () => void;
  write: (data: string) => void;
  focus: () => void;
  dispose: () => void;
  getSelection?: () => string;
  paste?: (text: string) => void;
}

interface ClaudeFitAddonLike {
  fit: () => void;
}

declare global {
  interface Window {
    claudeWorkspace: ClaudeWorkspaceApi;
  }

  const Terminal: new (options: ClaudeTerminalOptions) => ClaudeTerminalLike;
  const FitAddon: {
    FitAddon: new () => ClaudeFitAddonLike;
  };
}

export {};
