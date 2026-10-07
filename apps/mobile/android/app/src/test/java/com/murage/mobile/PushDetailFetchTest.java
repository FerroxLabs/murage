package com.murage.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.murage.mobile.shell.PushContract;
import com.murage.mobile.shell.PushOutcome;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;

/** Global Constraints: on ANY detail-fetch failure the generic text stays (FINDINGS.md, Task 0). */
public class PushDetailFetchTest {
    private static final String REF = "ab".repeat(32);
    private static final String TOKEN = "murage_pd_" + "A".repeat(43);
    private static final String RICH = "{\"title\":\"Run tests?\",\"body\":\"The bot wants to run pnpm test\",\"target\":{\"threadId\":\"t-secret\",\"requestId\":\"r1\"}}";
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final LogCapture log = new LogCapture();
    private ServerSocket server;

    @After public void stop() {
        pool.shutdownNow();
        close();
    }

    private void close() {
        try { if (server != null) server.close(); } catch (Exception ignored) {}
        server = null;
    }

    /** A one-thread HTTP/1.1 server on loopback (the JDK's HttpServer is not on Android's test classpath). */
    private String serve(int status, String body, AtomicReference<String> seenPath, AtomicReference<String> seenAuth) throws Exception {
        return serve(status, "", body, seenPath, seenAuth);
    }

    private String serve(int status, String extraHeaders, String body, AtomicReference<String> seenPath, AtomicReference<String> seenAuth) throws Exception {
        ServerSocket listening = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
        server = listening;
        Thread t = new Thread(() -> {
            while (!listening.isClosed()) {
                try (Socket s = listening.accept()) {
                    BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
                    String line = in.readLine();
                    if (seenPath != null && line != null) seenPath.set(line.substring(0, line.lastIndexOf(' ')));
                    while ((line = in.readLine()) != null && !line.isEmpty()) {
                        if (seenAuth != null && line.regionMatches(true, 0, "Authorization:", 0, 14)) seenAuth.set(line.substring(14).trim());
                    }
                    byte[] out = body.getBytes(StandardCharsets.UTF_8);
                    OutputStream o = s.getOutputStream();
                    o.write(("HTTP/1.1 " + status + " X\r\nContent-Type: application/json\r\nContent-Length: " + out.length + "\r\n" + extraHeaders + "Connection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                    o.write(out);
                    o.flush();
                } catch (Exception closed) {
                    return;
                }
            }
        });
        t.setDaemon(true);
        t.start();
        return "http://127.0.0.1:" + listening.getLocalPort();
    }

    private void assertGeneric(PushOutcome.Detail d) {
        assertEquals("Murage", d.title);
        assertEquals("Your attention is needed.", d.body);
        assertNull(d.target);
    }

    private void assertContentFree() {
        String all = log.all();
        assertFalse(all.contains(REF));
        assertFalse(all.contains(TOKEN));
        assertFalse(all.contains("Run tests"));
        assertFalse(all.contains("t-secret"));
    }

    @Test public void a200FromTheDoorRewritesTheText() throws Exception {
        AtomicReference<String> path = new AtomicReference<>(), auth = new AtomicReference<>();
        String origin = serve(200, RICH, path, auth);
        PushOutcome.Detail d = PushDetailFetch.fetch(pool, PushDetailFetch.door(origin, REF, TOKEN), 5000, PushContract.Category.APPROVAL);
        assertEquals("Run tests?", d.title);
        assertEquals("t-secret", d.target.threadId);
        assertEquals("GET /api/mobile/push/" + REF, path.get());
        assertEquals("Bearer " + TOKEN, auth.get());
        assertTrue(log.all().contains("push http method=GET status=200"));
        assertContentFree();
    }

    @Test public void aNon200KeepsTheGenericText() throws Exception {
        for (int status : new int[] {401, 404, 500, 502}) {
            String origin = serve(status, RICH, null, null);
            assertGeneric(PushDetailFetch.fetch(pool, PushDetailFetch.door(origin, REF, TOKEN), 5000, PushContract.Category.APPROVAL));
            close();
        }
        assertContentFree();
    }

    @Test public void aRedirectIsNotFollowedAndKeepsTheGenericText() throws Exception {
        AtomicReference<String> followed = new AtomicReference<>();
        String elsewhere = serve(200, RICH, followed, null);
        ServerSocket target = server;
        server = null;
        for (int status : new int[] {301, 302, 303, 307, 308}) {
            String origin = serve(status, "Location: " + elsewhere + "/api/mobile/push/" + REF + "\r\n", RICH, null, null);
            assertGeneric(PushDetailFetch.fetch(pool, PushDetailFetch.door(origin, REF, TOKEN), 5000, PushContract.Category.APPROVAL));
            close();
        }
        Thread.sleep(100);
        assertNull(followed.get());
        target.close();
        assertContentFree();
    }

    /** Headers at once, then a byte every 100 ms: no single read times out, only the whole deadline can stop it. */
    private String trickle() throws Exception {
        ServerSocket listening = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
        server = listening;
        Thread t = new Thread(() -> {
            try (Socket s = listening.accept()) {
                BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
                String line;
                while ((line = in.readLine()) != null && !line.isEmpty()) { /* headers */ }
                OutputStream o = s.getOutputStream();
                o.write("HTTP/1.1 200 X\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{".getBytes(StandardCharsets.UTF_8));
                o.flush();
                for (int i = 0; i < 100; i++) { Thread.sleep(100); o.write(' '); o.flush(); }
            } catch (Exception closed) {
                // the client hung up: what the deadline is for
            }
        });
        t.setDaemon(true);
        t.start();
        return "http://127.0.0.1:" + listening.getLocalPort();
    }

    @Test public void aTricklingHostIsCutOffAtTheWholeDeadline() throws Exception {
        String origin = trickle();
        long start = System.nanoTime();
        PushHttp.Answer a = PushHttp.call("GET", origin + "/api/mobile/push/" + REF, TOKEN, null, 700);
        long ms = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
        assertNull(a.status);
        assertTrue("took " + ms + " ms", ms < 2500);
        assertContentFree();
    }

    @Test public void theFetchWorkerDoesNotOutliveTheDeadline() throws Exception {
        String origin = trickle();
        CountDownLatch workerDone = new CountDownLatch(1);
        java.util.concurrent.Callable<PushHttp.Answer> door = PushDetailFetch.door(origin, REF, TOKEN, PushHttp::call, 700);
        long start = System.nanoTime();
        assertGeneric(PushDetailFetch.fetch(pool, () -> { try { return door.call(); } finally { workerDone.countDown(); } }, 700, PushContract.Category.APPROVAL));
        assertTrue(workerDone.await(1500, TimeUnit.MILLISECONDS));
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) < 2500);
        assertContentFree();
    }

    @Test public void aNetworkErrorKeepsTheGenericText() throws Exception {
        int closed;
        try (ServerSocket s = new ServerSocket(0)) { closed = s.getLocalPort(); } // nothing listens once it closes
        assertGeneric(PushDetailFetch.fetch(pool, PushDetailFetch.door("http://127.0.0.1:" + closed, REF, TOKEN), 5000, PushContract.Category.APPROVAL));
        assertTrue(log.all().contains("push http unreachable error="));
        assertContentFree();
    }

    @Test public void aThrowingCallKeepsTheGenericText() {
        assertGeneric(PushDetailFetch.fetch(pool, () -> { throw new java.io.IOException("boom " + TOKEN); }, 5000, PushContract.Category.APPROVAL));
        assertTrue(log.all().contains("push detail failed error=ExecutionException"));
        assertContentFree();
    }

    @Test public void aLateAnswerIsCancelledAndTheGenericTextStays() throws Exception {
        CountDownLatch interrupted = new CountDownLatch(1);
        long start = System.nanoTime();
        PushOutcome.Detail d = PushDetailFetch.fetch(pool, () -> {
            try { Thread.sleep(10_000); } catch (InterruptedException e) { interrupted.countDown(); throw e; }
            return new PushHttp.Answer(200, new JSONObject(RICH));
        }, 200, PushContract.Category.APPROVAL);
        assertGeneric(d);
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) < 2000);
        assertTrue(interrupted.await(2, TimeUnit.SECONDS));
        assertTrue(log.all().contains("push detail timeout ms=200"));
        assertContentFree();
    }

    @Test public void anEventRefOutsideTheContractNeverReachesTheUrl() throws Exception {
        AtomicReference<String> path = new AtomicReference<>();
        String origin = serve(200, RICH, path, null);
        for (String bad : new String[] {null, "", "AB".repeat(32), "ab".repeat(31), "ab".repeat(33), "../pending" + "a".repeat(54),
                "ab".repeat(31) + "?x", "ab".repeat(31) + "/.", "ab".repeat(32) + "\n", "pending"}) {
            assertGeneric(PushDetailFetch.fetch(pool, PushDetailFetch.door(origin, bad, TOKEN), 5000, PushContract.Category.APPROVAL));
        }
        Thread.sleep(100);
        assertNull(path.get());
        assertTrue(log.all().contains("push detail refused bad-ref"));
        assertContentFree();
    }

    @Test public void theDeadlineIsFiveSeconds() {
        assertEquals(5000, PushDetailFetch.DEADLINE_MS);
    }

    @Test public void genericTextFollowsTheCategory() {
        assertEquals("A task has finished.", PushDetailFetch.generic(PushContract.Category.DONE).body);
        assertEquals("No longer waiting.", PushDetailFetch.generic(PushContract.Category.RESOLVED).body);
    }
}
