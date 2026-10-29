#if os(iOS)
import Foundation

/// Main-queue delegate delivery preserves data/completion/finish-events order.
/// The extension's initial send and both task inventories have one owner per
/// process. All retries and foreground recovery use only the app identifier.
@MainActor public final class ShareBackgroundSessions: NSObject, ShareRetrySession, URLSessionDataDelegate {
    public static let shared = ShareBackgroundSessions()
    public static let identifier = "com.murage.mobile.share.app"
    public var completed: ((String, Int?, Data, Bool, URLRequest?) -> Void)?
    private lazy var app: URLSession = make(Self.identifier)
    private var extensionSession: URLSession?
    private var handlers: [String: [() -> Void]] = [:]
    private var responses: [String: Data] = [:]
    private var scheduled = Set<String>()
    private var inventoryErrors: [String: Error] = [:]
    private var inventoryFailureGeneration = 0
    private var finishedEvents = Set<String>()
    private var cancellationInventories = 0

    typealias UploadFactory = @MainActor (String, URLRequest, URL, String, Int64?) -> any ShareResumableUpload
    private var root: () -> URL? = { ShareContainer.root }
    private var uploadFactory: UploadFactory?
    private var testInventories: [ShareUploadCancellation.Inventory]?

    init(root: URL, upload: @escaping UploadFactory, inventories: [ShareUploadCancellation.Inventory]? = nil) {
        super.init()
        self.root = { root }; self.uploadFactory = upload; self.testInventories = inventories
    }
    public override init() {
        super.init()
    }
    private func make(_ identifier: String) -> URLSession {
        let config = URLSessionConfiguration.background(withIdentifier: identifier)
        config.sharedContainerIdentifier = ShareContainer.group
        config.isDiscretionary = false; config.sessionSendsLaunchEvents = true
        config.httpCookieStorage = nil; config.urlCredentialStorage = nil; config.urlCache = nil
        config.httpShouldSetCookies = false
        return URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }
    public func handleEvents(identifier: String, completion: @escaping () -> Void) {
        guard identifier == Self.identifier || identifier == ShareUploadSession.identifier else { completion(); return }
        handlers[identifier, default: []].append(completion)
        if identifier == Self.identifier { _ = app }
        if identifier == ShareUploadSession.identifier, extensionSession == nil {
            extensionSession = make(identifier)
        }
    }
    public func liveShareIDs() async throws -> Set<String> {
        // A force-quit launch may have no background-events callback. Enumerate
        // both identifiers before deciding an extension task has disappeared.
        if extensionSession == nil {
            extensionSession = make(ShareUploadSession.identifier)
        }
        var ids = scheduled
        for session in [app, extensionSession].compactMap({ $0 }) {
            let tasks = await session.allTasks
            ids.formUnion(tasks.filter { $0.state != .completed && $0.state != .canceling }
                .compactMap { ShareUploadIdentity.shareID($0.taskDescription) })
            if session.configuration.identifier == ShareUploadSession.identifier, tasks.isEmpty, cancellationInventories == 0 {
                session.finishTasksAndInvalidate()
            }
        }
        if let error = inventoryErrors.values.first {
            inventoryErrors.removeAll() // Report once; invalidation recreated the session handle.
            throw error
        }
        ids.formUnion(scheduled)
        return ids
    }
    public func enqueue(request: URLRequest, body: URL, shareId: String, notBefore: Int64) throws {
        guard !scheduled.contains(shareId), FileManager.default.isReadableFile(atPath: body.path) else {
            throw ShareInputError.invalid
        }
        try enqueue(request: request, body: body, shareId: shareId, identifier: Self.identifier, notBefore: notBefore)
    }
    public func enqueueExtension(request: URLRequest, body: URL, shareId: String) throws {
        try enqueue(request: request, body: body, shareId: shareId, identifier: ShareUploadSession.identifier, notBefore: nil)
    }
    private func enqueue(request: URLRequest, body: URL, shareId: String, identifier: String, notBefore: Int64?) throws {
        guard let root = root(), let url = request.url, let origin = WorkspaceOrigin(url: url) else {
            throw ShareInputError.invalid
        }
        let pending = SharePendingRemovals(root: root)
        guard !pending.contains(origin) else { throw ShareInputError.invalid }
        let identity = try ShareUploadIdentity(origin: origin, shareId: shareId)
        let task: any ShareResumableUpload
        if let uploadFactory {
            task = uploadFactory(identifier, request, body, identity.description, notBefore)
        } else {
            let session: URLSession
            if identifier == Self.identifier { session = app }
            else {
                if extensionSession == nil { extensionSession = make(identifier) }
                session = extensionSession!
            }
            let upload = session.uploadTask(with: request, fromFile: body)
            upload.taskDescription = identity.description
            if let notBefore { upload.earliestBeginDate = Date(timeIntervalSince1970: Double(notBefore) / 1000) }
            task = upload
        }
        if identifier == Self.identifier { scheduled.insert(shareId) }
        // The other process can arm removal while uploadTask creates its task.
        guard !pending.contains(origin) else {
            task.cancel()
            scheduled.remove(shareId)
            try ShareOriginRemoval.rows(root: root).markRemoved(origin,
                now: Int64(Date().timeIntervalSince1970 * 1000), code: "removed")
            throw ShareInputError.invalid
        }
        task.resume()
    }
    public func cancel(origin: WorkspaceOrigin, completion: @escaping @MainActor (Bool) -> Void) {
        // Reconnect even when no extension callback has been delivered this launch.
        if testInventories == nil, extensionSession == nil {
            extensionSession = make(ShareUploadSession.identifier)
        }
        let sessions = testInventories == nil ? [app, extensionSession].compactMap { $0 } : []
        let ids = [Self.identifier, ShareUploadSession.identifier]
        let folders = root().flatMap {
            try? FileManager.default.contentsOfDirectory(at: $0.appendingPathComponent("outbox"), includingPropertiesForKeys: nil)
        } ?? []
        // Legacy task ownership comes from state.json, independently of failed.json.
        let shareIDs = Set(folders.compactMap { folder -> String? in
            let id = folder.lastPathComponent
            guard PhoneAskContract.matches(id, "[A-Za-z0-9_-]{16,80}"),
                  let data = try? Data(contentsOf: folder.appendingPathComponent("state.json")),
                  let state = try? JSONDecoder().decode(ShareOutboxState.self, from: data),
                  state.shareId == id, state.workspace == ShareTargetCache.workspace(origin) else { return nil }
            return id
        })
        let failureGeneration = inventoryFailureGeneration
        cancellationInventories += 1
        Task { @MainActor in
            let sources: [ShareUploadCancellation.Inventory] = testInventories ?? sessions.map { session in
                { @MainActor in
                    let tasks = await session.allTasks
                    return tasks.map { $0 as any ShareUploadTask }
                }
            }
            let inventories: [ShareUploadCancellation.Inventory] = zip(ids, sources).map { identifier, source in
                { @MainActor in
                    if let error = self.inventoryErrors[identifier] { throw error }
                    let tasks = try await source()
                    if let error = self.inventoryErrors[identifier] { throw error }
                    return tasks
                }
            }
            let cancelled = await ShareUploadCancellation.cancel(origin: origin, shareIDs: shareIDs, inventories: inventories) {
                self.scheduled.remove($0)
            }
            cancellationInventories -= 1
            let success = cancelled && inventoryErrors.isEmpty && failureGeneration == inventoryFailureGeneration
            inventoryErrors.removeAll() // Report this failure, then let the replacement handles retry.
            completion(success)
            finishEventsIfReady()
        }
    }
    public func cancel(shareId: String) {
        scheduled.remove(shareId)
        for session in [app, extensionSession].compactMap({ $0 }) {
            session.getAllTasks { tasks in
                for task in tasks where ShareUploadIdentity.shareID(task.taskDescription) == shareId { task.cancel() }
            }
        }
    }
    nonisolated private func key(_ session: URLSession, _ task: URLSessionTask) -> String {
        (session.configuration.identifier ?? "") + ":" + String(task.taskIdentifier)
    }
    nonisolated public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        MainActor.assumeIsolated {
            let key = key(session, dataTask)
            // Contract answers are small. An oversized answer is malformed, never success.
            if responses[key, default: Data()].count <= 65_536 {
                responses[key, default: Data()].append(data.prefix(65_537))
            }
        }
    }
    nonisolated public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        MainActor.assumeIsolated {
            let data = responses.removeValue(forKey: key(session, task)) ?? Data()
            guard let id = ShareUploadIdentity.shareID(task.taskDescription) else { return }
            if session.configuration.identifier == Self.identifier { scheduled.remove(id) }
            let status = (task.response as? HTTPURLResponse)?.statusCode
            let bytes = data.count <= 65_536 ? data : Data()
            if let completed {
                completed(id, status, bytes, error != nil, task.originalRequest)
            } else if let root = ShareContainer.root {
                let now = Int64(Date().timeIntervalSince1970 * 1000)
                try? ShareCompletionRecord(status: status, data: bytes, networkError: error != nil, at: now)
                    .write(root: root, shareId: id)
                if status == 401 || status == 403,
                   let origin = ShareUploadIdentity(description: task.taskDescription)?.origin ??
                    task.originalRequest?.url.flatMap({ WorkspaceOrigin(url: $0) }) {
                    ShareOriginRemoval(root: root).forget(origin, now: now, code: "revoked")
                }
            }
        }
    }
    private func finishEventsIfReady() {
        guard cancellationInventories == 0 else { return }
        for id in Array(finishedEvents) {
            finishedEvents.remove(id)
            if id == ShareUploadSession.identifier { extensionSession?.finishTasksAndInvalidate() }
            handlers.removeValue(forKey: id)?.forEach { $0() }
        }
    }
    nonisolated public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        MainActor.assumeIsolated {
            guard let id = session.configuration.identifier else { return }
            finishedEvents.insert(id)
            // Do not return the OS wake completion while origin cancellation is pending.
            finishEventsIfReady()
        }
    }
    nonisolated public func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
        MainActor.assumeIsolated {
            guard let id = session.configuration.identifier else { return }
            didInvalidate(identifier: id, error: error)
        }
    }
    func didInvalidate(identifier: String, error: Error?) {
        if let error {
            inventoryErrors[identifier] = error
            inventoryFailureGeneration += 1
        }
        if identifier == ShareUploadSession.identifier { extensionSession = nil }
        if identifier == Self.identifier, testInventories == nil { app = make(Self.identifier) }
        finishedEvents.insert(identifier)
        finishEventsIfReady()
    }
    nonisolated public func urlSession(_ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
#endif
