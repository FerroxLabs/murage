#if os(iOS)
import UIKit
import UserNotifications
import MurageShellCore

@MainActor public protocol PushChannel: AnyObject {
    func registerPush(origin: WorkspaceOrigin, fresh: Bool) async -> Result<[String: Any], ChannelError>
    func pushStatus(origin: WorkspaceOrigin) async -> [String: Any]
    func issuePushTokens(origin: WorkspaceOrigin, tokens: IssuedTokens) -> Bool
    func setBadgeCount(origin: WorkspaceOrigin, count: Int)
}

/// The app's push state (spec §3.5): the ledger in the App Group, the tokens
/// in the Keychain, and the app badge as the sum over workspaces.
@MainActor public final class PushServices: PushChannel {
    public static let shared = PushServices()
    public let ledger = FileLedgerAccess(appGroup: Bundle.main.object(forInfoDictionaryKey: "MurageAppGroup") as? String ?? "group.com.murage.mobile")
    /// Relay DELETEs owed (B4): written before a binding is discarded locally,
    /// retried on activation and when connectivity returns.
    public let deletions = FileDeletionQueue(appGroup: Bundle.main.object(forInfoDictionaryKey: "MurageAppGroup") as? String ?? "group.com.murage.mobile")
    private lazy var bindings = PushBindings(ledger: ledger, secrets: KeychainPushSecrets(), owed: deletions)

    private init() { onForget = { PushRegistrar.shared.deleteAtRelay($0) } }

    public func registerPush(origin: WorkspaceOrigin, fresh: Bool) async -> Result<[String: Any], ChannelError> {
        await PushRegistrar.shared.register(origin: origin, fresh: fresh)
    }

    public func pushStatus(origin: WorkspaceOrigin) async -> [String: Any] {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let permission: String = switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: "granted"
        case .denied: "denied"
        default: "undetermined"
        }
        let enrolled = bindings.enrolled(origin: origin.serialized)
        var status: [String: Any] = ["permission": permission, "enrolled": enrolled]
        if let expiresAt = bindings.expiresAt(origin: origin.serialized) { status["expiresAt"] = expiresAt }
        return status
    }

    /// Only for the binding this workspace already holds (registerPush made
    /// it), or for the one a pending replace was waiting on (adopt, which
    /// moves the ledger first). A refused respond write keeps the old pair;
    /// a detail is never stored without its respond (PushBindings.issue).
    public func issuePushTokens(origin: WorkspaceOrigin, tokens: IssuedTokens) -> Bool {
        PushRegistrar.shared.adopt(origin: origin, bindingId: tokens.bindingId)
        return bindings.issue(origin: origin.serialized, tokens: tokens)
    }

    public func setBadgeCount(origin: WorkspaceOrigin, count: Int) {
        guard let total = ledger.update({ l -> Int? in
            guard let binding = l.binding(origin: origin.serialized) else { return nil }
            l.setBadge(binding, count: count)
            return l.total
        }) ?? nil else { return }
        UNUserNotificationCenter.current().setBadgeCount(total)
    }

    /// Signing out or removing a computer (ShellCoordinator.forget): its
    /// binding, its tokens and its count go. The tokens go even when the
    /// ledger cannot be saved; the next open's sweep finishes the ledger.
    public func forget(_ origin: WorkspaceOrigin) { forget(serialized: origin.serialized) }

    func forget(serialized origin: String) {
        PushRegistrar.shared.cancelPending(origin: origin)
        let out = bindings.forget(origin: origin)
        if !out.saved { ShellLog.event("push forget deferred") }
        guard let removed = out.bindingId else { return }
        if let total = ledger.read()?.total { UNUserNotificationCenter.current().setBadgeCount(total) }
        clearDelivered(of: [removed])
        onForget?(removed)
    }

    /// On app open, once the saved computers read (ShellCoordinator.launchIfNeeded):
    /// bindings for computers no longer saved are dropped, with their tokens,
    /// and so are token items no binding owns. Each dropped binding goes to
    /// `onForget`, as a forgotten one does, and so does the binding id of
    /// every orphaned token item.
    public func sweep(knownOrigins: Set<String>) {
        let out = bindings.sweep(knownOrigins: knownOrigins)
        if !out.saved { ShellLog.event("push sweep deferred") }
        (out.dropped + out.orphans).forEach { onForget?($0) }
        clearDelivered(of: Set(out.dropped + out.orphans))
        guard !out.dropped.isEmpty else { return }
        if let total = ledger.read()?.total { UNUserNotificationCenter.current().setBadgeCount(total) }
    }

    /// A dropped binding's notifications go with it (Android: PushReconciler.cancelFor):
    /// its tokens are gone, so a tap or an action on one could only fail.
    private func clearDelivered(of dropped: Set<String>) {
        guard !dropped.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        Task {
            let delivered = await center.deliveredNotifications().map {
                PushResponse.Delivered(identifier: $0.request.identifier, userInfo: $0.request.content.userInfo)
            }
            let remove = PushResponse.delivered(delivered, of: dropped)
            if !remove.isEmpty { center.removeDeliveredNotifications(withIdentifiers: remove) }
        }
    }

    /// The relay-delete seam: set in init to delete the binding at the relay.
    /// Called with the binding id by `forget` and by `sweep`.
    public var onForget: ((String) -> Void)?
}

/// What the app delegate calls; the app target sees only public API.
@MainActor public enum PushSetup {
    public static func launch() {
        UNUserNotificationCenter.current().delegate = PushResponder.shared   // before launch returns (I5)
        PushCategories.install()
        if UIApplication.shared.isRegisteredForRemoteNotifications { UIApplication.shared.registerForRemoteNotifications() }
    }
    public static func didRegister(deviceToken: Data) { PushRegistrar.shared.didRegister(deviceToken: deviceToken) }
    public static func didFail() { PushRegistrar.shared.didFail() }
    /// Spec §3.5 "Badge and reconciliation": every time the app comes to the front.
    public static func becameActive() {
        Task { await PushResponder.shared.reconcile() }
        PushRegistrar.shared.drainDeletions()   // B4
        PushRegistrar.shared.refreshIfDue()     // the relay sweeps registrations idle for 30 days
    }
}
#endif
