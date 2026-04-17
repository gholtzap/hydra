/**
 * Internal API - Thin adapter providing typed access to AppController state/methods.
 *
 * This module does NOT duplicate logic from main.ts. It reads from appController.state
 * and delegates mutations to existing AppController patterns.
 */

import type {
  AppStateSnapshot,
  ClaudeSettingsContext,
  DirectoryReadResult,
  MarketplaceInspectResponse,
  MarketplaceInstallResponse,
  MarketplaceInstallScope,
  MarketplaceReviewState,
  MarketplaceSkillDetails,
  RepoRecord,
  RepoAppLaunchConfig,
  SessionSearchResponse,
  SessionTagColor,
  SessionRecord,
  SessionStatus,
  StoredAppState,
  TrackedPortStatus,
  WikiContext,
  WikiFileContents,
  WorkspaceRecord,
  ReadFileResult
} from "../shared-types";

type MarketplaceSkillSourcePayload = {
  owner: string;
  repo: string;
  ref?: string;
  path: string;
  reviewState?: MarketplaceReviewState;
  tags?: string[];
};

type MarketplaceSkillDetailsArgs =
  | { source: MarketplaceSkillSourcePayload }
  | MarketplaceSkillSourcePayload;

type MarketplaceInstallArgs =
  | {
      source: { owner: string; repo: string; ref?: string; path: string };
      scope: MarketplaceInstallScope;
      repoPath?: string | null;
    }
  | {
      owner: string;
      repo: string;
      ref?: string;
      path: string;
      scope: MarketplaceInstallScope;
      repoPath?: string | null;
    };

export type McpActionName =
  | "create_session"
  | "rename_session"
  | "close_session"
  | "reopen_session"
  | "organize_session"
  | "search_sessions"
  | "resume_session"
  | "add_workspace"
  | "rescan_workspace"
  | "set_build_run_config"
  | "build_and_run_app"
  | "list_files"
  | "read_file"
  | "update_preferences"
  | "get_settings_context"
  | "load_settings_file"
  | "save_settings_file"
  | "get_wiki"
  | "read_wiki_page"
  | "toggle_wiki"
  | "get_skill_details"
  | "inspect_skill_url"
  | "install_skill"
  | "get_port_status"
  | "launch_ephemeral_tool"
  | "close_ephemeral_tool";

export type McpActionArgsMap = {
  create_session: {
    repoId: string;
    autoLaunch?: boolean;
    agentId?: string;
    prompt?: string;
  };
  rename_session: { sessionId: string; title: string };
  close_session: { sessionId: string };
  reopen_session: { sessionId: string };
  organize_session: {
    sessionId: string;
    pin?: boolean;
    isPinned?: boolean;
    tagColor?: SessionTagColor | null | string;
    repoId?: string;
  };
  search_sessions: { repoId: string; query: string };
  resume_session: { repoId: string; source?: string; externalSessionId: string };
  add_workspace: { path: string };
  rescan_workspace: { workspaceId: string };
  set_build_run_config: { repoId: string; buildCommand: string; runCommand: string };
  build_and_run_app: { repoId: string };
  list_files: { repoId: string };
  read_file: { repoId: string; path: string };
  update_preferences: ({ patch?: Record<string, unknown> } & Record<string, unknown>);
  get_settings_context: { repoId: string };
  load_settings_file: { repoId: string; filePath: string };
  save_settings_file: { repoId: string; filePath: string; content: string };
  get_wiki: { repoId: string };
  read_wiki_page: { repoId: string; path: string };
  toggle_wiki: { repoId: string; enabled: boolean };
  get_skill_details: MarketplaceSkillDetailsArgs;
  inspect_skill_url: { url: string };
  install_skill: MarketplaceInstallArgs;
  get_port_status: Record<string, never>;
  launch_ephemeral_tool: { toolId: string; repoId: string };
  close_ephemeral_tool: { toolId: string; sessionId: string };
};

export type McpActionResultMap = {
  create_session: string | null;
  rename_session: boolean;
  close_session: void;
  reopen_session: void;
  organize_session: boolean;
  search_sessions: SessionSearchResponse;
  resume_session: string | null;
  add_workspace: void;
  rescan_workspace: void;
  set_build_run_config: RepoAppLaunchConfig | null;
  build_and_run_app: string | null;
  list_files: DirectoryReadResult;
  read_file: ReadFileResult;
  update_preferences: void;
  get_settings_context: ClaudeSettingsContext;
  load_settings_file: string;
  save_settings_file: { ok: true };
  get_wiki: WikiContext | null;
  read_wiki_page: WikiFileContents;
  toggle_wiki: WikiContext | null;
  get_skill_details: MarketplaceSkillDetails;
  inspect_skill_url: MarketplaceInspectResponse;
  install_skill: MarketplaceInstallResponse;
  get_port_status: TrackedPortStatus;
  launch_ephemeral_tool: string | null;
  close_ephemeral_tool: void;
};

export type McpActionArgs<Action extends McpActionName> = McpActionArgsMap[Action];
export type McpActionResult<Action extends McpActionName> = McpActionResultMap[Action];

/**
 * Minimal interface for the AppController instance from main.ts.
 * We only type the properties/methods we actually access so this file
 * stays decoupled from the full AppController class.
 */
export interface AppControllerHandle {
  state: StoredAppState;
  focusedSessionId: string | null;
  lazygitPath: string | null;
  snapshot(): AppStateSnapshot;
  sessionById(sessionId: string): SessionRecord | null;
  broadcastState(): void;
  ptyHost: {
    sendInput(sessionId: string, data: string): void;
  };
  handleMcpAction<Action extends McpActionName>(
    action: Action,
    args: McpActionArgs<Action>
  ): Promise<McpActionResult<Action>>;
}

export type SessionFilters = {
  repoId?: string;
  status?: SessionStatus;
  limit?: number;
};

export class InternalApi {
  private ctrl: AppControllerHandle;

  constructor(appController: AppControllerHandle) {
    this.ctrl = appController;
  }

  // ── Read-only state access ────────────────────────────────────────

  /** Full app state snapshot (same data the renderer receives). */
  getSnapshot(): AppStateSnapshot {
    return this.ctrl.snapshot();
  }

  /** Find a single session by ID. */
  getSessionById(id: string): SessionRecord | null {
    return this.ctrl.sessionById(id);
  }

  /** Find a single repo by ID. */
  getRepoById(id: string): RepoRecord | null {
    return this.ctrl.state.repos.find((r) => r.id === id) || null;
  }

  /** Find a single workspace by ID. */
  getWorkspaceById(id: string): WorkspaceRecord | null {
    return this.ctrl.state.workspaces.find((w) => w.id === id) || null;
  }

  /** Filtered session list. */
  getSessions(filters?: SessionFilters): SessionRecord[] {
    let sessions: SessionRecord[] = this.ctrl.state.sessions;

    if (filters?.repoId) {
      sessions = sessions.filter((s) => s.repoID === filters.repoId);
    }
    if (filters?.status) {
      sessions = sessions.filter((s) => s.status === filters.status);
    }
    if (filters?.limit && filters.limit > 0) {
      sessions = sessions.slice(0, filters.limit);
    }

    return sessions;
  }

  /** Blocked and unread sessions (the "inbox"). */
  getInbox(): { blocked: SessionRecord[]; unread: SessionRecord[] } {
    const all = this.ctrl.state.sessions;
    return {
      blocked: all.filter((s) => s.status === "blocked"),
      unread: all.filter((s) => s.unreadCount > 0),
    };
  }

  /** All workspaces. */
  getWorkspaces(): WorkspaceRecord[] {
    return this.ctrl.state.workspaces;
  }

  /** All repos, optionally filtered by workspace. */
  getRepos(workspaceId?: string): RepoRecord[] {
    if (workspaceId) {
      return this.ctrl.state.repos.filter((r) => r.workspaceID === workspaceId);
    }
    return this.ctrl.state.repos;
  }

  // ── Mutations ────────────────────────────────────────────────────
  // Typed wrappers around handleMcpAction for type-safe access.

  async createSession(
    repoId: string,
    options?: { agentId?: string; prompt?: string }
  ): Promise<McpActionResult<"create_session">> {
    return this.ctrl.handleMcpAction("create_session", { repoId, ...options });
  }

  async renameSession(sessionId: string, title: string): Promise<McpActionResult<"rename_session">> {
    return this.ctrl.handleMcpAction("rename_session", { sessionId, title });
  }

  async closeSession(sessionId: string): Promise<McpActionResult<"close_session">> {
    return this.ctrl.handleMcpAction("close_session", { sessionId });
  }

  async reopenSession(sessionId: string): Promise<McpActionResult<"reopen_session">> {
    return this.ctrl.handleMcpAction("reopen_session", { sessionId });
  }

  async organizeSession(
    sessionId: string,
    patch: { isPinned?: boolean; tagColor?: SessionTagColor | null; repoId?: string }
  ): Promise<McpActionResult<"organize_session">> {
    return this.ctrl.handleMcpAction("organize_session", { sessionId, ...patch });
  }

  async searchSessions(repoId: string, query: string): Promise<McpActionResult<"search_sessions">> {
    return this.ctrl.handleMcpAction("search_sessions", { repoId, query });
  }

  async resumeSession(
    repoId: string,
    externalSessionId: string,
    source?: string
  ): Promise<McpActionResult<"resume_session">> {
    return this.ctrl.handleMcpAction("resume_session", { repoId, externalSessionId, source });
  }

  async addWorkspace(path: string): Promise<McpActionResult<"add_workspace">> {
    return this.ctrl.handleMcpAction("add_workspace", { path });
  }

  async rescanWorkspace(workspaceId: string): Promise<McpActionResult<"rescan_workspace">> {
    return this.ctrl.handleMcpAction("rescan_workspace", { workspaceId });
  }

  async setBuildRunConfig(
    repoId: string,
    buildCommand: string,
    runCommand: string
  ): Promise<McpActionResult<"set_build_run_config">> {
    return this.ctrl.handleMcpAction("set_build_run_config", { repoId, buildCommand, runCommand });
  }

  async buildAndRunApp(repoId: string): Promise<McpActionResult<"build_and_run_app">> {
    return this.ctrl.handleMcpAction("build_and_run_app", { repoId });
  }

  async updatePreferences(patch: Record<string, unknown>): Promise<McpActionResult<"update_preferences">> {
    return this.ctrl.handleMcpAction("update_preferences", { patch });
  }

  async loadSettingsFile(repoId: string, filePath: string): Promise<McpActionResult<"load_settings_file">> {
    return this.ctrl.handleMcpAction("load_settings_file", { repoId, filePath });
  }

  async saveSettingsFile(
    repoId: string,
    filePath: string,
    content: string
  ): Promise<McpActionResult<"save_settings_file">> {
    return this.ctrl.handleMcpAction("save_settings_file", { repoId, filePath, content });
  }

  async getSettingsContext(repoId: string): Promise<McpActionResult<"get_settings_context">> {
    return this.ctrl.handleMcpAction("get_settings_context", { repoId });
  }

  async getWiki(repoId: string): Promise<McpActionResult<"get_wiki">> {
    return this.ctrl.handleMcpAction("get_wiki", { repoId });
  }

  async readWikiPage(repoId: string, pagePath: string): Promise<McpActionResult<"read_wiki_page">> {
    return this.ctrl.handleMcpAction("read_wiki_page", { repoId, path: pagePath });
  }

  async toggleWiki(repoId: string, enabled: boolean): Promise<McpActionResult<"toggle_wiki">> {
    return this.ctrl.handleMcpAction("toggle_wiki", { repoId, enabled });
  }

  async listFiles(repoId: string): Promise<McpActionResult<"list_files">> {
    return this.ctrl.handleMcpAction("list_files", { repoId });
  }

  async readFile(repoId: string, filePath: string): Promise<McpActionResult<"read_file">> {
    return this.ctrl.handleMcpAction("read_file", { repoId, path: filePath });
  }
}
