import { describe, expect, it } from "vitest";
import {
  companionBrowserLink,
  companionPairingLink,
  companionPairingRoute,
  companionPairingRoutePin,
  companionPairingRoutePinAvailable,
  type CompanionBrowserDoor,
} from "./companion-pairing";

describe("companionPairingLink", () => {
  const token = `murage_pair_${"a".repeat(43)}`;

  const decodedEndpoints = (link: string) => {
    const encoded = new URL(link).searchParams.get("endpoints");
    if (!encoded) return null;
    const padded = encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  };

  it("carries the dialable address, one-time token, fallback code, and display name", () => {
    const link = companionPairingLink({
      address: "macbook.tail1234.ts.net",
      port: 8810,
      code: "004209",
      token,
      name: "Milind's Mac",
    });

    const url = new URL(link!);
    expect(url.protocol).toBe("murage:");
    expect(url.host).toBe("pair");
    expect(url.searchParams.get("address")).toBe("macbook.tail1234.ts.net:8810");
    expect(url.searchParams.get("token")).toBe(token);
    expect(url.searchParams.get("code")).toBe("004209");
    expect(url.searchParams.get("name")).toBe("Milind's Mac");
  });

  it("refuses to make a link from an invalid pairing window", () => {
    expect(companionPairingLink({ address: "", port: 8810, code: "123456", token })).toBeNull();
    expect(companionPairingLink({ address: "mac.local", port: 0, code: "123456", token })).toBeNull();
    expect(companionPairingLink({ address: "mac.local", port: 8810, code: "12345", token })).toBeNull();
    expect(companionPairingLink({ address: "mac.local", port: 8810, code: "123456", token: "weak" })).toBeNull();
  });

  it("makes an IPv6 address unambiguous", () => {
    const link = companionPairingLink({ address: "2001:db8::1", port: 8810, code: "123456", token });
    expect(new URL(link!).searchParams.get("address")).toBe("[2001:db8::1]:8810");
  });

  it("carries the ordered fallback hosts, comma-joined", () => {
    const link = companionPairingLink({
      address: "macbook.tail1234.ts.net",
      port: 8810,
      code: "004209",
      token,
      hosts: ["macbook.tail1234.ts.net", "192.168.1.42", "murage-abcd1234.local"],
    });
    expect(new URL(link!).searchParams.get("hosts")).toBe(
      "macbook.tail1234.ts.net,192.168.1.42,murage-abcd1234.local",
    );
  });

  it("carries sorted typed endpoints as URL-safe base64 JSON while preserving legacy fields", () => {
    const link = companionPairingLink({
      address: "192.168.1.42",
      port: 8810,
      code: "004209",
      token,
      hosts: ["192.168.1.42", "murage-abcd1234.local"],
      endpoints: [
        { url: "http://192.168.1.42:8810", kind: "lan", priority: 200 },
        { url: "https://Device-123.Companion.Example/", kind: "hosted", priority: 0 },
        { url: "http://murage-abcd1234.local:8810", kind: "bonjour", priority: 300 },
      ],
    });

    const url = new URL(link!);
    expect(url.searchParams.get("address")).toBe("192.168.1.42:8810");
    expect(url.searchParams.get("hosts")).toBe("192.168.1.42,murage-abcd1234.local");
    expect(url.searchParams.get("endpoints")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodedEndpoints(link!)).toEqual([
      { url: "https://device-123.companion.example", kind: "hosted", priority: 0 },
      { url: "http://192.168.1.42:8810", kind: "lan", priority: 200 },
      { url: "http://murage-abcd1234.local:8810", kind: "bonjour", priority: 300 },
    ]);
  });

  it("filters malformed or transport-mismatched typed endpoints", () => {
    const link = companionPairingLink({
      address: "mac.local",
      port: 8810,
      code: "004209",
      token,
      endpoints: [
        { url: "http://hosted.example", kind: "hosted", priority: 0 },
        { url: "https://192.168.1.42:8810", kind: "lan", priority: 200 },
        { url: "http://mac.local:8810/path", kind: "bonjour", priority: 300 },
        { url: "http://mac.local:0", kind: "bonjour", priority: 300 },
        { url: "http://mac.local:65536", kind: "bonjour", priority: 300 },
        { url: "http://mac.local:8810", kind: "bonjour", priority: 300 },
      ],
    });
    expect(decodedEndpoints(link!)).toEqual([
      { url: "http://mac.local:8810", kind: "bonjour", priority: 300 },
    ]);
  });

  it("drops unusable fallback hosts without breaking the link", () => {
    // A bad candidate costs the phone one failed dial at most, and an empty
    // list is a link that simply carries no fallbacks — pairing still works.
    const link = companionPairingLink({
      address: "mac.local",
      port: 8810,
      code: "004209",
      token,
      hosts: ["  192.168.1.42  ", "", "has space", "has/slash", "a,b"],
    });
    const url = new URL(link!);
    expect(url.searchParams.get("hosts")).toBe("192.168.1.42");
    expect(url.searchParams.get("address")).toBe("mac.local:8810");

    const none = companionPairingLink({ address: "mac.local", port: 8810, code: "004209", token, hosts: [] });
    expect(new URL(none!).searchParams.get("hosts")).toBeNull();
  });

  it("makes the automatic QR hosted-only even when Tailscale and LAN are advertised", () => {
    const endpoints = [
      { url: "https://device.murage.ai", kind: "hosted" as const, priority: 0 },
      { url: "http://mac.tail1234.ts.net:8810", kind: "tailnet" as const, priority: 100 },
      { url: "http://192.168.1.42:8810", kind: "lan" as const, priority: 200 },
    ];
    const route = companionPairingRoute({
      port: 8810,
      tailnetName: "mac.tail1234.ts.net",
      lan: "192.168.1.42",
      hosts: ["mac.tail1234.ts.net", "192.168.1.42"],
      endpoints,
    }, "automatic");

    expect(route).toEqual({
      address: "device.murage.ai",
      port: 443,
      hosts: ["device.murage.ai"],
      endpoints: [endpoints[0]],
    });
    const link = companionPairingLink({ ...route!, code: "004209", token });
    const url = new URL(link!);
    expect(url.searchParams.get("address")).toBe("device.murage.ai:443");
    expect(url.searchParams.get("hosts")).toBe("device.murage.ai");
    expect(url.searchParams.get("hosts")).not.toContain("192.168.1.42");
    expect(url.searchParams.get("hosts")).not.toContain("tail1234.ts.net");
    expect(decodedEndpoints(link!)).toEqual([endpoints[0]]);
    expect(companionPairingRoutePin({
      port: 8810,
      tailnetName: "mac.tail1234.ts.net",
      lan: "192.168.1.42",
      hosts: ["mac.tail1234.ts.net", "192.168.1.42"],
      endpoints,
    }, "automatic")?.protectedEndpoint?.kind).toBe("hosted");
  });

  it("refuses automatic pairing when hosted HTTPS is not ready", () => {
    const source = {
      port: 8810,
      tailnetName: "mac.tail1234.ts.net",
      lan: "192.168.1.42",
      hosts: ["mac.tail1234.ts.net", "192.168.1.42", "murage-aa.local"],
      endpoints: [
        { url: "http://mac.tail1234.ts.net:8810", kind: "tailnet" as const, priority: 0 },
        { url: "http://192.168.1.42:8810", kind: "lan" as const, priority: 100 },
      ],
    };

    expect(companionPairingRoute(source, "automatic")).toBeNull();
    expect(companionPairingRoutePin(source, "automatic")).toBeNull();
  });

  it("pins the protected automatic transport instead of downgrading the live QR to LAN", () => {
    const opened = {
      port: 8810,
      lan: "192.168.1.42",
      hosts: ["192.168.1.42"],
      endpoints: [
        { url: "https://device.murage.ai", kind: "hosted" as const, priority: 0 },
        { url: "http://192.168.1.42:8810", kind: "lan" as const, priority: 200 },
      ],
    };
    const pin = companionPairingRoutePin(opened, "automatic");
    expect(pin?.protectedEndpoint).toEqual({
      url: "https://device.murage.ai",
      kind: "hosted",
      priority: 0,
    });
    expect(pin?.route).toMatchObject({
      address: "device.murage.ai",
      port: 443,
      hosts: ["device.murage.ai"],
    });

    const withdrawn = {
      ...opened,
      endpoints: [{ url: "http://192.168.1.42:8810", kind: "lan" as const, priority: 200 }],
    };
    expect(companionPairingRoute(withdrawn, "automatic")).toBeNull();
    expect(companionPairingRoutePinAvailable(withdrawn, pin!)).toBe(false);
    expect(pin?.route.endpoints?.map((endpoint) => endpoint.kind)).toEqual(["hosted"]);
  });

  it("does not substitute a different protected transport for the pinned one", () => {
    const opened = {
      port: 8810,
      tailnetName: "mac.tail1234.ts.net",
      endpoints: [
        { url: "https://device.murage.ai", kind: "hosted" as const, priority: 0 },
        { url: "http://mac.tail1234.ts.net:8810", kind: "tailnet" as const, priority: 100 },
      ],
    };
    const pin = companionPairingRoutePin(opened, "automatic");
    expect(pin?.protectedEndpoint?.kind).toBe("hosted");
    expect(companionPairingRoutePinAvailable({
      endpoints: [opened.endpoints[1]],
    }, pin!)).toBe(false);
  });

  it("selects hosted HTTPS regardless of an unprotected endpoint's priority", () => {
    expect(companionPairingRoutePin({
      port: 8810,
      lan: "192.168.1.42",
      endpoints: [
        { url: "http://192.168.1.42:8810", kind: "lan", priority: 0 },
        { url: "https://device.murage.ai", kind: "hosted", priority: 100 },
      ],
    }, "automatic")?.route).toEqual({
      address: "device.murage.ai",
      port: 443,
      hosts: ["device.murage.ai"],
      endpoints: [
        { url: "https://device.murage.ai", kind: "hosted", priority: 100 },
      ],
    });
  });

  it("makes the explicitly selected LAN route first without losing protected upgrades", () => {
    const route = companionPairingRoute({
      port: 8810,
      tailnetName: "mac.tail1234.ts.net",
      lan: "192.168.1.42",
      hosts: ["mac.tail1234.ts.net", "192.168.1.42", "murage-aa.local"],
      endpoints: [
        { url: "https://device.murage.ai", kind: "hosted", priority: 0 },
        { url: "http://mac.tail1234.ts.net:8810", kind: "tailnet", priority: 100 },
        { url: "http://192.168.1.42:8810", kind: "lan", priority: 200 },
        { url: "http://murage-aa.local:8810", kind: "bonjour", priority: 300 },
      ],
    }, "local");

    expect(route?.address).toBe("192.168.1.42");
    expect(route?.port).toBe(8810);
    expect(route?.hosts).toEqual([
      "192.168.1.42",
      "murage-aa.local",
    ]);
    const link = companionPairingLink({ ...route!, code: "004209", token });
    expect(new URL(link!).searchParams.get("address")).toBe("192.168.1.42:8810");
    expect(decodedEndpoints(link!)).toEqual([
      { url: "http://192.168.1.42:8810", kind: "lan", priority: 0 },
      { url: "https://device.murage.ai", kind: "hosted", priority: 100 },
      { url: "http://murage-aa.local:8810", kind: "bonjour", priority: 200 },
    ]);
  });

  it("keeps an explicitly selected Tailscale route off cleartext LAN fallbacks", () => {
    const route = companionPairingRoute({
      port: 8810,
      tailnetName: "mac.tail1234.ts.net",
      lan: "192.168.1.42",
      hosts: ["mac.tail1234.ts.net", "192.168.1.42", "murage-aa.local"],
      endpoints: [
        { url: "https://device.murage.ai", kind: "hosted", priority: 0 },
        { url: "http://mac.tail1234.ts.net:8810", kind: "tailnet", priority: 100 },
        { url: "http://192.168.1.42:8810", kind: "lan", priority: 200 },
        { url: "http://murage-aa.local:8810", kind: "bonjour", priority: 300 },
      ],
    }, "tailscale");

    expect(route).toMatchObject({
      address: "mac.tail1234.ts.net",
      port: 8810,
      hosts: ["mac.tail1234.ts.net"],
    });
    const link = companionPairingLink({ ...route!, code: "004209", token });
    expect(decodedEndpoints(link!)).toEqual([
      { url: "http://mac.tail1234.ts.net:8810", kind: "tailnet", priority: 0 },
      { url: "https://device.murage.ai", kind: "hosted", priority: 100 },
    ]);
    expect(new URL(link!).searchParams.get("hosts")).toBe("mac.tail1234.ts.net");
  });

  it("refuses a Tailscale label that is not a MagicDNS ts.net name", () => {
    expect(companionPairingRoute({
      port: 8810,
      tailnetName: "attacker.example",
      endpoints: [
        { url: "http://attacker.example:8810", kind: "tailnet", priority: 0 },
      ],
    }, "tailscale")).toBeNull();
  });

  it("refuses explicit local pairing when no LAN or Bonjour route exists", () => {
    expect(companionPairingRoute({
      port: 8810,
      tailnetName: "mac.tail1234.ts.net",
      hosts: ["mac.tail1234.ts.net"],
      endpoints: [
        { url: "https://device.murage.ai", kind: "hosted", priority: 0 },
        { url: "http://mac.tail1234.ts.net:8810", kind: "tailnet", priority: 100 },
      ],
    }, "local")).toBeNull();
  });

  it("uses an advertised Bonjour route when no LAN address is available", () => {
    const route = companionPairingRoute({
      port: 8810,
      hosts: ["mac.tail1234.ts.net", "murage-aa.local"],
      discovery: { advertising: true, name: "murage-aa.local" },
      endpoints: [
        { url: "https://device.murage.ai", kind: "hosted", priority: 0 },
        { url: "http://murage-aa.local:8810", kind: "bonjour", priority: 300 },
      ],
    }, "local");

    expect(route?.address).toBe("murage-aa.local");
    expect(route?.hosts?.[0]).toBe("murage-aa.local");
    expect(route?.endpoints?.map((endpoint) => endpoint.kind)).toEqual(["bonjour", "hosted"]);
  });

  it("does not treat an inactive synthetic Bonjour name as a reachable local route", () => {
    expect(companionPairingRoute({
      port: 8810,
      hosts: ["mac.tail1234.ts.net", "murage-aa.local"],
      discovery: { advertising: false, name: "murage-aa.local" },
      endpoints: [
        { url: "https://device.murage.ai", kind: "hosted", priority: 0 },
        { url: "http://murage-aa.local:8810", kind: "bonjour", priority: 300 },
      ],
    }, "local")).toBeNull();
  });
});

// The link a phone actually follows.
//
// The pairing QR carried a `murage://pair` URL for an iOS app that was
// removed from this repository. Scanning it on a phone opened nothing, which
// is why the pairing copy stopped naming a client — the honest thing to do
// with a dead client, and not a fix. The fix is the browser door: the sidecar
// serves this same app over the tailnet, and `/enter#<token>` is the page a
// camera app can open.

/** A well-formed pairing token: the shape `devices.ts` issues and accepts. */
const TOKEN = `murage_pair_${"A".repeat(43)}`;
const DOOR: CompanionBrowserDoor = { scheme: "http", host: "macbook.tail1234.ts.net", port: 8813 };

describe("the link the QR carries", () => {
  it("sends a phone to the door's first-contact page with the token in the fragment", () => {
    // The fragment is the whole security design of /enter, not a formatting
    // choice: it never reaches a server, an access log, or a Referer header,
    // and the page strips it from history before its first network call.
    expect(companionBrowserLink(DOOR, TOKEN)).toBe(
      `http://macbook.tail1234.ts.net:8813/enter#${TOKEN}`,
    );
    // Never the query string, which would undo every one of those.
    expect(companionBrowserLink(DOOR, TOKEN)).not.toContain("?");
  });

  it("leaves the port off when it is the scheme's own", () => {
    // `tailscale serve` terminates TLS on 443. A URL that spelled it out
    // would still work and would look like an address someone typed wrong.
    expect(companionBrowserLink({ scheme: "https", host: "macbook.tail1234.ts.net", port: 443 }, TOKEN))
      .toBe(`https://macbook.tail1234.ts.net/enter#${TOKEN}`);
    expect(companionBrowserLink({ scheme: "http", host: "macbook.tail1234.ts.net", port: 80 }, TOKEN))
      .toBe(`http://macbook.tail1234.ts.net/enter#${TOKEN}`);
  });

  it("brackets a bare IPv6 literal", () => {
    // Unbracketed, the first colon of the address reads as the port
    // separator and the link addresses a machine that does not exist.
    expect(companionBrowserLink({ scheme: "http", host: "fd7a:115c:a1e0::4d3b", port: 8813 }, TOKEN))
      .toBe(`http://[fd7a:115c:a1e0::4d3b]:8813/enter#${TOKEN}`);
  });

  it("takes the tailnet address as readily as the name", () => {
    expect(companionBrowserLink({ scheme: "http", host: "100.79.121.109", port: 8813 }, TOKEN))
      .toBe(`http://100.79.121.109:8813/enter#${TOKEN}`);
  });

  it("answers null rather than building a link nothing can open", () => {
    // A malformed link is a QR code somebody points a phone at and gets a
    // blank page from, with nothing on screen saying why. Null is a state
    // the caller renders; a broken string is not.
    expect(companionBrowserLink(null, TOKEN)).toBeNull();
    expect(companionBrowserLink(undefined, TOKEN)).toBeNull();
    expect(companionBrowserLink(DOOR, null)).toBeNull();
    expect(companionBrowserLink(DOOR, undefined)).toBeNull();
    // the six-digit code is not the credential this page redeems
    expect(companionBrowserLink(DOOR, "123456")).toBeNull();
    expect(companionBrowserLink(DOOR, `murage_pair_${"A".repeat(42)}`)).toBeNull();
    expect(companionBrowserLink({ ...DOOR, host: "  " }, TOKEN)).toBeNull();
    expect(companionBrowserLink({ ...DOOR, port: 0 }, TOKEN)).toBeNull();
    expect(companionBrowserLink({ ...DOOR, port: 70_000 }, TOKEN)).toBeNull();
    expect(companionBrowserLink({ ...DOOR, port: 8813.5 }, TOKEN)).toBeNull();
  });

  it("refuses a host carrying anything that would re-shape the URL", () => {
    // The host comes over IPC from another process. A `/` or a `#` in it
    // would move the path or truncate the fragment, and a `@` would turn the
    // whole thing into userinfo in front of somebody else's host.
    for (const host of [
      "evil.example/x",
      "macbook.ts.net#",
      "macbook.ts.net?a=1",
      "user@evil.example",
      "macbook .ts.net",
      "macbook\\\\evil",
    ]) {
      expect(companionBrowserLink({ ...DOOR, host }, TOKEN), host).toBeNull();
    }
  });

  it("refuses a scheme that is not one of the two", () => {
    // `javascript:` and `data:` are the reason this is an allowlist.
    expect(
      companionBrowserLink({ ...DOOR, scheme: "javascript" as CompanionBrowserDoor["scheme"] }, TOKEN),
    ).toBeNull();
  });
});
