import Foundation

/// A workspace is an HTTPS origin the phone can reach (spec §2). The saved
/// origin, a frame's security origin and every navigation URL are compared
/// through this one type, so they are normalised the same way: lower-case
/// host, and the default port folded away. WKSecurityOrigin reports the
/// default port as 0 (Phase 0 findings, "iOS channel").
///
/// The rule is exactly apps/mobile/contract/origins.json, whose oracle is
/// `workspaceOrigin` in src/lib/native-contract.test.ts, applied to the raw
/// text. It is the only parser here: URLComponents is never consulted, since
/// it drops tabs and newlines, percent-decodes and IDNA-decodes hosts and
/// unwraps IPv6 brackets, and it refuses characters (`|^[]{}`, non-ASCII in
/// a path) that WebKit loads on the same origin.
///   1. trim U+0020 from both ends; any Cc, Zs, Zl, Zp or "\" → nil
///   2. `https://` (scheme case-insensitive, exactly two slashes), then the
///      authority up to the first "/", "?" or "#"
///   3. no "@" in the authority at all
///   4. host: ASCII letters, digits, "." and "-" only, then lower-cased
///   5. labels: one trailing dot is allowed and kept; otherwise no empty
///      label and no label that starts or ends with "-"
///   6. not an IP: the last label must not start with a digit
///   7. port: absent or empty → 443; otherwise ASCII digits, 1–65535 by value
///      (so 0443 is 443); 443 is not written out
public struct WorkspaceOrigin: Hashable, Sendable {
    public let host: String
    public let port: Int

    public init?(string: String) {
        guard let parsed = Self.parse(string) else { return nil }
        self = parsed
    }

    /// The same rule, applied to `url.absoluteString`: no blob: or data:
    /// unwrapping, so neither is ever on a workspace origin. Foundation may
    /// already have percent-encoded that string (a "\" becomes "%5C"), and
    /// the rule refuses the result wherever it lands in the authority.
    public init?(url: URL) {
        guard let parsed = Self.parse(url.absoluteString) else { return nil }
        self = parsed
    }

    /// From a frame's security origin. Port 0 means "the scheme's default".
    public init?(scheme: String, host: String, port: Int) {
        guard scheme.lowercased() == "https", let host = Self.validHost(Substring(host)) else { return nil }
        let normalised = port == 0 ? 443 : port
        guard (1...65535).contains(normalised) else { return nil }
        self.host = host
        self.port = normalised
    }

    private init(host: String, port: Int) {
        self.host = host
        self.port = port
    }

    public var serialized: String { port == 443 ? "https://\(host)" : "https://\(host):\(port)" }

    // Force-unwrap is safe: host is [a-z0-9.-] and port is 1–65535.
    public var url: URL { URL(string: serialized)! }

    /// `path` starts with "/" and may carry a fragment (`/#open=…`,
    /// `/enter#…`). Anything else would run into the authority
    /// ("@evil.example/" turns the saved host into a userinfo), so it is nil.
    public func url(path: String) -> URL? {
        guard path.hasPrefix("/") else { return nil }
        return URL(string: serialized + path)
    }

    public func contains(_ url: URL?) -> Bool { url.flatMap(WorkspaceOrigin.init(url:)) == self }

    /// What the launcher sends (typed or pasted) and what the scanner reads,
    /// trimmed at both ends before `init(string:)`: Unicode Zs, Zl and Zp,
    /// U+0009 to U+000D and U+0085. Exactly Java's WorkspaceOrigin.trimInput
    /// and the TS launcher's (contract/trim.json). Not Foundation's
    /// `.whitespacesAndNewlines`, which also trims U+200B (final review M4).
    public static func trimInput(_ value: String) -> String {
        var scalars = Substring(value).unicodeScalars
        while let first = scalars.first, trimmable(first) { scalars.removeFirst() }
        while let last = scalars.last, trimmable(last) { scalars.removeLast() }
        return String(scalars)
    }

    private static func trimmable(_ scalar: Unicode.Scalar) -> Bool {
        if (0x09...0x0D).contains(scalar.value) || scalar.value == 0x85 { return true }
        switch scalar.properties.generalCategory {
        case .spaceSeparator, .lineSeparator, .paragraphSeparator: return true
        default: return false
        }
    }

    // MARK: - The rule

    private static func parse(_ input: String) -> WorkspaceOrigin? {
        var text = Substring(input)
        while text.unicodeScalars.first == " " { text = Substring(text.unicodeScalars.dropFirst()) }
        while text.unicodeScalars.last == " " { text = Substring(text.unicodeScalars.dropLast()) }
        guard !text.unicodeScalars.contains(where: unsafe) else { return nil }

        let scalars = text.unicodeScalars
        guard scalars.count >= 8, String(String.UnicodeScalarView(scalars.prefix(8))).lowercased() == "https://" else { return nil }
        let rest = scalars.dropFirst(8)
        let authority = rest.prefix { $0 != "/" && $0 != "?" && $0 != "#" }
        guard !authority.contains("@") else { return nil }

        let parts = authority.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count <= 2, let host = validHost(Substring(parts[0])) else { return nil }
        var port = 443
        if parts.count == 2, !parts[1].isEmpty {
            guard let value = portValue(parts[1]) else { return nil }
            port = value
        }

        return WorkspaceOrigin(host: host, port: port)
    }

    /// Controls, any Unicode space or separator, and "\" (see
    /// src/lib/native-contract.test.ts UNSAFE). ChannelArgs and SaveRequest
    /// apply it to the raw text before any URL parser sees it.
    static func unsafe(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .control, .spaceSeparator, .lineSeparator, .paragraphSeparator: return true
        default: return scalar == "\\"
        }
    }

    /// Steps 4–6. ASCII is checked before lower-casing, so a character that
    /// lower-cases into ASCII (U+212A KELVIN SIGN → "k") is refused too.
    private static func validHost(_ raw: Substring) -> String? {
        let allowed = raw.unicodeScalars.allSatisfy { scalar in
            scalar.isASCII && (scalar.properties.isAlphabetic || ("0"..."9").contains(scalar) || scalar == "." || scalar == "-")
        }
        guard !raw.isEmpty, allowed else { return nil }
        let host = raw.lowercased()
        let labels = (host.hasSuffix(".") ? String(host.dropLast()) : host).split(separator: ".", omittingEmptySubsequences: false)
        guard labels.allSatisfy({ !$0.isEmpty && !$0.hasPrefix("-") && !$0.hasSuffix("-") }),
              let first = labels.last?.unicodeScalars.first, !("0"..."9").contains(first) else { return nil }
        return host
    }

    /// Step 7, without overflow: leading zeros are dropped before the length
    /// check, so "0443" is 443 and a 20-digit port is refused.
    private static func portValue(_ digits: Substring.UnicodeScalarView.SubSequence) -> Int? {
        guard digits.allSatisfy({ ("0"..."9").contains($0) }) else { return nil }
        let significant = digits.drop { $0 == "0" }
        guard significant.count <= 5, let value = Int(String(String.UnicodeScalarView(significant))),
              (1...65535).contains(value) else { return nil }
        return value
    }
}
