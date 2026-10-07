import Foundation

/// SEC-006: the fields `approveWithDevice` signs (apps/mobile/contract/approval-proof.json).
/// Native builds the bytes from validated fields; it never signs bytes the page made.
public struct ApprovalRequest: Equatable, Sendable {
    public let threadId: String, requestId: String, decision: String, digest: String, nonce: String
    public let expiresAt: Int64
    public let reason: String

    /// Exact ASCII check by scalar, no regex: ICU `$` lets a trailing line terminator through.
    private static func ascii(_ value: String, count: ClosedRange<Int>, hexOnly: Bool) -> Bool {
        let bytes = Array(value.utf8)
        guard count.contains(bytes.count), bytes.count == value.unicodeScalars.count else { return false }
        return bytes.allSatisfy { byte in
            let digit = byte >= 0x30 && byte <= 0x39
            if hexOnly { return digit || (byte >= 0x61 && byte <= 0x66) }
            return digit || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte == 0x2d || byte == 0x5f
        }
    }

    /// A control character (C0, DEL, C1) or a Unicode line or paragraph separator.
    private static func hasFraming(_ text: String) -> Bool {
        text.unicodeScalars.contains(where: { $0.properties.generalCategory == .control || $0 == "\u{2028}" || $0 == "\u{2029}" })
    }

    /// Framing, or any format (Cf) character: bidi controls, zero-width characters, BOM, U+061C.
    /// Refused, never stripped, so the signed reason is what the card showed.
    private static func hasHiddenText(_ text: String) -> Bool {
        hasFraming(text) || text.unicodeScalars.contains(where: { $0.properties.generalCategory == .format })
    }

    /// The contract: 1 to 256 UTF-16 units (the desktop counts the same way), no framing character.
    private static func validRequestId(_ value: String) -> Bool {
        (1...256).contains(value.utf16.count) && !hasFraming(value)
    }

    public static func parse(_ args: [String: Any]) -> ApprovalRequest? {
        guard IssuedTokens.channelInteger(args["v"]) == 1,
              let threadId = args["threadId"] as? String, ascii(threadId, count: 1...128, hexOnly: false),
              let requestId = args["requestId"] as? String, validRequestId(requestId),
              let decision = args["decision"] as? String, decision == "allow" || decision == "allow-task",
              let digest = args["digest"] as? String, ascii(digest, count: 64...64, hexOnly: true),
              let nonce = args["nonce"] as? String, ascii(nonce, count: 43...43, hexOnly: false),
              let expiresAt = IssuedTokens.channelInteger(args["expiresAt"]), expiresAt > 0,
              let reason = ChannelArgs.string(args["reason"], max: 160), !reason.isEmpty,
              !hasHiddenText(reason)
        else { return nil }
        return ApprovalRequest(threadId: threadId, requestId: requestId, decision: decision, digest: digest, nonce: nonce, expiresAt: expiresAt, reason: reason)
    }

    public var message: Data {
        Data([ApprovalProof.tag, threadId, requestId, decision, digest, nonce, String(expiresAt)].joined(separator: "\n").utf8)
    }
}

public enum ApprovalProof {
    public static let tag = "murage-approval-proof/1"
    public static func validPoint(_ data: Data) -> Bool { data.count == 65 && data.first == 0x04 }
    public static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    /// Strict: unpadded base64url only, canonical (no stray trailing bits).
    public static func data(base64url text: String) -> Data? {
        guard text.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x61 && $0 <= 0x7a) || $0 == 0x2d || $0 == 0x5f }),
              text.utf8.count % 4 != 1 else { return nil }
        var base = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base.count % 4 != 0 { base += "=" }
        guard let data = Data(base64Encoded: base), base64url(data) == text else { return nil }
        return data
    }
}
