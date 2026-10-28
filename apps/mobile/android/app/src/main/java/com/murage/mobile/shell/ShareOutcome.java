package com.murage.mobile.shell;

import org.json.JSONObject;

public enum ShareOutcome {
    SENT, CONFLICT, TARGET_GONE, TOO_LARGE, UNSUPPORTED_TYPE, INVALID, REVOKED, UPDATE, RETRY;
    public static ShareOutcome read(int status, String body) {
        if (status == 401 || status == 403) return REVOKED;
        if (status == 404) return UPDATE;
        JSONObject json = null;
        try { if (body != null) json = new JSONObject(body); } catch (Exception ignored) { }
        PhoneAskContract.ShareSent sent = PhoneAskContract.ShareSent.parse(json);
        if (status == 200 && sent != null && !sent.threadId.isEmpty()
            && ((sent.messageId != null && !sent.messageId.isEmpty()) || (sent.queueId != null && !sent.queueId.isEmpty()))) return SENT;
        PhoneAskContract.ShareFailure failure = PhoneAskContract.ShareFailure.parse(json);
        String code = failure == null ? "" : failure.code;
        if (status == 409 && code.equals("conflict")) return CONFLICT;
        if (status == 409 && code.equals("target_gone")) return TARGET_GONE;
        if (status == 413 && code.equals("too_large")) return TOO_LARGE;
        if (status == 415 && code.equals("unsupported_type")) return UNSUPPORTED_TYPE;
        if (status == 422 && code.equals("invalid")) return INVALID;
        return RETRY;
    }
}
