import XCTest
@testable import MurageShellCore

final class SaveRequestTests: XCTestCase {
    let saved = WorkspaceOrigin(string: "https://mac.tailnet123.ts.net")!

    func testSharedSaveCases() throws {
        let channel = try XCTUnwrap(Fixtures.json("channel.json") as? [String: Any])
        let origin = try XCTUnwrap(WorkspaceOrigin(string: try XCTUnwrap(channel["origin"] as? String)))
        XCTAssertEqual(channel["chunkBytes"] as? Int, SaveRequest.chunkBytes)
        XCTAssertEqual(channel["maxBytes"] as? Int, SaveRequest.maxBytes)
        let saves = try XCTUnwrap(channel["saves"] as? [[String: Any]])
        XCTAssertGreaterThan(saves.count, 15)
        for entry in saves {
            let request = try XCTUnwrap(entry["request"] as? [String: Any])
            let result = SaveRequest.parse(request, origin: origin)
            if let expected = entry["error"] as? String {
                guard case .failure(let error) = result else { XCTFail("accepted \(request)"); continue }
                XCTAssertEqual(error.rawValue, expected, "\(request)")
            } else {
                guard case .success(let parsed) = result else { XCTFail("refused \(request)"); continue }
                XCTAssertEqual(parsed, try expected(request), "\(request)")
            }
        }
    }

    /// The case an accepted fixture row must parse to, field for field. The
    /// fixture filenames are already safe, so they come back unchanged.
    private func expected(_ request: [String: Any]) throws -> SaveRequest {
        let kind = try XCTUnwrap(request["kind"] as? String)
        let id = request["id"] as? String ?? ""
        switch kind {
        case "url":
            return .url(try XCTUnwrap(URL(string: try XCTUnwrap(request["url"] as? String))),
                        filename: try XCTUnwrap(request["filename"] as? String))
        case "begin":
            return .begin(id: id, filename: try XCTUnwrap(request["filename"] as? String),
                          mime: try XCTUnwrap(request["mime"] as? String), size: try XCTUnwrap(request["size"] as? Int))
        case "chunk":
            return .chunk(id: id, index: try XCTUnwrap(request["index"] as? Int), base64: try XCTUnwrap(request["base64"] as? String))
        case "end": return .end(id: id)
        case "abort": return .abort(id: id)
        default: throw ChannelError.badArgs // an accepted row of an unknown kind
        }
    }

    /// M1: the iOS temp sink writes only a plain name directly inside its
    /// fresh directory, like Android's CacheSink; anything else is refused.
    func testContainedKeepsOnlyAPlainNameInsideItsDirectory() throws {
        let directory = URL(fileURLWithPath: "/private/tmp/murage-saves/0B6F9C1E", isDirectory: true)
        XCTAssertEqual(FileNames.contained("report.pdf", in: directory)?.path, "/private/tmp/murage-saves/0B6F9C1E/report.pdf")
        XCTAssertEqual(FileNames.contained("a b.txt", in: directory)?.lastPathComponent, "a b.txt")
        for name in ["", ".", "..", "../x", "../../etc/passwd", "a/b", "a/", "/etc/passwd", "x/..", "./a"] {
            XCTAssertNil(FileNames.contained(name, in: directory), name.debugDescription)
        }
        let cases = try XCTUnwrap(Fixtures.json("filenames.json") as? [[String: String]])
        for entry in cases {
            let safe = FileNames.safe(try XCTUnwrap(entry["input"]))
            XCTAssertEqual(FileNames.contained(safe, in: directory)?.lastPathComponent, safe, safe.debugDescription)
        }
    }

    /// Compared scalar by scalar: Swift's `==` is canonical equivalence, which
    /// would hide a dropped or kept combining mark.
    func testSharedFileNames() throws {
        let cases = try XCTUnwrap(Fixtures.json("filenames.json") as? [[String: String]])
        XCTAssertGreaterThan(cases.count, 40)
        for entry in cases {
            let input = try XCTUnwrap(entry["input"])
            let expected = try XCTUnwrap(entry["safe"])
            let safe = FileNames.safe(input)
            XCTAssertEqual(Array(safe.unicodeScalars), Array(expected.unicodeScalars), input.debugDescription)
            XCTAssertLessThanOrEqual(safe.utf8.count, 200, input.debugDescription)
        }
    }

    /// The limit is 200 UTF-8 bytes, not a character count.
    func testLongNamesAreCutByBytes() {
        XCTAssertEqual(FileNames.safe(String(repeating: "a", count: 130) + ".md"), String(repeating: "a", count: 130) + ".md")
        XCTAssertEqual(FileNames.safe(String(repeating: "a", count: 250) + ".md"), String(repeating: "a", count: 197) + ".md")
        XCTAssertEqual(FileNames.safe(String(repeating: "é", count: 150)).utf8.count, 200)
    }

    func testURLFilenamesAreMadeSafe() throws {
        let parsed = try SaveRequest.parse(["kind": "url", "url": "https://mac.tailnet123.ts.net/x", "filename": "../../etc/passwd"], origin: saved).get()
        XCTAssertEqual(parsed, .url(URL(string: "https://mac.tailnet123.ts.net/x")!, filename: "passwd"))
    }

    /// The page leaves `|{}^` raw in a query (WHATWG); the saved origin still
    /// downloads it.
    func testSameOriginURLWithRawQueryCharactersIsAccepted() throws {
        let parsed = try SaveRequest.parse(["kind": "url", "url": "https://mac.tailnet123.ts.net/x?a|b&c={d}^e", "filename": "x.md"], origin: saved).get()
        guard case .url(let url, _) = parsed else { return XCTFail("\(parsed)") }
        XCTAssertTrue(saved.contains(url))
    }

    func testIntegersRejectBooleansAndFractions() {
        XCTAssertEqual(ChannelArgs.int(5), 5)
        XCTAssertEqual(ChannelArgs.int(NSNumber(value: 26_214_400)), 26_214_400)
        XCTAssertNil(ChannelArgs.int(true))
        XCTAssertNil(ChannelArgs.int(NSNumber(value: true)))
        XCTAssertNil(ChannelArgs.int(1.5))
        XCTAssertNil(ChannelArgs.int(Double.nan))
        XCTAssertNil(ChannelArgs.int("5"))
        XCTAssertNil(ChannelArgs.int(nil))
    }

    /// int32 on both twins, and never negative: 2^31 and 2^32 are bad_args.
    func testIntegersAreNonNegativeInt32() {
        XCTAssertEqual(ChannelArgs.int(0), 0)
        XCTAssertEqual(ChannelArgs.int(NSNumber(value: 2_147_483_647)), 2_147_483_647)
        XCTAssertNil(ChannelArgs.int(NSNumber(value: 2_147_483_648)))
        XCTAssertNil(ChannelArgs.int(NSNumber(value: 4_294_967_296)))
        XCTAssertNil(ChannelArgs.int(-1))
    }

    /// The base64 cap counts UTF-16 units, as the page and Java do.
    func testChunkCapCountsUTF16Units() {
        let fits = String(repeating: "\u{E9}", count: SaveRequest.maxBase64) // 2 UTF-8 bytes, 1 UTF-16 unit each
        guard case .success = SaveRequest.parse(["kind": "chunk", "id": "a1", "index": 0, "base64": fits], origin: saved)
        else { return XCTFail("refused a base64 string at the UTF-16 cap") }
        let over = fits + "A"
        guard case .failure(.tooLarge) = SaveRequest.parse(["kind": "chunk", "id": "a1", "index": 0, "base64": over], origin: saved)
        else { return XCTFail("accepted a base64 string over the UTF-16 cap") }
    }

    /// Plan 1 note 5: never write the door's 401 page to disk as the user's file.
    func testDownloadGateRefusesErrorPages() {
        XCTAssertTrue(DownloadGate.accept(status: nil))
        XCTAssertTrue(DownloadGate.accept(status: 200))
        XCTAssertTrue(DownloadGate.accept(status: 206))
        XCTAssertFalse(DownloadGate.accept(status: 401))
        XCTAssertFalse(DownloadGate.accept(status: 404))
        XCTAssertFalse(DownloadGate.accept(status: 500))
    }
}
