import XCTest
@testable import CompanionCore

final class AttachedMessageContentTests: XCTestCase {
    func testSplitsSharedImagesAndNamedFilesFromVisibleText() {
        let parsed = AttachedMessageContent.parse("""
        Please review these.

        <attached-image path="/tmp/photo.png" />

        <attached-file path="/tmp/4ad3.pdf" name="Project &amp; notes.pdf" />
        """)

        XCTAssertEqual(parsed.text, "Please review these.")
        XCTAssertEqual(parsed.attachments, [
            DisplayedMessageAttachment(kind: .image, name: "photo.png"),
            DisplayedMessageAttachment(kind: .file, name: "Project & notes.pdf"),
        ])
    }

    func testFallsBackToBasenameForOlderFileTags() {
        let parsed = AttachedMessageContent.parse(
            #"<attached-file path="C:\Users\Maus\brief.docx" />"#
        )

        XCTAssertEqual(parsed.text, "")
        XCTAssertEqual(parsed.attachments, [
            DisplayedMessageAttachment(kind: .file, name: "brief.docx"),
        ])
    }

    func testLeavesInlineExamplesAndUnrelatedTagsVisible() {
        let source = "Example: <attached-file path=\"/tmp/demo.pdf\" />\n<pasted-text>hello</pasted-text>"
        let parsed = AttachedMessageContent.parse(source)

        XCTAssertEqual(parsed.text, source)
        XCTAssertTrue(parsed.attachments.isEmpty)
    }

    func testBoundsAndFlattensUntrustedDisplayNames() {
        let longName = "\u{202E}" + String(repeating: "a", count: 200) + "\n.pdf"
        let parsed = AttachedMessageContent.parse(
            "<attached-file path=\"/tmp/file.pdf\" name=\"\(longName.replacingOccurrences(of: "\n", with: "&#10;"))\" />"
        )

        XCTAssertEqual(parsed.attachments.count, 1)
        XCTAssertEqual(parsed.attachments[0].name.count, 180)
        XCTAssertFalse(parsed.attachments[0].name.contains("\n"))
        XCTAssertFalse(parsed.attachments[0].name.contains("\u{202E}"))
    }
}
