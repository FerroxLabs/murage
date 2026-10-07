package com.murage.mobile.shell;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Where the workspace WebView may go (final review I3): the rule that keeps a
 * foreign page out of the workspace, pure so JUnit drives it from
 * contract/navigation.json. The oracle is navigationDecision in
 * src/lib/native-contract.test.ts; NavigationPolicy.swift is the twin. The
 * WebView glue only maps the decision.
 * <ol>
 *   <li>the scheme is {@code ^[A-Za-z][A-Za-z0-9+.-]*:}, case-insensitive
 *   <li>a new window on the saved origin opens here; anything else goes out
 *   <li>about: only in a frame, and only about:blank and about:srcdoc (an empty
 *       iframe and the web UI's srcDoc previews); the main frame never shows an
 *       about: page, which a foreign frame could leave blank (M7)
 *   <li>blob: and data: in a frame are the CSP's business; the main frame never
 *       shows data:, and blob: only when the saved origin made it
 *   <li>http and https in a frame are the CSP's business (frame-src); the main
 *       frame stays on the saved origin and anything else goes out
 *   <li>any other scheme goes out from the main frame, and a frame loads nothing
 * </ol>
 */
public final class NavigationPolicy {
    /** Android turns window.open and target=_blank into main-frame navigations, so only iOS asks about NEW_WINDOW. */
    public enum Target { MAIN_FRAME, SUBFRAME, NEW_WINDOW }

    public enum Decision {
        /** Load it where it was going. */
        ALLOW,
        /** Load nothing. */
        CANCEL,
        /** Load nothing here; hand the URL to the openExternal rule (ChannelArgs.externalUrl). */
        SEND_OUT,
        /** A new window on the saved origin: load it in the workspace, since the system browser has no session. */
        OPEN_HERE
    }

    private static final Pattern SCHEME = Pattern.compile("([A-Za-z][A-Za-z0-9+.-]*):.*", Pattern.DOTALL);

    private NavigationPolicy() {}

    public static Decision decide(String url, Target target, WorkspaceOrigin saved) {
        if (url == null) return target == Target.MAIN_FRAME ? Decision.SEND_OUT : Decision.CANCEL;
        if (target == Target.NEW_WINDOW) return saved.contains(url) ? Decision.OPEN_HERE : Decision.SEND_OUT;
        boolean main = target == Target.MAIN_FRAME;
        switch (scheme(url)) {
            case "about": {
                String whole = url.toLowerCase(Locale.ROOT);
                return !main && (whole.equals("about:blank") || whole.equals("about:srcdoc")) ? Decision.ALLOW : Decision.CANCEL;
            }
            case "blob":
                return !main || saved.contains(url.substring("blob:".length())) ? Decision.ALLOW : Decision.CANCEL;
            case "data":
                return main ? Decision.CANCEL : Decision.ALLOW;
            case "https":
            case "http":
                return !main || saved.contains(url) ? Decision.ALLOW : Decision.SEND_OUT;
            default:
                return main ? Decision.SEND_OUT : Decision.CANCEL;
        }
    }

    /**
     * Camera and microphone: only the saved origin, and never a frame.
     * isMainFrame is null where the platform names no frame (Android's
     * PermissionRequest), and there the origin decides alone (M8, Plan 3).
     */
    public static boolean mayCapture(String requester, Boolean isMainFrame, WorkspaceOrigin saved) {
        return requester != null && saved.equals(WorkspaceOrigin.parse(requester)) && !Boolean.FALSE.equals(isMainFrame);
    }

    /** A failed load closes the workspace only when it is the workspace's own main document (M3). */
    public static boolean isOwnMainDocument(String url, boolean isMainFrame, WorkspaceOrigin saved) {
        return isMainFrame && url != null && saved.contains(url);
    }

    /** Step 1, lower-cased; "" when the text has no scheme. */
    static String scheme(String url) {
        Matcher matcher = SCHEME.matcher(url);
        return matcher.matches() ? matcher.group(1).toLowerCase(Locale.ROOT) : "";
    }
}
