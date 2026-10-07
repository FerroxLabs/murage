import Foundation
@testable import MurageShellCore

@MainActor final class FakeRelay: RelayTransport {
    var answers: [(Int?, [String: Any]?)] = []
    var sent: [RelayRequest] = []
    var beforeAnswer: (() -> Void)?
    var delayNanos: UInt64 = 0
    var routes: [String] { sent.map { "\($0.method) \($0.path)" } }
    func send(_ request: RelayRequest) async -> (status: Int?, body: [String: Any]?) {
        sent.append(request)
        await Task.yield()
        if delayNanos > 0 { try? await Task.sleep(nanoseconds: delayNanos) }
        beforeAnswer?()
        return answers.isEmpty ? (nil, nil) : answers.removeFirst()
    }
}

@MainActor final class FakeAttester: PushAttester {
    var isSupported = true
    var challenges: [String] = []
    func attest(challenge: String) async -> (keyId: String, attestationObject: String)? {
        challenges.append(challenge)
        return ("key", "object")
    }
}
