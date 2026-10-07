import Foundation

/// Twin of PushLedger.java; oracle apps/mobile/src/push-ledger.ts.
public struct PushLedger: Sendable {
    public enum Accept: String, Sendable { case show, stale, unknown }
    public static let seenLimit = 500

    private var order: [String] = []                 // binding ids, insertion order
    private var entries: [String: (origin: String, badge: Int)] = [:]
    private var seen: [(key: String, revision: Int)] = []

    public init() {}

    public mutating func bind(_ bindingId: String, origin: String) {
        for id in order where entries[id]?.origin == origin { entries[id] = nil }
        order.removeAll { entries[$0] == nil }
        let isNew = entries[bindingId] == nil
        entries[bindingId] = (origin, 0)
        if isNew { order.append(bindingId) }
    }
    public mutating func unbindOrigin(_ origin: String) -> String? {
        guard let id = order.first(where: { entries[$0]?.origin == origin }) else { return nil }
        entries[id] = nil
        order.removeAll { $0 == id }
        return id
    }
    public func origin(_ bindingId: String) -> String? { entries[bindingId]?.origin }
    public var bindingIds: [String] { order }
    public func binding(origin: String) -> String? { order.first { entries[$0]?.origin == origin } }
    public var total: Int { entries.values.reduce(0) { $0 + $1.badge } }

    public mutating func accept(_ bindingId: String, collapseKey: String, revision: Int, workspaceBadge: Int) -> Accept {
        guard entries[bindingId] != nil else { return .unknown }
        if let at = seen.firstIndex(where: { $0.key == collapseKey }) {
            if seen[at].revision >= revision { return .stale }
            seen.remove(at: at)
        }
        seen.append((collapseKey, revision))
        if seen.count > Self.seenLimit { seen.removeFirst(seen.count - Self.seenLimit) }
        entries[bindingId]?.badge = max(0, workspaceBadge)
        return .show
    }
    public mutating func setBadge(_ bindingId: String, count: Int) {
        if entries[bindingId] != nil { entries[bindingId]?.badge = max(0, count) }
    }
    public mutating func reconcile(_ bindingId: String, badge: Int, pending: [(String, Int)], shown: [String]) -> [String] {
        setBadge(bindingId, count: badge)
        for (key, revision) in pending {
            let at = seen.firstIndex { $0.key == key }
            if at == nil || seen[at!].revision < revision {
                if let at { seen.remove(at: at) }
                seen.append((key, revision))
            }
        }
        if seen.count > Self.seenLimit { seen.removeFirst(seen.count - Self.seenLimit) }
        let live = Set(pending.map(\.0))
        return shown.filter { !live.contains($0) }.sorted()
    }

    /// `bindings` is an ordered array of `[bindingId, origin, badge]` triples, not a JSON
    /// object keyed by bindingId: object key order is not guaranteed to survive a JSON
    /// library round trip, and `bindingIds` order (the contract, defined by the TS oracle)
    /// must. `.sortedKeys` makes the top-level object's own key order deterministic too.
    public func encoded() -> Data {
        var bindings: [[Any]] = []
        for id in order { if let e = entries[id] { bindings.append([id, e.origin, e.badge]) } }
        let object: [String: Any] = ["bindings": bindings, "seen": seen.map { [$0.key, $0.revision] as [Any] }]
        return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    }
    public static func decode(_ data: Data?) -> PushLedger {
        var ledger = PushLedger()
        guard let data, let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return ledger }
        for case let item as [Any] in o["bindings"] as? [Any] ?? [] {
            guard item.count == 3, let id = item[0] as? String, let origin = item[1] as? String, origin.hasPrefix("https://") else { continue }
            let badge = ChannelArgs.int(item[2]) ?? 0
            if ledger.entries[id] == nil { ledger.order.append(id) }
            ledger.entries[id] = (origin, badge)
        }
        for case let pair as [Any] in o["seen"] as? [Any] ?? [] {
            if pair.count == 2, let key = pair[0] as? String, let revision = ChannelArgs.int(pair[1]) { ledger.seen.append((key, revision)) }
        }
        if ledger.seen.count > seenLimit { ledger.seen.removeFirst(ledger.seen.count - seenLimit) }
        return ledger
    }
}
