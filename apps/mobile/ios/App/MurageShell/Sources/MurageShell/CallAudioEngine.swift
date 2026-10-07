#if os(iOS)
import AVFoundation
import MurageCallAudioCore
import UIKit

/// The two loudness levers of native call audio, in one place (spec §4.2.2
/// step 5, §6.0). Sean is still comparing loudness on the phone; the
/// controller sets these from that.
enum CallAudioTuning {
    /// The session mode. The spike's fallbacks were `.default` (voice
    /// processing stays on) and `.videoChat`.
    static let mode: AVAudioSession.Mode = .voiceChat
    /// The shared `AVAudioUnitEQ.globalGain` in front of the peak limiter,
    /// for the voice and the pulse alike. +12 dB leaked echo in the spike.
    static let voiceGainDb: Float = 0
}

// MARK: - The hardware

/// What `CallAudioEngine` asks of the audio hardware. `CallAudioDevice` is
/// the real one; the simulator unit tests pass a fake, so the engine's own
/// lifecycle (notifications, the reducer, the clip book, the events) is what
/// they drive. Every member is called on the engine's queue, except that
/// `onTap` is called from the render thread.
protocol CallAudioHardware: AnyObject {
    /// Set once by the engine, before anything starts. It gets a copy of each
    /// tap buffer that outlives the tap block.
    var onTap: ((AVAudioPCMBuffer) -> Void)? { get set }
    var recordPermission: RecordPermission { get }
    /// The answer arrives on any queue.
    func requestPermission(_ answer: @escaping @Sendable (Bool) -> Void)
    func recordSession()
    func restoreSession()
    func deactivateSession()
    /// Runs a `StartPlan` (see MurageCallAudioCore `StartPlan`). False when anything threw.
    func start(_ plan: StartPlan) -> Bool
    func stopEngine()
    func teardown()
    /// Media services were lost or reset: drop every AV object without calling into it.
    func discard()
    /// Whether an `AVAudioEngineConfigurationChange` came from the engine in use.
    func isEngine(_ id: ObjectIdentifier) -> Bool
    /// `.playAndRecord` with `CallAudioTuning.mode` (spec §4.2.5).
    var categoryIsOurs: Bool { get }
    var routeOutput: RouteOutput { get }
    /// `AVCaptureDevice.activeMicrophoneMode`, for the open's log line.
    var microphoneMode: Int { get }
    /// Schedules a voice buffer; `played` runs on any thread when it has
    /// played back, or when a stop drops it.
    func scheduleVoice(_ buffer: AVAudioPCMBuffer, played: @escaping @Sendable () -> Void)
    func playVoice()
    func pauseVoice()
    func stopVoice()
    /// Schedules one working tick on the pulse node.
    func schedulePulse()
    func stopPulse()
    /// Keeps the phone from auto-locking during a hands-free call: true on
    /// the open replying `.opened`, false on every teardown (close, lost,
    /// the watchdog, a navigation commit). `CallAudioDevice` is the only
    /// caller of `UIApplication.shared` for this — kept behind the seam so
    /// `FakeCallAudioHardware` can record it like `teardown`/`restoreSession`
    /// instead of a test reading the UIApplication global directly
    /// (callbar-review.md I7).
    func setIdleTimerDisabled(_ disabled: Bool)
}

private enum CallAudioDeviceError: Error {
    case noEngine
    /// The input read 0 Hz or 0 channels, mid-reconfiguration: a tap in that
    /// format crashes (spike finding 1).
    case invalidInput
}

/// The real hardware: AVAudioSession and one AVAudioEngine with voice
/// processing (spec §4.2.2). Engine-setup code lifted from the §6.0 spike,
/// which proved it on Sean's iPhone; the mic conversion is not here but in
/// the engine (`MicResampler`).
final class CallAudioDevice: CallAudioHardware {
    private static let playFormat = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
    /// `.allowBluetoothHFP` is the iOS 26 SDK name of `.allowBluetooth` (same
    /// raw value); it compiles at the iOS 17 deployment target.
    private static let options: AVAudioSession.CategoryOptions = [.defaultToSpeaker, .allowBluetoothHFP, .allowBluetoothA2DP]

    private struct Recorded {
        let category: AVAudioSession.Category
        let mode: AVAudioSession.Mode
        let options: AVAudioSession.CategoryOptions
    }

    var onTap: ((AVAudioPCMBuffer) -> Void)?
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var pulse: AVAudioPlayerNode?
    private var chain: [AVAudioNode] = []
    private var recorded: Recorded?
    private lazy var pulseBuffer = CallAudioPulse.make(format: Self.playFormat)

    var recordPermission: RecordPermission {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .granted
        case .denied: return .denied
        default: return .undetermined
        }
    }

    func requestPermission(_ answer: @escaping @Sendable (Bool) -> Void) {
        AVAudioApplication.requestRecordPermission { answer($0) }
    }

    func recordSession() {
        let session = AVAudioSession.sharedInstance()
        recorded = Recorded(category: session.category, mode: session.mode, options: session.categoryOptions)
    }

    func restoreSession() {
        guard let recorded else { return }
        self.recorded = nil
        do {
            try AVAudioSession.sharedInstance().setCategory(recorded.category, mode: recorded.mode, options: recorded.options)
        } catch {
            ShellLog.event("call audio session restore failed", status: (error as NSError).code)
        }
    }

    func deactivateSession() {
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            ShellLog.event("call audio session deactivate failed", status: (error as NSError).code)
        }
    }

    func start(_ plan: StartPlan) -> Bool {
        let session = AVAudioSession.sharedInstance()
        let began = Date()
        defer { ShellLog.timing("call audio start", ms: ms(since: began)) }
        do {
            // §4.2.2 step 1.
            if plan.applyCategory {
                try session.setCategory(.playAndRecord, mode: CallAudioTuning.mode, options: Self.options)
            }
            try session.setActive(true)
            if let engine, engine.isRunning { engine.stop() }
            if plan.rebuild == .engine || engine == nil {
                try build()
            } else {
                // §4.2.2 step 8: after a configuration change the old nodes
                // never play a scheduled buffer again.
                rebuildNodes()
                if plan.rebuild == .nodesAndTap { try installTap() }
            }
            guard let engine else { throw CallAudioDeviceError.noEngine }
            // Step 7. The voice player stays stopped until a clip is ready.
            engine.prepare()
            try engine.start()
            return true
        } catch {
            ShellLog.event("call audio start failed", status: (error as NSError).code)
            return false
        }
    }

    /// §4.2.2 steps 2 to 6.
    private func build() throws {
        teardown()
        let engine = AVAudioEngine()
        self.engine = engine
        try engine.inputNode.setVoiceProcessingEnabled(true)
        engine.inputNode.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
        attachChain(engine)
        try installTap()
    }

    /// Remakes the mixer-to-output connection (made at the old hardware
    /// format) and the whole playback chain with fresh nodes.
    private func rebuildNodes() {
        guard let engine else { return }
        engine.disconnectNodeOutput(engine.mainMixerNode)
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: nil)
        attachChain(engine)
    }

    /// Step 5: the voice player and the pulse feed one submixer, then one
    /// shared EQ (the loudness constant) and one peak limiter, into the main
    /// mixer, all at a fixed 48 kHz mono, so a route change never forces a
    /// decoder rebuild and the voice and the pulse sit at the same loudness.
    private func attachChain(_ engine: AVAudioEngine) {
        player?.stop()
        pulse?.stop()
        for node in chain { engine.detach(node) }
        let player = AVAudioPlayerNode()
        let pulse = AVAudioPlayerNode()
        let mixer = AVAudioMixerNode()
        let eq = AVAudioUnitEQ(numberOfBands: 0)
        eq.globalGain = CallAudioTuning.voiceGainDb
        let limiter = AVAudioUnitEffect(audioComponentDescription: AudioComponentDescription(
            componentType: kAudioUnitType_Effect, componentSubType: kAudioUnitSubType_PeakLimiter,
            componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0))
        let nodes: [AVAudioNode] = [player, pulse, mixer, eq, limiter]
        nodes.forEach(engine.attach)
        engine.connect(player, to: mixer, format: Self.playFormat)
        engine.connect(pulse, to: mixer, format: Self.playFormat)
        engine.connect(mixer, to: eq, format: Self.playFormat)
        engine.connect(eq, to: limiter, format: Self.playFormat)
        engine.connect(limiter, to: engine.mainMixerNode, format: Self.playFormat)
        chain = nodes
        self.player = player
        self.pulse = pulse
    }

    /// Step 6, with the format read now (after voice processing is on).
    private func installTap() throws {
        guard let engine else { throw CallAudioDeviceError.noEngine }
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw CallAudioDeviceError.invalidInput }
        let sink = onTap
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
            // The buffer is valid only during this call: copy, then hop (§4.2.1).
            guard let sink, let copy = Self.copy(buffer) else { return }
            sink(copy)
        }
    }

    func stopEngine() {
        engine?.stop()
    }

    func teardown() {
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            player?.stop()
            pulse?.stop()
            engine.stop()
        }
        discard()
    }

    func discard() {
        engine = nil
        player = nil
        pulse = nil
        chain = []
    }

    func isEngine(_ id: ObjectIdentifier) -> Bool {
        engine.map { ObjectIdentifier($0) == id } ?? false
    }

    var categoryIsOurs: Bool {
        let session = AVAudioSession.sharedInstance()
        return session.category == .playAndRecord && session.mode == CallAudioTuning.mode
    }

    var routeOutput: RouteOutput {
        switch AVAudioSession.sharedInstance().currentRoute.outputs.first?.portType {
        case .builtInSpeaker?: return .speaker
        case .builtInReceiver?: return .receiver
        case .headphones?, .usbAudio?: return .headphones
        case .bluetoothHFP?, .bluetoothA2DP?, .bluetoothLE?: return .bluetooth
        default: return .other
        }
    }

    var microphoneMode: Int { AVCaptureDevice.activeMicrophoneMode.rawValue }

    func scheduleVoice(_ buffer: AVAudioPCMBuffer, played: @escaping @Sendable () -> Void) {
        guard let player else { return }
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in played() }
    }

    /// `play()` on a stopped engine raises, so only while it runs.
    func playVoice() {
        guard let engine, engine.isRunning, let player else { return }
        player.play()
    }

    func pauseVoice() {
        player?.pause()
    }

    func stopVoice() {
        player?.stop()
    }

    func schedulePulse() {
        guard let engine, engine.isRunning, let pulse, let pulseBuffer else { return }
        pulse.scheduleBuffer(pulseBuffer, completionHandler: nil)
        if !pulse.isPlaying { pulse.play() }
    }

    func stopPulse() {
        pulse?.stop()
    }

    /// `UIApplication.isIdleTimerDisabled` must be touched on the main
    /// actor; this runs on the call-audio queue, so hop over. Not routed
    /// through the engine's `outbox`: it has no ordering dependency on
    /// replies or emitted events, and the watchdog's teardown must not
    /// wait behind those to release the timer.
    func setIdleTimerDisabled(_ disabled: Bool) {
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                UIApplication.shared.isIdleTimerDisabled = disabled
            }
        }
    }

    private static func copy(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else { return nil }
        copy.frameLength = buffer.frameLength
        let from = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: buffer.audioBufferList))
        let to = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for (source, target) in zip(from, to) {
            guard let s = source.mData, let d = target.mData else { continue }
            memcpy(d, s, Int(min(source.mDataByteSize, target.mDataByteSize)))
        }
        return copy
    }
}

/// Spec §4.2.4: the working tick, the same two-part blip as
/// src/lib/working-pulse.ts: 620 Hz at 0.07 then 740 Hz at 0.045, 110 ms
/// apart, each falling to 0.82 of its pitch over 120 ms, through a 1.8 kHz
/// low-pass. Made once; the engine schedules it every 950 ms.
enum CallAudioPulse {
    static let interval: DispatchTimeInterval = .milliseconds(950)

    static func make(format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let rate = format.sampleRate
        let length = Int(rate * 0.33)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(length)),
              let out = buffer.floatChannelData?[0] else { return nil }
        buffer.frameLength = AVAudioFrameCount(length)
        for i in 0..<length { out[i] = 0 }
        func blip(at start: Double, freq: Double, peak: Double) {
            // RBJ low-pass, 1.8 kHz, Q from Web Audio's default 1 dB.
            let q = pow(10, 1.0 / 20), w = 2 * Double.pi * 1800 / rate, alpha = sin(w) / (2 * q)
            let a0 = 1 + alpha
            let b0 = (1 - cos(w)) / 2 / a0, b1 = (1 - cos(w)) / a0, b2 = b0
            let a1 = -2 * cos(w) / a0, a2 = (1 - alpha) / a0
            var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0, phase = 0.0
            let first = Int(start * rate), count = Int(0.2 * rate)
            for n in 0..<count where first + n < length {
                let t = Double(n) / rate
                let f = t < 0.12 ? freq * pow(0.82, t / 0.12) : freq * 0.82
                phase += 2 * Double.pi * f / rate
                let x = sin(phase)
                let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
                x2 = x1; x1 = x; y2 = y1; y1 = y
                let gain: Double
                if t < 0.012 { gain = 0.0001 * pow(peak / 0.0001, t / 0.012) }
                else if t < 0.16 { gain = peak * pow(0.0001 / peak, (t - 0.012) / 0.148) }
                else { gain = 0.0001 }
                out[first + n] += Float(y * gain)
            }
        }
        blip(at: 0.01, freq: 620, peak: 0.07)
        blip(at: 0.12, freq: 740, peak: 0.045)
        return buffer
    }
}

extension CallAudioAppState {
    init(_ state: UIApplication.State) {
        switch state {
        case .active: self = .active
        case .inactive: self = .inactive
        default: self = .background
        }
    }
}

// MARK: - The engine

/// Spec §4.2: native call audio for one workspace screen. A dumb executor:
/// every notification, channel call and engine result goes into
/// `CallAudioState` (the lifecycle) or `ClipBook` (the clip), and this does
/// what they answer, in order, on one serial queue (§4.2.1). Only finished
/// string dictionaries and replies cross to the main actor, all the events
/// of one queue block in one ordered hop.
///
/// Long-lived callbacks (observers, the tap, timers, completions) capture it
/// weakly; the view controller owns it. The close entry point alone keeps it
/// alive until its block has run, so a close from `deinit` still restores
/// the session.
final class CallAudioEngine: @unchecked Sendable {
    /// A `callAudio` event detail (spec §4.1): every value is a string.
    struct Event: Sendable {
        let detail: [String: String]
        /// A mic frame: whether the page handled it feeds the watchdog.
        let isMic: Bool
    }

    enum Reply: Sendable {
        case ok
        /// `{ session, sampleRate: 16000, frame: 1024 }`.
        case opened(session: String)
        /// A channel error code (`bad_args`, `unavailable`, `denied`, `inactive`).
        case error(String)
    }

    typealias ReplyHandler = @MainActor @Sendable (Reply) -> Void
    /// Emits one event to the page; `done` gets whether a listener handled it.
    typealias Sink = @MainActor (Event, @escaping (Bool) -> Void) -> Void

    /// Channel arguments, handed to the queue unparsed.
    private struct Args: @unchecked Sendable {
        let value: [String: Any]
    }

    private enum Outgoing: Sendable {
        case event(Event)
        case reply(ReplyHandler, Reply)
    }

    /// Main actor only: set before the first channel call.
    var sink: Sink?

    private let queue = DispatchQueue(label: "call-audio")
    private let hardware: CallAudioHardware
    private let center: NotificationCenter
    private var observers: [NSObjectProtocol] = []

    // Queue only, from here on.
    private var state = CallAudioState()
    private var book = ClipBook()
    private var decoders: [UInt64: StreamDecoder] = [:]
    private var resampler: MicResampler?
    private var framer = MicFramer()
    private var openReplies: [Int: ReplyHandler] = [:]
    private var lastRequest = 0
    private var outbox: [Outgoing] = []
    /// The session the current reducer batch's events belong to: a close or
    /// `lost` ends the session inside `reduce`, before its cut is emitted.
    private var batchSession: String?
    private var micModeLogged: String?
    private var ticker: DispatchSourceTimer?
    private var pulseTimer: DispatchSourceTimer?

    init(hardware: CallAudioHardware = CallAudioDevice(), center: NotificationCenter = .default) {
        self.hardware = hardware
        self.center = center
        hardware.onTap = { [weak self] buffer in
            self?.queue.async { self?.tapped(buffer) }
        }
        observe()
    }

    deinit {
        observers.forEach(center.removeObserver)
        ticker?.cancel()
        pulseTimer?.cancel()
    }

    // MARK: channel (main actor in, main actor out)

    /// `callAudioOpen`. `app` is `applicationState`, read on the main actor
    /// when the call arrived, so it is on the queue before any later app
    /// notification.
    func open(app: CallAudioAppState, reply: @escaping ReplyHandler) {
        queue.async { [weak self] in
            guard let self else { Task { @MainActor in reply(.error("unavailable")) }; return }
            self.lastRequest += 1
            let request = self.lastRequest
            self.openReplies[request] = reply
            self.send(.openRequested(request: request, session: UUID().uuidString,
                                     permission: self.hardware.recordPermission, app: app))
            self.flush()
        }
    }

    /// `callAudioClose({ session })`: always `true` once it parses.
    func close(args: [String: Any], reply: @escaping ReplyHandler) {
        let args = Args(value: args)
        queue.async { [self] in
            switch CallAudioCloseArgs.parse(args.value) {
            case let .failure(error): outbox.append(.reply(reply, .error(error.rawValue)))
            case let .success(close):
                send(.closeRequested(session: close.session))
                outbox.append(.reply(reply, .ok))
            }
            flush()
        }
    }

    /// `callAudioPlay`: one piece of a clip (spec §4.1).
    func play(args: [String: Any], reply: @escaping ReplyHandler) {
        let args = Args(value: args)
        queue.async { [weak self] in
            guard let self else { Task { @MainActor in reply(.error("unavailable")) }; return }
            switch CallAudioPlayArgs.parse(args.value, sessions: self.state.sessions) {
            case let .failure(refusal):
                self.runClip(self.book.refused(refusal))
                self.outbox.append(.reply(reply, .error(refusal.error.rawValue)))
            case let .success(piece):
                let outcome = self.book.play(piece)
                self.runClip(outcome.actions, piece: piece)
                self.outbox.append(.reply(reply, outcome.reply.map { .error($0.rawValue) } ?? .ok))
            }
            self.flush()
        }
    }

    /// `callAudioControl`: the clip's pause, resume and stop, and the pulse.
    func control(args: [String: Any], reply: @escaping ReplyHandler) {
        let args = Args(value: args)
        queue.async { [weak self] in
            guard let self else { Task { @MainActor in reply(.error("unavailable")) }; return }
            switch CallAudioControlArgs.parse(args.value, sessions: self.state.sessions) {
            case let .failure(error):
                self.outbox.append(.reply(reply, .error(error.rawValue)))
            case let .success(control):
                switch control.action {
                case .pulseOn: self.send(.pulse(on: true))
                case .pulseOff: self.send(.pulse(on: false))
                case .pause, .resume, .stop: self.runClip(self.book.control(control.action))
                }
                self.outbox.append(.reply(reply, .ok))
            }
            self.flush()
        }
    }

    /// The other close paths (spec §4.2.7). Strong on purpose: see the type's note.
    func close(_ cause: CloseCause) {
        queue.async { [self] in
            send(.closed(cause))
            flush()
        }
    }

    // MARK: notifications (any thread in, queue after)

    private func observe() {
        let center = self.center
        func on(_ name: Notification.Name, _ handle: @escaping @Sendable (CallAudioEngine, Notification) -> Void) {
            observers.append(center.addObserver(forName: name, object: nil, queue: nil) { [weak self] note in
                guard let self else { return }
                let note = NoteBox(note)
                self.queue.async { [weak self] in
                    guard let self else { return }
                    handle(self, note.value)
                    self.flush()
                }
            })
        }
        on(AVAudioSession.interruptionNotification) { engine, note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            switch type {
            case .began:
                engine.send(.interruptionBegan(wasSuspended: Self.wasSuspended(note.userInfo)))
            case .ended:
                let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt).map(AVAudioSession.InterruptionOptions.init) ?? []
                engine.send(.interruptionEnded(shouldResume: options.contains(.shouldResume)))
            @unknown default:
                break
            }
        }
        on(AVAudioSession.routeChangeNotification) { engine, note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init)
            // §4.2.5: our own setCategory posts .categoryChange too, but
            // leaves the category and mode right.
            if reason == .categoryChange, !engine.hardware.categoryIsOurs { engine.send(.categoryLost) }
            engine.send(.routeChanged(engine.hardware.routeOutput))
        }
        on(.AVAudioEngineConfigurationChange) { engine, note in
            guard let object = note.object as AnyObject?, engine.hardware.isEngine(ObjectIdentifier(object)) else { return }
            engine.send(.configurationChanged)
        }
        on(AVAudioSession.mediaServicesWereLostNotification) { engine, _ in
            engine.mediaServicesGone()
            engine.send(.mediaServicesLost)
        }
        on(AVAudioSession.mediaServicesWereResetNotification) { engine, _ in
            engine.mediaServicesGone()
            engine.send(.mediaServicesReset)
        }
        on(UIApplication.willResignActiveNotification) { engine, _ in engine.send(.willResignActive) }
        on(UIApplication.didEnterBackgroundNotification) { engine, _ in engine.send(.didEnterBackground) }
        on(UIApplication.didBecomeActiveNotification) { engine, _ in engine.send(.didBecomeActive) }
    }

    /// A `.began` posted because a suspended app resumed: the reason
    /// `.appWasSuspended` (1), or the older key. Both are deprecated names
    /// (iOS 16 says it no longer posts them), hence the raw values here.
    private static func wasSuspended(_ info: [AnyHashable: Any]?) -> Bool {
        (info?[AVAudioSessionInterruptionReasonKey] as? UInt) == 1
            || (info?["AVAudioSessionInterruptionWasSuspendedKey"] as? Bool) == true
    }

    /// Every AV object is dead: forget them without calling into them.
    private func mediaServicesGone() {
        pulseTimer?.cancel()
        pulseTimer = nil
        hardware.discard()
        resetMic()
    }

    // MARK: the reducer's actions (queue)

    private func send(_ input: CallAudioInput) {
        let before = state.sessions.open
        let actions = state.reduce(input, now: ProcessInfo.processInfo.systemUptime)
        let outer = batchSession
        batchSession = before ?? state.sessions.open
        run(actions)
        batchSession = outer
        updateTicker()
    }

    private func run(_ actions: [CallAudioAction]) {
        for action in actions {
            switch action {
            case .requestPermission:
                hardware.requestPermission { [weak self] granted in
                    self?.queue.async {
                        guard let self else { return }
                        self.send(.permissionAnswered(granted: granted))
                        self.flush()
                    }
                }
            case .recordSession:
                hardware.recordSession()
            case let .start(plan):
                // Always last in its batch; answered before any other input.
                let ok = hardware.start(plan)
                resetMic()
                send(ok ? .started : .startFailed)
            case .stopEngine:
                hardware.stopEngine()
                resetMic()
            case .teardownEngine:
                stopPulseTimer()
                hardware.teardown()
                resetMic()
                // Every real end of a call runs this (close, lost, or app
                // teardown) — nothing else needs to know to let the phone
                // sleep again.
                hardware.setIdleTimerDisabled(false)
            case .restoreSession:
                hardware.restoreSession()
            case .deactivateSession:
                hardware.deactivateSession()
            case .startPulse:
                startPulseTimer()
            case .stopPulse:
                stopPulseTimer()
                hardware.stopPulse()
            case .holdClips:
                runClip(book.hold())
            case .releaseClips:
                book.endHold()
            case .closeClips:
                runClip(book.close())
                decoders.removeAll()
            case let .emitHold(session, reason):
                emit(["type": "hold", "session": session, "reason": reason.rawValue])
            case let .emitResume(session):
                emit(["type": "resume", "session": session])
            case let .emitLost(session, reason):
                emit(["type": "lost", "session": session, "reason": reason.rawValue])
            case let .emitRoute(session, output):
                emit(["type": "route", "session": session, "output": output.rawValue])
            case let .replyOpen(request, result):
                guard let reply = openReplies.removeValue(forKey: request) else { continue }
                switch result {
                case let .opened(session):
                    if micModeLogged != session {
                        micModeLogged = session
                        ShellLog.value("call audio mic mode", hardware.microphoneMode)
                    }
                    // A hands-free call must not let auto-lock pause it
                    // (moss-approval-bug.md: no background audio and no idle
                    // timer meant a locked phone silently held the call).
                    hardware.setIdleTimerDisabled(true)
                    outbox.append(.reply(reply, .opened(session: session)))
                case let .failed(error):
                    outbox.append(.reply(reply, .error(error.rawValue)))
                }
            case let .schedule(timer, delay):
                queue.asyncAfter(deadline: .now() + delay) { [weak self] in
                    guard let self else { return }
                    self.send(.timerFired(timer))
                    self.flush()
                }
            case let .log(line):
                ShellLog.callAudio(line)
            }
        }
    }

    // MARK: the clip (queue)

    /// Does what the book says. `piece` is the piece a `.feed` appends and
    /// `buffer` the decoded buffer a `.schedule` schedules.
    private func runClip(_ actions: [ClipAction], piece: CallAudioPlayArgs? = nil, buffer: AVAudioPCMBuffer? = nil) {
        for action in actions {
            switch action {
            case let .openDecoder(generation, label):
                decoders = [generation: StreamDecoder(label: label)]
            case let .feed(generation):
                guard let piece, let decoder = decoders[generation] else { continue }
                feed(decoder, generation: generation, piece: piece)
            case let .closeDecoder(generation):
                decoders[generation] = nil
            case let .schedule(generation):
                guard let buffer else { continue }
                let frames = Int(buffer.frameLength)
                hardware.scheduleVoice(buffer) { [weak self] in
                    // Completions (a stop fires them too) never act inline.
                    self?.queue.async {
                        guard let self else { return }
                        self.runClip(self.book.played(generation: generation, frames: frames))
                        self.flush()
                    }
                }
            case .startPlayer:
                hardware.playVoice()
            case .pausePlayer:
                hardware.pauseVoice()
            case .stopPlayer:
                hardware.stopVoice()
            case let .emit(clip, event):
                guard let session = batchSession ?? state.sessions.open else { continue }
                var detail = ["type": "clip", "session": session, "clip": clip, "state": event.state]
                if let reason = event.reason { detail["reason"] = reason }
                emit(detail)
            case .logUnderrun:
                ShellLog.event("call audio clip underrun")
            }
        }
    }

    private func feed(_ decoder: StreamDecoder, generation: UInt64, piece: CallAudioPlayArgs) {
        do {
            for buffer in try decoder.append(piece.bytes, last: piece.last) {
                runClip(book.decoded(generation: generation, frames: Int(buffer.frameLength)), buffer: buffer)
            }
            if piece.last { runClip(book.flushed(generation: generation)) }
        } catch {
            ShellLog.event("call audio clip failed decode")
            runClip(book.decodeFailed(generation: generation))
        }
    }

    /// `progress` about every 250 ms while a session is open; the book sends
    /// it only while samples are rendering.
    private func updateTicker() {
        let open = state.phase == .open
        if open, ticker == nil {
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250))
            timer.setEventHandler { [weak self] in
                guard let self else { return }
                self.runClip(self.book.tick())
                self.flush()
            }
            ticker = timer
            timer.resume()
        } else if !open, let ticker {
            ticker.cancel()
            self.ticker = nil
        }
    }

    // MARK: the pulse (queue)

    private func startPulseTimer() {
        stopPulseTimer()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: CallAudioPulse.interval)
        timer.setEventHandler { [weak self] in self?.hardware.schedulePulse() }
        pulseTimer = timer
        timer.resume()
    }

    private func stopPulseTimer() {
        pulseTimer?.cancel()
        pulseTimer = nil
    }

    // MARK: the microphone (queue)

    /// §4.2.3: 16 kHz frames only while the call is open, settled and not held.
    private func tapped(_ buffer: AVAudioPCMBuffer) {
        guard state.micLive, let session = state.sessions.open else {
            framer.reset()
            return
        }
        if resampler?.inputFormat != buffer.format {
            resampler = MicResampler(input: buffer.format)
            framer.reset()
        }
        guard let samples = resampler?.convert(buffer) else { return }
        for pcm in framer.append(samples) {
            outbox.append(.event(Event(detail: ["type": "mic", "session": session, "pcm": pcm], isMic: true)))
        }
        flush()
    }

    private func resetMic() {
        resampler = nil
        framer.reset()
    }

    /// A mic event's `handled`, back from the main actor (the §4.2.7 watchdog).
    private func micDelivered(_ handled: Bool) {
        queue.async { [weak self] in
            guard let self else { return }
            self.send(.micDelivered(handled: handled))
            self.flush()
        }
    }

    // MARK: to the main actor

    private func emit(_ detail: [String: String]) {
        outbox.append(.event(Event(detail: detail, isMic: false)))
    }

    /// One ordered hop for everything this queue block produced.
    private func flush() {
        guard !outbox.isEmpty else { return }
        let items = outbox
        outbox = []
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                for item in items {
                    switch item {
                    case let .reply(reply, value):
                        reply(value)
                    case let .event(event):
                        guard let sink = self?.sink else { continue }
                        sink(event) { [weak self] handled in
                            if event.isMic { self?.micDelivered(handled) }
                        }
                    }
                }
            }
        }
    }

    #if DEBUG
    /// Tests: `done` runs on the main actor after everything queued so far
    /// has run and its events have been delivered.
    func drain(_ done: @escaping @MainActor @Sendable () -> Void) {
        queue.async { DispatchQueue.main.async { MainActor.assumeIsolated { done() } } }
    }
    #endif
}

/// Notifications are not Sendable; the observer reads only `userInfo` and `object`.
private struct NoteBox: @unchecked Sendable {
    let value: Notification
    init(_ value: Notification) { self.value = value }
}
#endif
