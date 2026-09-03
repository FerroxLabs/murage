// The device door's pairing route, and the limiter that was missing from it.
//
// `POST /api/pair` used to have exactly one bound: the pairing window's own
// five-wrong-guess burn, inside `devices.ts`. That is a limit on the CODE, not
// on the CALLER — so any unauthenticated peer that could reach the device port
// could destroy a live pairing window in five requests, and destroy the next
// one the moment it opened. A permanent denial of service on pairing, from a
// door that answers before any credential exists.
//
// The browser door closed the same hole on `POST /session` with
// `createSignInLimiter`. These tests pin that the device door now uses THAT
// limiter — the exported one, not a second implementation — and that it keeps
// the two fail-closed properties that make it worth having: a locked client
// never reaches `redeem`, and a client the table has no room for is refused
// rather than waved through.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSignInLimiter,
  SIGN_IN_FREE_ATTEMPTS,
  SIGN_IN_MAX_CLIENTS,
  type SignInLimiter,
} from "../src/browser.ts";
import { DeviceRegistry, MAX_PAIRING_ATTEMPTS } from "../src/devices.ts";
import { createProxyHandler, type ProxyOptions } from "../src/proxy.ts";

/** Every key the handler charged an attempt to, in order, plus which calls it
 * made. A stub rather than a mock of the limiter itself: the limiter under
 * test is the real exported one wherever the property being tested is the
 * limiter's, and this only watches. */
interface Watched extends SignInLimiter {
  checked: string[];
  failed: string[];
  succeeded: string[];
}

const watch = (inner: SignInLimiter): Watched => {
  const checked: string[] = [];
  const failed: string[] = [];
  const succeeded: string[] = [];
  return {
    checked,
    failed,
    succeeded,
    check: (key, now) => {
      checked.push(key);
      return inner.check(key, now);
    },
    fail: (key, now) => {
      failed.push(key);
      return inner.fail(key, now);
    },
    succeed: (key) => {
      succeeded.push(key);
      inner.succeed(key);
    },
  };
};

let open: Server[] = [];

afterEach(async () => {
  for (const server of open) await new Promise<void>((r) => server.close(() => r()));
  open = [];
});

/** A device door on a real socket, because the client key is the socket's
 * peer address and a handler called directly with a fabricated request would
 * be testing the fabrication. */
const door = async (options: Partial<ProxyOptions> & Pick<ProxyOptions, "redeem">) => {
  const server = createServer(
    createProxyHandler({
      harnessPort: 1,
      authenticate: () => null,
      serverName: () => "Ada's computer",
      ...options,
    }),
  );
  open.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    /** One pairing attempt, as a phone with no token makes it. */
    pair: async (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: any = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      return { status: res.status, body: parsed, retryAfter: res.headers.get("retry-after") };
    },
  };
};

describe("the pairing route's per-client limiter", () => {
  it("refuses a locked client with a 429 the door already speaks, and never reaches redeem", async () => {
    let redeems = 0;
    const limiter = watch(createSignInLimiter());
    const d = await door({
      signInLimiter: limiter,
      redeem: () => {
        redeems += 1;
        return { error: "that pairing code is not right", reason: "wrong" };
      },
    });

    // Three free failures, then the fourth locks. Every one of these is a
    // real 401 from redeem, so the count below is the honest one.
    for (let i = 0; i <= SIGN_IN_FREE_ATTEMPTS; i++) {
      expect((await d.pair({ code: "000000" })).status).toBe(401);
    }
    expect(redeems).toBe(SIGN_IN_FREE_ATTEMPTS + 1);

    const locked = await d.pair({ code: "000000" });
    expect(locked.status).toBe(429);
    // The browser door's shape: a Retry-After header, and the same hint in
    // the body so a client that never reads headers still backs off.
    expect(locked.retryAfter).toBe("5");
    expect(locked.body.retryAfter).toBe(5);
    expect(locked.body.error).toMatch(/too many pairing attempts/);
    // The whole point. A refusal that still called redeem would be a refusal
    // that still spent one of the window's five attempts.
    expect(redeems).toBe(SIGN_IN_FREE_ATTEMPTS + 1);
    expect(limiter.checked.length).toBe(SIGN_IN_FREE_ATTEMPTS + 2);
  });

  it("does not spend one of the window's five attempts while a client is locked out", async () => {
    // The real registry, so the attempt budget being protected is the real
    // one. Four wrong guesses leave the window alive with one attempt left
    // AND leave this client locked out — the exact state in which a limiter
    // that ran after redeem would burn the window's last attempt.
    const devices = new DeviceRegistry();
    const window = devices.openPairing();
    const d = await door({
      redeem: (code, name, id) => devices.redeem(code, name, id),
    });

    for (let i = 0; i <= SIGN_IN_FREE_ATTEMPTS; i++) {
      expect((await d.pair({ code: "000000", deviceName: "Impostor" })).status).toBe(401);
    }
    expect(devices.pairing()?.attemptsLeft).toBe(MAX_PAIRING_ATTEMPTS - (SIGN_IN_FREE_ATTEMPTS + 1));
    expect(devices.pairing()?.attemptsLeft).toBeGreaterThan(0);

    // Locked. Even the RIGHT credential is refused here, which is the cost
    // being accepted on purpose: the window survives.
    const locked = await d.pair({ credential: window.token, deviceName: "Ada's iPhone" });
    expect(locked.status).toBe(429);
    expect(devices.pairing()?.attemptsLeft).toBe(MAX_PAIRING_ATTEMPTS - (SIGN_IN_FREE_ATTEMPTS + 1));

    // And the window is still redeemable — it was not burned by the flood.
    const redeemed = devices.redeem(window.token, "Ada's iPhone");
    expect("error" in redeemed).toBe(false);
  });

  it("forgets a client the moment it pairs successfully", async () => {
    const devices = new DeviceRegistry();
    const window = devices.openPairing();
    const limiter = watch(createSignInLimiter());
    const d = await door({
      signInLimiter: limiter,
      redeem: (code, name, id) => devices.redeem(code, name, id),
      hosts: () => [],
    });

    // Failures first, so there is a record to clear.
    for (let i = 0; i < SIGN_IN_FREE_ATTEMPTS; i++) {
      expect((await d.pair({ code: "000000" })).status).toBe(401);
    }
    expect(limiter.failed.length).toBe(SIGN_IN_FREE_ATTEMPTS);

    const ok = await d.pair({ credential: window.token, deviceName: "Ada's iPhone" });
    expect(ok.status).toBe(201);

    // Cleared, not merely reset to "one failure from a lockout": the next
    // browser or phone on this machine starts with the full free budget.
    // Asserted as behaviour before it is asserted as a call, so that a route
    // which stopped calling `succeed` fails here rather than only on the spy.
    devices.openPairing();
    for (let i = 0; i <= SIGN_IN_FREE_ATTEMPTS; i++) {
      // Every one of these reaches redeem. With the record left in place the
      // fourth would be a 429 instead, because the three failures above would
      // still be counted against this client.
      expect((await d.pair({ code: "000000" })).status).toBe(401);
    }
    expect(devices.pairing()?.attemptsLeft).toBe(MAX_PAIRING_ATTEMPTS - (SIGN_IN_FREE_ATTEMPTS + 1));
    expect(limiter.succeeded).toEqual(["127.0.0.1"]);
  });

  it("charges the socket's address and ignores X-Forwarded-For", async () => {
    // Bound directly to the tailnet this header is written by whoever is
    // connecting. A limiter keyed on it would let an attacker mint a fresh
    // identity per guess, which is a limiter that does nothing at all.
    const limiter = watch(createSignInLimiter());
    const d = await door({
      signInLimiter: limiter,
      redeem: () => ({ error: "that pairing code is not right", reason: "wrong" }),
    });

    for (let i = 0; i <= SIGN_IN_FREE_ATTEMPTS; i++) {
      expect(
        (await d.pair({ code: "000000" }, { "x-forwarded-for": `203.0.113.${i}` })).status,
      ).toBe(401);
    }
    // One key, not four. Every charge landed on the peer address.
    expect(new Set(limiter.failed)).toEqual(new Set(["127.0.0.1"]));
    expect(limiter.failed).not.toContain("203.0.113.0");

    // And the lockout it built cannot be shed by claiming to be someone else.
    const dodge = await d.pair({ code: "000000" }, { "x-forwarded-for": "198.51.100.7" });
    expect(dodge.status).toBe(429);
  });

  it("refuses an unknown client rather than admitting one when the table is full", async () => {
    // Full means refuse, not evict: evicting would let an attacker clear
    // their own lockout by making noise from other addresses. The property
    // lives in the limiter; this pins that the route honours it instead of
    // treating "no bucket" as "no problem".
    let redeems = 0;
    const limiter = createSignInLimiter();
    for (let i = 0; i < SIGN_IN_MAX_CLIENTS; i++) limiter.fail(`100.64.0.${i}`);
    const d = await door({
      signInLimiter: limiter,
      redeem: () => {
        redeems += 1;
        return { error: "that pairing code is not right", reason: "wrong" };
      },
    });

    const refused = await d.pair({ code: "000000" });
    expect(refused.status).toBe(429);
    expect(redeems).toBe(0);
  });

  it("does not charge a refusal that means the credential was right", async () => {
    // `full` is the fleet being at its ceiling and `save-failed` is the disk.
    // Both mean the person is holding the correct code, and locking them out
    // for them would punish the only caller who should get in.
    const limiter = watch(createSignInLimiter());
    const d = await door({
      signInLimiter: limiter,
      redeem: () => ({ error: "no room for another device", reason: "full" }),
    });

    for (let i = 0; i < SIGN_IN_FREE_ATTEMPTS + 3; i++) {
      expect((await d.pair({ code: "000000" })).status).toBe(401);
    }
    expect(limiter.failed).toEqual([]);
  });
});
