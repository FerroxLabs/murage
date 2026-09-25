import { describe, expect, it, vi } from "vitest";

import { afterSignOut, signOutThisDevice } from "./remote-sign-out";

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
  it("hands over to the app's re-pair screen when running inside the app", () => {
    const signOut = vi.fn();
    const replace = vi.fn();
    afterSignOut({ murageNative: { signOut }, location: { replace } } as unknown as Window);
    expect(signOut).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
  });

  it("goes back to the door's sign-in page in a plain browser", () => {
    const replace = vi.fn();
    afterSignOut({ location: { replace } } as unknown as Window);
    expect(replace).toHaveBeenCalledWith("/");
  });
});
