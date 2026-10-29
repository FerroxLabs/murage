package com.murage.mobile;

import com.murage.mobile.shell.PhoneJobsContract;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import org.json.JSONObject;

/** No OkHttp dependency in this app. Independent cancellable connections keep long polls off the actor. */
final class PhoneJobHTTP implements PhoneJobRunner.HTTP {
    private final ExecutorService io = Executors.newCachedThreadPool();
    private final java.util.concurrent.ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor();
    @Override public PhoneJobRunner.Cancel send(WorkspaceOrigin workspace, String token, String method, String suffix,
                                               JSONObject body, int timeoutMillis, Consumer<PhoneJobRunner.Response> done) {
        AtomicBoolean cancelled = new AtomicBoolean();
        AtomicReference<HttpURLConnection> connection = new AtomicReference<>();
        AtomicBoolean completed = new AtomicBoolean();
        java.util.concurrent.ScheduledFuture<?> deadline = deadlines.schedule(() -> {
            if (completed.compareAndSet(false, true)) {
                if (!cancelled.get()) done.accept(new PhoneJobRunner.Response(0, null));
                cancelled.set(true);
                HttpURLConnection c = connection.get(); if (c != null) io.execute(c::disconnect);
            }
        }, timeoutMillis, java.util.concurrent.TimeUnit.MILLISECONDS);
        io.execute(() -> {
            PhoneJobRunner.Response response = new PhoneJobRunner.Response(0, null);
            HttpURLConnection c = null;
            try {
                if (!PhoneJobsContract.tokenValid(token) || cancelled.get()) return;
                ProbeClient.dropCookieHandler();
                c = (HttpURLConnection) new URL(workspace.serialized() + "/api/phones/self" + suffix).openConnection();
                connection.set(c);
                if (cancelled.get()) return;
                c.setConnectTimeout(timeoutMillis); c.setReadTimeout(timeoutMillis);
                c.setUseCaches(false); c.setInstanceFollowRedirects(false); c.setRequestMethod(method);
                c.setRequestProperty("Authorization", "Bearer " + token); c.setRequestProperty("Accept", "application/json");
                if (body != null) {
                    byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                    c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json"); c.setFixedLengthStreamingMode(bytes.length);
                    try (java.io.OutputStream out = c.getOutputStream()) { out.write(bytes); }
                }
                int status = c.getResponseCode(); Object json = null;
                if (status == 200) {
                    long bodyDeadline = System.nanoTime() + timeoutMillis * 1000000L;
                    try (InputStream in = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                        byte[] buffer = new byte[4096]; int n;
                        while ((n = in.read(buffer)) != -1) {
                            if (out.size() + n > 262144 || System.nanoTime() > bodyDeadline) throw new java.io.IOException();
                            out.write(buffer, 0, n);
                        }
                        json = new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
                    }
                }
                response = new PhoneJobRunner.Response(status, json);
            } catch (Exception ignored) { /* No body, token, args or result in logs. */ }
            finally {
                if (c != null) c.disconnect(); deadline.cancel(false);
                if (completed.compareAndSet(false, true) && !cancelled.get()) done.accept(response);
            }
        });
        return () -> { cancelled.set(true); completed.set(true); deadline.cancel(false); HttpURLConnection c = connection.get(); if (c != null) io.execute(c::disconnect); };
    }
}
