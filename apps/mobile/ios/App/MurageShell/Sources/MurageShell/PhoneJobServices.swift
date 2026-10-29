#if os(iOS)
import UIKit
import MurageShellCore

/// App-owned singleton. The extension and page bridge never import this service.
@MainActor final class PhoneJobServices {
    static let shared = PhoneJobServices()
    private init() {
        cleanup.firstInstall(defaults: .standard, origins: PhoneJobsTokenStore.savedOrigins)
    }
    private var ledgers: [WorkspaceOrigin: PhoneLedgerFile] = [:]
    private lazy var cleanup = PhoneJobsCleanup(token: { [unowned self] in try tokens.readForRunner(origin: $0) },
        removeToken: { [unowned self] in try tokens.remove(origin: $0) },
        removeConsent: { [unowned self] in try store.remove(workspace: $0) },
        clearLedger: { [unowned self] workspace in
            let storage = ledgers.removeValue(forKey: workspace) ?? PhoneLedgerFile(workspace: workspace)
            try storage.clear()
        }, unregister: { [unowned self] request in
            Task { _ = try? await self.http.send(request) }
        })
    func forget(_ workspace: WorkspaceOrigin) {
        executors.forget(workspace)
        cleanup.forget(workspace)
        Task { await runner.forget(workspace) }
    }
    private let store = PhoneConsentStore(), tokens = PhoneJobsTokenStore(), permissions = PhonePermissions()
    private let http = PhoneJobHTTP()
    private weak var host: WorkspaceViewController?
    lazy var cards = NativePhoneJobCards(enabledWorkspaces: { [unowned self] in
        (WorkspaceBookStore().load()?.workspaces ?? []).filter {
            guard let origin = WorkspaceOrigin(string: $0.origin) else { return false }
            return (try? self.store.read(workspace: origin).enabled) == true
        }.count
    }, onScreen: { [weak self] in self?.host?.origin }, deferUsed: { [weak self] closed in self?.messageComposer.whenClosed(closed) ?? false }, present: { [weak self] workspace, card in
        guard let self, self.visible, !self.messageComposer.isComposing, UIApplication.shared.applicationState != .background,
              let host = self.host, PhoneJobPresentation.matches(workspace, host.origin) else { return false }
        return host.presentPhoneJobCard(card)
    })
    private lazy var messageComposer = SystemMessageComposer(host: { [weak self] in
        guard let self, self.visible else { return nil }; return self.host
    })
    private lazy var executors = WorkspacePhoneExecutors { [unowned self] in makeExecutors($0) }
    private func makeExecutors(_ workspace: WorkspaceOrigin) -> NativePhoneJobExecutors? {
        guard (try? tokens.readForRunner(origin: workspace)) != nil,
              (try? store.read(workspace: workspace).enabled) == true else { return nil }
        let storage = ledgers[workspace] ?? PhoneLedgerFile(workspace: workspace)
        ledgers[workspace] = storage
        let ledger = PhoneOperationLedger(storage: storage)
        return NativePhoneJobExecutors(modules: [
            "calendar": PhoneCalendarExecutor(os: EventKitCalendarAccess(), ledger: ledger),
            "reminders": PhoneRemindersExecutor(os: EventKitRemindersAccess(), ledger: ledger),
            "contacts": PhoneContactsExecutor(os: ContactsStoreAccess()),
            "location": PhoneLocationExecutor(os: CoreLocationAccess()),
            "alarms": PhoneAlarmsExecutor(os: AlarmKitAccess(), ledger: ledger),
            "messages": PhoneMessagesExecutor(os: messageComposer),
            "calls": PhoneCallsExecutor(os: SystemPhoneDialer())
        ], foreground: { [weak self] in self?.visible == true && UIApplication.shared.applicationState != .background })
    }
    private var visible = false
    lazy var runner = PhoneJobRunner(environment: .init(
        token: { [unowned self] in try? tokens.readForRunner(origin: $0) },
        enabled: { [unowned self] in UserDefaults.standard.bool(forKey: "phoneJobs.install.v1") && (try? store.read(workspace: $0).enabled) == true },
        needsProvider: { [unowned self] in (try? store.needsProviderSheet(workspace: $0, providerId: $1)) ?? true },
        recordProvider: { [unowned self] workspace, provider in
            do { try store.recordProviderConsent(workspace: workspace, providerId: provider); return true } catch { return false }
        }, consent: { [unowned self] workspace, offer in
            return (try? store.readForCommit(workspace: workspace, providerId: offer.provider.id, capability: offer.capability)) == true
        }, permission: { [unowned self] offer in
            guard visible, let value = permissions.value(offer.capability) else { return false }
            if offer.capability == "calendar", offer.action != "calendar.add" { return value as? String == "full" }
            return true
        }, turnOff: { [unowned self] workspace in
            try? tokens.remove(origin: workspace)
            if var c = try? store.read(workspace: workspace) { c.enabled = false; try? store.write(c, workspace: workspace) }
            NotificationCenter.default.post(name: .phoneJobsStateChanged, object: nil)
        }, preciseConsent: { [unowned self] in (try? store.read(workspace: $0).rows.contains("precise")) == true }),
        cards: cards, executors: executors, send: http.send)

    func attach(_ host: WorkspaceViewController) {
        cleanup.firstInstall(defaults: .standard, origins: PhoneJobsTokenStore.savedOrigins)
        if let previous = self.host, previous !== host { backgrounded() }
        self.host = host
        if UIApplication.shared.applicationState != .background { becameVisible() }
    }
    func detach(_ host: WorkspaceViewController) {
        guard self.host === host else { return }
        backgrounded(); self.host = nil
    }
    func becameVisible() {
        guard host != nil else { return }
        visible = true
        let origins = Set((WorkspaceBookStore().load()?.workspaces ?? []).compactMap { WorkspaceOrigin(string: $0.origin) })
        Task { await runner.start(workspaces: origins, visible: visible) }
    }
    func backgrounded() {
        visible = false
        // Close presentation synchronously; actor responses are separately fenced.
        cards.dismissAll()
        Task { await runner.stop() }
    }
    func open(workspace: WorkspaceOrigin, eventRef: String) {
        Task { await runner.open(workspace: workspace, eventRef: eventRef) }
    }
}
@MainActor private final class WorkspacePhoneExecutors: PhoneJobExecutorRegistry {
    let make: (WorkspaceOrigin) -> NativePhoneJobExecutors?
    var active: NativePhoneJobExecutors?
    private var workspace: WorkspaceOrigin?
    private var cancellation: PhoneJobCancellation?
    func forget(_ workspace: WorkspaceOrigin) {
        if self.workspace == workspace { cancellation?.cancel() }
    }
    init(make: @escaping (WorkspaceOrigin) -> NativePhoneJobExecutors?) { self.make = make }
    func cancel() async { await active?.cancel() }
    func run(operationId: String, capability: String, action: String, args: PhoneJobsContract.Args, preciseConsent: Bool, cancellation: PhoneJobCancellation) async -> PhoneJobExecution { .error(code: "denied") }
    func run(workspace: WorkspaceOrigin, operationId: String, capability: String, action: String, args: PhoneJobsContract.Args, preciseConsent: Bool, cancellation: PhoneJobCancellation) async -> PhoneJobExecution {
        guard let executor = make(workspace) else { return .error(code: "denied") }
        active = executor; self.workspace = workspace; self.cancellation = cancellation
        let result = await executor.run(operationId: operationId, capability: capability, action: action, args: args, preciseConsent: preciseConsent, cancellation: cancellation)
        active = nil; self.workspace = nil; self.cancellation = nil
        return result
    }
}
extension Notification.Name { static let phoneJobsStateChanged = Notification.Name("MuragePhoneJobsStateChanged") }

#endif
