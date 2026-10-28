package com.murage.mobile.shell;

/** Shared by targets, share and any native ask caller. No bearer is persisted in a request. */
public interface ShareAccess {
    boolean pending(WorkspaceOrigin origin);
    String token(WorkspaceOrigin origin);
    boolean forget(WorkspaceOrigin origin, String code);
    default void removeShortcuts(WorkspaceOrigin origin) {}
    default String current(WorkspaceOrigin origin) {
        if (pending(origin)) return null;
        try { String value = token(origin); return PhoneAskContract.tokenValid(value) ? value : null; }
        catch (RuntimeException locked) { return null; }
    }
    default boolean revoked(WorkspaceOrigin origin, int status) {
        if (status != 401 && status != 403) return false;
        // Disable published entry points before token/cache cleanup, even if cleanup fails.
        try { removeShortcuts(origin); }
        finally { forget(origin, "revoked"); }
        return true;
    }
}
