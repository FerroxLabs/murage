#if DEBUG && os(iOS)
import Foundation
import MurageCallAudioCore
import os
import UIKit

/// Debug builds only: runs the real `CallAudioEngine`, on the real audio
/// hardware, through the channel entry points the workspace's dispatch
/// calls, with the argument dictionaries the page sends: open, the bundled
/// fixture MP3 in 64 KB base64 pieces, pause, resume, stop, the same clip
/// again to its end, the pulse, then close. Every event and reply is logged
/// as fixed words (event types, clip states and reasons are the engine's
/// own fixed sets; never audio or ids) to os_log and to
/// Documents/call-audio-selftest.log. Started from the spike screen's
/// "Channel self-test" button, or with `-murageCallAudioSelfTest`.
@MainActor
final class CallAudioSelfTest {
    private static let logger = Logger(subsystem: "com.murage.mobile", category: "shell")
    private static let file: URL? = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
        .appendingPathComponent("call-audio-selftest.log")

    private let engine = CallAudioEngine()
    private let fixture: URL?
    private var states: [String] = []
    private var micFrames = 0
    private var progress = 0
    private var failures = 0
    var onLine: ((String) -> Void)?

    init(fixture: URL?) {
        self.fixture = fixture
    }

    func run() async {
        if let file = Self.file { try? FileManager.default.removeItem(at: file) }
        line("start")
        engine.sink = { [weak self] event, done in
            self?.record(event.detail)
            done(true)
        }
        guard let fixture, let bytes = try? Data(contentsOf: fixture) else { return finish(fail: "no fixture") }
        // A launch from a script runs this before the app is active: the
        // engine holds the open until it is (§4.2.10).
        let app = CallAudioAppState(UIApplication.shared.applicationState)
        let opened = await call { self.engine.open(app: app, reply: $0) }
        guard case let .opened(session) = opened else { return finish(fail: "open " + describe(opened)) }
        line("open opened")

        // Clip 1: pause, resume, then stop part-way.
        await play(bytes, session: session, clip: "selftest-1")
        await expect("playing", within: 4)
        await sleep(1.5)
        await control(session, "pause")
        await sleep(1)
        await control(session, "resume")
        await sleep(1)
        await control(session, "stop")
        await expect("cut/stop", within: 2)

        // Clip 2: played to the end, with the pulse over it.
        await play(bytes, session: session, clip: "selftest-2")
        await expect("playing", within: 4)
        await control(session, "pulseOn")
        await sleep(2.5)
        await control(session, "pulseOff")
        await expect("ended", within: 15)
        line("progress events \(progress)")
        if progress == 0 { failures += 1 }

        let closed = await call { self.engine.close(args: ["session": session], reply: $0) }
        line("close " + describe(closed))
        line("mic frames \(micFrames)")
        if micFrames == 0 { failures += 1 }
        finish(fail: failures == 0 ? nil : "\(failures) checks")
    }

    // MARK: steps

    /// 48 KB of source bytes is 64 KB of base64, the page's piece size.
    private func play(_ bytes: Data, session: String, clip: String) async {
        let size = 48 * 1024
        var seq = 0
        var offset = 0
        repeat {
            let piece = bytes.subdata(in: offset..<min(bytes.count, offset + size))
            offset += piece.count
            let args: [String: Any] = ["session": session, "clip": clip, "seq": seq, "mime": "audio/mpeg",
                                       "bytes": piece.base64EncodedString(), "last": offset >= bytes.count]
            let answer = await call { self.engine.play(args: args, reply: $0) }
            if case .ok = answer {} else { failures += 1 }
            seq += 1
        } while offset < bytes.count
        line("play pieces \(seq)")
    }

    private func control(_ session: String, _ action: String) async {
        let answer = await call { self.engine.control(args: ["session": session, "action": action], reply: $0) }
        line("control " + action + " " + describe(answer))
        if case .ok = answer {} else { failures += 1 }
    }

    private func expect(_ state: String, within seconds: Double) async {
        let deadline = Date().addingTimeInterval(seconds)
        while !states.contains(state), Date() < deadline { await sleep(0.05) }
        if states.contains(state) {
            states.removeAll()
        } else {
            failures += 1
            line("missing " + state)
        }
    }

    private func call(_ body: (@escaping CallAudioEngine.ReplyHandler) -> Void) async -> CallAudioEngine.Reply {
        await withCheckedContinuation { continuation in
            body { continuation.resume(returning: $0) }
        }
    }

    private func sleep(_ seconds: Double) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    // MARK: log

    private func record(_ detail: [String: String]) {
        switch detail["type"] {
        case "mic"?:
            micFrames += 1
        case "clip"?:
            let state = detail["state"] ?? "-"
            let word = detail["reason"].map { state + "/" + $0 } ?? state
            states.append(word)
            if state == "progress" { progress += 1 } else { line("event clip " + word) }
        case let type?:
            let extra = (detail["reason"] ?? detail["output"]).map { " " + $0 } ?? ""
            line("event " + type + extra)
        case nil:
            break
        }
    }

    private func describe(_ reply: CallAudioEngine.Reply) -> String {
        switch reply {
        case .ok: return "ok"
        case .opened: return "opened"
        case let .error(code): return "error " + code
        }
    }

    private func finish(fail: String?) {
        line(fail.map { "FAIL " + $0 } ?? "PASS")
    }

    private func line(_ text: String) {
        let text = "call audio selftest " + text
        Self.logger.info("\(text, privacy: .public)")
        onLine?(text)
        guard let file = Self.file, let data = (String(format: "%.3f ", Date().timeIntervalSince1970) + text + "\n").data(using: .utf8) else { return }
        if let handle = try? FileHandle(forWritingTo: file) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: file)
        }
    }
}
#endif
