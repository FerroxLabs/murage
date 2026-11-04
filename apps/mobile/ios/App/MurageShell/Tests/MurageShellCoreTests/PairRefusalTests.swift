import XCTest
@testable import MurageShellCore

final class PairRefusalTests: XCTestCase {
    func testSharedCases() throws {
        let fixture = try XCTUnwrap(Fixtures.json("pair-refusal.json") as? [String: Any])
        XCTAssertEqual(fixture["maxChars"] as? Int, PairRefusal.maxChars)
        let cases = try XCTUnwrap(fixture["cases"] as? [[String: String]])
        XCTAssertGreaterThan(cases.count, 5)
        for entry in cases {
            XCTAssertEqual(PairRefusal.message(try XCTUnwrap(entry["input"])), entry["message"], "\(entry)")
        }
    }

    func testTheGateAcceptsOnlyAShortMessage() {
        func parse(_ args: Any?) -> Result<ChannelRequest, ChannelError> {
            ChannelGate.parse(["method": "pairRefused", "args": args as Any])
        }
        XCTAssertEqual(try? parse(["message": String(repeating: "x", count: 200)]).get().method, .pairRefused)
        XCTAssertEqual(parse(["message": String(repeating: "x", count: 201)]).failureCode, .badArgs)
        XCTAssertEqual(parse([String: Any]()).failureCode, .badArgs)
        XCTAssertEqual(parse(["message": 7]).failureCode, .badArgs)
    }

    func testIsNeverAdvertised() {
        XCTAssertFalse(ChannelGate.advertised.contains(.pairRefused))
        XCTAssertEqual(CloseReason.pairRefused.rawValue, "pairRefused")
    }
}

private extension Result where Failure == ChannelError {
    var failureCode: ChannelError? {
        if case .failure(let error) = self { return error }
        return nil
    }
}
