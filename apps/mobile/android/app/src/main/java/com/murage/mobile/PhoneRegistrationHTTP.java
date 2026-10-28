package com.murage.mobile;

import com.murage.mobile.shell.PhoneJobsContract;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

final class PhoneRegistrationHTTP {
    static void send(WorkspaceOrigin workspace, String method, String token, JSONObject body) throws Exception {
        if (!PhoneJobsContract.tokenValid(token) || !("PUT".equals(method) || "DELETE".equals(method))) throw new IllegalArgumentException();
        ProbeClient.dropCookieHandler();
        HttpURLConnection c = (HttpURLConnection) new URL(workspace.serialized() + "/api/phones/self").openConnection();
        try {
            c.setConnectTimeout(8000); c.setReadTimeout(8000); c.setUseCaches(false); c.setInstanceFollowRedirects(false);
            c.setRequestMethod(method); c.setRequestProperty("Authorization", "Bearer " + token);
            c.setRequestProperty("Accept", "application/json");
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json"); c.setFixedLengthStreamingMode(bytes.length);
                try (java.io.OutputStream out = c.getOutputStream()) { out.write(bytes); }
            }
            if (c.getResponseCode() != 200) throw new java.io.IOException();
        } finally { c.disconnect(); }
    }
}
