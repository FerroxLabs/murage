import Foundation
import XCTest
@testable import CompanionCore

private final class ApprovalRequestStub: URLProtocol {
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        Self.capturedBody = Self.readBody(from: request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readBody(from request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { return nil }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

final class ApprovalClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        ApprovalRequestStub.capturedRequest = nil
        ApprovalRequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ApprovalRequestStub.self]
        session = URLSession(configuration: configuration)
        client = CompanionClient(
            connection: Connection(name: "Test", host: "127.0.0.1", port: 8810),
            token: "paired-token",
            session: session
        )
    }

    override func tearDown() {
        session?.invalidateAndCancel()
        session = nil
        client = nil
        super.tearDown()
    }

    func testSkillApprovalEchoesTheReviewedHash() async throws {
        let hash = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"

        try await client.respond(
            threadId: "thread-1",
            requestId: "request-1",
            behavior: "allow",
            reviewedSha256: hash
        )

        XCTAssertEqual(ApprovalRequestStub.capturedRequest?.url?.path, "/api/threads/thread-1/respond")
        let body = try XCTUnwrap(ApprovalRequestStub.capturedBody)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(object["reviewedSha256"], hash)
        XCTAssertEqual(object["behavior"], "allow")
    }

    func testDenialDoesNotNeedAReviewedHash() async throws {
        try await client.respond(threadId: "thread-1", requestId: "request-1", behavior: "deny")

        let body = try XCTUnwrap(ApprovalRequestStub.capturedBody)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertNil(object["reviewedSha256"])
        XCTAssertEqual(object["behavior"], "deny")
    }
}
