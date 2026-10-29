package com.murage.mobile.shell;

import java.net.URLDecoder;
import java.io.UnsupportedEncodingException;
import java.util.HashMap;
import java.util.Map;

/** Separate from the Part 1 notification hash. Literal bot: is the routing prefix. */
public final class ComposeHash {
    private ComposeHash() {}
    public static final class Target {
        public final String bot, threadId, again;
        private Target(String bot, String threadId, String again) { this.bot = bot; this.threadId = threadId; this.again = again; }
    }
    public static String buildBot(String botId) {
        return OpenHash.valid(botId) ? "#open=bot:" + OpenHash.formEncode(botId) + "&compose=1" : null;
    }
    public static String buildThread(String threadId, String again) {
        if (!OpenHash.valid(threadId) || threadId.startsWith("bot:") || (again != null && !OpenHash.valid(again))) return null;
        return "#open=" + OpenHash.formEncode(threadId) + "&compose=1" + (again == null ? "" : "&again=" + OpenHash.formEncode(again));
    }
    public static Target parse(String hash) {
        if (hash == null) return null;
        String raw = hash.startsWith("#") ? hash.substring(1) : hash;
        if (!raw.startsWith("open=")) return null;
        Map<String, String> fields = new HashMap<>();
        try {
            for (String part : raw.split("&", -1)) {
                String[] pair = part.split("=", 2);
                String key = URLDecoder.decode(pair[0], "UTF-8");
                if (!fields.containsKey(key)) fields.put(key, URLDecoder.decode(pair.length == 2 ? pair[1] : "", "UTF-8"));
            }
        } catch (IllegalArgumentException | UnsupportedEncodingException e) { return null; }
        String open = fields.get("open"), again = fields.get("again");
        if (!"1".equals(fields.get("compose")) || open == null || (again != null && !OpenHash.valid(again))) return null;
        if (open.startsWith("bot:")) return OpenHash.valid(open.substring(4)) && again == null ? new Target(open.substring(4), null, null) : null;
        return OpenHash.valid(open) ? new Target(null, open, again) : null;
    }
}
