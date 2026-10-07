import Foundation

/// The device's record of the page's `[call-diag]` / `[call-trace]` console
/// lines (channel method `diagLine`). One line per call, `ISO8601 <line>`,
/// appended to a single file that rotates at `maxBytes`, keeping one old file
/// (`<name>.1`). Callers serialise on one queue; this type does plain file I/O.
public struct DiagFile {
    public static let maxBytes = 2 * 1024 * 1024
    public static let fileName = "murage-call-diag.log"

    public let url: URL
    public let maxBytes: Int

    public init(url: URL, maxBytes: Int = DiagFile.maxBytes) {
        self.url = url
        self.maxBytes = maxBytes
    }

    public var oldURL: URL { url.appendingPathExtension("1") }

    public static func stamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    @discardableResult
    public func append(_ line: String, at date: Date = Date()) -> Bool {
        guard let data = (Self.stamp(date) + " " + line + "\n").data(using: .utf8) else { return false }
        let manager = FileManager.default
        let size = (try? manager.attributesOfItem(atPath: url.path))?[.size] as? Int ?? 0
        if size + data.count > maxBytes, size > 0 {
            try? manager.removeItem(at: oldURL)
            try? manager.moveItem(at: url, to: oldURL)
        }
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            // The throwing forms only: the legacy seekToEndOfFile()/write(_:)
            // raise an Objective-C exception on a full disk, which Swift cannot
            // catch and which would take the shell down.
            do {
                try handle.seekToEnd()
                try handle.write(contentsOf: data)
                return true
            } catch {
                return false
            }
        }
        return (try? data.write(to: url)) != nil
    }
}
