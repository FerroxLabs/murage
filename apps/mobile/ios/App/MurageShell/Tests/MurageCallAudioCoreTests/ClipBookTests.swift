import Foundation
import XCTest
@testable import MurageCallAudioCore

/// Spec §4.1 (one clip at a time, empty last piece, pieces during a hold, cut
/// reasons) and §4.2.4 (jitter threshold, underrun, generation token,
/// outstanding-buffer counter, the ended rule).
final class ClipBookTests: XCTestCase {
    // MARK: scenarios

    func testAClipPlaysThroughToEnded() {
        var book = ClipBook()
        XCTAssertEqual(book.play(piece("c1", 0)), ok([.openDecoder(generation: 1, label: .mpeg), .feed(generation: 1)]))
        XCTAssertEqual(book.decoded(generation: 1, frames: 6000), [.schedule(generation: 1)])
        XCTAssertEqual(book.tick(), []) // nothing is rendering yet
        // 250 ms scheduled: start.
        XCTAssertEqual(book.decoded(generation: 1, frames: 6000), [.schedule(generation: 1), .startPlayer, .emit(clip: "c1", .playing)])
        XCTAssertEqual(book.outstanding, 2)
        XCTAssertEqual(book.tick(), [.emit(clip: "c1", .progress)])
        XCTAssertEqual(book.play(piece("c1", 1, last: true, bytes: 0)), ok([.feed(generation: 1)])) // empty last piece
        XCTAssertEqual(book.flushed(generation: 1), [])
        XCTAssertEqual(book.played(generation: 1, frames: 6000), [])
        XCTAssertEqual(book.played(generation: 1, frames: 6000), [.stopPlayer, .emit(clip: "c1", .ended), .closeDecoder(generation: 1)])
        XCTAssertEqual(book.outstanding, 0)
        XCTAssertEqual(book.tick(), [])
        XCTAssertEqual(book.played(generation: 1, frames: 6000), []) // a stray completion after the end
    }

    func testZeroLengthBuffersAreNeverScheduled() {
        var book = started()
        XCTAssertEqual(book.decoded(generation: 1, frames: 0), [])
        XCTAssertEqual(book.outstanding, 2)
    }

    /// `last` arrives before 250 ms is scheduled: the flush starts playback.
    func testAShortClipStartsOnTheFlush() {
        var book = ClipBook()
        _ = book.play(piece("c1", 0, last: true))
        XCTAssertEqual(book.decoded(generation: 1, frames: 3000), [.schedule(generation: 1)])
        XCTAssertEqual(book.flushed(generation: 1), [.startPlayer, .emit(clip: "c1", .playing)])
        XCTAssertEqual(book.played(generation: 1, frames: 3000), [.stopPlayer, .emit(clip: "c1", .ended), .closeDecoder(generation: 1)])
    }

    /// A clip that held nothing playable fails (spec §4.1 "failed").
    func testNothingPlayableFails() {
        var book = ClipBook()
        _ = book.play(piece("c1", 0, last: true))
        XCTAssertEqual(book.flushed(generation: 1), [.emit(clip: "c1", .failed), .closeDecoder(generation: 1)])
        XCTAssertEqual(book.tick(), [])
    }

    func testDecodeFailureFailsOnce() {
        var book = started()
        XCTAssertEqual(book.decodeFailed(generation: 1), [.stopPlayer, .emit(clip: "c1", .failed), .closeDecoder(generation: 1)])
        XCTAssertEqual(book.decodeFailed(generation: 1), [])
        XCTAssertEqual(book.play(piece("c1", 1)), ok([])) // later pieces are dropped
    }

    func testUnderrunPausesAndResumesAtTheThreshold() {
        var book = started()
        XCTAssertEqual(book.played(generation: 1, frames: 6000), [])
        XCTAssertEqual(book.played(generation: 1, frames: 6000), [.pausePlayer, .logUnderrun])
        XCTAssertEqual(book.tick(), []) // progress stops
        XCTAssertEqual(book.decoded(generation: 1, frames: 6000), [.schedule(generation: 1)])
        XCTAssertEqual(book.decoded(generation: 1, frames: 6000), [.schedule(generation: 1), .startPlayer]) // no second "playing"
        XCTAssertEqual(book.tick(), [.emit(clip: "c1", .progress)])
    }

    func testUnderrunResumesOnTheFlush() {
        var book = started()
        _ = book.played(generation: 1, frames: 6000)
        _ = book.played(generation: 1, frames: 6000)
        _ = book.play(piece("c1", 1, last: true))
        XCTAssertEqual(book.decoded(generation: 1, frames: 100), [.schedule(generation: 1)])
        XCTAssertEqual(book.flushed(generation: 1), [.startPlayer])
        XCTAssertEqual(book.played(generation: 1, frames: 100), [.stopPlayer, .emit(clip: "c1", .ended), .closeDecoder(generation: 1)])
    }

    /// `ended` waits for both the flush and the last completion, in either order.
    func testEndedNeedsFlushAndZeroOutstanding() {
        var book = started()
        _ = book.play(piece("c1", 1, last: true))
        XCTAssertEqual(book.played(generation: 1, frames: 6000), [])
        XCTAssertEqual(book.played(generation: 1, frames: 6000), [.pausePlayer, .logUnderrun]) // not flushed yet
        XCTAssertEqual(book.flushed(generation: 1), [.stopPlayer, .emit(clip: "c1", .ended), .closeDecoder(generation: 1)])
    }

    func testStopCutsOnceAndIgnoresItsCompletions() {
        var book = started()
        XCTAssertEqual(book.control(.stop), [.stopPlayer, .emit(clip: "c1", .cut(.stop)), .closeDecoder(generation: 1)])
        XCTAssertEqual(book.control(.stop), [])
        // playerNode.stop() fires the pending completions: the generation token ignores them.
        XCTAssertEqual(book.played(generation: 1, frames: 6000), [])
        XCTAssertEqual(book.played(generation: 1, frames: 6000), [])
        XCTAssertEqual(book.decoded(generation: 1, frames: 6000), [])
        XCTAssertEqual(book.flushed(generation: 1), [])
        XCTAssertEqual(book.play(piece("c1", 1)), ok([])) // in-flight pieces are accepted and dropped
        XCTAssertEqual(book.play(piece("c1", 3)), PieceOutcome(reply: .badArgs, actions: [])) // a gap, but not live: no "failed"
    }

    /// One clip at a time: a new clip's first piece cuts the open one ("next").
    func testASecondClipCutsTheFirst() {
        var book = started()
        XCTAssertEqual(book.play(piece("c2", 0)), ok([
            .stopPlayer, .emit(clip: "c1", .cut(.next)), .closeDecoder(generation: 1),
            .openDecoder(generation: 2, label: .mpeg), .feed(generation: 2),
        ]))
        XCTAssertEqual(book.played(generation: 1, frames: 6000), []) // the old generation
        XCTAssertEqual(book.decoded(generation: 2, frames: 12000), [.schedule(generation: 2), .startPlayer, .emit(clip: "c2", .playing)])
    }

    /// A settled clip is not cut again by the next one.
    func testTheNextClipAfterEndedCutsNothing() {
        var book = ClipBook()
        _ = book.play(piece("c1", 0, last: true))
        _ = book.decoded(generation: 1, frames: 100)
        _ = book.flushed(generation: 1)
        _ = book.played(generation: 1, frames: 100)
        XCTAssertEqual(book.play(piece("c2", 0)), ok([.openDecoder(generation: 2, label: .mpeg), .feed(generation: 2)]))
    }

    /// A gap or a piece after `last` answers badArgs and fails a live clip exactly once.
    func testBadSequenceFailsTheLiveClipOnce() {
        var book = started()
        XCTAssertEqual(book.play(piece("c1", 5)), PieceOutcome(reply: .badArgs, actions: [
            .stopPlayer, .emit(clip: "c1", .failed), .closeDecoder(generation: 1),
        ]))
        XCTAssertEqual(book.play(piece("c1", 6)), PieceOutcome(reply: .badArgs, actions: []))
        XCTAssertEqual(book.play(piece("c1", 1)), PieceOutcome(reply: .badArgs, actions: []))
    }

    func testPieceAfterLastFailsTheLiveClip() {
        var book = started()
        _ = book.play(piece("c1", 1, last: true))
        XCTAssertEqual(book.play(piece("c1", 2)), PieceOutcome(reply: .badArgs, actions: [
            .stopPlayer, .emit(clip: "c1", .failed), .closeDecoder(generation: 1),
        ]))
    }

    /// A parse refusal (bad mime, too big) naming the live clip fails it once.
    func testParseRefusalFailsTheLiveClip() {
        var book = started()
        XCTAssertEqual(book.refused(CallAudioArgRefusal(error: .badArgs, clip: "c1")), [.stopPlayer, .emit(clip: "c1", .failed), .closeDecoder(generation: 1)])
        XCTAssertEqual(book.refused(CallAudioArgRefusal(error: .badArgs, clip: "c1")), [])
        XCTAssertEqual(book.play(piece("c1", 1)), PieceOutcome(reply: .badArgs, actions: []))
        var other = started()
        XCTAssertEqual(other.refused(CallAudioArgRefusal(error: .badArgs, clip: "zz")), [])
        XCTAssertEqual(other.refused(CallAudioArgRefusal(error: .badArgs, clip: nil)), [])
    }

    func testHoldCutsOnceAndDropsPiecesDuringIt() {
        var book = started()
        XCTAssertEqual(book.hold(), [.stopPlayer, .emit(clip: "c1", .cut(.hold)), .closeDecoder(generation: 1)])
        XCTAssertEqual(book.hold(), [])
        XCTAssertEqual(book.play(piece("c1", 1)), ok([]))
        // A new clip during the hold is accepted, dropped, and cut once.
        XCTAssertEqual(book.play(piece("c2", 0)), ok([.emit(clip: "c2", .cut(.hold))]))
        XCTAssertEqual(book.play(piece("c2", 1)), ok([]))
        XCTAssertEqual(book.play(piece("c2", 2, last: true)), ok([]))
        book.endHold()
        XCTAssertEqual(book.play(piece("c3", 0)), ok([.openDecoder(generation: 3, label: .mpeg), .feed(generation: 3)]))
    }

    func testPausedFirstPieceFillsButWaitsForResume() {
        var book = ClipBook()
        _ = book.play(piece("c1", 0, paused: true))
        XCTAssertEqual(book.decoded(generation: 1, frames: 24000), [.schedule(generation: 1)])
        XCTAssertEqual(book.tick(), [])
        XCTAssertEqual(book.control(.resume), [.startPlayer, .emit(clip: "c1", .playing)])
        XCTAssertEqual(book.tick(), [.emit(clip: "c1", .progress)])
    }

    func testPausedFirstPieceResumedBeforeTheThreshold() {
        var book = ClipBook()
        _ = book.play(piece("c1", 0, paused: true))
        XCTAssertEqual(book.control(.resume), [])
        XCTAssertEqual(book.decoded(generation: 1, frames: 12000), [.schedule(generation: 1), .startPlayer, .emit(clip: "c1", .playing)])
    }

    func testPauseAndResumeWhilePlaying() {
        var book = started()
        XCTAssertEqual(book.control(.pause), [.pausePlayer])
        XCTAssertEqual(book.tick(), [])
        XCTAssertEqual(book.control(.pause), [])
        XCTAssertEqual(book.control(.resume), [.startPlayer])
        XCTAssertEqual(book.control(.resume), [])
        XCTAssertEqual(book.tick(), [.emit(clip: "c1", .progress)])
    }

    func testPauseDuringAnUnderrunResumesAtTheThreshold() {
        var book = started()
        _ = book.played(generation: 1, frames: 6000)
        XCTAssertEqual(book.played(generation: 1, frames: 6000), [.pausePlayer, .logUnderrun])
        XCTAssertEqual(book.control(.pause), [])
        XCTAssertEqual(book.control(.resume), [])
        XCTAssertEqual(book.decoded(generation: 1, frames: 12000), [.schedule(generation: 1), .startPlayer])
    }

    func testControlsWithoutAClipDoNothing() {
        var book = ClipBook()
        for action in CallAudioControlAction.allCases { XCTAssertEqual(book.control(action), [], "\(action)") }
        var live = started()
        XCTAssertEqual(live.control(.pulseOn), [])
        XCTAssertEqual(live.control(.pulseOff), [])
    }

    func testCloseSettlesSilently() {
        var book = started()
        XCTAssertEqual(book.close(), [.stopPlayer, .closeDecoder(generation: 1)])
        XCTAssertEqual(book.close(), [])
        XCTAssertEqual(book.played(generation: 1, frames: 6000), [])
        XCTAssertEqual(book.play(piece("c9", 0)), ok([.openDecoder(generation: 2, label: .mpeg), .feed(generation: 2)]))
    }

    func testEventWireShape() {
        XCTAssertEqual(ClipEvent.playing.state, "playing")
        XCTAssertNil(ClipEvent.playing.reason)
        XCTAssertEqual(ClipEvent.cut(.next).state, "cut")
        XCTAssertEqual(ClipEvent.cut(.hold).reason, "hold")
        XCTAssertEqual(ClipEvent.cut(.stop).reason, "stop")
        XCTAssertEqual(ClipEvent.failed.state, "failed")
    }

    // MARK: every order

    /// One clip with three 125 ms buffers, played through every order of the
    /// events a real engine can produce: the decoder's buffers and flush (in
    /// order), the completions (in order, only after the player started and
    /// while not paused, or after a stop), a page pause then resume, a
    /// progress tick, and one of stop, hold or nothing.
    func testEveryOrder() {
        var runs = 0
        for interrupt in [Step.stop, .hold, nil] {
            var steps: [Step] = [.decoded(0), .decoded(1), .decoded(2), .flushed, .pause, .resume, .tick]
            if let interrupt { steps.append(interrupt) }
            explore(Model(), remaining: steps, runs: &runs)
        }
        XCTAssertGreaterThan(runs, 10_000)
        print("ClipBook every order: \(runs) orders")
    }

    private enum Step: Equatable {
        case decoded(Int), flushed, played(Int), pause, resume, tick, stop, hold
    }

    private struct Model {
        var book = ClipBook()
        var events: [ClipEvent] = []
        var scheduled: [Int] = []
        var playedCount = 0
        var playerRunning = false
        var playerStopped = false
        var flushed = false
        var interrupted = false
        var decodedCount = 0
        var pagePaused = false

        init() {
            _ = book.play(CallAudioPlayArgs(clip: "c1", seq: 0, mime: .mpeg, bytes: Data([1]), last: true, paused: false))
        }

        mutating func apply(_ step: Step, file: StaticString = #filePath, line: UInt = #line) {
            let actions: [ClipAction]
            switch step {
            case .decoded:
                decodedCount += 1
                actions = book.decoded(generation: 1, frames: 6000)
            case .flushed: flushed = true; actions = book.flushed(generation: 1)
            case .played: playedCount += 1; actions = book.played(generation: 1, frames: 6000)
            case .pause: pagePaused = true; actions = book.control(.pause)
            case .resume: pagePaused = false; actions = book.control(.resume)
            case .tick: actions = book.tick()
            case .stop: interrupted = true; actions = book.control(.stop)
            case .hold: interrupted = true; actions = book.hold()
            }
            for action in actions {
                switch action {
                case .schedule: scheduled.append(decodedCount - 1)
                case .startPlayer:
                    XCTAssertFalse(playerStopped, "start after stop", file: file, line: line)
                    XCTAssertFalse(pagePaused, "start while the page paused", file: file, line: line)
                    playerRunning = true
                case .pausePlayer: playerRunning = false
                case .stopPlayer: playerRunning = false; playerStopped = true
                case let .emit(clip, event):
                    XCTAssertEqual(clip, "c1", file: file, line: line)
                    if case .cut = event { XCTAssertTrue(step == .stop || step == .hold, "cut from \(step)", file: file, line: line) }
                    events.append(event)
                default: break
                }
            }
        }

        /// Completions come in order: while the player runs, or all at once after a stop.
        var nextCompletion: Step? {
            guard playedCount < scheduled.count, playerRunning || playerStopped else { return nil }
            return .played(playedCount)
        }
    }

    private func explore(_ model: Model, remaining: [Step], runs: inout Int) {
        var choices: [(Step, [Step])] = []
        if let completion = model.nextCompletion { choices.append((completion, remaining)) }
        for (index, step) in remaining.enumerated() {
            if case let .decoded(n) = step, n != model.decodedCount { continue }
            if step == .flushed, model.decodedCount < 3 { continue }
            if step == .resume, remaining.contains(.pause) { continue }
            var rest = remaining
            rest.remove(at: index)
            choices.append((step, rest))
        }
        if choices.isEmpty {
            runs += 1
            check(model)
            return
        }
        for (step, rest) in choices {
            var next = model
            next.apply(step)
            explore(next, remaining: rest, runs: &runs)
        }
    }

    private func check(_ model: Model) {
        let events = model.events
        let terminal = events.filter { if case .progress = $0 { return false }; return $0 != .playing }
        XCTAssertEqual(terminal.count, 1, "exactly one outcome: \(events)")
        XCTAssertEqual(events.last.map { terminal.contains($0) }, true, "nothing after the outcome: \(events)")
        XCTAssertLessThanOrEqual(events.filter { $0 == .playing }.count, 1)
        if let first = events.firstIndex(where: { $0 == .progress || $0 == .ended }) {
            XCTAssertTrue(events[..<first].contains(.playing), "playing first: \(events)")
        }
        if events.contains(.ended) {
            XCTAssertTrue(model.flushed)
            XCTAssertEqual(model.playedCount, model.scheduled.count, "ended with buffers outstanding")
            XCTAssertEqual(model.scheduled.count, 3)
        } else {
            XCTAssertTrue(model.interrupted, "no outcome but ended without a stop or hold: \(events)")
        }
        XCTAssertEqual(model.book.outstanding, model.book.isLive ? model.scheduled.count - model.playedCount : 0)
    }

    // MARK: helpers

    /// A clip with two 125 ms buffers scheduled and playing.
    private func started() -> ClipBook {
        var book = ClipBook()
        _ = book.play(piece("c1", 0))
        _ = book.decoded(generation: 1, frames: 6000)
        _ = book.decoded(generation: 1, frames: 6000)
        return book
    }

    private func piece(_ clip: String, _ seq: Int, last: Bool = false, paused: Bool = false, bytes: Int = 1) -> CallAudioPlayArgs {
        CallAudioPlayArgs(clip: clip, seq: seq, mime: .mpeg, bytes: Data(count: bytes), last: last, paused: paused)
    }

    private func ok(_ actions: [ClipAction]) -> PieceOutcome { PieceOutcome(reply: nil, actions: actions) }
}
