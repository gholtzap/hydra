const api = window.claudeWorkspace;

const state = {
  workspaces: [],
  repos: [],
  sessions: [],
  preferences: {}
};

const ui = {
  selection: { type: "inbox", id: null },
  terminal: null,
  fitAddon: null,
  terminalSessionId: null,
  resizeObserver: null,
  launcherQuery: "",
  launcherSelectedRepoId: null,
  launcherLaunchesClaudeOnStart: true,
  quickSwitcherQuery: "",
  commandPaletteQuery: "",
  settingsTab: "general",
  settingsContext: null,
  settingsSelectedFilePath: null,
  settingsEditorText: "",
  settingsSaveMessage: ""
};

const sidebarElement = document.getElementById("sidebar");
const detailElement = document.getElementById("detail");
const launcherDialog = document.getElementById("launcher-dialog");
const settingsDialog = document.getElementById("settings-dialog");
const quickSwitcherDialog = document.getElementById("quick-switcher-dialog");
const commandPaletteDialog = document.getElementById("command-palette-dialog");

document.addEventListener("click", handleClick);
document.addEventListener("input", handleInput);
document.addEventListener("change", handleChange);

api.onStateChanged((nextState) => {
  replaceState(nextState);
  ensureValidSelection();
  renderSidebar();
  renderDetail();
  renderDialogs();
});

api.onSessionOutput((payload) => {
  const session = appendSessionOutput(payload.sessionId, payload.data, payload.session);
  renderSidebar();

  if (!session) {
    return;
  }

  if (ui.selection.type === "session" && ui.selection.id === payload.sessionId && ui.terminal) {
    updateSessionChrome(session);
    ui.terminal.write(payload.data);
    syncTerminalLiveState(session);
    return;
  }

  if (ui.selection.type !== "session") {
    renderDetail();
  }
});

api.onSessionUpdated((payload) => {
  const session = mergeSessionSummary(payload.session);
  renderSidebar();

  if (!session) {
    return;
  }

  if (ui.selection.type === "session" && ui.selection.id === session.id) {
    updateSessionChrome(session);
    syncTerminalLiveState(session);
  } else if (ui.selection.type !== "session") {
    renderDetail();
  }
});

api.onCommand(async ({ command }) => {
  switch (command) {
    case "new-session":
      openLauncher();
      break;
    case "quick-switcher":
      openQuickSwitcher();
      break;
    case "command-palette":
      openCommandPalette();
      break;
    case "next-unread": {
      const nextSessionId = await api.nextUnreadSession();
      if (nextSessionId) {
        selectSession(nextSessionId);
      }
      break;
    }
    default:
      break;
  }
});

initialize().catch((error) => {
  detailElement.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
});

async function initialize() {
  replaceState(await api.getState());
  ensureValidSelection();
  renderSidebar();
  renderDetail();
  renderDialogs();
}

function replaceState(nextState) {
  state.workspaces = nextState.workspaces || [];
  state.repos = nextState.repos || [];
  state.sessions = nextState.sessions || [];
  state.preferences = nextState.preferences || {};
}

function ensureValidSelection() {
  if (ui.selection.type === "session" && !sessionById(ui.selection.id)) {
    ui.selection = { type: "inbox", id: null };
  }

  if (ui.selection.type === "repo" && !repoById(ui.selection.id)) {
    ui.selection = { type: "inbox", id: null };
  }
}

function renderSidebar() {
  sidebarElement.innerHTML = `
    <div class="sidebar-brand">
      <div class="eyebrow">Claude Code Workspace</div>
      <div class="sidebar-title">Claude Workspace</div>
      <div class="muted">A real shell-first desktop home for Claude sessions.</div>
    </div>

    <div class="sidebar-actions">
      <button class="primary" data-action="open-launcher">New Session</button>
      <button data-action="open-settings">Settings</button>
      <button data-action="open-workspace">Open Workspace</button>
      <button data-action="create-project">New Folder</button>
    </div>

    <div class="sidebar-section">
      <div class="section-label">Attention</div>
      <div class="sidebar-list">
        <button class="sidebar-item ${selectionMatches("inbox") ? "active" : ""}" data-action="select-inbox">
          <div class="sidebar-item-title">
            <span>Inbox / Needs Attention</span>
            ${inboxSessions().length ? `<span class="inbox-count">${inboxSessions().length}</span>` : ""}
          </div>
          <div class="row-subtitle">Blocked sessions and unread activity</div>
        </button>
      </div>
    </div>

    <div class="sidebar-section">
      <div class="section-label">Running Sessions</div>
      <div class="sidebar-list">
        ${renderRunningSessions()}
      </div>
    </div>

    <div class="sidebar-section" style="min-height: 0;">
      <div class="section-label">Workspaces</div>
      <div class="sidebar-list">
        ${renderWorkspaceBlocks()}
      </div>
    </div>
  `;
}

function renderRunningSessions() {
  const running = state.sessions
    .filter((session) => session.runtimeState === "live")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  if (!running.length) {
    return `<div class="muted" style="padding: 0 6px;">No live sessions</div>`;
  }

  return running
    .map(
      (session) => `
        <button class="session-row ${selectionMatches("session", session.id) ? "active" : ""}" data-action="select-session" data-session-id="${session.id}">
          <div class="row-title">
            <span>${escapeHtml(session.title)}</span>
            ${session.unreadCount && state.preferences.showInAppBadges ? '<span class="unread-dot"></span>' : ""}
          </div>
          <div class="row-subtitle">${escapeHtml(repoById(session.repoID)?.name || "Unknown Repo")}</div>
          <div class="row-meta">${statusLabel(session.status)}</div>
        </button>
      `
    )
    .join("");
}

function renderWorkspaceBlocks() {
  return state.workspaces
    .map((workspace) => {
      const repos = state.repos
        .filter((repo) => repo.workspaceID === workspace.id)
        .sort((left, right) => left.name.localeCompare(right.name));

      return `
        <section class="workspace-block">
          <div class="workspace-header">
            <div class="workspace-title">${escapeHtml(workspace.name)}</div>
            <button class="ghost" data-action="rescan-workspace" data-workspace-id="${workspace.id}">Rescan</button>
          </div>
          <div class="workspace-repos">
            ${
              repos.length
                ? repos
                    .map((repo) => {
                      const activeCount = state.sessions.filter(
                        (session) => session.repoID === repo.id && session.runtimeState === "live"
                      ).length;

                      return `
                        <button class="repo-item ${selectionMatches("repo", repo.id) ? "active" : ""}" data-action="select-repo" data-repo-id="${repo.id}">
                          <div class="row-title">
                            <span>${escapeHtml(repo.name)}</span>
                            ${activeCount ? `<span class="active-count">${activeCount}</span>` : ""}
                          </div>
                          <div class="row-subtitle">${escapeHtml(abbreviateHome(repo.path))}</div>
                        </button>
                      `;
                    })
                    .join("")
                : `<div class="muted" style="padding: 6px;">No repos found</div>`
            }
          </div>
        </section>
      `;
    })
    .join("");
}

function renderDetail() {
  if (ui.selection.type === "inbox") {
    destroyTerminal();
    renderInbox();
    return;
  }

  if (ui.selection.type === "repo") {
    destroyTerminal();
    renderRepoDetail(repoById(ui.selection.id));
    return;
  }

  if (ui.selection.type === "session") {
    renderSessionDetail(sessionById(ui.selection.id));
    return;
  }

  destroyTerminal();
  detailElement.innerHTML = `<div class="empty-state">Nothing selected.</div>`;
}

function renderInbox() {
  const sessions = inboxSessions();
  detailElement.innerHTML = `
    <section class="detail-panel">
      <div class="detail-hero">
        <div>
          <div class="eyebrow">Inbox</div>
          <h1 class="detail-title">Needs attention</h1>
          <div class="muted">Blocked sessions first, then unread activity across every repo.</div>
        </div>
        <div class="detail-actions">
          <button class="primary" data-action="open-launcher">New Session</button>
          <button data-action="open-quick-switcher">Quick Switcher</button>
        </div>
      </div>
      ${
        sessions.length
          ? `<div class="card-grid">${sessions.map(renderInboxCard).join("")}</div>`
          : `<div class="empty-state">Blocked sessions and unread activity will collect here.</div>`
      }
    </section>
  `;
}

function renderRepoDetail(repo) {
  if (!repo) {
    detailElement.innerHTML = `<div class="empty-state">This repo is no longer available.</div>`;
    return;
  }

  const sessions = state.sessions
    .filter((session) => session.repoID === repo.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  detailElement.innerHTML = `
    <section class="detail-panel">
      <div class="detail-hero">
        <div>
          <div class="eyebrow">Repository</div>
          <h1 class="detail-title">${escapeHtml(repo.name)}</h1>
          <div class="muted">${escapeHtml(abbreviateHome(repo.path))}</div>
        </div>
        <div class="detail-actions">
          <button data-action="reveal-repo" data-repo-id="${repo.id}">Reveal in Finder</button>
          <button data-action="rescan-workspace" data-workspace-id="${repo.workspaceID}">Rescan Workspace</button>
          <button class="primary" data-action="open-launcher" data-repo-id="${repo.id}">New Session</button>
        </div>
      </div>
      ${
        sessions.length
          ? `<div class="repo-session-list">${sessions.map((session) => renderRepoSession(session, repo)).join("")}</div>`
          : `<div class="empty-state">Start a shell-backed session for this repo from the New Session button.</div>`
      }
    </section>
  `;
}

function renderSessionDetail(session) {
  if (!session) {
    detailElement.innerHTML = `<div class="empty-state">This session is no longer available.</div>`;
    destroyTerminal();
    return;
  }

  detailElement.innerHTML = `
    <section class="session-detail">
      <div id="session-chrome"></div>
      <div id="session-blocker"></div>
      <div class="terminal-wrap">
        <div id="terminal-shell">
          <div id="terminal"></div>
        </div>
      </div>
    </section>
  `;

  updateSessionChrome(session);
  mountTerminal(session);
}

function updateSessionChrome(session) {
  if (ui.selection.type !== "session" || ui.selection.id !== session.id) {
    return;
  }

  const repo = repoById(session.repoID);
  const chrome = document.getElementById("session-chrome");
  const blockerElement = document.getElementById("session-blocker");

  if (!chrome || !blockerElement) {
    return;
  }

  chrome.innerHTML = `
    <div class="session-header">
      <div>
        <div class="session-title-row">
          <h1 class="session-title">${escapeHtml(session.title)}</h1>
          <span class="status-badge status-${escapeHtml(session.status)}">${escapeHtml(statusLabel(session.status))}</span>
        </div>
        <div class="muted">${escapeHtml(abbreviateHome(repo?.path || ""))}</div>
      </div>
      <div class="session-actions">
        <button data-action="reveal-repo" data-repo-id="${repo?.id || ""}">Reveal Repo</button>
        <button data-action="open-settings">Claude Settings</button>
        ${
          session.runtimeState === "live"
            ? `<button data-action="close-session" data-session-id="${session.id}">Close Session</button>`
            : `<button data-action="restart-session" data-session-id="${session.id}">Restart Session</button>
               <button data-action="close-session" data-session-id="${session.id}">Close Session</button>`
        }
      </div>
    </div>
  `;

  blockerElement.innerHTML = session.blocker
    ? `
      <div class="blocker-banner">
        <div>
          <div class="row-title">${escapeHtml(blockerLabel(session.blocker.kind))}</div>
          <div class="row-subtitle">${escapeHtml(session.blocker.summary)}</div>
        </div>
        ${
          session.blocker.kind === "approval" && session.runtimeState === "live"
            ? `<div class="session-actions">
                <button class="primary" data-action="approve-blocker" data-session-id="${session.id}">Approve</button>
                <button data-action="deny-blocker" data-session-id="${session.id}">Deny</button>
              </div>`
            : ""
        }
      </div>
    `
    : "";
}

function mountTerminal(session) {
  const terminalElement = document.getElementById("terminal");
  const shellElement = document.getElementById("terminal-shell");

  if (!terminalElement || !shellElement) {
    return;
  }

  if (ui.terminalSessionId !== session.id) {
    destroyTerminal();

    ui.terminal = new Terminal({
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorInactiveStyle: "outline",
      disableStdin: session.runtimeState !== "live",
      drawBoldTextInBrightColors: true,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      scrollback: 10000,
      theme: {
        background: "#121212",
        foreground: "#f4f4f4",
        cursor: "#7dd3fc",
        cursorAccent: "#161616",
        selectionBackground: "rgba(125, 211, 252, 0.28)",
        black: "#161616",
        red: "#ff7b72",
        green: "#7ee787",
        yellow: "#e3b341",
        blue: "#79c0ff",
        magenta: "#d2a8ff",
        cyan: "#a5f3fc",
        white: "#c9d1d9",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#f0f6fc"
      }
    });

    ui.fitAddon = new FitAddon.FitAddon();
    ui.terminal.loadAddon(ui.fitAddon);
    ui.terminal.open(terminalElement);
    ui.terminal.onData((data) => {
      if (ui.terminalSessionId) {
        api.sendInput(ui.terminalSessionId, data);
      }
    });
    ui.terminal.onBinary((data) => {
      if (ui.terminalSessionId) {
        api.sendBinaryInput(ui.terminalSessionId, data);
      }
    });
    ui.terminal.onResize((size) => {
      if (ui.terminalSessionId) {
        api.resizeSession(ui.terminalSessionId, size.cols, size.rows);
      }
    });

    ui.resizeObserver = new ResizeObserver(() => {
      if (ui.fitAddon) {
        ui.fitAddon.fit();
      }
    });
    ui.resizeObserver.observe(shellElement);

    ui.terminalSessionId = session.id;
    ui.terminal.reset();
    ui.terminal.write(session.rawTranscript || "");
  }

  syncTerminalLiveState(session);
  if (ui.fitAddon) {
    ui.fitAddon.fit();
    if (ui.terminalSessionId) {
      api.resizeSession(ui.terminalSessionId, ui.terminal.cols, ui.terminal.rows);
    }
    requestAnimationFrame(() => {
      if (!ui.fitAddon || !ui.terminal || ui.terminalSessionId !== session.id) {
        return;
      }

      ui.fitAddon.fit();
      api.resizeSession(ui.terminalSessionId, ui.terminal.cols, ui.terminal.rows);
    });
  }
  if (session.runtimeState === "live") {
    ui.terminal.focus();
  }
}

function syncTerminalLiveState(session) {
  if (!ui.terminal) {
    return;
  }

  ui.terminal.options.disableStdin = session.runtimeState !== "live";
}

function destroyTerminal() {
  if (ui.resizeObserver) {
    ui.resizeObserver.disconnect();
    ui.resizeObserver = null;
  }

  if (ui.terminal) {
    ui.terminal.dispose();
  }

  ui.terminal = null;
  ui.fitAddon = null;
  ui.terminalSessionId = null;
}

function renderInboxCard(session) {
  const repo = repoById(session.repoID);
  return `
    <button class="inbox-card" data-action="select-session" data-session-id="${session.id}">
      <div class="row-title">
        <span>${escapeHtml(session.title)}</span>
        <span class="status-badge status-${escapeHtml(session.status)}">${escapeHtml(statusLabel(session.status))}</span>
      </div>
      <div class="row-subtitle">${escapeHtml(repo?.name || "Unknown Repo")}</div>
      <div class="row-meta">${escapeHtml(session.blocker?.summary || previewTranscript(session.transcript))}</div>
    </button>
  `;
}

function renderRepoSession(session, repo) {
  return `
    <button class="session-row ${selectionMatches("session", session.id) ? "active" : ""}" data-action="select-session" data-session-id="${session.id}">
      <div class="row-title">
        <span>${escapeHtml(session.title)}</span>
        <span class="status-badge status-${escapeHtml(session.status)}">${escapeHtml(statusLabel(session.status))}</span>
      </div>
      <div class="row-subtitle">${escapeHtml(repo.name)}</div>
      <div class="row-meta">${escapeHtml(previewTranscript(session.transcript))}</div>
    </button>
  `;
}

function renderDialogs() {
  renderLauncherDialog();
  renderQuickSwitcherDialog();
  renderCommandPaletteDialog();
  if (settingsDialog.open) {
    renderSettingsDialog();
  }
}

function renderLauncherDialog() {
  const normalized = ui.launcherQuery.trim().toLowerCase();
  const repos = state.repos.filter((repo) => {
    if (!normalized) {
      return true;
    }

    return (
      repo.name.toLowerCase().includes(normalized) ||
      repo.path.toLowerCase().includes(normalized)
    );
  });

  launcherDialog.innerHTML = `
    <form method="dialog" class="dialog-body">
      <div class="dialog-header">
        <div>
          <div class="eyebrow">Session Launcher</div>
          <h2 class="dialog-title">New session</h2>
          <div class="muted">Open a real shell in any repo, then optionally auto-enter Claude.</div>
        </div>
        <button value="cancel">Close</button>
      </div>
      <input id="launcher-query" placeholder="Find a repo" value="${escapeAttribute(ui.launcherQuery)}" />
      <div class="dialog-grid">
        <div class="dialog-list">
          ${
            repos.length
              ? repos
                  .map(
                    (repo) => `
                      <button
                        type="button"
                        class="switcher-row ${ui.launcherSelectedRepoId === repo.id ? "active" : ""}"
                        data-action="launcher-select-repo"
                        data-repo-id="${repo.id}">
                        <div class="row-title">${escapeHtml(repo.name)}</div>
                        <div class="row-subtitle">${escapeHtml(abbreviateHome(repo.path))}</div>
                      </button>
                    `
                  )
                  .join("")
              : `<div class="muted">No repos match your search.</div>`
          }
        </div>
        <div class="dialog-panel">
          <div>
            <div class="row-title">Shell-backed session</div>
            <div class="row-subtitle">The terminal starts in the selected repo so you can enter and exit Claude normally.</div>
          </div>
          <label class="inline-toggle">
            <input type="checkbox" id="launcher-launches-claude" ${ui.launcherLaunchesClaudeOnStart ? "checked" : ""} />
            <span>Launch Claude immediately</span>
          </label>
          <div class="muted">When enabled, the app starts your login shell and runs the configured Claude command.</div>
          <div style="flex: 1;"></div>
          <div class="dialog-footer">
            <button type="button" data-action="launcher-close">Cancel</button>
            <button type="button" class="primary" data-action="launcher-start" ${ui.launcherSelectedRepoId ? "" : "disabled"}>Start Session</button>
          </div>
        </div>
      </div>
    </form>
  `;
}

function renderQuickSwitcherDialog() {
  const normalized = ui.quickSwitcherQuery.trim().toLowerCase();
  const sessions = state.sessions.filter((session) => {
    if (!normalized) {
      return true;
    }
    const repoName = (repoById(session.repoID)?.name || "").toLowerCase();
    return session.title.toLowerCase().includes(normalized) || repoName.includes(normalized);
  });
  const repos = state.repos.filter((repo) => {
    if (!normalized) {
      return true;
    }
    return repo.name.toLowerCase().includes(normalized) || repo.path.toLowerCase().includes(normalized);
  });

  quickSwitcherDialog.innerHTML = `
    <form method="dialog" class="dialog-body">
      <div class="dialog-header">
        <div>
          <div class="eyebrow">Quick Switcher</div>
          <h2 class="dialog-title">Jump instantly</h2>
        </div>
        <button value="cancel">Close</button>
      </div>
      <input id="quick-switcher-query" placeholder="Search sessions or repos" value="${escapeAttribute(ui.quickSwitcherQuery)}" />
      <div class="dialog-panel">
        <div class="section-label">Sessions</div>
        <div class="dialog-list">
          ${sessions
            .slice(0, 20)
            .map(
              (session) => `
                <button type="button" class="switcher-row" data-action="switch-session" data-session-id="${session.id}">
                  <div class="row-title">${escapeHtml(session.title)}</div>
                  <div class="row-subtitle">${escapeHtml(repoById(session.repoID)?.name || "Unknown Repo")}</div>
                </button>
              `
            )
            .join("")}
        </div>
        <div class="section-label">Repos</div>
        <div class="dialog-list">
          ${repos
            .slice(0, 20)
            .map(
              (repo) => `
                <button type="button" class="switcher-row" data-action="switch-repo" data-repo-id="${repo.id}">
                  <div class="row-title">${escapeHtml(repo.name)}</div>
                  <div class="row-subtitle">${escapeHtml(abbreviateHome(repo.path))}</div>
                </button>
              `
            )
            .join("")}
        </div>
      </div>
    </form>
  `;
}

function renderCommandPaletteDialog() {
  const commands = [
    { id: "open-workspace", label: "Open Workspace", action: "open-workspace" },
    { id: "create-project", label: "Create Project Folder", action: "create-project" },
    { id: "open-launcher", label: "New Session", action: "open-launcher" },
    { id: "open-settings", label: "Open Settings", action: "open-settings" },
    { id: "open-quick-switcher", label: "Open Quick Switcher", action: "open-quick-switcher" },
    { id: "next-unread", label: "Jump to Next Unread Session", action: "next-unread" }
  ];

  const normalized = ui.commandPaletteQuery.trim().toLowerCase();
  const filtered = commands.filter((command) =>
    !normalized || command.label.toLowerCase().includes(normalized)
  );

  commandPaletteDialog.innerHTML = `
    <form method="dialog" class="dialog-body">
      <div class="dialog-header">
        <div>
          <div class="eyebrow">Command Palette</div>
          <h2 class="dialog-title">Run a command</h2>
        </div>
        <button value="cancel">Close</button>
      </div>
      <input id="command-palette-query" placeholder="Search commands" value="${escapeAttribute(ui.commandPaletteQuery)}" />
      <div class="dialog-list">
        ${filtered
          .map(
            (command) => `
              <button type="button" class="command-row" data-action="${command.action}">
                <div class="row-title">${escapeHtml(command.label)}</div>
              </button>
            `
          )
          .join("")}
      </div>
    </form>
  `;
}

async function renderSettingsDialog() {
  const repoId = currentRepoId();
  if (!ui.settingsContext) {
    ui.settingsContext = await api.getClaudeSettingsContext(repoId);
    const firstFile = allSettingsFiles()[0];
    if (firstFile) {
      ui.settingsSelectedFilePath = firstFile.path;
      ui.settingsEditorText = await api.loadSettingsFile(firstFile.path);
    }
  }

  settingsDialog.innerHTML = `
    <form method="dialog" class="dialog-body">
      <div class="dialog-header">
        <div>
          <div class="eyebrow">Settings</div>
          <h2 class="dialog-title">Preferences and Claude files</h2>
          <div class="muted">Global command settings, project-specific Claude files, and resolved JSON values.</div>
        </div>
        <button value="cancel">Close</button>
      </div>

      <div class="settings-tabs">
        <button type="button" class="settings-tab ${ui.settingsTab === "general" ? "active" : ""}" data-action="settings-tab" data-tab="general">General</button>
        <button type="button" class="settings-tab ${ui.settingsTab === "claude" ? "active" : ""}" data-action="settings-tab" data-tab="claude">Claude Files</button>
      </div>

      ${
        ui.settingsTab === "general"
          ? renderGeneralSettingsPane()
          : renderClaudeSettingsPane()
      }
    </form>
  `;
}

function renderGeneralSettingsPane() {
  return `
    <div class="dialog-panel">
      <label>
        <div class="row-title">Claude Command</div>
        <input id="pref-claude-command" value="${escapeAttribute(state.preferences.claudeExecutablePath || "")}" />
      </label>
      <div class="muted">This command is typed into the session shell when Launch Claude immediately is enabled.</div>

      <label>
        <div class="row-title">Shell Executable</div>
        <input id="pref-shell-executable" value="${escapeAttribute(state.preferences.shellExecutablePath || "")}" />
      </label>
      <div class="muted">Sessions start as login shells in the selected repo so you can enter and exit Claude normally.</div>

      <label class="inline-toggle">
        <input type="checkbox" id="pref-notifications-enabled" ${state.preferences.notificationsEnabled ? "checked" : ""} />
        <span>Enable Notifications</span>
      </label>
      <label class="inline-toggle">
        <input type="checkbox" id="pref-native-notifications" ${state.preferences.showNativeNotifications ? "checked" : ""} />
        <span>Show Native macOS Notifications</span>
      </label>
      <label class="inline-toggle">
        <input type="checkbox" id="pref-in-app-badges" ${state.preferences.showInAppBadges ? "checked" : ""} />
        <span>Show In-App Badges</span>
      </label>
    </div>
  `;
}

function renderClaudeSettingsPane() {
  const context = ui.settingsContext || { globalFiles: [], projectFiles: [], resolvedValues: [] };
  const selectedFile = allSettingsFiles().find((file) => file.path === ui.settingsSelectedFilePath) || null;

  return `
    <div class="settings-layout">
      <div class="dialog-list">
        <div class="section-label">Global</div>
        ${context.globalFiles.map((file) => renderSettingsFileRow(file)).join("")}
        ${context.projectFiles.length ? `<div class="section-label">Project</div>` : ""}
        ${context.projectFiles.map((file) => renderSettingsFileRow(file)).join("")}
      </div>

      <div class="dialog-panel">
        ${
          selectedFile
            ? `
              <div class="detail-actions">
                <div>
                  <div class="row-title">${escapeHtml(selectedFile.title)}</div>
                  <div class="row-subtitle">${escapeHtml(abbreviateHome(selectedFile.path))}</div>
                </div>
                <div style="margin-left:auto;" class="detail-actions">
                  <button type="button" data-action="settings-reload-file">Reload</button>
                  <button type="button" data-action="settings-save-file" class="primary">${selectedFile.exists ? "Save" : "Create"}</button>
                  <button type="button" data-action="settings-reveal-file">Reveal</button>
                </div>
              </div>
              <textarea id="settings-editor">${escapeHtml(ui.settingsEditorText)}</textarea>
              ${
                ui.settingsSaveMessage
                  ? `<div class="muted">${escapeHtml(ui.settingsSaveMessage)}</div>`
                  : ""
              }
            `
            : `<div class="empty-state">Select a global or project Claude file to edit it.</div>`
        }

        <div>
          <div class="row-title">Resolved JSON Values</div>
          <div class="settings-values">
            ${
              context.resolvedValues.length
                ? context.resolvedValues
                    .map(
                      (value) => `
                        <div class="value-row">
                          <div class="row-title mono">${escapeHtml(value.keyPath)}</div>
                          <div class="row-subtitle">${escapeHtml(value.sourceLabel)}</div>
                          <div class="row-meta mono">${escapeHtml(value.valueSummary)}</div>
                        </div>
                      `
                    )
                    .join("")
                : `<div class="value-row muted">No JSON settings are currently available to resolve.</div>`
            }
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderSettingsFileRow(file) {
  return `
    <button
      type="button"
      class="switcher-row ${ui.settingsSelectedFilePath === file.path ? "active" : ""}"
      data-action="settings-select-file"
      data-file-path="${file.path}">
      <div class="row-title">${escapeHtml(file.title)}</div>
      <div class="row-subtitle">${file.exists ? "Exists" : "Missing"}</div>
    </button>
  `;
}

async function handleClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }

  const { action } = target.dataset;

  switch (action) {
    case "select-inbox":
      await selectInbox();
      break;
    case "select-repo":
      await selectRepo(target.dataset.repoId);
      break;
    case "select-session":
      await selectSession(target.dataset.sessionId);
      break;
    case "open-launcher":
      openLauncher(target.dataset.repoId || currentRepoId());
      break;
    case "open-settings":
      await openSettings();
      break;
    case "open-workspace":
      await api.openWorkspaceFolder();
      break;
    case "create-project":
      await api.createProjectFolder();
      break;
    case "rescan-workspace":
      await api.rescanWorkspace(target.dataset.workspaceId);
      break;
    case "reveal-repo":
      if (target.dataset.repoId) {
        await api.openRepoInFinder(target.dataset.repoId);
      }
      break;
    case "close-session":
      await api.closeSession(target.dataset.sessionId);
      if (ui.selection.type === "session" && ui.selection.id === target.dataset.sessionId) {
        await selectInbox();
      }
      break;
    case "restart-session":
      await api.reopenSession(target.dataset.sessionId);
      break;
    case "approve-blocker":
      await api.sendInput(target.dataset.sessionId, "1\r");
      break;
    case "deny-blocker":
      await api.sendInput(target.dataset.sessionId, "3\r");
      break;
    case "launcher-select-repo":
      ui.launcherSelectedRepoId = target.dataset.repoId;
      renderLauncherDialog();
      break;
    case "launcher-close":
      launcherDialog.close();
      break;
    case "launcher-start":
      await startLauncherSession();
      break;
    case "open-quick-switcher":
      openQuickSwitcher();
      break;
    case "switch-session":
      quickSwitcherDialog.close();
      await selectSession(target.dataset.sessionId);
      break;
    case "switch-repo":
      quickSwitcherDialog.close();
      await selectRepo(target.dataset.repoId);
      break;
    case "settings-tab":
      ui.settingsTab = target.dataset.tab;
      await renderSettingsDialog();
      break;
    case "settings-select-file":
      ui.settingsSelectedFilePath = target.dataset.filePath;
      ui.settingsEditorText = await api.loadSettingsFile(target.dataset.filePath);
      ui.settingsSaveMessage = "";
      await renderSettingsDialog();
      break;
    case "settings-save-file":
      await saveCurrentSettingsFile();
      break;
    case "settings-reload-file":
      if (ui.settingsSelectedFilePath) {
        ui.settingsEditorText = await api.loadSettingsFile(ui.settingsSelectedFilePath);
        ui.settingsSaveMessage = "";
        await renderSettingsDialog();
      }
      break;
    case "settings-reveal-file":
      if (ui.settingsSelectedFilePath) {
        await api.revealPath(ui.settingsSelectedFilePath);
      }
      break;
    case "next-unread": {
      const nextSessionId = await api.nextUnreadSession();
      if (nextSessionId) {
        commandPaletteDialog.close();
        await selectSession(nextSessionId);
      }
      break;
    }
    default:
      break;
  }
}

async function handleInput(event) {
  switch (event.target.id) {
    case "launcher-query":
      ui.launcherQuery = event.target.value;
      renderLauncherDialog();
      break;
    case "quick-switcher-query":
      ui.quickSwitcherQuery = event.target.value;
      renderQuickSwitcherDialog();
      break;
    case "command-palette-query":
      ui.commandPaletteQuery = event.target.value;
      renderCommandPaletteDialog();
      break;
    case "settings-editor":
      ui.settingsEditorText = event.target.value;
      break;
    default:
      break;
  }
}

async function handleChange(event) {
  switch (event.target.id) {
    case "launcher-launches-claude":
      ui.launcherLaunchesClaudeOnStart = event.target.checked;
      break;
    case "pref-notifications-enabled":
      await api.updatePreferences({ notificationsEnabled: event.target.checked });
      break;
    case "pref-claude-command":
      await api.updatePreferences({ claudeExecutablePath: event.target.value });
      break;
    case "pref-shell-executable":
      await api.updatePreferences({ shellExecutablePath: event.target.value });
      break;
    case "pref-native-notifications":
      await api.updatePreferences({ showNativeNotifications: event.target.checked });
      break;
    case "pref-in-app-badges":
      await api.updatePreferences({ showInAppBadges: event.target.checked });
      break;
    default:
      break;
  }
}

async function selectInbox() {
  ui.selection = { type: "inbox", id: null };
  await api.setFocusedSession(null);
  renderSidebar();
  renderDetail();
}

async function selectRepo(repoId) {
  ui.selection = { type: "repo", id: repoId };
  await api.setFocusedSession(null);
  renderSidebar();
  renderDetail();
}

async function selectSession(sessionId) {
  ui.selection = { type: "session", id: sessionId };
  await api.setFocusedSession(sessionId);
  renderSidebar();
  renderDetail();
}

function openLauncher(repoId = null) {
  ui.launcherQuery = "";
  ui.launcherSelectedRepoId =
    repoId ||
    currentRepoId() ||
    state.repos[0]?.id ||
    null;
  ui.launcherLaunchesClaudeOnStart = true;
  renderLauncherDialog();
  if (!launcherDialog.open) {
    launcherDialog.showModal();
  }
}

async function startLauncherSession() {
  if (!ui.launcherSelectedRepoId) {
    return;
  }

  const sessionId = await api.createSession(
    ui.launcherSelectedRepoId,
    ui.launcherLaunchesClaudeOnStart
  );

  launcherDialog.close();
  if (sessionId) {
    await selectSession(sessionId);
  }
}

async function openSettings() {
  ui.settingsTab = "general";
  ui.settingsContext = null;
  ui.settingsSelectedFilePath = null;
  ui.settingsEditorText = "";
  ui.settingsSaveMessage = "";
  await renderSettingsDialog();
  if (!settingsDialog.open) {
    settingsDialog.showModal();
  }
}

function openQuickSwitcher() {
  ui.quickSwitcherQuery = "";
  renderQuickSwitcherDialog();
  if (!quickSwitcherDialog.open) {
    quickSwitcherDialog.showModal();
  }
}

function openCommandPalette() {
  ui.commandPaletteQuery = "";
  renderCommandPaletteDialog();
  if (!commandPaletteDialog.open) {
    commandPaletteDialog.showModal();
  }
}

async function saveCurrentSettingsFile() {
  if (!ui.settingsSelectedFilePath) {
    return;
  }

  await api.saveSettingsFile(ui.settingsSelectedFilePath, ui.settingsEditorText);
  ui.settingsContext = await api.getClaudeSettingsContext(currentRepoId());
  ui.settingsSaveMessage = `Saved ${pathLabel(ui.settingsSelectedFilePath)}`;
  await renderSettingsDialog();
}

function allSettingsFiles() {
  if (!ui.settingsContext) {
    return [];
  }

  return [...ui.settingsContext.globalFiles, ...ui.settingsContext.projectFiles];
}

function mergeSessionSummary(summary) {
  const index = state.sessions.findIndex((session) => session.id === summary.id);
  if (index < 0) {
    return null;
  }

  state.sessions[index] = {
    ...state.sessions[index],
    ...summary
  };

  return state.sessions[index];
}

function appendSessionOutput(sessionId, chunk, summary) {
  const session = mergeSessionSummary(summary);
  if (!session) {
    return null;
  }

  session.rawTranscript = trimRawTranscript(`${session.rawTranscript || ""}${chunk}`);
  return session;
}

function sessionById(sessionId) {
  return state.sessions.find((session) => session.id === sessionId) || null;
}

function repoById(repoId) {
  return state.repos.find((repo) => repo.id === repoId) || null;
}

function currentRepoId() {
  if (ui.selection.type === "repo") {
    return ui.selection.id;
  }

  if (ui.selection.type === "session") {
    return sessionById(ui.selection.id)?.repoID || null;
  }

  return null;
}

function inboxSessions() {
  return [...state.sessions]
    .filter((session) => session.blocker || session.unreadCount > 0)
    .sort((left, right) => {
      if (!!left.blocker !== !!right.blocker) {
        return left.blocker ? -1 : 1;
      }

      return right.updatedAt.localeCompare(left.updatedAt);
    });
}

function selectionMatches(type, id = null) {
  return ui.selection.type === type && (id === null || ui.selection.id === id);
}

function statusLabel(status) {
  switch (status) {
    case "needs_input":
      return "Needs Input";
    case "blocked":
      return "Blocked";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "idle":
      return "Idle";
    default:
      return "Running";
  }
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

function previewTranscript(transcript) {
  const normalized = (transcript || "").trim().split("\n").filter(Boolean).slice(-1)[0];
  return normalized || "No transcript yet.";
}

function abbreviateHome(value) {
  return value.replace(/^\/Users\/[^/]+/, "~");
}

function trimRawTranscript(value) {
  return value.length > 250000 ? value.slice(-250000) : value;
}

function pathLabel(filePath) {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
