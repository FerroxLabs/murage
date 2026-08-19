// Keeping the Dynamic Island in step with the bots.
//
// One Live Activity per bot that is doing something — needs you, or working
// — started, updated and ended from the same `updates` the pill reads. The
// stream is foreground-only and there is no push path yet, so the island is
// exact while the app is alive and goes quiet with it; iOS keeps the last
// state on screen for a while, then the activity is ended on the next
// launch if the bot has moved on.
import ActivityKit
import Combine
import Foundation
import CompanionCore

@MainActor
final class LiveActivityCoordinator {
    private var cancellable: AnyCancellable?
    private var lastSent: [String: BotActivityAttributes.ContentState] = [:]

    func attach(to session: Session) {
        // Answer from the island: the intent runs in this process.
        AnswerApprovalIntent.handler = { [weak session] threadId, requestId, choice, isPermission in
            await session?.answer(threadId: threadId, requestId: requestId, choice: choice, isPermission: isPermission)
        }
        cancellable = session.$state
            .debounce(for: .milliseconds(400), scheduler: DispatchQueue.main)
            .sink { [weak self] state in self?.sync(state) }
    }

    private func sync(_ state: CompanionState) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let wanted = state.updates.filter { $0.kind != .toReview }
        var wantedIds = Set<String>()

        for update in wanted {
            guard case let .bot(bot) = update.chat else { continue }
            wantedIds.insert(bot.id)
            let face = MausState.forBot(bot, last: state.visibleTranscript(forThread: bot.threadId).last)
            let content = BotActivityAttributes.ContentState(
                face: face.rawValue,
                kind: update.kind == .needsYou ? "needsYou" : "working",
                headline: update.kind == .needsYou ? "\(bot.name) needs you" : "\(bot.name) is working",
                line: update.line.isEmpty ? (update.card?.title ?? "") : update.line,
                requestId: update.card?.isPending == true ? update.card?.requestId : nil,
                options: update.card?.isPending == true ? (update.card?.options ?? []) : [],
                isPermission: update.card?.isPermission ?? false
            )
            if lastSent[bot.id] == content { continue }
            lastSent[bot.id] = content

            if let activity = Activity<BotActivityAttributes>.activities.first(where: { $0.attributes.botId == bot.id }) {
                Task { await activity.update(.init(state: content, staleDate: nil)) }
            } else {
                let attributes = BotActivityAttributes(botId: bot.id, threadId: bot.threadId, name: bot.name, color: bot.color)
                _ = try? Activity.request(attributes: attributes, content: .init(state: content, staleDate: nil), pushType: nil)
            }
        }

        // bots that went quiet: let the island go
        for activity in Activity<BotActivityAttributes>.activities where !wantedIds.contains(activity.attributes.botId) {
            lastSent.removeValue(forKey: activity.attributes.botId)
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
    }
}
