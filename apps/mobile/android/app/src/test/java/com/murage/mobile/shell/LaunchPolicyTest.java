package com.murage.mobile.shell;

import static org.junit.Assert.*;

import org.junit.Test;

public class LaunchPolicyTest {
    private final WorkspaceOrigin mac = WorkspaceOrigin.parse("https://mac.tailnet123.ts.net");

    private WorkspaceBook book() {
        WorkspaceBook book = new WorkspaceBook();
        book.signedIn(mac, null, 1);
        return book;
    }

    @Test public void opensTheActiveComputerOnceOnAColdStart() {
        assertEquals(mac, LaunchPolicy.autoOpen(book(), false, false, false));
        assertNull(LaunchPolicy.autoOpen(book(), true, false, false)); // Phase 0 surprise 2
        assertNull(LaunchPolicy.autoOpen(book(), false, true, false)); // "Switch computer"
        assertNull(LaunchPolicy.autoOpen(book(), false, false, true)); // a screen is waiting
        assertNull(LaunchPolicy.autoOpen(new WorkspaceBook(), false, false, false));
    }

    @Test public void mainDocumentStatuses() {
        assertEquals(CloseReason.SIGNED_OUT, MainDocument.closeReason(401));
        assertEquals(CloseReason.HOSTERROR, MainDocument.closeReason(502));
        assertEquals(CloseReason.HOSTERROR, MainDocument.closeReason(504));
        assertNull(MainDocument.closeReason(200));
        assertNull(MainDocument.closeReason(404));
        assertNull(MainDocument.closeReason(500));
    }

    /** "/" signs in (may add the computer); any other loaded page but /enter only moves "Last connected" on. */
    @Test public void whatALoadedMainDocumentMeans() {
        assertEquals(MainDocument.Arrival.SIGNED_IN, MainDocument.arrival(200, "/"));
        assertEquals(MainDocument.Arrival.SIGNED_IN, MainDocument.arrival(200, ""));
        assertEquals(MainDocument.Arrival.SIGNED_IN, MainDocument.arrival(200, null));
        assertEquals(MainDocument.Arrival.IN_USE, MainDocument.arrival(200, "/t/abc123"));
        assertEquals(MainDocument.Arrival.IN_USE, MainDocument.arrival(200, "/settings"));
        assertEquals(MainDocument.Arrival.NOTHING, MainDocument.arrival(200, "/enter"));
        assertEquals(MainDocument.Arrival.NOTHING, MainDocument.arrival(401, "/"));
        assertEquals(MainDocument.Arrival.NOTHING, MainDocument.arrival(404, "/t/abc123"));
        assertEquals(MainDocument.Arrival.NOTHING, MainDocument.arrival(502, "/"));
        assertEquals(MainDocument.Arrival.NOTHING, MainDocument.arrival(304, "/"));
    }

    @Test public void closeReasonsAreTheLaunchersNames() {
        StringBuilder names = new StringBuilder();
        for (CloseReason reason : CloseReason.values()) names.append(reason.wire).append(' ');
        assertEquals("unreachable insecure signedOut signOut launcher updateRequired accessoff hosterror ", names.toString());
    }

    @Test public void theIconOverAnotherRootIsAReentry() {
        String main = "android.intent.action.MAIN";
        assertTrue(LaunchPolicy.isLauncherReentry(main, true, false)); // icon over a SWITCH-rooted task
        assertFalse(LaunchPolicy.isLauncherReentry(main, true, true)); // a cold start from the icon
        assertFalse(LaunchPolicy.isLauncherReentry("com.murage.mobile.SWITCH", false, false));
        assertFalse(LaunchPolicy.isLauncherReentry(main, false, false)); // MAIN without LAUNCHER
        assertFalse(LaunchPolicy.isLauncherReentry(null, true, false));
    }

    // B6 (Astra B6): a notification tap for a different computer must not
    // silently end a call in progress on the one already on screen.
    private final WorkspaceOrigin pc = WorkspaceOrigin.parse("https://pc.tailnet123.ts.net");

    @Test public void holdsADifferentComputersNotificationWhileACallIsOpen() {
        assertTrue(LaunchPolicy.mustHoldCrossComputerOpen(mac, true, pc));
    }

    @Test public void neverHoldsTheSameComputersNotification() {
        assertFalse(LaunchPolicy.mustHoldCrossComputerOpen(mac, true, mac));
    }

    @Test public void doesNotHoldADifferentComputerWithNoCallOpen() {
        assertFalse(LaunchPolicy.mustHoldCrossComputerOpen(mac, false, pc));
    }

    @Test public void nothingToProtectWhenNoWorkspaceIsLive() {
        assertFalse(LaunchPolicy.mustHoldCrossComputerOpen(null, true, pc));
    }

    // N-7: a held cross-computer open is dropped on a deliberate return to the launcher, delivered for any other close.
    @Test public void aHeldOpenIsDroppedOnAReturnToTheLauncher() {
        assertFalse(LaunchPolicy.deliversHeldOpenAfter(CloseReason.LAUNCHER));
    }

    @Test public void aHeldOpenIsDeliveredAfterAnyOtherClose() {
        for (CloseReason reason : CloseReason.values()) {
            if (reason != CloseReason.LAUNCHER) assertTrue(reason.name(), LaunchPolicy.deliversHeldOpenAfter(reason));
        }
    }
}
