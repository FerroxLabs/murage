#if os(iOS)
import CryptoKit
import DeviceCheck
import Network
import UIKit
import UserNotifications
import MurageShellCore

/// Spec §3.5 "Enrolment", phone side: the UIKit, DeviceCheck and
/// UserNotifications glue around PushEnrolment (MurageShellCore), which
/// holds the flow and its tests.
@MainActor final class PushRegistrar {
    static let shared = PushRegistrar()
    private let platform = Platform()
    private lazy var enrolment: PushEnrolment = {
        let enrolment = PushEnrolment(
            transport: RelayClient(), attester: AppAttester(), secrets: KeychainPushSecrets(), ledger: PushServices.shared.ledger,
            platform: platform, environment: RelayConfig.environment, forget: { PushServices.shared.forget(serialized: $0) },
            deletions: PushServices.shared.deletions)
        watchConnectivity()
        #if DEBUG
        enrolment.onDecision = { ShellLog.pushPlan($0) }
        #endif
        return enrolment
    }()

    /// B4: a relay DELETE owed from while the phone was offline goes the moment
    /// a network comes back, not only the next time the app is opened.
    private var monitor: NWPathMonitor?
    private func watchConnectivity() {
        guard monitor == nil else { return }
        let m = NWPathMonitor()
        m.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in self?.drainDeletions() }
        }
        m.start(queue: DispatchQueue(label: "com.murage.push.connectivity"))
        monitor = m
    }

    /// Retries the relay deletions owed; a no-op when none are.
    func drainDeletions() {
        guard !PushServices.shared.deletions.ids().isEmpty else { return }
        Task { await enrolment.drainDeletions() }
    }

    /// Every time the app comes to the front: refreshes the relay registration
    /// at most once every 24 hours (PushRefresher), so a quiet pairing is not
    /// swept as idle. Best effort: it is a detached task, a failure backs off,
    /// and nothing here is logged but the outcome.
    func refreshIfDue() {
        Task { await refresher.foreground() }
    }
    private lazy var refresher = PushRefresher(store: DefaultsRefreshStore(), run: { [weak self] in
        guard let self else { return .skipped }
        let out = await self.enrolment.refresh()
        if out == .failed { ShellLog.event("push refresh deferred") }
        return out
    })

    func didRegister(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        platform.received(token)
        Task { await enrolment.tokenChanged(token) }
    }
    func didFail() {
        ShellLog.event("push token refused")
        platform.received(nil)
    }

    /// The ledger holds origins in the book's form (I3's review), so the
    /// extension can find this computer from a binding id.
    func register(origin: WorkspaceOrigin, fresh: Bool) async -> Result<[String: Any], ChannelError> {
        await enrolment.register(origin: origin.serialized, fresh: fresh).reply
    }

    /// PushServices.issuePushTokens, before the tokens are stored: a pending
    /// replace the host just took retires the old binding and moves the ledger.
    func adopt(origin: WorkspaceOrigin, bindingId: String) {
        enrolment.adopt(origin: origin.serialized, bindingId: bindingId)
    }

    /// PushServices.forget: a forgotten workspace's pending replace goes too.
    func cancelPending(origin: String) {
        enrolment.cancelPending(origin: origin)
    }

    /// PushResponder.reconcile: the bindings a pending replace waits on.
    var pendingBindingIds: Set<String> { enrolment.pendingBindingIds }

    /// PushServices.onForget.
    func deleteAtRelay(_ bindingId: String) {
        Task { await enrolment.deleteAtRelay(bindingId) }
    }

    /// The last-success stamp and the backoff, in UserDefaults: not secret.
    private final class DefaultsRefreshStore: PushRefreshStore {
        private let defaults = UserDefaults.standard
        var record: PushRefreshRecord {
            get {
                PushRefreshRecord(lastSuccess: defaults.double(forKey: "murage.push.refresh.ok"),
                                  failures: defaults.integer(forKey: "murage.push.refresh.failures"),
                                  retryAt: defaults.double(forKey: "murage.push.refresh.retryAt"))
            }
            set {
                defaults.set(newValue.lastSuccess, forKey: "murage.push.refresh.ok")
                defaults.set(newValue.failures, forKey: "murage.push.refresh.failures")
                defaults.set(newValue.retryAt, forKey: "murage.push.refresh.retryAt")
            }
        }
    }

    @MainActor private final class Platform: PushPlatform {
        private var apnsToken: String?
        private var waiting: [UUID: CheckedContinuation<String?, Never>] = [:]

        func received(_ token: String?) {
            if let token { apnsToken = token }
            waiting.values.forEach { $0.resume(returning: token) }
            waiting = [:]
        }

        func notificationPermission() async -> String {
            let center = UNUserNotificationCenter.current()
            var settings = await center.notificationSettings()
            if settings.authorizationStatus == .notDetermined {
                _ = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
                settings = await center.notificationSettings()
            }
            return switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral: "granted"
            default: "denied"
            }
        }

        func pushToken() async -> String? {
            if let apnsToken { return apnsToken }
            UIApplication.shared.registerForRemoteNotifications()
            let id = UUID()
            return await withCheckedContinuation { continuation in
                waiting[id] = continuation
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(10))
                    waiting.removeValue(forKey: id)?.resume(returning: nil)
                }
            }
        }
    }
}

/// App Attest: a new key per attestation, over SHA256(utf8(nonce)). Shared by push
/// registration and the pairing-time approval statement.
final class AppAttester: PushAttester {
    var isSupported: Bool { DCAppAttestService.shared.isSupported }
    func attest(challenge: String) async -> (keyId: String, attestationObject: String)? {
        let service = DCAppAttestService.shared
        do {
            let keyId = try await service.generateKey()
            // The relay checks nonce = SHA256(authData || SHA256(utf8(challenge))). At pairing, "challenge" is the binding nonce.
            let clientDataHash = Data(SHA256.hash(data: Data(challenge.utf8)))
            let attestation = try await service.attestKey(keyId, clientDataHash: clientDataHash)
            return (keyId, attestation.base64EncodedString())
        } catch {
            ShellLog.event("app attest failed")
            return nil
        }
    }
}

#endif
