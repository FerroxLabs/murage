import Foundation

/// Why native stopped a clip that was not at fault (spec §4.1 `"cut"`).
public enum CutReason: String, Sendable {
    /// `callAudioControl` `stop`.
    case stop
    /// An interruption, a route change, background or a media reset.
    case hold
    /// A new clip's first piece arrived while this one was open.
    case next
}

/// The `state` (and `reason`) of a `{ type: "clip" }` event.
public enum ClipEvent: Equatable, Sendable {
    case playing, progress, ended, failed
    case cut(CutReason)

    public var state: String {
        switch self {
        case .playing: return "playing"
        case .progress: return "progress"
        case .ended: return "ended"
        case .failed: return "failed"
        case .cut: return "cut"
        }
    }

    public var reason: String? {
        if case let .cut(reason) = self { return reason.rawValue }
        return nil
    }
}

/// What the engine does for the book, in order.
public enum ClipAction: Equatable, Sendable {
    /// Make a StreamDecoder for this generation.
    case openDecoder(generation: UInt64, label: CallAudioMime)
    /// Append the piece just played in (its bytes and `last`) to this generation's decoder.
    case feed(generation: UInt64)
    /// Drop this generation's decoder.
    case closeDecoder(generation: UInt64)
    /// Schedule the buffer just reported to `decoded`, with a completion that
    /// reports `played(generation:frames:)` back on the queue.
    case schedule(generation: UInt64)
    /// `playerNode.play()`.
    case startPlayer
    /// `playerNode.pause()`.
    case pausePlayer
    /// `playerNode.stop()`. It fires the pending completions, which the book ignores.
    case stopPlayer
    /// Send `{ type: "clip", session, clip, state, reason? }`.
    case emit(clip: String, ClipEvent)
    /// ShellLog `call audio clip underrun`.
    case logUnderrun
}

/// The reply to one `callAudioPlay` (nil is `true`) and what to do about it.
public struct PieceOutcome: Equatable, Sendable {
    public var reply: CallAudioArgError?
    public var actions: [ClipAction]

    public init(reply: CallAudioArgError?, actions: [ClipAction]) {
        self.reply = reply
        self.actions = actions
    }
}

/// Spec §4.1 and §4.2.4: the bookkeeping for the one clip that plays at a
/// time, as pure logic over counts and durations. The engine owns the
/// decoder, the buffers and the player node, and does what the returned
/// actions say, in order.
///
/// - Each clip gets a generation token; anything reported for an old or
///   settled generation (a completion fired by `stopPlayer`, a buffer the
///   decoder made after a cut) is ignored.
/// - A counter tracks scheduled buffers not yet played. `ended` fires when
///   `last` has arrived, the decoder has been flushed, and the counter is
///   back to zero. Zero-length buffers are never scheduled.
/// - Jitter buffer: the player starts once 250 ms is scheduled, or when the
///   flush after `last` leaves less than that. If the scheduled audio runs
///   out before the flush, the player pauses (an underrun) and starts again
///   at 250 ms. A clip whose first piece says `paused` fills but waits for
///   `resume`.
/// - Every clip settles exactly once: `ended`, `failed` or `cut`. `cut` comes
///   only from the control path (stop, hold, the next clip), never from a
///   completion.
/// - During a hold, pieces are accepted and dropped, and a clip that starts
///   during it is cut once.
public struct ClipBook: Sendable {
    public static let sampleRate = 48000
    /// 250 ms at 48 kHz.
    public static let jitterFrames = 12000

    private struct Clip: Sendable {
        let id: String
        let generation: UInt64
        var paused: Bool
        var settled = false
        var started = false
        var underrun = false
        var flushed = false
        var outstanding = 0
        var queuedFrames = 0
        var totalFrames = 0
    }

    private var intake = ClipIntake()
    private var clip: Clip?
    private var generation: UInt64 = 0
    public private(set) var held = false

    public init() {}

    /// Buffers of the current clip scheduled and not yet played.
    public var outstanding: Int { isLive ? clip?.outstanding ?? 0 : 0 }

    /// A clip is open and has not settled.
    public var isLive: Bool { clip.map { !$0.settled } ?? false }

    /// The current clip's generation, if one is live.
    public var liveGeneration: UInt64? { isLive ? clip?.generation : nil }

    // MARK: pieces

    public mutating func play(_ piece: CallAudioPlayArgs) -> PieceOutcome {
        switch intake.admit(piece) {
        case let .refuse(id):
            return PieceOutcome(reply: .badArgs, actions: id.map { fail(clip: $0) } ?? [])
        case .next:
            // A settled clip's pieces (after a stop, a hold or a decode
            // failure) are accepted and dropped.
            guard let live = clip, !live.settled, live.id == piece.clip else { return PieceOutcome(reply: nil, actions: []) }
            return PieceOutcome(reply: nil, actions: [.feed(generation: live.generation)])
        case .first:
            var actions: [ClipAction] = []
            if let current = clip, !current.settled { actions += settle(.cut(.next)) }
            generation += 1
            clip = Clip(id: piece.clip, generation: generation, paused: piece.paused)
            if held {
                actions += settle(.cut(.hold), stopPlayer: false, closeDecoder: false)
                return PieceOutcome(reply: nil, actions: actions)
            }
            actions += [.openDecoder(generation: generation, label: piece.mime), .feed(generation: generation)]
            return PieceOutcome(reply: nil, actions: actions)
        }
    }

    /// A piece refused by `CallAudioPlayArgs.parse`: if it named the live
    /// clip, that clip fails once and takes no more pieces.
    public mutating func refused(_ refusal: CallAudioArgRefusal) -> [ClipAction] {
        guard let id = refusal.clip else { return [] }
        intake.refuse(clip: id)
        return fail(clip: id)
    }

    // MARK: decoder

    /// The decoder made a buffer of `frames` for `generation`.
    public mutating func decoded(generation: UInt64, frames: Int) -> [ClipAction] {
        guard frames > 0, var live = current(generation) else { return [] }
        live.outstanding += 1
        live.queuedFrames += frames
        live.totalFrames += frames
        clip = live
        return [.schedule(generation: generation)] + startIfReady()
    }

    /// The decoder has been flushed after `last`.
    public mutating func flushed(generation: UInt64) -> [ClipAction] {
        guard var live = current(generation) else { return [] }
        live.flushed = true
        clip = live
        if live.totalFrames == 0 { return settle(.failed, stopPlayer: false) }
        if live.outstanding == 0 { return settle(.ended) }
        return startIfReady()
    }

    /// The decoder threw: the clip cannot be played.
    public mutating func decodeFailed(generation: UInt64) -> [ClipAction] {
        guard current(generation) != nil else { return [] }
        return settle(.failed)
    }

    // MARK: player

    /// A scheduled buffer of `frames` finished (`.dataPlayedBack`).
    public mutating func played(generation: UInt64, frames: Int) -> [ClipAction] {
        guard var live = current(generation), live.outstanding > 0 else { return [] }
        live.outstanding -= 1
        live.queuedFrames = max(0, live.queuedFrames - frames)
        clip = live
        guard live.outstanding == 0 else { return [] }
        if live.flushed { return settle(.ended) }
        guard live.started, !live.underrun else { return [] }
        clip?.underrun = true
        return live.paused ? [.logUnderrun] : [.pausePlayer, .logUnderrun]
    }

    /// The engine's ~250 ms timer: `progress` only while samples are rendering.
    public func tick() -> [ClipAction] {
        guard let live = clip, !live.settled, live.started, !live.paused, !live.underrun else { return [] }
        return [.emit(clip: live.id, .progress)]
    }

    // MARK: control

    /// `callAudioControl` for the clip. The pulse actions are not the book's.
    public mutating func control(_ action: CallAudioControlAction) -> [ClipAction] {
        guard var live = clip, !live.settled else { return [] }
        switch action {
        case .stop:
            return settle(.cut(.stop))
        case .pause:
            guard !live.paused else { return [] }
            live.paused = true
            clip = live
            return live.started && !live.underrun ? [.pausePlayer] : []
        case .resume:
            guard live.paused else { return [] }
            live.paused = false
            clip = live
            return live.started && !live.underrun ? [.startPlayer] : startIfReady()
        case .pulseOn, .pulseOff:
            return []
        }
    }

    /// The engine is going on hold. Send `hold` BEFORE doing these actions'
    /// emits: the live clip is cut once, and pieces are dropped until `endHold`.
    public mutating func hold() -> [ClipAction] {
        held = true
        return isLive ? settle(.cut(.hold)) : []
    }

    public mutating func endHold() {
        held = false
    }

    /// The session is closing: stop without telling the page.
    public mutating func close() -> [ClipAction] {
        var actions: [ClipAction] = []
        if let live = clip, !live.settled { actions = [.stopPlayer, .closeDecoder(generation: live.generation)] }
        intake.reset()
        clip = nil
        held = false
        return actions
    }

    // MARK: internals

    private func current(_ generation: UInt64) -> Clip? {
        guard let live = clip, !live.settled, live.generation == generation else { return nil }
        return live
    }

    private mutating func fail(clip id: String) -> [ClipAction] {
        guard let live = clip, !live.settled, live.id == id else { return [] }
        return settle(.failed)
    }

    /// Starts (or restarts after an underrun) once 250 ms is queued, or once
    /// the flush left less than that.
    private mutating func startIfReady() -> [ClipAction] {
        guard var live = clip, !live.settled, !live.paused, !live.started || live.underrun,
              live.queuedFrames >= Self.jitterFrames || (live.flushed && live.queuedFrames > 0) else { return [] }
        let first = !live.started
        live.started = true
        live.underrun = false
        clip = live
        return first ? [.startPlayer, .emit(clip: live.id, .playing)] : [.startPlayer]
    }

    private mutating func settle(_ event: ClipEvent, stopPlayer: Bool = true, closeDecoder: Bool = true) -> [ClipAction] {
        guard var live = clip, !live.settled else { return [] }
        live.settled = true
        live.outstanding = 0
        clip = live
        var actions: [ClipAction] = stopPlayer ? [.stopPlayer] : []
        actions.append(.emit(clip: live.id, event))
        if closeDecoder { actions.append(.closeDecoder(generation: live.generation)) }
        return actions
    }
}
