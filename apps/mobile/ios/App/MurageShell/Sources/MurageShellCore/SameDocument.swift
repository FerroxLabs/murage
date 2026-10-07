import Foundation

/// Twin of SameDocument.java. A load whose target differs from the page's
/// URL only by the fragment is a same-document navigation in WebKit: no new
/// document, so the page never calls ready() again and the splash stays up
/// (device finding, 2026-09-28: a notification tap over a page already at "/").
public enum SameDocument {
    /// True when current and target are the same URL once the fragment is dropped.
    /// Compared byte for byte: a WebView that reports the URL encoded
    /// differently only costs the plain load this replaces.
    public static func of(current: URL?, target: URL) -> Bool {
        guard let current else { return false }
        return withoutFragment(current) == withoutFragment(target)
    }

    /// Moves the page to target without a hashchange, then boots a fresh
    /// document there. Answers false when it could not (an error page, a
    /// foreign origin), so the caller loads as before.
    public static func reloadScript(target: URL) -> String {
        "(function(){try{history.replaceState(null, '', " + ChannelScript.javaScriptString(target.absoluteString)
            + ");location.reload();return true}catch(e){return false}})()"
    }

    private static func withoutFragment(_ url: URL) -> String {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url.absoluteString }
        parts.fragment = nil
        return parts.string ?? url.absoluteString
    }
}
