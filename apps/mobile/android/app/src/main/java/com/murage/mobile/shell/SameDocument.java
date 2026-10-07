package com.murage.mobile.shell;

import org.json.JSONObject;

/**
 * Twin of SameDocument.swift. A load whose target differs from the page's URL
 * only by the fragment is a same-document navigation in Chromium: no new
 * document, so the page never calls ready() again and the splash stays up
 * (device finding, 2026-09-28: a notification tap over a page already at "/").
 */
public final class SameDocument {
    private SameDocument() {}

    /**
     * True when current and target are the same URL once the fragment is dropped.
     * Compared byte for byte: a WebView that reports the URL encoded differently
     * only costs the plain load this replaces.
     */
    public static boolean of(String current, String target) {
        if (current == null || target == null) return false;
        return withoutFragment(current).equals(withoutFragment(target));
    }

    /**
     * Moves the page to target without a hashchange, then boots a fresh
     * document there. Answers false when it could not (an error page, a
     * foreign origin), so the caller loads as before.
     */
    public static String reloadScript(String target) {
        return "(function(){try{history.replaceState(null, '', " + JSONObject.quote(target)
            + ");location.reload();return true}catch(e){return false}})()";
    }

    private static String withoutFragment(String url) {
        int hash = url.indexOf('#');
        return hash < 0 ? url : url.substring(0, hash);
    }
}
