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
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: connectionId,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        // Add first, and only delete when the add says something is already
        // there. Deleting up front is the tidier-looking order and it is the
        // wrong one: if the add then fails — the device locked before first
        // unlock, the keychain is unavailable mid-restore — the old token is
        // already gone, and the phone is signed out of a computer it was
        // perfectly able to reach a second ago. The failure this guards is
        // the one where re-pairing hurts, because the user has to walk to the
        // machine to get a new code.
        var status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecDuplicateItem {
            // Update in place rather than delete-then-add: it is one atomic
            // step, so there is no window in which no token exists at all.
            let identity: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: connectionId,
            ]
            status = SecItemUpdate(
                identity as CFDictionary,
                [
                    kSecValueData as String: data,
                    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                ] as CFDictionary
            )
            // An item that exists for `add` and is missing for `update` means
            // something else removed it in between. Adding again is the whole
            // recovery, and by now nothing is being lost by trying.
            if status == errSecItemNotFound {
                status = SecItemAdd(query as CFDictionary, nil)
            }
        }
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
