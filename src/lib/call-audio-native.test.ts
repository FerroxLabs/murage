// Choosing the call's audio path (spec §4.3.2): native on an iPhone build that
// lists callAudioOpen, unless the page's kill switch says otherwise.
import { afterEach, describe, expect, it, vi } from "vitest";

import { NATIVE_CALL_AUDIO, nativeCallAudioWanted } from "./call-audio-native";
import { resetNativeShellForTest } from "./native-shell";

afterEach(() => {
  resetNativeShellForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fakeBridge(methods: string[], helloDelayMs = 0) {
  const bridge: Record<string, unknown> = {
    hello: vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve({ version: 1, methods }), helloDelayMs)),
    ),
  };
  for (const method of methods) bridge[method] = vi.fn(async () => true);
  vi.stubGlobal("murageNative", bridge);
  return bridge;
}

function storage(value: string | null) {
  vi.stubGlobal("localStorage", { getItem: vi.fn(() => value) });
}

describe("nativeCallAudioWanted", () => {
  it("ships switched on", () => {
    expect(NATIVE_CALL_AUDIO).toBe(true);
  });

  it("picks native when the app lists callAudioOpen, and logs the fixed line", async () => {
    fakeBridge(["callAudioOpen", "callAudioClose"]);
    storage(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(nativeCallAudioWanted()).resolves.toBe(true);
    expect(warn).toHaveBeenCalledWith("[call-diag] audio native");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("picks the web path without the method, and logs the fixed line", async () => {
    fakeBridge(["ready"]);
    storage(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(nativeCallAudioWanted()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith("[call-diag] audio web");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("picks the web path outside the app", async () => {
    storage(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(nativeCallAudioWanted()).resolves.toBe(false);
  });

  it("waits for a late hello rather than deciding at render", async () => {
    vi.useFakeTimers();
    fakeBridge(["callAudioOpen"], 800);
    storage(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let answer: boolean | undefined;
    void nativeCallAudioWanted().then((value) => (answer = value));
    await vi.advanceTimersByTimeAsync(700);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(answer).toBe(true);
  });

  it("forces the web path when this device's switch is off", async () => {
    const bridge = fakeBridge(["callAudioOpen"]);
    storage("off");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(nativeCallAudioWanted()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith("[call-diag] audio web");
    expect(bridge.callAudioOpen).not.toHaveBeenCalled();
  });

  it("treats unreadable storage as switched on", async () => {
    fakeBridge(["callAudioOpen"]);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(nativeCallAudioWanted()).resolves.toBe(true);
  });
});
