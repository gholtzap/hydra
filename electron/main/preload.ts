import type {
  AppCommandPayload,
  AppPreferences,
  AppStateSnapshot,
  ClaudeSettingsContext,
  DirectoryReadResult,
  MarketplaceInspectResponse,
  MarketplaceInstallResponse,
  MarketplaceInstallScope,
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
} from "../shared-types";

const { contextBridge, ipcRenderer } = require("electron");

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

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
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
        error: "Dev Ports is available after a full app restart. Quit Claude Workspace and launch it again."
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
  readClipboardText: () => invoke<string>("clipboard:readText"),
  writeClipboardText: (text: string) => invoke<void>("clipboard:writeText", text),
  revealPath: (payload: ClaudePathRevealRequest) => invoke<void>("path:reveal", payload),
  openExternalUrl: (payload: ClaudeExternalUrlRequest) =>
    invoke<void>("path:openExternal", payload),
  nextUnreadSession: () => invoke<string | null>("session:nextUnread"),
  updatePreferences: (patch: Partial<AppPreferences>) =>
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
  readDirectory: (repoId: string) => invoke<DirectoryReadResult>("fs:readDir", repoId),
  readFile: (payload: ClaudeRepoFileRequest) => invoke<ReadFileResult>("fs:readFile", payload),
  onStateChanged: (callback: (payload: AppStateSnapshot) => void) => {
    const listener = (_event: unknown, payload: AppStateSnapshot) => callback(payload);
    ipcRenderer.on("state:changed", listener);
    return () => ipcRenderer.removeListener("state:changed", listener);
  },
  onSessionOutput: (callback: (payload: SessionOutputPayload) => void) => {
    const listener = (_event: unknown, payload: SessionOutputPayload) => callback(payload);
    ipcRenderer.on("session:output", listener);
    return () => ipcRenderer.removeListener("session:output", listener);
  },
  onSessionUpdated: (callback: (payload: SessionUpdatedPayload) => void) => {
    const listener = (_event: unknown, payload: SessionUpdatedPayload) => callback(payload);
    ipcRenderer.on("session:updated", listener);
    return () => ipcRenderer.removeListener("session:updated", listener);
  },
  onCommand: (callback: (payload: AppCommandPayload) => void) => {
    const listener = (_event: unknown, payload: AppCommandPayload) => callback(payload);
    ipcRenderer.on("app:command", listener);
    return () => ipcRenderer.removeListener("app:command", listener);
  },
  launchLazygit: (repoId: string) => invoke<string | null>("lazygit:launch", { repoId }),
  closeLazygit: (sessionId: string) => invoke<void>("lazygit:close", { sessionId }),
  sendLazygitInput: (sessionId: string, data: string) =>
    invoke<void>("lazygit:input", { sessionId, data }),
  sendLazygitBinaryInput: (sessionId: string, data: string) =>
    invoke<void>("lazygit:binaryInput", { sessionId, data }),
  resizeLazygit: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("lazygit:resize", { sessionId, cols, rows }),
  onLazygitOutput: (callback: (payload: { sessionId: string; data: string }) => void) => {
    const listener = (_event: unknown, payload: { sessionId: string; data: string }) => callback(payload);
    ipcRenderer.on("lazygit:output", listener);
    return () => ipcRenderer.removeListener("lazygit:output", listener);
  },
  onLazygitExit: (callback: (payload: { sessionId: string }) => void) => {
    const listener = (_event: unknown, payload: { sessionId: string }) => callback(payload);
    ipcRenderer.on("lazygit:exit", listener);
    return () => ipcRenderer.removeListener("lazygit:exit", listener);
  },
  launchTokscale: (repoId: string) => invoke<string | null>("tokscale:launch", { repoId }),
  closeTokscale: (sessionId: string) => invoke<void>("tokscale:close", { sessionId }),
  sendTokscaleInput: (sessionId: string, data: string) =>
    invoke<void>("tokscale:input", { sessionId, data }),
  sendTokscaleBinaryInput: (sessionId: string, data: string) =>
    invoke<void>("tokscale:binaryInput", { sessionId, data }),
  resizeTokscale: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("tokscale:resize", { sessionId, cols, rows }),
  onTokscaleOutput: (callback: (payload: { sessionId: string; data: string }) => void) => {
    const listener = (_event: unknown, payload: { sessionId: string; data: string }) => callback(payload);
    ipcRenderer.on("tokscale:output", listener);
    return () => ipcRenderer.removeListener("tokscale:output", listener);
  },
  onTokscaleExit: (callback: (payload: { sessionId: string }) => void) => {
    const listener = (_event: unknown, payload: { sessionId: string }) => callback(payload);
    ipcRenderer.on("tokscale:exit", listener);
    return () => ipcRenderer.removeListener("tokscale:exit", listener);
  }
});
