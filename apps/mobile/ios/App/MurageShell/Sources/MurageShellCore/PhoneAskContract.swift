import Foundation

/// Native twin of shared/phone-ask-contract.ts. Lengths count UTF-16 units.
public enum PhoneAskContract {
    public static let tag = "murage-phone-ask/1"
    public static let ttlMs = 60_000
    public static let targetsRecentMax = 8
    public enum ContractError: Error { case invalid }

    public static func phoneAskMessage(origin: String, keyId: String, nonce: String, expiresAt: Int64) -> String {
        [tag, origin, keyId, nonce, String(expiresAt)].joined(separator: "\n")
    }
    public static func tokenValid(_ value: String) -> Bool { matches(value, "murage_pa_[A-Za-z0-9_-]{43}") }
    static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: "\\A(?:" + pattern + ")\\z", options: .regularExpression) != nil
    }
    private static func text(_ value: String, _ min: Int, _ max: Int) -> Bool {
        (min...max).contains(value.utf16.count)
    }
    private static let uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
    private struct Key: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
    private static func checkKeys(_ decoder: Decoder, _ allowed: [String]) throws {
        let keys = try decoder.container(keyedBy: Key.self).allKeys.map(\.stringValue)
        guard Set(keys).isSubset(of: Set(allowed)) else { throw ContractError.invalid }
    }
    public static let imageMimes = ["image/png", "image/jpeg", "image/gif", "image/webp"]
    public static let fileMimes = ["text/plain", "text/markdown", "text/csv", "text/tab-separated-values", "application/json", "application/pdf", "application/rtf", "text/rtf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.oasis.opendocument.text", "application/vnd.oasis.opendocument.spreadsheet", "application/vnd.oasis.opendocument.presentation"]
    public enum ShareLimits {
        public static let maxItems = 10
        public static let maxShareBytes = 62_914_560
        public static let doorMaxBytes = 67_108_864
        public static let imageMaxBytes = 10_485_760
        public static let fileMaxBytes = 26_214_400
        public static let noteMaxChars = 2000
    }

    public struct ShareItem: Codable, Equatable {
        public let n: Int
        public let name: String
        public let mime: String
        public let bytes: Int64
        public let sha256: String

        public init(n: Int, name: String, mime: String, bytes: Int64, sha256: String) throws {
            self.n = n
            self.name = name
            self.mime = mime
            self.bytes = bytes
            self.sha256 = sha256
            try validate()
        }
        private enum CodingKeys: String, CodingKey { case n, name, mime, bytes, sha256 }
        public init(from decoder: Decoder) throws {
            try checkKeys(decoder, ["n", "name", "mime", "bytes", "sha256"])
            let c = try decoder.container(keyedBy: CodingKeys.self)
            n = try c.decode(Int.self, forKey: .n)
            name = try c.decode(String.self, forKey: .name)
            mime = try c.decode(String.self, forKey: .mime)
            bytes = try c.decode(Int64.self, forKey: .bytes)
            sha256 = try c.decode(String.self, forKey: .sha256)
            try validate()
        }
        public func encode(to encoder: Encoder) throws {
            try validate()
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(n, forKey: .n)
            try c.encode(name, forKey: .name)
            try c.encode(mime, forKey: .mime)
            try c.encode(bytes, forKey: .bytes)
            try c.encode(sha256, forKey: .sha256)
        }
        fileprivate func validate() throws {
            guard (1...10).contains(n) else { throw ContractError.invalid }
            guard PhoneAskContract.text(name, 1, 255) else { throw ContractError.invalid }
            guard (imageMimes + fileMimes).contains(mime) else { throw ContractError.invalid }
            guard (0...9007199254740991).contains(bytes) else { throw ContractError.invalid }
            guard matches(sha256, "[0-9a-f]{64}") else { throw ContractError.invalid }
        }
    }

    public struct ShareManifest: Codable, Equatable {
        public let shareId: String
        public let botId: String
        public let threadId: String
        public let note: String?
        public let text: String?
        public let url: String?
        public let items: [ShareItem]

        public init(shareId: String, botId: String, threadId: String, note: String? = nil, text: String? = nil, url: String? = nil, items: [ShareItem]) throws {
            self.shareId = shareId
            self.botId = botId
            self.threadId = threadId
            self.note = note
            self.text = text
            self.url = url
            self.items = items
            try validate()
        }
        private enum CodingKeys: String, CodingKey { case shareId, botId, threadId, note, text, url, items }
        public init(from decoder: Decoder) throws {
            try checkKeys(decoder, ["shareId", "botId", "threadId", "note", "text", "url", "items"])
            let c = try decoder.container(keyedBy: CodingKeys.self)
            shareId = try c.decode(String.self, forKey: .shareId)
            botId = try c.decode(String.self, forKey: .botId)
            threadId = try c.decode(String.self, forKey: .threadId)
            note = c.contains(.note) ? try c.decode(String.self, forKey: .note) : nil
            text = c.contains(.text) ? try c.decode(String.self, forKey: .text) : nil
            url = c.contains(.url) ? try c.decode(String.self, forKey: .url) : nil
            items = try c.decode([ShareItem].self, forKey: .items)
            try validate()
        }
        public func encode(to encoder: Encoder) throws {
            try validate()
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(shareId, forKey: .shareId)
            try c.encode(botId, forKey: .botId)
            try c.encode(threadId, forKey: .threadId)
            try c.encodeIfPresent(note, forKey: .note)
            try c.encodeIfPresent(text, forKey: .text)
            try c.encodeIfPresent(url, forKey: .url)
            try c.encode(items, forKey: .items)
        }
        fileprivate func validate() throws {
            guard matches(shareId, "[A-Za-z0-9_-]{16,80}") else { throw ContractError.invalid }
            guard PhoneAskContract.text(botId, 1, 128) else { throw ContractError.invalid }
            guard (threadId == "new" || matches(threadId, uuid)) else { throw ContractError.invalid }
            if let note { guard PhoneAskContract.text(note, 1, 2000) else { throw ContractError.invalid } }
            if let text { guard PhoneAskContract.text(text, 1, 1048576) else { throw ContractError.invalid } }
            if let url { guard (PhoneAskContract.text(url, 0, 2048) && matches(url, "https?://[^\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+")) else { throw ContractError.invalid } }
            guard items.count <= 10 else { throw ContractError.invalid }
            for value in items { try value.validate() }
            guard note != nil || text != nil || url != nil || !items.isEmpty,
                  items.enumerated().allSatisfy({ $0.element.n == $0.offset + 1 }) else { throw ContractError.invalid }
        }
    }

    public struct AskRequest: Codable, Equatable {
        public let askId: String
        public let botId: String
        public let text: String

        public init(askId: String, botId: String, text: String) throws {
            self.askId = askId
            self.botId = botId
            self.text = text
            try validate()
        }
        private enum CodingKeys: String, CodingKey { case askId, botId, text }
        public init(from decoder: Decoder) throws {
            try checkKeys(decoder, ["askId", "botId", "text"])
            let c = try decoder.container(keyedBy: CodingKeys.self)
            askId = try c.decode(String.self, forKey: .askId)
            botId = try c.decode(String.self, forKey: .botId)
            text = try c.decode(String.self, forKey: .text)
            try validate()
        }
        public func encode(to encoder: Encoder) throws {
            try validate()
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(askId, forKey: .askId)
            try c.encode(botId, forKey: .botId)
            try c.encode(text, forKey: .text)
        }
        fileprivate func validate() throws {
            guard matches(askId, "[A-Za-z0-9_-]{16,80}") else { throw ContractError.invalid }
            guard PhoneAskContract.text(botId, 1, 128) else { throw ContractError.invalid }
            guard PhoneAskContract.text(text, 1, 1048576) else { throw ContractError.invalid }
        }
    }

    public struct TokenRequest: Codable, Equatable {
        public let keyId: String
        public let nonce: String
        public let expiresAt: Int64
        public let signature: String
        public let scope: String?

        public init(keyId: String, nonce: String, expiresAt: Int64, signature: String, scope: String? = nil) throws {
            self.keyId = keyId
            self.nonce = nonce
            self.expiresAt = expiresAt
            self.signature = signature
            self.scope = scope
            try validate()
        }
        private enum CodingKeys: String, CodingKey { case keyId, nonce, expiresAt, signature, scope }
        public init(from decoder: Decoder) throws {
            try checkKeys(decoder, ["keyId", "nonce", "expiresAt", "signature", "scope"])
            let c = try decoder.container(keyedBy: CodingKeys.self)
            keyId = try c.decode(String.self, forKey: .keyId)
            nonce = try c.decode(String.self, forKey: .nonce)
            expiresAt = try c.decode(Int64.self, forKey: .expiresAt)
            signature = try c.decode(String.self, forKey: .signature)
            scope = c.contains(.scope) ? try c.decode(String.self, forKey: .scope) : nil
            try validate()
        }
        public func encode(to encoder: Encoder) throws {
            try validate()
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(keyId, forKey: .keyId)
            try c.encode(nonce, forKey: .nonce)
            try c.encode(expiresAt, forKey: .expiresAt)
            try c.encode(signature, forKey: .signature)
            try c.encodeIfPresent(scope, forKey: .scope)
        }
        fileprivate func validate() throws {
            guard matches(keyId, "[A-Za-z0-9_-]{43}") else { throw ContractError.invalid }
            guard matches(nonce, "[A-Za-z0-9_-]{43}") else { throw ContractError.invalid }
            guard (1...9007199254740991).contains(expiresAt) else { throw ContractError.invalid }
            guard matches(signature, "[A-Za-z0-9_-]{16,200}") else { throw ContractError.invalid }
            if let scope { guard ["jobs", "ask"].contains(scope) else { throw ContractError.invalid } }
        }
    }

    public struct TargetBot: Codable, Equatable {
        public let id: String
        public let name: String
        public let avatar: String?
        public let mainThreadId: String

        public init(id: String, name: String, avatar: String?, mainThreadId: String) throws {
            self.id = id
            self.name = name
            self.avatar = avatar
            self.mainThreadId = mainThreadId
            try validate()
        }
        private enum CodingKeys: String, CodingKey { case id, name, avatar, mainThreadId }
        public init(from decoder: Decoder) throws {
            try checkKeys(decoder, ["id", "name", "avatar", "mainThreadId"])
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            name = try c.decode(String.self, forKey: .name)
            guard c.contains(.avatar) else { throw ContractError.invalid }
            avatar = try c.decodeIfPresent(String.self, forKey: .avatar)
            mainThreadId = try c.decode(String.self, forKey: .mainThreadId)
            try validate()
        }
        public func encode(to encoder: Encoder) throws {
            try validate()
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(id, forKey: .id)
            try c.encode(name, forKey: .name)
            try c.encode(avatar, forKey: .avatar)
            try c.encode(mainThreadId, forKey: .mainThreadId)
        }
        fileprivate func validate() throws {
            guard PhoneAskContract.text(id, 1, 128) else { throw ContractError.invalid }
            guard PhoneAskContract.text(name, 1, 120) else { throw ContractError.invalid }
            guard PhoneAskContract.text(mainThreadId, 1, 128) else { throw ContractError.invalid }
        }
    }

    public struct RecentTarget: Codable, Equatable {
        public let botId: String
        public let threadId: String
        public let title: String
        public let at: Int64

        public init(botId: String, threadId: String, title: String, at: Int64) throws {
            self.botId = botId
            self.threadId = threadId
            self.title = title
            self.at = at
            try validate()
        }
        private enum CodingKeys: String, CodingKey { case botId, threadId, title, at }
        public init(from decoder: Decoder) throws {
            try checkKeys(decoder, ["botId", "threadId", "title", "at"])
            let c = try decoder.container(keyedBy: CodingKeys.self)
            botId = try c.decode(String.self, forKey: .botId)
            threadId = try c.decode(String.self, forKey: .threadId)
            title = try c.decode(String.self, forKey: .title)
            at = try c.decode(Int64.self, forKey: .at)
            try validate()
        }
        public func encode(to encoder: Encoder) throws {
            try validate()
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(botId, forKey: .botId)
            try c.encode(threadId, forKey: .threadId)
            try c.encode(title, forKey: .title)
            try c.encode(at, forKey: .at)
        }
        fileprivate func validate() throws {
            guard PhoneAskContract.text(botId, 1, 128) else { throw ContractError.invalid }
            guard PhoneAskContract.text(threadId, 1, 128) else { throw ContractError.invalid }
            guard PhoneAskContract.text(title, 0, 200) else { throw ContractError.invalid }
            guard (0...9007199254740991).contains(at) else { throw ContractError.invalid }
        }
    }

    public struct TargetsAnswer: Codable, Equatable {
        public let workspace: String
        public let bots: [TargetBot]
        public let recent: [RecentTarget]

        public init(workspace: String, bots: [TargetBot], recent: [RecentTarget]) throws {
            self.workspace = workspace
            self.bots = bots
            self.recent = recent
            try validate()
        }
        private enum CodingKeys: String, CodingKey { case workspace, bots, recent }
        public init(from decoder: Decoder) throws {
            try checkKeys(decoder, ["workspace", "bots", "recent"])
            let c = try decoder.container(keyedBy: CodingKeys.self)
            workspace = try c.decode(String.self, forKey: .workspace)
            bots = try c.decode([TargetBot].self, forKey: .bots)
            recent = try c.decode([RecentTarget].self, forKey: .recent)
            try validate()
        }
        public func encode(to encoder: Encoder) throws {
            try validate()
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(workspace, forKey: .workspace)
            try c.encode(bots, forKey: .bots)
            try c.encode(recent, forKey: .recent)
        }
        fileprivate func validate() throws {
            guard PhoneAskContract.text(workspace, 0, 120) else { throw ContractError.invalid }
            for value in bots { try value.validate() }
            guard recent.count <= 8 else { throw ContractError.invalid }
            for value in recent { try value.validate() }
        }
    }

    public struct ShareSent: Codable, Equatable {
        public let state: String
        public let threadId: String
        public let messageId: String?
        public let queueId: String?

        public init(state: String, threadId: String, messageId: String? = nil, queueId: String? = nil) throws {
            self.state = state
            self.threadId = threadId
            self.messageId = messageId
            self.queueId = queueId
            try validate()
        }
        private enum CodingKeys: String, CodingKey { case state, threadId, messageId, queueId }
        public init(from decoder: Decoder) throws {
            try checkKeys(decoder, ["state", "threadId", "messageId", "queueId"])
            let c = try decoder.container(keyedBy: CodingKeys.self)
            state = try c.decode(String.self, forKey: .state)
            threadId = try c.decode(String.self, forKey: .threadId)
            messageId = c.contains(.messageId) ? try c.decode(String.self, forKey: .messageId) : nil
            queueId = c.contains(.queueId) ? try c.decode(String.self, forKey: .queueId) : nil
            try validate()
        }
        public func encode(to encoder: Encoder) throws {
            try validate()
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(state, forKey: .state)
            try c.encode(threadId, forKey: .threadId)
            try c.encodeIfPresent(messageId, forKey: .messageId)
            try c.encodeIfPresent(queueId, forKey: .queueId)
        }
        fileprivate func validate() throws {
            guard ["sent"].contains(state) else { throw ContractError.invalid }
        }
    }

    public struct AskSent: Codable, Equatable {
        public let state: String
        public let askId: String
        public let threadId: String
        public let id: String
        public let notify: Bool

        public init(state: String, askId: String, threadId: String, id: String, notify: Bool) throws {
            self.state = state
            self.askId = askId
            self.threadId = threadId
            self.id = id
            self.notify = notify
            try validate()
        }
        private enum CodingKeys: String, CodingKey { case state, askId, threadId, id, notify }
        public init(from decoder: Decoder) throws {
            try checkKeys(decoder, ["state", "askId", "threadId", "id", "notify"])
            let c = try decoder.container(keyedBy: CodingKeys.self)
            state = try c.decode(String.self, forKey: .state)
            askId = try c.decode(String.self, forKey: .askId)
            threadId = try c.decode(String.self, forKey: .threadId)
            id = try c.decode(String.self, forKey: .id)
            notify = try c.decode(Bool.self, forKey: .notify)
            try validate()
        }
        public func encode(to encoder: Encoder) throws {
            try validate()
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(state, forKey: .state)
            try c.encode(askId, forKey: .askId)
            try c.encode(threadId, forKey: .threadId)
            try c.encode(id, forKey: .id)
            try c.encode(notify, forKey: .notify)
        }
        fileprivate func validate() throws {
            guard ["sent"].contains(state) else { throw ContractError.invalid }
        }
    }

    public struct ShareFailure: Codable, Equatable {
        public let error: String
        public let code: String

        public init(error: String, code: String) throws {
            self.error = error
            self.code = code
            try validate()
        }
        private enum CodingKeys: String, CodingKey { case error, code }
        public init(from decoder: Decoder) throws {
            try checkKeys(decoder, ["error", "code"])
            let c = try decoder.container(keyedBy: CodingKeys.self)
            error = try c.decode(String.self, forKey: .error)
            code = try c.decode(String.self, forKey: .code)
            try validate()
        }
        public func encode(to encoder: Encoder) throws {
            try validate()
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(error, forKey: .error)
            try c.encode(code, forKey: .code)
        }
        fileprivate func validate() throws {
            guard ["conflict", "target_gone", "too_large", "unsupported_type", "invalid", "revoked"].contains(code) else { throw ContractError.invalid }
        }
    }

    public struct AskFailure: Codable, Equatable {
        public let error: String
        public let code: String

        public init(error: String, code: String) throws {
            self.error = error
            self.code = code
            try validate()
        }
        private enum CodingKeys: String, CodingKey { case error, code }
        public init(from decoder: Decoder) throws {
            try checkKeys(decoder, ["error", "code"])
            let c = try decoder.container(keyedBy: CodingKeys.self)
            error = try c.decode(String.self, forKey: .error)
            code = try c.decode(String.self, forKey: .code)
            try validate()
        }
        public func encode(to encoder: Encoder) throws {
            try validate()
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(error, forKey: .error)
            try c.encode(code, forKey: .code)
        }
        fileprivate func validate() throws {
            guard ["conflict", "target_gone", "invalid", "revoked"].contains(code) else { throw ContractError.invalid }
        }
    }

    public enum ShareAnswer: Codable, Equatable {
        case sent(ShareSent)
        case failure(ShareFailure)
        public init(from decoder: Decoder) throws {
            let keys = try decoder.container(keyedBy: Key.self).allKeys.map(\.stringValue)
            if keys.contains("error") { self = .failure(try ShareFailure(from: decoder)) }
            else { self = .sent(try ShareSent(from: decoder)) }
        }
        public func encode(to encoder: Encoder) throws {
            switch self {
            case .sent(let body): try body.encode(to: encoder)
            case .failure(let body): try body.encode(to: encoder)
            }
        }
    }

    public enum AskAnswer: Codable, Equatable {
        case sent(AskSent)
        case failure(AskFailure)
        public init(from decoder: Decoder) throws {
            let keys = try decoder.container(keyedBy: Key.self).allKeys.map(\.stringValue)
            if keys.contains("error") { self = .failure(try AskFailure(from: decoder)) }
            else { self = .sent(try AskSent(from: decoder)) }
        }
        public func encode(to encoder: Encoder) throws {
            switch self {
            case .sent(let body): try body.encode(to: encoder)
            case .failure(let body): try body.encode(to: encoder)
            }
        }
    }
}
