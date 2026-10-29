import Foundation
import MurageShellCore
import Security

/// App-only, device-bound storage; deliberately outside the push access group.
@MainActor final class PhoneConsentStore: PhoneConsentStorage {
    private let operations: PhoneJobsTokenStore.Operations
    init(operations: PhoneJobsTokenStore.Operations = .keychain) { self.operations = operations }
    private func base(_ workspace: WorkspaceOrigin) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.murage.mobile.phone-consent",
         kSecAttrAccount as String: workspace.serialized,
         kSecAttrSynchronizable as String: false]
    }
    func remove(workspace: WorkspaceOrigin) throws {
        let status = operations.delete(base(workspace))
        guard status == errSecSuccess || status == errSecItemNotFound else { throw PhoneJobsMintError.storage }
    }
    func read(workspace: WorkspaceOrigin) throws -> PhoneConsent {
        var query = base(workspace)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        let (status, data) = operations.read(query)
        if status == errSecItemNotFound { return PhoneConsent() }
        guard status == errSecSuccess, let data,
              let consent = try? JSONDecoder().decode(PhoneConsent.self, from: data) else { throw PhoneJobsMintError.storage }
        return consent
    }
    func write(_ consent: PhoneConsent, workspace: WorkspaceOrigin) throws {
        let changes: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(consent),
                                     kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = operations.update(base(workspace), changes)
        if status == errSecItemNotFound {
            guard operations.add(base(workspace).merging(changes) { _, new in new }) == errSecSuccess else { throw PhoneJobsMintError.storage }
        } else if status != errSecSuccess { throw PhoneJobsMintError.storage }
    }
}
