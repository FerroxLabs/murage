package com.murage.mobile.shell;

import static org.junit.Assert.*;

import org.junit.Test;

public class InPlaceReloadTest {
    @Test
    public void aPageThatReloadedItselfNeedsNoLoad() {
        InPlaceReload reload = new InPlaceReload();
        long ticket = reload.begin();
        assertFalse(reload.fallBack(ticket, true));
        assertFalse("the timeout after the answer does nothing", reload.fallBack(ticket, false));
    }

    @Test
    public void aPageThatCouldNotLoadsOnce() {
        InPlaceReload reload = new InPlaceReload();
        long ticket = reload.begin();
        assertTrue(reload.fallBack(ticket, false));
        assertFalse(reload.fallBack(ticket, false));
    }

    /** Review Important 1: a hung renderer never answers; the timeout loads, and a late answer does nothing. */
    @Test
    public void theTimeoutLoadsAndALateAnswerIsIgnored() {
        InPlaceReload reload = new InPlaceReload();
        long ticket = reload.begin();
        assertTrue(reload.fallBack(ticket, false));
        assertFalse(reload.fallBack(ticket, false));
        assertFalse(reload.fallBack(ticket, true));
    }

    /** Review Important 2: an older load's late answer never navigates after a newer load(). */
    @Test
    public void aNewerLoadVoidsTheOlderOne() {
        InPlaceReload reload = new InPlaceReload();
        long older = reload.begin();
        long newer = reload.begin();
        assertNotEquals(older, newer);
        assertFalse(reload.fallBack(older, false));
        assertTrue(reload.fallBack(newer, false));
    }

    @Test
    public void nothingBeforeTheFirstLoad() {
        assertFalse(new InPlaceReload().fallBack(0, false));
    }
}
