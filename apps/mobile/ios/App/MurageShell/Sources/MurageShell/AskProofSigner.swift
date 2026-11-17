#if os(iOS)
import Foundation
import MurageShellCore

/// The one public door to the approval key for ask proofs. `ApprovalKeys` stays
/// internal. This takes only the typed request Core builds from server-supplied
/// challenge fields and the text the owner saw, never arbitrary bytes.
@MainActor
public enum AskProofSigner {
    /// The enrolled approval key's id, or nil with no key. Never prompts or enrols.
    public static func keyId(origin: WorkspaceOrigin) -> String? {
        ApprovalKeys.phoneJobsPoint(origin: origin).flatMap { PhoneJobsContract.approvalKeyId(point: $0) }
    }

    /// Face ID or passcode, then the signature (base64url DER) for exactly this request.
    public static func sign(_ signing: AskProofSigning) async -> Result<String, AskProofFailure> {
        switch await ApprovalKeys.signAskProof(signing: signing) {
        case .success(let signature): return .success(signature)
        case .failure(.cancelled): return .failure(.cancelled)
        case .failure(.noKey), .failure(.noLock): return .failure(.noKey)
        case .failure(.unavailable): return .failure(.unavailable)
        }
    }

    /// The injected steps for AskIntentRun. The pin is read only here: it is written at pairing (mint), never by an ask. `confirm` shows pre-filled text in
    /// full; `beforeSigning` is the foreground hop for the Face ID step and
    /// answers false when the owner declines it (then the ask goes plain).
    public static func steps(pin: AskDevicePin, confirm: @escaping (String) async -> Bool,
                             beforeSigning: @escaping () async -> Bool) -> AskProofSteps {
        AskProofSteps(
            keyId: { keyId(origin: $0) },
            pairedDeviceId: { origin in keyId(origin: origin).flatMap { pin.paired(origin: origin, keyId: $0) } },
            confirm: confirm,
            sign: { signing in
                guard await beforeSigning() else { return .failure(.declined) }
                return await sign(signing)
            })
    }
}
#endif
