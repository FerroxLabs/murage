import XCTest
@testable import MurageShellCore

final class ShellInfoTests: XCTestCase {
    func testUserAgentTokenIsWhatThePageLooksFor() {
        let token = ShellInfo.userAgentToken(version: "1.0.0", platform: "ios")
        XCTAssertEqual(token, "MurageApp/1.0.0 (ios)")
        XCTAssertTrue(token.hasPrefix("MurageApp/"))
        XCTAssertEqual(ShellInfo.channelVersion, 1)
    }
}
