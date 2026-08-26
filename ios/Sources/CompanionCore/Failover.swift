// Reaching the same computer through another credential-safe route still
// works.
//
// Pairing stores one host, and one host is one point of failure: a phone
// paired over the tailnet keeps a MagicDNS name that stops resolving the
// moment either device leaves the tailnet. The connection still carries every
// address the computer advertised, but a bearer credential cannot safely be
// sprayed onto whatever LAN happens to use the same private address later.
// Automatic walking is therefore a trust ratchet: protected routes can walk
// to other protected routes, while a user-selected cleartext route can be
// tried exactly once and can only move to a stronger transport. Both halves
// are pure — no sockets, no clocks — so the rules can be tested without a
// network; `Session` owns when they run.
import Foundation

/// The ordered walk through a connection's stored hosts.
///
/// Advance on an address-shaped failure, promote on success. Advancing wraps
/// rather than giving up, because the retry loop it lives in already backs
/// off between attempts and a network that comes back deserves a second lap.
public struct CandidateRotation: Equatable, Sendable {
    public private(set) var endpoints: [CompanionEndpoint]
    private var index: Int

    public init(hosts: [String]) {
        self.init(endpoints: hosts.enumerated().compactMap { offset, host in
            CompanionEndpoint.direct(host: host, port: 8810, priority: offset)
        })
    }

    public init(endpoints: [CompanionEndpoint]) {
        self.endpoints = CompanionEndpoint.automaticCandidates(from: endpoints)
        index = 0
    }

    /// Compatibility view for tests and callers that only understand the old
    /// host list. New dialing code uses `currentEndpoint` so it never loses a
    /// route's HTTPS scheme or distinct port.
    public var hosts: [String] { endpoints.map(\.displayAddress) }

    public var currentEndpoint: CompanionEndpoint? {
        endpoints.indices.contains(index) ? endpoints[index] : nil
    }

    /// The host the next attempt should dial. Empty only when there are no
    /// hosts at all, which a real connection never produces.
    public var current: String {
        currentEndpoint?.displayAddress ?? ""
    }

    public var count: Int { endpoints.count }

    /// Move to the next candidate and return it, wrapping past the end.
    @discardableResult
    public mutating func advance() -> String {
        advanceEndpoint()?.displayAddress ?? ""
    }

    @discardableResult
    public mutating func advanceEndpoint() -> CompanionEndpoint? {
        guard !endpoints.isEmpty else { return nil }
        index = (index + 1) % endpoints.count
        guard let next = currentEndpoint else { return nil }
        // An explicit local route may upgrade to a protected route, but that
        // upgrade is one-way. Pruning the local route prevents a later wrap
        // from silently downgrading the bearer transport again.
        if next.protectsCredentials,
           endpoints.contains(where: { !$0.protectsCredentials }) {
            let selectedURL = next.url
            endpoints.removeAll { !$0.protectsCredentials }
            index = endpoints.firstIndex(where: { $0.url == selectedURL }) ?? 0
        }
        return currentEndpoint
    }

    /// Move only when the failure belongs to this route rather than to the
    /// pairing or the phone as a whole. Keeping that decision beside the
    /// rotation makes reconnects handle URL and HTTP gateway failures alike.
    @discardableResult
    public mutating func advanceEndpoint(after error: Error) -> CompanionEndpoint? {
        guard endpoints.count > 1,
              ConnectionAdvice.shouldTryAnotherRoute(after: error)
        else { return nil }
        return advanceEndpoint()
    }

    public func promotedEndpoints() -> [CompanionEndpoint] {
        guard endpoints.indices.contains(index) else { return endpoints }
        return [endpoints[index]] + endpoints.enumerated()
            .filter { $0.offset != index }
            .map(\.element)
    }

    public func promoted() -> [String] {
        promotedEndpoints().map(\.displayAddress)
    }
}

/// What to do with a connection failure: whether another stored address is
/// worth trying, and what to tell the person watching the banner.
public enum ConnectionAdvice {
    /// True only for failures about the address — the name did not resolve,
    /// nothing answered there, the route timed out. Everything else stays
    /// put: a 401 is a token problem that every address would repeat, and
    /// "offline" fails identically wherever the dial points.
    public static func shouldTryAnotherHost(_ code: URLError.Code) -> Bool {
        switch code {
        case .cannotFindHost,
             .cannotConnectToHost,
             .timedOut,
             .secureConnectionFailed,
             .serverCertificateHasBadDate,
             .serverCertificateUntrusted,
             .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid,
             .clientCertificateRejected,
             .clientCertificateRequired:
            return true
        default:
            return false
        }
    }

    /// Classify errors which another advertised route can actually repair.
    /// 502–504 are ordinary reverse-proxy failures; 520–530 are the gateway
    /// family Cloudflare can return when a tunnel or its origin is unhealthy.
    /// Application errors such as 400/401/500 deliberately stay put.
    public static func shouldTryAnotherRoute(after error: Error) -> Bool {
        if let urlError = error as? URLError {
            return shouldTryAnotherHost(urlError.code)
        }
        guard let apiError = error as? APIError,
              case let .status(code, _) = apiError
        else { return false }
        return (502...504).contains(code) || (520...530).contains(code)
    }

    /// The offline banner as advice rather than an NSURLError string.
    ///
    /// Each code names the thing the person can actually check — the raw
    /// "A server with the specified hostname could not be found" says nothing
    /// about tailnets, and it is precisely the tailnet case that produces it.
    /// `tryingNext` is the candidate the walk moved to, when it moved.
    public static func message(
        for code: URLError.Code,
        host: String,
        port: Int,
        tryingNext next: String? = nil
    ) -> String {
        let advice: String
        switch code {
        case .cannotFindHost:
            advice = "\u{201C}\(host)\u{201D} didn't resolve. If that's a Tailscale name, this phone may not be on the tailnet."
        case .cannotConnectToHost:
            advice = "Reached your computer, but Phone access isn't answering on port \(port) — open OpenMausBot → Settings → Phone."
        case .timedOut:
            advice = "No route to your computer at \(host) — different network, or a firewall."
        case .notConnectedToInternet:
            advice = "You're offline."
        default:
            advice = "Could not reach \(host): \(URLError(code).localizedDescription)"
        }
        let fallback = next.map { " Trying \($0) next." } ?? ""
        return advice + fallback + " The app keeps retrying automatically."
    }

    public static func message(
        forGatewayStatus code: Int,
        host: String,
        tryingNext next: String? = nil
    ) -> String {
        let fallback = next.map { " Trying \($0) next." } ?? ""
        return "The route through \(host) is temporarily unavailable (HTTP \(code))." +
            fallback + " The app keeps retrying automatically."
    }
}

extension Connection {
    /// Every host this connection may dial, best first and never empty: the
    /// stored `host` leads, then the pairing-time fallbacks, deduplicated
    /// after the same normalization dialing applies.
    public var orderedHosts: [String] {
        var seen = Set<String>()
        var out: [String] = []
        for candidate in [host] + (hosts ?? []) {
            let normalized = Self.urlHost(candidate)
            if seen.insert(normalized).inserted { out.append(normalized) }
        }
        return out
    }

    /// Every complete route in policy order. Typed endpoints win over the
    /// legacy fields because they can represent hosted HTTPS. A connection
    /// either walks that complete typed set or, for an older desktop, derives
    /// direct routes from the legacy fields — never a lossy mixture of both.
    public var orderedEndpoints: [CompanionEndpoint] {
        var candidates = endpoints ?? []
        if !candidates.isEmpty {
            if let activeEndpoint, !candidates.contains(where: { $0.url == activeEndpoint.url }) {
                candidates.append(activeEndpoint)
            }
            candidates = candidates.enumerated().sorted {
                $0.element.priority == $1.element.priority
                    ? $0.offset < $1.offset
                    : $0.element.priority < $1.element.priority
            }.map(\.element)
        } else {
            candidates = orderedHosts.enumerated().compactMap { offset, candidate in
                CompanionEndpoint.direct(host: candidate, port: port, priority: offset)
            }
        }
        var seen = Set<String>()
        return candidates.filter { seen.insert($0.url).inserted }.prefix(8).map { $0 }
    }

    /// The subset an automatic pairing or authenticated reconnect may try.
    /// The complete advertised list remains persisted in `orderedEndpoints`
    /// so a person can explicitly choose a local route later.
    public var automaticEndpoints: [CompanionEndpoint] {
        CompanionEndpoint.automaticCandidates(from: orderedEndpoints)
    }

    /// Apply an authenticated endpoint snapshot. The caller owns the exact
    /// client carrying the current live stream; this value chooses what a
    /// future reconnect or launch may dial.
    ///
    /// The advertised version of the active route is retained when present.
    /// If it disappeared, a new protected route is a safe upgrade. With no
    /// protected replacement, the exact old route remains the first candidate
    /// instead of silently authorizing some other cleartext LAN address.
    public mutating func reconcile(_ metadata: CompanionConnectionMetadata) {
        let cleanedName = metadata.serverName.trimmingCharacters(in: .whitespacesAndNewlines)
            .filter { (!$0.isASCII && !$0.isNewline) || $0.asciiValue.map { $0 >= 32 && $0 != 127 } == true }
        if !cleanedName.isEmpty { name = String(cleanedName.prefix(80)) }

        if let advertisedHosts = metadata.hosts {
            var seen = Set<String>()
            hosts = advertisedHosts.compactMap { raw -> String? in
                let candidate = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !candidate.isEmpty,
                      candidate.utf8.count <= 253,
                      !candidate.contains(where: { $0.isWhitespace || "/?#".contains($0) })
                else { return nil }
                let normalized = Self.urlHost(candidate)
                return seen.insert(normalized).inserted ? normalized : nil
            }.prefix(8).map { $0 }
        }

        let previousActive = activeEndpoint
        endpoints = metadata.endpoints
        if let previousActive,
           let refreshedActive = metadata.endpoints.first(where: { $0.url == previousActive.url }) {
            activeEndpoint = refreshedActive
        } else if let protectedReplacement = metadata.endpoints.first(where: \.protectsCredentials) {
            activeEndpoint = protectedReplacement
        } else if let previousActive,
                  let retained = CompanionEndpoint(
                      url: previousActive.url,
                      kind: previousActive.kind,
                      priority: 0
                  ) {
            activeEndpoint = retained
            endpoints = [retained] + metadata.endpoints
                .filter { $0.url != retained.url }
                .prefix(7)
        } else {
            activeEndpoint = metadata.endpoints.first
        }
        if let activeEndpoint {
            host = activeEndpoint.host
            port = activeEndpoint.port
        }
    }

    /// A copy dialing `candidate` — same pairing, same port, different
    /// address. The stored order is untouched; committing a winner is
    /// `promote`, and only success earns it.
    public func dialing(_ candidate: String) -> Connection {
        guard let endpoint = CompanionEndpoint.direct(host: candidate, port: port, priority: 10_000) else {
            return self
        }
        return dialing(endpoint)
    }

    /// A copy dialing one complete route without changing its stored policy
    /// order or keychain identity.
    public func dialing(_ candidate: CompanionEndpoint) -> Connection {
        var copy = self
        copy.activeEndpoint = candidate
        copy.host = candidate.host
        copy.port = candidate.port
        return copy
    }

    /// `winner` becomes the host dialed first from now on — the one that just
    /// carried traffic, or the one the user typed in by hand.
    public mutating func promote(_ winner: String) {
        let normalized = Self.urlHost(winner)
        let rest = orderedHosts.filter { $0 != normalized }
        host = normalized
        hosts = [normalized] + rest
        activeEndpoint = CompanionEndpoint.direct(host: normalized, port: port, priority: 10_000)
    }

    /// Remember the route that worked without letting a cleartext fallback
    /// jump ahead of a lower-priority hosted/tailnet route on the next launch.
    public mutating func promote(_ winner: CompanionEndpoint) {
        activeEndpoint = winner
        host = winner.host
        port = winner.port
        if let existing = endpoints,
           !existing.contains(where: { $0.url == winner.url }) {
            endpoints = existing + [winner]
        }
        if winner.kind != .hosted {
            let rest = orderedHosts.filter { $0 != winner.host }
            hosts = [winner.host] + rest
        }
    }
}
