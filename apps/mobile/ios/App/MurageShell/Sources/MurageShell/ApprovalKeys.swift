#if os(iOS)
import CryptoKit
import Foundation
import LocalAuthentication
import MurageShellCore
import UIKit

/// SEC-006: one approval key per paired computer, made at pairing. The
/// Secure Enclave key needs the owner's presence (Face ID, Touch ID or the
/// passcode) for every signature and is gone if the passcode is removed.
/// Not exportable and ThisDeviceOnly, so there is no backup of it.
/// Nothing here is logged: no key bytes, signatures or nonces.
///
/// The Secure Enclave and LAContext paths cannot run in a macOS unit test, so
/// this file stays thin: the bytes signed come from ApprovalRequest.message
/// (MurageShellCore, tested) and the rest is the platform calls.
@MainActor
enum ApprovalKeys {
    enum Failure: String, Error { case cancelled, noLock = "no_lock", noKey = "no_key", unavailable }

    private static func item(_ origin: WorkspaceOrigin) -> KeychainItem {
        KeychainItem(service: "com.murage.mobile.approval", account: origin.serialized)
    }

    /// The new key's public point (base64url), or nil with no passcode or no Secure Enclave.
    static func enrol(origin: WorkspaceOrigin) -> String? {
        var policyError: NSError?
        guard LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else { return nil }
        #if targetEnvironment(simulator)
        // The simulator has no Secure Enclave. Its software key lets the e2e
        // exercise the prompt; release device builds never compile this.
        let key = P256.Signing.PrivateKey()
        guard item(origin).write(key.rawRepresentation) else { return nil }
        return ApprovalProof.base64url(key.publicKey.x963Representation)
        #else
        guard SecureEnclave.isAvailable,
              let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.privateKeyUsage, .userPresence], nil),
              let key = try? SecureEnclave.P256.Signing.PrivateKey(accessControl: access),
              item(origin).write(key.dataRepresentation) else { return nil }
        return ApprovalProof.base64url(key.publicKey.x963Representation)
        #endif
    }

    static func remove(origin: WorkspaceOrigin) { _ = item(origin).delete() }

    /// DER signature (base64url) over the request's exact message bytes.
    static func sign(origin: WorkspaceOrigin, request: ApprovalRequest) async -> Result<String, Failure> {
        let context = LAContext()
        context.touchIDAuthenticationAllowableReuseDuration = 0
        var policy: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policy) else {
            return .failure((policy as? LAError)?.code == .passcodeNotSet ? .noLock : .unavailable)
        }
        guard case .found(let blob) = item(origin).read() else { return .failure(.noKey) }
        defer { context.invalidate() }
        do {
            try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: request.reason)
            #if targetEnvironment(simulator)
            let key = try P256.Signing.PrivateKey(rawRepresentation: blob)
            #else
            let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context)
            #endif
            return .success(ApprovalProof.base64url(try key.signature(for: request.message).derRepresentation))
        } catch let error as LAError where [.userCancel, .appCancel, .systemCancel, .userFallback].contains(error.code) {
            return .failure(.cancelled)
        } catch let error as LAError where error.code == .passcodeNotSet {
            return .failure(.noLock)
        } catch is CryptoKitError {
            return .failure(.noKey) // the blob no longer opens on this device
        } catch {
            return .failure(.unavailable)
        }
    }
}
#endif
