import CryptoKit
import Foundation

/// Shared sign-out barrier. Coordinate read/modify/write across the app and
/// extension; atomic replacement keeps readers from observing partial sets.
public struct SharePendingRemovals {
    public let root: URL
    private let write: (Data, URL) throws -> Void
    private static let lock = NSLock()
    private static var failedWrites: [String: Set<String>] = [:]
    public init(root: URL) { self.init(root: root, write: ShareFiles.atomic) }
    init(root: URL, write: @escaping (Data, URL) throws -> Void) {
        self.root = root; self.write = write
    }
    private var key: String { root.standardizedFileURL.path }
    private var unpersisted: Set<String> {
        Self.lock.lock(); defer { Self.lock.unlock() }
        return Self.failedWrites[key] ?? []
    }
    private func remember(_ origin: WorkspaceOrigin, failed: Bool) {
        Self.lock.lock(); defer { Self.lock.unlock() }
        if failed { Self.failedWrites[key, default: []].insert(origin.serialized) }
        else {
            Self.failedWrites[key]?.remove(origin.serialized)
            if Self.failedWrites[key]?.isEmpty == true { Self.failedWrites.removeValue(forKey: key) }
        }
    }
    struct Attempt: Codable, Equatable {
        var attempts = 0
        var firstAttemptAt: Int64?
        var tokenDeleted: Bool?
        func exhausted(at now: Int64) -> Bool {
            attempts >= 3 || firstAttemptAt.map { now >= $0 && now - $0 >= 600_000 } == true
        }
    }
    private var file: URL { root.appendingPathComponent("phone-ask-pending-removals.json") }
    private func records(at url: URL) throws -> [String: Attempt] {
        let data: Data
        do { data = try Data(contentsOf: url) }
        catch CocoaError.fileReadNoSuchFile { return [:] }
        if let records = try? JSONDecoder().decode([String: Attempt].self, from: data),
           records.values.allSatisfy({ (0...3).contains($0.attempts) && ($0.firstAttemptAt ?? 0) >= 0 }) {
            return records
        }
        // Migrate the previous set without resetting any existing attempt record.
        return try Dictionary(uniqueKeysWithValues: JSONDecoder().decode(Set<String>.self, from: data)
            .map { ($0, Attempt()) })
    }
    private func recoveredRecords(at url: URL) -> [String: Attempt] {
        guard let data = try? Data(contentsOf: url) else { return [:] }
        let text = String(decoding: data, as: UTF8.self)
        // A truncated JSON array/object can still contain complete origin strings.
        let pattern = #""(?:[^"\\]|\\.)*""#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [:] }
        var recovered: [String: Attempt] = [:]
        for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let range = Range(match.range, in: text),
                  let value = try? JSONDecoder().decode(String.self, from: Data(text[range].utf8)),
                  let origin = WorkspaceOrigin(string: value), origin.serialized == value else { continue }
            recovered[value] = Attempt()
        }
        return recovered
    }
    public func read() throws -> Set<String> { Set(try records(at: file).keys).union(unpersisted) }
    /// Repair corrupt snapshots, retaining every complete origin we can recover.
    /// A file with no recoverable origins becomes a valid empty record set.
    public func retryOrigins() -> Set<String> {
        if let values = try? read() { return values }
        var recovered = Set(recoveredRecords(at: file).keys).union(unpersisted)
        try? update { recovered.formUnion($0.keys) }
        return recovered
    }
    @MainActor public func contains(_ origin: WorkspaceOrigin) -> Bool {
        contains(origin, readToken: { try PhoneAskTokenStore().readForAsk(origin: $0) })
    }
    @MainActor func contains(_ origin: WorkspaceOrigin,
                            readToken: (WorkspaceOrigin) throws -> String?) -> Bool {
        if let values = try? read() { return values.contains(origin.serialized) }
        if retryOrigins().contains(origin.serialized) { return true }
        // Corruption must not impose a permanent global barrier. Normal send
        // gates still require a readable token after the empty file is repaired.
        do { _ = try readToken(origin); return false } catch { return true }
    }
    func beginAttempt(_ origin: WorkspaceOrigin, now: Int64) throws -> Attempt {
        var attempt = Attempt()
        do {
            try update { values in
                attempt = values[origin.serialized] ?? Attempt()
                // Legacy records counted locked attempts. Start their bound anew.
                if attempt.tokenDeleted != true { attempt = Attempt(); attempt.tokenDeleted = true }
                attempt.attempts = min(3, attempt.attempts + 1)
                if attempt.firstAttemptAt == nil { attempt.firstAttemptAt = now }
                values[origin.serialized] = attempt
            }
        } catch { remember(origin, failed: true); throw error }
        remember(origin, failed: false)
        return attempt
    }
    public func set(_ origin: WorkspaceOrigin, pending: Bool) throws {
        do {
            try update { values in
                if pending { values[origin.serialized] = values[origin.serialized] ?? Attempt() }
                else { values.removeValue(forKey: origin.serialized) }
            }
        } catch {
            if pending { remember(origin, failed: true) }
            throw error
        }
        remember(origin, failed: false)
    }
    private func update(_ change: (inout [String: Attempt]) -> Void) throws {
        try ShareFiles.createDirectory(at: root)
        var coordinationError: NSError?
        var result: Result<Void, Error> = .success(())
        NSFileCoordinator().coordinate(writingItemAt: file, options: .forMerging, error: &coordinationError) { url in
            result = Result {
                var values = (try? records(at: url)) ?? recoveredRecords(at: url)
                for origin in unpersisted where values[origin] == nil { values[origin] = Attempt() }
                change(&values)
                try write(JSONEncoder().encode(values), url)
            }
        }
        if let coordinationError { throw coordinationError }
        try result.get()
    }
}

extension PhoneAskContract.RecentTarget {
    public var shareIdentity: ShareOutboxState.Target { .init(botId: botId, threadId: threadId) }
}

extension PhoneAskContract.TargetsAnswer {
    public func contains(_ target: ShareOutboxState.Target) -> Bool {
        guard let bot = bots.first(where: { $0.id == target.botId }) else { return false }
        return target.threadId == "new" || target.threadId == bot.mainThreadId ||
            recent.contains(where: { $0.shareIdentity == target })
    }
}

/// App Group cache. Timestamps are milliseconds since the epoch, like S34.
public struct ShareTargetCache {
    public struct Entry: Codable {
        public let v: Int
        public let origin: String
        public let fetchedAt: Int64
        public let targets: PhoneAskContract.TargetsAnswer
    }
    public let root: URL
    public init(root: URL) { self.root = root }
    public static func workspace(_ origin: WorkspaceOrigin) -> String {
        Data(SHA256.hash(data: Data(origin.serialized.utf8))).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
    public func file(_ origin: WorkspaceOrigin) -> URL {
        root.appendingPathComponent("targets").appendingPathComponent(Self.workspace(origin) + ".json")
    }
    public func read(_ origin: WorkspaceOrigin, now: Int64) -> Entry? {
        guard let data = try? Data(contentsOf: file(origin)),
              let value = try? JSONDecoder().decode(Entry.self, from: data), value.v == 1,
              value.origin == origin.serialized, value.fetchedAt >= 0, value.fetchedAt <= now,
              now - value.fetchedAt <= 30 * 86_400_000 else { return nil }
        return value
    }
    public func needsRefresh(_ origin: WorkspaceOrigin, now: Int64) -> Bool {
        guard let value = read(origin, now: now) else { return true }
        return now - value.fetchedAt > 300_000
    }
    public func write(_ targets: PhoneAskContract.TargetsAnswer, origin: WorkspaceOrigin, now: Int64) throws {
        try ShareFiles.atomic(JSONEncoder().encode(Entry(v: 1, origin: origin.serialized, fetchedAt: now, targets: targets)), to: file(origin))
    }
    public func remove(_ origin: WorkspaceOrigin) throws {
        let url = file(origin)
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
}

public enum ShareFiles {
    public static func excludeFromBackup(_ url: URL) throws {
        var url = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }
    public static func createDirectory(at url: URL, withIntermediateDirectories: Bool = true) throws {
        var created = [url], parent = url.deletingLastPathComponent()
        if withIntermediateDirectories {
            while !FileManager.default.fileExists(atPath: parent.path) {
                created.append(parent); parent.deleteLastPathComponent()
            }
        }
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: withIntermediateDirectories)
        for directory in created { try excludeFromBackup(directory) }
    }
    /// Re-apply to older installs, including files inside existing share folders.
    public static func excludeExisting(root: URL) throws {
        for name in ["outbox", "share-staging", "targets", "share-workspaces.json", "phone-ask-pending-removals.json"] {
            let url = root.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            try excludeFromBackup(url)
            if let children = FileManager.default.enumerator(at: url, includingPropertiesForKeys: nil) {
                for case let child as URL in children { try excludeFromBackup(child) }
            }
        }
    }
    public static func removeStaging(_ directory: URL) throws {
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }
    public static func sweepUnpublished(root: URL, now: Int64, liveShareIDs: Set<String>) throws {
        let cutoff = Date(timeIntervalSince1970: Double(now) / 1000 - 3600)
        for name in ["share-staging", "outbox"] {
            let directory = root.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: directory.path) else { continue }
            for folder in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey, .contentModificationDateKey]) {
                let values = try folder.resourceValues(forKeys: [.isDirectoryKey, .contentModificationDateKey])
                guard values.isDirectory == true, !liveShareIDs.contains(folder.lastPathComponent),
                      name == "share-staging" || !FileManager.default.fileExists(atPath: folder.appendingPathComponent("state.json").path),
                      try allContentsOlder(than: cutoff, at: folder) else { continue }
                try FileManager.default.removeItem(at: folder)
            }
        }
    }

    private static func allContentsOlder(than cutoff: Date, at url: URL) throws -> Bool {
        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .contentModificationDateKey])
        guard let modified = values.contentModificationDate, modified < cutoff else { return false }
        // Writing an existing file does not update its parent directory's date.
        // Include hidden partial bodies and nested provider files in the check.
        if values.isDirectory == true {
            for child in try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil) {
                guard try allContentsOlder(than: cutoff, at: child) else { return false }
            }
        }
        return true
    }

    public static func atomic(_ data: Data, to url: URL) throws {
        try createDirectory(at: url.deletingLastPathComponent())
        // Foundation writes a unique sibling then renames it. Concurrent writers
        // replace whole snapshots; readers can never see half a JSON document.
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: .atomic)
        #endif
        try excludeFromBackup(url)
    }
}

/// Only the app writes the paired workspace list. No session or bearer is here.
public struct ShareWorkspaceStore {
    public let root: URL
    public init(root: URL) { self.root = root }
    private var file: URL { root.appendingPathComponent("share-workspaces.json") }
    public func read() -> WorkspaceBook? {
        guard let bytes = try? Data(contentsOf: file) else { return nil }
        return WorkspaceBook.decode(bytes)
    }
    public func write(_ book: WorkspaceBook) throws { try ShareFiles.atomic(book.encoded(), to: file) }
}

/// One sheet owns one client. App Intents use ShareTargetCache.read only.
@MainActor
public final class ShareTargetsClient {
    public enum State: Equatable {
        case loading, setup, update, ready(PhoneAskContract.TargetsAnswer)
    }
    public struct Response: Sendable {
        public let status: Int
        public let data: Data
        public init(status: Int, data: Data) { self.status = status; self.data = data }
    }
    private let cache: ShareTargetCache
    private let removals: SharePendingRemovals
    private let readToken: (WorkspaceOrigin) throws -> String?
    private let removal: ShareOriginRemoval
    private let fetch: (WorkspaceOrigin, String) async throws -> Response
    private var opened = Set<WorkspaceOrigin>()
    private var invalidated = Set<WorkspaceOrigin>()
    public init(cache: ShareTargetCache,
                readToken: @escaping (WorkspaceOrigin) throws -> String?,
                removeToken: @escaping (WorkspaceOrigin) throws -> Void,
                cancelUploads: ShareOriginRemoval.CancelUploads? = nil,
                fetch: @escaping (WorkspaceOrigin, String) async throws -> Response) {
        self.cache = cache; self.readToken = readToken; self.fetch = fetch
        self.removals = SharePendingRemovals(root: cache.root)
        self.removal = ShareOriginRemoval(root: cache.root, removeToken: removeToken, cancelUploads: cancelUploads)
    }
    public func isSignedOut(_ origin: WorkspaceOrigin) -> Bool {
        invalidated.contains(origin) || removals.contains(origin)
    }
    public func allows(_ target: ShareOutboxState.Target, origin: WorkspaceOrigin, now: Int64) -> Bool {
        !isSignedOut(origin) && cache.read(origin, now: now)?.targets.contains(target) == true
    }
    public func initial(_ origin: WorkspaceOrigin, now: Int64) -> State {
        guard !isSignedOut(origin), (try? readToken(origin)) != nil else { return .setup }
        guard let entry = cache.read(origin, now: now) else { return .loading }
        return entry.targets.bots.isEmpty ? .setup : .ready(entry.targets)
    }
    /// Each origin fetches at most once per sheet, even after changing From.
    public func open(_ origin: WorkspaceOrigin, now: Int64) async -> State {
        let current = initial(origin, now: now)
        guard opened.insert(origin).inserted, cache.needsRefresh(origin, now: now) else { return current }
        return await refresh(origin, now: now, fallback: current)
    }
    public func refresh(_ origin: WorkspaceOrigin, now: Int64, fallback: State = .setup) async -> State {
        guard !isSignedOut(origin), let token = try? readToken(origin) else { return .setup }
        do {
            let response = try await fetch(origin, token)
            try Task.checkCancellation()
            guard !isSignedOut(origin) else { return .setup }
            if response.status == 401 || response.status == 403 {
                invalidated.insert(origin)
                removal.forget(origin, now: now, code: "revoked")
                return .setup
            }
            if response.status == 404 { return .update }
            guard response.status == 200 else { return fallback == .loading ? .setup : fallback }
            let targets = try JSONDecoder().decode(PhoneAskContract.TargetsAnswer.self, from: response.data)
            // A forget while awaiting the network cannot recreate the cache.
            guard !isSignedOut(origin), (try? readToken(origin)) == token else { return .setup }
            try Task.checkCancellation()
            guard !removals.contains(origin) else { return .setup }
            try cache.write(targets, origin: origin, now: now)
            return targets.bots.isEmpty ? .setup : .ready(targets)
        } catch { return isSignedOut(origin) || Task.isCancelled || fallback == .loading ? .setup : fallback }
    }
    public func forget(_ origin: WorkspaceOrigin) {
        invalidated.insert(origin)
        try? cache.remove(origin)
    }
}

/// The app's choice survives revocations performed by an extension or intent.
public enum PhoneAskSetupChoice {
    public static func marker(turnOn: Bool, pairing: String) -> String {
        (turnOn ? "on:" : "notnow:") + pairing
    }
    public static func shouldOffer(marker: String?, pairing: String, tokenReadable: Bool, removalPending: Bool) -> Bool {
        guard !removalPending else { return false }
        if marker == self.marker(turnOn: false, pairing: pairing) { return false }
        if marker == self.marker(turnOn: true, pairing: pairing) { return !tokenReadable }
        // Legacy markers did not record a choice. Ask once and replace them,
        // including when an older build already lost its token to revocation.
        return true
    }
}
