import Foundation
import Security
import XCTest
@testable import MurageShellCore

final class AskIntentTests: XCTestCase {
    private let origin = WorkspaceOrigin(string: "https://desk.example.test")!
    private let now: Int64 = 1_800_000_000_000
    private let token = "murage_pa_" + String(repeating: "A", count: 43)
    private let askId = "ask_0001_abcdefghij"

    private func fixture() throws -> [String: Any] {
        try XCTUnwrap(Fixtures.json("phone-ask.json") as? [String: Any])
    }
    private func ask() throws -> [String: Any] { try XCTUnwrap(fixture()["ask"] as? [String: Any]) }
    private func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
    private func targets() throws -> AskCachedTargets {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("n13-" + UUID().uuidString)
        let suite = "n13-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock {
            try? FileManager.default.removeItem(at: root)
            defaults.removePersistentDomain(forName: suite)
        }
        var book = WorkspaceBook()
        book.signedIn(origin, name: "Computer", at: now)
        try ShareWorkspaceStore(root: root).write(book)
        let targetFixture = try XCTUnwrap(fixture()["targets"] as? [String: Any])
        let answer = try JSONDecoder().decode(PhoneAskContract.TargetsAnswer.self, from: bytes(XCTUnwrap(targetFixture["answer"])))
        try ShareTargetCache(root: root).write(answer, origin: origin, now: now)
        return AskCachedTargets(root: root, last: ShareLastTarget(defaults: defaults))
    }

    func testEveryS25AnswerAndErrorChoosesOnlyDesignDialogs() throws {
        let fixture = try ask()
        var sent = try XCTUnwrap(fixture["answer"] as? [String: Any])
        XCTAssertEqual(sent["proven"] as? Bool, false) // the shared fixture is an unproven (plain) ask
        XCTAssertEqual(AskIntentResponse.outcome(status: 200, data: try bytes(sent), askId: askId, threadId: nil).dialog, .sentPlain)
        XCTAssertEqual(AskIntentResponse.outcome(status: 200, data: try bytes(sent), askId: askId, threadId: nil, unproven: .sentWithoutChat).dialog, .sentWithoutChat)
        sent["proven"] = true
        for notify in [true, false] {
            sent["notify"] = notify
            let result = AskIntentResponse.outcome(status: 200, data: try bytes(sent), askId: askId, threadId: nil)
            XCTAssertEqual(result.dialog, notify ? .sentNotify : .sentChat)
            XCTAssertEqual(result.threadId, sent["threadId"] as? String)
            XCTAssertEqual(result.id, "m-0002")
            XCTAssertTrue(result.showsSnippet)
            XCTAssertEqual(result.openHash, "#open=6c1e2f40-5b7d-4a93-8e16-0f2d9a7b3c58")
            XCTAssertEqual(result.askHash, "#open=6c1e2f40-5b7d-4a93-8e16-0f2d9a7b3c58&compose=1&again=m-0002")
        }
        let errors = try XCTUnwrap(fixture["errors"] as? [[String: Any]])
        let expected: [AskDialog] = [.unreachable, .targetGone, .unreachable, .setup, .setup, .update]
        XCTAssertEqual(errors.count, expected.count)
        for (entry, dialog) in zip(errors, expected) {
            let status = try XCTUnwrap(entry["status"] as? Int)
            let data = try entry["body"].map(bytes) ?? Data("not JSON".utf8)
            let result = AskIntentResponse.outcome(status: status, data: data, askId: askId, threadId: "cached-thread")
            XCTAssertEqual(result.dialog, dialog, "S25 status \(status)")
            XCTAssertEqual(result.showsSnippet, dialog != .unreachable)
            XCTAssertNil(result.id)
        }
    }

    func testUnknownResponseTextIsNeverDecodedOrPresented() throws {
        let fixture = try ask()
        let original = try XCTUnwrap(fixture["answer"] as? [String: Any])
        let expected = AskIntentResponse.outcome(status: 200, data: try bytes(original), askId: askId, threadId: nil)
        // Wrong types would fail any String decode, including decodeIfPresent.
        // Changing every content field must leave the outcome identical.
        for poison in ["private response text", ["nested": [1, 2]], [false, true], NSNull()] as [Any] {
            var response = original
            for key in ["answer", "text", "chat", "chatText", "message", "content", "error"] { response[key] = poison }
            let actual = AskIntentResponse.outcome(status: 200, data: try bytes(response), askId: askId, threadId: nil)
            XCTAssertEqual(actual, expected)
            XCTAssertFalse(actual.dialog.text(botName: "Ember").contains("private response text"))
            response["code"] = "target_gone"
            XCTAssertEqual(AskIntentResponse.outcome(status: 409, data: try bytes(response), askId: askId, threadId: nil).dialog, .targetGone)
            response["code"] = "revoked"
            XCTAssertEqual(AskIntentResponse.outcome(status: 403, data: try bytes(response), askId: askId, threadId: nil).dialog, .setup)
        }
    }

    func testMalformedAndMismatchedReceiptsNeverConfirm() throws {
        let original = try XCTUnwrap(ask()["answer"] as? [String: Any])
        let mutations: [(String, Any)] = [("state", "answered"), ("askId", "another-ask"), ("notify", "true"),
                                         ("threadId", ""), ("threadId", "bot:wrong"), ("id", "")]
        for (key, value) in mutations {
            var response = original; response[key] = value
            XCTAssertEqual(AskIntentResponse.outcome(status: 200, data: try bytes(response), askId: askId, threadId: nil).dialog, .unreachable)
        }
        for key in original.keys where key != "proven" {
            var response = original; response.removeValue(forKey: key)
            XCTAssertEqual(AskIntentResponse.outcome(status: 200, data: try bytes(response), askId: askId, threadId: nil).dialog, .unreachable)
        }
        // A harness that predates owner proof sends no `proven`: today's dialog, never "can't reach".
        var older = original; older.removeValue(forKey: "proven")
        XCTAssertEqual(AskIntentResponse.outcome(status: 200, data: try bytes(older), askId: askId, threadId: nil).dialog, .sentNotify)
        for status in [200, 403, 409, 422, 429, 500, 502, 503] {
            XCTAssertEqual(AskIntentResponse.outcome(status: status, data: Data("{".utf8), askId: askId, threadId: nil).dialog, status == 403 ? .setup : .unreachable)
        }
        XCTAssertEqual(AskIntentResponse.outcome(status: 409, data: try bytes(["code": "revoked"]), askId: askId, threadId: nil).dialog, .unreachable)
        XCTAssertEqual(AskIntentResponse.outcome(status: 403, data: try bytes(["code": "target_gone"]), askId: askId, threadId: nil).dialog, .setup)
    }

    func testResponseDecodersAccessOnlyReceiptAndCodeFields() throws {
        var response = try XCTUnwrap(ask()["answer"] as? [String: Any])
        for key in ["answer", "text", "chatText", "chat", "error", "content"] { response[key] = "must never be read" }
        response["code"] = "revoked"
        let decoder = JSONDecoder()
        let audit = AskReadAudit()
        decoder.userInfo[AskReadAudit.key] = audit
        _ = try decoder.decode(AuditedAskValue<AskIntentResponse.Receipt>.self, from: bytes(response))
        XCTAssertEqual(audit.keys, Set(["state", "askId", "threadId", "id", "notify", "proven"]))
        audit.keys.removeAll()
        _ = try decoder.decode(AuditedAskValue<AskIntentResponse.Failure>.self, from: bytes(response))
        XCTAssertEqual(audit.keys, Set(["code"]))
    }

    @MainActor
    func testOneTokenReadAndOnePostForEveryServerOutcome() async throws {
        let fixture = try ask()
        var cases = try XCTUnwrap(fixture["errors"] as? [[String: Any]])
        let sent = try XCTUnwrap(fixture["answer"] as? [String: Any])
        cases.append(["status": 200, "body": sent])
        var noNotify = sent; noNotify["notify"] = false
        cases.append(["status": 200, "body": noNotify])
        for status in [502, 503] { cases.append(["status": status]) }
        for entry in cases {
            let targets = try targets()
            var reads = 0, posts = 0
            let status = try XCTUnwrap(entry["status"] as? Int)
            let data = try entry["body"].map(bytes) ?? Data()
            let run = AskIntentRun(targets: targets, readToken: { [self] readOrigin in
                XCTAssertEqual(readOrigin, origin); reads += 1; return token
            }, removal: ShareOriginRemoval(root: targets.root, removeToken: { _ in }, cancelUploads: { _, done in done(true) }), post: { [self] request in
                posts += 1
                XCTAssertEqual(reads, 1)
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.url?.absoluteString, "https://desk.example.test/api/phones/self/ask")
                XCTAssertEqual(request.timeoutInterval, 5)
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer " + token)
                XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
                let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: String])
                XCTAssertEqual(body, ["askId": askId, "botId": "bot-lena", "text": "Question"])
                return .init(status: status, data: data)
            })
            let result = await run.run(identity: nil, text: "Question", now: now, askId: askId)
            XCTAssertEqual(reads, 1); XCTAssertEqual(posts, 1)
            XCTAssertEqual(result.dialog, AskIntentResponse.outcome(status: status, data: data, askId: askId, threadId: nil).dialog)
        }
    }

    @MainActor
    func testLockedMissingAndUnreadableKeychainNeverPost() async throws {
        for status in [errSecInteractionNotAllowed, errSecAuthFailed, errSecItemNotFound, errSecDecode] {
            var reads = 0
            let store = PhoneAskTokenStore(operations: .init(update: { _, _ in XCTFail(); return errSecParam },
                add: { _ in XCTFail(); return errSecParam }, read: { query in
                    reads += 1
                    XCTAssertEqual(query[kSecAttrService as String] as? String, "com.murage.mobile.ask.token")
                    return (status, nil)
                }, delete: { _ in XCTFail(); return errSecParam }), accessGroup: "TEST.com.murage.mobile.ask")
            let run = AskIntentRun(targets: try targets(), readToken: store.readForAsk,
                post: { _ in XCTFail("Locked phone must never POST"); throw URLError(.badURL) })
            let outcome = await run.run(identity: nil, text: "Question", now: now)
            XCTAssertEqual(outcome.dialog, .setup)
            XCTAssertEqual(reads, 1)
        }
    }

    @MainActor
    func testNetworkTimeoutAndCancellationNeverRetryOrReadTokenAgain() async throws {
        for error in [URLError(.timedOut), URLError(.notConnectedToInternet), CancellationError()] as [Error] {
            var reads = 0, posts = 0
            let run = AskIntentRun(targets: try targets(), readToken: { [self] _ in reads += 1; return token },
                post: { _ in posts += 1; throw error })
            let result = await run.run(identity: nil, text: "Question", now: now)
            XCTAssertEqual(result, .init(.unreachable))
            XCTAssertEqual(reads, 1); XCTAssertEqual(posts, 1)
        }
    }

    @MainActor
    func testFreshAskIdForEachInvocationAndLastUsedBot() async throws {
        let targets = try targets()
        targets.last.remember(origin: origin.serialized, botId: "bot-max")
        var ids: [String] = []
        let run = AskIntentRun(targets: targets, readToken: { [self] _ in token }, post: { request in
            let body = try JSONDecoder().decode(PhoneAskContract.AskRequest.self, from: XCTUnwrap(request.httpBody))
            XCTAssertEqual(body.botId, "bot-max")
            ids.append(body.askId)
            return .init(status: 503, data: Data())
        })
        _ = await run.run(identity: nil, text: "Question", now: now)
        _ = await run.run(identity: nil, text: "Question", now: now)
        XCTAssertEqual(ids.count, 2)
        XCTAssertNotEqual(ids.first, ids.last)
        let explicit = try XCTUnwrap(targets.all(now: now).first { $0.bot.id == "bot-lena" })
        XCTAssertEqual(targets.resolve(identity: explicit.identity, now: now)?.bot.id, "bot-lena")
        XCTAssertNil(targets.resolve(identity: "missing", now: now))
    }

    @MainActor
    func testCacheExpiryAndRemovalFailClosedWithoutFetching() async throws {
        let targets = try targets()
        XCTAssertEqual(targets.all(now: now + 300_001).count, 2) // old but usable, never refresh here
        XCTAssertTrue(targets.all(now: now + 30 * 86_400_000 + 1).isEmpty)
        XCTAssertTrue(targets.all(now: now - 1).isEmpty)
        try SharePendingRemovals(root: targets.root).set(origin, pending: true)
        XCTAssertTrue(targets.all(now: now).isEmpty)
        let run = AskIntentRun(targets: targets, readToken: { _ in XCTFail(); return nil },
            post: { _ in XCTFail(); throw URLError(.badURL) })
        let result = await run.run(identity: nil, text: "Question", now: now)
        XCTAssertEqual(result.dialog, .setup)
    }

    @MainActor
    func testRemovalBetweenTokenReadAndPostStillStopsSending() async throws {
        let targets = try targets()
        var reads = 0
        let run = AskIntentRun(targets: targets, readToken: { [self] readOrigin in
            reads += 1
            try SharePendingRemovals(root: targets.root).set(readOrigin, pending: true)
            return token
        }, post: { _ in XCTFail("Removal barrier must block POST"); throw URLError(.badURL) })
        let result = await run.run(identity: nil, text: "Question", now: now)
        XCTAssertEqual(result.dialog, .setup)
        XCTAssertEqual(reads, 1)
    }

    @MainActor
    func testEntityIdentityIncludesWorkspaceAndDoesNotCrossFallback() throws {
        let targets = try targets()
        let other = try XCTUnwrap(WorkspaceOrigin(string: "https://other.example.test"))
        var book = try XCTUnwrap(ShareWorkspaceStore(root: targets.root).read())
        book.signedIn(other, name: "Other computer", at: now)
        try ShareWorkspaceStore(root: targets.root).write(book)
        let original = try XCTUnwrap(ShareTargetCache(root: targets.root).read(origin, now: now))
        try ShareTargetCache(root: targets.root).write(original.targets, origin: other, now: now)
        let entities = targets.all(now: now)
        XCTAssertEqual(entities.count, 4)
        XCTAssertEqual(Set(entities.map(\.identity)).count, 4)
        targets.last.remember(origin: origin.serialized, botId: "bot-max")
        XCTAssertEqual(targets.resolve(identity: nil, now: now)?.origin, origin)
        let explicit = try XCTUnwrap(entities.first { $0.origin == other })
        XCTAssertEqual(targets.resolve(identity: explicit.identity, now: now)?.origin, other)
        try ShareTargetCache(root: targets.root).remove(origin)
        XCTAssertNil(targets.resolve(identity: nil, now: now))
        book.remove(other)
        try ShareWorkspaceStore(root: targets.root).write(book)
        XCTAssertNil(targets.resolve(identity: explicit.identity, now: now))
    }

    // MARK: D8-4 owner proof

    private let nonce = String(repeating: "N", count: 43)
    private let signature = "AAAAAAAA"
    private let thread = "6c1e2f40-5b7d-4a93-8e16-0f2d9a7b3c58"

    private func proofFixture() throws -> [String: Any] {
        try XCTUnwrap(Fixtures.json("phone-ask-proof.json") as? [String: Any])
    }

    private enum Reply { case status(Int, Any?), fail(Error) }

    private final class Script {
        var replies: [Reply]
        var bodies: [[String: Any]] = []
        init(_ replies: [Reply]) { self.replies = replies }
        func next(_ request: URLRequest) throws -> ShareTargetsClient.Response {
            let body = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any] ?? [:]
            bodies.append(body)
            XCTAssertFalse(replies.isEmpty, "unexpected extra POST")
            guard !replies.isEmpty else { throw URLError(.badURL) }
            switch replies.removeFirst() {
            case .status(let status, let body): return .init(status: status, data: try body.map { try JSONSerialization.data(withJSONObject: $0) } ?? Data())
            case .fail(let error): throw error
            }
        }
        var proofs: [Any?] { bodies.map { $0["proof"] } }
    }

    private final class Probe {
        var order: [String] = []
        var confirmed: [String] = []
        var signed: [AskProofSigning] = []
    }

    private func confirmBody(text: String, deviceId: String = "phone-a", bot: String = "bot-lena", digestText: String? = nil,
                             expiresIn: Int64 = 60_000) -> [String: Any] {
        let digest = AskProof.digest(deviceId: deviceId, askId: askId, botId: bot, threadId: thread, text: digestText ?? text)
        return ["state": "confirm", "deviceId": deviceId, "threadId": thread,
                "challenge": ["v": 1, "nonce": nonce, "digest": digest, "decision": "allow", "expiresAt": now + expiresIn] as [String: Any]]
    }

    private func sentBody(proven: Bool, askId id: String? = nil) throws -> [String: Any] {
        var body = try XCTUnwrap(ask()["answer"] as? [String: Any])
        if let id { body["askId"] = id }
        body["proven"] = proven
        body["notify"] = true
        return body
    }

    private func steps(_ probe: Probe, key: String? = "key-1", paired: String? = "phone-a", agree: Bool = true,
                       sign: Result<String, AskProofFailure>? = nil) -> AskProofSteps {
        AskProofSteps(keyId: { _ in key }, pairedDeviceId: { _ in paired },
            confirm: { shown in probe.order.append("confirm"); probe.confirmed.append(shown); return agree },
            sign: { signing in
                probe.order.append("sign"); probe.signed.append(signing)
                return sign ?? .success(self.signature)
            })
    }

    @MainActor
    private func ask(_ script: Script, _ probe: Probe, text: String = "hello", prefilled: Bool = false,
                     steps custom: AskProofSteps? = nil) async throws -> AskIntentOutcome {
        let run = AskIntentRun(targets: try targets(), readToken: { [self] _ in token }, proof: custom ?? steps(probe),
                               post: { try script.next($0) })
        return await run.run(identity: nil, text: text, now: now, askId: askId, textWasPrefilled: prefilled)
    }

    @MainActor
    func testSpokenTextSignsWithFaceIDOnlyAndSendsProven() async throws {
        let script = Script([.status(200, confirmBody(text: "hello")), .status(200, try sentBody(proven: true))])
        let probe = Probe()
        let result = try await ask(script, probe)
        XCTAssertEqual(probe.order, ["sign"]) // no confirmation screen for text the owner just spoke
        XCTAssertEqual(result.dialog, .sentNotify) // today's "Sent"
        XCTAssertEqual(script.bodies.count, 2)
        XCTAssertEqual(script.proofs[0] as? String, "want")
        XCTAssertEqual(script.bodies[0]["askId"] as? String, askId)
        let proof = try XCTUnwrap(script.proofs[1] as? [String: String])
        XCTAssertEqual(proof, ["nonce": nonce, "signature": signature])
        XCTAssertEqual(script.bodies[1]["text"] as? String, "hello")
        XCTAssertEqual(script.bodies[1]["askId"] as? String, askId)
    }

    @MainActor
    func testSignedBytesAreTheApprovalMessageForThisAsk() async throws {
        let script = Script([.status(200, confirmBody(text: "hello")), .status(200, try sentBody(proven: true))])
        let probe = Probe()
        _ = try await ask(script, probe)
        let signing = try XCTUnwrap(probe.signed.first)
        let digest = AskProof.digest(deviceId: "phone-a", askId: askId, botId: "bot-lena", threadId: thread, text: "hello")
        let expected = ["murage-approval-proof/1", thread, "ask:" + askId, "allow", digest, nonce, String(now + 60_000)].joined(separator: "\n")
        XCTAssertEqual(String(decoding: signing.message, as: UTF8.self), expected)
        XCTAssertEqual(signing.origin, origin)
        XCTAssertEqual(signing.nonce, nonce)
    }

    @MainActor
    func testPrefilledTextShowsTheFullTextThenFaceID() async throws {
        let long = String(repeating: "word ", count: 600)
        let script = Script([.status(200, confirmBody(text: long)), .status(200, try sentBody(proven: true))])
        let probe = Probe()
        let result = try await ask(script, probe, text: long, prefilled: true)
        XCTAssertEqual(probe.order, ["confirm", "sign"])
        XCTAssertEqual(probe.confirmed, [long]) // the whole text, not a prefix
        XCTAssertEqual(result.dialog, .sentNotify)
    }

    @MainActor
    func testCancelledConfirmationSendsPlainAndNeverSigns() async throws {
        let script = Script([.status(200, try sentBody(proven: false))])
        let probe = Probe()
        let result = try await ask(script, probe, text: "hello", prefilled: true, steps: steps(probe, agree: false))
        XCTAssertEqual(probe.order, ["confirm"])
        XCTAssertEqual(script.bodies.count, 1)
        XCTAssertNil(script.proofs[0]) // the plain ask: no proof field at all
        XCTAssertEqual(result.dialog, .sentWithoutChat)
        XCTAssertEqual(result.dialog.text(botName: "Ember"), "Sent to Ember without your recent chat.")
    }

    @MainActor
    func testFaceIDCancelSendsPlainWithTheSameAskId() async throws {
        for failure in [AskProofFailure.cancelled, .noKey, .unavailable, .declined] {
            let script = Script([.status(200, confirmBody(text: "hello")), .status(200, try sentBody(proven: false))])
            let probe = Probe()
            let result = try await ask(script, probe, steps: steps(probe, sign: .failure(failure)))
            XCTAssertEqual(script.bodies.count, 2, "\(failure)")
            XCTAssertEqual(script.proofs[0] as? String, "want")
            XCTAssertNil(script.proofs[1])
            XCTAssertEqual(script.bodies[1]["askId"] as? String, askId)
            XCTAssertEqual(result.dialog, .sentWithoutChat, "\(failure)")
        }
    }

    @MainActor
    func testNoKeySendsOnlyThePlainAskWithTheDialogLine() async throws {
        let script = Script([.status(200, try sentBody(proven: false))])
        let probe = Probe()
        let result = try await ask(script, probe, steps: steps(probe, key: nil))
        XCTAssertEqual(script.bodies.count, 1)
        XCTAssertEqual(Set(script.bodies[0].keys), ["askId", "botId", "text"])
        XCTAssertTrue(probe.order.isEmpty)
        XCTAssertEqual(result.dialog, .sentPlain) // keyless: never "without your recent chat"
        XCTAssertEqual(result.dialog.text(botName: "Ember"), "Sent to Ember.")
    }

    @MainActor
    func testFreshAuthFailedAndProofFailedSendPlainWithTheSameAskId() async throws {
        let refusals: [Reply] = [.status(403, ["error": "refused", "code": "fresh_auth_failed"]), .status(200, ["state": "proof_failed"]),
                                 .status(422, ["error": "x", "code": "invalid"]), .status(503, nil)]
        for refusal in refusals {
            var removed = 0
            let targets = try targets()
            let script = Script([.status(200, confirmBody(text: "hello")), refusal, .status(200, try sentBody(proven: false))])
            let probe = Probe()
            let run = AskIntentRun(targets: targets, readToken: { [self] _ in token },
                removal: ShareOriginRemoval(root: targets.root, removeToken: { _ in removed += 1 }, cancelUploads: { _, done in done(true) }),
                proof: steps(probe), post: { try script.next($0) })
            let result = await run.run(identity: nil, text: "hello", now: now, askId: askId)
            XCTAssertEqual(script.bodies.count, 3)
            XCTAssertNil(script.proofs[2])
            XCTAssertEqual(script.bodies[2]["askId"] as? String, askId)
            XCTAssertEqual(result.dialog, .sentWithoutChat)
            XCTAssertEqual(removed, 0, "a refused proof is not a revoked credential")
        }
    }

    @MainActor
    func testPlainAnswerAndOlderHarnessFallBackToPlain() async throws {
        for first in [Reply.status(200, ["state": "plain"]), .status(422, ["error": "x", "code": "invalid"]), .fail(URLError(.timedOut))] {
            let script = Script([first, .status(200, try sentBody(proven: false))])
            let probe = Probe()
            let result = try await ask(script, probe)
            XCTAssertEqual(script.bodies.count, 2)
            XCTAssertNil(script.proofs[1])
            XCTAssertEqual(result.dialog, .sentWithoutChat)
            XCTAssertTrue(probe.signed.isEmpty)
        }
    }

    @MainActor
    func testRevokedCredentialOnTheChallengeStepIsSetupAndNeverResent() async throws {
        let script = Script([.status(403, ["error": "revoked", "code": "revoked"])])
        let probe = Probe()
        let result = try await ask(script, probe)
        XCTAssertEqual(script.bodies.count, 1)
        XCTAssertEqual(result.dialog, .setup)
    }

    @MainActor
    func testConfirmDeviceMismatchRefusesToSignAndSendsPlain() async throws {
        let script = Script([.status(200, confirmBody(text: "hello", deviceId: "phone-a")), .status(200, try sentBody(proven: false))])
        let probe = Probe()
        let result = try await ask(script, probe, steps: steps(probe, paired: "phone-b"))
        XCTAssertTrue(probe.signed.isEmpty)
        XCTAssertNil(script.proofs[1])
        XCTAssertEqual(result.dialog, .sentWithoutChat)
    }

    @MainActor
    func testTheChallengeMustMatchWhatWasShown() async throws {
        let cases: [(String, [String: Any])] = [
            ("text changed after it was shown", confirmBody(text: "hello", digestText: "hello there")),
            ("other bot", confirmBody(text: "hello", bot: "bot-max")),
            ("expired", confirmBody(text: "hello", expiresIn: 0)),
        ]
        for (name, body) in cases {
            let script = Script([.status(200, body), .status(200, try sentBody(proven: false))])
            let probe = Probe()
            let result = try await ask(script, probe)
            XCTAssertTrue(probe.signed.isEmpty, name)
            XCTAssertNil(script.proofs[1], name)
            XCTAssertEqual(result.dialog, .sentWithoutChat, name)
        }
    }

    @MainActor
    func testLostAnswerRetriesTheSameBodyOnceAndACommittedReceiptReportsSent() async throws {
        let script = Script([.status(200, confirmBody(text: "hello")), .fail(URLError(.timedOut)), .status(200, try sentBody(proven: true))])
        let probe = Probe()
        let result = try await ask(script, probe)
        XCTAssertEqual(script.bodies.count, 3)
        XCTAssertEqual(script.bodies[1] as NSDictionary, script.bodies[2] as NSDictionary)
        XCTAssertEqual(result.dialog, .sentNotify) // proven: true, today's "Sent"
        XCTAssertEqual(probe.signed.count, 1) // one Face ID prompt for both tries
    }

    @MainActor
    func testUnknownOutcomeThenPlainAnswerOrSilence() async throws {
        let lost = Reply.fail(URLError(.timedOut))
        var script = Script([.status(200, confirmBody(text: "hello")), lost, lost, .status(200, try sentBody(proven: true))])
        var result = try await ask(script, Probe())
        XCTAssertEqual(script.bodies.count, 4)
        XCTAssertNil(script.proofs[3])
        XCTAssertEqual(result.dialog, .sentNotify) // the plain retry found the committed receipt
        script = Script([.status(200, confirmBody(text: "hello")), lost, lost, lost])
        result = try await ask(script, Probe())
        XCTAssertEqual(script.bodies.count, 4)
        XCTAssertEqual(result.dialog, .noAnswer) // never "Sent" without an acknowledgement
        XCTAssertEqual(result.dialog.text(botName: "Ember"), "Couldn't reach your computer. Check it's on and try again.")
        XCTAssertFalse(result.showsSnippet)
    }

    @MainActor
    func testUnansweredAskReusesItsAskIdSoNothingIsSentTwice() async throws {
        let suite = "n13-pending-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        let targets = try targets()
        let lost = Reply.fail(URLError(.timedOut))
        func run(_ script: Script, text: String = "hello", at: Int64) async -> AskIntentOutcome {
            await AskIntentRun(targets: targets, readToken: { [self] _ in token }, proof: steps(Probe()), pending: AskPendingAsk(defaults: defaults),
                               post: { try script.next($0) }).run(identity: nil, text: text, now: at)
        }
        // The harness answers `plain` to the challenge request, so the digest never matters here.
        let first = Script([.status(200, ["state": "plain"]), lost])
        let one = await run(first, at: now)
        XCTAssertEqual(one.dialog, .noAnswer)
        XCTAssertEqual(first.bodies.count, 2)
        let firstId = try XCTUnwrap(first.bodies.first?["askId"] as? String)
        XCTAssertNotEqual(firstId, askId)
        let second = Script([.status(200, ["state": "plain"]), .status(200, try sentBody(proven: false, askId: firstId))])
        let result = await run(second, at: now + 60_000)
        XCTAssertEqual(second.bodies.map { $0["askId"] as? String }, [firstId, firstId]) // same id: a committed receipt answers
        XCTAssertEqual(result.dialog, .sentWithoutChat)
        // answered: the id is spent, the next ask is new
        let third = Script([.status(200, ["state": "plain"]), .status(503, nil)])
        _ = await run(third, at: now + 120_000)
        XCTAssertNotEqual(third.bodies.first?["askId"] as? String, firstId)
        // a different text, or an old record, never reuses it
        let lostAgain = Script([.status(200, ["state": "plain"]), lost])
        _ = await run(lostAgain, text: "one thing", at: now + 130_000)
        let lostId = try XCTUnwrap(lostAgain.bodies.first?["askId"] as? String)
        let other = Script([.status(200, ["state": "plain"]), .status(503, nil)])
        _ = await run(other, text: "another thing", at: now + 131_000)
        XCTAssertNotEqual(other.bodies.first?["askId"] as? String, lostId)
        let old = Script([.status(200, ["state": "plain"]), .status(503, nil)])
        _ = await run(old, text: "one thing", at: now + 130_000 + AskPendingAsk.ttlMs + 1)
        XCTAssertNotEqual(old.bodies.first?["askId"] as? String, lostId)
    }

    @MainActor
    func testPhonePairedBeforePinningFailsClosedToPlainWithTheRePairLine() async throws {
        let script = Script([.status(200, try sentBody(proven: false))])
        let probe = Probe()
        let result = try await ask(script, probe, text: "hello", prefilled: true, steps: steps(probe, paired: nil))
        XCTAssertEqual(script.bodies.count, 1) // no challenge request at all
        XCTAssertNil(script.proofs[0])
        XCTAssertTrue(probe.order.isEmpty) // not even the full-text confirmation: nothing will be signed
        XCTAssertEqual(result.dialog, .sentRePair)
        XCTAssertEqual(result.dialog.text(botName: "Ember"), "Sent to Ember. Pair this phone again to include your recent chat.")
    }

    @MainActor
    func testAnAskNeverPinsTheDeviceId() async throws {
        let suite = "n13-nopin-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        let pin = AskDevicePin(defaults: defaults)
        let unpinned = AskProofSteps(keyId: { _ in "key-1" }, pairedDeviceId: { [self] _ in pin.paired(origin: origin, keyId: "key-1") },
                                     confirm: { _ in true }, sign: { _ in XCTFail("an unpinned phone never signs"); return .failure(.noKey) })
        let script = Script([.status(200, try sentBody(proven: false))])
        _ = try await ask(script, Probe(), steps: unpinned)
        XCTAssertNil(pin.paired(origin: origin, keyId: "key-1"))
        pin.pin(origin: origin, keyId: "key-1", deviceId: "phone-a")
        pin.pin(origin: origin, keyId: "key-1", deviceId: "phone/a") // malformed: ignored
        XCTAssertEqual(pin.paired(origin: origin, keyId: "key-1"), "phone-a")
    }

    @MainActor
    func testLegacyPhoneGetsTheRePairHintAndStillSendsThePlainAsk() async throws {
        let suite = "n13-hint-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        let pin = AskDevicePin(defaults: defaults), hint = AskRePairHint(defaults: defaults)
        // paired before pinning: no device id stored, the line shows, and the plain ask still goes out
        XCTAssertTrue(hint.visible(origin: origin, keyId: "key-1", asking: true, pin: pin))
        let script = Script([.status(200, try sentBody(proven: false))])
        let result = try await ask(script, Probe(), text: "hello", prefilled: true,
                                   steps: AskProofSteps(keyId: { _ in "key-1" }, pairedDeviceId: { [self] _ in pin.paired(origin: origin, keyId: "key-1") },
                                                        confirm: { _ in XCTFail("nothing is signed"); return false },
                                                        sign: { _ in XCTFail("a legacy phone never signs"); return .failure(.noKey) }))
        XCTAssertEqual(result.dialog, .sentRePair)
        XCTAssertNil(script.proofs[0])
        // never shown without an ask credential or an approval key
        XCTAssertFalse(hint.visible(origin: origin, keyId: "key-1", asking: false, pin: pin))
        XCTAssertFalse(hint.visible(origin: origin, keyId: nil, asking: true, pin: pin))
        // the copy names the bot it is given, never a fixed one
        XCTAssertEqual(hint.text(botName: "Ember"), "Pair this phone again so Ember can see your recent chat when you send from it.")
        // dismissal is remembered per pairing, not per workspace
        hint.dismiss(origin: origin, keyId: "key-1")
        XCTAssertFalse(hint.visible(origin: origin, keyId: "key-1", asking: true, pin: pin))
        XCTAssertTrue(hint.visible(origin: origin, keyId: "key-2", asking: true, pin: pin))
        // re-pairing pins the id: the line is gone and the old dismissal mark is dropped
        pin.pin(origin: origin, keyId: "key-1", deviceId: "phone-a")
        XCTAssertFalse(hint.visible(origin: origin, keyId: "key-1", asking: true, pin: pin))
        XCTAssertNil(defaults.object(forKey: AskRePairHint.key(origin, "key-1")))
        // re-pair clears: a pinned id wins even with no dismissal; losing the pin brings the line back
        hint.clear(origin: origin, keyId: "key-2")
        XCTAssertTrue(hint.visible(origin: origin, keyId: "key-2", asking: true, pin: pin))
    }

    @MainActor
    func testNoCachedRosterStillGetsTheHintAfterTheTargetsLoad() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("n13-hint-" + UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let targetFixture = try XCTUnwrap(fixture()["targets"] as? [String: Any])
        let answer = try JSONDecoder().decode(PhoneAskContract.TargetsAnswer.self, from: bytes(XCTUnwrap(targetFixture["answer"])))
        let first = try XCTUnwrap(answer.bots.first).name
        var fetches = 0
        let cache = ShareTargetCache(root: root)
        let client = ShareTargetsClient(cache: cache, readToken: { _ in "murage_pa_" + String(repeating: "A", count: 43) },
            removeToken: { _ in }, cancelUploads: { _, done in done(true) }, fetch: { _, _ in
                fetches += 1
                return .init(status: 200, data: try JSONEncoder().encode(answer))
            })
        XCTAssertNil(cache.read(origin, now: now), "no cached roster to start with")
        let name = await AskRePairHintBot.name(origin: origin, client: client, now: now)
        XCTAssertEqual(name, first)
        XCTAssertEqual(fetches, 1)
        let suite = "n13-hint2-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        let hint = AskRePairHint(defaults: defaults)
        XCTAssertTrue(hint.visible(origin: origin, keyId: "key-1", asking: true, pin: AskDevicePin(defaults: defaults)))
        XCTAssertEqual(hint.text(botName: try XCTUnwrap(name)), "Pair this phone again so \(first) can see your recent chat when you send from it.")
        // a cached roster answers without another load
        let again = await AskRePairHintBot.name(origin: origin, client: client, now: now)
        XCTAssertEqual(again, first)
        XCTAssertEqual(fetches, 1)
        // nothing cached and the load fails: no name, so the screen shows nothing and asks again on its next load
        let offline = ShareTargetsClient(cache: ShareTargetCache(root: root.appendingPathComponent("none")), readToken: { _ in "murage_pa_" + String(repeating: "A", count: 43) },
            removeToken: { _ in }, cancelUploads: { _, done in done(true) }, fetch: { _, _ in throw ShareInputError.invalid })
        let none = await AskRePairHintBot.name(origin: origin, client: offline, now: now)
        XCTAssertNil(none)
    }

    func testAFormatCharacterInTheBotNameStillSignsAndNeverReachesTheReason() throws {
        let f = try proofFixture(), request = try XCTUnwrap(f["request"] as? [String: String])
        let confirm = try JSONDecoder().decode(PhoneAskContract.AskConfirm.self, from: bytes(XCTUnwrap(f["confirm"])))
        let at = confirm.challenge.expiresAt - 30_000
        let zwj = "\u{1F469}\u{200D}\u{1F680} Ember\u{202E}"
        XCTAssertEqual(AskProofStrings.withoutFormatCharacters(zwj), "\u{1F469}\u{1F680} Ember")
        let result = AskProof.prepare(origin: origin, confirm: confirm, pairedDeviceId: confirm.deviceId,
            askId: try XCTUnwrap(request["askId"]), botId: try XCTUnwrap(request["botId"]), botName: zwj, text: try XCTUnwrap(request["text"]), now: at)
        guard case .success(let signing) = result else { return XCTFail("a ZWJ emoji name must not drop the ask to plain: \(result)") }
        // botName keeps the original joiner and bidi control; only the reason text (Face ID and the signed message) has them stripped
        XCTAssertEqual(signing.botName, zwj)
        XCTAssertTrue(signing.botName.unicodeScalars.contains("\u{200D}"))
        XCTAssertEqual(signing.faceIdReason, "Send to \u{1F469}\u{1F680} Ember as you")
        XCTAssertFalse(signing.faceIdReason.unicodeScalars.contains("\u{200D}"))
        XCTAssertFalse(signing.faceIdReason.unicodeScalars.contains("\u{202E}"))
    }

    func testMintAnswerCarriesTheDeviceIdStrictly() throws {
        let t = token
        XCTAssertEqual(AskMintAnswer.parse(["token": t]), AskMintAnswer(token: t, deviceId: nil))
        XCTAssertEqual(AskMintAnswer.parse(["token": t, "deviceId": "phone-a"])?.deviceId, "phone-a")
        let bad: [[String: Any]] = [["token": t, "deviceId": "phone/a"], ["token": t, "deviceId": ""], ["token": t, "deviceId": 7],
                                    ["token": t, "deviceId": NSNull()], ["token": t, "extra": 1], ["deviceId": "phone-a"], [:]]
        for body in bad { XCTAssertNil(AskMintAnswer.parse(body), "\(body)") }
    }

    @MainActor
    func testCancellationStopsEveryLaterStep() async throws {
        let script = Script([.status(200, confirmBody(text: "hello")), .fail(CancellationError())])
        let result = try await ask(script, Probe())
        XCTAssertEqual(script.bodies.count, 2)
        XCTAssertEqual(result, .init(.unreachable))
    }

    @MainActor
    func testRemovalBarrierStopsTheProofStepsToo() async throws {
        let targets = try targets()
        let script = Script([.status(200, confirmBody(text: "hello"))])
        let probe = Probe()
        let run = AskIntentRun(targets: targets, readToken: { [self] _ in token }, proof: AskProofSteps(
            keyId: { _ in "key-1" }, pairedDeviceId: { _ in "phone-a" },
            confirm: { _ in true },
            sign: { [self] signing in
                probe.order.append("sign")
                try? SharePendingRemovals(root: targets.root).set(origin, pending: true)
                return .success(signature)
            }), post: { try script.next($0) })
        let result = await run.run(identity: nil, text: "hello", now: now, askId: askId)
        XCTAssertEqual(script.bodies.count, 1) // the signed send never went out
        XCTAssertEqual(result.dialog, .setup)
    }

    func testDevicePinIsPerKeyAndOrigin() throws {
        let suite = "n13-pin-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        let pin = AskDevicePin(defaults: defaults)
        XCTAssertNil(pin.paired(origin: origin, keyId: "key-1"))
        pin.pin(origin: origin, keyId: "key-1", deviceId: "phone-a")
        XCTAssertEqual(pin.paired(origin: origin, keyId: "key-1"), "phone-a")
        XCTAssertNil(pin.paired(origin: origin, keyId: "key-2")) // a re-pair has a new key and starts clean
        XCTAssertNil(pin.paired(origin: WorkspaceOrigin(string: "https://other.example.test")!, keyId: "key-1"))
        XCTAssertNil(AskDevicePin(defaults: nil).paired(origin: origin, keyId: "key-1"))
    }

    // MARK: D8-4 shared fixtures (apps/mobile/contract/phone-ask-proof.json)

    func testFixtureDigestAndConfirmDecodeAndDeviceCases() throws {
        let f = try proofFixture()
        let request = try XCTUnwrap(f["request"] as? [String: String])
        let record = try XCTUnwrap(f["record"] as? [String: Any])
        let confirmJSON = try XCTUnwrap(f["confirm"] as? [String: Any])
        let confirm = try JSONDecoder().decode(PhoneAskContract.AskConfirm.self, from: bytes(confirmJSON))
        XCTAssertEqual(AskProof.digest(deviceId: confirm.deviceId, askId: try XCTUnwrap(request["askId"]), botId: try XCTUnwrap(request["botId"]),
                                       threadId: confirm.threadId, text: try XCTUnwrap(request["text"])), record["digest"] as? String)
        XCTAssertEqual(confirm.challenge.digest, record["digest"] as? String)
        let again = try JSONSerialization.jsonObject(with: JSONEncoder().encode(confirm)) as? [String: Any]
        XCTAssertEqual(try XCTUnwrap(again) as NSDictionary, confirmJSON as NSDictionary)
        let at = confirm.challenge.expiresAt - 30_000
        for row in try XCTUnwrap(f["confirmationCases"] as? [[String: Any]]) {
            let name = try XCTUnwrap(row["name"] as? String)
            let result = AskProof.prepare(origin: origin, confirm: confirm, pairedDeviceId: try XCTUnwrap(row["pairedDeviceId"] as? String),
                askId: try XCTUnwrap(request["askId"]), botId: try XCTUnwrap(request["botId"]), botName: "Ember", text: try XCTUnwrap(request["text"]), now: at)
            switch result {
            case .success: XCTAssertEqual(row["sign"] as? Bool, true, name)
            case .failure(let why):
                XCTAssertEqual(row["sign"] as? Bool, false, name)
                XCTAssertEqual(why, .deviceMismatch, name)
                XCTAssertEqual(row["fallback"] as? Bool, true, name)
            }
        }
    }

    func testFixtureRequestsAndAnswersAndInvalidShapes() throws {
        let f = try proofFixture()
        let base = try XCTUnwrap(f["request"] as? [String: Any])
        let proof = try XCTUnwrap(f["proof"] as? [String: Any])
        for value in [("want" as Any), proof] {
            var body = base; body["proof"] = value
            let model = try JSONDecoder().decode(PhoneAskContract.AskRequest.self, from: bytes(body))
            let restored = try JSONSerialization.jsonObject(with: JSONEncoder().encode(model)) as? [String: Any]
            XCTAssertEqual(try XCTUnwrap(restored) as NSDictionary, body as NSDictionary)
        }
        let plain = try JSONDecoder().decode(PhoneAskContract.AskRequest.self, from: bytes(base))
        XCTAssertNil(plain.proof)
        XCTAssertEqual(Set((try JSONSerialization.jsonObject(with: JSONEncoder().encode(plain)) as? [String: Any] ?? [:]).keys), ["askId", "botId", "text"])
        for row in try XCTUnwrap(f["invalidRequests"] as? [[String: Any]]) {
            var body = base; body["proof"] = row["proof"] ?? NSNull()
            XCTAssertThrowsError(try JSONDecoder().decode(PhoneAskContract.AskRequest.self, from: bytes(body)), row["name"] as? String ?? "")
        }
        for answer in try XCTUnwrap(f["answers"] as? [[String: Any]]) {
            let model = try JSONDecoder().decode(PhoneAskContract.AskAnswer.self, from: bytes(answer))
            let restored = try JSONSerialization.jsonObject(with: JSONEncoder().encode(model)) as? [String: Any]
            XCTAssertEqual(try XCTUnwrap(restored) as NSDictionary, answer as NSDictionary)
        }
        var plainAnswer: [String: Any] = ["state": "plain", "extra": true]
        XCTAssertThrowsError(try JSONDecoder().decode(PhoneAskContract.AskAnswer.self, from: bytes(plainAnswer)))
        plainAnswer = ["state": "unknown"]
        XCTAssertThrowsError(try JSONDecoder().decode(PhoneAskContract.AskAnswer.self, from: bytes(plainAnswer)))
        var confirm = try XCTUnwrap(f["confirm"] as? [String: Any])
        confirm.removeValue(forKey: "deviceId")
        XCTAssertThrowsError(try JSONDecoder().decode(PhoneAskContract.AskAnswer.self, from: bytes(confirm)))
    }

    // MARK: D8-5 copy inventory

    func testEveryD8StringIsInEveryAppLocaleAndNeverAnEmDash() throws {
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("App")
        let keys = AskProofStrings.all + [AskDialog.sentWithoutChat, .sentPlain, .sentRePair, .noAnswer].map(\.rawValue)
        XCTAssertEqual(keys.count, 9)
        let repo = app.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let roster = AskCopyGuard.roster(namesSource: try String(contentsOf: repo.appendingPathComponent("server/names.ts"), encoding: .utf8),
                                         contractJSON: try Data(contentsOf: repo.appendingPathComponent("apps/mobile/contract/bot-names.json")))
        XCTAssertGreaterThan(roster.count, 20, "the bot roster could not be read from server/names.ts")
        XCTAssertTrue(roster.contains("Ember"))
        XCTAssertTrue(roster.contains("Sable"), "the contract's bot-names.json (the desktop guard's source) must feed this guard too")
        XCTAssertEqual(AskCopyGuard.namedBot(in: "あなたとしてSableに送信", roster: roster), "Sable")
        XCTAssertEqual(AskCopyGuard.namedBot(in: "已发送给Sable。", roster: roster), "Sable")
        for locale in ["en", "de", "es", "fr", "hi", "ja", "pt-BR", "zh"] {
            let url = app.appendingPathComponent(locale + ".lproj/Localizable.strings")
            let table = try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: String], locale)
            for key in keys {
                let value = try XCTUnwrap(table[key], "\(locale): \(key)")
                XCTAssertFalse(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "\(locale): \(key)")
                XCTAssertFalse(value.contains("\u{2014}"), "\(locale): \(key)")
                XCTAssertNil(AskCopyGuard.namedBot(in: value, roster: roster), "\(locale): \(key) names a bot")
                XCTAssertNil(AskCopyGuard.namedBot(in: key, roster: roster), "\(locale): key \(key) names a bot")
                XCTAssertTrue(value.contains("%@") || key == AskProofStrings.confirmInApp || key == AskDialog.noAnswer.rawValue, "\(locale): \(key)")
                if locale == "en" { XCTAssertEqual(value, key) }
            }
        }
    }

    func testCopyGuardCatchesNamesBesideCJKAndNotInsideAsciiWords() {
        let roster = ["Sable"]
        XCTAssertEqual(AskCopyGuard.namedBot(in: "あなたとしてSableに送信", roster: roster), "Sable")
        XCTAssertEqual(AskCopyGuard.namedBot(in: "已发送给Sable。", roster: roster), "Sable")
        XCTAssertEqual(AskCopyGuard.namedBot(in: "Sent to Sable.", roster: roster), "Sable")
        XCTAssertNil(AskCopyGuard.namedBot(in: "Sablefish", roster: roster))
        XCTAssertNil(AskCopyGuard.namedBot(in: "unSable", roster: roster))
        XCTAssertNil(AskCopyGuard.namedBot(in: "Sable2", roster: roster))
    }

    func testVerbatimEnglishAndFallback() {
        XCTAssertEqual(AskDialog.update.text(botName: "Ember"), "Turn this on, or update Murage, on your computer.")
        XCTAssertEqual(AskDialog.sentNotify.text(botName: "Ember"), "Sent to Ember. I'll let you know when it answers.")
        XCTAssertEqual(AskDialog.sentChat.text(botName: "Ember"), "Sent to Ember. The answer will be in your chat.")
        XCTAssertEqual(AskDialog.sentWithoutChat.text(botName: "Ember"), "Sent to Ember without your recent chat.")
        XCTAssertEqual(AskDialog.sentPlain.text(botName: "Ember"), "Sent to Ember.")
        XCTAssertEqual(AskDialog.sentRePair.text(botName: "Ember"), "Sent to Ember. Pair this phone again to include your recent chat.")
        XCTAssertEqual(AskDialog.noAnswer.text(botName: "Ember"), "Couldn't reach your computer. Check it's on and try again.")
        XCTAssertEqual(AskProofStrings.render(AskProofStrings.confirmTitle, botName: "Ember"), "Send this to Ember as you?")
        XCTAssertEqual(AskProofStrings.render(AskProofStrings.repairHint, botName: "Ember"), "Pair this phone again so Ember can see your recent chat when you send from it.")
        XCTAssertEqual(AskProofStrings.render(AskProof.reason, botName: "Ember"), "Send to Ember as you")
        XCTAssertEqual(AskProofStrings.render(AskProofStrings.waitedTooLong, botName: "Ember"), "Sent to Ember without your recent chat (it waited too long).")
        XCTAssertEqual(AskDialog.question(botName: nil), "What do you want to ask?")
        XCTAssertEqual(AskDialog.question(botName: "Ember"), "What do you want to ask Ember?")
        for dialog in AskDialog.allCases {
            let fallback = dialog.text(botName: "Ember", canOpenSnippet: false)
            XCTAssertEqual(fallback.hasSuffix("Say open Murage to continue."), dialog != .unreachable && dialog != .noAnswer)
            XCTAssertFalse(fallback.contains("\u{2014}"))
        }
    }
}

private final class AskReadAudit {
    static let key = CodingUserInfoKey(rawValue: "askReadAudit")!
    var keys = Set<String>()
}

private struct AuditedAskValue<Value: Decodable>: Decodable {
    init(from decoder: Decoder) throws {
        let audit = try XCTUnwrap(decoder.userInfo[AskReadAudit.key] as? AskReadAudit)
        _ = try Value(from: AskAuditDecoder(base: decoder, audit: audit))
    }
}

private struct AskAuditDecoder: Decoder {
    let base: Decoder
    let audit: AskReadAudit
    var codingPath: [CodingKey] { base.codingPath }
    var userInfo: [CodingUserInfoKey: Any] { base.userInfo }
    func container<Key: CodingKey>(keyedBy type: Key.Type) throws -> KeyedDecodingContainer<Key> {
        KeyedDecodingContainer(AskAuditKeys(base: try base.container(keyedBy: type), audit: audit))
    }
    func unkeyedContainer() throws -> UnkeyedDecodingContainer { throw ShareInputError.invalid }
    func singleValueContainer() throws -> SingleValueDecodingContainer { throw ShareInputError.invalid }
}

private struct AskAuditKeys<Key: CodingKey>: KeyedDecodingContainerProtocol {
    let base: KeyedDecodingContainer<Key>
    let audit: AskReadAudit
    var codingPath: [CodingKey] { base.codingPath }
    var allKeys: [Key] { base.allKeys }
    func contains(_ key: Key) -> Bool { audit.keys.insert(key.stringValue); return base.contains(key) }
    func decodeNil(forKey key: Key) throws -> Bool { audit.keys.insert(key.stringValue); return try base.decodeNil(forKey: key) }
    private func read<T: Decodable>(_ type: T.Type, _ key: Key) throws -> T {
        audit.keys.insert(key.stringValue)
        return try base.decode(type, forKey: key)
    }
    func decode(_ type: Bool.Type, forKey key: Key) throws -> Bool { try read(type, key) }
    func decode(_ type: String.Type, forKey key: Key) throws -> String { try read(type, key) }
    func decode(_ type: Double.Type, forKey key: Key) throws -> Double { try read(type, key) }
    func decode(_ type: Float.Type, forKey key: Key) throws -> Float { try read(type, key) }
    func decode(_ type: Int.Type, forKey key: Key) throws -> Int { try read(type, key) }
    func decode(_ type: Int8.Type, forKey key: Key) throws -> Int8 { try read(type, key) }
    func decode(_ type: Int16.Type, forKey key: Key) throws -> Int16 { try read(type, key) }
    func decode(_ type: Int32.Type, forKey key: Key) throws -> Int32 { try read(type, key) }
    func decode(_ type: Int64.Type, forKey key: Key) throws -> Int64 { try read(type, key) }
    func decode(_ type: UInt.Type, forKey key: Key) throws -> UInt { try read(type, key) }
    func decode(_ type: UInt8.Type, forKey key: Key) throws -> UInt8 { try read(type, key) }
    func decode(_ type: UInt16.Type, forKey key: Key) throws -> UInt16 { try read(type, key) }
    func decode(_ type: UInt32.Type, forKey key: Key) throws -> UInt32 { try read(type, key) }
    func decode(_ type: UInt64.Type, forKey key: Key) throws -> UInt64 { try read(type, key) }
    func decode<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> T { try read(type, key) }
    func nestedContainer<NestedKey: CodingKey>(keyedBy type: NestedKey.Type, forKey key: Key) throws -> KeyedDecodingContainer<NestedKey> {
        audit.keys.insert(key.stringValue)
        throw ShareInputError.invalid
    }
    func nestedUnkeyedContainer(forKey key: Key) throws -> UnkeyedDecodingContainer {
        audit.keys.insert(key.stringValue)
        throw ShareInputError.invalid
    }
    func superDecoder() throws -> Decoder { throw ShareInputError.invalid }
    func superDecoder(forKey key: Key) throws -> Decoder {
        audit.keys.insert(key.stringValue)
        throw ShareInputError.invalid
    }
}
