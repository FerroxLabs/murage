import Foundation
import XCTest
@testable import MurageCallAudioCore

/// Spec §4.1 (open, hold, resume, lost), §4.2.2 step 8 (the configuration
/// change after every start), §4.2.5 (category reasserts), §4.2.6 (the
/// reducer), §4.2.7 (close paths, the watchdog), §4.2.8, §4.2.9, §4.2.10.
final class CallAudioStateTests: XCTestCase {
    private let t0: TimeInterval = 1000
    private let fullOpen = StartPlan(applyCategory: true, rebuild: .engine)
    private let settleRestart = StartPlan(applyCategory: false, rebuild: .nodesAndTap)
    private let close: [CallAudioAction] = [.log(.close), .closeClips, .teardownEngine, .restoreSession, .deactivateSession]

    // MARK: open

    func testOpenRepliesOnlyAfterTheStartSettles() {
        var s = CallAudioState()
        XCTAssertEqual(s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .active), now: t0),
                       [.log(.open), .recordSession, .start(fullOpen)])
        XCTAssertFalse(s.micLive)
        XCTAssertEqual(s.reduce(.started, now: t0 + 0.2), [.schedule(timer(.settle, 1), after: 0.5)])
        XCTAssertFalse(s.micLive)
        XCTAssertNil(s.sessions.open)
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 1)), now: t0 + 0.7), [.replyOpen(request: 1, .opened(session: "s1"))])
        XCTAssertEqual(s.sessions.open, "s1")
        XCTAssertTrue(s.micLive)
    }

    /// Step 8: the change ~0.1 s after start is a restart and a rebuild with
    /// fresh nodes, not debounced away, and no hold or resume while opening.
    func testThePostStartConfigurationChangeWhileOpening() {
        var s = CallAudioState()
        _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .active), now: t0)
        _ = s.reduce(.started, now: t0 + 0.2)
        XCTAssertEqual(s.reduce(.configurationChanged, now: t0 + 0.3), [.start(settleRestart)])
        // The old settle timer is stale now.
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 1)), now: t0 + 0.7), [])
        XCTAssertEqual(s.reduce(.started, now: t0 + 0.4), [.schedule(timer(.settle, 2), after: 0.5)])
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 2)), now: t0 + 0.9), [.replyOpen(request: 1, .opened(session: "s1"))])
        XCTAssertTrue(s.micLive)
    }

    /// A start that keeps posting changes is capped, then fails the open.
    func testEndlessPostStartChangesFailTheOpen() {
        var s = CallAudioState()
        _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .active), now: t0)
        var now = t0
        for _ in 0..<CallAudioState.maxSettleRestarts {
            now += 0.1
            _ = s.reduce(.started, now: now)
            XCTAssertEqual(s.reduce(.configurationChanged, now: now + 0.1), [.start(settleRestart)])
        }
        _ = s.reduce(.started, now: now + 0.2)
        XCTAssertEqual(s.reduce(.configurationChanged, now: now + 0.3),
                       [.teardownEngine, .restoreSession, .deactivateSession, .replyOpen(request: 1, .failed(.unavailable))])
    }

    func testOpenFailureRestoresTheSessionThenAnswersUnavailable() {
        var s = CallAudioState()
        _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .active), now: t0)
        XCTAssertEqual(s.reduce(.startFailed, now: t0), [.teardownEngine, .restoreSession, .deactivateSession, .replyOpen(request: 1, .failed(.unavailable))])
        XCTAssertNil(s.sessions.open)
        XCTAssertEqual(s.reduce(.started, now: t0), [])
    }

    func testOpenInTheBackgroundAnswersInactive() {
        var s = CallAudioState()
        XCTAssertEqual(s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .background), now: t0),
                       [.replyOpen(request: 1, .failed(.inactive))])
        XCTAssertEqual(s.phase, .idle)
    }

    /// Ruling 2 / M1: an open while inactive (a cold launch, a return from
    /// Siri or a lock) waits for didBecomeActive instead of being refused.
    func testOpenWhileInactiveWaitsForBecomingActive() {
        var s = CallAudioState()
        XCTAssertEqual(s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .inactive), now: t0),
                       [.schedule(timer(.activeWait, 1), after: 2)])
        XCTAssertEqual(s.phase, .waitingActive)
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 0.4), [.log(.open), .recordSession, .start(fullOpen)])
        // The wait's timer is spent.
        XCTAssertEqual(s.reduce(.timerFired(timer(.activeWait, 1)), now: t0 + 2), [])
        XCTAssertEqual(s.reduce(.started, now: t0 + 0.5), [.schedule(timer(.settle, 2), after: 0.5)])
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 2)), now: t0 + 1), [.replyOpen(request: 1, .opened(session: "s1"))])
        XCTAssertTrue(s.micLive)
    }

    func testOpenWhileInactiveAnswersInactiveAfterTheCap() {
        var s = CallAudioState()
        _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .inactive), now: t0)
        XCTAssertEqual(s.reduce(.timerFired(timer(.activeWait, 1)), now: t0 + 2), [.replyOpen(request: 1, .failed(.inactive))])
        XCTAssertEqual(s.phase, .idle)
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 3), [])
    }

    func testOpenWhileInactiveThenBackgroundAnswersInactiveAtOnce() {
        var s = CallAudioState()
        _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .inactive), now: t0)
        XCTAssertEqual(s.reduce(.didEnterBackground, now: t0 + 0.5), [.replyOpen(request: 1, .failed(.inactive))])
        XCTAssertEqual(s.reduce(.timerFired(timer(.activeWait, 1)), now: t0 + 2), [])
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 3), [])
    }

    /// Every close path ends the wait: the open answers, nothing was touched,
    /// and neither the timer nor becoming active acts afterwards.
    func testCloseDuringTheWaitCancelsIt() {
        for cause in [CloseCause.navigationCommitted, .webContentTerminated, .controllerClosed] {
            var s = CallAudioState()
            _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .inactive), now: t0)
            XCTAssertEqual(s.reduce(.closeRequested(session: "s1"), now: t0 + 0.1), []) // the page cannot know it yet
            XCTAssertEqual(s.reduce(.closed(cause), now: t0 + 0.2), [.replyOpen(request: 1, .failed(.unavailable))])
            XCTAssertEqual(s.phase, .idle)
            XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 0.3), [])
            XCTAssertEqual(s.reduce(.timerFired(timer(.activeWait, 1)), now: t0 + 2), [])
        }
    }

    /// A second open joins the wait. If it found the app active, the wait
    /// ends there; in the background, both answer inactive.
    func testANewOpenDuringTheWait() {
        var s = CallAudioState()
        _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .inactive), now: t0)
        XCTAssertEqual(s.reduce(.openRequested(request: 2, session: "s2", permission: .granted, app: .inactive), now: t0 + 0.1), [])
        XCTAssertEqual(s.reduce(.openRequested(request: 3, session: "s3", permission: .granted, app: .active), now: t0 + 0.2),
                       [.log(.open), .recordSession, .start(fullOpen)])
        XCTAssertEqual(s.reduce(.timerFired(timer(.activeWait, 1)), now: t0 + 2), []) // cancelled
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 0.3), []) // already opening
        _ = s.reduce(.started, now: t0 + 0.4)
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 2)), now: t0 + 0.9), [
            .replyOpen(request: 1, .opened(session: "s1")), .replyOpen(request: 2, .opened(session: "s1")),
            .replyOpen(request: 3, .opened(session: "s1")),
        ])

        s = CallAudioState()
        _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .inactive), now: t0)
        XCTAssertEqual(s.reduce(.openRequested(request: 2, session: "s2", permission: .granted, app: .background), now: t0 + 0.1),
                       [.replyOpen(request: 1, .failed(.inactive)), .replyOpen(request: 2, .failed(.inactive))])
        XCTAssertEqual(s.reduce(.timerFired(timer(.activeWait, 1)), now: t0 + 2), [])
    }

    func testAnUndeterminedOpenWhileInactivePromptsOnceActive() {
        var s = CallAudioState()
        _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .undetermined, app: .inactive), now: t0)
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 0.4), [.requestPermission])
        XCTAssertEqual(s.reduce(.permissionAnswered(granted: true), now: t0 + 2), [.log(.open), .recordSession, .start(fullOpen)])
    }

    /// Holds and engine notifications during the wait have nothing to act on.
    func testTheWaitIgnoresEngineInputs() {
        var s = CallAudioState()
        _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .inactive), now: t0)
        for input in [CallAudioInput.interruptionBegan(wasSuspended: false), .interruptionEnded(shouldResume: true), .willResignActive,
                      .configurationChanged, .categoryLost, .mediaServicesLost, .routeChanged(.speaker), .pulse(on: true),
                      .micDelivered(handled: false), .started, .startFailed, .timerFired(timer(.settle, 1))] {
            XCTAssertEqual(s.reduce(input, now: t0 + 0.1), [], "\(input)")
        }
        XCTAssertEqual(s.phase, .waitingActive)
    }

    /// §4.2.10: permission is checked first, so a denied inactive open says denied.
    func testPermissionDeniedAnswersDeniedWithoutAPrompt() {
        var s = CallAudioState()
        XCTAssertEqual(s.reduce(.openRequested(request: 1, session: "s1", permission: .denied, app: .background), now: t0),
                       [.replyOpen(request: 1, .failed(.denied))])
        XCTAssertEqual(s.phase, .idle)
    }

    func testUndeterminedPermissionPromptsThenOpensOnGrant() {
        var s = CallAudioState()
        XCTAssertEqual(s.reduce(.openRequested(request: 1, session: "s1", permission: .undetermined, app: .active), now: t0), [.requestPermission])
        // The prompt makes the app inactive but not backgrounded: nothing to do.
        XCTAssertEqual(s.reduce(.interruptionBegan(wasSuspended: false), now: t0), [])
        XCTAssertEqual(s.reduce(.permissionAnswered(granted: true), now: t0 + 2), [.log(.open), .recordSession, .start(fullOpen)])
        XCTAssertEqual(s.reduce(.permissionAnswered(granted: true), now: t0 + 2), []) // a second callback
    }

    func testUndeterminedPermissionDenied() {
        var s = CallAudioState()
        _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .undetermined, app: .active), now: t0)
        _ = s.reduce(.openRequested(request: 2, session: "s2", permission: .undetermined, app: .active), now: t0)
        XCTAssertEqual(s.reduce(.permissionAnswered(granted: false), now: t0 + 1),
                       [.replyOpen(request: 1, .failed(.denied)), .replyOpen(request: 2, .failed(.denied))])
        XCTAssertEqual(s.phase, .idle)
    }

    func testBackgroundDuringThePromptAnswersInactiveOnGrant() {
        var s = CallAudioState()
        _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .undetermined, app: .active), now: t0)
        XCTAssertEqual(s.reduce(.didEnterBackground, now: t0 + 1), [])
        XCTAssertEqual(s.reduce(.permissionAnswered(granted: true), now: t0 + 2), [.replyOpen(request: 1, .failed(.inactive))])
        XCTAssertEqual(s.phase, .idle)
    }

    /// A second open while opening joins the first; while open, it answers at once.
    func testASecondOpenGetsTheSameResult() {
        var s = CallAudioState()
        _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .active), now: t0)
        XCTAssertEqual(s.reduce(.openRequested(request: 2, session: "s2", permission: .granted, app: .active), now: t0 + 0.1), [])
        _ = s.reduce(.started, now: t0 + 0.2)
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 1)), now: t0 + 0.7),
                       [.replyOpen(request: 1, .opened(session: "s1")), .replyOpen(request: 2, .opened(session: "s1"))])
        XCTAssertEqual(s.reduce(.openRequested(request: 3, session: "s3", permission: .granted, app: .background), now: t0 + 1),
                       [.replyOpen(request: 3, .opened(session: "s1"))])
    }

    func testASecondOpenJoinsAFailure() {
        var s = CallAudioState()
        _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .active), now: t0)
        _ = s.reduce(.openRequested(request: 2, session: "s2", permission: .granted, app: .active), now: t0)
        XCTAssertEqual(s.reduce(.startFailed, now: t0), [
            .teardownEngine, .restoreSession, .deactivateSession,
            .replyOpen(request: 1, .failed(.unavailable)), .replyOpen(request: 2, .failed(.unavailable)),
        ])
    }

    /// Close during open: every close path tears down, restores, and answers the waiters.
    func testCloseDuringOpen() {
        for cause in [CloseCause.navigationCommitted, .webContentTerminated, .controllerClosed] {
            var s = CallAudioState()
            _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .active), now: t0)
            _ = s.reduce(.started, now: t0 + 0.1)
            XCTAssertEqual(s.reduce(.closed(cause), now: t0 + 0.2), [
                .log(.close), .teardownEngine, .restoreSession, .deactivateSession, .replyOpen(request: 1, .failed(.unavailable)),
            ])
            XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 1)), now: t0 + 0.6), [])
            XCTAssertEqual(s.reduce(.configurationChanged, now: t0 + 0.6), [])
        }
    }

    /// The page cannot know the session while opening, so its close is a no-op.
    func testAPageCloseWhileOpeningIsANoOp() {
        var s = CallAudioState()
        _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .active), now: t0)
        XCTAssertEqual(s.reduce(.closeRequested(session: "s1"), now: t0), [])
        XCTAssertEqual(s.phase, .opening)
    }

    func testCloseDuringThePromptAnswersTheWaiter() {
        var s = CallAudioState()
        _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .undetermined, app: .active), now: t0)
        XCTAssertEqual(s.reduce(.closed(.navigationCommitted), now: t0), [.replyOpen(request: 1, .failed(.unavailable))])
        XCTAssertEqual(s.reduce(.permissionAnswered(granted: true), now: t0 + 1), [])
    }

    func testBackgroundOrInterruptionDuringOpeningFailsInactive() {
        for input in [CallAudioInput.didEnterBackground, .interruptionBegan(wasSuspended: false)] {
            var s = CallAudioState()
            _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .active), now: t0)
            _ = s.reduce(.started, now: t0 + 0.1)
            XCTAssertEqual(s.reduce(input, now: t0 + 0.2),
                           [.teardownEngine, .restoreSession, .deactivateSession, .replyOpen(request: 1, .failed(.inactive))])
        }
    }

    func testMediaServicesDuringOpeningFailUnavailable() {
        for input in [CallAudioInput.mediaServicesLost, .mediaServicesReset] {
            var s = CallAudioState()
            _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .active), now: t0)
            _ = s.reduce(.started, now: t0 + 0.1)
            XCTAssertEqual(s.reduce(input, now: t0 + 0.2),
                           [.teardownEngine, .restoreSession, .deactivateSession, .replyOpen(request: 1, .failed(.unavailable))])
        }
    }

    // MARK: close

    func testPageCloseIsIdempotentAndStaleClosesAreNoOps() {
        var s = opened()
        XCTAssertEqual(s.reduce(.closeRequested(session: "other"), now: t0 + 5), [])
        XCTAssertEqual(s.reduce(.closeRequested(session: "s1"), now: t0 + 5), close)
        XCTAssertNil(s.sessions.open)
        XCTAssertEqual(s.reduce(.closeRequested(session: "s1"), now: t0 + 5), [])
        XCTAssertEqual(s.reduce(.closed(.controllerClosed), now: t0 + 5), [])
        // After close, nothing acts.
        for input in everyNonOpenInput() {
            XCTAssertEqual(s.reduce(input, now: t0 + 6), [], "\(input)")
        }
        // A new open starts a new session.
        XCTAssertEqual(s.reduce(.openRequested(request: 9, session: "s2", permission: .granted, app: .active), now: t0 + 7),
                       [.log(.open), .recordSession, .start(fullOpen)])
    }

    func testEveryCloseCauseClosesAnOpenSession() {
        for cause in [CloseCause.navigationCommitted, .webContentTerminated, .controllerClosed] {
            var s = opened()
            XCTAssertEqual(s.reduce(.closed(cause), now: t0 + 5), close)
        }
    }

    /// A commit during a hold closes without resuming.
    func testCommitDuringHold() {
        var s = opened()
        _ = s.reduce(.didEnterBackground, now: t0 + 2)
        XCTAssertEqual(s.reduce(.closed(.navigationCommitted), now: t0 + 3), close)
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 4), [])
    }

    // MARK: watchdog

    /// The watchdog used to close silently (`.log(.closedUnheard)` + a plain
    /// `close()`), leaving the page with a live-looking call screen over a
    /// dead session (moss-approval-bug.md). It now sends `lost` first, same
    /// as every other lost path, so the page can offer "Resume call".
    func testWatchdogSendsLostAtExactly32UnhandledMicEvents() {
        var s = opened()
        for _ in 0..<31 { XCTAssertEqual(s.reduce(.micDelivered(handled: false), now: t0 + 2), []) }
        XCTAssertEqual(s.reduce(.micDelivered(handled: true), now: t0 + 2), []) // resets the count
        for _ in 0..<31 { XCTAssertEqual(s.reduce(.micDelivered(handled: false), now: t0 + 3), []) }
        XCTAssertEqual(
            s.reduce(.micDelivered(handled: false), now: t0 + 3),
            [.emitLost(session: "s1", .unheard), .log(.lost(.unheard)), .closeClips, .teardownEngine, .restoreSession, .deactivateSession]
        )
        XCTAssertEqual(s.phase, .idle)
        XCTAssertEqual(s.reduce(.micDelivered(handled: false), now: t0 + 3), [])
    }

    // MARK: holds

    /// §4.2.8: hold first, cut, restart with fresh nodes and a new tap
    /// (always: the input format read at notification time can be stale,
    /// M2), resume after the settle.
    func testRouteChangeHoldsRestartsAndResumes() {
        var s = opened()
        XCTAssertEqual(s.reduce(.configurationChanged, now: t0 + 5),
                       [.emitHold(session: "s1", .mediaReset), .log(.hold(.mediaReset)), .holdClips, .start(settleRestart)])
        XCTAssertFalse(s.micLive)
        XCTAssertEqual(s.reduce(.started, now: t0 + 5.1), [.schedule(timer(.settle, 2), after: 0.5)])
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 2)), now: t0 + 5.6),
                       [.releaseClips, .emitResume(session: "s1"), .log(.resume)])
        XCTAssertTrue(s.micLive)
    }

    /// The change after the restart's own start is absorbed: no second hold.
    func testTheChangeAfterARestartIsNotASecondHold() {
        var s = opened()
        _ = s.reduce(.configurationChanged, now: t0 + 5)
        _ = s.reduce(.started, now: t0 + 5.1)
        XCTAssertEqual(s.reduce(.configurationChanged, now: t0 + 5.2), [.start(settleRestart)])
        XCTAssertEqual(s.reduce(.started, now: t0 + 5.3), [.schedule(timer(.settle, 3), after: 0.5)])
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 3)), now: t0 + 5.8),
                       [.releaseClips, .emitResume(session: "s1"), .log(.resume)])
    }

    func testPulseStopsOnHoldAndRestartsOnResume() {
        var s = opened()
        XCTAssertEqual(s.reduce(.pulse(on: true), now: t0 + 1), [.startPulse])
        XCTAssertEqual(s.reduce(.pulse(on: true), now: t0 + 1), [])
        XCTAssertEqual(s.reduce(.didEnterBackground, now: t0 + 2),
                       [.emitHold(session: "s1", .background), .log(.hold(.background)), .holdClips, .stopPulse, .stopEngine])
        XCTAssertEqual(s.reduce(.pulse(on: false), now: t0 + 2.5), []) // recorded only
        XCTAssertEqual(s.reduce(.pulse(on: true), now: t0 + 2.6), [])
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 3), [.start(settleRestart)])
        _ = s.reduce(.started, now: t0 + 3.1)
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 2)), now: t0 + 3.6),
                       [.releaseClips, .startPulse, .emitResume(session: "s1"), .log(.resume)])
    }

    /// Resume only on didBecomeActive, never while backgrounded.
    func testBackgroundThenActiveResumes() {
        var s = opened()
        _ = s.reduce(.didEnterBackground, now: t0 + 2)
        XCTAssertEqual(s.reduce(.configurationChanged, now: t0 + 2.5), []) // deferred
        XCTAssertEqual(s.reduce(.categoryLost, now: t0 + 2.6), []) // deferred
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 3),
                       [.log(.categoryReasserted), .start(StartPlan(applyCategory: true, rebuild: .nodesAndTap))])
    }

    /// `.began` with no `.ended`: the stale reason is cleared on becoming active
    /// when other audio is not playing.
    func testInterruptionWithoutEndedIsClearedOnBecomingActive() {
        var s = opened()
        XCTAssertEqual(s.reduce(.interruptionBegan(wasSuspended: false), now: t0 + 2),
                       [.emitHold(session: "s1", .interrupted), .log(.hold(.interrupted)), .holdClips, .stopEngine])
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 9), [.start(settleRestart)])
        _ = s.reduce(.started, now: t0 + 9.1)
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 2)), now: t0 + 9.6), [.releaseClips, .emitResume(session: "s1"), .log(.resume)])
    }

    /// §4.2.6 "a resume ALWAYS happens on becoming active": even while other
    /// audio plays and before any `.ended`. If the hardware is still taken,
    /// the start fails and the retry then `lost` path applies.
    func testBecomingActiveBeforeEndedStillResumes() {
        var s = opened()
        _ = s.reduce(.interruptionBegan(wasSuspended: false), now: t0 + 2)
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 3), [.start(settleRestart)])
        XCTAssertEqual(s.reasons, [])
        XCTAssertEqual(s.reduce(.interruptionEnded(shouldResume: false), now: t0 + 3.05), []) // late, harmless
        _ = s.reduce(.started, now: t0 + 3.1)
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 2)), now: t0 + 3.6), [.releaseClips, .emitResume(session: "s1"), .log(.resume)])
    }

    func testBecomingActiveWhileTheHardwareIsStillTakenEndsInLost() {
        var s = opened()
        _ = s.reduce(.interruptionBegan(wasSuspended: false), now: t0 + 2)
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 3), [.start(settleRestart)])
        XCTAssertEqual(s.reduce(.startFailed, now: t0 + 3), [.schedule(timer(.retry, 2), after: 0.5)])
        XCTAssertEqual(s.reduce(.timerFired(timer(.retry, 2)), now: t0 + 3.5), [.start(settleRestart)])
        XCTAssertEqual(s.reduce(.startFailed, now: t0 + 3.5).first, .emitLost(session: "s1", .restartFailed))
    }

    func testInterruptionEndedWithShouldResumeResumes() {
        var s = opened()
        _ = s.reduce(.interruptionBegan(wasSuspended: false), now: t0 + 2)
        XCTAssertEqual(s.reduce(.interruptionEnded(shouldResume: true), now: t0 + 3), [.start(settleRestart)])
    }

    /// Siri and the like resign active: an `.ended` without `shouldResume`
    /// then waits for didBecomeActive.
    func testInterruptionEndedWithoutShouldResumeWaitsForBecomingActive() {
        var s = opened()
        XCTAssertEqual(s.reduce(.willResignActive, now: t0 + 1.9), [])
        _ = s.reduce(.interruptionBegan(wasSuspended: false), now: t0 + 2)
        XCTAssertEqual(s.reduce(.interruptionEnded(shouldResume: false), now: t0 + 3), [])
        XCTAssertEqual(s.reasons, [.interrupted])
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 4), [.start(settleRestart)])
    }

    /// I2: a phone call answered or declined from the banner never resigns
    /// the app, so no didBecomeActive follows. `.ended` without
    /// `shouldResume` restarts anyway while active.
    func testInterruptionEndedWithoutShouldResumeRestartsWhileActive() {
        var s = opened()
        _ = s.reduce(.interruptionBegan(wasSuspended: false), now: t0 + 2)
        XCTAssertEqual(s.reduce(.interruptionEnded(shouldResume: false), now: t0 + 9), [.start(settleRestart)])
        XCTAssertEqual(s.reasons, [])
        _ = s.reduce(.started, now: t0 + 9.1)
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 2)), now: t0 + 9.6), [.releaseClips, .emitResume(session: "s1"), .log(.resume)])
    }

    /// The restart still needs the rest of the hold set clear, and a device
    /// still busy takes the one retry, then `lost`.
    func testInterruptionEndedWithoutShouldResumeKeepsTheOtherRules() {
        var s = opened()
        _ = s.reduce(.interruptionBegan(wasSuspended: false), now: t0 + 2)
        _ = s.reduce(.mediaServicesLost, now: t0 + 2.5)
        XCTAssertEqual(s.reduce(.interruptionEnded(shouldResume: false), now: t0 + 3), []) // media services still down
        XCTAssertEqual(s.reasons, [.mediaReset])

        s = opened()
        _ = s.reduce(.interruptionBegan(wasSuspended: false), now: t0 + 2)
        XCTAssertEqual(s.reduce(.interruptionEnded(shouldResume: false), now: t0 + 3), [.start(settleRestart)])
        XCTAssertEqual(s.reduce(.startFailed, now: t0 + 3), [.schedule(timer(.retry, 2), after: 0.5)])
        XCTAssertEqual(s.reduce(.timerFired(timer(.retry, 2)), now: t0 + 3.5), [.start(settleRestart)])
        XCTAssertEqual(s.reduce(.startFailed, now: t0 + 3.5).first, .emitLost(session: "s1", .restartFailed))
    }

    /// I2: `.began` while active with no `.ended` at all stays held on the
    /// native side; the page offers "Resume call" after a while.
    func testAnInterruptionThatNeverEndsWhileActiveStaysHeld() {
        var s = opened()
        _ = s.reduce(.interruptionBegan(wasSuspended: false), now: t0 + 2)
        XCTAssertEqual(s.reasons, [.interrupted])
        XCTAssertTrue(s.pageHeld)
        XCTAssertFalse(s.micLive)
    }

    /// I2: a stale `.began` (`.appWasSuspended`) never stops the engine,
    /// whether it lands while live or after didBecomeActive began the restart.
    func testAStaleSuspendedBeganIsIgnored() {
        var s = opened()
        XCTAssertEqual(s.reduce(.interruptionBegan(wasSuspended: true), now: t0 + 1), [])
        XCTAssertTrue(s.micLive)

        s = opened()
        _ = s.reduce(.didEnterBackground, now: t0 + 2)
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 3), [.start(settleRestart)])
        XCTAssertEqual(s.reduce(.interruptionBegan(wasSuspended: true), now: t0 + 3.05), [])
        _ = s.reduce(.started, now: t0 + 3.1)
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 2)), now: t0 + 3.6), [.releaseClips, .emitResume(session: "s1"), .log(.resume)])
        XCTAssertTrue(s.micLive)
    }

    /// Background during an interruption: one hold, one resume, only on becoming active.
    func testBackgroundDuringInterruption() {
        var s = opened()
        _ = s.reduce(.interruptionBegan(wasSuspended: false), now: t0 + 2)
        XCTAssertEqual(s.reduce(.didEnterBackground, now: t0 + 3), []) // already held and stopped
        XCTAssertEqual(s.reasons, [.interrupted, .background])
        XCTAssertEqual(s.reduce(.interruptionEnded(shouldResume: true), now: t0 + 4), []) // still in background
        XCTAssertEqual(s.reasons, [.background])
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 5), [.start(settleRestart)])
        _ = s.reduce(.started, now: t0 + 5.1)
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 2)), now: t0 + 5.6), [.releaseClips, .emitResume(session: "s1"), .log(.resume)])
    }

    /// A restart in flight is abandoned by background and redone on return.
    func testBackgroundDuringARestartStopsTheEngine() {
        var s = opened()
        _ = s.reduce(.configurationChanged, now: t0 + 5)
        _ = s.reduce(.started, now: t0 + 5.1)
        XCTAssertEqual(s.reduce(.didEnterBackground, now: t0 + 5.2), [.stopEngine]) // no second hold
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 2)), now: t0 + 5.6), []) // stale
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 8), [.start(settleRestart)])
        XCTAssertEqual(s.reasons, [.mediaReset])
        _ = s.reduce(.started, now: t0 + 8.1)
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 3)), now: t0 + 8.6), [.releaseClips, .emitResume(session: "s1"), .log(.resume)])
        XCTAssertEqual(s.reasons, [])
    }

    /// Becoming active with nothing held does nothing (Control Center pulled down).
    func testBecomingActiveWithoutAHoldDoesNothing() {
        var s = opened()
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 2), [])
    }

    // MARK: retry and lost

    func testOneRetryAfterHalfASecondThenSuccess() {
        var s = opened()
        _ = s.reduce(.didEnterBackground, now: t0 + 2)
        _ = s.reduce(.didBecomeActive, now: t0 + 3)
        XCTAssertEqual(s.reduce(.startFailed, now: t0 + 3), [.schedule(timer(.retry, 2), after: 0.5)])
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 3.2), []) // the retry is pending
        XCTAssertEqual(s.reduce(.timerFired(timer(.retry, 2)), now: t0 + 3.5), [.start(settleRestart)])
        XCTAssertEqual(s.reduce(.started, now: t0 + 3.6), [.schedule(timer(.settle, 3), after: 0.5)])
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 3)), now: t0 + 4.1), [.releaseClips, .emitResume(session: "s1"), .log(.resume)])
    }

    func testRetryFailureSendsLost() {
        var s = opened()
        _ = s.reduce(.configurationChanged, now: t0 + 5)
        XCTAssertEqual(s.reduce(.startFailed, now: t0 + 5), [.schedule(timer(.retry, 2), after: 0.5)])
        // The retry repeats the failed plan, tap rebuild included.
        XCTAssertEqual(s.reduce(.timerFired(timer(.retry, 2)), now: t0 + 5.5), [.start(settleRestart)])
        XCTAssertEqual(s.reduce(.startFailed, now: t0 + 5.5), [
            .emitLost(session: "s1", .restartFailed), .log(.lost(.restartFailed)),
            .closeClips, .teardownEngine, .restoreSession, .deactivateSession,
        ])
        XCTAssertNil(s.sessions.open)
        XCTAssertTrue(s.sessions.lost.contains("s1"))
        for input in everyNonOpenInput() {
            XCTAssertEqual(s.reduce(input, now: t0 + 6), [], "\(input)")
        }
        // After lost, an open starts a new session.
        XCTAssertEqual(s.reduce(.openRequested(request: 2, session: "s2", permission: .granted, app: .active), now: t0 + 7),
                       [.log(.open), .recordSession, .start(fullOpen)])
    }

    /// Too many post-start changes while resuming count as a failed restart.
    func testEndlessChangesWhileResumingRetryThenLost() {
        var s = opened()
        _ = s.reduce(.configurationChanged, now: t0 + 5)
        var now = t0 + 5
        for _ in 0..<CallAudioState.maxSettleRestarts {
            now += 0.1
            _ = s.reduce(.started, now: now)
            XCTAssertEqual(s.reduce(.configurationChanged, now: now + 0.05), [.start(settleRestart)])
        }
        _ = s.reduce(.started, now: now + 0.1)
        let retry = s.reduce(.configurationChanged, now: now + 0.15)
        XCTAssertEqual(retry.count, 1)
        guard case let .schedule(t, 0.5) = retry.first, t.kind == .retry else { return XCTFail("\(retry)") }
        XCTAssertEqual(s.reduce(.timerFired(t), now: now + 0.7), [.start(settleRestart)])
    }

    // MARK: category (§4.2.5)

    func testCategoryReassertHoldsReappliesAndResumes() {
        var s = opened()
        XCTAssertEqual(s.reduce(.categoryLost, now: t0 + 5), [
            .emitHold(session: "s1", .mediaReset), .log(.hold(.mediaReset)), .holdClips,
            .log(.categoryReasserted), .start(StartPlan(applyCategory: true, rebuild: .nodes)),
        ])
        _ = s.reduce(.started, now: t0 + 5.1)
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 2)), now: t0 + 5.6), [.releaseClips, .emitResume(session: "s1"), .log(.resume)])
    }

    /// At most 3 reasserts in 10 s; the fourth sends lost.
    func testCategoryReassertRateLimit() {
        var s = opened()
        var token = 1
        for i in 0..<3 {
            let now = t0 + 5 + Double(i) * 2
            XCTAssertTrue(s.reduce(.categoryLost, now: now).contains(.log(.categoryReasserted)))
            token += 1
            _ = s.reduce(.started, now: now + 0.1)
            _ = s.reduce(.timerFired(timer(.settle, token)), now: now + 0.6)
        }
        XCTAssertEqual(s.reduce(.categoryLost, now: t0 + 14.9), [
            .emitHold(session: "s1", .mediaReset), .log(.hold(.mediaReset)), .holdClips,
            .emitLost(session: "s1", .category), .log(.lost(.category)),
            .closeClips, .teardownEngine, .restoreSession, .deactivateSession,
        ])
    }

    func testCategoryReassertsOutsideTheWindowAreAllowed() {
        var s = opened()
        var token = 1
        for i in 0..<5 {
            let now = t0 + 5 + Double(i) * 4 // 3 per 12 s at most
            XCTAssertTrue(s.reduce(.categoryLost, now: now).contains(.log(.categoryReasserted)), "reassert \(i)")
            token += 1
            _ = s.reduce(.started, now: now + 0.1)
            _ = s.reduce(.timerFired(timer(.settle, token)), now: now + 0.6)
        }
        XCTAssertEqual(s.phase, .open)
    }

    /// Flips while the restart is deferred are not reasserts, so they never add up to lost.
    func testDeferredCategoryLossesDoNotCount() {
        var s = opened()
        _ = s.reduce(.didEnterBackground, now: t0 + 2)
        for i in 0..<6 { XCTAssertEqual(s.reduce(.categoryLost, now: t0 + 3 + Double(i) * 0.1), []) }
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 4),
                       [.log(.categoryReasserted), .start(StartPlan(applyCategory: true, rebuild: .nodesAndTap))])
    }

    /// Under the limit, a category loss while opening is reasserted with no
    /// hold (the page does not know the session yet); the open still answers.
    func testCategoryLossWhileOpeningIsReassertedSilently() {
        var s = CallAudioState()
        _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .active), now: t0)
        _ = s.reduce(.started, now: t0 + 0.1)
        XCTAssertEqual(s.reduce(.categoryLost, now: t0 + 0.2),
                       [.log(.categoryReasserted), .start(StartPlan(applyCategory: true, rebuild: .nodes))])
        XCTAssertEqual(s.reduce(.started, now: t0 + 0.3), [.schedule(timer(.settle, 2), after: 0.5)])
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 2)), now: t0 + 0.8), [.replyOpen(request: 1, .opened(session: "s1"))])
    }

    // MARK: media services (§4.2.9)

    func testMediaServicesLostThenResetRebuildsEverything() {
        var s = opened()
        XCTAssertEqual(s.reduce(.pulse(on: true), now: t0 + 1), [.startPulse])
        XCTAssertEqual(s.reduce(.mediaServicesLost, now: t0 + 2),
                       [.emitHold(session: "s1", .mediaReset), .log(.hold(.mediaReset)), .holdClips, .stopPulse])
        XCTAssertEqual(s.reduce(.configurationChanged, now: t0 + 2.6), [])
        XCTAssertEqual(s.reduce(.mediaServicesReset, now: t0 + 3), [.start(fullOpen)])
        _ = s.reduce(.started, now: t0 + 3.2)
        XCTAssertEqual(s.reduce(.timerFired(timer(.settle, 2)), now: t0 + 3.7),
                       [.releaseClips, .startPulse, .emitResume(session: "s1"), .log(.resume)])
    }

    /// A reset that never comes does not wedge the call: becoming active tries a whole new engine.
    func testBecomingActiveAfterMediaServicesLostRebuildsEverything() {
        var s = opened()
        _ = s.reduce(.mediaServicesLost, now: t0 + 2)
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 3), [.start(fullOpen)])
        // A reset during that start: the new engine may be dead too, so it is rebuilt once more.
        XCTAssertEqual(s.reduce(.mediaServicesReset, now: t0 + 3.05), [])
        XCTAssertEqual(s.reduce(.started, now: t0 + 3.1), [.start(fullOpen)])
    }

    func testMediaServicesResetInBackgroundWaitsForActive() {
        var s = opened()
        _ = s.reduce(.didEnterBackground, now: t0 + 2)
        XCTAssertEqual(s.reduce(.mediaServicesLost, now: t0 + 3), [])
        XCTAssertEqual(s.reduce(.mediaServicesReset, now: t0 + 4), [])
        XCTAssertEqual(s.reduce(.didBecomeActive, now: t0 + 5), [.start(fullOpen)])
    }

    func testMediaServicesResetFailureRetriesThenLost() {
        var s = opened()
        _ = s.reduce(.mediaServicesReset, now: t0 + 3)
        XCTAssertEqual(s.reduce(.startFailed, now: t0 + 3), [.schedule(timer(.retry, 2), after: 0.5)])
        XCTAssertEqual(s.reduce(.timerFired(timer(.retry, 2)), now: t0 + 3.5), [.start(fullOpen)])
        XCTAssertEqual(s.reduce(.startFailed, now: t0 + 3.5).first, .emitLost(session: "s1", .restartFailed))
    }

    // MARK: route events

    func testRouteEventsReachThePageOnlyWhileOpen() {
        var s = CallAudioState()
        XCTAssertEqual(s.reduce(.routeChanged(.bluetooth), now: t0), [])
        s = opened()
        XCTAssertEqual(s.reduce(.routeChanged(.bluetooth), now: t0 + 1), [.emitRoute(session: "s1", .bluetooth), .log(.routeBluetooth)])
        XCTAssertEqual(s.reduce(.routeChanged(.speaker), now: t0 + 1), [.emitRoute(session: "s1", .speaker)])
    }

    // MARK: property test

    /// Random seeded sequences, with a simulated engine answering every start.
    func testRandomSequencesKeepTheInvariants() {
        var seen: [String: Int] = [:]
        for seed in UInt64(1)...400 {
            var random = SeededRandom(seed: seed)
            var s = CallAudioState()
            var now: TimeInterval = 0
            var timers: [CallAudioTimer] = []
            var nextRequest = 1
            var replies: [Int: Int] = [:]
            var requested: Set<Int> = []
            var startPending = false
            var recorded = false // a recordSession not yet restored
            var restored = false
            var deactivated = false
            var heldSessions: Set<String> = []
            var trace: [String] = []

            func step(_ input: CallAudioInput) {
                if case let .openRequested(request, _, _, _) = input { requested.insert(request) }
                if case .started = input { startPending = false }
                if case .startFailed = input { startPending = false }
                let wasIdle = s.phase == .idle
                let wasHeld = s.pageHeld
                let actions = s.reduce(input, now: now)
                trace.append("\(trace.count): \(input) -> \(actions)")
                let context = "seed \(seed)\n" + trace.suffix(12).joined(separator: "\n")

                if wasIdle, !isOpen(input) {
                    XCTAssertEqual(actions, [], "an action after close\n\(context)")
                }
                for (i, action) in actions.enumerated() {
                    seen[String("\(action)".prefix { $0 != "(" }), default: 0] += 1
                    switch action {
                    case .emitResume:
                        XCTAssertTrue(s.reasons.isEmpty, "resume with reasons held\n\(context)")
                        XCTAssertTrue(wasHeld, "resume without a hold\n\(context)")
                    case .holdClips:
                        XCTAssertTrue(actions[..<i].contains { if case .emitHold = $0 { return true } else { return false } },
                                      "cut before hold\n\(context)")
                    case let .emitHold(session, _):
                        XCTAssertFalse(wasHeld, "a second hold\n\(context)")
                        heldSessions.insert(session)
                    case let .emitLost(session, _):
                        XCTAssertTrue(heldSessions.contains(session), "lost without a hold\n\(context)")
                    case let .replyOpen(request, _):
                        XCTAssertTrue(requested.contains(request), "reply to nothing\n\(context)")
                        replies[request, default: 0] += 1
                        XCTAssertEqual(replies[request], 1, "two replies\n\(context)")
                    case .start:
                        XCTAssertEqual(i, actions.count - 1, "start not last\n\(context)")
                        startPending = true
                    case let .schedule(timer, _):
                        timers.append(timer)
                    case .recordSession:
                        XCTAssertFalse(recorded, "recorded twice\n\(context)")
                        recorded = true
                        restored = false
                        deactivated = false
                    case .restoreSession:
                        XCTAssertTrue(recorded && !restored, "restore without one record\n\(context)")
                        restored = true
                    case .deactivateSession:
                        XCTAssertTrue(recorded && !deactivated, "deactivate without one record\n\(context)")
                        deactivated = true
                    default:
                        break
                    }
                }
                if recorded, restored, deactivated { recorded = false }
                if s.pageHeld { XCTAssertFalse(s.micLive, "mic live during a hold\n\(context)") }
                if s.phase == .idle {
                    XCTAssertNil(s.sessions.open, "a session outlived the close\n\(context)")
                    XCTAssertFalse(recorded, "idle with the session not restored\n\(context)")
                }
            }

            /// Liveness: the app is active, every start succeeds and every
            /// timer fires. The call must end up live, or closed.
            func calm() {
                step(.didBecomeActive)
                for _ in 0..<60 {
                    now += 0.6
                    if s.phase == .permission {
                        step(.permissionAnswered(granted: true))
                    } else if startPending {
                        step(.started)
                    } else if !timers.isEmpty {
                        step(.timerFired(timers.removeFirst()))
                    } else {
                        break
                    }
                }
                XCTAssertTrue(s.micLive || s.phase == .idle,
                              "wedged: \(s.phase) held \(s.pageHeld) reasons \(s.reasons)\nseed \(seed)\n" + trace.suffix(16).joined(separator: "\n"))
            }

            for _ in 0..<120 {
                now += Double(random.next(in: 0...800)) / 1000
                if startPending, random.next(in: 0...9) < 8 {
                    step(random.next(in: 0...5) == 0 ? .startFailed : .started)
                } else if !timers.isEmpty, random.next(in: 0...3) == 0 {
                    step(.timerFired(timers.remove(at: random.next(in: 0...(timers.count - 1)))))
                } else if random.next(in: 0...29) == 0 {
                    calm()
                } else {
                    step(randomInput(&random, request: &nextRequest))
                }
            }
            calm()
            // Every open request is answered exactly once, and every recorded
            // session restored, by the end.
            step(.closed(.controllerClosed))
            for request in requested {
                XCTAssertEqual(replies[request], 1, "seed \(seed): request \(request) answered \(replies[request] ?? 0) times")
            }
            XCTAssertFalse(recorded, "seed \(seed): a recorded session was never restored")
        }
        // The sequences reach the interesting states.
        for name in ["emitHold", "emitResume", "emitLost", "holdClips", "replyOpen", "requestPermission", "startPulse", "closeClips"] {
            XCTAssertGreaterThan(seen[name] ?? 0, 5, "\(name) seen \(seen[name] ?? 0) times")
        }
    }

    // MARK: helpers

    private func timer(_ kind: CallAudioTimer.Kind, _ token: Int) -> CallAudioTimer {
        CallAudioTimer(kind: kind, token: token)
    }

    /// Opened, settled and live, with session "s1"; the settle timer used token 1.
    private func opened() -> CallAudioState {
        var s = CallAudioState()
        _ = s.reduce(.openRequested(request: 1, session: "s1", permission: .granted, app: .active), now: t0)
        _ = s.reduce(.started, now: t0 + 0.2)
        _ = s.reduce(.timerFired(timer(.settle, 1)), now: t0 + 0.7)
        precondition(s.micLive)
        return s
    }

    private func everyNonOpenInput() -> [CallAudioInput] {
        [
            .permissionAnswered(granted: true), .started, .startFailed, .closeRequested(session: "s1"),
            .closed(.navigationCommitted), .interruptionBegan(wasSuspended: false), .interruptionEnded(shouldResume: true),
            .willResignActive, .didEnterBackground, .didBecomeActive,
            .configurationChanged, .categoryLost, .mediaServicesLost, .mediaServicesReset,
            .routeChanged(.speaker), .pulse(on: true), .micDelivered(handled: false),
            .timerFired(timer(.settle, 1)), .timerFired(timer(.retry, 2)), .timerFired(timer(.activeWait, 1)),
        ]
    }

    private func isOpen(_ input: CallAudioInput) -> Bool {
        if case .openRequested = input { return true }
        return false
    }

    private func randomInput(_ random: inout SeededRandom, request: inout Int) -> CallAudioInput {
        switch random.next(in: 0...19) {
        case 0, 1:
            request += 1
            let permission: RecordPermission = [.granted, .granted, .granted, .denied, .undetermined][random.next(in: 0...4)]
            return .openRequested(request: request, session: "s\(request)", permission: permission, app: [.active, .active, .active, .active, .inactive, .background][random.next(in: 0...5)])
        case 2: return .permissionAnswered(granted: random.next(in: 0...3) > 0)
        case 3: return .closeRequested(session: "s\(max(1, request - random.next(in: 0...2)))")
        case 4: return .closed([.navigationCommitted, .webContentTerminated, .controllerClosed][random.next(in: 0...2)])
        case 5: return random.next(in: 0...3) == 0 ? .willResignActive : .interruptionBegan(wasSuspended: random.next(in: 0...3) == 0)
        case 6: return .interruptionEnded(shouldResume: random.next(in: 0...1) == 1)
        case 7: return .didEnterBackground
        case 8, 9: return .didBecomeActive
        case 10, 11: return .configurationChanged
        case 12: return .categoryLost
        case 13: return .mediaServicesLost
        case 14: return .mediaServicesReset
        case 15: return .routeChanged([.speaker, .receiver, .headphones, .bluetooth, .other][random.next(in: 0...4)])
        case 16: return .pulse(on: random.next(in: 0...1) == 1)
        case 17, 18: return .micDelivered(handled: random.next(in: 0...9) > 0)
        default: return .timerFired(CallAudioTimer(kind: [.settle, .retry, .activeWait][random.next(in: 0...2)], token: random.next(in: 0...20)))
        }
    }
}
