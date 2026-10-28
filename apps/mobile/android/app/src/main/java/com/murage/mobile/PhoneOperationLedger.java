package com.murage.mobile;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Iterator;
import java.util.function.LongSupplier;
import org.json.JSONObject;

/** Only digest, state, OS identifier and timestamp are persisted. Runner serializes writes. */
final class PhoneOperationLedger {
    interface Storage { byte[] read() throws Exception; void write(byte[] data) throws Exception; }
    interface Save { String run() throws Exception; }
    static final long LIFETIME = 7L * 24 * 60 * 60 * 1000;
    private final Storage storage;
    private final LongSupplier now;
    PhoneOperationLedger(Storage storage, LongSupplier now) { this.storage = storage; this.now = now; }
    static String key(String operationId) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(operationId.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (byte b : digest) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return hex.toString();
    }
    synchronized String perform(String operationId, Save save) throws Exception {
        byte[] bytes = storage.read();
        JSONObject rows = bytes == null ? new JSONObject() : new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        JSONObject kept = new JSONObject();
        for (Iterator<String> it = rows.keys(); it.hasNext();) {
            String hash = it.next(); JSONObject entry = rows.getJSONObject(hash);
            String state = entry.getString("state");
            if (!hash.matches("[a-f0-9]{64}") || !("pending".equals(state) || "done".equals(state))
                || ("done".equals(state) && (!entry.has("identifier") || entry.length() != 3))
                || ("pending".equals(state) && entry.length() != 2)) throw new PhoneExecutorSupport.Failure("denied");
            if (now.getAsLong() - entry.getLong("timestamp") < LIFETIME) kept.put(hash, entry);
        }
        String hash = key(operationId);
        if (kept.has(hash)) {
            write(kept);
            JSONObject entry = kept.getJSONObject(hash);
            if (!"done".equals(entry.getString("state"))) throw new PhoneExecutorSupport.Failure("denied");
            return entry.getString("identifier");
        }
        kept.put(hash, PhoneJobRunner.json("state", "pending", "timestamp", now.getAsLong()));
        write(kept);
        String id = save.run();
        if (id == null || id.isEmpty() || id.length() > 256) throw new PhoneExecutorSupport.Failure("invalid_result");
        kept.put(hash, PhoneJobRunner.json("state", "done", "identifier", id, "timestamp", now.getAsLong()));
        write(kept);
        return id;
    }
    private void write(JSONObject rows) throws Exception { storage.write(rows.toString().getBytes(StandardCharsets.UTF_8)); }
    static final class PrivateStorage implements Storage {
        private final SecureStore store;
        private final SecureStore legacy;
        private boolean invalidated;
        PrivateStorage(android.content.Context context, com.murage.mobile.shell.WorkspaceOrigin workspace) {
            this(key -> new SecureStore(context, key), workspace);
        }
        PrivateStorage(PhoneJobsTokenStore.Stores stores, com.murage.mobile.shell.WorkspaceOrigin workspace) {
            store = stores.named("phone-operation-ledger-v2." + PhoneJobsTokenStore.key(workspace));
            legacy = stores.named("phone-operation-ledger-v1");
        }
        synchronized void clear() throws Exception {
            invalidated = true;
            boolean removed = store.remove();
            boolean retired = legacy.remove();
            if (!removed || !retired) throw new PhoneExecutorSupport.Failure("denied");
        }
        public synchronized byte[] read() throws Exception {
            if (invalidated) return null;
            SecureStore.Read r = store.read();
            if (r.state == SecureStore.Read.State.UNREADABLE) throw new PhoneExecutorSupport.Failure("denied");
            return r.state == SecureStore.Read.State.EMPTY ? null : r.bytes;
        }
        public synchronized void write(byte[] bytes) throws Exception {
            if (!invalidated && !store.write(bytes)) throw new PhoneExecutorSupport.Failure("denied");
        }
    }
}
