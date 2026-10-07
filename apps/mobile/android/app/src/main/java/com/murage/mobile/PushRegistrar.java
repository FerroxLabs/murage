package com.murage.mobile;

import android.app.NotificationManager;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import com.google.android.gms.tasks.Tasks;
import com.google.android.play.core.integrity.IntegrityManagerFactory;
import com.google.android.play.core.integrity.IntegrityTokenRequest;
import com.google.firebase.FirebaseApp;
import com.google.firebase.installations.FirebaseInstallations;
import com.google.firebase.messaging.FirebaseMessaging;
import com.murage.mobile.shell.PushRefreshPolicy;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import org.json.JSONObject;

/**
 * Spec §3.5 "Enrolment", Android: the FCM token, one Play Integrity
 * registration per install, and a relay binding per workspace. The relay work
 * itself is PushEnrolment; this adds Firebase, Play and the threads. The
 * device secret, grants and push tokens are never logged.
 */
final class PushRegistrar {
    private static PushRegistrar instance;
    static synchronized PushRegistrar get(Context c) {
        if (instance == null) instance = new PushRegistrar(c.getApplicationContext());
        return instance;
    }

    private final Context app;
    /** One thread: registrations, token updates and relay deletes never overlap. */
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicBoolean drainQueued = new AtomicBoolean();
    private PushRegistrar(Context app) { this.app = app; }

    private PushStore store() { return PushServices.get(app).store; }
    /** Replaces waiting for the host (PushEnrolment.adopt), shared by every enrolment made here. */
    private final Map<String, String[]> pending = new ConcurrentHashMap<>();
    private PushEnrolment enrolment() { return new PushEnrolment(RelayClient::call, store(), RelayClient.ENVIRONMENT, pending); }

    /** Without google-services.json the app builds with push off (A1): nothing to register with. */
    private boolean firebaseReady() { return !FirebaseApp.getApps(app).isEmpty(); }

    private String fcmToken() throws Exception {
        return Tasks.await(FirebaseMessaging.getInstance().getToken(), 10, TimeUnit.SECONDS);
    }

    /** Classic Play Integrity: the relay's challenge is the nonce (base64url, 43 characters). */
    static String integrityToken(Context app, String nonce) throws Exception {
        IntegrityTokenRequest.Builder request = IntegrityTokenRequest.builder().setNonce(nonce);
        if (BuildConfig.PLAY_CLOUD_PROJECT_NUMBER != 0) request.setCloudProjectNumber(BuildConfig.PLAY_CLOUD_PROJECT_NUMBER);
        return Tasks.await(IntegrityManagerFactory.create(app).requestIntegrityToken(request.build()), 20, TimeUnit.SECONDS).token();
    }

    /** registerPush calls in flight, by origin and fresh: a second one joins the first rather than registering twice. */
    private final SingleFlight<JSONObject> inFlight = new SingleFlight<>(io, main::post);

    /**
     * Runs on the registrar's thread and answers on the main thread: a result
     * object, or null for "unavailable". One thread means two registrations never
     * overlap (so an install attests once); a call for a workspace that is already
     * registering (a page reloaded mid-way) waits for that one's answer.
     */
    void register(WorkspaceOrigin origin, boolean fresh, Consumer<JSONObject> done) {
        inFlight.run(origin.serialized() + (fresh ? " fresh" : ""), done, () -> {
            try {
                boolean granted = app.getSystemService(NotificationManager.class).areNotificationsEnabled();
                PushEnrolment enrolment = enrolment();
                JSONObject result = enrolment.register(origin.serialized(), granted, fresh, firebaseReady(), this::fcmToken, n -> integrityToken(app, n));
                // Every open: the relay learns a token FCM rotated while it could not be told.
                if (result != null && "enrolled".equals(result.optString("status"))) io.execute(this::checkToken);
                return result;
            } catch (Exception failed) {
                ShellLog.i("push register failed error=" + failed.getClass().getSimpleName());
                return null;
            }
        });
    }

    /**
     * PushServices.issue, before the tokens are stored: a pending replace the host
     * just took retires the old binding (PushServices.forget, so its relay delete
     * is queued) and moves the ledger. On the caller's thread: the store is
     * synchronized, and the relay delete itself runs on the registrar's thread.
     */
    void adopt(WorkspaceOrigin origin, String bindingId) {
        enrolment().adopt(origin.serialized(), bindingId, () -> PushServices.get(app).forget(origin));
    }

    /** PushServices.forget. */
    void cancelPending(WorkspaceOrigin origin) { enrolment().cancelPending(origin.serialized()); }

    /** MurageMessagingService: a pending replace's binding shows the generic text. */
    boolean isPending(String bindingId) { return enrolment().isPending(bindingId); }

    private void checkToken() {
        try { enrolment().tokenChanged(fcmToken()); } catch (Exception failed) { ShellLog.i("push token check failed error=" + failed.getClass().getSimpleName()); }
    }

    /**
     * Every time the app comes to the front (WorkspaceActivity and MainActivity
     * onResume): refreshes the relay registration at most once every 24 hours, so
     * a quiet pairing is not swept as idle. Queued on the registrar's thread, off
     * the main thread, best effort.
     */
    void refreshIfDue() {
        if (!firebaseReady()) return;
        io.execute(() -> enrolment().refreshIfDue(
            new PushRefreshPolicy(new PrefsStore(app.getSharedPreferences("murage_push", Context.MODE_PRIVATE))), System.currentTimeMillis(), this::fcmToken));
    }

    /** MurageMessagingService.onNewToken. */
    void tokenChanged(String token) {
        io.execute(() -> enrolment().tokenChanged(token));
    }

    /**
     * PushServices.unbound: a binding the phone dropped goes at the relay too.
     * Recorded first, so an unreachable relay is retried on the next open;
     * repeating a delete is harmless (PushEnrolment.deleteBinding).
     */
    void deleteAtRelay(String bindingId) {
        store().addRelayDelete(bindingId);
        retryDeletes();
    }

    /**
     * Data minimisation: once the last computer is gone, FCM's token and this
     * install's Firebase id go too. Queued behind the relay deletes on the same
     * thread, best effort, and it never blocks the sign-out or removal.
     */
    void releaseDeviceIfLast() {
        io.execute(() -> {
            if (store().hasBindings()) return;
            if (!firebaseReady()) return;
            DeviceRelease.run(
                () -> Tasks.await(FirebaseMessaging.getInstance().deleteToken(), 10, TimeUnit.SECONDS),
                () -> Tasks.await(FirebaseInstallations.getInstance().delete(), 10, TimeUnit.SECONDS));
        });
    }

    /** Every open (PushServices.sweep): the deletes still owed, one drain at a time. */
    void retryDeletes() {
        if (!drainQueued.compareAndSet(false, true)) return;
        io.execute(() -> {
            drainQueued.set(false);
            enrolment().drainDeletes();
        });
    }
}
