import XCTest
@testable import ClaudeWorkspace

final class SessionSignalDetectorTests: XCTestCase {
    func testApprovalPromptBecomesBlockedApproval() {
        let update = SessionSignalDetector.detect(from: "Allow once / Allow always")

        XCTAssertEqual(update?.status, .blocked)
        XCTAssertEqual(update?.blocker?.kind, .approval)
    }

    func testQuestionPromptBecomesNeedsInput() {
        let update = SessionSignalDetector.detect(from: "How should I proceed from here?")

        XCTAssertEqual(update?.status, .needsInput)
        XCTAssertEqual(update?.blocker?.kind, .question)
    }

    func testCrashPromptBecomesFailed() {
        let update = SessionSignalDetector.detect(from: "fatal error: command failed")

        XCTAssertEqual(update?.status, .failed)
        XCTAssertEqual(update?.blocker?.kind, .crashed)
    }

    func testSanitizeRemovesEscapeSequences() {
        let input = "\u{001B}[31mhello\u{001B}[0m"

        XCTAssertEqual(SessionSignalDetector.sanitize(input), "hello")
    }
}
