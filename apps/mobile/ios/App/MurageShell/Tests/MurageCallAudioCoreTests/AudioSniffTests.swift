import Foundation
import XCTest
@testable import MurageCallAudioCore

final class AudioSniffTests: XCTestCase {
    func testFixtures() throws {
        let expected: [(String, CallAudioMime)] = [
            ("voice-id3.mp3", .mpeg), ("voice-vbr.mp3", .mpeg), ("voice-stereo.mp3", .mpeg),
            ("voice.wav", .wav), ("voice.aac", .aac), ("voice.m4a", .mp4),
        ]
        for (name, mime) in expected {
            let data = try fixture(name)
            XCTAssertEqual(AudioSniff.sniff(data, complete: true), .known(mime), name)
            // The sniffed type wins over any label.
            XCTAssertEqual(AudioSniff.resolve(data, label: .mp4, complete: true), mime, name)
        }
    }

    func testSignatures() {
        XCTAssertEqual(AudioSniff.sniff(bytes("ID3"), complete: false), .known(.mpeg))
        XCTAssertEqual(AudioSniff.sniff(Data([0xFF, 0xFB]), complete: false), .known(.mpeg)) // MPEG-1 layer III
        XCTAssertEqual(AudioSniff.sniff(Data([0xFF, 0xF3]), complete: false), .known(.mpeg)) // MPEG-2 layer III
        XCTAssertEqual(AudioSniff.sniff(Data([0xFF, 0xE3]), complete: false), .known(.mpeg)) // MPEG-2.5 layer III
        XCTAssertEqual(AudioSniff.sniff(Data([0xFF, 0xF1]), complete: false), .known(.aac)) // ADTS, MPEG-4
        XCTAssertEqual(AudioSniff.sniff(Data([0xFF, 0xF9]), complete: false), .known(.aac)) // ADTS, MPEG-2
        XCTAssertEqual(AudioSniff.sniff(bytes("RIFF") + Data([1, 2, 3, 4]) + bytes("WAVE"), complete: false), .known(.wav))
        XCTAssertEqual(AudioSniff.sniff(Data([0, 0, 0, 0x20]) + bytes("ftypM4A "), complete: false), .known(.mp4))
    }

    /// Fewer than 12 bytes that match nothing yet wait for more, unless the
    /// clip is complete.
    func testNeedsMore() {
        XCTAssertEqual(AudioSniff.sniff(Data(), complete: false), .needMore)
        XCTAssertEqual(AudioSniff.sniff(bytes("I"), complete: false), .needMore)
        XCTAssertEqual(AudioSniff.sniff(bytes("ID"), complete: false), .needMore)
        XCTAssertEqual(AudioSniff.sniff(Data([0xFF]), complete: false), .needMore)
        XCTAssertEqual(AudioSniff.sniff(bytes("RIFF1234WAV"), complete: false), .needMore)
        XCTAssertEqual(AudioSniff.sniff(Data([0, 0, 0]), complete: false), .needMore)
        XCTAssertEqual(AudioSniff.sniff(Data([0, 0, 0, 0x20, 0x66, 0x74]), complete: false), .needMore)
        XCTAssertEqual(AudioSniff.sniff(bytes("ID"), complete: true), .unknown)
    }

    func testUnknownFallsBackToTheLabel() {
        XCTAssertEqual(AudioSniff.sniff(bytes("OggS0000000000"), complete: false), .unknown)
        XCTAssertEqual(AudioSniff.sniff(bytes("RIFF1234AVI LIST"), complete: false), .unknown)
        XCTAssertEqual(AudioSniff.sniff(Data([0xFF, 0x00]) + Data(count: 10), complete: false), .unknown)
        XCTAssertEqual(AudioSniff.resolve(bytes("OggS0000000000"), label: .aac, complete: false), .aac)
        XCTAssertNil(AudioSniff.resolve(bytes("ID"), label: .aac, complete: false))
    }

    private func bytes(_ text: String) -> Data { Data(text.utf8) }
}

func fixture(_ name: String) throws -> Data {
    let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Fixtures"), name)
    return try Data(contentsOf: url)
}
