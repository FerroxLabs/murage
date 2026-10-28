import Foundation

/// Builds the activation predicate from the repository fixture. Unit tests
/// pin the checked-in extension plist to this result; no build script is needed.
public struct ShareTypePolicy: Decodable {
    public struct FileType: Decodable, Equatable {
        public let mime: String
        public let uti: String
        public let ext: String
    }
    public let images: [String]
    public let imageUtis: [String: String]
    public let files: [FileType]
    public var supportedIdentifiers: [String] {
        Array(Set(images.compactMap { imageUtis[$0] } + files.map(\.uti) + ["public.heic", "public.heif"])).sorted()
    }
    public var activationPredicate: String {
        let clauses = supportedIdentifiers.map { "ANY $a.registeredTypeIdentifiers UTI-CONFORMS-TO \"\($0)\"" }
        let url = "(ANY $a.registeredTypeIdentifiers UTI-CONFORMS-TO \"public.url\" AND NOT (ANY $a.registeredTypeIdentifiers UTI-CONFORMS-TO \"public.file-url\"))"
        return "SUBQUERY(extensionItems, $item, SUBQUERY($item.attachments, $a, (\((clauses + [url]).joined(separator: " OR "))) AND NOT (ANY $a.registeredTypeIdentifiers UTI-CONFORMS-TO \"public.audiovisual-content\")).@count == $item.attachments.@count).@count == extensionItems.@count AND SUBQUERY(extensionItems, $item, $item.attachments.@count > 0).@count >= 1"
    }
    public func accepts(_ identifiers: [String], conforms: (String, String) -> Bool) -> Bool {
        guard !identifiers.contains(where: { conforms($0, "public.audiovisual-content") }) else { return false }
        if identifiers.contains(where: { type in supportedIdentifiers.contains { conforms(type, $0) } }) { return true }
        return identifiers.contains { conforms($0, "public.url") } && !identifiers.contains { conforms($0, "public.file-url") }
    }
    public static func checkCount(_ count: Int) throws {
        guard count > 0 else { throw ShareInputError.unsupported }
        guard count <= PhoneAskContract.ShareLimits.maxItems else { throw ShareInputError.tooMany }
    }
}
