import Foundation

// Spec §4.2.6: the call-audio lifecycle as a pure reducer. `CallAudioEngine`
// (MurageShell) feeds every notification, channel call and engine result in
// as a `CallAudioInput`, with the time, and does what the returned
// `CallAudioAction`s say, in order. The reducer owns no timers and no AV
// objects: a timer is a `.schedule` action whose firing comes back as
// `.timerFired`.
//
// Engine contract:
// - Run the actions of one batch in order on the call-audio queue.
// - `.start` is always the last action of its batch. Run it, then feed
//   `.started` or `.startFailed` synchronously, in the same queue block,
//   before any other input. Never answer a start asynchronously: the
//   reducer's handling of a start in flight relies on it.
// - A `.schedule` fires `.timerFired` with the same timer after the delay.
//   The reducer ignores a timer it has since replaced or cancelled, so the
//   engine never cancels one.
// - `.holdClips` runs `ClipBook.hold()` and does what it returns. The
//   `.emitHold` before it in the same batch is always sent first, so the
//   events of one batch must cross to the main actor in one ordered hop.
// - `.teardownEngine`, `.stopEngine`, `.stopPulse`, `.restoreSession` and
//   `.deactivateSession` must tolerate having nothing to act on: they can
//   come after a failed first start, or after `mediaServicesLost`, when the
//   AV objects are dead (drop the references then; never call into them).
//   `.restoreSession` always follows a `.recordSession` today; skip it if
//   none ran.
// - Feed `willResignActive`, `didEnterBackground` and `didBecomeActive`
//   even while idle: a permission answer during the prompt, and an
//   interruption's end, read the app state.

/// `{ type: "hold", reason }` (spec §4.1).
public enum HoldReason: String, CaseIterable, Sendable {
    case interrupted
    case background
    case mediaReset = "media-reset"
}

/// `{ type: "lost", reason }`.
public enum LostReason: String, Sendable {
    /// The engine did not restart after a hold, retry included.
    case restartFailed = "restart-failed"
    /// The session category was fought over more than 3 times in 10 s (§4.2.5).
    case category
    /// The watchdog: 32 consecutive mic frames the page never answered
    /// (§4.2.7). The session is closed either way; this tells the page so
    /// instead of leaving a dead session behind a live-looking call screen
    /// (moss-approval-bug.md).
    case unheard
}

/// `{ type: "route", output }`.
public enum RouteOutput: String, CaseIterable, Sendable {
    case speaker, receiver, headphones, bluetooth, other
}

/// `UIApplication.shared.applicationState`, read on the main actor when the
/// open arrives.
public enum CallAudioAppState: Sendable {
    case active, inactive, background
}

/// `AVAudioApplication.shared.recordPermission`, read when the open arrives.
public enum RecordPermission: Sendable {
    case granted, denied, undetermined
}

/// The `callAudioOpen` error codes (spec §4.1).
public enum CallAudioOpenError: String, Error, Sendable {
    case denied
    /// The app did not become active within `CallAudioState.activeWait` of
    /// the open, or is in the background. Transient: the page retries once
    /// on the next `resume` app event.
    case inactive
    case unavailable
}

public enum CallAudioOpenResult: Equatable, Sendable {
    /// `{ session, sampleRate: 16000, frame: 1024 }`.
    case opened(session: String)
    case failed(CallAudioOpenError)
}

/// The close paths other than `callAudioClose` (spec §4.2.7).
public enum CloseCause: Sendable {
    /// `webView(_:didCommit:)`: any main-frame commit, reloads included.
    case navigationCommitted
    /// `webViewWebContentProcessDidTerminate`.
    case webContentTerminated
    /// `close(_:)`, `viewDidDisappear` or `deinit`.
    case controllerClosed
}

/// A timer the engine runs for the reducer.
public struct CallAudioTimer: Equatable, Sendable {
    public enum Kind: Sendable {
        /// The window after every start in which the configuration change of
        /// §4.2.2 step 8 is expected. The open answers, or the hold ends, only
        /// once it passes with the engine running.
        case settle
        /// The one retry after a failed restart (§4.2.6).
        case retry
        /// How long an open that arrived while inactive waits for
        /// `didBecomeActive` (§4.2.10).
        case activeWait
    }

    public let kind: Kind
    public let token: Int

    public init(kind: Kind, token: Int) {
        self.kind = kind
        self.token = token
    }
}

/// How much of the engine a `.start` rebuilds before starting. Ordered: a
/// later need merges into a pending one by taking the larger.
public enum Rebuild: Int, Comparable, Sendable {
    /// Remake the mixer-to-output connection and detach the player and pulse
    /// nodes for FRESH ones (a reused node never plays a scheduled buffer
    /// again after a configuration change, §4.2.2 step 8). Tap and converter kept.
    case nodes
    /// `.nodes`, plus remove the tap and install it again with the input
    /// format read now and a new converter. Check the format first: an input
    /// that reads 0 Hz makes `installTap` crash, so that is a failed start.
    case nodesAndTap
    /// Discard every AV object and build a new engine, §4.2.2 steps 2 to 6.
    case engine

    public static func < (lhs: Rebuild, rhs: Rebuild) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// What one `.start` does, in this order: `setCategory` (§4.2.2 step 1) if
/// `applyCategory`, `setActive(true)`, stop the engine if it runs, the
/// rebuild, then `prepare()` and `start()` (step 7). Any throw is `.startFailed`.
public struct StartPlan: Equatable, Sendable {
    public var applyCategory: Bool
    public var rebuild: Rebuild

    public init(applyCategory: Bool, rebuild: Rebuild) {
        self.applyCategory = applyCategory
        self.rebuild = rebuild
    }
}

/// The fixed ShellLog lines (spec §4.2.11) the reducer decides on.
public enum CallAudioLog: Equatable, Sendable {
    case open, close, resume, categoryReasserted, routeBluetooth
    case hold(HoldReason)
    /// Carries why, so a persisted line can tell the watchdog's `unheard`
    /// apart from a real media reset or a category fight
    /// (callbar-review.md M5: `.lost` alone couldn't).
    case lost(LostReason)

    public var message: String {
        switch self {
        case .open: return "call audio open"
        case .close: return "call audio close"
        case .resume: return "call audio resume"
        case let .lost(reason): return "call audio lost \(reason.rawValue)"
        case .categoryReasserted: return "call audio session category reasserted"
        case .routeBluetooth: return "call audio route bluetooth"
        case let .hold(reason): return "call audio hold \(reason.rawValue)"
        }
    }
}

public enum CallAudioInput: Sendable {
    /// `callAudioOpen`. `request` identifies the channel reply; `session` is
    /// a fresh id, used only if this request starts a new session.
    case openRequested(request: Int, session: String, permission: RecordPermission, app: CallAudioAppState)
    /// The `requestRecordPermission` callback, hopped to the queue.
    case permissionAnswered(granted: Bool)
    /// The last `.start` ran (the spec's "opened" and "restart succeeded").
    case started
    /// The last `.start` threw (the spec's "open failed" and "restart failed").
    case startFailed
    /// `callAudioClose({ session })`. The engine always answers `true`.
    case closeRequested(session: String)
    case closed(CloseCause)
    /// `wasSuspended`: the reason is `.appWasSuspended` (or the older
    /// `AVAudioSessionInterruptionWasSuspendedKey` is set). That is a stale
    /// notice posted when a suspended app resumes, not a new interruption,
    /// and Apple's guidance is to ignore it.
    case interruptionBegan(wasSuspended: Bool)
    /// Without `shouldResume` the restart is still tried while the app is
    /// active: the owner never left the call screen (a phone call answered
    /// or declined from the banner), and no `didBecomeActive` will follow.
    case interruptionEnded(shouldResume: Bool)
    /// `willResignActiveNotification`: Siri, Control Center, a full-screen call.
    case willResignActive
    case didEnterBackground
    /// `didBecomeActiveNotification`. With a call open it always clears
    /// `interrupted` and `background` and tries the restart (§4.2.6 "a resume
    /// ALWAYS happens on becoming active"); if the hardware is still taken,
    /// the start fails and the retry then `lost` path applies.
    case didBecomeActive
    /// `AVAudioEngineConfigurationChange`. Every restart it causes rebuilds
    /// the tap: the input format read at notification time can be stale.
    case configurationChanged
    /// A `routeChangeNotification` with reason `.categoryChange` AND a
    /// category or mode other than `.playAndRecord` / `.voiceChat` (§4.2.5).
    case categoryLost
    case mediaServicesLost
    case mediaServicesReset
    /// A `routeChangeNotification`: logging only on the page.
    case routeChanged(RouteOutput)
    /// `callAudioControl` `pulseOn` / `pulseOff` for the open session.
    case pulse(on: Bool)
    /// A mic event was emitted; `handled` is what `emit` reported.
    case micDelivered(handled: Bool)
    case timerFired(CallAudioTimer)
}

public enum CallAudioAction: Equatable, Sendable {
    /// `requestRecordPermission`; its answer comes back as `.permissionAnswered`.
    case requestPermission
    /// Record the session's category, mode and options, before anything changes them.
    case recordSession
    /// Always last in its batch. See `StartPlan`.
    case start(StartPlan)
    /// `engine.stop()`: the microphone turns off; the AV objects are kept.
    case stopEngine
    /// Stop the pulse loop and the engine, remove the tap, and drop every AV object.
    case teardownEngine
    /// Restore the category, mode and options from `.recordSession`.
    case restoreSession
    /// `setActive(false, options: .notifyOthersOnDeactivation)`.
    case deactivateSession
    /// Start and stop the pulse node's loop.
    case startPulse, stopPulse
    /// `ClipBook.hold()`: cut the live clip and drop pieces until `.releaseClips`.
    case holdClips
    /// `ClipBook.endHold()`.
    case releaseClips
    /// `ClipBook.close()`: stop without telling the page.
    case closeClips
    case emitHold(session: String, HoldReason)
    case emitResume(session: String)
    case emitLost(session: String, LostReason)
    case emitRoute(session: String, RouteOutput)
    /// Answer one `callAudioOpen`.
    case replyOpen(request: Int, CallAudioOpenResult)
    case schedule(CallAudioTimer, after: TimeInterval)
    case log(CallAudioLog)
}

/// Spec §4.2.6 to §4.2.10. One value per engine; see the engine contract at
/// the top of this file.
///
/// - An open that arrives while the app is inactive (not backgrounded) is
///   `waitingActive` until `didBecomeActive`, for at most `activeWait`, and
///   only then answers `inactive`. A cold launch and a return from Siri or a
///   lock both reach the page before the app is active.
/// - A session is `opening` from the open until its first start has settled,
///   then `open`. Holds during opening fail the open instead (`inactive` for
///   background or an interruption, `unavailable` otherwise), so the page
///   never sees a hold for a session it does not know yet.
/// - Every start is followed by a 0.5 s settle window. The configuration
///   change that voice processing posts ~0.1 s after a start (§4.2.2 step 8)
///   lands in it: it is a restart with fresh nodes and a new tap, never a
///   hold, and at most `maxSettleRestarts` in a row before the start counts
///   as failed. This is the "debounce" of §4.2.6: a change within 500 ms of
///   a start does not start a hold of its own. Outside the window, a change
///   is a `mediaReset` hold. Both rebuild the tap.
/// - `reasons` holds the hold reasons. `hold` is sent when the first one is
///   added, before the clip is cut. `resume` is sent only when the set is
///   empty and a restart has settled. A restart is deferred while
///   `interrupted` or `background` is held, or while media services are
///   down. `didBecomeActive` always clears those and tries it.
///   `interruptionEnded` with `shouldResume` also tries it without waiting
///   for `didBecomeActive` (allowed while inactive but not backgrounded);
///   without `shouldResume`, only while the app is active. A `.began` that
///   `wasSuspended` is ignored.
/// - Every restart after a background or an interruption rebuilds the tap
///   (`.nodesAndTap`): the route may have changed while the engine was
///   stopped without a configuration change being posted.
/// - A failed restart gets one retry after 0.5 s; a second failure is `lost`.
public struct CallAudioState: Sendable {
    public static let settleDelay: TimeInterval = 0.5
    public static let retryDelay: TimeInterval = 0.5
    public static let maxSettleRestarts = 3
    public static let maxReasserts = 3
    public static let reassertWindow: TimeInterval = 10
    public static let unheardLimit = 32
    public static let activeWait: TimeInterval = 2

    public enum Phase: Sendable {
        case idle, waitingActive, permission, opening, open
    }

    private enum Engine: Sendable {
        /// No usable AV objects: never built, or media services were lost.
        case down
        case stopped
        /// A `.start` is out; its result is next.
        case starting
        /// Started; the settle timer is armed.
        case settling
        case running
    }

    public private(set) var phase: Phase = .idle
    /// The open session and the lost ones, for argument parsing.
    public private(set) var sessions = CallAudioSessions()
    public private(set) var reasons: Set<HoldReason> = []
    /// `hold` was sent and `resume` not yet.
    public private(set) var pageHeld = false

    private var session: String?
    private var waiters: [Int] = []
    private var engine: Engine = .down
    private var pendingRebuild: Rebuild?
    private var pendingCategory = false
    private var lastPlan = StartPlan(applyCategory: true, rebuild: .engine)
    private var mediaDown = false
    private var settleRestarts = 0
    private var retryUsed = false
    private var retryScheduled = false
    private var armed: CallAudioTimer?
    private var timerToken = 0
    private var pulseOn = false
    private var unheard = 0
    private var reasserts: [TimeInterval] = []
    private var app: CallAudioAppState = .active
    private var inBackground: Bool { app == .background }
    /// The permission read with an open that is `waitingActive`.
    private var waitingPermission: RecordPermission = .granted
    /// A category loss waiting for its reassert, which is what counts (§4.2.5).
    private var reassertPending = false
    private var now: TimeInterval = 0

    public init() {}

    /// Whether the engine should emit mic frames: open, settled and not held.
    public var micLive: Bool { phase == .open && engine == .running && !pageHeld }

    public mutating func reduce(_ input: CallAudioInput, now: TimeInterval) -> [CallAudioAction] {
        self.now = now
        switch input {
        case let .openRequested(request, session, permission, app):
            return openRequested(request: request, session: session, permission: permission, app: app)
        case let .permissionAnswered(granted):
            guard phase == .permission else { return [] }
            if !granted { return finish(replying: .failed(.denied)) }
            if inBackground { return finish(replying: .failed(.inactive)) }
            return beginOpen()
        case .started:
            return started()
        case .startFailed:
            guard engine == .starting, phase == .opening || phase == .open else { return [] }
            return startFailed()
        case let .closeRequested(session):
            guard phase == .open, session == self.session else { return [] }
            return close()
        case .closed:
            return close()
        case let .interruptionBegan(wasSuspended):
            guard !wasSuspended else { return [] }
            return hold(.interrupted, failingOpenWith: .inactive)
        case let .interruptionEnded(shouldResume):
            guard phase == .open, shouldResume || app == .active, reasons.contains(.interrupted) else { return [] }
            reasons.remove(.interrupted)
            return attemptStart()
        case .willResignActive:
            if app == .active { app = .inactive }
            return []
        case .didEnterBackground:
            app = .background
            if phase == .waitingActive { return finish(replying: .failed(.inactive)) }
            return hold(.background, failingOpenWith: .inactive)
        case .didBecomeActive:
            app = .active
            if phase == .waitingActive { return proceedOpen() }
            guard phase == .open else { return [] }
            // The owner is back on the call screen. Interruption `.ended` is
            // not guaranteed, and a reset may never be posted: try anyway.
            reasons.remove(.background)
            reasons.remove(.interrupted)
            if mediaDown {
                mediaDown = false
                pendingRebuild = .engine
                pendingCategory = true
            }
            return attemptStart()
        case .configurationChanged:
            return configurationChanged()
        case .categoryLost:
            return categoryLost()
        case .mediaServicesLost:
            if phase == .opening { return failOpen(.unavailable) }
            guard phase == .open else { return [] }
            let actions = addReason(.mediaReset)
            engine = .down
            mediaDown = true
            cancelTimers()
            pendingRebuild = .engine
            pendingCategory = true
            return actions
        case .mediaServicesReset:
            if phase == .opening { return failOpen(.unavailable) }
            guard phase == .open else { return [] }
            let actions = addReason(.mediaReset)
            if engine != .starting { engine = .down }
            mediaDown = false
            cancelTimers()
            retryUsed = false
            pendingRebuild = .engine
            pendingCategory = true
            return actions + attemptStart()
        case let .routeChanged(output):
            guard phase == .open, let session else { return [] }
            return [.emitRoute(session: session, output)] + (output == .bluetooth ? [.log(.routeBluetooth)] : [])
        case let .pulse(on):
            guard phase == .open, on != pulseOn else { return [] }
            pulseOn = on
            guard engine == .running, !pageHeld else { return [] }
            return [on ? .startPulse : .stopPulse]
        case let .micDelivered(handled):
            guard phase == .open else { return [] }
            unheard = handled ? 0 : unheard + 1
            guard unheard >= Self.unheardLimit else { return [] }
            // Used to close silently (`.log(.closedUnheard)` + `close()`):
            // the page kept a live-looking call screen over a dead session,
            // with nothing telling it to offer "Resume call"
            // (moss-approval-bug.md). `lost` now goes to the page first.
            return loseNow(.unheard)
        case let .timerFired(timer):
            guard timer == armed else { return [] }
            armed = nil
            switch timer.kind {
            case .settle: return settled()
            case .retry:
                retryScheduled = false
                return attemptStart()
            case .activeWait:
                guard phase == .waitingActive else { return [] }
                return finish(replying: .failed(.inactive))
            }
        }
    }

    // MARK: open

    private mutating func openRequested(request: Int, session: String, permission: RecordPermission, app: CallAudioAppState) -> [CallAudioAction] {
        self.app = app
        switch phase {
        case .permission, .opening:
            // One engine: a second open gets the first one's result.
            waiters.append(request)
            return []
        case .waitingActive:
            // Joins the wait, which ends now if this open found the app
            // active (or in the background) before the notification came.
            waiters.append(request)
            switch app {
            case .active: return proceedOpen()
            case .background: return finish(replying: .failed(.inactive))
            case .inactive: return []
            }
        case .open:
            return [.replyOpen(request: request, .opened(session: self.session ?? session))]
        case .idle:
            if permission == .denied { return [.replyOpen(request: request, .failed(.denied))] }
            if app == .background { return [.replyOpen(request: request, .failed(.inactive))] }
            self.session = session
            waiters = [request]
            if app == .inactive {
                // §4.2.10: wait for the app to become active rather than refuse.
                phase = .waitingActive
                waitingPermission = permission
                return [schedule(.activeWait, after: Self.activeWait)]
            }
            return proceed(permission: permission)
        }
    }

    /// The app became active during the wait: open as if it had been.
    private mutating func proceedOpen() -> [CallAudioAction] {
        armed = nil
        return proceed(permission: waitingPermission)
    }

    private mutating func proceed(permission: RecordPermission) -> [CallAudioAction] {
        if permission == .undetermined {
            phase = .permission
            return [.requestPermission]
        }
        return beginOpen()
    }

    private mutating func beginOpen() -> [CallAudioAction] {
        phase = .opening
        engine = .down
        pendingRebuild = .engine
        pendingCategory = true
        return [.log(.open), .recordSession] + attemptStart()
    }

    /// Answers every waiting open and goes idle. Nothing was touched yet.
    private mutating func finish(replying result: CallAudioOpenResult) -> [CallAudioAction] {
        let replies = waiters.map { CallAudioAction.replyOpen(request: $0, result) }
        reset()
        return replies
    }

    /// §4.2.7: a failed open restores the session before the page falls back.
    private mutating func failOpen(_ error: CallAudioOpenError) -> [CallAudioAction] {
        [.teardownEngine, .restoreSession, .deactivateSession] + finish(replying: .failed(error))
    }

    // MARK: starts

    /// Starts with whatever is pending, unless something defers it.
    private mutating func attemptStart() -> [CallAudioAction] {
        guard phase == .opening || phase == .open,
              engine == .down || engine == .stopped,
              !mediaDown, !inBackground, !retryScheduled,
              reasons.isSubset(of: [.mediaReset]) else { return [] }
        let plan = StartPlan(applyCategory: pendingCategory, rebuild: pendingRebuild ?? .nodes)
        pendingCategory = false
        pendingRebuild = nil
        lastPlan = plan
        engine = .starting
        var actions: [CallAudioAction] = []
        if reassertPending {
            reassertPending = false
            reasserts.append(now)
            actions.append(.log(.categoryReasserted))
        }
        return actions + [.start(plan)]
    }

    private mutating func started() -> [CallAudioAction] {
        guard phase == .opening || phase == .open else { return [] }
        guard engine == .starting else {
            // A start that was given up on while it ran must not keep the mic on.
            return engine == .stopped ? [.stopEngine] : []
        }
        engine = .settling
        if pendingCategory || pendingRebuild != nil {
            // Something needed a restart while this one ran.
            engine = .stopped
            return attemptStart()
        }
        return [schedule(.settle, after: Self.settleDelay)]
    }

    private mutating func settled() -> [CallAudioAction] {
        guard engine == .settling else { return [] }
        engine = .running
        settleRestarts = 0
        retryUsed = false
        if phase == .opening {
            phase = .open
            sessions.open = session
            unheard = 0
            let session = self.session ?? ""
            let replies = waiters.map { CallAudioAction.replyOpen(request: $0, .opened(session: session)) }
            waiters = []
            return replies
        }
        reasons.remove(.mediaReset)
        // The pulse was only recorded while an unheld restart settled.
        guard pageHeld else { return [pulseOn ? .startPulse : .stopPulse] }
        guard reasons.isEmpty, let session else { return [] }
        pageHeld = false
        return [.releaseClips] + (pulseOn ? [.startPulse] : []) + [.emitResume(session: session), .log(.resume)]
    }

    private mutating func startFailed() -> [CallAudioAction] {
        if phase == .opening { return failOpen(.unavailable) }
        if retryUsed { return lose(.restartFailed) }
        retryUsed = true
        retryScheduled = true
        settleRestarts = 0
        engine = .stopped
        pendingRebuild = max(pendingRebuild ?? lastPlan.rebuild, lastPlan.rebuild)
        pendingCategory = pendingCategory || lastPlan.applyCategory
        return [schedule(.retry, after: Self.retryDelay)]
    }

    // MARK: holds

    /// Adds a reason; the first one sends `hold`, then cuts the clip.
    private mutating func addReason(_ reason: HoldReason) -> [CallAudioAction] {
        reasons.insert(reason)
        guard !pageHeld, let session else { return [] }
        pageHeld = true
        return [.emitHold(session: session, reason), .log(.hold(reason)), .holdClips] + (pulseOn ? [.stopPulse] : [])
    }

    /// Background and interruptions: hold and turn the microphone off. The
    /// restart waits for `didBecomeActive` (or `interruptionEnded`).
    private mutating func hold(_ reason: HoldReason, failingOpenWith error: CallAudioOpenError) -> [CallAudioAction] {
        if phase == .opening { return failOpen(error) }
        guard phase == .open else { return [] }
        var actions = addReason(reason)
        // The route may change while stopped with no configuration change
        // posted: the restart reinstalls the tap for the input format then.
        pendingRebuild = max(pendingRebuild ?? .nodesAndTap, .nodesAndTap)
        if engine == .starting {
            pendingRebuild = max(pendingRebuild ?? lastPlan.rebuild, lastPlan.rebuild)
            pendingCategory = pendingCategory || lastPlan.applyCategory
        }
        if engine == .running || engine == .settling || engine == .starting {
            actions.append(.stopEngine)
            engine = .stopped
        }
        // A new episode: the restart on return gets its own retry.
        cancelTimers()
        retryUsed = false
        settleRestarts = 0
        return actions
    }

    /// Every restart a change causes rebuilds the tap (`.nodesAndTap`): the
    /// input format read when the notification lands can still be the old
    /// one, and a tap in the wrong format can raise mid-call.
    private mutating func configurationChanged() -> [CallAudioAction] {
        guard phase == .opening || phase == .open else { return [] }
        let rebuild: Rebuild = .nodesAndTap
        switch engine {
        case .settling:
            // §4.2.2 step 8: the change after a start. Restart with fresh
            // nodes and a new tap; no hold of its own.
            settleRestarts += 1
            engine = .stopped
            cancelTimers()
            if settleRestarts > Self.maxSettleRestarts {
                engine = .starting
                return startFailed()
            }
            pendingRebuild = max(pendingRebuild ?? .nodesAndTap, .nodesAndTap)
            return attemptStart()
        case .running:
            // §4.2.8: Apple stopped the engine. Hold, cut, restart.
            let actions = addReason(.mediaReset)
            engine = .stopped
            pendingRebuild = max(pendingRebuild ?? rebuild, rebuild)
            return actions + attemptStart()
        case .down, .stopped, .starting:
            // Deferred, or picked up when the start in flight reports.
            guard phase == .open else { return [] }
            pendingRebuild = max(pendingRebuild ?? rebuild, rebuild)
            return engine == .starting ? [] : attemptStart()
        }
    }

    /// §4.2.5: reassert the category through a `mediaReset` hold, at most 3
    /// times in 10 s.
    private mutating func categoryLost() -> [CallAudioAction] {
        guard phase == .opening || phase == .open else { return [] }
        reasserts = reasserts.filter { now - $0 < Self.reassertWindow }
        if reasserts.count >= Self.maxReasserts {
            return phase == .opening ? failOpen(.unavailable) : lose(.category)
        }
        // Counted and logged when the reassert actually runs (attemptStart):
        // flips while the restart is deferred never add up to `lost`.
        reassertPending = true
        pendingCategory = true
        var actions: [CallAudioAction] = []
        if phase == .open { actions += addReason(.mediaReset) }
        if engine == .running || engine == .settling {
            engine = .stopped
            cancelTimers()
        }
        return actions + attemptStart()
    }

    // MARK: endings

    /// §4.1 `lost`: hold first if not held, then end the session for good.
    private mutating func lose(_ reason: LostReason) -> [CallAudioAction] {
        addReason(.mediaReset) + loseNow(reason)
    }

    /// The teardown half of `lose(_:)`, with no hold first: the watchdog
    /// calls this directly. Nothing reset the media here — the page just
    /// stopped answering mic frames — so there is nothing to hold for.
    private mutating func loseNow(_ reason: LostReason) -> [CallAudioAction] {
        var actions: [CallAudioAction] = []
        if let session { actions.append(.emitLost(session: session, reason)) }
        actions += [.log(.lost(reason)), .closeClips, .teardownEngine, .restoreSession, .deactivateSession]
        sessions.lose()
        reset()
        return actions
    }

    /// §4.2.7: every close path restores the session and deactivates it.
    private mutating func close() -> [CallAudioAction] {
        switch phase {
        case .idle:
            return []
        case .waitingActive, .permission:
            return finish(replying: .failed(.unavailable))
        case .opening:
            return [.log(.close)] + failOpen(.unavailable)
        case .open:
            sessions.open = nil
            reset()
            return [.log(.close), .closeClips, .teardownEngine, .restoreSession, .deactivateSession]
        }
    }

    /// Back to idle. `sessions`, `app` and the timer token survive.
    private mutating func reset() {
        phase = .idle
        session = nil
        waiters = []
        reasons = []
        pageHeld = false
        engine = .down
        pendingRebuild = nil
        pendingCategory = false
        mediaDown = false
        settleRestarts = 0
        retryUsed = false
        retryScheduled = false
        armed = nil
        pulseOn = false
        unheard = 0
        reasserts = []
        reassertPending = false
    }

    // MARK: timers

    private mutating func schedule(_ kind: CallAudioTimer.Kind, after delay: TimeInterval) -> CallAudioAction {
        timerToken += 1
        let timer = CallAudioTimer(kind: kind, token: timerToken)
        armed = timer
        return .schedule(timer, after: delay)
    }

    private mutating func cancelTimers() {
        armed = nil
        retryScheduled = false
    }
}
