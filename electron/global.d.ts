import type {
  AppCommandPayload,
  AppPreferences,
  AppStateSnapshot,
  ClaudeExternalUrlRequest,
  ClaudePathRevealRequest,
  ClaudeRepoFileRequest,
  ClaudeSettingsContext,
  ClaudeSettingsFileRequest,
  ClaudeSettingsSaveRequest,
  ClaudeSkillFileRequest,
  DirectoryReadResult,
  EphemeralToolExitPayload,
  EphemeralToolId,
  EphemeralToolOutputPayload,
  MarketplaceInspectResponse,
  MarketplaceInstallResponse,
  MarketplaceSkillDetails,
  Point,
  ReadFileResult,
  RepoAppLaunchConfig,
  SessionOrganizationPatch,
  SessionOutputPayload,
  SessionSearchResponse,
  SessionSummary,
  SessionUpdatedPayload,
  TrackedPortStatus,
  VoiceCallState,
  VoiceConfig,
  WikiContext,
  WikiFileContents
} from "./shared-types";

type Unsubscribe = () => void;

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
  updateRepoAppLaunchConfig: (payload: {
    repoId: string;
    config: RepoAppLaunchConfig;
  }) => Promise<RepoAppLaunchConfig | null>;
  buildAndRunApp: (repoId: string) => Promise<string | null>;
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
  resumeFromSessionSearchResult: (
    repoId: string,
    source: "claude" | "codex",
    sessionId: string
  ) => Promise<string | null>;
  readDirectory: (repoId: string) => Promise<DirectoryReadResult>;
  readFile: (payload: ClaudeRepoFileRequest) => Promise<ReadFileResult>;
  onStateChanged: (callback: (payload: AppStateSnapshot) => void) => Unsubscribe;
  onSessionOutput: (callback: (payload: SessionOutputPayload) => void) => Unsubscribe;
  onSessionUpdated: (callback: (payload: SessionUpdatedPayload) => void) => Unsubscribe;
  onCommand: (callback: (payload: AppCommandPayload) => void) => Unsubscribe;
  launchEphemeralTool: (toolId: EphemeralToolId, repoId: string) => Promise<string | null>;
  closeEphemeralTool: (toolId: EphemeralToolId, sessionId: string) => Promise<void>;
  sendEphemeralToolInput: (
    toolId: EphemeralToolId,
    sessionId: string,
    data: string
  ) => Promise<void>;
  sendEphemeralToolBinaryInput: (
    toolId: EphemeralToolId,
    sessionId: string,
    data: string
  ) => Promise<void>;
  resizeEphemeralTool: (
    toolId: EphemeralToolId,
    sessionId: string,
    cols: number,
    rows: number
  ) => Promise<void>;
  onEphemeralToolOutput: (
    callback: (payload: EphemeralToolOutputPayload) => void
  ) => Unsubscribe;
  onEphemeralToolExit: (
    callback: (payload: EphemeralToolExitPayload) => void
  ) => Unsubscribe;
  onPlanDetected: (
    callback: (payload: { sessionId: string; markdown: string }) => void
  ) => Unsubscribe;
  startVoiceCall: (config?: Partial<VoiceConfig>) => Promise<{
    success: boolean;
    port?: number;
    error?: string;
  }>;
  stopVoiceCall: () => Promise<void>;
  getVoiceCallState: () => Promise<VoiceCallState>;
  getVoiceConfig: () => Promise<VoiceConfig>;
  updateVoiceConfig: (patch: Partial<VoiceConfig>) => Promise<void>;
  checkPython: () => Promise<{ found: boolean; path?: string; version?: string }>;
  installVoiceDeps: () => Promise<{ success: boolean; error?: string }>;
  getVoiceBotPort: () => Promise<number | null>;
  onVoiceCallStateChanged: (
    callback: (state: VoiceCallState) => void
  ) => Unsubscribe;
  onVoiceInstallProgress: (
    callback: (line: string) => void
  ) => Unsubscribe;
  onVoiceError: (
    callback: (error: { code: string; message: string }) => void
  ) => Unsubscribe;
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

interface PipecatClientLike {
  connect: (params?: unknown) => Promise<unknown>;
  disconnect: () => Promise<void>;
  enableMic: (enabled: boolean) => void | Promise<void>;
  readonly isMicEnabled?: boolean;
}

interface PipecatClientOptionsLike {
  transport: unknown;
  enableMic?: boolean;
  enableCam?: boolean;
  callbacks?: Record<string, (...args: any[]) => void>;
}

declare global {
  interface Window {
    claudeWorkspace: ClaudeWorkspaceApi;
    PipecatClient: new (options: PipecatClientOptionsLike) => PipecatClientLike;
    SmallWebRTCTransport: new (options?: Record<string, unknown>) => unknown;
  }

  const Terminal: new (options: ClaudeTerminalOptions) => ClaudeTerminalLike;
  const FitAddon: {
    FitAddon: new () => ClaudeFitAddonLike;
  };
  const PipecatClient: new (options: PipecatClientOptionsLike) => PipecatClientLike;
  const SmallWebRTCTransport: new (options?: Record<string, unknown>) => unknown;
}

export {};
