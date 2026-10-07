import XCTest
@testable import MurageShellCore

final class MemorySink: SaveSink {
    var files: [URL: Data] = [:]
    var discarded: [URL] = []
    var failWrites = false

    func create(id: String, filename: String) throws -> URL {
        let url = URL(fileURLWithPath: "/memory/\(id)/\(filename)")
        files[url] = Data()
        return url
    }

    func append(_ data: Data, to file: URL) throws {
        if failWrites { throw CocoaError(.fileWriteUnknown) }
        files[file, default: Data()].append(data)
    }

    func discard(_ file: URL) {
        discarded.append(file)
        files[file] = nil
    }
}

@MainActor
final class ChunkAssemblerTests: XCTestCase {
    var sink: MemorySink!
    var clock = Date(timeIntervalSince1970: 1_000)
    var assembler: ChunkAssembler!

    override func setUp() {
        sink = MemorySink()
        clock = Date(timeIntervalSince1970: 1_000)
        assembler = ChunkAssembler(sink: sink, now: { [unowned self] in self.clock })
    }

    private func b64(_ text: String) -> String { Data(text.utf8).base64EncodedString() }

    private func assertError(_ expected: ChannelError, _ body: () throws -> Void, line: UInt = #line) {
        XCTAssertThrowsError(try body(), line: line) { XCTAssertEqual($0 as? ChannelError, expected, line: line) }
    }

    func testAssemblesChunksInOrder() throws {
        try assembler.begin(id: "a", filename: "n.txt", mime: "text/plain", size: 10)
        try assembler.chunk(id: "a", index: 0, base64: b64("hello"))
        try assembler.chunk(id: "a", index: 1, base64: b64("world"))
        let file = try assembler.end(id: "a")
        XCTAssertEqual(sink.files[file.file], Data("helloworld".utf8))
        XCTAssertEqual(file.size, 10)
        XCTAssertEqual(file.mime, "text/plain")
        XCTAssertEqual(assembler.openCount, 0)
    }

    func testRefusesAChunkOutOfOrder() throws {
        try assembler.begin(id: "a", filename: "n.txt", mime: "text/plain", size: 10)
        assertError(.badArgs) { try assembler.chunk(id: "a", index: 1, base64: b64("hi")) }
    }

    func testRefusesMoreBytesThanDeclared() throws {
        try assembler.begin(id: "a", filename: "n.txt", mime: "text/plain", size: 3)
        assertError(.tooLarge) { try assembler.chunk(id: "a", index: 0, base64: b64("hello")) }
    }

    func testRefusesAChunkOverOneMebibyte() throws {
        try assembler.begin(id: "a", filename: "n.bin", mime: "application/octet-stream", size: SaveRequest.maxBytes)
        let big = Data(count: SaveRequest.chunkBytes + 1).base64EncodedString()
        assertError(.tooLarge) { try assembler.chunk(id: "a", index: 0, base64: big) }
    }

    func testRefusesADeclaredSizeOverTheCap() {
        assertError(.tooLarge) { try assembler.begin(id: "a", filename: "n.bin", mime: "x", size: SaveRequest.maxBytes + 1) }
    }

    func testEndBeforeEveryByteArrivedIsRefused() throws {
        try assembler.begin(id: "a", filename: "n.txt", mime: "text/plain", size: 10)
        try assembler.chunk(id: "a", index: 0, base64: b64("hello"))
        assertError(.badArgs) { _ = try assembler.end(id: "a") }
        assembler.abort(id: "a") // what save-file.ts does next
        XCTAssertEqual(sink.discarded.count, 1)
    }

    func testRefusesInvalidBase64() throws {
        try assembler.begin(id: "a", filename: "n.txt", mime: "text/plain", size: 10)
        assertError(.badArgs) { try assembler.chunk(id: "a", index: 0, base64: "not base64!") }
    }

    func testAbortDiscardsTheHalfWrittenFile() throws {
        try assembler.begin(id: "a", filename: "n.txt", mime: "text/plain", size: 10)
        try assembler.chunk(id: "a", index: 0, base64: b64("hello"))
        assembler.abort(id: "a")
        assembler.abort(id: "a")
        XCTAssertEqual(sink.discarded.count, 1)
        XCTAssertEqual(assembler.openCount, 0)
    }

    func testAtMostTwoTransfersAtOnce() throws {
        try assembler.begin(id: "a", filename: "a.txt", mime: "text/plain", size: 1)
        try assembler.begin(id: "b", filename: "b.txt", mime: "text/plain", size: 1)
        assertError(.busy) { try assembler.begin(id: "c", filename: "c.txt", mime: "text/plain", size: 1) }
    }

    func testIdleTransfersExpire() throws {
        try assembler.begin(id: "a", filename: "a.txt", mime: "text/plain", size: 1)
        try assembler.begin(id: "b", filename: "b.txt", mime: "text/plain", size: 1)
        clock = clock.addingTimeInterval(ChunkAssembler.idleLimit + 1)
        try assembler.begin(id: "c", filename: "c.txt", mime: "text/plain", size: 1)
        XCTAssertEqual(sink.discarded.count, 2)
        XCTAssertEqual(assembler.openCount, 1)
    }

    func testAWriteFailureIsReported() throws {
        try assembler.begin(id: "a", filename: "a.txt", mime: "text/plain", size: 5)
        sink.failWrites = true
        assertError(.writeFailed) { try assembler.chunk(id: "a", index: 0, base64: b64("hello")) }
    }

    func testAWriteFailureDiscardsTheTransfer() throws {
        try assembler.begin(id: "a", filename: "a.txt", mime: "text/plain", size: 5)
        sink.failWrites = true
        assertError(.writeFailed) { try assembler.chunk(id: "a", index: 0, base64: b64("hello")) }
        XCTAssertEqual(sink.discarded.count, 1)
        XCTAssertEqual(assembler.openCount, 0)
        sink.failWrites = false
        // A retry can't append after partial bytes: the transfer is gone.
        assertError(.badArgs) { try assembler.chunk(id: "a", index: 0, base64: b64("hello")) }
    }

    func testDuplicateAndUnknownTransfersAreRefused() throws {
        try assembler.begin(id: "a", filename: "a.txt", mime: "text/plain", size: 5)
        assertError(.badArgs) { try assembler.begin(id: "a", filename: "a.txt", mime: "text/plain", size: 5) }
        assertError(.badArgs) { try assembler.chunk(id: "zz", index: 0, base64: b64("x")) }
        assertError(.badArgs) { _ = try assembler.end(id: "zz") }
    }

    func testRefusesMalformedBase64Strictly() throws {
        try assembler.begin(id: "a", filename: "n.txt", mime: "text/plain", size: 10)
        for bad in ["====", "aG=k", "aGk==", "aGk", "aG k"] {
            assertError(.badArgs) { try assembler.chunk(id: "a", index: 0, base64: bad) }
        }
    }

    func testAcceptsBase64WithNonCanonicalPadBits() throws {
        // "aGl=" has non-zero pad bits but still decodes; a re-encode-and-
        // compare check (which Java's twin must avoid) would wrongly reject it.
        try assembler.begin(id: "a", filename: "n.txt", mime: "text/plain", size: SaveRequest.maxBytes)
        XCTAssertNoThrow(try assembler.chunk(id: "a", index: 0, base64: "aGl="))
    }

    func testRefusesBase64LongerThanTheCapBeforeDecoding() throws {
        try assembler.begin(id: "a", filename: "n.bin", mime: "application/octet-stream", size: SaveRequest.maxBytes)
        let over = String(repeating: "A", count: SaveRequest.maxBase64 + 4)
        assertError(.tooLarge) { try assembler.chunk(id: "a", index: 0, base64: over) }
    }

    func testEmptyChunkIsRefusedUnlessDeclaredSizeIsZero() throws {
        try assembler.begin(id: "a", filename: "n.txt", mime: "text/plain", size: 5)
        assertError(.badArgs) { try assembler.chunk(id: "a", index: 0, base64: "") }
    }

    func testEmptyChunkIsAcceptedWhenDeclaredSizeIsZero() throws {
        try assembler.begin(id: "a", filename: "empty.txt", mime: "text/plain", size: 0)
        try assembler.chunk(id: "a", index: 0, base64: "")
        let file = try assembler.end(id: "a")
        XCTAssertEqual(file.size, 0)
        XCTAssertEqual(sink.files[file.file], Data())
    }

    func testRefusesARepeatedChunkAndDoesNotWriteItTwice() throws {
        try assembler.begin(id: "a", filename: "n.txt", mime: "text/plain", size: 10)
        try assembler.chunk(id: "a", index: 0, base64: b64("hello"))
        assertError(.badArgs) { try assembler.chunk(id: "a", index: 0, base64: b64("hello")) }
        try assembler.chunk(id: "a", index: 1, base64: b64("world"))
        let file = try assembler.end(id: "a")
        XCTAssertEqual(sink.files[file.file], Data("helloworld".utf8))
    }

    func testAbortAfterEndDoesNotDiscardTheFile() throws {
        try assembler.begin(id: "a", filename: "n.txt", mime: "text/plain", size: 5)
        try assembler.chunk(id: "a", index: 0, base64: b64("hello"))
        let file = try assembler.end(id: "a")
        assembler.abort(id: "a")
        XCTAssertEqual(sink.discarded.count, 0)
        XCTAssertEqual(sink.files[file.file], Data("hello".utf8))
    }
}
