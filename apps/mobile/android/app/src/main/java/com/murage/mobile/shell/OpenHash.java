package com.murage.mobile.shell;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;

/** {@code #open=<threadId>&msg=<messageId>}, as src/lib/deep-link.ts parses it. Twin of OpenHash.swift. */
public final class OpenHash {
    /** deep-link.ts MAX_ID, in UTF-16 units, which is what String.length() counts. */
    public static final int MAX_ID_LENGTH = 512;

    private OpenHash() {}

    /** Bot ids use the targets contract's bound and cannot introduce hash parameters. */
    public static boolean validBot(String id) {
        return id != null && id.matches("[A-Za-z0-9_-]{1,128}");
    }

    /** Empty means the bot list at the workspace root, never a remembered chat. */
    public static String compose(String botId) {
        return validBot(botId) ? "#open=bot:" + botId + "&compose=1" : "";
    }

    public static boolean isCompose(String hash) {
        return hash != null && (hash.isEmpty() || hash.matches("#open=bot:[A-Za-z0-9_-]{1,128}&compose=1"));
    }

    public static boolean valid(String id) {
        return id != null && !id.isEmpty() && id.length() <= MAX_ID_LENGTH;
    }

    public static String build(String threadId, String messageId) {
        if (!valid(threadId)) return null;
        String hash = "#open=" + formEncode(threadId);
        if (valid(messageId)) hash += "&msg=" + formEncode(messageId);
        return hash;
    }

    /**
     * URLEncoder is application/x-www-form-urlencoded: byte for byte URLSearchParams.toString().
     * A lone surrogate becomes U+FFFD first (%EF%BF%BD, as URLSearchParams and Swift give);
     * URLEncoder alone would write "?" (%3F).
     */
    public static String formEncode(String value) {
        try {
            return URLEncoder.encode(wellFormed(value), "UTF-8");
        } catch (UnsupportedEncodingException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    /** String.prototype.toWellFormed(): each unpaired surrogate becomes U+FFFD, one unit for one. */
    static String wellFormed(String value) {
        StringBuilder out = null;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (Character.isHighSurrogate(c) && i + 1 < value.length() && Character.isLowSurrogate(value.charAt(i + 1))) {
                if (out != null) out.append(c).append(value.charAt(i + 1));
                i++;
            } else if (Character.isSurrogate(c)) {
                if (out == null) out = new StringBuilder(value.substring(0, i));
                out.append('\uFFFD');
            } else if (out != null) {
                out.append(c);
            }
        }
        return out == null ? value : out.toString();
    }
}
