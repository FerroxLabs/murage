package com.murage.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

/** registerPush's single flight (A4 review Minors 5 and 6): joined calls share a run; an Error cannot strand the key. */
public class SingleFlightTest {
    private final Deque<Runnable> work = new ArrayDeque<>();
    private final SingleFlight<String> flight = new SingleFlight<>(work::add, Runnable::run);

    @Test public void overlappingCallsShareOneRunAndALaterCallStartsANewOne() {
        AtomicInteger runs = new AtomicInteger();
        List<String> answers = new ArrayList<>();
        flight.run("o", answers::add, () -> "first " + runs.incrementAndGet());
        flight.run("o", answers::add, () -> "second " + runs.incrementAndGet());
        assertEquals(1, work.size());
        work.poll().run();
        assertEquals(1, runs.get());
        assertEquals(List.of("first 1", "first 1"), answers);
        flight.run("o", answers::add, () -> "third " + runs.incrementAndGet());
        work.poll().run();
        assertEquals("third 2", answers.get(2));
    }

    @Test public void differentKeysRunApart() {
        List<String> answers = new ArrayList<>();
        flight.run("o", answers::add, () -> "a");
        flight.run("o fresh", answers::add, () -> "b");
        assertEquals(2, work.size());
    }

    @Test public void anErrorAnswersEveryWaiterWithNullAndClearsTheKey() {
        List<String> answers = new ArrayList<>();
        flight.run("o", answers::add, () -> { throw new NoClassDefFoundError("play"); });
        flight.run("o", answers::add, () -> "never");
        try {
            work.poll().run();
            fail("the Error should reach the executor");
        } catch (NoClassDefFoundError expected) {
            // the executor's thread sees it; the waiters are already answered
        }
        assertEquals(2, answers.size());
        assertNull(answers.get(0));
        assertNull(answers.get(1));
        flight.run("o", answers::add, () -> "again");
        assertEquals(1, work.size());
        work.poll().run();
        assertEquals("again", answers.get(2));
        assertTrue(work.isEmpty());
    }
}
