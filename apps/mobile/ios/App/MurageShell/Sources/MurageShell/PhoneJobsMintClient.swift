import CoreFoundation
import Foundation
import MurageShellCore

enum PhoneJobsMintError: Error, Equatable, LocalizedError {
    case notOffered, updateComputer, turnedOff, noApprovalKey, refused, rateLimited, invalidResponse, unavailable, storage, cancelled, busy

    var errorDescription: String? {
        switch self {
        case .notOffered: return PhoneJobStrings.text("ask_cloud")
        case .updateComputer: return PhoneJobStrings.text("phone_update")
        case .turnedOff: return PhoneJobStrings.text("phone_turned_off")
        case .noApprovalKey: return PhoneJobStrings.text("phone_no_key")
        case .refused: return PhoneJobStrings.text("phone_refused")
        case .rateLimited: return PhoneJobStrings.text("phone_rate_limited")
        case .invalidResponse, .unavailable: return PhoneJobStrings.text("phone_unavailable")
        case .storage: return PhoneJobStrings.text("phone_storage")
        case .cancelled: return PhoneJobStrings.text("phone_cancelled")
        case .busy: return PhoneJobStrings.text("phone_busy")
        }
    }
}

@MainActor
protocol PhoneJobsTokenWriting {
    func save(_ token: String, origin: WorkspaceOrigin) throws
}

/// Typed native signers share the bootstrap flow, never the signed purpose.
@MainActor
protocol PhoneMintSigning {
    func keyId(origin: WorkspaceOrigin) -> String?
    func sign(origin: WorkspaceOrigin, keyId: String, nonce: String, expiresAt: Int64) async throws -> String
}

/// N3 and N10 call mint only after an explicit native action. The typed
/// signer pins the purpose; completion contains no bearer. No automatic retry
/// can cause another authentication prompt or consume another challenge.
@MainActor
final class PhoneJobsMintClient {
    struct Response {
        let status: Int
        let body: Data
    }
    typealias Transport = (URLRequest) async throws -> Response

    private let signer: any PhoneMintSigning
    private let ask: Bool
    private let store: PhoneJobsTokenWriting
    private let send: Transport
    private let now: () -> Int64
    private let pin: AskDevicePin?
    private var minting = false

    init(signer: PhoneJobsSigner, store: PhoneJobsTokenWriting, send: @escaping Transport,
         now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.signer = signer; self.store = store; self.send = send; self.now = now; self.ask = false; self.pin = nil
    }

    /// `pin`: the ask mint pins the device id the harness issues in its answer (D8). Nothing else pins it.
    init(signer: PhoneAskSigner, store: PhoneJobsTokenWriting, send: @escaping Transport, pin: AskDevicePin? = nil,
         now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.signer = signer; self.store = store; self.send = send; self.now = now; self.ask = true; self.pin = pin
    }

    func mint(origin: WorkspaceOrigin) async throws {
        guard !minting else { throw PhoneJobsMintError.busy }
        minting = true
        defer { minting = false }
        guard let keyId = signer.keyId(origin: origin) else { throw PhoneJobsMintError.noApprovalKey }
        let hello = try await send(request(origin, path: "/healthz"))
        try Task.checkCancellation()
        guard hello.status == 200 else { throw PhoneJobsMintError.unavailable }
        let verdict = ProbeVerdict.classify(status: hello.status, body: hello.body, errorDomain: nil, errorCode: nil)
        guard (ask ? verdict.phoneAskOk : verdict.phoneJobsOk) else {
            throw verdict.phoneFlagsOk ? PhoneJobsMintError.turnedOff : PhoneJobsMintError.updateComputer
        }

        do { try await attempt(origin, keyId: keyId, wantDeviceId: ask) }
        catch is WantRefused {
            // A computer older than the pin-at-pairing release refuses the unknown `want` field with a 400. Its challenge was used up
            // by that answer, so one fresh challenge and signature ask again without `want`: a plain token, no pin, and the plain ask.
            try await attempt(origin, keyId: keyId, wantDeviceId: false)
        }
    }

    /// The old computer's refusal of an ask mint that carries `want`: 400 with exactly {"error":"bad request"} (companion/src/phone-door.ts).
    private struct WantRefused: Error {}

    private func attempt(_ origin: WorkspaceOrigin, keyId: String, wantDeviceId: Bool) async throws {
        let challenge = try object(await send(request(origin, path: "/api/phones/self/challenge", keyId: keyId)))
        guard Set(challenge.keys) == ["nonce", "expiresAt"], let nonce = challenge["nonce"] as? String,
              let expiry = Self.integer(challenge["expiresAt"]), expiry > now() else { throw PhoneJobsMintError.invalidResponse }
        try Task.checkCancellation()
        let signature = try await signer.sign(origin: origin, keyId: keyId, nonce: nonce, expiresAt: expiry)
        try Task.checkCancellation()
        guard expiry > now() else { throw PhoneJobsMintError.invalidResponse }
        var post = try request(origin, path: "/api/phones/self/token")
        post.httpMethod = "POST"
        post.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["keyId": keyId, "nonce": nonce, "expiresAt": expiry, "signature": signature]
        // The ask credential opts in to the computer's pairing id, which the phone pins at pairing (D8). Jobs never asks for it.
        if ask { body["scope"] = "ask" }
        if wantDeviceId { body["want"] = ["deviceId"] }
        post.httpBody = try JSONSerialization.data(withJSONObject: body)
        let response = try await send(post)
        if wantDeviceId, Self.isWantRefusal(response) { throw WantRefused() }
        let answer = try object(response)
        try Task.checkCancellation()
        guard let minted = AskMintAnswer.parse(answer),
              (ask ? PhoneAskContract.tokenValid(minted.token) : PhoneJobsContract.tokenValid(minted.token)) else { throw PhoneJobsMintError.invalidResponse }
        let token = minted.token
        guard signer.keyId(origin: origin) == keyId else { throw PhoneJobsMintError.noApprovalKey }
        try store.save(token, origin: origin)
        // Pairing is the only place the device id is pinned. A harness that sends none leaves the phone unpinned.
        if ask, let deviceId = minted.deviceId { pin?.pin(origin: origin, keyId: keyId, deviceId: deviceId) }
    }

    static func isWantRefusal(_ response: Response) -> Bool {
        guard response.status == 400, response.body.count <= 256,
              let json = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any] else { return false }
        return Set(json.keys) == ["error"] && json["error"] as? String == "bad request"
    }

    private func request(_ origin: WorkspaceOrigin, path: String, keyId: String? = nil) throws -> URLRequest {
        guard var url = URLComponents(string: origin.serialized + path) else { throw PhoneJobsMintError.unavailable }
        if let keyId { url.queryItems = [URLQueryItem(name: "key", value: keyId)] }
        guard let target = url.url else { throw PhoneJobsMintError.unavailable }
        var request = URLRequest(url: target)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private func object(_ response: Response) throws -> [String: Any] {
        if ask && response.status == 404 { throw PhoneJobsMintError.notOffered }
        if response.status == 403 { throw PhoneJobsMintError.refused }
        if response.status == 429 { throw PhoneJobsMintError.rateLimited }
        guard response.status == 200 else { throw PhoneJobsMintError.unavailable }
        guard response.body.count <= 4096,
              let json = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any] else {
            throw PhoneJobsMintError.invalidResponse
        }
        return json
    }

    private static func integer(_ value: Any?) -> Int64? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
              n.doubleValue > 0, n.doubleValue <= 9_007_199_254_740_991,
              n.doubleValue.rounded() == n.doubleValue else { return nil }
        return n.int64Value
    }
}

/// Native HTTP only: no cookies, cache, redirects or WebView session. The
/// bounded stream avoids buffering an unbounded response from a faulty door.
@MainActor
final class PhoneJobsMintHTTP: NSObject, URLSessionTaskDelegate {
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 8
        config.timeoutIntervalForResource = 16
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    func send(_ request: URLRequest) async throws -> PhoneJobsMintClient.Response {
        let (bytes, response) = try await session.bytes(for: request)
        defer { bytes.task.cancel() }
        guard let http = response as? HTTPURLResponse else { throw PhoneJobsMintError.unavailable }
        guard http.statusCode == 200 else { return .init(status: http.statusCode, body: Data()) }
        guard response.expectedContentLength <= 4096 else { throw PhoneJobsMintError.invalidResponse }
        var body = Data()
        for try await byte in bytes {
            guard body.count < 4096 else { throw PhoneJobsMintError.invalidResponse }
            body.append(byte)
        }
        return .init(status: http.statusCode, body: body)
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    /// N3 retains this transport alongside its mint client, then closes it.
    func close() { session.invalidateAndCancel() }
}
