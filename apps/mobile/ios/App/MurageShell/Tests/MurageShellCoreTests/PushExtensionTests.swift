import XCTest
@testable import MurageShellCore

final class PushExtensionTests: XCTestCase {
    final class Memory: LedgerAccess {
        var ledger: PushLedger?
        init(_ ledger: PushLedger?) { self.ledger = ledger }
        func read() -> PushLedger? { ledger }
        func update<T>(_ change: (inout PushLedger) -> T) -> T? { guard var l = ledger else { return nil }; let out = change(&l); ledger = l; return out }
    }
    let binding = "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3"
    var info: [AnyHashable: Any] {
        ["aps": [:], "murage": ["bindingId": binding, "eventRef": String(repeating: "9", count: 64), "category": "approval", "revision": 1, "workspaceBadge": 2, "collapseKey": String(repeating: "b", count: 32)]]
    }
    func bound() -> PushLedger { var l = PushLedger(); l.bind(binding, origin: "https://mac.tailnet123.ts.net"); return l }

    func testRewritesWithTheDetailAndCarriesTheTarget() async {
        var asked: URL?
        let out = await PushExtension.rewrite(userInfo: info, ledger: Memory(bound()), detailToken: { _ in "murage_pd_x" }) { url, token in
            asked = url
            XCTAssertEqual(token, "murage_pd_x")
            return (200, ["title": "Lena needs approval", "body": "Lena wants to delete 3 files", "target": ["threadId": "t1", "requestId": "req-1"]])
        }
        XCTAssertEqual(asked?.absoluteString, "https://mac.tailnet123.ts.net/api/mobile/push/" + String(repeating: "9", count: 64))
        XCTAssertEqual(out, PushRewrite(title: "Lena needs approval", body: "Lena wants to delete 3 files", badge: 2, target: PushTarget(threadId: "t1", messageId: nil, requestId: "req-1")))
    }

    func testBeforeFirstUnlockIsGenericWithNoBadgeAndNoFetch() async {
        let out = await PushExtension.rewrite(userInfo: info, ledger: Memory(nil), detailToken: { _ in "t" }) { _, _ in XCTFail("fetched"); return (nil, nil) }
        XCTAssertEqual(out, PushRewrite(title: "Murage", body: "Your attention is needed.", badge: nil, target: nil))
    }

    /// N-8: a lock wait that timed out skips the revision check, so the push is delivered
    /// quietly with the generic text and no fetch; "locked since boot" still alerts.
    func testALockTimeoutDeliversSilentlyWithTheGenericText() async {
        final class Stuck: LedgerAccess {
            func read() -> PushLedger? { PushLedger() }
            func update<T>(_ change: (inout PushLedger) -> T) -> T? { nil }
            var lockTimedOut: Bool { true }
        }
        let out = await PushExtension.rewrite(userInfo: info, ledger: Stuck(), detailToken: { _ in "t" }) { _, _ in XCTFail("fetched"); return (nil, nil) }
        XCTAssertEqual(out, PushRewrite(title: "Murage", body: "Your attention is needed.", badge: nil, target: nil, silent: true))
        let locked = await PushExtension.rewrite(userInfo: info, ledger: Memory(nil), detailToken: { _ in "t" }) { _, _ in XCTFail("fetched"); return (nil, nil) }
        XCTAssertFalse(locked.silent)
    }

    func testNoTokenOrAFailedFetchIsGenericWithTheBadge() async {
        let noToken = await PushExtension.rewrite(userInfo: info, ledger: Memory(bound()), detailToken: { _ in nil }) { _, _ in (200, [:]) }
        XCTAssertEqual(noToken.body, "Your attention is needed.")
        XCTAssertEqual(noToken.badge, 2)
        let failed = await PushExtension.rewrite(userInfo: info, ledger: Memory(bound()), detailToken: { _ in "t" }) { _, _ in (nil, nil) }
        XCTAssertEqual(failed.title, "Murage")
    }

    func testAnUnknownBindingIsGenericAndNotFetched() async {
        var l = PushLedger()
        l.bind("0a6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3", origin: "https://mac.tailnet123.ts.net")
        let out = await PushExtension.rewrite(userInfo: info, ledger: Memory(l), detailToken: { _ in "t" }) { _, _ in XCTFail("fetched"); return (nil, nil) }
        XCTAssertEqual(out, PushRewrite(title: "Murage", body: "Your attention is needed.", badge: 0, target: nil))
    }

    func testAStaleRevisionIsGenericAndNotFetched() async {
        var l = bound()
        _ = l.accept(binding, collapseKey: String(repeating: "b", count: 32), revision: 2, workspaceBadge: 1)
        let out = await PushExtension.rewrite(userInfo: info, ledger: Memory(l), detailToken: { _ in "t" }) { _, _ in XCTFail("fetched"); return (nil, nil) }
        XCTAssertEqual(out.body, "Your attention is needed.")
    }

    func testANotificationWithoutOurPayloadIsLeftGeneric() async {
        let out = await PushExtension.rewrite(userInfo: ["aps": [:]], ledger: Memory(bound()), detailToken: { _ in "t" }) { _, _ in (nil, nil) }
        XCTAssertEqual(out, PushRewrite(title: "Murage", body: "Your attention is needed.", badge: nil, target: nil))
    }

    // MARK: the real request path (FINDINGS.md: with Tailscale off or before the
    // first unlock the fetch fails fast, -1003; every failure keeps the generic text)

    /// Shared statics: this suite relies on XCTest's default serial run
    /// (no `swift test --parallel`), and each test resets them in `stubbed`.
    final class Stub: URLProtocol {
        nonisolated(unsafe) static var answer: (URLRequest) -> Result<(Int, Data), URLError> = { _ in .failure(URLError(.unknown)) }
        nonisolated(unsafe) static var seen: URLRequest?
        nonisolated(unsafe) static var requests = 0
        nonisolated(unsafe) static var headers: [String: String] = [:]
        nonisolated(unsafe) static var redirect: URL?
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            Stub.seen = request
            Stub.requests += 1
            if let to = Stub.redirect, request.url?.host != to.host {
                let response = HTTPURLResponse(url: request.url!, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": to.absoluteString, "Content-Length": "0"])!
                client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: to), redirectResponse: response)
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocolDidFinishLoading(self)
                return
            }
            switch Stub.answer(request) {
            case .failure(let error):
                client?.urlProtocol(self, didFailWithError: error)
            case .success(let (status, data)):
                let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"].merging(Stub.headers) { $1 })!
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            }
        }
        override func stopLoading() {}
    }

    func stubbed(_ answer: @escaping (URLRequest) -> Result<(Int, Data), URLError>) -> URLSession {
        Stub.answer = answer
        Stub.seen = nil
        Stub.requests = 0
        Stub.headers = [:]
        Stub.redirect = nil
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [Stub.self]
        return URLSession(configuration: config)
    }

    func through(_ session: URLSession, token: String? = "murage_pd_x") async -> PushRewrite {
        await PushExtension.rewrite(userInfo: info, ledger: Memory(bound()), detailToken: { _ in token }) { url, token in
            await PushExtension.fetch(url, token, session: session)
        }
    }

    let generic = PushRewrite(title: "Murage", body: "Your attention is needed.", badge: 2, target: nil)
    let detail = Data(#"{"title":"Lena needs approval","body":"Lena wants to delete 3 files","target":{"threadId":"t1"}}"#.utf8)

    func testTheRealFetchSendsTheBearerAndRewrites() async {
        let out = await through(stubbed { _ in .success((200, self.detail)) })
        XCTAssertEqual(Stub.seen?.httpMethod, "GET")
        XCTAssertEqual(Stub.seen?.value(forHTTPHeaderField: "Authorization"), "Bearer murage_pd_x")
        XCTAssertEqual(Stub.seen?.url?.path, "/api/mobile/push/" + String(repeating: "9", count: 64))
        XCTAssertEqual(out, PushRewrite(title: "Lena needs approval", body: "Lena wants to delete 3 files", badge: 2, target: PushTarget(threadId: "t1", messageId: nil, requestId: nil)))
    }

    func testANetworkErrorKeepsTheGenericText() async {
        let out = await through(stubbed { _ in .failure(URLError(.cannotFindHost)) }) // -1003
        XCTAssertEqual(out, generic)
    }

    func testATimeoutKeepsTheGenericText() async {
        let out = await through(stubbed { _ in .failure(URLError(.timedOut)) })
        XCTAssertEqual(out, generic)
    }

    func testANon200KeepsTheGenericText() async {
        for status in [401, 404, 500, 503] {
            let out = await through(stubbed { _ in .success((status, self.detail)) })
            XCTAssertEqual(out, generic, "status \(status)")
        }
    }

    func testABodyThatIsNotJSONKeepsTheGenericText() async {
        let out = await through(stubbed { _ in .success((200, Data("<html>".utf8))) })
        XCTAssertEqual(out, generic)
    }

    func testAnUnreadableKeychainKeepsTheGenericTextAndDoesNotFetch() async {
        let out = await through(stubbed { _ in XCTFail("fetched"); return .failure(URLError(.unknown)) }, token: nil)
        XCTAssertEqual(out, generic)
        XCTAssertNil(Stub.seen)
    }

    func testTargetInfoIsWhatTheAppReadsBack() {
        XCTAssertEqual(PushExtension.targetInfo(PushTarget(threadId: "t1", messageId: nil, requestId: "req-1")), ["threadId": "t1", "requestId": "req-1"])
        XCTAssertEqual(PushExtension.targetInfo(PushTarget(threadId: "t1", messageId: "m1", requestId: nil)), ["threadId": "t1", "messageId": "m1"])
    }

    // MARK: the URL builder (defence in depth)

    func testTheDetailURLNeedsSixtyFourLowerCaseHex() {
        let origin = "https://mac.tailnet123.ts.net"
        XCTAssertEqual(PushExtension.detailURL(origin: origin, eventRef: String(repeating: "a", count: 64))?.absoluteString,
                       origin + "/api/mobile/push/" + String(repeating: "a", count: 64))
        for bad in [String(repeating: "A", count: 64), String(repeating: "a", count: 63), String(repeating: "a", count: 65),
                    "../" + String(repeating: "a", count: 61), String(repeating: "a", count: 63) + "/", String(repeating: "a", count: 63) + "?",
                    "pending", ""] {
            XCTAssertNil(PushExtension.detailURL(origin: origin, eventRef: bad), bad)
        }
    }

    func testTheDetailURLNeedsAWorkspaceOrigin() {
        let ref = String(repeating: "9", count: 64)
        XCTAssertEqual(PushExtension.detailURL(origin: "https://mac.tailnet123.ts.net:8444", eventRef: ref)?.absoluteString,
                       "https://mac.tailnet123.ts.net:8444/api/mobile/push/" + ref)
        for bad in ["http://mac.tailnet123.ts.net", "https://user@mac.tailnet123.ts.net", "https://100.64.0.1",
                    "https://mac.tailnet123.ts.net/path", "https://mac.tailnet123.ts.net?x", "https://mac.tailnet123.ts.net#x",
                    "https://MAC.tailnet123.ts.net", "https://mac.tailnet123.ts.net:443", "ftp://mac.tailnet123.ts.net", ""] {
            XCTAssertNil(PushExtension.detailURL(origin: bad, eventRef: ref), bad)
        }
    }

    func testAnOriginThatIsNotHTTPSIsGenericAndNotFetched() async {
        for origin in ["http://mac.tailnet123.ts.net", "https://evil.example/steal?x="] {
            var l = PushLedger()
            l.bind(binding, origin: origin)
            let out = await PushExtension.rewrite(userInfo: info, ledger: Memory(l), detailToken: { _ in "t" }) { _, _ in XCTFail("fetched"); return (nil, nil) }
            XCTAssertEqual(out, generic, origin)
        }
    }

    // MARK: redirects and the body cap (review round 2)

    func testARedirectToAnotherHostIsNotFollowed() async {
        let session = stubbed { _ in .success((200, self.detail)) }
        Stub.redirect = URL(string: "https://evil.example/api/mobile/push/" + String(repeating: "9", count: 64))
        let out = await through(session)
        XCTAssertEqual(out, generic)
        XCTAssertEqual(Stub.requests, 1)
        XCTAssertEqual(Stub.seen?.url?.host, "mac.tailnet123.ts.net")
    }

    func testABodyOverTheCapIsGeneric() async {
        let padded = detail + Data(repeating: 0x20, count: PushExtension.bodyCap)
        let out = await through(stubbed { _ in .success((200, padded)) })
        XCTAssertEqual(out, generic)
    }

    func testABodyJustUnderTheCapStillRewrites() async {
        let padded = detail + Data(repeating: 0x20, count: PushExtension.bodyCap - detail.count)
        let out = await through(stubbed { _ in .success((200, padded)) })
        XCTAssertEqual(out.title, "Lena needs approval")
    }

    func testADeclaredLengthOverTheCapIsGeneric() async {
        let session = stubbed { _ in .success((200, self.detail)) }
        Stub.headers = ["Content-Length": String(PushExtension.bodyCap + 1)]
        let out = await through(session)
        XCTAssertEqual(out, generic)
    }
}
