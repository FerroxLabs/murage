#if os(iOS)
import Foundation
import MurageShellCore

enum ShellEnvironment {
    static let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
    /// src/lib/native-shell.ts NATIVE_UA_TOKEN, as `MurageApp/<version> (ios)`.
    static let userAgentToken = ShellInfo.userAgentToken(version: appVersion, platform: "ios")
}
#endif
