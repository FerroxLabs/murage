package com.murage.mobile;

import java.util.ArrayList;
import java.util.List;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.json.JSONObject;

/** Fakes for the push glue: in-memory keys, a bound store, and a scripted host. */
final class PushFakes {
    static final String BINDING = "11111111-1111-4111-8111-111111111111";
    static final String ORIGIN = "https://mac.tail0000.ts.net:8443";
    static final String DETAIL = "murage_pd_" + "D".repeat(43);
    static final String RESPOND = "murage_pr_" + "R".repeat(43);
    static final String REF = "ab".repeat(32);
    static final String KEY = "cd".repeat(16);
    private PushFakes() {}

    static SecureStore.Keys memoryKey() {
        try {
            KeyGenerator g = KeyGenerator.getInstance("AES");
            g.init(256);
            SecretKey key = g.generateKey();
            return new SecureStore.Keys() {
                @Override public SecretKey existing() { return key; }
                @Override public SecretKey create() { return key; }
            };
        } catch (Exception e) { throw new AssertionError(e); }
    }

    static SecureStore.Keys lockedKey() {
        return new SecureStore.Keys() {
            @Override public SecretKey existing() throws Exception { throw new Exception("user not authenticated"); }
            @Override public SecretKey create() throws Exception { throw new Exception("user not authenticated"); }
        };
    }

    /** A store with BINDING bound to ORIGIN; tokens only when asked. */
    static PushStore bound(FakePrefs prefs, SecureStore.Keys detail, SecureStore.Keys respond, boolean tokens) {
        PushStore store = new PushStore(prefs, detail, respond);
        store.updateLedger(l -> { l.bind(BINDING, ORIGIN); return null; });
        if (tokens && !store.putTokens(BINDING, DETAIL, RESPOND)) throw new AssertionError("tokens not stored");
        return store;
    }

    static final class Call {
        final String method, url, token, body;
        final int timeoutMs;
        Call(String method, String url, String token, JSONObject body, int timeoutMs) {
            this.method = method; this.url = url; this.token = token; this.body = body == null ? null : body.toString(); this.timeoutMs = timeoutMs;
        }
    }

    /** Answers each call in turn from a script; records what was asked. */
    static final class Host implements PushHttp.Caller {
        final List<Call> calls = new ArrayList<>();
        private final List<PushHttp.Answer> script = new ArrayList<>();

        Host answer(Integer status, String json) {
            Object body;
            try { body = json == null ? null : new JSONObject(json); } catch (Exception e) { throw new AssertionError(e); }
            script.add(new PushHttp.Answer(status, body));
            return this;
        }

        @Override public PushHttp.Answer call(String method, String url, String token, JSONObject body, int timeoutMs) {
            calls.add(new Call(method, url, token, body, timeoutMs));
            if (script.isEmpty()) throw new AssertionError("unexpected call " + method);
            return script.remove(0);
        }
    }
}
