// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP7: the public (no login) route shell for the emailed links. Contract: BUILD-PLAN C.1 "Public route names and JSON shapes, final".
//
//   POST /v1/public/token/lookup          { selector, secret }          read-only; changes nothing; never consumes
//   POST /v1/public/withdrawal/confirm    { selector, secret }
//   POST /v1/public/withdrawal/repudiate  { selector, secret }          ("This wasn't me", and the 312k hold link)
//   POST /v1/public/withdrawal/new-link   { selector }                  always 202 {}
//   POST /v1/public/clarify               { selector, secret, action }
//
// The token travels in the URL fragment; the site page POSTs it. A GET of any of these answers 405 and changes nothing. Errors are always
// {error: code}. This file owns everything that is the same for every purpose (parsing, rate limits, token verification, the refusal bodies);
// WP8, WP9 and WP10 register the part that acts, through `registerPublicHandlers`. A route whose handler is not registered answers
// 501 not_implemented after the token checked out (so a staging build shows exactly what is stubbed) and consumes nothing.
import { z } from "zod";
import { errorResponse, HTTPError, json, readBoundedJSON, type JSONValue } from "./http";
import {
  peekToken, RESEND_TOTAL_WINDOW_MS, takeSlot, takeSlots, verifyToken, type ClarifyAction, type Refusal, type TokenDeps, type TokenPurpose, type TokenRow, type Verified,
} from "./public-tokens";

/** What a handler returns for the lookup page: facts from the subject, never email content. */
export interface LookupDetails { planName?: string; planStartedOn?: string; effectiveAt?: number | string; executeByDate?: string }
/** Called with the verification result of a genuine link: `Verified` (nothing consumed yet; commit through commitToken in the handler's own fenced
 *  batch) or a `link_used` refusal (so the copy can render the committed state). Return null to fall back to the default answer. */
export type PublicRouteHandler = (env: Env, result: Verified | (Refusal & { code: "link_used" }), call: { action?: ClarifyAction; request: Request }) => Promise<Response | null>;
export interface PublicHandlers {
  describe?: (env: Env, row: TokenRow) => Promise<LookupDetails>;
  confirm?: PublicRouteHandler;
  repudiate?: PublicRouteHandler;
  clarify?: PublicRouteHandler;
  /** Sends a fresh link to the CURRENT account email (WP9). Runs at most once an hour and three times in all per notice (or cancellation), shared
   *  by every purpose and button of it (the counters belong to the subject, so neither a replacement selector nor another purpose buys anything);
   *  its outcome is never visible to the caller. */
  newLink?: (env: Env, selector: string) => Promise<void>;
  /** A genuine but expired link was pressed (WP8 r1: the 312k hold link opens its case and gets a fresh link). A Response replaces the default
   *  `link_expired` refusal; null keeps it. Nothing here may consume anything, with one exception (WP8 r2): a 312k hold link acts until its
   *  cancellation's hold_until, so a genuine unused one pressed while the hold is open verifies the current identity and holds, consuming the
   *  link in the same atomic transition as a live press. */
  expired?: (env: Env, row: TokenRow, purpose: TokenPurpose) => Promise<Response | null>;
}
const handlers: PublicHandlers = {};
/** Routes of other packages (WP8: the cancellation declaration and its receipt). Tried first; null = not theirs. Survive clearPublicHandlers. */
export type ExtraPublicRoute = (request: Request, env: Env, deps: TokenDeps, ctx?: ExecutionContext) => Promise<Response | null>;
/** Dependencies the Worker's own call of publicRoute uses (tests inject the clock and the reader here, so token expiry runs on the test clock). */
let routeDeps: TokenDeps = {};
export const setPublicRouteDeps = (d: TokenDeps) => { routeDeps = d; };
const extraRoutes: ExtraPublicRoute[] = [];
export const registerPublicRoute = (r: ExtraPublicRoute) => { if (!extraRoutes.includes(r)) extraRoutes.push(r); };
/** What `describe` is currently set to (so a package can wrap it instead of replacing it). */
export const currentPublicHandlers = (): Readonly<PublicHandlers> => handlers;
export const registerPublicHandlers = (h: PublicHandlers) => { Object.assign(handlers, h); };
export const clearPublicHandlers = () => { for (const k of Object.keys(handlers)) delete (handlers as Record<string, unknown>)[k]; };

const LOOKUP_PER_MINUTE = 30;
const GARBAGE_PER_MINUTE = 300;
const NEW_LINK_PER_HOUR = 1;
const NEW_LINK_TOTAL = 3;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const SELECTOR_RE = /^[A-Za-z0-9_-]{22}$/;

const tokenBody = z.strictObject({ selector: z.string().max(64), secret: z.string().max(128) });
const clarifyBody = z.strictObject({ selector: z.string().max(64), secret: z.string().max(128), action: z.enum(["withdraw_now", "cancel_at_end"]) });
const newLinkBody = z.strictObject({ selector: z.string().max(64) });

const NEW_LINK_PATH = "/v1/public/withdrawal/new-link";
const ROUTES = new Set(["/v1/public/token/lookup", "/v1/public/withdrawal/confirm", "/v1/public/withdrawal/repudiate", "/v1/public/withdrawal/new-link", "/v1/public/clarify"]);

/** canResend says whether /new-link would send anything for this link. WP10 r1-11: never for a clarify link (plan 5.3: after a clarify link expires
 *  the holder uses the signed-in route; no new link is sent), so its refusals say false. */
const refused = (code: Exclude<Refusal["code"], "link_used">, purpose?: TokenPurpose): Response => {
  if (code === "identity_unavailable") return errorResponse(503, code);
  return errorResponse(409, code, { canResend: purpose !== "clarify" && (code === "link_expired" || code === "identity_changed") });
};
const parse = async <T>(request: Request, schema: z.ZodType<T>): Promise<T | null> => {
  const r = schema.safeParse(await readBoundedJSON(request));
  return r.success ? r.data : null;
};
const invalid = () => errorResponse(400, "invalid_request");

async function lookup(request: Request, env: Env, deps: TokenDeps): Promise<Response> {
  const body = await parse(request, tokenBody);
  if (!body) return invalid();
  const now = (deps.now ?? Date.now)();
  const bucket = SELECTOR_RE.test(body.selector) ? `lk:${body.selector}` : "lk:garbage";
  const limit = bucket === "lk:garbage" ? GARBAGE_PER_MINUTE : LOOKUP_PER_MINUTE;
  if (!await takeSlot(env, bucket, limit, MINUTE, now)) return errorResponse(429, "rate_limited");
  const peek = await peekToken(env, deps, body.selector, body.secret);
  // Unknown selector and wrong secret share this exact shape.
  if (peek.state === "refused") return json({ kind: "withdrawal", state: "refused" });
  const { row } = peek;
  const out: { [k: string]: JSONValue } = {
    kind: row.purpose === "clarify" ? "clarify" : row.subjectKind === "cancellation" ? "cancellation" : "withdrawal",
    state: peek.state,
    purpose: row.purpose,
    receivedAt: row.receivedAt,
  };
  if (row.purpose === "clarify") out.action = row.action;
  if (row.subjectKind === "notice") out.executeByDate = new Date(row.receivedAt + 13 * 86_400_000).toISOString().slice(0, 10);
  if (handlers.describe) {
    const d = await handlers.describe(env, row);
    for (const [k, v] of Object.entries(d)) if (v !== undefined) out[k] = v;
  }
  return json(out);
}

async function act(request: Request, env: Env, deps: TokenDeps, purpose: TokenPurpose, handler: PublicRouteHandler | undefined): Promise<Response> {
  let selector: string; let secret: string; let action: ClarifyAction | undefined;
  if (purpose === "clarify") {
    const b = await parse(request, clarifyBody); if (!b) return invalid();
    ({ selector, secret, action } = b);
  } else {
    const b = await parse(request, tokenBody); if (!b) return invalid();
    ({ selector, secret } = b);
  }
  const result = await verifyToken(env, deps, selector, secret, purpose, action);
  if (!result.ok && result.code === "link_expired" && "row" in result && handlers.expired) {
    const r = await handlers.expired(env, result.row, purpose);
    if (r) return r;
  }
  if (!result.ok && result.code !== "link_used") return refused(result.code, purpose);
  if (!handler) return result.ok ? errorResponse(501, "not_implemented") : refused("link_invalid");
  const answer = await handler(env, result as Verified | (Refusal & { code: "link_used" }), { action, request });
  return answer ?? (result.ok ? errorResponse(501, "not_implemented") : refused("link_invalid"));
}

/** The resend counters' key: the subject alone, never the selector (a reissue rotates the selector; the limits must survive it) and never the
 *  purpose (support design 4.5: three per notice; confirm, repudiate and both clarify buttons of one notice share one allowance). */
const resendSubject = (r: { subject_kind: string; subject_id: string }) => `${r.subject_kind}:${r.subject_id}`;

/** The /new-link request boundary: whatever happens inside (a malformed or oversized body, a counter or lookup failure, the send failing), the
 *  caller sees the same 202 {}: no way to learn whether a selector exists, is limited or mail went out. Failures are logged without detail. */
async function newLink(request: Request, env: Env, deps: TokenDeps): Promise<Response> {
  try {
    await sendNewLink(request, env, deps);
  } catch (e) {
    const reason = e instanceof HTTPError ? `request_${e.status}` : "internal";
    console.error(JSON.stringify({ message: "new link suppressed", reason }));
  }
  return json({}, 202);
}

/** For the Worker's outer error boundary: a POST to /new-link that failed before its handler ran (body cap, origin-independent request errors)
 *  still answers 202 {}. null for every other request. */
export function newLinkFailure(request: Request, error: unknown): Response | null {
  if (request.method !== "POST" || new URL(request.url).pathname !== NEW_LINK_PATH) return null;
  const reason = error instanceof HTTPError ? `request_${error.status}` : "internal";
  console.error(JSON.stringify({ message: "new link suppressed", reason }));
  return json({}, 202);
}

async function sendNewLink(request: Request, env: Env, deps: TokenDeps): Promise<void> {
  const body = await parse(request, newLinkBody);
  if (body && SELECTOR_RE.test(body.selector) && handlers.newLink) {
    const row = await env.DB.prepare("SELECT subject_kind, subject_id, purpose FROM verify_tokens WHERE selector=?")
      .bind(body.selector).first<{ subject_kind: string; subject_id: string; purpose: string }>();
    if (row) {
      const now = (deps.now ?? Date.now)();
      const key = resendSubject(row);
      // Hourly and lifetime allowance in ONE transaction: an attempt the hourly limit refuses spends nothing of the three.
      if (await takeSlots(env, [{ bucket: `nlt:${key}`, limit: NEW_LINK_TOTAL, windowMs: RESEND_TOTAL_WINDOW_MS }, { bucket: `nl:${key}`, limit: NEW_LINK_PER_HOUR, windowMs: HOUR }], now)) {
        try { await handlers.newLink(env, body.selector); } catch { console.error(JSON.stringify({ message: "new link failed" })); }
      }
    }
  }
}

/** Answers /v1/public/* token routes, or null for any other path. Runs before authentication (these callers have no session). */
export async function publicRoute(request: Request, env: Env, deps: TokenDeps = {}, ctx?: ExecutionContext): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  deps = { ...routeDeps, ...deps };
  for (const extra of extraRoutes) { const r = await extra(request, env, deps, ctx); if (r) return r; }
  if (!ROUTES.has(path)) return null;
  if (request.method !== "POST") return errorResponse(405, "method_not_allowed");   // a prefetching scanner's GET changes nothing
  switch (path) {
    case "/v1/public/token/lookup": return lookup(request, env, deps);
    case "/v1/public/withdrawal/confirm": return act(request, env, deps, "confirm", handlers.confirm);
    case "/v1/public/withdrawal/repudiate": return act(request, env, deps, "repudiate", handlers.repudiate);
    case "/v1/public/clarify": return act(request, env, deps, "clarify", handlers.clarify);
    default: return newLink(request, env, deps);
  }
}
