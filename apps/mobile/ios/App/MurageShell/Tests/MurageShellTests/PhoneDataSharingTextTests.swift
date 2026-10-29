import XCTest
@testable import MurageShell

final class PhoneDataSharingTextTests: XCTestCase {
    func testComputerNameStaysOnItsOwnFilteredLine() {
        XCTAssertEqual(PhoneDataSharingText.message(providerName: "Acme\nAI", workspaceName: "Stu\u{202e}dio\n"),
                       PhoneDataSharingText.warning + "\n\nAI service: AcmeAI\n\nStudio")
    }

    private let warning = "Share what a bot reads from your phone, when you allow it, to the AI service that bot uses, through your own Murage."

    func testNewlinesAndControlsCannotExtendTheProviderLine() {
        let name = " \u{00a0}Acme\nAI\r\t\u{0000}\u{0085}\u{2028}\u{2029} \u{00a0}"
        XCTAssertEqual(PhoneDataSharingText.providerLine(name), "AcmeAI")
        XCTAssertEqual(PhoneDataSharingText.message(providerName: name), warning + "\n\nAI service: AcmeAI")
    }

    func testBidiOverridesAndOtherFormatCharactersAreRemoved() {
        let name = "\u{200e}\u{200f}\u{202a}\u{202b}\u{202c}\u{202d}\u{202e}Acme\u{2066}\u{2067}\u{2068}\u{2069}"
            + "\u{00ad}\u{200b}\u{200d}\u{feff}\u{e0001}"
        XCTAssertEqual(PhoneDataSharingText.providerLine(name), "Acme")
        XCTAssertEqual(PhoneDataSharingText.message(providerName: name), warning + "\n\nAI service: Acme")
    }

    func testEmptyNamesFallBackAndOrdinaryNamesStayPlain() {
        XCTAssertEqual(PhoneDataSharingText.providerLine(" \n\u{202e}\u{2069}\u{200b} "), "another AI service")
        XCTAssertEqual(PhoneDataSharingText.message(providerName: ""), warning + "\n\nAI service: another AI service")
        XCTAssertEqual(PhoneDataSharingText.message(providerName: nil), warning)
        XCTAssertEqual(PhoneDataSharingText.providerLine(" <b>Acme & AI</b> "), "<b>Acme & AI</b>")
    }

    #if os(iOS)
    @MainActor func testNamedSheetUsesTheFixedWarningAndFilteredLine() {
        let sheet = PhoneDataSharingSheet.make(providerName: "Acme\n\u{202e}AI") { _ in }
        XCTAssertEqual(sheet.message, warning + "\n\nAI service: AcmeAI")
    }
    #endif
}
