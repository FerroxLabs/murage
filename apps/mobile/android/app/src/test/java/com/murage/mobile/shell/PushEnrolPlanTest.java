package com.murage.mobile.shell;

import static org.junit.Assert.assertEquals;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class PushEnrolPlanTest {
    @Test public void everyFixtureCase() throws Exception {
        JSONArray cases = new JSONArray(Fixtures.read("push-enrol.json"));
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            assertEquals(c.getString("plan"), PushEnrolPlan.decide(c.getString("permission"), c.isNull("binding") ? null : c.getString("binding"), c.getBoolean("hasDetail"), c.getBoolean("fresh")));
        }
    }
}
