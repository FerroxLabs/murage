package com.murage.mobile;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
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
            this::post, PushRegistrar.get(this)::isPending);
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
     * so it has no origin, no detail token and no revision record: the generic
     * text, as iOS shows for it, rather than the silent drop a removed computer gets.
     */
    static boolean deliver(PushStore store, PushContract.Payload p, Fetch fetch, Poster poster, Predicate<String> pendingReplace) {
        PushLedger peek = store.ledger(); // a decoded copy: accepting on it saves nothing
        PushLedger.Accept verdict = peek.accept(p.bindingId, p.collapseKey, p.revision, p.workspaceBadge);
        if (verdict == PushLedger.Accept.UNKNOWN && pendingReplace.test(p.bindingId)) {
            poster.post(p, PushDetailFetch.generic(p.category), peek.total());
            return true;
        }
        if (verdict != PushLedger.Accept.SHOW) return false;
        WorkspaceOrigin bound = PushStore.canonical(peek.origin(p.bindingId)); // the detail bearer goes only to a canonical origin
        String origin = bound == null ? null : bound.serialized();
        PushOutcome.Detail detail = PushDetailFetch.generic(p.category);
        String token = store.detail(p.bindingId);
        if (PushContract.Features.RICH_TEXT && origin != null && token != null) detail = fetch.detail(origin, token);
        poster.post(p, detail, peek.total());
        store.updateLedger(l -> l.accept(p.bindingId, p.collapseKey, p.revision, p.workspaceBadge));
        return true;
    }

    private void post(PushContract.Payload p, PushOutcome.Detail detail, int total) {
        PushChannels.ensure(this);
        NotificationPlan.Plan plan = NotificationPlan.of(p.category, Build.VERSION.SDK_INT, PushContract.Features.LOCK_SCREEN_ACTIONS);
        Intent tap = PushIntents.fill(PushIntents.tap(this), p, detail.target);
        // Extras are not part of a PendingIntent's identity; the identifier is (API 29, minSdk).
        // One per collapse key and action, so a live notification never takes another's extras.
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, plan.channel)
            .setSmallIcon(R.drawable.ic_stat_murage)
            .setContentTitle(detail.title)
            .setContentText(detail.body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(detail.body))
            .setGroup(p.threadGroup)
            .setNumber(total)
            .setAutoCancel(true)
            .setOnlyAlertOnce(plan.silent)
            .setSilent(plan.silent)
            .addExtras(PushIntents.fill(new Intent(), p, null).getExtras()) // the reconciler finds the binding here
            .setContentIntent(PendingIntent.getActivity(this, 0, new Intent(tap).setIdentifier(p.collapseKey + "/TAP"), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        for (String action : plan.actions) {
            if (action.equals("OPEN")) { b.addAction(0, "Open", PendingIntent.getActivity(this, 0, new Intent(tap).setIdentifier(p.collapseKey + "/" + action), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)); continue; }
            Intent intent = PushIntents.fill(new Intent(this, PushActionReceiver.class).setAction(action), p, detail.target).setIdentifier(p.collapseKey + "/" + action);
            PendingIntent pending = PendingIntent.getBroadcast(this, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            NotificationCompat.Action.Builder a = new NotificationCompat.Action.Builder(0, action.equals("APPROVE") ? "Approve" : "Deny", pending);
            if (plan.authRequired) a.setAuthenticationRequired(true);
            b.addAction(a.build());
        }
        // tag = collapse key, id 1: a newer revision of the same event replaces the old one in place.
        getSystemService(NotificationManager.class).notify(p.collapseKey, 1, b.build());
    }
}
