import Foundation
import CryptoKit
import MurageShellCore

/// Only hashed operation IDs, state, OS identifiers and timestamps cross this seam.
@MainActor protocol PhoneLedgerStorage {
    func read() throws -> Data?
    func write(_ data: Data) throws
}

@MainActor final class PhoneOperationLedger {
    struct Entry: Codable {
        let state: String
        let identifier: String?
        let timestamp: TimeInterval
    }
    static let lifetime: TimeInterval = 7 * 24 * 60 * 60
    private let storage: PhoneLedgerStorage
    private let now: () -> Date
    init(storage: PhoneLedgerStorage, now: @escaping () -> Date = Date.init) { self.storage = storage; self.now = now }
    static func key(_ operationId: String) -> String {
        SHA256.hash(data: Data(operationId.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private func entries() throws -> [String: Entry] {
        let decoded = try storage.read().map { try JSONDecoder().decode([String: Entry].self, from: $0) } ?? [:]
        guard decoded.allSatisfy({ key, value in
            key.count == 64 && key.allSatisfy { "0123456789abcdef".contains($0) }
                && (value.state == "pending" && value.identifier == nil || value.state == "done" && value.identifier != nil)
                && value.timestamp.isFinite
        }) else { throw PhoneExecutorFailure.denied }
        return decoded.filter { now().timeIntervalSince1970 - $0.value.timestamp < Self.lifetime }
    }
    /// A pending save is deliberately never retried, including after process death.
    func perform(_ operationId: String, save: () async throws -> String) async throws -> String {
        var rows = try entries()
        let key = Self.key(operationId)
        if let entry = rows[key] {
            try storage.write(JSONEncoder().encode(rows)) // Also prune expired entries on replay.
            guard entry.state == "done", let id = entry.identifier else { throw PhoneExecutorFailure.denied }
            return id
        }
        rows[key] = Entry(state: "pending", identifier: nil, timestamp: now().timeIntervalSince1970)
        try storage.write(JSONEncoder().encode(rows))
        let id = try await save()
        guard !id.isEmpty, id.utf16.count <= 256 else { throw PhoneExecutorFailure.invalidResult }
        rows = try entries()
        rows[key] = Entry(state: "done", identifier: id, timestamp: now().timeIntervalSince1970)
        try storage.write(JSONEncoder().encode(rows))
        return id
    }
}

#if os(iOS)
@MainActor final class PhoneLedgerFile: PhoneLedgerStorage {
    private let workspace: WorkspaceOrigin
    private var invalidated = false
    private let directory: URL?
    init(workspace: WorkspaceOrigin, directory: URL? = nil) { self.workspace = workspace; self.directory = directory }
    func clear() throws {
        invalidated = true // An in-flight save may finish, but cannot recreate forgotten state.
        let url = try file()
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        // The pre-scope ledger cannot identify its owner. Retire it when a workspace is forgotten.
        let legacy = url.deletingLastPathComponent().appendingPathComponent("operations.json")
        if FileManager.default.fileExists(atPath: legacy.path) { try FileManager.default.removeItem(at: legacy) }
    }
    private func file() throws -> URL {
        let fm = FileManager.default
        var directory: URL
        if let supplied = self.directory { directory = supplied }
        else {
            directory = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                .appendingPathComponent("PhoneOperations", isDirectory: true)
        }
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [
            .posixPermissions: 0o700, .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication
        ])
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        return directory.appendingPathComponent(PhoneOperationLedger.key(workspace.serialized) + ".json")
    }
    func read() throws -> Data? {
        if invalidated { return nil }
        let url = try file()
        if !FileManager.default.fileExists(atPath: url.path) { return nil }
        return try Data(contentsOf: url)
    }
    func write(_ data: Data) throws {
        if invalidated { return }
        var url = try file()
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }
}
#endif
