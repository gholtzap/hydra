import SwiftUI

struct ClaudeWorkspaceToolbarContent: CustomizableToolbarContent {
    @ObservedObject var model: AppModel

    var body: some CustomizableToolbarContent {
        ToolbarItem(id: "open-workspace") {
            Button("Open Workspace", systemImage: "folder.badge.plus") {
                model.openWorkspaceFolderPanel()
            }
        }

        ToolbarItem(id: "new-folder") {
            Button("Create Folder", systemImage: "folder.badge.gearshape") {
                model.createProjectFolderPanel()
            }
        }

        ToolbarItem(id: "new-session") {
            Button("New Session", systemImage: "plus.bubble") {
                model.presentSessionLauncher(for: model.selectedRepo?.id)
            }
        }

        ToolbarItem(id: "next-unread") {
            Button("Next Unread", systemImage: "arrowshape.right.fill") {
                model.nextUnreadSession()
            }
        }
    }
}

@main
struct ClaudeWorkspaceApp: App {
    @StateObject private var model = AppModel()
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .frame(minWidth: 1180, minHeight: 760)
                .task {
                    appDelegate.model = model
                }
        }
        .commands {
            ClaudeWorkspaceCommands(model: model)
        }

        Settings {
            SettingsView(model: model)
        }
    }
}
