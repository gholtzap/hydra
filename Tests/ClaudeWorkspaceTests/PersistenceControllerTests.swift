import Foundation
import XCTest
@testable import ClaudeWorkspace

final class PersistenceControllerTests: XCTestCase {
    func testLoadDecodesLegacySnapshotWithMissingShellFields() throws {
        let stateURL = try temporaryStateURL()
        defer { try? FileManager.default.removeItem(at: stateURL.deletingLastPathComponent()) }

        let legacySnapshot = """
        {
          "preferences" : {
            "claudeExecutablePath" : "claude",
            "notificationsEnabled" : true,
            "showInAppBadges" : true,
            "showNativeNotifications" : true
          },
          "repos" : [
            {
              "discoveredAt" : "2026-04-02T12:00:00Z",
              "id" : "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB",
              "name" : "demo-repo",
              "path" : "/tmp/demo-repo",
              "workspaceID" : "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"
            }
          ],
          "sessions" : [
            {
              "createdAt" : "2026-04-02T12:00:00Z",
              "id" : "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC",
              "initialPrompt" : "",
              "lastActivityAt" : null,
              "launchCount" : 1,
              "repoID" : "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB",
              "runtimeState" : "stopped",
              "status" : "idle",
              "stoppedAt" : "2026-04-02T12:05:00Z",
              "title" : "Claude 1",
              "transcript" : "",
              "unreadCount" : 0,
              "updatedAt" : "2026-04-02T12:05:00Z",
              "blocker" : null
            }
          ],
          "workspaces" : [
            {
              "createdAt" : "2026-04-02T12:00:00Z",
              "id" : "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
              "name" : "demo",
              "rootPath" : "/tmp/demo"
            }
          ]
        }
        """

        try Data(legacySnapshot.utf8).write(to: stateURL)

        let snapshot = PersistenceController(stateURL: stateURL).load()

        XCTAssertEqual(snapshot.workspaces.count, 1)
        XCTAssertEqual(snapshot.repos.count, 1)
        XCTAssertEqual(snapshot.sessions.count, 1)
        XCTAssertEqual(snapshot.preferences.claudeExecutablePath, "claude")
        XCTAssertTrue(snapshot.sessions[0].shouldLaunchClaudeOnStart)
        XCTAssertFalse(snapshot.preferences.resolvedShellExecutablePath.isEmpty)
    }

    func testSaveAndLoadRoundTripsShellBackedSessionFields() throws {
        let stateURL = try temporaryStateURL()
        defer { try? FileManager.default.removeItem(at: stateURL.deletingLastPathComponent()) }

        let snapshot = AppStateSnapshot(
            workspaces: [
                WorkspaceRecord(
                    id: UUID(uuidString: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")!,
                    name: "demo",
                    rootPath: "/tmp/demo",
                    createdAt: Date(timeIntervalSince1970: 1_775_131_200)
                )
            ],
            repos: [
                RepoRecord(
                    id: UUID(uuidString: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB")!,
                    workspaceID: UUID(uuidString: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")!,
                    name: "demo-repo",
                    path: "/tmp/demo-repo",
                    discoveredAt: Date(timeIntervalSince1970: 1_775_131_200)
                )
            ],
            sessions: [
                SessionRecord(
                    id: UUID(uuidString: "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC")!,
                    repoID: UUID(uuidString: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB")!,
                    title: "Shell 1",
                    initialPrompt: "",
                    launchesClaudeOnStart: false,
                    status: .idle,
                    runtimeState: .stopped,
                    blocker: nil,
                    unreadCount: 0,
                    createdAt: Date(timeIntervalSince1970: 1_775_131_200),
                    updatedAt: Date(timeIntervalSince1970: 1_775_131_260),
                    lastActivityAt: nil,
                    stoppedAt: Date(timeIntervalSince1970: 1_775_131_260),
                    launchCount: 2,
                    transcript: "exit\n",
                    rawTranscript: "exit\r\n"
                )
            ],
            preferences: AppPreferences(
                claudeExecutablePath: "claude",
                shellExecutablePath: "/bin/zsh",
                notificationsEnabled: true,
                showInAppBadges: true,
                showNativeNotifications: true
            )
        )

        let controller = PersistenceController(stateURL: stateURL)
        try controller.save(snapshot)
        let loaded = controller.load()

        XCTAssertEqual(loaded.sessions.first?.launchesClaudeOnStart, false)
        XCTAssertEqual(loaded.sessions.first?.rawTranscript, "exit\r\n")
        XCTAssertEqual(loaded.preferences.shellExecutablePath, "/bin/zsh")
    }

    private func temporaryStateURL() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appending(path: "state.json")
    }
}
