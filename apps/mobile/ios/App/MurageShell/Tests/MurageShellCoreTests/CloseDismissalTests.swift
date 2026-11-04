import XCTest
@testable import MurageShellCore

/// A fake screen, clock and transition: the test decides when each callback runs.
private final class Harness {
    var presented: String? = "A"           // what the presenter presents now
    let mine = "A"
    var dismissCalls = 0
    var delivered = 0
    var completions: [() -> Void] = []     // UIKit dismiss completions, run by the test
    var transitionEnd: (() -> Void)?       // the transition coordinator's callback
    var timers: [(id: Int, delay: TimeInterval, run: () -> Void)] = []
    var cancelled: Set<Int> = []
    var nextId = 0
    var hasTransition = true

    lazy var close = CloseDismissal(
        isPresenting: { [unowned self] in self.presented == self.mine },
        dismiss: { [unowned self] completion in
            self.dismissCalls += 1
            self.presented = nil
            if let completion { self.completions.append(completion) }
        },
        afterTransition: { [unowned self] run in
            if self.hasTransition { self.transitionEnd = run } else { run() }
        },
        schedule: { [unowned self] delay, run in
            self.nextId += 1
            let id = self.nextId
            self.timers.append((id, delay, run))
            return { self.cancelled.insert(id) }
        },
        deliver: { [unowned self] in self.delivered += 1 }
    )

    func fireTimer() { for t in timers where !cancelled.contains(t.id) { t.run() } }
}

final class CloseDismissalTests: XCTestCase {
    func testCompletionFirstDeliversOnceAndTheTimerIsCancelled() {
        let h = Harness(); h.hasTransition = false
        h.close.start()
        XCTAssertEqual(h.dismissCalls, 1)
        XCTAssertEqual(h.delivered, 0, "not before UIKit finishes the dismissal")
        h.completions.forEach { $0() }
        XCTAssertEqual(h.delivered, 1)
        h.fireTimer()
        XCTAssertEqual(h.delivered, 1)
        XCTAssertEqual(h.dismissCalls, 1)
        XCTAssertEqual(h.timers.first?.delay, CloseDismissal.fallbackDelay)
    }

    func testTheFallbackDeliversWhenTheCompletionIsDropped() {
        let h = Harness(); h.hasTransition = false
        h.close.start()
        h.presented = "A"                 // the dismissal did not take
        h.fireTimer()
        XCTAssertEqual(h.delivered, 1)
        XCTAssertEqual(h.dismissCalls, 2, "the fallback dismisses its own workspace again")
    }

    func testBothCompletionAndFallbackDeliverOnce() {
        let h = Harness(); h.hasTransition = false
        h.close.start()
        h.fireTimer()
        h.completions.forEach { $0() }
        h.fireTimer()
        XCTAssertEqual(h.delivered, 1)
    }

    func testAnOpenBetweenTheCallbackAndTheFallbackIsNeverDismissedAndTheStaleCloseIsNotDelivered() {
        let h = Harness(); h.hasTransition = false
        h.close.start()                    // A dismissal asked; completion dropped
        h.close.supersede()                // B opens
        h.presented = "B"
        h.fireTimer()                      // the old fallback, if it had survived
        h.completions.forEach { $0() }     // a late completion
        XCTAssertEqual(h.presented, "B", "B stays on screen")
        XCTAssertEqual(h.dismissCalls, 1)
        XCTAssertEqual(h.delivered, 0)
        XCTAssertTrue(h.cancelled.contains(1), "the timer itself is cancelled")
    }

    func testAFallbackThatFindsAnotherWorkspaceDoesNotDismissIt() {
        // Even without supersede(): the presenter now presents B, so the fallback only delivers.
        let h = Harness(); h.hasTransition = false
        h.close.start()
        h.presented = "B"
        h.fireTimer()
        XCTAssertEqual(h.presented, "B")
        XCTAssertEqual(h.dismissCalls, 1)
        XCTAssertEqual(h.delivered, 1)
    }

    func testTheDeferredTransitionCallbackAfterDeliveryDoesNothing() {
        let h = Harness()                  // transition in flight
        h.close.start()
        h.fireTimer()                      // fallback first: dismisses and delivers
        XCTAssertEqual(h.delivered, 1)
        XCTAssertEqual(h.dismissCalls, 1)
        h.presented = "B"                  // the delivery opened a pending workspace
        h.transitionEnd?()                 // the late deferred callback
        XCTAssertEqual(h.presented, "B")
        XCTAssertEqual(h.dismissCalls, 1)
        XCTAssertEqual(h.delivered, 1)
    }

    func testTheDeferredTransitionCallbackAfterAnOpenDoesNothing() {
        let h = Harness()
        h.close.start()
        h.close.supersede()
        h.presented = "B"
        h.transitionEnd?()
        XCTAssertEqual(h.presented, "B")
        XCTAssertEqual(h.dismissCalls, 0)
        XCTAssertEqual(h.delivered, 0)
    }

    func testTheTransitionEndingNormallyDismissesThenDelivers() {
        let h = Harness()
        h.close.start()
        XCTAssertEqual(h.dismissCalls, 0, "waits for the transition")
        h.transitionEnd?()
        XCTAssertEqual(h.dismissCalls, 1)
        h.completions.forEach { $0() }
        XCTAssertEqual(h.delivered, 1)
    }

    func testAScreenAlreadyGoneIsNotDismissedAgain() {
        let h = Harness(); h.hasTransition = false
        h.presented = nil
        h.close.start()
        XCTAssertEqual(h.dismissCalls, 0)
        XCTAssertEqual(h.delivered, 1)
    }

    func testForceLeaveTakesOnlyItsOwnScreenOffAndLeavesDeliveryToTheCallbacks() {
        let h = Harness(); h.hasTransition = false
        h.close.start()
        h.presented = "A"
        h.close.forceLeave()
        XCTAssertEqual(h.dismissCalls, 2)
        XCTAssertEqual(h.presented, nil)
        h.fireTimer()
        XCTAssertEqual(h.delivered, 1)
        XCTAssertEqual(h.dismissCalls, 2, "nothing left to dismiss")

        let g = Harness(); g.hasTransition = false
        g.close.start()
        g.presented = "B"
        g.close.forceLeave()
        XCTAssertEqual(g.presented, "B")
        g.close.supersede()
        g.presented = "A"
        g.close.forceLeave()
        XCTAssertEqual(g.dismissCalls, 1, "a superseded close never acts")
    }

    func testTheRecoveryButtonStaysForEveryCloseExceptTheDeliberateTripToTheLauncher() {
        for reason in CloseReason.allCases {
            XCTAssertEqual(CloseDismissal.showsRecovery(whileClosing: reason), reason != .launcher, "\(reason)")
        }
        XCTAssertTrue(CloseDismissal.showsRecovery(whileClosing: .signedOut))
    }
}

/// Delivery releases the workspace: a dismissed workspace (and its WebView and
/// bridge) must not stay in memory while the person is in the launcher.
final class CloseDismissalReleaseTests: XCTestCase {
    private final class Workspace {}

    private func makeClose(holding workspace: Workspace?, presented: @escaping () -> Bool = { false },
                           deliver: @escaping () -> Void = {}) -> (CloseDismissal, () -> Void) {
        var fire: () -> Void = {}
        let close = CloseDismissal(
            isPresenting: presented,
            dismiss: { $0?() },
            afterTransition: { $0() },
            schedule: { _, run in fire = run; return {} },
            deliver: deliver,
            retaining: workspace)
        return (close, { fire() })
    }

    func testDeliveryReleasesTheWorkspace() {
        weak var weakWorkspace: Workspace?
        var close: CloseDismissal?
        autoreleasepool {
            let workspace = Workspace()
            weakWorkspace = workspace
            close = makeClose(holding: workspace).0
        }
        XCTAssertNotNil(weakWorkspace, "held while the close is pending, so it can be dismissed")
        close?.start() // not presented: delivered at once
        XCTAssertTrue(close?.isDelivered == true)
        XCTAssertNil(weakWorkspace, "released once the close is delivered")
    }

    func testTheFallbackTimerDeliveryReleasesIt() {
        weak var weakWorkspace: Workspace?
        var close: CloseDismissal?
        var fire: () -> Void = {}
        autoreleasepool {
            let workspace = Workspace()
            weakWorkspace = workspace
            // Never presented-and-dismissed in time: UIKit drops the completion.
            close = CloseDismissal(isPresenting: { true }, dismiss: { _ in }, afterTransition: { _ in },
                                   schedule: { _, run in fire = run; return {} }, deliver: {}, retaining: workspace)
        }
        close?.start()
        XCTAssertNotNil(weakWorkspace, "still pending")
        fire()
        XCTAssertTrue(close?.isDelivered == true)
        XCTAssertNil(weakWorkspace)
    }

    func testSupersedingReleasesIt() {
        weak var weakWorkspace: Workspace?
        var close: CloseDismissal?
        autoreleasepool {
            let workspace = Workspace()
            weakWorkspace = workspace
            close = makeClose(holding: workspace).0
        }
        close?.supersede()
        XCTAssertNil(weakWorkspace)
    }

    func testRecoveryStillWorksWhilePending() {
        // forceLeave (the "Your computers" button) needs only the callbacks, not the workspace.
        var dismissed = 0
        let close = CloseDismissal(isPresenting: { true }, dismiss: { _ in dismissed += 1 }, afterTransition: { _ in },
                                   schedule: { _, _ in {} }, deliver: {}, retaining: Workspace())
        close.start()
        close.forceLeave()
        XCTAssertEqual(dismissed, 1)
    }
}

/// A held open may present only once the dismissal is over.
final class CloseDismissalHeldOpenTests: XCTestCase {
    func testFallbackDoesNotLetAHeldOpenPresentInTheSameTurnAsTheDismiss() {
        var presented = true
        var delivered = 0, held = 0
        var completions: [() -> Void] = []
        var timers: [() -> Void] = []
        let close = CloseDismissal(
            isPresenting: { presented },
            dismiss: { c in if let c { completions.append(c) } },
            afterTransition: { _ in },                       // UIKit never ends the transition
            schedule: { _, run in timers.append(run); return {} },
            deliver: { delivered += 1 },
            afterGone: { held += 1 })
        close.start()
        timers.removeFirst()()                                // the one-second fallback
        XCTAssertEqual(delivered, 1, "the close is still delivered once")
        XCTAssertEqual(held, 0, "a held open must not present while the dismiss is in flight")
        presented = false
        completions.forEach { $0() }                          // UIKit finishes the dismissal
        XCTAssertEqual(held, 1)
        completions.forEach { $0() }
        XCTAssertEqual(held, 1, "once")
    }

    func testCompletionPathPresentsTheHeldOpenOnlyAfterDismissal() {
        var held = 0
        var completions: [() -> Void] = []
        let close = CloseDismissal(isPresenting: { true }, dismiss: { c in if let c { completions.append(c) } },
                                   afterTransition: { $0() }, schedule: { _, _ in {} }, deliver: {}, afterGone: { held += 1 })
        close.start()
        XCTAssertEqual(held, 0)
        completions.forEach { $0() }
        XCTAssertEqual(held, 1)
    }

    func testNothingToDismissPresentsTheHeldOpenAtOnce() {
        var held = 0
        let close = CloseDismissal(isPresenting: { false }, dismiss: { _ in }, afterTransition: { $0() },
                                   schedule: { _, _ in {} }, deliver: {}, afterGone: { held += 1 })
        close.start()
        XCTAssertEqual(held, 1)
    }

    func testSupersededCloseNeverPresentsTheHeldOpen() {
        var held = 0
        var completions: [() -> Void] = []
        let close = CloseDismissal(isPresenting: { true }, dismiss: { c in if let c { completions.append(c) } },
                                   afterTransition: { $0() }, schedule: { _, _ in {} }, deliver: {}, afterGone: { held += 1 })
        close.start()
        close.supersede()
        completions.forEach { $0() }
        XCTAssertEqual(held, 0)
    }
}

/// R3-02 / R3-03: the dismissal barrier is the one gate for held opens.
final class CloseDismissalBarrierTests: XCTestCase {
    private func make(presented: @escaping () -> Bool, completions: @escaping (@escaping () -> Void) -> Void, timers: @escaping (@escaping () -> Void) -> Void,
                      delivered: @escaping () -> Void = {}, held: @escaping () -> Void) -> CloseDismissal {
        CloseDismissal(isPresenting: presented, dismiss: { c in if let c { completions(c) } },
                       afterTransition: { _ in }, schedule: { _, run in timers(run); return {} },
                       deliver: delivered, afterGone: held)
    }

    func testTheBarrierStaysUpDuringAFallbackDismissalSoALateCallEndedCallbackHasNothingToRelease() {
        var timers: [() -> Void] = []
        let close = make(presented: { true }, completions: { _ in }, timers: { timers.append($0) }, held: {})
        close.start()
        XCTAssertFalse(close.isGone)
        timers.removeFirst()()                       // fallback: close delivered, dismissal still in flight
        XCTAssertTrue(close.isDelivered)
        XCTAssertFalse(close.isGone, "a call-ended callback now must wait: the coordinator checks isGone")
    }

    func testTheBarrierIsDownOnceSupersededOrGone() {
        let a = make(presented: { true }, completions: { _ in }, timers: { _ in }, held: {})
        a.start(); a.supersede()
        XCTAssertTrue(a.isGone)
        var presented = true
        var completions: [() -> Void] = []
        let b = make(presented: { presented }, completions: { completions.append($0) }, timers: { _ in }, held: {})
        b.start()
        b.forceLeave(); presented = false
        XCTAssertFalse(b.isGone)
    }

    func testRecoveryAfterBothTimersAndAllEarlierCompletionsAreDroppedDeliversTheHeldOpenOnce() {
        var presented = true
        var held = 0, delivered = 0
        var completions: [() -> Void] = []
        var timers: [() -> Void] = []
        let close = make(presented: { presented }, completions: { completions.append($0) }, timers: { timers.append($0) },
                         delivered: { delivered += 1 }, held: { held += 1 })
        close.start()
        timers.removeFirst()()                        // fallback: delivers the close
        timers.removeFirst()()                        // second check: still presented
        completions.removeAll()                       // UIKit dropped every completion
        XCTAssertEqual(delivered, 1)
        XCTAssertEqual(held, 0)
        close.forceLeave()                            // "Your computers"
        presented = false
        completions.forEach { $0() }                  // recovery's dismiss completes
        timers.forEach { $0() }                       // and its re-check
        close.disappeared()
        XCTAssertEqual(held, 1, "exactly once")
        XCTAssertEqual(delivered, 1)
    }

    func testRecoveryWhoseCompletionIsDroppedIsCaughtByTheRecheckOrTheDisappearance() {
        var presented = true
        var held = 0
        var timers: [() -> Void] = []
        let close = make(presented: { presented }, completions: { _ in }, timers: { timers.append($0) }, held: { held += 1 })
        close.start()
        timers.removeFirst()(); timers.removeFirst()()
        close.forceLeave()
        presented = false
        XCTAssertEqual(held, 0)
        timers.removeLast()()                         // the recovery's re-check
        XCTAssertEqual(held, 1)
        close.disappeared()
        XCTAssertEqual(held, 1)
    }

    func testDisappearingBeforeTheCloseIsDeliveredReleasesNothing() {
        var held = 0
        let close = make(presented: { true }, completions: { _ in }, timers: { _ in }, held: { held += 1 })
        close.start()
        close.disappeared()
        XCTAssertEqual(held, 0, "the close's own callbacks deliver it first, then release")
    }
}
