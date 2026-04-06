# Lessons

## lazygit: `open /dev/tty: device not configured`

**Root cause**: `pty_host.py` uses `subprocess.Popen` with `start_new_session=True`, which calls `setsid()` — creating a new session with **no controlling terminal**. The PTY slave fd is connected to stdin/stdout/stderr, but is never established as the controlling terminal. When any TUI program (lazygit, vim, htop) tries to open `/dev/tty`, it fails because there's no controlling terminal for the session. Shells handle this themselves (they call `TIOCSCTTY` internally), so regular shell sessions work fine — the bug only surfaces with programs that directly open `/dev/tty`.

**Fix (attempt 1 — incomplete)**: Pass `command: ["lazygit"]` directly to `pty_host.py` so lazygit is the root process in the PTY (not a child of a shell). Added an optional `command` field to `create_session` that bypasses the default `[shellPath, "-il"]`. This alone doesn't fix the issue because the controlling terminal is still not set.

**Fix (attempt 2 — actual fix)**: Added `TIOCSCTTY` ioctl call via `preexec_fn` in `subprocess.Popen`. After `setsid()` runs (from `start_new_session=True`), the `preexec_fn` calls `fcntl.ioctl(slave_fd, TIOCSCTTY, 0)` in the child process before `exec()`, making the PTY slave the controlling terminal. This fixes `/dev/tty` access for ALL sessions, not just lazygit. `TIOCSCTTY` constant is `0x20007461` on macOS, `0x540E` on Linux.

**Where**: `electron/main/pty_host.py` (`create_session`, `TIOCSCTTY`), `electron/main/main.ts` (`createLazygitSession`).

## lazygit overlay: blank screen on open

**Root cause**: `terminal.open(host)` was called synchronously right after `lazygitDialog.showModal()`. The browser hasn't computed layout yet at that point, so the `#lazygit-terminal-host` element has 0 width/height. `fitAddon.fit()` computes 0 cols/rows, sending a useless SIGWINCH to lazygit. Additionally, lazygit starts outputting immediately upon PTY creation but the `onLazygitOutput` listener wasn't subscribed yet, so early output was lost.

**Fix**: (1) Subscribe to `onLazygitOutput` immediately (before `showModal()`) and buffer output in an array. (2) Defer `terminal.open()`, `fitAddon.fit()`, and terminal mounting to a `requestAnimationFrame` callback so the dialog has laid out first. (3) Flush the output buffer into the terminal in the same frame it's created.

**Where**: `electron/renderer/app.ts` (`openLazygitOverlay`).
