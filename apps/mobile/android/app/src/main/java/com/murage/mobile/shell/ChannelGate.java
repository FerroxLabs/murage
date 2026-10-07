package com.murage.mobile.shell;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Twin of ChannelGate.swift, for the Android message envelope {id, method, args}. */
public final class ChannelGate {
    public static final int VERSION = 1;
    /** What hello() lists (Decision 3). callSessionOpen/Close started as
     * Android's own addition (callbar-rereview.md M4: Android has no
     * call-audio engine to ask, so the page tells native directly when a
     * call starts and ends) and are now shared -- iOS lists them too
     * (callbar-rereview2.md G3), since the page's own signal is the only
     * one that follows a real hang-up and not a retry, Resume or lost. */
    public static final List<String> ADVERTISED = Collections.unmodifiableList(
        Arrays.asList("ready", "saveFile", "openExternal", "haptic", "signOut", "rePair", "setRoute", "showLauncher",
            "registerPush", "pushStatus", "issuePushTokens", "setBadgeCount", "callSessionOpen", "callSessionClose", "diagLine",
            "approveWithDevice"));
    /** One 1 MiB chunk as base64 (1,398,104 chars) plus its envelope. */
    public static final int MAX_MESSAGE_CHARS = 1_500_000;

    private static final Set<String> METHODS;

    static {
        Set<String> all = new HashSet<>(ADVERTISED);
        all.add("hello");
        METHODS = Collections.unmodifiableSet(all);
    }

    private ChannelGate() {}

    public static final class Request {
        public final int id;
        public final String method;
        public final JSONObject args;

        Request(int id, String method, JSONObject args) {
            this.id = id;
            this.method = method;
            this.args = args;
        }
    }

    /** Spec §2: main frame only, and the frame's origin must be the saved one. */
    public static boolean admit(boolean isMainFrame, WorkspaceOrigin frame, WorkspaceOrigin saved) {
        return isMainFrame && saved != null && saved.equals(frame);
    }

    public static Request parse(String data) throws ChannelException {
        if (data == null) throw new ChannelException("bad_args");
        if (data.length() > MAX_MESSAGE_CHARS) throw new ChannelException("too_large");
        JSONObject message = Json.object(data);
        if (message == null) throw new ChannelException("bad_args");
        Integer id = ChannelArgs.integer(message.opt("id"));
        int replyId = id == null ? -1 : id;
        Object method = message.opt("method");
        if (!(method instanceof String)) throw new ChannelException("bad_args", replyId);
        if (!METHODS.contains(method)) throw new ChannelException("unknown_method", replyId);
        Object args = message.opt("args");
        if (args == null || args == JSONObject.NULL) return new Request(replyId, (String) method, new JSONObject());
        if (!(args instanceof JSONObject)) throw new ChannelException("bad_args", replyId);
        return new Request(replyId, (String) method, (JSONObject) args);
    }

    public static JSONObject hello() {
        JSONObject hello = new JSONObject();
        Json.put(hello, "version", VERSION);
        Json.put(hello, "methods", new JSONArray(ADVERTISED));
        return hello;
    }
}
