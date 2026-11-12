import CryptoKit
import Foundation

/// Why a proof step ended without a signature. Every case sends the plain ask.
public enum AskProofFailure: String, Error, Equatable, Sendable {
    case cancelled, noKey = "no_key", unavailable, declined
}

/// The bytes the owner's approval key may sign for one ask, and nothing else.
/// Only `AskProof.prepare` makes one, and only after it recomputed the digest
/// from the text the owner saw, the bot, the thread, this phone's device id and
/// the askId (design 8.6). The signing facade takes this type, never raw bytes.
public struct AskProofSigning: Equatable {
    public let origin: WorkspaceOrigin
    public let message: Data
    public let nonce: String
    /// The bot's own name exactly as the host sent it (a ZWJ emoji keeps its joiners). Never a literal.
    public let botName: String
    fileprivate init(origin: WorkspaceOrigin, message: Data, nonce: String, botName: String) {
        self.origin = origin; self.message = message; self.nonce = nonce; self.botName = botName
    }
    /// The Face ID reason text. Only here is the name stripped of format (Cf) characters, so the system prompt shows it cleanly.
    public var faceIdReason: String {
        AskProofStrings.render(AskProof.reason, botName: AskProofStrings.withoutFormatCharacters(botName))
    }
}

/// D8 owner proof for phone asks. No new crypto: the signed message is the
/// existing ApprovalRequest message with a disjoint request id and digest.
public enum AskProof {
    /// Keeps ask digests disjoint from card digests.
    public static let digestTag = "murage-ask/1"
    /// The English text is also the localization key. Shown by Face ID.
    public static let reason = "Send to %@ as you"
    public static let requestIdPrefix = "ask:"

    public enum Refusal: Error, Equatable { case deviceMismatch, digestMismatch, expired, invalid }

    static func sha256Hex(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// sha256(["murage-ask/1", deviceId, askId, botId, threadId, sha256hex(text)].join("\n")).
    /// `text` is the raw text the owner saw and the request carries.
    public static func digest(deviceId: String, askId: String, botId: String, threadId: String, text: String) -> String {
        sha256Hex([digestTag, deviceId, askId, botId, threadId, sha256Hex(text)].joined(separator: "\n"))
    }

    /// `pairedDeviceId` is the id pinned at pairing (AskDevicePin). A mismatch
    /// with the id the harness stamped, a digest that does not match what the
    /// phone computes, or an expired challenge all refuse to sign.
    public static func prepare(origin: WorkspaceOrigin, confirm: PhoneAskContract.AskConfirm, pairedDeviceId: String,
                               askId: String, botId: String, botName: String, text: String, now: Int64) -> Result<AskProofSigning, Refusal> {
        guard pairedDeviceId == confirm.deviceId else { return .failure(.deviceMismatch) }
        let expected = digest(deviceId: confirm.deviceId, askId: askId, botId: botId, threadId: confirm.threadId, text: text)
        guard expected == confirm.challenge.digest else { return .failure(.digestMismatch) }
        guard confirm.challenge.expiresAt > now else { return .failure(.expired) }
        // A format character (a ZWJ emoji) would make ApprovalRequest.parse refuse the reason and so silently drop the ask to plain, so the
        // reason text carries the stripped name. AskProofSigning.botName keeps the original; faceIdReason strips it again for the prompt.
        let shownName = AskProofStrings.withoutFormatCharacters(botName)
        let args: [String: Any] = [
            "v": NSNumber(value: 1),
            "threadId": confirm.threadId,
            "requestId": requestIdPrefix + askId,
            "decision": confirm.challenge.decision,
            "digest": expected,
            "nonce": confirm.challenge.nonce,
            "expiresAt": NSNumber(value: confirm.challenge.expiresAt),
            "reason": AskProofStrings.render(reason, botName: shownName, bundle: .main),
        ]
        // Same validation the approval card path uses (ApprovalRequest.parse).
        guard let request = ApprovalRequest.parse(args) else { return .failure(.invalid) }
        return .success(AskProofSigning(origin: origin, message: request.message, nonce: confirm.challenge.nonce, botName: botName))
    }
}

/// What the ask run needs from the app for the proof step. All injected, so the
/// run is testable on the Mac with no Face ID.
public struct AskProofSteps {
    /// The approval key's id, or nil when this phone holds no key (plain ask).
    public let keyId: (WorkspaceOrigin) -> String?
    /// The device id pinned at pairing, nil for a phone paired before pinning
    /// existed (its signed asks fail closed onto the plain path).
    public let pairedDeviceId: (WorkspaceOrigin) -> String?
    /// Shows the full text and answers whether the owner agreed to send it.
    public let confirm: (String) async -> Bool
    /// Face ID (or passcode) then the signature, for exactly this request.
    public let sign: (AskProofSigning) async -> Result<String, AskProofFailure>

    public init(keyId: @escaping (WorkspaceOrigin) -> String?,
                pairedDeviceId: @escaping (WorkspaceOrigin) -> String?,
                confirm: @escaping (String) async -> Bool,
                sign: @escaping (AskProofSigning) async -> Result<String, AskProofFailure>) {
        self.keyId = keyId; self.pairedDeviceId = pairedDeviceId
        self.confirm = confirm; self.sign = sign
    }
}

/// The device id the harness issued at pairing, pinned from the mint answer and
/// never from an ask. Kept per approval key, so a re-pair (new key) starts clean.
/// Nothing in an ask run can write it. No credentials.
public struct AskDevicePin {
    private let defaults: UserDefaults?
    public init(defaults: UserDefaults?) { self.defaults = defaults }
    private func key(_ origin: WorkspaceOrigin, _ keyId: String) -> String { "ask.deviceId." + origin.serialized + "|" + keyId }
    public static func validDeviceId(_ value: String) -> Bool { PhoneAskContract.matches(value, "[A-Za-z0-9_-]{1,128}") }
    public func paired(origin: WorkspaceOrigin, keyId: String) -> String? { defaults?.string(forKey: key(origin, keyId)) }
    /// Pairing only: called by the mint client with the id from the mint answer.
    public func pin(origin: WorkspaceOrigin, keyId: String, deviceId: String) {
        guard Self.validDeviceId(deviceId) else { return }
        defaults?.set(deviceId, forKey: key(origin, keyId))
        // A re-pair that pinned an id ends the re-pair line for this pairing.
        defaults?.removeObject(forKey: AskRePairHint.key(origin, keyId))
    }
}

/// The mint answer: the bearer and, from a harness that issues one, the device id.
public struct AskMintAnswer: Equatable {
    public let token: String
    public let deviceId: String?
    /// Strict: no other key. A present `deviceId` must be well formed. The caller checks the token's shape for its scope.
    public static func parse(_ json: [String: Any]) -> AskMintAnswer? {
        guard Set(json.keys).isSubset(of: ["token", "deviceId"]), let token = json["token"] as? String else { return nil }
        guard let raw = json["deviceId"] else { return AskMintAnswer(token: token, deviceId: nil) }
        guard let id = raw as? String, AskDevicePin.validDeviceId(id) else { return nil }
        return AskMintAnswer(token: token, deviceId: id)
    }
}

/// An ask that got no answer. The next run of the same text to the same bot
/// reuses its askId for a short while, so a lost answer never sends twice.
/// Stores a hash of the text, never the text.
public struct AskPendingAsk {
    public static let ttlMs: Int64 = 15 * 60 * 1000
    private let defaults: UserDefaults?
    public init(defaults: UserDefaults?) { self.defaults = defaults }
    private func key(_ origin: WorkspaceOrigin, _ botId: String) -> String { "ask.pending." + origin.serialized + "|" + botId }
    public func askId(origin: WorkspaceOrigin, botId: String, text: String, now: Int64) -> String? {
        guard let row = defaults?.dictionary(forKey: key(origin, botId)),
              row["h"] as? String == AskProof.sha256Hex(text), let at = row["at"] as? Int64, let id = row["id"] as? String,
              now >= at, now - at <= Self.ttlMs, PhoneAskContract.matches(id, "[A-Za-z0-9_-]{16,80}") else { return nil }
        return id
    }
    public func record(origin: WorkspaceOrigin, botId: String, text: String, askId: String, now: Int64) {
        defaults?.set(["h": AskProof.sha256Hex(text), "at": now, "id": askId] as [String: Any], forKey: key(origin, botId))
    }
    public func clear(origin: WorkspaceOrigin, botId: String) { defaults?.removeObject(forKey: key(origin, botId)) }
}

/// Strings added by D8 that are not an AskDialog case. Listed once so the
/// inventory test checks every locale for every one of them.
public enum AskProofStrings {
    /// Every string below that holds %@ takes the bot's own name. Sable is never a literal.
    public static let confirmTitle = "Send this to %@ as you?"
    public static let confirmInApp = "Confirm in Murage"
    public static let waitedTooLong = "Sent to %@ without your recent chat (it waited too long)."
    /// The hint for a phone paired before the device id was pinned. One constant, shown on the phone's pairing screen.
    public static let repairHint = "Pair this phone again so %@ can see your recent chat when you send from it."
    public static let all: [String] = [AskProof.reason, confirmTitle, confirmInApp, waitedTooLong, repairHint]
    /// The name without Unicode format (Cf) characters: ZWJ, bidi controls, zero-width characters. For the reason text only.
    public static func withoutFormatCharacters(_ name: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in name.unicodeScalars where scalar.properties.generalCategory != .format { scalars.append(scalar) }
        return String(scalars)
    }
    /// The localized string with the bot's name in place of %@.
    public static func render(_ key: String, botName: String, bundle: Bundle = .main) -> String {
        String(format: bundle.localizedString(forKey: key, value: key, table: nil), botName)
    }
}
