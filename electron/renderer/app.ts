const api = window.claudeWorkspace;
const SECTION_ORDER = ["sidebar", "sidebar-drawer", "main", "terminal"] as const;
type SectionId = (typeof SECTION_ORDER)[number];

const state = {
  workspaces: [] as any[],
  repos: [] as any[],
  sessions: [] as any[],
  preferences: {} as Record<string, any>
};

const ui = {
  selection: { type: "inbox", id: null },
  focusSection: "main" as SectionId,
  sidebarExpandedRepoId: null as string | null,
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
  settingsSaveMessage: "",
  settingsJsonDraft: null,
  settingsJsonError: "",
  settingsShowRawJson: false
};

const sidebarElement = document.getElementById("sidebar") as HTMLElement;
const detailElement = document.getElementById("detail") as HTMLElement;
const appShellElement = document.getElementById("app-shell") as HTMLElement;
const launcherDialog = document.getElementById("launcher-dialog") as HTMLDialogElement;
const settingsDialog = document.getElementById("settings-dialog") as HTMLDialogElement;
const quickSwitcherDialog = document.getElementById("quick-switcher-dialog") as HTMLDialogElement;
const commandPaletteDialog = document.getElementById("command-palette-dialog") as HTMLDialogElement;
const colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

sidebarElement.tabIndex = -1;
detailElement.tabIndex = -1;

type JsonRenderOptions = {
  customLabel?: string;
  allowRemove?: boolean;
  includeJsonToggle?: boolean;
  forceRawEditor?: boolean;
};

syncColorSchemeClass();

if (typeof colorSchemeQuery.addEventListener === "function") {
  colorSchemeQuery.addEventListener("change", handleColorSchemeChange);
} else if (typeof colorSchemeQuery.addListener === "function") {
  colorSchemeQuery.addListener(handleColorSchemeChange);
}

document.addEventListener("click", handleClick);
document.addEventListener("input", handleInput);
document.addEventListener("change", handleChange);
document.addEventListener("pointerdown", handlePointerDown, true);
document.addEventListener("keydown", handleKeyDown, true);

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
        await selectSession(nextSessionId, "terminal");
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

function handleColorSchemeChange() {
  syncColorSchemeClass();

  if (ui.terminal) {
    ui.terminal.options.theme = buildTerminalTheme();
  }
}

function syncColorSchemeClass() {
  document.documentElement.classList.toggle("dark", colorSchemeQuery.matches);
}

function readCssVar(name, fallback = "") {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function terminalFontFamily() {
  return readCssVar("--font-mono", 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace');
}

function buildTerminalTheme() {
  return {
    background: readCssVar("--terminal-background", "#121212"),
    foreground: readCssVar("--terminal-foreground", "#f4f4f4"),
    cursor: readCssVar("--terminal-cursor", "#7dd3fc"),
    cursorAccent: readCssVar("--terminal-cursor-accent", "#161616"),
    selectionBackground: readCssVar("--terminal-selection", "rgba(125, 211, 252, 0.28)"),
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
  };
}

async function initialize() {
  replaceState(await api.getState());
  ensureValidSelection();
  normalizeFocusSection();
  renderSidebar();
  renderDetail();
  renderDialogs();
}

function replaceState(nextState) {
  state.workspaces = nextState.workspaces || [];
  state.repos = nextState.repos || [];
  state.sessions = nextState.sessions || [];
  state.preferences = nextState.preferences || {};
  if (ui.sidebarExpandedRepoId && !repoById(ui.sidebarExpandedRepoId)) {
    ui.sidebarExpandedRepoId = null;
  }
}

function ensureValidSelection() {
  if (ui.selection.type === "session" && !sessionById(ui.selection.id)) {
    ui.selection = { type: "inbox", id: null };
  }

  if (ui.selection.type === "repo" && !repoById(ui.selection.id)) {
    ui.selection = { type: "inbox", id: null };
  }

  normalizeFocusSection();
}

function renderSidebar() {
  const expandedRepo = expandedSidebarRepo();

  sidebarElement.innerHTML = `
    <div class="sidebar-shell ${expandedRepo ? "sidebar-shell-expanded" : ""}">
      <div class="sidebar-rail">
        <div class="sidebar-rail-top">
          ${renderInboxRailButton()}
          <div class="sidebar-rail-divider"></div>
          ${renderProjectRailButtons()}
        </div>
        <div class="sidebar-rail-bottom">
          <button class="sidebar-rail-button sidebar-utility-button" data-action="open-workspace" data-tooltip="Add Workspace" title="Add Workspace" aria-label="Add Workspace">
            ${renderUtilityIcon("workspace")}
          </button>
          <button class="sidebar-rail-button sidebar-utility-button" data-action="create-project" data-tooltip="New Folder" title="New Folder" aria-label="New Folder">
            ${renderUtilityIcon("folder")}
          </button>
          <button class="sidebar-rail-button sidebar-utility-button" data-action="open-settings" data-tooltip="Settings" title="Settings" aria-label="Settings">
            ${renderUtilityIcon("settings")}
          </button>
        </div>
      </div>
      ${expandedRepo ? renderSidebarProjectDrawer(expandedRepo) : ""}
    </div>
  `;

  syncSectionFocusUi();
}

function renderInboxRailButton() {
  const count = inboxSessions().length;

  return `
    <button class="sidebar-rail-button sidebar-home-button ${selectionMatches("inbox") ? "active" : ""}" data-action="select-inbox" data-tooltip="Inbox" title="Inbox" aria-label="Inbox">
      ${renderUtilityIcon("inbox")}
      ${count ? `<span class="sidebar-rail-badge">${count > 9 ? "9+" : count}</span>` : ""}
    </button>
  `;
}

function renderProjectRailButtons() {
  if (!state.repos.length) {
    return `<div class="sidebar-rail-empty" data-tooltip="Add a workspace to start">?</div>`;
  }

  return [...state.repos]
    .sort(compareRepos)
    .map((repo) => renderProjectRailButton(repo))
    .join("");
}

function renderProjectRailButton(repo) {
  const sessions = sessionsForRepo(repo.id);
  const liveCount = sessions.filter((session) => session.runtimeState === "live").length;
  const attentionCount = sessions.filter((session) => session.blocker || session.unreadCount > 0).length;
  const active = currentRepoId() === repo.id;
  const expanded = ui.sidebarExpandedRepoId === repo.id;
  const badgeLabel = attentionCount ? (attentionCount > 9 ? "9+" : String(attentionCount)) : "";

  return `
    <button class="sidebar-rail-button sidebar-project-button ${active ? "active" : ""} ${expanded ? "expanded" : ""}" data-action="select-repo" data-repo-id="${repo.id}" data-tooltip="${escapeAttribute(repo.name)}" title="${escapeAttribute(repo.name)}" aria-label="${escapeAttribute(repo.name)}">
      <span class="sidebar-project-avatar" aria-hidden="true">${renderProjectAvatar(repo)}</span>
      ${
        badgeLabel
          ? `<span class="sidebar-rail-badge">${badgeLabel}</span>`
          : liveCount
            ? `<span class="sidebar-rail-dot"></span>`
            : ""
      }
    </button>
  `;
}

function renderSidebarProjectDrawer(repo) {
  const sessions = sessionsForRepo(repo.id);

  return `
    <section class="sidebar-project-drawer" tabindex="-1">
      <div class="sidebar-project-drawer-header">
        <div class="sidebar-project-drawer-title-row">
          <div class="sidebar-project-drawer-avatar" aria-hidden="true">${renderProjectAvatar(repo)}</div>
          <div class="sidebar-project-drawer-copy">
            <div class="sidebar-project-drawer-title">${escapeHtml(repo.name)}</div>
            <div class="sidebar-project-drawer-path">${escapeHtml(abbreviateHome(repo.path))}</div>
          </div>
        </div>
        <button class="ghost sidebar-project-drawer-close" data-action="collapse-sidebar-project" data-repo-id="${repo.id}" aria-label="Collapse ${escapeAttribute(repo.name)}">Close</button>
      </div>
      <div class="sidebar-project-drawer-section-label">Sessions</div>
      <div class="sidebar-project-drawer-list">
        ${
          sessions.length
            ? sessions.map((session) => renderSidebarDrawerSession(session, repo)).join("")
            : `<div class="sidebar-project-drawer-empty">No sessions yet.</div>`
        }
      </div>
    </section>
  `;
}

function renderSidebarDrawerSession(session, repo) {
  return `
    <button class="session-row ${selectionMatches("session", session.id) ? "active" : ""}" data-action="select-session" data-session-id="${session.id}">
      <div class="row-title">
        <span>${escapeHtml(session.title)}</span>
        ${session.unreadCount && state.preferences.showInAppBadges ? '<span class="unread-dot"></span>' : ""}
      </div>
      <div class="row-subtitle">${escapeHtml(repo.name)}</div>
      <div class="row-meta">${escapeHtml(previewTranscript(session.transcript))}</div>
    </button>
  `;
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
          <h1 class="detail-title">Review queue</h1>
          <div class="muted">Blocked sessions and unread activity.</div>
        </div>
        <div class="detail-actions">
          <button class="primary" data-action="open-launcher">New Session</button>
          <button data-action="open-quick-switcher">Jump To</button>
        </div>
      </div>
      ${
        sessions.length
          ? `<div class="card-grid">${sessions.map(renderInboxCard).join("")}</div>`
          : `<div class="empty-state">Blocked and unread sessions will appear here.</div>`
      }
    </section>
  `;

  syncSectionFocusUi();
}

function renderRepoDetail(repo) {
  if (!repo) {
    detailElement.innerHTML = `<div class="empty-state">This repo is no longer available.</div>`;
    syncSectionFocusUi();
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
          <button data-action="reveal-repo" data-repo-id="${repo.id}">Reveal</button>
          <button data-action="rescan-workspace" data-workspace-id="${repo.workspaceID}">Refresh</button>
          <button class="primary" data-action="open-launcher" data-repo-id="${repo.id}">New Session</button>
        </div>
      </div>
      ${
        sessions.length
          ? `<div class="repo-session-list">${sessions.map((session) => renderRepoSession(session, repo)).join("")}</div>`
          : `<div class="empty-state">Start a shell session for this repo.</div>`
      }
    </section>
  `;

  syncSectionFocusUi();
}

function renderSessionDetail(session) {
  if (!session) {
    detailElement.innerHTML = `<div class="empty-state">This session is no longer available.</div>`;
    destroyTerminal();
    return;
  }

  detailElement.innerHTML = `
    <section class="session-detail">
      <div id="session-main-region" class="session-main-region" tabindex="-1">
        <div id="session-chrome"></div>
        <div id="session-blocker"></div>
      </div>
      <div class="terminal-wrap" tabindex="-1">
        <div id="terminal-shell">
          <div id="terminal"></div>
        </div>
      </div>
    </section>
  `;

  updateSessionChrome(session);
  mountTerminal(session);
  syncSectionFocusUi();
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
        <button data-action="open-settings" data-settings-tab="claude">Claude Files</button>
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
      fontFamily: terminalFontFamily(),
      fontSize: 13,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      scrollback: 10000,
      theme: buildTerminalTheme()
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
    ui.terminal.write(terminalReplayText(session));
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
  if (session.runtimeState === "live" && ui.focusSection === "terminal" && !isAnyDialogOpen()) {
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

function terminalReplayText(session) {
  return session.rawTranscript || session.transcript || "";
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
          <div class="muted">Open a shell in any repo, then optionally start Claude.</div>
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
          <div class="muted">When enabled, your login shell runs the configured Claude command.</div>
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
  }

  const availableFiles = allSettingsFiles();
  const selectedExists = availableFiles.some((file) => file.path === ui.settingsSelectedFilePath);

  if (!selectedExists) {
    const firstFile = availableFiles[0];
    if (firstFile) {
      await loadSelectedSettingsFile(firstFile.path);
    }
  }

  settingsDialog.innerHTML = `
    <form method="dialog" class="dialog-body">
      <div class="dialog-header">
        <div>
          <div class="eyebrow">Settings</div>
          <h2 class="dialog-title">Preferences and Claude files</h2>
          <div class="muted">Edit app preferences, Claude instructions, and JSON settings in a format people can actually read.</div>
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
  const globalFiles = sortSettingsFiles(context.globalFiles);
  const projectFiles = sortSettingsFiles(context.projectFiles);
  const selectedFile = allSettingsFiles().find((file) => file.path === ui.settingsSelectedFilePath) || null;
  const projectRepo = repoById(currentRepoId());

  return `
    <div class="settings-layout">
      <div class="dialog-list">
        <div class="section-label">Global</div>
        ${globalFiles.map((file) => renderSettingsFileRow(file)).join("")}
        ${
          projectFiles.length
            ? `<div class="section-label">Project${projectRepo ? ` · ${escapeHtml(projectRepo.name)}` : ""}</div>`
            : ""
        }
        ${projectFiles.map((file) => renderSettingsFileRow(file)).join("")}
      </div>

      <div class="dialog-panel">
        ${
          selectedFile
            ? renderSelectedSettingsPanel(selectedFile, context)
            : `<div class="empty-state">Select a global or project Claude file to edit it.</div>`
        }
      </div>
    </div>
  `;
}

function renderSelectedSettingsPanel(selectedFile, context) {
  return isJsonSettingsFile(selectedFile)
    ? renderJsonSettingsPanel(selectedFile, context)
    : renderTextSettingsPanel(selectedFile);
}

function renderTextSettingsPanel(selectedFile) {
  return `
    <div class="settings-surface">
      <div class="settings-file-hero">
        <div class="settings-file-copy">
          <div class="eyebrow">${escapeHtml(settingsScopeLabel(selectedFile))}</div>
          <div class="settings-file-header">
            <div>
              <div class="row-title">${escapeHtml(friendlySettingsFileTitle(selectedFile))}</div>
              <div class="row-subtitle">${escapeHtml(abbreviateHome(selectedFile.path))}</div>
            </div>
            ${renderSettingsActionButtons(selectedFile)}
          </div>
          <div class="muted">${escapeHtml(friendlySettingsFileSummary(selectedFile))}</div>
        </div>
        <div class="settings-stat-grid">
          ${renderSettingsStat("Format", "Markdown")}
          ${renderSettingsStat("Status", selectedFile.exists ? "Ready" : "Missing")}
          ${renderSettingsStat("Scope", selectedFile.scope === "global" ? "Global" : "Project")}
        </div>
      </div>

      <div class="settings-editor-card">
        <div class="settings-help-row">
          <div>
            <div class="row-title">Instruction File</div>
            <div class="muted">This file stays as Markdown so you can keep free-form instructions and examples.</div>
          </div>
          <span class="settings-chip">Text Editor</span>
        </div>
        <textarea id="settings-text-editor">${escapeHtml(ui.settingsEditorText)}</textarea>
      </div>

      ${renderSettingsSaveMessage()}
    </div>
  `;
}

function renderJsonSettingsPanel(selectedFile, context) {
  const currentValue = currentJsonSettingsValue();
  const parseError = ui.settingsJsonError;
  const forceRawEditor = !!parseError;
  const showRawEditor = ui.settingsShowRawJson || forceRawEditor;
  const topLevelCount = countTopLevelJsonEntries(currentValue);
  const leafCount = countLeafJsonEntries(currentValue);
  const effectiveCount = context.resolvedValues.filter(
    (value) => value.sourceLabel === selectedFile.title
  ).length;

  return `
    <div class="settings-surface">
      <div class="settings-file-hero">
        <div class="settings-file-copy">
          <div class="eyebrow">${escapeHtml(settingsScopeLabel(selectedFile))}</div>
          <div class="settings-file-header">
            <div>
              <div class="row-title">${escapeHtml(friendlySettingsFileTitle(selectedFile))}</div>
              <div class="row-subtitle">${escapeHtml(abbreviateHome(selectedFile.path))}</div>
            </div>
            ${renderSettingsActionButtons(selectedFile, { includeJsonToggle: true, forceRawEditor })}
          </div>
          <div class="muted">${escapeHtml(friendlySettingsFileSummary(selectedFile))}</div>
        </div>
        <div class="settings-stat-grid">
          ${renderSettingsStat("Top-level", String(topLevelCount))}
          ${renderSettingsStat("Values", String(leafCount))}
          ${renderSettingsStat("Effective", String(effectiveCount))}
          ${renderSettingsStat("Status", selectedFile.exists ? "Ready" : "New File")}
        </div>
      </div>

      ${
        parseError
          ? `
            <div class="settings-warning-card">
              <div class="row-title">This file has invalid JSON</div>
              <div class="row-subtitle">Fix the parse error below to return to the form view.</div>
              <div class="row-meta mono">${escapeHtml(parseError)}</div>
            </div>
          `
          : ""
      }

      ${showRawEditor ? renderJsonRawEditor() : renderStructuredJsonEditor(currentValue)}

      ${renderSettingsSaveMessage()}
      ${renderResolvedSettingsPanel(context.resolvedValues)}
    </div>
  `;
}

function renderStructuredJsonEditor(currentValue) {
  return `
    <div class="settings-editor-card">
      <div class="settings-help-row">
        <div>
          <div class="row-title">Editable Settings</div>
          <div class="muted">Change the settings here and save when you’re ready. The matching JSON file stays in sync behind the scenes.</div>
        </div>
        <span class="settings-chip">Form View</span>
      </div>

      ${
        isJsonObject(currentValue)
          ? `
            ${
              Object.keys(currentValue).length
                ? `<div class="settings-field-stack">${renderJsonObjectFields(currentValue, [])}</div>`
                : `<div class="settings-empty-note">No settings have been defined yet. Add the first one below.</div>`
            }
            ${renderRootAddSettingCard()}
          `
          : `
            <div class="settings-field-stack">
              ${renderJsonNode(currentValue, [], { customLabel: "Root Value", allowRemove: false })}
            </div>
            <div class="muted">This file currently uses a ${describeJsonValueType(currentValue)} as its root value. Switch to Advanced JSON if you need to change the overall shape.</div>
          `
      }
    </div>
  `;
}

function renderJsonRawEditor() {
  return `
    <div class="settings-editor-card">
      <div class="settings-help-row">
        <div>
          <div class="row-title">Advanced JSON</div>
          <div class="muted">Use raw JSON for shapes the form doesn’t cover. As soon as the file parses cleanly again, you can switch back to the form.</div>
        </div>
        <span class="settings-chip">Raw JSON</span>
      </div>
      <textarea id="settings-json-raw-editor" class="settings-json-raw-editor" data-setting-editor="raw-json">${escapeHtml(ui.settingsEditorText)}</textarea>
    </div>
  `;
}

function renderResolvedSettingsPanel(resolvedValues) {
  return `
    <div class="settings-effective-panel">
      <div class="settings-help-row">
        <div>
          <div class="row-title">What Claude Will Use</div>
          <div class="muted">Project JSON files override global ones. This list shows the effective value for each resolved key.</div>
        </div>
        <span class="settings-chip">${resolvedValues.length} Resolved</span>
      </div>
      <div class="settings-values">
        ${
          resolvedValues.length
            ? resolvedValues
                .map(
                  (value) => `
                    <div class="value-row">
                      <div class="settings-file-row-top">
                        <div class="row-title">${escapeHtml(labelForResolvedKeyPath(value.keyPath))}</div>
                        <span class="settings-chip">${escapeHtml(friendlySourceLabel(value.sourceLabel))}</span>
                      </div>
                      <div class="row-subtitle mono">${escapeHtml(value.keyPath)}</div>
                      <div class="row-meta mono">${escapeHtml(value.valueSummary)}</div>
                    </div>
                  `
                )
                .join("")
            : `<div class="value-row muted">No JSON settings are currently available to resolve.</div>`
        }
      </div>
    </div>
  `;
}

function renderJsonObjectFields(objectValue, parentPath) {
  return Object.entries(objectValue)
    .map(([key, value]) => renderJsonNode(value, [...parentPath, key]))
    .join("");
}

function renderJsonNode(value, path, options: JsonRenderOptions = {}) {
  if (Array.isArray(value)) {
    return renderJsonArrayNode(value, path, options);
  }

  if (isJsonObject(value)) {
    return renderJsonObjectNode(value, path, options);
  }

  return renderJsonPrimitiveNode(value, path, options);
}

function renderJsonPrimitiveNode(value, path, options: JsonRenderOptions = {}) {
  const encodedPath = encodeSettingPath(path);
  const label = options.customLabel || labelForSettingPath(path);
  const allowRemove = options.allowRemove ?? path.length > 0;
  const pathLabelText = formatSettingPath(path);
  let controlMarkup = "";

  if (typeof value === "boolean") {
    controlMarkup = `
      <label class="settings-switch">
        <input type="checkbox" data-setting-editor="boolean" data-setting-path="${encodedPath}" ${value ? "checked" : ""} />
        <span>Enabled</span>
      </label>
    `;
  } else if (typeof value === "number") {
    controlMarkup = `
      <input
        type="number"
        step="any"
        data-setting-editor="number"
        data-setting-path="${encodedPath}"
        value="${escapeAttribute(String(value))}" />
    `;
  } else if (typeof value === "string") {
    controlMarkup =
      value.includes("\n") || value.length > 80
        ? `
          <textarea
            class="settings-field-textarea"
            data-setting-editor="string"
            data-setting-path="${encodedPath}">${escapeHtml(value)}</textarea>
        `
        : `
          <input
            type="text"
            data-setting-editor="string"
            data-setting-path="${encodedPath}"
            value="${escapeAttribute(value)}" />
        `;
  } else {
    controlMarkup = `
      <div class="settings-empty-note">This value is currently <span class="mono">null</span>.</div>
      <div class="settings-meta-row">
        <button type="button" data-action="settings-convert-field" data-setting-path="${encodedPath}" data-setting-value-kind="string">Use Text</button>
        <button type="button" data-action="settings-convert-field" data-setting-path="${encodedPath}" data-setting-value-kind="number">Use Number</button>
        <button type="button" data-action="settings-convert-field" data-setting-path="${encodedPath}" data-setting-value-kind="boolean">Use Toggle</button>
        <button type="button" data-action="settings-convert-field" data-setting-path="${encodedPath}" data-setting-value-kind="object">Use Group</button>
        <button type="button" data-action="settings-convert-field" data-setting-path="${encodedPath}" data-setting-value-kind="array">Use List</button>
      </div>
    `;
  }

  return `
    <div class="settings-field-card">
      <div class="settings-field-copy">
        <div class="settings-file-row-top">
          <div class="row-title">${escapeHtml(label)}</div>
          <span class="settings-chip">${escapeHtml(jsonValueTypeLabel(value))}</span>
        </div>
        <div class="row-subtitle mono">${escapeHtml(pathLabelText)}</div>
      </div>
      <div class="settings-field-control">
        ${controlMarkup}
      </div>
      ${
        allowRemove
          ? `<button type="button" class="ghost settings-field-remove" data-action="settings-remove-field" data-setting-path="${encodedPath}">Remove</button>`
          : ""
      }
    </div>
  `;
}

function renderJsonObjectNode(objectValue, path, options: JsonRenderOptions = {}) {
  const encodedPath = encodeSettingPath(path);
  const label = options.customLabel || labelForSettingPath(path);
  const allowRemove = options.allowRemove ?? path.length > 0;
  const childEntries = Object.keys(objectValue);

  return `
    <div class="settings-group-card">
      <div class="settings-group-header">
        <div class="settings-field-copy">
          <div class="settings-file-row-top">
            <div class="row-title">${escapeHtml(label)}</div>
            <span class="settings-chip">${childEntries.length} Fields</span>
          </div>
          <div class="row-subtitle mono">${escapeHtml(formatSettingPath(path))}</div>
        </div>
        ${
          allowRemove
            ? `<button type="button" class="ghost settings-field-remove" data-action="settings-remove-field" data-setting-path="${encodedPath}">Remove Group</button>`
            : ""
        }
      </div>
      ${
        childEntries.length
          ? `<div class="settings-group-body">${renderJsonObjectFields(objectValue, path)}</div>`
          : `<div class="settings-empty-note">This group is empty. Use Advanced JSON if you need to add nested keys here.</div>`
      }
    </div>
  `;
}

function renderJsonArrayNode(arrayValue, path, options: JsonRenderOptions = {}) {
  const encodedPath = encodeSettingPath(path);
  const label = options.customLabel || labelForSettingPath(path);
  const allowRemove = options.allowRemove ?? path.length > 0;

  return `
    <div class="settings-group-card">
      <div class="settings-group-header">
        <div class="settings-field-copy">
          <div class="settings-file-row-top">
            <div class="row-title">${escapeHtml(label)}</div>
            <span class="settings-chip">${arrayValue.length} Items</span>
          </div>
          <div class="row-subtitle mono">${escapeHtml(formatSettingPath(path))}</div>
        </div>
        <div class="settings-meta-row">
          <button type="button" data-action="settings-add-array-item" data-setting-path="${encodedPath}">Add Item</button>
          ${
            allowRemove
              ? `<button type="button" class="ghost settings-field-remove" data-action="settings-remove-field" data-setting-path="${encodedPath}">Remove List</button>`
              : ""
          }
        </div>
      </div>
      ${
        arrayValue.length
          ? `
            <div class="settings-group-body">
              ${arrayValue.map((item, index) => renderJsonNode(item, [...path, index])).join("")}
            </div>
          `
          : `<div class="settings-empty-note">This list is empty. Add the first item when you’re ready.</div>`
      }
    </div>
  `;
}

function renderRootAddSettingCard() {
  return `
    <div class="settings-add-card">
      <div class="row-title">Add a Top-Level Setting</div>
      <div class="row-subtitle">Create a new setting without touching raw JSON. Use Advanced JSON for custom nested structures.</div>
      <div class="settings-add-grid">
        <input id="settings-new-key" type="text" placeholder="Setting name" />
        <select id="settings-new-type">
          <option value="string">Text</option>
          <option value="number">Number</option>
          <option value="boolean">Toggle</option>
          <option value="object">Group</option>
          <option value="array">List</option>
        </select>
        <input id="settings-new-value" type="text" placeholder="Optional starting value" />
        <button type="button" class="primary" data-action="settings-add-root-field">Add Setting</button>
      </div>
    </div>
  `;
}

function renderSettingsActionButtons(selectedFile, options: JsonRenderOptions = {}) {
  const { includeJsonToggle = false, forceRawEditor = false } = options;
  const showJsonToggle = includeJsonToggle && !forceRawEditor;

  return `
    <div class="detail-actions settings-detail-actions">
      ${
        showJsonToggle
          ? `<button type="button" data-action="settings-toggle-raw-json">${ui.settingsShowRawJson ? "Back to Form" : "Advanced JSON"}</button>`
          : ""
      }
      <button type="button" data-action="settings-reload-file">Reload</button>
      <button type="button" class="primary" data-action="settings-save-file">${selectedFile.exists ? "Save" : "Create"}</button>
      <button type="button" data-action="settings-reveal-file">Reveal</button>
    </div>
  `;
}

function renderSettingsStat(label, value) {
  return `
    <div class="settings-stat">
      <div class="settings-stat-label">${escapeHtml(label)}</div>
      <div class="settings-stat-value">${escapeHtml(value)}</div>
    </div>
  `;
}

function renderSettingsSaveMessage() {
  return ui.settingsSaveMessage
    ? `<div class="settings-save-message">${escapeHtml(ui.settingsSaveMessage)}</div>`
    : "";
}

function renderSettingsFileRow(file) {
  return `
    <button
      type="button"
      class="switcher-row ${ui.settingsSelectedFilePath === file.path ? "active" : ""}"
      data-action="settings-select-file"
      data-file-path="${file.path}">
      <div class="settings-file-row-top">
        <div class="row-title">${escapeHtml(friendlySettingsFileTitle(file))}</div>
        <span class="settings-chip">${isJsonSettingsFile(file) ? "JSON" : "MD"}</span>
      </div>
      <div class="row-subtitle">${escapeHtml(friendlySettingsFileListSubtitle(file))}</div>
      <div class="row-meta">${file.exists ? "Ready to edit" : "Create on save"}</div>
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
    case "collapse-sidebar-project":
      collapseSidebarProjectDrawer(target.dataset.repoId);
      break;
    case "open-launcher":
      openLauncher(target.dataset.repoId || currentRepoId());
      break;
    case "open-settings":
      await openSettings(target.dataset.settingsTab || "general");
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
      await selectSession(target.dataset.sessionId, "terminal");
      break;
    case "switch-repo":
      quickSwitcherDialog.close();
      await selectRepo(target.dataset.repoId, "main");
      break;
    case "settings-tab":
      ui.settingsTab = target.dataset.tab;
      await renderSettingsDialog();
      break;
    case "settings-select-file":
      await loadSelectedSettingsFile(target.dataset.filePath);
      await renderSettingsDialog();
      break;
    case "settings-save-file":
      await saveCurrentSettingsFile();
      break;
    case "settings-reload-file":
      if (ui.settingsSelectedFilePath) {
        await loadSelectedSettingsFile(ui.settingsSelectedFilePath);
        await renderSettingsDialog();
      }
      break;
    case "settings-toggle-raw-json":
      if (ui.settingsShowRawJson) {
        syncSettingsJsonDraftFromText();
        if (ui.settingsJsonError) {
          ui.settingsSaveMessage = `Fix the JSON parse error before returning to the form: ${ui.settingsJsonError}`;
        } else {
          ui.settingsShowRawJson = false;
          ui.settingsSaveMessage = "";
        }
      } else {
        ui.settingsShowRawJson = true;
        ui.settingsSaveMessage = "";
      }
      await renderSettingsDialog();
      break;
    case "settings-remove-field":
      removeJsonSettingAtPath(decodeSettingPath(target.dataset.settingPath));
      await renderSettingsDialog();
      break;
    case "settings-add-array-item":
      addJsonArrayItem(decodeSettingPath(target.dataset.settingPath));
      await renderSettingsDialog();
      break;
    case "settings-convert-field":
      updateJsonSettingValue(
        decodeSettingPath(target.dataset.settingPath),
        defaultValueForSettingKind(target.dataset.settingValueKind)
      );
      await renderSettingsDialog();
      break;
    case "settings-add-root-field":
      addRootJsonSetting();
      await renderSettingsDialog();
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
        await selectSession(nextSessionId, "terminal");
      }
      break;
    }
    default:
      break;
  }
}

function handlePointerDown(event) {
  if (isAnyDialogOpen()) {
    return;
  }

  const target = event.target as HTMLElement | null;
  if (!target) {
    return;
  }

  if (isTerminalTarget(target)) {
    setFocusSection("terminal");
    return;
  }

  if (isSidebarDrawerTarget(target)) {
    setFocusSection("sidebar-drawer");
    return;
  }

  if (sidebarElement.contains(target)) {
    setFocusSection("sidebar");
    return;
  }

  if (detailElement.contains(target)) {
    setFocusSection("main");
  }
}

function handleKeyDown(event) {
  if (isAnyDialogOpen()) {
    return;
  }

  if (isSectionNavigationKey(event)) {
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const nextSection = adjacentSection(direction);
    if (!nextSection) {
      return;
    }

    event.preventDefault();
    setFocusSection(nextSection);
    return;
  }

  if (isEditableTarget(event.target as HTMLElement | null)) {
    return;
  }

  if (ui.focusSection === "sidebar" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      navigateSidebarProjects(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (event.key === "Enter") {
      const repoId = currentRepoId();
      if (repoId) {
        event.preventDefault();
        toggleSidebarProjectDrawer(repoId);
      }
    }
  }

  if (ui.focusSection === "sidebar-drawer" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      navigateSidebarDrawerSessions(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
  }
}

async function handleInput(event) {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  if (!target) {
    return;
  }

  if (target.dataset.settingEditor) {
    handleSettingsFieldInput(target);
    return;
  }

  switch (target.id) {
    case "launcher-query":
      ui.launcherQuery = target.value;
      renderLauncherDialog();
      break;
    case "quick-switcher-query":
      ui.quickSwitcherQuery = target.value;
      renderQuickSwitcherDialog();
      break;
    case "command-palette-query":
      ui.commandPaletteQuery = target.value;
      renderCommandPaletteDialog();
      break;
    case "settings-text-editor":
      ui.settingsEditorText = target.value;
      ui.settingsSaveMessage = "";
      break;
    default:
      break;
  }
}

async function handleChange(event) {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  if (!target) {
    return;
  }

  if (target.dataset.settingEditor) {
    handleSettingsFieldChange(target);
    return;
  }

  switch (target.id) {
    case "launcher-launches-claude":
      ui.launcherLaunchesClaudeOnStart = (target as HTMLInputElement).checked;
      break;
    case "pref-notifications-enabled":
      await api.updatePreferences({ notificationsEnabled: (target as HTMLInputElement).checked });
      break;
    case "pref-claude-command":
      await api.updatePreferences({ claudeExecutablePath: target.value });
      break;
    case "pref-shell-executable":
      await api.updatePreferences({ shellExecutablePath: target.value });
      break;
    case "pref-native-notifications":
      await api.updatePreferences({ showNativeNotifications: (target as HTMLInputElement).checked });
      break;
    case "pref-in-app-badges":
      await api.updatePreferences({ showInAppBadges: (target as HTMLInputElement).checked });
      break;
    default:
      break;
  }
}

async function selectInbox(nextFocusSection: SectionId | null = null) {
  if (nextFocusSection) {
    ui.focusSection = nextFocusSection;
  }
  ui.selection = { type: "inbox", id: null };
  ui.sidebarExpandedRepoId = null;
  normalizeFocusSection();
  await api.setFocusedSession(null);
  renderSidebar();
  renderDetail();
}

async function selectRepo(
  repoId,
  nextFocusSection: SectionId | null = null
) {
  if (nextFocusSection) {
    ui.focusSection = nextFocusSection;
  }
  ui.selection = { type: "repo", id: repoId };
  if (ui.sidebarExpandedRepoId) {
    ui.sidebarExpandedRepoId = repoId;
  }
  normalizeFocusSection();
  await api.setFocusedSession(null);
  renderSidebar();
  renderDetail();
}

async function selectSession(
  sessionId,
  nextFocusSection: SectionId | null = null
) {
  if (nextFocusSection) {
    ui.focusSection = nextFocusSection;
  }
  ui.selection = { type: "session", id: sessionId };
  if (ui.sidebarExpandedRepoId) {
    ui.sidebarExpandedRepoId = sessionById(sessionId)?.repoID || ui.sidebarExpandedRepoId;
  }
  normalizeFocusSection();
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
    await selectSession(sessionId, "terminal");
  }
}

async function openSettings(initialTab = "general") {
  ui.settingsTab = initialTab;
  ui.settingsContext = null;
  ui.settingsSelectedFilePath = null;
  ui.settingsEditorText = "";
  ui.settingsSaveMessage = "";
  ui.settingsJsonDraft = null;
  ui.settingsJsonError = "";
  ui.settingsShowRawJson = false;
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

  if (isJsonSettingsFilePath(ui.settingsSelectedFilePath)) {
    syncSettingsJsonDraftFromText();
    if (ui.settingsJsonError) {
      ui.settingsSaveMessage = `Fix the JSON parse error before saving: ${ui.settingsJsonError}`;
      await renderSettingsDialog();
      return;
    }
    ui.settingsEditorText = formatJsonValue(currentJsonSettingsValue());
  }

  await api.saveSettingsFile(ui.settingsSelectedFilePath, ui.settingsEditorText);
  ui.settingsContext = await api.getClaudeSettingsContext(currentRepoId());
  ui.settingsSaveMessage =
    `Saved ${friendlySettingsFileTitle(allSettingsFiles().find((file) => file.path === ui.settingsSelectedFilePath) || {
      path: ui.settingsSelectedFilePath,
      title: pathLabel(ui.settingsSelectedFilePath),
      scope: "global"
    })}`;
  await renderSettingsDialog();
}

function allSettingsFiles() {
  if (!ui.settingsContext) {
    return [];
  }

  return [
    ...sortSettingsFiles(ui.settingsContext.globalFiles),
    ...sortSettingsFiles(ui.settingsContext.projectFiles)
  ];
}

async function loadSelectedSettingsFile(filePath) {
  ui.settingsSelectedFilePath = filePath;
  ui.settingsEditorText = await api.loadSettingsFile(filePath);
  ui.settingsSaveMessage = "";
  ui.settingsShowRawJson = false;
  syncSettingsJsonDraftFromText();
}

function handleSettingsFieldInput(target) {
  const path = decodeSettingPath(target.dataset.settingPath);

  switch (target.dataset.settingEditor) {
    case "string":
      updateJsonSettingValue(path, target.value);
      break;
    case "raw-json":
      ui.settingsEditorText = target.value;
      syncSettingsJsonDraftFromText();
      break;
    default:
      break;
  }
}

function handleSettingsFieldChange(target) {
  const path = decodeSettingPath(target.dataset.settingPath);

  switch (target.dataset.settingEditor) {
    case "boolean":
      updateJsonSettingValue(path, target.checked);
      break;
    case "number": {
      const parsedValue = Number(target.value);
      updateJsonSettingValue(path, Number.isFinite(parsedValue) ? parsedValue : 0);
      if (!Number.isFinite(parsedValue)) {
        target.value = "0";
      }
      break;
    }
    case "string":
      updateJsonSettingValue(path, target.value);
      break;
    default:
      break;
  }
}

function syncSettingsJsonDraftFromText() {
  if (!isJsonSettingsFilePath(ui.settingsSelectedFilePath)) {
    ui.settingsJsonDraft = null;
    ui.settingsJsonError = "";
    return;
  }

  const rawContents = (ui.settingsEditorText || "").trim();
  if (!rawContents) {
    ui.settingsJsonDraft = {};
    ui.settingsJsonError = "";
    return;
  }

  try {
    ui.settingsJsonDraft = JSON.parse(ui.settingsEditorText);
    ui.settingsJsonError = "";
  } catch (error) {
    ui.settingsJsonDraft = null;
    ui.settingsJsonError = error.message;
  }
}

function currentJsonSettingsValue() {
  return ui.settingsJsonDraft ?? {};
}

function updateJsonSettingValue(path, value) {
  const nextRoot = cloneJsonValue(currentJsonSettingsValue());
  const updatedValue = setJsonValueAtPath(nextRoot, path, value);
  ui.settingsJsonDraft = updatedValue;
  ui.settingsJsonError = "";
  ui.settingsEditorText = formatJsonValue(updatedValue);
  ui.settingsSaveMessage = "";
}

function removeJsonSettingAtPath(path) {
  const nextRoot = cloneJsonValue(currentJsonSettingsValue());
  deleteJsonValueAtPath(nextRoot, path);
  ui.settingsJsonDraft = nextRoot;
  ui.settingsJsonError = "";
  ui.settingsEditorText = formatJsonValue(nextRoot);
  ui.settingsSaveMessage = "";
}

function addJsonArrayItem(path) {
  const nextRoot = cloneJsonValue(currentJsonSettingsValue());
  const arrayValue = getJsonValueAtPath(nextRoot, path);
  if (!Array.isArray(arrayValue)) {
    return;
  }

  arrayValue.push(defaultArrayItemValue(arrayValue));
  ui.settingsJsonDraft = nextRoot;
  ui.settingsJsonError = "";
  ui.settingsEditorText = formatJsonValue(nextRoot);
  ui.settingsSaveMessage = "";
}

function addRootJsonSetting() {
  const rootValue = currentJsonSettingsValue();
  if (!isJsonObject(rootValue)) {
    ui.settingsSaveMessage = "Use Advanced JSON to change the root structure before adding top-level settings.";
    return;
  }

  const keyInput = settingsDialog.querySelector("#settings-new-key") as HTMLInputElement | null;
  const typeInput = settingsDialog.querySelector("#settings-new-type") as HTMLSelectElement | null;
  const valueInput = settingsDialog.querySelector("#settings-new-value") as HTMLInputElement | null;
  const nextKey = keyInput?.value.trim();

  if (!nextKey) {
    ui.settingsSaveMessage = "Enter a setting name first.";
    return;
  }

  if (Object.prototype.hasOwnProperty.call(rootValue, nextKey)) {
    ui.settingsSaveMessage = `${nextKey} already exists in this file.`;
    return;
  }

  const nextRoot = cloneJsonValue(rootValue);
  nextRoot[nextKey] = buildNewSettingValue(typeInput?.value || "string", valueInput?.value || "");
  ui.settingsJsonDraft = nextRoot;
  ui.settingsJsonError = "";
  ui.settingsEditorText = formatJsonValue(nextRoot);
  ui.settingsSaveMessage = "";
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function setJsonValueAtPath(rootValue, path, nextValue) {
  if (!path.length) {
    return nextValue;
  }

  const parentValue = getJsonValueAtPath(rootValue, path.slice(0, -1));
  parentValue[path[path.length - 1]] = nextValue;
  return rootValue;
}

function getJsonValueAtPath(rootValue, path) {
  return path.reduce((currentValue, segment) => currentValue[segment], rootValue);
}

function deleteJsonValueAtPath(rootValue, path) {
  if (!path.length) {
    return rootValue;
  }

  const parentValue = getJsonValueAtPath(rootValue, path.slice(0, -1));
  const lastSegment = path[path.length - 1];

  if (Array.isArray(parentValue)) {
    parentValue.splice(lastSegment, 1);
  } else {
    delete parentValue[lastSegment];
  }

  return rootValue;
}

function buildNewSettingValue(kind, initialValue) {
  switch (kind) {
    case "number": {
      const parsedValue = Number(initialValue);
      return Number.isFinite(parsedValue) ? parsedValue : 0;
    }
    case "boolean":
      return initialValue.trim().toLowerCase() === "true";
    case "object":
      return {};
    case "array":
      return initialValue ? [initialValue] : [];
    default:
      return initialValue;
  }
}

function defaultArrayItemValue(arrayValue) {
  if (!arrayValue.length) {
    return "";
  }

  return defaultValueFromJsonValue(arrayValue[0]);
}

function defaultValueFromJsonValue(value) {
  if (Array.isArray(value)) {
    return [];
  }

  if (isJsonObject(value)) {
    return {};
  }

  return defaultValueForSettingKind(jsonValueTypeLabel(value).toLowerCase());
}

function defaultValueForSettingKind(kind) {
  switch (kind) {
    case "number":
      return 0;
    case "boolean":
    case "toggle":
      return false;
    case "object":
    case "group":
      return {};
    case "array":
    case "list":
      return [];
    case "null":
      return null;
    default:
      return "";
  }
}

function countTopLevelJsonEntries(value) {
  if (Array.isArray(value)) {
    return value.length;
  }

  if (isJsonObject(value)) {
    return Object.keys(value).length;
  }

  return value === null || value === undefined ? 0 : 1;
}

function countLeafJsonEntries(value) {
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + countLeafJsonEntries(item), 0);
  }

  if (isJsonObject(value)) {
    return Object.values(value).reduce((count, item) => count + countLeafJsonEntries(item), 0);
  }

  return value === undefined ? 0 : 1;
}

function describeJsonValueType(value) {
  return jsonValueTypeLabel(value).toLowerCase();
}

function jsonValueTypeLabel(value) {
  if (Array.isArray(value)) {
    return "Array";
  }

  if (value === null) {
    return "Null";
  }

  if (isJsonObject(value)) {
    return "Object";
  }

  switch (typeof value) {
    case "boolean":
      return "Boolean";
    case "number":
      return "Number";
    case "string":
      return "String";
    default:
      return "Value";
  }
}

function isJsonObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isJsonSettingsFile(file) {
  return isJsonSettingsFilePath(file?.path || "");
}

function isJsonSettingsFilePath(filePath) {
  return filePath.endsWith(".json");
}

function sortSettingsFiles(files) {
  return [...files].sort((left, right) => {
    const orderDelta = settingsFileOrder(left) - settingsFileOrder(right);
    if (orderDelta !== 0) {
      return orderDelta;
    }

    return left.path.localeCompare(right.path);
  });
}

function settingsFileOrder(file) {
  const name = pathLabel(file.path);
  switch (name) {
    case "settings.json":
      return 0;
    case "settings.local.json":
      return 1;
    case "CLAUDE.md":
      return 2;
    default:
      return 3;
  }
}

function friendlySettingsFileTitle(file) {
  const name = pathLabel(file.path);
  if (name === "CLAUDE.md") {
    return file.scope === "global" ? "Global Instructions" : "Project Instructions";
  }
  if (name === "settings.json") {
    return file.scope === "global" ? "Global Settings" : "Project Settings";
  }
  if (name === "settings.local.json") {
    return file.scope === "global" ? "Global Local Overrides" : "Project Local Overrides";
  }
  return file.title;
}

function friendlySettingsFileListSubtitle(file) {
  const name = pathLabel(file.path);
  if (name === "CLAUDE.md") {
    return file.scope === "global"
      ? "Shared Markdown instructions for every session"
      : "Repo-specific Markdown instructions";
  }
  if (name === "settings.json") {
    return file.scope === "global"
      ? "Shared Claude defaults in JSON"
      : "Repo-level JSON overrides";
  }
  if (name === "settings.local.json") {
    return file.scope === "global"
      ? "Machine-specific JSON overrides"
      : "Repo-local JSON overrides";
  }
  return file.title;
}

function friendlySettingsFileSummary(file) {
  const name = pathLabel(file.path);
  if (name === "CLAUDE.md") {
    return file.scope === "global"
      ? "Keep broad Claude guidance here. This file stays as Markdown and applies across your workspaces."
      : "Keep repo-specific Claude guidance here. This file stays as Markdown and travels with the project.";
  }
  if (name === "settings.json") {
    return file.scope === "global"
      ? "Edit shared Claude defaults in a form instead of reading raw JSON. Saving writes back to the underlying file."
      : "Edit repo-level Claude overrides in a form. These settings can replace your global defaults for this project.";
  }
  if (name === "settings.local.json") {
    return file.scope === "global"
      ? "Use local overrides for machine-specific Claude behavior that should sit on top of your shared defaults."
      : "Use repo-local overrides for settings that should win inside this project without changing broader defaults.";
  }
  return file.title;
}

function settingsScopeLabel(file) {
  return file.scope === "global" ? "Global Claude Defaults" : "Project Claude Override";
}

function friendlySourceLabel(sourceLabel) {
  const file = allSettingsFiles().find((candidate) => candidate.title === sourceLabel);
  return file ? friendlySettingsFileTitle(file) : sourceLabel;
}

function labelForResolvedKeyPath(keyPath) {
  if (!keyPath || keyPath === "$") {
    return "Root Value";
  }

  const segments = keyPath.split(".");
  return humanizeSettingSegment(segments[segments.length - 1]);
}

function labelForSettingPath(path) {
  if (!path.length) {
    return "Root Value";
  }

  const lastSegment = path[path.length - 1];
  if (typeof lastSegment === "number") {
    return `Item ${lastSegment + 1}`;
  }

  return humanizeSettingSegment(lastSegment);
}

function humanizeSettingSegment(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatSettingPath(path) {
  if (!path.length) {
    return "$";
  }

  return path.reduce((result, segment) => {
    if (typeof segment === "number") {
      return `${result}[${segment}]`;
    }

    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)
      ? `${result}.${segment}`
      : `${result}[${JSON.stringify(segment)}]`;
  }, "$");
}

function encodeSettingPath(path) {
  return encodeURIComponent(JSON.stringify(path));
}

function decodeSettingPath(serializedPath) {
  return JSON.parse(decodeURIComponent(serializedPath || "%5B%5D"));
}

function formatJsonValue(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
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

function expandedSidebarRepo() {
  return ui.sidebarExpandedRepoId ? repoById(ui.sidebarExpandedRepoId) : null;
}

function normalizeFocusSection() {
  const sections = availableSections();
  if (!sections.includes(ui.focusSection)) {
    if (ui.focusSection === "sidebar-drawer" && sections.includes("sidebar")) {
      ui.focusSection = "sidebar";
      return;
    }

    ui.focusSection = sections.includes("main") ? "main" : sections[0];
  }
}

function availableSections() {
  const sections: SectionId[] = ["sidebar"];

  if (expandedSidebarRepo()) {
    sections.push("sidebar-drawer");
  }

  sections.push("main");

  if (ui.selection.type === "session") {
    sections.push("terminal");
  }

  return sections;
}

function setFocusSection(section: SectionId) {
  ui.focusSection = section;
  normalizeFocusSection();
  syncSectionFocusUi();
}

function adjacentSection(direction: number) {
  const sections = availableSections();
  const currentIndex = sections.indexOf(ui.focusSection);
  const nextIndex = currentIndex + direction;
  return sections[nextIndex] || null;
}

function syncSectionFocusUi() {
  normalizeFocusSection();

  const expanded = !!expandedSidebarRepo();
  appShellElement.classList.toggle("sidebar-expanded", expanded);
  sidebarElement.classList.toggle("sidebar-expanded", expanded);

  sidebarElement.classList.toggle("section-focused", ui.focusSection === "sidebar");
  const sidebarDrawer = sidebarElement.querySelector(".sidebar-project-drawer") as HTMLElement | null;
  if (sidebarDrawer) {
    sidebarDrawer.classList.toggle("section-focused", ui.focusSection === "sidebar-drawer");
  }
  detailElement.classList.toggle(
    "section-focused",
    ui.focusSection === "main" && ui.selection.type !== "session"
  );

  const sessionMainRegion = document.getElementById("session-main-region");
  if (sessionMainRegion) {
    sessionMainRegion.classList.toggle("section-focused", ui.focusSection === "main");
  }

  const terminalWrap = detailElement.querySelector(".terminal-wrap") as HTMLElement | null;
  if (terminalWrap) {
    terminalWrap.classList.toggle("section-focused", ui.focusSection === "terminal");
  }

  if (isAnyDialogOpen()) {
    return;
  }

  focusCurrentSectionElement();
}

function focusCurrentSectionElement() {
  switch (ui.focusSection) {
    case "sidebar":
      sidebarElement.focus({ preventScroll: true });
      scrollSidebarSelectionIntoView();
      break;
    case "sidebar-drawer": {
      const sidebarDrawer = sidebarElement.querySelector(".sidebar-project-drawer") as HTMLElement | null;
      sidebarDrawer?.focus({ preventScroll: true });
      scrollSidebarDrawerSelectionIntoView();
      break;
    }
    case "terminal":
      if (ui.terminal) {
        ui.terminal.focus();
        break;
      }

      (detailElement.querySelector(".terminal-wrap") as HTMLElement | null)?.focus({
        preventScroll: true
      });
      break;
    case "main":
    default: {
      const sessionMainRegion = document.getElementById("session-main-region") as HTMLElement | null;
      (sessionMainRegion || detailElement).focus({ preventScroll: true });
      break;
    }
  }
}

function sortedRepos() {
  return [...state.repos].sort(compareRepos);
}

function compareRepos(left, right) {
  const nameDelta = left.name.localeCompare(right.name);
  if (nameDelta !== 0) {
    return nameDelta;
  }

  return left.path.localeCompare(right.path);
}

function navigateSidebarProjects(direction: number) {
  const repos = sortedRepos();
  if (!repos.length) {
    return;
  }

  const currentRepoIndex = repos.findIndex((repo) => repo.id === currentRepoId());
  if (currentRepoIndex < 0) {
    const fallbackIndex = direction > 0 ? 0 : repos.length - 1;
    void selectRepo(repos[fallbackIndex].id, "sidebar");
    return;
  }

  const nextIndex = currentRepoIndex + direction;
  if (nextIndex < 0 || nextIndex >= repos.length) {
    return;
  }

  void selectRepo(repos[nextIndex].id, "sidebar");
}

function navigateSidebarDrawerSessions(direction: number) {
  const repo = expandedSidebarRepo();
  if (!repo) {
    return;
  }

  const sessions = sessionsForRepo(repo.id);
  if (!sessions.length) {
    return;
  }

  const currentSessionIndex = sessions.findIndex((session) => session.id === ui.selection.id);
  if (ui.selection.type !== "session" || currentSessionIndex < 0) {
    const fallbackIndex = direction > 0 ? 0 : sessions.length - 1;
    void selectSession(sessions[fallbackIndex].id, "sidebar-drawer");
    return;
  }

  const nextIndex = currentSessionIndex + direction;
  if (nextIndex < 0 || nextIndex >= sessions.length) {
    return;
  }

  void selectSession(sessions[nextIndex].id, "sidebar-drawer");
}

function toggleSidebarProjectDrawer(repoId) {
  if (!repoId) {
    return;
  }

  ui.sidebarExpandedRepoId = ui.sidebarExpandedRepoId === repoId ? null : repoId;
  renderSidebar();
}

function collapseSidebarProjectDrawer(repoId = null) {
  if (!ui.sidebarExpandedRepoId) {
    return;
  }

  if (repoId && ui.sidebarExpandedRepoId !== repoId) {
    return;
  }

  ui.sidebarExpandedRepoId = null;
  renderSidebar();
}

function scrollSidebarSelectionIntoView() {
  const activeRepoId = currentRepoId();
  const target =
    (activeRepoId
      ? sidebarElement.querySelector(`[data-repo-id="${CSS.escape(activeRepoId)}"]`)
      : sidebarElement.querySelector('[data-action="select-inbox"]')) as HTMLElement | null;

  target?.scrollIntoView({ block: "nearest" });
}

function scrollSidebarDrawerSelectionIntoView() {
  if (ui.selection.type !== "session") {
    return;
  }

  const target = sidebarElement.querySelector(
    `[data-session-id="${CSS.escape(ui.selection.id)}"]`
  ) as HTMLElement | null;

  target?.scrollIntoView({ block: "nearest" });
}

function sessionsForRepo(repoId) {
  return [...state.sessions]
    .filter((session) => session.repoID === repoId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
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

function renderProjectAvatar(repo) {
  return buildIdenticonSvg(repo.path || repo.name || repo.id);
}

function renderUtilityIcon(kind) {
  switch (kind) {
    case "workspace":
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7.5h16v10H4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
          <path d="M7 5h4l1.3 1.5H20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
    case "folder":
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7.5h16v10H4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
          <path d="M12 10v5M9.5 12.5h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        </svg>
      `;
    case "settings":
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.7"/>
          <path d="M12 4.5v2M12 17.5v2M4.5 12h2M17.5 12h2M6.7 6.7l1.4 1.4M15.9 15.9l1.4 1.4M17.3 6.7l-1.4 1.4M8.1 15.9l-1.4 1.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        </svg>
      `;
    case "inbox":
    default:
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 7h14l1 10H4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
          <path d="M8.5 12.5h2l1.2 2h2.6l1.2-2h2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
  }
}

function buildIdenticonSvg(seed) {
  const hash = hashSeed(seed);
  const background = `hsl(${hash % 360} 52% 18%)`;
  const foreground = `hsl(${(hash >> 9) % 360} 72% 62%)`;
  const accent = `hsl(${(hash >> 18) % 360} 78% 74%)`;
  const cells: string[] = [];
  const bitSource = hash ^ 0x9e3779b9;
  const cellSize = 12;
  const offset = 2;

  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const bitIndex = row * 3 + column;
      const filled = ((bitSource >> bitIndex) & 1) === 1;
      if (!filled) {
        continue;
      }

      const mirroredColumn = 4 - column;
      cells.push(renderIdenticonCell(column, row, cellSize, offset, foreground, accent));
      if (mirroredColumn !== column) {
        cells.push(renderIdenticonCell(mirroredColumn, row, cellSize, offset, foreground, accent));
      }
    }
  }

  return `
    <svg viewBox="0 0 64 64" role="img" aria-hidden="true">
      <rect x="2" y="2" width="60" height="60" rx="18" fill="${background}"/>
      <rect x="8" y="8" width="48" height="48" rx="14" fill="rgba(255,255,255,0.04)"/>
      ${cells.join("")}
    </svg>
  `;
}

function renderIdenticonCell(column, row, cellSize, offset, foreground, accent) {
  const x = offset + column * cellSize;
  const y = offset + row * cellSize;

  return `
    <rect x="${x + 8}" y="${y + 8}" width="${cellSize - 2}" height="${cellSize - 2}" rx="4" fill="${foreground}"/>
    <circle cx="${x + 14}" cy="${y + 14}" r="2.2" fill="${accent}" opacity="0.85"/>
  `;
}

function hashSeed(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function isAnyDialogOpen() {
  return (
    launcherDialog.open ||
    settingsDialog.open ||
    quickSwitcherDialog.open ||
    commandPaletteDialog.open
  );
}

function isEditableTarget(target: HTMLElement | null) {
  if (!target) {
    return false;
  }

  const editableElement = target.closest(
    'input, textarea, select, [contenteditable="true"], [contenteditable=""], .xterm-helper-textarea'
  );

  return !!editableElement;
}

function isTerminalTarget(target: HTMLElement) {
  return !!target.closest("#terminal-shell");
}

function isSidebarDrawerTarget(target: HTMLElement) {
  return !!target.closest(".sidebar-project-drawer");
}

function isSectionNavigationKey(event: KeyboardEvent) {
  const hasModifier = event.metaKey || event.ctrlKey;
  return hasModifier && !event.altKey && event.key !== "ArrowUp" && event.key !== "ArrowDown"
    ? event.key === "ArrowLeft" || event.key === "ArrowRight"
    : false;
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
