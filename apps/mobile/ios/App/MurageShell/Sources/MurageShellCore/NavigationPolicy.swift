import Foundation

/// Which frame a navigation would load in. A new window is window.open or a
/// target=_blank link (WKUIDelegate createWebViewWith); Android turns those
/// into main-frame navigations, so only iOS asks about one.
public enum NavigationTarget: String, Sendable {
    case mainFrame = "main", subframe = "sub", newWindow
}

public enum NavigationDecision: String, Sendable {
    /// Load it where it was going.
    case allow
    /// Load nothing.
    case cancel
    /// Load nothing here; hand the URL to the openExternal rule, which lets
    /// out only http, https, tel and mailto without an attachment.
    case sendOut
    /// A new window on the saved origin: load it in the workspace itself,
    /// since the system browser has no session (Plan 1 note 9).
    case openHere
}

/// Where the workspace WebView may go (final review I3): the rule that keeps
/// a foreign page out of the workspace, pure so both suites drive it from
/// contract/navigation.json. The oracle is `navigationDecision` in
/// src/lib/native-contract.test.ts; NavigationPolicy.java is the twin. The
/// WebView glue only maps the decision.
///   1. the scheme is `^[A-Za-z][A-Za-z0-9+.-]*:`, case-insensitive
///   2. a new window on the saved origin opens here; anything else goes out
///   3. about: only in a frame, and only about:blank and about:srcdoc (an
///      empty iframe and the web UI's srcDoc previews); the main frame never
///      shows an about: page, which a foreign frame could leave blank (M7)
///   4. blob: and data: in a frame are the CSP's business; the main frame
///      never shows data:, and blob: only when the saved origin made it
///   5. http and https in a frame are the CSP's business (frame-src); the
///      main frame stays on the saved origin and anything else goes out
///   6. any other scheme goes out from the main frame, and a frame loads nothing
public enum NavigationPolicy {
    public static func decide(_ url: String, target: NavigationTarget, saved: WorkspaceOrigin) -> NavigationDecision {
        if target == .newWindow { return WorkspaceOrigin(string: url) == saved ? .openHere : .sendOut }
        let main = target == .mainFrame
        switch scheme(url) {
        case "about":
            let whole = url.lowercased()
            return !main && (whole == "about:blank" || whole == "about:srcdoc") ? .allow : .cancel
        case "blob":
            return !main || WorkspaceOrigin(string: String(url.dropFirst("blob:".count))) == saved ? .allow : .cancel
        case "data":
            return main ? .cancel : .allow
        case "https", "http":
            return !main || WorkspaceOrigin(string: url) == saved ? .allow : .sendOut
        default:
            return main ? .sendOut : .cancel
        }
    }

    /// Camera and microphone: only the saved origin, and never a frame.
    /// `isMainFrame` is nil where the platform names no frame (Android's
    /// PermissionRequest), and there the origin decides alone (M8, Plan 3).
    public static func mayCapture(requester: WorkspaceOrigin?, isMainFrame: Bool?, saved: WorkspaceOrigin) -> Bool {
        requester == saved && isMainFrame != false
    }

    /// Step 1, lower-cased; "" when the text has no scheme.
    static func scheme(_ url: String) -> String {
        let scalars = url.unicodeScalars
        guard let colon = scalars.firstIndex(of: ":"), colon != scalars.startIndex else { return "" }
        let name = scalars[scalars.startIndex..<colon]
        guard let first = name.first, first.isASCII, first.properties.isAlphabetic,
              name.allSatisfy({ $0.isASCII && ($0.properties.isAlphabetic || ("0"..."9").contains($0) || "+.-".unicodeScalars.contains($0)) })
        else { return "" }
        return String(String.UnicodeScalarView(name)).lowercased()
    }
}
