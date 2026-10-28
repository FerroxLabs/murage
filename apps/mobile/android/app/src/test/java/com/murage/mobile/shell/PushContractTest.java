package com.murage.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class PushContractTest {
    private static JSONObject push() throws Exception { return new JSONObject(Fixtures.read("push.json")); }

    private static Map<String, String> strings(JSONObject o) throws Exception {
        Map<String, String> out = new HashMap<>();
        for (Iterator<String> keys = o.keys(); keys.hasNext();) { String k = keys.next(); out.put(k, o.getString(k)); }
        return out;
    }

    @Test public void payloadsAgreeWithTheContract() throws Exception {
        JSONArray cases = push().getJSONArray("payloads");
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            assertEquals(c.opt("value").toString(), c.getBoolean("valid"), PushContract.Payload.parse(c.opt("value")) != null);
        }
    }

    @Test public void fcmDataAgreesAndCarriesTheGroup() throws Exception {
        JSONArray cases = push().getJSONArray("fcmData");
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            assertEquals(c.getBoolean("valid"), PushContract.Payload.fromFcmData(strings(c.getJSONObject("data"))) != null);
        }
        assertEquals("46af17e29b1130f0", PushContract.Payload.fromFcmData(strings(cases.getJSONObject(0).getJSONObject("data"))).threadGroup);
    }

    @Test public void issuedTokensAreStrict() throws Exception {
        JSONArray cases = push().getJSONArray("issueTokens");
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            assertEquals(c.getBoolean("valid"), PushContract.Issued.parse(c.opt("args")) != null);
        }
    }

    @Test public void categoriesChannelsAndWords() throws Exception {
        JSONObject p = push();
        assertEquals(p.getInt("version"), PushContract.VERSION);
        for (PushContract.Category c : PushContract.Category.values()) {
            assertEquals(p.getJSONObject("iosCategory").getString(c.wire), c.iosCategory());
            assertEquals(p.getJSONObject("androidChannel").getString(c.wire), c.channel());
            assertEquals(p.getJSONObject("generic").getJSONObject(c.wire).getString("title"), c.genericTitle());
            assertEquals(p.getJSONObject("generic").getJSONObject(c.wire).getString("body"), c.genericBody());
        }
    }

    @Test public void deviceJobCategoryAndBothPayloadTransportsHaveNoActions() throws Exception {
        JSONObject fixture = push();
        JSONArray categories = fixture.getJSONArray("categories");
        boolean found = false;
        for (int i = 0; i < categories.length(); i++) {
            JSONObject c = categories.getJSONObject(i);
            if (c.getString("kind").equals("device-job")) {
                found = true;
                assertEquals("device-job", c.getString("category"));
            }
        }
        assertTrue(found);
        JSONArray payloads = fixture.getJSONArray("payloads");
        JSONObject value = null;
        for (int i = 0; i < payloads.length(); i++) {
            JSONObject candidate = payloads.getJSONObject(i).optJSONObject("value");
            if (candidate != null && "device-job".equals(candidate.optString("category"))) value = candidate;
        }
        assertNotNull(value);
        PushContract.Payload payload = PushContract.Payload.parse(value);
        assertNotNull(payload);
        assertEquals(PushContract.Category.DEVICE_JOB, payload.category);
        assertEquals("DEVICE_JOB", payload.category.iosCategory());
        assertEquals("requests", payload.category.channel());
        Map<String, String> data = new HashMap<>();
        for (Iterator<String> it = value.keys(); it.hasNext();) { String key = it.next(); data.put(key, value.get(key).toString()); }
        data.put("threadGroup", fixture.getJSONArray("fcmData").getJSONObject(0).getJSONObject("data").getString("threadGroup"));
        assertEquals(PushContract.Category.DEVICE_JOB, PushContract.Payload.fromFcmData(data).category);
        for (int sdk : new int[] {29, 31, 36}) for (boolean enabled : new boolean[] {false, true}) {
            NotificationPlan.Plan plan = NotificationPlan.of(payload.category, sdk, enabled);
            assertEquals("requests", plan.channel);
            assertTrue(plan.actions.isEmpty());
        }
    }

    @Test public void featureSwitchesMatchTheFile() throws Exception {
        JSONObject f = new JSONObject(Fixtures.read("push-features.json"));
        assertEquals(f.getBoolean("richText"), PushContract.Features.RICH_TEXT);
        assertEquals(f.getBoolean("lockScreenActions"), PushContract.Features.LOCK_SCREEN_ACTIONS);
    }

    @Test public void allCategoriesCallActionsSoundAndDisplayVectorsMatch() throws Exception {
        JSONObject p = push();
        assertEquals(p.getJSONObject("iosCategory").length(), PushContract.Category.values().length);
        JSONArray categories = p.getJSONArray("categories");
        for (int i = 0; i < categories.length(); i++)
            org.junit.Assert.assertNotNull(PushContract.Category.of(categories.getJSONObject(i).getString("category")));
        JSONArray expiring = p.getJSONArray("expiringCategories");
        assertEquals(expiring.length(), PushContract.EXPIRING_CATEGORIES.size());
        for (int i = 0; i < expiring.length(); i++) assertEquals(expiring.getString(i), PushContract.EXPIRING_CATEGORIES.get(i).wire);
        JSONObject sound = p.getJSONObject("callSound");
        assertEquals(sound.getString("ios"), PushContract.CallSound.IOS);
        assertEquals(sound.getString("android"), PushContract.CallSound.ANDROID);
        assertEquals(sound.getInt("seconds"), PushContract.CallSound.SECONDS);
        JSONArray actions = p.getJSONObject("iosActions").getJSONArray("CALL");
        assertEquals(actions.length(), PushContract.IOS_ACTIONS.get("CALL").size());
        for (int i = 0; i < actions.length(); i++) {
            PushContract.Action got = PushContract.IOS_ACTIONS.get("CALL").get(i);
            JSONObject expected = actions.getJSONObject(i);
            assertEquals(expected.getString("id"), got.id);
            assertEquals(expected.getString("title"), got.title);
            JSONArray options = expected.getJSONArray("options");
            assertEquals(options.length(), got.options.size());
            for (int j = 0; j < options.length(); j++) assertEquals(options.getString(j), got.options.get(j));
        }
        for (PushContract.Category category : PushContract.Category.values())
            assertEquals(category == PushContract.Category.CALL, category.isTimeSensitive());
        JSONArray cases = p.getJSONArray("callDisplay");
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            java.util.List<String> shown = new java.util.ArrayList<>();
            JSONArray keys = c.getJSONArray("shown");
            for (int j = 0; j < keys.length(); j++) shown.add(keys.getString(j));
            assertEquals(c.getString("case"), c.getString("action"),
                PushContract.callDisplayAction(PushContract.Payload.parse(c.getJSONObject("payload")), c.getLong("now"), shown));
        }
    }

    @Test public void callDetailVectorsIgnoreEveryPreviewSetting() throws Exception {
        JSONArray cases = push().getJSONArray("callDetail");
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            PushOutcome.Detail d = PushOutcome.detail(200,
                new JSONObject().put("title", "Private bot").put("body", "Private preview")
                    .put("previewContent", c.getBoolean("previewContent")).put("target", new JSONObject().put("threadId", "t1")),
                PushContract.Category.of(c.getString("kind")));
            assertEquals(c.getJSONObject("detail").getString("title"), d.title);
            assertEquals(c.getJSONObject("detail").getString("body"), d.body);
            assertEquals("t1", d.target.threadId);
        }
    }

    @Test public void expiryRejectsNonDecimalAndOutOfRangeValues() throws Exception {
        JSONObject base = push().getJSONObject("providerCall").getJSONObject("apns").getJSONObject("body").getJSONObject("murage");
        for (String kind : new String[] {"call", "call-note"}) {
            JSONObject value = new JSONObject(base.toString()).put("category", kind);
            for (Object bad : new Object[] {true, "1790000045000", 0, -1, 1.5, 9_007_199_254_740_992L}) {
                value.put("expiresAt", bad);
                org.junit.Assert.assertNull(PushContract.Payload.parse(value));
            }
            value.put("expiresAt", 9_007_199_254_740_991L);
            org.junit.Assert.assertNotNull(PushContract.Payload.parse(value));
            Map<String, String> fcm = new HashMap<>();
            for (Iterator<String> keys = value.keys(); keys.hasNext();) { String key = keys.next(); fcm.put(key, value.get(key).toString()); }
            fcm.put("threadGroup", "46af17e29b1130f0");
            org.junit.Assert.assertNotNull(PushContract.Payload.fromFcmData(fcm));
            for (String bad : new String[] {"01790000045000", "+1790000045000", "1e12", "1.0", "0", "-1", "9007199254740992", "1790000045000\n"}) {
                fcm.put("expiresAt", bad);
                org.junit.Assert.assertNull(bad, PushContract.Payload.fromFcmData(fcm));
            }
        }
    }
}
