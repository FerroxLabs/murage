import Foundation

public struct PushRewrite: Equatable, Sendable {
    public let title: String
    public let body: String
    public let badge: Int?
    public let target: PushTarget?
    /// N-8: the ledger lock timed out, so this push could not be checked for a
    /// stale or repeated revision. Deliver it quietly (no sound, passive) with
    /// the generic text; the app's next reconcile fixes the badge.
    public var silent: Bool = false
}

/// Spec §3.5 "Rich but private text", as a function the extension calls:
/// every failure is the generic text, which is a complete outcome.
public enum PushExtension {
    public static func rewrite(userInfo: [AnyHashable: Any], ledger: LedgerAccess, detailToken: (String) -> String?,
                               fetch: (URL, String) async -> (Int?, Any?)) async -> PushRewrite {
        guard let payload = PushPayload.parse(userInfo["murage"]) else {
            return PushRewrite(title: "Murage", body: "Your attention is needed.", badge: nil, target: nil)
        }
        let generic = payload.category.generic
        guard case let (verdict, total, origin)? = ledger.update({ l -> (PushLedger.Accept, Int, String?) in
            let verdict = l.accept(payload.bindingId, collapseKey: payload.collapseKey, revision: payload.revision, workspaceBadge: payload.workspaceBadge)
            return (verdict, l.total, l.origin(payload.bindingId))
        }) else {
            // nil is "locked since boot" (generic, still alerts) or a lock wait that
            // timed out (N-8: quiet, since a stale or repeat event cannot be told apart)
            return PushRewrite(title: generic.title, body: generic.body, badge: nil, target: nil, silent: ledger.lockTimedOut)
        }
        let plain = PushRewrite(title: generic.title, body: generic.body, badge: total, target: nil)
        guard verdict == .show, PushFeatures.richText, let origin, let token = detailToken(payload.bindingId),
              let url = detailURL(origin: origin, eventRef: payload.eventRef) else { return plain }
        let (status, body) = await fetch(url, token)
        let detail = PushOutcome.detail(status: status, body: body, category: payload.category)
        return PushRewrite(title: detail.title, body: detail.body, badge: total, target: detail.target)
    }

    /// Defence in depth, though the payload and the ledger were checked
    /// already: the origin must be a workspace origin (HTTPS, a plain host,
    /// the same rule as the shell's) and the eventRef 64 lower-case hex, the
    /// door's DETAIL_PATH. Anything else is nil, which keeps the generic text.
    static func detailURL(origin: String, eventRef: String) -> URL? {
        guard PushPattern.hex(eventRef, 64), let workspace = WorkspaceOrigin(string: origin),
              workspace.serialized == origin else { return nil }
        return workspace.url.appendingPathComponent("api/mobile/push", isDirectory: true).appendingPathComponent(eventRef)
    }

    /// The door's detail answer is under 3 KB; anything past this is not one,
    /// and the extension's memory is small.
    static let bodyCap = 64 * 1024

    /// The detail read (companion/src/push-door.ts, scope "detail"). The
    /// caller's session sets the deadline; any error is (nil, nil), and a
    /// body over the cap is (status, nil), both of which `PushOutcome.detail`
    /// turns into the generic text.
    public static func fetch(_ url: URL, _ token: String, session: URLSession) async -> (Int?, Any?) {
        await send(PushResponse.bearer("GET", url, token), session: session)
    }

    /// Any push bearer call (the detail read, the pending list, the respond
    /// action; I5): no redirect is followed, the body is capped, and every
    /// error is (nil, nil). The caller's session sets the deadline.
    public static func send(_ request: URLRequest, session: URLSession) async -> (Int?, Any?) {
        do {
            let (bytes, response) = try await session.bytes(for: request, delegate: NoRedirects())
            let status = (response as? HTTPURLResponse)?.statusCode
            guard response.expectedContentLength <= bodyCap else { bytes.task.cancel(); return (status, nil) }
            var data = Data()
            for try await byte in bytes {
                data.append(byte)
                if data.count > bodyCap { bytes.task.cancel(); return (status, nil) }
            }
            return (status, try? JSONSerialization.jsonObject(with: data))
        } catch {
            return (nil, nil)
        }
    }

    /// A 3xx comes back as the answer (not 200, so generic): the text must
    /// come from the bound workspace, and the bearer never goes anywhere else.
    final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    public static func targetInfo(_ target: PushTarget) -> [String: String] {
        var out = ["threadId": target.threadId]
        if let m = target.messageId { out["messageId"] = m }
        if let r = target.requestId { out["requestId"] = r }
        return out
    }
}
