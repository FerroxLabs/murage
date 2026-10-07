import XCTest
@testable import MurageShellCore

final class WorkspaceOriginTests: XCTestCase {
    let saved = WorkspaceOrigin(string: "https://mac.tailnet123.ts.net")!

    func testSharedOriginCases() throws {
        let cases = try XCTUnwrap(Fixtures.json("origins.json") as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 40)
        for entry in cases {
            let input = try XCTUnwrap(entry["input"] as? String)
            XCTAssertEqual(WorkspaceOrigin(string: input)?.serialized, entry["origin"] as? String, input.debugDescription)
        }
    }

    /// A URL the parser accepts reaches the same origin through `init(url:)`,
    /// which is what `contains` uses for navigations.
    func testAcceptedCasesAgreeThroughURL() throws {
        let cases = try XCTUnwrap(Fixtures.json("origins.json") as? [[String: Any]])
        for entry in cases {
            guard let origin = entry["origin"] as? String else { continue }
            let input = try XCTUnwrap(entry["input"] as? String).trimmingCharacters(in: CharacterSet(charactersIn: " "))
            let url = try XCTUnwrap(URL(string: input), input)
            XCTAssertEqual(WorkspaceOrigin(url: url)?.serialized, origin, input)
        }
    }

    /// contract/trim.json: launcher input and a scanned code trim like Java's
    /// trimInput and the TS launcher, so U+200B, U+FEFF and U+180E stay (M4).
    /// JSONDecoder, not Fixtures.json: JSONSerialization drops a string's
    /// leading U+FEFF, which is one of the rows.
    func testSharedTrimCases() throws {
        struct Case: Decodable { let input: String; let trimmed: String; let origin: String? }
        let data = try Data(contentsOf: Fixtures.contract.appendingPathComponent("trim.json"))
        let cases = try JSONDecoder().decode([Case].self, from: data)
        XCTAssertGreaterThan(cases.count, 10)
        XCTAssertTrue(cases.contains { $0.input.unicodeScalars.first == "\u{FEFF}" })
        for entry in cases {
            let label = entry.input.unicodeScalars.map { String($0.value, radix: 16) }.joined(separator: " ")
            let trimmed = WorkspaceOrigin.trimInput(entry.input)
            XCTAssertTrue(trimmed.unicodeScalars.elementsEqual(entry.trimmed.unicodeScalars), label)
            XCTAssertEqual(WorkspaceOrigin(string: trimmed)?.serialized, entry.origin, label)
        }
    }

    /// WKSecurityOrigin reports the default port as 0 (Phase 0, "iOS channel").
    func testSecurityOriginPortZeroIsDefault() {
        XCTAssertEqual(WorkspaceOrigin(scheme: "https", host: "Mac.tailnet123.ts.net", port: 0), saved)
        XCTAssertEqual(WorkspaceOrigin(scheme: "https", host: "mac.tailnet123.ts.net", port: 443), saved)
        XCTAssertNotEqual(WorkspaceOrigin(scheme: "https", host: "mac.tailnet123.ts.net", port: 8444), saved)
    }

    /// A sandboxed iframe reports "://:0" (Phase 0, Q3 case 2b).
    func testOpaqueAndInsecureFramesHaveNoOrigin() {
        XCTAssertNil(WorkspaceOrigin(scheme: "", host: "", port: 0))
        XCTAssertNil(WorkspaceOrigin(scheme: "http", host: "mac.tailnet123.ts.net", port: 0))
    }

    /// A security origin's host passes the same host rule as a typed one.
    func testSecurityOriginHostsFollowTheSameRule() {
        XCTAssertNil(WorkspaceOrigin(scheme: "https", host: "100.101.102.103", port: 0))
        XCTAssertNil(WorkspaceOrigin(scheme: "https", host: "fd7a:115c:a1e0::1", port: 0))
        XCTAssertNil(WorkspaceOrigin(scheme: "https", host: "[fd7a:115c:a1e0::1]", port: 0))
        XCTAssertNil(WorkspaceOrigin(scheme: "https", host: "mäc.tailnet123.ts.net", port: 0))
        XCTAssertNil(WorkspaceOrigin(scheme: "https", host: "evil.example@mac.tailnet123.ts.net", port: 0))
        XCTAssertNil(WorkspaceOrigin(scheme: "https", host: "mac.tailnet123.ts.net", port: 70000))
        XCTAssertNil(WorkspaceOrigin(scheme: "https", host: "mac.tailnet123.ts.net", port: -1))
        XCTAssertNotEqual(WorkspaceOrigin(scheme: "https", host: "mac.tailnet123.ts.net.", port: 0), saved)
    }

    func testContainsOnlyTheSameSchemeHostAndPort() {
        let other = WorkspaceOrigin(string: "https://mac.tailnet123.ts.net:8444")!
        XCTAssertTrue(other.contains(URL(string: "https://mac.tailnet123.ts.net:8444/enter")))
        XCTAssertFalse(other.contains(URL(string: "https://mac.tailnet123.ts.net/")))
        XCTAssertFalse(other.contains(URL(string: "https://mac.tailnet123.ts.net.evil.example:8444/")))
        XCTAssertFalse(other.contains(URL(string: "http://mac.tailnet123.ts.net:8444/")))
        XCTAssertFalse(other.contains(nil))
    }

    /// No WHATWG blob: unwrapping, no userinfo, no other scheme (P4 carry).
    func testContainsRefusesSpoofs() {
        XCTAssertTrue(saved.contains(URL(string: "https://MAC.tailnet123.ts.net:443/x?y#z")))
        XCTAssertFalse(saved.contains(URL(string: "blob:https://mac.tailnet123.ts.net/0b1c2d3e")))
        XCTAssertFalse(saved.contains(URL(string: "data:text/plain;base64,aGk=")))
        XCTAssertFalse(saved.contains(URL(string: "https://evil.example@mac.tailnet123.ts.net/")))
        XCTAssertFalse(saved.contains(URL(string: "https://mac.tailnet123.ts.net@evil.example/")))
        XCTAssertFalse(saved.contains(URL(string: "https://mac.tailnet123.ts.net./")))
        XCTAssertFalse(saved.contains(URL(string: "about:blank")))
        XCTAssertFalse(saved.contains(URL(string: "javascript:alert(1)")))
        XCTAssertFalse(saved.contains(URL(string: "/relative", relativeTo: nil)))
    }

    /// A "\" in front of the saved host: the text is refused outright, and
    /// whatever URL(string:) makes of it (nil, or "%5C" in the userinfo) is
    /// not on the saved origin either.
    func testABackslashBeforeTheHostIsRefused() {
        let spoof = "https://evil.example\\@mac.tailnet123.ts.net/"
        XCTAssertNil(WorkspaceOrigin(string: spoof))
        if let url = URL(string: spoof) { XCTAssertNil(WorkspaceOrigin(url: url), url.absoluteString) }
        XCTAssertFalse(saved.contains(URL(string: spoof)))
    }

    /// Characters WHATWG leaves raw in a query must not push a same-origin
    /// URL off the origin. URL(string:) accepts this one (the unwrap pins
    /// that), and the rule only reads the authority, never the query.
    func testBracketsInTheQueryStayOnTheOrigin() throws {
        let url = try XCTUnwrap(URL(string: "https://mac.tailnet123.ts.net/x?filter[a]=1"))
        XCTAssertTrue(saved.contains(url), url.absoluteString)
    }

    func testPathsKeepTheirFragment() {
        XCTAssertEqual(saved.url.absoluteString, "https://mac.tailnet123.ts.net")
        XCTAssertEqual(saved.url(path: "/#open=t1")?.absoluteString, "https://mac.tailnet123.ts.net/#open=t1")
        XCTAssertEqual(saved.url(path: "/enter#123456")?.absoluteString, "https://mac.tailnet123.ts.net/enter#123456")
        XCTAssertEqual(WorkspaceOrigin(string: "https://mac.tailnet123.ts.net:8444")!.url(path: "/enter")?.absoluteString,
                       "https://mac.tailnet123.ts.net:8444/enter")
    }

    /// A path that does not start with "/" would change the authority
    /// ("@evil.example/" makes the saved host a userinfo).
    func testPathsMustStartWithASlash() {
        XCTAssertNil(saved.url(path: "@evil.example/"))
        XCTAssertNil(saved.url(path: ".evil.example/"))
        XCTAssertNil(saved.url(path: ""))
    }
}
