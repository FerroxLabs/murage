package com.murage.mobile.shell;

import static org.junit.Assert.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class ComposeHashTest {
    private static String repeat(String value, int count) { StringBuilder out = new StringBuilder(); for (int i = 0; i < count; i++) out.append(value); return out.toString(); }
    @Test public void everySharedFixture() throws Exception {
        JSONArray cases = new JSONArray(Fixtures.read("compose-hash.json"));
        for (int i = 0; i < cases.length(); i++) {
            JSONObject row = cases.getJSONObject(i);
            String hash = row.getString("hash");
            if (row.has("parses") && row.isNull("parses")) { assertNull(row.getString("why"), ComposeHash.parse(hash)); continue; }
            String bot = row.has("bot") ? row.getString("bot") : null;
            String thread = row.has("threadId") ? row.getString("threadId") : null;
            String again = row.has("again") ? row.getString("again") : null;
            assertEquals(hash, bot != null ? ComposeHash.buildBot(bot) : ComposeHash.buildThread(thread, again));
            ComposeHash.Target target = ComposeHash.parse(hash);
            assertNotNull(target);
            assertEquals(bot, target.bot); assertEquals(thread, target.threadId); assertEquals(again, target.again);
        }
    }
    @Test public void encodingAndBuilderBounds() {
        String id = "a &+=/#😀";
        assertEquals("#open=bot:a+%26%2B%3D%2F%23%F0%9F%98%80&compose=1", ComposeHash.buildBot(id));
        assertEquals(id, ComposeHash.parse(ComposeHash.buildBot(id)).bot);
        ComposeHash.Target target = ComposeHash.parse(ComposeHash.buildThread(id, id));
        assertEquals(id, target.threadId); assertEquals(id, target.again);
        for (String value : new String[] {"", repeat("a", 513), repeat("😀", 257)}) {
            assertNull(ComposeHash.buildBot(value)); assertNull(ComposeHash.buildThread(value, null)); assertNull(ComposeHash.buildThread("t", value));
        }
        assertNotNull(ComposeHash.buildBot(repeat("😀", 256)));
        assertNull(ComposeHash.buildThread("bot:b", null));
    }
}
