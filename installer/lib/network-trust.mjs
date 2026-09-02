/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * PROVENANCE: this module is a port of Wayland's
 * `app/src/process/webserver/middleware/networkTrust.ts` (Ferrox Labs,
 * Apache-2.0, same copyright holder as Murage). The classification logic —
 * "did this CONNECTION arrive over the tailnet?" — is carried over verbatim in
 * substance. Changed here: TypeScript -> ESM JavaScript so the installer has
 * zero build step, `WAYLAND_*` env names -> `MURAGE_*`, and the addition of
 * `tailnetAddresses()` / `isTailnetAddress()`, which the bind-policy module
 * needs and which Wayland never exposed (it only ever asked the yes/no
 * question, never "which address").
 */

import { networkInterfaces } from "node:os";

/**
 * Tailscale's registered ULA prefix, `fd7a:115c:a1e0::/48`.
 *
 * This is the strongest tailnet signal available: the prefix is registered to
 * Tailscale and assigned to every tailnet node, so — unlike 100.64.0.0/10 —
 * nothing else hands it out. Not an ISP's carrier NAT, and not an unrelated
 * VPN. It is what identifies WHICH interface is Tailscale's on macOS, where the
 * device is a bare `utun<N>` rather than a helpfully-named `tailscale0`.
 */
const TAILSCALE_ULA = /^fd7a:115c:a1e0:/i;

/**
 * Strip an IPv4-mapped IPv6 prefix (`::ffff:192.168.1.5` -> `192.168.1.5`),
 * an IPv6 zone id (`fe80::1%eth0`), and surrounding whitespace, so the range
 * checks below see a bare address.
 * @param {string} ip
 * @returns {string}
 */
export function normalizeIp(ip) {
  let value = String(ip).trim().toLowerCase();
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  if (value.startsWith("::ffff:")) value = value.slice("::ffff:".length);
  return value;
}

/**
 * Parse a dotted IPv4 string into its four octets, or null if malformed.
 * @param {string} ip
 * @returns {[number, number, number, number] | null}
 */
export function parseIpv4(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null;
  return /** @type {[number, number, number, number]} */ (octets);
}

/**
 * Whether an IP is loopback (IPv4 127.0.0.0/8 or IPv6 ::1).
 * @param {string | undefined | null} rawIp
 * @returns {boolean}
 */
export function isLoopbackAddress(rawIp) {
  if (!rawIp) return false;
  const ip = normalizeIp(rawIp);
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  const octets = parseIpv4(ip);
  return octets ? octets[0] === 127 : false;
}

/**
 * Whether an IP is in 100.64.0.0/10.
 *
 * This is NOT a Tailscale-exclusive range — it is RFC 6598 shared address
 * space, used by real ISPs for carrier-grade NAT. Membership alone proves
 * NOTHING about the peer. Kept private on purpose: nothing outside this module
 * should be tempted to treat it as a tailnet test.
 * @param {string} ip
 * @returns {boolean}
 */
function isCgnatRange(ip) {
  const octets = parseIpv4(ip);
  if (!octets) return false;
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/** Cached probe of THIS HOST's own tailnet addresses. `networkInterfaces()` is
 *  a syscall; the answer changes only when tailscale goes up or down, so a
 *  short TTL is plenty. */
let tailnetCache = null;
const TAILNET_CACHE_MS = 30_000;

/** Test seam: drop the memoized tailnet probe. */
export function resetNetworkTrustCache() {
  tailnetCache = null;
}

/**
 * THIS HOST's own tailnet addresses — the local addresses a connection must
 * have LANDED ON to have arrived over the tailnet. Two signals, and an address
 * must sit on an interface proven to be Tailscale's:
 *
 *  1. Any address in Tailscale's registered ULA prefix (`fd7a:115c:a1e0::/48`).
 *     Nothing else hands that out — not an ISP, not another VPN.
 *  2. A 100.64/10 address on that same proven-Tailscale interface.
 *     Deliberately NOT "a 100.64/10 address anywhere": a host behind carrier
 *     NAT holds one too, but on a PHYSICAL nic (en0/eth0/wlan0) from the ISP's
 *     DHCP. Requiring the Tailscale interface is what separates the tailnet
 *     from the ISP.
 *
 * An interface merely NAMED `tailscale*` is not sufficient on its own to
 * contribute an address: a down or logged-out `tailscale0` has no address, and
 * nothing can arrive on it.
 *
 * NOTE on stock macOS: `utun0/1/3/4` exist with no VPN at all (Handoff, Private
 * Relay, AWDL) but carry only `fe80::` link-local and no IPv4, so they
 * contribute nothing here.
 *
 * FAILS CLOSED: if interface enumeration throws we cannot prove a tailnet, so
 * we return the empty set rather than guessing.
 *
 * @param {{ now?: number, interfaces?: () => Record<string, Array<{address: string, family: string|number, internal: boolean}> | undefined> }} [opts]
 * @returns {Set<string>}
 */
export function tailnetAddresses(opts = {}) {
  const now = opts.now ?? Date.now();
  const probe = opts.interfaces ?? networkInterfaces;
  // Only the real syscall is cached; an injected probe must always be re-read
  // or tests would see each other's answers.
  const cacheable = !opts.interfaces;
  if (cacheable && tailnetCache && now - tailnetCache.at < TAILNET_CACHE_MS) return tailnetCache.value;

  const addresses = new Set();
  try {
    for (const [name, addrs] of Object.entries(probe())) {
      const entries = (addrs ?? []).filter((a) => !a.internal);

      // Is THIS INTERFACE Tailscale's? Two proofs, and it must be one of them:
      //   - it is named `tailscale*` (Linux `tailscale0`, Windows `Tailscale`), or
      //   - it carries an address in Tailscale's registered ULA prefix.
      // Identifying the INTERFACE (not just the host) is what keeps an
      // unrelated VPN out: WireGuard and corporate pools legitimately hand out
      // RFC 6598 space on a tun/wg device, and "a CGNAT address on some tunnel"
      // would have accepted them. A Tailscale device always carries the fd7a ULA.
      const isTailscaleIface =
        /^tailscale/i.test(name) || entries.some((a) => TAILSCALE_ULA.test(normalizeIp(a.address)));
      if (!isTailscaleIface) continue;

      for (const addr of entries) {
        const ip = normalizeIp(addr.address);
        // Node reports family as 'IPv4' (older) or 4 (newer). Accept both.
        const isV4 = addr.family === "IPv4" || addr.family === 4;
        if (TAILSCALE_ULA.test(ip) || (isV4 && isCgnatRange(ip))) addresses.add(ip);
      }
    }
  } catch {
    return new Set();
  }

  if (cacheable) tailnetCache = { value: addresses, at: now };
  return addresses;
}

/**
 * THIS HOST's own tailnet IPv4 address, or null. The bind-policy module needs a
 * single concrete address to hand to `server.listen()`; IPv6 is returned only
 * when there is no IPv4, since a v6-only bind surprises operators.
 * @param {Parameters<typeof tailnetAddresses>[0]} [opts]
 * @returns {string | null}
 */
export function tailnetIpv4(opts) {
  for (const ip of tailnetAddresses(opts)) if (parseIpv4(ip)) return ip;
  return null;
}

/**
 * Whether `address` is one of THIS HOST's own tailnet addresses.
 * @param {string | undefined | null} address
 * @param {Parameters<typeof tailnetAddresses>[0]} [opts]
 * @returns {boolean}
 */
export function isTailnetAddress(address, opts) {
  if (!address) return false;
  return tailnetAddresses(opts).has(normalizeIp(address));
}

/**
 * Whether a 100.64.0.0/10 peer arrived OVER THE TAILNET.
 *
 * The naive rule trusts the whole range, reasoning that "Tailscale peers are
 * cryptographically authenticated". But 100.64.0.0/10 is RFC 6598 CGNAT space,
 * NOT Tailscale's: reached over a carrier-NAT path, the DIRECT socket peer can
 * be a 100.64.x STRANGER.
 *
 * The decisive point: asking "is this HOST on a tailnet?" is the WRONG
 * question. Tailscale is the standard workaround FOR a CGNAT ISP, so the hosts
 * behind carrier NAT and the hosts on a tailnet are largely the SAME hosts — a
 * host-global check answers "yes" for exactly the population at risk. The
 * question is per-CONNECTION: did THIS connection arrive over the tailnet?
 *
 * `localIp` — the address the connection LANDED ON (`socket.localAddress`) —
 * answers it. A peer that reached us on the tailnet interface landed on one of
 * our OWN tailnet addresses; a stranger on the carrier segment landed on the
 * physical nic. An absent localIp cannot prove tailnet arrival, so it FAILS
 * CLOSED.
 *
 * `MURAGE_TAILSCALE_CGNAT_OPERATOR` forces the rule on or off for setups where
 * the local node holds no tailnet address of its own (e.g. reached through a
 * subnet router).
 * @param {string | undefined | null} localIp
 * @param {Parameters<typeof tailnetAddresses>[0] & { env?: Record<string, string | undefined> }} [opts]
 * @returns {boolean}
 */
export function arrivedOverTailnet(localIp, opts = {}) {
  const env = opts.env ?? process.env;
  const override = env.MURAGE_TAILSCALE_CGNAT_OPERATOR?.trim().toLowerCase();
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  if (!localIp) return false; // cannot prove tailnet arrival -> fail closed
  return isTailnetAddress(localIp, opts);
}

/**
 * Whether the operator has DECLARED that this instance sits behind a same-host
 * reverse proxy (`MURAGE_TRUSTED_PROXY`).
 *
 * `tailscale serve` IS such a proxy: verified on a live tailnet, a request
 * arriving through `tailscale serve` reaches the backend with
 * `socket.remoteAddress === "127.0.0.1"` and `socket.localAddress ===
 * "127.0.0.1"`. So under serve, loopback can no longer be read as "the local
 * human at the console" — it is tailscaled forwarding somebody. `murage setup`
 * writes `MURAGE_TRUSTED_PROXY=1` whenever it configures serve, for exactly
 * this reason.
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function trustedProxyDeclared(env = process.env) {
  const raw = env.MURAGE_TRUSTED_PROXY?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Classify a request's DIRECT-PEER IP as `operator` or `restricted`.
 *
 * Operator = loopback (only when no same-host proxy is declared) OR a
 * 100.64/10 peer that provably arrived over the tailnet. Everything else —
 * including a bare 10.x / 172.16.x / 192.168.x, and every public address — is
 * `restricted`. Unparseable or empty addresses fail safe to `restricted`.
 *
 * CALLERS MUST PASS `req.socket.remoteAddress`, never `req.ip` or anything
 * derived from `X-Forwarded-For`: with a proxy in front, XFF is attacker-
 * controlled, and the raw socket peer is not.
 * @param {string | undefined | null} rawIp
 * @param {string | undefined | null} [localIp]
 * @param {Parameters<typeof arrivedOverTailnet>[1]} [opts]
 * @returns {"operator" | "restricted"}
 */
export function classifyClientTrust(rawIp, localIp, opts = {}) {
  if (!rawIp) return "restricted";
  const ip = normalizeIp(rawIp);
  const env = opts.env ?? process.env;
  if (isLoopbackAddress(ip) && !trustedProxyDeclared(env)) return "operator";
  if (isCgnatRange(ip) && arrivedOverTailnet(localIp, opts)) return "operator";
  return "restricted";
}
