package com.murage.mobile.shell;

/**
 * Anything a lenient URL parser would silently drop or rewrite: Cc controls
 * (a WHATWG parser deletes tab and newline), any Unicode space, line or
 * paragraph separator (Zs, Zl, Zp), and "\" (WHATWG reads it as "/").
 * UNSAFE in src/lib/native-contract.test.ts.
 */
final class Unsafe {
    private Unsafe() {}

    static boolean any(String text) {
        for (int i = 0; i < text.length(); ) {
            int c = text.codePointAt(i);
            if (c == '\\') return true;
            switch (Character.getType(c)) {
                case Character.CONTROL:
                case Character.SPACE_SEPARATOR:
                case Character.LINE_SEPARATOR:
                case Character.PARAGRAPH_SEPARATOR:
                    return true;
                default:
                    break;
            }
            i += Character.charCount(c);
        }
        return false;
    }
}
