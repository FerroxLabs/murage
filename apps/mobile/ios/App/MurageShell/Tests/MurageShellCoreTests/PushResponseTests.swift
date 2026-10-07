import XCTest
@testable import MurageShellCore

/// I5: what Approve, Deny, a tap and opening the app do, on fakes.
final class PushResponseTests: XCTestCase {

    let binding = "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3"
    let other = "0a6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3"
    let originText = "https://mac.tailnet123.ts.net"
    var origin: WorkspaceOrigin { WorkspaceOrigin(string: originText)! }
    let ref = String(repeating: "9", count: 64)
    let detailToken = "murage_pd_" + String(repeating: "d", count: 43)
    let respondToken = "murage_pr_" + String(repeating: "r", count: 43)

    func payload(_ category: String = "approval", binding: String? = nil, key: String = String(repeating: "b", count: 32), revision: Int = 3) -> PushPayload {
        PushPayload.parse(["bindingId": binding ?? self.binding, "eventRef": ref, "category": category, "revision": revision,
                           "workspaceBadge": 1, "collapseKey": key])!
    }

    /// Records every request and answers from a script keyed by path.
    final class Net {
        var seen: [URLRequest] = []
        var answers: [String: (Int?, Any?)] = [:]
        func send(_ r: URLRequest) async -> (Int?, Any?) {
            seen.append(r)
            return answers[r.url!.path] ?? (nil, nil)
        }
        var paths: [String] { seen.map { $0.url!.path } }
    }

    var detailPath: String { "/api/mobile/push/" + ref }
    let detailBody: [String: Any] = ["title": "Lena needs approval", "body": "Delete 3 files", "target": ["threadId": "t1", "requestId": "req-1"]]

    func answer(_ net: Net, _ p: PushPayload? = nil, decision: String = "allow", detail: String? = nil, respond: String?? = .none) async -> PushNotice {
        let r: String? = respond ?? respondToken
        return await PushResponse.answer(payload: p ?? payload(), origin: origin, decision: decision,
                                         detailToken: { detail ?? self.detailToken }, respondToken: { r }, send: net.send)
    }

    // MARK: actions

    func testTheIdentifiersMapToDecisions() {
        XCTAssertEqual(PushResponse.action("APPROVE"), .answer(decision: "allow"))
        XCTAssertEqual(PushResponse.action("DENY"), .answer(decision: "deny"))
        XCTAssertEqual(PushResponse.action("OPEN"), .open)
        XCTAssertEqual(PushResponse.action("com.apple.UNNotificationDefaultActionIdentifier"), .open)
        XCTAssertEqual(PushResponse.action("com.apple.UNNotificationDismissActionIdentifier"), .open)
    }

    func testApproveReadsTheRequestThenPostsTheStrictBodyWithTheRespondToken() async {
        let net = Net()
        net.answers = [detailPath: (200, detailBody), "/api/mobile/push/respond": (200, ["ok": true, "outcome": "allowed"])]
        let notice = await answer(net)
        XCTAssertEqual(notice, .approved)
        XCTAssertEqual(net.paths, [detailPath, "/api/mobile/push/respond"])
        XCTAssertEqual(net.seen[0].value(forHTTPHeaderField: "Authorization"), "Bearer " + detailToken)
        let post = net.seen[1]
        XCTAssertEqual(post.httpMethod, "POST")
        XCTAssertEqual(post.url?.absoluteString, originText + "/api/mobile/push/respond")
        XCTAssertEqual(post.value(forHTTPHeaderField: "Authorization"), "Bearer " + respondToken)
        XCTAssertEqual(post.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(String(data: post.httpBody!, encoding: .utf8), #"{"decision":"allow","requestId":"req-1","revision":3}"#)
    }

    func testDenyPostsDeny() async {
        let net = Net()
        net.answers = [detailPath: (200, detailBody), "/api/mobile/push/respond": (200, ["ok": true, "outcome": "denied"])]
        do { let got = await answer(net, decision: "deny"); XCTAssertEqual(got, .denied) }
        let body = try! JSONSerialization.jsonObject(with: net.seen[1].httpBody!) as! [String: Any]
        XCTAssertEqual(body["decision"] as? String, "deny")
    }

    func testTheHostsAnswersBecomeTheirNotices() async {
        let cases: [(Int?, Any?, PushNotice)] = [
            (502, ["code": "unavailable"], .unreachable),        // answer() failed at the host
            (503, ["error": "x"], .unreachable),                 // the door without its companion
            (nil, nil, .unreachable),                            // Tailscale off, a timeout
            (403, ["code": "step_up"], .stepUp),
            (409, ["code": "already_answered"], .alreadyAnswered),
            (409, ["code": "stale"], .openApp),
            (404, ["code": "unavailable"], .openApp),
            (401, ["error": "sign in"], .openApp),
            (302, nil, .openApp),                                // a refused redirect
        ]
        for (status, body, expected) in cases {
            let net = Net()
            net.answers = [detailPath: (200, detailBody), "/api/mobile/push/respond": (status, body)]
            do { let got = await answer(net); XCTAssertEqual(got, expected, "\(String(describing: status))") }
        }
    }

    func testAnUnreachableDetailSaysCouldNotReachAndPostsNothing() async {
        for status: Int? in [nil, 502, 504] {
            let net = Net()
            net.answers = [detailPath: (status, nil)]
            do { let got = await answer(net); XCTAssertEqual(got, .unreachable) }
            XCTAssertEqual(net.paths, [detailPath])
        }
        XCTAssertEqual(PushNotice.unreachable.text.body, "Couldn't reach your Murage, open the app.")
    }

    func testADetailWithoutARequestOpensTheApp() async {
        for (status, body) in [(404, ["code": "unavailable"]), (200, ["title": "x", "body": "y", "target": ["threadId": "t1"]]), (200, [:])] as [(Int, [String: Any])] {
            let net = Net()
            net.answers = [detailPath: (status, body)]
            do { let got = await answer(net); XCTAssertEqual(got, .openApp) }
            XCTAssertEqual(net.paths, [detailPath])
        }
    }

    func testMissingOrMalformedTokensOpenTheAppWithoutPosting() async {
        let net = Net()
        net.answers = [detailPath: (200, detailBody)]
        do { let got = await answer(net, respond: .some(nil)); XCTAssertEqual(got, .openApp) }       // locked or never issued
        do { let got = await answer(net, respond: .some("murage_pd_" + String(repeating: "r", count: 43))); XCTAssertEqual(got, .openApp) }
        // A missing respond token is caught before any read; a malformed one after the detail read.
        XCTAssertEqual(net.paths, [detailPath])
        let none = Net()
        do { let got = await answer(none, detail: "not-a-token"); XCTAssertEqual(got, .openApp) }
        XCTAssertTrue(none.seen.isEmpty)
    }

    func testOnlyApprovalsAreAnsweredAndARiskyOneIsNeverApproved() async {
        let net = Net()
        do { let got = await answer(net, payload("question")); XCTAssertEqual(got, .openApp) }
        do { let got = await answer(net, payload("done"), decision: "deny"); XCTAssertEqual(got, .openApp) }
        do { let got = await answer(net, payload("approval-open")); XCTAssertEqual(got, .stepUp) }
        XCTAssertTrue(net.seen.isEmpty)
        net.answers = [detailPath: (200, detailBody), "/api/mobile/push/respond": (200, ["ok": true, "outcome": "denied"])]
        do { let got = await answer(net, payload("approval-open"), decision: "deny"); XCTAssertEqual(got, .denied) }
    }

    func testAHostThatCouldNotDeliverTheDecisionOpensTheApp() async {
        let net = Net()
        net.answers = [detailPath: (200, detailBody), "/api/mobile/push/respond": (200, ["ok": true, "outcome": "unavailable"])]
        do { let got = await answer(net); XCTAssertEqual(got, .openApp) }
    }

    // MARK: the request builders

    func testTheRespondBuilderRefusesWhatTheDoorWould() {
        let ok = PushResponse.respondRequest(origin: origin, token: respondToken, requestId: "req-1", decision: "allow", revision: 1)
        XCTAssertNotNil(ok)
        XCTAssertNotNil(PushResponse.respondRequest(origin: origin, token: respondToken, requestId: String(repeating: "x", count: 256), decision: "deny", revision: 1))
        for (token, id, decision, revision) in [
            (detailToken, "req-1", "allow", 1),                   // the wrong scope
            ("murage_pr_short", "req-1", "allow", 1),
            (respondToken + "\r\nX: y", "req-1", "allow", 1),     // no header injection
            (respondToken, "", "allow", 1),
            (respondToken, String(repeating: "x", count: 257), "allow", 1),
            (respondToken, "req\u{0}1", "allow", 1),
            (respondToken, "req\n1", "allow", 1),
            (respondToken, "req\u{7f}", "allow", 1),
            (respondToken, "req-1", "approve", 1),
            (respondToken, "req-1", "allow", 0),
        ] {
            XCTAssertNil(PushResponse.respondRequest(origin: origin, token: token, requestId: id, decision: decision, revision: revision), "\(id) \(decision) \(revision)")
        }
    }

    func testTheRespondAddressIsTheCanonicalOriginOnly() {
        let port = WorkspaceOrigin(string: "https://mac.tailnet123.ts.net:8444")!
        XCTAssertEqual(PushResponse.respondRequest(origin: port, token: respondToken, requestId: "r", decision: "deny", revision: 2)?.url?.absoluteString,
                       "https://mac.tailnet123.ts.net:8444/api/mobile/push/respond")
        XCTAssertEqual(PushResponse.origin(originText), origin)
        for bad in ["http://mac.tailnet123.ts.net", "https://mac.tailnet123.ts.net/", "https://MAC.tailnet123.ts.net",
                    "https://mac.tailnet123.ts.net:443", "https://user@mac.tailnet123.ts.net", "https://evil.example/x?", "", nil] as [String?] {
            XCTAssertNil(PushResponse.origin(bad), String(describing: bad))
        }
    }

    func testThePendingAndDetailBuildersNeedADetailToken() {
        XCTAssertEqual(PushResponse.pendingRequest(origin: origin, token: detailToken)?.url?.absoluteString, originText + "/api/mobile/push/pending")
        XCTAssertEqual(PushResponse.pendingRequest(origin: origin, token: detailToken)?.httpMethod, "GET")
        XCTAssertNil(PushResponse.pendingRequest(origin: origin, token: respondToken))
        XCTAssertNil(PushResponse.detailRequest(origin: origin, eventRef: "pending", token: detailToken))
        XCTAssertNil(PushResponse.detailRequest(origin: origin, eventRef: ref, token: respondToken))
    }

    // MARK: taps

    func testATapUsesTheSavedTargetWithoutAFetch() async {
        let net = Net()
        let t = await PushResponse.open(payload: payload(), origin: origin, userInfo: ["murageTarget": ["threadId": "t1", "messageId": "m1", "requestId": "r"]],
                                        detailToken: { self.detailToken }, send: net.send)
        XCTAssertEqual(t, PushTarget(threadId: "t1", messageId: "m1", requestId: nil))
        XCTAssertTrue(net.seen.isEmpty)
    }

    func testATapWithoutASavedTargetReadsTheDetailOnce() async {
        let net = Net()
        net.answers = [detailPath: (200, detailBody)]
        let t = await PushResponse.open(payload: payload(), origin: origin, userInfo: [:], detailToken: { self.detailToken }, send: net.send)
        XCTAssertEqual(t?.threadId, "t1")
        XCTAssertEqual(net.paths, [detailPath])
        let offline = Net()
        let none = await PushResponse.open(payload: payload(), origin: origin, userInfo: [:], detailToken: { self.detailToken }, send: offline.send)
        XCTAssertNil(none)
    }

    func testASavedTargetThatIsNotAnIdIsIgnored() {
        XCTAssertNil(PushResponse.tapTarget(userInfo: ["murageTarget": ["threadId": ""]]))
        XCTAssertNil(PushResponse.tapTarget(userInfo: ["murageTarget": ["messageId": "m1"]]))
        XCTAssertNil(PushResponse.tapTarget(userInfo: ["murageTarget": "t1"]))
        XCTAssertNil(PushResponse.tapTarget(userInfo: ["murageTarget": ["threadId": String(repeating: "x", count: OpenHash.maxIdLength + 1)]]))
        XCTAssertEqual(PushResponse.tapTarget(userInfo: ["murageTarget": ["threadId": "t1", "messageId": ""]]), PushTarget(threadId: "t1", messageId: nil, requestId: nil))
    }

    // MARK: reconciliation

    func testReconcileRemovesWhatWasAnsweredElsewhereAndCorrectsEachCount() async {
        let second = "https://studio.tailnet123.ts.net:8444"
        var l = PushLedger()
        l.bind(binding, origin: originText)
        l.bind(other, origin: second)
        _ = l.accept(binding, collapseKey: String(repeating: "a", count: 32), revision: 1, workspaceBadge: 5)
        _ = l.accept(other, collapseKey: String(repeating: "c", count: 32), revision: 1, workspaceBadge: 4)
        let ledger = PushExtensionTests.Memory(l)
        let info = { (b: String, key: Character) -> [AnyHashable: Any] in
            ["murage": ["bindingId": b, "eventRef": self.ref, "category": "approval", "revision": 1, "workspaceBadge": 1, "collapseKey": String(repeating: key, count: 32)]]
        }
        let delivered = [
            PushResponse.Delivered(identifier: "n-a", userInfo: info(binding, "a")),     // answered on the desktop
            PushResponse.Delivered(identifier: "n-b", userInfo: info(binding, "b")),     // still waiting
            PushResponse.Delivered(identifier: "n-c", userInfo: info(other, "c")),       // its workspace is unreachable
            PushResponse.Delivered(identifier: "n-x", userInfo: ["aps": [:]]),
        ]
        let net = Net()
        net.answers = ["/api/mobile/push/pending": (200, ["badge": 1, "items": [["collapseKey": String(repeating: "b", count: 32), "revision": 1, "category": "approval"]]])]
        var tokens: [String] = []
        let out = await PushResponse.reconcile(ledger: ledger, delivered: delivered, detailToken: { b in
            tokens.append(b)
            return b == self.binding ? self.detailToken : nil  // the second has no token: skipped, keeps its count
        }, send: net.send)
        XCTAssertEqual(tokens, [binding, other])
        XCTAssertEqual(net.seen.map { $0.url!.absoluteString }, [originText + "/api/mobile/push/pending"])
        XCTAssertEqual(out.remove, ["n-a"])
        XCTAssertEqual(out.total, 1 + 4)
    }

    /// Final review I2: a retired or forgotten binding's notifications go with
    /// it, as Android's PushReconciler.cancelFor does.
    func testTheNotificationsOfADroppedBindingAreFoundByBindingOnly() {
        let info = { (b: String) -> [AnyHashable: Any] in
            ["murage": ["bindingId": b, "eventRef": self.ref, "category": "approval", "revision": 1, "workspaceBadge": 1, "collapseKey": String(repeating: "a", count: 32)]]
        }
        let delivered = [
            PushResponse.Delivered(identifier: "n-old", userInfo: info(binding)),
            PushResponse.Delivered(identifier: "n-keep", userInfo: info(other)),
            PushResponse.Delivered(identifier: "n-x", userInfo: ["aps": [:], "bindingId": binding]),
        ]
        XCTAssertEqual(PushResponse.delivered(delivered, of: [binding]), ["n-old"])
        XCTAssertEqual(PushResponse.delivered(delivered, of: []), [])
        XCTAssertEqual(PushResponse.unbound(delivered, bound: [other], keep: []), ["n-old"])
        XCTAssertEqual(PushResponse.unbound(delivered, bound: [other], keep: [binding]), [])
    }

    /// Final review I2: reconcile clears what belongs to no binding the phone
    /// holds (a re-pair retired it), keeps a pending replace's, and never
    /// touches a notification that is not Murage's.
    func testReconcileRemovesNotificationsOfBindingsThePhoneNoLongerHolds() async {
        let retired = "1b6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3"
        let waiting = "2c6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3"
        var l = PushLedger()
        l.bind(binding, origin: originText)
        let info = { (b: String, key: Character) -> [AnyHashable: Any] in
            ["murage": ["bindingId": b, "eventRef": self.ref, "category": "approval", "revision": 1, "workspaceBadge": 1, "collapseKey": String(repeating: key, count: 32)]]
        }
        let delivered = [
            PushResponse.Delivered(identifier: "n-live", userInfo: info(binding, "b")),
            PushResponse.Delivered(identifier: "n-retired", userInfo: info(retired, "c")),
            PushResponse.Delivered(identifier: "n-waiting", userInfo: info(waiting, "d")),
            PushResponse.Delivered(identifier: "n-x", userInfo: ["aps": [:]]),
        ]
        let net = Net()
        net.answers = ["/api/mobile/push/pending": (200, ["badge": 1, "items": [["collapseKey": String(repeating: "b", count: 32), "revision": 1, "category": "approval"]]])]
        var kept = 0
        let out = await PushResponse.reconcile(ledger: PushExtensionTests.Memory(l), delivered: delivered, detailToken: { _ in self.detailToken },
                                               keep: { kept += 1; return [waiting] }, send: net.send)
        XCTAssertEqual(out.remove, ["n-retired"])
        XCTAssertEqual(kept, 1)
        XCTAssertEqual(out.total, 1)

        // Even when the bound computer cannot answer, the unbound still go.
        let down = Net()
        down.answers = ["/api/mobile/push/pending": (nil, nil)]
        let offline = await PushResponse.reconcile(ledger: PushExtensionTests.Memory(l), delivered: delivered, detailToken: { _ in self.detailToken },
                                                   send: down.send)
        XCTAssertEqual(offline.remove, ["n-retired", "n-waiting"])
    }

    func testReconcileKeepsEverythingWhenAWorkspaceCannotAnswer() async {
        var l = PushLedger()
        l.bind(binding, origin: originText)
        _ = l.accept(binding, collapseKey: String(repeating: "a", count: 32), revision: 1, workspaceBadge: 3)
        for (status, body) in [(nil, nil), (502, ["code": "unavailable"]), (200, ["badge": 1]), (200, ["badge": -1, "items": []]), (200, "x")] as [(Int?, Any?)] {
            let net = Net()
            net.answers = ["/api/mobile/push/pending": (status, body)]
            let delivered = [PushResponse.Delivered(identifier: "n-a", userInfo: ["murage": ["bindingId": binding, "eventRef": ref, "category": "approval", "revision": 1, "workspaceBadge": 1, "collapseKey": String(repeating: "a", count: 32)]])]
            let out = await PushResponse.reconcile(ledger: PushExtensionTests.Memory(l), delivered: delivered, detailToken: { _ in self.detailToken }, send: net.send)
            XCTAssertEqual(out.remove, [], String(describing: status))
            XCTAssertEqual(out.total, 3)
        }
    }

    func testReconcileNeverSendsATokenToANonCanonicalOrigin() async {
        var l = PushLedger()
        l.bind(binding, origin: "https://evil.example/steal?x=")
        let net = Net()
        let out = await PushResponse.reconcile(ledger: PushExtensionTests.Memory(l), delivered: [], detailToken: { _ in self.detailToken }, send: net.send)
        XCTAssertTrue(net.seen.isEmpty)
        XCTAssertEqual(out.total, 0)
    }

    func testAnUnreadableLedgerReconcilesNothing() async {
        let net = Net()
        let out = await PushResponse.reconcile(ledger: PushExtensionTests.Memory(nil), delivered: [], detailToken: { _ in self.detailToken }, send: net.send)
        XCTAssertTrue(net.seen.isEmpty)
        XCTAssertNil(out.total)
    }

    func testThePendingParserSkipsBadItemsAndRefusesBadLists() {
        let good = String(repeating: "b", count: 32)
        let parsed = PushResponse.pending(status: 200, body: ["badge": 2, "items": [["collapseKey": good, "revision": 2], ["collapseKey": "B", "revision": 1], ["collapseKey": good, "revision": 0]]])
        XCTAssertEqual(parsed?.badge, 2)
        XCTAssertEqual(parsed?.items.map(\.0), [good])
        XCTAssertNil(PushResponse.pending(status: 200, body: ["badge": true, "items": []]))
        XCTAssertNil(PushResponse.pending(status: 404, body: ["badge": 1, "items": []]))
        XCTAssertNil(PushResponse.pending(status: 200, body: ["badge": 1, "items": Array(repeating: ["collapseKey": good, "revision": 1], count: PushLedger.seenLimit + 1)]))
    }

    // MARK: the real send (redirects refused, as the extension's detail read)

    func testTheRespondPostNeverFollowsARedirect() async {
        typealias Stub = PushExtensionTests.Stub
        Stub.answer = { _ in .success((200, Data(#"{"ok":true,"outcome":"allowed"}"#.utf8))) }
        Stub.seen = nil
        Stub.requests = 0
        Stub.headers = [:]
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [Stub.self]
        let session = URLSession(configuration: config)
        defer { Stub.redirect = nil }
        Stub.redirect = URL(string: "https://evil.example/api/mobile/push/respond")
        let request = PushResponse.respondRequest(origin: origin, token: respondToken, requestId: "req-1", decision: "allow", revision: 1)!
        let (status, _) = await PushExtension.send(request, session: session)
        XCTAssertEqual(status, 302)
        XCTAssertEqual(Stub.requests, 1)
        XCTAssertEqual(Stub.seen?.url?.host, "mac.tailnet123.ts.net")
        XCTAssertEqual(PushOutcome.notice(status: status, body: nil, decision: "allow"), .openApp)
    }
}
