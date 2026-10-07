import XCTest
@testable import MurageShellCore

final class MemoryStore: KeyValueStore {
    var values: [String: String] = [:]
    func string(forKey key: String) -> String? { values[key] }
    func set(_ value: String?, forKey key: String) { values[key] = value }
}

final class RouteMemoryTests: XCTestCase {
    let mac = WorkspaceOrigin(string: "https://mac.tailnet123.ts.net")!
    let server = WorkspaceOrigin(string: "https://server.tailnet123.ts.net")!

    func testStartsAtTheRootWithNothingRemembered() {
        XCTAssertEqual(RouteMemory(store: MemoryStore()).startPath(for: mac), "/")
    }

    func testReturnsToTheLastConversationPerComputer() {
        let memory = RouteMemory(store: MemoryStore())
        XCTAssertTrue(memory.remember(threadId: "t1", for: mac))
        XCTAssertEqual(memory.startPath(for: mac), "/#open=t1")
        XCTAssertEqual(memory.startPath(for: server), "/")
        XCTAssertFalse(memory.remember(threadId: "", for: mac))
        XCTAssertFalse(memory.remember(threadId: String(repeating: "t", count: OpenHash.maxIdLength + 1), for: mac))
        XCTAssertEqual(memory.startPath(for: mac), "/#open=t1")
    }

    func testAPendingOpenWinsUntilThePageIsReady() {
        let memory = RouteMemory(store: MemoryStore())
        memory.remember(threadId: "t1", for: mac)
        XCTAssertTrue(memory.setPending(PendingOpen(origin: mac, threadId: "p1", messageId: "m1")))
        XCTAssertEqual(memory.startPath(for: mac), "/#open=p1&msg=m1")
        XCTAssertEqual(memory.startPath(for: server), "/")
        memory.clearPending(for: server)
        XCTAssertNotNil(memory.pending)
        memory.clearPending(for: mac)
        XCTAssertEqual(memory.startPath(for: mac), "/#open=t1")
    }

    /// Spec §3.2: the route and the pending intent survive the app being killed.
    func testSurvivesANewProcess() {
        let store = MemoryStore()
        RouteMemory(store: store).remember(threadId: "t1", for: mac)
        RouteMemory(store: store).setPending(PendingOpen(origin: server, threadId: "p1", messageId: nil))
        let later = RouteMemory(store: store)
        XCTAssertEqual(later.startPath(for: mac), "/#open=t1")
        XCTAssertEqual(later.startPath(for: server), "/#open=p1")
    }

    func testForgettingAComputerClearsItsRouteAndIntent() {
        let memory = RouteMemory(store: MemoryStore())
        memory.remember(threadId: "t1", for: mac)
        memory.setPending(PendingOpen(origin: mac, threadId: "p1", messageId: nil))
        memory.forget(mac)
        XCTAssertEqual(memory.startPath(for: mac), "/")
        XCTAssertNil(memory.pending)
        XCTAssertFalse(memory.setPending(PendingOpen(origin: mac, threadId: "", messageId: nil)))
        XCTAssertFalse(memory.setPending(PendingOpen(origin: mac, threadId: String(repeating: "p", count: OpenHash.maxIdLength + 1), messageId: nil)))
        XCTAssertNil(memory.pending)
    }

    /// Only thread ids and bare origins are kept: never the pairing credential from an /enter link.
    func testNeverStoresTheCredential() {
        let store = MemoryStore()
        let memory = RouteMemory(store: store)
        let paired = WorkspaceOrigin(string: "https://mac.tailnet123.ts.net/enter#murage_pair_secret&installId=abcdefghijklmnop")!
        memory.remember(threadId: "t1", for: paired)
        memory.setPending(PendingOpen(origin: paired, threadId: "p1", messageId: "m1"))
        XCTAssertEqual(Set(store.values.keys), [RouteMemory.pendingKey, "murage.route.https://mac.tailnet123.ts.net"])
        for (key, value) in store.values {
            XCTAssertFalse((key + value).contains("murage_pair"), value)
            XCTAssertFalse((key + value).contains("enter"), value)
            XCTAssertFalse((key + value).contains("installId"), value)
        }
    }

    func testADamagedPendingIntentIsIgnored() {
        let store = MemoryStore()
        let memory = RouteMemory(store: store)
        memory.remember(threadId: "t1", for: mac)
        let tooLong = String(repeating: "p", count: OpenHash.maxIdLength + 1)
        for bad in ["garbage", "{}", #"{"origin":5,"threadId":"p1"}"#, #"{"origin":"https://mac.tailnet123.ts.net","threadId":7}"#,
                    #"{"origin":"https://mac.tailnet123.ts.net","threadId":""}"#, #"{"origin":"https://mac.tailnet123.ts.net"}"#,
                    #"{"origin":"https://mac.tailnet123.ts.net","threadId":"\#(tooLong)"}"#] {
            store.values[RouteMemory.pendingKey] = bad
            XCTAssertNil(memory.pending, bad)
            XCTAssertEqual(memory.startPath(for: mac), "/#open=t1", bad)
        }
        // A wrongly typed messageId voids the record; a null one is just absent.
        store.values[RouteMemory.pendingKey] = #"{"origin":"https://mac.tailnet123.ts.net","threadId":"p1","messageId":5}"#
        XCTAssertEqual(memory.startPath(for: mac), "/#open=t1")
        store.values[RouteMemory.pendingKey] = #"{"origin":"https://mac.tailnet123.ts.net","threadId":"p1","messageId":null}"#
        XCTAssertEqual(memory.startPath(for: mac), "/#open=p1")
    }

    func testThePendingRecordHoldsOnlyItsFields() throws {
        let store = MemoryStore()
        RouteMemory(store: store).setPending(PendingOpen(origin: mac, threadId: "p1", messageId: nil))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(store.values[RouteMemory.pendingKey]).utf8)) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["origin", "threadId"])
        XCTAssertEqual(json["origin"] as? String, "https://mac.tailnet123.ts.net")
    }
}
