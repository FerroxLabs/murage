import CryptoKit
import Foundation
import MurageShellCore
import Security
import XCTest
#if os(iOS)
import UIKit
#endif
@testable import MurageShell

@MainActor
final class PhoneAskMintTests: XCTestCase {
    #if os(iOS)
    private func removalDirectory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ask-removal-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }
    func testForgetKeepsMarkerAndBearerUntilProtectedDataRetrySucceeds() async throws {
        let root = try removalDirectory()
        let suite = "ask-removal-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let notifications = NotificationCenter()
        let origin = try XCTUnwrap(WorkspaceOrigin(string: "https://desk.example.test"))
        let marker = "phoneAsk.setup.v1." + origin.serialized
        defaults.set("paired-key", forKey: marker)
        let token = "murage_pa_" + String(repeating: "A", count: 43)
        var locked = true, exists = true, deletes = 0
        let deleted = expectation(description: "unlock retries deletion")
        let store = PhoneAskTokenStore(operations: .init(update: { _, _ in errSecSuccess }, add: { _ in errSecSuccess },
            read: { _ in exists ? (errSecSuccess, Data(token.utf8)) : (errSecItemNotFound, nil) },
            delete: { _ in
                deletes += 1
                if locked { return errSecInteractionNotAllowed }
                exists = false
                deleted.fulfill()
                return errSecSuccess
            }), accessGroup: "TEAM.com.murage.mobile.ask")
        let queue = PhoneAskSetup.PendingRemovals(defaults: defaults, root: root, notifications: notifications, cancelUploads: { _, done in done(true) }, remove: store.remove)
        XCTAssertFalse(queue.forget(origin))
        queue.retry() // Another locked attempt must retain the request too.
        XCTAssertEqual(deletes, 2)
        XCTAssertTrue(queue.contains(origin))
        XCTAssertTrue(SharePendingRemovals(root: root).contains(origin))
        XCTAssertEqual(defaults.string(forKey: marker), "paired-key")
        XCTAssertEqual(try store.readForAsk(origin: origin), token)
        locked = false
        notifications.post(name: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil)
        await fulfillment(of: [deleted], timeout: 1)
        XCTAssertFalse(queue.contains(origin))
        XCTAssertNil(defaults.string(forKey: marker))
        XCTAssertNil(try store.readForAsk(origin: origin))
        queue.retry()
        XCTAssertEqual(deletes, 3)
    }

    func testPendingRemovalSurvivesOwnerRecreationAndOnlyClearsSuccessfulOrigins() throws {
        let root = try removalDirectory()
        let suite = "ask-removal-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = try XCTUnwrap(WorkspaceOrigin(string: "https://desk.example.test"))
        let second = try XCTUnwrap(WorkspaceOrigin(string: "https://other.example.test"))
        for origin in [first, second] { defaults.set("key", forKey: "phoneAsk.setup.v1." + origin.serialized) }
        var queue: PhoneAskSetup.PendingRemovals? = .init(defaults: defaults, root: root, notifications: NotificationCenter(),
            cancelUploads: { _, done in done(true) }, remove: { _ in throw PhoneAskTokenStore.StoreError.storage })
        XCTAssertFalse(try XCTUnwrap(queue).forget(first))
        XCTAssertFalse(try XCTUnwrap(queue).forget(second))
        queue = nil
        let store = PhoneAskTokenStore(operations: .init(update: { _, _ in errSecSuccess }, add: { _ in errSecSuccess },
            read: { _ in (errSecItemNotFound, nil) }, delete: { query in
                query[kSecAttrAccount as String] as? String == first.serialized ? errSecItemNotFound : errSecInteractionNotAllowed
            }), accessGroup: "TEAM.com.murage.mobile.ask")
        let restored = PhoneAskSetup.PendingRemovals(defaults: defaults, root: root, notifications: NotificationCenter(), cancelUploads: { _, done in done(true) }, remove: store.remove)
        restored.retry()
        XCTAssertFalse(restored.contains(first))
        XCTAssertNil(defaults.string(forKey: "phoneAsk.setup.v1." + first.serialized))
        XCTAssertTrue(restored.contains(second))
        XCTAssertEqual(defaults.string(forKey: "phoneAsk.setup.v1." + second.serialized), "key")
    }
    func testRetrySnapshotsAllPendingOriginsAndMigratesLegacyDefaults() throws {
        let root = try removalDirectory()
        let suite = "ask-removal-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = try XCTUnwrap(WorkspaceOrigin(string: "https://desk.example.test"))
        let second = try XCTUnwrap(WorkspaceOrigin(string: "https://other.example.test"))
        defaults.set([first.serialized, second.serialized], forKey: "phoneAsk.pendingRemovals.v1")
        var deleted = Set<String>()
        let queue = PhoneAskSetup.PendingRemovals(defaults: defaults, root: root, notifications: NotificationCenter(), cancelUploads: { _, done in done(true) }) {
            deleted.insert($0.serialized)
        }
        let shared = SharePendingRemovals(root: root)
        XCTAssertEqual(try shared.read(), Set([first.serialized, second.serialized]))
        XCTAssertNil(defaults.object(forKey: "phoneAsk.pendingRemovals.v1"))
        queue.retry()
        XCTAssertEqual(deleted, Set([first.serialized, second.serialized]))
        XCTAssertTrue(try shared.read().isEmpty)
        XCTAssertFalse(queue.contains(first))
        XCTAssertFalse(queue.contains(second))
    }
    #endif

    private static var mobile: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() }
        return url
    }

    private func fixture(_ name: String = "phone-ask.json") throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.mobile.appendingPathComponent("contract/" + name))) as? [String: Any])
    }

    private func vector() throws -> [String: Any] {
        try XCTUnwrap((fixture()["mint"] as? [String: Any])?["vector"] as? [String: Any])
    }

    private func response(_ json: [String: Any], status: Int = 200) throws -> PhoneJobsMintClient.Response {
        .init(status: status, body: try JSONSerialization.data(withJSONObject: json))
    }

    private final class Writer: PhoneJobsTokenWriting {
        var writes: [(String, WorkspaceOrigin)] = []
        var fails = false
        func save(_ token: String, origin: WorkspaceOrigin) throws {
            if fails { throw PhoneJobsMintError.storage }
            writes.append((token, origin))
        }
    }

    private func expect(_ expected: PhoneJobsMintError, _ work: () async throws -> Void) async {
        do { try await work(); XCTFail("expected \(expected)") }
        catch { XCTAssertEqual(error as? PhoneJobsMintError, expected) }
    }

    func testSignerUsesFixtureBytesAndDERAndSoftwareKeyVerifies() async throws {
        let v = try vector(), origin = try XCTUnwrap(WorkspaceOrigin(string: v["origin"] as! String))
        let point = v["point"] as! String, nonce = v["nonce"] as! String, keyId = v["keyId"] as! String
        let expiry = (v["expiresAt"] as! NSNumber).int64Value
        var prompts = 0
        // The fixture deliberately contains no private key. This fake returns
        // its committed DER only when asked to sign the exact fixture bytes.
        let signer = PhoneAskSigner(point: { _ in point }) { request in
            prompts += 1
            XCTAssertEqual(request.message, Data((v["message"] as! String).utf8))
            return v["signature"] as! String
        }
        let signature = try await signer.sign(origin: origin, keyId: keyId, nonce: nonce, expiresAt: expiry)
        let publicKey = try P256.Signing.PublicKey(x963Representation: XCTUnwrap(ApprovalProof.data(base64url: point)))
        let der = try P256.Signing.ECDSASignature(derRepresentation: XCTUnwrap(ApprovalProof.data(base64url: signature)))
        XCTAssertTrue(publicKey.isValidSignature(der, for: Data((v["message"] as! String).utf8)))
        XCTAssertEqual(prompts, 1)
        XCTAssertFalse(signature.contains("="))
        let mint = try XCTUnwrap(fixture()["mint"] as? [String: Any])
        let cross = try XCTUnwrap(mint["crossPurpose"] as? [String: Any])
        let jobs = try XCTUnwrap(cross["askVectorAsJobs"] as? [String: Any])
        XCTAssertFalse(publicKey.isValidSignature(der, for: Data((jobs["message"] as! String).utf8)))

        let key = P256.Signing.PrivateKey()
        let freshPoint = ApprovalProof.base64url(key.publicKey.x963Representation)
        let software = PhoneAskSigner(point: { _ in freshPoint }) { request in
            ApprovalProof.base64url(try key.signature(for: request.message).derRepresentation)
        }
        let freshId = try XCTUnwrap(software.keyId(origin: origin))
        let signed = try await software.sign(origin: origin, keyId: freshId, nonce: nonce, expiresAt: expiry)
        let message = PhoneAskContract.phoneAskMessage(origin: origin.serialized, keyId: freshId, nonce: nonce, expiresAt: expiry)
        XCTAssertTrue(key.publicKey.isValidSignature(try P256.Signing.ECDSASignature(derRepresentation: XCTUnwrap(ApprovalProof.data(base64url: signed))), for: Data(message.utf8)))
        await expect(.invalidResponse) { _ = try await signer.sign(origin: origin, keyId: keyId, nonce: nonce + "\n", expiresAt: expiry) }
        await expect(.noApprovalKey) { _ = try await signer.sign(origin: origin, keyId: freshId, nonce: nonce, expiresAt: expiry) }
        XCTAssertEqual(prompts, 1)
    }

    func testMintSuccessUsesDoorHelloExactRoutesOnePromptAndStoresWithoutReturningToken() async throws {
        let v = try vector(), origin = try XCTUnwrap(WorkspaceOrigin(string: v["origin"] as! String))
        let token = ((try fixture()["token"] as! [String: Any])["valid"] as! [String])[0]
        let writer = Writer()
        var prompts = 0, requests: [URLRequest] = []
        let signer = PhoneAskSigner(point: { _ in v["point"] as? String }) { request in
            prompts += 1
            XCTAssertEqual(request.message, Data((v["message"] as! String).utf8))
            return v["signature"] as! String
        }
        let answers = try [response(["mobile": 1, "phoneAsk": 2]), response(["nonce": v["nonce"]!, "expiresAt": v["expiresAt"]!]), response(["token": token])]
        let client = PhoneJobsMintClient(signer: signer, store: writer, send: { request in
            requests.append(request)
            return answers[requests.count - 1]
        }, now: { 1_700_000_000_000 })
        let result: Void = try await client.mint(origin: origin)
        _ = result // The screen's success cannot carry a bearer.
        XCTAssertEqual(prompts, 1)
        XCTAssertEqual(requests.map { $0.httpMethod! }, ["GET", "GET", "POST"])
        XCTAssertEqual(requests.map { $0.url!.absoluteString }, [origin.serialized + "/healthz", origin.serialized + "/api/phones/self/challenge?key=" + (v["keyId"] as! String), origin.serialized + "/api/phones/self/token"])
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(requests[2].httpBody)) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["keyId", "nonce", "expiresAt", "signature", "scope"])
        XCTAssertEqual(body["scope"] as? String, "ask")
        for field in ["keyId", "nonce", "expiresAt", "signature"] { XCTAssertEqual(String(describing: body[field]!), String(describing: v[field]!)) }
        for request in requests {
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        }
        XCTAssertEqual(writer.writes.count, 1)
        XCTAssertEqual(writer.writes.first?.0, token)
        XCTAssertEqual(writer.writes.first?.1, origin)
    }

    func testChallengeRefusalRateLimitAndNotOfferedNeverPromptOrStore() async throws {
        let v = try vector(), origin = try XCTUnwrap(WorkspaceOrigin(string: v["origin"] as! String))
        for (status, failure) in [(403, PhoneJobsMintError.refused), (429, .rateLimited), (404, .notOffered)] {
            let writer = Writer()
            var calls = 0
            let signer = PhoneAskSigner(point: { _ in v["point"] as? String }) { _ in XCTFail("no prompt"); return "" }
            let client = PhoneJobsMintClient(signer: signer, store: writer, send: { _ in
                calls += 1
                return try self.response(calls == 1 ? ["mobile": 1, "phoneAsk": 1] : [:], status: calls == 1 ? 200 : status)
            })
            await expect(failure) { try await client.mint(origin: origin) }
            XCTAssertEqual(calls, 2); XCTAssertTrue(writer.writes.isEmpty)
        }
    }

    func testPhoneFlagsWithoutFeatureShowsTurnedOffBeforeChallenge() async throws {
        let v = try vector(), origin = try XCTUnwrap(WorkspaceOrigin(string: v["origin"] as! String))
        XCTAssertEqual(PhoneJobStrings.text("ask_turned_off"), "Your computer hasn't turned this on yet. Turn it on in Murage on the computer, in Settings → Phone and other devices.")
        #if os(iOS)
        XCTAssertEqual(PhoneAskSetup.errorKey(PhoneJobsMintError.turnedOff), "ask_turned_off")
        #endif
        for flags in [1, 2] {
            let writer = Writer()
            var calls = 0
            let signer = PhoneAskSigner(point: { _ in v["point"] as? String }) { _ in XCTFail("no prompt"); return "" }
            let client = PhoneJobsMintClient(signer: signer, store: writer, send: { request in
                calls += 1
                XCTAssertEqual(request.url?.path, "/healthz")
                return try self.response(["mobile": 1, "phoneFlags": flags, "phoneJobs": 1])
            })
            await expect(.turnedOff) { try await client.mint(origin: origin) }
            XCTAssertEqual(calls, 1); XCTAssertTrue(writer.writes.isEmpty)
        }
    }

    func testMissingPhoneFlagsShowsTurnOnOrUpdateBeforeChallenge() async throws {
        let v = try vector(), origin = try XCTUnwrap(WorkspaceOrigin(string: v["origin"] as! String))
        XCTAssertEqual(PhoneJobStrings.text("ask_update"), "Turn this on, or update Murage, on your computer.")
        #if os(iOS)
        XCTAssertEqual(PhoneAskSetup.errorKey(PhoneJobsMintError.updateComputer), "ask_update")
        #endif
        let writer = Writer()
        var calls = 0
        let signer = PhoneAskSigner(point: { _ in v["point"] as? String }) { _ in XCTFail("no prompt"); return "" }
        let client = PhoneJobsMintClient(signer: signer, store: writer, send: { request in
            calls += 1
            XCTAssertEqual(request.url?.path, "/healthz")
            return try self.response(["mobile": 1])
        })
        await expect(.updateComputer) { try await client.mint(origin: origin) }
        XCTAssertEqual(calls, 1); XCTAssertTrue(writer.writes.isEmpty)
    }

    func testPhoneFlagsWithFeatureStillMints() async throws {
        let v = try vector(), origin = try XCTUnwrap(WorkspaceOrigin(string: v["origin"] as! String))
        let token = ((try fixture()["token"] as! [String: Any])["valid"] as! [String])[0]
        let writer = Writer()
        var calls = 0, prompts = 0
        let signer = PhoneAskSigner(point: { _ in v["point"] as? String }) { request in
            prompts += 1
            XCTAssertEqual(request.message, Data((v["message"] as! String).utf8))
            return v["signature"] as! String
        }
        let answers = try [response(["mobile": 1, "phoneFlags": 1, "phoneAsk": 1]),
                           response(["nonce": v["nonce"]!, "expiresAt": v["expiresAt"]!]), response(["token": token])]
        let client = PhoneJobsMintClient(signer: signer, store: writer, send: { _ in
            calls += 1
            return answers[calls - 1]
        }, now: { 1_700_000_000_000 })
        try await client.mint(origin: origin)
        XCTAssertEqual(calls, 3); XCTAssertEqual(prompts, 1)
        XCTAssertEqual(writer.writes.count, 1); XCTAssertEqual(writer.writes.first?.0, token)
    }

    func testOldDoorAndMissingKeyShowExactCopyBeforeChallenge() async throws {
        let v = try vector(), origin = try XCTUnwrap(WorkspaceOrigin(string: v["origin"] as! String))
        XCTAssertEqual(PhoneJobStrings.text("ask_update"), "Turn this on, or update Murage, on your computer.")
        XCTAssertEqual(PhoneJobStrings.text("ask_no_key"), "Set a passcode on this phone, then open Murage.")
        let invalidHellos: [[String: Any]] = [["mobile": 1], ["mobile": 1, "phoneJobs": 1], ["mobile": 1, "phoneAsk": 0], ["mobile": 1, "phoneAsk": true], ["mobile": 1, "phoneAsk": "1"], ["phoneAsk": 1]]
        for hello in invalidHellos {
            var calls = 0
            let signer = PhoneAskSigner(point: { _ in v["point"] as? String }) { _ in XCTFail("no prompt"); return "" }
            let client = PhoneJobsMintClient(signer: signer, store: Writer(), send: { _ in calls += 1; return try self.response(hello) })
            await expect(.updateComputer) { try await client.mint(origin: origin) }
            XCTAssertEqual(calls, 1)
        }
        let missing = PhoneAskSigner(point: { _ in nil }) { _ in XCTFail("no prompt"); return "" }
        let client = PhoneJobsMintClient(signer: missing, store: Writer(), send: { _ in XCTFail("no HTTP"); return try self.response([:]) })
        await expect(.noApprovalKey) { try await client.mint(origin: origin) }
    }

    func testMalformedTokensAndTokenRefusalsNeverWrite() async throws {
        let v = try vector(), origin = try XCTUnwrap(WorkspaceOrigin(string: v["origin"] as! String))
        let tokens = try fixture()["token"] as! [String: Any]
        let bad = (tokens["invalid"] as! [String]) + [(tokens["valid"] as! [String])[0] + "\n"]
        var cases: [(Int, [String: Any], PhoneJobsMintError)] = bad.map { (200, ["token": $0], .invalidResponse) }
        cases += [(200, ["token": true], .invalidResponse), (403, [:], .refused), (429, [:], .rateLimited), (503, [:], .unavailable)]
        for (status, body, error) in cases {
            let writer = Writer()
            var calls = 0, prompts = 0
            let signer = PhoneAskSigner(point: { _ in v["point"] as? String }) { _ in prompts += 1; return v["signature"] as! String }
            let client = PhoneJobsMintClient(signer: signer, store: writer, send: { _ in
                calls += 1
                if calls == 1 { return try self.response(["mobile": 1, "phoneAsk": 1]) }
                if calls == 2 { return try self.response(["nonce": v["nonce"]!, "expiresAt": v["expiresAt"]!]) }
                return try self.response(body, status: status)
            }, now: { 1_700_000_000_000 })
            await expect(error) { try await client.mint(origin: origin) }
            XCTAssertEqual(prompts, 1); XCTAssertEqual(calls, 3); XCTAssertTrue(writer.writes.isEmpty)
        }
    }

    func testMalformedChallengeCancelledPromptAndChangedKeyStopMint() async throws {
        let v = try vector(), origin = try XCTUnwrap(WorkspaceOrigin(string: v["origin"] as! String))
        for bad: Any in [true, "1700000060000", 1_700_000_060_000.5, 0, 9_007_199_254_740_992 as Int64] {
            var calls = 0
            let signer = PhoneAskSigner(point: { _ in v["point"] as? String }) { _ in XCTFail("no prompt"); return "" }
            let client = PhoneJobsMintClient(signer: signer, store: Writer(), send: { _ in
                calls += 1
                return try self.response(calls == 1 ? ["mobile": 1, "phoneAsk": 1] : ["nonce": v["nonce"]!, "expiresAt": bad])
            }, now: { 1_700_000_000_000 })
            await expect(.invalidResponse) { try await client.mint(origin: origin) }
            XCTAssertEqual(calls, 2)
        }
        for changed in [false, true] {
            var calls = 0, prompts = 0, point = v["point"] as? String
            let writer = Writer()
            let signer = PhoneAskSigner(point: { _ in point }) { _ in prompts += 1; throw PhoneJobsMintError.cancelled }
            let client = PhoneJobsMintClient(signer: signer, store: writer, send: { _ in
                calls += 1
                if calls == 1 { return try self.response(["mobile": 1, "phoneAsk": 1]) }
                if changed { point = nil }
                return try self.response(["nonce": v["nonce"]!, "expiresAt": v["expiresAt"]!])
            }, now: { 1_700_000_000_000 })
            await expect(changed ? .noApprovalKey : .cancelled) { try await client.mint(origin: origin) }
            XCTAssertEqual(prompts, changed ? 0 : 1); XCTAssertEqual(calls, 2); XCTAssertTrue(writer.writes.isEmpty)
        }
    }

    func testKeychainUsesAskGroupWhenUnlockedOnAddAndUpdateAndLockedReadFails() throws {
        let origin = try XCTUnwrap(WorkspaceOrigin(string: "https://desk.example.test"))
        let token = "murage_pa_" + String(repeating: "A", count: 43)
        var queries: [[String: Any]] = [], writes: [[String: Any]] = []
        var existing = false, locked = false
        let store = PhoneAskTokenStore(operations: .init(update: { query, changes in
            queries.append(query); writes.append(changes)
            return existing ? errSecSuccess : errSecItemNotFound
        }, add: { item in queries.append(item); writes.append(item); existing = true; return errSecSuccess }, read: { query in
            queries.append(query)
            return locked ? (errSecInteractionNotAllowed, nil) : (errSecSuccess, Data(token.utf8))
        }, delete: { query in queries.append(query); return errSecSuccess }), accessGroup: "TEAM.com.murage.mobile.ask")
        try store.save(token, origin: origin)
        try store.save(token, origin: origin)
        XCTAssertEqual(try store.readForAsk(origin: origin), token)
        locked = true
        XCTAssertThrowsError(try store.readForAsk(origin: origin))
        try store.remove(origin: origin)
        for query in queries {
            XCTAssertEqual(query[kSecAttrAccessGroup as String] as? String, "TEAM.com.murage.mobile.ask")
            XCTAssertEqual(query[kSecAttrSynchronizable as String] as? Bool, false)
            XCTAssertEqual(query[kSecAttrAccount as String] as? String, origin.serialized)
            XCTAssertEqual(query[kSecAttrService as String] as? String, "com.murage.mobile.ask.token")
        }
        // The app-only group stays first, ask second. The NSE has no ask entitlement.
        let entitlements = try Data(contentsOf: Self.mobile.appendingPathComponent("ios/App/App/App.entitlements"))
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: entitlements, format: nil) as? [String: Any])
        let groups = try XCTUnwrap(plist["keychain-access-groups"] as? [String])
        XCTAssertEqual(groups.first, "$(AppIdentifierPrefix)com.murage.mobile")
        XCTAssertEqual(groups[1], "$(AppIdentifierPrefix)com.murage.mobile.ask")
        let nse = try Data(contentsOf: Self.mobile.appendingPathComponent("ios/App/NotificationService/NotificationService.entitlements"))
        let nsePlist = try XCTUnwrap(PropertyListSerialization.propertyList(from: nse, format: nil) as? [String: Any])
        let nseGroups = try XCTUnwrap(nsePlist["keychain-access-groups"] as? [String])
        XCTAssertFalse(nseGroups.contains("$(AppIdentifierPrefix)com.murage.mobile.ask"))
        XCTAssertEqual(nseGroups, ["$(AppIdentifierPrefix)com.murage.mobile.shared"])
        let info = try Data(contentsOf: Self.mobile.appendingPathComponent("ios/App/App/Info.plist"))
        let infoPlist = try XCTUnwrap(PropertyListSerialization.propertyList(from: info, format: nil) as? [String: Any])
        XCTAssertEqual(infoPlist["MurageAskKeychainGroup"] as? String, groups[1])
        XCTAssertEqual(writes.count, 3)
        for write in writes { XCTAssertEqual(write[kSecAttrAccessible as String] as? String, kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String) }
        XCTAssertThrowsError(try store.save(token + "\n", origin: origin))
        XCTAssertEqual(writes.count, 3)
    }

    func testBusyAndCancellationIgnoreLateAnswersWithoutPrompting() async throws {
        let v = try vector(), origin = try XCTUnwrap(WorkspaceOrigin(string: v["origin"] as! String))
        let writer = Writer()
        let started = expectation(description: "hello requested")
        var held: CheckedContinuation<PhoneJobsMintClient.Response, Error>?
        let signer = PhoneAskSigner(point: { _ in v["point"] as? String }) { _ in XCTFail("no prompt"); return "" }
        let client = PhoneJobsMintClient(signer: signer, store: writer, send: { _ in
            try await withCheckedThrowingContinuation { continuation in
                held = continuation
                started.fulfill()
            }
        })
        let first = Task { try await client.mint(origin: origin) }
        await fulfillment(of: [started], timeout: 1)
        await expect(.busy) { try await client.mint(origin: origin) }
        first.cancel()
        try XCTUnwrap(held).resume(returning: response(["mobile": 1, "phoneAsk": 1]))
        do { try await first.value; XCTFail("cancelled mint completed") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(writer.writes.isEmpty)
    }

    func testStorageFailureCannotReportMintSuccess() async throws {
        let v = try vector(), origin = try XCTUnwrap(WorkspaceOrigin(string: v["origin"] as! String))
        let writer = Writer(); writer.fails = true
        var calls = 0
        let signer = PhoneAskSigner(point: { _ in v["point"] as? String }) { _ in v["signature"] as! String }
        let client = PhoneJobsMintClient(signer: signer, store: writer, send: { _ in
            calls += 1
            if calls == 1 { return try self.response(["mobile": 1, "phoneAsk": 1]) }
            if calls == 2 { return try self.response(["nonce": v["nonce"]!, "expiresAt": v["expiresAt"]!]) }
            return try self.response(["token": "murage_pa_" + String(repeating: "A", count: 43)])
        }, now: { 1_700_000_000_000 })
        await expect(.storage) { try await client.mint(origin: origin) }
        XCTAssertEqual(calls, 3); XCTAssertTrue(writer.writes.isEmpty)
    }

    func testEveryBridgeEntryRemainsSeparateFromMintAndTokenStore() throws {
        let allowed = Set("hello ready saveFile openExternal haptic signOut rePair setRoute showLauncher registerPush pushStatus issuePushTokens setBadgeCount callSessionOpen callSessionClose diagLine openPhoneForBots approveWithDevice callAudioOpen callAudioClose callAudioPlay callAudioControl".split(separator: " ").map(String.init))
        XCTAssertEqual(Set(ChannelMethod.allCases.map(\.rawValue)), allowed)
        for name in ["phoneAsk", "mintPhoneAsk", "signPhoneAsk", "readForAsk", "PhoneAskSigner"] {
            guard case .failure(.unknownMethod) = ChannelGate.parse(["method": name, "args": [:]]) else { XCTFail(name); continue }
        }
        let entries = try XCTUnwrap(fixture("approval-proof.json")["accepted"] as? [[String: Any]])
        let v = try vector()
        let key = P256.Signing.PrivateKey()
        for entry in entries {
            var args = try XCTUnwrap(entry["args"] as? [String: Any])
            args["tag"] = PhoneAskSigner.tag; args["message"] = v["message"]
            let request = try XCTUnwrap(ApprovalRequest.parse(args))
            XCTAssertTrue(String(decoding: request.message, as: UTF8.self).hasPrefix("murage-approval-proof/1\n"))
            let signed = try key.signature(for: request.message)
            XCTAssertFalse(key.publicKey.isValidSignature(signed, for: Data((v["message"] as! String).utf8)))
        }
        // Audit the actual dispatch, including every branch, in the macOS
        // suite where UIKit cannot be instantiated. New bridge wiring fails here.
        let source = try String(contentsOf: Self.mobile.appendingPathComponent("ios/App/MurageShell/Sources/MurageShell/WorkspaceViewController.swift"))
        let dispatch = try XCTUnwrap(source.range(of: "private func dispatch("))
        let end = try XCTUnwrap(source.range(of: "\n    }\n", range: dispatch.upperBound..<source.endIndex))
        let tail = String(source[dispatch.lowerBound..<end.upperBound])
        for forbidden in ["PhoneAskSigner", "PhoneJobsMint", "PhoneAskTokenStore", "signPhoneAsk", "readForAsk", "murage_pa_"] { XCTAssertFalse(tail.contains(forbidden), forbidden) }
        XCTAssertTrue(tail.contains("ApprovalKeys.sign(origin: origin, request: approval)"))
        XCTAssertEqual(Set(ChannelGate.hello().keys), ["version", "methods"])
    }
}
