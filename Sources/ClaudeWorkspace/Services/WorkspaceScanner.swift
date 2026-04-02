import Foundation

enum WorkspaceScanner {
    private static let skippedDirectories: Set<String> = [
        ".build",
        ".git",
        ".swiftpm",
        "DerivedData",
        "node_modules"
    ]

    static func scan(rootURL: URL, workspaceID: UUID) -> [RepoRecord] {
        let normalizedRootURL = rootURL.standardizedFileURL
        let fileManager = FileManager.default
        let resourceKeys: Set<URLResourceKey> = [.isDirectoryKey, .nameKey]

        guard let enumerator = fileManager.enumerator(
            at: normalizedRootURL,
            includingPropertiesForKeys: Array(resourceKeys),
            options: [.skipsPackageDescendants]
        ) else {
            return []
        }

        var repoURLs = Set<URL>()

        for case let itemURL as URL in enumerator {
            guard let values = try? itemURL.resourceValues(forKeys: resourceKeys) else {
                continue
            }

            if values.isDirectory == true, skippedDirectories.contains(itemURL.lastPathComponent), itemURL.lastPathComponent != ".git" {
                enumerator.skipDescendants()
                continue
            }

            guard itemURL.lastPathComponent == ".git", values.isDirectory == true else {
                continue
            }

            repoURLs.insert(itemURL.deletingLastPathComponent().standardizedFileURL)
            enumerator.skipDescendants()
        }

        var repos = repoURLs
            .sorted { $0.path(percentEncoded: false) < $1.path(percentEncoded: false) }
            .map {
                RepoRecord(
                    id: UUID(),
                    workspaceID: workspaceID,
                    name: $0.lastPathComponent,
                    path: $0.normalizedFileSystemPath,
                    discoveredAt: .now
                )
            }

        let rootPath = normalizedRootURL.normalizedFileSystemPath
        let rootHasGitDirectory = FileManager.default.fileExists(
            atPath: normalizedRootURL.appending(path: ".git").path(percentEncoded: false)
        )
        let containsRootAlready = repos.contains { $0.path == rootPath }

        if rootHasGitDirectory || repos.isEmpty {
            if !containsRootAlready {
                repos.insert(
                    RepoRecord(
                        id: UUID(),
                        workspaceID: workspaceID,
                        name: rootURL.lastPathComponent.isEmpty ? rootPath : rootURL.lastPathComponent,
                        path: rootPath,
                        discoveredAt: .now
                    ),
                    at: 0
                )
            }
        }

        return repos
    }
}
