const api = window.claudeWorkspace;
const SECTION_ORDER = ["sidebar", "sidebar-drawer", "main", "terminal"] as const;
type SectionId = (typeof SECTION_ORDER)[number];
const MAX_VISIBLE_SESSION_PANES = 4;

type WorkspaceSplitAxis = "row" | "column";
type WorkspaceDropZone = "center" | "left" | "right" | "top" | "bottom";

type WorkspaceLeafNode = {
  type: "leaf";
  sessionId: string;
};

type WorkspaceSplitNode = {
  type: "split";
  axis: WorkspaceSplitAxis;
  children: WorkspaceLayoutNode[];
};

type WorkspaceLayoutNode = WorkspaceLeafNode | WorkspaceSplitNode;

type TerminalMount = {
  terminal: any;
  fitAddon: any;
  resizeObserver: ResizeObserver;
};

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
  sidebarNavItem: "inbox" as string,
  mainListSessionId: null as string | null,
  terminalMounts: new Map<string, TerminalMount>(),
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
  settingsShowRawJson: false,
  portStatusData: null,
  portStatusLoading: false,
  portStatusShowAll: false,
  portStatusPollTimer: null as number | null,
  workspaceStructureSignature: "",
  draggingSessionId: null as string | null,
  draggingSessionSource: null as string | null,
  dragTargetSessionId: null as string | null,
  dragTargetZone: null as WorkspaceDropZone | null
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
document.addEventListener("contextmenu", handleContextMenu, true);
document.addEventListener("keydown", handleKeyDown, true);
document.addEventListener("dragstart", handleDragStart, true);
document.addEventListener("dragend", handleDragEnd, true);
document.addEventListener("dragover", handleDragOver, true);
document.addEventListener("drop", handleDrop, true);

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

  if (ui.selection.type === "session" && isSessionVisible(payload.sessionId)) {
    updateSessionWorkspaceToolbar();
    updateSessionPane(session);
    writeSessionTerminalOutput(payload.sessionId, payload.data);
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

  if (ui.selection.type === "session" && isSessionVisible(session.id)) {
    updateSessionWorkspaceToolbar();
    updateSessionPane(session);
    syncSessionTerminalLiveState(session);
  } else if (ui.selection.type !== "session") {
    renderDetail();
  }
});

api.onCommand(async ({ command, sessionId }) => {
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
    case "select-session":
      if (sessionId) {
        await selectSession(sessionId, "terminal");
      }
      break;
    default:
      break;
  }
});

initialize().catch((error) => {
  detailElement.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
});

function handleColorSchemeChange() {
  syncColorSchemeClass();

  for (const mount of ui.terminalMounts.values()) {
    mount.terminal.options.theme = buildTerminalTheme();
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
  syncStoredSessionWorkspaceLayout();
  if (ui.sidebarExpandedRepoId && !repoById(ui.sidebarExpandedRepoId)) {
    ui.sidebarExpandedRepoId = null;
  }
  if (ui.mainListSessionId && !sessionById(ui.mainListSessionId)) {
    ui.mainListSessionId = null;
  }
  syncSidebarNavSelection();
  syncMainListSelection();
}

function ensureValidSelection() {
  if (ui.selection.type === "session" && sessionById(ui.selection.id)) {
    syncStoredSessionWorkspaceLayout(ui.selection.id);
  }

  if (ui.selection.type === "session" && !sessionById(ui.selection.id)) {
    const visibleSessionIds = workspaceVisibleSessionIds();
    ui.selection = visibleSessionIds.length
      ? { type: "session", id: visibleSessionIds[0] }
      : { type: "inbox", id: null };
  }

  if (ui.selection.type === "repo" && !repoById(ui.selection.id)) {
    ui.selection = { type: "inbox", id: null };
  }

  syncSidebarNavSelection();
  syncMainListSelection();
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
          <button class="sidebar-rail-button sidebar-utility-button ${sidebarNavMatches(sidebarActionNavId("open-workspace")) ? "keyboard-active" : ""}" data-action="open-workspace" data-tooltip="Add Workspace" title="Add Workspace" aria-label="Add Workspace">
            ${renderUtilityIcon("workspace")}
          </button>
          <button class="sidebar-rail-button sidebar-utility-button ${sidebarNavMatches(sidebarActionNavId("create-project")) ? "keyboard-active" : ""}" data-action="create-project" data-tooltip="New Folder" title="New Folder" aria-label="New Folder">
            ${renderUtilityIcon("folder")}
          </button>
          <button class="sidebar-rail-button sidebar-utility-button ${selectionMatches("status") ? "active" : ""} ${sidebarNavMatches(sidebarActionNavId("open-status")) ? "keyboard-active" : ""}" data-action="open-status" data-tooltip="Dev Ports" title="Dev Ports" aria-label="Dev Ports">
            ${renderUtilityIcon("status")}
          </button>
          <button class="sidebar-rail-button sidebar-utility-button ${sidebarNavMatches(sidebarActionNavId("open-settings")) ? "keyboard-active" : ""}" data-action="open-settings" data-tooltip="Settings" title="Settings" aria-label="Settings">
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
    <button class="sidebar-rail-button sidebar-home-button ${selectionMatches("inbox") ? "active" : ""} ${sidebarNavMatches("inbox") ? "keyboard-active" : ""}" data-action="select-inbox" data-tooltip="Inbox" title="Inbox" aria-label="Inbox">
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
    <button class="sidebar-rail-button sidebar-project-button ${active ? "active" : ""} ${expanded ? "expanded" : ""} ${sidebarNavMatches(repo.id) ? "keyboard-active" : ""}" data-action="select-repo" data-repo-id="${repo.id}" data-tooltip="${escapeAttribute(repo.name)}" title="${escapeAttribute(repo.name)}" aria-label="${escapeAttribute(repo.name)}">
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
    <section class="sidebar-project-drawer" tabindex="-1" data-repo-id="${repo.id}">
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
    <button class="session-row ${selectionMatches("session", session.id) ? "active" : ""}" data-action="select-session" data-session-id="${session.id}" ${renderSessionDragAttributes(session.id, "list")}>
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
  syncPortStatusPolling();

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

  if (ui.selection.type === "status") {
    destroyTerminal();
    renderPortStatusDetail();
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

function renderPortStatusDetail() {
  const portStatus = ui.portStatusData;
  const activePorts = portStatus?.activePorts || [];
  const groups = portStatus?.groups || [];
  const trackedPortCount = portStatus?.trackedPortCount || 0;
  const activeCount = portStatus?.activeCount || 0;
  const canRenderTrackedTable = !!portStatus?.available && !!portStatus?.ports?.length;

  detailElement.innerHTML = `
    <section class="detail-panel">
      <div class="detail-hero">
        <div>
          <div class="eyebrow">Status</div>
          <h1 class="detail-title">Dev Ports</h1>
          <div class="muted">Watch common local dev ports without leaving the app.</div>
        </div>
        <div class="detail-actions">
          <button data-action="toggle-port-status-table">${ui.portStatusShowAll ? "Hide Quiet Ports" : "Show All Tracked Ports"}</button>
          <button class="primary" data-action="refresh-port-status">${ui.portStatusLoading ? "Refreshing..." : "Refresh"}</button>
        </div>
      </div>
      ${
        portStatus?.error
          ? `<div class="status-alert">${escapeHtml(portStatus.error)}</div>`
          : ""
      }
      <div class="status-stat-grid">
        ${renderPortStatusStat("Active Listeners", String(activeCount), activeCount ? "live" : "idle")}
        ${renderPortStatusStat("Tracked Ports", trackedPortCount ? String(trackedPortCount) : "Waiting", "neutral")}
        ${renderPortStatusStat("Last Scan", formatPortStatusScan(portStatus?.scannedAt), portStatus?.available === false ? "danger" : "neutral")}
      </div>
      <section class="status-panel">
        <div class="status-panel-header">
          <div>
            <div class="row-title">Live Now</div>
            <div class="row-subtitle">Processes listening on the ports this view watches.</div>
          </div>
          <span class="status-badge ${activeCount ? "status-running" : "status-idle"}">${activeCount ? `${activeCount} active` : "Quiet"}</span>
        </div>
        ${
          ui.portStatusLoading && !portStatus
            ? `<div class="status-empty-state">Scanning watched ports...</div>`
            : !portStatus?.available && portStatus
              ? `<div class="status-empty-state">Port data is unavailable until the scan succeeds.</div>`
              : activePorts.length
                ? `<div class="card-grid">${activePorts.map(renderLivePortCard).join("")}</div>`
                : `<div class="status-empty-state">Nothing in the watched ranges is listening right now.</div>`
        }
      </section>
      <section class="status-panel">
        <div class="status-panel-header">
          <div>
            <div class="row-title">Watched Ranges</div>
            <div class="row-subtitle">Grouped by the local ports developers usually care about.</div>
          </div>
        </div>
        ${
          portStatus?.available
            ? `<div class="status-group-grid">${groups.map(renderPortGroupCard).join("")}</div>`
            : `<div class="status-empty-state">The watched ranges will appear here after the next successful scan.</div>`
        }
      </section>
      ${
        ui.portStatusShowAll && canRenderTrackedTable
          ? `
            <section class="status-panel">
              <div class="status-panel-header">
                <div>
                  <div class="row-title">Tracked Ports</div>
                  <div class="row-subtitle">Every watched port, including quiet ones.</div>
                </div>
              </div>
              ${renderTrackedPortTable(portStatus.ports)}
            </section>
          `
          : ""
      }
    </section>
  `;

  syncSectionFocusUi();
}

function renderPortStatusStat(label, value, tone = "neutral") {
  return `
    <div class="status-stat-card status-stat-card-${tone}">
      <div class="status-stat-label">${escapeHtml(label)}</div>
      <div class="status-stat-value">${escapeHtml(value)}</div>
    </div>
  `;
}

function renderLivePortCard(port) {
  const extraListeners = Math.max(port.listeners.length - 2, 0);

  return `
    <article class="status-port-card">
      <div class="row-title">
        <span class="mono">:${escapeHtml(String(port.port))}</span>
        <span class="status-badge status-running">Listening</span>
      </div>
      <div class="row-subtitle">${escapeHtml(port.primaryCommand || "Unknown process")}${port.primaryPid ? ` · pid ${escapeHtml(String(port.primaryPid))}` : ""}</div>
      <div class="status-listener-list">
        ${port.listeners
          .slice(0, 2)
          .map(
            (listener) => `
              <div class="row-meta mono">${escapeHtml(listener.command)} · pid ${escapeHtml(String(listener.pid))} · ${escapeHtml(listener.address)}</div>
            `
          )
          .join("")}
        ${extraListeners ? `<div class="row-meta">+${extraListeners} more ${pluralize(extraListeners, "listener", "listeners")}</div>` : ""}
      </div>
    </article>
  `;
}

function renderPortGroupCard(group) {
  return `
    <article class="status-group-card">
      <div class="row-title">
        <span>${escapeHtml(group.label)}</span>
        <span class="status-badge ${group.activeCount ? "status-running" : "status-idle"}">${group.activeCount ? `${group.activeCount} live` : "Quiet"}</span>
      </div>
      <div class="row-subtitle">${escapeHtml(group.description)}</div>
      ${
        group.activePorts.length
          ? `
            <div class="status-chip-row">
              ${group.activePorts
                .map(
                  (port) => `
                    <span class="status-port-chip">
                      <span class="mono">:${escapeHtml(String(port.port))}</span>
                      <span>${escapeHtml(port.primaryCommand || "process")}</span>
                    </span>
                  `
                )
                .join("")}
            </div>
          `
          : `<div class="row-meta">No listeners in this range.</div>`
      }
    </article>
  `;
}

function renderTrackedPortTable(ports) {
  return `
    <div class="status-table-wrap">
      <table class="status-table">
        <thead>
          <tr>
            <th>Port</th>
            <th>Status</th>
            <th>Process</th>
            <th>Listener</th>
          </tr>
        </thead>
        <tbody>
          ${ports
            .map(
              (port) => `
                <tr>
                  <td class="mono">:${escapeHtml(String(port.port))}</td>
                  <td><span class="status-badge ${port.status === "listening" ? "status-running" : "status-idle"}">${port.status === "listening" ? "Listening" : "Closed"}</span></td>
                  <td>${escapeHtml(port.primaryCommand || "None")}${port.primaryPid ? ` · pid ${escapeHtml(String(port.primaryPid))}` : ""}</td>
                  <td class="mono">${escapeHtml(port.addressSummary[0] || "Not listening")}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function formatPortStatusScan(value) {
  if (!value) {
    return ui.portStatusLoading ? "Scanning..." : "Not scanned";
  }

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return "Unknown";
  }

  return timestamp.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}

function pluralize(count, singular, plural) {
  return count === 1 ? singular : plural;
}

function renderSessionDetail(session) {
  if (!session) {
    detailElement.innerHTML = `<div class="empty-state">This session is no longer available.</div>`;
    destroySessionWorkspaceTerminals();
    return;
  }

  const layout = syncStoredSessionWorkspaceLayout(session.id);
  const signature = workspaceLayoutSignature(layout);

  if (
    detailElement.querySelector(".session-workspace-detail") === null ||
    ui.workspaceStructureSignature !== signature
  ) {
    destroySessionWorkspaceTerminals();
    detailElement.innerHTML = `
      <section class="session-workspace-detail">
        <div id="session-workspace-toolbar"></div>
        <div id="session-workspace-canvas" class="session-workspace-canvas">
          ${layout ? renderSessionWorkspaceLayoutNode(layout) : `<div class="empty-state">Drag a session here to start a workspace layout.</div>`}
        </div>
      </section>
    `;
    ui.workspaceStructureSignature = signature;
    if (layout) {
      mountSessionWorkspaceTerminals(layout);
    }
  }

  updateSessionWorkspaceToolbar();
  updateAllSessionPanes();
  updateSessionDropUi();
  syncSectionFocusUi();
}

function updateSessionChrome(session) {
  if (isSessionVisible(session.id)) {
    updateSessionWorkspaceToolbar();
    updateSessionPane(session);
  }
}

function renderSessionWorkspaceLayoutNode(node: WorkspaceLayoutNode) {
  if (!node) {
    return "";
  }

  if (node.type === "leaf") {
    return renderSessionPane(node.sessionId);
  }

  return `
    <div class="session-workspace-split session-workspace-split-${node.axis}">
      ${node.children.map((child) => renderSessionWorkspaceLayoutNode(child)).join("")}
    </div>
  `;
}

function renderSessionPane(sessionId) {
  const session = sessionById(sessionId);
  if (!session) {
    return "";
  }

  return `
    <article class="session-pane ${selectionMatches("session", session.id) ? "session-pane-active" : ""}" data-session-id="${session.id}">
      <div class="session-pane-drop-indicator">
        <span class="session-pane-drop-label"></span>
      </div>
      <div class="session-pane-main" tabindex="-1" data-action="select-session-pane" data-session-id="${session.id}">
        <div class="session-pane-header"></div>
        <div class="session-pane-blocker"></div>
      </div>
      <div class="session-pane-terminal-wrap ${session.runtimeState === "live" ? "" : "session-pane-terminal-wrap-paused"}" tabindex="-1">
        <div class="session-terminal-shell" data-session-id="${session.id}">
          <div class="session-terminal" data-session-id="${session.id}"></div>
        </div>
        <div class="session-pane-paused-notice"></div>
      </div>
    </article>
  `;
}

function updateSessionWorkspaceToolbar() {
  if (ui.selection.type !== "session") {
    return;
  }

  const session = sessionById(ui.selection.id);
  const toolbar = document.getElementById("session-workspace-toolbar");

  if (!session || !toolbar) {
    return;
  }

  const repo = repoById(session.repoID);
  const visibleSessionCount = workspaceVisibleSessionIds().length;

  toolbar.innerHTML = `
    <div class="detail-hero workspace-hero">
      <div>
        <div class="eyebrow">Workspace</div>
        <h1 class="detail-title">${escapeHtml(session.title)}</h1>
        <div class="muted">${escapeHtml(repo?.name || "Unknown Repo")} · ${visibleSessionCount} visible ${pluralize(visibleSessionCount, "session", "sessions")} · Drag a session onto a pane edge to split it.</div>
      </div>
      <div class="detail-actions workspace-detail-actions">
        <button data-action="open-launcher" data-repo-id="${repo?.id || ""}">New Session</button>
        <button data-action="workspace-layout-columns">Columns</button>
        <button data-action="workspace-layout-stack">Stack</button>
        <button data-action="workspace-layout-grid" ${visibleSessionCount > 1 ? "" : "disabled"}>Grid</button>
        <button data-action="reveal-repo" data-repo-id="${repo?.id || ""}">Reveal Repo</button>
        <button data-action="open-settings" data-settings-tab="claude">Claude Files</button>
        ${
          session.runtimeState === "live"
            ? `<button data-action="close-session" data-session-id="${session.id}">Close Session</button>`
            : `<button class="primary" data-action="restart-session" data-session-id="${session.id}">${escapeHtml(resumeSessionActionLabel(session))}</button>
               <button data-action="close-session" data-session-id="${session.id}">Close Session</button>`
        }
      </div>
    </div>
  `;
}

function updateAllSessionPanes() {
  for (const sessionId of workspaceVisibleSessionIds()) {
    const session = sessionById(sessionId);
    if (session) {
      updateSessionPane(session);
    }
  }
}

function updateSessionPane(session) {
  const pane = sessionPaneElement(session.id);
  if (!pane) {
    return;
  }

  const repo = repoById(session.repoID);
  const header = pane.querySelector(".session-pane-header") as HTMLElement | null;
  const blockerElement = pane.querySelector(".session-pane-blocker") as HTMLElement | null;
  const pausedNotice = pane.querySelector(".session-pane-paused-notice") as HTMLElement | null;
  const terminalWrap = pane.querySelector(".session-pane-terminal-wrap") as HTMLElement | null;

  if (!header || !blockerElement || !pausedNotice || !terminalWrap) {
    return;
  }

  pane.classList.toggle("session-pane-active", selectionMatches("session", session.id));
  terminalWrap.classList.toggle("session-pane-terminal-wrap-paused", session.runtimeState !== "live");

  header.innerHTML = `
    <div class="session-pane-header-row">
      <div class="session-pane-title-row">
        <button class="ghost session-pane-drag-handle" draggable="true" data-drag-session-id="${session.id}" data-drag-source="pane" title="Drag ${escapeAttribute(session.title)}" aria-label="Drag ${escapeAttribute(session.title)}">Drag</button>
        <div class="session-pane-title-copy">
          <div class="session-title-row">
            <div class="session-title">${escapeHtml(session.title)}</div>
            <span class="status-badge status-${escapeHtml(session.status)}">${escapeHtml(statusLabel(session.status))}</span>
          </div>
          <div class="muted">${escapeHtml(repo?.name || "Unknown Repo")} · ${escapeHtml(abbreviateHome(repo?.path || ""))}</div>
        </div>
      </div>
      <div class="session-pane-actions">
        ${
          session.runtimeState === "live"
            ? ""
            : `<button class="primary" data-action="restart-session" data-session-id="${session.id}">${escapeHtml(resumeSessionActionLabel(session))}</button>`
        }
        <button data-action="remove-session-pane" data-session-id="${session.id}">Hide</button>
      </div>
    </div>
  `;

  blockerElement.innerHTML = renderSessionBlocker(session);
  pausedNotice.innerHTML = renderPausedSessionNotice(session);
}

function renderSessionBlocker(session) {
  if (!session.blocker) {
    return "";
  }

  return `
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
  `;
}

function renderPausedSessionNotice(session) {
  if (session.runtimeState === "live") {
    return "";
  }

  const body = session.launchesClaudeOnStart
    ? "This Claude conversation was restored from history. Resume it to send another message in this project."
    : "This shell session was restored from history. Restart it to type in the terminal again.";

  return `
    <div class="terminal-paused-notice">
      <div>
        <div class="row-title">${escapeHtml(resumeSessionActionLabel(session))}</div>
        <div class="row-subtitle">${escapeHtml(body)}</div>
      </div>
      <button class="primary" data-action="restart-session" data-session-id="${session.id}">${escapeHtml(resumeSessionActionLabel(session))}</button>
    </div>
  `;
}

function resumeSessionActionLabel(session) {
  return session.launchesClaudeOnStart ? "Resume Claude" : "Restart Shell";
}

function sessionOpenFocusSection(session): SectionId {
  return session?.runtimeState === "live" ? "terminal" : "main";
}

function mountSessionWorkspaceTerminals(layout: WorkspaceLayoutNode) {
  destroySessionWorkspaceTerminals();

  for (const sessionId of collectWorkspaceSessionIds(layout)) {
    const session = sessionById(sessionId);
    const terminalElement = detailElement.querySelector(
      `.session-terminal[data-session-id="${CSS.escape(sessionId)}"]`
    ) as HTMLElement | null;
    const shellElement = detailElement.querySelector(
      `.session-terminal-shell[data-session-id="${CSS.escape(sessionId)}"]`
    ) as HTMLElement | null;

    if (!session || !terminalElement || !shellElement) {
      continue;
    }

    const terminal = new Terminal({
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

    const fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalElement);
    terminal.attachCustomKeyEventHandler((event) => handleTerminalCustomKeyEvent(event));
    terminal.onData((data) => {
      api.sendInput(session.id, data);
    });
    terminal.onBinary((data) => {
      api.sendBinaryInput(session.id, data);
    });
    terminal.onResize((size) => {
      api.resizeSession(session.id, size.cols, size.rows);
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(shellElement);

    ui.terminalMounts.set(session.id, {
      terminal,
      fitAddon,
      resizeObserver
    });

    terminal.reset();
    terminal.write(terminalReplayText(session));
    syncSessionTerminalLiveState(session);
    fitAddon.fit();
    api.resizeSession(session.id, terminal.cols, terminal.rows);
    requestAnimationFrame(() => {
      const mount = ui.terminalMounts.get(session.id);
      if (!mount) {
        return;
      }

      mount.fitAddon.fit();
      api.resizeSession(session.id, mount.terminal.cols, mount.terminal.rows);
      if (
        ui.selection.type === "session" &&
        ui.selection.id === session.id &&
        ui.focusSection === "terminal" &&
        !isAnyDialogOpen()
      ) {
        mount.terminal.focus();
      }
    });
  }
}

function mountTerminal(session) {
  if (!isSessionVisible(session.id)) {
    return;
  }

  const mount = ui.terminalMounts.get(session.id);
  if (mount && ui.focusSection === "terminal" && ui.selection.type === "session" && ui.selection.id === session.id) {
    mount.terminal.focus();
  }
}

function writeSessionTerminalOutput(sessionId, data) {
  const mount = ui.terminalMounts.get(sessionId);
  if (!mount) {
    return;
  }

  mount.terminal.write(data);
}

function syncTerminalLiveState(session) {
  syncSessionTerminalLiveState(session);
}

function syncSessionTerminalLiveState(session) {
  const mount = ui.terminalMounts.get(session.id);
  if (!mount) {
    return;
  }

  mount.terminal.options.disableStdin = session.runtimeState !== "live";
}

function destroyTerminal() {
  destroySessionWorkspaceTerminals();
}

function destroySessionWorkspaceTerminals() {
  for (const mount of ui.terminalMounts.values()) {
    mount.resizeObserver.disconnect();
    mount.terminal.dispose();
  }

  ui.terminalMounts.clear();
  ui.workspaceStructureSignature = "";
}

function terminalReplayText(session) {
  return session.rawTranscript || session.transcript || "";
}

function sessionPaneElement(sessionId) {
  return detailElement.querySelector(
    `.session-pane[data-session-id="${CSS.escape(sessionId)}"]`
  ) as HTMLElement | null;
}

function activeTerminalMount() {
  if (ui.selection.type !== "session") {
    return null;
  }

  return ui.terminalMounts.get(ui.selection.id) || null;
}

function renderInboxCard(session) {
  const repo = repoById(session.repoID);
  return `
    <button class="inbox-card ${mainListSelectionMatches(session.id) ? "keyboard-active" : ""}" data-action="select-session" data-session-id="${session.id}" ${renderSessionDragAttributes(session.id, "list")}>
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
    <button class="session-row ${selectionMatches("session", session.id) ? "active" : ""} ${mainListSelectionMatches(session.id) ? "keyboard-active" : ""}" data-action="select-session" data-session-id="${session.id}" ${renderSessionDragAttributes(session.id, "list")}>
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
    { id: "open-status", label: "Open Dev Port Status", action: "open-status" },
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

  syncSidebarNavItemFromTarget(target);

  switch (action) {
    case "select-inbox":
      await selectInbox();
      break;
    case "select-repo":
      await selectRepo(target.dataset.repoId);
      break;
    case "select-session": {
      const session = sessionById(target.dataset.sessionId);
      await selectSession(target.dataset.sessionId, sessionOpenFocusSection(session));
      break;
    }
    case "select-session-pane":
      await activateVisibleSession(target.dataset.sessionId, "main");
      break;
    case "collapse-sidebar-project":
      collapseSidebarProjectDrawer(target.dataset.repoId);
      break;
    case "open-launcher":
      openLauncher(target.dataset.repoId || currentRepoId());
      break;
    case "open-status":
      await selectStatus();
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
      removeSessionFromWorkspace(target.dataset.sessionId, { persistSelection: false });
      await api.closeSession(target.dataset.sessionId);
      if (ui.selection.type === "session" && ui.selection.id === target.dataset.sessionId) {
        const nextVisibleSessionId = workspaceVisibleSessionIds()[0] || null;
        if (nextVisibleSessionId) {
          await selectSession(nextVisibleSessionId, "main");
        } else {
          await selectInbox();
        }
      }
      break;
    case "restart-session":
      setFocusSection("terminal");
      await api.reopenSession(target.dataset.sessionId);
      break;
    case "remove-session-pane":
      await hideSessionPane(target.dataset.sessionId);
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
    case "refresh-port-status":
      await refreshPortStatus();
      break;
    case "toggle-port-status-table":
      ui.portStatusShowAll = !ui.portStatusShowAll;
      renderDetail();
      break;
    case "workspace-layout-columns":
      applyWorkspacePreset("columns");
      break;
    case "workspace-layout-stack":
      applyWorkspacePreset("stack");
      break;
    case "workspace-layout-grid":
      applyWorkspacePreset("grid");
      break;
    case "switch-session":
      quickSwitcherDialog.close();
      await selectSession(
        target.dataset.sessionId,
        sessionOpenFocusSection(sessionById(target.dataset.sessionId))
      );
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

  const paneSessionId = sessionIdForPaneTarget(target);
  if (paneSessionId && ui.selection.type === "session" && ui.selection.id !== paneSessionId) {
    void activateVisibleSession(
      paneSessionId,
      isTerminalTarget(target) ? "terminal" : "main"
    );
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
    syncSidebarNavItemFromTarget(target);
    setFocusSection("sidebar");
    return;
  }

  if (detailElement.contains(target)) {
    setFocusSection("main");
  }
}

function handleDragStart(event: DragEvent) {
  const target = event.target as HTMLElement | null;
  const draggable = target?.closest("[data-drag-session-id]") as HTMLElement | null;
  const sessionId = draggable?.dataset.dragSessionId;

  if (!sessionId) {
    return;
  }

  ui.draggingSessionId = sessionId;
  ui.draggingSessionSource = draggable?.dataset.dragSource || "list";
  ui.dragTargetSessionId = null;
  ui.dragTargetZone = null;

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", sessionId);
  }

  updateSessionDropUi();
}

function handleDragEnd() {
  clearSessionDragState();
}

function handleDragOver(event: DragEvent) {
  if (!ui.draggingSessionId || ui.selection.type !== "session") {
    return;
  }

  const target = event.target as HTMLElement | null;
  const pane = target?.closest(".session-pane") as HTMLElement | null;
  const targetSessionId = pane?.dataset.sessionId;

  if (!pane || !targetSessionId) {
    clearSessionDropTarget();
    return;
  }

  const zone = workspaceDropZoneForEvent(pane, event);
  if (!canDropSessionAtTarget(ui.draggingSessionId, targetSessionId, zone)) {
    clearSessionDropTarget();
    return;
  }

  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }

  ui.dragTargetSessionId = targetSessionId;
  ui.dragTargetZone = zone;
  updateSessionDropUi();
}

function handleDrop(event: DragEvent) {
  if (!ui.draggingSessionId || ui.selection.type !== "session") {
    return;
  }

  const target = event.target as HTMLElement | null;
  const pane = target?.closest(".session-pane") as HTMLElement | null;
  const targetSessionId = pane?.dataset.sessionId;

  if (!pane || !targetSessionId) {
    clearSessionDragState();
    return;
  }

  const zone = workspaceDropZoneForEvent(pane, event);
  if (!canDropSessionAtTarget(ui.draggingSessionId, targetSessionId, zone)) {
    clearSessionDragState();
    return;
  }

  event.preventDefault();
  applySessionWorkspaceDrop(ui.draggingSessionId, targetSessionId, zone);
  clearSessionDragState();
}

function clearSessionDragState() {
  ui.draggingSessionId = null;
  ui.draggingSessionSource = null;
  ui.dragTargetSessionId = null;
  ui.dragTargetZone = null;
  updateSessionDropUi();
}

function clearSessionDropTarget() {
  if (!ui.dragTargetSessionId && !ui.dragTargetZone) {
    return;
  }

  ui.dragTargetSessionId = null;
  ui.dragTargetZone = null;
  updateSessionDropUi();
}

async function handleContextMenu(event) {
  if (isAnyDialogOpen()) {
    return;
  }

  const target = event.target as HTMLElement | null;
  if (!target) {
    return;
  }

  const repoElement = target.closest("[data-repo-id]") as HTMLElement | null;
  const repoId = repoElement?.dataset.repoId;
  if (!repoId || !sidebarElement.contains(repoElement)) {
    return;
  }

  event.preventDefault();

  const nextSection = isSidebarDrawerTarget(target) ? "sidebar-drawer" : "sidebar";
  if (currentRepoId() !== repoId) {
    await selectRepo(repoId, nextSection);
  } else {
    setFocusSection(nextSection);
  }

  await api.showRepoContextMenu(repoId, { x: event.clientX, y: event.clientY });
}

async function handleKeyDown(event) {
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

  if (await handleTerminalClipboardShortcut(event)) {
    return;
  }

  if (isEditableTarget(event.target as HTMLElement | null)) {
    return;
  }

  if (
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "c" &&
    (ui.focusSection === "sidebar" || ui.focusSection === "sidebar-drawer")
  ) {
    const repoId = currentRepoId();
    if (repoId) {
      event.preventDefault();
      void startClaudeSessionForRepo(repoId);
      return;
    }
  }

  if (ui.focusSection === "sidebar" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      navigateSidebarItems(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      await activateSidebarNavItem();
      return;
    }
  }

  if (ui.focusSection === "sidebar-drawer" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      navigateSidebarDrawerSessions(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
  }

  if (ui.focusSection === "main" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (event.key === "Enter" && ui.selection.type === "session") {
      event.preventDefault();
      const session = sessionById(ui.selection.id);
      if (session?.runtimeState === "live") {
        setFocusSection("terminal");
      } else if (session?.id) {
        setFocusSection("terminal");
        await api.reopenSession(session.id);
      }
      return;
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      navigateMainListSessions(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (event.key === "Enter" && ui.mainListSessionId) {
      event.preventDefault();
      void selectSession(
        ui.mainListSessionId,
        sessionOpenFocusSection(sessionById(ui.mainListSessionId))
      );
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
  ui.sidebarNavItem = "inbox";
  syncMainListSelection();
  normalizeFocusSection();
  await api.setFocusedSession(null);
  renderSidebar();
  renderDetail();
}

async function selectStatus(nextFocusSection: SectionId | null = null) {
  if (nextFocusSection) {
    ui.focusSection = nextFocusSection;
  }
  ui.selection = { type: "status", id: null };
  ui.sidebarExpandedRepoId = null;
  ui.sidebarNavItem = sidebarActionNavId("open-status");
  syncMainListSelection();
  normalizeFocusSection();
  await api.setFocusedSession(null);
  renderSidebar();
  renderDetail();
  await refreshPortStatus();
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
  ui.sidebarNavItem = repoId;
  syncMainListSelection();
  normalizeFocusSection();
  await api.setFocusedSession(null);
  renderSidebar();
  renderDetail();
}

async function selectSession(
  sessionId,
  nextFocusSection: SectionId | null = null
) {
  const session = sessionById(sessionId);
  if (!session) {
    return;
  }

  if (ui.selection.type === "session" && isSessionVisible(sessionId)) {
    await activateVisibleSession(sessionId, nextFocusSection);
    return;
  }

  if (nextFocusSection) {
    ui.focusSection = nextFocusSection;
  }

  const nextLayout = addSessionToWorkspaceLayout(
    syncStoredSessionWorkspaceLayout(),
    sessionId,
    ui.selection.type === "session" ? ui.selection.id : null
  );
  setStoredSessionWorkspaceLayout(nextLayout);

  ui.selection = { type: "session", id: sessionId };
  if (ui.sidebarExpandedRepoId) {
    ui.sidebarExpandedRepoId = session.repoID || ui.sidebarExpandedRepoId;
  }
  ui.sidebarNavItem = session.repoID || ui.sidebarNavItem;
  ui.mainListSessionId = sessionId;
  normalizeFocusSection();
  await api.setFocusedSession(sessionId);
  renderSidebar();
  renderDetail();
}

async function activateVisibleSession(
  sessionId,
  nextFocusSection: SectionId | null = null
) {
  const session = sessionById(sessionId);
  if (!session) {
    return;
  }

  if (nextFocusSection) {
    ui.focusSection = nextFocusSection;
  }

  ui.selection = { type: "session", id: sessionId };
  if (ui.sidebarExpandedRepoId) {
    ui.sidebarExpandedRepoId = session.repoID || ui.sidebarExpandedRepoId;
  }
  ui.sidebarNavItem = session.repoID || ui.sidebarNavItem;
  ui.mainListSessionId = sessionId;
  normalizeFocusSection();
  await api.setFocusedSession(sessionId);
  renderSidebar();
  updateSessionWorkspaceToolbar();
  updateAllSessionPanes();
  syncSectionFocusUi();
}

async function hideSessionPane(sessionId) {
  removeSessionFromWorkspace(sessionId, { persistSelection: false });

  if (ui.selection.type === "session" && ui.selection.id === sessionId) {
    const nextVisibleSessionId = workspaceVisibleSessionIds()[0] || null;
    if (nextVisibleSessionId) {
      await activateVisibleSession(nextVisibleSessionId, "main");
      renderDetail();
      return;
    }

    await selectInbox();
    return;
  }

  renderDetail();
}

function applyWorkspacePreset(preset: "columns" | "stack" | "grid") {
  if (ui.selection.type !== "session") {
    return;
  }

  const sessionIds = workspaceVisibleSessionIds();
  if (!sessionIds.length) {
    return;
  }

  switch (preset) {
    case "columns":
      setStoredSessionWorkspaceLayout(buildAxisWorkspaceLayout(sessionIds, "row"));
      break;
    case "stack":
      setStoredSessionWorkspaceLayout(buildAxisWorkspaceLayout(sessionIds, "column"));
      break;
    case "grid":
      setStoredSessionWorkspaceLayout(buildGridWorkspaceLayout(sessionIds));
      break;
    default:
      break;
  }

  renderDetail();
}

async function refreshPortStatus() {
  if (ui.portStatusLoading) {
    return;
  }

  ui.portStatusLoading = true;
  if (ui.selection.type === "status") {
    renderPortStatusDetail();
  }

  try {
    ui.portStatusData = await api.getTrackedPortStatus();
  } catch (error) {
    ui.portStatusData = {
      available: false,
      scannedAt: new Date().toISOString(),
      trackedPortCount: 0,
      activeCount: 0,
      ports: [],
      activePorts: [],
      groups: [],
      error: error instanceof Error ? error.message : "Port inspection failed."
    };
  } finally {
    ui.portStatusLoading = false;
  }

  if (ui.selection.type === "status") {
    renderPortStatusDetail();
  }
}

function syncPortStatusPolling() {
  if (ui.selection.type === "status") {
    if (ui.portStatusPollTimer === null) {
      ui.portStatusPollTimer = window.setInterval(() => {
        void refreshPortStatus();
      }, 5000);
    }

    if (!ui.portStatusData && !ui.portStatusLoading) {
      void refreshPortStatus();
    }
    return;
  }

  if (ui.portStatusPollTimer !== null) {
    window.clearInterval(ui.portStatusPollTimer);
    ui.portStatusPollTimer = null;
  }
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

  launcherDialog.close();
  await startSessionForRepo(ui.launcherSelectedRepoId, ui.launcherLaunchesClaudeOnStart, "terminal");
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

async function startClaudeSessionForRepo(repoId) {
  await startSessionForRepo(repoId, true, "terminal");
}

async function startSessionForRepo(
  repoId,
  launchesClaudeOnStart,
  focusSection: SectionId = "terminal"
) {
  if (!repoId) {
    return null;
  }

  const sessionId = await api.createSession(repoId, launchesClaudeOnStart);
  if (sessionId) {
    await selectSession(sessionId, focusSection);
  }

  return sessionId;
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

function renderSessionDragAttributes(sessionId, source = "list") {
  return `draggable="true" data-drag-session-id="${escapeAttribute(sessionId)}" data-drag-source="${escapeAttribute(source)}"`;
}

function cloneWorkspaceLayout(layout: WorkspaceLayoutNode | null = null) {
  return layout ? JSON.parse(JSON.stringify(layout)) : null;
}

function workspaceLayoutSignature(layout: WorkspaceLayoutNode | null = null) {
  return JSON.stringify(layout || null);
}

function createWorkspaceLeaf(sessionId: string): WorkspaceLeafNode {
  return {
    type: "leaf",
    sessionId
  };
}

function collectWorkspaceSessionIds(layout: WorkspaceLayoutNode | null): string[] {
  if (!layout) {
    return [];
  }

  if (layout.type === "leaf") {
    return [layout.sessionId];
  }

  return layout.children.flatMap((child) => collectWorkspaceSessionIds(child));
}

function normalizeWorkspaceLayout(
  layout: WorkspaceLayoutNode | null,
  validSessionIds = new Set(state.sessions.map((session) => session.id))
) {
  const normalized = normalizeWorkspaceNode(cloneWorkspaceLayout(layout), validSessionIds);
  const visibleIds = collectWorkspaceSessionIds(normalized);

  if (visibleIds.length <= MAX_VISIBLE_SESSION_PANES) {
    return normalized;
  }

  return normalizeWorkspaceNode(
    normalized,
    new Set(visibleIds.slice(0, MAX_VISIBLE_SESSION_PANES))
  );
}

function normalizeWorkspaceNode(
  layout: WorkspaceLayoutNode | null,
  validSessionIds: Set<string>
): WorkspaceLayoutNode | null {
  if (!layout) {
    return null;
  }

  if (layout.type === "leaf") {
    return validSessionIds.has(layout.sessionId) ? layout : null;
  }

  const normalizedChildren: WorkspaceLayoutNode[] = [];
  for (const child of layout.children || []) {
    const normalizedChild = normalizeWorkspaceNode(child, validSessionIds);
    if (!normalizedChild) {
      continue;
    }

    if (normalizedChild.type === "split" && normalizedChild.axis === layout.axis) {
      normalizedChildren.push(...normalizedChild.children);
    } else {
      normalizedChildren.push(normalizedChild);
    }
  }

  if (normalizedChildren.length === 0) {
    return null;
  }

  if (normalizedChildren.length === 1) {
    return normalizedChildren[0];
  }

  return {
    type: "split",
    axis: layout.axis === "column" ? "column" : "row",
    children: normalizedChildren
  };
}

function buildAxisWorkspaceLayout(sessionIds: string[], axis: WorkspaceSplitAxis) {
  const visibleIds = uniqueWorkspaceSessionIds(sessionIds);
  if (!visibleIds.length) {
    return null;
  }

  if (visibleIds.length === 1) {
    return createWorkspaceLeaf(visibleIds[0]);
  }

  return {
    type: "split",
    axis,
    children: visibleIds.map((sessionId) => createWorkspaceLeaf(sessionId))
  } satisfies WorkspaceLayoutNode;
}

function buildGridWorkspaceLayout(sessionIds: string[]) {
  const visibleIds = uniqueWorkspaceSessionIds(sessionIds);
  if (visibleIds.length <= 2) {
    return buildAxisWorkspaceLayout(visibleIds, "row");
  }

  const rows = [visibleIds.slice(0, 2), visibleIds.slice(2)];
  const rowLayouts = rows
    .filter((row) => row.length)
    .map((row) => buildAxisWorkspaceLayout(row, "row"))
    .filter(Boolean) as WorkspaceLayoutNode[];

  if (rowLayouts.length === 1) {
    return rowLayouts[0];
  }

  return {
    type: "split",
    axis: "column",
    children: rowLayouts
  } satisfies WorkspaceLayoutNode;
}

function uniqueWorkspaceSessionIds(sessionIds: string[]) {
  return [...new Set(sessionIds.filter((sessionId) => !!sessionById(sessionId)))].slice(
    0,
    MAX_VISIBLE_SESSION_PANES
  );
}

function setStoredSessionWorkspaceLayout(layout: WorkspaceLayoutNode | null) {
  const normalized = normalizeWorkspaceLayout(layout);
  const nextSignature = workspaceLayoutSignature(normalized);
  const currentSignature = workspaceLayoutSignature(
    state.preferences.sessionWorkspaceLayout || null
  );

  if (currentSignature === nextSignature) {
    return normalized;
  }

  state.preferences = {
    ...state.preferences,
    sessionWorkspaceLayout: normalized
  };
  void api.updatePreferences({ sessionWorkspaceLayout: normalized });
  return normalized;
}

function syncStoredSessionWorkspaceLayout(activeSessionId: string | null = null) {
  let layout = normalizeWorkspaceLayout(state.preferences.sessionWorkspaceLayout || null);

  if (activeSessionId && sessionById(activeSessionId)) {
    layout = addSessionToWorkspaceLayout(layout, activeSessionId, activeSessionId);
  }

  return setStoredSessionWorkspaceLayout(layout);
}

function workspaceVisibleSessionIds() {
  return collectWorkspaceSessionIds(syncStoredSessionWorkspaceLayout());
}

function isSessionVisible(sessionId) {
  return workspaceVisibleSessionIds().includes(sessionId);
}

function workspaceContainsSession(layout: WorkspaceLayoutNode | null, sessionId: string) {
  return collectWorkspaceSessionIds(layout).includes(sessionId);
}

function addSessionToWorkspaceLayout(
  layout: WorkspaceLayoutNode | null,
  sessionId: string,
  targetSessionId: string | null = null
) {
  if (!sessionById(sessionId)) {
    return layout;
  }

  if (!layout) {
    return createWorkspaceLeaf(sessionId);
  }

  if (workspaceContainsSession(layout, sessionId)) {
    return layout;
  }

  const visibleIds = collectWorkspaceSessionIds(layout);
  const replaceTargetId =
    targetSessionId && workspaceContainsSession(layout, targetSessionId)
      ? targetSessionId
      : visibleIds[visibleIds.length - 1];

  if (visibleIds.length >= MAX_VISIBLE_SESSION_PANES) {
    return replaceSessionInWorkspaceLayout(layout, replaceTargetId, sessionId);
  }

  return insertLeafNextToTarget(
    layout,
    replaceTargetId,
    createWorkspaceLeaf(sessionId),
    "row",
    false
  );
}

function replaceSessionInWorkspaceLayout(
  layout: WorkspaceLayoutNode | null,
  targetSessionId: string,
  newSessionId: string
) {
  if (!layout) {
    return createWorkspaceLeaf(newSessionId);
  }

  if (layout.type === "leaf") {
    return layout.sessionId === targetSessionId ? createWorkspaceLeaf(newSessionId) : layout;
  }

  return normalizeWorkspaceLayout({
    ...layout,
    children: layout.children.map((child) =>
      replaceSessionInWorkspaceLayout(child, targetSessionId, newSessionId)
    )
  });
}

function removeSessionFromLayout(layout: WorkspaceLayoutNode | null, sessionId: string) {
  if (!layout) {
    return null;
  }

  if (layout.type === "leaf") {
    return layout.sessionId === sessionId ? null : layout;
  }

  return normalizeWorkspaceLayout({
    ...layout,
    children: layout.children
      .map((child) => removeSessionFromLayout(child, sessionId))
      .filter(Boolean) as WorkspaceLayoutNode[]
  });
}

function removeSessionFromWorkspace(
  sessionId: string,
  options: { persistSelection?: boolean } = {}
) {
  const nextLayout = removeSessionFromLayout(syncStoredSessionWorkspaceLayout(), sessionId);
  setStoredSessionWorkspaceLayout(nextLayout);

  if (options.persistSelection === false) {
    return nextLayout;
  }

  if (ui.selection.type === "session" && ui.selection.id === sessionId) {
    const nextVisibleSessionId = collectWorkspaceSessionIds(nextLayout)[0] || null;
    if (nextVisibleSessionId) {
      ui.selection = { type: "session", id: nextVisibleSessionId };
    }
  }

  return nextLayout;
}

function swapSessionsInWorkspaceLayout(
  layout: WorkspaceLayoutNode | null,
  firstSessionId: string,
  secondSessionId: string
) {
  if (!layout) {
    return null;
  }

  if (layout.type === "leaf") {
    if (layout.sessionId === firstSessionId) {
      return createWorkspaceLeaf(secondSessionId);
    }

    if (layout.sessionId === secondSessionId) {
      return createWorkspaceLeaf(firstSessionId);
    }

    return layout;
  }

  return normalizeWorkspaceLayout({
    ...layout,
    children: layout.children.map((child) =>
      swapSessionsInWorkspaceLayout(child, firstSessionId, secondSessionId)
    )
  });
}

function insertLeafNextToTarget(
  layout: WorkspaceLayoutNode | null,
  targetSessionId: string,
  newLeaf: WorkspaceLeafNode,
  axis: WorkspaceSplitAxis,
  before: boolean
) {
  if (!layout) {
    return newLeaf;
  }

  if (layout.type === "leaf") {
    if (layout.sessionId !== targetSessionId) {
      return layout;
    }

    return normalizeWorkspaceLayout({
      type: "split",
      axis,
      children: before ? [newLeaf, layout] : [layout, newLeaf]
    });
  }

  const targetIndex = layout.children.findIndex(
    (child) => child.type === "leaf" && child.sessionId === targetSessionId
  );

  if (targetIndex >= 0) {
    const children = [...layout.children];
    if (layout.axis === axis) {
      children.splice(before ? targetIndex : targetIndex + 1, 0, newLeaf);
    } else {
      const targetChild = children[targetIndex];
      children[targetIndex] = {
        type: "split",
        axis,
        children: before ? [newLeaf, targetChild] : [targetChild, newLeaf]
      };
    }

    return normalizeWorkspaceLayout({
      ...layout,
      children
    });
  }

  return normalizeWorkspaceLayout({
    ...layout,
    children: layout.children.map((child) =>
      insertLeafNextToTarget(child, targetSessionId, newLeaf, axis, before)
    )
  });
}

function applySessionWorkspaceDrop(
  sourceSessionId: string,
  targetSessionId: string,
  zone: WorkspaceDropZone
) {
  let layout = syncStoredSessionWorkspaceLayout();
  const sourceVisible = workspaceContainsSession(layout, sourceSessionId);

  if (zone === "center") {
    layout = sourceVisible
      ? swapSessionsInWorkspaceLayout(layout, sourceSessionId, targetSessionId)
      : replaceSessionInWorkspaceLayout(layout, targetSessionId, sourceSessionId);
  } else {
    const axis = zone === "left" || zone === "right" ? "row" : "column";
    const before = zone === "left" || zone === "top";

    if (sourceVisible) {
      if (sourceSessionId === targetSessionId) {
        return;
      }

      layout = removeSessionFromLayout(layout, sourceSessionId);
    } else if (collectWorkspaceSessionIds(layout).length >= MAX_VISIBLE_SESSION_PANES) {
      return;
    }

    layout = insertLeafNextToTarget(
      layout,
      targetSessionId,
      createWorkspaceLeaf(sourceSessionId),
      axis,
      before
    );
  }

  setStoredSessionWorkspaceLayout(layout);
  ui.selection = { type: "session", id: sourceSessionId };
  ui.sidebarNavItem = sessionById(sourceSessionId)?.repoID || ui.sidebarNavItem;
  ui.mainListSessionId = sourceSessionId;
  normalizeFocusSection();
  void api.setFocusedSession(sourceSessionId);
  renderSidebar();
  renderDetail();
}

function canDropSessionAtTarget(
  sourceSessionId: string,
  targetSessionId: string,
  zone: WorkspaceDropZone
) {
  if (!sourceSessionId || !targetSessionId || !sessionById(sourceSessionId) || !sessionById(targetSessionId)) {
    return false;
  }

  const layout = syncStoredSessionWorkspaceLayout();
  const sourceVisible = workspaceContainsSession(layout, sourceSessionId);
  const targetVisible = workspaceContainsSession(layout, targetSessionId);

  if (!targetVisible) {
    return false;
  }

  if (zone === "center") {
    return sourceSessionId !== targetSessionId;
  }

  if (sourceSessionId === targetSessionId) {
    return false;
  }

  return sourceVisible || collectWorkspaceSessionIds(layout).length < MAX_VISIBLE_SESSION_PANES;
}

function workspaceDropZoneForEvent(pane: HTMLElement, event: DragEvent): WorkspaceDropZone {
  const rect = pane.getBoundingClientRect();
  const relativeX = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
  const relativeY = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
  const edgeDistances = [
    { zone: "left", value: relativeX },
    { zone: "right", value: 1 - relativeX },
    { zone: "top", value: relativeY },
    { zone: "bottom", value: 1 - relativeY }
  ] as { zone: WorkspaceDropZone; value: number }[];
  edgeDistances.sort((left, right) => left.value - right.value);

  return edgeDistances[0].value < 0.22 ? edgeDistances[0].zone : "center";
}

function sessionIdForPaneTarget(target: HTMLElement | null) {
  return (target?.closest(".session-pane") as HTMLElement | null)?.dataset.sessionId || null;
}

function updateSessionDropUi() {
  const panes = detailElement.querySelectorAll(".session-pane");
  for (const pane of panes) {
    pane.classList.remove(
      "session-pane-drop-center",
      "session-pane-drop-left",
      "session-pane-drop-right",
      "session-pane-drop-top",
      "session-pane-drop-bottom"
    );

    const sessionId = (pane as HTMLElement).dataset.sessionId;
    const label = pane.querySelector(".session-pane-drop-label") as HTMLElement | null;
    if (!sessionId || !label) {
      continue;
    }

    if (sessionId === ui.dragTargetSessionId && ui.dragTargetZone) {
      pane.classList.add(`session-pane-drop-${ui.dragTargetZone}`);
      label.textContent = workspaceDropLabel(ui.dragTargetZone, ui.draggingSessionId, sessionId);
    } else {
      label.textContent = "";
    }
  }
}

function workspaceDropLabel(
  zone: WorkspaceDropZone,
  sourceSessionId: string | null,
  targetSessionId: string
) {
  if (zone === "center") {
    return isSessionVisible(sourceSessionId || "")
      ? "Swap sessions"
      : `Replace ${sessionById(targetSessionId)?.title || "pane"}`;
  }

  switch (zone) {
    case "left":
      return "Split left";
    case "right":
      return "Split right";
    case "top":
      return "Split top";
    case "bottom":
      return "Split bottom";
    default:
      return "";
  }
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

function sidebarActionNavId(action) {
  return `action:${action}`;
}

function sidebarNavItems() {
  return [
    "inbox",
    ...sortedRepos().map((repo) => repo.id),
    sidebarActionNavId("open-workspace"),
    sidebarActionNavId("create-project"),
    sidebarActionNavId("open-status"),
    sidebarActionNavId("open-settings")
  ];
}

function syncSidebarNavSelection() {
  const items = new Set(sidebarNavItems());
  if (items.has(ui.sidebarNavItem)) {
    return;
  }

  if (ui.selection.type === "inbox") {
    ui.sidebarNavItem = "inbox";
    return;
  }

  if (ui.selection.type === "status") {
    ui.sidebarNavItem = sidebarActionNavId("open-status");
    return;
  }

  ui.sidebarNavItem = currentRepoId() || "inbox";
}

function sidebarNavMatches(itemId) {
  return ui.focusSection === "sidebar" && ui.sidebarNavItem === itemId;
}

function syncSidebarNavItemFromTarget(target) {
  const actionable = target.closest("[data-action], [data-repo-id]") as HTMLElement | null;
  if (!actionable || !sidebarElement.contains(actionable) || isSidebarDrawerTarget(actionable)) {
    return;
  }

  const { action, repoId } = actionable.dataset;
  if (repoId) {
    ui.sidebarNavItem = repoId;
    return;
  }

  switch (action) {
    case "select-inbox":
      ui.sidebarNavItem = "inbox";
      break;
    case "open-workspace":
    case "create-project":
    case "open-status":
    case "open-settings":
      ui.sidebarNavItem = sidebarActionNavId(action);
      break;
    default:
      break;
  }
}

function expandedSidebarRepo() {
  return ui.sidebarExpandedRepoId ? repoById(ui.sidebarExpandedRepoId) : null;
}

function mainListSessions() {
  if (ui.selection.type === "repo") {
    return sessionsForRepo(ui.selection.id);
  }

  if (ui.selection.type === "inbox") {
    return inboxSessions();
  }

  return [];
}

function syncMainListSelection() {
  if (ui.selection.type === "session") {
    ui.mainListSessionId = ui.selection.id;
    return;
  }

  const sessions = mainListSessions();
  if (!sessions.length) {
    ui.mainListSessionId = null;
    return;
  }

  if (ui.mainListSessionId && sessions.some((session) => session.id === ui.mainListSessionId)) {
    return;
  }

  ui.mainListSessionId = sessions[0].id;
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

  const sessionPanes = detailElement.querySelectorAll(".session-pane");
  for (const pane of sessionPanes) {
    const sessionId = (pane as HTMLElement).dataset.sessionId || null;
    const active = ui.selection.type === "session" && sessionId === ui.selection.id;
    const mainRegion = pane.querySelector(".session-pane-main") as HTMLElement | null;
    const terminalWrap = pane.querySelector(".session-pane-terminal-wrap") as HTMLElement | null;
    pane.classList.toggle("session-pane-active", active);
    mainRegion?.classList.toggle("section-focused", active && ui.focusSection === "main");
    terminalWrap?.classList.toggle("section-focused", active && ui.focusSection === "terminal");
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
      if (activeTerminalMount()) {
        activeTerminalMount()?.terminal.focus();
        break;
      }

      (
        sessionPaneElement(ui.selection.type === "session" ? ui.selection.id : "")?.querySelector(
          ".session-pane-terminal-wrap"
        ) as HTMLElement | null
      )?.focus({
        preventScroll: true
      });
      break;
    case "main":
    default: {
      const sessionMainRegion =
        ui.selection.type === "session"
          ? (sessionPaneElement(ui.selection.id)?.querySelector(".session-pane-main") as HTMLElement | null)
          : null;
      (sessionMainRegion || detailElement).focus({ preventScroll: true });
      if (ui.selection.type !== "session") {
        scrollMainListSelectionIntoView();
      }
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

function navigateSidebarItems(direction: number) {
  const items = sidebarNavItems();
  if (!items.length) {
    return;
  }

  const currentIndex = items.findIndex((itemId) => itemId === ui.sidebarNavItem);
  if (currentIndex < 0) {
    const fallbackIndex = direction > 0 ? 0 : items.length - 1;
    const fallbackItemId = items[fallbackIndex];
    if (fallbackItemId === "inbox") {
      void selectInbox("sidebar");
    } else {
      void selectRepo(fallbackItemId, "sidebar");
    }
    return;
  }

  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= items.length) {
    return;
  }

  const nextItemId = items[nextIndex];
  if (nextItemId.startsWith("action:")) {
    ui.sidebarNavItem = nextItemId;
    renderSidebar();
    return;
  }

  if (nextItemId === "inbox") {
    void selectInbox("sidebar");
    return;
  }

  void selectRepo(nextItemId, "sidebar");
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

function navigateMainListSessions(direction: number) {
  const sessions = mainListSessions();
  if (!sessions.length) {
    return;
  }

  const currentIndex = sessions.findIndex((session) => session.id === ui.mainListSessionId);
  if (currentIndex < 0) {
    ui.mainListSessionId = direction > 0 ? sessions[0].id : sessions[sessions.length - 1].id;
    renderDetail();
    return;
  }

  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= sessions.length) {
    return;
  }

  ui.mainListSessionId = sessions[nextIndex].id;
  renderDetail();
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
  const itemId = ui.sidebarNavItem;
  let target: HTMLElement | null = null;

  if (itemId === "inbox") {
    target = sidebarElement.querySelector('[data-action="select-inbox"]') as HTMLElement | null;
  } else if (itemId.startsWith("action:")) {
    const action = itemId.slice("action:".length);
    target = sidebarElement.querySelector(`[data-action="${CSS.escape(action)}"]`) as HTMLElement | null;
  } else {
    target = sidebarElement.querySelector(`[data-repo-id="${CSS.escape(itemId)}"]`) as HTMLElement | null;
  }

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

function scrollMainListSelectionIntoView() {
  if (!ui.mainListSessionId || ui.focusSection !== "main") {
    return;
  }

  const target = detailElement.querySelector(
    `[data-session-id="${CSS.escape(ui.mainListSessionId)}"]`
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

function mainListSelectionMatches(sessionId) {
  return ui.focusSection === "main" && ui.mainListSessionId === sessionId;
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
    case "status":
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 18V13M12 18V8M19 18V5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
          <path d="M4 19.5h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
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
  return !!target.closest(".session-terminal-shell");
}

function isSidebarDrawerTarget(target: HTMLElement) {
  return !!target.closest(".sidebar-project-drawer");
}

async function activateSidebarNavItem() {
  const itemId = ui.sidebarNavItem;
  if (itemId.startsWith("action:")) {
    const action = itemId.slice("action:".length);
    switch (action) {
      case "open-workspace":
        await api.openWorkspaceFolder();
        break;
      case "create-project":
        await api.createProjectFolder();
        break;
      case "open-status":
        await selectStatus("sidebar");
        break;
      case "open-settings":
        await openSettings("general");
        break;
      default:
        break;
    }
    return;
  }

  if (itemId === "inbox") {
    await selectInbox("sidebar");
    return;
  }

  toggleSidebarProjectDrawer(itemId);
}

async function handleTerminalClipboardShortcut(event) {
  const mount = activeTerminalMount();
  if (!mount || terminalClipboardHandled(event)) {
    return false;
  }

  if (ui.focusSection !== "terminal" && !isTerminalKeyboardTarget(event.target)) {
    return false;
  }

  if (isTerminalPasteShortcut(event)) {
    event.preventDefault();
    markTerminalClipboardHandled(event);
    await pasteClipboardIntoTerminal();
    return true;
  }

  if (isTerminalCopyShortcut(event)) {
    event.preventDefault();
    markTerminalClipboardHandled(event);
    const selection = mount.terminal.getSelection?.() || "";
    if (selection) {
      await api.writeClipboardText(selection);
    }
    return true;
  }

  return false;
}

function handleTerminalCustomKeyEvent(event) {
  if (event.type !== "keydown") {
    return true;
  }

  if (!isTerminalCopyShortcut(event) && !isTerminalPasteShortcut(event)) {
    return true;
  }

  if (terminalClipboardHandled(event)) {
    return false;
  }

  void handleTerminalClipboardShortcut(event);
  return false;
}

async function pasteClipboardIntoTerminal() {
  const mount = activeTerminalMount();
  if (!mount) {
    return;
  }

  const text = await api.readClipboardText();
  if (!text) {
    return;
  }

  if (typeof mount.terminal.paste === "function") {
    mount.terminal.paste(text);
    return;
  }

  if (ui.selection.type === "session") {
    await api.sendInput(ui.selection.id, text);
  }
}

function isTerminalKeyboardTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.classList.contains("xterm-helper-textarea") ||
    !!target.closest(".session-terminal-shell") ||
    !!target.closest(".xterm")
  );
}

function markTerminalClipboardHandled(event) {
  (event as KeyboardEvent & { __claudeWorkspaceTerminalClipboardHandled?: boolean }).__claudeWorkspaceTerminalClipboardHandled = true;
}

function terminalClipboardHandled(event) {
  return !!(event as KeyboardEvent & { __claudeWorkspaceTerminalClipboardHandled?: boolean }).__claudeWorkspaceTerminalClipboardHandled;
}

function isTerminalCopyShortcut(event) {
  return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c";
}

function isTerminalPasteShortcut(event) {
  return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "v";
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
