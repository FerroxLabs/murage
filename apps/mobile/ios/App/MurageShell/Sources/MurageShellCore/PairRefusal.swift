import Foundation

/// The line a computer gave when it refused a pairing code, cleaned before the
/// phone shows it (1.0.16). The page that reports it is the computer's own
/// /enter page, but the text is still treated as untrusted: control and format
/// characters (bidi overrides, zero-width marks) are dropped, every kind of
/// white space becomes one space, and the result is trimmed and capped.
/// Twin of PairRefusal.java; both are driven by contract/pair-refusal.json.
public enum PairRefusal {
    public static let maxChars = 160

    public static func message(_ raw: String) -> String {
        var out = String.UnicodeScalarView()
        var pendingSpace = false
        for scalar in raw.unicodeScalars {
            let category = scalar.properties.generalCategory
            if category == .format { continue }
            if category == .control || scalar.properties.isWhitespace {
                pendingSpace = !out.isEmpty
                continue
            }
            if pendingSpace { out.append(" "); pendingSpace = false }
            out.append(scalar)
        }
        var capped = String.UnicodeScalarView(out.prefix(maxChars))
        while capped.last == " " { capped.removeLast() }
        return String(capped)
    }
}
