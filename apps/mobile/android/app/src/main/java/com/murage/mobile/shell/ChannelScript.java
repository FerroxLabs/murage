package com.murage.mobile.shell;

import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * The document-start script that defines {@code window.murageNative} in the
 * workspace page (spec §2, §3.2). Phase 0: the raw listener object is
 * injected into same-origin iframes too, so it has its own name
 * ({@link #PORT}) and the wrapper is defined only in the top window. The
 * native listener still checks {@code isMainFrame} and the origin.
 * src/channel-script.test.ts runs this exact text in a JavaScript VM.
 *
 * <p>The script runs before any page script, so everything it calls later is
 * captured then: the page replacing JSON, Promise, Error, String,
 * Object.create, Array or Function methods, or the port's postMessage, cannot
 * redirect it. Replies arrive through the port's
 * {@code addEventListener("message")} (WebView's injected object has it, P21
 * ruling); a port without it falls back to {@code onmessage}, pinned to the
 * reply handler. Replies are read from their own fields only. The API object has no
 * prototype and is frozen, and both globals are non-writable and
 * non-configurable. The page can still reach the raw port itself; the
 * wrapper cannot hide it, which is why the gate is native.
 */
public final class ChannelScript {
    public static final String PORT = "__murageNativePort";

    private ChannelScript() {}

    /**
     * What WorkspaceActivity.emit evaluates in the main frame for a native event.
     * The origin is checked inside the script, in the page's own turn, not only
     * before evaluateJavascript: a navigation that commits in between never gets
     * the event (final review M6). src/channel-script.test.ts runs this text.
     */
    static final String EMIT_TEMPLATE =
        "(function(){if(location.origin!==__ORIGIN__)return false;var f=window.__murageNativeEmit;return typeof f==='function'?f(__NAME__,__DETAIL__)===true:false;})()";
    private static final Pattern EMIT_SLOT = Pattern.compile("__(ORIGIN|NAME|DETAIL)__");

    /** One pass over the template, so a value is never read as a slot. detail may be null. */
    public static String emit(String name, JSONObject detail, String serializedOrigin) {
        Matcher slot = EMIT_SLOT.matcher(EMIT_TEMPLATE);
        StringBuffer out = new StringBuffer();
        while (slot.find()) {
            String value;
            if ("ORIGIN".equals(slot.group(1))) value = JSONObject.quote(serializedOrigin);
            else if ("NAME".equals(slot.group(1))) value = JSONObject.quote(name);
            else value = detail == null ? "null" : detail.toString();
            slot.appendReplacement(out, Matcher.quoteReplacement(value));
        }
        slot.appendTail(out);
        return out.toString();
    }

    public static String android(String serializedOrigin) {
        return ANDROID_TEMPLATE.replace("__ORIGIN__", JSONObject.quote(serializedOrigin));
    }

    static final String ANDROID_TEMPLATE = """
        (function () {
          "use strict";
          if (window !== window.top || location.origin !== __ORIGIN__) return;
          var port = window.__murageNativePort;
          if (!port || typeof port.postMessage !== "function") return;
          var post = port.postMessage.bind(port);
          var stringify = JSON.stringify;
          var parse = JSON.parse;
          var Waiting = Promise;
          var Failure = Error;
          var own = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
          var create = Object.create;
          var text = String;
          var lastCall = 0;
          var pending = create(null);
          var listeners = create(null);
          var lastListener = 0;
          function receive(event) {
            var message;
            try {
              message = parse(event.data);
            } catch (ignored) {
              return;
            }
            if (!message || typeof message !== "object" || !own(message, "id")) return;
            var id = message.id;
            if (typeof id !== "number" || !own(pending, id)) return;
            var entry = pending[id];
            delete pending[id];
            if (own(message, "error") && typeof message.error === "string") entry.reject(new Failure(message.error));
            else entry.resolve(own(message, "result") ? message.result : undefined);
          }
          if (typeof port.addEventListener === "function") {
            port.addEventListener("message", receive);
          } else {
            port.onmessage = receive;
            try {
              Object.defineProperty(port, "onmessage", { get: function () { return receive; }, enumerable: true, configurable: false });
            } catch (ignored) {}
          }
          function call(method, args) {
            return new Waiting(function (resolve, reject) {
              var id = ++lastCall;
              pending[id] = { resolve: resolve, reject: reject };
              try {
                post(stringify({ id: id, method: method, args: args === undefined ? null : args }));
              } catch (error) {
                delete pending[id];
                reject(error);
              }
            });
          }
          function emit(name, detail) {
            var slots = listeners[name];
            if (!slots) return false;
            var queue = create(null);
            var count = 0;
            var key;
            for (key in slots) queue[count++] = slots[key];
            var handled = false;
            for (var at = 0; at < count; at++) {
              var listener = queue[at];
              try {
                if (listener(detail) === true) handled = true;
              } catch (ignored) {}
            }
            return handled;
          }
          function on(name, listener) {
            if (typeof listener !== "function") return function () {};
            var slots = listeners[name] || (listeners[name] = create(null));
            var key = ++lastListener;
            slots[key] = listener;
            return function () {
              delete slots[key];
            };
          }
          var api = create(null);
          api.hello = function () { return call("hello"); };
          api.ready = function () { return call("ready"); };
          api.saveFile = function (request) { return call("saveFile", request); };
          api.openExternal = function (url) { return call("openExternal", { url: text(url) }); };
          api.haptic = function (kind) { return call("haptic", { kind: text(kind) }); };
          api.signOut = function () { return call("signOut"); };
          api.rePair = function () { return call("rePair"); };
          api.setRoute = function (route) { return call("setRoute", route); };
          api.showLauncher = function () { return call("showLauncher"); };
          api.registerPush = function (options) { return call("registerPush", { fresh: !!(options && options.fresh === true) }); };
          api.pushStatus = function () { return call("pushStatus"); };
          api.issuePushTokens = function (tokens) { return call("issuePushTokens", tokens); };
          api.setBadgeCount = function (n) { return call("setBadgeCount", { count: n }); };
          api.callSessionOpen = function () { return call("callSessionOpen"); };
          api.callSessionClose = function () { return call("callSessionClose"); };
          api.diagLine = function (line) { return call("diagLine", { line: text(line) }); };
          api.approveWithDevice = function (args) { args = args || {}; return call("approveWithDevice", { v: args.v, threadId: text(args.threadId), requestId: text(args.requestId), decision: text(args.decision), digest: text(args.digest), nonce: text(args.nonce), expiresAt: args.expiresAt, reason: text(args.reason) }); };
          api.on = on;
          Object.defineProperty(window, "murageNative", { value: Object.freeze(api), writable: false, configurable: false, enumerable: false });
          Object.defineProperty(window, "__murageNativeEmit", { value: emit, writable: false, configurable: false, enumerable: false });
        })();
        """;
}
