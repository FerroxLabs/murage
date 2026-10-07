// The phone app reopens the last conversation after its WebView dies or the
// app is killed (spec §3.2 "Persisted state", §7). The page keeps no route in
// its URL, so it tells native which thread is on screen.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { nativeHello, resetNativeShellForTest } from "./native-shell";
import { createRouteReporter, reportRoute } from "./native-route";

afterEach(() => {
  resetNativeShellForTest();
  vi.unstubAllGlobals();
});

describe("telling the phone app which conversation is open", () => {
  it("sends each new thread once", () => {
    const send = vi.fn(() => true);
    const report = createRouteReporter(send);
    report("t1");
    report("t1");
    report("t2");
    expect(send.mock.calls).toEqual([["t1"], ["t2"]]);
  });

  it("keeps the last chat when the person opens settings or the inbox", () => {
    const send = vi.fn(() => true);
    const report = createRouteReporter(send);
    report("t1");
    report(null);
    report(undefined);
    report("t1");
    expect(send).toHaveBeenCalledOnce();
  });

  it("tries again when the first report came before hello() answered", () => {
    const send = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const report = createRouteReporter(send);
    report("t1");
    report("t1");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("calls setRoute with the thread once the app has listed it", async () => {
    const setRoute = vi.fn(async () => true);
    vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["setRoute"] }), setRoute });
    await nativeHello();
    reportRoute("thread-42");
    await new Promise((resolve) => setTimeout(resolve, 0)); // callNative awaits hello() first
    expect(setRoute).toHaveBeenCalledWith({ threadId: "thread-42" });
  });

  it("does nothing in a plain browser", () => {
    expect(() => reportRoute("thread-43")).not.toThrow();
  });

  it("is wired where the first snapshot is known", () => {
    const hook = readFileSync(new URL("../components/useDeepLinks.ts", import.meta.url), "utf8");
    expect(hook).toContain("state.hydrated ? visibleNotificationThread(state) : null");
    expect(hook).toContain("reportRoute(onScreen)");
  });
});
