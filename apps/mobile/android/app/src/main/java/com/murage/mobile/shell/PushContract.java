package com.murage.mobile.shell;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.json.JSONObject;

/** Twin of PushContract.swift; oracle apps/mobile/src/push-contract.ts. */
public final class PushContract {
    public static final int VERSION = 2;
    private PushContract() {}

    private static final Pattern UUID = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
    private static final Pattern REF = Pattern.compile("^[a-f0-9]{64}$");
    private static final Pattern COLLAPSE = Pattern.compile("^[a-f0-9]{32}$");
    private static final Pattern GROUP = Pattern.compile("^[a-f0-9]{16}$");
    private static final Pattern DECIMAL = Pattern.compile("^(0|[1-9][0-9]{0,9})$");
    private static final Pattern DETAIL = Pattern.compile("^murage_pd_[A-Za-z0-9_-]{43}$");
    private static final Pattern RESPOND = Pattern.compile("^murage_pr_[A-Za-z0-9_-]{43}$");
    private static final Set<String> KEYS = new HashSet<>(Arrays.asList("bindingId", "eventRef", "category", "revision", "workspaceBadge", "collapseKey"));

    public enum Category {
        APPROVAL("approval"), APPROVAL_OPEN("approval-open"), QUESTION("question"), DONE("done"), RESOLVED("resolved"), DEVICE_JOB("device-job"), CALL("call"), CALL_NOTE("call-note");
        public final String wire;
        Category(String wire) { this.wire = wire; }
        public static Category of(Object v) {
            for (Category c : values()) if (c.wire.equals(v)) return c;
            return null;
        }
        public boolean isExpiring() { return this == CALL || this == CALL_NOTE; }
        public boolean isTimeSensitive() { return this == CALL; }
        public String iosCategory() {
            switch (this) {
                case APPROVAL: return "APPROVAL";
                case APPROVAL_OPEN: return "APPROVAL_OPEN";
                case QUESTION: return "QUESTION";
                case DEVICE_JOB: return "DEVICE_JOB";
                case CALL: return "CALL";
                case CALL_NOTE: return "CALL_NOTE";
                default: return "DONE";
            }
        }
        public String channel() {
            switch (this) {
                case APPROVAL: case APPROVAL_OPEN: return "approvals";
                case DEVICE_JOB: return "requests";
                case QUESTION: case CALL_NOTE: return "questions";
                case CALL: return "calls_v2";
                default: return "finished";
            }
        }
        public String genericTitle() { return this == CALL ? "Murage is calling" : "Murage"; }
        public String genericBody() {
            switch (this) {
                case CALL: return "Answer to hear what it is.";
                case CALL_NOTE: return "Murage has a message for you.";
                case DONE: return "A task has finished.";
                case RESOLVED: return "No longer waiting.";
                case DEVICE_JOB: return "A bot is asking to use your phone";
                default: return "Your attention is needed.";
            }
        }
    }

    public static final java.util.List<Category> EXPIRING_CATEGORIES = java.util.Collections.unmodifiableList(Arrays.asList(Category.CALL, Category.CALL_NOTE));
    public static final class CallSound {
        public static final String IOS = "murage-call.caf", ANDROID = "murage_call";
        public static final int SECONDS = 10;
        private CallSound() {}
    }
    public static final class Action {
        public final String id, title;
        public final java.util.List<String> options;
        private Action(String id, String title, String... options) {
            this.id = id; this.title = title;
            this.options = java.util.Collections.unmodifiableList(Arrays.asList(options));
        }
    }
    public static final Map<String, java.util.List<Action>> IOS_ACTIONS = java.util.Collections.singletonMap("CALL",
        java.util.Collections.unmodifiableList(Arrays.asList(
            new Action("ANSWER", "Answer", "foreground", "authenticationRequired"),
            new Action("NOT_NOW", "Not now", "authenticationRequired"))));

    public static String callDisplayAction(Payload p, long now, java.util.Collection<String> shown) {
        if (p.category == Category.RESOLVED) return shown.contains(p.collapseKey) ? "replace" : "silent";
        if (p.expiresAt != null && now >= p.expiresAt) return "silent";
        return p.category == Category.CALL ? "ring" : "show";
    }
    private static Set<String> keysFor(Object category) {
        Set<String> out = new HashSet<>(KEYS);
        Category c = Category.of(category);
        if (c != null && c.isExpiring()) out.add("expiresAt");
        return out;
    }
    private static Long stamp(Object raw) {
        if (!(raw instanceof Number)) return null;
        double n = ((Number) raw).doubleValue();
        return Double.isFinite(n) && n == Math.floor(n) && n > 0 && n <= 9_007_199_254_740_991d ? ((Number) raw).longValue() : null;
    }
    private static Long decimalStamp(String raw) {
        if (raw == null || !raw.matches("^[1-9][0-9]{0,15}$")) return null;
        return stamp(Long.parseLong(raw));
    }

    /** B5: flipped by Plan 3a Task 0's verdict; mirrors contract/push-features.json. */
    public static final class Features {
        public static final boolean RICH_TEXT = true;
        public static final boolean LOCK_SCREEN_ACTIONS = true;
        private Features() {}
    }

    public static final class Payload {
        public final String bindingId, eventRef, collapseKey, threadGroup;
        public final Category category;
        public final int revision, workspaceBadge;
        public final Long expiresAt;

        private Payload(String bindingId, String eventRef, Category category, int revision, int workspaceBadge, String collapseKey, String threadGroup, Long expiresAt) {
            this.bindingId = bindingId; this.eventRef = eventRef; this.category = category; this.revision = revision;
            this.workspaceBadge = workspaceBadge; this.collapseKey = collapseKey; this.threadGroup = threadGroup; this.expiresAt = expiresAt;
        }

        private static Payload build(Object bindingId, Object eventRef, Object category, Integer revision, Integer badge, Object collapseKey, String group, Long expiresAt) {
            Category c = Category.of(category);
            if (!(bindingId instanceof String) || !UUID.matcher((String) bindingId).matches()) return null;
            if (!(eventRef instanceof String) || !REF.matcher((String) eventRef).matches()) return null;
            if (!(collapseKey instanceof String) || !COLLAPSE.matcher((String) collapseKey).matches()) return null;
            if (c == null || revision == null || revision < 1 || badge == null || badge < 0) return null;
            if (c.isExpiring() && expiresAt == null) return null;
            return new Payload((String) bindingId, (String) eventRef, c, revision, badge, (String) collapseKey, group, expiresAt);
        }

        public static Payload parse(Object any) {
            if (!(any instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) any;
            Set<String> keys = new HashSet<>();
            for (java.util.Iterator<String> it = o.keys(); it.hasNext();) keys.add(it.next());
            if (!keys.equals(keysFor(o.opt("category")))) return null;
            return build(o.opt("bindingId"), o.opt("eventRef"), o.opt("category"), ChannelArgs.integer(o.opt("revision")), ChannelArgs.integer(o.opt("workspaceBadge")), o.opt("collapseKey"), null, stamp(o.opt("expiresAt")));
        }

        public static Payload fromFcmData(Map<String, String> d) {
            Set<String> expected = keysFor(d.get("category"));
            expected.add("threadGroup");
            if (!d.keySet().equals(expected)) return null;
            String group = d.get("threadGroup");
            if (group == null || !GROUP.matcher(group).matches()) return null;
            return build(d.get("bindingId"), d.get("eventRef"), d.get("category"), decimal(d.get("revision")), decimal(d.get("workspaceBadge")), d.get("collapseKey"), group, decimalStamp(d.get("expiresAt")));
        }

        private static Integer decimal(String s) {
            if (s == null || !DECIMAL.matcher(s).matches()) return null;
            long n = Long.parseLong(s);
            return n <= Integer.MAX_VALUE ? (int) n : null;
        }
    }

    public static final class Issued {
        public final String bindingId, detail, respond;
        public final long expiresAt;

        private Issued(String bindingId, String detail, String respond, long expiresAt) {
            this.bindingId = bindingId; this.detail = detail; this.respond = respond; this.expiresAt = expiresAt;
        }

        public static Issued parse(Object any) {
            if (!(any instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) any;
            if (o.length() != 4) return null;
            Object b = o.opt("bindingId"), d = o.opt("detail"), r = o.opt("respond"), e = o.opt("expiresAt");
            if (!(b instanceof String) || !UUID.matcher((String) b).matches()) return null;
            if (!(d instanceof String) || !DETAIL.matcher((String) d).matches()) return null;
            if (!(r instanceof String) || !RESPOND.matcher((String) r).matches()) return null;
            if (!(e instanceof Number) || ((Number) e).doubleValue() != Math.floor(((Number) e).doubleValue()) || ((Number) e).longValue() <= 0) return null;
            return new Issued((String) b, (String) d, (String) r, ((Number) e).longValue());
        }
    }
}
