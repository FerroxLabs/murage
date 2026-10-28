import Foundation

/// N11's existing preferences, shared by the sheet and intents. No credentials.
public struct ShareLastTarget {
    private let defaults: UserDefaults?
    public init(defaults: UserDefaults?) { self.defaults = defaults }
    public var workspace: String? { defaults?.string(forKey: "share.lastWorkspace") }
    public func bot(origin: String) -> String? { defaults?.string(forKey: "share.lastBot." + origin) }
    public func remember(origin: String, botId: String) {
        defaults?.set(origin, forKey: "share.lastWorkspace")
        defaults?.set(botId, forKey: "share.lastBot." + origin)
    }
}

/// N11 cache access: no refresh or implicit workspace switch. Barrier recovery
/// may check token readability without fetching or minting.
public struct AskCachedTargets {
    public struct Target: Equatable {
        public let origin: WorkspaceOrigin
        public let bot: PhoneAskContract.TargetBot
        public var identity: String { origin.serialized + "\n" + bot.id }
    }
    public let root: URL
    public let last: ShareLastTarget
    public init(root: URL, last: ShareLastTarget) { self.root = root; self.last = last }
    @MainActor public func all(now: Int64) -> [Target] {
        guard let book = ShareWorkspaceStore(root: root).read() else { return [] }
        return book.sorted.flatMap { workspace -> [Target] in
            guard let origin = WorkspaceOrigin(string: workspace.origin),
                  !SharePendingRemovals(root: root).contains(origin),
                  let entry = ShareTargetCache(root: root).read(origin, now: now) else { return [] }
            return entry.targets.bots.map { Target(origin: origin, bot: $0) }
        }
    }
    @MainActor public func resolve(identity: String?, now: Int64) -> Target? {
        let targets = all(now: now)
        if let identity { return targets.first { $0.identity == identity } }
        guard let book = ShareWorkspaceStore(root: root).read() else { return nil }
        let remembered = last.workspace ?? book.active
        let origin = book.sorted.first(where: { $0.origin == remembered })?.origin ?? book.sorted.first?.origin
        let candidates = targets.filter { $0.origin.serialized == origin }
        return candidates.first { $0.bot.id == last.bot(origin: $0.origin.serialized) } ?? candidates.first
    }
}

/// Only these locally owned lines may be presented by an ask intent.
public enum AskDialog: String, CaseIterable, Sendable {
    case sentNotify = "Sent to %@. I'll let you know when it answers."
    case sentChat = "Sent to %@. The answer will be in your chat."
    case targetGone = "That chat is no longer available. Open Murage to pick another."
    case setup = "Open Murage to set up asking."
    case update = "Update Murage on your computer to use this."
    case unreachable = "Murage can't reach your computer right now."

    public static func question(botName: String?, bundle: Bundle = .main) -> String {
        let key = botName == nil ? "What do you want to ask?" : "What do you want to ask %@?"
        let format = bundle.localizedString(forKey: key, value: key, table: nil)
        return botName.map { String(format: format, $0) } ?? format
    }

    public func text(botName: String, bundle: Bundle = .main, canOpenSnippet: Bool = true) -> String {
        let format = bundle.localizedString(forKey: rawValue, value: rawValue, table: nil)
        let line = self == .sentNotify || self == .sentChat ? String(format: format, botName) : format
        guard self != .unreachable, !canOpenSnippet else { return line }
        let fallback = "Say open Murage to continue."
        return line + " " + bundle.localizedString(forKey: fallback, value: fallback, table: nil)
    }
}

public struct AskIntentOutcome: Equatable, Sendable {
    public let dialog: AskDialog
    public let threadId: String?
    public let id: String?
    public init(_ dialog: AskDialog, threadId: String? = nil, id: String? = nil) {
        self.dialog = dialog; self.threadId = threadId; self.id = id
    }
    public var showsSnippet: Bool { dialog != .unreachable }
    public var openHash: String? { threadId.flatMap { OpenHash.build(threadId: $0) } }
    public var askHash: String? { threadId.flatMap { ComposeHash.build(threadId: $0, again: id) } }
}

public enum AskIntentResponse {
    // Deliberate projections: never decode error prose, answer, text, chat, or
    // any unknown field. Even incorrectly typed unknown values are ignored.
    struct Receipt: Decodable {
        let state: String
        let askId: String
        let threadId: String
        let id: String
        let notify: Bool
    }
    struct Failure: Decodable { let code: String }

    public static func outcome(status: Int, data: Data, askId: String, threadId: String?) -> AskIntentOutcome {
        switch status {
        case 200:
            guard let sent = try? JSONDecoder().decode(Receipt.self, from: data),
                  sent.state == "sent", sent.askId == askId,
                  OpenHash.valid(sent.threadId), !sent.threadId.hasPrefix("bot:"), OpenHash.valid(sent.id)
            else { return .init(.unreachable) }
            return .init(sent.notify ? .sentNotify : .sentChat, threadId: sent.threadId, id: sent.id)
        case 401, 403: return .init(.setup, threadId: threadId)
        case 404: return .init(.update, threadId: threadId)
        case 409:
            guard (try? JSONDecoder().decode(Failure.self, from: data))?.code == "target_gone" else { return .init(.unreachable) }
            return .init(.targetGone, threadId: threadId)
        default: return .init(.unreachable) // conflict, invalid, gateway errors, unknown responses
        }
    }
}

/// One invocation, one unlocked-keychain read, at most one POST. No retry or poll.
@MainActor
public struct AskIntentRun {
    private let targets: AskCachedTargets
    private let readToken: (WorkspaceOrigin) throws -> String?
    private let removal: ShareOriginRemoval
    private let post: (URLRequest) async throws -> ShareTargetsClient.Response
    public init(targets: AskCachedTargets, readToken: @escaping (WorkspaceOrigin) throws -> String?,
                removal: ShareOriginRemoval? = nil,
                post: @escaping (URLRequest) async throws -> ShareTargetsClient.Response) {
        self.targets = targets; self.readToken = readToken; self.post = post
        self.removal = removal ?? ShareOriginRemoval(root: targets.root)
    }
    public static func request(origin: WorkspaceOrigin, token: String, askId: String, botId: String, text: String) throws -> URLRequest {
        guard PhoneAskContract.tokenValid(token), let url = origin.url(path: "/api/phones/self/ask") else { throw ShareInputError.invalid }
        let body = try PhoneAskContract.AskRequest(askId: askId, botId: botId, text: text)
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5)
        request.httpMethod = "POST"
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }
    public func run(identity: String?, text: String, now: Int64, askId: String = UUID().uuidString) async -> AskIntentOutcome {
        guard let target = targets.resolve(identity: identity, now: now) else { return .init(.setup) }
        let thread = target.bot.mainThreadId
        let token: String
        do {
            guard let value = try readToken(target.origin) else { return .init(.setup, threadId: thread) }
            token = value
        } catch { return .init(.setup, threadId: thread) }
        do {
            let request = try Self.request(origin: target.origin, token: token, askId: askId, botId: target.bot.id, text: text)
            try Task.checkCancellation()
            guard !SharePendingRemovals(root: targets.root).contains(target.origin) else { return .init(.setup, threadId: thread) }
            let response = try await post(request)
            if response.status == 401 || response.status == 403 {
                removal.forget(target.origin, now: now, code: "revoked")
            }
            let result = AskIntentResponse.outcome(status: response.status, data: response.data, askId: askId, threadId: thread)
            if result.dialog == .sentNotify || result.dialog == .sentChat {
                targets.last.remember(origin: target.origin.serialized, botId: target.bot.id)
            }
            return result
        } catch { return .init(.unreachable) }
    }
}
