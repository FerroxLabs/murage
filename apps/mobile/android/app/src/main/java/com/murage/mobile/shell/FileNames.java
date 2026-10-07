package com.murage.mobile.shell;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The name a saved file gets on disk. Twin of FileNames in SaveRequest.swift;
 * the rule is safeFileName in src/lib/native-contract.test.ts:
 * 1. the last non-empty component after splitting on "/" and "\"
 * 2. drop Cc, Cf, Cs, Zl, Zp and each of " * < > ? | :
 * 3. each run of Zs becomes one U+0020
 * 4. until stable: trim U+0020 at both ends, then drop leading "."
 * 5. over 200 UTF-8 bytes: keep a 1–10 ASCII alphanumeric extension, cut the
 *    stem at a code-point boundary to fit, drop trailing " " and "." from it
 * 6. empty is "download"
 */
public final class FileNames {
    static final int MAX_BYTES = 200;
    private static final String RESERVED = "\"*<>?|:";
    private static final Pattern EXTENSION = Pattern.compile("\\.[A-Za-z0-9]{1,10}\\z");

    private FileNames() {}

    public static String safe(String raw) {
        String name = collapse(lastComponent(raw == null ? "" : raw));
        for (String before = null; !name.equals(before); ) {
            before = name;
            name = trimSpaces(name);
            int dots = 0;
            while (dots < name.length() && name.charAt(dots) == '.') dots++;
            name = name.substring(dots);
        }
        if (utf8Bytes(name) > MAX_BYTES) name = cut(name);
        return name.isEmpty() ? "download" : name;
    }

    private static String lastComponent(String raw) {
        String[] parts = raw.split("[/\\\\]");
        for (int i = parts.length - 1; i >= 0; i--) {
            if (!parts[i].isEmpty()) return parts[i];
        }
        return "";
    }

    /** Steps 2 and 3. String.codePoints() yields a lone surrogate as itself, so Cs is seen. */
    private static String collapse(String component) {
        StringBuilder kept = new StringBuilder();
        boolean inSpaces = false;
        for (int i = 0; i < component.length(); ) {
            int c = component.codePointAt(i);
            i += Character.charCount(c);
            int type = Character.getType(c);
            if (type == Character.CONTROL || type == Character.FORMAT || type == Character.SURROGATE
                    || type == Character.LINE_SEPARATOR || type == Character.PARAGRAPH_SEPARATOR
                    || RESERVED.indexOf(c) >= 0) {
                continue;
            }
            if (type == Character.SPACE_SEPARATOR) {
                if (!inSpaces) kept.append(' ');
                inSpaces = true;
                continue;
            }
            inSpaces = false;
            kept.appendCodePoint(c);
        }
        return kept.toString();
    }

    private static String cut(String name) {
        Matcher match = EXTENSION.matcher(name);
        String extension = match.find() ? match.group() : "";
        String rest = name.substring(0, name.length() - extension.length());
        int budget = MAX_BYTES - extension.length(); // the extension is ASCII
        int end = 0;
        int used = 0;
        while (end < rest.length()) {
            int c = rest.codePointAt(end);
            int bytes = utf8Bytes(c);
            if (used + bytes > budget) break;
            used += bytes;
            end += Character.charCount(c);
        }
        int stemEnd = end;
        while (stemEnd > 0 && (rest.charAt(stemEnd - 1) == ' ' || rest.charAt(stemEnd - 1) == '.')) stemEnd--;
        String stem = rest.substring(0, stemEnd);
        return (stem.isEmpty() ? "download" : stem) + extension;
    }

    private static String trimSpaces(String value) {
        int start = 0;
        int end = value.length();
        while (start < end && value.charAt(start) == ' ') start++;
        while (end > start && value.charAt(end - 1) == ' ') end--;
        return value.substring(start, end);
    }

    static int utf8Bytes(String text) {
        int total = 0;
        for (int i = 0; i < text.length(); ) {
            int c = text.codePointAt(i);
            total += utf8Bytes(c);
            i += Character.charCount(c);
        }
        return total;
    }

    private static int utf8Bytes(int codePoint) {
        if (codePoint < 0x80) return 1;
        if (codePoint < 0x800) return 2;
        if (codePoint < 0x10000) return 3;
        return 4;
    }
}
