// SPDX-License-Identifier: AGPL-3.0-or-later
import { siteForwarderAuth } from "./announcements";
import { errorResponse, json } from "./http";

const ANNOUNCEMENTS_PATH = "/v1/announcements/subscribe";

/** A Workers Rate Limiting binding (wrangler.jsonc "ratelimits"): the slice used here. */
export interface EdgeLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

declare global {
  interface Env {
    MACHINE_OPEN_LIMIT?: EdgeLimiter;
    MACHINE_BEARER_LIMIT?: EdgeLimiter;
  }
  namespace Cloudflare {
    interface Env {
      MACHINE_OPEN_LIMIT?: EdgeLimiter;
      MACHINE_BEARER_LIMIT?: EdgeLimiter;
    }
  }
}

const MACHINE_ROUTE = /^\/v1\/machines\/([\w-]{1,128})\/(enroll|unwrap|lease|heartbeat|desired|endpoint|flux\/subkey|flux\/subkey\/ack|flux\/renewal-due)$/;
/** Warm pool (WARM-POOL-PLAN 5.2): the cloud-config a claimed server fetches. No bearer, so it is IP-limited like enroll. */
const POOL_CONFIG_ROUTE = /^\/v1\/pool\/[\w-]{1,128}\/cloud-config\/[A-Za-z0-9_-]{16,128}$/;
const PAIRING_ROUTE = /^\/v1\/homes\/[\w-]{1,128}\/pairing\/(start|code)$/;
/** A home's own calls (home-api.ts): HMAC authenticated, with their own D1 limits; this per-IP budget, in its own key space, is spent first. */
const HOME_API_EDGE_ROUTE = /^\/v1\/homes\/[\w-]{1,128}\/home\/(?:owner-code-send|owner-code-verify|terms-proof|owner-event)$/;
const BEARER = /^Bearer [^\s]+$/;
const NEW_LINK_PATH = "/v1/public/withdrawal/new-link";
/** The emailed step-up code (step-up-email.ts): send and verify. Authenticated, with their own D1 limits (5 sends per account per day, 30 s
 *  apart, 5 guesses per code); this per-IP budget, in its own key space, is spent before any D1 work (Astra STEPUP-EMAIL-1 #3). */
const STEP_UP_EMAIL_ROUTE = /^\/v1\/account\/step-up\/email\/(?:send|verify)$/;
/** The Flux email-proof code (flux-email-proof.ts): the same D1 limits as the step-up code, and its own per-IP budget, spent first. */
const FLUX_EMAIL_PROOF_ROUTE = /^\/v1\/account\/flux\/email-proof\/(?:send|verify)$/;

/** The caller's edge budget key (tester feedback, lane L-FB): an IPv4 address whole, an IPv6 address by its /64 (one site or one
 *  customer line holds a whole /64, so rotating addresses inside it buys nothing). An IPv4-mapped IPv6 is its IPv4. */
export function callerSubject(ip: string): string {
  const raw = ip.trim().toLowerCase();
  const mapped = /^(?:0{1,4}:){5}ffff:(\d{1,3}(?:\.\d{1,3}){3})$|^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (mapped) return `v4:${mapped[1] ?? mapped[2]}`;
  if (!raw.includes(":")) return `v4:${raw}`;
  const [head, tail = ""] = raw.split("::", 2);
  const left = head ? head.split(":") : [];
  const right = raw.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = raw.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `v6:${groups.slice(0, 4).map((g) => (g || "0").replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** The edge limiters' window: a throttled caller retries after this many seconds. */
const EDGE_RETRY_AFTER_SECONDS = 60;
export type EdgeClass = { limiter: "MACHINE_OPEN_LIMIT" | "MACHINE_BEARER_LIMIT"; key: string };

/** Which edge limiter, if any, covers this request. Pure: no D1, no binding access.
 *  Machine routes that present a bearer get the larger budget, still keyed by IP (a changed machine id in the path never buys a fresh budget); every
 *  other covered route (enroll, which sends its token in the body, a bearer-less
 *  probe, pairing, the announcement signup) is keyed by IP alone. */
export function classifyEdge(request: Request): EdgeClass | null {
  const url = new URL(request.url);
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  const machine = MACHINE_ROUTE.exec(url.pathname);
  if (machine) {
    if (machine[2] !== "enroll" && BEARER.test(request.headers.get("authorization") ?? "")) {
      return { limiter: "MACHINE_BEARER_LIMIT", key: ip };
    }
    return { limiter: "MACHINE_OPEN_LIMIT", key: ip };
  }
  if (request.method === "GET" && POOL_CONFIG_ROUTE.test(url.pathname)) return { limiter: "MACHINE_OPEN_LIMIT", key: `pool:${ip}` };
  if (request.method === "GET" && url.pathname === "/v1/status") return { limiter: "MACHINE_OPEN_LIMIT", key: `status:${ip}` };
  if (request.method === "POST" && HOME_API_EDGE_ROUTE.test(url.pathname)) return { limiter: "MACHINE_OPEN_LIMIT", key: `homeapi:${ip}` };
  if (STEP_UP_EMAIL_ROUTE.test(url.pathname)) return { limiter: "MACHINE_OPEN_LIMIT", key: `stepup:${ip}` };
  if (FLUX_EMAIL_PROOF_ROUTE.test(url.pathname)) return { limiter: "MACHINE_OPEN_LIMIT", key: `fluxproof:${ip}` };
  // Tester feedback (lane L-FB, designs/UX-FEEDBACK-LIMITS-1012.md): keyed by the /64 (IPv6) or the address (IPv4), so
  // rotating addresses inside one /64 never buys a fresh budget. Its own key space.
  if (request.method === "POST" && url.pathname === "/v1/owner-feedback") return { limiter: "MACHINE_OPEN_LIMIT", key: `fb:${callerSubject(ip)}` };
  if (PAIRING_ROUTE.test(url.pathname) || url.pathname === "/v1/pairing/desktop"
    || (request.method === "POST" && url.pathname === ANNOUNCEMENTS_PATH)
    || url.pathname.startsWith("/v1/public/")) {
    return { limiter: "MACHINE_OPEN_LIMIT", key: ip };
  }
  return null;
}

let warned = false;
function warnOnce(reason: string) {
  if (warned) return;
  warned = true;
  console.error(JSON.stringify({ message: "edge rate limiter unavailable, failing open", reason }));
}

/** The edge gate, spent before any D1 work. No binding (tests, local) or a
 *  binding that throws is no limit: the D1 limits behind it still stand, and a
 *  broken limiter must not take the control plane down. Returns the 429 when over. */
export async function edgeGate(request: Request, env: Env): Promise<Response | null> {
  const cls = classifyEdge(request);
  if (!cls) return null;
  // The site forwarder posts every signup from Vercel's shared egress IPs: a valid X-Murage-Site-Token skips this per-IP budget (the route
  // keeps its per-address limit and a global hourly cap). A wrong token is not skipped here; the route answers it 401.
  if (request.method === "POST" && new URL(request.url).pathname === ANNOUNCEMENTS_PATH
    && await siteForwarderAuth(request, env) === "valid") return null;
  const limiter = env[cls.limiter];
  if (!limiter) {
    warnOnce("binding_absent");
    return null;
  }
  try {
    if ((await limiter.limit({ key: cls.key })).success) return null;
  } catch {
    warnOnce("binding_error");
    return null;
  }
  // /new-link answers 202 {} to everything (public-routes.ts), so being throttled here must look the same: still no D1 work, still no send.
  if (request.method === "POST" && new URL(request.url).pathname === NEW_LINK_PATH) {
    console.error(JSON.stringify({ message: "new link suppressed", reason: "edge_limited" }));
    return json({}, 202);
  }
  // The emailed step-up code's endpoints answer the round-1 contract's 429 (Astra STEPUP-EMAIL-6 #4): the seconds to wait in the JSON body
  // too, the same value as Retry-After, in both spellings (the site reads retry_after_seconds; Astra STEPUP-EMAIL-10 #2), as the
  // account-level limiter answers. Every other edge-limited route keeps its own (header-only) answer.
  const stepUp = STEP_UP_EMAIL_ROUTE.test(new URL(request.url).pathname);
  const response = errorResponse(429, "rate_limited", stepUp
    ? { retryAfter: EDGE_RETRY_AFTER_SECONDS, retry_after_seconds: EDGE_RETRY_AFTER_SECONDS } : undefined);
  response.headers.set("retry-after", String(EDGE_RETRY_AFTER_SECONDS));
  return response;
}
