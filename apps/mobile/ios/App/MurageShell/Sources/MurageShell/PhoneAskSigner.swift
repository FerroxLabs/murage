import Foundation
import MurageShellCore

/// App-only mint signer. The bridge has no reference to this type. Its key
/// adapter accepts a typed request, never arbitrary bytes from a caller.
@MainActor
final class PhoneAskSigner: PhoneMintSigning {
    nonisolated static let tag = "murage-phone-ask/1"

    struct Request {
        let origin: WorkspaceOrigin
        let keyId: String
        let nonce: String
        let expiresAt: Int64

        fileprivate init(origin: WorkspaceOrigin, keyId: String, nonce: String, expiresAt: Int64) {
            self.origin = origin; self.keyId = keyId; self.nonce = nonce; self.expiresAt = expiresAt
        }

        var message: Data {
            // Reuse N9's byte contract, with our purpose pinned independently.
            precondition(PhoneAskContract.tag == PhoneAskSigner.tag)
            return Data(PhoneAskContract.phoneAskMessage(origin: origin.serialized, keyId: keyId,
                                                         nonce: nonce, expiresAt: expiresAt).utf8)
        }
    }

    private let point: (WorkspaceOrigin) -> String?
    private let authenticateAndSign: (Request) async throws -> String

    init(point: @escaping (WorkspaceOrigin) -> String?, authenticateAndSign: @escaping (Request) async throws -> String) {
        self.point = point; self.authenticateAndSign = authenticateAndSign
    }

    func keyId(origin: WorkspaceOrigin) -> String? {
        point(origin).flatMap { PhoneJobsContract.approvalKeyId(point: $0) }
    }

    /// Re-check the key after the challenge: a re-pair must not sign for the old key.
    func sign(origin: WorkspaceOrigin, keyId: String, nonce: String, expiresAt: Int64) async throws -> String {
        guard self.keyId(origin: origin) == keyId else { throw PhoneJobsMintError.noApprovalKey }
        guard nonce.utf8.count == 43, nonce.utf8.allSatisfy(Self.base64urlByte),
              expiresAt > 0, expiresAt <= 9_007_199_254_740_991 else { throw PhoneJobsMintError.invalidResponse }
        return try await authenticateAndSign(Request(origin: origin, keyId: keyId, nonce: nonce, expiresAt: expiresAt))
    }

    private static func base64urlByte(_ b: UInt8) -> Bool {
        (48...57).contains(b) || (65...90).contains(b) || (97...122).contains(b) || b == 45 || b == 95
    }
}

#if os(iOS)
extension PhoneAskSigner {
    static func enrolled() -> PhoneAskSigner {
        PhoneAskSigner(point: ApprovalKeys.phoneJobsPoint) { request in
            switch await ApprovalKeys.signPhoneAsk(request: request) {
            case .success(let signature): return signature
            case .failure(.noKey), .failure(.noLock): throw PhoneJobsMintError.noApprovalKey
            case .failure(.cancelled): throw PhoneJobsMintError.cancelled
            case .failure(.unavailable): throw PhoneJobsMintError.unavailable
            }
        }
    }
}
#endif
