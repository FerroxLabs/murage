import Foundation
import XCTest
@testable import MurageShellCore

/// contract/tailscale-address.json, whose oracle is `isTailnetAddress` in
/// src/lib/native-contract.test.ts. The glue hands the core the raw bytes
/// from getifaddrs; inet_pton turns each fixture's text into those bytes.
final class TailscaleAddressTests: XCTestCase {
    private func bytes(_ text: String) -> [UInt8]? {
        var v4 = in_addr()
        if inet_pton(AF_INET, text, &v4) == 1 { return withUnsafeBytes(of: &v4) { Array($0) } }
        var v6 = in6_addr()
        if inet_pton(AF_INET6, text, &v6) == 1 { return withUnsafeBytes(of: &v6) { Array($0) } }
        return nil
    }

    func testSharedAddressCases() throws {
        let cases = try XCTUnwrap(Fixtures.json("tailscale-address.json") as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 30)
        for entry in cases {
            let text = try XCTUnwrap(entry["address"] as? String)
            let expected = try XCTUnwrap(entry["tailnet"] as? Bool)
            // A case that doesn't parse fails on its own; it never skips the rest.
            guard let raw = bytes(text) else {
                XCTFail("not an address: \(text)")
                continue
            }
            XCTAssertEqual(TailscaleAddress.isTailnet(raw), expected, text)
        }
    }

    /// Java hands an IPv4-mapped address over as its 4 IPv4 bytes; Darwin
    /// keeps 16. Both read the embedded IPv4, so the platforms agree.
    func testIPv4MappedReadsTheEmbeddedAddress() {
        let mapped: [UInt8] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]
        XCTAssertTrue(TailscaleAddress.isTailnet(mapped + [100, 64, 0, 1]))
        XCTAssertFalse(TailscaleAddress.isTailnet(mapped + [100, 128, 0, 0]))
        XCTAssertFalse(TailscaleAddress.isTailnet([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 64, 0, 1])) // IPv4-compatible is not mapped
    }

    func testOnlyFourOrSixteenBytesAreAddresses() {
        XCTAssertFalse(TailscaleAddress.isTailnet([]))
        XCTAssertFalse(TailscaleAddress.isTailnet([100, 64, 0]))
        XCTAssertFalse(TailscaleAddress.isTailnet([100, 64, 0, 1, 0]))
        XCTAssertFalse(TailscaleAddress.isTailnet([0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0]))
    }

    private let on: [UInt8] = [100, 101, 102, 103]
    private let wifi: [UInt8] = [192, 168, 1, 20]

    func testConnectedWhenAnyAddressIsOnTheTailnet() {
        XCTAssertEqual(TailscaleStatus.ios(opensScheme: true, addresses: [wifi, on]), TailscaleStatus(installed: true, connected: true))
        XCTAssertEqual(TailscaleStatus.ios(opensScheme: true, addresses: [wifi]), TailscaleStatus(installed: true, connected: false))
        XCTAssertEqual(TailscaleStatus.ios(opensScheme: true, addresses: []), TailscaleStatus(installed: true, connected: false))
        // getifaddrs failed: unknown, never "off".
        XCTAssertEqual(TailscaleStatus.ios(opensScheme: true, addresses: nil), TailscaleStatus(installed: true, connected: nil))
    }

    /// Tailscale for iOS registers no documented URL scheme, so canOpenURL
    /// saying no is not "not installed": unknown, unless it is plainly on.
    func testIOSNeverSaysNotInstalled() {
        XCTAssertEqual(TailscaleStatus.ios(opensScheme: false, addresses: [wifi]), TailscaleStatus(installed: nil, connected: false))
        XCTAssertEqual(TailscaleStatus.ios(opensScheme: false, addresses: [on]), TailscaleStatus(installed: true, connected: true))
        XCTAssertEqual(TailscaleStatus.ios(opensScheme: false, addresses: nil), TailscaleStatus(installed: nil, connected: nil))
    }

    func testWireShapeUsesNullForUnknown() {
        let wire = TailscaleStatus(installed: nil, connected: false).wire
        XCTAssertTrue(wire["installed"] is NSNull)
        XCTAssertEqual(wire["connected"] as? Bool, false)
        XCTAssertEqual(Set(wire.keys), ["installed", "connected"])
    }
}
