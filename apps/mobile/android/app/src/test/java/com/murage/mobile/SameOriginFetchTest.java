package com.murage.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.murage.mobile.shell.WorkspaceOrigin;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

/** P20 ruling: the session cookie never leaves the saved origin, redirects included. */
public class SameOriginFetchTest {
    private static final WorkspaceOrigin ORIGIN = WorkspaceOrigin.parse("https://studio.tail1.ts.net:8443");
    private static final String BASE = "https://studio.tail1.ts.net:8443";

    /** A scripted response; records what the fetch set on it. */
    private static final class Fake extends HttpURLConnection {
        final int status;
        final String location;
        final Map<String, String> sent = new HashMap<>();
        boolean disconnected;

        Fake(URL url, int status, String location) {
            super(url);
            this.status = status;
            this.location = location;
        }

        @Override public int getResponseCode() {
            return status;
        }

        @Override public String getHeaderField(String name) {
            if (!"Location".equalsIgnoreCase(name) || location == null) return null;
            String[] all = location.split(" ");
            return all[all.length - 1]; // Android's HttpURLConnection returns the last value
        }

        @Override public Map<String, List<String>> getHeaderFields() {
            Map<String, List<String>> fields = new HashMap<>();
            if (location != null) fields.put("location", java.util.Arrays.asList(location.split(" ")));
            return fields;
        }

        @Override public void setRequestProperty(String key, String value) {
            sent.put(key, value);
        }

        @Override public void disconnect() {
            disconnected = true;
        }

        @Override public boolean usingProxy() {
            return false;
        }

        @Override public void connect() {}
    }

    /** Answers each opened URL from a script: url -> status [space location]. */
    private static final class Script implements SameOriginFetch.Opener {
        final Map<String, String> answers = new HashMap<>();
        final List<Fake> opened = new ArrayList<>();

        Script on(String url, String answer) {
            answers.put(url, answer);
            return this;
        }

        @Override public HttpURLConnection open(URL url) throws IOException {
            String answer = answers.get(url.toString());
            if (answer == null) throw new IOException("unscripted " + url);
            String[] parts = answer.split(" ", 2);
            Fake fake = new Fake(url, Integer.parseInt(parts[0]), parts.length > 1 ? parts[1] : null);
            opened.add(fake);
            return fake;
        }
    }

    private static final SameOriginFetch.Cookies COOKIE = url -> "murage_session=secret";
    private static final SameOriginFetch.Watch NONE = connection -> {};

    private static String refusal(String url, Script script) throws IOException {
        try {
            SameOriginFetch.open(url, ORIGIN, "UA", COOKIE, script, NONE);
        } catch (SameOriginFetch.Refused refused) {
            return refused.code;
        }
        fail("expected a refusal");
        return null;
    }

    @Test public void fetchesTheOriginWithTheCookieAndNoAutomaticRedirects() throws Exception {
        Script script = new Script().on(BASE + "/files/a.pdf", "200");
        HttpURLConnection connection = SameOriginFetch.open(BASE + "/files/a.pdf", ORIGIN, "UA", COOKIE, script, NONE);
        Fake fake = script.opened.get(0);
        assertSame(fake, connection);
        assertEquals("murage_session=secret", fake.sent.get("Cookie"));
        assertEquals("UA", fake.sent.get("User-Agent"));
        assertFalse(fake.getInstanceFollowRedirects());
        assertFalse(fake.getUseCaches());
    }

    @Test public void refusesAForeignStartWithoutConnecting() throws Exception {
        Script script = new Script();
        assertEquals("foreign_url", refusal("https://evil.example/a", script));
        assertEquals("foreign_url", refusal("https://studio.tail1.ts.net/a", script)); // another port
        assertEquals("foreign_url", refusal("blob:" + BASE + "/x", script));
        assertTrue(script.opened.isEmpty());
    }

    @Test public void followsASameOriginRedirect() throws Exception {
        Script script = new Script()
            .on(BASE + "/files/a", "302 /download/a?t=1")
            .on(BASE + "/download/a?t=1", "200");
        HttpURLConnection connection = SameOriginFetch.open(BASE + "/files/a", ORIGIN, "UA", COOKIE, script, NONE);
        assertEquals(2, script.opened.size());
        assertSame(script.opened.get(1), connection);
        assertTrue(script.opened.get(0).disconnected);
        assertEquals("murage_session=secret", script.opened.get(1).sent.get("Cookie"));
    }

    @Test public void neverFollowsARedirectOffTheOrigin() throws Exception {
        for (String location : new String[] {
            "https://evil.example/steal",
            "//evil.example/steal",
            "https://studio.tail1.ts.net:9999/a",
            "http://studio.tail1.ts.net:8443/a",
            "https://studio.tail1.ts.net:8443@evil.example/a",
        }) {
            Script script = new Script().on(BASE + "/files/a", "307 " + location);
            assertEquals(location, "foreign_url", refusal(BASE + "/files/a", script));
            assertEquals(location, 1, script.opened.size()); // the foreign target is never opened
            assertTrue(script.opened.get(0).disconnected);
        }
    }

    @Test public void givesUpAfterFiveRedirects() throws Exception {
        Script script = new Script();
        for (int i = 0; i <= SameOriginFetch.MAX_REDIRECTS; i++) script.on(BASE + "/r" + i, "302 /r" + (i + 1));
        assertEquals("download_failed", refusal(BASE + "/r0", script));
        assertEquals(SameOriginFetch.MAX_REDIRECTS + 1, script.opened.size());
    }

    @Test public void followsExactlyFiveRedirects() throws Exception {
        Script script = new Script();
        for (int i = 0; i < SameOriginFetch.MAX_REDIRECTS; i++) script.on(BASE + "/r" + i, "301 /r" + (i + 1));
        script.on(BASE + "/r" + SameOriginFetch.MAX_REDIRECTS, "200");
        assertNotNull(SameOriginFetch.open(BASE + "/r0", ORIGIN, "UA", COOKIE, script, NONE));
    }

    @Test public void aFailedStatusIsNeverAFile() throws Exception {
        for (String status : new String[] {"401", "404", "500", "304"}) {
            Script script = new Script().on(BASE + "/a", status);
            assertEquals(status, "download_failed", refusal(BASE + "/a", script));
            assertTrue(script.opened.get(0).disconnected);
        }
        Script noLocation = new Script().on(BASE + "/a", "302");
        assertEquals("download_failed", refusal(BASE + "/a", noLocation));
    }

    @Test public void sendsNoCookieHeaderWhenTheJarHasNone() throws Exception {
        Script script = new Script().on(BASE + "/a", "200");
        SameOriginFetch.open(BASE + "/a", ORIGIN, "UA", url -> null, script, NONE);
        assertNull(script.opened.get(0).sent.get("Cookie"));
    }

    @Test public void refusesALocationHeaderWithSeveralValues() throws Exception {
        // Same-origin values both, and still refused: which one a client follows is not ours to guess.
        Script script = new Script().on(BASE + "/a", "302 /b /c").on(BASE + "/b", "200").on(BASE + "/c", "200");
        assertEquals("download_failed", refusal(BASE + "/a", script));
        assertEquals(1, script.opened.size());
        Script mixed = new Script().on(BASE + "/a", "302 https://evil.example/x /c").on(BASE + "/c", "200");
        assertEquals("download_failed", refusal(BASE + "/a", mixed));
        assertEquals(1, mixed.opened.size());
    }

    @Test public void publishesEachHopsConnectionBeforeWaitingOnIt() throws Exception {
        Script script = new Script().on(BASE + "/a", "302 /b").on(BASE + "/b", "200");
        List<HttpURLConnection> seen = new ArrayList<>();
        SameOriginFetch.open(BASE + "/a", ORIGIN, "UA", COOKIE, script, seen::add);
        assertEquals(script.opened, seen); // so a cancel can disconnect whichever hop is running
    }

    @Test public void aCancelDuringTheRedirectsStopsBeforeTheNextHop() throws Exception {
        Script script = new Script().on(BASE + "/a", "302 /b").on(BASE + "/b", "200");
        int[] hops = {0};
        SameOriginFetch.Watch cancelOnSecond = connection -> {
            if (++hops[0] == 2) throw new java.io.InterruptedIOException("cancelled");
        };
        try {
            SameOriginFetch.open(BASE + "/a", ORIGIN, "UA", COOKIE, script, cancelOnSecond);
            fail("expected the cancel");
        } catch (java.io.InterruptedIOException expected) {
            // the cancel surfaces as an IOException
        }
        assertEquals(2, script.opened.size());
        assertTrue(script.opened.get(1).disconnected); // the cancelled hop is closed, never read
        assertNull(script.opened.get(1).sent.get("Cookie")); // nor sent anything
    }

    @Test public void cleansThePageMimeType() {
        assertEquals("application/pdf", SameOriginFetch.mimeOf("Application/PDF; charset=x", null));
        assertEquals("text/plain", SameOriginFetch.mimeOf(null, "text/plain"));
        assertEquals("application/octet-stream", SameOriginFetch.mimeOf(null, null));
        for (String bad : new String[] {"", "pdf", "a/b/c", "text/plain\r\nX: y", "../../x", "text /plain", "ö/x"}) {
            assertEquals(bad, "application/octet-stream", SameOriginFetch.mimeOf(bad, null));
        }
    }
}
