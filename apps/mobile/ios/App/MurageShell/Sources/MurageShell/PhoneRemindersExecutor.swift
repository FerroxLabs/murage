import Foundation
import MurageShellCore

@MainActor protocol PhoneRemindersAccess {
    var granted: Bool { get }
    func read(includeCompleted: Bool) async throws -> [[String: Any]]
    func add(_ args: PhoneJobsContract.RemindersAddArgs, cancellation: PhoneJobCancellation) throws -> String
    func complete(id: String, cancellation: PhoneJobCancellation) throws -> String
}
@MainActor final class PhoneRemindersExecutor: PhoneCapabilityExecutor {
    let os: PhoneRemindersAccess, ledger: PhoneOperationLedger
    init(os: PhoneRemindersAccess, ledger: PhoneOperationLedger) { self.os = os; self.ledger = ledger }
    func execute(operationId: String, args: PhoneJobsContract.Args, preciseConsent: Bool, cancellation: PhoneJobCancellation) async throws -> [String: Any] {
        try cancellation.check()
        guard os.granted else { throw PhoneExecutorFailure.denied }
        switch args {
        case .remindersRead(let a):
            let rows = try await os.read(includeCompleted: a.includeCompleted == true)
                .filter { a.includeCompleted == true || ($0["completed"] as? Bool) == false }
            guard os.granted else { throw PhoneExecutorFailure.denied }
            let limit = a.limit ?? 200
            return ["reminders": rows.prefix(limit).map {
                PhoneFields.pick($0, strings: ["id": 256, "title": 500, "due": 64, "list": 200], other: ["completed"])
            }, "truncated": rows.count > limit]
        case .remindersAdd(let a):
            return ["id": try await ledger.perform(operationId) { try cancellation.check(); return try os.add(a, cancellation: cancellation) }]
        case .remindersComplete(let a):
            return ["id": try await ledger.perform(operationId) { try cancellation.check(); return try os.complete(id: a.id, cancellation: cancellation) }, "completed": true]
        default: throw PhoneExecutorFailure.unsupported
        }
    }
}
#if os(iOS)
import EventKit
@MainActor final class EventKitRemindersAccess: PhoneRemindersAccess {
    private let store = EKEventStore()
    var granted: Bool { EKEventStore.authorizationStatus(for: .reminder) == .fullAccess }
    func read(includeCompleted: Bool) async throws -> [[String: Any]] {
        guard granted else { throw PhoneExecutorFailure.denied }
        let predicate = store.predicateForReminders(in: nil)
        let reminders: [EKReminder] = try await withCheckedThrowingContinuation { continuation in
            store.fetchReminders(matching: predicate) { rows in
                guard let rows else { continuation.resume(throwing: PhoneExecutorFailure.denied); return }
                continuation.resume(returning: rows)
            }
        }
        guard granted else { throw PhoneExecutorFailure.denied }
        return reminders.filter { includeCompleted || !$0.isCompleted }.sorted { $0.calendarItemIdentifier < $1.calendarItemIdentifier }.map { reminder in
            var row: [String: Any] = ["id": reminder.calendarItemIdentifier, "title": reminder.title ?? "", "completed": reminder.isCompleted, "list": reminder.calendar.title ?? ""]
            if let components = reminder.dueDateComponents, let date = Calendar.current.date(from: components) { row["due"] = PhoneFields.time(date) }
            return row
        }
    }
    func add(_ a: PhoneJobsContract.RemindersAddArgs, cancellation: PhoneJobCancellation) throws -> String {
        guard granted, let calendar = store.defaultCalendarForNewReminders() else { throw PhoneExecutorFailure.denied }
        let reminder = EKReminder(eventStore: store); reminder.calendar = calendar; reminder.title = a.title
        reminder.notes = a.notes
        if let due = a.due, !due.isEmpty {
            reminder.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second, .timeZone], from: try PhoneFields.date(due))
        }
        try cancellation.beginWrite()
        try store.save(reminder, commit: true)
        return reminder.calendarItemIdentifier
    }
    func complete(id: String, cancellation: PhoneJobCancellation) throws -> String {
        guard granted, let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else { throw PhoneExecutorFailure.denied }
        if !reminder.isCompleted { reminder.isCompleted = true; try cancellation.beginWrite(); try store.save(reminder, commit: true) }
        return reminder.calendarItemIdentifier
    }
}
#endif
