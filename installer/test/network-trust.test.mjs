/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from "node:assert/strict";
import { networkInterfaces } from "node:os";
import { test } from "node:test";

import {
  arrivedOverTailnet,
  classifyClientTrust,
  isLoopbackAddress,
  isTailnetAddress,
  normalizeIp,
  resetNetworkTrustCache,
  tailnetAddresses,
  tailnetIpv4,
} from "../lib/network-trust.mjs";

/** Build an interface probe from a plain description. */
const probeOf = (spec) => () => spec;
const v4 = (address) => ({ address, family: "IPv4", internal: false });
const v6 = (address) => ({ address, family: "IPv6", internal: false });

// Shapes taken from real hosts.
const LINUX_TAILNET = probeOf({
  lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  eth0: [v4("134.199.200.10")],
  tailscale0: [v4("100.81.158.63"), v6("fd7a:115c:a1e0::1234:5678")],
});
const MACOS_TAILNET = probeOf({
  en0: [v4("192.168.1.20")],
  utun0: [v6("fe80::1")], // stock macOS Handoff/AWDL tunnel: link-local only
  utun4: [v4("100.79.121.109"), v6("fd7a:115c:a1e0::4d3b:796d")],
});
/** A host behind a carrier-NAT ISP. Same address RANGE, physical nic. */
const CGNAT_ISP = probeOf({ eth0: [v4("100.100.7.9")] });
/** A different WireGuard VPN that also hands out RFC 6598 space on a tunnel. */
const OTHER_VPN = probeOf({ wg0: [v4("100.90.1.2")] });

test("normalizeIp strips mapped-v6 prefixes and zone ids", () => {
  assert.equal(normalizeIp("::FFFF:192.168.1.5"), "192.168.1.5");
  assert.equal(normalizeIp(" fe80::1%eth0 "), "fe80::1");
});

test("loopback detection covers both families", () => {
  for (const ip of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackAddress(ip), true, ip);
  }
  for (const ip of ["128.0.0.1", "10.0.0.1", "", null, undefined, "not-an-ip"]) {
    assert.equal(isLoopbackAddress(ip), false, String(ip));
  }
});

test("finds the tailnet addresses on a Linux node", () => {
  const found = tailnetAddresses({ interfaces: LINUX_TAILNET });
  assert.deepEqual([...found].sort(), ["100.81.158.63", "fd7a:115c:a1e0::1234:5678"]);
  assert.equal(tailnetIpv4({ interfaces: LINUX_TAILNET }), "100.81.158.63");
});

test("finds the tailnet on macOS, where the device is a bare utun", () => {
  // This is the case a NAME-ONLY match (`/^tailscale/`) misses entirely: the
  // interface is `utun4`. The fd7a ULA is what identifies it.
  const found = tailnetAddresses({ interfaces: MACOS_TAILNET });
  assert.deepEqual([...found].sort(), ["100.79.121.109", "fd7a:115c:a1e0::4d3b:796d"]);
});

test("stock macOS utun devices with only link-local contribute nothing", () => {
  const found = tailnetAddresses({ interfaces: probeOf({ utun0: [v6("fe80::1")], utun3: [v6("fe80::2")] }) });
  assert.equal(found.size, 0);
});

test("a carrier-NAT ISP address on a PHYSICAL nic is not a tailnet address", () => {
  // The whole point of #529: 100.64.0.0/10 is RFC 6598 shared space, and
  // Tailscale is the standard workaround FOR a CGNAT ISP — so the hosts behind
  // carrier NAT and the hosts on a tailnet are largely the same hosts.
  assert.equal(tailnetAddresses({ interfaces: CGNAT_ISP }).size, 0);
  assert.equal(isTailnetAddress("100.100.7.9", { interfaces: CGNAT_ISP }), false);
});

test("an unrelated VPN handing out RFC 6598 space on a tunnel is not Tailscale", () => {
  // wg0 is a tunnel and carries 100.90.1.2, but no fd7a ULA and no
  // tailscale-ish name. "A CGNAT address on some tunnel" would have accepted it.
  assert.equal(tailnetAddresses({ interfaces: OTHER_VPN }).size, 0);
});

test("interface enumeration failure fails CLOSED", () => {
  const found = tailnetAddresses({
    interfaces: () => {
      throw new Error("EPERM");
    },
  });
  assert.equal(found.size, 0);
});

test("arrivedOverTailnet compares the LOCAL address, not the peer", () => {
  const opts = { interfaces: LINUX_TAILNET, env: {} };
  // Landed on our tailnet address -> yes.
  assert.equal(arrivedOverTailnet("100.81.158.63", opts), true);
  // Same peer range, but landed on the PUBLIC nic -> no.
  assert.equal(arrivedOverTailnet("134.199.200.10", opts), false);
  // No local address at all -> fail closed.
  assert.equal(arrivedOverTailnet(undefined, opts), false);
  assert.equal(arrivedOverTailnet(null, opts), false);
});

test("the CGNAT operator override forces the rule both ways", () => {
  const base = { interfaces: LINUX_TAILNET };
  assert.equal(arrivedOverTailnet(undefined, { ...base, env: { MURAGE_TAILSCALE_CGNAT_OPERATOR: "1" } }), true);
  assert.equal(
    arrivedOverTailnet("100.81.158.63", { ...base, env: { MURAGE_TAILSCALE_CGNAT_OPERATOR: "0" } }),
    false
  );
});

test("classifyClientTrust: loopback is operator, but not behind a declared proxy", () => {
  const opts = { interfaces: LINUX_TAILNET, env: {} };
  assert.equal(classifyClientTrust("127.0.0.1", "127.0.0.1", opts), "operator");
  // `tailscale serve` arrives as 127.0.0.1 -> 127.0.0.1. Verified live. With
  // the proxy declared, that must NOT read as "the human at the console".
  const proxied = { interfaces: LINUX_TAILNET, env: { MURAGE_TRUSTED_PROXY: "1" } };
  assert.equal(classifyClientTrust("127.0.0.1", "127.0.0.1", proxied), "restricted");
});

test("classifyClientTrust: private ranges and public addresses are restricted", () => {
  const opts = { interfaces: LINUX_TAILNET, env: {} };
  for (const ip of ["10.0.0.5", "192.168.1.9", "172.20.0.4", "8.8.8.8", "169.254.1.1", "", null]) {
    assert.equal(classifyClientTrust(ip, "134.199.200.10", opts), "restricted", String(ip));
  }
});

test("classifyClientTrust: a CGNAT peer is operator only when it landed on the tailnet", () => {
  const opts = { interfaces: LINUX_TAILNET, env: {} };
  assert.equal(classifyClientTrust("100.109.207.54", "100.81.158.63", opts), "operator");
  assert.equal(classifyClientTrust("100.109.207.54", "134.199.200.10", opts), "restricted");
  assert.equal(classifyClientTrust("100.109.207.54", undefined, opts), "restricted");
});

test("the real-syscall probe is cached; an injected probe never is", () => {
  resetNetworkTrustCache();
  let calls = 0;
  const counting = () => {
    calls += 1;
    return {};
  };
  tailnetAddresses({ interfaces: counting });
  tailnetAddresses({ interfaces: counting });
  assert.equal(calls, 2, "injected probes must not be memoized or tests would leak into each other");
});

test("LIVE: this host's real interfaces classify consistently", (t) => {
  resetNetworkTrustCache();
  const real = tailnetAddresses();
  if (real.size === 0) {
    t.skip("this host is not on a tailnet; nothing live to check");
    return;
  }
  // Every address the probe returned must be confirmed by the public predicate.
  for (const ip of real) assert.equal(isTailnetAddress(ip), true, ip);
  // And no address on a physical nic may sneak in.
  const physical = Object.entries(networkInterfaces())
    .filter(([name]) => /^(en|eth|wlan|wl)\d/.test(name))
    .flatMap(([, addrs]) => (addrs ?? []).map((a) => normalizeIp(a.address)));
  for (const ip of physical) assert.equal(real.has(ip), false, `physical nic address leaked in: ${ip}`);
});
