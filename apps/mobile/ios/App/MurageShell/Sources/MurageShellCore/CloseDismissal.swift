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

    static let goneRetries = 10
    static let goneRetryDelay: TimeInterval = 0.1

    private let isPresenting: () -> Bool
    private let dismiss: (_ completion: (() -> Void)?) -> Void
    private let afterTransition: (_ run: @escaping () -> Void) -> Void
    private let schedule: (_ delay: TimeInterval, _ run: @escaping () -> Void) -> () -> Void
    private let deliver: () -> Void
    private let afterGone: () -> Void
    private var goneRan = false
    private var cancelFallback: (() -> Void)?
    /// The workspace this close belongs to, held only until the close is
    /// delivered (or superseded): the callbacks need it alive to dismiss it,
    /// and afterwards nothing here may keep it, or its WebView, in memory.
    private var retained: AnyObject?

    public private(set) var isDelivered = false
    public private(set) var isSuperseded = false
    /// The held-open barrier has been released (or can never be): nothing is still dismissing.
    public var isGone: Bool { goneRan || isSuperseded }

    /// - isPresenting: the presenter still presents this close's workspace.
    /// - dismiss: takes the presented screen off; the completion may never run.
    /// - afterTransition: runs the block once any transition in flight is over (at once when none is).
    /// - schedule: runs the block after the delay; returns its cancel.
    /// - deliver: tells the launcher the workspace closed.
    /// - afterGone: runs once, only when the workspace is no longer presented (a held open may present now, never while a dismiss is still in flight).
    /// - retaining: kept alive until the close is delivered or superseded, then released.
    public init(isPresenting: @escaping () -> Bool,
                dismiss: @escaping (_ completion: (() -> Void)?) -> Void,
                afterTransition: @escaping (_ run: @escaping () -> Void) -> Void,
                schedule: @escaping (_ delay: TimeInterval, _ run: @escaping () -> Void) -> () -> Void,
                deliver: @escaping () -> Void,
                afterGone: @escaping () -> Void = {},
                retaining workspace: AnyObject? = nil) {
        self.afterGone = afterGone
        self.retained = workspace
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
        retained = nil
    }

    /// "Your computers" on the closing splash: the screen is taken off now, but
    /// only if it is still this workspace on screen. The close is still delivered
    /// by the callbacks already pending.
    public func forceLeave() {
        guard !isSuperseded, isPresenting() else { return }
        // Recovery feeds the same once-only gone() path as the close itself: its
        // completion, a re-check timer, and the workspace's disappearance.
        dismiss { [weak self] in self?.recoveryEnded() }
        _ = schedule(Self.fallbackDelay) { [weak self] in self?.recoveryEnded(onlyIfOff: true) }
    }

    /// The workspace's screen is off (viewDidDisappear). Third signal into gone().
    public func disappeared() {
        recoveryEnded()
    }

    /// Only a close whose delivery already happened may release the barrier here;
    /// an earlier one is still released by its own pending callbacks.
    private func recoveryEnded(onlyIfOff: Bool = false) {
        guard isDelivered, !onlyIfOff || !isPresenting() else { return }
        gone()
    }

    private func transitionEnded() {
        guard isLive else { return }
        if isPresenting() {
            dismiss { [weak self] in self?.completed() }
        } else {
            finish()
            gone()
        }
    }

    private func completed() {
        guard !isSuperseded else { return }
        finish()
        gone()
    }

    private func fallbackFired() {
        guard isLive else { return }
        if isPresenting() {
            // UIKit's dismiss is asynchronous: the close is delivered now, but
            // anything that would present waits for the dismissal to be over.
            dismiss { [weak self] in self?.gone() }
            finish()
            _ = schedule(Self.fallbackDelay) { [weak self] in self?.goneIfOff() }
        } else {
            finish()
            gone()
        }
    }

    private func goneIfOff() {
        if !isPresenting() { gone() }
    }

    /// The only place the barrier is released. It releases only when the
    /// presenter no longer presents this workspace (viewDidDisappear and the
    /// dismiss completion can both run while the dismissal is still reported as
    /// in flight, and a held open presented then would issue a nested dismiss).
    /// While it is still presented it re-checks on the next turns, a bounded
    /// number of times; the once-only flag is set only when the release happens.
    private func gone(retries: Int = CloseDismissal.goneRetries) {
        guard !isSuperseded, !goneRan else { return }
        if isPresenting() {
            guard retries > 0 else { return }
            _ = schedule(Self.goneRetryDelay) { [weak self] in self?.gone(retries: retries - 1) }
            return
        }
        goneRan = true
        afterGone()
    }

    private func finish() {
        guard isLive else { return }
        isDelivered = true
        cancelFallback?()
        cancelFallback = nil
        retained = nil
        deliver()
    }
}
