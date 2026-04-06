const api = window.claudeWorkspace;
let sessionSearchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
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
  sizes?: number[];
};

type WorkspaceLayoutNode = WorkspaceLeafNode | WorkspaceSplitNode;

type TerminalMount = {
  terminal: any;
  fitAddon: any;
  resizeObserver: ResizeObserver;
};

type WikiTreeNode = {
  type: "directory" | "file";
  name: string;
  relativePath: string;
  children?: WikiTreeNode[];
};

type FileTreeNode = {
  type: "directory" | "file";
  name: string;
  path: string;
  relativePath: string;
  children?: FileTreeNode[];
};

type SessionSearchResult = {
  source: "claude" | "codex";
  filePath: string;
  sessionId: string | null;
  hydraSessionId?: string | null;
  lineNumber: number | null;
  preview: string;
  title: string;
};

const state = {
  workspaces: [] as any[],
  repos: [] as any[],
  sessions: [] as any[],
  preferences: {} as Record<string, any>,
  lazygitInstalled: false
};

const ui = {
  selection: { type: "inbox", id: null },
  focusSection: "main" as SectionId,
  sidebarExpandedRepoId: null as string | null,
  sidebarNavItem: "inbox" as string,
  mainListSessionId: null as string | null,
  terminalMounts: new Map<string, TerminalMount>(),
  renamingSessionId: null as string | null,
  renamingSessionTitle: "",
  quickSwitcherQuery: "",
  sessionSearchQuery: "",
  sessionSearchRepoId: null as string | null,
  sessionSearchResults: [] as SessionSearchResult[],
  sessionSearchError: "",
  sessionSearchLoading: false,
  sessionSearchSelectedIndex: 0,
  sessionSearchLoadId: 0,
  commandPaletteQuery: "",
  settingsTab: "general",
  settingsContext: null,
  settingsSelectedFilePath: null,
  settingsJsonCategoryId: "",
  settingsEditorText: "",
  settingsSaveMessage: "",
  settingsJsonDraft: null,
  settingsJsonError: "",
  settingsShowRawJson: false,
  portStatusData: null,
  portStatusLoading: false,
  portStatusShowAll: false,
  portStatusPollTimer: null as number | null,
  wikiContextRepoId: null as string | null,
  wikiContext: null as any,
  wikiSelectedPath: null as string | null,
  wikiPreviewMarkdown: "",
  wikiStatusMessage: "",
  wikiLoading: false,
  workspaceStructureSignature: "",
  draggingSessionId: null as string | null,
  draggingSessionSource: null as string | null,
  dragTargetSessionId: null as string | null,
  dragTargetZone: null as WorkspaceDropZone | null,
  fileBrowserRepoId: null as string | null,
  fileBrowserTree: null as FileTreeNode[] | null,
  fileBrowserSelectedPath: null as string | null,
  fileBrowserFileContent: null as string | null,
  fileBrowserFileTooLarge: false,
  fileBrowserLoadingFile: false,
  fileBrowserLoadId: 0,
  fileBrowserLoading: false,
  fileBrowserExpandedDirs: new Set<string>(),
  resizeDragState: null as {
    splitPath: string;
    handleIndex: number;
    axis: WorkspaceSplitAxis;
    startPos: number;
    startSizes: number[];
    containerSize: number;
    splitContainer: HTMLElement | null;
  } | null,
  tokscaleSessionId: null as string | null,
  tokscaleTerminalMount: null as TerminalMount | null,
  tokscaleUnsubOutput: null as (() => void) | null,
  tokscaleUnsubExit: null as (() => void) | null,
  lazygitSessionId: null as string | null,
  lazygitTerminalMount: null as TerminalMount | null,
  lazygitUnsubOutput: null as (() => void) | null,
  lazygitUnsubExit: null as (() => void) | null
};

const sidebarElement = document.getElementById("sidebar") as HTMLElement;
const detailElement = document.getElementById("detail") as HTMLElement;
const appShellElement = document.getElementById("app-shell") as HTMLElement;
const settingsDialog = document.getElementById("settings-dialog") as HTMLDialogElement;
const quickSwitcherDialog = document.getElementById("quick-switcher-dialog") as HTMLDialogElement;
const sessionSearchDialog = document.getElementById("session-search-dialog") as HTMLDialogElement;
const commandPaletteDialog = document.getElementById("command-palette-dialog") as HTMLDialogElement;
const tokscaleDialog = document.getElementById("tokscale-dialog") as HTMLDialogElement;
const lazygitDialog = document.getElementById("lazygit-dialog") as HTMLDialogElement;
const colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

sidebarElement.tabIndex = -1;
detailElement.tabIndex = -1;

type JsonRenderOptions = {
  customLabel?: string;
  allowRemove?: boolean;
  includeJsonToggle?: boolean;
  forceRawEditor?: boolean;
};

type SimplifiedJsonCategory = {
  id: string;
  label: string;
  description: string;
  entries: SimplifiedJsonEntry[];
};

type SimplifiedJsonEntry = {
  label: string;
  path: (string | number)[];
  description: string;
  kind: "primitive" | "string-list" | "summary";
  value?: any;
  summary?: string;
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
document.addEventListener("focusout", handleFocusOut, true);
document.addEventListener("pointerdown", handlePointerDown, true);
document.addEventListener("contextmenu", handleContextMenu, true);
document.addEventListener("keydown", handleKeyDown, true);
document.addEventListener("dragstart", handleDragStart, true);
document.addEventListener("dragend", handleDragEnd, true);
document.addEventListener("dragover", handleDragOver, true);
document.addEventListener("drop", handleDrop, true);
document.addEventListener("pointermove", handlePointerMove);
document.addEventListener("pointerup", handlePointerUp);

tokscaleDialog.addEventListener("cancel", (e) => {
  e.preventDefault();
  closeTokscaleOverlay();
});

lazygitDialog.addEventListener("cancel", (e) => {
  e.preventDefault();
  closeLazygitOverlay();
});

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
    // Update transcript preview in-place to avoid full DOM replacement, which causes
    // button flickering/loss of interactivity while sessions are running.
    const metaEl = detailElement.querySelector<HTMLElement>(
      `[data-session-id="${CSS.escape(payload.sessionId)}"] .row-meta`
    );
    if (metaEl) {
      metaEl.textContent = session.blocker?.summary || previewTranscript(session.transcript);
    }
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

api.onCommand(async ({ command, sessionId, repoId }) => {
  switch (command) {
    case "new-session":
      await startDefaultClaudeSession(repoId || currentRepoId());
      break;
    case "open-wiki":
      await openWiki(repoId || currentRepoId());
      break;
    case "initialize-wiki":
      await initializeWiki(repoId || currentRepoId());
      break;
    case "refresh-wiki":
      await runWikiAgentAction("refresh", repoId || currentRepoId());
      break;
    case "lint-wiki":
      await runWikiAgentAction("lint", repoId || currentRepoId());
      break;
    case "ask-wiki":
      await runWikiAgentAction("ask", repoId || currentRepoId());
      break;
    case "reveal-wiki":
      if (repoId || currentRepoId()) {
        await api.revealWiki(repoId || currentRepoId());
      }
      break;
    case "toggle-wiki":
      await toggleWiki(repoId || currentRepoId());
      break;
    case "quick-switcher":
      openQuickSwitcher();
      break;
    case "search-session-files":
      if (
        isEditableTarget(document.activeElement as HTMLElement | null) ||
        isTerminalKeyboardTarget(document.activeElement)
      ) {
        break;
      }
      openSessionSearch(repoId || currentRepoId() || state.repos[0]?.id || null);
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
    case "open-lazygit":
      await openLazygitOverlay(repoId || currentRepoId());
      break;
    case "open-tokscale":
      await openTokscaleOverlay(repoId || currentRepoId());
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

  if (ui.lazygitTerminalMount) {
    ui.lazygitTerminalMount.terminal.options.theme = buildTerminalTheme();
  }

  if (ui.tokscaleTerminalMount) {
    ui.tokscaleTerminalMount.terminal.options.theme = buildTerminalTheme();
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
  state.lazygitInstalled = !!nextState.lazygitInstalled;
  if (ui.renamingSessionId && !state.sessions.some((session) => session.id === ui.renamingSessionId)) {
    cancelSessionRename();
  }
  syncStoredSessionWorkspaceLayout();
  if (ui.sidebarExpandedRepoId && !repoById(ui.sidebarExpandedRepoId)) {
    ui.sidebarExpandedRepoId = null;
  }
  if (ui.mainListSessionId && !sessionById(ui.mainListSessionId)) {
    ui.mainListSessionId = null;
  }
  if (ui.wikiContextRepoId && !repoById(ui.wikiContextRepoId)) {
    clearWikiState();
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

  if (ui.selection.type === "wiki" && !repoById(ui.selection.id)) {
    clearWikiState();
    ui.selection = { type: "inbox", id: null };
  }

  if (ui.selection.type === "files" && !repoById(ui.selection.id)) {
    ui.selection = { type: "inbox", id: null };
  }

  syncSidebarNavSelection();
  syncMainListSelection();
  normalizeFocusSection();
}

function sidebarSignature() {
  const expandedRepo = expandedSidebarRepo();
  const inboxCount = inboxSessions().length;
  const railSig = state.repos.map((repo) => {
    const sessions = sessionsForRepo(repo.id);
    return `${repo.id}:${sessions.filter((s) => s.runtimeState === "live").length}:${sessions.filter((s) => s.blocker || s.unreadCount > 0).length}`;
  }).join(",");
  const drawerSig = expandedRepo
    ? sessionsForRepo(expandedRepo.id).map((s) =>
        `${s.id}:${s.title}:${s.status}:${s.unreadCount}:${previewTranscript(s.transcript)}`
      ).join(",")
    : "";
  const selSig = `${ui.selection.type}:${(ui.selection as any).id ?? ""}`;
  return `${inboxCount}|${railSig}|${drawerSig}|${selSig}|${ui.sidebarNavItem}|${ui.sidebarExpandedRepoId}`;
}

function renderSidebar() {
  const sig = sidebarSignature();
  if (sidebarElement.dataset.sig === sig) {
    syncSectionFocusUi();
    return;
  }
  sidebarElement.dataset.sig = sig;

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
          <button class="sidebar-rail-button sidebar-utility-button ${sidebarNavMatches(sidebarActionNavId("open-workspace")) ? "keyboard-active" : ""}" data-action="open-workspace" data-tooltip="Add Folder" title="Add Folder" aria-label="Add Folder">
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
    return `<div class="sidebar-rail-empty" data-tooltip="Add a folder to start">?</div>`;
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
      <div class="detail-actions">
        <button data-action="browse-files" data-repo-id="${repo.id}">Files</button>
        <button data-action="open-wiki" data-repo-id="${repo.id}">Wiki</button>
        <button data-action="toggle-wiki" data-repo-id="${repo.id}">${repo.wikiEnabled ? "Disable" : "Enable"}</button>
        <button class="primary" data-action="open-launcher" data-repo-id="${repo.id}">New Session</button>
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

  if (ui.selection.type === "wiki") {
    destroyTerminal();
    renderWikiDetail(repoById(ui.selection.id));
    return;
  }

  if (ui.selection.type === "session") {
    renderSessionDetail(sessionById(ui.selection.id));
    return;
  }

  if (ui.selection.type === "files") {
    destroyTerminal();
    renderFilesDetail(repoById(ui.selection.id));
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
          <button data-action="open-wiki" ${currentRepoId() ? "" : "disabled"}>Open Wiki</button>
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
    detailElement.innerHTML = `<div class="empty-state">This folder is no longer available.</div>`;
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
          <div class="eyebrow">Folder</div>
          <h1 class="detail-title">${escapeHtml(repo.name)}</h1>
          <div class="muted">${escapeHtml(abbreviateHome(repo.path))}</div>
        </div>
        <div class="detail-actions">
          <button data-action="reveal-repo" data-repo-id="${repo.id}">Reveal Folder</button>
          <button data-action="rescan-workspace" data-workspace-id="${repo.workspaceID}">Refresh Folder</button>
          <button data-action="browse-files" data-repo-id="${repo.id}">Browse Files</button>
          <button data-action="open-tokscale" data-repo-id="${repo.id}">Token Usage</button>
          <button data-action="open-wiki" data-repo-id="${repo.id}">Open Wiki</button>
          <button data-action="toggle-wiki" data-repo-id="${repo.id}">${repo.wikiEnabled ? "Disable Wiki" : "Enable Wiki"}</button>
          <button class="primary" data-action="open-launcher" data-repo-id="${repo.id}">New Session</button>
        </div>
      </div>
      ${
        sessions.length
          ? `<div class="repo-session-list">${sessions.map((session) => renderRepoSession(session, repo)).join("")}</div>`
          : `<div class="empty-state">Start a shell session for this folder.</div>`
      }
    </section>
  `;

  syncSectionFocusUi();
}

function renderWikiDetail(repo) {
  if (!repo) {
    detailElement.innerHTML = `<div class="empty-state">This folder is no longer available.</div>`;
    syncSectionFocusUi();
    return;
  }

  const wikiContext = ui.wikiContextRepoId === repo.id ? ui.wikiContext : null;

  detailElement.innerHTML = `
    <section class="detail-panel">
      <div class="detail-hero">
        <div>
          <div class="eyebrow">Wiki</div>
          <h1 class="detail-title">${escapeHtml(repo.name)}</h1>
          <div class="muted">${escapeHtml(abbreviateHome(repo.wikiPath || `${repo.path}/.wiki`))}</div>
        </div>
        <div class="detail-actions">
          <button data-action="toggle-wiki" data-repo-id="${repo.id}">${repo.wikiEnabled ? "Disable Wiki" : "Enable Wiki"}</button>
          <button data-action="reveal-wiki" data-repo-id="${repo.id}">Reveal .wiki</button>
          <button data-action="reload-wiki" data-repo-id="${repo.id}" ${repo.wikiEnabled ? "" : "disabled"}>Reload Files</button>
          <button data-action="refresh-wiki" data-repo-id="${repo.id}" ${repo.wikiEnabled ? "" : "disabled"}>Refresh Wiki</button>
          <button data-action="lint-wiki" data-repo-id="${repo.id}" ${repo.wikiEnabled ? "" : "disabled"}>Lint Wiki</button>
          <button data-action="ask-wiki" data-repo-id="${repo.id}" ${repo.wikiEnabled ? "" : "disabled"}>Ask Wiki</button>
        </div>
      </div>
      ${
        ui.wikiStatusMessage
          ? `<div class="settings-save-message">${escapeHtml(ui.wikiStatusMessage)}</div>`
          : ""
      }
      ${
        !repo.wikiEnabled
          ? `
            <div class="empty-state wiki-empty-state">
              <div>
                <div class="row-title">Wiki is disabled for this folder.</div>
                <div class="row-subtitle">Enable it to patch the project instruction file and let agents maintain durable knowledge in <span class="mono">.wiki/</span>.</div>
              </div>
            </div>
          `
          : ui.wikiLoading && !wikiContext
            ? `<div class="empty-state wiki-empty-state">Loading wiki files...</div>`
            : !wikiContext?.exists
              ? `
                <div class="empty-state wiki-empty-state">
                  <div>
                    <div class="row-title">The wiki is enabled, but no files exist yet.</div>
                    <div class="row-subtitle">Agents can create narrow, high-signal pages under <span class="mono">.wiki/</span> as they finish meaningful work.</div>
                  </div>
                </div>
              `
              : `
                <div class="wiki-layout">
                  <aside class="wiki-tree-panel">
                    <div class="wiki-panel-header">
                      <div>
                        <div class="row-title">Files</div>
                        <div class="row-subtitle">${flattenWikiFiles(wikiContext.tree || []).length} tracked ${pluralize(flattenWikiFiles(wikiContext.tree || []).length, "file", "files")}</div>
                      </div>
                    </div>
                    <div class="wiki-tree-scroll">
                      ${renderWikiTree(repo.id, wikiContext.tree || [])}
                    </div>
                  </aside>
                  <article class="wiki-preview-panel">
                    ${renderWikiPreview()}
                  </article>
                </div>
              `
      }
    </section>
  `;

  syncSectionFocusUi();
}

function renderWikiTree(repoId, nodes: WikiTreeNode[]) {
  if (!nodes.length) {
    return `<div class="sidebar-project-drawer-empty">No wiki files yet.</div>`;
  }

  return nodes.map((node) => renderWikiTreeNode(repoId, node, 0)).join("");
}

function renderWikiTreeNode(repoId, node: WikiTreeNode, depth: number) {
  if (node.type === "directory") {
    return `
      <div class="wiki-tree-group" style="--wiki-depth:${depth}">
        <div class="wiki-tree-group-label">${escapeHtml(node.name)}</div>
        <div class="wiki-tree-group-children">
          ${(node.children || []).map((child) => renderWikiTreeNode(repoId, child, depth + 1)).join("")}
        </div>
      </div>
    `;
  }

  return `
    <button
      type="button"
      class="wiki-tree-file ${ui.wikiSelectedPath === node.relativePath ? "active" : ""}"
      data-action="wiki-select-file"
      data-repo-id="${repoId}"
      data-wiki-path="${escapeAttribute(node.relativePath)}"
      style="--wiki-depth:${depth}">
      <span class="wiki-tree-file-name">${escapeHtml(node.name)}</span>
      <span class="wiki-tree-file-path">${escapeHtml(node.relativePath)}</span>
    </button>
  `;
}

function renderWikiPreview() {
  if (!ui.wikiSelectedPath) {
    return `
      <div class="wiki-preview-empty">
        <div class="row-title">Select a wiki file</div>
        <div class="row-subtitle">The preview renders Markdown and keeps raw sources readable without leaving the app.</div>
      </div>
    `;
  }

  return `
    <div class="wiki-panel-header">
      <div>
        <div class="row-title">${escapeHtml(pathLabel(ui.wikiSelectedPath))}</div>
        <div class="row-subtitle mono">${escapeHtml(ui.wikiSelectedPath)}</div>
      </div>
    </div>
    <div class="wiki-preview-markdown markdown-body">
      ${renderMarkdownDocument(ui.wikiPreviewMarkdown)}
    </div>
  `;
}

function renderFilesDetail(repo) {
  if (!repo) {
    detailElement.innerHTML = `<div class="empty-state">This folder is no longer available.</div>`;
    syncSectionFocusUi();
    return;
  }

  const fileTree = ui.fileBrowserRepoId === repo.id ? ui.fileBrowserTree : null;
  const flatFiles = fileTree ? flattenFileTreeNodes(fileTree) : [];

  detailElement.innerHTML = `
    <section class="detail-panel">
      <div class="detail-hero">
        <div>
          <div class="eyebrow">Files</div>
          <h1 class="detail-title">${escapeHtml(repo.name)}</h1>
          <div class="muted">${escapeHtml(abbreviateHome(repo.path))}</div>
        </div>
        <div class="detail-actions">
          <button data-action="files-reload" data-repo-id="${repo.id}" ${ui.fileBrowserLoading ? "disabled" : ""}>${ui.fileBrowserLoading ? "Loading..." : "Reload"}</button>
          <button data-action="reveal-repo" data-repo-id="${repo.id}">Reveal in Finder</button>
          <button class="primary" data-action="open-launcher" data-repo-id="${repo.id}">New Session</button>
        </div>
      </div>
      ${
        ui.fileBrowserLoading && !fileTree
          ? `<div class="empty-state">Reading directory...</div>`
          : !fileTree
            ? `<div class="empty-state">No directory data. Click Reload to scan files.</div>`
            : `
              <div class="files-layout">
                <aside class="files-tree-panel">
                  <div class="files-panel-header">
                    <div class="row-title">Directory</div>
                    <div class="row-subtitle">${flatFiles.length} ${pluralize(flatFiles.length, "file", "files")}</div>
                  </div>
                  <div class="files-tree-scroll">
                    ${renderFileTree(repo.id, fileTree)}
                  </div>
                </aside>
                <article class="files-content-panel">
                  ${renderFileContentPane()}
                </article>
              </div>
            `
      }
    </section>
  `;

  syncSectionFocusUi();
}

function renderFileTree(repoId: string, nodes: FileTreeNode[]): string {
  if (!nodes.length) {
    return `<div class="files-tree-empty">No files found.</div>`;
  }
  return nodes.map((node) => renderFileTreeNode(repoId, node, 0)).join("");
}

function renderFileTreeNode(repoId: string, node: FileTreeNode, depth: number): string {
  if (node.type === "directory") {
    const isExpanded = ui.fileBrowserExpandedDirs.has(node.relativePath);
    return `
      <div class="fb-dir-group">
        <button
          type="button"
          class="fb-dir-row ${isExpanded ? "fb-dir-open" : ""}"
          data-action="files-toggle-dir"
          data-repo-id="${escapeAttribute(repoId)}"
          data-dir-path="${escapeAttribute(node.relativePath)}"
          style="--fb-depth:${depth}">
          <span class="fb-chevron" aria-hidden="true"></span>
          <span class="fb-dir-name">${escapeHtml(node.name)}</span>
        </button>
        ${isExpanded && node.children?.length ? `
          <div class="fb-dir-children">
            ${node.children.map((child) => renderFileTreeNode(repoId, child, depth + 1)).join("")}
          </div>
        ` : ""}
      </div>
    `;
  }

  return `
    <button
      type="button"
      class="fb-file-row ${ui.fileBrowserSelectedPath === node.path ? "active" : ""} ${fileExtClass(node.name)}"
      data-action="files-select-file"
      data-repo-id="${escapeAttribute(repoId)}"
      data-file-path="${escapeAttribute(node.path)}"
      style="--fb-depth:${depth}">
      <span class="fb-file-dot" aria-hidden="true"></span>
      <span class="fb-file-name">${escapeHtml(node.name)}</span>
    </button>
  `;
}

function renderFileContentPane(): string {
  if (!ui.fileBrowserSelectedPath) {
    return `
      <div class="files-content-empty">
        <div class="row-title">Select a file</div>
        <div class="row-subtitle">Click any file in the tree to preview its contents here.</div>
      </div>
    `;
  }

  const name = ui.fileBrowserSelectedPath.split("/").pop() || ui.fileBrowserSelectedPath;

  if (ui.fileBrowserFileTooLarge) {
    return `
      <div class="files-panel-header">
        <div>
          <div class="row-title">${escapeHtml(name)}</div>
          <div class="row-subtitle mono">${escapeHtml(ui.fileBrowserSelectedPath)}</div>
        </div>
        <button data-action="files-reveal-file" data-file-path="${escapeAttribute(ui.fileBrowserSelectedPath)}">Reveal</button>
      </div>
      <div class="files-content-empty">
        <div class="row-title">File is too large to preview</div>
        <div class="row-subtitle">Open it in your editor instead.</div>
      </div>
    `;
  }

  if (ui.fileBrowserFileContent === null) {
    const body = ui.fileBrowserLoadingFile
      ? `<div class="row-title">Loading…</div>`
      : `<div class="row-title">Cannot preview this file</div>
         <div class="row-subtitle">It may be binary or permission-restricted.</div>`;
    return `
      <div class="files-panel-header">
        <div>
          <div class="row-title">${escapeHtml(name)}</div>
        </div>
      </div>
      <div class="files-content-empty">${body}</div>
    `;
  }

  const lineCount = (ui.fileBrowserFileContent.match(/\n/g) || []).length + 1;

  return `
    <div class="files-panel-header">
      <div>
        <div class="row-title">${escapeHtml(name)}</div>
        <div class="row-subtitle mono">${escapeHtml(ui.fileBrowserSelectedPath)}</div>
      </div>
      <div class="files-header-meta">
        <span class="files-line-count">${lineCount} ${pluralize(lineCount, "line", "lines")}</span>
        <button data-action="files-reveal-file" data-file-path="${escapeAttribute(ui.fileBrowserSelectedPath)}">Reveal</button>
      </div>
    </div>
    <div class="files-content-scroll">
      <pre class="files-content-pre"><code>${escapeHtml(ui.fileBrowserFileContent)}</code></pre>
    </div>
  `;
}

function fileExtClass(name: string): string {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const map: Record<string, string> = {
    ts: "fb-ext-ts", tsx: "fb-ext-ts", mts: "fb-ext-ts", cts: "fb-ext-ts",
    js: "fb-ext-js", jsx: "fb-ext-js", mjs: "fb-ext-js", cjs: "fb-ext-js",
    md: "fb-ext-md", mdx: "fb-ext-md",
    json: "fb-ext-json", jsonc: "fb-ext-json",
    yaml: "fb-ext-yaml", yml: "fb-ext-yaml",
    py: "fb-ext-py", pyw: "fb-ext-py",
    css: "fb-ext-css", scss: "fb-ext-css", sass: "fb-ext-css", less: "fb-ext-css",
    html: "fb-ext-html", htm: "fb-ext-html",
    sh: "fb-ext-sh", bash: "fb-ext-sh", zsh: "fb-ext-sh",
    rs: "fb-ext-rs",
    go: "fb-ext-go",
    rb: "fb-ext-rb",
    java: "fb-ext-java", kt: "fb-ext-java",
    swift: "fb-ext-swift",
    c: "fb-ext-c", cpp: "fb-ext-c", h: "fb-ext-c", cc: "fb-ext-c"
  };
  return map[ext] || "";
}

async function openFilesBrowser(repoId: string) {
  if (!repoId) return;

  if (ui.fileBrowserRepoId !== repoId) {
    ui.fileBrowserExpandedDirs.clear();
    ui.fileBrowserSelectedPath = null;
    ui.fileBrowserFileContent = null;
    ui.fileBrowserFileTooLarge = false;
    ui.fileBrowserLoadingFile = false;
    ui.fileBrowserLoadId++;
  }

  ui.selection = { type: "files", id: repoId };
  ui.sidebarExpandedRepoId = repoId;
  ui.sidebarNavItem = repoId;
  syncMainListSelection();
  normalizeFocusSection();
  await api.setFocusedSession(null);
  renderSidebar();
  renderDetail();
  await loadFileBrowserTree(repoId);
}

async function loadFileBrowserTree(repoId: string) {
  if (!repoId) return;

  ui.fileBrowserLoading = true;
  ui.fileBrowserRepoId = repoId;
  if (ui.selection.type === "files" && ui.selection.id === repoId) {
    renderDetail();
  }

  try {
    const result = await api.readDirectory(repoId);
    ui.fileBrowserTree = result?.tree || null;
  } catch {
    ui.fileBrowserTree = null;
  } finally {
    ui.fileBrowserLoading = false;
    if (ui.selection.type === "files" && ui.selection.id === repoId) {
      renderDetail();
    }
  }
}

async function selectFileBrowserFile(filePath: string) {
  if (!filePath) return;

  const loadId = ++ui.fileBrowserLoadId;
  ui.fileBrowserSelectedPath = filePath;
  ui.fileBrowserFileContent = null;
  ui.fileBrowserFileTooLarge = false;
  ui.fileBrowserLoadingFile = true;
  if (ui.selection.type === "files") renderDetail();

  try {
    const result = await api.readFile(filePath);
    if (ui.fileBrowserLoadId !== loadId) return;
    if (result.tooLarge) {
      ui.fileBrowserFileTooLarge = true;
    } else if (!result.error) {
      ui.fileBrowserFileContent = result.content;
    }
  } catch {
  } finally {
    if (ui.fileBrowserLoadId === loadId) ui.fileBrowserLoadingFile = false;
  }

  if (ui.fileBrowserLoadId === loadId && ui.selection.type === "files") renderDetail();
}

function flattenFileTreeNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.flatMap((node) => {
    if (node.type === "file") return [node];
    return flattenFileTreeNodes(node.children || []);
  });
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
  const signature = workspaceLayoutStructureSignature(layout);

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

function renderSessionWorkspaceLayoutNode(node: WorkspaceLayoutNode, path = "") {
  if (!node) {
    return "";
  }

  if (node.type === "leaf") {
    return renderSessionPane(node.sessionId);
  }

  const sizes = node.sizes && node.sizes.length === node.children.length
    ? node.sizes
    : node.children.map(() => 1);

  const parts: string[] = [];
  node.children.forEach((child, i) => {
    if (i > 0) {
      parts.push(`<div class="pane-resize-handle pane-resize-handle-${node.axis}" data-split-path="${escapeAttribute(path)}" data-handle-index="${i - 1}"></div>`);
    }
    const childPath = path ? `${path}.${i}` : `${i}`;
    parts.push(`<div class="split-child" style="flex: ${sizes[i]} 1 0%; min-width: 0; min-height: 0;">${renderSessionWorkspaceLayoutNode(child, childPath)}</div>`);
  });

  return `
    <div class="session-workspace-split session-workspace-split-${node.axis}" data-split-path="${escapeAttribute(path)}">
      ${parts.join("")}
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

  const sig = `${session.id}|${session.title}|${session.runtimeState}|${visibleSessionCount}|${repo?.id}`;
  if (toolbar.dataset.sig === sig) {
    return;
  }
  toolbar.dataset.sig = sig;

  toolbar.innerHTML = `
    <div class="ws-toolbar">
      <div class="ws-toolbar-info">
        <span class="ws-toolbar-title">${escapeHtml(session.title)}</span>
        <span class="ws-toolbar-sep">/</span>
        <span class="ws-toolbar-repo">${escapeHtml(repo?.name || "Unknown")}</span>
        <span class="ws-toolbar-meta">${visibleSessionCount} ${pluralize(visibleSessionCount, "pane", "panes")}</span>
      </div>
      <div class="ws-toolbar-actions">
        <div class="ws-layout-group" role="group" aria-label="Layout">
          <button class="ws-layout-btn" data-action="workspace-layout-columns" title="Side by side">Cols</button>
          <button class="ws-layout-btn" data-action="workspace-layout-stack" title="Stacked vertically">Stack</button>
          <button class="ws-layout-btn" data-action="workspace-layout-grid" title="2x2 Grid" ${visibleSessionCount > 1 ? "" : "disabled"}>Grid</button>
        </div>
        <button class="ws-action-btn primary" data-action="open-launcher" data-repo-id="${repo?.id || ""}">+ Session</button>
        <button class="ws-action-btn" data-action="open-wiki" data-repo-id="${repo?.id || ""}">Wiki</button>
        <button class="ws-action-btn" data-action="open-tokscale" data-repo-id="${repo?.id || ""}">Tokens</button>
        <button class="ws-action-btn" data-action="open-lazygit" data-repo-id="${repo?.id || ""}">Git</button>
        <button class="ws-action-btn" data-action="open-settings" data-settings-tab="claude">Agent Files</button>
        ${
          session.runtimeState !== "live"
            ? `<button class="ws-action-btn primary" data-action="restart-session" data-session-id="${session.id}">${escapeHtml(resumeSessionActionLabel(session))}</button>`
            : ""
        }
        <button class="ws-action-btn ws-action-danger" data-action="close-session" data-session-id="${session.id}">End</button>
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

  const header = pane.querySelector(".session-pane-header") as HTMLElement | null;
  const blockerElement = pane.querySelector(".session-pane-blocker") as HTMLElement | null;
  const pausedNotice = pane.querySelector(".session-pane-paused-notice") as HTMLElement | null;
  const terminalWrap = pane.querySelector(".session-pane-terminal-wrap") as HTMLElement | null;

  if (!header || !blockerElement || !pausedNotice || !terminalWrap) {
    return;
  }

  pane.classList.toggle("session-pane-active", selectionMatches("session", session.id));
  terminalWrap.classList.toggle("session-pane-terminal-wrap-paused", session.runtimeState !== "live");

  const isRenaming = ui.renamingSessionId === session.id;
  const headerSig = `${session.title}|${session.status}|${session.runtimeState}|${isRenaming}`;
  if (header.dataset.sig !== headerSig) {
    header.dataset.sig = headerSig;
    header.innerHTML = `
    <div class="pane-bar" ${isRenaming ? "" : `draggable="true" data-drag-session-id="${session.id}" data-drag-source="pane" title="Drag to reorder"`}>
      <div class="pane-bar-left">
        <span class="pane-grip" aria-hidden="true">\u2801\u2801\u2801</span>
        ${
          isRenaming
            ? `<input
                class="pane-title-input"
                type="text"
                value="${escapeAttribute(ui.renamingSessionTitle)}"
                data-session-rename-input="true"
                data-session-id="${session.id}"
                aria-label="Rename session" />`
            : `<span class="pane-title">${escapeHtml(session.title)}</span>`
        }
        <span class="status-badge status-${escapeHtml(session.status)}">${escapeHtml(statusLabel(session.status))}</span>
      </div>
      <div class="pane-bar-right">
        ${
          isRenaming
            ? `<button class="pane-action-btn" data-action="cancel-session-rename" data-session-id="${session.id}" data-no-drag="true" title="Cancel rename">Cancel</button>`
            : `<button class="pane-action-btn" data-action="start-session-rename" data-session-id="${session.id}" data-no-drag="true" title="Rename tab">Rename</button>`
        }
        ${
          session.runtimeState !== "live"
            ? `<button class="pane-action-btn primary" data-action="restart-session" data-session-id="${session.id}">${escapeHtml(resumeSessionActionLabel(session))}</button>`
            : ""
        }
        <button class="pane-action-btn pane-hide-btn" data-action="remove-session-pane" data-session-id="${session.id}" data-no-drag="true" title="Hide pane">&times;</button>
      </div>
    </div>
  `;
  }

  if (isRenaming) {
    requestAnimationFrame(() => {
      const input = pane.querySelector("[data-session-rename-input]") as HTMLInputElement | null;
      if (!input || document.activeElement === input) {
        return;
      }
      input.focus();
      input.select();
    });
  }

  const blockerHtml = renderSessionBlocker(session);
  if (blockerElement.dataset.sig !== blockerHtml) {
    blockerElement.dataset.sig = blockerHtml;
    blockerElement.innerHTML = blockerHtml;
  }

  const pausedHtml = renderPausedSessionNotice(session);
  if (pausedNotice.dataset.sig !== pausedHtml) {
    pausedNotice.dataset.sig = pausedHtml;
    pausedNotice.innerHTML = pausedHtml;
  }
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

function startSessionRename(sessionId) {
  const session = sessionById(sessionId);
  if (!session) {
    return;
  }

  ui.renamingSessionId = session.id;
  ui.renamingSessionTitle = session.title || "";
  updateSessionWorkspaceToolbar();
  updateSessionPane(session);
}

function cancelSessionRename() {
  const sessionId = ui.renamingSessionId;
  ui.renamingSessionId = null;
  ui.renamingSessionTitle = "";

  if (!sessionId) {
    return;
  }

  const session = sessionById(sessionId);
  if (session) {
    updateSessionWorkspaceToolbar();
    updateSessionPane(session);
  }
}

async function commitSessionRename(sessionId) {
  if (!sessionId || ui.renamingSessionId !== sessionId) {
    return;
  }

  const session = sessionById(sessionId);
  const nextTitle = ui.renamingSessionTitle.trim();

  if (!session || !nextTitle || nextTitle === session.title) {
    cancelSessionRename();
    return;
  }

  ui.renamingSessionId = null;
  ui.renamingSessionTitle = "";
  await api.renameSession(sessionId, nextTitle);
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
  renderQuickSwitcherDialog();
  renderSessionSearchDialog();
  renderCommandPaletteDialog();
  if (settingsDialog.open) {
    renderSettingsDialog();
  }
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
      <input id="quick-switcher-query" placeholder="Search sessions or folders" value="${escapeAttribute(ui.quickSwitcherQuery)}" />
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
        <div class="section-label">Folders</div>
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
    { id: "open-workspace", label: "Open Folder", action: "open-workspace" },
    { id: "create-project", label: "Create Folder", action: "create-project" },
    { id: "open-launcher", label: "New Session", action: "open-launcher" },
    { id: "open-session-search", label: "Search Session Files", action: "open-session-search" },
    { id: "open-wiki", label: "Open Wiki", action: "open-wiki" },
    { id: "initialize-wiki", label: "Initialize Wiki", action: "initialize-wiki" },
    { id: "refresh-wiki", label: "Refresh Wiki", action: "refresh-wiki" },
    { id: "lint-wiki", label: "Lint Wiki", action: "lint-wiki" },
    { id: "ask-wiki", label: "Ask Wiki", action: "ask-wiki" },
    { id: "reveal-wiki", label: "Reveal .wiki", action: "reveal-wiki" },
    { id: "open-status", label: "Open Dev Port Status", action: "open-status" },
    { id: "open-settings", label: "Open Settings", action: "open-settings" },
    { id: "open-quick-switcher", label: "Open Quick Switcher", action: "open-quick-switcher" },
    { id: "open-tokscale", label: "Open Token Usage", action: "open-tokscale" },
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

function renderSessionSearchDialog() {
  const repo = repoById(ui.sessionSearchRepoId || "");
  const selectedResult = selectedSessionSearchResult();
  const body = renderSessionSearchBody();

  sessionSearchDialog.innerHTML = `
    <form method="dialog" class="dialog-body">
      <div class="dialog-header">
        <div>
          <div class="eyebrow">Session Search</div>
          <h2 class="dialog-title">Search Claude and Codex session files</h2>
          <div class="muted">${escapeHtml(repo ? abbreviateHome(repo.path) : "Select a project to search its session files.")}</div>
        </div>
        <button value="cancel">Close</button>
      </div>
      <input id="session-search-query" placeholder="Search this project's Claude and Codex sessions" value="${escapeAttribute(ui.sessionSearchQuery)}" />
      <div class="dialog-panel">
        <div class="section-label" style="display:flex;align-items:center;justify-content:space-between;">
          <span>Matches</span>
          ${ui.sessionSearchResults.length > 0 ? `<span class="session-search-kbd-hint"><span class="session-search-kbd">↑</span><span class="session-search-kbd">↓</span> navigate &nbsp;<span class="session-search-kbd">↵</span> open</span>` : ""}
        </div>
        <div class="dialog-list session-search-list">${body}</div>
      </div>
      ${
        selectedResult
          ? `
            <div class="dialog-footer">
              <button type="button" data-action="reveal-session-search-result" data-result-index="${ui.sessionSearchSelectedIndex}">Reveal File</button>
              ${selectedResult.source === "claude" && selectedResult.sessionId ? `<button type="button" class="primary" data-action="resume-session-search-result" data-result-index="${ui.sessionSearchSelectedIndex}">Resume from here</button>` : ""}
            </div>
          `
          : ""
      }
    </form>
  `;
}

function renderSessionSearchBody() {
  if (!ui.sessionSearchRepoId) {
    return `<div class="empty-state">Open or select a project first.</div>`;
  }

  if (ui.sessionSearchError) {
    return `<div class="empty-state">${escapeHtml(ui.sessionSearchError)}</div>`;
  }

  if (!ui.sessionSearchQuery.trim()) {
    return `<div class="empty-state">Type to search only this project's Claude and Codex session files.</div>`;
  }

  if (ui.sessionSearchLoading) {
    return `<div class="session-search-loading-state"><div class="session-search-spinner"></div>Searching session files…</div>`;
  }

  if (!ui.sessionSearchResults.length) {
    return `<div class="empty-state">No matching session content found for this project.</div>`;
  }

  return ui.sessionSearchResults
    .map((result, index) => {
      const sourceLabel = result.source === "claude" ? "Claude" : "Codex";
      const normalizedPreview = normalizeJsonlPreview(result.preview);
      const canResume = result.source === "claude" && result.sessionId;
      const shortId = result.sessionId ? result.sessionId.slice(0, 8) : null;
      return `
        <div
          class="session-search-row ${index === ui.sessionSearchSelectedIndex ? "active" : ""}"
          data-action="select-session-search-result"
          data-result-index="${index}"
        >
          <div class="row-title">
            <span>${escapeHtml(result.title)}</span>
            <span class="session-search-source session-search-source-${escapeHtml(result.source)}">${escapeHtml(sourceLabel)}</span>
          </div>
          <div class="row-subtitle mono">${shortId ? escapeHtml(shortId) + " · " : ""}${escapeHtml(pathLeafLabel(result.filePath))}:${escapeHtml(String(result.lineNumber || 1))}</div>
          <div class="row-meta">${escapeHtml(normalizedPreview)}</div>
          <div class="session-search-actions">
            <button type="button" data-action="reveal-session-search-result" data-result-index="${index}">Reveal</button>
            ${canResume ? `<button type="button" class="primary" data-action="resume-session-search-result" data-result-index="${index}">Resume from here</button>` : ""}
          </div>
        </div>
      `;
    })
    .join("");
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
          <h2 class="dialog-title">Preferences and agent files</h2>
          <div class="muted">Edit app preferences, project instructions, and JSON settings in a format people can actually read.</div>
        </div>
        <button value="cancel">Close</button>
      </div>

      <div class="settings-tabs">
        <button type="button" class="settings-tab ${ui.settingsTab === "general" ? "active" : ""}" data-action="settings-tab" data-tab="general">General</button>
        <button type="button" class="settings-tab ${ui.settingsTab === "claude" ? "active" : ""}" data-action="settings-tab" data-tab="claude">Agent Files</button>
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
    <div class="settings-shell">
      <div class="settings-sidebar">
        <div class="settings-sidebar-sections">
          ${
            globalFiles.length
              ? `
                <div class="section-label">Global</div>
                ${globalFiles.map((file) => renderSettingsFileRow(file)).join("")}
              `
              : ""
          }
          ${
            projectFiles.length
              ? `
                <div class="section-label">Project${projectRepo ? ` · ${escapeHtml(projectRepo.name)}` : ""}</div>
                ${projectFiles.map((file) => renderSettingsFileRow(file)).join("")}
              `
              : ""
          }
          ${
            !globalFiles.length && !projectFiles.length
              ? `<div class="settings-sidebar-empty">No agent files are available yet.</div>`
              : ""
          }
        </div>
      </div>

      <div class="settings-detail-panel">
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
      ${renderSettingsFileSummaryCard(selectedFile, [
        renderSettingsMetaPill("Markdown"),
        renderSettingsMetaPill(selectedFile.exists ? "Ready" : "Create on Save"),
        renderSettingsMetaPill(selectedFile.scope === "global" ? "Global" : "Project")
      ])}

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
  const effectiveCount = context.resolvedValues.filter(
    (value) => value.sourceLabel === selectedFile.title
  ).length;

  return `
    <div class="settings-surface">
      ${renderSettingsFileSummaryCard(selectedFile, [
        renderSettingsMetaPill(showRawEditor ? "Raw JSON" : "Form View"),
        renderSettingsMetaPill(`${effectiveCount} Effective`),
        renderSettingsMetaPill(selectedFile.exists ? "Ready" : "Create on Save")
      ], { includeJsonToggle: true, forceRawEditor })}

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
  const categories = buildSimplifiedJsonCategories(currentValue);
  const activeCategory = activeSimplifiedJsonCategory(categories);

  return `
    <div class="settings-editor-card">
      <div class="settings-help-row">
        <div>
          <div class="row-title">Guided Settings</div>
          <div class="muted">Use the straightforward categories here for common edits. Switch to JSON for custom shapes or deeply nested values.</div>
        </div>
        <span class="settings-chip">Form View</span>
      </div>

      ${
        isJsonObject(currentValue)
          ? `
            <div class="settings-guided-layout">
              ${renderSimplifiedJsonCategoryNav(categories, activeCategory)}
              ${
                activeCategory
                  ? renderSimplifiedJsonCategoryPanel(activeCategory)
                  : `<div class="settings-guided-panel"><div class="settings-empty-note">No guided settings are available yet. Use JSON to define the initial structure.</div></div>`
              }
            </div>
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

function renderSimplifiedJsonCategoryNav(categories: SimplifiedJsonCategory[], activeCategory: SimplifiedJsonCategory | null) {
  return `
    <div class="settings-guided-nav">
      ${categories.map((category) => `
        <button
          type="button"
          class="settings-guided-nav-button ${activeCategory?.id === category.id ? "active" : ""}"
          data-action="settings-select-json-category"
          data-category-id="${escapeAttribute(category.id)}">
          <div class="row-title">${escapeHtml(category.label)}</div>
          <div class="row-meta">${escapeHtml(category.description)}</div>
        </button>
      `).join("")}
    </div>
  `;
}

function renderSimplifiedJsonCategoryPanel(category: SimplifiedJsonCategory) {
  return `
    <div class="settings-guided-panel">
      <div class="settings-guided-panel-header">
        <div>
          <div class="row-title">${escapeHtml(category.label)}</div>
          <div class="muted">${escapeHtml(category.description)}</div>
        </div>
      </div>
      ${
        category.entries.length
          ? `<div class="settings-field-stack">${category.entries.map((entry) => renderSimplifiedJsonEntry(entry)).join("")}</div>`
          : `<div class="settings-empty-note">Nothing in this section is editable in the guided view yet. Use JSON for custom changes.</div>`
      }
      ${category.id === "general" ? renderRootAddSettingCard() : ""}
    </div>
  `;
}

function renderSimplifiedJsonEntry(entry: SimplifiedJsonEntry) {
  const encodedPath = encodeSettingPath(entry.path);
  const pathText = formatSettingPath(entry.path);

  if (entry.kind === "summary") {
    return `
      <div class="settings-summary-card">
        <div class="settings-file-row-top">
          <div class="row-title">${escapeHtml(entry.label)}</div>
          <span class="settings-chip">JSON Only</span>
        </div>
        <div class="row-subtitle mono">${escapeHtml(pathText)}</div>
        <div class="row-meta">${escapeHtml(entry.summary || entry.description)}</div>
        <div class="settings-meta-row">
          <button type="button" data-action="settings-toggle-raw-json">Edit in JSON</button>
        </div>
      </div>
    `;
  }

  const controlMarkup = entry.kind === "string-list"
    ? `
      <textarea
        class="settings-field-textarea settings-list-editor"
        data-setting-editor="string-list"
        data-setting-path="${encodedPath}">${escapeHtml(formatStringListEditorValue(entry.value))}</textarea>
      <div class="row-meta">Enter one value per line.</div>
    `
    : renderSimplifiedPrimitiveControl(entry, encodedPath);

  return `
    <div class="settings-field-card settings-field-card-simple">
      <div class="settings-field-copy">
        <div class="settings-file-row-top">
          <div class="row-title">${escapeHtml(entry.label)}</div>
          <span class="settings-chip">${escapeHtml(entry.kind === "string-list" ? "List" : jsonValueTypeLabel(entry.value))}</span>
        </div>
        <div class="row-subtitle mono">${escapeHtml(pathText)}</div>
        <div class="row-meta">${escapeHtml(entry.description)}</div>
      </div>
      <div class="settings-field-control">
        ${controlMarkup}
      </div>
    </div>
  `;
}

function renderSimplifiedPrimitiveControl(entry: SimplifiedJsonEntry, encodedPath: string) {
  const value = entry.value;

  if (typeof value === "boolean") {
    return `
      <label class="settings-switch">
        <input type="checkbox" data-setting-editor="boolean" data-setting-path="${encodedPath}" ${value ? "checked" : ""} />
        <span>Enabled</span>
      </label>
    `;
  }

  if (typeof value === "number") {
    return `
      <input
        type="number"
        step="any"
        data-setting-editor="number"
        data-setting-path="${encodedPath}"
        value="${escapeAttribute(String(value))}" />
    `;
  }

  return `
    <input
      type="text"
      data-setting-editor="string"
      data-setting-path="${encodedPath}"
      value="${escapeAttribute(String(value ?? ""))}" />
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
          <div class="row-title">Resolved JSON Values</div>
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

function buildSimplifiedJsonCategories(rootValue): SimplifiedJsonCategory[] {
  if (!isJsonObject(rootValue)) {
    return [];
  }

  const categories: SimplifiedJsonCategory[] = [];
  const generalEntries = Object.entries(rootValue)
    .filter(([, value]) => isEditablePrimitiveValue(value))
    .map(([key, value]) => buildSimplifiedJsonEntry([key], value, {
      label: humanizeSettingSegment(key),
      description: "Edit this setting directly without opening raw JSON."
    }))
    .filter(Boolean) as SimplifiedJsonEntry[];

  categories.push({
    id: "general",
    label: "General",
    description: generalEntries.length ? `${generalEntries.length} direct settings` : "Top-level settings and quick additions",
    entries: generalEntries
  });

  if (isJsonObject(rootValue.permissions)) {
    categories.push({
      id: "permissions",
      label: "Permissions",
      description: "Allow and deny lists plus permission-related options",
      entries: buildSimplifiedEntriesForObject(rootValue.permissions, ["permissions"])
    });
  } else if (rootValue.permissions !== undefined) {
    categories.push({
      id: "permissions",
      label: "Permissions",
      description: "Permission-related settings",
      entries: [
        buildSummaryJsonEntry(["permissions"], rootValue.permissions, "This value is not editable in the guided view.")
      ]
    });
  }

  Object.entries(rootValue).forEach(([key, value]) => {
    if (key === "permissions" || isEditablePrimitiveValue(value)) {
      return;
    }

    if (isJsonObject(value)) {
      categories.push({
        id: `top-${key}`,
        label: humanizeSettingSegment(key),
        description: `Settings inside ${humanizeSettingSegment(key)}`,
        entries: buildSimplifiedEntriesForObject(value, [key])
      });
      return;
    }

    categories.push({
      id: `top-${key}`,
      label: humanizeSettingSegment(key),
      description: `Advanced ${humanizeSettingSegment(key)} configuration`,
      entries: [buildSummaryJsonEntry([key], value, "This structure is easier to manage in raw JSON.")]
    });
  });

  return categories.filter((category) => category.entries.length || category.id === "general");
}

function activeSimplifiedJsonCategory(categories: SimplifiedJsonCategory[]) {
  if (!categories.length) {
    ui.settingsJsonCategoryId = "";
    return null;
  }

  const selectedCategory = categories.find((category) => category.id === ui.settingsJsonCategoryId);
  if (selectedCategory) {
    return selectedCategory;
  }

  ui.settingsJsonCategoryId = categories[0].id;
  return categories[0];
}

function buildSimplifiedEntriesForObject(objectValue, parentPath: (string | number)[]) {
  return Object.entries(objectValue)
    .map(([key, value]) => buildSimplifiedJsonEntry([...parentPath, key], value, {
      label: humanizeSettingSegment(key),
      description: `Edit ${humanizeSettingSegment(key)} without opening raw JSON when the value is simple.`
    }))
    .filter(Boolean) as SimplifiedJsonEntry[];
}

function buildSimplifiedJsonEntry(path: (string | number)[], value, options: { label: string; description: string }) {
  if (isEditablePrimitiveValue(value)) {
    return {
      kind: "primitive",
      path,
      value,
      label: options.label,
      description: options.description
    } satisfies SimplifiedJsonEntry;
  }

  if (isEditableStringListValue(value, path)) {
    return {
      kind: "string-list",
      path,
      value,
      label: options.label,
      description: "Manage this list in a simple one-item-per-line editor."
    } satisfies SimplifiedJsonEntry;
  }

  return buildSummaryJsonEntry(path, value, "This nested structure stays visible here, but full editing happens in raw JSON.");
}

function buildSummaryJsonEntry(path: (string | number)[], value, summary: string): SimplifiedJsonEntry {
  return {
    kind: "summary",
    path,
    label: labelForSettingPath(path),
    description: summary,
    summary: summarizeJsonValue(value)
  };
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
          ? `<button type="button" data-action="settings-toggle-raw-json">${ui.settingsShowRawJson ? "Simple View" : "Edit JSON"}</button>`
          : ""
      }
      <button type="button" data-action="settings-reload-file">Reload</button>
      <button type="button" class="primary" data-action="settings-save-file">${selectedFile.exists ? "Save" : "Create"}</button>
      <button type="button" data-action="settings-reveal-file">Reveal</button>
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
      class="settings-nav-row ${ui.settingsSelectedFilePath === file.path ? "active" : ""}"
      data-action="settings-select-file"
      data-file-path="${file.path}">
      <div class="settings-nav-row-top">
        <span class="settings-nav-icon settings-nav-icon-${escapeAttribute(settingsFileVisualKind(file))}" aria-hidden="true">${escapeHtml(settingsFileIconLabel(file))}</span>
        <div class="settings-nav-copy">
          <div class="row-title">${escapeHtml(friendlySettingsFileTitle(file))}</div>
          <div class="row-subtitle">${escapeHtml(friendlySettingsFileListSubtitle(file))}</div>
        </div>
      </div>
      <div class="settings-nav-meta">
        <span class="settings-chip">${isJsonSettingsFile(file) ? "JSON" : "MD"}</span>
        <span class="row-meta">${file.exists ? "Ready" : "Create on Save"}</span>
      </div>
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
    case "open-wiki":
      await openWiki(target.dataset.repoId || currentRepoId());
      break;
    case "open-lazygit":
      await openLazygitOverlay(target.dataset.repoId || currentRepoId());
      break;
    case "open-tokscale":
      await openTokscaleOverlay(target.dataset.repoId || currentRepoId());
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
      await startDefaultClaudeSession(target.dataset.repoId || currentRepoId());
      break;
    case "open-status":
      await selectStatus();
      break;
    case "open-settings":
      await openSettings(target.dataset.settingsTab || "general");
      break;
    case "open-session-search":
      openSessionSearch(target.dataset.repoId || currentRepoId() || state.repos[0]?.id || null);
      break;
    case "open-workspace":
      await api.openWorkspaceFolder();
      break;
    case "create-project":
      await api.createProjectFolder();
      break;
    case "rescan-workspace":
      await api.rescanWorkspace(target.dataset.workspaceId);
      if (ui.selection.type === "wiki" && ui.selection.id) {
        await loadWikiContext(ui.selection.id);
      }
      break;
    case "browse-files":
      await openFilesBrowser(target.dataset.repoId || currentRepoId());
      break;
    case "files-reload":
      await loadFileBrowserTree(target.dataset.repoId || currentRepoId());
      break;
    case "files-toggle-dir": {
      const dirPath = target.dataset.dirPath;
      if (dirPath) {
        if (ui.fileBrowserExpandedDirs.has(dirPath)) {
          ui.fileBrowserExpandedDirs.delete(dirPath);
        } else {
          ui.fileBrowserExpandedDirs.add(dirPath);
        }
        if (ui.selection.type === "files") renderDetail();
      }
      break;
    }
    case "files-select-file":
      await selectFileBrowserFile(target.dataset.filePath);
      break;
    case "files-reveal-file":
      if (target.dataset.filePath) {
        await api.revealPath(target.dataset.filePath);
      }
      break;
    case "reveal-repo":
      if (target.dataset.repoId) {
        await api.openRepoInFinder(target.dataset.repoId);
      }
      break;
    case "reveal-wiki":
      if (target.dataset.repoId || currentRepoId()) {
        await api.revealWiki(target.dataset.repoId || currentRepoId());
      }
      break;
    case "toggle-wiki":
      await toggleWiki(target.dataset.repoId || currentRepoId());
      break;
    case "initialize-wiki":
      await initializeWiki(target.dataset.repoId || currentRepoId());
      break;
    case "reload-wiki":
      await loadWikiContext(target.dataset.repoId || currentRepoId(), ui.wikiSelectedPath);
      break;
    case "refresh-wiki":
      await runWikiAgentAction("refresh", target.dataset.repoId || currentRepoId());
      break;
    case "lint-wiki":
      await runWikiAgentAction("lint", target.dataset.repoId || currentRepoId());
      break;
    case "ask-wiki":
      await runWikiAgentAction("ask", target.dataset.repoId || currentRepoId());
      break;
    case "wiki-select-file":
      await selectWikiFile(target.dataset.repoId || currentRepoId(), target.dataset.wikiPath);
      break;
    case "close-session":
      await closeSessionById(target.dataset.sessionId);
      break;
    case "restart-session":
      setFocusSection("terminal");
      await api.reopenSession(target.dataset.sessionId);
      break;
    case "remove-session-pane":
      await hideSessionPane(target.dataset.sessionId);
      break;
    case "start-session-rename":
      startSessionRename(target.dataset.sessionId);
      break;
    case "cancel-session-rename":
      cancelSessionRename();
      break;
    case "approve-blocker":
      await api.sendInput(target.dataset.sessionId, "1\r");
      break;
    case "deny-blocker":
      await api.sendInput(target.dataset.sessionId, "3\r");
      break;
    case "open-quick-switcher":
      openQuickSwitcher();
      break;
    case "open-session-search-result":
      await activateSessionSearchResult(Number(target.dataset.resultIndex));
      break;
    case "resume-session-search-result":
      await resumeFromSessionSearchResult(Number(target.dataset.resultIndex));
      break;
    case "select-session-search-result":
      ui.sessionSearchSelectedIndex = Number(target.dataset.resultIndex) || 0;
      renderSessionSearchDialog();
      break;
    case "reveal-session-search-result":
      await revealSessionSearchResult(Number(target.dataset.resultIndex));
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
    case "settings-select-json-category":
      ui.settingsJsonCategoryId = target.dataset.categoryId || "";
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

  const resizeHandle = target.closest(".pane-resize-handle") as HTMLElement | null;
  if (resizeHandle) {
    const splitPath = resizeHandle.dataset.splitPath ?? "";
    const handleIndex = Number(resizeHandle.dataset.handleIndex ?? 0);
    const layout = state.preferences.sessionWorkspaceLayout as WorkspaceLayoutNode | null;
    const splitNode = splitNodeByPath(layout, splitPath);
    if (splitNode) {
      const axis = splitNode.axis;
      const container = resizeHandle.closest(".session-workspace-split") as HTMLElement | null;
      const containerSize = container
        ? (axis === "row" ? container.clientWidth : container.clientHeight)
        : 1;
      const sizes = splitNode.sizes && splitNode.sizes.length === splitNode.children.length
        ? [...splitNode.sizes]
        : splitNode.children.map(() => 1);
      resizeHandle.classList.add("pane-resize-handle-active");
      ui.resizeDragState = {
        splitPath,
        handleIndex,
        axis,
        startPos: axis === "row" ? event.clientX : event.clientY,
        startSizes: sizes,
        containerSize,
        splitContainer: container
      };
      event.preventDefault();
    }
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

function handlePointerMove(event: PointerEvent) {
  if (!ui.resizeDragState) return;

  const { splitPath, splitContainer, handleIndex, axis, startPos, startSizes, containerSize } = ui.resizeDragState;
  const currentPos = axis === "row" ? event.clientX : event.clientY;
  const delta = currentPos - startPos;
  const deltaRatio = delta / (containerSize || 1);
  const minSize = 0.15 * startSizes.length;

  const newSizes = [...startSizes];
  newSizes[handleIndex] = Math.max(minSize, startSizes[handleIndex] + deltaRatio);
  newSizes[handleIndex + 1] = Math.max(minSize, startSizes[handleIndex + 1] - deltaRatio);

  if (splitContainer) applySizesToDOM(splitContainer, newSizes);

  const layout = state.preferences.sessionWorkspaceLayout as WorkspaceLayoutNode | null;
  const node = splitNodeByPath(layout, splitPath);
  if (node) {
    node.sizes = newSizes;
  }
}

function handlePointerUp(_event: PointerEvent) {
  if (!ui.resizeDragState) return;

  const { splitPath } = ui.resizeDragState;
  ui.resizeDragState = null;

  const handle = detailElement.querySelector(
    `.pane-resize-handle-active[data-split-path="${CSS.escape(splitPath)}"]`
  );
  handle?.classList.remove("pane-resize-handle-active");

  setStoredSessionWorkspaceLayout(state.preferences.sessionWorkspaceLayout as WorkspaceLayoutNode | null);

  for (const mount of ui.terminalMounts.values()) {
    mount.fitAddon.fit();
  }
}

function applySizesToDOM(container: HTMLElement, sizes: number[]) {
  const children = Array.from(container.children).filter((el) =>
    el.classList.contains("split-child")
  );
  children.forEach((child, i) => {
    (child as HTMLElement).style.flex = `${sizes[i]} 1 0%`;
  });
}

function splitNodeByPath(layout: WorkspaceLayoutNode | null, path: string): WorkspaceSplitNode | null {
  if (!layout || layout.type !== "split") return null;
  if (!path) return layout as WorkspaceSplitNode;
  const parts = path.split(".");
  const head = Number(parts[0]);
  const tail = parts.slice(1).join(".");
  const child = (layout as WorkspaceSplitNode).children[head];
  return splitNodeByPath(child ?? null, tail);
}

function workspaceLayoutStructureSignature(layout: WorkspaceLayoutNode | null): string {
  if (!layout) return "";
  if (layout.type === "leaf") return `leaf:${layout.sessionId}`;
  return `split:${layout.axis}:[${layout.children.map(workspaceLayoutStructureSignature).join(",")}]`;
}

function handleDragStart(event: DragEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest("[data-no-drag]")) {
    event.preventDefault();
    return;
  }
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
  const renameInput = (event.target as HTMLElement | null)?.closest(
    '[data-session-rename-input="true"]'
  ) as HTMLInputElement | null;
  if (renameInput) {
    if (event.key === "Enter") {
      event.preventDefault();
      await commitSessionRename(renameInput.dataset.sessionId);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelSessionRename();
    }
    return;
  }

  if (sessionSearchDialog.open) {
    if (await handleSessionSearchKeyDown(event)) {
      return;
    }
  }

  if (isAnyDialogOpen()) {
    return;
  }

  if (await handleAppShortcut(event)) {
    return;
  }

  if (isSectionNavigationKey(event)) {
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const handledSessionNavigation = await handleSessionWorkspaceSectionNavigation(direction);
    if (handledSessionNavigation) {
      event.preventDefault();
      return;
    }

    const nextSection = adjacentSection(direction);
    if (nextSection) {
      event.preventDefault();
      setFocusSection(nextSection);
    }
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
      await startDefaultClaudeSession(repoId);
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

async function handleAppShortcut(event) {
  if (isEditableTarget(event.target as HTMLElement | null) || isTerminalKeyboardTarget(event.target)) {
    return false;
  }

  if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    openSessionSearch(currentRepoId() || state.repos[0]?.id || null);
    return true;
  }

  if (isOpenLauncherShortcut(event)) {
    event.preventDefault();
    await startDefaultClaudeSession();
    return true;
  }

  return false;
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
    case "quick-switcher-query":
      ui.quickSwitcherQuery = target.value;
      rerenderDialogInput(renderQuickSwitcherDialog, "quick-switcher-query", target);
      break;
    case "session-search-query":
      ui.sessionSearchQuery = target.value;
      rerenderDialogInput(renderSessionSearchDialog, "session-search-query", target);
      if (sessionSearchDebounceTimer !== null) {
        clearTimeout(sessionSearchDebounceTimer);
      }
      sessionSearchDebounceTimer = setTimeout(() => {
        sessionSearchDebounceTimer = null;
        void refreshSessionSearchResults();
      }, 250);
      break;
    case "command-palette-query":
      ui.commandPaletteQuery = target.value;
      rerenderDialogInput(renderCommandPaletteDialog, "command-palette-query", target);
      break;
    default:
      if (target.dataset.sessionRenameInput === "true") {
        ui.renamingSessionTitle = target.value;
        break;
      }
      break;
    case "settings-text-editor":
      ui.settingsEditorText = target.value;
      ui.settingsSaveMessage = "";
      break;
  }
}

function rerenderDialogInput(
  render: () => void,
  inputId: string,
  source: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
) {
  const selectionStart = "selectionStart" in source ? source.selectionStart : null;
  const selectionEnd = "selectionEnd" in source ? source.selectionEnd : null;
  render();

  const nextInput = document.getElementById(inputId) as HTMLInputElement | null;
  if (!nextInput) {
    return;
  }

  nextInput.focus();
  if (selectionStart !== null && selectionEnd !== null) {
    nextInput.setSelectionRange(selectionStart, selectionEnd);
  }
}

async function handleFocusOut(event: FocusEvent) {
  const target = event.target as HTMLInputElement | null;
  if (target?.dataset.sessionRenameInput !== "true") {
    return;
  }

  await commitSessionRename(target.dataset.sessionId);
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

async function openWiki(
  repoId,
  nextFocusSection: SectionId | null = null
) {
  if (!repoId) {
    return;
  }

  if (nextFocusSection) {
    ui.focusSection = nextFocusSection;
  }

  ui.selection = { type: "wiki", id: repoId };
  ui.sidebarExpandedRepoId = repoId;
  ui.sidebarNavItem = repoId;
  syncMainListSelection();
  normalizeFocusSection();
  await api.setFocusedSession(null);
  renderSidebar();
  renderDetail();
  await loadWikiContext(repoId);
}

async function initializeWiki(repoId) {
  if (!repoId) {
    window.alert("Select a folder first.");
    return;
  }

  await api.toggleWiki(repoId, true);
  ui.wikiStatusMessage = "Wiki enabled. Agents can now maintain durable knowledge in .wiki/.";
  await openWiki(repoId);
}

async function toggleWiki(repoId) {
  if (!repoId) {
    window.alert("Select a folder first.");
    return;
  }

  const repo = repoById(repoId);
  if (!repo) {
    return;
  }

  await api.toggleWiki(repoId, !repo.wikiEnabled);
  ui.wikiStatusMessage = !repo.wikiEnabled
    ? "Wiki enabled."
    : "Wiki disabled. The existing .wiki/ directory was left on disk.";

  if (ui.selection.type === "wiki" && ui.selection.id === repoId) {
    await loadWikiContext(repoId);
    renderDetail();
  }
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

function defaultSessionRepoId(explicitRepoId = null) {
  return (
    explicitRepoId ||
    currentRepoId() ||
    ui.sidebarExpandedRepoId ||
    state.sessions[0]?.repoID ||
    state.repos[0]?.id ||
    null
  );
}

async function startDefaultClaudeSession(explicitRepoId = null) {
  const repoId = defaultSessionRepoId(explicitRepoId);
  if (!repoId) {
    window.alert("Open a folder first.");
    return null;
  }

  return startSessionForRepo(repoId, true, "terminal");
}

async function closeSessionById(sessionId) {
  removeSessionFromWorkspace(sessionId, { persistSelection: false });
  await api.closeSession(sessionId);

  if (ui.selection.type === "session" && ui.selection.id === sessionId) {
    const nextVisibleSessionId = workspaceVisibleSessionIds()[0] || null;
    if (nextVisibleSessionId) {
      await selectSession(nextVisibleSessionId, "main");
    } else {
      await selectInbox();
    }
  }
}

async function openSettings(initialTab = "general") {
  ui.settingsTab = initialTab;
  ui.settingsContext = null;
  ui.settingsSelectedFilePath = null;
  ui.settingsJsonCategoryId = "";
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

function openSessionSearch(repoId: string | null) {
  ui.sessionSearchRepoId = repoId;
  ui.sessionSearchQuery = "";
  ui.sessionSearchResults = [];
  ui.sessionSearchError = "";
  ui.sessionSearchLoading = false;
  ui.sessionSearchSelectedIndex = 0;
  ui.sessionSearchLoadId += 1;
  renderSessionSearchDialog();
  if (!sessionSearchDialog.open) {
    sessionSearchDialog.showModal();
  }

  const input = document.getElementById("session-search-query") as HTMLInputElement | null;
  input?.focus();
}

function openCommandPalette() {
  ui.commandPaletteQuery = "";
  renderCommandPaletteDialog();
  if (!commandPaletteDialog.open) {
    commandPaletteDialog.showModal();
  }
}

async function openTokscaleOverlay(repoId: string | null) {
  if (!repoId) return;
  if (tokscaleDialog.open) return;

  const sessionId = await api.launchTokscale(repoId);
  if (!sessionId) return;

  ui.tokscaleSessionId = sessionId;

  const outputBuffer: string[] = [];
  let terminalReady = false;

  ui.tokscaleUnsubOutput = api.onTokscaleOutput(({ sessionId: sid, data }) => {
    if (sid !== sessionId) return;
    if (terminalReady && ui.tokscaleTerminalMount) {
      ui.tokscaleTerminalMount.terminal.write(data);
    } else {
      outputBuffer.push(data);
    }
  });

  ui.tokscaleUnsubExit = api.onTokscaleExit(({ sessionId: sid }) => {
    if (sid === sessionId) closeTokscaleOverlay();
  });

  tokscaleDialog.showModal();

  const host = document.getElementById("tokscale-terminal-host") as HTMLElement;
  host.innerHTML = "";

  requestAnimationFrame(() => {
    if (ui.tokscaleSessionId !== sessionId) return;

    const terminal = new Terminal({
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorInactiveStyle: "outline",
      disableStdin: false,
      drawBoldTextInBrightColors: true,
      fontFamily: terminalFontFamily(),
      fontSize: 13,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      scrollback: 5000,
      theme: buildTerminalTheme()
    });

    const fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.key === "Escape" && event.type === "keydown") {
        closeTokscaleOverlay();
        return false;
      }
      return true;
    });

    terminal.onData((data) => {
      api.sendTokscaleInput(sessionId, data);
    });
    terminal.onBinary((data) => {
      api.sendTokscaleBinaryInput(sessionId, data);
    });
    terminal.onResize((size) => {
      api.resizeTokscale(sessionId, size.cols, size.rows);
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(host);

    ui.tokscaleTerminalMount = { terminal, fitAddon, resizeObserver };

    for (const chunk of outputBuffer) terminal.write(chunk);
    outputBuffer.length = 0;
    terminalReady = true;

    fitAddon.fit();
    api.resizeTokscale(sessionId, terminal.cols, terminal.rows);
    terminal.focus();
  });
}

function closeTokscaleOverlay() {
  ui.tokscaleUnsubOutput?.();
  ui.tokscaleUnsubExit?.();
  ui.tokscaleUnsubOutput = null;
  ui.tokscaleUnsubExit = null;

  if (ui.tokscaleTerminalMount) {
    ui.tokscaleTerminalMount.resizeObserver.disconnect();
    ui.tokscaleTerminalMount.terminal.dispose();
    ui.tokscaleTerminalMount = null;
  }

  if (ui.tokscaleSessionId) {
    api.closeTokscale(ui.tokscaleSessionId);
    ui.tokscaleSessionId = null;
  }

  if (tokscaleDialog.open) {
    tokscaleDialog.close();
  }
}

async function openLazygitOverlay(repoId: string | null) {
  if (!repoId) return;
  if (lazygitDialog.open) return;

  if (!state.lazygitInstalled) {
    const host = document.getElementById("lazygit-terminal-host") as HTMLElement;
    host.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-family:var(--font-mono);font-size:14px;flex-direction:column;gap:8px;">
      <span>lazygit is not installed. Install lazygit and launch app again. </span>
      <code style="color:var(--text);background:var(--surface);padding:4px 10px;border-radius:6px;font-size:13px;">brew install lazygit</code>
    </div>`;
    lazygitDialog.showModal();
    return;
  }

  const sessionId = await api.launchLazygit(repoId);
  if (!sessionId) return;

  ui.lazygitSessionId = sessionId;

  // Buffer output that arrives before the terminal is mounted.
  const outputBuffer: string[] = [];
  let terminalReady = false;

  ui.lazygitUnsubOutput = api.onLazygitOutput(({ sessionId: sid, data }) => {
    if (sid !== sessionId) return;
    if (terminalReady && ui.lazygitTerminalMount) {
      ui.lazygitTerminalMount.terminal.write(data);
    } else {
      outputBuffer.push(data);
    }
  });

  ui.lazygitUnsubExit = api.onLazygitExit(({ sessionId: sid }) => {
    if (sid === sessionId) closeLazygitOverlay();
  });

  lazygitDialog.showModal();

  const host = document.getElementById("lazygit-terminal-host") as HTMLElement;
  host.innerHTML = "";

  // Defer terminal creation to after the dialog has fully laid out.
  // showModal() makes the dialog visible but layout isn't computed until the
  // browser paints — calling terminal.open() with a 0-size host causes
  // fitAddon to compute 0 cols/rows, which corrupts the lazygit session.
  requestAnimationFrame(() => {
    // Guard: overlay may have been closed before this frame fires.
    if (ui.lazygitSessionId !== sessionId) return;

    const terminal = new Terminal({
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorInactiveStyle: "outline",
      disableStdin: false,
      drawBoldTextInBrightColors: true,
      fontFamily: terminalFontFamily(),
      fontSize: 13,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      scrollback: 5000,
      theme: buildTerminalTheme()
    });

    const fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.key === "Escape" && event.type === "keydown") {
        closeLazygitOverlay();
        return false;
      }
      return true;
    });

    terminal.onData((data) => {
      api.sendLazygitInput(sessionId, data);
    });
    terminal.onBinary((data) => {
      api.sendLazygitBinaryInput(sessionId, data);
    });
    terminal.onResize((size) => {
      api.resizeLazygit(sessionId, size.cols, size.rows);
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(host);

    ui.lazygitTerminalMount = { terminal, fitAddon, resizeObserver };

    // Flush buffered output, then mark ready for live writes.
    for (const chunk of outputBuffer) terminal.write(chunk);
    outputBuffer.length = 0;
    terminalReady = true;

    fitAddon.fit();
    api.resizeLazygit(sessionId, terminal.cols, terminal.rows);
    terminal.focus();
  });
}

function closeLazygitOverlay() {
  ui.lazygitUnsubOutput?.();
  ui.lazygitUnsubExit?.();
  ui.lazygitUnsubOutput = null;
  ui.lazygitUnsubExit = null;

  if (ui.lazygitTerminalMount) {
    ui.lazygitTerminalMount.resizeObserver.disconnect();
    ui.lazygitTerminalMount.terminal.dispose();
    ui.lazygitTerminalMount = null;
  }

  if (ui.lazygitSessionId) {
    api.closeLazygit(ui.lazygitSessionId);
    ui.lazygitSessionId = null;
  }

  if (lazygitDialog.open) {
    lazygitDialog.close();
  }
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

function clearWikiState() {
  ui.wikiContextRepoId = null;
  ui.wikiContext = null;
  ui.wikiSelectedPath = null;
  ui.wikiPreviewMarkdown = "";
  ui.wikiStatusMessage = "";
  ui.wikiLoading = false;
}

async function loadWikiContext(repoId, preferredPath = null) {
  if (!repoId) {
    clearWikiState();
    return null;
  }

  ui.wikiLoading = true;
  if (ui.selection.type === "wiki" && ui.selection.id === repoId) {
    renderDetail();
  }

  try {
    const context = await api.getWikiContext(repoId);
    ui.wikiContextRepoId = repoId;
    ui.wikiContext = context;

    const files = flattenWikiFiles(context?.tree || []);
    const preferredFile =
      files.find((file) => file.relativePath === preferredPath) ||
      files.find((file) => file.relativePath === ui.wikiSelectedPath) ||
      preferredWikiFile(files);

    if (preferredFile) {
      await selectWikiFile(repoId, preferredFile.relativePath, { suppressReload: true });
    } else {
      ui.wikiSelectedPath = null;
      ui.wikiPreviewMarkdown = "";
    }

    return context;
  } catch (error) {
    ui.wikiStatusMessage = error instanceof Error ? error.message : "Failed to load the wiki.";
    ui.wikiSelectedPath = null;
    ui.wikiPreviewMarkdown = "";
    return null;
  } finally {
    ui.wikiLoading = false;
    if (ui.selection.type === "wiki" && ui.selection.id === repoId) {
      renderDetail();
    }
  }
}

async function selectWikiFile(repoId, relativePath, options: { suppressReload?: boolean } = {}) {
  if (!repoId || !relativePath) {
    return;
  }

  if (!options.suppressReload && ui.wikiContextRepoId !== repoId) {
    await loadWikiContext(repoId, relativePath);
    return;
  }

  const payload = await api.readWikiFile(repoId, relativePath);
  ui.wikiContextRepoId = repoId;
  ui.wikiSelectedPath = payload.relativePath;
  ui.wikiPreviewMarkdown = payload.contents || "";

  if (ui.selection.type === "wiki" && ui.selection.id === repoId) {
    renderDetail();
  }
}

async function runWikiAgentAction(action: "refresh" | "lint" | "ask", repoId) {
  if (!repoId) {
    window.alert("Select a folder first.");
    return;
  }

  const repo = repoById(repoId);
  if (!repo?.wikiEnabled) {
    window.alert("Enable the wiki for this folder first.");
    return;
  }

  const session = activeClaudeSessionForRepo(repoId);
  if (!session) {
    window.alert("Start a live Claude session in this folder to run wiki actions.");
    return;
  }

  let prompt = "";

  if (action === "ask") {
    const question = window.prompt("Question for the wiki");
    if (!question?.trim()) {
      return;
    }

    prompt = wikiPromptForAction(action, question.trim());
  } else {
    prompt = wikiPromptForAction(action);
  }

  await selectSession(session.id, "terminal");
  await api.sendInput(session.id, `${prompt}\r`);
}

function activeClaudeSessionForRepo(repoId) {
  if (ui.selection.type === "session") {
    const selectedSession = sessionById(ui.selection.id);
    if (
      selectedSession?.repoID === repoId &&
      selectedSession.launchesClaudeOnStart &&
      selectedSession.runtimeState === "live"
    ) {
      return selectedSession;
    }
  }

  return sessionsForRepo(repoId).find(
    (session) => session.launchesClaudeOnStart && session.runtimeState === "live"
  );
}

function wikiPromptForAction(action: "refresh" | "lint" | "ask", question = "") {
  switch (action) {
    case "refresh":
      return "Review what you learned in this task and update `.wiki/` only if there is durable, high-signal knowledge worth preserving. Prefer updating existing narrow pages such as `known-issues.md` or `commands.md` when relevant. Trust code over the wiki, avoid filler, avoid secrets, avoid speculation, and skip the write entirely if nothing durable changed.";
    case "lint":
      return "Lint `.wiki/` for stale claims, contradictions with the codebase, broken or missing cross-links, duplicate pages, and pages that are no longer useful for future agents. Update or delete pages directly where helpful, then summarize what changed.";
    case "ask":
      return `Use relevant pages from \`.wiki/\` as context, verify against code when needed, and answer this question: ${JSON.stringify(question)}. If the answer reveals durable project knowledge that future agents should keep, update the wiki after answering.`;
    default:
      return "";
  }
}

function preferredWikiFile(files: WikiTreeNode[]) {
  return (
    files.find((file) => file.relativePath.endsWith(".md")) ||
    files[0] ||
    null
  );
}

function flattenWikiFiles(nodes: WikiTreeNode[]): WikiTreeNode[] {
  return nodes.flatMap((node) => {
    if (node.type === "file") {
      return [node];
    }

    return flattenWikiFiles(node.children || []);
  });
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
  ui.settingsJsonCategoryId = "";
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
    case "string-list":
      updateJsonSettingValue(path, parseStringListEditorValue(target.value));
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

function isEditablePrimitiveValue(value) {
  return ["string", "number", "boolean"].includes(typeof value);
}

function isEditableStringListValue(value, path: (string | number)[] = []) {
  if (!Array.isArray(value)) {
    return false;
  }

  if (!value.length) {
    const lastSegment = String(path[path.length - 1] || "").toLowerCase();
    return ["allow", "deny", "permissions", "include", "exclude"].includes(lastSegment);
  }

  return value.every((item) => typeof item === "string");
}

function formatStringListEditorValue(value) {
  return Array.isArray(value) ? value.join("\n") : "";
}

function parseStringListEditorValue(value) {
  return String(value || "")
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function summarizeJsonValue(value) {
  if (Array.isArray(value)) {
    return value.length
      ? `${value.length} item${value.length === 1 ? "" : "s"}`
      : "Empty list";
  }

  if (isJsonObject(value)) {
    const keys = Object.keys(value);
    return keys.length
      ? `${keys.length} field${keys.length === 1 ? "" : "s"}`
      : "Empty object";
  }

  return String(value ?? "null");
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
    case "AGENTS.md":
      return 2;
    case "CLAUDE.md":
      return 3;
    default:
      return 4;
  }
}

function friendlySettingsFileTitle(file) {
  const name = pathLabel(file.path);
  if (name === "AGENTS.md") {
    return file.scope === "global" ? "Global AGENTS Instructions" : "Project AGENTS Instructions";
  }
  if (name === "CLAUDE.md") {
    return file.scope === "global" ? "Global CLAUDE Instructions" : "Project CLAUDE Instructions";
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
  if (name === "AGENTS.md") {
    return file.scope === "global"
      ? "Shared agent instructions for every session"
      : "Folder-specific agent instructions";
  }
  if (name === "CLAUDE.md") {
    return file.scope === "global"
      ? "Shared Claude-specific instructions for every session"
      : "Folder-specific Claude instructions";
  }
  if (name === "settings.json") {
    return file.scope === "global"
      ? "Shared Claude defaults in JSON"
      : "Project JSON overrides";
  }
  if (name === "settings.local.json") {
    return file.scope === "global"
      ? "Machine-specific JSON overrides"
      : "Project-local JSON overrides";
  }
  return file.title;
}

function friendlySettingsFileSummary(file) {
  const name = pathLabel(file.path);
  if (name === "AGENTS.md") {
    return file.scope === "global"
      ? "Keep broad, agent-agnostic instructions here. This file stays as Markdown and applies across projects."
      : "Keep folder-specific, agent-agnostic guidance here. This file stays as Markdown and travels with the project.";
  }
  if (name === "CLAUDE.md") {
    return file.scope === "global"
      ? "Keep broad Claude guidance here. This file stays as Markdown and applies across your projects."
      : "Keep folder-specific Claude guidance here. This file stays as Markdown and travels with the project.";
  }
  if (name === "settings.json") {
    return file.scope === "global"
      ? "Edit shared Claude defaults in a form instead of reading raw JSON. Saving writes back to the underlying file."
      : "Edit project-level Claude overrides in a form. These settings can replace your global defaults for this folder.";
  }
  if (name === "settings.local.json") {
    return file.scope === "global"
      ? "Use local overrides for machine-specific Claude behavior that should sit on top of your shared defaults."
      : "Use project-local overrides for settings that should win inside this folder without changing broader defaults.";
  }
  return file.title;
}

function settingsScopeLabel(file) {
  return file.scope === "global" ? "Global Agent Defaults" : "Project Agent Override";
}

function settingsFileVisualKind(file) {
  const name = pathLabel(file.path);
  if (name === "AGENTS.md") {
    return "agents";
  }
  if (name === "CLAUDE.md") {
    return "claude";
  }
  if (name === "settings.local.json") {
    return "local";
  }
  return "json";
}

function settingsFileIconLabel(file) {
  const name = pathLabel(file.path);
  if (name === "AGENTS.md") {
    return "AG";
  }
  if (name === "CLAUDE.md") {
    return "CL";
  }
  if (name === "settings.local.json") {
    return "LO";
  }
  return "JS";
}

function renderSettingsFileSummaryCard(selectedFile, metaItems, actionOptions: JsonRenderOptions = {}) {
  return `
    <div class="settings-file-summary-card">
      <div class="settings-file-summary-main">
        <div class="settings-file-summary-title">
          <span class="settings-nav-icon settings-nav-icon-${escapeAttribute(settingsFileVisualKind(selectedFile))}" aria-hidden="true">${escapeHtml(settingsFileIconLabel(selectedFile))}</span>
          <div class="settings-file-copy">
            <div class="eyebrow">${escapeHtml(settingsScopeLabel(selectedFile))}</div>
            <div class="row-title">${escapeHtml(friendlySettingsFileTitle(selectedFile))}</div>
            <div class="row-subtitle">${escapeHtml(abbreviateHome(selectedFile.path))}</div>
          </div>
        </div>
        ${renderSettingsActionButtons(selectedFile, actionOptions)}
      </div>
      <div class="muted">${escapeHtml(friendlySettingsFileSummary(selectedFile))}</div>
      <div class="settings-meta-row">
        ${metaItems.join("")}
      </div>
    </div>
  `;
}

function renderSettingsMetaPill(value) {
  return `<span class="settings-meta-pill">${escapeHtml(value)}</span>`;
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

  const originalSizes = layout.sizes;
  const hasOriginalSizes = !!originalSizes && originalSizes.length === (layout.children || []).length;
  const normalizedChildren: WorkspaceLayoutNode[] = [];
  const normalizedSizes: number[] = [];
  let sizesValid = hasOriginalSizes;

  for (let i = 0; i < (layout.children || []).length; i++) {
    const child = layout.children[i];
    const normalizedChild = normalizeWorkspaceNode(child, validSessionIds);
    if (!normalizedChild) {
      continue;
    }

    if (normalizedChild.type === "split" && normalizedChild.axis === layout.axis) {
      normalizedChildren.push(...normalizedChild.children);
      sizesValid = false;
    } else {
      normalizedChildren.push(normalizedChild);
      if (sizesValid) {
        normalizedSizes.push(originalSizes![i]);
      }
    }
  }

  if (normalizedChildren.length === 0) {
    return null;
  }

  if (normalizedChildren.length === 1) {
    return normalizedChildren[0];
  }

  const result: WorkspaceSplitNode = {
    type: "split",
    axis: layout.axis === "column" ? "column" : "row",
    children: normalizedChildren
  };

  if (sizesValid && normalizedSizes.length === normalizedChildren.length) {
    result.sizes = normalizedSizes;
  }

  return result;
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

  return buildGridWorkspaceLayout([...visibleIds, sessionId]);
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

  if (ui.selection.type === "wiki") {
    return ui.selection.id;
  }

  if (ui.selection.type === "session") {
    return sessionById(ui.selection.id)?.repoID || null;
  }

  return null;
}

function selectedSessionSearchResult() {
  if (!ui.sessionSearchResults.length) {
    return null;
  }

  const index = Math.min(
    Math.max(ui.sessionSearchSelectedIndex, 0),
    ui.sessionSearchResults.length - 1
  );
  ui.sessionSearchSelectedIndex = index;
  return ui.sessionSearchResults[index] || null;
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

async function handleSessionWorkspaceSectionNavigation(direction: number) {
  if (ui.selection.type !== "session") {
    return false;
  }

  const paneOrder = orderedVisibleSessionPaneIds();
  if (!paneOrder.length) {
    return false;
  }

  if (ui.focusSection === "sidebar") {
    if (direction < 0) {
      return false;
    }

    if (expandedSidebarRepo()) {
      setFocusSection("sidebar-drawer");
      return true;
    }

    await focusOrderedSessionPane(paneOrder[0], sessionPaneFocusSectionForHorizontalNavigation());
    return true;
  }

  if (ui.focusSection === "sidebar-drawer") {
    if (direction < 0) {
      setFocusSection("sidebar");
      return true;
    }

    await focusOrderedSessionPane(paneOrder[0], sessionPaneFocusSectionForHorizontalNavigation());
    return true;
  }

  if (ui.focusSection !== "main" && ui.focusSection !== "terminal") {
    return false;
  }

  const currentIndex = paneOrder.indexOf(ui.selection.id);
  if (currentIndex < 0) {
    await focusOrderedSessionPane(paneOrder[0], sessionPaneFocusSectionForHorizontalNavigation());
    return true;
  }

  const nextIndex = currentIndex + direction;
  if (nextIndex >= 0 && nextIndex < paneOrder.length) {
    await focusOrderedSessionPane(
      paneOrder[nextIndex],
      sessionPaneFocusSectionForHorizontalNavigation()
    );
    return true;
  }

  if (direction < 0) {
    if (expandedSidebarRepo()) {
      setFocusSection("sidebar-drawer");
      return true;
    }

    setFocusSection("sidebar");
    return true;
  }

  return true;
}

function orderedVisibleSessionPaneIds() {
  const paneElements = Array.from(
    detailElement.querySelectorAll(".session-pane")
  ) as HTMLElement[];

  const panes = paneElements
    .map((pane) => {
      const sessionId = pane.dataset.sessionId;
      if (!sessionId) {
        return null;
      }

      const rect = pane.getBoundingClientRect();
      return {
        sessionId,
        left: rect.left,
        top: rect.top
      };
    })
    .filter(Boolean) as Array<{ sessionId: string; left: number; top: number }>;

  if (!panes.length) {
    return [];
  }

  panes.sort((left, right) => {
    const leftDelta = left.left - right.left;
    if (Math.abs(leftDelta) > 24) {
      return leftDelta;
    }

    return left.top - right.top;
  });

  const columns: Array<{ left: number; panes: Array<{ sessionId: string; left: number; top: number }> }> =
    [];

  for (const pane of panes) {
    const existingColumn = columns.find((column) => Math.abs(column.left - pane.left) <= 24);
    if (existingColumn) {
      existingColumn.panes.push(pane);
      continue;
    }

    columns.push({
      left: pane.left,
      panes: [pane]
    });
  }

  columns.sort((left, right) => left.left - right.left);

  return columns.flatMap((column) =>
    column.panes.sort((left, right) => left.top - right.top).map((pane) => pane.sessionId)
  );
}

function sessionPaneFocusSectionForHorizontalNavigation(): SectionId {
  if (ui.focusSection === "main" || ui.focusSection === "terminal") {
    return ui.focusSection;
  }

  if (ui.selection.type === "session") {
    return sessionOpenFocusSection(sessionById(ui.selection.id));
  }

  return "terminal";
}

async function focusOrderedSessionPane(sessionId, focusSection: SectionId) {
  if (ui.selection.type === "session" && isSessionVisible(sessionId)) {
    await activateVisibleSession(sessionId, focusSection);
    return;
  }

  await selectSession(sessionId, focusSection);
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
    const paneFocused = active && (ui.focusSection === "main" || ui.focusSection === "terminal");
    const mainRegion = pane.querySelector(".session-pane-main") as HTMLElement | null;
    const terminalWrap = pane.querySelector(".session-pane-terminal-wrap") as HTMLElement | null;
    pane.classList.toggle("session-pane-active", active);
    pane.classList.toggle("session-pane-focused", paneFocused);
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
    settingsDialog.open ||
    quickSwitcherDialog.open ||
    sessionSearchDialog.open ||
    commandPaletteDialog.open ||
    tokscaleDialog.open ||
    lazygitDialog.open
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

async function handleTerminalLineKillShortcut(event) {
  const mount = activeTerminalMount();
  if (!mount || terminalLineKillHandled(event)) {
    return false;
  }

  if (ui.focusSection !== "terminal" && !isTerminalKeyboardTarget(event.target)) {
    return false;
  }

  if (!isTerminalLineKillShortcut(event)) {
    return false;
  }

  if (ui.selection.type !== "session") {
    return false;
  }

  event.preventDefault();
  markTerminalLineKillHandled(event);
  await api.sendInput(ui.selection.id, "\u0015");
  return true;
}

function handleTerminalCustomKeyEvent(event) {
  if (event.type !== "keydown") {
    return true;
  }

  if (isTerminalLineKillShortcut(event)) {
    if (terminalLineKillHandled(event)) {
      return false;
    }

    void handleTerminalLineKillShortcut(event);
    return false;
  }

  if (isTerminalCopyShortcut(event) || isTerminalPasteShortcut(event)) {
    if (terminalClipboardHandled(event)) {
      return false;
    }

    void handleTerminalClipboardShortcut(event);
    return false;
  }

  return true;
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

async function refreshSessionSearchResults() {
  const query = ui.sessionSearchQuery.trim();
  const repoId = ui.sessionSearchRepoId;
  const loadId = ++ui.sessionSearchLoadId;

  if (!repoId) {
    ui.sessionSearchResults = [];
    ui.sessionSearchError = "Open or select a project first.";
    ui.sessionSearchLoading = false;
    renderSessionSearchDialogKeepFocus();
    return;
  }

  if (!query) {
    ui.sessionSearchResults = [];
    ui.sessionSearchError = "";
    ui.sessionSearchLoading = false;
    ui.sessionSearchSelectedIndex = 0;
    renderSessionSearchDialogKeepFocus();
    return;
  }

  ui.sessionSearchLoading = true;
  ui.sessionSearchError = "";
  renderSessionSearchDialogKeepFocus();

  const response = await api.querySessionSearch(repoId, query);
  if (loadId !== ui.sessionSearchLoadId) {
    return;
  }

  if (!response?.ok) {
    ui.sessionSearchResults = [];
    ui.sessionSearchError = response?.error || "Session search failed.";
    ui.sessionSearchLoading = false;
    ui.sessionSearchSelectedIndex = 0;
    renderSessionSearchDialogKeepFocus();
    return;
  }

  ui.sessionSearchResults = response.results || [];
  ui.sessionSearchError = "";
  ui.sessionSearchLoading = false;
  ui.sessionSearchSelectedIndex = Math.min(
    ui.sessionSearchSelectedIndex,
    Math.max(ui.sessionSearchResults.length - 1, 0)
  );
  renderSessionSearchDialogKeepFocus();
}

async function handleSessionSearchKeyDown(event: KeyboardEvent) {
  if (!sessionSearchDialog.open) {
    return false;
  }

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!ui.sessionSearchResults.length) {
      return false;
    }

    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const lastIndex = ui.sessionSearchResults.length - 1;
    ui.sessionSearchSelectedIndex = Math.max(
      0,
      Math.min(lastIndex, ui.sessionSearchSelectedIndex + delta)
    );
    renderSessionSearchDialog();
    const input = document.getElementById("session-search-query") as HTMLInputElement | null;
    input?.focus();
    const activeRow = document.querySelector(".session-search-row.active");
    activeRow?.scrollIntoView({ block: "nearest" });
    return true;
  }

  if (event.key === "Enter") {
    const target = event.target as HTMLElement | null;
    if (target?.id === "session-search-query" || target?.closest(".session-search-row")) {
      event.preventDefault();
      await activateSessionSearchResult(ui.sessionSearchSelectedIndex);
      return true;
    }
  }

  return false;
}

async function activateSessionSearchResult(index: number) {
  const result = ui.sessionSearchResults[index];
  if (!result) {
    return;
  }

  if (result.source === "claude" && result.sessionId) {
    await resumeFromSessionSearchResult(index);
    return;
  }

  await api.revealPath(result.filePath);
}

async function resumeFromSessionSearchResult(index: number) {
  const result = ui.sessionSearchResults[index];
  if (!result || !ui.sessionSearchRepoId) {
    return;
  }

  if (result.hydraSessionId) {
    sessionSearchDialog.close();
    await selectSession(result.hydraSessionId, sessionOpenFocusSection(sessionById(result.hydraSessionId)));
    return;
  }

  if (result.source === "claude" && result.sessionId) {
    sessionSearchDialog.close();
    const newSessionId = await api.resumeFromClaudeSession(ui.sessionSearchRepoId, result.sessionId);
    if (newSessionId) {
      await selectSession(newSessionId, "terminal");
    }
    return;
  }

  await api.revealPath(result.filePath);
}

async function revealSessionSearchResult(index: number) {
  const result = ui.sessionSearchResults[index];
  if (!result) {
    return;
  }

  await api.revealPath(result.filePath);
}

function pathLeafLabel(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts.slice(-2).join("/");
}

function normalizeJsonlPreview(raw: string): string {
  try {
    const parsed = JSON.parse(raw);

    // last-prompt record: {"type":"last-prompt","lastPrompt":"..."}
    if (parsed?.lastPrompt) {
      return String(parsed.lastPrompt).slice(0, 300).trim();
    }

    // custom-title record: {"type":"custom-title","customTitle":"..."}
    if (parsed?.customTitle) {
      return String(parsed.customTitle).slice(0, 300).trim();
    }

    // user / assistant message — message.content is string or array of blocks
    const msgContent = parsed?.message?.content;
    if (msgContent) {
      if (typeof msgContent === "string") return msgContent.slice(0, 300).trim();
      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (block?.type === "text" && block?.text) {
            return String(block.text).slice(0, 300).trim();
          }
          if (block?.type === "tool_result") {
            const inner = typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content.find((b: any) => b?.type === "text")?.text
                : null;
            if (inner) return String(inner).slice(0, 300).trim();
          }
        }
      }
    }

    // top-level content field (tool results, etc.)
    if (parsed?.content) {
      const c = parsed.content;
      if (typeof c === "string") return c.slice(0, 300).trim();
      if (Array.isArray(c)) {
        const tp = c.find((b: any) => b?.type === "text" && b?.text);
        if (tp?.text) return String(tp.text).slice(0, 300).trim();
      }
    }
  } catch {
    // not valid JSON
  }
  return raw.slice(0, 300).trim();
}

function renderSessionSearchDialogKeepFocus() {
  const prev = document.getElementById("session-search-query") as HTMLInputElement | null;
  const wasFocused = document.activeElement === prev;
  const selStart = wasFocused && prev ? prev.selectionStart : null;
  const selEnd = wasFocused && prev ? prev.selectionEnd : null;
  renderSessionSearchDialog();
  if (wasFocused) {
    const next = document.getElementById("session-search-query") as HTMLInputElement | null;
    next?.focus();
    if (selStart !== null && selEnd !== null) {
      next?.setSelectionRange(selStart, selEnd);
    }
  }
}

function markTerminalClipboardHandled(event) {
  (event as KeyboardEvent & { __claudeWorkspaceTerminalClipboardHandled?: boolean }).__claudeWorkspaceTerminalClipboardHandled = true;
}

function terminalClipboardHandled(event) {
  return !!(event as KeyboardEvent & { __claudeWorkspaceTerminalClipboardHandled?: boolean }).__claudeWorkspaceTerminalClipboardHandled;
}

function markTerminalLineKillHandled(event) {
  (event as KeyboardEvent & { __claudeWorkspaceTerminalLineKillHandled?: boolean }).__claudeWorkspaceTerminalLineKillHandled = true;
}

function terminalLineKillHandled(event) {
  return !!(event as KeyboardEvent & { __claudeWorkspaceTerminalLineKillHandled?: boolean }).__claudeWorkspaceTerminalLineKillHandled;
}

function isTerminalCopyShortcut(event) {
  return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c";
}

function isTerminalPasteShortcut(event) {
  return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "v";
}

function isTerminalLineKillShortcut(event) {
  return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === "Backspace";
}

function isOpenLauncherShortcut(event) {
  return event.metaKey && !event.ctrlKey && !event.altKey && event.shiftKey && event.key.toLowerCase() === "a";
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

function renderMarkdownDocument(markdown) {
  const normalized = String(markdown || "").replace(/\r\n/g, "\n");
  if (!normalized.trim()) {
    return `<p class="muted">This file is empty.</p>`;
  }

  const lines = normalized.split("\n");
  const blocks: string[] = [];
  const paragraph: string[] = [];
  const unorderedList: string[] = [];
  const orderedList: string[] = [];
  const codeFence: string[] = [];
  let inCodeFence = false;

  const flushParagraph = () => {
    if (!paragraph.length) {
      return;
    }

    blocks.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph.length = 0;
  };

  const flushUnorderedList = () => {
    if (!unorderedList.length) {
      return;
    }

    blocks.push(`<ul>${unorderedList.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`);
    unorderedList.length = 0;
  };

  const flushOrderedList = () => {
    if (!orderedList.length) {
      return;
    }

    blocks.push(`<ol>${orderedList.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ol>`);
    orderedList.length = 0;
  };

  const flushCodeFence = () => {
    if (!codeFence.length) {
      return;
    }

    blocks.push(`<pre><code>${escapeHtml(codeFence.join("\n"))}</code></pre>`);
    codeFence.length = 0;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "  ");

    if (/^```/.test(line.trim())) {
      if (inCodeFence) {
        flushCodeFence();
        inCodeFence = false;
      } else {
        flushParagraph();
        flushUnorderedList();
        flushOrderedList();
        inCodeFence = true;
      }
      continue;
    }

    if (inCodeFence) {
      codeFence.push(rawLine);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushUnorderedList();
      flushOrderedList();
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2].trim())}</h${level}>`);
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushUnorderedList();
      flushOrderedList();
      blocks.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.*)$/);
    if (unordered) {
      flushParagraph();
      flushOrderedList();
      unorderedList.push(unordered[1].trim());
      continue;
    }

    const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      flushUnorderedList();
      orderedList.push(ordered[1].trim());
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushUnorderedList();
      flushOrderedList();
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushUnorderedList();
  flushOrderedList();
  flushCodeFence();

  return blocks.join("");
}

function renderInlineMarkdown(value) {
  let html = escapeHtml(value);

  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
    return `<a href="${escapeAttribute(url)}">${label}</a>`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  return html;
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
