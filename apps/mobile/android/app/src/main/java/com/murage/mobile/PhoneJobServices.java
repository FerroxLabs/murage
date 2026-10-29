package com.murage.mobile;

import android.app.Activity;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import androidx.appcompat.app.AlertDialog;
import com.murage.mobile.shell.PhoneJobsContract;
import com.murage.mobile.shell.WorkspaceBook;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

/** Native process singleton, never instantiated by the notification receiver or WebView. */
final class PhoneJobServices {
    private static PhoneJobServices instance;
    static synchronized PhoneJobServices get(Context context) {
        if (instance == null) instance = new PhoneJobServices(context.getApplicationContext());
        return instance;
    }
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService serial = java.util.concurrent.Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService timer = java.util.concurrent.Executors.newSingleThreadScheduledExecutor();
    private final PhoneConsentStore store;
    private final PhoneJobsTokenStore tokens;
    private final Map<Activity, PhonePermissions> permissions = new WeakHashMap<>();
    private final Set<Activity> visible = Collections.newSetFromMap(new IdentityHashMap<>());
    private final NativeCards cards = new NativeCards();
    private final PhoneJobHTTP http = new PhoneJobHTTP();
    final PhoneJobRunner runner;
    private final Map<WorkspaceOrigin, PhoneOperationLedger.PrivateStorage> ledgers = new HashMap<>();
    private final PhoneJobsCleanup cleanup;

    private PhoneJobServices(Context context) {
        this.context = context; store = new PhoneConsentStore(context); tokens = new PhoneJobsTokenStore(context);
        cleanup = new PhoneJobsCleanup(new PhoneJobsCleanup.State() {
            public String token(WorkspaceOrigin w) { return tokens.readForRunner(w); }
            public void removeToken(WorkspaceOrigin w) throws Exception { if (!tokens.remove(w)) throw new java.io.IOException(); }
            public void removeConsent(WorkspaceOrigin w) throws Exception { if (!store.remove(w)) throw new java.io.IOException(); }
            public void clearLedger(WorkspaceOrigin w) throws Exception {
                synchronized (ledgers) {
                    PhoneOperationLedger.PrivateStorage storage = ledgers.remove(w);
                    if (storage == null) storage = new PhoneOperationLedger.PrivateStorage(context, w);
                    storage.clear();
                }
            }
        }, http);
        runner = new PhoneJobRunner(serial, new PhoneJobRunner.Environment() {
            @Override public String token(WorkspaceOrigin w) { return ui(() -> tokens.readForRunner(w), null); }
            @Override public boolean enabled(WorkspaceOrigin w) { return ui(() -> store.read(w).enabled, false); }
            @Override public boolean needsProvider(WorkspaceOrigin w, String p) { return ui(() -> store.needsProviderSheet(w, p), true); }
            @Override public boolean recordProvider(WorkspaceOrigin w, String p) { return ui(() -> { store.recordProviderConsent(w, p); return true; }, false); }
            @Override public boolean consent(WorkspaceOrigin w, PhoneJobsContract.Offer offer) { return ui(() -> {
                return store.readForCommit(w, offer.provider.id, offer.capability);
            }, false); }
            @Override public boolean permission(PhoneJobsContract.Offer offer) { return ui(() -> {
                PhonePermissions p = currentPermissions(); if (p == null) return false;
                Object value = p.value(offer.capability); if (value == null) return false;
                if ("calendar".equals(offer.capability) && !"calendar.add".equals(offer.action)) return "full".equals(value);
                return true;
            }, false); }
            @Override public boolean preciseConsent(WorkspaceOrigin w) { return ui(() -> store.read(w).rows.contains("precise"), false); }
            @Override public void turnOff(WorkspaceOrigin w) { ui(() -> {
                tokens.remove(w); PhoneForBotsModel.Consent c = store.read(w); c.enabled = false; store.write(w, c);
                for (Activity activity : visible) if (activity instanceof WorkspaceActivity) ((WorkspaceActivity) activity).phoneJobsStateChanged();
                return true;
            }, false); }
        }, cards, scopedExecutors(), http,
        new PhoneJobRunner.Clock() {
            @Override public long now() { return System.currentTimeMillis(); }
            @Override public PhoneJobRunner.Cancel after(long ms, Runnable task) {
                ScheduledFuture<?> future = timer.schedule(task, ms, TimeUnit.MILLISECONDS); return () -> future.cancel(false);
            }
        });
    }
    void forget(WorkspaceOrigin workspace) {
        runner.forget(workspace);
        cleanup.forget(workspace);
    }
    private PhoneJobRunner.Executors scopedExecutors() {
        return new PhoneJobRunner.Executors() {
            volatile NativePhoneJobExecutors active;
            public void cancel() { if (active != null) active.cancel(); }
            public void run(String id, String capability, String action, PhoneJobsContract.Args args, boolean precise, PhoneJobRunner.Cancellation cancellation, Consumer<PhoneJobRunner.Execution> done) { done.accept(PhoneJobRunner.Execution.error("denied")); }
            public void run(WorkspaceOrigin w, String id, String capability, String action, PhoneJobsContract.Args args, boolean precise, PhoneJobRunner.Cancellation cancellation, Consumer<PhoneJobRunner.Execution> done) {
                active = nativeExecutors(w);
                active.run(id, capability, action, args, precise, cancellation, result -> { active = null; done.accept(result); });
            }
        };
    }
    private NativePhoneJobExecutors nativeExecutors(WorkspaceOrigin workspace) {
        PhoneOperationLedger.PrivateStorage storage;
        synchronized (ledgers) {
            storage = ledgers.get(workspace);
            if (storage == null) { storage = new PhoneOperationLedger.PrivateStorage(context, workspace); ledgers.put(workspace, storage); }
        }
        PhoneOperationLedger ledger = new PhoneOperationLedger(storage, System::currentTimeMillis);
        PhoneSystemIntents intents = new PhoneIntentLauncher(cards::executionHost, operation -> ui(operation, false));
        Map<String, PhoneExecutorSupport.Module> modules = new HashMap<>();
        modules.put("calendar", new PhoneCalendarExecutor(new PhoneCalendarProvider(context), ledger));
        modules.put("reminders", new PhoneRemindersExecutor());
        modules.put("contacts", new PhoneContactsExecutor(new PhoneContactsProvider(context)));
        modules.put("location", new PhoneLocationExecutor(new PhoneLocationProvider(context)));
        modules.put("alarms", new PhoneAlarmsExecutor(intents, ledger));
        modules.put("messages", new PhoneMessagesExecutor(intents));
        modules.put("calls", new PhoneCallsExecutor(intents));
        return new NativePhoneJobExecutors(modules);
    }
    // The actor never blocks the UI; durable consent and N3's UI-owned permissions are read on main.
    private <T> T ui(Callable<T> work, T fallback) {
        try {
            if (Looper.myLooper() == Looper.getMainLooper()) return work.call();
            FutureTask<T> task = new FutureTask<>(work); main.post(task); return task.get();
        } catch (Exception error) { return fallback; }
    }
    void attach(Activity activity, PhonePermissions p) { permissions.put(activity, p); }
    private PhonePermissions currentPermissions() {
        for (Activity activity : visible) { PhonePermissions p = permissions.get(activity); if (p != null) return p; }
        return null;
    }
    void resumed(Activity activity) {
        visible.add(activity);
        if (cards.host() == null) return;
        Set<WorkspaceOrigin> origins = new HashSet<>();
        WorkspaceBook book = Shell.get(context).book();
        if (book != null) for (WorkspaceBook.Entry entry : book.sorted()) {
            WorkspaceOrigin w = WorkspaceOrigin.parse(entry.origin); if (w != null) origins.add(w);
        }
        runner.start(origins, true);
    }
    void stopped(Activity activity) {
        visible.remove(activity);
        WorkspaceActivity next = cards.host();
        if (next == null || cards.owner == activity) {
            cards.dismissAll(); runner.stop();
            if (next != null) resumed(next);
        }
    }
    void registration(WorkspaceOrigin workspace, String method, String token, org.json.JSONObject body, PhoneForBotsModel.Done done) {
        runner.registration(workspace, method, token, body,
            status -> main.post(() -> done.finish(status == 200 ? null : new java.io.IOException())));
    }
    private int enabledWorkspaceCount() {
        WorkspaceBook book = Shell.get(context).book();
        int count = 0;
        if (book != null) for (WorkspaceBook.Entry entry : book.sorted()) {
            WorkspaceOrigin w = WorkspaceOrigin.parse(entry.origin);
            try { if (w != null && store.read(w).enabled) count++; }
            catch (Exception unreadable) { /* Unreadable consent cannot enable a workspace. */ }
        }
        return count;
    }
    private final class NativeCards implements PhoneJobRunner.Cards {
        private AlertDialog providerSheet;
        private WorkspaceActivity owner;
        private WorkspaceOrigin workspace;
        private String operationId;
        private PhoneJobCardModel model;
        private final java.util.concurrent.atomic.AtomicLong epoch = new java.util.concurrent.atomic.AtomicLong();
        private WorkspaceActivity host() {
            for (Activity a : visible) if (a instanceof WorkspaceActivity && !a.isFinishing() && !a.isDestroyed()) return (WorkspaceActivity) a;
            return null;
        }
        private WorkspaceActivity host(WorkspaceOrigin w) {
            for (Activity a : visible) if (a instanceof WorkspaceActivity && !a.isFinishing() && !a.isDestroyed()
                    && PhoneJobCardModel.matches(w, ((WorkspaceActivity) a).origin)) return (WorkspaceActivity) a;
            return null;
        }
        private WorkspaceActivity executionHost() {
            return owner != null && visible.contains(owner) && !owner.isFinishing() && !owner.isDestroyed()
                && PhoneJobCardModel.matches(workspace, owner.origin) ? owner : null;
        }
        private boolean offscreen(WorkspaceOrigin w) { return host(w) == null; }
        // Background dismissal also fences work already queued from the serial runner.
        private void post(Runnable action) {
            long generation = epoch.get();
            main.post(() -> { if (generation == epoch.get()) action.run(); });
        }
        private void post(Runnable action, Runnable failed) {
            long generation = epoch.get();
            main.post(() -> { if (generation == epoch.get()) action.run(); else failed.run(); });
        }
        @Override public boolean canPresent(WorkspaceOrigin w) { return ui(() -> host(w) != null, false); }
        @Override public void show(WorkspaceOrigin w, PhoneJobsContract.Offer offer, Consumer<Boolean> answer) {
            post(() -> display(w, offer.operationId, new PhoneJobCardModel(offer, enabledWorkspaceCount(), offscreen(w), answer)));
        }
        @Override public void show(WorkspaceOrigin w, PhoneJobsContract.Offer offer, PhoneJobsContract.Args args, Consumer<Boolean> answer, Runnable failed) {
            String title = null;
            try {
                if (args instanceof PhoneJobsContract.CalendarChangeArgs) title = new PhoneCalendarProvider(context).title(((PhoneJobsContract.CalendarChangeArgs) args).id);
                // Android has no reminders provider; never approve an unidentified existing item.
                if (args instanceof PhoneJobsContract.RemindersCompleteArgs) { failed.run(); return; }
            } catch (Exception unavailable) { failed.run(); return; }
            String currentTitle = title;
            post(() -> {
                try {
                    if (!display(w, offer.operationId, new PhoneJobCardModel(offer, args, currentTitle, enabledWorkspaceCount(), answer))) failed.run();
                } catch (RuntimeException unavailable) { clear(); failed.run(); }
            }, failed);
        }
        @Override public void showProvider(WorkspaceOrigin w, PhoneJobsContract.NamedParty provider, String workspaceName, Consumer<Boolean> answer) {
            showProvider(w, provider, workspaceName, answer, () -> {});
        }
        @Override public void showProvider(WorkspaceOrigin w, PhoneJobsContract.NamedParty provider, String workspaceName, Consumer<Boolean> answer, Runnable failed) {
            post(() -> {
                WorkspaceActivity activity = host(w); if (activity == null) { failed.run(); return; }
                clear(); owner = activity; workspace = w;
                PhoneJobCardModel gate = new PhoneJobCardModel("", "", "", "", 1, answer); model = gate;
                try { providerSheet = PhoneDataSharingSheet.show(activity, provider.name, workspaceName, allow -> {
                    if (model != gate) return;
                    providerSheet = null; model = null; workspace = null; owner = null;
                    gate.choose(allow); gate.dismiss();
                }); } catch (RuntimeException unavailable) { clear(); failed.run(); }
            }, failed);
        }
        @Override public void used(WorkspaceOrigin w, PhoneJobsContract.Offer offer, Runnable closed) {
            post(() -> {
                PhoneJobCardModel next = new PhoneJobCardModel(offer, enabledWorkspaceCount(), offscreen(w), ignored -> {});
                next.complete(closed);
                if (!display(w, offer.operationId, next)) closed.run();
            });
        }
        @Override public void alreadyHandled(WorkspaceOrigin w, String operation, Runnable closed) {
            post(() -> {
                PhoneJobCardModel next = new PhoneJobCardModel("", "", "", "", 1, ignored -> {});
                next.alreadyHandled(closed);
                if (!display(w, operation, next)) closed.run();
            });
        }
        private boolean display(WorkspaceOrigin w, String operation, PhoneJobCardModel next) {
            WorkspaceActivity activity = host(w);
            if (activity == null) { next.dismiss(); return false; }
            if (owner != activity || providerSheet != null) clear();
            if (model != null) model.dismiss();
            owner = activity; model = next; workspace = w; operationId = operation;
            activity.showPhoneJobCard(next);
            return true;
        }
        @Override public void dismiss(WorkspaceOrigin w, String operation) {
            post(() -> { if (w.equals(workspace) && (operation == null || operationId == null || operation.equals(operationId))) clear(); });
        }
        void dismissAll() { epoch.incrementAndGet(); clear(); }
        private void clear() {
            if (model != null) model.dismiss();
            if (providerSheet != null) providerSheet.dismiss();
            if (owner != null) owner.dismissPhoneJobCard();
            providerSheet = null; owner = null; model = null; workspace = null; operationId = null;
        }
    }
}
