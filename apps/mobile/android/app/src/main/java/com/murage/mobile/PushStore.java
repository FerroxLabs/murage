package com.murage.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import com.murage.mobile.shell.PushLedger;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Function;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;

/**
 * Spec §3.5 storage on Android. Tokens are sealed with Keystore keys: the
 * detail key works on a locked phone (the messaging service runs there); the
 * respond key requires an unlocked device, so a locked phone cannot answer.
 * The ledger is plain JSON: ids and counts only, never a secret.
 */
final class PushStore {
    static final String DETAIL_ALIAS = "murage.push.detail.v1";
    static final String RESPOND_ALIAS = "murage.push.respond.v1";
    private static final int IV = 12;
    private final SharedPreferences prefs;
    private final SecureStore.Keys detailKey, respondKey;

    PushStore(Context context) {
        this(context.getSharedPreferences("murage_push", Context.MODE_PRIVATE), keystoreKeys(DETAIL_ALIAS, false), keystoreKeys(RESPOND_ALIAS, true));
    }

    PushStore(SharedPreferences prefs, SecureStore.Keys detailKey, SecureStore.Keys respondKey) {
        this.prefs = prefs; this.detailKey = detailKey; this.respondKey = respondKey;
    }

    /** The unlocked flag is only ever true for RESPOND_ALIAS (see PushStore(Context)). */
    static SecureStore.Keys keystoreKeys(String alias, boolean unlocked) {
        return new SecureStore.Keys() {
            @Override public synchronized SecretKey existing() throws Exception {
                KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
                ks.load(null);
                return (SecretKey) ks.getKey(alias, null);
            }
            @Override public synchronized SecretKey create() throws Exception {
                SecretKey raced = existing();
                if (raced != null) return raced;
                KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256);
                if (unlocked) spec.setUnlockedDeviceRequired(true);
                g.init(spec.build());
                return g.generateKey();
            }
        };
    }

    private boolean seal(String name, String value, SecureStore.Keys keys) {
        try {
            SecretKey key = keys.existing();
            if (key == null) key = keys.create();
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            // The Keystore refuses a caller IV (randomized encryption): it picks a fresh one, as in SecureStore.write.
            c.init(Cipher.ENCRYPT_MODE, key);
            byte[] iv = c.getIV();
            if (iv.length != IV) throw new IllegalStateException("iv");
            byte[] sealed = c.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] all = new byte[IV + sealed.length];
            System.arraycopy(iv, 0, all, 0, IV);
            System.arraycopy(sealed, 0, all, IV, sealed.length);
            return prefs.edit().putString(name, Base64.getEncoder().encodeToString(all)).commit();
        } catch (Exception failed) {
            ShellLog.i("push seal failed error=" + failed.getClass().getSimpleName());
            return false;
        }
    }

    private String open(String name, SecureStore.Keys keys) {
        String stored = prefs.getString(name, null);
        if (stored == null) return null;
        try {
            SecretKey key = keys.existing();
            if (key == null) return null;
            byte[] all = Base64.getDecoder().decode(stored);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, all, 0, IV));
            return new String(c.doFinal(all, IV, all.length - IV), StandardCharsets.UTF_8);
        } catch (Exception locked) {
            return null; // a locked respond key, or a key lost to a restore: never an error the user sees
        }
    }

    /**
     * Respond first, detail last, so a detail token (what "enrolled" means) always
     * has its respond token beside it. A locked phone refuses the respond seal
     * (setUnlockedDeviceRequired): that changes nothing, so the old pair stays
     * whole and the next open re-mints instead of replacing the binding at the
     * relay. The trade-off: the host already rotated that pair, so until the next
     * open a detail fetch or a lock-screen answer gets 401 (generic text, "Open
     * Murage"). A refused detail seal after respond went through leaves neither.
     */
    boolean putTokens(String bindingId, String detail, String respond) {
        if (!seal("respond." + bindingId, respond, respondKey)) return false;
        if (seal("detail." + bindingId, detail, detailKey)) return true;
        deleteTokens(bindingId);
        return false;
    }

    /**
     * The same, and then the expiry the host gave with the pair (ms since the
     * epoch). It goes in after the pair, so it never outlives a failed pair. A pair
     * whose expiry cannot be written is not stored at all: the phone then reports
     * not enrolled and the enrolment retry runs.
     */
    boolean putTokens(String bindingId, String detail, String respond, long expiresAt) {
        if (!putTokens(bindingId, detail, respond)) return false;
        if (!prefs.edit().putLong("expires." + bindingId, expiresAt).commit()) {
            deleteTokens(bindingId);
            return false;
        }
        return true;
    }
    /** When this binding's tokens stop working; 0 when none was recorded (a pair stored before expiry was kept). */
    long expiresAt(String bindingId) { return prefs.getLong("expires." + bindingId, 0L); }
    /** A pair past its expiry is not a working one, and a pair with no recorded expiry (stored by an older build) is unknown, so it is not current either. */
    boolean current(String bindingId, long now) {
        long at = expiresAt(bindingId);
        return at != 0L && at > now;
    }
    String detail(String bindingId) { return open("detail." + bindingId, detailKey); }
    String respond(String bindingId) { return open("respond." + bindingId, respondKey); }
    void deleteTokens(String bindingId) { prefs.edit().remove("detail." + bindingId).remove("respond." + bindingId).remove("expires." + bindingId).commit(); }

    /**
     * The install (Global Constraints: app-only, readable after first unlock):
     * sealed with the detail key, which needs no unlock, so a token rotation in
     * the background can still reach the relay.
     */
    String deviceSecret() { return open("device.secret", detailKey); }
    boolean putDeviceSecret(String secret) { return seal("device.secret", secret, detailKey); }
    boolean putDeviceSecret(String secret, String pushToken) { return putDeviceSecret(secret) && markRelayToken(pushToken); }
    void deleteDeviceSecret() { prefs.edit().remove("device.secret").remove("relay.token.sha256").commit(); }

    /**
     * The relay forgot this install (401) or another registration holds its push
     * token (409). Only when the failing secret is still the stored one: the
     * secret goes, and so does every binding's token pair, because those bindings
     * belonged to the old relay device; each workspace then plans "replace" rather
     * than reusing a dead binding. Returns whether it dropped anything.
     */
    synchronized boolean dropInstall(String failingSecret) {
        if (failingSecret == null || !failingSecret.equals(deviceSecret())) return false;
        deleteDeviceSecret();
        for (String bindingId : ledger().bindingIds()) deleteTokens(bindingId);
        return true;
    }

    /** Only a digest of the push token the relay holds: enough to tell a new one, never the token itself. */
    boolean relayHolds(String pushToken) { return pushToken != null && digest(pushToken).equals(prefs.getString("relay.token.sha256", null)); }
    boolean markRelayToken(String pushToken) { return prefs.edit().putString("relay.token.sha256", digest(pushToken)).commit(); }
    private static String digest(String value) {
        try {
            StringBuilder hex = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    /** Bindings the phone dropped whose relay delete has not been confirmed yet: ids only, retried on every open. */
    synchronized List<String> relayDeletes() {
        List<String> out = new ArrayList<>();
        try {
            JSONArray ids = new JSONArray(prefs.getString("relay.deletes", "[]"));
            for (int i = 0; i < ids.length(); i++) out.add(ids.getString(i));
        } catch (Exception unreadable) { /* nothing to retry */ }
        return out;
    }
    synchronized void addRelayDelete(String bindingId) {
        List<String> ids = relayDeletes();
        if (!ids.contains(bindingId)) { ids.add(bindingId); prefs.edit().putString("relay.deletes", new JSONArray(ids).toString()).commit(); }
    }
    synchronized void removeRelayDelete(String bindingId) {
        List<String> ids = relayDeletes();
        if (ids.remove(bindingId)) prefs.edit().putString("relay.deletes", new JSONArray(ids).toString()).commit();
    }

    /**
     * The origin a token may go to (A5 review Minor 6): only one the ledger holds in
     * WorkspaceOrigin's own serialized form, so a bearer never goes to an origin that
     * reads one way here and another way to a WebView or the host. Null otherwise.
     */
    WorkspaceOrigin canonicalOrigin(String bindingId) {
        return bindingId == null ? null : canonical(ledger().origin(bindingId));
    }

    static WorkspaceOrigin canonical(String text) {
        WorkspaceOrigin origin = text == null ? null : WorkspaceOrigin.parse(text);
        return origin != null && origin.serialized().equals(text) ? origin : null;
    }

    synchronized PushLedger ledger() { return PushLedger.decode(prefs.getString("ledger.v1", "{}")); }

    synchronized <T> T updateLedger(Function<PushLedger, T> change) {
        PushLedger ledger = ledger();
        T out = change.apply(ledger);
        return prefs.edit().putString("ledger.v1", ledger.encode()).commit() ? out : null;
    }

    /** True while any computer still has a relay binding on this phone. */
    synchronized boolean hasBindings() { return !ledger().bindingIds().isEmpty(); }

    /**
     * Unbinds this origin and deletes its tokens; returns the binding it held, or
     * null. The tokens go even when the ledger cannot be saved: the next open's
     * sweep drops the binding then.
     */
    synchronized String forget(String origin) {
        PushLedger ledger = ledger();
        String removed = ledger.unbindOrigin(origin);
        if (removed == null) return null;
        if (!prefs.edit().putString("ledger.v1", ledger.encode()).commit()) ShellLog.i("push forget deferred");
        deleteTokens(removed);
        return removed;
    }

    /**
     * On every open: unbinds each origin that is no longer a saved computer,
     * deletes its tokens, and deletes any token no binding owns (left by a forget
     * that could not save). Returns the bindings it unbound, then the ids of those
     * stray tokens (a token is stored under its binding id), so each can go at the
     * relay too.
     */
    synchronized List<String> sweep(Set<String> savedOrigins) {
        PushLedger ledger = ledger();
        List<String> dropped = new ArrayList<>();
        for (String id : ledger.bindingIds()) {
            String origin = ledger.origin(id);
            if (!savedOrigins.contains(origin)) { ledger.unbindOrigin(origin); dropped.add(id); }
        }
        if (!dropped.isEmpty() && !prefs.edit().putString("ledger.v1", ledger.encode()).commit()) ShellLog.i("push sweep deferred");
        Set<String> owned = new HashSet<>(ledger.bindingIds());
        SharedPreferences.Editor edit = prefs.edit();
        int stray = 0;
        Set<String> orphans = new TreeSet<>();
        for (String name : prefs.getAll().keySet()) {
            if (name.startsWith("expires.") && !owned.contains(name.substring(8))) { edit.remove(name); stray++; continue; } // no relay binding of its own
            String id = name.startsWith("detail.") ? name.substring(7) : name.startsWith("respond.") ? name.substring(8) : null;
            if (id != null && !owned.contains(id)) { edit.remove(name); stray++; if (!dropped.contains(id)) orphans.add(id); }
        }
        if (stray > 0 && !edit.commit()) ShellLog.i("push sweep deferred");
        if (!dropped.isEmpty() || stray > 0) ShellLog.i("push sweep dropped=" + dropped.size() + " tokens=" + stray);
        dropped.addAll(orphans);
        return dropped;
    }
}
