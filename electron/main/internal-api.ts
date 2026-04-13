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

  // ── Mutation stubs ────────────────────────────────────────────────
  // These will be filled in as tool files are implemented.
  // Tools call these via the appController reference passed through.
}
