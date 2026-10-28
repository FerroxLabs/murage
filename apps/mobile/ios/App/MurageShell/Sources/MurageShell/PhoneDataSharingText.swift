import Foundation

/// Untrusted display names stay on their own plain line, outside the warning.
enum PhoneDataSharingText {
    static var warning: String { PhoneJobStrings.text("phone_sharing_generic") }

    static func providerLine(_ name: String) -> String {
        let value = plain(name, limit: 120)
        return value.isEmpty ? PhoneJobStrings.text("phone_provider_fallback") : value
    }

    /// Offer schema limits count UTF-16 units. Never split a surrogate pair.
    static func plain(_ text: String, limit: Int, lineBreaks: Int = 0) -> String {
        var value = "", units = 0, breaks = 0
        for scalar in text.unicodeScalars {
            if scalar == "\n", breaks < lineBreaks {
                breaks += 1
            } else {
                switch scalar.properties.generalCategory {
                case .control, .format, .lineSeparator, .paragraphSeparator: continue
                default: break
                }
            }
            let width = scalar.value > 0xffff ? 2 : 1
            guard units + width <= limit else { break }
            value.unicodeScalars.append(scalar); units += width
        }
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func message(providerName: String?, workspaceName: String? = nil) -> String {
        var message = warning
        if let providerName { message += "\n\n" + String(format: PhoneJobStrings.text("phone_provider_label"), providerLine(providerName)) }
        if let workspaceName { message += "\n\n" + plain(workspaceName, limit: 120) }
        return message
    }
}
