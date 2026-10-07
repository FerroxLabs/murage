package com.murage.mobile;

import android.webkit.WebView;

/** Debug builds only. After ready, runs one fixed script and logs its result for P26. */
final class E2EProbe {
    static boolean requested;

    private E2EProbe() {}

    static void run(WebView webView) {
        if (!requested || webView == null) return;
        webView.evaluateJavascript("(async function (platform) {\n" + SCRIPT + "\n})(\"android\").then("
            + "function (out) { console.log(\"murage-e2e \" + JSON.stringify(out)); },"
            + "function (error) { console.log(\"murage-e2e failed \" + error.message); });", null);
    }

    static boolean isProbeOutput(String message) {
        return message != null && message.startsWith("murage-e2e ");
    }

    static final String SCRIPT = """
        const out = { platform: platform };
        try { out.hello = await window.murageNative.hello(); } catch (error) { out.hello = "error " + error.message; }
        const holder = document.createElement("div");
        holder.style.cssText = "position:fixed;top:0;left:0;padding-top:env(safe-area-inset-top,0px)";
        document.body.appendChild(holder);
        out.safeTop = getComputedStyle(holder).paddingTop;
        holder.remove();
        const frame = document.createElement("iframe");
        frame.srcdoc = "<!doctype html><p>probe</p>";
        document.body.appendChild(frame);
        await new Promise((resolve) => { frame.onload = resolve; setTimeout(resolve, 3000); });
        const inner = frame.contentWindow;
        out.frameWrapper = typeof inner.murageNative;
        out.framePost = await new Promise((resolve) => {
          setTimeout(() => resolve("no-reply"), 3000);
          try {
            if (platform === "webkit") {
              const port = inner.webkit && inner.webkit.messageHandlers && inner.webkit.messageHandlers.murageNative;
              if (!port) { resolve("no-port"); return; }
              port.postMessage({ method: "hello", args: null }).then(() => resolve("answered"), (error) => resolve("rejected " + error.message));
            } else {
              const port = inner.__murageNativePort;
              if (!port) { resolve("no-port"); return; }
              port.onmessage = (event) => resolve("replied " + event.data);
              port.postMessage(JSON.stringify({ id: 1, method: "hello", args: null }));
            }
          } catch (error) { resolve("threw " + error.message); }
        });
        frame.remove();
        try {
          await window.murageNative.saveFile({ kind: "begin", id: "e2e", filename: "murage-e2e.txt", mime: "text/plain", size: 5 });
          await window.murageNative.saveFile({ kind: "chunk", id: "e2e", index: 0, base64: "aGVsbG8=" });
          out.save = await window.murageNative.saveFile({ kind: "end", id: "e2e" });
        } catch (error) { out.save = "error " + error.message; }
        setTimeout(() => { location.assign("https://example.com/"); }, 500);
        return out;
        """;
}
