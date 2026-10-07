package com.murage.mobile.shell;

import android.webkit.WebViewClient;

/**
 * What a failed main-document load means (spec §3.2, §7). The WebViewClient
 * codes are compile-time constants, so this stays a pure JVM class. Like
 * NavigationFailure.swift (P10 fix ruling): only a URL the WebView will not
 * show is ignored, a failed handshake is insecure, and every other failure is
 * a can't-reach, never a splash left up for good.
 */
public final class NavigationFailure {
    private NavigationFailure() {}

    public static LoadFailure classify(int errorCode) {
        switch (errorCode) {
            case WebViewClient.ERROR_HOST_LOOKUP: // Tailscale off: MagicDNS cannot resolve *.ts.net
            case WebViewClient.ERROR_CONNECT:     // the computer is asleep or the door is down
            case WebViewClient.ERROR_TIMEOUT:
            case WebViewClient.ERROR_IO:
                return LoadFailure.UNREACHABLE;
            case WebViewClient.ERROR_FAILED_SSL_HANDSHAKE:
                return LoadFailure.INSECURE;
            case WebViewClient.ERROR_UNSUPPORTED_SCHEME:
                // Policy, not the network (WebKit's 101): shouldOverrideUrlLoading sends
                // such links out, and the readiness deadline covers the rest.
                return LoadFailure.IGNORE;
            default:
                return LoadFailure.UNREACHABLE;
        }
    }
}
