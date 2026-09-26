import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { nativeHello, resetNativeShellForTest } from "@/lib/native-shell";
import { pairAgain } from "./SignedOutCard";

afterEach(() => {
  resetNativeShellForTest();
  vi.unstubAllGlobals();
});

describe("pairing again", () => {
  it("hands over to the phone app's own re-pair screen when it has one", async () => {
    const rePair = vi.fn(async () => undefined);
    const assign = vi.fn();
    vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["rePair"] }), rePair });
    vi.stubGlobal("location", { assign });
    await nativeHello();
    await pairAgain();
    expect(rePair).toHaveBeenCalledOnce();
    expect(assign).not.toHaveBeenCalled();
  });

  it("sends a browser to the door's code page", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign });
    await pairAgain();
    expect(assign).toHaveBeenCalledWith("/enter");
  });

  it("falls back to the code page when the app's re-pair fails", async () => {
    const assign = vi.fn();
    vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["rePair"] }), rePair: async () => { throw new Error("gone"); } });
    vi.stubGlobal("location", { assign });
    await nativeHello();
    await pairAgain();
    expect(assign).toHaveBeenCalledWith("/enter");
  });

  it("is shown over everything once the store says signed out", () => {
    const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
    expect(app).toContain("{state.signedOut && <SignedOutCard />}");
  });
});
