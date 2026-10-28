#if os(iOS)
import MurageShellCore
import UIKit

@MainActor final class ShareOutboxViewController: UITableViewController {
    private var rows: [ShareOutboxState] = []
    private var observer: NSObjectProtocol?
    private var problem: String?
    init() { super.init(style: .insetGrouped) }
    required init?(coder: NSCoder) { nil }
    override func viewDidLoad() {
        super.viewDidLoad()
        title = PhoneJobStrings.text("share_outbox_waiting")
        navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(done))
        observer = NotificationCenter.default.addObserver(forName: PhoneShareOutbox.changed, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.reload() }
        }
        reload()
        PhoneShareOutbox.shared.foreground()
    }
    override func viewWillAppear(_ animated: Bool) { super.viewWillAppear(animated); reload() }
    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
    @objc private func done() { dismiss(animated: true) }
    private func reload() {
        do { rows = try PhoneShareOutbox.shared.outbox?.entries() ?? [] }
        catch { problem = PhoneJobStrings.text("share_outbox_failed") }
        tableView.reloadData()
    }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { rows.count }
    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? { problem }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let state = rows[indexPath.row], cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        cell.textLabel?.text = PhoneJobStrings.text(ShareOutbox.messageKey(state, hasBody: hasBody(state)))
        cell.textLabel?.numberOfLines = 0
        if let origin = PhoneShareOutbox.origin(state.workspace), let root = ShareContainer.root {
            let cached = ShareTargetCache(root: root).read(origin, now: PhoneShareOutbox.now)?.targets
            let bot = cached?.bots.first { $0.id == state.target.botId }?.name
            cell.detailTextLabel?.text = [bot, WorkspaceBookStore().load()?.entry(for: origin)?.name].compactMap { $0 }.joined(separator: " · ")
        }
        let actionable = (state.state == .failed || state.state == .needsTarget) && hasBody(state)
        cell.accessoryType = actionable ? .disclosureIndicator : .none
        cell.selectionStyle = actionable ? .default : .none
        return cell
    }
    private func hasBody(_ state: ShareOutboxState) -> Bool {
        guard let body = try? PhoneShareOutbox.shared.outbox?.body(state.shareId) else { return false }
        return FileManager.default.fileExists(atPath: body.path)
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let state = rows[indexPath.row]
        guard hasBody(state) else { return }
        if state.state == .needsTarget {
            navigationController?.pushViewController(ShareRedirectViewController(state: state), animated: true)
        } else if state.state == .failed {
            do { try PhoneShareOutbox.shared.resend(state); problem = nil }
            catch { problem = PhoneJobStrings.text("share_outbox_failed") }
            reload()
        }
    }
}

@MainActor private final class ShareRedirectViewController: UITableViewController {
    private let state: ShareOutboxState
    private var choices: [(String, ShareOutboxState.Target)] = []
    private var problem: String?
    init(state: ShareOutboxState) { self.state = state; super.init(style: .insetGrouped) }
    required init?(coder: NSCoder) { nil }
    override func viewDidLoad() {
        super.viewDidLoad()
        title = PhoneJobStrings.text("share_outbox_target")
        guard let origin = PhoneShareOutbox.origin(state.workspace) else { return }
        Task { @MainActor in
            guard let root = ShareContainer.root else { return }
            let http = ShareTargetsHTTP(); defer { http.close() }
            let client = ShareTargetsClient(cache: ShareTargetCache(root: root),
                readToken: { origin in
                    guard UIApplication.shared.applicationState == .active, UIApplication.shared.isProtectedDataAvailable,
                          !PhoneAskSetup.removalPending(origin) else { return nil }
                    return try PhoneAskTokenStore().readForAsk(origin: origin)
                }, removeToken: PhoneAskTokenStore().remove, fetch: http.fetch)
            let result = await client.refresh(origin, now: PhoneShareOutbox.now)
            if case .ready(let targets) = result {
                choices = targets.bots.map { ($0.name, .init(botId: $0.id, threadId: $0.mainThreadId)) }
                choices += targets.recent.map { ($0.title, .init(botId: $0.botId, threadId: $0.threadId)) }
            } else { problem = PhoneJobStrings.text(result == .update ? "ask_update" : "ask_setup_again") }
            tableView.reloadData()
        }
    }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { choices.count }
    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? { problem }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = UITableViewCell(style: .default, reuseIdentifier: nil)
        cell.textLabel?.text = choices[indexPath.row].0
        return cell
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        do {
            try PhoneShareOutbox.shared.resend(state, target: choices[indexPath.row].1)
            navigationController?.popViewController(animated: true)
        } catch { problem = PhoneJobStrings.text("share_outbox_failed"); tableView.reloadData() }
    }
}
#endif
