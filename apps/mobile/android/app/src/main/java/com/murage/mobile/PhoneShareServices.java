package com.murage.mobile;

import android.content.Context;
import com.murage.mobile.shell.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;
import org.json.JSONObject;

/** Process-owned sends continue after a sheet closes. Relaunch reads only private native files. */
final class PhoneShareServices {
    private static volatile PhoneShareServices instance;
    static PhoneShareServices get(Context context) {
        synchronized (ShareFiles.LOCK) {
            if (instance == null) instance = new PhoneShareServices(context.getApplicationContext());
            return instance;
        }
    }
    final Context app;
    final File root;
    final ShareAccess access;
    final ShareTargets targets;
    final ShareOutbox outbox;
    final ExecutorService io = Executors.newFixedThreadPool(3);
    final java.util.concurrent.CopyOnWriteArrayList<java.util.function.Consumer<WorkspaceOrigin>> removalListeners = new java.util.concurrent.CopyOnWriteArrayList<>();
    final java.util.concurrent.CopyOnWriteArrayList<Runnable> changeListeners = new java.util.concurrent.CopyOnWriteArrayList<>();
    private void changed() { for (Runnable listener : changeListeners) listener.run(); }
    private final ScheduledExecutorService retries = Executors.newSingleThreadScheduledExecutor();
    private final Map<String, ScheduledFuture<?>> scheduled = new HashMap<>();
    private final Map<String, Long> generations = new HashMap<>();
    long generation(WorkspaceOrigin origin) { synchronized (ShareFiles.LOCK) { return generations.getOrDefault(origin.serialized(), 0L); } }
    private boolean foregroundRunning;
    private PhoneShareServices(Context app) {
        this.app = app; root = app.getFilesDir();
        PhoneAskTokenStore tokens = new PhoneAskTokenStore(app);
        access = new ShareAccess() {
            public boolean pending(WorkspaceOrigin origin) { return PhoneAskSetup.removalPending(app, origin); }
            public String token(WorkspaceOrigin origin) { return tokens.readForShareOrOutbox(origin); }
            public void removeShortcuts(WorkspaceOrigin origin) { PhoneAskSetup.removeShortcuts(app, origin); }
            public boolean forget(WorkspaceOrigin origin, String code) { return PhoneAskSetup.forget(app, origin, code); }
        };
        PhoneShareHTTP http = new PhoneShareHTTP();
        targets = new ShareTargets(root, access, http, origin -> PhoneAskSetup.refreshShortcuts(app));
        outbox = new ShareOutbox(root, access, http, targets, System::currentTimeMillis);
    }
    WorkspaceBook book() {
        SecureStore.Read read = new SecureStore(app).read();
        return read.state == SecureStore.Read.State.UNREADABLE ? null : WorkspaceBook.decode(read.bytes);
    }
    List<WorkspaceBook.Entry> computers() {
        WorkspaceBook book = book(); List<WorkspaceBook.Entry> result = new ArrayList<>();
        if (book != null) for (WorkspaceBook.Entry entry : book.sorted()) {
            WorkspaceOrigin origin = WorkspaceOrigin.parse(entry.origin);
            synchronized (ShareFiles.LOCK) { if (!access.pending(origin)) result.add(entry); }
        }
        return result;
    }
    WorkspaceOrigin origin(String workspace) {
        for (WorkspaceBook.Entry entry : computers()) {
            WorkspaceOrigin origin = WorkspaceOrigin.parse(entry.origin);
            if (ShareFiles.workspace(origin).equals(workspace)) return origin;
        }
        return null;
    }
    boolean cleanup(WorkspaceOrigin origin, String code) {
        synchronized (ShareFiles.LOCK) {
            generations.put(origin.serialized(), generation(origin) + 1);
            for (java.util.function.Consumer<WorkspaceOrigin> listener : removalListeners) listener.accept(origin);
            boolean complete = PhoneAskSetup.removeShortcuts(app, origin);
            try { targets.remove(origin); } catch (IOException failed) { complete = false; }
            // Cancellation still runs when deleting the cache or token failed.
            try { outbox.markRemoved(origin, code); } catch (IOException failed) { complete = false; }
            try {
                for (Iterator<Map.Entry<String, ScheduledFuture<?>>> it = scheduled.entrySet().iterator(); it.hasNext();) {
                    Map.Entry<String, ScheduledFuture<?>> task = it.next();
                    if (ShareFiles.workspace(origin).equals(outbox.state(task.getKey()).optString("workspace"))) { task.getValue().cancel(false); it.remove(); }
                }
            } catch (IOException failed) { complete = false; }
            changed(); return complete;
        }
    }
    void foreground() {
        synchronized (ShareFiles.LOCK) { if (foregroundRunning) return; foregroundRunning = true; }
        io.execute(() -> {
            try {
                PhoneAskSetup.retryRemovals(app);
                outbox.foreground(this::origin);
                schedule();
                for (WorkspaceBook.Entry entry : computers()) targets.foreground(WorkspaceOrigin.parse(entry.origin), System.currentTimeMillis());
            } catch (IOException ignored) { }
            finally { PhoneAskSetup.refreshShortcuts(app); synchronized (ShareFiles.LOCK) { foregroundRunning = false; } changed(); }
        });
    }
    void paired(WorkspaceOrigin origin) { io.execute(() -> targets.refresh(origin, System.currentTimeMillis())); }
    void send(String id, WorkspaceOrigin origin) throws IOException {
        try { outbox.sweep(); outbox.send(id, origin); schedule(); }
        finally { changed(); }
    }
    private void schedule() throws IOException {
        synchronized (ShareFiles.LOCK) {
            for (JSONObject row : outbox.entries()) {
                String id = row.optString("shareId");
                if (!"queued".equals(row.optString("state")) || !row.has("nextAttemptAt") || scheduled.containsKey(id)) continue;
                if (!outbox.body(id).isFile() || System.currentTimeMillis() - row.optLong("createdAt") >= ShareOutbox.WEEK) continue;
                WorkspaceOrigin origin = origin(row.optString("workspace"));
                if (origin == null || access.current(origin) == null) continue;
                long delay = Math.max(0, row.optLong("nextAttemptAt") - System.currentTimeMillis());
                scheduled.put(id, retries.schedule(() -> {
                    synchronized (ShareFiles.LOCK) { scheduled.remove(id); }
                    io.execute(() -> { try { send(id, origin); } catch (IOException ignored) { } });
                }, delay, TimeUnit.MILLISECONDS));
            }
        }
    }
    void remember(WorkspaceOrigin origin, String bot, String thread) {
        synchronized (ShareFiles.LOCK) {
            if (access.current(origin) == null) return;
            app.getSharedPreferences("phone_share_choices", Context.MODE_PRIVATE).edit()
                .putString("origin", origin.serialized()).putString(ShareFiles.workspace(origin) + ".bot", bot)
                .putString(ShareFiles.workspace(origin) + ".thread", thread).apply();
            PhoneAskSetup.refreshShortcuts(app);
        }
    }
}
