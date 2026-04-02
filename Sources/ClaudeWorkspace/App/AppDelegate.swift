import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var model: AppModel?

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let model, model.hasLiveSessions else {
            model?.prepareForTermination()
            return .terminateNow
        }

        let alert = NSAlert()
        alert.messageText = "Quit Claude Workspace?"
        alert.informativeText = "Quitting will terminate \(model.liveSessionCount) running Claude session(s)."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Cancel")

        let response = alert.runModal()

        guard response == .alertFirstButtonReturn else {
            return .terminateCancel
        }

        model.prepareForTermination()
        return .terminateNow
    }

    func applicationWillTerminate(_ notification: Notification) {
        model?.prepareForTermination()
    }
}
