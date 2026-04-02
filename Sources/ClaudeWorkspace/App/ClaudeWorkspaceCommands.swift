import SwiftUI

struct ClaudeWorkspaceCommands: Commands {
    @ObservedObject var model: AppModel

    var body: some Commands {
        CommandGroup(after: .newItem) {
            Button("Open Workspace Folder…") {
                model.openWorkspaceFolderPanel()
            }
            .keyboardShortcut("O", modifiers: [.command, .shift])

            Button("Create Empty Folder…") {
                model.createProjectFolderPanel()
            }
            .keyboardShortcut("N", modifiers: [.command, .shift])

            Button("New Session…") {
                model.presentSessionLauncher(for: model.selectedRepo?.id)
            }
            .keyboardShortcut("T", modifiers: [.command, .shift])
        }

        CommandMenu("Navigate") {
            Button("Quick Switcher") {
                model.quickSwitcherPresented = true
            }
            .keyboardShortcut("k", modifiers: [.command])

            Button("Command Palette") {
                model.commandPalettePresented = true
            }
            .keyboardShortcut("p", modifiers: [.command, .shift])

            Button("Next Unread Session") {
                model.nextUnreadSession()
            }
            .keyboardShortcut("]", modifiers: [.command, .option])
        }
    }
}
