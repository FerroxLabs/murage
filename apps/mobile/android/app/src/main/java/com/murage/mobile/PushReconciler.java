package com.murage.mobile;

import android.app.NotificationManager;
import android.content.Context;
import android.service.notification.StatusBarNotification;
import com.murage.mobile.shell.ChannelArgs;
import com.murage.mobile.shell.PushLedger;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Predicate;
import org.json.JSONArray;
import org.json.JSONObject;

/** Spec §3.5: when the app opens, each workspace's pending list clears what was answered elsewhere. */
final class PushReconciler {
    /** One thread, one pass at a time, and at most one more waiting (Coalesce). */
    private static final ExecutorService WORK = Executors.newSingleThreadExecutor();
    static final int PENDING_MS = 5000;
    private static Coalesce passes;
    private PushReconciler() {}

    static void run(Context context) {
        Context app = context.getApplicationContext();
        Coalesce c;
        synchronized (PushReconciler.class) {
            if (passes == null) passes = new Coalesce(WORK, () -> pass(app));
            c = passes;
        }
        c.request();
    }

    private static void pass(Context app) {
        try {
            NotificationManager nm = app.getSystemService(NotificationManager.class);
            for (String tag : sweep(PushServices.get(app).store, PushHttp::call, shown(nm), PushRegistrar.get(app)::isPending)) nm.cancel(tag, 1);
        } catch (RuntimeException unexpected) {
            ShellLog.i("push reconcile failed error=" + unexpected.getClass().getSimpleName());
        }
    }

    /** The tags on screen, by the binding each notification carries in its extras. */
    static Map<String, List<String>> shown(NotificationManager nm) {
        Map<String, List<String>> shown = new HashMap<>();
        for (StatusBarNotification n : nm.getActiveNotifications()) {
            String binding = n.getNotification().extras.getString("murage.bindingId");
            if (binding != null && n.getTag() != null) shown.computeIfAbsent(binding, k -> new ArrayList<>()).add(n.getTag());
        }
        return shown;
    }

    /**
     * A5 review Minor 7: a computer removed from this phone (forget or sweep) takes its
     * notifications with it, so none is left whose Approve or tap has nowhere to go.
     */
    static void cancelFor(Context context, String bindingId) {
        try {
            NotificationManager nm = context.getSystemService(NotificationManager.class);
            List<String> tags = shown(nm).get(bindingId);
            if (tags != null) for (String tag : tags) nm.cancel(tag, 1);
        } catch (RuntimeException unexpected) {
            ShellLog.i("push clear failed error=" + unexpected.getClass().getSimpleName());
        }
    }

    /**
     * For every binding the host answers for: the badge it reports, and the tags of
     * notifications on screen that are no longer pending there (to cancel), then every
     * tag of a binding the phone no longer holds. A binding
     * whose host is out of reach, or answers in a shape this does not know, keeps what
     * it shows.
     */
    static List<String> sweep(PushStore store, PushHttp.Caller http, Map<String, List<String>> shown) {
        return sweep(store, http, shown, bindingId -> false);
    }

    /**
     * {@code pendingReplace}: a binding a replace is still waiting on (PushEnrolment.isPending).
     * The host may already push to it, and it is not in the ledger yet, so its
     * notifications are not "no longer on this phone" (final review M5, as iOS).
     */
    static List<String> sweep(PushStore store, PushHttp.Caller http, Map<String, List<String>> shown, Predicate<String> pendingReplace) {
        List<String> cancel = new ArrayList<>();
        for (String binding : store.ledger().bindingIds()) {
            WorkspaceOrigin origin = store.canonicalOrigin(binding); // the bearer goes only to a canonical origin (Minor 6)
            String token = origin == null ? null : store.detail(binding);
            if (token == null) continue;
            PushHttp.Answer a = http.call("GET", origin.serialized() + "/api/mobile/push/pending", token, null, PENDING_MS);
            if (a == null || a.status == null || a.status != 200 || !(a.body instanceof JSONObject)) continue;
            JSONObject body = (JSONObject) a.body;
            Integer badge = ChannelArgs.integer(body.opt("badge"));
            JSONArray items = body.optJSONArray("items");
            if (badge == null || items == null) continue;
            List<PushLedger.Pending> pending = new ArrayList<>();
            boolean understood = true;
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                Integer revision = item == null ? null : ChannelArgs.integer(item.opt("revision"));
                if (item == null || !(item.opt("collapseKey") instanceof String) || revision == null) { understood = false; break; }
                pending.add(new PushLedger.Pending(item.optString("collapseKey"), revision));
            }
            // One item it cannot read could be the one on screen: cancel nothing for this binding.
            if (!understood) continue;
            List<String> onScreen = shown.getOrDefault(binding, new ArrayList<>());
            List<String> remove = store.updateLedger(l -> l.reconcile(binding, badge, pending, onScreen));
            if (remove != null) cancel.addAll(remove);
        }
        // Notifications of a binding no longer on this phone (one the unbind could not clear).
        // The waiting replaces first, then the ledger: a replace adopted in
        // between is in the ledger by the second read, so it is never swept.
        List<String> candidates = new ArrayList<>();
        for (String id : shown.keySet()) if (!pendingReplace.test(id)) candidates.add(id);
        List<String> bound = store.ledger().bindingIds();
        for (String id : candidates) if (!bound.contains(id)) cancel.addAll(shown.get(id));
        ShellLog.i("push reconcile cancelled=" + cancel.size());
        return cancel;
    }
}
