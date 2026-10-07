// A reviewer's phone reaches the door through a TLS reverse proxy on this
// machine (Caddy -> 127.0.0.1:8813). Two things have to hold there: the door
// still knows its client is on https, and one reviewer's wrong guesses are not
// charged to the next reviewer.
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import {
  browserFront,
  expectedOrigin,
  originGate,
  reconcileBrowserFront,
  signInClientKey,
  type BoundIdentity,
} from "../src/browser.ts";

const FRONT = browserFront("https://review.murage.ai");
const req = (headers: Record<string, string>, peer = "127.0.0.1"): IncomingMessage =>
  ({ headers, method: "POST", socket: { remoteAddress: peer } }) as unknown as IncomingMessage;

describe("a configured proxy front", () => {
  it("survives moveBrowserDoor when Tailscale is not ours", () => {
    for (const owner of ["none", "other", "unknown"] as const) {
      expect(reconcileBrowserFront(owner, null, FRONT), owner).toEqual(FRONT);
    }
  });

  it("yields to a Tailscale-owned front when Tailscale is ours", () => {
    expect(reconcileBrowserFront("ours", "https://box.tail1.ts.net", FRONT)?.host).toBe("box.tail1.ts.net");
  });

  it("default (no front configured) is unchanged: null", () => {
    expect(reconcileBrowserFront("none", null, null)).toBeNull();
    expect(reconcileBrowserFront("other", null, null)).toBeNull();
  });
});

describe("origin check behind the proxy", () => {
  const identity: BoundIdentity = { scheme: "https", hosts: new Set(["review.murage.ai"]) };
  const post = (origin: string, host = "review.murage.ai") =>
    req({ host, origin, "sec-fetch-site": "same-origin" });

  it("expects https://review.murage.ai", () => {
    expect(expectedOrigin(post("https://review.murage.ai"), identity)).toBe("https://review.murage.ai");
  });
  it("lets an https Origin POST through", () => {
    expect(originGate(post("https://review.murage.ai"), identity)).toBeNull();
  });
  it("still refuses an http Origin", () => {
    expect(originGate(post("http://review.murage.ai"), identity)?.status).toBe(403);
  });
  it("still refuses a foreign host", () => {
    expect(originGate(post("https://evil.example", "evil.example"), identity)).not.toBeNull();
    expect(expectedOrigin(post("https://evil.example", "evil.example"), identity)).toBeNull();
  });
  it("with an http scheme (the old fallback) the https Origin is refused", () => {
    expect(originGate(post("https://review.murage.ai"), { ...identity, scheme: "http" })?.status).toBe(403);
  });
});

describe("signInClientKey and X-Forwarded-For", () => {
  const on = { MURAGE_TRUST_PROXY: "1" } as NodeJS.ProcessEnv;
  const off = {} as NodeJS.ProcessEnv;

  it("ignores the header without the flag", () => {
    expect(signInClientKey(req({ "x-forwarded-for": "203.0.113.9" }), off)).toBe("127.0.0.1");
  });
  it("ignores the header when the peer is not loopback, flag or not", () => {
    expect(signInClientKey(req({ "x-forwarded-for": "203.0.113.9" }, "100.64.0.10"), on)).toBe("100.64.0.10");
  });
  it("uses the rightmost entry with flag and loopback peer", () => {
    expect(signInClientKey(req({ "x-forwarded-for": "203.0.113.9" }), on)).toBe("203.0.113.9");
    expect(signInClientKey(req({ "x-forwarded-for": "198.51.100.7" }, "::1"), on)).toBe("198.51.100.7");
    expect(signInClientKey(req({ "x-forwarded-for": "2001:db8::5" }, "::ffff:127.0.0.1"), on)).toBe("2001:db8::5");
  });
  it("ignores spoofed leftmost entries", () => {
    expect(signInClientKey(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2 , 203.0.113.9" }), on)).toBe("203.0.113.9");
  });
  it("falls back to the peer on garbage", () => {
    for (const bad of ["", "garbage", "1.1.1.1, not-an-ip", "999.1.1.1", "1.1.1.1,"]) {
      expect(signInClientKey(req({ "x-forwarded-for": bad }), on), bad).toBe("127.0.0.1");
    }
    expect(signInClientKey(req({}), on)).toBe("127.0.0.1");
  });
  it("two forwarded IPs get separate keys, so separate lockout buckets", () => {
    const a = signInClientKey(req({ "x-forwarded-for": "203.0.113.9" }), on);
    const b = signInClientKey(req({ "x-forwarded-for": "203.0.113.10" }), on);
    expect(a).not.toBe(b);
  });
});
