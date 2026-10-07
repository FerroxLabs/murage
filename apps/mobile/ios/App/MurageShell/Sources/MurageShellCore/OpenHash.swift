import Foundation

/// `#open=<threadId>&msg=<messageId>` (spec §3.6), built so the page's
/// `parseOpenHash` (src/lib/deep-link.ts) reads back exactly these ids.
/// apps/mobile/contract/open-hash.json pins the output.
public enum OpenHash {
    /// src/lib/deep-link.ts and src/lib/native-shell.ts MAX_ID, counted in
    /// UTF-16 units the way JavaScript's `length` counts.
    public static let maxIdLength = 512

    public static func valid(_ id: String?) -> Bool {
        guard let id else { return false }
        return !id.isEmpty && id.utf16.count <= maxIdLength
    }

    /// nil for an invalid thread id; an invalid message id is left out, as
    /// the page would ignore it.
    public static func build(threadId: String, messageId: String? = nil) -> String? {
        guard valid(threadId) else { return nil }
        var hash = "#open=" + formEncode(threadId)
        if valid(messageId), let messageId { hash += "&msg=" + formEncode(messageId) }
        return hash
    }

    /// application/x-www-form-urlencoded, byte for byte what
    /// `URLSearchParams.toString()` emits: ASCII letters, digits and `*-._`
    /// stay, space becomes `+`, every other UTF-8 byte is `%XX`.
    public static func formEncode(_ value: String) -> String {
        var out = ""
        for byte in value.utf8 {
            switch byte {
            case UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "A")...UInt8(ascii: "Z"),
                 UInt8(ascii: "0")...UInt8(ascii: "9"),
                 UInt8(ascii: "*"), UInt8(ascii: "-"), UInt8(ascii: "."), UInt8(ascii: "_"):
                out.unicodeScalars.append(UnicodeScalar(byte))
            case UInt8(ascii: " "):
                out += "+"
            default:
                out += String(format: "%%%02X", byte)
            }
        }
        return out
    }
}
