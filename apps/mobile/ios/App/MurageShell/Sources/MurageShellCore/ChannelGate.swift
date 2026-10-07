import Foundation

public enum ChannelMethod: String, CaseIterable, Sendable {
    case hello, ready, saveFile, openExternal, haptic, signOut, rePair, setRoute, showLauncher
    case registerPush, pushStatus, issuePushTokens, setBadgeCount
    // The page's own signal that a call is open or has really ended
    // (callbar-rereview.md M4, callbar-rereview2.md G3): originally added
    // for Android, which has no call-audio engine to ask, but iOS needs it
    // too — the native call-audio engine's own session closes and reopens
    // on every teardown (lost, Resume, a retry's stale close), not only a
    // real hang-up, so it cannot tell WorkspaceViewController when to
    // deliver a held route (it no longer has a property for this at all;
    // both platforms are page-signalled now). This is the one signal that
    // only ever follows startCall/endCall.
    case callSessionOpen, callSessionClose
    // One `[call-diag]` / `[call-trace]` console line from the page, kept in a
    // file on the device (DiagFile). Shared with Android.
    case diagLine
    // SEC-006: native fresh authentication for a high-risk Allow. Shared with
    // Android; dispatch is added with the iOS and Android handlers.
    case approveWithDevice
    // iPhone native call audio (spec §4.1). iOS only: Android's ChannelGate
    // never learns these names, so an Android page sending one gets
    // unknown_method, same as any other name it does not recognise.
    case callAudioOpen, callAudioClose, callAudioPlay, callAudioControl
}

/// Reply error codes. The page sees them as the rejected promise's message.
public enum ChannelError: String, Error, Sendable {
    case unavailable
    case unknownMethod = "unknown_method"
    case badArgs = "bad_args"
    case tooLarge = "too_large"
    case foreignURL = "foreign_url"
    case busy
    case downloadFailed = "download_failed"
    case writeFailed = "write_failed"
    case cancelled
    case noLock = "no_lock"
    case noKey = "no_key"
}

public struct ChannelRequest {
    public let method: ChannelMethod
    public let args: [String: Any]
}

public enum ChannelGate {
    public static let version = ShellInfo.channelVersion

    /// What hello() lists (Decision 3). The page keeps only names it knows
    /// (src/lib/native-shell.ts parseNativeHello), so an unlisted method is
    /// never called.
    public static let advertised: [ChannelMethod] = [.ready, .saveFile, .openExternal, .haptic, .signOut, .rePair, .setRoute, .showLauncher,
                                                     .registerPush, .pushStatus, .issuePushTokens, .setBadgeCount,
                                                     .callSessionOpen, .callSessionClose, .diagLine, .approveWithDevice,
                                                     .callAudioOpen, .callAudioClose, .callAudioPlay, .callAudioControl]

    /// Spec §2: main frame only, and the frame's origin must be the saved one.
    public static func admit(isMainFrame: Bool, frameOrigin: WorkspaceOrigin?, saved: WorkspaceOrigin) -> Bool {
        isMainFrame && frameOrigin == saved
    }

    public static func parse(_ body: Any?) -> Result<ChannelRequest, ChannelError> {
        guard let object = body as? [String: Any], let name = object["method"] as? String else { return .failure(.badArgs) }
        guard let method = ChannelMethod(rawValue: name) else { return .failure(.unknownMethod) }
        guard let raw = object["args"], !(raw is NSNull) else { return .success(ChannelRequest(method: method, args: [:])) }
        guard let args = raw as? [String: Any] else { return .failure(.badArgs) }
        return .success(ChannelRequest(method: method, args: args))
    }

    public static func hello() -> [String: Any] {
        ["version": version, "methods": advertised.map(\.rawValue)]
    }
}

public enum HapticKind: String, Sendable {
    case tap, success, warning, error
}

public enum ChannelArgs {
    public static func string(_ value: Any?, max: Int) -> String? {
        guard let text = value as? String, text.utf16.count <= max else { return nil }
        return text
    }

    /// `diagLine({line})`: a string of at most 600 UTF-16 units that starts
    /// with `[call-diag]` or `[call-trace]` and holds no control character.
    /// The page already caps and cleans it; this is the native check.
    public static func diagLine(_ args: [String: Any]) -> String? {
        guard let line = string(args["line"], max: 600),
              line.hasPrefix("[call-diag]") || line.hasPrefix("[call-trace]"),
              !line.unicodeScalars.contains(where: { $0.properties.generalCategory == .control }) else { return nil }
        return line
    }

    /// A JSON integer in 0…2^31−1: int32 on both twins, and no caller
    /// (size, index) takes a negative. JSON booleans and fractions arrive as
    /// NSNumber too, so both are refused explicitly.
    public static func int(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard double.rounded() == double, double >= 0, double <= Double(Int32.max) else { return nil }
        return number.intValue
    }

    /// `openExternal(url)`: the system browser, mail or phone, by the
    /// openExternal rule in src/lib/native-contract.test.ts (channel.json
    /// externalUrls), applied to the raw text before URL(string:) can drop or
    /// encode anything:
    ///   1. any Cc, Zs, Zl, Zp or "\" → refused
    ///   2. scheme `[A-Za-z][A-Za-z0-9+.-]*:`, one of http, https, mailto, tel
    ///   3. http(s): "//", then after any userinfo a non-empty host with no
    ///      ":" and optionally ":" plus digits
    ///   4. mailto: no `attach` or `attachment` parameter, %XX-decoded, any case
    ///   5. Swift only: URL(string:) must also parse it, which can only refuse more
    public static func externalURL(_ args: [String: Any]) -> URL? {
        guard let raw = string(args["url"], max: 4096), !raw.unicodeScalars.contains(where: WorkspaceOrigin.unsafe),
              let (scheme, rest) = splitScheme(raw) else { return nil }
        switch scheme.lowercased() {
        case "http", "https": guard hasHost(rest) else { return nil }
        case "tel": break
        case "mailto": guard !attaches(rest) else { return nil }
        default: return nil
        }
        return URL(string: raw)
    }

    /// `[A-Za-z][A-Za-z0-9+.-]*:` at the start: the scheme and what follows the colon.
    static func splitScheme(_ raw: String) -> (scheme: String, rest: Substring.UnicodeScalarView)? {
        let scalars = raw.unicodeScalars
        guard let colon = scalars.firstIndex(of: ":"), colon != scalars.startIndex else { return nil }
        let scheme = scalars[..<colon]
        guard let first = scheme.first, first.isASCII, first.properties.isAlphabetic,
              scheme.allSatisfy({ $0.isASCII && ($0.properties.isAlphabetic || ("0"..."9").contains($0) || "+.-".unicodeScalars.contains($0)) })
        else { return nil }
        return (String(String.UnicodeScalarView(scheme)), scalars[scalars.index(after: colon)...])
    }

    private static func hasHost(_ rest: Substring.UnicodeScalarView) -> Bool {
        guard rest.starts(with: "//".unicodeScalars) else { return false }
        let authority = rest.dropFirst(2).prefix { $0 != "/" && $0 != "?" && $0 != "#" }
        var host = Array(authority.lastIndex(of: "@").map { authority[authority.index(after: $0)...] } ?? authority)
        let digits = host.reversed().prefix { ("0"..."9").contains($0) }.count
        if host.count > digits, host[host.count - digits - 1] == ":" { host.removeLast(digits + 1) }
        return !host.isEmpty && !host.contains(":")
    }

    /// Some mail apps attach a local file named by `?attach=` or `?attachment=`.
    private static func attaches(_ rest: Substring.UnicodeScalarView) -> Bool {
        guard let question = rest.firstIndex(of: "?") else { return false }
        let query = rest[rest.index(after: question)...].prefix { $0 != "#" }
        return query.split(separator: "&", omittingEmptySubsequences: false).contains { pair in
            let name = decode(pair.prefix { $0 != "=" }).lowercased()
            return name == "attach" || name == "attachment"
        }
    }

    /// Each %XX becomes the code point XX, as the oracle decodes it.
    private static func decode(_ text: Substring.UnicodeScalarView.SubSequence) -> String {
        let scalars = Array(text)
        var out = String.UnicodeScalarView()
        var i = 0
        while i < scalars.count {
            if scalars[i] == "%", i + 2 < scalars.count,
               scalars[i + 1].properties.isASCIIHexDigit, scalars[i + 2].properties.isASCIIHexDigit,
               let byte = UInt8(String(String.UnicodeScalarView(scalars[(i + 1)...(i + 2)])), radix: 16) {
                out.append(Unicode.Scalar(byte))
                i += 3
            } else {
                out.append(scalars[i])
                i += 1
            }
        }
        return String(out)
    }

    public enum Route: Equatable {
        case thread(String)
        case keep
        case invalid
    }

    /// `setRoute({threadId})` (Decision 2). A null thread keeps the last one.
    public static func route(_ args: [String: Any]) -> Route {
        guard let raw = args["threadId"], !(raw is NSNull) else { return .keep }
        guard let thread = raw as? String, OpenHash.valid(thread) else { return .invalid }
        return .thread(thread)
    }
}
