package com.murage.mobile;

import android.app.Activity;
import android.os.CancellationSignal;
import com.murage.mobile.shell.PhoneJobsContract;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.nio.charset.StandardCharsets;

/** App-only purpose-specific signer. There is no bridge entry for it. */
final class PhoneJobsSigner implements PhoneJobsMintClient.Signer {
    static final String TAG = "murage-phone-jobs/1";

    interface Key {
        String point(WorkspaceOrigin origin);
        void authenticateAndSign(Request request, Callback callback);
    }

    interface Callback {
        void signed(String signature);
        void failed(PhoneJobsMintClient.Failure failure);
    }

    static final class Request {
        final WorkspaceOrigin origin;
        final String keyId, nonce;
        final long expiresAt;

        private Request(WorkspaceOrigin origin, String keyId, String nonce, long expiresAt) {
            this.origin = origin; this.keyId = keyId; this.nonce = nonce; this.expiresAt = expiresAt;
        }

        byte[] message() {
            if (!TAG.equals(PhoneJobsContract.TAG)) throw new IllegalStateException("phone jobs purpose changed");
            return PhoneJobsContract.phoneJobsMessage(origin.serialized(), keyId, nonce, expiresAt).getBytes(StandardCharsets.UTF_8);
        }
    }

    private final Key key;
    PhoneJobsSigner(Key key) { this.key = key; }

    @Override public String keyId(WorkspaceOrigin origin) { return PhoneJobsContract.approvalKeyId(key.point(origin)); }

    @Override public void sign(WorkspaceOrigin origin, String keyId, String nonce, long expiresAt, Callback callback) {
        if (keyId == null || !keyId.equals(keyId(origin))) { callback.failed(PhoneJobsMintClient.Failure.NO_APPROVAL_KEY); return; }
        if (nonce == null || !nonce.matches("[A-Za-z0-9_-]{43}") || expiresAt <= 0 || expiresAt > 9_007_199_254_740_991L) {
            callback.failed(PhoneJobsMintClient.Failure.INVALID_RESPONSE); return;
        }
        key.authenticateAndSign(new Request(origin, keyId, nonce, expiresAt), callback);
    }

    /** N3 owns this adapter for its screen lifetime and cancels on dismissal. */
    static final class EnrolledKey implements Key {
        private final Activity activity;
        private CancellationSignal prompt;
        EnrolledKey(Activity activity) { this.activity = activity; }

        @Override public String point(WorkspaceOrigin origin) { return ApprovalKeys.phoneJobsPoint(origin); }

        @Override public void authenticateAndSign(Request request, Callback callback) {
            prompt = ApprovalKeys.signPhoneJobs(activity, request, new ApprovalKeys.Callback() {
                @Override public void ok(String signature) { callback.signed(signature); }
                @Override public void error(String code) {
                    callback.failed("no_key".equals(code) || "no_lock".equals(code) ? PhoneJobsMintClient.Failure.NO_APPROVAL_KEY
                        : "cancelled".equals(code) ? PhoneJobsMintClient.Failure.CANCELLED : PhoneJobsMintClient.Failure.UNAVAILABLE);
                }
            });
        }

        void cancel() { if (prompt != null) prompt.cancel(); }
    }
}
