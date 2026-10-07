import AudioToolbox
import AVFAudio
import Foundation

public enum StreamDecoderError: Error, Equatable {
    /// A piece arrived after `last`.
    case finished
    /// The bytes could not be parsed (the OSStatus of the parser or file).
    case unreadable(OSStatus)
    /// `last` arrived and no audio format was ever found.
    case noAudio
    /// The converter could not be made or failed.
    case converter
}

/// Spec §4.2.4 Decoder: one per clip. Pieces go in as they arrive; 48 kHz
/// mono Float32 buffers come out as soon as there is audio to make them, and
/// the rest is flushed on `last`.
///
/// - The type is sniffed from the first bytes (AudioSniff), and the sniffed
///   type wins over the page's label.
/// - MP3, ADTS AAC and WAV stream through `AudioFileStream`, with the type
///   hint. Compressed packets become `AVAudioCompressedBuffer`s with their
///   packet descriptions (VBR) and the magic cookie when there is one; WAV
///   bytes are wrapped as PCM in the stream's format.
/// - MP4 is buffered whole and read through `AudioFile` callbacks when
///   `last` arrives, because a file whose `moov` follows `mdat` cannot be
///   streamed. No current voice service sends it.
/// - One `AVAudioConverter` with `downmix = true` makes 48 kHz mono. Its
///   input block answers `.noDataNow` while waiting for bytes, and
///   `.endOfStream` only after `last`, so its state runs across pieces and
///   the output is the same however the bytes were split.
/// - Priming (about 25 ms of leading silence in MP3) is kept.
///
/// Not thread-safe: the engine drives it on its one queue.
public final class StreamDecoder {
    public static let outputFormat = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
    /// Output buffer size: 100 ms.
    static let chunkFrames: AVAudioFrameCount = 4800
    /// Bytes gathered before each `AudioFileStreamParseBytes`. Measured on
    /// macOS 26: fed pieces smaller than an MP3 frame (1 or 2 bytes, or runs
    /// of up to 500), the MP3 parser silently loses or mangles packets; with
    /// at least 1 KB per call it matched a one-shot parse on 600 random
    /// splits. 4 KB is above the largest MP3 frame (2,881 bytes). The page
    /// sends 64 KB pieces, so this never delays real playback.
    static let minParseBytes = 4096

    public let label: CallAudioMime
    /// The type being decoded, once the first bytes have decided it.
    public private(set) var type: CallAudioMime?
    /// `last` has been appended.
    public private(set) var finished = false

    private var head = Data()
    private var unparsed = Data()
    private var whole = Data()
    private var stream: AudioFileStreamID?
    private var sourceFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var pending: [AVAudioBuffer] = []
    private var pcmCarry = Data()
    private var failure: StreamDecoderError?

    public init(label: CallAudioMime) {
        self.label = label
    }

    deinit {
        if let stream { AudioFileStreamClose(stream) }
    }

    /// Appends one piece (which may be empty) and returns the non-empty
    /// buffers it completes. With `last`, everything left is flushed. A thrown
    /// error means the clip cannot be played any further.
    public func append(_ bytes: Data, last: Bool) throws -> [AVAudioPCMBuffer] {
        guard !finished else { throw StreamDecoderError.finished }
        finished = last
        var input = bytes
        if type == nil {
            head.append(bytes)
            guard let resolved = AudioSniff.resolve(head, label: label, complete: last) else { return [] }
            type = resolved
            input = head
            head = Data()
        }
        if type == .mp4 {
            whole.append(input)
            guard last else { return [] }
            try readWhole()
        } else {
            unparsed.append(input)
            if unparsed.count >= Self.minParseBytes || last {
                try parse(unparsed)
                unparsed = Data()
            }
        }
        return try drain(last: last)
    }

    // MARK: streaming (MP3, ADTS, WAV)

    private func parse(_ bytes: Data) throws {
        if stream == nil {
            let hint: AudioFileTypeID
            switch type {
            case .wav: hint = kAudioFileWAVEType
            case .aac: hint = kAudioFileAAC_ADTSType
            default: hint = kAudioFileMP3Type
            }
            var opened: AudioFileStreamID?
            let status = AudioFileStreamOpen(Unmanaged.passUnretained(self).toOpaque(), { client, stream, property, _ in
                Unmanaged<StreamDecoder>.fromOpaque(client).takeUnretainedValue().property(stream, property)
            }, { client, count, packets, data, descriptions in
                Unmanaged<StreamDecoder>.fromOpaque(client).takeUnretainedValue().packets(count, packets, data, descriptions)
            }, hint, &opened)
            guard status == noErr, let opened else { throw StreamDecoderError.unreadable(status) }
            stream = opened
        }
        guard let stream, !bytes.isEmpty else { return }
        let status = bytes.withUnsafeBytes { raw in
            AudioFileStreamParseBytes(stream, UInt32(raw.count), raw.baseAddress, [])
        }
        if let failure { throw failure }
        guard status == noErr else { throw StreamDecoderError.unreadable(status) }
    }

    private func property(_ stream: AudioFileStreamID, _ property: AudioFileStreamPropertyID) {
        guard property == kAudioFileStreamProperty_ReadyToProducePackets, converter == nil else { return }
        var description = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        guard AudioFileStreamGetProperty(stream, kAudioFileStreamProperty_DataFormat, &size, &description) == noErr,
              let format = AVAudioFormat(streamDescription: &description) else {
            failure = .noAudio
            return
        }
        var cookieSize: UInt32 = 0
        if AudioFileStreamGetPropertyInfo(stream, kAudioFileStreamProperty_MagicCookieData, &cookieSize, nil) == noErr, cookieSize > 0 {
            var cookie = Data(count: Int(cookieSize))
            let status = cookie.withUnsafeMutableBytes { AudioFileStreamGetProperty(stream, kAudioFileStreamProperty_MagicCookieData, &cookieSize, $0.baseAddress!) }
            if status == noErr { format.magicCookie = cookie.prefix(Int(cookieSize)) }
        }
        makeConverter(from: format)
    }

    private func packets(_ count: UInt32, _ packets: UInt32, _ data: UnsafeRawPointer, _ descriptions: UnsafeMutablePointer<AudioStreamPacketDescription>?) {
        guard let format = sourceFormat, failure == nil else { return }
        if format.commonFormat != .otherFormat {
            pcm(UnsafeRawBufferPointer(start: data, count: Int(count)), format)
            return
        }
        // Copy packet by packet: the descriptions' offsets need not start at
        // zero or cover every byte (ADTS headers sit between them).
        let buffer: AVAudioCompressedBuffer
        if let descriptions {
            let largest = (0..<Int(packets)).map { Int(descriptions[$0].mDataByteSize) }.max() ?? 0
            buffer = AVAudioCompressedBuffer(format: format, packetCapacity: packets, maximumPacketSize: max(1, largest))
            guard let target = buffer.packetDescriptions else {
                failure = .converter
                return
            }
            var offset = 0
            for i in 0..<Int(packets) {
                var packet = descriptions[i]
                let size = Int(packet.mDataByteSize)
                guard packet.mStartOffset >= 0, Int(packet.mStartOffset) + size <= Int(count) else {
                    failure = .unreadable(kAudioFileStreamError_InvalidPacketOffset)
                    return
                }
                (buffer.data + offset).copyMemory(from: data + Int(packet.mStartOffset), byteCount: size)
                packet.mStartOffset = Int64(offset)
                target[i] = packet
                offset += size
            }
            buffer.byteLength = UInt32(offset)
        } else {
            buffer = AVAudioCompressedBuffer(format: format, packetCapacity: packets)
            guard Int(count) <= buffer.byteCapacity else {
                failure = .unreadable(kAudioFileStreamError_InvalidPacketOffset)
                return
            }
            buffer.data.copyMemory(from: data, byteCount: Int(count))
            buffer.byteLength = count
        }
        buffer.packetCount = packets
        pending.append(buffer)
    }

    /// WAV: bytes to PCM frames in the stream's own format, carrying any
    /// partial frame to the next call.
    private func pcm(_ bytes: UnsafeRawBufferPointer, _ format: AVAudioFormat) {
        let frameBytes = Int(format.streamDescription.pointee.mBytesPerFrame)
        guard frameBytes > 0, format.isInterleaved || format.channelCount == 1 else {
            failure = .noAudio
            return
        }
        pcmCarry.append(contentsOf: bytes)
        let frames = pcmCarry.count / frameBytes
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let target = buffer.mutableAudioBufferList.pointee.mBuffers.mData else { return }
        pcmCarry.withUnsafeBytes { target.copyMemory(from: $0.baseAddress!, byteCount: frames * frameBytes) }
        buffer.frameLength = AVAudioFrameCount(frames)
        pcmCarry.removeFirst(frames * frameBytes)
        pending.append(buffer)
    }

    // MARK: buffered whole (MP4)

    private func readWhole() throws {
        var file: AudioFileID?
        let client = Unmanaged.passUnretained(self).toOpaque()
        var status = AudioFileOpenWithCallbacks(client, { client, position, count, buffer, actual in
            let whole = Unmanaged<StreamDecoder>.fromOpaque(client).takeUnretainedValue().whole
            let start = Int(max(0, min(position, Int64(whole.count))))
            let end = min(whole.count, start + Int(count))
            whole.withUnsafeBytes { buffer.copyMemory(from: $0.baseAddress! + start, byteCount: end - start) }
            actual.pointee = UInt32(end - start)
            return noErr
        }, nil, { client in
            Int64(Unmanaged<StreamDecoder>.fromOpaque(client).takeUnretainedValue().whole.count)
        }, nil, kAudioFileM4AType, &file)
        guard status == noErr, let file else { throw StreamDecoderError.unreadable(status) }
        defer { AudioFileClose(file) }
        var ext: ExtAudioFileRef?
        status = ExtAudioFileWrapAudioFileID(file, false, &ext)
        guard status == noErr, let ext else { throw StreamDecoderError.unreadable(status) }
        defer { ExtAudioFileDispose(ext) }

        var description = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        status = ExtAudioFileGetProperty(ext, kExtAudioFileProperty_FileDataFormat, &size, &description)
        guard status == noErr, description.mSampleRate > 0, description.mChannelsPerFrame > 0,
              let client = AVAudioFormat(standardFormatWithSampleRate: description.mSampleRate, channels: description.mChannelsPerFrame)
        else { throw StreamDecoderError.unreadable(status) }
        status = ExtAudioFileSetProperty(ext, kExtAudioFileProperty_ClientDataFormat,
                                         UInt32(MemoryLayout<AudioStreamBasicDescription>.size), client.streamDescription)
        guard status == noErr else { throw StreamDecoderError.unreadable(status) }
        makeConverter(from: client)
        while true {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: client, frameCapacity: 8192) else { throw StreamDecoderError.converter }
            buffer.frameLength = buffer.frameCapacity // sizes the buffer list for the read
            var frames: UInt32 = buffer.frameCapacity
            status = ExtAudioFileRead(ext, &frames, buffer.mutableAudioBufferList)
            guard status == noErr else { throw StreamDecoderError.unreadable(status) }
            if frames == 0 { break }
            buffer.frameLength = frames
            pending.append(buffer)
        }
    }

    // MARK: conversion

    private func makeConverter(from format: AVAudioFormat) {
        guard let converter = AVAudioConverter(from: format, to: Self.outputFormat) else {
            failure = .converter
            return
        }
        converter.downmix = true
        sourceFormat = format
        self.converter = converter
    }

    /// Converts every pending buffer, each drained before the next is
    /// supplied (ConverterPump), then flushes the converter on `last`.
    private func drain(last: Bool) throws -> [AVAudioPCMBuffer] {
        if let failure { throw failure }
        guard let converter else {
            if last { throw StreamDecoderError.noAudio }
            return []
        }
        var out: [AVAudioPCMBuffer] = []
        while !pending.isEmpty {
            let input = pending.removeFirst()
            guard let buffers = ConverterPump.run(converter, input: input, end: false, capacity: Self.chunkFrames) else {
                throw StreamDecoderError.converter
            }
            out += buffers
        }
        if last {
            guard let buffers = ConverterPump.run(converter, input: nil, end: true, capacity: Self.chunkFrames) else {
                throw StreamDecoderError.converter
            }
            out += buffers
        }
        return out
    }
}
