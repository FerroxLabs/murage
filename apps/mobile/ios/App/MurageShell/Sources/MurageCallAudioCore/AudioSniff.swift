import Foundation

public enum SniffResult: Equatable, Sendable {
    case known(CallAudioMime)
    /// Too few bytes to say yet.
    case needMore
    /// Nothing recognised: the page's label decides.
    case unknown
}

/// Spec §4.1 `mime`: native sniffs the first bytes, and the sniffed type wins
/// over the label. ID3 or an MPEG audio frame sync is MP3, `RIFF…WAVE` is WAV,
/// an ADTS header is AAC, and a `ftyp` box is MP4.
public enum AudioSniff {
    /// The most bytes any signature needs (`RIFF` size `WAVE`).
    public static let window = 12

    public static func sniff(_ bytes: Data, complete: Bool) -> SniffResult {
        let b = [UInt8](bytes.prefix(window))
        if b.count >= 3, b[0] == 0x49, b[1] == 0x44, b[2] == 0x33 { return .known(.mpeg) } // "ID3"
        if b.count >= 2, b[0] == 0xFF, b[1] & 0xE0 == 0xE0 {
            let layer = (b[1] >> 1) & 0x03
            let version = (b[1] >> 3) & 0x03
            // ADTS: a 12-bit sync and layer 00. MPEG audio: an 11-bit sync, a
            // real layer, and not the reserved version 01.
            if layer == 0, b[1] & 0xF0 == 0xF0 { return .known(.aac) }
            if layer != 0, version != 0x01 { return .known(.mpeg) }
        }
        if b.count >= 12, b[0..<4] == [0x52, 0x49, 0x46, 0x46][...], b[8..<12] == [0x57, 0x41, 0x56, 0x45][...] {
            return .known(.wav)
        }
        if b.count >= 8, b[4..<8] == [0x66, 0x74, 0x79, 0x70][...] { return .known(.mp4) } // "ftyp"
        return b.count < window && !complete ? .needMore : .unknown
    }

    /// The type to decode as: the sniffed one, else the label, or nil while
    /// more bytes are needed to tell.
    public static func resolve(_ bytes: Data, label: CallAudioMime, complete: Bool) -> CallAudioMime? {
        switch sniff(bytes, complete: complete) {
        case let .known(mime): return mime
        case .unknown: return label
        case .needMore: return nil
        }
    }
}
