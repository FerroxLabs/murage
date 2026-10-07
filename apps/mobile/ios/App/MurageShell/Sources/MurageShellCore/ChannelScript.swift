import Foundation

/// The document-start script that defines `window.murageNative` in the
/// workspace page (spec §2, §3.2). WebKit injects it into the main frame only
/// (`forMainFrameOnly: true`); its own origin and top-window checks are
/// cosmetic, and the native gate (ChannelGate.admit) is the enforcement.
/// src/channel-script.test.ts runs this exact text in a JavaScript VM.
///
/// The script runs before any page script, so everything it calls later is
/// captured then: the page replacing JSON, String, Object.create, Array or
/// Function methods, or the handler's postMessage, cannot redirect it. The
/// API object has no prototype and is frozen, and both globals are
/// non-writable and non-configurable. WebKit itself still exposes
/// `webkit.messageHandlers.murageNative` to the page; the wrapper cannot
/// hide it, which is why the gate is native.
public enum ChannelScript {
    public static let iosHandlerName = "murageNative"

    public static func ios(origin: WorkspaceOrigin) -> String {
        iosTemplate.replacingOccurrences(of: "__ORIGIN__", with: javaScriptString(origin.serialized))
    }

    /// The body `WorkspaceViewController.emit` runs with callAsyncJavaScript,
    /// arguments `name`, `detail` and `origin` (the saved origin, serialized).
    /// The origin is checked here, in the page's own turn, not only before the
    /// call: a navigation that commits in between never gets the event (M6).
    public static let iosEmit = "if (location.origin !== origin) return false; return typeof window.__murageNativeEmit === 'function' ? window.__murageNativeEmit(name, detail) === true : false"

    static func javaScriptString(_ value: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [value], options: [.withoutEscapingSlashes])) ?? Data("[\"\"]".utf8)
        return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
    }

    static let iosTemplate = #"""
(function () {
  "use strict";
  if (window !== window.top || location.origin !== __ORIGIN__) return;
  var handlers = window.webkit && window.webkit.messageHandlers;
  var port = handlers && handlers.murageNative;
  if (!port || typeof port.postMessage !== "function") return;
  var post = port.postMessage.bind(port);
  var create = Object.create;
  var text = String;
  var listeners = create(null);
  var lastListener = 0;
  function call(method, args) {
    return post({ method: method, args: args === undefined ? null : args });
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
  api.callAudioOpen = function () { return call("callAudioOpen"); };
  api.callAudioClose = function (args) { args = args || {}; return call("callAudioClose", { session: text(args.session) }); };
  api.callAudioPlay = function (args) {
    args = args || {};
    var out = { session: text(args.session), clip: text(args.clip), seq: args.seq, mime: text(args.mime), bytes: text(args.bytes), last: !!args.last };
    if (args.paused === true) out.paused = true;
    return call("callAudioPlay", out);
  };
  api.callAudioControl = function (args) { args = args || {}; return call("callAudioControl", { session: text(args.session), action: text(args.action) }); };
  api.on = on;
  Object.defineProperty(window, "murageNative", { value: Object.freeze(api), writable: false, configurable: false, enumerable: false });
  Object.defineProperty(window, "__murageNativeEmit", { value: emit, writable: false, configurable: false, enumerable: false });
})();
"""#
}
