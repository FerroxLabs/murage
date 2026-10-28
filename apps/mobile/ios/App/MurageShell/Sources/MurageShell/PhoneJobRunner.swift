import Foundation
import MurageShellCore

/// N5 owns presentation. Dismiss releases views and callbacks; late callbacks are fenced by the runner.
@MainActor protocol PhoneJobCardPresenter: AnyObject {
    func show(workspace: WorkspaceOrigin, offer: PhoneJobsContract.Offer, args: PhoneJobsContract.Args, answer: @escaping (Bool) -> Void, failed: @escaping () -> Void)
    func showProvider(workspace: WorkspaceOrigin, provider: PhoneJobsContract.NamedParty, workspaceName: String, answer: @escaping (Bool) -> Void, failed: @escaping () -> Void)
    func canPresent(workspace: WorkspaceOrigin) -> Bool
    func show(workspace: WorkspaceOrigin, offer: PhoneJobsContract.Offer, answer: @escaping (Bool) -> Void)
    func showProvider(workspace: WorkspaceOrigin, provider: PhoneJobsContract.NamedParty, workspaceName: String, answer: @escaping (Bool) -> Void)
    func used(workspace: WorkspaceOrigin, offer: PhoneJobsContract.Offer, closed: @escaping () -> Void)
    func alreadyHandled(workspace: WorkspaceOrigin, operationId: String?, closed: @escaping () -> Void)
    func dismiss(workspace: WorkspaceOrigin, operationId: String?)
}

extension PhoneJobCardPresenter {
    func canPresent(workspace: WorkspaceOrigin) -> Bool { true }
    func show(workspace: WorkspaceOrigin, offer: PhoneJobsContract.Offer, args: PhoneJobsContract.Args, answer: @escaping (Bool) -> Void, failed: @escaping () -> Void) { show(workspace: workspace, offer: offer, answer: answer) }
    func showProvider(workspace: WorkspaceOrigin, provider: PhoneJobsContract.NamedParty, workspaceName: String, answer: @escaping (Bool) -> Void, failed: @escaping () -> Void) { showProvider(workspace: workspace, provider: provider, workspaceName: workspaceName, answer: answer) }
}

/// N6 owns execution. Only typed N1 values cross this seam, never a WebView message.
protocol PhoneJobExecutorRegistry {
    func cancel() async
    func run(workspace: WorkspaceOrigin, operationId: String, capability: String, action: String, args: PhoneJobsContract.Args, preciseConsent: Bool, cancellation: PhoneJobCancellation) async -> PhoneJobExecution
    func run(operationId: String, capability: String, action: String, args: PhoneJobsContract.Args, preciseConsent: Bool, cancellation: PhoneJobCancellation) async -> PhoneJobExecution
}
extension PhoneJobExecutorRegistry {
    func cancel() async {}
    func run(workspace: WorkspaceOrigin, operationId: String, capability: String, action: String, args: PhoneJobsContract.Args, preciseConsent: Bool, cancellation: PhoneJobCancellation) async -> PhoneJobExecution {
        await run(operationId: operationId, capability: capability, action: action, args: args, preciseConsent: preciseConsent, cancellation: cancellation)
    }
}
enum PhoneJobExecution {
    case result(PhoneJobsContract.Result)
    case error(code: String)
}

/// One signal per job, shared with executors across actor and OS callbacks.
final class PhoneJobCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false, writing = false
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    func cancel() { lock.lock(); if !writing { cancelled = true }; lock.unlock() }
    func beginWrite() throws {
        lock.lock(); defer { lock.unlock() }
        if cancelled { throw PhoneExecutorFailure.denied }; writing = true
    }
    func check() throws { if isCancelled { throw PhoneExecutorFailure.denied } }
}

actor PhoneJobRunner {
    struct Response { let status: Int; let body: Any? }
    struct Environment {
        let token: @MainActor (WorkspaceOrigin) -> String?
        let enabled: @MainActor (WorkspaceOrigin) -> Bool
        let needsProvider: @MainActor (WorkspaceOrigin, String) -> Bool
        let recordProvider: @MainActor (WorkspaceOrigin, String) -> Bool
        // Re-read durable consent and OS state, never values captured by the card.
        let consent: @MainActor (WorkspaceOrigin, PhoneJobsContract.Offer) -> Bool
        let permission: @MainActor (PhoneJobsContract.Offer) -> Bool
        let turnOff: @MainActor (WorkspaceOrigin) -> Void
        var preciseConsent: @MainActor (WorkspaceOrigin) -> Bool = { _ in false }
    }
    typealias Send = (URLRequest) async throws -> Response
    private final class Job {
        let workspace: WorkspaceOrigin, offer: PhoneJobsContract.Offer, args: PhoneJobsContract.Args
        let token: String, generation: Int
        var answering = false, revoked = false, posted = false, executing = false, closing = false
        let cancellation = PhoneJobCancellation()
        var providerPending = false
        var lease: String?
        var retainedResult: [String: Any]?
        init(_ workspace: WorkspaceOrigin, _ offer: PhoneJobsContract.Offer, _ args: PhoneJobsContract.Args, _ token: String, _ generation: Int) {
            self.workspace = workspace; self.offer = offer; self.args = args; self.token = token; self.generation = generation
        }
    }
    private let environment: Environment, cards: PhoneJobCardPresenter, executors: PhoneJobExecutorRegistry
    private let send: Send, now: () -> Int64, sleep: (UInt64) async throws -> Void
    private var foreground = false, generation = 0
    private var workspaces: Set<WorkspaceOrigin> = [], blocked: Set<WorkspaceOrigin> = []
    private var blockedTokens: [WorkspaceOrigin: String] = [:]
    private var polls: [WorkspaceOrigin: Task<Void, Never>] = [:]
    private var waiting: [(WorkspaceOrigin, PhoneJobsContract.Offer)] = []
    private var current: Job?
    // A push takes priority over ordinary polls for this foreground visit.
    private var push: (WorkspaceOrigin, String)?
    private var resolvingPush = false, pushResolved = false

    init(environment: Environment, cards: PhoneJobCardPresenter, executors: PhoneJobExecutorRegistry,
         send: @escaping Send, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
         sleep: @escaping (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }) {
        self.environment = environment; self.cards = cards; self.executors = executors
        self.send = send; self.now = now; self.sleep = sleep
    }

    /// Called only by a visible scene. A resign-active event deliberately has no hook.
    func start(workspaces: Set<WorkspaceOrigin>, visible: Bool) async {
        guard visible else { return }
        if !foreground { foreground = true; generation += 1 }
        let removed = self.workspaces.subtracting(workspaces)
        self.workspaces = workspaces
        for workspace in removed { await suspendWorkspace(workspace) }
        if push != nil { await resolvePush(); return }
        await startPolls()
    }
    func refresh(_ workspace: WorkspaceOrigin) async {
        guard await environment.enabled(workspace), let token = await environment.token(workspace) else {
            await suspendWorkspace(workspace); return
        }
        workspaces.insert(workspace)
        // Fresh mint + explicit on is the only way to leave the blocked set.
        if token != blockedTokens[workspace] { blocked.remove(workspace); blockedTokens.removeValue(forKey: workspace) }
        if foreground { await startPolls() }
    }
    private func suspendWorkspace(_ workspace: WorkspaceOrigin) async {
        polls.removeValue(forKey: workspace)?.cancel()
        waiting.removeAll { $0.0 == workspace }
        if let held = current, held.workspace == workspace {
            held.revoked = true; held.cancellation.cancel()
            if held.executing { held.closing = true }
            else if held.lease != nil { Task { await self.post(held, code: "denied") } }
            else if !held.answering { await finish(held) }
        }
        await cards.dismiss(workspace: workspace, operationId: nil)
    }
    func forget(_ workspace: WorkspaceOrigin) async {
        workspaces.remove(workspace)
        await suspendWorkspace(workspace)
        if push?.0 == workspace, let ref = push?.1 { await closePush(ref) }
    }
    func stop() async {
        guard foreground else { return }
        foreground = false; generation += 1; push = nil; pushResolved = false; waiting.removeAll()
        polls.values.forEach { $0.cancel() }; polls.removeAll()
        let held = current
        held?.revoked = true; held?.cancellation.cancel()
        if held?.executing != true { await executors.cancel() }
        if let held, !held.answering || (held.posted && !held.executing) {
            held.retainedResult = nil; current = nil
        }
        for workspace in workspaces {
            await cards.dismiss(workspace: workspace, operationId: nil)
            if let token = await environment.token(workspace) {
                Task { _ = await self.call(workspace, token, "POST", "/foreground", ["active": false]) }
            }
        }
        if let held {
            if held.executing { held.closing = true }
            else if held.lease != nil { Task { await self.post(held, code: "denied") } }
        }
    }
    func open(workspace: WorkspaceOrigin, eventRef: String) async {
        guard eventRef.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { return }
        push = (workspace, eventRef); pushResolved = false
        polls.values.forEach { $0.cancel() }; polls.removeAll(); waiting.removeAll()
        if let job = current, !job.answering { await finish(job) }
        if foreground { await resolvePush() }
    }
    private func resolvePush() async {
        guard foreground, !resolvingPush, !pushResolved, let target = push, current == nil else { return }
        guard !blocked.contains(target.0), await cards.canPresent(workspace: target.0),
              await environment.enabled(target.0), let token = await environment.token(target.0) else {
            await closePush(target.1); return
        }
        guard foreground, current == nil else { return }
        resolvingPush = true
        let epoch = generation
        let response = await call(target.0, token, "GET", "/jobs?eventRef=" + target.1)
        resolvingPush = false
        guard foreground, epoch == generation, push?.1 == target.1 else {
            if foreground, push != nil { await resolvePush() }; return
        }
        guard response?.status == 200, !blocked.contains(target.0) else { await closePush(target.1); return }
        pushResolved = true
        switch PhoneJobsContract.TargetedAnswer.parse(response?.body) {
        case .jobs(let offer):
            await receive(target.0, offer)
            if current == nil { await closePush(target.1) }
        case .handled: await cards.alreadyHandled(workspace: target.0, operationId: nil) { Task { await self.closePush(target.1) } }
        default: await closePush(target.1) // LEASED never creates another card.
        }
    }
    private func closePush(_ ref: String) async {
        guard push?.1 == ref else { return }
        push = nil; pushResolved = false
        await startPolls()
    }
    private func startPolls() async {
        guard foreground, push == nil else { return }
        let epoch = generation
        for workspace in workspaces where polls[workspace] == nil && !blocked.contains(workspace) {
            guard await environment.enabled(workspace), let token = await environment.token(workspace),
                  foreground, generation == epoch, push == nil, workspaces.contains(workspace),
                  !blocked.contains(workspace), polls[workspace] == nil else { continue }
            polls[workspace] = Task { await self.poll(workspace, token, epoch) }
        }
    }
    private func poll(_ workspace: WorkspaceOrigin, _ token: String, _ epoch: Int) async {
        while foreground && generation == epoch && workspaces.contains(workspace) && !blocked.contains(workspace) && !Task.isCancelled {
            let response = await call(workspace, token, "GET", "/jobs")
            guard foreground, generation == epoch, workspaces.contains(workspace), push == nil, !blocked.contains(workspace), !Task.isCancelled else { return }
            if response?.status == 200, let answer = PhoneJobsContract.PollAnswer.parse(response?.body) {
                for offer in answer.jobs { await receive(workspace, offer) }
            }
            // Bounded backoff also prevents a fast empty server from spinning.
            do { try await sleep(1_000_000_000) } catch { return }
        }
    }
    private func receive(_ workspace: WorkspaceOrigin, _ offer: PhoneJobsContract.Offer) async {
        let epoch = generation
        guard foreground, !blocked.contains(workspace), offer.expiresAt > now() - 180_000,
              await environment.enabled(workspace), let token = await environment.token(workspace), foreground, epoch == generation, !blocked.contains(workspace) else { return }
        guard let args = offer.decodedArgs else {
            _ = await call(workspace, token, "POST", "/jobs/" + offer.operationId + "/decline", ["offerId": offer.offerId]); return
        }
        guard await cards.canPresent(workspace: workspace), foreground, epoch == generation, !blocked.contains(workspace) else { return }
        if let held = current {
            if held.workspace != workspace || held.offer.operationId != offer.operationId {
                waiting.removeAll { $0.0 == workspace }; waiting.append((workspace, offer))
            }
            return
        }
        let job = Job(workspace, offer, args, token, generation)
        current = job
        let needs = await environment.needsProvider(workspace, offer.provider.id)
        guard valid(job) else { return }
        if needs {
            job.providerPending = true
            await cards.showProvider(workspace: workspace, provider: offer.provider, workspaceName: offer.workspace, answer: { allow in
                Task { await self.providerAnswer(job, allow) }
            }, failed: { Task { await self.finish(job) } })
        } else { await show(job) }
    }
    private func providerAnswer(_ job: Job, _ allow: Bool) async {
        guard valid(job), !job.answering, job.providerPending else { return }
        job.providerPending = false
        job.answering = true
        guard allow, await environment.recordProvider(job.workspace, job.offer.provider.id) else { await decline(job); return }
        job.answering = false
        if valid(job) { await show(job) } else { await finish(job) }
    }
    private func show(_ job: Job) async {
        await cards.show(workspace: job.workspace, offer: job.offer, args: job.args, answer: { allow in Task { await self.answer(job, allow) } }, failed: { Task { await self.finish(job) } })
    }
    private func valid(_ job: Job) -> Bool {
        foreground && current === job && generation == job.generation && !job.revoked && !job.cancellation.isCancelled && !blocked.contains(job.workspace)
    }
    private func decline(_ job: Job) async {
        _ = await call(job.workspace, job.token, "POST", path(job, "/decline"), ["offerId": job.offer.offerId])
        await finish(job)
    }
    private func answer(_ job: Job, _ allow: Bool) async {
        guard valid(job), !job.answering else { return }
        job.answering = true
        guard allow else { await decline(job); return }
        let response = await call(job.workspace, job.token, "POST", path(job, "/lease"), ["offerId": job.offer.offerId])
        guard response?.status == 200, case .active(let lease) = PhoneJobsContract.LeaseAnswer.parse(response?.body) else {
            await finish(job); return // inactive is a notice, but has no lease to answer.
        }
        job.lease = lease
        guard valid(job) else { await post(job, code: "denied"); return }
        let notice = await call(job.workspace, job.token, "GET", path(job), timeout: 3)
        guard notice?.status == 200, case .leased(let expires) = PhoneJobsContract.TargetedAnswer.parse(notice?.body), expires > now() - 180_000 else {
            job.revoked = true; await cards.dismiss(workspace: job.workspace, operationId: job.offer.operationId)
            await post(job, code: "denied"); return
        }
        let consent = await environment.consent(job.workspace, job.offer)
        let permission = await environment.permission(job.offer)
        guard consent, permission, valid(job), !job.posted else { await post(job, code: "denied"); return }
        let precise = await environment.preciseConsent(job.workspace)
        guard valid(job), !job.posted else { await post(job, code: "denied"); return }
        job.executing = true
        let output = await executors.run(workspace: job.workspace, operationId: job.offer.operationId, capability: job.offer.capability,
                                        action: job.offer.action, args: job.args, preciseConsent: precise, cancellation: job.cancellation)
        job.executing = false
        guard !job.posted else { if job.closing { await finish(job) }; return }
        // Once execution starts, its outcome is authoritative even after stop/revoke.
        switch output {
        case .error(let code): await post(job, code: PhoneJobsContract.resultCodes.contains(code) ? code : "invalid_result")
        case .result(let result):
            guard let encoded = result.encode(), PhoneJobsContract.Result.parse(action: job.offer.action, encoded) != nil,
                  PhoneJobsContract.withinResultBound(encoded) else { await post(job, code: "invalid_result"); return }
            await post(job, result: encoded)
        }
    }
    private func path(_ job: Job, _ suffix: String = "") -> String { "/jobs/" + job.offer.operationId + suffix }
    private func post(_ job: Job, result: [String: Any]? = nil, code: String? = nil) async {
        guard let lease = job.lease, !job.posted else { return }
        job.posted = true // Before any suspension, including the HTTP call's auth notice.
        var body: [String: Any] = ["leaseToken": lease, "ok": code == nil]
        if let code { body["code"] = code } else { body["result"] = result }
        job.retainedResult = body
        let response = await call(job.workspace, job.token, "POST", path(job, "/result"), body)
        if response?.status == 409, valid(job) {
            await cards.alreadyHandled(workspace: job.workspace, operationId: job.offer.operationId) { Task { await self.finish(job) } }
        } else if code == nil, valid(job) {
            job.retainedResult = nil
            await cards.used(workspace: job.workspace, offer: job.offer) { Task { await self.finish(job) } }
        } else { await finish(job) }
    }
    private func finish(_ job: Job) async {
        if job.executing { job.closing = true; return }
        guard current === job else { job.retainedResult = nil; return }
        current = nil; job.retainedResult = nil
        await cards.dismiss(workspace: job.workspace, operationId: job.offer.operationId)
        if foreground, let target = push {
            if pushResolved { await closePush(target.1) } else { await resolvePush() }
        }
        if foreground, push == nil, !waiting.isEmpty {
            let next = waiting.removeFirst(); await receive(next.0, next.1)
        }
    }
    func registration(workspace: WorkspaceOrigin, method: String, token: String, body: [String: Any]?) async -> Int {
        if blocked.contains(workspace) {
            guard await environment.enabled(workspace), let saved = await environment.token(workspace),
                  saved == token, token != blockedTokens[workspace] else { return 403 }
        }
        let response = await call(workspace, token, method, "", body)
        if response?.status == 200 { await refresh(workspace) }
        return response?.status ?? 0
    }
    /// Also called for N3 registration responses, before its completion reaches the UI.
    func notice(workspace: WorkspaceOrigin, status: Int, token: String) async {
        guard status == 401 || status == 403 else { return }
        let wasBlocked = blocked.contains(workspace)
        blocked.insert(workspace)
        // Capture the failed request bearer before any actor hop can delete the stored token.
        if !wasBlocked { blockedTokens[workspace] = token }
        polls.removeValue(forKey: workspace)?.cancel()
        waiting.removeAll { $0.0 == workspace }
        let held = current?.workspace == workspace ? current : nil
        held?.revoked = true; held?.cancellation.cancel()
        if let held, !held.executing { await executors.cancel() }
        await cards.dismiss(workspace: workspace, operationId: nil)
        await environment.turnOff(workspace)
        if let held {
            if held.executing { held.closing = true }
            else if held.lease != nil { Task { await self.post(held, code: "denied") } }
            else if !held.answering { await finish(held) }
        }
    }
    private func call(_ workspace: WorkspaceOrigin, _ token: String, _ method: String, _ suffix: String,
                      _ body: [String: Any]? = nil, timeout: TimeInterval = 25) async -> Response? {
        guard PhoneJobsContract.tokenValid(token), let url = URL(string: workspace.serialized + "/api/phones/self" + suffix) else { return nil }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = method; request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body { request.httpBody = try? JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        do {
            let response = try await send(request)
            await notice(workspace: workspace, status: response.status, token: token)
            return response
        } catch { return nil }
    }
}

/// Ephemeral native sessions: 25 seconds normally, 3 seconds for the targeted check.
/// No shared cookie jar, cache, redirects or body logging.
final class PhoneJobHTTP {
    private final class Redirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    }
    private let session: URLSession
    private let targetedSession: URLSession
    init(configuration: URLSessionConfiguration = .ephemeral) {
        configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false; configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 25; configuration.timeoutIntervalForResource = 25
        session = URLSession(configuration: configuration, delegate: Redirects(), delegateQueue: nil)
        let targeted = configuration.copy() as! URLSessionConfiguration
        targeted.timeoutIntervalForRequest = 3; targeted.timeoutIntervalForResource = 3
        targetedSession = URLSession(configuration: targeted, delegate: Redirects(), delegateQueue: nil)
    }
    func send(_ request: URLRequest) async throws -> PhoneJobRunner.Response {
        let transport = request.timeoutInterval <= 3 ? targetedSession : session
        let (bytes, response) = try await transport.bytes(for: request)
        defer { bytes.task.cancel() }
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard response.statusCode == 200 else { return .init(status: response.statusCode, body: nil) }
        var data = Data()
        for try await byte in bytes {
            guard data.count < PhoneJobsContract.resultMaxBytes else { throw URLError(.dataLengthExceedsMaximum) }
            data.append(byte)
        }
        return .init(status: response.statusCode, body: try JSONSerialization.jsonObject(with: data))
    }
    deinit { session.invalidateAndCancel(); targetedSession.invalidateAndCancel() }
}
