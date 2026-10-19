// SPDX-License-Identifier: AGPL-3.0-or-later
// The first purchase on a fresh account (TRUST-FIRST-FACTOR.md revision 4, part D; Astra TRUST-3 #2, TRUST-4 P2-1..P2-5).
//
// A brand-new member signs in with the emailed code and pays, with no authenticator yet. On an account with NOTHING TO PROTECT the three
// purchase routes (POST /v1/billing/reserve, /v1/billing/checkout, /v1/billing/checkout/resume) accept that sign-in, whatever its aal, under
// ONE purchase authorization (cloud_purchase_bootstraps, migration 0085), bound to the account, the Supabase session that reserved, the home
// reserved in the same batch, and the Stripe customer, order and session this operation itself creates. Everything else is unchanged: any
// other route, any other session, any account with something to protect answers 403 step_up_required (body step_up.bootstrap: false).
// RULE (Sean, 2026-10-12: one purchase = at most ONE emailed code): POST /v1/billing/reserve is SIGN-IN ONLY for every signed-in account
// (never step-up gated, no approval is minted for it); it only reserves a payable home. Checkout, checkout/resume and every other money
// route stay gated, and checkout's own approval pins the home. A fresh account's reserve still claims the bootstrap below.
//
//   - Reserve CLAIMS the row in the batch that inserts the home, by INSERT ... SELECT ... WHERE <protect-set empty, own home excepted>
//     (protectSetEmpty), so eligibility is decided inside the claim statement, never by an earlier read (Astra P2-1).
//   - Checkout and resume continue it only while state='open', now < issue_until, the token's session_id is the reserving one, the RESOLVED
//     home is the reserved one, and the protect-set holds only this operation's own records (matched by their stored ids). Every write that
//     publishes a binding (the Stripe customer, then each issued Stripe session) re-checks all of that in its own UPDATE, fenced by the
//     row's generation, so a stale request cannot adopt another operation's records (Astra P2-3).
//   - The worker gate (index.ts STEP_UP_ROUTES) and the handlers consult the SAME function, purchaseBootstrap, through the shared
//     billingDependencies.stepUp. It only reads: evaluating it twice never allocates or consumes anything (Astra P2-4).
//   - The paid moment consumes it, in the same batch that records the accepted payment, on every paid path (paidMomentStatements); an unpaid
//     completion marks it submitted, a parked completion parked, a rejection or failed payment closed (Astra P2-6 of round 4, "P2-4" in the
//     build brief). submitted/parked freeze new checkout authority; consumed/closed are final (triggers in 0085).
//   - Abandonment (Astra P2-5/P2-7): an open row may become 'expired' only after issue_until AND once every Stripe session it issued is
//     terminal; then ONE more generation may be claimed by compare-and-swap, only while the protect-set is still empty apart from this
//     account's own expired records (their deleted home and unpaid customer, matched by the ids kept in cloud_purchase_bootstrap_history).
//     ONE reconciliation decides it (reconcileAbandonment), for reserve and the webhook alike, under the home lease, over EVERY page of the
//     customer's Stripe sessions and every local issuance attempt; once it holds, reserve releases that generation's unused reservation at
//     once instead of waiting out the 25-hour settlement delay (Astra TRUSTCODE-2 P2-2, P2-3).
import type { ControlPlaneAuth } from "./auth";
import type { BillingDependencies } from "./b5-billing";
import type { StripeClient } from "./b5-stripe";
import { boundCustomer } from "./customer-identity";
import { HTTPError } from "./http";
import { DB_NOW, fencedBatch, q, type HomeLease, type Q } from "./billing-lease";

/** How long after the reserve new (or replacement) Stripe sessions may be issued on the sign-in alone. An issued session keeps its own lifetime. */
export const BOOTSTRAP_ISSUE_MS = 30 * 60_000;
/** A Stripe session this operation issues lives this long (b5-billing.ts CHECKOUT_SESSION_TTL_MS, the same value; not imported, to keep this
 *  module free of a runtime cycle). An issuance attempt older than this can no longer have a payable session. */
const ISSUED_SESSION_TTL_MS = 60 * 60_000;
/** Generations an account may ever claim: the first, and ONE more after an expired attempt. */
export const BOOTSTRAP_MAX_GENERATION = 2;
export const PURCHASE_ROUTES: ReadonlySet<string> = new Set(["/v1/billing/reserve", "/v1/billing/checkout", "/v1/billing/checkout/resume"]);
export const isPurchaseRoute = (method: string, path: string) => method === "POST" && PURCHASE_ROUTES.has(path);

export interface BootstrapRow {
  user_id: string; generation: number; session_id: string; home_id: string; consent_id: string | null; stripe_customer_id: string | null;
  stripe_session_id: string | null; state: string; created_at: number; issue_until: number; consumed_at: number | null; closed_reason: string | null;
}
/** A purchase route may proceed on the sign-in alone. `row` is the account's open authorization (null on a first reserve: nothing claimed yet). */
export interface BootstrapGrant { kind: "bootstrap"; userId: string; sessionId: string; row: BootstrapRow | null }
export type PurchaseAuthority = "trusted" | BootstrapGrant;

/** The 403 every refused purchase route answers (the site learns it is not on the bootstrap path). */
export const stepUpRefused = (need?: Record<string, unknown> | null) =>
  new HTTPError(403, "step_up_required", { step_up: { ...(need ?? {}), bootstrap: false } as never });
/** Astra INTEGRATED-1 #8: an expired purchase authorization is the NORMAL step-up refusal (403 step_up_required), so the worker's serializer
 *  freezes this exact request and offers the emailed code with its intent (step-up-email.ts stepUpRefusal); `bootstrap_expired` says why. The
 *  unresolved attempt and its original key are untouched: an approved retry replays them. */
export const bootstrapExpired = () => new HTTPError(403, "step_up_required", { step_up: { bootstrap: false, bootstrap_expired: true } });

/** "Nothing to protect", as ONE SQL predicate over the account's whole protect-set, so it can sit inside the statement that acts on it.
 *  `own` are the records this operation created and may find: its home (by id) and its Stripe customer (by id, on that home, unpaid). Records
 *  of this account's EXPIRED generations are excepted only as they were left: their home deleted, their customer on that home and unpaid. */
export function protectSetEmpty(userId: string, own: { homeId: string | null; customerId: string | null }): { sql: string; binds: unknown[] } {
  const expired = "SELECT home_id FROM cloud_purchase_bootstrap_history WHERE user_id=?";
  return {
    sql: `NOT EXISTS (SELECT 1 FROM cloud_homes ph WHERE ph.owner_id=? AND ph.id IS NOT ?
        AND NOT (ph.desired_state='deleted' AND ph.id IN (${expired})))
      AND NOT EXISTS (SELECT 1 FROM billing_subscriptions ps JOIN cloud_homes psh ON psh.id=ps.home_id WHERE psh.owner_id=?
        AND NOT (ps.subscription_id IS NULL AND ps.home_id IS ? AND ps.customer_id IS ?)
        AND NOT (ps.subscription_id IS NULL AND EXISTS (SELECT 1 FROM cloud_purchase_bootstrap_history px WHERE px.user_id=? AND px.home_id=ps.home_id
          AND px.stripe_customer_id=ps.customer_id)))
      AND NOT EXISTS (SELECT 1 FROM contract_links pl JOIN cloud_homes plh ON plh.id=pl.home_id WHERE plh.owner_id=?)
      AND NOT EXISTS (SELECT 1 FROM machine_owners WHERE owner_user_id=?)
      AND NOT EXISTS (SELECT 1 FROM cloud_trusted_factors WHERE user_id=?)
      AND NOT EXISTS (SELECT 1 FROM cloud_factor_trust_events WHERE user_id=? AND kind LIKE 'trusted\\_%' ESCAPE '\\')
      AND NOT EXISTS (SELECT 1 FROM checkout_retry_routes WHERE account_id=?)
      AND NOT EXISTS (SELECT 1 FROM checkout_consents pc WHERE pc.user_id=? AND (pc.acceptance_parked_at IS NOT NULL OR pc.completed_at IS NOT NULL
        OR pc.paid_at IS NOT NULL OR pc.rejected_at IS NOT NULL))`,
    binds: [userId, own.homeId, userId, userId, own.homeId, own.customerId, userId, userId, userId, userId, userId, userId, userId],
  };
}

export const getBootstrap = (env: Env, userId: string) =>
  env.DB.prepare("SELECT * FROM cloud_purchase_bootstraps WHERE user_id=?").bind(userId).first<BootstrapRow>();
const holds = async (env: Env, p: { sql: string; binds: unknown[] }) =>
  (await env.DB.prepare(`SELECT 1 AS x WHERE ${p.sql}`).bind(...p.binds).first()) !== null;

/** THE purchase-bootstrap check, shared by the worker gate and the handlers (through billingDependencies.stepUp). Read-only. Null unless:
 *  this is one of the three purchase routes, the request carries a verified Supabase session of `accountId` (when given), and
 *    - reserve: the session's own open authorization is still issuing (a retry), or the account has nothing to protect (no row yet), or its
 *      only attempt may be reclaimed (expired, or open past issue_until: the handler settles which, then claims by compare-and-swap);
 *    - checkout / resume: the row is open, from this session, for `homeId` (the resolved home; null at the worker gate, before it is
 *      resolved), and the protect-set holds only its own records. Past issue_until: 403 step_up_required (bootstrap_expired, with an email intent). */
export async function purchaseBootstrap(env: Env, request: Request, accountId: string | null, homeId: string | null, now: number): Promise<BootstrapGrant | null> {
  const path = new URL(request.url).pathname;
  if (!isPurchaseRoute(request.method, path)) return null;
  const s = await boundCustomer(request)?.resolve();
  if (!s || !s.supabase.sessionId || (accountId !== null && accountId !== s.user.id)) return null;
  const userId = s.user.id;
  const sessionId = s.supabase.sessionId;
  const row = await getBootstrap(env, userId);
  const grant = (r: BootstrapRow | null): BootstrapGrant => ({ kind: "bootstrap", userId, sessionId, row: r });
  if (path === "/v1/billing/reserve") {
    if (!row) return await holds(env, protectSetEmpty(userId, { homeId: null, customerId: null })) ? grant(null) : null;
    // A retry of the reserving session: still only while the protect-set holds nothing but this operation's own records (Astra TRUSTCODE-2 P3-4).
    if (row.state === "open" && row.issue_until > now) {
      return row.session_id === sessionId && await holds(env, protectSetEmpty(userId, { homeId: row.home_id, customerId: row.stripe_customer_id })) ? grant(row) : null;
    }
    // One more attempt, ever, after an abandoned one; the handler proves it abandoned (reconcileAbandonment) and claims atomically.
    if ((row.state === "open" || row.state === "expired") && row.generation < BOOTSTRAP_MAX_GENERATION) return grant(row);
    return null;
  }
  if (!row || row.state !== "open" || row.session_id !== sessionId || (homeId !== null && homeId !== row.home_id)) return null;
  if (row.issue_until <= now) throw bootstrapExpired();
  return await holds(env, protectSetEmpty(userId, { homeId: row.home_id, customerId: row.stripe_customer_id })) ? grant(row) : null;
}

/** For a handler of a purchase route: a trusted step-up, or the bootstrap grant for the home it resolved, or null (refuse with stepUpRefused).
 *  The trusted check is the worker's own (deps.trustedStepUp; a direct caller's deps.stepUp); the bootstrap is the same purchaseBootstrap. */
export async function purchaseAuthority(deps: BillingDependencies, env: Env, request: Request, auth: ControlPlaneAuth, accountId: string | null,
  homeId: string | null): Promise<PurchaseAuthority | null> {
  if (await (deps.trustedStepUp ?? deps.stepUp ?? (async () => false))(env, request, auth)) return "trusted";
  return deps.purchaseBootstrap ? deps.purchaseBootstrap(env, request, accountId, homeId) : null;
}

/** Issuance of `homeId` that is not settled locally: a checkout still being created (its session may exist or appear) within the lifetime its
 *  session would have, a published session not yet past its expiry, or a resume attempt not finished (a replay of it would issue a session). */
function unresolvedIssuance(homeId: string, now: number): { sql: string; binds: unknown[] } {
  return {
    sql: `(EXISTS (SELECT 1 FROM open_checkouts WHERE home_id=? AND ((state='creating' AND updated_at>?) OR (state='open' AND COALESCE(expires_at,0)>?)))
      OR EXISTS (SELECT 1 FROM checkout_resume_attempts WHERE home_id=? AND state='creating' AND expires_at>?))`,
    binds: [homeId, now - ISSUED_SESSION_TTL_MS, now, homeId, now],
  };
}

/** THE abandonment reconciliation (Astra TRUSTCODE-2 P2-2), used by BOTH the reserve path and the checkout.session.expired webhook, and only
 *  under the home's billing lease (`lease`, for `row.home_id`), so it is serialized with every issuance (checkout and resume hold that lease).
 *  True only when the row is expired (now, or already) AND every Stripe session ever issued for its customer is terminal ('expired'; ALL
 *  pages, never the first 20 alone) AND no issuance attempt of its home is unresolved. An open row is moved to 'expired' (with its history row)
 *  only then, past issue_until, in one fenced batch that re-checks the local part in the statement. A listing that fails throws (StripeError):
 *  nothing is expired on a partial view. */
export async function reconcileAbandonment(env: Env, lease: HomeLease, row: BootstrapRow, now: number,
  stripe: Pick<StripeClient, "listAllCheckoutSessions">): Promise<boolean> {
  if (lease.homeId !== row.home_id) throw new Error("reconcile_needs_home_lease");
  if (row.state !== "open" && row.state !== "expired") return false;
  if (row.state === "open" && row.issue_until > now) return false;
  const open = unresolvedIssuance(row.home_id, now);
  if (await holds(env, open)) return false;
  if (row.stripe_customer_id && (await stripe.listAllCheckoutSessions(row.stripe_customer_id)).some((s) => s.status !== "expired")) return false;
  if (row.state === "expired") return true;
  const [moved] = await fencedBatch(env, lease, [
    q(`UPDATE cloud_purchase_bootstraps SET state='expired' WHERE user_id=? AND generation=? AND home_id=? AND state='open' AND issue_until<=?
      AND stripe_session_id IS ? AND stripe_customer_id IS ? AND NOT ${open.sql}`,
    row.user_id, row.generation, row.home_id, now, row.stripe_session_id, row.stripe_customer_id, ...open.binds),
    historyQ("user_id=? AND generation=?", [row.user_id, row.generation], now),
  ]);
  if (moved.meta.changes === 1) return true;
  const cur = await getBootstrap(env, row.user_id);
  return cur?.state === "expired" && cur.generation === row.generation;
}
/** The history row of an expired generation (insert-only), as one statement of the batch that expires it. */
function historyQ(where: string, binds: unknown[], now: number): Q {
  return q(`INSERT OR IGNORE INTO cloud_purchase_bootstrap_history
    (user_id,generation,session_id,home_id,consent_id,stripe_customer_id,stripe_session_id,state,created_at,issue_until,ended_at)
    SELECT user_id,generation,session_id,home_id,consent_id,stripe_customer_id,stripe_session_id,'expired',created_at,issue_until,?
    FROM cloud_purchase_bootstraps WHERE state='expired' AND ${where}`, now, ...binds);
}

/** The claim, for the reserve batch that inserts `homeId` (b3-control.ts reserveCore): inserts the open row only while the account has
 *  nothing to protect but that home; on an EXPIRED row of generation `expected` (compare-and-swap) it becomes generation expected+1. Two
 *  statements: the claim, then a guard that aborts the WHOLE batch (the home included) when the home was inserted but the claim was not. */
export function claimStatements(env: Env, i: { userId: string; sessionId: string; homeId: string; now: number; expected: number | null }): D1PreparedStatement[] {
  const free = protectSetEmpty(i.userId, { homeId: i.homeId, customerId: null });
  const generation = i.expected === null ? 1 : i.expected + 1;
  const guard = crypto.randomUUID();
  return [
    env.DB.prepare(`INSERT INTO cloud_purchase_bootstraps (user_id,generation,session_id,home_id,state,created_at,issue_until)
      SELECT ?,?,?,?,'open',?,? WHERE ? <= ${BOOTSTRAP_MAX_GENERATION}
        AND EXISTS (SELECT 1 FROM cloud_homes WHERE id=? AND owner_id=? AND desired_state='payment_pending') AND ${free.sql}
      ON CONFLICT(user_id) DO UPDATE SET generation=excluded.generation,session_id=excluded.session_id,home_id=excluded.home_id,consent_id=NULL,
        stripe_customer_id=NULL,stripe_session_id=NULL,state='open',created_at=excluded.created_at,issue_until=excluded.issue_until,consumed_at=NULL,closed_reason=NULL
      WHERE cloud_purchase_bootstraps.state='expired' AND cloud_purchase_bootstraps.generation=? AND excluded.generation=cloud_purchase_bootstraps.generation+1`)
      .bind(i.userId, generation, i.sessionId, i.homeId, i.now, i.now + BOOTSTRAP_ISSUE_MS, generation, i.homeId, i.userId, ...free.binds, i.expected ?? 0),
    // Only when the home was inserted (a waitlisted reserve inserts neither): its value is the claim's changes(), under CHECK(ok=1).
    env.DB.prepare("INSERT INTO cloud_write_guards SELECT ?, changes() WHERE EXISTS (SELECT 1 FROM cloud_homes WHERE id=?)").bind(`${guard}-bootstrap`, i.homeId),
    env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(`${guard}-bootstrap`),
  ];
}

/** The time a publication is judged at: the injected clock read NOW (tests), else null, which the statements turn into the DATABASE's time
 *  at the write (`COALESCE(?, DB_NOW)`), never the handler's pre-Stripe `now` (Astra TRUSTCODE-2 P2-1). */
export const publishClock = (deps: { now?: () => number }): number | null => deps.now ? deps.now() : null;
/** The deadline has passed, on the same clock a publication uses (`at` from publishClock). */
export async function issuancePast(env: Env, row: BootstrapRow, at: number | null): Promise<boolean> {
  return (await env.DB.prepare(`SELECT 1 AS x WHERE ? <= COALESCE(?,${DB_NOW})`).bind(row.issue_until, at).first()) !== null;
}
/** Binds the Stripe customer this checkout just created to the open row (generation-fenced, eligibility and issue_until re-checked in the
 *  statement, issue_until on the time of the write). */
export function bindCustomerQ(row: BootstrapRow, customerId: string, at: number | null): Q {
  const free = protectSetEmpty(row.user_id, { homeId: row.home_id, customerId: null });
  return q(`UPDATE cloud_purchase_bootstraps SET stripe_customer_id=? WHERE user_id=? AND generation=? AND state='open' AND session_id=? AND home_id=?
    AND stripe_customer_id IS NULL AND issue_until>COALESCE(?,${DB_NOW}) AND ${free.sql}`, customerId, row.user_id, row.generation, row.session_id, row.home_id, at, ...free.binds);
}
/** Publishes an issued Stripe session (and its order) on the open row: same fence, the stored customer must be the one it was issued for, and
 *  issue_until is judged at the time of THIS write (a session created across the deadline is never published; the caller expires it). */
export function bindSessionQ(row: BootstrapRow, i: { customerId: string; sessionId: string; consentId: string; at: number | null }): Q {
  const free = protectSetEmpty(row.user_id, { homeId: row.home_id, customerId: i.customerId });
  return q(`UPDATE cloud_purchase_bootstraps SET stripe_session_id=?,consent_id=? WHERE user_id=? AND generation=? AND state='open' AND session_id=? AND home_id=?
    AND stripe_customer_id=? AND issue_until>COALESCE(?,${DB_NOW}) AND ${free.sql}`, i.sessionId, i.consentId, row.user_id, row.generation, row.session_id, row.home_id,
  i.customerId, i.at, ...free.binds);
}

/** One lifecycle transition, matched on the immutable tuple (home, order, the order's Stripe session, the home's Stripe customer). A row of
 *  any other purchase (or none) is untouched, so the statement can join every paid / unpaid / parked / rejected batch unconditionally. */
export function bootstrapTransitionQ(to: "submitted" | "parked" | "consumed" | "closed", from: readonly string[], i: { homeId: string; consentId: string; now: number; reason?: string }): Q {
  return q(`UPDATE cloud_purchase_bootstraps SET state=?,consumed_at=CASE WHEN ?='consumed' THEN ? ELSE consumed_at END,
      closed_reason=CASE WHEN ?='closed' THEN ? ELSE closed_reason END
    WHERE home_id=? AND consent_id=? AND state IN (${from.map(() => "?").join(",")}) AND stripe_session_id IS NOT NULL
      AND stripe_session_id=(SELECT stripe_session_id FROM checkout_consents WHERE id=?)
      AND stripe_customer_id=(SELECT customer_id FROM billing_subscriptions WHERE home_id=?)`,
  to, to, i.now, to, i.reason ?? null, i.homeId, i.consentId, ...from, i.consentId, i.homeId);
}
export const PRE_PAYMENT = ["open", "submitted", "parked"] as const;
