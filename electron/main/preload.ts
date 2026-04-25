import type {
  AppCommandPayload,
  AppPreferencesPatch,
  AppUpdateCheckResult,
  AppStateSnapshot,
  AuthResult,
  AuthSession,
  ClaudeExternalUrlRequest,
  ClaudePathRevealRequest,
  ClaudeRepoFileRequest,
  ClaudeSettingsFileRequest,
  ClaudeSettingsSaveRequest,
  ClaudeSettingsContext,
  ClaudeSkillFileRequest,
  DirectoryReadResult,
  EphemeralToolExitPayload,
  EphemeralToolId,
  EphemeralToolOutputPayload,
  MarketplaceInspectResponse,
  MarketplaceInstallResponse,
  MarketplaceInstallScope,
  MarketplaceSkillDetails,
  Point,
  ReadFileResult,
  RepoAppLaunchConfig,
  SessionOrganizationPatch,
  SessionOutputPayload,
  SessionRestartRequest,
  SessionSearchResponse,
  SessionSummary,
  SessionUpdatedPayload,
  TrackedPortStatus,
  WikiContext,
  WikiFileContents
} from "../shared-types";

const { contextBridge, ipcRenderer } = require("electron");

type RepoAppLaunchConfigRequest = {
  repoId: string;
  config: RepoAppLaunchConfig;
};

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}


async function getTrackedPortStatus(): Promise<TrackedPortStatus> {
  try {
    return await invoke<TrackedPortStatus>("status:ports");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (message.includes("No handler registered for 'status:ports'")) {
      return {
        available: false,
        scannedAt: new Date().toISOString(),
        trackedPortCount: 0,
        activeCount: 0,
        ports: [],
        activePorts: [],
        groups: [],
        error: "Dev Ports is available after a full app restart. Quit Hydra and launch it again."
      };
    }

    throw error;
  }
}

contextBridge.exposeInMainWorld("claudeWorkspace", {
    getState: () => invoke<AppStateSnapshot>("state:get"),
    openWorkspaceFolder: () => invoke<void>("workspace:open"),
    createProjectFolder: () => invoke<void>("project:create"),
    rescanWorkspace: (workspaceId: string) => invoke<void>("workspace:rescan", workspaceId),
    createSession: (repoId: string, launchesClaudeOnStart: boolean) =>
      invoke<string | null>("session:create", { repoId, launchesClaudeOnStart }),
    reopenSession: (sessionId: string) => invoke<void>("session:reopen", sessionId),
    restartSession: (payload: SessionRestartRequest) => invoke<void>("session:restart", payload),
    closeSession: (sessionId: string) => invoke<void>("session:close", sessionId),
    renameSession: (sessionId: string, title: string) =>
      invoke<boolean>("session:rename", { sessionId, title }),
    updateSessionOrganization: (sessionId: string, patch: SessionOrganizationPatch) =>
      invoke<boolean>("session:organize", { sessionId, patch }),
    importSessionIcon: (sessionId: string) =>
      invoke<SessionSummary | null>("session:importIcon", sessionId),
    clearSessionIcon: (sessionId: string) =>
      invoke<boolean>("session:clearIcon", sessionId),
    sendInput: (sessionId: string, data: string) =>
      invoke<void>("session:input", { sessionId, data }),
    sendBinaryInput: (sessionId: string, data: string) =>
      invoke<void>("session:binaryInput", { sessionId, data }),
    resizeSession: (sessionId: string, cols: number, rows: number) =>
      invoke<void>("session:resize", { sessionId, cols, rows }),
    setFocusedSession: (sessionId: string | null) => invoke<void>("session:focus", sessionId),
    openRepoInFinder: (repoId: string) => invoke<void>("repo:reveal", repoId),
    showRepoContextMenu: (repoId: string, position: Point) =>
      invoke<void>("repo:contextMenu", { repoId, position }),
    updateRepoAppLaunchConfig: (payload: RepoAppLaunchConfigRequest) =>
      invoke<RepoAppLaunchConfig | null>("repo:updateAppLaunchConfig", payload),
    buildAndRunApp: (repoId: string) => invoke<string | null>("repo:buildAndRunApp", repoId),
    readClipboardText: () => invoke<string>("clipboard:readText"),
    writeClipboardText: (text: string) => invoke<void>("clipboard:writeText", text),
    checkForUpdates: () => invoke<AppUpdateCheckResult>("app:checkForUpdates"),
    revealPath: (payload: ClaudePathRevealRequest) => invoke<void>("path:reveal", payload),
    openExternalUrl: (payload: ClaudeExternalUrlRequest) =>
      invoke<void>("path:openExternal", payload),
    nextUnreadSession: () => invoke<string | null>("session:nextUnread"),
    updatePreferences: (patch: AppPreferencesPatch) =>
      invoke<void>("preferences:update", patch),
    getTrackedPortStatus,
    getClaudeSettingsContext: (repoId: string | null) =>
      invoke<ClaudeSettingsContext>("settings:context", repoId),
    loadSettingsFile: (payload: ClaudeSettingsFileRequest) =>
      invoke<string>("settings:loadFile", payload),
    saveSettingsFile: (payload: ClaudeSettingsSaveRequest) =>
      invoke<void>("settings:saveFile", payload),
    importSkillIcon: (payload: ClaudeSkillFileRequest) =>
      invoke<string | null>("settings:importSkillIcon", payload),
    clearSkillIcon: (payload: ClaudeSkillFileRequest) =>
      invoke<boolean>("settings:clearSkillIcon", payload),
    getMarketplaceSkillDetails: (payload: { source: MarketplaceSkillDetails["source"] & { tags?: string[] } }) =>
      invoke<MarketplaceSkillDetails>("skillsMarketplace:details", payload),
    inspectMarketplaceUrl: (payload: { url: string }) =>
      invoke<MarketplaceInspectResponse>("skillsMarketplace:inspectUrl", payload),
    installMarketplaceSkill: (payload: {
      source: MarketplaceSkillDetails["source"];
      scope: MarketplaceInstallScope;
      repoPath?: string | null;
    }) => invoke<MarketplaceInstallResponse>("skillsMarketplace:install", payload),
    getWikiContext: (repoId: string) => invoke<WikiContext | null>("wiki:getContext", repoId),
    readWikiFile: (repoId: string, relativePath: string) =>
      invoke<WikiFileContents>("wiki:readFile", { repoId, relativePath }),
    toggleWiki: (repoId: string, enabled: boolean) =>
      invoke<WikiContext | null>("wiki:toggle", { repoId, enabled }),
    revealWiki: (repoId: string) => invoke<void>("wiki:reveal", repoId),
    querySessionSearch: (repoId: string | null, query: string) =>
      invoke<SessionSearchResponse>("sessionSearch:query", { repoId, query }),
    resumeFromClaudeSession: (repoId: string, claudeSessionId: string) =>
      invoke<string | null>("session:resumeFromClaude", { repoId, claudeSessionId }),
    resumeFromSessionSearchResult: (repoId: string, source: "claude" | "codex", sessionId: string) =>
      invoke<string | null>("session:resumeFromSearchResult", { repoId, source, sessionId }),
    readDirectory: (repoId: string) => invoke<DirectoryReadResult>("fs:readDir", repoId),
    readFile: (payload: ClaudeRepoFileRequest) => invoke<ReadFileResult>("fs:readFile", payload),
    onStateChanged: (callback: (payload: AppStateSnapshot) => void) =>
      subscribe<AppStateSnapshot>("state:changed", callback),
    onSessionOutput: (callback: (payload: SessionOutputPayload) => void) =>
      subscribe<SessionOutputPayload>("session:output", callback),
    onSessionUpdated: (callback: (payload: SessionUpdatedPayload) => void) =>
      subscribe<SessionUpdatedPayload>("session:updated", callback),
    onCommand: (callback: (payload: AppCommandPayload) => void) =>
      subscribe<AppCommandPayload>("app:command", callback),
    launchEphemeralTool: (toolId: EphemeralToolId, repoId: string) =>
      invoke<string | null>("ephemeralTool:launch", { toolId, repoId }),
    closeEphemeralTool: (toolId: EphemeralToolId, sessionId: string) =>
      invoke<void>("ephemeralTool:close", { toolId, sessionId }),
    sendEphemeralToolInput: (toolId: EphemeralToolId, sessionId: string, data: string) =>
      invoke<void>("ephemeralTool:input", { toolId, sessionId, data }),
    sendEphemeralToolBinaryInput: (toolId: EphemeralToolId, sessionId: string, data: string) =>
      invoke<void>("ephemeralTool:binaryInput", { toolId, sessionId, data }),
    resizeEphemeralTool: (toolId: EphemeralToolId, sessionId: string, cols: number, rows: number) =>
      invoke<void>("ephemeralTool:resize", { toolId, sessionId, cols, rows }),
    onEphemeralToolOutput: (callback: (payload: EphemeralToolOutputPayload) => void) =>
      subscribe<EphemeralToolOutputPayload>("ephemeralTool:output", callback),
    onEphemeralToolExit: (callback: (payload: EphemeralToolExitPayload) => void) =>
      subscribe<EphemeralToolExitPayload>("ephemeralTool:exit", callback),
    onPlanDetected: (callback: (payload: { sessionId: string; markdown: string }) => void) =>
      subscribe<{ sessionId: string; markdown: string }>("plan:detected", callback),

    // Auth
    signInWithEmail: (email: string, password: string) =>
      invoke<AuthResult>("auth:signIn", { email, password }),
    signUpWithEmail: (name: string, email: string, password: string) =>
      invoke<AuthResult>("auth:signUp", { name, email, password }),
    authStartProvider: (provider: "google" | "discord" | "github") =>
      invoke<AuthResult>("auth:startProvider", { provider }),
    authSignOut: () => invoke<void>("auth:signOut"),
    authGetSession: () => invoke<AuthSession | null>("auth:getSession"),
    authOpenPage: () => invoke<void>("auth:openPage"),
    requestPasswordReset: (email: string, redirectUrl: string) =>
      invoke<AuthResult>("auth:resetPassword", { email, redirectUrl }),
    verifyTotp: (code: string) =>
      invoke<AuthResult>("auth:verifyTotp", { code }),
    onAuthStateChanged: (callback: (session: AuthSession | null) => void) =>
      subscribe<AuthSession | null>("auth:stateChanged", callback)
  });
