package com.murage.mobile;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import com.murage.mobile.shell.NotificationPlan;
import com.murage.mobile.shell.PushContract;
import com.murage.mobile.shell.PushLedger;
import com.murage.mobile.shell.PushOutcome;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Predicate;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;

/**
 * Spec §3.5: data-only, so this runs even in the background; it builds the
 * notification itself, rewritten from the detail within 5 s or generic.
 * The respond token is never read here.
 *
 * The Task 0 spike (docs/mobile/phase0/FINDINGS.md) showed a high-priority
 * data message wakes a dead process in deep Doze and the fetch completes.
 * A force-stopped app is different: Android's stopped state holds every
 * message until the person opens the app again (docs/mobile/phase3/ANDROID-PUSH.md).
 */
public class MurageMessagingService extends FirebaseMessagingService {
    private static final ExecutorService FETCH = Executors.newCachedThreadPool();

    @Override public void onNewToken(String token) {
        PushRegistrar.get(this).tokenChanged(token);
    }

    @Override public void onMessageReceived(RemoteMessage message) {
        PushContract.Payload p = PushContract.Payload.fromFcmData(message.getData());
        if (p == null) return;
        deliver(PushServices.get(this).store, p,
            (origin, token) -> PushDetailFetch.fetch(FETCH, PushDetailFetch.door(origin, p.eventRef, token), PushDetailFetch.DEADLINE_MS, p.category),
            this::post, PushRegistrar.get(this)::isPending, System::currentTimeMillis, this::shownCalls);
    }

    interface Fetch { PushOutcome.Detail detail(String origin, String detailToken); }
    interface Poster { void post(PushContract.Payload p, PushOutcome.Detail detail, int total); }

    /**
     * The service's guards, apart from Android so JVM tests drive them: a stale
     * revision or a removed computer is dropped (B3) before any fetch; no origin or
     * no detail token means the generic text. The revision is recorded only once
     * the notification is up: a post that throws leaves it unseen, so FCM's
     * redelivery of the same revision still shows. Messages reach one service
     * thread in turn, so nothing records this key between the peek and the write.
     */
    static boolean deliver(PushStore store, PushContract.Payload p, Fetch fetch, Poster poster) {
        return deliver(store, p, fetch, poster, bindingId -> false);
    }

    /**
     * {@code pendingReplace}: a binding the host may already push to that this
     * phone has not committed yet (PushEnrolment.adopt). It is not in the ledger,
     * so it has no origin or detail token: remember its revision and show generic
     * text, as iOS shows for it, rather than the silent drop a removed computer gets.
     */
    static boolean deliver(PushStore store, PushContract.Payload p, Fetch fetch, Poster poster, Predicate<String> pendingReplace) {
        return deliver(store, p, fetch, poster, pendingReplace, System::currentTimeMillis);
    }

    static boolean deliver(PushStore store, PushContract.Payload p, Fetch fetch, Poster poster,
                           Predicate<String> pendingReplace, LongSupplier now) {
        return deliver(store, p, fetch, poster, pendingReplace, now, Collections::emptyList);
    }

    static boolean deliver(PushStore store, PushContract.Payload p, Fetch fetch, Poster poster,
                           Predicate<String> pendingReplace, LongSupplier now, Supplier<Collection<String>> shown) {
        PushLedger peek = store.ledger(); // a decoded copy: accepting on it saves nothing
        boolean pending = peek.origin(p.bindingId) == null && pendingReplace.test(p.bindingId);
        PushLedger.Accept verdict = peek.accept(p.bindingId, p.collapseKey, p.revision, p.workspaceBadge, pending);
        if (verdict != PushLedger.Accept.SHOW) return false;
        WorkspaceOrigin bound = PushStore.canonical(peek.origin(p.bindingId)); // the detail bearer goes only to a canonical origin
        String origin = bound == null ? null : bound.serialized();
        PushOutcome.Detail detail = PushDetailFetch.generic(p.category);
        String token = origin == null ? null : store.detail(p.bindingId);
        if (!quiet(p, now.getAsLong(), shown.get()) && PushContract.Features.RICH_TEXT && origin != null && token != null) detail = fetch.detail(origin, token);
        // Recheck after the fetch: expiry or a resolved revision may have arrived meanwhile.
        Integer latest = store.ledger().revision(p.collapseKey);
        if (latest != null && latest > p.revision) return false;
        if (p.category.isExpiring()) detail = detail.closed(p.category);
        if (quiet(p, now.getAsLong(), shown.get())) detail = PushDetailFetch.generic(p.category).withSilent(true);
        poster.post(p, detail, peek.total());
        store.updateLedger(l -> l.accept(p.bindingId, p.collapseKey, p.revision, p.workspaceBadge, pending));
        return true;
    }

    static boolean quiet(PushContract.Payload p, long now, Collection<String> shown) {
        String action = PushContract.callDisplayAction(p, now, shown);
        return "replace".equals(action) || "silent".equals(action);
    }

    /** Only call notifications posted at our tag/id participate in call replacement. */
    private Collection<String> shownCalls() {
        Collection<String> shown = new ArrayList<>();
        for (StatusBarNotification n : getSystemService(NotificationManager.class).getActiveNotifications()) {
            if (n.getId() == 1 && n.getTag() != null &&
                "call".equals(n.getNotification().extras.getString("murage.category"))) shown.add(n.getTag());
        }
        return shown;
    }

    private void post(PushContract.Payload p, PushOutcome.Detail detail, int total) {
        PushChannels.ensure(this);
        NotificationPlan.Plan plan = NotificationPlan.of(p.category, Build.VERSION.SDK_INT, PushContract.Features.LOCK_SCREEN_ACTIONS, detail.silent || quiet(p, System.currentTimeMillis(), shownCalls()));
        if (p.category.isExpiring()) detail = detail.closed(p.category);
        String title = p.category == PushContract.Category.CALL ? getString(R.string.push_call_title) : detail.title;
        String body = p.category == PushContract.Category.CALL ? getString(R.string.push_call_body) :
            p.category == PushContract.Category.CALL_NOTE ? getString(R.string.push_call_note_body) : detail.body;
        Intent tap = PushIntents.fill(PushIntents.tap(this), p, detail.target);
        // Extras are not part of a PendingIntent's identity; the identifier is (API 29, minSdk).
        // One per collapse key and action, so a live notification never takes another's extras.
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, plan.channel)
            .setSmallIcon(R.drawable.ic_stat_murage)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setGroup(p.threadGroup)
            .setNumber(total)
            .setAutoCancel(true)
            .setOnlyAlertOnce(plan.silent)
            .setSilent(plan.silent)
            .addExtras(PushIntents.fill(new Intent(), p, null).getExtras()) // the reconciler finds the binding here
            .setContentIntent(PendingIntent.getActivity(this, 0, new Intent(tap).setIdentifier(p.collapseKey + "/TAP"), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        for (String action : plan.actions) {
            if (action.equals("OPEN")) { b.addAction(0, "Open", PendingIntent.getActivity(this, 0, new Intent(tap).setIdentifier(p.collapseKey + "/" + action), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)); continue; }
            if (action.equals("ANSWER")) {
                Intent answer = CallAnswerRoute.intent(tap).setIdentifier(p.collapseKey + "/ANSWER");
                NotificationCompat.Action.Builder a = new NotificationCompat.Action.Builder(0, getString(R.string.push_call_answer),
                    PendingIntent.getActivity(this, 0, answer, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
                if (plan.authRequired && Build.VERSION.SDK_INT >= 31) a.setAuthenticationRequired(true);
                b.addAction(a.build());
                continue;
            }
            Intent intent = PushIntents.fill(new Intent(this, PushActionReceiver.class).setAction(action), p, detail.target).setIdentifier(p.collapseKey + "/" + action);
            PendingIntent pending = PendingIntent.getBroadcast(this, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            NotificationCompat.Action.Builder a = new NotificationCompat.Action.Builder(0, action.equals("NOT_NOW") ? getString(R.string.push_call_not_now) : action.equals("APPROVE") ? "Approve" : "Deny", pending);
            if (plan.authRequired && Build.VERSION.SDK_INT >= 31) a.setAuthenticationRequired(true);
            b.addAction(a.build());
        }
        // tag = collapse key, id 1: a newer revision of the same event replaces the old one in place.
        getSystemService(NotificationManager.class).notify(p.collapseKey, 1, b.build());
    }
}
