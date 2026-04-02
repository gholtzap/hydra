import XCTest
@testable import ClaudeWorkspace

final class TerminalTranscriptBufferTests: XCTestCase {
    func testCarriageReturnOverwritesExistingLine() {
        let buffer = TerminalTranscriptBuffer()
        let text = buffer.consume("abcdef\rxy")

        XCTAssertEqual(text, "xycdef")
    }

    func testClearLineSequenceRemovesStaleTail() {
        let buffer = TerminalTranscriptBuffer()
        let text = buffer.consume("abcdef\r\u{001B}[Kxy")

        XCTAssertEqual(text, "xy")
    }

    func testBackspaceDeletesPreviousCharacter() {
        let buffer = TerminalTranscriptBuffer()
        let text = buffer.consume("abc\u{0008}d")

        XCTAssertEqual(text, "abd")
    }

    func testClearScreenSequenceResetsTranscript() {
        let buffer = TerminalTranscriptBuffer()
        _ = buffer.consume("before\n")
        let text = buffer.consume("\u{001B}[2Jafter")

        XCTAssertEqual(text, "after")
    }

    func testCursorMovementCanOverwriteMiddleOfLine() {
        let buffer = TerminalTranscriptBuffer()
        let text = buffer.consume("12345\u{001B}[3Dab")

        XCTAssertEqual(text, "12ab5")
    }
}
