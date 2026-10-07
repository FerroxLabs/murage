import Foundation

/// Spec §4.2.3: the resampler's 16 kHz mono Float32 arrives in whatever sizes
/// the tap produces; the framer carries the remainder across taps and cuts
/// exact 1024-sample frames, each as signed 16-bit little-endian PCM (clipped)
/// in base64: 2,048 bytes, 2,732 characters.
public struct MicFramer: Sendable {
    public static let frameLength = 1024

    private var carry: [Float] = []

    public init() {}

    /// Samples held back for the next frame.
    public var pending: Int { carry.count }

    /// Appends samples and returns every whole frame they complete.
    public mutating func append(_ samples: UnsafeBufferPointer<Float>) -> [String] {
        var frames: [String] = []
        var at = 0
        if !carry.isEmpty {
            let take = min(Self.frameLength - carry.count, samples.count)
            carry += samples[0..<take]
            at = take
            guard carry.count == Self.frameLength else { return [] }
            frames.append(carry.withUnsafeBufferPointer { Self.encode($0[...]) })
            carry.removeAll(keepingCapacity: true)
        }
        while samples.count - at >= Self.frameLength {
            frames.append(Self.encode(samples[at..<(at + Self.frameLength)]))
            at += Self.frameLength
        }
        carry += samples[at...]
        return frames
    }

    public mutating func append(_ samples: [Float]) -> [String] {
        samples.withUnsafeBufferPointer { append($0) }
    }

    /// Drops the remainder, for a new capture after a hold.
    public mutating func reset() {
        carry.removeAll()
    }

    /// Float to Int16: clipped to ±1, scaled by 32767, rounded; NaN is silence.
    public static func int16(_ sample: Float) -> Int16 {
        guard !sample.isNaN else { return 0 }
        return Int16((max(-1, min(1, sample)) * 32767).rounded())
    }

    private static func encode(_ frame: Slice<UnsafeBufferPointer<Float>>) -> String {
        var pcm = Data(count: frame.count * 2)
        pcm.withUnsafeMutableBytes { raw in
            for (i, sample) in frame.enumerated() {
                raw.storeBytes(of: int16(sample).littleEndian, toByteOffset: i * 2, as: Int16.self)
            }
        }
        return pcm.base64EncodedString()
    }
}
