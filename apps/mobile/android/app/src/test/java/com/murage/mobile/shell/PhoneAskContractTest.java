package com.murage.mobile.shell;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.KeyFactory;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;
import java.util.Base64;
import java.util.Iterator;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

public class PhoneAskContractTest {
    private static JSONObject fixture() throws Exception { return new JSONObject(Fixtures.read("phone-ask.json")); }
    private static String repeat(String value, int count) { StringBuilder out = new StringBuilder(); for (int i = 0; i < count; i++) out.append(value); return out.toString(); }
    /** Compare JSON values using only org.json APIs available on Android. */
    private static boolean jsonEquals(Object left, Object right) throws JSONException {
        if (left == right) return true;
        if (left == null || right == null || left == JSONObject.NULL || right == JSONObject.NULL) return false;
        if (left instanceof JSONObject && right instanceof JSONObject) {
            JSONObject a = (JSONObject) left, b = (JSONObject) right;
            if (a.length() != b.length()) return false;
            for (Iterator<String> it = a.keys(); it.hasNext();) {
                String key = it.next();
                if (!b.has(key) || !jsonEquals(a.get(key), b.get(key))) return false;
            }
            return true;
        }
        if (left instanceof JSONArray && right instanceof JSONArray) {
            JSONArray a = (JSONArray) left, b = (JSONArray) right;
            if (a.length() != b.length()) return false;
            for (int i = 0; i < a.length(); i++) if (!jsonEquals(a.get(i), b.get(i))) return false;
            return true;
        }
        if (left instanceof Number && right instanceof Number) {
            return new BigDecimal(left.toString()).compareTo(new BigDecimal(right.toString())) == 0;
        }
        return left.equals(right);
    }

    /** Expand args.to and nested result paths before testing the vector. */
    private static JSONObject expanded(JSONObject vector) throws Exception {
        JSONObject body = new JSONObject(vector.getJSONObject("body").toString());
        if (!vector.has("repeat")) return body;
        JSONObject spec = vector.getJSONObject("repeat");
        String[] path = spec.getString("path").split("\\.");
        JSONObject parent = body;
        for (int i = 0; i < path.length - 1; i++) parent = parent.getJSONObject(path[i]);
        String key = path[path.length - 1];
        JSONArray source = parent.getJSONArray(key), values = new JSONArray();
        assertEquals(1, source.length());
        int count = spec.getInt("count");
        assertTrue(count > 0);
        for (int i = 0; i < count; i++) values.put(source.get(0));
        parent.put(key, values);
        return body;
    }

    private static String message(JSONObject v) throws Exception {
        return PhoneAskContract.phoneAskMessage(v.getString("origin"), v.getString("keyId"), v.getString("nonce"), v.getLong("expiresAt"));
    }
    private static boolean verifies(JSONObject v, String message) throws Exception {
        byte[] point = Base64.getUrlDecoder().decode(v.getString("point"));
        AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
        parameters.init(new ECGenParameterSpec("secp256r1"));
        ECPoint coordinates = new ECPoint(new BigInteger(1, Arrays.copyOfRange(point, 1, 33)), new BigInteger(1, Arrays.copyOfRange(point, 33, 65)));
        Signature verifier = Signature.getInstance("SHA256withECDSA");
        verifier.initVerify(KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(coordinates, parameters.getParameterSpec(ECParameterSpec.class))));
        verifier.update(message.getBytes(StandardCharsets.UTF_8));
        return verifier.verify(Base64.getUrlDecoder().decode(v.getString("signature")));
    }
    private interface Codec { JSONObject roundTrip(Object value); }
    private static final Codec MANIFEST = value -> { PhoneAskContract.ShareManifest m = PhoneAskContract.ShareManifest.parse(value); return m == null ? null : m.encode(); };
    private static final Codec ASK = value -> { PhoneAskContract.AskRequest m = PhoneAskContract.AskRequest.parse(value); return m == null ? null : m.encode(); };
    private static final Codec TOKEN = value -> { PhoneAskContract.TokenRequest m = PhoneAskContract.TokenRequest.parse(value); return m == null ? null : m.encode(); };
    private static final Codec TARGETS = value -> { PhoneAskContract.TargetsAnswer m = PhoneAskContract.TargetsAnswer.parse(value); return m == null ? null : m.encode(); };
    private static final Codec SHARE_ANSWER = value -> { PhoneAskContract.ShareAnswer m = PhoneAskContract.ShareAnswer.parse(value); return m == null ? null : m.encode(); };
    private static final Codec ASK_ANSWER = value -> { PhoneAskContract.AskAnswer m = PhoneAskContract.AskAnswer.parse(value); return m == null ? null : m.encode(); };
    private static void roundTrip(Codec codec, Object value) throws Exception { assertTrue(jsonEquals(value, codec.roundTrip(value))); }
    private static void refused(Codec codec, JSONArray vectors) throws Exception {
        for (int i = 0; i < vectors.length(); i++) {
            JSONObject vector = vectors.getJSONObject(i);
            assertNull(vector.getString("why"), codec.roundTrip(expanded(vector)));
        }
    }

    @Test public void mintBytesAndBothCrossPurposeSignatures() throws Exception {
        JSONObject mint = fixture().getJSONObject("mint"), v = mint.getJSONObject("vector"), cross = mint.getJSONObject("crossPurpose"), jobs = cross.getJSONObject("jobsVector");
        assertEquals(mint.getString("tag"), PhoneAskContract.TAG);
        assertEquals(mint.getInt("ttlMs"), PhoneAskContract.TTL_MS);
        String message = message(v);
        assertArrayEquals(v.getString("message").getBytes(StandardCharsets.UTF_8), message.getBytes(StandardCharsets.UTF_8));
        assertFalse(message.endsWith("\n"));
        assertEquals(v.getString("keyId"), PhoneJobsContract.approvalKeyId(v.getString("point")));
        assertTrue(verifies(v, message));
        assertFalse(verifies(v, message + "0"));
        String asJobs = cross.getJSONObject("askVectorAsJobs").getString("message");
        assertEquals(asJobs, PhoneJobsContract.phoneJobsMessage(v.getString("origin"), v.getString("keyId"), v.getString("nonce"), v.getLong("expiresAt")));
        assertFalse(verifies(v, asJobs));
        assertTrue(verifies(jobs, jobs.getString("message")));
        assertFalse(verifies(jobs, message(jobs)));
        assertTrue(jsonEquals(jobs, new JSONObject(Fixtures.read("phone-jobs.json")).getJSONObject("mint").getJSONObject("vector")));
    }

    @Test public void everyRequestAndTargetVector() throws Exception {
        JSONObject f = fixture(), share = f.getJSONObject("share"), manifest = share.getJSONObject("manifest");
        roundTrip(MANIFEST, manifest.get("valid"));
        JSONArray also = manifest.getJSONArray("alsoValid");
        for (int i = 0; i < also.length(); i++) roundTrip(MANIFEST, also.get(i));
        refused(MANIFEST, share.getJSONArray("invalid"));
        JSONObject ask = f.getJSONObject("ask"), token = f.getJSONObject("tokenRequest"), targets = f.getJSONObject("targets");
        roundTrip(ASK, ask.get("request")); refused(ASK, ask.getJSONArray("invalid"));
        roundTrip(TOKEN, token.get("valid"));
        also = token.getJSONArray("alsoValid");
        for (int i = 0; i < also.length(); i++) roundTrip(TOKEN, also.get(i));
        refused(TOKEN, token.getJSONArray("invalid"));
        roundTrip(TARGETS, targets.get("answer")); refused(TARGETS, targets.getJSONArray("invalid"));
        assertEquals(targets.getInt("recentMax"), PhoneAskContract.TARGETS_RECENT_MAX);
        JSONObject shape = f.getJSONObject("token");
        JSONArray valid = shape.getJSONArray("valid"), invalid = shape.getJSONArray("invalid");
        for (int i = 0; i < valid.length(); i++) assertTrue(PhoneAskContract.tokenValid(valid.getString(i)));
        for (int i = 0; i < invalid.length(); i++) assertFalse(PhoneAskContract.tokenValid(invalid.getString(i)));
    }

    @Test public void everyAnswerAndStrictUnionKeys() throws Exception {
        JSONObject f = fixture(), answers = f.getJSONObject("share").getJSONObject("answers"), ask = f.getJSONObject("ask");
        for (String key : Arrays.asList("ok", "errors")) {
            JSONArray rows = answers.getJSONArray(key);
            for (int i = 0; i < rows.length(); i++) if (rows.getJSONObject(i).has("body")) roundTrip(SHARE_ANSWER, rows.getJSONObject(i).get("body"));
        }
        roundTrip(ASK_ANSWER, ask.get("answer"));
        JSONArray rows = ask.getJSONArray("errors");
        for (int i = 0; i < rows.length(); i++) if (rows.getJSONObject(i).has("body")) roundTrip(ASK_ANSWER, rows.getJSONObject(i).get("body"));
        JSONObject shareOK = answers.getJSONArray("ok").getJSONObject(0).getJSONObject("body");
        for (String key : Arrays.asList("via", "origin", "answer", "text", "ownerActs")) {
            assertNull(SHARE_ANSWER.roundTrip(new JSONObject(shareOK.toString()).put(key, "x")));
            assertNull(ASK_ANSWER.roundTrip(new JSONObject(ask.getJSONObject("answer").toString()).put(key, "x")));
        }
        assertNull(SHARE_ANSWER.roundTrip(new JSONObject(shareOK.toString()).put("error", "x").put("code", "invalid")));
        assertNull(ASK_ANSWER.roundTrip(new JSONObject().put("error", "x").put("code", "too_large")));
        JSONObject body = new JSONObject(ask.getJSONObject("answer").toString()).put("notify", 1);
        assertNull(ASK_ANSWER.roundTrip(body));
        body.put("notify", false); roundTrip(ASK_ANSWER, body);
    }

    @Test public void limitsTypesAndUTF16Validation() throws Exception {
        JSONObject f = fixture(), limits = f.getJSONObject("limits"), types = new JSONObject(Fixtures.read("share-types.json"));
        JSONObject nativeLimits = new JSONObject().put("maxItems", PhoneAskContract.ShareLimits.MAX_ITEMS)
                .put("maxShareBytes", PhoneAskContract.ShareLimits.MAX_SHARE_BYTES).put("doorMaxBytes", PhoneAskContract.ShareLimits.DOOR_MAX_BYTES)
                .put("imageMaxBytes", PhoneAskContract.ShareLimits.IMAGE_MAX_BYTES).put("fileMaxBytes", PhoneAskContract.ShareLimits.FILE_MAX_BYTES)
                .put("noteMaxChars", PhoneAskContract.ShareLimits.NOTE_MAX_CHARS);
        assertTrue(jsonEquals(limits, nativeLimits));
        assertTrue(jsonEquals(types.getJSONArray("images"), new JSONArray(PhoneAskContract.IMAGE_MIMES)));
        JSONArray files = new JSONArray();
        for (int i = 0; i < types.getJSONArray("files").length(); i++) files.put(types.getJSONArray("files").getJSONObject(i).getString("mime"));
        assertTrue(jsonEquals(files, new JSONArray(PhoneAskContract.FILE_MIMES)));
        JSONArray all = new JSONArray(PhoneAskContract.IMAGE_MIMES);
        for (String mime : PhoneAskContract.FILE_MIMES) all.put(mime);
        assertTrue(jsonEquals(types.getJSONArray("androidFilter"), all));
        JSONObject body = f.getJSONObject("share").getJSONObject("manifest").getJSONObject("valid");
        for (String key : Arrays.asList("note", "text", "url")) assertNull(MANIFEST.roundTrip(new JSONObject(body.toString()).put(key, JSONObject.NULL)));
        body.put("note", repeat("😀", 1000)); assertNotNull(MANIFEST.roundTrip(body));
        body.put("note", repeat("😀", 1001)); assertNull(MANIFEST.roundTrip(body));
        body.remove("note");
        JSONObject item = body.getJSONArray("items").getJSONObject(0);
        body.put("items", new JSONArray().put(item));
        for (int i = 0; i < all.length(); i++) { item.put("mime", all.getString(i)); assertNotNull(MANIFEST.roundTrip(body)); }
        for (Object bytes : Arrays.asList(-1, 1.5, true, "6", 9007199254740992L, JSONObject.NULL)) {
            item.put("bytes", bytes); assertNull(MANIFEST.roundTrip(body));
        }
        JSONObject request = f.getJSONObject("ask").getJSONObject("request");
        request.put("text", repeat("a", 1048577)); assertNull(ASK.roundTrip(request));
        request.put("text", 123); assertNull(ASK.roundTrip(request));
    }

    @Test public void multipartWriterMatchesFixtureBytesAndRejectsChangedInputs() throws Exception {
        JSONObject share = fixture().getJSONObject("share"), mp = share.getJSONObject("multipart");
        PhoneAskContract.ShareManifest manifest = PhoneAskContract.ShareManifest.parse(share.getJSONObject("manifest").getJSONObject("valid"));
        assertNotNull(manifest);
        String boundary = mp.getString("boundary");
        JSONArray items = mp.getJSONArray("items");
        assertEquals(mp.getString("contentType"), ShareMultipartWriter.contentType(boundary));
        byte[][] data = new byte[items.length()][];
        for (int i = 0; i < items.length(); i++) data[i] = items.getJSONObject(i).getString("text").getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        ShareMultipartWriter.write(manifest, boundary, output, item -> new ByteArrayInputStream(data[item.n - 1]));
        assertArrayEquals(mp.getString("body").getBytes(StandardCharsets.UTF_8), output.toByteArray());
        for (String altered : Arrays.asList("", "HELLO\n", "hello\nextra")) {
            try {
                ShareMultipartWriter.write(manifest, boundary, new ByteArrayOutputStream(), item -> new ByteArrayInputStream(altered.getBytes(StandardCharsets.UTF_8)));
                fail("changed data must be refused");
            } catch (java.io.IOException expected) { /* digest or size mismatch */ }
        }
        try { ShareMultipartWriter.contentType("x\r\ny"); fail("boundary"); } catch (IllegalArgumentException expected) { }
        PhoneAskContract.ShareItem first = manifest.items.get(0);
        for (int index = 0; index < 2; index++) {
            for (String filename : Arrays.asList("a\r\nb", "a\"b", "../a", "a\\b", ".", "..", "a\u0000b", "a\u001fb", "a\u007fb", "a\u009fb", "", repeat("a", 256))) {
                PhoneAskContract.ShareItem invalid = new PhoneAskContract.ShareItem(index + 1, filename, first.mime, first.bytes, first.sha256);
                assertMultipartHeaderRefused(manifest, boundary, data[0], index, invalid);
            }
            for (String mime : Arrays.asList("text/plain\r\nX-Injected: yes", "application/unknown", "")) {
                PhoneAskContract.ShareItem invalid = new PhoneAskContract.ShareItem(index + 1, first.name, mime, first.bytes, first.sha256);
                assertMultipartHeaderRefused(manifest, boundary, data[0], index, invalid);
            }
            for (long bytes : new long[] {-1, 9007199254740992L}) {
                PhoneAskContract.ShareItem invalid = new PhoneAskContract.ShareItem(index + 1, first.name, first.mime, bytes, first.sha256);
                assertMultipartHeaderRefused(manifest, boundary, data[0], index, invalid);
            }
        }
    }

    private static void assertMultipartHeaderRefused(PhoneAskContract.ShareManifest manifest, String boundary, byte[] data,
                                                    int index, PhoneAskContract.ShareItem invalid) throws Exception {
        PhoneAskContract.ShareItem first = manifest.items.get(0);
        PhoneAskContract.ShareItem second = new PhoneAskContract.ShareItem(2, first.name, first.mime, first.bytes, first.sha256);
        PhoneAskContract.ShareManifest bad = new PhoneAskContract.ShareManifest(manifest.shareId, manifest.botId, manifest.threadId,
                manifest.note, manifest.text, manifest.url, index == 0 ? Arrays.asList(invalid, second) : Arrays.asList(first, invalid));
        ByteArrayOutputStream untouched = new ByteArrayOutputStream();
        int[] opened = {0};
        try {
            ShareMultipartWriter.write(bad, boundary, untouched, item -> { opened[0]++; return new ByteArrayInputStream(data); });
            fail("header must be refused");
        } catch (IllegalArgumentException expected) { }
        assertEquals("header must be refused before opening any input", 0, opened[0]);
        assertEquals("header must be refused before writing any byte", 0, untouched.size());
    }
}
