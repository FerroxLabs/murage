import Foundation
import XCTest
@testable import MurageCallAudioCore

final class CallAudioArgsTests: XCTestCase {
    private static let contract: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() } // …/apps/mobile
        return url.appendingPathComponent("contract/channel.json")
    }()

    private let sessions = CallAudioSessions(open: "s1")

    /// Every `callAudioRequests` case in the shared contract (spec §4.1
    /// Limits), parsed with session "s1" open. Each case is one piece on its
    /// own: the sequence rules (seq order, after `last`, one clip at a time,
    /// 8 MB) need several pieces and are covered by the ClipIntake tests.
    func testSharedFixtureLimits() throws {
        let data = try Data(contentsOf: Self.contract)
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let cases = try XCTUnwrap(root["callAudioRequests"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 15)
        for (index, item) in cases.enumerated() {
            let request = try XCTUnwrap(item["request"] as? [String: Any])
            let result = CallAudioPlayArgs.parse(request, sessions: sessions)
            switch (result, item["error"] as? String) {
            case (.success, nil): break
            case let (.failure(refusal), expected?): XCTAssertEqual(refusal.error.rawValue, expected, "case \(index)")
            case let (.success(args), expected?): XCTFail("case \(index) passed as \(args.clip), expected \(expected)")
            case let (.failure(refusal), nil): XCTFail("case \(index) refused with \(refusal.error), expected success")
            }
        }
    }

    func testPlayFields() throws {
        let args = try parse(["session": "s1", "clip": "c1", "seq": 0, "mime": "audio/wav", "bytes": "AAEC", "last": false, "paused": true]).get()
        XCTAssertEqual(args.clip, "c1")
        XCTAssertEqual(args.seq, 0)
        XCTAssertEqual(args.mime, .wav)
        XCTAssertEqual(args.bytes, Data([0, 1, 2]))
        XCTAssertFalse(args.last)
        XCTAssertTrue(args.paused)
        XCTAssertFalse(try parse(base(["paused": nil])).get().paused)
    }

    func testPlayRefusals() {
        let bad: [[String: Any?]] = [
            ["session": nil], ["session": 1], ["clip": nil], ["clip": ""], ["clip": 7],
            ["seq": nil], ["seq": "0"], ["seq": true], ["seq": 2_147_483_648.0],
            ["mime": nil], ["mime": "audio/mp3"], ["mime": "AUDIO/MPEG"], ["mime": "audio/x-wav"],
            ["bytes": nil], ["bytes": "not base64!"], ["bytes": "AA="], ["bytes": 5],
            ["last": nil], ["last": 1], ["last": "true"], ["paused": 1], ["paused": "yes"],
        ]
        for patch in bad {
            guard case let .failure(refusal) = parse(base(patch)) else { return XCTFail("\(patch) passed") }
            XCTAssertEqual(refusal.error, .badArgs, "\(patch)")
        }
    }

    func testEmptyLastPieceIsAccepted() throws {
        let args = try parse(base(["seq": 3, "bytes": "", "last": true])).get()
        XCTAssertEqual(args.bytes, Data())
        XCTAssertTrue(args.last)
    }

    /// A refusal names the clip only when the session is the open one, so a
    /// live clip can be failed once (spec §4.1).
    func testRefusalNamesTheClipOfTheOpenSession() {
        guard case let .failure(own) = parse(base(["mime": "audio/ogg"])) else { return XCTFail() }
        XCTAssertEqual(own.clip, "c1")
        guard case let .failure(other) = parse(base(["session": "s2", "mime": "audio/ogg"])) else { return XCTFail() }
        XCTAssertEqual(other.error, .badArgs)
        XCTAssertNil(other.clip)
    }

    /// After `lost` the old session answers `unavailable` (spec §4.1 event `lost`).
    func testLostSessionAnswersUnavailable() {
        var sessions = CallAudioSessions(open: "s1")
        sessions.lose()
        XCTAssertNil(sessions.open)
        guard case let .failure(refusal) = CallAudioPlayArgs.parse(base([:]), sessions: sessions) else { return XCTFail() }
        XCTAssertEqual(refusal.error, .unavailable)
        XCTAssertEqual(CallAudioControlArgs.parse(["session": "s1", "action": "stop"], sessions: sessions).failure, .unavailable)
        XCTAssertEqual(CallAudioControlArgs.parse(["session": "s9", "action": "stop"], sessions: sessions).failure, .badArgs)
        sessions.open = "s2"
        XCTAssertEqual(CallAudioControlArgs.parse(["session": "s2", "action": "stop"], sessions: sessions).success?.action, .stop)
    }

    func testControl() {
        for action in ["pause", "resume", "stop", "pulseOn", "pulseOff"] {
            XCTAssertEqual(CallAudioControlArgs.parse(["session": "s1", "action": action], sessions: sessions).success?.action.rawValue, action)
        }
        for bad: [String: Any] in [["session": "s1"], ["session": "s1", "action": "play"], ["session": "s1", "action": 1],
                                   ["action": "stop"], ["session": "s2", "action": "stop"]] {
            XCTAssertEqual(CallAudioControlArgs.parse(bad, sessions: sessions).failure, .badArgs, "\(bad)")
        }
    }

    /// A stale or unknown session is a no-op `true`; only a missing one is refused.
    func testClose() {
        XCTAssertEqual(CallAudioCloseArgs.parse(["session": "s1"]).success?.session, "s1")
        XCTAssertEqual(CallAudioCloseArgs.parse(["session": "old"]).success?.session, "old")
        XCTAssertEqual(CallAudioCloseArgs.parse([:]).failure, .badArgs)
        XCTAssertEqual(CallAudioCloseArgs.parse(["session": 1]).failure, .badArgs)
        XCTAssertTrue(sessions.closes("s1"))
        XCTAssertFalse(sessions.closes("old"))
    }

    // MARK: ClipIntake: seq order, `last`, one clip at a time, 8 MB

    func testIntakeInOrder() {
        var intake = ClipIntake()
        XCTAssertEqual(intake.admit(piece("c1", 0)), .first(replacing: nil))
        XCTAssertEqual(intake.admit(piece("c1", 1)), .next)
        XCTAssertEqual(intake.admit(piece("c1", 2, last: true)), .next)
        XCTAssertEqual(intake.admit(piece("c2", 0)), .first(replacing: "c1"))
    }

    func testIntakeRefusesGapsRepeatsAndPiecesAfterLast() {
        var intake = ClipIntake()
        XCTAssertEqual(intake.admit(piece("c1", 1)), .refuse(clip: nil)) // a new clip must start at 0
        XCTAssertEqual(intake.admit(piece("c1", 0)), .first(replacing: nil))
        XCTAssertEqual(intake.admit(piece("c1", 2)), .refuse(clip: "c1")) // gap
        XCTAssertEqual(intake.admit(piece("c1", 1)), .refuse(clip: "c1")) // the clip stays refused
        XCTAssertEqual(intake.admit(piece("c2", 0, last: true)), .first(replacing: "c1"))
        XCTAssertEqual(intake.admit(piece("c2", 1)), .refuse(clip: "c2")) // after last
        XCTAssertEqual(intake.admit(piece("c3", 0)), .first(replacing: "c2"))
        XCTAssertEqual(intake.admit(piece("c3", 0)), .refuse(clip: "c3")) // repeat
    }

    func testIntakeRefusalFromParseClosesTheClip() {
        var intake = ClipIntake()
        XCTAssertEqual(intake.admit(piece("c1", 0)), .first(replacing: nil))
        intake.refuse(clip: "c1")
        XCTAssertEqual(intake.admit(piece("c1", 1)), .refuse(clip: "c1"))
        intake.refuse(clip: "other") // not the current clip: no change
        XCTAssertEqual(intake.admit(piece("c2", 0)), .first(replacing: "c1"))
        XCTAssertEqual(intake.admit(piece("c2", 1)), .next)
    }

    func testIntakeCapsAClipAtEightMegabytes() {
        var intake = ClipIntake()
        let piece = 196_608 // the most one 256 KB base64 piece can carry
        var seq = 0
        var total = 0
        while total + piece <= CallAudioLimits.maxClipBytes {
            XCTAssertEqual(intake.admit(self.piece("c1", seq, size: piece)), seq == 0 ? .first(replacing: nil) : .next)
            seq += 1
            total += piece
        }
        XCTAssertEqual(intake.admit(self.piece("c1", seq, size: CallAudioLimits.maxClipBytes - total)), .next)
        XCTAssertEqual(intake.admit(self.piece("c1", seq + 1, size: 1)), .refuse(clip: "c1"))
    }

    // MARK: helpers

    private func base(_ patch: [String: Any?]) -> [String: Any] {
        var args: [String: Any] = ["session": "s1", "clip": "c1", "seq": 0, "mime": "audio/mpeg", "bytes": "AA==", "last": false]
        for (key, value) in patch { args[key] = value }
        return args
    }

    private func parse(_ args: [String: Any]) -> Result<CallAudioPlayArgs, CallAudioArgRefusal> {
        // Round-trip through JSON so numbers and booleans arrive as they do from WebKit.
        let data = try! JSONSerialization.data(withJSONObject: args)
        let object = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        return CallAudioPlayArgs.parse(object, sessions: sessions)
    }

    private func piece(_ clip: String, _ seq: Int, last: Bool = false, size: Int = 1) -> CallAudioPlayArgs {
        CallAudioPlayArgs(clip: clip, seq: seq, mime: .mpeg, bytes: Data(count: size), last: last, paused: false)
    }
}

extension Result {
    var success: Success? { if case let .success(value) = self { return value }; return nil }
    var failure: Failure? { if case let .failure(error) = self { return error }; return nil }
}
