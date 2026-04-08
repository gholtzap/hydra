import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { PtyCreateSessionPayload, PtyHostMessage } from "../shared-types";

const { spawn } = require("node:child_process");
const path = require("node:path");

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

    const hostPath = path.join(__dirname, "pty_host.py");
    this.child = spawn("/usr/bin/env", ["python3", hostPath], {
      stdio: ["pipe", "pipe", "inherit"]
    }) as ChildProcessWithoutNullStreams;

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

module.exports = {
  PtyHostClient
};
