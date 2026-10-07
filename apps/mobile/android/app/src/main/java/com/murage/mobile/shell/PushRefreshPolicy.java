package com.murage.mobile.shell;

/**
 * The foreground push refresh's schedule. The relay deletes a device row and its
 * bindings after 30 idle days, and only a registration refresh, a delivery or a
 * host publish counts; opening the app does not. So when the app comes to the
 * front the registration is refreshed, at most once every 24 hours. A failure
 * waits 15 minutes, doubling to 6 hours, and only the next foreground after that
 * tries again: no retry loop. Twin of PushRefresh.swift (PushRefresher).
 */
public final class PushRefreshPolicy {
    static final long DAY_MS = 24L * 3_600_000L;
    static final String OK_KEY = "murage.push.refresh.ok";
    static final String FAILURES_KEY = "murage.push.refresh.failures";
    static final String RETRY_KEY = "murage.push.refresh.retryAt";

    private final KeyValueStore store;
    public PushRefreshPolicy(KeyValueStore store) { this.store = store; }

    public static long backoffMs(int failures) {
        int n = Math.max(1, Math.min(failures, 10));
        return Math.min(6L * 3_600_000L, 15L * 60_000L * (1L << (n - 1)));
    }

    /** A clock that moved back before the last success reads as due, never as locked out. */
    public boolean due(long nowMs) {
        long ok = read(OK_KEY), retry = read(RETRY_KEY);
        if (nowMs < retry && retry - nowMs <= 6L * 3_600_000L) return false;
        return ok == 0 || nowMs < ok || nowMs - ok >= DAY_MS;
    }

    public void succeeded(long nowMs) {
        store.put(OK_KEY, Long.toString(nowMs));
        store.put(FAILURES_KEY, null);
        store.put(RETRY_KEY, null);
    }

    public void failed(long nowMs) {
        int failures = (int) read(FAILURES_KEY) + 1;
        store.put(FAILURES_KEY, Integer.toString(failures));
        store.put(RETRY_KEY, Long.toString(nowMs + backoffMs(failures)));
    }

    private long read(String key) {
        try {
            String v = store.get(key);
            return v == null ? 0 : Long.parseLong(v);
        } catch (NumberFormatException bad) {
            return 0;
        }
    }
}
