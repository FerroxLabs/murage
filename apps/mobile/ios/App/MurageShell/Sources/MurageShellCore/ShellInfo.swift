import Foundation

public enum ShellInfo {
    /// `hello().version` (src/lib/native-shell.ts parseNativeHello needs an integer ≥ 1).
    public static let channelVersion = 1
    /// The user agent token both WebViews add (src/lib/native-shell.ts NATIVE_UA_TOKEN).
    public static func userAgentToken(version: String, platform: String) -> String {
        "MurageApp/\(version) (\(platform))"
    }
}
