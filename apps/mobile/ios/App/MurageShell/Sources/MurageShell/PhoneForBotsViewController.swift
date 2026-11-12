#if os(iOS)
import UIKit
import MurageShellCore

/// Both sheets are native. N4 presents make(providerName:) using the offer's name,
/// and records its ID only after Allow. Not now belongs to N4's decline path.
@MainActor enum PhoneDataSharingSheet {
    static func make(providerName: String? = nil, workspaceName: String? = nil, answer: @escaping (Bool) -> Void) -> UIAlertController {
        let sheet = UIAlertController(title: PhoneJobStrings.text("phone_sharing_title"),
            message: PhoneDataSharingText.message(providerName: providerName, workspaceName: workspaceName), preferredStyle: .alert)
        sheet.addAction(UIAlertAction(title: PhoneJobStrings.text("phone_job_not_now"), style: .cancel) { _ in answer(false) })
        sheet.addAction(UIAlertAction(title: PhoneJobStrings.text("phone_job_allow"), style: .default) { _ in answer(true) })
        return sheet
    }
}

/// Owned by the workspace, so lifecycle registration continues after dismissal.
@MainActor final class PhoneForBotsSession {
    let permissions = PhonePermissions()
    let store = PhoneConsentStore()
    let tokens = PhoneJobsTokenStore()
    let http = PhoneJobsMintHTTP()
    let origin: WorkspaceOrigin
    private lazy var signer = PhoneJobsSigner.enrolled()
    private lazy var mint = PhoneJobsMintClient(signer: signer, store: tokens, send: http.send)
    lazy var model = PhoneForBotsModel(workspace: origin, store: store,
        token: { [unowned self] in try tokens.readForRunner(origin: origin) },
        removeToken: { [unowned self] in try tokens.remove(origin: origin) },
        mint: { [unowned self] in try await mint.mint(origin: origin) },
        available: { [unowned self] in try await checkAvailability() },
        permission: { [unowned self] in permissions.value($0) },
        requestPermission: { [unowned self] in await permissions.request($0) },
        metadata: {
            ["name": String(UIDevice.current.name.prefix(80)), "platform": "ios",
             "osVersion": UIDevice.current.systemVersion,
             "appVersion": String((Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.9").prefix(40)),
             "timeZone": TimeZone.current.identifier]
        }, send: { [unowned self] method, token, body in
            let status = await PhoneJobServices.shared.runner.registration(workspace: origin, method: method, token: token, body: body)
            guard status == 200 else { throw PhoneJobsMintError.unavailable }
        })
    init(origin: WorkspaceOrigin) { self.origin = origin }
    func checkAvailability() async throws {
        guard signer.keyId(origin: origin) != nil else { throw PhoneJobsMintError.noApprovalKey }
        let verdict = await ProbeClient.probe(origin, userAgent: ShellEnvironment.userAgentToken)
        guard verdict.phoneJobsOk else {
            throw verdict.phoneFlagsOk ? PhoneJobsMintError.turnedOff : PhoneJobsMintError.updateComputer
        }
    }
    func refresh() { Task { try? await model.refresh() } }

    /// The bot the legacy-phone line names, resolved by `loadRePairBot` (cached targets, else the targets load).
    private var rePairBot: String?
    /// Resolves the bot name through the same targets load the share sheet uses, so the line does not depend on a cached roster.
    func loadRePairBot() async {
        guard let root = ShareContainer.root else { return }
        let origin = origin
        let targetsHTTP = ShareTargetsHTTP(); defer { targetsHTTP.close() }
        let client = ShareTargetsClient(cache: ShareTargetCache(root: root),
            readToken: { origin in
                guard UIApplication.shared.applicationState == .active, UIApplication.shared.isProtectedDataAvailable,
                      !PhoneAskSetup.removalPending(origin) else { return nil }
                return try PhoneAskTokenStore().readForAsk(origin: origin)
            }, removeToken: PhoneAskTokenStore().remove, fetch: targetsHTTP.fetch)
        rePairBot = await AskRePairHintBot.name(origin: origin, client: client, now: Int64(Date().timeIntervalSince1970 * 1000))
    }
    /// The legacy-phone line (D8): no device id pinned for this pairing and not dismissed.
    private var rePairState: (keyId: String, text: String)? {
        guard let bot = rePairBot else { return nil }
        let defaults = UserDefaults(suiteName: ShareContainer.group)
        let keyId = PhoneAskSigner.enrolled().keyId(origin: origin)
        let hint = AskRePairHint(defaults: defaults)
        guard hint.visible(origin: origin, keyId: keyId, asking: (try? PhoneAskTokenStore().readForAsk(origin: origin)) != nil,
                           pin: AskDevicePin(defaults: defaults)), let keyId else { return nil }
        return (keyId, hint.text(botName: bot))
    }
    var rePairText: String? { rePairState?.text }
    func dismissRePair() {
        if let state = rePairState { AskRePairHint(defaults: UserDefaults(suiteName: ShareContainer.group)).dismiss(origin: origin, keyId: state.keyId) }
    }
    func close() { http.close() }
}

@MainActor final class PhoneForBotsViewController: UITableViewController {
    private let session: PhoneForBotsSession
    private let rows = ["master", "calendar", "reminders", "contacts", "location", "precise", "alarms", "messages", "calls"]
    private var status: String?
    private var working = false
    private var observer: NSObjectProtocol?
    private var stateObserver: NSObjectProtocol?
    init(session: PhoneForBotsSession) { self.session = session; super.init(style: .insetGrouped) }
    required init?(coder: NSCoder) { nil }
    override func viewDidLoad() {
        super.viewDidLoad()
        title = PhoneJobStrings.text("phone_for_bots")
        navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(done))
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: PhoneJobStrings.text("share_outbox_waiting"),
            style: .plain, target: self, action: #selector(openOutbox))
        observer = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.reload() }
        }
        stateObserver = NotificationCenter.default.addObserver(forName: .phoneJobsStateChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.reload() }
        }
        Task {
            do { try await session.checkAvailability(); _ = try session.model.state() }
            catch { status = (error as? PhoneJobsMintError)?.errorDescription ?? PhoneJobStrings.text("phone_failed") }
            reload()
            await session.loadRePairBot()
            reload()
        }
    }
    private func reload() { updateRePairHint(); tableView.reloadData() }
    /// One plain, dismissible line above the rows for a phone that has no pinned device id.
    private var hintWidth: CGFloat = 0
    /// The header is laid out by hand, so it is laid out again when the width (rotation, split view) or the text size changes.
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if tableView.tableHeaderView != nil, tableView.bounds.width != hintWidth { updateRePairHint() }
    }
    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        if previous?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory { updateRePairHint() }
    }
    private func updateRePairHint() {
        guard let text = session.rePairText else { tableView.tableHeaderView = nil; return }
        let width = tableView.bounds.width
        hintWidth = width
        let label = UILabel()
        label.text = text
        label.numberOfLines = 0
        label.font = .preferredFont(forTextStyle: .footnote)
        label.textColor = .secondaryLabel
        let dismiss = UIButton(type: .system)
        dismiss.setTitle(PhoneJobStrings.text("ask_ok"), for: .normal)
        dismiss.addTarget(self, action: #selector(dismissRePair), for: .touchUpInside)
        dismiss.sizeToFit()
        let inset: CGFloat = 20
        let textWidth = max(0, width - inset * 2 - dismiss.bounds.width - 8)
        let height = max(44, ceil(label.sizeThatFits(CGSize(width: textWidth, height: .greatestFiniteMagnitude)).height) + 16)
        let header = UIView(frame: CGRect(x: 0, y: 0, width: width, height: height))
        label.frame = CGRect(x: inset, y: 8, width: textWidth, height: height - 16)
        dismiss.frame = CGRect(x: width - inset - dismiss.bounds.width, y: (height - dismiss.bounds.height) / 2,
                               width: dismiss.bounds.width, height: dismiss.bounds.height)
        dismiss.accessibilityLabel = text
        header.addSubview(label)
        header.addSubview(dismiss)
        tableView.tableHeaderView = header
    }
    @objc private func dismissRePair() { session.dismissRePair(); reload() }
    deinit { if let observer { NotificationCenter.default.removeObserver(observer) }; if let stateObserver { NotificationCenter.default.removeObserver(stateObserver) } }
    @objc private func openSettings() { UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) }
    @objc private func done() { dismiss(animated: true) }
    @objc private func openOutbox() { navigationController?.pushViewController(ShareOutboxViewController(), animated: true) }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { rows.count }
    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? { status }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let row = rows[indexPath.row]
        let consent = (try? session.model.state()) ?? PhoneConsent()
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        cell.textLabel?.text = PhoneJobStrings.text(row == "master" ? "phone_for_bots" : "phone_" + row)
        let toggle = UISwitch()
        toggle.tag = indexPath.row
        toggle.isOn = row == "master" ? consent.enabled : consent.rows.contains(row)
        toggle.isEnabled = !working && (row == "master" || consent.enabled)
        toggle.accessibilityLabel = cell.textLabel?.text
        toggle.addTarget(self, action: #selector(changed(_:)), for: .valueChanged)
        cell.accessoryView = toggle
        if row != "master", consent.rows.contains(row), session.permissions.value(row) == nil {
            let settings = UIButton(type: .system)
            settings.setTitle(PhoneJobStrings.text("phone_settings"), for: .normal)
            settings.addTarget(self, action: #selector(openSettings), for: .touchUpInside)
            settings.sizeToFit()
            let controls = UIStackView(arrangedSubviews: [settings, toggle])
            controls.spacing = 8
            controls.frame.size = CGSize(width: settings.bounds.width + toggle.intrinsicContentSize.width + 8,
                                         height: max(44, toggle.intrinsicContentSize.height))
            cell.accessoryView = controls
        }
        return cell
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let row = rows[indexPath.row]
        guard row != "master", (try? session.model.state().rows.contains(row)) == true,
              session.permissions.value(row) == nil else { return }
        UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!)
    }
    @objc private func changed(_ toggle: UISwitch) {
        let row = rows[toggle.tag], on = toggle.isOn
        working = true
        isModalInPresentation = true
        navigationController?.isModalInPresentation = true
        navigationItem.rightBarButtonItem?.isEnabled = false
        tableView.reloadData()
        Task {
            do {
                if row == "master" {
                    try await session.model.setMaster(on) {
                        await withCheckedContinuation { answer in
                            var presenter: UIViewController = self
                            while let top = presenter.presentedViewController { presenter = top }
                            guard !presenter.isBeingDismissed, !presenter.isBeingPresented,
                                  presenter.viewIfLoaded?.window != nil else { answer.resume(returning: false); return }
                            var answered = false
                            let finish: (Bool) -> Void = { value in
                                guard !answered else { return }; answered = true; answer.resume(returning: value)
                            }
                            let sheet = PhoneDataSharingSheet.make(answer: finish)
                            presenter.present(sheet, animated: false)
                            if sheet.presentingViewController == nil { finish(false) }
                        }
                    }
                } else { try await session.model.setRow(row, on: on) }
                status = nil
            } catch { status = (error as? PhoneJobsMintError)?.errorDescription ?? PhoneJobStrings.text("phone_failed") }
            working = false
            isModalInPresentation = false
            navigationController?.isModalInPresentation = false
            navigationItem.rightBarButtonItem?.isEnabled = true
            tableView.reloadData()
        }
    }
}
#endif
