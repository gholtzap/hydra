const { contextBridge, ipcRenderer } = require("electron");

async function getTrackedPortStatus() {
  try {
    return await ipcRenderer.invoke("status:ports");
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
  getState: () => ipcRenderer.invoke("state:get"),
  openWorkspaceFolder: () => ipcRenderer.invoke("workspace:open"),
  createProjectFolder: () => ipcRenderer.invoke("project:create"),
  rescanWorkspace: (workspaceId) => ipcRenderer.invoke("workspace:rescan", workspaceId),
  createSession: (repoId, launchesClaudeOnStart) =>
    ipcRenderer.invoke("session:create", { repoId, launchesClaudeOnStart }),
  reopenSession: (sessionId) => ipcRenderer.invoke("session:reopen", sessionId),
  closeSession: (sessionId) => ipcRenderer.invoke("session:close", sessionId),
  sendInput: (sessionId, data) => ipcRenderer.invoke("session:input", { sessionId, data }),
  sendBinaryInput: (sessionId, data) =>
    ipcRenderer.invoke("session:binaryInput", { sessionId, data }),
  resizeSession: (sessionId, cols, rows) =>
    ipcRenderer.invoke("session:resize", { sessionId, cols, rows }),
  setFocusedSession: (sessionId) => ipcRenderer.invoke("session:focus", sessionId),
  openRepoInFinder: (repoId) => ipcRenderer.invoke("repo:reveal", repoId),
  showRepoContextMenu: (repoId, position) =>
    ipcRenderer.invoke("repo:contextMenu", { repoId, position }),
  readClipboardText: () => ipcRenderer.invoke("clipboard:readText"),
  writeClipboardText: (text) => ipcRenderer.invoke("clipboard:writeText", text),
  revealPath: (filePath) => ipcRenderer.invoke("path:reveal", filePath),
  nextUnreadSession: () => ipcRenderer.invoke("session:nextUnread"),
  updatePreferences: (patch) => ipcRenderer.invoke("preferences:update", patch),
  getTrackedPortStatus,
  getClaudeSettingsContext: (repoId) => ipcRenderer.invoke("settings:context", repoId),
  loadSettingsFile: (filePath) => ipcRenderer.invoke("settings:loadFile", filePath),
  saveSettingsFile: (filePath, contents) =>
    ipcRenderer.invoke("settings:saveFile", { filePath, contents }),
  onStateChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("state:changed", listener);
    return () => ipcRenderer.removeListener("state:changed", listener);
  },
  onSessionOutput: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("session:output", listener);
    return () => ipcRenderer.removeListener("session:output", listener);
  },
  onSessionUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("session:updated", listener);
    return () => ipcRenderer.removeListener("session:updated", listener);
  },
  onCommand: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("app:command", listener);
    return () => ipcRenderer.removeListener("app:command", listener);
  }
});
