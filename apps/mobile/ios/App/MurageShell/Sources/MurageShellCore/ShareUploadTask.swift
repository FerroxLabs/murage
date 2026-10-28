import Foundation

/// Background tasks retain this identity even when originalRequest is unavailable.
struct ShareUploadIdentity: Equatable {
    let origin: WorkspaceOrigin
    let shareId: String

    init(origin: WorkspaceOrigin, shareId: String) throws {
        guard PhoneAskContract.matches(shareId, "[A-Za-z0-9_-]{16,80}") else { throw ShareInputError.invalid }
        self.origin = origin; self.shareId = shareId
    }
    init?(description: String?) {
        guard let parts = description?.components(separatedBy: "\n"), parts.count == 3,
              parts[0] == "murage-share/1", let origin = WorkspaceOrigin(string: parts[1]),
              origin.serialized == parts[1],
              let value = try? Self(origin: origin, shareId: parts[2]) else { return nil }
        self = value
    }
    var description: String { "murage-share/1\n" + origin.serialized + "\n" + shareId }

    static func shareID(_ description: String?) -> String? {
        if let identity = Self(description: description) { return identity.shareId }
        // Completions from the previous app version still refer to existing rows.
        guard let description, PhoneAskContract.matches(description, "[A-Za-z0-9_-]{16,80}") else { return nil }
        return description
    }
}

protocol ShareUploadTask: AnyObject {
    var taskDescription: String? { get }
    var originalRequest: URLRequest? { get }
    func cancel()
}
extension URLSessionTask: ShareUploadTask {}

protocol ShareResumableUpload: ShareUploadTask {
    func resume()
}
extension URLSessionUploadTask: ShareResumableUpload {}

/// Shared by the real background sessions and the fake-session regression tests.
@MainActor enum ShareUploadCancellation {
    typealias Inventory = @MainActor () async throws -> [any ShareUploadTask]

    static func cancel(origin: WorkspaceOrigin, shareIDs: Set<String> = [], inventories: [Inventory],
                       didCancel: (String) -> Void = { _ in }) async -> Bool {
        guard inventories.count == 2 else { return false }
        var clean = true
        for inventory in inventories {
            do {
                for task in try await inventory() {
                    guard belongs(task, to: origin, shareIDs: shareIDs) else { continue }
                    task.cancel()
                    if let id = ShareUploadIdentity.shareID(task.taskDescription) { didCancel(id) }
                }
            } catch { clean = false }
        }
        // cancel() only requests cancellation. Even a canceling/completed task
        // still listed here keeps the barrier until a subsequent forget attempt.
        for inventory in inventories {
            do {
                for task in try await inventory() {
                    if belongs(task, to: origin, shareIDs: shareIDs) { clean = false }
                }
            } catch { clean = false }
        }
        return clean
    }
    private static func belongs(_ task: any ShareUploadTask, to origin: WorkspaceOrigin,
                                shareIDs: Set<String>) -> Bool {
        ShareUploadIdentity(description: task.taskDescription)?.origin == origin ||
            task.taskDescription.map { shareIDs.contains($0) } == true ||
            origin.contains(task.originalRequest?.url)
    }
}
