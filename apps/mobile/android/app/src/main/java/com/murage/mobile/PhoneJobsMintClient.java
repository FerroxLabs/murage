package com.murage.mobile;

import com.murage.mobile.shell.PhoneJobsContract;
import com.murage.mobile.shell.ProbeVerdict;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.util.concurrent.Executor;
import java.util.function.LongSupplier;
import org.json.JSONObject;

/** Shared native N3/N10 mint flow. The typed signer selects the purpose.
 * Saves the bearer and returns only completion to the screen.
 * Call mint/cancel on the UI executor; all HTTP work runs on the IO executor.
 * There are no retries. Cancellation ignores even a late HTTP/prompt answer. */
final class PhoneJobsMintClient {
    enum Failure {
        NOT_OFFERED("Coming to Murage Cloud", R.string.ask_cloud),
        UPDATE_COMPUTER("Turn this on, or update Murage, on your computer.", R.string.phone_update),
        TURNED_OFF("Your computer hasn't turned this on yet. Turn it on in Murage on the computer, in Settings → Phone and other devices.", R.string.phone_turned_off),
        NO_APPROVAL_KEY("Set a passcode on this phone, then pair again", R.string.phone_no_key),
        REFUSED("Phone sign-in was refused. Pair this phone again.", R.string.phone_refused),
        RATE_LIMITED("Too many sign-in attempts. Try again shortly.", R.string.phone_rate_limited),
        INVALID_RESPONSE("Could not enable phone tools. Try again.", R.string.phone_unavailable),
        UNAVAILABLE("Could not enable phone tools. Try again.", R.string.phone_unavailable),
        STORAGE("Could not save phone sign-in. Try again.", R.string.phone_storage),
        CANCELLED("Phone sign-in was cancelled.", R.string.phone_cancelled),
        BUSY("Phone sign-in is already in progress.", R.string.phone_busy);
        final String message;
        final int messageResource;
        Failure(String message, int messageResource) { this.message = message; this.messageResource = messageResource; }
    }

    interface Completion {
        void complete();
        void failed(Failure failure);
    }

    interface TokenWriter { boolean save(String token, WorkspaceOrigin origin); }
    interface Transport { Response send(WorkspaceOrigin origin, String method, String path, JSONObject body) throws Exception; }
    static final class Response {
        final int status;
        final String body;
        Response(int status, String body) { this.status = status; this.body = body; }
    }

    interface Signer {
        String keyId(WorkspaceOrigin origin);
        void sign(WorkspaceOrigin origin, String keyId, String nonce, long expiresAt, PhoneJobsSigner.Callback callback);
    }
    private final Signer signer;
    private final boolean ask;
    private final TokenWriter store;
    private final Transport http;
    private final Executor io, ui;
    private final LongSupplier now;
    private Attempt active;

    private static final class Attempt {
        final WorkspaceOrigin origin;
        final String keyId;
        final Completion completion;
        boolean signing, posting;
        Attempt(WorkspaceOrigin origin, String keyId, Completion completion) {
            this.origin = origin; this.keyId = keyId; this.completion = completion;
        }
    }

    PhoneJobsMintClient(PhoneJobsSigner signer, TokenWriter store, Transport http, Executor io, Executor ui, LongSupplier now) {
        this.signer = signer; this.store = store; this.http = http; this.io = io; this.ui = ui; this.now = now; this.ask = false;
    }

    PhoneJobsMintClient(PhoneAskSigner signer, TokenWriter store, Transport http, Executor io, Executor ui, LongSupplier now) {
        this.signer = signer; this.store = store; this.http = http; this.io = io; this.ui = ui; this.now = now; this.ask = true;
    }

    void mint(WorkspaceOrigin origin, Completion completion) {
        if (active != null) { completion.failed(Failure.BUSY); return; }
        String keyId = signer.keyId(origin);
        if (keyId == null) { completion.failed(Failure.NO_APPROVAL_KEY); return; }
        Attempt a = new Attempt(origin, keyId, completion);
        active = a;
        send(a, "GET", "/healthz", null, response -> {
            if (response.status != 200) { fail(a, Failure.UNAVAILABLE); return; }
            ProbeVerdict verdict = ProbeVerdict.classify(response.status, response.body, null);
            if (!(ask ? verdict.phoneAskOk() : verdict.phoneJobsOk())) {
                fail(a, verdict.phoneFlagsOk() ? Failure.TURNED_OFF : Failure.UPDATE_COMPUTER); return;
            }
            send(a, "GET", "/api/phones/self/challenge?key=" + a.keyId, null, challenge -> sign(a, challenge));
        });
    }

    void cancel() { if (active != null) fail(active, Failure.CANCELLED); }

    private void sign(Attempt a, Response response) throws Exception {
        JSONObject challenge = object(a, response);
        if (challenge == null) return;
        Object n = challenge.opt("nonce"), e = challenge.opt("expiresAt");
        if (challenge.length() != 2 || !(n instanceof String) || !(e instanceof Number)) { fail(a, Failure.INVALID_RESPONSE); return; }
        double value = ((Number) e).doubleValue();
        if (!Double.isFinite(value) || value != Math.rint(value) || value <= 0 || value > 9_007_199_254_740_991L) { fail(a, Failure.INVALID_RESPONSE); return; }
        long expiry = ((Number) e).longValue();
        if (expiry <= now.getAsLong()) { fail(a, Failure.INVALID_RESPONSE); return; }
        if (a.signing) return;
        a.signing = true;
        signer.sign(a.origin, a.keyId, (String) n, expiry, new PhoneJobsSigner.Callback() {
            @Override public void signed(String signature) {
                if (active != a || a.posting) return;
                a.posting = true;
                if (expiry <= now.getAsLong()) { fail(a, Failure.INVALID_RESPONSE); return; }
                try {
                    JSONObject body = new JSONObject().put("keyId", a.keyId).put("nonce", n).put("expiresAt", expiry).put("signature", signature);
                    if (ask) body.put("scope", "ask");
                    send(a, "POST", "/api/phones/self/token", body, answer -> {
                        JSONObject json = object(a, answer);
                        if (json == null) return;
                        Object token = json.opt("token");
                        if (json.length() != 1 || !(token instanceof String) || !(ask ? com.murage.mobile.shell.PhoneAskContract.tokenValid((String) token) : PhoneJobsContract.tokenValid((String) token))) { fail(a, Failure.INVALID_RESPONSE); return; }
                        if (!a.keyId.equals(signer.keyId(a.origin))) { fail(a, Failure.NO_APPROVAL_KEY); return; }
                        if (!store.save((String) token, a.origin)) { fail(a, Failure.STORAGE); return; }
                        active = null;
                        a.completion.complete();
                    });
                } catch (Exception failed) { fail(a, Failure.UNAVAILABLE); }
            }

            @Override public void failed(Failure failure) { fail(a, failure); }
        });
    }

    private JSONObject object(Attempt a, Response response) throws Exception {
        if (ask && response.status == 404) { fail(a, Failure.NOT_OFFERED); return null; }
        if (response.status == 403) { fail(a, Failure.REFUSED); return null; }
        if (response.status == 429) { fail(a, Failure.RATE_LIMITED); return null; }
        if (response.status != 200) { fail(a, Failure.UNAVAILABLE); return null; }
        try {
            if (response.body == null || response.body.length() > 4096) throw new IllegalArgumentException();
            return new JSONObject(response.body);
        } catch (Exception malformed) { fail(a, Failure.INVALID_RESPONSE); return null; }
    }

    private interface Answer { void accept(Response response) throws Exception; }
    private void send(Attempt a, String method, String path, JSONObject body, Answer answer) {
        io.execute(() -> {
            try {
                Response response = http.send(a.origin, method, path, body);
                ui.execute(() -> {
                    if (active != a) return;
                    try { answer.accept(response); } catch (Exception failed) { fail(a, Failure.UNAVAILABLE); }
                });
            } catch (Exception failed) { ui.execute(() -> fail(a, Failure.UNAVAILABLE)); }
        });
    }

    private void fail(Attempt a, Failure failure) {
        if (active != a) return;
        active = null;
        a.completion.failed(failure);
    }
}
