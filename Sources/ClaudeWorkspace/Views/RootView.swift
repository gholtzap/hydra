import SwiftUI

struct RootView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        NavigationSplitView {
            SidebarView(model: model)
        } detail: {
            DetailView(model: model)
        }
        .toolbar(id: "main-toolbar") {
            ClaudeWorkspaceToolbarContent(model: model)
        }
        .sheet(isPresented: $model.quickSwitcherPresented) {
            QuickSwitcherView(model: model)
        }
        .sheet(isPresented: $model.commandPalettePresented) {
            CommandPaletteView(model: model)
        }
        .sheet(isPresented: $model.sessionLauncherPresented) {
            SessionLauncherView(model: model)
        }
    }
}

private struct SidebarView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        List(selection: $model.selection) {
            Section {
                SidebarInboxRow(count: model.inboxSessions.count)
                    .tag(SidebarSelection.inbox)
            }

            Section("Running Sessions") {
                if model.runningSessions.isEmpty {
                    Text("No live sessions")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(model.runningSessions) { session in
                        SessionSidebarRow(
                            title: session.title,
                            status: session.status,
                            hasUnread: session.hasUnread && model.preferences.showInAppBadges,
                            repoName: model.repo(id: session.repoID)?.name ?? "Unknown Repo"
                        )
                        .tag(SidebarSelection.session(session.id))
                    }
                }
            }

            ForEach(model.sortedWorkspaces) { workspace in
                Section(workspace.name) {
                    let repos = model.repos(in: workspace)

                    if repos.isEmpty {
                        Text("No git repos found")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(repos) { repo in
                            RepoSidebarRow(
                                name: repo.name,
                                path: repo.path.abbreviatedHomePath,
                                activeSessions: model.sessions(in: repo).filter(\.isLive).count
                            )
                            .tag(SidebarSelection.repo(repo.id))
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
    }
}

private struct DetailView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        switch model.selection {
        case .inbox:
            InboxView(model: model)
        case .repo(let repoID):
            if let repo = model.repo(id: repoID) {
                RepoDetailView(model: model, repo: repo)
            } else {
                EmptyDetailView(
                    title: "Repo Missing",
                    message: "This repo is no longer available."
                )
            }
        case .session(let sessionID):
            if let session = model.session(id: sessionID), let repo = model.repo(id: session.repoID) {
                SessionDetailView(model: model, session: session, repo: repo)
            } else {
                EmptyDetailView(
                    title: "Session Missing",
                    message: "This session is no longer available."
                )
            }
        }
    }
}

private struct InboxView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Inbox / Needs Attention")
                    .font(.largeTitle.weight(.bold))
                Text("Blocked sessions and unread activity across all repos.")
                    .foregroundStyle(.secondary)
            }

            if model.inboxSessions.isEmpty {
                EmptyDetailView(
                    title: "Nothing Needs Attention",
                    message: "Blocked and unread sessions will appear here."
                )
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(model.inboxSessions) { session in
                            Button {
                                model.selection = .session(session.id)
                            } label: {
                                InboxSessionCard(
                                    session: session,
                                    repo: model.repo(id: session.repoID)
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.bottom, 24)
                }
            }
        }
        .padding(24)
    }
}

private struct RepoDetailView: View {
    @ObservedObject var model: AppModel
    let repo: RepoRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(repo.name)
                        .font(.largeTitle.weight(.bold))
                    Text(repo.path.abbreviatedHomePath)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                HStack {
                    Button("Reveal in Finder") {
                        model.openRepoInFinder(repo.id)
                    }

                    Button("Rescan Workspace") {
                        model.rescanWorkspace(repo.workspaceID)
                    }

                    Button("New Session") {
                        model.presentSessionLauncher(for: repo.id)
                    }
                    .buttonStyle(.borderedProminent)
                }
            }

            if model.sessions(in: repo).isEmpty {
                EmptyDetailView(
                    title: "No Sessions Yet",
                    message: "Open a shell-backed session for this repo from the New Session button."
                )
            } else {
                List {
                    ForEach(model.sessions(in: repo)) { session in
                        Button {
                            model.selection = .session(session.id)
                        } label: {
                            RepoSessionRow(session: session)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .listStyle(.inset)
            }
        }
        .padding(24)
    }
}

private struct SessionDetailView: View {
    @ObservedObject var model: AppModel
    let session: SessionRecord
    let repo: RepoRecord

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(session.title)
                            .font(.title3.weight(.semibold))
                        StatusBadgeView(status: session.status)
                    }

                    Text(repo.path.abbreviatedHomePath)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                HStack {
                    Button("Reveal Repo") {
                        model.openRepoInFinder(repo.id)
                    }

                    Button("Claude Settings") {
                        model.openSettingsWindow()
                    }

                    if session.isLive {
                        Button("Terminate Session") {
                            model.closeSession(session.id)
                        }
                    } else {
                        Button("Restart Session") {
                            model.reopenSession(session.id)
                        }

                        Button("Close Session") {
                            model.closeSession(session.id)
                        }
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 14)

            if let blocker = session.blocker {
                Divider()

                SessionBlockerBanner(
                    blocker: blocker,
                    isLive: session.isLive,
                    approveAction: {
                        model.approveBlocker(for: session.id)
                    },
                    denyAction: {
                        model.denyBlocker(for: session.id)
                    }
                )
                .padding(.horizontal, 20)
                .padding(.vertical, 14)
            }

            Divider()

            TerminalConsoleView(
                sessionID: session.id,
                replayText: session.rawTranscript ?? session.transcript,
                isLive: session.isLive
            ) { input in
                model.sendInput(input, to: session.id)
            } onBinaryInput: { input in
                model.sendBinaryInput(input, to: session.id)
            } onResize: { columns, rows in
                model.resizeSession(session.id, columns: columns, rows: rows)
            }
            .id(session.id)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

private struct SessionInspector: View {
    @ObservedObject var model: AppModel
    let session: SessionRecord
    let repo: RepoRecord

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                GroupBox("Session") {
                    VStack(alignment: .leading, spacing: 10) {
                        MetadataRow(label: "Repo", value: repo.name)
                        MetadataRow(label: "State", value: session.isLive ? "Live" : "Stopped")
                        MetadataRow(label: "Created", value: session.createdAt.shortTimestamp)
                        MetadataRow(label: "Updated", value: session.updatedAt.shortTimestamp)
                        MetadataRow(label: "Terminal", value: session.isLive ? "Interactive PTY" : "Read Only")

                        if let stoppedAt = session.stoppedAt {
                            MetadataRow(label: "Stopped", value: stoppedAt.shortTimestamp)
                        }
                    }
                }

                GroupBox("Attention") {
                    VStack(alignment: .leading, spacing: 10) {
                        MetadataRow(label: "Unread", value: "\(session.unreadCount)")

                        if let blocker = session.blocker {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(blocker.kind.label)
                                    .font(.headline)
                                Text(blocker.summary)
                                    .foregroundStyle(.secondary)
                            }

                            if blocker.kind == .approval, session.isLive {
                                HStack {
                                    Button("Approve") {
                                        model.approveBlocker(for: session.id)
                                    }
                                    .buttonStyle(.borderedProminent)

                                    Button("Deny") {
                                        model.denyBlocker(for: session.id)
                                    }
                                }

                                Text("Approval buttons use conservative canned input. The live terminal remains the fallback.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        } else {
                            Text("No active blocker.")
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                GroupBox("Actions") {
                    VStack(alignment: .leading, spacing: 10) {
                        Button("Reveal Repo in Finder") {
                            model.openRepoInFinder(repo.id)
                        }

                        Button("Edit Claude Settings") {
                            model.openSettingsWindow()
                        }
                    }
                }

                GroupBox("Terminal") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("The session view now accepts direct keyboard input, paste, and PTY resize updates.")
                            .foregroundStyle(.secondary)

                        MetadataRow(label: "Paste", value: "Cmd-V")
                        MetadataRow(label: "Interrupt", value: "Ctrl-C")
                        MetadataRow(label: "EOF", value: "Ctrl-D")
                        MetadataRow(label: "Select All", value: "Cmd-A")
                    }
                }
            }
            .padding(16)
        }
    }
}

private struct SessionBlockerBanner: View {
    let blocker: SessionBlocker
    let isLive: Bool
    let approveAction: () -> Void
    let denyAction: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text(blocker.kind.label)
                    .font(.headline)
                Text(blocker.summary)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if blocker.kind == .approval, isLive {
                HStack(spacing: 10) {
                    Button("Approve") {
                        approveAction()
                    }
                    .buttonStyle(.borderedProminent)

                    Button("Deny") {
                        denyAction()
                    }
                }
            }
        }
        .padding(14)
        .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(.orange.opacity(0.2))
        }
    }
}

struct EmptyDetailView: View {
    let title: String
    let message: String

    var body: some View {
        VStack(alignment: .center, spacing: 10) {
            Text(title)
                .font(.title2.weight(.semibold))
            Text(message)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct SidebarInboxRow: View {
    let count: Int

    var body: some View {
        HStack {
            Label("Inbox / Needs Attention", systemImage: "tray.full")
            Spacer()

            if count > 0 {
                Text("\(count)")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.red.opacity(0.16), in: Capsule())
                    .foregroundStyle(.red)
            }
        }
    }
}

private struct SessionSidebarRow: View {
    let title: String
    let status: SessionStatus
    let hasUnread: Bool
    let repoName: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title)
                    .lineLimit(1)
                Spacer()

                if hasUnread {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 8, height: 8)
                }
            }

            HStack {
                Text(repoName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                StatusBadgeView(status: status)
            }
        }
        .contentShape(Rectangle())
    }
}

private struct RepoSidebarRow: View {
    let name: String
    let path: String
    let activeSessions: Int

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .lineLimit(1)
                Text(path)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            if activeSessions > 0 {
                Text("\(activeSessions)")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.blue.opacity(0.14), in: Capsule())
                    .foregroundStyle(.blue)
            }
        }
        .contentShape(Rectangle())
    }
}

private struct InboxSessionCard: View {
    let session: SessionRecord
    let repo: RepoRecord?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(session.title)
                    .font(.headline)
                Spacer()
                StatusBadgeView(status: session.status)
            }

            Text(repo?.name ?? "Unknown Repo")
                .foregroundStyle(.secondary)

            if let blocker = session.blocker {
                Text(blocker.summary)
                    .font(.subheadline)
            }

            HStack {
                Text(session.updatedAt.shortTimestamp)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()

                if session.hasUnread {
                    Text("\(session.unreadCount) unread")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                }
            }
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

private struct RepoSessionRow: View {
    let session: SessionRecord

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(session.title)
                    .lineLimit(1)

                Text(session.updatedAt.shortTimestamp)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if session.hasUnread {
                Text("\(session.unreadCount)")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.accentColor.opacity(0.14), in: Capsule())
            }

            StatusBadgeView(status: session.status)
        }
        .padding(.vertical, 4)
    }
}

private struct MetadataRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .multilineTextAlignment(.trailing)
        }
    }
}
