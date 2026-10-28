import Foundation
import XCTest
import MurageShellCore
@testable import MurageShell

@MainActor final class PhoneNativeExecutorsTests: XCTestCase {
    typealias C = PhoneJobsContract
    @MainActor final class Memory: PhoneLedgerStorage {
        var data: Data?, fail = false
        var beforeWrite: () -> Void = {}
        func read() throws -> Data? { if fail { throw PhoneExecutorFailure.denied }; return data }
        func write(_ data: Data) throws { beforeWrite(); if fail { throw PhoneExecutorFailure.denied }; self.data = data }
    }
    @MainActor final class CalendarFake: PhoneCalendarAccess {
        var access: String? = "full", rows: [[String: Any]] = [], writes = 0, notesRequested = false, revoke = false
        func events(start: Date, end: Date, includeNotes: Bool) throws -> [[String: Any]] {
            notesRequested = includeNotes; if revoke { access = nil }; return rows
        }
        func add(_ a: C.CalendarAddArgs, cancellation: PhoneJobCancellation) throws -> String { writes += 1; return "event-1" }
        func change(_ a: C.CalendarChangeArgs, cancellation: PhoneJobCancellation) throws -> String { writes += 1; return a.id }
    }
    @MainActor final class RemindersFake: PhoneRemindersAccess {
        var granted = true, rows: [[String: Any]] = [], writes = 0, revoke = false
        func read(includeCompleted: Bool) async throws -> [[String: Any]] { if revoke { granted = false }; return rows }
        func add(_ a: C.RemindersAddArgs, cancellation: PhoneJobCancellation) throws -> String { writes += 1; return "reminder-1" }
        func complete(id: String, cancellation: PhoneJobCancellation) throws -> String { writes += 1; return id }
    }
    @MainActor final class ContactsFake: PhoneContactsAccess {
        var access: String? = "full", rows: [[String: Any]] = [], grantedIDs: Set<String> = [], revoke = false
        private func grantedRows() -> [[String: Any]] { rows.filter { access != "limited" || grantedIDs.contains($0["id"] as? String ?? "") } }
        func search(query: String, limit: Int) throws -> [[String: Any]] { let result = grantedRows(); if revoke { access = nil }; return result }
        func get(id: String) throws -> [String: Any]? { grantedRows().first { $0["id"] as? String == id } }
    }
    @MainActor final class LocationFake: PhoneLocationAccess {
        var granted = true, precise = true, requestedPrecise: Bool?, revoke = false, hold = false
        var pending: CheckedContinuation<PhoneLocationFix, Error>?
        func cancel() { let answer = pending; pending = nil; answer?.resume(throwing: PhoneExecutorFailure.denied) }
        func current(precise: Bool) async throws -> PhoneLocationFix {
            requestedPrecise = precise; if revoke { granted = false }
            if hold { return try await withCheckedThrowingContinuation { pending = $0 } }
            return .init(lat: 37.77491, lon: -122.41942, accuracy: 12.5, at: Date(timeIntervalSince1970: 1_790_000_000))
        }
    }
    @MainActor final class AlarmsFake: PhoneAlarmsAccess {
        var supported = true, granted = true, writes = 0
        var hour: Int?, minute: Int?, seconds: Int?, label: String?, operation: String?
        func set(operationId: String, hour: Int, minute: Int, label: String?, cancellation: PhoneJobCancellation) async throws -> String {
            writes += 1; operation = operationId; self.hour = hour; self.minute = minute; self.label = label; return operationId
        }
        func timer(operationId: String, seconds: Int, label: String?, cancellation: PhoneJobCancellation) async throws -> String {
            writes += 1; operation = operationId; self.seconds = seconds; self.label = label; return operationId
        }
    }
    @MainActor final class ComposerFake: PhoneMessageComposer {
        var available = true, recipients: [String]?, body: String?, opens = 0
        func open(recipients: [String], body: String, cancellation: PhoneJobCancellation) async throws { self.recipients = recipients; self.body = body; opens += 1 }
    }
    @MainActor final class DialerFake: PhoneDialer {
        var supported = true, number: String?, opens = 0
        var onAvailability: () -> Void = {}
        var available: Bool {
            get { onAvailability(); return supported }
            set { supported = newValue }
        }
        func open(number: String, cancellation: PhoneJobCancellation) async throws { self.number = number; opens += 1 }
    }
    @MainActor final class URLOpenerFake: URLOpener {
        var opened: [URL] = [], probed: [URL] = []
        var onForeground: () -> Void = {}
        var foreground: Bool { onForeground(); return true }
        func canOpenURL(_ url: URL) -> Bool { probed.append(url); return true }
        func open(_ url: URL, cancellation: PhoneJobCancellation) async throws -> Bool {
            try cancellation.check(); opened.append(url); return true
        }
    }
    @MainActor final class Rig {
        let memory = Memory(), calendar = CalendarFake(), reminders = RemindersFake(), contacts = ContactsFake()
        let location = LocationFake(), alarms = AlarmsFake(), composer = ComposerFake(), dialer = DialerFake()
        var now = Date(timeIntervalSince1970: 1_790_000_000)
        lazy var ledger = PhoneOperationLedger(storage: memory, now: { self.now })
        lazy var registry = NativePhoneJobExecutors(modules: [
            "calendar": PhoneCalendarExecutor(os: calendar, ledger: ledger), "reminders": PhoneRemindersExecutor(os: reminders, ledger: ledger),
            "contacts": PhoneContactsExecutor(os: contacts), "location": PhoneLocationExecutor(os: location),
            "alarms": PhoneAlarmsExecutor(os: alarms, ledger: ledger), "messages": PhoneMessagesExecutor(os: composer), "calls": PhoneCallsExecutor(os: dialer)
        ])
        func run(_ action: String, _ args: [String: Any], id: String = UUID().uuidString.lowercased(), precise: Bool = false) async throws -> PhoneJobExecution {
            let decoded = try XCTUnwrap(C.Args.parse(action: action, args))
            return await registry.run(operationId: id, capability: String(action.split(separator: ".")[0]), action: action, args: decoded, preciseConsent: precise, cancellation: PhoneJobCancellation())
        }
    }
    private func fixture() throws -> [String: Any] {
        var path = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while path.path != "/" {
            let file = path.appendingPathComponent("contract/phone-jobs.json")
            if FileManager.default.fileExists(atPath: file.path) {
                return try XCTUnwrap((JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])?["actions"] as? [String: Any])
            }
            path.deleteLastPathComponent()
        }
        throw PhoneExecutorFailure.invalidResult
    }
    private func output(_ execution: PhoneJobExecution, _ action: String) throws -> [String: Any] {
        guard case .result(let result) = execution else { XCTFail("Expected result for " + action); throw PhoneExecutorFailure.invalidResult }
        let json = try XCTUnwrap(result.encode())
        XCTAssertNotNil(C.Result.parse(action: action, json)); XCTAssertTrue(C.withinResultBound(json)); return json
    }
    private func error(_ execution: PhoneJobExecution, _ code: String) {
        guard case .error(let actual) = execution else { XCTFail("Expected " + code); return }; XCTAssertEqual(actual, code)
    }
    private var event: [String: Any] { ["id": "event-1", "title": "Meeting", "start": "2026-10-27T09:00:00Z", "end": "2026-10-27T10:00:00Z", "allDay": false, "calendar": "Work", "notes": "Only when asked", "attendees": ["private"], "url": "private"] }
    private var contact: [String: Any] { ["id": "c-1", "name": "Sam", "phones": [["number": "+15555550100", "label": "mobile", "private": true]], "emails": [["address": "sam@example.test", "private": true]], "birthday": "private"] }

    func testForbiddenDialCharactersDeclineWithoutOpening() async throws {
        for character in [":", "/", "?", "&", "%", ";", ",", "@", "a", "\n", "\t", "\u{202e}", "\u{00a0}", "١"] {
            let r = Rig()
            r.dialer.onAvailability = { XCTFail("Invalid number reached the dialer") }
            error(try await r.run("calls.dial", ["number": "+123" + character + "4"]), "denied")
            XCTAssertEqual(r.dialer.opens, 0)
        }
    }
    func testCancelledDialJobNeverOpensIncludingCancellationDuringAvailability() async throws {
        for cancelDuringAvailability in [false, true] {
            let r = Rig(), signal = PhoneJobCancellation()
            if cancelDuringAvailability { r.dialer.onAvailability = { signal.cancel() } }
            else { signal.cancel() }
            let args = try XCTUnwrap(C.Args.parse(action: "calls.dial", ["number": "+123"]))
            let result = await r.registry.run(operationId: UUID().uuidString.lowercased(), capability: "calls", action: "calls.dial",
                args: args, preciseConsent: false, cancellation: signal)
            error(result, "denied"); XCTAssertEqual(r.dialer.opens, 0)
        }
    }
    func testProductionDialerBuildsEncodedTelURLThroughURLOpener() async throws {
        let opener = URLOpenerFake(), signal = PhoneJobCancellation()
        let dialer = SystemPhoneDialer(opener: opener)
        XCTAssertTrue(dialer.available)
        XCTAssertEqual(opener.probed.map(\.absoluteString), ["tel:123"])
        try await dialer.open(number: "+1 (555) 010-20.30", cancellation: signal)
        XCTAssertEqual(opener.opened.map(\.absoluteString), ["tel:+1%20(555)%20010-20.30"])
        XCTAssertEqual(opener.opened.first?.scheme, "tel")
        XCTAssertNil(opener.opened.first?.fragment)
        XCTAssertNil(opener.opened.first?.query)
    }
    func testProductionDialerRefusesForbiddenCharactersAndCancelledJobs() async throws {
        for number in ["123;456", "123%23", "123\n", "123\u{202e}", "123?x", "１２３"] {
            let opener = URLOpenerFake()
            do {
                try await SystemPhoneDialer(opener: opener).open(number: number, cancellation: PhoneJobCancellation())
                XCTFail("Expected refusal")
            } catch let failure as PhoneExecutorFailure { XCTAssertEqual(failure.code, "denied") }
            XCTAssertTrue(opener.opened.isEmpty)
        }
        for cancelDuringForeground in [false, true] {
            let opener = URLOpenerFake(), signal = PhoneJobCancellation()
            if cancelDuringForeground { opener.onForeground = { signal.cancel() } }
            else { signal.cancel() }
            do {
                try await SystemPhoneDialer(opener: opener).open(number: "+123", cancellation: signal)
                XCTFail("Expected refusal")
            } catch let failure as PhoneExecutorFailure { XCTAssertEqual(failure.code, "denied") }
            XCTAssertTrue(opener.opened.isEmpty)
        }
    }

    func testCancellationDuringLedgerSavePreventsEveryOSWrite() async throws {
        let actions = try fixture()
        for action in ["calendar.add", "calendar.change", "reminders.add", "reminders.complete", "alarms.set", "alarms.timer"] {
            let r = Rig(), signal = PhoneJobCancellation()
            r.memory.beforeWrite = { signal.cancel() }
            let values = try XCTUnwrap(actions[action] as? [String: Any])
            let args = try XCTUnwrap((values["validArgs"] as? [[String: Any]])?.first)
            let decoded = try XCTUnwrap(C.Args.parse(action: action, args))
            let result = await r.registry.run(operationId: UUID().uuidString.lowercased(), capability: String(action.split(separator: ".")[0]),
                action: action, args: decoded, preciseConsent: false, cancellation: signal)
            error(result, "denied")
            XCTAssertEqual(r.calendar.writes + r.reminders.writes + r.alarms.writes, 0)
        }
    }

    func testEveryValidActionVectorProducesAnN1EncodedResult() async throws {
        let actions = try fixture(); var count = 0
        for (action, value) in actions {
            guard let spec = value as? [String: Any], let vectors = spec["validArgs"] as? [[String: Any]] else { continue }
            count += 1
            for args in vectors {
                let r = Rig(); r.calendar.rows = [event]; r.contacts.rows = [contact]
                r.reminders.rows = [["id": "r-1", "title": "Buy milk", "list": "Home", "completed": false, "private": true]]
                _ = try output(await r.run(action, args, precise: true), action)
            }
        }
        XCTAssertEqual(count, 14)
    }
    func testReadTrimmingNotesLimitsAndLimitedContacts() async throws {
        let r = Rig(); r.calendar.rows = [event, event]
        let args: [String: Any] = ["start": "2026-10-27T00:00:00Z", "end": "2026-10-28T00:00:00Z", "limit": 1]
        let read = try output(await r.run("calendar.read", args), "calendar.read")
        let row = try XCTUnwrap((read["events"] as? [[String: Any]])?.first)
        XCTAssertNil(row["attendees"]); XCTAssertNil(row["url"]); XCTAssertNil(row["notes"])
        XCTAssertFalse(r.calendar.notesRequested); XCTAssertEqual(read["truncated"] as? Bool, true)
        var withNotes = args; withNotes["includeNotes"] = true
        let included = try output(await r.run("calendar.read", withNotes), "calendar.read")
        XCTAssertNotNil((included["events"] as? [[String: Any]])?.first?["notes"])
        r.reminders.rows = [["id": "r-1", "title": "Milk", "completed": false, "list": "Home", "notes": "private"], ["id": "r-2", "title": "Done", "completed": true, "list": "Home"]]
        let reminders = try output(await r.run("reminders.read", [:]), "reminders.read")
        XCTAssertEqual((reminders["reminders"] as? [[String: Any]])?.count, 1)
        XCTAssertNil((reminders["reminders"] as? [[String: Any]])?.first?["notes"])
        var hidden = contact; hidden["id"] = "hidden"
        r.contacts.rows = [contact, hidden]; r.contacts.access = "limited"; r.contacts.grantedIDs = ["c-1"]
        let found = try output(await r.run("contacts.search", ["query": "Sam"]), "contacts.search")
        let contacts = try XCTUnwrap(found["contacts"] as? [[String: Any]])
        XCTAssertEqual(contacts.count, 1); XCTAssertEqual(found["limited"] as? Bool, true)
        XCTAssertNil(contacts[0]["birthday"]); XCTAssertNil((contacts[0]["phones"] as? [[String: Any]])?.first?["private"])
        let missing = try output(await r.run("contacts.get", ["id": "hidden"]), "contacts.get")
        XCTAssertTrue(missing["contact"] is NSNull); XCTAssertEqual(missing["limited"] as? Bool, true)
    }
    func testApproximateWithoutSeparateConsentAndOSPrecision() async throws {
        for (consent, osPrecise) in [(false, true), (true, false), (true, true)] {
            let r = Rig(); r.location.precise = osPrecise
            let value = try output(await r.run("location.get", ["precision": "precise"], precise: consent), "location.get")
            let precise = consent && osPrecise
            XCTAssertEqual(r.location.requestedPrecise, precise)
            XCTAssertEqual(value["precision"] as? String, precise ? "precise" : "approximate")
            XCTAssertEqual(value["lat"] as? Double, precise ? 37.77491 : 37.775)
            XCTAssertEqual(value["accuracyMeters"] as? Double, precise ? 12.5 : 100)
        }
    }
    func testComposerAndDialerOnlyOpenWithRequestedValues() async throws {
        let r = Rig()
        _ = try output(await r.run("messages.compose", ["to": ["+15555550100", "+15555550101"], "body": "Hi & hello"]), "messages.compose")
        XCTAssertEqual(r.composer.recipients, ["+15555550100", "+15555550101"]); XCTAssertEqual(r.composer.body, "Hi & hello"); XCTAssertEqual(r.composer.opens, 1)
        _ = try output(await r.run("calls.dial", ["number": "+15555550100"]), "calls.dial")
        XCTAssertEqual(r.dialer.number, "+15555550100"); XCTAssertEqual(r.dialer.opens, 1)
        // These seams deliberately have no send or call method.
    }
    func testEveryWriteDoneReplayPendingNoResaveExpiryAndMarkerOnlyStorage() async throws {
        let actions = try fixture()
        for action in ["calendar.add", "calendar.change", "reminders.add", "reminders.complete", "alarms.set", "alarms.timer"] {
            let r = Rig(), id = UUID().uuidString.lowercased()
            let spec = try XCTUnwrap(actions[action] as? [String: Any]); let args = try XCTUnwrap((spec["validArgs"] as? [[String: Any]])?.first)
            let first = try output(await r.run(action, args, id: id), action)
            let second = try output(await r.run(action, args, id: id), action)
            XCTAssertTrue(NSDictionary(dictionary: first).isEqual(to: second))
            XCTAssertEqual(r.calendar.writes + r.reminders.writes + r.alarms.writes, 1)
            let stored = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(r.memory.data)) as? [String: [String: Any]])
            XCTAssertEqual(Set(stored.keys), [PhoneOperationLedger.key(id)])
            XCTAssertEqual(Set(try XCTUnwrap(stored.values.first).keys), ["state", "identifier", "timestamp"])
            if !action.hasPrefix("alarms.") { XCTAssertFalse(String(data: r.memory.data!, encoding: .utf8)!.contains(id)) }
            for key in ["args", "result", "title", "notes", "body", "label"] { XCTAssertFalse(stored.values.contains { $0[key] != nil }) }
            r.now.addTimeInterval(PhoneOperationLedger.lifetime)
            _ = try output(await r.run(action, args, id: id), action)
            XCTAssertEqual(r.calendar.writes + r.reminders.writes + r.alarms.writes, 2)
            let pending = Rig()
            pending.memory.data = try JSONSerialization.data(withJSONObject: [PhoneOperationLedger.key(id): ["state": "pending", "timestamp": pending.now.timeIntervalSince1970]])
            error(try await pending.run(action, args, id: id), "denied")
            XCTAssertEqual(pending.calendar.writes + pending.reminders.writes + pending.alarms.writes, 0)
        }
    }
    func testDeniedRevokedWriteOnlyAndUnsupported() async throws {
        let actions = try fixture()
        for (action, value) in actions {
            guard let spec = value as? [String: Any], let args = (spec["validArgs"] as? [[String: Any]])?.first else { continue }
            let r = Rig(); r.calendar.access = nil; r.reminders.granted = false; r.contacts.access = nil; r.location.granted = false; r.alarms.granted = false; r.composer.available = false; r.dialer.available = false
            error(try await r.run(action, args), action.hasPrefix("messages.") || action.hasPrefix("calls.") ? "unsupported" : "denied")
        }
        let r = Rig(); r.calendar.access = "write-only"
        let add = try XCTUnwrap(((actions["calendar.add"] as? [String: Any])?["validArgs"] as? [[String: Any]])?.first)
        let result = try output(await r.run("calendar.add", add), "calendar.add"); XCTAssertEqual(result["writeOnly"] as? Bool, true)
        r.alarms.supported = false; error(try await r.run("alarms.set", ["hour": 8, "minute": 30]), "unsupported")
        for action in ["calendar.read", "calendar.free_time", "reminders.read", "contacts.search", "location.get"] {
            let revoked = Rig(); revoked.calendar.revoke = true; revoked.reminders.revoke = true; revoked.contacts.revoke = true; revoked.location.revoke = true
            let args = try XCTUnwrap(((actions[action] as? [String: Any])?["validArgs"] as? [[String: Any]])?.first)
            error(try await revoked.run(action, args), "denied")
        }
    }
    func testEncodedByteCapAfterTrimmingAndLedgerFailureBeforeSave() async throws {
        let r = Rig(); var large = event; large["notes"] = String(repeating: "漢", count: 4000)
        r.calendar.rows = Array(repeating: large, count: 200)
        error(try await r.run("calendar.read", ["start": "2026-10-27T00:00:00Z", "end": "2026-10-28T00:00:00Z", "includeNotes": true]), "too_large")
        for action in (try fixture()).keys where action != "note" {
            error(PhoneFields.result(action, ["payload": String(repeating: "漢", count: 100000)]), "too_large")
        }
        r.memory.fail = true
        error(try await r.run("reminders.add", ["title": "private title", "notes": "private notes"]), "denied")
        XCTAssertEqual(r.reminders.writes, 0)
    }
    func testInterruptedSavePersistsPendingAcrossLedgerInstancesAndExpires() async throws {
        let memory = Memory(), id = UUID().uuidString.lowercased()
        var now = Date(timeIntervalSince1970: 1_790_000_000), saves = 0
        let ledger = PhoneOperationLedger(storage: memory, now: { now })
        do {
            _ = try await ledger.perform(id) {
                saves += 1
                let rows = try JSONSerialization.jsonObject(with: XCTUnwrap(memory.data)) as! [String: [String: Any]]
                XCTAssertEqual(rows[PhoneOperationLedger.key(id)]?["state"] as? String, "pending")
                XCTAssertEqual(Set(rows[PhoneOperationLedger.key(id)]!.keys), ["state", "timestamp"])
                throw PhoneExecutorFailure.denied
            }
            XCTFail("Expected interruption")
        } catch {}
        let reopened = PhoneOperationLedger(storage: memory, now: { now })
        do { _ = try await reopened.perform(id) { saves += 1; return "event-1" }; XCTFail("Pending must refuse") } catch {}
        XCTAssertEqual(saves, 1)
        now.addTimeInterval(PhoneOperationLedger.lifetime)
        let identifier = try await reopened.perform(id) { saves += 1; return "event-1" }
        XCTAssertEqual(identifier, "event-1"); XCTAssertEqual(saves, 2)
    }
    func testBackgroundCancellationEndsOneShot() async throws {
        let r = Rig(); r.location.hold = true
        let task = Task { try await r.run("location.get", ["precision": "approximate"]) }
        while r.location.pending == nil { await Task.yield() }
        await r.registry.cancel()
        error(try await task.value, "denied"); XCTAssertNil(r.location.pending)
    }
    func testLargeReadResultsUseEncodedBytesAndUnknownDataIsDroppedFirst() async throws {
        let r = Rig()
        r.reminders.rows = Array(repeating: ["id": "r-1", "title": String(repeating: "漢", count: 500), "list": String(repeating: "漢", count: 200), "completed": false], count: 200)
        error(try await r.run("reminders.read", [:]), "too_large")
        let person: [String: Any] = ["id": "c-1", "name": String(repeating: "漢", count: 200),
            "phones": Array(repeating: ["number": String(repeating: "漢", count: 40), "label": String(repeating: "漢", count: 50)], count: 10),
            "emails": Array(repeating: ["address": String(repeating: "漢", count: 254), "label": String(repeating: "漢", count: 50)], count: 10)]
        r.contacts.rows = Array(repeating: person, count: 25)
        error(try await r.run("contacts.search", ["query": "Sam"]), "too_large")
        var small = contact; small["undocumented"] = String(repeating: "漢", count: 100000)
        r.contacts.rows = [small]
        _ = try output(await r.run("contacts.search", ["query": "Sam"]), "contacts.search")
    }

    func testFreeTimeMergesOverlapsAndClipsToRequestedWindow() async throws {
        let r = Rig()
        r.calendar.rows = [("08:00", "09:30"), ("09:00", "10:00"), ("10:30", "11:00")].map { s, e in
            ["start": "2026-10-27T" + s + ":00Z", "end": "2026-10-27T" + e + ":00Z"]
        }
        let result = try output(await r.run("calendar.free_time", ["start": "2026-10-27T09:00:00Z", "end": "2026-10-27T12:00:00Z", "durationMinutes": 30]), "calendar.free_time")
        let slots = try XCTUnwrap(result["slots"] as? [[String: String]])
        XCTAssertEqual(slots, [["start": "2026-10-27T10:00:00Z", "end": "2026-10-27T10:30:00Z"], ["start": "2026-10-27T11:00:00Z", "end": "2026-10-27T12:00:00Z"]])
    }
}
