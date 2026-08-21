import XCTest
@testable import CompanionCore

final class ProfileRoutinePolicyTests: XCTestCase {
    func testAgentVoiceWorksWithoutANonexistentWorkspaceDefault() throws {
        let keyOnly = try decodeConfig(#"{"tts":{"configured":true,"ready":false,"voice":""}}"#)
        XCTAssertTrue(keyOnly.isTTSConfigured)
        XCTAssertFalse(keyOnly.hasWorkspaceDefaultVoice)
        XCTAssertFalse(keyOnly.canSpeak(agentVoice: nil))
        XCTAssertTrue(keyOnly.canSpeak(agentVoice: "agent-voice"))

        let withDefault = try decodeConfig(#"{"tts":{"configured":true,"ready":true,"voice":"workspace-voice"}}"#)
        XCTAssertTrue(withDefault.hasWorkspaceDefaultVoice)
        XCTAssertTrue(withDefault.canSpeak(agentVoice: nil))
    }

    private func decodeConfig(_ json: String) throws -> ConfigStatus {
        try JSONDecoder().decode(ConfigStatus.self, from: Data(json.utf8))
    }
}
