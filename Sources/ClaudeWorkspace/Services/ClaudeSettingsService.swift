import Foundation

enum ClaudeSettingsService {
    private static let fileLayouts: [(String, String)] = [
        ("CLAUDE.md", "CLAUDE.md"),
        (".claude/settings.json", "settings.json"),
        (".claude/settings.local.json", "settings.local.json")
    ]

    static func context(for repo: RepoRecord?) -> ClaudeSettingsContext {
        let globalRoot = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".claude")
        let globalFiles = files(for: globalRoot, scope: .global, prefix: "Global")
        let projectFiles: [ClaudeSettingsFile]

        if let repo {
            projectFiles = files(
                for: URL(fileURLWithPath: repo.path, isDirectory: true),
                scope: .project(repo.name),
                prefix: repo.name
            )
        } else {
            projectFiles = []
        }

        let resolvedValues = resolveValues(globalFiles: globalFiles, projectFiles: projectFiles)

        return ClaudeSettingsContext(
            globalFiles: globalFiles,
            projectFiles: projectFiles,
            resolvedValues: resolvedValues
        )
    }

    static func loadContents(for file: ClaudeSettingsFile) -> String {
        guard file.exists, let contents = try? String(contentsOf: file.url, encoding: .utf8) else {
            return ""
        }

        return contents
    }

    static func save(contents: String, to file: ClaudeSettingsFile) throws {
        try FileManager.default.createDirectory(
            at: file.url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        try contents.write(to: file.url, atomically: true, encoding: .utf8)
    }

    private static func files(
        for rootURL: URL,
        scope: ClaudeSettingsFile.Scope,
        prefix: String
    ) -> [ClaudeSettingsFile] {
        fileLayouts.map { relativePath, title in
            let url = rootURL.appending(path: relativePath)
            let exists = FileManager.default.fileExists(atPath: url.path(percentEncoded: false))
            return ClaudeSettingsFile(
                title: "\(prefix) \(title)",
                url: url,
                scope: scope,
                exists: exists
            )
        }
    }

    private static func resolveValues(
        globalFiles: [ClaudeSettingsFile],
        projectFiles: [ClaudeSettingsFile]
    ) -> [ResolvedSettingValue] {
        let precedence = [globalFiles, projectFiles].flatMap { files in
            files.filter { $0.url.pathExtension == "json" && $0.exists }
        }

        var valuesByKey: [String: ResolvedSettingValue] = [:]

        for file in precedence {
            guard
                let data = try? Data(contentsOf: file.url),
                let json = try? JSONSerialization.jsonObject(with: data)
            else {
                continue
            }

            for (keyPath, value) in flatten(json, prefix: nil) {
                valuesByKey[keyPath] = ResolvedSettingValue(
                    keyPath: keyPath,
                    valueSummary: value,
                    sourceLabel: file.title
                )
            }
        }

        return valuesByKey.values.sorted { $0.keyPath < $1.keyPath }
    }

    private static func flatten(_ value: Any, prefix: String?) -> [(String, String)] {
        if let dictionary = value as? [String: Any] {
            return dictionary.keys.sorted().flatMap { key in
                let nextPrefix = prefix.map { "\($0).\(key)" } ?? key
                return flatten(dictionary[key] as Any, prefix: nextPrefix)
            }
        }

        let key = prefix ?? "$"
        return [(key, stringify(value))]
    }

    private static func stringify(_ value: Any) -> String {
        if JSONSerialization.isValidJSONObject(value),
           let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
           let string = String(data: data, encoding: .utf8) {
            return string
        }

        if let string = value as? String {
            return string
        }

        if let number = value as? NSNumber {
            return number.stringValue
        }

        if value is NSNull {
            return "null"
        }

        return String(describing: value)
    }
}
