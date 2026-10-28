package com.murage.mobile.shell;

import static org.junit.Assert.*;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

public class PhoneJobsContractTest {
    private static JSONObject fixture() throws Exception { return new JSONObject(Fixtures.read("phone-jobs.json")); }
    private static JSONObject object(String json) throws Exception { return new JSONObject(json); }
    private static String repeat(String value, int count) { StringBuilder b = new StringBuilder(); for (int i = 0; i < count; i++) b.append(value); return b.toString(); }

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

    @Test public void jsonEqualityPreservesStructureTypesAndNumericValues() throws Exception {
        JSONObject value = object("{\"items\":[1,{\"enabled\":true,\"value\":null}],\"name\":\"x\"}");
        assertTrue(jsonEquals(value, object("{\"name\":\"x\",\"items\":[1.0,{\"value\":null,\"enabled\":true}]}")));
        assertFalse(jsonEquals(value, object("{\"name\":\"x\",\"items\":[1,{\"enabled\":true}]}")));
        assertFalse(jsonEquals(object("{\"a\":null}"), object("{\"b\":null}")));
        assertFalse(jsonEquals(new JSONArray("[1,2]"), new JSONArray("[2,1]")));
        assertFalse(jsonEquals(new JSONArray("[1]"), new JSONArray("[1,2]")));
        assertFalse(jsonEquals(new JSONObject(), new JSONArray()));
        assertTrue(jsonEquals(1L, 1.0));
        assertFalse(jsonEquals(9007199254740992L, 9007199254740993L));
        assertFalse(jsonEquals(1, "1"));
        assertFalse(jsonEquals(true, 1));
        assertFalse(jsonEquals(true, false));
        assertFalse(jsonEquals("x", "y"));
        assertFalse(jsonEquals(JSONObject.NULL, "null"));
        assertFalse(jsonEquals(JSONObject.NULL, null));
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

    @Test public void keyIdsHashDecodedPointsAndRejectMalformedPoints() throws Exception {
        JSONObject keys = fixture().getJSONObject("keyId"), wrong = keys.getJSONObject("notKeyId");
        JSONArray vectors = keys.getJSONArray("vectors");
        assertEquals(2, vectors.length());
        for (int i = 0; i < vectors.length(); i++) {
            JSONObject v = vectors.getJSONObject(i);
            String point = v.getString("point"), id = PhoneJobsContract.approvalKeyId(point);
            assertEquals(v.getString("keyId"), id);
            assertNotEquals(wrong.getString(point), id);
            assertNull(PhoneJobsContract.approvalKeyId(point + "="));
            assertNull(PhoneJobsContract.approvalKeyId(point + "\n"));
            assertNull(PhoneJobsContract.approvalKeyId(point.substring(1)));
        }
        for (String point : Arrays.asList(null, "", repeat("A", 87), "+" + repeat("A", 86))) assertNull(PhoneJobsContract.approvalKeyId(point));
    }

    @Test public void mintMessageIsByteExact() throws Exception {
        JSONObject mint = fixture().getJSONObject("mint"), v = mint.getJSONObject("vector");
        assertEquals(mint.getString("tag"), PhoneJobsContract.TAG);
        assertEquals(mint.getInt("ttlMs"), PhoneJobsContract.TTL_MS);
        String message = PhoneJobsContract.phoneJobsMessage(v.getString("origin"), v.getString("keyId"), v.getString("nonce"), v.getLong("expiresAt"));
        assertArrayEquals(v.getString("message").getBytes(StandardCharsets.UTF_8), message.getBytes(StandardCharsets.UTF_8));
        assertFalse(message.endsWith("\n"));
    }

    @Test public void tokensAndRegistrationMatchEveryVector() throws Exception {
        JSONObject f = fixture(), token = f.getJSONObject("token"), registration = f.getJSONObject("registration");
        JSONArray capabilities = f.getJSONArray("capabilities");
        assertEquals(capabilities.length(), PhoneJobsContract.CAPABILITIES.size());
        for (int i = 0; i < capabilities.length(); i++) assertEquals(capabilities.getString(i), PhoneJobsContract.CAPABILITIES.get(i));
        JSONArray valid = token.getJSONArray("valid"), invalid = token.getJSONArray("invalid");
        for (int i = 0; i < valid.length(); i++) assertTrue(PhoneJobsContract.tokenValid(valid.getString(i)));
        for (int i = 0; i < invalid.length(); i++) assertFalse(PhoneJobsContract.tokenValid(invalid.getString(i)));
        assertTrue(PhoneJobsContract.registrationValid(registration.get("valid")));
        valid = registration.getJSONArray("alsoValid"); invalid = registration.getJSONArray("invalid");
        for (int i = 0; i < valid.length(); i++) assertTrue(PhoneJobsContract.registrationValid(valid.get(i)));
        for (int i = 0; i < invalid.length(); i++) assertFalse(PhoneJobsContract.registrationValid(expanded(invalid.getJSONObject(i))));
    }

    @Test public void offerEnvelopesAndActionValidationAreSeparate() throws Exception {
        JSONObject job = fixture().getJSONObject("job");
        JSONArray valid = job.getJSONArray("offers"), invalid = job.getJSONArray("invalidOffers");
        for (int i = 0; i < valid.length(); i++) {
            JSONObject v = valid.getJSONObject(i);
            PhoneJobsContract.Offer offer = PhoneJobsContract.Offer.parse(v);
            assertNotNull(offer);
            assertEquals(v.getString("operationId"), offer.operationId);
            assertEquals(v.getString("offerId"), offer.offerId);
            assertEquals(v.getString("workspace"), offer.workspace);
            assertEquals(v.getJSONObject("bot").getString("id"), offer.bot.id);
            assertEquals(v.getJSONObject("provider").getString("name"), offer.provider.name);
            // The legacy wire fixture permits a contact name; native approval requires a number.
            if (offer.action.equals("messages.compose")) {
                assertEquals("Sam", offer.args().getJSONArray("to").getString(0));
                assertNull(offer.decodedArgs());
            } else assertNotNull(offer.decodedArgs());
        }
        for (int i = 0; i < invalid.length(); i++) assertNull(PhoneJobsContract.Offer.parse(expanded(invalid.getJSONObject(i))));
        JSONObject v = new JSONObject(valid.getJSONObject(0).toString());
        v.put("capability", "contacts");
        assertNotNull(PhoneJobsContract.Offer.parse(v));
        assertNull(PhoneJobsContract.Offer.parse(v).decodedArgs());
        v.put("action", "contacts.future");
        assertNotNull(PhoneJobsContract.Offer.parse(v));
        assertNull(PhoneJobsContract.Offer.parse(v).decodedArgs());
        v.put("expiresAt", true);
        assertNull(PhoneJobsContract.Offer.parse(v));
    }

    @Test public void pollAndTargetedAnswersKeepTheirDistinctUnions() throws Exception {
        JSONObject job = fixture().getJSONObject("job"), poll = job.getJSONObject("poll"), targeted = job.getJSONObject("targeted");
        JSONArray valid = poll.getJSONArray("answers"), invalid = poll.getJSONArray("invalid");
        for (int i = 0; i < valid.length(); i++) assertNotNull(PhoneJobsContract.PollAnswer.parse(valid.get(i)));
        for (int i = 0; i < invalid.length(); i++) assertNull(PhoneJobsContract.PollAnswer.parse(expanded(invalid.getJSONObject(i))));
        valid = targeted.getJSONArray("answers"); invalid = targeted.getJSONArray("invalid");
        for (int i = 0; i < valid.length(); i++) {
            JSONObject v = valid.getJSONObject(i);
            PhoneJobsContract.TargetedAnswer answer = PhoneJobsContract.TargetedAnswer.parse(v);
            assertNotNull(answer);
            switch (answer.kind) {
                case JOBS: assertEquals(v.getJSONArray("jobs").getJSONObject(0).getString("operationId"), answer.job.operationId); break;
                case LEASED: assertEquals(v.getLong("expiresAt"), answer.expiresAt.longValue()); break;
                case HANDLED: assertEquals(v.getString("reason"), answer.reason); break;
            }
        }
        for (int i = 0; i < invalid.length(); i++) assertNull(PhoneJobsContract.TargetedAnswer.parse(expanded(invalid.getJSONObject(i))));
        JSONObject offer = job.getJSONArray("offers").getJSONObject(0);
        for (JSONObject v : Arrays.asList(new JSONObject().put("jobs", new JSONArray().put(offer).put(offer)), object("{\"jobs\":[],\"x\":1}"), object("{\"jobs\":[null]}"))) {
            assertNull(PhoneJobsContract.PollAnswer.parse(v)); assertNull(PhoneJobsContract.TargetedAnswer.parse(v));
        }
        assertNull(PhoneJobsContract.TargetedAnswer.parse(object("{\"leased\":true,\"expiresAt\":0}")));
        assertNull(PhoneJobsContract.TargetedAnswer.parse(object("{\"leased\":1,\"expiresAt\":100}")));
    }

    @Test public void leaseRequestsAndAnswersMatchEveryVector() throws Exception {
        JSONObject lease = fixture().getJSONObject("job").getJSONObject("lease");
        assertNotNull(PhoneJobsContract.LeaseRequest.parse(lease.get("request")));
        JSONArray invalid = lease.getJSONArray("invalidRequests");
        for (int i = 0; i < invalid.length(); i++) assertNull(PhoneJobsContract.LeaseRequest.parse(expanded(invalid.getJSONObject(i))));
        JSONArray valid = lease.getJSONArray("answers"); invalid = lease.getJSONArray("invalidAnswers");
        for (int i = 0; i < valid.length(); i++) {
            JSONObject v = valid.getJSONObject(i);
            PhoneJobsContract.LeaseAnswer answer = PhoneJobsContract.LeaseAnswer.parse(v);
            assertNotNull(answer);
            assertEquals(v.getBoolean("active"), answer.active);
            assertEquals(v.has("leaseToken") ? v.getString("leaseToken") : null, answer.leaseToken);
        }
        for (int i = 0; i < invalid.length(); i++) assertNull(PhoneJobsContract.LeaseAnswer.parse(expanded(invalid.getJSONObject(i))));
        assertNull(PhoneJobsContract.LeaseAnswer.parse(object("{\"active\":0}")));
    }

    @Test public void resultBodiesMatchEveryVectorAndPreserveAbsentVersusNull() throws Exception {
        JSONObject job = fixture().getJSONObject("job");
        JSONArray valid = job.getJSONArray("results"), invalid = job.getJSONArray("invalidResults");
        for (int i = 0; i < valid.length(); i++) assertNotNull(PhoneJobsContract.ResultBody.parse(valid.getJSONObject(i).get("body")));
        for (int i = 0; i < invalid.length(); i++) assertNull(PhoneJobsContract.ResultBody.parse(expanded(invalid.getJSONObject(i))));
        JSONObject base = new JSONObject().put("leaseToken", repeat("A", 43)).put("ok", true);
        PhoneJobsContract.ResultBody absent = PhoneJobsContract.ResultBody.parse(base);
        assertNotNull(absent); assertFalse(absent.hasResult); assertNull(absent.result());
        PhoneJobsContract.ResultBody explicitNull = PhoneJobsContract.ResultBody.parse(base.put("result", JSONObject.NULL));
        assertNotNull(explicitNull); assertTrue(explicitNull.hasResult); assertSame(JSONObject.NULL, explicitNull.result());
        assertNull(PhoneJobsContract.ResultBody.parse(base.put("ok", false).put("code", "denied")));
        base.remove("result"); base.remove("code");
        assertNull(PhoneJobsContract.ResultBody.parse(base.put("ok", 1)));
        assertNull(PhoneJobsContract.ResultBody.parse(base.put("ok", true).put("error", JSONObject.NULL)));
    }

    @Test public void allFourteenActionArgsAndResultEncodersMatchEveryVector() throws Exception {
        JSONObject actions = fixture().getJSONObject("actions");
        Set<String> names = new HashSet<>(Arrays.asList("calendar.read", "calendar.free_time", "calendar.add", "calendar.change", "reminders.read", "reminders.add", "reminders.complete",
            "contacts.search", "contacts.get", "location.get", "alarms.set", "alarms.timer", "messages.compose", "calls.dial"));
        Set<String> fixtureNames = new HashSet<>();
        for (Iterator<String> it = actions.keys(); it.hasNext();) fixtureNames.add(it.next());
        fixtureNames.remove("note"); assertEquals(names, fixtureNames);
        for (String name : names) {
            JSONObject vectors = actions.getJSONObject(name);
            JSONArray valid = vectors.getJSONArray("validArgs"), invalid = vectors.getJSONArray("invalidArgs");
            for (int i = 0; i < valid.length(); i++) assertNotNull(name, PhoneJobsContract.Args.parse(name, valid.get(i)));
            for (int i = 0; i < invalid.length(); i++) assertNull(name + ": " + invalid.getJSONObject(i).getString("why"), PhoneJobsContract.Args.parse(name, expanded(invalid.getJSONObject(i))));
            valid = vectors.getJSONArray("validResults"); invalid = vectors.getJSONArray("invalidResults");
            for (int i = 0; i < valid.length(); i++) {
                JSONObject v = valid.getJSONObject(i);
                PhoneJobsContract.Result result = PhoneJobsContract.Result.parse(name, v);
                assertNotNull(name, result);
                JSONObject encoded = result.encode();
                assertNotNull(name, encoded);
                assertTrue(name, jsonEquals(v, new JSONObject(encoded.toString())));
            }
            for (int i = 0; i < invalid.length(); i++) {
                PhoneJobsContract.Result result = PhoneJobsContract.Result.parse(name, expanded(invalid.getJSONObject(i)));
                assertNull(name + ": " + invalid.getJSONObject(i).getString("why"), result == null ? null : result.encode());
            }
        }
        assertNull(PhoneJobsContract.Args.parse("calendar.future", new JSONObject()));
        assertNull(PhoneJobsContract.Result.parse("calendar.future", new JSONObject()));
    }

    @Test public void limitsUseUTF16AndStrictJSONTypes() throws Exception {
        assertNotNull(PhoneJobsContract.CallsDialArgs.parse(new JSONObject().put("number", repeat("😀", 20))));
        assertNull(PhoneJobsContract.CallsDialArgs.parse(new JSONObject().put("number", repeat("😀", 21))));
        for (Object bad : Arrays.asList(true, "1", 1.5, 0, 201, JSONObject.NULL)) assertNull(PhoneJobsContract.RemindersReadArgs.parse(new JSONObject().put("limit", bad)));
        assertNotNull(PhoneJobsContract.RemindersReadArgs.parse(new JSONObject().put("limit", 200.0)));
        assertNull(PhoneJobsContract.RemindersReadArgs.parse(object("{\"includeCompleted\":1}")));
        assertNull(PhoneJobsContract.RemindersReadArgs.parse(object("{\"includeCompleted?\":true}")));
        assertNull(PhoneJobsContract.RemindersAddArgs.parse(object("{\"title\":\"x\",\"notes\":null}")));
        assertNotNull(PhoneJobsContract.RemindersAddArgs.parse(new JSONObject().put("title", repeat("x", 500)).put("due", repeat("x", 64)).put("notes", repeat("x", 4000))));
        String[] fields = {"title", "due", "notes"}; int[] limits = {501, 65, 4001};
        for (int i = 0; i < fields.length; i++) assertNull(PhoneJobsContract.RemindersAddArgs.parse(new JSONObject().put("title", "x").put(fields[i], repeat("x", limits[i]))));
        assertNull(PhoneJobsContract.MessagesComposeArgs.parse(object("{\"to\":[\"\"],\"body\":\"x\"}")));
        JSONObject message = new JSONObject().put("to", new JSONArray(Collections.nCopies(10, "x"))).put("body", repeat("x", 2000));
        assertNotNull(PhoneJobsContract.MessagesComposeArgs.parse(message));
        assertNull(PhoneJobsContract.MessagesComposeArgs.parse(message.put("body", repeat("x", 2001))));
    }

    @Test public void timeParsingAndRangeBoundariesMatchTheReference() throws Exception {
        String start = "2026-10-01T00:00:00Z";
        JSONObject range = new JSONObject().put("start", start).put("end", "2026-11-01T00:00:00Z");
        assertNotNull(PhoneJobsContract.CalendarReadArgs.parse(range));
        assertNull(PhoneJobsContract.CalendarReadArgs.parse(range.put("end", "2026-11-01T00:00:00.001Z")));
        assertNull(PhoneJobsContract.CalendarReadArgs.parse(range.put("end", "2026-10-01T01:00:00+01:00")));
        for (String time : Arrays.asList("2026-13-01T00:00:00Z", "2026-10-32T00:00:00Z", "2026-10-01T24:01:00Z", "2026-10-01T00:00:60Z", "2026-10-01T00:00:00+24:00", "2026-10-01T00:00:00Z\n"))
            assertNull(time, PhoneJobsContract.CalendarChangeArgs.parse(new JSONObject().put("id", "e").put("start", time)));
        for (String time : Arrays.asList("0000-01-01T00:00:00Z", "2026-02-31T00:00:00Z", "2026-10-01T24:00:00Z", "2026-10-01T00:00:00.123456789+23:59"))
            assertNotNull(time, PhoneJobsContract.CalendarChangeArgs.parse(new JSONObject().put("id", "e").put("start", time)));
        assertNotNull(PhoneJobsContract.CalendarChangeArgs.parse(new JSONObject().put("id", "e").put("start", "2026-10-02T00:00:00Z").put("end", start)));
        assertNotNull(new PhoneJobsContract.CalendarFreeTimeResult(Collections.singletonList(new PhoneJobsContract.Slot("2026-10-02T00:00:00Z", start))).encode());
    }

    @Test public void typedEncodersRefuseInvalidValuesAndNestedLimits() {
        assertNull(new PhoneJobsContract.RemindersCompleteResult("r", false).encode());
        assertNull(new PhoneJobsContract.CalendarAddResult("", true).encode());
        assertNull(new PhoneJobsContract.AlarmsSetResult("done").encode());
        assertNull(new PhoneJobsContract.AlarmsTimerResult("done").encode());
        assertNull(new PhoneJobsContract.MessagesComposeResult("sent").encode());
        assertNull(new PhoneJobsContract.CallsDialResult("called").encode());
        assertNull(new PhoneJobsContract.LocationGetResult(Double.NaN, 0.0, 0.0, "precise", "x").encode());
        assertNull(new PhoneJobsContract.LocationGetResult(0.0, 181.0, 0.0, "precise", "x").encode());
        assertNull(new PhoneJobsContract.Contact("c", "", Collections.emptyList(), Collections.nCopies(11, new PhoneJobsContract.ContactEmail(null, "x"))).encode());
        assertNull(new PhoneJobsContract.ContactPhone(repeat("x", 51), "x").encode());
        assertNull(new PhoneJobsContract.ContactEmail(null, repeat("x", 255)).encode());
        assertNull(new PhoneJobsContract.ContactsGetResult(new PhoneJobsContract.Contact("", "", Collections.emptyList(), Collections.emptyList()), false).encode());
        assertNull(new PhoneJobsContract.CalendarReadResult(null, false).encode());
    }

    @Test public void resultByteBoundaryIncludesUTF8EscapesAndNestedResults() throws Exception {
        int max = PhoneJobsContract.RESULT_MAX_BYTES;
        assertEquals(fixture().getJSONObject("job").getJSONObject("oversize").getInt("maxBytes"), max);
        Object[] values = {new JSONObject().put("text", repeat("a", max - 11)), new JSONObject().put("text", repeat("a", max - 10)),
            repeat("é", (max - 2) / 2), repeat("é", max / 2), repeat("\n", (max - 2) / 2), repeat("\n", max / 2), repeat("/", max - 2)};
        boolean[] expected = {true, false, true, false, true, false, true};
        for (int i = 0; i < values.length; i++) {
            assertEquals(expected[i], PhoneJobsContract.withinResultBound(values[i]));
            assertEquals(expected[i], PhoneJobsContract.ResultBody.parse(new JSONObject().put("leaseToken", repeat("A", 43)).put("ok", true).put("result", values[i])) != null);
        }
        PhoneJobsContract.Event event = new PhoneJobsContract.Event("e", "", "2026-10-01T00:00:00Z", "2026-10-01T01:00:00Z", false, "", null, repeat("x", 4000));
        assertNull(new PhoneJobsContract.CalendarReadResult(Collections.nCopies(200, event), false).encode());
        assertFalse(PhoneJobsContract.withinResultBound(Double.POSITIVE_INFINITY));
    }

    @Test public void decodedAndEncodedContainersDoNotShareMutableJSON() throws Exception {
        JSONObject source = object("{\"contacts\":[{\"id\":\"c\",\"name\":\"Sam\",\"phones\":[],\"emails\":[]}],\"limited\":false}");
        PhoneJobsContract.ContactsSearchResult result = PhoneJobsContract.ContactsSearchResult.parse(source);
        assertNotNull(result);
        source.getJSONArray("contacts").getJSONObject(0).put("id", "changed");
        JSONObject encoded = result.encode();
        assertNotNull(encoded);
        encoded.getJSONArray("contacts").getJSONObject(0).put("id", "again");
        assertEquals("c", result.encode().getJSONArray("contacts").getJSONObject(0).getString("id"));
        List<PhoneJobsContract.Contact> list = new ArrayList<>(result.contacts);
        PhoneJobsContract.ContactsSearchResult copied = new PhoneJobsContract.ContactsSearchResult(list, false);
        list.clear(); assertEquals(1, copied.contacts.size());
        JSONObject offerJSON = fixture().getJSONObject("job").getJSONArray("offers").getJSONObject(0);
        PhoneJobsContract.Offer offer = PhoneJobsContract.Offer.parse(offerJSON);
        assertNotNull(offer);
        offer.args().put("start", "changed");
        offerJSON.getJSONObject("args").put("start", "changed");
        assertNotNull(offer.decodedArgs());
    }

    @Test public void numberByteAccountingUsesJavaScriptDecimalCutovers() throws Exception {
        double[] numbers = {-0.0, 1.0, 1e-7, 1e-6, 1e20, 1e21, 1e23, Double.MIN_VALUE, -12.5};
        String[] decimals = {"0", "1", "1e-7", "0.000001", "100000000000000000000", "1e+21", "1e+23", "5e-324", "-12.5"};
        for (int i = 0; i < numbers.length; i++) {
            int framing = ("{\"n\":" + decimals[i] + ",\"padding\":\"\"}").length();
            String padding = repeat("a", PhoneJobsContract.RESULT_MAX_BYTES - framing);
            JSONObject value = new JSONObject().put("n", numbers[i]).put("padding", padding);
            assertTrue(decimals[i], PhoneJobsContract.withinResultBound(value));
            assertFalse(decimals[i], PhoneJobsContract.withinResultBound(value.put("padding", padding + "a")));
        }
    }
}
