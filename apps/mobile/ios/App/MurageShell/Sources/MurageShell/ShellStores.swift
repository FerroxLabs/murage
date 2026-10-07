#if os(iOS)
import Foundation
import MurageShellCore

/// RouteMemory's store: the last conversation per computer and the pending intent.
final class UserDefaultsStore: KeyValueStore {
    private let defaults: UserDefaults

    init(_ defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func string(forKey key: String) -> String? { defaults.string(forKey: key) }

    func set(_ value: String?, forKey key: String) {
        if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
    }
}

/// The saved computers, in the Keychain (spec §3.1).
///
/// CALLERS (P15/P17): `load()` returning nil means the Keychain could not be
/// read, NOT that nothing is saved. On nil, do not show the empty launcher
/// ("add your first computer") and do not start pairing; show a retry and
/// load again (after `protectedDataDidBecomeAvailable`, for one).
final class WorkspaceBookStore {
    private let item = KeychainItem(service: "com.murage.mobile.workspaces", account: "book.v1")

    init() {
        clearAfterReinstall()
    }

    /// nil when unreadable; an empty book only when there is truly no item.
    func load() -> WorkspaceBook? {
        switch item.read() {
        case .found(let data): return WorkspaceBook.decode(data)
        case .missing: return WorkspaceBook()
        case .failed(let status):
            ShellLog.event("book read failed", status: Int(status))
            return nil
        }
    }

    @discardableResult
    func save(_ book: WorkspaceBook) -> Bool {
        guard item.write(book.encoded()) else {
            ShellLog.event("book save failed")
            return false
        }
        return true
    }

    /// False, and nothing written, when the current book cannot be read: a
    /// save on top of an unreadable list would replace it.
    @discardableResult
    func update(_ change: (inout WorkspaceBook) -> Void) -> Bool {
        updateIfChanged { book in
            change(&book)
            return true
        }
    }

    /// As `update`, but a change that answers false (nothing changed) is not
    /// saved; that still counts as done.
    @discardableResult
    func updateIfChanged(_ change: (inout WorkspaceBook) -> Bool) -> Bool {
        guard var book = load() else { return false }
        guard change(&book) else { return true }
        return save(book)
    }

    /// Keychain items outlive an uninstall; the WebView's cookies do not. A
    /// saved list without its sessions would only lead to re-pair screens, so
    /// a fresh install (no marker file yet) starts with an empty list
    /// (Decision 7). The marker is excluded from backup so a restored phone
    /// counts as fresh too. The list is cleared only once the marker is
    /// written, so a marker that cannot be written never empties it every
    /// launch; a delete that fails removes the marker again so the next
    /// launch retries.
    private func clearAfterReinstall() {
        let files = FileManager.default
        guard let support = try? files.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true) else { return }
        var marker = support.appendingPathComponent("murage-install-v1")
        guard !files.fileExists(atPath: marker.path) else { return }
        do {
            try Data("1".utf8).write(to: marker, options: .atomic)
        } catch {
            ShellLog.event("install marker write failed")
            return
        }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        do {
            try marker.setResourceValues(values)
        } catch {
            ShellLog.event("install marker backup exclusion failed")
        }
        let status = item.delete()
        if status != errSecSuccess, status != errSecItemNotFound {
            ShellLog.event("book delete failed", status: Int(status))
            try? files.removeItem(at: marker)
        }
    }
}

/// Spec §3.3 "Device records": the installId lives in the Keychain, which
/// survives a reinstall, so pairing again replaces this phone's old record.
/// Not a secret. Never cleared by the app.
///
/// CALLERS (P15/P17): nil means the id could not be read or saved. Do not
/// pair on nil (a stand-in id would leave a second device record behind);
/// wait and try again.
enum InstallIdentity {
    static func value() -> String? {
        let item = KeychainItem(service: "com.murage.mobile.install", account: "installId")
        switch item.read() {
        case .found(let data):
            if let stored = String(data: data, encoding: .utf8), PairingLink.validInstallId(stored) { return stored }
            // A readable but damaged value can never be sent; replace it.
            return mint(into: item)
        case .missing:
            return mint(into: item)
        case .failed(let status):
            ShellLog.event("install id read failed", status: Int(status))
            return nil
        }
    }

    private static func mint(into item: KeychainItem) -> String? {
        let fresh = PairingLink.newInstallId(prefix: "ios")
        guard item.write(Data(fresh.utf8)) else {
            ShellLog.event("install id save failed")
            return nil
        }
        return fresh
    }
}
#endif
