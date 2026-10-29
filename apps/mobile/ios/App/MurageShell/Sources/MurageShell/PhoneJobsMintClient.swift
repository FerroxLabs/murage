import CoreFoundation
import Foundation
import MurageShellCore

enum PhoneJobsMintError: Error, Equatable, LocalizedError {
    case notOffered, updateComputer, noApprovalKey, refused, rateLimited, invalidResponse, unavailable, storage, cancelled, busy

    var errorDescription: String? {
        switch self {
        case .notOffered: return PhoneJobStrings.text("ask_cloud")
        case .updateComputer: return PhoneJobStrings.text("phone_update")
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
    private var minting = false

    init(signer: PhoneJobsSigner, store: PhoneJobsTokenWriting, send: @escaping Transport,
         now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.signer = signer; self.store = store; self.send = send; self.now = now; self.ask = false
    }

    init(signer: PhoneAskSigner, store: PhoneJobsTokenWriting, send: @escaping Transport,
         now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.signer = signer; self.store = store; self.send = send; self.now = now; self.ask = true
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
        guard (ask ? verdict.phoneAskOk : verdict.phoneJobsOk) else { throw PhoneJobsMintError.updateComputer }

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
        if ask { body["scope"] = "ask" }
        post.httpBody = try JSONSerialization.data(withJSONObject: body)
        let answer = try object(await send(post))
        try Task.checkCancellation()
        guard Set(answer.keys) == ["token"], let token = answer["token"] as? String,
              (ask ? PhoneAskContract.tokenValid(token) : PhoneJobsContract.tokenValid(token)) else { throw PhoneJobsMintError.invalidResponse }
        guard signer.keyId(origin: origin) == keyId else { throw PhoneJobsMintError.noApprovalKey }
        try store.save(token, origin: origin)
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
