// The phone app's channel, as the page sees it. Nothing here may assume a
// method exists: an older app, or an Android WebView missing a feature,
// hands the page less than the newest one does (spec §3.2).
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  callNative,
  type CallAudioEvent,
  hasNativeUserAgent,
  inNativeShell,
  nativeAvailable,
  nativeHas,
  nativeHello,
  onNativeEvent,
  parseCallAudioEvent,
  parseNativeHello,
  parseNotificationOpened,
  resetNativeShellForTest,
} from "./native-shell";

afterEach(() => {
  resetNativeShellForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fakeBridge(hello: unknown, extra: Record<string, unknown> = {}) {
  const listeners = new Map<string, Set<(detail?: unknown) => unknown>>();
  const bridge = {
    hello: vi.fn(async () => hello),
    on: vi.fn((name: string, listener: (detail?: unknown) => unknown) => {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => set.delete(listener);
    }),
    // Mirrors the native shells' deliver() (ChannelScript.java / .swift): an
    // event only counts as handled when a listener answers exactly `true`.
    emit(name: string, detail?: unknown): boolean {
      let handled = false;
      for (const listener of listeners.get(name) ?? []) {
        if (listener(detail) === true) handled = true;
      }
      return handled;
    },
    ...extra,
  };
  vi.stubGlobal("murageNative", bridge);
  return bridge;
}

describe("knowing we are inside the phone app", () => {
  it("reads the user agent token, which works before hello() and on a fail-closed channel", () => {
    expect(hasNativeUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) MurageApp/1.0.0 (android)")).toBe(true);
    expect(hasNativeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) MurageApp/1.0.0 (ios)")).toBe(true);
    expect(hasNativeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1")).toBe(false);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 14; wv) MurageApp/1.0.0 (android)" });
    expect(inNativeShell()).toBe(true);
  });

  it("is not fooled by the desktop bridge", () => {
    // window.muragebox is Electron's preload. It proves the DESKTOP; it must
    // never be read as the phone app (src/lib/use-surface.ts).
    vi.stubGlobal("muragebox", { platform: "darwin", openExternal: vi.fn() });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh) Electron/37.0.0" });
    expect(inNativeShell()).toBe(false);
  });

  it("counts a bridge without a UA token (a future shell that drops the token)", () => {
    fakeBridge({ version: 1, methods: [] });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0" });
    expect(inNativeShell()).toBe(true);
  });
});

describe("feature detection", () => {
  it("offers a method only when hello() listed it AND the function is there", async () => {
    fakeBridge({ version: 1, methods: ["saveFile", "rePair", "teleport"] }, { saveFile: vi.fn(), openExternal: vi.fn() });
    expect(nativeHas("saveFile")).toBe(false); // nothing is assumed before hello()
    expect(await nativeHello()).toEqual({ version: 1, methods: ["saveFile", "rePair"] });
    expect(nativeHas("saveFile")).toBe(true);
    expect(nativeHas("rePair")).toBe(false); // listed, but no function to call
    expect(nativeHas("openExternal")).toBe(false); // a function, but not listed
  });

  it.each([
    ["no object", null],
    ["a string version", { version: "1", methods: ["saveFile"] }],
    ["a zero version", { version: 0, methods: ["saveFile"] }],
    ["methods that are not a list", { version: 1, methods: "saveFile" }],
  ])("treats a malformed hello (%s) as no features at all", async (_label, hello) => {
    fakeBridge(hello, { saveFile: vi.fn() });
    expect(await nativeHello()).toBeNull();
    expect(nativeHas("saveFile")).toBe(false);
    await expect(callNative("saveFile", {})).rejects.toMatchObject({ code: "native-unavailable" });
  });

  it("gives up on a hello() that never answers, so a hung bridge cannot hang the page", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("murageNative", { hello: () => new Promise(() => {}) });
    const answer = nativeHello(1_500);
    vi.advanceTimersByTime(1_500);
    expect(await answer).toBeNull();
  });

  it("survives a hello() that throws synchronously", async () => {
    vi.stubGlobal("murageNative", { hello: () => { throw new Error("bridge torn down"); } });
    expect(await nativeHello()).toBeNull();
  });

  it("asks hello() once however many callers race it", async () => {
    const bridge = fakeBridge({ version: 2, methods: ["ready"] }, { ready: vi.fn() });
    await Promise.all([nativeHello(), nativeHello(), nativeAvailable("ready")]);
    expect(bridge.hello).toHaveBeenCalledOnce();
  });

  it("passes arguments through and returns what native answered", async () => {
    const saveFile = vi.fn(async () => ({ saved: true }));
    fakeBridge({ version: 1, methods: ["saveFile"] }, { saveFile });
    await expect(callNative("saveFile", { kind: "url", url: "https://h/x", filename: "x" })).resolves.toEqual({ saved: true });
    expect(saveFile).toHaveBeenCalledWith({ kind: "url", url: "https://h/x", filename: "x" });
  });

  it("answers no for everything in a plain browser", async () => {
    expect(await nativeHello()).toBeNull();
    expect(await nativeAvailable("openExternal")).toBe(false);
  });

  it("keeps the two methods Plan 2 added", async () => {
    fakeBridge({ version: 1, methods: ["setRoute", "showLauncher"] }, { setRoute: vi.fn(), showLauncher: vi.fn() });
    expect(await nativeHello()).toEqual({ version: 1, methods: ["setRoute", "showLauncher"] });
    expect(nativeHas("setRoute")).toBe(true);
  });
});

describe("events", () => {
  it("delivers a well-formed notificationOpened and drops a malformed one", () => {
    const bridge = fakeBridge({ version: 1, methods: [] });
    const opened = vi.fn();
    const stop = onNativeEvent("notificationOpened", opened);
    bridge.emit("notificationOpened", { bindingId: "b1", threadId: "t1", messageId: "m1" });
    bridge.emit("notificationOpened", { threadId: "" });
    bridge.emit("notificationOpened", { threadId: "x".repeat(513) });
    bridge.emit("notificationOpened", "t1");
    expect(opened.mock.calls).toEqual([[{ bindingId: "b1", threadId: "t1", messageId: "m1" }]]);
    stop();
    bridge.emit("notificationOpened", { threadId: "t2" });
    expect(opened).toHaveBeenCalledOnce();
  });

  it("is a no-op without a bridge or without on()", () => {
    expect(() => onNativeEvent("resume", vi.fn())()).not.toThrow();
    vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: [] }) });
    expect(() => onNativeEvent("resume", vi.fn())()).not.toThrow();
  });

  // Decision 10: native lets the page claim Back only if a listener returns true. The
  // page's onNativeEvent never does, whatever its own listener returns (Plan 4 decides).
  it("never tells native it handled backButton, even when the listener returns true", () => {
    const bridge = fakeBridge({ version: 1, methods: [] });
    const listener = vi.fn(() => true);
    onNativeEvent("backButton", listener as unknown as () => void);
    const handler = bridge.on.mock.calls[0][1];
    expect(handler()).toBeUndefined();
    expect(listener).toHaveBeenCalledOnce();
  });

  // The native shells reload onto the thread route whenever the wrapper does
  // not answer exactly `true` (ChannelScript.java / .swift `deliver()`), so
  // these confirm every case that must NOT claim handled.
  it("tells native it handled a well-formed notificationOpened", () => {
    const bridge = fakeBridge({ version: 1, methods: [] });
    const opened = vi.fn();
    onNativeEvent("notificationOpened", opened);
    expect(bridge.emit("notificationOpened", { threadId: "t1", messageId: "m1" })).toBe(true);
    expect(opened).toHaveBeenCalledWith({ threadId: "t1", messageId: "m1" });
  });

  // moss-approval-bug.md: a tap on another bot's approval push used to hang
  // up Moss's call. The native shells (ChannelScript.java / .swift) reload
  // the page onto the notification's route in-app (no `window.location`
  // assignment from here) ONLY when this wrapper fails to answer `true`.
  // This drives useDeepLinks.ts's ACTUAL listener (openDeepLink, the real
  // production code, not a stand-in) so the test can actually fail if that
  // path is ever changed to throw, or to reach into call state, while a
  // call is active. What it proves is narrower than "the call survives":
  // it proves only that this path never causes a reload and never touches
  // `@/lib/call` — neither did before this fix, since the real fix is
  // where `Call` is mounted (App.tsx's Shell), which this layer cannot see
  // at all. See src/e2e/call-host.human.spec.ts for the render-level proof
  // that the call keeps running while another thread is selected.
  it("a push tap for another bot's thread, through the real deep-link path: no throw, no reload, and the call is untouched", async () => {
    const { openDeepLink } = await import("./deep-link");
    const { currentCall, endCall, startCall } = await import("./call");
    vi.stubGlobal("window", { muragebox: { speechStop: vi.fn(async () => {}) } });
    const bridge = fakeBridge({ version: 1, methods: [] });
    startCall("moss");
    const state = {
      bots: [
        { id: "moss", threadId: "moss-thread" },
        { id: "sable", threadId: "sable-thread" },
      ],
      groups: [],
    };
    const dispatched: unknown[] = [];
    // useDeepLinks.ts's real listener body: push the notification straight
    // into openDeepLink. If that function were ever changed to check or
    // touch call state (or simply to throw on this shape), this listener
    // would throw and the assertion on `handled` below would catch it.
    const listener = (opened: { threadId: string; messageId?: string }) => {
      openDeepLink(opened, state, (action) => dispatched.push(action));
    };
    onNativeEvent("notificationOpened", listener);
    expect(bridge.emit("notificationOpened", { threadId: "sable-thread" })).toBe(true);
    expect(dispatched).toContainEqual({ type: "select", id: "sable" });
    // The call itself is untouched — openDeepLink has no path to it.
    expect(currentCall()).toBe("moss");
    endCall("moss");
  });

  it("does not claim a malformed notificationOpened", () => {
    const bridge = fakeBridge({ version: 1, methods: [] });
    const opened = vi.fn();
    onNativeEvent("notificationOpened", opened);
    expect(bridge.emit("notificationOpened", { threadId: "" })).toBe(false);
    expect(opened).not.toHaveBeenCalled();
  });

  it("does not claim notificationOpened once unsubscribed", () => {
    const bridge = fakeBridge({ version: 1, methods: [] });
    const opened = vi.fn();
    const stop = onNativeEvent("notificationOpened", opened);
    stop();
    expect(bridge.emit("notificationOpened", { threadId: "t1" })).toBe(false);
    expect(opened).not.toHaveBeenCalled();
  });

  it("does not claim notificationOpened when the listener throws", () => {
    const bridge = fakeBridge({ version: 1, methods: [] });
    const opened = vi.fn(() => {
      throw new Error("boom");
    });
    onNativeEvent("notificationOpened", opened);
    expect(bridge.emit("notificationOpened", { threadId: "t1" })).toBe(false);
    expect(opened).toHaveBeenCalledOnce();
  });

  it("never claims resume, even though the listener ran fine", () => {
    const bridge = fakeBridge({ version: 1, methods: [] });
    const listener = vi.fn();
    onNativeEvent("resume", listener as unknown as () => void);
    expect(bridge.emit("resume")).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("keeps optional ids optional", () => {
    expect(parseNotificationOpened({ threadId: "t1" })).toEqual({ threadId: "t1" });
    expect(parseNotificationOpened({ threadId: "t1", messageId: 7 })).toEqual({ threadId: "t1" });
    expect(parseNativeHello({ version: 1, methods: ["ready", "ready"] })).toEqual({ version: 1, methods: ["ready"] });
  });
});

describe("call audio events (spec §4.1)", () => {
  it("parses each shape and drops anything unknown, missing or oversize", () => {
    expect(parseCallAudioEvent({ type: "mic", session: "s1", pcm: "AAAA" })).toEqual({ type: "mic", session: "s1", pcm: "AAAA" });
    expect(parseCallAudioEvent({ type: "mic", session: "s1", pcm: "A".repeat(8_193) })).toBeNull();
    expect(parseCallAudioEvent({ type: "mic", session: "s1", pcm: 7 })).toBeNull();
    expect(parseCallAudioEvent({ type: "mic", session: "s1" })).toBeNull();
    expect(parseCallAudioEvent({ type: "mic", session: "", pcm: "AA" })).toBeNull();
    expect(parseCallAudioEvent({ type: "mic", session: "x".repeat(513), pcm: "AA" })).toBeNull();

    expect(parseCallAudioEvent({ type: "clip", session: "s1", clip: "c1", state: "playing" })).toEqual({
      type: "clip",
      session: "s1",
      clip: "c1",
      state: "playing",
    });
    expect(parseCallAudioEvent({ type: "clip", session: "s1", clip: "c1", state: "unknown" })).toBeNull();
    expect(parseCallAudioEvent({ type: "clip", session: "s1", clip: "x".repeat(513), state: "ended" })).toBeNull();
    expect(parseCallAudioEvent({ type: "clip", session: "s1", clip: "c1" })).toBeNull();

    // reason (spec §4.1 rev 3) only means anything alongside state "cut".
    expect(parseCallAudioEvent({ type: "clip", session: "s1", clip: "c1", state: "cut", reason: "hold" })).toEqual({
      type: "clip",
      session: "s1",
      clip: "c1",
      state: "cut",
      reason: "hold",
    });
    expect(parseCallAudioEvent({ type: "clip", session: "s1", clip: "c1", state: "cut", reason: "stop" })).toEqual({
      type: "clip",
      session: "s1",
      clip: "c1",
      state: "cut",
      reason: "stop",
    });
    expect(parseCallAudioEvent({ type: "clip", session: "s1", clip: "c1", state: "cut", reason: "next" })).toEqual({
      type: "clip",
      session: "s1",
      clip: "c1",
      state: "cut",
      reason: "next",
    });
    // an unrecognised reason is dropped on its own, not the whole event.
    expect(parseCallAudioEvent({ type: "clip", session: "s1", clip: "c1", state: "cut", reason: "explode" })).toEqual({
      type: "clip",
      session: "s1",
      clip: "c1",
      state: "cut",
    });
    expect(parseCallAudioEvent({ type: "clip", session: "s1", clip: "c1", state: "cut" })).toEqual({
      type: "clip",
      session: "s1",
      clip: "c1",
      state: "cut",
    });
    // a reason on any other state is ignored, not surfaced.
    expect(parseCallAudioEvent({ type: "clip", session: "s1", clip: "c1", state: "playing", reason: "hold" })).toEqual({
      type: "clip",
      session: "s1",
      clip: "c1",
      state: "playing",
    });

    expect(parseCallAudioEvent({ type: "hold", session: "s1", reason: "interrupted" })).toEqual({ type: "hold", session: "s1", reason: "interrupted" });
    expect(parseCallAudioEvent({ type: "hold", session: "s1", reason: "napping" })).toBeNull();

    expect(parseCallAudioEvent({ type: "resume", session: "s1" })).toEqual({ type: "resume", session: "s1" });
    expect(parseCallAudioEvent({ type: "resume" })).toBeNull();

    expect(parseCallAudioEvent({ type: "lost", session: "s1", reason: "engine could not restart" })).toEqual({
      type: "lost",
      session: "s1",
      reason: "engine could not restart",
    });
    expect(parseCallAudioEvent({ type: "lost", session: "s1", reason: 7 })).toBeNull();
    expect(parseCallAudioEvent({ type: "lost", session: "s1", reason: "" })).toBeNull();

    expect(parseCallAudioEvent({ type: "route", session: "s1", output: "bluetooth" })).toEqual({ type: "route", session: "s1", output: "bluetooth" });
    expect(parseCallAudioEvent({ type: "route", session: "s1", output: "usb" })).toBeNull();

    expect(parseCallAudioEvent({ type: "explode", session: "s1" })).toBeNull();
    expect(parseCallAudioEvent(null)).toBeNull();
    expect(parseCallAudioEvent("mic")).toBeNull();
    expect(parseCallAudioEvent(["mic"])).toBeNull();
  });

  it("tells native it handled a well-formed callAudio event, so the mic watchdog (spec §4.2.7) sees it as live", () => {
    const bridge = fakeBridge({ version: 1, methods: [] });
    const events: CallAudioEvent[] = [];
    const stop = onNativeEvent("callAudio", (event) => events.push(event));
    expect(bridge.emit("callAudio", { type: "mic", session: "s1", pcm: "AAAA" })).toBe(true);
    expect(events).toEqual([{ type: "mic", session: "s1", pcm: "AAAA" }]);
    stop();
    expect(bridge.emit("callAudio", { type: "resume", session: "s1" })).toBe(false);
    expect(events).toHaveLength(1);
  });

  it("does not claim a malformed callAudio event", () => {
    const bridge = fakeBridge({ version: 1, methods: [] });
    const event = vi.fn();
    onNativeEvent("callAudio", event);
    expect(bridge.emit("callAudio", { type: "explode", session: "s1" })).toBe(false);
    expect(event).not.toHaveBeenCalled();
  });

  it("does not claim handled when the listener throws", () => {
    const bridge = fakeBridge({ version: 1, methods: [] });
    const listener = vi.fn(() => {
      throw new Error("boom");
    });
    onNativeEvent("callAudio", listener);
    expect(bridge.emit("callAudio", { type: "resume", session: "s1" })).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
  });
});

it("is asked at boot, so synchronous checks have an answer by the first tap", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
  expect(main).toContain("void nativeHello();");
});
