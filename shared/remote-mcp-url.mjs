// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The network policy for MCP servers added by link (spec MCP-LINK 3.9). Pure:
// no DNS, no sockets, no fetch. Both the Murage server and Electron main import
// it, so a rule is written once. shared/guarded-http.mjs is the client that
// obeys it.
//
// Every row of the 3.9 table is one exported function so each can be tested and
// reviewed alone:
//   schemes                    -> parseServerUrl, evaluateUrlPolicy
//   address classes            -> classifyAddress, classifyHostname
//   confirmations              -> confirmationFor
//   always-refused addresses   -> isRefusedClass (classifyAddress returns "refused")
//   re-check before a request  -> evaluateUrlPolicy({ mode: "request", resolved })
//   redirects                  -> redirectPolicyFor, decideRedirect
//   size and time caps         -> LIMITS
//   token audience             -> sameOrigin
//   logging                    -> logSafeUrl
//
// Its classifier is self-contained (it does not import shared/local-models.ts)
// because Electron main loads .mjs files directly and cannot load TypeScript.
// shared/remote-mcp-url.test.ts checks it agrees with local-models.ts wherever
// both answer, and is stricter where the spec asks it to be.

import { displayUrl } from "./mcp-secret-url.mjs";

/** @typedef {"public" | "loopback" | "private" | "tailnet" | "local-name" | "refused"} AddressClass */

export const LIMITS = Object.freeze({
  metadataBytes: 64 * 1024,
  registerBytes: 64 * 1024,
  tokenBytes: 64 * 1024,
  mcpResponseBytes: 20 * 1024 * 1024,
  sseEventBytes: 20 * 1024 * 1024,
  toolsListed: 100,
  dnsMs: 3_000,
  connectMs: 10_000,
  // initialize + tools/list over the internet for an account with many
  // workspaces can take well over 20 s. Only a person-initiated Test waits
  // on this, never a bot's turn (OpenMausBot #2449, Apache-2.0).
  probeTotalMs: 30_000,
  initializeRelayMs: 30_000,
  toolCallMs: 10 * 60_000,
  signInMs: 10 * 60_000,
});

// ── address classes ─────────────────────────────────────────────────────

function stripBrackets(text) {
  return text.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

function ipv4Octets(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

/** Eight 16-bit groups, or null when this is not an IPv6 literal. A zone
 * suffix (%en0) is dropped: a zone only ever appears on link-local addresses,
 * which are refused anyway. */
function ipv6Groups(value) {
  let text = value.split("%")[0] ?? "";
  if (!text.includes(":")) return null;
  const lastColon = text.lastIndexOf(":");
  const dotted = text.slice(lastColon + 1);
  if (dotted.includes(".")) {
    const v4 = ipv4Octets(dotted);
    if (!v4) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (chunk) => {
    if (!chunk) return [];
    const groups = chunk.split(":");
    return groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group)) ? groups.map((group) => parseInt(group, 16)) : null;
  };
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !rest) return null;
  const used = head.length + rest.length;
  if (halves.length === 1) return used === 8 ? head : null;
  if (used > 7) return null;
  return [...head, ...Array.from({ length: 8 - used }, () => 0), ...rest];
}

/** @returns {AddressClass} */
function classifyIpv4(octets) {
  const [a, b, c, d] = octets;
  // 0.0.0.0/8: "this host". Connecting to 0.0.0.0 reaches the local machine on
  // some platforms, so it is refused rather than called loopback.
  if (a === 0) return "refused";
  if (a === 127) return "loopback";
  // 169.254.0.0/16: link-local, and what answers there in a cloud is the
  // instance metadata service (AWS IMDS, ECS task credentials, GCP, Azure...).
  if (a === 169 && b === 254) return "refused";
  // 192.0.0.0/24 (IETF protocol assignments, including 192.0.0.192, the legacy
  // Oracle Cloud metadata address) and Azure's WireServer 168.63.129.16.
  if (a === 192 && b === 0 && c === 0) return "refused";
  if (a === 168 && b === 63 && c === 129 && d === 16) return "refused";
  // Multicast 224/4, reserved 240/4 and broadcast.
  if (a >= 224) return "refused";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  // Alibaba Cloud's metadata service sits inside the CGNAT range that
  // Tailscale uses, so this one address is carved out of "tailnet".
  if (a === 100 && b === 100 && c === 100 && d === 200) return "refused";
  if (a === 100 && b >= 64 && b <= 127) return "tailnet";
  return "public";
}

const CLASS_STRICTNESS = ["public", "tailnet", "local-name", "private", "loopback", "refused"];
/** @param {AddressClass} a @param {AddressClass} b @returns {AddressClass} */
function stricterClass(a, b) {
  return CLASS_STRICTNESS.indexOf(a) >= CLASS_STRICTNESS.indexOf(b) ? a : b;
}

/**
 * Class of one IP literal, with or without IPv6 brackets. A string that is not
 * an IP literal is "public": hostnames go through classifyHostname.
 * @param {string} address
 * @returns {AddressClass}
 */
export function classifyAddress(address) {
  const text = stripBrackets(String(address ?? ""));
  const v4 = ipv4Octets(text);
  if (v4) return classifyIpv4(v4);
  const groups = ipv6Groups(text);
  if (!groups) return "public";
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // :: (unspecified) is refused; ::1 is loopback.
  if (zeroPrefix && g5 === 0 && g6 === 0 && g7 === 0) return "refused";
  if (zeroPrefix && g5 === 0 && g6 === 0 && g7 === 1) return "loopback";
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible (::a.b.c.d):
  // the embedded address decides.
  if (zeroPrefix && (g5 === 0xffff || g5 === 0)) return classifyIpv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  // NAT64 64:ff9b::/96 embeds an IPv4 address the same way.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return classifyIpv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  // Local-use NAT64 64:ff9b:1::/48 embeds the address either in the last 32
  // bits (the /96 habit) or in the RFC 6052 /48 layout. Judge both, keep the stricter.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) {
    return stricterClass(
      classifyIpv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]),
      classifyIpv4([g3 >> 8, g3 & 0xff, g4 & 0xff, g5 >> 8]),
    );
  }
  // 6to4 2002::/16 carries an IPv4 address in bits 16-47.
  if (g0 === 0x2002) return classifyIpv4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]);
  // SIIT ::ffff:0:0:0/96 (IPv4-translated).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return "refused";
  // fec0::/10 (deprecated site-local) and 2001:db8::/32 (documentation).
  if ((g0 & 0xffc0) === 0xfec0) return "refused";
  if (g0 === 0x2001 && g1 === 0x0db8) return "refused";
  // fe80::/10 link-local, including the IPv6 faces of the metadata services.
  if ((g0 & 0xffc0) === 0xfe80) return "refused";
  // ff00::/8 multicast.
  if ((g0 & 0xff00) === 0xff00) return "refused";
  // AWS reserves fd00:ec2::/32 (IMDS at fd00:ec2::254, ECS at fd00:ec2::23).
  if (g0 === 0xfd00 && g1 === 0x0ec2) return "refused";
  if (g0 === 0xfd7a && g1 === 0x115c && g2 === 0xa1e0) return "tailnet";
  if ((g0 & 0xfe00) === 0xfc00) return "private"; // ULA fc00::/7
  return "public";
}

const LOCAL_NAME_SUFFIXES = [".ts.net", ".local", ".lan", ".internal", ".home.arpa"];
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Names a cloud gives its own metadata service. Several end in `.internal`,
 * which the local-name rule would otherwise accept. */
const METADATA_HOSTNAMES = new Set(["metadata.google.internal", "metadata", "instance-data", "instance-data.ec2.internal"]);

/**
 * Class of a hostname by its spelling alone. "local-name" is only a candidate
 * (gpubox, nas.local, *.ts.net): resolving it and classifying the addresses is
 * what decides, in evaluateUrlPolicy.
 * @param {string} hostname
 * @returns {AddressClass}
 */
export function classifyHostname(hostname) {
  const host = stripBrackets(String(hostname ?? "")).replace(/\.$/, "");
  if (!host) return "public";
  if (METADATA_HOSTNAMES.has(host)) return "refused";
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  if (host.includes(":") || ipv4Octets(host)) return classifyAddress(host);
  if (host.length > 253) return "public";
  const labels = host.split(".");
  if (!labels.every((label) => HOST_LABEL.test(label))) return "public";
  if (labels.length === 1) return /^\d+$/.test(host) ? "public" : "local-name";
  return LOCAL_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length) ? "local-name" : "public";
}

/** @param {AddressClass} addressClass */
export function isRefusedClass(addressClass) {
  return addressClass === "refused";
}

/**
 * The confirmation an address class needs: "this-computer" for loopback,
 * "local-network" for private, tailnet and local names, null for public, and
 * "refused" for a class no confirmation can unlock.
 * @param {AddressClass} addressClass
 * @returns {"this-computer" | "local-network" | "refused" | null}
 */
export function confirmationFor(addressClass) {
  switch (addressClass) {
    case "loopback": return "this-computer";
    case "private":
    case "tailnet":
    case "local-name": return "local-network";
    case "refused": return "refused";
    default: return null;
  }
}

// ── parsing ─────────────────────────────────────────────────────────────

/**
 * Strict parse of a server link. Only http and https; userinfo is refused (the
 * caller splits it out first); the hostname comes back lowercased, without a
 * trailing dot and without IPv6 brackets. WHATWG URL folds 2130706433,
 * 0x7f.0.0.1 and 127.1 to 127.0.0.1, so the class is judged on the address and
 * not on how it was spelled.
 * @param {string} input
 */
export function parseServerUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? "").trim());
  } catch {
    return { ok: false, code: "invalid-address" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, code: "invalid-address" };
  if (url.username || url.password) return { ok: false, code: "credentials-in-address" };
  const hostname = stripBrackets(url.hostname).replace(/\.$/, "");
  if (!hostname) return { ok: false, code: "invalid-address" };
  const scheme = url.protocol === "https:" ? "https" : "http";
  const port = url.port ? Number(url.port) : scheme === "https" ? 443 : 80;
  return { ok: true, scheme, hostname, port, path: url.pathname, href: url.href };
}

// ── the policy ──────────────────────────────────────────────────────────

/**
 * May a request go to this link? Two modes:
 *  - "inspect": the owner just pasted it. A non-public address asks for a
 *    confirmation (code "local-confirm", `needs` says which).
 *  - "request": every later request (probe, OAuth, relay). `confirmed` is what
 *    the stored entry holds. Any change of class is "address-changed" and
 *    nothing is sent, so a public name that starts resolving private is refused
 *    (DNS rebinding).
 *
 * `resolved` is the address list the caller's single DNS lookup returned. For a
 * hostname it decides the class, because the spelling proves nothing; for an IP
 * literal it is not needed. A local-name spelling with no `resolved` is
 * "unresolved-address": the syntax alone never unlocks it.
 *
 * @param {{ url: string, mode: "inspect" | "request", confirmed?: "this-computer" | "local-network" | null | undefined, resolved?: ReadonlyArray<{ address: string }> }} input
 */
export function evaluateUrlPolicy(input) {
  const parsed = parseServerUrl(input.url);
  if (!parsed.ok) return { ok: false, code: parsed.code };
  const confirmed = input.confirmed ?? null;
  const isLiteral = parsed.hostname.includes(":") || ipv4Octets(parsed.hostname) !== null;
  const nameClass = classifyHostname(parsed.hostname);
  if (nameClass === "refused") return { ok: false, code: "refused-address" };

  /** @type {AddressClass} */
  let addressClass = nameClass;
  if (!isLiteral && input.resolved) {
    if (input.resolved.length === 0) return { ok: false, code: "unresolved-address" };
    const classes = input.resolved.map((entry) => classifyAddress(entry.address));
    if (classes.some(isRefusedClass)) return { ok: false, code: "refused-address" };
    const needs = new Set(classes.map(confirmationFor));
    // One answer that spans public and private, or loopback and LAN, is never
    // a single server the owner confirmed.
    if (needs.size > 1) return { ok: false, code: "refused-address" };
    addressClass = classes[0];
  } else if (nameClass === "local-name") {
    return { ok: false, code: "unresolved-address" };
  }

  const needed = confirmationFor(addressClass);
  if (needed === "refused") return { ok: false, code: "refused-address" };
  if (needed !== confirmed) {
    // Nothing was confirmed and something needs it: at first look, ask.
    if (confirmed === null && input.mode === "inspect") {
      return { ok: false, code: "local-confirm", needs: needed };
    }
    // A confirmation that no longer matches the address, or an entry that
    // had none whose address is no longer public.
    return { ok: false, code: "address-changed" };
  }
  if (parsed.scheme === "http" && needed === null) return { ok: false, code: "https-required" };
  return { ok: true, addressClass, local: needed };
}

// ── redirects ───────────────────────────────────────────────────────────

/**
 * Hop budget per request kind. MCP POST and GET, SSE, token and registration
 * requests never follow a redirect (a 3xx at probe time is reported as a moved
 * server instead). Metadata and authorization-server GETs follow at most 3,
 * https only.
 * @param {"mcp" | "sse" | "metadata" | "token" | "register"} kind
 */
export function redirectPolicyFor(kind) {
  return { maxHops: kind === "metadata" ? 3 : 0, httpsOnly: true };
}

/**
 * Decide one redirect hop. The caller still runs the full policy and DNS check
 * on the returned url; this function only applies the per-kind rules that need
 * no network.
 * `allowPlainHttp` is set by the caller only when the owner confirmed a local
 * address: a plain-http hop is then judged by evaluateUrlPolicy, which accepts
 * it only while the hop stays in the confirmed class.
 * @param {{ kind: "mcp" | "sse" | "metadata" | "token" | "register", hopsSoFar: number, from: string, location: string, allowPlainHttp?: boolean }} input
 */
export function decideRedirect(input) {
  const policy = redirectPolicyFor(input.kind);
  if (policy.maxHops === 0) return { follow: false, code: "redirect-not-allowed" };
  if (input.hopsSoFar >= policy.maxHops) return { follow: false, code: "too-many-redirects" };
  let target;
  try {
    target = new URL(String(input.location ?? ""), input.from);
  } catch {
    return { follow: false, code: "invalid-address" };
  }
  if (!input.location) return { follow: false, code: "invalid-address" };
  const parsed = parseServerUrl(target.href);
  if (!parsed.ok) return { follow: false, code: parsed.code };
  if (classifyHostname(parsed.hostname) === "refused") return { follow: false, code: "refused-address" };
  if (policy.httpsOnly && !input.allowPlainHttp && parsed.scheme !== "https") return { follow: false, code: "https-required" };
  return { follow: true, url: target.href };
}

/**
 * The policy mode for a redirect hop. The owner confirmed the address they
 * pasted, not wherever a redirect points, so every hop after the first is a
 * plain request: a change of class is refused, never offered as a question.
 * @param {"inspect" | "request"} mode
 * @param {number} hopsSoFar
 * @returns {"inspect" | "request"}
 */
export function hopMode(mode, hopsSoFar) {
  return hopsSoFar > 0 ? "request" : mode;
}

// ── audience and logging ────────────────────────────────────────────────

/** Scheme, host and port equal. A token is sent only where this is true of the
 * confirmed server URL. */
export function sameOrigin(a, b) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin !== "null" && left.origin === right.origin;
  } catch {
    return false;
  }
}

/** What a log line may say about a link: scheme, host and path, with opaque
 * segments masked, and never userinfo, query or fragment. The token rule is the
 * shared one in mcp-secret-url.mjs. */
export function logSafeUrl(value) {
  return displayUrl(String(value ?? ""));
}
