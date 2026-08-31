import Foundation

/// An attachment encoded in a stored user prompt. Agents receive local paths,
/// but people should see a quiet attachment label rather than the transport
/// tag that carries that path.
public struct DisplayedMessageAttachment: Hashable, Sendable {
    public enum Kind: Hashable, Sendable {
        case image
        case file
    }

    public let kind: Kind
    public let name: String

    public init(kind: Kind, name: String) {
        self.kind = kind
        self.name = name
    }
}

public struct AttachedMessageContent: Hashable, Sendable {
    public let text: String
    public let attachments: [DisplayedMessageAttachment]

    public init(text: String, attachments: [DisplayedMessageAttachment]) {
        self.text = text
        self.attachments = attachments
    }

    /// Splits only the exact, standalone tags OpenMausBot writes. An inline
    /// example in somebody's prose stays prose instead of disappearing.
    public static func parse(_ source: String) -> AttachedMessageContent {
        let range = NSRange(source.startIndex..<source.endIndex, in: source)
        let matches = tagExpression.matches(in: source, range: range)
        let attachments = matches.compactMap { match -> DisplayedMessageAttachment? in
            guard
                let kindRange = Range(match.range(at: 1), in: source),
                let pathRange = Range(match.range(at: 2), in: source)
            else { return nil }

            let kind: DisplayedMessageAttachment.Kind = source[kindRange] == "image" ? .image : .file
            let path = decodeAttribute(String(source[pathRange]))
            let providedName: String?
            if match.range(at: 3).location != NSNotFound,
               let nameRange = Range(match.range(at: 3), in: source) {
                providedName = decodeAttribute(String(source[nameRange]))
            } else {
                providedName = nil
            }
            return DisplayedMessageAttachment(
                kind: kind,
                name: displayName(providedName: providedName, path: path, kind: kind)
            )
        }

        let stripped = tagExpression
            .stringByReplacingMatches(in: source, range: range, withTemplate: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return AttachedMessageContent(text: stripped, attachments: attachments)
    }

    private static let tagExpression = try! NSRegularExpression(
        pattern: #"(?m)^[\t ]*<attached-(image|file)[\t ]+path="([^"\r\n]*)"(?:[\t ]+name="([^"\r\n]*)")?[\t ]*/>[\t ]*(?:\r?\n)?"#
    )

    private static func decodeAttribute(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&#9;", with: "\t")
            .replacingOccurrences(of: "&#10;", with: "\n")
            .replacingOccurrences(of: "&#13;", with: "\r")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    private static func displayName(
        providedName: String?,
        path: String,
        kind: DisplayedMessageAttachment.Kind
    ) -> String {
        let fallback = path.components(separatedBy: CharacterSet(charactersIn: "/\\"))
            .last(where: { !$0.isEmpty })
        let candidate = providedName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let value = (candidate?.isEmpty == false ? candidate : fallback) ?? (kind == .image ? "Image" : "File")
        let oneLine = value.unicodeScalars.map { scalar in
            let code = scalar.value
            let isBidiControl = (0x202A...0x202E).contains(code) || (0x2066...0x2069).contains(code)
            return CharacterSet.controlCharacters.contains(scalar) || isBidiControl ? " " : String(scalar)
        }.joined()
        return String(oneLine.prefix(180))
    }
}
