#if os(iOS)
import AVFoundation
import MurageCallAudioCore
@testable import MurageShell
import UIKit
import XCTest

// Spec §6.1, iOS simulator unit bundle: drives the real CallAudioEngine (its
// notification handling, the reducer and clip book it executes, the events
// it emits and the replies it sends) with posted interruption, route-change,
// configuration-change, media-services and app notifications, userInfo
// included. The audio hardware is a fake: sound in the simulator means
// nothing, and the AV setup itself is proven on the phone (spike, and the
// channel self-test on the spike screen). Run with
// `xcodebuild test -scheme MurageShell-Package -destination 'platform=iOS Simulator,…'`.

/// Records what the engine asked of the hardware. Touched on the engine's
/// queue and read by the test after `drain`, which orders the two.
final class FakeCallAudioHardware: CallAudioHardware, @unchecked Sendable {
    var onTap: ((AVAudioPCMBuffer) -> Void)?
    var recordPermission: RecordPermission = .granted
    var permissionAnswer = true
    var calls: [String] = []
    var plans: [StartPlan] = []
    /// Results for the next starts, in order; true once they run out.
    var startResults: [Bool] = []
    /// Runs inside each start (on the engine's queue), after it succeeded.
    var onStart: ((Int) -> Void)?
    var categoryIsOurs = true
    var routeOutput: RouteOutput = .speaker
    var microphoneMode = 0
    let engineObject = NSObject()
    private(set) var running = false
    private var pending: [@Sendable () -> Void] = []
    var scheduled = 0

    func requestPermission(_ answer: @escaping @Sendable (Bool) -> Void) {
        calls.append("requestPermission")
        let granted = permissionAnswer
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { answer(granted) }
    }

    func recordSession() { calls.append("recordSession") }
    func restoreSession() { calls.append("restoreSession") }
    func deactivateSession() { calls.append("deactivateSession") }

    func start(_ plan: StartPlan) -> Bool {
        calls.append("start")
        plans.append(plan)
        let ok = startResults.isEmpty ? true : startResults.removeFirst()
        running = ok
        if ok {
            if plan.applyCategory { categoryIsOurs = true }
            onStart?(plans.count)
        }
        return ok
    }

    func stopEngine() { calls.append("stopEngine"); running = false }
    func teardown() { calls.append("teardown"); running = false; firePending() }
    func discard() { calls.append("discard"); running = false; pending = [] }
    func isEngine(_ id: ObjectIdentifier) -> Bool { id == ObjectIdentifier(engineObject) }

    func scheduleVoice(_ buffer: AVAudioPCMBuffer, played: @escaping @Sendable () -> Void) {
        scheduled += 1
        pending.append(played)
    }

    func playVoice() { calls.append("playVoice") }
    func pauseVoice() { calls.append("pauseVoice") }
    /// Like `AVAudioPlayerNode.stop()`, it fires every pending completion.
    func stopVoice() { calls.append("stopVoice"); firePending() }
    func schedulePulse() { calls.append("schedulePulse") }
    func stopPulse() { calls.append("stopPulse") }
    var idleTimerDisabled = false
    func setIdleTimerDisabled(_ disabled: Bool) {
        idleTimerDisabled = disabled
        calls.append("setIdleTimerDisabled(\(disabled))")
    }

    /// Plays back everything scheduled so far.
    func firePending() {
        let done = pending
        pending = []
        done.forEach { $0() }
    }
}

final class Box<T>: @unchecked Sendable {
    var value: T?
}

final class CallAudioEngineTests: XCTestCase {
    private var hardware: FakeCallAudioHardware!
    private var center: NotificationCenter!
    private var engine: CallAudioEngine!
    private let events = Box<[[String: String]]>()
    /// What the fake page answers for each event (the watchdog's input).
    private let handled = Box<Bool>()

    override func setUp() {
        super.setUp()
        hardware = FakeCallAudioHardware()
        center = NotificationCenter()
        engine = CallAudioEngine(hardware: hardware, center: center)
        events.value = []
        handled.value = true
        let events = self.events, handled = self.handled
        engine.sink = { event, done in
            events.value?.append(event.detail)
            done(handled.value ?? false)
        }
    }

    override func tearDown() {
        engine.close(.controllerClosed)
        drain()
        engine = nil
        super.tearDown()
    }

    // MARK: helpers

    /// Waits `seconds`, then until the engine's queue and its events are through.
    private func drain(after seconds: TimeInterval = 0) {
        if seconds > 0 {
            let waited = expectation(description: "time")
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { waited.fulfill() }
            wait(for: [waited], timeout: seconds + 5)
        }
        let drained = expectation(description: "drain")
        engine.drain { drained.fulfill() }
        wait(for: [drained], timeout: 5)
    }

    private func call(_ body: (@escaping CallAudioEngine.ReplyHandler) -> Void, timeout: TimeInterval = 3) -> CallAudioEngine.Reply? {
        let answer = Box<CallAudioEngine.Reply>()
        let answered = expectation(description: "reply")
        body { reply in
            answer.value = reply
            answered.fulfill()
        }
        wait(for: [answered], timeout: timeout)
        return answer.value
    }

    /// Opens a call and returns its session (after the 0.5 s settle).
    @discardableResult
    private func openCall(file: StaticString = #filePath, line: UInt = #line) -> String {
        let reply = call { engine.open(app: .active, reply: $0) }
        guard case let .opened(session)? = reply else {
            XCTFail("open answered \(String(describing: reply))", file: file, line: line)
            return ""
        }
        drain()
        return session
    }

    private func post(_ name: Notification.Name, object: Any? = nil, _ info: [AnyHashable: Any]? = nil) {
        center.post(name: name, object: object, userInfo: info)
    }

    /// Every event but mic frames and progress, as `type[:state][/reason|output]`.
    private var story: [String] {
        (events.value ?? []).compactMap { detail in
            guard let type = detail["type"], type != "mic", detail["state"] != "progress" else { return nil }
            var text = type
            if let state = detail["state"] { text += ":" + state }
            if let reason = detail["reason"] ?? detail["output"] { text += "/" + reason }
            return text
        }
    }

    private var micFrames: Int { (events.value ?? []).filter { $0["type"] == "mic" }.count }

    /// A 16-bit mono WAV of a 440 Hz sine.
    private static func wav(seconds: Double, rate: Int = 48000) -> Data {
        let count = Int(Double(rate) * seconds)
        var data = Data()
        func u32(_ value: Int) { withUnsafeBytes(of: UInt32(value).littleEndian) { data.append(contentsOf: $0) } }
        func u16(_ value: Int) { withUnsafeBytes(of: UInt16(value).littleEndian) { data.append(contentsOf: $0) } }
        data.append(contentsOf: Array("RIFF".utf8)); u32(36 + count * 2); data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
        data.append(contentsOf: Array("data".utf8)); u32(count * 2)
        for i in 0..<count {
            let sample = Int16(sin(2 * Double.pi * 440 * Double(i) / Double(rate)) * 12000)
            withUnsafeBytes(of: sample.littleEndian) { data.append(contentsOf: $0) }
        }
        return data
    }

    /// Plays a WAV clip in two pieces, as the page does, and checks both replies.
    private func playClip(_ session: String, clip: String = "c1", seconds: Double = 0.5, file: StaticString = #filePath, line: UInt = #line) {
        let bytes = Self.wav(seconds: seconds)
        let split = bytes.count / 2
        for (seq, piece) in [bytes.prefix(split), bytes.suffix(from: split)].enumerated() {
            let args: [String: Any] = ["session": session, "clip": clip, "seq": seq, "mime": "audio/wav",
                                       "bytes": Data(piece).base64EncodedString(), "last": seq == 1]
            let reply = call { engine.play(args: args, reply: $0) }
            guard case .ok? = reply else { return XCTFail("piece \(seq) answered \(String(describing: reply))", file: file, line: line) }
        }
        drain()
    }

    /// One tap buffer of 48 kHz mono Float32.
    private func tap(frames: Int = 4800) {
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 1, interleaved: false)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
        buffer.frameLength = AVAudioFrameCount(frames)
        for i in 0..<frames { buffer.floatChannelData![0][i] = Float(sin(Double(i) * 0.05) * 0.1) }
        hardware.onTap?(buffer)
    }

    private func configurationChange() {
        post(.AVAudioEngineConfigurationChange, object: hardware.engineObject)
    }

    // MARK: open

    func testOpenRidesOutTheConfigurationChangeAfterStart() {
        // §4.2.2 step 8: voice processing posts a change ~0.1 s after every start.
        let center = self.center!, object = hardware.engineObject
        hardware.onStart = { starts in
            if starts == 1 { center.post(name: .AVAudioEngineConfigurationChange, object: object) }
        }
        let session = openCall()
        XCTAssertFalse(session.isEmpty)
        XCTAssertEqual(hardware.plans, [StartPlan(applyCategory: true, rebuild: .engine), StartPlan(applyCategory: false, rebuild: .nodesAndTap)])
        XCTAssertEqual(Array(hardware.calls.prefix(2)), ["recordSession", "start"])
        XCTAssertEqual(story, [], "no hold or resume while opening")
        // The mic runs once the open has answered.
        for _ in 0..<3 { tap() }
        drain()
        XCTAssertGreaterThan(micFrames, 0)
        XCTAssertTrue((events.value ?? []).allSatisfy { $0["session"] == session })
    }

    func testOpenDeniedAndInactive() {
        hardware.recordPermission = .denied
        guard case .error("denied")? = call({ engine.open(app: .active, reply: $0) }) else { return XCTFail("denied") }
        hardware.recordPermission = .granted
        guard case .error("inactive")? = call({ engine.open(app: .background, reply: $0) }) else { return XCTFail("inactive") }
        XCTAssertEqual(hardware.calls, [], "nothing touched")
    }

    /// Ruling 2 / M1: an open while inactive is held until didBecomeActive.
    func testOpenWhileInactiveWaitsForBecomingActive() {
        let center = self.center!
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { center.post(name: UIApplication.didBecomeActiveNotification, object: nil) }
        guard case .opened? = call({ engine.open(app: .inactive, reply: $0) }) else { return XCTFail("opened") }
        XCTAssertEqual(Array(hardware.calls.prefix(2)), ["recordSession", "start"])
    }

    func testOpenWhileInactiveAnswersInactiveAfterTwoSeconds() {
        guard case .error("inactive")? = call({ engine.open(app: .inactive, reply: $0) }, timeout: 4) else { return XCTFail("inactive") }
        XCTAssertEqual(hardware.calls, [], "nothing touched")
    }

    func testOpenAsksForPermissionOnce() {
        hardware.recordPermission = .undetermined
        let reply = call { engine.open(app: .active, reply: $0) }
        guard case .opened? = reply else { return XCTFail("open answered \(String(describing: reply))") }
        XCTAssertEqual(hardware.calls.first, "requestPermission")
    }

    func testFailedOpenRestoresTheSessionBeforeAnswering() {
        hardware.startResults = [false]
        guard case .error("unavailable")? = call({ engine.open(app: .active, reply: $0) }) else { return XCTFail("unavailable") }
        XCTAssertEqual(hardware.calls, ["recordSession", "start", "teardown", "setIdleTimerDisabled(false)", "restoreSession", "deactivateSession"])
    }

    // MARK: holds

    func testInterruptionHoldsThenResumes() {
        let session = openCall()
        post(AVAudioSession.interruptionNotification, [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue])
        drain()
        XCTAssertEqual(story, ["hold/interrupted"])
        XCTAssertTrue(hardware.calls.contains("stopEngine"), "the microphone turns off")
        // The mic sends nothing while held.
        let before = micFrames
        for _ in 0..<3 { tap() }
        drain()
        XCTAssertEqual(micFrames, before)

        post(AVAudioSession.interruptionNotification, [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue,
                                                     AVAudioSessionInterruptionOptionKey: AVAudioSession.InterruptionOptions.shouldResume.rawValue])
        drain(after: 0.7)
        XCTAssertEqual(story, ["hold/interrupted", "resume"])
        XCTAssertEqual(hardware.plans.last?.rebuild, .nodesAndTap, "the tap is reinstalled after a hold")
        XCTAssertTrue((events.value ?? []).allSatisfy { $0["session"] == session })
    }

    /// I2: declined from the banner, the app never resigned active.
    func testInterruptionEndedWithoutShouldResumeResumesWhileActive() {
        openCall()
        post(AVAudioSession.interruptionNotification, [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue])
        post(AVAudioSession.interruptionNotification, [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue])
        drain(after: 0.7)
        XCTAssertEqual(story, ["hold/interrupted", "resume"])
    }

    func testInterruptionEndedWithoutShouldResumeWaitsWhileInactive() {
        openCall()
        post(UIApplication.willResignActiveNotification)
        post(AVAudioSession.interruptionNotification, [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue])
        post(AVAudioSession.interruptionNotification, [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue])
        drain(after: 0.7)
        XCTAssertEqual(story, ["hold/interrupted"])
        post(UIApplication.didBecomeActiveNotification)
        drain(after: 0.7)
        XCTAssertEqual(story, ["hold/interrupted", "resume"])
    }

    /// I2: a `.began` with reason `.appWasSuspended` (1) or the older key is ignored.
    func testASuspendedBeganIsIgnored() {
        openCall()
        let began = AVAudioSession.InterruptionType.began.rawValue
        post(AVAudioSession.interruptionNotification, [AVAudioSessionInterruptionTypeKey: began, AVAudioSessionInterruptionReasonKey: UInt(1)])
        post(AVAudioSession.interruptionNotification, [AVAudioSessionInterruptionTypeKey: began, "AVAudioSessionInterruptionWasSuspendedKey": true])
        drain()
        XCTAssertEqual(story, [])
        XCTAssertFalse(hardware.calls.contains("stopEngine"))
    }

    func testBackgroundHoldsAndBecomingActiveResumes() {
        openCall()
        post(UIApplication.didEnterBackgroundNotification)
        drain(after: 0.7)
        XCTAssertEqual(story, ["hold/background"])
        post(UIApplication.didBecomeActiveNotification)
        drain(after: 0.7)
        XCTAssertEqual(story, ["hold/background", "resume"])
    }

    func testBecomingActiveClearsAnInterruptionThatNeverEnded() {
        openCall()
        post(AVAudioSession.interruptionNotification, [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue])
        post(UIApplication.didBecomeActiveNotification)
        drain(after: 0.7)
        XCTAssertEqual(story, ["hold/interrupted", "resume"])
    }

    func testConfigurationChangeSendsHoldBeforeTheCutThenResumes() {
        let session = openCall()
        playClip(session)
        XCTAssertEqual(story, ["clip:playing"])
        configurationChange()
        drain()
        XCTAssertEqual(story, ["clip:playing", "hold/media-reset", "clip:cut/hold"], "hold is sent before the cut")
        XCTAssertEqual(hardware.plans.last, StartPlan(applyCategory: false, rebuild: .nodesAndTap))
        drain(after: 0.7)
        XCTAssertEqual(story, ["clip:playing", "hold/media-reset", "clip:cut/hold", "resume"])
    }

    func testRouteChangeSendsTheRouteOnly() {
        let session = openCall()
        hardware.routeOutput = .bluetooth
        post(AVAudioSession.routeChangeNotification, [AVAudioSessionRouteChangeReasonKey: AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue])
        // Our own setCategory also posts .categoryChange, with the category still ours.
        post(AVAudioSession.routeChangeNotification, [AVAudioSessionRouteChangeReasonKey: AVAudioSession.RouteChangeReason.categoryChange.rawValue])
        drain(after: 0.7)
        XCTAssertEqual(story, ["route/bluetooth", "route/bluetooth"])
        XCTAssertEqual(events.value?.first?["session"], session)
    }

    func testCategoryLostIsReasserted() {
        openCall()
        let starts = hardware.plans.count
        hardware.categoryIsOurs = false
        post(AVAudioSession.routeChangeNotification, [AVAudioSessionRouteChangeReasonKey: AVAudioSession.RouteChangeReason.categoryChange.rawValue])
        drain(after: 0.7)
        XCTAssertEqual(story, ["hold/media-reset", "route/speaker", "resume"])
        XCTAssertEqual(hardware.plans.count, starts + 1)
        XCTAssertEqual(hardware.plans.last?.applyCategory, true)
    }

    func testMediaServicesResetRebuildsEverything() {
        openCall()
        post(AVAudioSession.mediaServicesWereLostNotification)
        drain()
        XCTAssertEqual(story, ["hold/media-reset"])
        XCTAssertTrue(hardware.calls.contains("discard"))
        post(AVAudioSession.mediaServicesWereResetNotification)
        drain(after: 0.7)
        XCTAssertEqual(story, ["hold/media-reset", "resume"])
        XCTAssertEqual(hardware.plans.last, StartPlan(applyCategory: true, rebuild: .engine))
    }

    func testRestartThatFailsTwiceIsLost() {
        let session = openCall()
        hardware.startResults = [false, false]
        configurationChange()
        drain(after: 0.8)
        XCTAssertEqual(story, ["hold/media-reset", "lost/restart-failed"])
        XCTAssertEqual(Array(hardware.calls.suffix(4)), ["teardown", "setIdleTimerDisabled(false)", "restoreSession", "deactivateSession"])
        let args: [String: Any] = ["session": session, "action": "pulseOn"]
        guard case .error("unavailable")? = call({ engine.control(args: args, reply: $0) }) else { return XCTFail("lost session") }
    }

    // MARK: clips and the pulse

    func testClipPlaysToTheEnd() {
        let session = openCall()
        playClip(session)
        XCTAssertEqual(story, ["clip:playing"])
        XCTAssertTrue(hardware.calls.contains("playVoice"))
        XCTAssertGreaterThan(hardware.scheduled, 0)
        hardware.firePending()
        drain()
        XCTAssertEqual(story, ["clip:playing", "clip:ended"])
    }

    func testClipStopIsCutOnce() {
        let session = openCall()
        playClip(session, seconds: 1)
        guard case .ok? = call({ engine.control(args: ["session": session, "action": "stop"], reply: $0) }) else { return XCTFail("stop") }
        drain()
        XCTAssertEqual(story, ["clip:playing", "clip:cut/stop"], "the completions a stop fires are ignored")
    }

    func testBadPiecesAreRefused() {
        let session = openCall()
        let unknown: [String: Any] = ["session": "nope", "clip": "c", "seq": 0, "mime": "audio/wav", "bytes": "", "last": true]
        guard case .error("bad_args")? = call({ engine.play(args: unknown, reply: $0) }) else { return XCTFail("unknown session") }
        let gap: [String: Any] = ["session": session, "clip": "c", "seq": 3, "mime": "audio/wav", "bytes": "", "last": true]
        guard case .error("bad_args")? = call({ engine.play(args: gap, reply: $0) }) else { return XCTFail("gap") }
    }

    func testPulseFollowsTheHold() {
        let session = openCall()
        guard case .ok? = call({ engine.control(args: ["session": session, "action": "pulseOn"], reply: $0) }) else { return XCTFail("pulseOn") }
        drain(after: 0.2)
        XCTAssertTrue(hardware.calls.contains("schedulePulse"))
        post(UIApplication.didEnterBackgroundNotification)
        drain()
        XCTAssertTrue(hardware.calls.contains("stopPulse"))
        let ticks = hardware.calls.filter { $0 == "schedulePulse" }.count
        drain(after: 1.1)
        XCTAssertEqual(hardware.calls.filter { $0 == "schedulePulse" }.count, ticks, "no ticks while held")
        post(UIApplication.didBecomeActiveNotification)
        drain(after: 0.8)
        XCTAssertGreaterThan(hardware.calls.filter { $0 == "schedulePulse" }.count, ticks, "back after the resume")
    }

    // MARK: closing

    func testCloseRestoresTheSessionAndIsIdempotent() {
        let session = openCall()
        guard case .ok? = call({ engine.close(args: ["session": session], reply: $0) }) else { return XCTFail("close") }
        guard case .ok? = call({ engine.close(args: ["session": session], reply: $0) }) else { return XCTFail("close twice") }
        XCTAssertEqual(Array(hardware.calls.suffix(4)), ["teardown", "setIdleTimerDisabled(false)", "restoreSession", "deactivateSession"])
        XCTAssertEqual(hardware.calls.filter { $0 == "restoreSession" }.count, 1)
    }

    func testNavigationCommitCloses() {
        openCall()
        engine.close(.navigationCommitted)
        drain()
        XCTAssertEqual(Array(hardware.calls.suffix(4)), ["teardown", "setIdleTimerDisabled(false)", "restoreSession", "deactivateSession"])
    }

    func testWatchdogClosesAnUnheardCall() {
        openCall()
        handled.value = false
        // 4800 frames at 48 kHz is 1.56 mic frames: 25 taps make 39.
        for _ in 0..<25 {
            tap()
            drain()
        }
        drain()
        XCTAssertEqual(Array(hardware.calls.suffix(4)), ["teardown", "setIdleTimerDisabled(false)", "restoreSession", "deactivateSession"])
        // moss-approval-bug.md: the watchdog used to close with nothing
        // telling the page, leaving a live-looking call screen over a dead
        // session. It now sends `lost` first, like every other lost path.
        XCTAssertTrue(story.contains("lost/unheard"), "story was \(story)")
        let frames = micFrames
        XCTAssertGreaterThanOrEqual(frames, CallAudioState.unheardLimit)
        tap()
        drain()
        XCTAssertEqual(micFrames, frames, "no mic after the watchdog closed")
    }

    // MARK: idle timer

    /// A hands-free call must not let auto-lock pause it. Disabled once the
    /// open really lands (not on the request), re-enabled once the session
    /// actually tears down — close, lost or a navigation commit all route
    /// through the same `.teardownEngine` action. Read back from the fake
    /// hardware's own recorded calls, not `UIApplication.shared`: an SPM
    /// test bundle may have no host app, so a direct read may not reflect
    /// the write, and the global carries over between tests
    /// (callbar-review.md I7).
    func testIdleTimerDisabledWhileOpenAndReenabledOnClose() {
        XCTAssertFalse(hardware.idleTimerDisabled)
        let session = openCall()
        XCTAssertFalse(session.isEmpty)
        XCTAssertTrue(hardware.idleTimerDisabled)
        XCTAssertEqual(hardware.calls.last, "setIdleTimerDisabled(true)")
        guard case .ok? = call({ engine.close(args: ["session": session], reply: $0) }) else { return XCTFail("close") }
        XCTAssertFalse(hardware.idleTimerDisabled)
        XCTAssertEqual(Array(hardware.calls.suffix(4)), ["teardown", "setIdleTimerDisabled(false)", "restoreSession", "deactivateSession"])
    }

    func testIdleTimerReenabledWhenTheWatchdogClosesAnUnheardCall() {
        openCall()
        XCTAssertTrue(hardware.idleTimerDisabled)
        handled.value = false
        for _ in 0..<25 {
            tap()
            drain()
        }
        drain()
        XCTAssertFalse(hardware.idleTimerDisabled)
    }

    func testIdleTimerReenabledOnNavigationCommit() {
        openCall()
        XCTAssertTrue(hardware.idleTimerDisabled)
        engine.close(.navigationCommitted)
        drain()
        XCTAssertFalse(hardware.idleTimerDisabled)
    }
}
#endif
