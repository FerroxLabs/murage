import XCTest
@testable import MurageShellCore

final class PushEnrolPlanTests: XCTestCase {
    func testEveryFixtureCase() throws {
        for case let c as [String: Any] in try Fixtures.json("push-enrol.json") as? [Any] ?? [] {
            XCTAssertEqual(PushEnrolPlan.decide(permission: c["permission"] as? String ?? "", binding: c["binding"] as? String,
                                                hasDetail: c["hasDetail"] as? Bool ?? false, fresh: c["fresh"] as? Bool ?? false).rawValue, c["plan"] as? String)
        }
    }
}
