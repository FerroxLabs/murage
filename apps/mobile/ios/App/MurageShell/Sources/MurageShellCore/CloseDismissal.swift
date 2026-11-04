import Foundation

/// The ordering of one workspace close: take the screen off, then tell the
/// launcher, once, even when UIKit drops a completion. Pure, with every side
/// effect injected, so the orderings are unit tested.
///
/// A close only ever acts on the workspace it belongs to. Before any dismissal
/// it asks `isPresenting` (does the presenter still present THAT workspace?),
/// and a new open calls `supersede()`, which voids the fallback timer and every
/// callback still pending, so a late callback can neither dismiss the newer
/// workspace nor deliver this one's close.
public final class CloseDismissal {
    /// How long UIKit has to run the dismiss completion before the close is delivered anyway.
    public static let fallbackDelay: TimeInterval = 1

    /// The "Your computers" button on a closing splash stays available for
    /// every close that was not the person's own trip to the launcher.
    public static func showsRecovery(whileClosing reason: CloseReason) -> Bool {
        reason != .launcher
    }

    private let isPresenting: () -> Bool
    private let dismiss: (_ completion: (() -> Void)?) -> Void
    private let afterTransition: (_ run: @escaping () -> Void) -> Void
    private let schedule: (_ delay: TimeInterval, _ run: @escaping () -> Void) -> () -> Void
    private let deliver: () -> Void
    private var cancelFallback: (() -> Void)?

    public private(set) var isDelivered = false
    public private(set) var isSuperseded = false

    /// - isPresenting: the presenter still presents this close's workspace.
    /// - dismiss: takes the presented screen off; the completion may never run.
    /// - afterTransition: runs the block once any transition in flight is over (at once when none is).
    /// - schedule: runs the block after the delay; returns its cancel.
    /// - deliver: tells the launcher the workspace closed.
    public init(isPresenting: @escaping () -> Bool,
                dismiss: @escaping (_ completion: (() -> Void)?) -> Void,
                afterTransition: @escaping (_ run: @escaping () -> Void) -> Void,
                schedule: @escaping (_ delay: TimeInterval, _ run: @escaping () -> Void) -> () -> Void,
                deliver: @escaping () -> Void) {
        self.isPresenting = isPresenting
        self.dismiss = dismiss
        self.afterTransition = afterTransition
        self.schedule = schedule
        self.deliver = deliver
    }

    private var isLive: Bool { !isSuperseded && !isDelivered }

    public func start() {
        afterTransition { [weak self] in self?.transitionEnded() }
        guard isLive else { return }
        cancelFallback = schedule(Self.fallbackDelay) { [weak self] in self?.fallbackFired() }
    }

    /// Another workspace is opening: nothing this close has pending may act any more.
    public func supersede() {
        isSuperseded = true
        cancelFallback?()
        cancelFallback = nil
    }

    /// "Your computers" on the closing splash: the screen is taken off now, but
    /// only if it is still this workspace on screen. The close is still delivered
    /// by the callbacks already pending.
    public func forceLeave() {
        guard !isSuperseded, isPresenting() else { return }
        dismiss(nil)
    }

    private func transitionEnded() {
        guard isLive else { return }
        if isPresenting() {
            dismiss { [weak self] in self?.completed() }
        } else {
            finish()
        }
    }

    private func completed() {
        guard !isSuperseded else { return }
        finish()
    }

    private func fallbackFired() {
        guard isLive else { return }
        if isPresenting() { dismiss(nil) }
        finish()
    }

    private func finish() {
        guard isLive else { return }
        isDelivered = true
        cancelFallback?()
        cancelFallback = nil
        deliver()
    }
}
