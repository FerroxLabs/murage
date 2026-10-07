import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { currentCall, deferCallCleanup, endCall, startCall } from "./call";
import { resetNativeShellForTest } from "./native-shell";

describe("call ownership", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { muragebox: { speechStop: vi.fn(async () => {}) } });
    endCall();
  });

  afterEach(() => {
    resetNativeShellForTest();
    vi.unstubAllGlobals();
  });

  it("does not let stale cleanup hang up a newer call", () => {
    startCall("bot-a");
    startCall("bot-b");

    expect(endCall("bot-a")).toBe(false);
    expect(currentCall()).toBe("bot-b");
    expect(endCall("bot-b")).toBe(true);
    expect(currentCall()).toBeNull();
  });

  it("does not let StrictMode's effect probe hang up a new call", async () => {
    startCall("bot-a");
    let mounted = false;
    deferCallCleanup("bot-a", () => mounted);
    mounted = true;

    await Promise.resolve();

    expect(currentCall()).toBe("bot-a");
  });

  it("hangs up after a genuine call-screen unmount", async () => {
    startCall("bot-a");
    deferCallCleanup("bot-a", () => false);

    await Promise.resolve();

    expect(currentCall()).toBeNull();
  });
});

// callbar-rereview.md M4: Android has no call-audio engine of its own, so
// this is its only signal that a call is live -- the page tells native,
// fire-and-forget, on every start and every genuine end.
describe("call ownership notifies native (M4)", () => {
  function fakeBridge() {
    const calls: string[] = [];
    const bridge = {
      hello: vi.fn(async () => ({ version: 1, methods: ["callSessionOpen", "callSessionClose"] })),
      callSessionOpen: vi.fn(async () => {
        calls.push("open");
      }),
      callSessionClose: vi.fn(async () => {
        calls.push("close");
      }),
    };
    vi.stubGlobal("murageNative", bridge);
    return calls;
  }

  /** callNative chains several promise hops (hello(), then the method
   * itself); a macrotask boundary guarantees every microtask in that chain
   * has run, however many hops it takes. */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    vi.stubGlobal("window", { muragebox: { speechStop: vi.fn(async () => {}) } });
    endCall();
  });

  afterEach(() => {
    resetNativeShellForTest();
    vi.unstubAllGlobals();
  });

  it("tells native a session opened, then closed, on a real start and a real end", async () => {
    const calls = fakeBridge();
    startCall("bot-a");
    await flush();
    expect(endCall("bot-a")).toBe(true);
    await flush();
    expect(calls).toEqual(["open", "close"]);
  });

  it("never tells native anything for a no-op start, or a mismatched end", async () => {
    const calls = fakeBridge();
    startCall("bot-a");
    await flush();
    calls.length = 0;
    startCall("bot-a"); // already on this call
    expect(endCall("bot-b")).toBe(false); // not the current call
    await flush();
    expect(calls).toEqual([]);
  });

  it("is a harmless no-op when no native bridge, or an older one that never listed this, is present -- desktop included", async () => {
    // No murageNative stubbed at all (desktop, browser, or an older app
    // build on either platform): callNative rejects "native-unavailable"
    // and notifyNativeCallSession swallows it.
    expect(() => startCall("bot-a")).not.toThrow();
    expect(() => endCall("bot-a")).not.toThrow();
    await flush();
  });
});
