#if os(iOS)
import Foundation
import UniformTypeIdentifiers

/// Serial provider loading bounds peak image memory to one thumbnail. Provider
/// URLs expire when the completion handler returns, so copy inside that handler.
public enum ShareItemLoader {
    public struct Payload: Sendable {
        public var text: String?
        public var url: String?
        public var attachments: [ShareBodyFile.Attachment] = []
        public var preview: String { url ?? text ?? attachments.first?.name ?? "" }
    }
    public static func load(_ providers: [NSItemProvider], policy: ShareTypePolicy, directory: URL) async throws -> Payload {
        try ShareTypePolicy.checkCount(providers.count)
        try ShareFiles.createDirectory(at: directory.deletingLastPathComponent())
        try ShareFiles.createDirectory(at: directory)
        var payload = Payload()
        for provider in providers {
            try Task.checkCancellation()
            let types = provider.registeredTypeIdentifiers
            guard policy.accepts(types, conforms: conforms) else { throw ShareInputError.unsupported }
            let imageTypes = policy.images.compactMap { policy.imageUtis[$0] } + ["public.heic", "public.heif"]
            if let imageType = imageTypes.first(where: { provider.hasItemConformingToTypeIdentifier($0) }) {
                let input = try await file(provider, type: imageType, directory: directory)
                let output = directory.appendingPathComponent(UUID().uuidString + ".jpg")
                try ShareImagePreparation.prepare(source: input, destination: output, expectedType: imageType)
                try? FileManager.default.removeItem(at: input)
                payload.attachments.append(.init(url: output, name: cleanName(provider.suggestedName, fallback: "image") + ".jpg", mime: "image/jpeg"))
            } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                      !types.contains(where: { conforms($0, UTType.fileURL.identifier) }) {
                let item = try await value(provider, type: UTType.url.identifier)
                guard let link = (item as? URL) ?? (item as? String).flatMap(URL.init(string:)),
                      ["http", "https"].contains(link.scheme?.lowercased() ?? ""), !link.isFileURL else { throw ShareInputError.unsupported }
                // The wire has one URL field; preserve additional links as text.
                if payload.url == nil { payload.url = link.absoluteString }
                else { try append(link.absoluteString, to: &payload) }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                      provider.suggestedName == nil,
                      !types.contains(where: { conforms($0, UTType.fileURL.identifier) }) {
                let item = try await value(provider, type: UTType.plainText.identifier)
                guard let text = item as? String else { throw ShareInputError.unsupported }
                try append(text, to: &payload)
            } else if let fileType = policy.files.reversed().first(where: { provider.hasItemConformingToTypeIdentifier($0.uti) }) {
                let input = try await file(provider, type: fileType.uti, directory: directory)
                let actual = try input.resourceValues(forKeys: [.contentTypeKey]).contentType
                guard let actual, let wanted = UTType(fileType.uti), actual.conforms(to: wanted),
                      !actual.conforms(to: .audiovisualContent) else { throw ShareInputError.unsupported }
                payload.attachments.append(.init(url: input, name: cleanName(provider.suggestedName ?? input.lastPathComponent, fallback: "file"), mime: fileType.mime))
            } else { throw ShareInputError.unsupported }
        }
        try Task.checkCancellation()
        return payload
    }
    private static func conforms(_ actual: String, _ expected: String) -> Bool {
        if actual == expected { return true }
        guard let actual = UTType(actual), let expected = UTType(expected) else { return false }
        return actual.conforms(to: expected)
    }
    private static func append(_ text: String, to payload: inout Payload) throws {
        let joined = [payload.text, text].compactMap { $0 }.joined(separator: "\n")
        guard joined.utf16.count <= 1_048_576 else { throw ShareInputError.invalid }
        payload.text = joined
    }
    private static func cleanName(_ name: String?, fallback: String) -> String {
        let text = (name ?? fallback).unicodeScalars.filter { $0.value >= 0x20 && ![0x22, 0x2f, 0x5c].contains($0.value) && !(0x7f...0x9f).contains($0.value) }
        let result = String(String.UnicodeScalarView(text)).prefix(120)
        return result.isEmpty || result == "." || result == ".." ? fallback : String(result)
    }
    private static func value(_ provider: NSItemProvider, type: String) async throws -> NSSecureCoding {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type, options: nil) { item, error in
                if let error { continuation.resume(throwing: error) }
                else if let item { continuation.resume(returning: item) }
                else { continuation.resume(throwing: ShareInputError.unsupported) }
            }
        }
    }
    private static func file(_ provider: NSItemProvider, type: String, directory: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                do {
                    if let error { throw error }
                    guard let url else { throw ShareInputError.unsupported }
                    let destination = directory.appendingPathComponent(UUID().uuidString + "-" + url.lastPathComponent)
                    // copyItem copies file-to-file, never materializes a document as Data.
                    try FileManager.default.copyItem(at: url, to: destination)
                    try ShareFiles.excludeFromBackup(destination)
                    continuation.resume(returning: destination)
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
}
#endif
