#if os(iOS)
import XCTest
import UserNotifications
import MurageShellCore
@testable import MurageShell

final class CallPushPresentationTests: XCTestCase {
    private func payload(_ category: String = "call") throws -> PushPayload {
        var o: [String: Any] = ["bindingId": "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3", "eventRef": String(repeating: "a", count: 64),
                               "category": category, "revision": 1, "workspaceBadge": 1, "collapseKey": String(repeating: "b", count: 32)]
        if category != "resolved" { o["expiresAt"] = 1000 }
        return try XCTUnwrap(PushPayload.parse(o))
    }

    func testRegisteredCategoriesAndCallAuthenticationMatchTheContract() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { root.deleteLastPathComponent() }
        let c = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("contract/push.json"))) as? [String: Any])
        let expected = try XCTUnwrap(c["iosCategory"] as? [String: String])
        for feature in [true, false] {
            let registered = PushCategories.registered(actions: feature)
            XCTAssertEqual(Set(registered.map(\.identifier)), Set(expected.values))
            let call = try XCTUnwrap(registered.first { $0.identifier == "CALL" })
            XCTAssertEqual(call.actions.map(\.identifier), ["ANSWER", "NOT_NOW"])
            XCTAssertEqual(call.actions[0].options, [.foreground, .authenticationRequired])
            XCTAssertEqual(call.actions[1].options, [.authenticationRequired])
            XCTAssertEqual(call.actions[0].title, CallPushStrings.text("push_call_answer"))
            XCTAssertEqual(call.actions[1].title, CallPushStrings.text("push_call_not_now"))
        }
    }

    func testNSEAdapterClosesAllTextAndUsesTimeSensitiveCallSound() throws {
        for category in ["call", "call-note"] {
            let p = try payload(category), content = UNMutableNotificationContent()
            content.subtitle = "Private preview"
            content.summaryArgument = "Private bot"
            PushNotificationContent.apply(PushRewrite(title: "Private", body: "Private", badge: 1, target: nil), payload: p, to: content, now: 999)
            XCTAssertEqual(content.title, CallPushStrings.closed(p.category).title)
            XCTAssertEqual(content.body, CallPushStrings.closed(p.category).body)
            XCTAssertTrue(content.subtitle.isEmpty)
            XCTAssertTrue(content.summaryArgument.isEmpty)
            if category == "call" {
                XCTAssertNotNil(content.sound)
                XCTAssertEqual(content.interruptionLevel, .timeSensitive)
            } else {
                XCTAssertNotNil(content.sound)
                XCTAssertEqual(content.interruptionLevel, .active)
            }
        }
    }

    func testExpiredResolvedAndTimeoutFallbackHaveNoSoundOrBannerPriority() throws {
        for category in ["call", "call-note", "resolved"] {
            for fallback in [false, true] {
                let p = try payload(category), content = UNMutableNotificationContent()
                content.sound = .default
                content.interruptionLevel = .timeSensitive
                PushNotificationContent.apply(PushRewrite(title: p.category.generic.title, body: p.category.generic.body,
                                                          badge: nil, target: nil, silent: fallback),
                                              payload: p, to: content, now: fallback ? 999 : 1000)
                XCTAssertNil(content.sound)
                XCTAssertEqual(content.interruptionLevel, .passive)
                XCTAssertEqual(content.userInfo["murageSilent"] as? Bool, true)
                XCTAssertNil(content.userInfo["murageTarget"])
            }
        }
    }

    func testMalformedCallCannotLeakTextThroughTheTimeoutFallback() {
        let content = UNMutableNotificationContent()
        content.userInfo["murage"] = ["category": "call"]
        content.subtitle = "Private preview"
        content.sound = .default
        PushNotificationContent.apply(PushRewrite(title: "Private", body: "Private", badge: nil, target: nil),
                                      payload: nil, to: content, now: 0)
        XCTAssertEqual(content.title, CallPushStrings.closed(.call).title)
        XCTAssertEqual(content.body, CallPushStrings.closed(.call).body)
        XCTAssertTrue(content.subtitle.isEmpty)
        XCTAssertNil(content.sound)
        XCTAssertEqual(content.interruptionLevel, .passive)
    }
}
#endif
