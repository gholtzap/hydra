# Claude Workspace Product Memory

## Confirmed product direction

- Build a macOS app for solo developers to run and manage many Claude Code sessions across many local repositories.
- One session equals one live Claude Code instance.
- The app launches and manages Claude Code processes itself.
- The experience should feel like Claude Code or Codex inside a desktop shell, not like a separate chat product.
- The main session surface is a true PTY-backed session surface with native app chrome around it.
- Sessions should behave like a VS Code integrated terminal tab: the user is inside a real repo shell, can enter Claude normally, and can exit back to the shell without leaving the session.
- The app is beginner-friendly by default but still grounded in real terminal sessions and real files.
- The architecture should be Claude-first in v1 while leaving room for other terminal-based coding agents later.

## Confirmed v1 requirements

### Core UX

- Default landing view is `Inbox / Needs Attention`.
- Inbox includes blocked plus unread sessions, with blockers sorted first.
- Left sidebar hierarchy:
  - `Running Sessions`
  - `Workspaces`
  - `Repos` inside each workspace
- Running sessions should have priority similar to Discord DMs.
- Repos remain visible even with no active sessions.
- Users can open many projects and many sessions at once.
- Session titles default to the inferred first user prompt or task title.

### Session behavior

- Quitting the app warns if active sessions exist.
- Quitting the app terminates running Claude processes.
- On relaunch, prior sessions are restored as history only and remain stopped.
- Reopening a historical session keeps the same session identity but launches a fresh Claude process in that repo.
- Done sessions stay visible in the repo list until manually closed.
- Close session and terminate process are the same action in v1.
- Session startup is shell-first: each session launches a login shell in the repo, and v1 may optionally auto-run the configured Claude command inside that shell.
- The session view should not use a fake chat composer. Terminal input belongs directly in the terminal surface.

### States and notifications

- Exposed session states:
  - `running`
  - `needs_input`
  - `blocked`
  - `done`
  - `failed`
  - `idle`
- Notifications should fire on blockers.
- Notifications should be detailed, not generic.
- Unread is automatic-only in v1.
- Done detection should be conservative and optimize to avoid false positives.

### Workspace model

- A workspace is a real filesystem folder containing multiple repos.
- The app scans a selected folder for git repos automatically.
- v1 is local-only.
- Project creation in v1 only needs `create empty folder`.

### Native app features

- Global quick launcher can create a session in any recent repo.
- Keybindings in v1:
  - quick switcher
  - command palette
  - jump to next unread session
- Native approval actions should exist for Claude blockers, with terminal fallback if heuristics are not enough.
- Notifications should be available both natively and in-app, with global preferences.

### Settings

- v1 needs a real settings UI.
- It should cover:
  - global Claude settings
  - per-project Claude settings
  - model/defaults
  - permissions/tool policies
  - notification preferences
  - keybindings
- Raw file editing must be available.
- If global and project settings overlap, the UI should show the final resolved value.

## Implementation notes captured during discovery

- Use real terminal sessions and real files as the foundation.
- Do not rely only on scraped terminal text if structured Claude signals become available later.
- If Claude does not expose reliable structured status or blocker signals, v1 should use conservative PTY heuristics and prefer under-detecting over false positives.
- If a workspace has no nested git repos yet, treat the workspace root itself as a runnable project so users can open or create a folder and start Claude immediately.

## Current implementation direction

- The product is pivoting away from the Swift shell and onto an Electron shell.
- The reason for the pivot is product fit, not platform impossibility: the goal is to feel like the VS Code terminal, and Electron gives direct access to the same class of terminal stack.
- The desktop stack should be:
  - Electron app shell
  - `xterm.js` renderer
  - PTY host for real shell processes
- The current PTY bridge uses a Python helper because `node-pty` was failing to spawn shells correctly in this environment.
- Terminal parity work should prioritize:
  - preserving PTY output without corrupting UTF-8 across chunk boundaries
  - waiting for the real xterm size before auto-launching Claude's TUI
  - revisiting a first-class PTY backend once the shell host is stable
- The terminal workflow should stay shell-native even when the app adds higher-level Claude affordances like blockers, notifications, and settings.
- Existing Swift code is now reference material for product behavior and state shape, not the long-term implementation path.

## Explicit non-v1 ideas to keep for later

- Full archived session search and history browsing.
- Remote repos, SSH, and container-backed projects.
- Per-project notification overrides.
- Session templates such as `general`, `bugfix`, `feature`, and `review`.
- First-class support for additional terminal-based coding agents.
- More advanced terminal rendering if the initial PTY view is not sufficient.
- Richer blocker handling once Claude exposes stronger structured events.
