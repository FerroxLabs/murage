package com.murage.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.WebView;
import com.murage.mobile.shell.CloseReason;
import com.murage.mobile.shell.Json;
import com.murage.mobile.shell.LaunchPolicy;
import com.murage.mobile.shell.PairingLink;
import com.murage.mobile.shell.PendingOpen;
import com.murage.mobile.shell.ProbeVerdict;
import com.murage.mobile.shell.RouteMemory;
import com.murage.mobile.shell.TailscaleStatus;
import com.murage.mobile.shell.WorkspaceBook;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import java.util.function.Predicate;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Process-wide shell state: the saved computers, routes, the one live
 * workspace, closes. Twin of ShellCoordinator.swift (P17); P21's plugin is a
 * thin door onto {@link #snapshot}, {@link #open}, {@link #remove}. Failure
 * codes are the iOS ones: unreachable, insecure, unreadable, busy,
 * bad_origin, bad_credential, no_launcher.
 *
 * <p>Threading: Callers may be off the main thread (P21's plugin methods run
 * on Capacitor's plugin thread; P21 also posts them to main). The book, the
 * names, the pending close and the live workspace are guarded by this
 * object's lock; {@link #listener} is volatile. {@link #open} and
 * {@link #startWorkspace} and {@link #queueOpen} start or touch activities and
 * must be called on the main thread.
 */
final class Shell {
    static final String USER_AGENT_TOKEN = "MurageApp/" + BuildConfig.VERSION_NAME + " (android)";

    interface Listener {
        void closed(String origin, String reason);
    }

    /** The launcher's open(): exactly one of these is called, on the main thread. */
    interface OpenDone {
        void opened(ProbeVerdict verdict);

        void failed(String code);
    }

    private static Shell instance;

    static synchronized Shell get(Context context) {
        if (instance == null) instance = new Shell(context.getApplicationContext());
        return instance;
    }

    final RouteMemory routes;
    volatile boolean autoOpened;
    /** Set by P21's plugin; read under no lock, so volatile. */
    volatile Listener listener;
    private WorkspaceActivity live;
    private final Context app;
    private final SecureStore secure;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Map<String, String> names = new HashMap<>();
    private String[] pendingClose;
    /** Kept once read; a failed read is tried again next time (never cached as null). */
    private String installIdValue;
    /** One open at a time: the probe is awaited, and a second tap must not start twice. */
    private boolean opening;

    private Shell(Context app) {
        this.app = app;
        CacheSink.sweep(app); // once per process, before any save exists
        secure = new SecureStore(app);
        routes = new RouteMemory(new PrefsStore(app.getSharedPreferences("murage_routes", Context.MODE_PRIVATE)));
    }

    /** The install id, or null while it cannot be read (then nothing pairs). */
    synchronized String installId() {
        if (installIdValue == null) installIdValue = InstallId.get(app);
        return installIdValue;
    }

    /**
     * The saved computers, or null when the store is UNREADABLE (P18): never
     * an empty book, which a later save would write over the real one.
     */
    synchronized WorkspaceBook book() {
        SecureStore.Read read = secure.read();
        if (read.state == SecureStore.Read.State.UNREADABLE) return null;
        return WorkspaceBook.decode(read.bytes);
    }

    /** Reads, changes and saves the book; false (and nothing written) when it could not be read or saved. */
    private synchronized boolean update(Consumer<WorkspaceBook> change) {
        return updateIfChanged(book -> {
            change.accept(book);
            return true;
        });
    }

    /**
     * As {@link #update}, but a change that answers false (nothing changed)
     * is not saved; that still counts as done.
     */
    private synchronized boolean updateIfChanged(Predicate<WorkspaceBook> change) {
        WorkspaceBook book = book();
        if (book == null) {
            ShellLog.i("book not updated: unreadable");
            return false;
        }
        if (!change.test(book)) return true;
        if (secure.write(book.encode())) return true;
        ShellLog.i("book save failed");
        return false;
    }

    synchronized void rememberName(WorkspaceOrigin origin, String name) {
        if (name != null) names.put(origin.serialized(), name);
    }

    void signedIn(WorkspaceOrigin origin) {
        String name;
        synchronized (this) {
            name = names.get(origin.serialized());
        }
        long now = System.currentTimeMillis();
        if (!update(book -> book.signedIn(origin, name, now))) ShellLog.i("book not updated after sign-in");
    }

    /**
     * "Last connected" moves on while the computer is in use, not only when it
     * loads. The same read-then-write as every change: nothing is saved when
     * the book cannot be read, and a computer not on it is not added.
     */
    void inUse(WorkspaceOrigin origin) {
        long now = System.currentTimeMillis();
        if (!updateIfChanged(book -> book.touched(origin, now))) ShellLog.i("book not updated after use");
    }

    // ---- opening ----

    /**
     * The launcher's open: probe first, then show the workspace (spec §3.1
     * table). Main thread. A second call while one is in flight answers busy.
     */
    void open(Activity from, String originText, String credential, OpenDone done) {
        if (opening) {
            done.failed("busy");
            return;
        }
        // The launcher trims its input too (P22); a pasted newline is not a different origin.
        WorkspaceOrigin origin = WorkspaceOrigin.parseInput(originText);
        if (origin == null) {
            done.failed("bad_origin");
            return;
        }
        if (credential != null && !PairingLink.validCredential(credential)) {
            done.failed("bad_credential");
            return;
        }
        // Pairing adds the computer to the list, which must be readable to be written.
        if (credential != null && book() == null) {
            done.failed("unreadable");
            return;
        }
        opening = true;
        io.execute(() -> {
            ProbeVerdict verdict;
            try {
                verdict = ProbeClient.probe(origin, USER_AGENT_TOKEN); // Decision 4: probe first
            } catch (RuntimeException unexpected) {
                verdict = ProbeVerdict.classify(null, null, unexpected);
            }
            ProbeVerdict result = verdict;
            main.post(() -> {
                opening = false;
                finishOpen(from, origin, credential, result, done);
            });
        });
    }

    private void finishOpen(Activity from, WorkspaceOrigin origin, String credential, ProbeVerdict verdict, OpenDone done) {
        if (verdict.kind == ProbeVerdict.Kind.UNREACHABLE || verdict.kind == ProbeVerdict.Kind.INSECURE
                || verdict.kind == ProbeVerdict.Kind.ACCESSOFF || verdict.kind == ProbeVerdict.Kind.HOSTERROR) {
            done.failed(verdict.mode());
            return;
        }
        if (!verdict.hostCapabilityOk()) {
            done.opened(verdict);
            return;
        }
        rememberName(origin, verdict.name);
        // A full door records this phone by its install id: never pair it without one.
        if (credential != null && verdict.isFull() && installId() == null) {
            done.failed("unreadable");
            return;
        }
        String failure = startWorkspace(from, origin, credential, verdict.mode(), true, verdict.approvalProofOk());
        if (failure != null) done.failed(failure);
        else done.opened(verdict);
    }

    /**
     * Shows the workspace; null once it is on its way, else a failure code.
     * An older workspace still on screen closes properly (its saves are
     * cancelled) without telling the launcher.
     */
    String startWorkspace(Activity from, WorkspaceOrigin origin, String credential, String mode) {
        return startWorkspace(from, origin, credential, mode, false, false);
    }

    /** hostOk: the caller's probe passed hostCapabilityOk(), so the workspace may load without probing again. */
    String startWorkspace(Activity from, WorkspaceOrigin origin, String credential, String mode, boolean hostOk, boolean approvalProof) {
        if (from == null || from.isFinishing() || from.isDestroyed()) return "no_launcher";
        if (credential != null) {
            // The credential was checked in open(); only the install id can fail here.
            // WorkspaceActivity builds the same path with the id cached now.
            String id = null;
            if ("full".equals(mode)) {
                id = installId();
                if (id == null) return "unreadable";
            }
            if (PairingLink.enterPath(credential, id) == null) return "unreadable";
        }
        WorkspaceActivity old;
        synchronized (this) {
            old = live;
            live = null;
        }
        if (old != null) old.closeFromShell();
        Intent intent = new Intent(from, WorkspaceActivity.class)
            .putExtra(WorkspaceActivity.EXTRA_ORIGIN, origin.serialized())
            .putExtra(WorkspaceActivity.EXTRA_MODE, mode)
            .putExtra(WorkspaceActivity.EXTRA_HOST_OK, hostOk)
            .putExtra(WorkspaceActivity.EXTRA_APPROVAL_PROOF, approvalProof);
        if (credential != null) intent.putExtra(WorkspaceActivity.EXTRA_CREDENTIAL, credential);
        from.startActivity(intent);
        from.overridePendingTransition(0, 0);
        return null;
    }

    // ---- the live workspace ----

    synchronized WorkspaceActivity live() {
        return live;
    }

    synchronized void attach(WorkspaceActivity workspace) {
        live = workspace;
    }

    /** Only if it is still the live one; a replaced workspace leaves its successor alone. */
    synchronized void detach(WorkspaceActivity workspace) {
        if (live == workspace) live = null;
    }

    // ---- closing ----

    /** From the workspace that is closing; a replaced one (no longer live) says nothing. */
    synchronized void closed(WorkspaceActivity workspace, CloseReason reason) {
        if (live != workspace) return;
        live = null;
        WorkspaceOrigin origin = workspace.origin;
        if (reason == CloseReason.SIGN_OUT) forget(origin, workspace.webView());
        else if (reason == CloseReason.SIGNED_OUT) ApprovalKeys.remove(origin); // a 401 or re-pair takes the approval key, as on iOS
        Listener current = listener;
        if (current != null) current.closed(origin.serialized(), reason.wire);
        else pendingClose = new String[] {origin.serialized(), reason.wire};
    }

    synchronized String[] takePendingClose() {
        String[] close = pendingClose;
        pendingClose = null;
        return close;
    }

    synchronized boolean hasPendingClose() {
        return pendingClose != null;
    }

    /**
     * Signing out, or removing the computer: off the list, its routes gone,
     * and its session gone from the WebView (R4). The session is cleared even
     * when the list cannot be read. Returns false if the list could not be updated.
     */
    boolean forget(WorkspaceOrigin origin, WebView using) {
        boolean removed = update(book -> book.remove(origin));
        if (!removed) ShellLog.i("book not updated after forget");
        routes.forget(origin);
        PushServices.get(app).forget(origin);
        ApprovalKeys.remove(origin); // SEC-006: removing a computer takes its approval key
        if (Looper.myLooper() == Looper.getMainLooper()) clearSession(origin, using);
        else main.post(() -> clearSession(origin, null));
        return removed;
    }

    /**
     * R4: this host's cookies and the WebView HTTP cache. Cookies carry no
     * port, so a second computer on the same host (another port) loses its
     * cookies too; the door's session cookie has no Domain and one name on
     * every port, so nothing truly separate is lost. The cache is one per app
     * and is cleared whole; losing it costs only a reload. Main thread.
     */
    private void clearSession(WorkspaceOrigin origin, WebView using) {
        CookieManager cookies = CookieManager.getInstance();
        String url = origin.serialized() + "/";
        String header = cookies.getCookie(url);
        int cleared = 0;
        if (header != null) {
            for (String part : header.split(";")) {
                String name = part.trim().split("=", 2)[0];
                if (name.isEmpty()) continue;
                cookies.setCookie(url, name + "=; Max-Age=0; Path=/; Secure");
                cleared++;
            }
        }
        cookies.flush();
        ShellLog.i("session cookies cleared count=" + cleared);
        WebView view = using != null ? using : new WebView(app);
        view.clearCache(true);
        if (view != using) view.destroy();
        ShellLog.i("workspace cache cleared");
    }

    // ---- launcher requests ----

    /**
     * The launcher's state, or null when the saved list cannot be read (the
     * plugin rejects with unreadable; a pending close waits for a read that works).
     */
    JSONObject snapshot() {
        WorkspaceBook book = book();
        if (book == null) return null;
        JSONArray workspaces = new JSONArray();
        for (WorkspaceBook.Entry entry : book.sorted()) {
            JSONObject item = new JSONObject();
            Json.put(item, "origin", entry.origin);
            Json.put(item, "name", entry.name);
            Json.put(item, "lastConnected", entry.lastConnected);
            workspaces.put(item);
        }
        JSONObject state = new JSONObject();
        Json.put(state, "workspaces", workspaces);
        Json.put(state, "active", book.active() == null ? JSONObject.NULL : book.active());
        String[] closed = takePendingClose();
        if (closed == null) {
            Json.put(state, "closed", JSONObject.NULL);
        } else {
            JSONObject close = new JSONObject();
            Json.put(close, "origin", closed[0]);
            Json.put(close, "reason", closed[1]);
            Json.put(state, "closed", close);
        }
        Json.put(state, "platform", "android");
        Json.put(state, "tailscale", tailscale().wire());
        return state;
    }

    static final String TAILSCALE = "com.tailscale.ipn";

    /** Installed: the package (visible through the manifest's queries entry). Connected: a Tailscale address on an up interface. */
    private TailscaleStatus tailscale() {
        boolean installed;
        try {
            app.getPackageManager().getPackageInfo(TAILSCALE, 0);
            installed = true;
        } catch (PackageManager.NameNotFoundException missing) {
            installed = false;
        }
        return TailscaleStatus.android(installed, interfaceAddresses());
    }

    /** Every address on an interface that is up, as raw bytes; null when they cannot be read. Never logged. */
    private static List<byte[]> interfaceAddresses() {
        try {
            List<byte[]> addresses = new ArrayList<>();
            java.util.Enumeration<NetworkInterface> all = NetworkInterface.getNetworkInterfaces();
            if (all == null) return null; // none readable: unknown, not "off"
            for (NetworkInterface each : Collections.list(all)) {
                if (!each.isUp()) continue;
                for (InetAddress address : Collections.list(each.getInetAddresses())) addresses.add(address.getAddress());
            }
            return addresses;
        } catch (Exception unreadable) {
            return null;
        }
    }

    /** null when done (an origin that does not parse was never saved); unreadable when the list could not be updated. */
    String remove(String originText) {
        WorkspaceOrigin origin = WorkspaceOrigin.parseInput(originText);
        if (origin == null) return null;
        return forget(origin, null) ? null : "unreadable";
    }

    /**
     * Spec §3.5 "Tapping a notification": the binding chose the origin, never the
     * active computer. startWorkspace closes any other workspace first, so nothing
     * late from it lands here; the pending open is keyed by origin and survives a
     * re-pair. With no thread id (the detail never arrived) the workspace opens on
     * its last route, and the page's Inbox shows what is waiting. Main thread.
     */
    void openFromNotification(Activity from, WorkspaceOrigin origin, String threadId, String messageId) {
        PendingOpen open = threadId == null ? null : new PendingOpen(origin, threadId, messageId);
        if (open != null && !routes.setPending(open)) open = null; // a thread id the route cannot carry
        WorkspaceActivity current = live();
        if (current != null && current.origin.equals(origin)) {
            if (open != null) current.deliver(open);
            return;
        }
        // B6 (Astra B6): a different computer's notification must not end a
        // call in progress on screen -- startWorkspace closes any other
        // workspace first, which would tear down a live call. Hold it at
        // this boundary and deliver it once the call really ends or the
        // workspace closes for any other reason (deliverPendingCrossComputerOpen).
        WorkspaceOrigin currentOrigin = current == null ? null : current.origin;
        boolean currentHasCall = current != null && current.hasOpenCall();
        if (LaunchPolicy.mustHoldCrossComputerOpen(currentOrigin, currentHasCall, origin)) {
            ShellLog.i("notification open held: call in progress on another computer");
            setPendingCrossComputerOpen(new PendingCrossOpen(origin, threadId, messageId));
            return;
        }
        String failure = startWorkspace(from, origin, null, "unknown");
        if (failure != null) ShellLog.i("notification open failed code=" + failure);
    }

    /** A different computer's notification held by openFromNotification
     * because the live workspace had a call open (B6). */
    static final class PendingCrossOpen {
        final WorkspaceOrigin origin;
        final String threadId, messageId;
        final long heldAt = System.currentTimeMillis();
        PendingCrossOpen(WorkspaceOrigin origin, String threadId, String messageId) {
            this.origin = origin;
            this.threadId = threadId;
            this.messageId = messageId;
        }
    }

    private static final long HELD_OPEN_MAX_MS = 10 * 60_000L;
    private PendingCrossOpen pendingCrossComputerOpen;

    synchronized void setPendingCrossComputerOpen(PendingCrossOpen open) {
        pendingCrossComputerOpen = open;
    }

    synchronized PendingCrossOpen takePendingCrossComputerOpen() {
        PendingCrossOpen open = pendingCrossComputerOpen;
        pendingCrossComputerOpen = null;
        return open;
    }

    /** The call that made openFromNotification hold a different computer's
     * notification has ended, or the workspace holding it is gone for some
     * other reason (B6). Re-runs the same open now that nothing blocks it --
     * a no-op if nothing was held. Main thread. */
    void deliverPendingCrossComputerOpen(Activity from) {
        PendingCrossOpen open = takePendingCrossComputerOpen();
        // A tap held for long enough that the person has moved on is dropped,
        // not acted on later (B6 review M2).
        if (open != null && System.currentTimeMillis() - open.heldAt <= HELD_OPEN_MAX_MS) openFromNotification(from, open.origin, open.threadId, open.messageId);
    }

    /**
     * A notification tap PushOpenActivity hands to the launcher when no workspace is
     * live (the process died, or none is open). In memory only: the launcher is
     * exported, so it acts on what this process put here, never on an intent's extras
     * (A5 review Minor 2). A null origin is a removed computer.
     */
    static final class PushTap {
        final WorkspaceOrigin origin;
        final String threadId, messageId;
        PushTap(WorkspaceOrigin origin, String threadId, String messageId) { this.origin = origin; this.threadId = threadId; this.messageId = messageId; }
    }

    private PushTap pushTap;

    synchronized void handPushTap(PushTap tap) { pushTap = tap; }
    synchronized boolean hasPushTap() { return pushTap != null; }
    synchronized PushTap takePushTap() {
        PushTap tap = pushTap;
        pushTap = null;
        return tap;
    }

    // ---- notices for the launcher (L1 shows the words) ----

    private Consumer<String> noticeListener;
    private String pendingNotice;

    /** The launcher on screen listens; a notice sent while none is listening waits for the next one. */
    void onNotice(Consumer<String> listener) {
        String waiting;
        synchronized (this) {
            noticeListener = listener;
            waiting = pendingNotice;
            pendingNotice = null;
        }
        if (waiting != null) main.post(() -> listener.accept(waiting));
    }

    /** Only if it is still this listener: a newer launcher may already be listening. */
    synchronized void offNotice(Consumer<String> listener) {
        if (noticeListener == listener) noticeListener = null;
    }

    void showNotice(String code) {
        Consumer<String> listener;
        synchronized (this) {
            listener = noticeListener;
            if (listener == null) pendingNotice = code;
        }
        if (listener != null) main.post(() -> listener.accept(code));
    }

    /** A conversation to open: Plan 3's notification tap, or the debug extra (P21). */
    void queueOpen(Activity from, String threadId, String messageId) {
        WorkspaceBook book = book();
        WorkspaceOrigin active = book == null ? null : WorkspaceOrigin.parse(book.active());
        if (active == null) return;
        PendingOpen open = new PendingOpen(active, threadId, messageId);
        if (!routes.setPending(open)) return;
        WorkspaceActivity current = live();
        if (current != null) {
            if (current.origin.equals(active)) current.deliver(open);
        } else if (autoOpened) {
            startWorkspace(from, active, null, "unknown");
        }
    }
}
