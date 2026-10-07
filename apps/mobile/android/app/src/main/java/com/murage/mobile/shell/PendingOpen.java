package com.murage.mobile.shell;

import org.json.JSONObject;

/**
 * A conversation to open once the page is up. Twin of PendingOpen in
 * RouteMemory.swift. It holds a bare origin and ids only, never a credential.
 */
public final class PendingOpen {
    public final String origin;
    public final String threadId;
    public final String messageId;

    public PendingOpen(WorkspaceOrigin origin, String threadId, String messageId) {
        this(origin.serialized(), threadId, messageId);
    }

    private PendingOpen(String origin, String threadId, String messageId) {
        this.origin = origin;
        this.threadId = threadId;
        this.messageId = messageId;
    }

    String toJson() {
        JSONObject json = new JSONObject();
        Json.put(json, "origin", origin);
        Json.put(json, "threadId", threadId);
        if (messageId != null) Json.put(json, "messageId", messageId);
        return json.toString();
    }

    /** Strictly typed like Swift's JSONDecoder: a wrong type voids the record; a null messageId is absent. */
    static PendingOpen fromJson(String text) {
        JSONObject json = text == null ? null : Json.object(text);
        if (json == null) return null;
        Object origin = json.opt("origin");
        Object thread = json.opt("threadId");
        Object message = json.opt("messageId");
        if (!(origin instanceof String) || !(thread instanceof String) || !OpenHash.valid((String) thread)) return null;
        if (message == JSONObject.NULL) message = null;
        if (message != null && !(message instanceof String)) return null;
        return new PendingOpen((String) origin, (String) thread, (String) message);
    }
}
