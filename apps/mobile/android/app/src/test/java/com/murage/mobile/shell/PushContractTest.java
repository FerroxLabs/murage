package com.murage.mobile.shell;

import static org.junit.Assert.assertEquals;

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
        for (PushContract.Category c : PushContract.Category.values()) {
            assertEquals(p.getJSONObject("iosCategory").getString(c.wire), c.iosCategory());
            assertEquals(p.getJSONObject("androidChannel").getString(c.wire), c.channel());
            assertEquals(p.getJSONObject("generic").getJSONObject(c.wire).getString("title"), c.genericTitle());
            assertEquals(p.getJSONObject("generic").getJSONObject(c.wire).getString("body"), c.genericBody());
        }
    }

    @Test public void featureSwitchesMatchTheFile() throws Exception {
        JSONObject f = new JSONObject(Fixtures.read("push-features.json"));
        assertEquals(f.getBoolean("richText"), PushContract.Features.RICH_TEXT);
        assertEquals(f.getBoolean("lockScreenActions"), PushContract.Features.LOCK_SCREEN_ACTIONS);
    }
}
