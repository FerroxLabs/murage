import Foundation
import MurageShellCore
@MainActor protocol PhoneMessageComposer {
    var available: Bool { get }
    func open(recipients: [String], body: String, cancellation: PhoneJobCancellation) async throws
    func cancel()
}
extension PhoneMessageComposer { func cancel() {} }
@MainActor final class PhoneMessagesExecutor: PhoneCapabilityExecutor {
    let os: PhoneMessageComposer
    func cancel() { os.cancel() }
    init(os: PhoneMessageComposer) { self.os = os }
    func execute(operationId: String, args: PhoneJobsContract.Args, preciseConsent: Bool, cancellation: PhoneJobCancellation) async throws -> [String: Any] {
        try cancellation.check()
        guard case .messagesCompose(let a) = args else { throw PhoneExecutorFailure.unsupported }
        guard os.available else { throw PhoneExecutorFailure.unsupported }
        try cancellation.check()
        try await os.open(recipients: a.to, body: a.body, cancellation: cancellation)
        return ["outcome": "opened_for_you_to_send"]
    }
}
#if os(iOS)
import UIKit
import MessageUI
@MainActor final class SystemMessageComposer: NSObject, PhoneMessageComposer, MFMessageComposeViewControllerDelegate {
    private let host: () -> UIViewController?
    private weak var composer: MFMessageComposeViewController?
    private var closed: (() -> Void)?
    private var presented: CheckedContinuation<Void, Error>?
    var isComposing: Bool { composer != nil }
    func whenClosed(_ done: @escaping () -> Void) -> Bool {
        guard isComposing else { return false }; closed = done; return true
    }
    init(host: @escaping () -> UIViewController?) { self.host = host }
    var available: Bool { MFMessageComposeViewController.canSendText() }
    func open(recipients: [String], body: String, cancellation: PhoneJobCancellation) async throws {
        guard available, !isComposing, UIApplication.shared.applicationState != .background, let host = host(), host.viewIfLoaded?.window != nil else { throw PhoneExecutorFailure.denied }
        var presenter = host
        while let next = presenter.presentedViewController { presenter = next }
        let sheet = MFMessageComposeViewController(); sheet.recipients = recipients; sheet.body = body; sheet.messageComposeDelegate = self
        guard !presenter.isBeingDismissed, !presenter.isBeingPresented else { throw PhoneExecutorFailure.denied }
        try cancellation.beginWrite()
        composer = sheet
        // Receipt means presentation, never the owner's later send decision.
        try await withCheckedThrowingContinuation { continuation in
            presented = continuation
            presenter.present(sheet, animated: false) { [weak self] in
                let pending = self?.presented; self?.presented = nil; pending?.resume()
            }
            if sheet.presentingViewController == nil {
                let pending = presented; presented = nil; composer = nil
                pending?.resume(throwing: PhoneExecutorFailure.denied)
            }
        }
    }
    func cancel() {
        let pending = presented; presented = nil
        composer?.dismiss(animated: false); composer = nil; closed = nil
        pending?.resume(throwing: PhoneExecutorFailure.denied)
    }
    func messageComposeViewController(_ controller: MFMessageComposeViewController, didFinishWith result: MessageComposeResult) {
        controller.dismiss(animated: true) { [weak self] in
            guard let self else { return }; self.composer = nil
            let done = self.closed; self.closed = nil; done?()
        }
    }
}
#endif
