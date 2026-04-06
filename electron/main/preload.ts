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
  renameSession: (sessionId, title) => ipcRenderer.invoke("session:rename", { sessionId, title }),
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
  getWikiContext: (repoId) => ipcRenderer.invoke("wiki:getContext", repoId),
  readWikiFile: (repoId, relativePath) =>
    ipcRenderer.invoke("wiki:readFile", { repoId, relativePath }),
  toggleWiki: (repoId, enabled) => ipcRenderer.invoke("wiki:toggle", { repoId, enabled }),
  revealWiki: (repoId) => ipcRenderer.invoke("wiki:reveal", repoId),
  readDirectory: (repoId) => ipcRenderer.invoke("fs:readDir", repoId),
  readFile: (filePath) => ipcRenderer.invoke("fs:readFile", filePath),
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
  },
  launchLazygit: (repoId) => ipcRenderer.invoke("lazygit:launch", { repoId }),
  closeLazygit: (sessionId) => ipcRenderer.invoke("lazygit:close", { sessionId }),
  sendLazygitInput: (sessionId, data) =>
    ipcRenderer.invoke("lazygit:input", { sessionId, data }),
  sendLazygitBinaryInput: (sessionId, data) =>
    ipcRenderer.invoke("lazygit:binaryInput", { sessionId, data }),
  resizeLazygit: (sessionId, cols, rows) =>
    ipcRenderer.invoke("lazygit:resize", { sessionId, cols, rows }),
  onLazygitOutput: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("lazygit:output", listener);
    return () => ipcRenderer.removeListener("lazygit:output", listener);
  },
  onLazygitExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("lazygit:exit", listener);
    return () => ipcRenderer.removeListener("lazygit:exit", listener);
  },
  launchTokscale: (repoId) => ipcRenderer.invoke("tokscale:launch", { repoId }),
  closeTokscale: (sessionId) => ipcRenderer.invoke("tokscale:close", { sessionId }),
  sendTokscaleInput: (sessionId, data) =>
    ipcRenderer.invoke("tokscale:input", { sessionId, data }),
  sendTokscaleBinaryInput: (sessionId, data) =>
    ipcRenderer.invoke("tokscale:binaryInput", { sessionId, data }),
  resizeTokscale: (sessionId, cols, rows) =>
    ipcRenderer.invoke("tokscale:resize", { sessionId, cols, rows }),
  onTokscaleOutput: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("tokscale:output", listener);
    return () => ipcRenderer.removeListener("tokscale:output", listener);
  },
  onTokscaleExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("tokscale:exit", listener);
    return () => ipcRenderer.removeListener("tokscale:exit", listener);
  }
});
