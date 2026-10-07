package com.murage.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.murage.mobile.shell.PushOutcome;
import org.json.JSONObject;
import org.junit.Test;

/** Spec §3.5 actions and §7's local notice: every path ends in one notice (review focus 4). */
public class PushActionReceiverTest {
    private final LogCapture log = new LogCapture();
    private final FakePrefs prefs = new FakePrefs();
    private final SecureStore.Keys detailKey = PushFakes.memoryKey(), respondKey = PushFakes.memoryKey();

    private PushStore store() { return PushFakes.bound(prefs, detailKey, respondKey, true); }

    private static PushActionReceiver.Action action(String action, String requestId) {
        return new PushActionReceiver.Action(action, PushFakes.BINDING, PushFakes.REF, "approval", 3, requestId);
    }

    private void assertContentFree() {
        String all = log.all();
        for (String secret : new String[] {PushFakes.RESPOND, PushFakes.DETAIL, PushFakes.BINDING, PushFakes.REF, "req-1", "t-secret", "mac.tail"}) assertFalse(all.contains(secret));
    }

    @Test public void approvePostsTheStrictBodyWithTheRespondToken() throws Exception {
        PushFakes.Host host = new PushFakes.Host().answer(200, "{\"ok\":true,\"outcome\":\"answered\"}");
        PushActionReceiver.Result r = PushActionReceiver.answer(store(), host, action("APPROVE", "req-1"));
        assertEquals(PushOutcome.Notice.APPROVED, r.notice);
        assertEquals(1, host.calls.size());
        PushFakes.Call c = host.calls.get(0);
        assertEquals("POST", c.method);
        assertEquals(PushFakes.ORIGIN + "/api/mobile/push/respond", c.url);
        assertEquals(PushFakes.RESPOND, c.token);
        JSONObject body = new JSONObject(c.body);
        assertEquals(3, body.length());
        assertEquals("req-1", body.getString("requestId"));
        assertEquals("allow", body.getString("decision"));
        assertEquals(3, body.getInt("revision"));
        assertEquals(PushActionReceiver.RESPOND_MS, c.timeoutMs);
        assertContentFree();
    }

    @Test public void denySendsDeny() throws Exception {
        PushFakes.Host host = new PushFakes.Host().answer(200, "{\"ok\":true,\"outcome\":\"answered\"}");
        assertEquals(PushOutcome.Notice.DENIED, PushActionReceiver.answer(store(), host, action("DENY", "req-1")).notice);
        assertEquals("deny", new JSONObject(host.calls.get(0).body).getString("decision"));
    }

    @Test public void theHostsAnswersBecomeTheirNotices() {
        Object[][] cases = {
            {502, "{\"code\":\"unavailable\",\"error\":\"x\"}", PushOutcome.Notice.UNREACHABLE},
            {null, null, PushOutcome.Notice.UNREACHABLE},
            {403, "{\"code\":\"step_up\",\"error\":\"x\"}", PushOutcome.Notice.STEP_UP},
            {409, "{\"code\":\"already_answered\",\"error\":\"x\"}", PushOutcome.Notice.ALREADY_ANSWERED},
            {409, "{\"code\":\"stale\",\"error\":\"x\"}", PushOutcome.Notice.OPEN_APP},
            {404, "{\"code\":\"unavailable\",\"error\":\"x\"}", PushOutcome.Notice.OPEN_APP},
            {302, null, PushOutcome.Notice.OPEN_APP},
        };
        for (Object[] each : cases) {
            PushFakes.Host host = new PushFakes.Host().answer((Integer) each[0], (String) each[1]);
            assertEquals("status " + each[0], each[2], PushActionReceiver.answer(store(), host, action("APPROVE", "req-1")).notice);
        }
        assertContentFree();
    }

    @Test public void aLockedRespondTokenOpensTheAppAndSendsNothing() {
        PushFakes.bound(prefs, detailKey, respondKey, true);
        PushStore locked = new PushStore(prefs, detailKey, PushFakes.lockedKey());
        PushFakes.Host host = new PushFakes.Host();
        assertEquals(PushOutcome.Notice.OPEN_APP, PushActionReceiver.answer(locked, host, action("APPROVE", "req-1")).notice);
        assertTrue(host.calls.isEmpty());
    }

    @Test public void aRemovedComputerOrAnActionItCannotReadSendsNothing() {
        PushFakes.Host host = new PushFakes.Host();
        PushStore unbound = new PushStore(new FakePrefs(), PushFakes.memoryKey(), PushFakes.memoryKey());
        assertEquals(PushOutcome.Notice.OPEN_APP, PushActionReceiver.answer(unbound, host, action("APPROVE", "req-1")).notice);
        PushStore store = store();
        assertEquals(PushOutcome.Notice.OPEN_APP, PushActionReceiver.answer(store, host, action("OPEN", "req-1")).notice);
        assertEquals(PushOutcome.Notice.OPEN_APP, PushActionReceiver.answer(store, host,
            new PushActionReceiver.Action("APPROVE", PushFakes.BINDING, PushFakes.REF, "question", 3, "req-1")).notice);
        assertEquals(PushOutcome.Notice.OPEN_APP, PushActionReceiver.answer(store, host,
            new PushActionReceiver.Action("APPROVE", null, PushFakes.REF, "approval", 3, "req-1")).notice);
        assertEquals(PushOutcome.Notice.OPEN_APP, PushActionReceiver.answer(store, host,
            new PushActionReceiver.Action("APPROVE", PushFakes.BINDING, PushFakes.REF, "approval", 0, "req-1")).notice);
        assertTrue(host.calls.isEmpty());
    }

    @Test public void withoutARequestIdItFetchesTheDetailFirstThenAnswers() {
        PushFakes.Host host = new PushFakes.Host()
            .answer(200, "{\"title\":\"Run tests?\",\"body\":\"b\",\"target\":{\"threadId\":\"t-secret\",\"requestId\":\"req-1\"}}")
            .answer(200, "{\"ok\":true,\"outcome\":\"answered\"}");
        PushActionReceiver.Result r = PushActionReceiver.answer(store(), host, action("APPROVE", null));
        assertEquals(PushOutcome.Notice.APPROVED, r.notice);
        assertEquals("t-secret", r.target.threadId);
        assertEquals("GET", host.calls.get(0).method);
        assertEquals(PushFakes.ORIGIN + "/api/mobile/push/" + PushFakes.REF, host.calls.get(0).url);
        assertEquals(PushFakes.DETAIL, host.calls.get(0).token);
        assertEquals(PushActionReceiver.DETAIL_MS, host.calls.get(0).timeoutMs);
        assertEquals(PushFakes.RESPOND, host.calls.get(1).token);
        assertContentFree();
    }

    @Test public void anUnreachableDetailSaysCouldNotReach() {
        PushFakes.Host host = new PushFakes.Host().answer(null, null);
        PushActionReceiver.Result r = PushActionReceiver.answer(store(), host, action("APPROVE", null));
        assertEquals(PushOutcome.Notice.UNREACHABLE, r.notice);
        assertEquals("Couldn't reach your Murage, open the app.", r.notice.body());
        assertEquals(1, host.calls.size());
    }

    @Test public void aDetailWithoutARequestIdOrABadRefOpensTheApp() {
        PushFakes.Host host = new PushFakes.Host().answer(401, "{\"error\":\"sign in\"}");
        assertEquals(PushOutcome.Notice.OPEN_APP, PushActionReceiver.answer(store(), host, action("APPROVE", null)).notice);
        assertEquals(1, host.calls.size());
        PushFakes.Host none = new PushFakes.Host();
        PushActionReceiver.Result bad = PushActionReceiver.answer(store(), none,
            new PushActionReceiver.Action("APPROVE", PushFakes.BINDING, "../pending", "approval", 3, null));
        assertEquals(PushOutcome.Notice.OPEN_APP, bad.notice);
        assertTrue(none.calls.isEmpty());
        assertNull(bad.target);
    }

    @Test public void aThrowingHostStillEndsInANotice() {
        PushActionReceiver.Result r = PushActionReceiver.answer(store(), (m, u, t, b, ms) -> { throw new IllegalStateException("boom " + t); }, action("APPROVE", "req-1"));
        assertEquals(PushOutcome.Notice.OPEN_APP, r.notice);
        assertContentFree();
    }

    // ---- A5 review fixes ----

    @Test public void theRespondTokenIsReadBeforeTheDetailRead() {
        // No requestId on the notification, and the phone locked again: nothing is read or sent.
        PushFakes.bound(prefs, detailKey, respondKey, true);
        PushStore locked = new PushStore(prefs, detailKey, PushFakes.lockedKey());
        PushFakes.Host host = new PushFakes.Host();
        assertEquals(PushOutcome.Notice.OPEN_APP, PushActionReceiver.answer(locked, host, action("APPROVE", null)).notice);
        assertTrue(host.calls.isEmpty());
    }

    @Test public void theDetailReReadMapsLikeIos() {
        Object[][] cases = {
            {502, "{\"code\":\"unavailable\",\"error\":\"x\"}", PushOutcome.Notice.UNREACHABLE},
            {500, null, PushOutcome.Notice.UNREACHABLE},
            {503, null, PushOutcome.Notice.UNREACHABLE},
            {null, null, PushOutcome.Notice.UNREACHABLE},
            {404, "{\"error\":\"x\"}", PushOutcome.Notice.OPEN_APP},
            {403, "{\"code\":\"step_up\"}", PushOutcome.Notice.OPEN_APP},
            {302, null, PushOutcome.Notice.OPEN_APP},
            {200, "{\"title\":\"Run tests?\",\"body\":\"b\",\"target\":{\"threadId\":\"t-secret\"}}", PushOutcome.Notice.OPEN_APP},
        };
        for (Object[] each : cases) {
            PushFakes.Host host = new PushFakes.Host().answer((Integer) each[0], (String) each[1]);
            assertEquals("detail status " + each[0], each[2], PushActionReceiver.answer(store(), host, action("APPROVE", null)).notice);
            assertEquals(1, host.calls.size()); // never a POST without a request from the bound computer
        }
        assertContentFree();
    }

    @Test public void allowOnARiskyApprovalIsRefusedOnThePhone() {
        PushFakes.Host none = new PushFakes.Host();
        PushActionReceiver.Result r = PushActionReceiver.answer(store(), none,
            new PushActionReceiver.Action("APPROVE", PushFakes.BINDING, PushFakes.REF, "approval-open", 3, "req-1"));
        assertEquals(PushOutcome.Notice.STEP_UP, r.notice);
        assertTrue(none.calls.isEmpty());
        PushFakes.Host host = new PushFakes.Host().answer(200, "{\"ok\":true,\"outcome\":\"answered\"}");
        assertEquals(PushOutcome.Notice.DENIED, PushActionReceiver.answer(store(), host,
            new PushActionReceiver.Action("DENY", PushFakes.BINDING, PushFakes.REF, "approval-open", 3, "req-1")).notice);
    }

    @Test public void aNonCanonicalOriginGetsNoBearer() {
        for (String odd : new String[] {"https://mac.tail0000.ts.net:443", "https://MAC.tail0000.ts.net:8443", "https://mac.tail0000.ts.net:8443/", "https://mac.tail0000.ts.net:8443/api"}) {
            PushStore s = new PushStore(new FakePrefs(), PushFakes.memoryKey(), PushFakes.memoryKey());
            s.updateLedger(l -> { l.bind(PushFakes.BINDING, odd); return null; });
            assertTrue(s.putTokens(PushFakes.BINDING, PushFakes.DETAIL, PushFakes.RESPOND));
            PushFakes.Host none = new PushFakes.Host();
            PushActionReceiver.Result r = PushActionReceiver.answer(s, none, action("APPROVE", "req-1"));
            assertTrue(odd, r.removed);
            assertTrue(odd, none.calls.isEmpty());
        }
    }

    @Test public void aRemovedComputerIsToldApartFromOpenTheApp() {
        PushStore unbound = new PushStore(new FakePrefs(), PushFakes.memoryKey(), PushFakes.memoryKey());
        assertTrue(PushActionReceiver.answer(unbound, new PushFakes.Host(), action("APPROVE", "req-1")).removed);
        assertFalse(PushActionReceiver.answer(store(), new PushFakes.Host(), action("OPEN", "req-1")).removed);
    }
}
