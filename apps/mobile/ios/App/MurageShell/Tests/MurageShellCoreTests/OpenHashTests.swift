import XCTest
@testable import MurageShellCore

final class OpenHashTests: XCTestCase {
    func testSharedCases() throws {
        let cases = try XCTUnwrap(Fixtures.json("open-hash.json") as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 10)
        for entry in cases {
            let thread = try XCTUnwrap(entry["threadId"] as? String)
            let message = entry["messageId"] as? String
            XCTAssertEqual(OpenHash.build(threadId: thread, messageId: message), entry["hash"] as? String, thread)
        }
    }

    /// src/lib/deep-link.ts MAX_ID: 512 UTF-16 units, as JavaScript counts.
    func testIdsFollowThePagesLimit() {
        XCTAssertNotNil(OpenHash.build(threadId: String(repeating: "a", count: 512)))
        XCTAssertNil(OpenHash.build(threadId: String(repeating: "a", count: 513)))
        XCTAssertEqual(OpenHash.build(threadId: "t", messageId: String(repeating: "m", count: 513)), "#open=t")
        XCTAssertNotNil(OpenHash.build(threadId: String(repeating: "😀", count: 256)))
        XCTAssertNil(OpenHash.build(threadId: String(repeating: "😀", count: 257)))
    }
}
