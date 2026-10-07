package com.murage.mobile.shell;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;
import java.util.Base64;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * SEC-006: Java twin of ApprovalProof.swift (apps/mobile/contract/approval-proof.json).
 * Native builds the bytes from validated fields; it never signs bytes the page made.
 */
public final class ApprovalProof {
    public static final String TAG = "murage-approval-proof/1";

    private static final Pattern ID = Pattern.compile("[A-Za-z0-9_-]{1,128}");
    private static final Pattern DIGEST = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern NONCE = Pattern.compile("[A-Za-z0-9_-]{43}");

    private ApprovalProof() {}

    public static final class Request {
        public final String threadId, requestId, decision, digest, nonce, reason;
        public final long expiresAt;

        private Request(String threadId, String requestId, String decision, String digest, String nonce, long expiresAt, String reason) {
            this.threadId = threadId;
            this.requestId = requestId;
            this.decision = decision;
            this.digest = digest;
            this.nonce = nonce;
            this.expiresAt = expiresAt;
            this.reason = reason;
        }

        private static String matching(Object value, Pattern pattern) {
            return value instanceof String && pattern.matcher((String) value).matches() ? (String) value : null;
        }

        /** 1 to 256 UTF-16 units, no C0, DEL or C1 control character, no U+2028 or U+2029. */
        private static String requestId(Object value) {
            String id = ChannelArgs.string(value, 256);
            if (id == null || id.isEmpty() || hasControl(id)) return null;
            return id;
        }

        private static boolean hasControl(String text) {
            for (int i = 0; i < text.length(); i++) {
                char c = text.charAt(i);
                if (Character.getType(c) == Character.CONTROL || c == '\u2028' || c == '\u2029') return true;
            }
            return false;
        }

        private static final long MAX_SAFE = 9_007_199_254_740_991L;

        /** Same rules as ApprovalRequest.parse in ApprovalProof.swift; null when any field is refused. */
        public static Request parse(JSONObject args) {
            Integer version = ChannelArgs.integer(args.opt("v"));
            if (version == null || version != 1) return null;
            String threadId = matching(args.opt("threadId"), ID);
            String requestId = requestId(args.opt("requestId"));
            if (threadId == null || requestId == null) return null;
            Object decision = args.opt("decision");
            if (!"allow".equals(decision) && !"allow-task".equals(decision)) return null;
            String digest = matching(args.opt("digest"), DIGEST);
            String nonce = matching(args.opt("nonce"), NONCE);
            if (digest == null || nonce == null) return null;
            Object rawExpiry = args.opt("expiresAt");
            long expiresAt;
            if (rawExpiry instanceof Long) expiresAt = (Long) rawExpiry;
            else if (rawExpiry instanceof Integer) expiresAt = (Integer) rawExpiry;
            else return null;
            if (expiresAt <= 0 || expiresAt > MAX_SAFE) return null; // 2^53-1, as the page and iOS
            String reason = ChannelArgs.string(args.opt("reason"), 160);
            if (reason == null || reason.isEmpty()) return null;
            // Control, U+2028/2029 and any format (Cf) character, astral ones included: refused, never stripped.
            for (int i = 0; i < reason.length(); ) {
                int c = reason.codePointAt(i);
                int type = Character.getType(c);
                if (type == Character.CONTROL || type == Character.FORMAT || c == 0x2028 || c == 0x2029) return null;
                i += Character.charCount(c);
            }
            return new Request(threadId, requestId, (String) decision, digest, nonce, expiresAt, reason);
        }

        /** The seven lines joined by LF, UTF-8, no trailing newline. */
        public byte[] message() {
            return String.join("\n", TAG, threadId, requestId, decision, digest, nonce, Long.toString(expiresAt)).getBytes(StandardCharsets.UTF_8);
        }
    }

    /** A P-256 SPKI is 91 bytes ending in the 65-byte uncompressed point; returns it base64url, or null. */
    public static String rawPointFromSpki(byte[] spki) {
        if (spki == null || spki.length != 91 || spki[26] != 0x04) return null;
        return base64url(Arrays.copyOfRange(spki, 26, 91));
    }

    /** Strict base64url: URL alphabet only, no padding, canonical (re-encodes to the same text). Null otherwise. */
    static byte[] strictDecode(String text) {
        if (text == null || text.indexOf('=') >= 0) return null;
        try {
            byte[] data = Base64.getUrlDecoder().decode(text);
            return base64url(data).equals(text) ? data : null;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    public static String base64url(byte[] data) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(data);
    }

    /** The AndroidKeyStore alias for one workspace origin. */
    public static String alias(String serializedOrigin) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(serializedOrigin.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder("murage_approval_");
            for (int i = 0; i < 8; i++) hex.append(String.format("%02x", hash[i] & 0xff));
            return hex.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** Test-only: verifies a DER signature over the UTF-8 message; accepts high-S, as the server does. */
    static boolean verifyForTest(String point, String message, String signature) {
        try {
            byte[] raw = strictDecode(point);
            byte[] der = strictDecode(signature);
            if (raw == null || der == null) return false;
            if (raw.length != 65 || raw[0] != 0x04) return false;
            AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
            parameters.init(new ECGenParameterSpec("secp256r1"));
            ECParameterSpec curve = parameters.getParameterSpec(ECParameterSpec.class);
            ECPoint w = new ECPoint(new BigInteger(1, Arrays.copyOfRange(raw, 1, 33)), new BigInteger(1, Arrays.copyOfRange(raw, 33, 65)));
            PublicKey key = KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(w, curve));
            Signature verifier = Signature.getInstance("SHA256withECDSA");
            verifier.initVerify(key);
            verifier.update(message.getBytes(StandardCharsets.UTF_8));
            return verifier.verify(der);
        } catch (Exception e) {
            return false;
        }
    }
}
