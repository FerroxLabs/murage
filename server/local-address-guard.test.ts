import { describe, expect, it } from "vitest";

import { checkLocalServerUrl, type LocalNameLookup } from "./local-address-guard.ts";

const resolver = (table: Record<string, string[]>): LocalNameLookup & { calls: string[] } => {
  const calls: string[] = [];
  const lookup = async (hostname: string) => {
    calls.push(hostname);
    const addresses = table[hostname];
    if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return Object.assign(lookup, { calls });
};

describe("plain http to a local name (server authority)", () => {
  it("allows a name only when every address is loopback, private, link-local or tailnet", async () => {
    const lookup = resolver({
      gpubox: ["100.101.102.103", "fd7a:115c:a1e0::1234"],
      "nas.local": ["192.168.1.40", "fe80::1"],
      "db.internal": ["10.0.0.4", "fd12::4"],
    });
    for (const url of ["http://gpubox:11434/v1/models", "http://nas.local:8080/v1", "http://db.internal/v1"]) {
      expect(await checkLocalServerUrl(url, lookup), url).toEqual({ ok: true });
    }
  });

  it("refuses a name when any resolved address is public", async () => {
    const lookup = resolver({ gpubox: ["192.168.1.40", "203.0.113.9"], "box.tail0000.ts.net": ["::ffff:8.8.8.8"] });
    expect(await checkLocalServerUrl("http://gpubox:11434/v1", lookup)).toEqual({ ok: false, code: "https-required" });
    expect(await checkLocalServerUrl("http://box.tail0000.ts.net:11434/v1", lookup)).toEqual({ ok: false, code: "https-required" });
  });

  it("says a name did not resolve instead of calling it public", async () => {
    const lookup = resolver({ empty: [] });
    expect(await checkLocalServerUrl("http://missing:11434/v1", lookup)).toEqual({ ok: false, code: "unresolved-address" });
    expect(await checkLocalServerUrl("http://empty:11434/v1", lookup)).toEqual({ ok: false, code: "unresolved-address" });
    const hanging: LocalNameLookup = () => new Promise(() => undefined);
    expect(await checkLocalServerUrl("http://slow:11434/v1", hanging, 20)).toEqual({ ok: false, code: "unresolved-address" });
  });

  it("answers again on every call, so a name that rebinds to a public address is refused", async () => {
    const table: Record<string, string[]> = { gpubox: ["100.101.102.103"] };
    const lookup = resolver(table);
    expect(await checkLocalServerUrl("http://gpubox:11434/v1", lookup)).toEqual({ ok: true });
    table.gpubox = ["198.51.100.7"];
    expect(await checkLocalServerUrl("http://gpubox:11434/v1/models", lookup)).toEqual({ ok: false, code: "https-required" });
    expect(lookup.calls).toEqual(["gpubox", "gpubox"]);
  });

  it("never resolves IP literals, https, or public names", async () => {
    const lookup = resolver({});
    expect(await checkLocalServerUrl("http://127.0.0.1:8080/v1", lookup)).toEqual({ ok: true });
    expect(await checkLocalServerUrl("http://[fd7a:115c:a1e0::1]:8080/v1", lookup)).toEqual({ ok: true });
    expect(await checkLocalServerUrl("https://gpu.example.com/v1", lookup)).toEqual({ ok: true });
    expect(await checkLocalServerUrl("http://gpu.example.com/v1", lookup)).toEqual({ ok: false, code: "https-required" });
    expect(await checkLocalServerUrl("http://8.8.8.8/v1", lookup)).toEqual({ ok: false, code: "https-required" });
    expect(lookup.calls).toEqual([]);
  });
});
