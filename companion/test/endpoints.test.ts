import { describe, expect, it } from "vitest";

import {
  companionEndpointCandidates,
  hostedCompanionUrl,
  MAX_COMPANION_ENDPOINTS,
} from "../src/endpoints.ts";

describe("hostedCompanionUrl", () => {
  it("normalizes one explicit HTTPS origin", () => {
    expect(hostedCompanionUrl("  https://Ember.Example/  ")).toBe("https://ember.example");
    expect(hostedCompanionUrl(undefined)).toBeNull();
    expect(hostedCompanionUrl("  ")).toBeNull();
  });

  it("refuses insecure or ambiguous hosted routes", () => {
    for (const value of [
      "http://ember.example",
      "https://user:secret@ember.example",
      "https://ember.example/companion",
      "https://ember.example?device=one",
      "https://ember.example#pair",
      "not a URL",
    ]) {
      expect(() => hostedCompanionUrl(value)).toThrow(/MURAGE_COMPANION_HOSTED_URL/);
    }
  });
});

describe("companionEndpointCandidates", () => {
  it("puts the tailnet first, then hosted, then LAN and Bonjour", () => {
    expect(
      companionEndpointCandidates(
        8810,
        ["100.121.5.6", "192.168.1.42", "10.0.0.7"],
        "macbook.tail1234.ts.net",
        "https://device-123.companion.example",
        "murage-abcd1234.local",
      ),
    ).toEqual([
      { url: "http://macbook.tail1234.ts.net:8810", kind: "tailnet", priority: 0 },
      { url: "https://device-123.companion.example", kind: "hosted", priority: 150 },
      { url: "http://192.168.1.42:8810", kind: "lan", priority: 201 },
      { url: "http://10.0.0.7:8810", kind: "lan", priority: 202 },
      { url: "http://murage-abcd1234.local:8810", kind: "bonjour", priority: 300 },
    ]);
  });

  // The tailnet address used to be dropped on the floor whenever MagicDNS
  // was off or the Tailscale CLI could not be read: the tailnet branch
  // required a name, and the LAN loop deliberately excludes the tailnet
  // address. A browser that is not on the LAN was left with nothing.
  it("still offers the tailnet address when no MagicDNS name resolves", () => {
    expect(
      companionEndpointCandidates(
        8810,
        ["100.121.5.6", "192.168.1.42"],
        null,
        null,
        "murage-abcd1234.local",
      ),
    ).toEqual([
      { url: "http://100.121.5.6:8810", kind: "tailnet", priority: 0 },
      { url: "http://192.168.1.42:8810", kind: "lan", priority: 201 },
      { url: "http://murage-abcd1234.local:8810", kind: "bonjour", priority: 300 },
    ]);
  });

  it("prefers the MagicDNS name over the bare address when it resolves", () => {
    // It survives an address change, and it is the name a Tailscale cert is
    // issued to — the only tailnet origin reachable over HTTPS.
    const tailnet = companionEndpointCandidates(
      8810, ["100.121.5.6"], "macbook.tail1234.ts.net", null, "murage-abcd1234.local",
    ).filter((endpoint) => endpoint.kind === "tailnet");
    expect(tailnet).toEqual([
      { url: "http://macbook.tail1234.ts.net:8810", kind: "tailnet", priority: 0 },
    ]);
  });

  it("keeps direct routes when no hosted route exists", () => {
    expect(
      companionEndpointCandidates(8810, ["192.168.1.42"], null, null, "murage-abcd1234.local"),
    ).toEqual([
      { url: "http://192.168.1.42:8810", kind: "lan", priority: 200 },
      { url: "http://murage-abcd1234.local:8810", kind: "bonjour", priority: 300 },
    ]);
  });

  // The re-rank this pins is a security property, not a preference: a hosted
  // route is public-internet ingress and the tailnet is not, so no combination
  // of inputs may put hosted ahead of an available tailnet route.
  it("never offers a public hosted route ahead of the tailnet", () => {
    for (const magicDns of ["macbook.tail1234.ts.net", null]) {
      for (const addresses of [["100.121.5.6"], ["100.121.5.6", "192.168.1.42"], ["100.64.0.1", "10.0.0.7"]]) {
        const endpoints = companionEndpointCandidates(
          8810,
          addresses,
          magicDns,
          "https://device-123.companion.example",
          "murage-abcd1234.local",
        );
        const tailnet = endpoints.findIndex((e) => e.kind === "tailnet");
        const hosted = endpoints.findIndex((e) => e.kind === "hosted");
        expect(tailnet, `no tailnet route for ${JSON.stringify(addresses)}`).toBeGreaterThanOrEqual(0);
        expect(hosted).toBeGreaterThan(tailnet);
      }
    }
  });

  it("caps pathological interface lists without losing the Bonjour fallback", () => {
    const addresses = Array.from({ length: 20 }, (_, index) => `192.168.1.${index + 1}`);
    const endpoints = companionEndpointCandidates(
      8810,
      addresses,
      null,
      "https://device-123.companion.example",
      "murage-abcd1234.local",
    );
    expect(endpoints).toHaveLength(MAX_COMPANION_ENDPOINTS);
    // No tailnet address in this list, so hosted leads what remains.
    expect(endpoints[0]).toMatchObject({ kind: "hosted", priority: 150 });
    expect(endpoints.at(-1)).toEqual({
      url: "http://murage-abcd1234.local:8810",
      kind: "bonjour",
      priority: 300,
    });
  });
});
