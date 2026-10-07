import Foundation

/// Spec §3.5 "Lock-screen actions", "Tapping a notification" and "Badge and
/// reconciliation", and §7 "Lock-screen action can't reach the host", as
/// functions the app's PushResponder calls. The network is a parameter, so
/// the tests run on fakes.
public enum PushResponse {
    public typealias Send = (URLRequest) async -> (Int?, Any?)

    /// What a notification response asks for: APPROVE and DENY answer; a
    /// tap (the default action) and OPEN open the chat.
    public enum Action: Equatable, Sendable {
        case answer(decision: String)
        case open
    }

    public static func action(_ identifier: String) -> Action {
        switch identifier {
        case "APPROVE": .answer(decision: "allow")
        case "DENY": .answer(decision: "deny")
        default: .open
        }
    }

    /// The ledger's origin for a binding, only in the canonical form the
    /// ledger stores (I3's review): anything else is not a computer the
    /// phone paired with, and no bearer goes to it.
    public static func origin(_ text: String?) -> WorkspaceOrigin? {
        guard let text, let origin = WorkspaceOrigin(string: text), origin.serialized == text else { return nil }
        return origin
    }

    static let respondPath = "/api/mobile/push/respond"
    static let pendingPath = "/api/mobile/push/pending"

    static func bearer(_ method: String, _ url: URL, _ token: String) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    /// The door's respond body (shared/mobile-push.ts parseRespondBody):
    /// exactly these three keys, a requestId of 1 to 256 characters with no
    /// control characters, allow or deny, and a revision of at least 1.
    public static func respondRequest(origin: WorkspaceOrigin, token: String, requestId: String, decision: String, revision: Int) -> URLRequest? {
        guard PushPattern.token(token, prefix: "murage_pr_"), validRequestId(requestId),
              decision == "allow" || decision == "deny", revision >= 1,
              let url = URL(string: origin.serialized + respondPath),
              let body = try? JSONSerialization.data(withJSONObject: ["requestId": requestId, "decision": decision, "revision": revision] as [String: Any],
                                                     options: [.sortedKeys]) else { return nil }
        var request = bearer("POST", url, token)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return request
    }

    public static func pendingRequest(origin: WorkspaceOrigin, token: String) -> URLRequest? {
        guard PushPattern.token(token, prefix: "murage_pd_"), let url = URL(string: origin.serialized + pendingPath) else { return nil }
        return bearer("GET", url, token)
    }

    public static func detailRequest(origin: WorkspaceOrigin, eventRef: String, token: String) -> URLRequest? {
        guard PushPattern.token(token, prefix: "murage_pd_"),
              let url = PushExtension.detailURL(origin: origin.serialized, eventRef: eventRef) else { return nil }
        return bearer("GET", url, token)
    }

    static func validRequestId(_ id: String) -> Bool {
        (1...256).contains(id.utf16.count) && !id.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f }
    }

    /// Approve or Deny. The request comes fresh from the bound computer's
    /// detail read, never from the notification's userInfo: the extension
    /// only writes a target when its own fetch worked, and anything else
    /// there came with the push, which the relay built. Every path is a
    /// notice, so an action never fails silently (Review Focus 4).
    public static func answer(payload: PushPayload, origin: WorkspaceOrigin, decision: String,
                              detailToken: () -> String?, respondToken: () -> String?, send: Send) async -> PushNotice {
        guard payload.category == .approval || payload.category == .approvalOpen else { return .openApp }
        // APPROVAL_OPEN offers no Approve (PushCategories); the host would refuse it too.
        if decision == "allow", payload.category == .approvalOpen { return .stepUp }
        // The respond token first, while the phone is surely unlocked: the
        // detail read can take seconds, and the phone may lock meanwhile.
        guard let respond = respondToken() else { return .openApp }
        guard let token = detailToken(), let read = detailRequest(origin: origin, eventRef: payload.eventRef, token: token) else { return .openApp }
        let (status, body) = await send(read)
        guard let status, status < 500 else { return .unreachable }
        guard let requestId = PushOutcome.detail(status: status, body: body, category: payload.category).target?.requestId else { return .openApp }
        guard let request = respondRequest(origin: origin, token: respond, requestId: requestId, decision: decision, revision: payload.revision) else { return .openApp }
        let (answerStatus, answerBody) = await send(request)
        return PushOutcome.notice(status: answerStatus, body: answerBody, decision: decision)
    }

    /// The target the extension saved on the notification (PushExtension.targetInfo).
    /// A tap only chooses which chat opens inside the bound computer.
    public static func tapTarget(userInfo: [AnyHashable: Any]) -> PushTarget? {
        guard let d = userInfo["murageTarget"] as? [String: String], let thread = d["threadId"], OpenHash.valid(thread) else { return nil }
        let message = d["messageId"].flatMap { OpenHash.valid($0) ? $0 : nil }
        return PushTarget(threadId: thread, messageId: message, requestId: nil)
    }

    /// A tap: the saved target, else one detail read; nil opens the computer
    /// at its last chat.
    public static func open(payload: PushPayload, origin: WorkspaceOrigin, userInfo: [AnyHashable: Any],
                            detailToken: () -> String?, send: Send) async -> PushTarget? {
        if let saved = tapTarget(userInfo: userInfo) { return saved }
        guard let token = detailToken(), let read = detailRequest(origin: origin, eventRef: payload.eventRef, token: token) else { return nil }
        let (status, body) = await send(read)
        guard let target = PushOutcome.detail(status: status, body: body, category: payload.category).target, OpenHash.valid(target.threadId) else { return nil }
        return PushTarget(threadId: target.threadId, messageId: target.messageId.flatMap { OpenHash.valid($0) ? $0 : nil }, requestId: nil)
    }

    /// The pending list (server/mobile-push-outbox.ts `pending`): the
    /// workspace's count and what is still waiting. nil for anything else.
    public static func pending(status: Int?, body: Any?) -> (badge: Int, items: [(String, Int)])? {
        guard status == 200, let b = body as? [String: Any], let badge = ChannelArgs.int(b["badge"]),
              let items = b["items"] as? [[String: Any]], items.count <= PushLedger.seenLimit else { return nil }
        let pending = items.compactMap { item -> (String, Int)? in
            guard let key = item["collapseKey"] as? String, PushPattern.hex(key, 32),
                  let revision = ChannelArgs.int(item["revision"]), revision >= 1 else { return nil }
            return (key, revision)
        }
        return (badge, pending)
    }

    public struct Delivered {
        public let identifier: String
        public let userInfo: [AnyHashable: Any]
        public init(identifier: String, userInfo: [AnyHashable: Any]) {
            self.identifier = identifier
            self.userInfo = userInfo
        }
    }

    /// The delivered Murage notifications that belong to any of `bindings`
    /// (a forgotten, retired or swept binding: PushServices). Anything that
    /// is not a Murage payload is never touched.
    public static func delivered(_ delivered: [Delivered], of bindings: Set<String>) -> [String] {
        guard !bindings.isEmpty else { return [] }
        return delivered.compactMap { note in
            guard let p = PushPayload.parse(note.userInfo["murage"]), bindings.contains(p.bindingId) else { return nil }
            return note.identifier
        }
    }

    /// The delivered Murage notifications whose binding the phone no longer
    /// holds: neither in the ledger nor waiting in a replace (`keep`). Their
    /// tokens are gone, so a tap or an action could only fail (Android:
    /// PushReconciler's unbound sweep).
    public static func unbound(_ delivered: [Delivered], bound: Set<String>, keep: Set<String>) -> [String] {
        delivered.compactMap { note in
            guard let p = PushPayload.parse(note.userInfo["murage"]),
                  !bound.contains(p.bindingId), !keep.contains(p.bindingId) else { return nil }
            return note.identifier
        }
    }

    /// When the app opens: each workspace's pending list removes what was
    /// answered elsewhere and corrects its count; the badge is their sum.
    /// A workspace that cannot be read keeps what it had. Notifications of a
    /// binding the phone no longer holds go too; `keep` names the bindings a
    /// replace is still waiting on, read at the end, together with the
    /// ledger, so a replace adopted meanwhile is never swept. Returns the
    /// delivered notifications to remove and the new total (nil when the
    /// ledger cannot be read).
    public static func reconcile(ledger: LedgerAccess, delivered: [Delivered], detailToken: (String) -> String?,
                                 keep: () async -> Set<String> = { [] }, send: Send) async -> (remove: [String], total: Int?) {
        guard let current = ledger.read() else { return ([], nil) }
        var remove: [String] = []
        for binding in current.bindingIds {
            guard let origin = origin(current.origin(binding)), let token = detailToken(binding),
                  let request = pendingRequest(origin: origin, token: token) else { continue }
            let (status, body) = await send(request)
            guard let answer = pending(status: status, body: body) else { continue }
            let mine = delivered.compactMap { note -> (String, String)? in
                guard let p = PushPayload.parse(note.userInfo["murage"]), p.bindingId == binding else { return nil }
                return (note.identifier, p.collapseKey)
            }
            let gone = ledger.update { $0.reconcile(binding, badge: answer.badge, pending: answer.items, shown: mine.map(\.1)) } ?? []
            remove += mine.filter { gone.contains($0.1) }.map(\.0)
        }
        // The waiting replaces first, then the ledger: a replace adopted in
        // between is in the ledger by then, so it is never swept.
        let kept = await keep()
        guard let after = ledger.read() else { return (remove, nil) }
        remove += unbound(delivered, bound: Set(after.bindingIds), keep: kept).filter { !remove.contains($0) }
        return (remove, after.total)
    }
}
