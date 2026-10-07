package com.murage.mobile.shell;

import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

/** {@code /enter#<credential>[&installId=<id>]} (Plan 1 A5). Twin of PairingLink.swift. */
public final class PairingLink {
    private static final Pattern CREDENTIAL = Pattern.compile("[A-Za-z0-9_-]{1,512}");
    private static final Pattern INSTALL = Pattern.compile("[A-Za-z0-9._-]{16,128}");

    private static final Pattern APPROVAL_KEY = Pattern.compile("[A-Za-z0-9_-]{87}");
    private static final Pattern APPROVAL_STATEMENT = Pattern.compile("[A-Za-z0-9_-]{40,1200}\\.[A-Za-z0-9_-]{86}");

    private PairingLink() {}

    public static boolean validCredential(String value) {
        return value != null && CREDENTIAL.matcher(value).matches();
    }

    public static boolean validInstallId(String value) {
        return value != null && INSTALL.matcher(value).matches();
    }

    /** An uncompressed P-256 point as 87 base64url characters. */
    public static boolean validApprovalKey(String value) {
        return value != null && APPROVAL_KEY.matcher(value).matches();
    }

    /** The relay's statement: 40-1200 base64url, a dot, 86 base64url (companion/src/relay-statement.ts). */
    public static boolean validApprovalStatement(String value) {
        return value != null && APPROVAL_STATEMENT.matcher(value).matches();
    }

    /** installId is null unless the probe answered mobile: 1 (Review Focus 5). */
    public static String enterPath(String credential, String installId) {
        return enterPath(credential, installId, null, null);
    }

    /**
     * {@code /enter#<credential>&installId=<id>[&approvalKey=<key>&approvalStatement=<statement>]},
     * the order the desktop's enter page parses (companion/src/browser.ts). A key and its statement
     * go together or not at all: either alone is null, so a bare key cannot be sent by API shape.
     */
    public static String enterPath(String credential, String installId, String approvalKey, String approvalStatement) {
        if (!validCredential(credential)) return null;
        if ((approvalKey == null) != (approvalStatement == null)) return null;
        if (installId == null) return approvalKey == null ? "/enter#" + credential : null;
        if (!validInstallId(installId)) return null;
        String path = "/enter#" + credential + "&installId=" + installId;
        if (approvalKey == null) return path;
        if (!validApprovalKey(approvalKey) || !validApprovalStatement(approvalStatement)) return null;
        return path + "&approvalKey=" + approvalKey + "&approvalStatement=" + approvalStatement;
    }

    /** A scanned pairing code: the computer's origin and its credential. */
    public static final class Link {
        public final WorkspaceOrigin origin;
        public final String credential;

        Link(WorkspaceOrigin origin, String credential) {
            this.origin = origin;
            this.credential = credential;
        }
    }

    /**
     * What the pairing QR code on the computer holds: exactly
     * {@code <origin>/enter#<credential>}, the origin by the WorkspaceOrigin
     * rule. Anything else the camera sees (another app's code, a Wi-Fi code,
     * a link with a query or its own installId) is null. Twin of
     * PairingLink.parse in Swift: U+0020 is trimmed from both ends, nothing else.
     */
    public static Link parse(String text) {
        if (text == null || text.codePointCount(0, text.length()) > 4096) return null;
        WorkspaceOrigin origin = WorkspaceOrigin.parse(text);
        if (origin == null) return null;
        int start = 0;
        int end = text.length();
        while (start < end && text.charAt(start) == ' ') start++;
        while (end > start && text.charAt(end - 1) == ' ') end--;
        // WorkspaceOrigin has checked the eight-character "https://" and an ASCII authority.
        String rest = text.substring(start + 8, end);
        int hash = rest.indexOf('#');
        if (hash < 0) return null;
        String head = rest.substring(0, hash);
        int slash = -1;
        for (int i = 0; i < head.length(); i++) {
            char c = head.charAt(i);
            if (c == '/' || c == '?') {
                slash = i;
                break;
            }
        }
        if (slash < 0 || !head.substring(slash).equals("/enter")) return null;
        String credential = rest.substring(hash + 1);
        return validCredential(credential) ? new Link(origin, credential) : null;
    }

    public static String newInstallId(String prefix, UUID uuid) {
        return prefix + "-" + uuid.toString().toLowerCase(Locale.ROOT).replace("-", "");
    }
}
