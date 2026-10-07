import XCTest
@testable import MurageShellCore

final class PushOutcomeTests: XCTestCase {
    private var f: [String: Any] { (try? Fixtures.json("push-outcomes.json")) as? [String: Any] ?? [:] }

    func testDetail() {
        for case let c as [String: Any] in f["detail"] as? [Any] ?? [] {
            let category = PushCategory(rawValue: c["category"] as? String ?? "")!
            let got = PushOutcome.detail(status: c["status"] as? Int, body: c["body"], category: category)
            let want = c["expect"] as? [String: Any] ?? [:]
            XCTAssertEqual(got.title, want["title"] as? String)
            XCTAssertEqual(got.body, want["body"] as? String)
            let target = want["target"] as? [String: String]
            XCTAssertEqual(got.target?.threadId, target?["threadId"])
            XCTAssertEqual(got.target?.messageId, target?["messageId"])
            XCTAssertEqual(got.target?.requestId, target?["requestId"])
        }
    }

    func testNotice() {
        for case let c as [String: Any] in f["notice"] as? [Any] ?? [] {
            XCTAssertEqual(PushOutcome.notice(status: c["status"] as? Int, body: c["body"], decision: c["decision"] as? String ?? "").rawValue, c["expect"] as? String)
        }
    }

    func testWords() {
        let words = f["noticeText"] as? [String: [String: String]] ?? [:]
        for notice in PushNotice.allCases {
            XCTAssertEqual(notice.text.title, words[notice.rawValue]?["title"])
            XCTAssertEqual(notice.text.body, words[notice.rawValue]?["body"])
        }
    }
}
