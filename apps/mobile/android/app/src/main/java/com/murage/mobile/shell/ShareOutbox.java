package com.murage.mobile.shell;

import java.io.*;
import java.util.*;
import java.util.function.Function;
import java.util.function.LongSupplier;
import org.json.*;

/** Durable outcomes and retries, with injectable calls and clock for JVM tests. */
public final class ShareOutbox {
    public static final long DAY = 86_400_000, WEEK = 7 * DAY;
    public static final long[] BACKOFF = {60_000, 300_000, 1_800_000};
    public interface Call { ShareTargets.Response execute() throws Exception; void cancel(); }
    public interface Transport { Call create(WorkspaceOrigin origin, String token, File body, String boundary) throws IOException; }
    private static final class Live {
        final WorkspaceOrigin origin; final Call call;
        Live(WorkspaceOrigin origin, Call call) { this.origin = origin; this.call = call; }
    }
    private final File root;
    private final ShareAccess access;
    private final Transport transport;
    private final ShareTargets targets;
    private final LongSupplier clock;
    private final Map<String, Live> live = new HashMap<>();
    public ShareOutbox(File root, ShareAccess access, Transport transport, ShareTargets targets, LongSupplier clock) {
        this.root = root; this.access = access; this.transport = transport; this.targets = targets; this.clock = clock;
    }
    private File failuresFile() { return new File(new File(root, "outbox"), "failed.json"); }
    private JSONArray failures() throws IOException {
        synchronized (ShareFiles.LOCK) {
            if (!failuresFile().exists()) return new JSONArray();
            try {
                JSONArray lines = new JSONArray(ShareFiles.read(failuresFile(), 8 * 1024 * 1024));
                for (int i = 0; i < lines.length(); i++) lines.getJSONObject(i);
                return lines;
            } catch (JSONException e) {
                JSONArray repaired = new JSONArray();
                ShareFiles.json(failuresFile(), repaired);
                return repaired; // state.json still holds each durable outcome.
            }
        }
    }
    public File body(String id) throws IOException { return new File(ShareFiles.folder(root, id), "body"); }
    public JSONObject state(String id) throws IOException {
        synchronized (ShareFiles.LOCK) {
            ShareFiles.folder(root, id);
            JSONArray lines = failures();
            for (int i = 0; i < lines.length(); i++) {
                JSONObject line = lines.optJSONObject(i);
                if (line != null && id.equals(line.optString("shareId"))) return line;
            }
            try {
                JSONObject value = new JSONObject(ShareFiles.read(new File(ShareFiles.folder(root, id), "state.json"), 16384));
                if (!id.equals(value.getString("shareId"))) throw new IOException("state id");
                return value;
            } catch (JSONException e) { throw new IOException(e); }
        }
    }
    public List<JSONObject> entries() throws IOException {
        synchronized (ShareFiles.LOCK) {
            Map<String, JSONObject> values = new HashMap<>();
            File[] folders = new File(root, "outbox").listFiles();
            if (folders != null) for (File folder : folders) {
                if (!folder.isDirectory() || !folder.getName().matches("[A-Za-z0-9_-]{16,80}")) continue;
                try { values.put(folder.getName(), state(folder.getName())); } catch (IOException ignored) { }
            }
            JSONArray lines = failures();
            for (int i = 0; i < lines.length(); i++) {
                JSONObject line = lines.optJSONObject(i);
                if (line != null && line.optString("shareId").matches("[A-Za-z0-9_-]{16,80}")) values.put(line.optString("shareId"), line);
            }
            List<JSONObject> result = new ArrayList<>(values.values());
            result.sort((a, b) -> Long.compare(b.optLong("createdAt"), a.optLong("createdAt"))); return result;
        }
    }
    private void save(JSONObject value) throws IOException {
        ShareFiles.json(new File(ShareFiles.folder(root, value.optString("shareId")), "state.json"), value);
    }
    private void dropFailure(String id) throws IOException {
        JSONArray next = new JSONArray(), old = failures();
        for (int i = 0; i < old.length(); i++) if (!id.equals(old.optJSONObject(i).optString("shareId"))) next.put(old.optJSONObject(i));
        ShareFiles.json(failuresFile(), next);
    }
    private void deletePayload(String id) throws IOException {
        File[] files = ShareFiles.folder(root, id).listFiles();
        if (files != null) for (File file : files) if (!file.getName().equals("state.json")) ShareFiles.delete(file);
    }
    private void terminal(JSONObject value, boolean discard) throws IOException {
        if (!"sent".equals(value.optString("state"))) {
            JSONArray lines = failures(), next = new JSONArray();
            for (int i = 0; i < lines.length(); i++) if (!value.optString("shareId").equals(lines.optJSONObject(i).optString("shareId"))) next.put(lines.optJSONObject(i));
            next.put(value); ShareFiles.json(failuresFile(), next); // First, so a crash cannot resurrect a queued row.
        }
        save(value);
        if (discard) deletePayload(value.optString("shareId"));
    }
    public void completed(String id, WorkspaceOrigin origin, int status, String response) throws IOException {
        synchronized (ShareFiles.LOCK) {
            if (access.revoked(origin, status)) return; // Also applies to late, missing and already-terminal rows.
            JSONObject value = state(id);
            if (!"queued".equals(value.optString("state")) || access.pending(origin)) return;
            long now = clock.getAsLong();
            try {
                value.put("updatedAt", now); value.remove("nextAttemptAt");
                ShareOutcome outcome = ShareOutcome.read(status, response);
                if (outcome == ShareOutcome.RETRY) {
                    if (now - value.getLong("createdAt") >= WEEK) {
                        value.put("state", "failed").put("code", "expired"); terminal(value, true); return;
                    }
                    int attempt = value.optInt("attempts"); value.put("attempts", Math.min(attempt + 1, 4));
                    if (attempt < BACKOFF.length) value.put("nextAttemptAt", now + BACKOFF[attempt]);
                    save(value); return;
                }
                if (outcome == ShareOutcome.SENT) {
                    value.put("state", "sent"); value.remove("code");
                    value.put("threadId", new JSONObject(response).getString("threadId"));
                    terminal(value, true); return;
                }
                String code = outcome.name().toLowerCase(Locale.ROOT);
                value.put("state", outcome == ShareOutcome.TARGET_GONE ? "needsTarget" : "failed").put("code", code);
                terminal(value, outcome == ShareOutcome.TOO_LARGE || outcome == ShareOutcome.UNSUPPORTED_TYPE || outcome == ShareOutcome.INVALID);
                if (outcome == ShareOutcome.TARGET_GONE) targets.remove(origin);
            } catch (JSONException e) { throw new IOException(e); }
        }
    }
    /** A call is registered under the barrier lock before any network I/O. Cancel prevents later execute. */
    public void send(String id, WorkspaceOrigin origin) throws IOException {
        Live task;
        synchronized (ShareFiles.LOCK) {
            JSONObject value = state(id); long now = clock.getAsLong();
            if (!ShareFiles.workspace(origin).equals(value.optString("workspace")) || !"queued".equals(value.optString("state"))
                || live.containsKey(id) || now < value.optLong("nextAttemptAt") || now - value.optLong("createdAt") >= WEEK) return;
            String token = access.current(origin);
            if (token == null || !body(id).isFile()) return;
            task = new Live(origin, transport.create(origin, token, body(id), ShareBody.boundary(id)));
            if (access.pending(origin)) { task.call.cancel(); return; }
            live.put(id, task);
        }
        ShareTargets.Response result;
        try { result = task.call.execute(); }
        catch (Exception failed) { result = new ShareTargets.Response(0, null); }
        try { completed(id, origin, result.status, result.body); }
        finally { synchronized (ShareFiles.LOCK) { if (live.get(id) == task) live.remove(id); } }
        if (ShareOutcome.read(result.status, result.body) == ShareOutcome.TARGET_GONE) targets.refresh(origin, clock.getAsLong());
    }
    /** Live tasks survive another foreground; vanished tasks are recreated from the same durable id/body. */
    public void foreground(Function<String, WorkspaceOrigin> origins) throws IOException {
        sweep();
        for (JSONObject row : entries()) {
            WorkspaceOrigin origin = origins.apply(row.optString("workspace"));
            if (origin != null && "queued".equals(row.optString("state"))) send(row.optString("shareId"), origin);
        }
    }
    public void markRemoved(WorkspaceOrigin origin, String code) throws IOException {
        synchronized (ShareFiles.LOCK) {
            for (Iterator<Map.Entry<String, Live>> it = live.entrySet().iterator(); it.hasNext();) {
                Live task = it.next().getValue();
                if (task.origin.equals(origin)) { task.call.cancel(); it.remove(); }
            }
            for (JSONObject row : entries()) if (ShareFiles.workspace(origin).equals(row.optString("workspace")) && !"sent".equals(row.optString("state"))) {
                try {
                    row.put("state", "failed").put("updatedAt", clock.getAsLong()); row.remove("nextAttemptAt");
                    if (!"revoked".equals(row.optString("code"))) row.put("code", code);
                    terminal(row, true);
                } catch (JSONException e) { throw new IOException(e); }
            }
        }
    }
    public void sweep() throws IOException {
        synchronized (ShareFiles.LOCK) {
            long now = clock.getAsLong();
            for (JSONObject row : entries()) {
                String id = row.optString("shareId"), state = row.optString("state");
                long age = now - row.optLong("updatedAt", row.optLong("createdAt"));
                try {
                    if (state.equals("sent") && age >= DAY || !state.equals("queued") && !state.equals("sent") && age >= WEEK) {
                        ShareFiles.delete(ShareFiles.folder(root, id)); dropFailure(id);
                    } else if (!state.equals("sent") && now - row.optLong("createdAt") >= WEEK && (state.equals("queued") || body(id).exists())) {
                        Live task = live.remove(id); if (task != null) task.call.cancel();
                        row.put("state", "failed").put("code", "expired").put("updatedAt", now); row.remove("nextAttemptAt");
                        terminal(row, true);
                    } else if (!state.equals("queued")) {
                        save(row);
                        if (state.equals("sent") || Arrays.asList("removed", "revoked", "too_large", "unsupported_type", "invalid", "expired").contains(row.optString("code"))) deletePayload(id);
                    }
                } catch (JSONException e) { throw new IOException(e); }
            }
            // Unpublished copies from a killed activity carry no queued state and are never sent.
            File[] folders = new File(root, "outbox").listFiles();
            if (folders != null) for (File folder : folders) if (folder.isDirectory()
                && !new File(folder, "state.json").exists() && now - folder.lastModified() >= WEEK) ShareFiles.delete(folder);
        }
    }
    public JSONObject resend(String id, WorkspaceOrigin origin, String bot, String thread) throws IOException {
        synchronized (ShareFiles.LOCK) {
            JSONObject old = state(id); long now = clock.getAsLong();
            if (!("failed".equals(old.optString("state")) || "needsTarget".equals(old.optString("state")))
                || !ShareFiles.workspace(origin).equals(old.optString("workspace")) || now - old.optLong("createdAt") >= WEEK
                || access.current(origin) == null || access.pending(origin)) throw new IOException("retry unavailable");
            JSONObject next = ShareBody.resend(root, old, origin, bot, thread, now, () -> access.current(origin) != null);
            dropFailure(id); ShareFiles.delete(ShareFiles.folder(root, id)); return next;
        }
    }
    public static String messageKey(JSONObject row, boolean hasBody) {
        if ("failed".equals(row.optString("state")) || "needsTarget".equals(row.optString("state"))) {
            if ("revoked".equals(row.optString("code"))) return "share_again";
            if ("update".equals(row.optString("code"))) return "share_update";
            if (!hasBody) return "share_outbox_couldnt_send";
        }
        switch (row.optString("state")) {
            case "queued": return "share_outbox_waiting";
            case "sent": return "share_outbox_sent";
            case "needsTarget": return "share_outbox_target";
            default:
                if ("revoked".equals(row.optString("code"))) return "share_again";
                if ("update".equals(row.optString("code"))) return "share_update";
                return "share_outbox_failed";
        }
    }
}
