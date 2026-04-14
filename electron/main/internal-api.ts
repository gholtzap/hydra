/**
 * Internal API - Thin adapter providing typed access to AppController state/methods.
 *
 * This module does NOT duplicate logic from main.ts. It reads from appController.state
 * and delegates mutations to existing AppController patterns.
 */

import type {
  AppStateSnapshot,
  RepoRecord,
  SessionRecord,
  SessionStatus,
  SessionSummary,
  StoredAppState,
  WorkspaceRecord,
} from "../shared-types";

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
  handleMcpAction(action: string, args: any): Promise<any>;
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

  async createSession(repoId: string, options?: { agentId?: string; prompt?: string }): Promise<any> {
    return this.ctrl.handleMcpAction("create_session", { repoId, ...options });
  }

  async renameSession(sessionId: string, title: string): Promise<any> {
    return this.ctrl.handleMcpAction("rename_session", { sessionId, title });
  }

  async closeSession(sessionId: string): Promise<any> {
    return this.ctrl.handleMcpAction("close_session", { sessionId });
  }

  async reopenSession(sessionId: string): Promise<any> {
    return this.ctrl.handleMcpAction("reopen_session", { sessionId });
  }

  async organizeSession(sessionId: string, patch: { isPinned?: boolean; tagColor?: string | null; repoId?: string }): Promise<any> {
    return this.ctrl.handleMcpAction("organize_session", { sessionId, ...patch });
  }

  async searchSessions(repoId: string, query: string): Promise<any> {
    return this.ctrl.handleMcpAction("search_sessions", { repoId, query });
  }

  async resumeSession(repoId: string, externalSessionId: string, source?: string): Promise<any> {
    return this.ctrl.handleMcpAction("resume_session", { repoId, externalSessionId, source });
  }

  async addWorkspace(path: string): Promise<any> {
    return this.ctrl.handleMcpAction("add_workspace", { path });
  }

  async rescanWorkspace(workspaceId: string): Promise<any> {
    return this.ctrl.handleMcpAction("rescan_workspace", { workspaceId });
  }

  async setBuildRunConfig(repoId: string, buildCommand: string, runCommand: string): Promise<any> {
    return this.ctrl.handleMcpAction("set_build_run_config", { repoId, buildCommand, runCommand });
  }

  async buildAndRunApp(repoId: string): Promise<any> {
    return this.ctrl.handleMcpAction("build_and_run_app", { repoId });
  }

  async updatePreferences(patch: Record<string, any>): Promise<any> {
    return this.ctrl.handleMcpAction("update_preferences", { patch });
  }

  async loadSettingsFile(repoId: string, filePath: string): Promise<any> {
    return this.ctrl.handleMcpAction("load_settings_file", { repoId, filePath });
  }

  async saveSettingsFile(repoId: string, filePath: string, content: string): Promise<any> {
    return this.ctrl.handleMcpAction("save_settings_file", { repoId, filePath, content });
  }

  async getSettingsContext(repoId: string): Promise<any> {
    return this.ctrl.handleMcpAction("get_settings_context", { repoId });
  }

  async getWiki(repoId: string): Promise<any> {
    return this.ctrl.handleMcpAction("get_wiki", { repoId });
  }

  async readWikiPage(repoId: string, pagePath: string): Promise<any> {
    return this.ctrl.handleMcpAction("read_wiki_page", { repoId, path: pagePath });
  }

  async toggleWiki(repoId: string, enabled: boolean): Promise<any> {
    return this.ctrl.handleMcpAction("toggle_wiki", { repoId, enabled });
  }

  async listFiles(repoId: string): Promise<any> {
    return this.ctrl.handleMcpAction("list_files", { repoId });
  }

  async readFile(repoId: string, filePath: string): Promise<any> {
    return this.ctrl.handleMcpAction("read_file", { repoId, path: filePath });
  }
}
