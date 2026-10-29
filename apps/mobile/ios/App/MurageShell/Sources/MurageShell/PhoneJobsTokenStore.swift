import Foundation
import MurageShellCore
import Security

/// App-only, per-origin bearer. Deliberately does not use SharedPushStore or
/// KeychainItem (whose AfterFirstUnlock policy permits background reads).
@MainActor
final class PhoneJobsTokenStore: PhoneJobsTokenWriting {
    struct Operations {
        var update: ([String: Any], [String: Any]) -> OSStatus
        var add: ([String: Any]) -> OSStatus
        var read: ([String: Any]) -> (OSStatus, Data?)
        var delete: ([String: Any]) -> OSStatus

        static let keychain = Operations(
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
    init(operations: Operations = .keychain) { self.operations = operations }

    private func base(_ origin: WorkspaceOrigin) -> [String: Any] {
        // Omit kSecAttrAccessGroup: the default application group, never the
        // com.murage.mobile.shared group used by the notification extension.
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.murage.mobile.phone-jobs",
         kSecAttrAccount as String: origin.serialized,
         kSecAttrSynchronizable as String: false]
    }

    func save(_ token: String, origin: WorkspaceOrigin) throws {
        guard PhoneJobsContract.tokenValid(token) else { throw PhoneJobsMintError.invalidResponse }
        let changes: [String: Any] = [kSecValueData as String: Data(token.utf8),
                                     kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = operations.update(base(origin), changes)
        if status == errSecItemNotFound {
            let item = base(origin).merging(changes) { _, new in new }
            guard operations.add(item) == errSecSuccess else { throw PhoneJobsMintError.storage }
        } else if status != errSecSuccess { throw PhoneJobsMintError.storage }
    }

    /// Only the foreground runner calls this. Locked/unreadable is an error,
    /// never treated as missing and never a reason to mint without the switch.
    func readForRunner(origin: WorkspaceOrigin) throws -> String? {
        var query = base(origin)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        let (status, data) = operations.read(query)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data, let token = String(data: data, encoding: .utf8),
              PhoneJobsContract.tokenValid(token) else { throw PhoneJobsMintError.storage }
        return token
    }

    static func savedOrigins() throws -> [WorkspaceOrigin] {
        var origins = Set<WorkspaceOrigin>()
        for service in ["com.murage.mobile.phone-jobs", "com.murage.mobile.phone-consent"] {
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service, kSecAttrSynchronizable as String: false,
                kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            if status == errSecItemNotFound { continue }
            guard status == errSecSuccess, let rows = result as? [[String: Any]] else { throw PhoneJobsMintError.storage }
            for row in rows {
                if let account = row[kSecAttrAccount as String] as? String, let origin = WorkspaceOrigin(string: account) { origins.insert(origin) }
            }
        }
        return Array(origins)
    }
    func remove(origin: WorkspaceOrigin) throws {
        let status = operations.delete(base(origin))
        guard status == errSecSuccess || status == errSecItemNotFound else { throw PhoneJobsMintError.storage }
    }
}
