import { afterEach, describe, expect, it, vi } from "vitest";

import { nativeHello, resetNativeShellForTest } from "./native-shell";
import { PAIR_AGAIN_PATH } from "./session-check";
import { afterSignOut, signOutThisDevice } from "./remote-sign-out";

afterEach(() => {
  resetNativeShellForTest();
  vi.unstubAllGlobals();
});

const reply = (status: number, body: unknown = {}) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("signing this device out", () => {
  it("asks the door to remove this device, as a same-origin DELETE", async () => {
    const fetchImpl = reply(200, { ok: true });
    expect(await signOutThisDevice(fetchImpl as unknown as typeof fetch)).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith("/session/device", { method: "DELETE", credentials: "same-origin" });
  });

  it("treats an already-signed-out device as done", async () => {
    expect(await signOutThisDevice(reply(401, { error: "sign in" }) as unknown as typeof fetch)).toEqual({ ok: true });
  });

  it("says the computer's own sentence when it could not finish", async () => {
    const result = await signOutThisDevice(
      reply(500, { error: "could not sign this device out on the computer — try again" }) as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, error: "could not sign this device out on the computer — try again" });
  });

  it("says the computer is unreachable when the request never lands", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await signOutThisDevice(offline as unknown as typeof fetch);
    expect(result.ok).toBe(false);
  });
});

describe("after signing out", () => {
  it("hands over to the app's re-pair screen through the hello()-negotiated bridge", async () => {
    const signOut = vi.fn(async () => undefined);
    const replace = vi.fn();
    vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["signOut"] }), signOut });
    await nativeHello();
    await afterSignOut({ location: { replace } } as unknown as Window);
    expect(signOut).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
  });

  it("goes to the door's sign-in page when the bridge does not list signOut", async () => {
    const signOut = vi.fn();
    const replace = vi.fn();
    vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: [] }), signOut });
    await nativeHello();
    await afterSignOut({ location: { replace } } as unknown as Window);
    expect(signOut).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith(PAIR_AGAIN_PATH);
  });

  it("falls back to the door's sign-in page when the native call rejects", async () => {
    const signOut = vi.fn(async () => {
      throw new Error("bridge torn down");
    });
    const replace = vi.fn();
    vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["signOut"] }), signOut });
    await nativeHello();
    await afterSignOut({ location: { replace } } as unknown as Window);
    expect(signOut).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith(PAIR_AGAIN_PATH);
  });

  it("goes back to the door's sign-in page in a plain browser", async () => {
    const replace = vi.fn();
    await afterSignOut({ location: { replace } } as unknown as Window);
    expect(replace).toHaveBeenCalledWith(PAIR_AGAIN_PATH);
  });
});
