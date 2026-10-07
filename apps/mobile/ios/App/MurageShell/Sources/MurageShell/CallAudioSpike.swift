#if DEBUG && os(iOS)
import AVFoundation
import UIKit
import os

// Debug builds only (spec §6.0): the native call audio spike. Launched with
// `-murageCallAudioSpike`; `-murageCallAudioSpikeAuto` also runs every
// variant in turn with no taps. It measures whether playing through the
// voice-processing engine sounds clean before any channel or web work is
// built. Logs are fixed strings plus numbers only.

/// Fixed-string, numbers-only log lines, to os_log and to
/// Documents/call-audio-spike.log (fetch with `devicectl device copy from`).
/// Never stdout: under `devicectl --console` a slow pipe blocks the writer,
/// which froze the audio queue mid-clip.
private enum SpikeLog {
    private static let logger = Logger(subsystem: "com.murage.mobile", category: "shell")
    private static let writer = DispatchQueue(label: "call-audio-spike-log")
    private static let file: URL? = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
        .appendingPathComponent("call-audio-spike.log")

    /// A fresh file for each launch.
    static func reset() {
        writer.async { if let file { try? FileManager.default.removeItem(at: file) } }
    }

    static func line(_ name: StaticString, _ values: [(StaticString, Double)] = []) {
        var text = "call audio spike \(name)"
        for (key, value) in values { text += " \(key)=\(String(format: "%.6g", value))" }
        logger.info("\(text, privacy: .public)")
        let stamped = String(format: "%.3f ", Date().timeIntervalSince1970) + text + "\n"
        writer.async {
            guard let file, let data = stamped.data(using: .utf8) else { return }
            if let handle = try? FileHandle(forWritingTo: file) {
                handle.seekToEndOfFile()
                handle.write(data)
                try? handle.close()
            } else {
                try? data.write(to: file)
            }
        }
    }
}

/// The three session modes the spike compares (§6.0), all with voice processing on.
private enum SpikeMode: Int, CaseIterable {
    case voiceChat, defaultMode, videoChat

    var session: AVAudioSession.Mode {
        switch self {
        case .voiceChat: .voiceChat
        case .defaultMode: .default
        case .videoChat: .videoChat
        }
    }

    var label: String {
        switch self {
        case .voiceChat: "voiceChat"
        case .defaultMode: "default + VP"
        case .videoChat: "videoChat"
        }
    }
}

private enum SpikeVariant: Int {
    case plain = 1, engine = 2, enginePulse = 3
}

/// Route as a number for the log: 1 speaker, 2 receiver, 3 wired headphones,
/// 4 Bluetooth HFP, 5 Bluetooth A2DP, 6 Bluetooth LE, 0 other.
private func routeCode(_ port: AVAudioSession.Port?) -> Int {
    switch port {
    case .builtInSpeaker?: 1
    case .builtInReceiver?: 2
    case .headphones?: 3
    case .bluetoothHFP?: 4
    case .bluetoothA2DP?: 5
    case .bluetoothLE?: 6
    default: 0
    }
}

/// What the screen shows. Built on the queue, handed to the main actor whole.
private struct SpikeReadout: Sendable {
    var variant = "idle"
    var mode = "voiceChat"
    var state = "idle"
    var inputFormat = "-"
    var outputFormat = "-"
    var route = "-"
    var micMode = "-"
    var gainDB = 0.0
    var sessionRate = 0.0
    var framesPerSecond = 0.0
    var frames = 0
    var playRMS = 0.0
    var silenceRMS = 0.0
    var playFrames = 0
    var silenceFrames = 0

    var ratioDB: Double? {
        guard playRMS > 0, silenceRMS > 0 else { return nil }
        return 20 * log10(playRMS / silenceRMS)
    }

    var text: String {
        func db(_ rms: Double) -> String { rms > 0 ? String(format: "%.4f (%.1f dBFS)", rms, 20 * log10(rms)) : "-" }
        return """
        variant      \(variant)
        mode         \(mode)
        voice gain   \(String(format: "%+.0f dB", gainDB)) (EQ globalGain, limiter after)
        session rate \(sessionRate > 0 ? String(format: "%.0f Hz", sessionRate) : "-")
        state        \(state)
        input        \(inputFormat)
        output       \(outputFormat)
        route        \(route)
        mic mode     \(micMode)
        frames/s     \(String(format: "%.2f", framesPerSecond)) (\(frames) frames)
        mic RMS play \(db(playRMS)) n=\(playFrames)
        mic RMS sil  \(db(silenceRMS)) n=\(silenceFrames)
        play/sil     \(ratioDB.map { String(format: "%.1f dB", $0) } ?? "-")
        """
    }
}

/// Once-only flag for the converter's input block.
private final class SpikeOnce: @unchecked Sendable {
    var done = false
}

/// All audio work runs on one serial queue (§4.2.1); nothing here touches
/// the main thread except `onReadout`, which the rig hops to itself.
private final class CallAudioSpikeRig: @unchecked Sendable {
    private let queue = DispatchQueue(label: "call-audio")
    private let fixtureURL: URL?
    var onReadout: (@MainActor @Sendable (SpikeReadout) -> Void)?

    private var readout = SpikeReadout()
    private var mode = SpikeMode.voiceChat
    /// The voice player's EQ globalGain, cycled 0 / +6 / +12 dB ("quieter" in Sean's report).
    static let gains: [Float] = [0, 6, 12]
    private var gainIndex = 0
    private var voiceEQ: AVAudioUnitEQ?
    private var generation = 0

    // Variant A.
    private var plainPlayer: AVAudioPlayer?
    // Variant B.
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var pulse: AVAudioPlayerNode?
    private var pulseTimer: DispatchSourceTimer?
    private var pulseBuffer: AVAudioPCMBuffer?
    private var micConverter: AVAudioConverter?
    private var micRemainder: [Float] = []
    private var clipPlaying = false
    private var firstTapAt: Date?
    private var playSquares = 0.0
    private var silenceSquares = 0.0
    private var frameBytes = 0
    private var configObserver: NSObjectProtocol?
    /// Rebuilds after an engine configuration change within one run (§4.2.8 in miniature).
    private var rebuilds = 0
    private var clipSettled = false
    private var chainNodes: [AVAudioNode] = []

    private static let playFormat = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
    private static let micFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    private static let frameLength = 1024
    private static let useRendered = ProcessInfo.processInfo.arguments.contains("-murageCallAudioSpikeRendered")

    init(fixtureURL: URL?) {
        self.fixtureURL = fixtureURL
    }

    // MARK: controls (any thread)

    func run(_ variant: SpikeVariant, completion: (@Sendable () -> Void)? = nil) {
        queue.async { [weak self] in self?.start(variant, completion: completion) }
    }

    func cycleMode() {
        queue.async { [weak self] in
            guard let self else { return }
            self.teardown()
            self.mode = SpikeMode(rawValue: (self.mode.rawValue + 1) % SpikeMode.allCases.count) ?? .voiceChat
            self.readout.mode = self.mode.label
            self.readout.state = "idle"
            SpikeLog.line("mode", [("mode", Double(self.mode.rawValue))])
            self.publish()
        }
    }

    func setMode(_ index: Int) {
        queue.async { [weak self] in
            guard let self else { return }
            self.mode = SpikeMode(rawValue: index) ?? .voiceChat
            self.readout.mode = self.mode.label
            self.publish()
        }
    }

    func stop() {
        queue.async { [weak self] in self?.teardown() }
    }

    /// Takes effect live on a running engine, and on every later run.
    func setGain(_ index: Int) {
        queue.async { [weak self] in
            guard let self else { return }
            self.gainIndex = index % Self.gains.count
            let gain = Self.gains[self.gainIndex]
            self.voiceEQ?.globalGain = gain
            self.readout.gainDB = Double(gain)
            SpikeLog.line("gain", [("db", Double(gain))])
            self.publish()
        }
    }

    // MARK: runs (queue)

    private func start(_ variant: SpikeVariant, completion: (@Sendable () -> Void)?) {
        teardown()
        generation += 1
        let gen = generation
        readout = SpikeReadout()
        readout.mode = mode.label
        readout.gainDB = Double(Self.gains[gainIndex])
        rebuilds = 0
        playSquares = 0
        silenceSquares = 0
        firstTapAt = nil
        micRemainder = []
        clipPlaying = false
        guard let fixtureURL else {
            readout.state = "no fixture"
            SpikeLog.line("fixture missing")
            publish()
            return
        }
        switch variant {
        case .plain:
            readout.variant = "A: plain"
            startPlain(fixtureURL, gen: gen, completion: completion)
        case .engine, .enginePulse:
            readout.variant = variant == .engine ? "B: call engine" : "B + pulse"
            // §4.2.10: the engine never starts without the microphone grant.
            let permission = AVAudioApplication.shared.recordPermission
            SpikeLog.line("permission", [("value", Double(permission == .granted ? 1 : permission == .denied ? 2 : 0))])
            switch permission {
            case .granted:
                startEngine(fixtureURL, pulse: variant == .enginePulse, gen: gen, completion: completion)
            case .denied:
                readout.state = "microphone denied"
                completion?()
            default:
                readout.state = "asking for the microphone"
                AVAudioApplication.requestRecordPermission { [weak self] granted in
                    self?.queue.async {
                        guard let self, self.generation == gen else { return }
                        if granted { self.start(variant, completion: completion) } else {
                            self.readout.state = "microphone denied"
                            self.publish()
                            completion?()
                        }
                    }
                }
            }
        }
        publish()
    }

    private func startPlain(_ url: URL, gen: Int, completion: (@Sendable () -> Void)?) {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
            let player = try AVAudioPlayer(contentsOf: url)
            plainPlayer = player
            player.prepareToPlay()
            player.play()
            readout.outputFormat = describe(player.format)
            readout.inputFormat = "none (no microphone)"
            readRoute()
            readout.state = "playing"
            SpikeLog.line("plain start", [("rate", player.format.sampleRate), ("route", Double(routeCode(session.currentRoute.outputs.first?.portType)))])
            let duration = player.duration
            queue.asyncAfter(deadline: .now() + duration + 0.5) { [weak self] in
                guard let self, self.generation == gen else { return }
                self.readout.state = "ended"
                SpikeLog.line("plain ended", [("seconds", duration)])
                self.teardown()
                self.publish()
                completion?()
            }
        } catch {
            readout.state = "failed"
            SpikeLog.line("plain failed", [("code", Double((error as NSError).code))])
            completion?()
        }
    }

    /// §4.2.2, in order.
    private func startEngine(_ url: URL, pulse withPulse: Bool, gen: Int, completion: (@Sendable () -> Void)?) {
        let session = AVAudioSession.sharedInstance()
        do {
            // 1. Session.
            try session.setCategory(.playAndRecord, mode: mode.session,
                                    options: [.defaultToSpeaker, .allowBluetoothHFP, .allowBluetoothA2DP])
            try session.setActive(true)
            // 2. A new engine.
            let engine = AVAudioEngine()
            self.engine = engine
            // 3. Voice processing.
            try engine.inputNode.setVoiceProcessingEnabled(true)
            // 4. No ducking of other audio.
            engine.inputNode.voiceProcessingOtherAudioDuckingConfiguration =
                .init(enableAdvancedDucking: false, duckingLevel: .min)
            // 5. Player and pulse nodes, each through EQ (0 dB) and a peak limiter, fixed 48 kHz mono.
            attachChains(engine)
            guard let player = self.player, let pulse = self.pulse else { throw NSError(domain: "spike", code: 4) }
            // 6. The tap, with the format read after voice processing is on.
            let inputFormat = engine.inputNode.outputFormat(forBus: 0)
            // Mid-reconfiguration the input can read 0 Hz / 0 ch; installTap would raise.
            guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
                throw NSError(domain: "spike", code: 3)
            }
            micConverter = AVAudioConverter(from: inputFormat, to: Self.micFormat)
            engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
                // The buffer is valid only during this call: copy, then hop.
                guard let copy = Self.copy(buffer) else { return }
                self?.queue.async { self?.tapped(copy) }
            }
            // An AVAudioEngineConfigurationChange stops the engine: log it and rebuild the run once.
            configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
                self?.queue.async {
                    guard let self, self.generation == gen, let engine = self.engine else { return }
                    let sessionRate = AVAudioSession.sharedInstance().sampleRate
                    SpikeLog.line("config change", [("running", engine.isRunning ? 1 : 0), ("rebuilds", Double(self.rebuilds)),
                                                    ("inRate", engine.inputNode.outputFormat(forBus: 0).sampleRate),
                                                    ("outRate", engine.outputNode.outputFormat(forBus: 0).sampleRate),
                                                    ("sessionRate", sessionRate)])
                    guard self.rebuilds < 2 else { return }
                    if self.rebuilds == 0, self.restartInPlace(engine) {
                        self.rebuilds = 1
                        return
                    }
                    let rebuilds = self.rebuilds + 1
                    self.teardown(deactivate: false)
                    self.generation += 1
                    self.rebuilds = rebuilds
                    self.readout.state = "rebuilt after config change"
                    let next = self.generation
                    // Let the route settle before reading the new formats.
                    self.queue.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                        guard let self, self.generation == next else { return }
                        self.startEngine(url, pulse: withPulse, gen: next, completion: completion)
                    }
                }
            }
            // 7. Start.
            engine.prepare()
            try engine.start()
            player.play()
            pulse.play()

            readout.inputFormat = describe(inputFormat)
            readout.outputFormat = describe(engine.outputNode.outputFormat(forBus: 0))
            readRoute()
            readout.state = "listening (silence)"
            readout.sessionRate = session.sampleRate
            SpikeLog.line("engine start", [
                ("mode", Double(mode.rawValue)), ("gainDb", Double(Self.gains[gainIndex])),
                ("sessionRate", session.sampleRate), ("ioBufferMs", session.ioBufferDuration * 1000),
                ("outCh", Double(engine.outputNode.outputFormat(forBus: 0).channelCount)),
                ("inRate", inputFormat.sampleRate), ("inCh", Double(inputFormat.channelCount)),
                ("outRate", engine.outputNode.outputFormat(forBus: 0).sampleRate),
                ("route", Double(routeCode(session.currentRoute.outputs.first?.portType))),
                ("micMode", Double(AVCaptureDevice.activeMicrophoneMode.rawValue)),
            ])

            heartbeat(gen: gen, after: 3)
            let clip = try decodeFixture(url)
            SpikeLog.line("fixture decoded", [("frames", Double(clip.frameLength))])
            if withPulse { startPulse() }
            // 1.5 s of silence first, then the clip, then 2 s of silence.
            queue.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard let self, self.generation == gen, let player = self.player else { return }
                self.clipPlaying = true
                self.readout.state = "playing clip"
                self.publish()
                self.clipSettled = false
                // Spike finding: .dataPlayedBack never fired on Sean's iPhone with
                // voice processing on (the player rendered in real time). The
                // launch argument -murageCallAudioSpikeRendered compares .dataRendered.
                let type: AVAudioPlayerNodeCompletionCallbackType = Self.useRendered ? .dataRendered : .dataPlayedBack
                player.scheduleBuffer(clip, completionCallbackType: type) { [weak self] _ in
                    self?.queue.async { self?.clipEnded(gen: gen, fromCompletion: true, completion: completion) }
                }
                // Backstop: if the completion never comes, the clip window still closes.
                let seconds = Double(clip.frameLength) / 48000 + 1.5
                self.queue.asyncAfter(deadline: .now() + seconds) { [weak self] in
                    self?.clipEnded(gen: gen, fromCompletion: false, completion: completion)
                }
            }
        } catch {
            SpikeLog.line("engine failed", [("code", Double((error as NSError).code)), ("rebuilds", Double(rebuilds))])
            if rebuilds > 0, rebuilds < 3 {
                // A rebuild that hit a route still settling: one more try.
                teardown(deactivate: false)
                rebuilds += 1
                queue.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    guard let self, self.generation == gen else { return }
                    self.startEngine(url, pulse: withPulse, gen: gen, completion: completion)
                }
                return
            }
            readout.state = "failed"
            teardown()
            completion?()
        }
    }

    private func clipEnded(gen: Int, fromCompletion: Bool, completion: (@Sendable () -> Void)?) {
        guard generation == gen, !clipSettled else { return }
        clipSettled = true
        SpikeLog.line(fromCompletion ? "clip ended" : "clip completion missing", [("rendered", Self.useRendered ? 1 : 0)])
        clipPlaying = false
        readout.state = fromCompletion ? "listening (silence after)" : "silence after (no completion)"
        publish()
        queue.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.generation == gen else { return }
            self.summary()
            self.teardown()
            self.readout.state = "ended"
            self.publish()
            completion?()
        }
    }

    /// Every 2 s while the run lives: proves the queue is free and the engine renders.
    private func heartbeat(gen: Int, after seconds: Double) {
        queue.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self, self.generation == gen, let engine = self.engine else { return }
            let sample = self.player?.lastRenderTime.flatMap { self.player?.playerTime(forNodeTime: $0) }?.sampleTime ?? -1
            SpikeLog.line("health", [("running", engine.isRunning ? 1 : 0), ("frames", Double(self.readout.frames)),
                                     ("clip", self.clipPlaying ? 1 : 0), ("playerSample", Double(sample)),
                                     ("playerPlaying", self.player?.isPlaying == true ? 1 : 0)])
            self.heartbeat(gen: gen, after: 2)
        }
    }

    /// Player and pulse, each through EQ and a peak limiter into the mixer at 48 kHz mono.
    private func attachChains(_ engine: AVAudioEngine) {
        for node in chainNodes { engine.detach(node) }
        chainNodes = []
        let player = AVAudioPlayerNode()
        let pulse = AVAudioPlayerNode()
        self.player = player
        self.pulse = pulse
        for node in [player, pulse] {
            let eq = AVAudioUnitEQ(numberOfBands: 0)
            eq.globalGain = node === player ? Self.gains[gainIndex] : 0
            if node === player { voiceEQ = eq }
            let limiter = AVAudioUnitEffect(audioComponentDescription: AudioComponentDescription(
                componentType: kAudioUnitType_Effect, componentSubType: kAudioUnitSubType_PeakLimiter,
                componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0))
            engine.attach(node)
            engine.attach(eq)
            engine.attach(limiter)
            engine.connect(node, to: eq, format: Self.playFormat)
            engine.connect(eq, to: limiter, format: Self.playFormat)
            engine.connect(limiter, to: engine.mainMixerNode, format: Self.playFormat)
            chainNodes += [node, eq, limiter]
        }
    }

    /// Apple's answer to a configuration change: re-read the input format,
    /// reinstall the tap and start the same engine again. True when it runs.
    private func restartInPlace(_ engine: AVAudioEngine) -> Bool {
        engine.inputNode.removeTap(onBus: 0)
        let inputFormat = engine.inputNode.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else { return false }
        micConverter = AVAudioConverter(from: inputFormat, to: Self.micFormat)
        // The mixer's link to the output was made at the old hardware format: remake
        // it, and give the player and pulse fresh nodes (the old ones never rendered
        // a scheduled buffer again after the change).
        engine.disconnectNodeOutput(engine.mainMixerNode)
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: nil)
        attachChains(engine)
        engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            guard let copy = Self.copy(buffer) else { return }
            self?.queue.async { self?.tapped(copy) }
        }
        engine.prepare()
        do { try engine.start() } catch {
            SpikeLog.line("restart failed", [("code", Double((error as NSError).code))])
            return false
        }
        player?.play()
        pulse?.play()
        readout.inputFormat = describe(inputFormat)
        readout.outputFormat = describe(engine.outputNode.outputFormat(forBus: 0))
        readout.sessionRate = AVAudioSession.sharedInstance().sampleRate
        SpikeLog.line("restarted in place", [("running", engine.isRunning ? 1 : 0), ("inRate", inputFormat.sampleRate),
                                             ("outRate", engine.outputNode.outputFormat(forBus: 0).sampleRate),
                                             ("outCh", Double(engine.outputNode.outputFormat(forBus: 0).channelCount)),
                                             ("ioBufferMs", AVAudioSession.sharedInstance().ioBufferDuration * 1000)])
        publish()
        return engine.isRunning
    }

    /// One-shot decode of the fixture to 48 kHz mono Float32.
    private func decodeFixture(_ url: URL) throws -> AVAudioPCMBuffer {
        let file = try AVAudioFile(forReading: url)
        guard let source = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)) else {
            throw NSError(domain: "spike", code: 1)
        }
        try file.read(into: source)
        guard let converter = AVAudioConverter(from: file.processingFormat, to: Self.playFormat),
              let out = AVAudioPCMBuffer(pcmFormat: Self.playFormat, frameCapacity:
                AVAudioFrameCount(ceil(Double(source.frameLength) * 48000 / file.processingFormat.sampleRate)) + 1024) else {
            throw NSError(domain: "spike", code: 2)
        }
        let once = SpikeOnce()
        var error: NSError?
        _ = converter.convert(to: out, error: &error) { _, status in
            if once.done { status.pointee = .endOfStream; return nil }
            once.done = true
            status.pointee = .haveData
            return source
        }
        if let error { throw error }
        return out
    }

    // MARK: microphone (§4.2.3)

    private static func copy(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else { return nil }
        copy.frameLength = buffer.frameLength
        let from = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: buffer.audioBufferList))
        let to = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for (src, dst) in zip(from, to) {
            guard let s = src.mData, let d = dst.mData else { continue }
            memcpy(d, s, Int(min(src.mDataByteSize, dst.mDataByteSize)))
        }
        return copy
    }

    private func tapped(_ buffer: AVAudioPCMBuffer) {
        guard engine != nil, let converter = micConverter else { return }
        let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16000 / buffer.format.sampleRate)) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: Self.micFormat, frameCapacity: capacity) else { return }
        // Streaming: supply this buffer once, then .noDataNow (never .endOfStream).
        let once = SpikeOnce()
        var error: NSError?
        _ = converter.convert(to: out, error: &error) { _, status in
            if once.done { status.pointee = .noDataNow; return nil }
            once.done = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let samples = out.floatChannelData?[0] else { return }
        if firstTapAt == nil { firstTapAt = Date() }
        micRemainder.append(contentsOf: UnsafeBufferPointer(start: samples, count: Int(out.frameLength)))
        while micRemainder.count >= Self.frameLength {
            let frame = Array(micRemainder.prefix(Self.frameLength))
            micRemainder.removeFirst(Self.frameLength)
            frameCut(frame)
        }
        if let firstTapAt {
            let elapsed = Date().timeIntervalSince(firstTapAt)
            if elapsed > 0.5 { readout.framesPerSecond = Double(readout.frames) / elapsed }
        }
        if readout.frames % 8 == 0 { publish() }
    }

    private func frameCut(_ frame: [Float]) {
        var squares = 0.0
        for s in frame { squares += Double(s) * Double(s) }
        // Int16 LE, clipped, base64: the real per-frame cost.
        var pcm = Data(capacity: frame.count * 2)
        for s in frame {
            let v = Int16(max(-1, min(1, s)) * 32767).littleEndian
            withUnsafeBytes(of: v) { pcm.append(contentsOf: $0) }
        }
        frameBytes = pcm.base64EncodedString().utf8.count
        readout.frames += 1
        if clipPlaying {
            playSquares += squares
            readout.playFrames += 1
            readout.playRMS = sqrt(playSquares / Double(readout.playFrames * Self.frameLength))
        } else {
            silenceSquares += squares
            readout.silenceFrames += 1
            readout.silenceRMS = sqrt(silenceSquares / Double(readout.silenceFrames * Self.frameLength))
        }
    }

    // MARK: pulse (§4.2.4)

    private func startPulse() {
        if pulseBuffer == nil { pulseBuffer = Self.makePulse() }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(950))
        timer.setEventHandler { [weak self] in
            guard let self, let pulse = self.pulse, let buffer = self.pulseBuffer else { return }
            pulse.scheduleBuffer(buffer, completionHandler: nil)
        }
        pulseTimer = timer
        timer.resume()
    }

    /// The same two-part blip as src/lib/working-pulse.ts: 620 Hz at 0.07
    /// then 740 Hz at 0.045, 110 ms apart, each falling to 0.82 of its pitch
    /// over 120 ms through a 1.8 kHz low-pass.
    private static func makePulse() -> AVAudioPCMBuffer? {
        let rate = 48000.0
        let length = Int(rate * 0.33)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(length)),
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

    // MARK: teardown and readouts (queue)

    private func summary() {
        SpikeLog.line("summary", [
            ("variant", readout.variant == "B + pulse" ? 3 : 2),
            ("mode", Double(mode.rawValue)), ("gainDb", readout.gainDB),
            ("playRms", readout.playRMS), ("silRms", readout.silenceRMS),
            ("ratioDb", readout.ratioDB ?? 0),
            ("fps", readout.framesPerSecond), ("frames", Double(readout.frames)),
            ("frameB64", Double(frameBytes)),
        ])
    }

    private func teardown(deactivate: Bool = true) {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        pulseTimer?.cancel()
        pulseTimer = nil
        plainPlayer?.stop()
        plainPlayer = nil
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            player?.stop()
            pulse?.stop()
            engine.stop()
        }
        engine = nil
        player = nil
        pulse = nil
        voiceEQ = nil
        chainNodes = []
        micConverter = nil
        clipPlaying = false
        if deactivate { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    }

    private func readRoute() {
        let route = AVAudioSession.sharedInstance().currentRoute
        let outs = route.outputs.map(\.portType.rawValue).joined(separator: ",")
        let ins = route.inputs.map(\.portType.rawValue).joined(separator: ",")
        readout.route = "out \(outs.isEmpty ? "-" : outs) / in \(ins.isEmpty ? "-" : ins)"
        let mic = AVCaptureDevice.activeMicrophoneMode
        readout.micMode = switch mic {
        case .standard: "standard"
        case .wideSpectrum: "wideSpectrum"
        case .voiceIsolation: "voiceIsolation"
        @unknown default: "raw \(mic.rawValue)"
        }
    }

    private func describe(_ format: AVAudioFormat) -> String {
        "\(Int(format.sampleRate)) Hz, \(format.channelCount) ch, \(format.isInterleaved ? "interleaved" : "planar")"
    }

    private func publish() {
        let snapshot = readout
        guard let onReadout else { return }
        Task { @MainActor in onReadout(snapshot) }
    }
}

/// Full-screen debug view: four buttons and the live readouts.
@MainActor
final class CallAudioSpikeViewController: UIViewController {
    private let rig = CallAudioSpikeRig(fixtureURL: Bundle.main.url(forResource: "spike-voice", withExtension: "mp3"))
    private let readoutLabel = UILabel()
    private let modeButton = UIButton(type: .system)
    private var modeIndex = 0
    private let gainButton = UIButton(type: .system)
    private var gainIndex = 0
    private let auto: Bool
    /// The channel self-test (Task 5): the real CallAudioEngine end to end.
    private var selfTest: CallAudioSelfTest?
    private let selfTestLabel = UILabel()

    init(auto: Bool) {
        self.auto = auto
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let title = UILabel()
        title.text = "Call audio spike (DEBUG)"
        title.font = .preferredFont(forTextStyle: .headline)

        let a = button("A: plain", id: "spike.plain") { [weak self] in self?.rig.run(.plain) }
        let b = button("B: call engine", id: "spike.engine") { [weak self] in self?.rig.run(.engine) }
        let bp = button("B + pulse", id: "spike.pulse") { [weak self] in self?.rig.run(.enginePulse) }
        modeButton.setTitle("Mode: voiceChat", for: .normal)
        modeButton.accessibilityIdentifier = "spike.mode"
        modeButton.titleLabel?.font = .preferredFont(forTextStyle: .title3)
        modeButton.addAction(UIAction { [weak self] _ in self?.cycleMode() }, for: .touchUpInside)

        gainButton.setTitle("Gain: +0 dB", for: .normal)
        gainButton.accessibilityIdentifier = "spike.gain"
        gainButton.titleLabel?.font = .preferredFont(forTextStyle: .title3)
        gainButton.addAction(UIAction { [weak self] _ in self?.cycleGain() }, for: .touchUpInside)

        let channel = button("Channel self-test", id: "spike.selftest") { [weak self] in self?.runSelfTest() }
        selfTestLabel.numberOfLines = 2
        selfTestLabel.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        selfTestLabel.accessibilityIdentifier = "spike.selftest.status"

        readoutLabel.numberOfLines = 0
        readoutLabel.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        readoutLabel.accessibilityIdentifier = "spike.readout"

        let stack = UIStackView(arrangedSubviews: [title, a, b, bp, modeButton, gainButton, channel, selfTestLabel, readoutLabel])
        stack.axis = .vertical
        stack.spacing = 14
        stack.alignment = .leading
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
        ])

        rig.onReadout = { [weak self] readout in self?.readoutLabel.text = readout.text }
        readoutLabel.text = SpikeReadout().text
        SpikeLog.reset()
        SpikeLog.line("shown", [("auto", auto ? 1 : 0)])
        if auto { runAll() }
        if ProcessInfo.processInfo.arguments.contains("-murageCallAudioSelfTest") { runSelfTest() }
    }

    /// One at a time, with the spike's own engine stopped first.
    private func runSelfTest() {
        guard selfTest == nil else { return }
        rig.stop()
        let test = CallAudioSelfTest(fixture: Bundle.main.url(forResource: "spike-voice", withExtension: "mp3"))
        test.onLine = { [weak self] text in self?.selfTestLabel.text = text }
        selfTest = test
        Task { @MainActor [weak self] in
            await test.run()
            self?.selfTest = nil
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        rig.stop()
    }

    private func button(_ title: String, id: String, action: @escaping @MainActor () -> Void) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(title, for: .normal)
        button.titleLabel?.font = .preferredFont(forTextStyle: .title3)
        button.accessibilityIdentifier = id
        button.addAction(UIAction { _ in action() }, for: .touchUpInside)
        return button
    }

    private func cycleMode() {
        modeIndex = (modeIndex + 1) % SpikeMode.allCases.count
        modeButton.setTitle("Mode: \(SpikeMode(rawValue: modeIndex)?.label ?? "-")", for: .normal)
        rig.cycleMode()
    }

    private func cycleGain() {
        gainIndex = (gainIndex + 1) % CallAudioSpikeRig.gains.count
        gainButton.setTitle(String(format: "Gain: %+.0f dB", CallAudioSpikeRig.gains[gainIndex]), for: .normal)
        rig.setGain(gainIndex)
    }

    /// `-murageCallAudioSpikeAuto`: B cold (before any A), A, then B and B + pulse in each mode, then
    /// B at +6 and +12 dB, one after another. (variant, mode, gain index)
    private func runAll() {
        let steps: [(SpikeVariant, Int, Int)] = [(.engine, 0, 0), (.plain, 0, 0), (.engine, 0, 0), (.enginePulse, 0, 0), (.engine, 1, 0), (.enginePulse, 1, 0),
                                                 (.engine, 2, 0), (.enginePulse, 2, 0), (.engine, 0, 1), (.engine, 0, 2)]
        let rig = self.rig
        func step(_ index: Int) {
            guard index < steps.count else { SpikeLog.line("auto done"); rig.setGain(0); return }
            let (variant, mode, gain) = steps[index]
            rig.setMode(mode)
            rig.setGain(gain)
            rig.run(variant) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { step(index + 1) }
            }
        }
        step(0)
    }
}
#endif
