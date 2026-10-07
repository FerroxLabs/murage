import Foundation
#if canImport(Security)
import Security
#endif

/// Where the ledger lives: one file in the App Group container, which both
/// the app and the extension read. Before the first unlock after a reboot the
/// file exists but cannot be read; that is nil ("unreadable"), never an empty
/// ledger, so the extension shows generic text and writes nothing.
public protocol LedgerAccess {
    func read() -> PushLedger?
    func update<T>(_ change: (inout PushLedger) -> T) -> T?
    /// True when the last `update` gave up waiting for the cross-process lock.
    var lockTimedOut: Bool { get }
}

public extension LedgerAccess {
    var lockTimedOut: Bool { false }
}

public final class FileLedgerAccess: LedgerAccess {
    private let url: URL?
    public private(set) var lockTimedOut = false

    public convenience init(appGroup: String) {
        self.init(url: FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?.appendingPathComponent("push-ledger.json"))
    }
    public init(url: URL?) { self.url = url }

    public func read() -> PushLedger? {
        guard let url else { return nil }
        guard FileManager.default.fileExists(atPath: url.path) else { return PushLedger() }
        guard let data = try? Data(contentsOf: url) else { return nil }
        return PushLedger.decode(data)
    }

    /// The app and the notification extension are two processes updating one
    /// file, and the ledger holds the bindings as well as the badge counts, so
    /// the whole read-modify-write runs under an exclusive `flock` on a sidecar
    /// file (B3). Without it the older snapshot is written back over a newer
    /// one and a freshly enrolled binding disappears. The lock is held on a
    /// separate file because the ledger itself is replaced atomically (its
    /// inode changes on every write); `flock` is released when the descriptor
    /// closes, so a process that dies mid-update never leaves it held.
    public func update<T>(_ change: (inout PushLedger) -> T) -> T? {
        lockTimedOut = false
        guard let url else { return nil }
        let lockFd = open(url.path + ".lock", O_CREAT | O_RDWR, 0o600)
        guard lockFd >= 0 else { return nil }
        defer { close(lockFd) }
        // Bounded wait (review M8): try without blocking, for about 2 s at most,
        // so a stuck holder cannot freeze the main thread or use up the
        // extension's budget; on timeout nothing is written (nil).
        var locked = flock(lockFd, LOCK_EX | LOCK_NB) == 0
        for _ in 0..<400 where !locked {
            usleep(5_000)
            locked = flock(lockFd, LOCK_EX | LOCK_NB) == 0
        }
        guard locked else { lockTimedOut = true; return nil }
        defer { flock(lockFd, LOCK_UN) }
        guard var ledger = read() else { return nil }
        let out = change(&ledger)
        #if os(iOS)
        let options: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        #else
        let options: Data.WritingOptions = [.atomic]
        #endif
        do { try ledger.encoded().write(to: url, options: options) } catch { return nil }
        return out
    }
}

public enum PushSecret { case detail, respond, deviceSecret, expiry }

/// The Keychain calls PushBindings makes, so tests can fail a write.
public protocol PushSecrets {
    func write(_ value: String, secret: PushSecret, account: String) -> Bool
    func read(secret: PushSecret, account: String) -> String?
    func delete(secret: PushSecret, account: String)
    /// Every account holding this secret; nil when the store cannot be listed.
    func accounts(secret: PushSecret) -> [String]?
}

/// The ledger and the tokens together: what issuing, forgetting and the
/// open-time sweep do to both. Revocation wins: tokens for a binding that
/// is going are deleted even when the ledger cannot be saved.
public struct PushBindings {
    public let ledger: LedgerAccess
    public let secrets: PushSecrets
    /// Relay deletions owed (B4): a binding is written here before it is
    /// discarded locally, so a relay DELETE that fails is retried later.
    public let owed: PushDeletionQueue?

    public init(ledger: LedgerAccess, secrets: PushSecrets, owed: PushDeletionQueue? = nil) {
        self.ledger = ledger
        self.secrets = secrets
        self.owed = owed
    }

    /// Enrolled means the detail token is present, and detail is written last.
    /// A token past the expiry the host gave with it is not a working one, so
    /// it does not count, and neither does a pair with no recorded expiry (one
    /// stored by an older build): its expiry is unknown, so it is not reported
    /// as current, and the next open's reissue stores one with an expiry.
    public func enrolled(origin: String, now: Date = Date()) -> Bool {
        guard let binding = ledger.read()?.binding(origin: origin) else { return false }
        guard secrets.read(secret: .detail, account: binding) != nil else { return false }
        guard let expiresAt = expiresAt(origin: origin) else { return false }
        return expiresAt > Int64(now.timeIntervalSince1970 * 1000)
    }

    /// When this workspace's tokens stop working (ms since the epoch), if known.
    public func expiresAt(origin: String) -> Int64? {
        guard let binding = ledger.read()?.binding(origin: origin) else { return nil }
        return secrets.read(secret: .expiry, account: binding).flatMap { Int64($0) }
    }

    /// Respond first, then detail as the commit marker, so a detail token is
    /// never without its respond token. A refused respond write (a locked
    /// phone: respond is WhenUnlocked) changes nothing: the old pair stays
    /// whole and "enrolled" survives, so the next open re-mints instead of
    /// replacing the binding at the relay. The trade-off: the host already
    /// rotated that pair, so until the next open the extension's detail read
    /// and a lock-screen answer get 401 (generic text, "Open Murage"). A
    /// refused detail write after respond went through leaves neither token.
    public func issue(origin: String, tokens: IssuedTokens) -> Bool {
        guard ledger.read()?.binding(origin: origin) == tokens.bindingId else { return false }
        let id = tokens.bindingId
        guard secrets.write(tokens.respond, secret: .respond, account: id) else { return false }
        guard secrets.write(tokens.detail, secret: .detail, account: id) else {
            deleteTokens(id)
            return false
        }
        // After detail, so an expiry never outlives a failed pair. A pair whose
        // expiry cannot be written is not stored at all: the phone then reports
        // not enrolled and the enrolment retry runs.
        guard secrets.write(String(tokens.expiresAt), secret: .expiry, account: id) else {
            deleteTokens(id)
            return false
        }
        return true
    }

    public struct Forgot: Equatable {
        /// The binding the origin held, found in the ledger; its tokens are gone.
        public let bindingId: String?
        /// False when the ledger could not be read or saved; the sweep finishes it.
        public let saved: Bool
    }

    public func forget(origin: String) -> Forgot {
        var found: String?
        let saved = ledger.update({ l -> Bool in
            if let id = l.binding(origin: origin) { owed?.add(id) }
            found = l.unbindOrigin(origin)
            return true
        }) != nil
        if let found { deleteTokens(found) }
        return Forgot(bindingId: found, saved: saved)
    }

    public struct Sweep: Equatable {
        /// Bindings whose computer is no longer saved; their tokens are gone.
        public let dropped: [String]
        /// Binding ids of token items no binding owned; those items are gone,
        /// and their relay bindings should go too.
        public let orphans: [String]
        /// False when the ledger could not be read or saved.
        public let saved: Bool
    }

    /// On app open, once the saved computers read: drop bindings for origins
    /// no longer saved, then delete detail and respond items no binding owns.
    /// An unreadable ledger changes nothing (every item would look orphaned).
    /// The file is rewritten only when a binding is dropped: the extension
    /// may be reading it, and a cold start usually has nothing to drop.
    public func sweep(knownOrigins: Set<String>) -> Sweep {
        guard let current = ledger.read() else { return Sweep(dropped: [], orphans: [], saved: false) }
        var dropped = current.bindingIds.filter { id in current.origin(id).map { !knownOrigins.contains($0) } ?? false }
        var owned = Set(current.bindingIds)
        var saved = true
        if !dropped.isEmpty {
            dropped = []
            saved = ledger.update({ l -> Bool in
                for id in l.bindingIds {
                    guard let origin = l.origin(id), !knownOrigins.contains(origin) else { continue }
                    owed?.add(id)
                    _ = l.unbindOrigin(origin)
                    dropped.append(id)
                }
                owned = Set(l.bindingIds)
                return true
            }) != nil
        }
        for id in dropped { deleteTokens(id) }
        var orphans: [String] = []
        for secret in [PushSecret.detail, .respond] {
            for account in secrets.accounts(secret: secret) ?? [] where !owned.contains(account) {
                owed?.add(account)
                secrets.delete(secret: secret, account: account)
                if !orphans.contains(account) { orphans.append(account) }
            }
        }
        // An expiry no binding owns has no relay binding of its own to delete.
        for account in secrets.accounts(secret: .expiry) ?? [] where !owned.contains(account) {
            secrets.delete(secret: .expiry, account: account)
        }
        return Sweep(dropped: dropped, orphans: orphans, saved: saved)
    }

    private func deleteTokens(_ id: String) {
        secrets.delete(secret: .detail, account: id)
        secrets.delete(secret: .respond, account: id)
        secrets.delete(secret: .expiry, account: id)
    }
}

#if canImport(Security)
/// Push secrets in the Keychain, one item per binding (the device secret has
/// one per install). Spec §3.5: detail readable after first unlock and shared
/// with the extension; respond only while unlocked and never shared.
public enum PushKeychain {
    public static var sharedGroup: String? { Bundle.main.object(forInfoDictionaryKey: "MurageKeychainGroup") as? String }

    static func place(_ secret: PushSecret) -> (service: String, accessible: CFString, group: String?) {
        switch secret {
        case .detail:
            return ("com.murage.mobile.push.detail", kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, sharedGroup)
        case .respond:
            return ("com.murage.mobile.push.respond", kSecAttrAccessibleWhenUnlockedThisDeviceOnly, nil)
        case .deviceSecret:
            return ("com.murage.mobile.push.device", kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, nil)
        case .expiry:
            return ("com.murage.mobile.push.expiry", kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, nil)
        }
    }

    private static func base(_ secret: PushSecret, _ account: String) -> [String: Any] {
        let p = place(secret)
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: p.service, kSecAttrAccount as String: account]
        if let group = p.group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    @discardableResult
    public static func write(_ value: String, secret: PushSecret, account: String) -> Bool {
        let changes: [String: Any] = [kSecValueData as String: Data(value.utf8), kSecAttrAccessible as String: place(secret).accessible]
        let status = SecItemUpdate(base(secret, account) as CFDictionary, changes as CFDictionary)
        if status == errSecItemNotFound {
            return SecItemAdd(base(secret, account).merging(changes) { $1 } as CFDictionary, nil) == errSecSuccess
        }
        return status == errSecSuccess
    }

    public static func read(secret: PushSecret, account: String) -> String? {
        var q = base(secret, account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &value) == errSecSuccess, let data = value as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public static func delete(secret: PushSecret, account: String) {
        SecItemDelete(base(secret, account) as CFDictionary)
    }

    /// Every account holding this secret (the sweep's orphan check); nil
    /// when the Keychain answers anything but items or "none".
    public static func accounts(secret: PushSecret) -> [String]? {
        let p = place(secret)
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: p.service,
                                kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
        if let group = p.group { q[kSecAttrAccessGroup as String] = group }
        var value: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &value)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let items = value as? [[String: Any]] else { return nil }
        return items.compactMap { $0[kSecAttrAccount as String] as? String }
    }
}

/// The real Keychain behind PushBindings.
public struct KeychainPushSecrets: PushSecrets {
    public init() {}
    public func write(_ value: String, secret: PushSecret, account: String) -> Bool { PushKeychain.write(value, secret: secret, account: account) }
    public func read(secret: PushSecret, account: String) -> String? { PushKeychain.read(secret: secret, account: account) }
    public func delete(secret: PushSecret, account: String) { PushKeychain.delete(secret: secret, account: account) }
    public func accounts(secret: PushSecret) -> [String]? { PushKeychain.accounts(secret: secret) }
}
#endif
