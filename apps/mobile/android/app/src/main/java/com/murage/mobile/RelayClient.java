package com.murage.mobile;

import com.murage.mobile.shell.WorkspaceOrigin;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/**
 * The relay's phone routes (Plan 3a R3). Blocking; call off the main thread.
 * Redirects are never followed, so the device secret only ever goes to the
 * relay itself. Logs carry the route template and the status only.
 */
final class RelayClient {
    /** Decision 4 with Plan 3a's correction: the relay lives on workers.dev until murage.ai moves accounts. */
    static final String DEFAULT_ORIGIN = "https://murage-push-relay.sean-874.workers.dev";
    static volatile String ORIGIN = DEFAULT_ORIGIN;
    /** Decision 5: Debug registers as development (the relay admits the debug signing key there). */
    static final String ENVIRONMENT = BuildConfig.DEBUG ? "development" : "production";
    private static final int TIMEOUT_MS = 15_000;
    /** The whole request, end to end (tests shorten it). */
    static volatile long DEADLINE_MS = 15_000;
    private static final ExecutorService POOL = Executors.newCachedThreadPool();
    private static final int MAX_BODY = 16_384;

    static final class Answer {
        final int status; final JSONObject body;
        Answer(int status, JSONObject body) { this.status = status; this.body = body; }
    }
    private RelayClient() {}

    /** Debug builds only (MainActivity's murage.relay extra): an https origin, or nothing changes. */
    static String overrideOrigin(String value) {
        if (!BuildConfig.DEBUG) return null;
        WorkspaceOrigin origin = WorkspaceOrigin.parse(value);
        if (origin == null) return null;
        ORIGIN = origin.serialized();
        return ORIGIN;
    }

    /** The route as a template: never a binding id. */
    private static String route(String method, String path) {
        return method + " " + (path.startsWith("/v1/bindings/") ? "/v1/bindings/:id" : path);
    }

    /**
     * Status 0 and an empty body when the relay could not be reached or the
     * whole request (connect, send, read) took longer than DEADLINE_MS: the
     * connect and read timeouts alone would let a trickling answer run on.
     */
    static Answer call(String method, String path, String secret, JSONObject body) {
        AtomicReference<HttpURLConnection> open = new AtomicReference<>();
        Future<Answer> answer = POOL.submit(() -> attempt(open, method, path, secret, body));
        try {
            return answer.get(DEADLINE_MS, TimeUnit.MILLISECONDS);
        } catch (TimeoutException late) {
            ShellLog.i("relay timeout route=" + route(method, path) + " ms=" + DEADLINE_MS);
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
        } catch (Exception failed) {
            ShellLog.i("relay failed route=" + route(method, path) + " error=" + failed.getClass().getSimpleName());
        }
        answer.cancel(true);
        HttpURLConnection c = open.get();
        if (c != null) c.disconnect(); // unblocks a read in progress
        return new Answer(0, new JSONObject());
    }

    private static Answer attempt(AtomicReference<HttpURLConnection> open, String method, String path, String secret, JSONObject body) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(ORIGIN + path).openConnection();
            open.set(c);
            c.setRequestMethod(method);
            c.setConnectTimeout(TIMEOUT_MS);
            c.setReadTimeout(TIMEOUT_MS);
            c.setUseCaches(false);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("Accept", "application/json");
            if (secret != null) c.setRequestProperty("Authorization", "Bearer " + secret);
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = c.getOutputStream()) { out.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            }
            int status = c.getResponseCode();
            InputStream in = status < 400 ? c.getInputStream() : c.getErrorStream();
            JSONObject parsed;
            try { parsed = new JSONObject(in == null ? "" : PushHttp.read(in, MAX_BODY)); } catch (Exception notJson) { parsed = new JSONObject(); }
            ShellLog.i("relay route=" + route(method, path) + " status=" + status);
            return new Answer(status, parsed);
        } catch (Exception unreachable) {
            ShellLog.i("relay unreachable route=" + route(method, path) + " error=" + unreachable.getClass().getSimpleName());
            return new Answer(0, new JSONObject());
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
