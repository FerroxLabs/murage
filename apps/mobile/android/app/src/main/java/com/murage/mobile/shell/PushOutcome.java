package com.murage.mobile.shell;

import org.json.JSONObject;

/** Twin of PushOutcome.swift; oracle apps/mobile/src/push-outcome.ts. */
public final class PushOutcome {
    private PushOutcome() {}

    public static final class Target {
        public final String threadId, messageId, requestId;
        Target(String t, String m, String r) { threadId = t; messageId = m; requestId = r; }
    }
    public static final class Detail {
        public final String title, body;
        public final Target target;
        Detail(String title, String body, Target target) { this.title = title; this.body = body; this.target = target; }
    }
    public enum Notice {
        APPROVED("approved", "Approved."), DENIED("denied", "Denied."), STEP_UP("stepUp", "Open Murage to allow this."),
        ALREADY_ANSWERED("alreadyAnswered", "This was already answered."),
        UNREACHABLE("unreachable", "Couldn't reach your Murage, open the app."), OPEN_APP("openApp", "Open Murage to answer this.");
        public final String wire;
        private final String body;
        Notice(String wire, String body) { this.wire = wire; this.body = body; }
        public String title() { return "Murage"; }
        public String body() { return body; }
    }

    private static String id(Object v) {
        return v instanceof String && !((String) v).isEmpty() && ((String) v).length() <= 512 ? (String) v : null;
    }

    public static Detail detail(Integer status, Object body, PushContract.Category category) {
        Detail generic = new Detail(category.genericTitle(), category.genericBody(), null);
        if (status == null || status != 200 || !(body instanceof JSONObject)) return generic;
        JSONObject b = (JSONObject) body;
        Object title = b.opt("title"), text = b.opt("body");
        JSONObject t = b.optJSONObject("target");
        if (!(title instanceof String) || ((String) title).isEmpty() || ((String) title).length() > 200) return generic;
        if (!(text instanceof String) || ((String) text).length() > 2000) return generic;
        if (t == null || id(t.opt("threadId")) == null) return generic;
        return new Detail((String) title, (String) text, new Target(id(t.opt("threadId")), id(t.opt("messageId")), id(t.opt("requestId"))));
    }

    public static Notice notice(Integer status, Object body, String decision) {
        Object code = body instanceof JSONObject ? ((JSONObject) body).opt("code") : null;
        if (status == null || status >= 500) return Notice.UNREACHABLE;
        if (status == 200) {
            if (body instanceof JSONObject && "unavailable".equals(((JSONObject) body).opt("outcome"))) return Notice.OPEN_APP;
            return "allow".equals(decision) ? Notice.APPROVED : Notice.DENIED;
        }
        if (status == 403 && "step_up".equals(code)) return Notice.STEP_UP;
        if (status == 409 && "already_answered".equals(code)) return Notice.ALREADY_ANSWERED;
        return Notice.OPEN_APP;
    }
}
