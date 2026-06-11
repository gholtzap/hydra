# Lessons

## Workspace tools `<details>` menu closed immediately after opening (stale sig desync)

**Root cause**: `updateSessionWorkspaceTab` was introduced as a fast-path to update only a tab's title/status in the DOM without rebuilding the entire toolbar. However, it did not update `toolbar.dataset.sig`, which `updateSessionWorkspaceToolbar` uses to short-circuit full rebuilds. After `updateSessionWorkspaceTab` ran (e.g., on session output), the sig became stale. The next call to `updateSessionWorkspaceToolbar` (e.g., from `onSessionUpdated`) saw a mismatch and rebuilt the entire toolbar DOM — including a fresh, closed `<details>` element — destroying the user's open menu state.

**What caused it**: The fast-path optimization forgot to keep the sig cache in sync with the DOM mutations it performed.

**Fix**: After updating the tab DOM, `updateSessionWorkspaceTab` now recomputes the full sig (same formula as `updateSessionWorkspaceToolbar`) and stores it in `toolbar.dataset.sig`, so the next toolbar update call correctly skips the rebuild.

## New session: IPC race condition caused selectSession to silently no-op

**Root cause**: `startSessionForRepo` calls `api.createSession` (an IPC invoke) and then immediately calls `selectSession(sessionId)`. The main process calls `broadcastState()` (via `webContents.send`) *before* returning the sessionId, but `send` and `invoke` replies travel on separate Chromium IPC channels with no ordering guarantee. The invoke reply often arrives first, so `sessionById(sessionId)` returns `null` inside `selectSession` and the function returns early — the session exists in main-process state but the renderer never navigates to it.

**Fix**: After `api.createSession` resolves, check if the session is already in `state.sessions`. If not, force-sync via `replaceState(await api.getState())` before calling `selectSession`. This guarantees the session is present regardless of channel ordering.

**Second bug**: `isOpenLauncherShortcut` only checked `kb["new-session"]` (Cmd+Shift+A), not `kb["new-session-alt"]` (Cmd+N). Added the alt-binding check so the renderer keyboard handler also handles Cmd+N.

**Where**: `electron/renderer/app.ts` — `startSessionForRepo` and `isOpenLauncherShortcut`.

## EPIPE crash on session resize after pty host exits

**Root cause**: `PtyHostClient.send()` checks `this.child.stdin.writable` before writing, but the pty host process can exit between that check and the actual `stdin.write()` call, causing an `EPIPE` error. A try/catch around `stdin.write()` does NOT work because `write()` emits errors asynchronously via the stream's `'error'` event, not as a synchronous throw.

**Fix**: Attached `this.child.stdin.on("error", () => {})` and `this.child.on("error", () => {})` handlers in `start()`. In Node, unhandled `'error'` events on streams and child processes crash the process. Adding these handlers makes EPIPE (and similar write-after-close errors) non-fatal.

**Where**: `electron/main/pty-host-client.ts` — `start()` method.

## Codex plan approval: TUI uses Enter/Arrow keys, not numbered menu like Claude

**Root cause**: The plan review modal sent `"1\r"` (approve) and `"3\r"` (deny) for all sessions, copying Claude Code's numbered menu format. But Codex shows a cursor-driven interactive menu — "yes, implement this plan" / "no, stay in plan mode" — navigated with arrow keys, confirmed with Enter. Sending `"1\r"` to a Codex PTY did nothing because the TUI interpreted `1` as literal text input, not a menu selection.

**Fix**: Made `approve-blocker`, `deny-blocker`, `approve-plan-review`, and `deny-plan-review` action handlers check `session.startupAgentId === "codex"`. For Codex sessions, Approve sends `"\r"` (Enter — selects the default-highlighted "yes" option) and Deny sends `"\x1b[B\r"` (Arrow Down + Enter — moves to "no, stay in plan mode"). For all other agents, the existing `"1\r"` / `"3\r"` numbered-menu format is preserved.

**Evidence**: Analyzed `~/.codex/sessions/**/*.jsonl` files. After a plan turn ends (`task_complete`), the JSONL shows a new `task_started(collaboration_mode_kind: "default")` turn with `user_message: "Implement the plan."` — confirming the TUI generates this message internally when the user selects the menu option, not via a numbered PTY response.

**Where**: `electron/renderer/app.ts` (four action cases in the global click handler).

## Codex plan review: terminal transcript is not the only durable plan source

**Root cause**: Codex Plan Mode stores plans in `~/.codex/sessions/**/*.jsonl`, but the first durable plan record can be an `event_msg` with `payload.type === "item_completed"` and `item.type === "Plan"`, not only a final assistant message containing raw `<proposed_plan>...</proposed_plan>` tags. Hydra only detected Codex plans from the renderer transcript and then from assistant response items, so it missed the actual TUI plan event when the terminal did not expose the raw tags plainly. The blocker detector also only recognized Claude-style "proceed with this plan" text, not Codex's "Implement this plan?" prompt.

**Fix**: Added a main-process watcher for Codex session JSONL files, extracted the latest proposed plan from both Codex `Plan` event items and assistant response items, mapped it back to live Hydra Codex sessions by Codex session id or cwd, preserved file-detected Codex plans when transcript sync has no visible plan block, and taught the blocker detector Codex's plan approval phrases.

**Where**: `electron/main/main.ts`, `electron/main/session-signals.ts`, `electron/renderer/app.ts`, `.wiki/renderer-plan-review-modal.md`.

## app launch workflow: PTY-typed shell input will always leak implementation details

**Root cause**: The first `Build and Run App` implementation opened an interactive shell session and then injected a build/run shell block as terminal input. Even after simplifying the printed messages, the shell still echoed the injected command line itself, so the terminal exposed internal `printf`/`if` scaffolding instead of behaving like a dedicated app runner.

**Fix**: Switched app launches to a dedicated PTY command path backed by a standalone shell script. Hydra now starts app sessions with the runner script as the session's real process, passes the configured build/run commands from the saved repo setup, and lets the script own the spinner/status UI directly.

**Where**: `electron/main/main.ts`, `electron/main/app-launch-runner.sh`, `electron/main/state-store.ts`, `electron/shared-types.d.ts`, `package.json`.

## app build/run transcript: injected shell commands were being echoed into the PTY

**Root cause**: The `Build and Run App` flow queued multiple shell lines and sent them into an interactive PTY as normal terminal input. The shell echoed those injected commands and prompts into the transcript before executing them, so the terminal showed Hydra's internal shell block instead of a clean build/run status sequence.

**Fix**: Collapsed the workflow into a single injected shell line that immediately clears the terminal, silences build stdout/stderr, prints a minimal status sequence (`Building`, `Built`, `Now running...`), and then starts the configured run command.

**Where**: `electron/main/main.ts`.

## session visuals: empty optional markup crashed renderer boot

**Root cause**: `renderSessionVisual()` is allowed to return an empty string when a session has neither `sessionIconUrl` nor `tagColor` and the caller does not request a placeholder. But `renderSessionVisualElement()` always passed that string into `trustedElement()`, whose contract requires a real root element. On initial load, rendering any such session threw `Expected HTML fragment with a root element.` and replaced the UI with the error state.

**Fix**: Made `renderSessionVisualElement()` trim the generated HTML and return `null` when the visual is intentionally absent. The DOM composition helpers already treat `null` as "append nothing", so optional visuals no longer force HTML parsing on empty markup.

**Where**: `electron/renderer/app.ts`.

## session streaming: renderer was duplicating `rawTranscript` on every output event

**Root cause**: `appendSessionOutput()` in the renderer merged the latest `SessionSummary` from the main process, and then appended the streamed chunk to `rawTranscript` a second time. But the main process had already included that chunk in `payload.session.rawTranscript`, so the renderer copy drifted from source of truth and could replay duplicated output after remounts.

**Fix**: Stopped mutating `rawTranscript` in `appendSessionOutput()` and now trust the merged `SessionSummary` as the canonical transcript state.

**Where**: `electron/renderer/app.ts`.

## app state snapshot: async wiki check stored a `Promise` in IPC payloads

**Root cause**: `snapshot()` in the Electron main process built repo snapshots with `wikiExists(repo.path)`, but `wikiExists` is async and returns `Promise<boolean>`. That leaked unresolved `Promise` objects into the app state payload, and Electron's `structuredClone`/IPC serialization failed with `DOMException [DataCloneError]: #<Promise> could not be cloned`.

**Fix**: Added a synchronous `wikiExistsSync()` helper in `electron/main/wiki.ts` and used that inside `snapshot()`. Snapshot payloads now stay fully cloneable while async wiki helpers remain available for non-IPC code paths.

**Where**: `electron/main/main.ts`, `electron/main/wiki.ts`.

## session search rows: nested buttons break dialog actions

**Root cause**: The first `Cmd+F` search modal implementation rendered each result row as a `<button>` that also contained `Reveal` and `Open` buttons. Nested interactive controls are invalid HTML and cause broken click/keyboard behavior because the browser cannot consistently resolve which control should own the event.

**Fix**: Changed the outer search result container to a non-button row and kept only the inner action buttons interactive.

**Where**: `electron/renderer/app.ts`, `electron/renderer/app.css`.

## session search tool resolution: implicit dynamic object shape broke TypeScript

**Root cause**: `resolveRequiredTools()` built its return value with dynamic property assignment (`resolved[toolName + "Path"] = ...`). TypeScript inferred the object too narrowly, so `rgPath` and `fzfPath` were not guaranteed to exist at compile time and the main-process build failed.

**Fix**: Returned an explicit object shape with `rgPath` and `fzfPath` initialized up front, then filled those fields conditionally during tool resolution.

**Where**: `electron/main/session-search.ts`.

## terminal line editing: `Cmd+Backspace` was consumed before the PTY saw it

**Root cause**: Removing the app-level accelerator was necessary but not sufficient. Session input is terminal-backed via xterm's hidden textarea, and `Cmd+Backspace` was still being handled locally by the browser/xterm layer instead of being forwarded to the PTY. That made the shortcut look dead inside Claude/shell sessions.

**Fix**: Intercepted `Cmd+Backspace` in the session terminal's custom key handler and translated it into `Ctrl+U` (`\u0015`) on the PTY input channel, which clears the current prompt line for Claude/shell sessions without affecting launcher/settings inputs or overlay terminals.

**Where**: `electron/renderer/app.ts`.

## global shortcuts: `Cmd+Backspace` should not be app-bound

**Root cause**: I incorrectly treated `Cmd+Backspace` as a workspace command and bound it as a global accelerator. On macOS that shortcut is expected to act on the focused text control, and in a terminal/chat surface it must be allowed to pass through instead of being captured by the app shell.

**Fix**: Removed the global `Cmd+Backspace` renderer shortcut and Electron menu accelerator so the focused input or terminal can handle it normally.

**Where**: `electron/renderer/app.ts`, `electron/main/main.ts`, `.wiki/shortcuts.md`.

## global shortcuts: `Cmd+Shift+A` and `Cmd+Backspace` were never implemented

**Root cause**: The app had a global renderer `keydown` handler and an Electron menu accelerator map, but neither layer actually registered `Cmd+Shift+A` or `Cmd+Backspace`. The result looked like a shortcut regression even though the commands simply did not exist.

**Fix**: Added explicit app shortcut handling for `Cmd+Shift+A` in the renderer and a matching menu accelerator. `Cmd+Backspace` was later removed because it should remain a focused-input editing shortcut, not a global workspace command.

**Where**: `electron/renderer/app.ts`, `electron/main/main.ts`.

## guided settings editor: `null` values would have become empty strings

**Root cause**: In the new shallow JSON editor, `null` was initially classified as an editable primitive. The simplified primitive renderer only has direct controls for strings, numbers, and booleans, so a `null` value would have fallen through to the text-input path and been coerced into `""` on edit.

**Fix**: Removed `null` from the set of directly editable primitive values so it now renders as a JSON-only summary instead of a misleading simple field.

**Where**: `electron/renderer/app.ts`.

## agent files settings: search input lost focus while typing

**Root cause**: The new Agent Files search was implemented by updating renderer state and calling `renderSettingsDialog()` on every `input` event. Because the settings dialog is rebuilt with `innerHTML`, the original search `<input>` node is destroyed on each keystroke. Without restoring focus, typing a single character would blur the field and break incremental filtering.

**Fix**: After re-rendering the settings dialog for `settings-agent-search`, immediately re-focus the recreated search input so the field remains usable as a live filter.

**Where**: `electron/renderer/app.ts`.

## agent files settings: JSON and resolved rows lost header alignment

**Root cause**: The redesign removed the old `.settings-file-row-top` layout rule while switching the navigation list to new sidebar-specific row classes. That class is also reused inside the JSON editor cards and resolved-values rows, so those headers would have lost their flex alignment and collapsed into plain block flow.

**Fix**: Restored `.settings-file-row-top` as a shared flex header rule alongside the new settings row/header classes.

**Where**: `electron/renderer/app.css`.

## lazygit: `open /dev/tty: device not configured`

**Root cause**: `pty_host.py` uses `subprocess.Popen` with `start_new_session=True`, which calls `setsid()` — creating a new session with **no controlling terminal**. The PTY slave fd is connected to stdin/stdout/stderr, but is never established as the controlling terminal. When any TUI program (lazygit, vim, htop) tries to open `/dev/tty`, it fails because there's no controlling terminal for the session. Shells handle this themselves (they call `TIOCSCTTY` internally), so regular shell sessions work fine — the bug only surfaces with programs that directly open `/dev/tty`.

**Fix (attempt 1 — incomplete)**: Pass `command: ["lazygit"]` directly to `pty_host.py` so lazygit is the root process in the PTY (not a child of a shell). Added an optional `command` field to `create_session` that bypasses the default `[shellPath, "-il"]`. This alone doesn't fix the issue because the controlling terminal is still not set.

**Fix (attempt 2 — actual fix)**: Added `TIOCSCTTY` ioctl call via `preexec_fn` in `subprocess.Popen`. After `setsid()` runs (from `start_new_session=True`), the `preexec_fn` calls `fcntl.ioctl(slave_fd, TIOCSCTTY, 0)` in the child process before `exec()`, making the PTY slave the controlling terminal. This fixes `/dev/tty` access for ALL sessions, not just lazygit. `TIOCSCTTY` constant is `0x20007461` on macOS, `0x540E` on Linux.

**Where**: `electron/main/pty_host.py` (`create_session`, `TIOCSCTTY`), `electron/main/main.ts` (`createLazygitSession`).

## lazygit overlay: blank screen on open

**Root cause**: `terminal.open(host)` was called synchronously right after `lazygitDialog.showModal()`. The browser hasn't computed layout yet at that point, so the `#lazygit-terminal-host` element has 0 width/height. `fitAddon.fit()` computes 0 cols/rows, sending a useless SIGWINCH to lazygit. Additionally, lazygit starts outputting immediately upon PTY creation but the `onLazygitOutput` listener wasn't subscribed yet, so early output was lost.

**Fix**: (1) Subscribe to `onLazygitOutput` immediately (before `showModal()`) and buffer output in an array. (2) Defer `terminal.open()`, `fitAddon.fit()`, and terminal mounting to a `requestAnimationFrame` callback so the dialog has laid out first. (3) Flush the output buffer into the terminal in the same frame it's created.

**Where**: `electron/renderer/app.ts` (`openLazygitOverlay`).

## tokscale overlay: renderer dialog listener typo

**Root cause**: While wiring the new tokscale overlay, the cancel listener was attached to `toksaleDialog` instead of `tokscaleDialog`. That left a broken identifier in renderer startup and would have crashed the app before the overlay could open.

**Fix**: Renamed the listener target to `tokscaleDialog` and reran the TypeScript build to confirm the renderer boot path was clean.

**Where**: `electron/renderer/app.ts`.

## session naming: repo context menu bypassed the launcher

**Root cause**: The repo context menu in the main process was creating sessions directly via `createSession(repoId, true)`. That bypassed the renderer launcher flow entirely, so any create-time naming UI would have been skipped for sessions started from that entrypoint.

**Fix**: Changed the context-menu action to dispatch the existing `new-session` app command with the repo id, so the renderer opens the launcher and all new sessions go through the same naming flow.

**Where**: `electron/main/main.ts`.

## launcher inputs: typing would lose focus after each re-render

**Root cause**: The launcher, quick switcher, and command palette all rebuild their dialog DOM with `innerHTML` on every `input` change. Without restoring focus to the recreated node, the active text field is destroyed after each keystroke, which would have made the new session-name field effectively unusable and left the existing search inputs brittle for live typing.

**Fix**: Added a small re-render helper that restores focus and caret position for the recreated dialog input after each render.

**Where**: `electron/renderer/app.ts`.

## inline session rename: draggable pane header could hijack edit interactions

**Root cause**: Session pane headers are draggable as a whole for workspace reordering. Adding a rename button and inline text input inside that same header means pointer interactions can bubble into the draggable ancestor and start a drag instead of a normal click/edit action.

**Fix**: Render the pane header in a non-draggable state while renaming, and ignore drag starts that originate from controls marked with `data-no-drag`.

**Where**: `electron/renderer/app.ts`.

## session search: async re-render discards focused input mid-typing

**Root cause**: `refreshSessionSearchResults()` is async (debounced, IPC call). When results arrive, it called `renderSessionSearchDialog()` which rebuilds the entire `innerHTML`. That destroys the `<input id="session-search-query">` DOM node. Without restoring focus after the async re-render, any keystroke the user was mid-typing while results came back silently discarded — the input appeared to "randomly disable" because it lost focus with no visible indication.

**Fix**: Added `renderSessionSearchDialogKeepFocus()` that captures `document.activeElement === searchInput` + caret selection range before re-rendering, then calls `focus()` + `setSelectionRange()` on the recreated input element. All `renderSessionSearchDialog()` calls inside `refreshSessionSearchResults` now use this wrapper.

**Where**: `electron/renderer/app.ts`.

## session search: claudeProjectKey only replaced slashes, not underscores

**Root cause**: `claudeProjectKey(repoPath)` used `.replace(/[\\/]/g, "-")` — replacing only forward/backslashes. But Claude CLI replaces **all** non-alphanumeric characters with `-` when computing the project key. So `omavashia_portfolio` became `-Users-omavashia-omavashia_portfolio` in the code but `-Users-omavashia-omavashia-portfolio` on disk (same for `cse340_p2`, `claude_yank`, `claude_code_tasks`, etc.). The directory lookup always failed for any project path containing underscores, dots, spaces, or other non-slash separators, returning zero results silently.

**Fix**: Changed the regex to `/[^a-zA-Z0-9]/g` — replace every non-alphanumeric character with `-`, matching Claude's actual behavior.

**Where**: `electron/main/session-search.ts`, `claudeProjectKey()`.

## session search: raw JSONL line shown as preview instead of prompt text

**Root cause**: The `preview` field on each search result is the literal matched line from the `.jsonl` file. rg matches ANY line containing the query, including `last-prompt`, `custom-title`, `progress`, `file-history-snapshot` records — not just user messages. The initial `normalizeJsonlPreview` only checked `message.content` and fell through to `[type message]` for everything else. Crucially, `last-prompt` records (which always contain the exact prompt text) store it in a `lastPrompt` top-level field, not in `message.content`.

**Fix**: Expanded `normalizeJsonlPreview` to handle all common record types in priority order: (1) `lastPrompt` field, (2) `customTitle` field, (3) `message.content` as string or text block, (4) `tool_result` nested content, (5) top-level `content` field. Removed the `[type message]` fallback — if none of the known paths match, it now shows the raw line truncated to 300 chars instead of an unhelpful label.

**Where**: `electron/renderer/app.ts`.

## session search: Codex results had no working history resume path

**Root cause**: Session search treated resume as Claude-only even though Codex JSONL metadata already exposes a stable external session id. Hydra also only stored Claude's external session id (`claudeSessionId`), so there was no generic way to associate a restored non-Claude agent session with the CLI command needed to reopen it.

**Fix**: Added a generic `agentSessionId` to `SessionRecord`, backfilled it from `claudeSessionId` during state normalization, introduced a shared search-result resume IPC path, and taught session launch resolution to run `codex resume <session-id>` for Codex-backed restored sessions. The search UI now shows `Resume from here` for Codex rows when a session id is present.

**Where**: `electron/shared-types.d.ts`, `electron/main/state-store.ts`, `electron/main/main.ts`, `electron/main/preload.ts`, `electron/global.d.ts`, `electron/renderer/app.ts`.

## session search: unbounded process spawning and duplicate footer buttons

**Root cause**: Three separate bugs were compounding each other. (1) The `session-search-query` input handler called `refreshSessionSearchResults()` on every `input` event with no debounce, spawning a fresh `rg` + `fzf` subprocess pair on each keystroke. (2) When a selected result had no `hydraSessionId`, the dialog footer rendered "Reveal File" twice — once as a plain button and again as the primary action — because the primary button label was `hydraSessionId ? "Open in Hydra" : "Reveal File"` and the secondary reveal button was always rendered. (3) Arrow-key navigation updated `ui.sessionSearchSelectedIndex` and re-rendered the dialog, but never called `scrollIntoView` so rows at the bottom of the scrollable list were selected without being visible. (4) The results list had `min-height: 360px` but no `max-height`, so long result sets pushed the dialog off-screen.

**Fix**: Added a 250 ms debounce timer (`sessionSearchDebounceTimer`) cleared and reset on every keystroke before invoking the async search. Removed the unconditional "Reveal File" secondary button and conditioned it on `selectedResult.hydraSessionId` so no action is duplicated. Added `activeRow?.scrollIntoView({ block: "nearest" })` after each arrow-key re-render. Added `max-height: 440px; overflow-y: auto` to `.session-search-list`. Also added a CSS spinner (`session-search-spinner`) for the loading state and keyboard hint badges in the Matches header.

**Where**: `electron/renderer/app.ts`, `electron/renderer/app.css`.

## removing the session launcher: sidebar shortcut still called deleted helper

**Root cause**: After replacing the launcher dialog with immediate session creation, one keyboard path in `handleKeyDown()` still called `openLauncher(repoId)`. That would have thrown at runtime the first time the sidebar shortcut was used because the helper had already been removed.

**Fix**: Pointed that path at `startDefaultClaudeSession(repoId)` so all new-session entrypoints share the same direct-create behavior.

**Where**: `electron/renderer/app.ts`.

## project page session cards: transcript preview leaked into repo session list

**Root cause**: The repo detail page reused the generic session-row layout and `renderRepoSession()` populated both `row-subtitle` and `row-meta`, which meant each project-page card showed the repo name and the latest transcript preview. That overexposed session body text in a view that should only summarize the session itself.

**Fix**: Simplified `renderRepoSession()` so repo detail cards render only the session title plus a binary `Running`/`Idle` badge derived from `session.runtimeState`. Removed the extra subtitle and transcript preview rows from that view.

**Where**: `electron/renderer/app.ts`.

## app build/run automation: queued PTY input must exist before the shell session starts

**Root cause**: The first implementation queued the build/run command block only after creating a new shell session. Hydra's PTY host can emit the session `created` event immediately, so `handleHostCreated()` could run before the queued input was registered. The result was a misleading partial success: the new `Build and Run App` shortcut opened a session, but the build/run commands never executed.

**Fix**: Added queued session-launch bookkeeping and register the queued build/run input before starting a newly created shell session. `handleHostCreated()` now flushes any queued launch input before considering agent auto-launch behavior.

**Where**: `electron/main/main.ts`.

## MCP tools: `server.tool()` requires Zod schemas, not plain JSON Schema objects

**Root cause**: The MCP SDK's `McpServer.tool()` method validates the second argument and only accepts Zod schemas or `ToolAnnotations`. The initial tool files passed plain JSON Schema objects (`{ type: "string", description: "..." }`) which the SDK rejected at runtime with `Tool list_sessions expected a Zod schema or ToolAnnotations, but received an unrecognized object`. TypeScript didn't catch this because `server` was typed as `any`.

**Fix**: Rewrote all 7 tool files to use Zod schemas (`z.string().describe(...)`, `z.number().optional()`, etc.) and switched to the 4-argument `server.tool(name, description, zodSchema, handler)` signature.

**Where**: `electron/main/mcp-tools/*.ts` (all 7 tool files).

## MCP resources: `appController.getSnapshot()` does not exist on AppController

**Root cause**: The MCP resources file called `appController.getSnapshot()` but the actual method on AppController is `snapshot()`. The resources file was typed as `any` so TypeScript didn't catch the mismatch — it would have thrown at runtime when an MCP client tried to read the `hydra://state` resource.

**Fix**: Changed the call to `appController.snapshot()` to match the real method name.

**Where**: `electron/main/mcp-resources.ts`.

## repo config normalization: avoid duplicate keys when overriding normalized fields

**Root cause**: While normalizing persisted repo records, the object literal in `normalizeRepos()` set `appLaunchConfig` twice: once as a default and once as a normalized override after spreading the saved repo object. TypeScript rejects duplicate object-literal keys, so the app failed to compile even though the intent was just "default then normalize".

**Fix**: Normalize through a `safeRepo` temporary object and set `appLaunchConfig` exactly once after the spread.

**Where**: `electron/main/state-store.ts`.

## tokscale overlay flickers and closes: missing `tui` subcommand

**Root cause**: `ephemeralToolCommand("tokscale")` ran `npx --yes tokscale@latest` with no subcommand. Without arguments, tokscale prints its help text and exits immediately. The PTY process exiting triggered `onEphemeralToolExit`, which called `closeEphemeralToolOverlay` right after `showModal()`, producing a brief flicker.

**Fix**: Changed the command to `npx --yes tokscale@latest tui` to launch the interactive TUI.

**Where**: `electron/main/main.ts` (`ephemeralToolCommand`).

## preload crash: `node:` protocol prefix not supported in sandboxed preload context

**Root cause**: `preload.ts` used `require("node:path")` and `require("node:url")`. In Electron's sandboxed preload environment, the `node:` protocol prefix is not recognized, so both requires threw `Error: module not found: node:path`. This caused the entire preload script to fail, meaning `contextBridge.exposeInMainWorld("claudeWorkspace", ...)` was never called. As a result `window.claudeWorkspace` was `undefined` in the renderer, and the top-level `api.onStateChanged(...)` call crashed with `TypeError: Cannot read properties of undefined`, leaving the app completely blank.

**Fix**: Changed both requires to use the bare module names: `require("path")` and `require("url")`.

**Where**: `electron/main/preload.ts`.

## Windows PTY: Python pty/fcntl/termios modules don't exist on Windows

**Root cause**: `pty_host.py` uses Unix-only Python modules (`pty`, `fcntl`, `termios`). These are POSIX-only and do not exist on Windows at all — importing them throws `ModuleNotFoundError`. The PTY host is the core process for running all terminal sessions, so this completely breaks Hydra on Windows.

**Fix**: Added a `WindowsPtyHostClient` class in `pty-host-client.ts` that uses `node-pty` (which was already in `dependencies` and uses Windows ConPTY under the hood) directly in-process, with no subprocess. It implements the same public interface as `PtyHostClient` (`createSession`, `sendInput`, `resizeSession`, `killSession`, `stop`, `onMessage`). The module conditionally exports `WindowsPtyHostClient` when `process.platform === "win32"`, so `main.ts` needs no changes. Also added `node_modules/node-pty/**/*` to `asarUnpack` in `electron-builder.yml` so the native `.node` binary is not trapped inside the ASAR archive.

**Where**: `electron/main/pty-host-client.ts`, `electron-builder.yml`.

## Windows shell: SHELL env var and /bin/zsh don't exist on Windows

**Root cause**: `resolvedShellPath()` fell back to `process.env.SHELL || "/bin/zsh"`. Neither exists on Windows — `SHELL` is not set and `/bin/zsh` is not a valid path. Every non-configured shell session would fail to spawn.

**Fix**: Added a `process.platform === "win32"` branch that falls back to `process.env.COMSPEC || "cmd.exe"`.

**Where**: `electron/main/main.ts` (`resolvedShellPath`).

## renderer crash: `process` is not defined with contextIsolation

**Root cause**: Electron renderer windows run with `contextIsolation: true` and `nodeIntegration: false`, so Node.js globals (`process`, `process.env`, etc.) are not available. Adding `process.platform` / `process.env.SHELL` to `DEFAULT_PREFERENCES` and `abbreviateHome` in the renderer caused an immediate `ReferenceError: process is not defined` at module load, leaving the entire UI blank.

**Fix**: Replace all `process.platform` calls in `electron/renderer/app.ts` with `navigator.platform` checks (`navigator.platform.includes("Mac")`, `navigator.platform.startsWith("Win")`). Replace `process.env.HOME`/`USERPROFILE` in `abbreviateHome` with a regex that matches both Unix (`/Users/name`, `/home/name`) and Windows (`C:\Users\name`) home paths. Do not declare `process` in `global.d.ts` for the renderer — use web APIs only.

**Where**: `electron/renderer/app.ts` (`matchesAccelerator`, `acceleratorDisplayParts`, `DEFAULT_PREFERENCES`, `abbreviateHome`).

## Windows: Node.js 22 refuses to spawn `.cmd` files without `shell: true` (CVE-2024-27980)

**Root cause**: Node.js 22+ patched CVE-2024-27980 by no longer directly executing `.bat`/`.cmd` files via `child_process.spawn`/`spawnSync` without `shell: true`. `run-electron-builder.mjs` called `spawnSync("npx.cmd", [...])` without `shell: true`, causing `EINVAL` on Windows regardless of whether the parent process is bash or PowerShell. The error was silent because the code only checked `result.status` (which was `null` on spawn failure) and fell through to `process.exit(1)` with no message.

**Fix**: Added `shell: process.platform === "win32"` to the spawnSync options so `.cmd` files are executed through cmd.exe on Windows. Also added a `result.error` check to log spawn failures.

**Where**: `scripts/run-electron-builder.mjs`.

## electron-builder: `"build": {}` in package.json overrides electron-builder.yml

**Root cause**: electron-builder checks `package.json`'s `"build"` field first. If it exists (even as an empty `{}`), electron-builder uses it as the configuration source and **ignores** `electron-builder.yml`. After removing the invalid `win.sign: false` from package.json, `"build": {}` was left behind. This caused all Mac builds to run with default config — no custom `directories.output`, no `artifactName`, no target specs. The DMG was either not produced or produced with default naming in the default `dist/` directory, not `release/Hydra-{version}-arm64.dmg`.

**Fix**: Removed `"build": {}` entirely from `package.json` so electron-builder reads from `electron-builder.yml` as intended.

**Where**: `package.json`.

## Windows CI: PowerShell default shell swallows Node.js stderr from npm subprocesses

**Root cause**: GitHub Actions Windows runners default to PowerShell as the step shell. When npm spawns Node.js scripts through cmd.exe, stderr from those scripts can be lost in the PowerShell → cmd.exe buffering chain, making failures appear as a silent exit-code-1 with no error output.

**Fix**: Add `shell: bash` to any Windows CI step that runs npm scripts that need reliable stderr (git bash is always available on GitHub Actions Windows runners). Also wrap Node.js build scripts in try/catch with explicit `process.stderr.write` to guarantee errors appear even under bad buffering.

**Where**: `.github/workflows/release.yml` ("Build Windows release artifacts" step), `scripts/build-assets.mjs`.

## Windows build: double drive letter in path from `import.meta.url.pathname`

**Root cause**: `new URL("..", import.meta.url).pathname` on Windows returns a path starting with `/D:/...`. Passing that to `path.join()` produces `D:\D:\...` because `join` sees the leading slash and the existing drive letter and concatenates both, doubling the drive letter.

**Fix**: Use `fileURLToPath(new URL("..", import.meta.url))` from `node:url`, which correctly converts a file URL to a native Windows path without the spurious leading slash.

**Where**: `scripts/build-assets.mjs`.

## electron-builder: `win.sign` is not a valid configuration property — must be removed from ALL config files

**Root cause**: `sign` is not a recognized property in electron-builder's `win` config schema (valid alternatives are `signtoolOptions`, `azureSignOptions`, `forceCodeSigning`). electron-builder validates the entire config on startup — even when building for macOS — so the invalid property in ANY config source causes **all** platform builds to fail with `ValidationError: Invalid configuration object`. It appeared in two places: `package.json`'s `build.win` field AND `electron-builder.yml`'s `win:` section. Fixing only one left the other still breaking builds.

**Fix**: Remove `sign: false` from both `package.json` (`build.win`) and `electron-builder.yml` (`win:`). To skip Windows code signing, rely on `run-electron-builder.mjs` unsetting `CSC_IDENTITY_AUTO_DISCOVERY` when no signing credentials are present.

**Where**: `package.json` (`build.win.sign`), `electron-builder.yml` (`win.sign`).

## Auth server: `better-auth-cloudflare` npm package version mismatch

**Root cause**: The plan referenced `better-auth-cloudflare@^0.6.2` but the latest published version on npm is `0.3.0`. The package had been assumed to follow better-auth's versioning but it's independently versioned. Also, `better-sqlite3@^11.0.0` conflicted with better-auth's peer dependency requiring `^12.0.0`.

**Fix**: Checked actual npm versions with `npm view` and corrected to `better-auth-cloudflare@^0.3.0` and `better-sqlite3@^12.0.0`. Used `--legacy-peer-deps` for transitive peer conflicts from better-auth's optional dependencies (prisma, etc.).

**Where**: `auth-server/package.json`.

## Auth schema generation: Better Auth CLI outputs Drizzle schema, not raw SQL

**Root cause**: `npx @better-auth/cli generate` with `--output migrations/0001_auth_schema.sql` writes a **Drizzle ORM schema file** (TypeScript with `sqliteTable()` calls), not raw SQL DDL. The `.sql` extension is misleading — D1 migrations require actual SQL `CREATE TABLE` statements.

**Fix**: Moved the generated file to `src/db/schema.ts` as the Drizzle schema definition, then manually wrote the equivalent raw SQL migration in `migrations/0001_auth_schema.sql` for D1 consumption.

**Where**: `auth-server/src/db/schema.ts`, `auth-server/migrations/0001_auth_schema.sql`.

## MCP `add_workspace` action routed to Electron file dialog instead of path-based API

**Root cause**: `handleMcpAction("add_workspace")` called `this.openWorkspaceFolder()`, which opens an Electron native file dialog. MCP clients (Discord bot, voice agents, etc.) are headless and cannot interact with OS-level dialogs, so the action would hang or fail silently. The correct method `addWorkspace(path)` already existed and accepts a path string directly.

**Fix**: Changed the `add_workspace` case to call `this.addWorkspace(args.path)` instead of `this.openWorkspaceFolder()`.

**Where**: `electron/main/main.ts` (`handleMcpAction`).

## preferences update: new fields silently dropped by `sanitizePreferencesPatch`

**Root cause**: `sanitizePreferencesPatch` in `main.ts` is an explicit allowlist — it builds a clean `AppPreferencesPatch` object by only copying known fields. Any new field added to `AppPreferencesPatch` in `shared-types.d.ts` is silently dropped unless a corresponding `hasOwnProperty` block is also added to `sanitizePreferencesPatch`. The `invoke` resolves successfully (it accepted the call), `broadcastState()` fires with the unchanged state, and the renderer re-renders the old value — producing a flicker.

**Fix**: Add the new field to `sanitizePreferencesPatch` in `electron/main/main.ts` alongside any additions to `AppPreferencesPatch`.

**Where**: `electron/main/main.ts` (`sanitizePreferencesPatch`).

## Auth: missing isDestroyed() guard after async initialize() in loadAuthenticatedPage

**Root cause**: `loadAuthenticatedPage()` awaits `this.authClient?.initialize()` which can take up to ~1.45s with retries. If the user closes the window during initialization, `window.loadFile()` throws "Object has been destroyed". The catch block also calls `window.loadFile()` on the same destroyed window, producing an unhandled promise rejection. The sibling method `handleAuthSessionChanged()` already had the correct `isDestroyed()` guard.

**Fix**: Added `if (window.isDestroyed()) return;` after the `await` and at the start of the `catch` block.

**Where**: `electron/main/main.ts` (`loadAuthenticatedPage`).

## Auth: handleAuthSessionChanged only handled session-gained direction

**Root cause**: `handleAuthSessionChanged()` only navigated when a session was gained (null → valid session on auth.html), but never handled the reverse: session becoming null while the user is on the main app. Server-side session revocation or expiry would leave the user stuck on the main app with no valid session. Additionally, the `auth:signOut` IPC handler had no try/finally, so a network error during `signOut()` would skip the navigation to auth.html entirely, and the `finally` block in `signOut()` still cleared the local session — leaving the user with no session and no redirect.

**Fix**: (1) Added an else branch to `handleAuthSessionChanged` that navigates to auth.html when session is null and the URL isn't already auth.html. (2) Wrapped the `signOut()` call in the IPC handler with try/finally so `loadFile(auth.html)` always executes, with an `isDestroyed()` guard. (3) Used `TRUSTED_AUTH_ENTRY_PATH` constant instead of hardcoded path.

**Where**: `electron/main/main.ts` (`handleAuthSessionChanged`, `auth:signOut` IPC handler).

## Voice modal: `timeStamp()` typo and deprecated Pipecat callbacks

**Root cause**: Two issues in the voice modal implementation. (1) The `onVoiceError` handler called `timeStamp()` instead of `voiceTimeStamp()` — the helper was renamed to avoid colliding with DOM's built-in `timeStamp` property, but one call site was missed. TypeScript caught this as `TS2304: Cannot find name 'timeStamp'`. (2) The `onBotTranscript` callback was deprecated in Pipecat client-js v1.5.0 in favor of `onBotOutput`, which receives `{ text: string; spoken: boolean; aggregated_by: string }` instead of `{ text: string }`. (3) The `webrtcUrl` connect param was deprecated in SmallWebRTC transport v1.4.0 in favor of `webrtcRequestParams: { endpoint: string }`.

**Fix**: (1) Changed `timeStamp()` → `voiceTimeStamp()`. (2) Switched from `onBotTranscript` to `onBotOutput`. (3) Changed `connect({ webrtcUrl })` to `connect({ webrtcRequestParams: { endpoint } })`.

**Where**: `electron/renderer/app.ts` (voice modal functions).

## Voice modal: operator precedence bug in error detection filter

**Root cause**: The `lastError` finder used `e.role === "system" && e.text.startsWith("Error:") || e.text.includes("could not")`. Due to `&&` binding tighter than `||`, this evaluated as `(role === "system" && startsWith("Error:")) || includes("could not")` — the second branch matched ANY transcript entry (user, bot, or system) containing "could not", not just system messages.

**Fix**: Extracted the predicate into a named `isVoiceError()` function with explicit parentheses grouping all conditions inside the `&&`, and reused it for both the `lastError` lookup and the transcript display filter.

**Where**: `electron/renderer/app.ts` (`renderVoiceDialog`).

## Auth types on wrong interface in global.d.ts

**Root cause**: Auth method declarations (`signInWithEmail`, `signUpWithEmail`, `authStartProvider`, `authSignOut`, `authGetSession`, `authOpenPage`, `requestPasswordReset`, `verifyTotp`, `onAuthStateChanged`) were placed on `PipecatClientOptionsLike` instead of `ClaudeWorkspaceApi`. The renderer calls these methods on `window.claudeWorkspace` (which is typed as `ClaudeWorkspaceApi`), so TypeScript reported them as missing. Additionally, `PipecatClientOptionsLike` is the constructor options type for `new PipecatClient(...)`, so any object passed to it was also required to have all 9 auth methods — causing unrelated voice-call code to fail type-checking.

**Fix**: Moved the auth method declarations from `PipecatClientOptionsLike` to `ClaudeWorkspaceApi`. Also fixed a missing trailing comma after the `onVoiceError` property in `preload.ts` that caused a syntax error.

**Where**: `electron/global.d.ts`, `electron/main/preload.ts`.

## Toolbar three-dots menu invisible + "End session" unreachable

**Root cause**: `.session-workspace-detail` had `overflow: hidden`, which clipped the `.ws-toolbar-menu-popover` (absolutely positioned below the toolbar). The `<details>` element toggled its `open` attribute correctly, but the popover content extended below the toolbar and was clipped by the parent's overflow. Since "End session" was only accessible through this menu, both bugs had the same root cause.

**Fix**: Changed `overflow: hidden` to `overflow: visible` on `.session-workspace-detail`. The child `.session-workspace-canvas` already has its own `overflow: hidden`, so terminal/pane content is still correctly clipped. Also added close-on-action (close the `<details>` when any menu item is clicked) and close-on-outside-click behavior for the toolbar menu.

**Where**: `electron/renderer/app.css` (`.session-workspace-detail`), `electron/renderer/app.ts` (`handleClick`).

## Voice deps: `uv pip install` targets wrong Python, pipecat not found at runtime

**Root cause**: `installDeps()` detects `uv` and runs `uv pip install -r requirements.txt` without specifying which Python interpreter to target. `uv pip install` defaults to the active environment or its own managed Python, which may differ from the `python3` binary that `checkPython()` found and that `spawnBot()` uses. Packages get installed into one environment but the bot runs in another, causing `ModuleNotFoundError: No module named 'pipecat'`. The deps marker file (`~/.hydra/voice-deps.json`) then records success, so subsequent starts skip installation entirely and keep failing.

**Fix**: Added `--python <python.path>` to the `uv pip install` args so packages are installed into the same interpreter that `spawnBot()` uses.

**Where**: `electron/main/voice-manager.ts` (`installDeps`).

## Voice WebRTC: Electron blocks microphone access without permission handler

**Root cause**: `PipecatClient.connect()` calls `initDevices()` which invokes `navigator.mediaDevices.getUserMedia({ audio: true })`. Electron's renderer process blocks media device access by default unless the session has a `setPermissionRequestHandler` that grants the `media` permission. Without it, `getUserMedia` is denied, `initDevices()` fails, and the WebRTC connection never reaches the bot's `/api/offer` endpoint — the entire connect flow fails silently because the PipecatClient catches the error and calls `disconnect()`.

**Fix**: Added `session.setPermissionRequestHandler` and `session.setPermissionCheckHandler` to the main window setup, granting `media` permission and denying all others.

**Where**: `electron/main/main.ts` (window creation, after `webPreferences`).

## Voice bot cannot use MCP tools (2026-04-30)

**Root cause:** The Hydra MCP server requires Bearer token authentication, but the voice bot's `StreamableHttpParameters` was created without auth headers. The auth token was resolved in `main.ts` but never passed through `VoiceManager` to the bot subprocess.

**Fix:** Pass the MCP auth token as `HYDRA_MCP_AUTH_TOKEN` environment variable to the bot subprocess. In `bot.py`, read it and include it in `StreamableHttpParameters(headers={"Authorization": f"Bearer {token}"})`.

**Additional fix:** Auto-start the MCP server when a voice call begins (via `ensureMcpServerForVoice()`), removing the requirement for users to manually set `HYDRA_ENABLE_MCP_SERVER=1`.

## Agent handoff: terminal freeze, repeated banners, and prompt corruption

**Root cause:** Four bugs in the agent handoff implementation. (1) The handoff prompt (up to 16K chars of transcript context) was sent as raw PTY stdin input after the new agent launched. `os.write(master_fd, data)` in `pty_host.py` writes to the PTY master FD in a single call. On macOS, PTY buffers are 4–8KB; writing 16K+ bytes blocks the write syscall until the slave side drains the buffer. Since `pty_host.py` runs a single-threaded event loop, a blocked write freezes ALL terminal sessions. (2) The handoff prompt contains `\n` characters (from `buildAgentHandoffPrompt`'s `lines.join("\n")`). When pasted into a TUI agent's terminal input in chunks (due to buffer limits), each chunk arrives as a separate paste event and gets submitted independently — producing "a series of messages" instead of one coherent prompt. (3) For claude-to-claude handoff, `claudeSessionId` was set to the existing session ID, causing `claude --session-id <id>` to resume the usage-limited session instead of starting fresh. (4) `requestAgentHandoff` had no idempotency guard — multiple OSC triggers from buffered PTY data each added a `[Continuing this session...]` banner, producing 6+ duplicate lines that also polluted the next agent's handoff prompt context.

**Fix:** (1) Pass the handoff prompt as a positional CLI argument (`claude "prompt"`, `codex "prompt"`) instead of typing it via stdin. Both agents support `[PROMPT]` as a positional arg. (2) For large stdin writes (worktree-enabled sessions), moved writes >4KB to a background thread in `pty_host.py` that chunks at 2048 bytes. (3) Set `claudeSessionId = null` and `agentSessionId = null` for handoff so the new agent starts fresh. (4) Added early return in `requestAgentHandoff` when `pendingAgentHandoffs` already has an entry for the session. Removed the banner entirely from `requestAgentHandoff` — the handoff is now silent. Also stripped `[Continuing...]` and `[Agent exited...]` banners from `handoffTranscriptTail` before building the next agent's prompt context. Removed the `continue()` shell function alias (conflicts with shell builtin); only `hydra-continue` is defined.

**Where:** `electron/main/main.ts` (`requestAgentHandoff`, `startAgentHandoffSession`, `resolvedSessionLaunchCommand`, `handoffTranscriptTail`, `bashHandoffRcSource`, `zshHandoffRcSource`, `fallbackToShell`), `electron/main/pty_host.py` (`handle_input`, `_write_large_input`).

## Cmd+1-9 tab shortcuts: hints shown but never wired up

**Root cause**: The tab bar rendered `⌘1`, `⌘2`, etc. as shortcut hints on each tab button (line 3045: `dom("span", { className: "ws-tab-shortcut" }, `\u2318${index + 1}`)`), but the `handleKeyDown` function had no handler for `Cmd+Digit` events. The shortcuts were purely cosmetic.

**Fix**: Added a `Cmd+1` through `Cmd+9` handler in `handleKeyDown` after the dialog-open guard but before `handleAppShortcut` (which gates on editable/terminal targets). The handler maps the digit to the corresponding index in `workspaceVisibleSessionIds()` and calls `activateVisibleSession()`. Placed before the terminal/editable guard so it works regardless of focus location.

**Where**: `electron/renderer/app.ts` (`handleKeyDown`).

## Voice mini overlay: drag jumps and resize handle unreachable

**Root cause:** Two separate bugs. (1) The overlay is positioned with `left: 50%; transform: translateX(-50%)` and has an entrance animation with `animation-fill-mode: both`. CSS animations cascade above inline styles, so `el.style.transform = "none"` set during mousedown was silently overridden by the animation's fill-mode `transform: translateX(-50%)`. The element's `left` was set to `getBoundingClientRect().left` (the correct visual position), but the persisting `-50%` translateX shifted it half a width to the left on first drag. (2) The mousedown handler on the overlay called `e.preventDefault()` on all non-button clicks, which prevented the browser's native `resize: both` handle (bottom-right corner) from receiving interaction.

**Fix:** (1) Set `el.style.animation = "none"` on mousedown to cancel the animation fill-mode, allowing the inline `transform: none` to take effect. Reset `animation` to `""` in `minimizeVoiceModal()` so the entrance animation replays on re-minimize. (2) Added a resize-zone check: if mousedown is within 18px of the bottom-right corner, skip drag initiation and let the native resize handle work. Also styled `::-webkit-resizer` for visibility.

**Where:** `electron/renderer/app.ts` (`initVoiceMiniDrag`, `minimizeVoiceModal`), `electron/renderer/app.css`.

## Context panel: can't type in sidebar + terminal flickering when panel opens/closes

**Root cause:** Three interacting bugs. (1) `syncSectionFocusUi()` is called from `renderSessionDetail()` on every `onStateChanged` broadcast. It calls `focusCurrentSectionElement()` which steals focus to the terminal or main section — the context panel is not a recognized `SectionId`, so typing in the notes textarea is interrupted every time the main process broadcasts state. The existing guard only checked `isAnyDialogOpen() || options.preserveCurrentFocus || ui.renamingSessionId`. (2) `updateContextPanel()` uses `replaceDomChildren()` to fully rebuild the DOM when the signature changes. If the notes auto-save (debounced 400ms) triggers a state broadcast while the user is still typing, the `notes.length` in the signature changes, the DOM is rebuilt, and the textarea is destroyed mid-edit — losing cursor position and in-progress text. (3) The context panel open/close uses a 220ms CSS transition on `flex-basis` and `width`. Each intermediate frame fires the `ResizeObserver` on every mounted terminal's shell element, calling `fitAddon.fit()` synchronously. With multiple session panes, this produces dozens of synchronous fit/resize cycles during a single animation, causing visible terminal flickering.

**Fix:** (1) Added `activeInContextPanel` check to `syncSectionFocusUi()` — if `document.activeElement` is inside `.context-panel`, skip `focusCurrentSectionElement()`. (2) In `updateContextPanel()`, if `document.activeElement` is inside `.context-panel`, update the signature (to prevent stale re-checks) but skip the DOM rebuild. Added a `focusout` handler that clears the signature and re-runs `updateContextPanel()` when focus leaves the panel, ensuring deferred updates are applied. (3) Wrapped the `ResizeObserver` callback in `requestAnimationFrame` with cancellation — consecutive resize events coalesce into a single fit at the end of the frame, eliminating per-frame terminal reflows during the CSS transition.

**Where:** `electron/renderer/app.ts` (`syncSectionFocusUi`, `updateContextPanel`, `handleFocusOut`, `mountSessionWorkspaceTerminals`).

## Context panel: active-element guard too broad, blocking all interactive re-renders

**Root cause:** `updateContextPanel()` had a guard at line 8872 that skipped DOM rebuilds whenever `document.activeElement` was inside `.context-panel`. This was designed to preserve cursor position while typing in the notes textarea, but it also fired when clicking buttons or checkboxes inside the panel. When the user clicked the "+" button (add pin), a checkbox (toggle pin), or the "×" button (remove pin), the clicked element became `document.activeElement`. The immediate `updateContextPanel()` call detected focus inside the panel and skipped the rebuild, updating only the signature. The subsequent `onSessionUpdated` event from the IPC round-trip also called `updateContextPanel`, but now the signature already matched (updated in the skipped call), so it returned at the signature-equality check. Result: the panel NEVER re-rendered after any click interaction inside it.

**Fix:** Narrowed the guard from `document.activeElement?.closest(".context-panel")` to `document.activeElement instanceof HTMLTextAreaElement` inside the panel. Only textarea focus (notes editing) skips the rebuild; buttons, checkboxes, and other interactive elements allow immediate re-renders.

**Additionally:** (1) Added `toggle-pinned-message` to the click handler's switch/case — it was only handled in the `change` event handler, but `handleClick`'s `event.preventDefault()` on line 6640 prevented the checkbox from toggling, so the `change` event never fired. (2) Added optimistic local state updates: `addPinnedMessage`, `removePinnedMessage`, and `togglePinnedMessage` now mutate `session.pinnedMessages` in-place and call `updateContextPanel()` before the IPC round-trip, giving immediate visual feedback. (3) Added `scrollPinListToBottom()` to auto-scroll the pin list to show newly added pins.

**Where:** `electron/renderer/app.ts` (`updateContextPanel`, `handleClick`, `addPinnedMessage`, `removePinnedMessage`, `togglePinnedMessage`, `scrollPinListToBottom`).

## Right sidebar changes: "Not tracked" for non-worktree sessions

**Root cause:** `refreshRepoParallelWorktreeState()` filtered `candidateSessions` to only `launchProfile === "agent"` AND `mode !== "disabled"`. Shell sessions, appLaunch sessions, and agent sessions without worktree enabled were excluded from change stat gathering entirely. The renderer's `renderContextChangeNodes()` then checked `isTracked = !!metadata && metadata.mode !== "disabled"` — any session with `mode === "disabled"` showed "Not tracked" instead of actual git diff stats.

**Fix:** (1) Removed the `launchProfile === "agent"` and `mode !== "disabled"` filters from `candidateSessions` so all repo sessions get change stats. (2) For non-isolated sessions, default `targetPath` to `repo.path` instead of only for `mode === "shared"`. (3) Removed the `isTracked` gate in the renderer — always show change stats (additions/deletions) or "None".

**Where:** `electron/main/main.ts` (`refreshRepoParallelWorktreeState`), `electron/renderer/app.ts` (`renderContextChangeNodes`).
