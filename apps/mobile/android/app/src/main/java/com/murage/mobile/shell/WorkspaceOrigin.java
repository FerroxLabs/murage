package com.murage.mobile.shell;

import java.util.Locale;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A workspace is an HTTPS origin the phone can reach (spec §2): lower-case
 * host, default port folded away. Twin of WorkspaceOrigin.swift.
 *
 * <p>Parsed by hand on the raw string, exactly the rule in
 * src/lib/native-contract.test.ts, never by java.net.URI (which accepts
 * userinfo, IP literals and escapes a WebView would read differently).
 */
public final class WorkspaceOrigin {
    private static final Pattern URL = Pattern.compile("https://([^/?#]*)(?:[/?#].*)?", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern AUTHORITY = Pattern.compile("([^:]*)(?::([0-9]*))?");
    private static final Pattern HOST = Pattern.compile("[A-Za-z0-9.-]+");

    public final String host;
    public final int port;

    private WorkspaceOrigin(String host, int port) {
        this.host = host;
        this.port = port;
    }

    public static WorkspaceOrigin parse(String value) {
        if (value == null) return null;
        String text = trimSpaces(value);
        if (Unsafe.any(text)) return null;
        Matcher url = URL.matcher(text);
        if (!url.matches() || url.group(1).indexOf('@') >= 0) return null;
        Matcher authority = AUTHORITY.matcher(url.group(1));
        if (!authority.matches()) return null;
        // ASCII is checked before lower-casing: U+212A (Kelvin) would otherwise become "k".
        if (!HOST.matcher(authority.group(1)).matches()) return null;
        String host = authority.group(1).toLowerCase(Locale.ROOT);
        String bare = host.endsWith(".") ? host.substring(0, host.length() - 1) : host;
        String[] labels = bare.split("\\.", -1);
        for (String label : labels) {
            if (label.isEmpty() || label.startsWith("-") || label.endsWith("-")) return null;
        }
        char first = labels[labels.length - 1].charAt(0);
        if (first >= '0' && first <= '9') return null; // an IP literal (100.64.0.1, 2130706433, 0x7f.1)
        int port = port(authority.group(2));
        if (port < 1) return null;
        return new WorkspaceOrigin(host, port);
    }

    /**
     * What the launcher sends (typed or pasted): trimmed like Swift's
     * {@code .whitespacesAndNewlines} (Unicode Z*, U+0009–U+000D and U+0085),
     * then {@link #parse}. open() and remove() both read their input this way (P17).
     */
    public static WorkspaceOrigin parseInput(String value) {
        if (value == null) return null;
        return parse(trimInput(value));
    }

    /** The launcher-input trim on its own (P21: the QR scanner trims a code the same way); null stays null. */
    public static String trimInput(String value) {
        if (value == null) return null;
        int start = 0;
        int end = value.length();
        while (start < end && trimmable(value.charAt(start))) start++;
        while (end > start && trimmable(value.charAt(end - 1))) end--;
        return value.substring(start, end);
    }

    private static boolean trimmable(char c) {
        if ((c >= 0x09 && c <= 0x0D) || c == 0x85) return true;
        int type = Character.getType(c);
        return type == Character.SPACE_SEPARATOR || type == Character.LINE_SEPARATOR || type == Character.PARAGRAPH_SEPARATOR;
    }

    /** Absent or empty is 443; otherwise 1–65535 by value (so 0443 is 443), without overflow. */
    private static int port(String digits) {
        if (digits == null || digits.isEmpty()) return 443;
        int start = 0;
        while (start < digits.length() - 1 && digits.charAt(start) == '0') start++;
        String significant = digits.substring(start);
        if (significant.length() > 5) return -1;
        int port = Integer.parseInt(significant);
        return port <= 65535 ? port : -1;
    }

    /** U+0020 only, like the oracle: String.trim() would also eat tab and newline. */
    private static String trimSpaces(String value) {
        int start = 0;
        int end = value.length();
        while (start < end && value.charAt(start) == ' ') start++;
        while (end > start && value.charAt(end - 1) == ' ') end--;
        return value.substring(start, end);
    }

    public String serialized() {
        return port == 443 ? "https://" + host : "https://" + host + ":" + port;
    }

    /** The same parse applied to an absolute URL; blob: is never unwrapped the WHATWG way. */
    public boolean contains(String url) {
        return equals(parse(url));
    }

    @Override
    public boolean equals(Object other) {
        if (!(other instanceof WorkspaceOrigin)) return false;
        WorkspaceOrigin that = (WorkspaceOrigin) other;
        return port == that.port && host.equals(that.host);
    }

    @Override
    public int hashCode() {
        return Objects.hash(host, port);
    }

    @Override
    public String toString() {
        return serialized();
    }
}
