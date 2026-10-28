import Foundation
import MurageShellCore

enum PhoneJobStrings {
    static func text(_ key: String) -> String {
        NSLocalizedString(key, bundle: .module, comment: "Phone job card")
    }
    static func capability(_ value: String) -> String { text("phone_job_" + value) }
    static func used(bot: String, capability: String) -> String {
        String(format: text("phone_job_used"), bot, text("phone_job_used_" + capability))
    }
}

/// Memory-only presentation state, shared by the native view and model tests.
@MainActor final class PhoneJobCardModel {
    enum State { case offer, waiting, used, handled, dismissed }
    private(set) var state: State = .offer
    let bot: String, capability: String, say: String, workspace: String?
    let destinations: [String]
    var details: [String] = []
    private var answer: ((Bool) -> Void)?
    private var closed: (() -> Void)?

    init(bot: String, capability: String, say: String, workspace: String,
         enabledWorkspaces: Int, offscreen: Bool = false, destinations: [String] = [], answer: @escaping (Bool) -> Void) {
        self.bot = PhoneDataSharingText.plain(bot, limit: 120)
        self.capability = capability
        self.say = PhoneDataSharingText.plain(say, limit: 240, lineBreaks: 2)
        self.workspace = (enabledWorkspaces > 1 || offscreen) ? PhoneDataSharingText.plain(workspace, limit: 120) : nil
        self.answer = answer
        self.destinations = destinations // Already validated; approval must preserve every byte.
    }
    convenience init(offer: PhoneJobsContract.Offer, enabledWorkspaces: Int, offscreen: Bool = false, answer: @escaping (Bool) -> Void) {
        let destinations: [String]
    var details: [String] = []
        switch offer.decodedArgs {
        case .callsDial(let args): destinations = [args.number]
        case .messagesCompose(let args): destinations = args.to
        default: destinations = []
        }
        self.init(bot: offer.bot.name, capability: offer.capability, say: offer.say,
                  workspace: offer.workspace, enabledWorkspaces: enabledWorkspaces, offscreen: offscreen, destinations: destinations, answer: answer)
        if let args = offer.decodedArgs { details = Self.details(args) }
    }
    convenience init(offer: PhoneJobsContract.Offer, args: PhoneJobsContract.Args, currentTitle: String? = nil, enabledWorkspaces: Int, answer: @escaping (Bool) -> Void) {
        let destinations: [String]
        switch args {
        case .callsDial(let a): destinations = [a.number]
        case .messagesCompose(let a): destinations = a.to
        default: destinations = []
        }
        self.init(bot: offer.bot.name, capability: offer.capability, say: offer.say, workspace: offer.workspace,
                  enabledWorkspaces: enabledWorkspaces, destinations: destinations, answer: answer)
        details = Self.details(args, currentTitle: currentTitle)
    }
    static func details(_ args: PhoneJobsContract.Args, currentTitle: String? = nil) -> [String] {
        var rows: [String] = []
        func add(_ key: String, _ value: String?) {
            guard let value else { return }
            rows.append(PhoneJobStrings.text("phone_detail_" + key) + ": " + PhoneDataSharingText.plain(value, limit: 4000, lineBreaks: 8))
        }
        switch args {
        case .calendarAdd(let a):
            add("title", a.title); add("start", a.start); add("end", a.end)
            add("all_day", PhoneJobStrings.text(a.allDay == true ? "phone_detail_yes" : "phone_detail_no"))
            add("location", a.location); add("notes", a.notes)
        case .calendarChange(let a):
            add("current_item", currentTitle); add("id", a.id); add("title", a.title)
            add("start", a.start); add("end", a.end); add("location", a.location); add("notes", a.notes)
        case .remindersAdd(let a): add("title", a.title); add("due", a.due ?? PhoneJobStrings.text("phone_detail_none")); add("notes", a.notes)
        case .remindersComplete(let a): add("current_item", currentTitle); add("id", a.id); add("completed", PhoneJobStrings.text("phone_detail_yes"))
        case .alarmsSet(let a): add("time", String(format: "%02d:%02d", a.hour, a.minute)); add("label", a.label)
        case .alarmsTimer(let a): add("seconds", String(a.seconds)); add("label", a.label)
        case .messagesCompose(let a): add("message", a.body)
        default: break
        }
        return rows
    }
    func choose(_ allow: Bool) {
        guard state == .offer, let callback = answer else { return }
        state = .waiting; answer = nil
        callback(allow)
    }
    func complete(closed: @escaping () -> Void) {
        guard state != .dismissed else { return }
        state = .used; answer = nil; self.closed = closed
    }
    func alreadyHandled(closed: @escaping () -> Void) {
        guard state != .dismissed else { return }
        state = .handled; answer = nil; self.closed = closed
    }
    func close() {
        guard state == .used || state == .handled else { return }
        let callback = closed
        dismiss(); callback?()
    }
    func dismiss() { state = .dismissed; answer = nil; closed = nil }
}

/// Presentation is permitted only on the computer that owns the job.
enum PhoneJobPresentation {
    static func matches(_ workspace: WorkspaceOrigin, _ onScreen: WorkspaceOrigin?) -> Bool {
        workspace == onScreen
    }
}
