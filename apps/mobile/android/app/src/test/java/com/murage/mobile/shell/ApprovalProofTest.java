package com.murage.mobile.shell;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.spec.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class ApprovalProofTest {
    private static JSONObject contract() throws Exception { return new JSONObject(Fixtures.read("approval-proof.json")); }

    @Test public void acceptedArgsBuildTheExactMessage() throws Exception {
        JSONArray accepted = contract().getJSONArray("accepted");
        assertEquals(3, accepted.length()); // the committed vector has three accepted cases
        for (int i = 0; i < accepted.length(); i++) {
            JSONObject entry = accepted.getJSONObject(i);
            ApprovalProof.Request request = ApprovalProof.Request.parse(entry.getJSONObject("args"));
            assertNotNull(entry.toString(), request);
            assertEquals(entry.getString("message"), new String(request.message(), StandardCharsets.UTF_8));
        }
    }

    @Test public void refusedArgs() throws Exception {
        JSONArray refused = contract().getJSONArray("refused");
        for (int i = 0; i < refused.length(); i++) {
            assertNull(refused.getJSONObject(i).getString("why"), ApprovalProof.Request.parse(refused.getJSONObject(i).getJSONObject("args")));
        }
    }

    private static JSONObject first() throws Exception {
        return new JSONObject(contract().getJSONArray("accepted").getJSONObject(0).getJSONObject("args").toString());
    }

    @Test public void requestIdFollowsTheContract() throws Exception {
        JSONObject args = first();
        String[] ok = {"req.1:x", "r", new String(new char[256]).replace('\0', 'x')};
        for (String id : ok) { args.put("requestId", id); assertNotNull(id, ApprovalProof.Request.parse(args)); }
        String[] bad = {"", new String(new char[257]).replace('\0', 'x'), "a\u0001b", "a\u007fb", "a\u0085b", "a\u009fb", "a\u2028b", "a\u2029b", "a\nb"};
        for (String id : bad) { args.put("requestId", id); assertNull(id, ApprovalProof.Request.parse(args)); }
        args.put("threadId", "t.1");
        args.put("requestId", "req-1");
        assertNull(ApprovalProof.Request.parse(args));
    }

    @Test public void acceptedCasesByNameVerifyEachSignature() throws Exception {
        JSONArray accepted = contract().getJSONArray("accepted");
        assertEquals(3, accepted.length());
        String[] prefixes = {"allow, low-S", "allow-task, random nonce", "allow, high-S"};
        for (int i = 0; i < 3; i++) {
            JSONObject entry = accepted.getJSONObject(i);
            assertTrue(entry.getString("name"), entry.getString("name").startsWith(prefixes[i]));
            assertTrue(entry.getString("name"), ApprovalProof.verifyForTest(entry.getString("publicKey"), entry.getString("message"), entry.getString("signatureDer")));
        }
    }

    @Test public void signatureCasesMatchExpectedVerdict() throws Exception {
        JSONArray cases = contract().getJSONArray("signatureCases");
        assertTrue(cases.length() >= 4);
        boolean sawRaw = false, sawTag = false;
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            boolean verdict = ApprovalProof.verifyForTest(c.getString("publicKey"), c.getString("message"), c.getString("signatureDer"));
            assertEquals(c.getString("name"), c.getJSONObject("expect").getBoolean("verify"), verdict);
            if (c.getString("name").startsWith("raw r||s")) sawRaw = true;
            if (c.getString("name").equals("malformed DER")) sawTag = true;
        }
        assertTrue(sawRaw && sawTag);
    }

    @Test public void base64urlIsStrict() {
        assertNotNull(ApprovalProof.strictDecode("AAAA"));
        assertNull(ApprovalProof.strictDecode("AA=="));
        assertNull(ApprovalProof.strictDecode("AA+/"));
        assertNull(ApprovalProof.strictDecode("AB"));
    }

    @Test public void requestIdLengthCountsUtf16Units() throws Exception {
        JSONObject args = first();
        StringBuilder astral = new StringBuilder();
        for (int i = 0; i < 128; i++) astral.appendCodePoint(0x1F600);
        assertEquals(256, astral.length());
        args.put("requestId", astral.toString());
        assertNotNull(ApprovalProof.Request.parse(args));
        astral.appendCodePoint(0x1F600);
        args.put("requestId", astral.toString());
        assertNull(ApprovalProof.Request.parse(args));
    }

    @Test public void trailingAndLeadingLineTerminatorsAreRefused() throws Exception {
        String[] terminators = {"\n", "\r", "\r\n", "\u000B", "\u000C", "\u0085", "\u2028", "\u2029"};
        for (String field : new String[] {"threadId", "digest", "nonce"}) {
            for (String terminator : terminators) {
                JSONObject args = first();
                String value = args.getString(field);
                args.put(field, value + terminator);
                assertNull(field + " trailing", ApprovalProof.Request.parse(args));
                args.put(field, terminator + value);
                assertNull(field + " leading", ApprovalProof.Request.parse(args));
            }
        }
    }

    @Test public void expiresAtMustBeAnIntegerInstance() throws Exception {
        JSONObject args = new JSONObject(contract().getJSONArray("accepted").getJSONObject(0).getJSONObject("args").toString());
        args.put("expiresAt", 1700000060000.0);
        assertNull(ApprovalProof.Request.parse(args));
        args.put("expiresAt", "1700000060000");
        assertNull(ApprovalProof.Request.parse(args));
        args.put("expiresAt", 0L);
        assertNull(ApprovalProof.Request.parse(args));
        args.put("expiresAt", 1700000060000L);
        assertNotNull(ApprovalProof.Request.parse(args));
    }

    /** The Android bridge hands native a JSON string (postMessage of JSON.stringify), so numbers
     *  arrive as org.json parses text: whole values as Integer or Long, never as a decimal. */
    @Test public void numbersFromTheBridgeTextAreAccepted() throws Exception {
        JSONArray accepted = contract().getJSONArray("accepted");
        for (int i = 0; i < accepted.length(); i++) {
            JSONObject entry = accepted.getJSONObject(i);
            JSONObject reparsed = new JSONObject(entry.getJSONObject("args").toString());
            ApprovalProof.Request request = ApprovalProof.Request.parse(reparsed);
            assertNotNull(entry.toString(), request);
            assertEquals(entry.getString("message"), new String(request.message(), StandardCharsets.UTF_8));
        }
        JSONObject args = first();
        JSONObject viaText = new JSONObject(args.toString().replaceAll("\"expiresAt\":\\d+", "\"expiresAt\":1760000000000").replaceAll("\"v\":\\d+", "\"v\":1"));
        assertTrue(viaText.get("expiresAt") instanceof Long);
        assertEquals(1760000000000L, ApprovalProof.Request.parse(viaText).expiresAt);
        for (String bad : new String[] {"1.5", "1760000000000.5", "true", "\"1760000000000\"", "9007199254740992", "1e21", "0", "-5"}) {
            JSONObject text = new JSONObject(args.toString().replaceAll("\"expiresAt\":\\d+", "\"expiresAt\":" + bad.replace("\\", "\\\\")));
            assertNull("expiresAt " + bad, ApprovalProof.Request.parse(text));
        }
        assertNotNull(ApprovalProof.Request.parse(new JSONObject(args.toString().replaceAll("\"expiresAt\":\\d+", "\"expiresAt\":9007199254740991"))));
    }

    @Test public void reasonRules() throws Exception {
        JSONObject args = new JSONObject(contract().getJSONArray("accepted").getJSONObject(0).getJSONObject("args").toString());
        String[] bad = {"", "a\nb", "a\u2028b", "a\u2029b", "a\u007fb", "a\u202eb", "a\u2066b", "a\u200bb", "a\u200fb", "\ufeffa", "a\u061cb", "a\ud83d\ude00\udb40\udc01b", new String(new char[161]).replace('\0', 'x')};
        for (String reason : bad) {
            args.put("reason", reason);
            assertNull(reason, ApprovalProof.Request.parse(args));
        }
        args.put("reason", new String(new char[160]).replace('\0', 'x'));
        assertNotNull(ApprovalProof.Request.parse(args));
    }

    @Test public void spkiBecomesTheRawPointAndVerifies() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair pair = generator.generateKeyPair();
        String point = ApprovalProof.rawPointFromSpki(pair.getPublic().getEncoded());
        assertNotNull(point);
        assertEquals(87, point.length());
        Signature signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign(pair.getPrivate());
        signer.update("m".getBytes(StandardCharsets.UTF_8));
        assertTrue(ApprovalProof.verifyForTest(point, "m", ApprovalProof.base64url(signer.sign())));
        assertNull(ApprovalProof.rawPointFromSpki(new byte[91]));
        assertNull(ApprovalProof.rawPointFromSpki(new byte[90]));
    }

    @Test public void committedSignatureVerifies() throws Exception {
        JSONObject signature = contract().getJSONObject("signature");
        assertTrue(ApprovalProof.verifyForTest(signature.getString("publicKey"), signature.getString("message"), signature.getString("signatureDer")));
    }

    @Test public void highSAcceptedCaseVerifiesUnchanged() throws Exception {
        JSONObject entry = contract().getJSONArray("accepted").getJSONObject(2);
        assertTrue(ApprovalProof.verifyForTest(entry.getString("publicKey"), entry.getString("message"), entry.getString("signatureDer")));
    }

    @Test public void aliasIsStablePerOrigin() {
        assertEquals(ApprovalProof.alias("https://mac.tailnet123.ts.net"), ApprovalProof.alias("https://mac.tailnet123.ts.net"));
        assertNotEquals(ApprovalProof.alias("https://mac.tailnet123.ts.net"), ApprovalProof.alias("https://other.tailnet123.ts.net"));
        assertTrue(ApprovalProof.alias("https://mac.tailnet123.ts.net").matches("murage_approval_[0-9a-f]{16}"));
    }
}
