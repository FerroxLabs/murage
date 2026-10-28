import Foundation

/// Separate from the Part 1 notification hash. Literal bot: is the routing prefix.
public enum ComposeHash {
    public struct Target: Equatable {
        public let bot: String?
        public let threadId: String?
        public let again: String?
    }
    public static func build(botId: String) -> String? {
        guard OpenHash.valid(botId) else { return nil }
        return "#open=bot:" + OpenHash.formEncode(botId) + "&compose=1"
    }
    public static func build(threadId: String, again: String? = nil) -> String? {
        guard OpenHash.valid(threadId), !threadId.hasPrefix("bot:"), again == nil || OpenHash.valid(again) else { return nil }
        return "#open=" + OpenHash.formEncode(threadId) + "&compose=1" + (again.map { "&again=" + OpenHash.formEncode($0) } ?? "")
    }
    public static func parse(_ hash: String) -> Target? {
        let raw = hash.hasPrefix("#") ? String(hash.dropFirst()) : hash
        guard raw.hasPrefix("open=") else { return nil }
        var fields: [String: String] = [:]
        for part in raw.split(separator: "&", omittingEmptySubsequences: false) {
            let pair = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            func decode(_ value: String) -> String? { value.replacingOccurrences(of: "+", with: " ").removingPercentEncoding }
            guard let key = decode(String(pair[0])), let value = decode(pair.count == 2 ? String(pair[1]) : "") else { return nil }
            if fields[key] == nil { fields[key] = value }
        }
        guard fields["compose"] == "1", let open = fields["open"], fields["again"] == nil || OpenHash.valid(fields["again"]) else { return nil }
        if open.hasPrefix("bot:") {
            let bot = String(open.dropFirst(4))
            guard OpenHash.valid(bot), fields["again"] == nil else { return nil }
            return Target(bot: bot, threadId: nil, again: nil)
        }
        guard OpenHash.valid(open) else { return nil }
        return Target(bot: nil, threadId: open, again: fields["again"])
    }
}
