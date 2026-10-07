package com.murage.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.json.JSONObject;
import org.junit.Test;

/** registerPush's relay half against a scripted fake relay (never the live one). */
public class PushEnrolmentTest {
    private static final String CHALLENGE = "c".repeat(43);
    private static final String SECRET = "murage_ds_" + "S".repeat(43);
    private static final String SECRET2 = "murage_ds_" + "T".repeat(43);
    private static final String GRANT = "murage_pg_" + "G".repeat(43);
    private static final String PUSH = "fcm-token-" + "p".repeat(40);
    private static final String INTEGRITY = "integrity-" + "i".repeat(40);
    private static final String BINDING = "0b0e7a52-2f0c-4a54-9d6e-4c0b3f4f6a11";

    static final class Call {
        final String method, path, secret; final JSONObject body;
        Call(String m, String p, String s, JSONObject b) { method = m; path = p; secret = s; body = b; }
    }

    /** Answers in order; records every call. */
    static final class FakeRelay implements PushEnrolment.Relay {
        final List<Call> calls = new ArrayList<>();
        final Deque<RelayClient.Answer> answers = new ArrayDeque<>();
        FakeRelay then(int status, String body) throws Exception { answers.add(new RelayClient.Answer(status, new JSONObject(body))); return this; }
        java.util.function.Consumer<Call> hook = c -> {};
        @Override public RelayClient.Answer call(String method, String path, String secret, JSONObject body) {
            Call c = new Call(method, path, secret, body);
            calls.add(c);
            hook.accept(c);
            return answers.isEmpty() ? new RelayClient.Answer(0, new JSONObject()) : answers.poll();
        }
    }

    private final List<String> nonces = new ArrayList<>();
    private final PushEnrolment.Attest attest = nonce -> { nonces.add(nonce); return INTEGRITY; };
    private final LogCapture log = new LogCapture();

    private static SecureStore.Keys memoryKey() throws Exception {
        KeyGenerator g = KeyGenerator.getInstance("AES");
        g.init(256);
        SecretKey key = g.generateKey();
        return new SecureStore.Keys() {
            @Override public SecretKey existing() { return key; }
            @Override public SecretKey create() { return key; }
        };
    }
    private static PushStore store() throws Exception { return new PushStore(new FakePrefs(), memoryKey(), memoryKey()); }

    private static String created(String secret) { return "{\"deviceId\":\"d\",\"deviceSecret\":\"" + secret + "\"}"; }
    private static final String BOUND = "{\"bindingId\":\"" + BINDING + "\",\"grant\":\"" + GRANT + "\",\"grantExpiresAt\":1}";

    private void assertContentFree() {
        String all = log.all();
        for (String s : new String[] {SECRET, SECRET2, GRANT, PUSH, INTEGRITY, CHALLENGE, BINDING}) assertFalse(all.contains(s));
    }

    @Test public void theFirstBindingAttestsWithTheChallengeAsTheNonce() throws Exception {
        FakeRelay relay = new FakeRelay().then(201, "{\"challenge\":\"" + CHALLENGE + "\",\"expiresAt\":1}").then(201, created(SECRET)).then(201, BOUND);
        PushStore store = store();
        PushEnrolment.Binding made = new PushEnrolment(relay, store, "development").bind(PUSH, attest);
        assertNotNull(made);
        assertEquals(BINDING, made.bindingId);
        assertEquals(GRANT, made.grant);
        assertEquals(List.of(CHALLENGE), nonces);
        assertEquals(3, relay.calls.size());
        Call challenge = relay.calls.get(0), device = relay.calls.get(1), binding = relay.calls.get(2);
        assertEquals("POST /v1/challenges", challenge.method + " " + challenge.path);
        assertNull(challenge.secret);
        assertEquals("POST /v1/devices", device.method + " " + device.path);
        assertNull(device.secret);
        JSONObject body = device.body;
        assertEquals("android", body.getString("platform"));
        assertEquals("development", body.getString("environment"));
        assertEquals(PUSH, body.getString("pushToken"));
        assertEquals(CHALLENGE, body.getString("challenge"));
        assertEquals("play-integrity", body.getJSONObject("attestation").getString("kind"));
        assertEquals(INTEGRITY, body.getJSONObject("attestation").getString("token"));
        assertEquals(5, body.length()); // the relay's schema is strict
        assertEquals(2, body.getJSONObject("attestation").length());
        assertEquals("POST /v1/bindings", binding.method + " " + binding.path);
        assertEquals(SECRET, binding.secret);
        assertEquals(SECRET, store.deviceSecret());
        assertTrue(store.relayHolds(PUSH));
        assertContentFree();
    }

    @Test public void laterBindingsReuseTheInstallSecret() throws Exception {
        PushStore store = store();
        store.putDeviceSecret(SECRET, PUSH);
        FakeRelay relay = new FakeRelay().then(201, BOUND);
        assertNotNull(new PushEnrolment(relay, store, "production").bind(PUSH, attest));
        assertEquals(1, relay.calls.size());
        assertEquals(SECRET, relay.calls.get(0).secret);
        assertTrue(nonces.isEmpty());
    }

    @Test public void aRelayThatForgotTheInstallIsAttestedOnceMore() throws Exception {
        PushStore store = store();
        store.putDeviceSecret(SECRET, PUSH);
        FakeRelay relay = new FakeRelay().then(401, "{\"error\":\"unauthorized\"}")
            .then(201, "{\"challenge\":\"" + CHALLENGE + "\"}").then(201, created(SECRET2)).then(201, BOUND);
        assertNotNull(new PushEnrolment(relay, store, "development").bind(PUSH, attest));
        assertEquals(4, relay.calls.size());
        assertEquals(SECRET2, relay.calls.get(3).secret);
        assertEquals(SECRET2, store.deviceSecret());
        assertContentFree();
    }

    @Test public void aRefusedAttestationStoresNothingAndBindsNothing() throws Exception {
        PushStore store = store();
        FakeRelay relay = new FakeRelay().then(201, "{\"challenge\":\"" + CHALLENGE + "\"}").then(403, "{\"error\":\"attestation_failed\"}");
        assertNull(new PushEnrolment(relay, store, "development").bind(PUSH, attest));
        assertEquals(2, relay.calls.size());
        assertNull(store.deviceSecret());
        assertFalse(store.relayHolds(PUSH));
    }

    @Test public void anUnreachableRelayOrAFailingPlayIsUnavailable() throws Exception {
        assertNull(new PushEnrolment(new FakeRelay(), store(), "development").bind(PUSH, attest));
        FakeRelay relay = new FakeRelay().then(201, "{\"challenge\":\"" + CHALLENGE + "\"}");
        PushEnrolment.Attest broken = nonce -> { throw new Exception("play said no " + INTEGRITY); };
        assertNull(new PushEnrolment(relay, store(), "development").bind(PUSH, broken));
        assertEquals(1, relay.calls.size());
        assertContentFree();
    }

    @Test public void aBindingAnswerOutsideTheContractIsUnavailable() throws Exception {
        for (String bad : new String[] {"{\"bindingId\":\"../x\",\"grant\":\"" + GRANT + "\"}", "{\"bindingId\":\"" + BINDING + "\"}", "{\"bindingId\":7,\"grant\":\"" + GRANT + "\"}"}) {
            PushStore store = store();
            store.putDeviceSecret(SECRET, PUSH);
            assertNull(new PushEnrolment(new FakeRelay().then(201, bad), store, "development").bind(PUSH, attest));
        }
        PushStore store = store();
        store.putDeviceSecret(SECRET, PUSH);
        assertNull(new PushEnrolment(new FakeRelay().then(429, "{\"error\":\"binding_limit\"}"), store, "development").bind(PUSH, attest));
    }

    @Test public void aNewTokenGoesToTheRelayOnlyWhenItDiffers() throws Exception {
        PushStore store = store();
        store.putDeviceSecret(SECRET, "old-token-" + "o".repeat(40));
        FakeRelay relay = new FakeRelay().then(200, "{\"ok\":true}");
        PushEnrolment e = new PushEnrolment(relay, store, "development");
        e.tokenChanged(PUSH);
        assertEquals(1, relay.calls.size());
        Call put = relay.calls.get(0);
        assertEquals("PUT /v1/devices/self/token", put.method + " " + put.path);
        assertEquals(SECRET, put.secret);
        assertEquals(PUSH, put.body.getString("pushToken"));
        assertEquals(1, put.body.length());
        assertTrue(store.relayHolds(PUSH));
        e.tokenChanged(PUSH);
        assertEquals(1, relay.calls.size());
        assertContentFree();
    }

    private static final long DAY = 24L * 3_600_000L;

    @Test public void theForegroundRefreshSendsTheTokenEvenWhenTheRelayHoldsIt() throws Exception {
        PushStore store = store();
        store.putDeviceSecret(SECRET, PUSH);
        FakeRelay relay = new FakeRelay().then(200, "{\"ok\":true}");
        com.murage.mobile.shell.PushRefreshPolicy policy = new com.murage.mobile.shell.PushRefreshPolicy(new FakeKv());
        PushEnrolment e = new PushEnrolment(relay, store, "development");
        long t = 5_000_000_000_000L;
        e.refreshIfDue(policy, t, () -> PUSH);
        assertEquals(1, relay.calls.size());
        assertEquals("PUT /v1/devices/self/token", relay.calls.get(0).method + " " + relay.calls.get(0).path);
        assertEquals(SECRET, relay.calls.get(0).secret);
        assertEquals(PUSH, relay.calls.get(0).body.getString("pushToken"));
        e.refreshIfDue(policy, t + DAY - 1, () -> PUSH);
        assertEquals(1, relay.calls.size()); // within 24 h: nothing
        relay.then(200, "{\"ok\":true}");
        e.refreshIfDue(policy, t + DAY + 1, () -> PUSH);
        assertEquals(2, relay.calls.size());
        assertContentFree();
    }

    @Test public void aFailedRefreshBacksOffAndNeverThrows() throws Exception {
        PushStore store = store();
        store.putDeviceSecret(SECRET, PUSH);
        FakeRelay relay = new FakeRelay(); // unreachable
        com.murage.mobile.shell.PushRefreshPolicy policy = new com.murage.mobile.shell.PushRefreshPolicy(new FakeKv());
        PushEnrolment e = new PushEnrolment(relay, store, "development");
        long t = 5_000_000_000_000L;
        e.refreshIfDue(policy, t, () -> PUSH);
        e.refreshIfDue(policy, t + 1000, () -> PUSH);
        assertEquals(1, relay.calls.size());
        assertEquals(SECRET, store.deviceSecret());
        e.refreshIfDue(policy, t + 20 * 60_000L, () -> PUSH);
        assertEquals(2, relay.calls.size());
        // A token FCM cannot give is a failure too, with no relay call.
        PushEnrolment f = new PushEnrolment(relay, store, "development");
        f.refreshIfDue(new com.murage.mobile.shell.PushRefreshPolicy(new FakeKv()), t, () -> { throw new Exception("fcm down"); });
        assertEquals(2, relay.calls.size());
        assertContentFree();
    }

    @Test public void aRefreshWithoutAnInstallSendsNothing() throws Exception {
        FakeRelay relay = new FakeRelay();
        new PushEnrolment(relay, store(), "development").refreshIfDue(new com.murage.mobile.shell.PushRefreshPolicy(new FakeKv()), 5_000_000_000_000L, () -> PUSH);
        assertTrue(relay.calls.isEmpty());
    }

    @Test public void aRefreshTheRelayRefusesDropsTheInstall() throws Exception {
        PushStore store = store();
        store.putDeviceSecret(SECRET, PUSH);
        new PushEnrolment(new FakeRelay().then(401, "{\"error\":\"unauthorized\"}"), store, "development")
            .refreshIfDue(new com.murage.mobile.shell.PushRefreshPolicy(new FakeKv()), 5_000_000_000_000L, () -> PUSH);
        assertNull(store.deviceSecret());
    }

    static final class FakeKv implements com.murage.mobile.shell.KeyValueStore {
        final java.util.Map<String, String> values = new java.util.HashMap<>();
        @Override public String get(String key) { return values.get(key); }
        @Override public void put(String key, String value) { if (value == null) values.remove(key); else values.put(key, value); }
    }

    @Test public void aTokenInUseOrAForgottenInstallDropsTheInstall() throws Exception {
        for (int status : new int[] {409, 401}) {
            PushStore store = store();
            store.putDeviceSecret(SECRET, "old-token-" + "o".repeat(40));
            new PushEnrolment(new FakeRelay().then(status, "{\"error\":\"token_in_use\"}"), store, "development").tokenChanged(PUSH);
            assertNull(store.deviceSecret());
            assertFalse(store.relayHolds(PUSH));
        }
    }

    @Test public void anUnreachableRelayKeepsTheInstallForTheNextTry() throws Exception {
        PushStore store = store();
        store.putDeviceSecret(SECRET, "old-token-" + "o".repeat(40));
        new PushEnrolment(new FakeRelay(), store, "development").tokenChanged(PUSH);
        assertEquals(SECRET, store.deviceSecret());
        assertFalse(store.relayHolds(PUSH));
    }

    @Test public void withoutAnInstallNothingIsSent() throws Exception {
        FakeRelay relay = new FakeRelay();
        PushEnrolment e = new PushEnrolment(relay, store(), "development");
        e.tokenChanged(PUSH);
        e.deleteBinding(BINDING);
        assertTrue(relay.calls.isEmpty());
    }

    @Test public void deleteSendsTheBindingWithTheInstallSecretOnly() throws Exception {
        PushStore store = store();
        store.putDeviceSecret(SECRET, PUSH);
        FakeRelay relay = new FakeRelay().then(200, "{\"removed\":true}");
        PushEnrolment e = new PushEnrolment(relay, store, "development");
        e.deleteBinding(BINDING);
        e.deleteBinding("../devices/self/token");
        e.deleteBinding(null);
        assertEquals(1, relay.calls.size());
        assertEquals("DELETE /v1/bindings/" + BINDING, relay.calls.get(0).method + " " + relay.calls.get(0).path);
        assertEquals(SECRET, relay.calls.get(0).secret);
        assertNull(relay.calls.get(0).body);
        assertContentFree();
    }
    @Test public void aRepeatedDeleteCountsAsDone() throws Exception {
        PushStore store = store();
        store.putDeviceSecret(SECRET, PUSH);
        // 403 is what the relay answers a device secret for a binding it no longer holds.
        for (int status : new int[] {200, 401, 403, 404}) {
            assertTrue(new PushEnrolment(new FakeRelay().then(status, "{}"), store, "development").deleteBinding(BINDING));
        }
        for (int status : new int[] {0, 429, 500, 503}) {
            assertFalse(new PushEnrolment(new FakeRelay().then(status, "{}"), store, "development").deleteBinding(BINDING));
        }
        assertTrue(new PushEnrolment(new FakeRelay(), store(), "development").deleteBinding(BINDING)); // no install: nothing can
        assertTrue(new PushEnrolment(new FakeRelay(), store, "development").deleteBinding("not-a-binding"));
    }

    @Test public void drainingCrossesOffConfirmedDeletesAndKeepsTheRest() throws Exception {
        String second = "1b0e7a52-2f0c-4a54-9d6e-4c0b3f4f6a12", third = "2b0e7a52-2f0c-4a54-9d6e-4c0b3f4f6a13";
        PushStore store = store();
        store.putDeviceSecret(SECRET, PUSH);
        store.addRelayDelete(BINDING);
        store.addRelayDelete(second);
        store.addRelayDelete(third);
        FakeRelay relay = new FakeRelay().then(200, "{\"removed\":true}").then(0, "{}").then(404, "{\"error\":\"not_found\"}");
        new PushEnrolment(relay, store, "development").drainDeletes();
        assertEquals(3, relay.calls.size());
        assertEquals(List.of(second), store.relayDeletes());
        // The next open repeats only the one the relay never confirmed.
        FakeRelay again = new FakeRelay().then(403, "{\"error\":\"forbidden\"}");
        new PushEnrolment(again, store, "development").drainDeletes();
        assertEquals("DELETE /v1/bindings/" + second, again.calls.get(0).method + " " + again.calls.get(0).path);
        assertTrue(store.relayDeletes().isEmpty());
        assertContentFree();
    }
    @Test public void aSecondRefusalAfterTheOneRetryIsUnavailable() throws Exception {
        PushStore store = store();
        store.putDeviceSecret(SECRET, PUSH);
        FakeRelay relay = new FakeRelay().then(401, "{}").then(201, "{\"challenge\":\"" + CHALLENGE + "\"}").then(201, created(SECRET2)).then(401, "{}")
            .then(201, "{\"challenge\":\"" + CHALLENGE + "\"}");
        assertNull(new PushEnrolment(relay, store, "development").bind(PUSH, attest));
        assertEquals(4, relay.calls.size());
    }

    // ---- register: the whole flow, with a fake relay, Play and FCM ----

    private static final String MAC = "https://mac.tailnet123.ts.net", PI = "https://pi.tailnet123.ts.net:8443";
    private static final String OLD_A = "3b0e7a52-2f0c-4a54-9d6e-4c0b3f4f6a14", OLD_B = "4b0e7a52-2f0c-4a54-9d6e-4c0b3f4f6a15";
    private final List<String> forgotten = new ArrayList<>();

    private JSONObject register(PushEnrolment e, PushStore store, String origin, boolean granted, boolean fresh) throws Exception {
        return e.register(origin, granted, fresh, true, () -> PUSH, attest);
    }

    /** Two computers enrolled under the install SECRET. */
    private static PushStore enrolledTwice() throws Exception {
        PushStore store = store();
        store.putDeviceSecret(SECRET, PUSH);
        store.updateLedger(l -> { l.bind(OLD_A, MAC); l.bind(OLD_B, PI); return null; });
        assertTrue(store.putTokens(OLD_A, "murage_pd_a", "murage_pr_a"));
        assertTrue(store.putTokens(OLD_B, "murage_pd_b", "murage_pr_b"));
        return store;
    }

    @Test public void deniedAndUnsupportedTouchNothing() throws Exception {
        FakePrefs prefs = new FakePrefs();
        PushStore store = new PushStore(prefs, memoryKey(), memoryKey());
        store.putDeviceSecret(SECRET, PUSH);
        store.updateLedger(l -> { l.bind(OLD_A, MAC); return null; });
        java.util.Map<String, ?> before = prefs.getAll();
        FakeRelay relay = new FakeRelay();
        PushEnrolment e = new PushEnrolment(relay, store, "development");
        assertEquals("{\"status\":\"denied\"}", register(e, store, MAC, false, true).toString());
        assertEquals("{\"status\":\"unsupported\"}", e.register(MAC, true, true, false, () -> { throw new AssertionError("no FCM"); }, attest).toString());
        assertEquals(before, prefs.getAll());
        assertTrue(relay.calls.isEmpty());
        assertTrue(forgotten.isEmpty());
    }

    @Test public void anEnrolledComputerIsReusedAndANewOneCreated() throws Exception {
        PushStore store = enrolledTwice();
        FakeRelay relay = new FakeRelay().then(201, BOUND);
        PushEnrolment e = new PushEnrolment(relay, store, "development");
        JSONObject reuse = register(e, store, MAC, true, false);
        assertEquals("enrolled", reuse.getString("status"));
        assertEquals(OLD_A, reuse.getString("bindingId"));
        assertTrue(relay.calls.isEmpty());
        JSONObject created = register(e, store, "https://new.tailnet123.ts.net", true, false);
        assertEquals("granted", created.getString("status"));
        assertEquals(BINDING, created.getString("bindingId"));
        assertEquals(GRANT, created.getString("grant"));
        assertEquals(BINDING, store.ledger().binding("https://new.tailnet123.ts.net"));
        assertTrue(forgotten.isEmpty());
    }

    /** The 2026-09-27 device incident: a replace deleted the working binding at the relay before the host had the new one. */
    @Test public void replaceDoesNotForgetBeforeAdopt() throws Exception {
        PushStore store = enrolledTwice();
        FakeRelay relay = new FakeRelay().then(201, BOUND);
        PushEnrolment e = new PushEnrolment(relay, store, "development");
        JSONObject made = register(e, store, MAC, true, true);
        assertEquals("granted", made.getString("status"));
        assertEquals(BINDING, made.getString("bindingId"));
        assertEquals(1, relay.calls.size()); // POST /v1/bindings only: no DELETE of the old binding
        assertTrue(forgotten.isEmpty());
        assertEquals(OLD_A, store.ledger().binding(MAC));
        assertEquals("murage_pd_a", store.detail(OLD_A));
        assertEquals("murage_pr_a", store.respond(OLD_A));
        assertTrue(store.relayDeletes().isEmpty());
        // The host never took it: the old binding is still the one in use.
        assertEquals("enrolled", register(e, store, MAC, true, false).getString("status"));
        assertEquals(OLD_B, store.ledger().binding(PI));
    }

    @Test public void adoptForgetsTheOldAndQueuesItsRelayDelete() throws Exception {
        PushStore store = enrolledTwice();
        PushEnrolment e = new PushEnrolment(new FakeRelay().then(201, BOUND), store, "development");
        register(e, store, MAC, true, true);
        // What PushServices.adopt hands in: PushServices.forget, whose relay delete is queued first.
        Runnable forget = () -> { String gone = store.forget(MAC); forgotten.add(gone); store.addRelayDelete(gone); };
        assertTrue(e.adopt(MAC, BINDING, forget));
        assertEquals(List.of(OLD_A), forgotten);
        assertEquals(List.of(OLD_A), store.relayDeletes());
        assertNull(store.detail(OLD_A));
        assertEquals(BINDING, store.ledger().binding(MAC));
        assertEquals(OLD_B, store.ledger().binding(PI));
        assertFalse(e.adopt(MAC, BINDING, forget)); // once
        assertEquals(List.of(OLD_A), forgotten);
        assertContentFree();
    }

    /** Review Important 1: the binding was made under the install the relay then dropped. */
    @Test public void aDropDuringAPendingReplaceIsNeverAdopted() throws Exception {
        PushStore store = enrolledTwice();
        FakeRelay relay = new FakeRelay().then(201, BOUND);
        PushEnrolment e = new PushEnrolment(relay, store, "development");
        assertEquals("granted", register(e, store, MAC, true, true).getString("status"));
        relay.then(409, "{\"error\":\"token_in_use\"}");
        e.tokenChanged("new-token-" + "n".repeat(40));
        assertNull(store.deviceSecret());
        assertFalse(e.adopt(MAC, BINDING, () -> forgotten.add(store.forget(MAC))));
        assertTrue(forgotten.isEmpty());
        assertEquals(OLD_A, store.ledger().binding(MAC));
        assertNull(store.detail(BINDING));
    }

    @Test public void forgettingAComputerDropsItsPendingReplace() throws Exception {
        PushStore store = enrolledTwice();
        PushEnrolment e = new PushEnrolment(new FakeRelay().then(201, BOUND), store, "development");
        register(e, store, MAC, true, true);
        assertTrue(e.isPending(BINDING));
        e.cancelPending(MAC);
        assertFalse(e.isPending(BINDING));
        assertFalse(e.adopt(MAC, BINDING, () -> forgotten.add(store.forget(MAC))));
        assertEquals(OLD_A, store.ledger().binding(MAC));
    }

    @Test public void adoptNeverResurrectsASignedOutComputer() throws Exception {
        PushStore store = enrolledTwice();
        PushEnrolment e = new PushEnrolment(new FakeRelay().then(201, BOUND), store, "development");
        register(e, store, MAC, true, true);
        store.forget(MAC); // signed out, not paired again
        assertFalse(e.adopt(MAC, BINDING, () -> forgotten.add(store.forget(MAC))));
        assertTrue(forgotten.isEmpty());
        assertNull(store.ledger().binding(MAC));
    }

    @Test public void adoptRefusesAnotherBindingAndAnAlreadyMovedLedger() throws Exception {
        PushStore store = enrolledTwice();
        PushEnrolment e = new PushEnrolment(new FakeRelay().then(201, BOUND), store, "development");
        Runnable forget = () -> forgotten.add(store.forget(MAC));
        assertFalse(e.adopt(MAC, BINDING, forget)); // nothing pending
        register(e, store, MAC, true, true);
        assertFalse(e.adopt(MAC, OLD_B, forget));
        assertFalse(e.adopt(PI, BINDING, forget));
        assertEquals(OLD_A, store.ledger().binding(MAC));
        // Signed out and paired again meanwhile: the pending replace no longer retires what the ledger holds.
        String other = "6b0e7a52-2f0c-4a54-9d6e-4c0b3f4f6a17";
        store.updateLedger(l -> { l.bind(other, MAC); return null; });
        assertFalse(e.adopt(MAC, BINDING, forget));
        assertTrue(forgotten.isEmpty());
        assertEquals(other, store.ledger().binding(MAC));
    }

    @Test public void aBindingTheLedgerCannotRecordIsGivenBack() throws Exception {
        FakePrefs prefs = new FakePrefs();
        PushStore store = new PushStore(prefs, memoryKey(), memoryKey());
        store.putDeviceSecret(SECRET, PUSH);
        FakeRelay relay = new FakeRelay().then(201, BOUND).then(200, "{\"removed\":true}");
        relay.hook = c -> { if (c.path.equals("/v1/bindings")) prefs.commitSucceeds = false; };
        assertNull(register(new PushEnrolment(relay, store, "development"), store, MAC, true, false));
        assertEquals(2, relay.calls.size());
        assertEquals("DELETE /v1/bindings/" + BINDING, relay.calls.get(1).method + " " + relay.calls.get(1).path);
        assertEquals(SECRET, relay.calls.get(1).secret);
        assertNull(store.ledger().binding(MAC));
        assertContentFree();
    }

    @Test public void afterADropEveryOtherComputerReplacesRatherThanReusing() throws Exception {
        // A 401 while binding the first computer: the relay forgot the install.
        PushStore store = enrolledTwice();
        FakeRelay relay = new FakeRelay().then(401, "{}").then(201, "{\"challenge\":\"" + CHALLENGE + "\"}").then(201, created(SECRET2)).then(201, BOUND);
        PushEnrolment e = new PushEnrolment(relay, store, "development");
        assertEquals("granted", register(e, store, MAC, true, true).getString("status"));
        assertEquals(SECRET2, store.deviceSecret());
        // The second computer's binding belonged to the old relay device: it is not reused.
        String next = "5b0e7a52-2f0c-4a54-9d6e-4c0b3f4f6a16";
        relay.then(201, "{\"bindingId\":\"" + next + "\",\"grant\":\"" + GRANT + "\"}");
        JSONObject pi = register(e, store, PI, true, false);
        assertEquals("granted", pi.getString("status"));
        assertEquals(next, pi.getString("bindingId"));
        assertTrue(forgotten.isEmpty()); // each old binding stays until the host takes its new one
        assertTrue(e.adopt(MAC, BINDING, () -> forgotten.add(store.forget(MAC))));
        assertTrue(e.adopt(PI, next, () -> forgotten.add(store.forget(PI))));
        assertEquals(List.of(OLD_A, OLD_B), forgotten);
        assertEquals(SECRET2, relay.calls.get(relay.calls.size() - 1).secret);
    }

    @Test public void aTokenConflictDropsEveryBindingsTokens() throws Exception {
        PushStore store = enrolledTwice();
        new PushEnrolment(new FakeRelay().then(409, "{\"error\":\"token_in_use\"}"), store, "development").tokenChanged("new-token-" + "n".repeat(40));
        assertNull(store.deviceSecret());
        assertNull(store.detail(OLD_A));
        assertNull(store.detail(OLD_B));
        assertNull(store.respond(OLD_A));
        // Re-attesting for one computer, the other still plans replace.
        FakeRelay relay = new FakeRelay().then(201, "{\"challenge\":\"" + CHALLENGE + "\"}").then(201, created(SECRET2)).then(201, BOUND);
        PushEnrolment e = new PushEnrolment(relay, store, "development");
        assertEquals("granted", register(e, store, MAC, true, false).getString("status"));
        relay.then(201, "{\"bindingId\":\"5b0e7a52-2f0c-4a54-9d6e-4c0b3f4f6a16\",\"grant\":\"" + GRANT + "\"}");
        assertEquals("granted", register(e, store, PI, true, false).getString("status"));
        assertTrue(forgotten.isEmpty());
        assertEquals(OLD_A, store.ledger().binding(MAC));
        assertEquals(OLD_B, store.ledger().binding(PI));
    }

    @Test public void aDropOnlyTakesTheSecretThatFailed() throws Exception {
        PushStore store = enrolledTwice();
        FakeRelay relay = new FakeRelay().then(409, "{\"error\":\"token_in_use\"}");
        // A registration stored a newer secret while this update was on the wire.
        relay.hook = c -> store.putDeviceSecret(SECRET2, PUSH);
        new PushEnrolment(relay, store, "development").tokenChanged("new-token-" + "n".repeat(40));
        assertEquals(SECRET2, store.deviceSecret());
        assertEquals("murage_pd_a", store.detail(OLD_A));
        assertEquals("murage_pd_b", store.detail(OLD_B));
    }
}
