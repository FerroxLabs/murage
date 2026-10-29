import Foundation

public enum ShareOutcome: Equatable {
    case sent, conflict, targetGone, rejected(String), revoked, update, retry

    public static func read(status: Int?, data: Data, networkError: Bool) -> Self {
        if status == 401 || status == 403 { return .revoked }
        guard !networkError, let status else { return .retry }
        if status == 200, let sent = try? JSONDecoder().decode(PhoneAskContract.ShareSent.self, from: data),
           !sent.threadId.isEmpty, !(sent.messageId ?? sent.queueId ?? "").isEmpty { return .sent }
        if status == 404 { return .update }
        let code = (try? JSONDecoder().decode(PhoneAskContract.ShareFailure.self, from: data))?.code
        switch (status, code) {
        case (409, "conflict"): return .conflict
        case (409, "target_gone"): return .targetGone
        case (413, "too_large"): return .rejected("too_large")
        case (415, "unsupported_type"): return .rejected("unsupported_type")
        case (422, "invalid"): return .rejected("invalid")
        default: return .retry // Unknown/malformed answers never discard a payload.
        }
    }
}

/// Only this interface can schedule retries. The iOS implementation uploads on
/// com.murage.mobile.share.app, never on the extension's session.
@MainActor public protocol ShareRetrySession: AnyObject {
    func liveShareIDs() async throws -> Set<String>
    func enqueue(request: URLRequest, body: URL, shareId: String, notBefore: Int64) throws
    func cancel(shareId: String)
    /// True only after fresh inventories of both sessions confirm the origin's tasks are gone.
    func cancel(origin: WorkspaceOrigin, completion: @escaping @MainActor (Bool) -> Void)
}

/// All state transitions and retention rules are independent of UIKit/URLSession.
@MainActor public final class ShareOutbox {
    public static let week: Int64 = 7 * 86_400_000
    public static let day: Int64 = 86_400_000
    public static let backoff: [Int64] = [60_000, 300_000, 1_800_000]
    public let root: URL
    private let session: ShareRetrySession
    private let originForWorkspace: (String) -> WorkspaceOrigin?
    private let readToken: (WorkspaceOrigin) throws -> String?
    private let foregroundAllowed: () -> Bool
    private let removals: SharePendingRemovals
    private let removeToken: ((WorkspaceOrigin) throws -> Void)?
    private lazy var removal = ShareOriginRemoval(root: root, removeToken: removeToken, cancelUploads: session.cancel)
    private var reconciling = false
    public var changed: (() -> Void)?
    private var goneTargets = Set<WorkspaceOrigin>()
    public func takeGoneTargets() -> Set<WorkspaceOrigin> {
        defer { goneTargets.removeAll() }
        return goneTargets
    }

    public init(root: URL, session: ShareRetrySession,
                origin: @escaping (String) -> WorkspaceOrigin?,
                readToken: @escaping (WorkspaceOrigin) throws -> String?,
                foregroundAllowed: @escaping () -> Bool,
                removeToken: ((WorkspaceOrigin) throws -> Void)? = nil) {
        self.root = root; self.session = session; self.originForWorkspace = origin
        self.readToken = readToken; self.foregroundAllowed = foregroundAllowed
        self.removals = SharePendingRemovals(root: root)
        self.removeToken = removeToken
    }
    private var directory: URL { root.appendingPathComponent("outbox") }
    private var failureFile: URL { directory.appendingPathComponent("failed.json") }
    private func folder(_ id: String) throws -> URL {
        guard PhoneAskContract.matches(id, "[A-Za-z0-9_-]{16,80}") else { throw ShareInputError.invalid }
        return directory.appendingPathComponent(id)
    }
    public func body(_ id: String) throws -> URL { try folder(id).appendingPathComponent("body") }
    public func state(_ id: String) throws -> ShareOutboxState {
        let value = try JSONDecoder().decode(ShareOutboxState.self, from: Data(contentsOf: folder(id).appendingPathComponent("state.json")))
        guard value.shareId == id else { throw ShareInputError.invalid }
        // failed.json is written first. Honour it after a crash between the two writes.
        return try failures().first(where: { $0.shareId == id }) ?? value
    }
    private func save(_ value: ShareOutboxState) throws {
        try ShareFiles.atomic(JSONEncoder().encode(value), to: folder(value.shareId).appendingPathComponent("state.json"))
    }
    public func failures() throws -> [ShareOutboxState] {
        try ShareFailureJournal(file: failureFile).update { _ in }
    }
    private func updateFailures(_ change: (inout [ShareOutboxState]) -> Void) throws {
        _ = try ShareFailureJournal(file: failureFile).update(change)
    }
    public func entries() throws -> [ShareOutboxState] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        let states = files.compactMap { try? state($0.lastPathComponent) }
        let ids = Set(states.map(\.shareId))
        return (states + (try failures()).filter { !ids.contains($0.shareId) }).sorted { $0.createdAt > $1.createdAt }
    }
    public static func messageKey(_ state: ShareOutboxState, hasBody: Bool) -> String {
        if state.state == .failed || state.state == .needsTarget {
            if state.code == "revoked" { return "ask_setup_again" }
            if state.code == "update" { return "ask_update" }
            if !hasBody { return "share_outbox_couldnt_send" }
        }
        switch state.state {
        case .queued: return "share_outbox_waiting"
        case .sent: return "share_outbox_sent"
        case .needsTarget: return "share_outbox_target"
        case .failed:
            if state.code == "revoked" { return "ask_setup_again" }
            if state.code == "update" { return "ask_update" }
            return "share_outbox_failed"
        }
    }
    private func removeBody(_ id: String) throws {
        let url = try body(id)
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
    private func terminal(_ value: ShareOutboxState, deleteBody: Bool) throws {
        // Record the failure before discarding bytes; a crash can be repaired by sweep.
        if value.state != .sent {
            try updateFailures { lines in
                lines.removeAll { $0.shareId == value.shareId }
                lines.append(value)
            }
        }
        try save(value)
        if deleteBody { try removeBody(value.shareId) }
    }
    public func completed(shareId: String, status: Int?, data: Data, networkError: Bool,
                          originalRequest: URLRequest?, now: Int64, completionID: String? = nil) throws {
        var value = try state(shareId)
        // A refusal revokes the origin even if this row already became terminal.
        if status == 401 || status == 403,
           let origin = originForWorkspace(value.workspace) ?? originalRequest?.url.flatMap({ WorkspaceOrigin(url: $0) }),
           ShareTargetCache.workspace(origin) == value.workspace {
            removal.forget(origin, now: now, code: "revoked")
            changed?()
            return
        }
        guard value.state == .queued else { return }
        if let completionID, value.lastCompletionID == completionID { return }
        value.lastCompletionID = completionID
        let outcome = ShareOutcome.read(status: status, data: data, networkError: networkError)
        value.updatedAt = now; value.nextAttemptAt = nil
        switch outcome {
        case .sent:
            value.state = .sent; value.code = nil
            try terminal(value, deleteBody: true)
        case .conflict, .targetGone, .rejected, .revoked, .update:
            value.state = outcome == .targetGone ? .needsTarget : .failed
            switch outcome {
            case .conflict: value.code = "conflict"
            case .targetGone:
                value.code = "target_gone"
                if let origin = originForWorkspace(value.workspace) {
                    try ShareTargetCache(root: root).remove(origin)
                    goneTargets.insert(origin)
                }
            case .rejected(let code): value.code = code
            case .revoked: value.code = "revoked"
            default: value.code = "update"
            }
            let discard = outcome == .revoked || { if case .rejected = outcome { return true }; return false }()
            try terminal(value, deleteBody: discard)
        case .retry:
            if now - value.createdAt >= Self.week {
                value.state = .failed; value.code = "expired"
                try terminal(value, deleteBody: true)
            } else {
                let attempt = value.attempts ?? 0
                value.attempts = min(attempt + 1, Self.backoff.count + 1)
                if attempt < Self.backoff.count, now + Self.backoff[attempt] < value.createdAt + Self.week {
                    value.nextAttemptAt = now + Self.backoff[attempt]
                }
                try save(value)
                // Locked/background completions retain their schedule for foreground.
                // Never trust the bearer captured by a task before a forget or rotation.
                if let date = value.nextAttemptAt, let request = originalRequest,
                   requestMatches(request, value: value), foregroundAllowed(),
                   let url = request.url, let origin = WorkspaceOrigin(url: url), !removals.contains(origin),
                   let token = try? readToken(origin), PhoneAskContract.tokenValid(token),
                   request.value(forHTTPHeaderField: "Authorization") == "Bearer " + token,
                   !removals.contains(origin) {
                    try? session.enqueue(request: request, body: body(shareId), shareId: shareId, notBefore: date)
                }
            }
        }
        changed?()
    }
    public func receive(_ record: ShareCompletionRecord, shareId: String, originalRequest: URLRequest?) throws {
        // Revocation is origin-wide even if the completed row is missing or unreadable.
        if record.status == 401 || record.status == 403,
           let url = originalRequest?.url, let origin = WorkspaceOrigin(url: url) {
            removal.forget(origin, now: record.at, code: "revoked")
            changed?()
            return
        }
        // A late cancellation for an expired/removed row has nothing to update.
        guard FileManager.default.fileExists(atPath: try folder(shareId).appendingPathComponent("state.json").path) else { return }
        try record.write(root: root, shareId: shareId)
        try apply(record, shareId: shareId, originalRequest: originalRequest)
    }
    private func apply(_ record: ShareCompletionRecord, shareId: String, originalRequest: URLRequest?) throws {
        try completed(shareId: shareId, status: record.status, data: record.data, networkError: record.networkError,
                      originalRequest: originalRequest, now: record.at, completionID: record.id)
        try FileManager.default.removeItem(at: ShareCompletionRecord.file(root: root, shareId: shareId))
    }
    private func replayCompletions() throws {
        for state in try entries() {
            let file = try ShareCompletionRecord.file(root: root, shareId: state.shareId)
            guard FileManager.default.fileExists(atPath: file.path) else { continue }
            let record = try JSONDecoder().decode(ShareCompletionRecord.self, from: Data(contentsOf: file))
            try apply(record, shareId: state.shareId, originalRequest: nil)
        }
    }
    private func requestMatches(_ request: URLRequest, value: ShareOutboxState) -> Bool {
        guard let url = request.url, let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.path == "/api/phones/self/share", components.query == nil, components.fragment == nil,
              let origin = WorkspaceOrigin(url: url),
              ShareTargetCache.workspace(origin) == value.workspace,
              request.httpMethod == "POST", let auth = request.value(forHTTPHeaderField: "Authorization"),
              auth.hasPrefix("Bearer "), PhoneAskContract.tokenValid(String(auth.dropFirst(7))),
              request.value(forHTTPHeaderField: "Content-Type") == (try? ShareMultipartWriter.contentType(boundary: ShareBodyFile.boundary(shareId: value.shareId))) else { return false }
        return true
    }
    /// Called on the first active scene of a launch and subsequent foregrounds.
    /// A vanished task is recreated from the same body/id; a live task on either
    /// session is left alone, including one already scheduled with a delay.
    public func foreground(now: Int64) async throws {
        guard !reconciling else { return }
        reconciling = true; defer { reconciling = false }
        let live = try await session.liveShareIDs()
        try ShareFiles.sweepUnpublished(root: root, now: now, liveShareIDs: live)
        try replayCompletions()
        try sweep(now: now)
        guard foregroundAllowed() else { return }
        for value in try entries() where value.state == .queued && !live.contains(value.shareId) {
            guard foregroundAllowed(), let origin = originForWorkspace(value.workspace),
                  !removals.contains(origin),
                  let token = try? readToken(origin), PhoneAskContract.tokenValid(token),
                  let url = origin.url(path: "/api/phones/self/share"),
                  FileManager.default.fileExists(atPath: try body(value.shareId).path) else { continue }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            request.setValue(try ShareMultipartWriter.contentType(boundary: ShareBodyFile.boundary(shareId: value.shareId)), forHTTPHeaderField: "Content-Type")
            guard !removals.contains(origin) else { continue }
            try session.enqueue(request: request, body: body(value.shareId), shareId: value.shareId,
                                notBefore: max(now, value.nextAttemptAt ?? now))
        }
        changed?()
    }
    public func sweep(now: Int64) throws {
        for var value in try entries() {
            let age = now - (value.updatedAt ?? value.createdAt)
            if value.state == .queued && now - value.createdAt >= Self.week {
                session.cancel(shareId: value.shareId)
                value.state = .failed; value.code = "expired"; value.updatedAt = now; value.nextAttemptAt = nil
                try terminal(value, deleteBody: true)
            } else if (value.state == .sent && age >= Self.day) || (value.state != .queued && value.state != .sent && age >= Self.week) {
                let path = try folder(value.shareId)
                if FileManager.default.fileExists(atPath: path.path) { try FileManager.default.removeItem(at: path) }
            } else if value.state != .queued {
                // Repair state.json if the app exited after writing failed.json.
                try save(value)
                if value.state == .sent || ["removed", "revoked", "too_large", "unsupported_type", "invalid", "expired"].contains(value.code ?? "") {
                    try removeBody(value.shareId)
                }
            }
        }
        try updateFailures { $0.removeAll { now - ($0.updatedAt ?? $0.createdAt) >= Self.week } }
    }
    @discardableResult public func forget(_ origin: WorkspaceOrigin, now: Int64) -> Bool {
        let result = removal.forget(origin, now: now)
        changed?()
        return result
    }
    /// Called with the shared barrier already set. Workspace hashes remain usable
    /// after the paired-workspace entry has been removed.
    func markRemoved(_ origin: WorkspaceOrigin, now: Int64, code: String) throws {
        for var value in try entries() where value.workspace == ShareTargetCache.workspace(origin) && value.state != .sent {
            value.state = .failed
            if value.code != "revoked" { value.code = code }
            value.updatedAt = now; value.nextAttemptAt = nil
            try terminal(value, deleteBody: true)
        }
    }
    /// A deliberate retry/redirect is a new send, with its own manifest and fingerprint.
    @discardableResult public func resend(_ id: String, target: ShareOutboxState.Target? = nil, now: Int64) throws -> ShareOutboxState {
        let old = try state(id)
        guard foregroundAllowed(), old.state == .failed || old.state == .needsTarget,
              old.state != .needsTarget || target != nil,
              let origin = originForWorkspace(old.workspace), !removals.contains(origin),
              let token = try? readToken(origin), PhoneAskContract.tokenValid(token),
              !removals.contains(origin) else { throw ShareInputError.invalid }
        let prepared = try ShareBodyFile.reprepare(root: root, previous: old, origin: origin,
                                                   target: target ?? old.target, now: now)
        // New durable state exists before old payload/line is removed.
        try updateFailures { $0.removeAll { $0.shareId == id } }
        try FileManager.default.removeItem(at: folder(id))
        changed?()
        return prepared.state
    }
}

/// A completion received before the extension exits must survive until the app
/// owns the outbox. Contains only the bounded answer, never request credentials.
public struct ShareCompletionRecord: Codable {
    public let id: String
    public let status: Int?
    public let data: Data
    public let networkError: Bool
    public let at: Int64
    public init(status: Int?, data: Data, networkError: Bool, at: Int64) {
        self.id = UUID().uuidString
        self.status = status; self.data = data.count <= 65_536 ? data : Data()
        self.networkError = networkError; self.at = at
    }
    public static func file(root: URL, shareId: String) throws -> URL {
        guard PhoneAskContract.matches(shareId, "[A-Za-z0-9_-]{16,80}") else { throw ShareInputError.invalid }
        return root.appendingPathComponent("outbox").appendingPathComponent(shareId).appendingPathComponent("completion.json")
    }
    public func write(root: URL, shareId: String) throws {
        try ShareFiles.atomic(JSONEncoder().encode(self), to: Self.file(root: root, shareId: shareId))
    }
}

/// Shared by forget, targets, share completions and ask. The durable barrier is
/// cleared after local cleanup and cancellation, or the bounded cancellation retry.
@MainActor public final class ShareOriginRemoval {
    public typealias CancelUploads = @MainActor (WorkspaceOrigin, @escaping @MainActor (Bool) -> Void) -> Void
    private let root: URL
    private let removeToken: (WorkspaceOrigin) throws -> Void
    private let cancelUploads: CancelUploads
    private let pending: SharePendingRemovals
    private var cancelling = Set<WorkspaceOrigin>()
    private static var generations: [String: UUID] = [:]
    public static var log: (StaticString) -> Void = { _ in }

    public convenience init(root: URL, removeToken: ((WorkspaceOrigin) throws -> Void)? = nil,
                cancelUploads: CancelUploads? = nil) {
        self.init(root: root, pending: SharePendingRemovals(root: root),
                  removeToken: removeToken, cancelUploads: cancelUploads)
    }
    init(root: URL, pending: SharePendingRemovals,
         removeToken: ((WorkspaceOrigin) throws -> Void)? = nil, cancelUploads: CancelUploads? = nil) {
        self.root = root
        self.pending = pending
        self.removeToken = removeToken ?? PhoneAskTokenStore().remove
        self.cancelUploads = cancelUploads ?? Self.cancelUploads
    }
    private static func cancelUploads(_ origin: WorkspaceOrigin, completion: @escaping @MainActor (Bool) -> Void) {
        #if os(iOS)
        ShareBackgroundSessions.shared.cancel(origin: origin, completion: completion)
        #else
        completion(true) // Background URL sessions exist only in the iOS product.
        #endif
    }
    @discardableResult public func forget(_ origin: WorkspaceOrigin, now: Int64, code: String = "removed",
                                          completion: (@MainActor (Bool) -> Void)? = nil) -> Bool {
        guard cancelling.insert(origin).inserted else { completion?(false); return false }
        let key = root.standardizedFileURL.path + "\n" + origin.serialized
        let generation = UUID()
        Self.generations[key] = generation
        var clean = true
        var attempt: SharePendingRemovals.Attempt?
        do { try pending.set(origin, pending: true) }
        catch {
            if Self.generations[key] == generation { Self.generations.removeValue(forKey: key) }
            cancelling.remove(origin)
            completion?(false)
            return false
        }
        // Failure in Keychain must not prevent cancelling tasks or deleting bodies.
        var tokenDeleted = true
        do { try removeToken(origin) } catch { clean = false; tokenDeleted = false }
        if tokenDeleted {
            do { attempt = try pending.beginAttempt(origin, now: now) }
            catch { clean = false }
        }
        do { try ShareTargetCache(root: root).remove(origin) } catch { clean = false }
        let rows = Self.rows(root: root)
        do { try rows.markRemoved(origin, now: now, code: code) } catch { clean = false }
        let storageClean = clean
        let bounded = tokenDeleted && attempt?.exhausted(at: now) == true
        cancelUploads(origin) { [self] cancelled in
            var success = ((storageClean && cancelled) || bounded) && Self.generations[key] == generation
            // Re-scan after asynchronous inventory. Once credentials are deleted,
            // neither a straggling task nor failed cleanup may extend the bound.
            var cleanupFailed = !storageClean
            if success {
                do { try rows.markRemoved(origin, now: now, code: code) }
                catch { cleanupFailed = true; success = bounded }
                if success {
                    do {
                        try pending.set(origin, pending: false)
                        if !cancelled || cleanupFailed { Self.log("share removal cancellation bound reached") }
                    } catch { success = false }
                }
            }
            if Self.generations[key] == generation { Self.generations.removeValue(forKey: key) }
            cancelling.remove(origin)
            completion?(success)
        }
        return !pending.contains(origin)
    }
    static func rows(root: URL) -> ShareOutbox {
        ShareOutbox(root: root, session: RemovalSession(), origin: { _ in nil },
                    readToken: { _ in nil }, foregroundAllowed: { false })
    }
    /// Disk transitions need no transport. This session cannot enqueue anything.
    private final class RemovalSession: ShareRetrySession {
        func liveShareIDs() async -> Set<String> { [] }
        func enqueue(request: URLRequest, body: URL, shareId: String, notBefore: Int64) throws { throw ShareInputError.invalid }
        func cancel(shareId: String) {}
        func cancel(origin: WorkspaceOrigin, completion: @escaping @MainActor (Bool) -> Void) { completion(false) }
    }
}

/// Coordinate the complete read/modify/write, including corrupt-file repair.
/// Each callback must use the URL supplied by the coordinator.
struct ShareFailureJournal {
    let file: URL
    @discardableResult func update(_ change: (inout [ShareOutboxState]) -> Void) throws -> [ShareOutboxState] {
        try ShareFiles.createDirectory(at: file.deletingLastPathComponent())
        var coordinationError: NSError?
        var result: Result<[ShareOutboxState], Error> = .success([])
        NSFileCoordinator().coordinate(writingItemAt: file, options: .forMerging, error: &coordinationError) { url in
            result = Result {
                let data: Data?
                do { data = try Data(contentsOf: url) }
                catch CocoaError.fileReadNoSuchFile { data = nil }
                let decoded = data.flatMap { try? JSONDecoder().decode([ShareOutboxState].self, from: $0) }
                var values = decoded ?? []
                change(&values)
                if decoded == nil || values != decoded {
                    try ShareFiles.atomic(JSONEncoder().encode(values), to: url)
                }
                return values
            }
        }
        if let coordinationError { throw coordinationError }
        return try result.get()
    }
}
