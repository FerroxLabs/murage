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
