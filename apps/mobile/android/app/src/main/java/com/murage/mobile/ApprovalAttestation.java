package com.murage.mobile;

import com.murage.mobile.shell.PairingLink;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * SEC-006 decision 8 (P9), Android: one Play Integrity attestation at pairing,
 * over a nonce that names the approval key, so the relay can sign a statement
 * that the key lives in the genuine app. JVM-testable (no Android classes).
 * The statement, key, challenge, nonce and token are never logged here.
 */
final class ApprovalAttestation {
    private static final String TAG = "murage-approval-key/1";
    private static final Pattern CHALLENGE = Pattern.compile("^[A-Za-z0-9_-]{43}$");
    private ApprovalAttestation() {}

    /** Lowercase hex SHA-256 of the 65 raw key bytes; null unless an uncompressed P-256 point in base64url. */
    static String keyHash(String approvalKey) {
        try {
            byte[] point = Base64.getUrlDecoder().decode(approvalKey);
            if (point.length != 65 || point[0] != 4) return null;
            StringBuilder hex = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(point)) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (Exception notAKey) {
            return null;
        }
    }

    /** Unpadded base64url of SHA-256(UTF-8 of {@code murage-approval-key/1\n<challenge>\n<installId>\n<keyHash>}): the relay's approvalBindingNonce. */
    static String bindingNonce(String challenge, String installId, String approvalKey) {
        String hash = keyHash(approvalKey);
        if (hash == null) return null;
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest((TAG + "\n" + challenge + "\n" + installId + "\n" + hash).getBytes(StandardCharsets.UTF_8));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(digest);
        } catch (Exception impossible) {
            return null;
        }
    }

    /**
     * One attempt, blocking (call off the main thread): challenge, attest the
     * binding nonce, ask for the statement. Null on any miss (no Play Services,
     * no network, a refusal, the 5 per install per hour limit); the caller then
     * pairs without a key. No retry.
     */
    static String statement(PushEnrolment.Relay relay, PushEnrolment.Attest attest, String environment, String installId, String approvalKey) {
        try {
            RelayClient.Answer asked = relay.call("POST", "/v1/challenges", null, null);
            String challenge = asked.status == 201 ? asked.body.optString("challenge", null) : null;
            if (challenge == null || !CHALLENGE.matcher(challenge).matches()) return null;
            String nonce = bindingNonce(challenge, installId, approvalKey);
            if (nonce == null) return null;
            String token = attest.token(nonce);
            // No token: the relay would refuse with 400 after the challenge is spent. Skip the call.
            if (token == null || token.isEmpty()) return null;
            JSONObject body = new JSONObject().put("platform", "android").put("environment", environment).put("challenge", challenge)
                .put("installId", installId).put("approvalKey", approvalKey)
                .put("attestation", new JSONObject().put("kind", "play-integrity").put("token", token));
            RelayClient.Answer made = relay.call("POST", "/v1/approval-keys", null, body);
            String statement = made.status == 201 ? made.body.optString("statement", null) : null;
            return PairingLink.validApprovalStatement(statement) ? statement : null;
        } catch (Exception failed) {
            return null;
        }
    }

    /** The pairing path. A key travels only with a valid statement; otherwise the link carries neither. */
    static String enterPath(String credential, String installId, String approvalKey, String approvalStatement) {
        if (approvalKey != null && PairingLink.validApprovalStatement(approvalStatement)) {
            return PairingLink.enterPath(credential, installId, approvalKey, approvalStatement);
        }
        return PairingLink.enterPath(credential, installId);
    }
}
