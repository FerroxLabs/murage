import Foundation
import XCTest
import MurageShellCore
@testable import MurageShell

@MainActor final class PhoneJobsCleanupTests: XCTestCase {
    @MainActor private final class Rig {
        let one = WorkspaceOrigin(string: "https://one.example.ts.net")!
        let two = WorkspaceOrigin(string: "https://two.example.ts.net")!
        var tokens: [WorkspaceOrigin: String] = [:]
        var consent: Set<WorkspaceOrigin> = [], ledger: Set<WorkspaceOrigin> = []
        var requests: [URLRequest] = []
        var failTokenRemoval = false
        lazy var cleanup = PhoneJobsCleanup(token: { self.tokens[$0] }, removeToken: {
            if self.failTokenRemoval { throw PhoneJobsMintError.storage }; self.tokens.removeValue(forKey: $0)
        }, removeConsent: { self.consent.remove($0) }, clearLedger: { self.ledger.remove($0) }, unregister: {
            self.requests.append($0) // Deliberately never completes: network failure cannot hold local state.
        })
        init() {
            for origin in [one, two] { tokens[origin] = "murage_pj_" + String(repeating: "a", count: 43); consent.insert(origin); ledger.insert(origin) }
        }
    }
    func testSignOutAndRemoveComputerClearOnlyTheirWorkspaceBeforeDeleteCompletes() {
        for _ in ["signOut", "removeComputer", "signedOut"] {
            let r = Rig(); let token = r.tokens[r.one]!
            XCTAssertTrue(r.cleanup.forget(r.one))
            XCTAssertNil(r.tokens[r.one]); XCTAssertFalse(r.consent.contains(r.one)); XCTAssertFalse(r.ledger.contains(r.one))
            XCTAssertNotNil(r.tokens[r.two]); XCTAssertTrue(r.consent.contains(r.two)); XCTAssertTrue(r.ledger.contains(r.two))
            XCTAssertEqual(r.requests.count, 1)
            XCTAssertEqual(r.requests.first?.httpMethod, "DELETE")
            XCTAssertEqual(r.requests.first?.url?.absoluteString, r.one.serialized + "/api/phones/self")
            XCTAssertEqual(r.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer " + token)
            XCTAssertNil(r.requests.first?.httpBody)
            XCTAssertTrue(r.cleanup.forget(r.one)); XCTAssertEqual(r.requests.count, 1)
        }
    }
    func testReinstallClearsKeychainOriginsAbsentFromBookAndOrdinaryLaunchDoesNot() throws {
        let suite = "PhoneJobsCleanupTests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let r = Rig()
        r.cleanup.firstInstall(defaults: defaults) { [r.one, r.two] }
        XCTAssertTrue(r.tokens.isEmpty); XCTAssertTrue(r.consent.isEmpty); XCTAssertTrue(r.ledger.isEmpty)
        XCTAssertEqual(r.requests.count, 2)
        r.tokens[r.one] = "fresh"; r.consent.insert(r.one); r.ledger.insert(r.one)
        r.cleanup.firstInstall(defaults: defaults) { XCTFail("ordinary launch enumerated keychain"); return [] }
        XCTAssertEqual(r.tokens[r.one], "fresh"); XCTAssertEqual(r.requests.count, 2)
        defaults.removeObject(forKey: "phoneJobs.install.v1") // Reinstall loses UserDefaults, retains Keychain.
        r.cleanup.firstInstall(defaults: defaults) { [r.one] }
        XCTAssertNil(r.tokens[r.one]); XCTAssertTrue(r.consent.isEmpty); XCTAssertTrue(r.ledger.isEmpty)
        XCTAssertEqual(r.requests.count, 3)
    }
    func testLocalFailureDoesNotSkipOtherClearsOrMarkInstallComplete() throws {
        let r = Rig(); r.failTokenRemoval = true
        let suite = "PhoneJobsCleanupTests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        r.cleanup.firstInstall(defaults: defaults) { [r.one] }
        XCTAssertFalse(defaults.bool(forKey: "phoneJobs.install.v1"))
        XCTAssertFalse(r.consent.contains(r.one)); XCTAssertFalse(r.ledger.contains(r.one)); XCTAssertEqual(r.requests.count, 1)
        r.failTokenRemoval = false
        r.cleanup.firstInstall(defaults: defaults) { [r.one] }
        XCTAssertTrue(defaults.bool(forKey: "phoneJobs.install.v1")); XCTAssertNil(r.tokens[r.one])
    }
    #if os(iOS)
    func testLedgerRemovalIsScopedAndLateExecutorCannotRecreateIt() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let one = WorkspaceOrigin(string: "https://one.example.ts.net")!, two = WorkspaceOrigin(string: "https://two.example.ts.net")!
        let first = PhoneLedgerFile(workspace: one, directory: root), second = PhoneLedgerFile(workspace: two, directory: root)
        let ledger = PhoneOperationLedger(storage: first), other = PhoneOperationLedger(storage: second)
        _ = try await other.perform("other-operation") { "other-event" }
        let id = try await ledger.perform("operation") {
            try first.clear() // Forget while the OS save is in flight.
            return "saved-event"
        }
        XCTAssertEqual(id, "saved-event")
        XCTAssertNil(try PhoneLedgerFile(workspace: one, directory: root).read())
        XCTAssertNotNil(try PhoneLedgerFile(workspace: two, directory: root).read())
        let replay = try await other.perform("other-operation") { XCTFail("duplicate save"); return "duplicate" }
        XCTAssertEqual(replay, "other-event")
    }
    #endif

}
