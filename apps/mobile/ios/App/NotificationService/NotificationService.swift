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
    private var shownCalls: [String] = []
    private let appGroup = Bundle.main.object(forInfoDictionaryKey: "MurageAppGroup") as? String ?? "group.com.murage.mobile"

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        lock.lock()
        handler = contentHandler
        original = request.content
        best = request.content.mutableCopy() as? UNMutableNotificationContent
        // Only this extension's own fetch may set a tap target; one that came
        // with the push was built by the relay.
        best?.userInfo["murageTarget"] = nil
        // Set a closed, quiet fallback before any async work. If the OS ends
        // the extension early, it cannot reveal a preview or ring unchecked.
        let raw = (request.content.userInfo["murage"] as? [String: Any])?["category"] as? String
        if let category = raw.flatMap(PushCategory.init(rawValue:)),
           category.isExpiring || category == .resolved, let best {
            let text = category.generic
            PushNotificationContent.apply(PushRewrite(title: text.title, body: text.body, badge: nil, target: nil, silent: true),
                                          payload: PushPayload.parse(request.content.userInfo["murage"]), to: best)
        }
        lock.unlock()
        let info = request.content.userInfo
        Task {
            let center = UNUserNotificationCenter.current()
            // The async form of getDeliveredNotifications includes calls already on screen.
            let delivered = await center.deliveredNotifications().map {
                PushResponse.Delivered(identifier: $0.request.identifier, userInfo: $0.request.content.userInfo)
            }
            let shown = PushResponse.deliveredCallKeys(delivered)
            let out = await PushExtension.rewrite(userInfo: info, ledger: FileLedgerAccess(appGroup: appGroup),
                                                  detailToken: { PushKeychain.read(secret: .detail, account: $0) },
                                                  shown: shown,
                                                  fetch: Self.fetch)
            if let payload = PushPayload.parse(info["murage"]), payload.category == .resolved {
                // A ring may have arrived while rewrite was suspended.
                let fresh = await center.deliveredNotifications().map {
                    PushResponse.Delivered(identifier: $0.request.identifier, userInfo: $0.request.content.userInfo)
                }
                let remove = PushResponse.resolvedCallNotifications(payload, delivered: fresh)
                if !remove.isEmpty { center.removeDeliveredNotifications(withIdentifiers: remove) }
            }
            apply(out, shown: shown)
            deliverOnce()
        }
    }

    /// Synchronous, so the lock is never held across a suspension point.
    private func apply(_ out: PushRewrite, shown: [String]) {
        lock.lock()
        defer { lock.unlock() }
        guard handler != nil, let best else { return }
        shownCalls = shown
        PushNotificationContent.apply(out, payload: PushPayload.parse(best.userInfo["murage"]), to: best, shown: shown)
    }

    override func serviceExtensionTimeWillExpire() {
        deliverOnce()
    }

    private func deliverOnce() {
        lock.lock()
        if let best, let payload = PushPayload.parse(best.userInfo["murage"]),
           PushExtension.callNeedsQuietDelivery(payload, ledger: FileLedgerAccess(appGroup: appGroup),
                                                now: Int64(Date().timeIntervalSince1970 * 1000), shown: shownCalls) {
            let text = payload.category.generic
            PushNotificationContent.apply(PushRewrite(title: text.title, body: text.body, badge: nil, target: nil, silent: true),
                                          payload: payload, to: best, shown: shownCalls)
        }
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
