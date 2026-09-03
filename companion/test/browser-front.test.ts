// What the door advertises when something is standing in front of it.
//
// The bug this file pins: with `tailscale serve` terminating TLS on 443 and
// proxying to 127.0.0.1:8813, `/state` reported port 8813. The generated link
// was `https://<name>:8813/enter#…` — a certificate that does not cover that
// port, a serve config that does not answer on it, and a QR nobody can use.
// Every individual fact in it was true; the composition was not.
import { describe, expect, it } from "vitest";

import { browserDoorLocation, browserFront } from "../src/browser.ts";

const NAME = "seans-macbook-pro.tail0a48a4.ts.net";

describe("the proxy in front of the door", () => {
  it("reads a plain HTTPS origin and fills in the default port", () => {
    expect(browserFront(`https://${NAME}`)).toEqual({ scheme: "https", host: NAME, port: 443 });
    expect(browserFront("http://example.internal")).toEqual({
      scheme: "http",
      host: "example.internal",
      port: 80,
    });
  });

  it("keeps an explicit port when the proxy is not on the scheme's default", () => {
    expect(browserFront(`https://${NAME}:8443`)).toEqual({ scheme: "https", host: NAME, port: 8443 });
  });

  it("is null for anything that is not an origin", () => {
    // Nothing here degrades to a guess. A malformed value means "no proxy",
    // which is a real and working configuration; a half-read one would put a
    // typo into a QR code and into the door's Host allowlist.
    for (const bad of [
      undefined,
      null,
      "",
      "   ",
      "not a url",
      `ftp://${NAME}`,
      `https://user:pass@${NAME}`,
      `https://${NAME}/enter`,
      `https://${NAME}/?x=1`,
      `https://${NAME}#fragment`,
      "https://",
    ]) {
      expect(browserFront(bad as string | undefined), String(bad)).toBeNull();
    }
  });

  it("lower-cases the host and drops the FQDN's trailing dot", () => {
    expect(browserFront(`https://${NAME.toUpperCase()}.`)?.host).toBe(NAME);
  });
});

describe("where the door tells a browser to go", () => {
  it("advertises the socket when nothing is in front", () => {
    expect(browserDoorLocation("http", 8813, "100.64.0.1", NAME, "100.64.0.1")).toEqual({
      scheme: "http",
      host: NAME,
      port: 8813,
    });
  });

  it("advertises the FRONT, not the socket, when serve is proxying", () => {
    // This is the fix. The door is bound to loopback on 8813; what a phone
    // or a laptop types is `https://<name>` with no port at all.
    const front = browserFront(`https://${NAME}`);
    expect(browserDoorLocation("https", 8813, "127.0.0.1", NAME, null, front)).toEqual({
      scheme: "https",
      host: NAME,
      port: 443,
    });
  });

  it("prefers the front's host over the MagicDNS name it was handed", () => {
    // The front's host is the name the certificate was issued for, read back
    // out of `serve status`. A MagicDNS probe that found something else — or
    // found nothing — must not override it.
    const front = browserFront(`https://${NAME}`);
    expect(browserDoorLocation("https", 8813, "127.0.0.1", "stale.example.ts.net", null, front)?.host)
      .toBe(NAME);
    expect(browserDoorLocation("https", 8813, "127.0.0.1", null, null, front)?.host).toBe(NAME);
  });

  it("still says nothing is listening when the socket is down", () => {
    // A proxy in front of a door that is not listening is a 502. Reporting a
    // reachable-looking address for it is the exact half-truth `null` exists
    // to avoid.
    expect(browserDoorLocation("https", 8813, null, NAME, null, browserFront(`https://${NAME}`)))
      .toBeNull();
  });
});
