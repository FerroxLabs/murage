import XCTest
#if canImport(UserNotifications)
import UserNotifications
#endif
@testable import MurageShellCore

final class CallPushTests: XCTestCase {
    private func contract() throws -> [String: Any] { try XCTUnwrap(Fixtures.json("push.json") as? [String: Any]) }
    private func vector(_ category: String = "call", revision: Int = 1) throws -> [String: Any] {
        let rows = try XCTUnwrap(contract()["payloads"] as? [[String: Any]])
        var value = try XCTUnwrap(rows.compactMap { $0["value"] as? [String: Any] }.first { $0["category"] as? String == category })
        value["revision"] = revision
        return value
    }
    private func memory(_ payload: PushPayload) -> PushExtensionTests.Memory {
        var l = PushLedger()
        l.bind(payload.bindingId, origin: "https://mac.tailnet123.ts.net")
        return PushExtensionTests.Memory(l)
    }

    func testEveryContractCategoryAndCallConstantIsRepresented() throws {
        let c = try contract()
        XCTAssertEqual(Set(PushCategory.allCases.map(\.rawValue)), Set(try XCTUnwrap(c["iosCategory"] as? [String: String]).keys))
        for row in try XCTUnwrap(c["categories"] as? [[String: String]]) {
            XCTAssertNotNil(row["category"].flatMap(PushCategory.init(rawValue:)))
        }
        XCTAssertEqual(PushContract.expiringCategories.map(\.rawValue), c["expiringCategories"] as? [String])
        let sound = try XCTUnwrap(c["callSound"] as? [String: Any])
        XCTAssertEqual(PushContract.CallSound.ios, sound["ios"] as? String)
        XCTAssertEqual(PushContract.CallSound.android, sound["android"] as? String)
        XCTAssertEqual(PushContract.CallSound.seconds, sound["seconds"] as? Int)
        let actions = try XCTUnwrap((c["iosActions"] as? [String: [[String: Any]]])?["CALL"])
        let native = try XCTUnwrap(PushContract.iosActions["CALL"])
        XCTAssertEqual(native.count, actions.count)
        for (got, expected) in zip(native, actions) {
            XCTAssertEqual(got.id, expected["id"] as? String)
            XCTAssertEqual(got.title, expected["title"] as? String)
            XCTAssertEqual(got.options, expected["options"] as? [String])
        }
        for category in PushCategory.allCases { XCTAssertEqual(category.isTimeSensitive, category == .call) }
    }

    func testCallDisplayVectors() throws {
        for c in try XCTUnwrap(contract()["callDisplay"] as? [[String: Any]]) {
            let p = try XCTUnwrap(PushPayload.parse(c["payload"]))
            let now = try XCTUnwrap(c["now"] as? NSNumber).int64Value
            XCTAssertEqual(PushContract.callDisplayAction(p, now: now, shown: try XCTUnwrap(c["shown"] as? [String])).rawValue,
                           c["action"] as? String, c["case"] as? String ?? "")
        }
    }

    func testExpiryIsStrictAndMatchesTheJavaScriptIntegerLimit() throws {
        for category in ["call", "call-note"] {
            var o = try vector(category)
            for bad: Any in [true, "1790000045000", 0, -1, 1.5, NSNumber(value: 9_007_199_254_740_992 as Int64)] {
                o["expiresAt"] = bad
                XCTAssertNil(PushPayload.parse(o), "\(bad)")
            }
            o["expiresAt"] = NSNumber(value: 9_007_199_254_740_991 as Int64)
            XCTAssertNotNil(PushPayload.parse(o))
            var fcm = o.mapValues { String(describing: $0) }
            fcm["threadGroup"] = "46af17e29b1130f0"
            XCTAssertNotNil(PushPayload.parse(fcmData: fcm))
            for bad in ["01790000045000", "+1790000045000", "1e12", "1.0", "0", "-1", "9007199254740992", "1790000045000\n"] {
                fcm["expiresAt"] = bad
                XCTAssertNil(PushPayload.parse(fcmData: fcm), bad)
            }
        }
    }

    func testExpiredCallsAndNotesStayClosedWithoutFetchingEvenBeforeFirstUnlock() async throws {
        for category in ["call", "call-note"] {
            let o = try vector(category), p = try XCTUnwrap(PushPayload.parse(o))
            for l in [memory(p), PushExtensionTests.Memory(nil)] {
                for delta: Int64 in [0, 1] {
                    let out = await PushExtension.rewrite(userInfo: ["murage": o], ledger: l, detailToken: { _ in XCTFail("token"); return nil },
                                                          now: { p.expiresAt! + delta }) { _, _ in XCTFail("fetch"); return (nil, nil) }
                    XCTAssertTrue(out.silent)
                    XCTAssertEqual(out.title, p.category.generic.title)
                    XCTAssertEqual(out.body, p.category.generic.body)
                    XCTAssertNil(out.target)
                }
            }
        }
    }

    func testCallDetailVectorsNeverExposePreviewButKeepTheThread() async throws {
        for c in try XCTUnwrap(contract()["callDetail"] as? [[String: Any]]) {
            let kind = try XCTUnwrap(c["kind"] as? String)
            let o = try vector(kind), p = try XCTUnwrap(PushPayload.parse(o))
            let closed = try XCTUnwrap(c["detail"] as? [String: String])
            let out = await PushExtension.rewrite(userInfo: ["murage": o], ledger: memory(p), detailToken: { _ in "token" }, now: { p.expiresAt! - 1 }) { _, _ in
                (200, ["title": "Private bot", "body": "Private preview", "previewContent": c["previewContent"]!,
                       "target": ["threadId": "t1", "requestId": "intent1"]])
            }
            XCTAssertFalse(out.silent)
            XCTAssertEqual(out.title, closed["title"])
            XCTAssertEqual(out.body, closed["body"])
            XCTAssertEqual(out.target?.threadId, "t1")
        }
    }

    func testResolvedBeforeRingAndRepeatedRingStaySilentAcrossLedgerReload() async throws {
        let o = try vector(), p = try XCTUnwrap(PushPayload.parse(o)), l = memory(p)
        let resolved = try vector("resolved", revision: 2)
        let stop = await PushExtension.rewrite(userInfo: ["murage": resolved], ledger: l, detailToken: { _ in XCTFail("token"); return nil }, now: { 1 }) { _, _ in XCTFail("fetch"); return (nil, nil) }
        XCTAssertTrue(stop.silent) // unknown collapse key
        let restored = PushExtensionTests.Memory(PushLedger.decode(l.read()?.encoded()))
        let late = await PushExtension.rewrite(userInfo: ["murage": o], ledger: restored, detailToken: { _ in XCTFail("token"); return nil }, now: { 1 }) { _, _ in XCTFail("fetch"); return (nil, nil) }
        XCTAssertTrue(late.silent)
        XCTAssertEqual(late.body, p.category.generic.body)
        XCTAssertEqual(restored.read()?.revision(for: p.collapseKey), 2)
    }

    func testExpiryAndResolutionDuringFetchCannotRestartTheRing() async throws {
        let o = try vector(), p = try XCTUnwrap(PushPayload.parse(o))
        for resolved in [false, true] {
            let l = memory(p)
            var now = p.expiresAt! - 1
            let out = await PushExtension.rewrite(userInfo: ["murage": o], ledger: l, detailToken: { _ in "token" }, now: { now }) { _, _ in
                if resolved { _ = l.update { $0.accept(p.bindingId, collapseKey: p.collapseKey, revision: 2, workspaceBadge: 0) } }
                else { now = p.expiresAt! }
                return (200, ["title": "Private", "body": "Private", "target": ["threadId": "t1"]])
            }
            XCTAssertTrue(out.silent)
            XCTAssertEqual(out.body, p.category.generic.body)
            XCTAssertNil(out.target)
        }
    }

    func testCallActionsAndAnswerThreadSeam() async throws {
        XCTAssertEqual(PushResponse.action("NOT_NOW"), .notNow)
        XCTAssertEqual(PushResponse.action("ANSWER"), .callAnswer)
        let p = try XCTUnwrap(PushPayload.parse(vector()))
        let target = await CallAnswerRoute.target(payload: p, origin: WorkspaceOrigin(string: "https://mac.tailnet123.ts.net")!, userInfo: [:],
                                                  detailToken: { "murage_pd_" + String(repeating: "A", count: 43) }) { request in
            XCTAssertEqual(request.httpMethod, "GET")
            return (200, ["title": "Private", "body": "Private", "target": ["threadId": "the-call-thread", "messageId": "m1"]])
        }
        XCTAssertEqual(target?.threadId, "the-call-thread")
        XCTAssertNil(target?.messageId)
    }

    func testResolutionRemovesOnlyOlderMatchingRings() throws {
        let ring = try vector(), resolved = try XCTUnwrap(PushPayload.parse(vector("resolved", revision: 2)))
        var other = ring
        other["collapseKey"] = String(repeating: "c", count: 32)
        var newer = ring
        newer["revision"] = 3
        let delivered = [PushResponse.Delivered(identifier: "ring", userInfo: ["murage": ring]),
                         PushResponse.Delivered(identifier: "other", userInfo: ["murage": other]),
                         PushResponse.Delivered(identifier: "newer", userInfo: ["murage": newer])]
        XCTAssertEqual(PushResponse.resolvedCallNotifications(resolved, delivered: delivered), ["ring"])
        XCTAssertTrue(PushResponse.resolvedCallNotifications(resolved, delivered: []).isEmpty)
    }

    func testDeliveredCallKeysSelectReplaceAndResolutionStaysQuiet() async throws {
        let ring = try vector(), p = try XCTUnwrap(PushPayload.parse(ring))
        let resolved = try vector("resolved", revision: 2)
        let stop = try XCTUnwrap(PushPayload.parse(resolved))
        let delivered = [PushResponse.Delivered(identifier: "ring", userInfo: ["murage": ring]),
                         PushResponse.Delivered(identifier: "note", userInfo: ["murage": try vector("call-note")]),
                         PushResponse.Delivered(identifier: "resolved", userInfo: ["murage": resolved]),
                         PushResponse.Delivered(identifier: "unrelated", userInfo: [:])]
        let shown = PushResponse.deliveredCallKeys(delivered)
        XCTAssertEqual(shown, [p.collapseKey])
        XCTAssertEqual(PushContract.callDisplayAction(stop, now: 1, shown: shown), .replace)
        XCTAssertEqual(PushContract.callDisplayAction(stop, now: 1, shown: []), .silent)
        for ledger in [memory(p), PushExtensionTests.Memory(nil)] {
            let out = await PushExtension.rewrite(userInfo: ["murage": resolved], ledger: ledger,
                                                  detailToken: { _ in XCTFail("token"); return nil }, shown: shown,
                                                  now: { 1 }) { _, _ in XCTFail("fetch"); return (nil, nil) }
            XCTAssertTrue(out.silent)
            XCTAssertNil(out.target)
        }
        XCTAssertEqual(PushResponse.resolvedCallNotifications(stop, delivered: delivered), ["ring"])
    }

    func testResolutionRemovesRingDeliveredAfterInitialSnapshot() async throws {
        let ring = try vector(), p = try XCTUnwrap(PushPayload.parse(ring))
        let resolved = try vector("resolved", revision: 2)
        let stop = try XCTUnwrap(PushPayload.parse(resolved))
        let first: [PushResponse.Delivered] = []
        let out = await PushExtension.rewrite(userInfo: ["murage": resolved], ledger: memory(p),
                                              detailToken: { _ in XCTFail("token"); return nil },
                                              shown: PushResponse.deliveredCallKeys(first), now: { 1 }) { _, _ in
            XCTFail("fetch"); return (nil, nil)
        }
        XCTAssertTrue(out.silent)
        XCTAssertTrue(PushResponse.resolvedCallNotifications(stop, delivered: first).isEmpty)
        let second = [PushResponse.Delivered(identifier: "late-ring", userInfo: ["murage": ring])]
        let remove = PushResponse.resolvedCallNotifications(stop, delivered: second)
        XCTAssertEqual(remove, ["late-ring"])
        XCTAssertTrue(second.filter { !remove.contains($0.identifier) }.isEmpty)
    }

    func testTimeoutQuietsOnlyExpiredOrSupersededCallsWithoutShownCalls() throws {
        let p = try XCTUnwrap(PushPayload.parse(vector())), ledger = memory(p)
        let now = p.expiresAt! - 1
        XCTAssertEqual(PushContract.callDisplayAction(p, now: now, shown: []), .ring)
        XCTAssertFalse(PushExtension.callNeedsQuietDelivery(p, ledger: ledger, now: now))
        _ = ledger.update { $0.accept(p.bindingId, collapseKey: p.collapseKey, revision: p.revision, workspaceBadge: 1) }
        XCTAssertFalse(PushExtension.callNeedsQuietDelivery(p, ledger: ledger, now: now))
        XCTAssertTrue(PushExtension.callNeedsQuietDelivery(p, ledger: ledger, now: p.expiresAt!))
        _ = ledger.update { $0.accept(p.bindingId, collapseKey: p.collapseKey, revision: p.revision + 1, workspaceBadge: 0) }
        XCTAssertTrue(PushExtension.callNeedsQuietDelivery(p, ledger: ledger, now: now))
    }

    #if canImport(UserNotifications)
    @MainActor
    func testTimeoutClearsSupersededCallActionsBeforeRewriteIsApplied() async throws {
        let o = try vector(), p = try XCTUnwrap(PushPayload.parse(o)), ledger = memory(p)
        _ = ledger.update { $0.accept(p.bindingId, collapseKey: p.collapseKey, revision: p.revision + 1, workspaceBadge: 0) }
        let content = UNMutableNotificationContent()
        content.categoryIdentifier = "CALL"
        content.sound = .default
        content.userInfo = ["murage": o, "murageTarget": ["threadId": "old-target"]]
        let now = p.expiresAt! - 1
        // Exercise the synchronous delivery guard with shownCalls still empty.
        if PushExtension.callNeedsQuietDelivery(p, ledger: ledger, now: now, shown: []) {
            let text = p.category.generic
            PushNotificationContent.apply(PushRewrite(title: text.title, body: text.body, badge: nil, target: nil, silent: true),
                                          payload: p, to: content, shown: [], now: now)
        }
        XCTAssertTrue(content.categoryIdentifier.isEmpty)
        XCTAssertNil(content.sound)
        XCTAssertEqual(content.interruptionLevel, .passive)
        XCTAssertNil(content.userInfo["murageTarget"])
    }

    @MainActor
    func testQuietAndExpiredCallsHaveNoActionCategory() async throws {
        let o = try vector(), p = try XCTUnwrap(PushPayload.parse(o))
        for (silent, now) in [(false, p.expiresAt! - 1), (true, p.expiresAt! - 1),
                              (false, p.expiresAt!), (false, p.expiresAt! + 1)] {
            let content = UNMutableNotificationContent()
            content.categoryIdentifier = "CALL"
            content.userInfo = ["murage": o, "murageTarget": ["threadId": "old-target"]]
            content.sound = .default
            let rewrite = PushRewrite(title: "Private", body: "Private", badge: nil,
                                      target: PushTarget(threadId: "thread", messageId: nil, requestId: nil), silent: silent)
            PushNotificationContent.apply(rewrite, payload: p, to: content, shown: [p.collapseKey], now: now)
            if silent || now >= p.expiresAt! {
                XCTAssertTrue(content.categoryIdentifier.isEmpty)
                XCTAssertNil(content.sound)
                XCTAssertEqual(content.interruptionLevel, .passive)
                XCTAssertNil(content.userInfo["murageTarget"])
            } else {
                XCTAssertEqual(content.categoryIdentifier, "CALL")
                XCTAssertNotNil(content.sound)
                XCTAssertEqual(content.interruptionLevel, .timeSensitive)
            }
        }
    }

    @MainActor
    func testSupersededCallRewriteClearsPreviouslyAssignedAnswerActions() async throws {
        let o = try vector(), p = try XCTUnwrap(PushPayload.parse(o)), ledger = memory(p)
        _ = ledger.update { $0.accept(p.bindingId, collapseKey: p.collapseKey, revision: 2, workspaceBadge: 0) }
        let out = await PushExtension.rewrite(userInfo: ["murage": o], ledger: ledger,
                                              detailToken: { _ in XCTFail("token"); return nil }, shown: [p.collapseKey],
                                              now: { p.expiresAt! - 1 }) { _, _ in XCTFail("fetch"); return (nil, nil) }
        let content = UNMutableNotificationContent()
        content.categoryIdentifier = "CALL"
        content.userInfo = ["murage": o]
        PushNotificationContent.apply(out, payload: p, to: content, shown: [p.collapseKey], now: p.expiresAt! - 1)
        XCTAssertTrue(out.silent)
        XCTAssertTrue(content.categoryIdentifier.isEmpty)
        XCTAssertNil(content.sound)
        XCTAssertEqual(content.interruptionLevel, .passive)
        // Clearing the action category preserves the payload needed to remove an older delivered call.
        let resolved = try XCTUnwrap(PushPayload.parse(vector("resolved", revision: 2)))
        let delivered = [PushResponse.Delivered(identifier: "quiet-ring", userInfo: content.userInfo)]
        XCTAssertEqual(PushResponse.deliveredCallKeys(delivered), [p.collapseKey])
        XCTAssertEqual(PushResponse.resolvedCallNotifications(resolved, delivered: delivered), ["quiet-ring"])
    }

    @MainActor
    func testMalformedCallFallbackClearsRelayCategoryAndActions() async {
        let content = UNMutableNotificationContent()
        content.categoryIdentifier = "CALL"
        content.userInfo = ["murage": ["category": "call"]]
        content.sound = .default
        PushNotificationContent.apply(PushRewrite(title: "Private", body: "Private", badge: nil, target: nil),
                                      payload: nil, to: content, now: 1)
        XCTAssertTrue(content.categoryIdentifier.isEmpty)
        XCTAssertNil(content.sound)
        XCTAssertEqual(content.interruptionLevel, .passive)
    }
    #endif
}
