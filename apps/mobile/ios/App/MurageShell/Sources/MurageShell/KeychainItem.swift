#if os(iOS)
import Foundation
import Security

/// What a Keychain read found. `failed` is not "empty": before the first
/// unlock after a reboot, for one, the item exists but cannot be read.
enum KeychainRead {
    case found(Data)
    case missing
    case failed(OSStatus)
}

/// One generic-password item. ThisDeviceOnly: never restored onto another
/// phone from a backup; AfterFirstUnlock: readable by a cold or background
/// launch that happens after the phone was unlocked once. No access group is
/// set, so only this app can read it; a Plan 3 extension would need one.
final class KeychainItem {
    private static let accessible = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    private let service: String
    private let account: String

    init(service: String, account: String) {
        self.service = service
        self.account = account
    }

    private var base: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    func read() -> KeychainRead {
        var query = base
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        switch status {
        case errSecSuccess:
            guard let data = value as? Data else { return .failed(errSecDecode) }
            return .found(data)
        case errSecItemNotFound:
            return .missing
        default:
            return .failed(status)
        }
    }

    /// Update in place, else add. The update restates the accessibility class
    /// so an item can never keep a weaker one.
    @discardableResult
    func write(_ data: Data) -> Bool {
        let changes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: Self.accessible]
        let status = SecItemUpdate(base as CFDictionary, changes as CFDictionary)
        if status == errSecItemNotFound {
            var query = base
            query[kSecValueData as String] = data
            query[kSecAttrAccessible as String] = Self.accessible
            return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
        }
        return status == errSecSuccess
    }

    /// errSecSuccess or errSecItemNotFound both mean the item is gone.
    @discardableResult
    func delete() -> OSStatus {
        SecItemDelete(base as CFDictionary)
    }
}
#endif
