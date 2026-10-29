import CryptoKit
import CoreFoundation
import Foundation

/// Native twin of shared/phone-jobs-contract.ts and phone-jobs-hash.ts.
/// JSON lengths use UTF-16 units, just as JavaScript does. No UI dependencies.
public enum PhoneJobsContract {
    public static let tag = "murage-phone-jobs/1"
    public static let ttlMs = 60_000
    public static let resultMaxBytes = 262_144
    public static let capabilities = ["calendar", "reminders", "contacts", "location", "alarms", "messages", "calls"]
    public static let resultCodes = ["denied", "unsupported", "too_large", "invalid_result", "declined"]

    public static func approvalKeyId(point: String) -> String? {
        guard matches(point, "[A-Za-z0-9_-]{87}"),
              let bytes = Data(base64Encoded: point.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "="),
              bytes.count == 65, bytes.first == 4 else { return nil }
        return Data(SHA256.hash(data: bytes)).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    public static func phoneJobsMessage(origin: String, keyId: String, nonce: String, expiresAt: Int64) -> String {
        [tag, origin, keyId, nonce, String(expiresAt)].joined(separator: "\n")
    }

    public static func tokenValid(_ value: String) -> Bool { matches(value, "murage_pj_[A-Za-z0-9_-]{43}") }

    public struct Event {
        public let id: String
        public let title: String
        public let start: String
        public let end: String
        public let allDay: Bool
        public let calendar: String
        public let location: String?
        public let notes: String?

        public init(id: String, title: String, start: String, end: String, allDay: Bool, calendar: String, location: String? = nil, notes: String? = nil) {
            self.id = id
            self.title = title
            self.start = start
            self.end = end
            self.allDay = allDay
            self.calendar = calendar
            self.location = location
            self.notes = notes
        }

        public static func parse(_ any: Any?) -> Event? {
            guard let o = any as? [String: Any], valid("Event", o) else { return nil }
            return Event(
                id: (o["id"]! as! String),
                title: (o["title"]! as! String),
                start: (o["start"]! as! String),
                end: (o["end"]! as! String),
                allDay: (o["allDay"]! as! Bool),
                calendar: (o["calendar"]! as! String),
                location: o["location"].map { ($0 as! String) },
                notes: o["notes"].map { ($0 as! String) }
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            o["id"] = id
            o["title"] = title
            o["start"] = start
            o["end"] = end
            o["allDay"] = allDay
            o["calendar"] = calendar
            if let location { o["location"] = location }
            if let notes { o["notes"] = notes }
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("Event", o) && withinResultBound(o) ? o : nil
        }
    }

    public struct ContactPhone {
        public let label: String?
        public let number: String

        public init(label: String? = nil, number: String) {
            self.label = label
            self.number = number
        }

        public static func parse(_ any: Any?) -> ContactPhone? {
            guard let o = any as? [String: Any], valid("ContactPhone", o) else { return nil }
            return ContactPhone(
                label: o["label"].map { ($0 as! String) },
                number: (o["number"]! as! String)
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            if let label { o["label"] = label }
            o["number"] = number
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("ContactPhone", o) && withinResultBound(o) ? o : nil
        }
    }

    public struct ContactEmail {
        public let label: String?
        public let address: String

        public init(label: String? = nil, address: String) {
            self.label = label
            self.address = address
        }

        public static func parse(_ any: Any?) -> ContactEmail? {
            guard let o = any as? [String: Any], valid("ContactEmail", o) else { return nil }
            return ContactEmail(
                label: o["label"].map { ($0 as! String) },
                address: (o["address"]! as! String)
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            if let label { o["label"] = label }
            o["address"] = address
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("ContactEmail", o) && withinResultBound(o) ? o : nil
        }
    }

    public struct Contact {
        public let id: String
        public let name: String
        public let phones: [ContactPhone]
        public let emails: [ContactEmail]

        public init(id: String, name: String, phones: [ContactPhone], emails: [ContactEmail]) {
            self.id = id
            self.name = name
            self.phones = phones
            self.emails = emails
        }

        public static func parse(_ any: Any?) -> Contact? {
            guard let o = any as? [String: Any], valid("Contact", o) else { return nil }
            return Contact(
                id: (o["id"]! as! String),
                name: (o["name"]! as! String),
                phones: (o["phones"]! as! [Any]).map { ContactPhone.parse($0)! },
                emails: (o["emails"]! as! [Any]).map { ContactEmail.parse($0)! }
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            o["id"] = id
            o["name"] = name
            o["phones"] = phones.map { $0.wire }
            o["emails"] = emails.map { $0.wire }
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("Contact", o) && withinResultBound(o) ? o : nil
        }
    }

    public struct Slot {
        public let start: String
        public let end: String

        public init(start: String, end: String) {
            self.start = start
            self.end = end
        }

        public static func parse(_ any: Any?) -> Slot? {
            guard let o = any as? [String: Any], valid("Slot", o) else { return nil }
            return Slot(
                start: (o["start"]! as! String),
                end: (o["end"]! as! String)
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            o["start"] = start
            o["end"] = end
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("Slot", o) && withinResultBound(o) ? o : nil
        }
    }

    public struct Reminder {
        public let id: String
        public let title: String
        public let due: String?
        public let completed: Bool
        public let list: String

        public init(id: String, title: String, due: String? = nil, completed: Bool, list: String) {
            self.id = id
            self.title = title
            self.due = due
            self.completed = completed
            self.list = list
        }

        public static func parse(_ any: Any?) -> Reminder? {
            guard let o = any as? [String: Any], valid("Reminder", o) else { return nil }
            return Reminder(
                id: (o["id"]! as! String),
                title: (o["title"]! as! String),
                due: o["due"].map { ($0 as! String) },
                completed: (o["completed"]! as! Bool),
                list: (o["list"]! as! String)
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            o["id"] = id
            o["title"] = title
            if let due { o["due"] = due }
            o["completed"] = completed
            o["list"] = list
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("Reminder", o) && withinResultBound(o) ? o : nil
        }
    }

    public struct CalendarReadArgs {
        public let start: String
        public let end: String
        public let includeNotes: Bool?
        public let limit: Int?

        public init(start: String, end: String, includeNotes: Bool? = nil, limit: Int? = nil) {
            self.start = start
            self.end = end
            self.includeNotes = includeNotes
            self.limit = limit
        }

        public static func parse(_ any: Any?) -> CalendarReadArgs? {
            guard let o = any as? [String: Any], valid("CalendarReadArgs", o) else { return nil }
            return CalendarReadArgs(
                start: (o["start"]! as! String),
                end: (o["end"]! as! String),
                includeNotes: o["includeNotes"].map { ($0 as! Bool) },
                limit: o["limit"].map { ($0 as! NSNumber).intValue }
            )
        }
    }

    public struct CalendarReadResult {
        public let events: [Event]
        public let truncated: Bool

        public init(events: [Event], truncated: Bool) {
            self.events = events
            self.truncated = truncated
        }

        public static func parse(_ any: Any?) -> CalendarReadResult? {
            guard let o = any as? [String: Any], valid("CalendarReadResult", o) else { return nil }
            return CalendarReadResult(
                events: (o["events"]! as! [Any]).map { Event.parse($0)! },
                truncated: (o["truncated"]! as! Bool)
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            o["events"] = events.map { $0.wire }
            o["truncated"] = truncated
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("CalendarReadResult", o) && withinResultBound(o) ? o : nil
        }
    }

    public struct CalendarFreeTimeArgs {
        public let start: String
        public let end: String
        public let durationMinutes: Int
        public let limit: Int?

        public init(start: String, end: String, durationMinutes: Int, limit: Int? = nil) {
            self.start = start
            self.end = end
            self.durationMinutes = durationMinutes
            self.limit = limit
        }

        public static func parse(_ any: Any?) -> CalendarFreeTimeArgs? {
            guard let o = any as? [String: Any], valid("CalendarFreeTimeArgs", o) else { return nil }
            return CalendarFreeTimeArgs(
                start: (o["start"]! as! String),
                end: (o["end"]! as! String),
                durationMinutes: (o["durationMinutes"]! as! NSNumber).intValue,
                limit: o["limit"].map { ($0 as! NSNumber).intValue }
            )
        }
    }

    public struct CalendarFreeTimeResult {
        public let slots: [Slot]

        public init(slots: [Slot]) {
            self.slots = slots
        }

        public static func parse(_ any: Any?) -> CalendarFreeTimeResult? {
            guard let o = any as? [String: Any], valid("CalendarFreeTimeResult", o) else { return nil }
            return CalendarFreeTimeResult(
                slots: (o["slots"]! as! [Any]).map { Slot.parse($0)! }
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            o["slots"] = slots.map { $0.wire }
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("CalendarFreeTimeResult", o) && withinResultBound(o) ? o : nil
        }
    }

    public struct CalendarAddArgs {
        public let title: String
        public let start: String
        public let end: String
        public let allDay: Bool?
        public let location: String?
        public let notes: String?

        public init(title: String, start: String, end: String, allDay: Bool? = nil, location: String? = nil, notes: String? = nil) {
            self.title = title
            self.start = start
            self.end = end
            self.allDay = allDay
            self.location = location
            self.notes = notes
        }

        public static func parse(_ any: Any?) -> CalendarAddArgs? {
            guard let o = any as? [String: Any], valid("CalendarAddArgs", o) else { return nil }
            return CalendarAddArgs(
                title: (o["title"]! as! String),
                start: (o["start"]! as! String),
                end: (o["end"]! as! String),
                allDay: o["allDay"].map { ($0 as! Bool) },
                location: o["location"].map { ($0 as! String) },
                notes: o["notes"].map { ($0 as! String) }
            )
        }
    }

    public struct CalendarAddResult {
        public let id: String
        public let writeOnly: Bool

        public init(id: String, writeOnly: Bool) {
            self.id = id
            self.writeOnly = writeOnly
        }

        public static func parse(_ any: Any?) -> CalendarAddResult? {
            guard let o = any as? [String: Any], valid("CalendarAddResult", o) else { return nil }
            return CalendarAddResult(
                id: (o["id"]! as! String),
                writeOnly: (o["writeOnly"]! as! Bool)
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            o["id"] = id
            o["writeOnly"] = writeOnly
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("CalendarAddResult", o) && withinResultBound(o) ? o : nil
        }
    }

    public struct CalendarChangeArgs {
        public let id: String
        public let title: String?
        public let start: String?
        public let end: String?
        public let location: String?
        public let notes: String?

        public init(id: String, title: String? = nil, start: String? = nil, end: String? = nil, location: String? = nil, notes: String? = nil) {
            self.id = id
            self.title = title
            self.start = start
            self.end = end
            self.location = location
            self.notes = notes
        }

        public static func parse(_ any: Any?) -> CalendarChangeArgs? {
            guard let o = any as? [String: Any], valid("CalendarChangeArgs", o) else { return nil }
            return CalendarChangeArgs(
                id: (o["id"]! as! String),
                title: o["title"].map { ($0 as! String) },
                start: o["start"].map { ($0 as! String) },
                end: o["end"].map { ($0 as! String) },
                location: o["location"].map { ($0 as! String) },
                notes: o["notes"].map { ($0 as! String) }
            )
        }
    }

    public struct CalendarChangeResult {
        public let id: String

        public init(id: String) {
            self.id = id
        }

        public static func parse(_ any: Any?) -> CalendarChangeResult? {
            guard let o = any as? [String: Any], valid("CalendarChangeResult", o) else { return nil }
            return CalendarChangeResult(
                id: (o["id"]! as! String)
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            o["id"] = id
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("CalendarChangeResult", o) && withinResultBound(o) ? o : nil
        }
    }

    public struct RemindersReadArgs {
        public let includeCompleted: Bool?
        public let limit: Int?

        public init(includeCompleted: Bool? = nil, limit: Int? = nil) {
            self.includeCompleted = includeCompleted
            self.limit = limit
        }

        public static func parse(_ any: Any?) -> RemindersReadArgs? {
            guard let o = any as? [String: Any], valid("RemindersReadArgs", o) else { return nil }
            return RemindersReadArgs(
                includeCompleted: o["includeCompleted"].map { ($0 as! Bool) },
                limit: o["limit"].map { ($0 as! NSNumber).intValue }
            )
        }
    }

    public struct RemindersReadResult {
        public let reminders: [Reminder]
        public let truncated: Bool

        public init(reminders: [Reminder], truncated: Bool) {
            self.reminders = reminders
            self.truncated = truncated
        }

        public static func parse(_ any: Any?) -> RemindersReadResult? {
            guard let o = any as? [String: Any], valid("RemindersReadResult", o) else { return nil }
            return RemindersReadResult(
                reminders: (o["reminders"]! as! [Any]).map { Reminder.parse($0)! },
                truncated: (o["truncated"]! as! Bool)
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            o["reminders"] = reminders.map { $0.wire }
            o["truncated"] = truncated
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("RemindersReadResult", o) && withinResultBound(o) ? o : nil
        }
    }

    public struct RemindersAddArgs {
        public let title: String
        public let due: String?
        public let notes: String?

        public init(title: String, due: String? = nil, notes: String? = nil) {
            self.title = title
            self.due = due
            self.notes = notes
        }

        public static func parse(_ any: Any?) -> RemindersAddArgs? {
            guard let o = any as? [String: Any], valid("RemindersAddArgs", o) else { return nil }
            return RemindersAddArgs(
                title: (o["title"]! as! String),
                due: o["due"].map { ($0 as! String) },
                notes: o["notes"].map { ($0 as! String) }
            )
        }
    }

    public struct RemindersAddResult {
        public let id: String

        public init(id: String) {
            self.id = id
        }

        public static func parse(_ any: Any?) -> RemindersAddResult? {
            guard let o = any as? [String: Any], valid("RemindersAddResult", o) else { return nil }
            return RemindersAddResult(
                id: (o["id"]! as! String)
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            o["id"] = id
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("RemindersAddResult", o) && withinResultBound(o) ? o : nil
        }
    }

    public struct RemindersCompleteArgs {
        public let id: String

        public init(id: String) {
            self.id = id
        }

        public static func parse(_ any: Any?) -> RemindersCompleteArgs? {
            guard let o = any as? [String: Any], valid("RemindersCompleteArgs", o) else { return nil }
            return RemindersCompleteArgs(
                id: (o["id"]! as! String)
            )
        }
    }

    public struct RemindersCompleteResult {
        public let id: String
        public let completed: Bool

        public init(id: String, completed: Bool) {
            self.id = id
            self.completed = completed
        }

        public static func parse(_ any: Any?) -> RemindersCompleteResult? {
            guard let o = any as? [String: Any], valid("RemindersCompleteResult", o) else { return nil }
            return RemindersCompleteResult(
                id: (o["id"]! as! String),
                completed: (o["completed"]! as! Bool)
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            o["id"] = id
            o["completed"] = completed
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("RemindersCompleteResult", o) && withinResultBound(o) ? o : nil
        }
    }

    public struct ContactsSearchArgs {
        public let query: String
        public let limit: Int?

        public init(query: String, limit: Int? = nil) {
            self.query = query
            self.limit = limit
        }

        public static func parse(_ any: Any?) -> ContactsSearchArgs? {
            guard let o = any as? [String: Any], valid("ContactsSearchArgs", o) else { return nil }
            return ContactsSearchArgs(
                query: (o["query"]! as! String),
                limit: o["limit"].map { ($0 as! NSNumber).intValue }
            )
        }
    }

    public struct ContactsSearchResult {
        public let contacts: [Contact]
        public let limited: Bool

        public init(contacts: [Contact], limited: Bool) {
            self.contacts = contacts
            self.limited = limited
        }

        public static func parse(_ any: Any?) -> ContactsSearchResult? {
            guard let o = any as? [String: Any], valid("ContactsSearchResult", o) else { return nil }
            return ContactsSearchResult(
                contacts: (o["contacts"]! as! [Any]).map { Contact.parse($0)! },
                limited: (o["limited"]! as! Bool)
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            o["contacts"] = contacts.map { $0.wire }
            o["limited"] = limited
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("ContactsSearchResult", o) && withinResultBound(o) ? o : nil
        }
    }

    public struct ContactsGetArgs {
        public let id: String

        public init(id: String) {
            self.id = id
        }

        public static func parse(_ any: Any?) -> ContactsGetArgs? {
            guard let o = any as? [String: Any], valid("ContactsGetArgs", o) else { return nil }
            return ContactsGetArgs(
                id: (o["id"]! as! String)
            )
        }
    }

    public struct ContactsGetResult {
        public let contact: Contact?
        public let limited: Bool

        public init(contact: Contact?, limited: Bool) {
            self.contact = contact
            self.limited = limited
        }

        public static func parse(_ any: Any?) -> ContactsGetResult? {
            guard let o = any as? [String: Any], valid("ContactsGetResult", o) else { return nil }
            return ContactsGetResult(
                contact: (o["contact"]! is NSNull ? nil : Contact.parse(o["contact"]!)!),
                limited: (o["limited"]! as! Bool)
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            o["contact"] = contact.map { $0.wire as Any } ?? NSNull()
            o["limited"] = limited
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("ContactsGetResult", o) && withinResultBound(o) ? o : nil
        }
    }

    public struct LocationGetArgs {
        public let precision: String

        public init(precision: String) {
            self.precision = precision
        }

        public static func parse(_ any: Any?) -> LocationGetArgs? {
            guard let o = any as? [String: Any], valid("LocationGetArgs", o) else { return nil }
            return LocationGetArgs(
                precision: (o["precision"]! as! String)
            )
        }
    }

    public struct LocationGetResult {
        public let lat: Double
        public let lon: Double
        public let accuracyMeters: Double
        public let precision: String
        public let at: String

        public init(lat: Double, lon: Double, accuracyMeters: Double, precision: String, at: String) {
            self.lat = lat
            self.lon = lon
            self.accuracyMeters = accuracyMeters
            self.precision = precision
            self.at = at
        }

        public static func parse(_ any: Any?) -> LocationGetResult? {
            guard let o = any as? [String: Any], valid("LocationGetResult", o) else { return nil }
            return LocationGetResult(
                lat: (o["lat"]! as! NSNumber).doubleValue,
                lon: (o["lon"]! as! NSNumber).doubleValue,
                accuracyMeters: (o["accuracyMeters"]! as! NSNumber).doubleValue,
                precision: (o["precision"]! as! String),
                at: (o["at"]! as! String)
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            o["lat"] = lat
            o["lon"] = lon
            o["accuracyMeters"] = accuracyMeters
            o["precision"] = precision
            o["at"] = at
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("LocationGetResult", o) && withinResultBound(o) ? o : nil
        }
    }

    public struct AlarmsSetArgs {
        public let hour: Int
        public let minute: Int
        public let label: String?

        public init(hour: Int, minute: Int, label: String? = nil) {
            self.hour = hour
            self.minute = minute
            self.label = label
        }

        public static func parse(_ any: Any?) -> AlarmsSetArgs? {
            guard let o = any as? [String: Any], valid("AlarmsSetArgs", o) else { return nil }
            return AlarmsSetArgs(
                hour: (o["hour"]! as! NSNumber).intValue,
                minute: (o["minute"]! as! NSNumber).intValue,
                label: o["label"].map { ($0 as! String) }
            )
        }
    }

    public struct AlarmsSetResult {
        public let outcome: String

        public init(outcome: String) {
            self.outcome = outcome
        }

        public static func parse(_ any: Any?) -> AlarmsSetResult? {
            guard let o = any as? [String: Any], valid("AlarmsSetResult", o) else { return nil }
            return AlarmsSetResult(
                outcome: (o["outcome"]! as! String)
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            o["outcome"] = outcome
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("AlarmsSetResult", o) && withinResultBound(o) ? o : nil
        }
    }

    public struct AlarmsTimerArgs {
        public let seconds: Int
        public let label: String?

        public init(seconds: Int, label: String? = nil) {
            self.seconds = seconds
            self.label = label
        }

        public static func parse(_ any: Any?) -> AlarmsTimerArgs? {
            guard let o = any as? [String: Any], valid("AlarmsTimerArgs", o) else { return nil }
            return AlarmsTimerArgs(
                seconds: (o["seconds"]! as! NSNumber).intValue,
                label: o["label"].map { ($0 as! String) }
            )
        }
    }

    public struct AlarmsTimerResult {
        public let outcome: String

        public init(outcome: String) {
            self.outcome = outcome
        }

        public static func parse(_ any: Any?) -> AlarmsTimerResult? {
            guard let o = any as? [String: Any], valid("AlarmsTimerResult", o) else { return nil }
            return AlarmsTimerResult(
                outcome: (o["outcome"]! as! String)
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            o["outcome"] = outcome
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("AlarmsTimerResult", o) && withinResultBound(o) ? o : nil
        }
    }

    /// Approval and dialer share this exact ASCII alphabet; never normalize a destination.
    /// This contract has no iMessage-specific email recipient mode.
    public static func isDialNumber(_ value: String) -> Bool {
        let allowed = CharacterSet(charactersIn: "0123456789+ -.()")
        return !value.isEmpty && value.utf16.count <= 40 && value.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    public static func isMessageBody(_ value: String) -> Bool {
        value.utf16.count <= 2000 && value.unicodeScalars.allSatisfy {
            $0.value == 10 || ($0.properties.generalCategory != .control && $0.properties.generalCategory != .format)
        }
    }

    /// The wire shape can carry arbitrary text. Native approval is stricter and never sanitizes it.
    private static func approvalArgs(action: String, _ raw: [String: Any]) -> Args? {
        guard let args = Args.parse(action: action, raw) else { return nil }
        switch args {
        case .callsDial(let a): guard isDialNumber(a.number) else { return nil }
        case .messagesCompose(let a):
            guard a.to.allSatisfy(isDialNumber), isMessageBody(a.body) else { return nil }
        default: break
        }
        return args
    }

    public struct MessagesComposeArgs {
        public let to: [String]
        public let body: String

        public init(to: [String], body: String) {
            self.to = to
            self.body = body
        }

        public static func parse(_ any: Any?) -> MessagesComposeArgs? {
            guard let o = any as? [String: Any], valid("MessagesComposeArgs", o) else { return nil }
            return MessagesComposeArgs(
                to: (o["to"]! as! [Any]).map { ($0 as! String) },
                body: (o["body"]! as! String)
            )
        }
    }

    public struct MessagesComposeResult {
        public let outcome: String

        public init(outcome: String) {
            self.outcome = outcome
        }

        public static func parse(_ any: Any?) -> MessagesComposeResult? {
            guard let o = any as? [String: Any], valid("MessagesComposeResult", o) else { return nil }
            return MessagesComposeResult(
                outcome: (o["outcome"]! as! String)
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            o["outcome"] = outcome
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("MessagesComposeResult", o) && withinResultBound(o) ? o : nil
        }
    }

    public struct CallsDialArgs {
        public let number: String

        public init(number: String) {
            self.number = number
        }

        public static func parse(_ any: Any?) -> CallsDialArgs? {
            guard let o = any as? [String: Any], valid("CallsDialArgs", o) else { return nil }
            return CallsDialArgs(
                number: (o["number"]! as! String)
            )
        }
    }

    public struct CallsDialResult {
        public let outcome: String

        public init(outcome: String) {
            self.outcome = outcome
        }

        public static func parse(_ any: Any?) -> CallsDialResult? {
            guard let o = any as? [String: Any], valid("CallsDialResult", o) else { return nil }
            return CallsDialResult(
                outcome: (o["outcome"]! as! String)
            )
        }

        fileprivate var wire: [String: Any] {
            var o: [String: Any] = [:]
            o["outcome"] = outcome
            return o
        }

        public func encode() -> [String: Any]? {
            let o = wire
            return valid("CallsDialResult", o) && withinResultBound(o) ? o : nil
        }
    }

    public enum Args {
        case calendarRead(CalendarReadArgs)
        case calendarFreeTime(CalendarFreeTimeArgs)
        case calendarAdd(CalendarAddArgs)
        case calendarChange(CalendarChangeArgs)
        case remindersRead(RemindersReadArgs)
        case remindersAdd(RemindersAddArgs)
        case remindersComplete(RemindersCompleteArgs)
        case contactsSearch(ContactsSearchArgs)
        case contactsGet(ContactsGetArgs)
        case locationGet(LocationGetArgs)
        case alarmsSet(AlarmsSetArgs)
        case alarmsTimer(AlarmsTimerArgs)
        case messagesCompose(MessagesComposeArgs)
        case callsDial(CallsDialArgs)

        public static func parse(action: String, _ any: Any?) -> Args? {
            switch action {
            case "calendar.read": return CalendarReadArgs.parse(any).map(Self.calendarRead)
            case "calendar.free_time": return CalendarFreeTimeArgs.parse(any).map(Self.calendarFreeTime)
            case "calendar.add": return CalendarAddArgs.parse(any).map(Self.calendarAdd)
            case "calendar.change": return CalendarChangeArgs.parse(any).map(Self.calendarChange)
            case "reminders.read": return RemindersReadArgs.parse(any).map(Self.remindersRead)
            case "reminders.add": return RemindersAddArgs.parse(any).map(Self.remindersAdd)
            case "reminders.complete": return RemindersCompleteArgs.parse(any).map(Self.remindersComplete)
            case "contacts.search": return ContactsSearchArgs.parse(any).map(Self.contactsSearch)
            case "contacts.get": return ContactsGetArgs.parse(any).map(Self.contactsGet)
            case "location.get": return LocationGetArgs.parse(any).map(Self.locationGet)
            case "alarms.set": return AlarmsSetArgs.parse(any).map(Self.alarmsSet)
            case "alarms.timer": return AlarmsTimerArgs.parse(any).map(Self.alarmsTimer)
            case "messages.compose": return MessagesComposeArgs.parse(any).map(Self.messagesCompose)
            case "calls.dial": return CallsDialArgs.parse(any).map(Self.callsDial)
            default: return nil
            }
        }
    }

    public enum Result {
        case calendarRead(CalendarReadResult)
        case calendarFreeTime(CalendarFreeTimeResult)
        case calendarAdd(CalendarAddResult)
        case calendarChange(CalendarChangeResult)
        case remindersRead(RemindersReadResult)
        case remindersAdd(RemindersAddResult)
        case remindersComplete(RemindersCompleteResult)
        case contactsSearch(ContactsSearchResult)
        case contactsGet(ContactsGetResult)
        case locationGet(LocationGetResult)
        case alarmsSet(AlarmsSetResult)
        case alarmsTimer(AlarmsTimerResult)
        case messagesCompose(MessagesComposeResult)
        case callsDial(CallsDialResult)

        public static func parse(action: String, _ any: Any?) -> Result? {
            switch action {
            case "calendar.read": return CalendarReadResult.parse(any).map(Self.calendarRead)
            case "calendar.free_time": return CalendarFreeTimeResult.parse(any).map(Self.calendarFreeTime)
            case "calendar.add": return CalendarAddResult.parse(any).map(Self.calendarAdd)
            case "calendar.change": return CalendarChangeResult.parse(any).map(Self.calendarChange)
            case "reminders.read": return RemindersReadResult.parse(any).map(Self.remindersRead)
            case "reminders.add": return RemindersAddResult.parse(any).map(Self.remindersAdd)
            case "reminders.complete": return RemindersCompleteResult.parse(any).map(Self.remindersComplete)
            case "contacts.search": return ContactsSearchResult.parse(any).map(Self.contactsSearch)
            case "contacts.get": return ContactsGetResult.parse(any).map(Self.contactsGet)
            case "location.get": return LocationGetResult.parse(any).map(Self.locationGet)
            case "alarms.set": return AlarmsSetResult.parse(any).map(Self.alarmsSet)
            case "alarms.timer": return AlarmsTimerResult.parse(any).map(Self.alarmsTimer)
            case "messages.compose": return MessagesComposeResult.parse(any).map(Self.messagesCompose)
            case "calls.dial": return CallsDialResult.parse(any).map(Self.callsDial)
            default: return nil
            }
        }

        public func encode() -> [String: Any]? {
            switch self {
            case .calendarRead(let value): return value.encode()
            case .calendarFreeTime(let value): return value.encode()
            case .calendarAdd(let value): return value.encode()
            case .calendarChange(let value): return value.encode()
            case .remindersRead(let value): return value.encode()
            case .remindersAdd(let value): return value.encode()
            case .remindersComplete(let value): return value.encode()
            case .contactsSearch(let value): return value.encode()
            case .contactsGet(let value): return value.encode()
            case .locationGet(let value): return value.encode()
            case .alarmsSet(let value): return value.encode()
            case .alarmsTimer(let value): return value.encode()
            case .messagesCompose(let value): return value.encode()
            case .callsDial(let value): return value.encode()
            }
        }
    }

    private static let schemas: [String: [String: Rule]] = [
        "Event": ["id": .text(1, 256), "title": .text(0, 500), "start": .time, "end": .time, "allDay": .boolean, "calendar": .text(0, 200), "location?": .text(0, 500), "notes?": .text(0, 4000)],
        "ContactPhone": ["label?": .text(0, 50), "number": .text(1, 40)],
        "ContactEmail": ["label?": .text(0, 50), "address": .text(1, 254)],
        "Contact": ["id": .text(1, 256), "name": .text(0, 200), "phones": .array(.object("ContactPhone"), 0, 10), "emails": .array(.object("ContactEmail"), 0, 10)],
        "Slot": ["start": .time, "end": .time],
        "Reminder": ["id": .text(1, 256), "title": .text(0, 500), "due?": .text(0, 64), "completed": .boolean, "list": .text(0, 200)],
        "CalendarReadArgs": ["start": .time, "end": .time, "includeNotes?": .boolean, "limit?": .integer(1, 200)],
        "CalendarReadResult": ["events": .array(.object("Event"), 0, 200), "truncated": .boolean],
        "CalendarFreeTimeArgs": ["start": .time, "end": .time, "durationMinutes": .integer(5, 480), "limit?": .integer(1, 20)],
        "CalendarFreeTimeResult": ["slots": .array(.object("Slot"), 0, 20)],
        "CalendarAddArgs": ["title": .text(1, 500), "start": .time, "end": .time, "allDay?": .boolean, "location?": .text(0, 500), "notes?": .text(0, 4000)],
        "CalendarAddResult": ["id": .text(1, 256), "writeOnly": .boolean],
        "CalendarChangeArgs": ["id": .text(1, 256), "title?": .text(1, 500), "start?": .time, "end?": .time, "location?": .text(0, 500), "notes?": .text(0, 4000)],
        "CalendarChangeResult": ["id": .text(1, 256)],
        "RemindersReadArgs": ["includeCompleted?": .boolean, "limit?": .integer(1, 200)],
        "RemindersReadResult": ["reminders": .array(.object("Reminder"), 0, 200), "truncated": .boolean],
        "RemindersAddArgs": ["title": .text(1, 500), "due?": .text(0, 64), "notes?": .text(0, 4000)],
        "RemindersAddResult": ["id": .text(1, 256)],
        "RemindersCompleteArgs": ["id": .text(1, 256)],
        "RemindersCompleteResult": ["id": .text(1, 256), "completed": .trueValue],
        "ContactsSearchArgs": ["query": .text(1, 100), "limit?": .integer(1, 25)],
        "ContactsSearchResult": ["contacts": .array(.object("Contact"), 0, 25), "limited": .boolean],
        "ContactsGetArgs": ["id": .text(1, 256)],
        "ContactsGetResult": ["contact": .nullable(.object("Contact")), "limited": .boolean],
        "LocationGetArgs": ["precision": .oneOf(["approximate", "precise"])],
        "LocationGetResult": ["lat": .number(-90, 90), "lon": .number(-180, 180), "accuracyMeters": .number(0, Double.greatestFiniteMagnitude), "precision": .oneOf(["approximate", "precise"]), "at": .text(1, 64)],
        "AlarmsSetArgs": ["hour": .integer(0, 23), "minute": .integer(0, 59), "label?": .text(0, 100)],
        "AlarmsSetResult": ["outcome": .oneOf(["set", "clock_app_opened"])],
        "AlarmsTimerArgs": ["seconds": .integer(1, 86400), "label?": .text(0, 100)],
        "AlarmsTimerResult": ["outcome": .oneOf(["set", "clock_app_opened"])],
        "MessagesComposeArgs": ["to": .array(.text(1, 40), 1, 10), "body": .text(0, 2000)],
        "MessagesComposeResult": ["outcome": .oneOf(["opened_for_you_to_send"])],
        "CallsDialArgs": ["number": .text(1, 40)],
        "CallsDialResult": ["outcome": .oneOf(["dialer_opened"])],
    ]

    private indirect enum Rule {
        case text(Int, Int), integer(Int, Int), number(Double, Double), oneOf([String])
        case boolean, trueValue, time, object(String), array(Rule, Int, Int), nullable(Rule)

        func accepts(_ value: Any) -> Bool {
            switch self {
            case .text(let min, let max):
                guard let s = value as? String else { return false }
                return (min...max).contains(s.utf16.count)
            case .integer(let min, let max):
                guard let n = numeric(value) else { return false }
                return n.rounded() == n && n >= Double(min) && n <= Double(max)
            case .number(let min, let max):
                guard let n = numeric(value) else { return false }
                return n >= min && n <= max
            case .oneOf(let values): return (value as? String).map(values.contains) ?? false
            case .boolean: return PhoneJobsContract.boolean(value) != nil
            case .trueValue: return PhoneJobsContract.boolean(value) == true
            case .time: return (value as? String).flatMap(instant) != nil
            case .object(let name): return (value as? [String: Any]).map { valid(name, $0) } ?? false
            case .array(let rule, let min, let max):
                guard let a = value as? [Any], (min...max).contains(a.count) else { return false }
                return a.allSatisfy(rule.accepts)
            case .nullable(let rule): return value is NSNull || rule.accepts(value)
            }
        }
    }

    private static func valid(_ name: String, _ o: [String: Any]) -> Bool {
        guard let fields = schemas[name], accepts(fields, o) else { return false }
        switch name {
        case "CalendarReadArgs", "CalendarFreeTimeArgs", "CalendarAddArgs":
            guard let start = (o["start"] as? String).flatMap(instant), let end = (o["end"] as? String).flatMap(instant), end > start else { return false }
            let days = name == "CalendarReadArgs" ? 31 : 14
            return name == "CalendarAddArgs" || end - start <= Int64(days) * 86_400_000
        case "CalendarChangeArgs": return o.count > 1
        default: return true
        }
    }

    private static func accepts(_ fields: [String: Rule], _ o: [String: Any]) -> Bool {
        let allowed = Set(fields.keys.map { $0.hasSuffix("?") ? String($0.dropLast()) : $0 })
        guard Set(o.keys).isSubset(of: allowed) else { return false }
        for (field, rule) in fields {
            let optional = field.hasSuffix("?")
            let key = optional ? String(field.dropLast()) : field
            guard let value = o[key] else { if optional { continue }; return false }
            if !rule.accepts(value) { return false }
        }
        return true
    }

    private static func matches(_ s: String, _ pattern: String) -> Bool {
        guard let range = s.range(of: "\\A(?:" + pattern + ")\\z", options: .regularExpression) else { return false }
        return range == s.startIndex..<s.endIndex
    }

    private static func boolean(_ value: Any?) -> Bool? {
        guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
        return n.boolValue
    }

    private static func numeric(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
        return n.doubleValue
    }

    private static func positiveInteger(_ value: Any?) -> Int64? {
        guard let n = numeric(value), n > 0, n <= 9_007_199_254_740_991, n.rounded() == n else { return nil }
        return Int64(n)
    }

    private static let uuid4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
    private static let leasePattern = "[A-Za-z0-9_-]{43}"

    /// Date.parse's ISO subset: day 1...31 rolls within the month, 24:00 is
    /// midnight on the following day, and fractions are truncated to milliseconds.
    /// Calendar.add/read/free_time compare instants, not the original offset text.
    private static func instant(_ s: String) -> Int64? {
        guard s.utf16.count <= 40,
              matches(s, "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})") else { return nil }
        let b = Array(s.utf8)
        func digits(_ start: Int, _ count: Int) -> Int { b[start..<(start + count)].reduce(0) { $0 * 10 + Int($1 - 48) } }
        let year = digits(0, 4), month = digits(5, 2), day = digits(8, 2)
        let hour = digits(11, 2), minute = digits(14, 2), second = digits(17, 2)
        var i = 19, millis = 0
        if b[i] == 46 {
            i += 1
            let start = i
            while i < b.count && (48...57).contains(b[i]) { i += 1 }
            for j in 0..<3 { millis = millis * 10 + (start + j < i ? Int(b[start + j] - 48) : 0) }
        }
        guard (1...12).contains(month), (1...31).contains(day), hour <= 24, minute < 60, second < 60,
              hour != 24 || (minute == 0 && second == 0 && millis == 0) else { return nil }
        var offset = 0
        if b[i] != 90 {
            let h = digits(i + 1, 2), m = digits(i + 4, 2)
            guard h < 24, m < 60 else { return nil }
            offset = (h * 60 + m) * (b[i] == 43 ? 1 : -1)
        }
        // Proleptic Gregorian days since 1970, including year 0000.
        let y = year - (month <= 2 ? 1 : 0)
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let mp = month + (month > 2 ? -3 : 9)
        let doy = (153 * mp + 2) / 5 + day - 1
        let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468
        return Int64(days) * 86_400_000 + Int64(hour * 3600000 + minute * 60000 + second * 1000 + millis - offset * 60000)
    }

    /// JSON.stringify byte accounting: no slash/Unicode escaping, compact JSON,
    /// and JavaScript's decimal/exponent cutovers for finite IEEE-754 numbers.
    private static func jsonBytes(_ value: Any) -> Int? {
        if value is NSNull { return 4 }
        if let b = boolean(value) { return b ? 4 : 5 }
        if let s = value as? String {
            return s.unicodeScalars.reduce(2) { size, scalar in
                switch scalar.value {
                case 8, 9, 10, 12, 13, 34, 92: return size + 2
                case 0..<32: return size + 6
                default: return size + String(scalar).utf8.count
                }
            }
        }
        if let n = numeric(value) { return numberText(n).utf8.count }
        if let a = value as? [Any] {
            var size = 2 + max(0, a.count - 1)
            for item in a { guard let count = jsonBytes(item) else { return nil }; size += count }
            return size
        }
        if let o = value as? [String: Any] {
            var size = 2 + max(0, o.count - 1)
            for (key, item) in o {
                guard let count = jsonBytes(item), let keyCount = jsonBytes(key) else { return nil }
                size += keyCount + 1 + count
            }
            return size
        }
        return nil
    }

    private static func numberText(_ n: Double) -> String {
        if n == 0 { return "0" }
        let parts = String(abs(n)).lowercased().split(separator: "e")
        let mantissa = String(parts[0])
        let fraction = mantissa.split(separator: ".", omittingEmptySubsequences: false)
        var digits = fraction.joined()
        var decimal = fraction[0].count + (parts.count == 2 ? Int(parts[1])! : 0)
        while digits.first == "0" { digits.removeFirst(); decimal -= 1 }
        while digits.last == "0" { digits.removeLast() }
        let sign = n < 0 ? "-" : ""
        if decimal > 0 && decimal <= 21 {
            if decimal >= digits.count { return sign + digits + String(repeating: "0", count: decimal - digits.count) }
            let index = digits.index(digits.startIndex, offsetBy: decimal)
            return sign + String(digits[..<index]) + "." + String(digits[index...])
        }
        if decimal <= 0 && decimal > -6 { return sign + "0." + String(repeating: "0", count: -decimal) + digits }
        let exponent = decimal - 1
        return sign + String(digits.prefix(1)) + (digits.count > 1 ? "." + String(digits.dropFirst()) : "") + "e" + (exponent >= 0 ? "+" : "") + String(exponent)
    }

    public static func withinResultBound(_ value: Any) -> Bool {
        guard let count = jsonBytes(value) else { return false }
        return count <= resultMaxBytes
    }

    public struct NamedParty {
        public let id: String
        public let name: String
        fileprivate init(_ o: [String: Any]) { id = o["id"] as! String; name = o["name"] as! String }
    }

    public struct Offer {
        public let operationId: String
        public let offerId: String
        public let workspace: String
        public let bot: NamedParty
        public let capability: String
        public let action: String
        public let args: [String: Any]
        public let say: String
        public let provider: NamedParty
        public let expiresAt: Int64
        public let leaseMs: Int
        /// One immutable validated snapshot shared by the card and executor.
        public let decodedArgs: Args?

        private init(_ o: [String: Any]) {
            operationId = o["operationId"] as! String; offerId = o["offerId"] as! String
            workspace = o["workspace"] as! String; bot = NamedParty(o["bot"] as! [String: Any])
            capability = o["capability"] as! String; action = o["action"] as! String
            args = o["args"] as! [String: Any]; say = o["say"] as! String
            decodedArgs = action.split(separator: ".").first.map(String.init) == capability
                ? approvalArgs(action: action, args) : nil
            provider = NamedParty(o["provider"] as! [String: Any])
            expiresAt = positiveInteger(o["expiresAt"])!; leaseMs = (o["leaseMs"] as! NSNumber).intValue
        }

        /// Mirrors offerSchema. Use decodedArgs before executing an action.
        public static func parse(_ any: Any?) -> Offer? {
            guard let o = any as? [String: Any], Set(o.keys) == ["operationId", "offerId", "workspace", "bot", "capability", "action", "args", "say", "provider", "expiresAt", "leaseMs"],
                  let operation = o["operationId"] as? String, matches(operation, uuid4),
                  let offer = o["offerId"] as? String, matches(offer, uuid4),
                  Rule.text(1, 120).accepts(o["workspace"]!),
                  let bot = o["bot"] as? [String: Any], accepts(["id": .text(1, 128), "name": .text(1, 120)], bot),
                  Rule.oneOf(capabilities).accepts(o["capability"]!),
                  let action = o["action"] as? String, action.utf16.count <= 48, matches(action, "[a-z]+\\.[a-z_]+"),
                  o["args"] is [String: Any], Rule.text(1, 240).accepts(o["say"]!),
                  let provider = o["provider"] as? [String: Any], accepts(["id": .text(1, 64), "name": .text(1, 120)], provider),
                  positiveInteger(o["expiresAt"]) != nil, let lease = numeric(o["leaseMs"]), [45_000, 180_000].contains(lease) else { return nil }
            // Freeze Foundation containers, including nested args, at the boundary.
            guard let data = try? JSONSerialization.data(withJSONObject: o),
                  let copy = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            return Offer(copy)
        }
    }

    public struct PollAnswer {
        public let jobs: [Offer]
        private init(jobs: [Offer]) { self.jobs = jobs }
        public static func parse(_ any: Any?) -> PollAnswer? {
            guard let o = any as? [String: Any], Set(o.keys) == ["jobs"], let jobs = o["jobs"] as? [Any], jobs.count <= 1 else { return nil }
            let parsed = jobs.compactMap(Offer.parse)
            return parsed.count == jobs.count ? PollAnswer(jobs: parsed) : nil
        }
    }

    public enum TargetedAnswer {
        case jobs(Offer)
        case leased(expiresAt: Int64)
        case handled(reason: String)

        public static func parse(_ any: Any?) -> TargetedAnswer? {
            guard let o = any as? [String: Any] else { return nil }
            if let poll = PollAnswer.parse(o), poll.jobs.count == 1 { return .jobs(poll.jobs[0]) }
            if Set(o.keys) == ["leased", "expiresAt"], boolean(o["leased"]) == true, let expires = positiveInteger(o["expiresAt"]) { return .leased(expiresAt: expires) }
            if Set(o.keys) == ["handled", "reason"], boolean(o["handled"]) == true,
               let reason = o["reason"] as? String, ["done", "revoked", "ended", "unknown"].contains(reason) { return .handled(reason: reason) }
            return nil
        }
    }

    public struct LeaseRequest {
        public let offerId: String
        private init(offerId: String) { self.offerId = offerId }
        public static func parse(_ any: Any?) -> LeaseRequest? {
            guard let o = any as? [String: Any], Set(o.keys) == ["offerId"], let id = o["offerId"] as? String, matches(id, uuid4) else { return nil }
            return LeaseRequest(offerId: id)
        }
    }

    public enum LeaseAnswer {
        case active(leaseToken: String)
        case inactive
        public static func parse(_ any: Any?) -> LeaseAnswer? {
            guard let o = any as? [String: Any], let active = boolean(o["active"]) else { return nil }
            if !active && Set(o.keys) == ["active"] { return .inactive }
            if active && Set(o.keys) == ["active", "leaseToken"], let token = o["leaseToken"] as? String, matches(token, leasePattern) { return .active(leaseToken: token) }
            return nil
        }
    }

    public struct ResultBody {
        public let leaseToken: String
        public let ok: Bool
        /// nil means absent; NSNull means an explicit JSON null.
        public let result: Any?
        public let error: String?
        public let code: String?
        private init(_ o: [String: Any]) {
            leaseToken = o["leaseToken"] as! String; ok = boolean(o["ok"])!
            result = o["result"]; error = o["error"] as? String; code = o["code"] as? String
        }
        public static func parse(_ any: Any?) -> ResultBody? {
            guard let o = any as? [String: Any], Set(o.keys).isSubset(of: ["leaseToken", "ok", "result", "error", "code"]),
                  let token = o["leaseToken"] as? String, matches(token, leasePattern), let ok = boolean(o["ok"]) else { return nil }
            if let error = o["error"], !Rule.text(1, 500).accepts(error) { return nil }
            if let code = o["code"], !Rule.oneOf(resultCodes).accepts(code) { return nil }
            if ok ? (o["error"] != nil || o["code"] != nil) : (o["code"] == nil || o["result"] != nil) { return nil }
            if let result = o["result"], !withinResultBound(result) { return nil }
            guard let data = try? JSONSerialization.data(withJSONObject: o),
                  let copy = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            return ResultBody(copy)
        }
    }

    public static func registrationValid(_ any: Any?) -> Bool {
        guard let o = any as? [String: Any], Set(o.keys) == ["name", "platform", "osVersion", "appVersion", "timeZone", "protocol", "capabilities"],
              Rule.text(1, 80).accepts(o["name"]!), Rule.oneOf(["ios", "android"]).accepts(o["platform"]!),
              Rule.text(1, 40).accepts(o["osVersion"]!), Rule.text(1, 40).accepts(o["appVersion"]!),
              Rule.text(1, 64).accepts(o["timeZone"]!), numeric(o["protocol"]) == 1,
              let report = o["capabilities"] as? [String: Any] else { return false }
        return accepts(["calendar?": .oneOf(["full", "write-only"]), "reminders?": .boolean, "contacts?": .oneOf(["full", "limited"]),
                        "location?": .oneOf(["approximate", "precise"]), "alarms?": .boolean, "messages?": .boolean, "calls?": .boolean], report)
    }
}
