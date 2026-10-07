import XCTest
@testable import MurageShellCore

final class WorkspaceBookTests: XCTestCase {
    let mac = WorkspaceOrigin(string: "https://mac.tailnet123.ts.net")!
    let server = WorkspaceOrigin(string: "https://server.tailnet123.ts.net")!

    private func host(_ index: Int) -> WorkspaceOrigin { WorkspaceOrigin(string: "https://host\(index).tailnet123.ts.net")! }

    private func decode(_ json: Any) throws -> WorkspaceBook {
        WorkspaceBook.decode(try JSONSerialization.data(withJSONObject: json))
    }

    private func decodeList(_ list: [[String: Any]]) throws -> WorkspaceBook { try decode(["workspaces": list]) }

    func testSigningInSavesAndActivates() {
        var book = WorkspaceBook()
        book.signedIn(mac, name: "Sean's Mac", at: 1_000)
        XCTAssertEqual(book.workspaces, [SavedWorkspace(origin: "https://mac.tailnet123.ts.net", name: "Sean's Mac", lastConnected: 1_000)])
        XCTAssertEqual(book.active, "https://mac.tailnet123.ts.net")
    }

    func testANameIsKeptUntilABetterOneArrives() {
        var book = WorkspaceBook()
        book.signedIn(server, name: nil, at: 1_000)
        XCTAssertEqual(book.entry(for: server)?.name, "server")
        book.signedIn(server, name: "Home server", at: 2_000)
        book.signedIn(server, name: nil, at: 3_000)
        book.signedIn(server, name: "", at: 3_000)
        XCTAssertEqual(book.entry(for: server)?.name, "Home server")
        XCTAssertEqual(book.entry(for: server)?.lastConnected, 3_000)
        book.signedIn(server, name: String(repeating: "s", count: 500), at: 4_000)
        XCTAssertEqual(book.entry(for: server)?.name.unicodeScalars.count, 200)
    }

    func testNewestFirstAndRemoval() {
        var book = WorkspaceBook()
        book.signedIn(mac, name: nil, at: 1_000)
        book.signedIn(server, name: nil, at: 2_000)
        XCTAssertEqual(book.sorted.map(\.origin), [server.serialized, mac.serialized])
        book.remove(server)
        XCTAssertNil(book.active)
        XCTAssertEqual(book.workspaces.count, 1)
    }

    /// Like Java's stable sort: equal times keep the order they are listed in.
    func testSortedKeepsTiesInListedOrder() {
        var book = WorkspaceBook()
        for index in 0..<12 { book.signedIn(host(index), name: nil, at: 7) }
        XCTAssertEqual(book.sorted.map(\.origin), (0..<12).map { host($0).serialized })
    }

    func testKeepsTwentyAndDropsTheOldest() {
        var book = WorkspaceBook()
        for index in 0..<21 {
            book.signedIn(host(index), name: nil, at: Int64(index))
        }
        XCTAssertEqual(book.workspaces.count, 20)
        XCTAssertNil(book.entry(for: host(0)))
    }

    /// The computer just signed in to is never the one evicted, even when its time is older than every other.
    func testSigningInNeverEvictsTheNewEntry() {
        var book = WorkspaceBook()
        for index in 0..<WorkspaceBook.limit { book.signedIn(host(index), name: nil, at: 10_000 + Int64(index)) }
        book.signedIn(mac, name: nil, at: 5)
        XCTAssertEqual(book.workspaces.count, WorkspaceBook.limit)
        XCTAssertNotNil(book.entry(for: mac))
        XCTAssertEqual(book.active, mac.serialized)
        XCTAssertNil(book.entry(for: host(0)))
    }

    /// Use after pairing (a load, going to the background) moves the time on;
    /// it never adds a computer, never changes the active one, and so never evicts.
    func testTouchingMovesTheTimeOfASavedComputerOnly() {
        var book = WorkspaceBook()
        book.signedIn(mac, name: "Sean's Mac", at: 1_000)
        book.signedIn(server, name: nil, at: 2_000)
        XCTAssertTrue(book.touched(mac, at: 90_000))
        XCTAssertEqual(book.entry(for: mac), SavedWorkspace(origin: mac.serialized, name: "Sean's Mac", lastConnected: 90_000))
        XCTAssertEqual(book.sorted.map(\.origin), [mac.serialized, server.serialized])
        XCTAssertEqual(book.active, server.serialized)
        var full = WorkspaceBook()
        for index in 0..<WorkspaceBook.limit { full.signedIn(host(index), name: nil, at: Int64(index)) }
        let before = full
        XCTAssertFalse(full.touched(mac, at: 500_000)) // removed or never saved: nothing comes back
        XCTAssertEqual(full, before)
    }

    /// "Last connected" shows minutes: a touch within a minute of the saved
    /// time changes nothing, so the store is not written again.
    func testTouchingWithinAMinuteChangesNothing() {
        var book = WorkspaceBook()
        book.signedIn(mac, name: nil, at: 1_000_000)
        let before = book
        XCTAssertFalse(book.touched(mac, at: 1_000_000))
        XCTAssertFalse(book.touched(mac, at: 1_059_999))
        XCTAssertEqual(book, before)
        XCTAssertTrue(book.touched(mac, at: 1_060_000))
        XCTAssertEqual(book.entry(for: mac)?.lastConnected, 1_060_000)
        // A clock that went back is still a later use: the time follows it.
        XCTAssertTrue(book.touched(mac, at: 5_000))
        XCTAssertEqual(book.entry(for: mac)?.lastConnected, 5_000)
    }

    func testDecodingIsForgiving() {
        XCTAssertEqual(WorkspaceBook.decode(nil), WorkspaceBook())
        XCTAssertEqual(WorkspaceBook.decode(Data("garbage".utf8)), WorkspaceBook())
        XCTAssertEqual(WorkspaceBook.decode(Data("[]".utf8)), WorkspaceBook())
        XCTAssertEqual(WorkspaceBook.decode(Data(#"{"workspaces":{}}"#.utf8)), WorkspaceBook())
        let dirty = #"{"workspaces":[{"origin":"http://bad","name":"x","lastConnected":1},{"origin":"https://Mac.tailnet123.ts.net","name":"Mac","lastConnected":2}],"active":"http://bad"}"#
        let book = WorkspaceBook.decode(Data(dirty.utf8))
        XCTAssertEqual(book.workspaces.map(\.origin), ["https://mac.tailnet123.ts.net"])
        XCTAssertNil(book.active)
    }

    /// A damaged entry is dropped alone; the rest of the book survives.
    func testOneDamagedEntryDropsOnlyItself() {
        let stored = #"{"workspaces":["x",7,null,{},{"origin":5},{"name":"no origin"},{"origin":"https://mac.tailnet123.ts.net","name":"Mac","lastConnected":"soon"},{"origin":"https://server.tailnet123.ts.net","name":["S"]}],"active":"https://server.tailnet123.ts.net"}"#
        let book = WorkspaceBook.decode(Data(stored.utf8))
        XCTAssertEqual(book.workspaces, [
            SavedWorkspace(origin: mac.serialized, name: "Mac", lastConnected: 0),
            SavedWorkspace(origin: server.serialized, name: "server", lastConnected: 0),
        ])
        XCTAssertEqual(book.active, server.serialized)
    }

    func testRoundTrip() {
        var book = WorkspaceBook()
        book.signedIn(mac, name: "Mac", at: 5)
        book.signedIn(server, name: "Server 😀", at: 1_700_000_000_000)
        XCTAssertEqual(WorkspaceBook.decode(book.encoded()), book)
    }

    /// The book keeps origin, name and time only: no credential, cookie or unknown field survives a round trip.
    func testNeverPersistsCredentialsOrUnknownFields() throws {
        let stored = #"{"workspaces":[{"origin":"https://mac.tailnet123.ts.net","name":"Mac","lastConnected":2,"credential":"murage_pair_secret","cookie":"murage_session=abc"}],"active":"https://mac.tailnet123.ts.net","token":"murage_pair_secret"}"#
        var book = WorkspaceBook.decode(Data(stored.utf8))
        book.signedIn(WorkspaceOrigin(string: "https://server.tailnet123.ts.net/enter#murage_pair_other&installId=abcdefghijklmnop")!, name: nil, at: 3)
        let encoded = String(decoding: book.encoded(), as: UTF8.self)
        for secret in ["murage_pair", "murage_session", "enter", "installId", "credential", "cookie", "token"] {
            XCTAssertFalse(encoded.contains(secret), encoded)
        }
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: book.encoded()) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["workspaces", "active"])
        for item in try XCTUnwrap(json["workspaces"] as? [[String: Any]]) {
            XCTAssertEqual(Set(item.keys), ["origin", "name", "lastConnected"])
        }
        XCTAssertEqual(book.active, "https://server.tailnet123.ts.net")
    }

    /// Every row of contract/origins.json: a saved origin survives decoding only if it parses, and only in its clean form.
    func testSharedOriginRows() throws {
        let cases = try XCTUnwrap(Fixtures.json("origins.json") as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 40)
        for row in cases {
            let input = try XCTUnwrap(row["input"] as? String)
            let book = try decodeList([["origin": input, "name": "x", "lastConnected": 1]])
            XCTAssertEqual(book.workspaces.first?.origin, row["origin"] as? String, input.debugDescription)
            XCTAssertLessThanOrEqual(book.workspaces.count, 1)
        }
    }

    func testDecodingCleansNamesDuplicatesAndTheLimit() throws {
        var list: [[String: Any]] = [
            ["origin": "https://mac.tailnet123.ts.net", "name": 7, "lastConnected": 1],
            ["origin": "https://MAC.tailnet123.ts.net", "name": "dup", "lastConnected": 2],
            ["origin": "https://server.tailnet123.ts.net", "name": String(repeating: "s", count: 500), "lastConnected": 3],
        ]
        for index in 0..<30 { list.append(["origin": host(index).serialized, "name": "h", "lastConnected": 100 + index]) }
        let book = try decode(["workspaces": list, "active": "https://MAC.tailnet123.ts.net"])
        XCTAssertEqual(book.workspaces.count, WorkspaceBook.limit)
        XCTAssertEqual(book.sorted.first?.origin, "https://host29.tailnet123.ts.net")
        XCTAssertNil(book.entry(for: mac))
        // "active" must name a saved origin exactly.
        XCTAssertNil(book.active)

        let small = try decodeList(Array(list.prefix(3)))
        XCTAssertEqual(small.workspaces.count, 2)
        XCTAssertEqual(small.entry(for: mac)?.name, "mac")
        XCTAssertEqual(small.entry(for: server)?.name, String(repeating: "s", count: 200))
    }

    /// Names are cut at 200 code points, as Java cuts them; an empty one is the machine name.
    func testDecodingCutsNamesByCodePoint() throws {
        let face = "😀"
        let book = try decodeList([
            ["origin": mac.serialized, "name": String(repeating: face, count: 300)],
            ["origin": server.serialized, "name": ""],
            ["origin": host(1).serialized, "name": String(repeating: "n", count: 199) + "e\u{301}"],
        ])
        XCTAssertEqual(book.entry(for: mac)?.name, String(repeating: face, count: 200))
        XCTAssertEqual(book.entry(for: server)?.name, "server")
        XCTAssertEqual(book.entry(for: host(1))?.name, String(repeating: "n", count: 199) + "e")
    }

    /// "active" is checked after the cap: an active entry the cap dropped is not active.
    func testActiveIsCheckedAfterTheCap() throws {
        var list: [[String: Any]] = [["origin": mac.serialized, "lastConnected": 1]]
        for index in 0..<WorkspaceBook.limit { list.append(["origin": host(index).serialized, "lastConnected": 100 + index]) }
        let book = try decode(["workspaces": list, "active": mac.serialized])
        XCTAssertNil(book.entry(for: mac))
        XCTAssertNil(book.active)
        let kept = try decode(["workspaces": list, "active": host(3).serialized])
        XCTAssertEqual(kept.active, host(3).serialized)
        XCTAssertNil(try decode(["workspaces": list, "active": 5]).active)
    }

    /// lastConnected is an integer or it is 0: a string such as "1e3", a fraction or a boolean is not read as a time.
    func testDecodingReadsOnlyIntegerTimes() {
        let stored = #"{"workspaces":[{"origin":"https://mac.tailnet123.ts.net","lastConnected":"1e3"},"#
            + #"{"origin":"https://server.tailnet123.ts.net","lastConnected":1.5},"#
            + #"{"origin":"https://host1.tailnet123.ts.net","lastConnected":1700000000000},"#
            + #"{"origin":"https://host2.tailnet123.ts.net","lastConnected":7},"#
            + #"{"origin":"https://host3.tailnet123.ts.net","lastConnected":1.0},"#
            + #"{"origin":"https://host4.tailnet123.ts.net","lastConnected":true},"#
            + #"{"origin":"https://host5.tailnet123.ts.net","lastConnected":-5},"#
            + #"{"origin":"https://host6.tailnet123.ts.net","lastConnected":9223372036854775808},"#
            + #"{"origin":"https://host7.tailnet123.ts.net","lastConnected":null}]}"#
        let book = WorkspaceBook.decode(Data(stored.utf8))
        XCTAssertEqual(book.entry(for: mac)?.lastConnected, 0)
        XCTAssertEqual(book.entry(for: server)?.lastConnected, 0)
        XCTAssertEqual(book.entry(for: host(1))?.lastConnected, 1_700_000_000_000)
        XCTAssertEqual(book.entry(for: host(2))?.lastConnected, 7)
        XCTAssertEqual(book.entry(for: host(3))?.lastConnected, 0)
        XCTAssertEqual(book.entry(for: host(4))?.lastConnected, 0)
        XCTAssertEqual(book.entry(for: host(5))?.lastConnected, -5)
        XCTAssertEqual(book.entry(for: host(6))?.lastConnected, 0)
        XCTAssertEqual(book.entry(for: host(7))?.lastConnected, 0)
    }

    /// P13 twin ruling: a duplicate origin keeps the first; at the cap, a tie drops the entry listed first among the oldest.
    func testDecodingDuplicatesAndTies() throws {
        let duplicates = try decodeList([
            ["origin": mac.serialized, "name": "first", "lastConnected": 1],
            ["origin": mac.serialized, "name": "second", "lastConnected": 9],
        ])
        XCTAssertEqual(duplicates.entry(for: mac)?.name, "first")
        XCTAssertEqual(duplicates.entry(for: mac)?.lastConnected, 1)

        let full = try decodeList((0...WorkspaceBook.limit).map { ["origin": host($0).serialized, "lastConnected": $0 < 3 ? 5 : 100 + $0] })
        XCTAssertEqual(full.workspaces.count, WorkspaceBook.limit)
        XCTAssertNil(full.entry(for: host(0)))
        XCTAssertNotNil(full.entry(for: host(1)))
        XCTAssertNotNil(full.entry(for: host(2)))
    }

    func testEntriesAreValues() {
        var book = WorkspaceBook()
        book.signedIn(mac, name: "Mac", at: 1)
        let before = book.entry(for: mac)
        book.signedIn(mac, name: "Renamed", at: 2)
        XCTAssertEqual(before?.name, "Mac")
        XCTAssertEqual(book.entry(for: mac)?.name, "Renamed")
    }

    func testDefaultNameIsTheMachineName() {
        XCTAssertEqual(WorkspaceBook.defaultName(WorkspaceOrigin(string: "https://example-mac.tailnet123.ts.net")!), "example-mac")
        XCTAssertEqual(WorkspaceBook.defaultName(WorkspaceOrigin(string: "https://localhost:8444")!), "localhost")
    }
}
