package com.murage.mobile;

import com.murage.mobile.shell.WorkspaceOrigin;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** The same cookie-free, redirect-free transport policy as the door probe. */
final class PhoneJobsMintHTTP implements PhoneJobsMintClient.Transport {
    private final String userAgent;
    PhoneJobsMintHTTP(String userAgent) { this.userAgent = userAgent; }

    @Override public PhoneJobsMintClient.Response send(WorkspaceOrigin origin, String method, String path, JSONObject body) throws Exception {
        if (!("GET".equals(method) && ("/healthz".equals(path) || path.matches("/api/phones/self/challenge\\?key=[A-Za-z0-9_-]{43}")))
            && !("POST".equals(method) && "/api/phones/self/token".equals(path))) throw new IllegalArgumentException("mint route");
        ProbeClient.dropCookieHandler();
        HttpURLConnection connection = (HttpURLConnection) new URL(origin.serialized() + path).openConnection();
        try {
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setUseCaches(false);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod(method);
            connection.setRequestProperty("User-Agent", userAgent);
            connection.setRequestProperty("Accept", "application/json");
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (java.io.OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            }
            int status = connection.getResponseCode();
            String response = status == 200 ? ProbeClient.readCapped(connection.getInputStream(), System.currentTimeMillis() + 16000) : null;
            return new PhoneJobsMintClient.Response(status, response);
        } finally { connection.disconnect(); }
    }
}
