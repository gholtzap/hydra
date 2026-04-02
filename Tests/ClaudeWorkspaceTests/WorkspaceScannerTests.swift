import Foundation
import XCTest
@testable import ClaudeWorkspace

final class WorkspaceScannerTests: XCTestCase {
    func testScanReturnsWorkspaceRootWhenNoGitReposExist() throws {
        let workspaceURL = try makeTemporaryDirectory()

        let repos = WorkspaceScanner.scan(rootURL: workspaceURL, workspaceID: UUID())

        XCTAssertEqual(repos.count, 1)
        XCTAssertEqual(repos.first?.path, workspaceURL.path(percentEncoded: false))
    }

    func testScanReturnsNestedGitRepos() throws {
        let workspaceURL = try makeTemporaryDirectory()
        let repoURL = workspaceURL.appending(path: "project")
        try FileManager.default.createDirectory(at: repoURL, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: repoURL.appending(path: ".git"), withIntermediateDirectories: true)

        let repos = WorkspaceScanner.scan(rootURL: workspaceURL, workspaceID: UUID())

        XCTAssertEqual(repos.count, 1)
        XCTAssertEqual(repos.first?.path, repoURL.path(percentEncoded: false))
    }

    func testScanReturnsRootWhenRootItselfIsGitRepo() throws {
        let workspaceURL = try makeTemporaryDirectory()
        try FileManager.default.createDirectory(at: workspaceURL.appending(path: ".git"), withIntermediateDirectories: true)

        let repos = WorkspaceScanner.scan(rootURL: workspaceURL, workspaceID: UUID())

        XCTAssertEqual(repos.count, 1)
        XCTAssertEqual(repos.first?.path, workspaceURL.path(percentEncoded: false))
    }

    private func makeTemporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock {
            try? FileManager.default.removeItem(at: url)
        }
        return url
    }
}
