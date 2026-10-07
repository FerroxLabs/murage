import XCTest
@testable import MurageShellCore

final class LaunchPolicyTests: XCTestCase {
    let mac = WorkspaceOrigin(string: "https://mac.tailnet123.ts.net")!

    private var book: WorkspaceBook {
        var book = WorkspaceBook()
        book.signedIn(mac, name: nil, at: 1)
        return book
    }

    func testOpensTheActiveComputerOnAColdStart() {
        XCTAssertEqual(LaunchPolicy.autoOpen(book: book, alreadyAutoOpened: false, launcherRequested: false, closePending: false), mac)
    }

    /// Phase 0 surprise 2: Back → launcher → workspace again, in a loop.
    func testOnlyOncePerProcess() {
        XCTAssertNil(LaunchPolicy.autoOpen(book: book, alreadyAutoOpened: true, launcherRequested: false, closePending: false))
    }

    func testNotWhenThePersonAskedForTheList() {
        XCTAssertNil(LaunchPolicy.autoOpen(book: book, alreadyAutoOpened: false, launcherRequested: true, closePending: false))
    }

    /// A can't-reach or re-pair screen is waiting to be shown.
    func testNotOverAPendingScreen() {
        XCTAssertNil(LaunchPolicy.autoOpen(book: book, alreadyAutoOpened: false, launcherRequested: false, closePending: true))
    }

    func testNothingToOpen() {
        XCTAssertNil(LaunchPolicy.autoOpen(book: WorkspaceBook(), alreadyAutoOpened: false, launcherRequested: false, closePending: false))
        var removed = book
        removed.remove(mac)
        XCTAssertNil(LaunchPolicy.autoOpen(book: removed, alreadyAutoOpened: false, launcherRequested: false, closePending: false))
    }

    func testCloseReasonsAreTheLaunchersNames() {
        XCTAssertEqual(CloseReason.allCases.map(\.rawValue), ["unreachable", "insecure", "signedOut", "signOut", "launcher", "updateRequired", "accessoff", "hosterror"])
    }

    /// The door answers 200 without a session only for /enter. "/" (where
    /// pairing lands) signs in: it may add the computer. Any other page that
    /// loaded only moves "Last connected" on: it never adds, activates or evicts.
    func testWhatALoadedMainDocumentMeans() {
        XCTAssertEqual(MainDocument.arrival(status: 200, path: "/"), .signedIn)
        XCTAssertEqual(MainDocument.arrival(status: 200, path: ""), .signedIn)
        XCTAssertEqual(MainDocument.arrival(status: 200, path: "/t/abc123"), .inUse)
        XCTAssertEqual(MainDocument.arrival(status: 200, path: "/settings"), .inUse)
        XCTAssertEqual(MainDocument.arrival(status: 200, path: "/enter"), .nothing)
        XCTAssertEqual(MainDocument.arrival(status: 401, path: "/"), .nothing)
        XCTAssertEqual(MainDocument.arrival(status: 404, path: "/t/abc123"), .nothing)
        XCTAssertEqual(MainDocument.arrival(status: 502, path: "/"), .nothing)
        XCTAssertEqual(MainDocument.arrival(status: 304, path: "/"), .nothing)
    }

    func testMainDocumentStatuses() {
        XCTAssertEqual(MainDocument.closeReason(status: 401), .signedOut)
        XCTAssertEqual(MainDocument.closeReason(status: 502), .hosterror)
        XCTAssertEqual(MainDocument.closeReason(status: 503), .hosterror)
        XCTAssertEqual(MainDocument.closeReason(status: 504), .hosterror)
        XCTAssertNil(MainDocument.closeReason(status: 200))
        XCTAssertNil(MainDocument.closeReason(status: 404))
        XCTAssertNil(MainDocument.closeReason(status: 500))
    }

    // B6 (Astra B6): a notification tap for a different computer must not
    // silently end a call in progress on the one already on screen.
    let pc = WorkspaceOrigin(string: "https://pc.tailnet123.ts.net")!

    func testHoldsADifferentComputersNotificationWhileACallIsOpen() {
        XCTAssertTrue(CrossComputerNotification.mustHold(current: mac, hasOpenCall: true, requested: pc))
    }

    func testNeverHoldsTheSameComputersNotification() {
        XCTAssertFalse(CrossComputerNotification.mustHold(current: mac, hasOpenCall: true, requested: mac))
    }

    func testDoesNotHoldADifferentComputerWithNoCallOpen() {
        XCTAssertFalse(CrossComputerNotification.mustHold(current: mac, hasOpenCall: false, requested: pc))
    }

    func testNothingToProtectWhenNoWorkspaceIsOnScreen() {
        XCTAssertFalse(CrossComputerNotification.mustHold(current: nil, hasOpenCall: true, requested: pc))
    }
}
