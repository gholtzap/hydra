#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const localAuthServerUrl = "http://localhost:8787";
const hasAuthServerOverride = Boolean(process.env.AUTH_SERVER_URL?.trim()) || existsSync("electron/renderer/auth-config.json");

const processes = [
  {
    label: "auth",
    cmd: npmCommand,
    args: ["--prefix", "auth-server", "run", "dev:local"],
  },
  {
    label: "desktop",
    cmd: npmCommand,
    args: ["run", "dev:desktop"],
    env: hasAuthServerOverride ? {} : { AUTH_SERVER_URL: localAuthServerUrl },
  },
];

const children = [];
let exiting = false;

for (const processConfig of processes) {
  const child = spawn(processConfig.cmd, processConfig.args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...processConfig.env,
    },
  });

  child.on("exit", (code, signal) => {
    if (exiting) {
      return;
    }

    exiting = true;
    terminateChildren(child.pid ?? null);

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });

  children.push(child);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (exiting) {
      return;
    }

    exiting = true;
    terminateChildren();
    process.exit(0);
  });
}

function terminateChildren(skipPid = null) {
  for (const child of children) {
    if (!child.pid || child.pid === skipPid) {
      continue;
    }

    child.kill("SIGTERM");
  }
}
