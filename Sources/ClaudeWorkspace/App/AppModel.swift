import AppKit
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published var workspaces: [WorkspaceRecord]
    @Published var repos: [RepoRecord]
    @Published var sessions: [SessionRecord]
    @Published var preferences: AppPreferences {
        didSet {
            scheduleSave()
        }
    }
    @Published var selection: SidebarSelection = .inbox {
        didSet {
            handleSelectionChange()
        }
    }
    @Published var quickSwitcherPresented = false
    @Published var commandPalettePresented = false
    @Published var sessionLauncherPresented = false
    @Published var launchTargetRepoID: UUID?
    @Published var lastErrorMessage: String?

    private let persistence = PersistenceController()
    private let notificationService = NotificationService()
    private var runtimes: [UUID: SessionRuntime] = [:]
    private var terminalBuffers: [UUID: TerminalTranscriptBuffer] = [:]
    private var saveTask: Task<Void, Never>?
    private var inactivityTimer: Timer?

    init() {
        let snapshot = persistence.load()
        workspaces = snapshot.workspaces.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        repos = snapshot.repos.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        sessions = snapshot.sessions.sorted { $0.updatedAt > $1.updatedAt }
        preferences = snapshot.preferences
        normalizeRestoredSessions()
        notificationService.requestAuthorizationIfNeeded()
        startInactivityTimer()
    }

    var liveSessionCount: Int {
        sessions.filter(\.isLive).count
    }

    var hasLiveSessions: Bool {
        liveSessionCount > 0
    }

    var runningSessions: [SessionRecord] {
        sessions
            .filter(\.isLive)
            .sorted(by: runningSessionSort)
    }

    var inboxSessions: [SessionRecord] {
        sessions
            .filter { $0.blocker != nil || $0.hasUnread }
            .sorted(by: inboxSessionSort)
    }

    var sortedWorkspaces: [WorkspaceRecord] {
        workspaces.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    var selectedRepo: RepoRecord? {
        switch selection {
        case .inbox:
            return nil
        case .repo(let repoID):
            return repo(id: repoID)
        case .session(let sessionID):
            guard let session = session(id: sessionID) else {
                return nil
            }
            return repo(id: session.repoID)
        }
    }

    var claudeSettingsContext: ClaudeSettingsContext {
        ClaudeSettingsService.context(for: selectedRepo)
    }

    func repos(in workspace: WorkspaceRecord) -> [RepoRecord] {
        repos
            .filter { $0.workspaceID == workspace.id }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    func sessions(in repo: RepoRecord) -> [SessionRecord] {
        sessions
            .filter { $0.repoID == repo.id }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    func repo(id: UUID) -> RepoRecord? {
        repos.first { $0.id == id }
    }

    func session(id: UUID) -> SessionRecord? {
        sessions.first { $0.id == id }
    }

    func openWorkspaceFolderPanel() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.prompt = "Open Workspace"

        guard panel.runModal() == .OK, let url = panel.url else {
            return
        }

        addWorkspace(at: url)
    }

    func createProjectFolderPanel() {
        let panel = NSSavePanel()
        panel.canCreateDirectories = true
        panel.nameFieldStringValue = "New Project"
        panel.prompt = "Create Folder"
        panel.title = "Create Empty Project Folder"

        guard panel.runModal() == .OK, let url = panel.url else {
            return
        }

        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            addWorkspace(at: url)
        } catch {
            present(error: error)
        }
    }

    func addWorkspace(at url: URL) {
        let normalizedURL = url.standardizedFileURL
        let path = normalizedURL.normalizedFileSystemPath

        if let existingWorkspace = workspaces.first(where: { $0.rootPath == path }) {
            rescanWorkspace(existingWorkspace.id)
            return
        }

        let workspace = WorkspaceRecord(
            id: UUID(),
            name: normalizedURL.lastPathComponent.isEmpty ? path : normalizedURL.lastPathComponent,
            rootPath: path,
            createdAt: .now
        )

        workspaces.append(workspace)
        rescanWorkspace(workspace.id)
        scheduleSave()
    }

    func rescanWorkspace(_ workspaceID: UUID) {
        guard let workspace = workspaces.first(where: { $0.id == workspaceID }) else {
            return
        }

        let scannedRepos = WorkspaceScanner.scan(
            rootURL: URL(fileURLWithPath: workspace.rootPath, isDirectory: true),
            workspaceID: workspaceID
        )

        let existingReposByPath = Dictionary(uniqueKeysWithValues: repos.map { ($0.path, $0) })
        let mergedRepos = scannedRepos.map { existingReposByPath[$0.path] ?? $0 }
        let otherRepos = repos.filter { $0.workspaceID != workspaceID }
        repos = (otherRepos + mergedRepos).sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

        if selection == .inbox, let firstRepo = mergedRepos.first {
            selection = .repo(firstRepo.id)
        }

        scheduleSave()
    }

    func presentSessionLauncher(for repoID: UUID? = nil) {
        launchTargetRepoID = repoID
        sessionLauncherPresented = true
    }

    func startSession(in repoID: UUID, launchesClaudeOnStart: Bool) {
        guard let repo = repo(id: repoID) else {
            return
        }

        let now = Date.now
        let session = SessionRecord(
            id: UUID(),
            repoID: repoID,
            title: inferredTitle(for: repo, launchesClaudeOnStart: launchesClaudeOnStart),
            initialPrompt: "",
            launchesClaudeOnStart: launchesClaudeOnStart,
            status: .running,
            runtimeState: .live,
            blocker: nil,
            unreadCount: 0,
            createdAt: now,
            updatedAt: now,
            lastActivityAt: nil,
            stoppedAt: nil,
            launchCount: 1,
            transcript: "",
            rawTranscript: nil
        )

        sessions.insert(session, at: 0)
        selection = .session(session.id)
        sessionLauncherPresented = false
        launchTargetRepoID = nil
        launchRuntime(for: session.id, in: repo)
        scheduleSave()
    }

    func reopenSession(_ sessionID: UUID) {
        guard
            let repo = session(id: sessionID).flatMap({ repo(id: $0.repoID) }),
            let index = sessions.firstIndex(where: { $0.id == sessionID })
        else {
            return
        }

        sessions[index].runtimeState = .live
        sessions[index].status = .running
        sessions[index].blocker = nil
        sessions[index].stoppedAt = nil
        sessions[index].launchCount += 1
        sessions[index].updatedAt = .now
        let resumeBanner = "[Session reopened \(Date.now.shortTimestamp)]"
        sessions[index].transcript += "\n\n\(resumeBanner)\n\n"
        sessions[index].rawTranscript = trimmedRawTranscript((sessions[index].rawTranscript ?? "") + "\r\n\(resumeBanner)\r\n")
        selection = .session(sessionID)
        launchRuntime(for: sessionID, in: repo)
        scheduleSave()
    }

    func closeSession(_ sessionID: UUID) {
        runtimes[sessionID]?.stop()
        runtimes.removeValue(forKey: sessionID)

        let fallbackRepoID = session(id: sessionID)?.repoID
        sessions.removeAll { $0.id == sessionID }
        terminalBuffers.removeValue(forKey: sessionID)

        if case .session(let selectedSessionID) = selection, selectedSessionID == sessionID {
            if let fallbackRepoID {
                selection = .repo(fallbackRepoID)
            } else {
                selection = .inbox
            }
        }

        scheduleSave()
    }

    func sendInput(_ text: String, to sessionID: UUID) {
        guard let runtime = runtimes[sessionID], !text.isEmpty else {
            return
        }

        runtime.send(text)

        if let index = sessions.firstIndex(where: { $0.id == sessionID }) {
            sessions[index].status = .running
            sessions[index].blocker = nil
            sessions[index].updatedAt = .now
        }

        scheduleSave()
    }

    func sendBinaryInput(_ text: String, to sessionID: UUID) {
        guard let runtime = runtimes[sessionID], !text.isEmpty else {
            return
        }

        runtime.sendBinary(text)

        if let index = sessions.firstIndex(where: { $0.id == sessionID }) {
            sessions[index].status = .running
            sessions[index].blocker = nil
            sessions[index].updatedAt = .now
        }

        scheduleSave()
    }

    func resizeSession(_ sessionID: UUID, columns: Int, rows: Int) {
        guard let runtime = runtimes[sessionID] else {
            return
        }

        let clampedColumns = max(1, min(columns, Int(UInt16.max)))
        let clampedRows = max(1, min(rows, Int(UInt16.max)))
        runtime.resize(columns: UInt16(clampedColumns), rows: UInt16(clampedRows))
    }

    func approveBlocker(for sessionID: UUID) {
        sendInput("1\r", to: sessionID)
    }

    func denyBlocker(for sessionID: UUID) {
        sendInput("3\r", to: sessionID)
    }

    func nextUnreadSession() {
        guard let nextSession = inboxSessions.first else {
            return
        }

        selection = .session(nextSession.id)
    }

    func openRepoInFinder(_ repoID: UUID) {
        guard let repo = repo(id: repoID) else {
            return
        }

        NSWorkspace.shared.open(URL(fileURLWithPath: repo.path, isDirectory: true))
    }

    func openSettingsWindow() {
        NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
    }

    func prepareForTermination() {
        let now = Date.now

        for runtime in runtimes.values {
            runtime.stop()
        }

        runtimes.removeAll()

        for index in sessions.indices {
            guard sessions[index].runtimeState == .live else {
                continue
            }

            sessions[index].runtimeState = .stopped
            sessions[index].stoppedAt = now

            if sessions[index].status == .running {
                sessions[index].status = .idle
            }
        }

        persistNow()
    }

    private func launchRuntime(for sessionID: UUID, in repo: RepoRecord) {
        do {
            terminalBuffers[sessionID] = TerminalTranscriptBuffer(seedText: session(id: sessionID)?.transcript ?? "")
            let runtime = try SessionRuntime(
                sessionID: sessionID,
                executablePath: preferences.resolvedShellExecutablePath,
                arguments: ["-l"],
                currentDirectoryURL: URL(fileURLWithPath: repo.path, isDirectory: true)
            )

            runtime.onOutput = { [weak self] data in
                self?.handleOutput(data, sessionID: sessionID)
            }

            runtime.onExit = { [weak self] exitCode in
                self?.handleExit(exitCode, sessionID: sessionID)
            }

            try runtime.start()
            runtimes[sessionID] = runtime

            if session(id: sessionID)?.shouldLaunchClaudeOnStart == true {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                    guard let self else {
                        return
                    }

                    self.sendInput(self.claudeLaunchCommand, to: sessionID)
                }
            }
        } catch {
            present(error: error)
            handleFailedLaunch(for: sessionID, error: error)
        }
    }

    private func handleOutput(_ data: Data, sessionID: UUID) {
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else {
            return
        }

        let rawChunk = String(decoding: data, as: UTF8.self)
        let buffer = terminalBuffer(for: sessionID, seedText: sessions[index].transcript)
        let visibleChunk = SessionSignalDetector.sanitize(rawChunk)

        guard !visibleChunk.isEmpty || !rawChunk.isEmpty else {
            return
        }

        let wasSelected = selection == .session(sessionID)
        sessions[index].rawTranscript = trimmedRawTranscript((sessions[index].rawTranscript ?? "") + rawChunk)
        sessions[index].transcript = buffer.consume(rawChunk)
        sessions[index].updatedAt = .now
        sessions[index].lastActivityAt = .now

        if !wasSelected {
            sessions[index].unreadCount += 1
        }

        if let signal = SessionSignalDetector.detect(from: visibleChunk) {
            let previousBlocker = sessions[index].blocker
            sessions[index].status = signal.status
            sessions[index].blocker = signal.blocker

            if
                preferences.notificationsEnabled,
                preferences.showNativeNotifications,
                !wasSelected,
                let blocker = signal.blocker,
                blocker != previousBlocker
            {
                notificationService.sendBlockerNotification(
                    session: sessions[index],
                    repo: repo(id: sessions[index].repoID)
                )
            }
        } else if sessions[index].blocker == nil {
            sessions[index].status = .running
        }

        scheduleSave()
    }

    private func handleExit(_ exitCode: Int32, sessionID: UUID) {
        runtimes.removeValue(forKey: sessionID)

        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else {
            return
        }

        let wasSelected = selection == .session(sessionID)
        sessions[index].runtimeState = .stopped
        sessions[index].stoppedAt = .now
        sessions[index].updatedAt = .now

        if exitCode == 0 {
            if sessions[index].status == .running || sessions[index].status == .idle {
                sessions[index].status = .done
                sessions[index].blocker = nil
            }
        } else {
            sessions[index].status = .failed
            sessions[index].blocker = SessionBlocker(
                kind: .crashed,
                summary: "The session shell exited with status \(exitCode).",
                detectedAt: .now
            )

            if preferences.notificationsEnabled, preferences.showNativeNotifications, !wasSelected {
                notificationService.sendBlockerNotification(
                    session: sessions[index],
                    repo: repo(id: sessions[index].repoID)
                )
            }
        }

        if !wasSelected {
            sessions[index].unreadCount += 1
        }

        scheduleSave()
    }

    private func handleFailedLaunch(for sessionID: UUID, error: Error) {
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else {
            return
        }

        sessions[index].runtimeState = .stopped
        sessions[index].status = .failed
        sessions[index].blocker = SessionBlocker(
            kind: .crashed,
            summary: "The session shell failed to start: \(error.localizedDescription)",
            detectedAt: .now
        )
        sessions[index].stoppedAt = .now
        scheduleSave()
    }

    private func inferredTitle(for repo: RepoRecord, launchesClaudeOnStart: Bool) -> String {
        let ordinal = sessions.filter { $0.repoID == repo.id }.count + 1
        let prefix = launchesClaudeOnStart ? "Claude" : "Shell"
        return "\(prefix) \(ordinal)"
    }

    private var claudeLaunchCommand: String {
        let trimmed = preferences.claudeExecutablePath.trimmingCharacters(in: .whitespacesAndNewlines)
        let command = trimmed.isEmpty ? "claude" : trimmed
        return command + "\r"
    }

    private func normalizeRestoredSessions() {
        for index in sessions.indices {
            if sessions[index].runtimeState == .live {
                sessions[index].runtimeState = .stopped
                sessions[index].stoppedAt = .now

                if sessions[index].status == .running {
                    sessions[index].status = .idle
                }
            }
        }
    }

    private func handleSelectionChange() {
        guard case .session(let sessionID) = selection else {
            return
        }

        clearUnread(for: sessionID)
    }

    private func clearUnread(for sessionID: UUID) {
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else {
            return
        }

        sessions[index].unreadCount = 0
        scheduleSave()
    }

    private func startInactivityTimer() {
        inactivityTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.refreshLiveSessionState()
            }
        }
    }

    private func refreshLiveSessionState() {
        let now = Date.now
        var didChange = false

        for index in sessions.indices {
            guard sessions[index].isLive, sessions[index].blocker == nil else {
                continue
            }

            guard let lastActivityAt = sessions[index].lastActivityAt else {
                continue
            }

            let newStatus: SessionStatus = now.timeIntervalSince(lastActivityAt) > 30 ? .idle : .running

            if sessions[index].status != newStatus {
                sessions[index].status = newStatus
                didChange = true
            }
        }

        if didChange {
            scheduleSave()
        }
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            await MainActor.run {
                self?.persistNow()
            }
        }
    }

    private func persistNow() {
        do {
            try persistence.save(
                AppStateSnapshot(
                    workspaces: workspaces,
                    repos: repos,
                    sessions: sessions,
                    preferences: preferences
                )
            )
        } catch {
            lastErrorMessage = error.localizedDescription
        }
    }

    private func present(error: Error) {
        lastErrorMessage = error.localizedDescription
    }

    private func terminalBuffer(for sessionID: UUID, seedText: String) -> TerminalTranscriptBuffer {
        if let existingBuffer = terminalBuffers[sessionID] {
            return existingBuffer
        }

        let buffer = TerminalTranscriptBuffer(seedText: seedText)
        terminalBuffers[sessionID] = buffer
        return buffer
    }

    private func trimmedRawTranscript(_ transcript: String) -> String {
        let limit = 400_000

        guard transcript.count > limit else {
            return transcript
        }

        let startIndex = transcript.index(transcript.endIndex, offsetBy: -limit)
        return String(transcript[startIndex...])
    }

    private func runningSessionSort(lhs: SessionRecord, rhs: SessionRecord) -> Bool {
        let lhsPriority = (lhs.blocker != nil ? 0 : 1, lhs.updatedAt)
        let rhsPriority = (rhs.blocker != nil ? 0 : 1, rhs.updatedAt)

        if lhsPriority.0 != rhsPriority.0 {
            return lhsPriority.0 < rhsPriority.0
        }

        return lhsPriority.1 > rhsPriority.1
    }

    private func inboxSessionSort(lhs: SessionRecord, rhs: SessionRecord) -> Bool {
        let lhsPriority = (
            lhs.blocker == nil ? 1 : 0,
            lhs.hasUnread ? 0 : 1,
            lhs.updatedAt
        )
        let rhsPriority = (
            rhs.blocker == nil ? 1 : 0,
            rhs.hasUnread ? 0 : 1,
            rhs.updatedAt
        )

        if lhsPriority.0 != rhsPriority.0 {
            return lhsPriority.0 < rhsPriority.0
        }

        if lhsPriority.1 != rhsPriority.1 {
            return lhsPriority.1 < rhsPriority.1
        }

        return lhsPriority.2 > rhsPriority.2
    }
}
