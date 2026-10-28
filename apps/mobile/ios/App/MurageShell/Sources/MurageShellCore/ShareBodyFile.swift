import CryptoKit
import Foundation

public enum ShareInputError: Error { case unsupported, tooMany, photoTooLarge, fileTooLarge, invalid }

public struct ShareOutboxState: Codable, Equatable, Sendable {
    public struct Target: Codable, Hashable, Sendable {
        public let botId: String
        public let threadId: String
        public init(botId: String, threadId: String) { self.botId = botId; self.threadId = threadId }
    }
    public enum Status: String, Codable, Sendable { case queued, sent, needsTarget, failed }
    public let shareId: String
    public let workspace: String
    public let target: Target
    public let fingerprint: String
    public let createdAt: Int64
    public var state: Status
    // Optional so N11's already queued records remain readable.
    public var attempts: Int? = nil
    public var nextAttemptAt: Int64? = nil
    public var updatedAt: Int64? = nil
    public var code: String? = nil
    public var lastCompletionID: String? = nil
}

/// Files and images arrive here as URLs; only a 32 KiB chunk is read at once.
public enum ShareBodyFile {
    public struct Attachment: Sendable {
        public let url: URL
        public let name: String
        public let mime: String
        public init(url: URL, name: String, mime: String) { self.url = url; self.name = name; self.mime = mime }
    }
    public struct Prepared: Sendable {
        public let body: URL
        public let state: ShareOutboxState
        public let boundary: String
    }
    public static func boundary(shareId: String) -> String { "murage-" + shareId }
    public static func prepare(root: URL, origin: WorkspaceOrigin, target: ShareOutboxState.Target,
                               shareId: String, note: String?, text: String?, url: String?,
                               attachments: [Attachment], now: Int64) throws -> Prepared {
        guard PhoneAskContract.matches(shareId, "[A-Za-z0-9_-]{16,80}") else { throw ShareInputError.invalid }
        guard attachments.count <= PhoneAskContract.ShareLimits.maxItems else { throw ShareInputError.tooMany }
        var items: [PhoneAskContract.ShareItem] = []
        var total: Int64 = 0
        for (index, attachment) in attachments.enumerated() {
            let isImage = PhoneAskContract.imageMimes.contains(attachment.mime)
            guard isImage || PhoneAskContract.fileMimes.contains(attachment.mime) else { throw ShareInputError.unsupported }
            let limit = Int64(isImage ? PhoneAskContract.ShareLimits.imageMaxBytes : PhoneAskContract.ShareLimits.fileMaxBytes)
            let (count, hash) = try digest(attachment.url, limit: limit, image: isImage)
            total += count
            guard total <= PhoneAskContract.ShareLimits.maxShareBytes else { throw ShareInputError.fileTooLarge }
            items.append(try .init(n: index + 1, name: attachment.name, mime: attachment.mime, bytes: count, sha256: hash))
        }
        let manifest = try PhoneAskContract.ShareManifest(shareId: shareId, botId: target.botId, threadId: target.threadId,
                                                          note: note, text: text, url: url, items: items)
        // S36 hashes recursively sorted JSON; item digests are fields of the manifest.
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let fingerprint = SHA256.hash(data: try encoder.encode(manifest)).map { String(format: "%02x", $0) }.joined()
        let state = ShareOutboxState(shareId: shareId, workspace: ShareTargetCache.workspace(origin), target: target,
                                    fingerprint: fingerprint, createdAt: now, state: .queued)
        let folder = root.appendingPathComponent("outbox").appendingPathComponent(shareId)
        // Never replace a previously queued share or its body.
        try ShareFiles.createDirectory(at: folder.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard !FileManager.default.fileExists(atPath: folder.path) else { throw ShareInputError.invalid }
        try ShareFiles.createDirectory(at: folder, withIntermediateDirectories: false)
        do {
            let body = folder.appendingPathComponent("body")
            try write(manifest: manifest, boundary: boundary(shareId: shareId), body: body, urls: attachments.map(\.url))
            #if os(iOS)
            // A transfer already started may finish after lock. New sends still
            // need an unlocked-keychain read immediately before scheduling.
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: body.path)
            #endif
            try ShareFiles.atomic(encoder.encode(state), to: folder.appendingPathComponent("state.json"))
            return Prepared(body: body, state: state, boundary: boundary(shareId: shareId))
        } catch {
            try? FileManager.default.removeItem(at: folder)
            throw error
        }
    }
    /// Also exercised against phone-ask.json's literal multipart body.
    public static func write(manifest: PhoneAskContract.ShareManifest, boundary: String, body: URL, urls: [URL]) throws {
        let temporary = body.deletingLastPathComponent().appendingPathComponent(".body-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: temporary) }
        guard let output = OutputStream(url: temporary, append: false) else { throw ShareInputError.invalid }
        output.open()
        do {
            try ShareFiles.excludeFromBackup(temporary)
            try ShareMultipartWriter.write(manifest: manifest, boundary: boundary, to: output) { item in
                guard urls.indices.contains(item.n - 1), let stream = InputStream(url: urls[item.n - 1]) else { throw ShareInputError.invalid }
                return stream
            }
            output.close()
            try FileManager.default.moveItem(at: temporary, to: body)
        } catch { output.close(); throw error }
    }
    private static func digest(_ url: URL, limit: Int64, image: Bool) throws -> (Int64, String) {
        guard let stream = InputStream(url: url) else { throw ShareInputError.invalid }
        stream.open(); defer { stream.close() }
        var bytes = [UInt8](repeating: 0, count: 32 * 1024), count: Int64 = 0, hash = SHA256()
        while true {
            let n = stream.read(&bytes, maxLength: bytes.count)
            guard n >= 0 else { throw stream.streamError ?? ShareInputError.invalid }
            if n == 0 { break }
            count += Int64(n)
            guard count <= limit else { throw image ? ShareInputError.photoTooLarge : ShareInputError.fileTooLarge }
            hash.update(data: Data(bytes.prefix(n)))
        }
        return (count, hash.finalize().map { String(format: "%02x", $0) }.joined())
    }
}

extension ShareBodyFile {
    /// Recover our own manifest-first body without loading attachments into memory.
    /// The existing writer revalidates hashes, limits and names for the new send.
    public static func reprepare(root: URL, previous: ShareOutboxState, origin: WorkspaceOrigin,
                                 target: ShareOutboxState.Target, now: Int64) throws -> Prepared {
        guard PhoneAskContract.matches(previous.shareId, "[A-Za-z0-9_-]{16,80}") else { throw ShareInputError.invalid }
        let folder = root.appendingPathComponent("outbox").appendingPathComponent(previous.shareId)
        let reader = try BodyReader(folder.appendingPathComponent("body"))
        defer { reader.close() }
        let oldBoundary = boundary(shareId: previous.shareId)
        guard try reader.line(limit: 256) == "--" + oldBoundary,
              try reader.line(limit: 256) == "Content-Disposition: form-data; name=\"manifest\"",
              try reader.line(limit: 256) == "Content-Type: application/json",
              try reader.line(limit: 2).isEmpty else { throw ShareInputError.invalid }
        let manifest = try JSONDecoder().decode(PhoneAskContract.ShareManifest.self,
            from: Data(reader.line(limit: 8 * 1024 * 1024).utf8))
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let fingerprint = SHA256.hash(data: try encoder.encode(manifest)).map { String(format: "%02x", $0) }.joined()
        guard manifest.shareId == previous.shareId, fingerprint == previous.fingerprint else { throw ShareInputError.invalid }
        let staging = folder.appendingPathComponent(".retry-" + UUID().uuidString)
        try ShareFiles.createDirectory(at: staging, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: staging) }
        var attachments: [Attachment] = []
        for item in manifest.items {
            guard try reader.line(limit: 256) == "--" + oldBoundary,
                  try reader.line(limit: 2048) == "Content-Disposition: form-data; name=\"item-\(item.n)\"; filename=\"\(item.name)\"",
                  try reader.line(limit: 256) == "Content-Type: \(item.mime)",
                  try reader.line(limit: 2).isEmpty else { throw ShareInputError.invalid }
            let file = staging.appendingPathComponent(String(item.n))
            try reader.copy(bytes: item.bytes, sha256: item.sha256, to: file)
            guard try reader.line(limit: 2).isEmpty else { throw ShareInputError.invalid }
            attachments.append(.init(url: file, name: item.name, mime: item.mime))
        }
        guard try reader.line(limit: 256) == "--" + oldBoundary + "--" else { throw ShareInputError.invalid }
        return try prepare(root: root, origin: origin, target: target, shareId: UUID().uuidString,
                           note: manifest.note, text: manifest.text, url: manifest.url, attachments: attachments, now: now)
    }

    private final class BodyReader {
        let file: FileHandle
        var buffer = Data()
        init(_ url: URL) throws { file = try FileHandle(forReadingFrom: url) }
        func close() { try? file.close() }
        func fill() throws {
            let data = try file.read(upToCount: 32 * 1024) ?? Data()
            guard !data.isEmpty else { throw ShareInputError.invalid }
            buffer.append(data)
        }
        func line(limit: Int) throws -> String {
            let end = Data([13, 10])
            while true {
                if let range = buffer.range(of: end) {
                    guard buffer.distance(from: buffer.startIndex, to: range.lowerBound) <= limit,
                          let result = String(data: buffer[..<range.lowerBound], encoding: .utf8) else { throw ShareInputError.invalid }
                    buffer = Data(buffer[range.upperBound...])
                    return result
                }
                guard buffer.count <= limit else { throw ShareInputError.invalid }
                try fill()
            }
        }
        func copy(bytes: Int64, sha256: String, to url: URL) throws {
            guard bytes >= 0, bytes <= PhoneAskContract.ShareLimits.fileMaxBytes,
                  FileManager.default.createFile(atPath: url.path, contents: nil) else { throw ShareInputError.invalid }
            try ShareFiles.excludeFromBackup(url)
            let output = try FileHandle(forWritingTo: url)
            defer { try? output.close() }
            var remaining = bytes
            var hash = SHA256()
            while remaining > 0 {
                if buffer.isEmpty { try fill() }
                let count = min(buffer.count, Int(remaining))
                let chunk = buffer.prefix(count)
                hash.update(data: chunk)
                try output.write(contentsOf: chunk)
                buffer = Data(buffer.dropFirst(count)); remaining -= Int64(count)
            }
            guard hash.finalize().map({ String(format: "%02x", $0) }).joined() == sha256 else { throw ShareInputError.invalid }
        }
    }
}
