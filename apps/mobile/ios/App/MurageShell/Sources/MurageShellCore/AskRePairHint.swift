import Foundation

/// The one line for a phone paired before the computer's device id was pinned
/// at pairing: "Pair this phone again so {bot} can see your recent chat when you
/// send from it." Shown only while no device id is stored for the pairing
/// (origin + approval key), and only until the person dismisses it. The
/// dismissal is per pairing, so a re-pair (a new key and a pinned id) starts
/// clean and `AskDevicePin.pin` drops any old mark. Stores a flag, no credentials.
public struct AskRePairHint {
    private let defaults: UserDefaults?
    public init(defaults: UserDefaults?) { self.defaults = defaults }
    static func key(_ origin: WorkspaceOrigin, _ keyId: String) -> String { "ask.repairHint.dismissed." + origin.serialized + "|" + keyId }

    /// `keyId` is nil when the phone has no approval key; `asking` is true once the ask credential exists.
    /// No device id stored and not dismissed: show.
    public func visible(origin: WorkspaceOrigin, keyId: String?, asking: Bool, pin: AskDevicePin) -> Bool {
        guard asking, let keyId else { return false }
        if pin.paired(origin: origin, keyId: keyId) != nil { return false }
        return defaults?.bool(forKey: Self.key(origin, keyId)) != true
    }
    public func dismiss(origin: WorkspaceOrigin, keyId: String) { defaults?.set(true, forKey: Self.key(origin, keyId)) }
    public func clear(origin: WorkspaceOrigin, keyId: String) { defaults?.removeObject(forKey: Self.key(origin, keyId)) }
    public func text(botName: String, bundle: Bundle = .main) -> String {
        AskProofStrings.render(AskProofStrings.repairHint, botName: botName, bundle: bundle)
    }
}

/// Names the bot for the hint without depending on a cached roster: the cached targets first, else the same targets load
/// the share and ask sheets use (the host's list, whose first bot is its default). Nil when neither resolves; the screen
/// then shows nothing and asks again on its next load.
public enum AskRePairHintBot {
    @MainActor public static func name(origin: WorkspaceOrigin, client: ShareTargetsClient, now: Int64) async -> String? {
        if case .ready(let cached) = client.initial(origin, now: now), let bot = cached.bots.first { return bot.name }
        if case .ready(let loaded) = await client.refresh(origin, now: now), let bot = loaded.bots.first { return bot.name }
        return nil
    }
}

/// Item 6 guard: no shipped D8 string may name a bot. The roster is read from
/// the product's own source (server/names.ts), never typed here.
public enum AskCopyGuard {
    /// The product's names (server/names.ts) plus the contract's list of names real bots have used (apps/mobile/contract/bot-names.json).
    public static func roster(namesSource: String, contractJSON: Data?) -> [String] {
        var names = roster(namesSource: namesSource)
        if let contractJSON, let object = try? JSONSerialization.jsonObject(with: contractJSON) as? [String: Any],
           let listed = object["names"] as? [String] {
            names += listed.filter { !$0.isEmpty }
        }
        return Array(Set(names)).sorted()
    }
    /// Quoted names inside `const NAMES = [ ... ];` plus DEFAULT_BOT_NAME.
    public static func roster(namesSource: String) -> [String] {
        var names: [String] = []
        if let open = namesSource.range(of: "const NAMES = ["), let close = namesSource.range(of: "];", range: open.upperBound..<namesSource.endIndex) {
            names += quoted(String(namesSource[open.upperBound..<close.lowerBound]))
        }
        if let line = namesSource.components(separatedBy: "\n").first(where: { $0.contains("DEFAULT_BOT_NAME =") }) { names += quoted(line) }
        return names
    }
    private static func quoted(_ text: String) -> [String] {
        text.components(separatedBy: "\"").enumerated().filter { $0.offset % 2 == 1 }.map(\.element).filter { !$0.isEmpty }
    }
    /// The boundary is "not an ASCII letter or digit", so a name next to CJK text (あなたとしてSableに送信) is still a name,
    /// while Sablefish and unSable are not.
    private static func isAsciiAlnum(_ c: Character?) -> Bool {
        guard let c, c.isASCII else { return false }
        return c.isLetter || c.isNumber
    }
    /// The first roster name that appears in `value` as a whole word, or nil.
    public static func namedBot(in value: String, roster: [String]) -> String? {
        roster.first { name in
            var from = value.startIndex
            while let r = value.range(of: name, options: .literal, range: from..<value.endIndex) {
                let before = r.lowerBound == value.startIndex ? nil : value[value.index(before: r.lowerBound)]
                let after = r.upperBound == value.endIndex ? nil : value[r.upperBound]
                if !isAsciiAlnum(before) && !isAsciiAlnum(after) { return true }
                from = r.upperBound
            }
            return false
        }
    }
}
