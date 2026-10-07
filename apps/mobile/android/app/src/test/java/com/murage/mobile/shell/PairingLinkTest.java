package com.murage.mobile.shell;

import static org.junit.Assert.*;

import java.util.UUID;
import org.junit.Test;

public class PairingLinkTest {
    private static final String INSTALL = "and-0123456789abcdef0123456789abcdef";

    @Test
    public void fullModeAppendsTheInstallId() {
        assertEquals("/enter#murage_pair_abc&installId=" + INSTALL, PairingLink.enterPath("murage_pair_abc", INSTALL));
        assertEquals("/enter#123456&installId=" + INSTALL, PairingLink.enterPath("123456", INSTALL));
    }

    @Test
    public void noInstallIdForAnOlderDoor() {
        assertEquals("/enter#murage_pair_abc", PairingLink.enterPath("murage_pair_abc", null));
    }

    @Test
    public void refusesACredentialThatCouldCarryItsOwnSuffix() {
        assertNull(PairingLink.enterPath("abc&installId=x", null));
        assertNull(PairingLink.enterPath("12 34 56", null));
        assertNull(PairingLink.enterPath("", null));
        assertNull(PairingLink.enterPath(null, null));
        assertNull(PairingLink.enterPath("a".repeat(513), null));
        assertNull(PairingLink.enterPath("abc\n", null));
        assertNull(PairingLink.enterPath("abc", "short"));
    }

    @Test
    public void newInstallIdsMatchTheDoorsPattern() {
        String id = PairingLink.newInstallId("and", UUID.fromString("e621e1f8-c36c-495a-93fc-0c247a3e6e5f"));
        assertEquals("and-e621e1f8c36c495a93fc0c247a3e6e5f", id);
        assertTrue(PairingLink.validInstallId(id));
        assertFalse(PairingLink.validInstallId(null));
    }

    /** P17 twin: the QR scanner hands the launcher only {@code <origin>/enter#<credential>}. */
    @Test
    public void parsesTheComputersPairingLink() {
        PairingLink.Link link = PairingLink.parse("https://Mac.tailnet123.ts.net:443/enter#murage_pair_abc");
        assertEquals("https://mac.tailnet123.ts.net", link.origin.serialized());
        assertEquals("murage_pair_abc", link.credential);
        assertEquals(8444, PairingLink.parse(" https://mac.tailnet123.ts.net:8444/enter#123456 ").origin.port);
    }

    /** The same refusals as PairingLinkTests.swift, plus the 4096 cap Swift applies. */
    @Test
    public void refusesAnyOtherCode() {
        String[] refused = {
            "https://mac.tailnet123.ts.net/",
            "https://mac.tailnet123.ts.net/enter",
            "https://mac.tailnet123.ts.net/enter#",
            "https://mac.tailnet123.ts.net/enter/#murage_pair_abc",
            "https://mac.tailnet123.ts.net/other#murage_pair_abc",
            "https://mac.tailnet123.ts.net/enter?x=1#murage_pair_abc",
            "https://mac.tailnet123.ts.net/enter#murage_pair_abc&installId=ios-0123456789abcdef",
            "https://mac.tailnet123.ts.net/enter#a#b",
            "http://mac.tailnet123.ts.net/enter#murage_pair_abc",
            "https://user@mac.tailnet123.ts.net/enter#murage_pair_abc",
            "https://100.64.0.1/enter#murage_pair_abc",
            "https://mac.tailnet123.ts.net/enter#murage_pair_abc\n",
            "WIFI:S:home;T:WPA;P:secret;;",
            "https://mac.tailnet123.ts.net/enter#" + "a".repeat(513),
            "https://mac.tailnet123.ts.net/enter#123456" + " ".repeat(4096),
        };
        assertEquals(15, refused.length);
        for (String text : refused) assertNull(text, PairingLink.parse(text));
        assertNull(PairingLink.parse(null));
    }

    /** Only U+0020 is trimmed, like Swift and WorkspaceOrigin: a tab or newline is refused. */
    @Test
    public void trimsSpacesOnly() {
        assertNotNull(PairingLink.parse("  https://mac.tailnet123.ts.net/enter#123456  "));
        assertNull(PairingLink.parse("\thttps://mac.tailnet123.ts.net/enter#123456"));
        assertNull(PairingLink.parse("https://mac.tailnet123.ts.net/enter#123456\u00a0"));
    }

    @Test
    public void enterPathCarriesTheApprovalKeyOnlyWithAStatement() {
        String install = "android-0123456789abcdef0123456789abcdef";
        String key = "B".repeat(87);
        String statement = "S".repeat(120) + "." + "T".repeat(86);
        assertEquals("/enter#murage_pair_abc&installId=" + install, PairingLink.enterPath("murage_pair_abc", install, null, null));
        // F2: a key with no statement cannot be built by API shape.
        assertNull(PairingLink.enterPath("murage_pair_abc", install, key, null));
        assertNull(PairingLink.enterPath("murage_pair_abc", null, key, statement));
        assertNull(PairingLink.enterPath("murage_pair_abc", install, "short", statement));
        assertNull(PairingLink.enterPath("murage_pair_abc", install, "B".repeat(86) + "=", statement));
    }

    /** Desktop order (companion/src/browser.ts enterPage): installId, approvalKey, approvalStatement. */
    @Test
    public void enterPathCarriesTheRelayStatementLast() {
        String install = "android-0123456789abcdef0123456789abcdef";
        String key = "B".repeat(87);
        String statement = "S".repeat(120) + "." + "T".repeat(86);
        assertEquals("/enter#murage_pair_abc&installId=" + install + "&approvalKey=" + key + "&approvalStatement=" + statement,
                PairingLink.enterPath("murage_pair_abc", install, key, statement));
        assertNull(PairingLink.enterPath("murage_pair_abc", install, null, statement));
        String[] bad = {"nodot", "S".repeat(39) + "." + "T".repeat(86), "S".repeat(120) + "." + "T".repeat(85), "S".repeat(1201) + "." + "T".repeat(86), "a&b." + "T".repeat(86)};
        for (String b : bad) assertNull(b, PairingLink.enterPath("murage_pair_abc", install, key, b));
    }
}
