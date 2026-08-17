// The companion API client.
//
// Everything the phone can do to the harness, in one place. The rules it
// encodes come from `remoteDenial()` in server/index.ts: a paired phone may
// chat, answer approvals, and manage tasks and rooms — it may not touch
// credentials, pairing, or the Local VM. Those routes are simply absent
// here rather than present and failing at runtime.
import Foundation

/// Where a companion connects, and with what. The token is *not* held here
/// — it lives in the keychain and is handed to the client at construction,
/// so a `Connection` can be written to disk without writing a credential.
public struct Connection: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    /// What the computer calls itself, e.g. "Ada Lovelace's computer".
    public var name: String
    public var host: String
    public var port: Int

    public init(id: String = UUID().uuidString, name: String, host: String, port: Int) {
        self.id = id
        self.name = name
        self.host = host
        self.port = port
    }

    /// Plain HTTP, and that is a real limitation rather than an oversight.
    ///
    /// The bearer token goes out in a header on every request, so anyone who
    /// can observe the path between phone and computer can lift it and use it
    /// until the device is revoked. What that means in practice depends
    /// entirely on how you reach the computer, and the two supported routes
    /// are not equivalent:
    ///
    /// - **Over a tailnet** — the recommended route, and the only one that
    ///   works away from home — the traffic is inside WireGuard before it
    ///   reaches any network, so it is encrypted and authenticated end to end
    ///   even though this URL says `http`.
    /// - **Over a LAN**, it is cleartext on that network. Trust it exactly as
    ///   far as you trust everyone on the wifi: fine at home, not fine on a
    ///   café or conference network — pair over the tailnet there instead.
    ///
    /// TLS is not a drop-in improvement here, which is why it is not simply
    /// switched on. A self-signed certificate on a LAN address is a
    /// certificate nothing can validate, so it would have to be pinned at
    /// pairing time and re-pinned whenever the sidecar regenerates it — a
    /// meaningful amount of machinery whose benefit, on the tailnet path, is
    /// zero. The honest position is: the tailnet carries the encryption, the
    /// LAN path is documented as trusted-network-only, and pinned TLS is what
    /// this needs before it could claim otherwise. See `docs/ios-companion.md`.
    public var baseURL: URL? {
        var components = URLComponents()
        components.scheme = "http"
        components.host = host
        components.port = port
        return components.url
    }
}

public enum APIError: Error, LocalizedError, Sendable {
    /// The harness answered, and said no.
    case status(code: Int, message: String?)
    /// Could not reach it at all.
    case transport(String)
    case badURL

    public var errorDescription: String? {
        switch self {
        case let .status(code, message):
            if let message { return message }
            switch code {
            case 401: return "This phone is not paired with that computer."
            case 403: return "That can only be done on the computer itself."
            case 404: return "That is no longer there."
            case 409: return "The bot is busy — stop it first."
            default: return "The computer answered with an error (\(code))."
            }
        case let .transport(detail):
            return detail
        case .badURL:
            return "That address doesn't look right."
        }
    }

    /// The one error that means "stop retrying and send them back to
    /// pairing" rather than "try again in a moment".
    public var isUnauthorized: Bool {
        if case let .status(code, _) = self { return code == 401 }
        return false
    }
}

public struct CompanionClient: Sendable {
    public let connection: Connection
    private let token: String?
    private let session: URLSession

    public init(connection: Connection, token: String?, session: URLSession = .shared) {
        self.connection = connection
        self.token = token
        self.session = session
    }

    // MARK: - Requests

    private func makeRequest(_ method: String, _ path: String, query: [URLQueryItem] = [], body: [String: Any]? = nil) throws -> URLRequest {
        guard let base = connection.baseURL,
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        else { throw APIError.badURL }
        components.path = path
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw APIError.badURL }

        var request = URLRequest(url: url)
        request.httpMethod = method
        // Short on purpose. These are calls to a computer on the same
        // network; if it does not answer in twenty seconds it is not going
        // to. The default sixty leaves someone watching a spinner long
        // enough to assume the app is broken rather than the address wrong.
        request.timeoutInterval = 20
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return request
    }

    @discardableResult
    private func send<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let (data, response) = try await perform(request)
        try Self.check(response, data)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.transport("The computer sent something this app couldn't read.")
        }
    }

    private func send(_ request: URLRequest) async throws {
        let (data, response) = try await perform(request)
        try Self.check(response, data)
    }

    private func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
    }

    /// Turn a non-2xx into an `APIError` carrying the harness's own message.
    /// Those messages are written for people ("pair this device in
    /// OpenMausBot → Settings → Companion"), so passing them through beats
    /// inventing a worse one here.
    static func check(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard !(200...299).contains(http.statusCode) else { return }
        let message = try? JSONDecoder().decode(APIErrorBody.self, from: data).error
        throw APIError.status(code: http.statusCode, message: message)
    }

    // MARK: - Pairing

    /// Redeem a code for a device token. The only call made without one.
    public static func pair(
        connection: Connection,
        code: String,
        deviceName: String,
        session: URLSession = .shared
    ) async throws -> PairResponse {
        let client = CompanionClient(connection: connection, token: nil, session: session)
        let pairRequest = try client.makeRequest("POST", "/api/pair", body: ["code": code, "deviceName": deviceName])
        return try await client.send(pairRequest, as: PairResponse.self)
    }

    // MARK: - Reading

    /// Hydrate. `messages` opts into the paged shape — the newest n per
    /// thread, with screen captures reduced to a flag.
    public func fleet(messages: Int? = 50) async throws -> Fleet {
        let query = messages.map { [URLQueryItem(name: "messages", value: String($0))] } ?? []
        return try await send(try makeRequest("GET", "/api/bots", query: query), as: Fleet.self)
    }

    /// Scrollback: the page before a message already held.
    public func messages(threadId: String, before: String? = nil, limit: Int = 50) async throws -> ThreadPage {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        return try await send(try makeRequest("GET", "/api/threads/\(threadId)/messages", query: query), as: ThreadPage.self)
    }

    public func instances() async throws -> [Instance] {
        try await send(try makeRequest("GET", "/api/instances"), as: InstanceList.self).instances
    }

    public func config() async throws -> ConfigStatus {
        try await send(try makeRequest("GET", "/api/config"), as: ConfigStatus.self)
    }

    /// The pixels of one screen message.
    public func image(threadId: String, messageId: String) async throws -> Data {
        let imageRequest = try makeRequest("GET", "/api/threads/\(threadId)/messages/\(messageId)/image")
        let (data, response) = try await perform(imageRequest)
        try Self.check(response, data)
        return data
    }

    // MARK: - Doing

    /// Make a new bot. The harness picks its name, colour and greeting — the
    /// phone deliberately does not, so a bot created here is indistinguishable
    /// from one created on the desktop.
    public func createBot() async throws -> Bot {
        try await send(try makeRequest("POST", "/api/bots"), as: CreatedBot.self).bot
    }

    public func send(text: String, toBot botId: String) async throws {
        try await send(try makeRequest("POST", "/api/bots/\(botId)/messages", body: ["text": text]))
    }

    public func send(text: String, toRoom groupId: String) async throws {
        try await send(try makeRequest("POST", "/api/groups/\(groupId)/messages", body: ["text": text]))
    }

    /// Answer an approval or a question.
    ///
    /// Addressed by thread rather than by bot on purpose: a request raised
    /// inside a room belongs to whichever member is speaking, and the
    /// harness already knows which that is.
    public func respond(threadId: String, requestId: String, behavior: String, message: String? = nil) async throws {
        var body: [String: Any] = ["requestId": requestId, "behavior": behavior]
        if let message { body["message"] = message }
        try await send(try makeRequest("POST", "/api/threads/\(threadId)/respond", body: body))
    }

    /// Remember a grant so the same tool stops asking. The harness decides
    /// the key and puts it on the card; the phone never derives its own.
    public func alwaysAllow(botId: String, keys: [String]) async throws {
        try await send(try makeRequest("PATCH", "/api/bots/\(botId)", body: ["alwaysAllow": keys]))
    }

    public func interrupt(botId: String) async throws {
        try await send(try makeRequest("POST", "/api/bots/\(botId)/interrupt"))
    }

    public func markRead(botId: String) async throws {
        try await send(try makeRequest("PATCH", "/api/bots/\(botId)", body: ["unread": false]))
    }

    public func markRead(roomId: String) async throws {
        try await send(try makeRequest("PATCH", "/api/groups/\(roomId)", body: ["unread": false]))
    }

    // MARK: - Events

    /// A session for a connection that is meant to stay open for hours.
    ///
    /// `timeoutIntervalForRequest` is the *idle* timeout — the gap between
    /// bytes, not the lifetime of the request — so 90s is comfortably above
    /// the harness's 25-second keepalive comment while still noticing a
    /// connection that genuinely died.
    ///
    /// Emphatically NOT `request.timeoutInterval = .greatestFiniteMagnitude`,
    /// which is what this used to be. It reads like "never time out", but
    /// URLSession turns a timeout into a deadline by adding it to the current
    /// time, and 1.8e308 does not survive that arithmetic: the request opens
    /// and then never delivers a byte. The stream appeared to hang forever
    /// with no error to show for it.
    private static let streaming: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 90
        configuration.waitsForConnectivity = true
        // no caching for an event stream — it would only ever be wrong
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    /// The event stream, resuming from `cursor` when there is one.
    ///
    /// `screens` defaults off, and should stay off unless something is
    /// actually showing them: the harness pushes a base64 desktop capture
    /// every few seconds to every client that asks, which is a poor thing to
    /// send a phone on cellular. The computer panel turns it on for exactly
    /// as long as it is open, which costs a reconnect — cheap, because the
    /// stream resumes from its cursor and loses nothing.
    public func events(since cursor: String?, screens: Bool = false) throws -> AsyncThrowingStream<StreamFrame, Error> {
        var query = [URLQueryItem(name: "screens", value: screens ? "on" : "off")]
        if let cursor { query.append(URLQueryItem(name: "since", value: cursor)) }
        var streamRequest = try makeRequest("GET", "/api/events", query: query)
        streamRequest.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        // `makeRequest` stamps every request with the 20 seconds that suit a
        // call-and-answer API, and a per-request timeout *overrides* the
        // session's `timeoutIntervalForRequest` rather than deferring to it —
        // so the 90 seconds configured just above was never in effect here.
        // The harness sends a keepalive comment every 25 seconds, which is
        // already past 20: a stream with nothing to say would time out on its
        // first quiet gap and reconnect, forever, looking like a flaky network
        // rather than a number in the wrong place.
        streamRequest.timeoutInterval = 90
        return eventStream(request: streamRequest, session: Self.streaming)
    }
}
