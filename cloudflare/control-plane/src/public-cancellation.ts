// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP8: the public, no-login cancellation (312k BGB). Plan 5.2; BUILD-PLAN WP8 and C.1.
//
//   POST /v1/public/cancellation                 the declaration (type, email, name, ...): recorded with a frozen received_at and its receipt,
//                                                and answered AT ONCE with the same body for every sender; matching, Stripe and mail run after
//                                                the answer (ctx.waitUntil, then the sweep): no account oracle in the body, the time or headers
//   GET  /v1/public/cancellation/{id}/receipt    the declaration as printable HTML, the bytes stored at submission (the id is a 128-bit capability)
//   POST /v1/public/withdrawal/repudiate         "This wasn't me" for a cancellation token (registered through registerPublicHandlers)
//   POST /v1/account/cancellations/{id}/keep     "Keep my plan": signed in (sign-in only, B5), own plan; before effective_at
//   POST /v1/admin/cancellations/{id}/reason     operator: accept | reject (with the reason why) the serious reason
//   POST /v1/admin/cancellations/{id}/attribute  operator: identify the plan (attribution_basis "support")
//   POST /v1/admin/cancellations/{id}/resume     operator: a held (or already kept) declaration was found valid
//
// Rules this file keeps:
//  - Dates are frozen from received_at; matching later never moves them. effective_at is the legal end; hold_until is only the operational
//    end of "This wasn't me" and never changes it. A plan's paid months follow its billing anchor (Oct 31 -> Nov 30 -> Dec 31).
//  - Every status change is ONE conditional UPDATE ... WHERE status IN (...), in one fenced batch (the home lease) together with the token
//    consumption, the case and the mail rows (conditioned on the transition's own op id). Exactly one of hold and execution wins.
//  - A serious reason is never carried out before its decision, nor before the time it asked for. While it is checked, Stripe only pauses
//    collection (renewals become drafts, nothing is charged); it never ends the plan. A hold lifts the pause and releases those drafts.
//  - Stripe is brought in line with the intent of ALL declarations of the subscription, computed inside the home lease, through a journal of
//    mutations (own idempotency key each; an unresolved one is settled first; a cached failure is superseded under a fresh key), and only a
//    read-back makes a row synced. The sweep re-verifies open rows periodically.
//  - Mail is written to an outbox in the same batch and rendered from the committed state. One sender per delivery (claim; everything is
//    read again after the claim, and a hold link is minted only while the claim is still the sender's). A payload that carries a hold link
//    is kept for its retries, envelope-encrypted (CANCELLATION_MAIL_KEY), bound to the account's email generation (checked before every
//    send) and wiped once sent or obsolete; retries never stop; ops hears when one keeps failing.
//  - The hold link acts until hold_until (open while a reason is checked), never only 7 days; "Keep my plan" by the customer is final.
//  - Identification is the attribution: "support" or "identifier" or "account_email", never "customer reconfirmed".
import { z } from "zod";
import { accountSession, type ControlPlaneAuth } from "./auth";
import { admin } from "./b3-control";
import { attemptAnswered, attemptsOf, CancelUnconfirmed, cfg, declRevision, getSub, keepableBy, keyAnswered, markEndedQ, openDeclarationsSql, parkedSql, scheduleParked, publicResolutionQ, RESOLUTION_PRECISION_MS, withdrawInAppResolutionQ, withdrawPublicResolutionQ, STRIPE_ATTEMPT_MAX_AGE_MS,
  stubFluxHooks, syncCancellation, validationRefusal, type BillingDependencies, type OpenDeclaration } from "./b5-billing";
import { allocateCancelRef, isCancelRef } from "./cancel-reference";
import { backfillCharges, CHARGE_PRECISION_MS, CHARGE_WATCH_MS, promiseOf } from "./cancel-charges";
import { StripeError, stripeClient, type InvoiceView, type StripeClient } from "./b5-stripe";
import { stripeEndConfirmedSql, unparkQs, writeSubscription } from "./subscription-gateway";
import { planEndOf } from "./plan-end-reason";
import { fence, fencedBatch, fencedRun, HomeBusy, LeaseLost, q, withHomeLease, type HomeLease, type Q } from "./billing-lease";
import { HTTPError, errorResponse, json, readBoundedJSON, type JSONValue } from "./http";
import { senderOrFail, type TransactionalEmailSender } from "./email";
import { getConsent } from "./legal-flows";
import { advanceRefundOp, refundOpInsert, type RefundContext } from "./legal-refunds";
import { refundLine, refundState, type RefundPath, type RefundStateFields } from "./refund-kinds";
import { currentPublicHandlers, registerPublicHandlers, registerPublicRoute, type PublicRouteHandler } from "./public-routes";
import {
  commitToken, issueToken, lostCommitRefusal, readerOf, takeSlot, WHEN_CONSUMED,
  type IdentityReader, type TokenDeps, type TokenPurpose, type TokenRow,
} from "./public-tokens";
import { sellerOfConsent } from "./seller";
import {
  anchorDayOf, fmtDate, fmtReceived, fmtYmd, KIND_OF_TYPE, periodContaining, t, workingDaysAfter, type CancelKind, type Lang, type StringKey,
} from "./cancellation-strings";

export interface CancellationDeps extends TokenDeps {
  stripe?: StripeClient | null;
  mailer?: TransactionalEmailSender | null;
  /** Billing dependencies of the worker (flux hooks, notifier) for the refund operations this file opens. */
  billing?: BillingDependencies;
  siteOrigin?: string;
}
let injected: CancellationDeps = {};
/** Production wires `billing` once; tests inject fakes (stripe, reader, mailer, now). */
export const setCancellationDeps = (d: CancellationDeps) => { injected = d; };
const clockOf = (d: CancellationDeps) => (d.now ?? Date.now)();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** Working days for the reason check (plan 5.2: "within 3 working days"). */
export const REASON_CHECK_WORKING_DAYS = 3;
export const REQUESTS_PER_HOUR = 5;
/** A delivery is claimed by one sender for this long (a crashed sender's claim lapses). */
const CLAIM_MS = 5 * MINUTE;
/** Ops hears once when a delivery has failed this often; retries continue regardless. */
const MAIL_ESCALATE_AFTER = 8;
/** Open declarations are re-read against Stripe at least this often. */
const VERIFY_EVERY_MS = 6 * HOUR;
/** A new op id written by SQL itself (sweep transitions that touch many rows). */
const NEW_OP = "lower(hex(randomblob(16)))";

/** The home's billing lease for an interactive action: a few short retries when another worker holds it, so a press is not turned away by
 *  a race it would win a moment later. Still busy after that: HomeBusy (the caller answers 503 and nothing was consumed). */
async function leased<T>(env: Env, homeId: string, work: (lease: HomeLease) => Promise<T>, held?: HomeLease | null): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try { return await withHomeLease(env, homeId, work, held); }
    catch (e) { if (!(e instanceof HomeBusy) || attempt >= 8) throw e; await new Promise((r) => setTimeout(r, 40 * attempt)); }
  }
}

// --- records ----------------------------------------------------------------------------------------------------------------------

export type Status = "open" | "reason_pending" | "held" | "executing" | "completed" | "kept";
export interface CancellationRow {
  id: string; ref: string; received_at: number; fields_json: string; kind: CancelKind; requested_date: string | null; reason: string | null;
  entered_email: string; entered_name: string; identifier: string | null; confirm_email: string; language: Lang; claimed_ip: string | null; claimed_ua: string | null;
  match_state: "pending" | "matched" | "unmatched"; attribution_basis: "account_email" | "identifier" | "support" | null; attributed_at: number | null;
  account_id: string | null; supabase_sub: string | null; home_id: string | null; subscription_id: string | null;
  effective_at: number | null; fallback_end_at: number | null; hold_until: number | null; keep_at: number | null; status: Status;
  held_at: number | null; held_from: string | null; case_id: string | null; receipt_sha256: string; reason_decision: "accept" | "reject" | null;
  reason_decided_at: number | null; reason_note: string | null; completed_at: number | null; stripe_synced: number; stripe_cancel_at: number | null;
  last_op: string | null; late_checked_at: number | null; escalated_at: number | null; created_at: number; updated_at: number;
  receipt_html: string | null; seller_path: RefundPath | null; identify_due_at: number | null; reason_due_at: number | null;
  kept_by: "timeout" | "customer" | null; stripe_verified_at: number | null;
  /** WP10 r1: the emailed notice this declaration was filed for (its target is frozen at insertion, never rematched), and why it was retired
   *  without running to its end ('contract_ended': the notice's contract had ended before the stop could be scheduled; 'withdrawal:<notice>':
   *  an immediate withdrawal of the same contract ended the plan). */
  notice_id: string | null; superseded_by: string | null;
  next_match_at: number | null; match_attempts: number; exec_checked_at: number | null; stripe_attempt_at: number | null;
  identify_escalated_at: number | null; reason_escalated_at: number | null; schedule_escalated_at: number | null;
}
const load = (env: Env, id: string) => env.DB.prepare("SELECT * FROM cancellation_requests WHERE id=?").bind(id).first<CancellationRow>();

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
async function keyed(env: Env, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.BETTER_AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`murage/cancel/v1:${value}`))).slice(0, 32);
}
const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (x) => x.toString(16).padStart(2, "0")).join("");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const normEmail = (s: string) => s.trim().toLowerCase();
const ymdToMs = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);
/** An ops alert. cloud_alerts allows ONE open alert per (home_id, kind): `scope` is the alert's own subject (one request, delivery or
 *  subscription), stable across retries, never a shared "billing" (that would swallow every escalation after the first) and never a time
 *  bucket (that would raise a new alert every hour, Astra WP8-2 #9). Once ops resolves it, a recurrence is a new row. */
const alert = (env: Env, scope: string, kind: string, severity: string, detail: Record<string, JSONValue>, now: number) =>
  env.DB.prepare("INSERT OR IGNORE INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?)")
    .bind(`${scope}:${kind}:${randomHex(8)}`, scope, kind, severity, JSON.stringify(detail), now);

// --- the receipt ------------------------------------------------------------------------------------------------------------------

type ReceiptFields = Pick<CancellationRow, "id" | "ref" | "received_at" | "kind" | "requested_date" | "reason" | "entered_email" | "entered_name" | "identifier" | "confirm_email" | "language">;
const choiceKey = (k: CancelKind): StringKey => k === "ordinary_earliest" ? "choiceEarliest" : k === "ordinary_date" ? "choiceDate" : "choiceNow";

/** The declaration itself (312k(3)): every field as entered, the type and requested date, received_at in its time zone, the reference and the
 *  sentence of the plan. Rendered ONCE at submission; those bytes are stored and served (receipt_sha256 is their digest), so a later change of
 *  wording never alters a receipt already given. It never says whether an account exists. */
export function renderReceipt(r: ReceiptFields): string {
  const lang = r.language;
  const row = (label: string, value: string) => `<tr><th scope="row">${esc(label)}</th><td>${esc(value)}</td></tr>`;
  const rows = [
    row(t("lblReference", lang), r.ref),
    row(t("lblReceived", lang), fmtReceived(r.received_at, lang)),
    row(t("lblAccountEmail", lang), r.entered_email),
    row(t("lblName", lang), r.entered_name),
    ...(r.identifier ? [row(t("lblIdentifier", lang), r.identifier)] : []),
    row(t("lblType", lang), t(choiceKey(r.kind), lang)),
    ...(r.requested_date ? [row(t("lblDate", lang), fmtYmd(r.requested_date, lang))] : []),
    ...(r.reason ? [row(t("lblReason", lang), r.reason)] : []),
    row(t("lblConfirmEmail", lang), r.confirm_email),
  ].join("");
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">`
    + `<title>${esc(t("title", lang))} ${esc(r.ref)}</title></head><body><h1>${esc(t("title", lang))}</h1>`
    + `<p>${esc(t("declaration", lang, { received_at: fmtReceived(r.received_at, lang) }))}</p><table>${rows}</table>`
    + `<p><button type="button" onclick="window.print()">${esc(t("download", lang))}</button></p></body></html>`;
}

// --- matching -------------------------------------------------------------------------------------------------------------------------

interface PlanRef { userId: string; sub: string | null; homeId: string; subscriptionId: string; customerId: string; periodStart: number | null; periodEnd: number | null; consentId: string | null }
const LIVE = "('active','trialing','past_due')";
interface PlanRow { user_id: string; sub: string | null; home_id: string; subscription_id: string; customer_id: string; ps: number | null; pe: number | null; consent_id: string | null }
const planRef = (r: PlanRow): PlanRef => ({ userId: r.user_id, sub: r.sub, homeId: r.home_id, subscriptionId: r.subscription_id, customerId: r.customer_id, periodStart: r.ps, periodEnd: r.pe, consentId: r.consent_id });
const PLAN_SELECT = `SELECT h.owner_id AS user_id, s.sub AS sub, h.id AS home_id, b.subscription_id AS subscription_id, b.customer_id AS customer_id,
    b.current_period_start AS ps, b.current_period_end AS pe, b.consent_id AS consent_id
  FROM cloud_homes h JOIN billing_subscriptions b ON b.home_id=h.id LEFT JOIN supabase_identities s ON s.user_id=h.owner_id
  WHERE h.desired_state<>'deleted' AND b.subscription_id IS NOT NULL AND b.status IN ${LIVE}`;

/** The live plans of the account(s) whose contact email is `email`. It identifies a plan only when exactly one results (never guessed). */
async function plansByEmail(env: Env, email: string): Promise<PlanRef[]> {
  return (await env.DB.prepare(`${PLAN_SELECT} AND h.owner_id IN (SELECT user_id FROM supabase_identities WHERE lower(contact_email)=?)`).bind(email).all<PlanRow>()).results.map(planRef);
}
async function plansOfUser(env: Env, userId: string): Promise<PlanRef[]> {
  return (await env.DB.prepare(`${PLAN_SELECT} AND h.owner_id=?`).bind(userId).all<PlanRow>()).results.map(planRef);
}
/** The identifier is checked against Stripe invoice numbers and receipt emails; it identifies a plan only when exactly one live plan results. */
async function plansByIdentifier(env: Env, stripe: StripeClient | null, identifier: string): Promise<PlanRef[]> {
  if (!stripe) return [];
  const customers = await stripe.customersForIdentifier(identifier);
  if (customers.length === 0) return [];
  const marks = customers.map(() => "?").join(",");
  return (await env.DB.prepare(`${PLAN_SELECT} AND b.customer_id IN (${marks})`).bind(...customers).all<PlanRow>()).results.map(planRef);
}

function stripeOf(env: Env, d: CancellationDeps): StripeClient | null {
  if (d.stripe !== undefined) return d.stripe;
  // The worker's own Stripe transport when it was given one (BillingDependencies.stripeFetch), as every other billing path uses.
  try { return stripeClient(cfg(env), d.billing?.stripeFetch); } catch { return null; }
}

/** The paid month [start, end) current at `t`: from our record (an actual period), refreshed from Stripe when the record is behind, then rolled
 *  month by month on the billing anchor (Stripe's billing_cycle_anchor day when read, else the day the actual period shows). */
async function paidMonthAt(env: Env, d: CancellationDeps, plan: PlanRef, t0: number, now: number): Promise<{ start: number; end: number } | null> {
  let start = plan.periodStart; let end = plan.periodEnd; let anchorDay: number | null = null;
  if (end === null || end <= now) {
    const stripe = stripeOf(env, d);
    if (stripe) {
      try {
        const s = await stripe.getSubscription(plan.subscriptionId);
        if (typeof s.current_period_start === "number" && typeof s.current_period_end === "number") { start = s.current_period_start * 1000; end = s.current_period_end * 1000; }
        if (typeof s.billing_cycle_anchor === "number") anchorDay = new Date(s.billing_cycle_anchor * 1000).getUTCDate();
      } catch { /* keep our record */ }
    }
  }
  if (start === null || end === null) return null;
  return periodContaining({ start, end }, t0, anchorDay ?? anchorDayOf({ start, end }));
}

interface Schedule { effectiveAt: number; fallbackEndAt: number | null; status: Status; holdUntil: number | null }
async function scheduleFor(env: Env, d: CancellationDeps, plan: PlanRef, r: CancellationRow, now: number): Promise<Schedule | null> {
  const atReceipt = await paidMonthAt(env, d, plan, r.received_at, now);
  if (!atReceipt) return null;
  if (r.kind === "ordinary_earliest") return { effectiveAt: atReceipt.end, fallbackEndAt: null, status: "open", holdUntil: atReceipt.end };
  const dateStart = r.requested_date ? ymdToMs(r.requested_date) : r.received_at;
  const instant = Math.max(dateStart, r.received_at);
  if (r.kind === "ordinary_date") {
    const m = await paidMonthAt(env, d, plan, instant, now);
    return m ? { effectiveAt: m.end, fallbackEndAt: null, status: "open", holdUntil: m.end } : null;
  }
  // Serious reason: the legal date is received_at (or the later date asked for); if the reason does not hold, the paid month current at received_at.
  // hold_until stays open (NULL) while the reason is checked: nothing can be carried out before the decision, so the hold is always possible.
  return { effectiveAt: instant, fallbackEndAt: atReceipt.end, status: "reason_pending", holdUntil: null };
}

/** Direct or Managed Payments, from the contract's consent. Frozen on the request at attribution (Astra WP8-1 #8): a contract sold through
 *  Link stays on the Managed Payments path after it is cancelled. For a row from before the freeze, the original subscription is read whatever
 *  its status (a cancelled contract included). */
async function sellerPathOfConsent(env: Env, consentId: string | null): Promise<RefundPath> {
  const consent = consentId ? await getConsent(env, consentId) : null;
  return consent && sellerOfConsent(consent) === "link" ? "mp" : "direct";
}
async function sellerPathOf(env: Env, r: CancellationRow): Promise<RefundPath> {
  if (r.seller_path) return r.seller_path;
  const b = r.subscription_id ? await env.DB.prepare("SELECT consent_id FROM billing_subscriptions WHERE subscription_id=?").bind(r.subscription_id).first<{ consent_id: string | null }>() : null;
  return sellerPathOfConsent(env, b?.consent_id ?? null);
}

// --- attribution -------------------------------------------------------------------------------------------------------------------

const mailInsert = (id: string, kind: string, now: number, opId: string): Q => q(
  `INSERT OR IGNORE INTO cancellation_mail (id,request_id,kind,created_at) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM cancellation_requests WHERE id=? AND last_op=?)`,
  `${id}:${kind}`, id, kind, now, id, opId);

export type AttributeResult = "attributed" | "already" | "no_schedule" | "busy";
/** Identification is the attribution: the declaration applies with its frozen received_at. One conditional UPDATE (attributed_at IS NULL) and its
 *  mail, in one fenced batch under the plan's home lease. The account confirmation is queued whatever happens to the hold link later. */
export async function attributeRequest(env: Env, d: CancellationDeps, id: string, plan: PlanRef, basis: "account_email" | "identifier" | "support", atSubmission: boolean): Promise<AttributeResult> {
  const r = await load(env, id);
  if (!r) return "already";
  if (r.attributed_at !== null) return "already";
  const now = clockOf(d);
  const sch = await scheduleFor(env, d, plan, r, now);
  if (!sch) return "no_schedule";
  const sellerPath = await sellerPathOfConsent(env, plan.consentId);
  const reasonDue = sch.status === "reason_pending" ? workingDaysAfter(now, REASON_CHECK_WORKING_DAYS) : null;
  const op = crypto.randomUUID();
  try {
    const won = await leased(env, plan.homeId, async (lease) => {
      const res = await fencedBatch(env, lease, [
        q(`UPDATE cancellation_requests SET match_state='matched', attribution_basis=?, attributed_at=?, account_id=?, supabase_sub=?, home_id=?, subscription_id=?,
            effective_at=?, fallback_end_at=?, hold_until=?, status=?, seller_path=?, reason_due_at=?, stripe_synced=0, last_op=?, updated_at=?
            WHERE id=? AND attributed_at IS NULL AND status IN ('open','reason_pending')`,
        basis, now, plan.userId, plan.sub, plan.homeId, plan.subscriptionId, sch.effectiveAt, sch.fallbackEndAt, sch.holdUntil, sch.status, sellerPath, reasonDue, op, now, id),
        mailInsert(id, "confirm_account", now, op),
        ...(atSubmission ? [] : [mailInsert(id, "attributed_declarant", now, op)]),
        ...(sch.status === "reason_pending" ? [q(`INSERT OR IGNORE INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM cancellation_requests WHERE id=? AND last_op=?)`,
          `cx-reason:${id}`, `cx-reason:${id}`, "cancellation.reason_check", "medium", JSON.stringify({ id, ref: r.ref, due: reasonDue }), now, id, op)] : []),
        // Astra JOURNEY-BCORE-2 #1: the generation-bound resolution of the end this request promises, in the same batch.
        ...publicResolutionQ(id, op, now),
      ]);
      return res[0].meta.changes === 1;
    });
    if (!won) return "already";
  } catch (e) {
    if (e instanceof HomeBusy || e instanceof LeaseLost) return "busy";
    throw e;
  }
  await afterTransition(env, d, id);
  return "attributed";
}

/** Match a received declaration: the account email first, then the identifier; otherwise it waits for support, who is told now (an
 *  identification job) and again, urgently, 3 days before the next renewal of any plan it could be (with none known: at once). */
export async function matchRequest(env: Env, d: CancellationDeps, id: string, atSubmission: boolean): Promise<void> {
  const r = await load(env, id);
  if (!r || r.match_state === "matched") return;
  // WP10 r1-1: a declaration filed for an emailed notice carries its frozen account and contract from insertion. It is matched to exactly
  // that contract or not at all, never by the account's CURRENT email (which could pick a replacement plan).
  if (r.notice_id) { await matchFrozen(env, d, r); return; }
  const byEmail = await plansByEmail(env, r.entered_email);
  let plan: PlanRef | null = byEmail.length === 1 ? byEmail[0] : null;
  let basis: "account_email" | "identifier" = "account_email";
  let byIdentifier: PlanRef[] = [];
  if (!plan && r.identifier) {
    try { byIdentifier = await plansByIdentifier(env, stripeOf(env, d), r.identifier); } catch { byIdentifier = []; }
    if (byIdentifier.length === 1) { plan = byIdentifier[0]; basis = "identifier"; }
  }
  if (!plan) {
    const now = clockOf(d);
    const renewals = [...byEmail, ...byIdentifier].map((p) => p.periodEnd).filter((x): x is number => typeof x === "number");
    const due = renewals.length ? Math.max(r.received_at, Math.min(...renewals) - 3 * DAY) : r.received_at;
    await env.DB.batch([
      env.DB.prepare("UPDATE cancellation_requests SET match_state='unmatched', identify_due_at=COALESCE(identify_due_at,?), updated_at=? WHERE id=? AND match_state<>'matched' AND attributed_at IS NULL")
        .bind(due, now, id),
      alert(env, `cx-req:${id}`, "cancellation.identify", "medium", { id, ref: r.ref, due }, now),
    ]);
    return;
  }
  const res = await attributeRequest(env, d, id, plan, basis, atSubmission);
  if (res === "no_schedule") await escalateNoSchedule(env, d, r);
}

/** The plan is known but its paid months cannot be laid out (a date beyond the calendar helper's 60 months, or no period on record): never
 *  silently pending. Ops hears once (its own marker); the sweep keeps retrying on its fair schedule (Astra WP8-2 #6). The marker and the alert
 *  commit in ONE transaction: the alert is written only by the statement that set the marker (changes() right after it), and a failed alert
 *  insert rolls the marker back, so the next retry escalates again (Astra WP8-3 #4). WP10 r2-6: also for a notice's own cancellation. */
async function escalateNoSchedule(env: Env, d: CancellationDeps, r: CancellationRow): Promise<void> {
  const now = clockOf(d);
  await env.DB.batch([
    env.DB.prepare("UPDATE cancellation_requests SET schedule_escalated_at=?, updated_at=? WHERE id=? AND schedule_escalated_at IS NULL AND attributed_at IS NULL")
      .bind(now, now, r.id),
    env.DB.prepare("INSERT OR IGNORE INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) SELECT ?,?,?,?,?,? WHERE changes()=1")
      .bind(`cx-req:${r.id}:cancellation.no_schedule:${randomHex(8)}`, `cx-req:${r.id}`, "cancellation.no_schedule", "high", JSON.stringify({ id: r.id, ref: r.ref, requested: r.requested_date }), now),
  ]);
}

/** After the 201: match, then send the confirmations. Runs in ctx.waitUntil; the sweep does the same for anything left pending. */
export async function processIntake(env: Env, d: CancellationDeps, id: string): Promise<void> {
  try { await matchRequest(env, d, id, true); } catch { console.error(JSON.stringify({ message: "cancellation match failed" })); }
  try { await flushMail(env, d, id); } catch { console.error(JSON.stringify({ message: "cancellation mail failed" })); }
}

// --- Stripe, refunds, mail: after a committed transition ----------------------------------------------------------------------------------

async function afterTransition(env: Env, d: CancellationDeps, id: string): Promise<void> {
  try { await syncStripe(env, d, id); } catch { console.error(JSON.stringify({ message: "cancellation stripe sync failed" })); }
  try { await recordLateCharges(env, d, id); } catch { console.error(JSON.stringify({ message: "cancellation late charge record failed" })); }
  try { await flushMail(env, d, id); } catch { console.error(JSON.stringify({ message: "cancellation mail failed" })); }
}

/** Brings Stripe in line with every declaration of this request's subscription (kept for callers; see reconcileSubscription). */
export async function syncStripe(env: Env, d: CancellationDeps, id: string): Promise<void> {
  const r = await load(env, id);
  if (!r || !r.subscription_id || !r.home_id) return;
  await reconcileSubscription(env, d, r.subscription_id);
}

interface SubDecl { id: string; status: Status; kind: CancelKind; effective_at: number | null; reason_decision: string | null; last_op: string | null }
/** What Stripe must show for this subscription, from ALL its declarations: `skip` while an accepted immediate end is executing (its refund
 *  operation owns the end); `end` once one has ended (completed, or an ordinary end that is due); otherwise cancel_at = the earliest ordinary
 *  end (a rejected serious reason counts as one) and collection paused while a serious reason is being checked. A cancellation the customer made
 *  on the account page owns cancel_at ("leave"). */
interface Intent { skip: boolean; end: boolean; cancelAt: number | null | "leave"; pause: boolean; endAt?: number | null }
async function intentFor(env: Env, subscriptionId: string, now: number): Promise<{ intent: Intent; rows: SubDecl[] }> {
  const rows = (await env.DB.prepare("SELECT id,status,kind,effective_at,reason_decision,last_op FROM cancellation_requests WHERE subscription_id=? AND match_state='matched'")
    .bind(subscriptionId).all<SubDecl>()).results;
  if (rows.some((r) => r.status === "executing")) return { intent: { skip: true, end: true, cancelAt: "leave", pause: false }, rows };
  const ends = rows.filter((r) => r.status === "open" && r.effective_at !== null && (r.kind !== "extraordinary" || r.reason_decision === "reject")).map((r) => r.effective_at!);
  const cancelAt = ends.length ? Math.min(...ends) : null;
  const end = rows.some((r) => r.status === "completed") || (cancelAt !== null && cancelAt <= now);
  // The legal end the plan reached (drafts a pause held back are judged against it, never against the day Stripe was told).
  const endAts = [...rows.filter((r) => r.status === "completed" && r.effective_at !== null).map((r) => r.effective_at!), ...(cancelAt !== null && cancelAt <= now ? [cancelAt] : [])];
  const endAt = endAts.length ? Math.min(...endAts) : null;
  const acct = await env.DB.prepare("SELECT cancel_at_period_end, customer_cancel_at, cancel_terminal_sub FROM billing_subscriptions WHERE subscription_id=?")
    .bind(subscriptionId).first<{ cancel_at_period_end: number | null; customer_cancel_at: number | null; cancel_terminal_sub: string | null }>();
  const accountCancel = !!acct && (acct.cancel_at_period_end === 1 || acct.customer_cancel_at !== null || acct.cancel_terminal_sub === subscriptionId);
  return { intent: { skip: false, end, endAt, cancelAt: accountCancel ? "leave" : cancelAt, pause: !end && rows.some((r) => r.status === "reason_pending") }, rows };
}

type Mutation = { kind: "cancel_at"; value: number | null } | { kind: "pause"; value: 0 | 1 } | { kind: "cancel_now"; value: null };
type Got = Awaited<ReturnType<StripeClient["getSubscription"]>>;
function diffs(intent: Intent, got: Got): Mutation[] {
  if (got.status === "canceled") return [];
  if (intent.end) return [{ kind: "cancel_now", value: null }];
  const out: Mutation[] = [];
  if (intent.cancelAt !== "leave") {
    const want = intent.cancelAt === null ? null : Math.floor(intent.cancelAt / 1000);
    if ((got.cancel_at ?? null) !== want) out.push({ kind: "cancel_at", value: want });
  }
  if ((got.pause_collection ?? null) !== null !== intent.pause) out.push({ kind: "pause", value: intent.pause ? 1 : 0 });
  return out;
}

/** Sends one journaled subscription mutation with ITS key, through the gateway (Astra JOURNEY-BCORE-6 #1): true when the subscription is
 *  parked and nothing was sent (the mutation stays pending). The renewal drafts a pause held back are NOT released here: each is settled by its
 *  own journal row (settleDrafts), so a release that fails after the unpause succeeded is never lost (Astra WP8-2 #2). */
async function applyMutation(env: Env, lease: HomeLease, stripe: StripeClient, subId: string, m: Mutation, key: string): Promise<boolean> {
  if (m.kind === "cancel_at") return (await writeSubscription(env, lease, stripe, subId, { kind: "cancel_at", value: m.value, key })).parked;
  if (m.kind === "cancel_now") {
    // Astra JOURNEY-BCORE-4 #3: the normal end-now call, the same as the resolver's: usage not yet invoiced is billed now, no proration.
    try { return (await writeSubscription(env, lease, stripe, subId, { kind: "cancel_now", opts: { invoiceNow: true, prorate: false } })).parked; }
    catch (e) { if (!(e instanceof StripeError && e.status === 404)) throw e; return false; }
  }
  return (await writeSubscription(env, lease, stripe, subId, { kind: "pause", value: m.value === 1 ? "keep_as_draft" : null, key })).parked;
}

// --- the renewal drafts a pause held back -------------------------------------------------------------------------------------------------

type DraftKind = "release" | "void";
const SUB_KINDS = "('cancel_at','pause','cancel_now')";
/** The last moment an invoice pays for (its lines' period end), or null when it shows none. */
const periodEndOf = (inv: InvoiceView): number | null => {
  const ends = (inv.lines?.data ?? []).map((l) => l.period?.end).filter((x): x is number => typeof x === "number");
  return ends.length ? Math.max(...ends) * 1000 : null;
};
/** release: collection on (auto_advance), Stripe finalizes and collects it. void: finalized without collection, then voided. */
async function sendDraft(stripe: StripeClient, kind: DraftKind, invoiceId: string, key: string): Promise<void> {
  if (kind === "release") { await stripe.setInvoiceAutoAdvance(invoiceId, true, key); return; }
  const inv = await stripe.getInvoice(invoiceId);
  if (inv.status === "void" || inv.status === "paid") return;
  if (inv.status === "draft") await stripe.finalizeInvoice(invoiceId, `${key}:fin`);
  await stripe.voidInvoice(invoiceId, `${key}:void`);
}
/** Read back: a release is done only on an explicit auto_advance=true or a recognised terminal status (paid, void, uncollectible); an
 *  incomplete read (open with auto_advance missing, an unknown status) is NOT (Astra WP8-4 #4). A void is done once it is void (or it was
 *  paid after all: then the late-charge refund owns it). An invoice that finalized but did not void is `open`: it is NOT settled for a void
 *  (Astra WP8-3 #1). */
const TERMINAL_INVOICE = new Set(["paid", "void", "uncollectible"]);
const draftSettled = (kind: DraftKind, inv: InvoiceView): boolean =>
  kind === "release"
    ? inv.auto_advance === true || (typeof inv.status === "string" && TERMINAL_INVOICE.has(inv.status))
    : inv.status === "void" || inv.status === "paid";
/** The first moment an invoice pays for (its lines' period start), or null when it shows none. */
const periodStartOf = (inv: InvoiceView): number | null => {
  const starts = (inv.lines?.data ?? []).map((l) => l.period?.start).filter((x): x is number => typeof x === "number");
  return starts.length ? Math.min(...starts) * 1000 : null;
};
/** What a held-back invoice must become against the CURRENT legal end (`cutoff`; null: no end). Wholly before the end, or no end: released
 *  (owed). Wholly after the end: voided (never owed). Straddling the end: released, so the time before the end stays owed, and the time after
 *  it is refunded pro rata by the late-charge refund once it is paid (recorded by recordLateCharges for an operator to execute; owner default r3, Astra WP8-3 #3: no blanket waiver). */
const wantFor = (inv: InvoiceView, cutoff: number | null): DraftKind => {
  if (cutoff === null) return "release";
  const end = periodEndOf(inv) ?? inv.created * 1000;
  if (end <= cutoff) return "release";
  const start = periodStartOf(inv) ?? inv.created * 1000;
  return start >= cutoff ? "void" : "release";
};
/** The live invoice, or null when Stripe no longer has it (deleted: nothing is left to collect or void). */
async function readInvoice(stripe: StripeClient, id: string): Promise<InvoiceView | null> {
  try { return (await stripe.getInvoice(id)) ?? null; }
  catch (e) { if (e instanceof StripeError && e.status === 404) return null; throw e; }
}

/** Settles every renewal invoice that a pause of this package held back, once the pause is lifted (Astra WP8-2 #2, P2 #8; WP8-3 #1-#3).
 *  (1) Every unresolved journal row is first resolved with its OWN key (a request an older holder may still have in flight can then never
 *  land later; a key still in flight stops here); its own outcome is recorded. (2) The outstanding obligations are then EVERY invoice this
 *  pause window journaled, whatever its status now (a finalized one whose void failed is `open`, which a draft-only listing never finds again),
 *  plus every draft the pause held back. Each is read and judged against the CURRENT cutoff (wantFor), including one an earlier pass
 *  released or that is already open; one not yet settled goes out under a fresh key (a failure Stripe cached against a key is superseded) and
 *  is read back. Returns true only when a read of every obligation shows it settled; the pause rows are then marked released, unless `close`
 *  is false: a pass made BEFORE the subscription is cancelled keeps the obligations open, because Stripe switches auto_advance off on every
 *  draft and open invoice when it cancels, undoing a release made before it (Astra WP8-4 #1); a pass after the cancellation closes them. */
async function settleDrafts(env: Env, stripe: StripeClient, lease: HomeLease, subscriptionId: string, homeId: string, cutoff: number | null, now: number, close = true): Promise<boolean> {
  try {
    const ok = await settleOnce(env, stripe, lease, subscriptionId, homeId, cutoff, now, close);
    if (ok) await fencedRun(env, lease, `UPDATE cancellation_stripe_mutations SET settle_failures=0, settle_failing_since=NULL WHERE subscription_id=? AND kind='pause' AND settle_failures>0`, subscriptionId);
    return ok;
  } catch (e) {
    if (e instanceof HomeBusy || e instanceof LeaseLost) throw e;
    try { await noteSettleFailure(env, lease, subscriptionId, e, now); } catch { /* the obligation stays open either way */ }
    throw e;
  }
}
/** A settle pass that a read, transport or in-flight error stopped: counted on the open pause rows with the time of the first such failure,
 *  across passes. Once it has failed SETTLE_ESCALATE_AFTER passes in a row, or for SETTLE_ESCALATE_AGE, ops hears (one open alert per
 *  subscription); the obligation stays open and every later pass tries again (Astra WP8-4 #2). */
const SETTLE_ESCALATE_AFTER = 3;
const SETTLE_ESCALATE_AGE = 6 * HOUR;
const OPEN_PAUSES = "subscription_id=? AND kind='pause' AND value=1 AND state='confirmed' AND released_at IS NULL";
async function noteSettleFailure(env: Env, lease: HomeLease, subscriptionId: string, e: unknown, now: number): Promise<void> {
  await fencedRun(env, lease, `UPDATE cancellation_stripe_mutations SET settle_failures=settle_failures+1, settle_failing_since=COALESCE(settle_failing_since, ?) WHERE ${OPEN_PAUSES}`, now, subscriptionId);
  const f = await env.DB.prepare(`SELECT MAX(settle_failures) AS n, MIN(settle_failing_since) AS since FROM cancellation_stripe_mutations WHERE ${OPEN_PAUSES}`)
    .bind(subscriptionId).first<{ n: number | null; since: number | null }>();
  if (!f?.n) return;
  if (f.n >= SETTLE_ESCALATE_AFTER || (f.since !== null && now - f.since >= SETTLE_ESCALATE_AGE)) {
    await alert(env, `cx-sub:${subscriptionId}`, "cancellation.drafts_unsettled", "high", { subscriptionId, why: "read_failing", failures: f.n, failingSince: f.since,
      last: e instanceof StripeError ? e.code : "transport" }, now).run();
  }
}
async function settleOnce(env: Env, stripe: StripeClient, lease: HomeLease, subscriptionId: string, homeId: string, cutoff: number | null, now: number, close: boolean): Promise<boolean> {
  const pauses = (await env.DB.prepare("SELECT id, created_at FROM cancellation_stripe_mutations WHERE subscription_id=? AND kind='pause' AND value=1 AND state='confirmed' AND released_at IS NULL")
    .bind(subscriptionId).all<{ id: string; created_at: number }>()).results;
  if (pauses.length === 0) return true;
  const supersede = (id: string, e: StripeError) => fencedRun(env, lease, "UPDATE cancellation_stripe_mutations SET state='superseded', resolved_at=?, provider_error=? WHERE id=? AND state='pending'", now, providerError(e), id);
  const open = (await env.DB.prepare(`SELECT id,kind,invoice_id,idempotency_key FROM cancellation_stripe_mutations WHERE subscription_id=? AND state='pending' AND kind IN ('release','void')
      ORDER BY created_at, rowid`).bind(subscriptionId).all<{ id: string; kind: DraftKind; invoice_id: string; idempotency_key: string }>()).results;
  for (const m of open) {
    await fence(env, lease);
    try { await sendDraft(stripe, m.kind, m.invoice_id, m.idempotency_key); }
    catch (e) { if (!(e instanceof StripeError) || e.meta.inFlight) throw e; await supersede(m.id, e); continue; }
    const back = await readInvoice(stripe, m.invoice_id);
    await fencedRun(env, lease, "UPDATE cancellation_stripe_mutations SET state=?, resolved_at=? WHERE id=? AND state='pending'", back === null || draftSettled(m.kind, back) ? "confirmed" : "superseded", now, m.id);
  }
  const firstPause = Math.min(...pauses.map((p) => p.created_at));
  // Journal rows of THIS pause window: every draft row is written after the pause it settles was confirmed (an older window's rows were
  // written when that window was released, before this pause existed).
  const journaled = (await env.DB.prepare(`SELECT invoice_id FROM cancellation_stripe_mutations WHERE subscription_id=? AND kind IN ('release','void') AND invoice_id IS NOT NULL
      AND created_at>=? GROUP BY invoice_id ORDER BY MIN(created_at), MIN(rowid)`).bind(subscriptionId, firstPause).all<{ invoice_id: string }>()).results.map((x) => x.invoice_id);
  const held = (await stripe.listSubscriptionInvoices(subscriptionId, "draft")).filter((i) => i.auto_advance === false && i.created * 1000 >= firstPause - HOUR).map((i) => i.id);
  let todo = [...new Set([...held, ...journaled])];
  for (let attempt = 0; todo.length > 0; attempt += 1) {
    const left: string[] = [];
    for (const invoiceId of todo) {
      const inv = await readInvoice(stripe, invoiceId);
      if (inv === null) continue;
      const kind = wantFor(inv, cutoff);
      if (draftSettled(kind, inv)) continue;
      if (attempt >= 3) { left.push(invoiceId); continue; }
      const mid = crypto.randomUUID();
      await fencedRun(env, lease, "INSERT INTO cancellation_stripe_mutations (id,subscription_id,home_id,kind,value,idempotency_key,state,created_at,invoice_id) VALUES (?,?,?,?,NULL,?,'pending',?,?)",
        mid, subscriptionId, homeId, kind, `cxl${kind}:${mid}`, now, invoiceId);
      await fence(env, lease);
      try { await sendDraft(stripe, kind, invoiceId, `cxl${kind}:${mid}`); }
      catch (e) { if (!(e instanceof StripeError) || e.meta.inFlight) throw e; await supersede(mid, e); left.push(invoiceId); continue; }
      const back = await readInvoice(stripe, invoiceId);
      const ok = back === null || draftSettled(kind, back);
      await fencedRun(env, lease, "UPDATE cancellation_stripe_mutations SET state=?, resolved_at=? WHERE id=? AND state='pending'", ok ? "confirmed" : "superseded", now, mid);
      if (!ok) left.push(invoiceId);
    }
    if (left.length > 0 && attempt >= 3) {
      await alert(env, `cx-sub:${subscriptionId}`, "cancellation.drafts_unsettled", "high", { subscriptionId, drafts: left }, now).run();
      return false;
    }
    todo = left;
  }
  if (!close) return true;
  await fencedRun(env, lease, `UPDATE cancellation_stripe_mutations SET released_at=? WHERE id IN (${pauses.map(() => "?").join(",")}) AND released_at IS NULL`, now, ...pauses.map((p) => p.id));
  return true;
}
const providerError = (e: StripeError) => JSON.stringify({ status: e.status, code: e.code, replayed: e.meta.replayed ?? false, requestId: e.meta.requestId ?? null });
/** Ops are told once a subscription's public mutations were refused three times. */
async function failingAlert(env: Env, subscriptionId: string, e: StripeError, now: number): Promise<void> {
  const failed = await env.DB.prepare("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE subscription_id=? AND provider_error IS NOT NULL").bind(subscriptionId).first<{ n: number }>();
  if ((failed?.n ?? 0) >= 3) await alert(env, `cx-sub:${subscriptionId}`, "cancellation.stripe_failing", "high", { subscriptionId, failures: failed?.n ?? 0, last: e.code }, now).run();
}

/** Records an attempt under a public mutation's key (fenced) BEFORE it is sent; ANSWERED_SQL takes it off again once Stripe answered it
 *  (Astra JOURNEY-BCORE-1 #1, the same evidence as b5-billing.ts sub_mutations.dispatched_at). */
const DISPATCH_SQL = "UPDATE cancellation_stripe_mutations SET dispatched_at=json_insert(COALESCE(dispatched_at,json_array(created_at)),'$[#]',?) WHERE id=? AND state='pending'";
const ANSWERED_SQL = `UPDATE cancellation_stripe_mutations SET dispatched_at=json_remove(dispatched_at,'$[#-1]') WHERE id=? AND json_type(dispatched_at)='array'
  AND json_extract(dispatched_at,'$[#-1]')=?`;
/** A pending row older than this is reported to ops (cancellation.key_unsettled); reported, never retired on age. */
const UNSETTLED_KEY_ALERT_MS = DAY;
/** Whether a mutation, if it still landed, would undo what the intent now asks for (an opposing request). An END now (or one being executed)
 *  is never undone by a late cancel_at or pause: Stripe cannot reactivate an ended subscription. */
function opposes(m: { kind: Mutation["kind"]; value: number | null }, intent: Intent): boolean {
  if (intent.skip || intent.end || m.kind === "cancel_now") return false;
  if (m.kind === "pause") return (m.value === 1) !== intent.pause;
  if (intent.cancelAt === "leave") return true; // the account page owns the end: a late public cancel_at change is never welcome
  return (m.value ?? null) !== (intent.cancelAt === null ? null : Math.floor(intent.cancelAt / 1000));
}

/** Under the home lease: (1) every unresolved mutation of the subscription is settled first by its OWN request and key (a request an older
 *  holder may still have in flight can then never land later). Astra JOURNEY-BCORE-1 #1: the SAME settlement rules as the in-app path
 *  (b5-billing.ts syncCancellation): every attempt is recorded before it is sent (dispatched_at) and taken off once Stripe answered it; a
 *  pending mutation is retired only on an AUTHORITATIVE answer for its own key (2xx, a replayed answer, a 400 idempotency_error), or when
 *  Stripe, read live, shows the subscription ended and no outstanding attempt is younger than STRIPE_ATTEMPT_MAX_AGE_MS. An uncached 429, a
 *  fresh 5xx, a network failure and a validation 400 settle nothing: the mutation stays pending. While any pending mutation that would undo
 *  the current intent (opposes) remains unresolved, nothing newer is sent or confirmed: the pass stops (the sweep retries; ops are told).
 *  (2) Stripe is read and compared with the intent of ALL declarations, computed now, inside the lease; each difference is journaled under a
 *  FRESH key, sent and read back, a few times. (3) Only then are the declarations read at the start marked synced, each only if no
 *  transition moved it since (its op id). */
/** Follow-up 1 #2 (Astra INTEGRATED-3 answer (ii)): a declaration whose plan ended EARLIER for another reason (setup failed and refunded, a
 *  withdrawal, a dispute, Delete) promises nothing any more. Once THE Stripe-end checkpoint is set (stripeEndConfirmedSql: Stripe's own end, never
 *  a local status) and the plan ended before the declaration's promised date, the declaration is completed and superseded_by
 *  "plan_ended:<reason>" (the same reason the account summary shows, plan-end-reason.ts), in one fenced batch with its case closed. Its
 *  effective_at (the promise) and its receipt are never changed; nothing is ever un-completed. A plan that ends ON (or after) the promised date
 *  is left alone: that declaration ends it the ordinary way.
 *  Astra INTEGRATED-5 #3: a declaration the due-end pass (completeDue) already completed because its date passed before the first verification
 *  is corrected too when THIS subscription's confirmed end (ended_at) predates the promise: only superseded_by (and its case) is written; its
 *  completion, its promise and its receipt stay exactly as they were. */
async function supersedeOutlived(env: Env, lease: HomeLease, subscriptionId: string, now: number): Promise<void> {
  const sub = await env.DB.prepare(`SELECT b.home_id,b.subscription_id,b.status,b.ended_at,b.updated_at FROM billing_subscriptions b
    WHERE b.subscription_id=? AND ${stripeEndConfirmedSql("b")}`).bind(subscriptionId)
    .first<{ home_id: string; subscription_id: string; status: string; ended_at: number | null; updated_at: number | null }>();
  if (!sub) return;
  const rows = (await env.DB.prepare(`SELECT id,status,effective_at,last_op FROM cancellation_requests WHERE subscription_id=? AND match_state='matched'
    AND status IN ('open','reason_pending','held','completed') AND superseded_by IS NULL`).bind(subscriptionId)
    .all<{ id: string; status: string; effective_at: number | null; last_op: string | null }>()).results;
  if (!rows.length) return;
  const end = await planEndOf(env, sub.home_id, sub);
  const endedAt = sub.ended_at ?? end.at ?? now;
  // A completed one only on THIS subscription's own confirmed end strictly before its promise (never on a derived or fallback time).
  const outlived = rows.filter((r) => r.status === "completed"
    ? sub.ended_at !== null && r.effective_at !== null && sub.ended_at < r.effective_at
    : r.effective_at === null || endedAt < r.effective_at);
  if (!outlived.length) return;
  const why = `plan_ended:${end.reason}`;
  await fencedBatch(env, lease, outlived.flatMap((r) => {
    const op = crypto.randomUUID();
    if (r.status === "completed") return [
      q(`UPDATE cancellation_requests SET superseded_by=?, last_op=?, updated_at=? WHERE id=? AND status='completed' AND superseded_by IS NULL AND last_op IS ?`,
        why, op, now, r.id, r.last_op),
      q(`UPDATE cancellation_cases SET closed_at=?, outcome='plan_ended' WHERE request_id=? AND closed_at IS NULL
          AND EXISTS (SELECT 1 FROM cancellation_requests WHERE id=? AND last_op=?)`, now, r.id, r.id, op),
    ];
    return [
      q(`UPDATE cancellation_requests SET status='completed', completed_at=?, superseded_by=?, hold_until=MIN(COALESCE(hold_until,?),?), keep_at=NULL,
          stripe_synced=0, last_op=?, updated_at=? WHERE id=? AND status IN ('open','reason_pending','held') AND superseded_by IS NULL AND last_op IS ?`,
        now, why, now, now, op, now, r.id, r.last_op),
      q(`UPDATE cancellation_cases SET closed_at=?, outcome='plan_ended' WHERE request_id=? AND closed_at IS NULL
          AND EXISTS (SELECT 1 FROM cancellation_requests WHERE id=? AND last_op=?)`, now, r.id, r.id, op),
    ];
  }));
}

export async function reconcileSubscription(env: Env, d: CancellationDeps, subscriptionId: string): Promise<"synced" | "busy" | "skipped"> {
  const stripe = stripeOf(env, d);
  if (!stripe) return "skipped";
  const home = await env.DB.prepare("SELECT home_id FROM cancellation_requests WHERE subscription_id=? AND home_id IS NOT NULL LIMIT 1").bind(subscriptionId).first<{ home_id: string }>();
  if (!home) return "skipped";
  try {
    return await withHomeLease(env, home.home_id, async (lease) => {
      const now = clockOf(d);
      await supersedeOutlived(env, lease, subscriptionId, now);
      const { intent, rows } = await intentFor(env, subscriptionId, now);
      // The declaration revision every mutation of this pass is computed for (Astra CANCEL-SUMMARY-1 #3): a confirmation counts only for it.
      const rev = declRevision(rows);
      // Astra JOURNEY-BCORE-4 #1: parked on an attached schedule: this reconciliation writes nothing (no settle, no DELETE, no cancel_at);
      // the declarations stay unsynced and only the resolver's hourly read looks at the subscription.
      if (!intent.skip && await scheduleParked(env, subscriptionId)) return "skipped" as const;
      if (!intent.skip) {
        const open = (await env.DB.prepare(`SELECT id,kind,value,idempotency_key,created_at,dispatched_at FROM cancellation_stripe_mutations WHERE subscription_id=? AND state='pending'
          AND kind IN ${SUB_KINDS} ORDER BY created_at, rowid`).bind(subscriptionId)
          .all<{ id: string; kind: Mutation["kind"]; value: number | null; idempotency_key: string; created_at: number; dispatched_at: string | null }>()).results;
        const unresolved: typeof open = [];
        // Astra JOURNEY-BCORE-6 #3: EVERY read of this pass that shows the subscription ended is persisted under the lease (markEndedQ), so a
        // Keep that asked for this reconciliation answers too_late, never kept.
        const seen = async (g: Got): Promise<Got> => {
          if (endedAtStripe(g)) await fencedBatch(env, lease, [markEndedQ(home.home_id, subscriptionId, clockOf(d))]);
          return g;
        };
        let liveEnded: boolean | null = null;
        const endedNow = async () => {
          if (liveEnded === null) { try { liveEnded = endedAtStripe(await seen(await stripe.getSubscription(subscriptionId))); } catch (e) { if (e instanceof LeaseLost) throw e; liveEnded = false; } }
          return liveEnded;
        };
        for (const m of open) {
          await fence(env, lease);
          if (m.kind === "cancel_now") {
            // No key on a DELETE: settled by what Stripe shows. An end is never undone, so a lost one only needs to be repeated if still wanted.
            const s = await seen(await stripe.getSubscription(subscriptionId));
            await fencedRun(env, lease, "UPDATE cancellation_stripe_mutations SET state=?, resolved_at=? WHERE id=? AND state='pending'", s.status === "canceled" ? "confirmed" : "superseded", now, m.id);
            continue;
          }
          const sentAt = clockOf(d);
          await fencedRun(env, lease, DISPATCH_SQL, sentAt, m.id);
          let parkedNow = false;
          try { parkedNow = await applyMutation(env, lease, stripe, subscriptionId, { kind: m.kind, value: m.value } as Mutation, m.idempotency_key); }
          catch (e) {
            if (e instanceof LeaseLost) throw e;
            // Still being processed at Stripe under that key: its outcome is unknown, so nothing newer is decided (the sweep settles it).
            if (e instanceof StripeError && e.meta.inFlight) throw e;
            if (attemptAnswered(e)) await fencedRun(env, lease, ANSWERED_SQL, m.id, sentAt);
            if (keyAnswered(e)) {
              // Stripe answered for THIS key (a replayed cached failure, or the key is spent): it can never change the subscription later.
              await fencedRun(env, lease, "UPDATE cancellation_stripe_mutations SET state='superseded', resolved_at=?, provider_error=? WHERE id=? AND state='pending'", now, providerError(e), m.id);
              await failingAlert(env, subscriptionId, e, now);
              continue;
            }
            if (now - m.created_at >= UNSETTLED_KEY_ALERT_MS) {
              await alert(env, `cx-mut:${m.id}`, "cancellation.key_unsettled", "high", { subscriptionId, mutation: m.id, code: e instanceof StripeError ? e.code : "network" }, now).run();
            }
            // Verified terminal state: the subscription has ended at Stripe and no outstanding attempt is young enough to still be on its way.
            const outstanding = attemptAnswered(e) ? [] : [sentAt];
            const attempts = [...attemptsOf(m), ...outstanding];
            if ((!attempts.length || Math.max(...attempts) <= clockOf(d) - STRIPE_ATTEMPT_MAX_AGE_MS) && await endedNow()) {
              await fencedRun(env, lease, "UPDATE cancellation_stripe_mutations SET state='superseded', resolved_at=?, provider_error=? WHERE id=? AND state='pending'", now,
                JSON.stringify({ status: e instanceof StripeError ? e.status : null, code: e instanceof StripeError ? e.code : "network", retired: "terminal" }), m.id);
              continue;
            }
            // A request whose outcome is unknown (still in flight, an uncached 429, a fresh 5xx, a network failure, a validation 400) stays pending.
            unresolved.push(m);
            continue;
          }
          // Parked since the check at the top of this pass: nothing was sent; the mutation stays pending and nothing is synced.
          if (parkedNow) return "skipped" as const;
          await fencedRun(env, lease, "UPDATE cancellation_stripe_mutations SET state='confirmed', resolved_at=? WHERE id=? AND state='pending'", now, m.id);
        }
        // A pending request that would undo the current intent may still land: nothing newer is decided or confirmed meanwhile.
        if (unresolved.some((m) => opposes(m, intent))) {
          // Ops hear of it once it has stood for an hour (a transient 429 settles on the next pass); stuck beyond a day: key_unsettled too.
          if (unresolved.some((m) => now - m.created_at >= HOUR)) {
            await alert(env, `cx-sub:${subscriptionId}`, "cancellation.mutation_unresolved", "high", { subscriptionId, mutations: unresolved.map((m) => m.id) }, now).run();
          }
          throw new Error("cancellation_mutation_unresolved");
        }
        let got = await seen(await stripe.getSubscription(subscriptionId));
        if (got.status === "canceled" && !intent.end) {
          await alert(env, `cx-sub:${subscriptionId}`, "cancellation.subscription_gone", "high", { subscriptionId }, now).run();
        }
        for (let attempt = 0; ; attempt += 1) {
          const todo = diffs(intent, got);
          if (todo.length === 0) break;
          if (attempt >= 3) {
            await alert(env, `cx-sub:${subscriptionId}`, "cancellation.stripe_unconfirmed", "high", { subscriptionId }, now).run();
            throw new Error("cancellation_stripe_unconfirmed");
          }
          const sent: string[] = [];
          for (const m of todo) {
            const mid = crypto.randomUUID();
            sent.push(mid);
            const key = `cxlmut:${mid}`;
            await fencedRun(env, lease, `INSERT INTO cancellation_stripe_mutations (id,subscription_id,home_id,kind,value,idempotency_key,state,created_at,decl_rev,decl_n,dispatched_at)
              VALUES (?,?,?,?,?,?,'pending',?,?,?,'[]')`, mid, subscriptionId, home.home_id, m.kind, m.value, key, now, rev.rev, rev.n);
            await fence(env, lease);
            const sentAt = clockOf(d);
            if (m.kind !== "cancel_now") await fencedRun(env, lease, DISPATCH_SQL, sentAt, mid);
            let parkedNow = false;
            try { parkedNow = await applyMutation(env, lease, stripe, subscriptionId, m, key); }
            catch (e) {
              if (e instanceof LeaseLost) throw e;
              if (m.kind !== "cancel_now" && attemptAnswered(e)) await fencedRun(env, lease, ANSWERED_SQL, mid, sentAt);
              // Astra JOURNEY-BCORE-1 #1: closed only when nothing can land under this fresh key: Stripe answered for the key (a cached failure,
              // a spent key) or refused its only attempt on validation (nothing saved). Anything else (an uncached 429, a fresh 5xx, a network
              // failure, still in flight) leaves it pending and stops the pass; the next pass settles it by its own key first.
              if (!(keyAnswered(e) || validationRefusal(e))) throw e;
              await fencedRun(env, lease, "UPDATE cancellation_stripe_mutations SET state='superseded', resolved_at=?, provider_error=? WHERE id=? AND state='pending'", now, providerError(e), mid);
              await failingAlert(env, subscriptionId, e, now);
              // Astra JOURNEY-BCORE-4 #1: the end-now refused because a schedule is attached: parked like the resolver parks it, nothing repeated.
              if (m.kind === "cancel_now" && refusedByStripe(e)) {
                // Astra JOURNEY-BCORE-5 #4: the read just before showed the schedule: parked NOW, before any fallible read-back.
                if (got.schedule && !endedAtStripe(got)) {
                  await parkOnSchedule(env, lease, subscriptionId, home.home_id, got.schedule, e, { promisedEndAt: intent.endAt ?? null }, now);
                  return "skipped" as const;
                }
                // Astra JOURNEY-BCORE-7 #5: this read too goes through `seen` (an end it shows is persisted before anything else).
                const live = await seen(await stripe.getSubscription(subscriptionId));
                if (live.schedule && !endedAtStripe(live)) {
                  await parkOnSchedule(env, lease, subscriptionId, home.home_id, live.schedule, e, { promisedEndAt: intent.endAt ?? null }, now);
                  return "skipped" as const;
                }
              }
            }
            if (parkedNow) return "skipped" as const; // nothing sent: the journaled mutation stays pending
          }
          got = await seen(await stripe.getSubscription(subscriptionId));
          const still = new Set(diffs(intent, got).map((m) => m.kind));
          await fencedRun(env, lease, `UPDATE cancellation_stripe_mutations SET state=CASE WHEN kind IN (${[...still].map(() => "?").join(",") || "''"}) THEN 'superseded' ELSE 'confirmed' END,
            resolved_at=? WHERE subscription_id=? AND state='pending' AND kind IN ${SUB_KINDS} AND id IN (${sent.map(() => "?").join(",")})`, ...still, now, subscriptionId, ...sent);
        }
        // (2b) Collection is no longer paused: every draft the pause held back is settled (released, or voided after the legal end), each by
        // its own journal row, and read back. Until then nothing is marked synced (Astra WP8-2 #2).
        if (!intent.pause && (got.status === "canceled" || (got.pause_collection ?? null) === null)
          && !await settleDrafts(env, stripe, lease, subscriptionId, home.home_id, intent.end ? intent.endAt ?? now : null, now)) throw new Error("cancellation_drafts_unsettled");
      }
      const cancelAt = intent.skip || intent.end || intent.cancelAt === "leave" ? null : intent.cancelAt;
      // The home's row learns Stripe's confirmed cancel_at in the SAME batch, so the account page shows the plan ending before (and without)
      // any webhook; a cancellation taken back (kept, repudiated) clears it the same way. An end now (or one the account page owns) leaves it.
      const own = !intent.skip && !intent.end && intent.cancelAt !== "leave";
      if (rows.length) await fencedBatch(env, lease, [...rows.map((r) => q("UPDATE cancellation_requests SET stripe_synced=1, stripe_cancel_at=?, stripe_verified_at=? WHERE id=? AND last_op IS ?",
        cancelAt, now, r.id, r.last_op)),
        ...(own ? [q("UPDATE billing_subscriptions SET cancel_at=? WHERE home_id=? AND subscription_id=?", cancelAt, home.home_id, subscriptionId)] : [])]);
      return "synced" as const;
    });
  } catch (e) {
    if (e instanceof HomeBusy || e instanceof LeaseLost) return "busy";
    throw e;
  }
}

// --- mail ------------------------------------------------------------------------------------------------------------------------------

const siteOrigin = (env: Env, d: CancellationDeps) => d.siteOrigin ?? (env as unknown as { SITE_ORIGIN?: string }).SITE_ORIGIN ?? "https://murage.ai";
function mailer(env: Env, d: CancellationDeps): TransactionalEmailSender {
  return d.mailer ?? senderOrFail(env);
}
interface Mail { to: string; subject: string; text: string }

/** The immutable declaration as the confirmation repeats it (312k(4)): what was declared, by whom, how to identify the plan, when we received
 *  it, and where the confirmation goes. Never changes after submission. */
function declarationLines(r: CancellationRow, lang: Lang): string[] {
  const received = fmtReceived(r.received_at, lang);
  return [
    t("declaration", lang, { received_at: received }),
    `${t("lblReference", lang)}: ${r.ref}`,
    `${t("lblReceived", lang)}: ${received}`,
    `${t("lblAccountEmail", lang)}: ${r.entered_email}`,
    `${t("lblName", lang)}: ${r.entered_name}`,
    ...(r.identifier ? [`${t("lblIdentifier", lang)}: ${r.identifier}`] : []),
    `${t("lblType", lang)}: ${t(choiceKey(r.kind), lang)}`,
    ...(r.requested_date ? [`${t("lblDate", lang)}: ${fmtYmd(r.requested_date, lang)}`] : []),
    ...(r.reason ? [`${t("lblReason", lang)}: ${r.reason}`] : []),
    `${t("lblConfirmEmail", lang)}: ${r.confirm_email}`,
  ];
}

/** The durable confirmation (312k(4)): the declaration, received_at, and the end as the COMMITTED state has it now (a delayed confirmation of a
 *  held or kept declaration says it is on hold, never that the plan ends). */
function confirmationText(r: CancellationRow, lang: Lang): string {
  const received = fmtReceived(r.received_at, lang);
  const lines = declarationLines(r, lang);
  if (r.status === "held" || r.status === "kept") { lines.push("", t("heldMail", lang)); return lines.join("\n"); }
  if (r.match_state !== "matched" || r.effective_at === null) {
    const vars = { received_at: received, requested_date: r.requested_date ? fmtYmd(r.requested_date, lang) : "" };
    const asked = r.kind === "ordinary_earliest" ? t("askedEarliest", lang) : r.kind === "ordinary_date" ? t("askedDate", lang, vars) : t("askedNow", lang);
    const ends = r.kind === "ordinary_earliest" ? t("endsEarliest", lang, vars) : r.kind === "ordinary_date" ? t("endsDate", lang, vars) : t("endsNow", lang, vars);
    lines.push("", t("unmatched", lang, { ...vars, asked, ends }));
    return lines.join("\n");
  }
  const periodEnd = fmtDate(r.fallback_end_at ?? r.effective_at, lang);
  lines.push("");
  if (r.kind === "ordinary_earliest") lines.push(t("endMonth", lang, { period_end: periodEnd }));
  else if (r.kind === "ordinary_date") lines.push(t("onDate", lang, { requested_date: fmtYmd(r.requested_date!, lang), effective_at: fmtDate(r.effective_at, lang) }));
  else lines.push(t("now", lang, { received_at: fmtReceived(r.effective_at, lang), period_end: periodEnd }));
  return lines.join("\n");
}

type RefundRow = RefundStateFields & { id: string; amount_cents: number | null; decided_at: number | null; cutover_at?: number | null; paid_cents?: number | null };
const refundRows = (env: Env, like: string) =>
  env.DB.prepare("SELECT id,refund_submitted_at,stripe_refund_status,refunded_at,attempts,done_at,amount_cents,decided_at,cutover_at,paid_cents FROM refund_ops WHERE id LIKE ? ORDER BY id").bind(like).all<RefundRow>().then((x) => x.results);
/** An operation decided at zero (nothing paid for the time after the end): it has no refund to report. */
const nothingToRefund = (o: RefundRow) => o.decided_at !== null && (o.amount_cents ?? 0) === 0;

/** What a mail row becomes now: a mail ("gen": the account's email generation it was rendered for; "link": it carries a hold link and is
 *  kept for its retries), "skip" (nothing to send), {wait} (not yet true: send later, not a failure), "lost" (another sender owns this
 *  delivery now: stop) or null (cannot be rendered yet: the identity reader is down; retried). */
interface Identity { email: string; updatedAt: string }
type RenderedMail = Mail & { gen?: Identity; link?: boolean };
type Rendered = RenderedMail | "skip" | "lost" | { wait: number } | null;
const holdOpen = (r: CancellationRow, now: number) => (r.status === "open" || r.status === "reason_pending") && (r.hold_until === null || r.hold_until > now);
/** The delivery the caller holds: a hold link is minted only while this claim is still the caller's (Astra WP8-2 #3). */
interface Claim { mailId: string; claimId: string }
const LINK_KINDS = (kind: string) => kind === "confirm_account" || kind.startsWith("relink_account");

async function currentIdentity(env: Env, d: CancellationDeps, r: CancellationRow): Promise<Identity | null> {
  if (!r.supabase_sub) return null;
  const reader: IdentityReader | null = readerOf(env, d);
  if (!reader) return null;
  try {
    const i = await reader.emailGen(r.supabase_sub);
    return i.email && i.updatedAt ? { email: i.email.trim().toLowerCase(), updatedAt: i.updatedAt } : null;
  } catch { return null; }
}

async function renderMail(env: Env, d: CancellationDeps, r: CancellationRow, kind: string, now: number, claim?: Claim): Promise<Rendered> {
  const lang = r.language;
  const base = confirmationText(r, lang);
  if (kind === "receipt_declarant") {
    // Matched through the account email and the same address was entered for the confirmation: the account mail below is that mail.
    if (r.match_state === "matched" && r.attribution_basis === "account_email" && normEmail(r.confirm_email) === r.entered_email) return "skip";
    return { to: r.confirm_email, subject: t("subjectReceipt", lang), text: base };
  }
  if (kind === "attributed_declarant") return { to: r.confirm_email, subject: t("subjectReceipt", lang), text: base };
  if (kind === "rejected_declarant") return { to: r.confirm_email, subject: t("subjectRejected", lang), text: rejectedText(r, lang) };
  if (kind === "accepted_declarant" || kind === "accepted_account") {
    // "Your plan has ended" is true only once the end has been carried out (completed), never while it is being carried out (Astra WP8-2
    // #7); a later date asked for waits until then.
    if (r.status === "executing") return { wait: now + 10 * MINUTE };
    if (r.status === "open") return { wait: Math.max(now + MINUTE, r.effective_at ?? now + HOUR) };
    if (r.status !== "completed") return "skip";
  }
  if (kind === "accepted_declarant") return { to: r.confirm_email, subject: t("subjectAccepted", lang), text: await acceptedText(env, r, lang) };
  // The rest go to the ACCOUNT email, read now from the identity reader (never from a stale copy); no reader answer, no mail yet.
  const identity = await currentIdentity(env, d, r);
  if (!identity) return null;
  if (LINK_KINDS(kind)) {
    // The confirmation never depends on the link: no link can be issued (the hold is over, or used), the confirmation goes without it.
    let link: string | null = null;
    if (holdOpen(r, now)) {
      link = await holdLink(env, d, r, identity, claim);
      if (!link && claim && !await env.DB.prepare("SELECT 1 AS x FROM cancellation_mail WHERE id=? AND claim_id=?").bind(claim.mailId, claim.claimId).first()) return "lost";
    }
    // A replacement link that could not be issued while the hold is open is never dropped silently (Astra WP8-4 #3): not ready, retried
    // with backoff, and escalated by the delivery. Once the hold is over there is nothing left to replace.
    if (!link && kind !== "confirm_account") return holdOpen(r, now) ? null : "skip";
    return { to: identity.email, subject: t("subjectReceipt", lang), text: link ? `${base}\n\n${t("wasntMe", lang)}\n${t("wasntMeLink", lang)} ${link}` : base, gen: identity, link: link !== null };
  }
  if (kind === "held_account") return { to: identity.email, subject: t("subjectHeld", lang), text: t("heldMail", lang) };
  if (kind === "rejected_account") return { to: identity.email, subject: t("subjectRejected", lang), text: rejectedText(r, lang) };
  if (kind === "accepted_account") return { to: identity.email, subject: t("subjectAccepted", lang), text: await acceptedText(env, r, lang) };
  if (kind === "late_account") {
    // Execution and refund are told apart (Astra WP8-2 #7): "your service has ended" only once the end has been carried out; "we have
    // refunded it in full" only when every late refund has been submitted to Stripe and none has failed; a failed or delayed refund says
    // so. Each refund's own state follows as the ledger's line.
    if (r.status !== "completed") return r.status === "executing" ? { wait: now + 10 * MINUTE } : "skip";
    const ops = (await refundRows(env, `cxl-late:${r.id}:%`)).filter((o) => !nothingToRefund(o));
    if (ops.length === 0) return "skip";
    const path = await sellerPathOf(env, r);
    const states = ops.map((o) => refundState(o, path).status);
    if (states.includes("being_prepared")) return { wait: now + 10 * MINUTE };
    // Subject and body from the SAME ledger state (Astra WP8-3 #6): delayed in either means delayed in both.
    const delayed = states.includes("delayed");
    // A straddling renewal is refunded only for the time after the end (Astra WP8-3 #3): never "in full" then.
    // Astra JOURNEY-BCORE-3: an operator may refund less than the payment (record-only late charges): never "in full" then either.
    const part = ops.some((o) => (o.cutover_at !== null && o.cutover_at !== undefined) || (o.amount_cents !== null && o.amount_cents !== undefined
      && typeof o.paid_cents === "number" && o.amount_cents < o.paid_cents));
    const key: StringKey = part ? (delayed ? "lateMailPartDelayed" : "lateMailPart") : delayed ? "lateMailDelayed" : "lateMail";
    return { to: identity.email, subject: t(delayed ? "subjectLateDelayed" : "subjectLate", lang),
      text: [t(key, lang, { effective_at: fmtDate(r.effective_at ?? r.received_at, lang) }), ...ops.map((o) => refundLine(o, lang, path))].join("\n\n") };
  }
  return null;
}
const rejectedText = (r: CancellationRow, lang: Lang) => t("rejectedMail", lang, { received_at: fmtReceived(r.received_at, lang), period_end: fmtDate(r.fallback_end_at ?? r.effective_at ?? r.received_at, lang), note: r.reason_note ?? "" });
/** The accepted end, carried out: the refund's own state on its own line; an end with nothing paid after it says there is nothing to refund. */
async function acceptedText(env: Env, r: CancellationRow, lang: Lang): Promise<string> {
  const vars = { effective_at: fmtReceived(r.effective_at ?? r.received_at, lang) };
  const [op] = await refundRows(env, `cxl-ext:${r.id}`);
  if (op && nothingToRefund(op)) return t("acceptedMailNoRefund", lang, vars);
  const text = t("acceptedMail", lang, vars);
  return op ? `${text}\n\n${refundLine(op, lang, await sellerPathOf(env, r))}` : text;
}

/** The "This wasn't me" link: the token technique of public-tokens.ts bound to the request, the account and the account email. It acts until
 *  the hold's own end, hold_until (Astra WP8-2 #1: no 7-day limit, no extra click); while a reason is checked hold_until is open, so the link
 *  lasts a year past the latest date the declaration names (a backstop for the token row only: whether a press still holds is the
 *  cancellation's own state, checked in the same atomic transition). Minted only while the caller still holds its mail delivery. */
const PENDING_HOLD_CAP_MS = 365 * DAY;
const holdCap = (r: CancellationRow) => r.hold_until ?? Math.max(r.received_at, r.effective_at ?? 0, r.fallback_end_at ?? 0) + PENDING_HOLD_CAP_MS;
/** A link issued while the hold is open (holdLink is only called then) always gets a live expiry: hold_until, or while a reason is still being
 *  checked (no hold_until) the later of the original cap and a fresh, bounded REISSUE_HOLD_MS from now, so a replacement link can be issued
 *  however long the check takes (Astra WP8-4 #3). Only the token row's expiry moves: the declaration's legal dates are never touched, and a
 *  consumed link is never reissued (issueToken's used_at guard). */
const REISSUE_HOLD_MS = 30 * DAY;
const holdLinkCap = (r: CancellationRow, now: number) => r.hold_until ?? Math.max(holdCap(r), now + REISSUE_HOLD_MS);
async function holdLink(env: Env, d: CancellationDeps, r: CancellationRow, identity: Identity, claim?: Claim): Promise<string | null> {
  const token = await issueToken(env, d, { purpose: "repudiate", subjectKind: "cancellation", subjectId: r.id, accountId: r.supabase_sub!, accountEmail: identity.email,
    supabaseUpdatedAt: identity.updatedAt, receivedAt: r.received_at, capAt: holdLinkCap(r, clockOf(d)) },
  { throughCap: true, ...(claim ? { when: q("EXISTS (SELECT 1 FROM cancellation_mail WHERE id=? AND claim_id=?)", claim.mailId, claim.claimId) } : {}) });
  return token ? `${siteOrigin(env, d)}/verify#${token.token}` : null;
}

// --- retry payloads: envelope encryption ------------------------------------------------------------------------------------------------

/** A payload kept for retries carries a live hold link (a bearer token): it is stored only as an AES-GCM envelope (Astra WP8-2 #10). A fresh
 *  256-bit data key encrypts the payload; the key-encryption key, derived from the Worker secret CANCELLATION_MAIL_KEY, wraps the data key.
 *  Both are bound (AAD) to the delivery and the transition it was rendered for, so a payload copied to another row never opens. No secret:
 *  nothing is stored and a link mail is not sent (it fails closed and ops hears through the delivery's escalation). */
const enc = new TextEncoder();
const b64 = (u: Uint8Array) => { let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function mailKek(env: Env): Promise<CryptoKey | null> {
  const secret = (env as unknown as { CANCELLATION_MAIL_KEY?: string }).CANCELLATION_MAIL_KEY;
  if (!secret || secret.length < 32) return null;
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`murage/cancel-mail-kek/v1:${secret}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function sealPayload(env: Env, aad: string, value: RenderedMail): Promise<string | null> {
  const kek = await mailKek(env);
  if (!kek) return null;
  const dekRaw = crypto.getRandomValues(new Uint8Array(32));
  const dek = await crypto.subtle.importKey("raw", dekRaw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12)); const wiv = crypto.getRandomValues(new Uint8Array(12)); const ad = enc.encode(aad);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ad }, dek, enc.encode(JSON.stringify(value))));
  const wk = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: wiv, additionalData: ad }, kek, dekRaw));
  dekRaw.fill(0);
  return JSON.stringify({ v: 1, alg: "A256GCM", wk: b64(wk), wiv: b64(wiv), iv: b64(iv), ct: b64(ct) });
}
async function openPayload(env: Env, aad: string, sealed: string): Promise<RenderedMail | null> {
  try {
    const kek = await mailKek(env);
    const e = JSON.parse(sealed) as { v?: number; wk: string; wiv: string; iv: string; ct: string };
    if (!kek || e.v !== 1) return null;
    const ad = enc.encode(aad);
    const dekRaw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(e.wiv), additionalData: ad }, kek, unb64(e.wk)));
    const dek = await crypto.subtle.importKey("raw", dekRaw, "AES-GCM", false, ["decrypt"]);
    dekRaw.fill(0);
    const m = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(e.iv), additionalData: ad }, dek, unb64(e.ct)))) as RenderedMail;
    return m && typeof m.to === "string" && m.gen ? m : null;
  } catch { return null; }
}

/** The first retries are due at once (one submission can try a delivery twice: after the match and after the intake), then 2, 4, 8 ... minutes, at
 *  most 6 hours apart, for ever. */
const backoff = (attempts: number) => attempts < 3 ? 0 : Math.min(2 ** Math.min(attempts - 2, 20) * MINUTE, 6 * HOUR);

/** Sends every due mail (of one request, or all of them). The selection passes only ids on: each delivery is CLAIMED first (one sender; a
 *  crashed sender's claim lapses) and everything else (payload, attempts) is read after the claim, so a sender never acts on what it saw
 *  before another sender's attempt (Astra WP8-2 #3). A failure is retried with backoff for as long as it takes; ops hears once. */
export async function flushMail(env: Env, d: CancellationDeps, requestId?: string): Promise<number> {
  const now = clockOf(d);
  const ids = (await env.DB.prepare(`SELECT id FROM cancellation_mail WHERE sent_at IS NULL AND next_attempt_at<=? AND (claimed_until IS NULL OR claimed_until<=?)
      ${requestId ? "AND request_id=?" : ""} ORDER BY next_attempt_at, created_at LIMIT 50`)
    .bind(now, now, ...(requestId ? [requestId] : [])).all<{ id: string }>()).results;
  let sent = 0;
  for (const { id } of ids) if (await deliver(env, d, id, now)) sent += 1;
  return sent;
}

/** One delivery. A payload with a hold link is kept (sealed) for its retries so a retry never mints a second link that would void a first
 *  one already delivered; before it is sent again it must still be for the committed transition, the hold must still be open and the
 *  account's email generation must be the one it was rendered for (Astra WP8-2 #4): otherwise it is wiped and rendered anew. */
async function deliver(env: Env, d: CancellationDeps, id: string, now: number): Promise<boolean> {
  const claim = crypto.randomUUID();
  const won = await env.DB.prepare("UPDATE cancellation_mail SET claim_id=?, claimed_until=? WHERE id=? AND sent_at IS NULL AND next_attempt_at<=? AND (claimed_until IS NULL OR claimed_until<=?)")
    .bind(claim, now + CLAIM_MS, id, now, now).run();
  if (won.meta.changes !== 1) return false;
  const m = await env.DB.prepare("SELECT id,request_id,kind,attempts,payload_json,payload_op,escalated_at FROM cancellation_mail WHERE id=? AND claim_id=? AND sent_at IS NULL")
    .bind(id, claim).first<{ id: string; request_id: string; kind: string; attempts: number; payload_json: string | null; payload_op: string | null; escalated_at: number | null }>();
  if (!m) return false;
  const release = (sql: string, ...b: unknown[]) => env.DB.prepare(`UPDATE cancellation_mail SET ${sql}, claim_id=NULL, claimed_until=NULL WHERE id=? AND claim_id=?`).bind(...b, m.id, claim).run();
  const fail = async (why: string) => {
    const attempts = m.attempts + 1;
    await release("attempts=?, next_attempt_at=?, last_error=?", attempts, now + backoff(attempts), why);
    if (attempts >= MAIL_ESCALATE_AFTER && m.escalated_at === null) {
      const first = await env.DB.prepare("UPDATE cancellation_mail SET escalated_at=? WHERE id=? AND escalated_at IS NULL").bind(now, m.id).run();
      if (first.meta.changes === 1) await alert(env, `cx-mail:${m.id}`, "cancellation.mail_failing", "high", { id: m.request_id, kind: m.kind, attempts }, now).run();
    }
  };
  const wipe = "payload_json=NULL, payload_op=NULL";
  const r = await load(env, m.request_id);
  if (!r) { await release(`sent_at=?, last_error='no_request', ${wipe}`, now); return false; }
  let mail: RenderedMail | null = null;
  if (m.payload_json) {
    const cached = m.payload_op === r.last_op && holdOpen(r, now) ? await openPayload(env, `${m.id}|${m.payload_op}`, m.payload_json) : null;
    if (cached) {
      const identity = await currentIdentity(env, d, r);
      if (!identity) { await fail("not_ready"); return false; }
      if (identity.email === cached.gen!.email && identity.updatedAt === cached.gen!.updatedAt) mail = cached;
    }
    if (!mail) await env.DB.prepare(`UPDATE cancellation_mail SET ${wipe} WHERE id=? AND claim_id=?`).bind(m.id, claim).run();
  }
  if (!mail) {
    if (LINK_KINDS(m.kind) && holdOpen(r, now) && !await mailKek(env)) { await fail("mail_key_missing"); return false; }
    let rendered: Rendered = null;
    try { rendered = await renderMail(env, d, r, m.kind, now, { mailId: m.id, claimId: claim }); } catch { rendered = null; }
    if (rendered === "lost") return false;
    if (rendered === "skip") { await release(`sent_at=?, last_error='deduped', ${wipe}`, now); return false; }
    if (rendered && "wait" in rendered) { await release(`next_attempt_at=?, ${wipe}`, rendered.wait); return false; }
    if (!rendered) { await fail("not_ready"); return false; }
    mail = rendered;
    if (rendered.link) {
      const sealed = await sealPayload(env, `${m.id}|${r.last_op}`, rendered);
      if (!sealed) { await fail("mail_key_missing"); return false; }
      const kept = await env.DB.prepare("UPDATE cancellation_mail SET payload_json=?, payload_op=? WHERE id=? AND claim_id=?").bind(sealed, r.last_op, m.id, claim).run();
      if (kept.meta.changes !== 1) return false;          // another sender took the delivery over: it sends, not this one
    }
  }
  try {
    await mailer(env, d).send({ to: mail.to, from: { email: env.EMAIL_FROM, name: "Murage" }, subject: mail.subject, text: mail.text,
      html: `<!doctype html><html><body>${mail.text.split("\n\n").map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("")}</body></html>` });
  } catch {
    await fail("send_failed");
    return false;
  }
  await release(`sent_at=?, ${wipe}`, now);
  return true;
}

// --- references ----------------------------------------------------------------------------------------------------------------------------

/** Astra JOURNEY-A-2 A5: a customer only ever sees a CX- reference reserved in cancel_references (unique across the public form and the
 *  signed-in cancel). If none can be reserved now, the cancellation is recorded under its internal receipt id (its `ref` is that id, unique
 *  as the primary key is, and never a CX- number) and the sweep (allocatePendingReferences) retries; later mails carry the CX- reference once
 *  it is reserved. Cancelling never waits on this. */
async function referenceOrReceiptId(env: Env, requestId: string, now: number): Promise<string> {
  try { return await allocateCancelRef(env, `public:${requestId}`, now); } catch { return requestId; }
}
/** The sweep's retry: every cancellation still recorded under its receipt id gets a reserved CX- reference (only while it still has none). */
export async function allocatePendingReferences(env: Env, now: number): Promise<void> {
  const rows = await env.DB.prepare("SELECT id FROM cancellation_requests WHERE ref=id ORDER BY received_at LIMIT 50").all<{ id: string }>();
  for (const { id } of rows.results) {
    let ref: string;
    try { ref = await allocateCancelRef(env, `public:${id}`, now); } catch { return; } // nothing can be reserved right now: the next sweep tries again
    await env.DB.prepare("UPDATE cancellation_requests SET ref=?, updated_at=? WHERE id=? AND ref=id").bind(ref, now, id).run();
  }
}

// --- POST /v1/public/cancellation ---------------------------------------------------------------------------------------------------------

const emailField = z.string().trim().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
const submitSchema = z.strictObject({
  type: z.enum(["end_of_paid_month", "on_date", "now_for_cause"]),
  email: emailField,
  name: z.string().trim().min(1).max(200),
  identifier: z.string().trim().max(200).optional(),
  requestedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reason: z.string().trim().max(2000).optional(),
  confirmationEmail: emailField,
  language: z.enum(["en", "de"]).optional(),
});
const validYmd = (s: string) => { const ms = ymdToMs(s); return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s; };

/** Records the declaration and its receipt and answers 201 at once. Nothing account-dependent runs before the answer: matching, Stripe and the
 *  mails run in ctx.waitUntil (and the sweep for anything left), so neither the body nor the time nor a header differs between senders. */
async function submit(request: Request, env: Env, d: CancellationDeps, ctx?: ExecutionContext): Promise<Response> {
  const parsed = submitSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) return errorResponse(400, "invalid_request");
  const b = parsed.data;
  const now = clockOf(d);
  const kind = KIND_OF_TYPE[b.type];
  const today = fmtDate(now, "en");
  if (kind === "ordinary_date" && (!b.requestedDate || !validYmd(b.requestedDate) || b.requestedDate < today)) return errorResponse(400, "invalid_request");
  if (kind === "extraordinary" && !b.reason) return errorResponse(400, "invalid_request");
  if (kind === "extraordinary" && b.requestedDate && (!validYmd(b.requestedDate) || b.requestedDate < today)) return errorResponse(400, "invalid_request");
  const email = normEmail(b.email);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  // 5 an hour per IP and per email; the buckets hold keyed hashes, never an address.
  if (!await takeSlot(env, `cx-ip:${await keyed(env, ip)}`, REQUESTS_PER_HOUR, HOUR, now)
    || !await takeSlot(env, `cx-em:${await keyed(env, email)}`, REQUESTS_PER_HOUR, HOUR, now)) return errorResponse(429, "rate_limited");
  const language: Lang = b.language ?? ((request.headers.get("accept-language") ?? "").toLowerCase().startsWith("de") ? "de" : "en");
  const requestId = randomHex(16);
  // The reference comes from the allocator shared with the signed-in cancel (never the same CX- number twice); if it cannot be reserved the
  // declaration is still recorded, under its internal receipt id (never an unreserved CX- number), and the sweep retries the allocation.
  const ref = await referenceOrReceiptId(env, requestId, now);
  const fields: ReceiptFields = { id: requestId, ref, received_at: now, kind, requested_date: kind === "ordinary_earliest" ? null : b.requestedDate ?? null,
    reason: kind === "extraordinary" ? b.reason ?? null : null, entered_email: email, entered_name: b.name, identifier: b.identifier || null,
    confirm_email: normEmail(b.confirmationEmail), language };
  const receiptHtml = renderReceipt(fields);
  const receiptSha = await sha256(receiptHtml);
  const op = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO cancellation_requests (id,ref,received_at,fields_json,kind,requested_date,reason,entered_email,entered_name,identifier,confirm_email,language,claimed_ip,claimed_ua,
        receipt_sha256,receipt_html,last_op,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(fields.id, fields.ref, now, JSON.stringify({ ...b, email, confirmationEmail: fields.confirm_email }),
      kind, fields.requested_date, fields.reason, email, b.name, fields.identifier, fields.confirm_email, language, ip.slice(0, 64), (request.headers.get("user-agent") ?? "").slice(0, 300) || null,
      receiptSha, receiptHtml, op, now, now),
    env.DB.prepare("INSERT INTO cancellation_mail (id,request_id,kind,created_at) VALUES (?,?,?,?)").bind(`${fields.id}:receipt_declarant`, fields.id, "receipt_declarant", now),
  ]);
  if (ctx) ctx.waitUntil(processIntake(env, d, fields.id));
  // The answer never depends on the match: no account oracle (BUILD-PLAN WP8 "Done when"). `matched` is always false and `effectiveAt` always null;
  // the customer learns the exact date from the confirmation emails.
  return json({ id: fields.id, receivedAt: now, type: b.type, ...(fields.requested_date ? { requestedDate: fields.requested_date } : {}), effectiveAt: null, matched: false,
    receiptUrl: `/cancel/receipt/${fields.id}` }, 201);
}

const RECEIPT_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer" };
/** The receipt exactly as given at submission: the stored bytes, served only if they still hash to receipt_sha256. */
async function receipt(env: Env, d: CancellationDeps, id: string): Promise<Response> {
  const r = /^[0-9a-f]{32}$/.test(id) ? await load(env, id) : null;
  if (!r) return errorResponse(404, "not_found");
  const html = r.receipt_html ?? renderReceipt(r);
  if (await sha256(html) !== r.receipt_sha256) {
    await alert(env, `cx-receipt:${r.id}`, "cancellation.receipt_integrity", "high", { id: r.id }, clockOf(d)).run();
    return errorResponse(500, "receipt_unavailable");
  }
  return new Response(html, { status: 200, headers: RECEIPT_HEADERS });
}

async function publicCancellationRoute(request: Request, env: Env, tokenDeps: TokenDeps, ctx?: ExecutionContext): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const d: CancellationDeps = { ...injected, ...tokenDeps };
  if (path === "/v1/public/cancellation") return request.method === "POST" ? submit(request, env, d, ctx) : errorResponse(405, "method_not_allowed");
  const m = /^\/v1\/public\/cancellation\/([^/]+)\/receipt$/.exec(path);
  if (m) return request.method === "GET" ? receipt(env, d, m[1]) : errorResponse(405, "method_not_allowed");
  return null;
}

// --- due ends ----------------------------------------------------------------------------------------------------------------------------

/** An ordinary end (or a rejected serious reason) reaches effective_at: completed. An accepted serious reason reaches the time it asked for:
 *  executing (its refund operation ends the plan). Conditional UPDATEs; each a new op id, so Stripe is read back again. */
export async function completeDue(env: Env, d: CancellationDeps, id?: string): Promise<void> {
  const now = clockOf(d);
  const one = id ? " AND id=?" : "";
  const b = id ? [id] : [];
  await env.DB.batch([
    env.DB.prepare(`UPDATE cancellation_requests SET status='executing', stripe_synced=0, last_op=${NEW_OP}, updated_at=? WHERE status='open' AND kind='extraordinary'
      AND reason_decision='accept' AND effective_at IS NOT NULL AND effective_at<=?${one}`).bind(now, now, ...b),
    env.DB.prepare(`UPDATE cancellation_requests SET status='completed', completed_at=?, stripe_synced=0, last_op=${NEW_OP}, updated_at=? WHERE status='open'
      AND NOT (kind='extraordinary' AND reason_decision='accept') AND effective_at IS NOT NULL AND effective_at<=?${one}`).bind(now, now, now, ...b),
  ]);
}

// --- "This wasn't me" -------------------------------------------------------------------------------------------------------------------------

type Outcome = "held" | "too_late_executing" | "too_late_completed" | "refused";
/** From the committed state only. An open request past its effective_at is being ended (never called completed before it is). */
function outcomeOf(r: CancellationRow, now: number): Outcome {
  if (r.status === "held" || r.status === "kept") return "held";
  if (r.status === "executing") return "too_late_executing";
  if (r.status === "completed") return "too_late_completed";
  if (r.status === "open" && r.effective_at !== null && r.effective_at <= now) return "too_late_executing";
  return "refused";
}
/** The refund the end of this declaration owes, as the ledger has it now: the accepted end's own refund, else a late renewal's. */
async function refundOfRequest(env: Env, r: CancellationRow): Promise<RefundRow | null> {
  const ops = [...await refundRows(env, `cxl-ext:${r.id}`), ...await refundRows(env, `cxl-late:${r.id}:%`)].filter((o) => !nothingToRefund(o));
  return ops[0] ?? null;
}
/** The page's answer, from the committed state: the execution state (outcome) and, independently, the refund state (C3 `Refund`) with its
 *  line in the customer's words (Astra WP8-2 #7). */
async function outcomeBody(env: Env, r: CancellationRow, now: number): Promise<Response> {
  const outcome = outcomeOf(r, now);
  if (outcome === "refused") return errorResponse(409, "link_invalid", { canResend: false });
  const lang = r.language;
  const message = outcome === "held" ? t("heldMail", lang) : outcome === "too_late_executing" ? t("tooLateExecuting", lang)
    : t("tooLateCompleted", lang, { effective_at: fmtDate(r.effective_at ?? r.received_at, lang) });
  const body: { [k: string]: JSONValue } = { outcome, kind: "cancellation", message };
  if (outcome === "too_late_completed" && r.effective_at !== null) body.effectiveAt = r.effective_at;
  if (outcome === "too_late_completed" && r.completed_at !== null) body.completedAt = r.completed_at;
  if (outcome !== "held") {
    body.caseOpened = (await env.DB.prepare("SELECT 1 AS x FROM cancellation_cases WHERE request_id=?").bind(r.id).first()) !== null;
    const op = await refundOfRequest(env, r);
    if (op) {
      const path = await sellerPathOf(env, r);
      const st = refundState(op, path);
      body.refund = { status: st.status, ...(st.date !== undefined ? { date: st.date } : {}), path: st.path };
      body.refundLine = refundLine(op, lang, path);
    }
  }
  return json(body);
}
/** The committed state after letting a due end take effect first (so the copy is true). */
async function settledOutcome(env: Env, d: CancellationDeps, id: string, now: number): Promise<Response> {
  await completeDue(env, d, id);
  return outcomeBody(env, (await load(env, id))!, now);
}

/** The hold itself, run in the same batch as the token's consumption (conditioned on it): one conditional UPDATE on the request's status and
 *  hold_until, the case and the hold mail. Shared by a live link and a genuine one past its own expiry (both act until hold_until). */
function holdStatements(id: string, selector: string, opId: string, now: number): Q[] {
  return [
    q(`UPDATE cancellation_requests SET status='held', held_from=status, held_at=?, case_id=?, stripe_synced=0, last_op=?, updated_at=?, kept_by=NULL,
        keep_at=CASE WHEN kind='extraordinary' AND reason_decision IS NULL THEN fallback_end_at ELSE effective_at END
      WHERE id=? AND status IN ('open','reason_pending') AND (hold_until IS NULL OR hold_until>?) AND ${WHEN_CONSUMED}`, now, `case-${id}`, opId, now, id, now, selector, opId),
    q(`INSERT OR IGNORE INTO cancellation_cases (id,request_id,opened_at,reason) SELECT ?,?,?,? WHERE ${WHEN_CONSUMED}`, `case-${id}`, id, now, "wasnt_me", selector, opId),
    q(`INSERT OR IGNORE INTO cancellation_mail (id,request_id,kind,created_at) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM cancellation_requests WHERE id=? AND last_op=? AND status='held')`,
      `${id}:held_account`, id, "held_account", now, id, opId),
  ];
}

/** Press of the hold link. The token consumption, the hold (one conditional UPDATE on the request's status), the case and the mail are ONE
 *  fenced batch; the response renders the committed state, so the loser of the race with the immediate end is told what really happened. */
export const repudiateCancellation: PublicRouteHandler = async (env, result, call) => {
  void call;
  const row = result.row;
  if (row.subjectKind !== "cancellation") return null;
  const d = injected;
  const now = clockOf(d);
  const req = await load(env, row.subjectId);
  if (!req || !req.supabase_sub || req.supabase_sub !== row.accountId || !req.home_id) return errorResponse(409, "link_invalid", { canResend: false });
  // r2-4: a cancellation superseded by a withdrawal (or by the end of its contract) promises nothing any more: a replay of its used hold link
  // is refused, never answered "your plan continues".
  if (req.superseded_by) return errorResponse(409, "link_invalid", { canResend: false });
  if (!result.ok) return settledOutcome(env, d, req.id, now);          // already used: the committed state, nothing acted twice
  try {
    const { won } = await leased(env, req.home_id, (lease) => commitToken(env, result, { lease, extra: (v) => holdStatements(req.id, v.row.selector, v.opId, now) }));
    if (won) { await afterTransition(env, d, req.id); return settledOutcome(env, d, req.id, now); }
    // Lost the consume: classified on the commit's clock (WP7 lostCommitRefusal). Used by a concurrent press: the committed state; expired at
    // the commit: the expired-press handling; replaced or removed: refused.
    const lost = await lostCommitRefusal(env, result);
    if (lost.code === "link_used") return settledOutcome(env, d, req.id, now);
    if (lost.code === "link_expired") return (await expiredCancellation(env, row, "repudiate")) ?? errorResponse(409, "link_expired", { canResend: true });
    return errorResponse(409, "link_invalid", { canResend: false });
  } catch (e) {
    if (e instanceof HomeBusy || e instanceof LeaseLost) return errorResponse(503, "home_busy");
    throw e;
  }
};

/** A fresh hold link to the CURRENT account email (the confirmation mail again, with a new link), queued for the outbox. */
async function queueRelink(env: Env, d: CancellationDeps, r: CancellationRow, now: number): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO cancellation_mail (id,request_id,kind,created_at) VALUES (?,?,?,?)").bind(`${r.id}:relink_account:${now}`, r.id, `relink_account:${now}`, now).run();
  await flushMail(env, d, r.id);
}
/** A genuine hold link pressed after its own expiry (a link issued before r2 lasted 7 days). The hold lasts until hold_until, so while it
 *  is open the press HOLDS, with no further click (Astra WP8-2 #1): the account's current identity is verified against the link exactly as
 *  for a live one (email and Supabase updated_at unchanged), and the same atomic transition runs, consuming the link in its batch. Once the
 *  hold is over, a case is opened and the page shows the committed state (the end took effect, or is being carried out). */
async function expiredCancellation(env: Env, row: TokenRow, purpose: TokenPurpose): Promise<Response | null> {
  if (row.subjectKind !== "cancellation" || purpose !== "repudiate") return null;
  const d = injected;
  const now = clockOf(d);
  const r = await load(env, row.subjectId);
  if (!r || !r.supabase_sub || r.supabase_sub !== row.accountId || !r.home_id) return null;
  if (r.superseded_by) return errorResponse(409, "link_invalid", { canResend: false });     // r2-4
  if (!holdOpen(r, now)) {
    await env.DB.prepare("INSERT OR IGNORE INTO cancellation_cases (id,request_id,opened_at,reason) VALUES (?,?,?,?)").bind(`case-${r.id}`, r.id, now, "wasnt_me_expired_link").run();
    return settledOutcome(env, d, r.id, now);
  }
  if (row.usedAt !== null) return settledOutcome(env, d, r.id, now);
  const identity = await currentIdentity(env, d, r);
  if (!identity) return errorResponse(503, "identity_unavailable");
  if (identity.email !== row.email || identity.updatedAt !== row.emailGen) return errorResponse(409, "identity_changed", { canResend: true });
  const opId = crypto.randomUUID();
  try {
    const won = await leased(env, r.home_id, async (lease) => (await fencedBatch(env, lease, [
      q("UPDATE verify_tokens SET used_at=?, used_by=? WHERE selector=? AND hmac=? AND email=? AND email_gen=? AND used_at IS NULL", now, opId, row.selector, row.hmac, row.email, row.emailGen),
      ...holdStatements(r.id, row.selector, opId, now),
    ]))[0].meta.changes === 1);
    if (won) await afterTransition(env, d, r.id);
    else if (!await env.DB.prepare("SELECT 1 AS x FROM verify_tokens WHERE selector=? AND hmac=? AND used_at IS NOT NULL").bind(row.selector, row.hmac).first()) {
      return errorResponse(409, "link_invalid", { canResend: false });   // replaced by a reissue meanwhile
    }
    return settledOutcome(env, d, r.id, now);
  } catch (e) {
    if (e instanceof HomeBusy || e instanceof LeaseLost) return errorResponse(503, "home_busy");
    throw e;
  }
}

// --- the reason check, found-valid, "Keep my plan" and attribution by the operator ------------------------------------------------------------

/** The refund operation that ends an accepted immediate termination and refunds the unused days (kind extraordinary, frozen values). */
async function ensureExecution(env: Env, d: CancellationDeps, id: string): Promise<void> {
  const r = await load(env, id);
  if (!r || r.status !== "executing" || !r.home_id || !r.subscription_id || r.effective_at === null || !r.account_id) return;
  const stripe = stripeOf(env, d);
  if (!stripe) return;
  const opId = `cxl-ext:${r.id}`;
  const now = clockOf(d);
  if (!await env.DB.prepare("SELECT 1 AS x FROM refund_ops WHERE id=?").bind(opId).first()) {
    // Drafts a reason check's pause held back are settled against the legal end first (voided: never owed after it), so nothing can be
    // collected for the time after the end once the plan is cancelled (Astra WP8-2 P2 #8). The obligations stay OPEN through the
    // cancellation (close=false): it switches collection off again on what was released here (Astra WP8-4 #1).
    let settled = false;
    try { settled = await withHomeLease(env, r.home_id, (lease) => settleDrafts(env, stripe, lease, r.subscription_id!, r.home_id!, r.effective_at!, now, false)); }
    catch (e) { if (!(e instanceof HomeBusy || e instanceof LeaseLost || e instanceof StripeError)) throw e; }
    if (!settled) return;                                          // the sweep comes back
    const eff = r.effective_at;
    const withPeriod = (await stripe.listSubscriptionInvoices(r.subscription_id, "paid")).map((i) => ({ i, p: i.lines?.data?.[0]?.period }))
      .filter((x) => typeof x.p?.start === "number" && typeof x.p?.end === "number");
    const covering = withPeriod.filter((x) => x.i.amount_paid > 0 && x.p!.start! * 1000 <= eff && eff < x.p!.end! * 1000).sort((a, b) => b.i.created - a.i.created)[0];
    // No paid invoice covers effective_at (the time was inside a period a pause held back, or never paid): EVERY paid invoice was read
    // (complete pagination), so nothing is refundable. Settled explicitly at zero: the operation is frozen on the last paid period that
    // ended at or before effective_at, whose unused fraction is 0, so it ends the plan and decides 0 instead of waiting for frozen values
    // for ever (Astra WP8-2 P2 #8).
    const before = covering ? null : withPeriod.filter((x) => x.p!.end! * 1000 <= eff).sort((a, b) => b.p!.end! - a.p!.end! || b.i.created - a.i.created)[0] ?? null;
    const frozen = covering ?? before;
    if (!frozen) {
      await alert(env, `cx-req:${r.id}`, "cancellation.execution_unsettled", "high", { id: r.id, why: "no_invoice" }, now).run();
      return;
    }
    const path = await sellerPathOf(env, r);
    const [sql, binds] = refundOpInsert({ id: opId, kind: "extraordinary", homeId: r.home_id, userId: r.account_id, invoiceId: frozen.i.id, endPlan: true,
      cancelSubscriptionId: r.subscription_id, subscriptionId: r.subscription_id, inheritSubscription: false, detail: { path, revoke: false, ...(covering ? {} : { zeroRefundable: true }) },
      frozen: { cutoverAt: eff, oldInvoiceId: frozen.i.id, oldPeriodStart: frozen.p!.start! * 1000, oldPeriodEnd: frozen.p!.end! * 1000 } }, now);
    await env.DB.prepare(sql).bind(...(binds ?? [])).run();
  }
  const billing = d.billing ?? {};
  const ctx: RefundContext = { stripe, flux: billing.flux ?? stubFluxHooks, deps: billing, now };
  try { await advanceRefundOp(env, ctx, opId); } catch { /* the refund sweep continues it */ }
  const op = await env.DB.prepare("SELECT canceled_at FROM refund_ops WHERE id=?").bind(opId).first<{ canceled_at: number | null }>();
  if (!op?.canceled_at) return;
  // Cancelled: Stripe has switched auto_advance off on every draft and open invoice. What is still owed (time before the end) is released
  // again and read back, and only then are the obligations closed (Astra WP8-4 #1). A failure leaves them open: the reconciliation of the
  // completed request settles them on its next pass (settleDrafts escalates a failure that persists).
  try { await withHomeLease(env, r.home_id, (lease) => settleDrafts(env, stripe, lease, r.subscription_id!, r.home_id!, r.effective_at!, clockOf(d))); }
  catch { console.error(JSON.stringify({ message: "cancellation drafts after the end left open" })); }
  await env.DB.prepare(`UPDATE cancellation_requests SET status='completed', completed_at=?, stripe_synced=0, last_op=${NEW_OP}, updated_at=? WHERE id=? AND status='executing'`).bind(now, now, id).run();
}

export type ReasonResult = { ok: true; status: Status } | { ok: false; code: "not_found" | "not_reason_pending" | "busy" | "note_required" | "kept_by_customer" };
/** The operator's decision on the serious reason: ONE conditional UPDATE from reason_pending (the same transition "This wasn't me" competes for).
 *  accept: carried out now if the time asked for has come, else at that time (never early). reject: needs the reason why; the declaration ends
 *  the plan at the end of the paid month current at received_at. */
export async function decideReason(env: Env, d: CancellationDeps, id: string, decision: "accept" | "reject", note: string): Promise<ReasonResult> {
  if (decision === "reject" && !note.trim()) return { ok: false, code: "note_required" };
  const r = await load(env, id);
  if (!r) return { ok: false, code: "not_found" };
  if (r.status !== "reason_pending" || !r.home_id) return { ok: false, code: "not_reason_pending" };
  const now = clockOf(d);
  const op = crypto.randomUUID();
  const stmts: Q[] = decision === "accept"
    ? [q(`UPDATE cancellation_requests SET status=CASE WHEN effective_at<=? THEN 'executing' ELSE 'open' END, reason_decision='accept', reason_decided_at=?, reason_note=?,
          hold_until=CASE WHEN effective_at<=? THEN NULL ELSE effective_at END, stripe_synced=0, last_op=?, updated_at=? WHERE id=? AND status='reason_pending'`, now, now, note, now, op, now, id),
      mailInsert(id, "accepted_declarant", now, op), mailInsert(id, "accepted_account", now, op)]
    : [q(`UPDATE cancellation_requests SET status='open', reason_decision='reject', reason_decided_at=?, reason_note=?, effective_at=fallback_end_at, hold_until=fallback_end_at, stripe_synced=0, last_op=?, updated_at=?
        WHERE id=? AND status='reason_pending'`, now, note, op, now, id),
      mailInsert(id, "rejected_declarant", now, op), mailInsert(id, "rejected_account", now, op)];
  stmts.push(...publicResolutionQ(id, op, now)); // JOURNEY-BCORE-2 #1: a rejected reason's end (the fallback) is promised in this same batch
  let won = false;
  try { won = await leased(env, r.home_id, async (lease) => (await fencedBatch(env, lease, stmts))[0].meta.changes === 1); }
  catch (e) { if (e instanceof HomeBusy || e instanceof LeaseLost) return { ok: false, code: "busy" }; throw e; }
  if (!won) return { ok: false, code: "not_reason_pending" };    // "This wasn't me" got there first
  await completeDue(env, d, id);
  await ensureExecution(env, d, id);
  await afterTransition(env, d, id);
  return { ok: true, status: (await load(env, id))!.status };
}

/** A held declaration was found valid (for example support identified the declarant as entitled to cancel), also after it closed as kept
 *  because nobody answered (kept_by 'timeout'): it keeps its original received_at, effective_at and decision, with no renewed consent. It
 *  goes back where the hold found it: a reason check still undecided resumes; anything else is open again if its end is ahead, else ends now
 *  (an accepted serious reason through its refund operation) and every renewal collected after effective_at is refunded. A rejected reason
 *  is never checked again. The customer's own "Keep my plan" is final: a declaration they kept never reopens (Astra WP8-2 #5). */
export async function resumeHeld(env: Env, d: CancellationDeps, id: string): Promise<ReasonResult> {
  const r = await load(env, id);
  if (!r) return { ok: false, code: "not_found" };
  if (r.status === "kept" && r.kept_by === "customer") return { ok: false, code: "kept_by_customer" };
  if ((r.status !== "held" && !(r.status === "kept" && r.kept_by === "timeout")) || !r.home_id || r.effective_at === null) return { ok: false, code: "not_reason_pending" };
  const now = clockOf(d);
  const op = crypto.randomUUID();
  const next: Status = r.held_from === "reason_pending" ? "reason_pending"
    : r.effective_at > now ? "open"
      : r.kind === "extraordinary" && r.reason_decision === "accept" ? "executing" : "completed";
  let won = false;
  try {
    won = await leased(env, r.home_id, async (lease) => (await fencedBatch(env, lease, [q(
      `UPDATE cancellation_requests SET status=?, hold_until=CASE WHEN ?='open' THEN effective_at ELSE NULL END, completed_at=CASE WHEN ?='completed' THEN ? END, held_at=NULL, keep_at=NULL,
        kept_by=NULL, stripe_synced=0, last_op=?, updated_at=? WHERE id=? AND status=? AND (status='held' OR kept_by='timeout')`, next, next, next, now, op, now, id, r.status),
      ...publicResolutionQ(id, op, now)]))[0].meta.changes === 1);
  } catch (e) { if (e instanceof HomeBusy || e instanceof LeaseLost) return { ok: false, code: "busy" }; throw e; }
  if (!won) {
    const now2 = await load(env, id);
    return { ok: false, code: now2?.status === "kept" && now2.kept_by === "customer" ? "kept_by_customer" : "not_reason_pending" };
  }
  await env.DB.prepare("UPDATE cancellation_cases SET closed_at=?, outcome='found_valid' WHERE request_id=? AND (closed_at IS NULL OR outcome='kept') AND outcome IS NOT 'kept_by_customer'").bind(now, id).run();
  if (next === "executing") await ensureExecution(env, d, id);
  await afterTransition(env, d, id);
  return { ok: true, status: next };
}

export type KeepResult = { ok: true; status: Status; stripeConfirmed: boolean } | { ok: false; code: "not_found" | "not_keepable" | "already_kept" | "too_late" | "busy" };
type Refusal = Extract<KeepResult, { ok: false }>;

/** Whether the home and subscription a Keep acts on are STILL what it was asked for, read under the home's lease (Astra JOURNEY-B-1 #2): the
 *  caller owns the home now (not_found otherwise, deliberately the same as an unknown id), the cancellation's subscription is the home's
 *  current (retained) one (a replaced contract's cancellation is not_keepable), that subscription has not ended (too_late), and the Cloud is
 *  neither being deleted nor waiting for its deletion (the 72 h hold): keeping would charge for a Cloud that is going away (not_keepable). */
async function keepRefusal(env: Env, homeId: string, userId: string, subscriptionId: string | null): Promise<Refusal | null> {
  const home = await env.DB.prepare("SELECT owner_id,desired_state FROM cloud_homes WHERE id=?").bind(homeId).first<{ owner_id: string; desired_state: string }>();
  if (!home || home.owner_id !== userId) return { ok: false, code: "not_found" };
  const sub = await getSub(env, homeId);
  if (!sub?.subscription_id || !subscriptionId || sub.subscription_id !== subscriptionId) return { ok: false, code: "not_keepable" };
  if (sub.status === "canceled" || sub.status === "disputed") return { ok: false, code: "too_late" };
  if (["deleting", "deleted"].includes(home.desired_state) || await env.DB.prepare(`SELECT 1 AS x FROM cloud_recovery_holds WHERE home_id=? AND action='delete'
    AND completed_at IS NULL AND canceled_at IS NULL`).bind(homeId).first()) return { ok: false, code: "not_keepable" };
  return null;
}
/** keepRefusal's conditions inside the keep's own write (the row aliased `x` carries home_id and subscription_id), so the batch never applies
 *  to a home that changed between the read and the write. */
const KEEP_STILL_VALID = (x: string) => `EXISTS (SELECT 1 FROM cloud_homes kh JOIN billing_subscriptions kb ON kb.home_id=kh.id WHERE kh.id=${x}.home_id AND kh.owner_id=?
  AND kh.desired_state NOT IN ('deleting','deleted') AND kb.subscription_id=${x}.subscription_id AND kb.status NOT IN ('canceled','disputed'))
  AND NOT EXISTS (SELECT 1 FROM cloud_recovery_holds kd WHERE kd.home_id=${x}.home_id AND kd.action='delete' AND kd.completed_at IS NULL AND kd.canceled_at IS NULL)`;
/** The keep of public declarations `ids` (all this user's, all keepable now) as statements for ONE batch: each closed as kept (kept_by
 *  customer) with its case, under one op, and only while the home and subscription are still valid for a Keep (KEEP_STILL_VALID). The first
 *  is the one the customer pressed; the others ride along (Astra CANCEL-SUMMARY-2 #1). */
function keepDeclStmts(ids: string[], userId: string, now: number, op: string, guard: { sql: string; binds: unknown[] } = { sql: "1", binds: [] }): Q[] {
  return ids.flatMap((id) => [
    // Astra JOURNEY-BCORE-5 #5: while parked (keepableBy's rule) also after its date, and also once marked completed.
    q(`UPDATE cancellation_requests SET status='kept', kept_by='customer', completed_at=?, stripe_synced=0, last_op=?, updated_at=? WHERE id=? AND account_id=?
        AND (status IN ('open','held') AND effective_at>? OR status IN ('open','held','completed') AND effective_at IS NOT NULL AND ${parkedSql("cancellation_requests.subscription_id")})
        AND NOT (kind='extraordinary' AND reason_decision IS NOT 'reject') AND ${KEEP_STILL_VALID("cancellation_requests")} AND ${guard.sql}`,
    now, op, now, id, userId, now, userId, ...guard.binds),
    q("UPDATE cancellation_cases SET closed_at=?, outcome='kept_by_customer' WHERE request_id=? AND closed_at IS NULL AND EXISTS (SELECT 1 FROM cancellation_requests WHERE id=? AND last_op=?)", now, id, id, op),
  ]);
}
/** The other public declarations of `subscriptionId` this user can keep now (keepableBy, the summary's rule). */
async function otherKeepable(env: Env, subscriptionId: string, userId: string, now: number, except: string | null): Promise<string[]> {
  const parked = await scheduleParked(env, subscriptionId);
  return (await env.DB.prepare(openDeclarationsSql("?")).bind(subscriptionId).all<OpenDeclaration>()).results
    .filter((x) => x.id !== except && keepableBy(x, userId, now, parked)).map((x) => x.id);
}
/** Astra CANCEL-SUMMARY-2 #1: whether the plan now RENEWS, the subscription as a whole: nothing local still ends it (no running or completed
 *  declaration, no kept one Stripe has not confirmed, no in-app intent, no unsynced revision, not canceled), and Stripe, read now, shows
 *  it active with no end. Only then does Keep answer stripeConfirmed true. Astra JOURNEY-BCORE-6 #3: run under the home's lease; a read that
 *  shows the subscription ENDED is persisted there (markEndedQ) and reported (`ended`): the Keep then answers too_late. */
export async function renewsAgain(env: Env, stripe: StripeClient | null, subscriptionId: string, at: { lease: HomeLease; homeId: string; now: number }):
  Promise<{ renews: boolean; ended: boolean }> {
  const no = { renews: false, ended: false };
  const sub = await env.DB.prepare("SELECT status,customer_cancel_at,cancel_intent_rev,cancel_synced_rev FROM billing_subscriptions WHERE subscription_id=?").bind(subscriptionId)
    .first<{ status: string; customer_cancel_at: number | null; cancel_intent_rev: number; cancel_synced_rev: number }>();
  if (sub && (sub.status === "canceled" || sub.status === "disputed")) return { renews: false, ended: true };
  if (!stripe) return no;
  let got: Got;
  try { await fence(env, at.lease); got = await stripe.getSubscription(subscriptionId); }
  catch (e) { if (e instanceof LeaseLost) throw e; return no; }
  if (endedAtStripe(got)) { await fencedBatch(env, at.lease, [markEndedQ(at.homeId, subscriptionId, at.now)]); return { renews: false, ended: true }; }
  if (!sub || sub.customer_cancel_at !== null || sub.cancel_intent_rev !== sub.cancel_synced_rev) return no;
  if (await env.DB.prepare(`SELECT 1 AS x FROM cancellation_requests WHERE subscription_id=? AND match_state='matched'
    AND (status IN ('open','reason_pending','held','executing','completed') OR (status='kept' AND stripe_synced=0))`).bind(subscriptionId).first()) return no;
  return { renews: got.cancel_at_period_end !== true && !(typeof got.cancel_at === "number" && got.cancel_at > 0), ended: false };
}
/** A subscription that has ended (canceled, disputed) can never renew again (Stripe cannot reactivate it): Keep answers too_late. */
async function terminalSub(env: Env, subscriptionId: string | null): Promise<boolean> {
  if (!subscriptionId) return false;
  const s = await env.DB.prepare("SELECT status FROM billing_subscriptions WHERE subscription_id=?").bind(subscriptionId).first<{ status: string }>();
  return s?.status === "canceled" || s?.status === "disputed";
}
/** The CX reference of the in-app cancellation of exactly this home's `subscriptionId` (never another contract's), or null. */
async function inAppRefOf(env: Env, homeId: string, subscriptionId: string): Promise<string | null> {
  return (await env.DB.prepare("SELECT reference AS r FROM plan_cancellations WHERE home_id=? AND subscription_id=?").bind(homeId, subscriptionId)
    .first<{ r: string }>())?.r ?? null;
}

/** "Keep my plan" (plan 5.2): the signed-in owner takes back an end-of-month or chosen-date cancellation (a rejected serious reason is one)
 *  before effective_at. Closed as kept (kept_by customer) through the same transition rules and the same subscription reconciliation.
 *  Astra CANCEL-SUMMARY-2 #1: one customer action keeps EVERY cancellation of the plan this customer can keep now (the other public
 *  declarations, and an in-app cancellation), a terminal subscription is refused (too_late), and stripeConfirmed is the subscription's
 *  aggregate outcome (renewsAgain), never one declaration's. Astra JOURNEY-B-1: ownership, the retained subscription and the deletion state
 *  are validated under the lease and inside the write (#2), only THIS subscription's cancellations are aggregated (#2), Stripe's live terminal
 *  state is read under the lease and persisted (#10, BCORE-4 #8). Astra JOURNEY-B-2 #4: every reversal commits in ONE batch with the
 *  pressed one (keepTogether). */
export async function keepPlan(env: Env, d: CancellationDeps, id: string, userId: string): Promise<KeepResult> {
  const r = await load(env, id);
  if (!r || r.account_id !== userId || !r.home_id) return { ok: false, code: "not_found" };
  const now = clockOf(d);
  if (r.status === "kept") return { ok: false, code: "already_kept" };
  if (await terminalSub(env, r.subscription_id)) return { ok: false, code: "too_late" };
  if (!r.subscription_id) return { ok: false, code: "not_keepable" };
  // Astra JOURNEY-BCORE-5 #5: parked on a schedule, Stripe is still active: the owner's local Keep stays allowed after the date (keepableBy).
  const parked = await scheduleParked(env, r.subscription_id);
  if (r.status !== "open" && r.status !== "held" && !(parked && r.status === "completed")) return { ok: false, code: "not_keepable" };
  if (r.kind === "extraordinary" && r.reason_decision !== "reject") return { ok: false, code: "not_keepable" };
  if (r.effective_at === null || (r.effective_at <= now && !parked)) return { ok: false, code: "too_late" };
  // Astra JOURNEY-BCORE-4 #8: Stripe's live end is read INSIDE the lease (keepTogether), where it is persisted before too_late is answered.
  return keepTogether(env, d, { homeId: r.home_id, subscriptionId: r.subscription_id, userId, now, press: { kind: "public", id } });
}

/** B5: Keep my plan for an IN-APP cancellation (Cancel plan, or the plan end a deletion journaled), by its CX reference (plan_cancellations,
 *  lane A's receipt). The same answers as keepPlan: not_found (unknown, or not this user's: deliberately the same), too_late (the plan's end
 *  has passed or the plan has ended, also at Stripe now), already_kept, not_keepable (no in-app cancellation is running for it, its
 *  subscription was replaced, or the Cloud is being deleted or its deletion waits: keeping would charge for a Cloud that is going away), busy.
 *  Under the home's lease the journaled intent is cleared (a new revision, the final "terminal" mark lifted) and the keep recorded with that
 *  revision, then synced to Stripe exactly like a cancel (syncCancellation: cancel_at_period_end false, read back). The customer's keepable
 *  public declarations of the same plan are kept in the SAME batch (Astra JOURNEY-B-2 #4), and stripeConfirmed is the aggregate outcome. */
export async function keepInApp(env: Env, deps: BillingDependencies, reference: string, userId: string, now: number): Promise<KeepResult> {
  const d: CancellationDeps = { ...injected, billing: { ...(injected.billing ?? {}), ...deps }, ...(deps.now ? { now: deps.now } : {}) };
  const row = await env.DB.prepare("SELECT reference,home_id,user_id,subscription_id FROM plan_cancellations WHERE reference=?").bind(reference)
    .first<{ reference: string; home_id: string; user_id: string; subscription_id: string }>();
  if (!row || row.user_id !== userId) return { ok: false, code: "not_found" };
  const alreadyKept = async () => (await env.DB.prepare("SELECT 1 AS x FROM plan_cancellation_keeps WHERE reference=?").bind(reference).first()) !== null;
  const pre = await keepRefusal(env, row.home_id, userId, row.subscription_id);
  if (pre && pre.code !== "not_keepable") return pre;
  const sub0 = await getSub(env, row.home_id);
  if (sub0 && sub0.subscription_id === row.subscription_id) {
    const end = sub0.current_period_end ?? sub0.first_charge_at;
    if (end !== null && end <= now && !await scheduleParked(env, row.subscription_id)) return { ok: false, code: "too_late" };
    if (sub0.customer_cancel_at === null) return { ok: false, code: await alreadyKept() ? "already_kept" : "not_keepable" };
  }
  if (pre) return pre;
  return keepTogether(env, d, { homeId: row.home_id, subscriptionId: row.subscription_id, userId, now, press: { kind: "in_app", reference } });
}

type KeepPress = { kind: "public"; id: string } | { kind: "in_app"; reference: string };
/** Astra JOURNEY-B-2 #4: ONE customer Keep takes back every cancellation of the plan this customer can keep now, the pressed one and the
 *  others (public declarations, the in-app intent), in ONE fenced batch under ONE lease: all of them or none. Lease contention (busy) commits
 *  nothing, so a retry finds everything still to keep, never a half-kept plan answering already_kept. Every other reversal is guarded by the
 *  pressed one's success inside the batch. Stripe is then told: the in-app clear synced under the same lease, the public ones by their own
 *  transition (afterTransition); anything Stripe did not confirm is finished by the sweeps (cancel_intent_rev, stripe_synced=0). */
async function keepTogether(env: Env, d: CancellationDeps, a: { homeId: string; subscriptionId: string; userId: string; now: number; press: KeepPress }): Promise<KeepResult> {
  const { homeId, subscriptionId, userId, now, press } = a;
  const billing = d.billing ?? {};
  const op = crypto.randomUUID();
  const alreadyKept = async () => press.kind === "public" ? (await load(env, press.id))?.status === "kept"
    : (await env.DB.prepare("SELECT 1 AS x FROM plan_cancellation_keeps WHERE reference=?").bind(press.reference).first()) !== null;
  let outcome: KeepResult = { ok: false, code: "not_keepable" };
  let kept: string[] = [];
  try {
    await leased(env, homeId, async (lease) => {
      const refused = await keepRefusal(env, homeId, userId, subscriptionId);
      if (refused) { outcome = refused; return; }
      // Astra JOURNEY-BCORE-3 #4: the terminal check INSIDE the lease. A resolution that ended the subscription between the caller's precheck and
      // this lease (it holds the same lease) has resolved its row and marked the subscription ended; Stripe, read now, is asked too. An end
      // discovered here is persisted locally and the Keep is refused too_late: a Keep never acknowledges an already-ended plan.
      const endedHere = (await env.DB.prepare("SELECT 1 AS x FROM cancel_resolutions WHERE subscription_id=? AND state IN ('terminated','resolved')").bind(subscriptionId).first()) !== null;
      const stripeNow = stripeOf(env, d);
      let endedLive = false;
      // Astra JOURNEY-BCORE-5 #3: a failed read leaves the end UNKNOWN (never "not ended"): it is asked again after the commit.
      let liveUnknown = !stripeNow;
      if (stripeNow) { await fence(env, lease); try { endedLive = endedAtStripe(await stripeNow.getSubscription(subscriptionId)); } catch { liveUnknown = true; } }
      if (endedHere || endedLive) {
        if (endedLive) await fencedBatch(env, lease, [markEndedQ(homeId, subscriptionId, now)]);
        outcome = { ok: false, code: "too_late" };
        return;
      }
      const sub = (await getSub(env, homeId))!;
      // Astra JOURNEY-BCORE-5 #5: parked, Stripe is still active: the local withdrawal is allowed after the period end too.
      const parked = await scheduleParked(env, subscriptionId);
      const end = parked ? null : sub.current_period_end ?? sub.first_charge_at;
      const ref = await inAppRefOf(env, homeId, subscriptionId);
      const refOwner = ref ? (await env.DB.prepare("SELECT user_id AS u FROM plan_cancellations WHERE reference=?").bind(ref).first<{ u: string }>())?.u ?? null : null;
      const inAppKeepable = ref !== null && refOwner === userId && sub.customer_cancel_at !== null && (end === null || end > now);
      if (press.kind === "in_app") {
        if (end !== null && end <= now) { outcome = { ok: false, code: "too_late" }; return; }
        if (press.reference !== ref || !inAppKeepable) { outcome = { ok: false, code: await alreadyKept() ? "already_kept" : "not_keepable" }; return; }
      }
      const publics = await otherKeepable(env, subscriptionId, userId, now, null);
      if (press.kind === "public" && !publics.includes(press.id)) { outcome = { ok: false, code: await alreadyKept() ? "already_kept" : "not_keepable" }; return; }
      const rev = sub.cancel_intent_rev;
      const pressedGuard = press.kind === "public"
        ? { sql: "EXISTS (SELECT 1 FROM cancellation_requests WHERE id=? AND last_op=? AND status='kept')", binds: [press.id, op] as unknown[] }
        : { sql: "EXISTS (SELECT 1 FROM plan_cancellation_keeps WHERE reference=? AND revision=?)", binds: [ref, rev + 1] as unknown[] };
      const g = press.kind === "public" ? pressedGuard : { sql: "1", binds: [] as unknown[] };
      // The in-app clear: a new revision, applied only to the revision read here; its keep record carries that revision (#4, #12).
      const inAppStmts: Q[] = inAppKeepable ? [
        q(`UPDATE billing_subscriptions SET customer_cancel_at=NULL,cancel_terminal_sub=NULL,cancel_intent_rev=cancel_intent_rev+1,updated_at=?
          WHERE home_id=? AND subscription_id=? AND customer_cancel_at IS NOT NULL AND cancel_intent_rev=? AND ${g.sql}`, now, homeId, subscriptionId, rev, ...g.binds),
        q("INSERT INTO plan_cancellation_keeps (reference,user_id,kept_at,revision) SELECT ?,?,?,? WHERE changes()=1", ref, userId, now, rev + 1),
      ] : [];
      const pressedDecl = press.kind === "public" ? keepDeclStmts([press.id], userId, now, op) : [];
      const others = publics.filter((x) => press.kind !== "public" || x !== press.id);
      // Astra JOURNEY-BCORE-2 #1: every reversal withdraws its generation's resolution in the SAME batch (appended last: the indices above stay).
      const withdrawals: Q[] = [...(inAppKeepable ? [withdrawInAppResolutionQ(subscriptionId, sub.customer_cancel_at!, ref!, rev + 1, now)] : []),
        ...(press.kind === "public" ? [withdrawPublicResolutionQ(press.id, op, now)] : []), ...others.map((x) => withdrawPublicResolutionQ(x, op, now))];
      const stmts = [...pressedDecl, ...inAppStmts, ...keepDeclStmts(others, userId, now, op, pressedGuard), ...withdrawals];
      const res = await fencedBatch(env, lease, stmts);
      const pressedOk = res[0].meta.changes === 1; // the pressed one is first: its declaration, or the in-app clear
      if (!pressedOk) { outcome = { ok: false, code: await alreadyKept() ? "already_kept" : "not_keepable" }; return; }
      const base = pressedDecl.length + inAppStmts.length;
      kept = [...(press.kind === "public" ? [press.id] : []), ...others.filter((_, i) => res[base + 2 * i].meta.changes === 1)];
      outcome = { ok: true, status: "kept", stripeConfirmed: false };
      if (inAppStmts.length && res[pressedDecl.length].meta.changes === 1) {
        try { await syncCancellation(env, { ...billing, lease }, homeId, lease); }
        catch (e) { if (!(e instanceof StripeError || e instanceof CancelUnconfirmed || e instanceof LeaseLost)) throw e; }
      }
      // Astra JOURNEY-BCORE-5 #3: the end was unknown before the commit: asked again (a read only), and an end found by the sync or by this
      // read is persisted and answered too_late. Still unknown: the local Keep stands, unconfirmed (stripeConfirmed false).
      if (liveUnknown && stripeNow && !await terminalSub(env, subscriptionId)) {
        try { await fence(env, lease); if (endedAtStripe(await stripeNow.getSubscription(subscriptionId))) await fencedBatch(env, lease, [markEndedQ(homeId, subscriptionId, clockOf(d))]); }
        catch (e) { if (e instanceof LeaseLost) throw e; }
      }
      if (await terminalSub(env, subscriptionId)) { outcome = { ok: false, code: "too_late" }; kept = []; return; }
    }, billing.lease);
  } catch (e) { if (e instanceof HomeBusy || e instanceof LeaseLost) return { ok: false, code: "busy" }; throw e; }
  const result = outcome as KeepResult;
  if (!result.ok) return result;
  for (const k of kept) await afterTransition(env, d, k);
  // Kept is final the moment it commits; stripeConfirmed says whether the PLAN renews now, Stripe read back (else the sweep finishes it, and
  // plan changes stay unavailable until it has: members-api.ts). Astra JOURNEY-BCORE-6 #3: ANY read of the Keep path that shows the
  // subscription ended wins, also these last ones (the reconciliation afterTransition ran, and renewsAgain's own read): persisted under the
  // lease, answered too_late. Busy: nothing is known about the end, so the local Keep stands unconfirmed.
  let final: { renews: boolean; ended: boolean };
  try {
    final = await leased(env, homeId, (lease) => renewsAgain(env, stripeOf(env, d), subscriptionId, { lease, homeId, now: clockOf(d) }), billing.lease);
  } catch (e) {
    if (!(e instanceof HomeBusy || e instanceof LeaseLost)) throw e;
    final = { renews: false, ended: await terminalSub(env, subscriptionId) };
  }
  if (final.ended) return { ok: false, code: "too_late" };
  return { ok: true, status: "kept", stripeConfirmed: final.renews };
}

// --- late charges ---------------------------------------------------------------------------------------------------------------------------

/** Astra JOURNEY-BCORE-3 #5-#8: a charge for service after effective_at (identification or the decision came late) is RECORDED, never refunded
 *  by an amount computed here: the declaration's end is first carried out when it is due (completeDue), then every invoice of the subscription
 *  is tracked by id and each one paid after the earliest standing promise becomes ONE cancellation_late record with its full line snapshot and
 *  no amount (cancel-charges.ts). An operator executes it by its id with the amount they decide (executeLateRefund); the customer is told then.
 *  Returns the number of records created. */
export async function recordLateCharges(env: Env, d: CancellationDeps, id: string): Promise<number> {
  let r = await load(env, id);
  if (!r || !r.subscription_id || !r.home_id || r.effective_at === null || r.effective_at > clockOf(d)) return 0;
  if (r.status === "open") { await completeDue(env, d, id); r = (await load(env, id))!; }
  if (r.status !== "executing" && r.status !== "completed") return 0;
  const stripe = stripeOf(env, d);
  if (!stripe) return 0;
  const now = clockOf(d);
  const earliest = await promiseOf(env, r.subscription_id);
  const promisedEndAt = earliest !== null && earliest.promisedEndAt < r.effective_at! ? earliest.promisedEndAt : r.effective_at!;
  const { recorded } = await backfillCharges(env, stripe, { subscriptionId: r.subscription_id!, homeId: r.home_id!, promisedEndAt, requestId: id }, now);
  await env.DB.prepare("UPDATE cancellation_requests SET late_checked_at=? WHERE id=?").bind(now, id).run();
  return recorded;
}

// --- cancellation resolution (every cancellation, generation-bound) -------------------------------------------------------------------------

interface ResolutionRow { subscription_id: string; home_id: string; source: "in_app" | "public" | "parked"; generation: string; promised_end_at: number; due_at: number;
  schedule_id: string | null; state: "open" | "terminated" | "resolved" | "withdrawn"; attempts: number; next_attempt_at: number;
  last_attempt_at: number | null; last_error: string | null; ended_at: number | null; late_checked_at: number | null }
/** Ops are told when a resolution has failed this many attempts in a row (cancel.resolution_unresolved). */
const RESOLUTION_ALERT_AFTER = 3;
/** A due resolution is retried at most this long after its last attempt (the row stays due until the subscription is ended). */
const RESOLUTION_BACKOFF_MAX_MS = 5 * MINUTE;
const endedAtStripe = (live: Got): boolean => live.status === "canceled" || live.status === "incomplete_expired";
const resolutionAlert = (env: Env, r: ResolutionRow, kind: string, detail: Record<string, JSONValue>, now: number) =>
  env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
    .bind(`${kind}:${r.subscription_id}:${r.generation}`, r.home_id, kind, "high", JSON.stringify({ subscriptionId: r.subscription_id, generation: r.generation, promisedEndAt: r.promised_end_at, ...detail }), now).run();
/** Whether the cancellation this resolution was written for still stands, read under the home's lease right before any provider call
 *  (Astra JOURNEY-BCORE-2 #1). live: its generation is current. wait: the declaration is on hold or its reason is being checked (it may resume).
 *  withdrawn: kept, replaced or gone: this generation never acts again. Each row answers for its OWN cancellation only (Astra JOURNEY-BCORE-3
 *  #2): another cancellation of the same plan that waits or was withdrawn never stalls or withdraws this one. */
async function standing(env: Env, r: ResolutionRow): Promise<"live" | "wait" | "withdrawn"> {
  if (r.source === "in_app") {
    const sub = await getSub(env, r.home_id);
    return sub?.subscription_id === r.subscription_id && sub.customer_cancel_at !== null && `in_app:${sub.customer_cancel_at}` === r.generation ? "live" : "withdrawn";
  }
  const id = r.generation.slice("public:".length, r.generation.lastIndexOf(":"));
  const req = await env.DB.prepare("SELECT status,kind,reason_decision,effective_at,subscription_id FROM cancellation_requests WHERE id=?").bind(id)
    .first<{ status: string; kind: string; reason_decision: string | null; effective_at: number | null; subscription_id: string | null }>();
  if (!req || req.subscription_id !== r.subscription_id || req.effective_at === null || `public:${id}:${req.effective_at}` !== r.generation) return "withdrawn";
  if (req.status === "held" || req.status === "reason_pending") return "wait";
  if (req.status === "open") return req.kind !== "extraordinary" || req.reason_decision === "reject" ? "live" : "wait";
  return req.status === "executing" || req.status === "completed" ? "live" : "withdrawn";
}
/** A 4xx Stripe ANSWERED (the request was refused and nothing was done); a 429 or an in-flight key is not an answer. */
const refusedByStripe = (e: unknown): e is StripeError => e instanceof StripeError && e.status >= 400 && e.status < 500 && e.status !== 429 && !e.meta.inFlight;
/** A failure Stripe ANSWERED for good under this key: a refusal (4xx), or a cached failure replayed (Idempotent-Replayed 5xx: the key now
 *  answers the same failure forever). Only with a live read showing the state unchanged is it authoritative (the key is rotated). */
const answeredFailure = (e: unknown): boolean => refusedByStripe(e) || (e instanceof StripeError && e.status >= 500 && e.meta.replayed === true);
/** The date guard (Astra JOURNEY-BCORE-3 #1): a resolution is eligible only from its OWN frozen promise less the precision, whatever its
 *  next_attempt_at says and whatever Stripe's current period is. Thrown under the lease right before a destructive call when the clock (read
 *  again) is still before it. */
class NotYetDue extends Error { constructor(readonly eligibleAt: number) { super("resolution_not_yet_due"); } }

type ResolutionAction = "delete";
/** The resolver's parked state: Stripe refused the normal cancel because a subscription schedule is attached (an operator resolves it). */
const SCHEDULE_ATTACHED = "cancel.schedule_attached";
/** Parks the SUBSCRIPTION on the attached schedule that refused the normal cancel (schedule_id on every resolution row of it, whatever its
 *  state: the durable parked state, scheduleParked), looked at again in an hour, with ONE deduplicated ops alert. Astra JOURNEY-BCORE-5 #2/#4:
 *  written the moment Stripe refused, before any read-back, and needing no obligation row: a subscription with none gets a carrier row
 *  (source 'parked', state withdrawn: never an obligation, only read hourly). Used by the resolver and the public reconciliation. */
async function parkOnSchedule(env: Env, lease: HomeLease, subId: string, homeId: string, scheduleId: string, refusal: StripeError,
  detail: { generation?: string; promisedEndAt: number | null }, now: number): Promise<void> {
  // Astra JOURNEY-BCORE-6 #5: the deduplicated ops alert commits in the SAME batch as the parking: never parked without it.
  await fencedBatch(env, lease, [
    q("UPDATE cancel_resolutions SET schedule_id=?,last_error=?,next_attempt_at=? WHERE subscription_id=?", scheduleId, SCHEDULE_ATTACHED, now + HOUR, subId),
    q(`INSERT INTO cancel_resolutions (subscription_id,home_id,source,generation,promised_end_at,due_at,schedule_id,state,next_attempt_at,last_error,created_at,resolved_at)
      SELECT ?,?,'parked','parked',?,?,?,'withdrawn',?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM cancel_resolutions WHERE subscription_id=?)`,
    subId, homeId, detail.promisedEndAt ?? now, detail.promisedEndAt ?? now, scheduleId, now + HOUR, SCHEDULE_ATTACHED, now, now, subId),
    scheduleAlertQ(subId, homeId, scheduleId, { generation: detail.generation ?? null, promisedEndAt: detail.promisedEndAt,
      refusal: { status: refusal.status, code: refusal.code, type: refusal.meta.type ?? null, requestId: refusal.meta.requestId ?? null } }, now)]);
}
/** The ONE deduplicated cancel.schedule_attached alert of a parked subscription (its id is the subscription's). Written with the parking, and
 *  again by every hourly inspection that still finds it parked (a no-op while the alert exists: Astra JOURNEY-BCORE-6 #5, belt and braces). */
const scheduleAlertQ = (subId: string, homeId: string, scheduleId: string, detail: Record<string, JSONValue>, now: number): Q =>
  q("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
    `${SCHEDULE_ATTACHED}:${subId}`, homeId, SCHEDULE_ATTACHED, "high", JSON.stringify({ subscriptionId: subId, scheduleId, ...detail }), now);
interface AttemptRow { seq: number; idempotency_key: string; state: "unresolved" | "failed" | "done" }
/** Astra JOURNEY-BCORE-3 #3: one provider call of a resolution, journaled BEFORE it is sent. The key of an attempt whose outcome is unresolved is
 *  sent again (Stripe may still be executing it, or will answer its cached outcome); after an AUTHORITATIVE failure (answeredFailure, confirmed
 *  by a live read showing nothing changed) or a success the next attempt gets a new key (seq+1). */
async function attemptKey(env: Env, lease: HomeLease, r: ResolutionRow, action: ResolutionAction, target: string, now: number): Promise<{ seq: number; key: string }> {
  const last = await env.DB.prepare(`SELECT seq,idempotency_key,state FROM cancel_resolution_attempts WHERE subscription_id=? AND generation=? AND action=? AND target=?
    ORDER BY seq DESC LIMIT 1`).bind(r.subscription_id, r.generation, action, target).first<AttemptRow>();
  if (last?.state === "unresolved") {
    await fencedRun(env, lease, "UPDATE cancel_resolution_attempts SET sends=sends+1,last_sent_at=? WHERE subscription_id=? AND generation=? AND action=? AND target=? AND seq=?",
      now, r.subscription_id, r.generation, action, target, last.seq);
    return { seq: last.seq, key: last.idempotency_key };
  }
  const seq = (last?.seq ?? 0) + 1;
  // Astra JOURNEY-BCORE-4 #2: a NEW key names the subscription too (two in-app generations stamped in the same millisecond never share a key);
  // an attempt already journaled keeps the key it was sent with (above).
  const key = `cxres:${r.subscription_id}:${r.generation}:${action}:${seq}`;
  await fencedRun(env, lease, `INSERT INTO cancel_resolution_attempts (subscription_id,generation,action,target,seq,idempotency_key,state,sends,first_sent_at,last_sent_at)
    VALUES (?,?,?,?,?,?,'unresolved',1,?,?)`, r.subscription_id, r.generation, action, target, seq, key, now, now);
  return { seq, key };
}
const settleAttempt = (env: Env, lease: HomeLease, r: ResolutionRow, action: ResolutionAction, target: string, seq: number, state: "unresolved" | "failed" | "done",
  error: string | null, now: number) => fencedRun(env, lease, `UPDATE cancel_resolution_attempts SET state=?,answered_at=CASE WHEN ?<>'unresolved' THEN ? ELSE answered_at END,
    last_error=? WHERE subscription_id=? AND generation=? AND action=? AND target=? AND seq=? AND state='unresolved'`,
  state, state, now, error, r.subscription_id, r.generation, action, target, seq);

/** Astra JOURNEY-BCORE-2 #1/#5, JOURNEY-BCORE-3 #1/#3 (launch version): one cancellation's resolution (cancel_resolutions, written in the same
 *  batch as the cancellation). NOTHING is done at the provider before the promised end. Eligible only from promised_end_at -
 *  RESOLUTION_PRECISION_MS by its own date guard (re-checked under the lease right before the destructive call), under the home's lease and only
 *  while its generation is current:
 *  1. Stripe shows the subscription ended (it ended itself at the period end): resolved.
 *  2. else the NORMAL cancel, once per pass: the subscription is ended now (DELETE, invoice_now: usage not yet invoiced is billed; no proration),
 *     the same call every other end-now cancellation makes, journaled with its key (attemptKey).
 *  3. Stripe refused it and a subscription schedule is attached: the control plane makes NO further write for that subscription. The row is
 *     parked as schedule-attached (cancel.schedule_attached: the subscription, the promised end and the refusal; one deduplicated ops alert) and
 *     the customer keeps seeing the plan ending on its date, being confirmed. An operator releases or cancels the schedule by hand in the Stripe
 *     dashboard; each later pass only READS the subscription and, once no schedule is attached any more, makes the normal cancel again (a
 *     new key: the refusal was an authoritative answer).
 *  4. read back: ended means resolved, and the local subscription is marked ended in the same lease (a Keep then answers too_late). Not ended:
 *     retried within RESOLUTION_BACKOFF_MAX_MS, ops are told after three attempts.
 *  Charges after the promise are recorded apart (watchCharges), also afterwards. */
async function resolveOne(env: Env, d: CancellationDeps, stripe: StripeClient, r: ResolutionRow): Promise<void> {
  const subId = r.subscription_id; const gen = r.generation;
  await leased(env, r.home_id, async (lease) => {
    const row = await env.DB.prepare("SELECT promised_end_at,state,schedule_id FROM cancel_resolutions WHERE subscription_id=? AND generation=?").bind(subId, gen)
      .first<{ promised_end_at: number; state: string; schedule_id: string | null }>();
    if (!row) return;
    const eligibleAt = row.promised_end_at - RESOLUTION_PRECISION_MS;
    // Astra INTEGRATED-1 #4: the hourly parking inspection is independent of termination eligibility: an open parked row before its promised
    // end is READ hourly too (and cleared once the schedule is gone); only the destructive cancel below waits for the date guard.
    if (row.state !== "open" || (row.schedule_id !== null && clockOf(d) < eligibleAt)) {
      // Astra JOURNEY-BCORE-5 #1: a parked row no longer open (kept, replaced, the carrier) keeps the subscription parked: the hourly
      // inspection only READS, and clears the parking once the schedule is gone or the subscription has ended.
      if (row.schedule_id === null) return;
      await fence(env, lease);
      const seen = await stripe.getSubscription(subId);
      const t = clockOf(d);
      if (endedAtStripe(seen) || !seen.schedule) {
        await fencedBatch(env, lease, [...unparkQs(subId, t), ...(endedAtStripe(seen) ? [markEndedQ(r.home_id, subId, t)] : [])]);
        return;
      }
      await fencedBatch(env, lease, [q("UPDATE cancel_resolutions SET attempts=?,next_attempt_at=? WHERE subscription_id=? AND generation=?", r.attempts, t + HOUR, subId, gen),
        scheduleAlertQ(subId, r.home_id, row.schedule_id, { generation: gen, promisedEndAt: row.promised_end_at, reraised: true }, t)]);
      return;
    }
    const dateGuard = () => { const t = clockOf(d); if (t < eligibleAt) throw new NotYetDue(eligibleAt); return t; };
    try { dateGuard(); }
    catch (e) {
      if (!(e instanceof NotYetDue)) throw e;
      await fencedRun(env, lease, "UPDATE cancel_resolutions SET next_attempt_at=?,attempts=? WHERE subscription_id=? AND generation=? AND state='open'", eligibleAt, r.attempts, subId, gen);
      return;
    }
    const standingNow = await standing(env, r);
    const now = clockOf(d);
    if (standingNow === "withdrawn") {
      await fencedRun(env, lease, "UPDATE cancel_resolutions SET state='withdrawn',resolved_at=? WHERE subscription_id=? AND generation=? AND state IN ('open','terminated')", now, subId, gen);
      return;
    }
    if (standingNow === "wait") {
      await fencedRun(env, lease, "UPDATE cancel_resolutions SET next_attempt_at=?,attempts=? WHERE subscription_id=? AND generation=? AND state='open'", now + HOUR, r.attempts, subId, gen);
      return;
    }
    await fence(env, lease);
    let live = await stripe.getSubscription(subId);
    let forced = false;
    if (!endedAtStripe(live)) {
      forced = true;
      // Astra JOURNEY-BCORE-4 #4: parked is the durable schedule_id of ANY open resolution of the subscription (scheduleParked), never last_error:
      // a failed hourly read keeps it parked. Still attached: nothing is sent (an operator resolves it in the dashboard); looked at again hourly.
      const parked = await scheduleParked(env, subId);
      if (parked && live.schedule) {
        await fencedBatch(env, lease, [q("UPDATE cancel_resolutions SET attempts=?,next_attempt_at=? WHERE subscription_id=? AND generation=? AND state='open'", r.attempts, now + HOUR, subId, gen),
          scheduleAlertQ(subId, r.home_id, live.schedule, { generation: gen, promisedEndAt: row.promised_end_at, reraised: true }, now)]);
        return;
      }
      // Astra JOURNEY-BCORE-5 #1: the ONLY clearance: this hourly read saw the schedule gone; the normal cancel follows.
      if (parked) await fencedBatch(env, lease, unparkQs(subId, now));
      const before = live;
      await fence(env, lease);
      const t = dateGuard();
      const k = await attemptKey(env, lease, r, "delete", subId, t);
      let refusal: StripeError | null = null;
      try {
        // Through the gateway (Astra JOURNEY-BCORE-6 #1). Parked again under this same lease is impossible (cleared just above, and only this
        // read parks or clears), but if it were: nothing is sent, the attempt stays unresolved, and the row is read again in an hour.
        if ((await writeSubscription(env, lease, stripe, subId, { kind: "cancel_now", opts: { prorate: false, invoiceNow: true }, key: k.key })).parked) {
          await fencedRun(env, lease, "UPDATE cancel_resolutions SET attempts=?,next_attempt_at=? WHERE subscription_id=? AND generation=? AND state='open'", r.attempts, now + HOUR, subId, gen);
          return;
        }
      } catch (e) {
        if (!(e instanceof StripeError)) throw e;
        if (e.status !== 404) refusal = e;
      }
      // Astra JOURNEY-BCORE-5 #4: refused while the read just before showed a schedule: parked NOW, before the fallible read-back.
      const parkedNow = !!refusal && refusedByStripe(refusal) && !!before.schedule;
      if (parkedNow) await parkOnSchedule(env, lease, subId, r.home_id, before.schedule!, refusal!, { generation: gen, promisedEndAt: row.promised_end_at }, now);
      live = await stripe.getSubscription(subId);
      const code = refusal ? `${refusal.status}:${refusal.code}${refusal.meta.replayed ? ":replayed" : ""}` : null;
      // The attempt's outcome against the live read: ended = done; an authoritative failure with nothing changed = failed (the next attempt
      // gets a new key); anything else stays unresolved and its key is sent again.
      await settleAttempt(env, lease, r, "delete", subId, k.seq, endedAtStripe(live) ? "done" : refusal && answeredFailure(refusal) ? "failed" : "unresolved", code, clockOf(d));
      if (!endedAtStripe(live)) {
        if (parkedNow || (refusal && refusedByStripe(refusal) && live.schedule)) {
          await fencedRun(env, lease, "UPDATE cancel_resolutions SET attempts=? WHERE subscription_id=? AND generation=? AND state='open'", r.attempts, subId, gen);
          if (!parkedNow) await parkOnSchedule(env, lease, subId, r.home_id, live.schedule!, refusal!, { generation: gen, promisedEndAt: row.promised_end_at }, now);
          return;
        }
        throw refusal ?? new Error("cancellation_resolution_unresolved");
      }
    }
    const at = clockOf(d);
    await fencedBatch(env, lease, [
      q("UPDATE cancel_resolutions SET state='resolved',ended_at=COALESCE(ended_at,?),resolved_at=?,last_error=NULL WHERE subscription_id=? AND generation=? AND state='open'", at, at, subId, gen),
      ...unparkQs(subId, at), markEndedQ(r.home_id, subId, at)]);
    if (forced) await resolutionAlert(env, r, "cancel.resolution_forced_end", {}, at);
  }, d.billing?.lease);
}
/** Cron: every due cancellation-resolution obligation, the one attempted longest ago first; its attempt and next eligibility (backoff, at most
 *  RESOLUTION_BACKOFF_MAX_MS) are persisted BEFORE it is worked on, so obligations that cannot progress never starve the others. A row is
 *  eligible only from its promised end less RESOLUTION_PRECISION_MS (clamped here and guarded again in resolveOne). */
export async function resolveCancellations(env: Env, d: CancellationDeps): Promise<void> {
  const stripe = stripeOf(env, d);
  if (!stripe) return;
  const now = clockOf(d);
  // Astra JOURNEY-BCORE-5 #1: plus every PARKED row in any state (only read hourly), so a parking whose obligations were kept still clears.
  // Astra INTEGRATED-1 #4: a parked row is due hourly whatever its promised end (inspection only); the end-date cutoff applies to the rest.
  const due = (await env.DB.prepare(`SELECT * FROM cancel_resolutions WHERE next_attempt_at<=? AND ((state='open' AND promised_end_at-?<=?) OR schedule_id IS NOT NULL)
    ORDER BY COALESCE(last_attempt_at,0), next_attempt_at, subscription_id, generation LIMIT 50`).bind(now, RESOLUTION_PRECISION_MS, now).all<ResolutionRow>()).results;
  for (const r of due) {
    const attempts = r.attempts + 1;
    const backoff = Math.min(RESOLUTION_BACKOFF_MAX_MS, 15_000 * 2 ** Math.min(attempts, 5));
    await env.DB.prepare("UPDATE cancel_resolutions SET attempts=?,last_attempt_at=?,next_attempt_at=? WHERE subscription_id=? AND generation=? AND state=?")
      .bind(attempts, now, now + backoff, r.subscription_id, r.generation, r.state).run();
    try { await resolveOne(env, d, stripe, r); }
    catch (e) {
      const busy = e instanceof HomeBusy || e instanceof LeaseLost;
      const code = e instanceof StripeError ? e.code : e instanceof Error ? e.message : "error";
      try {
        // A home busy with another holder is not a failed attempt: it is simply tried again soon. Neither is a guard that found it not yet due.
        if (busy) await env.DB.prepare("UPDATE cancel_resolutions SET attempts=?,next_attempt_at=? WHERE subscription_id=? AND generation=?").bind(r.attempts, now + 30_000, r.subscription_id, r.generation).run();
        else if (e instanceof NotYetDue) await env.DB.prepare("UPDATE cancel_resolutions SET attempts=?,next_attempt_at=? WHERE subscription_id=? AND generation=?").bind(r.attempts, e.eligibleAt, r.subscription_id, r.generation).run();
        else {
          // Astra JOURNEY-BCORE-4 #4: last_error is only a note; a parked row (schedule_id) stays parked and is read again in an hour.
          await env.DB.prepare("UPDATE cancel_resolutions SET last_error=?,next_attempt_at=CASE WHEN schedule_id IS NOT NULL THEN ? ELSE next_attempt_at END WHERE subscription_id=? AND generation=?")
            .bind(code, now + HOUR, r.subscription_id, r.generation).run();
          if (attempts >= RESOLUTION_ALERT_AFTER) await resolutionAlert(env, r, "cancel.resolution_unresolved", { attempts, last: code }, now);
        }
      } catch { console.error(JSON.stringify({ message: "cancellation resolution bookkeeping failed" })); }
    }
  }
}
/** Astra JOURNEY-BCORE-3 #8: the durable charge backfill, per subscription with a standing promise that has come (its earliest one), at most
 *  hourly each: every invoice tracked by id until final and every listing in lifecycle order (cancel-charges.ts backfillCharges). It CONTINUES
 *  after the resolution: for CHARGE_WATCH_MS after the last resolution, and for as long as an invoice it saw is still open or in draft. */
export async function watchCharges(env: Env, d: CancellationDeps): Promise<void> {
  const stripe = stripeOf(env, d);
  if (!stripe) return;
  const now = clockOf(d);
  const subs = (await env.DB.prepare(`SELECT subscription_id AS s FROM cancel_resolutions r WHERE state IN ('open','terminated','resolved') AND promised_end_at-?<=?
      AND (state<>'resolved' OR COALESCE(resolved_at,0)>? OR EXISTS (SELECT 1 FROM cancel_invoice_checks c WHERE c.subscription_id=r.subscription_id
        AND (c.status IS NULL OR c.status NOT IN ('paid','void','uncollectible'))))
    GROUP BY subscription_id HAVING MAX(COALESCE(late_checked_at,0))<=? ORDER BY MAX(COALESCE(late_checked_at,0)), subscription_id LIMIT 50`)
    .bind(CHARGE_PRECISION_MS, now, now - CHARGE_WATCH_MS, now - HOUR).all<{ s: string }>()).results;
  for (const { s } of subs) {
    await env.DB.prepare("UPDATE cancel_resolutions SET late_checked_at=? WHERE subscription_id=?").bind(now, s).run();
    try {
      const p = await promiseOf(env, s);
      if (p) await backfillCharges(env, stripe, p, now);
    } catch { console.error(JSON.stringify({ message: "cancellation charge backfill failed" })); }
  }
}
const executeBody = z.strictObject({ amountCents: z.number().int().min(1).max(100_000_000), note: z.string().trim().max(2000).optional() });
/** POST /v1/admin/cancellations/late-refunds/{id}/execute {amountCents} (operator): executes one recorded post-promise charge by its id with
 *  the amount the OPERATOR decided (never more than the invoice paid), as the ledger refund of that payment (refund_ops kind cancellation_late)
 *  that is then advanced. Once only: a second call answers the operation already opened. A record made against a public declaration opens the
 *  operation under that declaration's id (cxl-late:<request>:<invoice>) and the customer's late-refund mail follows the ledger. */
async function executeLateRefund(env: Env, d: CancellationDeps, id: string, body: unknown): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM cancel_late_refunds WHERE id=?").bind(id).first<{ id: string; subscription_id: string; home_id: string; user_id: string;
    invoice_id: string; payment_intent: string | null; paid_cents: number; request_id: string | null; executed_at: number | null; executed_cents: number | null; refund_op_id: string | null }>();
  if (!row) return errorResponse(404, "not_found");
  const stripe = stripeOf(env, d);
  if (!stripe) return errorResponse(503, "stripe_unavailable");
  const now = clockOf(d);
  const opId = row.refund_op_id ?? (row.request_id ? `cxl-late:${row.request_id}:${row.invoice_id}` : row.id);
  if (row.executed_at === null) {
    const b = executeBody.safeParse(body);
    if (!b.success) throw new HTTPError(400, "invalid_request");
    if (b.data.amountCents > row.paid_cents) return errorResponse(409, "amount_exceeds_payment");
    const sub = await env.DB.prepare("SELECT consent_id FROM billing_subscriptions WHERE subscription_id=?").bind(row.subscription_id).first<{ consent_id: string | null }>();
    const path = await sellerPathOfConsent(env, sub?.consent_id ?? null);
    const [sql, binds] = refundOpInsert({ id: opId, kind: "cancellation_late", homeId: row.home_id, userId: row.user_id, invoiceId: row.invoice_id, paidCents: row.paid_cents,
      endPlan: true, cancelSubscriptionId: row.subscription_id, subscriptionId: row.subscription_id, inheritSubscription: false, paymentIntent: row.payment_intent,
      detail: { path, revoke: false, operatorCents: b.data.amountCents, lateRecord: row.id } }, now);
    await env.DB.batch([env.DB.prepare(sql).bind(...(binds ?? [])),
      env.DB.prepare("UPDATE cancel_late_refunds SET executed_at=?,executed_cents=?,refund_op_id=? WHERE id=? AND executed_at IS NULL").bind(now, b.data.amountCents, opId, row.id),
      ...(row.request_id ? [env.DB.prepare("INSERT OR IGNORE INTO cancellation_mail (id,request_id,kind,created_at) VALUES (?,?,?,?)").bind(`${row.request_id}:late_account`, row.request_id, "late_account", now)] : [])]);
  }
  const billing = d.billing ?? {};
  let op: Awaited<ReturnType<typeof advanceRefundOp>> = null;
  try { op = await advanceRefundOp(env, { stripe, flux: billing.flux ?? stubFluxHooks, deps: billing, now }, opId); }
  catch { /* opened and recorded: the refund sweep continues it from its last checkpoint */ }
  if (row.request_id) { try { await flushMail(env, d, row.request_id); } catch { /* the mail sweep sends it */ } }
  const done = await env.DB.prepare("SELECT executed_cents FROM cancel_late_refunds WHERE id=?").bind(row.id).first<{ executed_cents: number | null }>();
  return json({ id: row.id, refundOpId: opId, done: op?.done_at != null, amountCents: done?.executed_cents ?? null });
}

// --- sweep ----------------------------------------------------------------------------------------------------------------------------------

/** Cron: match what is still pending, close held cases as `kept` at their time, end what is due, finish accepted terminations, bring every
 *  subscription in line with Stripe (and re-verify open ones), refund late renewals, send due mail, escalate. Each step stands alone. */
export async function sweepCancellations(env: Env, billing?: BillingDependencies): Promise<void> {
  const d: CancellationDeps = { ...injected, ...(billing ? { billing } : {}) };
  const now = clockOf(d);
  const each = async (sql: string, binds: unknown[], work: (id: string) => Promise<unknown>) => {
    for (const row of (await env.DB.prepare(sql).bind(...binds).all<{ id: string }>()).results) { try { await work(row.id); } catch { console.error(JSON.stringify({ message: "cancellation sweep step failed" })); } }
  };
  // Fair scheduling (Astra WP8-2 #6): every step takes the rows unattended longest first, and a row is moved to the back BEFORE it is
  // worked on, so rows that cannot progress (no schedule, Stripe down) never hold the others back, whatever happens to the attempt.
  try { await allocatePendingReferences(env, now); } catch { console.error(JSON.stringify({ message: "cancellation sweep step failed" })); }
  // Pending intake: still "at submission" while the declarant's receipt mail has not gone out (it then carries the match).
  await each("SELECT id FROM cancellation_requests WHERE match_state='pending' AND COALESCE(next_match_at,0)<=? ORDER BY COALESCE(next_match_at,0), received_at LIMIT 50", [now], async (id) => {
    await env.DB.prepare("UPDATE cancellation_requests SET match_attempts=match_attempts+1, next_match_at=?+MIN(?*(1<<MIN(match_attempts,12)),?) WHERE id=? AND match_state='pending'")
      .bind(now, MINUTE, 6 * HOUR, id).run();
    const unsent = await env.DB.prepare("SELECT 1 AS x FROM cancellation_mail WHERE id=? AND sent_at IS NULL").bind(`${id}:receipt_declarant`).first();
    await matchRequest(env, d, id, unsent !== null);
  });
  // Held and unanswered: the case closes as kept and the plan continues.
  await env.DB.prepare(`UPDATE cancellation_requests SET status='kept', kept_by='timeout', completed_at=?, stripe_synced=0, last_op=${NEW_OP}, updated_at=? WHERE status='held' AND keep_at IS NOT NULL AND keep_at<=?`)
    .bind(now, now, now).run();
  await env.DB.prepare("UPDATE cancellation_cases SET closed_at=?, outcome='kept' WHERE closed_at IS NULL AND request_id IN (SELECT id FROM cancellation_requests WHERE status='kept')").bind(now).run();
  await completeDue(env, d);
  await each("SELECT id FROM cancellation_requests WHERE status='executing' ORDER BY COALESCE(exec_checked_at,0) LIMIT 50", [], async (id) => {
    await env.DB.prepare("UPDATE cancellation_requests SET exec_checked_at=? WHERE id=?").bind(now, id).run();
    await ensureExecution(env, d, id);
  });
  await each(`SELECT subscription_id AS id, MIN(COALESCE(stripe_attempt_at,0)) AS o FROM cancellation_requests WHERE subscription_id IS NOT NULL AND (stripe_synced=0
      OR (status IN ('open','reason_pending','held') AND (stripe_verified_at IS NULL OR stripe_verified_at<?))) GROUP BY subscription_id ORDER BY o LIMIT 50`, [now - VERIFY_EVERY_MS], async (sub) => {
    await env.DB.prepare("UPDATE cancellation_requests SET stripe_attempt_at=? WHERE subscription_id=?").bind(now, sub).run();
    await reconcileSubscription(env, d, sub);
  });
  // Every cancellation's own resolution (in-app and public), each obligation on its own; then the durable charge backfill (record only).
  try { await resolveCancellations(env, d); } catch { console.error(JSON.stringify({ message: "cancellation sweep step failed" })); }
  try { await watchCharges(env, d); } catch { console.error(JSON.stringify({ message: "cancellation sweep step failed" })); }
  await each(`SELECT id FROM cancellation_requests WHERE status IN ('open','executing','completed') AND effective_at IS NOT NULL AND effective_at<=? AND subscription_id IS NOT NULL
    AND (late_checked_at IS NULL OR late_checked_at<?) ORDER BY COALESCE(late_checked_at,0) LIMIT 50`, [now, now - HOUR], async (id) => {
    await env.DB.prepare("UPDATE cancellation_requests SET late_checked_at=? WHERE id=?").bind(now, id).run();
    await recordLateCharges(env, d, id);
  });
  await flushMail(env, d);
  // Retry payloads that can no longer be needed are wiped (Astra WP8-2 #10): sent, or rendered for a transition that has moved on, or for a
  // hold that is over. A delivery still waiting for its retry keeps its (sealed) payload; one claimed right now is left to its sender.
  await env.DB.prepare(`UPDATE cancellation_mail SET payload_json=NULL, payload_op=NULL WHERE payload_json IS NOT NULL AND (claimed_until IS NULL OR claimed_until<=?)
      AND (sent_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM cancellation_requests c WHERE c.id=cancellation_mail.request_id AND c.last_op IS cancellation_mail.payload_op
        AND c.status IN ('open','reason_pending') AND (c.hold_until IS NULL OR c.hold_until>?)))`).bind(now, now).run();
  // One escalation marker per kind (Astra WP8-2 #9): an identification escalation never suppresses a later reason escalation.
  // Unidentified at its deadline (3 days before the next renewal of any candidate plan; none known: at once): urgent, once.
  await each("SELECT id FROM cancellation_requests WHERE match_state='unmatched' AND attributed_at IS NULL AND identify_escalated_at IS NULL AND identify_due_at IS NOT NULL AND identify_due_at<=? LIMIT 50", [now], async (id) => {
    await env.DB.batch([alert(env, `cx-req:${id}`, "cancellation.unidentified", "high", { id }, now),
      env.DB.prepare("UPDATE cancellation_requests SET identify_escalated_at=?, escalated_at=COALESCE(escalated_at,?) WHERE id=? AND identify_escalated_at IS NULL").bind(now, now, id)]);
  });
  // A reason check past its 3 working days: urgent, once.
  await each("SELECT id FROM cancellation_requests WHERE status='reason_pending' AND reason_decided_at IS NULL AND reason_due_at IS NOT NULL AND reason_due_at<=? AND reason_escalated_at IS NULL LIMIT 50", [now], async (id) => {
    await env.DB.batch([alert(env, `cx-req:${id}`, "cancellation.reason_overdue", "high", { id }, now),
      env.DB.prepare("UPDATE cancellation_requests SET reason_escalated_at=?, escalated_at=COALESCE(escalated_at,?) WHERE id=? AND reason_escalated_at IS NULL").bind(now, now, id)]);
  });
}

// --- operator routes ------------------------------------------------------------------------------------------------------------------------

const reasonBody = z.strictObject({ decision: z.enum(["accept", "reject"]), note: z.string().trim().max(2000).default("") });
const attributeBody = z.strictObject({ accountId: z.string().min(1).max(200), basis: z.enum(["support", "identifier"]) });
const resumeBody = z.strictObject({ note: z.string().trim().max(2000).optional() });

export async function cancellationAdminRoute(request: Request, env: Env): Promise<Response | null> {
  const late = /^\/v1\/admin\/cancellations\/late-refunds\/(cxr-late:[\w-]{1,100}:[\w-]{1,100})\/execute$/.exec(decodeURIComponent(new URL(request.url).pathname));
  if (late) {
    if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
    await admin(request, env);
    return executeLateRefund(env, injected, late[1], await readBoundedJSON(request));
  }
  const m = /^\/v1\/admin\/cancellations\/([0-9a-f]{32})\/(reason|attribute|resume)$/.exec(new URL(request.url).pathname);
  if (!m) return null;
  if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
  await admin(request, env);
  const d = injected;
  const [, id, action] = m;
  const body = await readBoundedJSON(request);
  const fail = (code: string) => errorResponse(code === "not_found" ? 404 : code === "busy" ? 503 : code === "note_required" ? 400 : 409, code);
  if (action === "reason") {
    const b = reasonBody.safeParse(body); if (!b.success) throw new HTTPError(400, "invalid_request");
    const r = await decideReason(env, d, id, b.data.decision, b.data.note);
    return r.ok ? json({ status: r.status }) : fail(r.code);
  }
  if (action === "resume") {
    if (!resumeBody.safeParse(body).success) throw new HTTPError(400, "invalid_request");
    const r = await resumeHeld(env, d, id);
    return r.ok ? json({ status: r.status }) : fail(r.code === "not_reason_pending" ? "not_held" : r.code);
  }
  const b = attributeBody.safeParse(body); if (!b.success) throw new HTTPError(400, "invalid_request");
  const req = await load(env, id);
  if (!req) return fail("not_found");
  if (req.notice_id) return fail("notice_bound");             // r1-1: a notice's declaration belongs to its frozen contract only
  const plans = await plansOfUser(env, b.data.accountId);
  if (plans.length !== 1) return fail("no_single_plan");
  const res = await attributeRequest(env, d, id, plans[0], b.data.basis, false);
  if (res === "busy") return fail("busy");
  if (res === "no_schedule") return fail("no_schedule");
  if (res === "already") return fail("already_attributed");
  return json({ status: (await load(env, id))!.status });
}

// --- account route --------------------------------------------------------------------------------------------------------------------------

/** Astra JOURNEY-BCORE-5 #3: what a Keep the payment provider has not confirmed yet tells the customer. Plain and short. */
const KEEP_UNCONFIRMED = "Your plan is kept. We are still confirming it with our payment provider.";
/** POST /v1/account/cancellations/{id}/keep. `id`: a public-form declaration (32 hex) or an in-app cancellation's CX reference (B5). Signed
 *  in (the Cloud member), on the caller's own plan (anything else is not_found). SIGN-IN ONLY, the same level as Cancel plan (owner rule,
 *  2026-10-12): a plain Keep restores the customer's own prior state (the plan renews as it did before they cancelled), moves no money and
 *  changes no price, so it needs no more than cancelling did. */
export async function cancellationAccountRoute(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response | null> {
  const m = /^\/v1\/account\/cancellations\/([^/]+)\/keep$/.exec(new URL(request.url).pathname);
  if (!m) return null;
  if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
  const user = await (deps.accountUser ?? (async (r, a) => (await accountSession(r, a))?.user ?? null))(request, auth);
  if (!user) throw new HTTPError(401, "unauthorized");
  const r = isCancelRef(m[1]) ? await keepInApp(env, { ...(injected.billing ?? {}), ...deps }, m[1], user.id, (deps.now ?? Date.now)())
    : /^[0-9a-f]{32}$/.test(m[1]) ? await keepPlan(env, { ...injected, ...(deps.now ? { now: deps.now } : {}) }, m[1], user.id)
      : { ok: false as const, code: "not_found" as const };
  if (r.ok) return json({ status: r.status, stripeConfirmed: r.stripeConfirmed, ...(r.stripeConfirmed ? {} : { message: KEEP_UNCONFIRMED }) });
  return errorResponse(r.code === "not_found" ? 404 : r.code === "busy" ? 503 : 409, r.code);
}

// --- wiring ---------------------------------------------------------------------------------------------------------------------------------

/** Registers this package with the public route shell. WP9 and WP10 add their own subjects through the same handlers; `repudiate`, `describe`,
 *  `newLink` and `expired` here answer cancellations and hand every other subject on to whatever was registered before them. */
export function registerCancellation(billing?: BillingDependencies): void {
  if (billing) injected = { ...injected, billing };
  registerPublicRoute(publicCancellationRoute);
  const before = { ...currentPublicHandlers() };
  registerPublicHandlers({
    repudiate: async (env, result, call) => (result.row.subjectKind === "cancellation" ? repudiateCancellation(env, result, call) : before.repudiate ? before.repudiate(env, result, call) : null),
    describe: async (env, row: TokenRow) => {
      if (row.subjectKind !== "cancellation") return before.describe ? before.describe(env, row) : {};
      const r = await load(env, row.subjectId);
      if (!r) return {};
      const plan = r.subscription_id ? await env.DB.prepare("SELECT plan FROM billing_subscriptions WHERE subscription_id=?").bind(r.subscription_id).first<{ plan: string }>() : null;
      return { ...(plan ? { planName: plan.plan } : {}), ...(r.effective_at !== null ? { effectiveAt: r.effective_at } : {}) };
    },
    // /new-link for a hold link (the route already spent its allowance): the confirmation again with a fresh link, while the hold is open.
    newLink: async (env, selector) => {
      const t0 = await env.DB.prepare("SELECT subject_kind, subject_id, purpose FROM verify_tokens WHERE selector=?").bind(selector).first<{ subject_kind: string; subject_id: string; purpose: string }>();
      if (!t0 || t0.subject_kind !== "cancellation") { if (before.newLink) await before.newLink(env, selector); return; }
      const r = await load(env, t0.subject_id);
      const now = clockOf(injected);
      if (r && t0.purpose === "repudiate" && holdOpen(r, now)) await queueRelink(env, injected, r, now);
    },
    expired: async (env, row, purpose) => (row.subjectKind === "cancellation" ? expiredCancellation(env, row, purpose) : before.expired ? before.expired(env, row, purpose) : null),
  });
}

// --- WP10: a cancellation filed on behalf of an emailed notice -----------------------------------------------------------------------------

export interface NoticeCancellation {
  noticeId: string; receivedAt: number; email: string; language: Lang; userId: string; supabaseSub: string | null; homeId: string; subscriptionId: string;
  requestedDate?: string | null;
}
const LIVE_STATUSES = ["active", "trialing", "past_due"];
/** The frozen contract has ended (its subscription is no longer live, or its home was deleted): nothing is left to stop. Unknown: false. */
async function frozenContractEnded(env: Env, subscriptionId: string): Promise<boolean> {
  const b = await env.DB.prepare("SELECT b.status AS status, h.desired_state AS ds FROM billing_subscriptions b LEFT JOIN cloud_homes h ON h.id=b.home_id WHERE b.subscription_id=?")
    .bind(subscriptionId).first<{ status: string | null; ds: string | null }>();
  return !!b && (!LIVE_STATUSES.includes(b.status ?? "") || b.ds === "deleted");
}
/** Matches a notice's declaration to its OWN frozen contract (r1-1): attributed when that plan is live, retired as `contract_ended` when it has
 *  ended, left pending (retried) when it cannot be told yet. Never a match by email. */
async function matchFrozen(env: Env, d: CancellationDeps, r: CancellationRow): Promise<"attributed" | "ended" | "pending" | "unscheduled"> {
  if (r.attributed_at !== null) return "attributed";
  if (!r.account_id || !r.subscription_id) return "pending";
  const plan = (await plansOfUser(env, r.account_id)).find((p) => p.subscriptionId === r.subscription_id && p.homeId === r.home_id);
  if (plan) {
    const res = await attributeRequest(env, d, r.id, plan, "account_email", true);
    // r2-6: never discarded: the scheduling escalation is raised (once) and the caller links the request, so its processing status stays
    // visible on the notice while the sweep keeps retrying.
    if (res === "no_schedule") { await escalateNoSchedule(env, d, r); return "unscheduled"; }
    return (await load(env, r.id))?.attributed_at != null ? "attributed" : "pending";
  }
  if (!await frozenContractEnded(env, r.subscription_id)) return "pending";
  const now = clockOf(d);
  await env.DB.prepare(`UPDATE cancellation_requests SET match_state='unmatched', status='completed', completed_at=?, superseded_by='contract_ended', last_op=${NEW_OP}, updated_at=?
    WHERE id=? AND attributed_at IS NULL AND match_state='pending'`).bind(now, now, r.id).run();
  return "ended";
}
/** The §5.2 cancellation for an emailed notice (a candidate's renewal stop, a notice classified `cancellation`, the answer "end at the end of the
 *  paid month"): `ordinary_earliest` (or `ordinary_date`), the notice's ORIGINAL received_at. The request id is derived from the notice id, so this
 *  is idempotent and a crash between the steps resumes into the same row. r1-1: the row is INSERTED already bound to the notice and to its frozen
 *  account, home and subscription (one statement), and is then matched to exactly that contract (matchFrozen), so neither a crash nor WP8's
 *  sweep can ever attach it to another plan. Returns the request id once it is scheduled (attributed) or retired because the contract ended;
 *  null while it cannot be scheduled yet (the notice sweep calls again). */
export async function fileNoticeCancellation(env: Env, d: CancellationDeps, a: NoticeCancellation): Promise<string | null> {
  const id = (await sha256(`notice-cancellation:${a.noticeId}`)).slice(0, 32);
  const email = normEmail(a.email);
  const now = clockOf(d);
  if (!await load(env, id)) {
    const kind: CancelKind = a.requestedDate ? "ordinary_date" : "ordinary_earliest";
    const ref = await referenceOrReceiptId(env, id, now);
    const fields: ReceiptFields = { id, ref, received_at: a.receivedAt, kind, requested_date: a.requestedDate ?? null, reason: null, entered_email: email,
      entered_name: "(emailed notice)", identifier: null, confirm_email: email, language: a.language };
    await env.DB.prepare(`INSERT OR IGNORE INTO cancellation_requests (id,ref,received_at,fields_json,kind,requested_date,reason,entered_email,entered_name,identifier,confirm_email,language,claimed_ip,
        claimed_ua,receipt_sha256,receipt_html,last_op,created_at,updated_at,notice_id,account_id,supabase_sub,home_id,subscription_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, fields.ref, a.receivedAt, JSON.stringify({ source: "notice", noticeId: a.noticeId, email, kind }), kind, fields.requested_date, null, email, fields.entered_name, null, email,
        a.language, null, null, await sha256(renderReceipt(fields)), renderReceipt(fields), crypto.randomUUID(), now, now, a.noticeId, a.userId, a.supabaseSub, a.homeId, a.subscriptionId).run();
  }
  const r = await load(env, id);
  if (!r || r.notice_id !== a.noticeId) return null;
  const m = await matchFrozen(env, d, r);
  return m === "pending" ? null : id;          // "unscheduled" (r2-6): linked and escalated, shown as being processed
}

/** WP10 r1-5: the end date read out of a notice (YYYY-MM-DD) replaces its provisional earliest end. Under the plan's home lease, one conditional
 *  UPDATE: the declaration becomes `ordinary_date` with the end recalculated from the ORIGINAL received_at; an open request gets the new hold
 *  window and the confirmation again (with its hold link), a held one keeps its hold and its case (only its keep time follows the new end), and
 *  the receipt (the declaration as received) never changes. Terminal requests are not touched. true when the request now carries the date. */
export async function redateNoticeCancellation(env: Env, d: CancellationDeps, id: string, ymd: string): Promise<boolean> {
  const r = await load(env, id);
  if (!r || !r.notice_id || !validYmd(ymd)) return false;
  if (r.requested_date === ymd && r.kind === "ordinary_date") return true;
  if ((r.status !== "open" && r.status !== "held") || r.attributed_at === null || !r.account_id || !r.home_id || r.superseded_by) return false;
  const plan = (await plansOfUser(env, r.account_id)).find((p) => p.subscriptionId === r.subscription_id && p.homeId === r.home_id);
  if (!plan) return false;
  const now = clockOf(d);
  const sch = await scheduleFor(env, d, plan, { ...r, kind: "ordinary_date", requested_date: ymd }, now);
  if (!sch) return false;
  const op = crypto.randomUUID();
  try {
    await leased(env, r.home_id, (lease) => fencedBatch(env, lease, [
      q(`UPDATE cancellation_requests SET kind='ordinary_date', requested_date=?, effective_at=?, hold_until=CASE WHEN status='open' THEN ? ELSE hold_until END,
          keep_at=CASE WHEN status='held' THEN ? ELSE keep_at END, stripe_synced=0, last_op=?, updated_at=?
        WHERE id=? AND status IN ('open','held') AND superseded_by IS NULL AND requested_date IS ? AND kind=?`, ymd, sch.effectiveAt, sch.holdUntil, sch.effectiveAt, op, now, id, r.requested_date, r.kind),
      q(`INSERT OR IGNORE INTO cancellation_mail (id,request_id,kind,created_at) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM cancellation_requests WHERE id=? AND last_op=? AND status='open')`,
        `${id}:relink_account:redated:${ymd}`, id, `relink_account:redated:${ymd}`, now, id, op),
    ]));
  } catch (e) {
    if (e instanceof HomeBusy || e instanceof LeaseLost) return false;
    throw e;
  }
  await afterTransition(env, d, id);
  return (await load(env, id))?.requested_date === ymd;
}

/** WP10 r1-8: an immediate withdrawal of the same contract ended the plan: the notice's cancellation is retired with its hold capability, under
 *  the home lease in one fenced batch: completed and superseded (so no hold, keep, end or confirmation can follow), unused hold links deleted
 *  (a press then answers link_invalid, never "the plan continues"), its case closed and its unsent mails dropped. Idempotent. */
export async function retireNoticeCancellation(env: Env, d: CancellationDeps, id: string, why: string): Promise<boolean> {
  const r = await load(env, id);
  if (!r) return false;
  if (r.superseded_by) return true;
  // r2-4: a request the holder (or the timeout) already KEPT is retired too: its hold link's replay would otherwise still say "your plan
  // continues" after the withdrawal ended and refunded the plan. A kept request keeps its status and completion time; only the supersession is new.
  if ((r.status !== "open" && r.status !== "reason_pending" && r.status !== "held" && r.status !== "kept") || !r.home_id) return false;
  const now = clockOf(d);
  const op = crypto.randomUUID();
  const mineSql = "EXISTS (SELECT 1 FROM cancellation_requests WHERE id=? AND last_op=?)";
  try {
    await leased(env, r.home_id, (lease) => fencedBatch(env, lease, [
      q(`UPDATE cancellation_requests SET status=CASE WHEN status='kept' THEN 'kept' ELSE 'completed' END, completed_at=CASE WHEN status='kept' THEN COALESCE(completed_at,?) ELSE ? END,
          superseded_by=?, hold_until=MIN(COALESCE(hold_until,?),?), keep_at=NULL, stripe_synced=0,
          last_op=?, updated_at=? WHERE id=? AND status IN ('open','reason_pending','held','kept') AND superseded_by IS NULL`, now, now, why, now, now, op, now, id),
      q(`DELETE FROM verify_tokens WHERE subject_kind='cancellation' AND subject_id=? AND used_at IS NULL AND ${mineSql}`, id, id, op),
      q(`UPDATE cancellation_cases SET closed_at=?, outcome='withdrawn' WHERE request_id=? AND closed_at IS NULL AND ${mineSql}`, now, id, id, op),
      q(`UPDATE cancellation_mail SET sent_at=?, last_error='superseded', payload_json=NULL WHERE request_id=? AND sent_at IS NULL AND ${mineSql}`, now, id, id, op),
    ]));
  } catch (e) {
    if (e instanceof HomeBusy || e instanceof LeaseLost) return false;
    throw e;
  }
  return (await load(env, id))?.superseded_by === why;
}

/** What the later confirmation says, from the COMMITTED state of the cancellation: held or kept -> the plan continues (no cancellation claim);
 *  otherwise the end date. null: not scheduled yet. */
export async function committedCancellation(env: Env, id: string): Promise<{ status: Status; effectiveAt: number | null; text: string; superseded: string | null } | null> {
  const r = await load(env, id);
  if (!r) return null;
  // A plan that ended earlier (plan_ended:<reason>) did not end on the declared date: no date is claimed for it either.
  if (r.superseded_by) return { status: r.status, effectiveAt: r.superseded_by === "contract_ended" || r.superseded_by.startsWith("plan_ended:") ? null : r.effective_at,
    text: "", superseded: r.superseded_by };
  if (r.status === "held" || r.status === "kept") return { status: r.status, effectiveAt: r.effective_at, text: t("heldMail", r.language), superseded: null };
  if (r.match_state !== "matched" || r.effective_at === null) return null;
  return { status: r.status, effectiveAt: r.effective_at, text: confirmationText(r, r.language), superseded: null };
}
/** The effective_at of a cancellation (null when unknown / not matched). */
export async function cancellationEffectiveAt(env: Env, id: string): Promise<number | null> {
  return (await load(env, id))?.effective_at ?? null;
}
