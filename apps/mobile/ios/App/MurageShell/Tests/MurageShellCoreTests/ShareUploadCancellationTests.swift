import Foundation
import XCTest
@testable import MurageShellCore

@MainActor final class ShareUploadCancellationTests: XCTestCase {
    private let origin = WorkspaceOrigin(string: "https://desk.example.test")!
    private let other = WorkspaceOrigin(string: "https://other.example.test")!
    private let id = "share_cancel_test_0001"

    private final class FakeTask: ShareResumableUpload {
        let taskDescription: String?
        let originalRequest: URLRequest?
        var cancellations = 0
        var resumes = 0
        func resume() { resumes += 1 }
        var removeOnCancel = true
        var removed = false
        init(description: String?, originalRequest: URLRequest? = nil) {
            self.taskDescription = description; self.originalRequest = originalRequest
        }
        func cancel() {
            cancellations += 1
            if removeOnCancel { removed = true }
        }
    }
    private final class FakeSession {
        var tasks: [FakeTask]
        var inventories = 0
        var failOn = Set<Int>()
        var inventoryError: Error?
        var snapshots: [Int: [FakeTask]] = [:]
        init(_ tasks: [FakeTask]) { self.tasks = tasks }
        func allTasks() async throws -> [any ShareUploadTask] {
            inventories += 1
            if failOn.contains(inventories) { inventoryError = URLError(.backgroundSessionInUseByAnotherProcess) }
            if let inventoryError { throw inventoryError }
            return (snapshots[inventories] ?? tasks.filter { !$0.removed }).map { $0 as any ShareUploadTask }
        }
    }
    private func task(_ origin: WorkspaceOrigin, id: String? = nil, request: URLRequest? = nil) throws -> FakeTask {
        FakeTask(description: try ShareUploadIdentity(origin: origin, shareId: id ?? self.id).description,
                 originalRequest: request)
    }
    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("n12-cancel-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }
    private func forget(_ removal: ShareOriginRemoval) async -> Bool {
        await withCheckedContinuation { continuation in
            XCTAssertFalse(removal.forget(origin, now: 1_800_000_000_000) { continuation.resume(returning: $0) })
        }
    }
    private func removal(_ root: URL, app: FakeSession, ext: FakeSession,
                         didCancel: @escaping (String) -> Void = { _ in }) -> ShareOriginRemoval {
        ShareOriginRemoval(root: root, removeToken: { _ in }, cancelUploads: { origin, done in
            Task { @MainActor in
                let result = await ShareUploadCancellation.cancel(origin: origin,
                    inventories: [app.allTasks, ext.allTasks], didCancel: didCancel)
                done(result)
            }
        })
    }

    func testTaggedTasksAndMatchingRequestsAreCancelledWhileUnrelatedTaskIsPreserved() async throws {
        let root = try directory(), barrier = SharePendingRemovals(root: root)
        let appTask = try task(origin, request: URLRequest(url: other.url))
        let extTask = try task(origin)
        let otherApp = try task(other, id: "share_other_app_00001", request: URLRequest(url: origin.url))
        let otherExt = try task(other, id: "share_other_ext_00001")
        let app = FakeSession([appTask, otherApp]), ext = FakeSession([extTask, otherExt])
        var handled: [String] = []
        let removal = removal(root, app: app, ext: ext) { id in
            XCTAssertTrue(barrier.contains(self.origin))
            handled.append(id)
        }
        XCTAssertNil(extTask.originalRequest)
        let result = await forget(removal)
        XCTAssertTrue(result); XCTAssertFalse(barrier.contains(origin))
        XCTAssertEqual(appTask.cancellations, 1); XCTAssertEqual(extTask.cancellations, 1)
        XCTAssertEqual(handled, [id, "share_other_app_00001", id])
        XCTAssertEqual(otherApp.cancellations, 1); XCTAssertEqual(otherExt.cancellations, 0)
        XCTAssertTrue(otherApp.removed); XCTAssertFalse(otherExt.removed)
        XCTAssertEqual(app.inventories, 2); XCTAssertEqual(ext.inventories, 2)
    }

    func testTaskStillListedAfterCancelKeepsBarrierUntilNextRemovalRetry() async throws {
        for retainedSession in ["app", "extension"] {
            let root = try directory(), barrier = SharePendingRemovals(root: root)
            let appTask = try task(origin), extTask = try task(origin)
            let retained = retainedSession == "app" ? appTask : extTask
            retained.removeOnCancel = false
            let app = FakeSession([appTask]), ext = FakeSession([extTask])
            var handled: [String] = []
            let removal = removal(root, app: app, ext: ext) { handled.append($0) }
            let result = await forget(removal)
            XCTAssertFalse(result); XCTAssertTrue(barrier.contains(origin))
            XCTAssertEqual(appTask.cancellations, 1); XCTAssertEqual(extTask.cancellations, 1)
            XCTAssertEqual(handled, [id, id])
            XCTAssertEqual(app.inventories, 2); XCTAssertEqual(ext.inventories, 2)
            XCTAssertEqual(barrier.retryOrigins(), [origin.serialized])
            // The OS removes the task before the next foreground/unlock retry.
            retained.removed = true
            let retried = await forget(removal)
            XCTAssertTrue(retried); XCTAssertFalse(barrier.contains(origin))
            XCTAssertEqual(handled, [id, id], "An empty inventory must not count as a cancellation")
            XCTAssertEqual(app.inventories, 4); XCTAssertEqual(ext.inventories, 4)
        }
    }

    func testTaskMissingFromInitialInventoryButPresentOnFreshInventoryKeepsBarrier() async throws {
        let root = try directory(), barrier = SharePendingRemovals(root: root)
        let hidden = try task(origin)
        let app = FakeSession([]), ext = FakeSession([hidden])
        ext.snapshots[1] = []
        var handled: [String] = []
        let removal = removal(root, app: app, ext: ext) { handled.append($0) }
        let result = await forget(removal)
        XCTAssertFalse(result); XCTAssertTrue(barrier.contains(origin))
        XCTAssertEqual(hidden.cancellations, 0); XCTAssertTrue(handled.isEmpty)
        XCTAssertEqual(app.inventories, 2); XCTAssertEqual(ext.inventories, 2)
        let retried = await forget(removal)
        XCTAssertTrue(retried); XCTAssertFalse(barrier.contains(origin))
        XCTAssertEqual(hidden.cancellations, 1); XCTAssertEqual(handled, [id])
    }

    func testFailureOfEitherSessionInEitherInventoryKeepsBarrierForRetry() async throws {
        for failedSession in ["app", "extension"] {
            for failedPass in [1, 2] {
                let root = try directory(), barrier = SharePendingRemovals(root: root)
                let appTask = try task(origin), extTask = try task(origin)
                let otherTask = try task(other)
                let app = FakeSession([appTask]), ext = FakeSession([extTask, otherTask])
                let failed = failedSession == "app" ? app : ext
                failed.failOn = [failedPass]
                let removal = removal(root, app: app, ext: ext)
                let result = await forget(removal)
                XCTAssertFalse(result); XCTAssertTrue(barrier.contains(origin))
                XCTAssertEqual(app.inventories, 2); XCTAssertEqual(ext.inventories, 2)
                XCTAssertEqual(otherTask.cancellations, 0)
                XCTAssertNotNil(failed.inventoryError)
                failed.inventoryError = nil // Owner reports the invalidation and replaces its handle.
                let retried = await forget(removal)
                XCTAssertTrue(retried); XCTAssertFalse(barrier.contains(origin))
                XCTAssertEqual(appTask.cancellations, 1); XCTAssertEqual(extTask.cancellations, 1)
                XCTAssertEqual(otherTask.cancellations, 0)
            }
        }
    }

    func testLegacyOrUntaggedTaskWithMatchingRequestIsCancelled() async throws {
        for description in [nil, id, "malformed-tag"] as [String?] {
            let unknown = FakeTask(description: description, originalRequest: URLRequest(url: origin.url))
            let app = FakeSession([]), ext = FakeSession([unknown])
            var handled: [String] = []
            let result = await ShareUploadCancellation.cancel(origin: origin,
                inventories: [app.allTasks, ext.allTasks], didCancel: { handled.append($0) })
            XCTAssertTrue(result); XCTAssertEqual(unknown.cancellations, 1)
            XCTAssertEqual(handled, description == id ? [id] : [])
        }
    }

    func testBareOutboxIDIsCancelledWithoutRequest() async throws {
        let legacy = FakeTask(description: id)
        let app = FakeSession([legacy]), ext = FakeSession([])
        var handled: [String] = []
        let result = await ShareUploadCancellation.cancel(origin: origin, shareIDs: [id],
            inventories: [app.allTasks, ext.allTasks], didCancel: { handled.append($0) })
        XCTAssertTrue(result); XCTAssertEqual(legacy.cancellations, 1); XCTAssertEqual(handled, [id])
    }

    func testRequestAttributionAlsoCancelsTaskWithForeignTag() async throws {
        let upload = try task(other, request: URLRequest(url: origin.url))
        let app = FakeSession([]), ext = FakeSession([upload])
        let result = await ShareUploadCancellation.cancel(origin: origin, inventories: [app.allTasks, ext.allTasks])
        XCTAssertTrue(result); XCTAssertEqual(upload.cancellations, 1)
    }

    func testUnattributableTasksDoNotBlockForgetAndURLRequiresSchemeHostAndPort() async throws {
        let urls: [URL?] = [nil, other.url, URL(string: "http://desk.example.test"), URL(string: "https://desk.example.test:8443")]
        for url in urls {
            let unknown = FakeTask(description: "malformed-tag", originalRequest: url.map { URLRequest(url: $0) })
            let app = FakeSession([]), ext = FakeSession([unknown])
            let result = await ShareUploadCancellation.cancel(origin: origin, inventories: [app.allTasks, ext.allTasks])
            XCTAssertTrue(result); XCTAssertEqual(unknown.cancellations, 0)
        }
    }

    func testInventoryFailureStaysStickyUntilReportedAndCleared() async throws {
        let upload = try task(origin), app = FakeSession([])
        let ext = FakeSession([upload]); ext.failOn = [1]
        for _ in 0..<2 {
            let result = await ShareUploadCancellation.cancel(origin: origin, inventories: [app.allTasks, ext.allTasks])
            XCTAssertFalse(result); XCTAssertNotNil(ext.inventoryError); XCTAssertEqual(upload.cancellations, 0)
        }
        ext.inventoryError = nil
        let result = await ShareUploadCancellation.cancel(origin: origin, inventories: [app.allTasks, ext.allTasks])
        XCTAssertTrue(result); XCTAssertEqual(upload.cancellations, 1)
    }

    #if os(iOS)
    func testAppAndExtensionEnqueueRefusePendingOriginBeforeCreatingTask() throws {
        for isExtension in [false, true] {
            let root = try directory(), body = root.appendingPathComponent("body")
            try Data("body".utf8).write(to: body)
            try SharePendingRemovals(root: root).set(origin, pending: true)
            var creations = 0
            let sessions = ShareBackgroundSessions(root: root, upload: { _, _, _, tag, _ in
                creations += 1; return FakeTask(description: tag)
            })
            let request = URLRequest(url: origin.url)
            if isExtension { XCTAssertThrowsError(try sessions.enqueueExtension(request: request, body: body, shareId: id)) }
            else { XCTAssertThrowsError(try sessions.enqueue(request: request, body: body, shareId: id, notBefore: 0)) }
            XCTAssertEqual(creations, 0)
        }
    }

    func testAppAndExtensionRecheckBeforeResumeCancelsTaskAndFailsRow() throws {
        for isExtension in [false, true] {
            let root = try directory(), pending = SharePendingRemovals(root: root)
            let prepared = try ShareBodyFile.prepare(root: root, origin: origin,
                target: .init(botId: "bot-lena", threadId: "new"), shareId: id,
                note: "Note", text: "Text", url: nil, attachments: [], now: 1_800_000_000_000)
            let upload = FakeTask(description: id)
            let sessions = ShareBackgroundSessions(root: root, upload: { identifier, _, _, _, _ in
                XCTAssertEqual(identifier, isExtension ? ShareUploadSession.identifier : ShareBackgroundSessions.identifier)
                do { try pending.set(self.origin, pending: true) } catch { XCTFail("Barrier write failed: \(error)") }
                return upload
            })
            let request = URLRequest(url: origin.url)
            if isExtension { XCTAssertThrowsError(try sessions.enqueueExtension(request: request, body: prepared.body, shareId: id)) }
            else { XCTAssertThrowsError(try sessions.enqueue(request: request, body: prepared.body, shareId: id, notBefore: 0)) }
            XCTAssertEqual(upload.cancellations, 1); XCTAssertEqual(upload.resumes, 0)
            let row = try ShareOriginRemoval.rows(root: root).state(id)
            XCTAssertEqual(row.state, .failed); XCTAssertEqual(row.code, "removed")
            XCTAssertFalse(FileManager.default.fileExists(atPath: prepared.body.path))
        }
    }

    func testBackgroundOwnerUsesOriginOutboxRowsForBareIDAttribution() async throws {
        let root = try directory()
        _ = try ShareBodyFile.prepare(root: root, origin: origin,
            target: .init(botId: "bot-lena", threadId: "new"), shareId: id,
            note: "Note", text: "Text", url: nil, attachments: [], now: 1_800_000_000_000)
        let legacy = FakeTask(description: id), app = FakeSession([])
        let ext = FakeSession([legacy])
        let sessions = ShareBackgroundSessions(root: root, upload: { _, _, _, tag, _ in FakeTask(description: tag) },
            inventories: [app.allTasks, ext.allTasks])
        let result = await withCheckedContinuation { continuation in
            sessions.cancel(origin: origin) { continuation.resume(returning: $0) }
        }
        XCTAssertTrue(result); XCTAssertEqual(legacy.cancellations, 1)
    }

    func testBackgroundOwnerCancelsBareIDWithoutRequestWhenFailedJSONIsCorrupt() async throws {
        let root = try directory(), otherID = "share_other_row_00001"
        for (workspace, shareID) in [(origin, id), (other, otherID)] {
            _ = try ShareBodyFile.prepare(root: root, origin: workspace,
                target: .init(botId: "bot-lena", threadId: "new"), shareId: shareID,
                note: "Note", text: "Text", url: nil, attachments: [], now: 1_800_000_000_000)
        }
        try Data("{".utf8).write(to: root.appendingPathComponent("outbox/failed.json"))
        let legacy = FakeTask(description: id), unrelated = FakeTask(description: otherID)
        let app = FakeSession([unrelated]), ext = FakeSession([legacy])
        let sessions = ShareBackgroundSessions(root: root, upload: { _, _, _, tag, _ in FakeTask(description: tag) },
            inventories: [app.allTasks, ext.allTasks])
        XCTAssertNil(legacy.originalRequest)
        XCTAssertNil(ShareUploadIdentity(description: legacy.taskDescription))
        let result = await withCheckedContinuation { continuation in
            sessions.cancel(origin: origin) { continuation.resume(returning: $0) }
        }
        XCTAssertTrue(result); XCTAssertEqual(legacy.cancellations, 1)
        XCTAssertTrue(legacy.removed); XCTAssertEqual(unrelated.cancellations, 0)
        XCTAssertEqual(app.inventories, 2); XCTAssertEqual(ext.inventories, 2)
    }

    func testBackgroundOwnerReportsStickyInvalidationThenCancelsOnNextCall() async throws {
        for identifier in [ShareBackgroundSessions.identifier, ShareUploadSession.identifier] {
            let root = try directory(), appTask = try task(origin), extTask = try task(origin)
            let app = FakeSession([appTask]), ext = FakeSession([extTask])
            let sessions = ShareBackgroundSessions(root: root, upload: { _, _, _, tag, _ in FakeTask(description: tag) },
                inventories: [app.allTasks, ext.allTasks])
            // The delegate forwards didBecomeInvalidWithError to this same method.
            sessions.didInvalidate(identifier: identifier, error: URLError(.backgroundSessionInUseByAnotherProcess))
            let first = await withCheckedContinuation { continuation in
                sessions.cancel(origin: origin) { continuation.resume(returning: $0) }
            }
            XCTAssertFalse(first)
            let second = await withCheckedContinuation { continuation in
                sessions.cancel(origin: origin) { continuation.resume(returning: $0) }
            }
            XCTAssertTrue(second)
            XCTAssertEqual(appTask.cancellations, 1); XCTAssertEqual(extTask.cancellations, 1)
        }
    }
    #endif

    func testTagRoundTripPreservesOriginAndShareIDAndAcceptsLegacyCompletionIDs() throws {
        let identity = try ShareUploadIdentity(origin: origin, shareId: id)
        XCTAssertEqual(ShareUploadIdentity(description: identity.description), identity)
        XCTAssertEqual(ShareUploadIdentity.shareID(identity.description), id)
        XCTAssertEqual(ShareUploadIdentity.shareID(id), id)
        XCTAssertNil(ShareUploadIdentity.shareID("malformed-tag"))
        XCTAssertThrowsError(try ShareUploadIdentity(origin: origin, shareId: "../body"))
    }
}
