package com.murage.mobile.shell;

/**
 * Twin of InPlaceReload.swift. Which answer to a same-document reload
 * (SameDocument.reloadScript) may still fall back to a plain load: only the
 * first one, the page's or the timeout's, and only for the newest load(), so
 * a hung renderer cannot swallow Retry and an older load's late answer never
 * navigates over a newer one (open-reload review, Important 1 and 2).
 */
public final class InPlaceReload {
    /** A healthy page answers the one-line script in milliseconds; Back waits 500 ms for more work. */
    public static final long TIMEOUT_MS = 1000;

    private long current;
    private boolean settled = true;

    /** Every load() takes a ticket, which voids the tickets before it. */
    public long begin() {
        settled = false;
        return ++current;
    }

    /** True when the caller should load the target itself: this is the first answer for the newest load and the page did not reload. */
    public boolean fallBack(long ticket, boolean reloaded) {
        if (ticket != current || settled) return false;
        settled = true;
        return !reloaded;
    }
}
