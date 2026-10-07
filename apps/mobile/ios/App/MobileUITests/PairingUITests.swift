import XCTest

/// Plan 2 E2E. Drives the installed com.murage.mobile against the isolated
/// host. Run only through apps/mobile/e2e/ios-e2e.sh, which prepares the host
/// between methods and passes MURAGE_E2E_ADDRESS and MURAGE_E2E_CODE.
final class PairingUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "com.murage.mobile")

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func button(_ label: String) -> XCUIElement { app.webViews.buttons[label] }

    private func text(containing fragment: String) -> XCUIElement {
        app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", fragment)).firstMatch
    }

    private func waitForChat(timeout: TimeInterval = 60) {
        XCTAssertTrue(button("Attach a file").waitForExistence(timeout: timeout), "the chat did not load")
    }

    private func relaunch(_ arguments: [String] = []) {
        app.terminate()
        app.launchArguments = arguments
        app.launch()
    }

    /// From the welcome screen: the typed address and code, then the door's
    /// pairing page (/enter), which is left unanswered.
    private func typePairingUpToTheDoor() throws {
        let env = ProcessInfo.processInfo.environment
        let address = try XCTUnwrap(env["MURAGE_E2E_ADDRESS"])
        let code = try XCTUnwrap(env["MURAGE_E2E_CODE"])
        XCTAssertTrue(button("Yes, let's connect").waitForExistence(timeout: 20))
        button("Yes, let's connect").tap()
        // Get your code ready comes before the camera, so no scanner is open
        // here: Type the code instead goes straight to the form.
        XCTAssertTrue(text(containing: "Get your code ready").waitForExistence(timeout: 20), "Yes, let's connect did not get the code ready")
        XCTAssertTrue(app.webViews.images.matching(NSPredicate(format: "label CONTAINS %@", "Phone and other devices")).firstMatch.exists, "the picture of the desktop page is missing")
        let type = button("Type the code instead")
        XCTAssertTrue(type.waitForExistence(timeout: 20))
        type.tap()
        let addressField = app.webViews.textFields["Address"]
        XCTAssertTrue(addressField.waitForExistence(timeout: 5))
        addressField.tap()
        addressField.typeText(address)
        let codeField = app.webViews.textFields["Six-digit code"]
        codeField.tap()
        codeField.typeText(code)
        button("Connect").tap()
        XCTAssertTrue(button("Sign in on this device").waitForExistence(timeout: 30), "the door's pairing page did not load")
    }

    /// The launcher's welcome, with no computer on the list.
    private func assertNoSavedComputer() {
        XCTAssertTrue(button("Yes, let's connect").waitForExistence(timeout: 20), "the launcher did not show its welcome")
        XCTAssertFalse(text(containing: "Your computers").exists, "a computer is still on the list")
        XCTAssertFalse(app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Open ")).firstMatch.exists)
    }

    /// The script's turn: the app ends with the test run, so while the script
    /// runs page checks through Web Inspector this test keeps it alive, until
    /// the script creates the MURAGE_E2E_HANDOFF file.
    private func waitForTheScript() throws {
        let path = try XCTUnwrap(ProcessInfo.processInfo.environment["MURAGE_E2E_HANDOFF"])
        let deadline = Date().addingTimeInterval(180)
        while !FileManager.default.fileExists(atPath: path) {
            guard Date() < deadline else { return XCTFail("the script never handed back") }
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }
    }

    func test1TypedPairingReachesChat() throws {
        app.launch()
        try typePairingUpToTheDoor()
        button("Sign in on this device").tap()
        waitForChat()
    }

    func test2RelaunchStaysSignedIn() {
        relaunch()
        waitForChat(timeout: 30)
        XCTAssertFalse(button("Yes, let's connect").exists)
    }

    func test3OpenMissingThreadSaysSo() {
        relaunch(["-murageOpenThread", "e2e-missing-thread"])
        waitForChat()
        XCTAssertTrue(text(containing: "isn't available on this device").waitForExistence(timeout: 20))
    }

    func test4ProbeFromInsideThePage() {
        relaunch(["-murageE2EProbe"])
        waitForChat()
        // The probe's chunked save ends in the share sheet, then it navigates to example.com.
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 30), "a foreign navigation did not open Safari")
        app.activate()
    }

    func test5StillInChatAfterWebContentDied() {
        app.activate()
        waitForChat(timeout: 60)
    }

    func test6UnreachableScreen() {
        relaunch()
        XCTAssertTrue(text(containing: "Can't reach").waitForExistence(timeout: 60))
        XCTAssertTrue(button("Open Tailscale").exists)
        XCTAssertTrue(text(containing: "Last connected").exists)
    }

    /// The app ends with each test run, so this one takes the can't-reach
    /// screen itself and waits while the script starts the door again.
    func test7TryAgainAfterTheComputerWakes() throws {
        relaunch()
        XCTAssertTrue(button("Try again").waitForExistence(timeout: 60))
        try waitForTheScript()
        button("Try again").tap()
        waitForChat()
    }

    func test8RepairScreen() {
        relaunch()
        XCTAssertTrue(text(containing: "Scan the code on your computer again").waitForExistence(timeout: 60))
        XCTAssertTrue(button("Type the code instead").exists)
    }

    /// After the page's signOut(): a cold start opens nothing and lists no
    /// computer, and a new pairing reaches the door's page. There the script
    /// asks the door whether the old cookie is still there, then calls
    /// signOut() and a late ready(): the launcher is back, with no computer.
    func test9SignedOutThenTheDoorsPage() throws {
        relaunch()
        assertNoSavedComputer()
        try typePairingUpToTheDoor()
        try waitForTheScript()
        assertNoSavedComputer()
    }

    /// signOut() then a late ready() on the door's page: still no computer on
    /// the list after a cold start (P19's guard).
    func test10LateReadyLeftNoComputer() {
        relaunch()
        assertNoSavedComputer()
    }
}
