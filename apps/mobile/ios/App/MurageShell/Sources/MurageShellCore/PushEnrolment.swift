import Foundation

/// One phone call to the relay (cloudflare/push-relay/src/relay.ts), as
/// contract/relay-requests.json lists them. `ok` is the one status that
/// means success; anything else, a 3xx included, is a refusal.
public struct RelayRequest {
    public let method: String
    public let path: String
    public let bearer: String?
    public let body: [String: Any]?
    public let ok: Int

    public static func challenge() -> RelayRequest {
        RelayRequest(method: "POST", path: "/v1/challenges", bearer: nil, body: nil, ok: 201)
    }
    public static func registerDevice(environment: String, pushToken: String, challenge: String, keyId: String, attestationObject: String) -> RelayRequest {
        RelayRequest(method: "POST", path: "/v1/devices", bearer: nil, body: [
            "platform": "ios", "environment": environment, "pushToken": pushToken, "challenge": challenge,
            "attestation": ["kind": "app-attest", "keyId": keyId, "attestationObject": attestationObject],
        ], ok: 201)
    }
    /// SEC-006 decision 8: the relay's statement that `approvalKey` was named in a
    /// genuine App Attest attestation (cloudflare/push-relay/src/relay.ts). 201 `{statement, expiresAt}`.
    public static func approvalStatement(environment: String, challenge: String, installId: String, approvalKey: String, keyId: String, attestationObject: String) -> RelayRequest {
        RelayRequest(method: "POST", path: "/v1/approval-keys", bearer: nil, body: [
            "platform": "ios", "environment": environment, "challenge": challenge, "installId": installId, "approvalKey": approvalKey,
            "attestation": ["kind": "app-attest", "keyId": keyId, "attestationObject": attestationObject],
        ], ok: 201)
    }
    /// 200 taken; 401 the relay no longer knows this install; 409
    /// `token_in_use`, another registration holds this push token.
    public static func updateToken(secret: String, pushToken: String) -> RelayRequest {
        RelayRequest(method: "PUT", path: "/v1/devices/self/token", bearer: secret, body: ["pushToken": pushToken], ok: 200)
    }
    public static func createBinding(secret: String) -> RelayRequest {
        RelayRequest(method: "POST", path: "/v1/bindings", bearer: secret, body: nil, ok: 201)
    }
    public static func deleteBinding(_ bindingId: String, secret: String) -> RelayRequest {
        RelayRequest(method: "DELETE", path: "/v1/bindings/\(bindingId)", bearer: secret, body: nil, ok: 200)
    }
    /// Whether an answer to a DELETE ends the obligation (B4): the relay
    /// removed it (200) or gave a client answer that retrying cannot change
    /// (401 it no longer knows this install, 403, 404). No answer, 408, 429
    /// and 5xx are the network or the relay having a bad moment: try again.
    public static func deletionIsFinal(status: Int?) -> Bool {
        guard let status else { return false }
        return status == 200 || ((400..<500).contains(status) && status != 408 && status != 429)
    }

    public func urlRequest(origin: URL) -> URLRequest {
        var request = URLRequest(url: origin.appendingPathComponent(String(path.dropFirst())), timeoutInterval: 15)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        if let body { request.httpBody = try? JSONSerialization.data(withJSONObject: body) }
        return request
    }
}

/// What a `PUT /v1/devices/self/token` answer means for the install.
public enum TokenUpdateOutcome: Equatable, Sendable {
    /// The relay holds the new token: remember it.
    case store
    /// The relay forgot this install (401) or another registration holds the
    /// token (409): drop the install, and every workspace replaces its binding.
    case drop
    /// Unreachable, limited or anything else: the next launch tries again.
    case retry

    public static func from(status: Int?) -> TokenUpdateOutcome {
        switch status {
        case 200: .store
        case 401, 409: .drop
        default: .retry
        }
    }
}

/// Sends one request; nil status when the relay could not be reached.
public protocol RelayTransport {
    func send(_ request: RelayRequest) async -> (status: Int?, body: [String: Any]?)
}
/// App Attest: a new key, attested over SHA256(utf8(challenge)).
public protocol PushAttester {
    var isSupported: Bool { get }
    func attest(challenge: String) async -> (keyId: String, attestationObject: String)?
}
/// The notification permission (asking when undetermined) and the APNs token.
public protocol PushPlatform {
    func notificationPermission() async -> String
    func pushToken() async -> String?
}

/// Spec §3.5 "Enrolment", phone side, without UIKit: one App Attest
/// registration per install and a relay binding per workspace. The device
/// secret and the push token the relay holds live in `.deviceSecret`
/// (accounts `install` and `apnsToken`); neither is ever logged.
@MainActor public final class PushEnrolment {
    public enum Outcome: Equatable, Sendable {
        case denied, unsupported, failed
        case enrolled(bindingId: String)
        case granted(bindingId: String, grant: String)

        /// The `registerPush` reply on the channel.
        public var reply: Result<[String: Any], ChannelError> {
            switch self {
            case .denied: .success(["status": "denied"])
            case .unsupported: .success(["status": "unsupported"])
            case .enrolled(let id): .success(["status": "enrolled", "bindingId": id])
            case .granted(let id, let grant): .success(["status": "granted", "bindingId": id, "grant": grant])
            case .failed: .failure(.unavailable)
            }
        }
    }

    /// What one registerPush decided and why: the plan and the facts behind
    /// it, never a binding id or a token. PushRegistrar logs it in debug
    /// builds, so a device run shows why a binding was made.
    public struct Decision: Equatable, Sendable {
        public let plan: PushEnrolPlan
        public let permission: String
        public let bound: Bool
        public let hasDetail: Bool
        public let fresh: Bool
    }
    public var onDecision: ((Decision) -> Void)?

    public static let installAccount = "install"
    public static let tokenAccount = "apnsToken"

    private let transport: RelayTransport
    private let attester: PushAttester
    private let secrets: PushSecrets
    private let ledger: LedgerAccess
    private let platform: PushPlatform
    private let environment: String
    private let deletions: PushDeletionQueue
    private var draining = false
    /// Forgets a workspace's binding by origin (PushServices.forget: its
    /// tokens, its count, and the relay delete through onForget).
    private let forget: (String) -> Void
    private var runs: [String: Task<Outcome, Never>] = [:]
    private var attesting: Task<String?, Never>?
    /// A replace waiting for the host, by origin: the new binding and the one
    /// it retires. Only `adopt` (issuePushTokens for the new binding) moves the
    /// ledger and forgets the old one. Lost with the process: the page then
    /// gets tokens for a binding this phone does not hold, and enrols afresh
    /// (src/lib/push-enrol.ts).
    private var pending: [String: (bindingId: String, retires: String)] = [:]

    public init(transport: RelayTransport, attester: PushAttester, secrets: PushSecrets, ledger: LedgerAccess,
                platform: PushPlatform, environment: String, forget: @escaping (String) -> Void,
                deletions: PushDeletionQueue = MemoryDeletionQueue()) {
        self.deletions = deletions
        self.transport = transport
        self.attester = attester
        self.secrets = secrets
        self.ledger = ledger
        self.platform = platform
        self.environment = environment
        self.forget = forget
    }

    private var installSecret: String? { secrets.read(secret: .deviceSecret, account: Self.installAccount) }

    /// Overlapping calls for the same workspace (a reload mid-registration)
    /// share one run, so the install is never attested twice at once.
    public func register(origin: String, fresh: Bool) async -> Outcome {
        let key = "\(fresh) \(origin)"
        if let running = runs[key] { return await running.value }
        let run = Task { await self.run(origin: origin, fresh: fresh) }
        runs[key] = run
        let out = await run.value
        runs[key] = nil
        return out
    }

    private func run(origin: String, fresh: Bool) async -> Outcome {
        let permission = await platform.notificationPermission()
        let binding = ledger.read()?.binding(origin: origin)
        let hasDetail = binding.map { secrets.read(secret: .detail, account: $0) != nil } ?? false
        let plan = PushEnrolPlan.decide(permission: permission, binding: binding, hasDetail: hasDetail, fresh: fresh)
        onDecision?(Decision(plan: plan, permission: permission, bound: binding != nil, hasDetail: hasDetail, fresh: fresh))
        switch plan {
        case .denied:
            return .denied
        case .reuse:
            return .enrolled(bindingId: binding!)
        case .replace, .create:
            // The simulator has no App Attest: nothing is touched there.
            guard attester.isSupported else { return .unsupported }
            guard let token = await platform.pushToken(), var secret = await deviceSecret(pushToken: token) else { return .failed }
            var made = await transport.send(.createBinding(secret: secret))
            if made.status == 401 { // the relay forgot this install: attest again, once
                dropInstall(failing: secret)
                guard let again = await deviceSecret(pushToken: token) else { return .failed }
                secret = again
                made = await transport.send(.createBinding(secret: secret))
            }
            guard made.status == RelayRequest.createBinding(secret: secret).ok,
                  let bindingId = made.body?["bindingId"] as? String, let grant = made.body?["grant"] as? String else { return .failed }
            if let old = binding {
                // Make before break: the old binding keeps delivering until the
                // host takes this one, and the host retires it at the relay when
                // it redeems the grant. A grant never redeemed lapses at the relay.
                pending[origin] = (bindingId, old)
                return .granted(bindingId: bindingId, grant: grant)
            }
            guard ledger.update({ $0.bind(bindingId, origin: origin) }) != nil else {
                // Unrecorded here, it could never be forgotten: give it back.
                _ = await transport.send(.deleteBinding(bindingId, secret: secret))
                return .failed
            }
            return .granted(bindingId: bindingId, grant: grant)
        }
    }

    /// issuePushTokens for a pending replace: the host redeemed the new
    /// binding. Only now does the old one go (its tokens here, and at the
    /// relay through `forget`, repeating the host's own removal) and the
    /// ledger move. False when nothing is pending for this binding, or when
    /// the ledger no longer holds the binding the replace was to retire (the
    /// workspace was forgotten or bound again meanwhile): then nothing moves.
    @discardableResult
    public func adopt(origin: String, bindingId: String) -> Bool {
        guard let p = pending[origin], p.bindingId == bindingId else { return false }
        pending[origin] = nil
        guard ledger.read()?.binding(origin: origin) == p.retires else { return false }
        forget(origin)
        return ledger.update({ $0.bind(bindingId, origin: origin) }) != nil
    }

    /// The bindings a replace is still waiting on: not in the ledger yet, but
    /// the host may already publish to them, so their notifications stay.
    public var pendingBindingIds: Set<String> { Set(pending.values.map(\.bindingId)) }

    /// Forgetting a workspace (sign-out, a removed computer) drops its pending
    /// replace too. `adopt` would refuse it anyway (the ledger no longer holds
    /// what it retires); this makes that explicit.
    public func cancelPending(origin: String) {
        pending[origin] = nil
    }

    /// One registration per install, and only one in flight.
    private func deviceSecret(pushToken: String) async -> String? {
        if let secret = installSecret { return secret }
        if let attesting { return await attesting.value }
        let task = Task { await self.attest(pushToken: pushToken) }
        attesting = task
        let secret = await task.value
        attesting = nil
        return secret
    }

    /// A new App Attest key each time: a key can be attested only once.
    private func attest(pushToken: String) async -> String? {
        guard attester.isSupported else { return nil }
        let asked = await transport.send(.challenge())
        guard asked.status == RelayRequest.challenge().ok, let challenge = asked.body?["challenge"] as? String,
              let proof = await attester.attest(challenge: challenge) else { return nil }
        let request = RelayRequest.registerDevice(environment: environment, pushToken: pushToken, challenge: challenge,
                                                  keyId: proof.keyId, attestationObject: proof.attestationObject)
        let made = await transport.send(request)
        guard made.status == request.ok, let secret = made.body?["deviceSecret"] as? String,
              secrets.write(secret, secret: .deviceSecret, account: Self.installAccount) else { return nil }
        _ = secrets.write(pushToken, secret: .deviceSecret, account: Self.tokenAccount)
        return secret
    }

    /// Every APNs registration hands over the token; the relay hears only a
    /// token that differs from the one it holds.
    public func tokenChanged(_ token: String) async {
        guard let secret = installSecret, secrets.read(secret: .deviceSecret, account: Self.tokenAccount) != token else { return }
        switch TokenUpdateOutcome.from(status: await transport.send(.updateToken(secret: secret, pushToken: token)).status) {
        case .store: _ = secrets.write(token, secret: .deviceSecret, account: Self.tokenAccount)
        case .drop: dropInstall(failing: secret)
        case .retry: break
        }
    }

    /// The foreground refresh (PushRefresher): the same PUT /v1/devices/self/token
    /// tokenChanged sends, with the token the relay already holds. The relay
    /// counts it as activity for the device and its bindings. Nothing is sent
    /// without an install and a stored token; a 401 or 409 drops the install as
    /// tokenChanged does.
    public func refresh() async -> PushRefreshResult {
        guard let secret = installSecret, let token = secrets.read(secret: .deviceSecret, account: Self.tokenAccount) else { return .skipped }
        switch TokenUpdateOutcome.from(status: await transport.send(.updateToken(secret: secret, pushToken: token)).status) {
        case .store: return .refreshed
        case .drop: dropInstall(failing: secret); return .skipped
        case .retry: return .failed
        }
    }

    /// The install's bindings are gone at the relay (401) or belong to a
    /// device that no longer receives (409). Their detail and respond tokens
    /// go, so every workspace plans `replace` on its next registerPush, even
    /// after another workspace has registered the install again. Only the
    /// secret that failed is dropped: one stored meanwhile is newer.
    func dropInstall(failing: String) {
        guard installSecret == failing else { return }
        // A replace made under this install is never committed: its binding
        // belongs to the dropped relay device, and adopting it would leave a
        // detail token that no re-attest ever repairs.
        pending.removeAll()
        secrets.delete(secret: .deviceSecret, account: Self.installAccount)
        secrets.delete(secret: .deviceSecret, account: Self.tokenAccount)
        for id in ledger.read()?.bindingIds ?? [] {
            secrets.delete(secret: .detail, account: id)
            secrets.delete(secret: .respond, account: id)
            secrets.delete(secret: .expiry, account: id)
        }
    }

    /// PushServices.onForget: a forgotten, swept or orphaned binding goes at
    /// the relay too. The obligation is recorded first (it normally is already,
    /// before the local discard) and cleared only by a final relay answer.
    public func deleteAtRelay(_ bindingId: String) async {
        deletions.add(bindingId)
        await drainDeletions()
    }

    /// Works through the relay deletions owed (B4): on every deletion, on
    /// activation, and when connectivity returns. A final answer clears an
    /// entry; no answer stops the pass (the network is down) and keeps what is
    /// left for the next one. Without an install secret nothing can be
    /// authorised: the pass stops and the queue is kept.
    public func drainDeletions() async {
        guard !draining else { return }
        draining = true
        defer { draining = false }
        // One try per entry per pass; an entry added while the pass runs
        // (another computer removed meanwhile) is picked up before it ends.
        var tried: Set<String> = []
        while case let todo = deletions.ids().filter({ !tried.contains($0) }), !todo.isEmpty {
            for id in todo {
                tried.insert(id)
                // No secret read: keep the queue. A Keychain read that fails (before
                // first unlock, a transient error) looks the same as no secret,
                // and clearing here would lose every owed DELETE (review M7).
                // Entries for a dropped install are cleared by the relay's own
                // final answer once a new install secret exists.
                guard let secret = installSecret else { return }
                let answer = await transport.send(.deleteBinding(id, secret: secret))
                if RelayRequest.deletionIsFinal(status: answer.status) { deletions.remove(id) }
                else if answer.status == nil { return }
            }
        }
    }

    /// Bindings still owed a relay DELETE (for tests and diagnostics).
    public var owedDeletions: [String] { deletions.ids() }
}
