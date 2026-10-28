import CryptoKit
import Foundation

/// Manifest first, then item-1...item-n. The caller owns and opens/closes the output;
/// each input returned by openItem is opened and closed here. File streams keep memory bounded.
/// On failure the caller must discard the partial output file, never upload it.
public enum ShareMultipartWriter {
    private typealias C = PhoneAskContract

    public static func contentType(boundary: String) throws -> String {
        guard C.matches(boundary, "[0-9A-Za-z'()+_,./:=?-]{1,70}") else { throw C.ContractError.invalid }
        return "multipart/form-data; boundary=\(boundary)"
    }

    public static func write(manifest: PhoneAskContract.ShareManifest, boundary: String, to output: OutputStream,
                             openItem: (PhoneAskContract.ShareItem) throws -> InputStream) throws {
        _ = try contentType(boundary: boundary)
        // Encoding validates every item's name length, media type and size before any I/O.
        _ = try JSONEncoder().encode(manifest)
        for item in manifest.items {
            guard item.name != ".", item.name != "..",
                  item.name.unicodeScalars.allSatisfy({ scalar in
                      let value = scalar.value
                      return value >= 0x20 && !(0x7f...0x9f).contains(value)
                          && value != 0x22 && value != 0x2f && value != 0x5c
                  }) else { throw C.ContractError.invalid }
        }
        try write(Data(("--\(boundary)\r\nContent-Disposition: form-data; name=\"manifest\"\r\nContent-Type: application/json\r\n\r\n"
                        + manifestJSON(manifest) + "\r\n").utf8), to: output)
        for item in manifest.items {
            try write(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"item-\(item.n)\"; filename=\"\(item.name)\"\r\nContent-Type: \(item.mime)\r\n\r\n".utf8), to: output)
            let input = try openItem(item)
            input.open()
            defer { input.close() }
            var buffer = [UInt8](repeating: 0, count: 32 * 1024)
            var count: Int64 = 0
            var hash = SHA256()
            while true {
                let read = input.read(&buffer, maxLength: buffer.count)
                guard read >= 0 else {
                    if let error = input.streamError { throw error }
                    throw C.ContractError.invalid
                }
                if read == 0 { break }
                guard Int64(read) <= item.bytes - count else { throw C.ContractError.invalid }
                count += Int64(read)
                let chunk = Data(buffer.prefix(read))
                hash.update(data: chunk)
                try write(chunk, to: output)
            }
            guard count == item.bytes,
                  hash.finalize().map({ String(format: "%02x", $0) }).joined() == item.sha256 else { throw C.ContractError.invalid }
            try write(Data("\r\n".utf8), to: output)
        }
        try write(Data("--\(boundary)--\r\n".utf8), to: output)
    }

    private static func write(_ data: Data, to output: OutputStream) throws {
        try data.withUnsafeBytes { raw in
            guard let bytes = raw.bindMemory(to: UInt8.self).baseAddress else { return }
            var offset = 0
            while offset < data.count {
                let written = output.write(bytes.advanced(by: offset), maxLength: data.count - offset)
                guard written > 0 else {
                    if let error = output.streamError { throw error }
                    throw C.ContractError.invalid
                }
                offset += written
            }
        }
    }

    /// Explicit field order: Codable/JSON dictionary order is not a wire guarantee.
    private static func manifestJSON(_ m: C.ShareManifest) throws -> String {
        func quote(_ value: String) throws -> String {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.withoutEscapingSlashes]
            return String(decoding: try encoder.encode(value), as: UTF8.self)
        }
        var fields = try ["\"shareId\":" + quote(m.shareId), "\"botId\":" + quote(m.botId), "\"threadId\":" + quote(m.threadId)]
        if let note = m.note { fields.append(try "\"note\":" + quote(note)) }
        if let text = m.text { fields.append(try "\"text\":" + quote(text)) }
        if let url = m.url { fields.append(try "\"url\":" + quote(url)) }
        let items = try m.items.map { item in
            try "{\"n\":\(item.n),\"name\":" + quote(item.name) + ",\"mime\":" + quote(item.mime)
                + ",\"bytes\":\(item.bytes),\"sha256\":" + quote(item.sha256) + "}"
        }
        fields.append("\"items\":[" + items.joined(separator: ",") + "]")
        return "{" + fields.joined(separator: ",") + "}"
    }
}
