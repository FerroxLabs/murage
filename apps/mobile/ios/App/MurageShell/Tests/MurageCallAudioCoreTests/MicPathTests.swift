import AVFAudio
import Foundation
import XCTest
@testable import MurageCallAudioCore

/// Spec §4.2.3: the tap's streaming converter to 16 kHz mono, and the framer
/// that cuts exact 1024-sample Int16 LE base64 frames.
final class MicPathTests: XCTestCase {
    // MARK: framer

    func testFramerCutsExactFramesFromUnevenPieces() {
        var framer = MicFramer()
        let total = 10 * 1024 + 300
        let signal = (0..<total).map { Float(($0 % 2000) - 1000) / 1000 }
        var frames: [String] = []
        var at = 0
        for size in [1, 1023, 0, 1025, 3000, 7, 4096, 1, 500] + [Int](repeating: 64, count: 100) where at < total {
            let end = min(total, at + size)
            frames += framer.append(Array(signal[at..<end]))
            at = end
        }
        frames += framer.append(Array(signal[at...]))
        XCTAssertEqual(frames.count, 10)
        XCTAssertEqual(framer.pending, 300)
        var decoded: [Int16] = []
        for frame in frames {
            XCTAssertEqual(frame.utf8.count, 2732) // spec §4.1: about 2.7 KB of text
            let data = Data(base64Encoded: frame)!
            XCTAssertEqual(data.count, 2048)
            data.withUnsafeBytes { raw in
                for i in 0..<1024 { decoded.append(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))) }
            }
        }
        for (i, sample) in decoded.enumerated() {
            XCTAssertEqual(sample, MicFramer.int16(signal[i]), "sample \(i)")
        }
    }

    func testInt16ClipsAndRounds() {
        XCTAssertEqual(MicFramer.int16(0), 0)
        XCTAssertEqual(MicFramer.int16(1), 32767)
        XCTAssertEqual(MicFramer.int16(-1), -32767)
        XCTAssertEqual(MicFramer.int16(1.7), 32767)
        XCTAssertEqual(MicFramer.int16(-9), -32767)
        XCTAssertEqual(MicFramer.int16(.infinity), 32767)
        XCTAssertEqual(MicFramer.int16(.nan), 0)
        XCTAssertEqual(MicFramer.int16(0.5), 16384) // 16383.5 rounds away from zero
    }

    func testFramerLittleEndian() {
        var framer = MicFramer()
        var samples = [Float](repeating: 0, count: 1024)
        samples[0] = 1
        samples[1] = -1
        let frame = framer.append(samples)
        let bytes = [UInt8](Data(base64Encoded: frame[0])!)
        XCTAssertEqual(Array(bytes[0..<4]), [0xFF, 0x7F, 0x01, 0x80])
    }

    // MARK: resampler

    func testCapacityFormula() {
        XCTAssertEqual(MicResampler.capacity(frames: 4096, inputRate: 48000), 1366 + 32)
        XCTAssertEqual(MicResampler.capacity(frames: 4800, inputRate: 48000), 1600 + 32)
        XCTAssertEqual(MicResampler.capacity(frames: 4410, inputRate: 44100), 1600 + 32)
        XCTAssertEqual(MicResampler.capacity(frames: 1, inputRate: 44100), 1 + 32)
    }

    func testSineAt48kHz() throws { try sine(rate: 48000, channels: 1) }
    func testSineAt44_1kHz() throws { try sine(rate: 44100, channels: 1) }
    func testSineFromStereoInput() throws { try sine(rate: 48000, channels: 2) }

    /// A 440 Hz sine fed in uneven tap-sized pieces comes out at 16 kHz with
    /// the same frequency, the right length, and exactly the samples a single
    /// conversion of the whole signal gives: nothing is lost at the edges.
    private func sine(rate: Double, channels: AVAudioChannelCount) throws {
        let seconds = 3.0
        let count = Int(rate * seconds)
        let signal = (0..<count).map { Float(0.5 * sin(2 * Double.pi * 440 * Double($0) / rate)) }
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: rate, channels: channels))

        let streamed = try XCTUnwrap(MicResampler(input: format))
        var out: [Float] = []
        var at = 0
        let sizes = [4096, 4800, 1, 997, 4096, 2048, 4096, 333, 4096]
        var i = 0
        while at < count {
            let end = min(count, at + sizes[i % sizes.count])
            out += try XCTUnwrap(streamed.convert(buffer(signal[at..<end], format)))
            at = end
            i += 1
        }

        let whole = try XCTUnwrap(MicResampler(input: format))
        let reference = try XCTUnwrap(whole.convert(buffer(signal[...], format)))

        // Continuity: the same samples as one conversion of the whole signal.
        // Only the tail the converter still holds may differ in length.
        XCTAssertEqual(Double(out.count), Double(reference.count), accuracy: Double(MicResampler.maxLatency))
        for j in 0..<min(out.count, reference.count) where abs(out[j] - reference[j]) > 1e-6 {
            XCTFail("sample \(j): \(out[j]) vs \(reference[j])")
            break
        }

        // Length: every input sample is accounted for, less at most the
        // converter's own latency, which it keeps until the next tap.
        let expected = Int((Double(count) * 16000 / rate).rounded())
        XCTAssertLessThanOrEqual(out.count, expected + 1)
        XCTAssertGreaterThanOrEqual(out.count, expected - MicResampler.maxLatency)

        // Frequency by zero crossings, skipping the converter's start-up.
        let settled = Array(out.dropFirst(1600))
        var crossings = 0
        for j in 1..<settled.count where (settled[j - 1] < 0) != (settled[j] < 0) { crossings += 1 }
        let hz = Double(crossings) / 2 / (Double(settled.count) / 16000)
        XCTAssertEqual(hz, 440, accuracy: 1, "rate \(rate)")
        let peak = settled.map(abs).max() ?? 0
        if channels == 1 { XCTAssertEqual(Double(peak), 0.5, accuracy: 0.05) } else { XCTAssertGreaterThan(peak, 0.3) }
    }

    private func buffer(_ samples: ArraySlice<Float>, _ format: AVAudioFormat) -> AVAudioPCMBuffer {
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(max(1, samples.count)))!
        buffer.frameLength = AVAudioFrameCount(samples.count)
        for channel in 0..<Int(format.channelCount) {
            let data = buffer.floatChannelData![channel]
            for (k, value) in samples.enumerated() { data[k] = value }
        }
        return buffer
    }
}
