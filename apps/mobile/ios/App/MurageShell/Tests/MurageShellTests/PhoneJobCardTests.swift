import XCTest
import MurageShellCore
@testable import MurageShell
#if os(iOS)
import UIKit
#endif

@MainActor final class PhoneJobCardTests: XCTestCase {
    private func model(count: Int = 1, answer: @escaping (Bool) -> Void = { _ in }) -> PhoneJobCardModel {
        PhoneJobCardModel(bot: "Ember", capability: "calendar", say: "Read tomorrow's events",
                          workspace: "Studio", enabledWorkspaces: count, answer: answer)
    }
    func testOffscreenWorkspaceHasItsOwnFilteredCardLineWithOnlyOneEnabled() {
        let card = PhoneJobCardModel(bot: "Ember", capability: "calendar", say: "Read events",
                                    workspace: "Stu\u{202e}dio\n", enabledWorkspaces: 1, offscreen: true) { _ in }
        XCTAssertEqual(card.workspace, "Studio")
        let one = WorkspaceOrigin(string: "https://one.example.ts.net")!
        let two = WorkspaceOrigin(string: "https://two.example.ts.net")!
        XCTAssertTrue(PhoneJobPresentation.matches(one, one))
        XCTAssertFalse(PhoneJobPresentation.matches(one, two))
        XCTAssertFalse(PhoneJobPresentation.matches(one, nil))
    }
    func testWorkspaceNameOnlyWithTwoEnabledWorkspaces() {
        XCTAssertNil(model().workspace)
        XCTAssertEqual(model(count: 2).workspace, "Studio")
    }
    func testEachChoiceCallsBackOnceIncludingReentrantAndOppositeTaps() {
        for allow in [true, false] {
            var answers: [Bool] = []
            var card: PhoneJobCardModel!
            card = model { value in answers.append(value); card.choose(!value) }
            card.choose(allow); card.choose(allow); card.choose(!allow)
            XCTAssertEqual(answers, [allow]); XCTAssertEqual(card.state, .waiting)
        }
    }
    func testBackgroundDismissalDropsChoicesAndCompletionCallbacks() {
        let card = model { _ in XCTFail("dismissed card answered") }
        card.dismiss(); card.choose(true); card.choose(false)
        card.complete { XCTFail("dismissed card revived") }; card.close()
        XCTAssertEqual(card.state, .dismissed)
        let used = model(); used.complete { XCTFail("background close was a user action") }
        used.dismiss(); used.close()
    }
    func testAlreadyHandledReplacesChoiceAndClosesOnce() {
        let card = model { _ in XCTFail("handled card answered") }
        var closes = 0
        card.alreadyHandled { closes += 1 }
        XCTAssertEqual(card.state, .handled)
        card.choose(true); card.choose(false); card.close(); card.close()
        XCTAssertEqual(closes, 1)
    }
    func testCompletedRunUsesLocalizedSmallLineAndClosesOnce() {
        let card = model(); var closes = 0
        card.choose(true); card.complete { closes += 1 }
        XCTAssertEqual(card.state, .used)
        XCTAssertEqual(PhoneJobStrings.used(bot: card.bot, capability: card.capability), "Ember used your calendar")
        card.close(); card.close(); XCTAssertEqual(closes, 1)
    }
    func testUntrustedBotSayAndWorkspaceStayPlainAndBounded() {
        let card = PhoneJobCardModel(bot: "<b>Em\u{202e}ber</b>\n\n\u{2069}", capability: "calendar",
            say: "Read\u{202e}\n\n\n\nthis\u{2066}\r\t\u{0000}\u{2028} <i>text</i>",
            workspace: "Stu\u{200d}dio\n\u{2029}", enabledWorkspaces: 2) { _ in }
        XCTAssertEqual(card.bot, "<b>Ember</b>")
        XCTAssertEqual(card.say, "Read\n\nthis <i>text</i>")
        XCTAssertEqual(card.workspace, "Studio")
        let long = PhoneJobCardModel(bot: String(repeating: "😀", count: 100), capability: "calendar",
            say: String(repeating: "a", count: 300), workspace: String(repeating: "b", count: 200), enabledWorkspaces: 2) { _ in }
        XCTAssertEqual(long.bot.utf16.count, 120); XCTAssertEqual(long.say.utf16.count, 240)
        XCTAssertEqual(long.workspace?.utf16.count, 120)
        XCTAssertEqual(PhoneDataSharingText.providerLine(String(repeating: "p", count: 200)).utf16.count, 120)
        XCTAssertEqual(PhoneDataSharingText.plain(String(repeating: "a", count: 119) + "😀", limit: 120).utf16.count, 119)
    }

    private func offer(action: String? = nil, args: [String: Any]? = nil) throws -> PhoneJobsContract.Offer {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() }
        let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: url.appendingPathComponent("contract/phone-jobs.json"))) as! [String: Any]
        let offers = (fixture["job"] as! [String: Any])["offers"] as! [[String: Any]]
        var value = offers[0]
        if let action { value["action"] = action; value["capability"] = String(action.split(separator: ".")[0]) }
        if let args { value["args"] = args }
        return try XCTUnwrap(PhoneJobsContract.Offer.parse(value))
    }
    func testValidatedDialNumberAndEachRecipientStayUnchangedBeforeAllow() throws {
        let number = "+1 (555) 010-20.30"
        let dial = PhoneJobCardModel(offer: try offer(action: "calls.dial", args: ["number": number]), enabledWorkspaces: 1) { _ in }
        XCTAssertEqual(dial.state, .offer)
        XCTAssertEqual(dial.destinations, [number])
        let recipients = [number, "+44 (20) 1234"]
        let message = PhoneJobCardModel(offer: try offer(action: "messages.compose", args: ["to": recipients, "body": "Hi"]), enabledWorkspaces: 1) { _ in }
        XCTAssertEqual(message.state, .offer)
        XCTAssertEqual(message.destinations, recipients)
        XCTAssertTrue(model().destinations.isEmpty)
    }
    #if os(iOS)
    func testNativeDestinationLabelsAreVisibleBeforeAllow() throws {
        for (action, args, expected) in [
            ("calls.dial", ["number": "+1 (555) 010-20.30"] as [String: Any], ["+1 (555) 010-20.30"]),
            ("messages.compose", ["to": ["+1 (555) 010-20.30", "+44 20 1234"], "body": "Hi"] as [String: Any], ["+1 (555) 010-20.30", "+44 20 1234"])
        ] {
            let model = PhoneJobCardModel(offer: try offer(action: action, args: args), enabledWorkspaces: 1) { _ in XCTFail("No choice made") }
            let card = PhoneJobCardViewController(model: model)
            card.loadViewIfNeeded()
            XCTAssertEqual(Array(card.labels.compactMap(\.text).suffix(expected.count)), expected)
            XCTAssertEqual(model.state, .offer)
            XCTAssertTrue(card.allowButton?.isEnabled == true)
        }
    }
    func testProviderAndJobCardPresentOnlyOnTheirOwnWorkspace() throws {
        let one = WorkspaceOrigin(string: "https://one.example.ts.net")!
        let two = WorkspaceOrigin(string: "https://two.example.ts.net")!
        var onScreen = two
        var shown: [UIViewController] = [], origins: [WorkspaceOrigin] = []
        let cards = NativePhoneJobCards(enabledWorkspaces: { 1 }, onScreen: { onScreen }) { workspace, controller in
            origins.append(workspace); shown.append(controller); return true
        }
        let job = try offer()
        cards.showProvider(workspace: one, provider: job.provider, workspaceName: "Stu\u{202e}dio\n") { _ in }
        cards.show(workspace: one, offer: job) { _ in }
        XCTAssertTrue(shown.isEmpty)
        onScreen = one
        cards.showProvider(workspace: one, provider: job.provider, workspaceName: "Stu\u{202e}dio\n") { _ in }
        let sheet = try XCTUnwrap(shown.last as? UIAlertController)
        XCTAssertEqual(sheet.message, PhoneDataSharingText.warning + "\n\nAI service: Anthropic\n\nStudio")
        cards.dismissAll()
        cards.show(workspace: one, offer: job) { _ in }
        XCTAssertTrue(shown.last is PhoneJobCardViewController)
        XCTAssertEqual(origins, [one, one])
        // A card from another computer must never replace the existing visible card.
        let original = try XCTUnwrap(shown.last as? PhoneJobCardViewController)
        cards.show(workspace: two, offer: job) { _ in }
        XCTAssertEqual(shown.count, 2); XCTAssertEqual(original.model.state, .offer)
        cards.dismissAll()
    }
    func testNativeViewOneAndTwoWorkspacesAndButtons() {
        for count in [1, 2] {
            var answers: [Bool] = []
            let card = PhoneJobCardViewController(model: model(count: count) { answers.append($0) })
            card.loadViewIfNeeded()
            XCTAssertEqual(card.labels.compactMap(\.text), count == 1
                ? ["Ember", "Calendar", "Read tomorrow's events"]
                : ["Ember", "Calendar", "Studio", "Read tomorrow's events"])
            let allow = card.allowButton!, notNow = card.notNowButton!
            XCTAssertEqual(allow.title(for: .normal), "Allow")
            XCTAssertEqual(notNow.title(for: .normal), "Not now")
            let choice = count == 1
            (choice ? allow : notNow).sendActions(for: .touchUpInside)
            allow.sendActions(for: .touchUpInside); notNow.sendActions(for: .touchUpInside)
            XCTAssertEqual(answers, [choice])
            XCTAssertFalse(card.allowButton!.isEnabled); XCTAssertFalse(card.notNowButton!.isEnabled)
        }
    }
    func testHandledViewReplacesOfferAndStaleButtonCannotAnswerReplacement() {
        let card = PhoneJobCardViewController(model: model { _ in XCTFail("old offer answered") })
        card.loadViewIfNeeded(); let stale = card.allowButton!
        let handled = model(); handled.alreadyHandled {}
        card.replace(with: handled)
        XCTAssertEqual(card.labels.compactMap(\.text), ["Already handled"])
        XCTAssertNil(card.allowButton); XCTAssertNil(card.notNowButton)
        card.replace(with: model { _ in XCTFail("stale button answered new offer") })
        stale.sendActions(for: .touchUpInside)
        let used = model(); used.complete {}; card.replace(with: used)
        XCTAssertEqual(card.labels.first?.text, "Ember used your calendar")
        XCTAssertEqual(card.labels.first?.font, UIFont.preferredFont(forTextStyle: .footnote))
    }
    func testComposerKeepsReceiptFromCoveringSystemSheet() throws {
        var closeComposer: (() -> Void)?, closes = 0, presentations = 0
        let cards = NativePhoneJobCards(enabledWorkspaces: { 1 }, onScreen: { WorkspaceOrigin(string: "https://one.example.ts.net")! }, deferUsed: { closeComposer = $0; return true }) { _, _ in
            presentations += 1; return true
        }
        cards.used(workspace: WorkspaceOrigin(string: "https://one.example.ts.net")!, offer: try offer()) { closes += 1 }
        XCTAssertEqual(presentations, 0); XCTAssertEqual(closes, 0)
        closeComposer?(); XCTAssertEqual(closes, 1)
    }
    func testFailedProviderAndCardPresentationReleaseRunnerCallback() throws {
        let workspace = WorkspaceOrigin(string: "https://one.example.ts.net")!
        let cards = NativePhoneJobCards(enabledWorkspaces: { 1 }, onScreen: { workspace }) { _, _ in false }
        let job = try offer(); var failures = 0
        cards.show(workspace: workspace, offer: job, args: try XCTUnwrap(job.decodedArgs), answer: { _ in XCTFail("failed card answered") }, failed: { failures += 1 })
        cards.showProvider(workspace: workspace, provider: job.provider, workspaceName: job.workspace, answer: { _ in XCTFail("failed sheet answered") }, failed: { failures += 1 })
        XCTAssertEqual(failures, 2)
    }
    func testPresenterBackgroundDismissalInvalidatesTheVisibleCard() throws {
        var shown: PhoneJobCardViewController?
        let cards = NativePhoneJobCards(enabledWorkspaces: { 1 }, onScreen: { WorkspaceOrigin(string: "https://one.example.ts.net")! }) { _, controller in
            shown = controller as? PhoneJobCardViewController; return true
        }
        let workspace = WorkspaceOrigin(string: "https://one.example.ts.net")!
        cards.show(workspace: workspace, offer: try offer()) { _ in XCTFail("background card answered") }
        let visible = shown!
        cards.dismissAll() // The synchronous sceneDidEnterBackground service path.
        XCTAssertEqual(visible.model.state, .dismissed)
        visible.model.choose(true); visible.model.choose(false)
    }
    func testPresenterAlreadyHandledReplacesCardAndScopedDismissal() throws {
        var shown: PhoneJobCardViewController?, presentations = 0
        let cards = NativePhoneJobCards(enabledWorkspaces: { 2 }, onScreen: { WorkspaceOrigin(string: "https://one.example.ts.net")! }) { _, controller in
            shown = controller as? PhoneJobCardViewController; presentations += 1; return true
        }
        let workspace = WorkspaceOrigin(string: "https://one.example.ts.net")!
        let offer = try offer()
        cards.show(workspace: workspace, offer: offer) { _ in XCTFail("replaced offer answered") }
        let card = shown!; card.loadViewIfNeeded(); let old = card.model
        cards.dismiss(workspace: workspace, operationId: "another-operation")
        XCTAssertEqual(old.state, .offer)
        var closes = 0
        cards.alreadyHandled(workspace: workspace, operationId: offer.operationId) { closes += 1 }
        XCTAssertEqual(presentations, 1); XCTAssertTrue(shown === card)
        XCTAssertEqual(old.state, .dismissed); XCTAssertEqual(card.labels.compactMap(\.text), ["Already handled"])
        old.choose(true); card.model.close(); card.model.close(); XCTAssertEqual(closes, 1)
        cards.dismissAll()
    }
    #endif
    func testWriteDetailsUseValidatedSnapshotAndFilterPlainText() throws {
        let start = "2026-10-27T09:00:00Z", end = "2026-10-27T10:00:00Z"
        let cases: [(String, [String: Any], [String])] = [
            ("calendar.add", ["title": "Lunch\u{202e}", "start": start, "end": end, "allDay": true, "location": "Cafe", "notes": "Bring notes"],
             ["Title: Lunch", "Start: " + start, "End: " + end, "All day: Yes", "Location: Cafe", "Notes: Bring notes"]),
            ("calendar.change", ["id": "event", "title": "New title", "start": start, "end": end, "location": "", "notes": "New notes"],
             ["Current item: Original", "Item ID: event", "Title: New title", "Start: " + start, "End: " + end, "Location: ", "Notes: New notes"]),
            ("reminders.add", ["title": "Buy milk", "due": start, "notes": "Two bottles"], ["Title: Buy milk", "Due: " + start, "Notes: Two bottles"]),
            ("reminders.complete", ["id": "reminder"], ["Current item: Original", "Item ID: reminder", "Completed: Yes"]),
            ("alarms.set", ["hour": 7, "minute": 5, "label": "Wake"], ["Time: 07:05", "Label: Wake"]),
            ("alarms.timer", ["seconds": 90, "label": "Tea"], ["Duration in seconds: 90", "Label: Tea"]),
            ("messages.compose", ["to": ["+123"], "body": "Hello"], ["Message: Hello"])
        ]
        for (action, raw, expected) in cases {
            let value = try offer(action: action, args: raw)
            let args = try XCTUnwrap(value.decodedArgs)
            let card = PhoneJobCardModel(offer: value, args: args, currentTitle: "Ori\u{202e}ginal", enabledWorkspaces: 1) { _ in }
            XCTAssertEqual(card.details, expected, action)
        }
    }
    func testDialCodesAreRejectedByBothCallAndMessageDecoders() throws {
        for number in ["*123", "123#", "*#06#"] {
            XCTAssertFalse(PhoneJobsContract.isDialNumber(number))
            XCTAssertNil(try offer(action: "calls.dial", args: ["number": number]).decodedArgs)
            XCTAssertNil(try offer(action: "messages.compose", args: ["to": [number], "body": "Hi"]).decodedArgs)
        }
    }

}
