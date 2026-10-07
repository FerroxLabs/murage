import Foundation

/// Tailscale's addresses (spec §3.1 can't-reach): IPv4 100.64.0.0/10 and
/// IPv6 fd7a:115c:a1e0::/48. Twin of TailscaleAddress.java; the shared cases
/// are contract/tailscale-address.json. Raw network-order bytes, 4 or 16,
/// exactly what getifaddrs hands over; anything else is not an address.
/// An IPv4-mapped address counts as the IPv4 inside it.
public enum TailscaleAddress {
    public static func isTailnet(_ bytes: [UInt8]) -> Bool {
        switch bytes.count {
        case 4: return bytes[0] == 100 && bytes[1] & 0xC0 == 64
        case 16:
            // IPv4-mapped (::ffff:0:0/96) is its embedded IPv4, as Java hands it over.
            if bytes.prefix(12).elementsEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]) { return isTailnet(Array(bytes.suffix(4))) }
            return bytes.prefix(6).elementsEqual([0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0])
        default: return false
        }
    }
}

/// What the launcher's state() says about Tailscale; nil is unknown, and the
/// launcher then keeps its general wording. Twin of TailscaleStatus.java.
public struct TailscaleStatus: Equatable, Sendable {
    public var installed: Bool?
    public var connected: Bool?

    public init(installed: Bool?, connected: Bool?) {
        self.installed = installed
        self.connected = connected
    }

    /// `addresses`: every address on an interface that is up, or nil when
    /// they could not be read. `opensScheme`: canOpenURL("tailscale://").
    /// Tailscale for iOS documents no URL scheme (tailscale/tailscale#14679),
    /// so a no there is not proof it is missing: installed is never false on iOS.
    public static func ios(opensScheme: Bool, addresses: [[UInt8]]?) -> TailscaleStatus {
        let connected = addresses.map { $0.contains(where: TailscaleAddress.isTailnet) }
        return TailscaleStatus(installed: opensScheme || connected == true ? true : nil, connected: connected)
    }

    public var wire: [String: Any] {
        ["installed": installed.map { $0 as Any } ?? NSNull(), "connected": connected.map { $0 as Any } ?? NSNull()]
    }
}
