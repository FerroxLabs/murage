package com.murage.mobile.shell;

import java.io.*;
import java.util.*;
import org.json.*;

/** Native cache is only a hint. The server rechecks the selected target at commit. */
public final class ShareTargets {
    public static final long FRESH = 300_000, MAX_AGE = 30L * 86_400_000;
    public enum State { LOADING, SETUP, UPDATE, READY }
    public static final class Result {
        public final State state;
        public final PhoneAskContract.TargetsAnswer targets;
        Result(State state, PhoneAskContract.TargetsAnswer targets) { this.state = state; this.targets = targets; }
    }
    public static final class Response {
        public final int status; public final String body;
        public Response(int status, String body) { this.status = status; this.body = body; }
    }
    public interface Fetch { Response get(WorkspaceOrigin origin, String token) throws Exception; }
    private final File root;
    private final ShareAccess access;
    private final Fetch fetch;
    private final java.util.function.Consumer<WorkspaceOrigin> published;
    private final Map<String, Long> attempts = new HashMap<>();
    public ShareTargets(File root, ShareAccess access, Fetch fetch) { this(root, access, fetch, origin -> {}); }
    public ShareTargets(File root, ShareAccess access, Fetch fetch, java.util.function.Consumer<WorkspaceOrigin> published) {
        this.root = root; this.access = access; this.fetch = fetch; this.published = published;
    }
    public File file(WorkspaceOrigin origin) { return file(root, origin); }
    private static File file(File root, WorkspaceOrigin origin) { return new File(new File(root, "targets"), ShareFiles.workspace(origin) + ".json"); }
    private static JSONObject entry(File root, WorkspaceOrigin origin, long now) {
        try {
            JSONObject e = new JSONObject(ShareFiles.read(file(root, origin), 2 * 1024 * 1024));
            long at = e.getLong("fetchedAt");
            return e.getInt("v") == 1 && origin.serialized().equals(e.getString("origin")) && at >= 0 && at <= now
                && now - at <= MAX_AGE && PhoneAskContract.TargetsAnswer.parse(e.opt("targets")) != null ? e : null;
        } catch (Exception invalid) { return null; }
    }
    public PhoneAskContract.TargetsAnswer read(WorkspaceOrigin origin, long now) {
        return readCached(root, origin, now);
    }
    /** Cache-only entry for the composer trampoline: no access/token/fetch object is constructed. */
    public static PhoneAskContract.TargetsAnswer readCached(File root, WorkspaceOrigin origin, long now) {
        JSONObject e = entry(root, origin, now); return e == null ? null : PhoneAskContract.TargetsAnswer.parse(e.opt("targets"));
    }
    public static String resolveBot(PhoneAskContract.TargetsAnswer targets, String shortcut, String lastUsed) {
        if (knownBot(targets, shortcut) != null) return shortcut;
        return knownBot(targets, lastUsed) == null ? null : lastUsed;
    }
    private static PhoneAskContract.TargetBot knownBot(PhoneAskContract.TargetsAnswer targets, String id) {
        if (targets == null || !OpenHash.validBot(id)) return null;
        for (PhoneAskContract.TargetBot bot : targets.bots) if (id.equals(bot.id)) return bot;
        return null;
    }
    /** Last selection first, then distinct bots in descending recent-chat order. */
    public static List<PhoneAskContract.TargetBot> recentBots(PhoneAskContract.TargetsAnswer targets, String lastUsed) {
        LinkedHashMap<String, PhoneAskContract.TargetBot> bots = new LinkedHashMap<>();
        PhoneAskContract.TargetBot last = knownBot(targets, lastUsed);
        if (last != null) bots.put(last.id, last);
        if (targets != null) {
            List<PhoneAskContract.RecentTarget> recent = new ArrayList<>(targets.recent);
            recent.sort((a, b) -> Long.compare(b.at, a.at));
            for (PhoneAskContract.RecentTarget row : recent) {
                PhoneAskContract.TargetBot bot = knownBot(targets, row.botId);
                if (bot != null && bots.size() < 4) bots.putIfAbsent(bot.id, bot);
            }
        }
        return new ArrayList<>(bots.values());
    }
    public boolean needsRefresh(WorkspaceOrigin origin, long now) {
        JSONObject e = entry(root, origin, now); return e == null || now - e.optLong("fetchedAt") > FRESH;
    }
    public void remove(WorkspaceOrigin origin) throws IOException {
        synchronized (ShareFiles.LOCK) { ShareFiles.delete(file(origin)); attempts.remove(origin.serialized()); }
    }
    public Result initial(WorkspaceOrigin origin, long now) {
        synchronized (ShareFiles.LOCK) {
            if (access.current(origin) == null) return new Result(State.SETUP, null);
            PhoneAskContract.TargetsAnswer value = read(origin, now);
            return value == null ? new Result(State.LOADING, null) : result(value);
        }
    }
    private static Result result(PhoneAskContract.TargetsAnswer value) {
        return new Result(value.bots.isEmpty() ? State.SETUP : State.READY, value);
    }
    public Result open(WorkspaceOrigin origin, long now, Set<String> opened) {
        synchronized (ShareFiles.LOCK) {
            if (!opened.add(origin.serialized()) || !needsRefresh(origin, now)) return initial(origin, now);
        }
        return refresh(origin, now);
    }
    public void foreground(WorkspaceOrigin origin, long now) {
        synchronized (ShareFiles.LOCK) {
            if (access.current(origin) == null) return;
            Long last = attempts.get(origin.serialized());
            if (!needsRefresh(origin, now) || (last != null && now - last < FRESH)) return;
            attempts.put(origin.serialized(), now);
        }
        refresh(origin, now);
    }
    public Result refresh(WorkspaceOrigin origin, long now) {
        Result fallback = initial(origin, now); String token;
        synchronized (ShareFiles.LOCK) { token = access.current(origin); }
        if (token == null) return new Result(State.SETUP, null);
        try {
            Response response = fetch.get(origin, token);
            synchronized (ShareFiles.LOCK) {
                // Includes codeless authentication failures, even after a concurrent forget.
                if (access.revoked(origin, response.status)) return new Result(State.SETUP, null);
                if (access.pending(origin) || !token.equals(access.current(origin))) return new Result(State.SETUP, null);
                if (response.status == 404) return new Result(State.UPDATE, null);
                PhoneAskContract.TargetsAnswer value = response.status == 200 && response.body != null
                    ? PhoneAskContract.TargetsAnswer.parse(new JSONObject(response.body)) : null;
                if (value != null) {
                    // Same lock as forget and mint: no cache publication can follow a removal.
                    if (access.pending(origin) || !token.equals(access.current(origin))) return new Result(State.SETUP, null);
                    ShareFiles.json(file(origin), new JSONObject().put("v", 1).put("origin", origin.serialized())
                        .put("fetchedAt", now).put("targets", value.encode()));
                    published.accept(origin);
                    return result(value);
                }
            }
        } catch (Exception ignored) { }
        synchronized (ShareFiles.LOCK) {
            if (access.current(origin) == null || fallback.state == State.LOADING) return new Result(State.SETUP, null);
            return fallback;
        }
    }
    public boolean allows(WorkspaceOrigin origin, String bot, String thread, long now) {
        synchronized (ShareFiles.LOCK) { return access.current(origin) != null && contains(read(origin, now), bot, thread); }
    }
    public static boolean contains(PhoneAskContract.TargetsAnswer value, String bot, String thread) {
        if (value == null) return false;
        for (PhoneAskContract.TargetBot b : value.bots) if (b.id.equals(bot)) {
            if ("new".equals(thread) || thread.equals(b.mainThreadId)) return true;
            for (PhoneAskContract.RecentTarget r : value.recent) if (bot.equals(r.botId) && thread.equals(r.threadId)) return true;
        }
        return false;
    }
}
