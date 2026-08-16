// Device tokens, in the keychain.
//
// The token is the whole credential: anyone holding it can talk to the
// user's harness, which runs shell commands on their laptop. UserDefaults
// would be wrong for it, and so would anything that lands in an iCloud or
// iTunes backup — hence `ThisDeviceOnly`, which also matches the server's
// model, where a token belongs to one paired device and is revoked per
// device.
import Foundation
import Security

enum Keychain {
    private static let service = "com.openmausbot.companion.token"

    static func save(_ token: String, for connectionId: String) throws {
        let data = Data(token.utf8)
        // delete-then-add rather than SecItemUpdate: re-pairing replaces the
        // token, and an update against a missing item is an error path with
        // no upside here
        remove(connectionId)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: connectionId,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError(status: status)
        }
    }

    static func token(for connectionId: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: connectionId,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func remove(_ connectionId: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: connectionId,
        ]
        return SecItemDelete(query as CFDictionary) == errSecSuccess
    }
}

struct KeychainError: LocalizedError {
    let status: OSStatus

    var errorDescription: String? {
        let detail = SecCopyErrorMessageString(status, nil) as String? ?? "status \(status)"
        return "Couldn't save the pairing securely: \(detail)"
    }
}
