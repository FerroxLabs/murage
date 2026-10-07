import Foundation

/// Where assembled bytes go. The app writes real files (P16); tests use memory.
public protocol SaveSink: AnyObject {
    func create(id: String, filename: String) throws -> URL
    func append(_ data: Data, to file: URL) throws
    func discard(_ file: URL)
}

public struct AssembledFile: Equatable, Sendable {
    public let file: URL
    public let filename: String
    public let mime: String
    public let size: Int
}

/// The native half of save-file.ts saveBlobNatively: `begin`, chunks in
/// order from index 0, `end`; `abort` on any failure. Each chunk is appended
/// as it arrives, so at most one 1 MiB piece is ever held in memory here.
///
/// Not thread-safe: `open` is unguarded mutable state, so every call must
/// come from the same thread/queue (the channel's own serial delivery).
@MainActor
public final class ChunkAssembler {
    public static let maxOpen = 2
    public static let idleLimit: TimeInterval = 120

    private struct Transfer {
        let file: URL
        let filename: String
        let mime: String
        let size: Int
        var next = 0
        var received = 0
        var touched: Date
    }

    private var open: [String: Transfer] = [:]
    private let sink: SaveSink
    private let now: () -> Date

    public init(sink: SaveSink, now: @escaping () -> Date = Date.init) {
        self.sink = sink
        self.now = now
    }

    public var openCount: Int { open.count }

    public func begin(id: String, filename: String, mime: String, size: Int) throws {
        expireIdle()
        guard open[id] == nil, size >= 0 else { throw ChannelError.badArgs }
        guard size <= SaveRequest.maxBytes else { throw ChannelError.tooLarge }
        guard open.count < Self.maxOpen else { throw ChannelError.busy }
        let file: URL
        do { file = try sink.create(id: id, filename: filename) } catch { throw ChannelError.writeFailed }
        open[id] = Transfer(file: file, filename: filename, mime: mime, size: size, touched: now())
    }

    public func chunk(id: String, index: Int, base64: String) throws {
        guard var transfer = open[id], index == transfer.next else { throw ChannelError.badArgs }
        // Before decoding: Foundation's decoder is lenient (stray whitespace,
        // dropped padding), and a giant string is wasted work either way.
        guard base64.utf16.count <= SaveRequest.maxBase64 else { throw ChannelError.tooLarge }
        guard !base64.isEmpty || transfer.size == 0 else { throw ChannelError.badArgs }
        guard Self.isStrictBase64(base64), let data = Data(base64Encoded: base64) else { throw ChannelError.badArgs }
        guard data.count <= SaveRequest.chunkBytes, transfer.received + data.count <= transfer.size else {
            throw ChannelError.tooLarge
        }
        do {
            try sink.append(data, to: transfer.file)
        } catch {
            // A retry can't append after partial bytes: the transfer is gone.
            abort(id: id)
            throw ChannelError.writeFailed
        }
        transfer.next += 1
        transfer.received += data.count
        transfer.touched = now()
        open[id] = transfer
    }

    /// `^[A-Za-z0-9+/]*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$`, checked by
    /// hand rather than re-encoding: a re-encode-and-compare would reject a
    /// legal chunk like "aGl=" whose pad bits are non-zero but still decode
    /// the same bytes (Foundation and the page's `atob` both accept it).
    private static func isStrictBase64(_ text: String) -> Bool {
        let scalars = Array(text.unicodeScalars)
        guard scalars.count % 4 == 0 else { return false }
        guard !scalars.isEmpty else { return true }
        func isAlphabet(_ scalar: Unicode.Scalar) -> Bool {
            ("A"..."Z").contains(scalar) || ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
                || scalar == "+" || scalar == "/"
        }
        guard scalars.dropLast(4).allSatisfy(isAlphabet) else { return false }
        let tail = Array(scalars.suffix(4))
        if tail.allSatisfy(isAlphabet) { return true }
        if isAlphabet(tail[0]), isAlphabet(tail[1]), tail[2] == "=", tail[3] == "=" { return true }
        if isAlphabet(tail[0]), isAlphabet(tail[1]), isAlphabet(tail[2]), tail[3] == "=" { return true }
        return false
    }

    /// A short transfer stays open so the page's `abort` can discard it.
    public func end(id: String) throws -> AssembledFile {
        guard let transfer = open[id], transfer.received == transfer.size else { throw ChannelError.badArgs }
        open[id] = nil
        return AssembledFile(file: transfer.file, filename: transfer.filename, mime: transfer.mime, size: transfer.size)
    }

    public func abort(id: String) {
        guard let transfer = open.removeValue(forKey: id) else { return }
        sink.discard(transfer.file)
    }

    /// A page that reloaded mid-transfer never sends `abort`.
    private func expireIdle() {
        let cutoff = now().addingTimeInterval(-Self.idleLimit)
        for (id, transfer) in open where transfer.touched < cutoff { abort(id: id) }
    }
}
