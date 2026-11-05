package com.murage.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class PairRefusalTest {
    @Test
    public void sharedCases() throws Exception {
        JSONObject fixture = new JSONObject(Fixtures.read("pair-refusal.json"));
        assertEquals(PairRefusal.MAX_CHARS, fixture.getInt("maxChars"));
        JSONArray cases = fixture.getJSONArray("cases");
        assertTrue(cases.length() > 5);
        for (int i = 0; i < cases.length(); i++) {
            JSONObject entry = cases.getJSONObject(i);
            assertEquals(entry.toString(), entry.getString("message"), PairRefusal.message(entry.getString("input")));
        }
    }

    private static String send(String args) throws ChannelException {
        ChannelGate.Request request = ChannelGate.parse("{\"id\":1,\"method\":\"pairRefused\",\"args\":" + args + "}");
        return request.method;
    }

    @Test
    public void theGateAcceptsOnlyAShortMessage() throws Exception {
        StringBuilder max = new StringBuilder();
        for (int i = 0; i < 200; i++) max.append('x');
        assertEquals("pairRefused", send("{\"message\":\"" + max + "\"}"));
        for (String args : new String[] {"{\"message\":\"" + max + "x\"}", "{}", "{\"message\":7}"}) {
            try {
                send(args);
                fail("accepted " + args);
            } catch (ChannelException refused) {
                assertEquals("bad_args", refused.code);
            }
        }
    }

    @Test
    public void isNeverAdvertised() {
        assertFalse(ChannelGate.ADVERTISED.contains("pairRefused"));
        assertEquals("pairRefused", CloseReason.PAIR_REFUSED.wire);
    }
}
