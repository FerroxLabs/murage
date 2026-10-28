import Foundation
import Security
import XCTest
@testable import MurageShellCore

@MainActor final class ShareOutboxTests: XCTestCase {
    private let now: Int64 = 1_800_000_000_000
    private let origin = WorkspaceOrigin(string: "https://desk.example.test")!
    private let token = "murage_pa_" + String(repeating: "A", count: 43)
    private let id = "share_outbox_test_0001"

    private final class FakeSession: ShareRetrySession {
        struct Upload { let request: URLRequest; let body: URL; let id: String; let at: Int64 }
        var uploads: [Upload] = []
        var appTasks = Set<String>(), extensionTasks = Set<String>()
        var cancelled: [String] = []
        var reject = false
        var origins: [String: WorkspaceOrigin] = [:]
        var holdCancellation = false
        var cancellationSucceeds = true
        var cancellation: (@MainActor () -> Void)?
        var beforeCancel: (@MainActor () -> Void)?
        func cancel(origin: WorkspaceOrigin, completion: @escaping @MainActor (Bool) -> Void) {
            beforeCancel?()
            let finish: @MainActor () -> Void = { [self] in
                for id in appTasks.union(extensionTasks) where origins[id] == origin { cancel(shareId: id) }
                completion(cancellationSucceeds)
            }
            if holdCancellation { cancellation = finish } else { finish() }
        }
        var finished: ((String, Int?, Data, Bool, URLRequest?, Int64) throws -> Void)?
        func liveShareIDs() async -> Set<String> { appTasks.union(extensionTasks) }
        func enqueue(request: URLRequest, body: URL, shareId: String, notBefore: Int64) throws {
            if reject { throw URLError(.cannotOpenFile) }
            if let url = request.url { origins[shareId] = WorkspaceOrigin(url: url) }
            uploads.append(.init(request: request, body: body, id: shareId, at: notBefore)); appTasks.insert(shareId)
        }
        func cancel(shareId: String) { cancelled.append(shareId); appTasks.remove(shareId); extensionTasks.remove(shareId) }
        func finish(_ id: String, status: Int?, data: Data, error: Bool = false, request: URLRequest?, now: Int64) throws {
            appTasks.remove(id); extensionTasks.remove(id)
            try finished?(id, status, data, error, request, now)
        }
    }
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("n12-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    private func prepare(_ root: URL, attachments: [ShareBodyFile.Attachment] = []) throws -> ShareBodyFile.Prepared {
        try ShareBodyFile.prepare(root: root, origin: origin, target: .init(botId: "bot-lena", threadId: "new"),
            shareId: id, note: "Keep this note", text: "Hello", url: nil, attachments: attachments, now: now)
    }
    private func make(_ root: URL, session: FakeSession, allowed: @escaping () -> Bool = { true },
                      remove: @escaping (WorkspaceOrigin) throws -> Void = { _ in },
                      read: @escaping (WorkspaceOrigin) throws -> String? = { _ in nil }) -> ShareOutbox {
        let outbox = ShareOutbox(root: root, session: session, origin: { [origin] workspace in
            ShareTargetCache.workspace(origin) == workspace ? origin : nil
        }, readToken: read, foregroundAllowed: allowed, removeToken: remove)
        session.finished = { [weak outbox] id, status, data, error, request, now in
            try outbox?.completed(shareId: id, status: status, data: data, networkError: error, originalRequest: request, now: now)
        }
        return outbox
    }
    private func request() throws -> URLRequest {
        var value = URLRequest(url: origin.url(path: "/api/phones/self/share")!)
        value.httpMethod = "POST"
        value.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        value.setValue(try ShareMultipartWriter.contentType(boundary: ShareBodyFile.boundary(shareId: id)), forHTTPHeaderField: "Content-Type")
        value.setValue("preserve-me", forHTTPHeaderField: "X-Test")
        return value
    }
    private func answers() throws -> [[String: Any]] {
        let fixture = try XCTUnwrap(Fixtures.json("phone-ask.json") as? [String: Any])
        let share = try XCTUnwrap(fixture["share"] as? [String: Any])
        let answers = try XCTUnwrap(share["answers"] as? [String: Any])
        return try XCTUnwrap(answers["ok"] as? [[String: Any]]) + XCTUnwrap(answers["errors"] as? [[String: Any]])
    }
    private func failure(_ code: String) throws -> Data {
        try JSONEncoder().encode(PhoneAskContract.ShareFailure(error: "Fixture refusal", code: code))
    }
    private func extra(_ root: URL, origin: WorkspaceOrigin, id: String) throws -> ShareBodyFile.Prepared {
        try ShareBodyFile.prepare(root: root, origin: origin, target: .init(botId: "bot-lena", threadId: "new"),
            shareId: id, note: nil, text: "Other payload", url: nil, attachments: [], now: now)
    }
    private func cache(_ root: URL, origins: [WorkspaceOrigin]) throws -> ShareTargetCache {
        let cache = ShareTargetCache(root: root)
        let bot = try PhoneAskContract.TargetBot(id: "bot-lena", name: "Lena", avatar: nil, mainThreadId: "main")
        for origin in origins {
            try cache.write(PhoneAskContract.TargetsAnswer(workspace: "Desk", bots: [bot], recent: []), origin: origin, now: now)
        }
        return cache
    }
    func testForegroundSetupOffersTurnOnAfterOutboxRevocationButHonoursNotNowAndPending() throws {
        for status in [401, 403] {
            let root = try directory(), session = FakeSession()
            _ = try prepare(root)
            var bearer: String? = token
            let suite = "setup-test-" + UUID().uuidString
            let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
            defer { defaults.removePersistentDomain(forName: suite) }
            let key = "phoneAsk.setup.v1." + origin.serialized, pairing = "key-1"
            defaults.set(PhoneAskSetupChoice.marker(turnOn: true, pairing: pairing), forKey: key)
            let outbox = make(root, session: session, remove: { _ in bearer = nil }, read: { _ in bearer })
            let foreground: @MainActor () -> Bool = { [origin] in
                PhoneAskSetupChoice.shouldOffer(marker: defaults.string(forKey: key), pairing: pairing,
                    tokenReadable: bearer != nil, removalPending: SharePendingRemovals(root: root).contains(origin))
            }
            XCTAssertFalse(foreground())
            session.holdCancellation = true
            try outbox.completed(shareId: id, status: status, data: Data(), networkError: false, originalRequest: request(), now: now)
            XCTAssertNil(bearer)
            XCTAssertFalse(foreground()) // No re-enrolment while cancellation is pending.
            try XCTUnwrap(session.cancellation)()
            XCTAssertTrue(foreground()) // The app's marker was untouched by the revoking owner.
            XCTAssertEqual(defaults.string(forKey: key), "on:key-1")
            defaults.set(PhoneAskSetupChoice.marker(turnOn: false, pairing: pairing), forKey: key)
            XCTAssertFalse(foreground())
            XCTAssertTrue(PhoneAskSetupChoice.shouldOffer(marker: "notnow:old-key", pairing: pairing,
                tokenReadable: false, removalPending: false))
            XCTAssertTrue(PhoneAskSetupChoice.shouldOffer(marker: pairing, pairing: pairing,
                tokenReadable: false, removalPending: false)) // Upgrade after an older build revoked.
        }
    }
    func testTargetGoneChangeRequestsImmediateRefreshExactlyOnceAndOnReplay() async throws {
        for replay in [false, true] {
            let root = try directory(), session = FakeSession()
            _ = try prepare(root)
            let cache = try cache(root, origins: [origin])
            let outbox = make(root, session: session)
            var refreshed: [WorkspaceOrigin] = []
            outbox.changed = {
                for origin in outbox.takeGoneTargets() {
                    XCTAssertNil(cache.read(origin, now: self.now))
                    refreshed.append(origin)
                }
            }
            if replay {
                try ShareCompletionRecord(status: 409, data: failure("target_gone"), networkError: false, at: now)
                    .write(root: root, shareId: id)
                try await outbox.foreground(now: now)
            } else {
                try outbox.completed(shareId: id, status: 409, data: failure("target_gone"), networkError: false,
                    originalRequest: request(), now: now)
            }
            XCTAssertEqual(refreshed, [origin])
            XCTAssertEqual(try outbox.state(id).state, .needsTarget)
            XCTAssertTrue(outbox.takeGoneTargets().isEmpty)
            outbox.changed = nil
        }
    }
    func testEveryForegroundSweepsHourOldStagingAndStatelessOutboxOnly() async throws {
        let root = try directory(), session = FakeSession()
        let prepared = try prepare(root)
        let outbox = make(root, session: session)
        let folders = ["share-staging/old", "share-staging/fresh", "share-staging/boundary",
                       "outbox/orphan_old_00000001", "outbox/orphan_fresh_000001", "outbox/orphan_boundary_01"]
        for name in folders {
            let folder = root.appendingPathComponent(name)
            let body = folder.appendingPathComponent(".body-partial")
            try ShareFiles.atomic(Data("partial".utf8), to: body)
            let age: Int64 = name.contains("old") ? 3_600_001 : name.contains("boundary") ? 3_600_000 : 1
            try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: Double(now - age) / 1000)], ofItemAtPath: body.path)
            try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: Double(now - age) / 1000)], ofItemAtPath: folder.path)
        }
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: Double(now - 3_600_001) / 1000)],
            ofItemAtPath: prepared.body.deletingLastPathComponent().path)
        try await outbox.foreground(now: now)
        for name in folders { XCTAssertEqual(FileManager.default.fileExists(atPath: root.appendingPathComponent(name).path), !name.contains("old"), name) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: prepared.body.path))
        try await outbox.foreground(now: now + 3_600_001)
        for name in folders { XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(name).path), name) }
        XCTAssertEqual(try outbox.state(id).state, .queued)
    }
    private func unpublishedFolder(_ root: URL, name: String, fileAge: Int64, nested: Bool = false) throws -> URL {
        let folder = root.appendingPathComponent(name)
        let parent = nested ? folder.appendingPathComponent("nested") : folder
        let file = parent.appendingPathComponent(".body-partial")
        try ShareFiles.atomic(Data("still copying".utf8), to: file)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: Double(now - fileAge) / 1000)], ofItemAtPath: file.path)
        let old = Date(timeIntervalSince1970: Double(now - 7_200_000) / 1000)
        for directory in [parent, folder] {
            try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: directory.path)
        }
        return folder
    }
    func testForegroundKeepsOldFolderContainingFreshFile() async throws {
        for name in ["share-staging", "outbox"] {
            for nested in [false, true] {
                let root = try directory(), session = FakeSession()
                let folder = try unpublishedFolder(root, name: name + "/" + id, fileAge: 1, nested: nested)
                try await make(root, session: session).foreground(now: now)
                let file = folder.appendingPathComponent(nested ? "nested/.body-partial" : ".body-partial")
                XCTAssertEqual(try Data(contentsOf: file), Data("still copying".utf8))
            }
        }
    }
    func testForegroundKeepsAllOldFoldersForLiveIDsOnEitherSession() async throws {
        for name in ["share-staging", "outbox"] {
            for extensionTask in [false, true] {
                let root = try directory(), session = FakeSession()
                let folder = try unpublishedFolder(root, name: name + "/" + id, fileAge: 7_200_000)
                if extensionTask { session.extensionTasks.insert(id) } else { session.appTasks.insert(id) }
                try await make(root, session: session).foreground(now: now)
                XCTAssertEqual(try Data(contentsOf: folder.appendingPathComponent(".body-partial")), Data("still copying".utf8))
                XCTAssertTrue(session.cancelled.isEmpty)
            }
        }
    }
    func testForegroundRemovesUnpublishedFolderOnlyWhenAllContentsAreOld() async throws {
        for name in ["share-staging", "outbox"] {
            let root = try directory(), session = FakeSession()
            let folder = try unpublishedFolder(root, name: name + "/" + id, fileAge: 7_200_000, nested: true)
            try await make(root, session: session).foreground(now: now)
            XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
        }
    }
    func testCorruptFailureJournalRepairsWithoutLosingDurableStatesOrBlockingForeground() async throws {
        for bytes in [Data("{".utf8), Data("[null]".utf8), Data([0xff])] {
            let root = try directory(), session = FakeSession()
            _ = try prepare(root)
            let other = try extra(root, origin: origin, id: "share_other_00000001")
            let outbox = make(root, session: session, read: { _ in self.token })
            try outbox.completed(shareId: id, status: 415, data: failure("unsupported_type"), networkError: false,
                originalRequest: request(), now: now)
            let file = root.appendingPathComponent("outbox/failed.json")
            try ShareFiles.atomic(bytes, to: file)
            XCTAssertEqual(try outbox.state(id).code, "unsupported_type")
            XCTAssertTrue(try outbox.failures().isEmpty)
            XCTAssertEqual(try JSONDecoder().decode([ShareOutboxState].self, from: Data(contentsOf: file)), [])
            XCTAssertEqual(try outbox.entries().count, 2)
            try await outbox.foreground(now: now)
            XCTAssertEqual(session.uploads.map(\.id), [other.state.shareId])
            XCTAssertEqual(try outbox.state(id).code, "unsupported_type")
        }
    }
    func testLegacyLockedAttemptBoundRequiresFreshInventoryAfterTokenDeletion() throws {
        let root = try directory(), pending = SharePendingRemovals(root: root)
        let records: [String: Any] = [origin.serialized: ["attempts": 3, "firstAttemptAt": now - 86_400_000]]
        try ShareFiles.atomic(JSONSerialization.data(withJSONObject: records), to: root.appendingPathComponent("phone-ask-pending-removals.json"))
        var inventory: (@MainActor (Bool) -> Void)?
        let removal = ShareOriginRemoval(root: root, removeToken: { _ in }, cancelUploads: { _, done in inventory = done })
        XCTAssertFalse(removal.forget(origin, now: now))
        XCTAssertTrue(pending.contains(origin))
        try XCTUnwrap(inventory)(false)
        XCTAssertTrue(pending.contains(origin)) // Old attempts cannot release the new bound.
        XCTAssertFalse(removal.forget(origin, now: now + 600_000))
        XCTAssertTrue(pending.contains(origin))
        try XCTUnwrap(inventory)(false)
        XCTAssertFalse(pending.contains(origin))
    }
    func testRowsWithoutBodiesNeverOfferRetryOrTargetSelection() throws {
        let root = try directory(), prepared = try prepare(root)
        for code in ["too_large", "unsupported_type", "invalid", "expired", "removed", "conflict", "unknown"] {
            var row = prepared.state; row.state = .failed; row.code = code
            XCTAssertEqual(ShareOutbox.messageKey(row, hasBody: false), "share_outbox_couldnt_send")
            XCTAssertEqual(ShareOutbox.messageKey(row, hasBody: true), "share_outbox_failed")
        }
        var row = prepared.state; row.state = .needsTarget
        XCTAssertEqual(ShareOutbox.messageKey(row, hasBody: false), "share_outbox_couldnt_send")
        XCTAssertEqual(ShareOutbox.messageKey(row, hasBody: true), "share_outbox_target")
        row.state = .failed; row.code = "revoked"
        XCTAssertEqual(ShareOutbox.messageKey(row, hasBody: false), "ask_setup_again")
        row.code = "update"
        XCTAssertEqual(ShareOutbox.messageKey(row, hasBody: false), "ask_update")
        row.state = .sent
        XCTAssertEqual(ShareOutbox.messageKey(row, hasBody: false), "share_outbox_sent")
    }
    func testPendingMissingAndRotatedTokenBlockEveryTransientReenqueue() async throws {
        for status in [nil, 500, 503] as [Int?] {
            for reason in ["pending", "missing", "rotated"] {
                let root = try directory(), session = FakeSession()
                _ = try prepare(root)
                let barrier = SharePendingRemovals(root: root)
                if reason == "pending" { try barrier.set(origin, pending: true) }
                var reads = 0
                let current = reason == "missing" ? nil : "murage_pa_" + String(repeating: "B", count: 43)
                let outbox = make(root, session: session, read: { _ in
                    reads += 1
                    if reason == "pending" { XCTFail("Pending removal must block token reads") }
                    return current
                })
                try session.finish(id, status: status, data: Data(), error: status == nil, request: request(), now: now)
                XCTAssertTrue(session.uploads.isEmpty)
                try await outbox.foreground(now: now + 60_000)
                if reason == "rotated" {
                    XCTAssertEqual(session.uploads.count, 1)
                    XCTAssertEqual(session.uploads.first?.request.value(forHTTPHeaderField: "Authorization"), "Bearer " + current!)
                } else { XCTAssertTrue(session.uploads.isEmpty) }
                if reason == "pending" { XCTAssertEqual(reads, 0) }
            }
        }
    }
    func testUnlockedTransientRetryValidatesTokenAndPreservesExactRequestBodyAndDelay() throws {
        for status in [nil, 500, 502, 503, 504, 599] as [Int?] {
            let root = try directory(), prepared = try prepare(root), session = FakeSession()
            var reads = 0
            let outbox = make(root, session: session, read: { [token] _ in reads += 1; return token })
            let original = try request()
            try session.finish(id, status: status, data: Data(), error: status == nil, request: original, now: now)
            let upload = try XCTUnwrap(session.uploads.first)
            XCTAssertEqual(upload.request, original); XCTAssertEqual(upload.id, id)
            XCTAssertEqual(upload.body, prepared.body); XCTAssertEqual(upload.at, now + 60_000)
            XCTAssertEqual(reads, 1); XCTAssertTrue(try outbox.failures().isEmpty)
        }
    }
    func testRejectedEnqueueRetainsPayloadForForegroundRecovery() async throws {
        let root = try directory(), prepared = try prepare(root), session = FakeSession()
        let outbox = make(root, session: session, read: { [token] _ in token })
        session.reject = true
        try session.finish(id, status: 503, data: Data(), request: request(), now: now)
        XCTAssertTrue(session.uploads.isEmpty)
        XCTAssertEqual(try outbox.state(id).state, .queued)
        XCTAssertTrue(FileManager.default.fileExists(atPath: prepared.body.path))
        session.reject = false
        try await outbox.foreground(now: now + 1)
        XCTAssertEqual(session.uploads.count, 1)
        XCTAssertEqual(session.uploads.first?.at, now + 60_000)
        XCTAssertEqual(session.uploads.first?.body, prepared.body)
    }
    func testRefusalWithoutCompletedRowStillRevokesOrigin() throws {
        let root = try directory(), session = FakeSession()
        let remaining = try extra(root, origin: origin, id: "share_second_00000001")
        let cache = try cache(root, origins: [origin])
        var bearer: String? = token
        let outbox = make(root, session: session, remove: { _ in bearer = nil }, read: { _ in bearer })
        let record = ShareCompletionRecord(status: 401, data: Data(), networkError: false, at: now)
        try outbox.receive(record, shareId: id, originalRequest: request())
        XCTAssertNil(bearer); XCTAssertNil(cache.read(origin, now: now))
        XCTAssertEqual(try outbox.state(remaining.state.shareId).code, "revoked")
        XCTAssertFalse(FileManager.default.fileExists(atPath: remaining.body.path))
        XCTAssertTrue(session.uploads.isEmpty)
    }
    func testForgetWaitsForBothSessionCancellationsAndMarksOnlyRemovedOrigin() throws {
        let root = try directory(), first = try prepare(root), session = FakeSession()
        let second = try extra(root, origin: origin, id: "share_second_00000001")
        let other = WorkspaceOrigin(string: "https://other.example.test")!
        let unrelated = try extra(root, origin: other, id: "share_other_000000001")
        let cache = try cache(root, origins: [origin, other])
        let otherBytes = try Data(contentsOf: unrelated.body)
        var tokens = [origin: token, other: token]
        session.appTasks = [id, unrelated.state.shareId]
        session.extensionTasks = [second.state.shareId, unrelated.state.shareId]
        session.origins = [id: origin, second.state.shareId: origin, unrelated.state.shareId: other]
        session.holdCancellation = true
        let outbox = make(root, session: session, remove: { tokens.removeValue(forKey: $0) }, read: { tokens[$0] })
        let barrier = SharePendingRemovals(root: root)
        session.beforeCancel = { [origin] in XCTAssertTrue(barrier.contains(origin)) }
        XCTAssertFalse(outbox.forget(origin, now: now + 1))
        XCTAssertTrue(barrier.contains(origin))
        XCTAssertNil(tokens[origin]); XCTAssertNil(cache.read(origin, now: now + 1))
        for row in [first, second] {
            XCTAssertEqual(try outbox.state(row.state.shareId).state, .failed)
            XCTAssertEqual(try outbox.state(row.state.shareId).code, "removed")
            XCTAssertNil(try outbox.state(row.state.shareId).nextAttemptAt)
            XCTAssertFalse(FileManager.default.fileExists(atPath: row.body.path))
        }
        try XCTUnwrap(session.cancellation)()
        XCTAssertFalse(barrier.contains(origin))
        XCTAssertEqual(Set(session.cancelled), [id, second.state.shareId])
        XCTAssertEqual(session.appTasks, [unrelated.state.shareId])
        XCTAssertEqual(session.extensionTasks, [unrelated.state.shareId])
        XCTAssertEqual(try outbox.state(unrelated.state.shareId), unrelated.state)
        XCTAssertEqual(try Data(contentsOf: unrelated.body), otherBytes)
        XCTAssertEqual(tokens[other], token); XCTAssertNotNil(cache.read(other, now: now + 1))
        // A task's late network-error callback cannot resurrect the removed payload.
        try session.finish(id, status: 503, data: Data(), request: request(), now: now + 2)
        XCTAssertTrue(session.uploads.isEmpty)
        XCTAssertEqual(try outbox.state(id).code, "removed")
    }
    func testFailedCancellationInventoryKeepsBarrierUntilSuccessfulRetry() throws {
        let root = try directory(), prepared = try prepare(root), session = FakeSession()
        var bearer: String? = token
        let outbox = make(root, session: session, remove: { _ in bearer = nil }, read: { _ in bearer })
        session.cancellationSucceeds = false
        XCTAssertFalse(outbox.forget(origin, now: now))
        XCTAssertTrue(SharePendingRemovals(root: root).contains(origin))
        XCTAssertNil(bearer)
        XCTAssertEqual(try outbox.state(id).code, "removed")
        XCTAssertFalse(FileManager.default.fileExists(atPath: prepared.body.path))
        session.cancellationSucceeds = true
        XCTAssertTrue(outbox.forget(origin, now: now + 1))
        XCTAssertFalse(SharePendingRemovals(root: root).contains(origin))
    }
    func testFailedBarrierWriteReturnsFalsePreservesStateAndNeverResendsOldBearer() async throws {
        let root = try directory(), prepared = try prepare(root), session = FakeSession()
        let other = WorkspaceOrigin(string: "https://other.example.test")!
        let cache = try cache(root, origins: [origin, other])
        var bearer: String? = token, deletes = 0, cancellationCalls = 0
        let remove: (WorkspaceOrigin) throws -> Void = { _ in deletes += 1; bearer = nil }
        let barrier = SharePendingRemovals(root: root)
        let failing = SharePendingRemovals(root: root, write: { _, _ in throw CocoaError(.fileWriteNoPermission) })
        let removal = ShareOriginRemoval(root: root, pending: failing, removeToken: remove,
            cancelUploads: { _, _ in cancellationCalls += 1; XCTFail("Barrier was not armed") })
        let outbox = make(root, session: session, remove: remove, read: { _ in
            XCTFail("Failed forget must block the surviving bearer"); return bearer
        })
        var completion: Bool?
        XCTAssertFalse(removal.forget(origin, now: now) { completion = $0 })
        XCTAssertEqual(completion, false)
        XCTAssertEqual(deletes, 0); XCTAssertEqual(cancellationCalls, 0); XCTAssertEqual(bearer, token)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("phone-ask-pending-removals.json").path))
        XCTAssertEqual(try outbox.state(id), prepared.state)
        XCTAssertTrue(FileManager.default.fileExists(atPath: prepared.body.path))
        XCTAssertNotNil(cache.read(origin, now: now)); XCTAssertNotNil(cache.read(other, now: now))
        XCTAssertTrue(barrier.contains(origin)); XCTAssertFalse(barrier.contains(other))
        XCTAssertEqual(barrier.retryOrigins(), [origin.serialized])
        for status in [nil, 503] as [Int?] {
            try session.finish(id, status: status, data: Data(), error: status == nil, request: request(), now: now + 1)
        }
        // Another owner observes the failed write, and a foreground while disk
        // writes still fail cannot send the old bearer or discard the retry.
        let restarted = make(root, session: session, remove: remove, read: { _ in
            XCTFail("Foreground must not read the surviving bearer"); return bearer
        })
        for value in barrier.retryOrigins() {
            XCTAssertFalse(removal.forget(try XCTUnwrap(WorkspaceOrigin(string: value)), now: now + 2))
        }
        try await restarted.foreground(now: now + 2)
        XCTAssertTrue(session.uploads.isEmpty); XCTAssertEqual(deletes, 0)
        // The existing foreground/unlock queue retries through a recreated owner.
        let recovered = ShareOriginRemoval(root: root, removeToken: remove, cancelUploads: session.cancel)
        for value in barrier.retryOrigins() {
            XCTAssertTrue(recovered.forget(try XCTUnwrap(WorkspaceOrigin(string: value)), now: now + 3))
        }
        try await restarted.foreground(now: now + 4)
        XCTAssertNil(bearer); XCTAssertEqual(deletes, 1)
        XCTAssertTrue(barrier.retryOrigins().isEmpty); XCTAssertFalse(barrier.contains(origin))
        XCTAssertEqual(try restarted.state(id).code, "removed")
        XCTAssertFalse(FileManager.default.fileExists(atPath: prepared.body.path))
        XCTAssertTrue(session.uploads.isEmpty); XCTAssertNotNil(cache.read(other, now: now + 4))
    }
    func testCancellationBoundClearsOnThirdAttemptAcrossOwnerRecreation() throws {
        let root = try directory(), pending = SharePendingRemovals(root: root)
        let other = WorkspaceOrigin(string: "https://other.example.test")!
        try pending.set(other, pending: true)
        var deletes = 0, cancels = 0, logs: [String] = []
        let previousLog = ShareOriginRemoval.log
        ShareOriginRemoval.log = { logs.append(String(describing: $0)) }
        defer { ShareOriginRemoval.log = previousLog }
        for attempt in 1...3 {
            let removal = ShareOriginRemoval(root: root, removeToken: { _ in deletes += 1 }, cancelUploads: { _, done in
                cancels += 1; done(false)
            })
            var completed: Bool?
            XCTAssertEqual(removal.forget(origin, now: now + Int64(attempt)) { completed = $0 }, attempt == 3)
            XCTAssertEqual(completed, attempt == 3)
            XCTAssertEqual(pending.contains(origin), attempt < 3)
            XCTAssertTrue(pending.contains(other))
            if attempt < 3 {
                let records = try JSONDecoder().decode([String: SharePendingRemovals.Attempt].self,
                    from: Data(contentsOf: root.appendingPathComponent("phone-ask-pending-removals.json")))
                XCTAssertEqual(records[origin.serialized]?.attempts, attempt)
                XCTAssertEqual(records[origin.serialized]?.firstAttemptAt, now + 1)
            }
        }
        XCTAssertEqual(deletes, 3); XCTAssertEqual(cancels, 3)
        XCTAssertEqual(logs, ["share removal cancellation bound reached"])
    }

    func testCancellationBoundClearsAtTenMinutesFromFirstAttempt() throws {
        // Each case has only two attempts, so elapsed time must decide the outcome.
        for elapsed in [599_999, 600_000] as [Int64] {
            let root = try directory()
            let removal = ShareOriginRemoval(root: root, removeToken: { _ in }, cancelUploads: { _, done in done(false) })
            XCTAssertFalse(removal.forget(origin, now: now))
            let restarted = ShareOriginRemoval(root: root, removeToken: { _ in }, cancelUploads: { _, done in done(false) })
            XCTAssertEqual(restarted.forget(origin, now: now + elapsed), elapsed == 600_000)
            XCTAssertEqual(SharePendingRemovals(root: root).contains(origin), elapsed < 600_000)
        }
    }

    func testCancellationBoundNeverClearsWhileTokenDeletionFails() throws {
        let root = try directory(), pending = SharePendingRemovals(root: root)
        let removal = ShareOriginRemoval(root: root,
            removeToken: { _ in throw PhoneAskTokenStore.StoreError.storage }, cancelUploads: { _, done in done(false) })
        for attempt in 0..<4 {
            XCTAssertFalse(removal.forget(origin, now: now + Int64(attempt) * 600_000))
            XCTAssertTrue(pending.contains(origin))
        }
        let unlocked = ShareOriginRemoval(root: root, removeToken: { _ in }, cancelUploads: { _, done in done(false) })
        XCTAssertFalse(unlocked.forget(origin, now: now + 2_400_000))
        XCTAssertTrue(pending.contains(origin))
        XCTAssertFalse(unlocked.forget(origin, now: now + 2_400_001))
        XCTAssertTrue(pending.contains(origin))
        XCTAssertTrue(unlocked.forget(origin, now: now + 2_400_002))
        XCTAssertFalse(pending.contains(origin))
    }

    func testBoundReleasesEvenWhenOutboxCleanupCannotReadRowsAfterTokenDeletion() throws {
        let root = try directory(), pending = SharePendingRemovals(root: root)
        // An unreadable journal still exercises the cleanup bound; malformed JSON now repairs.
        try FileManager.default.createDirectory(at: root.appendingPathComponent("outbox/failed.json"), withIntermediateDirectories: true)
        var deletes = 0
        let removal = ShareOriginRemoval(root: root, removeToken: { _ in deletes += 1 },
            cancelUploads: { _, done in done(false) })
        for attempt in 1...3 {
            XCTAssertEqual(removal.forget(origin, now: now + Int64(attempt)), attempt == 3)
        }
        XCTAssertEqual(deletes, 3); XCTAssertFalse(pending.contains(origin))
    }

    func testCorruptPendingFileRecoversOriginsAndAllowsBoundedRetry() throws {
        for prefix in ["[", "{"] {
            let root = try directory(), pending = SharePendingRemovals(root: root)
            let file = root.appendingPathComponent("phone-ask-pending-removals.json")
            // Both the old set and the new record format can be truncated.
            let partial = prefix + "\"" + origin.serialized + "\"" + (prefix == "[" ? "," : ":{\"attempts\":")
            try ShareFiles.atomic(Data(partial.utf8), to: file)
            XCTAssertEqual(pending.retryOrigins(), [origin.serialized])
            XCTAssertEqual(try pending.read(), [origin.serialized])
            XCTAssertTrue(pending.contains(origin))
            for attempt in 1...3 {
                let removal = ShareOriginRemoval(root: root, removeToken: { _ in }, cancelUploads: { _, done in done(false) })
                XCTAssertEqual(removal.forget(origin, now: now + Int64(attempt)), attempt == 3)
            }
            XCTAssertTrue(pending.retryOrigins().isEmpty)
        }
    }

    func testCorruptPendingFileWithoutOriginsBecomesValidEmptySet() throws {
        for bytes in [Data("{".utf8), Data([0xff, 0x00])] {
            let root = try directory(), pending = SharePendingRemovals(root: root)
            let file = root.appendingPathComponent("phone-ask-pending-removals.json")
            try ShareFiles.atomic(bytes, to: file)
            XCTAssertTrue(pending.retryOrigins().isEmpty)
            XCTAssertTrue(try pending.read().isEmpty)
            XCTAssertFalse(pending.contains(origin))
        }
    }

    func testCorruptFileFallbackIsPerOriginAndDoesNotGrantUnreadableTokenAccess() throws {
        let root = try directory(), pending = SharePendingRemovals(root: root)
        let file = root.appendingPathComponent("phone-ask-pending-removals.json")
        try ShareFiles.atomic(Data("{".utf8), to: file)
        XCTAssertTrue(pending.contains(origin, readToken: { _ in throw PhoneAskTokenStore.StoreError.storage }))
        XCTAssertTrue(try pending.read().isEmpty)
        try ShareFiles.atomic(Data("{".utf8), to: file)
        XCTAssertFalse(pending.contains(origin, readToken: { _ in nil }))
        try ShareFiles.atomic(Data("{".utf8), to: file)
        XCTAssertFalse(pending.contains(origin, readToken: { _ in self.token }))
        XCTAssertTrue(try pending.read().isEmpty)
    }

    func testCorruptFileRecoveryKeepsUnreadableTokenBlockedWithoutBlockingOtherOrigins() async throws {
        let root = try directory(), session = FakeSession()
        _ = try prepare(root)
        let other = WorkspaceOrigin(string: "https://other.example.test")!
        let ready = try extra(root, origin: other, id: "share_readable_000001")
        try ShareFiles.atomic(Data("{".utf8), to: root.appendingPathComponent("phone-ask-pending-removals.json"))
        XCTAssertTrue(SharePendingRemovals(root: root).retryOrigins().isEmpty)
        let outbox = ShareOutbox(root: root, session: session, origin: { workspace in
            [self.origin, other].first { ShareTargetCache.workspace($0) == workspace }
        }, readToken: { origin in
            if origin == self.origin { throw PhoneAskTokenStore.StoreError.storage }
            return self.token
        }, foregroundAllowed: { true })
        try await outbox.foreground(now: now)
        try await outbox.foreground(now: now + 1)
        XCTAssertEqual(session.uploads.map(\.id), [ready.state.shareId])
        XCTAssertEqual(try outbox.state(id).state, .queued)
    }

    func testLegacyPendingSetMigratesWithoutResettingRetryMetadata() throws {
        let root = try directory(), pending = SharePendingRemovals(root: root)
        try ShareFiles.atomic(JSONEncoder().encode([origin.serialized]),
            to: root.appendingPathComponent("phone-ask-pending-removals.json"))
        XCTAssertEqual(pending.retryOrigins(), [origin.serialized])
        let first = try pending.beginAttempt(origin, now: now)
        try pending.set(origin, pending: true)
        let second = try SharePendingRemovals(root: root).beginAttempt(origin, now: now + 1)
        XCTAssertEqual(first.attempts, 1); XCTAssertEqual(second.attempts, 2)
        XCTAssertEqual(second.firstAttemptAt, now)
    }

    func testShareAndAskRevocationsRemoveCredentialsCacheAndAllOriginRows() async throws {
        for ask in [false, true] {
            for (status, data) in [(401, try failure("revoked")), (401, Data()), (403, Data()), (403, try failure("target_gone"))] {
                let root = try directory(), first = try prepare(root), session = FakeSession()
                let second = try extra(root, origin: origin, id: "share_second_00000001")
                let other = WorkspaceOrigin(string: "https://other.example.test")!
                let unrelated = try extra(root, origin: other, id: "share_other_000000001")
                let cache = try cache(root, origins: [origin, other])
                var tokens = [origin: token, other: token]
                session.appTasks = [id, unrelated.state.shareId]
                session.extensionTasks = [second.state.shareId]
                session.origins = [id: origin, second.state.shareId: origin, unrelated.state.shareId: other]
                let outbox = make(root, session: session, remove: { tokens.removeValue(forKey: $0) }, read: { tokens[$0] })
                if ask {
                    var book = WorkspaceBook(); book.signedIn(origin, name: "Desk", at: now)
                    try ShareWorkspaceStore(root: root).write(book)
                    let removal = ShareOriginRemoval(root: root, removeToken: { tokens.removeValue(forKey: $0) }, cancelUploads: session.cancel)
                    var posts = 0
                    let run = AskIntentRun(targets: .init(root: root, last: .init(defaults: nil)), readToken: { tokens[$0] },
                        removal: removal, post: { _ in posts += 1; return .init(status: status, data: data) })
                    let result = await run.run(identity: nil, text: "Question", now: now)
                    XCTAssertEqual(result.dialog, .setup)
                    _ = await run.run(identity: nil, text: "Question", now: now + 1)
                    XCTAssertEqual(posts, 1)
                } else {
                    // HTTP refusal takes priority even if delivery also reports an error.
                    try session.finish(id, status: status, data: data, error: true, request: request(), now: now)
                }
                XCTAssertNil(tokens[origin]); XCTAssertNil(cache.read(origin, now: now))
                XCTAssertEqual(tokens[other], token); XCTAssertNotNil(cache.read(other, now: now))
                for row in [first, second] {
                    XCTAssertEqual(try outbox.state(row.state.shareId).state, .failed)
                    XCTAssertEqual(try outbox.state(row.state.shareId).code, "revoked")
                    XCTAssertNil(try outbox.state(row.state.shareId).nextAttemptAt)
                    XCTAssertFalse(FileManager.default.fileExists(atPath: row.body.path))
                }
                XCTAssertEqual(try outbox.state(unrelated.state.shareId), unrelated.state)
                XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.body.path))
                XCTAssertFalse(session.cancelled.contains(unrelated.state.shareId))
                XCTAssertFalse(session.appTasks.contains(id)); XCTAssertTrue(session.extensionTasks.isEmpty)
                try await outbox.foreground(now: now + 60_000)
                XCTAssertTrue(session.uploads.isEmpty)
            }
        }
    }
    func testLockedRevocationKeepsBarrierButCancelsAndDeletesBodiesUntilUnlockRetry() throws {
        let root = try directory(), prepared = try prepare(root), session = FakeSession()
        let cache = try cache(root, origins: [origin])
        var locked = true, exists = true
        let store = PhoneAskTokenStore(operations: .init(update: { _, _ in errSecSuccess }, add: { _ in errSecSuccess },
            read: { [token] _ in exists ? (errSecSuccess, Data(token.utf8)) : (errSecItemNotFound, nil) },
            delete: { _ in
                if locked { return errSecInteractionNotAllowed }
                exists = false; return errSecSuccess
            }), accessGroup: "TEST.com.murage.mobile.ask")
        session.extensionTasks = [id]; session.origins[id] = origin
        let outbox = make(root, session: session, remove: store.remove, read: store.readForAsk)
        try outbox.completed(shareId: id, status: 403, data: Data(), networkError: false, originalRequest: request(), now: now)
        XCTAssertTrue(exists); XCTAssertTrue(SharePendingRemovals(root: root).contains(origin))
        XCTAssertNil(cache.read(origin, now: now)); XCTAssertEqual(session.cancelled, [id])
        XCTAssertFalse(FileManager.default.fileExists(atPath: prepared.body.path))
        XCTAssertEqual(try outbox.state(id).code, "revoked"); XCTAssertNil(try outbox.state(id).nextAttemptAt)
        locked = false
        // The durable pending set is sufficient after recreating the owner on unlock.
        let restored = ShareOriginRemoval(root: root, removeToken: store.remove, cancelUploads: session.cancel)
        for value in try SharePendingRemovals(root: root).read() {
            XCTAssertTrue(restored.forget(try XCTUnwrap(WorkspaceOrigin(string: value)), now: now + 1))
        }
        XCTAssertNil(try store.readForAsk(origin: origin))
        XCTAssertFalse(SharePendingRemovals(root: root).contains(origin)); XCTAssertTrue(session.uploads.isEmpty)
    }
    func testEveryS25OutcomeRowThroughFakeSession() throws {
        for answer in try answers() {
            let root = try directory(), prepared = try prepare(root), session = FakeSession()
            var reads = 0
            let outbox = make(root, session: session, read: { _ in reads += 1; return nil })
            let status = try XCTUnwrap(answer["status"] as? Int)
            let body = answer["body"] as? [String: Any]
            let bytes = try body.map { try JSONSerialization.data(withJSONObject: $0) } ?? Data()
            let code = body?["code"] as? String
            try session.finish(id, status: status, data: bytes, request: request(), now: now + 1000)
            let value = try outbox.state(id)
            XCTAssertEqual(value.state, status == 200 ? .sent : code == "target_gone" ? .needsTarget : .failed)
            XCTAssertEqual(FileManager.default.fileExists(atPath: prepared.body.path), [409, 404].contains(status))
            XCTAssertEqual(try outbox.failures().count, status == 200 ? 0 : 1)
            XCTAssertEqual(value.code, status == 404 ? "update" : code)
            XCTAssertEqual(reads, 0)
            XCTAssertTrue(session.uploads.isEmpty)
            if status != 200 {
                let line = try String(contentsOf: root.appendingPathComponent("outbox/failed.json"), encoding: .utf8)
                XCTAssertFalse(line.contains(token)); XCTAssertFalse(line.contains("Keep this note"))
                XCTAssertFalse(line.contains("Authorization"))
            }
        }
    }
    func testEveryTransientRowRetainsBodyAndScheduleWithoutReadingLockedKeychain() throws {
        for status in [nil, 500, 502, 503, 504, 599] as [Int?] {
            let root = try directory(), prepared = try prepare(root), session = FakeSession()
            let outbox = make(root, session: session, allowed: { false }, read: { _ in XCTFail("Locked retry read a token"); return nil })
            let original = try request()
            try session.finish(id, status: status, data: Data(), error: status == nil, request: original, now: now)
            XCTAssertEqual(try outbox.state(id).state, .queued)
            XCTAssertTrue(session.uploads.isEmpty)
            XCTAssertEqual(try outbox.state(id).nextAttemptAt, now + 60_000)
            XCTAssertEqual(try outbox.state(id).shareId, id)
            XCTAssertTrue(FileManager.default.fileExists(atPath: prepared.body.path))
            XCTAssertTrue(try outbox.failures().isEmpty)
        }
    }
    func testBackoffThenEachForegroundAndRestartPreservesSchedule() async throws {
        let root = try directory(), session = FakeSession()
        _ = try prepare(root)
        var reads = 0
        let outbox = make(root, session: session, read: { [token] _ in reads += 1; return token })
        var clock = now
        for delay in ShareOutbox.backoff {
            try session.finish(id, status: 502, data: Data(), request: request(), now: clock)
            XCTAssertEqual(session.uploads.last?.at, clock + delay)
            clock += delay
        }
        try session.finish(id, status: 503, data: Data(), request: request(), now: clock)
        XCTAssertEqual(session.uploads.count, 3); XCTAssertEqual(reads, 3)
        XCTAssertNil(try outbox.state(id).nextAttemptAt)
        try await outbox.foreground(now: clock + 1)
        XCTAssertEqual(session.uploads.count, 4); XCTAssertEqual(reads, 4)
        // Another scene/foreground sees the live task, so it cannot duplicate it.
        try await outbox.foreground(now: clock + 2)
        XCTAssertEqual(session.uploads.count, 4)
        try session.finish(id, status: nil, data: Data(), error: true, request: request(), now: clock + 3)
        try await outbox.foreground(now: clock + 4)
        XCTAssertEqual(session.uploads.count, 5); XCTAssertEqual(reads, 5)
    }
    func testForceQuitRequeuesOnlyMissingTasksAcrossBothSessions() async throws {
        for live in ["app", "extension", "none"] {
            let root = try directory(), prepared = try prepare(root), session = FakeSession()
            let original = try Data(contentsOf: prepared.body)
            if live == "app" { session.appTasks.insert(id) }
            if live == "extension" { session.extensionTasks.insert(id) }
            var reads = 0
            let outbox = make(root, session: session, read: { [token] _ in reads += 1; return token })
            try await outbox.foreground(now: now + 10)
            XCTAssertEqual(session.uploads.count, live == "none" ? 1 : 0)
            XCTAssertEqual(reads, live == "none" ? 1 : 0)
            XCTAssertEqual(try Data(contentsOf: prepared.body), original)
            XCTAssertEqual(try outbox.state(id).shareId, id)
        }
    }
    func testMissingOriginalOrRejectedReuseFallsBackToFreshTokenAndLockedFailsClosed() async throws {
        for hasOriginal in [false, true] {
            let root = try directory(), session = FakeSession()
            _ = try prepare(root)
            var locked = true, reads = 0
            let lockedStore = PhoneAskTokenStore(operations: .init(update: { _, _ in errSecSuccess }, add: { _ in errSecSuccess },
                read: { _ in reads += 1; return (errSecInteractionNotAllowed, nil) }, delete: { _ in errSecSuccess }),
                accessGroup: "TEAM.com.murage.mobile.ask")
            let outbox = make(root, session: session, read: { [token] origin in
                if locked { return try lockedStore.readForAsk(origin: origin) }
                reads += 1; return token
            })
            session.reject = true
            try session.finish(id, status: 502, data: Data(), request: hasOriginal ? request() : nil, now: now)
            XCTAssertEqual(reads, hasOriginal ? 1 : 0); XCTAssertTrue(session.uploads.isEmpty)
            session.reject = false
            try await outbox.foreground(now: now + 1)
            XCTAssertEqual(reads, hasOriginal ? 2 : 1); XCTAssertTrue(session.uploads.isEmpty)
            XCTAssertEqual(try outbox.state(id).state, .queued)
            locked = false
            // A new owner reads the persisted delay after process loss.
            let restarted = make(root, session: session, read: { [token] _ in reads += 1; return token })
            try await restarted.foreground(now: now + 2)
            XCTAssertEqual(reads, hasOriginal ? 3 : 2); XCTAssertEqual(session.uploads.count, 1)
            XCTAssertEqual(session.uploads[0].at, now + 60_000)
        }
    }
    func testBackgroundReconcileDoesNotReadTokenAndForeignRequestIsNotReused() async throws {
        let root = try directory(), session = FakeSession()
        _ = try prepare(root)
        let outbox = make(root, session: session, allowed: { false }, read: { _ in XCTFail("Background token read"); return nil })
        var foreign = try request(); foreign.url = URL(string: "https://other.example.test/api/phones/self/share")!
        try session.finish(id, status: 502, data: Data(), request: foreign, now: now)
        try await outbox.foreground(now: now + 60_000)
        XCTAssertTrue(session.uploads.isEmpty)
        XCTAssertEqual(try outbox.state(id).state, .queued)
    }
    func testSentRetentionStartsAtCompletionAndFailuresLastSevenDays() throws {
        for status in [200, 404, 413] {
            let root = try directory(), prepared = try prepare(root), session = FakeSession()
            let outbox = make(root, session: session)
            let data: Data
            if status == 200 { data = Data("{\"state\":\"sent\",\"threadId\":\"thread\",\"queueId\":\"q\"}".utf8) }
            else { data = try failure("too_large") }
            let completedAt = now + ShareOutbox.day * 2
            try session.finish(id, status: status, data: data, request: request(), now: completedAt)
            let retention = status == 200 ? ShareOutbox.day : ShareOutbox.week
            try outbox.sweep(now: completedAt + retention - 1)
            XCTAssertEqual(try outbox.entries().count, 1)
            XCTAssertEqual(FileManager.default.fileExists(atPath: prepared.body.path), status == 404)
            try outbox.sweep(now: completedAt + retention)
            XCTAssertTrue(try outbox.entries().isEmpty)
            XCTAssertFalse(FileManager.default.fileExists(atPath: prepared.body.path))
            XCTAssertTrue(try outbox.failures().isEmpty)
        }
    }
    func testSevenDayQueueExpiryCancelsTaskDeletesBodyAndKeepsFailureLine() async throws {
        let root = try directory(), prepared = try prepare(root), session = FakeSession()
        session.appTasks.insert(id)
        let outbox = make(root, session: session, read: { _ in XCTFail("Expired share read a token"); return nil })
        try outbox.sweep(now: now + ShareOutbox.week - 1)
        XCTAssertEqual(try outbox.state(id).state, .queued)
        try await outbox.foreground(now: now + ShareOutbox.week)
        XCTAssertEqual(session.cancelled, [id])
        XCTAssertFalse(FileManager.default.fileExists(atPath: prepared.body.path))
        XCTAssertEqual(try outbox.failures().first?.code, "expired")
        XCTAssertEqual(try outbox.state(id).state, .failed)
        // Late cancellation callbacks cannot turn expiry back into queued.
        try session.finish(id, status: nil, data: Data(), error: true, request: request(), now: now + ShareOutbox.week + 1)
        XCTAssertTrue(session.uploads.isEmpty)
        try outbox.sweep(now: now + 2 * ShareOutbox.week)
        XCTAssertTrue(try outbox.failures().isEmpty)
    }
    func testConflictRetryAndTargetRedirectRebuildBodyWithNewIDAndKeepBinaryBytes() throws {
        for code in ["conflict", "target_gone"] {
            let root = try directory(), session = FakeSession()
            let file = root.appendingPathComponent("input.pdf")
            let bytes = Data((0..<100_000).map { UInt8($0 % 256) })
            try bytes.write(to: file)
            let prepared = try prepare(root, attachments: [.init(url: file, name: "test.pdf", mime: "application/pdf")])
            let cache = ShareTargetCache(root: root)
            try cache.write(PhoneAskContract.TargetsAnswer(workspace: "Desk", bots: [], recent: []), origin: origin, now: now)
            let outbox = make(root, session: session, read: { [token] _ in token })
            try session.finish(id, status: 409, data: failure(code), request: request(), now: now + 1)
            if code == "target_gone" {
                XCTAssertNil(cache.read(origin, now: now + 1))
                XCTAssertThrowsError(try outbox.resend(id, now: now + 2))
            }
            let target: ShareOutboxState.Target? = code == "target_gone" ? .init(botId: "bot-new", threadId: "new") : nil
            let fresh = try outbox.resend(id, target: target, now: now + 2)
            XCTAssertNotEqual(fresh.shareId, id); XCTAssertNotEqual(fresh.fingerprint, prepared.state.fingerprint)
            XCTAssertEqual(fresh.target, target ?? prepared.state.target); XCTAssertEqual(fresh.state, .queued)
            XCTAssertTrue(try outbox.failures().isEmpty)
            let newBody = try Data(contentsOf: outbox.body(fresh.shareId))
            XCTAssertNotNil(newBody.range(of: bytes))
            XCTAssertNotNil(newBody.range(of: Data(fresh.shareId.utf8)))
            XCTAssertNil(newBody.range(of: Data(id.utf8)))
            XCTAssertFalse(FileManager.default.fileExists(atPath: prepared.body.path))
        }
    }
    func testMalformedOutcomesRetainPayloadExceptRevocationAndJournalHasNoRequest() throws {
        for status in [200, 401, 403, 409, 413, 415, 422, 302] {
            let root = try directory(), prepared = try prepare(root), session = FakeSession()
            let outbox = make(root, session: session)
            try session.finish(id, status: status, data: Data("{}".utf8), request: nil, now: now)
            let revoked = status == 401 || status == 403
            XCTAssertEqual(try outbox.state(id).state, revoked ? .failed : .queued)
            XCTAssertEqual(FileManager.default.fileExists(atPath: prepared.body.path), !revoked)
            if revoked {
                XCTAssertEqual(try outbox.state(id).code, "revoked")
                XCTAssertNil(try outbox.state(id).nextAttemptAt)
                XCTAssertTrue(session.uploads.isEmpty)
            }
        }
        let root = try directory()
        _ = try prepare(root)
        let record = ShareCompletionRecord(status: 409, data: try failure("conflict"), networkError: false, at: now)
        try record.write(root: root, shareId: id)
        let data = try Data(contentsOf: ShareCompletionRecord.file(root: root, shareId: id))
        let restored = try JSONDecoder().decode(ShareCompletionRecord.self, from: data)
        XCTAssertEqual(restored.data, record.data); XCTAssertEqual(restored.status, 409)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("Authorization"))
    }
    func testExtensionCompletionIsReplayedBeforeForegroundRecovery() async throws {
        let root = try directory(), prepared = try prepare(root), session = FakeSession()
        let outbox = make(root, session: session, read: { _ in XCTFail("A completed upload must not be requeued"); return nil })
        let record = ShareCompletionRecord(status: 200,
            data: Data("{\"state\":\"sent\",\"threadId\":\"thread\",\"queueId\":\"q\"}".utf8), networkError: false, at: now + 1)
        try record.write(root: root, shareId: id)
        try await outbox.foreground(now: now + 2)
        XCTAssertEqual(try outbox.state(id).state, .sent)
        XCTAssertFalse(FileManager.default.fileExists(atPath: prepared.body.path))
        XCTAssertTrue(session.uploads.isEmpty)
    }
    func testReplayingAnAppliedCompletionDoesNotAdvanceBackoffTwice() async throws {
        let root = try directory(), session = FakeSession()
        _ = try prepare(root)
        let outbox = make(root, session: session, read: { [token] _ in token })
        let record = ShareCompletionRecord(status: 502, data: Data(), networkError: false, at: now)
        // Simulate exit after state.json was written but before journal removal.
        try record.write(root: root, shareId: id)
        try outbox.completed(shareId: id, status: record.status, data: record.data, networkError: false,
                             originalRequest: nil, now: now, completionID: record.id)
        try await outbox.foreground(now: now + 1)
        XCTAssertEqual(try outbox.state(id).attempts, 1)
        XCTAssertEqual(session.uploads.first?.at, now + 60_000)
    }
    func testFailureLedgerWinsAfterExitBeforeStateWrite() async throws {
        let root = try directory(), prepared = try prepare(root), session = FakeSession()
        let outbox = make(root, session: session, read: { _ in XCTFail("A durable refusal must not be requeued"); return nil })
        var refused = prepared.state
        refused.state = .failed; refused.code = "revoked"; refused.updatedAt = now + 1
        try ShareFiles.atomic(JSONEncoder().encode([refused]), to: root.appendingPathComponent("outbox/failed.json"))
        try await outbox.foreground(now: now + 2)
        XCTAssertEqual(try outbox.state(id).state, .failed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: prepared.body.path))
        XCTAssertTrue(session.uploads.isEmpty)
    }
    func testInvalidSentReceiptAndMismatchedStatusCodeAreRetryable() throws {
        XCTAssertEqual(ShareOutcome.read(status: 200,
            data: Data("{\"state\":\"sent\",\"threadId\":\"thread\"}".utf8), networkError: false), .retry)
        XCTAssertEqual(ShareOutcome.read(status: 409, data: try failure("revoked"), networkError: false), .retry)
        XCTAssertEqual(ShareOutcome.read(status: 200,
            data: Data("{\"state\":\"sent\",\"threadId\":\"thread\",\"queueId\":\"q\"}".utf8), networkError: true), .retry)
    }
    func testOutboxCopyInAllEightLocalesAndEnglishVerbatim() throws {
        let resources = Fixtures.contract.deletingLastPathComponent().appendingPathComponent("ios/App/MurageShell/Sources/MurageShell/Resources")
        let expected = ["share_outbox_waiting": "Waiting to send", "share_outbox_sent": "Sent",
                        "share_outbox_failed": "Couldn't send. Tap to try again.",
                        "share_outbox_couldnt_send": "Couldn't send",
                        "share_outbox_target": "That chat is no longer available. Pick another."]
        for locale in ["en", "de", "es", "fr", "hi", "ja", "pt-BR", "zh"] {
            let data = try Data(contentsOf: resources.appendingPathComponent(locale + ".lproj/Localizable.strings"))
            let strings = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: String])
            for (key, english) in expected {
                let value = try XCTUnwrap(strings[key])
                XCTAssertFalse(value.isEmpty); XCTAssertFalse(value.contains("\u{2014}"))
                XCTAssertNil(value.range(of: "\\b(safe|unsafe|safety)\\b", options: [.regularExpression, .caseInsensitive]))
                if locale == "en" { XCTAssertEqual(value, english) }
            }
        }
    }
}
