import Foundation
import MurageShellCore

/// Durable workspace choices. A provider is never inferred from generic consent.
struct PhoneConsent: Codable, Equatable {
    var enabled = false
    var sharing = false
    var providers: Set<String> = []
    var rows: Set<String> = []
}

@MainActor protocol PhoneConsentStorage {
    func read(workspace: WorkspaceOrigin) throws -> PhoneConsent
    func write(_ consent: PhoneConsent, workspace: WorkspaceOrigin) throws
}

extension PhoneConsentStorage {
    func needsProviderSheet(workspace: WorkspaceOrigin, providerId: String) throws -> Bool {
        let consent = try read(workspace: workspace)
        return !consent.sharing || !consent.providers.contains(providerId)
    }

    func recordProviderConsent(workspace: WorkspaceOrigin, providerId: String) throws {
        var consent = try read(workspace: workspace)
        guard consent.enabled, consent.sharing, !providerId.isEmpty else { throw PhoneJobsMintError.refused }
        consent.providers.insert(providerId)
        try write(consent, workspace: workspace)
    }

    /// N4 must call at the commit point, then re-read OS permission too.
    func readForCommit(workspace: WorkspaceOrigin, providerId: String, capability: String) throws -> Bool {
        let consent = try read(workspace: workspace)
        return consent.enabled && consent.sharing && consent.providers.contains(providerId) && consent.rows.contains(capability)
    }
}

@MainActor final class PhoneForBotsModel {
    static let rows = PhoneJobsContract.capabilities + ["precise"]
    let workspace: WorkspaceOrigin
    let store: PhoneConsentStorage
    private let token: () throws -> String?
    private let removeToken: () throws -> Void
    private let mint: () async throws -> Void
    private let available: () async throws -> Void
    private let permission: (String) -> Any?
    private let requestPermission: (String) async -> Void
    private let send: (String, String, [String: Any]?) async throws -> Void
    private let metadata: () -> [String: Any]
    private(set) var busy = false
    private var refreshPending = false

    init(workspace: WorkspaceOrigin, store: PhoneConsentStorage,
         token: @escaping () throws -> String?, removeToken: @escaping () throws -> Void,
         mint: @escaping () async throws -> Void, available: @escaping () async throws -> Void,
         permission: @escaping (String) -> Any?, requestPermission: @escaping (String) async -> Void,
         metadata: @escaping () -> [String: Any], send: @escaping (String, String, [String: Any]?) async throws -> Void) {
        self.workspace = workspace; self.store = store; self.token = token; self.removeToken = removeToken
        self.mint = mint; self.available = available; self.permission = permission
        self.requestPermission = requestPermission; self.metadata = metadata; self.send = send
    }

    func state() throws -> PhoneConsent { try store.read(workspace: workspace) }

    func setMaster(_ on: Bool, disclose: () async -> Bool) async throws {
        guard !busy else { throw PhoneJobsMintError.busy }
        busy = true
        defer { busy = false }
        var consent = try state()
        if on {
            try await available()
            if !consent.sharing {
                guard await disclose() else { return }
                consent.sharing = true
                consent.providers = []
                try store.write(consent, workspace: workspace)
            }
            // Complete cleanup if a previous local deletion failed.
            if !consent.enabled, let old = try token() {
                try await send("DELETE", old, nil)
                try removeToken()
            }
            if try token() == nil { try await mint() }
            consent = try state()
            consent.enabled = true
        } else { consent.enabled = false }
        try store.write(consent, workspace: workspace)
        try await synchronize()
    }

    func setRow(_ row: String, on: Bool) async throws {
        guard Self.rows.contains(row), !busy else { throw PhoneJobsMintError.busy }
        busy = true
        defer { busy = false }
        var consent = try state()
        guard consent.enabled, consent.sharing else { throw PhoneJobsMintError.refused }
        if on {
            await requestPermission(row)
            // Persist the explicit choice even if denied, so Settings can grant it later.
            consent = try state()
            consent.rows.insert(row)
        } else { consent.rows.remove(row) }
        try store.write(consent, workspace: workspace)
        try await synchronize()
    }

    func registration() throws -> [String: Any] {
        let consent = try state()
        var capabilities: [String: Any] = [:]
        if consent.enabled && consent.sharing {
            for row in PhoneJobsContract.capabilities where consent.rows.contains(row) {
                if let value = permission(row) {
                    capabilities[row] = row == "location" && !consent.rows.contains("precise") ? "approximate" : value
                }
            }
        }
        var body = metadata()
        body["protocol"] = 1
        body["capabilities"] = capabilities
        guard PhoneJobsContract.registrationValid(body) else { throw PhoneJobsMintError.invalidResponse }
        return body
    }

    func refresh() async throws {
        if busy { refreshPending = true; return }
        busy = true
        defer { busy = false }
        try await synchronize()
    }

    private func synchronize() async throws {
        repeat {
            refreshPending = false
            guard let bearer = try token() else { return }
            if try state().enabled {
                try await send("PUT", bearer, registration())
            } else {
                do { try await send("DELETE", bearer, nil) }
                catch {
                    try removeToken()
                    throw error
                }
                try removeToken()
            }
        } while refreshPending
    }
}
