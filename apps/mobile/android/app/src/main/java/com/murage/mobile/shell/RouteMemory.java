package com.murage.mobile.shell;

/** Spec §3.2 "Persisted state". Twin of RouteMemory.swift. */
public final class RouteMemory {
    static final String PENDING_KEY = "murage.pendingOpen";
    private final KeyValueStore store;

    public RouteMemory(KeyValueStore store) {
        this.store = store;
    }

    private static String routeKey(WorkspaceOrigin origin) {
        return "murage.route." + origin.serialized();
    }

    public boolean remember(String threadId, WorkspaceOrigin origin) {
        if (!OpenHash.valid(threadId)) return false;
        store.put(routeKey(origin), threadId);
        return true;
    }

    public PendingOpen pending() {
        return PendingOpen.fromJson(store.get(PENDING_KEY));
    }

    public boolean setPending(PendingOpen open) {
        if (!OpenHash.valid(open.threadId)) return false;
        store.put(PENDING_KEY, open.toJson());
        return true;
    }

    public void clearPending(WorkspaceOrigin origin) {
        PendingOpen open = pending();
        if (open != null && open.origin.equals(origin.serialized())) store.put(PENDING_KEY, null);
    }

    public void forget(WorkspaceOrigin origin) {
        store.put(routeKey(origin), null);
        clearPending(origin);
    }

    public String startPath(WorkspaceOrigin origin) {
        PendingOpen open = pending();
        if (open != null && open.origin.equals(origin.serialized())) {
            String hash = OpenHash.build(open.threadId, open.messageId);
            if (hash != null) return "/" + hash;
        }
        String hash = OpenHash.build(store.get(routeKey(origin)), null);
        return hash == null ? "/" : "/" + hash;
    }
}
