package com.murage.mobile.shell;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;

/** Native twin of shared/phone-ask-contract.ts; all lengths use UTF-16 units. */
public final class PhoneAskContract {
    private PhoneAskContract() {}
    public static final String TAG = "murage-phone-ask/1";
    public static final int TTL_MS = 60_000;
    public static final int TARGETS_RECENT_MAX = 8;
    public static String phoneAskMessage(String origin, String keyId, String nonce, long expiresAt) {
        return String.join("\n", TAG, origin, keyId, nonce, Long.toString(expiresAt));
    }
    public static boolean tokenValid(String value) { return matches(value, "murage_pa_[A-Za-z0-9_-]{43}"); }
    static boolean matches(String value, String pattern) { return value != null && value.matches(pattern); }
    private static final String UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    public static final class ShareLimits {
        private ShareLimits() {}
        public static final int MAX_ITEMS = 10, MAX_SHARE_BYTES = 62_914_560, DOOR_MAX_BYTES = 67_108_864,
                IMAGE_MAX_BYTES = 10_485_760, FILE_MAX_BYTES = 26_214_400, NOTE_MAX_CHARS = 2000;
    }
    public static final List<String> IMAGE_MIMES = Collections.unmodifiableList(Arrays.asList("image/png", "image/jpeg", "image/gif", "image/webp"));
    public static final List<String> FILE_MIMES = Collections.unmodifiableList(Arrays.asList("text/plain", "text/markdown", "text/csv", "text/tab-separated-values", "application/json", "application/pdf", "application/rtf", "text/rtf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.oasis.opendocument.text", "application/vnd.oasis.opendocument.spreadsheet", "application/vnd.oasis.opendocument.presentation"));
    private static boolean keys(JSONObject o, String... allowed) {
        List<String> names = Arrays.asList(allowed);
        for (Iterator<String> it = o.keys(); it.hasNext();) if (!names.contains(it.next())) return false;
        return true;
    }
    private static boolean field(JSONObject o, String key, String rule, boolean optional, boolean nullable) {
        if (!o.has(key)) return optional;
        Object value = o.opt(key);
        if (value == JSONObject.NULL) return nullable;
        String[] parts = rule.split(":", -1);
        if (parts[0].equals("integer")) {
            if (!(value instanceof Number)) return false;
            double n = ((Number) value).doubleValue();
            return Double.isFinite(n) && n == Math.rint(n) && n >= Double.parseDouble(parts[1]) && n <= Double.parseDouble(parts[2]);
        }
        if (rule.equals("bool")) return value instanceof Boolean;
        if (!(value instanceof String)) return false;
        String s = (String) value;
        switch (parts[0]) {
            case "string": return true;
            case "text": return s.length() >= Integer.parseInt(parts[1]) && s.length() <= Integer.parseInt(parts[2]);
            case "pattern": return matches(s, rule.substring(8));
            case "enum": return Arrays.asList(parts).subList(1, parts.length).contains(s);
            case "mime": return IMAGE_MIMES.contains(s) || FILE_MIMES.contains(s);
            case "thread": return s.equals("new") || matches(s, UUID);
            case "url": return s.length() <= 2048 && matches(s, "https?://[^\\u0009-\\u000D\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\uFEFF]+");
            default: return false;
        }
    }

    public static final class ShareItem {
        public final int n;
        public final String name;
        public final String mime;
        public final long bytes;
        public final String sha256;
        public ShareItem(int n, String name, String mime, long bytes, String sha256) {
            this.n = n;
            this.name = name;
            this.mime = mime;
            this.bytes = bytes;
            this.sha256 = sha256;
        }
        public static ShareItem parse(Object value) {
            if (!(value instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) value;
            if (!keys(o, "n", "name", "mime", "bytes", "sha256")) return null;
            if (!field(o, "n", "integer:1:10", false, false)) return null;
            if (!field(o, "name", "text:1:255", false, false)) return null;
            if (!field(o, "mime", "mime", false, false)) return null;
            if (!field(o, "bytes", "integer:0:9007199254740991", false, false)) return null;
            if (!field(o, "sha256", "pattern:[0-9a-f]{64}", false, false)) return null;
            return new ShareItem(((Number) o.opt("n")).intValue(), (String) o.opt("name"), (String) o.opt("mime"), ((Number) o.opt("bytes")).longValue(), (String) o.opt("sha256"));
        }
        public JSONObject encode() {
            try {
                JSONObject o = new JSONObject();
                o.put("n", n);
                o.put("name", name);
                o.put("mime", mime);
                o.put("bytes", bytes);
                o.put("sha256", sha256);
                return parse(o) == null ? null : o;
            } catch (JSONException e) { return null; }
        }
    }

    public static final class ShareManifest {
        public final String shareId;
        public final String botId;
        public final String threadId;
        public final String note;
        public final String text;
        public final String url;
        public final List<ShareItem> items;
        public ShareManifest(String shareId, String botId, String threadId, String note, String text, String url, List<ShareItem> items) {
            this.shareId = shareId;
            this.botId = botId;
            this.threadId = threadId;
            this.note = note;
            this.text = text;
            this.url = url;
            this.items = Collections.unmodifiableList(new ArrayList<>(items));
        }
        public static ShareManifest parse(Object value) {
            if (!(value instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) value;
            if (!keys(o, "shareId", "botId", "threadId", "note", "text", "url", "items")) return null;
            if (!field(o, "shareId", "pattern:[A-Za-z0-9_-]{16,80}", false, false)) return null;
            if (!field(o, "botId", "text:1:128", false, false)) return null;
            if (!field(o, "threadId", "thread", false, false)) return null;
            if (!field(o, "note", "text:1:2000", true, false)) return null;
            if (!field(o, "text", "text:1:1048576", true, false)) return null;
            if (!field(o, "url", "url", true, false)) return null;
            JSONArray itemsJSON = o.optJSONArray("items");
            if (itemsJSON == null || itemsJSON.length() > 10) return null;
            List<ShareItem> itemsValues = new ArrayList<>();
            for (int i = 0; i < itemsJSON.length(); i++) {
                ShareItem item = ShareItem.parse(itemsJSON.opt(i));
                if (item == null) return null;
                itemsValues.add(item);
            }
            if (!o.has("note") && !o.has("text") && !o.has("url") && itemsValues.isEmpty()) return null;
            for (int i = 0; i < itemsValues.size(); i++) if (itemsValues.get(i).n != i + 1) return null;
            return new ShareManifest((String) o.opt("shareId"), (String) o.opt("botId"), (String) o.opt("threadId"), (o.opt("note") instanceof String ? (String) o.opt("note") : null), (o.opt("text") instanceof String ? (String) o.opt("text") : null), (o.opt("url") instanceof String ? (String) o.opt("url") : null), itemsValues);
        }
        public JSONObject encode() {
            try {
                JSONObject o = new JSONObject();
                o.put("shareId", shareId);
                o.put("botId", botId);
                o.put("threadId", threadId);
                if (note != null) o.put("note", note);
                if (text != null) o.put("text", text);
                if (url != null) o.put("url", url);
                JSONArray itemsJSON = new JSONArray();
                for (ShareItem item : items) { JSONObject body = item.encode(); if (body == null) return null; itemsJSON.put(body); }
                o.put("items", itemsJSON);
                return parse(o) == null ? null : o;
            } catch (JSONException e) { return null; }
        }
    }

    public static final class AskRequest {
        public final String askId;
        public final String botId;
        public final String text;
        public AskRequest(String askId, String botId, String text) {
            this.askId = askId;
            this.botId = botId;
            this.text = text;
        }
        public static AskRequest parse(Object value) {
            if (!(value instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) value;
            if (!keys(o, "askId", "botId", "text")) return null;
            if (!field(o, "askId", "pattern:[A-Za-z0-9_-]{16,80}", false, false)) return null;
            if (!field(o, "botId", "text:1:128", false, false)) return null;
            if (!field(o, "text", "text:1:1048576", false, false)) return null;
            return new AskRequest((String) o.opt("askId"), (String) o.opt("botId"), (String) o.opt("text"));
        }
        public JSONObject encode() {
            try {
                JSONObject o = new JSONObject();
                o.put("askId", askId);
                o.put("botId", botId);
                o.put("text", text);
                return parse(o) == null ? null : o;
            } catch (JSONException e) { return null; }
        }
    }

    public static final class TokenRequest {
        public final String keyId;
        public final String nonce;
        public final long expiresAt;
        public final String signature;
        public final String scope;
        public TokenRequest(String keyId, String nonce, long expiresAt, String signature, String scope) {
            this.keyId = keyId;
            this.nonce = nonce;
            this.expiresAt = expiresAt;
            this.signature = signature;
            this.scope = scope;
        }
        public static TokenRequest parse(Object value) {
            if (!(value instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) value;
            if (!keys(o, "keyId", "nonce", "expiresAt", "signature", "scope")) return null;
            if (!field(o, "keyId", "pattern:[A-Za-z0-9_-]{43}", false, false)) return null;
            if (!field(o, "nonce", "pattern:[A-Za-z0-9_-]{43}", false, false)) return null;
            if (!field(o, "expiresAt", "integer:1:9007199254740991", false, false)) return null;
            if (!field(o, "signature", "pattern:[A-Za-z0-9_-]{16,200}", false, false)) return null;
            if (!field(o, "scope", "enum:jobs:ask", true, false)) return null;
            return new TokenRequest((String) o.opt("keyId"), (String) o.opt("nonce"), ((Number) o.opt("expiresAt")).longValue(), (String) o.opt("signature"), (o.opt("scope") instanceof String ? (String) o.opt("scope") : null));
        }
        public JSONObject encode() {
            try {
                JSONObject o = new JSONObject();
                o.put("keyId", keyId);
                o.put("nonce", nonce);
                o.put("expiresAt", expiresAt);
                o.put("signature", signature);
                if (scope != null) o.put("scope", scope);
                return parse(o) == null ? null : o;
            } catch (JSONException e) { return null; }
        }
    }

    public static final class TargetBot {
        public final String id;
        public final String name;
        public final String avatar;
        public final String mainThreadId;
        public TargetBot(String id, String name, String avatar, String mainThreadId) {
            this.id = id;
            this.name = name;
            this.avatar = avatar;
            this.mainThreadId = mainThreadId;
        }
        public static TargetBot parse(Object value) {
            if (!(value instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) value;
            if (!keys(o, "id", "name", "avatar", "mainThreadId")) return null;
            if (!field(o, "id", "text:1:128", false, false)) return null;
            if (!field(o, "name", "text:1:120", false, false)) return null;
            if (!field(o, "avatar", "string", false, true)) return null;
            if (!field(o, "mainThreadId", "text:1:128", false, false)) return null;
            return new TargetBot((String) o.opt("id"), (String) o.opt("name"), (o.opt("avatar") instanceof String ? (String) o.opt("avatar") : null), (String) o.opt("mainThreadId"));
        }
        public JSONObject encode() {
            try {
                JSONObject o = new JSONObject();
                o.put("id", id);
                o.put("name", name);
                o.put("avatar", avatar == null ? JSONObject.NULL : avatar);
                o.put("mainThreadId", mainThreadId);
                return parse(o) == null ? null : o;
            } catch (JSONException e) { return null; }
        }
    }

    public static final class RecentTarget {
        public final String botId;
        public final String threadId;
        public final String title;
        public final long at;
        public RecentTarget(String botId, String threadId, String title, long at) {
            this.botId = botId;
            this.threadId = threadId;
            this.title = title;
            this.at = at;
        }
        public static RecentTarget parse(Object value) {
            if (!(value instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) value;
            if (!keys(o, "botId", "threadId", "title", "at")) return null;
            if (!field(o, "botId", "text:1:128", false, false)) return null;
            if (!field(o, "threadId", "text:1:128", false, false)) return null;
            if (!field(o, "title", "text:0:200", false, false)) return null;
            if (!field(o, "at", "integer:0:9007199254740991", false, false)) return null;
            return new RecentTarget((String) o.opt("botId"), (String) o.opt("threadId"), (String) o.opt("title"), ((Number) o.opt("at")).longValue());
        }
        public JSONObject encode() {
            try {
                JSONObject o = new JSONObject();
                o.put("botId", botId);
                o.put("threadId", threadId);
                o.put("title", title);
                o.put("at", at);
                return parse(o) == null ? null : o;
            } catch (JSONException e) { return null; }
        }
    }

    public static final class TargetsAnswer {
        public final String workspace;
        public final List<TargetBot> bots;
        public final List<RecentTarget> recent;
        public TargetsAnswer(String workspace, List<TargetBot> bots, List<RecentTarget> recent) {
            this.workspace = workspace;
            this.bots = Collections.unmodifiableList(new ArrayList<>(bots));
            this.recent = Collections.unmodifiableList(new ArrayList<>(recent));
        }
        public static TargetsAnswer parse(Object value) {
            if (!(value instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) value;
            if (!keys(o, "workspace", "bots", "recent")) return null;
            if (!field(o, "workspace", "text:0:120", false, false)) return null;
            JSONArray botsJSON = o.optJSONArray("bots");
            if (botsJSON == null) return null;
            List<TargetBot> botsValues = new ArrayList<>();
            for (int i = 0; i < botsJSON.length(); i++) {
                TargetBot item = TargetBot.parse(botsJSON.opt(i));
                if (item == null) return null;
                botsValues.add(item);
            }
            JSONArray recentJSON = o.optJSONArray("recent");
            if (recentJSON == null || recentJSON.length() > 8) return null;
            List<RecentTarget> recentValues = new ArrayList<>();
            for (int i = 0; i < recentJSON.length(); i++) {
                RecentTarget item = RecentTarget.parse(recentJSON.opt(i));
                if (item == null) return null;
                recentValues.add(item);
            }
            return new TargetsAnswer((String) o.opt("workspace"), botsValues, recentValues);
        }
        public JSONObject encode() {
            try {
                JSONObject o = new JSONObject();
                o.put("workspace", workspace);
                JSONArray botsJSON = new JSONArray();
                for (TargetBot item : bots) { JSONObject body = item.encode(); if (body == null) return null; botsJSON.put(body); }
                o.put("bots", botsJSON);
                JSONArray recentJSON = new JSONArray();
                for (RecentTarget item : recent) { JSONObject body = item.encode(); if (body == null) return null; recentJSON.put(body); }
                o.put("recent", recentJSON);
                return parse(o) == null ? null : o;
            } catch (JSONException e) { return null; }
        }
    }

    public static final class ShareSent {
        public final String state;
        public final String threadId;
        public final String messageId;
        public final String queueId;
        public ShareSent(String state, String threadId, String messageId, String queueId) {
            this.state = state;
            this.threadId = threadId;
            this.messageId = messageId;
            this.queueId = queueId;
        }
        public static ShareSent parse(Object value) {
            if (!(value instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) value;
            if (!keys(o, "state", "threadId", "messageId", "queueId")) return null;
            if (!field(o, "state", "enum:sent", false, false)) return null;
            if (!field(o, "threadId", "string", false, false)) return null;
            if (!field(o, "messageId", "string", true, false)) return null;
            if (!field(o, "queueId", "string", true, false)) return null;
            return new ShareSent((String) o.opt("state"), (String) o.opt("threadId"), (o.opt("messageId") instanceof String ? (String) o.opt("messageId") : null), (o.opt("queueId") instanceof String ? (String) o.opt("queueId") : null));
        }
        public JSONObject encode() {
            try {
                JSONObject o = new JSONObject();
                o.put("state", state);
                o.put("threadId", threadId);
                if (messageId != null) o.put("messageId", messageId);
                if (queueId != null) o.put("queueId", queueId);
                return parse(o) == null ? null : o;
            } catch (JSONException e) { return null; }
        }
    }

    public static final class AskSent {
        public final String state;
        public final String askId;
        public final String threadId;
        public final String id;
        public final boolean notify;
        public AskSent(String state, String askId, String threadId, String id, boolean notify) {
            this.state = state;
            this.askId = askId;
            this.threadId = threadId;
            this.id = id;
            this.notify = notify;
        }
        public static AskSent parse(Object value) {
            if (!(value instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) value;
            if (!keys(o, "state", "askId", "threadId", "id", "notify")) return null;
            if (!field(o, "state", "enum:sent", false, false)) return null;
            if (!field(o, "askId", "string", false, false)) return null;
            if (!field(o, "threadId", "string", false, false)) return null;
            if (!field(o, "id", "string", false, false)) return null;
            if (!field(o, "notify", "bool", false, false)) return null;
            return new AskSent((String) o.opt("state"), (String) o.opt("askId"), (String) o.opt("threadId"), (String) o.opt("id"), (Boolean) o.opt("notify"));
        }
        public JSONObject encode() {
            try {
                JSONObject o = new JSONObject();
                o.put("state", state);
                o.put("askId", askId);
                o.put("threadId", threadId);
                o.put("id", id);
                o.put("notify", notify);
                return parse(o) == null ? null : o;
            } catch (JSONException e) { return null; }
        }
    }

    public static final class ShareFailure {
        public final String error;
        public final String code;
        public ShareFailure(String error, String code) {
            this.error = error;
            this.code = code;
        }
        public static ShareFailure parse(Object value) {
            if (!(value instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) value;
            if (!keys(o, "error", "code")) return null;
            if (!field(o, "error", "string", false, false)) return null;
            if (!field(o, "code", "enum:conflict:target_gone:too_large:unsupported_type:invalid:revoked", false, false)) return null;
            return new ShareFailure((String) o.opt("error"), (String) o.opt("code"));
        }
        public JSONObject encode() {
            try {
                JSONObject o = new JSONObject();
                o.put("error", error);
                o.put("code", code);
                return parse(o) == null ? null : o;
            } catch (JSONException e) { return null; }
        }
    }

    public static final class AskFailure {
        public final String error;
        public final String code;
        public AskFailure(String error, String code) {
            this.error = error;
            this.code = code;
        }
        public static AskFailure parse(Object value) {
            if (!(value instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) value;
            if (!keys(o, "error", "code")) return null;
            if (!field(o, "error", "string", false, false)) return null;
            if (!field(o, "code", "enum:conflict:target_gone:invalid:revoked", false, false)) return null;
            return new AskFailure((String) o.opt("error"), (String) o.opt("code"));
        }
        public JSONObject encode() {
            try {
                JSONObject o = new JSONObject();
                o.put("error", error);
                o.put("code", code);
                return parse(o) == null ? null : o;
            } catch (JSONException e) { return null; }
        }
    }

    public static final class ShareAnswer {
        public final ShareSent sent;
        public final ShareFailure failure;
        private ShareAnswer(ShareSent sent, ShareFailure failure) { this.sent = sent; this.failure = failure; }
        public static ShareAnswer parse(Object value) {
            if (!(value instanceof JSONObject)) return null;
            if (((JSONObject) value).has("error")) {
                ShareFailure body = ShareFailure.parse(value);
                return body == null ? null : new ShareAnswer(null, body);
            }
            ShareSent body = ShareSent.parse(value);
            return body == null ? null : new ShareAnswer(body, null);
        }
        public JSONObject encode() { return sent != null ? sent.encode() : failure.encode(); }
    }

    public static final class AskAnswer {
        public final AskSent sent;
        public final AskFailure failure;
        private AskAnswer(AskSent sent, AskFailure failure) { this.sent = sent; this.failure = failure; }
        public static AskAnswer parse(Object value) {
            if (!(value instanceof JSONObject)) return null;
            if (((JSONObject) value).has("error")) {
                AskFailure body = AskFailure.parse(value);
                return body == null ? null : new AskAnswer(null, body);
            }
            AskSent body = AskSent.parse(value);
            return body == null ? null : new AskAnswer(body, null);
        }
        public JSONObject encode() { return sent != null ? sent.encode() : failure.encode(); }
    }
}
