import type { SessionBlocker, SessionBlockerKind, SessionStatus } from "../shared-types";

const { TerminalTranscriptBuffer } = require("./terminal-transcript-buffer");

function sanitizeVisibleText(text: string): string {
  return TerminalTranscriptBuffer.visibleText(text);
}

function detectSignal(chunk: string): { status: SessionStatus; blocker: SessionBlocker } | null {
  const lowered = normalizeSignalText(chunk);

  if (!lowered) {
    return null;
  }

  if (
    lowered.includes("allow once") ||
    lowered.includes("allow always") ||
    lowered.includes("permission prompt") ||
    lowered.includes("yes, allow once") ||
    lowered.includes("yes, allow always")
  ) {
    return {
      status: "blocked",
      blocker: blocker("approval", "Claude is waiting for an approval decision.")
    };
  }

  if (lowered.includes("permission denied") || lowered.includes("tool permission")) {
    return {
      status: "blocked",
      blocker: blocker("toolPermission", "Claude hit a tool permission blocker.")
    };
  }

  if (
    lowered.includes("fix conflicts and then commit") ||
    lowered.includes("you have unmerged paths") ||
    lowered.includes("cannot merge: you have unmerged files")
  ) {
    return {
      status: "blocked",
      blocker: blocker("gitConflict", "Claude is blocked on a git conflict.")
    };
  }

  const questionSignals = [
    "what would you like",
    "which option",
    "how should i proceed",
    "please choose",
    "let me know which"
  ];

  if (questionSignals.some((signal) => lowered.includes(signal))) {
    return {
      status: "needs_input",
      blocker: blocker("question", "Claude is waiting for your input.")
    };
  }

  const planModeSignals = [
    "would you like to proceed with this plan",
    "do you want to proceed with this plan",
    "proceed with this plan",
    "1. yes, proceed",
    "1) yes, proceed"
  ];

  if (planModeSignals.some((signal) => lowered.includes(signal))) {
    return {
      status: "blocked",
      blocker: blocker("planMode", "Claude is waiting for plan approval.")
    };
  }

  if (lowered.includes("process crashed") || lowered.includes("fatal error")) {
    return {
      status: "failed",
      blocker: blocker("crashed", "Claude reported a crash.")
    };
  }

  return null;
}

function normalizeSignalText(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function blocker(kind: SessionBlockerKind, summary: string): SessionBlocker {
  return {
    kind,
    summary,
    detectedAt: new Date().toISOString()
  };
}

module.exports = {
  sanitizeVisibleText,
  detectSignal
};
