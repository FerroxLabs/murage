import XCTest
@testable import MurageShellCore

final class ChannelScriptTests: XCTestCase {
    func testInjectsTheSavedOriginAsAJavaScriptString() {
        let script = ChannelScript.ios(origin: WorkspaceOrigin(string: "https://mac.tailnet123.ts.net:8444")!)
        XCTAssertTrue(script.contains(#"location.origin !== "https://mac.tailnet123.ts.net:8444""#))
        XCTAssertFalse(script.contains("__ORIGIN__"))
        XCTAssertTrue(script.contains("window !== window.top"))
    }
}
