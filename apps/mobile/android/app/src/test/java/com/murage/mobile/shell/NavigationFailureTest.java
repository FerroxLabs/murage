package com.murage.mobile.shell;

import static org.junit.Assert.assertEquals;

import android.webkit.WebViewClient;
import org.junit.Test;

public class NavigationFailureTest {
    @Test public void networkErrorsAreUnreachable() {
        for (int code : new int[] {WebViewClient.ERROR_HOST_LOOKUP, WebViewClient.ERROR_CONNECT, WebViewClient.ERROR_TIMEOUT, WebViewClient.ERROR_IO}) {
            assertEquals(LoadFailure.UNREACHABLE, NavigationFailure.classify(code));
        }
    }

    @Test public void aFailedHandshakeIsInsecure() {
        assertEquals(LoadFailure.INSECURE, NavigationFailure.classify(WebViewClient.ERROR_FAILED_SSL_HANDSHAKE));
    }

    /** Policy, not the network: a URL the WebView will not show (WebKit's 101 on iOS). */
    @Test public void anUnsupportedSchemeIsIgnored() {
        assertEquals(LoadFailure.IGNORE, NavigationFailure.classify(WebViewClient.ERROR_UNSUPPORTED_SCHEME));
    }

    /** P10 fix ruling, as in Swift: any other failure is a can't-reach, never a splash left up for good. */
    @Test public void everythingElseIsUnreachable() {
        int[] codes = {
            WebViewClient.ERROR_UNKNOWN, WebViewClient.ERROR_BAD_URL, WebViewClient.ERROR_REDIRECT_LOOP,
            WebViewClient.ERROR_AUTHENTICATION, WebViewClient.ERROR_PROXY_AUTHENTICATION, WebViewClient.ERROR_UNSAFE_RESOURCE,
            WebViewClient.ERROR_TOO_MANY_REQUESTS, WebViewClient.ERROR_FILE, WebViewClient.ERROR_FILE_NOT_FOUND, 7, -99,
        };
        for (int code : codes) assertEquals(String.valueOf(code), LoadFailure.UNREACHABLE, NavigationFailure.classify(code));
    }
}
