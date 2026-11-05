import XCTest
@testable import MurageShellCore

/// A closing workspace's page reaches nothing native, whatever it asks.
final class BridgeGateTests: XCTestCase {
    /// What the controller's message handler does, in the order it does it.
    private func handle(_ gate: BridgeGate, method: ChannelMethod, ran: inout [ChannelMethod]) -> String? {
        guard gate.admitsRequest() else { return ChannelError.unavailable.rawValue }
        if case .success(let request) = ChannelGate.parse(["method": method.rawValue, "args": [String: Any]()] as [String: Any]) {
            ran.append(request.method)
        }
        return nil
    }

    func testEveryMethodIsAdmittedWhileOpen() {
        let gate = BridgeGate()
        var ran: [ChannelMethod] = []
        for method in ChannelMethod.allCases where method != .openPhoneForBots && method != .pairRefused {
            XCTAssertNil(handle(gate, method: method, ran: &ran), method.rawValue)
        }
        XCTAssertTrue(ran.contains(.callAudioOpen))
        XCTAssertTrue(gate.admitsEvent())
    }

    func testOnceClosingEveryMethodIsRejectedAndNoneRuns() {
        let gate = BridgeGate()
        gate.close()
        var ran: [ChannelMethod] = []
        for method in ChannelMethod.allCases {
            XCTAssertEqual(handle(gate, method: method, ran: &ran), "unavailable", method.rawValue)
        }
        XCTAssertTrue(ran.isEmpty, "callAudioOpen, Ask, phone and job calls included")
        XCTAssertTrue(ChannelMethod.allCases.contains(.callAudioOpen))
    }

    func testOnceClosingNoEventIsSentAndClosingIsIrreversible() {
        let gate = BridgeGate()
        XCTAssertTrue(gate.admitsEvent())
        gate.close()
        XCTAssertFalse(gate.admitsEvent())
        gate.close()
        XCTAssertTrue(gate.isClosed)
        XCTAssertFalse(gate.admitsRequest())
    }
}
