import Foundation

struct SessionSignalUpdate {
    var status: SessionStatus
    var blocker: SessionBlocker?
}

enum SessionSignalDetector {
    static func sanitize(_ text: String) -> String {
        TerminalTranscriptBuffer.visibleText(in: text)
    }

    static func detect(from chunk: String) -> SessionSignalUpdate? {
        let lowered = chunk.lowercased()

        if lowered.contains("allow once") || lowered.contains("allow always") || lowered.contains("permission prompt") {
            return SessionSignalUpdate(
                status: .blocked,
                blocker: SessionBlocker(
                    kind: .approval,
                    summary: "Claude is waiting for an approval decision.",
                    detectedAt: .now
                )
            )
        }

        if lowered.contains("permission denied") || lowered.contains("tool permission") {
            return SessionSignalUpdate(
                status: .blocked,
                blocker: SessionBlocker(
                    kind: .toolPermission,
                    summary: "Claude hit a tool permission blocker.",
                    detectedAt: .now
                )
            )
        }

        if lowered.contains("merge conflict") || lowered.contains("git conflict") {
            return SessionSignalUpdate(
                status: .blocked,
                blocker: SessionBlocker(
                    kind: .gitConflict,
                    summary: "Claude is blocked on a git conflict.",
                    detectedAt: .now
                )
            )
        }

        let questionSignals = [
            "what would you like",
            "which option",
            "how should i proceed",
            "please choose",
            "let me know which"
        ]

        if questionSignals.contains(where: lowered.contains) {
            return SessionSignalUpdate(
                status: .needsInput,
                blocker: SessionBlocker(
                    kind: .question,
                    summary: "Claude is waiting for your input.",
                    detectedAt: .now
                )
            )
        }

        if lowered.contains("process crashed") || lowered.contains("fatal error") {
            return SessionSignalUpdate(
                status: .failed,
                blocker: SessionBlocker(
                    kind: .crashed,
                    summary: "Claude reported a crash.",
                    detectedAt: .now
                )
            )
        }

        return nil
    }
}
