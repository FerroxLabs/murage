#if os(iOS)
import Foundation
import MurageShellCore

/// App owns refresh after pairing/mint and on each foreground. N12 also calls
/// targetGone after a refused upload; Intents never use this fetching owner.
@MainActor
public enum PhoneShareTargets {
    public static var didRefresh: (() -> Void)?
    private static let tokens = PhoneAskTokenStore()
    private static let http = ShareTargetsHTTP()
    private static var inFlight: [WorkspaceOrigin: Task<Void, Never>] = [:]
    private static var attemptedAt: [WorkspaceOrigin: Int64] = [:]
    static func foreground() {
        PhoneAskSetup.retryRemovals()
        guard let root = ShareContainer.root, let book = WorkspaceBookStore().load() else { return }
        try? ShareWorkspaceStore(root: root).write(book)
        for workspace in book.workspaces {
            if let origin = WorkspaceOrigin(string: workspace.origin) { refresh(origin) }
        }
    }
    static func refresh(_ origin: WorkspaceOrigin, force: Bool = false) {
        guard !PhoneAskSetup.removalPending(origin), let root = ShareContainer.root, inFlight[origin] == nil else { return }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let cache = ShareTargetCache(root: root)
        guard force || (cache.needsRefresh(origin, now: now) && now - (attemptedAt[origin] ?? 0) >= 300_000) else { return }
        attemptedAt[origin] = now
        inFlight[origin] = Task { @MainActor in
            defer { inFlight[origin] = nil }
            let client = ShareTargetsClient(cache: cache, readToken: tokens.readForAsk, removeToken: tokens.remove,
                                           fetch: { origin, token in try await http.fetch(origin, token: token) })
            _ = await client.refresh(origin, now: now)
            // Empty or revoked targets must also disappear from shortcut choices.
            didRefresh?()
        }
    }
    static func targetGone(_ origin: WorkspaceOrigin) {
        if let root = ShareContainer.root { try? ShareTargetCache(root: root).remove(origin) }
        refresh(origin, force: true)
    }
    static func forget(_ origin: WorkspaceOrigin) {
        inFlight.removeValue(forKey: origin)?.cancel()
        attemptedAt[origin] = nil
        // ShareOriginRemoval deletes the cache only after arming the barrier.
        didRefresh?()
    }
}
#endif
