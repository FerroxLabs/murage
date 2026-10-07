import Foundation

/// The door's pairing page, `/enter#<credential>[&installId=<id>]`
/// (companion/src/browser.ts enterPage; Plan 1 A5).
public enum PairingLink {
    private static let credentialCharacters = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
    private static let installCharacters = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")

    /// A `murage_pair_…` token from the QR code, or the six digits typed in.
    /// No `&`, `#` or space can get through, so a credential cannot carry its
    /// own `&installId=`.
    public static func validCredential(_ value: String) -> Bool {
        (1...512).contains(value.unicodeScalars.count) && value.unicodeScalars.allSatisfy(credentialCharacters.contains)
    }

    /// Plan 1 A5 (companion/src/devices.ts INSTALL_ID): `/^[A-Za-z0-9._-]{16,128}$/`.
    public static func validInstallId(_ value: String?) -> Bool {
        guard let value else { return false }
        return (16...128).contains(value.unicodeScalars.count) && value.unicodeScalars.allSatisfy(installCharacters.contains)
    }

    /// The app's approval public key: an uncompressed P-256 point, 87 base64url characters.
    public static func validApprovalKey(_ value: String?) -> Bool {
        guard let value else { return false }
        return value.unicodeScalars.count == 87 && value.unicodeScalars.allSatisfy(credentialCharacters.contains)
    }

    /// The relay's statement for an install and key: `<40-1200 base64url>.<86 base64url>`
    /// (companion/src/relay-statement.ts verifyApprovalStatement).
    public static func validApprovalStatement(_ value: String?) -> Bool {
        guard let value else { return false }
        let parts = value.unicodeScalars.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 2, (40...1200).contains(parts[0].count), parts[1].count == 86 else { return false }
        return parts.allSatisfy { $0.allSatisfy(credentialCharacters.contains) }
    }

    /// `installId` is nil unless the probe answered `mobile: 1`: an older door
    /// reads the whole fragment as the credential (Review Focus 5).
    public static func enterPath(credential: String, installId: String?) -> String? {
        enterPath(credential: credential, installId: installId, approvalKey: nil, approvalStatement: nil)
    }

    /// `/enter#<credential>&installId=<id>[&approvalKey=<key>&approvalStatement=<statement>]`,
    /// the order the desktop's enter page parses (companion/src/browser.ts). A key and its
    /// statement go together or not at all: a key with no statement, or a statement with no
    /// key, is nil, so a bare key cannot be sent by API shape. Both need an install id.
    public static func enterPath(credential: String, installId: String?, approvalKey: String?, approvalStatement: String?) -> String? {
        guard validCredential(credential) else { return nil }
        guard (approvalKey == nil) == (approvalStatement == nil) else { return nil }
        guard let installId else { return approvalKey == nil ? "/enter#" + credential : nil }
        guard validInstallId(installId) else { return nil }
        let path = "/enter#\(credential)&installId=\(installId)"
        guard let approvalKey, let approvalStatement else { return path }
        guard validApprovalKey(approvalKey), validApprovalStatement(approvalStatement) else { return nil }
        return path + "&approvalKey=\(approvalKey)&approvalStatement=\(approvalStatement)"
    }

    /// What the pairing QR code on the computer holds: exactly
    /// `<origin>/enter#<credential>`, the origin by the WorkspaceOrigin rule.
    /// Anything else the camera sees (another app's code, a Wi-Fi code, a
    /// link with a query or its own installId) is nil (P17).
    public static func parse(_ text: String) -> (origin: WorkspaceOrigin, credential: String)? {
        guard text.unicodeScalars.count <= 4096, let origin = WorkspaceOrigin(string: text) else { return nil }
        var scalars = Substring(text).unicodeScalars
        while scalars.first == " " { scalars = scalars.dropFirst() }
        while scalars.last == " " { scalars = scalars.dropLast() }
        // WorkspaceOrigin has checked the eight-scalar `https://`.
        let rest = scalars.dropFirst(8)
        guard let hash = rest.firstIndex(of: "#") else { return nil }
        let head = rest[..<hash]
        guard let slash = head.firstIndex(where: { $0 == "/" || $0 == "?" }),
              String(String.UnicodeScalarView(head[slash...])) == "/enter" else { return nil }
        let credential = String(String.UnicodeScalarView(rest[rest.index(after: hash)...]))
        guard validCredential(credential) else { return nil }
        return (origin, credential)
    }

    public static func newInstallId(prefix: String, uuid: UUID = UUID()) -> String {
        prefix + "-" + uuid.uuidString.lowercased().replacingOccurrences(of: "-", with: "")
    }
}
