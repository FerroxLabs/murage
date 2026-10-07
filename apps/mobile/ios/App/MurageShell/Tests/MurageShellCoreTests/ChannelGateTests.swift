import XCTest
@testable import MurageShellCore

final class ChannelGateTests: XCTestCase {
    let saved = WorkspaceOrigin(string: "https://mac.tailnet123.ts.net")!

    private func channel() throws -> [String: Any] {
        try XCTUnwrap(Fixtures.json("channel.json") as? [String: Any])
    }

    func testSharedRequestCases() throws {
        let requests = try XCTUnwrap(channel()["requests"] as? [[String: Any]])
        XCTAssertGreaterThan(requests.count, 5)
        for entry in requests {
            let result = ChannelGate.parse(entry["body"])
            if let method = entry["method"] as? String {
                XCTAssertEqual(try? result.get().method.rawValue, method, "\(entry)")
            } else if case .failure(let error) = result {
                XCTAssertEqual(error.rawValue, entry["error"] as? String, "\(entry)")
            } else {
                XCTFail("accepted \(entry)")
            }
        }
    }

    func testHelloListsExactlyTheSharedMethods() throws {
        let hello = ChannelGate.hello()
        let shared = try channel()
        XCTAssertEqual(hello["version"] as? Int, shared["version"] as? Int)
        let methods = try XCTUnwrap(shared["methods"] as? [String])
        let platformMethods = try XCTUnwrap(shared["platformMethods"] as? [String: [String]])
        let ios = try XCTUnwrap(platformMethods["ios"])
        // iOS advertises the shared methods (which now include
        // callSessionOpen/Close -- callbar-rereview2.md G3; they started as
        // Android's own addition, callbar-rereview.md M4, but the page's
        // signal is the only one that follows a real hang-up rather than a
        // retry, Resume or lost, so iOS needs it too) plus its own four
        // call-audio methods (spec §4.1).
        XCTAssertEqual(hello["methods"] as? [String], methods + ios)
    }

    /// spec §4.1, §6.2: the four call-audio methods route on iOS. These live
    /// under platformRequests.ios, not the shared `requests` fixture, because
    /// `requests` is read byte-for-byte by Android's unmodified ChannelGateTest
    /// too, and Android never learns these method names (unknown_method there
    /// is correct and untouched). Task 3's CallAudioArgs owns every other
    /// limit (clip length, mime, piece size, seq, one clip); here ChannelGate
    /// only has to recognise the method and require args to be an object.
    func testCallAudioMethodsRouteOnIOS() throws {
        let ios = try XCTUnwrap((try channel()["platformRequests"] as? [String: [[String: Any]]])?["ios"])
        XCTAssertGreaterThan(ios.count, 3)
        for entry in ios {
            let result = ChannelGate.parse(entry["body"])
            if let method = entry["method"] as? String {
                XCTAssertEqual(try? result.get().method.rawValue, method, "\(entry)")
            } else if case .failure(let error) = result {
                XCTAssertEqual(error.rawValue, entry["error"] as? String, "\(entry)")
            } else {
                XCTFail("accepted \(entry)")
            }
        }
    }

    func testCallAudioMethodsAreAdvertisedOnIOS() {
        for method: ChannelMethod in [.callAudioOpen, .callAudioClose, .callAudioPlay, .callAudioControl] {
            XCTAssertTrue(ChannelGate.advertised.contains(method), "\(method)")
        }
    }

    func testSubframeIsRefusedEvenOnTheSavedOrigin() {
        XCTAssertTrue(ChannelGate.admit(isMainFrame: true, frameOrigin: saved, saved: saved))
        XCTAssertFalse(ChannelGate.admit(isMainFrame: false, frameOrigin: saved, saved: saved))
        XCTAssertFalse(ChannelGate.admit(isMainFrame: true, frameOrigin: WorkspaceOrigin(string: "https://example.com"), saved: saved))
        XCTAssertFalse(ChannelGate.admit(isMainFrame: true, frameOrigin: nil, saved: saved))
    }

    func testRouteArgument() {
        XCTAssertEqual(ChannelArgs.route(["threadId": "t1"]), .thread("t1"))
        XCTAssertEqual(ChannelArgs.route(["threadId": NSNull()]), .keep)
        XCTAssertEqual(ChannelArgs.route([:]), .keep)
        XCTAssertEqual(ChannelArgs.route(["threadId": ""]), .invalid)
        XCTAssertEqual(ChannelArgs.route(["threadId": 7]), .invalid)
    }

    /// channel.json externalUrls: the openExternal rule in
    /// src/lib/native-contract.test.ts, row by row.
    func testSharedExternalURLs() throws {
        let cases = try XCTUnwrap(channel()["externalUrls"] as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 20)
        for entry in cases {
            let raw = try XCTUnwrap(entry["url"] as? String)
            let accepted = try XCTUnwrap(entry["accepted"] as? Bool)
            XCTAssertEqual(ChannelArgs.externalURL(["url": raw]) != nil, accepted, raw)
        }
    }

    func testExternalURLKeepsTheTarget() {
        XCTAssertEqual(ChannelArgs.externalURL(["url": "https://example.com/a"])?.host, "example.com")
        XCTAssertEqual(ChannelArgs.externalURL(["url": "tel:+15551234"])?.absoluteString, "tel:+15551234")
        XCTAssertNil(ChannelArgs.externalURL([:]))
        XCTAssertNil(ChannelArgs.externalURL(["url": 7]))
        XCTAssertNil(ChannelArgs.externalURL(["url": "https://example.com/" + String(repeating: "a", count: 4096)]))
    }

    func testHapticKinds() {
        XCTAssertEqual(HapticKind(rawValue: "success"), .success)
        XCTAssertNil(HapticKind(rawValue: "explode"))
    }
}

/// `diagLine` (shared with Android): the gate admits the method, and the
/// native argument check takes only a `[call-diag]`/`[call-trace]` string.
final class DiagLineArgsTests: XCTestCase {
    private func fixture() throws -> [String: [[String: Any]]] {
        let shared = try XCTUnwrap(Fixtures.json("channel.json") as? [String: Any])
        return try XCTUnwrap(shared["diagLineArgs"] as? [String: [[String: Any]]])
    }

    func testAdvertisedAndRouted() {
        XCTAssertTrue(ChannelGate.advertised.contains(.diagLine))
        let body: [String: Any] = ["method": "diagLine", "args": ["line": "[call-diag] x"]]
        XCTAssertEqual(try? ChannelGate.parse(body).get().method, .diagLine)
    }

    func testAcceptsOnlyStringLinesWithADiagPrefix() throws {
        let fixture = try fixture()
        for args in try XCTUnwrap(fixture["accepted"]) {
            XCTAssertEqual(ChannelArgs.diagLine(args), args["line"] as? String, "\(args)")
        }
        for args in try XCTUnwrap(fixture["refused"]) {
            XCTAssertNil(ChannelArgs.diagLine(args), "\(args)")
        }
    }

    func testRefusesAnOverlongLine() {
        XCTAssertNotNil(ChannelArgs.diagLine(["line": "[call-diag] " + String(repeating: "a", count: 588)]))
        XCTAssertNil(ChannelArgs.diagLine(["line": "[call-diag] " + String(repeating: "a", count: 589)]))
    }
}
