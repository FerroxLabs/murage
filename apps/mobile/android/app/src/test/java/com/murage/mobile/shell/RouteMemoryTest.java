package com.murage.mobile.shell;

import static org.junit.Assert.*;

import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class RouteMemoryTest {
    static final class MemoryStore implements KeyValueStore {
        final Map<String, String> values = new HashMap<>();
        @Override public String get(String key) { return values.get(key); }
        @Override public void put(String key, String value) { if (value == null) values.remove(key); else values.put(key, value); }
    }

    private final WorkspaceOrigin mac = WorkspaceOrigin.parse("https://mac.tailnet123.ts.net");
    private final WorkspaceOrigin server = WorkspaceOrigin.parse("https://server.tailnet123.ts.net");

    @Test public void returnsToTheLastConversationPerComputer() {
        RouteMemory memory = new RouteMemory(new MemoryStore());
        assertEquals("/", memory.startPath(mac));
        assertTrue(memory.remember("t1", mac));
        assertEquals("/#open=t1", memory.startPath(mac));
        assertEquals("/", memory.startPath(server));
        assertFalse(memory.remember("", mac));
    }

    @Test public void aPendingOpenWinsUntilThePageIsReady() {
        RouteMemory memory = new RouteMemory(new MemoryStore());
        memory.remember("t1", mac);
        assertTrue(memory.setPending(new PendingOpen(mac, "p1", "m1")));
        assertEquals("/#open=p1&msg=m1", memory.startPath(mac));
        memory.clearPending(server);
        assertNotNull(memory.pending());
        memory.clearPending(mac);
        assertEquals("/#open=t1", memory.startPath(mac));
    }

    /** Android recreates the WebView after a renderer crash and loses sessionStorage (Phase 0). */
    @Test public void survivesANewProcess() {
        MemoryStore store = new MemoryStore();
        new RouteMemory(store).remember("t1", mac);
        new RouteMemory(store).setPending(new PendingOpen(server, "p1", null));
        RouteMemory later = new RouteMemory(store);
        assertEquals("/#open=t1", later.startPath(mac));
        assertEquals("/#open=p1", later.startPath(server));
    }

    @Test public void forgettingAComputerClearsItsRouteAndIntent() {
        RouteMemory memory = new RouteMemory(new MemoryStore());
        memory.remember("t1", mac);
        memory.setPending(new PendingOpen(mac, "p1", null));
        memory.forget(mac);
        assertEquals("/", memory.startPath(mac));
        assertNull(memory.pending());
        assertFalse(memory.setPending(new PendingOpen(mac, "", null)));
    }

    /** Only thread ids and bare origins are kept: never the pairing credential from an /enter link. */
    @Test public void neverStoresTheCredential() {
        MemoryStore store = new MemoryStore();
        RouteMemory memory = new RouteMemory(store);
        WorkspaceOrigin paired = WorkspaceOrigin.parse("https://mac.tailnet123.ts.net/enter#murage_pair_secret&installId=abcdefghijklmnop");
        memory.remember("t1", paired);
        memory.setPending(new PendingOpen(paired, "p1", "m1"));
        assertEquals(2, store.values.size());
        for (Map.Entry<String, String> entry : store.values.entrySet()) {
            assertTrue(entry.getKey(), entry.getKey().equals(RouteMemory.PENDING_KEY) || entry.getKey().equals("murage.route.https://mac.tailnet123.ts.net"));
            assertFalse(entry.getValue(), (entry.getKey() + entry.getValue()).contains("murage_pair"));
            assertFalse(entry.getValue(), (entry.getKey() + entry.getValue()).contains("enter"));
        }
    }

    @Test public void aDamagedPendingIntentIsIgnored() {
        MemoryStore store = new MemoryStore();
        RouteMemory memory = new RouteMemory(store);
        memory.remember("t1", mac);
        for (String bad : new String[] {"garbage", "{}", "{\"origin\":5,\"threadId\":\"p1\"}", "{\"origin\":\"https://mac.tailnet123.ts.net\",\"threadId\":7}",
                "{\"origin\":\"https://mac.tailnet123.ts.net\",\"threadId\":\"\"}"}) {
            store.values.put(RouteMemory.PENDING_KEY, bad);
            assertNull(bad, memory.pending());
            assertEquals(bad, "/#open=t1", memory.startPath(mac));
        }
        // A wrongly typed messageId voids the record, as Swift's JSONDecoder does; a null one is just absent.
        store.values.put(RouteMemory.PENDING_KEY, "{\"origin\":\"https://mac.tailnet123.ts.net\",\"threadId\":\"p1\",\"messageId\":5}");
        assertEquals("/#open=t1", memory.startPath(mac));
        store.values.put(RouteMemory.PENDING_KEY, "{\"origin\":\"https://mac.tailnet123.ts.net\",\"threadId\":\"p1\",\"messageId\":null}");
        assertEquals("/#open=p1", memory.startPath(mac));
    }
}
