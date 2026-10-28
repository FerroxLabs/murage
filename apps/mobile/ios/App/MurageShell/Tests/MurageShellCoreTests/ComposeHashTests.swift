import Foundation
import XCTest
@testable import MurageShellCore

final class ComposeHashTests: XCTestCase {
    func testEverySharedFixture() throws {
        for row in try XCTUnwrap(Fixtures.json("compose-hash.json") as? [[String: Any]]) {
            let hash = try XCTUnwrap(row["hash"] as? String)
            if row["parses"] is NSNull { XCTAssertNil(ComposeHash.parse(hash), row["why"] as? String ?? hash); continue }
            let built: String?
            if let bot = row["bot"] as? String { built = ComposeHash.build(botId: bot) }
            else { built = ComposeHash.build(threadId: try XCTUnwrap(row["threadId"] as? String), again: row["again"] as? String) }
            XCTAssertEqual(built, hash)
            let parsed = try XCTUnwrap(ComposeHash.parse(hash))
            XCTAssertEqual(parsed.bot, row["bot"] as? String)
            XCTAssertEqual(parsed.threadId, row["threadId"] as? String)
            XCTAssertEqual(parsed.again, row["again"] as? String)
        }
    }
    func testEncodingAndBuilderBounds() throws {
        let id = "a &+=/#😀"
        XCTAssertEqual(ComposeHash.build(botId: id), "#open=bot:a+%26%2B%3D%2F%23%F0%9F%98%80&compose=1")
        XCTAssertEqual(ComposeHash.parse(try XCTUnwrap(ComposeHash.build(botId: id)))?.bot, id)
        let hash = try XCTUnwrap(ComposeHash.build(threadId: id, again: id))
        XCTAssertEqual(ComposeHash.parse(hash)?.threadId, id)
        XCTAssertEqual(ComposeHash.parse(hash)?.again, id)
        for value in ["", String(repeating: "a", count: 513), String(repeating: "😀", count: 257)] {
            XCTAssertNil(ComposeHash.build(botId: value))
            XCTAssertNil(ComposeHash.build(threadId: value))
            XCTAssertNil(ComposeHash.build(threadId: "t", again: value))
        }
        XCTAssertNotNil(ComposeHash.build(botId: String(repeating: "😀", count: 256)))
        XCTAssertNil(ComposeHash.build(threadId: "bot:b"))
    }
}
