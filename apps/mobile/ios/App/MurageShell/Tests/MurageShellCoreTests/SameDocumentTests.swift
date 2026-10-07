import XCTest
@testable import MurageShellCore

final class SameDocumentTests: XCTestCase {
    let host = "https://mac.tailnet123.ts.net"

    private func url(_ string: String) -> URL { URL(string: string)! }

    /// The device finding: a tap's "/#open=…" over a page already at "/".
    func testOnlyTheFragmentDiffers() {
        XCTAssertTrue(SameDocument.of(current: url(host + "/#open=a"), target: url(host + "/#open=b")))
        XCTAssertTrue(SameDocument.of(current: url(host + "/"), target: url(host + "/#open=b")))
        XCTAssertTrue(SameDocument.of(current: url(host + "/#open=a"), target: url(host + "/")))
        XCTAssertTrue(SameDocument.of(current: url(host + "/"), target: url(host + "/")))
    }

    func testAnotherPathOrQueryIsANewDocument() {
        XCTAssertFalse(SameDocument.of(current: url(host + "/enter"), target: url(host + "/#open=b")))
        XCTAssertFalse(SameDocument.of(current: url(host + "/?a=1#open=a"), target: url(host + "/#open=b")))
        XCTAssertFalse(SameDocument.of(current: url(host + "/?a=1"), target: url(host + "/?a=2")))
    }

    func testAnotherOriginOrNoPageIsANewDocument() {
        XCTAssertFalse(SameDocument.of(current: nil, target: url(host + "/#open=b")))
        XCTAssertFalse(SameDocument.of(current: url("https://other.tailnet123.ts.net/"), target: url(host + "/#open=b")))
        XCTAssertFalse(SameDocument.of(current: url(host + ":8444/"), target: url(host + "/#open=b")))
    }

    /// replaceState fires no hashchange; a failure answers false so the caller loads as before.
    func testTheReloadScriptQuotesTheTarget() {
        let script = SameDocument.reloadScript(target: url(host + "/#open=a'b%22c"))
        XCTAssertTrue(script.contains("history.replaceState(null, '', \"https://mac.tailnet123.ts.net/#open=a'b%22c\")"), script)
        XCTAssertTrue(script.contains("location.reload()"), script)
        XCTAssertTrue(script.contains("return false"), script)
    }
}
