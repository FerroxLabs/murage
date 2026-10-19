// SPDX-License-Identifier: AGPL-3.0-or-later
// Step-up by a fresh emailed 6-digit code (Sean, 2026-10-12: no customer is ever required to own an authenticator or passkey). Binding
// contract: Astra STEPUP-EMAIL-1 ("Contract" section and findings 1-9), with STEPUP-EMAIL-2 findings 1-6 and STEPUP-EMAIL-3 findings 1-6. Authenticators stay optional and
// work exactly as before (customer-identity.ts stepUpNeeded); this is the always-available alternative for the protected actions
// (STEP_UP_ROUTES / PATTERNS, unchanged, plus the GET logs read that self-service.ts checks in its handler).
//
// The shape, end to end:
//   1. A protected request that is refused answers 403 step_up_required through ONE serializer (stepUpRefusal, used for the worker gate
//      and every handler alike). Its step_up.email_code.intent_id names a server-FROZEN intent: this account, this Supabase session, the
//      method, the path, the canonical query and body (material parameters), and the route's RESOLVED TARGET with its material versions
//      (targetSpec: the current home and its generation/lifecycle; the Flux home's lifecycle, link and cap versions; the subscription's
//      plan, status and period; the export job). The id is a reference, never a credential.
//   2. POST /v1/account/step-up/email/send {intentId}: reserves one of the account's five issuances per rolling 24 h (30 s apart, failed
//      deliveries count, new sessions never reset it), replaces this session's previous challenge, and emails a 6-digit code to the
//      CURRENT confirmed Supabase address (fixed, code-free subject). 202 only after the sender accepted the message.
//   3. POST /v1/account/step-up/email/verify {intentId, challengeId, code}: spends one of the challenge's five guesses atomically BEFORE
//      comparing, compares in constant time, then in ONE batch deletes exactly that challenge (still unexpired) and approves exactly that
//      intent (changes()=1). Every failure is the same 403 code_refused.
//   4. The site retries the frozen request with "stepUpIntentId" in its JSON body (a query parameter for GET logs). The retry MUST be the
//      byte-identical approved request: for POST /v1/billing/checkout that includes consent.disclosureToken exactly as first sent (never
//      a freshly fetched token). A resend that differs ONLY in that token runs nothing and answers 403 stepup_request_changed with
//      changed:"disclosure_token", keeping the approval (at most MAX_TOKEN_MISMATCHES times); any other change voids it. prepareStepUp strips
//      it before any handler's strict validation and FIRST resolves the named intent's own state (a completed or running operation is
//      answered as such whatever else could authorize the request: #6). Otherwise it CLAIMS it UNDER THE HANDLER'S LEASE (STEPUP-EMAIL-3
//      #2), in ONE D1 batch: the frozen target re-computed in SQL must be unchanged (its pinned versions: for billing routes only the one
//      home and subscription the action touches), the lease free; then the approval is consumed, the operation record is created
//      (executing, phase 'claimed', fencing token exec_token) and the lease (that home's billing lease, or the Flux home lease) is
//      acquired for the record's holder. The handler runs AS that holder (step-up-op.ts): billing-lease.ts withHomeLease and b4-flux.ts
//      use the held lease, another home is refused. A busy lease consumes nothing. Only a TRUSTED factor can stand in for the email
//      approval here; the first-purchase bootstrap is never promoted into one (#1).
//   5. Explicit phases (#4): 'claimed' (lease bookkeeping only) -> 'dispatched' (journalDispatch: an external call recorded under the
//      operation's stable identity BEFORE it is made: portal and Checkout sessions, the export link, the Flux mint) -> 'committed' (the
//      operation's durable effect, marked in the SAME transaction: the journaled binding marks a handler's first durable write, a Flux
//      mint marks its key adoption itself) -> 'delivered' (the finalization) or 'compensated' (the sweep revoked an undelivered Flux
//      key). Nothing is answered unless the token-fenced finalization changed exactly this row (#3): a runner superseded by a
//      reconciling retry answers 409 action_in_progress only, never its response. An interruption is reconciled by phase: before
//      commitment the exact retry resumes it; after it, it is completed and never re-run. The approval is marked consumed the moment the
//      claim succeeds (#5): every answer after it, errors included, says x-step-up-consumed: 1, unless a confirmed release of a no-effect
//      refusal ('claimed', 4xx) gave the approval back for an exact retry. NO response body is ever stored: a completed secret-bearing
//      operation answers its duplicates 410 already_completed (409 action_in_progress while it runs) with the operation reference only;
//      any other keeps status, error code and operation reference, expiring with the grant.
//   6. GET logs after POST logs/request is bound to that home, its generation and that collect_logs command, and only until the
//      ORIGINAL grant deadline (#4).
//   7. Revocation: live Supabase GET /auth/v1/user (the member's own token) at send, verify, the claim and a resumption; fail closed. The
//      address and its generation (auth.users.updated_at) are bound into the code HMAC, the approval and the claim, so A->B->A
//      invalidates. No sliding renewal: the approval lives min(600 s, CLOUD_STEPUP_MAX_AGE_SECONDS) from verification. Logout is
//      Supabase's server-side session revocation, which /user then refuses (401).
// Factor administration (trusted-factors.ts) never consults this proof: it calls trustedStepUpRequirement directly.
import { z } from "zod";
import { fluxClaimLeaseStatements, fluxLeaseFree, linkRevisionSql, releaseFluxLeaseStatement, undeliveredKeyCompensation } from "./b4-flux";
import { claimHomeLeaseStatements, homeLeaseFree, releaseHomeLeaseOf } from "./billing-lease";
import { NONE_SELLER } from "./checkout-replacement";
import { admin } from "./b3-control";
import { boundCustomer, carryBinding, DEVICE_REVOKE_ROUTE, DOOR_ROUTE, markStepUpProof, needsStepUp, stepUpMaxAgeFor, type Identity } from "./customer-identity";
import { senderOrFail, type TransactionalEmailSender } from "./email";
import { errorResponse, HTTPError, json, readBoundedJSON, type JSONValue } from "./http";
import { isPurchaseRoute } from "./purchase-bootstrap";
import { bindStepUpOp, type StepUpOp } from "./step-up-op";
import type { SupabaseAuthConfig } from "./supabase-jwt";

export const SEND_PATH = "/v1/account/step-up/email/send";
export const VERIFY_PATH = "/v1/account/step-up/email/verify";
export const LOGS_READ_PATH = "/v1/account/home/logs";
const LOGS_REQUEST_PATH = "/v1/account/home/logs/request";
const EXPORT_DOWNLOAD_PATH = "/v1/account/export/download";

export const CODE_DIGITS = 6;
export const CODE_TTL_SECONDS = 600;
export const MAX_GUESSES = 5;
export const SENDS_PER_DAY = 5;
export const SEND_GAP_MS = 30_000;
const DAY_MS = 24 * 60 * 60_000;
/** A frozen intent waits this long for its code. */
export const INTENT_TTL_MS = 30 * 60_000;
/** Pending intents kept per account (each refusal may freeze one); the oldest go first. */
const MAX_PENDING_INTENTS = 20;
/** How many resends of an intent that differ only in the disclosure token are answered 403 stepup_request_changed before it is dropped. */
const MAX_TOKEN_MISMATCHES = 3;
/** A claimed operation runs this long before an exact retry may reconcile it (the billing lease's length). */
export const EXEC_LEASE_MS = 2 * 60_000;
const PURPOSE = "murage.stepup-email.v1";

export const INTENT_ID_RE = /^si_[0-9a-f]{32}$/;
/** The body without consent.disclosureToken, or null when it carries no such token (only the checkout consent does). */
function withoutDisclosureToken(body: unknown): unknown {
  const consent = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).consent : undefined;
  if (!consent || typeof consent !== "object" || Array.isArray(consent) || typeof (consent as Record<string, unknown>).disclosureToken !== "string") return null;
  const { disclosureToken: _token, ...rest } = consent as Record<string, unknown>;
  return { ...(body as Record<string, unknown>), consent: rest };
}
const CHALLENGE_ID_RE = /^sc_[0-9a-f]{32}$/;
const intentId = z.string().regex(INTENT_ID_RE);
const sendSchema = z.strictObject({ intentId });
const verifySchema = z.strictObject({ intentId, challengeId: z.string().regex(CHALLENGE_ID_RE), code: z.string().regex(/^[0-9]{6}$/) });

/** A protected action: the worker gate's routes, plus GET logs (gated in its handler, self-service.ts readLogs). */
export const isProtectedAction = (method: string, path: string) => needsStepUp(method, path) || (method === "GET" && path === LOGS_READ_PATH);
/** The approval's lifetime in seconds: never longer than the authenticator window (60..3600 s, supabase-jwt.ts), nor than the route's own
 *  (300 s on the door: customer-identity.ts stepUpMaxAgeFor). */
export const grantTtlSeconds = (config: SupabaseAuthConfig, path = "") =>
  Math.min(CODE_TTL_SECONDS, stepUpMaxAgeFor(path, config.stepUpMaxAgeSeconds));

// ---- primitives --------------------------------------------------------------------------------------------------------------------

const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
const randomId = (prefix: string) => `${prefix}${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}
/** Six uniformly random digits: rejection sampling over a 32-bit word, no modulo bias. */
export function sixDigits(): string {
  const limit = 4_294_967_296 - (4_294_967_296 % 1_000_000);
  const word = new Uint32Array(1);
  do crypto.getRandomValues(word); while (word[0] >= limit);
  return String(word[0] % 1_000_000).padStart(CODE_DIGITS, "0");
}
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
/** HMAC of the canonically encoded tuple (a JSON array of strings: unambiguous, no separator games). */
export const codeHash = (secret: string, t: { issuer: string; userId: string; sessionId: string; email: string; gen: string; intentId: string;
  challengeId: string; code: string }) =>
  hmacHex(secret, JSON.stringify([PURPOSE, t.issuer, t.userId, t.sessionId, t.email, t.gen, t.intentId, t.challengeId, t.code]));

/** Canonical JSON: object keys sorted at every level, so the same parameters always hash the same. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

function rateLimited(retryAfterMs: number): Response {
  const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
  // Both spellings, same value (the site reads retry_after_seconds; Astra STEPUP-EMAIL-9 #5), and the Retry-After header.
  const res = errorResponse(429, "rate_limited", { retryAfter, retry_after_seconds: retryAfter });
  res.headers.set("retry-after", String(retryAfter));
  return res;
}
const event = (env: Env, userId: string, sessionId: string, kind: string, intent: string | null, challenge: string | null, at: number) =>
  env.DB.prepare("INSERT INTO cloud_stepup_events (id,user_id,session_id,kind,intent_id,challenge_id,at) VALUES (?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), userId, sessionId, kind, intent, challenge, at);

// ---- routes: what each protected action targets, holds and whether its answer carries a secret -------------------------------------

const CURRENT_HOME_ROUTES: ReadonlySet<string> = new Set(["/v1/account/home/hold", "/v1/account/home/reset", "/v1/account/home/reset/undo", LOGS_REQUEST_PATH]);
const DESKTOP_RE = /^\/v1\/account\/homes\/([^/]+)\/desktop-code$/;
const FLUX_HOME_RE = /^\/v1\/homes\/([^/]+)\/flux\/(subkey|cap|stop)$/;
const FLUX_LINK_RE = /^\/v1\/flux\/link\/(?:start|complete)$/;
const KEEP_RE = /^\/v1\/account\/cancellations\/([^/]+)\/keep$/;

/** Operations whose answer carries NO secret (a status, ids, amounts). Everything else is secret-bearing, fail-safe: the export link and
 *  its decryption key (self-service.ts exportDownloadLink), the Flux key (b4-flux.ts mintLocked), the desktop pairing code (pairing.ts),
 *  the Stripe Checkout and billing-portal session links (b5-billing.ts, members-api.ts resume), the Flux link state (b4-flux.ts
 *  linkStart) and log lines (GET logs). For those NOTHING of the answer is kept; for these only status, error code and an id. */
export function nonSecretAnswer(method: string, path: string): boolean {
  if (method !== "POST") return false;
  return CURRENT_HOME_ROUTES.has(path) || path === "/v1/account/topup" || path === "/v1/account/plan"
    || path === "/v1/account/export-request" || KEEP_RE.test(path) || path === "/v1/flux/link/complete"
    || /^\/v1\/homes\/[^/]+\/flux\/(?:cap|stop)$/.test(path) || DEVICE_REVOKE_ROUTE.test(path);
}

/** A route's frozen target and the resource lease its handler runs under (Astra STEPUP-EMAIL-3 #2). `sql` is a scalar SQL expression:
 *  the resolved operation's identity and the material versions of exactly what it depends on, as JSON text whose element 1 is the home
 *  for the "home", "billing" and "flux" kinds. The same SQL freezes the intent and, inside the claiming statement and every repeated
 *  check, re-validates it. `lease`: the handler's lease on that home, acquired by the claim in the SAME batch that consumes the approval
 *  and creates the operation record; the handler then runs as its holder (step-up-op.ts). `explicit`: the handler marks its own phases
 *  (dispatch, commitment); otherwise its first journaled durable write is its commitment. */
export interface TargetSpec { kind: string; op: string; sql: string; binds: unknown[]; lease: "billing" | "flux" | null; explicit: boolean;
  /** Every durable write of the operation is an own reservation (step-up-op.ts reserveOwn; journalD1). */
  reserveOwn?: boolean }
const CURRENT_HOME = "SELECT h.id FROM cloud_homes h WHERE h.owner_id=? AND h.desired_state<>'deleted' ORDER BY h.created_at DESC LIMIT 1";
/** The homes the billing handlers resolve (b5-billing.ts actor "payable" / "subscribed", legal-routes.ts ownHome, the quote's, the
 *  cancellation's), as SQL with their binds. */
type HomeSql = { sql: string; binds: unknown[] };
const payableHome = (userId: string, now: number): HomeSql => ({ binds: [userId, userId, NONE_SELLER, now],
  sql: `SELECT COALESCE((SELECT id FROM cloud_homes WHERE owner_id=? AND desired_state='payment_pending' ORDER BY created_at DESC LIMIT 1),
    (SELECT h.id FROM checkout_retry_routes r JOIN cloud_homes h ON h.owner_id=r.account_id AND h.desired_state<>'deleted'
      JOIN billing_subscriptions b ON b.home_id=h.id AND b.subscription_id=r.replaces_subscription_id
      WHERE r.account_id=? AND r.reason='address_change' AND r.seller<>? AND r.expires_at>? ORDER BY h.created_at DESC LIMIT 1))` });
const subscribedHome = (userId: string): HomeSql => ({ binds: [userId], sql: `SELECT h.id FROM cloud_homes h JOIN billing_subscriptions b ON b.home_id=h.id
  WHERE h.owner_id=? AND h.desired_state<>'deleted' ORDER BY h.created_at DESC LIMIT 1` });
const currentHome = (userId: string): HomeSql => ({ binds: [userId], sql: CURRENT_HOME });
/** The home's open order (correlated on the billing target's h.id): its consent id and material fingerprint, and the consent's money terms. */
const CHECKOUT_ORDER = `SELECT json_array(o.consent_id, o.fingerprint, c.plan, c.price_cents, c.billing_country, c.declared_country, c.stripe_price_id,
    c.quote_id, c.quoted_total_cents, c.topup_enabled, c.topup_amount_cents, c.topup_threshold_cents, c.topup_cap_cents, c.start_request_at)
  FROM open_checkouts o LEFT JOIN checkout_consents c ON c.id=o.consent_id WHERE o.home_id=h.id`;
const str = (body: unknown, key: string) => body && typeof body === "object" && typeof (body as Record<string, unknown>)[key] === "string"
  ? (body as Record<string, string>)[key] : "";
/** ONE home's billing dependencies: its state, entitlement, generation, payment version and its subscription's id, plan, status, period
 *  and cancellation revision, plus `extra` (the quote, the cancellation). Never the other homes of the account: a renewal elsewhere
 *  does not void this approval, and only this home's billing lease is taken. */
const billingTarget = (home: HomeSql, op: string, lease: boolean, extra?: HomeSql): TargetSpec => ({ kind: "billing", op, lease: lease ? "billing" : null,
  explicit: false, binds: [...(extra?.binds ?? []), ...home.binds],
  sql: `COALESCE((SELECT json_array('billing', h.id, h.desired_state, h.entitlement, h.generation, h.payment_version, s.subscription_id, s.plan,
      s.status, s.cancel_at_period_end, s.current_period_start, s.current_period_end, s.cancel_intent_rev, ${extra ? `(${extra.sql})` : "NULL"})
    FROM cloud_homes h LEFT JOIN billing_subscriptions s ON s.home_id=h.id WHERE h.id=(${home.sql})), 'none')` });

export function targetSpec(method: string, path: string, body: unknown, userId: string, now: number): TargetSpec {
  // "The current home" (self-service.ts customerHome): the newest live home, its generation, resource generation, lifecycle state and
  // payment version. A newer home, a reset, a delete or a payment change is a different target. Its handlers run under its billing lease
  // (self-service.ts underLease); the GET logs read takes none.
  if (CURRENT_HOME_ROUTES.has(path) || (method === "GET" && path === LOGS_READ_PATH)) {
    return { kind: "home", op: path.slice(path.lastIndexOf("/") + 1), binds: [userId], lease: method === "GET" ? null : "billing", explicit: false,
      sql: `COALESCE((SELECT json_array('home', h.id, h.generation, h.resource_generation, h.desired_state, h.payment_version) FROM cloud_homes h
        WHERE h.owner_id=? AND h.desired_state<>'deleted' ORDER BY h.created_at DESC LIMIT 1), 'none')` };
  }
  if (path === EXPORT_DOWNLOAD_PATH) {
    // The export job named in the body, as the handler authorises it (historical ownership), with its state, availability and whether its
    // key is still undisclosed. No lease: the disclosure is its own once-only row (self-service.ts exportDownloadLink).
    const requestId = str(body, "requestId");
    return { kind: "export", op: "export_link", binds: [requestId, userId, userId], lease: null, explicit: false,
      sql: `COALESCE((SELECT json_array('export', j.request_id, j.home_id, j.state, j.available_until, j.archive_id, j.wrapped_key IS NOT NULL)
        FROM cloud_export_jobs j JOIN cloud_homes h ON h.id=j.home_id WHERE j.request_id=?
        AND (h.owner_id=? OR EXISTS (SELECT 1 FROM data_export_requests r WHERE r.id=j.request_id AND r.user_id=?))), 'none')` };
  }
  const desktop = DESKTOP_RE.exec(path);
  if (desktop) {
    // A pairing code (pairing.ts) holds no lease: its code row is its own record.
    return { kind: "desktop", op: "desktop_code", binds: [desktop[1], userId], lease: null, explicit: false,
      sql: `COALESCE((SELECT json_array('desktop', h.id, h.generation, h.desired_state) FROM cloud_homes h WHERE h.id=? AND h.owner_id=?), 'none')` };
  }
  const revoke = DEVICE_REVOKE_ROUTE.exec(path);
  if (revoke) {
    // Removing a device (devices.ts) holds no lease: the owned home, its generation and state, and the device named.
    return { kind: "device", op: "device_revoke", binds: [revoke[2], revoke[1], userId], lease: null, explicit: false,
      sql: `COALESCE((SELECT json_array('device', ?, h.id, h.generation, h.desired_state) FROM cloud_homes h WHERE h.id=? AND h.owner_id=?), 'none')` };
  }
  const door = DOOR_ROUTE.exec(path);
  if (door) {
    // The door (door.ts) holds no lease and keeps no ticket: the owned home, its generation and state. A rebuilt or deleted home is a new target.
    return { kind: "door", op: "door", binds: [door[1], userId], lease: null, explicit: false,
      sql: `COALESCE((SELECT json_array('door', h.id, h.generation, h.desired_state) FROM cloud_homes h WHERE h.id=? AND h.owner_id=?), 'none')` };
  }
  const fluxHome = FLUX_HOME_RE.exec(path);
  if (fluxHome) {
    // The Flux home: its lifecycle version (every Stop, billing stop, unlink and resume moves it), cap version, key state, billing hold and
    // the link it was minted under, and the owner's current link (id, version, fenced). Runs under the home's Flux lease (b4-flux.ts); a
    // mint marks its own dispatch and commitment (an interruption before the mint is NOT a completed operation).
    // NORMALIZED (Astra STEPUP-EMAIL-4 #4): a home without a key row yet freezes exactly as the row the claim seeds in the same batch
    // (b4-flux.ts fluxClaimLeaseStatements: state 'none', versions 0, no hold), so seeding it is not a change of target. Last element:
    // the owner's monotonic link revision (absence included).
    return { kind: "flux", op: fluxHome[2] === "subkey" ? "flux_mint" : `flux_${fluxHome[2]}`, binds: [fluxHome[1], userId], lease: "flux",
      explicit: fluxHome[2] === "subkey",
      sql: `COALESCE((SELECT json_array('flux', h.id, h.generation, COALESCE(k.state, 'none'), COALESCE(k.lifecycle_version, 0), COALESCE(k.cap_version, 0),
          COALESCE(k.billing_hold, 0), k.link_id, k.link_version, k.stop_version, l.flux_account_id, l.link_id, l.link_version, l.fenced, ${linkRevisionSql("h.owner_id")})
        FROM cloud_homes h LEFT JOIN flux_home_keys k ON k.home_id=h.id LEFT JOIN flux_links l ON l.owner_user_id=h.owner_id
        WHERE h.id=? AND h.owner_id=? AND h.desired_state<>'deleted'), 'none')` };
  }
  if (FLUX_LINK_RE.test(path)) {
    // The owner's link, ALWAYS with its monotonic revision (element 1; b4-flux.ts linkRevisionSql): link, unlink and relink each move it
    // and absence is a revision too, never a missing field (Astra STEPUP-EMAIL-4 #2: absent -> linked -> unlinked is not "the same
    // target"). The link mutation re-checks the same revision inside its own statement (b4-flux.ts linkComplete).
    // Completion marks its own commitment (#4 of STEPUP-EMAIL-5): the challenge, the proof and the revision-checked link insert are ONE
    // batch, committed only with that link (b4-flux.ts linkComplete).
    return { kind: "flux_link", op: "flux_link", binds: [userId], lease: null, explicit: path.endsWith("/complete"),
      sql: `(SELECT json_array('flux_link', ${linkRevisionSql("o.id")}, l.flux_account_id, l.link_id, l.link_version, l.fenced)
        FROM (SELECT ? AS id) o LEFT JOIN flux_links l ON l.owner_user_id=o.id)` };
  }
  // Billing and account actions: the ONE home the handler resolves, under that home's billing lease.
  const keep = KEEP_RE.exec(path);
  if (keep) {
    return billingTarget({ binds: [keep[1], userId], sql: "SELECT c.home_id FROM cancellation_requests c JOIN cloud_homes h ON h.id=c.home_id WHERE c.id=? AND h.owner_id=?" },
      "keep", true, { binds: [keep[1]], sql: "SELECT json_array(c.status, c.subscription_id, c.effective_at) FROM cancellation_requests c WHERE c.id=?" });
  }
  if (path === "/v1/account/plan") {
    const quoteId = str(body, "quoteId");
    return billingTarget({ binds: [quoteId, userId], sql: "SELECT q.home_id FROM plan_quotes q WHERE q.id=? AND q.user_id=?" }, "plan", true,
      { binds: [quoteId], sql: "SELECT json_array(q.id, q.used_at, q.expires_at, q.to_plan, q.subscription_id) FROM plan_quotes q WHERE q.id=?" });
  }
  // Checkout and resume mark their own phases (Astra STEPUP-EMAIL-4 #1): preparation writes (the open row, the consent, the customer)
  // are not the operation; journalDispatch precedes the Stripe session, and only the session recorded as the home's open checkout
  // commits it (b5-billing.ts createCheckoutLeased, members-api.ts resumeLeased: commitQ in that same batch).
  // The target is also THE ORDER (Astra STEPUP-EMAIL-5 #1): the home's open checkout, its consent id and the material checkout
  // fingerprint (plan, countries, top-up, renewal text, versions: open_checkouts.fingerprint) with the consent's price, quote, top-up
  // and button-press time. Checkout A replaced by a same-plan checkout B is a different target: A's approval never pays for B. Only the
  // order's identity and money terms are frozen, never its session bookkeeping (state, session id), which the operation itself moves.
  // Every write of the operation is an own reservation (reserveOwn, journalD1): checked against the target under the held billing lease
  // and recorded as the target it leaves (the open row, the consent, the subscription row it creates), so its exact retry after a crash
  // recognises its own changes (#3).
  if (path === "/v1/billing/checkout" || path === "/v1/billing/checkout/resume") {
    return { ...billingTarget(payableHome(userId, now), "checkout", true, { binds: [], sql: CHECKOUT_ORDER }), explicit: true, reserveOwn: true };
  }
  // Reserving creates the home: there is no home lease to take yet; the account's payable home (usually none) is what it depends on.
  if (path === "/v1/billing/portal") return billingTarget(subscribedHome(userId), "portal", true);
  return billingTarget(currentHome(userId), path === "/v1/account/topup" ? "topup" : "export_request", true);
}
/** Element `i` of a frozen target's JSON, when it is of type `t`. */
function targetAt<T>(target: string, i: number, t: "string" | "number"): T | null {
  try { const v = (JSON.parse(target) as unknown[])[i]; return typeof v === t ? v as T : null; } catch { return null; }
}
/** The home a "home"/"billing"/"flux" target was resolved to (null: none). */
const homeOf = (spec: TargetSpec, target: string) => spec.kind === "home" || spec.kind === "billing" || spec.kind === "flux" ? targetAt<string>(target, 1, "string") : null;

// ---- intents -----------------------------------------------------------------------------------------------------------------------

/** What a protected request asks for, without its stepUpIntentId: frozen into an intent on refusal, matched on retry. */
export interface Frozen {
  method: string; path: string; paramsHash: string; body: unknown;
  /** The same fingerprint without the checkout consent's disclosureToken (null: the request carries none). Never authorizes anything. */
  tokenFreeHash?: string | null;
}

interface IntentRow {
  id: string; user_id: string; session_id: string; method: string; path: string; params_hash: string; target_kind: string; target: string;
  secret: number; state: string; email: string | null; email_gen: string | null; expires_at: number; approved_at: number | null;
  grant_expires_at: number | null; token_free_hash: string | null; exec_token: string | null; exec_until: number | null; response_status: number | null;
  phase: string | null; dispatch_ref: string | null; reserved_target: string | null; op_kind: string | null; lease_kind: string | null; lease_home: string | null; lease_holder: string | null;
  response_code: string | null; response_ref: string | null; continuation_home: string | null; continuation_generation: number | null;
  continuation_command: string | null;
}

/** The pending intent for exactly this request, this session and this target (reused while it waits), or a new one. The target is
 *  resolved and persisted NOW (#3): approval and claim are bound to it. */
async function freezeIntent(env: Env, userId: string, sessionId: string, f: Frozen, now: number): Promise<string> {
  const spec = targetSpec(f.method, f.path, f.body, userId, now);
  const target = (await env.DB.prepare(`SELECT ${spec.sql} AS t`).bind(...spec.binds).first<{ t: string }>())!.t;
  const same = await env.DB.prepare(`SELECT id FROM cloud_stepup_intents WHERE user_id=? AND session_id=? AND state='pending' AND expires_at>?
    AND method=? AND path=? AND params_hash=? AND target=? ORDER BY created_at DESC LIMIT 1`)
    .bind(userId, sessionId, now, f.method, f.path, f.paramsHash, target).first<{ id: string }>();
  if (same) return same.id;
  const id = randomId("si_");
  await env.DB.batch([
    // Only expired approvals that never became an operation (Astra STEPUP-EMAIL-4 #5). An operation record (executing, done, or an
    // undelivered committed Flux key awaiting its compensation) is never collected here: the sweep does, once it is settled.
    env.DB.prepare("DELETE FROM cloud_stepup_intents WHERE user_id=? AND expires_at<=? AND state IN ('pending','approved')").bind(userId, now),
    env.DB.prepare(`INSERT INTO cloud_stepup_intents (id,user_id,session_id,method,path,params_hash,token_free_hash,target_kind,target,secret,state,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).bind(id, userId, sessionId, f.method, f.path, f.paramsHash, f.tokenFreeHash ?? null, spec.kind, target,
      nonSecretAnswer(f.method, f.path) ? 0 : 1, now, now + INTENT_TTL_MS),
    env.DB.prepare(`DELETE FROM cloud_stepup_intents WHERE user_id=? AND state='pending' AND id NOT IN
      (SELECT id FROM cloud_stepup_intents WHERE user_id=? AND state='pending' ORDER BY created_at DESC, rowid DESC LIMIT ?)`)
      .bind(userId, userId, MAX_PENDING_INTENTS),
  ]);
  return id;
}

/** THE step-up refusal (Astra #2: one serializer for the gate and every handler). Keeps whatever the refusing code said (reason, methods,
 *  window, purchase bootstrap:false), fills the authenticator requirement when it said nothing, and adds the email alternative bound to a
 *  frozen intent for exactly this request. */
export async function stepUpRefusal(env: Env, identity: Identity, request: Request, frozen: Frozen, error: HTTPError): Promise<HTTPError> {
  const existing = (error.extra?.step_up ?? {}) as { [key: string]: JSONValue };
  let need: { [key: string]: JSONValue } = {};
  if (existing.reason === undefined) {
    try { need = ((await identity.stepUpNeeded(request, env)) ?? {}) as unknown as { [key: string]: JSONValue }; } catch { need = {}; }
  }
  const s = await identity.customer(request);
  const config = identity.config(env);
  // What the member may use, in offer order: the account's usable trusted authenticators first ("totp" for an authenticator app,
  // "webauthn" for a security key or passkey: Supabase's factor types), then "email_code", always present, always last. The list is
  // advisory (D1 trust rows only); the proof itself is re-checked live when it is used.
  // Without a bound Supabase session nothing can be frozen: the refusal stays as the refusing code wrote it (no email alternative).
  if (!s || !s.supabase.sessionId || !config) return error;
  const methods: string[] = [];
  const rows = (await env.DB.prepare("SELECT DISTINCT factor_type FROM cloud_trusted_factors WHERE user_id=? AND state='active' AND usable_at<=?")
    .bind(s.user.id, identity.now()).all<{ factor_type: string }>()).results.map((r) => r.factor_type);
  for (const m of ["totp", "webauthn"]) if (rows.includes(m)) methods.push(m);
  methods.push("email_code");
  const id = await freezeIntent(env, s.user.id, s.supabase.sessionId, frozen, identity.now());
  const emailCode = { available: true, digits: CODE_DIGITS, ttl_seconds: CODE_TTL_SECONDS, grant_ttl_seconds: grantTtlSeconds(config, frozen.path), intent_id: id };
  const stepUp = { ...need, ...existing, methods, ...(isPurchaseRoute(frozen.method, frozen.path) ? { bootstrap: false } : {}), email_code: emailCode };
  return new HTTPError(403, "step_up_required", { ...(error.extra ?? {}), step_up: stepUp });
}

/** True only for a refusal the members area can act on: step_up.email_code with every field (Astra STEPUP-EMAIL-7 #4). */
export function completeStepUpRefusal(error: HTTPError): boolean {
  const code = ((error.extra?.step_up ?? null) as { email_code?: Record<string, unknown> } | null)?.email_code;
  return !!code && code.available === true && Number.isSafeInteger(code.digits) && Number.isSafeInteger(code.ttl_seconds)
    && Number.isSafeInteger(code.grant_ttl_seconds) && typeof code.intent_id === "string" && /^si_[0-9a-f]{32}$/.test(code.intent_id);
}

// ---- the protected request: extract, resolve, claim ---------------------------------------------------------------------------------

export interface Prepared {
  request: Request;
  /** Set on a protected action by a customer (not the operator): what a refusal would freeze. */
  frozen: Frozen | null;
  /** The intent this request claimed: its operation record, fencing token and held lease (the outcome must be recorded). */
  claimed?: { id: string; token: string; secret: boolean; explicit: boolean; op: StepUpOp };
  /** The answer for a duplicate of the named operation (never a stored body). */
  replay?: Response;
  /** The approval was consumed by this request: its answer, whatever it is, says x-step-up-consumed: 1. */
  consumed?: boolean;
}

/** The response of the call that consumed an intent, or of a duplicate of that same operation, says so (and no other does). */
export const CONSUMED_HEADER = "x-step-up-consumed";
function consumed(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set(CONSUMED_HEADER, "1");
  return out;
}

/** A duplicate of a completed operation: never its body. A secret-bearing one (or one whose answer is unknown) is 410 already_completed;
 *  any other answers its recorded status with the operation reference (and error code). */
function replayOf(row: IntentRow): Response {
  const operation: { [key: string]: JSONValue } = { id: row.id, ...(row.response_ref ? { ref: row.response_ref } : {}) };
  const status = row.response_status;
  const ok = status === null || (status >= 200 && status < 300);
  if (ok && (row.secret === 1 || status === null)) return consumed(errorResponse(410, "already_completed", { operation }));
  if (ok) return consumed(json({ replayed: true, operation }, status));
  return consumed(errorResponse(status, row.response_code ?? "action_failed", { ...(FIXED_ERROR_FIELDS[row.response_code ?? ""] ?? {}), replayed: true, operation }));
}
/** The fixed, non-secret fields an error code always carries, rebuilt on its replay from the stored code alone (no body is stored; Astra
 *  STEPUP-EMAIL-9 #4): consent_stale always says restart:"checkout" (b5-billing.ts consentRestart, members-api.ts). */
const FIXED_ERROR_FIELDS: Record<string, { [key: string]: JSONValue }> = { consent_stale: { restart: "checkout" } };

/** Runs on every request after authentication and the body cap, before any route. On a protected action by a Cloud customer: validates
 *  and removes stepUpIntentId (body field; query parameter on GET) before any strict body validation, fingerprints the request, resolves
 *  the named intent's own execution/replay state first, and claims it when it authorizes exactly this request. */
export async function prepareStepUp(request: Request, env: Env, identity: Identity,
  opts: { operator: () => Promise<boolean>; stepped: (request: Request) => Promise<boolean> }, sink: { consumed?: boolean } = {}): Promise<Prepared> {
  const url = new URL(request.url);
  const method = request.method;
  if (!boundCustomer(request)) return { request, frozen: null };
  // stepUpIntentId is removed from EVERY Cloud request before any route sees it (query parameter, or a top-level JSON body field), so a
  // strict body schema never trips on it. Off a protected action it is ignored. A malformed one is no reference at all.
  let named: string | null = null;
  let carried = false;
  let out = request;
  let body: unknown = null;
  const query = new URLSearchParams(url.search);
  if (query.has("stepUpIntentId")) {
    const ids = query.getAll("stepUpIntentId");
    carried = true;
    if (method === "GET" && ids.length === 1 && INTENT_ID_RE.test(ids[0])) named = ids[0];
    query.delete("stepUpIntentId");
    const u = new URL(url);
    u.search = query.toString();
    out = new Request(u.toString(), { method, headers: request.headers, body: method === "GET" || method === "HEAD" ? undefined : await request.clone().arrayBuffer() });
  }
  if (method !== "GET" && method !== "HEAD") {
    const text = request.body ? await request.clone().text() : "";
    let parsed: unknown = undefined;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.hasOwn(parsed, "stepUpIntentId")) {
      const { stepUpIntentId: v, ...rest } = parsed as Record<string, unknown>;
      carried = true;
      if (typeof v === "string" && INTENT_ID_RE.test(v)) named = v;
      body = rest;
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      out = new Request(out.url, { method, headers, body: JSON.stringify(rest) });
    } else {
      body = parsed === undefined ? { raw: text } : parsed;
    }
  }
  if (out !== request) carryBinding(request, out);
  if (!isProtectedAction(method, url.pathname) || await opts.operator()) return { request: out, frozen: null };
  const sortedQuery = [...query.entries()].sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1));
  const tokenFree = withoutDisclosureToken(body);
  const frozen: Frozen = { method, path: url.pathname, body,
    paramsHash: await sha256(JSON.stringify([method, url.pathname, sortedQuery, canonical(body)])),
    tokenFreeHash: tokenFree === null ? null : await sha256(JSON.stringify([method, url.pathname, sortedQuery, canonical(tokenFree)])) };
  if (!carried || !named) return { request: out, frozen };

  const s = await identity.customer(out);
  if (!s) throw new HTTPError(401, "unauthorized");
  const config = identity.config(env);
  if (!s.supabase.sessionId || !config) return { request: out, frozen };
  const c: Ctx = { env, identity, out, frozen, userId: s.user.id, sessionId: s.supabase.sessionId, now: identity.now(),
    grantMs: grantTtlSeconds(config, frozen.path) * 1000, spec: targetSpec(method, frozen.path, body, s.user.id, identity.now()), stepped: opts.stepped, sink };
  const row = await loadIntent(c, named);
  if (!row) return { request: out, frozen };
  const exact = row.method === method && row.path === frozen.path && row.params_hash === frozen.paramsHash;
  // 1. The named operation's own state comes FIRST, whatever else could authorize this request (#6): a running or completed operation is
  //    answered as such, never run again.
  //    Its approval is CONSUMED from this moment (Astra STEPUP-EMAIL-5 #5): every answer of this request says so, whatever happens next
  //    (a 401/503 of the live identity check, a 403 after the target, address, grant or factor authority moved, a 500 while the duplicate
  //    is reconciled). Only a confirmed release (recordOutcome) clears it.
  if (exact && (row.state === "executing" || row.state === "done")) {
    c.sink.consumed = true;
    const dup = await duplicate(c, row);
    if (dup) return { ...dup, consumed: true };
    return { request: out, frozen, consumed: true };
  }
  // 2. The explicitly bound continuation: reading the logs the approved request just asked for (#4).
  if (!exact && row.state === "done" && method === "GET" && frozen.path === LOGS_READ_PATH && row.path === LOGS_REQUEST_PATH) {
    await continuation(c, row);
    return { request: out, frozen };
  }
  // 3. Claim it: an email approval (live address check), or a pending/approved intent for a request a fresh TRUSTED authenticator
  //    authorizes on its own (the claim then records the operation, so its exact retry is answered by step 1). `stepped` is the
  //    trusted-factor check only: the first-purchase bootstrap is its own, separately constrained purchase authority, checked by the
  //    purchase handlers themselves, and is never promoted into an approval (Astra STEPUP-EMAIL-3 #1).
  if (exact && (row.state === "approved" || row.state === "pending")) {
    const byFactor = await opts.stepped(out);
    if (row.state === "approved" || byFactor) {
      const r = await claim(c, row, byFactor ? "factor" : "email");
      if (r) return r;
    }
  }
  // 4. The approved request resent with ONLY its disclosure token changed (the page fetched a fresh one after confirmation; Astra
  //    STEPUP-EMAIL-9 #1). It is not the approved request, so it runs nothing; but the approval is kept, so the client can resend the EXACT
  //    approved request, token included: 403 stepup_request_changed, changed:"disclosure_token". Bounded (MAX_TOKEN_MISMATCHES per intent),
  //    so the reference cannot be probed forever; past that, and for any other change, the rule below applies.
  if (!exact && (row.state === "approved" || row.state === "pending") && row.method === method && row.path === frozen.path
    && frozen.tokenFreeHash && row.token_free_hash === frozen.tokenFreeHash) {
    const kept = await env.DB.prepare(`UPDATE cloud_stepup_intents SET token_mismatches=token_mismatches+1 WHERE id=? AND user_id=? AND session_id=?
      AND state IN ('pending','approved') AND expires_at>? AND token_mismatches<?`).bind(named, c.userId, c.sessionId, c.now, MAX_TOKEN_MISMATCHES).run();
    if (kept.meta.changes === 1) throw new HTTPError(403, "stepup_request_changed", { changed: "disclosure_token" });
  }
  // Anything else carries no authority. The named intent, if it is this account's and this session's and not yet used, is invalidated
  // (a stale or mismatched reference never stays usable), and the request goes on unproved: the gate (or handler) refuses it with a
  // FRESH intent for exactly this request.
  await invalidate(c, named);
  return { request: out, frozen };
}

interface Ctx {
  env: Env; identity: Identity; out: Request; frozen: Frozen; userId: string; sessionId: string; now: number; grantMs: number;
  spec: TargetSpec; stepped: (request: Request) => Promise<boolean>; sink: { consumed?: boolean };
}
const loadIntent = (c: Ctx, id: string) => c.env.DB.prepare("SELECT * FROM cloud_stepup_intents WHERE id=? AND user_id=? AND session_id=?")
  .bind(id, c.userId, c.sessionId).first<IntentRow>();
const invalidate = (c: Ctx, id: string) => c.env.DB.prepare("DELETE FROM cloud_stepup_intents WHERE id=? AND user_id=? AND session_id=? AND state IN ('pending','approved')")
  .bind(id, c.userId, c.sessionId).run();

/** Live: the same user, a session Supabase still honours (401 otherwise), and the address and generation the approval was bound to. */
async function liveMatches(c: Ctx, row: IntentRow): Promise<boolean> {
  const supa = await c.identity.supabaseUser(c.out, c.env);
  if (!supa.updatedAt) throw new HTTPError(503, "identity_unavailable");
  return row.email === supa.email && row.email_gen === supa.updatedAt;
}

/** The target still is the frozen one, or the one the operation's OWN reservation left it at (reserved_target; Astra STEPUP-EMAIL-4 #4). */
const targetHolds = (c: Ctx, alias = "") => ({ sql: `(${alias}target=${c.spec.sql} OR ${alias}reserved_target=${c.spec.sql})`, binds: [...c.spec.binds, ...c.spec.binds] });
/** The proof this request carries once it holds the claim: its pinned home (and Flux lifecycle) as the claiming statement saw the target,
 *  and the D1 re-validation every repeated check runs (still this request's claim; the target unchanged, or moved only by the operation's
 *  own reservation, until its commitment). */
function proofFor(c: Ctx, row: IntentRow, token: string, pinned: string) {
  const holds = targetHolds(c);
  return { intentId: row.id, homeId: c.spec.kind === "home" || c.spec.kind === "billing" ? homeOf(c.spec, pinned) : null, logsCommand: null,
    fluxLifecycle: c.spec.kind === "flux" ? targetAt<number>(pinned, 4, "number") : null,
    revalidate: async () => (await c.env.DB.prepare(`SELECT 1 AS x FROM cloud_stepup_intents WHERE id=? AND exec_token=? AND state='executing'
      AND (phase='committed' OR ${holds.sql})`).bind(row.id, token, ...holds.binds).first()) !== null };
}

/** The lease a claim takes: free, or held by `previous` (the superseded runner of this same operation, past its execution lease). */
function leaseFree(c: Ctx, kind: "billing" | "flux" | null, home: string | null, previous: string | null): { sql: string; binds: unknown[] } {
  if (!kind || !home) return { sql: "1", binds: [] };
  if (kind === "flux") return fluxLeaseFree(home, c.now, previous);
  return homeLeaseFree(home, previous);
}
/** Releases the lease an operation's claim took (by its own holder only: never anybody else's). */
function leaseRelease(env: Env, row: { lease_kind: string | null; lease_home: string | null; lease_holder: string | null }): D1PreparedStatement[] {
  if (!row.lease_home || !row.lease_holder) return [];
  if (row.lease_kind === "flux") return [releaseFluxLeaseStatement(env, row.lease_home, row.lease_holder)];
  if (row.lease_kind === "billing") return [releaseHomeLeaseOf(env.DB, row.lease_home, row.lease_holder)];
  return [];
}

/** THE claim (Astra STEPUP-EMAIL-3 #2), ONE D1 batch: the request fingerprint, session, grant and (email) live address must match, the
 *  frozen target re-computed in SQL must equal the persisted one (its pinned versions) and the handler's lease must be free; then the
 *  approval is consumed, the operation record is created (executing, phase 'claimed', its fencing token, its lease) and the lease is
 *  acquired for that record's holder, all or nothing. The handler then runs as that holder. A busy lease consumes nothing; a moved
 *  target voids the approval. `takeover`: the resumption of an interrupted operation (only before its commitment). */
async function claim(c: Ctx, row: IntentRow, via: "email" | "factor", takeover?: { token: string; holder: string | null }): Promise<Prepared | null> {
  if (via === "email" && !await liveMatches(c, row)) return null;
  const db = c.env.DB;
  const token = crypto.randomUUID();
  const holder = `stepup-${token}`;
  const home = c.spec.lease ? homeOf(c.spec, row.target) : null;
  const leaseKind = home ? c.spec.lease : null;
  const free = leaseFree(c, leaseKind, home, takeover?.holder ?? null);
  const state = takeover
    ? "state='executing' AND exec_token=? AND exec_until<=? AND phase IN ('claimed','dispatched') AND (grant_expires_at IS NULL OR grant_expires_at>?)"
    : via === "email" ? "state='approved' AND grant_expires_at>?" : "state IN ('pending','approved')";
  const stateBinds = takeover ? [takeover.token, c.now, c.now] : via === "email" ? [c.now] : [];
  const mine = { sql: "EXISTS (SELECT 1 FROM cloud_stepup_intents WHERE id=? AND exec_token=?)", binds: [row.id, token] as unknown[] };
  const lease: D1PreparedStatement[] = leaseKind === "flux" ? fluxClaimLeaseStatements(c.env, home!, holder, c.now, mine)
    : leaseKind === "billing" ? [
      ...claimHomeLeaseStatements(db, home!, holder, mine),
      db.prepare("UPDATE cloud_stepup_intents SET lease_generation=(SELECT generation FROM billing_home_leases WHERE home_id=? AND holder=?) WHERE id=? AND exec_token=?")
        .bind(home, holder, row.id, token),
    ] : [];
  // The frozen target, or (a resumption) the one this operation's own reservation left it at; RETURNING the target as it is now: what the
  // handler pins (its home, its Flux lifecycle).
  const holds = targetHolds(c);
  const [won] = await db.batch<{ id: string; pinned: string }>([
    db.prepare(`UPDATE cloud_stepup_intents SET state='executing', phase=COALESCE(phase,'claimed'), op_kind=?, claimed_at=?, exec_token=?, exec_until=?,
        lease_kind=?, lease_home=?, lease_holder=?, lease_generation=NULL,
        grant_expires_at=COALESCE(grant_expires_at, ?), expires_at=MAX(expires_at, COALESCE(grant_expires_at, ?))
      WHERE id=? AND user_id=? AND session_id=? AND method=? AND path=? AND params_hash=? AND ${state}
        AND ${holds.sql} AND ${free.sql} RETURNING id, ${c.spec.sql} AS pinned`)
      .bind(c.spec.op, c.now, token, c.now + EXEC_LEASE_MS, leaseKind, leaseKind ? home : null, leaseKind ? holder : null, c.now + c.grantMs,
        c.now + c.grantMs, row.id, c.userId, c.sessionId, c.frozen.method, c.frozen.path, c.frozen.paramsHash, ...stateBinds, ...holds.binds, ...free.binds,
        ...c.spec.binds),
    ...lease,
    db.prepare(`INSERT INTO cloud_stepup_events (id,user_id,session_id,kind,intent_id,challenge_id,at) SELECT ?,?,?,'claimed',?,NULL,? WHERE ${mine.sql}`)
      .bind(crypto.randomUUID(), c.userId, c.sessionId, row.id, c.now, ...mine.binds),
  ]);
  if (won.results.length === 1) {
    // Consumed from this moment (#5): every answer of this request, an error included, says so until a confirmed release says otherwise.
    c.sink.consumed = true;
    const generation = leaseKind === "billing"
      ? (await db.prepare("SELECT lease_generation AS g FROM cloud_stepup_intents WHERE id=? AND exec_token=?").bind(row.id, token).first<{ g: number | null }>())?.g ?? null
      : null;
    const pinned = won.results[0].pinned;
    const op: StepUpOp = { intentId: row.id, token, db, target: { sql: c.spec.sql, binds: c.spec.binds }, pinned, reserveOwn: c.spec.reserveOwn === true,
      linkRevision: c.spec.kind === "flux_link" ? targetAt<number>(pinned, 1, "number") : undefined,
      lease: leaseKind === "flux" ? { kind: "flux", homeId: home!, holder } : leaseKind === "billing" && generation !== null ? { kind: "billing", homeId: home!, holder, generation } : null };
    markStepUpProof(c.out, proofFor(c, row, token, pinned));
    console.log(JSON.stringify({ message: takeover ? "step-up operation resumed" : "step-up approval claimed", path: c.frozen.path, via }));
    return { request: c.out, frozen: c.frozen, consumed: true,
      claimed: { id: row.id, token, secret: row.secret === 1, explicit: c.spec.explicit, op } };
  }
  // Why not: lost to a concurrent claim (answered as a duplicate), a busy lease (nothing consumed: retry), or a moved target (the
  // approval is superseded: refused with a fresh intent).
  const whyHolds = targetHolds(c, "i.");
  const why = await db.prepare(`SELECT i.*, (${whyHolds.sql}) AS same, (${free.sql}) AS free FROM cloud_stepup_intents i WHERE i.id=? AND i.user_id=? AND i.session_id=?`)
    .bind(...whyHolds.binds, ...free.binds, row.id, c.userId, c.sessionId).first<IntentRow & { same: number; free: number }>();
  if (!why) return null;
  if (why.state === "done" || (why.state === "executing" && why.exec_token !== (takeover?.token ?? null))) return duplicate(c, why);
  // A busy lease: an approval never claimed consumes nothing (unmarked: retry). A resumption of an operation that already consumed its
  // approval (e.g. the sweep holds the lease) is still consumed, and says so (Astra STEPUP-EMAIL-4 #6).
  if (why.same === 1 && why.free !== 1) {
    const busy = errorResponse(409, "home_busy");
    if (takeover) c.sink.consumed = true;
    return { request: c.out, frozen: c.frozen, replay: takeover ? consumed(busy) : busy };
  }
  if (takeover) {
    // The interrupted operation's target moved: nothing of it happened ('claimed') voids it; a dispatch that may have reached a provider
    // closes it as completed with an unknown answer (never re-run, never disclosed).
    await db.batch([
      db.prepare("DELETE FROM cloud_stepup_intents WHERE id=? AND exec_token=? AND phase='claimed'").bind(row.id, takeover.token),
      db.prepare("UPDATE cloud_stepup_intents SET state='done', done_at=?, exec_until=NULL, response_status=NULL WHERE id=? AND exec_token=? AND phase<>'claimed'")
        .bind(c.now, row.id, takeover.token),
      ...leaseRelease(c.env, why),
    ]);
  }
  return null;
}

/** A duplicate of the named operation: running (409), completed (its minimal replay record), or interrupted past its execution lease,
 *  reconciled BY PHASE (#4): committed (or delivered) means the operation happened, closed with an unknown answer and never re-run (an
 *  undelivered secret is compensated by the sweep); claimed or dispatched resumes under the same operation identity, with the same
 *  checks as a claim (live identity, target, lease). Null: no longer answerable (the record expired with its grant). */
async function duplicate(c: Ctx, row: IntentRow): Promise<Prepared | null> {
  const answer = (replay: Response): Prepared => ({ request: c.out, frozen: c.frozen, replay });
  if (row.state === "done") return row.expires_at > c.now ? answer(replayOf(row)) : null;
  if ((row.exec_until ?? 0) > c.now) return answer(consumed(errorResponse(409, "action_in_progress", { operation: { id: row.id } })));
  if (row.phase === "committed" || row.phase === "delivered") {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE cloud_stepup_intents SET state='done', done_at=?, exec_until=NULL, response_status=NULL WHERE id=? AND state='executing' AND exec_token=?")
        .bind(c.now, row.id, row.exec_token),
      ...leaseRelease(c.env, row),
    ]);
    const fresh = await loadIntent(c, row.id);
    return fresh && fresh.state === "done" ? answer(replayOf(fresh)) : answer(consumed(errorResponse(409, "action_in_progress", { operation: { id: row.id } })));
  }
  const via = row.approved_at !== null ? "email" : "factor";
  if (via === "factor" && !await c.stepped(c.out)) return null;
  return claim(c, row, via, { token: row.exec_token ?? "", holder: row.lease_holder });
}

/** GET logs after POST logs/request: bound to the collection that request made (that home, at that generation, that collect_logs
 *  command), while that home is still the member's current one, in the same session and address, and only until the ORIGINAL grant
 *  deadline. Anything else proves nothing (the gate refuses it with a fresh intent). */
async function continuation(c: Ctx, row: IntentRow): Promise<void> {
  if (!row.continuation_command || !row.continuation_home || (row.grant_expires_at ?? 0) <= c.now) return;
  if (!await liveMatches(c, row)) return;
  const check = async () => (await c.env.DB.prepare(`SELECT 1 AS x FROM cloud_stepup_intents i
      JOIN cloud_home_commands k ON k.id=i.continuation_command AND k.home_id=i.continuation_home AND k.generation=i.continuation_generation AND k.kind='collect_logs'
      JOIN cloud_homes h ON h.id=i.continuation_home AND h.generation=i.continuation_generation
    WHERE i.id=? AND i.state='done' AND i.grant_expires_at>? AND i.continuation_home=(${CURRENT_HOME})`)
    .bind(row.id, c.identity.now(), c.userId).first()) !== null;
  if (!await check()) return;
  markStepUpProof(c.out, { intentId: row.id, homeId: row.continuation_home, logsCommand: row.continuation_command, revalidate: check });
}

// ---- execution: the journal, the phases, the finalization -------------------------------------------------------------------------

const WRITE_RE = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i;
const TABLE_RE = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?(\w+)/i;
/** Bookkeeping, never the operation's effect: leases (billing_home_leases, and the Flux home lease columns and key-row seeding on
 *  flux_home_keys), write guards, rate limits, audit, alerts and this module's own tables. */
const BOOKKEEPING = /^(?:cloud_stepup_\w+|cloud_write_guards|billing_home_leases|cloud_leases|\w*_limits|\w*_audit|cloud_alerts)$/;
const FLUX_LEASE_RE = /^\s*(?:UPDATE\s+flux_home_keys\s+SET\s+op_(?:holder|lease_until)\s*=|INSERT\s+OR\s+IGNORE\s+INTO\s+flux_home_keys\b)/i;
const isEffect = (sql: string) => {
  if (!WRITE_RE.test(sql) || FLUX_LEASE_RE.test(sql)) return false;
  const m = TABLE_RE.exec(sql);
  return m ? !BOOKKEEPING.test(m[1]) : true;
};

/** The handler's D1 binding while it runs a claimed operation (it carries the operation, step-up-op.ts). Every write transaction to an
 *  operation table is fenced by the claim's token (a guard row under cloud_write_guards' CHECK(ok=1): once a reconciling retry took the
 *  operation over, the stale runner's writes roll back whole). Unless the operation marks its own phases (`explicit`), its first durable
 *  write is its COMMITMENT, marked in the same transaction ('committed'); a write transaction that changed nothing puts the phase back. */
export function journalD1(db: D1Database, op: StepUpOp, explicit: boolean): D1Database {
  const sqlOf = new WeakMap<object, string>();
  const real = new WeakMap<object, D1PreparedStatement>();
  const mineSql = "id=? AND exec_token=? AND state='executing'";
  const guard = (g: string) => db.prepare("INSERT INTO cloud_write_guards VALUES (?,(SELECT COUNT(*) FROM cloud_stepup_intents WHERE id=? AND exec_token=? AND state='executing'))")
    .bind(g, op.intentId, op.token);
  const unguard = (g: string) => db.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(g);
  const commit = (cond: string) => db.prepare(`UPDATE cloud_stepup_intents SET phase='committed' WHERE ${mineSql} AND phase IN ('claimed','dispatched')${cond} RETURNING phase`)
    .bind(op.intentId, op.token);
  const phaseNow = async () => (await db.prepare(`SELECT phase FROM cloud_stepup_intents WHERE ${mineSql}`).bind(op.intentId, op.token).first<{ phase: string }>())?.phase ?? null;
  // OWN RESERVATIONS (op.reserveOwn; Astra STEPUP-EMAIL-5 #1, #3): each write transaction of the operation applies only while its target
  // still holds (the frozen one, or as this operation's own earlier writes left it; anything once committed), and records, in that SAME
  // transaction, the target as the write left it. A resumption after a crash anywhere in between therefore recognises exactly its own
  // changes (the claim accepts reserved_target), and a write that meets somebody else's change rolls back whole: 403 step_up_required.
  const T = explicit && op.reserveOwn && op.target ? op.target : null;
  const holdsSql = T ? `(phase='committed' OR target IS (${T.sql}) OR reserved_target IS (${T.sql}))` : "";
  const pre = (g: string): D1PreparedStatement[] => T ? [guard(g), db.prepare(`INSERT INTO cloud_write_guards VALUES (?,(SELECT COUNT(*) FROM cloud_stepup_intents
      WHERE ${mineSql} AND ${holdsSql}))`).bind(`${g}-hold`, op.intentId, op.token, ...T.binds, ...T.binds)] : [guard(g)];
  const post = (g: string): D1PreparedStatement[] => T ? [db.prepare(`UPDATE cloud_stepup_intents SET reserved_target=(${T.sql}) WHERE ${mineSql}
      AND phase IN ('claimed','dispatched')`).bind(...T.binds, op.intentId, op.token), db.prepare("DELETE FROM cloud_write_guards WHERE id IN (?,?)").bind(g, `${g}-hold`)]
    : [unguard(g)];
  /** An explicit transaction: a failure that met a moved target is the step-up refusal (the approval is void), anything else as it was. */
  const explicitBatch = async (stmts: D1PreparedStatement[]): Promise<D1Result[]> => {
    const g = `su-${crypto.randomUUID()}`;
    const head = pre(g).length;
    try { return (await db.batch([...pre(g), ...stmts, ...post(g)])).slice(head, head + stmts.length); }
    catch (e) {
      if (T && await db.prepare(`SELECT 1 AS x FROM cloud_stepup_intents WHERE ${mineSql} AND NOT ${holdsSql}`)
        .bind(op.intentId, op.token, ...T.binds, ...T.binds).first() !== null) throw new HTTPError(403, "step_up_required");
      throw e;
    }
  };
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if ((prop === "run" || prop === "all" || prop === "first") && isEffect(sql)) {
          return async (column?: string) => {
            const g = `su-${crypto.randomUUID()}`;
            const [res] = explicit ? await explicitBatch([target]) : (await db.batch([guard(g), target, commit(" AND changes()>0"), unguard(g)])).slice(1);
            if (prop !== "first") return res;
            const first = (res.results ?? [])[0] as Record<string, unknown> | undefined;
            return first === undefined ? null : column === undefined ? first : first[column];
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    real.set(proxy, stmt);
    sqlOf.set(proxy, sql);
    return proxy;
  };
  const journal = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const effect = statements.map((s) => isEffect(sqlOf.get(s) ?? ""));
          const plain = statements.map((s) => real.get(s) ?? s);
          if (!effect.some(Boolean)) return target.batch(plain);
          if (explicit) return explicitBatch(plain);
          const g = `su-${crypto.randomUUID()}`;
          const before = await phaseNow();
          const all = await target.batch([guard(g), ...plain, commit(""), unguard(g)]);
          const results = all.slice(1, 1 + plain.length);
          // This batch committed nothing after all: the phase it marked goes back (only if it was this batch that marked it).
          if ((all[1 + plain.length].results ?? []).length === 1 && before !== "committed" && !results.some((r, i) => effect[i] && (r.meta.changes ?? 0) > 0)) {
            await target.prepare(`UPDATE cloud_stepup_intents SET phase=? WHERE ${mineSql} AND phase='committed'`).bind(before, op.intentId, op.token).run();
          }
          return results;
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  bindStepUpOp(journal, op);
  return journal;
}

const REF_KEYS = ["requestId", "commandId", "resetId", "holdId", "quoteId", "homeId"] as const;
/** From a NON-secret JSON answer only: its error code and one operation id. Never anything else of the body. */
async function minimalOf(res: Response, secret: boolean): Promise<{ code: string | null; ref: string | null; commandId: string | null }> {
  const none = { code: null, ref: null, commandId: null };
  let v: unknown;
  try {
    const text = await res.clone().text();
    if (text.length > 65_536) return none;
    v = JSON.parse(text);
  } catch { return none; }
  if (!v || typeof v !== "object") return none;
  const o = v as Record<string, unknown>;
  const code = typeof o.error === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(o.error) ? o.error : null;
  if (secret) return { ...none, code };
  const key = REF_KEYS.find((k) => typeof o[k] === "string" && /^[\w-]{1,128}$/.test(o[k] as string));
  return { code, ref: key ? `${key}:${o[key] as string}` : null, commandId: typeof o.commandId === "string" && /^[\w-]{1,128}$/.test(o.commandId) ? o.commandId : null };
}

/** Runs the claimed operation on the journaled binding, as its lease holder, and records the outcome BY PHASE (#3, #4, #5). Nothing is
 *  disclosed unless the token-fenced finalization changed exactly this operation's row: a runner whose token was superseded (a
 *  reconciling retry took the operation over) answers only 409 action_in_progress, never its response. Never a body is stored. A refusal
 *  before anything happened ('claimed') releases the approval for an exact retry; an uncertain failure before commitment stays
 *  resumable; a committed operation is completed (its minimal replay record); an undelivered committed secret is left 'committed' for
 *  the sweep's compensation. */
export async function recordOutcome(env: Env, prepared: Prepared, now: () => number, run: (env: Env) => Promise<Response>): Promise<Response> {
  const { id, token, secret, explicit, op } = prepared.claimed!;
  prepared.consumed = true;
  const db = env.DB;
  const mine = "id=? AND exec_token=? AND state='executing'";
  const lease = { lease_kind: op.lease?.kind ?? null, lease_home: op.lease?.homeId ?? null, lease_holder: op.lease?.holder ?? null };
  const supersededAnswer = () => {
    console.log(JSON.stringify({ message: "step-up runner superseded", path: prepared.frozen?.path ?? null }));
    return consumed(errorResponse(409, "action_in_progress", { operation: { id } }));
  };
  /** The token-fenced finalization: true only when it changed exactly this operation's row (the lease goes with it). */
  const finalize = async (status: number | null, code: string | null, ref: string | null, commandId: string | null, delivered: boolean) => {
    const [fin] = await db.batch([
      db.prepare(`UPDATE cloud_stepup_intents SET state='done', done_at=?, exec_until=NULL, response_status=?, response_code=?, response_ref=?,
          phase=CASE WHEN ? THEN 'delivered' ELSE phase END,
          continuation_home=(SELECT home_id FROM cloud_home_commands WHERE id=? AND kind='collect_logs'),
          continuation_generation=(SELECT generation FROM cloud_home_commands WHERE id=? AND kind='collect_logs'),
          continuation_command=(SELECT id FROM cloud_home_commands WHERE id=? AND kind='collect_logs') WHERE ${mine}`)
        .bind(now(), status, code, ref, delivered ? 1 : 0, commandId, commandId, commandId, id, token),
      ...leaseRelease(env, lease),
    ]);
    return fin.meta.changes === 1;
  };
  /** Not finished, nothing committed: an exact retry resumes it at once under the same operation identity. */
  const resumable = () => db.batch([db.prepare(`UPDATE cloud_stepup_intents SET exec_until=? WHERE ${mine}`).bind(now(), id, token), ...leaseRelease(env, lease)]);
  let res: Response | null = null;
  let thrown: unknown = null;
  try { res = await run({ ...env, DB: journalD1(db, op, explicit) } as Env); } catch (e) { thrown = e; }
  // The operation's phase, read under this runner's token: null means it was taken over (or is gone). This read failing is an error
  // after the claim: the outer handler still marks the answer consumed (prepared.consumed is already set).
  const phase = (await db.prepare(`SELECT phase, state FROM cloud_stepup_intents WHERE ${mine}`).bind(id, token).first<{ phase: string }>())?.phase ?? null;
  if (phase === null) return supersededAnswer();
  if (thrown instanceof HTTPError && thrown.status === 403 && thrown.code === "step_up_required") {
    // A repeated check found the target moved under the request: the approval is void; the serializer answers with a fresh intent.
    if (phase === "claimed") await db.batch([db.prepare(`DELETE FROM cloud_stepup_intents WHERE ${mine}`).bind(id, token), ...leaseRelease(env, lease)]);
    else await finalize(403, "step_up_required", null, null, false);
    throw thrown;
  }
  if (thrown && !(thrown instanceof HTTPError)) {
    await (phase === "committed" ? finalize(null, null, null, null, false) : resumable()).catch(() => undefined);
    throw thrown;
  }
  if (thrown instanceof HTTPError) res = errorResponse(thrown.status, thrown.code, thrown.extra);
  const answer = res!;
  if (answer.status >= 400 && phase === "claimed") {
    if (answer.status < 500) {
      // Proven no-effect refusal (nothing dispatched, nothing committed): the approval stays claimable for an exact retry within its grant.
      const [released] = await db.batch([
        db.prepare(`UPDATE cloud_stepup_intents SET state=CASE WHEN approved_at IS NULL THEN 'pending' ELSE 'approved' END, phase=NULL,
            grant_expires_at=CASE WHEN approved_at IS NULL THEN NULL ELSE grant_expires_at END, exec_token=NULL, exec_until=NULL, claimed_at=NULL,
            lease_kind=NULL, lease_home=NULL, lease_holder=NULL, lease_generation=NULL, dispatch_ref=NULL
          WHERE ${mine} AND phase='claimed'`).bind(id, token),
        ...leaseRelease(env, lease),
      ]);
      if (released.meta.changes !== 1) return supersededAnswer();
      prepared.consumed = false;
      return answer;
    }
    await resumable();
    return consumed(answer);
  }
  // A dispatch whose provider call failed transiently (5xx) and committed nothing: resumable under the same operation identity.
  if (answer.status >= 500 && phase === "dispatched") {
    await resumable();
    return consumed(answer);
  }
  const m = await minimalOf(answer, secret);
  const continuation = prepared.frozen?.path === LOGS_REQUEST_PATH && answer.status >= 200 && answer.status < 300 ? m.commandId : null;
  const ok = answer.status >= 200 && answer.status < 300;
  if (!await finalize(answer.status, m.code, m.ref, continuation, ok)) return supersededAnswer();
  return consumed(answer);
}

// ---- send and verify ---------------------------------------------------------------------------------------------------------------

export interface StepUpEmailDependencies { emailSender?: (env: Env) => TransactionalEmailSender }

async function live(request: Request, env: Env, identity: Identity) {
  const s = await identity.customer(request);
  const config = identity.config(env);
  if (!s || !config || !s.supabase.sessionId) throw new HTTPError(401, "unauthorized");
  const supa = await identity.supabaseUser(request, env);
  // The address generation binds the code and the approval; without it nothing can be bound: fail closed.
  if (!supa.updatedAt) throw new HTTPError(503, "identity_unavailable");
  return { userId: s.user.id, sessionId: s.supabase.sessionId, config, email: supa.email, gen: supa.updatedAt, now: identity.now() };
}

/** Plain words for the action a code approves (the email says what it is for). */
function actionWords(method: string, path: string): string {
  if (isPurchaseRoute(method, path)) return "a payment for your Murage Cloud plan";
  if (path === "/v1/billing/portal") return "opening your billing settings";
  if (path === "/v1/account/topup") return "a change to your automatic top-up";
  if (path === "/v1/account/plan") return "a change to your plan";
  if (path.startsWith("/v1/account/export")) return "a copy of your data";
  if (path.startsWith("/v1/account/home/logs")) return "reading your Cloud logs";
  if (path.startsWith("/v1/account/home/reset")) return "resetting your Cloud";
  if (path === "/v1/account/home/hold") return "a protected change to your Cloud";
  if (path.endsWith("/desktop-code")) return "connecting a desktop to your Cloud";
  if (DOOR_ROUTE.test(path)) return "opening your Murage home";
  if (DEVICE_REVOKE_ROUTE.test(path)) return "removing a device from your Murage home";
  if (path.endsWith("/keep")) return "keeping your plan";
  if (path.includes("/flux")) return "a change to your Flux credits";
  return "a protected action on your account";
}

async function sendCode(request: Request, env: Env, identity: Identity, deps: StepUpEmailDependencies): Promise<Response> {
  const parsed = sendSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const l = await live(request, env, identity);
  const intent = await env.DB.prepare("SELECT method,path FROM cloud_stepup_intents WHERE id=? AND user_id=? AND session_id=? AND state='pending' AND expires_at>?")
    .bind(parsed.data.intentId, l.userId, l.sessionId, l.now).first<{ method: string; path: string }>();
  if (!intent) throw new HTTPError(403, "intent_refused");
  const challengeId = randomId("sc_");
  const code = sixDigits();
  const hash = await codeHash(env.BETTER_AUTH_SECRET, { issuer: l.config.issuer, userId: l.userId, sessionId: l.sessionId, email: l.email, gen: l.gen,
    intentId: parsed.data.intentId, challengeId, code });
  // ONE transaction: the account-wide reservation (fewer than five in 24 h and none in the last 30 s, decided inside the INSERT, so two
  // concurrent sends cannot both pass), then this session's challenge, written only when the reservation took (changes()=1). A resend
  // replaces this session's previous challenge (its code stops working); other sessions' challenges are untouched.
  const [reserved] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO cloud_stepup_events (id,user_id,session_id,kind,intent_id,challenge_id,at) SELECT ?,?,?,'code_reserved',?,?,?
      WHERE (SELECT COUNT(*) FROM cloud_stepup_events WHERE user_id=? AND kind='code_reserved' AND at>?) < ?
        AND NOT EXISTS (SELECT 1 FROM cloud_stepup_events WHERE user_id=? AND kind='code_reserved' AND at>?)`)
      .bind(crypto.randomUUID(), l.userId, l.sessionId, parsed.data.intentId, challengeId, l.now, l.userId, l.now - DAY_MS, SENDS_PER_DAY,
        l.userId, l.now - SEND_GAP_MS),
    env.DB.prepare(`INSERT INTO cloud_stepup_challenges (user_id,session_id,challenge_id,intent_id,code_hash,email,email_gen,attempts,delivered,
        created_at,expires_at) SELECT ?,?,?,?,?,?,?,0,0,?,? WHERE changes()=1
      ON CONFLICT(user_id,session_id) DO UPDATE SET challenge_id=excluded.challenge_id,intent_id=excluded.intent_id,code_hash=excluded.code_hash,
        email=excluded.email,email_gen=excluded.email_gen,attempts=0,delivered=0,created_at=excluded.created_at,expires_at=excluded.expires_at`)
      .bind(l.userId, l.sessionId, challengeId, parsed.data.intentId, hash, l.email, l.gen, l.now, l.now + CODE_TTL_SECONDS * 1000),
  ]);
  if (reserved.meta.changes !== 1) {
    const recent = (await env.DB.prepare("SELECT at FROM cloud_stepup_events WHERE user_id=? AND kind='code_reserved' AND at>? ORDER BY at DESC LIMIT ?")
      .bind(l.userId, l.now - DAY_MS, SENDS_PER_DAY).all<{ at: number }>()).results;
    const cooldown = recent[0] ? recent[0].at + SEND_GAP_MS - l.now : 0;
    const quota = recent.length >= SENDS_PER_DAY ? recent[SENDS_PER_DAY - 1].at + DAY_MS - l.now : 0;
    return rateLimited(Math.max(cooldown, quota));
  }
  const subject = "Your Murage security code";
  const text = `${subject}\n\nSomeone signed in to your Murage Cloud account asked to approve ${actionWords(intent.method, intent.path)}.\n\n`
    + `Your code is: ${code}\n\nIt works once, for 10 minutes, and only for that one action. Nobody from Murage will ever ask you for this code.\n\n`
    + "If this was not you: do not share the code, sign in at https://murage.ai, change your password and contact support.";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  try {
    const sender = deps.emailSender?.(env) ?? senderOrFail(env);
    await sender.send({ to: l.email, from: { email: env.EMAIL_FROM, name: "Murage" }, subject, text,
      html: `<!doctype html><html><body>${text.split("\n\n").map((p) => `<p>${esc(p)}</p>`).join("")}</body></html>` });
  } catch {
    // The reservation stays spent (a failed delivery counts). Only THIS issuance's challenge is removed. Nothing about the message,
    // the address or the provider's answer is logged.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM cloud_stepup_challenges WHERE challenge_id=? AND user_id=? AND session_id=?").bind(challengeId, l.userId, l.sessionId),
      event(env, l.userId, l.sessionId, "send_failed", parsed.data.intentId, challengeId, identity.now()),
    ]);
    console.error(JSON.stringify({ message: "step-up code email failed" }));
    throw new HTTPError(503, "email_unavailable");
  }
  const delivered = await env.DB.prepare(`UPDATE cloud_stepup_challenges SET delivered=1 WHERE challenge_id=? AND user_id=? AND session_id=?
    RETURNING expires_at`).bind(challengeId, l.userId, l.sessionId).first<{ expires_at: number }>();
  if (!delivered) throw new HTTPError(403, "intent_refused");
  const after = identity.now();
  console.log(JSON.stringify({ message: "step-up code sent", path: intent.path }));
  return json({ sent: true, challengeId, digits: CODE_DIGITS, expiresAt: Math.floor(delivered.expires_at / 1000),
    expiresIn: Math.max(0, Math.ceil((delivered.expires_at - after) / 1000)), resendIn: Math.max(0, Math.ceil((l.now + SEND_GAP_MS - after) / 1000)) }, 202);
}

async function verifyCode(request: Request, env: Env, identity: Identity): Promise<Response> {
  const parsed = verifySchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const l = await live(request, env, identity);
  const { intentId: iid, challengeId, code } = parsed.data;
  const refused = async () => {
    await event(env, l.userId, l.sessionId, "code_refused", iid, challengeId, l.now).run().catch(() => undefined);
    return new HTTPError(403, "code_refused");
  };
  // A guess is spent BEFORE the comparison, atomically: at most five per issuance, however many requests race. Bound to this account,
  // this session, this challenge and this intent: another session's challenge is invisible here (the same uniform refusal).
  const ch = await env.DB.prepare(`UPDATE cloud_stepup_challenges SET attempts=attempts+1 WHERE user_id=? AND session_id=? AND challenge_id=?
      AND intent_id=? AND delivered=1 AND attempts<? AND expires_at>? RETURNING code_hash,email,email_gen`)
    .bind(l.userId, l.sessionId, challengeId, iid, MAX_GUESSES, l.now).first<{ code_hash: string; email: string; email_gen: string }>();
  if (!ch) throw await refused();
  const expected = await codeHash(env.BETTER_AUTH_SECRET, { issuer: l.config.issuer, userId: l.userId, sessionId: l.sessionId, email: l.email, gen: l.gen,
    intentId: iid, challengeId, code });
  // The address and its generation must be the ones the code was sent to (A->B->A included: the generation moved).
  if (!sameHex(expected, ch.code_hash) || ch.email !== l.email || ch.email_gen !== l.gen) throw await refused();
  // The approval lives as long as its route's window allows (the door: 300 s).
  const intentPath = await env.DB.prepare("SELECT path FROM cloud_stepup_intents WHERE id=? AND user_id=? AND session_id=?")
    .bind(iid, l.userId, l.sessionId).first<{ path: string }>();
  const ttl = grantTtlSeconds(l.config, intentPath?.path ?? "") * 1000;
  const [spent, approved] = await env.DB.batch([
    env.DB.prepare("DELETE FROM cloud_stepup_challenges WHERE challenge_id=? AND user_id=? AND session_id=? AND intent_id=? AND expires_at>?")
      .bind(challengeId, l.userId, l.sessionId, iid, l.now),
    env.DB.prepare(`UPDATE cloud_stepup_intents SET state='approved', email=?, email_gen=?, approved_at=?, grant_expires_at=?, expires_at=?
      WHERE id=? AND user_id=? AND session_id=? AND state='pending' AND expires_at>? AND changes()=1`)
      .bind(l.email, l.gen, l.now, l.now + ttl, l.now + ttl, iid, l.userId, l.sessionId, l.now),
    env.DB.prepare("INSERT INTO cloud_stepup_events (id,user_id,session_id,kind,intent_id,challenge_id,at) SELECT ?,?,?,'granted',?,?,? WHERE changes()=1")
      .bind(crypto.randomUUID(), l.userId, l.sessionId, iid, challengeId, l.now),
  ]);
  if (spent.meta.changes !== 1 || approved.meta.changes !== 1) throw await refused();
  console.log(JSON.stringify({ message: "step-up email approval granted" }));
  return json({ verified: true, intentId: iid, expiresAt: Math.floor((l.now + ttl) / 1000), expiresIn: Math.floor(ttl / 1000) });
}

export async function stepUpEmailRoute(request: Request, env: Env, identity: Identity, deps: StepUpEmailDependencies = {}): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === REQUEUE_PATH) {
    if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
    return requeueUndeliveredKey(request, env, identity.now());
  }
  if (path !== SEND_PATH && path !== VERIFY_PATH) return null;
  if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
  return path === SEND_PATH ? sendCode(request, env, identity, deps) : verifyCode(request, env, identity);
}

// ---- failed compensation: escalation and operator recovery (Astra STEPUP-EMAIL-5 #6) --------------------------------------------------

/** The operator's recovery action for an undelivered Flux key whose revocation is not confirmed (named in the alert below). */
export const REQUEUE_PATH = "/v1/admin/step-up/undelivered-keys/requeue";
/** A compensation still unconfirmed after this many failed router attempts, or this long after it was queued, is escalated. */
export const COMPENSATION_ALERT_ATTEMPTS = 3;
export const COMPENSATION_ALERT_AGE_MS = 60 * 60_000;
export const UNREVOKED_ALERT = "flux.undelivered_key_unrevoked";
const UNDELIVERED_OP = "undelivered:";

/** Operator only (CLOUD_ADMIN_TOKEN). Re-queues the revocation of the undelivered key of step-up operation `intentId`: its operation
 *  record (kept, never collected while unsettled) becomes 'compensating' if it was not yet, its journal op is queued again with its
 *  attempts and backoff reset, or re-created if it is missing; the next Flux sweep runs it at once. Idempotent; nothing is revoked
 *  here and nothing else changes. A delivered, compensated or still-running operation is 409 not_requeueable. */
async function requeueUndeliveredKey(request: Request, env: Env, now: number): Promise<Response> {
  await admin(request, env);
  const parsed = z.strictObject({ intentId }).safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const row = await env.DB.prepare("SELECT id,phase,state,exec_until,dispatch_ref FROM cloud_stepup_intents WHERE id=? AND op_kind='flux_mint'")
    .bind(parsed.data.intentId).first<{ id: string; phase: string | null; state: string; exec_until: number | null; dispatch_ref: string | null }>();
  if (!row) throw new HTTPError(404, "not_found");
  const m = /^flux:([^:]+):(\d+)$/.exec(row.dispatch_ref ?? "");
  const settledRunner = row.state === "done" || (row.exec_until ?? 0) <= now;
  if (!m || !(row.phase === "compensating" || (row.phase === "committed" && settledRunner))) throw new HTTPError(409, "not_requeueable");
  const opId = `${UNDELIVERED_OP}${row.id}`;
  const [marked] = await env.DB.batch([
    env.DB.prepare(`UPDATE cloud_stepup_intents SET phase='compensating', state='done', exec_token=NULL, exec_until=NULL, done_at=COALESCE(done_at, ?)
      WHERE id=? AND (phase='compensating' OR (phase='committed' AND (state='done' OR exec_until<=?)))`).bind(now, row.id, now),
    env.DB.prepare(`UPDATE flux_home_ops SET state='queued', attempts=0, last_error=NULL, updated_at=? WHERE op_id=?
      AND EXISTS (SELECT 1 FROM cloud_stepup_intents WHERE id=? AND phase='compensating')`).bind(now, opId, row.id),
    undeliveredKeyCompensation(env, m[1], Number(m[2]), row.id, now, { sql: `NOT EXISTS (SELECT 1 FROM flux_home_ops WHERE op_id=?)
      AND EXISTS (SELECT 1 FROM cloud_stepup_intents WHERE id=? AND phase='compensating')`, binds: [opId, row.id] }),
  ]);
  if (marked.meta.changes !== 1) throw new HTTPError(409, "not_requeueable");
  console.log(JSON.stringify({ message: "step-up undelivered Flux key revocation re-queued by the operator" }));
  return json({ requeued: true, intentId: row.id, homeId: m[1] });
}

/** Raises ONE open alert per home (cloud_alerts_open dedups it; its detail lists every stuck operation and the recovery action) for
 *  undelivered-key revocations still unconfirmed past the threshold. The compensation keeps retrying under the Flux sweep's backoff and
 *  its records are kept; the alert is resolved by the confirmed revocation (b4-flux.ts executeOp). */
async function escalateUnrevoked(env: Env, now: number): Promise<void> {
  const stuck = (await env.DB.prepare(`SELECT home_id, json_group_array(substr(op_id, ${UNDELIVERED_OP.length + 1})) AS intents, MAX(attempts) AS attempts,
      MIN(created_at) AS since FROM flux_home_ops WHERE substr(op_id, 1, ${UNDELIVERED_OP.length})=? AND state IN ('queued','running')
      AND (attempts>=? OR created_at<=?) GROUP BY home_id ORDER BY MIN(created_at) LIMIT 50`)
    .bind(UNDELIVERED_OP, COMPENSATION_ALERT_ATTEMPTS, now - COMPENSATION_ALERT_AGE_MS)
    .all<{ home_id: string; intents: string; attempts: number; since: number }>()).results;
  for (const h of stuck) {
    const detail = JSON.stringify({ intents: JSON.parse(h.intents) as string[], attempts: h.attempts, since: h.since,
      recovery: `POST ${REQUEUE_PATH} {"intentId": "<one of intents>"} once the Flux router is reachable` });
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) SELECT ?,?,?,'high',?,?
        WHERE NOT EXISTS (SELECT 1 FROM cloud_alerts WHERE home_id=? AND kind=? AND resolved_at IS NULL) ON CONFLICT DO NOTHING`)
        .bind(`${UNREVOKED_ALERT}:${h.home_id}:${now}`, h.home_id, UNREVOKED_ALERT, detail, now, h.home_id, UNREVOKED_ALERT),
      env.DB.prepare("UPDATE cloud_alerts SET detail=? WHERE home_id=? AND kind=? AND resolved_at IS NULL AND detail<>?").bind(detail, h.home_id, UNREVOKED_ALERT, detail),
    ]);
    console.error(JSON.stringify({ message: "step-up undelivered Flux key revocation unconfirmed past its threshold", attempts: h.attempts }));
  }
}

/** Cron. FIRST the compensation BY PHASE (#4): an owner Flux key whose mint committed ('committed') but was never delivered (its runner
 *  died or was superseded: the operation is closed, or its execution lease ran out) is revoked: exactly that generation, through the
 *  Flux home's own journal (b4-flux.ts), in the same batch that moves the operation to 'compensated' (only the sweep that wins it).
 *  A delivered key ('delivered') is never touched. Then expired challenges, intents a day past their expiry, events older than 30 days. */
export async function sweepStepUpEmail(env: Env, now = Date.now()): Promise<void> {
  const undelivered = (await env.DB.prepare(`SELECT id, dispatch_ref FROM cloud_stepup_intents WHERE op_kind='flux_mint' AND phase='committed'
      AND (state='done' OR (state='executing' AND exec_until<=?)) LIMIT 50`).bind(now).all<{ id: string; dispatch_ref: string | null }>()).results;
  for (const u of undelivered) {
    const m = /^flux:([^:]+):(\d+)$/.exec(u.dispatch_ref ?? "");
    const won = { sql: "changes() = 1", binds: [] as unknown[] };
    // 'compensating' until the router confirmed the revocation (b4-flux.ts executeOp records 'compensated' then): never "done" on a queue.
    await env.DB.batch([
      env.DB.prepare(`UPDATE cloud_stepup_intents SET phase=?, state='done', exec_token=NULL, exec_until=NULL, done_at=COALESCE(done_at, ?)
        WHERE id=? AND phase='committed' AND (state='done' OR (state='executing' AND exec_until<=?))`).bind(m ? "compensating" : "compensated", now, u.id, now),
      ...(m ? [undeliveredKeyCompensation(env, m[1], Number(m[2]), u.id, now, won)] : []),
    ]);
    if (m) console.log(JSON.stringify({ message: "step-up undelivered Flux key compensation queued" }));
  }
  // A compensation the router has not confirmed past the threshold is escalated (#6 of STEPUP-EMAIL-5); its records stay.
  await escalateUnrevoked(env, now);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM cloud_stepup_challenges WHERE expires_at<=?").bind(now),
    // Garbage collection only of SETTLED records (Astra STEPUP-EMAIL-4 #5): never an undelivered committed Flux key, nor one whose
    // compensation the router has not confirmed yet.
    env.DB.prepare(`DELETE FROM cloud_stepup_intents WHERE expires_at<=? AND NOT (op_kind IS 'flux_mint' AND phase IN ('committed','compensating'))`).bind(now - DAY_MS),
    env.DB.prepare("DELETE FROM cloud_stepup_events WHERE at<=?").bind(now - 30 * DAY_MS),
  ]);
}
