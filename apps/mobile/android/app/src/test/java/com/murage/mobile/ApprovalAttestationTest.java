package com.murage.mobile;

import static org.junit.Assert.*;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public class ApprovalAttestationTest {
    static final String CHALLENGE = "ccccccccccccccccccccccccccccccccccccccccccc";
    static final String INSTALL = "install-0123456789abcdef";
    static final String KEY = "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
    static final String NONCE = "UN2c6c0F-1AOnOUvSdQGdncHDywJnuy_rPVYm56KLhI";
    static final String STATEMENT = "p".repeat(300) + "." + "s".repeat(86);

    @Test public void bindingNonceMatchesTheRelayVector() {
        assertEquals("698bea63dc44a344663ff1429aea10842df27b6b991ef25866b2c6c02cdcc5be", ApprovalAttestation.keyHash(KEY));
        assertEquals(NONCE, ApprovalAttestation.bindingNonce(CHALLENGE, INSTALL, KEY));
    }

    @Test public void aKeyThatIsNotAPointHasNoHash() {
        assertNull(ApprovalAttestation.keyHash("AAAA"));
        assertNull(ApprovalAttestation.bindingNonce(CHALLENGE, INSTALL, "AAAA"));
    }

    @Test public void attestsTheBindingNonceAndReturnsTheStatement() throws Exception {
        ArrayDeque<RelayClient.Answer> answers = new ArrayDeque<>();
        answers.add(new RelayClient.Answer(201, new JSONObject().put("challenge", CHALLENGE)));
        answers.add(new RelayClient.Answer(201, new JSONObject().put("statement", STATEMENT).put("expiresAt", 1)));
        List<String> paths = new ArrayList<>(); List<JSONObject> bodies = new ArrayList<>(); List<String> nonces = new ArrayList<>();
        String got = ApprovalAttestation.statement((m, p, s, b) -> { paths.add(m + " " + p); bodies.add(b); return answers.poll(); },
            nonce -> { nonces.add(nonce); return "integrity-token"; }, "production", INSTALL, KEY);
        assertEquals(STATEMENT, got);
        assertEquals(List.of(NONCE), nonces); // never the bare challenge
        assertEquals(List.of("POST /v1/challenges", "POST /v1/approval-keys"), paths);
        JSONObject body = bodies.get(1);
        assertEquals("android", body.getString("platform"));
        assertEquals("production", body.getString("environment"));
        assertEquals(CHALLENGE, body.getString("challenge"));
        assertEquals(INSTALL, body.getString("installId"));
        assertEquals(KEY, body.getString("approvalKey"));
        assertEquals("play-integrity", body.getJSONObject("attestation").getString("kind"));
        assertEquals("integrity-token", body.getJSONObject("attestation").getString("token"));
    }

    @Test public void anyFailureMeansNoStatementAndNoSecondAttempt() {
        int[] calls = {0};
        assertNull(ApprovalAttestation.statement((m, p, s, b) -> { calls[0]++; return new RelayClient.Answer(0, new JSONObject()); }, n -> "t", "production", INSTALL, KEY));
        assertEquals(1, calls[0]);
        calls[0] = 0;
        assertNull(ApprovalAttestation.statement((m, p, s, b) -> { calls[0]++; return p.equals("/v1/challenges") ? answer(201, "challenge", CHALLENGE) : answer(403, "error", "attestation_failed"); }, n -> "t", "production", INSTALL, KEY));
        assertEquals(2, calls[0]);
        assertNull(ApprovalAttestation.statement((m, p, s, b) -> p.equals("/v1/challenges") ? answer(201, "challenge", "short") : answer(201, "statement", STATEMENT), n -> "t", "production", INSTALL, KEY));
        assertNull(ApprovalAttestation.statement((m, p, s, b) -> answer(201, "challenge", CHALLENGE), n -> { throw new Exception("no play services"); }, "production", INSTALL, KEY));
        assertNull(ApprovalAttestation.statement((m, p, s, b) -> p.equals("/v1/challenges") ? answer(201, "challenge", CHALLENGE) : answer(201, "statement", "a&b"), n -> "t", "production", INSTALL, KEY));
    }

    /** F4: no token means no relay call, so the challenge is the only quota spent. */
    @Test public void aMissingOrEmptyIntegrityTokenSkipsTheRelayCall() {
        for (String token : new String[] {null, ""}) {
            List<String> paths = new ArrayList<>();
            assertNull(ApprovalAttestation.statement((m, p, s, b) -> { paths.add(p); return answer(201, "challenge", CHALLENGE); }, n -> token, "production", INSTALL, KEY));
            assertEquals(List.of("/v1/challenges"), paths);
        }
    }

    /** From the P4 review: a key never goes without its statement. */
    @Test public void noStatementPairsWithoutAKeyAtAll() {
        String link = ApprovalAttestation.enterPath("murage_pair_abc", INSTALL, KEY, null);
        assertEquals("/enter#murage_pair_abc&installId=" + INSTALL, link);
        assertFalse(link.contains("approvalKey"));
        assertEquals("/enter#murage_pair_abc&installId=" + INSTALL + "&approvalKey=" + KEY + "&approvalStatement=" + STATEMENT,
            ApprovalAttestation.enterPath("murage_pair_abc", INSTALL, KEY, STATEMENT));
        // A statement that fails the shape check also falls back to no key.
        assertEquals("/enter#murage_pair_abc&installId=" + INSTALL, ApprovalAttestation.enterPath("murage_pair_abc", INSTALL, KEY, "a&b"));
        assertEquals("/enter#murage_pair_abc", ApprovalAttestation.enterPath("murage_pair_abc", null, null, null));
    }

    private static RelayClient.Answer answer(int status, String k, String v) {
        try { return new RelayClient.Answer(status, new JSONObject().put(k, v)); } catch (Exception e) { throw new AssertionError(e); }
    }
}
