import Foundation
import MurageShellCore

@MainActor protocol PhoneCalendarAccess {
    var access: String? { get }
    func events(start: Date, end: Date, includeNotes: Bool) throws -> [[String: Any]]
    func add(_ args: PhoneJobsContract.CalendarAddArgs, cancellation: PhoneJobCancellation) throws -> String
    func change(_ args: PhoneJobsContract.CalendarChangeArgs, cancellation: PhoneJobCancellation) throws -> String
}
@MainActor final class PhoneCalendarExecutor: PhoneCapabilityExecutor {
    let os: PhoneCalendarAccess, ledger: PhoneOperationLedger
    init(os: PhoneCalendarAccess, ledger: PhoneOperationLedger) { self.os = os; self.ledger = ledger }
    func execute(operationId: String, args: PhoneJobsContract.Args, preciseConsent: Bool, cancellation: PhoneJobCancellation) async throws -> [String: Any] {
        try cancellation.check()
        guard let access = os.access else { throw PhoneExecutorFailure.denied }
        switch args {
        case .calendarAdd(let a):
            let id = try await ledger.perform(operationId) { try cancellation.check(); return try os.add(a, cancellation: cancellation) }
            return ["id": id, "writeOnly": access == "write-only"]
        case .calendarChange(let a):
            guard access == "full" else { throw PhoneExecutorFailure.denied }
            return ["id": try await ledger.perform(operationId) { try cancellation.check(); return try os.change(a, cancellation: cancellation) }]
        case .calendarRead(let a):
            guard access == "full" else { throw PhoneExecutorFailure.denied }
            let rows = try os.events(start: PhoneFields.date(a.start), end: PhoneFields.date(a.end), includeNotes: a.includeNotes == true)
            guard os.access == "full" else { throw PhoneExecutorFailure.denied }
            var strings = ["id": 256, "title": 500, "calendar": 200, "location": 500]
            if a.includeNotes == true { strings["notes"] = 4000 }
            let limit = a.limit ?? 200
            return ["events": rows.prefix(limit).map { PhoneFields.pick($0, strings: strings, other: ["start", "end", "allDay"]) }, "truncated": rows.count > limit]
        case .calendarFreeTime(let a):
            guard access == "full" else { throw PhoneExecutorFailure.denied }
            let start = try PhoneFields.date(a.start), end = try PhoneFields.date(a.end)
            let rows = try os.events(start: start, end: end, includeNotes: false)
            guard os.access == "full" else { throw PhoneExecutorFailure.denied }
            let intervals = try rows.map { row -> (Date, Date) in
                guard let s = row["start"] as? String, let e = row["end"] as? String else { throw PhoneExecutorFailure.invalidResult }
                return (try PhoneFields.date(s), try PhoneFields.date(e))
            }.sorted { $0.0 < $1.0 }
            var cursor = start, slots: [[String: Any]] = []
            let duration = TimeInterval(a.durationMinutes * 60), limit = a.limit ?? 20
            for (s, e) in intervals + [(end, end)] {
                let stop = min(s, end)
                if stop.timeIntervalSince(cursor) >= duration, slots.count < limit {
                    slots.append(["start": PhoneFields.time(cursor), "end": PhoneFields.time(stop)])
                }
                cursor = min(end, max(cursor, e))
            }
            return ["slots": slots]
        default: throw PhoneExecutorFailure.unsupported
        }
    }
}

#if os(iOS)
import EventKit
@MainActor final class EventKitCalendarAccess: PhoneCalendarAccess {
    private let store = EKEventStore()
    var access: String? {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: return "full"
        case .writeOnly: return "write-only"
        default: return nil
        }
    }
    func events(start: Date, end: Date, includeNotes: Bool) throws -> [[String: Any]] {
        guard access == "full" else { throw PhoneExecutorFailure.denied }
        return store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil))
            .sorted { $0.startDate < $1.startDate }.map { event in
                var row: [String: Any] = ["id": event.eventIdentifier ?? "", "title": event.title ?? "", "start": PhoneFields.time(event.startDate),
                    "end": PhoneFields.time(event.endDate), "allDay": event.isAllDay, "calendar": event.calendar.title ?? ""]
                row["location"] = event.location
                if includeNotes { row["notes"] = event.notes }
                return row
            }
    }
    func add(_ a: PhoneJobsContract.CalendarAddArgs, cancellation: PhoneJobCancellation) throws -> String {
        guard access != nil, let calendar = store.defaultCalendarForNewEvents else { throw PhoneExecutorFailure.denied }
        let event = EKEvent(eventStore: store)
        event.calendar = calendar; event.title = a.title; event.startDate = try PhoneFields.date(a.start); event.endDate = try PhoneFields.date(a.end)
        event.isAllDay = a.allDay ?? false; event.location = a.location; event.notes = a.notes
        try cancellation.beginWrite()
        try store.save(event, span: .thisEvent, commit: true)
        // Both identifiers are supplied by the saved object, without a read-back query.
        let id = event.eventIdentifier ?? event.calendarItemIdentifier
        guard !id.isEmpty else { throw PhoneExecutorFailure.denied }
        return id
    }
    func change(_ a: PhoneJobsContract.CalendarChangeArgs, cancellation: PhoneJobCancellation) throws -> String {
        guard access == "full", let event = store.event(withIdentifier: a.id) ?? (store.calendarItem(withIdentifier: a.id) as? EKEvent) else { throw PhoneExecutorFailure.denied }
        if let title = a.title { event.title = title }
        if let start = a.start { event.startDate = try PhoneFields.date(start) }
        if let end = a.end { event.endDate = try PhoneFields.date(end) }
        guard event.endDate > event.startDate else { throw PhoneExecutorFailure.denied }
        if let location = a.location { event.location = location }
        if let notes = a.notes { event.notes = notes }
        // Preserve any existing user URL on changes; the durable ledger owns deduplication.
        try cancellation.beginWrite()
        try store.save(event, span: .thisEvent, commit: true)
        return event.eventIdentifier ?? a.id
    }
}
#endif
