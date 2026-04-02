import Foundation

extension String {
    var abbreviatedHomePath: String {
        let home = NSHomeDirectory()
        guard hasPrefix(home) else {
            return self
        }

        let suffix = dropFirst(home.count)
        return suffix.isEmpty ? "~" : "~\(suffix)"
    }

    func trimmed(to limit: Int) -> String {
        guard count > limit else {
            return self
        }

        let endIndex = index(startIndex, offsetBy: limit)
        return String(self[..<endIndex]).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
    }
}

extension Date {
    var shortTimestamp: String {
        formatted(date: .abbreviated, time: .shortened)
    }
}

extension URL {
    var abbreviatedPath: String {
        path(percentEncoded: false).abbreviatedHomePath
    }

    var normalizedFileSystemPath: String {
        let standardized = standardizedFileURL.path(percentEncoded: false)

        guard standardized.count > 1, standardized.hasSuffix("/") else {
            return standardized
        }

        return String(standardized.dropLast())
    }
}
