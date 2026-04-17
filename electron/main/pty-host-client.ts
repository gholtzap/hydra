import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { PtyCreateSessionPayload, PtyHostMessage } from "../shared-types";

const { spawn } = require("node:child_process");
const { resolveBundledHelperPath } = require("./runtime-paths") as {
  resolveBundledHelperPath: (fileName: string) => string;
};

// Unix PTY host: spawns pty_host.py as a subprocess, communicates via JSON over stdio.
class PtyHostClient {
  child: ChildProcessWithoutNullStreams | null;
  pending: string;
  listeners: Set<(message: PtyHostMessage) => void>;

  constructor() {
    this.child = null;
    this.pending = "";
    this.listeners = new Set();
  }

  start() {
    if (this.child) {
      return;
    }

    const hostPath = resolveBundledHelperPath("pty_host.py");
    this.child = spawn("/usr/bin/env", ["python3", hostPath], {
      stdio: ["pipe", "pipe", "inherit"]
    }) as ChildProcessWithoutNullStreams;

    this.child.stdin.on("error", () => {
      // Swallow EPIPE / write-after-close errors on stdin.
      // The pty host process may exit at any time; writes are best-effort.
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.pending += chunk;
      let newlineIndex = this.pending.indexOf("\n");

      while (newlineIndex >= 0) {
        const line = this.pending.slice(0, newlineIndex).trim();
        this.pending = this.pending.slice(newlineIndex + 1);

        if (line) {
          try {
            const message = JSON.parse(line) as PtyHostMessage;
            this.listeners.forEach((listener) => listener(message));
          } catch {
            continue;
          }
        }

        newlineIndex = this.pending.indexOf("\n");
      }
    });

    this.child.on("error", () => {
      // Swallow spawn / process-level errors (e.g. ENOENT if python3 disappears).
    });

    this.child.on("exit", () => {
      this.child = null;
    });
  }

  stop() {
    if (!this.child) {
      return;
    }

    this.send({ type: "shutdown" });
    this.child.kill();
    this.child = null;
  }

  onMessage(listener: (message: PtyHostMessage) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  createSession(payload: PtyCreateSessionPayload) {
    this.send({
      type: "create",
      ...payload
    });
  }

  sendInput(sessionId: string, data: string) {
    this.send({
      type: "input",
      sessionId,
      data
    });
  }

  resizeSession(sessionId: string, cols: number, rows: number) {
    this.send({
      type: "resize",
      sessionId,
      cols,
      rows
    });
  }

  killSession(sessionId: string) {
    this.send({
      type: "kill",
      sessionId
    });
  }

  send(
    payload:
      | (PtyCreateSessionPayload & { type: "create" })
      | { type: "shutdown" }
      | { type: "input"; sessionId: string; data: string }
      | { type: "resize"; sessionId: string; cols: number; rows: number }
      | { type: "kill"; sessionId: string }
  ) {
    this.start();
    if (!this.child || !this.child.stdin.writable) {
      return;
    }

    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }
}

// Windows PTY host: uses node-pty in-process via ConPTY (no Python required).
class WindowsPtyHostClient {
  sessions: Map<string, ReturnType<typeof import("node-pty").spawn>>;
  listeners: Set<(message: PtyHostMessage) => void>;

  constructor() {
    this.sessions = new Map();
    this.listeners = new Set();
  }

  start() {
    // no-op: in-process, no subprocess to start
  }

  stop() {
    for (const sessionId of this.sessions.keys()) {
      this.killSession(sessionId);
    }
  }

  onMessage(listener: (message: PtyHostMessage) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  createSession(payload: PtyCreateSessionPayload) {
    const { sessionId, cwd, env: sessionEnv } = payload;
    const nodePty = require("node-pty") as typeof import("node-pty");

    let shell: string;
    let args: string[];
    if ("command" in payload && payload.command) {
      shell = payload.command[0];
      args = payload.command.slice(1);
    } else {
      shell = ("shellPath" in payload && payload.shellPath) || process.env.COMSPEC || "cmd.exe";
      args = [];
    }

    const ptyProcess = nodePty.spawn(shell, args, {
      name: "xterm-256color",
      cols: 140,
      rows: 42,
      cwd,
      env: { ...process.env, ...sessionEnv, TERM: "xterm-256color" } as NodeJS.ProcessEnv
    });

    this.sessions.set(sessionId, ptyProcess);

    ptyProcess.onData((data: string) => {
      this.emit({ type: "data", sessionId, data });
    });

    ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      this.sessions.delete(sessionId);
      this.emit({ type: "exit", sessionId, exitCode: exitCode ?? 0 });
    });

    this.emit({ type: "created", sessionId });
  }

  sendInput(sessionId: string, data: string) {
    this.sessions.get(sessionId)?.write(data);
  }

  resizeSession(sessionId: string, cols: number, rows: number) {
    this.sessions.get(sessionId)?.resize(cols, rows);
  }

  killSession(sessionId: string) {
    const ptyProcess = this.sessions.get(sessionId);
    if (ptyProcess) {
      ptyProcess.kill();
      this.sessions.delete(sessionId);
    }
  }

  private emit(message: PtyHostMessage) {
    this.listeners.forEach((listener) => listener(message));
  }
}

module.exports = {
  PtyHostClient: process.platform === "win32" ? WindowsPtyHostClient : PtyHostClient
};
