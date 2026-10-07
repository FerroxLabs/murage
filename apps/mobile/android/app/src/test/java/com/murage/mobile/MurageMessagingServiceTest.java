package com.murage.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.murage.mobile.shell.PushContract;
import com.murage.mobile.shell.PushLedger;
import com.murage.mobile.shell.PushOutcome;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

/** The service's own guards (A3 review Minor 5) and the ledger written after the post (Minor 3). */
public class MurageMessagingServiceTest {
    private final FakePrefs prefs = new FakePrefs();
    private final List<String> fetched = new ArrayList<>();
    private final List<PushOutcome.Detail> posted = new ArrayList<>();
    private final List<Integer> totals = new ArrayList<>();

    private static PushContract.Payload payload(int revision, int badge) {
        Map<String, String> d = new HashMap<>();
        d.put("bindingId", PushFakes.BINDING); d.put("eventRef", PushFakes.REF); d.put("category", "approval");
        d.put("revision", String.valueOf(revision)); d.put("workspaceBadge", String.valueOf(badge));
        d.put("collapseKey", PushFakes.KEY); d.put("threadGroup", "ef".repeat(8));
        PushContract.Payload p = PushContract.Payload.fromFcmData(d);
        if (p == null) throw new AssertionError("payload");
        return p;
    }

    private MurageMessagingService.Fetch fetch() {
        return (origin, token) -> {
            fetched.add(origin + " " + token);
            return PushDetailFetch.generic(PushContract.Category.QUESTION);
        };
    }

    private boolean deliver(PushStore store, PushContract.Payload p) {
        return MurageMessagingService.deliver(store, p, fetch(), (q, detail, total) -> { posted.add(detail); totals.add(total); });
    }

    @Test public void aBoundComputerWithItsTokenFetchesWithTheDetailTokenAndPosts() {
        PushStore store = PushFakes.bound(prefs, PushFakes.memoryKey(), PushFakes.memoryKey(), true);
        assertTrue(deliver(store, payload(1, 2)));
        assertEquals(List.of(PushFakes.ORIGIN + " " + PushFakes.DETAIL), fetched);
        assertEquals(1, posted.size());
        assertEquals(Integer.valueOf(2), totals.get(0));
    }

    @Test public void noDetailTokenPostsTheGenericTextWithoutAFetch() {
        PushStore store = PushFakes.bound(prefs, PushFakes.memoryKey(), PushFakes.memoryKey(), false);
        assertTrue(deliver(store, payload(1, 1)));
        assertTrue(fetched.isEmpty());
        assertEquals("Your attention is needed.", posted.get(0).body);
        assertNull(posted.get(0).target);
    }

    @Test public void anUnreadableDetailTokenPostsTheGenericTextWithoutAFetch() {
        SecureStore.Keys detail = PushFakes.memoryKey();
        PushFakes.bound(prefs, detail, PushFakes.memoryKey(), true);
        PushStore locked = new PushStore(prefs, PushFakes.lockedKey(), PushFakes.memoryKey());
        assertTrue(deliver(locked, payload(1, 1)));
        assertTrue(fetched.isEmpty());
        assertEquals("Your attention is needed.", posted.get(0).body);
    }

    @Test public void aRemovedComputerHasNoOriginAndIsDropped() {
        PushStore store = new PushStore(prefs, PushFakes.memoryKey(), PushFakes.memoryKey());
        assertFalse(deliver(store, payload(1, 1)));
        assertTrue(fetched.isEmpty());
        assertTrue(posted.isEmpty());
    }

    /** Review Minor 1: the host took a replace this phone has not committed yet; iOS shows generic text for it too. */
    @Test public void aPendingReplacesBindingPostsTheGenericTextWithoutAFetch() {
        PushStore store = new PushStore(prefs, PushFakes.memoryKey(), PushFakes.memoryKey());
        List<String> asked = new ArrayList<>();
        assertTrue(MurageMessagingService.deliver(store, payload(1, 1), fetch(), (q, detail, total) -> { posted.add(detail); totals.add(total); },
            id -> { asked.add(id); return id.equals(PushFakes.BINDING); }));
        assertEquals(List.of(PushFakes.BINDING), asked);
        assertTrue(fetched.isEmpty());
        assertEquals(1, posted.size());
        assertNull(posted.get(0).target);
        assertTrue(store.ledger().bindingIds().isEmpty()); // nothing recorded for a binding the ledger does not hold
        // Not pending: still the removed computer's silent drop.
        assertFalse(MurageMessagingService.deliver(store, payload(2, 1), fetch(), (q, d, t) -> posted.add(d), id -> false));
        assertEquals(1, posted.size());
    }

    @Test public void aStaleOrRepeatedRevisionIsDroppedBeforeAnyFetch() {
        PushStore store = PushFakes.bound(prefs, PushFakes.memoryKey(), PushFakes.memoryKey(), true);
        assertTrue(deliver(store, payload(2, 1)));
        assertFalse(deliver(store, payload(2, 1)));
        assertFalse(deliver(store, payload(1, 1)));
        assertEquals(1, fetched.size());
        assertEquals(1, posted.size());
        assertTrue(deliver(store, payload(3, 1)));
    }

    @Test public void aPostThatThrowsLeavesTheRevisionUnseenSoARedeliveryShows() {
        PushStore store = PushFakes.bound(prefs, PushFakes.memoryKey(), PushFakes.memoryKey(), true);
        try {
            MurageMessagingService.deliver(store, payload(1, 1), fetch(), (q, d, t) -> { throw new IllegalStateException("channel"); });
            fail("the post should throw");
        } catch (IllegalStateException expected) {
            // FCM logs it; the message may come again
        }
        assertEquals(PushLedger.Accept.SHOW, store.ledger().accept(PushFakes.BINDING, PushFakes.KEY, 1, 1));
        assertTrue(deliver(store, payload(1, 1)));
        assertEquals(1, posted.size());
        assertEquals(PushLedger.Accept.STALE, store.ledger().accept(PushFakes.BINDING, PushFakes.KEY, 1, 1));
    }
}
