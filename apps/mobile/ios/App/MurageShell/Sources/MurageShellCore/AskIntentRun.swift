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
    case update = "Turn this on, or update Murage, on your computer."
    case unreachable = "Murage can't reach your computer right now."
    /// D8: a phone with no approval key sent the plain ask and it was acknowledged.
    case sentPlain = "Sent to %@."
    /// D8: the phone has an approval key, the signed path did not work, the plain ask was acknowledged.
    case sentWithoutChat = "Sent to %@ without your recent chat."
    /// D8: the plain ask was acknowledged, but this phone was paired before the device id was pinned.
    case sentRePair = "Sent to %@. Pair this phone again to include your recent chat."
    /// D8: nothing was acknowledged (the signed try, its retry and the plain send all timed out). Never says "Sent".
    case noAnswer = "Couldn't reach your computer. Check it's on and try again."

    /// Every dialog that says the ask went out.
    public var isSent: Bool {
        switch self {
        case .sentNotify, .sentChat, .sentPlain, .sentWithoutChat, .sentRePair: return true
        default: return false
        }
    }

    public static func question(botName: String?, bundle: Bundle = .main) -> String {
        let key = botName == nil ? "What do you want to ask?" : "What do you want to ask %@?"
        let format = bundle.localizedString(forKey: key, value: key, table: nil)
        return botName.map { String(format: format, $0) } ?? format
    }

    private static let namesTheBot: Set<AskDialog> = [.sentNotify, .sentChat, .sentPlain, .sentWithoutChat, .sentRePair]

    public func text(botName: String, bundle: Bundle = .main, canOpenSnippet: Bool = true) -> String {
        let format = bundle.localizedString(forKey: rawValue, value: rawValue, table: nil)
        let line = Self.namesTheBot.contains(self) ? String(format: format, botName) : format
        guard self != .unreachable, self != .noAnswer, !canOpenSnippet else { return line }
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
    public var showsSnippet: Bool { dialog != .unreachable && dialog != .noAnswer }
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
        /// Absent from a harness that predates owner proof: today's dialogs.
        let proven: Bool?
    }
    struct Failure: Decodable { let code: String }

    /// `unproven`: what to say when the harness answers `proven: false`.
    public static func outcome(status: Int, data: Data, askId: String, threadId: String?, unproven: AskDialog = .sentPlain) -> AskIntentOutcome {
        switch status {
        case 200:
            guard let sent = try? JSONDecoder().decode(Receipt.self, from: data),
                  sent.state == "sent", sent.askId == askId,
                  OpenHash.valid(sent.threadId), !sent.threadId.hasPrefix("bot:"), OpenHash.valid(sent.id)
            else { return .init(.unreachable) }
            // proven false: the ask went out plain; the caller knows why (no key, signed path failed, not pinned).
            let dialog: AskDialog = sent.proven == false ? unproven : (sent.notify ? .sentNotify : .sentChat)
            return .init(dialog, threadId: sent.threadId, id: sent.id)
        case 401, 403: return .init(.setup, threadId: threadId)
        case 404: return .init(.update, threadId: threadId)
        case 409:
            guard (try? JSONDecoder().decode(Failure.self, from: data))?.code == "target_gone" else { return .init(.unreachable) }
            return .init(.targetGone, threadId: threadId)
        default: return .init(.unreachable) // conflict, invalid, gateway errors, unknown responses
        }
    }
}

/// One invocation, one unlocked-keychain read. Without the proof steps: at most
/// one POST, no retry or poll. With them (the owner holds an approval key): a
/// challenge request, one signed send (retried once on a lost answer), and the
/// plain ask with the same askId when anything about the proof does not work.
@MainActor
public struct AskIntentRun {
    private let targets: AskCachedTargets
    private let readToken: (WorkspaceOrigin) throws -> String?
    private let removal: ShareOriginRemoval
    private let post: (URLRequest) async throws -> ShareTargetsClient.Response
    private let proof: AskProofSteps?
    private let pending: AskPendingAsk?
    private enum Stop: Error { case removalPending }

    public init(targets: AskCachedTargets, readToken: @escaping (WorkspaceOrigin) throws -> String?,
                removal: ShareOriginRemoval? = nil, proof: AskProofSteps? = nil, pending: AskPendingAsk? = nil,
                post: @escaping (URLRequest) async throws -> ShareTargetsClient.Response) {
        self.targets = targets; self.readToken = readToken; self.post = post; self.proof = proof; self.pending = pending
        self.removal = removal ?? ShareOriginRemoval(root: targets.root)
    }
    public static func request(origin: WorkspaceOrigin, token: String, askId: String, botId: String, text: String,
                               proof: PhoneAskContract.AskProofField? = nil) throws -> URLRequest {
        guard PhoneAskContract.tokenValid(token), let url = origin.url(path: "/api/phones/self/ask") else { throw ShareInputError.invalid }
        let body = try PhoneAskContract.AskRequest(askId: askId, botId: botId, text: text, proof: proof)
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5)
        request.httpMethod = "POST"
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }

    /// `textWasPrefilled`: the text came from a Shortcut or Spotlight parameter,
    /// not from this run's own question, so the owner must see it in full first.
    /// `askId` nil: reuse the id of an earlier unanswered ask of this text to this bot, else a fresh one.
    public func run(identity: String?, text: String, now: Int64, askId: String? = nil,
                    textWasPrefilled: Bool = false) async -> AskIntentOutcome {
        guard let target = targets.resolve(identity: identity, now: now) else { return .init(.setup) }
        let thread = target.bot.mainThreadId
        let token: String
        do {
            guard let value = try readToken(target.origin) else { return .init(.setup, threadId: thread) }
            token = value
        } catch { return .init(.setup, threadId: thread) }
        let id = askId ?? pending?.askId(origin: target.origin, botId: target.bot.id, text: text, now: now) ?? UUID().uuidString
        let ask = Ask(target: target, token: token, askId: id, text: text, now: now)
        do {
            if let proof, proof.keyId(target.origin) != nil {
                do { return try await proven(ask, proof: proof, prefilled: textWasPrefilled) }
                catch { // nothing acknowledged: never "Sent"; the same askId is reused by a later try
                    if Self.isFatal(error) { throw error }
                    return .init(.noAnswer, threadId: thread)
                }
            }
            return try await plain(ask)
        } catch Stop.removalPending {
            return .init(.setup, threadId: thread)
        } catch { return .init(.unreachable) }
    }

    private struct Ask {
        let target: AskCachedTargets.Target
        let token: String, askId: String, text: String
        let now: Int64
        /// What a plain ask acknowledged as `proven: false` says (who is asking and why it was plain).
        var unproven: AskDialog = .sentPlain
        var thread: String { target.bot.mainThreadId }
    }

    /// Cancellation and a removal barrier end the run; anything else is a transport failure.
    private static func isFatal(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled || error is Stop
    }

    private func exchange(_ ask: Ask, _ proof: PhoneAskContract.AskProofField?) async throws -> ShareTargetsClient.Response {
        let request = try Self.request(origin: ask.target.origin, token: ask.token, askId: ask.askId,
                                       botId: ask.target.bot.id, text: ask.text, proof: proof)
        try Task.checkCancellation()
        guard !SharePendingRemovals(root: targets.root).contains(ask.target.origin) else { throw Stop.removalPending }
        return try await post(request)
    }

    private func settle(_ response: ShareTargetsClient.Response, _ ask: Ask) -> AskIntentOutcome {
        if response.status == 401 || response.status == 403 {
            removal.forget(ask.target.origin, now: ask.now, code: "revoked")
        }
        pending?.clear(origin: ask.target.origin, botId: ask.target.bot.id) // answered: the id is spent
        let result = AskIntentResponse.outcome(status: response.status, data: response.data, askId: ask.askId, threadId: ask.thread, unproven: ask.unproven)
        if result.dialog.isSent {
            targets.last.remember(origin: ask.target.origin.serialized, botId: ask.target.bot.id)
        }
        return result
    }

    /// The plain ask: exactly today's single POST.
    private func plain(_ ask: Ask) async throws -> AskIntentOutcome {
        let response: ShareTargetsClient.Response
        do { response = try await exchange(ask, nil) }
        catch {
            if !Self.isFatal(error) {
                pending?.record(origin: ask.target.origin, botId: ask.target.bot.id, text: ask.text, askId: ask.askId, now: ask.now)
            }
            throw error
        }
        return settle(response, ask)
    }

    private func answer(_ response: ShareTargetsClient.Response) -> PhoneAskContract.AskAnswer? {
        guard response.status == 200 else { return nil }
        return try? JSONDecoder().decode(PhoneAskContract.AskAnswer.self, from: response.data)
    }

    private func proven(_ plainAsk: Ask, proof: AskProofSteps, prefilled: Bool) async throws -> AskIntentOutcome {
        // A phone paired before pinning has no device id to compare: fail closed onto the plain path.
        guard let pinned = proof.pairedDeviceId(plainAsk.target.origin) else {
            var ask = plainAsk; ask.unproven = .sentRePair
            return try await plain(ask)
        }
        var ask = plainAsk; ask.unproven = .sentWithoutChat
        // The owner sees pre-filled text in full before anything is signed (8.6).
        if prefilled, !(await proof.confirm(ask.text)) { return try await plain(ask) }
        let want: ShareTargetsClient.Response
        do { want = try await exchange(ask, .want) }
        catch { if Self.isFatal(error) { throw error }; return try await plain(ask) }
        switch want.status {
        case 401, 403, 404, 409: return settle(want, ask)
        case 200: break
        default: return try await plain(ask) // an older harness refuses the unknown field: plain still works
        }
        switch answer(want) {
        case .confirm(let confirm)?: return try await signed(ask, confirm: confirm, pinned: pinned, proof: proof)
        case .sent?: return settle(want, ask) // a committed receipt for this askId answers as it did
        default: return try await plain(ask)
        }
    }

    private func signed(_ ask: Ask, confirm: PhoneAskContract.AskConfirm, pinned: String, proof: AskProofSteps) async throws -> AskIntentOutcome {
        guard case .success(let signing) = AskProof.prepare(origin: ask.target.origin, confirm: confirm,
                pairedDeviceId: pinned, askId: ask.askId,
                botId: ask.target.bot.id, botName: ask.target.bot.name, text: ask.text, now: ask.now) else { return try await plain(ask) }
        guard case .success(let signature) = await proof.sign(signing) else { return try await plain(ask) }
        let body = PhoneAskContract.AskProofField.signed(nonce: signing.nonce, signature: signature)
        var response: ShareTargetsClient.Response?
        for _ in 0..<2 { // a lost answer: retry the same body once, a committed receipt answers
            do { response = try await exchange(ask, body); break }
            catch { if Self.isFatal(error) { throw error } }
        }
        // Unknown whether it committed: send plain with the same askId. If that is silent too the
        // caller reports that nothing was acknowledged (and a later try reuses the askId).
        guard let response else { return try await plain(ask) }
        switch response.status {
        case 200:
            if case .sent? = answer(response) { return settle(response, ask) }
            return try await plain(ask) // proof_failed, or a shape this phone does not know
        case 401, 403, 404, 409:
            if response.status == 403, (try? JSONDecoder().decode(AskIntentResponse.Failure.self, from: response.data))?.code == "fresh_auth_failed" {
                return try await plain(ask)
            }
            return settle(response, ask)
        default: return try await plain(ask)
        }
    }
}
