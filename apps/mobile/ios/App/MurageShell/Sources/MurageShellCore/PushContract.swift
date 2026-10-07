import Foundation

/// The push contract as the phone reads it (apps/mobile/contract/push.json).
/// Twin of PushContract.java; oracle apps/mobile/src/push-contract.ts.
public enum PushCategory: String, CaseIterable, Sendable {
    case approval, approvalOpen = "approval-open", question, done, resolved

    public var iosCategory: String {
        switch self {
        case .approval: "APPROVAL"
        case .approvalOpen: "APPROVAL_OPEN"
        case .question: "QUESTION"
        case .done, .resolved: "DONE"
        }
    }
    public var androidChannel: String {
        switch self {
        case .approval, .approvalOpen: "approvals"
        case .question: "questions"
        case .done, .resolved: "finished"
        }
    }
    public var generic: (title: String, body: String) {
        switch self {
        case .approval, .approvalOpen, .question: ("Murage", "Your attention is needed.")
        case .done: ("Murage", "A task has finished.")
        case .resolved: ("Murage", "No longer waiting.")
        }
    }
}

/// B5: flipped by Plan 3a Task 0's verdict; mirrors contract/push-features.json.
public enum PushFeatures {
    public static let richText = true
    public static let lockScreenActions = true
}

public struct PushPayload: Equatable, Sendable {
    public let bindingId: String
    public let eventRef: String
    public let category: PushCategory
    public let revision: Int
    public let workspaceBadge: Int
    public let collapseKey: String
    public let threadGroup: String?

    static let keys: Set<String> = ["bindingId", "eventRef", "category", "revision", "workspaceBadge", "collapseKey"]

    private static func build(_ o: [String: Any], revision: Int?, badge: Int?, group: String?) -> PushPayload? {
        guard let bindingId = o["bindingId"] as? String, PushPattern.uuid(bindingId),
              let eventRef = o["eventRef"] as? String, PushPattern.hex(eventRef, 64),
              let raw = o["category"] as? String, let category = PushCategory(rawValue: raw),
              let collapseKey = o["collapseKey"] as? String, PushPattern.hex(collapseKey, 32),
              let revision, revision >= 1, let badge, badge >= 0 else { return nil }
        return PushPayload(bindingId: bindingId, eventRef: eventRef, category: category, revision: revision, workspaceBadge: badge, collapseKey: collapseKey, threadGroup: group)
    }

    /// The APNs `murage` dictionary: exactly six keys, JSON integers.
    public static func parse(_ any: Any?) -> PushPayload? {
        guard let o = any as? [String: Any], Set(o.keys) == keys else { return nil }
        return build(o, revision: ChannelArgs.int(o["revision"]), badge: ChannelArgs.int(o["workspaceBadge"]), group: nil)
    }

    /// FCM data: the same six as strings, plus threadGroup.
    public static func parse(fcmData d: [String: String]) -> PushPayload? {
        guard Set(d.keys) == keys.union(["threadGroup"]), let group = d["threadGroup"], PushPattern.hex(group, 16) else { return nil }
        return build(d, revision: PushPattern.decimal(d["revision"]), badge: PushPattern.decimal(d["workspaceBadge"]), group: group)
    }
}

public struct IssuedTokens: Equatable, Sendable {
    public let bindingId: String
    public let detail: String
    public let respond: String
    public let expiresAt: Int64

    public static func parse(_ any: Any?) -> IssuedTokens? {
        guard let o = any as? [String: Any], Set(o.keys) == ["bindingId", "detail", "respond", "expiresAt"],
              let bindingId = o["bindingId"] as? String, PushPattern.uuid(bindingId),
              let detail = o["detail"] as? String, PushPattern.token(detail, prefix: "murage_pd_"),
              let respond = o["respond"] as? String, PushPattern.token(respond, prefix: "murage_pr_"),
              let expiresAt = channelInteger(o["expiresAt"]), expiresAt > 0 else { return nil }
        return IssuedTokens(bindingId: bindingId, detail: detail, respond: respond, expiresAt: expiresAt)
    }

    /// A whole number as the channel carries it. WKScriptMessage turns every
    /// JavaScript number into a double NSNumber, so JSONInteger (which wants
    /// JSONSerialization's integer types) refused every expiresAt: each
    /// issuePushTokens answered bad_args, no token was stored, and every
    /// registerPush replaced the binding (the iPhone churn of 2026-09-28).
    /// Same rule as the page (Number.isSafeInteger) and PushContract.java
    /// (a whole Number); booleans and fractions are refused.
    static func channelInteger(_ raw: Any?) -> Int64? {
        guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        if !CFNumberIsFloatType(number) { return JSONInteger.value(number) }
        let double = number.doubleValue
        guard double.isFinite, double.rounded() == double, abs(double) <= 9_007_199_254_740_991 else { return nil }
        return Int64(double)
    }
}

enum PushPattern {
    static func hex(_ s: String, _ count: Int) -> Bool {
        s.utf8.count == count && s.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    static func uuid(_ s: String) -> Bool {
        s.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil
    }
    static func token(_ s: String, prefix: String) -> Bool {
        s.range(of: "^\(prefix)[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
    }
    static func decimal(_ s: String?) -> Int? {
        guard let s, s.range(of: "^(0|[1-9][0-9]{0,9})$", options: .regularExpression) != nil, let n = Int(s), n <= Int(Int32.max) else { return nil }
        return n
    }
}
