package com.murage.mobile;

/** Untrusted display names stay on their own plain line, outside the warning. */
final class PhoneDataSharingText {
    static String providerLine(String name) {
        return providerLine(name, "another AI service");
    }
    static String providerLine(String name, String fallback) {
        String value = plain(name, 120, 0);
        return value.isEmpty() ? fallback : value;
    }

    /** Offer schema limits count UTF-16 units; a surrogate pair stays intact. */
    static String plain(String text, int limit, int lineBreaks) {
        StringBuilder line = new StringBuilder();
        int breaks = 0;
        for (int i = 0; text != null && i < text.length();) {
            int point = text.codePointAt(i);
            i += Character.charCount(point);
            int type = Character.getType(point);
            if (point == '\n' && breaks < lineBreaks) breaks++;
            else if (type == Character.CONTROL || type == Character.FORMAT
                    || type == Character.LINE_SEPARATOR || type == Character.PARAGRAPH_SEPARATOR) continue;
            if (line.length() + Character.charCount(point) > limit) break;
            line.appendCodePoint(point);
        }
        String value = line.toString();
        int start = 0, end = value.length();
        while (start < end && space(value.codePointAt(start))) start += Character.charCount(value.codePointAt(start));
        while (end > start && space(value.codePointBefore(end))) end -= Character.charCount(value.codePointBefore(end));
        value = value.substring(start, end);
        return value;
    }

    private static boolean space(int point) {
        return Character.isWhitespace(point) || Character.isSpaceChar(point);
    }

    static String message(String warning, String providerName) {
        return message(warning, providerName, null);
    }
    static String message(String warning, String providerName, String workspaceName) {
        return message(warning, providerName, workspaceName, "another AI service");
    }
    static String message(String warning, String providerName, String workspaceName, String fallback) {
        String message = providerName == null ? warning : warning + "\n\n" + providerLine(providerName, fallback);
        return workspaceName == null ? message : message + "\n\n" + plain(workspaceName, 120, 0);
    }
}
