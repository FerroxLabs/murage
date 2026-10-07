import type { Db } from "./db";

/** Spec §3.5 abuse controls. One counter row per scope per window. */
export const LIMITS = {
  challengesPerIpHour: 30,
  registrationsPerIpHour: 10,
  approvalStatementsPerIpHour: 10,
  approvalStatementsPerInstallHour: 5,
  bindingsPerDevice: 10,
  bindingCreatesPerDeviceHour: 20,
  tokenUpdatesPerDeviceHour: 10,
  grantTtlMs: 300_000,
  challengeTtlMs: 300_000,
  pushesPerBindingDay: 500,
  pendingPerBinding: 50,
  pendingTotal: 10_000,
  maxEventLifetimeMs: 24 * 3600_000,
} as const;

/** Count one use; true while the window is within its limit. */
export async function spend(db: Db, scope: string, windowMs: number, limit: number, now: number): Promise<boolean> {
  const window = Math.floor(now / windowMs) * windowMs;
  const row = await db.prepare("INSERT INTO relay_counters (scope,window_start,count) VALUES (?,?,1) ON CONFLICT(scope,window_start) DO UPDATE SET count=count+1 RETURNING count")
    .bind(scope, window).first<{ count: number }>();
  return (row?.count ?? Number.MAX_SAFE_INTEGER) <= limit;
}

/** A Workers Rate Limiting binding (wrangler.jsonc "ratelimits"): the slice the relay uses. */
export interface EdgeLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The edge gate, spent before any D1 work. No binding (the tests, a dry
 *  run, a Worker deployed without one) is no limit, and so is a binding that
 *  throws: D1's own limits still stand behind it, and a broken limiter must
 *  not take the relay down with it. */
export async function edgeAllows(limiter: EdgeLimiter | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    console.error("push-relay", JSON.stringify({ edge: "unavailable" }));
    return true;
  }
}

/** Give back one use counted by `spend` in the same window. */
export async function refund(db: Db, scope: string, windowMs: number, now: number): Promise<void> {
  await db.prepare("UPDATE relay_counters SET count=count-1 WHERE scope=? AND window_start=? AND count>0").bind(scope, Math.floor(now / windowMs) * windowMs).run();
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET = /^[0-9a-f]{1,4}$/;
function ipv4(value: string): number[] | null {
  const m = value.match(IPV4);
  const octets = m ? m.slice(1).map(Number) : null;
  return octets && octets.every((o) => o <= 255) ? octets : null;
}
function ipv6(value: string): number[] | null {
  let parts = value.split(":");
  const tail = parts[parts.length - 1];
  if (tail.includes(".")) {
    const v4 = ipv4(tail);
    if (!v4) return null;
    parts = [...parts.slice(0, -1), ((v4[0] << 8) | v4[1]).toString(16), ((v4[2] << 8) | v4[3]).toString(16)];
  }
  const joined = parts.join(":");
  const halves = joined.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  return all.every((h) => HEXTET.test(h)) ? all.map((h) => parseInt(h, 16)) : null;
}

/** In-memory normalization only, never a limiter key or persisted value.
 *  The input is `cf-connecting-ip`. An IPv6 client usually
 *  holds a whole /64, so that is one bucket; an IPv4-mapped address is its
 *  IPv4 address. No header is its own bucket, and anything unparseable is
 *  keyed literally so it can neither pose as an address nor as "none". */
export function clientBucket(address: string | null): string {
  if (address === null) return "none";
  const v4 = ipv4(address);
  if (v4) return `ip4=${v4.join(".")}`;
  const bare = address.replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "").toLowerCase();
  const v6 = bare.includes(":") ? ipv6(bare) : null;
  if (!v6) return `raw=${address}`;
  if (v6.slice(0, 5).every((h) => h === 0) && v6[5] === 0xffff) return `ip4=${[v6[6] >> 8, v6[6] & 255, v6[7] >> 8, v6[7] & 255].join(".")}`;
  return `ip6=${v6.slice(0, 4).map((h) => h.toString(16).padStart(4, "0")).join(":")}::/64`;
}

// Lazy initialization: Workers disallow randomness during module evaluation.
// Without the secret, limits are per-isolate and reset on isolate replacement.
let isolateIpKey: Promise<CryptoKey> | undefined;
const encoder = new TextEncoder();
const importIpKey = (bytes: Uint8Array) => crypto.subtle.importKey("raw", new Uint8Array(bytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

/** Only this digest may leave the request's IP normalization path. The UTC
 * period is an epoch-aligned two-day interval, with no timezone dependence. */
export async function clientHash(address: string | null, now: number, secret?: string): Promise<string> {
  const key = secret ? await importIpKey(encoder.encode(secret))
    : await (isolateIpKey ??= importIpKey(crypto.getRandomValues(new Uint8Array(32))));
  const period = Math.floor(now / (2 * 86400_000));
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${period}\n${clientBucket(address)}`));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
