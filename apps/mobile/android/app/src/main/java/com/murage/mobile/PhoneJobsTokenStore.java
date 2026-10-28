package com.murage.mobile;

import android.content.Context;
import com.murage.mobile.shell.ApprovalProof;
import com.murage.mobile.shell.PhoneJobsContract;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** App-only token entries in SecureStore. Never part of the workspace book,
 * push store, or WebView reply. Only the foreground runner reads them. */
final class PhoneJobsTokenStore implements PhoneJobsMintClient.TokenWriter {
    interface Stores { SecureStore named(String key); }
    private final Stores stores;

    PhoneJobsTokenStore(Context context) { this(key -> new SecureStore(context.getApplicationContext(), key)); }
    PhoneJobsTokenStore(Stores stores) { this.stores = stores; }

    static String key(WorkspaceOrigin origin) {
        try {
            return "phone_jobs.v1." + ApprovalProof.base64url(MessageDigest.getInstance("SHA-256")
                .digest(origin.serialized().getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }

    @Override public boolean save(String token, WorkspaceOrigin origin) {
        return PhoneJobsContract.tokenValid(token) && stores.named(key(origin)).write(token.getBytes(StandardCharsets.UTF_8));
    }

    /** Null only for an absent entry. Unreadable never starts a fresh mint. */
    String readForRunner(WorkspaceOrigin origin) {
        SecureStore.Read read = stores.named(key(origin)).read();
        if (read.state == SecureStore.Read.State.EMPTY) return null;
        if (read.state != SecureStore.Read.State.OK) throw new IllegalStateException("phone sign-in unreadable");
        String token = new String(read.bytes, StandardCharsets.UTF_8);
        if (!PhoneJobsContract.tokenValid(token)) throw new IllegalStateException("phone sign-in unreadable");
        return token;
    }

    boolean remove(WorkspaceOrigin origin) { return stores.named(key(origin)).remove(); }
}
