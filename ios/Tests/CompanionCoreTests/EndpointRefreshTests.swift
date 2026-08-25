import Foundation
import XCTest
@testable import CompanionCore

private final class EndpointRefreshRequestStub: URLProtocol {
    static let lock = NSLock()
    static var responseBody = Data()
    static var capturedRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.capturedRequest = request
        let body = Self.responseBody
        Self.lock.unlock()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func reset(body: Data) {
        lock.lock()
        responseBody = body
        capturedRequest = nil
        lock.unlock()
    }

    static func captured() -> URLRequest? {
        lock.lock()
        defer { lock.unlock() }
        return capturedRequest
    }
}

final class EndpointRefreshTests: XCTestCase {
    private var session: URLSession!

    override func setUp() {
        super.setUp()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EndpointRefreshRequestStub.self]
        session = URLSession(configuration: configuration)
    }

    override func tearDown() {
        session.invalidateAndCancel()
        session = nil
        super.tearDown()
    }

    func testFetchesTheAuthenticatedEndpointSnapshot() async throws {
        EndpointRefreshRequestStub.reset(body: Self.fullMetadata)
        let client = CompanionClient(
            connection: Connection(name: "Mac", host: "192.168.1.42", port: 8810),
            token: "paired-token",
            session: session
        )

        let metadata = try await client.connectionMetadata()

        XCTAssertEqual(metadata.serverName, "Milind's computer")
        XCTAssertEqual(metadata.endpoints.map(\.kind), [.hosted, .tailnet, .lan])
        let request = try XCTUnwrap(EndpointRefreshRequestStub.captured())
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/companion/endpoints")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token")
    }

    func testRejectsAReplacementSnapshotWithNoUsableEndpoint() throws {
        let body = Data(#"{"serverName":"Mac","endpoints":[{"url":"http://public.example","kind":"tailnet","priority":0}]}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(CompanionConnectionMetadata.self, from: body))
    }

    func testProtectedConnectionDoesNotDowngradeWhenHostedIsWithdrawn() throws {
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
            endpoints: [hosted, lan]
        )
        let metadata = try JSONDecoder().decode(
            CompanionConnectionMetadata.self,
            from: Data(#"{"serverName":"Mac","hosts":["192.168.1.42"],"endpoints":[{"url":"http://192.168.1.42:8810","kind":"lan","priority":200}]}"#.utf8)
        )

        connection.reconcile(metadata)

        XCTAssertEqual(connection.activeEndpoint, hosted)
        XCTAssertEqual(connection.orderedEndpoints.map(\.url), [hosted.url, lan.url])
        XCTAssertEqual(connection.automaticEndpoints, [hosted])
    }

    func testExistingLocalPairingLearnsHostedWithoutRepairing() throws {
        let local = try XCTUnwrap(CompanionEndpoint(
            url: "http://192.168.1.42:8810",
            kind: .lan,
            priority: 200
        ))
        var connection = Connection(
            name: "Mac",
            host: local.host,
            port: local.port,
            activeEndpoint: local,
            endpoints: [local]
        )
        let metadata = try JSONDecoder().decode(
            CompanionConnectionMetadata.self,
            from: Self.fullMetadata
        )

        connection.reconcile(metadata)

        XCTAssertEqual(connection.activeEndpoint, local, "the live local stream is not switched underneath itself")
        XCTAssertEqual(connection.orderedEndpoints.first?.kind, .hosted, "the next launch upgrades to hosted HTTPS")

        var liveRotation = CandidateRotation(
            endpoints: [local] + connection.orderedEndpoints.filter { $0.url != local.url }
        )
        XCTAssertEqual(liveRotation.currentEndpoint, local)
        XCTAssertEqual(
            liveRotation.advanceEndpoint(after: URLError(.timedOut))?.kind,
            .hosted,
            "the current session can upgrade after its explicitly chosen local route fails"
        )
        XCTAssertTrue(liveRotation.endpoints.allSatisfy(\.protectsCredentials))
    }

    private static let fullMetadata = Data(
        #"{"serverName":"Milind's computer","hosts":["mac.tail1234.ts.net","192.168.1.42"],"endpoints":[{"url":"http://192.168.1.42:8810","kind":"lan","priority":200},{"url":"http://not-a-tailnet.example:8810","kind":"tailnet","priority":50},{"url":"http://mac.tail1234.ts.net:8810","kind":"tailnet","priority":100},{"url":"https://mac.companion.example","kind":"hosted","priority":0}]}"#.utf8
    )
}
