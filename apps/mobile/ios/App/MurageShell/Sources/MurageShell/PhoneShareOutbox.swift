#if os(iOS)
import Foundation
import MurageShellCore
import UIKit

@MainActor public final class PhoneShareOutbox {
    public static let shared = PhoneShareOutbox()
    public static let shortcut = "com.murage.mobile.outbox"
    static let changed = Notification.Name("murage.share.outbox.changed")
    private let sessions = ShareBackgroundSessions.shared
    private let tokens = PhoneAskTokenStore()
    private var engine: ShareOutbox?
    private var foregroundTask: Task<Void, Never>?
    private var unlockObserver: NSObjectProtocol?
    var outbox: ShareOutbox? { configure(); return engine }
    static var now: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    private init() {
        ShareOriginRemoval.log = { ShellLog.event($0, persist: true) }
        sessions.completed = { [weak self] id, status, data, error, request in
            guard let self else { return }
            let record = ShareCompletionRecord(status: status, data: data, networkError: error, at: Self.now)
            do {
                guard let outbox = self.outbox else { return }
                try outbox.receive(record, shareId: id, originalRequest: request)
            } catch { ShellLog.event("share outcome awaiting foreground") }
        }
        unlockObserver = NotificationCenter.default.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification,
                                                               object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.foreground() }
        }
    }
    deinit { if let unlockObserver { NotificationCenter.default.removeObserver(unlockObserver) } }
    private func configure() {
        guard engine == nil, let root = ShareContainer.root else { return }
        let value = ShareOutbox(root: root, session: sessions, origin: Self.origin,
            readToken: { [tokens] origin in
                guard !PhoneAskSetup.removalPending(origin) else { return nil }
                return try tokens.readForAsk(origin: origin)
            }, foregroundAllowed: {
                UIApplication.shared.applicationState == .active && UIApplication.shared.isProtectedDataAvailable
            })
        value.changed = { [weak value] in
            for origin in value?.takeGoneTargets() ?? [] { PhoneShareTargets.targetGone(origin) }
            NotificationCenter.default.post(name: Self.changed, object: nil)
        }
        engine = value
    }
    static func origin(_ workspace: String) -> WorkspaceOrigin? {
        guard let root = ShareContainer.root else { return nil }
        return ShareWorkspaceStore(root: root).read()?.workspaces.compactMap { WorkspaceOrigin(string: $0.origin) }
            .first { ShareTargetCache.workspace($0) == workspace }
    }
    public func launch() {
        if let root = ShareContainer.root { try? ShareFiles.excludeExisting(root: root) }
        configure()
        var shortcuts = UIApplication.shared.shortcutItems ?? []
        if !shortcuts.contains(where: { $0.type == Self.shortcut }) {
            shortcuts.append(UIApplicationShortcutItem(type: Self.shortcut,
                localizedTitle: PhoneJobStrings.text("share_outbox_waiting"), localizedSubtitle: nil,
                icon: UIApplicationShortcutIcon(systemImageName: "tray"), userInfo: nil))
            UIApplication.shared.shortcutItems = shortcuts
        }
    }
    public func handleEvents(identifier: String, completion: @escaping () -> Void) {
        configure()
        sessions.handleEvents(identifier: identifier, completion: completion)
    }
    public func foreground() {
        PhoneAskSetup.retryRemovals()
        guard foregroundTask == nil, UIApplication.shared.applicationState == .active else { return }
        configure()
        foregroundTask = Task { @MainActor in
            defer { foregroundTask = nil }
            guard let engine else { return }
            do {
                try await engine.foreground(now: Self.now)
            } catch { ShellLog.event("share outbox awaiting foreground") }
        }
    }
    func resend(_ state: ShareOutboxState, target: ShareOutboxState.Target? = nil) throws {
        guard let outbox else { throw ShareInputError.invalid }
        try outbox.resend(state.shareId, target: target, now: Self.now)
        foreground()
    }
}
#endif
