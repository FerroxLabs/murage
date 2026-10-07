import Foundation

/// `murageNative.saveFile(request)`, exactly src/lib/save-file.ts NativeSaveRequest.
public enum SaveRequest: Equatable {
    case url(URL, filename: String)
    case begin(id: String, filename: String, mime: String, size: Int)
    case chunk(id: String, index: Int, base64: String)
    case end(id: String)
    case abort(id: String)

    /// save-file.ts NATIVE_SAVE_CHUNK_BYTES and NATIVE_SAVE_MAX_BYTES.
    public static let chunkBytes = 1_048_576
    public static let maxBytes = 26_214_400
    /// Base64 of one full chunk: 4 × ceil(chunkBytes / 3).
    static let maxBase64 = 1_398_104

    public static func parse(_ args: [String: Any], origin: WorkspaceOrigin) -> Result<SaveRequest, ChannelError> {
        guard let kind = args["kind"] as? String else { return .failure(.badArgs) }
        switch kind {
        case "url":
            guard let raw = ChannelArgs.string(args["url"], max: 8192),
                  let filename = ChannelArgs.string(args["filename"], max: 1024) else { return .failure(.badArgs) }
            // Clean and absolute before any parser sees it: URL(string:) would
            // percent-encode a "\" and could read what precedes it as userinfo.
            // save-file.ts always sends an absolute URL; a relative one is a bug.
            guard !raw.unicodeScalars.contains(where: WorkspaceOrigin.unsafe), ChannelArgs.splitScheme(raw) != nil,
                  let url = URL(string: raw) else { return .failure(.badArgs) }
            // Native downloads with the WebView's cookie: never for another
            // origin. blob:, data: and userinfo URLs are never on it (R3).
            guard WorkspaceOrigin(string: raw) == origin, origin.contains(url) else { return .failure(.foreignURL) }
            return .success(.url(url, filename: FileNames.safe(filename)))
        case "begin":
            guard let id = transferId(args["id"]), let filename = ChannelArgs.string(args["filename"], max: 1024),
                  let mime = ChannelArgs.string(args["mime"], max: 255), let size = ChannelArgs.int(args["size"]), size >= 0
            else { return .failure(.badArgs) }
            guard size <= maxBytes else { return .failure(.tooLarge) }
            return .success(.begin(id: id, filename: FileNames.safe(filename), mime: mime, size: size))
        case "chunk":
            guard let id = transferId(args["id"]), let index = ChannelArgs.int(args["index"]), index >= 0,
                  let base64 = args["base64"] as? String else { return .failure(.badArgs) }
            // UTF-16 units, as the page and Java count a string's length.
            guard base64.utf16.count <= maxBase64 else { return .failure(.tooLarge) }
            return .success(.chunk(id: id, index: index, base64: base64))
        case "end":
            guard let id = transferId(args["id"]) else { return .failure(.badArgs) }
            return .success(.end(id: id))
        case "abort":
            guard let id = transferId(args["id"]) else { return .failure(.badArgs) }
            return .success(.abort(id: id))
        default:
            return .failure(.badArgs)
        }
    }

    private static func transferId(_ value: Any?) -> String? {
        guard let id = ChannelArgs.string(value, max: 128), !id.isEmpty else { return nil }
        return id
    }
}

/// The name a saved file gets on disk. The rule is safeFileName in
/// src/lib/native-contract.test.ts (apps/mobile/contract/filenames.json),
/// applied to Unicode scalars, never to Characters:
///   1. the last non-empty component after splitting on "/" and "\"
///   2. drop Cc, Cf, Cs, Zl, Zp and each of " * < > ? | :
///   3. each run of Zs becomes one U+0020
///   4. until stable: trim U+0020 at both ends, then drop leading "."
///   5. over 200 UTF-8 bytes: keep a 1–10 ASCII alphanumeric extension, cut
///      the stem at a scalar boundary to fit, then drop trailing " " and "."
///      from it ("download" if nothing is left)
///   6. empty → "download"
/// Accepted twin difference: WebKit hands the channel a lone surrogate as
/// U+FFFD (So), which is kept here; Java sees the real lone surrogate (Cs)
/// and drops it. A Swift String cannot hold a lone surrogate at all.
public enum FileNames {
    /// The file `filename` directly inside `directory`, or nil when the name
    /// is not one plain path component that lands there (Android's CacheSink
    /// check; final review M1). `safe` already guarantees this; the sink
    /// checks again rather than trust every caller to have run it.
    public static func contained(_ filename: String, in directory: URL) -> URL? {
        guard !filename.isEmpty, filename != ".", filename != ".." else { return nil }
        let file = directory.appendingPathComponent(filename, isDirectory: false)
        guard file.lastPathComponent == filename,
              file.deletingLastPathComponent().standardizedFileURL.path == directory.standardizedFileURL.path else { return nil }
        return file
    }

    static let maxBytes = 200
    private static let reserved = Set("\"*<>?|:".unicodeScalars)

    public static func safe(_ raw: String) -> String {
        let last = raw.unicodeScalars.split { $0 == "/" || $0 == "\\" }.last ?? Substring.UnicodeScalarView()

        var name: [Unicode.Scalar] = []
        var inSpaces = false
        for scalar in last {
            switch scalar.properties.generalCategory {
            case .control, .format, .surrogate, .lineSeparator, .paragraphSeparator:
                continue
            case .spaceSeparator:
                if !inSpaces { name.append(" ") }
                inSpaces = true
                continue
            default:
                if reserved.contains(scalar) { continue }
            }
            inSpaces = false
            name.append(scalar)
        }

        var before: [Unicode.Scalar]? = nil
        while name != before {
            before = name
            while name.first == " " { name.removeFirst() }
            while name.last == " " { name.removeLast() }
            while name.first == "." { name.removeFirst() }
        }

        if bytes(name) > maxBytes { name = cut(name) }
        return name.isEmpty ? "download" : String(String.UnicodeScalarView(name))
    }

    private static func cut(_ name: [Unicode.Scalar]) -> [Unicode.Scalar] {
        let run = name.reversed().prefix { $0.isASCII && ($0.properties.isAlphabetic || ("0"..."9").contains($0)) }.count
        let hasExtension = (1...10).contains(run) && name.count > run && name[name.count - run - 1] == "."
        let extensionLength = hasExtension ? run + 1 : 0
        let budget = maxBytes - extensionLength // the extension is ASCII

        var stem: [Unicode.Scalar] = []
        var used = 0
        for scalar in name.dropLast(extensionLength) {
            let size = scalar.utf8.count
            if used + size > budget { break }
            used += size
            stem.append(scalar)
        }
        while stem.last == " " || stem.last == "." { stem.removeLast() }
        return (stem.isEmpty ? Array("download".unicodeScalars) : stem) + name.suffix(extensionLength)
    }

    private static func bytes(_ scalars: [Unicode.Scalar]) -> Int {
        scalars.reduce(0) { $0 + $1.utf8.count }
    }
}

/// Plan 1 note 5: a non-2xx download is a failed save, never a file.
public enum DownloadGate {
    public static func accept(status: Int?) -> Bool {
        guard let status else { return true }
        return (200..<300).contains(status)
    }
}
