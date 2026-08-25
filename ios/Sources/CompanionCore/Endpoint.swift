import Foundation

/// Why an address exists. The kind is display and policy metadata; the URL
/// remains the complete dialing authority, so hosted HTTPS and local HTTP can
/// live in the same fallback list without guessing a scheme from a hostname.
public enum CompanionEndpointKind: String, Codable, CaseIterable, Sendable {
    case hosted
    case tailnet
    case lan
    case bonjour
}

/// One validated route to the desktop companion.
public struct CompanionEndpoint: Codable, Hashable, Sendable {
    public let url: String
    public let kind: CompanionEndpointKind
    public let priority: Int

    public init?(url: String, kind: CompanionEndpointKind, priority: Int) {
        guard (0...1_000_000).contains(priority),
              let normalized = Self.normalizedURL(url, kind: kind)
        else { return nil }
        self.url = normalized
        self.kind = kind
        self.priority = priority
    }

    public var baseURL: URL? { URL(string: url) }

    public var host: String {
        guard let host = URLComponents(string: url)?.host else { return "" }
        return Connection.urlHost(host)
    }

    public var port: Int {
        guard let components = URLComponents(string: url) else { return 0 }
        return components.port ?? (components.scheme?.lowercased() == "https" ? 443 : 80)
    }

    public var isSecure: Bool {
        URLComponents(string: url)?.scheme?.lowercased() == "https"
    }

    /// Host-only for the old direct routes, full HTTPS authority for hosted
    /// routes. Used in status copy, never for dialing.
    public var displayAddress: String {
        if kind == .hosted || isSecure { return url }
        return port == 8810 ? host : "\(host):\(port)"
    }

    /// Construct the legacy HTTP route represented by `host` + `port`.
    public static func direct(
        host: String,
        port: Int,
        kind: CompanionEndpointKind = .lan,
        priority: Int
    ) -> CompanionEndpoint? {
        var components = URLComponents()
        components.scheme = "http"
        components.host = Connection.urlHost(host)
        components.port = port
        guard let value = components.url?.absoluteString else { return nil }
        return CompanionEndpoint(url: value, kind: kind, priority: priority)
    }

    private static func normalizedURL(_ raw: String, kind: CompanionEndpointKind) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.utf8.count <= 2_048,
              var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host,
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              kind == .hosted ? scheme == "https" : scheme == "http"
        else { return nil }

        components.scheme = scheme
        components.host = host.lowercased()
        components.path = ""
        if let port = components.port, !(1...65_535).contains(port) { return nil }
        return components.url?.absoluteString
    }

    private enum CodingKeys: String, CodingKey { case url, kind, priority }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let url = try values.decode(String.self, forKey: .url)
        let kind = try values.decode(CompanionEndpointKind.self, forKey: .kind)
        let priority = try values.decode(Int.self, forKey: .priority)
        guard let accepted = CompanionEndpoint(url: url, kind: kind, priority: priority) else {
            throw DecodingError.dataCorruptedError(
                forKey: .url,
                in: values,
                debugDescription: "Companion endpoints must be absolute HTTP(S) authorities; hosted routes require HTTPS."
            )
        }
        self = accepted
    }
}

extension Connection {
    public var displayAddress: String {
        activeEndpoint?.displayAddress ?? "\(host):\(port)"
    }
}
