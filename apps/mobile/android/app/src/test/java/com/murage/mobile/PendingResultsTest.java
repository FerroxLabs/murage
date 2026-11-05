package com.murage.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.net.Uri;
import android.webkit.ValueCallback;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/** R4-01: a result that arrives after the workspace closed delivers no files and starts no registration. */
public class PendingResultsTest {
    private static final class Answers implements ValueCallback<Uri[]> {
        final List<Uri[]> got = new ArrayList<>();
        @Override public void onReceiveValue(Uri[] value) { got.add(value); }
    }

    @Test public void anOpenWorkspaceGetsTheFilesAndRunsTheRegistrations() {
        PendingResults pending = new PendingResults();
        Answers answers = new Answers();
        Uri[] picked = new Uri[0];
        pending.awaitFiles(answers);
        pending.deliverFiles(true, picked);
        assertEquals(1, answers.got.size());
        assertTrue(answers.got.get(0) == picked);
        int[] ran = {0};
        assertTrue(pending.awaitPush(() -> ran[0]++));
        assertFalse(pending.awaitPush(() -> ran[0]++));
        pending.runPushes(true);
        assertEquals(2, ran[0]);
        assertFalse(pending.pushWaiting());
    }

    @Test public void closeThenResultDeliversNoFilesAndRunsNoRegistration() {
        PendingResults pending = new PendingResults();
        Answers answers = new Answers();
        int[] ran = {0};
        pending.awaitFiles(answers);
        pending.awaitPush(() -> ran[0]++);
        pending.settle(); // close() / closeFromShell()
        assertEquals(1, answers.got.size());
        assertNull(answers.got.get(0)); // the page is answered with nothing
        pending.deliverFiles(false, new Uri[0]); // the late picker result
        pending.runPushes(false); // the late prompt result
        assertEquals(1, answers.got.size()); // not answered twice
        assertEquals(0, ran[0]);
        assertFalse(pending.pushWaiting());
    }

    @Test public void aResultThatBeatsTheSettleStillDeliversNothingOnceClosed() {
        PendingResults pending = new PendingResults();
        Answers answers = new Answers();
        int[] ran = {0};
        pending.awaitFiles(answers);
        pending.awaitPush(() -> ran[0]++);
        pending.deliverFiles(false, new Uri[0]); // gate already closed
        pending.runPushes(false);
        assertEquals(1, answers.got.size());
        assertNull(answers.got.get(0));
        assertEquals(0, ran[0]);
    }

    @Test public void aSecondChooserAnswersTheFirstWithNothing() {
        PendingResults pending = new PendingResults();
        Answers first = new Answers();
        Answers second = new Answers();
        pending.awaitFiles(first);
        pending.awaitFiles(second);
        assertEquals(1, first.got.size());
        assertNull(first.got.get(0));
        assertEquals(0, second.got.size());
    }
}
