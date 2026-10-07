package com.murage.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

public class PushOutcomeTest {
    private static JSONObject f() throws Exception { return new JSONObject(Fixtures.read("push-outcomes.json")); }
    private static Integer status(JSONObject c) throws JSONException { return c.isNull("status") ? null : c.getInt("status"); }

    @Test public void detail() throws Exception {
        JSONArray cases = f().getJSONArray("detail");
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i), want = c.getJSONObject("expect");
            PushOutcome.Detail got = PushOutcome.detail(status(c), c.opt("body"), PushContract.Category.of(c.getString("category")));
            assertEquals(want.getString("title"), got.title);
            assertEquals(want.getString("body"), got.body);
            if (want.isNull("target")) { assertNull(got.target); continue; }
            JSONObject t = want.getJSONObject("target");
            assertEquals(t.getString("threadId"), got.target.threadId);
            assertEquals(t.optString("messageId", null), got.target.messageId);
            assertEquals(t.optString("requestId", null), got.target.requestId);
        }
    }

    @Test public void notice() throws Exception {
        JSONArray cases = f().getJSONArray("notice");
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            assertEquals(c.getString("expect"), PushOutcome.notice(status(c), c.opt("body"), c.getString("decision")).wire);
        }
    }

    @Test public void words() throws Exception {
        JSONObject words = f().getJSONObject("noticeText");
        for (PushOutcome.Notice n : PushOutcome.Notice.values()) {
            assertEquals(words.getJSONObject(n.wire).getString("title"), n.title());
            assertEquals(words.getJSONObject(n.wire).getString("body"), n.body());
        }
    }
}
