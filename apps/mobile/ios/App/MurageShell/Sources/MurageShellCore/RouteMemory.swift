import Foundation

/// UserDefaults on iOS (P14); memory in tests. A nil value removes the key.
public protocol KeyValueStore: AnyObject {
    func string(forKey key: String) -> String?
    func set(_ value: String?, forKey key: String)
}

/// A conversation to open once the page is up: a notification tap (Plan 3)
/// or, in debug builds, the E2E launch argument. It holds a bare origin and
/// ids only, never a credential. Twin of PendingOpen.java.
public struct PendingOpen: Codable, Equatable, Sendable {
    public let origin: String
    public let threadId: String
    public let messageId: String?

    public init(origin: WorkspaceOrigin, threadId: String, messageId: String?) {
        self.origin = origin.serialized
        self.threadId = threadId
        self.messageId = messageId
    }

    private enum CodingKeys: String, CodingKey { case origin, threadId, messageId }

    /// Strictly typed: a wrong type, or an empty or too-long thread id, voids
    /// the record; a null messageId is absent.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        origin = try container.decode(String.self, forKey: .origin)
        threadId = try container.decode(String.self, forKey: .threadId)
        messageId = try container.decodeIfPresent(String.self, forKey: .messageId)
        guard OpenHash.valid(threadId) else {
            throw DecodingError.dataCorruptedError(forKey: .threadId, in: container, debugDescription: "invalid thread id")
        }
    }
}

/// Spec §3.2 "Persisted state": the last route per computer and any pending
/// intent survive the app being killed, the web process dying, and (on
/// Android) the WebView being recreated, which loses sessionStorage.
/// Twin of RouteMemory.java.
public final class RouteMemory {
    static let pendingKey = "murage.pendingOpen"
    private let store: KeyValueStore

    public init(store: KeyValueStore) {
        self.store = store
    }

    private func routeKey(_ origin: WorkspaceOrigin) -> String { "murage.route." + origin.serialized }

    @discardableResult
    public func remember(threadId: String, for origin: WorkspaceOrigin) -> Bool {
        guard OpenHash.valid(threadId) else { return false }
        store.set(threadId, forKey: routeKey(origin))
        return true
    }

    public var pending: PendingOpen? {
        store.string(forKey: Self.pendingKey).flatMap { try? JSONDecoder().decode(PendingOpen.self, from: Data($0.utf8)) }
    }

    @discardableResult
    public func setPending(_ open: PendingOpen) -> Bool {
        guard OpenHash.valid(open.threadId), let data = try? JSONEncoder().encode(open) else { return false }
        store.set(String(decoding: data, as: UTF8.self), forKey: Self.pendingKey)
        return true
    }

    public func clearPending(for origin: WorkspaceOrigin) {
        if pending?.origin == origin.serialized { store.set(nil, forKey: Self.pendingKey) }
    }

    public func forget(_ origin: WorkspaceOrigin) {
        store.set(nil, forKey: routeKey(origin))
        clearPending(for: origin)
    }

    /// Where a fresh page load starts: a pending intent, else the last
    /// conversation, else the root.
    public func startPath(for origin: WorkspaceOrigin) -> String {
        if let open = pending, open.origin == origin.serialized,
           let hash = OpenHash.build(threadId: open.threadId, messageId: open.messageId) { return "/" + hash }
        if let thread = store.string(forKey: routeKey(origin)), let hash = OpenHash.build(threadId: thread) { return "/" + hash }
        return "/"
    }
}
