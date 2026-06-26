#!/usr/bin/env node
// Cross-platform replacement for the shell-based build:assets script.
import { cpSync, mkdirSync, chmodSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:process";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/[/\\]$/, "");
const rendererAssets = [
  "index.html",
  "auth.html",
  "app.css",
  "vendor/xterm.css",
  "vendor/xterm.js",
  "vendor/addon-fit.js",
  "vendor/pipecat-client.js",
  "vendor/pipecat-webrtc.js",
];

function cp(src, dest, options) {
  cpSync(join(root, src), join(root, dest), options);
}

try {
  // Ensure output directories exist
  mkdirSync(join(root, "dist-electron/main"), { recursive: true });
  mkdirSync(join(root, "dist-electron/renderer/vendor"), { recursive: true });

  // PTY host (Unix only — Windows uses node-pty in-process)
  cp("electron/main/pty_host.py", "dist-electron/main/pty_host.py");

  // App launch runner scripts
  cp("electron/main/app-launch-runner.sh", "dist-electron/main/app-launch-runner.sh");
  cp("electron/main/app-launch-runner.ps1", "dist-electron/main/app-launch-runner.ps1");
  rmSync(join(root, "dist-electron/main/voice"), { recursive: true, force: true });
  cp("voice", "dist-electron/main/voice", { recursive: true });

  // Make shell script executable on non-Windows platforms
  if (platform !== "win32") {
    chmodSync(join(root, "dist-electron/main/app-launch-runner.sh"), 0o755);
  }

  // Renderer static assets
  for (const asset of rendererAssets) {
    cp(`electron/renderer/${asset}`, `dist-electron/renderer/${asset}`);
  }

  // Optional auth server override used by packaged/dev builds.
  if (existsSync(join(root, "electron/renderer/auth-config.json"))) {
    cp("electron/renderer/auth-config.json", "dist-electron/renderer/auth-config.json");
  }
} catch (err) {
  process.stderr.write(`build-assets error: ${err.message}\n`);
  process.exit(1);
}
