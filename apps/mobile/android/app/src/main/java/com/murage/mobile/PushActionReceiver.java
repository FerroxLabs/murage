package com.murage.mobile;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;
import androidx.core.app.NotificationCompat;
import com.murage.mobile.shell.PushContract;
import com.murage.mobile.shell.PushOutcome;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * Spec §3.5 actions: Approve or Deny, answered first-wins by the host; §7: a
 * local notice replaces the notification whatever happens, "Couldn't reach
 * your Murage" when the host is out of reach. setAuthenticationRequired (A3)
 * means this runs after an unlock, so the respond token is readable; if it
 * still is not, the notice says to open the app. Android 12 and later do not
 * let a receiver started from a notification open an activity, so "open the
 * app" (step-up, anything unclear) is the notice, and its tap opens the chat.
 */
public class PushActionReceiver extends BroadcastReceiver {
    /** One thread: two taps answer in turn, never at once. */
    private static final ExecutorService WORK = Executors.newSingleThreadExecutor();
    static final int DETAIL_MS = 5000, RESPOND_MS = 10_000;

    @Override public void onReceive(Context context, Intent intent) {
        PendingResult async = goAsync();
        Context app = context.getApplicationContext();
        WORK.execute(() -> {
            try {
                Result result;
                try {
                    result = answer(PushServices.get(app).store, PushHttp::call, Action.of(intent));
                } catch (RuntimeException unexpected) {
                    ShellLog.i("push action failed error=" + unexpected.getClass().getSimpleName());
                    result = new Result(PushOutcome.Notice.OPEN_APP, null);
                }
                // A5 review Minor 8: an OEM notify that throws must not kill the app from the lock screen.
                try {
                    if (result.removed) removed(app, intent);
                    else postNotice(app, intent, result);
                } catch (RuntimeException unposted) {
                    ShellLog.i("push notice not posted error=" + unposted.getClass().getSimpleName());
                }
            } finally {
                async.finish();
            }
        });
    }

    /**
     * A5 review Minor 7: the computer is no longer on this phone. Its notification goes,
     * and a text toast says why (allowed from the background; an activity is not).
     */
    static void removed(Context context, Intent intent) {
        String tag = intent.getStringExtra("murage.collapseKey");
        if (tag != null) context.getSystemService(NotificationManager.class).cancel(tag, 1);
        ShellLog.i("notification for a removed computer");
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                Toast.makeText(context, R.string.removed_workspace, Toast.LENGTH_LONG).show();
            } catch (RuntimeException unshown) {
                ShellLog.i("removed notice not shown error=" + unshown.getClass().getSimpleName());
            }
        });
    }

    /** What the notification's intent carries: ids only (PushIntents). */
    static final class Action {
        final String decision, bindingId, eventRef, requestId;
        final PushContract.Category category;
        final int revision;

        Action(String action, String bindingId, String eventRef, String category, int revision, String requestId) {
            this.decision = "APPROVE".equals(action) ? "allow" : "DENY".equals(action) ? "deny" : null;
            this.bindingId = bindingId; this.eventRef = eventRef; this.category = PushContract.Category.of(category);
            this.revision = revision; this.requestId = requestId;
        }

        static Action of(Intent i) {
            return new Action(i.getAction(), i.getStringExtra("murage.bindingId"), i.getStringExtra("murage.eventRef"),
                i.getStringExtra("murage.category"), i.getIntExtra("murage.revision", 0), i.getStringExtra("murage.requestId"));
        }
    }

    /** The notice, and the chat its tap opens when the answer path learned it late (a detail fetched here). */
    static final class Result {
        final PushOutcome.Notice notice;
        final PushOutcome.Target target;
        /** The binding is gone from this phone: nothing was sent, and there is nothing to open. */
        final boolean removed;
        Result(PushOutcome.Notice notice, PushOutcome.Target target) { this(notice, target, false); }
        private Result(PushOutcome.Notice notice, PushOutcome.Target target, boolean removed) { this.notice = notice; this.target = target; this.removed = removed; }
        static Result removedComputer() { return new Result(PushOutcome.Notice.OPEN_APP, null, true); }
    }

    /**
     * Off the main thread. Every path ends in a notice; nothing here throws on a bad
     * answer. Twin of PushResponse.answer on iOS: Allow on a risky approval is refused
     * here; the respond token is read first; a detail read that fails or answers 5xx is
     * "Couldn't reach", one that answers anything else without a request is "Open Murage".
     */
    static Result answer(PushStore store, PushHttp.Caller http, Action a) {
        String bindingId = a.bindingId;
        boolean approval = a.category == PushContract.Category.APPROVAL || a.category == PushContract.Category.APPROVAL_OPEN;
        if (bindingId == null || !approval || a.decision == null || a.revision < 1) return new Result(PushOutcome.Notice.OPEN_APP, null);
        // The origin every bearer below goes to: the ledger's, and only in canonical form (Minor 6).
        WorkspaceOrigin bound = store.canonicalOrigin(bindingId);
        if (bound == null) return Result.removedComputer();
        String origin = bound.serialized();
        String decision = a.decision;
        // APPROVAL_OPEN offers no Approve (NotificationPlan); the host would refuse it too (Minor 9).
        if (a.category == PushContract.Category.APPROVAL_OPEN && "allow".equals(decision)) return new Result(PushOutcome.Notice.STEP_UP, null);
        // The respond token first, while the phone is surely unlocked: the detail read
        // below can take seconds, and the phone may lock meanwhile (Minor 1).
        String token = store.respond(bindingId);
        if (token == null) return new Result(PushOutcome.Notice.OPEN_APP, null); // still locked, or unreadable: open the app
        int revision = a.revision;
        String requestId = a.requestId;
        PushOutcome.Target learned = null;
        if (requestId == null) {
            // The detail fetch failed when the notification was posted (Tailscale off, or the
            // phone locked before its first unlock): try it once more, now the phone is unlocked.
            String detail = store.detail(bindingId);
            if (detail == null) return new Result(PushOutcome.Notice.OPEN_APP, null);
            PushHttp.Answer got;
            try {
                got = PushDetailFetch.door(origin, a.eventRef, detail, http, DETAIL_MS).call();
            } catch (Exception failed) {
                got = null; // not a network failure (PushHttp answers those with no status): something unexpected
            }
            if (got == null) return new Result(PushOutcome.Notice.OPEN_APP, null); // an eventRef outside the contract, or a throw
            if (got.status == null || got.status >= 500) return new Result(PushOutcome.Notice.UNREACHABLE, null); // Minor 4
            learned = PushOutcome.detail(got.status, got.body, a.category).target;
            requestId = learned == null ? null : learned.requestId;
            if (requestId == null) return new Result(PushOutcome.Notice.OPEN_APP, learned);
        }
        PushOutcome.Notice notice;
        try {
            PushHttp.Answer got = http.call("POST", origin + "/api/mobile/push/respond", token,
                new JSONObject().put("requestId", requestId).put("decision", decision).put("revision", revision), RESPOND_MS);
            notice = PushOutcome.notice(got.status, got.body, decision);
        } catch (Exception bad) {
            notice = PushOutcome.Notice.OPEN_APP;
        }
        ShellLog.i("push action answered notice=" + notice.wire);
        return new Result(notice, learned);
    }

    /** Replaces the notification it answers (same tag), and a tap still opens the chat. */
    static void postNotice(Context context, Intent intent, Result result) {
        PushChannels.ensure(context);
        PushOutcome.Notice notice = result.notice;
        String tag = intent.getStringExtra("murage.collapseKey");
        if (tag == null) tag = "murage.notice";
        Intent tap = PushIntents.tap(context).putExtras(intent).setIdentifier(tag + "/TAP");
        if (result.target != null) {
            tap.putExtra("murage.threadId", result.target.threadId);
            if (result.target.messageId != null) tap.putExtra("murage.messageId", result.target.messageId);
        }
        boolean settled = notice == PushOutcome.Notice.APPROVED || notice == PushOutcome.Notice.DENIED || notice == PushOutcome.Notice.ALREADY_ANSWERED;
        android.os.Bundle ids = new android.os.Bundle();
        ids.putString("murage.bindingId", intent.getStringExtra("murage.bindingId")); // the reconciler clears it once answered elsewhere
        NotificationCompat.Builder b = new NotificationCompat.Builder(context, settled ? "finished" : "questions")
            .setSmallIcon(R.drawable.ic_stat_murage).setContentTitle(notice.title()).setContentText(notice.body()).setAutoCancel(true)
            .setGroup(intent.getStringExtra("murage.threadGroup"))
            .addExtras(ids)
            .setContentIntent(PendingIntent.getActivity(context, 0, tap, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        context.getSystemService(NotificationManager.class).notify(tag, 1, b.build());
    }
}
