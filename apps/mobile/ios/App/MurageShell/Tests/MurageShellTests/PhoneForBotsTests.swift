import Foundation
import MurageShellCore
import Security
import XCTest
@testable import MurageShell

@MainActor final class PhoneForBotsTests: XCTestCase {
    private final class Store: PhoneConsentStorage {
        var values: [WorkspaceOrigin: PhoneConsent] = [:]
        func read(workspace: WorkspaceOrigin) throws -> PhoneConsent { values[workspace] ?? PhoneConsent() }
        func write(_ consent: PhoneConsent, workspace: WorkspaceOrigin) throws { values[workspace] = consent }
    }
    @MainActor private final class Rig {
        let origin = WorkspaceOrigin(string: "https://phone.example.ts.net")!
        let store = Store()
        var bearer: String?
        var prompts = 0, disclosures = 0
        var requests: [String] = [], events: [String] = []
        var allowed: [String: Any] = [:]
        var unavailable: PhoneJobsMintError?
        var failHTTP = false
        var bodies: [[String: Any]] = []
        var metadata: [String: Any] = ["name": "Phone", "platform": "ios", "osVersion": "26.0", "appVersion": "1.0.9", "timeZone": "UTC"]
        lazy var model = PhoneForBotsModel(workspace: origin, store: store,
            token: { self.bearer }, removeToken: { self.events.append("remove"); self.bearer = nil },
            mint: { self.prompts += 1; self.bearer = "murage_pj_" + String(repeating: "a", count: 43) },
            available: { if let error = self.unavailable { throw error } },
            permission: { self.allowed[$0] }, requestPermission: { self.requests.append($0) },
            metadata: { self.metadata }, send: { method, token, body in
                XCTAssertTrue(PhoneJobsContract.tokenValid(token))
                self.events.append(method)
                if self.failHTTP { throw PhoneJobsMintError.unavailable }
                if let body { self.bodies.append(body) }
            })
        func enable(_ allow: Bool = true) async throws {
            try await model.setMaster(true) { self.disclosures += 1; return allow }
        }
        func caps() throws -> [String: Any] { try XCTUnwrap(model.registration()["capabilities"] as? [String: Any]) }
    }
    private static var mobile: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() }
        return url
    }

    func testFirstRunNotNowAndFirstAllow() async throws {
        let r = Rig()
        try await r.model.refresh()
        XCTAssertEqual(try r.model.state(), PhoneConsent())
        XCTAssertTrue(r.events.isEmpty); XCTAssertTrue(r.requests.isEmpty)
        try await r.enable(false)
        XCTAssertFalse(try r.model.state().enabled); XCTAssertNil(r.bearer); XCTAssertEqual(r.prompts, 0)
        try await r.enable()
        XCTAssertTrue(try r.model.state().enabled); XCTAssertTrue(try r.model.state().sharing)
        XCTAssertTrue(try r.model.state().providers.isEmpty); XCTAssertEqual(r.prompts, 1)
        XCTAssertTrue(try r.caps().isEmpty)
        try await r.model.refresh()
        try await r.enable()
        XCTAssertEqual(r.prompts, 1); XCTAssertEqual(r.disclosures, 2)
    }

    func testEveryRowRequiresConsentAndPermissionAndOffDoesNotPrompt() async throws {
        let r = Rig(); try await r.enable()
        r.allowed = ["calendar": "full", "reminders": true, "contacts": "limited", "location": "precise", "precise": true,
                     "alarms": true, "messages": true, "calls": true]
        XCTAssertTrue(try r.caps().isEmpty)
        for row in PhoneForBotsModel.rows {
            let value = r.allowed.removeValue(forKey: row)
            try await r.model.setRow(row, on: true)
            XCTAssertEqual(r.requests.last, row)
            XCTAssertNil(try r.caps()[row])
            r.allowed[row] = value
            try await r.model.refresh()
            if row != "precise" { XCTAssertNotNil(try r.caps()[row]) }
            let asks = r.requests.count
            try await r.model.setRow(row, on: false)
            XCTAssertNil(try r.caps()[row]); XCTAssertEqual(r.requests.count, asks)
        }
        XCTAssertTrue(try r.caps().isEmpty)
        XCTAssertEqual(r.requests.count, PhoneForBotsModel.rows.count)
    }

    func testPreciseIsSeparateAndPermissionLossNarrowing() async throws {
        let r = Rig(); try await r.enable()
        r.allowed["location"] = "precise"; r.allowed["precise"] = true
        try await r.model.setRow("location", on: true)
        XCTAssertEqual(try r.caps()["location"] as? String, "approximate")
        try await r.model.setRow("precise", on: true)
        XCTAssertEqual(try r.caps()["location"] as? String, "precise")
        r.allowed["location"] = "approximate"; r.allowed["precise"] = nil
        try await r.model.refresh()
        XCTAssertEqual(try r.caps()["location"] as? String, "approximate")
        r.allowed["location"] = nil
        XCTAssertNil(try r.caps()["location"])
    }

    func testProviderConsentIsPerWorkspaceAndReReadAtCommit() async throws {
        let r = Rig(); try await r.enable(); try await r.model.setRow("contacts", on: true)
        XCTAssertTrue(try r.store.needsProviderSheet(workspace: r.origin, providerId: "first"))
        XCTAssertFalse(try r.store.readForCommit(workspace: r.origin, providerId: "first", capability: "contacts"))
        // Not now makes no write and leaves the provider pending.
        XCTAssertTrue(try r.store.needsProviderSheet(workspace: r.origin, providerId: "first"))
        try r.store.recordProviderConsent(workspace: r.origin, providerId: "first")
        XCTAssertFalse(try r.store.needsProviderSheet(workspace: r.origin, providerId: "first"))
        XCTAssertTrue(try r.store.needsProviderSheet(workspace: r.origin, providerId: "second"))
        let other = WorkspaceOrigin(string: "https://other.example.ts.net")!
        XCTAssertTrue(try r.store.needsProviderSheet(workspace: other, providerId: "first"))
        XCTAssertTrue(try r.store.readForCommit(workspace: r.origin, providerId: "first", capability: "contacts"))
        var c = try r.model.state(); c.sharing = false; try r.store.write(c, workspace: r.origin)
        XCTAssertFalse(try r.store.readForCommit(workspace: r.origin, providerId: "first", capability: "contacts"))
        XCTAssertTrue(try r.caps().isEmpty)
    }

    func testOffDeletesBeforeRemovingEvenWhenDeleteFails() async throws {
        let r = Rig(); try await r.enable(); r.events = []
        r.failHTTP = true
        do { try await r.model.setMaster(false) { XCTFail(); return true }; XCTFail() } catch {}
        XCTAssertFalse(try r.model.state().enabled); XCTAssertNil(r.bearer)
        XCTAssertEqual(r.events, ["DELETE", "remove"])
        r.failHTTP = false; try await r.model.refresh()
        XCTAssertEqual(r.events, ["DELETE", "remove"])
        try await r.enable()
        XCTAssertEqual(r.disclosures, 1); XCTAssertEqual(r.prompts, 2)
        r.events = []
        try await r.model.setMaster(false) { XCTFail(); return true }
        XCTAssertEqual(r.events, ["DELETE", "remove"]); XCTAssertNil(r.bearer)
    }

    func testMissingKeyOrOldDoorNeverDisclosesMintsOrRegisters() async throws {
        for error in [PhoneJobsMintError.noApprovalKey, .updateComputer, .turnedOff] {
            let r = Rig(); r.unavailable = error
            do { try await r.enable(); XCTFail() } catch {}
            XCTAssertEqual(r.prompts, 0); XCTAssertEqual(r.disclosures, 0); XCTAssertTrue(r.events.isEmpty)
            XCTAssertFalse(try r.model.state().enabled)
        }
    }

    func testRegistrationMatchesFixtureBodiesAndRejectsInvalidVectors() async throws {
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.mobile.appendingPathComponent("contract/phone-jobs.json"))) as? [String: Any])
        let fixture = try XCTUnwrap(json["registration"] as? [String: Any])
        let valid = [try XCTUnwrap(fixture["valid"] as? [String: Any])] + (try XCTUnwrap(fixture["alsoValid"] as? [[String: Any]]))
        for body in valid {
            // Fixture vectors are raw registration bodies, shared with the server schema.
            let r = Rig(); r.metadata = body; r.metadata.removeValue(forKey: "capabilities"); r.metadata.removeValue(forKey: "protocol")
            let caps = try XCTUnwrap(body["capabilities"] as? [String: Any])
            r.allowed = caps
            var c = PhoneConsent(); c.enabled = true; c.sharing = true; c.rows = Set(caps.keys)
            if caps["location"] as? String == "precise" { c.rows.insert("precise") }
            try r.store.write(c, workspace: r.origin)
            XCTAssertEqual(try r.model.registration() as NSDictionary, body as NSDictionary)
        }
        for body in try XCTUnwrap(fixture["invalid"] as? [[String: Any]]) { XCTAssertFalse(PhoneJobsContract.registrationValid(body["body"])) }
    }

    func testKeychainConsentIsDeviceOnlyAndReadableAgainWithoutSharedGroup() throws {
        var saved: Data?
        let store = PhoneConsentStore(operations: .init(update: { query, changes in
            XCTAssertNil(query[kSecAttrAccessGroup as String]); XCTAssertEqual(changes[kSecAttrAccessible as String] as? String, kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
            saved = changes[kSecValueData as String] as? Data; return errSecSuccess
        }, add: { _ in XCTFail(); return errSecSuccess }, read: { query in
            XCTAssertNil(query[kSecAttrAccessGroup as String]); return saved == nil ? (errSecItemNotFound, nil) : (errSecSuccess, saved)
        }, delete: { _ in XCTFail(); return errSecSuccess }))
        let origin = Rig().origin
        XCTAssertEqual(try store.read(workspace: origin), PhoneConsent())
        var c = PhoneConsent(); c.enabled = true; c.sharing = true; c.rows = ["contacts"]
        try store.write(c, workspace: origin)
        try store.recordProviderConsent(workspace: origin, providerId: "service")
        XCTAssertTrue(try store.readForCommit(workspace: origin, providerId: "service", capability: "contacts"))
    }

    func testBridgeTakesNoArgumentsReturnsVoidAndOnlyPresents() throws {
        var presented = 0
        let result: Void = try PhoneForBotsEntry.open(args: [:], paired: true) { presented += 1 }
        _ = result
        try PhoneForBotsEntry.open(args: [:], paired: false) { XCTFail() }
        XCTAssertThrowsError(try PhoneForBotsEntry.open(args: ["provider": "injected"], paired: true) { XCTFail() })
        XCTAssertEqual(presented, 1)
        guard case .failure(.badArgs) = ChannelGate.parse(["method": "openPhoneForBots", "args": ["token": "injected"]]) else { return XCTFail() }
        let source = try String(contentsOf: Self.mobile.appendingPathComponent("ios/App/MurageShell/Sources/MurageShell/WorkspaceViewController.swift"))
        let start = try XCTUnwrap(source.range(of: "case .openPhoneForBots:"))
        let end = try XCTUnwrap(source.range(of: "case .approveWithDevice:", range: start.upperBound..<source.endIndex))
        let dispatch = String(source[start.lowerBound..<end.lowerBound])
        XCTAssertTrue(dispatch.contains("reply(nil, nil)"))
        for forbidden in ["PhoneJobsSigner", "PhoneJobsTokenStore", "PhoneConsentStore", "readForRunner", "recordProviderConsent", "signPhoneJobs", "request.args["] {
            XCTAssertFalse(dispatch.contains(forbidden), forbidden)
        }
    }
}
