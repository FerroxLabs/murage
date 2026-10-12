// SPDX-License-Identifier: AGPL-3.0-or-later
// Every row of spec 3.9 has its own test here. The policy module is pure: no
// network, no DNS. guarded-http.test.ts proves the client obeys it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { classifyIpAddress as classifyLocalModelsAddress, classifyLocalHostname } from "./local-models.ts";
import {
  LIMITS,
  classifyAddress,
  classifyHostname,
  confirmationFor,
  decideRedirect,
  hopMode,
  evaluateUrlPolicy,
  isRefusedClass,
  logSafeUrl,
  parseServerUrl,
  redirectPolicyFor,
  sameOrigin,
} from "./remote-mcp-url.mjs";

describe("address classes (3.9: loopback, private, tailnet, refused)", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["::1", "loopback"],
    ["[::1]", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["10.0.0.5", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.20", "private"],
    ["fc00::1", "private"],
    ["fd12:3456::1", "private"],
    ["::ffff:10.1.2.3", "private"],
    ["100.64.0.1", "tailnet"],
    ["100.127.255.255", "tailnet"],
    ["fd7a:115c:a1e0::1", "tailnet"],
    ["8.8.8.8", "public"],
    ["93.184.216.34", "public"],
    ["172.15.0.1", "public"],
    ["172.32.0.1", "public"],
    ["100.63.255.255", "public"],
    ["100.128.0.1", "public"],
    ["2606:4700::1111", "public"],
    ["::ffff:8.8.8.8", "public"],
  ])("%s is %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it.each([
    "169.254.0.1",
    "169.254.169.254",
    "169.254.170.2",
    "169.254.255.255",
    "0.0.0.0",
    "0.1.2.3",
    "::",
    "fe80::1",
    "febf::1",
    "fe80::1%en0",
    "::ffff:169.254.169.254",
    "224.0.0.1",
    "239.255.255.250",
    "ff02::1",
    "ff05::2",
    "255.255.255.255",
    "240.0.0.1",
    "100.100.100.200",
    "fd00:ec2::254",
    "fd00:ec2::23",
    "::ffff:100.100.100.200",
    "::169.254.169.254",
    "64:ff9b::a9fe:a9fe",
  ])("%s is always refused", (address) => {
    expect(classifyAddress(address)).toBe("refused");
    expect(isRefusedClass(classifyAddress(address))).toBe(true);
  });

  it("agrees with the shared local-model classifier wherever both give a usable class", () => {
    for (const address of ["127.0.0.1", "::1", "10.1.1.1", "192.168.0.1", "100.64.1.1", "8.8.8.8", "fd00::1", "fd7a:115c:a1e0::5"]) {
      expect([address, classifyAddress(address)]).toEqual([address, classifyLocalModelsAddress(address)]);
    }
    // Where local-models says "public" for a metadata or link-local address, this module is stricter.
    for (const address of ["169.254.169.254", "fe80::1", "100.100.100.200", "fd00:ec2::254"]) {
      expect(classifyLocalModelsAddress(address)).toBe("public");
      expect(classifyAddress(address)).toBe("refused");
    }
  });

  it("not an IP literal is reported as public by classifyAddress (hostnames use classifyHostname)", () => {
    expect(classifyAddress("example.com")).toBe("public");
    expect(classifyAddress("")).toBe("public");
  });
});

describe("hostname classes", () => {
  it.each([
    ["localhost", "loopback"],
    ["LOCALHOST", "loopback"],
    ["localhost.", "loopback"],
    ["foo.localhost", "loopback"],
    ["127.0.0.1", "loopback"],
    ["[::1]", "loopback"],
    ["gpubox", "local-name"],
    ["nas.local", "local-name"],
    ["box.tail1234.ts.net", "local-name"],
    ["printer.lan", "local-name"],
    ["host.home.arpa", "local-name"],
    ["10.0.0.5", "private"],
    ["100.64.0.9", "tailnet"],
    ["cloud.comfy.org", "public"],
    ["example.com", "public"],
    ["ts.net", "public"],
    ["12345", "public"],
  ])("%s is %s", (host, expected) => {
    expect(classifyHostname(host)).toBe(expected);
  });

  it.each([
    "169.254.169.254",
    "metadata.google.internal",
    "METADATA.GOOGLE.INTERNAL.",
    "metadata",
    "instance-data",
    "instance-data.ec2.internal",
    "fd00:ec2::254",
    "100.100.100.200",
    "0.0.0.0",
    "[fe80::1]",
  ])("%s is refused by name", (host) => {
    expect(classifyHostname(host)).toBe("refused");
  });

  it("agrees with classifyLocalHostname for ordinary names", () => {
    for (const host of ["localhost", "gpubox", "nas.local", "box.ts.net", "example.com", "10.0.0.1"]) {
      expect([host, classifyHostname(host)]).toEqual([host, classifyLocalHostname(host)]);
    }
  });
});

describe("which confirmation a class needs", () => {
  it("loopback needs This computer; private, tailnet and local names need Local network; public needs none", () => {
    expect(confirmationFor("loopback")).toBe("this-computer");
    expect(confirmationFor("private")).toBe("local-network");
    expect(confirmationFor("tailnet")).toBe("local-network");
    expect(confirmationFor("local-name")).toBe("local-network");
    expect(confirmationFor("public")).toBeNull();
  });
  it("a refused class has no confirmation that can unlock it", () => {
    expect(confirmationFor("refused")).toBe("refused");
  });
});

describe("parseServerUrl", () => {
  it("accepts http and https and reports the pieces", () => {
    expect(parseServerUrl("https://cloud.comfy.org/mcp")).toMatchObject({
      ok: true, scheme: "https", hostname: "cloud.comfy.org", port: 443, path: "/mcp",
    });
    expect(parseServerUrl("http://127.0.0.1:8811/mcp")).toMatchObject({ ok: true, scheme: "http", hostname: "127.0.0.1", port: 8811 });
    expect(parseServerUrl("https://[::1]:9/x")).toMatchObject({ ok: true, hostname: "::1" });
  });
  it("refuses other schemes, userinfo and garbage", () => {
    for (const bad of ["ftp://x.example/", "file:///etc/passwd", "javascript:alert(1)", "ws://x.example/", "nonsense", "", "//x.example/mcp"]) {
      expect([bad, parseServerUrl(bad)]).toEqual([bad, { ok: false, code: "invalid-address" }]);
    }
    expect(parseServerUrl("https://me:pw@x.example/mcp")).toEqual({ ok: false, code: "credentials-in-address" });
    expect(parseServerUrl("https://me@x.example/mcp")).toEqual({ ok: false, code: "credentials-in-address" });
  });
  it("normalizes spellings that hide an address", () => {
    // WHATWG URL folds these to 127.0.0.1, so the class is seen, not the spelling.
    for (const spelling of ["http://2130706433/", "http://0x7f.0.0.1/", "http://0177.0.0.1/", "http://127.1/"]) {
      const parsed = parseServerUrl(spelling);
      expect([spelling, parsed.ok && classifyHostname(parsed.hostname)]).toEqual([spelling, "loopback"]);
    }
    const metadata = parseServerUrl("http://2852039166/");
    expect(metadata.ok && classifyHostname(metadata.hostname)).toBe("refused");
    const trailing = parseServerUrl("https://Example.COM./mcp");
    expect(trailing).toMatchObject({ ok: true, hostname: "example.com" });
  });
});

describe("evaluateUrlPolicy: scheme and confirmation rules", () => {
  const inspect = (url: string, extra: Record<string, unknown> = {}) => evaluateUrlPolicy({ url, mode: "inspect", ...extra });
  const request = (url: string, extra: Record<string, unknown> = {}) => evaluateUrlPolicy({ url, mode: "request", ...extra });

  it("https to a public host passes with no confirmation", () => {
    expect(inspect("https://cloud.comfy.org/mcp")).toEqual({ ok: true, addressClass: "public", local: null });
    expect(request("https://cloud.comfy.org/mcp")).toEqual({ ok: true, addressClass: "public", local: null });
  });

  it("http to a public host is refused: https-required", () => {
    expect(inspect("http://cloud.comfy.org/mcp")).toMatchObject({ ok: false, code: "https-required" });
    expect(request("http://8.8.8.8/mcp")).toMatchObject({ ok: false, code: "https-required" });
  });

  it("loopback needs This computer, and http then passes once confirmed", () => {
    expect(inspect("http://127.0.0.1:8811/mcp")).toEqual({ ok: false, code: "local-confirm", needs: "this-computer" });
    expect(inspect("https://localhost/mcp")).toEqual({ ok: false, code: "local-confirm", needs: "this-computer" });
    expect(inspect("http://[::1]:1/mcp", { confirmed: "this-computer" })).toEqual({ ok: true, addressClass: "loopback", local: "this-computer" });
  });

  it("private, tailnet and .local names need Local network", () => {
    for (const url of ["http://192.168.1.20/mcp", "http://10.0.0.5/mcp", "http://100.64.1.1/mcp", "http://nas.local/mcp", "http://box.tail1.ts.net/mcp", "http://gpubox/mcp"]) {
      const resolved = url.includes("//nas.local") || url.includes("ts.net") || url.includes("//gpubox")
        ? { resolved: [{ address: "192.168.1.9" }] } : {};
      expect([url, inspect(url, resolved)]).toEqual([url, { ok: false, code: "local-confirm", needs: "local-network" }]);
      expect([url, inspect(url, { ...resolved, confirmed: "local-network" })]).toMatchObject([url, { ok: true, local: "local-network" }]);
    }
  });

  it("a confirmation of the wrong kind does not unlock the address", () => {
    expect(inspect("http://127.0.0.1/mcp", { confirmed: "local-network" })).toMatchObject({ ok: false, code: "address-changed" });
    expect(inspect("http://10.0.0.5/mcp", { confirmed: "this-computer" })).toMatchObject({ ok: false, code: "address-changed" });
  });

  it("a confirmation on a public address is meaningless and refused", () => {
    expect(request("https://cloud.comfy.org/mcp", { confirmed: "this-computer" })).toMatchObject({ ok: false, code: "address-changed" });
  });

  it("link-local, metadata and unspecified addresses are refused even with a confirmation", () => {
    for (const url of [
      "http://169.254.169.254/latest", "https://169.254.169.254/", "http://[fe80::1]/", "http://0.0.0.0/", "http://[::]/",
      "http://224.0.0.1/", "http://[ff02::1]/", "http://100.100.100.200/", "http://[fd00:ec2::254]/",
      "http://metadata.google.internal/", "http://metadata/",
    ]) {
      for (const confirmed of [undefined, "this-computer", "local-network"] as const) {
        expect([url, confirmed, inspect(url, { confirmed })]).toEqual([url, confirmed, { ok: false, code: "refused-address" }]);
      }
    }
  });

  it("credentials in the address are refused before anything else", () => {
    expect(inspect("https://me:pw@cloud.comfy.org/mcp")).toEqual({ ok: false, code: "credentials-in-address" });
  });

  it("an unparseable address is invalid-address", () => {
    expect(inspect("nonsense")).toEqual({ ok: false, code: "invalid-address" });
  });
});

describe("evaluateUrlPolicy: re-check against the resolved addresses (rebinding)", () => {
  const r = (...addresses: string[]) => addresses.map((address) => ({ address }));

  it("a public name resolving to public addresses passes", () => {
    expect(evaluateUrlPolicy({ url: "https://cloud.comfy.org/mcp", mode: "request", resolved: r("93.184.216.34", "2606:4700::1111") }))
      .toEqual({ ok: true, addressClass: "public", local: null });
  });

  it("a public name that starts resolving private is refused as address-changed when requesting", () => {
    expect(evaluateUrlPolicy({ url: "https://cloud.comfy.org/mcp", mode: "request", resolved: r("10.0.0.5") }))
      .toMatchObject({ ok: false, code: "address-changed" });
    expect(evaluateUrlPolicy({ url: "https://cloud.comfy.org/mcp", mode: "request", resolved: r("127.0.0.1") }))
      .toMatchObject({ ok: false, code: "address-changed" });
  });

  it("the same name at first inspect asks for a confirmation instead", () => {
    expect(evaluateUrlPolicy({ url: "https://mcp.corp.example/mcp", mode: "inspect", resolved: r("10.0.0.5") }))
      .toEqual({ ok: false, code: "local-confirm", needs: "local-network" });
  });

  it("a confirmed local name whose addresses move class is address-changed and nothing is sent", () => {
    const base = { url: "http://nas.local/mcp", mode: "request", confirmed: "local-network" } as const;
    expect(evaluateUrlPolicy({ ...base, resolved: r("192.168.1.9") })).toMatchObject({ ok: true, local: "local-network" });
    expect(evaluateUrlPolicy({ ...base, resolved: r("127.0.0.1") })).toMatchObject({ ok: false, code: "address-changed" });
    expect(evaluateUrlPolicy({ ...base, resolved: r("8.8.8.8") })).toMatchObject({ ok: false, code: "address-changed" });
  });

  it("any refused address in the answer refuses the whole request", () => {
    for (const refused of ["169.254.169.254", "fe80::1", "0.0.0.0", "100.100.100.200"]) {
      expect(evaluateUrlPolicy({ url: "https://cloud.comfy.org/mcp", mode: "request", resolved: r("93.184.216.34", refused) }))
        .toEqual({ ok: false, code: "refused-address" });
    }
  });

  it("a mixed answer (public and private together) is refused", () => {
    expect(evaluateUrlPolicy({ url: "https://x.example/mcp", mode: "request", resolved: r("93.184.216.34", "10.0.0.5") }))
      .toEqual({ ok: false, code: "refused-address" });
  });

  it("an empty answer is unresolved-address", () => {
    expect(evaluateUrlPolicy({ url: "https://x.example/mcp", mode: "request", resolved: [] }))
      .toEqual({ ok: false, code: "unresolved-address" });
  });

  it("IPv6 link-local results are refused, not skipped", () => {
    expect(evaluateUrlPolicy({ url: "http://nas.local/mcp", mode: "request", confirmed: "local-network", resolved: r("192.168.1.9", "fe80::1") }))
      .toEqual({ ok: false, code: "refused-address" });
  });

  it("a literal address needs no resolution, and a resolution that disagrees with a literal is ignored by the caller", () => {
    expect(evaluateUrlPolicy({ url: "http://127.0.0.1:1/mcp", mode: "request", confirmed: "this-computer" }))
      .toEqual({ ok: true, addressClass: "loopback", local: "this-computer" });
  });
});

describe("redirect policy (3.9: MCP none, metadata 3 hops, token and register none)", () => {
  it("has the right hop limits per kind", () => {
    expect(redirectPolicyFor("mcp")).toEqual({ maxHops: 0, httpsOnly: true });
    expect(redirectPolicyFor("sse")).toEqual({ maxHops: 0, httpsOnly: true });
    expect(redirectPolicyFor("token")).toEqual({ maxHops: 0, httpsOnly: true });
    expect(redirectPolicyFor("register")).toEqual({ maxHops: 0, httpsOnly: true });
    expect(redirectPolicyFor("metadata")).toEqual({ maxHops: 3, httpsOnly: true });
  });

  const from = "https://as.example/.well-known/oauth-authorization-server";
  it("follows a metadata redirect to another https host, resolving relative locations", () => {
    expect(decideRedirect({ kind: "metadata", hopsSoFar: 0, from, location: "https://other.example/x" }))
      .toEqual({ follow: true, url: "https://other.example/x" });
    expect(decideRedirect({ kind: "metadata", hopsSoFar: 2, from, location: "/moved" }))
      .toEqual({ follow: true, url: "https://as.example/moved" });
  });

  it("stops after 3 hops", () => {
    expect(decideRedirect({ kind: "metadata", hopsSoFar: 3, from, location: "https://other.example/x" }))
      .toEqual({ follow: false, code: "too-many-redirects" });
  });

  it("never follows for mcp, sse, token or register", () => {
    for (const kind of ["mcp", "sse", "token", "register"] as const) {
      expect(decideRedirect({ kind, hopsSoFar: 0, from, location: "https://other.example/x" }))
        .toEqual({ follow: false, code: "redirect-not-allowed" });
    }
  });

  it("refuses a hop to a refused class, to http, to userinfo, or to a bad location", () => {
    for (const location of ["https://169.254.169.254/latest", "http://as.example/x", "https://u:p@as.example/x", "ftp://as.example/x", "https://[fe80::1]/", "https://metadata.google.internal/"]) {
      expect([location, decideRedirect({ kind: "metadata", hopsSoFar: 0, from, location })]).toMatchObject([location, { follow: false }]);
    }
    expect(decideRedirect({ kind: "metadata", hopsSoFar: 0, from, location: "https://169.254.169.254/" }))
      .toEqual({ follow: false, code: "refused-address" });
    expect(decideRedirect({ kind: "metadata", hopsSoFar: 0, from, location: "http://as.example/x" }))
      .toEqual({ follow: false, code: "https-required" });
    expect(decideRedirect({ kind: "metadata", hopsSoFar: 0, from, location: "" }))
      .toEqual({ follow: false, code: "invalid-address" });
  });
});

describe("review L3: address ranges the first table missed", () => {
  it.each([
    "64:ff9b:1::a9fe:a9fe", "64:ff9b:1::7f00:1", "2002:a9fe:a9fe::1", "2002:7f00:1::1", "2002:a00:1::1", "::ffff:0:7f00:1",
    "fec0::1", "febf::1", "192.0.0.192", "192.0.0.1", "168.63.129.16", "2001:db8::1", "2001:db8:ffff::1",
  ])("%s is refused or judged by what it embeds, never public", (address) => {
    expect(classifyAddress(address)).not.toBe("public");
  });

  it("RFC 6052 /48 layout for the local-use NAT64 prefix is judged by the embedded address too", () => {
    // 169.254.169.254 in the /48 layout: v4 bytes a9 fe | u=00 | a9 | fe in groups g3..g5.
    expect(classifyAddress("64:ff9b:1:a9fe:a9:fe00::")).toBe("refused");
    expect(classifyAddress("2002:a9fe:a9fe::1")).toBe("refused");
    expect(classifyAddress("2002:7f00:1::1")).toBe("loopback");
    expect(classifyAddress("2002:a00:1::1")).toBe("private");
  });

  it("keeps the ranges that real setups use reachable: 198.18/15 (fake-ip resolvers), ordinary 6to4, nearby addresses", () => {
    expect(classifyAddress("198.18.0.1")).toBe("public");
    expect(classifyAddress("198.19.255.255")).toBe("public");
    expect(classifyAddress("2002:808:808::1")).toBe("public");
    expect(classifyAddress("192.0.1.1")).toBe("public");
    expect(classifyAddress("168.63.129.17")).toBe("public");
    expect(classifyAddress("2001:db9::1")).toBe("public");
  });
});

describe("review L4: redirect hops are requests, not questions", () => {
  it("only the first hop may ask for a confirmation", () => {
    expect(hopMode("inspect", 0)).toBe("inspect");
    expect(hopMode("inspect", 1)).toBe("request");
    expect(hopMode("inspect", 3)).toBe("request");
    expect(hopMode("request", 0)).toBe("request");
    // The effect: a redirect target on the LAN is refused, never offered for confirmation.
    const target = { url: "https://lan.example.test/x", confirmed: null, resolved: [{ address: "10.0.0.5" }] } as const;
    expect(evaluateUrlPolicy({ ...target, mode: hopMode("inspect", 0) })).toMatchObject({ ok: false, code: "local-confirm" });
    expect(evaluateUrlPolicy({ ...target, mode: hopMode("inspect", 1) })).toEqual({ ok: false, code: "address-changed" });
  });
});

describe("review F2: log lines mask every token shape", () => {
  it("jwt, padded base64, short mixed and dotted tokens", () => {
    for (const url of [
      "https://x.example/sse/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123",
      "https://mcp.example/s/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==/mcp",
      "https://mcp.example/s/abcDEF123456789012/mcp",
      "https://mcp.example/k/sk~live.0123456789abcdefghij/mcp",
    ]) {
      expect(logSafeUrl(url)).toContain("\u2022\u2022\u2022");
      expect(logSafeUrl(url)).not.toMatch(/eyJ|Zm9v|abcDEF|sk~live/);
    }
  });
});

describe("limits (3.9 size and time caps)", () => {
  it("are the spec values", () => {
    expect(LIMITS).toEqual({
      metadataBytes: 64 * 1024,
      registerBytes: 64 * 1024,
      tokenBytes: 64 * 1024,
      mcpResponseBytes: 20 * 1024 * 1024,
      sseEventBytes: 20 * 1024 * 1024,
      toolsListed: 100,
      dnsMs: 3_000,
      connectMs: 10_000,
      probeTotalMs: 30_000,
      initializeRelayMs: 30_000,
      toolCallMs: 10 * 60_000,
      signInMs: 10 * 60_000,
    });
  });
});

describe("sameOrigin (token audience)", () => {
  it("compares scheme, host and port", () => {
    expect(sameOrigin("https://a.example/x", "https://a.example/y")).toBe(true);
    expect(sameOrigin("https://a.example:443/x", "https://a.example/y")).toBe(true);
    expect(sameOrigin("https://a.example/x", "http://a.example/x")).toBe(false);
    expect(sameOrigin("https://a.example/x", "https://b.example/x")).toBe(false);
    expect(sameOrigin("https://a.example/x", "https://a.example:8443/x")).toBe(false);
    expect(sameOrigin("https://a.example/x", "https://a.example.evil.test/x")).toBe(false);
    expect(sameOrigin("nonsense", "https://a.example/x")).toBe(false);
  });
});

describe("logSafeUrl (logging: host and masked path only)", () => {
  it("drops query, userinfo and fragment and masks long opaque segments", () => {
    expect(logSafeUrl("https://me:pw@h.example/s/abcdefghijklmnopqrstuvwx/mcp?k=SECRET#f")).toBe("https://h.example/s/•••/mcp");
    expect(logSafeUrl("https://cloud.comfy.org/mcp")).toBe("https://cloud.comfy.org/mcp");
    expect(logSafeUrl("nonsense")).toBe("");
  });
});

describe("module hygiene", () => {
  const source = readFileSync(new URL("./remote-mcp-url.mjs", import.meta.url), "utf8");
  it("does no I/O: no fetch, network, child process or eval", () => {
    for (const banned of [/\bfetch\s*\(/, /node:net/, /node:http/, /node:dns/, /child_process/, /\beval\s*\(/, /new Function/]) {
      expect(source).not.toMatch(banned);
    }
  });
  it("carries the license header", () => {
    expect(source).toContain("SPDX-License-Identifier: AGPL-3.0-or-later");
  });
});
