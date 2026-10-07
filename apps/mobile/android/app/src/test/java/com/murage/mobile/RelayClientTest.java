package com.murage.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;

/** The relay's HTTP client against a loopback fake (never the live relay). */
public class RelayClientTest {
    private static final String SECRET = "murage_ds_" + "S".repeat(43);
    private final LogCapture log = new LogCapture();
    private final List<String> requests = new CopyOnWriteArrayList<>();
    private ServerSocket server;

    @After public void stop() throws Exception {
        if (server != null) server.close();
        RelayClient.ORIGIN = RelayClient.DEFAULT_ORIGIN;
        RelayClient.DEADLINE_MS = 15_000;
    }

    /** One-thread HTTP/1.1 on loopback; records "METHOD path|auth|content-type|body" per request. */
    private String serve(String head, String body) throws Exception {
        ServerSocket listening = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
        server = listening;
        Thread t = new Thread(() -> {
            while (!listening.isClosed()) {
                try (Socket s = listening.accept()) {
                    BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
                    String line = in.readLine();
                    String request = line.substring(0, line.lastIndexOf(' '));
                    String auth = "", type = "";
                    int length = 0;
                    while ((line = in.readLine()) != null && !line.isEmpty()) {
                        if (line.regionMatches(true, 0, "Authorization:", 0, 14)) auth = line.substring(14).trim();
                        if (line.regionMatches(true, 0, "Content-Type:", 0, 13)) type = line.substring(13).trim();
                        if (line.regionMatches(true, 0, "Content-Length:", 0, 15)) length = Integer.parseInt(line.substring(15).trim());
                    }
                    char[] sent = new char[length];
                    int read = 0;
                    while (read < length) read += in.read(sent, read, length - read);
                    requests.add(request + "|" + auth + "|" + type + "|" + new String(sent));
                    byte[] out = body.getBytes(StandardCharsets.UTF_8);
                    OutputStream o = s.getOutputStream();
                    o.write((head + "\r\nContent-Type: application/json\r\nContent-Length: " + out.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
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

    @Test public void theDefaultIsTheDeployedRelay() {
        assertEquals("https://murage-push-relay.sean-874.workers.dev", RelayClient.DEFAULT_ORIGIN);
    }

    @Test public void sendsJsonWithTheBearerAndReadsTheAnswer() throws Exception {
        RelayClient.ORIGIN = serve("HTTP/1.1 201 Created", "{\"bindingId\":\"b\",\"grant\":\"g\"}");
        RelayClient.Answer a = RelayClient.call("PUT", "/v1/devices/self/token", SECRET, new JSONObject().put("pushToken", "t".repeat(20)));
        assertEquals(201, a.status);
        assertEquals("b", a.body.getString("bindingId"));
        assertEquals("PUT /v1/devices/self/token|Bearer " + SECRET + "|application/json|{\"pushToken\":\"" + "t".repeat(20) + "\"}", requests.get(0));
        assertTrue(log.all().contains("relay route=PUT /v1/devices/self/token status=201"));
        assertFalse(log.all().contains(SECRET));
    }

    @Test public void noSecretMeansNoAuthorizationHeader() throws Exception {
        RelayClient.ORIGIN = serve("HTTP/1.1 201 Created", "{\"challenge\":\"c\"}");
        assertEquals(201, RelayClient.call("POST", "/v1/challenges", null, null).status);
        assertTrue(requests.get(0).startsWith("POST /v1/challenges||"));
    }

    @Test public void aRedirectIsNeverFollowed() throws Exception {
        String origin = serve("HTTP/1.1 307 Temporary Redirect\r\nLocation: /elsewhere", "{}");
        RelayClient.ORIGIN = origin;
        RelayClient.Answer a = RelayClient.call("DELETE", "/v1/bindings/0b0e7a52-2f0c-4a54-9d6e-4c0b3f4f6a11", SECRET, null);
        assertEquals(307, a.status);
        Thread.sleep(200);
        assertEquals(1, requests.size());
        assertTrue(log.all().contains("relay route=DELETE /v1/bindings/:id status=307"));
        assertFalse(log.all().contains("0b0e7a52"));
    }

    @Test public void anErrorBodyIsReadAndANonJsonBodyIsEmpty() throws Exception {
        RelayClient.ORIGIN = serve("HTTP/1.1 409 Conflict", "{\"error\":\"token_in_use\"}");
        RelayClient.Answer a = RelayClient.call("PUT", "/v1/devices/self/token", SECRET, new JSONObject());
        assertEquals(409, a.status);
        assertEquals("token_in_use", a.body.getString("error"));
        stop();
        RelayClient.ORIGIN = serve("HTTP/1.1 502 Bad Gateway", "<html>");
        assertEquals(0, RelayClient.call("POST", "/v1/bindings", SECRET, null).body.length());
    }

    @Test public void anUnreachableRelayIsStatusZero() throws Exception {
        int closed;
        try (ServerSocket s = new ServerSocket(0)) { closed = s.getLocalPort(); }
        RelayClient.ORIGIN = "http://127.0.0.1:" + closed;
        RelayClient.Answer a = RelayClient.call("POST", "/v1/challenges", null, null);
        assertEquals(0, a.status);
        assertEquals(0, a.body.length());
        assertTrue(log.all().contains("relay unreachable route=POST /v1/challenges"));
    }

    @Test public void theDebugOverrideTakesOnlyAnHttpsOrigin() {
        assertNull(RelayClient.overrideOrigin("http://relay.example"));
        assertNull(RelayClient.overrideOrigin("https://user@relay.example"));
        assertNull(RelayClient.overrideOrigin("not a url"));
        assertEquals(RelayClient.DEFAULT_ORIGIN, RelayClient.ORIGIN);
        assertEquals("https://relay.example:8443", RelayClient.overrideOrigin("https://Relay.Example:8443/ignored"));
        assertEquals("https://relay.example:8443", RelayClient.ORIGIN);
    }
    @Test public void theWholeRequestHasADeadline() throws Exception {
        // Listening but never answering: connect succeeds, the read would wait out its own 15 s.
        server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
        RelayClient.ORIGIN = "http://127.0.0.1:" + server.getLocalPort();
        RelayClient.DEADLINE_MS = 300;
        long start = System.nanoTime();
        RelayClient.Answer a = RelayClient.call("POST", "/v1/bindings", SECRET, null);
        assertEquals(0, a.status);
        assertTrue(java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) < 3000);
        assertTrue(log.all().contains("relay timeout route=POST /v1/bindings ms=300"));
        assertFalse(log.all().contains(SECRET));
    }
}
