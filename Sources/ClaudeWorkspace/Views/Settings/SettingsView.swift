import AppKit
import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        TabView {
            GeneralSettingsPane(model: model)
                .tabItem {
                    Label("General", systemImage: "gearshape")
                }

            ClaudeSettingsPane(model: model)
                .tabItem {
                    Label("Claude", systemImage: "slider.horizontal.3")
                }

            KeybindingsPane()
                .tabItem {
                    Label("Keybindings", systemImage: "keyboard")
                }
        }
        .padding(20)
        .frame(width: 980, height: 700)
    }
}

private struct GeneralSettingsPane: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Form {
            TextField(
                "Claude Command",
                text: Binding(
                    get: { model.preferences.claudeExecutablePath },
                    set: { model.preferences.claudeExecutablePath = $0 }
                )
            )

            Text("This command is typed into the session shell when Launch Claude immediately is enabled.")
                .font(.caption)
                .foregroundStyle(.secondary)

            TextField(
                "Shell Executable",
                text: Binding(
                    get: { model.preferences.shellExecutablePath ?? model.preferences.resolvedShellExecutablePath },
                    set: { model.preferences.shellExecutablePath = $0 }
                )
            )

            Text("Sessions start as login shells in the selected repo so you can enter and exit Claude normally.")
                .font(.caption)
                .foregroundStyle(.secondary)

            Toggle(
                "Enable Notifications",
                isOn: Binding(
                    get: { model.preferences.notificationsEnabled },
                    set: { model.preferences.notificationsEnabled = $0 }
                )
            )

            Toggle(
                "Show Native macOS Notifications",
                isOn: Binding(
                    get: { model.preferences.showNativeNotifications },
                    set: { model.preferences.showNativeNotifications = $0 }
                )
            )

            Toggle(
                "Show In-App Badges",
                isOn: Binding(
                    get: { model.preferences.showInAppBadges },
                    set: { model.preferences.showInAppBadges = $0 }
                )
            )
        }
        .formStyle(.grouped)
    }
}

private struct ClaudeSettingsPane: View {
    @ObservedObject var model: AppModel
    @State private var selectedFileID: String?
    @State private var editorText = ""
    @State private var saveMessage = ""
    @State private var refreshToken = UUID()

    private var context: ClaudeSettingsContext {
        _ = refreshToken
        return model.claudeSettingsContext
    }

    private var selectedFile: ClaudeSettingsFile? {
        context.allFiles.first { $0.id == selectedFileID }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Claude Settings")
                        .font(.title2.weight(.bold))
                    Text("Edit global and project Claude files directly, then inspect the resolved JSON values.")
                        .foregroundStyle(.secondary)
                }

                Spacer()

                if let repo = model.selectedRepo {
                    Text("Project: \(repo.name)")
                        .foregroundStyle(.secondary)
                } else {
                    Text("Select a repo or session to view project-specific files.")
                        .foregroundStyle(.secondary)
                }
            }

            HSplitView {
                List(selection: $selectedFileID) {
                    Section("Global") {
                        ForEach(context.globalFiles) { file in
                            SettingsFileRow(file: file)
                                .tag(Optional(file.id))
                        }
                    }

                    if !context.projectFiles.isEmpty {
                        Section("Project") {
                            ForEach(context.projectFiles) { file in
                                SettingsFileRow(file: file)
                                    .tag(Optional(file.id))
                            }
                        }
                    }
                }
                .frame(minWidth: 240)

                VStack(alignment: .leading, spacing: 12) {
                    if let selectedFile {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(selectedFile.title)
                                    .font(.headline)
                                Text(selectedFile.url.path.abbreviatedHomePath)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }

                            Spacer()

                            Button("Reload") {
                                loadSelectedFile()
                            }

                            Button(selectedFile.exists ? "Save" : "Create") {
                                saveSelectedFile()
                            }
                            .buttonStyle(.borderedProminent)

                            Button("Reveal") {
                                NSWorkspace.shared.activateFileViewerSelecting([selectedFile.url])
                            }
                        }

                        TextEditor(text: $editorText)
                            .font(.system(.body, design: .monospaced))
                            .overlay {
                                RoundedRectangle(cornerRadius: 12)
                                    .stroke(.quaternary)
                            }

                        if !saveMessage.isEmpty {
                            Text(saveMessage)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        EmptyDetailView(
                            title: "Select a Settings File",
                            message: "Choose a global or project Claude file to edit it."
                        )
                    }

                    Divider()

                    VStack(alignment: .leading, spacing: 10) {
                        Text("Resolved JSON Values")
                            .font(.headline)

                        if context.resolvedValues.isEmpty {
                            Text("No JSON settings are currently available to resolve.")
                                .foregroundStyle(.secondary)
                        } else {
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: 10) {
                                    ForEach(context.resolvedValues) { value in
                                        VStack(alignment: .leading, spacing: 4) {
                                            HStack {
                                                Text(value.keyPath)
                                                    .font(.system(.caption, design: .monospaced))
                                                Spacer()
                                                Text(value.sourceLabel)
                                                    .font(.caption)
                                                    .foregroundStyle(.secondary)
                                            }
                                            Text(value.valueSummary)
                                                .font(.system(.caption, design: .monospaced))
                                                .foregroundStyle(.secondary)
                                            Divider()
                                        }
                                    }
                                }
                            }
                            .frame(minHeight: 180)
                        }
                    }
                }
                .padding(.leading, 16)
            }
        }
        .onAppear {
            syncSelection()
        }
        .onChange(of: context.signature) { _, _ in
            syncSelection()
        }
        .onChange(of: selectedFileID) { _, _ in
            loadSelectedFile()
        }
    }

    private func syncSelection() {
        if let selectedFileID, context.allFiles.contains(where: { $0.id == selectedFileID }) {
            loadSelectedFile()
            return
        }

        selectedFileID = context.allFiles.first?.id
        loadSelectedFile()
    }

    private func loadSelectedFile() {
        guard let selectedFile else {
            editorText = ""
            return
        }

        editorText = ClaudeSettingsService.loadContents(for: selectedFile)
        saveMessage = ""
    }

    private func saveSelectedFile() {
        guard let selectedFile else {
            return
        }

        do {
            try ClaudeSettingsService.save(contents: editorText, to: selectedFile)
            saveMessage = "Saved \(selectedFile.title)"
            refreshToken = UUID()
            syncSelection()
        } catch {
            saveMessage = error.localizedDescription
        }
    }
}

private struct SettingsFileRow: View {
    let file: ClaudeSettingsFile

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(file.title)
                Text(file.url.lastPathComponent)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Text(file.exists ? "Exists" : "New")
                .font(.caption.weight(.semibold))
                .foregroundStyle(file.exists ? .secondary : Color.accentColor)
        }
    }
}

private struct KeybindingsPane: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Current Keybindings")
                .font(.title2.weight(.bold))

            KeybindingRow(command: "Quick Switcher", shortcut: "Cmd-K")
            KeybindingRow(command: "Command Palette", shortcut: "Shift-Cmd-P")
            KeybindingRow(command: "Next Unread Session", shortcut: "Option-Cmd-]")
            KeybindingRow(command: "New Session", shortcut: "Shift-Cmd-T")
            KeybindingRow(command: "Open Workspace Folder", shortcut: "Shift-Cmd-O")
            KeybindingRow(command: "Create Empty Folder", shortcut: "Shift-Cmd-N")

            Spacer()
        }
    }
}

private struct KeybindingRow: View {
    let command: String
    let shortcut: String

    var body: some View {
        HStack {
            Text(command)
            Spacer()
            Text(shortcut)
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}
