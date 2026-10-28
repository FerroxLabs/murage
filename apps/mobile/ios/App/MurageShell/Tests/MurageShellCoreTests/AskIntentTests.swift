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
        for key in original.keys {
            var response = original; response.removeValue(forKey: key)
            XCTAssertEqual(AskIntentResponse.outcome(status: 200, data: try bytes(response), askId: askId, threadId: nil).dialog, .unreachable)
        }
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
        XCTAssertEqual(audit.keys, Set(["state", "askId", "threadId", "id", "notify"]))
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

    func testVerbatimEnglishAndFallback() {
        XCTAssertEqual(AskDialog.sentNotify.text(botName: "Ember"), "Sent to Ember. I'll let you know when it answers.")
        XCTAssertEqual(AskDialog.sentChat.text(botName: "Ember"), "Sent to Ember. The answer will be in your chat.")
        XCTAssertEqual(AskDialog.question(botName: nil), "What do you want to ask?")
        XCTAssertEqual(AskDialog.question(botName: "Ember"), "What do you want to ask Ember?")
        for dialog in AskDialog.allCases {
            let fallback = dialog.text(botName: "Ember", canOpenSnippet: false)
            XCTAssertEqual(fallback.hasSuffix("Say open Murage to continue."), dialog != .unreachable)
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
