import UserNotifications
import MurageShellCore

/// Spec §3.5: fetch the detail over Tailscale within 5 s and rewrite the
/// notification; on a timeout, the expiry handler or a phone locked since
/// boot, the generic text stays. Only the detail token is read here.
final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var best: UNMutableNotificationContent?
    private var original: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        lock.lock()
        handler = contentHandler
        original = request.content
        best = request.content.mutableCopy() as? UNMutableNotificationContent
        // Only this extension's own fetch may set a tap target; one that came
        // with the push was built by the relay.
        best?.userInfo["murageTarget"] = nil
        lock.unlock()
        let group = Bundle.main.object(forInfoDictionaryKey: "MurageAppGroup") as? String ?? "group.com.murage.mobile"
        let info = request.content.userInfo
        Task {
            let out = await PushExtension.rewrite(userInfo: info, ledger: FileLedgerAccess(appGroup: group),
                                                  detailToken: { PushKeychain.read(secret: .detail, account: $0) },
                                                  fetch: Self.fetch)
            apply(out)
            deliverOnce()
        }
    }

    /// Synchronous, so the lock is never held across a suspension point.
    private func apply(_ out: PushRewrite) {
        lock.lock()
        defer { lock.unlock() }
        guard handler != nil, let best else { return }
        best.title = out.title
        best.body = out.body
        if out.silent { best.sound = nil; best.interruptionLevel = .passive }
        if let badge = out.badge { best.badge = NSNumber(value: badge) }
        if let target = out.target { best.userInfo["murageTarget"] = PushExtension.targetInfo(target) }
    }

    override func serviceExtensionTimeWillExpire() {
        deliverOnce()
    }

    private func deliverOnce() {
        lock.lock()
        let deliver = handler, content: UNNotificationContent? = best ?? original
        handler = nil
        lock.unlock()
        if let deliver, let content { deliver(content) }
    }

    private static func fetch(_ url: URL, _ token: String) async -> (Int?, Any?) {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 5
        config.timeoutIntervalForResource = 5
        config.httpCookieStorage = nil
        config.urlCache = nil
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }
        return await PushExtension.fetch(url, token, session: session)
    }
}
