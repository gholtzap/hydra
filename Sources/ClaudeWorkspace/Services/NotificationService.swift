import Foundation
import UserNotifications

@MainActor
final class NotificationService {
    func requestAuthorizationIfNeeded() {
        guard canUseSystemNotifications else {
            return
        }

        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
        }
    }

    func sendBlockerNotification(session: SessionRecord, repo: RepoRecord?) {
        guard canUseSystemNotifications else {
            return
        }

        guard let blocker = session.blocker else {
            return
        }

        let content = UNMutableNotificationContent()
        content.title = blocker.kind.label
        content.subtitle = repo?.name ?? session.title
        content.body = blocker.summary
        content.sound = .default

        let identifier = "blocker-\(session.id.uuidString)-\(Int(blocker.detectedAt.timeIntervalSince1970))"
        let request = UNNotificationRequest(
            identifier: identifier,
            content: content,
            trigger: nil
        )

        UNUserNotificationCenter.current().add(request)
    }

    private var canUseSystemNotifications: Bool {
        Bundle.main.bundleURL.pathExtension == "app"
    }
}
