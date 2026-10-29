import Foundation
import XCTest
import MurageShellCore
@testable import MurageShell

/// Exercises the real request builder/session with controlled, memory-only URLProtocol replies.
private final class RunnerURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var routes: [String: (RunnerURLProtocol) -> Void] = [:]
    static func register(_ host: String, _ handler: @escaping (RunnerURLProtocol) -> Void) {
        lock.lock(); routes[host] = handler; lock.unlock()
    }
    static func remove(_ host: String) { lock.lock(); routes.removeValue(forKey: host); lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let route = Self.routes[request.url!.host!]; Self.lock.unlock()
        route?(self)
    }
    override func stopLoading() {}
    func reply(_ body: Any = [:], status: Int = 200) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
        client?.urlProtocolDidFinishLoading(self)
    }
    func fail(_ code: URLError.Code = .timedOut) { client?.urlProtocol(self, didFailWithError: URLError(code)) }
    private var savedBody: [String: Any]?
    var body: [String: Any] {
        if let savedBody { return savedBody }
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let n = stream.read(&bytes, maxLength: bytes.count); if n <= 0 { break }; data.append(contentsOf: bytes.prefix(n)) }
        }
        let parsed = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        savedBody = parsed
        return parsed
    }
}

private final class RunnerTestClock {
    private let lock = NSLock()
    private var value: Int64 = 1_700_000_000_000
    var now: Int64 {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); value = newValue; lock.unlock() }
    }
}

@MainActor final class PhoneJobRunnerTests: XCTestCase {
    private final class Cards: PhoneJobCardPresenter {
        var offers: [PhoneJobsContract.Offer] = [], providers: [String] = []
        var onScreen: WorkspaceOrigin?
        var providerWorkspaces: [WorkspaceOrigin] = [], offerWorkspaces: [WorkspaceOrigin] = [], workspaceNames: [String] = []
        func canPresent(workspace: WorkspaceOrigin) -> Bool { onScreen == nil || PhoneJobPresentation.matches(workspace, onScreen) }
        var answer: ((Bool) -> Void)?, providerAnswer: ((Bool) -> Void)?, close: (() -> Void)?
        var failPresentation = false
        var presentedArgs: PhoneJobsContract.Args?
        func show(workspace: WorkspaceOrigin, offer: PhoneJobsContract.Offer, args: PhoneJobsContract.Args, answer: @escaping (Bool) -> Void, failed: @escaping () -> Void) {
            presentedArgs = args
            if failPresentation { failed(); return }
            show(workspace: workspace, offer: offer, answer: answer)
        }
        func showProvider(workspace: WorkspaceOrigin, provider: PhoneJobsContract.NamedParty, workspaceName: String, answer: @escaping (Bool) -> Void, failed: @escaping () -> Void) {
            if failPresentation { failed(); return }
            showProvider(workspace: workspace, provider: provider, workspaceName: workspaceName, answer: answer)
        }
        var used = 0
        var heldUsed = false
        var handled = 0, dismissals = 0, displayed = false
        func show(workspace: WorkspaceOrigin, offer: PhoneJobsContract.Offer, answer: @escaping (Bool) -> Void) { offerWorkspaces.append(workspace); offers.append(offer); self.answer = answer; displayed = true }
        func showProvider(workspace: WorkspaceOrigin, provider: PhoneJobsContract.NamedParty, workspaceName: String, answer: @escaping (Bool) -> Void) { providerWorkspaces.append(workspace); workspaceNames.append(workspaceName); providers.append(provider.name); providerAnswer = answer; displayed = true }
        func used(workspace: WorkspaceOrigin, offer: PhoneJobsContract.Offer, closed: @escaping () -> Void) {
            used += 1; close = closed; displayed = true
            if !heldUsed { closed() }
        }
        func alreadyHandled(workspace: WorkspaceOrigin, operationId: String?, closed: @escaping () -> Void) { handled += 1; close = closed; displayed = true }
        func dismiss(workspace: WorkspaceOrigin, operationId: String?) { dismissals += 1; displayed = false }
    }
    private actor Executors: PhoneJobExecutorRegistry {
        var runs = 0, writes = 0, completed = 0
        var cancellation: PhoneJobCancellation?
        var receivedArgs: PhoneJobsContract.Args?
        var operationId: String?, preciseConsent = false
        var hold = false
        var pending: CheckedContinuation<PhoneJobExecution, Never>?
        var output: PhoneJobExecution = .result(.calendarRead(.init(events: [], truncated: false)))
        func run(operationId: String, capability: String, action: String, args: PhoneJobsContract.Args, preciseConsent: Bool, cancellation: PhoneJobCancellation) async -> PhoneJobExecution {
            self.cancellation = cancellation; self.receivedArgs = args
            runs += 1; self.operationId = operationId; self.preciseConsent = preciseConsent
            let result: PhoneJobExecution
            if hold { result = await withCheckedContinuation { pending = $0 } } else { result = output }
            if !cancellation.isCancelled { writes += 1 }
            completed += 1
            return cancellation.isCancelled ? .error(code: "denied") : result
        }
        func setHold() { hold = true }
        func complete() { pending?.resume(returning: output); pending = nil }
        func set(_ output: PhoneJobExecution) { self.output = output }
    }
    @MainActor private final class Rig {
        let workspace: WorkspaceOrigin
        let cards = Cards(), executors = Executors()
        var consent = PhoneConsent(enabled: true, sharing: true, providers: ["anthropic"], rows: ["calendar"])
        var token: String? = "murage_pj_" + String(repeating: "a", count: 43)
        var extraTokens: [WorkspaceOrigin: String] = [:]
        var permission = true, off = 0
        let clock = RunnerTestClock()
        var now: Int64 { get { clock.now } set { clock.now = newValue } }
        var sleeps: [CheckedContinuation<Void, Error>] = []
        var requests: [RunnerURLProtocol] = [], consumed: Set<ObjectIdentifier> = []
        let http: PhoneJobHTTP
        lazy var runner = PhoneJobRunner(environment: .init(
            token: { workspace in workspace == self.workspace ? self.token : self.extraTokens[workspace] }, enabled: { _ in self.consent.enabled },
            needsProvider: { _, provider in !self.consent.sharing || !self.consent.providers.contains(provider) },
            recordProvider: { _, provider in self.consent.providers.insert(provider); return true },
            consent: { _, offer in self.consent.enabled && self.consent.sharing && self.consent.rows.contains(offer.capability) && self.consent.providers.contains(offer.provider.id) },
            permission: { _ in self.permission }, turnOff: { _ in self.off += 1; self.token = nil; self.consent.enabled = false },
            preciseConsent: { _ in self.consent.rows.contains("precise") }),
            cards: cards, executors: executors, send: http.send,
            now: { [clock] in clock.now }, sleep: { _ in try await self.sleep() })
        init() {
            workspace = WorkspaceOrigin(string: "https://test-" + UUID().uuidString.lowercased() + ".example.ts.net")!
            let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [RunnerURLProtocol.self]
            http = PhoneJobHTTP(configuration: config)
            RunnerURLProtocol.register(URL(string: workspace.serialized)!.host!) { [weak self] request in
                Task { @MainActor in self?.requests.append(request) }
            }
        }
        func sleep() async throws { try await withCheckedThrowingContinuation { sleeps.append($0) } }
        func tick() { now += 1000; let pending = sleeps; sleeps.removeAll(); pending.forEach { $0.resume() } }
        func start(_ visible: Bool = true) async { await runner.start(workspaces: [workspace], visible: visible) }
        func shutdown() async {
            await runner.stop(); tick()
            RunnerURLProtocol.remove(URL(string: workspace.serialized)!.host!)
        }
        func take(_ suffix: String) async throws -> RunnerURLProtocol {
            for _ in 0..<10000 {
                if let found = requests.first(where: { !consumed.contains(ObjectIdentifier($0)) && ($0.request.url!.path + ($0.request.url!.query.map { "?" + $0 } ?? "")).hasSuffix(suffix) }) {
                    consumed.insert(ObjectIdentifier(found)); return found
                }
                await Task.yield()
            }
            XCTFail("Missing request: " + suffix); throw URLError(.timedOut)
        }
        func until(_ predicate: () -> Bool) async {
            for _ in 0..<10000 { if predicate() { return }; await Task.yield() }
            XCTAssertTrue(predicate())
        }
        func offer(_ changes: [String: Any] = [:]) throws -> [String: Any] {
            var url = URL(fileURLWithPath: #filePath)
            for _ in 0..<6 { url.deleteLastPathComponent() }
            let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: url.appendingPathComponent("contract/phone-jobs.json"))) as! [String: Any]
            var value = (fixture["job"] as! [String: Any])["offers"] as! [[String: Any]]
            for (k, v) in changes { value[0][k] = v }
            return value[0]
        }
        func show(_ changes: [String: Any] = [:]) async throws {
            await start(); let poll = try await take("/jobs"); poll.reply(["jobs": [try offer(changes)]])
            await until { !self.cards.offers.isEmpty || !self.cards.providers.isEmpty }
        }
        func lease() async throws -> RunnerURLProtocol {
            cards.answer?(true); return try await take("/lease")
        }
        func active(_ lease: RunnerURLProtocol) async throws -> RunnerURLProtocol {
            lease.reply(["active": true, "leaseToken": String(repeating: "L", count: 43)])
            let target = try await take("/jobs/" + (try offer()["operationId"] as! String))
            XCTAssertEqual(target.request.timeoutInterval, 3); return target
        }
        func result(_ code: String?) async throws -> RunnerURLProtocol {
            let request = try await take("/result")
            XCTAssertEqual(request.body["ok"] as? Bool, code == nil)
            XCTAssertEqual(request.body["code"] as? String, code)
            return request
        }
    }

    func testUnsafeDestinationsDeclineBeforeAnyCardOrExecution() async throws {
        for action in ["messages.compose", "calls.dial"] {
            for bad in ["+15551212\n900", "+1555\u{202e}1212", "+1\u{200d}23", "+1\t23", "+1\u{0000}23", "Sam", "sam@example.test", "*123", "123#", String(repeating: "1", count: 41)] {
                let r = Rig(); r.consent.providers.removeAll()
                let args: [String: Any] = action == "calls.dial" ? ["number": bad] : ["to": ["+123", bad], "body": "Hi"]
                await r.start(); let poll = try await r.take("/jobs")
                poll.reply(["jobs": [try r.offer(["action": action, "capability": String(action.split(separator: ".")[0]), "args": args])]])
                let decline = try await r.take("/decline"); decline.reply()
                XCTAssertTrue(r.cards.offers.isEmpty); XCTAssertTrue(r.cards.providers.isEmpty)
                XCTAssertFalse(r.requests.contains { $0.request.url!.path.hasSuffix("/lease") })
                let runs = await r.executors.runs; XCTAssertEqual(runs, 0)
                await r.shutdown()
            }
        }
    }

    func testMessageBodyControlsDeclineWithoutSilentRemoval() async throws {
        for body in ["Hi\u{202e}there", "Hi\u{200d}there", "Hi\tthere", "Hi\rthere", "Hi\u{0000}there"] {
            let r = Rig(); await r.start(); let poll = try await r.take("/jobs")
            poll.reply(["jobs": [try r.offer(["action": "messages.compose", "capability": "messages", "args": ["to": ["+123"], "body": body]])]])
            let decline = try await r.take("/decline"); decline.reply()
            XCTAssertTrue(r.cards.offers.isEmpty); XCTAssertTrue(r.cards.providers.isEmpty)
            let runs = await r.executors.runs; XCTAssertEqual(runs, 0)
            await r.shutdown()
        }
    }

    func testExecutorReceivesExactlyTheDisplayedDestinations() async throws {
        for action in ["messages.compose", "calls.dial"] {
            let r = Rig(), number = " +1 (555) 010-20.30 ", body = "Hi\nthere 👋"
            let capability = String(action.split(separator: ".")[0])
            r.consent.rows.insert(capability)
            let args: [String: Any] = action == "calls.dial" ? ["number": number] : ["to": [number, "+44 (20) 1234"], "body": body]
            await r.executors.set(action == "calls.dial" ? .result(.callsDial(.init(outcome: "dialer_opened"))) : .result(.messagesCompose(.init(outcome: "opened_for_you_to_send"))))
            try await r.show(["action": action, "capability": capability, "args": args])
            let card = PhoneJobCardModel(offer: try XCTUnwrap(r.cards.offers.first), args: try XCTUnwrap(r.cards.presentedArgs), enabledWorkspaces: 1) { r.cards.answer?($0) }
            XCTAssertEqual(card.destinations.first, number)
            card.choose(true)
            let lease = try await r.take("/lease"), target = try await r.active(lease)
            target.reply(["leased": true, "expiresAt": r.now + 45000])
            let result = try await r.result(nil)
            let received = await r.executors.receivedArgs
            switch received {
            case .callsDial(let a): XCTAssertEqual(Array(a.number.utf8), Array(card.destinations[0].utf8))
            case .messagesCompose(let a):
                XCTAssertEqual(a.to.map { Array($0.utf8) }, card.destinations.map { Array($0.utf8) })
                XCTAssertEqual(Array(a.body.utf8), Array(body.utf8))
            default: XCTFail("Missing destination arguments")
            }
            result.reply(); await r.shutdown()
        }
    }

    func testOffscreenOfferCannotBlockProviderAndCardForVisibleComputer() async throws {
        let r = Rig(), other = WorkspaceOrigin(string: "https://other-" + UUID().uuidString.lowercased() + ".example.ts.net")!
        r.extraTokens[other] = "murage_pj_" + String(repeating: "b", count: 43)
        r.cards.onScreen = r.workspace; r.consent.providers.removeAll()
        RunnerURLProtocol.register(URL(string: other.serialized)!.host!) { request in Task { @MainActor in r.requests.append(request) } }
        await r.runner.start(workspaces: [r.workspace, other], visible: true)
        let first = try await r.take("/jobs"), second = try await r.take("/jobs")
        let own = first.request.url!.host == URL(string: r.workspace.serialized)!.host ? first : second
        let away = own === first ? second : first
        away.reply(["jobs": [try r.offer(["workspace": "Other"])]])
        await r.until { !r.sleeps.isEmpty }
        XCTAssertTrue(r.cards.offers.isEmpty); XCTAssertTrue(r.cards.providers.isEmpty)
        own.reply(["jobs": [try r.offer(["workspace": "Studio"])]])
        await r.until { r.cards.providers.count == 1 }
        XCTAssertEqual(r.cards.providerWorkspaces, [r.workspace]); XCTAssertEqual(r.cards.workspaceNames, ["Studio"])
        r.cards.providerAnswer?(true)
        await r.until { r.cards.offers.count == 1 }
        XCTAssertEqual(r.cards.offerWorkspaces, [r.workspace])
        await r.shutdown(); RunnerURLProtocol.remove(URL(string: other.serialized)!.host!)
    }

    func testOverlappingAuthFailuresCannotRestoreTheSameBearer() async throws {
        for status in [401, 403] {
            let r = Rig(); await r.start(); _ = try await r.take("/jobs")
            let old = r.token!
            let registration = Task { await r.runner.registration(workspace: r.workspace, method: "PUT", token: old, body: [:]) }
            let put = try await r.take("/self")
            let secondRegistration = Task { await r.runner.registration(workspace: r.workspace, method: "PUT", token: old, body: [:]) }
            let secondPut = try await r.take("/self")
            // Both requests are in flight before either response revokes the token.
            put.reply(status: status); secondPut.reply(status: status)
            _ = await registration.value; _ = await secondRegistration.value
            await r.until { r.off == 2 }
            XCTAssertNil(r.token)
            let before = r.requests.count
            r.consent.enabled = true
            await r.runner.refresh(r.workspace) // A missing saved bearer cannot unblock.
            r.token = old; await r.runner.refresh(r.workspace)
            let refused = await r.runner.registration(workspace: r.workspace, method: "PUT", token: old, body: [:])
            XCTAssertEqual(refused, 403)
            XCTAssertEqual(r.requests.count, before)
            r.token = "murage_pj_" + String(repeating: "b", count: 43)
            await r.runner.refresh(r.workspace)
            let fresh = try await r.take("/jobs")
            XCTAssertEqual(fresh.request.value(forHTTPHeaderField: "Authorization"), "Bearer " + r.token!)
            fresh.reply(["jobs": []]); await r.shutdown()
        }
    }

    func testStopAndRevokeCancelBeforeWriteAndAwaitExecutorResult() async throws {
        for revoke in [false, true] {
            let r = Rig(); await r.executors.setHold(); try await r.show()
            let lease = try await r.lease(); let target = try await r.active(lease)
            target.reply(["leased": true, "expiresAt": r.now + 45000])
            for _ in 0..<10000 { if await r.executors.runs == 1 { break }; await Task.yield() }
            let signal = await r.executors.cancellation
            XCTAssertNotNil(signal)
            if revoke { await r.runner.notice(workspace: r.workspace, status: 401, token: r.token!) }
            else { await r.runner.stop() }
            XCTAssertTrue(signal?.isCancelled == true)
            XCTAssertFalse(r.requests.contains { $0.request.url!.path.hasSuffix("/result") })
            await r.executors.complete()
            let denied = try await r.result("denied"); denied.reply()
            for _ in 0..<10000 { if await r.executors.completed == 1 { break }; await Task.yield() }
            let writes = await r.executors.writes, completed = await r.executors.completed
            XCTAssertEqual(writes, 0); XCTAssertEqual(completed, 1)
            // Give the runner its actor turn to finish without posting a second result.
            for _ in 0..<100 { await Task.yield() }
            XCTAssertEqual(r.requests.filter { $0.request.url!.path.hasSuffix("/result") }.count, 1)
            XCTAssertEqual(r.cards.used, 0)
            await r.shutdown()
        }
    }

    func testRunnerPassesOperationIdAndSeparatePreciseConsent() async throws {
        let r = Rig(); r.consent.rows.insert("precise")
        try await r.show(); let lease = try await r.lease(); let target = try await r.active(lease)
        target.reply(["leased": true, "expiresAt": r.now + 45000])
        let request = try await r.result(nil)
        let id = await r.executors.operationId, precise = await r.executors.preciseConsent
        XCTAssertEqual(id, try r.offer()["operationId"] as? String); XCTAssertTrue(precise)
        request.reply(); await r.shutdown()
    }

    func testBackgroundCannotStartAndResignActiveHasNoStop() async throws {
        let r = Rig(); await r.start(false); XCTAssertTrue(r.requests.isEmpty)
        try await r.show()
        // A second didBecomeActive after a sheet is idempotent, not a stop/start.
        await r.start(); XCTAssertTrue(r.cards.displayed)
        await r.runner.stop(); XCTAssertFalse(r.cards.displayed)
        let off = try await r.take("/foreground"); XCTAssertEqual(off.body["active"] as? Bool, false); off.reply()
        let stale = r.cards.answer; stale?(true)
        for _ in 0..<50 { await Task.yield() }
        XCTAssertFalse(r.requests.contains { $0.request.url!.path.hasSuffix("/lease") })
        await r.shutdown()
    }

    func testFourCommitChecksAndExactlyOnce() async throws {
        for check in 0..<4 {
            let r = Rig(); try await r.show(); let lease = try await r.lease(); let target = try await r.active(lease)
            switch check {
            case 0: r.consent.rows.remove("calendar")
            case 1: r.consent.providers.remove("anthropic")
            case 2: r.permission = false
            default: await r.runner.notice(workspace: r.workspace, status: 403, token: r.token!)
            }
            target.reply(["leased": true, "expiresAt": r.now + 45000])
            let result = try await r.result("denied"); result.reply()
            await r.until { !r.cards.displayed }
            let runs = await r.executors.runs; XCTAssertEqual(runs, 0)
            XCTAssertEqual(r.requests.filter { $0.request.url!.path.hasSuffix("/result") }.count, 1)
            await r.shutdown()
        }
    }

    func testMasterAndSharingRevocationAtCommit() async throws {
        for master in [true, false] {
            let r = Rig(); try await r.show(); let lease = try await r.lease(); let target = try await r.active(lease)
            if master { r.consent.enabled = false } else { r.consent.sharing = false }
            target.reply(["leased": true, "expiresAt": r.now + 45000])
            let result = try await r.result("denied"); result.reply()
            let runs = await r.executors.runs; XCTAssertEqual(runs, 0); await r.shutdown()
        }
    }

    func testLeaseInactiveDismissesWithoutResult() async throws {
        let r = Rig(); try await r.show(); let lease = try await r.lease(); lease.reply(["active": false])
        await r.until { !r.cards.displayed }; XCTAssertFalse(r.requests.contains { $0.request.url!.path.hasSuffix("/result") })
        let runs = await r.executors.runs; XCTAssertEqual(runs, 0); await r.shutdown()
    }

    func testEveryTargetedHandledReasonAndTransportFailureDenies() async throws {
        for reason in ["done", "revoked", "ended", "unknown", "timeout", "network"] {
            let r = Rig(); try await r.show(); let lease = try await r.lease(); let target = try await r.active(lease)
            if reason == "timeout" { r.now += 3001; target.fail() }
            else if reason == "network" { target.fail(.notConnectedToInternet) }
            else { target.reply(["handled": true, "reason": reason]) }
            let result = try await r.result("denied"); XCTAssertFalse(r.cards.displayed); result.reply()
            let runs = await r.executors.runs; XCTAssertEqual(runs, 0); await r.shutdown()
        }
    }

    func testAuthNoticesRevokeTokenAndStopPollAndHeldLease() async throws {
        for status in [401, 403] {
            let r = Rig(); try await r.show(); let lease = try await r.lease(); let target = try await r.active(lease)
            target.reply(status: status)
            let result = try await r.result("denied"); XCTAssertNil(r.token); XCTAssertFalse(r.consent.enabled); XCTAssertFalse(r.cards.displayed)
            result.reply(status: status)
            await r.until { r.off >= 2 }
            let runs = await r.executors.runs; XCTAssertEqual(runs, 0)
            XCTAssertEqual(r.requests.filter { $0.request.url!.path.hasSuffix("/result") }.count, 1)
            await r.shutdown()
        }
    }

    func testProviderAllowNotNowKnownAndInvalidArgs() async throws {
        for allow in [true, false] {
            let r = Rig(); r.consent.providers = []; try await r.show()
            XCTAssertEqual(r.cards.providers, ["Anthropic"]); XCTAssertTrue(r.cards.offers.isEmpty)
            r.cards.providerAnswer?(allow)
            if allow { await r.until { r.cards.offers.count == 1 }; XCTAssertTrue(r.consent.providers.contains("anthropic")) }
            else { let decline = try await r.take("/decline"); decline.reply(); XCTAssertTrue(r.cards.offers.isEmpty) }
            await r.shutdown()
        }
        let r = Rig(); await r.start(); let poll = try await r.take("/jobs")
        poll.reply(["jobs": [try r.offer(["args": ["extra": true]])]])
        let decline = try await r.take("/decline"); decline.reply()
        XCTAssertTrue(r.cards.offers.isEmpty); XCTAssertTrue(r.cards.providers.isEmpty); await r.shutdown()
    }

    func testPushOnlyResolvesItsOfferAndAllHandledReasonsAndLeased() async throws {
        for reason in ["offer", "leased", "done", "revoked", "ended", "unknown"] {
            let r = Rig(); let ref = String(repeating: "f", count: 64)
            await r.runner.open(workspace: r.workspace, eventRef: ref); XCTAssertTrue(r.requests.isEmpty)
            let body: [String: Any]
            if reason == "offer" { body = ["jobs": [try r.offer()]] }
            else if reason == "leased" { body = ["leased": true, "expiresAt": r.now + 45000] }
            else { body = ["handled": true, "reason": reason] }
            // start() awaits the targeted response. Reply from the protocol callback,
            // not after awaiting start(), which would wait for the 25-second timeout.
            RunnerURLProtocol.register(URL(string: r.workspace.serialized)!.host!) { request in
                Task { @MainActor in
                    r.requests.append(request)
                    if request.request.url?.query == nil { request.reply(["jobs": []]); return }
                    XCTAssertEqual(request.request.httpMethod, "GET")
                    XCTAssertEqual(request.request.url?.path, "/api/phones/self/jobs")
                    XCTAssertEqual(request.request.url?.query, "eventRef=" + ref)
                    request.reply(body)
                }
            }
            await r.start() // Completion includes parsing and the MainActor presenter hop.
            XCTAssertEqual(r.requests.filter { $0.request.url?.query != nil }.count, 1)
            if reason == "offer" {
                XCTAssertEqual(r.cards.offers.count, 1)
                XCTAssertEqual(r.cards.offers.first?.operationId, try r.offer()["operationId"] as? String)
            } else if reason == "leased" { XCTAssertFalse(r.cards.displayed) }
            else { XCTAssertEqual(r.cards.handled, 1) }
            if reason != "leased" { XCTAssertFalse(r.requests.contains { $0.request.url!.path.hasSuffix("/jobs") && $0.request.url!.query == nil }) }
            RunnerURLProtocol.register(URL(string: r.workspace.serialized)!.host!) { request in request.reply() }
            await r.shutdown()
        }
    }

    func testAS8LateLeaseAfterBackgroundDeniesOnce() async throws {
        let r = Rig(); try await r.show(); let lease = try await r.lease()
        await r.runner.stop(); XCTAssertFalse(r.cards.displayed)
        lease.reply(["active": true, "leaseToken": String(repeating: "L", count: 43)])
        let result = try await r.result("denied"); result.reply()
        let runs = await r.executors.runs; XCTAssertEqual(runs, 0)
        XCTAssertEqual(r.requests.filter { $0.request.url!.path.hasSuffix("/result") }.count, 1); await r.shutdown()
    }

    func testAS8LostForegroundOffReoffersWithNewRevisionOnly() async throws {
        let r = Rig(); try await r.show(); let old = r.cards.answer
        await r.runner.stop(); let off = try await r.take("/foreground"); off.fail(.notConnectedToInternet)
        await r.start(); let poll = try await r.take("/jobs")
        let newID = "a1b2c3d4-0000-4000-8000-000000000002"
        poll.reply(["jobs": [try r.offer(["offerId": newID])]])
        await r.until { r.cards.offers.count == 2 }
        old?(true); let lease = try await r.lease(); XCTAssertEqual(lease.body["offerId"] as? String, newID)
        lease.reply(["active": false]); await r.shutdown()
    }

    func testAS8Restart409RetainsOnlyUntilCloseAndNeverRetries() async throws {
        let r = Rig(); try await r.show(); let lease = try await r.lease(); let target = try await r.active(lease)
        target.reply(["leased": true, "expiresAt": r.now + 45000])
        let result = try await r.result(nil); result.reply(status: 409)
        await r.until { r.cards.handled == 1 }; r.tick()
        XCTAssertEqual(r.cards.used, 0)
        XCTAssertEqual(r.requests.filter { $0.request.url!.path.hasSuffix("/result") }.count, 1)
        let runs = await r.executors.runs; XCTAssertEqual(runs, 1)
        r.cards.close?(); await r.until { !r.cards.displayed }; await r.shutdown()
    }

    func testSuccessfulRunShowsUsedLineUntilCloseWithoutPostingAgain() async throws {
        let r = Rig(); r.cards.heldUsed = true
        try await r.show(); let lease = try await r.lease(); let target = try await r.active(lease)
        target.reply(["leased": true, "expiresAt": r.now + 45000])
        let result = try await r.result(nil); result.reply()
        await r.until { r.cards.used == 1 }
        XCTAssertTrue(r.cards.displayed); XCTAssertEqual(r.cards.handled, 0)
        r.tick(); XCTAssertEqual(r.requests.filter { $0.request.url!.path.hasSuffix("/result") }.count, 1)
        r.cards.close?(); await r.until { !r.cards.displayed }; await r.shutdown()
    }

    func testBackgroundWhilePostingCannotShowUsedLine() async throws {
        let r = Rig(); try await r.show(); let lease = try await r.lease(); let target = try await r.active(lease)
        target.reply(["leased": true, "expiresAt": r.now + 45000])
        let result = try await r.result(nil)
        await r.runner.stop(); result.reply()
        await r.shutdown()
        XCTAssertFalse(r.cards.displayed); XCTAssertEqual(r.cards.used, 0)
    }

    func testAS8RegistrationRevokedAfterReconnectRequiresFreshEnable() async throws {
        let r = Rig(); await r.start(); _ = try await r.take("/jobs")
        let oldToken = r.token!
        let registration = Task { await r.runner.registration(workspace: r.workspace, method: "PUT", token: r.token!, body: [:]) }
        let put = try await r.take("/self"); put.reply(["error": "revoked"], status: 403)
        let status = await registration.value; XCTAssertEqual(status, 403); XCTAssertNil(r.token); XCTAssertFalse(r.consent.enabled)
        await r.runner.stop(); let before = r.requests.count; await r.start(); r.tick()
        let blocked = await r.runner.registration(workspace: r.workspace, method: "PUT", token: oldToken, body: [:])
        XCTAssertEqual(blocked, 403)
        for _ in 0..<50 { await Task.yield() }
        XCTAssertEqual(r.requests.count, before)
        r.consent.enabled = true; r.token = "murage_pj_" + String(repeating: "b", count: 43)
        await r.runner.refresh(r.workspace); let poll = try await r.take("/jobs")
        XCTAssertEqual(poll.request.value(forHTTPHeaderField: "Authorization"), "Bearer " + r.token!)
        await r.shutdown()
    }

    func testOneExecutorAcrossWorkspacesAndBackgroundReopen() async throws {
        let r = Rig()
        let other = WorkspaceOrigin(string: "https://other-" + UUID().uuidString.lowercased() + ".example.ts.net")!
        r.extraTokens[other] = "murage_pj_" + String(repeating: "b", count: 43)
        RunnerURLProtocol.register(URL(string: other.serialized)!.host!) { request in Task { @MainActor in r.requests.append(request) } }
        await r.runner.start(workspaces: [r.workspace, other], visible: true)
        let first = try await r.take("/jobs"), second = try await r.take("/jobs")
        first.reply(["jobs": [try r.offer()]])
        await r.until { r.cards.offers.count == 1 }
        await r.executors.setHold()
        let lease = try await r.lease(); let target = try await r.active(lease)
        target.reply(["leased": true, "expiresAt": r.now + 45000])
        for _ in 0..<10000 { if await r.executors.runs == 1 { break }; await Task.yield() }
        second.reply(["jobs": [try r.offer(["operationId": "a1b2c3d4-0000-4000-8000-000000000001"])]])
        await r.runner.stop()
        XCTAssertFalse(r.requests.contains { $0.request.url!.path.hasSuffix("/result") })
        await r.start()
        XCTAssertEqual(r.cards.offers.count, 1)
        let runs = await r.executors.runs; XCTAssertEqual(runs, 1)
        await r.executors.complete()
        let result = try await r.result("denied"); result.reply()
        XCTAssertEqual(r.requests.filter { $0.request.url!.path.hasSuffix("/result") }.count, 1)
        for request in r.requests {
            let token = request.request.url!.host == URL(string: other.serialized)!.host ? r.extraTokens[other]! : r.token!
            XCTAssertEqual(request.request.value(forHTTPHeaderField: "Authorization"), "Bearer " + token)
        }
        await r.shutdown(); RunnerURLProtocol.remove(URL(string: other.serialized)!.host!)
    }

    func testClockExpiryAndNotNowNeverExecute() async throws {
        let r = Rig(); await r.start(); let poll = try await r.take("/jobs")
        poll.reply(["jobs": [try r.offer(["expiresAt": r.now - 180_001])]])
        for _ in 0..<100 { await Task.yield() }
        XCTAssertTrue(r.cards.offers.isEmpty)
        await r.shutdown()
        let declined = Rig(); try await declined.show(); declined.cards.answer?(false)
        let decline = try await declined.take("/decline"); decline.reply()
        XCTAssertFalse(declined.requests.contains { $0.request.url!.path.hasSuffix("/lease") })
        let runs = await declined.executors.runs; XCTAssertEqual(runs, 0); await declined.shutdown()
    }

    func testInvalidOutputAndExecutorErrorAreEncodedOnce() async throws {
        for output in [PhoneJobExecution.result(.calendarAdd(.init(id: "event", writeOnly: false))), .error(code: "unsupported")] {
            let r = Rig(); await r.executors.set(output); try await r.show()
            let lease = try await r.lease(); let target = try await r.active(lease)
            target.reply(["leased": true, "expiresAt": r.now + 45000])
            let result = try await r.take("/result")
            XCTAssertEqual(result.body["ok"] as? Bool, false)
            XCTAssertTrue(["invalid_result", "unsupported"].contains(result.body["code"] as? String ?? "")); result.reply()
            await r.shutdown()
        }
    }
    func testStopAndBothAuthStatusesAfterWriteStartPostRealOutcome() async throws {
        for status in [0, 401, 403] {
            let r = Rig(); r.consent.rows.insert("alarms")
            await r.executors.setHold(); await r.executors.set(.result(.alarmsSet(.init(outcome: "set"))))
            try await r.show(["action": "alarms.set", "capability": "alarms", "args": ["hour": 7, "minute": 5, "label": "Wake"]])
            let lease = try await r.lease(); let target = try await r.active(lease)
            target.reply(["leased": true, "expiresAt": r.now + 45000])
            for _ in 0..<10000 { if await r.executors.runs == 1 { break }; await Task.yield() }
            let captured = await r.executors.cancellation
            let signal = try XCTUnwrap(captured)
            try signal.beginWrite()
            if status == 0 { await r.runner.stop() }
            else { await r.runner.notice(workspace: r.workspace, status: status, token: r.token!) }
            XCTAssertFalse(signal.isCancelled)
            XCTAssertFalse(r.requests.contains { $0.request.url!.path.hasSuffix("/result") })
            await r.executors.complete()
            let result = try await r.result(nil); result.reply()
            for _ in 0..<100 { await Task.yield() }
            XCTAssertEqual(r.requests.filter { $0.request.url!.path.hasSuffix("/result") }.count, 1)
            XCTAssertEqual(r.cards.used, 0)
            await r.shutdown()
        }
    }

    func testPushTerminalOutcomesAndPresentationFailuresResumePolling() async throws {
        for outcome in ["leased", "network", "http", "malformed", "expired", "decode", "offscreen", "card", "provider"] {
            let r = Rig(), ref = String(repeating: "f", count: 64)
            await r.runner.open(workspace: r.workspace, eventRef: ref)
            let start = Task { await r.start() }
            let target = try await r.take("/jobs?eventRef=" + ref)
            if outcome == "card" || outcome == "provider" { r.cards.failPresentation = true }
            if outcome == "provider" { r.consent.providers = [] }
            if outcome == "offscreen" { r.cards.onScreen = WorkspaceOrigin(string: "https://other.example.ts.net")! }
            switch outcome {
            case "network": target.fail(.notConnectedToInternet)
            case "http": target.reply(status: 500)
            case "malformed": target.reply(["unexpected": true])
            case "leased": target.reply(["leased": true, "expiresAt": r.now + 45000])
            case "expired": target.reply(["jobs": [try r.offer(["expiresAt": r.now - 180_001])]])
            case "decode": target.reply(["jobs": [try r.offer(["args": ["extra": true]])]])
            default: target.reply(["jobs": [try r.offer()]])
            }
            if outcome == "decode" { let decline = try await r.take("/decline"); decline.reply() }
            await start.value
            let poll = try await r.take("/jobs")
            XCTAssertNil(poll.request.url?.query)
            r.cards.failPresentation = false; r.cards.onScreen = nil; r.consent.providers = ["anthropic"]
            poll.reply(["jobs": [try r.offer()]])
            await r.until { r.cards.offers.count == 1 }
            XCTAssertFalse(r.requests.contains { $0.request.url!.path.hasSuffix("/lease") })
            await r.shutdown()
        }
    }

    func testTwoMinuteClockSkewStillShowsAndExecutesAfterLeaseCheck() async throws {
        let r = Rig(); let serverNow = r.now; r.now += 120_000
        try await r.show(["expiresAt": serverNow + 30_000])
        let lease = try await r.lease(); let target = try await r.active(lease)
        target.reply(["leased": true, "expiresAt": serverNow + 45_000])
        let result = try await r.result(nil); result.reply(); await r.shutdown()
    }

}
