package com.murage.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/** A5 review Minor 5: overlapping reconcile requests coalesce instead of queuing. */
public class CoalesceTest {
    /** Runs nothing until told: what is "running" is whatever it holds. */
    private static final class Held implements java.util.concurrent.Executor {
        final List<Runnable> tasks = new ArrayList<>();
        @Override public void execute(Runnable r) { tasks.add(r); }
        void runOne() { tasks.remove(0).run(); }
    }

    @Test public void aBurstWhileOneRunsCostsOneMorePassNotOneEach() {
        Held held = new Held();
        int[] passes = {0};
        Coalesce c = new Coalesce(held, () -> passes[0]++);
        c.request();
        for (int i = 0; i < 5; i++) c.request(); // five resumes while the first is still queued or running
        assertEquals(1, held.tasks.size());
        held.runOne();
        assertEquals(2, passes[0]); // the first, then one more for the whole burst
        assertEquals(0, held.tasks.size());
        c.request(); // idle again: a fresh pass
        assertEquals(1, held.tasks.size());
        held.runOne();
        assertEquals(3, passes[0]);
    }

    @Test public void aRequestDuringAPassRunsOnceMoreAfterIt() {
        Held held = new Held();
        int[] passes = {0};
        Coalesce[] self = new Coalesce[1];
        self[0] = new Coalesce(held, () -> { if (passes[0]++ == 0) { self[0].request(); self[0].request(); } });
        self[0].request();
        held.runOne();
        assertEquals(2, passes[0]);
        assertEquals(0, held.tasks.size());
    }

    @Test public void aPassThatThrowsDoesNotStrandTheNextRequest() {
        Held held = new Held();
        int[] passes = {0};
        Coalesce c = new Coalesce(held, () -> { passes[0]++; throw new IllegalStateException("boom"); });
        c.request();
        try { held.runOne(); fail("the pass threw"); } catch (IllegalStateException expected) { /* the executor's problem */ }
        c.request();
        assertEquals(1, held.tasks.size());
    }
}
