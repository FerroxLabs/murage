package com.murage.mobile;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.widget.Toast;
import com.murage.mobile.shell.ChannelException;
import com.murage.mobile.shell.ChunkAssembler;
import com.murage.mobile.shell.FileNames;
import com.murage.mobile.shell.Json;
import com.murage.mobile.shell.SaveRequest;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import org.json.JSONObject;

/**
 * saveFile (spec §3.2; src/lib/save-file.ts) and every download the page
 * starts (Decision 8). Both end in Downloads through MediaStore (minSdk 29).
 *
 * <p>Server files are fetched by {@link SameOriginFetch}, never
 * DownloadManager, so the session cookie never leaves the saved origin (P20
 * ruling). Every page request is answered, success or a code; after
 * {@link #cancelAll} the answer is {@code unavailable}. Callers may be on any
 * thread: the work runs on this controller's own threads and the UI (toasts)
 * is posted to the main thread.
 */
final class SaveController {
    /** A server file that has not finished by then fails (download_failed); the queue moves on. */
    static final long FETCH_DEADLINE_MS = 10 * 60_000;
    private final Context context;
    private final WorkspaceOrigin origin;
    private final String userAgent;
    private final ChunkAssembler assembler;
    private final Handler main = new Handler(Looper.getMainLooper());
    /** Chunked saves, in the page's order. */
    private final ExecutorService disk = Executors.newSingleThreadExecutor();
    /** Server files, one at a time. */
    private final ExecutorService net = Executors.newSingleThreadExecutor();
    private final Set<String> openTransfers = new HashSet<>();
    private final Set<Fetch> fetches = new HashSet<>();
    private boolean closed;

    /** One server file in flight. */
    private static final class Fetch {
        final ChannelBridge.Reply reply;
        final long deadline = SystemClock.elapsedRealtime() + FETCH_DEADLINE_MS;
        volatile boolean cancelled;
        /** The hop in flight, published before it sends anything so cancelAll can disconnect it. */
        volatile HttpURLConnection connection;

        Fetch(ChannelBridge.Reply reply) {
            this.reply = reply;
        }

        boolean expired() {
            return SystemClock.elapsedRealtime() > deadline;
        }

        boolean stopped() {
            return cancelled || expired();
        }
    }

    SaveController(Activity activity, WorkspaceOrigin origin, String userAgent) {
        this.context = activity.getApplicationContext();
        this.origin = origin;
        this.userAgent = userAgent;
        this.assembler = new ChunkAssembler(new CacheSink(context), SystemClock::elapsedRealtime);
    }

    void handle(JSONObject args, ChannelBridge.Reply reply) {
        SaveRequest request;
        try {
            request = SaveRequest.parse(args, origin);
        } catch (ChannelException refused) {
            reply.error(refused.code);
            return;
        }
        if ("url".equals(request.kind)) {
            fetch(request.url, request.filename, null, reply);
            return;
        }
        synchronized (this) {
            if (closed) {
                reply.error("unavailable");
                return;
            }
            try {
                disk.execute(() -> transfer(request, reply));
            } catch (RejectedExecutionException gone) {
                reply.error("unavailable");
            }
        }
    }

    /** begin/chunk/end/abort on the disk thread; the core enforces the caps and the order. */
    private void transfer(SaveRequest request, ChannelBridge.Reply reply) {
        synchronized (this) {
            if (closed) {
                reply.error("unavailable");
                return;
            }
        }
        try {
            switch (request.kind) {
                case "begin":
                    assembler.begin(request.id, request.filename, request.mime, request.size);
                    synchronized (this) {
                        openTransfers.add(request.id);
                    }
                    reply.ok(ok());
                    return;
                case "chunk":
                    // write_failed has already discarded the transfer (ChunkAssembler).
                    assembler.chunk(request.id, request.index, request.base64);
                    reply.ok(ok());
                    return;
                case "end": {
                    ChunkAssembler.Assembled file = assembler.end(request.id);
                    synchronized (this) {
                        openTransfers.remove(request.id);
                    }
                    publish(file, reply);
                    return;
                }
                case "abort":
                    assembler.abort(request.id);
                    synchronized (this) {
                        openTransfers.remove(request.id);
                    }
                    reply.ok(ok());
                    return;
                default:
                    reply.error("bad_args");
            }
        } catch (ChannelException refused) {
            reply.error(refused.code);
        }
    }

    /**
     * The WebView's DownloadListener: a[download], attachments, anything it
     * cannot show. WorkspaceActivity has already checked that the page is on
     * the saved origin; the URL must be too. Nothing on the page is waiting.
     */
    void onDownload(String url, String agent, String contentDisposition, String mimeType, long length) {
        if (url == null) return;
        String lower = url.toLowerCase(Locale.ROOT);
        if (lower.startsWith("blob:") || lower.startsWith("data:")) {
            ShellLog.i("download of page memory ignored; the page saves it with saveFile");
            return;
        }
        if (!origin.contains(url)) {
            ShellLog.i("download from another origin refused");
            return;
        }
        fetch(url, FileNames.safe(URLUtil.guessFileName(url, contentDisposition, mimeType)), mimeType, null);
    }

    /** reply is null for a download the page did not ask for through saveFile. */
    private void fetch(String url, String name, String mimeHint, ChannelBridge.Reply reply) {
        Fetch fetch = new Fetch(reply);
        synchronized (this) {
            if (closed) {
                if (reply != null) reply.error("unavailable");
                return;
            }
            fetches.add(fetch);
            try {
                net.execute(() -> download(fetch, url, name, mimeHint));
            } catch (RejectedExecutionException gone) {
                fetches.remove(fetch);
                if (reply != null) reply.error("unavailable");
            }
        }
    }

    private void download(Fetch fetch, String url, String name, String mimeHint) {
        String code = null;
        long bytes = 0;
        try {
            if (fetch.cancelled) throw new InterruptedIOException("cancelled");
            ProbeClient.dropCookieHandler(); // the jar goes only where SameOriginFetch puts it
            HttpURLConnection connection = SameOriginFetch.open(url, origin, userAgent,
                target -> CookieManager.getInstance().getCookie(target), target -> (HttpURLConnection) target.openConnection(),
                hop -> {
                    // Published first, then checked: either cancelAll sees this hop and
                    // disconnects it, or this sees the cancel (both fields are volatile).
                    fetch.connection = hop;
                    if (fetch.cancelled) throw new InterruptedIOException("cancelled");
                    if (fetch.expired()) throw new InterruptedIOException("deadline");
                });
            try {
                if (fetch.stopped()) throw new InterruptedIOException("stopped");
                String mime = SameOriginFetch.mimeOf(connection.getContentType(), mimeHint);
                try (InputStream in = connection.getInputStream()) {
                    bytes = store(in, name, mime, fetch::stopped);
                }
            } finally {
                connection.disconnect();
            }
        } catch (SameOriginFetch.Refused refused) {
            code = refused.code;
        } catch (IOException | RuntimeException failed) {
            code = fetch.cancelled ? "unavailable" : "download_failed";
            ShellLog.i("save download error=" + failed.getClass().getSimpleName() + " expired=" + fetch.expired());
        } finally {
            synchronized (this) {
                fetches.remove(fetch);
            }
        }
        if (code == null) {
            ShellLog.i("save download bytes=" + bytes);
            toast(context.getString(R.string.saved_to_downloads, name));
            if (fetch.reply != null) fetch.reply.ok(result(-1));
        } else {
            if (fetch.reply != null) fetch.reply.error(code);
            else if (!fetch.cancelled) toast(context.getString(R.string.save_failed));
        }
    }

    private interface Cancelled {
        boolean now();
    }

    /**
     * Streams into a pending Downloads entry, published only when complete. A
     * failure or a close part-way deletes the entry, so no partial file or
     * error page is ever left under the user's name.
     */
    private long store(InputStream in, String name, String mime, Cancelled cancelled) throws IOException {
        synchronized (this) {
            if (closed) throw new IOException("closing"); // no hand-off while the workspace closes
        }
        ContentResolver resolver = context.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, name);
        values.put(MediaStore.Downloads.MIME_TYPE, SameOriginFetch.mimeOf(mime, null));
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri target = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (target == null) throw new IOException("no MediaStore entry");
        long total = 0;
        try {
            try (OutputStream out = resolver.openOutputStream(target)) {
                if (out == null) throw new IOException("no output stream");
                byte[] buffer = new byte[64 * 1024];
                for (int n; (n = in.read(buffer)) != -1; ) {
                    if (cancelled.now()) throw new IOException("cancelled");
                    out.write(buffer, 0, n);
                    total += n;
                }
            }
            if (cancelled.now()) throw new IOException("cancelled");
            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            // 0 rows means the entry is still pending and invisible: not saved.
            if (resolver.update(target, values, null, null) != 1) throw new IOException("not published");
            return total;
        } catch (IOException | RuntimeException failed) {
            try {
                resolver.delete(target, null, null);
            } catch (RuntimeException alsoFailed) {
                ShellLog.i("save cleanup error=" + alsoFailed.getClass().getSimpleName());
            }
            throw failed;
        }
    }

    /** end: the assembled file goes to Downloads, then its cache directory is cleared. */
    private void publish(ChunkAssembler.Assembled file, ChannelBridge.Reply reply) {
        try (InputStream in = new FileInputStream(file.file)) {
            store(in, file.filename, SameOriginFetch.mimeOf(file.mime, null), this::isClosed);
            ShellLog.i("save blob bytes=" + file.size);
            toast(context.getString(R.string.saved_to_downloads, file.filename));
            reply.ok(result(file.size));
        } catch (IOException | RuntimeException failed) {
            reply.error(isClosed() ? "unavailable" : "write_failed");
        } finally {
            CacheSink.delete(file.file.getParentFile());
        }
    }

    private synchronized boolean isClosed() {
        return closed;
    }

    private void toast(String text) {
        main.post(() -> {
            if (!isClosed()) Toast.makeText(context, text, Toast.LENGTH_SHORT).show();
        });
    }

    private static JSONObject ok() {
        return Json.put(new JSONObject(), "ok", true);
    }

    private static JSONObject result(long bytes) {
        JSONObject saved = Json.put(new JSONObject(), "saved", true);
        return bytes >= 0 ? Json.put(saved, "bytes", bytes) : saved;
    }

    /**
     * The workspace is closing or being replaced: every save in flight stops,
     * its partial file is removed and the page (if still there) hears
     * unavailable. Safe from any thread and more than once.
     */
    void cancelAll() {
        // A cancel landing after a publish but before its reply still says unavailable,
        // though the file is in Downloads: rare, and the page only under-reports.
        List<Fetch> running;
        synchronized (this) {
            if (closed) return;
            closed = true;
            running = new ArrayList<>(fetches);
            fetches.clear();
        }
        for (Fetch fetch : running) {
            fetch.cancelled = true;
            if (fetch.reply != null) fetch.reply.error("unavailable");
            HttpURLConnection connection = fetch.connection;
            // disconnect() may touch the socket: never on the main thread.
            if (connection != null) new Thread(connection::disconnect, "murage-save-cancel").start();
        }
        // After whatever chunk is being written: the queue runs in order.
        try {
            disk.execute(() -> {
                List<String> ids;
                synchronized (this) {
                    ids = new ArrayList<>(openTransfers);
                    openTransfers.clear();
                }
                for (String id : ids) assembler.abort(id);
                ShellLog.i("saves cancelled transfers=" + ids.size());
            });
        } catch (RejectedExecutionException gone) {
            // Already shut down.
        }
        disk.shutdown();
        net.shutdown();
        ShellLog.i("saves cancelled downloads=" + running.size());
    }

    void dispose() {
        cancelAll();
    }
}
