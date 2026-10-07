package com.murage.mobile.shell;

import static org.junit.Assert.*;

import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class SaveRequestTest {
    @Test
    public void sharedSaveCases() throws Exception {
        JSONObject channel = new JSONObject(Fixtures.read("channel.json"));
        WorkspaceOrigin origin = WorkspaceOrigin.parse(channel.getString("origin"));
        assertEquals(channel.getInt("chunkBytes"), SaveRequest.CHUNK_BYTES);
        assertEquals(channel.getInt("maxBytes"), SaveRequest.MAX_BYTES);
        JSONArray saves = channel.getJSONArray("saves");
        assertTrue(saves.length() > 15);
        for (int i = 0; i < saves.length(); i++) {
            JSONObject entry = saves.getJSONObject(i);
            JSONObject request = entry.getJSONObject("request");
            try {
                SaveRequest parsed = SaveRequest.parse(request, origin);
                assertFalse("accepted " + request, entry.has("error"));
                assertEquals(request.getString("kind"), parsed.kind);
                assertEquals(request.toString(), request.optString("id", null), parsed.id);
                assertEquals(request.toString(), request.optString("url", null), parsed.url);
                assertEquals(request.toString(), request.optString("filename", null), parsed.filename);
                assertEquals(request.toString(), request.optString("mime", null), parsed.mime);
                assertEquals(request.toString(), request.optInt("size", 0), parsed.size);
                assertEquals(request.toString(), request.optInt("index", 0), parsed.index);
                assertEquals(request.toString(), request.optString("base64", null), parsed.base64);
            } catch (ChannelException refused) {
                assertEquals(request.toString(), entry.optString("error", "(accepted)"), refused.code);
            }
        }
    }

    @Test
    public void sharedFileNames() throws Exception {
        JSONArray cases = new JSONArray(Fixtures.read("filenames.json"));
        assertTrue(cases.length() > 40);
        for (int i = 0; i < cases.length(); i++) {
            JSONObject entry = cases.getJSONObject(i);
            String safe = FileNames.safe(entry.getString("input"));
            assertEquals(entry.getString("input"), entry.getString("safe"), safe);
            assertTrue(safe, safe.getBytes(StandardCharsets.UTF_8).length <= 200);
        }
    }

    /** Cs cannot sit in the shared JSON (Darwin's parser refuses a lone surrogate), so Java pins it here. */
    @Test
    public void loneSurrogatesAreDropped() {
        assertEquals("ab.txt", FileNames.safe("a\uD800b.txt"));
        assertEquals("ab.txt", FileNames.safe("a\uDC00b.txt"));
        assertEquals("download", FileNames.safe("\uD800"));
    }

    /** The cut is 200 UTF-8 bytes, not the old 120 code points. */
    @Test
    public void longNamesAreCutByBytes() {
        assertEquals(133, FileNames.safe("a".repeat(130) + ".md").length());
        assertEquals("a".repeat(197) + ".md", FileNames.safe("a".repeat(300) + ".md"));
        assertEquals("download", FileNames.safe(null));
    }

    @Test
    public void urlFilenamesAreMadeSafe() throws Exception {
        WorkspaceOrigin origin = WorkspaceOrigin.parse("https://mac.tailnet123.ts.net");
        SaveRequest request = SaveRequest.parse(new JSONObject("{\"kind\":\"url\",\"url\":\"https://mac.tailnet123.ts.net/x\",\"filename\":\"../../etc/passwd\"}"), origin);
        assertEquals("passwd", request.filename);
        assertEquals("https://mac.tailnet123.ts.net/x", request.url);
    }

    /** A backslash, control or space anywhere is bad_args before any origin check. */
    @Test
    public void uncleanUrlsAreBadArgs() throws Exception {
        WorkspaceOrigin origin = WorkspaceOrigin.parse("https://mac.tailnet123.ts.net");
        String[] unclean = {
            "https://mac.tailnet123.ts.net/a\\b",
            "https://mac.tailnet123.ts.net/a\tb",
            " https://mac.tailnet123.ts.net/x",
            "https://mac.tailnet123.ts.net/x\n",
            "https://mac.tailnet123.ts.net/a b",
            "https://mac.tailnet123.ts.net/a\u2028b", // LINE SEPARATOR, escaped so it is visible here
        };
        for (String url : unclean) {
            try {
                SaveRequest.parse(new JSONObject().put("kind", "url").put("url", url).put("filename", "x.md"), origin);
                fail("accepted " + url);
            } catch (ChannelException refused) {
                assertEquals(url, "bad_args", refused.code);
            }
        }
    }

    @Test
    public void integersRejectBooleansAndFractions() {
        assertEquals(Integer.valueOf(5), ChannelArgs.integer(5));
        assertEquals(Integer.valueOf(5), ChannelArgs.integer(5L));
        assertNull(ChannelArgs.integer(1L << 40));
        assertNull(ChannelArgs.integer(true));
        assertNull(ChannelArgs.integer(1.5));
        assertNull(ChannelArgs.integer("5"));
        assertNull(ChannelArgs.integer(null));
    }

    /** int32 on both twins, and never negative: 2^31 and 2^32 are bad_args (ff3c8a82). */
    @Test
    public void integersAreNonNegativeInt32() {
        assertEquals(Integer.valueOf(0), ChannelArgs.integer(0));
        assertEquals(Integer.valueOf(Integer.MAX_VALUE), ChannelArgs.integer((long) Integer.MAX_VALUE));
        assertNull(ChannelArgs.integer(2_147_483_648L));
        assertNull(ChannelArgs.integer(4_294_967_296L));
        assertNull(ChannelArgs.integer(-1));
        assertNull(ChannelArgs.integer(-1L));
    }

    /** The base64 cap counts UTF-16 units, as the page and Swift do. */
    @Test
    public void chunkCapCountsUtf16Units() throws Exception {
        WorkspaceOrigin origin = WorkspaceOrigin.parse("https://mac.tailnet123.ts.net");
        String fits = "\u00E9".repeat(SaveRequest.MAX_BASE64);
        assertEquals(fits, SaveRequest.parse(new JSONObject().put("kind", "chunk").put("id", "a1").put("index", 0).put("base64", fits), origin).base64);
        try {
            SaveRequest.parse(new JSONObject().put("kind", "chunk").put("id", "a1").put("index", 0).put("base64", fits + "A"), origin);
            fail("accepted a base64 string over the UTF-16 cap");
        } catch (ChannelException refused) {
            assertEquals("too_large", refused.code);
        }
    }

    /** Plan 1 note 5: never write the door's 401 page to disk as the user's file. */
    @Test
    public void downloadGateRefusesErrorPages() {
        assertTrue(DownloadGate.accept(null));
        assertTrue(DownloadGate.accept(200));
        assertTrue(DownloadGate.accept(206));
        assertFalse(DownloadGate.accept(401));
        assertFalse(DownloadGate.accept(404));
        assertFalse(DownloadGate.accept(500));
    }
}
