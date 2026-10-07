import Foundation

/// Spec §3.1: `{origin, name, bindingId?, lastConnected}`. `bindingId`
/// arrives with push in Plan 3.
public struct SavedWorkspace: Codable, Equatable, Sendable {
    public var origin: String
    public var name: String
    public var lastConnected: Int64
}

/// The saved computers, kept in the Keychain (P14). Twin of
/// WorkspaceBook.java. Each entry is a bare origin, a display name and a
/// time: never a credential or cookie, and decoding drops any other field.
/// Encodable only: the one way in is `decode(_:)`, which cleans.
public struct WorkspaceBook: Encodable, Equatable, Sendable {
    public static let limit = 20
    static let maxName = 200
    public private(set) var workspaces: [SavedWorkspace] = []
    public private(set) var active: String?

    public init() {}

    /// Forgiving: a damaged entry (no origin, or one that does not parse) is
    /// dropped alone; a bad name becomes the machine name, a time that is not
    /// an integer becomes 0, and a duplicate origin keeps the first.
    public static func decode(_ data: Data?) -> WorkspaceBook {
        var book = WorkspaceBook()
        guard let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return book }
        for item in json["workspaces"] as? [Any] ?? [] {
            guard let item = item as? [String: Any], let raw = item["origin"] as? String,
                  let origin = WorkspaceOrigin(string: raw), book.entry(for: origin) == nil else { continue }
            let name = (item["name"] as? String).flatMap(cleanName) ?? defaultName(origin)
            book.workspaces.append(SavedWorkspace(origin: origin.serialized, name: name, lastConnected: JSONInteger.value(item["lastConnected"]) ?? 0))
        }
        // A file that somehow holds more than the limit keeps the newest; a tie drops the one listed first.
        while book.workspaces.count > limit, let index = book.oldest(keeping: nil) { book.workspaces.remove(at: index) }
        // "active" must be exactly a saved origin, after the cap.
        if let active = json["active"] as? String, book.workspaces.contains(where: { $0.origin == active }) { book.active = active }
        return book
    }

    public func encoded() -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return (try? encoder.encode(self)) ?? Data("{}".utf8)
    }

    /// Newest first; equal times keep their listed order, as Java's stable sort does.
    public var sorted: [SavedWorkspace] {
        workspaces.enumerated()
            .sorted { $0.element.lastConnected != $1.element.lastConnected ? $0.element.lastConnected > $1.element.lastConnected : $0.offset < $1.offset }
            .map(\.element)
    }

    public func entry(for origin: WorkspaceOrigin) -> SavedWorkspace? {
        workspaces.first { $0.origin == origin.serialized }
    }

    public mutating func signedIn(_ origin: WorkspaceOrigin, name: String?, at millis: Int64) {
        let key = origin.serialized
        let clean = name.flatMap(Self.cleanName)
        if let index = workspaces.firstIndex(where: { $0.origin == key }) {
            workspaces[index].lastConnected = millis
            if let clean { workspaces[index].name = clean }
        } else {
            workspaces.append(SavedWorkspace(origin: key, name: clean ?? Self.defaultName(origin), lastConnected: millis))
            // Never the one just signed in to, even when its clock is behind every other.
            if workspaces.count > Self.limit, let index = oldest(keeping: key) { workspaces.remove(at: index) }
        }
        active = key
    }

    /// "Last connected" shows minutes, so a touch within one of the saved time changes nothing.
    public static let touchInterval: Int64 = 60_000

    /// The computer was in use at `millis` (a later load, going to the
    /// background): its time only. Never adds one (a removed computer stays
    /// removed), never changes the active one, so never evicts. False when
    /// nothing changed (not saved, or within `touchInterval`): no save needed.
    @discardableResult
    public mutating func touched(_ origin: WorkspaceOrigin, at millis: Int64) -> Bool {
        guard let index = workspaces.firstIndex(where: { $0.origin == origin.serialized }) else { return false }
        let since = millis - workspaces[index].lastConnected
        if since >= 0, since < Self.touchInterval { return false }
        workspaces[index].lastConnected = millis
        return true
    }

    public mutating func remove(_ origin: WorkspaceOrigin) {
        workspaces.removeAll { $0.origin == origin.serialized }
        if active == origin.serialized { active = nil }
    }

    /// The MagicDNS machine name: `example-mac` from `example-mac.tail….ts.net`.
    public static func defaultName(_ origin: WorkspaceOrigin) -> String {
        origin.host.split(separator: ".").first.map(String.init) ?? origin.host
    }

    /// A computer's name as shown: nil when empty, else its first 200 code
    /// points (Unicode scalars), exactly where Java cuts it.
    static func cleanName(_ name: String) -> String? {
        guard !name.isEmpty else { return nil }
        guard name.unicodeScalars.count > maxName else { return name }
        var cut = String.UnicodeScalarView()
        cut.append(contentsOf: name.unicodeScalars.prefix(maxName))
        return String(cut)
    }

    /// The index of the first-listed entry with the smallest time, other than `keep`.
    private func oldest(keeping keep: String?) -> Int? {
        var oldest: Int?
        for (index, entry) in workspaces.enumerated() where entry.origin != keep {
            if oldest == nil || entry.lastConnected < workspaces[oldest!].lastConnected { oldest = index }
        }
        return oldest
    }
}
