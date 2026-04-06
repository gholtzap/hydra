type Unsubscribe = () => void;

interface ClaudeWorkspaceApi {
  getState: () => Promise<any>;
  openWorkspaceFolder: () => Promise<void>;
  createProjectFolder: () => Promise<void>;
  rescanWorkspace: (workspaceId: string) => Promise<any>;
  createSession: (repoId: string, launchesClaudeOnStart: boolean) => Promise<any>;
  reopenSession: (sessionId: string) => Promise<any>;
  closeSession: (sessionId: string) => Promise<any>;
  renameSession: (sessionId: string, title: string) => Promise<any>;
  sendInput: (sessionId: string, data: string) => Promise<any>;
  sendBinaryInput: (sessionId: string, data: string) => Promise<any>;
  resizeSession: (sessionId: string, cols: number, rows: number) => Promise<any>;
  setFocusedSession: (sessionId: string | null) => Promise<any>;
  openRepoInFinder: (repoId: string) => Promise<any>;
  showRepoContextMenu: (
    repoId: string,
    position: { x: number; y: number }
  ) => Promise<any>;
  readClipboardText: () => Promise<string>;
  writeClipboardText: (text: string) => Promise<any>;
  revealPath: (filePath: string) => Promise<any>;
  nextUnreadSession: () => Promise<string | null>;
  updatePreferences: (patch: Record<string, unknown>) => Promise<any>;
  getTrackedPortStatus: () => Promise<any>;
  getClaudeSettingsContext: (repoId: string | null) => Promise<any>;
  loadSettingsFile: (filePath: string) => Promise<string>;
  saveSettingsFile: (filePath: string, contents: string) => Promise<any>;
  getWikiContext: (repoId: string) => Promise<any>;
  readWikiFile: (repoId: string, relativePath: string) => Promise<any>;
  toggleWiki: (repoId: string, enabled: boolean) => Promise<any>;
  revealWiki: (repoId: string) => Promise<any>;
  readDirectory: (repoId: string) => Promise<any>;
  readFile: (filePath: string) => Promise<any>;
  onStateChanged: (callback: (payload: any) => void) => Unsubscribe;
  onSessionOutput: (callback: (payload: any) => void) => Unsubscribe;
  onSessionUpdated: (callback: (payload: any) => void) => Unsubscribe;
  onCommand: (
    callback: (payload: { command: string; sessionId?: string; repoId?: string }) => void
  ) => Unsubscribe;
  launchLazygit: (repoId: string) => Promise<string | null>;
  closeLazygit: (sessionId: string) => Promise<any>;
  sendLazygitInput: (sessionId: string, data: string) => Promise<any>;
  sendLazygitBinaryInput: (sessionId: string, data: string) => Promise<any>;
  resizeLazygit: (sessionId: string, cols: number, rows: number) => Promise<any>;
  onLazygitOutput: (callback: (payload: { sessionId: string; data: string }) => void) => Unsubscribe;
  onLazygitExit: (callback: (payload: { sessionId: string }) => void) => Unsubscribe;
  launchTokscale: (repoId: string) => Promise<string | null>;
  closeTokscale: (sessionId: string) => Promise<any>;
  sendTokscaleInput: (sessionId: string, data: string) => Promise<any>;
  sendTokscaleBinaryInput: (sessionId: string, data: string) => Promise<any>;
  resizeTokscale: (sessionId: string, cols: number, rows: number) => Promise<any>;
  onTokscaleOutput: (callback: (payload: { sessionId: string; data: string }) => void) => Unsubscribe;
  onTokscaleExit: (callback: (payload: { sessionId: string }) => void) => Unsubscribe;
}

declare global {
  interface Window {
    claudeWorkspace: ClaudeWorkspaceApi;
  }

  const Terminal: new (options: Record<string, unknown>) => any;
  const FitAddon: {
    FitAddon: new () => any;
  };
}

export {};
