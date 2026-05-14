# Parallel Worktrees Goal

## Objective

Implement project-scoped, opt-in isolated worktrees for Hydra agent sessions, plus a lightweight coordination ledger that surfaces overlapping edits across parallel sessions.

## Plan

1. Keep the feature opt-in and store that opt-in on each project, not as a global preference.
2. Have Hydra create the Git worktree before launching an agent session, then launch the session with the worktree as its working directory.
3. Keep existing session metadata and marker conventions for lifecycle state, changed files, overlap detection, and retained worktree records.
4. Add UI in the project view and settings for enabling the feature, configuring base/landing branches, revealing worktrees, opening active sessions, and seeing overlap warnings.
5. Build-gate commits with `npm run build`; commit and push only on `om/worktrees-goal-codex`.

## Implementation Notes

- `electron/main/git-worktrees.ts` now exposes sync helpers for creating and validating Git worktrees.
- `electron/main/main.ts` creates one managed worktree per opted-in agent session before launch and uses that path as the agent terminal cwd.
- Reopened isolated sessions reuse their existing tracked worktree when Git still reports it as a valid worktree.
- Project settings are the only active opt-in source. The previous global worktree default path was removed from shared types, state normalization, and renderer settings.
- `electron/renderer/app.ts` keeps the settings form project-scoped and adds project-detail controls for enabling isolated worktrees and managing active or retained worktree entries.
- The existing changed-file refresh loop continues to populate overlap warnings by comparing changed files across active sessions in the same project.
- `.wiki/parallel-worktrees.md` records the durable architecture notes for future agents.

## Verification

- `npm run build` passed after the final implementation and documentation changes.
- Commit only after a clean final status review.
- Push only `om/worktrees-goal-codex`.
