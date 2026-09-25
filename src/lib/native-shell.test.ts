// The phone app's channel, as the page sees it. Nothing here may assume a
// method exists: an older app, or an Android WebView missing a feature,
// hands the page less than the newest one does (spec §3.2).
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  callNative,
  hasNativeUserAgent,
  inNativeShell,
  nativeAvailable,
  nativeHas,
  nativeHello,
  onNativeEvent,
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
  const listeners = new Map<string, Set<(detail?: unknown) => void>>();
  const bridge = {
    hello: vi.fn(async () => hello),
    on: vi.fn((name: string, listener: (detail?: unknown) => void) => {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => set.delete(listener);
    }),
    emit(name: string, detail?: unknown) {
      for (const listener of listeners.get(name) ?? []) listener(detail);
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

  it("keeps optional ids optional", () => {
    expect(parseNotificationOpened({ threadId: "t1" })).toEqual({ threadId: "t1" });
    expect(parseNotificationOpened({ threadId: "t1", messageId: 7 })).toEqual({ threadId: "t1" });
    expect(parseNativeHello({ version: 1, methods: ["ready", "ready"] })).toEqual({ version: 1, methods: ["ready"] });
  });
});

it("is asked at boot, so synchronous checks have an answer by the first tap", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
  expect(main).toContain("void nativeHello();");
});
