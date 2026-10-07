// The phone shell keeps the page's [call-diag] and [call-trace] lines in a
// file on the device (apps/mobile channel method diagLine). Only those two
// prefixes cross, throttled and capped; nothing else on the console does.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DIAG_MAX_CHARS,
  DIAG_MAX_PER_SECOND,
  createDiagForwarder,
  diagLineFor,
  installCallDiagForward,
  resetCallDiagForwardForTest,
} from "./call-diag-forward";
import { resetNativeShellForTest } from "./native-shell";

afterEach(() => {
  resetNativeShellForTest();
  resetCallDiagForwardForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("diagLineFor", () => {
  it("passes a lone string that starts with a diag prefix", () => {
    expect(diagLineFor(["[call-diag] audio native"])).toBe("[call-diag] audio native");
    expect(diagLineFor(["[call-trace] turn sent words=4"])).toBe("[call-trace] turn sent words=4");
  });

  it("refuses everything else", () => {
    expect(diagLineFor(["hello"])).toBeNull();
    expect(diagLineFor([" [call-diag] leading space"])).toBeNull();
    expect(diagLineFor(["transcript [call-diag]"])).toBeNull();
    expect(diagLineFor([{ a: 1 }])).toBeNull();
    expect(diagLineFor([])).toBeNull();
    expect(diagLineFor([42])).toBeNull();
  });

  it("drops extra arguments rather than forwarding them", () => {
    expect(diagLineFor(["[call-diag] x", "the owner said something"])).toBe("[call-diag] x");
  });

  it("caps the length and strips line breaks", () => {
    const long = diagLineFor(["[call-diag] " + "a".repeat(2000)])!;
    expect(long.length).toBe(DIAG_MAX_CHARS);
    expect(diagLineFor(["[call-diag] a\nb\r\nc"])).toBe("[call-diag] a b  c");
  });
});

describe("createDiagForwarder", () => {
  it("sends up to the per-second budget and drops the rest, then refills", () => {
    let t = 1000;
    const send = vi.fn();
    const forward = createDiagForwarder(send, () => t);
    for (let i = 0; i < DIAG_MAX_PER_SECOND + 15; i++) forward(["[call-diag] n " + i]);
    expect(send).toHaveBeenCalledTimes(DIAG_MAX_PER_SECOND);
    t += 1000;
    forward(["[call-diag] later"]);
    expect(send).toHaveBeenCalledTimes(DIAG_MAX_PER_SECOND + 1);
  });

  it("does not spend budget on lines it refuses", () => {
    const send = vi.fn();
    const forward = createDiagForwarder(send, () => 0);
    for (let i = 0; i < 100; i++) forward(["noise " + i]);
    forward(["[call-diag] ok"]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

function fakeBridge(methods: string[]) {
  const diagLine = vi.fn(async () => true);
  vi.stubGlobal("murageNative", {
    hello: vi.fn(async () => ({ version: 1, methods })),
    diagLine,
  });
  return diagLine;
}

describe("installCallDiagForward", () => {
  function stubConsole() {
    const warn = vi.fn();
    const log = vi.fn();
    vi.stubGlobal("console", { warn, log, info: vi.fn(), error: vi.fn() });
    return { warn, log };
  }

  it("does nothing outside the phone shell", () => {
    const { warn } = stubConsole();
    const before = console.warn;
    installCallDiagForward(false);
    expect(console.warn).toBe(before);
    expect(warn).not.toHaveBeenCalled();
  });

  it("forwards diag lines, still prints them, and ignores other output", async () => {
    const diagLine = fakeBridge(["diagLine"]);
    const { warn, log } = stubConsole();
    installCallDiagForward(true);
    console.warn("[call-diag] stream: live");
    console.warn("not a diag line");
    console.log("[call-trace] hold words=3");
    console.log("plain");
    await vi.waitFor(() => expect(diagLine).toHaveBeenCalledTimes(2));
    expect(diagLine).toHaveBeenNthCalledWith(1, "[call-diag] stream: live");
    expect(diagLine).toHaveBeenNthCalledWith(2, "[call-trace] hold words=3");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("is silent when this app build does not list diagLine, and never throws", async () => {
    const diagLine = fakeBridge(["ready"]);
    stubConsole();
    installCallDiagForward(true);
    expect(() => console.warn("[call-diag] x")).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(diagLine).not.toHaveBeenCalled();
  });

  it("installs once", () => {
    stubConsole();
    installCallDiagForward(true);
    const first = console.warn;
    installCallDiagForward(true);
    expect(console.warn).toBe(first);
  });
});
