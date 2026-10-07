package com.murage.mobile.shell;

import static org.junit.Assert.*;

import org.junit.Test;

public class OriginReturnTest {
    @Test public void goesBackToThePageTheForeignPostReplaced() {
        OriginReturn r = new OriginReturn();
        assertEquals(OriginReturn.Action.SEND_OUT_AND_RETURN, r.left());
        assertEquals(OriginReturn.Action.GO_BACK, r.run(true));
        assertEquals(OriginReturn.Action.NONE, r.landed(true));
        assertFalse(r.returning());
    }

    @Test public void withNoHistoryReloadsAndClearsOnceFinished() {
        OriginReturn r = new OriginReturn();
        r.left();
        assertEquals(OriginReturn.Action.RELOAD, r.run(false));
        assertFalse(r.reloaded(false)); // a foreign finish is not the reload
        assertTrue(r.reloaded(true));
        assertFalse(r.returning());
    }

    @Test public void aForeignPushStateBackEntryIsNeverShown() {
        OriginReturn r = new OriginReturn();
        r.left();
        r.run(true);
        // goBack lands on the foreign page's own same-document entry: no onPageStarted
        assertEquals(OriginReturn.Action.RELOAD, r.landed(false));
        assertTrue(r.reloaded(true));
    }

    @Test public void aDoubleLoadGoesBackOnceAndIsSentOutOnce() {
        OriginReturn r = new OriginReturn();
        assertEquals(OriginReturn.Action.SEND_OUT_AND_RETURN, r.left());
        assertEquals(OriginReturn.Action.STOP, r.left()); // the foreign page submits again
        assertEquals(OriginReturn.Action.GO_BACK, r.run(true));
        assertEquals(OriginReturn.Action.NONE, r.run(true)); // no second goBack
    }

    @Test public void aForeignBackEntryReloadsWithoutOpeningAgain() {
        OriginReturn r = new OriginReturn();
        r.left();
        r.run(true);
        // going back starts a foreign cross-document entry: no second browser tab
        assertEquals(OriginReturn.Action.RELOAD, r.left());
        assertEquals(OriginReturn.Action.RELOAD, r.left());
        assertEquals(OriginReturn.Action.NONE, r.landed(true)); // only reloaded() ends a reload
        assertTrue(r.reloaded(true));
    }

    @Test public void landingOnEnterReloadsTheRoute() {
        OriginReturn r = new OriginReturn();
        r.left();
        r.run(true);
        assertEquals(OriginReturn.Action.RELOAD, r.landed(false)); // /enter#<spent token> is not allowed
    }

    @Test public void idleNavigationIsNotItsBusiness() {
        OriginReturn r = new OriginReturn();
        assertEquals(OriginReturn.Action.NONE, r.landed(false));
        assertEquals(OriginReturn.Action.NONE, r.run(true));
        assertFalse(r.reloaded(true));
        assertFalse(r.returning());
    }
}
