import Foundation
import XCTest
@testable import MurageShellCore

final class PhoneJobsContractTests: XCTestCase {
    private typealias C = PhoneJobsContract
    private func fixture() throws -> [String: Any] { try XCTUnwrap(Fixtures.json("phone-jobs.json") as? [String: Any]) }
    private func object(_ value: Any?) throws -> [String: Any] { try XCTUnwrap(value as? [String: Any]) }
    private func objects(_ value: Any?) throws -> [[String: Any]] { try XCTUnwrap(value as? [[String: Any]]) }

    /// Expand every repeat vector, including nested contact.phones and args.to.
    private func expanded(_ vector: [String: Any]) throws -> [String: Any] {
        let body = try object(vector["body"])
        guard let repeatSpec = vector["repeat"] else { return body }
        let spec = try object(repeatSpec)
        let path = try XCTUnwrap(spec["path"] as? String).split(separator: ".").map(String.init)
        let count = try XCTUnwrap(spec["count"] as? Int)
        XCTAssertGreaterThan(count, 0)
        func replace(_ o: [String: Any], _ path: ArraySlice<String>) throws -> [String: Any] {
            var copy = o
            let key = try XCTUnwrap(path.first)
            if path.count == 1 {
                let items = try XCTUnwrap(copy[key] as? [Any])
                XCTAssertEqual(items.count, 1)
                copy[key] = Array(repeating: try XCTUnwrap(items.first), count: count)
            } else { copy[key] = try replace(object(copy[key]), path.dropFirst()) }
            return copy
        }
        return try replace(body, path[...])
    }

    func testKeyIdsHashDecodedPointsAndRejectMalformedPoints() throws {
        let keys = try object(fixture()["keyId"])
        let wrong = try object(keys["notKeyId"])
        let vectors = try objects(keys["vectors"])
        XCTAssertEqual(vectors.count, 2)
        for vector in vectors {
            let point = try XCTUnwrap(vector["point"] as? String)
            let id = C.approvalKeyId(point: point)
            XCTAssertEqual(id, vector["keyId"] as? String)
            XCTAssertNotEqual(id, wrong[point] as? String)
            XCTAssertNil(C.approvalKeyId(point: point + "="))
            XCTAssertNil(C.approvalKeyId(point: point + "\n"))
            XCTAssertNil(C.approvalKeyId(point: String(point.dropLast())))
        }
        for point in ["", String(repeating: "A", count: 87), "+" + String(repeating: "A", count: 86)] {
            XCTAssertNil(C.approvalKeyId(point: point))
        }
    }

    func testMintMessageIsByteExact() throws {
        let mint = try object(fixture()["mint"]), vector = try object(mint["vector"])
        XCTAssertEqual(C.tag, mint["tag"] as? String)
        XCTAssertEqual(C.ttlMs, mint["ttlMs"] as? Int)
        let message = C.phoneJobsMessage(origin: try XCTUnwrap(vector["origin"] as? String), keyId: try XCTUnwrap(vector["keyId"] as? String),
                                        nonce: try XCTUnwrap(vector["nonce"] as? String), expiresAt: try XCTUnwrap(vector["expiresAt"] as? NSNumber).int64Value)
        XCTAssertEqual(Data(message.utf8), Data(try XCTUnwrap(vector["message"] as? String).utf8))
        XCTAssertFalse(message.hasSuffix("\n"))
    }

    func testTokensAndRegistrationMatchEveryVector() throws {
        let f = try fixture(), token = try object(f["token"]), registration = try object(f["registration"])
        XCTAssertEqual(C.capabilities, f["capabilities"] as? [String])
        for value in try XCTUnwrap(token["valid"] as? [String]) { XCTAssertTrue(C.tokenValid(value)) }
        for value in try XCTUnwrap(token["invalid"] as? [String]) { XCTAssertFalse(C.tokenValid(value)) }
        XCTAssertTrue(C.registrationValid(registration["valid"]))
        for value in try objects(registration["alsoValid"]) { XCTAssertTrue(C.registrationValid(value)) }
        for vector in try objects(registration["invalid"]) { XCTAssertFalse(C.registrationValid(try expanded(vector)), "\(vector)") }
    }

    func testOfferEnvelopesAndActionValidationAreSeparate() throws {
        let job = try object(fixture()["job"])
        for value in try objects(job["offers"]) {
            let offer = try XCTUnwrap(C.Offer.parse(value))
            XCTAssertEqual(offer.operationId, value["operationId"] as? String)
            XCTAssertEqual(offer.offerId, value["offerId"] as? String)
            XCTAssertEqual(offer.workspace, value["workspace"] as? String)
            XCTAssertEqual(offer.bot.id, try object(value["bot"])["id"] as? String)
            XCTAssertEqual(offer.provider.name, try object(value["provider"])["name"] as? String)
            // The legacy wire fixture permits a contact name; native approval requires a number.
            if offer.action == "messages.compose" {
                XCTAssertEqual(offer.args["to"] as? [String], ["Sam"])
                XCTAssertNil(offer.decodedArgs)
            } else { XCTAssertNotNil(offer.decodedArgs) }
        }
        for vector in try objects(job["invalidOffers"]) { XCTAssertNil(C.Offer.parse(try expanded(vector)), "\(vector)") }
        var value = try XCTUnwrap(objects(job["offers"]).first)
        value["capability"] = "contacts"
        XCTAssertNotNil(C.Offer.parse(value))
        XCTAssertNil(C.Offer.parse(value)?.decodedArgs)
        value["action"] = "contacts.future"
        XCTAssertNotNil(C.Offer.parse(value))
        XCTAssertNil(C.Offer.parse(value)?.decodedArgs)
        value["expiresAt"] = true
        XCTAssertNil(C.Offer.parse(value))
    }

    func testPollAndTargetedAnswersKeepTheirDistinctUnions() throws {
        let job = try object(fixture()["job"]), poll = try object(job["poll"]), targeted = try object(job["targeted"])
        for value in try objects(poll["answers"]) { XCTAssertNotNil(C.PollAnswer.parse(value)) }
        for vector in try objects(poll["invalid"]) { XCTAssertNil(C.PollAnswer.parse(try expanded(vector))) }
        for value in try objects(targeted["answers"]) {
            let answer = try XCTUnwrap(C.TargetedAnswer.parse(value))
            switch answer {
            case .jobs(let offer): XCTAssertEqual(offer.operationId, try objects(value["jobs"]).first?["operationId"] as? String)
            case .leased(let expiresAt): XCTAssertEqual(expiresAt, (value["expiresAt"] as? NSNumber)?.int64Value)
            case .handled(let reason): XCTAssertEqual(reason, value["reason"] as? String)
            }
        }
        for vector in try objects(targeted["invalid"]) { XCTAssertNil(C.TargetedAnswer.parse(try expanded(vector)), "\(vector)") }
        let offer = try XCTUnwrap(objects(job["offers"]).first)
        for value: [String: Any] in [["jobs": [offer, offer]], ["jobs": [], "x": 1], ["jobs": [NSNull()]]] {
            XCTAssertNil(C.PollAnswer.parse(value)); XCTAssertNil(C.TargetedAnswer.parse(value))
        }
        XCTAssertNil(C.TargetedAnswer.parse(["leased": true, "expiresAt": 0]))
        XCTAssertNil(C.TargetedAnswer.parse(["leased": 1, "expiresAt": 100]))
    }

    func testLeaseRequestsAndAnswersMatchEveryVector() throws {
        let lease = try object(object(fixture()["job"])["lease"])
        XCTAssertNotNil(C.LeaseRequest.parse(lease["request"]))
        for vector in try objects(lease["invalidRequests"]) { XCTAssertNil(C.LeaseRequest.parse(try expanded(vector))) }
        for value in try objects(lease["answers"]) {
            let answer = try XCTUnwrap(C.LeaseAnswer.parse(value))
            switch answer {
            case .active(let token): XCTAssertEqual(token, value["leaseToken"] as? String)
            case .inactive: XCTAssertEqual(value["active"] as? Bool, false)
            }
        }
        for vector in try objects(lease["invalidAnswers"]) { XCTAssertNil(C.LeaseAnswer.parse(try expanded(vector))) }
        XCTAssertNil(C.LeaseAnswer.parse(["active": 0]))
    }

    func testResultBodiesMatchEveryVectorAndPreserveAbsentVersusNull() throws {
        let job = try object(fixture()["job"])
        for vector in try objects(job["results"]) { XCTAssertNotNil(C.ResultBody.parse(vector["body"])) }
        for vector in try objects(job["invalidResults"]) { XCTAssertNil(C.ResultBody.parse(try expanded(vector)), "\(vector)") }
        let token = String(repeating: "A", count: 43)
        XCTAssertNil(C.ResultBody.parse(["leaseToken": token, "ok": 1]))
        XCTAssertNil(C.ResultBody.parse(["leaseToken": token, "ok": false, "code": "denied", "result": NSNull()]))
        XCTAssertNil(C.ResultBody.parse(["leaseToken": token, "ok": true, "error": NSNull()]))
        XCTAssertNil(try XCTUnwrap(C.ResultBody.parse(["leaseToken": token, "ok": true])).result)
        XCTAssertTrue(try XCTUnwrap(C.ResultBody.parse(["leaseToken": token, "ok": true, "result": NSNull()])).result is NSNull)
    }

    func testAllFourteenActionArgsAndResultEncodersMatchEveryVector() throws {
        let actions = try object(fixture()["actions"])
        let names = Set(["calendar.read", "calendar.free_time", "calendar.add", "calendar.change", "reminders.read", "reminders.add", "reminders.complete",
                         "contacts.search", "contacts.get", "location.get", "alarms.set", "alarms.timer", "messages.compose", "calls.dial"])
        XCTAssertEqual(Set(actions.keys).subtracting(["note"]), names)
        for name in names.sorted() {
            let vectors = try object(actions[name])
            for value in try objects(vectors["validArgs"]) { XCTAssertNotNil(C.Args.parse(action: name, value), name) }
            for vector in try objects(vectors["invalidArgs"]) { XCTAssertNil(C.Args.parse(action: name, try expanded(vector)), "\(name): \(vector["why"] ?? "")") }
            for value in try objects(vectors["validResults"]) {
                let result = try XCTUnwrap(C.Result.parse(action: name, value), name)
                let encoded = try XCTUnwrap(result.encode(), name)
                let bytes = try JSONSerialization.data(withJSONObject: encoded)
                let decoded = try object(JSONSerialization.jsonObject(with: bytes))
                XCTAssertTrue(NSDictionary(dictionary: decoded).isEqual(to: value), name)
            }
            for vector in try objects(vectors["invalidResults"]) {
                let result = C.Result.parse(action: name, try expanded(vector))
                XCTAssertNil(result?.encode(), "\(name): \(vector["why"] ?? "")")
            }
        }
        XCTAssertNil(C.Args.parse(action: "calendar.future", [:]))
        XCTAssertNil(C.Result.parse(action: "calendar.future", [:]))
    }

    func testLimitsUseUTF16AndStrictJSONTypes() throws {
        XCTAssertNotNil(C.CallsDialArgs.parse(["number": String(repeating: "😀", count: 20)]))
        XCTAssertNil(C.CallsDialArgs.parse(["number": String(repeating: "😀", count: 21)]))
        for bad: Any in [true, "1", 1.5, 0, 201, NSNull()] { XCTAssertNil(C.RemindersReadArgs.parse(["limit": bad])) }
        XCTAssertNotNil(C.RemindersReadArgs.parse(["limit": NSNumber(value: 200.0)]))
        XCTAssertNil(C.RemindersReadArgs.parse(["includeCompleted": 1]))
        XCTAssertNil(C.RemindersReadArgs.parse(["includeCompleted?": true]))
        XCTAssertNil(C.RemindersAddArgs.parse(["title": "x", "notes": NSNull()]))
        XCTAssertNotNil(C.RemindersAddArgs.parse(["title": String(repeating: "x", count: 500), "due": String(repeating: "x", count: 64), "notes": String(repeating: "x", count: 4000)]))
        for (key, count) in [("title", 501), ("due", 65), ("notes", 4001)] {
            var value = ["title": "x"]; value[key] = String(repeating: "x", count: count)
            XCTAssertNil(C.RemindersAddArgs.parse(value))
        }
        XCTAssertNil(C.MessagesComposeArgs.parse(["to": [""], "body": "x"]))
        XCTAssertNotNil(C.MessagesComposeArgs.parse(["to": Array(repeating: "x", count: 10), "body": String(repeating: "x", count: 2000)]))
        XCTAssertNil(C.MessagesComposeArgs.parse(["to": ["x"], "body": String(repeating: "x", count: 2001)]))
    }

    func testTimeParsingAndRangeBoundariesMatchTheReference() {
        let start = "2026-10-01T00:00:00Z"
        XCTAssertNotNil(C.CalendarReadArgs.parse(["start": start, "end": "2026-11-01T00:00:00Z"]))
        XCTAssertNil(C.CalendarReadArgs.parse(["start": start, "end": "2026-11-01T00:00:00.001Z"]))
        XCTAssertNil(C.CalendarReadArgs.parse(["start": start, "end": "2026-10-01T01:00:00+01:00"]))
        for time in ["2026-13-01T00:00:00Z", "2026-10-32T00:00:00Z", "2026-10-01T24:01:00Z", "2026-10-01T00:00:60Z", "2026-10-01T00:00:00+24:00", "2026-10-01T00:00:00Z\n"] {
            XCTAssertNil(C.CalendarChangeArgs.parse(["id": "e", "start": time]), time)
        }
        for time in ["0000-01-01T00:00:00Z", "2026-02-31T00:00:00Z", "2026-10-01T24:00:00Z", "2026-10-01T00:00:00.123456789+23:59"] {
            XCTAssertNotNil(C.CalendarChangeArgs.parse(["id": "e", "start": time]), time)
        }
        // Change and result slots have no ordering refinement in S1b.
        XCTAssertNotNil(C.CalendarChangeArgs.parse(["id": "e", "start": "2026-10-02T00:00:00Z", "end": start]))
        XCTAssertNotNil(C.CalendarFreeTimeResult(slots: [C.Slot(start: "2026-10-02T00:00:00Z", end: start)]).encode())
    }

    func testTypedEncodersRefuseInvalidValuesAndNestedLimits() {
        XCTAssertNil(C.RemindersCompleteResult(id: "r", completed: false).encode())
        XCTAssertNil(C.CalendarAddResult(id: "", writeOnly: true).encode())
        XCTAssertNil(C.AlarmsSetResult(outcome: "done").encode())
        XCTAssertNil(C.AlarmsTimerResult(outcome: "done").encode())
        XCTAssertNil(C.MessagesComposeResult(outcome: "sent").encode())
        XCTAssertNil(C.CallsDialResult(outcome: "called").encode())
        XCTAssertNil(C.LocationGetResult(lat: .nan, lon: 0, accuracyMeters: 0, precision: "precise", at: "x").encode())
        XCTAssertNil(C.LocationGetResult(lat: 0, lon: 181, accuracyMeters: 0, precision: "precise", at: "x").encode())
        XCTAssertNil(C.Contact(id: "c", name: "", phones: [], emails: Array(repeating: C.ContactEmail(address: "x"), count: 11)).encode())
        XCTAssertNil(C.ContactPhone(label: String(repeating: "x", count: 51), number: "x").encode())
        XCTAssertNil(C.ContactEmail(address: String(repeating: "x", count: 255)).encode())
        XCTAssertNil(C.ContactsGetResult(contact: C.Contact(id: "", name: "", phones: [], emails: []), limited: false).encode())
    }

    func testResultByteBoundaryIncludesUTF8EscapesAndNestedResults() throws {
        let job = try object(fixture()["job"]), oversize = try object(job["oversize"])
        XCTAssertEqual(C.resultMaxBytes, oversize["maxBytes"] as? Int)
        let max = C.resultMaxBytes, token = String(repeating: "A", count: 43)
        // {"text":"..."} has eleven bytes of framing.
        let cases: [(Any, Bool)] = [
            (["text": String(repeating: "a", count: max - 11)], true),
            (["text": String(repeating: "a", count: max - 10)], false),
            (String(repeating: "é", count: (max - 2) / 2), true),
            (String(repeating: "é", count: max / 2), false),
            (String(repeating: "\n", count: (max - 2) / 2), true),
            (String(repeating: "\n", count: max / 2), false),
            (String(repeating: "/", count: max - 2), true)
        ]
        for (value, expected) in cases {
            XCTAssertEqual(C.withinResultBound(value), expected)
            XCTAssertEqual(C.ResultBody.parse(["leaseToken": token, "ok": true, "result": value]) != nil, expected)
        }
        let event = C.Event(id: "e", title: "", start: "2026-10-01T00:00:00Z", end: "2026-10-01T01:00:00Z", allDay: false, calendar: "", notes: String(repeating: "x", count: 4000))
        XCTAssertNil(C.CalendarReadResult(events: Array(repeating: event, count: 200), truncated: false).encode())
        XCTAssertFalse(C.withinResultBound(Double.infinity))
    }

    func testNumberByteAccountingUsesJavaScriptDecimalCutovers() {
        let cases: [(Double, String)] = [(-0.0, "0"), (1.0, "1"), (1e-7, "1e-7"), (1e-6, "0.000001"),
                                       (1e20, "100000000000000000000"), (1e21, "1e+21"), (1e23, "1e+23"),
                                       (Double.leastNonzeroMagnitude, "5e-324"), (-12.5, "-12.5")]
        for (number, decimal) in cases {
            let framing = "{\"n\":\(decimal),\"padding\":\"\"}".utf8.count
            let padding = String(repeating: "a", count: C.resultMaxBytes - framing)
            XCTAssertTrue(C.withinResultBound(["n": number, "padding": padding]), decimal)
            XCTAssertFalse(C.withinResultBound(["n": number, "padding": padding + "a"]), decimal)
        }
    }

    func testDecodedAndEncodedContainersDoNotShareMutableJSON() throws {
        let contact = C.Contact(id: "c", name: "Sam", phones: [], emails: [])
        var contacts = [contact]
        let result = C.ContactsSearchResult(contacts: contacts, limited: false)
        contacts.removeAll()
        XCTAssertEqual(result.contacts.count, 1)
        var encoded = try XCTUnwrap(result.encode())
        encoded["contacts"] = []
        XCTAssertEqual((try XCTUnwrap(result.encode())["contacts"] as? [Any])?.count, 1)
        let job = try object(fixture()["job"])
        let source = try XCTUnwrap(objects(job["offers"]).first)
        let mutableArgs = NSMutableDictionary(dictionary: try object(source["args"]))
        var input = source
        input["args"] = mutableArgs
        let offer = try XCTUnwrap(C.Offer.parse(input))
        mutableArgs["start"] = "changed"
        XCTAssertNotNil(offer.decodedArgs)
    }
}
