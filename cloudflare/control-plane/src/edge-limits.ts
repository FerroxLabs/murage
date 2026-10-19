// SPDX-License-Identifier: AGPL-3.0-or-later
import { errorResponse, json } from "./http";

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
const PAIRING_ROUTE = /^\/v1\/homes\/[\w-]{1,128}\/pairing\/(start|code)$/;
const BEARER = /^Bearer [^\s]+$/;
const NEW_LINK_PATH = "/v1/public/withdrawal/new-link";
/** The emailed step-up code (step-up-email.ts): send and verify. Authenticated, with their own D1 limits (5 sends per account per day, 30 s
 *  apart, 5 guesses per code); this per-IP budget, in its own key space, is spent before any D1 work (Astra STEPUP-EMAIL-1 #3). */
const STEP_UP_EMAIL_ROUTE = /^\/v1\/account\/step-up\/email\/(?:send|verify)$/;

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
  if (STEP_UP_EMAIL_ROUTE.test(url.pathname)) return { limiter: "MACHINE_OPEN_LIMIT", key: `stepup:${ip}` };
  if (PAIRING_ROUTE.test(url.pathname) || url.pathname === "/v1/pairing/desktop"
    || (request.method === "POST" && url.pathname === "/v1/announcements/subscribe")
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
