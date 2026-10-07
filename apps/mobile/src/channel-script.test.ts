// The wrapper scripts native injects at document start (spec §2, §3.2),
// pulled out of ChannelScript.swift and ChannelScript.java and run in a VM.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const ROOT = new URL("..", import.meta.url);
const ORIGIN = "https://mac.tailnet123.ts.net";

function extract(path: string, pattern: RegExp): string {
  const match = readFileSync(new URL(path, ROOT), "utf8").match(pattern);
  if (!match) throw new Error(`no channel script found in ${path}`);
  return match[1];
}

const IOS = extract("ios/App/MurageShell/Sources/MurageShellCore/ChannelScript.swift", /iosTemplate = #"""\n([\s\S]*?)\n\s*"""#/);
const ANDROID = extract("android/app/src/main/java/com/murage/mobile/shell/ChannelScript.java", /ANDROID_TEMPLATE = """\n([\s\S]*?)"""/);
const CONTRACT: { methods: string[]; platformMethods?: Record<string, string[]> } = JSON.parse(
  readFileSync(new URL("contract/channel.json", ROOT), "utf8"),
);
const METHODS = CONTRACT.methods;
// iOS gets the shared methods plus its own (spec §4.1, callAudio*); Android
// stays exactly the shared list (its ChannelScript.java is untouched).
const PLATFORM_METHODS: Record<string, string[]> = { iOS: [...METHODS, ...(CONTRACT.platformMethods?.ios ?? [])], Android: METHODS };

type Win = Record<string, any>;

function run(script: string, window: Win, origin = ORIGIN) {
  window.window = window;
  window.top ??= window;
  window.location ??= { origin };
  runInNewContext(script.replace("__ORIGIN__", JSON.stringify(ORIGIN)), window);
  return window;
}

/** Page code, run later in the same global as the injected script. */
const pageRuns = (window: Win, code: string) => runInNewContext(code, window);

function iosPage(overrides: Win = {}) {
  const posted: unknown[] = [];
  const window: Win = {
    webkit: { messageHandlers: { murageNative: { postMessage: (body: unknown) => (posted.push(body), Promise.resolve("ok")) } } },
    ...overrides,
  };
  return { window: run(IOS, window), posted };
}

function androidPage(overrides: Win = {}) {
  const posted: string[] = [];
  const port: Win = { postMessage: (data: string) => posted.push(data) };
  const window = run(ANDROID, { __murageNativePort: port, ...overrides });
  const reply = (message: unknown) => port.onmessage?.({ data: JSON.stringify(message) });
  return { window, posted, reply };
}

/** The global names the web side (src/lib/native-shell.ts) knows. */
function knownMethods(): string[] {
  const source = readFileSync(new URL("../../src/lib/native-shell.ts", ROOT), "utf8");
  const block = source.match(/const KNOWN_METHODS[^[]*\[([\s\S]*?)\]/);
  if (!block) throw new Error("KNOWN_METHODS not found in src/lib/native-shell.ts");
  return [...block[1].matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1]);
}

/** Every method name src/lib/call.ts passes to callNative directly -- the
 *  one call site with no platform awareness at all (it swallows
 *  "native-unavailable" itself), so a method missing from either wrapper
 *  script fails silently there instead of loudly here
 *  (callbar-rereview3.md R1, which this would have caught: callSessionOpen/
 *  Close were in the contract and in KNOWN_METHODS, but absent from both
 *  wrapper templates, and nothing failed until a real device tried it). */
function callNativeMethodsIn(relativePath: string): string[] {
  const source = readFileSync(new URL(relativePath, ROOT), "utf8");
  const names = new Set<string>();
  for (const call of source.matchAll(/callNative\(([^)]*)\)/g)) {
    for (const literal of call[1].matchAll(/"([A-Za-z]+)"/g)) names.add(literal[1]);
  }
  return [...names];
}

describe("every method src/lib/call.ts calls through callNative is wired in both wrapper scripts (callbar-rereview3.md R1)", () => {
  const methods = callNativeMethodsIn("../../src/lib/call.ts");

  it("found at least one method to check (a canary against the regex above going stale)", () => {
    expect(methods.length).toBeGreaterThan(0);
  });

  it("exists as a callable function in the iOS wrapper", () => {
    const { window } = iosPage();
    for (const method of methods) expect(typeof window.murageNative[method], method).toBe("function");
  });

  it("exists as a callable function in the Android wrapper", () => {
    const { window } = androidPage();
    for (const method of methods) expect(typeof window.murageNative[method], method).toBe("function");
  });
});

describe.each([
  ["iOS", () => iosPage()],
  ["Android", () => androidPage()],
])("%s wrapper", (name, page) => {
  const methods = PLATFORM_METHODS[name]!;

  it("offers every advertised method, plus hello and on", () => {
    const { window } = page();
    for (const method of ["hello", "on", ...methods]) expect(typeof window.murageNative[method], method).toBe("function");
  });

  it("offers exactly the contract's methods, each one the web side knows", () => {
    const { window } = page();
    expect(Object.keys(window.murageNative).sort()).toEqual(["hello", "on", ...methods].sort());
    const known = knownMethods();
    for (const method of methods) expect(known, method).toContain(method);
  });

  it("offers signOut, which afterSignOut calls once hello() lists it", () => {
    expect(typeof page().window.murageNative.signOut).toBe("function");
  });

  it("cannot be replaced or extended by the page", () => {
    const { window } = page();
    const original = window.murageNative;
    expect(Object.isFrozen(original)).toBe(true);
    // An ES module is strict, so writing a non-writable property throws.
    expect(() => {
      window.murageNative = {};
    }).toThrow();
    expect(window.murageNative).toBe(original);
    expect(Object.getOwnPropertyDescriptor(window, "__murageNativeEmit")?.writable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(window, "__murageNativeEmit")?.configurable).toBe(false);
  });

  it("has no prototype, so nothing the page adds to Object.prototype looks like a method", () => {
    const { window } = page();
    expect(Object.getPrototypeOf(window.murageNative)).toBeNull();
    pageRuns(window, "Object.prototype.notAdvertised = function () {};");
    expect(window.murageNative.notAdvertised).toBeUndefined();
  });

  it("adds only murageNative and __murageNativeEmit to the page's globals", () => {
    const before: Win = name === "iOS" ? { webkit: { messageHandlers: { murageNative: { postMessage: vi.fn() } } } } : { __murageNativePort: { postMessage: vi.fn() } };
    before.window = before;
    before.top = before;
    before.location = { origin: ORIGIN };
    const names = Object.getOwnPropertyNames(before);
    run(name === "iOS" ? IOS : ANDROID, before);
    expect(Object.getOwnPropertyNames(before).filter((key) => !names.includes(key)).sort()).toEqual(["__murageNativeEmit", "murageNative"]);
  });

  it("delivers events, reports handled only when a listener returns true, and unsubscribes", () => {
    const { window } = page();
    const quiet = vi.fn();
    const stop = window.murageNative.on("resume", quiet);
    expect(window.__murageNativeEmit("resume")).toBe(false);
    window.murageNative.on("backButton", () => true);
    window.murageNative.on("backButton", () => {
      throw new Error("a broken listener must not stop the others");
    });
    expect(window.__murageNativeEmit("backButton")).toBe(true);
    stop();
    window.__murageNativeEmit("resume");
    expect(quiet).toHaveBeenCalledOnce();
    expect(window.__murageNativeEmit("nobody-listens")).toBe(false);
    expect(typeof window.murageNative.on("x", "not a function")).toBe("function");
  });

  it("passes the detail, calls listeners in order, and a listener added during an event waits for the next", () => {
    const { window } = page();
    const seen: string[] = [];
    window.murageNative.on("notificationOpened", (detail: { threadId: string }) => {
      seen.push(`first ${detail.threadId}`);
      window.murageNative.on("notificationOpened", () => seen.push("late"));
    });
    const stop = window.murageNative.on("notificationOpened", () => seen.push("second"));
    window.__murageNativeEmit("notificationOpened", { threadId: "t1" });
    expect(seen).toEqual(["first t1", "second"]);
    stop();
    stop();
    expect(window.__murageNativeEmit("__proto__")).toBe(false);
  });

  it("keeps working after the page replaces JSON, Promise, String, Error, Array and Function methods", async () => {
    const { window } = page();
    const handled = window.murageNative.on("backButton", () => true);
    pageRuns(
      window,
      `JSON.stringify = JSON.parse = function () { throw new Error("hijacked"); };
       Promise = function () { throw new Error("hijacked"); };
       String = Error = Object.create = function () { throw new Error("hijacked"); };
       Object.prototype.hasOwnProperty = function () { return true; };
       Array.prototype.slice = Array.prototype.forEach = Array.prototype.push = Array.prototype.indexOf = Array.prototype.splice = function () { throw new Error("hijacked"); };
       Object.defineProperty(Array.prototype, "0", { set: function () { throw new Error("hijacked"); }, configurable: true });
       Function.prototype.call = Function.prototype.apply = Function.prototype.bind = function () { throw new Error("hijacked"); };`,
    );
    expect(window.__murageNativeEmit("backButton")).toBe(true);
    handled();
    expect(window.__murageNativeEmit("backButton")).toBe(false);
    expect(typeof window.murageNative.on("resume", () => undefined)).toBe("function");
    expect(() => window.murageNative.openExternal("https://example.com/")).not.toThrow();
    expect(() => window.murageNative.haptic("tap")).not.toThrow();
  });

  it("is not defined in a subframe (Phase 0: wrapper only in the top window)", () => {
    const { window } = page();
    const frame: Win = { top: window };
    const script = name === "iOS" ? IOS : ANDROID;
    run(script, Object.assign(frame, name === "iOS" ? { webkit: window.webkit } : { __murageNativePort: window.__murageNativePort }));
    expect(frame.murageNative).toBeUndefined();
  });

  it("is not defined for another origin", () => {
    const script = name === "iOS" ? IOS : ANDROID;
    const other: Win = { location: { origin: "https://example.com" }, webkit: { messageHandlers: { murageNative: { postMessage: vi.fn() } } }, __murageNativePort: { postMessage: vi.fn() } };
    run(script, other);
    expect(other.murageNative).toBeUndefined();
  });

  it("stays out of the way when the native side installed nothing (channel failed closed)", () => {
    const script = name === "iOS" ? IOS : ANDROID;
    const bare = run(script, {});
    expect(bare.murageNative).toBeUndefined();
  });

  it("contains no backslash, so neither a Swift raw string nor a Java text block can alter it", () => {
    expect(name === "iOS" ? IOS : ANDROID).not.toContain("\\");
  });

  it("holds the origin placeholder exactly once", () => {
    expect((name === "iOS" ? IOS : ANDROID).split("__ORIGIN__")).toHaveLength(2);
  });
});

describe("iOS messages", () => {
  it("posts {method, args} and returns WebKit's promise", async () => {
    const { window, posted } = iosPage();
    await expect(window.murageNative.hello()).resolves.toBe("ok");
    window.murageNative.openExternal("https://example.com/");
    window.murageNative.setRoute({ threadId: "t1" });
    expect(posted).toEqual([
      { method: "hello", args: null },
      { method: "openExternal", args: { url: "https://example.com/" } },
      { method: "setRoute", args: { threadId: "t1" } },
    ]);
  });

  it("shapes every method's args the way ChannelGate parses them", () => {
    const { window, posted } = iosPage();
    const native = window.murageNative;
    native.ready();
    native.saveFile({ kind: "end", id: "a" });
    native.haptic("success");
    native.signOut();
    native.rePair();
    native.showLauncher();
    expect(posted).toEqual([
      { method: "ready", args: null },
      { method: "saveFile", args: { kind: "end", id: "a" } },
      { method: "haptic", args: { kind: "success" } },
      { method: "signOut", args: null },
      { method: "rePair", args: null },
      { method: "showLauncher", args: null },
    ]);
  });

  it("shapes approveWithDevice into a fresh object of exactly the contract's fields", () => {
    const { window, posted } = iosPage();
    window.murageNative.approveWithDevice({ v: 1, threadId: "t1", requestId: "req-1", decision: "allow", digest: "a".repeat(64), nonce: "n".repeat(43), expiresAt: 5, reason: "r", extra: "dropped" });
    expect(posted.at(-1)).toEqual({ method: "approveWithDevice", args: { v: 1, threadId: "t1", requestId: "req-1", decision: "allow", digest: "a".repeat(64), nonce: "n".repeat(43), expiresAt: 5, reason: "r" } });
  });

  it("shapes call audio args into fresh objects, the way ChannelGate parses them (spec §4.1)", () => {
    const { window, posted } = iosPage();
    const native = window.murageNative;
    native.callAudioOpen();
    native.callAudioClose({ session: "s1" });
    native.callAudioPlay({ session: "s1", clip: "c1", seq: 0, mime: "audio/mpeg", bytes: "AA==", last: false, paused: true });
    native.callAudioPlay({ session: "s1", clip: "c1", seq: 1, mime: "audio/mpeg", bytes: "", last: true });
    native.callAudioControl({ session: "s1", action: "pulseOn" });
    expect(posted).toEqual([
      { method: "callAudioOpen", args: null },
      { method: "callAudioClose", args: { session: "s1" } },
      { method: "callAudioPlay", args: { session: "s1", clip: "c1", seq: 0, mime: "audio/mpeg", bytes: "AA==", last: false, paused: true } },
      { method: "callAudioPlay", args: { session: "s1", clip: "c1", seq: 1, mime: "audio/mpeg", bytes: "", last: true } },
      { method: "callAudioControl", args: { session: "s1", action: "pulseOn" } },
    ]);
  });

  it("uses the handler it found at document start, whatever the page does to it later", () => {
    const { window, posted } = iosPage();
    pageRuns(window, `webkit.messageHandlers.murageNative.postMessage = function () { throw new Error("hijacked"); };`);
    window.murageNative.ready();
    expect(posted).toEqual([{ method: "ready", args: null }]);
  });
});

describe("Android messages", () => {
  it("numbers each call and settles it from the matching reply", async () => {
    const { window, posted, reply } = androidPage();
    const hello = window.murageNative.hello();
    const save = window.murageNative.saveFile({ kind: "end", id: "a" });
    expect(posted.map((data) => JSON.parse(data))).toEqual([
      { id: 1, method: "hello", args: null },
      { id: 2, method: "saveFile", args: { kind: "end", id: "a" } },
    ]);
    reply({ id: 99, result: "stray" });
    reply({ id: 2, error: "bad_args" });
    reply({ id: 1, result: { version: 1, methods: ["ready"] } });
    await expect(hello).resolves.toEqual({ version: 1, methods: ["ready"] });
    await expect(save).rejects.toMatchObject({ message: "bad_args" });
  });

  it("shapes approveWithDevice into a fresh object of exactly the contract's fields", () => {
    const { window, posted } = androidPage();
    window.murageNative.approveWithDevice({ v: 1, threadId: "t1", requestId: "req-1", decision: "allow", digest: "a".repeat(64), nonce: "n".repeat(43), expiresAt: 5, reason: "r", extra: "dropped" });
    expect(JSON.parse(posted[posted.length - 1])).toEqual({ id: 1, method: "approveWithDevice", args: { v: 1, threadId: "t1", requestId: "req-1", decision: "allow", digest: "a".repeat(64), nonce: "n".repeat(43), expiresAt: 5, reason: "r" } });
  });

  it("ignores a reply that is not JSON", () => {
    const { window, reply } = androidPage();
    void window.murageNative.ready();
    expect(() => window.__murageNativePort.onmessage({ data: "not json" })).not.toThrow();
    expect(() => reply(null)).not.toThrow();
  });

  it("settles each call once, and a second reply for it is ignored", async () => {
    const { window, reply } = androidPage();
    const ready = window.murageNative.ready();
    reply({ id: 1, result: null });
    reply({ id: 1, error: "busy" });
    await expect(ready).resolves.toBeNull();
  });

  it("rejects the call when the port refuses the message, and forgets it", async () => {
    const posted: string[] = [];
    const port: Win = {
      postMessage: (data: string) => {
        posted.push(data);
        throw new Error("port closed");
      },
    };
    const window = run(ANDROID, { __murageNativePort: port });
    await expect(window.murageNative.rePair()).rejects.toThrow("port closed");
    port.onmessage({ data: JSON.stringify({ id: 1, result: "late" }) });
    expect(posted).toHaveLength(1);
  });

  it("reads only the reply's own fields, not ones the page puts on Object.prototype", async () => {
    const { window, reply } = androidPage();
    pageRuns(window, `Object.prototype.error = "forged"; Object.prototype.id = 1;`);
    const ready = window.murageNative.ready();
    reply({ result: "no id" });
    reply({ id: 1, result: "ok" });
    await expect(ready).resolves.toBe("ok");
  });

  it("keeps its reply handler when the page assigns the port's onmessage", async () => {
    const { window, reply } = androidPage();
    const port = window.__murageNativePort;
    const handler = port.onmessage;
    pageRuns(window, `__murageNativePort.onmessage = function () {};`);
    expect(port.onmessage).toBe(handler);
    expect(Object.getOwnPropertyDescriptor(port, "onmessage")?.configurable).toBe(false);
    const ready = window.murageNative.ready();
    reply({ id: 1, result: "ok" });
    await expect(ready).resolves.toBe("ok");
  });

  it("keeps numbering and settling after the page replaces JSON, Promise and the port's postMessage", async () => {
    const { window, posted, reply } = androidPage();
    pageRuns(
      window,
      `JSON.stringify = JSON.parse = function () { throw new Error("hijacked"); };
       Promise = Error = function () { throw new Error("hijacked"); };
       __murageNativePort.postMessage = function () { throw new Error("hijacked"); };
       Function.prototype.call = Function.prototype.bind = function () { throw new Error("hijacked"); };`,
    );
    const route = window.murageNative.setRoute({ threadId: "t1" });
    const open = window.murageNative.openExternal("https://example.com/");
    expect(posted.map((data) => JSON.parse(data))).toEqual([
      { id: 1, method: "setRoute", args: { threadId: "t1" } },
      { id: 2, method: "openExternal", args: { url: "https://example.com/" } },
    ]);
    reply({ id: 1, result: null });
    reply({ id: 2, error: "unavailable" });
    await expect(route).resolves.toBeNull();
    await expect(open).rejects.toMatchObject({ message: "unavailable" });
  });

  it("names its raw port something other than murageNative", () => {
    expect(ANDROID).toContain("window.__murageNativePort");
    expect(ANDROID).not.toMatch(/window\.murageNative\b/);
  });
});

// Carried ruling (P11 → P21): WebView's injected object takes addEventListener("message");
// the wrapper uses it where it exists and falls back to onmessage. The native side
// (ChannelBridge.Reply) posts every answer through the reply proxy, so hello() settles.
describe("Android wrapper on a port with addEventListener (P21)", () => {
  /** Like WebView's JsBinding: listeners from addEventListener, onmessage never read. */
  function listenerPort() {
    const posted: string[] = [];
    const added: Array<[string, (event: { data: string }) => void]> = [];
    const port: Win = {
      postMessage: (data: string) => posted.push(data),
      addEventListener: (type: string, listener: (event: { data: string }) => void) => added.push([type, listener]),
    };
    const window = run(ANDROID, { __murageNativePort: port });
    const reply = (message: unknown) => {
      for (const [type, listener] of added) if (type === "message") listener({ data: JSON.stringify(message) });
    };
    return { window, port, posted, added, reply };
  }

  it("registers one message listener and leaves onmessage alone", () => {
    const { port, added } = listenerPort();
    expect(added.map(([type]) => type)).toEqual(["message"]);
    expect(port.onmessage).toBeUndefined();
  });

  it("resolves hello() from a reply delivered only to event listeners", async () => {
    const { window, posted, reply } = listenerPort();
    const hello = window.murageNative.hello();
    expect(JSON.parse(posted[0])).toEqual({ id: 1, method: "hello", args: null });
    reply({ id: 1, result: { version: 1, methods: ["ready", "signOut"] } });
    await expect(hello).resolves.toEqual({ version: 1, methods: ["ready", "signOut"] });
  });

  it("keeps answering after the page assigns onmessage or replaces addEventListener", async () => {
    const { window, reply } = listenerPort();
    pageRuns(window, `__murageNativePort.onmessage = function () {}; __murageNativePort.addEventListener = function () { throw new Error("hijacked"); };`);
    const ready = window.murageNative.ready();
    reply({ id: 1, result: "ok" });
    await expect(ready).resolves.toBe("ok");
  });

  it("falls back to a pinned onmessage when the port has no addEventListener", async () => {
    const { window, reply } = androidPage();
    const port = window.__murageNativePort;
    expect(typeof port.onmessage).toBe("function");
    const hello = window.murageNative.hello();
    reply({ id: 1, result: { version: 1, methods: [] } });
    await expect(hello).resolves.toEqual({ version: 1, methods: [] });
  });
});

// Native events (pause, resume, backButton, notificationOpened) go through
// these scripts. The origin check runs inside them, in the same turn as the
// call, so a navigation that commits after native's own check can never hand
// a foreign page an event (final review M6).
describe("the native event scripts", () => {
  const IOS_EMIT = JSON.parse(extract("ios/App/MurageShell/Sources/MurageShellCore/ChannelScript.swift", /iosEmit = ("[^\n]*")\n/)) as string;
  const ANDROID_EMIT = JSON.parse(extract("android/app/src/main/java/com/murage/mobile/shell/ChannelScript.java", /EMIT_TEMPLATE =\s*("[^\n]*");\n/)) as string;

  function page(origin: string) {
    const seen: unknown[][] = [];
    const window: Win = { location: { origin }, __murageNativeEmit: (...args: unknown[]) => (seen.push(args), true) };
    window.window = window;
    return { window, seen };
  }

  const ios = async (origin: string) => {
    const { window, seen } = page(origin);
    const call = runInNewContext(`(async function (name, detail, origin) { ${IOS_EMIT} })`, window);
    return { result: await call("notificationOpened", { threadId: "t1" }, ORIGIN), seen };
  };

  const android = (origin: string) => {
    const { window, seen } = page(origin);
    const script = ANDROID_EMIT.replace(/__(ORIGIN|NAME|DETAIL)__/g, (_, slot: string) =>
      slot === "ORIGIN" ? JSON.stringify(ORIGIN) : slot === "NAME" ? JSON.stringify("notificationOpened") : JSON.stringify({ threadId: "t1" }),
    );
    return { result: runInNewContext(script, window), seen };
  };

  it("hands the event to the page on the saved origin", async () => {
    for (const { result, seen } of [await ios(ORIGIN), android(ORIGIN)]) {
      expect(result).toBe(true);
      expect(seen).toEqual([["notificationOpened", { threadId: "t1" }]]);
    }
  });

  it("never hands it to a page on another origin, even one with the same global", async () => {
    for (const origin of ["https://evil.example", "https://mac.tailnet123.ts.net:8444", "null"]) {
      for (const { result, seen } of [await ios(origin), android(origin)]) {
        expect(result, origin).toBe(false);
        expect(seen, origin).toEqual([]);
      }
    }
  });
});
