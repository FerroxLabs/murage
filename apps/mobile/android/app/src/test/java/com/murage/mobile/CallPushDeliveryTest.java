package com.murage.mobile;

import static org.junit.Assert.*;
import com.murage.mobile.shell.NotificationPlan;
import com.murage.mobile.shell.PushContract;
import com.murage.mobile.shell.PushOutcome;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONObject;
import org.junit.Test;

public class CallPushDeliveryTest {
    private final FakePrefs prefs = new FakePrefs();
    private final List<PushOutcome.Detail> posted = new ArrayList<>();
    private long now = 999;
    private PushStore store() { return PushFakes.bound(prefs, PushFakes.memoryKey(), PushFakes.memoryKey(), true); }
    private static PushContract.Payload payload(String category, int revision) {
        Map<String, String> d = new HashMap<>();
        d.put("bindingId", PushFakes.BINDING); d.put("eventRef", PushFakes.REF); d.put("category", category);
        d.put("revision", String.valueOf(revision)); d.put("workspaceBadge", "1");
        d.put("collapseKey", PushFakes.KEY); d.put("threadGroup", "ef".repeat(8));
        if (category.equals("call") || category.equals("call-note")) d.put("expiresAt", "1000");
        PushContract.Payload p = PushContract.Payload.fromFcmData(d);
        assertNotNull(p);
        return p;
    }
    private boolean deliver(PushStore store, PushContract.Payload p, MurageMessagingService.Fetch fetch) {
        return MurageMessagingService.deliver(store, p, fetch, (q, d, total) -> posted.add(d), id -> false, () -> now);
    }
    private MurageMessagingService.Fetch neverFetch() {
        return (o, t) -> { fail("must not fetch"); return null; };
    }
    private static PushOutcome.Detail preview() {
        try {
            return PushOutcome.detail(200, new JSONObject().put("title", "Private bot").put("body", "Private preview")
                .put("target", new JSONObject().put("threadId", "call-thread")), PushContract.Category.QUESTION);
        } catch (Exception e) { throw new AssertionError(e); }
    }

    @Test public void callsAndNotesAlwaysUseClosedCopyEvenIfFetcherReturnsAPreview() {
        for (String kind : new String[] {"call", "call-note"}) {
            PushStore s = PushFakes.bound(new FakePrefs(), PushFakes.memoryKey(), PushFakes.memoryKey(), true);
            PushContract.Payload p = payload(kind, 1);
            assertTrue(deliver(s, p, (o, t) -> preview()));
            PushOutcome.Detail shown = posted.get(posted.size() - 1);
            assertEquals(p.category.genericTitle(), shown.title);
            assertEquals(p.category.genericBody(), shown.body);
            assertEquals("call-thread", shown.target.threadId);
            assertFalse(shown.silent);
        }
    }

    @Test public void atAndAfterExpiryCallsAndNotesPostSilentlyWithoutFetch() {
        for (String kind : new String[] {"call", "call-note"}) {
            for (long instant : new long[] {1000, 1001}) {
                PushStore s = PushFakes.bound(new FakePrefs(), PushFakes.memoryKey(), PushFakes.memoryKey(), true);
                now = instant;
                PushContract.Payload p = payload(kind, 1);
                assertTrue(deliver(s, p, neverFetch()));
                PushOutcome.Detail shown = posted.get(posted.size() - 1);
                assertTrue(shown.silent);
                assertEquals(p.category.genericTitle(), shown.title);
                assertEquals(p.category.genericBody(), shown.body);
                assertNull(shown.target);
                NotificationPlan.Plan plan = NotificationPlan.of(p.category, 34, true, shown.silent);
                assertTrue(plan.silent);
                assertTrue(plan.actions.isEmpty());
            }
        }
    }

    @Test public void expiredPendingBindingCannotRing() {
        PushStore s = new PushStore(prefs, PushFakes.memoryKey(), PushFakes.memoryKey());
        now = 1000;
        assertTrue(MurageMessagingService.deliver(s, payload("call", 1), neverFetch(),
            (p, d, total) -> posted.add(d), id -> true, () -> now));
        assertTrue(posted.get(0).silent);
    }

    @Test public void boundResolvedIsSilentAndItsPersistedRevisionSuppressesALateRing() {
        PushStore s = store();
        assertTrue(deliver(s, payload("resolved", 2), neverFetch()));
        assertTrue(posted.get(0).silent);
        // A new store reads the on-disk ledger, as a restarted FCM service does.
        PushStore restored = new PushStore(prefs, PushFakes.memoryKey(), PushFakes.memoryKey());
        assertFalse(deliver(restored, payload("call", 1), neverFetch()));
        assertEquals(1, posted.size());
        assertEquals(Integer.valueOf(2), restored.ledger().revision(PushFakes.KEY));
    }

    @Test public void pendingBindingResolutionPersistsAndSuppressesLateRingsBeforeAndAfterAdoption() {
        PushStore s = new PushStore(prefs, PushFakes.memoryKey(), PushFakes.memoryKey());
        assertTrue(MurageMessagingService.deliver(s, payload("resolved", 2), neverFetch(),
            (p, d, total) -> posted.add(d), id -> true, () -> now));
        assertTrue(posted.get(0).silent);
        PushStore restored = new PushStore(prefs, PushFakes.memoryKey(), PushFakes.memoryKey());
        assertEquals(Integer.valueOf(2), restored.ledger().revision(PushFakes.KEY));
        assertTrue(restored.ledger().bindingIds().isEmpty());
        assertEquals(0, restored.ledger().total());
        for (int revision : new int[] {1, 2}) {
            assertFalse(MurageMessagingService.deliver(restored, payload("call", revision), neverFetch(),
                (p, d, total) -> posted.add(d), id -> true, () -> now));
        }
        restored.updateLedger(l -> { l.bind(PushFakes.BINDING, PushFakes.ORIGIN); return null; });
        assertFalse(deliver(restored, payload("call", 1), neverFetch()));
        assertEquals(1, posted.size());
    }

    @Test public void failedPendingPostLeavesTheRevisionAvailableForRedelivery() {
        PushStore s = new PushStore(prefs, PushFakes.memoryKey(), PushFakes.memoryKey());
        try {
            MurageMessagingService.deliver(s, payload("resolved", 2), neverFetch(),
                (p, d, total) -> { throw new IllegalStateException("post failed"); }, id -> true, () -> now);
            fail("post should throw");
        } catch (IllegalStateException expected) {
            assertNull(s.ledger().revision(PushFakes.KEY));
        }
        assertTrue(MurageMessagingService.deliver(s, payload("resolved", 2), neverFetch(),
            (p, d, total) -> posted.add(d), id -> true, () -> now));
        assertEquals(Integer.valueOf(2), s.ledger().revision(PushFakes.KEY));
    }

    @Test public void postedRingMakesResolutionReplaceQuietlyAndPreservesOtherCalls() {
        PushStore s = store();
        Map<String, PushOutcome.Detail> notifications = new HashMap<>();
        notifications.put("other-call", preview());
        assertTrue(MurageMessagingService.deliver(s, payload("call", 1), (o, t) -> preview(),
            (p, d, total) -> notifications.put(p.collapseKey, d), id -> false, () -> now, notifications::keySet));
        PushContract.Payload resolved = payload("resolved", 2);
        assertEquals("replace", PushContract.callDisplayAction(resolved, now, notifications.keySet()));
        assertTrue(MurageMessagingService.quiet(resolved, now, notifications.keySet()));
        List<String> lookedUp = new ArrayList<>();
        List<String> shown = new ArrayList<String>(notifications.keySet()) {
            @Override public boolean contains(Object key) {
                lookedUp.add((String) key);
                return super.contains(key);
            }
        };
        assertTrue(MurageMessagingService.deliver(s, resolved, neverFetch(),
            (p, d, total) -> notifications.put(p.collapseKey, d), id -> false, () -> now,
            () -> shown));
        // A resolved shortcut or shown=[] would never consult the posted call keys.
        assertFalse(lookedUp.isEmpty());
        for (String key : lookedUp) assertEquals(PushFakes.KEY, key);
        assertTrue(notifications.get(PushFakes.KEY).silent);
        assertFalse(notifications.get("other-call").silent);
        assertEquals(2, notifications.size());
    }

    @Test public void aResolutionAfterARingPostsQuietlyToTheSameCollapseKey() {
        PushStore s = store();
        assertTrue(deliver(s, payload("call", 1), (o, t) -> preview()));
        assertTrue(deliver(s, payload("resolved", 2), neverFetch()));
        assertFalse(posted.get(0).silent);
        assertTrue(posted.get(1).silent);
        assertFalse(deliver(s, payload("call", 1), neverFetch()));
        assertEquals(2, posted.size());
    }

    @Test public void expiryDuringTheFetchIsRechecked() {
        PushStore s = store();
        assertTrue(deliver(s, payload("call", 1), (o, t) -> { now = 1000; return preview(); }));
        assertTrue(posted.get(0).silent);
        assertEquals(PushContract.Category.CALL.genericBody(), posted.get(0).body);
        assertNull(posted.get(0).target);
    }

    @Test public void resolutionDuringTheFetchCannotBeOverwrittenByTheOldRing() {
        PushStore s = store();
        assertFalse(deliver(s, payload("call", 1), (o, t) -> {
            assertTrue(deliver(s, payload("resolved", 2), neverFetch()));
            return preview();
        }));
        assertEquals(1, posted.size());
        assertTrue(posted.get(0).silent);
    }

    @Test public void callActionsRequireAuthenticationSupportAndAnswerRouteRemainsValid() {
        for (int sdk : new int[] {29, 30, 31, 34}) {
            NotificationPlan.Plan plan = NotificationPlan.of(PushContract.Category.CALL, sdk, true);
            assertEquals("calls_v2", plan.channel);
            assertEquals(sdk >= 31 ? Arrays.asList("ANSWER", "NOT_NOW") : Arrays.asList("OPEN"), plan.actions);
            assertEquals(sdk >= 31, plan.authRequired);
            assertFalse(plan.silent);
        }
        assertTrue(CallAnswerRoute.isNotNow("NOT_NOW"));
        assertFalse(CallAnswerRoute.isNotNow("ANSWER"));
        assertEquals("call-thread", CallAnswerRoute.thread("call-thread"));
        assertNull(CallAnswerRoute.thread(""));
        assertNull(CallAnswerRoute.thread(null));
    }
}
