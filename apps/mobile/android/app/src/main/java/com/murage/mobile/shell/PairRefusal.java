package com.murage.mobile.shell;

/**
 * The line a computer gave when it refused a pairing code, cleaned before the
 * phone shows it (1.0.16). Control and format characters are dropped, every
 * kind of white space becomes one space, and the result is trimmed and capped
 * at {@link #MAX_CHARS} code points. Twin of PairRefusal.swift; both are driven
 * by contract/pair-refusal.json.
 */
public final class PairRefusal {
    public static final int MAX_CHARS = 160;

    private PairRefusal() {}

    public static String message(String raw) {
        if (raw == null) return "";
        StringBuilder out = new StringBuilder();
        boolean pendingSpace = false;
        int kept = 0;
        for (int at = 0; at < raw.length() && kept < MAX_CHARS; ) {
            int point = raw.codePointAt(at);
            at += Character.charCount(point);
            int type = Character.getType(point);
            if (type == Character.FORMAT) continue;
            if (type == Character.CONTROL || Character.isWhitespace(point) || Character.isSpaceChar(point)) {
                pendingSpace = out.length() > 0;
                continue;
            }
            if (pendingSpace) {
                out.append(' ');
                kept++;
                pendingSpace = false;
                if (kept >= MAX_CHARS) break;
            }
            out.appendCodePoint(point);
            kept++;
        }
        int end = out.length();
        while (end > 0 && out.charAt(end - 1) == ' ') end--;
        return out.substring(0, end);
    }
}
