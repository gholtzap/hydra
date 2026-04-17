import type {
  AgentId,
  AppPreferences,
  AppStateSnapshot,
  ClaudeSettingsContext,
  EphemeralToolId,
  EphemeralToolOutputPayload,
  FileTreeNode as SharedFileTreeNode,
  JsonObject,
  JsonValue,
  KeybindingAction,
  KeybindingMap,
  RepoAppLaunchConfig,
  RepoSnapshot,
  SessionSearchResult as SharedSessionSearchResult,
  SessionSummary,
  SessionTagColor,
  TrackedPortStatus,
  WikiContext,
  WikiTreeNode as SharedWikiTreeNode,
  WorkspaceRecord
} from "../shared-types";

const api = window.claudeWorkspace;
let sessionSearchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const SECTION_ORDER = ["sidebar", "sidebar-drawer", "main", "terminal"] as const;
type SectionId = (typeof SECTION_ORDER)[number];
const MAX_VISIBLE_SESSION_PANES = 9;

// ---------------------------------------------------------------------------
// Keybinding configuration
// ---------------------------------------------------------------------------

const DEFAULT_KEYBINDINGS: KeybindingMap = {
  "open-folder": "CmdOrCtrl+O",
  "create-folder": "CmdOrCtrl+Shift+N",
  "new-session": "CmdOrCtrl+Shift+A",
  "new-session-alt": "CmdOrCtrl+N",
  "open-wiki": "CmdOrCtrl+Shift+W",
  "quick-switcher": "CmdOrCtrl+K",
  "command-palette": "CmdOrCtrl+Shift+P",
  "next-unread": "CmdOrCtrl+]",
  "open-lazygit": "CmdOrCtrl+Shift+G",
  "open-tokscale": "CmdOrCtrl+Shift+T",
  "open-launcher": "CmdOrCtrl+C",
  "build-and-run-app": "CmdOrCtrl+Shift+B",
  "search-project-sessions": "CmdOrCtrl+F",
  "navigate-section-left": "CmdOrCtrl+ArrowLeft",
  "navigate-section-right": "CmdOrCtrl+ArrowRight",
  "navigate-section-up": "CmdOrCtrl+ArrowUp",
  "navigate-section-down": "CmdOrCtrl+ArrowDown"
};

const KEYBINDING_LABELS: Record<KeybindingAction, string> = {
  "open-folder": "Open Folder",
  "create-folder": "Create Folder",
  "new-session": "New Session",
  "new-session-alt": "New Session (Alt)",
  "open-wiki": "Open Wiki",
  "quick-switcher": "Quick Switcher",
  "command-palette": "Command Palette",
  "next-unread": "Next Unread Session",
  "open-lazygit": "Open Lazygit",
  "open-tokscale": "Open Token Usage",
  "open-launcher": "Open Launcher",
  "build-and-run-app": "Build and Run App",
  "search-project-sessions": "Search Project Sessions",
  "navigate-section-left": "Navigate Section Left",
  "navigate-section-right": "Navigate Section Right",
  "navigate-section-up": "Navigate Session Up",
  "navigate-section-down": "Navigate Session Down"
};

const ALL_KEYBINDING_ACTIONS: KeybindingAction[] = Object.keys(DEFAULT_KEYBINDINGS) as KeybindingAction[];

function getKeybindings(): KeybindingMap {
  return { ...DEFAULT_KEYBINDINGS, ...(state.preferences.keybindings || {}) };
}

function matchesAccelerator(event: KeyboardEvent, accelerator: string): boolean {
  const parts = accelerator.split("+").map((p) => p.toLowerCase());
  let needsMeta = false;
  let needsCtrl = false;
  let needsShift = false;
  let needsAlt = false;
  let targetKey = "";

  for (const part of parts) {
    if (part === "cmdorctrl" || part === "commandorcontrol") {
      if (navigator.platform.includes("Mac")) {
        needsMeta = true;
      } else {
        needsCtrl = true;
      }
    } else if (part === "cmd" || part === "command" || part === "meta") {
      needsMeta = true;
    } else if (part === "ctrl" || part === "control") {
      needsCtrl = true;
    } else if (part === "shift") {
      needsShift = true;
    } else if (part === "alt" || part === "option") {
      needsAlt = true;
    } else {
      targetKey = part;
    }
  }

  if (event.metaKey !== needsMeta) return false;
  if (event.ctrlKey !== needsCtrl) return false;
  if (event.shiftKey !== needsShift) return false;
  if (event.altKey !== needsAlt) return false;

  const eventKey = event.key.toLowerCase();
  if (targetKey === "arrowleft") return eventKey === "arrowleft";
  if (targetKey === "arrowright") return eventKey === "arrowright";
  if (targetKey === "arrowup") return eventKey === "arrowup";
  if (targetKey === "arrowdown") return eventKey === "arrowdown";
  if (targetKey === "enter" || targetKey === "return") return eventKey === "enter";
  if (targetKey === "escape") return eventKey === "escape";
  if (targetKey === "backspace" || targetKey === "delete") return eventKey === "backspace";
  if (targetKey === "tab") return eventKey === "tab";
  if (targetKey === "space") return eventKey === " ";
  if (targetKey === "]") return eventKey === "]";
  if (targetKey === "[") return eventKey === "[";

  return eventKey === targetKey;
}

function acceleratorDisplayParts(accelerator: string): { isMac: boolean; parts: string[] } {
  const isMac = navigator.platform.includes("Mac");
  const acceleratorParts = accelerator.split("+");
  const display: string[] = [];

  for (const part of acceleratorParts) {
    const normalized = part.toLowerCase();
    if (normalized === "cmdorctrl" || normalized === "commandorcontrol") {
      display.push(isMac ? "\u2318" : "Ctrl");
    } else if (normalized === "cmd" || normalized === "command" || normalized === "meta") {
      display.push(isMac ? "\u2318" : "Win");
    } else if (normalized === "ctrl" || normalized === "control") {
      display.push(isMac ? "\u2303" : "Ctrl");
    } else if (normalized === "shift") {
      display.push(isMac ? "\u21E7" : "Shift");
    } else if (normalized === "alt" || normalized === "option") {
      display.push(isMac ? "\u2325" : "Alt");
    } else if (normalized === "arrowleft") {
      display.push("\u2190");
    } else if (normalized === "arrowright") {
      display.push("\u2192");
    } else if (normalized === "arrowup") {
      display.push("\u2191");
    } else if (normalized === "arrowdown") {
      display.push("\u2193");
    } else if (normalized === "enter" || normalized === "return") {
      display.push("\u21A9");
    } else if (normalized === "escape") {
      display.push("Esc");
    } else if (normalized === "backspace" || normalized === "delete") {
      display.push(isMac ? "\u232B" : "Backspace");
    } else if (normalized === "tab") {
      display.push(isMac ? "\u21E5" : "Tab");
    } else if (normalized === "space") {
      display.push("Space");
    } else {
      display.push(part.length === 1 ? part.toUpperCase() : part);
    }
  }

  return { isMac, parts: display };
}

function formatAccelerator(accelerator: string): string {
  const display = acceleratorDisplayParts(accelerator);
  return display.isMac ? display.parts.join("") : display.parts.join("+");
}

function renderAcceleratorMarkup(accelerator: string): string {
  const display = acceleratorDisplayParts(accelerator);
  const joiner = display.isMac ? "" : `<span class="accelerator-joiner" aria-hidden="true">+</span>`;

  return `<span class="accelerator-sequence" aria-label="${escapeAttribute(formatAccelerator(accelerator))}">${display.parts
    .map((part) => `<span class="accelerator-token">${escapeHtml(part)}</span>`)
    .join(joiner)}</span>`;
}

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
type WorkspaceNavigationDirection = "left" | "right" | "up" | "down";
type RendererSelection =
  | { type: "inbox"; id: null }
  | { type: "repo"; id: string }
  | { type: "wiki"; id: string }
  | { type: "session"; id: string }
  | { type: "files"; id: string }
  | { type: "status"; id: null };

type VisibleSessionPane = {
  sessionId: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerX: number;
  centerY: number;
};

type TerminalMount = {
  terminal: InstanceType<typeof Terminal>;
  fitAddon: InstanceType<typeof FitAddon.FitAddon>;
  resizeObserver: ResizeObserver;
};

type EphemeralToolOverlayState = {
  sessionId: string | null;
  terminalMount: TerminalMount | null;
  unsubOutput: (() => void) | null;
  unsubExit: (() => void) | null;
};

type WikiTreeNode = SharedWikiTreeNode;
type FileTreeNode = SharedFileTreeNode;

type SessionSearchResult = SharedSessionSearchResult & {
  hydraSessionId?: string | null;
};

function createEphemeralToolOverlayState(): EphemeralToolOverlayState {
  return {
    sessionId: null,
    terminalMount: null,
    unsubOutput: null,
    unsubExit: null
  };
}

const SESSION_TAG_OPTIONS = [
  { value: "", label: "No Tag" },
  { value: "red", label: "Red" },
  { value: "orange", label: "Orange" },
  { value: "yellow", label: "Yellow" },
  { value: "green", label: "Green" },
  { value: "blue", label: "Blue" },
  { value: "purple", label: "Purple" },
  { value: "gray", label: "Gray" }
] as const;
const SESSION_TAG_VALUES = new Set<string>(
  SESSION_TAG_OPTIONS.map((option) => option.value).filter(Boolean) as string[]
);
const AGENT_OPTIONS = [
  { id: "claude", label: "Claude Code", defaultCommand: "claude" },
  { id: "codex", label: "Codex CLI", defaultCommand: "codex" },
  { id: "gemini", label: "Gemini CLI", defaultCommand: "gemini" },
  { id: "aider", label: "Aider", defaultCommand: "aider" },
  { id: "opencode", label: "OpenCode", defaultCommand: "opencode" },
  { id: "goose", label: "Goose", defaultCommand: "goose" },
  { id: "amazon-q", label: "Amazon Q Developer CLI", defaultCommand: "q chat" },
  { id: "github-copilot", label: "GitHub Copilot CLI", defaultCommand: "gh copilot" },
  { id: "junie", label: "Junie CLI", defaultCommand: "junie" },
  { id: "qwen", label: "Qwen Code", defaultCommand: "qwen-code" },
  { id: "amp", label: "Amp", defaultCommand: "amp" },
  { id: "warp", label: "Warp", defaultCommand: "warp" }
] as const;
const DEFAULT_AGENT_ID: AgentId = "claude";
const AGENT_IDS = new Set<AgentId>(AGENT_OPTIONS.map((agent) => agent.id));
const DEFAULT_AGENT_COMMANDS = Object.fromEntries(
  AGENT_OPTIONS.map((agent) => [agent.id, agent.defaultCommand])
) as Record<AgentId, string>;

const INITIAL_PREFERENCES: AppPreferences = {
  defaultAgentId: DEFAULT_AGENT_ID,
  agentCommandOverrides: { ...DEFAULT_AGENT_COMMANDS },
  claudeExecutablePath: DEFAULT_AGENT_COMMANDS.claude,
  shellExecutablePath: navigator.platform.startsWith("Win") ? "cmd.exe" : "/bin/sh",
  notificationsEnabled: true,
  showInAppBadges: true,
  showNativeNotifications: true,
  sessionWorkspaceLayout: null,
  keybindings: {},
  themeAppearance: "system",
  themeActiveId: "workspace-default",
  themeCustomThemes: []
};

const state: AppStateSnapshot = {
  workspaces: [] as WorkspaceRecord[],
  repos: [] as RepoSnapshot[],
  sessions: [] as SessionSummary[],
  preferences: { ...INITIAL_PREFERENCES },
  lazygitInstalled: false,
  tokscaleInstalled: false
};

type UiState = {
  selection: RendererSelection;
  focusSection: SectionId;
  sidebarExpandedRepoId: string | null;
  sidebarNavItem: string;
  sidebarCollapsed: boolean;
  navbarCollapsed: boolean;
  mainListSessionId: string | null;
  terminalMounts: Map<string, TerminalMount>;
  renamingSessionId: string | null;
  renamingSessionTitle: string;
  quickSwitcherQuery: string;
  sessionSearchQuery: string;
  sessionSearchRepoId: string | null;
  sessionSearchResults: SessionSearchResult[];
  sessionSearchError: string;
  sessionSearchLoading: boolean;
  sessionSearchSelectedIndex: number;
  sessionSearchLoadId: number;
  sessionSearchFilter: "all" | "claude" | "codex";
  commandPaletteQuery: string;
  settingsTab: string;
  settingsClaudeView: ClaudeSettingsView;
  settingsContext: ClaudeSettingsContext | null;
  settingsSelectedFilePath: string | null;
  settingsJsonCategoryId: string;
  settingsEditorText: string;
  settingsSaveMessage: string;
  settingsJsonDraft: JsonValue | null;
  settingsJsonError: string;
  settingsShowRawJson: boolean;
  appLaunchRepoId: string | null;
  appLaunchBuildCommand: string;
  appLaunchRunCommand: string;
  appLaunchError: string;
  marketplaceResults: MarketplaceSkillSummary[];
  marketplaceSelectedId: string | null;
  marketplaceSelectedDetail: MarketplaceSkillDetails | null;
  marketplaceLoading: boolean;
  marketplaceDetailLoading: boolean;
  marketplaceError: string;
  marketplaceInstallMessage: string;
  marketplaceInspectUrl: string;
  marketplaceInspectMessage: string;
  marketplacePreferredScope: "user" | "project";
  portStatusData: TrackedPortStatus | null;
  portStatusLoading: boolean;
  portStatusShowAll: boolean;
  portStatusPollTimer: number | null;
  wikiContextRepoId: string | null;
  wikiContext: WikiContext | null;
  wikiSelectedPath: string | null;
  wikiPreviewMarkdown: string;
  wikiStatusMessage: string;
  wikiLoading: boolean;
  workspaceStructureSignature: string;
  draggingSessionId: string | null;
  draggingSessionSource: string | null;
  dragTargetSessionId: string | null;
  dragTargetZone: WorkspaceDropZone | null;
  fileBrowserRepoId: string | null;
  fileBrowserTree: FileTreeNode[] | null;
  fileBrowserSelectedPath: string | null;
  fileBrowserFileContent: string | null;
  fileBrowserFileTooLarge: boolean;
  fileBrowserLoadingFile: boolean;
  fileBrowserLoadId: number;
  fileBrowserLoading: boolean;
  fileBrowserExpandedDirs: Set<string>;
  sessionPlanReviews: Map<string, SessionPlanReview>;
  lastAutoOpenedPlanFingerprintBySession: Map<string, string>;
  activePlanReviewSessionId: string | null;
  ephemeralToolOverlays: Record<EphemeralToolId, EphemeralToolOverlayState>;
  resizeDragState: {
    splitPath: string;
    handleIndex: number;
    axis: WorkspaceSplitAxis;
    startPos: number;
    startSizes: number[];
    containerSize: number;
    splitContainer: HTMLElement | null;
  } | null;
  keybindingRecordingAction: KeybindingAction | null;
  lassoActive: boolean;
  lassoPending: boolean;
  lassoOriginX: number;
  lassoOriginY: number;
  lassoCurrentX: number;
  lassoCurrentY: number;
  lassoContainerRepoId: string | null;
  lassoPressedSessionId: string | null;
  lassoSuppressClickUntil: number;
  selectedSessionIds: Set<string>;
};

const ui: UiState = {
  selection: { type: "inbox", id: null },
  focusSection: "main" as SectionId,
  sidebarExpandedRepoId: null as string | null,
  sidebarNavItem: "inbox" as string,
  sidebarCollapsed: false,
  navbarCollapsed: false,
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
  sessionSearchFilter: "all" as "all" | "claude" | "codex",
  commandPaletteQuery: "",
  settingsTab: "general",
  settingsClaudeView: "files" as ClaudeSettingsView,
  settingsContext: null,
  settingsSelectedFilePath: null,
  settingsJsonCategoryId: "",
  settingsEditorText: "",
  settingsSaveMessage: "",
  settingsJsonDraft: null,
  settingsJsonError: "",
  settingsShowRawJson: false,
  appLaunchRepoId: null,
  appLaunchBuildCommand: "",
  appLaunchRunCommand: "",
  appLaunchError: "",
  marketplaceResults: [] as MarketplaceSkillSummary[],
  marketplaceSelectedId: null as string | null,
  marketplaceSelectedDetail: null as MarketplaceSkillDetails | null,
  marketplaceLoading: false,
  marketplaceDetailLoading: false,
  marketplaceError: "",
  marketplaceInstallMessage: "",
  marketplaceInspectUrl: "",
  marketplaceInspectMessage: "",
  marketplacePreferredScope: "project" as "user" | "project",
  portStatusData: null,
  portStatusLoading: false,
  portStatusShowAll: false,
  portStatusPollTimer: null as number | null,
  wikiContextRepoId: null as string | null,
  wikiContext: null,
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
  sessionPlanReviews: new Map<string, SessionPlanReview>(),
  lastAutoOpenedPlanFingerprintBySession: new Map<string, string>(),
  activePlanReviewSessionId: null as string | null,
  ephemeralToolOverlays: {
    lazygit: createEphemeralToolOverlayState(),
    tokscale: createEphemeralToolOverlayState()
  },
  resizeDragState: null as {
    splitPath: string;
    handleIndex: number;
    axis: WorkspaceSplitAxis;
    startPos: number;
    startSizes: number[];
    containerSize: number;
    splitContainer: HTMLElement | null;
  } | null,
  keybindingRecordingAction: null as KeybindingAction | null,
  lassoActive: false,
  lassoPending: false,
  lassoOriginX: 0,
  lassoOriginY: 0,
  lassoCurrentX: 0,
  lassoCurrentY: 0,
  lassoContainerRepoId: null as string | null,
  lassoPressedSessionId: null as string | null,
  lassoSuppressClickUntil: 0,
  selectedSessionIds: new Set<string>()
};

const sidebarElement = document.getElementById("sidebar") as HTMLElement;
const detailElement = document.getElementById("detail") as HTMLElement;
const appShellElement = document.getElementById("app-shell") as HTMLElement;
const sidebarRevealHandleElement = document.getElementById("sidebar-reveal-handle") as HTMLButtonElement;
const navbarRevealHandleElement = document.getElementById("navbar-reveal-handle") as HTMLButtonElement;
const settingsDialog = document.getElementById("settings-dialog") as HTMLDialogElement;
const quickSwitcherDialog = document.getElementById("quick-switcher-dialog") as HTMLDialogElement;
const sessionSearchDialog = document.getElementById("session-search-dialog") as HTMLDialogElement;
const commandPaletteDialog = document.getElementById("command-palette-dialog") as HTMLDialogElement;
const appLaunchDialog = document.getElementById("app-launch-dialog") as HTMLDialogElement;
const planReviewDialog = document.getElementById("plan-review-dialog") as HTMLDialogElement;
const tokscaleDialog = document.getElementById("tokscale-dialog") as HTMLDialogElement;
const lazygitDialog = document.getElementById("lazygit-dialog") as HTMLDialogElement;
const colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

const EPHEMERAL_TOOL_DIALOGS: Record<
  EphemeralToolId,
  { dialog: HTMLDialogElement; hostId: string }
> = {
  lazygit: { dialog: lazygitDialog, hostId: "lazygit-terminal-host" },
  tokscale: { dialog: tokscaleDialog, hostId: "tokscale-terminal-host" }
};

sidebarElement.tabIndex = -1;
detailElement.tabIndex = -1;

type DomChild = Node | string | number | false | null | undefined;
type DomAttributeValue = string | number | boolean | null | undefined;
type DomOptions = {
  className?: string;
  attrs?: Record<string, DomAttributeValue>;
  value?: string;
};

function classNames(...tokens: Array<string | false | null | undefined>) {
  return tokens.filter(Boolean).join(" ");
}

function appendDomChild(parent: Node, child: DomChild) {
  if (child === null || child === undefined || child === false) {
    return;
  }

  if (child instanceof Node) {
    parent.appendChild(child);
    return;
  }

  parent.appendChild(document.createTextNode(String(child)));
}

function replaceDomChildren(target: Element, ...children: DomChild[]) {
  const fragment = document.createDocumentFragment();
  children.forEach((child) => appendDomChild(fragment, child));
  target.replaceChildren(fragment);
}

function dom<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  options: DomOptions = {},
  ...children: DomChild[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);

  if (options.className) {
    element.className = options.className;
  }

  if (options.value !== undefined && "value" in element) {
    (element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value = options.value;
  }

  if (options.attrs) {
    Object.entries(options.attrs).forEach(([name, value]) => {
      if (value === null || value === undefined || value === false) {
        return;
      }
      element.setAttribute(name, value === true ? "true" : String(value));
    });
  }

  children.forEach((child) => appendDomChild(element, child));
  return element;
}

function trustedFragment(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content;
}

function trustedElement<T extends Element>(html: string): T {
  const fragment = trustedFragment(html);
  const element = fragment.firstElementChild;
  if (!element) {
    throw new Error("Expected HTML fragment with a root element.");
  }
  return element as T;
}

function emptyStateElement(message: string, extraClass = "") {
  return dom("div", { className: classNames("empty-state", extraClass || undefined) }, message);
}

type JsonRenderOptions = {
  customLabel?: string;
  allowRemove?: boolean;
  includeJsonToggle?: boolean;
  forceRawEditor?: boolean;
};

type ClaudeSettingsView = "files" | "skills" | "marketplace" | "plugins";

type MarketplaceSkillSource = {
  owner: string;
  repo: string;
  ref?: string;
  path: string;
  reviewState?: string;
  tags?: string[];
};

type MarketplaceSkillSummary = {
  id: string;
  title: string;
  description: string;
  reviewState: "reviewed" | "unreviewed";
  sourceUrl: string;
  repoUrl: string;
  repoFullName: string;
  stars: number;
  updatedAt: string;
  tags: string[];
  compatibility: string[];
  fileCount: number;
  source: MarketplaceSkillSource;
};

type MarketplaceSkillDetails = MarketplaceSkillSummary & {
  markdown: string;
  files: Array<{
    path: string;
    relativePath: string;
    size: number;
  }>;
  installTargets?: {
    user?: string | null;
    project?: string | null;
  };
};

type MarkdownRenderContext =
  | { kind: "plain"; repoId: string | null }
  | { kind: "wiki"; repoId: string; currentPath: string }
  | { kind: "marketplace"; source: MarketplaceSkillSource };

type ResolvedMarkdownLink =
  | { kind: "github-url"; url: string }
  | { kind: "wiki-file"; repoId: string; relativePath: string }
  | { kind: "repo-file"; repoId: string; relativePath: string };

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

type ThemeAppearance = "system" | "light" | "dark";
type ThemeMode = "light" | "dark";
type SessionPlanReview = {
  sessionId: string;
  markdown: string;
  fingerprint: string;
  detectedAt: string;
};

type ThemeSeedPalette = {
  background: string;
  surface: string;
  text: string;
  mutedText: string;
  primary: string;
  border: string;
  focus: string;
  terminalBackground: string;
};

type ThemeColorFieldId = keyof ThemeSeedPalette;

type ThemeDefinition = {
  id: string;
  name: string;
  description: string;
  light: ThemeSeedPalette;
  dark: ThemeSeedPalette;
};

type ThemePreferences = {
  appearance: ThemeAppearance;
  activeThemeId: string;
  customThemes: ThemeDefinition[];
};

type RgbColor = {
  r: number;
  g: number;
  b: number;
};

const THEME_BOOTSTRAP_STORAGE_KEY = "claude-workspace-theme-bootstrap-v1";
const DEFAULT_THEME_PALETTE_LIGHT: ThemeSeedPalette = {
  background: "#f5f1ea",
  surface: "#fcfaf7",
  text: "#37332d",
  mutedText: "#7e776f",
  primary: "#5c574f",
  border: "#e3ded5",
  focus: "#8a847a",
  terminalBackground: "#faf7f2"
};
const DEFAULT_THEME_PALETTE_DARK: ThemeSeedPalette = {
  background: "#211f1c",
  surface: "#282521",
  text: "#ece6dd",
  mutedText: "#aba196",
  primary: "#e7dfd2",
  border: "#44403a",
  focus: "#c7bdaf",
  terminalBackground: "#171512"
};
const DEFAULT_THEME_PREFERENCES: ThemePreferences = {
  appearance: "system",
  activeThemeId: "workspace-default",
  customThemes: []
};
const BUILT_IN_THEMES: ThemeDefinition[] = [
  {
    id: "workspace-default",
    name: "Workspace Default",
    description: "The current neutral palette the app ships with.",
    light: DEFAULT_THEME_PALETTE_LIGHT,
    dark: DEFAULT_THEME_PALETTE_DARK
  },
  {
    id: "coastal-signal",
    name: "Coastal Signal",
    description: "Cool blue surfaces with a brighter accent.",
    light: {
      background: "#eef6fa",
      surface: "#fbfdff",
      text: "#173447",
      mutedText: "#567385",
      primary: "#1679b7",
      border: "#c8dbe7",
      focus: "#45a6d9",
      terminalBackground: "#f3fbff"
    },
    dark: {
      background: "#111d24",
      surface: "#15262e",
      text: "#e1f0f8",
      mutedText: "#84a7ba",
      primary: "#6bc8ff",
      border: "#29414d",
      focus: "#50b7f0",
      terminalBackground: "#0a141a"
    }
  },
  {
    id: "ember-notes",
    name: "Ember Notes",
    description: "Warm clay and amber tones without turning the whole UI orange.",
    light: {
      background: "#fbf1ea",
      surface: "#fff8f3",
      text: "#452b22",
      mutedText: "#8c6657",
      primary: "#c96b2c",
      border: "#ecd1c3",
      focus: "#de874d",
      terminalBackground: "#fff7f1"
    },
    dark: {
      background: "#231713",
      surface: "#2b1e19",
      text: "#f5e5dc",
      mutedText: "#ba9282",
      primary: "#f2a15f",
      border: "#4a342c",
      focus: "#f7b37d",
      terminalBackground: "#160f0d"
    }
  },
  {
    id: "forest-console",
    name: "Forest Console",
    description: "A greener palette with restrained contrast and darker chrome.",
    light: {
      background: "#f1f6ef",
      surface: "#fcfffb",
      text: "#223728",
      mutedText: "#657d6a",
      primary: "#3d7a4d",
      border: "#d4e1d5",
      focus: "#58a36e",
      terminalBackground: "#f7fcf6"
    },
    dark: {
      background: "#172019",
      surface: "#1d2820",
      text: "#e5f1e5",
      mutedText: "#92aa95",
      primary: "#7fce8f",
      border: "#344538",
      focus: "#72d694",
      terminalBackground: "#101612"
    }
  }
];
const THEME_COLOR_FIELDS: { id: ThemeColorFieldId; label: string; hint: string }[] = [
  { id: "background", label: "Background", hint: "App canvas and outer chrome." },
  { id: "surface", label: "Surface", hint: "Cards, dialogs, panels, and sidebars." },
  { id: "text", label: "Text", hint: "Primary body text and headings." },
  { id: "mutedText", label: "Muted Text", hint: "Secondary labels and metadata." },
  { id: "primary", label: "Accent", hint: "Primary buttons, counts, and highlights." },
  { id: "border", label: "Border", hint: "Hairlines and control outlines." },
  { id: "focus", label: "Focus Ring", hint: "Keyboard focus and active selection halo." },
  { id: "terminalBackground", label: "Terminal", hint: "Terminal canvas background." }
];

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeHexColor(value: any, fallback: string) {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(trimmed)) {
    return trimmed;
  }
  if (/^#[0-9a-f]{3}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }
  return fallback;
}

function parseHexColor(value: string): RgbColor {
  const normalized = normalizeHexColor(value, "#000000");
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16)
  };
}

function rgbToHex(color: RgbColor) {
  return `#${[color.r, color.g, color.b]
    .map((channel) => clampNumber(Math.round(channel), 0, 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function mixColors(left: string, right: string, rightWeight: number) {
  const from = parseHexColor(left);
  const to = parseHexColor(right);
  const weight = clampNumber(rightWeight, 0, 1);
  return rgbToHex({
    r: from.r + (to.r - from.r) * weight,
    g: from.g + (to.g - from.g) * weight,
    b: from.b + (to.b - from.b) * weight
  });
}

function withAlpha(color: string, alpha: number) {
  const rgb = parseHexColor(color);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clampNumber(alpha, 0, 1).toFixed(3)})`;
}

function relativeLuminance(color: string) {
  const { r, g, b } = parseHexColor(color);
  const normalize = (channel: number) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const rr = normalize(r);
  const gg = normalize(g);
  const bb = normalize(b);
  return 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
}

function pickReadableText(background: string, darkText = "#111827", lightText = "#f8fafc") {
  return relativeLuminance(background) > 0.45 ? darkText : lightText;
}

function normalizeThemePalette(raw: any, fallback: ThemeSeedPalette): ThemeSeedPalette {
  const next: Partial<ThemeSeedPalette> = {};
  for (const field of THEME_COLOR_FIELDS) {
    next[field.id] = normalizeHexColor(raw?.[field.id], fallback[field.id]);
  }
  return next as ThemeSeedPalette;
}

function normalizeThemeDefinition(raw: any, index: number): ThemeDefinition {
  return {
    id:
      typeof raw?.id === "string" && raw.id.trim()
        ? raw.id.trim()
        : `custom-theme-${index + 1}`,
    name:
      typeof raw?.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : `Custom Theme ${index + 1}`,
    description: typeof raw?.description === "string" ? raw.description.trim() : "",
    light: normalizeThemePalette(raw?.light, DEFAULT_THEME_PALETTE_LIGHT),
    dark: normalizeThemePalette(raw?.dark, DEFAULT_THEME_PALETTE_DARK)
  };
}

function isThemeAppearance(value: any): value is ThemeAppearance {
  return value === "system" || value === "light" || value === "dark";
}

function themePreferencesFromState(): ThemePreferences {
  const customThemes = Array.isArray(state.preferences.themeCustomThemes)
    ? state.preferences.themeCustomThemes.map((theme, index) => normalizeThemeDefinition(theme, index))
    : [];
  const allThemes = [...BUILT_IN_THEMES, ...customThemes];
  const activeThemeId =
    typeof state.preferences.themeActiveId === "string" &&
    allThemes.some((theme) => theme.id === state.preferences.themeActiveId)
      ? state.preferences.themeActiveId
      : DEFAULT_THEME_PREFERENCES.activeThemeId;

  return {
    appearance: isThemeAppearance(state.preferences.themeAppearance)
      ? state.preferences.themeAppearance
      : DEFAULT_THEME_PREFERENCES.appearance,
    activeThemeId,
    customThemes
  };
}

function allThemes(themePreferences = themePreferencesFromState()) {
  return [...BUILT_IN_THEMES, ...themePreferences.customThemes];
}

function resolveTheme(themePreferences = themePreferencesFromState()) {
  return (
    allThemes(themePreferences).find((theme) => theme.id === themePreferences.activeThemeId) ||
    BUILT_IN_THEMES[0]
  );
}

function isCustomTheme(themeId: string, themePreferences = themePreferencesFromState()) {
  return themePreferences.customThemes.some((theme) => theme.id === themeId);
}

function resolvedThemeMode(themePreferences = themePreferencesFromState()): ThemeMode {
  if (themePreferences.appearance === "light" || themePreferences.appearance === "dark") {
    return themePreferences.appearance;
  }
  return colorSchemeQuery.matches ? "dark" : "light";
}

function themePalette(theme: ThemeDefinition, mode: ThemeMode) {
  return mode === "dark" ? theme.dark : theme.light;
}

function buildThemeCssVariables(theme: ThemeDefinition, mode: ThemeMode) {
  const palette = themePalette(theme, mode);
  const isDark = mode === "dark";
  const primaryForeground = pickReadableText(palette.primary);
  const terminalForeground = pickReadableText(
    palette.terminalBackground,
    mixColors(palette.text, "#000000", 0.16),
    "#f4f7fb"
  );
  const secondary = mixColors(palette.surface, palette.background, isDark ? 0.18 : 0.45);
  const muted = mixColors(palette.surface, palette.background, isDark ? 0.12 : 0.55);
  const accent = mixColors(palette.surface, palette.primary, isDark ? 0.18 : 0.12);
  const accentForeground = pickReadableText(accent, palette.text, "#f8fafc");
  const sidebarSurface = mixColors(palette.surface, palette.background, isDark ? 0.06 : 0.18);
  const accent2 = mixColors(palette.primary, palette.text, isDark ? 0.18 : 0.24);
  const terminalBlue = mixColors(palette.primary, isDark ? "#60a5fa" : "#2563eb", 0.55);
  const terminalMagenta = mixColors(palette.primary, isDark ? "#c084fc" : "#9333ea", 0.40);

  return {
    "--background": palette.background,
    "--foreground": palette.text,
    "--card": palette.surface,
    "--card-foreground": palette.text,
    "--popover": mixColors(palette.surface, palette.background, isDark ? 0.1 : 0.28),
    "--popover-foreground": palette.text,
    "--primary": palette.primary,
    "--primary-foreground": primaryForeground,
    "--secondary": secondary,
    "--secondary-foreground": palette.text,
    "--muted": muted,
    "--muted-foreground": palette.mutedText,
    "--accent": accent,
    "--accent-foreground": accentForeground,
    "--destructive": isDark ? "#ef6363" : "#d14a4a",
    "--destructive-foreground": "#ffffff",
    "--border": palette.border,
    "--input": palette.border,
    "--ring": palette.focus,
    "--chart-1": mixColors(palette.primary, "#f59e0b", 0.28),
    "--chart-2": mixColors(palette.primary, palette.text, 0.32),
    "--chart-3": mixColors(palette.primary, palette.background, 0.55),
    "--chart-4": mixColors(palette.surface, palette.background, isDark ? 0.18 : 0.56),
    "--chart-5": mixColors(palette.surface, "#ffffff", isDark ? 0.04 : 0.8),
    "--sidebar": sidebarSurface,
    "--sidebar-foreground": palette.text,
    "--sidebar-primary": palette.primary,
    "--sidebar-primary-foreground": primaryForeground,
    "--sidebar-accent": accent,
    "--sidebar-accent-foreground": palette.text,
    "--sidebar-border": palette.border,
    "--sidebar-ring": palette.focus,
    "--border-strong": mixColors(palette.border, palette.text, isDark ? 0.22 : 0.12),
    "--accent-2": accent2,
    "--field-bg": mixColors(palette.surface, palette.background, isDark ? 0.06 : 0.6),
    "--surface-soft": mixColors(palette.surface, palette.background, isDark ? 0.08 : 0.22),
    "--surface-muted": mixColors(palette.surface, palette.background, isDark ? 0.16 : 0.38),
    "--surface-active": mixColors(palette.surface, palette.primary, isDark ? 0.14 : 0.1),
    "--surface-active-border": withAlpha(
      mixColors(palette.border, palette.primary, 0.52),
      isDark ? 0.28 : 0.4
    ),
    "--sidebar-surface": withAlpha(sidebarSurface, isDark ? 0.98 : 0.96),
    "--app-glow-top": withAlpha(palette.primary, isDark ? 0.18 : 0.12),
    "--app-glow-bottom": withAlpha(
      mixColors(palette.primary, palette.background, 0.7),
      isDark ? 0.14 : 0.08
    ),
    "--focus-ring": withAlpha(palette.focus, isDark ? 0.24 : 0.18),
    "--warn-bg": withAlpha("#f59e0b", isDark ? 0.28 : 0.16),
    "--warn-border": withAlpha("#f59e0b", isDark ? 0.42 : 0.32),
    "--badge-bg": mixColors(palette.surface, palette.background, isDark ? 0.12 : 0.48),
    "--status-live-bg": withAlpha("#22c55e", isDark ? 0.26 : 0.16),
    "--status-live-fg": isDark ? "#b7f5cd" : "#166534",
    "--status-danger-bg": withAlpha("#ef4444", isDark ? 0.24 : 0.14),
    "--status-danger-fg": isDark ? "#fecaca" : "#b91c1c",
    "--status-muted-bg": mixColors(palette.surface, palette.background, isDark ? 0.18 : 0.4),
    "--status-muted-fg": palette.mutedText,
    "--count-bg": palette.primary,
    "--count-fg": primaryForeground,
    "--dialog-backdrop": withAlpha(isDark ? "#050505" : palette.text, isDark ? 0.54 : 0.18),
    "--terminal-background": palette.terminalBackground,
    "--terminal-foreground": terminalForeground,
    "--terminal-cursor": palette.focus,
    "--terminal-cursor-accent": palette.terminalBackground,
    "--terminal-selection": withAlpha(palette.primary, isDark ? 0.32 : 0.22),
    "--terminal-shell-top": withAlpha(palette.primary, isDark ? 0.16 : 0.1),
    "--terminal-shell-bottom": withAlpha(
      mixColors(palette.primary, palette.background, 0.65),
      isDark ? 0.12 : 0.06
    ),
    "--terminal-scrollbar": withAlpha(palette.mutedText, 0.25),
    "--terminal-ansi-black": mixColors(palette.terminalBackground, "#000000", isDark ? 0.45 : 0.68),
    "--terminal-ansi-red": isDark ? "#f87171" : "#dc2626",
    "--terminal-ansi-green": isDark ? "#4ade80" : "#16a34a",
    "--terminal-ansi-yellow": isDark ? "#facc15" : "#ca8a04",
    "--terminal-ansi-blue": terminalBlue,
    "--terminal-ansi-magenta": terminalMagenta,
    "--terminal-ansi-cyan": isDark ? "#22d3ee" : "#0891b2",
    "--terminal-ansi-white": mixColors(terminalForeground, "#ffffff", isDark ? 0.12 : 0.02),
    "--terminal-ansi-bright-black": mixColors(palette.mutedText, palette.terminalBackground, 0.2),
    "--terminal-ansi-bright-red": isDark ? "#fca5a5" : "#ef4444",
    "--terminal-ansi-bright-green": isDark ? "#86efac" : "#22c55e",
    "--terminal-ansi-bright-yellow": isDark ? "#fde047" : "#eab308",
    "--terminal-ansi-bright-blue": mixColors(terminalBlue, "#ffffff", isDark ? 0.18 : 0.08),
    "--terminal-ansi-bright-magenta": mixColors(terminalMagenta, "#ffffff", isDark ? 0.18 : 0.08),
    "--terminal-ansi-bright-cyan": isDark ? "#67e8f9" : "#06b6d4",
    "--terminal-ansi-bright-white": isDark ? "#ffffff" : mixColors(terminalForeground, "#ffffff", 0.22)
  };
}

function cacheThemeBootstrap(themePreferences = themePreferencesFromState()) {
  try {
    const theme = resolveTheme(themePreferences);
    localStorage.setItem(
      THEME_BOOTSTRAP_STORAGE_KEY,
      JSON.stringify({
        appearance: themePreferences.appearance,
        lightVars: buildThemeCssVariables(theme, "light"),
        darkVars: buildThemeCssVariables(theme, "dark")
      })
    );
  } catch {}
}

function applyThemePreferences(themePreferences = themePreferencesFromState()) {
  const mode = resolvedThemeMode(themePreferences);
  const theme = resolveTheme(themePreferences);
  const variables = buildThemeCssVariables(theme, mode);
  const root = document.documentElement;

  root.classList.toggle("dark", mode === "dark");
  root.dataset.themeId = theme.id;
  root.dataset.themeMode = mode;

  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }

  cacheThemeBootstrap(themePreferences);
}

function refreshTerminalThemes() {
  for (const mount of ui.terminalMounts.values()) {
    mount.terminal.options.theme = buildTerminalTheme();
  }

  for (const overlay of Object.values(ui.ephemeralToolOverlays)) {
    if (overlay.terminalMount) {
      overlay.terminalMount.terminal.options.theme = buildTerminalTheme();
    }
  }
}

function updateThemePreferencesInState(themePreferences: ThemePreferences) {
  state.preferences = {
    ...state.preferences,
    themeAppearance: themePreferences.appearance,
    themeActiveId: themePreferences.activeThemeId,
    themeCustomThemes: themePreferences.customThemes
  };
}

async function persistThemePreferences(themePreferences: ThemePreferences) {
  updateThemePreferencesInState(themePreferences);
  applyThemePreferences(themePreferences);
  refreshTerminalThemes();
  await api.updatePreferences({
    themeAppearance: themePreferences.appearance,
    themeActiveId: themePreferences.activeThemeId,
    themeCustomThemes: themePreferences.customThemes
  });
}

function nextCustomThemeName(themePreferences = themePreferencesFromState()) {
  const existingNames = new Set(
    themePreferences.customThemes.map((theme) => theme.name.trim().toLowerCase()).filter(Boolean)
  );
  let index = 1;
  while (existingNames.has(index === 1 ? "custom theme" : `custom theme ${index}`)) {
    index += 1;
  }
  return index === 1 ? "Custom Theme" : `Custom Theme ${index}`;
}

function createCustomTheme(themePreferences = themePreferencesFromState()) {
  const base = resolveTheme(themePreferences);
  return {
    id: `custom-theme-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: nextCustomThemeName(themePreferences),
    description: `Custom palette based on ${base.name}.`,
    light: { ...base.light },
    dark: { ...base.dark }
  } satisfies ThemeDefinition;
}

applyThemePreferences();

if (typeof colorSchemeQuery.addEventListener === "function") {
  colorSchemeQuery.addEventListener("change", handleColorSchemeChange);
} else if (typeof colorSchemeQuery.addListener === "function") {
  colorSchemeQuery.addListener(handleColorSchemeChange);
}

document.addEventListener("click", handleClick);
document.addEventListener("input", handleInput);
document.addEventListener("change", handleChange);
document.addEventListener("focusin", handleFocusIn, true);
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
planReviewDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closePlanReviewDialog();
});

for (const [toolId, definition] of Object.entries(EPHEMERAL_TOOL_DIALOGS) as Array<
  [EphemeralToolId, (typeof EPHEMERAL_TOOL_DIALOGS)[EphemeralToolId]]
>) {
  definition.dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeEphemeralToolOverlay(toolId);
  });
}

api.onStateChanged((nextState) => {
  replaceState(nextState);
  syncPlanReviewsFromState();
  ensureValidSelection();
  syncViewedSessionReadState();
  renderSidebar();
  renderDetail();
  renderDialogs();
});

api.onSessionOutput((payload) => {
  const session = appendSessionOutput(payload.sessionId, payload.data, payload.session);
  syncSessionPlanReview(session, { autoOpen: true });
  if (ui.activePlanReviewSessionId === payload.sessionId) {
    renderPlanReviewDialog();
  }
  syncViewedSessionReadState(payload.sessionId);
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
  syncSessionPlanReview(session, { autoOpen: false });
  if (ui.activePlanReviewSessionId === payload.session?.id) {
    renderPlanReviewDialog();
  }
  syncViewedSessionReadState(payload.session?.id);
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

api.onPlanDetected(({ sessionId, markdown }) => {
  const session = sessionById(sessionId);
  if (!session) return;

  const fingerprint = markdown;
  const existing = ui.sessionPlanReviews.get(sessionId);
  ui.sessionPlanReviews.set(sessionId, {
    sessionId,
    markdown,
    fingerprint,
    detectedAt: new Date().toISOString()
  });

  if (!existing || existing.fingerprint !== fingerprint) {
    ui.lastAutoOpenedPlanFingerprintBySession.set(sessionId, fingerprint);
    openPlanReviewDialog(sessionId);
  }
});

api.onCommand(async ({ command, sessionId, repoId }) => {
  const targetRepoId = repoId || currentRepoId();
  switch (command) {
    case "new-session":
      await startDefaultAgentSession(targetRepoId);
      break;
    case "open-wiki":
      await openWiki(targetRepoId);
      break;
    case "initialize-wiki":
      await initializeWiki(targetRepoId);
      break;
    case "refresh-wiki":
      await runWikiAgentAction("refresh", targetRepoId);
      break;
    case "lint-wiki":
      await runWikiAgentAction("lint", targetRepoId);
      break;
    case "ask-wiki":
      await runWikiAgentAction("ask", targetRepoId);
      break;
    case "reveal-wiki":
      if (targetRepoId) {
        await api.revealWiki(targetRepoId);
      }
      break;
    case "toggle-wiki":
      await toggleWiki(targetRepoId);
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
    case "build-and-run-app":
      await runConfiguredApp(repoId || currentRepoId());
      break;
    case "configure-build-and-run-app":
      openAppLaunchDialog(repoId || currentRepoId());
      break;
    default:
      break;
  }
});

initialize().catch((error) => {
  detailElement.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
});

function handleColorSchemeChange() {
  applyThemePreferences();
  refreshTerminalThemes();
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
    black: readCssVar("--terminal-ansi-black", "#161616"),
    red: readCssVar("--terminal-ansi-red", "#ff7b72"),
    green: readCssVar("--terminal-ansi-green", "#7ee787"),
    yellow: readCssVar("--terminal-ansi-yellow", "#e3b341"),
    blue: readCssVar("--terminal-ansi-blue", "#79c0ff"),
    magenta: readCssVar("--terminal-ansi-magenta", "#d2a8ff"),
    cyan: readCssVar("--terminal-ansi-cyan", "#a5f3fc"),
    white: readCssVar("--terminal-ansi-white", "#c9d1d9"),
    brightBlack: readCssVar("--terminal-ansi-bright-black", "#6e7681"),
    brightRed: readCssVar("--terminal-ansi-bright-red", "#ffa198"),
    brightGreen: readCssVar("--terminal-ansi-bright-green", "#56d364"),
    brightYellow: readCssVar("--terminal-ansi-bright-yellow", "#e3b341"),
    brightBlue: readCssVar("--terminal-ansi-bright-blue", "#79c0ff"),
    brightMagenta: readCssVar("--terminal-ansi-bright-magenta", "#d2a8ff"),
    brightCyan: readCssVar("--terminal-ansi-bright-cyan", "#56d4dd"),
    brightWhite: readCssVar("--terminal-ansi-bright-white", "#f0f6fc")
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
  state.tokscaleInstalled = !!nextState.tokscaleInstalled;
  applyThemePreferences();
  refreshTerminalThemes();
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

function syncViewedSessionReadState(sessionId = ui.selection.type === "session" ? ui.selection.id : null) {
  if (ui.selection.type !== "session" || !sessionId || ui.selection.id !== sessionId) {
    return;
  }

  const session = sessionById(sessionId);
  if (!session || session.unreadCount < 1) {
    return;
  }

  void api.setFocusedSession(sessionId);
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
  const multiSelSig = ui.selectedSessionIds.size ? [...ui.selectedSessionIds].sort().join(",") : "";
  return `${inboxCount}|${railSig}|${drawerSig}|${selSig}|${ui.sidebarNavItem}|${ui.sidebarExpandedRepoId}|${multiSelSig}`;
}

function renderSidebar() {
  const sig = sidebarSignature();
  if (sidebarElement.dataset.sig === sig) {
    syncSectionFocusUi();
    return;
  }
  sidebarElement.dataset.sig = sig;

  const expandedRepo = expandedSidebarRepo();

  replaceDomChildren(
    sidebarElement,
    dom(
      "div",
      { className: classNames("sidebar-shell", expandedRepo ? "sidebar-shell-expanded" : undefined) },
      dom(
        "div",
        { className: "sidebar-rail" },
        dom(
          "div",
          { className: "sidebar-rail-top" },
          renderInboxRailButton(),
          dom("div", { className: "sidebar-rail-divider" }),
          ...renderProjectRailButtons()
        ),
        dom(
          "div",
          { className: "sidebar-rail-bottom" },
          renderSidebarUtilityButton(
            "open-workspace",
            "Add Folder",
            "workspace",
            sidebarNavMatches(sidebarActionNavId("open-workspace")) ? "keyboard-active" : ""
          ),
          renderSidebarUtilityButton(
            "create-project",
            "New Folder",
            "folder",
            sidebarNavMatches(sidebarActionNavId("create-project")) ? "keyboard-active" : ""
          ),
          renderSidebarUtilityButton(
            "open-status",
            "Dev Ports",
            "status",
            classNames(
              selectionMatches("status") ? "active" : undefined,
              sidebarNavMatches(sidebarActionNavId("open-status")) ? "keyboard-active" : undefined
            )
          ),
          renderSidebarUtilityButton(
            "open-settings",
            "Settings",
            "settings",
            sidebarNavMatches(sidebarActionNavId("open-settings")) ? "keyboard-active" : ""
          ),
          renderSidebarUtilityButton(
            "collapse-sidebar",
            "Hide Sidebar",
            "collapse",
            sidebarNavMatches(sidebarActionNavId("collapse-sidebar")) ? "keyboard-active" : ""
          )
        )
      ),
      expandedRepo ? renderSidebarProjectDrawer(expandedRepo) : null
    )
  );

  syncSectionFocusUi();
}

function renderSidebarUtilityButton(
  action: string,
  label: string,
  iconKind: Parameters<typeof renderUtilityIcon>[0],
  extraClass = ""
) {
  return dom(
    "button",
    {
      className: classNames("sidebar-rail-button", "sidebar-utility-button", extraClass || undefined),
      attrs: {
        "data-action": action,
        "data-tooltip": label,
        title: label,
        "aria-label": label
      }
    },
    renderUtilityIconElement(iconKind)
  );
}

function renderInboxRailButton() {
  const count = inboxSessions().length;

  return dom(
    "button",
    {
      className: classNames(
        "sidebar-rail-button",
        "sidebar-home-button",
        selectionMatches("inbox") ? "active" : undefined,
        sidebarNavMatches("inbox") ? "keyboard-active" : undefined
      ),
      attrs: {
        "data-action": "select-inbox",
        "data-tooltip": "Inbox",
        title: "Inbox",
        "aria-label": "Inbox"
      }
    },
    renderUtilityIconElement("inbox"),
    count
      ? dom("span", { className: "sidebar-rail-badge" }, count > 9 ? "9+" : String(count))
      : null
  );
}

function renderProjectRailButtons() {
  if (!state.repos.length) {
    return [dom("div", { className: "sidebar-rail-empty", attrs: { "data-tooltip": "Add a folder to start" } }, "?")];
  }

  return [...state.repos]
    .sort(compareRepos)
    .map((repo) => renderProjectRailButton(repo));
}

function renderProjectRailButton(repo) {
  const sessions = sessionsForRepo(repo.id);
  const liveCount = sessions.filter((session) => session.runtimeState === "live").length;
  const attentionCount = sessions.filter((session) => session.blocker || session.unreadCount > 0).length;
  const active = currentRepoId() === repo.id;
  const expanded = ui.sidebarExpandedRepoId === repo.id;
  const badgeLabel = attentionCount ? (attentionCount > 9 ? "9+" : String(attentionCount)) : "";

  return dom(
    "button",
    {
      className: classNames(
        "sidebar-rail-button",
        "sidebar-project-button",
        active ? "active" : undefined,
        expanded ? "expanded" : undefined,
        sidebarNavMatches(repo.id) ? "keyboard-active" : undefined
      ),
      attrs: {
        "data-action": "select-repo",
        "data-repo-id": repo.id,
        "data-tooltip": repo.name,
        title: repo.name,
        "aria-label": repo.name
      }
    },
    dom(
      "span",
      { className: "sidebar-project-avatar", attrs: { "aria-hidden": "true" } },
      renderProjectAvatarElement(repo)
    ),
    badgeLabel
      ? dom("span", { className: "sidebar-rail-badge" }, badgeLabel)
      : liveCount
        ? dom("span", { className: "sidebar-rail-dot" })
        : null
  );
}

function renderSidebarProjectDrawer(repo) {
  const sessions = sessionsForRepo(repo.id);

  return dom(
    "section",
    {
      className: "sidebar-project-drawer",
      attrs: { tabindex: "-1", "data-repo-id": repo.id }
    },
    dom(
      "div",
      { className: "sidebar-project-drawer-header" },
      dom(
        "div",
        { className: "sidebar-project-drawer-title-row" },
        dom(
          "div",
          { className: "sidebar-project-drawer-avatar", attrs: { "aria-hidden": "true" } },
          renderProjectAvatarElement(repo)
        ),
        dom(
          "div",
          { className: "sidebar-project-drawer-copy" },
          dom("div", { className: "sidebar-project-drawer-title" }, repo.name),
          dom("div", { className: "sidebar-project-drawer-path" }, abbreviateHome(repo.path))
        )
      ),
      dom(
        "button",
        {
          className: "ghost sidebar-project-drawer-close",
          attrs: {
            "data-action": "collapse-sidebar-project",
            "data-repo-id": repo.id,
            "aria-label": `Collapse ${repo.name}`
          }
        },
        "Close"
      )
    ),
    dom(
      "div",
      { className: "detail-actions" },
      dom("button", { attrs: { "data-action": "browse-files", "data-repo-id": repo.id } }, "Files"),
      dom("button", { attrs: { "data-action": "open-wiki", "data-repo-id": repo.id } }, "Wiki"),
      dom(
        "button",
        { attrs: { "data-action": "toggle-wiki", "data-repo-id": repo.id } },
        repo.wikiEnabled ? "Disable" : "Enable"
      ),
      dom(
        "button",
        {
          className: "primary",
          attrs: { "data-action": "open-launcher", "data-repo-id": repo.id }
        },
        "New Session"
      )
    ),
    dom("div", { className: "sidebar-project-drawer-section-label" }, "Sessions"),
    dom(
      "div",
      { className: "sidebar-project-drawer-list" },
      ...(sessions.length
        ? sessions.map((session) => renderSidebarDrawerSession(session, repo))
        : [dom("div", { className: "sidebar-project-drawer-empty" }, "No sessions yet.")])
    )
  );
}

function renderSidebarDrawerSession(session, repo) {
  const multiSelected = ui.selectedSessionIds.has(session.id);
  const button = dom(
    "button",
    {
      className: classNames(
        "session-row",
        session.isPinned ? "session-row-pinned" : undefined,
        selectionMatches("session", session.id) ? "active" : undefined,
        multiSelected ? "session-row-selected" : undefined
      ),
      attrs: {
        "data-action": "select-session",
        "data-session-id": session.id
      }
    },
    dom(
      "div",
      { className: "row-title" },
      dom(
        "span",
        { className: "row-title-main" },
        renderSessionVisualElement(session, "session-visual-list"),
        dom("span", { className: "row-title-text" }, session.title)
      ),
      dom(
        "span",
        { className: "row-title-meta" },
        renderSessionRestartInlineElement(session),
        session.isPinned ? renderSessionPinIndicatorElement("Pin") : null,
        session.unreadCount && state.preferences.showInAppBadges
          ? dom("span", { className: "unread-dot" })
          : null
      )
    ),
    dom("div", { className: "row-subtitle" }, repo.name),
    dom("div", { className: "row-meta" }, previewTranscript(session.transcript))
  );

  setSessionDragAttributes(button, session.id, "list");
  return button;
}

function renderBulkActionBar(currentRepoId: string) {
  if (ui.selectedSessionIds.size < 2) {
    return "";
  }

  const otherRepos = state.repos.filter((r) => r.id !== currentRepoId);
  const moveOptions = otherRepos.map((r) =>
    `<button class="bulk-action-move-target" data-action="bulk-move-sessions" data-target-repo-id="${r.id}">${escapeHtml(r.name)}</button>`
  ).join("");

  return `
    <div class="bulk-action-bar">
      <span class="bulk-action-count">${ui.selectedSessionIds.size} selected</span>
      <div class="bulk-action-buttons">
        ${otherRepos.length ? `
          <div class="bulk-action-move-group">
            <button class="bulk-action-btn" data-action="bulk-move-toggle">Move to\u2026</button>
            <div class="bulk-move-menu" style="display:none">
              ${moveOptions}
            </div>
          </div>
        ` : ""}
        <button class="bulk-action-btn bulk-action-danger" data-action="bulk-delete-sessions">Delete</button>
        <button class="bulk-action-btn bulk-action-cancel" data-action="bulk-clear-selection">Cancel</button>
      </div>
    </div>
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

  const sessions = sessionsForRepo(repo.id);

  detailElement.innerHTML = `
    <section class="detail-panel" ${sessions.length ? `data-lasso-container data-lasso-repo-id="${repo.id}"` : ""}>
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
          ? `<div class="repo-session-list">
              ${sessions.map((session) => renderRepoSession(session)).join("")}
            </div>
            ${renderBulkActionBar(repo.id)}`
          : `<div class="empty-state">Start a shell session for this folder.</div>`
      }
      ${sessions.length ? `<div class="lasso-rect" style="display:none"></div>` : ""}
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

  const markdownContext: MarkdownRenderContext =
    ui.wikiContextRepoId && ui.wikiSelectedPath
      ? { kind: "wiki", repoId: ui.wikiContextRepoId, currentPath: ui.wikiSelectedPath }
      : { kind: "plain", repoId: currentRepoId() };

  return `
    <div class="wiki-panel-header">
      <div>
        <div class="row-title">${escapeHtml(pathLabel(ui.wikiSelectedPath))}</div>
        <div class="row-subtitle mono">${escapeHtml(ui.wikiSelectedPath)}</div>
      </div>
    </div>
    <div class="wiki-preview-markdown markdown-body">
      ${renderMarkdownDocument(ui.wikiPreviewMarkdown, markdownContext)}
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
  const repoId = currentRepoId();
  if (!repoId) return;

  const loadId = ++ui.fileBrowserLoadId;
  ui.fileBrowserSelectedPath = filePath;
  ui.fileBrowserFileContent = null;
  ui.fileBrowserFileTooLarge = false;
  ui.fileBrowserLoadingFile = true;
  if (ui.selection.type === "files") renderDetail();

  try {
    const result = await api.readFile({ repoId, filePath });
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

function formatBytes(value) {
  const size = Number(value || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return "0 B";
  }

  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(size >= 10 * 1024 ? 0 : 1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function formatRelativeDate(value) {
  if (!value) {
    return "Updated recently";
  }

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return "Updated recently";
  }

  const delta = Date.now() - timestamp.getTime();
  const absDelta = Math.abs(delta);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (absDelta < hour) {
    const minutes = Math.max(1, Math.round(absDelta / minute));
    return `${minutes} ${pluralize(minutes, "minute", "minutes")} ago`;
  }

  if (absDelta < day) {
    const hours = Math.max(1, Math.round(absDelta / hour));
    return `${hours} ${pluralize(hours, "hour", "hours")} ago`;
  }

  const days = Math.max(1, Math.round(absDelta / day));
  if (days < 30) {
    return `${days} ${pluralize(days, "day", "days")} ago`;
  }

  return timestamp.toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function renderSessionDetail(session) {
  if (!session) {
    replaceDomChildren(detailElement, emptyStateElement("This session is no longer available."));
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
    replaceDomChildren(
      detailElement,
      dom(
        "section",
        { className: "session-workspace-detail" },
        dom("div", { attrs: { id: "session-workspace-toolbar" } }),
        dom(
          "div",
          { className: "session-workspace-canvas", attrs: { id: "session-workspace-canvas" } },
          layout
            ? renderSessionWorkspaceLayoutNode(layout)
            : emptyStateElement("Drag a session here to start a workspace layout.")
        )
      )
    );
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
    return null;
  }

  if (node.type === "leaf") {
    return renderSessionPane(node.sessionId);
  }

  const sizes = node.sizes && node.sizes.length === node.children.length
    ? node.sizes
    : node.children.map(() => 1);

  const split = dom(
    "div",
    {
      className: `session-workspace-split session-workspace-split-${node.axis}`,
      attrs: { "data-split-path": path }
    }
  );

  node.children.forEach((child, i) => {
    if (i > 0) {
      split.appendChild(
        dom("div", {
          className: `pane-resize-handle pane-resize-handle-${node.axis}`,
          attrs: {
            "data-split-path": path,
            "data-handle-index": String(i - 1)
          }
        })
      );
    }
    const childPath = path ? `${path}.${i}` : `${i}`;
    const childElement = dom("div", { className: "split-child" }, renderSessionWorkspaceLayoutNode(child, childPath));
    childElement.style.flex = `${sizes[i]} 1 0%`;
    childElement.style.minWidth = "0";
    childElement.style.minHeight = "0";
    split.appendChild(childElement);
  });

  return split;
}

function renderSessionPane(sessionId) {
  const session = sessionById(sessionId);
  if (!session) {
    return null;
  }

  return dom(
    "article",
    {
      className: classNames(
        "session-pane",
        session.isPinned ? "session-pane-pinned" : undefined,
        selectionMatches("session", session.id) ? "session-pane-active" : undefined
      ),
      attrs: { "data-session-id": session.id }
    },
    dom(
      "div",
      { className: "session-pane-drop-indicator" },
      dom("span", { className: "session-pane-drop-label" })
    ),
    dom(
      "div",
      {
        className: "session-pane-main",
        attrs: {
          tabindex: "-1",
          "data-action": "select-session-pane",
          "data-session-id": session.id
        }
      },
      dom("div", { className: "session-pane-header" }),
      dom("div", { className: "session-pane-blocker" })
    ),
    dom(
      "div",
      {
        className: classNames(
          "session-pane-terminal-wrap",
          session.runtimeState === "live" ? undefined : "session-pane-terminal-wrap-paused"
        ),
        attrs: { tabindex: "-1" }
      },
      dom(
        "div",
        { className: "session-terminal-shell", attrs: { "data-session-id": session.id } },
        dom("div", { className: "session-terminal", attrs: { "data-session-id": session.id } })
      ),
      dom("div", { className: "session-pane-paused-notice" })
    )
  );
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

  const sig = `${session.id}|${session.title}|${session.runtimeState}|${visibleSessionCount}|${repo?.id}|${session.isPinned}|${session.tagColor || ""}|${session.sessionIconUrl || ""}|${session.sessionIconUpdatedAt || ""}`;
  if (toolbar.dataset.sig === sig) {
    return;
  }
  toolbar.dataset.sig = sig;

  replaceDomChildren(
    toolbar,
    dom(
      "div",
      { className: "ws-toolbar" },
      dom(
        "div",
        { className: "ws-toolbar-info" },
        renderSessionVisualButtonElement(
          session,
          "session-visual-toolbar",
          "import-session-icon",
          session.sessionIconUrl ? "Replace session icon" : "Upload session icon"
        ),
        dom("span", { className: "ws-toolbar-title" }, session.title),
        session.isPinned
          ? renderSessionPinIndicatorElement("Pinned", "session-pin-indicator-toolbar")
          : null,
        dom("span", { className: "ws-toolbar-sep" }, "/"),
        dom("span", { className: "ws-toolbar-repo" }, repo?.name || "Unknown"),
        dom(
          "span",
          { className: "ws-toolbar-meta" },
          `${visibleSessionCount} ${pluralize(visibleSessionCount, "pane", "panes")}`
        )
      ),
      dom(
        "div",
        { className: "ws-toolbar-actions" },
        dom(
          "div",
          { className: "ws-layout-group", attrs: { role: "group", "aria-label": "Layout" } },
          dom(
            "button",
            { className: "ws-layout-btn", attrs: { "data-action": "workspace-layout-columns", title: "Side by side" } },
            "Cols"
          ),
          dom(
            "button",
            { className: "ws-layout-btn", attrs: { "data-action": "workspace-layout-stack", title: "Stacked vertically" } },
            "Stack"
          ),
          dom(
            "button",
            {
              className: "ws-layout-btn",
              attrs: {
                "data-action": "workspace-layout-grid",
                title: "2x2 Grid",
                disabled: visibleSessionCount > 1 ? undefined : true
              }
            },
            "Grid"
          )
        ),
        dom(
          "button",
          {
            className: classNames("ws-action-btn", session.isPinned ? "ws-action-btn-active" : undefined),
            attrs: { "data-action": "toggle-session-pin", "data-session-id": session.id }
          },
          session.isPinned ? "Unpin" : "Pin"
        ),
        renderSessionTagSelectElement(session, "session-tag-select-toolbar"),
        session.sessionIconUrl
          ? dom(
              "button",
              {
                className: "ws-action-btn",
                attrs: { "data-action": "clear-session-icon", "data-session-id": session.id }
              },
              "Clear Icon"
            )
          : null,
        dom(
          "button",
          {
            className: "ws-action-btn primary",
            attrs: { "data-action": "open-launcher", "data-repo-id": repo?.id || "" }
          },
          "+ Session"
        ),
        dom("button", { className: "ws-action-btn", attrs: { "data-action": "open-wiki", "data-repo-id": repo?.id || "" } }, "Wiki"),
        dom(
          "button",
          { className: "ws-action-btn", attrs: { "data-action": "open-tokscale", "data-repo-id": repo?.id || "" } },
          "Tokens"
        ),
        dom("button", { className: "ws-action-btn", attrs: { "data-action": "open-lazygit", "data-repo-id": repo?.id || "" } }, "Git"),
        dom(
          "button",
          {
            className: "ws-action-btn",
            attrs: {
              "data-action": "open-settings",
              "data-settings-tab": "claude",
              "data-settings-claude-view": "skills"
            }
          },
          "Skills"
        ),
        dom(
          "button",
          {
            className: "ws-action-btn",
            attrs: {
              "data-action": "open-settings",
              "data-settings-tab": "claude",
              "data-settings-claude-view": "plugins"
            }
          },
          "Plugins"
        ),
        dom(
          "button",
          { className: "ws-action-btn", attrs: { "data-action": "open-settings", "data-settings-tab": "claude" } },
          "Agent Files"
        ),
        dom("button", { className: "ws-action-btn", attrs: { "data-action": "collapse-navbar" } }, "Hide Bar"),
        renderSessionRestartButtonElement(session, {
          className: "ws-action-btn",
          primary: session.runtimeState !== "live"
        }),
        dom(
          "button",
          { className: "ws-action-btn ws-action-danger", attrs: { "data-action": "close-session", "data-session-id": session.id } },
          "End"
        )
      )
    )
  );
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
  pane.classList.toggle("session-pane-pinned", !!session.isPinned);
  terminalWrap.classList.toggle("session-pane-terminal-wrap-paused", session.runtimeState !== "live");

  const isRenaming = ui.renamingSessionId === session.id;
  const planFingerprint = planReviewForSession(session.id)?.fingerprint || "";
  const headerSig = `${session.title}|${session.status}|${session.runtimeState}|${isRenaming}|${session.isPinned}|${session.tagColor || ""}|${session.sessionIconUrl || ""}|${session.sessionIconUpdatedAt || ""}|${planFingerprint}|${ui.navbarCollapsed}`;
  if (header.dataset.sig !== headerSig) {
    header.dataset.sig = headerSig;
    replaceDomChildren(header, renderSessionPaneHeader(session, isRenaming));
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

  const blockerSig = session.blocker
    ? `${session.blocker.kind}|${session.blocker.summary}|${session.runtimeState}|${planFingerprint}`
    : planFingerprint
      ? `plan|${planFingerprint}`
      : "";
  if (blockerElement.dataset.sig !== blockerSig) {
    blockerElement.dataset.sig = blockerSig;
    replaceDomChildren(blockerElement, renderSessionBlocker(session));
  }

  const pausedSig = session.runtimeState === "live"
    ? ""
    : `${session.runtimeState}|${sessionAgentId(session) || ""}`;
  if (pausedNotice.dataset.sig !== pausedSig) {
    pausedNotice.dataset.sig = pausedSig;
    replaceDomChildren(pausedNotice, renderPausedSessionNotice(session));
  }
}

function renderSessionPaneHeader(session, isRenaming: boolean) {
  const planReview = planReviewForSession(session.id);
  const paneBar = dom(
    "div",
    {
      className: "pane-bar",
      attrs: isRenaming ? {} : { title: "Drag to reorder" }
    },
    dom(
      "div",
      { className: "pane-bar-left" },
      dom("span", { className: "pane-grip", attrs: { "aria-hidden": "true" } }, "\u2801\u2801\u2801"),
      renderSessionVisualElement(session, "session-visual-pane"),
      isRenaming
        ? dom("input", {
            className: "pane-title-input",
            value: ui.renamingSessionTitle,
            attrs: {
              type: "text",
              "data-session-rename-input": "true",
              "data-session-id": session.id,
              "aria-label": "Rename session"
            }
          })
        : dom("span", { className: "pane-title" }, session.title),
      session.isPinned
        ? renderSessionPinIndicatorElement("Pin", "session-pin-indicator-compact")
        : null,
      dom(
        "span",
        { className: `status-badge status-${session.status}` },
        statusLabel(session.status)
      )
    ),
    dom(
      "div",
      { className: "pane-bar-right" },
      ui.navbarCollapsed
        ? dom(
            "button",
            {
              className: "pane-action-btn pane-show-navbar-btn",
              attrs: {
                "data-action": "expand-navbar",
                "data-no-drag": "true",
                title: "Show toolbar"
              }
            },
            "Show Bar"
          )
        : null,
      isRenaming
        ? dom(
            "button",
            {
              className: "pane-action-btn",
              attrs: {
                "data-action": "cancel-session-rename",
                "data-session-id": session.id,
                "data-no-drag": "true",
                title: "Cancel rename"
              }
            },
            "Cancel"
          )
        : dom(
            "button",
            {
              className: "pane-action-btn",
              attrs: {
                "data-action": "start-session-rename",
                "data-session-id": session.id,
                "data-no-drag": "true",
                title: "Rename tab"
              }
            },
            "Rename"
          ),
      planReview
        ? dom(
            "button",
            {
              className: "pane-action-btn",
              attrs: {
                "data-action": "open-plan-review",
                "data-session-id": session.id,
                "data-no-drag": "true",
                title: "Review latest plan"
              }
            },
            "Review Plan"
          )
        : null,
      renderSessionRestartButtonElement(session, {
        className: "pane-action-btn",
        primary: session.runtimeState !== "live",
        noDrag: true
      }),
      dom(
        "button",
        {
          className: "pane-action-btn pane-hide-btn",
          attrs: {
            "data-action": "remove-session-pane",
            "data-session-id": session.id,
            "data-no-drag": "true",
            title: "Hide pane"
          }
        },
        "\u00D7"
      )
    )
  );

  if (!isRenaming) {
    setSessionDragAttributes(paneBar, session.id, "pane");
  }

  return paneBar;
}

function renderSessionBlocker(session) {
  if (!session.blocker) {
    return null;
  }

  const planReview = planReviewForSession(session.id);
  const canReplyToApproval = session.blocker.kind === "approval" && session.runtimeState === "live";

  return dom(
    "div",
    { className: "blocker-banner" },
    dom(
      "div",
      {},
      dom("div", { className: "row-title" }, blockerLabel(session.blocker.kind)),
      dom("div", { className: "row-subtitle" }, session.blocker.summary)
    ),
    canReplyToApproval || planReview
      ? dom(
          "div",
          { className: "session-actions" },
          planReview
            ? dom(
                "button",
                {
                  attrs: { "data-action": "open-plan-review", "data-session-id": session.id }
                },
                "Review Plan"
              )
            : null,
          canReplyToApproval
            ? dom(
                "button",
                {
                  className: "primary",
                  attrs: { "data-action": "approve-blocker", "data-session-id": session.id }
                },
                "Approve"
              )
            : null,
          canReplyToApproval
            ? dom("button", { attrs: { "data-action": "deny-blocker", "data-session-id": session.id } }, "Deny")
            : null
        )
      : null
  );
}

function renderPlanReviewDialog() {
  const sessionId = ui.activePlanReviewSessionId;
  const session = sessionById(sessionId || "");
  const planReview = sessionId ? planReviewForSession(sessionId) : null;
  const repo = session ? repoById(session.repoID) : null;
  const canReplyToApproval = !!(
    session &&
    (session.blocker?.kind === "approval" || session.blocker?.kind === "planMode") &&
    session.runtimeState === "live"
  );

  replaceDomChildren(
    planReviewDialog,
    dom(
      "div",
      { className: "dialog-body dialog-body-plan-review" },
      dom(
        "div",
        { className: "dialog-header" },
        dom(
          "div",
          {},
          dom("div", { className: "eyebrow" }, "Codex Plan Review"),
          dom("h2", { className: "dialog-title" }, session?.title || "Plan Review"),
          dom(
            "div",
            { className: "muted" },
            repo ? abbreviateHome(repo.path) : "No active session selected."
          )
        ),
        dom(
          "button",
          {
            attrs: {
              type: "button",
              "data-action": "close-plan-review"
            }
          },
          "Close"
        )
      ),
      !planReview
        ? emptyStateElement("No proposed plan is available for this session.")
        : dom(
            "div",
            { className: "dialog-panel dialog-panel-plan-review" },
            !canReplyToApproval
              ? dom(
                  "div",
                  { className: "plan-review-note" },
                  session?.runtimeState === "live"
                    ? "Waiting for Codex to reach the approval prompt before sending a decision."
                    : "This session is not live, so approval actions are unavailable."
                )
              : null,
            trustedElement(
              `<div class="plan-review-markdown markdown-body">${renderMarkdownDocument(planReview.markdown, { kind: "plain", repoId: session?.repoID || null })}</div>`
            )
          ),
      dom(
        "div",
        { className: "dialog-footer" },
        dom(
          "button",
          {
            attrs: {
              type: "button",
              "data-action": "deny-plan-review",
              disabled: canReplyToApproval ? undefined : true
            }
          },
          "Deny"
        ),
        dom(
          "button",
          {
            className: "primary",
            attrs: {
              type: "button",
              "data-action": "approve-plan-review",
              disabled: canReplyToApproval ? undefined : true
            }
          },
          "Approve"
        )
      )
    )
  );
}

function renderPausedSessionNotice(session) {
  if (session.runtimeState === "live") {
    return null;
  }

  const body = `This session is paused. Restart it to relaunch ${restartTargetAgentLabel()} in this project.`;

  return dom(
    "div",
    { className: "terminal-paused-notice" },
    dom(
      "div",
      {},
      dom("div", { className: "row-title" }, restartSessionActionLabel()),
      dom("div", { className: "row-subtitle" }, body)
    ),
    renderSessionRestartButtonElement(session, { className: "primary" })
  );
}

function restartSessionActionLabel() {
  return "Restart";
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
    // Replay can contain terminal queries (OSC/CSI) that trigger xterm
    // responses. Wire stdin forwarding only after replay to avoid sending
    // those protocol responses into the live shell as commands.
    terminal.onData((data) => {
      api.sendInput(session.id, data);
    });
    terminal.onBinary((data) => {
      api.sendBinaryInput(session.id, data);
    });
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
    <button class="inbox-card ${session.isPinned ? "session-card-pinned" : ""} ${mainListSelectionMatches(session.id) ? "keyboard-active" : ""}" data-action="select-session" data-session-id="${session.id}" ${renderSessionDragAttributes(session.id, "list")}>
      <div class="row-title">
        <span class="row-title-main">
          ${renderSessionVisual(session, "session-visual-list")}
          <span class="row-title-text">${escapeHtml(session.title)}</span>
        </span>
        <span class="row-title-meta">
          ${renderSessionRestartInline(session)}
          ${session.isPinned ? renderSessionPinIndicator("Pin") : ""}
          <span class="status-badge status-${escapeHtml(session.status)}">${escapeHtml(statusLabel(session.status))}</span>
        </span>
      </div>
      <div class="row-subtitle">${escapeHtml(repo?.name || "Unknown Repo")}</div>
      <div class="row-meta">${escapeHtml(session.blocker?.summary || previewTranscript(session.transcript))}</div>
    </button>
  `;
}

function projectSessionStateLabel(session) {
  return session.runtimeState === "live" ? "Running" : "Idle";
}

function renderRepoSession(session) {
  const multiSelected = ui.selectedSessionIds.has(session.id);
  return `
    <button class="session-row ${session.isPinned ? "session-row-pinned" : ""} ${selectionMatches("session", session.id) ? "active" : ""} ${mainListSelectionMatches(session.id) ? "keyboard-active" : ""} ${multiSelected ? "session-row-selected" : ""}" data-action="select-session" data-session-id="${session.id}" ${renderSessionDragAttributes(session.id, "list")}>
      <div class="row-title">
        <span class="row-title-main">
          ${renderSessionVisual(session, "session-visual-list")}
          <span class="row-title-text">${escapeHtml(session.title)}</span>
        </span>
        <span class="row-title-meta">
          ${renderSessionRestartInline(session)}
          ${session.isPinned ? renderSessionPinIndicator("Pin") : ""}
          <span class="status-badge ${session.runtimeState === "live" ? "status-running" : "status-idle"}">${projectSessionStateLabel(session)}</span>
        </span>
      </div>
    </button>
  `;
}

function renderDialogs() {
  renderQuickSwitcherDialog();
  renderSessionSearchDialog();
  renderCommandPaletteDialog();
  renderPlanReviewDialog();
  if (settingsDialog.open) {
    renderSettingsDialog();
  }
}

function renderQuickSwitcherDialog() {
  const normalized = ui.quickSwitcherQuery.trim().toLowerCase();
  const sessions = state.sessions
    .filter((session) => {
      if (!normalized) {
        return true;
      }
      const repoName = (repoById(session.repoID)?.name || "").toLowerCase();
      return session.title.toLowerCase().includes(normalized) || repoName.includes(normalized);
    })
    .sort(compareSessions);
  const repos = state.repos.filter((repo) => {
    if (!normalized) {
      return true;
    }
    return repo.name.toLowerCase().includes(normalized) || repo.path.toLowerCase().includes(normalized);
  });

  replaceDomChildren(
    quickSwitcherDialog,
    dom(
      "form",
      { className: "dialog-body", attrs: { method: "dialog" } },
      dom(
        "div",
        { className: "dialog-header" },
        dom(
          "div",
          {},
          dom("div", { className: "eyebrow" }, "Quick Switcher"),
          dom("h2", { className: "dialog-title" }, "Jump instantly")
        ),
        dom("button", { attrs: { value: "cancel" } }, "Close")
      ),
      dom("input", {
        value: ui.quickSwitcherQuery,
        attrs: {
          id: "quick-switcher-query",
          placeholder: "Search sessions or folders"
        }
      }),
      dom(
        "div",
        { className: "dialog-panel" },
        dom("div", { className: "section-label" }, "Sessions"),
        dom(
          "div",
          { className: "dialog-list" },
          ...sessions.slice(0, 20).map((session) => renderQuickSwitcherSessionRow(session))
        ),
        dom("div", { className: "section-label" }, "Folders"),
        dom(
          "div",
          { className: "dialog-list" },
          ...repos.slice(0, 20).map((repo) => renderQuickSwitcherRepoRow(repo))
        )
      )
    )
  );
}

function renderQuickSwitcherSessionRow(session) {
  return dom(
    "button",
    {
      className: classNames("switcher-row", session.isPinned ? "session-card-pinned" : undefined),
      attrs: {
        type: "button",
        "data-action": "switch-session",
        "data-session-id": session.id
      }
    },
    dom(
      "div",
      { className: "row-title" },
      dom(
        "span",
        { className: "row-title-main" },
        renderSessionVisualElement(session, "session-visual-list"),
        dom("span", { className: "row-title-text" }, session.title)
      ),
      dom(
        "span",
        { className: "row-title-meta" },
        session.isPinned ? renderSessionPinIndicatorElement("Pin") : null
      )
    ),
    dom("div", { className: "row-subtitle" }, repoById(session.repoID)?.name || "Unknown Repo")
  );
}

function renderQuickSwitcherRepoRow(repo) {
  return dom(
    "button",
    {
      className: "switcher-row",
      attrs: {
        type: "button",
        "data-action": "switch-repo",
        "data-repo-id": repo.id
      }
    },
    dom("div", { className: "row-title" }, repo.name),
    dom("div", { className: "row-subtitle" }, abbreviateHome(repo.path))
  );
}

function commandPaletteShortcutForAction(action: string): string | null {
  const kb = getKeybindings();
  const actionToKeybinding: Record<string, KeybindingAction> = {
    "open-workspace": "open-folder",
    "create-project": "create-folder",
    "open-launcher": "new-session",
    "build-and-run-app": "build-and-run-app",
    "open-wiki": "open-wiki",
    "open-quick-switcher": "quick-switcher",
    "open-tokscale": "open-tokscale",
    "next-unread": "next-unread",
    "open-lazygit": "open-lazygit"
  };
  const keybindingAction = actionToKeybinding[action];
  return keybindingAction ? formatAccelerator(kb[keybindingAction]) : null;
}

function renderCommandPaletteDialog() {
  const commands = [
    { id: "open-workspace", label: "Open Folder", action: "open-workspace" },
    { id: "create-project", label: "Create Folder", action: "create-project" },
    { id: "open-launcher", label: "New Session", action: "open-launcher" },
    { id: "build-and-run-app", label: "Build and Run App", action: "build-and-run-app" },
    { id: "configure-build-and-run-app", label: "Configure App Launch", action: "configure-build-and-run-app" },
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

  replaceDomChildren(
    commandPaletteDialog,
    dom(
      "form",
      { className: "dialog-body", attrs: { method: "dialog" } },
      dom(
        "div",
        { className: "dialog-header" },
        dom(
          "div",
          {},
          dom("div", { className: "eyebrow" }, "Command Palette"),
          dom("h2", { className: "dialog-title" }, "Run a command")
        ),
        dom("button", { attrs: { value: "cancel" } }, "Close")
      ),
      dom("input", {
        value: ui.commandPaletteQuery,
        attrs: {
          id: "command-palette-query",
          placeholder: "Search commands"
        }
      }),
      dom(
        "div",
        { className: "dialog-list" },
        ...filtered.map((command) => renderCommandPaletteRow(command))
      )
    )
  );
}

function renderCommandPaletteRow(command: { action: string; label: string }) {
  const shortcut = commandPaletteShortcutForAction(command.action);
  return dom(
    "button",
    {
      className: "command-row",
      attrs: {
        type: "button",
        "data-action": command.action
      }
    },
    dom("div", { className: "row-title" }, command.label),
    shortcut
      ? dom(
          "kbd",
          { className: "shortcut-hint" },
          renderAcceleratorMarkupElement(shortcut)
        )
      : null
  );
}

function renderSessionSearchDialog() {
  const repo = repoById(ui.sessionSearchRepoId || "");
  const selectedResult = selectedSessionSearchResult();
  const sectionLabel = dom(
    "div",
    { className: "section-label", attrs: { style: "display:flex;align-items:center;justify-content:space-between;" } },
    dom("span", {}, "Matches"),
    ui.sessionSearchResults.length > 0
      ? dom(
          "span",
          { className: "session-search-kbd-hint" },
          dom("span", { className: "session-search-kbd" }, "\u2191"),
          dom("span", { className: "session-search-kbd" }, "\u2193"),
          " navigate \u00A0",
          dom("span", { className: "session-search-kbd" }, "\u21B5"),
          " open"
        )
      : null
  );

  replaceDomChildren(
    sessionSearchDialog,
    dom(
      "form",
      { className: "dialog-body", attrs: { method: "dialog" } },
      dom(
        "div",
        { className: "dialog-header" },
        dom(
          "div",
          {},
          dom("div", { className: "eyebrow" }, "Session Search"),
          dom("h2", { className: "dialog-title" }, "Search Claude and Codex session files"),
          dom(
            "div",
            { className: "muted" },
            repo ? abbreviateHome(repo.path) : "Select a project to search its session files."
          )
        ),
        dom("button", { attrs: { value: "cancel" } }, "Close")
      ),
      dom("input", {
        value: ui.sessionSearchQuery,
        attrs: {
          id: "session-search-query",
          placeholder: "Search this project's Claude and Codex sessions"
        }
      }),
      dom(
        "div",
        { className: "session-search-filter-bar" },
        ...renderSessionSearchFilterButtons()
      ),
      dom(
        "div",
        { className: "dialog-panel" },
        sectionLabel,
        dom(
          "div",
          { className: "dialog-list session-search-list" },
          ...renderSessionSearchBody()
        )
      ),
      selectedResult
        ? dom(
            "div",
            { className: "dialog-footer" },
            dom(
              "button",
              {
                attrs: {
                  type: "button",
                  "data-action": "reveal-session-search-result",
                  "data-result-index": String(ui.sessionSearchSelectedIndex)
                }
              },
              "Reveal File"
            ),
            canResumeSessionSearchResult(selectedResult)
              ? dom(
                  "button",
                  {
                    className: "primary",
                    attrs: {
                      type: "button",
                      "data-action": "resume-session-search-result",
                      "data-result-index": String(ui.sessionSearchSelectedIndex)
                    }
                  },
                  "Resume from here"
                )
              : null
          )
        : null
    )
  );
}

function renderSessionSearchFilterButtons() {
  const claudeCount = ui.sessionSearchResults.filter((r) => r.source === "claude").length;
  const codexCount = ui.sessionSearchResults.filter((r) => r.source === "codex").length;
  const totalCount = ui.sessionSearchResults.length;
  const hasResults = totalCount > 0;

  const makeButton = (
    filter: "all" | "claude" | "codex",
    label: string,
    count: number
  ) => {
    const isActive = ui.sessionSearchFilter === filter;
    return dom(
      "button",
      {
        className: classNames(
          "session-search-filter-button",
          `session-search-filter-button-${filter}`,
          isActive ? "active" : undefined
        ),
        attrs: {
          type: "button",
          "data-action": "session-search-filter",
          "data-filter-value": filter
        }
      },
      label,
      hasResults
        ? dom("span", { className: "session-search-filter-count" }, String(count))
        : null
    );
  };

  return [
    makeButton("all", "All", totalCount),
    makeButton("claude", "Claude", claudeCount),
    makeButton("codex", "Codex", codexCount),
  ];
}

function renderSessionSearchBody() {
  if (!ui.sessionSearchRepoId) {
    return [emptyStateElement("Open or select a project first.")];
  }

  if (ui.sessionSearchError) {
    return [emptyStateElement(ui.sessionSearchError)];
  }

  if (!ui.sessionSearchQuery.trim()) {
    return [emptyStateElement("Type to search only this project's Claude and Codex session files.")];
  }

  if (ui.sessionSearchLoading) {
    return [
      dom(
        "div",
        { className: "session-search-loading-state" },
        dom("div", { className: "session-search-spinner" }),
        "Searching session files\u2026"
      )
    ];
  }

  if (!ui.sessionSearchResults.length) {
    return [emptyStateElement("No matching session content found for this project.")];
  }

  const indexedResults = ui.sessionSearchResults
    .map((result, originalIndex) => ({ result, originalIndex }))
    .filter(({ result }) => ui.sessionSearchFilter === "all" || result.source === ui.sessionSearchFilter);

  if (!indexedResults.length) {
    const label = ui.sessionSearchFilter === "claude" ? "Claude" : "Codex";
    return [emptyStateElement(`No ${label} sessions matched. Try a different filter.`)];
  }

  return indexedResults
    .map(({ result, originalIndex: index }) => {
      const sourceLabel = result.source === "claude" ? "Claude" : "Codex";
      const normalizedPreview = normalizeJsonlPreview(result.preview);
      const canResume = canResumeSessionSearchResult(result);
      const shortId = result.sessionId ? result.sessionId.slice(0, 8) : null;
      return dom(
        "div",
        {
          className: classNames(
            "session-search-row",
            index === ui.sessionSearchSelectedIndex ? "active" : undefined
          ),
          attrs: {
            "data-action": "select-session-search-result",
            "data-result-index": String(index)
          }
        },
        dom(
          "div",
          { className: "row-title" },
          dom("span", {}, result.title),
          dom(
            "span",
            {
              className: classNames(
                "session-search-source",
                `session-search-source-${result.source}`
              )
            },
            sourceLabel
          )
        ),
        dom(
          "div",
          { className: "row-subtitle mono" },
          `${shortId ? `${shortId} \u00B7 ` : ""}${pathLeafLabel(result.filePath)}:${String(result.lineNumber || 1)}`
        ),
        dom("div", { className: "row-meta" }, normalizedPreview),
        dom(
          "div",
          { className: "session-search-actions" },
          dom(
            "button",
            {
              attrs: {
                type: "button",
                "data-action": "reveal-session-search-result",
                "data-result-index": String(index)
              }
            },
            "Reveal"
          ),
          canResume
            ? dom(
                "button",
                {
                  className: "primary",
                  attrs: {
                    type: "button",
                    "data-action": "resume-session-search-result",
                    "data-result-index": String(index)
                  }
                },
                "Resume from here"
              )
            : null
        )
      );
    });
}

async function renderSettingsDialog() {
  const repoId = currentRepoId();
  if (!ui.settingsContext) {
    ui.settingsContext = await api.getClaudeSettingsContext(repoId);
  }

  await ensureSettingsSelection();

  const savedScrollTop = (settingsDialog.querySelector(".settings-dialog-body") as HTMLElement | null)?.scrollTop ?? 0;

  settingsDialog.innerHTML = `
    <form method="dialog" class="dialog-body settings-dialog-body ${ui.settingsTab === "themes" ? "settings-dialog-body-sticky-header" : ""}">
      <div class="settings-dialog-header-shell">
        <div class="dialog-header settings-dialog-header">
          <div>
            <div class="eyebrow">Settings</div>
            <h2 class="dialog-title">Preferences and agent files</h2>
            <div class="muted">Edit app preferences, project instructions, custom skills, plugin toggles, and JSON settings in one place.</div>
          </div>
          <button value="cancel">Close</button>
        </div>

        <div class="settings-tabs">
          <button type="button" class="settings-tab ${ui.settingsTab === "general" ? "active" : ""}" data-action="settings-tab" data-tab="general">General</button>
          <button type="button" class="settings-tab ${ui.settingsTab === "themes" ? "active" : ""}" data-action="settings-tab" data-tab="themes">Themes</button>
          <button type="button" class="settings-tab ${ui.settingsTab === "keybindings" ? "active" : ""}" data-action="settings-tab" data-tab="keybindings">Keybindings</button>
          <button type="button" class="settings-tab ${ui.settingsTab === "claude" ? "active" : ""}" data-action="settings-tab" data-tab="claude">Agent Files</button>
        </div>
      </div>

      <div class="settings-dialog-content">
        ${
          ui.settingsTab === "general"
            ? renderGeneralSettingsPane()
            : ui.settingsTab === "themes"
              ? renderThemesSettingsPane()
              : ui.settingsTab === "keybindings"
              ? renderKeybindingsSettingsPane()
              : renderClaudeSettingsPane()
        }
      </div>
    </form>
  `;

  if (savedScrollTop > 0) {
    const body = settingsDialog.querySelector(".settings-dialog-body") as HTMLElement | null;
    if (body) body.scrollTop = savedScrollTop;
  }
}

async function ensureSettingsSelection() {
  if (ui.settingsTab !== "claude") {
    await ensureClaudeFileSelection();
    return;
  }

  if (ui.settingsClaudeView === "skills") {
    await ensureClaudeSkillSelection();
    return;
  }

  if (ui.settingsClaudeView === "marketplace") {
    await ensureClaudeMarketplaceSelection();
    return;
  }

  if (ui.settingsClaudeView === "plugins") {
    await ensureClaudePluginSelection();
    return;
  }

  await ensureClaudeFileSelection();
}

async function ensureClaudeFileSelection() {
  const availableFiles = allSettingsFiles();
  const selectedExists = availableFiles.some((file) => file.path === ui.settingsSelectedFilePath);

  if (!selectedExists) {
    const firstFile = availableFiles[0];
    if (firstFile) {
      await loadSelectedSettingsFile(firstFile.path);
    }
  }
}

async function ensureClaudePluginSelection() {
  const availableFiles = editableClaudeJsonFiles();
  const selectedExists = availableFiles.some((file) => file.path === ui.settingsSelectedFilePath);

  if (!selectedExists) {
    const preferredFile = preferredClaudeJsonFile(availableFiles);
    if (preferredFile) {
      await loadSelectedSettingsFile(preferredFile.path);
      return;
    }
  }

  if (!availableFiles.length) {
    clearSelectedSettingsFile();
  }
}

async function ensureClaudeSkillSelection() {
  const availableSkills = allClaudeSkills();
  const selectedExists = availableSkills.some((skill) => skill.path === ui.settingsSelectedFilePath);

  if (!selectedExists) {
    const preferredSkill =
      availableSkills.find((skill) => skill.editable && skill.sourceType === "project") ||
      availableSkills.find((skill) => skill.editable) ||
      availableSkills[0];

    if (preferredSkill) {
      await loadSelectedSettingsFile(preferredSkill.path);
      return;
    }
  }

  if (!availableSkills.length) {
    clearSelectedSettingsFile();
  }
}

async function ensureClaudeMarketplaceSelection() {
  const canInstallProject = !!repoById(currentRepoId())?.path;
  ui.marketplacePreferredScope = resolvedMarketplaceScope(canInstallProject);

  const selectedExists = ui.marketplaceResults.some((result) => result.id === ui.marketplaceSelectedId);
  if (!selectedExists) {
    ui.marketplaceSelectedId =
      ui.marketplaceResults.find((result) => result.reviewState === "reviewed")?.id ||
      ui.marketplaceResults[0]?.id ||
      null;
  }

  if (!ui.marketplaceResults.length) {
    ui.marketplaceSelectedId = null;
    ui.marketplaceSelectedDetail = null;
    return;
  }

  if (
    ui.marketplaceSelectedDetail &&
    ui.marketplaceSelectedDetail.id !== ui.marketplaceSelectedId
  ) {
    ui.marketplaceSelectedDetail = null;
  }
}

function clearSelectedSettingsFile() {
  ui.settingsSelectedFilePath = null;
  ui.settingsEditorText = "";
  ui.settingsSaveMessage = "";
  ui.settingsJsonDraft = null;
  ui.settingsJsonError = "";
  ui.settingsShowRawJson = false;
}

function renderThemesSettingsPane() {
  const themePreferences = themePreferencesFromState();
  const themes = allThemes(themePreferences);
  const activeTheme = resolveTheme(themePreferences);
  const currentMode = resolvedThemeMode(themePreferences);
  const editingCustomTheme = isCustomTheme(activeTheme.id, themePreferences);

  return `
    <div class="settings-surface themes-settings-surface">
      <div class="settings-group-card themes-toolbar-card">
        <div class="themes-toolbar-header">
          <div class="themes-toolbar-copy">
            <div class="row-title">Theme Library</div>
            <div class="muted">Each theme includes light and dark palettes. System appearance is currently ${escapeHtml(currentMode)}.</div>
          </div>
          <div class="themes-toolbar-controls">
            <label class="themes-appearance-field">
              <div class="row-title">Appearance</div>
              <select id="pref-theme-appearance">
                <option value="system" ${themePreferences.appearance === "system" ? "selected" : ""}>System</option>
                <option value="light" ${themePreferences.appearance === "light" ? "selected" : ""}>Light</option>
                <option value="dark" ${themePreferences.appearance === "dark" ? "selected" : ""}>Dark</option>
              </select>
            </label>
            <div class="themes-toolbar-actions">
              <button type="button" data-action="theme-create-custom">Create Custom Theme</button>
              ${
                editingCustomTheme
                  ? `<button type="button" class="ws-action-danger" data-action="theme-delete-custom" data-theme-id="${escapeAttribute(activeTheme.id)}">Delete Custom Theme</button>`
                  : ""
              }
            </div>
          </div>
        </div>
      </div>

      <div class="themes-grid">
        ${themes.map((theme) => renderThemeCard(theme, themePreferences.activeThemeId, currentMode)).join("")}
      </div>

      ${
        editingCustomTheme
          ? renderCustomThemeEditor(activeTheme)
          : `
            <div class="settings-warning-card themes-readonly-card">
              <div class="row-title">Preset themes are read-only</div>
              <div class="muted">Select a preset, then create a custom theme to make your own version of it.</div>
            </div>
          `
      }
    </div>
  `;
}

function renderThemeCard(theme: ThemeDefinition, activeThemeId: string, currentMode: ThemeMode) {
  const isActive = theme.id === activeThemeId;
  const custom = isCustomTheme(theme.id);
  const activeLabel = currentMode === "dark" ? "Dark" : "Light";

  return `
    <button
      type="button"
      class="theme-card ${isActive ? "active" : ""}"
      data-action="select-theme"
      data-theme-id="${escapeAttribute(theme.id)}"
    >
      <div class="theme-card-header">
        <div>
          <div class="row-title">${escapeHtml(theme.name)}</div>
          <div class="muted">${escapeHtml(theme.description || (custom ? "Custom theme" : "Preset theme"))}</div>
        </div>
        <span class="theme-card-badge">${custom ? "Custom" : "Preset"}</span>
      </div>
      <div class="theme-card-previews">
        ${renderThemeCardPreview(theme.light, "Light")}
        ${renderThemeCardPreview(theme.dark, "Dark")}
      </div>
      <div class="theme-card-footer">
        <span>${isActive ? `Active · ${escapeHtml(activeLabel)}` : "Activate theme"}</span>
      </div>
    </button>
  `;
}

function renderThemeCardPreview(palette: ThemeSeedPalette, label: string) {
  return `
    <div class="theme-preview-window">
      <div class="theme-preview-window-shell" style="--theme-preview-bg:${escapeAttribute(palette.background)};--theme-preview-surface:${escapeAttribute(palette.surface)};--theme-preview-border:${escapeAttribute(palette.border)};--theme-preview-text:${escapeAttribute(palette.text)};--theme-preview-muted:${escapeAttribute(palette.mutedText)};--theme-preview-primary:${escapeAttribute(palette.primary)};">
        <div class="theme-preview-sidebar"></div>
        <div class="theme-preview-content">
          <div class="theme-preview-header"></div>
          <div class="theme-preview-line theme-preview-line-strong"></div>
          <div class="theme-preview-line"></div>
          <div class="theme-preview-accent"></div>
        </div>
      </div>
      <div class="theme-preview-label">${escapeHtml(label)}</div>
    </div>
  `;
}

function renderCustomThemeEditor(theme: ThemeDefinition) {
  return `
    <div class="themes-workbench">
      <div class="themes-workbench-sidebar">
        <div class="settings-group-card themes-editor-card themes-identity-card">
          <div class="themes-editor-header">
            <div>
              <div class="row-title">Custom Theme</div>
              <div class="muted">Changes apply immediately and are stored locally for this app install.</div>
            </div>
          </div>
          <label class="themes-name-field">
            <div class="row-title">Theme Name</div>
            <input
              id="theme-name-input"
              data-theme-name-input="true"
              data-theme-id="${escapeAttribute(theme.id)}"
              value="${escapeAttribute(theme.name)}"
              placeholder="Custom Theme"
            />
          </label>
        </div>

        <div class="settings-group-card themes-editor-card themes-preview-card">
          <div class="themes-editor-header">
            <div>
              <div class="row-title">Preview</div>
              <div class="muted">Keep both palettes visible while you tune them.</div>
            </div>
          </div>
          <div class="themes-preview-grid">
            ${renderThemeCardPreview(theme.light, "Light")}
            ${renderThemeCardPreview(theme.dark, "Dark")}
          </div>
        </div>
      </div>
      <div class="themes-workbench-main">
        <div class="themes-palette-grid">
          ${renderThemePaletteEditor(theme, "light")}
          ${renderThemePaletteEditor(theme, "dark")}
        </div>
      </div>
    </div>
  `;
}

function renderThemePaletteEditor(theme: ThemeDefinition, mode: ThemeMode) {
  const palette = themePalette(theme, mode);
  const title = mode === "dark" ? "Dark Palette" : "Light Palette";

  return `
    <div class="settings-group-card themes-editor-card themes-palette-card">
      <div class="themes-palette-header">
        <div class="themes-editor-header">
          <div class="row-title">${title}</div>
          <div class="muted">Interface, dialogs, and terminal colors derive from this palette.</div>
        </div>
        <div class="theme-palette-strip">
          ${THEME_COLOR_FIELDS.map(
            (field) =>
              `<span class="theme-palette-swatch" title="${escapeAttribute(field.label)}" style="--theme-swatch:${escapeAttribute(palette[field.id])};"></span>`
          ).join("")}
        </div>
      </div>
      <div class="theme-field-list">
        ${THEME_COLOR_FIELDS.map((field) => renderThemeColorField(theme.id, mode, field, palette[field.id])).join("")}
      </div>
    </div>
  `;
}

function renderThemeColorField(
  themeId: string,
  mode: ThemeMode,
  field: { id: ThemeColorFieldId; label: string; hint: string },
  value: string
) {
  return `
    <label class="theme-color-row">
      <div class="theme-color-row-copy">
        <span class="row-title">${escapeHtml(field.label)}</span>
        <span class="muted">${escapeHtml(field.hint)}</span>
      </div>
      <div class="theme-color-row-controls">
        <input
          type="color"
          class="theme-color-input"
          data-theme-color-input="true"
          data-theme-id="${escapeAttribute(themeId)}"
          data-theme-mode="${escapeAttribute(mode)}"
          data-theme-field="${escapeAttribute(field.id)}"
          value="${escapeAttribute(value)}"
        />
        <span class="theme-color-value">${escapeHtml(value)}</span>
      </div>
    </label>
  `;
}

function renderGeneralSettingsPane() {
  const selectedAgentId = defaultSessionAgentId();
  const selectedAgent = agentOption(selectedAgentId) || AGENT_OPTIONS[0];
  return `
    <div class="dialog-panel">
      <section class="settings-field-card agent-default-card">
        <div class="agent-default-grid">
          <label>
            <div class="row-title">Default Session Agent</div>
            <select id="pref-default-agent">
              ${AGENT_OPTIONS.map(
                (agent) =>
                  `<option value="${escapeAttribute(agent.id)}" ${selectedAgentId === agent.id ? "selected" : ""}>${escapeHtml(agent.label)}</option>`
              ).join("")}
            </select>
          </label>
          <label>
            <div class="row-title">Default Launch Command</div>
            <input
              data-agent-command-id="${escapeAttribute(selectedAgent.id)}"
              value="${escapeAttribute(agentCommandValue(selectedAgent.id))}"
            />
          </label>
        </div>
        <div class="muted">Every new session launches the selected agent. If you choose ${escapeHtml(selectedAgent.label)}, this command is what gets typed into the terminal on session start.</div>
      </section>

      <label>
        <div class="row-title">Shell Executable</div>
        <input id="pref-shell-executable" value="${escapeAttribute(state.preferences.shellExecutablePath || "")}" />
      </label>
      <div class="muted">Sessions start as login shells in the selected repo so you can enter and exit agents normally.</div>

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

function renderKeybindingsSettingsPane() {
  const kb = getKeybindings();
  // Build rows safely — all labels come from internal KEYBINDING_LABELS constant
  // and accelerator values are escaped as they are rendered into markup.
  const rows = ALL_KEYBINDING_ACTIONS.map((action) => {
    const label = KEYBINDING_LABELS[action];
    const current = kb[action];
    const isCustom = !!(state.preferences.keybindings && state.preferences.keybindings[action]);
    const isRecording = ui.keybindingRecordingAction === action;

    return `<div class="keybinding-row">
        <div class="keybinding-label">${escapeHtml(label)}</div>
        <div class="keybinding-value">
          <button type="button" class="keybinding-key ${isRecording ? "recording" : ""} ${isCustom ? "custom" : ""}"
            data-action="record-keybinding" data-keybinding-action="${action}">
            ${isRecording ? "Press keys..." : renderAcceleratorMarkup(current)}
          </button>
          ${isCustom ? `<button type="button" class="keybinding-reset" data-action="reset-keybinding" data-keybinding-action="${action}" title="Reset to default">Reset</button>` : ""}
        </div>
      </div>`;
  });

  return `
    <div class="dialog-panel keybindings-panel">
      <div class="muted">Click a shortcut to record a new binding. Press Escape to cancel.</div>
      <div class="keybinding-list">
        ${rows.join("")}
      </div>
    </div>
  `;
}

function renderClaudeSettingsPane() {
  const context = ui.settingsContext || {
    globalFiles: [],
    projectFiles: [],
    resolvedValues: [],
    plugins: [],
    skills: [],
    skillRoots: {}
  };

  return `
    <div class="claude-settings-stack">
      ${renderClaudeSettingsModeBar()}
      ${
        ui.settingsClaudeView === "plugins"
          ? renderClaudePluginsPane(context)
          : ui.settingsClaudeView === "marketplace"
            ? renderClaudeMarketplacePane(context)
          : ui.settingsClaudeView === "skills"
            ? renderClaudeSkillsPane(context)
            : renderClaudeFilesPane(context)
      }
    </div>
  `;
}

function renderClaudeSettingsModeBar() {
  return `
    <div class="claude-settings-mode-bar" role="tablist" aria-label="Claude settings views">
      <div class="claude-settings-mode-buttons">
        ${renderClaudeSettingsModeButton("files", "Files")}
        ${renderClaudeSettingsModeButton("skills", "Skills")}
        ${renderClaudeSettingsModeButton("marketplace", "Marketplace")}
        ${renderClaudeSettingsModeButton("plugins", "Plugins")}
      </div>
    </div>
  `;
}

function renderClaudeSettingsModeButton(view: ClaudeSettingsView, label: string) {
  return `
    <button
      type="button"
      class="claude-settings-mode-button ${ui.settingsClaudeView === view ? "active" : ""}"
      data-action="settings-claude-view"
      data-claude-view="${view}">
      ${escapeHtml(label)}
    </button>
  `;
}

function renderClaudeFilesPane(context) {
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

function renderClaudePluginsPane(context) {
  const selectedFile =
    editableClaudeJsonFiles().find((file) => file.path === ui.settingsSelectedFilePath) || null;
  const parseError = ui.settingsJsonError;
  const showRawEditor = ui.settingsShowRawJson || !!parseError;
  const currentRootValue = currentJsonSettingsValue();
  const enabledPluginsValue = currentEnabledPluginsSettingsValue();
  const canEditPlugins = !showRawEditor && isJsonObject(currentRootValue) && enabledPluginsValue !== null;

  return `
    <div class="settings-surface">
      ${
        selectedFile
          ? renderSettingsFileSummaryCard(selectedFile, [
              renderSettingsMetaPill(showRawEditor ? "Raw JSON" : "Plugin Toggles"),
              renderSettingsMetaPill(`${context.plugins?.length || 0} Known`),
              renderSettingsMetaPill(selectedFile.exists ? "Ready" : "Create on Save")
            ], { includeJsonToggle: true, forceRawEditor: !!parseError })
          : `
            <div class="settings-warning-card">
              <div class="row-title">No Claude JSON settings file is available</div>
              <div class="row-subtitle">Create a project or global settings JSON file first to edit plugins.</div>
            </div>
          `
      }

      ${
        editableClaudeJsonFiles().length
          ? `
            <div class="settings-group-card">
              <div class="settings-help-row">
                <div>
                  <div class="row-title">Save Location</div>
                  <div class="muted">Choose which Claude settings file should own the plugin overrides from this popup.</div>
                </div>
              </div>
              <div class="claude-settings-chip-row">
                ${editableClaudeJsonFiles().map((file) => renderClaudeSettingsFileChip(file)).join("")}
              </div>
            </div>
          `
          : ""
      }

      ${
        selectedFile && !canEditPlugins
          ? `
            <div class="settings-warning-card">
              <div class="row-title">This file can’t hold plugin toggles yet</div>
              <div class="row-subtitle">
                ${
                  parseError
                    ? `Fix the JSON parse error first: ${escapeHtml(parseError)}`
                    : `The root JSON value must be an object, and <span class="mono">enabledPlugins</span> must either be missing or an object.`
                }
              </div>
              <div class="settings-meta-row">
                <button type="button" data-action="settings-toggle-raw-json">Edit JSON</button>
              </div>
            </div>
          `
          : ""
      }

      ${selectedFile && showRawEditor ? renderJsonRawEditor() : ""}

      ${
        selectedFile && canEditPlugins
          ? `
            <div class="settings-add-card claude-plugin-add-card">
              <div class="row-title">Add a Plugin ID</div>
              <div class="row-subtitle">Enable a plugin directly in ${escapeHtml(friendlySettingsFileTitle(selectedFile))}.</div>
              <div class="settings-add-grid">
                <input id="plugins-new-id" type="text" placeholder="plugin-name@marketplace" />
                <label class="settings-switch claude-plugin-add-toggle">
                  <input id="plugins-new-enabled" type="checkbox" checked />
                  <span>Enabled</span>
                </label>
                <button type="button" class="primary" data-action="plugins-add-entry">Add Plugin</button>
              </div>
            </div>
          `
          : ""
      }

      ${
        showRawEditor
          ? ""
          : `
            <div class="claude-plugin-grid">
              ${
                (context.plugins || []).length
                  ? context.plugins
                      .map((plugin) => renderClaudePluginCard(plugin, canEditPlugins ? selectedFile : null))
                      .join("")
                  : `
                    <div class="settings-group-card">
                      <div class="row-title">No plugins discovered</div>
                      <div class="muted">Install or configure Claude plugins and they’ll appear here.</div>
                    </div>
                  `
              }
            </div>
          `
      }

      ${renderSettingsSaveMessage()}
    </div>
  `;
}

function renderClaudeSettingsFileChip(file) {
  return `
    <button
      type="button"
      class="claude-settings-chip-button ${ui.settingsSelectedFilePath === file.path ? "active" : ""}"
      data-action="settings-select-file"
      data-file-path="${file.path}">
      ${escapeHtml(friendlySettingsFileTitle(file))}
    </button>
  `;
}

function renderClaudePluginCard(plugin, selectedFile) {
  const fileOverride = selectedFile ? selectedEnabledPluginOverride(plugin.id) : undefined;
  const effectiveEnabled = typeof fileOverride === "boolean" ? fileOverride : plugin.enabled;
  const fileStateLabel =
    typeof fileOverride === "boolean"
      ? fileOverride
        ? "Enabled Here"
        : "Disabled Here"
      : "Inherited";
  const sourceLabel =
    typeof fileOverride === "boolean"
      ? friendlySettingsFileTitle(selectedFile)
      : plugin.sourceLabel
        ? friendlySourceLabel(plugin.sourceLabel)
        : "No explicit override";
  const checkboxPath = encodeSettingPath(["enabledPlugins", plugin.id]);

  return `
    <div class="settings-group-card claude-plugin-card">
      <div class="settings-group-header">
        <div class="settings-field-copy">
          <div class="settings-file-row-top">
            <div class="row-title">${escapeHtml(plugin.name)}</div>
            <span class="settings-chip">${effectiveEnabled ? "Enabled" : "Disabled"}</span>
          </div>
          <div class="row-subtitle mono">${escapeHtml(plugin.id)}</div>
          <div class="row-meta">${escapeHtml(sourceLabel)}</div>
        </div>
        ${
          selectedFile
            ? `
              <label class="settings-switch">
                <input
                  type="checkbox"
                  data-setting-editor="boolean"
                  data-setting-path="${checkboxPath}"
                  ${effectiveEnabled ? "checked" : ""} />
                <span>${escapeHtml(fileStateLabel)}</span>
              </label>
            `
            : ""
        }
      </div>

      <div class="claude-plugin-meta">
        <span class="settings-meta-pill">${escapeHtml(plugin.marketplace || "local")}</span>
        <span class="settings-meta-pill">${plugin.installed ? "Installed" : "Not Installed"}</span>
        ${
          plugin.version
            ? `<span class="settings-meta-pill">v${escapeHtml(plugin.version)}</span>`
            : ""
        }
        <span class="settings-meta-pill">${plugin.skillCount} ${pluralize(plugin.skillCount, "skill", "skills")}</span>
      </div>

      ${
        plugin.skillNames?.length
          ? `<div class="row-meta">${escapeHtml(plugin.skillNames.join(", "))}</div>`
          : `<div class="row-meta">No plugin-provided skills were discovered for this plugin.</div>`
      }

      ${
        selectedFile && typeof fileOverride === "boolean"
          ? `
            <div class="settings-meta-row">
              <button
                type="button"
                class="ghost"
                data-action="plugins-clear-entry"
                data-plugin-id="${escapeAttribute(plugin.id)}">
                Clear Override
              </button>
            </div>
          `
          : ""
      }
    </div>
  `;
}

function renderClaudeSkillsPane(context) {
  const skills = allClaudeSkills();
  const selectedSkill = selectedClaudeSkill();
  const projectSkills = skills.filter((skill) => skill.sourceType === "project");
  const userSkills = skills.filter((skill) => skill.sourceType === "user");
  const managedSkills = skills.filter((skill) => skill.sourceType === "managed");
  const pluginSkills = skills.filter((skill) => skill.sourceType === "plugin");

  return `
    <div class="settings-shell claude-skills-shell">
      <div class="settings-sidebar">
        <div class="settings-sidebar-sections">
          ${renderClaudeSkillCreationCard(context)}
          ${projectSkills.length ? `<div class="section-label">Project Skills</div>${projectSkills.map((skill) => renderClaudeSkillRow(skill)).join("")}` : ""}
          ${userSkills.length ? `<div class="section-label">User Skills</div>${userSkills.map((skill) => renderClaudeSkillRow(skill)).join("")}` : ""}
          ${managedSkills.length ? `<div class="section-label">Managed Skills</div>${managedSkills.map((skill) => renderClaudeSkillRow(skill)).join("")}` : ""}
          ${pluginSkills.length ? `<div class="section-label">Plugin Skills</div>${pluginSkills.map((skill) => renderClaudeSkillRow(skill)).join("")}` : ""}
          ${!skills.length ? `<div class="settings-sidebar-empty">No skills were discovered for this project yet.</div>` : ""}
        </div>
      </div>

      <div class="settings-detail-panel claude-skills-detail-panel">
        ${
          selectedSkill
            ? renderClaudeSkillPanel(selectedSkill)
            : `
              <div class="empty-state claude-skills-empty-state">
                Select a skill to inspect it. Project and user skills are editable here; plugin and managed skills are read-only.
              </div>
            `
        }
      </div>
    </div>
  `;
}

function renderClaudeMarketplacePane(context) {
  const results = ui.marketplaceResults || [];
  const selectedResult = selectedMarketplaceResult();
  const selectedDetail = ui.marketplaceSelectedDetail;
  const repo = repoById(currentRepoId());
  const canInstallProject = !!repo?.path;
  const preferredScope = resolvedMarketplaceScope(canInstallProject);

  return `
    <div class="settings-shell claude-marketplace-shell">
      <div class="settings-sidebar">
        <div class="settings-sidebar-sections">
          ${renderClaudeMarketplaceSearchCard()}
          ${
            ui.marketplaceLoading
              ? `<div class="settings-sidebar-empty">Searching GitHub for matching skills…</div>`
              : ""
          }
          ${
            ui.marketplaceError
              ? `<div class="settings-warning-card"><div class="row-title">Marketplace error</div><div class="row-subtitle">${escapeHtml(ui.marketplaceError)}</div></div>`
              : ""
          }
          ${
            results.length
              ? `<div class="section-label">Loaded Skills</div>${results.map((result) => renderMarketplaceResultRow(result)).join("")}`
              : ""
          }
          ${
            !ui.marketplaceLoading && !results.length && !ui.marketplaceError
              ? `<div class="settings-sidebar-empty">Paste a GitHub repo or skill URL to load installable skills.</div>`
              : ""
          }
        </div>
      </div>

      <div class="settings-detail-panel claude-marketplace-detail-panel">
        ${
          ui.marketplaceDetailLoading
            ? `<div class="empty-state claude-skills-empty-state">Loading skill preview…</div>`
            : selectedResult && selectedDetail && selectedDetail.id === selectedResult.id
              ? `
                <div class="settings-surface claude-marketplace-panel">
                  <div class="settings-file-summary-card marketplace-summary-card">
                    <div class="settings-file-summary-main">
                      <div class="settings-file-summary-title">
                        <div class="settings-file-copy">
                          <div class="eyebrow">${escapeHtml(selectedDetail.repoFullName)}</div>
                          <div class="row-title">${escapeHtml(selectedDetail.title)}</div>
                          <div class="row-subtitle">${escapeHtml(selectedDetail.description || "No description provided.")}</div>
                        </div>
                        <span class="settings-chip ${selectedDetail.reviewState === "reviewed" ? "settings-chip-success" : ""}">
                          ${selectedDetail.reviewState === "reviewed" ? "Reviewed" : "Unreviewed"}
                        </span>
                      </div>
                      <div class="claude-plugin-meta">
                        <span class="settings-meta-pill">${selectedDetail.stars} stars</span>
                        <span class="settings-meta-pill">${formatRelativeDate(selectedDetail.updatedAt)}</span>
                        <span class="settings-meta-pill">${selectedDetail.fileCount} ${pluralize(selectedDetail.fileCount, "file", "files")}</span>
                        ${
                          selectedDetail.compatibility?.length
                            ? selectedDetail.compatibility.map((value) => `<span class="settings-meta-pill">${escapeHtml(value)}</span>`).join("")
                            : ""
                        }
                      </div>
                      ${
                        selectedDetail.tags?.length
                          ? `<div class="claude-plugin-meta">${selectedDetail.tags.map((tag) => `<span class="settings-meta-pill">${escapeHtml(tag)}</span>`).join("")}</div>`
                          : ""
                      }
                      <div class="settings-meta-row">
                        <button type="button" class="ghost" data-action="marketplace-open-source">Open on GitHub</button>
                      </div>
                    </div>
                  </div>

                  <div class="settings-group-card marketplace-install-card">
                    <div class="settings-help-row">
                      <div>
                        <div class="row-title">Install</div>
                        <div class="muted">Choose where Claude should store this skill. The first choice becomes the default for later installs.</div>
                      </div>
                    </div>
                    <div class="settings-add-grid marketplace-install-grid">
                      <select id="marketplace-install-scope">
                        ${canInstallProject ? `<option value="project" ${preferredScope === "project" ? "selected" : ""}>Project (${escapeHtml(repo.name)})</option>` : ""}
                        <option value="user" ${preferredScope === "user" ? "selected" : ""}>User</option>
                      </select>
                      <button type="button" class="primary" data-action="marketplace-install-skill">Install Skill</button>
                    </div>
                    ${
                      ui.marketplaceInstallMessage
                        ? `<div class="row-meta">${escapeHtml(ui.marketplaceInstallMessage)}</div>`
                        : ""
                    }
                  </div>

                  <div class="settings-group-card marketplace-files-card">
                    <div class="settings-help-row">
                      <div>
                        <div class="row-title">Files</div>
                        <div class="muted">Preview the folder contents before installing.</div>
                      </div>
                    </div>
                    <div class="marketplace-file-list">
                      ${selectedDetail.files.slice(0, 24).map((file) => `<div class="marketplace-file-row"><span class="mono">${escapeHtml(file.relativePath)}</span><span class="row-meta">${formatBytes(file.size)}</span></div>`).join("")}
                      ${
                        selectedDetail.files.length > 24
                          ? `<div class="row-meta">Showing 24 of ${selectedDetail.files.length} files.</div>`
                          : ""
                      }
                    </div>
                  </div>

                  <div class="settings-editor-card claude-skill-editor-card marketplace-markdown-card">
                    <div class="settings-help-row">
                      <div>
                        <div class="row-title">SKILL.md Preview</div>
                        <div class="muted">Rendered from the GitHub source.</div>
                      </div>
                    </div>
                    <div class="wiki-preview-markdown markdown-body marketplace-markdown-preview">
                      ${renderMarkdownDocument(selectedDetail.markdown, { kind: "marketplace", source: selectedDetail.source })}
                    </div>
                  </div>
                </div>
              `
              : `
                <div class="empty-state claude-skills-empty-state">
                  Paste a GitHub URL, then select a loaded skill to preview and install it.
                </div>
              `
        }
      </div>
    </div>
  `;
}

function renderClaudeMarketplaceSearchCard() {
  return `
    <div class="settings-add-card claude-marketplace-search-card">
      <div class="row-title">Load Skills From GitHub</div>
      <div class="row-subtitle">Paste a GitHub repo URL or a direct skill folder URL.</div>
      <div class="settings-add-grid">
        <input id="marketplace-inspect-url" type="text" placeholder="https://github.com/owner/repo/tree/main/skills/skill-name" value="${escapeAttribute(ui.marketplaceInspectUrl)}" />
        <button type="button" class="primary" data-action="marketplace-load-url">Load GitHub URL</button>
      </div>
      ${
        ui.marketplaceInspectMessage
          ? `<div class="row-meta">${escapeHtml(ui.marketplaceInspectMessage)}</div>`
          : ""
      }
    </div>
  `;
}

function renderMarketplaceResultRow(result: MarketplaceSkillSummary) {
  return `
    <button
      type="button"
      class="settings-nav-row ${ui.marketplaceSelectedId === result.id ? "active" : ""}"
      data-action="marketplace-select-result"
      data-marketplace-id="${escapeAttribute(result.id)}">
      <div class="settings-nav-row-top">
        <div class="settings-nav-copy">
          <div class="row-title">${escapeHtml(result.title)}</div>
          <div class="row-subtitle">${escapeHtml(result.description || result.repoFullName)}</div>
        </div>
      </div>
      <div class="settings-nav-meta">
        <span class="settings-chip">${result.reviewState === "reviewed" ? "Reviewed" : "GitHub"}</span>
        <span class="row-meta">${escapeHtml(result.repoFullName)}</span>
      </div>
    </button>
  `;
}

function renderClaudeSkillCreationCard(context) {
  const canCreateProjectSkill = !!context.skillRoots?.project;

  return `
    <div class="settings-add-card claude-skill-add-card">
      <div class="row-title">New Skill</div>
      <div class="row-subtitle">Create a new custom Claude skill as a normal <span class="mono">SKILL.md</span> file.</div>
      <div class="settings-add-grid">
        <input id="skills-new-name" type="text" placeholder="skill-name" />
        <select id="skills-new-scope">
          ${canCreateProjectSkill ? `<option value="project">Project</option>` : ""}
          <option value="user">User</option>
        </select>
        <button type="button" class="primary" data-action="skills-create-file">Create Skill</button>
      </div>
    </div>
  `;
}

function renderClaudeSkillAvatar(skill, size = "small") {
  return skill.iconUrl
    ? `
      <span class="skill-avatar skill-avatar-${size}" aria-hidden="true">
        <img class="skill-avatar-image" src="${escapeAttribute(skill.iconUrl)}" alt="" />
      </span>
    `
    : `
      <span class="skill-avatar skill-avatar-${size} skill-avatar-fallback" aria-hidden="true">SK</span>
    `;
}

function renderClaudeSkillAvatarButton(skill, size = "large") {
  const label = skill.iconUrl ? "Replace skill icon" : "Upload skill icon";

  return skill.iconUrl
    ? `
      <button
        type="button"
        class="skill-avatar skill-avatar-${size} skill-avatar-button"
        data-action="skills-upload-icon"
        aria-label="${escapeAttribute(label)}"
        title="${escapeAttribute(label)}">
        <img class="skill-avatar-image" src="${escapeAttribute(skill.iconUrl)}" alt="" />
      </button>
    `
    : `
      <button
        type="button"
        class="skill-avatar skill-avatar-${size} skill-avatar-fallback skill-avatar-button"
        data-action="skills-upload-icon"
        aria-label="${escapeAttribute(label)}"
        title="${escapeAttribute(label)}">SK</button>
    `;
}

function renderClaudeSkillRow(skill) {
  return `
    <button
      type="button"
      class="settings-nav-row ${ui.settingsSelectedFilePath === skill.path ? "active" : ""}"
      data-action="settings-select-file"
      data-file-path="${skill.path}">
      <div class="settings-nav-row-top">
        ${renderClaudeSkillAvatar(skill)}
        <div class="settings-nav-copy">
          <div class="row-title">${escapeHtml(skill.name)}</div>
          <div class="row-subtitle">${escapeHtml(skill.description || skill.sourceLabel)}</div>
        </div>
      </div>
      <div class="settings-nav-meta">
        <span class="settings-chip">${escapeHtml(skillSourceLabel(skill))}</span>
        <span class="row-meta">${skill.editable ? "Editable" : "Read Only"}</span>
      </div>
    </button>
  `;
}

function renderClaudeSkillPanel(skill) {
  return `
    <div class="settings-surface claude-skill-panel">
      ${renderClaudeSkillSummaryCard(skill)}
      <div class="settings-editor-card claude-skill-editor-card">
        <div class="settings-help-row">
          <div>
            <div class="row-title">${skill.editable ? "Skill Editor" : "Skill Preview"}</div>
            <div class="muted">
              ${
                skill.editable
                  ? "Edit the skill markdown directly. Saving writes back to the original SKILL.md file."
                  : "This skill comes from Claude’s managed inventory or an installed plugin, so it is shown read-only here."
              }
            </div>
          </div>
          <span class="settings-chip">${skill.editable ? "Editable" : "Read Only"}</span>
        </div>
        <textarea
          id="settings-text-editor"
          class="claude-skill-editor"
          ${skill.editable ? "" : "readonly"}>${escapeHtml(ui.settingsEditorText)}</textarea>
      </div>

      ${renderSettingsSaveMessage()}
    </div>
  `;
}

function renderClaudeSkillSummaryCard(skill) {
  return `
    <div class="settings-file-summary-card">
      <div class="settings-file-summary-main">
        <div class="settings-file-summary-title">
          ${skill.editable ? renderClaudeSkillAvatarButton(skill, "large") : renderClaudeSkillAvatar(skill, "large")}
          <div class="settings-file-copy">
            <div class="eyebrow">${escapeHtml(skill.sourceLabel)}</div>
            <div class="row-title">${escapeHtml(skill.name)}</div>
            <div class="row-subtitle">${escapeHtml(abbreviateHome(skill.path))}</div>
          </div>
        </div>
        <div class="detail-actions settings-detail-actions">
          <button type="button" data-action="settings-reload-file">Reload</button>
          ${skill.editable ? `<button type="button" class="primary" data-action="settings-save-file">Save</button>` : ""}
          <button type="button" data-action="settings-reveal-file">Reveal</button>
        </div>
      </div>
      <div class="muted">${escapeHtml(skill.description || "Skill instructions loaded from disk.")}</div>
      <div class="settings-meta-row">
        ${renderSettingsMetaPill(skillSourceLabel(skill))}
        ${renderSettingsMetaPill(skill.editable ? "Editable" : "Read Only")}
        ${renderSettingsMetaPill(skill.iconUrl ? "Custom Icon" : "Default Icon")}
        ${skill.pluginId ? renderSettingsMetaPill(skill.pluginId) : ""}
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

  const pathKey = entry.path.join(".");
  const knownOptions = KNOWN_SETTINGS[pathKey]?.options;
  if (typeof value === "string" && knownOptions) {
    const hasCustomValue = value !== "" && !knownOptions.some((opt) => opt.value === value);
    return `
      <select data-setting-editor="string" data-setting-path="${encodedPath}">
        ${knownOptions.map((opt) => `<option value="${escapeAttribute(opt.value)}"${value === opt.value ? " selected" : ""}>${escapeHtml(opt.label)}</option>`).join("")}
        ${hasCustomValue ? `<option value="${escapeAttribute(value)}" selected>${escapeHtml(value)} (custom)</option>` : ""}
      </select>
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

const KNOWN_SETTINGS: Record<string, { description: string; options?: Array<{ value: string; label: string }> }> = {
  model: {
    description: "The Claude model used for all agent sessions in this scope.",
    options: [
      { value: "claude-opus-4-6", label: "Claude Opus 4.6 — Most capable" },
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 — Balanced" },
      { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 — Fastest" },
    ],
  },
  maxTokens: {
    description: "Maximum number of tokens Claude can generate in a single response.",
  },
  cleanupPeriodDays: {
    description: "Number of days before old session data is automatically removed.",
  },
  apiKeyHelper: {
    description: "Shell command used to retrieve the API key dynamically at runtime.",
  },
};

function buildSimplifiedJsonCategories(rootValue): SimplifiedJsonCategory[] {
  if (!isJsonObject(rootValue)) {
    return [];
  }

  const categories: SimplifiedJsonCategory[] = [];
  const generalEntries = Object.entries(rootValue)
    .filter(([, value]) => isEditablePrimitiveValue(value))
    .map(([key, value]) => buildSimplifiedJsonEntry([key], value, {
      label: humanizeSettingSegment(key),
      description: KNOWN_SETTINGS[key]?.description ?? "Edit this setting directly without opening raw JSON."
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
  const statusText = file.exists ? "Ready" : "Create on Save";
  return `
    <button
      type="button"
      class="settings-nav-row ${ui.settingsSelectedFilePath === file.path ? "active" : ""}"
      data-action="settings-select-file"
      data-file-path="${file.path}">
      <div class="settings-nav-row-top">
        <span class="settings-nav-icon settings-nav-icon-${escapeAttribute(settingsFileVisualKind(file))}" aria-hidden="true">${escapeHtml(settingsFileIconLabel(file))}</span>
        <div class="settings-nav-copy">
          <div class="row-title">
            <span>${escapeHtml(friendlySettingsFileTitle(file))}</span>
            <span class="settings-chip">${isJsonSettingsFile(file) ? "JSON" : "MD"}</span>
          </div>
          <div class="row-subtitle">${escapeHtml(friendlySettingsFileListSubtitle(file))} · ${escapeHtml(statusText)}</div>
        </div>
      </div>
    </button>
  `;
}

async function handleClick(event) {
  if (Date.now() < ui.lassoSuppressClickUntil) {
    return;
  }

  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }

  event.preventDefault();

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
      if (ui.selectedSessionIds.size) {
        ui.selectedSessionIds.clear();
        renderSidebar();
      }
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
    case "collapse-sidebar":
      collapseSidebarChrome();
      break;
    case "expand-sidebar":
      expandSidebarChrome();
      setFocusSection("sidebar");
      break;
    case "collapse-navbar":
      collapseWorkspaceNavbar();
      break;
    case "expand-navbar":
      expandWorkspaceNavbar({ focusToolbarControl: true });
      break;
    case "open-launcher":
      await startDefaultAgentSession(target.dataset.repoId || currentRepoId());
      break;
    case "build-and-run-app":
      await runConfiguredApp(target.dataset.repoId || currentRepoId());
      break;
    case "configure-build-and-run-app":
      openAppLaunchDialog(target.dataset.repoId || currentRepoId());
      break;
    case "close-app-launch-dialog":
      closeAppLaunchDialog();
      break;
    case "save-app-launch-config":
      if (await saveAppLaunchConfig()) {
        closeAppLaunchDialog();
      }
      break;
    case "save-and-run-app-launch":
      if (await saveAppLaunchConfig()) {
        const repoId = ui.appLaunchRepoId;
        closeAppLaunchDialog();
        await runConfiguredApp(repoId);
      }
      break;
    case "open-status":
      await selectStatus();
      break;
    case "open-settings":
      await openSettings(target.dataset.settingsTab || "general", {
        claudeView: (target.dataset.settingsClaudeView || undefined) as ClaudeSettingsView | undefined
      });
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
        const repoId = currentRepoId();
        if (repoId) {
          await api.revealPath({ scope: "repo-file", repoId, filePath: target.dataset.filePath });
        }
      }
      break;
    case "reveal-repo":
      if (target.dataset.repoId) {
        await api.openRepoInFinder(target.dataset.repoId);
      }
      break;
    case "reveal-wiki":
      {
        const repoId = target.dataset.repoId || currentRepoId();
        if (repoId) {
          await api.revealWiki(repoId);
        }
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
    case "markdown-open-github":
      if (target.dataset.url) {
        await api.openExternalUrl({ scope: "github-url", url: target.dataset.url });
      }
      break;
    case "markdown-open-wiki":
      if (target.dataset.repoId && target.dataset.wikiPath) {
        await selectWikiFile(target.dataset.repoId, target.dataset.wikiPath);
      }
      break;
    case "markdown-reveal-repo-file":
      if (target.dataset.repoId && target.dataset.relativePath) {
        await api.revealPath({
          scope: "repo-relative-file",
          repoId: target.dataset.repoId,
          relativePath: target.dataset.relativePath
        });
      }
      break;
    case "close-session":
      await closeSessionById(target.dataset.sessionId);
      break;
    case "toggle-session-pin":
      await toggleSessionPin(target.dataset.sessionId);
      break;
    case "import-session-icon":
      await importSessionIcon(target.dataset.sessionId);
      break;
    case "clear-session-icon":
      await clearSessionIcon(target.dataset.sessionId);
      break;
    case "restart-session":
      await restartSessionById(target.dataset.sessionId);
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
    case "open-plan-review":
      openPlanReviewDialog(target.dataset.sessionId);
      break;
    case "close-plan-review":
      closePlanReviewDialog();
      break;
    case "approve-plan-review":
      if (ui.activePlanReviewSessionId) {
        await api.sendInput(ui.activePlanReviewSessionId, "1\r");
        closePlanReviewDialog();
      }
      break;
    case "deny-plan-review":
      if (ui.activePlanReviewSessionId) {
        await api.sendInput(ui.activePlanReviewSessionId, "3\r");
        closePlanReviewDialog();
      }
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
    case "session-search-filter":
      ui.sessionSearchFilter = (target.dataset.filterValue || "all") as "all" | "claude" | "codex";
      ui.sessionSearchSelectedIndex = 0;
      renderSessionSearchDialogKeepFocus();
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
      if (ui.settingsTab !== "claude") {
        ui.settingsClaudeView = "files";
      }
      ui.keybindingRecordingAction = null;
      await renderSettingsDialog();
      break;
    case "settings-claude-view":
      ui.settingsClaudeView = (target.dataset.claudeView || "files") as ClaudeSettingsView;
      ui.keybindingRecordingAction = null;
      await renderSettingsDialog();
      break;
    case "marketplace-load-url":
      await inspectMarketplaceGitHubUrl();
      break;
    case "marketplace-select-result":
      await selectMarketplaceResult(target.dataset.marketplaceId || null);
      break;
    case "marketplace-open-source":
      if (ui.marketplaceSelectedDetail?.sourceUrl) {
        await api.openExternalUrl({
          scope: "github-url",
          url: ui.marketplaceSelectedDetail.sourceUrl
        });
      }
      break;
    case "marketplace-install-skill":
      await installSelectedMarketplaceSkill();
      break;
    case "select-theme": {
      const themePreferences = themePreferencesFromState();
      const themeId = target.dataset.themeId;
      if (themeId && themeId !== themePreferences.activeThemeId) {
        await persistThemePreferences({
          ...themePreferences,
          activeThemeId: themeId
        });
      }
      await renderSettingsDialog();
      break;
    }
    case "theme-create-custom": {
      const themePreferences = themePreferencesFromState();
      const customTheme = createCustomTheme(themePreferences);
      await persistThemePreferences({
        ...themePreferences,
        activeThemeId: customTheme.id,
        customThemes: [...themePreferences.customThemes, customTheme]
      });
      await renderSettingsDialog();
      break;
    }
    case "theme-delete-custom": {
      const themePreferences = themePreferencesFromState();
      const themeId = target.dataset.themeId;
      if (!themeId) {
        break;
      }
      await persistThemePreferences({
        ...themePreferences,
        activeThemeId:
          themePreferences.activeThemeId === themeId
            ? DEFAULT_THEME_PREFERENCES.activeThemeId
            : themePreferences.activeThemeId,
        customThemes: themePreferences.customThemes.filter((theme) => theme.id !== themeId)
      });
      await renderSettingsDialog();
      break;
    }
    case "record-keybinding":
      ui.keybindingRecordingAction = (target.dataset.keybindingAction || null) as KeybindingAction | null;
      await renderSettingsDialog();
      break;
    case "reset-keybinding": {
      const actionToReset = target.dataset.keybindingAction as KeybindingAction;
      if (actionToReset) {
        const currentOverrides = { ...(state.preferences.keybindings || {}) };
        delete currentOverrides[actionToReset];
        await api.updatePreferences({ keybindings: currentOverrides });
      }
      await renderSettingsDialog();
      break;
    }
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
    case "plugins-add-entry":
      addClaudePluginOverride();
      await renderSettingsDialog();
      break;
    case "plugins-clear-entry":
      if (target.dataset.pluginId) {
        clearClaudePluginOverride(target.dataset.pluginId);
        await renderSettingsDialog();
      }
      break;
    case "skills-create-file":
      await createClaudeSkillFile();
      await renderSettingsDialog();
      break;
    case "skills-upload-icon":
      await importSelectedClaudeSkillIcon();
      await renderSettingsDialog();
      break;
    case "skills-remove-icon":
      await clearSelectedClaudeSkillIcon();
      await renderSettingsDialog();
      break;
    case "settings-reveal-file":
      if (ui.settingsSelectedFilePath) {
        await api.revealPath({
          scope: "settings-file",
          repoId: currentRepoId(),
          filePath: ui.settingsSelectedFilePath
        });
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
    case "bulk-delete-sessions":
      await bulkDeleteSessions();
      break;
    case "bulk-move-sessions":
      if (target.dataset.targetRepoId) {
        await bulkMoveSessions(target.dataset.targetRepoId);
      }
      break;
    case "bulk-move-toggle": {
      const moveMenu = target.closest(".bulk-action-move-group")?.querySelector(".bulk-move-menu") as HTMLElement | null;
      if (moveMenu) {
        moveMenu.style.display = moveMenu.style.display === "none" ? "flex" : "none";
      }
      break;
    }
    case "bulk-clear-selection":
      clearBulkSelection();
      break;
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

  if (target.closest("[data-stop-row-select='true']")) {
    return;
  }

  if (target.closest("[data-no-drag='true'], [data-session-rename-input='true']")) {
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

  const lassoContainer = target.closest("[data-lasso-container]") as HTMLElement | null;
  if (
    lassoContainer &&
    !target.closest(".bulk-action-bar") &&
    !target.closest(".detail-actions")
  ) {
    const repoId = lassoContainer.dataset.lassoRepoId || null;
    ui.lassoActive = false;
    ui.lassoOriginX = event.clientX;
    ui.lassoOriginY = event.clientY;
    ui.lassoCurrentX = event.clientX;
    ui.lassoCurrentY = event.clientY;
    ui.lassoContainerRepoId = repoId;
    ui.lassoPressedSessionId =
      (target.closest(".session-row") as HTMLElement | null)?.dataset.sessionId || null;
    ui.lassoPending = true;
    setFocusSection("main");
    event.preventDefault();
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
  if (ui.lassoPending && !ui.lassoActive) {
    const dx = event.clientX - ui.lassoOriginX;
    const dy = event.clientY - ui.lassoOriginY;
    const dist = dx * dx + dy * dy;
    if (dist > 64) {
      ui.lassoActive = true;
      ui.lassoPending = false;
      ui.selectedSessionIds.clear();
    }
  }

  if (ui.lassoActive) {
    ui.lassoCurrentX = event.clientX;
    ui.lassoCurrentY = event.clientY;
    updateLassoSelection();
    event.preventDefault();
    return;
  }

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

function handlePointerUp(event: PointerEvent) {
  if (ui.lassoPending && !ui.lassoActive) {
    const pressedSessionId = ui.lassoPressedSessionId;
    ui.lassoPending = false;
    ui.lassoPressedSessionId = null;
    const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const releasedSessionId =
      (target?.closest("[data-action='select-session']") as HTMLElement | null)?.dataset.sessionId || null;
    if (pressedSessionId && (!releasedSessionId || releasedSessionId === pressedSessionId)) {
      ui.lassoSuppressClickUntil = Date.now() + 120;
      if (ui.selectedSessionIds.size) {
        ui.selectedSessionIds.clear();
        renderSidebar();
      }
      const session = sessionById(pressedSessionId);
      if (session) {
        void selectSession(pressedSessionId, sessionOpenFocusSection(session));
      }
      return;
    }
    if (ui.selectedSessionIds.size) {
      ui.lassoSuppressClickUntil = Date.now() + 120;
      clearBulkSelection();
    }
    return;
  }

  if (ui.lassoActive) {
    ui.lassoActive = false;
    ui.lassoPending = false;
    ui.lassoPressedSessionId = null;
    ui.lassoSuppressClickUntil = Date.now() + 120;
    const lassoRects = document.querySelectorAll(".lasso-rect");
    for (const el of lassoRects) {
      (el as HTMLElement).style.display = "none";
    }
    renderSidebar();
    renderDetail();
    return;
  }

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

function updateLassoSelection() {
  const repoId = ui.lassoContainerRepoId;
  const containers = document.querySelectorAll("[data-lasso-container]");
  let container: HTMLElement | null = null;
  for (const c of containers) {
    if ((c as HTMLElement).dataset.lassoRepoId === repoId) {
      container = c as HTMLElement;
      break;
    }
  }
  if (!container) return;

  const containerRect = container.getBoundingClientRect();
  const x1 = Math.min(ui.lassoOriginX, ui.lassoCurrentX);
  const y1 = Math.min(ui.lassoOriginY, ui.lassoCurrentY);
  const x2 = Math.max(ui.lassoOriginX, ui.lassoCurrentX);
  const y2 = Math.max(ui.lassoOriginY, ui.lassoCurrentY);

  const lassoEl = container.querySelector(".lasso-rect") as HTMLElement | null;
  if (lassoEl) {
    const left = Math.max(0, x1 - containerRect.left);
    const top = Math.max(0, y1 - containerRect.top + container.scrollTop);
    const right = Math.min(containerRect.width, x2 - containerRect.left);
    const bottom = y2 - containerRect.top + container.scrollTop;
    lassoEl.style.display = "block";
    lassoEl.style.left = `${left}px`;
    lassoEl.style.top = `${top}px`;
    lassoEl.style.width = `${Math.max(0, right - left)}px`;
    lassoEl.style.height = `${Math.max(0, bottom - top)}px`;
  }

  const nextSelected = new Set<string>();
  const rows = container.querySelectorAll(".session-row");
  for (const row of rows) {
    const rowRect = row.getBoundingClientRect();
    const overlaps =
      rowRect.left < x2 && rowRect.right > x1 &&
      rowRect.top < y2 && rowRect.bottom > y1;
    if (overlaps) {
      const sessionId = (row as HTMLElement).dataset.sessionId;
      if (sessionId) nextSelected.add(sessionId);
    }
  }

  if (setsEqual(nextSelected, ui.selectedSessionIds)) return;
  ui.selectedSessionIds = nextSelected;

  for (const row of rows) {
    const sessionId = (row as HTMLElement).dataset.sessionId;
    if (sessionId && nextSelected.has(sessionId)) {
      row.classList.add("session-row-selected");
    } else {
      row.classList.remove("session-row-selected");
    }
  }
}

function setsEqual(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function clearBulkSelection() {
  ui.selectedSessionIds.clear();
  ui.lassoContainerRepoId = null;
  renderSidebar();
  renderDetail();
}

async function bulkDeleteSessions() {
  const ids = [...ui.selectedSessionIds];
  const count = ids.length;
  if (!count) return;
  if (!window.confirm(`Delete ${count} session${count > 1 ? "s" : ""}?`)) return;

  ui.selectedSessionIds.clear();
  for (const id of ids) {
    removeSessionFromWorkspace(id, { persistSelection: false });
    await api.closeSession(id);
  }

  if (ui.selection.type === "session" && ids.includes(ui.selection.id)) {
    const nextVisibleSessionId = workspaceVisibleSessionIds()[0] || null;
    if (nextVisibleSessionId) {
      await selectSession(nextVisibleSessionId, "main");
    } else {
      await selectInbox();
    }
  }

  renderSidebar();
  renderDetail();
}

async function bulkMoveSessions(targetRepoId: string) {
  const ids = [...ui.selectedSessionIds];
  if (!ids.length) return;

  for (const id of ids) {
    await api.updateSessionOrganization(id, { repoID: targetRepoId });
  }

  ui.selectedSessionIds.clear();
  renderSidebar();
  renderDetail();
}

function handleDragStart(event: DragEvent) {
  if (ui.lassoPending || ui.lassoActive) {
    event.preventDefault();
    return;
  }
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

function keyboardEventToAccelerator(event: KeyboardEvent): string | null {
  // Only record when a non-modifier key is pressed
  const modifierKeys = new Set(["shift", "control", "alt", "meta", "os"]);
  if (modifierKeys.has(event.key.toLowerCase())) return null;

  const parts: string[] = [];
  const isMac = /mac/i.test(navigator.platform);

  if (event.metaKey) parts.push(isMac ? "CmdOrCtrl" : "Meta");
  if (event.ctrlKey) parts.push(isMac ? "Ctrl" : "CmdOrCtrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");

  // Require at least one modifier
  if (parts.length === 0) return null;

  const key = event.key;
  if (key === "ArrowLeft") parts.push("ArrowLeft");
  else if (key === "ArrowRight") parts.push("ArrowRight");
  else if (key === "ArrowUp") parts.push("ArrowUp");
  else if (key === "ArrowDown") parts.push("ArrowDown");
  else if (key === "Enter") parts.push("Enter");
  else if (key === "Escape") return null; // Escape cancels recording
  else if (key === "Backspace") parts.push("Backspace");
  else if (key === "Tab") parts.push("Tab");
  else if (key === " ") parts.push("Space");
  else if (key.length === 1) parts.push(key.toUpperCase());
  else parts.push(key);

  return parts.join("+");
}

async function handleKeyDown(event) {
  // Handle keybinding recording when the settings dialog is open
  if (ui.keybindingRecordingAction) {
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      ui.keybindingRecordingAction = null;
      await renderSettingsDialog();
      return;
    }

    const accelerator = keyboardEventToAccelerator(event);
    if (accelerator) {
      const currentOverrides = { ...(state.preferences.keybindings || {}) };
      // If it matches the default, remove the override instead
      if (accelerator === DEFAULT_KEYBINDINGS[ui.keybindingRecordingAction]) {
        delete currentOverrides[ui.keybindingRecordingAction];
      } else {
        currentOverrides[ui.keybindingRecordingAction] = accelerator;
      }
      await api.updatePreferences({ keybindings: currentOverrides });
      ui.keybindingRecordingAction = null;
      await renderSettingsDialog();
    }
    return;
  }

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

  const keydownTarget = event.target as HTMLElement | null;
  if (keydownTarget instanceof HTMLInputElement && settingsDialog.open) {
    if (keydownTarget.id === "marketplace-inspect-url" && event.key === "Enter") {
      event.preventDefault();
      await inspectMarketplaceGitHubUrl();
      return;
    }
  }

  if (keydownTarget instanceof HTMLInputElement && appLaunchDialog.open) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (await saveAppLaunchConfig()) {
        const repoId = ui.appLaunchRepoId;
        closeAppLaunchDialog();
        await runConfiguredApp(repoId);
      }
      return;
    }
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

  const kb = getKeybindings();

  if (matchesAccelerator(event, kb["navigate-section-left"]) || matchesAccelerator(event, kb["navigate-section-right"])) {
    const direction = matchesAccelerator(event, kb["navigate-section-left"]) ? -1 : 1;
    const handledSessionNavigation = await handleSessionWorkspaceDirectionalNavigation(
      direction < 0 ? "left" : "right"
    );
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

  if (matchesAccelerator(event, kb["navigate-section-up"]) || matchesAccelerator(event, kb["navigate-section-down"])) {
    const handledSessionNavigation = await handleSessionWorkspaceDirectionalNavigation(
      matchesAccelerator(event, kb["navigate-section-up"]) ? "up" : "down"
    );
    if (handledSessionNavigation) {
      event.preventDefault();
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
    matchesAccelerator(event, kb["open-launcher"]) &&
    (ui.focusSection === "sidebar" || ui.focusSection === "sidebar-drawer")
  ) {
    const repoId = currentRepoId();
    if (repoId) {
      event.preventDefault();
      await startDefaultAgentSession(repoId);
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

  const kb = getKeybindings();
  if (matchesAccelerator(event, kb["search-project-sessions"])) {
    event.preventDefault();
    openSessionSearch(currentRepoId() || state.repos[0]?.id || null);
    return true;
  }

  if (isOpenLauncherShortcut(event)) {
    event.preventDefault();
    await startDefaultAgentSession();
    return true;
  }

  if (matchesAccelerator(event, kb["build-and-run-app"])) {
    event.preventDefault();
    await runConfiguredApp(currentRepoId() || state.repos[0]?.id || null);
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
    case "app-launch-build-command":
      ui.appLaunchBuildCommand = target.value;
      ui.appLaunchError = "";
      break;
    case "app-launch-run-command":
      ui.appLaunchRunCommand = target.value;
      ui.appLaunchError = "";
      break;
    case "marketplace-inspect-url":
      ui.marketplaceInspectUrl = target.value;
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

  const sessionId = target.dataset.sessionId || null;
  const currentPane = target.closest(".session-pane") as HTMLElement | null;
  const nextFocus = event.relatedTarget as HTMLElement | null;
  const nextPane = nextFocus?.closest(".session-pane") as HTMLElement | null;
  if (
    sessionId &&
    currentPane?.dataset.sessionId === sessionId &&
    nextPane?.dataset.sessionId === sessionId
  ) {
    return;
  }

  await commitSessionRename(sessionId);
}

function handleFocusIn(event: FocusEvent) {
  if (isAnyDialogOpen()) {
    return;
  }

  const target = event.target as HTMLElement | null;
  if (!target) {
    return;
  }

  let needsUiSync = false;

  if (sidebarElement.contains(target)) {
    const focusSection: SectionId = isSidebarDrawerTarget(target) ? "sidebar-drawer" : "sidebar";
    if (ui.focusSection !== focusSection) {
      ui.focusSection = focusSection;
      normalizeFocusSection();
      needsUiSync = true;
    }
  }

  if (ui.sidebarCollapsed && sidebarElement.contains(target)) {
    ui.sidebarCollapsed = false;
    needsUiSync = true;
  }

  if (ui.navbarCollapsed && isWorkspaceNavbarTarget(target)) {
    ui.navbarCollapsed = false;
    needsUiSync = true;
  }

  if (needsUiSync) {
    syncSectionFocusUi({ preserveCurrentFocus: true });
  }
}

async function handleChange(event) {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  if (!target) {
    return;
  }

  if (target.id === "pref-theme-appearance") {
    const themePreferences = themePreferencesFromState();
    if (isThemeAppearance(target.value)) {
      await persistThemePreferences({
        ...themePreferences,
        appearance: target.value
      });
      if (settingsDialog.open) {
        await renderSettingsDialog();
      }
    }
    return;
  }

  if (target.dataset.themeColorInput === "true") {
    await handleThemeColorChange(target as HTMLInputElement);
    return;
  }

  if (target.dataset.themeNameInput === "true") {
    await handleThemeNameChange(target as HTMLInputElement);
    return;
  }

  if (target.dataset.settingEditor) {
    handleSettingsFieldChange(target);
    if (ui.settingsTab === "claude" && ui.settingsClaudeView === "plugins") {
      await renderSettingsDialog();
    }
    return;
  }

  if (target.dataset.sessionTagSelect === "true") {
    await setSessionTagColor(target.dataset.sessionId, target.value || null);
    return;
  }

  if (target.dataset.agentCommandId) {
    const agentId = normalizeAgentId(target.dataset.agentCommandId, null);
    if (!agentId) {
      return;
    }

    await api.updatePreferences({
      agentCommandOverrides: {
        ...state.preferences.agentCommandOverrides,
        [agentId]: target.value
      }
    });
    return;
  }

  switch (target.id) {
    case "marketplace-install-scope":
      ui.marketplacePreferredScope = target.value === "user" ? "user" : "project";
      break;
    case "pref-notifications-enabled":
      await api.updatePreferences({ notificationsEnabled: (target as HTMLInputElement).checked });
      break;
    case "pref-default-agent":
      {
        const nextAgentId = normalizeAgentId(target.value, null);
        if (nextAgentId) {
          await api.updatePreferences({ defaultAgentId: nextAgentId });
        }
      }
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

async function handleThemeColorChange(target: HTMLInputElement) {
  const themeId = target.dataset.themeId || "";
  const mode = target.dataset.themeMode === "dark" ? "dark" : "light";
  const field = target.dataset.themeField as ThemeColorFieldId | undefined;
  if (!field || !THEME_COLOR_FIELDS.some((entry) => entry.id === field)) {
    return;
  }

  const themePreferences = themePreferencesFromState();
  const customThemeIndex = themePreferences.customThemes.findIndex((theme) => theme.id === themeId);
  if (customThemeIndex < 0) {
    return;
  }

  const customThemes = [...themePreferences.customThemes];
  const nextTheme = {
    ...customThemes[customThemeIndex],
    [mode]: {
      ...customThemes[customThemeIndex][mode],
      [field]: normalizeHexColor(target.value, customThemes[customThemeIndex][mode][field])
    }
  };
  customThemes[customThemeIndex] = nextTheme;

  await persistThemePreferences({
    ...themePreferences,
    customThemes
  });
}

async function handleThemeNameChange(target: HTMLInputElement) {
  const themeId = target.dataset.themeId || "";
  const themePreferences = themePreferencesFromState();
  const customThemeIndex = themePreferences.customThemes.findIndex((theme) => theme.id === themeId);
  if (customThemeIndex < 0) {
    return;
  }

  const customThemes = [...themePreferences.customThemes];
  customThemes[customThemeIndex] = {
    ...customThemes[customThemeIndex],
    name: target.value.trim() || customThemes[customThemeIndex].name
  };

  await persistThemePreferences({
    ...themePreferences,
    customThemes
  });

  if (settingsDialog.open) {
    await renderSettingsDialog();
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
  repoId: string | null,
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

async function initializeWiki(repoId: string | null) {
  if (!repoId) {
    window.alert("Select a folder first.");
    return;
  }

  await api.toggleWiki(repoId, true);
  ui.wikiStatusMessage = "Wiki enabled. Agents can now maintain durable knowledge in .wiki/.";
  await openWiki(repoId);
}

function currentAppLaunchConfig(): RepoAppLaunchConfig | null {
  const buildCommand = ui.appLaunchBuildCommand.trim();
  const runCommand = ui.appLaunchRunCommand.trim();

  if (!buildCommand || !runCommand) {
    return null;
  }

  return {
    buildCommand,
    runCommand
  };
}

async function saveAppLaunchConfig() {
  const repoId = ui.appLaunchRepoId;
  const config = currentAppLaunchConfig();
  if (!repoId || !config) {
    ui.appLaunchError = "Both build and run commands are required.";
    renderAppLaunchDialog();
    return null;
  }

  try {
    await api.updateRepoAppLaunchConfig({
      repoId,
      config
    });
    const repo = repoById(repoId);
    if (repo) {
      repo.appLaunchConfig = config;
    }
    ui.appLaunchError = "";
    return config;
  } catch (error) {
    ui.appLaunchError = error instanceof Error ? error.message : "Failed to save app commands.";
    renderAppLaunchDialog();
    return null;
  }
}

async function runConfiguredApp(repoId: string | null) {
  if (!repoId) {
    window.alert("Select a folder first.");
    return;
  }

  const repo = repoById(repoId);
  if (!repo?.appLaunchConfig) {
    openAppLaunchDialog(repoId);
    return;
  }

  try {
    const sessionId = await api.buildAndRunApp(repoId);
    if (sessionId) {
      commandPaletteDialog.close();
      await selectSession(sessionId, "terminal");
    }
  } catch (error) {
    ui.appLaunchError = error instanceof Error ? error.message : "Failed to build and run the app.";
    openAppLaunchDialog(repoId, { preserveInput: true });
  }
}

async function toggleWiki(repoId: string | null) {
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

function normalizeAgentId(
  value: string | null | undefined,
  fallback: AgentId | null = DEFAULT_AGENT_ID
): AgentId | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return AGENT_IDS.has(normalized as AgentId) ? normalized as AgentId : fallback;
}

function defaultSessionAgentId(): AgentId {
  return normalizeAgentId(state.preferences.defaultAgentId) || DEFAULT_AGENT_ID;
}

function sessionAgentId(session: SessionSummary | null | undefined): AgentId | null {
  return normalizeAgentId(session?.startupAgentId, null);
}

function agentOption(agentId: string | null | undefined) {
  const normalized = normalizeAgentId(agentId, null);
  return AGENT_OPTIONS.find((agent) => agent.id === normalized) || null;
}

function agentLabel(agentId: string | null | undefined) {
  return agentOption(agentId)?.label || "Shell";
}

function agentCommandValue(agentId: AgentId): string {
  const savedValue = state.preferences.agentCommandOverrides?.[agentId];
  const normalized = typeof savedValue === "string" ? savedValue.trim() : "";
  return normalized || DEFAULT_AGENT_COMMANDS[agentId] || "";
}

function defaultSessionRepoId(explicitRepoId: string | null = null): string | null {
  return (
    explicitRepoId ||
    currentRepoId() ||
    ui.sidebarExpandedRepoId ||
    mostRecentlyUpdatedSession()?.repoID ||
    state.repos[0]?.id ||
    null
  );
}

async function startDefaultAgentSession(explicitRepoId: string | null = null): Promise<string | null> {
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

async function restartSessionById(sessionId) {
  const session = sessionId ? sessionById(sessionId) : null;
  if (!session) {
    return;
  }

  if (session.runtimeState === "live") {
    const targetAgent = restartTargetAgentLabel();
    const repo = repoById(session.repoID);
    const message = repo
      ? `Restart this session with ${targetAgent}? This will stop the current terminal and relaunch ${targetAgent} in ${repo.name}.`
      : `Restart this session with ${targetAgent}? This will stop the current terminal and relaunch ${targetAgent}.`;
    if (!window.confirm(message)) {
      return;
    }
  }

  await selectSession(session.id, "terminal");
  await api.restartSession({ sessionId: session.id });
}

async function toggleSessionPin(sessionId) {
  const session = sessionById(sessionId);
  if (!session) {
    return;
  }

  await api.updateSessionOrganization(sessionId, { isPinned: !session.isPinned });
}

async function importSessionIcon(sessionId) {
  if (!sessionId) {
    return;
  }

  try {
    await api.importSessionIcon(sessionId);
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "Failed to import session icon.");
  }
}

async function clearSessionIcon(sessionId) {
  if (!sessionId) {
    return;
  }

  try {
    await api.clearSessionIcon(sessionId);
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "Failed to clear session icon.");
  }
}

async function setSessionTagColor(sessionId: string | null | undefined, tagColor: string | null) {
  if (!sessionId) {
    return;
  }

  await api.updateSessionOrganization(sessionId, {
    tagColor: normalizeSessionTagColor(tagColor)
  });
}

async function openSettings(
  initialTab = "general",
  options: { claudeView?: ClaudeSettingsView } = {}
) {
  ui.settingsTab = initialTab;
  ui.settingsClaudeView =
    initialTab === "claude" ? options.claudeView || ui.settingsClaudeView || "files" : "files";
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
  ui.sessionSearchFilter = "all";
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

function openAppLaunchDialog(repoId: string | null, options: { preserveInput?: boolean } = {}) {
  const repo = repoById(repoId || "");
  if (!repo) {
    window.alert("Select a folder first.");
    return;
  }

  const config = repo.appLaunchConfig;
  ui.appLaunchRepoId = repo.id;
  ui.appLaunchError = "";
  if (!options.preserveInput) {
    ui.appLaunchBuildCommand = config?.buildCommand || "";
    ui.appLaunchRunCommand = config?.runCommand || "";
  }

  renderAppLaunchDialog();
  if (!appLaunchDialog.open) {
    appLaunchDialog.showModal();
  }
}

function closeAppLaunchDialog() {
  ui.appLaunchRepoId = null;
  ui.appLaunchBuildCommand = "";
  ui.appLaunchRunCommand = "";
  ui.appLaunchError = "";
  if (appLaunchDialog.open) {
    appLaunchDialog.close();
  }
}

function renderAppLaunchDialog() {
  const repo = repoById(ui.appLaunchRepoId || "");

  replaceDomChildren(
    appLaunchDialog,
    dom(
      "form",
      { className: "dialog-body", attrs: { method: "dialog" } },
      dom(
        "div",
        { className: "dialog-header" },
        dom(
          "div",
          {},
          dom("div", { className: "eyebrow" }, "App Launch"),
          dom("h2", { className: "dialog-title" }, repo ? `Build and Run ${repo.name}` : "Build and Run App"),
          dom(
            "div",
            { className: "muted" },
            repo ? abbreviateHome(repo.path) : "Select a repo to configure commands."
          )
        ),
        dom(
          "button",
          {
            attrs: {
              type: "button",
              "data-action": "close-app-launch-dialog"
            }
          },
          "Close"
        )
      ),
      dom(
        "div",
        { className: "app-launch-fields" },
        dom(
          "label",
          { className: "app-launch-field" },
          dom("div", { className: "row-title" }, "Build Command"),
          dom("input", {
            value: ui.appLaunchBuildCommand,
            attrs: {
              id: "app-launch-build-command",
              placeholder: "npm run build"
            }
          }),
          dom("div", { className: "muted" }, "Runs first. If it exits non-zero, Hydra skips the run command.")
        ),
        dom(
          "label",
          { className: "app-launch-field" },
          dom("div", { className: "row-title" }, "Run Command"),
          dom("input", {
            value: ui.appLaunchRunCommand,
            attrs: {
              id: "app-launch-run-command",
              placeholder: "npm run dev"
            }
          }),
          dom("div", { className: "muted" }, "Starts after a successful build inside a Hydra shell session.")
        )
      ),
      ui.appLaunchError
        ? dom("div", { className: "settings-warning-card" }, ui.appLaunchError)
        : null,
      dom(
        "div",
        { className: "dialog-footer" },
        dom(
          "button",
          {
            attrs: {
              type: "button",
              "data-action": "save-app-launch-config"
            }
          },
          "Save"
        ),
        dom(
          "button",
          {
            className: "primary",
            attrs: {
              type: "button",
              "data-action": "save-and-run-app-launch"
            }
          },
          "Save and Run"
        )
      )
    )
  );
}

function openPlanReviewDialog(sessionId: string | null | undefined) {
  const nextSessionId = sessionId || "";
  if (!nextSessionId || !planReviewForSession(nextSessionId)) {
    return;
  }

  ui.activePlanReviewSessionId = nextSessionId;
  renderPlanReviewDialog();
  if (!planReviewDialog.open) {
    planReviewDialog.showModal();
  }
}

function closePlanReviewDialog() {
  ui.activePlanReviewSessionId = null;
  if (planReviewDialog.open) {
    planReviewDialog.close();
  }
  renderPlanReviewDialog();
}

function overlayState(toolId: EphemeralToolId): EphemeralToolOverlayState {
  return ui.ephemeralToolOverlays[toolId];
}

function overlayDialog(toolId: EphemeralToolId): HTMLDialogElement {
  return EPHEMERAL_TOOL_DIALOGS[toolId].dialog;
}

function overlayHost(toolId: EphemeralToolId): HTMLElement {
  return document.getElementById(EPHEMERAL_TOOL_DIALOGS[toolId].hostId) as HTMLElement;
}

function unavailableEphemeralToolMarkup(toolId: EphemeralToolId): string | null {
  if (toolId === "lazygit") {
    if (state.lazygitInstalled) {
      return null;
    }

    const ua = navigator.userAgent;
    let installLines: string[];
    if (ua.includes("Windows")) {
      installLines = [
        "winget install -e --id JesseBartlett.lazygit",
        "scoop install lazygit"
      ];
    } else if (ua.includes("Linux")) {
      installLines = [
        "pacman -S lazygit",
        "dnf install lazygit",
        "go install github.com/jesseduffield/lazygit@latest"
      ];
    } else {
      installLines = ["brew install lazygit"];
    }
    const codeStyle = "color:var(--text);background:var(--surface);padding:4px 10px;border-radius:6px;font-size:13px;";
    const codesHtml = installLines.map((cmd) => `<code style="${codeStyle}">${cmd}</code>`).join("\n      ");
    return `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-family:var(--font-mono);font-size:14px;flex-direction:column;gap:8px;">
      <span>lazygit is not installed. Install lazygit and launch app again.</span>
      ${codesHtml}
    </div>`;
  }

  if (toolId === "tokscale" && !state.tokscaleInstalled) {
    return `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-family:var(--font-mono);font-size:14px;flex-direction:column;gap:8px;">
      <span>Tokscale is unavailable in this Hydra build.</span>
      <span>Reinstall or update Hydra so the bundled Tokscale binary is included.</span>
    </div>`;
  }

  return null;
}

function mountEphemeralToolTerminal(
  toolId: EphemeralToolId,
  sessionId: string,
  host: HTMLElement
): TerminalMount {
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
      closeEphemeralToolOverlay(toolId);
      return false;
    }

    return true;
  });

  terminal.onData((data) => {
    api.sendEphemeralToolInput(toolId, sessionId, data);
  });
  terminal.onBinary((data) => {
    api.sendEphemeralToolBinaryInput(toolId, sessionId, data);
  });
  terminal.onResize((size) => {
    api.resizeEphemeralTool(toolId, sessionId, size.cols, size.rows);
  });

  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
  });
  resizeObserver.observe(host);

  return { terminal, fitAddon, resizeObserver };
}

function handleEphemeralToolOutput(
  payload: EphemeralToolOutputPayload,
  expectedToolId: EphemeralToolId,
  expectedSessionId: string,
  outputBuffer: string[],
  terminalReady: { current: boolean }
) {
  if (payload.toolId !== expectedToolId || payload.sessionId !== expectedSessionId) {
    return;
  }

  const overlay = overlayState(expectedToolId);
  if (terminalReady.current && overlay.terminalMount) {
    overlay.terminalMount.terminal.write(payload.data);
  } else {
    outputBuffer.push(payload.data);
  }
}

async function openEphemeralToolOverlay(toolId: EphemeralToolId, repoId: string | null) {
  if (!repoId || overlayDialog(toolId).open) {
    return;
  }

  const unavailableMarkup = unavailableEphemeralToolMarkup(toolId);
  if (unavailableMarkup) {
    overlayHost(toolId).innerHTML = unavailableMarkup;
    overlayDialog(toolId).showModal();
    return;
  }

  const sessionId = await api.launchEphemeralTool(toolId, repoId);
  if (!sessionId) {
    return;
  }

  const overlay = overlayState(toolId);
  overlay.sessionId = sessionId;

  const outputBuffer: string[] = [];
  const terminalReady = { current: false };

  overlay.unsubOutput = api.onEphemeralToolOutput((payload) => {
    handleEphemeralToolOutput(payload, toolId, sessionId, outputBuffer, terminalReady);
  });
  overlay.unsubExit = api.onEphemeralToolExit((payload) => {
    if (payload.toolId === toolId && payload.sessionId === sessionId) {
      closeEphemeralToolOverlay(toolId);
    }
  });

  const dialog = overlayDialog(toolId);
  const host = overlayHost(toolId);

  dialog.showModal();
  host.innerHTML = "";

  // Defer terminal creation until layout has settled. Opening xterm against
  // a zero-size host produces a broken cols/rows handshake for TUI sessions.
  requestAnimationFrame(() => {
    if (overlayState(toolId).sessionId !== sessionId) {
      return;
    }

    const mount = mountEphemeralToolTerminal(toolId, sessionId, host);
    overlayState(toolId).terminalMount = mount;

    for (const chunk of outputBuffer) {
      mount.terminal.write(chunk);
    }
    outputBuffer.length = 0;
    terminalReady.current = true;

    mount.fitAddon.fit();
    api.resizeEphemeralTool(toolId, sessionId, mount.terminal.cols, mount.terminal.rows);
    mount.terminal.focus();
  });
}

function closeEphemeralToolOverlay(toolId: EphemeralToolId) {
  const overlay = overlayState(toolId);
  overlay.unsubOutput?.();
  overlay.unsubExit?.();
  overlay.unsubOutput = null;
  overlay.unsubExit = null;

  if (overlay.terminalMount) {
    overlay.terminalMount.resizeObserver.disconnect();
    overlay.terminalMount.terminal.dispose();
    overlay.terminalMount = null;
  }

  if (overlay.sessionId) {
    void api.closeEphemeralTool(toolId, overlay.sessionId);
    overlay.sessionId = null;
  }

  const dialog = overlayDialog(toolId);
  if (dialog.open) {
    dialog.close();
  }
}

async function openTokscaleOverlay(repoId: string | null) {
  await openEphemeralToolOverlay("tokscale", repoId);
}

function closeTokscaleOverlay() {
  closeEphemeralToolOverlay("tokscale");
}

async function openLazygitOverlay(repoId: string | null) {
  await openEphemeralToolOverlay("lazygit", repoId);
}

function closeLazygitOverlay() {
  closeEphemeralToolOverlay("lazygit");
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
    // Flush state before selecting: the invoke response and the broadcastState
    // "state:changed" event travel on separate IPC channels with no ordering
    // guarantee. Fetching state here ensures the new session is in state.sessions
    // before selectSession tries to look it up.
    if (!sessionById(sessionId)) {
      replaceState(await api.getState());
    }
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

function planReviewForSession(sessionId: string) {
  return ui.sessionPlanReviews.get(sessionId) || null;
}

function syncPlanReviewsFromState() {
  const activeSessionIds = new Set(state.sessions.map((session) => session.id));

  for (const sessionId of ui.sessionPlanReviews.keys()) {
    if (!activeSessionIds.has(sessionId)) {
      ui.sessionPlanReviews.delete(sessionId);
    }
  }

  for (const sessionId of ui.lastAutoOpenedPlanFingerprintBySession.keys()) {
    if (!activeSessionIds.has(sessionId)) {
      ui.lastAutoOpenedPlanFingerprintBySession.delete(sessionId);
    }
  }

  if (ui.activePlanReviewSessionId && !activeSessionIds.has(ui.activePlanReviewSessionId)) {
    ui.activePlanReviewSessionId = null;
    if (planReviewDialog.open) {
      planReviewDialog.close();
    }
  }

  for (const session of state.sessions) {
    syncSessionPlanReview(session, { autoOpen: false });
  }
}

function syncSessionPlanReview(session: SessionSummary | null, options: { autoOpen: boolean }) {
  if (!session) {
    return null;
  }

  const isCodex = session.startupAgentId === "codex";

  if (!isCodex) {
    // Non-Codex sessions (Claude, etc.): plan reviews are set via the plans
    // directory watcher (onPlanDetected). Don't auto-clear them here.
    return ui.sessionPlanReviews.get(session.id) || null;
  }

  const transcript = session.transcript || session.rawTranscript || "";
  const proposedPlan = extractLatestProposedPlan(transcript);
  if (!proposedPlan) {
    ui.sessionPlanReviews.delete(session.id);
    if (ui.activePlanReviewSessionId === session.id) {
      closePlanReviewDialog();
    }
    return null;
  }

  const nextReview: SessionPlanReview = {
    sessionId: session.id,
    markdown: proposedPlan.markdown,
    fingerprint: proposedPlan.fingerprint,
    detectedAt: session.updatedAt || new Date().toISOString()
  };
  const previousReview = ui.sessionPlanReviews.get(session.id);
  ui.sessionPlanReviews.set(session.id, nextReview);

  if (ui.activePlanReviewSessionId === session.id && previousReview?.fingerprint !== nextReview.fingerprint) {
    renderPlanReviewDialog();
  }

  if (
    options.autoOpen &&
    previousReview?.fingerprint !== nextReview.fingerprint &&
    ui.lastAutoOpenedPlanFingerprintBySession.get(session.id) !== nextReview.fingerprint
  ) {
    ui.lastAutoOpenedPlanFingerprintBySession.set(session.id, nextReview.fingerprint);
    openPlanReviewDialog(session.id);
  }

  return nextReview;
}

function extractLatestProposedPlan(transcript: string) {
  const normalized = String(transcript || "").replace(/\r\n/g, "\n");
  const pattern = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/g;
  let latestMarkdown = "";

  while (true) {
    const match = pattern.exec(normalized);
    if (!match) {
      break;
    }
    latestMarkdown = match[1] || "";
  }

  const markdown = latestMarkdown.trim();
  if (!markdown) {
    return null;
  }

  return {
    markdown,
    fingerprint: markdown
  };
}

function extractClaudePlanFromTranscript(transcript: string) {
  const normalized = String(transcript || "").replace(/\r\n/g, "\n");

  const approvalPatterns = [
    /would you like to proceed with this plan/i,
    /do you want to proceed with this plan/i,
    /proceed with this plan/i
  ];

  let approvalIndex = -1;
  for (const pattern of approvalPatterns) {
    const match = normalized.search(pattern);
    if (match !== -1 && (approvalIndex === -1 || match < approvalIndex)) {
      approvalIndex = match;
    }
  }

  if (approvalIndex === -1) return null;

  const beforeApproval = normalized.slice(0, approvalIndex).trimEnd();
  if (!beforeApproval) return null;

  const lines = beforeApproval.split("\n");
  const planLines = lines.slice(-200);

  let start = 0;
  while (start < planLines.length && !planLines[start].trim()) start++;
  const markdown = planLines.slice(start).join("\n").trim();

  return markdown ? { markdown, fingerprint: markdown } : null;
}

async function loadWikiContext(
  repoId: string | null,
  preferredPath: string | null = null
): Promise<WikiContext | null> {
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

async function selectWikiFile(
  repoId: string | null,
  relativePath: string | null | undefined,
  options: { suppressReload?: boolean } = {}
) {
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

async function runWikiAgentAction(action: "refresh" | "lint" | "ask", repoId: string | null) {
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
      selectedSession &&
      selectedSession.repoID === repoId &&
      sessionAgentId(selectedSession) === DEFAULT_AGENT_ID &&
      selectedSession.runtimeState === "live"
    ) {
      return selectedSession;
    }
  }

  return sessionsForRepo(repoId).find(
    (session) => sessionAgentId(session) === DEFAULT_AGENT_ID && session.runtimeState === "live"
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

  await api.saveSettingsFile({
    repoId: currentRepoId(),
    filePath: ui.settingsSelectedFilePath,
    contents: ui.settingsEditorText
  });
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

function editableClaudeJsonFiles() {
  return allSettingsFiles().filter((file) => isJsonSettingsFile(file));
}

function preferredClaudeJsonFile(files) {
  return (
    files.find((file) => file.scope === "project" && pathLabel(file.path) === "settings.local.json") ||
    files.find((file) => file.scope === "project" && pathLabel(file.path) === "settings.json") ||
    files.find((file) => file.scope === "global" && pathLabel(file.path) === "settings.local.json") ||
    files.find((file) => file.scope === "global" && pathLabel(file.path) === "settings.json") ||
    files[0] ||
    null
  );
}

function allClaudeSkills() {
  return ui.settingsContext?.skills || [];
}

function selectedClaudeSkill() {
  return allClaudeSkills().find((skill) => skill.path === ui.settingsSelectedFilePath) || null;
}

function marketplacePreferredScopeKey() {
  return "claudeMarketplacePreferredScope";
}

function resolvedMarketplaceScope(canInstallProject: boolean) {
  if (ui.marketplacePreferredScope === "user") {
    return "user";
  }
  if (ui.marketplacePreferredScope === "project" && canInstallProject) {
    return "project";
  }

  const savedScope = state.preferences?.[marketplacePreferredScopeKey()];
  if (savedScope === "user") {
    return "user";
  }
  if (savedScope === "project" && canInstallProject) {
    return "project";
  }

  return canInstallProject ? "project" : "user";
}

function selectedMarketplaceResult() {
  return ui.marketplaceResults.find((result) => result.id === ui.marketplaceSelectedId) || null;
}

function currentMarketplaceInspectUrl() {
  const input = settingsDialog.querySelector("#marketplace-inspect-url") as HTMLInputElement | null;
  return (input?.value ?? ui.marketplaceInspectUrl ?? "").trim();
}

async function loadMarketplaceDetailById(resultId: string | null) {
  const result = ui.marketplaceResults.find((entry) => entry.id === resultId) || null;
  if (!result) {
    ui.marketplaceSelectedDetail = null;
    return;
  }

  ui.marketplaceSelectedId = result.id;
  ui.marketplaceDetailLoading = true;
  ui.marketplaceInstallMessage = "";
  await renderSettingsDialog();

  try {
    ui.marketplaceSelectedDetail = await api.getMarketplaceSkillDetails({
      source: {
        ...result.source,
        reviewState: result.reviewState,
        tags: result.tags
      }
    });
  } catch (error) {
    ui.marketplaceError =
      error instanceof Error ? error.message : "Failed to load the selected skill preview.";
    ui.marketplaceSelectedDetail = null;
  } finally {
    ui.marketplaceDetailLoading = false;
    await renderSettingsDialog();
  }
}

async function selectMarketplaceResult(resultId: string | null) {
  if (!resultId) {
    return;
  }

  if (resultId === ui.marketplaceSelectedId && ui.marketplaceSelectedDetail?.id === resultId) {
    return;
  }

  await loadMarketplaceDetailById(resultId);
}

async function inspectMarketplaceGitHubUrl(options: { rawUrl?: string } = {}) {
  const rawUrl = String(options.rawUrl || currentMarketplaceInspectUrl() || "").trim();
  ui.marketplaceInspectUrl = rawUrl;
  if (!rawUrl) {
    ui.marketplaceInspectMessage = "Paste a GitHub URL first.";
    await renderSettingsDialog();
    return;
  }

  ui.marketplaceInspectMessage = "Loading GitHub URL…";
  ui.marketplaceError = "";
  await renderSettingsDialog();

  try {
    const payload = await api.inspectMarketplaceUrl({ url: rawUrl });
    ui.marketplaceResults = Array.isArray(payload?.results) ? payload.results : [];
    ui.marketplaceSelectedId = ui.marketplaceResults[0]?.id || null;
    ui.marketplaceInspectMessage = ui.marketplaceResults.length
      ? `Loaded ${ui.marketplaceResults.length} ${pluralize(ui.marketplaceResults.length, "skill", "skills")} from GitHub.`
      : "No skills were found at that URL.";
    if (ui.marketplaceSelectedId) {
      await loadMarketplaceDetailById(ui.marketplaceSelectedId);
      return;
    }
    ui.marketplaceSelectedDetail = null;
  } catch (error) {
    ui.marketplaceInspectMessage =
      error instanceof Error ? error.message : "Failed to inspect that GitHub URL.";
  }

  await renderSettingsDialog();
}

async function installSelectedMarketplaceSkill() {
  const detail = ui.marketplaceSelectedDetail;
  if (!detail) {
    return;
  }

  const scopeInput = settingsDialog.querySelector("#marketplace-install-scope") as HTMLSelectElement | null;
  const scope = (scopeInput?.value || resolvedMarketplaceScope(!!repoById(currentRepoId())?.path)) as "user" | "project";
  const repo = repoById(currentRepoId());
  ui.marketplaceInstallMessage = "Installing skill…";
  await renderSettingsDialog();

  try {
    const payload = await api.installMarketplaceSkill({
      source: detail.source,
      scope,
      repoPath: repo?.path || null
    });
    ui.marketplaceInstallMessage = `Installed ${payload.skillName} to ${payload.scope === "project" ? ".claude/skills" : abbreviateHome(payload.installPath)}.`;
    await api.updatePreferences({
      [marketplacePreferredScopeKey()]: scope
    });
    ui.settingsContext = await api.getClaudeSettingsContext(currentRepoId());
  } catch (error) {
    ui.marketplaceInstallMessage =
      error instanceof Error ? error.message : "Failed to install the selected skill.";
  }

  await renderSettingsDialog();
}

async function loadSelectedSettingsFile(filePath) {
  ui.settingsSelectedFilePath = filePath;
  ui.settingsJsonCategoryId = "";
  ui.settingsEditorText = await api.loadSettingsFile({
    repoId: currentRepoId(),
    filePath
  });
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
    ui.settingsJsonError = error instanceof Error ? error.message : "Invalid JSON.";
  }
}

function currentJsonSettingsValue(): JsonValue {
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

function currentEnabledPluginsSettingsValue(): JsonObject | null {
  const rootValue = currentJsonSettingsValue();
  if (!isJsonObject(rootValue)) {
    return null;
  }

  if (rootValue.enabledPlugins === undefined) {
    return {};
  }

  return isJsonObject(rootValue.enabledPlugins) ? rootValue.enabledPlugins : null;
}

function selectedEnabledPluginOverride(pluginId: string): boolean | undefined {
  const enabledPluginsValue = currentEnabledPluginsSettingsValue();
  if (!enabledPluginsValue) {
    return undefined;
  }

  const value = enabledPluginsValue[pluginId];
  return typeof value === "boolean" ? value : undefined;
}

function addClaudePluginOverride() {
  const pluginIdInput = settingsDialog.querySelector("#plugins-new-id") as HTMLInputElement | null;
  const enabledInput = settingsDialog.querySelector("#plugins-new-enabled") as HTMLInputElement | null;
  const pluginId = pluginIdInput?.value.trim() || "";

  if (!pluginId) {
    ui.settingsSaveMessage = "Enter a plugin identifier first.";
    return;
  }

  const enabledPluginsValue = currentEnabledPluginsSettingsValue();
  if (enabledPluginsValue === null) {
    ui.settingsSaveMessage = "This file needs an object root and an object enabledPlugins value before plugins can be added.";
    return;
  }

  updateJsonSettingValue(["enabledPlugins", pluginId], enabledInput?.checked !== false);
}

function clearClaudePluginOverride(pluginId: string) {
  removeJsonSettingAtPath(["enabledPlugins", pluginId]);

  const enabledPluginsValue = currentEnabledPluginsSettingsValue();
  if (enabledPluginsValue && !Object.keys(enabledPluginsValue).length) {
    removeJsonSettingAtPath(["enabledPlugins"]);
  }
}

async function createClaudeSkillFile() {
  const nameInput = settingsDialog.querySelector("#skills-new-name") as HTMLInputElement | null;
  const scopeInput = settingsDialog.querySelector("#skills-new-scope") as HTMLSelectElement | null;
  const rawName = nameInput?.value.trim() || "";
  const scope: "user" | "project" = scopeInput?.value === "user" ? "user" : "project";
  const skillName = slugifySkillName(rawName);
  const skillRoots = ui.settingsContext?.skillRoots || null;
  const rootPath = scope === "user" ? skillRoots?.user ?? null : skillRoots?.project ?? null;

  if (!rawName) {
    ui.settingsSaveMessage = "Enter a skill name first.";
    return;
  }

  if (!skillName) {
    ui.settingsSaveMessage = "Use letters, numbers, spaces, dashes, or underscores in the skill name.";
    return;
  }

  if (!rootPath) {
    ui.settingsSaveMessage = scope === "project"
      ? "Open a project folder before creating a project skill."
      : "No user skills directory is available.";
    return;
  }

  const skillFilePath = `${rootPath.replace(/[\\/]+$/, "")}/${skillName}/SKILL.md`;
  const existingSkill = allClaudeSkills().find(
    (skill) => skill.name === skillName && skill.sourceType === scope
  );
  if (existingSkill) {
    ui.settingsSaveMessage = `${skillName} already exists.`;
    await loadSelectedSettingsFile(existingSkill.path);
    return;
  }

  await api.saveSettingsFile({
    repoId: currentRepoId(),
    filePath: skillFilePath,
    contents: defaultClaudeSkillTemplate(rawName)
  });
  ui.settingsContext = await api.getClaudeSettingsContext(currentRepoId());
  ui.settingsSelectedFilePath = skillFilePath;
  await loadSelectedSettingsFile(skillFilePath);
  ui.settingsSaveMessage = `Created ${skillName}.`;
}

async function refreshSelectedClaudeSkill() {
  ui.settingsContext = await api.getClaudeSettingsContext(currentRepoId());
  if (ui.settingsSelectedFilePath) {
    await loadSelectedSettingsFile(ui.settingsSelectedFilePath);
  }
}

async function importSelectedClaudeSkillIcon() {
  const skill = selectedClaudeSkill();
  if (!skill || !skill.editable) {
    return;
  }

  const importedPath = await api.importSkillIcon({
    repoId: currentRepoId(),
    skillFilePath: skill.path
  });
  if (!importedPath) {
    return;
  }

  await refreshSelectedClaudeSkill();
  ui.settingsSaveMessage = `Updated icon for ${skill.name}.`;
}

async function clearSelectedClaudeSkillIcon() {
  const skill = selectedClaudeSkill();
  if (!skill || !skill.editable || !skill.iconUrl) {
    return;
  }

  await api.clearSkillIcon({
    repoId: currentRepoId(),
    skillFilePath: skill.path
  });
  await refreshSelectedClaudeSkill();
  ui.settingsSaveMessage = `Removed icon for ${skill.name}.`;
}

function defaultClaudeSkillTemplate(skillName: string) {
  return `---
description: Describe when Claude should load this skill and what it should help with.
---

# ${skillName.trim()}

Explain the workflow, constraints, and expected output for this skill.
`;
}

function slugifySkillName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 _-]+/g, "")
    .replace(/[ _]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function skillSourceLabel(skill) {
  switch (skill.sourceType) {
    case "project":
      return "Project";
    case "user":
      return "User";
    case "managed":
      return "Managed";
    case "plugin":
      return "Plugin";
    default:
      return skill.sourceLabel || "Skill";
  }
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function setJsonValueAtPath(rootValue, path, nextValue) {
  if (!path.length) {
    return nextValue;
  }

  let currentValue = rootValue;

  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    const nextSegment = path[index + 1];
    const nextContainerIsArray = typeof nextSegment === "number";
    const existingValue = currentValue?.[segment];

    if (existingValue === undefined || existingValue === null) {
      currentValue[segment] = nextContainerIsArray ? [] : {};
    } else if (nextContainerIsArray && !Array.isArray(existingValue)) {
      currentValue[segment] = [];
    } else if (!nextContainerIsArray && !isJsonObject(existingValue)) {
      currentValue[segment] = {};
    }

    currentValue = currentValue[segment];
  }

  currentValue[path[path.length - 1]] = nextValue;
  return rootValue;
}

function getJsonValueAtPath(rootValue, path) {
  return path.reduce(
    (currentValue, segment) => (currentValue === undefined || currentValue === null ? undefined : currentValue[segment]),
    rootValue
  );
}

function deleteJsonValueAtPath(rootValue, path) {
  if (!path.length) {
    return rootValue;
  }

  const parentValue = getJsonValueAtPath(rootValue, path.slice(0, -1));
  if (parentValue === undefined || parentValue === null) {
    return rootValue;
  }
  const lastSegment = path[path.length - 1];

  if (Array.isArray(parentValue) && typeof lastSegment === "number") {
    parentValue.splice(lastSegment, 1);
  } else if (typeof parentValue === "object") {
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

function isJsonObject(value: unknown): value is JsonObject {
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
  return mergeSessionSummary(summary);
}

function renderSessionDragAttributes(sessionId, source = "list") {
  return `draggable="true" data-drag-session-id="${escapeAttribute(sessionId)}" data-drag-source="${escapeAttribute(source)}"`;
}

function setSessionDragAttributes(element: HTMLElement, sessionId: string, source = "list") {
  element.draggable = true;
  element.dataset.dragSessionId = sessionId;
  element.dataset.dragSource = source;
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

  const cols = Math.ceil(Math.sqrt(visibleIds.length));
  const rows: string[][] = [];
  for (let i = 0; i < visibleIds.length; i += cols) {
    rows.push(visibleIds.slice(i, i + cols));
  }

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

function sessionById(sessionId: string): SessionSummary | null {
  return state.sessions.find((session) => session.id === sessionId) || null;
}

function repoById(repoId: string | null | undefined): RepoSnapshot | null {
  if (!repoId) {
    return null;
  }

  return state.repos.find((repo) => repo.id === repoId) || null;
}

function currentRepoId(): string | null {
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
    sidebarActionNavId("open-settings"),
    sidebarActionNavId("collapse-sidebar")
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
    case "collapse-sidebar":
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
  if ((section === "sidebar" || section === "sidebar-drawer") && ui.sidebarCollapsed) {
    ui.sidebarCollapsed = false;
  }
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

async function handleSessionWorkspaceDirectionalNavigation(direction: WorkspaceNavigationDirection) {
  if (ui.selection.type !== "session") {
    return false;
  }

  const paneOrder = orderedVisibleSessionPaneIds();
  if (!paneOrder.length) {
    return false;
  }

  if (direction === "left" || direction === "right") {
    if (ui.focusSection === "sidebar") {
      if (direction === "left") {
        return false;
      }

      if (expandedSidebarRepo()) {
        setFocusSection("sidebar-drawer");
        return true;
      }

      await focusOrderedSessionPane(paneOrder[0], sessionPaneFocusSectionForWorkspaceNavigation());
      return true;
    }

    if (ui.focusSection === "sidebar-drawer") {
      if (direction === "left") {
        setFocusSection("sidebar");
        return true;
      }

      await focusOrderedSessionPane(paneOrder[0], sessionPaneFocusSectionForWorkspaceNavigation());
      return true;
    }
  }

  if (ui.focusSection !== "main" && ui.focusSection !== "terminal") {
    return false;
  }

  if (!paneOrder.includes(ui.selection.id)) {
    await focusOrderedSessionPane(paneOrder[0], sessionPaneFocusSectionForWorkspaceNavigation());
    return true;
  }

  const nextSessionId = adjacentVisibleSessionPaneId(ui.selection.id, direction);
  if (nextSessionId) {
    await focusOrderedSessionPane(nextSessionId, sessionPaneFocusSectionForWorkspaceNavigation());
    return true;
  }

  if (direction === "left") {
    if (expandedSidebarRepo()) {
      setFocusSection("sidebar-drawer");
      return true;
    }

    setFocusSection("sidebar");
    return true;
  }

  return true;
}

function visibleSessionPanes() {
  return Array.from(detailElement.querySelectorAll(".session-pane"))
    .map((pane) => {
      const element = pane as HTMLElement;
      const sessionId = element.dataset.sessionId;
      if (!sessionId) {
        return null;
      }

      const rect = element.getBoundingClientRect();
      return {
        sessionId,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        centerX: rect.left + rect.width / 2,
        centerY: rect.top + rect.height / 2
      } satisfies VisibleSessionPane;
    })
    .filter(Boolean) as VisibleSessionPane[];
}

function intervalGap(startA: number, endA: number, startB: number, endB: number) {
  return Math.max(0, Math.max(startA, startB) - Math.min(endA, endB));
}

function directionalPaneScore(
  currentPane: VisibleSessionPane,
  candidatePane: VisibleSessionPane,
  direction: WorkspaceNavigationDirection
) {
  switch (direction) {
    case "left":
      if (candidatePane.centerX >= currentPane.centerX - 1) {
        return null;
      }
      return {
        primaryGap: Math.max(0, currentPane.left - candidatePane.right),
        orthogonalGap: intervalGap(
          currentPane.top,
          currentPane.bottom,
          candidatePane.top,
          candidatePane.bottom
        ),
        orthogonalCenterDelta: Math.abs(currentPane.centerY - candidatePane.centerY),
        primaryCenterDelta: currentPane.centerX - candidatePane.centerX
      };
    case "right":
      if (candidatePane.centerX <= currentPane.centerX + 1) {
        return null;
      }
      return {
        primaryGap: Math.max(0, candidatePane.left - currentPane.right),
        orthogonalGap: intervalGap(
          currentPane.top,
          currentPane.bottom,
          candidatePane.top,
          candidatePane.bottom
        ),
        orthogonalCenterDelta: Math.abs(currentPane.centerY - candidatePane.centerY),
        primaryCenterDelta: candidatePane.centerX - currentPane.centerX
      };
    case "up":
      if (candidatePane.centerY >= currentPane.centerY - 1) {
        return null;
      }
      return {
        primaryGap: Math.max(0, currentPane.top - candidatePane.bottom),
        orthogonalGap: intervalGap(
          currentPane.left,
          currentPane.right,
          candidatePane.left,
          candidatePane.right
        ),
        orthogonalCenterDelta: Math.abs(currentPane.centerX - candidatePane.centerX),
        primaryCenterDelta: currentPane.centerY - candidatePane.centerY
      };
    case "down":
      if (candidatePane.centerY <= currentPane.centerY + 1) {
        return null;
      }
      return {
        primaryGap: Math.max(0, candidatePane.top - currentPane.bottom),
        orthogonalGap: intervalGap(
          currentPane.left,
          currentPane.right,
          candidatePane.left,
          candidatePane.right
        ),
        orthogonalCenterDelta: Math.abs(currentPane.centerX - candidatePane.centerX),
        primaryCenterDelta: candidatePane.centerY - currentPane.centerY
      };
    default:
      return null;
  }
}

function adjacentVisibleSessionPaneId(
  currentSessionId: string,
  direction: WorkspaceNavigationDirection
) {
  const panes = visibleSessionPanes();
  const currentPane = panes.find((pane) => pane.sessionId === currentSessionId);
  if (!currentPane) {
    return null;
  }

  const rankedCandidates = panes
    .filter((pane) => pane.sessionId !== currentSessionId)
    .map((pane) => ({
      pane,
      score: directionalPaneScore(currentPane, pane, direction)
    }))
    .filter((entry) => !!entry.score) as Array<{
    pane: VisibleSessionPane;
    score: {
      primaryGap: number;
      orthogonalGap: number;
      orthogonalCenterDelta: number;
      primaryCenterDelta: number;
    };
  }>;

  rankedCandidates.sort((left, right) => {
    const leftOverlapPriority = left.score.orthogonalGap === 0 ? 0 : 1;
    const rightOverlapPriority = right.score.orthogonalGap === 0 ? 0 : 1;
    if (leftOverlapPriority !== rightOverlapPriority) {
      return leftOverlapPriority - rightOverlapPriority;
    }

    if (left.score.primaryGap !== right.score.primaryGap) {
      return left.score.primaryGap - right.score.primaryGap;
    }

    if (left.score.orthogonalGap !== right.score.orthogonalGap) {
      return left.score.orthogonalGap - right.score.orthogonalGap;
    }

    if (left.score.orthogonalCenterDelta !== right.score.orthogonalCenterDelta) {
      return left.score.orthogonalCenterDelta - right.score.orthogonalCenterDelta;
    }

    if (left.score.primaryCenterDelta !== right.score.primaryCenterDelta) {
      return left.score.primaryCenterDelta - right.score.primaryCenterDelta;
    }

    return left.pane.sessionId.localeCompare(right.pane.sessionId);
  });

  return rankedCandidates[0]?.pane.sessionId || null;
}

function orderedVisibleSessionPaneIds() {
  const panes = visibleSessionPanes().map((pane) => ({
    sessionId: pane.sessionId,
    left: pane.left,
    top: pane.top
  }));

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

function sessionPaneFocusSectionForWorkspaceNavigation(): SectionId {
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

function syncSectionFocusUi(options: { preserveCurrentFocus?: boolean } = {}) {
  normalizeFocusSection();

  const expanded = !!expandedSidebarRepo();
  appShellElement.classList.toggle("sidebar-expanded", expanded);
  appShellElement.classList.toggle("sidebar-collapsed", ui.sidebarCollapsed);
  sidebarElement.classList.toggle("sidebar-expanded", expanded);
  detailElement.classList.toggle("navbar-collapsed", ui.navbarCollapsed);
  sidebarRevealHandleElement.disabled = !ui.sidebarCollapsed;
  navbarRevealHandleElement.disabled = true;

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

  if (isAnyDialogOpen() || options.preserveCurrentFocus) {
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

function collapseSidebarChrome() {
  if (ui.focusSection === "sidebar" || ui.focusSection === "sidebar-drawer") {
    setFocusSection("main");
  }

  if (ui.sidebarCollapsed) {
    return;
  }

  ui.sidebarCollapsed = true;
  syncSectionFocusUi({ preserveCurrentFocus: true });
}

function expandSidebarChrome() {
  if (!ui.sidebarCollapsed) {
    return;
  }

  ui.sidebarCollapsed = false;
  syncSectionFocusUi({ preserveCurrentFocus: true });
}

function collapseWorkspaceNavbar() {
  if (ui.focusSection === "sidebar" || ui.focusSection === "sidebar-drawer") {
    setFocusSection("main");
  }

  if (isWorkspaceNavbarTarget(document.activeElement as HTMLElement | null)) {
    setFocusSection("main");
  }

  if (ui.navbarCollapsed) {
    return;
  }

  ui.navbarCollapsed = true;
  syncSectionFocusUi({ preserveCurrentFocus: true });
  updateAllSessionPanes();
}

function expandWorkspaceNavbar(options: { focusToolbarControl?: boolean } = {}) {
  if (!ui.navbarCollapsed) {
    return;
  }

  ui.navbarCollapsed = false;
  syncSectionFocusUi({ preserveCurrentFocus: true });
  updateAllSessionPanes();

  if (!options.focusToolbarControl) {
    return;
  }

  requestAnimationFrame(() => {
    const toolbarControl = detailElement.querySelector(
      "#session-workspace-toolbar button, #session-workspace-toolbar select, #session-workspace-toolbar input"
    ) as HTMLElement | null;
    toolbarControl?.focus({ preventScroll: true });
  });
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
    .sort(compareSessions);
}

function inboxSessions() {
  return [...state.sessions]
    .filter((session) => session.blocker || session.unreadCount > 0)
    .sort(compareInboxSessions);
}

function mostRecentlyUpdatedSession() {
  return [...state.sessions].sort(compareSessionsByUpdatedAt)[0] || null;
}

function compareSessionPinning(left, right) {
  if (!!left.isPinned === !!right.isPinned) {
    return 0;
  }

  return left.isPinned ? -1 : 1;
}

function compareSessionsByUpdatedAt(left, right) {
  return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
}

function compareSessions(left, right) {
  const pinOrder = compareSessionPinning(left, right);
  if (pinOrder !== 0) {
    return pinOrder;
  }

  return compareSessionsByUpdatedAt(left, right);
}

function compareInboxSessions(left, right) {
  const pinOrder = compareSessionPinning(left, right);
  if (pinOrder !== 0) {
    return pinOrder;
  }

  if (!!left.blocker !== !!right.blocker) {
    return left.blocker ? -1 : 1;
  }

  return compareSessionsByUpdatedAt(left, right);
}

function normalizeSessionTagColor(value: unknown): SessionTagColor | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SESSION_TAG_VALUES.has(normalized) ? normalized as SessionTagColor : null;
}

function sessionTagLabel(tagColor) {
  return SESSION_TAG_OPTIONS.find((option) => option.value === tagColor)?.label || "Tag";
}

function renderSessionTagDot(tagColor, extraClass = "") {
  const normalized = normalizeSessionTagColor(tagColor);
  if (!normalized) {
    return "";
  }

  const className = extraClass ? ` ${extraClass}` : "";
  return `<span class="session-tag-dot session-tag-${escapeAttribute(normalized)}${className}" title="${escapeAttribute(sessionTagLabel(normalized))} tag" aria-hidden="true"></span>`;
}

function renderSessionVisualButton(session, extraClass = "", action = "", label = "Upload session icon") {
  const className = extraClass ? ` ${extraClass}` : "";
  const actionAttribute = action ? ` data-action="${escapeAttribute(action)}"` : "";
  return `
    <button
      type="button"
      class="session-visual-button${className}"
      ${actionAttribute}
      data-session-id="${session.id}"
      aria-label="${escapeAttribute(label)}"
      title="${escapeAttribute(label)}">
      ${renderSessionVisual(session, "session-visual-button-content", { includePlaceholder: true })}
    </button>
  `;
}

function renderSessionVisual(
  session,
  extraClass = "",
  options: { includePlaceholder?: boolean } = {}
) {
  const className = extraClass ? ` ${extraClass}` : "";
  const hasIcon = !!session?.sessionIconUrl;
  const normalizedTag = normalizeSessionTagColor(session?.tagColor);
  const includePlaceholder = !!options.includePlaceholder;

  if (!hasIcon && !includePlaceholder) {
    return renderSessionTagDot(normalizedTag, extraClass);
  }

  return `
    <span class="session-visual${className}" aria-hidden="true">
      <span class="session-icon-frame">
        ${
          hasIcon
            ? `<img class="session-icon-image" src="${escapeAttribute(session.sessionIconUrl)}" alt="" />`
            : renderSessionPlaceholderIcon()
        }
        ${normalizedTag ? renderSessionTagDot(normalizedTag, "session-icon-tag") : ""}
      </span>
    </span>
  `;
}

function renderSessionPlaceholderIcon() {
  return `
    <span class="session-icon-placeholder" aria-hidden="true">
      <svg class="session-icon-placeholder-glyph" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.5 4.25A1.75 1.75 0 0 1 5.25 2.5h5.5A1.75 1.75 0 0 1 12.5 4.25v7.5a1.75 1.75 0 0 1-1.75 1.75h-5.5A1.75 1.75 0 0 1 3.5 11.75z" fill="none" stroke="currentColor" stroke-width="1.2"/>
        <circle cx="6.1" cy="6" r="1.1" fill="currentColor"/>
        <path d="M5 10.7 7.2 8.6l1.5 1.5 2.3-2.4 1 1.1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </span>
  `;
}

function renderSessionPinIndicator(label = "Pinned", extraClass = "") {
  const className = extraClass ? ` ${extraClass}` : "";
  return `
    <span class="session-pin-indicator${className}" title="Pinned session">
      ${renderPinIcon()}
      ${label ? `<span>${escapeHtml(label)}</span>` : ""}
    </span>
  `;
}

function renderSessionTagSelect(session, extraClass = "") {
  const className = extraClass ? ` ${extraClass}` : "";
  const currentValue = normalizeSessionTagColor(session.tagColor) || "";

  return `
    <select class="session-tag-select${className}" data-session-tag-select="true" data-session-id="${session.id}" aria-label="Set session color tag">
      ${SESSION_TAG_OPTIONS.map((option) => `<option value="${escapeAttribute(option.value)}" ${currentValue === option.value ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}
    </select>
  `;
}

function renderPinIcon() {
  return `
    <svg class="session-pin-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.2 2.4h5.6v1.6l-1.6 1.6v2.1l1.8 1.8v1H8.7v2.9l-.7.8-.7-.8v-2.9H5v-1l1.8-1.8V5.6L5.2 4z" fill="currentColor"/>
    </svg>
  `;
}

function renderRestartIcon() {
  return `
    <svg class="session-restart-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.46-3.54" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M10.6 2.7H13v2.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
}

function restartTargetAgentLabel() {
  return agentLabel(defaultSessionAgentId());
}

type SessionRestartButtonRenderOptions = {
  className?: string;
  primary?: boolean;
  tagName?: "button" | "span";
  noDrag?: boolean;
  stopRowSelect?: boolean;
};

function renderSessionRestartButton(session, options: SessionRestartButtonRenderOptions = {}) {
  const {
    className = "",
    primary = false,
    tagName = "button",
    noDrag = false,
    stopRowSelect = false
  } = options;
  const label = restartSessionActionLabel();
  const classes = classNames(
    className || undefined,
    "session-restart-button",
    primary ? "primary" : undefined
  );
  const title = `Restart with ${restartTargetAgentLabel()}`;
  const baseAttrs = [
    `class="${escapeAttribute(classes)}"`,
    `data-action="restart-session"`,
    `data-session-id="${escapeAttribute(session.id)}"`,
    `data-runtime-state="${escapeAttribute(session.runtimeState)}"`,
    `aria-label="${escapeAttribute(title)}"`,
    `title="${escapeAttribute(title)}"`
  ];

  if (tagName === "button") {
    baseAttrs.push(`type="button"`);
  } else {
    baseAttrs.push(`role="button"`, `tabindex="-1"`);
  }

  if (noDrag) {
    baseAttrs.push(`data-no-drag="true"`);
  }

  if (stopRowSelect) {
    baseAttrs.push(`data-stop-row-select="true"`);
  }

  return `
    <${tagName} ${baseAttrs.join(" ")}>
      ${renderRestartIcon()}
      <span class="session-restart-label">${escapeHtml(label)}</span>
    </${tagName}>
  `;
}

function renderSessionRestartButtonElement(
  session,
  options: SessionRestartButtonRenderOptions = {}
) {
  return trustedElement<HTMLElement>(renderSessionRestartButton(session, options));
}

function renderSessionRestartInline(session) {
  return renderSessionRestartButton(session, {
    className: "session-inline-action",
    tagName: "span",
    stopRowSelect: true
  });
}

function renderSessionRestartInlineElement(session) {
  return renderSessionRestartButtonElement(session, {
    className: "session-inline-action",
    tagName: "span",
    stopRowSelect: true
  });
}

function selectionMatches(type: RendererSelection["type"], id: string | null = null): boolean {
  return ui.selection.type === type && (id === null || ui.selection.id === id);
}

function mainListSelectionMatches(sessionId) {
  return ui.focusSection === "main" && ui.mainListSessionId === sessionId;
}

function renderProjectAvatar(repo) {
  return buildIdenticonSvg(repo.path || repo.name || repo.id);
}

function renderProjectAvatarElement(repo): SVGElement {
  return trustedElement<SVGElement>(renderProjectAvatar(repo));
}

function renderUtilityIconElement(kind): SVGElement {
  return trustedElement<SVGElement>(renderUtilityIcon(kind));
}

function renderSessionVisualButtonElement(session, extraClass = "", action = "", label = "Upload session icon") {
  return trustedElement<HTMLButtonElement>(
    renderSessionVisualButton(session, extraClass, action, label)
  );
}

function renderSessionVisualElement(
  session,
  extraClass = "",
  options: { includePlaceholder?: boolean } = {}
) {
  const html = renderSessionVisual(session, extraClass, options).trim();
  if (!html) {
    return null;
  }

  return trustedElement<HTMLElement>(html);
}

function renderSessionPinIndicatorElement(label = "Pinned", extraClass = "") {
  return trustedElement<HTMLElement>(renderSessionPinIndicator(label, extraClass));
}

function renderSessionTagSelectElement(session, extraClass = "") {
  return trustedElement<HTMLSelectElement>(renderSessionTagSelect(session, extraClass));
}

function renderAcceleratorMarkupElement(accelerator: string) {
  return trustedElement<HTMLElement>(renderAcceleratorMarkup(accelerator));
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
    case "collapse":
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15.5 5.5 8.5 12l7 6.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
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
    appLaunchDialog.open ||
    planReviewDialog.open ||
    Object.values(EPHEMERAL_TOOL_DIALOGS).some((definition) => definition.dialog.open)
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

function isWorkspaceNavbarTarget(target: HTMLElement | null) {
  if (!target) {
    return false;
  }

  return !!target.closest("#session-workspace-toolbar");
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
      case "collapse-sidebar":
        collapseSidebarChrome();
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
  if (!result || !ui.sessionSearchRepoId) {
    return;
  }

  if (canResumeSessionSearchResult(result)) {
    await resumeFromSessionSearchResult(index);
    return;
  }

  await api.revealPath({
    scope: "session-search-result",
    repoId: ui.sessionSearchRepoId,
    filePath: result.filePath
  });
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

  if (canResumeSessionSearchResult(result)) {
    sessionSearchDialog.close();
    const newSessionId = await api.resumeFromSessionSearchResult(
      ui.sessionSearchRepoId,
      result.source,
      result.sessionId
    );
    if (newSessionId) {
      await selectSession(newSessionId, "terminal");
    }
    return;
  }

  await api.revealPath({
    scope: "session-search-result",
    repoId: ui.sessionSearchRepoId,
    filePath: result.filePath
  });
}

async function revealSessionSearchResult(index: number) {
  const result = ui.sessionSearchResults[index];
  if (!result || !ui.sessionSearchRepoId) {
    return;
  }

  await api.revealPath({
    scope: "session-search-result",
    repoId: ui.sessionSearchRepoId,
    filePath: result.filePath
  });
}

function pathLeafLabel(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts.slice(-2).join("/");
}

function canResumeSessionSearchResult(
  result: SessionSearchResult | null | undefined
): result is SessionSearchResult & { sessionId: string } {
  return !!result && (result.source === "claude" || result.source === "codex") && !!result.sessionId;
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
  const kb = getKeybindings();
  return matchesAccelerator(event, kb["new-session"]) || matchesAccelerator(event, kb["new-session-alt"]);
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
  const lines = (transcript || "").trim().split("\n").filter(Boolean);
  // Walk backwards to find the last line that looks like meaningful text,
  // skipping lines dominated by terminal escape artifacts (e.g. OSC color
  // responses like "rgb:f4f4/f7f7/fbfb") or lines that are mostly
  // non-alphanumeric noise.
  for (let i = lines.length - 1; i >= 0; i--) {
    const cleaned = lines[i]
      .replace(/\d{1,3};rgb:[0-9a-f/]+/gi, "")
      .replace(/rgb:[0-9a-f/]+/gi, "")
      .trim();
    if (cleaned.length >= 2 && /[a-zA-Z]/.test(cleaned)) {
      return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
    }
  }
  return "No transcript yet.";
}

function abbreviateHome(value) {
  // Replace Unix home dirs (/Users/name or /home/name) and Windows home dirs (C:\Users\name)
  return value
    .replace(/^\/(?:Users|home)\/[^/]+/, "~")
    .replace(/^[A-Za-z]:[/\\]Users[/\\][^/\\]+/, "~");
}

function trimRawTranscript(value) {
  return value.length > 250000 ? value.slice(-250000) : value;
}

function pathLabel(filePath) {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

function renderMarkdownDocument(
  markdown: string | null | undefined,
  context: MarkdownRenderContext = { kind: "plain", repoId: null }
) {
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

    blocks.push(`<p>${renderInlineMarkdown(paragraph.join(" "), context)}</p>`);
    paragraph.length = 0;
  };

  const flushUnorderedList = () => {
    if (!unorderedList.length) {
      return;
    }

    blocks.push(
      `<ul>${unorderedList.map((item) => `<li>${renderInlineMarkdown(item, context)}</li>`).join("")}</ul>`
    );
    unorderedList.length = 0;
  };

  const flushOrderedList = () => {
    if (!orderedList.length) {
      return;
    }

    blocks.push(
      `<ol>${orderedList.map((item) => `<li>${renderInlineMarkdown(item, context)}</li>`).join("")}</ol>`
    );
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
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2].trim(), context)}</h${level}>`);
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushUnorderedList();
      flushOrderedList();
      blocks.push(`<blockquote>${renderInlineMarkdown(quote[1], context)}</blockquote>`);
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

function renderInlineMarkdownText(value: string | null | undefined) {
  let html = escapeHtml(value);

  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  return html;
}

function renderInlineMarkdown(
  value: string | null | undefined,
  context: MarkdownRenderContext = { kind: "plain", repoId: null }
) {
  const raw = String(value ?? "");
  const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let html = "";
  let lastIndex = 0;

  for (const match of raw.matchAll(linkPattern)) {
    const index = match.index ?? 0;
    html += renderInlineMarkdownText(raw.slice(lastIndex, index));
    html += renderMarkdownLink(match[1] || "", match[2] || "", context);
    lastIndex = index + match[0].length;
  }

  html += renderInlineMarkdownText(raw.slice(lastIndex));
  return html;
}

function renderMarkdownLink(
  label: string,
  href: string,
  context: MarkdownRenderContext
) {
  const resolved = resolveMarkdownLink(href, context);
  const renderedLabel = renderInlineMarkdownText(label);
  if (!resolved) {
    return renderedLabel;
  }

  switch (resolved.kind) {
    case "github-url":
      return `<a href="#" data-action="markdown-open-github" data-url="${escapeAttribute(resolved.url)}">${renderedLabel}</a>`;
    case "wiki-file":
      return `<a href="#" data-action="markdown-open-wiki" data-repo-id="${escapeAttribute(resolved.repoId)}" data-wiki-path="${escapeAttribute(resolved.relativePath)}">${renderedLabel}</a>`;
    case "repo-file":
      return `<a href="#" data-action="markdown-reveal-repo-file" data-repo-id="${escapeAttribute(resolved.repoId)}" data-relative-path="${escapeAttribute(resolved.relativePath)}">${renderedLabel}</a>`;
    default:
      return renderedLabel;
  }
}

function resolveMarkdownLink(
  href: string,
  context: MarkdownRenderContext
): ResolvedMarkdownLink | null {
  const normalizedHref = String(href ?? "").trim();
  if (!normalizedHref || normalizedHref.startsWith("#")) {
    return null;
  }

  const githubUrl = resolveGitHubMarkdownUrl(normalizedHref, context);
  if (githubUrl) {
    return { kind: "github-url", url: githubUrl };
  }

  if (context.kind === "wiki") {
    return resolveWikiMarkdownLink(normalizedHref, context.repoId, context.currentPath);
  }

  if (context.kind === "plain" && context.repoId) {
    return resolveRepoMarkdownLink(normalizedHref, context.repoId);
  }

  return null;
}

function resolveGitHubMarkdownUrl(
  href: string,
  context: MarkdownRenderContext
): string | null {
  try {
    const parsed =
      context.kind === "marketplace"
        ? new URL(href, buildMarketplaceMarkdownBaseUrl(context.source) || undefined)
        : new URL(href);
    return isGitHubMarkdownUrl(parsed) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function resolveWikiMarkdownLink(
  href: string,
  repoId: string,
  currentPath: string
): ResolvedMarkdownLink | null {
  try {
    const baseUrl = new URL("https://wiki.invalid/");
    baseUrl.pathname = `/.wiki/${currentPath.replace(/^\/+/, "")}`;
    const resolvedUrl = new URL(href, baseUrl);
    if (resolvedUrl.origin !== baseUrl.origin) {
      return null;
    }

    const normalizedPath = decodeURIComponent(resolvedUrl.pathname);
    if (normalizedPath === "/.wiki" || normalizedPath === "/.wiki/") {
      return null;
    }

    if (normalizedPath.startsWith("/.wiki/")) {
      return {
        kind: "wiki-file",
        repoId,
        relativePath: normalizedPath.slice("/.wiki/".length)
      };
    }

    const relativePath = normalizedPath.replace(/^\/+/, "");
    if (!relativePath) {
      return null;
    }

    return { kind: "repo-file", repoId, relativePath };
  } catch {
    return null;
  }
}

function resolveRepoMarkdownLink(href: string, repoId: string): ResolvedMarkdownLink | null {
  try {
    const baseUrl = new URL("https://repo.invalid/");
    const resolvedUrl = new URL(href, baseUrl);
    if (resolvedUrl.origin !== baseUrl.origin) {
      return null;
    }

    const relativePath = decodeURIComponent(resolvedUrl.pathname).replace(/^\/+/, "");
    if (!relativePath) {
      return null;
    }

    return { kind: "repo-file", repoId, relativePath };
  } catch {
    return null;
  }
}

function buildMarketplaceMarkdownBaseUrl(source: MarketplaceSkillSource): string | null {
  const owner = typeof source.owner === "string" ? source.owner.trim() : "";
  const repo = typeof source.repo === "string" ? source.repo.trim() : "";
  const ref = typeof source.ref === "string" ? source.ref.trim() : "";
  if (!owner || !repo || !ref) {
    return null;
  }

  const pathSegments = String(source.path || "")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));
  if (!pathSegments.length || pathSegments[pathSegments.length - 1] !== "SKILL.md") {
    pathSegments.push("SKILL.md");
  }

  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${encodeURIComponent(ref)}/${pathSegments.join("/")}`;
}

function isGitHubMarkdownUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return (
    url.protocol === "https:" &&
    (hostname === "github.com" || hostname === "www.github.com")
  );
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
