package com.murage.mobile;

import android.content.Context;
import com.murage.mobile.shell.ApprovalProof;
import com.murage.mobile.shell.PhoneAskContract;
import com.murage.mobile.shell.WorkspaceOrigin;
import com.murage.mobile.shell.ShareFiles;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** App-only token entries in SecureStore. Never part of the workspace book,
 * push store, or WebView reply. Only ShareActivity and the outbox read them. */
final class PhoneAskTokenStore implements PhoneJobsMintClient.TokenWriter {
    interface Stores { SecureStore named(String key); }
    private final Stores stores;

    private final java.util.function.BooleanSupplier unlocked;
    private final java.util.function.Predicate<WorkspaceOrigin> removalPending;
    PhoneAskTokenStore(Context context) {
        this(key -> new SecureStore(context.getApplicationContext(), key, SecureStore.ASK_KEYSTORE), () -> {
            android.app.KeyguardManager gate = context.getSystemService(android.app.KeyguardManager.class);
            return gate != null && gate.isDeviceSecure() && !gate.isDeviceLocked();
        }, origin -> PhoneAskSetup.removalPending(context.getApplicationContext(), origin));
    }
    PhoneAskTokenStore(Stores stores, java.util.function.BooleanSupplier unlocked) {
        this(stores, unlocked, origin -> false);
    }
    PhoneAskTokenStore(Stores stores, java.util.function.BooleanSupplier unlocked,
                      java.util.function.Predicate<WorkspaceOrigin> removalPending) {
        this.stores = stores; this.unlocked = unlocked; this.removalPending = removalPending;
    }

    static String key(WorkspaceOrigin origin) {
        try {
            return "phone_ask.v1." + ApprovalProof.base64url(MessageDigest.getInstance("SHA-256")
                .digest(origin.serialized().getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }

    @Override public boolean save(String token, WorkspaceOrigin origin) {
        synchronized (ShareFiles.LOCK) {
            return !removalPending.test(origin) && unlocked.getAsBoolean() && PhoneAskContract.tokenValid(token)
                && stores.named(key(origin)).write(token.getBytes(StandardCharsets.UTF_8));
        }
    }

    /** Pending sign-outs are absent to share/outbox even if ciphertext remains. */
    String readForShareOrOutbox(WorkspaceOrigin origin) {
        if (removalPending.test(origin)) return null;
        if (!unlocked.getAsBoolean()) throw new IllegalStateException("phone sign-in unreadable");
        SecureStore.Read read = stores.named(key(origin)).read();
        if (read.state == SecureStore.Read.State.EMPTY) return null;
        if (read.state != SecureStore.Read.State.OK) throw new IllegalStateException("phone sign-in unreadable");
        String token = new String(read.bytes, StandardCharsets.UTF_8);
        if (!PhoneAskContract.tokenValid(token)) throw new IllegalStateException("phone sign-in unreadable");
        return token;
    }

    boolean remove(WorkspaceOrigin origin) {
        // Removing ciphertext needs no decryption or unlocked Keystore key.
        // A failed preferences commit must still be retried by the setup owner.
        try { return stores.named(key(origin)).remove(); }
        catch (RuntimeException failed) { return false; }
    }
}
