package com.murage.mobile;

import com.murage.mobile.shell.PushRefreshPolicy;
import com.murage.mobile.shell.PushEnrolPlan;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * registerPush's relay half (Plan 3a R3, cloudflare/push-relay/src/relay.ts),
 * apart from Firebase, Play and Android's threads so JVM tests drive every
 * branch against a fake relay. One Play Integrity registration per install
 * gives the device secret; each workspace then gets a binding and a
 * single-use grant. Blocking: call it off the main thread, one call at a time
 * (PushRegistrar's single thread). Nothing it handles is ever logged.
 */
final class PushEnrolment {
    interface Relay { RelayClient.Answer call(String method, String path, String secret, JSONObject body); }
    /** Play Integrity: a token for this nonce, or an exception. */
    interface Attest { String token(String nonce) throws Exception; }
    /** The FCM token, or an exception. */
    interface PushToken { String get() throws Exception; }

    static final class Binding {
        final String bindingId, grant;
        Binding(String bindingId, String grant) { this.bindingId = bindingId; this.grant = grant; }
    }

    /** The relay's shapes (shared/mobile-push.ts); an answer outside them is treated as unavailable. */
    private static final Pattern UUID = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
    private static final Pattern CHALLENGE = Pattern.compile("^[A-Za-z0-9_-]{43}$");
    private static final Pattern SECRET = Pattern.compile("^murage_ds_[A-Za-z0-9_-]{43}$");
    private static final Pattern GRANT = Pattern.compile("^murage_pg_[A-Za-z0-9_-]{43}$");

    private final Relay relay;
    private final PushStore store;
    private final String environment;
    /**
     * Replaces waiting for the host, by origin: {new binding, the binding it
     * retires}. Only {@link #adopt} (issuePushTokens for the new binding) moves
     * the ledger and forgets the old one. Held by PushRegistrar across calls and
     * lost with the process: the page then gets tokens for a binding this phone
     * does not hold, and enrols afresh (src/lib/push-enrol.ts).
     */
    private final Map<String, String[]> pending;

    PushEnrolment(Relay relay, PushStore store, String environment) {
        this(relay, store, environment, new ConcurrentHashMap<>());
    }
    PushEnrolment(Relay relay, PushStore store, String environment, Map<String, String[]> pending) {
        this.relay = relay; this.store = store; this.environment = environment; this.pending = pending;
    }

    private static String field(JSONObject body, String name, Pattern shape) {
        Object value = body == null ? null : body.opt(name);
        return value instanceof String && shape.matcher((String) value).matches() ? (String) value : null;
    }

    /**
     * registerPush for one workspace: a result for the page, or null for
     * "unavailable". The plan is the shared one (contract/push-enrol.json).
     * {@code origin} is WorkspaceOrigin.serialized(), the book's form, so the
     * messaging service finds this computer's door from a binding id.
     * A replace is make before break: the old binding stays bound, with its
     * tokens and its relay row, until {@link #adopt}; the host retires it at the
     * relay when it redeems the new grant, and a grant never redeemed lapses at
     * the relay on its own.
     */
    JSONObject register(String origin, boolean granted, boolean fresh, boolean supported, PushToken fcm, Attest attest) throws Exception {
        String binding = store.ledger().binding(origin);
        // A dropped install deletes every binding's tokens (PushStore.dropInstall),
        // so a detail token here means the binding belongs to the current install.
        boolean hasDetail = binding != null && store.detail(binding) != null && store.deviceSecret() != null;
        String plan = PushEnrolPlan.decide(granted ? "granted" : "denied", binding, hasDetail, fresh);
        ShellLog.i("push register plan=" + plan);
        if (plan.equals("denied")) return new JSONObject().put("status", "denied");
        if (!supported) return new JSONObject().put("status", "unsupported"); // nothing is touched
        if (plan.equals("reuse")) return new JSONObject().put("status", "enrolled").put("bindingId", binding);
        Binding made = bind(fcm.get(), attest);
        if (made == null) return null;
        if (binding != null) {
            // "replace": the old binding keeps working until issuePushTokens for this one (adopt).
            pending.put(origin, new String[] {made.bindingId, binding});
            return new JSONObject().put("status", "granted").put("bindingId", made.bindingId).put("grant", made.grant);
        }
        if (store.updateLedger(l -> { l.bind(made.bindingId, origin); return Boolean.TRUE; }) == null) {
            // Unrecorded here, it could never be forgotten: give it back.
            ShellLog.i("push register ledger unsaved");
            if (!deleteBinding(made.bindingId)) store.addRelayDelete(made.bindingId);
            return null;
        }
        return new JSONObject().put("status", "granted").put("bindingId", made.bindingId).put("grant", made.grant);
    }

    /**
     * issuePushTokens for a pending replace: the host redeemed the new binding.
     * Only now does the old one go ({@code forget} is PushServices.forget: its
     * tokens, its notifications, and its relay delete through the durable queue,
     * repeating the host's own removal) and the ledger move. False when nothing
     * is pending for this binding, or when the ledger no longer holds the binding
     * the replace was to retire (forgotten or bound again meanwhile): then
     * nothing moves.
     */
    boolean adopt(String origin, String bindingId, Runnable forget) {
        String[] p = pending.get(origin);
        if (p == null || !p[0].equals(bindingId) || !pending.remove(origin, p)) return false;
        if (!p[1].equals(store.ledger().binding(origin))) return false;
        forget.run();
        return store.updateLedger(l -> { l.bind(bindingId, origin); return Boolean.TRUE; }) != null;
    }

    /**
     * The install's device secret, registering once when there is none. The
     * Play Integrity nonce is the relay's challenge itself (the relay compares
     * requestDetails.nonce with it). Debug builds register as development, which
     * the relay admits from a sideloaded APK signed with the debug key.
     */
    String deviceSecret(String pushToken, Attest attest) throws Exception {
        String secret = store.deviceSecret();
        if (secret != null) return secret;
        RelayClient.Answer challenge = relay.call("POST", "/v1/challenges", null, null);
        String nonce = challenge.status == 201 ? field(challenge.body, "challenge", CHALLENGE) : null;
        if (nonce == null) return null;
        String integrity = attest.token(nonce);
        JSONObject body = new JSONObject().put("platform", "android").put("environment", environment).put("pushToken", pushToken)
            .put("challenge", nonce).put("attestation", new JSONObject().put("kind", "play-integrity").put("token", integrity));
        RelayClient.Answer device = relay.call("POST", "/v1/devices", null, body);
        secret = device.status == 201 ? field(device.body, "deviceSecret", SECRET) : null;
        return secret != null && store.putDeviceSecret(secret, pushToken) ? secret : null;
    }

    /** A new binding and its grant, or null (unavailable). A 401 means the relay forgot this install: attest once more, once. */
    Binding bind(String pushToken, Attest attest) {
        try {
            String secret = deviceSecret(pushToken, attest);
            if (secret == null) return null;
            RelayClient.Answer made = relay.call("POST", "/v1/bindings", secret, null);
            if (made.status == 401) {
                drop(secret, 401);
                secret = deviceSecret(pushToken, attest);
                if (secret == null) return null;
                made = relay.call("POST", "/v1/bindings", secret, null);
            }
            if (made.status != 201) return null;
            String bindingId = field(made.body, "bindingId", UUID), grant = field(made.body, "grant", GRANT);
            return bindingId != null && grant != null ? new Binding(bindingId, grant) : null;
        } catch (Exception failed) {
            ShellLog.i("push enrol failed error=" + failed.getClass().getSimpleName());
            return null;
        }
    }

    private void drop(String failingSecret, int status) {
        if (!store.dropInstall(failingSecret)) return;
        // A replace made under this install is never committed: its binding belongs
        // to the dropped relay device, and adopting it would leave a detail token
        // that no re-attest repairs. The map is the registrar's, shared by every call.
        pending.clear();
        ShellLog.i("push install dropped status=" + status);
    }

    /** PushServices.forget: a forgotten computer's pending replace goes too (adopt would refuse it anyway). */
    void cancelPending(String origin) { pending.remove(origin); }

    /**
     * A binding the host may already push to that this phone has not committed yet
     * (a pending replace): the messaging service shows the generic text for it, as
     * iOS does, rather than dropping it as a removed computer's.
     */
    boolean isPending(String bindingId) {
        for (String[] p : pending.values()) if (p[0].equals(bindingId)) return true;
        return false;
    }

    /**
     * FCM rotated the token (or an open found it differs from the one the relay
     * holds). 401 (the relay forgot this install) and 409 token_in_use (another
     * attested registration holds it) drop the install: the next registerPush
     * attests again and every workspace replaces its binding. Unreachable keeps
     * it for the next try.
     */
    void tokenChanged(String pushToken) {
        String secret = store.deviceSecret();
        if (secret == null || pushToken == null || store.relayHolds(pushToken)) return;
        try {
            int status = relay.call("PUT", "/v1/devices/self/token", secret, new JSONObject().put("pushToken", pushToken)).status;
            if (status == 200) store.markRelayToken(pushToken);
            else if (status == 401 || status == 409) drop(secret, status);
        } catch (Exception failed) {
            ShellLog.i("push token update failed error=" + failed.getClass().getSimpleName());
        }
    }

    /**
     * The foreground refresh (PushRefreshPolicy): the same PUT tokenChanged sends,
     * with the current token even when the relay already holds it, which the relay
     * counts as activity for the device and its bindings. Best effort: nothing is
     * thrown, a failure backs off, and nothing is sent without an install. A
     * 401 or 409 drops the install as tokenChanged does.
     */
    void refreshIfDue(PushRefreshPolicy policy, long nowMs, PushToken token) {
        String secret = store.deviceSecret();
        if (secret == null || !policy.due(nowMs)) return;
        try {
            String pushToken = token.get();
            if (pushToken == null) { policy.failed(nowMs); return; }
            int status = relay.call("PUT", "/v1/devices/self/token", secret, new JSONObject().put("pushToken", pushToken)).status;
            if (status == 200) { store.markRelayToken(pushToken); policy.succeeded(nowMs); }
            else if (status == 401 || status == 409) drop(secret, status);
            else policy.failed(nowMs);
        } catch (Exception failed) {
            policy.failed(nowMs);
            ShellLog.i("push refresh failed error=" + failed.getClass().getSimpleName());
        }
    }

    /** Every relay delete the phone still owes (PushStore.relayDeletes), each confirmed one crossed off. */
    void drainDeletes() {
        for (String bindingId : store.relayDeletes()) {
            if (deleteBinding(bindingId)) store.removeRelayDelete(bindingId);
        }
    }

    /**
     * DELETE /v1/bindings/:id with the device secret. True when there is nothing
     * left to do: removed (200), or already gone or unreachable for this install
     * (401, 403, 404: the relay answers 403 for a binding it no longer holds), or
     * never deletable (no install, an id outside the contract). False keeps it for
     * the next open.
     */
    boolean deleteBinding(String bindingId) {
        String secret = store.deviceSecret();
        if (secret == null || bindingId == null || !UUID.matcher(bindingId).matches()) return true;
        int status = relay.call("DELETE", "/v1/bindings/" + bindingId, secret, null).status;
        return status == 200 || status == 401 || status == 403 || status == 404;
    }
}
