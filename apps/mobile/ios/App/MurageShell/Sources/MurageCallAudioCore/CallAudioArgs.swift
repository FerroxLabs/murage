import Foundation

// Spec §4.1: the arguments of callAudioPlay, callAudioControl and
// callAudioClose, with every limit. ChannelGate hands over the raw args
// dictionary; these parsers decide. The per-piece limits are pinned in
// apps/mobile/contract/channel.json `callAudioRequests`; the rules that need
// a sequence of pieces (seq order, after `last`, one clip at a time, 8 MB)
// live in ClipIntake below.

/// The reply errors these parsers produce. The raw values are the channel's
/// (MurageShellCore `ChannelError`), which this target cannot import.
public enum CallAudioArgError: String, Error, Sendable {
    case badArgs = "bad_args"
    case unavailable
}

/// The labels native accepts. The page normalises its MIME type before
/// sending (parameters dropped, `audio/mp3` and `audio/mpeg3` → `audio/mpeg`,
/// `audio/wave` and `audio/x-wav` → `audio/wav`), so anything else is refused.
public enum CallAudioMime: String, CaseIterable, Sendable {
    case mpeg = "audio/mpeg"
    case wav = "audio/wav"
    case aac = "audio/aac"
    case mp4 = "audio/mp4"
}

public enum CallAudioLimits {
    /// Clip ids are a page counter plus the session.
    public static let maxClipChars = 64
    /// Session ids are ours (`callAudioOpen`); anything longer is not one.
    public static let maxSessionChars = 64
    /// The hard cap of base64 text per piece. The page sends 64 KB pieces.
    public static let maxPieceBase64 = 256 * 1024
    /// Source bytes one clip may hold.
    public static let maxClipBytes = 8 * 1024 * 1024
}

/// Which session the page may talk to. After `lost`, the old session answers
/// `unavailable`; any other unknown session is `bad_args`.
public struct CallAudioSessions: Sendable {
    public var open: String?
    public private(set) var lost: Set<String> = []

    public init(open: String? = nil) {
        self.open = open
    }

    /// The engine could not be kept: the open session ends for good.
    public mutating func lose() {
        if let open { lost.insert(open) }
        open = nil
    }

    /// Whether a `callAudioClose` for `session` closes the open session. A
    /// stale or unknown one is a no-op `true` for the page.
    public func closes(_ session: String) -> Bool {
        session == open
    }

    func check(_ value: Any?) -> CallAudioArgError? {
        guard let session = CallAudioParse.string(value, max: CallAudioLimits.maxSessionChars) else { return .badArgs }
        if session == open { return nil }
        return lost.contains(session) ? .unavailable : .badArgs
    }
}

/// A refused piece. `clip` is set when the request named a clip of the open
/// session, so a live clip can be failed once (§4.1).
public struct CallAudioArgRefusal: Error, Equatable, Sendable {
    public let error: CallAudioArgError
    public let clip: String?

    public init(error: CallAudioArgError, clip: String?) {
        self.error = error
        self.clip = clip
    }
}

/// `callAudioPlay({ session, clip, seq, mime, bytes, last, paused? })`.
public struct CallAudioPlayArgs: Equatable, Sendable {
    public let clip: String
    public let seq: Int
    public let mime: CallAudioMime
    public let bytes: Data
    public let last: Bool
    /// Only meaningful on seq 0: the clip fills its buffer but waits for `resume`.
    public let paused: Bool

    public init(clip: String, seq: Int, mime: CallAudioMime, bytes: Data, last: Bool, paused: Bool) {
        self.clip = clip
        self.seq = seq
        self.mime = mime
        self.bytes = bytes
        self.last = last
        self.paused = paused
    }

    public static func parse(_ args: [String: Any], sessions: CallAudioSessions) -> Result<CallAudioPlayArgs, CallAudioArgRefusal> {
        if let error = sessions.check(args["session"]) { return .failure(CallAudioArgRefusal(error: error, clip: nil)) }
        guard let clip = CallAudioParse.string(args["clip"], max: CallAudioLimits.maxClipChars), !clip.isEmpty else {
            return .failure(CallAudioArgRefusal(error: .badArgs, clip: nil))
        }
        let refused = Result<CallAudioPlayArgs, CallAudioArgRefusal>.failure(CallAudioArgRefusal(error: .badArgs, clip: clip))
        guard let seq = CallAudioParse.int(args["seq"]),
              let label = args["mime"] as? String, let mime = CallAudioMime(rawValue: label),
              let text = args["bytes"] as? String, text.utf8.count <= CallAudioLimits.maxPieceBase64,
              let bytes = Data(base64Encoded: text),
              let last = CallAudioParse.bool(args["last"])
        else { return refused }
        var paused = false
        if let value = args["paused"], !(value is NSNull) {
            guard let flag = CallAudioParse.bool(value) else { return refused }
            paused = flag
        }
        return .success(CallAudioPlayArgs(clip: clip, seq: seq, mime: mime, bytes: bytes, last: last, paused: paused))
    }
}

public enum CallAudioControlAction: String, CaseIterable, Sendable {
    case pause, resume, stop, pulseOn, pulseOff
}

/// `callAudioControl({ session, action })`.
public struct CallAudioControlArgs: Equatable, Sendable {
    public let action: CallAudioControlAction

    public static func parse(_ args: [String: Any], sessions: CallAudioSessions) -> Result<CallAudioControlArgs, CallAudioArgError> {
        if let error = sessions.check(args["session"]) { return .failure(error) }
        guard let name = args["action"] as? String, let action = CallAudioControlAction(rawValue: name) else { return .failure(.badArgs) }
        return .success(CallAudioControlArgs(action: action))
    }
}

/// `callAudioClose({ session })`. Any session string is accepted: a stale or
/// unknown one is a no-op (`CallAudioSessions.closes`).
public struct CallAudioCloseArgs: Equatable, Sendable {
    public let session: String

    public static func parse(_ args: [String: Any]) -> Result<CallAudioCloseArgs, CallAudioArgError> {
        guard let session = CallAudioParse.string(args["session"], max: CallAudioLimits.maxSessionChars) else { return .failure(.badArgs) }
        return .success(CallAudioCloseArgs(session: session))
    }
}

/// What ClipIntake makes of a well-formed piece.
public enum IntakeVerdict: Equatable, Sendable {
    /// seq 0 of a new clip. `replacing` is the clip it takes over from, if any.
    case first(replacing: String?)
    /// The next piece of the current clip.
    case next
    /// `bad_args`. `clip` is set when the piece belongs to the current clip,
    /// which then stays refused.
    case refuse(clip: String?)
}

/// The sequence rules of §4.1: `seq` counts up from 0 with no gaps, nothing
/// follows `last`, a clip holds at most 8 MB of source bytes, and a new
/// clip's seq 0 takes over from the current one.
public struct ClipIntake: Sendable {
    private var clip: String?
    private var nextSeq = 0
    private var bytes = 0
    private var closed = false

    public init() {}

    public mutating func admit(_ piece: CallAudioPlayArgs) -> IntakeVerdict {
        guard piece.clip == clip else {
            guard piece.seq == 0 else { return .refuse(clip: nil) }
            let previous = clip
            clip = piece.clip
            nextSeq = 1
            bytes = piece.bytes.count
            closed = piece.last
            return .first(replacing: previous)
        }
        guard !closed, piece.seq == nextSeq, bytes + piece.bytes.count <= CallAudioLimits.maxClipBytes else {
            closed = true
            return .refuse(clip: piece.clip)
        }
        nextSeq += 1
        bytes += piece.bytes.count
        closed = piece.last
        return .next
    }

    /// A piece of `clip` was refused before it got here (a bad label, an
    /// oversized piece): the rest of that clip is refused too.
    public mutating func refuse(clip: String) {
        if clip == self.clip { closed = true }
    }

    /// The session closed: forget the clip.
    public mutating func reset() {
        self = ClipIntake()
    }
}

enum CallAudioParse {
    static func string(_ value: Any?, max: Int) -> String? {
        guard let text = value as? String, text.utf16.count <= max else { return nil }
        return text
    }

    /// A JSON integer in 0…2^31−1, as MurageShellCore's ChannelArgs.int.
    /// JSON booleans and fractions arrive as NSNumber too, so both are refused.
    static func int(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard double.rounded() == double, double >= 0, double <= Double(Int32.max) else { return nil }
        return number.intValue
    }

    /// A JSON boolean only, never a number.
    static func bool(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }
}
