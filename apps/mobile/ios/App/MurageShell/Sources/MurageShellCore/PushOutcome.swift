import Foundation

/// Twin of PushOutcome.java; oracle apps/mobile/src/push-outcome.ts.
public struct PushTarget: Equatable, Sendable {
    public let threadId: String
    public let messageId: String?
    public let requestId: String?
}

public struct PushDetail: Equatable, Sendable {
    public let title: String
    public let body: String
    public let target: PushTarget?
}

public enum PushNotice: String, CaseIterable, Sendable {
    case approved, denied, stepUp, alreadyAnswered, unreachable, openApp

    public var text: (title: String, body: String) {
        switch self {
        case .approved: ("Murage", "Approved.")
        case .denied: ("Murage", "Denied.")
        case .stepUp: ("Murage", "Open Murage to allow this.")
        case .alreadyAnswered: ("Murage", "This was already answered.")
        case .unreachable: ("Murage", "Couldn't reach your Murage, open the app.")
        case .openApp: ("Murage", "Open Murage to answer this.")
        }
    }
}

public enum PushOutcome {
    private static func id(_ v: Any?) -> String? {
        guard let s = v as? String, !s.isEmpty, s.utf16.count <= 512 else { return nil }
        return s
    }

    public static func detail(status: Int?, body: Any?, category: PushCategory) -> PushDetail {
        let generic = PushDetail(title: category.generic.title, body: category.generic.body, target: nil)
        guard status == 200, let b = body as? [String: Any],
              let title = b["title"] as? String, (1...200).contains(title.utf16.count),
              let text = b["body"] as? String, text.utf16.count <= 2000,
              let t = b["target"] as? [String: Any], let thread = id(t["threadId"]) else { return generic }
        return PushDetail(title: title, body: text, target: PushTarget(threadId: thread, messageId: id(t["messageId"]), requestId: id(t["requestId"])))
    }

    public static func notice(status: Int?, body: Any?, decision: String) -> PushNotice {
        let code = (body as? [String: Any])?["code"] as? String
        guard let status, status < 500 else { return .unreachable }
        switch status {
        case 200:
            if (body as? [String: Any])?["outcome"] as? String == "unavailable" { return .openApp }
            return decision == "allow" ? .approved : .denied
        case 403 where code == "step_up": return .stepUp
        case 409 where code == "already_answered": return .alreadyAnswered
        default: return .openApp
        }
    }
}
