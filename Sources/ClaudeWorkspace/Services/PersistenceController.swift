import Foundation

struct PersistenceController {
    let stateURL: URL

    init(fileManager: FileManager = .default) {
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.homeDirectoryForCurrentUser
        stateURL = appSupport
            .appending(path: "ClaudeWorkspace", directoryHint: .isDirectory)
            .appending(path: "state.json")
    }

    init(stateURL: URL) {
        self.stateURL = stateURL
    }

    func load() -> AppStateSnapshot {
        guard
            let data = try? Data(contentsOf: stateURL)
        else {
            return .empty
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        guard let snapshot = try? decoder.decode(AppStateSnapshot.self, from: data) else {
            return .empty
        }

        return snapshot
    }

    func save(_ snapshot: AppStateSnapshot) throws {
        try FileManager.default.createDirectory(
            at: stateURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601

        let data = try encoder.encode(snapshot)
        try data.write(to: stateURL, options: .atomic)
    }
}
