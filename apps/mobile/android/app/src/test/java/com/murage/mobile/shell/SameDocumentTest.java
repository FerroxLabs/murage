package com.murage.mobile.shell;

import static org.junit.Assert.*;

import org.junit.Test;

public class SameDocumentTest {
    private static final String HOST = "https://mac.tailnet123.ts.net";

    /** The device finding: a tap's "/#open=…" over a page already at "/". */
    @Test
    public void onlyTheFragmentDiffers() {
        assertTrue(SameDocument.of(HOST + "/#open=a", HOST + "/#open=b"));
        assertTrue(SameDocument.of(HOST + "/", HOST + "/#open=b"));
        assertTrue(SameDocument.of(HOST + "/#open=a", HOST + "/"));
        assertTrue(SameDocument.of(HOST + "/", HOST + "/"));
    }

    @Test
    public void anotherPathOrQueryIsANewDocument() {
        assertFalse(SameDocument.of(HOST + "/enter", HOST + "/#open=b"));
        assertFalse(SameDocument.of(HOST + "/?a=1#open=a", HOST + "/#open=b"));
        assertFalse(SameDocument.of(HOST + "/?a=1", HOST + "/?a=2"));
    }

    @Test
    public void anotherOriginOrNoPageIsANewDocument() {
        assertFalse(SameDocument.of(null, HOST + "/#open=b"));
        assertFalse(SameDocument.of("https://other.tailnet123.ts.net/", HOST + "/#open=b"));
        assertFalse(SameDocument.of(HOST + ":8444/", HOST + "/#open=b"));
        assertFalse(SameDocument.of(HOST + "/", null));
    }

    /** replaceState fires no hashchange; a failure answers false so the caller loads as before. */
    @Test
    public void theReloadScriptQuotesTheTarget() {
        String script = SameDocument.reloadScript(HOST + "/#open=a'b\"c");
        assertTrue(script, script.contains("history.replaceState(null, '', \"https://mac.tailnet123.ts.net/#open=a'b\\\"c\")"));
        assertTrue(script, script.contains("location.reload()"));
        assertTrue(script, script.contains("return false"));
    }
}
