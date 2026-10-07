import XCTest
@testable import MurageShellCore

/// contract/navigation.json, whose oracle is `navigationDecision` and
/// `mayCapture` in src/lib/native-contract.test.ts (final review I3).
final class NavigationPolicyTests: XCTestCase {
    private func contract() throws -> (WorkspaceOrigin, [String: Any]) {
        let json = try XCTUnwrap(Fixtures.json("navigation.json") as? [String: Any])
        let origin = try XCTUnwrap(WorkspaceOrigin(string: try XCTUnwrap(json["origin"] as? String)))
        return (origin, json)
    }

    func testSharedNavigationCases() throws {
        let (saved, json) = try contract()
        let cases = try XCTUnwrap(json["navigations"] as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 40)
        for entry in cases {
            let url = try XCTUnwrap(entry["url"] as? String)
            let target = try XCTUnwrap(NavigationTarget(rawValue: try XCTUnwrap(entry["target"] as? String)))
            let decision = try XCTUnwrap(NavigationDecision(rawValue: try XCTUnwrap(entry["decision"] as? String)))
            XCTAssertEqual(NavigationPolicy.decide(url, target: target, saved: saved), decision, "\(target.rawValue) \(url)")
        }
    }

    func testSharedCaptureCases() throws {
        let (saved, json) = try contract()
        let cases = try XCTUnwrap(json["captures"] as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 5)
        for entry in cases {
            let requester = (entry["requester"] as? String).flatMap(WorkspaceOrigin.init(string:))
            let mainFrame = entry["mainFrame"] as? Bool
            let granted = try XCTUnwrap(entry["granted"] as? Bool)
            XCTAssertEqual(NavigationPolicy.mayCapture(requester: requester, isMainFrame: mainFrame, saved: saved), granted,
                           "\(String(describing: entry["requester"])) \(String(describing: mainFrame))")
        }
    }

    /// What the iOS glue hands the policy: `url.absoluteString`.
    func testURLsFromFoundationDecideTheSame() throws {
        let saved = try XCTUnwrap(WorkspaceOrigin(string: "https://mac.tailnet123.ts.net:8444"))
        let own = try XCTUnwrap(URL(string: "blob:https://mac.tailnet123.ts.net:8444/0b6f9c1e"))
        XCTAssertEqual(NavigationPolicy.decide(own.absoluteString, target: .mainFrame, saved: saved), .allow)
        let page = try XCTUnwrap(URL(string: "https://mac.tailnet123.ts.net:8444/a b".replacingOccurrences(of: " ", with: "%20")))
        XCTAssertEqual(NavigationPolicy.decide(page.absoluteString, target: .mainFrame, saved: saved), .allow)
    }
}
