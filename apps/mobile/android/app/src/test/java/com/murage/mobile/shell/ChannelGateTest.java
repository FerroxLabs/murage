package com.murage.mobile.shell;

import static org.junit.Assert.*;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class ChannelGateTest {
    private final WorkspaceOrigin saved = WorkspaceOrigin.parse("https://mac.tailnet123.ts.net");

    /** The wrapper always sends an id; the fixtures' bodies get one here. */
    private static String envelope(Object body) throws Exception {
        if (body instanceof JSONObject) return new JSONObject(body.toString()).put("id", 1).toString();
        return body instanceof String ? JSONObject.quote((String) body) : String.valueOf(body);
    }

    @Test
    public void sharedRequestCases() throws Exception {
        JSONArray requests = new JSONObject(Fixtures.read("channel.json")).getJSONArray("requests");
        assertTrue(requests.length() > 5);
        for (int i = 0; i < requests.length(); i++) {
            JSONObject entry = requests.getJSONObject(i);
            String data = envelope(entry.get("body"));
            if (entry.has("method")) {
                assertEquals(data, entry.getString("method"), ChannelGate.parse(data).method);
            } else {
                try {
                    ChannelGate.parse(data);
                    fail("accepted " + data);
                } catch (ChannelException refused) {
                    assertEquals(data, entry.getString("error"), refused.code);
                }
            }
        }
    }

    @Test
    public void repliesCarryTheCallersId() throws Exception {
        try {
            ChannelGate.parse("{\"id\":7,\"method\":\"teleport\"}");
            fail();
        } catch (ChannelException refused) {
            assertEquals(7, refused.id);
        }
        assertEquals(3, ChannelGate.parse("{\"id\":3,\"method\":\"ready\",\"args\":null}").id);
    }

    @Test
    public void refusesAnOversizedMessage() {
        try {
            ChannelGate.parse("x".repeat(ChannelGate.MAX_MESSAGE_CHARS + 1));
            fail();
        } catch (ChannelException refused) {
            assertEquals("too_large", refused.code);
        }
    }

    /** Android's org.json parses by recursion: a deep enough message overflows the stack. It is bad_args, never a crash. */
    @Test
    public void deeplyNestedJsonIsBadArgs() {
        int depth = 200_000;
        String data = "{\"id\":1,\"method\":\"ready\",\"args\":{\"a\":" + "[".repeat(depth) + "]".repeat(depth) + "}}";
        assertTrue(data.length() < ChannelGate.MAX_MESSAGE_CHARS);
        try {
            ChannelGate.parse(data);
            fail("accepted a message nested " + depth + " deep");
        } catch (ChannelException refused) {
            assertEquals("bad_args", refused.code);
        }
    }

    /** No ':' in the host after userinfo, then optionally ':' and digits (ff3c8a82): no IPv6 literal, no "a:x". */
    @Test
    public void externalUrlAuthorityRule() throws Exception {
        for (String url : new String[] {"https://a::", "https://a:x/", "https://[::1]/", "http://u:p@a:b/"}) {
            assertNull(url, ChannelArgs.externalUrl(new JSONObject().put("url", url)));
        }
        for (String url : new String[] {"https://a:/", "https://a:443/x", "https://u:p@a:8443", "https://u:p@a"}) {
            assertEquals(url, url, ChannelArgs.externalUrl(new JSONObject().put("url", url)));
        }
    }

    @Test
    public void helloListsExactlyTheSharedMethods() throws Exception {
        JSONObject channel = new JSONObject(Fixtures.read("channel.json"));
        JSONObject hello = ChannelGate.hello();
        assertEquals(channel.getInt("version"), hello.getInt("version"));
        assertEquals(channel.getInt("version"), ChannelGate.VERSION);
        // callSessionOpen/Close started as Android's own addition
        // (callbar-rereview.md M4) and are now shared -- iOS lists them
        // too (callbar-rereview2.md G3), so Android is back to advertising
        // exactly the shared list, with no platform addition of its own.
        assertEquals(channel.getJSONArray("methods").toString(), hello.getJSONArray("methods").toString());
    }

    @Test
    public void subframeIsRefusedEvenOnTheSavedOrigin() {
        assertTrue(ChannelGate.admit(true, saved, saved));
        assertFalse(ChannelGate.admit(false, saved, saved));
        assertFalse(ChannelGate.admit(true, WorkspaceOrigin.parse("https://example.com"), saved));
        assertFalse(ChannelGate.admit(true, null, saved));
        assertFalse(ChannelGate.admit(true, saved, null));
    }

    /** openExternal: every contract row, accepted ones returned unchanged (| { } ^ stay raw). */
    @Test
    public void sharedExternalUrls() throws Exception {
        JSONArray cases = new JSONObject(Fixtures.read("channel.json")).getJSONArray("externalUrls");
        assertTrue(cases.length() > 20);
        for (int i = 0; i < cases.length(); i++) {
            JSONObject entry = cases.getJSONObject(i);
            String url = entry.getString("url");
            String expected = entry.getBoolean("accepted") ? url : null;
            assertEquals(url, expected, ChannelArgs.externalUrl(new JSONObject().put("url", url)));
        }
    }

    @Test
    public void externalUrlNeedsAString() throws Exception {
        assertNull(ChannelArgs.externalUrl(new JSONObject()));
        assertNull(ChannelArgs.externalUrl(new JSONObject("{\"url\":7}")));
        assertNull(ChannelArgs.externalUrl(new JSONObject().put("url", "https://example.com/" + "a".repeat(4096))));
    }

    @Test
    public void routeArguments() throws Exception {
        assertEquals(ChannelArgs.RouteKind.THREAD, ChannelArgs.route(new JSONObject("{\"threadId\":\"t1\"}")).kind);
        assertEquals("t1", ChannelArgs.route(new JSONObject("{\"threadId\":\"t1\"}")).threadId);
        assertEquals(ChannelArgs.RouteKind.KEEP, ChannelArgs.route(new JSONObject("{\"threadId\":null}")).kind);
        assertEquals(ChannelArgs.RouteKind.KEEP, ChannelArgs.route(new JSONObject()).kind);
        assertEquals(ChannelArgs.RouteKind.INVALID, ChannelArgs.route(new JSONObject("{\"threadId\":7}")).kind);
        assertEquals(ChannelArgs.RouteKind.INVALID, ChannelArgs.route(new JSONObject("{\"threadId\":\"\"}")).kind);
        assertTrue(ChannelArgs.HAPTICS.contains("success"));
        assertFalse(ChannelArgs.HAPTICS.contains("explode"));
    }

    /** diagLine: routed and advertised, and only a [call-diag]/[call-trace] string line passes. */
    @Test
    public void diagLineArgs() throws Exception {
        assertTrue(ChannelGate.ADVERTISED.contains("diagLine"));
        JSONObject fixture = new JSONObject(Fixtures.read("channel.json")).getJSONObject("diagLineArgs");
        JSONArray accepted = fixture.getJSONArray("accepted");
        for (int i = 0; i < accepted.length(); i++) {
            JSONObject args = accepted.getJSONObject(i);
            assertEquals(args.toString(), args.getString("line"), ChannelArgs.diagLine(args));
        }
        JSONArray refused = fixture.getJSONArray("refused");
        for (int i = 0; i < refused.length(); i++) {
            assertNull(refused.getJSONObject(i).toString(), ChannelArgs.diagLine(refused.getJSONObject(i)));
        }
        StringBuilder tooLong = new StringBuilder("[call-diag] ");
        while (tooLong.length() <= 600) tooLong.append('a');
        assertNull(ChannelArgs.diagLine(new JSONObject().put("line", tooLong.toString())));
    }
}
