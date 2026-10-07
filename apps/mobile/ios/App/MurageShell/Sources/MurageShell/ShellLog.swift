#if os(iOS)
import Foundation
import MurageCallAudioCore
import MurageShellCore
import os

/// Content-free logging (Global Constraints): methods, status codes, hosts,
/// byte counts and timings. Never a cookie, a credential, the /enter
/// fragment, message text or a thread id. Lines are `.public` so E2E can
/// read them (P25); the API takes only compile-time event names, numbers,
/// a host and an error domain, so no free text can reach the log.
enum ShellLog {
    private static let logger = Logger(subsystem: "com.murage.mobile", category: "shell")

    /// Content-free lines that outlive the process: `.info` os_log lines are
    /// gone the moment the app exits, so a report made without the phone in
    /// hand had nothing to read (moss-approval-bug.md). Mirrors
    /// CallAudioSelfTest's own Documents file, generalized to push taps,
    /// push actions and call-audio lifecycle events — never everything
    /// ShellLog logs, to keep the writes rare. Caches, not Documents: this
    /// is a debugging aid, not user data, and Caches is excluded from an
    /// iCloud or iTunes backup by the system without needing a resource
    /// value set on the file (callbar-review.md M6).
    private static let diagnosticsFile: URL? = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
        .appendingPathComponent("murage-diagnostics.log")
    private static let diagnosticsMaxBytes = 512 * 1024
    /// One writer for the file: `callAudio(_:)` runs on the call-audio
    /// queue and `event(_:status:persist:)` on push/channel callers' own
    /// queues (often main); without this, a trim's read-then-rewrite on
    /// one queue can race an append through an open `FileHandle` on
    /// another and lose lines (callbar-review.md M6). Also keeps every
    /// write off the caller's own queue — the call-audio queue especially,
    /// where disk I/O must never delay mic-frame handling.
    private static let diagnosticsQueue = DispatchQueue(label: "com.murage.mobile.diagnostics-log")

    private static func persist(_ text: String) {
        let line = String(format: "%.3f ", Date().timeIntervalSince1970) + text + "\n"
        diagnosticsQueue.async {
            guard let file = diagnosticsFile, let data = line.data(using: .utf8) else { return }
            if let handle = try? FileHandle(forWritingTo: file) {
                handle.seekToEndOfFile()
                handle.write(data)
                try? handle.close()
            } else {
                try? data.write(to: file)
            }
            trimDiagnosticsIfNeeded(file)
        }
    }

    /// Keeps the file from growing without bound: drops the older half once
    /// past the cap. Best effort — a failed trim just keeps logging.
    private static func trimDiagnosticsIfNeeded(_ file: URL) {
        guard let size = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.size] as? Int,
              size > diagnosticsMaxBytes else { return }
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return }
        let lines = text.split(separator: "\n")
        let kept = lines.suffix(lines.count / 2).joined(separator: "\n") + "\n"
        try? kept.write(to: file, atomically: true, encoding: .utf8)
    }

    /// The page's `[call-diag]` / `[call-trace]` lines (channel `diagLine`),
    /// appended as `ISO8601 <line>` to Caches/murage-call-diag.log. Caches,
    /// next to murage-diagnostics.log: the app does not enable
    /// UIFileSharingEnabled, so Documents would not be visible in Files either.
    /// Written off the caller's queue; the channel logs only accept/refuse.
    private static let callDiagFile: DiagFile? = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        .map { DiagFile(url: $0.appendingPathComponent(DiagFile.fileName)) }
    private static let callDiagQueue = DispatchQueue(label: "com.murage.mobile.call-diag-log", qos: .utility)

    static func callDiag(_ line: String) {
        let now = Date()
        callDiagQueue.async { callDiagFile?.append(line, at: now) }
    }

    /// A fixed event, with an optional OSStatus or similar code. `persist`
    /// also writes it to Caches/murage-diagnostics.log: set for push
    /// taps and push actions, the two paths moss-approval-bug.md found
    /// nothing durable logging.
    static func event(_ name: StaticString, status: Int? = nil, persist shouldPersist: Bool = false) {
        let text = String(describing: name)
        if let status {
            logger.info("\(text, privacy: .public) status=\(status, privacy: .public)")
            if shouldPersist { persist("\(text) status=\(status)") }
        } else {
            logger.info("\(text, privacy: .public)")
            if shouldPersist { persist(text) }
        }
    }

    /// A fixed event with a host (never a path, query or fragment).
    static func host(_ name: StaticString, host: String) {
        logger.info("\(String(describing: name), privacy: .public) host=\(host, privacy: .public)")
    }

    /// A fixed name and a number, as `name=value`.
    static func value(_ name: StaticString, _ value: Int) {
        logger.info("\(String(describing: name), privacy: .public)=\(value, privacy: .public)")
    }

    /// A fixed event with a duration.
    static func timing(_ name: StaticString, ms: Int) {
        logger.info("\(String(describing: name), privacy: .public) ms=\(ms, privacy: .public)")
    }

    /// The workspace channel (P15): the method or refusal code is an enum
    /// raw value; a dropped call logs the frame kind and host only.
    /// `callAudioPlay` carries a clip in pieces and is not logged per call
    /// (spec §4.2.11).
    static func channelAccepted(_ method: ChannelMethod) {
        guard method != .callAudioPlay else { return }
        logger.info("channel accept method=\(method.rawValue, privacy: .public)")
    }

    static func channelRefused(_ error: ChannelError) {
        logger.info("channel refuse error=\(error.rawValue, privacy: .public)")
    }

    static func channelDropped(mainFrame: Bool, host: String?) {
        logger.info("channel drop main=\(mainFrame, privacy: .public) host=\(host ?? "opaque", privacy: .public)")
    }

    /// A main-document response on the saved origin. `path=/enter` is a fixed
    /// word for the door's pairing page (never its fragment); no other path is logged.
    static func mainDocument(status: Int, enter: Bool) {
        logger.info("main-document status=\(status, privacy: .public)\(enter ? " path=/enter" : "", privacy: .public)")
    }

    /// A failed workspace load: the NSError domain constant and code, and what it meant.
    static func navigationFailed(_ name: StaticString, domain: String, code: Int, outcome: LoadFailure?) {
        let meaning = outcome.map { String(describing: $0) } ?? "-"
        logger.info("\(String(describing: name), privacy: .public) error=\(domain, privacy: .public)/\(code, privacy: .public) outcome=\(meaning, privacy: .public)")
    }

    /// `bytes` is nil when the body was not read (a non-200) or passed the cap.
    static func probe(host: String, status: Int, bytes: Int?, mode: String, ms: Int) {
        logger.info("probe host=\(host, privacy: .public) status=\(status, privacy: .public) bytes=\(bytes ?? -1, privacy: .public) mode=\(mode, privacy: .public) ms=\(ms, privacy: .public)")
    }

    /// `domain` is an NSError domain constant (NSURLErrorDomain and so on), never a description.
    static func probeFailed(host: String, domain: String, code: Int, mode: String, ms: Int) {
        logger.info("probe host=\(host, privacy: .public) error=\(domain, privacy: .public)/\(code, privacy: .public) mode=\(mode, privacy: .public) ms=\(ms, privacy: .public)")
    }

    /// Native call audio (spec §4.2.11): the reducer's fixed lines, built
    /// only from its enums (never audio, text or a clip or session id).
    /// Always persisted: hold, resume, lost and close are exactly what a
    /// call-audio report needs and are rare enough to afford the write.
    static func callAudio(_ line: CallAudioLog) {
        logger.info("\(line.message, privacy: .public)")
        persist(line.message)
    }

    /// P17: why the workspace screen closed, as the enum's raw value.
    static func closed(_ reason: CloseReason) {
        logger.info("workspace closed reason=\(reason.rawValue, privacy: .public)")
    }

    #if DEBUG
    /// Debug builds only: the E2E probe's JSON (P25). The fixed probe script
    /// builds it from typeof checks, reply codes and a CSS length; no page
    /// content, cookie or credential is in it.
    static func e2eProbe(_ json: String) {
        logger.info("e2e probe \(json, privacy: .public)")
    }

    /// Debug builds only: what registerPush decided and why (the iPhone
    /// churn of 2026-09-28). The plan and permission are fixed words and the
    /// rest are booleans; never a binding id or a token.
    static func pushPlan(_ d: PushEnrolment.Decision) {
        logger.info("push register plan=\(d.plan.rawValue, privacy: .public) permission=\(d.permission, privacy: .public) bound=\(d.bound, privacy: .public) detail=\(d.hasDetail, privacy: .public) fresh=\(d.fresh, privacy: .public)")
    }
    #endif
}

func ms(since start: Date) -> Int { Int(Date().timeIntervalSince(start) * 1000) }
#endif
