package com.murage.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Collections;

import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.junit.Before;
import org.junit.Test;

public class PushStoreTest {
    // A store that fails a seal logs it, and android.util.Log is only a stub on the JVM.
    @Before public void quietLog() { ShellLog.sink = message -> {}; }

    private static SecureStore.Keys memoryKey() throws Exception {
        KeyGenerator g = KeyGenerator.getInstance("AES");
        g.init(256);
        SecretKey key = g.generateKey();
        return new SecureStore.Keys() {
            @Override public SecretKey existing() { return key; }
            @Override public SecretKey create() { return key; }
        };
    }

    @Test public void tokensRoundTripAndDeleteTogether() throws Exception {
        PushStore store = new PushStore(new FakePrefs(), memoryKey(), memoryKey());
        store.putTokens("B1", "murage_pd_x", "murage_pr_y");
        assertEquals("murage_pd_x", store.detail("B1"));
        assertEquals("murage_pr_y", store.respond("B1"));
        store.deleteTokens("B1");
        assertNull(store.detail("B1"));
        assertNull(store.respond("B1"));
    }

    private static SecureStore.Keys lockedKey() {
        return new SecureStore.Keys() {
            @Override public SecretKey existing() throws Exception { throw new Exception("user not authenticated"); }
            @Override public SecretKey create() throws Exception { throw new Exception("user not authenticated"); }
        };
    }

    @Test public void aLockedRespondKeyReadsAsNullNotAsAnError() throws Exception {
        FakePrefs prefs = new FakePrefs();
        SecureStore.Keys detail = memoryKey();
        assertTrue(new PushStore(prefs, detail, memoryKey()).putTokens("B1", "murage_pd_x", "murage_pr_y"));
        PushStore locked = new PushStore(prefs, detail, lockedKey());
        assertEquals("murage_pd_x", locked.detail("B1"));
        assertNull(locked.respond("B1"));
    }

    /** A respond key that is there but refuses to encrypt, as the Keystore does for an unlocked-device key on a locked phone. */
    private static SecureStore.Keys refusesToSeal() {
        SecretKey unusable = new javax.crypto.spec.SecretKeySpec(new byte[7], "AES");
        return new SecureStore.Keys() {
            @Override public SecretKey existing() { return unusable; }
            @Override public SecretKey create() { return unusable; }
        };
    }

    /**
     * A locked phone refuses the respond seal: the old pair stays whole, so the
     * workspace still reads as enrolled and the next open re-mints rather than
     * replacing the binding at the relay (the 2026-09-27 device incident).
     */
    @Test public void aLockedRespondKeyKeepsTheOldPair() throws Exception {
        FakePrefs prefs = new FakePrefs();
        SecureStore.Keys detail = memoryKey(), respond = memoryKey();
        assertTrue(new PushStore(prefs, detail, respond).putTokens("B1", "murage_pd_old", "murage_pr_old"));
        assertFalse(new PushStore(prefs, detail, refusesToSeal()).putTokens("B1", "murage_pd_x", "murage_pr_y"));
        assertFalse(new PushStore(prefs, detail, lockedKey()).putTokens("B1", "murage_pd_x", "murage_pr_y"));
        PushStore after = new PushStore(prefs, detail, respond);
        assertEquals("murage_pd_old", after.detail("B1"));
        assertEquals("murage_pr_old", after.respond("B1"));
    }

    // RES-009: the host's expiry is kept with the pair, and a pair past it is not current.
    @Test public void theExpiryIsKeptWithThePairAndCurrentStopsAtIt() throws Exception {
        PushStore store = new PushStore(new FakePrefs(), memoryKey(), memoryKey());
        assertTrue(store.putTokens("B1", "murage_pd_x", "murage_pr_y", 5_000L));
        assertEquals(5_000L, store.expiresAt("B1"));
        assertTrue(store.current("B1", 4_999L));
        assertFalse(store.current("B1", 5_000L));
        assertFalse(store.current("B1", 6_000L));
    }

    // RES-009: a pair stored with no recorded expiry (issued by an older build) is
    // unknown, not current; the page's every-open reissue then renews it.
    @Test public void aPairWithNoRecordedExpiryIsUnknownAndNotCurrent() throws Exception {
        PushStore store = new PushStore(new FakePrefs(), memoryKey(), memoryKey());
        assertTrue(store.putTokens("B1", "murage_pd_x", "murage_pr_y"));
        assertEquals(0L, store.expiresAt("B1"));
        assertFalse(store.current("B1", 10L));
        assertTrue(store.putTokens("B1", "murage_pd_z", "murage_pr_z", 5_000L));
        assertTrue(store.current("B1", 4L));
    }

    // RES-009: storing a pair fails when its expiry cannot be written, and leaves no
    // pair behind, so the phone reports not enrolled and the enrolment retry runs.
    @Test public void aFailedExpiryWriteFailsTheStoreAndLeavesNoPair() throws Exception {
        FakePrefs prefs = new FakePrefs();
        PushStore store = new PushStore(prefs, memoryKey(), memoryKey());
        assertTrue(store.putTokens("B1", "murage_pd_a", "murage_pr_a", 5_000L));
        prefs.failWritesTo = "expires.";
        assertFalse(store.putTokens("B1", "murage_pd_b", "murage_pr_b", 9_000L));
        prefs.failWritesTo = null;
        assertNull(store.detail("B1"));
        assertNull(store.respond("B1"));
        assertEquals(0L, store.expiresAt("B1"));
        assertFalse(store.current("B1", 10L));
    }

    @Test public void aReissueReplacesTheExpiryAndAFailedPairKeepsTheOldOne() throws Exception {
        FakePrefs prefs = new FakePrefs();
        SecureStore.Keys detail = memoryKey(), respond = memoryKey();
        PushStore store = new PushStore(prefs, detail, respond);
        assertTrue(store.putTokens("B1", "murage_pd_a", "murage_pr_a", 5_000L));
        assertTrue(store.putTokens("B1", "murage_pd_b", "murage_pr_b", 9_000L));
        assertEquals(9_000L, store.expiresAt("B1"));
        assertFalse(new PushStore(prefs, detail, lockedKey()).putTokens("B1", "murage_pd_c", "murage_pr_c", 20_000L));
        assertEquals(9_000L, store.expiresAt("B1"));
    }

    @Test public void forgetAndSweepRemoveTheExpiryToo() throws Exception {
        FakePrefs prefs = new FakePrefs();
        PushStore store = new PushStore(prefs, memoryKey(), memoryKey());
        store.updateLedger(l -> { l.bind("B1", "https://kept.tailnet123.ts.net"); l.bind("B2", "https://gone.tailnet123.ts.net"); return null; });
        store.putTokens("B1", "murage_pd_1", "murage_pr_1", 5_000L);
        store.putTokens("B2", "murage_pd_2", "murage_pr_2", 5_000L);
        prefs.values.put("expires.B9", 5_000L); // no binding owns it
        assertEquals(java.util.Arrays.asList("B2"), store.sweep(Collections.singleton("https://kept.tailnet123.ts.net")));
        assertEquals(5_000L, store.expiresAt("B1"));
        assertEquals(0L, store.expiresAt("B2"));
        assertEquals(0L, store.expiresAt("B9"));
        assertEquals("B1", store.forget("https://kept.tailnet123.ts.net"));
        assertEquals(0L, store.expiresAt("B1"));
    }

    @Test public void aDetailWriteThatFailsLeavesNeitherToken() throws Exception {
        FakePrefs prefs = new FakePrefs();
        SecureStore.Keys respond = memoryKey();
        assertFalse(new PushStore(prefs, lockedKey(), respond).putTokens("B1", "murage_pd_x", "murage_pr_y"));
        assertNull(new PushStore(prefs, memoryKey(), respond).respond("B1"));
        assertTrue(prefs.values.isEmpty());
    }

    @Test public void forgetDeletesTheTokensAndReturnsTheBinding() throws Exception {
        PushStore store = new PushStore(new FakePrefs(), memoryKey(), memoryKey());
        store.updateLedger(l -> { l.bind("B1", "https://mac.tailnet123.ts.net"); return null; });
        store.putTokens("B1", "murage_pd_x", "murage_pr_y");
        assertEquals("B1", store.forget("https://mac.tailnet123.ts.net"));
        assertNull(store.detail("B1"));
        assertNull(store.respond("B1"));
        assertNull(store.ledger().binding("https://mac.tailnet123.ts.net"));
        assertNull(store.forget("https://mac.tailnet123.ts.net"));
    }

    @Test public void forgetStillNamesTheBindingWhenTheLedgerCannotBeSaved() throws Exception {
        FakePrefs prefs = new FakePrefs();
        PushStore store = new PushStore(prefs, memoryKey(), memoryKey());
        store.updateLedger(l -> { l.bind("B1", "https://mac.tailnet123.ts.net"); return null; });
        LogCapture log = new LogCapture();
        prefs.commitSucceeds = false;
        assertEquals("B1", store.forget("https://mac.tailnet123.ts.net"));
        assertEquals("push forget deferred", log.all());
    }

    @Test public void sweepDropsBindingsForRemovedComputersAndStrayTokens() throws Exception {
        FakePrefs prefs = new FakePrefs();
        PushStore store = new PushStore(prefs, memoryKey(), memoryKey());
        store.updateLedger(l -> { l.bind("B1", "https://kept.tailnet123.ts.net"); l.bind("B2", "https://gone.tailnet123.ts.net"); return null; });
        store.putTokens("B1", "murage_pd_1", "murage_pr_1");
        store.putTokens("B2", "murage_pd_2", "murage_pr_2");
        store.putTokens("B9", "murage_pd_9", "murage_pr_9");
        assertTrue(store.putDeviceSecret("secret"));
        // B9's tokens had no binding (a forget that could not save): it goes at the relay too (A4).
        assertEquals(java.util.Arrays.asList("B2", "B9"), store.sweep(Collections.singleton("https://kept.tailnet123.ts.net")));
        assertEquals(Collections.singletonList("B1"), store.ledger().bindingIds());
        assertEquals("murage_pd_1", store.detail("B1"));
        assertEquals("murage_pr_1", store.respond("B1"));
        assertNull(store.detail("B2"));
        assertNull(store.respond("B2"));
        assertNull(store.detail("B9"));
        assertNull(store.respond("B9"));
        assertEquals("secret", store.deviceSecret());
        assertEquals(Collections.emptyList(), store.sweep(Collections.singleton("https://kept.tailnet123.ts.net")));
    }

    @Test public void theInstallKeepsOnlyADigestOfThePushTokenAndDropsBoth() throws Exception {
        FakePrefs prefs = new FakePrefs();
        PushStore store = new PushStore(prefs, memoryKey(), memoryKey());
        assertTrue(store.putDeviceSecret("murage_ds_secret", "fcm-token-abcdefghij"));
        assertTrue(store.relayHolds("fcm-token-abcdefghij"));
        assertFalse(store.relayHolds("fcm-token-other"));
        for (Object v : prefs.values.values()) {
            assertFalse(String.valueOf(v).contains("fcm-token"));
            assertFalse(String.valueOf(v).contains("murage_ds_"));
        }
        store.deleteDeviceSecret();
        assertNull(store.deviceSecret());
        assertFalse(store.relayHolds("fcm-token-abcdefghij"));
    }

    @Test public void relayDeletesAreAnOrderedSetThatSurvives() throws Exception {
        FakePrefs prefs = new FakePrefs();
        PushStore store = new PushStore(prefs, memoryKey(), memoryKey());
        store.addRelayDelete("B1");
        store.addRelayDelete("B2");
        store.addRelayDelete("B1");
        assertEquals(java.util.Arrays.asList("B1", "B2"), new PushStore(prefs, memoryKey(), memoryKey()).relayDeletes());
        store.removeRelayDelete("B1");
        store.removeRelayDelete("B9");
        assertEquals(Collections.singletonList("B2"), store.relayDeletes());
        // The sweep's stray-token scan leaves the list alone.
        store.sweep(Collections.emptySet());
        assertEquals(Collections.singletonList("B2"), store.relayDeletes());
    }

    @Test public void theLedgerIsPlainJsonAndSurvives() throws Exception {
        FakePrefs prefs = new FakePrefs();
        PushStore first = new PushStore(prefs, memoryKey(), memoryKey());
        first.updateLedger(l -> { l.bind("B1", "https://mac.tailnet123.ts.net"); l.setBadge("B1", 2); return null; });
        assertEquals(2, new PushStore(prefs, memoryKey(), memoryKey()).ledger().total());
    }

    @Test public void onlyACanonicalOriginIsOneATokenMayGoTo() {
        assertEquals("https://mac.tail0000.ts.net:8443", PushStore.canonical("https://mac.tail0000.ts.net:8443").serialized());
        assertEquals("https://mac.tail0000.ts.net", PushStore.canonical("https://mac.tail0000.ts.net").serialized());
        for (String odd : new String[] {null, "", "https://mac.tail0000.ts.net:443", "https://MAC.tail0000.ts.net", "https://mac.tail0000.ts.net/",
            "https://mac.tail0000.ts.net/api", "https://mac.tail0000.ts.net:08443", " https://mac.tail0000.ts.net", "http://mac.tail0000.ts.net", "https://100.64.0.1"}) {
            assertNull(String.valueOf(odd), PushStore.canonical(odd));
        }
    }
}
