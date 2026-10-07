package com.murage.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.junit.Test;

/** The /healthz body read is capped (P13 review carry). */
public class ProbeClientTest {
    private static final long LATER = Long.MAX_VALUE;

    /** Counts what the probe pulls off the wire. */
    private static final class Counting extends ByteArrayInputStream {
        int consumed;

        Counting(byte[] data) {
            super(data);
        }

        @Override public synchronized int read(byte[] b, int off, int len) {
            int n = super.read(b, off, len);
            if (n > 0) consumed += n;
            return n;
        }
    }

    private static byte[] bytes(int size) {
        byte[] data = new byte[size];
        Arrays.fill(data, (byte) 'a');
        return data;
    }

    @Test public void readsASmallReplyWhole() throws IOException {
        String body = "{\"ok\":true,\"mobile\":1,\"name\":\"Studio ✓\"}";
        assertEquals(body, ProbeClient.readCapped(new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)), LATER));
    }

    @Test public void readsExactlyTheCap() throws IOException {
        assertEquals(ProbeClient.MAX_BODY, ProbeClient.readCapped(new ByteArrayInputStream(bytes(ProbeClient.MAX_BODY)), LATER).length());
    }

    @Test public void refusesALongerReplyAndStopsReading() throws IOException {
        Counting huge = new Counting(bytes(10 * 1024 * 1024));
        assertNull(ProbeClient.readCapped(huge, LATER));
        assertEquals(ProbeClient.MAX_BODY + 1, huge.consumed);
    }

    @Test public void givesUpAtTheDeadline() throws IOException {
        assertNull(ProbeClient.readCapped(new ByteArrayInputStream(bytes(10)), System.currentTimeMillis() - 1));
    }

    @Test public void dropsAnyProcessCookieHandlerBeforeProbing() {
        LogCapture log = new LogCapture();
        java.net.CookieHandler.setDefault(new java.net.CookieManager());
        try {
            ProbeClient.dropCookieHandler();
            assertNull(java.net.CookieHandler.getDefault());
            assertTrue(log.all().contains("probe dropped a cookie handler"));
        } finally {
            java.net.CookieHandler.setDefault(null);
        }
    }

    @Test public void closesTheStream() throws IOException {
        boolean[] closed = {false};
        InputStream stream = new ByteArrayInputStream(bytes(3)) {
            @Override public void close() {
                closed[0] = true;
            }
        };
        ProbeClient.readCapped(stream, LATER);
        assertTrue(closed[0]);
    }
}
