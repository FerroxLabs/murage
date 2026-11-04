package com.murage.mobile;

import android.net.Uri;
import android.webkit.ValueCallback;
import java.util.ArrayList;
import java.util.List;

/**
 * What a workspace's page is waiting on from the system: a file chooser's answer and the
 * push registrations queued behind the notification prompt. A result that arrives after
 * the workspace closed delivers nothing and starts nothing (R4-01); closing settles both
 * at once, so no late result can reach a page that has been told the workspace is gone.
 */
final class PendingResults {
    private ValueCallback<Uri[]> files;
    private final List<Runnable> pushes = new ArrayList<>();

    /** The chooser the page opened now; an earlier one still waiting is answered with nothing. */
    void awaitFiles(ValueCallback<Uri[]> callback) {
        if (files != null) files.onReceiveValue(null);
        files = callback;
    }

    /** The chooser could not be launched: forget it without answering (the caller refuses it). */
    void dropFiles() {
        files = null;
    }

    /** The picker's result: delivered only while the workspace is open, otherwise answered with nothing. */
    void deliverFiles(boolean open, Uri[] picked) {
        ValueCallback<Uri[]> callback = files;
        files = null;
        if (callback != null) callback.onReceiveValue(open ? picked : null);
    }

    /** Queues a registration behind the notification prompt; true when it is the first (the prompt must be launched). */
    boolean awaitPush(Runnable registration) {
        pushes.add(registration);
        return pushes.size() == 1;
    }

    boolean pushWaiting() {
        return !pushes.isEmpty();
    }

    /** The notification prompt's answer: the queued registrations run only while the workspace is open. */
    void runPushes(boolean open) {
        List<Runnable> waiting = new ArrayList<>(pushes);
        pushes.clear();
        if (open) for (Runnable go : waiting) go.run();
    }

    /** Closing: the chooser is answered with nothing and the queued registrations are dropped. */
    void settle() {
        ValueCallback<Uri[]> callback = files;
        files = null;
        pushes.clear();
        if (callback != null) callback.onReceiveValue(null);
    }
}
