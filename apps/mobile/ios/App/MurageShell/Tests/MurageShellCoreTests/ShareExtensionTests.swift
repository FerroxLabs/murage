import CryptoKit
import Foundation
import Security
import UniformTypeIdentifiers
import XCTest
import ImageIO
import CoreGraphics
@testable import MurageShellCore

final class ShareExtensionTests: XCTestCase {
    private let origin = WorkspaceOrigin(string: "https://desk.example.test")!
    private let now: Int64 = 1_800_000_000_000
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("n11-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    private func answer() throws -> PhoneAskContract.TargetsAnswer {
        let fixture = try XCTUnwrap(Fixtures.json("phone-ask.json") as? [String: Any])
        let targets = try XCTUnwrap(fixture["targets"] as? [String: Any])
        return try JSONDecoder().decode(PhoneAskContract.TargetsAnswer.self,
            from: JSONSerialization.data(withJSONObject: XCTUnwrap(targets["answer"])))
    }
    func testEverySharedFileIsExcludedAtCreationAndOnLaunchRepair() throws {
        let root = try directory()
        var book = WorkspaceBook(); book.signedIn(origin, name: "Desk", at: now)
        try ShareWorkspaceStore(root: root).write(book)
        try ShareTargetCache(root: root).write(answer(), origin: origin, now: now)
        try SharePendingRemovals(root: root).set(origin, pending: true)
        let prepared = try ShareBodyFile.prepare(root: root, origin: origin, target: .init(botId: "bot-lena", threadId: "new"),
            shareId: "share_backup_test_0001", note: nil, text: "Hello", url: nil, attachments: [], now: now)
        let staging = root.appendingPathComponent("share-staging/test")
        try ShareFiles.createDirectory(at: staging)
        try ShareFiles.atomic(Data("private copy".utf8), to: staging.appendingPathComponent("copy"))
        let paths = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)).allObjects.compactMap { $0 as? URL }
        XCTAssertTrue(paths.contains {
            $0.resolvingSymlinksInPath().standardizedFileURL == prepared.body.resolvingSymlinksInPath().standardizedFileURL
        })
        XCTAssertGreaterThan(paths.count, 8)
        for var url in paths {
            url.removeCachedResourceValue(forKey: .isExcludedFromBackupKey)
            XCTAssertEqual(try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true, url.path)
        }
        #if os(iOS)
        // All fixture writes, including prepare's state.json write, finish
        // synchronously. macOS can still report inherited/cached exclusions
        // after clearing these flags and the URL cache; exercise the reset and
        // launch repair on iOS, where the product uses this backup policy.
        // The enumerator omits root. Clear descendants before their parents.
        let resetPaths = ([root] + paths).sorted { $0.pathComponents.count > $1.pathComponents.count }
        for var url in resetPaths {
            var values = URLResourceValues(); values.isExcludedFromBackup = false
            try url.setResourceValues(values)
        }
        for var url in resetPaths {
            url.removeCachedResourceValue(forKey: .isExcludedFromBackupKey)
            XCTAssertEqual(try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, false, url.path)
        }
        try ShareFiles.excludeExisting(root: root)
        for var url in paths {
            url.removeCachedResourceValue(forKey: .isExcludedFromBackupKey)
            XCTAssertEqual(try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true, url.path)
        }
        #endif
        // Atomic replacement must carry the exclusion onto the new inode too.
        try ShareWorkspaceStore(root: root).write(book)
        var workspaceFile = root.appendingPathComponent("share-workspaces.json")
        workspaceFile.removeCachedResourceValue(forKey: .isExcludedFromBackupKey)
        XCTAssertEqual(try workspaceFile.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }
    func testCancelDeletesOnlyThisSharesStaging() throws {
        let root = try directory(), staging = root.appendingPathComponent("share-staging/one")
        let other = root.appendingPathComponent("share-staging/two/body")
        try ShareFiles.atomic(Data("one".utf8), to: staging.appendingPathComponent("body"))
        try ShareFiles.atomic(Data("two".utf8), to: other)
        try ShareFiles.removeStaging(staging)
        try ShareFiles.removeStaging(staging) // Idempotent after a cancelled provider returns.
        XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path))
        XCTAssertEqual(try Data(contentsOf: other), Data("two".utf8))
        let source = try String(contentsOf: Fixtures.contract.deletingLastPathComponent()
            .appendingPathComponent("ios/App/ShareExtension/ShareViewController.swift"), encoding: .utf8)
        XCTAssertTrue(source.contains("barButtonSystemItem: .cancel"))
        XCTAssertTrue(source.contains("context?.cancelRequest(withError:"))
        XCTAssertTrue(source.contains("ShareFiles.removeStaging(staging)"))
    }
    func testConcurrentFailureJournalWritersKeepAllRowsAndRemoveOnlyTheirOwn() throws {
        let root = try directory(), file = root.appendingPathComponent("outbox/failed.json")
        let values = (0..<20).map { index in
            ShareOutboxState(shareId: "share_journal_0000_\(index)", workspace: "workspace",
                target: .init(botId: "bot-lena", threadId: "new"), fingerprint: "hash", createdAt: 1, state: .failed)
        }
        DispatchQueue.concurrentPerform(iterations: values.count) { index in
            do { try ShareFailureJournal(file: file).update { $0.append(values[index]) } }
            catch { XCTFail("Journal write failed: \(error)") }
        }
        XCTAssertEqual(Set(try ShareFailureJournal(file: file).update { _ in }.map(\.shareId)), Set(values.map(\.shareId)))
        DispatchQueue.concurrentPerform(iterations: values.count) { index in
            do {
                try ShareFailureJournal(file: file).update { lines in
                    if index.isMultiple(of: 2) { lines.removeAll { $0.shareId == values[index].shareId } }
                    else { lines.removeAll { $0.shareId == values[index].shareId }; lines.append(values[index]) }
                }
            } catch { XCTFail("Journal update failed: \(error)") }
        }
        XCTAssertEqual(Set(try ShareFailureJournal(file: file).update { _ in }.map(\.shareId)),
                       Set(values.enumerated().filter { !$0.offset.isMultiple(of: 2) }.map { $0.element.shareId }))
    }
    func testCacheIdentityFiveMinutesAndThirtyDays() throws {
        let cache = ShareTargetCache(root: try directory())
        let targets = try answer()
        XCTAssertTrue(cache.needsRefresh(origin, now: now))
        try cache.write(targets, origin: origin, now: now)
        XCTAssertFalse(cache.needsRefresh(origin, now: now + 300_000))
        XCTAssertTrue(cache.needsRefresh(origin, now: now + 300_001))
        XCTAssertEqual(cache.read(origin, now: now)?.targets, targets)
        XCTAssertNil(cache.read(origin, now: now + 31 * 86_400_000))
        XCTAssertNil(cache.read(origin, now: now - 1))
        let expected = Data(SHA256.hash(data: Data(origin.serialized.utf8))).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        XCTAssertEqual(cache.file(origin).lastPathComponent, expected + ".json")
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: cache.file(origin))) as? [String: Any])
        object["v"] = 2
        try ShareFiles.atomic(JSONSerialization.data(withJSONObject: object), to: cache.file(origin))
        XCTAssertNil(cache.read(origin, now: now))
        try ShareFiles.atomic(Data("{".utf8), to: cache.file(origin))
        XCTAssertNil(cache.read(origin, now: now))
        try cache.write(targets, origin: origin, now: now)
        try cache.remove(origin)
        XCTAssertNil(cache.read(origin, now: now))
    }
    func testAtomicReadersAndConcurrentAppAndExtensionWriters() throws {
        let root = try directory(), targets = try answer()
        let app = ShareTargetCache(root: root), sheet = ShareTargetCache(root: root)
        try app.write(targets, origin: origin, now: now)
        let group = DispatchGroup(), queue = DispatchQueue(label: "n11-cache", attributes: .concurrent)
        let start = DispatchSemaphore(value: 0)
        for writer in [app, sheet] {
            group.enter()
            queue.async { [self] in
                start.wait()
                defer { group.leave() }
                for index in 0..<100 {
                    do { try writer.write(targets, origin: origin, now: now + Int64(index % 2)) }
                    catch { XCTFail("Atomic writer failed: \(error)") }
                }
            }
        }
        start.signal(); start.signal()
        for _ in 0..<300 {
            let entry = try XCTUnwrap(app.read(origin, now: now + 1))
            XCTAssertTrue([now, now + 1].contains(entry.fetchedAt))
            XCTAssertEqual(entry.targets, targets)
        }
        XCTAssertEqual(group.wait(timeout: .now() + 10), .success)
        XCTAssertNotNil(app.read(origin, now: now + 1))
    }
    @MainActor
    func testEmptyFailedOrEmptyBotsCacheIsSetupAndNeverQueues() async throws {
        for status in [200, 503, 404] {
            let root = try directory(), cache = ShareTargetCache(root: root)
            var requests = 0
            let empty = try PhoneAskContract.TargetsAnswer(workspace: "desk", bots: [], recent: [])
            let client = ShareTargetsClient(cache: cache, readToken: { _ in "murage_pa_" + String(repeating: "A", count: 43) },
                removeToken: { _ in XCTFail("unexpected removal") }, cancelUploads: { _, done in done(true) }, fetch: { _, _ in
                    requests += 1
                    return .init(status: status, data: try JSONEncoder().encode(empty))
                })
            XCTAssertEqual(client.initial(origin, now: now), .loading)
            let state = await client.open(origin, now: now)
            XCTAssertEqual(state, status == 404 ? .update : .setup)
            _ = await client.open(origin, now: now)
            XCTAssertEqual(requests, 1)
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("outbox").path))
        }
        let root = try directory()
        let client = ShareTargetsClient(cache: .init(root: root), readToken: { _ in nil }, removeToken: { _ in },
                                        cancelUploads: { _, done in done(true) }, fetch: { _, _ in XCTFail("No token must not fetch"); throw ShareInputError.invalid })
        let state = await client.open(origin, now: now)
        XCTAssertEqual(state, .setup)
    }
    @MainActor
    func testUnauthorizedDeletesTokenAndCacheAndFreshCacheDoesNotFetch() async throws {
        for status in [401, 403] {
            let cache = ShareTargetCache(root: try directory())
            try cache.write(answer(), origin: origin, now: now - 300_001)
            var token: String? = "murage_pa_" + String(repeating: "A", count: 43)
            let client = ShareTargetsClient(cache: cache, readToken: { _ in token }, removeToken: { _ in token = nil },
                cancelUploads: { _, done in done(true) }, fetch: { _, _ in .init(status: status, data: Data()) })
            let result = await client.open(origin, now: now)
            XCTAssertEqual(result, .setup)
            XCTAssertNil(token); XCTAssertNil(cache.read(origin, now: now))
        }
        let cache = ShareTargetCache(root: try directory()), targets = try answer()
        try cache.write(targets, origin: origin, now: now)
        let client = ShareTargetsClient(cache: cache, readToken: { _ in "token" }, removeToken: { _ in },
            cancelUploads: { _, done in done(true) }, fetch: { _, _ in XCTFail("Fresh cache must not fetch"); throw ShareInputError.invalid })
        let result = await client.open(origin, now: now + 300_000)
        XCTAssertEqual(result, .ready(targets))
    }
    @MainActor
    func testNetworkFailureAndUnpairDuringFetchCannotCreateCache() async throws {
        let root = try directory(), cache = ShareTargetCache(root: root), targets = try answer()
        var token: String? = "token"
        let client = ShareTargetsClient(cache: cache, readToken: { _ in token }, removeToken: { _ in token = nil },
            cancelUploads: { _, done in done(true) }, fetch: { _, _ in
                token = nil // app unpaired while the GET was in flight
                return .init(status: 200, data: try JSONEncoder().encode(targets))
            })
        let result = await client.open(origin, now: now)
        XCTAssertEqual(result, .setup)
        XCTAssertNil(cache.read(origin, now: now))
        let offline = ShareTargetsClient(cache: cache, readToken: { _ in "token" }, removeToken: { _ in },
                                        cancelUploads: { _, done in done(true) }, fetch: { _, _ in throw URLError(.timedOut) })
        let failed = await offline.open(origin, now: now)
        XCTAssertEqual(failed, .setup)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("outbox").path))
    }
    @MainActor
    func testSharedRemovalSetSurvivesReadersAndKeepsOtherOrigins() throws {
        let root = try directory()
        let app = SharePendingRemovals(root: root), sheet = SharePendingRemovals(root: root)
        let other = try XCTUnwrap(WorkspaceOrigin(string: "https://other.example.test"))
        XCTAssertFalse(sheet.contains(origin))
        try app.set(origin, pending: true)
        try sheet.set(other, pending: true)
        XCTAssertEqual(try app.read(), Set([origin.serialized, other.serialized]))
        try app.set(origin, pending: false)
        XCTAssertFalse(sheet.contains(origin))
        XCTAssertTrue(sheet.contains(other))
        try ShareFiles.atomic(Data("{".utf8), to: root.appendingPathComponent("phone-ask-pending-removals.json"))
        XCTAssertTrue(sheet.contains(origin), "Unreadable shared state fails closed")
    }
    func testConcurrentSharedRemovalWritersKeepEveryOrigin() throws {
        let root = try directory()
        let origins = (0..<12).map { WorkspaceOrigin(string: "https://desk\($0).example.test")! }
        DispatchQueue.concurrentPerform(iterations: origins.count) { index in
            do { try SharePendingRemovals(root: root).set(origins[index], pending: true) }
            catch { XCTFail("Shared removal writer failed: \(error)") }
        }
        XCTAssertEqual(try SharePendingRemovals(root: root).read(), Set(origins.map(\.serialized)))
    }
    @MainActor
    func testPendingRemovalBlocksInitialRefreshAndSendWithoutReadingToken() async throws {
        let root = try directory(), cache = ShareTargetCache(root: root), targets = try answer()
        try cache.write(targets, origin: origin, now: now)
        try SharePendingRemovals(root: root).set(origin, pending: true)
        let client = ShareTargetsClient(cache: cache,
            readToken: { _ in XCTFail("Pending removal must not read Keychain"); return "surviving-bearer" },
            removeToken: { _ in XCTFail("Only the app retries pending deletion") },
            cancelUploads: { _, done in done(true) }, fetch: { _, _ in XCTFail("Pending removal must not refetch"); throw ShareInputError.invalid })
        XCTAssertTrue(client.isSignedOut(origin)) // The workspace picker uses the same gate.
        XCTAssertEqual(client.initial(origin, now: now), .setup)
        let opened = await client.open(origin, now: now)
        XCTAssertEqual(opened, .setup)
        let refreshed = await client.refresh(origin, now: now, fallback: .ready(targets))
        XCTAssertEqual(refreshed, .setup)
        let bot = try XCTUnwrap(targets.bots.first)
        XCTAssertFalse(client.allows(.init(botId: bot.id, threadId: bot.mainThreadId), origin: origin, now: now))
    }
    @MainActor
    func testLockedForgetDuringRefreshCannotRestoreCacheOrFallback() async throws {
        for status in [200, 404, 500, -1] {
            let root = try directory(), cache = ShareTargetCache(root: root), targets = try answer()
            try cache.write(targets, origin: origin, now: now - 300_001)
            let app = SharePendingRemovals(root: root)
            var reads = 0
            let client = ShareTargetsClient(cache: cache, readToken: { _ in reads += 1; return "surviving-bearer" },
                removeToken: { _ in throw PhoneAskTokenStore.StoreError.storage }, cancelUploads: { _, done in done(true) }, fetch: { [self] _, _ in
                    // Independent app writer forgets while the sheet awaits its response.
                    try app.set(origin, pending: true)
                    try cache.remove(origin)
                    if status == -1 { throw URLError(.timedOut) }
                    return .init(status: status, data: try JSONEncoder().encode(targets))
                })
            let state = await client.refresh(origin, now: now, fallback: .ready(targets))
            XCTAssertEqual(state, .setup)
            XCTAssertEqual(reads, 1)
            XCTAssertNil(cache.read(origin, now: now))
            XCTAssertEqual(client.initial(origin, now: now), .setup)
        }
    }
    @MainActor
    func testRefreshRechecksRemovalImmediatelyBeforeCacheWrite() async throws {
        let root = try directory(), cache = ShareTargetCache(root: root), targets = try answer()
        var reads = 0
        let client = ShareTargetsClient(cache: cache, readToken: { [self] _ in
            reads += 1
            if reads == 2 { try SharePendingRemovals(root: root).set(origin, pending: true) }
            return "surviving-bearer"
        }, removeToken: { _ in }, cancelUploads: { _, done in done(true) }, fetch: { _, _ in .init(status: 200, data: try JSONEncoder().encode(targets)) })
        let state = await client.refresh(origin, now: now)
        XCTAssertEqual(state, .setup)
        XCTAssertEqual(reads, 2)
        XCTAssertNil(cache.read(origin, now: now))
    }
    @MainActor
    func testUnauthorizedLockedDeletePersistsBarrierForNextSheet() async throws {
        for status in [401, 403] {
            let root = try directory(), cache = ShareTargetCache(root: root)
            try cache.write(answer(), origin: origin, now: now - 300_001)
            let client = ShareTargetsClient(cache: cache, readToken: { _ in "surviving-bearer" },
                removeToken: { _ in throw PhoneAskTokenStore.StoreError.storage },
                cancelUploads: { _, done in done(true) }, fetch: { _, _ in .init(status: status, data: Data()) })
            let state = await client.open(origin, now: now)
            XCTAssertEqual(state, .setup)
            XCTAssertTrue(SharePendingRemovals(root: root).contains(origin))
            XCTAssertNil(cache.read(origin, now: now))
            let next = ShareTargetsClient(cache: cache, readToken: { _ in XCTFail("Signed out"); return "token" },
                removeToken: { _ in }, cancelUploads: { _, done in done(true) }, fetch: { _, _ in XCTFail("Signed out"); throw ShareInputError.invalid })
            XCTAssertEqual(next.initial(origin, now: now), .setup)
            let reopened = await next.open(origin, now: now)
            XCTAssertEqual(reopened, .setup)
        }
    }
    @MainActor
    func testRecentIdentityAndSendRequireExactPairInCurrentOrigin() throws {
        let root = try directory(), cache = ShareTargetCache(root: root)
        let bots = try ["a", "b"].map { try PhoneAskContract.TargetBot(id: $0, name: $0, avatar: nil, mainThreadId: "main") }
        let recent = try ["a", "b"].map { try PhoneAskContract.RecentTarget(botId: $0, threadId: "shared", title: $0, at: now) }
        XCTAssertEqual(Set(recent.map(\.shareIdentity)).count, 2)
        let targets = try PhoneAskContract.TargetsAnswer(workspace: "desk", bots: bots, recent: recent)
        try cache.write(targets, origin: origin, now: now)
        let client = ShareTargetsClient(cache: cache, readToken: { _ in XCTFail("Validation must not read token"); return nil },
            removeToken: { _ in }, cancelUploads: { _, done in done(true) }, fetch: { _, _ in throw ShareInputError.invalid })
        for row in recent { XCTAssertTrue(client.allows(row.shareIdentity, origin: origin, now: now)) }
        XCTAssertTrue(client.allows(.init(botId: "a", threadId: "new"), origin: origin, now: now))
        XCTAssertTrue(client.allows(.init(botId: "a", threadId: "main"), origin: origin, now: now))
        XCTAssertFalse(client.allows(.init(botId: "unknown", threadId: "shared"), origin: origin, now: now))
        XCTAssertFalse(client.allows(.init(botId: "a", threadId: "unknown"), origin: origin, now: now))
        let other = try XCTUnwrap(WorkspaceOrigin(string: "https://other.example.test"))
        try cache.write(PhoneAskContract.TargetsAnswer(workspace: "other", bots: bots, recent: [recent[0]]), origin: other, now: now)
        XCTAssertFalse(client.allows(recent[1].shareIdentity, origin: other, now: now))
        // A target removed while the body was prepared cannot enqueue afterward.
        try cache.write(PhoneAskContract.TargetsAnswer(workspace: "desk", bots: bots, recent: [recent[0]]), origin: origin, now: now)
        XCTAssertFalse(client.allows(recent[1].shareIdentity, origin: origin, now: now))
        try SharePendingRemovals(root: root).set(origin, pending: true)
        XCTAssertFalse(client.allows(recent[0].shareIdentity, origin: origin, now: now))
    }
    func testPredicateMatchesEveryFixtureTypeButNotFileURLOrVideo() throws {
        let policy = try JSONDecoder().decode(ShareTypePolicy.self, from: Data(contentsOf: Fixtures.contract.appendingPathComponent("share-types.json")))
        XCTAssertEqual(policy.files.map(\.mime), PhoneAskContract.fileMimes)
        XCTAssertEqual(policy.images, PhoneAskContract.imageMimes)
        func conforms(_ a: String, _ b: String) -> Bool {
            if a == b { return true }
            guard let a = UTType(a), let b = UTType(b) else { return false }
            return a.conforms(to: b)
        }
        for type in policy.supportedIdentifiers { XCTAssertTrue(policy.accepts([type], conforms: conforms), type) }
        XCTAssertTrue(policy.accepts(["public.url"], conforms: conforms))
        XCTAssertTrue(policy.accepts(["public.file-url", "com.adobe.pdf"], conforms: conforms))
        XCTAssertFalse(policy.accepts(["public.file-url"], conforms: conforms))
        XCTAssertFalse(policy.accepts(["public.mpeg-4"], conforms: conforms))
        XCTAssertFalse(policy.accepts(["public.jpeg", "public.movie"], conforms: conforms))
        XCTAssertFalse(policy.accepts([], conforms: conforms))
        XCTAssertThrowsError(try ShareTypePolicy.checkCount(11))
        XCTAssertThrowsError(try ShareTypePolicy.checkCount(0))
        try ShareTypePolicy.checkCount(10)
    }
    func testCheckedInActivationPredicateMatchesRepositoryFixture() throws {
        let policy = try JSONDecoder().decode(ShareTypePolicy.self, from: Data(contentsOf: Fixtures.contract.appendingPathComponent("share-types.json")))
        let app = Fixtures.contract.deletingLastPathComponent().appendingPathComponent("ios/App")
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: app.appendingPathComponent("ShareExtension/Info.plist")), format: nil) as? [String: Any])
        let extensionInfo = try XCTUnwrap(plist["NSExtension"] as? [String: Any])
        let attributes = try XCTUnwrap(extensionInfo["NSExtensionAttributes"] as? [String: Any])
        XCTAssertEqual(attributes["NSExtensionActivationRule"] as? String, policy.activationPredicate)
        XCTAssertEqual(attributes["IntentsSupported"] as? [String], ["INSendMessageIntent"])
    }
    func testBodyFileIsExactlyTheMultipartFixtureAndStateIsQueued() throws {
        let root = try directory()
        let f = try XCTUnwrap(Fixtures.json("phone-ask.json") as? [String: Any])
        let share = try XCTUnwrap(f["share"] as? [String: Any]), mp = try XCTUnwrap(share["multipart"] as? [String: Any])
        let manifest = try XCTUnwrap(share["manifest"] as? [String: Any])
        let value = try JSONDecoder().decode(PhoneAskContract.ShareManifest.self, from: JSONSerialization.data(withJSONObject: XCTUnwrap(manifest["valid"])))
        let items = try XCTUnwrap(mp["items"] as? [[String: Any]])
        let urls = try items.enumerated().map { index, item -> URL in
            let url = root.appendingPathComponent("input-\(index)")
            try Data(XCTUnwrap(item["text"] as? String).utf8).write(to: url)
            return url
        }
        let body = root.appendingPathComponent("body")
        try ShareBodyFile.write(manifest: value, boundary: XCTUnwrap(mp["boundary"] as? String), body: body, urls: urls)
        XCTAssertEqual(try Data(contentsOf: body), Data(try XCTUnwrap(mp["body"] as? String).utf8))
        let target = ShareOutboxState.Target(botId: value.botId, threadId: value.threadId)
        let attachments = zip(value.items, urls).map { ShareBodyFile.Attachment(url: $0.1, name: $0.0.name, mime: $0.0.mime) }
        let prepared = try ShareBodyFile.prepare(root: root, origin: origin, target: target, shareId: value.shareId,
            note: value.note, text: value.text, url: value.url, attachments: attachments, now: now)
        let state = try JSONDecoder().decode(ShareOutboxState.self, from: Data(contentsOf: prepared.body.deletingLastPathComponent().appendingPathComponent("state.json")))
        XCTAssertEqual(state, prepared.state)
        XCTAssertEqual(state.state, .queued)
        XCTAssertEqual(state.workspace, ShareTargetCache.workspace(origin))
        XCTAssertEqual(state.target, target)
        XCTAssertEqual(state.createdAt, now)
        XCTAssertEqual(state.fingerprint.count, 64)
        let original = try Data(contentsOf: prepared.body)
        XCTAssertThrowsError(try ShareBodyFile.prepare(root: root, origin: origin, target: target, shareId: value.shareId,
            note: "different", text: value.text, url: value.url, attachments: attachments, now: now))
        XCTAssertEqual(try Data(contentsOf: prepared.body), original)
    }
    func test48MegapixelPanoramaIsPreparedByRealDecoderAt4096Pixels() throws {
        let root = try directory(), source = root.appendingPathComponent("panorama.jpg"), destination = root.appendingPathComponent("photo.jpg")
        // Generate the fixture locally. Peak process memory remains a device check.
        try autoreleasepool {
            let context = try XCTUnwrap(CGContext(data: nil, width: 16_000, height: 3_000,
                bitsPerComponent: 8, bytesPerRow: 16_000 * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
            context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.6, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: 16_000, height: 3_000))
            let image = try XCTUnwrap(context.makeImage())
            let writer = try XCTUnwrap(CGImageDestinationCreateWithURL(source as CFURL, UTType.jpeg.identifier as CFString, 1, nil))
            CGImageDestinationAddImage(writer, image, nil)
            XCTAssertTrue(CGImageDestinationFinalize(writer))
        }
        try ShareImagePreparation.prepare(source: source, destination: destination, expectedType: UTType.jpeg.identifier)
        let output = try XCTUnwrap(CGImageSourceCreateWithURL(destination as CFURL, nil))
        let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(output, 0, nil) as? [CFString: Any])
        XCTAssertEqual(properties[kCGImagePropertyPixelWidth] as? Int, 4096)
        XCTAssertEqual(properties[kCGImagePropertyPixelHeight] as? Int, 768)
        XCTAssertEqual(CGImageSourceGetType(output) as String?, UTType.jpeg.identifier)

        // Spy on the same ImageIO call used by production, then run the real
        // decoder. This asserts the decode limit as well as the encoded result.
        var calls = 0
        let observed = root.appendingPathComponent("observed.jpg")
        try ShareImagePreparation.prepare(source: source, destination: observed, expectedType: UTType.jpeg.identifier) { image, index, options in
            calls += 1
            guard let options = options as? [CFString: Any] else {
                XCTFail("Production thumbnail options are missing")
                return nil
            }
            XCTAssertEqual(options[kCGImageSourceThumbnailMaxPixelSize] as? Int, 4096)
            XCTAssertEqual(options[kCGImageSourceCreateThumbnailFromImageAlways] as? Bool, true)
            let preview = CGImageSourceCreateThumbnailAtIndex(image, index, options as CFDictionary)
            if let preview {
                XCTAssertEqual(preview.width, 4096)
                XCTAssertEqual(preview.height, 768)
                XCTAssertLessThanOrEqual(max(preview.width, preview.height), 4096)
            } else { XCTFail("Production thumbnail decoding failed") }
            return preview
        }
        XCTAssertEqual(calls, 1)
    }
    @MainActor
    func testCoreTokenStoreLockedReadAndOnlyAskGroup() throws {
        var queried: [[String: Any]] = []
        let store = PhoneAskTokenStore(operations: .init(update: { _, _ in errSecSuccess }, add: { _ in errSecSuccess },
            read: { query in queried.append(query); return (errSecInteractionNotAllowed, nil) }, delete: { _ in errSecSuccess }),
            accessGroup: "TEAM.com.murage.mobile.ask")
        XCTAssertThrowsError(try store.readForAsk(origin: origin))
        XCTAssertEqual(queried.count, 1)
        XCTAssertEqual(queried[0][kSecAttrAccessGroup as String] as? String, "TEAM.com.murage.mobile.ask")
    }
    func testPartialBodyAndOversizedInputsNeverLeaveQueuedState() throws {
        let root = try directory(), input = root.appendingPathComponent("file.pdf")
        XCTAssertTrue(FileManager.default.createFile(atPath: input.path, contents: nil))
        let handle = try FileHandle(forWritingTo: input)
        try handle.truncate(atOffset: UInt64(PhoneAskContract.ShareLimits.fileMaxBytes + 1))
        try handle.close()
        let target = ShareOutboxState.Target(botId: "bot-lena", threadId: "new")
        XCTAssertThrowsError(try ShareBodyFile.prepare(root: root, origin: origin, target: target,
            shareId: "share_oversized_0001", note: nil, text: nil, url: nil,
            attachments: [.init(url: input, name: "file.pdf", mime: "application/pdf")], now: now))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("outbox/share_oversized_0001/state.json").path))
        try Data("hello".utf8).write(to: input)
        XCTAssertThrowsError(try ShareBodyFile.prepare(root: root, origin: origin, target: target,
            shareId: "share_badname_0001", note: nil, text: nil, url: nil,
            attachments: [.init(url: input, name: "../file.pdf", mime: "application/pdf")], now: now))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("outbox/share_badname_0001").path))
    }
    func testExtensionEntitlementsAndAllShippedLocales() throws {
        let app = Fixtures.contract.deletingLastPathComponent().appendingPathComponent("ios/App")
        let appInfo = try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: app.appendingPathComponent("App/Info.plist")), format: nil) as? [String: Any])
        XCTAssertNil(appInfo["CFBundleURLTypes"])
        let extensionRoot = app.appendingPathComponent("ShareExtension")
        let entitlements = try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: extensionRoot.appendingPathComponent("ShareExtension.entitlements")), format: nil) as? [String: Any])
        XCTAssertEqual(Set(entitlements.keys), Set(["com.apple.security.application-groups", "keychain-access-groups"]))
        XCTAssertEqual(entitlements["com.apple.security.application-groups"] as? [String], ["group.com.murage.mobile"])
        XCTAssertEqual(entitlements["keychain-access-groups"] as? [String], ["$(AppIdentifierPrefix)com.murage.mobile.ask"])
        var expectedKeys: Set<String>?
        for locale in ["en", "de", "es", "fr", "hi", "ja", "pt-BR", "zh"] {
            let data = try Data(contentsOf: extensionRoot.appendingPathComponent(locale + ".lproj/Localizable.strings"))
            let strings = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: String])
            if let expectedKeys { XCTAssertEqual(Set(strings.keys), expectedKeys) }
            else { expectedKeys = Set(strings.keys) }
            for value in strings.values {
                XCTAssertFalse(value.contains("\u{2014}"))
                XCTAssertNil(value.range(of: "\\b(safe|unsafe|safety)\\b", options: [.regularExpression, .caseInsensitive]))
            }
            XCTAssertFalse(try XCTUnwrap(strings["share_done"]).isEmpty)
            XCTAssertNil(strings["share_open"])
            XCTAssertTrue(try XCTUnwrap(strings["share_sent"]).contains("%@"))
        }
    }

}
