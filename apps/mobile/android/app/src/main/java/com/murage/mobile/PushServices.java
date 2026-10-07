package com.murage.mobile;

import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import com.murage.mobile.shell.Json;
import com.murage.mobile.shell.PushContract;
import com.murage.mobile.shell.WorkspaceBook;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONObject;

/** The app side of the four push methods (spec §3.2), and forgetting a computer. */
final class PushServices {
    private static PushServices instance;
    static synchronized PushServices get(Context c) {
        if (instance == null) instance = new PushServices(c.getApplicationContext());
        return instance;
    }

    final Context app;
    final PushStore store;
    private PushServices(Context app) { this.app = app; this.store = new PushStore(app); }

    JSONObject pushStatus(WorkspaceOrigin origin) {
        boolean granted = app.getSystemService(NotificationManager.class).areNotificationsEnabled();
        boolean asked = app.getSharedPreferences("murage_push", Context.MODE_PRIVATE).getBoolean("asked", false);
        String binding = store.ledger().binding(origin.serialized());
        JSONObject out = new JSONObject();
        Json.put(out, "permission", permission(granted, asked, Build.VERSION.SDK_INT));
        Json.put(out, "enrolled", binding != null && store.detail(binding) != null && store.current(binding, System.currentTimeMillis()));
        long expiresAt = binding == null ? 0L : store.expiresAt(binding);
        if (expiresAt > 0L) Json.put(out, "expiresAt", expiresAt);
        return out;
    }

    /**
     * Below API 33 there is no prompt to come: notifications off is the person's
     * choice in Settings, so it reads as denied, the answer registerPush gives
     * (A4 review, Minor 1). From 33 it is undetermined until the one prompt ran.
     */
    static String permission(boolean granted, boolean asked, int sdk) {
        if (granted) return "granted";
        return asked || sdk < 33 ? "denied" : "undetermined";
    }

    /**
     * Only for the binding this workspace holds, or for the one a pending replace
     * was waiting on (adopt moves the ledger first). A refused respond seal keeps
     * the old pair (PushStore.putTokens).
     */
    boolean issue(WorkspaceOrigin origin, PushContract.Issued tokens) {
        PushRegistrar.get(app).adopt(origin, tokens.bindingId);
        String binding = store.ledger().binding(origin.serialized());
        return tokens.bindingId.equals(binding) && store.putTokens(tokens.bindingId, tokens.detail, tokens.respond, tokens.expiresAt);
    }

    void setBadge(WorkspaceOrigin origin, int count) {
        store.updateLedger(l -> {
            String binding = l.binding(origin.serialized());
            if (binding != null) l.setBadge(binding, count);
            return null;
        }); // B4: Android has no badge count; the ledger feeds setNumber (A3)
    }

    void forget(WorkspaceOrigin origin) {
        PushRegistrar.get(app).cancelPending(origin);
        String removed = store.forget(origin.serialized());
        if (removed != null) {
            unbound(removed);
            PushRegistrar.get(app).releaseDeviceIfLast();
        }
    }

    /** Every open, once the book reads: drops bindings for computers no longer saved. */
    void sweep(WorkspaceBook book) {
        Set<String> saved = new HashSet<>();
        for (WorkspaceBook.Entry entry : book.sorted()) saved.add(entry.origin);
        // Removed computers' bindings, then stray tokens' ids (a token is stored under its binding id).
        for (String bindingId : store.sweep(saved)) unbound(bindingId);
        PushRegistrar.get(app).retryDeletes(); // deletes an earlier open could not deliver
        if (saved.isEmpty()) PushRegistrar.get(app).releaseDeviceIfLast();
    }

    /**
     * The one place a binding the phone dropped (forget or sweep) passes through,
     * after its tokens are gone: its notifications go (A5 review Minor 7), and it
     * goes at the relay too (A4).
     */
    private void unbound(String bindingId) {
        PushReconciler.cancelFor(app, bindingId);
        PushRegistrar.get(app).deleteAtRelay(bindingId);
    }
}
