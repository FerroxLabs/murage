import Foundation
import Security

/// Per-origin ask bearer, shared only with the ask extension group. Deliberately does not use SharedPushStore or
/// KeychainItem (whose AfterFirstUnlock policy permits background reads).
@MainActor
public final class PhoneAskTokenStore {
    public enum StoreError: Error { case storage, invalidResponse }

    public struct Operations {
        var update: ([String: Any], [String: Any]) -> OSStatus
        var add: ([String: Any]) -> OSStatus
        var read: ([String: Any]) -> (OSStatus, Data?)
        var delete: ([String: Any]) -> OSStatus

        public init(update: @escaping ([String: Any], [String: Any]) -> OSStatus,
                    add: @escaping ([String: Any]) -> OSStatus,
                    read: @escaping ([String: Any]) -> (OSStatus, Data?),
                    delete: @escaping ([String: Any]) -> OSStatus) {
            self.update = update; self.add = add; self.read = read; self.delete = delete
        }
        public static let keychain = Operations(
            update: { SecItemUpdate($0 as CFDictionary, $1 as CFDictionary) },
            add: { SecItemAdd($0 as CFDictionary, nil) },
            read: { query in
                var value: CFTypeRef?
                let status = SecItemCopyMatching(query as CFDictionary, &value)
                return (status, value as? Data)
            },
            delete: { SecItemDelete($0 as CFDictionary) }
        )
    }

    private let operations: Operations
    private let accessGroup: String?
    public init(operations: Operations = .keychain,
         accessGroup: String? = Bundle.main.object(forInfoDictionaryKey: "MurageAskKeychainGroup") as? String) {
        self.operations = operations; self.accessGroup = accessGroup
    }

    private func base(_ origin: WorkspaceOrigin) throws -> [String: Any] {
        // No default-group fallback: missing build expansion must fail closed.
        guard let accessGroup, accessGroup.hasSuffix(".com.murage.mobile.ask"),
              !accessGroup.contains("$"), accessGroup != ".com.murage.mobile.ask" else { throw StoreError.storage }
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: "com.murage.mobile.ask.token",
                kSecAttrAccessGroup as String: accessGroup,
                kSecAttrAccount as String: origin.serialized,
                kSecAttrSynchronizable as String: false]
    }

    public func save(_ token: String, origin: WorkspaceOrigin) throws {
        guard PhoneAskContract.tokenValid(token) else { throw StoreError.invalidResponse }
        let changes: [String: Any] = [kSecValueData as String: Data(token.utf8),
                                     kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = operations.update(try base(origin), changes)
        if status == errSecItemNotFound {
            let item = try base(origin).merging(changes) { _, new in new }
            guard operations.add(item) == errSecSuccess else { throw StoreError.storage }
        } else if status != errSecSuccess { throw StoreError.storage }
    }

    /// Share, outbox and native ask consumers only. Never prompts or mints.
    /// Keychain denies reads while locked, including after a prior unlock.
    public func readForAsk(origin: WorkspaceOrigin) throws -> String? {
        var query = try base(origin)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        let (status, data) = operations.read(query)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data, let token = String(data: data, encoding: .utf8),
              PhoneAskContract.tokenValid(token) else { throw StoreError.storage }
        return token
    }

    public func remove(origin: WorkspaceOrigin) throws {
        let status = operations.delete(try base(origin))
        guard status == errSecSuccess || status == errSecItemNotFound else { throw StoreError.storage }
    }
}
