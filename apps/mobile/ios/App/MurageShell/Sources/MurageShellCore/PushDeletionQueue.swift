import Foundation

/// B4 (Astra B4): relay bindings this phone owes a DELETE for.
///
/// Removing a computer discards its binding locally at once; the relay DELETE
/// is one best-effort request. Offline, it was lost for good, and the old host
/// could keep publishing to the phone. A binding id is written here BEFORE the
/// local discard and leaves only when the relay gave a final answer, so every
/// activation or return of connectivity can retry it (Android keeps the same
/// obligation in its push_relay_removals table). Only ids are kept: the secret
/// that authorises the DELETE is the install's device secret in the Keychain.
public protocol PushDeletionQueue: AnyObject {
    func ids() -> [String]
    func add(_ bindingId: String)
    func remove(_ bindingId: String)
}

public extension PushDeletionQueue {
    func clear() { for id in ids() { remove(id) } }
}

public final class MemoryDeletionQueue: PushDeletionQueue {
    private var list: [String] = []
    public init() {}
    public func ids() -> [String] { list }
    public func add(_ bindingId: String) { if !list.contains(bindingId) { list.append(bindingId) } }
    public func remove(_ bindingId: String) { list.removeAll { $0 == bindingId } }
}

/// One JSON file (an array of binding ids), replaced atomically under a lock,
/// bounded so a long outage cannot grow it without limit.
public final class FileDeletionQueue: PushDeletionQueue, @unchecked Sendable {
    public static let limit = 200
    private let url: URL?
    private let lock = NSLock()

    public convenience init(appGroup: String) {
        self.init(url: FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?.appendingPathComponent("push-deletions.json"))
    }
    public init(url: URL?) { self.url = url }

    public func ids() -> [String] { lock.withLock { load() } }

    public func add(_ bindingId: String) {
        lock.withLock {
            var list = load()
            guard !list.contains(bindingId) else { return }
            list.append(bindingId)
            if list.count > Self.limit { list.removeFirst(list.count - Self.limit) }
            save(list)
        }
    }

    public func remove(_ bindingId: String) {
        lock.withLock {
            let list = load()
            let kept = list.filter { $0 != bindingId }
            if kept.count != list.count { save(kept) }
        }
    }

    private func load() -> [String] {
        guard let url, let data = try? Data(contentsOf: url), let list = try? JSONDecoder().decode([String].self, from: data) else { return [] }
        return list
    }

    private func save(_ list: [String]) {
        guard let url, let data = try? JSONEncoder().encode(list) else { return }
        #if os(iOS)
        let options: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        #else
        let options: Data.WritingOptions = [.atomic]
        #endif
        try? data.write(to: url, options: options)
    }
}
