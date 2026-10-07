import XCTest
@testable import MurageShellCore

final class PushStoresTests: XCTestCase {
    private func temp() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("ledger-\(UUID().uuidString).json") }

    func testMissingIsEmptyAndWritesThrough() {
        let url = temp()
        let access = FileLedgerAccess(url: url)
        XCTAssertEqual(access.update { l -> Int in l.bind("B1", origin: "https://mac.tailnet123.ts.net"); return l.total }, 0)
        XCTAssertEqual(FileLedgerAccess(url: url).read()?.origin("B1"), "https://mac.tailnet123.ts.net")
    }

    func testUnreadableIsNilNotEmpty() throws {
        let url = temp()
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true) // a directory cannot be read as data
        let access = FileLedgerAccess(url: url)
        XCTAssertNil(access.read())
        XCTAssertNil(access.update { _ in 1 })
    }

    func testNoContainerIsUnreadable() {
        XCTAssertNil(FileLedgerAccess(url: nil).read())
    }
}

/// A Keychain stand-in whose writes can fail per secret (a locked phone).
private final class FakeSecrets: PushSecrets {
    var items: [String: String] = [:] // "secret/account" -> value
    var failing: Set<String> = []
    var unlistable = false
    private func key(_ s: PushSecret, _ a: String) -> String { "\(s)/\(a)" }
    func write(_ value: String, secret: PushSecret, account: String) -> Bool {
        if failing.contains("\(secret)") { return false }
        items[key(secret, account)] = value
        return true
    }
    func read(secret: PushSecret, account: String) -> String? { items[key(secret, account)] }
    func delete(secret: PushSecret, account: String) { items[key(secret, account)] = nil }
    func accounts(secret: PushSecret) -> [String]? {
        if unlistable { return nil }
        return items.keys.compactMap { $0.hasPrefix("\(secret)/") ? String($0.dropFirst("\(secret)/".count)) : nil }
    }
}

/// A ledger whose save can fail, or which cannot be read at all.
private final class MemoryLedger: LedgerAccess {
    var ledger: PushLedger?
    var saveFails = false
    var writes = 0
    init(_ ledger: PushLedger?) { self.ledger = ledger }
    func read() -> PushLedger? { ledger }
    func update<T>(_ change: (inout PushLedger) -> T) -> T? {
        guard var l = ledger else { return nil }
        let out = change(&l)
        if saveFails { return nil }
        ledger = l
        writes += 1
        return out
    }
}

final class PushBindingsTests: XCTestCase {
    private let a = "https://mac.tailnet123.ts.net"
    private let b = "https://old.tailnet123.ts.net"
    private let b1 = "5b0c6f0e-1d2a-4c3b-8a9d-0e1f2a3b4c5d"
    private let b2 = "6c1d7a1f-2e3b-4d4c-9b0e-1f2a3b4c5d6e"
    private let b3 = "7d2e8b2a-3f4c-4e5d-a0f1-2a3b4c5d6e7f"

    private let farFuture: Int64 = 4_102_444_800_000 // 2100-01-01
    private func tokens(_ id: String, _ c: Character = "A", expiresAt: Int64? = nil) -> IssuedTokens {
        IssuedTokens(bindingId: id, detail: "murage_pd_" + String(repeating: c, count: 43),
                     respond: "murage_pr_" + String(repeating: c, count: 43), expiresAt: expiresAt ?? farFuture)
    }
    private func ledger(_ pairs: [(String, String)]) -> MemoryLedger {
        var l = PushLedger()
        for (id, origin) in pairs { l.bind(id, origin: origin) }
        return MemoryLedger(l)
    }

    func testIssueWritesThePair() {
        let secrets = FakeSecrets()
        let push = PushBindings(ledger: ledger([(b1, a)]), secrets: secrets)
        XCTAssertTrue(push.issue(origin: a, tokens: tokens(b1)))
        XCTAssertEqual(secrets.read(secret: .respond, account: b1), tokens(b1).respond)
        XCTAssertEqual(secrets.read(secret: .detail, account: b1), tokens(b1).detail)
        XCTAssertTrue(push.enrolled(origin: a))
    }

    /// A locked phone refuses the respond write (WhenUnlocked): the old pair
    /// stays whole, so the next open reuses the binding and re-mints rather
    /// than replacing it at the relay.
    func testARefusedRespondWriteKeepsTheOldPair() {
        let secrets = FakeSecrets()
        let push = PushBindings(ledger: ledger([(b1, a)]), secrets: secrets)
        XCTAssertTrue(push.issue(origin: a, tokens: tokens(b1, "A")))
        secrets.failing = ["respond"]
        XCTAssertFalse(push.issue(origin: a, tokens: tokens(b1, "B")))
        XCTAssertEqual(secrets.read(secret: .detail, account: b1), tokens(b1, "A").detail)
        XCTAssertEqual(secrets.read(secret: .respond, account: b1), tokens(b1, "A").respond)
        XCTAssertTrue(push.enrolled(origin: a))
    }

    func testAFailedDetailWriteLeavesNeitherToken() {
        let secrets = FakeSecrets()
        let push = PushBindings(ledger: ledger([(b1, a)]), secrets: secrets)
        secrets.failing = ["detail"]
        XCTAssertFalse(push.issue(origin: a, tokens: tokens(b1)))
        XCTAssertTrue(secrets.items.isEmpty)
    }

    func testIssueRefusesAnotherBinding() {
        let secrets = FakeSecrets()
        let push = PushBindings(ledger: ledger([(b1, a)]), secrets: secrets)
        XCTAssertFalse(push.issue(origin: a, tokens: tokens(b2)))
        XCTAssertFalse(push.issue(origin: b, tokens: tokens(b1)))
        XCTAssertTrue(secrets.items.isEmpty)
    }

    // RES-009: the host's expiry is kept with the tokens, and an expired pair is not "enrolled".
    func testIssueKeepsTheExpiryAndEnrolledStopsAtIt() {
        let secrets = FakeSecrets()
        let push = PushBindings(ledger: ledger([(b1, a)]), secrets: secrets)
        XCTAssertTrue(push.issue(origin: a, tokens: tokens(b1, expiresAt: 5_000)))
        XCTAssertEqual(push.expiresAt(origin: a), 5_000)
        XCTAssertTrue(push.enrolled(origin: a, now: Date(timeIntervalSince1970: 4.999)))
        XCTAssertFalse(push.enrolled(origin: a, now: Date(timeIntervalSince1970: 5)))
        XCTAssertFalse(push.enrolled(origin: a, now: Date(timeIntervalSince1970: 6)))
    }

    // RES-009: a pair stored with no recorded expiry (issued by an older build)
    // is unknown, not current. The page's every-open reissue then renews it.
    func testAPairWithNoRecordedExpiryIsUnknownAndNotEnrolled() {
        let secrets = FakeSecrets()
        let push = PushBindings(ledger: ledger([(b1, a)]), secrets: secrets)
        _ = secrets.write("murage_pd_x", secret: .detail, account: b1)
        XCTAssertNil(push.expiresAt(origin: a))
        XCTAssertFalse(push.enrolled(origin: a, now: Date(timeIntervalSince1970: 10)))
        // Issuing a fresh pair with its expiry makes it current again.
        XCTAssertTrue(push.issue(origin: a, tokens: tokens(b1, expiresAt: 5_000)))
        XCTAssertTrue(push.enrolled(origin: a, now: Date(timeIntervalSince1970: 4)))
    }

    func testAReissueReplacesTheExpiry() {
        let secrets = FakeSecrets()
        let push = PushBindings(ledger: ledger([(b1, a)]), secrets: secrets)
        XCTAssertTrue(push.issue(origin: a, tokens: tokens(b1, expiresAt: 5_000)))
        XCTAssertTrue(push.issue(origin: a, tokens: tokens(b1, "B", expiresAt: 9_000)))
        XCTAssertEqual(push.expiresAt(origin: a), 9_000)
    }

    // RES-009: storing a pair fails when its expiry cannot be written, and
    // leaves no pair behind, so the phone reports not enrolled and the
    // enrolment retry path runs.
    func testAFailedExpiryWriteFailsTheIssueAndLeavesNoPair() {
        let secrets = FakeSecrets()
        let push = PushBindings(ledger: ledger([(b1, a)]), secrets: secrets)
        XCTAssertTrue(push.issue(origin: a, tokens: tokens(b1, expiresAt: 5_000)))
        secrets.failing = ["expiry"]
        XCTAssertFalse(push.issue(origin: a, tokens: tokens(b1, "C", expiresAt: 20_000)))
        XCTAssertTrue(secrets.items.isEmpty)
        XCTAssertNil(push.expiresAt(origin: a))
        XCTAssertFalse(push.enrolled(origin: a, now: Date(timeIntervalSince1970: 10)))
        secrets.failing = []
        XCTAssertFalse(push.enrolled(origin: a, now: Date(timeIntervalSince1970: 10)))
    }

    func testForgetAndSweepDeleteTheExpiryToo() {
        let secrets = FakeSecrets()
        let push = PushBindings(ledger: ledger([(b1, a), (b2, b)]), secrets: secrets)
        _ = push.issue(origin: a, tokens: tokens(b1))
        _ = push.issue(origin: b, tokens: tokens(b2))
        _ = secrets.write("1", secret: .expiry, account: b3)   // no binding owns it
        _ = push.sweep(knownOrigins: [a])
        XCTAssertEqual(Set(secrets.items.keys), ["detail/\(b1)", "respond/\(b1)", "expiry/\(b1)"])
        _ = push.forget(origin: a)
        XCTAssertTrue(secrets.items.isEmpty)
    }

    func testForgetDeletesTheTokensEvenWhenTheLedgerSaveFails() {
        let secrets = FakeSecrets()
        let store = ledger([(b1, a)])
        let push = PushBindings(ledger: store, secrets: secrets)
        XCTAssertTrue(push.issue(origin: a, tokens: tokens(b1)))
        store.saveFails = true
        let out = push.forget(origin: a)
        XCTAssertEqual(out.bindingId, b1)
        XCTAssertFalse(out.saved)
        XCTAssertTrue(secrets.items.isEmpty)
    }

    func testForgetOnAnUnreadableLedgerFindsNothingAndSaysSo() {
        let push = PushBindings(ledger: MemoryLedger(nil), secrets: FakeSecrets())
        let out = push.forget(origin: a)
        XCTAssertNil(out.bindingId)
        XCTAssertFalse(out.saved)
    }

    func testForgetSavesAndDeletes() {
        let secrets = FakeSecrets()
        let store = ledger([(b1, a)])
        let push = PushBindings(ledger: store, secrets: secrets)
        _ = push.issue(origin: a, tokens: tokens(b1))
        let out = push.forget(origin: a)
        XCTAssertEqual(out.bindingId, b1)
        XCTAssertTrue(out.saved)
        XCTAssertNil(store.ledger?.binding(origin: a))
        XCTAssertTrue(secrets.items.isEmpty)
    }

    func testSweepDropsUnsavedOriginsAndOrphanTokensButKeepsTheDeviceSecret() {
        let secrets = FakeSecrets()
        let store = ledger([(b1, a), (b2, b)])
        let push = PushBindings(ledger: store, secrets: secrets)
        _ = push.issue(origin: a, tokens: tokens(b1))
        _ = push.issue(origin: b, tokens: tokens(b2))
        _ = secrets.write("murage_pd_x", secret: .detail, account: b3)   // no binding owns it
        _ = secrets.write("murage_pr_x", secret: .respond, account: b3)
        _ = secrets.write("device", secret: .deviceSecret, account: "install")
        let out = push.sweep(knownOrigins: [a])
        XCTAssertEqual(out.dropped, [b2])
        XCTAssertEqual(out.orphans, [b3]) // its relay binding goes too (onForget)
        XCTAssertTrue(out.saved)
        XCTAssertEqual(store.ledger?.bindingIds, [b1])
        XCTAssertEqual(Set(secrets.items.keys), ["detail/\(b1)", "respond/\(b1)", "expiry/\(b1)", "deviceSecret/install"])
    }

    /// Every cold start sweeps; a sweep that drops nothing must not rewrite
    /// the file the extension may be reading (I2/A2 re-review).
    func testSweepWithNothingToDropWritesNothing() {
        let secrets = FakeSecrets()
        let store = ledger([(b1, a)])
        let push = PushBindings(ledger: store, secrets: secrets)
        _ = push.issue(origin: a, tokens: tokens(b1))
        let writes = store.writes
        let out = push.sweep(knownOrigins: [a])
        XCTAssertEqual(out, PushBindings.Sweep(dropped: [], orphans: [], saved: true))
        XCTAssertEqual(store.writes, writes)
        XCTAssertEqual(Set(secrets.items.keys), ["detail/\(b1)", "respond/\(b1)", "expiry/\(b1)"])
    }

    func testSweepStillDeletesDroppedTokensWhenTheSaveFails() {
        let secrets = FakeSecrets()
        let store = ledger([(b1, a), (b2, b)])
        let push = PushBindings(ledger: store, secrets: secrets)
        _ = push.issue(origin: a, tokens: tokens(b1))
        _ = push.issue(origin: b, tokens: tokens(b2))
        store.saveFails = true
        let out = push.sweep(knownOrigins: [a])
        XCTAssertEqual(out.dropped, [b2])
        XCTAssertFalse(out.saved)
        XCTAssertEqual(Set(secrets.items.keys), ["detail/\(b1)", "respond/\(b1)", "expiry/\(b1)"])
    }

    func testSweepOnAnUnreadableLedgerTouchesNothing() {
        let secrets = FakeSecrets()
        _ = secrets.write("murage_pd_x", secret: .detail, account: b3)
        let out = PushBindings(ledger: MemoryLedger(nil), secrets: secrets).sweep(knownOrigins: [])
        XCTAssertEqual(out.dropped, [])
        XCTAssertFalse(out.saved)
        XCTAssertEqual(secrets.items.count, 1)
    }
}

/// B3 (Astra B3): the app and the notification extension are two processes
/// updating one ledger file. A read-modify-write that takes no lock lets the
/// older snapshot overwrite a newer one and erases a binding.
final class FileLedgerAccessTwoWriterTests: XCTestCase {
    func testTwoWritersNeverLoseAnUpdate() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ledger-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url); try? FileManager.default.removeItem(atPath: url.path + ".lock") }
        // Each worker has its own access object, as the app and the extension do.
        let writers = [FileLedgerAccess(url: url), FileLedgerAccess(url: url)]
        let each = 60
        DispatchQueue.concurrentPerform(iterations: 2) { w in
            for i in 0..<each {
                _ = writers[w].update { l in l.bind("W\(w)-\(i)", origin: "https://w\(w)-\(i).tailnet123.ts.net") }
            }
        }
        let ledger = FileLedgerAccess(url: url).read()
        XCTAssertEqual(ledger?.bindingIds.count, each * 2)
    }

    func testABadgeUpdateCannotEraseAnEnrolment() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ledger-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url); try? FileManager.default.removeItem(atPath: url.path + ".lock") }
        let app = FileLedgerAccess(url: url), extensionSide = FileLedgerAccess(url: url)
        _ = app.update { l in l.bind("A", origin: "https://a.tailnet123.ts.net") }
        DispatchQueue.concurrentPerform(iterations: 2) { w in
            if w == 0 {
                for i in 0..<40 { _ = app.update { l in l.bind("B\(i)", origin: "https://b\(i).tailnet123.ts.net") } }
            } else {
                for i in 0..<40 { _ = extensionSide.update { l in l.setBadge("A", count: i) } }
            }
        }
        let ledger = extensionSide.read()
        XCTAssertEqual(ledger?.bindingIds.count, 41)
    }
}

final class FileLedgerAccessLockBoundTests: XCTestCase {
    /// B3 review M8: a lock held elsewhere makes update give up (nil), not hang.
    func testUpdateGivesUpWhenTheLockIsHeld() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ledger-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url); try? FileManager.default.removeItem(atPath: url.path + ".lock") }
        let fd = open(url.path + ".lock", O_CREAT | O_RDWR, 0o600)
        XCTAssertEqual(flock(fd, LOCK_EX), 0)
        defer { flock(fd, LOCK_UN); close(fd) }
        let started = Date()
        let access = FileLedgerAccess(url: url)
        XCTAssertNil(access.update { _ in 1 })
        XCTAssertTrue(access.lockTimedOut)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
    }
}
