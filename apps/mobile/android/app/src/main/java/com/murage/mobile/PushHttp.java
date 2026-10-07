package com.murage.mobile;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/** One bearer request to the host over Tailscale; no cookies, content-free logs. */
final class PushHttp {
    static final int MAX_BODY = 65_536;
    static final class Answer { final Integer status; final Object body; Answer(Integer s, Object b) { status = s; body = b; } }
    /** The seam JVM tests fake: the receiver and the reconciler call through it. */
    interface Caller { Answer call(String method, String url, String token, JSONObject body, int timeoutMs); }
    /**
     * Disconnects a request when its whole deadline passes. The timeouts below bound
     * each connect and each read, so a host that trickles bytes would otherwise keep
     * the worker going long after its caller gave up (A3 review).
     */
    private static final ScheduledExecutorService DEADLINES = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "push-http-deadline");
        t.setDaemon(true);
        return t;
    });
    private PushHttp() {}

    static Answer call(String method, String url, String token, JSONObject body, int timeoutMs) {
        HttpURLConnection c = null;
        ScheduledFuture<?> deadline = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            HttpURLConnection open = c;
            deadline = DEADLINES.schedule(open::disconnect, timeoutMs, TimeUnit.MILLISECONDS);
            c.setRequestMethod(method);
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setUseCaches(false);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("Authorization", "Bearer " + token);
            c.setRequestProperty("Accept", "application/json");
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = c.getOutputStream()) { out.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            }
            int status = c.getResponseCode();
            InputStream in = status < 400 ? c.getInputStream() : c.getErrorStream();
            String text = in == null ? "" : read(in, MAX_BODY);
            Object parsed;
            try { parsed = new JSONObject(text); } catch (Exception notJson) { parsed = null; }
            ShellLog.i("push http method=" + method + " status=" + status);
            return new Answer(status, parsed);
        } catch (Exception unreachable) {
            ShellLog.i("push http unreachable error=" + unreachable.getClass().getSimpleName());
            return new Answer(null, null);
        } finally {
            if (deadline != null) deadline.cancel(false);
            if (c != null) c.disconnect();
        }
    }

    /** At most max bytes (InputStream.readNBytes needs API 33; minSdk is 29). RelayClient reads through this too. */
    static String read(InputStream in, int max) throws java.io.IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while (out.size() < max && (n = s.read(buf, 0, Math.min(buf.length, max - out.size()))) != -1) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
