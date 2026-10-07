package com.murage.mobile.shell;

import static org.junit.Assert.*;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class OpenHashTest {
    @Test
    public void sharedCases() throws Exception {
        JSONArray cases = new JSONArray(Fixtures.read("open-hash.json"));
        assertTrue(cases.length() > 10);
        for (int i = 0; i < cases.length(); i++) {
            JSONObject entry = cases.getJSONObject(i);
            String message = entry.has("messageId") ? entry.getString("messageId") : null;
            String expected = entry.isNull("hash") ? null : entry.getString("hash");
            assertEquals(entry.getString("threadId"), expected, OpenHash.build(entry.getString("threadId"), message));
        }
    }

    /**
     * Java-only (a lone surrogate cannot sit in the shared JSON): URLSearchParams
     * and Swift both encode it as U+FFFD, so Java does too, not as "?".
     */
    @Test
    public void loneSurrogatesBecomeTheReplacementCharacter() {
        assertEquals("#open=a%EF%BF%BDb", OpenHash.build("a\uD800b", null));
        assertEquals("#open=%EF%BF%BD&msg=m%EF%BF%BD", OpenHash.build("\uDC00", "m\uD83D"));
        assertEquals("#open=%F0%9F%98%80", OpenHash.build("\uD83D\uDE00", null));
    }

    @Test
    public void idsFollowThePagesLimit() {
        assertNotNull(OpenHash.build("a".repeat(512), null));
        assertNull(OpenHash.build("a".repeat(513), null));
        assertEquals("#open=t", OpenHash.build("t", "m".repeat(513)));
        assertNotNull(OpenHash.build("😀".repeat(256), null));
        assertNull(OpenHash.build("😀".repeat(257), null));
        assertNull(OpenHash.build(null, "m"));
        assertNull(OpenHash.build("", "m"));
    }
}
