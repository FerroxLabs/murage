package com.murage.mobile;

import com.murage.mobile.shell.*;
import java.io.*;
import java.net.*;

/** No cookies, redirect following, response text display, or WebView access. */
final class PhoneShareHTTP implements ShareOutbox.Transport, ShareTargets.Fetch {
    interface Connections { HttpURLConnection open(URL url) throws IOException; }
    private final Connections connections;
    private final Runnable clearCookies;
    private final String userAgent;
    PhoneShareHTTP() { this(url -> (HttpURLConnection) url.openConnection(), () -> CookieHandler.setDefault(null), Shell.USER_AGENT_TOKEN); }
    PhoneShareHTTP(Connections connections, Runnable clearCookies, String userAgent) {
        this.connections = connections; this.clearCookies = clearCookies; this.userAgent = userAgent;
    }
    @Override public ShareOutbox.Call create(WorkspaceOrigin origin, String token, File body, String boundary) {
        return new Request(origin, token, "/api/phones/self/share", body, ShareMultipartWriter.contentType(boundary), 15000);
    }
    @Override public ShareTargets.Response get(WorkspaceOrigin origin, String token) throws Exception {
        return new Request(origin, token, "/api/phones/self/targets", null, null, 5000).execute();
    }
    private final class Request implements ShareOutbox.Call {
        private final WorkspaceOrigin origin;
        private final String token, path, contentType;
        private final File body;
        private final int timeout;
        private boolean cancelled;
        private HttpURLConnection connection;
        Request(WorkspaceOrigin origin, String token, String path, File body, String contentType, int timeout) {
            this.origin = origin; this.token = token; this.path = path; this.body = body; this.contentType = contentType; this.timeout = timeout;
        }
        @Override public void cancel() {
            HttpURLConnection active;
            synchronized (this) { cancelled = true; active = connection; }
            if (active != null) active.disconnect();
        }
        private synchronized void check() throws IOException { if (cancelled) throw new IOException("cancelled"); }
        @Override public ShareTargets.Response execute() throws Exception {
            final HttpURLConnection c;
            synchronized (this) {
                check(); clearCookies.run();
                c = connections.open(new URL(origin.serialized() + path)); connection = c;
                c.setInstanceFollowRedirects(false); c.setUseCaches(false);
                c.setConnectTimeout(timeout); c.setReadTimeout(timeout);
                c.setRequestMethod(body == null ? "GET" : "POST");
                c.setRequestProperty("Authorization", "Bearer " + token);
                c.setRequestProperty("User-Agent", userAgent);
                c.setRequestProperty("Accept", "application/json");
                if (body != null) {
                    c.setDoOutput(true); c.setFixedLengthStreamingMode(body.length()); c.setRequestProperty("Content-Type", contentType);
                }
            }
            // A deadline bounds the whole request, including providers/peers that dribble bytes.
            java.util.Timer deadline = new java.util.Timer(true);
            deadline.schedule(new java.util.TimerTask() { @Override public void run() { Request.this.cancel(); } }, timeout);
            try {
                check();
                if (body != null) try (InputStream in = new FileInputStream(body); OutputStream out = c.getOutputStream()) {
                    byte[] buffer = new byte[32768]; int n;
                    while ((n = in.read(buffer)) != -1) { check(); out.write(buffer, 0, n); }
                }
                check(); int status = c.getResponseCode();
                // Authentication failures are returned even when the peer supplies no readable body.
                if (status == 401 || status == 403) return new ShareTargets.Response(status, null);
                String answer = null;
                try (InputStream in = status < 400 ? c.getInputStream() : c.getErrorStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                    if (in != null) {
                        byte[] buffer = new byte[8192]; int n; int limit = body == null ? 2 * 1024 * 1024 : 65536;
                        while ((n = in.read(buffer)) != -1) {
                            check(); if (out.size() + n > limit) throw new IOException("answer limit"); out.write(buffer, 0, n);
                        }
                        answer = out.toString("UTF-8");
                    }
                } catch (IOException unreadable) { /* Preserve the status; malformed answers use the outcome table. */ }
                return new ShareTargets.Response(status, answer);
            } catch (HttpRetryException response) {
                // Streaming mode may surface an authentication response as an exception.
                // Return its status to the common revocation gate; never replay Authorization here.
                return new ShareTargets.Response(response.responseCode(), null);
            } finally { deadline.cancel(); c.disconnect(); synchronized (this) { connection = null; } }
        }
    }
}
