import Foundation

final class TerminalTranscriptBuffer {
    private let maxLength: Int
    private var committedText: String
    private var currentLine: [Character]
    private var cursorColumn: Int

    init(seedText: String = "", maxLength: Int = 160_000) {
        self.maxLength = maxLength
        committedText = ""
        currentLine = []
        cursorColumn = 0
        replaceSeed(with: seedText)
    }

    var renderedText: String {
        committedText + String(currentLine)
    }

    func consume(_ rawText: String) -> String {
        apply(rawText)
        trimIfNeeded()
        return renderedText
    }

    func replaceSeed(with text: String) {
        if let newlineIndex = text.lastIndex(of: "\n") {
            let nextIndex = text.index(after: newlineIndex)
            committedText = String(text[..<nextIndex])
            currentLine = Array(text[nextIndex...])
        } else {
            committedText = ""
            currentLine = Array(text)
        }

        cursorColumn = currentLine.count
    }

    static func visibleText(in rawText: String) -> String {
        TerminalTranscriptBuffer(seedText: "", maxLength: max(rawText.count * 2, 4_096))
            .consume(rawText)
    }

    private func apply(_ rawText: String) {
        let scalars = Array(rawText.unicodeScalars)
        var index = 0

        while index < scalars.count {
            let scalar = scalars[index]

            if scalar == "\u{001B}" {
                index = parseEscapeSequence(in: scalars, startingAt: index)
                continue
            }

            switch scalar {
            case "\n":
                committedText.append(contentsOf: currentLine)
                committedText.append("\n")
                currentLine.removeAll(keepingCapacity: true)
                cursorColumn = 0
            case "\r":
                cursorColumn = 0
            case "\u{0008}", "\u{007F}":
                guard cursorColumn > 0 else {
                    break
                }

                cursorColumn -= 1

                if cursorColumn < currentLine.count {
                    currentLine.remove(at: cursorColumn)
                }
            case "\t":
                write(character: "\t")
            default:
                guard !CharacterSet.controlCharacters.contains(scalar) else {
                    break
                }

                write(character: Character(scalar))
            }

            index += 1
        }
    }

    private func parseEscapeSequence(in scalars: [UnicodeScalar], startingAt startIndex: Int) -> Int {
        let nextIndex = startIndex + 1

        guard nextIndex < scalars.count else {
            return startIndex + 1
        }

        switch scalars[nextIndex] {
        case "[":
            return parseCSISequence(in: scalars, startingAt: nextIndex + 1)
        case "]":
            return skipOSCSequence(in: scalars, startingAt: nextIndex + 1)
        default:
            return nextIndex + 1
        }
    }

    private func parseCSISequence(in scalars: [UnicodeScalar], startingAt startIndex: Int) -> Int {
        var index = startIndex
        var parameterScalars: [UnicodeScalar] = []

        while index < scalars.count {
            let scalar = scalars[index]

            if scalar.value >= 0x40, scalar.value <= 0x7E {
                applyCSI(final: scalar, parameterString: String(String.UnicodeScalarView(parameterScalars)))
                return index + 1
            }

            parameterScalars.append(scalar)
            index += 1
        }

        return index
    }

    private func skipOSCSequence(in scalars: [UnicodeScalar], startingAt startIndex: Int) -> Int {
        var index = startIndex

        while index < scalars.count {
            let scalar = scalars[index]

            if scalar == "\u{0007}" {
                return index + 1
            }

            if scalar == "\u{001B}", index + 1 < scalars.count, scalars[index + 1] == "\\" {
                return index + 2
            }

            index += 1
        }

        return index
    }

    private func applyCSI(final: UnicodeScalar, parameterString: String) {
        let parameters = parameterString
            .split(separator: ";", omittingEmptySubsequences: false)
            .map { Int($0) ?? 0 }

        switch final {
        case "m":
            return
        case "K":
            clearLine(mode: parameters.first ?? 0)
        case "J":
            clearScreen(mode: parameters.first ?? 0)
        case "C":
            moveCursorForward(by: max(parameters.first ?? 1, 1))
        case "D":
            moveCursorBackward(by: max(parameters.first ?? 1, 1))
        case "G":
            moveCursorToColumn(max((parameters.first ?? 1) - 1, 0))
        case "P":
            deleteCharacters(count: max(parameters.first ?? 1, 1))
        case "X":
            eraseCharacters(count: max(parameters.first ?? 1, 1))
        default:
            return
        }
    }

    private func write(character: Character) {
        if cursorColumn < currentLine.count {
            currentLine[cursorColumn] = character
        } else {
            while currentLine.count < cursorColumn {
                currentLine.append(" ")
            }

            currentLine.append(character)
        }

        cursorColumn += 1
    }

    private func clearLine(mode: Int) {
        switch mode {
        case 1:
            let upperBound = min(cursorColumn, currentLine.count)
            guard upperBound > 0 else {
                return
            }

            for index in 0..<upperBound {
                currentLine[index] = " "
            }
        case 2:
            currentLine.removeAll(keepingCapacity: true)
            cursorColumn = 0
        default:
            guard cursorColumn < currentLine.count else {
                return
            }

            currentLine.removeSubrange(cursorColumn...)
        }
    }

    private func clearScreen(mode: Int) {
        guard mode == 2 || mode == 3 else {
            return
        }

        committedText = ""
        currentLine.removeAll(keepingCapacity: true)
        cursorColumn = 0
    }

    private func moveCursorForward(by amount: Int) {
        cursorColumn += amount
    }

    private func moveCursorBackward(by amount: Int) {
        cursorColumn = max(cursorColumn - amount, 0)
    }

    private func moveCursorToColumn(_ column: Int) {
        cursorColumn = max(column, 0)
    }

    private func deleteCharacters(count: Int) {
        guard cursorColumn < currentLine.count else {
            return
        }

        let upperBound = min(cursorColumn + count, currentLine.count)
        currentLine.removeSubrange(cursorColumn..<upperBound)
    }

    private func eraseCharacters(count: Int) {
        guard cursorColumn < currentLine.count else {
            return
        }

        let upperBound = min(cursorColumn + count, currentLine.count)

        for index in cursorColumn..<upperBound {
            currentLine[index] = " "
        }
    }

    private func trimIfNeeded() {
        guard renderedText.count > maxLength else {
            return
        }

        replaceSeed(with: String(renderedText.suffix(maxLength)))
    }
}
