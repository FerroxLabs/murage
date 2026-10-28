package com.murage.mobile;

import com.murage.mobile.shell.PhoneJobsContract;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.function.Consumer;
import org.json.JSONObject;

/** UI-thread state machine. IO/prompt adapters always answer on that thread. */
final class PhoneForBotsModel {
    static final String[] ROWS = {"calendar", "contacts", "location", "precise", "alarms", "messages", "calls"};
    static final class Consent {
        boolean enabled, sharing;
        final Set<String> providers = new HashSet<>(), rows = new HashSet<>();
    }
    interface Store {
        Consent read(WorkspaceOrigin workspace) throws Exception;
        void write(WorkspaceOrigin workspace, Consent consent) throws Exception;
        default boolean needsProviderSheet(WorkspaceOrigin workspace, String providerId) throws Exception {
            Consent c = read(workspace);
            return !c.sharing || !c.providers.contains(providerId);
        }
        default void recordProviderConsent(WorkspaceOrigin workspace, String providerId) throws Exception {
            Consent c = read(workspace);
            if (!c.enabled || !c.sharing || providerId == null || providerId.isEmpty()) throw new IllegalStateException();
            c.providers.add(providerId);
            write(workspace, c);
        }
        /** N4 re-reads this AND OS permission at the commit point. */
        default boolean readForCommit(WorkspaceOrigin workspace, String providerId, String capability) throws Exception {
            Consent c = read(workspace);
            return c.enabled && c.sharing && c.providers.contains(providerId) && c.rows.contains(capability);
        }
    }
    interface Done { void finish(Exception error); }
    interface Action { void run(Done done); }
    interface Disclosure { void show(Consumer<Boolean> answer); }
    interface Permissions {
        Object value(String row);
        void request(String row, Runnable done);
    }
    interface Tokens { String read(); void remove() throws Exception; }
    interface Transport { void send(String method, String token, JSONObject body, Done done); }
    interface Metadata { JSONObject get() throws Exception; }
    final WorkspaceOrigin workspace;
    final Store store;
    private final Tokens tokens;
    private final Action mint, available;
    private final Permissions permissions;
    private final Transport http;
    private final Metadata metadata;
    private boolean busy, refreshPending;

    PhoneForBotsModel(WorkspaceOrigin workspace, Store store, Tokens tokens, Action mint, Action available,
                      Permissions permissions, Metadata metadata, Transport http) {
        this.workspace = workspace; this.store = store; this.tokens = tokens; this.mint = mint;
        this.available = available; this.permissions = permissions; this.metadata = metadata; this.http = http;
    }
    Consent state() throws Exception { return store.read(workspace); }
    private interface Work { void run() throws Exception; }
    private void attempt(Work work, Done done) { try { work.run(); } catch (Exception error) { done.finish(error); } }
    private Done begin(Done done) {
        if (busy) { done.finish(new IllegalStateException()); return null; }
        busy = true;
        return error -> { busy = false; done.finish(error); };
    }
    void setMaster(boolean on, Disclosure disclosure, Done completion) {
        Done done = begin(completion);
        if (done == null) return;
        attempt(() -> {
            if (!on) {
                Consent c = state(); c.enabled = false; store.write(workspace, c); synchronize(done); return;
            }
            available.run(error -> {
                if (error != null) { done.finish(error); return; }
                attempt(() -> {
                    if (state().sharing) enable(done);
                    else disclosure.show(allow -> {
                        if (!allow) { done.finish(null); return; }
                        attempt(() -> {
                            Consent c = state(); c.sharing = true; c.providers.clear(); store.write(workspace, c);
                            enable(done);
                        }, done);
                    });
                }, done);
            });
        }, done);
    }
    private void enable(Done done) throws Exception {
        // Complete cleanup if a previous local deletion failed.
        if (!state().enabled && tokens.read() != null) {
            http.send("DELETE", tokens.read(), null, error -> {
                if (error != null) { done.finish(error); return; }
                attempt(() -> { tokens.remove(); mintAndEnable(done); }, done);
            });
        } else mintAndEnable(done);
    }
    private void mintAndEnable(Done done) {
        Done minted = error -> {
            if (error != null) { done.finish(error); return; }
            attempt(() -> {
                Consent c = state(); c.enabled = true; store.write(workspace, c); synchronize(done);
            }, done);
        };
        if (tokens.read() == null) mint.run(minted); else minted.finish(null);
    }
    void setRow(String row, boolean on, Done completion) {
        Done done = begin(completion);
        if (done == null) return;
        attempt(() -> {
            Consent c = state();
            if (!Arrays.asList(ROWS).contains(row) || !c.enabled || !c.sharing) throw new IllegalStateException();
            Runnable save = () -> attempt(() -> {
                Consent latest = state();
                if (on) latest.rows.add(row); else latest.rows.remove(row);
                store.write(workspace, latest); synchronize(done);
            }, done);
            if (on) permissions.request(row, save); else save.run();
        }, done);
    }
    JSONObject registration() throws Exception {
        Consent c = state();
        JSONObject caps = new JSONObject();
        if (c.enabled && c.sharing) for (String row : ROWS) {
            if ("precise".equals(row) || !c.rows.contains(row)) continue;
            Object value = permissions.value(row);
            if (value != null) caps.put(row, "location".equals(row) && !c.rows.contains("precise") ? "approximate" : value);
        }
        JSONObject body = metadata.get().put("protocol", 1).put("capabilities", caps);
        if (!PhoneJobsContract.registrationValid(body)) throw new IllegalArgumentException();
        return body;
    }
    void refresh(Done completion) {
        if (busy) { refreshPending = true; completion.finish(null); return; }
        Done done = begin(completion);
        attempt(() -> synchronize(done), done);
    }
    private void synchronize(Done done) throws Exception {
        refreshPending = false;
        String token = tokens.read();
        if (token == null) { done.finish(null); return; }
        boolean enabled = state().enabled;
        // Capture the bearer for DELETE, but erase it locally before dispatch. Closing
        // the screen or a stopped executor must not leave cleanup waiting on a callback.
        if (!enabled) tokens.remove();
        http.send(enabled ? "PUT" : "DELETE", token, enabled ? registration() : null, error -> {
            attempt(() -> {
                if (error != null) { done.finish(error); return; }
                if (refreshPending) synchronize(done); else done.finish(null);
            }, done);
        });
    }
}
