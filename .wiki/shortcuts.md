# Shortcuts

## Session shortcuts

- `Cmd+Shift+A`: Open the new-session launcher for the current repo, or the first repo if none is selected.
- `Cmd+Backspace`: In the main Claude/shell session terminals, clear the current prompt by sending the terminal line-kill control (`Ctrl+U`) to the PTY.

## Notes

- Shortcut handling is split between Electron menu accelerators in [`electron/main/main.ts`](../electron/main/main.ts) and a capture-phase renderer handler in [`electron/renderer/app.ts`](../electron/renderer/app.ts).
- The `Cmd+Backspace` mapping is terminal-local only. It is implemented in the session xterm custom key handler and intentionally does not apply to lazygit/tokscale overlays or regular DOM text inputs.
- App-level shortcuts that would conflict with text entry should be guarded with `isEditableTarget(...)` and `isTerminalKeyboardTarget(...)` in the renderer before preventing default behavior.
