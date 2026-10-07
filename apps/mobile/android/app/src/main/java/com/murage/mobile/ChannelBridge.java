package com.murage.mobile;

import android.os.Looper;
import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.murage.mobile.shell.ChannelArgs;
import com.murage.mobile.shell.ChannelException;
import com.murage.mobile.shell.ChannelGate;
import com.murage.mobile.shell.ChannelScript;
import com.murage.mobile.shell.Json;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.util.Collections;
import java.util.Set;
import org.json.JSONObject;

/** The window.murageNative channel on Android (spec §2, §3.2; Phase 0 recommendations). */
final class ChannelBridge {
    interface Handler {
        void onRequest(ChannelGate.Request request, Reply reply);
    }

    /** One answer per request, always posted on the UI thread. */
    static final class Reply {
        private static final android.os.Handler MAIN = new android.os.Handler(Looper.getMainLooper());
        private final JavaScriptReplyProxy proxy;
        private final int id;
        private boolean sent;

        Reply(JavaScriptReplyProxy proxy, int id) {
            this.proxy = proxy;
            this.id = id;
        }

        void ok(Object result) {
            send("result", result);
        }

        void error(String code) {
            send("error", code);
        }

        private synchronized void send(String key, Object value) {
            if (sent) return;
            sent = true;
            JSONObject message = new JSONObject();
            Json.put(message, "id", id);
            Json.put(message, key, value == null ? JSONObject.NULL : value);
            Runnable post = () -> {
                try {
                    proxy.postMessage(message.toString());
                } catch (RuntimeException gone) {
                    ShellLog.i("channel reply dropped; the page has gone");
                }
            };
            if (Looper.myLooper() == Looper.getMainLooper()) post.run();
            else MAIN.post(post);
        }
    }

    private ChannelBridge() {}

    static boolean install(WebView webView, WorkspaceOrigin origin, Handler handler) {
        boolean listener = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER);
        boolean startScript = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
        if (!listener || !startScript) {
            // addDocumentStartJavaScript throws when unsupported: fail closed, the page still works.
            ShellLog.i("channel features listener=" + listener + " startScript=" + startScript);
            return false;
        }
        Set<String> rules = Collections.singleton(origin.serialized());
        WebViewCompat.addWebMessageListener(webView, ChannelScript.PORT, rules, (view, message, sourceOrigin, isMainFrame, proxy) -> {
            String data = message.getData();
            WorkspaceOrigin frame = WorkspaceOrigin.parse(sourceOrigin == null ? null : sourceOrigin.toString());
            if (!ChannelGate.admit(isMainFrame, frame, origin)) {
                ShellLog.i("channel drop main=" + isMainFrame + " origin=" + (frame == null ? "opaque" : frame.serialized()));
                Integer id = idOf(data);
                if (id != null) new Reply(proxy, id).error("unavailable");
                return;
            }
            ChannelGate.Request request;
            try {
                request = ChannelGate.parse(data);
            } catch (ChannelException refused) {
                ShellLog.i("channel refuse error=" + refused.code);
                if (refused.id >= 0) new Reply(proxy, refused.id).error(refused.code);
                return;
            }
            ShellLog.i("channel accept method=" + request.method);
            handler.onRequest(request, new Reply(proxy, request.id));
        });
        WebViewCompat.addDocumentStartJavaScript(webView, ChannelScript.android(origin.serialized()), rules);
        return true;
    }

    private static Integer idOf(String data) {
        if (data == null || data.length() > ChannelGate.MAX_MESSAGE_CHARS) return null;
        JSONObject message = Json.object(data);
        return message == null ? null : ChannelArgs.integer(message.opt("id"));
    }
}
