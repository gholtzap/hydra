import SwiftUI

struct QuickSwitcherView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: AppModel
    @State private var query = ""

    private var matchingSessions: [SessionRecord] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        guard !normalized.isEmpty else {
            return model.sessions.sorted { $0.updatedAt > $1.updatedAt }
        }

        return model.sessions.filter { session in
            let repoName = model.repo(id: session.repoID)?.name.lowercased() ?? ""
            return session.title.lowercased().contains(normalized) || repoName.contains(normalized)
        }
    }

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
            Text("Quick Switcher")
                .font(.title2.weight(.bold))

            TextField("Search sessions or repos", text: $query)
                .textFieldStyle(.roundedBorder)

            List {
                Section("Sessions") {
                    ForEach(matchingSessions.prefix(20)) { session in
                        Button {
                            model.selection = .session(session.id)
                            dismiss()
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(session.title)
                                    Text(model.repo(id: session.repoID)?.name ?? "Unknown Repo")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                StatusBadgeView(status: session.status)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }

                Section("Repos") {
                    ForEach(matchingRepos.prefix(20)) { repo in
                        Button {
                            model.selection = .repo(repo.id)
                            dismiss()
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(repo.name)
                                Text(repo.path.abbreviatedHomePath)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .listStyle(.inset)
        }
        .padding(20)
        .frame(width: 640, height: 520)
    }
}
