package com.murage.mobile;

import static org.junit.Assert.*;

import com.murage.mobile.shell.ApprovalProof;
import com.murage.mobile.shell.ChannelException;
import com.murage.mobile.shell.ChannelGate;
import com.murage.mobile.shell.PhoneAskContract;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.AlgorithmParameters;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Executor;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class PhoneAskMintTest {
    @Test public void forgetRetainsBarrierUntilCacheCancellationAndPayloadCleanupFinish() throws Exception {
        FakePrefs choices = new FakePrefs(), prefs = new FakePrefs();
        WorkspaceOrigin origin = WorkspaceOrigin.parse("https://desk.example.test");
        prefs.values.put(PhoneAskTokenStore.key(origin), "ciphertext");
        PhoneAskTokenStore tokens = new PhoneAskTokenStore(name -> new SecureStore(prefs, null, name), () -> false);
        boolean[] cleaned = {false}; int[] calls = {0};
        PhoneAskSetup.PendingRemovals queue = new PhoneAskSetup.PendingRemovals(choices, tokens, (candidate, code) -> {
            assertEquals(origin, candidate); assertEquals("revoked", code);
            assertTrue(choices.getStringSet("pendingRemovals.v1", java.util.Collections.emptySet()).contains(origin.serialized()));
            assertFalse(prefs.contains(PhoneAskTokenStore.key(origin)));
            calls[0]++; return cleaned[0];
        });
        assertFalse(queue.forget(origin, "revoked")); assertTrue(queue.contains(origin));
        // A new process retains both the barrier and the reason until cleanup succeeds.
        cleaned[0] = true;
        PhoneAskSetup.PendingRemovals restored = new PhoneAskSetup.PendingRemovals(choices, tokens, (candidate, code) -> {
            assertEquals("revoked", code); assertTrue(queue.contains(origin)); calls[0]++; return true;
        });
        restored.retry(); assertFalse(restored.contains(origin)); assertEquals(2, calls[0]);
    }

    @Test public void failedTokenDeletionStillCancelsSendsAndMintCannotCrossPendingBarrier() throws Exception {
        FakePrefs choices = new FakePrefs(), prefs = new FakePrefs();
        WorkspaceOrigin origin = WorkspaceOrigin.parse("https://desk.example.test");
        PhoneAskTokenStore tokens = new PhoneAskTokenStore(name -> new SecureStore(prefs, null, name), () -> true,
            candidate -> choices.getStringSet("pendingRemovals.v1", java.util.Collections.emptySet()).contains(candidate.serialized()));
        prefs.values.put(PhoneAskTokenStore.key(origin), "ciphertext"); prefs.commitSucceeds = false;
        boolean[] cancelled = {false};
        PhoneAskSetup.PendingRemovals queue = new PhoneAskSetup.PendingRemovals(choices, tokens, (candidate, code) -> { cancelled[0] = true; return true; });
        assertFalse(queue.forget(origin)); assertTrue(cancelled[0]); assertTrue(queue.contains(origin));
        assertFalse(tokens.save(fixture().getJSONObject("token").getJSONArray("valid").getString(0), origin));
        assertNull(tokens.readForShareOrOutbox(origin));
    }

    @Test public void failedDeletionKeepsMarkerAndBearerAndRetriesAfterOwnerRecreation() throws Exception {
        FakePrefs choices = new FakePrefs(), prefs = new FakePrefs();
        KeyGenerator generator = KeyGenerator.getInstance("AES"); generator.init(256);
        SecretKey secret = generator.generateKey();
        SecureStore.Keys keys = new SecureStore.Keys() {
            @Override public SecretKey existing() { return secret; }
            @Override public SecretKey create() { return secret; }
        };
        boolean[] unlocked = {true};
        PhoneAskTokenStore tokens = new PhoneAskTokenStore(name -> new SecureStore(prefs, keys, name), () -> unlocked[0],
            origin -> choices.getStringSet("pendingRemovals.v1", java.util.Collections.emptySet()).contains(origin.serialized()));
        WorkspaceOrigin origin = WorkspaceOrigin.parse("https://desk.example.test");
        WorkspaceOrigin other = WorkspaceOrigin.parse("https://other.example.test");
        String token = fixture().getJSONObject("token").getJSONArray("valid").getString(0);
        assertTrue(tokens.save(token, origin));
        choices.edit().putString(origin.serialized(), "paired-key").putString(other.serialized(), "other-key").commit();
        PhoneAskSetup.PendingRemovals queue = new PhoneAskSetup.PendingRemovals(choices, tokens);
        prefs.commitSucceeds = false;
        unlocked[0] = false;
        assertFalse(queue.forget(origin));
        queue.retry();
        assertTrue(queue.contains(origin));
        assertEquals("paired-key", choices.getString(origin.serialized(), null));
        unlocked[0] = true;
        assertNull(tokens.readForShareOrOutbox(origin)); // Sign-out wins over the surviving bearer.
        assertTrue(prefs.contains(PhoneAskTokenStore.key(origin)));
        queue = new PhoneAskSetup.PendingRemovals(choices, tokens);
        assertTrue(queue.contains(origin));
        prefs.commitSucceeds = true;
        queue.retry(); // Same retry used by the unlock receiver and app entry.
        assertFalse(queue.contains(origin));
        assertNull(tokens.readForShareOrOutbox(origin));
        assertNull(choices.getString(origin.serialized(), null));
        assertEquals("other-key", choices.getString(other.serialized(), null));
        assertTrue(queue.forget(origin)); // An already absent token is complete.
        assertFalse(new PhoneAskSetup.PendingRemovals(choices, tokens).contains(origin));
    }

    @Test public void pendingSignOutNeverOpensTokenStorageEvenAfterUnlock() {
        WorkspaceOrigin origin = WorkspaceOrigin.parse("https://desk.example.test");
        boolean[] unlocked = {false};
        PhoneAskTokenStore tokens = new PhoneAskTokenStore(name -> {
            fail("Pending sign-out must not read ciphertext");
            return null;
        }, () -> unlocked[0], candidate -> candidate.equals(origin));
        assertNull(tokens.readForShareOrOutbox(origin));
        unlocked[0] = true;
        assertNull(tokens.readForShareOrOutbox(origin));
    }

    @Test public void deletionExceptionKeepsMarkerAndQueueUntilRetrySucceeds() {
        FakePrefs choices = new FakePrefs(), prefs = new FakePrefs();
        WorkspaceOrigin origin = WorkspaceOrigin.parse("https://desk.example.test");
        choices.edit().putString(origin.serialized(), "paired-key").commit();
        prefs.values.put(PhoneAskTokenStore.key(origin), "ciphertext");
        boolean[] fails = {true};
        PhoneAskTokenStore tokens = new PhoneAskTokenStore(name -> {
            if (fails[0]) throw new IllegalStateException("storage unavailable");
            return new SecureStore(prefs, null, name);
        }, () -> false);
        PhoneAskSetup.PendingRemovals queue = new PhoneAskSetup.PendingRemovals(choices, tokens);
        assertFalse(queue.forget(origin));
        assertEquals("paired-key", choices.getString(origin.serialized(), null));
        assertTrue(queue.contains(origin));
        assertTrue(prefs.contains(PhoneAskTokenStore.key(origin)));
        fails[0] = false;
        queue.retry(); // Ciphertext deletion itself needs no unlocked key.
        assertFalse(prefs.contains(PhoneAskTokenStore.key(origin)));
        assertFalse(queue.contains(origin));
        assertNull(choices.getString(origin.serialized(), null));
    }

    private static JSONObject fixture(String name) throws Exception {
        return new JSONObject(new String(Files.readAllBytes(Paths.get("../../contract", name)), StandardCharsets.UTF_8));
    }
    private static JSONObject fixture() throws Exception { return fixture("phone-ask.json"); }
    private static JSONObject vector() throws Exception { return fixture().getJSONObject("mint").getJSONObject("vector"); }
    private static PhoneJobsMintClient.Response response(JSONObject json) { return new PhoneJobsMintClient.Response(200, json.toString()); }
    private static JSONObject hello() throws Exception { return new JSONObject().put("mobile", 1).put("phoneAsk", 2); }
    private static JSONObject challenge(JSONObject v) throws Exception { return new JSONObject().put("nonce", v.get("nonce")).put("expiresAt", v.get("expiresAt")); }

    private static final class Done implements PhoneJobsMintClient.Completion {
        int successes, failures;
        PhoneJobsMintClient.Failure failure;
        @Override public void complete() { successes++; }
        @Override public void failed(PhoneJobsMintClient.Failure f) { failures++; failure = f; }
    }

    private static final class Key implements PhoneAskSigner.Key {
        final JSONObject v;
        String point;
        int prompts;
        PhoneJobsMintClient.Failure failure;
        Key(JSONObject v) throws Exception { this.v = v; point = v.getString("point"); }
        @Override public String point(WorkspaceOrigin origin) { return point; }
        @Override public void authenticateAndSign(PhoneAskSigner.Request request, PhoneJobsSigner.Callback callback) {
            prompts++;
            try {
                // The fixture has no private key. Replay its signature only
                // after checking the bytes sent to the signing adapter.
                assertArrayEquals(v.getString("message").getBytes(StandardCharsets.UTF_8), request.message());
                if (failure != null) callback.failed(failure);
                else callback.signed(v.getString("signature"));
            } catch (Exception e) { throw new AssertionError(e); }
        }
    }

    private static final class Writer implements PhoneJobsMintClient.TokenWriter {
        int writes;
        String token;
        WorkspaceOrigin origin;
        boolean works = true;
        @Override public boolean save(String token, WorkspaceOrigin origin) {
            if (!works) return false;
            writes++; this.token = token; this.origin = origin; return true;
        }
    }

    private static final class HTTP implements PhoneJobsMintClient.Transport {
        final List<PhoneJobsMintClient.Response> answers = new ArrayList<>();
        final List<String> calls = new ArrayList<>();
        final List<JSONObject> bodies = new ArrayList<>();
        @Override public PhoneJobsMintClient.Response send(WorkspaceOrigin origin, String method, String path, JSONObject body) {
            calls.add(method + " " + origin.serialized() + path);
            bodies.add(body);
            return answers.get(calls.size() - 1);
        }
    }

    private static PhoneJobsMintClient client(Key key, Writer writer, HTTP http) {
        return new PhoneJobsMintClient(new PhoneAskSigner(key), writer, http, Runnable::run, Runnable::run, () -> 1_700_000_000_000L);
    }

    private static PublicKey publicKey(String point) throws Exception {
        byte[] raw = Base64.getUrlDecoder().decode(point);
        AlgorithmParameters p = AlgorithmParameters.getInstance("EC");
        p.init(new ECGenParameterSpec("secp256r1"));
        ECPoint w = new ECPoint(new BigInteger(1, Arrays.copyOfRange(raw, 1, 33)), new BigInteger(1, Arrays.copyOfRange(raw, 33, 65)));
        return KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(w, p.getParameterSpec(ECParameterSpec.class)));
    }

    private static boolean verify(PublicKey key, byte[] message, String signature) throws Exception {
        Signature verifier = Signature.getInstance("SHA256withECDSA");
        verifier.initVerify(key); verifier.update(message);
        return verifier.verify(Base64.getUrlDecoder().decode(signature));
    }

    @Test public void signerUsesFixtureBytesAndDERAndSoftwareKeyVerifies() throws Exception {
        JSONObject v = vector();
        Key key = new Key(v);
        PhoneAskSigner signer = new PhoneAskSigner(key);
        WorkspaceOrigin origin = WorkspaceOrigin.parse(v.getString("origin"));
        String[] signature = {null};
        PhoneJobsSigner.Callback callback = new PhoneJobsSigner.Callback() {
            @Override public void signed(String s) { signature[0] = s; }
            @Override public void failed(PhoneJobsMintClient.Failure f) { fail(f.name()); }
        };
        signer.sign(origin, v.getString("keyId"), v.getString("nonce"), v.getLong("expiresAt"), callback);
        assertEquals(1, key.prompts);
        assertTrue(verify(publicKey(v.getString("point")), v.getString("message").getBytes(StandardCharsets.UTF_8), signature[0]));
        assertFalse(signature[0].contains("="));
        String jobsMessage = fixture().getJSONObject("mint").getJSONObject("crossPurpose").getJSONObject("askVectorAsJobs").getString("message");
        assertFalse(verify(publicKey(v.getString("point")), jobsMessage.getBytes(StandardCharsets.UTF_8), signature[0]));

        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair fresh = generator.generateKeyPair();
        String point = ApprovalProof.rawPointFromSpki(fresh.getPublic().getEncoded());
        PhoneAskSigner software = new PhoneAskSigner(new PhoneAskSigner.Key() {
            @Override public String point(WorkspaceOrigin o) { return point; }
            @Override public void authenticateAndSign(PhoneAskSigner.Request r, PhoneJobsSigner.Callback cb) {
                try {
                    Signature s = Signature.getInstance("SHA256withECDSA");
                    s.initSign(fresh.getPrivate()); s.update(r.message()); cb.signed(ApprovalProof.base64url(s.sign()));
                } catch (Exception e) { throw new AssertionError(e); }
            }
        });
        software.sign(origin, software.keyId(origin), v.getString("nonce"), v.getLong("expiresAt"), callback);
        byte[] message = PhoneAskContract.phoneAskMessage(origin.serialized(), software.keyId(origin), v.getString("nonce"), v.getLong("expiresAt")).getBytes(StandardCharsets.UTF_8);
        assertTrue(verify(fresh.getPublic(), message, signature[0]));
        signer.sign(origin, v.getString("keyId"), v.getString("nonce") + "\n", v.getLong("expiresAt"), new PhoneJobsSigner.Callback() {
            @Override public void signed(String s) { fail("bad nonce signed"); }
            @Override public void failed(PhoneJobsMintClient.Failure f) { assertEquals(PhoneJobsMintClient.Failure.INVALID_RESPONSE, f); }
        });
        assertEquals(1, key.prompts);
    }

    @Test public void mintSuccessUsesDoorHelloExactRoutesOnePromptAndStoresWithoutReturningToken() throws Exception {
        JSONObject v = vector(); Key key = new Key(v); Writer writer = new Writer(); HTTP http = new HTTP(); Done done = new Done();
        String token = fixture().getJSONObject("token").getJSONArray("valid").getString(0);
        http.answers.add(response(hello())); http.answers.add(response(challenge(v))); http.answers.add(response(new JSONObject().put("token", token)));
        WorkspaceOrigin origin = WorkspaceOrigin.parse(v.getString("origin"));
        client(key, writer, http).mint(origin, done);
        assertEquals(1, done.successes); assertEquals(0, done.failures); assertEquals(1, key.prompts);
        assertEquals(Arrays.asList("GET " + origin.serialized() + "/healthz", "GET " + origin.serialized() + "/api/phones/self/challenge?key=" + v.getString("keyId"), "POST " + origin.serialized() + "/api/phones/self/token"), http.calls);
        JSONObject body = http.bodies.get(2);
        assertEquals(5, body.length());
        assertEquals("ask", body.getString("scope"));
        for (String field : Arrays.asList("keyId", "nonce", "expiresAt", "signature")) assertEquals(v.get(field), body.get(field));
        assertEquals(1, writer.writes); assertEquals(token, writer.token); assertEquals(origin, writer.origin);
        // Completion has no payload through which the setup screen could receive the token.
        assertEquals(0, PhoneJobsMintClient.Completion.class.getDeclaredMethod("complete").getParameterCount());
    }

    @Test public void challengeRefusalRateLimitAndNotOfferedNeverPromptOrStore() throws Exception {
        JSONObject v = vector();
        for (int status : new int[] {403, 429, 404}) {
            Key key = new Key(v); Writer writer = new Writer(); HTTP http = new HTTP(); Done done = new Done();
            http.answers.add(response(hello())); http.answers.add(new PhoneJobsMintClient.Response(status, "{}"));
            client(key, writer, http).mint(WorkspaceOrigin.parse(v.getString("origin")), done);
            assertEquals(status == 403 ? PhoneJobsMintClient.Failure.REFUSED : status == 404 ? PhoneJobsMintClient.Failure.NOT_OFFERED : PhoneJobsMintClient.Failure.RATE_LIMITED, done.failure);
            assertEquals(1, done.failures); assertEquals(0, done.successes); assertEquals(0, key.prompts); assertEquals(0, writer.writes); assertEquals(2, http.calls.size());
        }
    }

    @Test public void oldDoorAndMissingKeyShowExactCopyBeforeChallenge() throws Exception {
        assertEquals(R.string.ask_update, PhoneAskSetup.errorResource(PhoneJobsMintClient.Failure.UPDATE_COMPUTER));
        assertEquals(R.string.ask_no_key, PhoneAskSetup.errorResource(PhoneJobsMintClient.Failure.NO_APPROVAL_KEY));
        assertEquals(R.string.ask_computer_off, PhoneAskSetup.errorResource(PhoneJobsMintClient.Failure.REFUSED));
        assertEquals(R.string.ask_cloud, PhoneAskSetup.errorResource(PhoneJobsMintClient.Failure.NOT_OFFERED));
        JSONObject v = vector();
        for (String hello : Arrays.asList("{\"mobile\":1}", "{\"mobile\":1,\"phoneJobs\":1}", "{\"mobile\":1,\"phoneAsk\":0}", "{\"mobile\":1,\"phoneAsk\":true}", "{\"mobile\":1,\"phoneAsk\":\"1\"}", "{\"phoneAsk\":1}")) {
            Key key = new Key(v); HTTP http = new HTTP(); Done done = new Done(); Writer writer = new Writer();
            http.answers.add(new PhoneJobsMintClient.Response(200, hello));
            client(key, writer, http).mint(WorkspaceOrigin.parse(v.getString("origin")), done);
            assertEquals(PhoneJobsMintClient.Failure.UPDATE_COMPUTER, done.failure);
            assertEquals(1, http.calls.size()); assertEquals(0, key.prompts); assertEquals(0, writer.writes);
        }
        Key key = new Key(v); key.point = null; HTTP http = new HTTP(); Done done = new Done(); Writer writer = new Writer();
        client(key, writer, http).mint(WorkspaceOrigin.parse(v.getString("origin")), done);
        assertEquals(PhoneJobsMintClient.Failure.NO_APPROVAL_KEY, done.failure);
        assertEquals(0, http.calls.size()); assertEquals(0, key.prompts); assertEquals(0, writer.writes);
    }

    @Test public void malformedTokensAndTokenRefusalsNeverWrite() throws Exception {
        JSONObject v = vector();
        List<PhoneJobsMintClient.Response> answers = new ArrayList<>();
        JSONArray invalid = fixture().getJSONObject("token").getJSONArray("invalid");
        for (int i = 0; i < invalid.length(); i++) answers.add(response(new JSONObject().put("token", invalid.get(i))));
        answers.add(response(new JSONObject().put("token", fixture().getJSONObject("token").getJSONArray("valid").getString(0) + "\n")));
        answers.add(response(new JSONObject().put("token", true)));
        answers.add(new PhoneJobsMintClient.Response(403, "{}")); answers.add(new PhoneJobsMintClient.Response(429, "{}")); answers.add(new PhoneJobsMintClient.Response(503, "{}"));
        for (PhoneJobsMintClient.Response answer : answers) {
            Key key = new Key(v); Writer writer = new Writer(); HTTP http = new HTTP(); Done done = new Done();
            http.answers.add(response(hello())); http.answers.add(response(challenge(v))); http.answers.add(answer);
            client(key, writer, http).mint(WorkspaceOrigin.parse(v.getString("origin")), done);
            PhoneJobsMintClient.Failure expected = answer.status == 403 ? PhoneJobsMintClient.Failure.REFUSED : answer.status == 429 ? PhoneJobsMintClient.Failure.RATE_LIMITED
                : answer.status == 503 ? PhoneJobsMintClient.Failure.UNAVAILABLE : PhoneJobsMintClient.Failure.INVALID_RESPONSE;
            assertEquals(expected, done.failure); assertEquals(0, writer.writes); assertEquals(1, key.prompts); assertEquals(3, http.calls.size());
        }
    }

    @Test public void malformedChallengeCancelledPromptAndChangedKeyStopMint() throws Exception {
        JSONObject v = vector();
        for (Object bad : Arrays.asList(true, "1700000060000", 1_700_000_060_000.5, 0, 9_007_199_254_740_992L)) {
            Key key = new Key(v); Writer writer = new Writer(); HTTP http = new HTTP(); Done done = new Done();
            http.answers.add(response(hello())); http.answers.add(response(challenge(v).put("expiresAt", bad)));
            client(key, writer, http).mint(WorkspaceOrigin.parse(v.getString("origin")), done);
            assertEquals(PhoneJobsMintClient.Failure.INVALID_RESPONSE, done.failure); assertEquals(0, key.prompts); assertEquals(0, writer.writes);
        }
        Key key = new Key(v); key.failure = PhoneJobsMintClient.Failure.CANCELLED;
        Writer writer = new Writer(); HTTP http = new HTTP(); Done done = new Done();
        http.answers.add(response(hello())); http.answers.add(response(challenge(v)));
        client(key, writer, http).mint(WorkspaceOrigin.parse(v.getString("origin")), done);
        assertEquals(PhoneJobsMintClient.Failure.CANCELLED, done.failure); assertEquals(1, key.prompts); assertEquals(2, http.calls.size()); assertEquals(0, writer.writes);
        key.point = null;
        new PhoneAskSigner(key).sign(WorkspaceOrigin.parse(v.getString("origin")), v.getString("keyId"), v.getString("nonce"), v.getLong("expiresAt"), new PhoneJobsSigner.Callback() {
            @Override public void signed(String signature) { fail("changed key"); }
            @Override public void failed(PhoneJobsMintClient.Failure f) { assertEquals(PhoneJobsMintClient.Failure.NO_APPROVAL_KEY, f); }
        });
        assertEquals(1, key.prompts);
    }

    @Test public void busyAndCancellationIgnoreLateAnswersWithoutPrompting() throws Exception {
        JSONObject v = vector(); Key key = new Key(v); Writer writer = new Writer(); HTTP http = new HTTP(); Done first = new Done(), second = new Done();
        List<Runnable> pending = new ArrayList<>(); Executor queue = pending::add;
        http.answers.add(response(hello()));
        PhoneJobsMintClient client = new PhoneJobsMintClient(new PhoneAskSigner(key), writer, http, queue, Runnable::run, () -> 1_700_000_000_000L);
        WorkspaceOrigin origin = WorkspaceOrigin.parse(v.getString("origin"));
        client.mint(origin, first); client.mint(origin, second);
        assertEquals(PhoneJobsMintClient.Failure.BUSY, second.failure);
        client.cancel(); pending.remove(0).run();
        assertEquals(PhoneJobsMintClient.Failure.CANCELLED, first.failure); assertEquals(1, first.failures);
        assertEquals(0, writer.writes); assertEquals(0, key.prompts); assertTrue(pending.isEmpty());
    }

    @Test public void tokenUsesOwnEncryptedSecureStoreKeyAndCannotMoveBetweenOrigins() throws Exception {
        new LogCapture();
        FakePrefs prefs = new FakePrefs();
        KeyGenerator generator = KeyGenerator.getInstance("AES"); generator.init(256); SecretKey secret = generator.generateKey();
        SecureStore.Keys keys = new SecureStore.Keys() {
            @Override public SecretKey existing() { return secret; }
            @Override public SecretKey create() { return secret; }
        };
        boolean[] unlocked = {true};
        PhoneAskTokenStore store = new PhoneAskTokenStore(name -> new SecureStore(prefs, keys, name), () -> unlocked[0]);
        WorkspaceOrigin origin = WorkspaceOrigin.parse("https://desk.example.test"), other = WorkspaceOrigin.parse("https://other.example.test");
        String token = fixture().getJSONObject("token").getJSONArray("valid").getString(0);
        assertNull(store.readForShareOrOutbox(origin));
        assertTrue(store.save(token, origin));
        assertEquals(token, store.readForShareOrOutbox(origin));
        unlocked[0] = false;
        try { store.readForShareOrOutbox(origin); fail("locked read"); } catch (IllegalStateException expected) { }
        assertFalse(store.save(token, origin));
        unlocked[0] = true;
        assertEquals(token, store.readForShareOrOutbox(origin));
        assertEquals(1, prefs.values.size()); assertFalse(prefs.values.containsKey("book"));
        String name = PhoneAskTokenStore.key(origin);
        assertTrue(name.startsWith("phone_ask.v1.")); assertNotEquals(name, PhoneAskTokenStore.key(other));
        String sealed = (String) prefs.values.get(name);
        assertFalse(new String(Base64.getDecoder().decode(sealed), StandardCharsets.ISO_8859_1).contains(token));
        prefs.values.put(PhoneAskTokenStore.key(other), sealed);
        try { store.readForShareOrOutbox(other); fail("moved ciphertext"); } catch (IllegalStateException expected) { /* authentication tag binds origin */ }
        assertFalse(store.save(token + "\n", origin));
        assertEquals(token, store.readForShareOrOutbox(origin));
        assertTrue(store.remove(origin)); assertNull(store.readForShareOrOutbox(origin));
        prefs.commitSucceeds = false;
        assertFalse(store.save(token, origin));
    }

    @Test public void storageFailureCannotReportMintSuccess() throws Exception {
        JSONObject v = vector(); Key key = new Key(v); Writer writer = new Writer(); HTTP http = new HTTP(); Done done = new Done();
        writer.works = false;
        http.answers.add(response(hello())); http.answers.add(response(challenge(v)));
        http.answers.add(response(new JSONObject().put("token", fixture().getJSONObject("token").getJSONArray("valid").getString(0))));
        client(key, writer, http).mint(WorkspaceOrigin.parse(v.getString("origin")), done);
        assertEquals(PhoneJobsMintClient.Failure.STORAGE, done.failure); assertEquals(0, done.successes);
        assertEquals(1, key.prompts); assertEquals(3, http.calls.size()); assertEquals(0, writer.writes);
    }

    @Test public void everyBridgeEntryRemainsSeparateFromMintAndTokenStore() throws Exception {
        Set<String> allowed = new HashSet<>(Arrays.asList("ready saveFile openExternal haptic signOut rePair setRoute showLauncher registerPush pushStatus issuePushTokens setBadgeCount callSessionOpen callSessionClose diagLine openPhoneForBots approveWithDevice".split(" ")));
        assertEquals(allowed, new HashSet<>(ChannelGate.ADVERTISED));
        for (String name : Arrays.asList("phoneAsk", "mintPhoneAsk", "signPhoneAsk", "readForShareOrOutbox", "PhoneAskSigner")) {
            try { ChannelGate.parse(new JSONObject().put("id", 1).put("method", name).put("args", new JSONObject()).toString()); fail(name); }
            catch (ChannelException expected) { assertEquals("unknown_method", expected.code); }
        }
        JSONObject v = vector();
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC"); generator.initialize(new ECGenParameterSpec("secp256r1")); KeyPair key = generator.generateKeyPair();
        JSONArray entries = fixture("approval-proof.json").getJSONArray("accepted");
        for (int i = 0; i < entries.length(); i++) {
            JSONObject args = entries.getJSONObject(i).getJSONObject("args").put("tag", PhoneAskSigner.TAG).put("message", v.get("message"));
            ApprovalProof.Request request = ApprovalProof.Request.parse(args);
            assertNotNull(request);
            assertTrue(new String(request.message(), StandardCharsets.UTF_8).startsWith("murage-approval-proof/1\n"));
            Signature s = Signature.getInstance("SHA256withECDSA"); s.initSign(key.getPrivate()); s.update(request.message());
            assertFalse(verify(key.getPublic(), v.getString("message").getBytes(StandardCharsets.UTF_8), ApprovalProof.base64url(s.sign())));
        }
        String source = new String(Files.readAllBytes(Paths.get("src/main/java/com/murage/mobile/WorkspaceActivity.java")), StandardCharsets.UTF_8);
        int start = source.indexOf("private void onChannel(");
        assertTrue(start >= 0);
        String dispatch = source.substring(start, source.indexOf("\n    }\n", start));
        for (String forbidden : Arrays.asList("PhoneAskSigner", "PhoneJobsMint", "PhoneAskTokenStore", "signPhoneAsk", "readForShareOrOutbox", "murage_pa_")) assertFalse(forbidden, dispatch.contains(forbidden));
        assertTrue(dispatch.contains("ApprovalKeys.sign(this, origin, approval,"));
        assertEquals(2, ChannelGate.hello().length()); assertTrue(ChannelGate.hello().has("version")); assertTrue(ChannelGate.hello().has("methods"));
    }
}
