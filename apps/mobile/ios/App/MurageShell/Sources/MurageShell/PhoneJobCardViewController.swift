#if os(iOS)
import UIKit
import EventKit
import MurageShellCore

/// UIKit owns every label and action; no card content enters the page channel.
@MainActor final class PhoneJobCardViewController: UIViewController {
    private(set) var model: PhoneJobCardModel
    private let stack = UIStackView()
    private(set) var labels: [UILabel] = []
    private(set) var allowButton: UIButton?
    private(set) var notNowButton: UIButton?

    init(model: PhoneJobCardModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        isModalInPresentation = true
        sheetPresentationController?.detents = [.medium(), .large()]
    }
    required init?(coder: NSCoder) { nil }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        stack.axis = .vertical; stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48)
        ])
        render()
    }
    func replace(with model: PhoneJobCardModel) {
        self.model.dismiss(); self.model = model
        if isViewLoaded { render() }
    }
    func render() {
        let displayed = model
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        labels = []; allowButton = nil; notNowButton = nil
        switch model.state {
        case .offer, .waiting:
            label(model.bot, style: .title2)
            label(PhoneJobStrings.capability(model.capability), style: .headline)
            if let workspace = model.workspace { label(workspace, style: .subheadline) }
            label(model.say, style: .body)
            for destination in model.destinations { label(destination, style: .body) }
            for detail in model.details { label(detail, style: .body) }
            allowButton = button("phone_job_allow") { [weak self] in self?.choose(true, displayed: displayed) }
            notNowButton = button("phone_job_not_now") { [weak self] in self?.choose(false, displayed: displayed) }
            allowButton?.isEnabled = model.state == .offer
            notNowButton?.isEnabled = model.state == .offer
        case .used:
            label(PhoneJobStrings.used(bot: model.bot, capability: model.capability), style: .footnote)
            if let workspace = model.workspace { label(workspace, style: .subheadline) }
            _ = button("phone_job_done") { displayed.close() }
        case .handled:
            label(PhoneJobStrings.text("phone_job_handled"), style: .headline)
            _ = button("phone_job_done") { displayed.close() }
        case .dismissed: break
        }
    }
    private func choose(_ allow: Bool, displayed: PhoneJobCardModel) {
        guard model === displayed else { return }
        model.choose(allow); render()
    }
    private func label(_ text: String, style: UIFont.TextStyle) {
        let label = UILabel()
        label.text = text // Plain text, never attributed HTML or Markdown.
        label.font = .preferredFont(forTextStyle: style)
        label.adjustsFontForContentSizeCategory = true; label.numberOfLines = 0
        if style == .footnote { label.textColor = .secondaryLabel }
        labels.append(label); stack.addArrangedSubview(label)
    }
    private func button(_ key: String, action: @escaping () -> Void) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(PhoneJobStrings.text(key), for: .normal)
        button.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        button.titleLabel?.adjustsFontForContentSizeCategory = true
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        button.addAction(UIAction { _ in action() }, for: .touchUpInside)
        stack.addArrangedSubview(button)
        return button
    }
}

@MainActor final class NativePhoneJobCards: PhoneJobCardPresenter {
    private let present: (WorkspaceOrigin, UIViewController) -> Bool
    private let onScreen: () -> WorkspaceOrigin?
    private let enabledWorkspaces: () -> Int
    private let deferUsed: (@escaping () -> Void) -> Bool
    private var sheet: UIViewController?
    private var model: PhoneJobCardModel?
    private var workspace: WorkspaceOrigin?
    private var operationId: String?

    init(enabledWorkspaces: @escaping () -> Int, onScreen: @escaping () -> WorkspaceOrigin?, deferUsed: @escaping (@escaping () -> Void) -> Bool = { _ in false },
         present: @escaping (WorkspaceOrigin, UIViewController) -> Bool) {
        self.onScreen = onScreen; self.enabledWorkspaces = enabledWorkspaces; self.present = present; self.deferUsed = deferUsed
    }
    func canPresent(workspace: WorkspaceOrigin) -> Bool { PhoneJobPresentation.matches(workspace, onScreen()) }
    func show(workspace: WorkspaceOrigin, offer: PhoneJobsContract.Offer, answer: @escaping (Bool) -> Void) {
        display(PhoneJobCardModel(offer: offer, enabledWorkspaces: enabledWorkspaces(), offscreen: !PhoneJobPresentation.matches(workspace, onScreen()), answer: answer),
                workspace: workspace, operationId: offer.operationId)
    }
    func show(workspace: WorkspaceOrigin, offer: PhoneJobsContract.Offer, args: PhoneJobsContract.Args, answer: @escaping (Bool) -> Void, failed: @escaping () -> Void) {
        let store = EKEventStore()
        var title: String?
        switch args {
        case .calendarChange(let a):
            guard EKEventStore.authorizationStatus(for: .event) == .fullAccess,
                  let event = store.event(withIdentifier: a.id) ?? (store.calendarItem(withIdentifier: a.id) as? EKEvent) else { failed(); return }
            title = event.title ?? ""
        case .remindersComplete(let a):
            guard EKEventStore.authorizationStatus(for: .reminder) == .fullAccess,
                  let reminder = store.calendarItem(withIdentifier: a.id) as? EKReminder else { failed(); return }
            title = reminder.title ?? ""
        default: break
        }
        let model = PhoneJobCardModel(offer: offer, args: args, currentTitle: title, enabledWorkspaces: enabledWorkspaces(), answer: answer)
        if !display(model, workspace: workspace, operationId: offer.operationId) { failed() }
    }
    func showProvider(workspace: WorkspaceOrigin, provider: PhoneJobsContract.NamedParty, workspaceName: String, answer: @escaping (Bool) -> Void) {
        showProvider(workspace: workspace, provider: provider, workspaceName: workspaceName, answer: answer, failed: {})
    }
    func showProvider(workspace: WorkspaceOrigin, provider: PhoneJobsContract.NamedParty, workspaceName: String, answer: @escaping (Bool) -> Void, failed: @escaping () -> Void) {
        guard PhoneJobPresentation.matches(workspace, onScreen()) else { failed(); return }
        dismissAll(); self.workspace = workspace
        let gate = PhoneJobCardModel(bot: "", capability: "", say: "", workspace: "", enabledWorkspaces: 1, answer: answer)
        model = gate
        let sheet = PhoneDataSharingSheet.make(providerName: provider.name, workspaceName: workspaceName) { [weak self, weak gate] allow in
            guard let self, let gate, self.model === gate else { return }
            self.sheet = nil; self.model = nil; self.workspace = nil
            gate.choose(allow); gate.dismiss()
        }
        self.sheet = sheet
        if !present(workspace, sheet) { dismissAll(); failed() }
    }
    func used(workspace: WorkspaceOrigin, offer: PhoneJobsContract.Offer, closed: @escaping () -> Void) {
        if deferUsed(closed) { return }
        let model = PhoneJobCardModel(offer: offer, enabledWorkspaces: enabledWorkspaces(), offscreen: !PhoneJobPresentation.matches(workspace, onScreen())) { _ in }
        model.complete(closed: closed)
        if !display(model, workspace: workspace, operationId: offer.operationId) { closed() }
    }
    func alreadyHandled(workspace: WorkspaceOrigin, operationId: String?, closed: @escaping () -> Void) {
        let model = PhoneJobCardModel(bot: "", capability: "", say: "", workspace: "", enabledWorkspaces: 1) { _ in }
        model.alreadyHandled(closed: closed)
        if !display(model, workspace: workspace, operationId: operationId) { closed() }
    }
    @discardableResult private func display(_ model: PhoneJobCardModel, workspace: WorkspaceOrigin, operationId: String?) -> Bool {
        guard PhoneJobPresentation.matches(workspace, onScreen()) else { model.dismiss(); return false }
        if self.workspace == workspace, let card = sheet as? PhoneJobCardViewController, !card.isBeingDismissed {
            card.replace(with: model)
            self.model = model; self.workspace = workspace; self.operationId = operationId
            return true
        }
        dismissAll()
        self.model = model; self.workspace = workspace; self.operationId = operationId
        let card = PhoneJobCardViewController(model: model); sheet = card
        guard present(workspace, card) else { dismissAll(); return false }
        return true
    }
    func dismiss(workspace: WorkspaceOrigin, operationId: String?) {
        if self.workspace == workspace, operationId == nil || self.operationId == nil || self.operationId == operationId { dismissAll() }
    }
    func dismissAll() {
        model?.dismiss(); model = nil
        sheet?.dismiss(animated: false); sheet = nil; workspace = nil; operationId = nil
    }
}
#endif
