package com.murage.mobile;

import androidx.annotation.WorkerThread;
import com.murage.mobile.shell.ProbeVerdict;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.CookieHandler;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Spec §3.1 "Reachability probe": GET /healthz with native HTTP, no cookies
 * (Decision 4). HttpURLConnection uses the process-wide CookieHandler, and
 * Capacitor's always-loaded CapacitorCookies plugin installs one backed by
 * the WebView's cookie jar. MainActivity removes it after the bridge starts,
 * and the probe removes it again before connecting, so no workspace cookie
 * is ever sent or stored by the probe.
 */
final class ProbeClient {
    /** The real reply is a few dozen bytes; anything past this is not a Murage door. */
    static final int MAX_BODY = 4096;
    private static final int TIMEOUT_MS = 8_000;

    private ProbeClient() {}

    @WorkerThread
    static ProbeVerdict probe(WorkspaceOrigin origin, String userAgent) {
        long started = System.currentTimeMillis();
        dropCookieHandler();
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(origin.serialized() + "/healthz").openConnection();
            connection.setConnectTimeout(TIMEOUT_MS);
            connection.setReadTimeout(TIMEOUT_MS);
            connection.setUseCaches(false);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("User-Agent", userAgent);
            connection.setRequestProperty("Accept", "application/json");
            int status = connection.getResponseCode();
            String body = status == 200 ? readCapped(connection.getInputStream(), started + 2L * TIMEOUT_MS) : null;
            ProbeVerdict verdict = ProbeVerdict.classify(status, body, null);
            ShellLog.i("probe host=" + origin.host + " status=" + status + " mode=" + verdict.mode() + " ms=" + (System.currentTimeMillis() - started));
            return verdict;
        } catch (IOException | RuntimeException failed) {
            // SSLHandshakeException and SSLPeerUnverifiedException are IOExceptions: ProbeVerdict makes them INSECURE.
            ProbeVerdict verdict = ProbeVerdict.classify(null, null, failed);
            ShellLog.i("probe host=" + origin.host + " error=" + failed.getClass().getSimpleName() + " mode=" + verdict.mode() + " ms=" + (System.currentTimeMillis() - started));
            return verdict;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** Nothing in this app uses a java.net cookie handler; one here would be Capacitor's, over the WebView jar. */
    static synchronized void dropCookieHandler() {
        if (CookieHandler.getDefault() != null) {
            ShellLog.i("probe dropped a cookie handler");
            CookieHandler.setDefault(null);
        }
    }

    /**
     * The body as UTF-8, or null (read as basic mode) when it is longer than
     * MAX_BODY or still arriving at the deadline. Never reads more than
     * MAX_BODY + 1 bytes, so a hostile door cannot make the phone buffer more.
     */
    static String readCapped(InputStream in, long deadlineMillis) throws IOException {
        try (InputStream stream = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[1024];
            int total = 0;
            while (total <= MAX_BODY) {
                if (System.currentTimeMillis() > deadlineMillis) return null;
                int n = stream.read(buffer, 0, Math.min(buffer.length, MAX_BODY + 1 - total));
                if (n == -1) return out.toString(StandardCharsets.UTF_8.name());
                out.write(buffer, 0, n);
                total += n;
            }
            return null;
        }
    }
}
