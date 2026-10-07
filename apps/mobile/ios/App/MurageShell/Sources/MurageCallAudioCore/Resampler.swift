import AVFAudio
import Foundation

/// Spec §4.2.3: one long-lived converter per input format, from the tap's
/// format to 16 kHz mono Float32. Its input block supplies each tap buffer
/// once and then answers `.noDataNow`, never `.endOfStream`, so the converter
/// keeps its filter state between taps and no samples are lost at the edges.
/// Not thread-safe: the engine calls it on its one queue, with a copy of the
/// tap's buffer (the tap's own buffer is only valid during the tap block).
public final class MicResampler {
    public static let outputRate: Double = 16000
    public static let outputFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: outputRate, channels: 1, interleaved: false
    )!
    /// The most output the converter holds back until the next tap, at
    /// 16 kHz: its filter latency plus a partly filled internal block.
    /// Measured on macOS 26 at up to 242 frames (4800-frame taps at 44.1 kHz);
    /// nothing is lost, it comes out with the next tap.
    public static let maxLatency = 512

    public let inputFormat: AVAudioFormat
    private let converter: AVAudioConverter

    public init?(input: AVAudioFormat) {
        guard input.sampleRate > 0, input.channelCount > 0,
              let converter = AVAudioConverter(from: input, to: Self.outputFormat) else { return nil }
        converter.downmix = true
        inputFormat = input
        self.converter = converter
    }

    /// `ceil(in × 16000 / inRate) + 32` frames.
    public static func capacity(frames: AVAudioFrameCount, inputRate: Double) -> AVAudioFrameCount {
        AVAudioFrameCount((Double(frames) * outputRate / inputRate).rounded(.up)) + 32
    }

    /// Converts one tap buffer (in `inputFormat`) and returns the 16 kHz
    /// samples it completes, or nil if the converter failed.
    public func convert(_ buffer: AVAudioPCMBuffer) -> [Float]? {
        guard buffer.format == inputFormat,
              let outputs = ConverterPump.run(converter, input: buffer, end: false,
                                              capacity: Self.capacity(frames: buffer.frameLength, inputRate: inputFormat.sampleRate))
        else { return nil }
        var samples: [Float] = []
        for out in outputs {
            samples += UnsafeBufferPointer(start: out.floatChannelData![0], count: Int(out.frameLength))
        }
        return samples
    }
}

/// How both converters are driven, measured on macOS 26: an input buffer is
/// supplied ONCE, then the block answers `.noDataNow` (or `.endOfStream` for
/// a flush) and `convert` is called again while it reports `.haveData`
/// (output full), until `.inputRanDry`. Handing over the next buffer while
/// the converter still holds part of the last one drops that part: with tap
/// sizes that vary (4096, 4800, 997, …) a single call per tap lost about
/// 200 samples in 3 s, with an audible jump. Draining each buffer first
/// gives the same samples however the input is split.
enum ConverterPump {
    static func run(_ converter: AVAudioConverter, input: AVAudioBuffer?, end: Bool, capacity: AVAudioFrameCount) -> [AVAudioPCMBuffer]? {
        let once = SuppliedOnce()
        once.done = input == nil
        var outputs: [AVAudioPCMBuffer] = []
        while true {
            guard let out = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: max(1, capacity)) else { return nil }
            var error: NSError?
            let status = converter.convert(to: out, error: &error) { _, inputStatus in
                if once.done {
                    inputStatus.pointee = end ? .endOfStream : .noDataNow
                    return nil
                }
                once.done = true
                inputStatus.pointee = .haveData
                return input
            }
            if status == .error || error != nil { return nil }
            if out.frameLength > 0 { outputs.append(out) }
            guard status == .haveData else { return outputs }
        }
    }
}

/// A once-only flag for a converter's input block.
final class SuppliedOnce: @unchecked Sendable {
    var done = false
}
