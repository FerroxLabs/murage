package com.murage.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

/** The foreground refresh's schedule: once a day, with a backoff after a failure. */
public class PushRefreshPolicyTest {
    private static final long HOUR = 3_600_000L;
    private static final long MIN = 60_000L;

    static final class Memory implements KeyValueStore {
        final Map<String, String> values = new HashMap<>();
        @Override public String get(String key) { return values.get(key); }
        @Override public void put(String key, String value) { if (value == null) values.remove(key); else values.put(key, value); }
    }

    @Test public void dueOnTheFirstForegroundAndAfter24Hours() {
        Memory store = new Memory();
        PushRefreshPolicy p = new PushRefreshPolicy(store);
        long t = 1_000_000_000_000L;
        assertTrue(p.due(t));
        p.succeeded(t);
        assertFalse(p.due(t + 23 * HOUR));
        assertTrue(p.due(t + 24 * HOUR));
        assertFalse(new PushRefreshPolicy(store).due(t + 1 * HOUR)); // survives a new process
    }

    @Test public void aFailureBacksOffAndDoesNotCountAsARefresh() {
        PushRefreshPolicy p = new PushRefreshPolicy(new Memory());
        long t = 1_000_000_000_000L;
        p.failed(t);
        assertFalse(p.due(t));
        assertFalse(p.due(t + 14 * MIN));
        assertTrue(p.due(t + 16 * MIN));
        p.failed(t + 16 * MIN);
        assertFalse(p.due(t + 16 * MIN + 29 * MIN));
        assertTrue(p.due(t + 16 * MIN + 31 * MIN));
        p.succeeded(t + 60 * MIN);
        assertFalse(p.due(t + 61 * MIN));
    }

    @Test public void theBackoffIsCappedAtSixHours() {
        assertEquals(15 * MIN, PushRefreshPolicy.backoffMs(1));
        assertEquals(30 * MIN, PushRefreshPolicy.backoffMs(2));
        assertEquals(6 * HOUR, PushRefreshPolicy.backoffMs(50));
    }

    @Test public void aClockThatMovedBackDoesNotLockTheRefreshOut() {
        PushRefreshPolicy p = new PushRefreshPolicy(new Memory());
        long t = 1_000_000_000_000L;
        p.succeeded(t);
        assertTrue(p.due(t - 2 * 24 * HOUR));
    }
}
