import XCTest
@testable import MurageShellCore

final class PushContractTests: XCTestCase {
    private var push: [String: Any] { (try? Fixtures.json("push.json")) as? [String: Any] ?? [:] }

    func testPayloadsAgreeWithTheContract() {
        for case let c as [String: Any] in push["payloads"] as? [Any] ?? [] {
            XCTAssertEqual(PushPayload.parse(c["value"]) != nil, c["valid"] as? Bool, "\(String(describing: c["value"]))")
        }
    }

    func testFcmDataAgreesAndCarriesTheGroup() {
        for case let c as [String: Any] in push["fcmData"] as? [Any] ?? [] {
            let data = c["data"] as? [String: String] ?? [:]
            XCTAssertEqual(PushPayload.parse(fcmData: data) != nil, c["valid"] as? Bool)
        }
        let first = ((push["fcmData"] as? [[String: Any]])?.first?["data"]) as? [String: String] ?? [:]
        XCTAssertEqual(PushPayload.parse(fcmData: first)?.threadGroup, "46af17e29b1130f0")
    }

    func testIssuedTokensAreStrict() {
        for case let c as [String: Any] in push["issueTokens"] as? [Any] ?? [] {
            XCTAssertEqual(IssuedTokens.parse(c["args"]) != nil, c["valid"] as? Bool)
        }
    }

    /// WKScriptMessage hands the channel every JavaScript number as a double
    /// NSNumber (checked against WebKit on 2026-09-28): the fixture must read
    /// the same way when its numbers arrive like that (the iPhone churn).
    func testIssuedTokensReadTheSameWhenWebKitSendsDoubles() {
        func webKit(_ any: Any?) -> Any? {
            guard let o = any as? [String: Any] else { return any }
            return o.mapValues { v -> Any in
                guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return v }
                return NSNumber(value: n.doubleValue)
            }
        }
        let cases = push["issueTokens"] as? [[String: Any]] ?? []
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            XCTAssertEqual(IssuedTokens.parse(webKit(c["args"])) != nil, c["valid"] as? Bool)
        }
        let valid = cases.first { $0["valid"] as? Bool == true }?["args"] as? [String: Any] ?? [:]
        XCTAssertEqual(IssuedTokens.parse(webKit(valid))?.expiresAt, 1_790_000_000_000)
        for bad: Any in [NSNumber(value: 1.5), NSNumber(value: true), NSNumber(value: 0.0), NSNumber(value: -5.0),
                         NSNumber(value: Double.infinity), NSNumber(value: Double.nan), NSNumber(value: 9_007_199_254_740_992.0), "1790000000000"] {
            var args = valid
            args["expiresAt"] = bad
            XCTAssertNil(IssuedTokens.parse(args), "\(bad)")
        }
    }

    func testCategoriesChannelsAndWords() {
        let ios = push["iosCategory"] as? [String: String] ?? [:]
        let android = push["androidChannel"] as? [String: String] ?? [:]
        let generic = push["generic"] as? [String: [String: String]] ?? [:]
        for category in PushCategory.allCases {
            XCTAssertEqual(category.iosCategory, ios[category.rawValue])
            XCTAssertEqual(category.androidChannel, android[category.rawValue])
            XCTAssertEqual(category.generic.title, generic[category.rawValue]?["title"])
            XCTAssertEqual(category.generic.body, generic[category.rawValue]?["body"])
        }
    }

    func testFeatureSwitchesMatchTheFile() throws {
        let file = try Fixtures.json("push-features.json") as? [String: Bool]
        XCTAssertEqual(PushFeatures.richText, file?["richText"])
        XCTAssertEqual(PushFeatures.lockScreenActions, file?["lockScreenActions"])
    }
}
