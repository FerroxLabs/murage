import CryptoKit
import Foundation
import MurageShellCore
import Security
import XCTest
@testable import MurageShell

@MainActor
final class PhoneJobsMintTests: XCTestCase {
    private static var mobile: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() }
        return url
    }

    private func fixture(_ name: String = "phone-jobs.json") throws -> [String: Any] {
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
        let signer = PhoneJobsSigner(point: { _ in point }) { request in
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

        let key = P256.Signing.PrivateKey()
        let freshPoint = ApprovalProof.base64url(key.publicKey.x963Representation)
        let software = PhoneJobsSigner(point: { _ in freshPoint }) { request in
            ApprovalProof.base64url(try key.signature(for: request.message).derRepresentation)
        }
        let freshId = try XCTUnwrap(software.keyId(origin: origin))
        let signed = try await software.sign(origin: origin, keyId: freshId, nonce: nonce, expiresAt: expiry)
        let message = PhoneJobsContract.phoneJobsMessage(origin: origin.serialized, keyId: freshId, nonce: nonce, expiresAt: expiry)
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
        let signer = PhoneJobsSigner(point: { _ in v["point"] as? String }) { request in
            prompts += 1
            XCTAssertEqual(request.message, Data((v["message"] as! String).utf8))
            return v["signature"] as! String
        }
        let answers = try [response(["mobile": 1, "phoneJobs": 2]), response(["nonce": v["nonce"]!, "expiresAt": v["expiresAt"]!]), response(["token": token])]
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
        XCTAssertEqual(Set(body.keys), ["keyId", "nonce", "expiresAt", "signature"])
        for field in body.keys { XCTAssertEqual(String(describing: body[field]!), String(describing: v[field]!)) }
        for request in requests {
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        }
        XCTAssertEqual(writer.writes.count, 1)
        XCTAssertEqual(writer.writes.first?.0, token)
        XCTAssertEqual(writer.writes.first?.1, origin)
    }

    func testChallenge403And429NeverPromptOrStore() async throws {
        let v = try vector(), origin = try XCTUnwrap(WorkspaceOrigin(string: v["origin"] as! String))
        for (status, failure) in [(403, PhoneJobsMintError.refused), (429, .rateLimited)] {
            let writer = Writer()
            var calls = 0
            let signer = PhoneJobsSigner(point: { _ in v["point"] as? String }) { _ in XCTFail("no prompt"); return "" }
            let client = PhoneJobsMintClient(signer: signer, store: writer, send: { _ in
                calls += 1
                return try self.response(calls == 1 ? ["mobile": 1, "phoneJobs": 1] : [:], status: calls == 1 ? 200 : status)
            })
            await expect(failure) { try await client.mint(origin: origin) }
            XCTAssertEqual(calls, 2); XCTAssertTrue(writer.writes.isEmpty)
        }
    }

    func testOldDoorAndMissingKeyShowExactCopyBeforeChallenge() async throws {
        let v = try vector(), origin = try XCTUnwrap(WorkspaceOrigin(string: v["origin"] as! String))
        XCTAssertEqual(PhoneJobsMintError.updateComputer.errorDescription, "Update Murage on your computer")
        XCTAssertEqual(PhoneJobsMintError.noApprovalKey.errorDescription, "Set a passcode on this phone, then pair again")
        let invalidHellos: [[String: Any]] = [["mobile": 1], ["mobile": 1, "phoneJobs": 0], ["mobile": 1, "phoneJobs": true], ["mobile": 1, "phoneJobs": "1"], ["phoneJobs": 1]]
        for hello in invalidHellos {
            var calls = 0
            let signer = PhoneJobsSigner(point: { _ in v["point"] as? String }) { _ in XCTFail("no prompt"); return "" }
            let client = PhoneJobsMintClient(signer: signer, store: Writer(), send: { _ in calls += 1; return try self.response(hello) })
            await expect(.updateComputer) { try await client.mint(origin: origin) }
            XCTAssertEqual(calls, 1)
        }
        let missing = PhoneJobsSigner(point: { _ in nil }) { _ in XCTFail("no prompt"); return "" }
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
            let signer = PhoneJobsSigner(point: { _ in v["point"] as? String }) { _ in prompts += 1; return v["signature"] as! String }
            let client = PhoneJobsMintClient(signer: signer, store: writer, send: { _ in
                calls += 1
                if calls == 1 { return try self.response(["mobile": 1, "phoneJobs": 1]) }
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
            let signer = PhoneJobsSigner(point: { _ in v["point"] as? String }) { _ in XCTFail("no prompt"); return "" }
            let client = PhoneJobsMintClient(signer: signer, store: Writer(), send: { _ in
                calls += 1
                return try self.response(calls == 1 ? ["mobile": 1, "phoneJobs": 1] : ["nonce": v["nonce"]!, "expiresAt": bad])
            }, now: { 1_700_000_000_000 })
            await expect(.invalidResponse) { try await client.mint(origin: origin) }
            XCTAssertEqual(calls, 2)
        }
        for changed in [false, true] {
            var calls = 0, prompts = 0, point = v["point"] as? String
            let writer = Writer()
            let signer = PhoneJobsSigner(point: { _ in point }) { _ in prompts += 1; throw PhoneJobsMintError.cancelled }
            let client = PhoneJobsMintClient(signer: signer, store: writer, send: { _ in
                calls += 1
                if calls == 1 { return try self.response(["mobile": 1, "phoneJobs": 1]) }
                if changed { point = nil }
                return try self.response(["nonce": v["nonce"]!, "expiresAt": v["expiresAt"]!])
            }, now: { 1_700_000_000_000 })
            await expect(changed ? .noApprovalKey : .cancelled) { try await client.mint(origin: origin) }
            XCTAssertEqual(prompts, changed ? 0 : 1); XCTAssertEqual(calls, 2); XCTAssertTrue(writer.writes.isEmpty)
        }
    }

    func testKeychainIsAppOnlyWhenUnlockedOnAddAndUpdateAndLockedReadFails() throws {
        let origin = try XCTUnwrap(WorkspaceOrigin(string: "https://desk.example.test"))
        let token = "murage_pj_" + String(repeating: "A", count: 43)
        var queries: [[String: Any]] = [], writes: [[String: Any]] = []
        var existing = false, locked = false
        let store = PhoneJobsTokenStore(operations: .init(update: { query, changes in
            queries.append(query); writes.append(changes)
            return existing ? errSecSuccess : errSecItemNotFound
        }, add: { item in queries.append(item); writes.append(item); existing = true; return errSecSuccess }, read: { query in
            queries.append(query)
            return locked ? (errSecInteractionNotAllowed, nil) : (errSecSuccess, Data(token.utf8))
        }, delete: { query in queries.append(query); return errSecSuccess }))
        try store.save(token, origin: origin)
        try store.save(token, origin: origin)
        XCTAssertEqual(try store.readForRunner(origin: origin), token)
        locked = true
        XCTAssertThrowsError(try store.readForRunner(origin: origin))
        try store.remove(origin: origin)
        for query in queries {
            XCTAssertNil(query[kSecAttrAccessGroup as String])
            XCTAssertEqual(query[kSecAttrSynchronizable as String] as? Bool, false)
            XCTAssertEqual(query[kSecAttrAccount as String] as? String, origin.serialized)
            XCTAssertEqual(query[kSecAttrService as String] as? String, "com.murage.mobile.phone-jobs")
        }
        // The omitted group resolves to the app group because it is first
        // in the existing entitlement. A future ordering change must fail.
        let entitlements = try Data(contentsOf: Self.mobile.appendingPathComponent("ios/App/App/App.entitlements"))
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: entitlements, format: nil) as? [String: Any])
        let groups = try XCTUnwrap(plist["keychain-access-groups"] as? [String])
        XCTAssertEqual(groups.first, "$(AppIdentifierPrefix)com.murage.mobile")
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
        let signer = PhoneJobsSigner(point: { _ in v["point"] as? String }) { _ in XCTFail("no prompt"); return "" }
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
        try XCTUnwrap(held).resume(returning: response(["mobile": 1, "phoneJobs": 1]))
        do { try await first.value; XCTFail("cancelled mint completed") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(writer.writes.isEmpty)
    }

    func testStorageFailureCannotReportMintSuccess() async throws {
        let v = try vector(), origin = try XCTUnwrap(WorkspaceOrigin(string: v["origin"] as! String))
        let writer = Writer(); writer.fails = true
        var calls = 0
        let signer = PhoneJobsSigner(point: { _ in v["point"] as? String }) { _ in v["signature"] as! String }
        let client = PhoneJobsMintClient(signer: signer, store: writer, send: { _ in
            calls += 1
            if calls == 1 { return try self.response(["mobile": 1, "phoneJobs": 1]) }
            if calls == 2 { return try self.response(["nonce": v["nonce"]!, "expiresAt": v["expiresAt"]!]) }
            return try self.response(["token": "murage_pj_" + String(repeating: "A", count: 43)])
        }, now: { 1_700_000_000_000 })
        await expect(.storage) { try await client.mint(origin: origin) }
        XCTAssertEqual(calls, 3); XCTAssertTrue(writer.writes.isEmpty)
    }

    func testEveryBridgeEntryRemainsSeparateFromMintAndTokenStore() throws {
        let allowed = Set("hello ready saveFile openExternal haptic signOut rePair setRoute showLauncher registerPush pushStatus issuePushTokens setBadgeCount callSessionOpen callSessionClose diagLine openPhoneForBots approveWithDevice callAudioOpen callAudioClose callAudioPlay callAudioControl".split(separator: " ").map(String.init))
        XCTAssertEqual(Set(ChannelMethod.allCases.map(\.rawValue)), allowed)
        for name in ["phoneJobs", "mintPhoneJobs", "signPhoneJobs", "readForRunner", "PhoneJobsSigner"] {
            guard case .failure(.unknownMethod) = ChannelGate.parse(["method": name, "args": [:]]) else { XCTFail(name); continue }
        }
        let entries = try XCTUnwrap(fixture("approval-proof.json")["accepted"] as? [[String: Any]])
        let v = try vector()
        let key = P256.Signing.PrivateKey()
        for entry in entries {
            var args = try XCTUnwrap(entry["args"] as? [String: Any])
            args["tag"] = PhoneJobsSigner.tag; args["message"] = v["message"]
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
        for forbidden in ["PhoneJobsSigner", "PhoneJobsMint", "PhoneJobsTokenStore", "signPhoneJobs", "readForRunner", "murage_pj_"] { XCTAssertFalse(tail.contains(forbidden), forbidden) }
        XCTAssertTrue(tail.contains("ApprovalKeys.sign(origin: origin, request: approval)"))
        XCTAssertEqual(Set(ChannelGate.hello().keys), ["version", "methods"])
    }
}
