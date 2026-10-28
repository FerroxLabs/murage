package com.murage.mobile;

import static org.junit.Assert.*;
import com.murage.mobile.shell.*;
import java.io.*;
import java.net.*;
import java.nio.file.Files;
import org.junit.*;
import org.junit.rules.TemporaryFolder;

public class PhoneShareHTTPTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private static final WorkspaceOrigin ORIGIN = WorkspaceOrigin.parse("https://desk.example.test");
    private static final class Connection extends HttpURLConnection {
        int status = 200, opened, closed; boolean streamAuthFailure;
        ByteArrayOutputStream upload = new ByteArrayOutputStream();
        Connection() throws Exception { super(new URL(ORIGIN.serialized() + "/api/phones/self/share")); }
        public void connect() { opened++; }
        public void disconnect() { closed++; }
        public boolean usingProxy() { return false; }
        public OutputStream getOutputStream() throws IOException {
            opened++;
            if (streamAuthFailure) throw new HttpRetryException("refused", status);
            return upload;
        }
        public int getResponseCode() { return status; }
        public InputStream getInputStream() { return new ByteArrayInputStream("{}".getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
        public InputStream getErrorStream() { return null; }
        long length() { return fixedContentLengthLong; }
    }
    @Test public void postsOneStreamWithNoRedirectsAndNoCredentialInTheBody() throws Exception {
        Connection connection = new Connection(); int[] clears = {0}, opens = {0};
        PhoneShareHTTP http = new PhoneShareHTTP(url -> {
            assertEquals(ORIGIN.serialized() + "/api/phones/self/share", url.toString()); opens[0]++; return connection;
        }, () -> clears[0]++, "test-agent");
        File body = temporary.newFile(); byte[] bytes = new byte[90_000]; Files.write(body.toPath(), bytes);
        ShareTargets.Response result = http.create(ORIGIN, "fresh-token", body, "boundary").execute();
        assertEquals(200, result.status); assertEquals(1, opens[0]); assertEquals(1, clears[0]);
        assertArrayEquals(bytes, connection.upload.toByteArray()); assertEquals(bytes.length, connection.length());
        assertEquals("POST", connection.getRequestMethod()); assertFalse(connection.getInstanceFollowRedirects()); assertFalse(connection.getUseCaches());
        assertEquals("Bearer fresh-token", connection.getRequestProperty("Authorization")); assertNull(connection.getRequestProperty("Cookie"));
        assertEquals(1, connection.closed);
    }
    @Test public void codelessAndStreamingAuthenticationFailuresKeepTheirStatusWithoutRetry() throws Exception {
        for (int status : new int[]{401, 403}) for (boolean streaming : new boolean[]{false, true}) {
            Connection connection = new Connection(); connection.status = status; connection.streamAuthFailure = streaming;
            int[] opens = {0};
            PhoneShareHTTP http = new PhoneShareHTTP(url -> { opens[0]++; return connection; }, () -> {}, "test");
            ShareTargets.Response response = http.create(ORIGIN, "token", temporary.newFile(), "boundary").execute();
            assertEquals(status, response.status); assertNull(response.body); assertEquals(1, opens[0]);
            assertEquals(ShareOutcome.REVOKED, ShareOutcome.read(response.status, response.body));
        }
    }
    @Test public void cancelledBeforeExecutionNeverOpensConnectionAndTargetsHaveFiveSecondDeadline() throws Exception {
        PhoneShareHTTP blocked = new PhoneShareHTTP(url -> { fail("cancelled request"); return null; }, () -> {}, "test");
        ShareOutbox.Call call = blocked.create(ORIGIN, "token", temporary.newFile(), "boundary"); call.cancel();
        try { call.execute(); fail("cancelled"); } catch (IOException expected) { }
        Connection connection = new Connection();
        PhoneShareHTTP http = new PhoneShareHTTP(url -> {
            assertEquals(ORIGIN.serialized() + "/api/phones/self/targets", url.toString()); return connection;
        }, () -> {}, "test");
        assertEquals(200, http.get(ORIGIN, "token").status);
        assertEquals("GET", connection.getRequestMethod()); assertEquals(5000, connection.getReadTimeout()); assertEquals(5000, connection.getConnectTimeout());
    }
}
