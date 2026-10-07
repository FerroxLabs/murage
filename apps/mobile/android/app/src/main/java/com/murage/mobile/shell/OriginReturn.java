package com.murage.mobile.shell;

/**
 * P26 F1: a main frame that left the saved origin (a foreign form POST, which
 * shouldOverrideUrlLoading never sees) has already committed by the time
 * onPageStarted runs, so stopping it is not enough: the workspace goes back to
 * the page it replaced. One return at a time, sent out once, and checked where
 * it lands: a foreign entry (a pushState the foreign page made, a second
 * foreign commit) or the door's /enter page is never shown; the saved route is
 * reloaded instead and the history cleared behind it. Pure, so JUnit drives it.
 */
public final class OriginReturn {
    public enum Action {
        /** Nothing to do. */
        NONE,
        /** Stop the load, send its URL out, and post run(). */
        SEND_OUT_AND_RETURN,
        /** Stop the load only: a return is already on its way. */
        STOP,
        /** Go back one entry. */
        GO_BACK,
        /** Load the saved route; clear the history once it has finished. */
        RELOAD
    }

    private enum Phase { IDLE, LEFT, BACK, RELOAD }

    private Phase phase = Phase.IDLE;

    /** onPageStarted with a URL the main frame may not show. */
    public Action left() {
        switch (phase) {
            case IDLE:
                phase = Phase.LEFT;
                return Action.SEND_OUT_AND_RETURN;
            case LEFT:
                return Action.STOP; // a second commit before the return ran: never a second goBack
            default:
                phase = Phase.RELOAD; // going back reached a foreign entry
                return Action.RELOAD;
        }
    }

    /** The posted return runs. */
    public Action run(boolean canGoBack) {
        if (phase != Phase.LEFT) return Action.NONE;
        phase = canGoBack ? Phase.BACK : Phase.RELOAD;
        return canGoBack ? Action.GO_BACK : Action.RELOAD;
    }

    /**
     * Where going back landed (doUpdateVisitedHistory, which also sees
     * same-document entries, and onPageFinished). allowed: on the saved origin
     * and not the door's /enter page.
     */
    public Action landed(boolean allowed) {
        if (phase != Phase.BACK) return Action.NONE;
        if (allowed) {
            phase = Phase.IDLE;
            return Action.NONE;
        }
        phase = Phase.RELOAD;
        return Action.RELOAD;
    }

    /** onPageFinished: true once the reload has finished on the origin (clear the history now). */
    public boolean reloaded(boolean onOrigin) {
        if (phase != Phase.RELOAD || !onOrigin) return false;
        phase = Phase.IDLE;
        return true;
    }

    public boolean returning() {
        return phase != Phase.IDLE;
    }
}
