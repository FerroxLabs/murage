import AVFAudio
import Foundation
import XCTest
@testable import MurageCallAudioCore

/// Spec §4.2.4 Decoder: pieces in, 48 kHz mono Float32 out. Each fixture is
/// fed in uneven pieces and compared with a one-shot decode of the same bytes:
/// same frame count, and the same samples (no gap, repeat or click where a
/// piece boundary fell).
final class StreamDecoderTests: XCTestCase {
    private let fixtures: [(name: String, label: CallAudioMime, seconds: Double)] = [
        ("voice-id3.mp3", .mpeg, 10.03), ("voice-vbr.mp3", .mpeg, 2.95), ("voice.wav", .wav, 2.5),
        ("voice.aac", .aac, 2.97), ("voice-stereo.mp3", .mpeg, 2.0), ("voice.m4a", .mp4, 2.95),
    ]

    func testOneShotLengthAndFormat() throws {
        for (name, label, seconds) in fixtures {
            let pcm: [Float]
            do { pcm = try decode(fixture(name), label: label, pieces: [Int.max]) } catch {
                XCTFail("\(name): \(error)")
                continue
            }
            // MP3 and AAC priming adds up to about 50 ms of leading silence (accepted, §4.2.4).
            XCTAssertEqual(Double(pcm.count) / 48000, seconds, accuracy: 0.08, name)
            XCTAssertGreaterThan(pcm.map(abs).max() ?? 0, 0.05, name)
        }
    }

    func testUnevenPiecesMatchTheOneShotDecode() throws {
        for (name, label, _) in fixtures {
            let data = try fixture(name)
            let reference = try decode(data, label: label, pieces: [Int.max])
            var random = SeededRandom(seed: 7)
            let plans: [(String, [Int])] = [
                ("64 KB", [65_536]),
                ("1 byte for 8 KB", [Int](repeating: 1, count: 8192) + [4096]),
                ("1 byte", [1]),
                // Pieces split the ID3 tag (6,156 bytes) and then the first frame headers.
                ("mid-header", [1, 2, 3, 5, 700, 948, 2, 1, 417, 3000]),
                // The decoder parses in 4 KB steps, so pieces just over that
                // put the parser's own boundaries mid-tag, mid-header and mid-frame.
                ("parse steps", [4097, 4099, 4101, 4103, 4105, 4107, 4109]),
                ("random", (0..<400).map { _ in random.next(in: 1...3000) }),
                ("random large", (0..<100).map { _ in random.next(in: 4096...9000) }),
                ("odd sizes", [3, 1021, 17, 4099, 2]),
            ]
            for (plan, sizes) in plans {
                let pcm: [Float]
                do { pcm = try decode(data, label: label, pieces: sizes) } catch {
                    XCTFail("\(name) \(plan): \(error)")
                    continue
                }
                XCTAssertEqual(pcm.count, reference.count, "\(name) \(plan)")
                if let j = (0..<min(pcm.count, reference.count)).first(where: { abs(pcm[$0] - reference[$0]) > 1e-6 }) {
                    XCTFail("\(name) \(plan): sample \(j) is \(pcm[j]), one-shot \(reference[j])")
                }
            }
        }
    }

    /// The last piece may be empty; a clip only flushes on `last`.
    func testEmptyLastPieceFlushes() throws {
        let data = try fixture("voice-vbr.mp3")
        let decoder = StreamDecoder(label: .mpeg)
        var frames = try decoder.append(data, last: false).reduce(0) { $0 + Int($1.frameLength) }
        XCTAssertFalse(decoder.finished)
        frames += try decoder.append(Data(), last: true).reduce(0) { $0 + Int($1.frameLength) }
        XCTAssertTrue(decoder.finished)
        XCTAssertEqual(frames, try decode(data, label: .mpeg, pieces: [Int.max]).count)
    }

    /// Output arrives while pieces stream in, before `last` (except MP4).
    func testStreamsBeforeLast() throws {
        let data = try fixture("voice-id3.mp3")
        let decoder = StreamDecoder(label: .mpeg)
        let early = try decoder.append(data.prefix(20_000), last: false)
        XCTAssertGreaterThan(early.reduce(0) { $0 + Int($1.frameLength) }, 48000)
        for buffer in early {
            XCTAssertGreaterThan(buffer.frameLength, 0) // never a zero-length buffer
            XCTAssertEqual(buffer.format, StreamDecoder.outputFormat)
        }
    }

    /// MP4 is buffered whole: `moov` may come after `mdat` (it does in this fixture).
    func testMP4IsBufferedWhole() throws {
        let data = try fixture("voice.m4a")
        let decoder = StreamDecoder(label: .mp4)
        XCTAssertEqual(try decoder.append(data.prefix(10_000), last: false).count, 0)
        let rest = try decoder.append(data.dropFirst(10_000), last: true)
        XCTAssertGreaterThan(rest.reduce(0) { $0 + Int($1.frameLength) }, 48000)
    }

    /// The sniffed type wins over the label.
    func testSniffWinsOverTheLabel() throws {
        let decoder = StreamDecoder(label: .wav)
        let pcm = try decoder.append(fixture("voice-vbr.mp3"), last: true)
        XCTAssertEqual(decoder.type, .mpeg)
        XCTAssertGreaterThan(pcm.count, 0)
    }

    /// The right channel only: a downmix hears it, taking the left channel would not.
    func testStereoIsDownmixed() throws {
        let pcm = try decode(fixture("voice-stereo.mp3"), label: .mpeg, pieces: [5000])
        let settled = Array(pcm.dropFirst(4800).dropLast(4800))
        XCTAssertGreaterThan(settled.map(abs).max() ?? 0, 0.03)
        var crossings = 0
        for j in 1..<settled.count where (settled[j - 1] < 0) != (settled[j] < 0) { crossings += 1 }
        XCTAssertEqual(Double(crossings) / 2 / (Double(settled.count) / 48000), 440, accuracy: 2)
    }

    func testUndecodableClipsThrow() throws {
        XCTAssertThrowsError(try StreamDecoder(label: .mpeg).append(Data(), last: true))
        XCTAssertThrowsError(try StreamDecoder(label: .mpeg).append(Data(repeating: 0x41, count: 5000), last: true))
        XCTAssertThrowsError(try StreamDecoder(label: .mp4).append(Data(repeating: 0, count: 5000), last: true))
        XCTAssertThrowsError(try StreamDecoder(label: .wav).append(Data("RIFF".utf8) + Data(count: 40), last: true))
        let truncated = try fixture("voice.wav").prefix(30)
        XCTAssertThrowsError(try StreamDecoder(label: .wav).append(truncated, last: true))
    }

    /// A download that broke part-way still plays what arrived (spec §4.1).
    func testPartialClipPlaysWhatArrived() throws {
        let data = try fixture("voice-id3.mp3")
        let half = data.count / 2
        let pcm = try decode(data.prefix(half), label: .mpeg, pieces: [4000])
        // 10 s of CBR audio follows the 6,156-byte tag: the half that arrived holds its share.
        let expected = 10.03 * Double(half - 6156) / Double(data.count - 6156)
        XCTAssertEqual(Double(pcm.count) / 48000, expected, accuracy: 0.1)
    }

    func testAppendAfterFinishIsRefused() throws {
        let decoder = StreamDecoder(label: .mpeg)
        _ = try decoder.append(fixture("voice-vbr.mp3"), last: true)
        XCTAssertThrowsError(try decoder.append(Data([1]), last: true))
    }

    /// Recorded in the task report: the time to decode the 10 s MP3 on this Mac.
    func testDecodeTimeFor10Seconds() throws {
        let data = try fixture("voice-id3.mp3")
        _ = try decode(data, label: .mpeg, pieces: [65_536]) // warm up
        let start = Date()
        let pcm = try decode(data, label: .mpeg, pieces: [65_536])
        let elapsed = Date().timeIntervalSince(start)
        print("call audio decode 10 s MP3: \(String(format: "%.1f", elapsed * 1000)) ms for \(pcm.count) frames")
        XCTAssertLessThan(elapsed, 1.0)
    }

    // MARK: helpers

    /// Feeds `data` in pieces of the given sizes (the last size repeats), then
    /// an empty `last` piece, and returns every sample.
    private func decode(_ data: Data, label: CallAudioMime, pieces: [Int]) throws -> [Float] {
        let decoder = StreamDecoder(label: label)
        var out: [Float] = []
        var at = data.startIndex
        var i = 0
        func take(_ buffers: [AVAudioPCMBuffer]) {
            for buffer in buffers {
                XCTAssertEqual(buffer.format, StreamDecoder.outputFormat)
                XCTAssertGreaterThan(buffer.frameLength, 0)
                out += UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength))
            }
        }
        while at < data.endIndex {
            let size = pieces[min(i, pieces.count - 1)]
            let end = data.index(at, offsetBy: min(size, data.endIndex - at))
            take(try decoder.append(data[at..<end], last: false))
            at = end
            i += 1
        }
        take(try decoder.append(Data(), last: true))
        XCTAssertTrue(decoder.finished)
        return out
    }
}

/// A small deterministic generator, so a failing split is reproducible.
struct SeededRandom {
    private var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next(in range: ClosedRange<Int>) -> Int {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return range.lowerBound + Int((state >> 33) % UInt64(range.count))
    }
}
