import XCTest
@testable import MurageShellCore

final class DiagFileTests: XCTestCase {
    private func temp() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("diagfile-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir.appendingPathComponent(DiagFile.fileName)
    }

    func testAppendsIsoStampedLines() throws {
        let file = DiagFile(url: try temp())
        XCTAssertTrue(file.append("[call-diag] one", at: Date(timeIntervalSince1970: 0)))
        XCTAssertTrue(file.append("[call-diag] two", at: Date(timeIntervalSince1970: 1.5)))
        let text = try String(contentsOf: file.url, encoding: .utf8)
        XCTAssertEqual(text, "1970-01-01T00:00:00.000Z [call-diag] one\n1970-01-01T00:00:01.500Z [call-diag] two\n")
    }

    func testRotatesAtTheCapKeepingOneOldFile() throws {
        let file = DiagFile(url: try temp(), maxBytes: 200)
        for i in 0..<20 { file.append("[call-diag] line \(i) " + String(repeating: "x", count: 30)) }
        let manager = FileManager.default
        XCTAssertTrue(manager.fileExists(atPath: file.oldURL.path))
        XCTAssertFalse(manager.fileExists(atPath: file.oldURL.appendingPathExtension("1").path))
        let current = try Data(contentsOf: file.url).count
        let old = try Data(contentsOf: file.oldURL).count
        XCTAssertLessThanOrEqual(current, 200)
        XCTAssertLessThanOrEqual(old, 200)
        let text = try String(contentsOf: file.url, encoding: .utf8)
        XCTAssertTrue(text.contains("line 19 "))
    }

    func testDefaultCapIsTwoMegabytes() {
        XCTAssertEqual(DiagFile.maxBytes, 2 * 1024 * 1024)
    }

    func testAnUnwritableLocationReturnsFalseInsteadOfCrashing() {
        let missing = FileManager.default.temporaryDirectory
            .appendingPathComponent("diagfile-missing-\(UUID().uuidString)/nested/\(DiagFile.fileName)")
        XCTAssertFalse(DiagFile(url: missing).append("[call-diag] x"))
    }
}
