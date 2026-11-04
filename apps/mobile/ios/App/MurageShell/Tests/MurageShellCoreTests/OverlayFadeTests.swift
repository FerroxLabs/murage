import XCTest
@testable import MurageShellCore

final class OverlayFadeTests: XCTestCase {
    func testAFadeThatFinishesWithNothingShownHidesTheOverlay() {
        var fade = OverlayFade()
        let token = fade.beginHide()
        XCTAssertNotNil(token)
        XCTAssertTrue(fade.finishHide(token: token!, finished: true))
        XCTAssertEqual(fade.mode, .hidden)
        XCTAssertNil(fade.beginHide(), "already hidden")
    }

    func testAHideCompletionAfterShowClosingDoesNotHide() {
        var fade = OverlayFade()
        let token = fade.beginHide()!      // ready() starts the 200 ms fade
        fade.showClosing()                 // a sign-out arrives during it
        XCTAssertFalse(fade.finishHide(token: token, finished: true), "even a completion that reports finished")
        XCTAssertEqual(fade.mode, .closing)
    }

    func testRevealAfterClosingIsIgnored() {
        var fade = OverlayFade()
        fade.showClosing()
        XCTAssertNil(fade.beginHide(), "a late /enter finish cannot take the closing screen down")
        XCTAssertEqual(fade.mode, .closing)
    }

    func testAnInterruptedFadeDoesNothing() {
        var fade = OverlayFade()
        let token = fade.beginHide()!
        XCTAssertFalse(fade.finishHide(token: token, finished: false))
        XCTAssertEqual(fade.mode, .splash)
    }

    func testANewerSplashOrSlowShowBeatsAnOlderFade() {
        var fade = OverlayFade()
        let first = fade.beginHide()!
        fade.showSplash()
        XCTAssertFalse(fade.finishHide(token: first, finished: true))
        let second = fade.beginHide()!
        fade.showSlow()
        XCTAssertFalse(fade.finishHide(token: second, finished: true))
        XCTAssertEqual(fade.mode, .slow)
    }

    func testTheNewestOfTwoFadesWins() {
        var fade = OverlayFade()
        let older = fade.beginHide()!
        let newer = fade.beginHide()!
        XCTAssertFalse(fade.finishHide(token: older, finished: true))
        XCTAssertTrue(fade.finishHide(token: newer, finished: true))
    }
}
