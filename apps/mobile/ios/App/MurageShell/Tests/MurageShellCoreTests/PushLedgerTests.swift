import XCTest
@testable import MurageShellCore

final class PushLedgerTests: XCTestCase {
    private func run(_ name: String, _ steps: [[String: Any]]) {
        var ledger = PushLedger()
        for s in steps {
            let op = s["op"] as? String ?? ""
            let binding = s["bindingId"] as? String ?? ""
            switch op {
            case "bind": ledger.bind(binding, origin: s["origin"] as? String ?? "")
            case "origin": XCTAssertEqual(ledger.origin(binding), s["expect"] as? String, name)
            case "binding": XCTAssertEqual(ledger.binding(origin: s["origin"] as? String ?? ""), s["expect"] as? String, name)
            case "bindingIds": XCTAssertEqual(ledger.bindingIds, s["expect"] as? [String], name)
            case "accept":
                XCTAssertEqual(ledger.accept(binding, collapseKey: s["collapseKey"] as? String ?? "", revision: s["revision"] as? Int ?? 0, workspaceBadge: s["workspaceBadge"] as? Int ?? 0).rawValue, s["expect"] as? String, name)
                XCTAssertEqual(ledger.total, s["total"] as? Int, name)
            case "acceptMany":
                for i in 0..<(s["count"] as? Int ?? 0) {
                    _ = ledger.accept(binding, collapseKey: "\(s["prefix"] as? String ?? "")\(i)", revision: s["revision"] as? Int ?? 0, workspaceBadge: s["workspaceBadge"] as? Int ?? 0)
                }
            case "setBadge": ledger.setBadge(binding, count: s["count"] as? Int ?? 0); XCTAssertEqual(ledger.total, s["total"] as? Int, name)
            case "unbindOrigin": XCTAssertEqual(ledger.unbindOrigin(s["origin"] as? String ?? ""), s["expect"] as? String, name); XCTAssertEqual(ledger.total, s["total"] as? Int, name)
            case "reconcile":
                let pending = (s["pending"] as? [[String: Any]] ?? []).map { ($0["collapseKey"] as? String ?? "", $0["revision"] as? Int ?? 0) }
                XCTAssertEqual(ledger.reconcile(binding, badge: s["badge"] as? Int ?? 0, pending: pending, shown: s["shown"] as? [String] ?? []), s["expect"] as? [String], name)
                XCTAssertEqual(ledger.total, s["total"] as? Int, name)
            case "roundTrip": ledger = PushLedger.decode(ledger.encoded())
            default: XCTFail("unknown op \(op)")
            }
        }
    }

    func testEveryFixtureCase() throws {
        let fixture = try Fixtures.json("push-ledger.json") as? [String: Any]
        for case let c as [String: Any] in fixture?["cases"] as? [Any] ?? [] {
            run(c["name"] as? String ?? "", c["steps"] as? [[String: Any]] ?? [])
        }
    }

    func testDecodeIsForgiving() throws {
        let fixture = try Fixtures.json("push-ledger.json") as? [String: Any]
        for case let c as [String: Any] in fixture?["decode"] as? [Any] ?? [] {
            XCTAssertEqual(PushLedger.decode(Data((c["input"] as? String ?? "").utf8)).total, c["total"] as? Int)
        }
    }
}
