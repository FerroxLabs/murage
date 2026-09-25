// A 401 from an API route is not proof of being signed out: a harness route
// answers 401 for a provider IT could not sign in to (server/avatar-image.ts
// :297). And the event stream cannot report a status at all. Only the door's
// own GET /session can say this browser has lost its session (spec §3.6).
import { describe, expect, it, vi } from "vitest";

import { SESSION_CHECK_MIN_GAP_MS, createSessionWatch, sessionVerdict } from "./session-check";

function watch(answer: () => Promise<{ status: number }>, options: { desktop?: boolean } = {}) {
  let now = 0;
  const fetch = vi.fn(answer);
  const session = createSessionWatch({ fetch, now: () => now, desktop: () => options.desktop ?? false });
  return { session, fetch, advance: (ms: number) => { now += ms; } };
}

describe("reading the door's answer", () => {
  it("only an actual 401 means signed out", () => {
    expect(sessionVerdict(401)).toBe("signed-out");
    expect(sessionVerdict(200)).toBe("signed-in");
    // A network failure is a host that is asleep, not a person signed out.
    expect(sessionVerdict(null)).toBe("unknown");
    // The desktop dev server answers /session with the SPA shell; a harness
    // restart answers 502 through the door. Neither may sign anyone out.
    expect(sessionVerdict(404)).toBe("unknown");
    expect(sessionVerdict(502)).toBe("unknown");
  });
});

describe("the watch", () => {
  it("announces signed-out once, and stays signed out", async () => {
    const { session, fetch } = watch(async () => ({ status: 401 }));
    const listener = vi.fn();
    session.onSignedOut(listener);
    expect(await session.check()).toBe("signed-out");
    expect(await session.check()).toBe("signed-out");
    expect(listener).toHaveBeenCalledOnce();
    expect(session.isSignedOut()).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/session", { credentials: "same-origin", cache: "no-store" });
  });

  it("keeps the app signed in when an API 401 turns out to be the harness's own", async () => {
    const { session } = watch(async () => ({ status: 200 }));
    const listener = vi.fn();
    session.onSignedOut(listener);
    expect(await session.check()).toBe("signed-in");
    expect(listener).not.toHaveBeenCalled();
  });

  it("treats an unreachable door as unknown, so reconnecting continues", async () => {
    const { session } = watch(async () => { throw new TypeError("Failed to fetch"); });
    expect(await session.check()).toBe("unknown");
    expect(session.isSignedOut()).toBe(false);
  });

  it("asks once for a burst of 401s, and not again inside the gap", async () => {
    let release!: (value: { status: number }) => void;
    const { session, fetch, advance } = watch(() => new Promise((resolve) => { release = resolve; }));
    const burst = [session.check(), session.check(), session.check()];
    release({ status: 200 });
    expect(await Promise.all(burst)).toEqual(["signed-in", "signed-in", "signed-in"]);
    expect(await session.check()).toBe("signed-in");
    expect(fetch).toHaveBeenCalledOnce();
    advance(SESSION_CHECK_MIN_GAP_MS);
    void session.check();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never asks on the desktop, which has no door and no session", async () => {
    const { session, fetch } = watch(async () => ({ status: 401 }), { desktop: true });
    expect(await session.check()).toBe("unknown");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tells a late subscriber that sign-out already happened", async () => {
    const { session } = watch(async () => ({ status: 401 }));
    await session.check();
    const late = vi.fn();
    session.onSignedOut(late);
    await Promise.resolve();
    expect(late).toHaveBeenCalledOnce();
  });
});
