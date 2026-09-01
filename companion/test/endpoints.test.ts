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
  it("puts hosted HTTPS first, followed by tailnet, LAN, and Bonjour routes", () => {
    expect(
      companionEndpointCandidates(
        8810,
        ["100.121.5.6", "192.168.1.42", "10.0.0.7"],
        "macbook.tail1234.ts.net",
        "https://device-123.companion.example",
        "murage-abcd1234.local",
      ),
    ).toEqual([
      { url: "https://device-123.companion.example", kind: "hosted", priority: 0 },
      { url: "http://macbook.tail1234.ts.net:8810", kind: "tailnet", priority: 100 },
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
      { url: "http://100.121.5.6:8810", kind: "tailnet", priority: 100 },
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
      { url: "http://macbook.tail1234.ts.net:8810", kind: "tailnet", priority: 100 },
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
    expect(endpoints[0]).toMatchObject({ kind: "hosted", priority: 0 });
    expect(endpoints.at(-1)).toEqual({
      url: "http://murage-abcd1234.local:8810",
      kind: "bonjour",
      priority: 300,
    });
  });
});
