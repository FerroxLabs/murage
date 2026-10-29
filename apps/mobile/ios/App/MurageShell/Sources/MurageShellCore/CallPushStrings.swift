import Foundation

/// Localized presentation; the contract twin keeps its exact English wire copy.
public enum CallPushStrings {
    public static func text(_ key: String) -> String {
        Bundle.module.localizedString(forKey: key, value: nil, table: nil)
    }
    public static func closed(_ category: PushCategory) -> (title: String, body: String) {
        switch category {
        case .call: (text("push_call_title"), text("push_call_body"))
        case .callNote: ("Murage", text("push_call_note_body"))
        default: category.generic
        }
    }
}
