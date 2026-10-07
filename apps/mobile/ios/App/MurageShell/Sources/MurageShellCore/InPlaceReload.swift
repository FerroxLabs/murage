import Foundation

/// Twin of InPlaceReload.java. Which answer to a same-document reload
/// (SameDocument.reloadScript) may still fall back to a plain load: only the
/// first one, the page's or the timeout's, and only for the newest load(), so
/// a hung web content process cannot swallow Retry and an older load's late
/// answer never navigates over a newer one (open-reload review, Important 1 and 2).
public struct InPlaceReload: Sendable {
    /// A healthy page answers the one-line script in milliseconds.
    public static let timeout: TimeInterval = 1

    private var current = 0
    private var settled = true

    public init() {}

    /// Every load() takes a ticket, which voids the tickets before it.
    public mutating func begin() -> Int {
        settled = false
        current += 1
        return current
    }

    /// True when the caller should load the target itself: this is the first
    /// answer for the newest load and the page did not reload.
    public mutating func fallBack(ticket: Int, reloaded: Bool) -> Bool {
        guard ticket == current, !settled else { return false }
        settled = true
        return !reloaded
    }
}
