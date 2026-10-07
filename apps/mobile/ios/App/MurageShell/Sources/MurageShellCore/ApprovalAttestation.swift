import CryptoKit
import Foundation

/// SEC-006 decision 8 (P9), phone side without UIKit: one attestation at pairing,
/// over a nonce that names the approval key, so the relay can sign a statement
/// that the key lives in the genuine app. The statement, the key, the challenge
/// and the nonce are never logged here.
public enum ApprovalAttestation {
    private static let tag = "murage-approval-key/1"

    /// Lowercase hex SHA-256 of the 65 raw key bytes; nil unless the key is an
    /// uncompressed P-256 point in base64url.
    public static func keyHash(approvalKey: String) -> String? {
        guard let point = decodeBase64url(approvalKey), point.count == 65, point[point.startIndex] == 0x04 else { return nil }
        return SHA256.hash(data: point).map { String(format: "%02x", $0) }.joined()
    }

    /// Unpadded base64url of SHA-256(utf8 of `murage-approval-key/1\n<challenge>\n<installId>\n<keyHash>`):
    /// the relay's `approvalBindingNonce` (src/approval-statement.ts).
    public static func bindingNonce(challenge: String, installId: String, approvalKey: String) -> String? {
        guard let hash = keyHash(approvalKey: approvalKey) else { return nil }
        let digest = SHA256.hash(data: Data([tag, challenge, installId, hash].joined(separator: "\n").utf8))
        return ApprovalProof.base64url(Data(digest))
    }

    /// The relay's challenge shape: 43 base64url characters.
    private static func validChallenge(_ value: String?) -> Bool {
        guard let value else { return false }
        return value.unicodeScalars.count == 43 && PairingLink.validCredential(value)
    }

    /// One attempt: challenge, attest the binding nonce, ask for the statement.
    /// nil on any miss (unsupported device, no network, a refusal, a slow relay,
    /// the 5 per install per hour limit), and the caller pairs without a key.
    /// The whole attempt is capped by `budget` so a slow relay cannot let the
    /// pairing code expire.
    @MainActor
    public static func statement(transport: RelayTransport, attester: PushAttester, environment: String, installId: String, approvalKey: String,
                                 budget: Duration = .seconds(10)) async -> String? {
        guard attester.isSupported else { return nil }
        // A hard cap: whichever of the attempt and the deadline finishes first resumes
        // the caller, once. The loser is cancelled and never awaited, so an App Attest or
        // relay call that ignores cancellation cannot hold pairing past the budget.
        return await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
            let race = Race(continuation)
            race.work = Task { @MainActor in
                let result = await attempt(transport: transport, attester: attester, environment: environment, installId: installId, approvalKey: approvalKey)
                race.finish(result)
            }
            race.timer = Task { @MainActor in
                try? await Task.sleep(for: budget)
                if !Task.isCancelled { race.finish(nil) }
            }
        }
    }

    /// Resumes its continuation exactly once; the first caller wins. Main actor only.
    @MainActor private final class Race {
        private var continuation: CheckedContinuation<String?, Never>?
        var work: Task<Void, Never>?
        var timer: Task<Void, Never>?
        init(_ continuation: CheckedContinuation<String?, Never>) { self.continuation = continuation }
        func finish(_ value: String?) {
            guard let continuation else { return }
            self.continuation = nil
            continuation.resume(returning: value)
            work?.cancel()
            timer?.cancel()
        }
    }

    @MainActor
    private static func attempt(transport: RelayTransport, attester: PushAttester, environment: String, installId: String, approvalKey: String) async -> String? {
        let asked = await transport.send(.challenge())
        guard asked.status == RelayRequest.challenge().ok, let challenge = asked.body?["challenge"] as? String, validChallenge(challenge),
              let nonce = bindingNonce(challenge: challenge, installId: installId, approvalKey: approvalKey),
              let proof = await attester.attest(challenge: nonce), !Task.isCancelled else { return nil }
        let request = RelayRequest.approvalStatement(environment: environment, challenge: challenge, installId: installId, approvalKey: approvalKey,
                                                     keyId: proof.keyId, attestationObject: proof.attestationObject)
        let made = await transport.send(request)
        guard made.status == request.ok, let statement = made.body?["statement"] as? String, PairingLink.validApprovalStatement(statement) else { return nil }
        return statement
    }

    /// The pairing path. A key travels only with its statement: with no valid
    /// statement the link carries neither (the desktop drops a bare key, and the
    /// phone tells the owner to pair again for approvals).
    public static func enterPath(credential: String, installId: String?, approvalKey: String?, approvalStatement: String?) -> String? {
        if let approvalKey, let approvalStatement, PairingLink.validApprovalStatement(approvalStatement) {
            return PairingLink.enterPath(credential: credential, installId: installId, approvalKey: approvalKey, approvalStatement: approvalStatement)
        }
        return PairingLink.enterPath(credential: credential, installId: installId)
    }

    private static func decodeBase64url(_ value: String) -> Data? {
        var text = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard !text.contains("=") else { return nil }
        text += String(repeating: "=", count: (4 - text.count % 4) % 4)
        return Data(base64Encoded: text)
    }
}
