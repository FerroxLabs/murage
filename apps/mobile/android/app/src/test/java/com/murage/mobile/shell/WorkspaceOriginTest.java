package com.murage.mobile.shell;

import static org.junit.Assert.*;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class WorkspaceOriginTest {
    private final WorkspaceOrigin saved = WorkspaceOrigin.parse("https://mac.tailnet123.ts.net");

    @Test
    public void sharedOriginCases() throws Exception {
        JSONArray cases = new JSONArray(Fixtures.read("origins.json"));
        assertTrue(cases.length() > 40);
        for (int i = 0; i < cases.length(); i++) {
            JSONObject entry = cases.getJSONObject(i);
            WorkspaceOrigin origin = WorkspaceOrigin.parse(entry.getString("input"));
            String expected = entry.isNull("origin") ? null : entry.getString("origin");
            assertEquals(entry.getString("input"), expected, origin == null ? null : origin.serialized());
        }
    }

    /** contract/trim.json: Swift and the TS launcher trim the same, so U+200B, U+FEFF and U+180E stay (final review M4). */
    @Test
    public void sharedTrimCases() throws Exception {
        JSONArray cases = new JSONArray(Fixtures.read("trim.json"));
        assertTrue(cases.length() > 10);
        assertEquals('\uFEFF', cases.getJSONObject(5).getString("input").charAt(0));
        for (int i = 0; i < cases.length(); i++) {
            JSONObject entry = cases.getJSONObject(i);
            String input = entry.getString("input");
            assertEquals(input, entry.getString("trimmed"), WorkspaceOrigin.trimInput(input));
            WorkspaceOrigin origin = WorkspaceOrigin.parseInput(input);
            String expected = entry.isNull("origin") ? null : entry.getString("origin");
            assertEquals(input, expected, origin == null ? null : origin.serialized());
        }
    }

    /** What WebMessageListener hands the listener as sourceOrigin. */
    @Test
    public void listenerSourceOrigins() {
        assertEquals(saved, WorkspaceOrigin.parse("https://mac.tailnet123.ts.net"));
        assertNull(WorkspaceOrigin.parse("null")); // an opaque (sandboxed) frame
        assertNull(WorkspaceOrigin.parse(null));
        assertNotEquals(saved, WorkspaceOrigin.parse("https://mac.tailnet123.ts.net:8444"));
        assertNotEquals(saved, WorkspaceOrigin.parse("https://mac.tailnet123.ts.net."));
    }

    @Test
    public void containsOnlyTheSameSchemeHostAndPort() {
        WorkspaceOrigin other = WorkspaceOrigin.parse("https://mac.tailnet123.ts.net:8444");
        assertTrue(other.contains("https://mac.tailnet123.ts.net:8444/enter"));
        assertFalse(other.contains("https://mac.tailnet123.ts.net/"));
        assertFalse(other.contains("https://mac.tailnet123.ts.net.evil.example:8444/"));
        assertFalse(other.contains("http://mac.tailnet123.ts.net:8444/"));
        assertFalse(other.contains("blob:https://mac.tailnet123.ts.net:8444/0b8e5c2a"));
        assertFalse(other.contains(null));
    }

    /** Only the authority decides: characters java.net.URI would choke on in a path or query do not matter. */
    @Test
    public void pathAndQueryDoNotAffectTheOrigin() {
        assertEquals(saved, WorkspaceOrigin.parse("https://mac.tailnet123.ts.net/?q=a|b[1]"));
        assertEquals(saved, WorkspaceOrigin.parse("https://mac.tailnet123.ts.net/ü"));
        assertEquals(saved, WorkspaceOrigin.parse("https://mac.tailnet123.ts.net/a{b}^c`d"));
        assertTrue(saved.contains("https://mac.tailnet123.ts.net/?q=a|b[1]"));
        // The oracle's label rule: "xn--" ends with "-".
        assertNull(WorkspaceOrigin.parse("https://xn--.tailnet123.ts.net"));
    }

    /** Only ASCII is read as a host, before lower-casing (U+212A KELVIN SIGN lower-cases to "k"). */
    @Test
    public void refusesAHostThatOnlyLowerCasesToAscii() {
        assertNull(WorkspaceOrigin.parse("https://Kac.tailnet123.ts.net"));
    }

    /** Java-only pins: look-alike or invisible characters in the host are refused, never folded. */
    @Test
    public void refusesLookAlikeAndInvisibleHostCharacters() {
        assertNull(WorkspaceOrigin.parse("https://mac.tailnet123.ts.net\uFF1A8444")); // fullwidth colon
        assertNull(WorkspaceOrigin.parse("https://ma\u200Dc.tailnet123.ts.net")); // ZWJ
        assertNull(WorkspaceOrigin.parse("https://ma\u200Bc.tailnet123.ts.net")); // ZWSP
        assertNull(WorkspaceOrigin.parse("https://\u0131mac.tailnet123.ts.net")); // dotless i
        assertEquals(saved, WorkspaceOrigin.parse("https://mac.tailnet123.ts.net:00443"));
        assertEquals(saved, WorkspaceOrigin.parse("https://mac.tailnet123.ts.net:00443/x"));
    }

    /** The launcher's typed input (P17 twin): Swift's whitespacesAndNewlines are trimmed first; the rule then applies. */
    @Test
    public void parseInputTrimsWhitespaceAndNewlines() {
        for (String text : new String[] {"https://mac.example.ts.net\n", "\t https://mac.example.ts.net \r\n", "\u00a0https://mac.example.ts.net\u2028", "\u0085https://mac.example.ts.net\u3000"}) {
            WorkspaceOrigin origin = WorkspaceOrigin.parseInput(text);
            assertNotNull(text, origin);
            assertEquals("https://mac.example.ts.net", origin.serialized());
        }
        assertNull(WorkspaceOrigin.parseInput(null));
        assertNull(WorkspaceOrigin.parseInput("  \n "));
        assertNull("inside the text it is still refused", WorkspaceOrigin.parseInput("https://mac.example\n.ts.net"));
        assertNull("parse itself trims U+0020 only", WorkspaceOrigin.parse("https://mac.example.ts.net\n"));
    }
}
