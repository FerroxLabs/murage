import Foundation

/// The splash overlay's visibility ordering, without UIKit. Every show bumps a
/// generation, so a fade started earlier can no longer hide what was shown
/// later; and once the overlay shows the closing screen no reveal hides it
/// (its "Your computers" button is the way out until the screen has gone).
public struct OverlayFade {
    public enum Mode: Equatable { case splash, slow, closing, hidden }

    public private(set) var generation = 0
    public private(set) var mode: Mode = .splash

    public init() {}

    public mutating func showSplash() { generation += 1; mode = .splash }
    public mutating func showSlow() { generation += 1; mode = .slow }
    public mutating func showClosing() { generation += 1; mode = .closing }

    /// A reveal asks to hide. Returns the token to finish it with, or nil
    /// when there is nothing to hide (already hidden, or closing).
    public mutating func beginHide() -> Int? {
        guard mode != .hidden, mode != .closing else { return nil }
        generation += 1
        return generation
    }

    /// The fade ended. True only when nothing was shown since it began.
    public mutating func finishHide(token: Int, finished: Bool) -> Bool {
        guard finished, token == generation, mode != .closing else { return false }
        mode = .hidden
        return true
    }
}
