import Foundation

enum SessionStatus: String, Codable, CaseIterable, Hashable {
    case running
    case needsInput = "needs_input"
    case blocked
    case done
    case failed
    case idle

    var label: String {
        switch self {
        case .running:
            return "Running"
        case .needsInput:
            return "Needs Input"
        case .blocked:
            return "Blocked"
        case .done:
            return "Done"
        case .failed:
            return "Failed"
        case .idle:
            return "Idle"
        }
    }
}

enum SessionRuntimeState: String, Codable, Hashable {
    case live
    case stopped
}

enum SessionBlockerKind: String, Codable, Hashable {
    case approval
    case question
    case toolPermission
    case gitConflict
    case crashed
    case stuck
    case unknown

    var label: String {
        switch self {
        case .approval:
            return "Approval"
        case .question:
            return "Question"
        case .toolPermission:
            return "Tool Permission"
        case .gitConflict:
            return "Git Conflict"
        case .crashed:
            return "Crashed"
        case .stuck:
            return "Possibly Stuck"
        case .unknown:
            return "Needs Attention"
        }
    }
}

struct SessionBlocker: Codable, Hashable {
    var kind: SessionBlockerKind
    var summary: String
    var detectedAt: Date
}

struct WorkspaceRecord: Identifiable, Codable, Hashable {
    var id: UUID
    var name: String
    var rootPath: String
    var createdAt: Date
}

struct RepoRecord: Identifiable, Codable, Hashable {
    var id: UUID
    var workspaceID: UUID
    var name: String
    var path: String
    var discoveredAt: Date
}

struct SessionRecord: Identifiable, Codable, Hashable {
    var id: UUID
    var repoID: UUID
    var title: String
    var initialPrompt: String
    var launchesClaudeOnStart: Bool?
    var status: SessionStatus
    var runtimeState: SessionRuntimeState
    var blocker: SessionBlocker?
    var unreadCount: Int
    var createdAt: Date
    var updatedAt: Date
    var lastActivityAt: Date?
    var stoppedAt: Date?
    var launchCount: Int
    var transcript: String
    var rawTranscript: String?

    var hasUnread: Bool {
        unreadCount > 0
    }

    var isLive: Bool {
        runtimeState == .live
    }

    var shouldLaunchClaudeOnStart: Bool {
        launchesClaudeOnStart ?? true
    }
}

struct AppPreferences: Codable, Hashable {
    var claudeExecutablePath: String
    var shellExecutablePath: String?
    var notificationsEnabled: Bool
    var showInAppBadges: Bool
    var showNativeNotifications: Bool

    var resolvedShellExecutablePath: String {
        let trimmed = shellExecutablePath?.trimmingCharacters(in: .whitespacesAndNewlines)

        if let trimmed, !trimmed.isEmpty {
            return trimmed
        }

        let environmentShell = ProcessInfo.processInfo.environment["SHELL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return environmentShell?.isEmpty == false ? environmentShell! : "/bin/zsh"
    }

    static let `default` = AppPreferences(
        claudeExecutablePath: "claude",
        shellExecutablePath: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh",
        notificationsEnabled: true,
        showInAppBadges: true,
        showNativeNotifications: true
    )
}

struct AppStateSnapshot: Codable {
    var workspaces: [WorkspaceRecord]
    var repos: [RepoRecord]
    var sessions: [SessionRecord]
    var preferences: AppPreferences

    static let empty = AppStateSnapshot(
        workspaces: [],
        repos: [],
        sessions: [],
        preferences: .default
    )
}

enum SidebarSelection: Hashable {
    case inbox
    case repo(UUID)
    case session(UUID)
}

struct ClaudeSettingsFile: Identifiable, Hashable {
    enum Scope: Hashable {
        case global
        case project(String)
    }

    var id: String {
        url.path
    }

    var title: String
    var url: URL
    var scope: Scope
    var exists: Bool
}

struct ResolvedSettingValue: Identifiable, Hashable {
    var id: String {
        keyPath
    }

    var keyPath: String
    var valueSummary: String
    var sourceLabel: String
}

struct ClaudeSettingsContext: Hashable {
    var globalFiles: [ClaudeSettingsFile]
    var projectFiles: [ClaudeSettingsFile]
    var resolvedValues: [ResolvedSettingValue]

    var allFiles: [ClaudeSettingsFile] {
        globalFiles + projectFiles
    }

    var signature: String {
        allFiles.map(\.id).joined(separator: "|")
    }
}
