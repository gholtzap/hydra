function sanitizeVisibleText(text) {
  return text
    .replace(/\x1b\][^\u0007]*(?:\u0007|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .replace(/[^\x09\x0a\x20-\x7e\u00a0-\uffff]/g, "");
}

function detectSignal(chunk) {
  const lowered = chunk.toLowerCase();

  if (
    lowered.includes("allow once") ||
    lowered.includes("allow always") ||
    lowered.includes("permission prompt")
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

  if (lowered.includes("merge conflict") || lowered.includes("git conflict")) {
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

  if (lowered.includes("process crashed") || lowered.includes("fatal error")) {
    return {
      status: "failed",
      blocker: blocker("crashed", "Claude reported a crash.")
    };
  }

  return null;
}

function blocker(kind, summary) {
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
