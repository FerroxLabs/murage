import Foundation
import XCTest
@testable import CompanionCore

final class FailoverTests: XCTestCase {
    // MARK: - CandidateRotation

    func testWalksTheCandidatesInOrderAndWraps() {
        var rotation = CandidateRotation(hosts: ["mac.tail1234.ts.net", "192.168.1.42", "openmausbot-aa.local"])
        XCTAssertEqual(rotation.current, "mac.tail1234.ts.net")
        XCTAssertEqual(rotation.advance(), "192.168.1.42")
        XCTAssertEqual(rotation.advance(), "openmausbot-aa.local")
        // Wraps rather than giving up: the retry loop backs off between laps,
        // and a network that comes back deserves another try at the front.
        XCTAssertEqual(rotation.advance(), "mac.tail1234.ts.net")
    }

    func testPromotesTheWorkingCandidateToTheFront() {
        var rotation = CandidateRotation(hosts: ["mac.tail1234.ts.net", "192.168.1.42", "openmausbot-aa.local"])
        rotation.advance() // the tailnet name failed; the LAN address carried a stream
        XCTAssertEqual(rotation.promoted(), ["192.168.1.42", "mac.tail1234.ts.net", "openmausbot-aa.local"])
    }

    func testPromotionWithoutAWalkChangesNothing() {
        let rotation = CandidateRotation(hosts: ["mac.tail1234.ts.net", "192.168.1.42"])
        XCTAssertEqual(rotation.promoted(), ["mac.tail1234.ts.net", "192.168.1.42"])
    }

    func testSurvivesAnEmptyCandidateList() {
        // A real connection never produces one, but the type must not trap.
        var rotation = CandidateRotation(hosts: [])
        XCTAssertEqual(rotation.current, "")
        XCTAssertEqual(rotation.advance(), "")
        XCTAssertEqual(rotation.promoted(), [])
    }

    // MARK: - Which failures move the dial

    func testRotatesOnAddressFailuresAndNothingElse() {
        XCTAssertTrue(ConnectionAdvice.shouldTryAnotherHost(.cannotFindHost)) // -1003
        XCTAssertTrue(ConnectionAdvice.shouldTryAnotherHost(.cannotConnectToHost)) // -1004
        XCTAssertTrue(ConnectionAdvice.shouldTryAnotherHost(.timedOut)) // -1001
        XCTAssertTrue(ConnectionAdvice.shouldTryAnotherHost(.secureConnectionFailed)) // -1200
        XCTAssertTrue(ConnectionAdvice.shouldTryAnotherHost(.serverCertificateHasBadDate)) // -1201
        XCTAssertTrue(ConnectionAdvice.shouldTryAnotherHost(.serverCertificateUntrusted)) // -1202
        XCTAssertTrue(ConnectionAdvice.shouldTryAnotherHost(.serverCertificateHasUnknownRoot)) // -1203
        XCTAssertTrue(ConnectionAdvice.shouldTryAnotherHost(.serverCertificateNotYetValid)) // -1204

        // Offline fails on every address, and cancellation is deliberate.
        XCTAssertFalse(ConnectionAdvice.shouldTryAnotherHost(.notConnectedToInternet)) // -1009
        XCTAssertFalse(ConnectionAdvice.shouldTryAnotherHost(.cancelled))
        XCTAssertFalse(ConnectionAdvice.shouldTryAnotherHost(.networkConnectionLost))
    }

    func testRotatesPastTunnelGatewayFailuresButNotApplicationErrors() {
        for code in [502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530] {
            XCTAssertTrue(ConnectionAdvice.shouldTryAnotherRoute(
                after: APIError.status(code: code, message: nil)
            ), "expected HTTP \(code) to move to another route")
        }
        for code in [400, 401, 403, 404, 409, 500, 501] {
            XCTAssertFalse(ConnectionAdvice.shouldTryAnotherRoute(
                after: APIError.status(code: code, message: nil)
            ), "expected HTTP \(code) to stay on the current route")
        }
    }

    func testTunnelGatewayFailureAdvancesFromHostedToLAN() throws {
        let hosted = try XCTUnwrap(CompanionEndpoint(
            url: "https://mac.companion.example",
            kind: .hosted,
            priority: 0
        ))
        let lan = try XCTUnwrap(CompanionEndpoint(
            url: "http://192.168.1.42:8810",
            kind: .lan,
            priority: 200
        ))
        var rotation = CandidateRotation(endpoints: [hosted, lan])

        let next = rotation.advanceEndpoint(
            after: APIError.status(code: 502, message: nil)
        )

        XCTAssertEqual(next, lan)
        XCTAssertEqual(rotation.currentEndpoint, lan)
    }

    func testAuthenticationFailureDoesNotAdvanceTheRoute() throws {
        let hosted = try XCTUnwrap(CompanionEndpoint(
            url: "https://mac.companion.example",
            kind: .hosted,
            priority: 0
        ))
        let lan = try XCTUnwrap(CompanionEndpoint(
            url: "http://192.168.1.42:8810",
            kind: .lan,
            priority: 200
        ))
        var rotation = CandidateRotation(endpoints: [hosted, lan])

        XCTAssertNil(rotation.advanceEndpoint(
            after: APIError.status(code: 401, message: nil)
        ))
        XCTAssertEqual(rotation.currentEndpoint, hosted)
    }

    // MARK: - The advice strings

    func testUnresolvedHostNamesTheTailnetPossibility() {
        let message = ConnectionAdvice.message(for: .cannotFindHost, host: "mac.tail1234.ts.net", port: 8810)
        XCTAssertTrue(message.contains("mac.tail1234.ts.net"))
        XCTAssertTrue(message.contains("tailnet"))
        XCTAssertTrue(message.contains("retrying automatically"))
    }

    func testRefusedConnectionPointsAtTheCompanionToggle() {
        let message = ConnectionAdvice.message(for: .cannotConnectToHost, host: "192.168.1.42", port: 8810)
        XCTAssertTrue(message.contains("port 8810"))
        XCTAssertTrue(message.contains("Settings → Companion"))
    }

    func testTimeoutBlamesTheRouteNotTheApp() {
        let message = ConnectionAdvice.message(for: .timedOut, host: "192.168.1.42", port: 8810)
        XCTAssertTrue(message.contains("No route"))
        XCTAssertTrue(message.contains("firewall"))
    }

    func testOfflineSaysOffline() {
        XCTAssertTrue(ConnectionAdvice.message(for: .notConnectedToInternet, host: "x", port: 8810)
            .contains("You're offline."))
    }

    func testAdviceNamesTheCandidateBeingTriedNext() {
        let message = ConnectionAdvice.message(
            for: .cannotFindHost,
            host: "mac.tail1234.ts.net",
            port: 8810,
            tryingNext: "192.168.1.42"
        )
        XCTAssertTrue(message.contains("Trying 192.168.1.42 next."))
    }

    func testGatewayAdviceNamesTheFallbackRoute() {
        let message = ConnectionAdvice.message(
            forGatewayStatus: 502,
            host: "https://mac.companion.example",
            tryingNext: "192.168.1.42"
        )
        XCTAssertTrue(message.contains("HTTP 502"))
        XCTAssertTrue(message.contains("Trying 192.168.1.42 next."))
    }

    // MARK: - Connection candidate helpers

    func testOrderedHostsLeadsWithTheStoredHostAndDeduplicates() {
        let connection = Connection(
            name: "Mac",
            host: "192.168.1.42",
            port: 8810,
            hosts: ["mac.tail1234.ts.net", "192.168.1.42", "openmausbot-aa.local"]
        )
        XCTAssertEqual(connection.orderedHosts, ["192.168.1.42", "mac.tail1234.ts.net", "openmausbot-aa.local"])
    }

    func testOrderedHostsFallsBackToTheSingleStoredHost() {
        // A connection saved before fallbacks existed still dials.
        let connection = Connection(name: "Mac", host: "mac.tail1234.ts.net", port: 8810)
        XCTAssertEqual(connection.orderedHosts, ["mac.tail1234.ts.net"])
    }

    func testDialingSwapsTheHostWithoutTouchingTheStoredOrder() {
        let connection = Connection(
            name: "Mac",
            host: "mac.tail1234.ts.net",
            port: 8810,
            hosts: ["mac.tail1234.ts.net", "192.168.1.42"]
        )
        let dialed = connection.dialing("192.168.1.42")
        XCTAssertEqual(dialed.host, "192.168.1.42")
        XCTAssertEqual(dialed.baseURL?.absoluteString, "http://192.168.1.42:8810")
        XCTAssertEqual(dialed.hosts, connection.hosts)
        XCTAssertEqual(dialed.id, connection.id) // same pairing, same keychain entry
    }

    func testPromoteReordersAndKeepsEveryCandidate() {
        var connection = Connection(
            name: "Mac",
            host: "mac.tail1234.ts.net",
            port: 8810,
            hosts: ["mac.tail1234.ts.net", "192.168.1.42", "openmausbot-aa.local"]
        )
        connection.promote("192.168.1.42")
        XCTAssertEqual(connection.host, "192.168.1.42")
        XCTAssertEqual(connection.hosts, ["192.168.1.42", "mac.tail1234.ts.net", "openmausbot-aa.local"])

        // A hand-typed address the list has never seen joins at the front —
        // the stored fallbacks remain worth walking behind it.
        connection.promote("10.0.0.7")
        XCTAssertEqual(connection.hosts?.first, "10.0.0.7")
        XCTAssertEqual(connection.hosts?.count, 4)
    }

    func testTypedRoutesKeepHostedHTTPSAheadOfAnActiveLANFallback() throws {
        let hosted = try XCTUnwrap(CompanionEndpoint(
            url: "https://mac.companion.example",
            kind: .hosted,
            priority: 0
        ))
        let lan = try XCTUnwrap(CompanionEndpoint(
            url: "http://192.168.1.42:8810",
            kind: .lan,
            priority: 200
        ))
        var connection = Connection(
            name: "Mac",
            host: hosted.host,
            port: hosted.port,
            activeEndpoint: hosted,
            endpoints: [lan, hosted]
        )

        connection.promote(lan)

        XCTAssertEqual(connection.baseURL?.absoluteString, lan.url)
        XCTAssertEqual(connection.orderedEndpoints.map(\.url), [hosted.url, lan.url])
    }

    func testPromotingAWorkingLegacyEndpointKeepsEveryLegacyFallback() throws {
        var connection = Connection(
            name: "Mac",
            host: "mac.tail1234.ts.net",
            port: 8810,
            hosts: ["mac.tail1234.ts.net", "192.168.1.42", "openmausbot-aa.local"]
        )
        let lan = try XCTUnwrap(CompanionEndpoint.direct(
            host: "192.168.1.42",
            port: 8810,
            priority: 1
        ))

        connection.promote(lan)

        XCTAssertNil(connection.endpoints)
        XCTAssertEqual(connection.orderedEndpoints.map(\.host), [
            "192.168.1.42", "mac.tail1234.ts.net", "openmausbot-aa.local",
        ])
    }

    func testTypedRotationPreservesSchemesAndPorts() throws {
        let hosted = try XCTUnwrap(CompanionEndpoint(
            url: "https://mac.companion.example",
            kind: .hosted,
            priority: 0
        ))
        let direct = try XCTUnwrap(CompanionEndpoint(
            url: "http://192.168.1.42:9910",
            kind: .lan,
            priority: 200
        ))
        var rotation = CandidateRotation(endpoints: [hosted, direct])

        XCTAssertEqual(rotation.currentEndpoint, hosted)
        XCTAssertEqual(rotation.advanceEndpoint(), direct)
        XCTAssertEqual(rotation.promotedEndpoints(), [direct, hosted])
    }
}
