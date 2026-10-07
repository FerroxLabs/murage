package com.murage.mobile;

import androidx.annotation.WorkerThread;
import com.murage.mobile.shell.DownloadGate;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.MalformedURLException;
import java.net.URL;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * A server file fetched with the workspace's cookie (P20 ruling). Not
 * DownloadManager: its DownloadThread re-adds every request header, Cookie
 * included, on each redirect hop to whatever host the Location names, so the
 * session cookie could leave the origin. Here redirects are off and followed
 * by hand, only on the saved origin, at most {@link #MAX_REDIRECTS} times, and
 * the cookie is set only on a request already checked to be on the origin.
 */
final class SameOriginFetch {
    static final int MAX_REDIRECTS = 5;
    private static final int TIMEOUT_MS = 30_000;

    interface Opener {
        HttpURLConnection open(URL url) throws IOException;
    }

    /** The WebView jar's Cookie header for a URL, or null. */
    interface Cookies {
        String forUrl(String url);
    }

    /**
     * Sees each hop's connection as soon as it is opened, before anything is
     * sent, so a cancel can disconnect whichever hop is running; throwing
     * (cancelled, past the deadline) stops the fetch there.
     */
    interface Watch {
        void opened(HttpURLConnection connection) throws IOException;
    }

    /** A reply error code for the page: foreign_url or download_failed. */
    static final class Refused extends Exception {
        final String code;

        Refused(String code) {
            super(code);
            this.code = code;
        }
    }

    private SameOriginFetch() {}

    /** A 2xx response on the saved origin, ready to read; the caller disconnects it. */
    @WorkerThread
    static HttpURLConnection open(String url, WorkspaceOrigin origin, String userAgent, Cookies cookies, Opener opener, Watch watch) throws Refused, IOException {
        String current = url;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            if (!sameOrigin(current, origin)) throw new Refused("foreign_url");
            HttpURLConnection connection = opener.open(new URL(current));
            try {
                watch.opened(connection);
            } catch (IOException | RuntimeException stopped) {
                connection.disconnect();
                throw stopped;
            }
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setConnectTimeout(TIMEOUT_MS);
            connection.setReadTimeout(TIMEOUT_MS);
            connection.setRequestProperty("User-Agent", userAgent);
            String cookie = cookies.forUrl(current);
            if (cookie != null) connection.setRequestProperty("Cookie", cookie);
            int status;
            try {
                status = connection.getResponseCode();
            } catch (IOException | RuntimeException failed) {
                connection.disconnect();
                throw failed;
            }
            if (isRedirect(status)) {
                int locations = locationCount(connection);
                String location = connection.getHeaderField("Location");
                connection.disconnect();
                // None, or several (which one a client follows is not ours to guess): no file.
                if (location == null || locations != 1) throw new Refused("download_failed");
                String next;
                try {
                    next = new URL(new URL(current), location).toString();
                } catch (MalformedURLException bad) {
                    throw new Refused("foreign_url");
                }
                if (!sameOrigin(next, origin)) {
                    ShellLog.i("save redirect refused status=" + status);
                    throw new Refused("foreign_url");
                }
                current = next;
                continue;
            }
            if (!DownloadGate.accept(status)) {
                ShellLog.i("save refused status=" + status);
                connection.disconnect();
                throw new Refused("download_failed");
            }
            return connection;
        }
        ShellLog.i("save refused: too many redirects");
        throw new Refused("download_failed");
    }

    private static int locationCount(HttpURLConnection connection) {
        Map<String, List<String>> fields = connection.getHeaderFields();
        if (fields == null) return 0;
        int count = 0;
        for (Map.Entry<String, List<String>> field : fields.entrySet()) {
            if (field.getKey() != null && "location".equalsIgnoreCase(field.getKey()) && field.getValue() != null) count += field.getValue().size();
        }
        return count;
    }

    /**
     * A MIME type fit for MediaStore: type/subtype of token characters,
     * lower-cased, parameters dropped; anything else is octet-stream. The
     * page's own type (saveFile begin) and a server's Content-Type both pass
     * through here, so neither can make MediaProvider misname the file.
     */
    static String mimeOf(String contentType, String hint) {
        String type = contentType != null ? contentType : hint;
        if (type == null) return "application/octet-stream";
        int semicolon = type.indexOf(';');
        String bare = (semicolon < 0 ? type : type.substring(0, semicolon)).trim().toLowerCase(Locale.ROOT);
        return bare.matches("[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*") ? bare : "application/octet-stream";
    }

    private static boolean isRedirect(int status) {
        return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
    }

    /**
     * The shell's own origin rule on the string, and java.net.URL agreeing on
     * scheme, host and port, since that parse is the one that connects.
     */
    static boolean sameOrigin(String url, WorkspaceOrigin origin) {
        if (!origin.contains(url)) return false;
        try {
            URL parsed = new URL(url);
            int port = parsed.getPort() == -1 ? 443 : parsed.getPort();
            return "https".equals(parsed.getProtocol().toLowerCase(Locale.ROOT))
                && parsed.getUserInfo() == null
                && origin.host.equals(parsed.getHost().toLowerCase(Locale.ROOT))
                && port == origin.port;
        } catch (MalformedURLException bad) {
            return false;
        }
    }
}
