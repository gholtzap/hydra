#!/usr/bin/env node
// Cross-platform replacement for the shell-based build:assets script.
import { cpSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:process";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/[/\\]$/, "");

function mkdir(dir) {
  mkdirSync(dir, { recursive: true });
}

function cp(src, dest) {
  cpSync(join(root, src), join(root, dest));
}

try {
  // Ensure output directories exist
  mkdir(join(root, "dist-electron/main"));
  mkdir(join(root, "dist-electron/renderer/vendor"));

  // PTY host (Unix only — Windows uses node-pty in-process)
  cp("electron/main/pty_host.py", "dist-electron/main/pty_host.py");

  // App launch runner scripts
  cp("electron/main/app-launch-runner.sh", "dist-electron/main/app-launch-runner.sh");
  cp("electron/main/app-launch-runner.ps1", "dist-electron/main/app-launch-runner.ps1");

  // Make shell script executable on non-Windows platforms
  if (platform !== "win32") {
    chmodSync(join(root, "dist-electron/main/app-launch-runner.sh"), 0o755);
  }

  // Renderer static assets
  cp("electron/renderer/index.html", "dist-electron/renderer/index.html");
  cp("electron/renderer/auth.html", "dist-electron/renderer/auth.html");
  cp("electron/renderer/app.css", "dist-electron/renderer/app.css");
  cp("electron/renderer/vendor/xterm.css", "dist-electron/renderer/vendor/xterm.css");
  cp("electron/renderer/vendor/xterm.js", "dist-electron/renderer/vendor/xterm.js");
  cp("electron/renderer/vendor/addon-fit.js", "dist-electron/renderer/vendor/addon-fit.js");
} catch (err) {
  process.stderr.write(`build-assets error: ${err.message}\n`);
  process.exit(1);
}
