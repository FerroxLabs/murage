#if DEBUG && os(iOS)
import Foundation
import WebKit

/// Debug builds only. After `ready`, runs one fixed script that checks the
/// channel from inside the page (Phase 0 Q3 cases 1, 2a and 3a, the safe
/// area and a chunked save) and logs the result for P25. The script is a
/// constant: nothing from a launch argument or the page reaches it.
enum E2EProbe {
    /// Private WebKit API, debug builds only (R9): P25 kills this process to
    /// prove the crash recovery.
    static func webContentPID(_ webView: WKWebView) -> Int {
        (webView.value(forKey: "_webProcessIdentifier") as? Int) ?? -1
    }

    static func run(in webView: WKWebView) {
        webView.callAsyncJavaScript(script, arguments: ["platform": "webkit"], in: nil, in: .page) { result in
            switch result {
            case .success(let value):
                let data = (try? JSONSerialization.data(withJSONObject: value ?? NSNull(), options: [.fragmentsAllowed])) ?? Data()
                ShellLog.e2eProbe(String(decoding: data, as: UTF8.self))
            case .failure:
                ShellLog.event("e2e probe failed")
            }
        }
    }

    static let script = #"""
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
"""#
}
#endif
