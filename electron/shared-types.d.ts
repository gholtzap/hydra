export type AgentId =
  | "claude"
  | "codex"
  | "gemini"
  | "aider"
  | "opencode"
  | "goose"
  | "amazon-q"
  | "github-copilot"
  | "junie"
  | "qwen"
  | "amp"
  | "warp";

export type SessionTagColor =
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "gray";

export type WorkspaceSplitAxis = "row" | "column";

export type WorkspaceLeafNode = {
  type: "leaf";
  sessionId: string;
};

export type WorkspaceSplitNode = {
  type: "split";
  axis: WorkspaceSplitAxis;
  children: WorkspaceLayoutNode[];
  sizes?: number[];
};

export type WorkspaceLayoutNode = WorkspaceLeafNode | WorkspaceSplitNode;

export type KeybindingAction =
  | "open-folder"
  | "create-folder"
  | "new-session"
  | "new-session-alt"
  | "open-wiki"
  | "quick-switcher"
  | "command-palette"
  | "next-unread"
  | "open-lazygit"
  | "open-tokscale"
  | "open-launcher"
  | "search-project-sessions"
  | "navigate-section-left"
  | "navigate-section-right"
  | "navigate-section-up"
  | "navigate-section-down";

export type KeybindingMap = Record<KeybindingAction, string>;
export type KeybindingOverrides = Partial<KeybindingMap>;

export type ThemeAppearance = "system" | "light" | "dark";

export type ThemeSeedPalette = {
  background: string;
  surface: string;
  text: string;
  mutedText: string;
  primary: string;
  border: string;
  focus: string;
  terminalBackground: string;
};

export type ThemeDefinition = {
  id: string;
  name: string;
  description: string;
  light: ThemeSeedPalette;
  dark: ThemeSeedPalette;
};

export type AgentDefinition = {
  id: AgentId;
  label: string;
  defaultCommand: string;
};

export type SessionBlockerKind =
  | "approval"
  | "toolPermission"
  | "gitConflict"
  | "question"
  | "crashed";

export type SessionBlocker = {
  kind: SessionBlockerKind;
  summary: string;
  detectedAt: string;
};

export type SessionStatus =
  | "running"
  | "blocked"
  | "needs_input"
  | "failed"
  | "done"
  | "idle";

export type SessionRuntimeState = "live" | "stopped";

export type SessionOrganizationPatch = {
  isPinned?: boolean;
  tagColor?: SessionTagColor | null;
  repoID?: string;
};

export type WorkspaceRecord = {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
};

export type RepoRecord = {
  id: string;
  workspaceID: string;
  name: string;
  path: string;
  wikiEnabled: boolean;
  discoveredAt: string;
  updatedAt?: string;
};

export type RepoSnapshot = RepoRecord & {
  wikiExists: boolean;
  wikiPath: string;
};

export type SessionRecord = {
  id: string;
  repoID: string;
  title: string;
  initialPrompt: string;
  launchesClaudeOnStart: boolean;
  startupAgentId: AgentId | null;
  claudeSessionId: string | null;
  status: SessionStatus;
  runtimeState: SessionRuntimeState;
  blocker: SessionBlocker | null;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  stoppedAt: string | null;
  launchCount: number;
  isPinned: boolean;
  tagColor: SessionTagColor | null;
  sessionIconPath: string | null;
  sessionIconUpdatedAt: string | null;
  transcript: string;
  rawTranscript: string;
};

export type SessionSummary = Omit<SessionRecord, "sessionIconPath"> & {
  sessionIconUrl: string;
};

export type AppPreferences = {
  defaultAgentId: AgentId;
  agentCommandOverrides: Record<AgentId, string>;
  claudeExecutablePath: string;
  shellExecutablePath: string;
  notificationsEnabled: boolean;
  showInAppBadges: boolean;
  showNativeNotifications: boolean;
  sessionWorkspaceLayout: WorkspaceLayoutNode | null;
  keybindings: KeybindingOverrides;
  themeAppearance: ThemeAppearance;
  themeActiveId: string;
  themeCustomThemes: ThemeDefinition[];
  [key: string]: unknown;
};

export type StoredAppState = {
  workspaces: WorkspaceRecord[];
  repos: RepoRecord[];
  sessions: SessionRecord[];
  preferences: AppPreferences;
};

export type AppStateSnapshot = {
  workspaces: WorkspaceRecord[];
  repos: RepoSnapshot[];
  sessions: SessionSummary[];
  preferences: AppPreferences;
  lazygitInstalled: boolean;
};

export type EphemeralToolId = "lazygit" | "tokscale";

export type EphemeralToolLaunchRequest = {
  toolId: EphemeralToolId;
  repoId: string;
};

export type EphemeralToolSessionRequest = {
  toolId: EphemeralToolId;
  sessionId: string;
};

export type EphemeralToolInputRequest = EphemeralToolSessionRequest & {
  data: string;
};

export type EphemeralToolResizeRequest = EphemeralToolSessionRequest & {
  cols: number;
  rows: number;
};

export type EphemeralToolOutputPayload = EphemeralToolSessionRequest & {
  data: string;
};

export type EphemeralToolExitPayload = EphemeralToolSessionRequest;

export type SessionUpdatedPayload = {
  session: SessionSummary;
};

export type SessionOutputPayload = {
  sessionId: string;
  data: string;
  session: SessionSummary;
};

export type AppCommandPayload = {
  command: string;
  sessionId?: string;
  repoId?: string;
};

export type Point = {
  x: number;
  y: number;
};

export type WikiTreeNode = {
  type: "directory" | "file";
  name: string;
  relativePath: string;
  children?: WikiTreeNode[];
};

export type WikiContext = {
  enabled: boolean;
  exists: boolean;
  wikiPath: string;
  tree: WikiTreeNode[];
};

export type WikiFileContents = {
  relativePath: string;
  absolutePath: string;
  contents: string;
};

export type FileTreeNode = {
  type: "directory" | "file";
  name: string;
  path: string;
  relativePath: string;
  children?: FileTreeNode[];
};

export type DirectoryReadResult = {
  path: string;
  tree: FileTreeNode[];
} | null;

export type ReadFileResult = {
  content: string | null;
  tooLarge?: boolean;
  size?: number;
  error?: string;
};

export type SessionSearchSource = "claude" | "codex";

export type SessionSearchResult = {
  source: SessionSearchSource;
  filePath: string;
  sessionId: string | null;
  lineNumber: number | null;
  preview: string;
  title: string;
};

export type SessionSearchResponse = {
  ok: boolean;
  installCommand: string;
  missingTools: string[];
  results: SessionSearchResult[];
  error?: string;
};

export type MarketplaceReviewState = "reviewed" | "unreviewed";

export type MarketplaceSkillSource = {
  owner: string;
  repo: string;
  ref?: string;
  path: string;
  reviewState?: MarketplaceReviewState;
  tags?: string[];
};

export type MarketplaceSkillFile = {
  path: string;
  relativePath: string;
  size: number;
};

export type MarketplaceSkillSummary = {
  id: string;
  title: string;
  description: string;
  reviewState: MarketplaceReviewState;
  sourceUrl: string;
  repoUrl: string;
  repoFullName: string;
  stars: number;
  updatedAt: string;
  tags: string[];
  compatibility: string[];
  fileCount: number;
  source: Required<Pick<MarketplaceSkillSource, "owner" | "repo" | "ref" | "path">>;
};

export type MarketplaceSkillDetails = MarketplaceSkillSummary & {
  markdown: string;
  files: MarketplaceSkillFile[];
  installTargets: {
    user: string | null;
    project: string | null;
  };
};

export type MarketplaceSearchResponse = {
  query: string;
  results: MarketplaceSkillSummary[];
};

export type MarketplaceInspectResponse = {
  results: MarketplaceSkillSummary[];
};

export type MarketplaceInstallScope = "user" | "project";

export type MarketplaceInstallResponse = {
  installed: true;
  installPath: string;
  scope: MarketplaceInstallScope;
  skillName: string;
  sourceUrl: string;
};

export type ClaudeSettingsFileScope = "global" | "project";

export type ClaudeSettingsFileSummary = {
  id: string;
  title: string;
  path: string;
  scope: ClaudeSettingsFileScope;
  exists: boolean;
};

export type ClaudeResolvedValue = {
  id: string;
  keyPath: string;
  valueSummary: string;
  sourceLabel: string;
};

export type ClaudePluginInventoryItem = {
  id: string;
  name: string;
  marketplace: string;
  installed: boolean;
  enabled: boolean;
  enabledValue: boolean | null;
  sourceLabel: string | null;
  installPath: string | null;
  version: string | null;
  installedAt: string | null;
  lastUpdated: string | null;
  skillCount: number;
  skillNames: string[];
};

export type ClaudeSkillSourceType = "project" | "user" | "managed" | "plugin";

export type ClaudeSkillInventoryItem = {
  id: string;
  name: string;
  path: string;
  sourceType: ClaudeSkillSourceType;
  sourceLabel: string;
  editable: boolean;
  description: string;
  iconPath: string;
  iconUrl: string;
  pluginId: string | null;
};

export type ClaudeSkillRoots = {
  user: string;
  project: string | null;
  managed: string | null;
};

export type ClaudeSettingsContext = {
  globalFiles: ClaudeSettingsFileSummary[];
  projectFiles: ClaudeSettingsFileSummary[];
  resolvedValues: ClaudeResolvedValue[];
  plugins: ClaudePluginInventoryItem[];
  skills: ClaudeSkillInventoryItem[];
  skillRoots: ClaudeSkillRoots;
};

export type PortListener = {
  pid: number;
  command: string;
  address: string;
};

export type PortStatusItem = {
  port: number;
  status: "listening" | "closed";
  listenerCount: number;
  listeners: PortListener[];
  primaryCommand: string | null;
  primaryPid: number | null;
  addressSummary: string[];
  localUrl: string;
};

export type PortStatusGroup = {
  id: string;
  label: string;
  description: string;
  totalCount: number;
  activeCount: number;
  activePorts: PortStatusItem[];
  ports: PortStatusItem[];
};

export type TrackedPortStatus = {
  available: boolean;
  scannedAt: string;
  trackedPortCount: number;
  activeCount: number;
  groups: PortStatusGroup[];
  ports: PortStatusItem[];
  activePorts: PortStatusItem[];
  error?: string;
};

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = {
  [key: string]: JsonValue;
};

export type PtyCreateSessionPayload =
  | {
      sessionId: string;
      cwd: string;
      shellPath: string;
      command?: never;
    }
  | {
      sessionId: string;
      cwd: string;
      command: string[];
      shellPath?: never;
    };

export type PtyHostMessage =
  | {
      type: "created";
      sessionId: string;
    }
  | {
      type: "data";
      sessionId: string;
      data: string;
    }
  | {
      type: "exit";
      sessionId: string;
      exitCode: number;
    };
