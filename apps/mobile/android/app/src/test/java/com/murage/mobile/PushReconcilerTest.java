package com.murage.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.murage.mobile.shell.PushLedger;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

/** Spec §3.5: opening the app clears what was answered elsewhere and corrects the count (review focus 3). */
public class PushReconcilerTest {
    private static final String A = "aa".repeat(16), B = "bb".repeat(16);
    private final LogCapture log = new LogCapture();
    private final FakePrefs prefs = new FakePrefs();
    private final PushStore store = PushFakes.bound(prefs, PushFakes.memoryKey(), PushFakes.memoryKey(), true);

    private Map<String, List<String>> shown(String... tags) {
        Map<String, List<String>> m = new HashMap<>();
        m.put(PushFakes.BINDING, Arrays.asList(tags));
        return m;
    }

    @Test public void cancelsWhatIsNoLongerPendingAndTakesTheBadge() {
        PushFakes.Host host = new PushFakes.Host().answer(200, "{\"badge\":1,\"items\":[{\"collapseKey\":\"" + A + "\",\"revision\":2,\"category\":\"approval\"}]}");
        List<String> cancel = PushReconciler.sweep(store, host, shown(A, B));
        assertEquals(Collections.singletonList(B), cancel);
        assertEquals(1, store.ledger().total());
        assertEquals("GET", host.calls.get(0).method);
        assertEquals(PushFakes.ORIGIN + "/api/mobile/push/pending", host.calls.get(0).url);
        assertEquals(PushFakes.DETAIL, host.calls.get(0).token);
        // The pending revision is now seen: an older push for it is stale.
        assertEquals(PushLedger.Accept.STALE, store.ledger().accept(PushFakes.BINDING, A, 2, 1));
        assertFalse(log.all().contains(A));
        assertFalse(log.all().contains(PushFakes.DETAIL));
    }

    @Test public void anUnreachableOrOddHostCancelsNothing() {
        String[] odd = {null, "{\"badge\":1}", "{\"items\":[]}", "{\"badge\":-1,\"items\":[]}", "{\"badge\":1,\"items\":[{\"collapseKey\":1,\"revision\":2}]}", "{\"badge\":1,\"items\":[{\"collapseKey\":\"" + A + "\"}]}"};
        for (String body : odd) {
            PushFakes.Host host = new PushFakes.Host().answer(body == null ? null : 200, body);
            assertTrue(body, PushReconciler.sweep(store, host, shown(A, B)).isEmpty());
        }
        assertTrue(PushReconciler.sweep(store, new PushFakes.Host().answer(401, "{\"error\":\"sign in\"}"), shown(B)).isEmpty());
    }

    @Test public void aBindingWithoutItsDetailTokenIsSkipped() {
        PushStore noTokens = PushFakes.bound(new FakePrefs(), PushFakes.memoryKey(), PushFakes.memoryKey(), false);
        PushFakes.Host host = new PushFakes.Host();
        assertTrue(PushReconciler.sweep(noTokens, host, shown(A)).isEmpty());
        assertTrue(host.calls.isEmpty());
    }

    @Test public void anEmptyPendingListCancelsEverythingShownForThatBindingOnly() {
        PushFakes.Host host = new PushFakes.Host().answer(200, "{\"badge\":0,\"items\":[]}");
        Map<String, List<String>> shown = shown(A);
        // Another bound computer's notification (no tokens, so it is not asked): left alone.
        store.updateLedger(l -> { l.bind("22222222-2222-4222-8222-222222222222", "https://other.tail0000.ts.net"); return null; });
        shown.put("22222222-2222-4222-8222-222222222222", Collections.singletonList(B));
        assertEquals(Collections.singletonList(A), PushReconciler.sweep(store, host, shown));
        assertEquals(0, store.ledger().total());
    }

    // ---- A5 review fixes ----

    @Test public void aRemovedComputersNotificationsAreCancelled() {
        PushFakes.Host host = new PushFakes.Host().answer(200, "{\"badge\":1,\"items\":[{\"collapseKey\":\"" + A + "\",\"revision\":2}]}");
        Map<String, List<String>> shown = shown(A);
        shown.put("33333333-3333-4333-8333-333333333333", Arrays.asList(B, "cc".repeat(16))); // no longer on this phone
        List<String> cancel = PushReconciler.sweep(store, host, shown);
        assertEquals(Arrays.asList(B, "cc".repeat(16)), cancel);
    }

    /** Final review M5: a pending replace's notifications stay; a removed computer's still go. */
    @Test public void aPendingReplacesNotificationsAreKept() {
        PushFakes.Host host = new PushFakes.Host().answer(200, "{\"badge\":1,\"items\":[{\"collapseKey\":\"" + A + "\",\"revision\":2}]}");
        Map<String, List<String>> shown = shown(A);
        String waiting = "44444444-4444-4444-8444-444444444444";
        shown.put(waiting, Collections.singletonList(B));
        shown.put("33333333-3333-4333-8333-333333333333", Collections.singletonList("cc".repeat(16)));
        List<String> cancel = PushReconciler.sweep(store, host, shown, waiting::equals);
        assertEquals(Collections.singletonList("cc".repeat(16)), cancel);
    }

    @Test public void aNonCanonicalOriginIsNeverAsked() {
        for (String odd : new String[] {"https://mac.tail0000.ts.net:443", "https://MAC.tail0000.ts.net:8443", "https://mac.tail0000.ts.net:8443/x"}) {
            PushStore s = new PushStore(new FakePrefs(), PushFakes.memoryKey(), PushFakes.memoryKey());
            s.updateLedger(l -> { l.bind(PushFakes.BINDING, odd); return null; });
            assertTrue(s.putTokens(PushFakes.BINDING, PushFakes.DETAIL, PushFakes.RESPOND));
            PushFakes.Host none = new PushFakes.Host();
            assertTrue(odd, PushReconciler.sweep(s, none, shown(A)).isEmpty());
            assertTrue(odd, none.calls.isEmpty());
        }
    }
}
