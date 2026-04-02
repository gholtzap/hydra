import SwiftUI

struct SessionLauncherView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: AppModel
    @State private var query = ""
    @State private var selectedRepoID: UUID?
    @State private var launchesClaudeOnStart = true

    private var matchingRepos: [RepoRecord] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        guard !normalized.isEmpty else {
            return model.repos
        }

        return model.repos.filter { repo in
            repo.name.lowercased().contains(normalized) || repo.path.lowercased().contains(normalized)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("New Session")
                .font(.title2.weight(.bold))

            TextField("Find a repo", text: $query)
                .textFieldStyle(.roundedBorder)

            HSplitView {
                List(selection: $selectedRepoID) {
                    ForEach(matchingRepos) { repo in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(repo.name)
                            Text(repo.path.abbreviatedHomePath)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .tag(Optional(repo.id))
                    }
                }
                .frame(minWidth: 260)

                VStack(alignment: .leading, spacing: 12) {
                    Text("Shell-Backed Session")
                        .font(.headline)

                    Text("Each session opens a real terminal in the selected repo. You can enter and exit Claude normally inside that shell.")
                        .foregroundStyle(.secondary)

                    Toggle("Launch Claude immediately", isOn: $launchesClaudeOnStart)

                    Text("When enabled, the app starts a login shell and runs your configured Claude command for you.")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Spacer()

                    HStack {
                        Spacer()

                        Button("Cancel") {
                            model.sessionLauncherPresented = false
                            dismiss()
                        }

                        Button("Start Session") {
                            guard let selectedRepoID else {
                                return
                            }

                            model.startSession(in: selectedRepoID, launchesClaudeOnStart: launchesClaudeOnStart)
                            dismiss()
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(selectedRepoID == nil)
                    }
                }
                .padding(.leading, 16)
            }
        }
        .padding(20)
        .frame(width: 780, height: 420)
        .onAppear {
            selectedRepoID = model.launchTargetRepoID ?? model.selectedRepo?.id ?? model.repos.first?.id
        }
    }
}
