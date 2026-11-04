package com.murage.mobile.shell;

/**
 * The one place a closing workspace stops being reachable. Once close() is
 * called every page request is turned away (whatever its method) and no event
 * is sent to the page, so a page that outlives its screen, even for a moment,
 * holds no native authority. Used at the top of the channel handler and at the
 * emit() entry, never per method.
 */
public final class BridgeGate {
    private volatile boolean closed;

    /** The workspace has started to close. Irreversible. */
    public void close() {
        closed = true;
    }

    public boolean isClosed() {
        return closed;
    }

    /** True while a page request (any method) may reach native code. */
    public boolean admitsRequest() {
        return !closed;
    }

    /** True while an event may still be sent to the page. */
    public boolean admitsEvent() {
        return !closed;
    }
}
