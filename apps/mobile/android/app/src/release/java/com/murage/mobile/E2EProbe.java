package com.murage.mobile;

import android.webkit.WebView;

/** Release builds: there is no E2E probe. */
final class E2EProbe {
    static boolean requested;

    private E2EProbe() {}

    static void run(WebView webView) {}

    static boolean isProbeOutput(String message) {
        return false;
    }
}
