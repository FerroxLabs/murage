import XCTest
@testable import MurageShellCore

final class PairingLinkTests: XCTestCase {
    let install = "ios-0123456789abcdef0123456789abcdef"

    func testFullModeAppendsTheInstallId() {
        XCTAssertEqual(PairingLink.enterPath(credential: "murage_pair_abc", installId: install), "/enter#murage_pair_abc&installId=\(install)")
        XCTAssertEqual(PairingLink.enterPath(credential: "123456", installId: install), "/enter#123456&installId=\(install)")
    }

    /// An older door takes the whole fragment as the credential, so the suffix
    /// would break pairing (Review Focus 5).
    func testNoInstallIdForAnOlderDoor() {
        XCTAssertEqual(PairingLink.enterPath(credential: "murage_pair_abc", installId: nil), "/enter#murage_pair_abc")
    }

    func testRefusesACredentialThatCouldCarryItsOwnSuffix() {
        XCTAssertNil(PairingLink.enterPath(credential: "abc&installId=x", installId: nil))
        XCTAssertNil(PairingLink.enterPath(credential: "12 34 56", installId: nil))
        XCTAssertNil(PairingLink.enterPath(credential: "", installId: nil))
        XCTAssertNil(PairingLink.enterPath(credential: String(repeating: "a", count: 513), installId: nil))
        XCTAssertNil(PairingLink.enterPath(credential: "abc", installId: "short"))
    }

    func testNewInstallIdsMatchTheDoorsPattern() {
        let id = PairingLink.newInstallId(prefix: "ios", uuid: UUID(uuidString: "E621E1F8-C36C-495A-93FC-0C247A3E6E5F")!)
        XCTAssertEqual(id, "ios-e621e1f8c36c495a93fc0c247a3e6e5f")
        XCTAssertTrue(PairingLink.validInstallId(id))
        XCTAssertFalse(PairingLink.validInstallId(nil))
        XCTAssertFalse(PairingLink.validInstallId("has space in it 0123"))
    }

    /// P17: the QR scanner hands the launcher only `<origin>/enter#<credential>`.
    func testParsesTheComputersPairingLink() {
        let link = PairingLink.parse("https://Mac.tailnet123.ts.net:443/enter#murage_pair_abc")
        XCTAssertEqual(link?.origin.serialized, "https://mac.tailnet123.ts.net")
        XCTAssertEqual(link?.credential, "murage_pair_abc")
        XCTAssertEqual(PairingLink.parse(" https://mac.tailnet123.ts.net:8444/enter#123456 ")?.origin.port, 8444)
    }

    func testRefusesAnyOtherCode() {
        for text in [
            "https://mac.tailnet123.ts.net/",
            "https://mac.tailnet123.ts.net/enter",
            "https://mac.tailnet123.ts.net/enter#",
            "https://mac.tailnet123.ts.net/enter/#murage_pair_abc",
            "https://mac.tailnet123.ts.net/other#murage_pair_abc",
            "https://mac.tailnet123.ts.net/enter?x=1#murage_pair_abc",
            "https://mac.tailnet123.ts.net/enter#murage_pair_abc&installId=ios-0123456789abcdef",
            "https://mac.tailnet123.ts.net/enter#a#b",
            "http://mac.tailnet123.ts.net/enter#murage_pair_abc",
            "https://user@mac.tailnet123.ts.net/enter#murage_pair_abc",
            "https://100.64.0.1/enter#murage_pair_abc",
            "https://mac.tailnet123.ts.net/enter#murage_pair_abc\n",
            "WIFI:S:home;T:WPA;P:secret;;",
            "https://mac.tailnet123.ts.net/enter#" + String(repeating: "a", count: 513),
        ] {
            XCTAssertNil(PairingLink.parse(text), text)
        }
    }

    func testEnterPathCarriesTheApprovalKeyOnlyWithAStatement() {
        let install = "ios-0123456789abcdef0123456789abcdef"
        let key = String(repeating: "B", count: 87)
        let statement = String(repeating: "S", count: 120) + "." + String(repeating: "T", count: 86)
        XCTAssertEqual(PairingLink.enterPath(credential: "murage_pair_abc", installId: install, approvalKey: nil, approvalStatement: nil), "/enter#murage_pair_abc&installId=\(install)")
        // F2: a key with no statement cannot be built by API shape.
        XCTAssertNil(PairingLink.enterPath(credential: "murage_pair_abc", installId: install, approvalKey: key, approvalStatement: nil))
        XCTAssertNil(PairingLink.enterPath(credential: "murage_pair_abc", installId: nil, approvalKey: key, approvalStatement: statement))
        XCTAssertNil(PairingLink.enterPath(credential: "murage_pair_abc", installId: install, approvalKey: "short", approvalStatement: statement))
        XCTAssertNil(PairingLink.enterPath(credential: "murage_pair_abc", installId: install, approvalKey: String(repeating: "B", count: 86) + "=", approvalStatement: statement))
    }

    /// The desktop parser (companion/src/browser.ts enterPage) reads
    /// installId, then approvalKey, then approvalStatement, in that order.
    func testEnterPathCarriesTheRelayStatementLast() {
        let install = "ios-0123456789abcdef0123456789abcdef"
        let key = String(repeating: "B", count: 87)
        let statement = String(repeating: "S", count: 120) + "." + String(repeating: "T", count: 86)
        XCTAssertEqual(PairingLink.enterPath(credential: "murage_pair_abc", installId: install, approvalKey: key, approvalStatement: statement),
                       "/enter#murage_pair_abc&installId=\(install)&approvalKey=\(key)&approvalStatement=\(statement)")
        XCTAssertNil(PairingLink.enterPath(credential: "murage_pair_abc", installId: install, approvalKey: nil, approvalStatement: statement))
        for bad in ["nodot", String(repeating: "S", count: 39) + "." + String(repeating: "T", count: 86), String(repeating: "S", count: 120) + "." + String(repeating: "T", count: 85), String(repeating: "S", count: 1201) + "." + String(repeating: "T", count: 86), "a&b." + String(repeating: "T", count: 86)] {
            XCTAssertNil(PairingLink.enterPath(credential: "murage_pair_abc", installId: install, approvalKey: key, approvalStatement: bad), bad)
        }
    }
}
