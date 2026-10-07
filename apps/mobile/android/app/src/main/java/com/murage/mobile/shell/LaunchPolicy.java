package com.murage.mobile.shell;

/** Twin of LaunchPolicy.swift: auto-open once per process (Phase 0 surprise 2). */
public final class LaunchPolicy {
    private LaunchPolicy() {}

    public static WorkspaceOrigin autoOpen(WorkspaceBook book, boolean alreadyAutoOpened, boolean launcherRequested, boolean closePending) {
        if (alreadyAutoOpened || launcherRequested || closePending || book.active() == null) return null;
        WorkspaceOrigin origin = WorkspaceOrigin.parse(book.active());
        return book.entry(origin) == null ? null : origin;
    }

    /**
     * P26 F2: the icon (MAIN + LAUNCHER) arriving in a task whose root is not
     * that intent (the "Switch computer" shortcut, later a notification) makes
     * Android add a fresh launcher on top of the live workspace. That instance
     * finishes at once, which reveals what the task already shows.
     */
    public static boolean isLauncherReentry(String action, boolean hasLauncherCategory, boolean isTaskRoot) {
        return !isTaskRoot && "android.intent.action.MAIN".equals(action) && hasLauncherCategory;
    }

    /**
     * B6 (Astra B6, Android twin of CrossComputerNotification.mustHold):
     * whether a different computer's notification must be held because
     * the current workspace has a call open. startWorkspace closes any
     * other workspace first, which would tear down a live call, so this
     * must be checked before it is called. {@code current} is null when no
     * workspace is live, in which case there is nothing to protect. Same-
     * origin notifications are never held here; WorkspaceActivity's own
     * reloadOrKeepPending() already guards a same-origin reload mid-call.
     */
    public static boolean mustHoldCrossComputerOpen(WorkspaceOrigin current, boolean hasOpenCall, WorkspaceOrigin requested) {
        if (current == null || current.equals(requested)) return false;
        return hasOpenCall;
    }

    /**
     * N-7 (twin of the iOS coordinator): a deliberate trip back to the
     * launcher drops a held cross-computer open (the person chose where to
     * go); any other close delivers it.
     */
    public static boolean deliversHeldOpenAfter(CloseReason reason) {
        return reason != CloseReason.LAUNCHER;
    }
}
