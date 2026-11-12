import AppIntents
import MurageShell
import MurageShellCore
import SwiftUI

struct BotEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Ask a bot"
    static var defaultQuery = BotQuery()
    let id: String
    let name: String
    let workspace: String
    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(workspace)")
    }
}

struct BotQuery: EntityQuery {
    @MainActor
    func entities(for identifiers: [String]) async throws -> [BotEntity] {
        IntentEnvironment.entities.filter { identifiers.contains($0.id) }
    }
    @MainActor
    func suggestedEntities() async throws -> [BotEntity] { IntentEnvironment.entities }
    @MainActor
    func defaultResult() async -> BotEntity? {
        guard let target = IntentEnvironment.targets?.resolve(identity: nil, now: IntentEnvironment.now) else { return nil }
        return IntentEnvironment.entities.first { $0.id == target.identity }
    }
}

@MainActor
private enum IntentEnvironment {
    static var now: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
    static var targets: AskCachedTargets? {
        ShareContainer.root.map { AskCachedTargets(root: $0, last: ShareLastTarget(defaults: UserDefaults(suiteName: ShareContainer.group))) }
    }
    static var entities: [BotEntity] {
        targets?.all(now: now).map { BotEntity(id: $0.identity, name: $0.bot.name, workspace: $0.origin.host) } ?? []
    }
    static func open(origin: String?, hash: String?) {
        guard let origin, let origin = WorkspaceOrigin(string: origin), let hash else {
            ShellCoordinator.shared.showLauncher()
            return
        }
        ShellCoordinator.shared.openFromAskIntent(origin: origin, hash: hash)
    }
}

struct AskMurageIntent: ForegroundContinuableIntent {
    static var title: LocalizedStringResource = "Ask Murage"
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static var openAppWhenRun: Bool = false
    // Background by default; only the Face ID proof step may continue in the
    // foreground (design 8.7, the OpenAskIntent pattern). V-D8-1 decides later
    // whether Face ID can present in the background and the hop can go.
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { [.background, .foreground(.dynamic)] }

    @Parameter(title: "Ask a bot") var bot: BotEntity?
    @Parameter(title: "What do you want to ask?", requestValueDialog: "What do you want to ask?") var question: String?

    private static func local(_ key: String) -> String { Bundle.main.localizedString(forKey: key, value: key, table: nil) }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        let targets = IntentEnvironment.targets
        let target = targets?.resolve(identity: bot?.id, now: IntentEnvironment.now)
        let text: String
        // Text from a Shortcut or Spotlight parameter was not typed or spoken in this run.
        let prefilled: Bool
        if let question, !question.isEmpty { text = question; prefilled = true }
        else {
            let prompt = AskDialog.question(botName: bot == nil ? nil : target?.bot.name)
            text = try await $question.requestValue(IntentDialog("\(prompt)"))
            prefilled = false
        }
        let outcome: AskIntentOutcome
        if let targets, let target {
            let http = ShareTargetsHTTP()
            defer { http.close() }
            let tokens = MurageShellCore.PhoneAskTokenStore()
            let steps = AskProofSigner.steps(
                pin: AskDevicePin(defaults: UserDefaults(suiteName: ShareContainer.group)),
                confirm: { shown in
                    // The owner sees the full text; cancelling sends the plain ask (design 8.9).
                    let title = AskProofStrings.render(AskProofStrings.confirmTitle, botName: target.bot.name)
                    do {
                        try await requestConfirmation(result: .result(dialog: IntentDialog("\(title)"), view: AskConfirmSnippet(text: shown)),
                                                      confirmationActionName: .send)
                        return true
                    } catch { return false }
                },
                beforeSigning: {
                    // Declining or no continuation leaves the plain ask to send.
                    let line = Self.local(AskProofStrings.confirmInApp)
                    do {
                        if #available(iOS 26.0, *) { try await continueInForeground(IntentDialog("\(line)"), alwaysConfirm: true) }
                        else { try await requestToContinueInForeground(IntentDialog("\(line)")) }
                        return true
                    } catch { return false }
                })
            outcome = await AskIntentRun(targets: targets, readToken: tokens.readForAsk, proof: steps,
                post: { try await http.send($0) }).run(identity: target.identity, text: text, now: IntentEnvironment.now,
                                                       textWasPrefilled: prefilled)
        } else { outcome = .init(.setup) }
        let line = outcome.dialog.text(botName: target?.bot.name ?? "")
        return .result(dialog: IntentDialog("\(line)"), view: AskResultSnippet(outcome: outcome, origin: target?.origin.serialized))
    }
}

/// The full text the owner is asked to send as themselves.
private struct AskConfirmSnippet: View {
    let text: String
    var body: some View {
        Text(verbatim: text).fixedSize(horizontal: false, vertical: true).padding()
    }
}

struct OpenAskIntent: ForegroundContinuableIntent {
    static var title: LocalizedStringResource = "Open my chat"
    static var openAppWhenRun: Bool = true
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.dynamic) }
    @Parameter(title: "Ask a bot") var bot: BotEntity?

    @MainActor
    func perform() async throws -> some IntentResult {
        if #available(iOS 26.0, *) { try await continueInForeground(alwaysConfirm: false) }
        let target = IntentEnvironment.targets?.resolve(identity: bot?.id, now: IntentEnvironment.now)
        IntentEnvironment.open(origin: target?.origin.serialized, hash: target.flatMap { ComposeHash.build(botId: $0.bot.id) })
        return .result()
    }
}

struct AskInMurageIntent: ForegroundContinuableIntent {
    static var title: LocalizedStringResource = "Ask in Murage"
    static var isDiscoverable: Bool = false
    static var openAppWhenRun: Bool = true
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.dynamic) }
    @Parameter(title: "From") var origin: String?
    @Parameter(title: "Open my chat") var threadId: String?
    @Parameter(title: "Ask in Murage") var messageId: String?
    init() {}
    init(origin: String?, threadId: String?, id: String?) {
        self.origin = origin; self.threadId = threadId; self.messageId = id
    }
    @MainActor
    func perform() async throws -> some IntentResult {
        if #available(iOS 26.0, *) { try await continueInForeground(alwaysConfirm: false) }
        IntentEnvironment.open(origin: origin, hash: threadId.flatMap { ComposeHash.build(threadId: $0, again: messageId) })
        return .result()
    }
}

struct OpenInMurageIntent: ForegroundContinuableIntent {
    static var title: LocalizedStringResource = "Open in Murage"
    static var isDiscoverable: Bool = false
    static var openAppWhenRun: Bool = true
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.dynamic) }
    @Parameter(title: "From") var origin: String?
    @Parameter(title: "Open my chat") var threadId: String?
    init() {}
    init(origin: String?, threadId: String?) { self.origin = origin; self.threadId = threadId }
    @MainActor
    func perform() async throws -> some IntentResult {
        if #available(iOS 26.0, *) { try await continueInForeground(alwaysConfirm: false) }
        IntentEnvironment.open(origin: origin, hash: threadId.flatMap { OpenHash.build(threadId: $0) })
        return .result()
    }
}

private struct AskResultSnippet: View {
    let outcome: AskIntentOutcome
    let origin: String?
    var body: some View {
        if outcome.showsSnippet {
            HStack {
                Button("Open in Murage", intent: OpenInMurageIntent(origin: origin, threadId: outcome.threadId))
                Button("Ask in Murage", intent: AskInMurageIntent(origin: origin, threadId: outcome.threadId, id: outcome.id))
            }
        }
    }
}

struct MurageShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AskMurageIntent(), phrases: ["Ask \(.applicationName)", "Ask \(.applicationName) something", "Ask \(\.$bot) in \(.applicationName)"],
                    shortTitle: "Ask Murage", systemImageName: "bubble.left")
        AppShortcut(intent: OpenAskIntent(), phrases: ["Open my chat in \(.applicationName)"],
                    shortTitle: "Open my chat", systemImageName: "square.and.pencil")
    }
}
