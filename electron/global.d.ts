type Unsubscribe = () => void;

interface ClaudeWorkspaceApi {
  getState: () => Promise<any>;
  openWorkspaceFolder: () => Promise<void>;
  createProjectFolder: () => Promise<void>;
  rescanWorkspace: (workspaceId: string) => Promise<any>;
  createSession: (repoId: string, launchesClaudeOnStart: boolean) => Promise<any>;
  reopenSession: (sessionId: string) => Promise<any>;
  closeSession: (sessionId: string) => Promise<any>;
  sendInput: (sessionId: string, data: string) => Promise<any>;
  sendBinaryInput: (sessionId: string, data: string) => Promise<any>;
  resizeSession: (sessionId: string, cols: number, rows: number) => Promise<any>;
  setFocusedSession: (sessionId: string | null) => Promise<any>;
  openRepoInFinder: (repoId: string) => Promise<any>;
  showRepoContextMenu: (
    repoId: string,
    position: { x: number; y: number }
  ) => Promise<any>;
  revealPath: (filePath: string) => Promise<any>;
  nextUnreadSession: () => Promise<string | null>;
  updatePreferences: (patch: Record<string, unknown>) => Promise<any>;
  getClaudeSettingsContext: (repoId: string | null) => Promise<any>;
  loadSettingsFile: (filePath: string) => Promise<string>;
  saveSettingsFile: (filePath: string, contents: string) => Promise<any>;
  onStateChanged: (callback: (payload: any) => void) => Unsubscribe;
  onSessionOutput: (callback: (payload: any) => void) => Unsubscribe;
  onSessionUpdated: (callback: (payload: any) => void) => Unsubscribe;
  onCommand: (callback: (payload: { command: string; sessionId?: string }) => void) => Unsubscribe;
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
