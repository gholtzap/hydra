import SwiftUI

private struct PaletteAction: Identifiable {
    let id = UUID()
    let title: String
    let subtitle: String
    let action: () -> Void
}

struct CommandPaletteView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: AppModel
    @State private var query = ""

    private var actions: [PaletteAction] {
        [
            PaletteAction(
                title: "Open Workspace Folder",
                subtitle: "Scan a folder for git repositories."
            ) {
                model.openWorkspaceFolderPanel()
            },
            PaletteAction(
                title: "Create Empty Folder",
                subtitle: "Create a new local project folder."
            ) {
                model.createProjectFolderPanel()
            },
            PaletteAction(
                title: "New Session",
                subtitle: "Launch Claude in a recent repo."
            ) {
                model.presentSessionLauncher(for: model.selectedRepo?.id)
            },
            PaletteAction(
                title: "Next Unread Session",
                subtitle: "Jump to the next blocked or unread session."
            ) {
                model.nextUnreadSession()
            },
            PaletteAction(
                title: "Open Settings",
                subtitle: "Edit Claude paths, notifications, and raw settings files."
            ) {
                model.openSettingsWindow()
            }
        ]
    }

    private var filteredActions: [PaletteAction] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        guard !normalized.isEmpty else {
            return actions
        }

        return actions.filter { action in
            action.title.lowercased().contains(normalized) || action.subtitle.lowercased().contains(normalized)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Command Palette")
                .font(.title2.weight(.bold))

            TextField("Search commands", text: $query)
                .textFieldStyle(.roundedBorder)

            List(filteredActions) { action in
                Button {
                    dismiss()
                    action.action()
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(action.title)
                        Text(action.subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
            }
            .listStyle(.inset)
        }
        .padding(20)
        .frame(width: 560, height: 420)
    }
}
