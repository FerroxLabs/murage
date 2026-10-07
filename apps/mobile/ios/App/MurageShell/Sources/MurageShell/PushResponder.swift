#if os(iOS)
import UIKit
import UserNotifications
import MurageShellCore

/// Spec §3.5 "Lock-screen actions", "Tapping a notification", "Badge and
/// reconciliation" and §7 "Lock-screen action can't reach the host". The
/// flows are PushResponse (MurageShellCore, tested on fakes); this is the
/// UIKit and UserNotifications glue around them.
@MainActor final class PushResponder: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushResponder()
    private var reconciling = false

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completion: @escaping (UNNotificationPresentationOptions) -> Void) {
        let resolved = PushPayload.parse(notification.request.content.userInfo["murage"])?.category == .resolved
        completion(resolved ? [.list, .badge] : [.banner, .list, .badge, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completion: @escaping () -> Void) {
        Task { @MainActor in
            await self.handle(response)
            completion()
        }
    }

    private func handle(_ response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let payload = PushPayload.parse(info["murage"]) else { ShellLog.event("push tap unreadable", persist: true); return }
        let ledger = PushServices.shared.ledger.read()
        guard let origin = PushResponse.origin(ledger?.origin(payload.bindingId)) else {
            ShellLog.event("push tap no workspace", persist: true)
            ShellCoordinator.shared.showNotice(code: "removedWorkspace")
            return
        }
        let detailToken = { PushKeychain.read(secret: .detail, account: payload.bindingId) }
        switch PushResponse.action(response.actionIdentifier) {
        case .answer(let decision):
            // The action ran with the phone unlocked (.authenticationRequired),
            // so the app-only respond token reads; the work may outlast the
            // moment the app is woken for.
            var task = UIBackgroundTaskIdentifier.invalid
            task = UIApplication.shared.beginBackgroundTask(withName: "murage.respond") {
                UIApplication.shared.endBackgroundTask(task)
                task = .invalid
            }
            let notice = await PushResponse.answer(payload: payload, origin: origin, decision: decision, detailToken: detailToken,
                                                   respondToken: { PushKeychain.read(secret: .respond, account: payload.bindingId) },
                                                   send: Self.send)
            ShellLog.event("push action answered", persist: true)
            await postNotice(notice, for: response.notification)
            if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
        case .open:
            let target = await PushResponse.open(payload: payload, origin: origin, userInfo: info, detailToken: detailToken, send: Self.send)
            ShellLog.event(target == nil ? "push tap open without thread" : "push tap open thread", persist: true)
            ShellCoordinator.shared.openFromNotification(origin: origin, threadId: target?.threadId, messageId: target?.messageId)
        }
    }

    /// Replaces the notification it answers (same identifier), keeping its
    /// payload so a tap still opens the right chat.
    private func postNotice(_ notice: PushNotice, for original: UNNotification) async {
        let content = UNMutableNotificationContent()
        content.title = notice.text.title
        content.body = notice.text.body
        content.userInfo = original.request.content.userInfo
        content.threadIdentifier = original.request.content.threadIdentifier
        content.categoryIdentifier = [.approved, .denied, .alreadyAnswered].contains(notice) ? "DONE" : "QUESTION"
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: original.request.identifier, content: content, trigger: nil))
    }

    /// When the app opens (PushSetup.becameActive). One pass at a time: the
    /// scene becomes active again after every Face ID sheet.
    func reconcile() async {
        guard !reconciling else { return }
        reconciling = true
        defer { reconciling = false }
        let center = UNUserNotificationCenter.current()
        let delivered = await center.deliveredNotifications().map {
            PushResponse.Delivered(identifier: $0.request.identifier, userInfo: $0.request.content.userInfo)
        }
        let out = await PushResponse.reconcile(ledger: PushServices.shared.ledger, delivered: delivered,
                                               detailToken: { PushKeychain.read(secret: .detail, account: $0) },
                                               keep: { await MainActor.run { PushRegistrar.shared.pendingBindingIds } }, send: Self.send)
        if !out.remove.isEmpty { center.removeDeliveredNotifications(withIdentifiers: out.remove) }
        if let total = out.total { try? await center.setBadgeCount(total) }
    }

    /// Every push bearer call from the app: its own ephemeral session (no
    /// cookies, no cache), 5 s for a read and 10 s for the respond POST, and
    /// no redirects or oversized bodies (PushExtension.send), so the tokens
    /// go only to the bound computer. Nothing is logged but the status.
    private static func send(_ request: URLRequest) async -> (Int?, Any?) {
        let seconds: TimeInterval = request.httpMethod == "POST" ? 10 : 5
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = seconds
        config.timeoutIntervalForResource = seconds
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCache = nil
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }
        let out = await PushExtension.send(request, session: session)
        ShellLog.event("push call answered", status: out.0 ?? 0)
        return out
    }
}
#endif
