package com.murage.mobile.shell;

import static org.junit.Assert.*;

import java.nio.charset.StandardCharsets;
import org.junit.Test;
import org.json.JSONArray;
import org.json.JSONObject;

public class WorkspaceBookTest {
    private final WorkspaceOrigin mac = WorkspaceOrigin.parse("https://mac.tailnet123.ts.net");
    private final WorkspaceOrigin server = WorkspaceOrigin.parse("https://server.tailnet123.ts.net");

    @Test public void signingInSavesNamesAndActivates() {
        WorkspaceBook book = new WorkspaceBook();
        book.signedIn(server, null, 1_000);
        assertEquals("server", book.entry(server).name);
        book.signedIn(server, "Home server", 2_000);
        book.signedIn(server, null, 3_000);
        assertEquals("Home server", book.entry(server).name);
        assertEquals(3_000, book.entry(server).lastConnected);
        assertEquals("https://server.tailnet123.ts.net", book.active());
    }

    @Test public void newestFirstRemovalAndTheLimit() {
        WorkspaceBook book = new WorkspaceBook();
        book.signedIn(mac, null, 1_000);
        book.signedIn(server, null, 2_000);
        assertEquals(server.serialized(), book.sorted().get(0).origin);
        book.remove(server);
        assertNull(book.active());
        for (int i = 0; i < 21; i++) book.signedIn(WorkspaceOrigin.parse("https://host" + i + ".tailnet123.ts.net"), null, 10_000 + i);
        assertEquals(20, book.sorted().size());
        assertNull(book.entry(mac));
    }

    @Test public void decodingIsForgivingAndRoundTrips() {
        assertEquals(0, WorkspaceBook.decode(null).sorted().size());
        assertEquals(0, WorkspaceBook.decode("garbage".getBytes(StandardCharsets.UTF_8)).sorted().size());
        String dirty = "{\"workspaces\":[{\"origin\":\"http://bad\",\"name\":\"x\",\"lastConnected\":1},"
            + "{\"origin\":\"https://Mac.tailnet123.ts.net\",\"name\":\"Mac\",\"lastConnected\":2}],\"active\":\"http://bad\"}";
        WorkspaceBook book = WorkspaceBook.decode(dirty.getBytes(StandardCharsets.UTF_8));
        assertEquals(1, book.sorted().size());
        assertEquals("https://mac.tailnet123.ts.net", book.sorted().get(0).origin);
        assertNull(book.active());
        book.signedIn(mac, "Mac", 5);
        WorkspaceBook again = WorkspaceBook.decode(book.encode());
        assertEquals("Mac", again.entry(mac).name);
        assertEquals(mac.serialized(), again.active());
    }

    /** The book keeps origin, name and time only: no credential, cookie or unknown field survives a round trip. */
    @Test public void neverPersistsCredentialsOrUnknownFields() throws Exception {
        String stored = "{\"workspaces\":[{\"origin\":\"https://mac.tailnet123.ts.net\",\"name\":\"Mac\",\"lastConnected\":2,"
            + "\"credential\":\"murage_pair_secret\",\"cookie\":\"murage_session=abc\"}],\"active\":\"https://mac.tailnet123.ts.net\",\"token\":\"murage_pair_secret\"}";
        WorkspaceBook book = WorkspaceBook.decode(stored.getBytes(StandardCharsets.UTF_8));
        book.signedIn(WorkspaceOrigin.parse("https://server.tailnet123.ts.net/enter#murage_pair_other&installId=abcdefghijklmnop"), null, 3);
        String encoded = new String(book.encode(), StandardCharsets.UTF_8);
        assertFalse(encoded, encoded.contains("murage_pair"));
        assertFalse(encoded, encoded.contains("murage_session"));
        assertFalse(encoded, encoded.contains("enter"));
        JSONObject json = new JSONObject(encoded);
        assertEquals(2, json.length());
        JSONArray list = json.getJSONArray("workspaces");
        for (int i = 0; i < list.length(); i++) assertEquals(3, list.getJSONObject(i).length());
        assertEquals("https://server.tailnet123.ts.net", book.active());
    }

    /** Every row of contract/origins.json: a saved origin survives decoding only if it parses, and only in its clean form. */
    @Test public void sharedOriginRows() throws Exception {
        JSONArray cases = new JSONArray(Fixtures.read("origins.json"));
        for (int i = 0; i < cases.length(); i++) {
            JSONObject row = cases.getJSONObject(i);
            JSONObject item = new JSONObject().put("origin", row.getString("input")).put("name", "x").put("lastConnected", 1);
            JSONObject stored = new JSONObject().put("workspaces", new JSONArray().put(item));
            WorkspaceBook book = WorkspaceBook.decode(stored.toString().getBytes(StandardCharsets.UTF_8));
            if (row.isNull("origin")) {
                assertEquals(row.getString("input"), 0, book.sorted().size());
            } else {
                assertEquals(row.getString("input"), row.getString("origin"), book.sorted().get(0).origin);
            }
        }
    }

    @Test public void decodingCleansNamesDuplicatesAndTheLimit() throws Exception {
        JSONArray list = new JSONArray();
        list.put(new JSONObject().put("origin", "https://mac.tailnet123.ts.net").put("name", 7).put("lastConnected", 1));
        list.put(new JSONObject().put("origin", "https://MAC.tailnet123.ts.net").put("name", "dup").put("lastConnected", 2));
        list.put(new JSONObject().put("origin", "https://server.tailnet123.ts.net").put("name", "s".repeat(500)).put("lastConnected", 3));
        for (int i = 0; i < 30; i++) list.put(new JSONObject().put("origin", "https://host" + i + ".tailnet123.ts.net").put("name", "h").put("lastConnected", 100 + i));
        JSONObject stored = new JSONObject().put("workspaces", list).put("active", "https://MAC.tailnet123.ts.net");
        WorkspaceBook book = WorkspaceBook.decode(stored.toString().getBytes(StandardCharsets.UTF_8));
        assertEquals(WorkspaceBook.LIMIT, book.sorted().size());
        assertEquals("https://host29.tailnet123.ts.net", book.sorted().get(0).origin);
        assertNull(book.entry(mac));
        // Like Swift, "active" must name a saved origin exactly.
        assertNull(book.active());

        WorkspaceBook small = WorkspaceBook.decode(new JSONObject().put("workspaces", new JSONArray().put(list.get(0)).put(list.get(1)).put(list.get(2)))
            .toString().getBytes(StandardCharsets.UTF_8));
        assertEquals(2, small.sorted().size());
        assertEquals("mac", small.entry(mac).name);
        assertEquals(200, small.entry(server).name.length());
    }

    /** The computer just signed in to is never the one evicted, even when its time is older than every other. */
    @Test public void signingInNeverEvictsTheNewEntry() {
        WorkspaceBook book = new WorkspaceBook();
        for (int i = 0; i < WorkspaceBook.LIMIT; i++) book.signedIn(WorkspaceOrigin.parse("https://host" + i + ".tailnet123.ts.net"), null, 10_000 + i);
        book.signedIn(mac, null, 5);
        assertEquals(WorkspaceBook.LIMIT, book.sorted().size());
        assertNotNull(book.entry(mac));
        assertEquals(mac.serialized(), book.active());
        assertNull(book.entry(WorkspaceOrigin.parse("https://host0.tailnet123.ts.net")));
    }

    /** Use after pairing moves the time on; it never adds a computer, never changes the active one, never evicts. */
    @Test public void touchingMovesTheTimeOfASavedComputerOnly() {
        WorkspaceBook book = new WorkspaceBook();
        book.signedIn(mac, "Sean's Mac", 1_000);
        book.signedIn(server, null, 2_000);
        assertTrue(book.touched(mac, 90_000));
        assertEquals(90_000, book.entry(mac).lastConnected);
        assertEquals("Sean's Mac", book.entry(mac).name);
        assertEquals(mac.serialized(), book.sorted().get(0).origin);
        assertEquals(server.serialized(), book.active());
        WorkspaceBook full = new WorkspaceBook();
        for (int i = 0; i < WorkspaceBook.LIMIT; i++) full.signedIn(WorkspaceOrigin.parse("https://host" + i + ".tailnet123.ts.net"), null, i);
        byte[] before = full.encode();
        assertFalse(full.touched(mac, 500_000)); // removed or never saved: nothing comes back
        assertArrayEquals(before, full.encode());
    }

    /** "Last connected" shows minutes: a touch within a minute of the saved time changes nothing, so nothing is saved. */
    @Test public void touchingWithinAMinuteChangesNothing() {
        WorkspaceBook book = new WorkspaceBook();
        book.signedIn(mac, null, 1_000_000);
        byte[] before = book.encode();
        assertFalse(book.touched(mac, 1_000_000));
        assertFalse(book.touched(mac, 1_059_999));
        assertArrayEquals(before, book.encode());
        assertTrue(book.touched(mac, 1_060_000));
        assertEquals(1_060_000, book.entry(mac).lastConnected);
        assertTrue(book.touched(mac, 5_000)); // a clock that went back: the time follows it
        assertEquals(5_000, book.entry(mac).lastConnected);
    }

    private static WorkspaceBook decodeList(JSONArray list) throws Exception {
        return WorkspaceBook.decode(new JSONObject().put("workspaces", list).toString().getBytes(StandardCharsets.UTF_8));
    }

    /** lastConnected is an integer or it is 0: a string such as "1e3" or a fraction is not read as a time. */
    @Test public void decodingReadsOnlyIntegerTimes() throws Exception {
        String stored = "{\"workspaces\":[{\"origin\":\"https://mac.tailnet123.ts.net\",\"lastConnected\":\"1e3\"},"
            + "{\"origin\":\"https://server.tailnet123.ts.net\",\"lastConnected\":1.5},"
            + "{\"origin\":\"https://host1.tailnet123.ts.net\",\"lastConnected\":1700000000000},"
            + "{\"origin\":\"https://host2.tailnet123.ts.net\",\"lastConnected\":7}]}";
        WorkspaceBook book = WorkspaceBook.decode(stored.getBytes(StandardCharsets.UTF_8));
        assertEquals(0, book.entry(mac).lastConnected);
        assertEquals(0, book.entry(server).lastConnected);
        assertEquals(1_700_000_000_000L, book.entry(WorkspaceOrigin.parse("https://host1.tailnet123.ts.net")).lastConnected);
        assertEquals(7, book.entry(WorkspaceOrigin.parse("https://host2.tailnet123.ts.net")).lastConnected);
    }

    /** P13 twin ruling: a duplicate origin keeps the first; at the cap, a tie drops the entry listed first among the oldest. */
    @Test public void decodingDuplicatesAndTies() throws Exception {
        JSONArray list = new JSONArray();
        list.put(new JSONObject().put("origin", "https://mac.tailnet123.ts.net").put("name", "first").put("lastConnected", 1));
        list.put(new JSONObject().put("origin", "https://mac.tailnet123.ts.net").put("name", "second").put("lastConnected", 9));
        assertEquals("first", decodeList(list).entry(mac).name);
        assertEquals(1, decodeList(list).entry(mac).lastConnected);

        JSONArray full = new JSONArray();
        for (int i = 0; i <= WorkspaceBook.LIMIT; i++) full.put(new JSONObject().put("origin", "https://host" + i + ".tailnet123.ts.net").put("lastConnected", i < 3 ? 5 : 100 + i));
        WorkspaceBook book = decodeList(full);
        assertEquals(WorkspaceBook.LIMIT, book.sorted().size());
        assertNull(book.entry(WorkspaceOrigin.parse("https://host0.tailnet123.ts.net")));
        assertNotNull(book.entry(WorkspaceOrigin.parse("https://host1.tailnet123.ts.net")));
        assertNotNull(book.entry(WorkspaceOrigin.parse("https://host2.tailnet123.ts.net")));
    }

    @Test public void entriesCannotBeChangedFromOutside() {
        WorkspaceBook book = new WorkspaceBook();
        book.signedIn(mac, "Mac", 1);
        WorkspaceBook.Entry before = book.entry(mac);
        book.signedIn(mac, "Renamed", 2);
        assertEquals("Mac", before.name);
        assertEquals("Renamed", book.entry(mac).name);
        book.sorted().clear();
        assertEquals(1, book.sorted().size());
    }
}
