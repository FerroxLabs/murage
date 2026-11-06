#if os(iOS)
import Foundation
import MurageShellCore
import UIKit

/// Foreground app owner only. Extensions and intents can read a token but
/// cannot enrol a key or reach this setup screen. No bearer enters the UI.
@MainActor
final class PhoneAskSetup {
    private static let removals = PendingRemovals(defaults: .standard, root: ShareContainer.root, remove: PhoneAskTokenStore().remove)
    private let origin: WorkspaceOrigin
    private let defaults: UserDefaults
    private let signer = PhoneAskSigner.enrolled()
    private let http = PhoneJobsMintHTTP()
    private lazy var mint = PhoneJobsMintClient(signer: signer, store: PhoneAskTokenStore(), send: http.send)
    private weak var screen: UIAlertController?
    private var task: Task<Void, Never>?
    private var closed = false

    init(origin: WorkspaceOrigin, defaults: UserDefaults = .standard) {
        self.origin = origin; self.defaults = defaults
    }

    private var marker: String { "phoneAsk.setup.v1." + origin.serialized }
    private var pairing: String { signer.keyId(origin: origin) ?? "no-key" }

    func foreground(in presenter: UIViewController) {
        Self.retryRemovals()
        guard !Self.removalPending(origin) else { return }
        PhoneShareTargets.refresh(origin)
        guard !closed, task == nil, screen == nil,
              UIApplication.shared.applicationState == .active,
              UIApplication.shared.isProtectedDataAvailable,
              presenter.viewIfLoaded?.window != nil, presenter.presentedViewController == nil,
              PhoneAskSetupChoice.shouldOffer(marker: defaults.string(forKey: marker), pairing: pairing,
                  tokenReadable: (try? PhoneAskTokenStore().readForAsk(origin: origin)) != nil,
                  removalPending: Self.removalPending(origin)) else { return }
        show(in: presenter)
    }

    private func show(in presenter: UIViewController, problem: String? = nil) {
        guard !closed, UIApplication.shared.applicationState == .active,
              presenter.viewIfLoaded?.window != nil, presenter.presentedViewController == nil else { return }
        let body = PhoneJobStrings.text("ask_setup_body") + (problem.map { "\n\n" + $0 } ?? "")
        let alert = UIAlertController(title: PhoneJobStrings.text("ask_setup_title"), message: body, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: PhoneJobStrings.text("ask_not_now"), style: .cancel) { [weak self] _ in
            guard let self else { return }
            self.defaults.set(PhoneAskSetupChoice.marker(turnOn: false, pairing: self.pairing), forKey: self.marker)
        })
        alert.addAction(UIAlertAction(title: PhoneJobStrings.text("ask_turn_on"), style: .default) { [weak self, weak presenter, weak alert] _ in
            // Wait for dismissal before a synchronous no-key failure can
            // present its explanation, or before device authentication starts.
            alert?.dismiss(animated: true) { [weak self, weak presenter] in
                guard let self, let presenter else { return }
                self.turnOn(in: presenter)
            }
        })
        screen = alert
        presenter.present(alert, animated: true)
    }

    private func turnOn(in presenter: UIViewController) {
        guard !closed, task == nil, !Self.removalPending(origin), UIApplication.shared.applicationState == .active else { return }
        task = Task { @MainActor [weak self, weak presenter] in
            guard let self else { return }
            var problem: String?
            do {
                try await self.mint.mint(origin: self.origin)
                PhoneShareTargets.refresh(self.origin, force: true)
                self.defaults.set(PhoneAskSetupChoice.marker(turnOn: true, pairing: self.pairing), forKey: self.marker)
            } catch {
                if !Task.isCancelled { problem = PhoneJobStrings.text(Self.errorKey(error)) }
            }
            self.task = nil
            if let problem, let presenter { self.show(in: presenter, problem: problem) }
        }
    }

    static func errorKey(_ error: Error) -> String {
        switch error as? PhoneJobsMintError {
        case .updateComputer: return "ask_update"
        case .turnedOff: return "ask_turned_off"
        case .noApprovalKey: return "ask_no_key"
        case .refused: return "ask_computer_off"
        case .notOffered: return "ask_cloud"
        default: return "ask_setup_again"
        }
    }

    func background() {
        task?.cancel()
        screen?.dismiss(animated: false)
        screen = nil
    }

    func close() { closed = true; background(); http.close() }

    @discardableResult
    static func forget(_ origin: WorkspaceOrigin) -> Bool {
        let removed = removals.forget(origin)
        PhoneShareTargets.forget(origin)
        return removed
    }

    static func retryRemovals() { removals.retry() }
    static func removalPending(_ origin: WorkspaceOrigin) -> Bool { removals.contains(origin) }

    @MainActor
    final class PendingRemovals {
        private let defaults: UserDefaults
        private let shared: SharePendingRemovals?
        private let removal: ShareOriginRemoval?
        private let notifications: NotificationCenter
        private var observer: NSObjectProtocol?
        private static let queueKey = "phoneAsk.pendingRemovals.v1"
        private var pending: Set<String>

        init(defaults: UserDefaults, root: URL?, notifications: NotificationCenter = .default,
             cancelUploads: ShareOriginRemoval.CancelUploads? = nil,
             remove: @escaping (WorkspaceOrigin) throws -> Void) {
            self.defaults = defaults; self.notifications = notifications
            ShareOriginRemoval.log = { ShellLog.event($0, persist: true) }
            self.removal = root.map { ShareOriginRemoval(root: $0, removeToken: remove, cancelUploads: cancelUploads) }
            let shared = root.map { SharePendingRemovals(root: $0) }
            self.shared = shared
            let legacy = Set(defaults.stringArray(forKey: Self.queueKey) ?? [])
            pending = legacy.union(shared?.retryOrigins() ?? [])
            // Migrate the old app-only queue before removing its recovery copy.
            if let shared {
                do {
                    for value in legacy {
                        if let origin = WorkspaceOrigin(string: value) { try shared.set(origin, pending: true) }
                    }
                    defaults.removeObject(forKey: Self.queueKey)
                } catch { /* Retry the migration on the next app launch. */ }
            }
            observer = notifications.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification,
                                                 object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor [weak self] in self?.retry() }
            }
        }

        deinit { if let observer { notifications.removeObserver(observer) } }

        func contains(_ origin: WorkspaceOrigin) -> Bool {
            pending.contains(origin.serialized) || (shared?.contains(origin) ?? true)
        }

        @discardableResult
        func forget(_ origin: WorkspaceOrigin) -> Bool {
            // Record before touching Keychain so a locked delete survives app exit.
            pending.insert(origin.serialized)
            guard let removal else { return false }
            return removal.forget(origin, now: Int64(Date().timeIntervalSince1970 * 1000)) { [weak self] success in
                guard success, let self else { return }
                self.defaults.removeObject(forKey: "phoneAsk.setup.v1." + origin.serialized)
                self.pending.remove(origin.serialized)
            }
        }

        func retry() {
            pending.formUnion(shared?.retryOrigins() ?? [])
            for value in Array(pending) {
                if let origin = WorkspaceOrigin(string: value) { forget(origin) }
            }
        }
    }
}
#endif
