import XCTest
@testable import MurageShellCore

final class InPlaceReloadTests: XCTestCase {
    func testAPageThatReloadedItselfNeedsNoLoad() {
        var reload = InPlaceReload()
        let ticket = reload.begin()
        XCTAssertFalse(reload.fallBack(ticket: ticket, reloaded: true))
        XCTAssertFalse(reload.fallBack(ticket: ticket, reloaded: false), "the timeout after the answer does nothing")
    }

    func testAPageThatCouldNotLoadsOnce() {
        var reload = InPlaceReload()
        let ticket = reload.begin()
        XCTAssertTrue(reload.fallBack(ticket: ticket, reloaded: false))
        XCTAssertFalse(reload.fallBack(ticket: ticket, reloaded: false))
    }

    /// Review Important 1: a hung renderer never answers; the timeout loads, and a late answer does nothing.
    func testTheTimeoutLoadsAndALateAnswerIsIgnored() {
        var reload = InPlaceReload()
        let ticket = reload.begin()
        XCTAssertTrue(reload.fallBack(ticket: ticket, reloaded: false))
        XCTAssertFalse(reload.fallBack(ticket: ticket, reloaded: false))
        XCTAssertFalse(reload.fallBack(ticket: ticket, reloaded: true))
    }

    /// Review Important 2: an older load's late answer never navigates after a newer load().
    func testANewerLoadVoidsTheOlderOne() {
        var reload = InPlaceReload()
        let older = reload.begin()
        let newer = reload.begin()
        XCTAssertNotEqual(older, newer)
        XCTAssertFalse(reload.fallBack(ticket: older, reloaded: false))
        XCTAssertTrue(reload.fallBack(ticket: newer, reloaded: false))
    }

    func testNothingBeforeTheFirstLoad() {
        var reload = InPlaceReload()
        XCTAssertFalse(reload.fallBack(ticket: 0, reloaded: false))
    }
}
