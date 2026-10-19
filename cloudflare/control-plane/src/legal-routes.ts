// SPDX-License-Identifier: AGPL-3.0-or-later
// HTTP for the legal flows (legal-flows.ts, legal-refunds.ts):
//   GET  /v1/legal/disclosure?plan=    the checkout wording and dates, from one source (the portal shows exactly this)
//   POST /v1/legal/quote               the same disclosure priced by Stripe Tax for the customer's country and postal code (before consent)
//   GET  /v1/account/confirmation     the contract confirmation, kept on the account page
//   GET  /v1/account/cloud             My Cloud: plan, cancel state, start date, top-up, export request, refund window, terms status
//   GET  /v1/account/terms             which document versions the customer accepted, and whether new ones need accepting
//   POST /v1/account/terms/accept      fresh, logged acceptance of the versions in force
//   POST /v1/account/cancel-plan       online cancel: Stripe cancel_at_period_end, confirmation email. No "contact us" step.
//   GET/POST /v1/account/topup         read or change the auto top-up authorization (applied to Flux auto-recharge)
//   POST /v1/account/export-request   "request my data": records the request and pauses the day-14 deletion (once per deletion cycle)
//   POST /v1/account/withdraw          EU online withdrawal function
//   POST /v1/admin/export-delivered   operator: the export was sent; deletion may resume
//   POST /v1/admin/refund-first-month operator: computes and issues the first-month refund (dryRun to only see the amount)
//   POST /v1/admin/abuse-closure      operator: records an evidenced abuse closure (the only thing that disqualifies the 7-day refund)
//   POST /v1/admin/refund-identity-objection  operator: records an objection to keeping a person's refund codes (restricted at once), and
//                                     later the checkpoint that the decision notice was sent (keep or erase), which lifts the restriction
import { assertPinnedHome } from "./customer-identity";
import { readyAnchorSql, refundWindow, withdrawalEndsAt, withdrawalOpen } from "./checkout-moments";
import { issueDisclosureToken } from "./disclosure-token";
import { acceptanceCounts, authorizationFor, createManagedQuote, LINK_SELLER_LINE, retentionDaysText, SCREEN_VERSION, traderIdentity } from "./legal-flows";
import { sellerFor, sellerSettings } from "./seller";
import { applyServiceLog } from "./service-intervals";
import { z } from "zod";
import { accountSession, type ControlPlaneAuth } from "./auth";
import { admin } from "./b3-control";
import { PLAN_MONTHLY_USD } from "./b5-config";
import { promiseOf } from "./cancel-charges";
import { fluxOn } from "./b4-flux";
import { claimDisputeCredit, closeDisputeHold, markDisputeCreditApplied, resolveInexactDispute, actor, applyTopup, listCustomerOrphans, ORPHAN_REVIEW_MS, ORPHAN_ESCALATE_MS, CancelUnconfirmed, cfg, getSub, homeSoldByLink, liftTermsCancel, notify, recordNotice, replayParkedAcceptance, syncCancellation, readJSON, stubFluxHooks, type BillingDependencies, inAppPending, IN_APP_CANCEL_INTENT_SQL, inAppResolutionQ, keepableBy, openDeclarationsSql, scheduleParked, inAppCancellationId, noFurtherCharge, planEndSentence, renewalStopSentence, planEndState, planEnding, publicCancelEndSql, publicCurrentSql, type OpenDeclaration } from "./b5-billing";
import { StripeError, stripeClient } from "./b5-stripe";
import { sellerOfConsent } from "./seller";
import { fencedBatch, fencedRun, HomeBusy, LeaseLost, q, withHomeLease, type HomeLease } from "./billing-lease";
import { HTTPError, json } from "./http";
import {
  archiveCurrentDocs, type AcceptanceRow, buildDisclosure, changedSince, clientMeta, clientSchema, consentIsEu, createTaxQuote, currentVersions, EXPORT_PAUSE_MAX_MS, getConsent, getTopup, isoDate,
  dataKeptUntil, latestAcceptance, planFrom, PLAN_NAMES, pinCurrentPayment, type PinnedPayment, quoteFirstMonthRefund, saveTopup, TOPUP_CAP_PERIOD, TOPUP_CAP_RESETS, TOPUP_DEFAULTS,
  topupChargeText, topupSchema, usd, validateTopup, htmlOf, TERMS_NONACCEPTANCE_WORDING, WORDING,
} from "./legal-flows";
/** Murage Cloud terms (site 6947dd1), word for word: a second export request in the same deletion period. */
export const EXPORT_REPEAT_WORDING = "Your data is already due for deletion and your first request paused it once. A second request does not pause it again, but we still send you what we hold before deletion.";
import { allocateCancelRef } from "./cancel-reference";
import { journeyRoute, refundRequestDecided } from "./journey";
import { setCountrySwitch, switchBody } from "./checkout-policy";
import { langOf, renderDisclosure } from "./checkout-strings";
import { advanceRefundOp, euUkFullRefundFor, euUkFullRefundQuote, getRefundOp, isLegacyRefusal, refundOpInsert, refusalReason, reopenLegacyRefusal,
  firstMonthOpFor, reopenRefusedRequest, type RefundContext, type RefundOpRow, type RequestSnapshot } from "./legal-refunds";
import { denialText, recordObjection, recordObjectionDecision, refusalReceiptFor, refusalReceiptReopenable, refusalReceiptStatement, refusalStands,
  RefusalWithdrawn } from "./refund-identity";
import { queueExportArchive } from "./self-service";
import { planEndOf } from "./plan-end-reason";

const homeIdSchema = z.string().regex(/^[\w-]{1,128}$/);
const cancelSchema = z.object({ homeId: homeIdSchema.optional() }).strict();
const topupBody = topupSchema.extend({ homeId: homeIdSchema.optional(), client: clientSchema.optional() }).strict();
const exportBody = z.object({ homeId: homeIdSchema.optional(), client: clientSchema.optional() }).strict();
const deliveredBody = z.object({ requestId: z.string().regex(/^[\w-]{1,128}$/) }).strict();
/** The operator's refund: by home (decided as of now), or by a customer's refund request (journey A2: decided as of the request's receipt time,
 *  for the payment and contract the request was recorded for). Exactly one of the two. */
const refundBody = z.object({ homeId: homeIdSchema.optional(), requestId: z.string().regex(/^rr-[0-9a-f-]{36}$/).optional(), dryRun: z.boolean().optional() }).strict()
  .refine((b) => (b.homeId === undefined) !== (b.requestId === undefined));
const quoteBody = z.object({ plan: z.string().max(20), country: z.string().regex(/^[A-Za-z]{2}$/), postalCode: z.string().trim().max(20).optional(),
  topupAmountUsd: z.number().int().min(5).max(500).optional(), homeId: homeIdSchema.optional() }).strict();
const versionsBody = z.object({ cloudTerms: z.string().max(80), termsOfService: z.string().max(80), privacyPolicy: z.string().max(80) }).strict();
const acceptBody = z.object({ termsAccepted: z.literal(true), documentVersions: versionsBody, client: clientSchema.optional() }).strict();
const abuseBody = z.object({ homeId: homeIdSchema, evidence: z.string().trim().min(10).max(4000) }).strict();
/** Round 10 (Astra TAXCOUNTRY-9 P1-2 / P2-a): an operator's record of money or credit, always with its evidence and who recorded it. */
const resolveReturnedBody = z.object({ returnedCents: z.number().int().min(0).max(100_000_000), evidence: z.string().trim().min(10).max(4000),
  by: z.string().trim().min(1).max(128) }).strict();
/** Astra INTEGRATED-11 P1-2d: an operator's evidenced close of an unreleased dispute hold (optionally naming the home it was attributed to). */
const holdCloseBody = z.object({ by: z.string().trim().min(1).max(128), evidence: z.string().trim().min(10).max(4000), homeId: homeIdSchema.optional() }).strict();
const creditAppliedBody = z.object({ token: z.string().uuid(), appliedCents: z.number().int().min(0).max(100_000_000), evidence: z.string().trim().min(10).max(4000),
  by: z.string().trim().min(1).max(128) }).strict();
const creditClaimBody = z.object({ by: z.string().trim().min(1).max(128), evidence: z.string().trim().min(10).max(4000).optional() }).strict();
const objectionBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("object"), userId: z.string().trim().min(1).max(128) }).strict(),
  z.object({ action: z.literal("decision_notice_sent"), userId: z.string().trim().min(1).max(128), decision: z.enum(["keep", "erase"]) }).strict(),
]);

async function currentUser(request: Request, deps: BillingDependencies, auth: ControlPlaneAuth) {
  const user = await (deps.accountUser ?? (async (r, a) => (await accountSession(r, a))?.user ?? null))(request, auth);
  if (!user) throw new HTTPError(401, "unauthorized");
  return user;
}
async function isOperator(request: Request, env: Env) { try { await admin(request, env); return true; } catch { return false; } }
/** The signed-in customer's own home (latest live one). Never a home id from the body, unless the caller is the operator. */
async function ownHome(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth, named?: string) {
  if (await isOperator(request, env)) {
    if (!named) throw new HTTPError(400, "invalid_request");
    const row = await env.DB.prepare("SELECT id,owner_id FROM cloud_homes WHERE id=? AND desired_state<>'deleted'").bind(named).first<{ id: string; owner_id: string }>();
    if (!row) throw new HTTPError(404, "not_found");
    return { homeId: row.id, userId: row.owner_id, operator: true };
  }
  const user = await currentUser(request, deps, auth);
  const row = await env.DB.prepare("SELECT id FROM cloud_homes WHERE owner_id=? AND desired_state<>'deleted' ORDER BY created_at DESC LIMIT 1").bind(user.id).first<{ id: string }>();
  if (!row) throw new HTTPError(404, "not_found");
  // A home id a customer names must be their own live home: anything else is not found (never silently the caller's own home instead).
  if (named !== undefined && named !== row.id) throw new HTTPError(404, "not_found");
  // An emailed approval was frozen for one home (step-up-email.ts): resolving another one now voids it.
  assertPinnedHome(request, row.id);
  return { homeId: row.id, userId: user.id, operator: false };
}
const nowOf = (deps: BillingDependencies) => (deps.now ?? Date.now)();
/** A home whose billing lease is held by someone else: the customer or operator is told to retry (nothing was changed). */
async function busyAs409<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (e) { if (e instanceof HomeBusy || e instanceof LeaseLost) throw new HTTPError(409, "home_busy"); throw e; }
}
const fluxOf = (deps: BillingDependencies) => deps.flux ?? stubFluxHooks;
const refundCtx = (env: Env, deps: BillingDependencies): RefundContext =>
  ({ stripe: stripeClient(cfg(env), deps.stripeFetch), flux: fluxOf(deps), deps, now: nowOf(deps) });

// ---- disclosure and tax quote ---------------------------------------------------------------------------------------------------

/** GET /v1/legal/disclosure?plan=&siteLanguage=&topupAmountUsd=&declaredCountry=&checkoutLanguage=. Public, no tax quote. `siteLanguage` (alias
 *  `locale`) is the page language (en or de) the lines, renewalText and server-owned top-up wording are rendered in; the consent's required
 *  `siteLanguage` must equal it. Unknown query parameters are ignored. With `declaredCountry` it also returns the r13 box (`disclosure`): the lines in order,
 *  the path (direct or managed, by the seller of that country), the Stripe locale that will be sent (de for DE/AT) and `renewalText`, which the
 *  site sends back unchanged and /v1/billing/checkout compares byte for byte. */
function disclosure(request: Request, env: Env, deps: BillingDependencies): Response {
  const params = new URL(request.url).searchParams;
  const plan = planFrom(params.get("plan"));
  if (!plan) throw new HTTPError(400, "invalid_request");
  const siteLocale = langOf(params.get("siteLanguage") ?? params.get("locale") ?? params.get("checkoutLanguage"));
  const amountParam = params.get("topupAmountUsd");
  const amount = amountParam === null ? TOPUP_DEFAULTS.amountUsd : Number(amountParam);
  if (!Number.isInteger(amount) || amount < 5 || amount > 500) throw new HTTPError(400, "invalid_request");
  const base = buildDisclosure(plan, nowOf(deps), null, { siteLocale, topupAmountUsd: amount });
  const declared = params.get("declaredCountry");
  if (declared === null) return json(base as never);
  if (!/^[A-Za-z]{2}$/.test(declared)) throw new HTTPError(400, "invalid_request");
  const seller = sellerFor(sellerSettings(env), declared);
  const d = renderDisclosure(plan, declared, siteLocale, seller, params.get("checkoutLanguage") ?? siteLocale);
  // WP4 r2-3: the token binds this rendering (page language, country, path, Stripe locale, text) to the consent the page sends back.
  const token = issueDisclosureToken(env, { screenVersion: SCREEN_VERSION, siteLanguage: siteLocale, declaredCountry: d.declaredCountry, path: d.path,
    locale: d.locale, renewalText: d.renewalText }, nowOf(deps));
  return json({ ...base, seller, sellerLine: seller === "link" ? LINK_SELLER_LINE : null, topupAvailable: seller !== "link",
    wording: { ...base.wording, authorization: authorizationFor(seller) },
    disclosure: { screenVersion: SCREEN_VERSION, declaredCountry: d.declaredCountry, locale: d.locale, path: d.path, lines: d.lines, renewalText: d.renewalText,
      token } } as never);
}

/** The disclosure priced for this address: the total including tax sits next to the boxes, before anything is ticked. Signed-in only
 *  (each Stripe Tax calculation is billed). If Stripe Tax fails this answers 409 tax_unavailable (no quote, no checkout). */
async function quote(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  const body = await readJSON(request, quoteBody);
  const plan = planFrom(body.plan);
  if (!plan) throw new HTTPError(400, "invalid_request");
  let userId: string;
  if (await isOperator(request, env)) {
    if (!body.homeId) throw new HTTPError(400, "invalid_request");
    const row = await env.DB.prepare("SELECT owner_id FROM cloud_homes WHERE id=?").bind(body.homeId).first<{ owner_id: string }>();
    if (!row) throw new HTTPError(404, "not_found");
    userId = row.owner_id;
  } else userId = (await currentUser(request, deps, auth)).id;
  const now = nowOf(deps);
  const input = { userId, plan, country: body.country, postalCode: body.postalCode, topupAmountCents: (body.topupAmountUsd ?? TOPUP_DEFAULTS.amountUsd) * 100 };
  // The seller for this country (seller.ts): a Ferrox sale is priced by Stripe Tax here; a Link sale is priced by Link on its own page.
  const q = sellerFor(sellerSettings(env), body.country) === "link"
    ? await createManagedQuote(env, input, now)
    : await createTaxQuote(env, stripeClient(cfg(env), deps.stripeFetch), input, now);
  // Signed in only (this route): the trader identity block, with the phone number from the LEGAL_PHONE secret when it is set.
  return json({ ...buildDisclosure(plan, now, q), trader: traderIdentity(env) } as never);
}

// ---- My Cloud summary -----------------------------------------------------------------------------------------------------------


/** B2, the ended view: the signed-in customer has no live home, only a deleted one. Instead of 404 the page gets what ended and when, and
 *  whether anything is still kept; "Start again" is a new checkout (a deleted home never blocks a reservation: b3-control.ts). */
async function endedView(env: Env, userId: string): Promise<Response | null> {
  const h = await env.DB.prepare("SELECT id,updated_at FROM cloud_homes WHERE owner_id=? AND desired_state='deleted' ORDER BY updated_at DESC, created_at DESC LIMIT 1")
    .bind(userId).first<{ id: string; updated_at: number }>();
  if (!h) return null;
  const sub = await getSub(env, h.id);
  // Astra R17 P2: the deleted home's first-month refund request, with the live summary's payment-scoped lookup (summary(), rrR), in ONE
  // batch with the deletion read.
  const [doneR, rrR] = await env.DB.batch([
    env.DB.prepare("SELECT created_at FROM cloud_outbox WHERE home_id=? AND kind='deleted' ORDER BY created_at DESC LIMIT 1").bind(h.id),
    env.DB.prepare(`SELECT id,received_at,eligible,decided_at FROM refund_requests
      WHERE home_id=? AND payment_key=(SELECT first_invoice_id FROM billing_subscriptions WHERE home_id=?) ORDER BY received_at DESC, rowid DESC LIMIT 1`).bind(h.id, h.id),
  ]);
  const done = (doneR.results[0] ?? null) as { created_at: number } | null;
  const rrRow = (rrR.results[0] ?? null) as { id: string; received_at: number; eligible: number; decided_at: number | null } | null;
  const refundRequest = rrRow ? { id: rrRow.id, status: rrRow.decided_at !== null ? "decided" : rrRow.eligible === 1 ? "eligible" : "pending",
    receivedAt: rrRow.received_at, decidedAt: rrRow.decided_at } : null;
  const deletedAt = done?.created_at ?? h.updated_at;
  const plan = planFrom(sub?.plan);
  // The service ended when the plan ended or the Cloud was deleted, whichever came first (a plan still running to its period end at Stripe
  // is never charged again: the deletion ended it, B1).
  const p = sub ? await planEndState(env, h.id) : null;
  const endedAt = p?.state === "ended" && p.endsAt !== null ? Math.min(p.endsAt, deletedAt) : deletedAt;
  const planEndAll = sub ? await planEndOf(env, h.id, sub) : { reason: null, refundState: null };
  return json({
    homeId: null,
    home: { id: h.id, state: "deleted", deletedAt },
    subscription: sub ? { plan: sub.plan, planName: plan ? PLAN_NAMES[plan] : sub.plan, priceUsd: plan ? PLAN_MONTHLY_USD[plan] : null, status: sub.status,
      ended: true, endedAt, cancelAtPeriodEnd: true, activeUntil: endedAt, endedReason: planEndAll.reason, refundState: planEndAll.refundState,
      // Astra JOURNEY-BCORE-1 #5: whether billing has stopped, as Stripe confirmed it. A deletion whose plan end Stripe has not confirmed yet
      // is `ending` with `confirmed: false`: the page says the end is being confirmed, and never promises that nothing more can be charged (renewalStopSentence).
      billing: p ? { state: p.state, endsAt: p.endsAt, confirmed: p.confirmed, noFurtherCharge: noFurtherCharge(p), sentence: planEndSentence(p) } : null,
      cancellation: { state: null, endsAt: null, id: null, kind: null, keepable: false, keepIds: [] }, refundRequest } : null,
    // Deleted: the server, its data and every backup are purged (members-api.ts deletionReceipt has the proof); nothing is kept.
    dataKeptUntil: null,
    startAgain: true,
  });
}

async function summary(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  let who: Awaited<ReturnType<typeof ownHome>>;
  try { who = await ownHome(request, env, deps, auth); }
  catch (e) {
    // No live home: a customer whose Cloud was deleted sees the ended view, never a bare 404 (the operator still names a live home).
    if (!(e instanceof HTTPError && e.status === 404) || await isOperator(request, env)) throw e;
    const ended = await endedView(env, (await currentUser(request, deps, auth)).id);
    if (!ended) throw e;
    return ended;
  }
  const now = nowOf(deps);
  // Every read the page needs, in ONE D1 batch (one round trip, not fourteen). The statements are the ones getSub, getTopup,
  // withdrawalState, noticeState (its notice and older-acceptance lookups; the summary needs only whether a notice is pending),
  // homeSoldByLink and latestAcceptance run one by one elsewhere.
  const cur = currentVersions();
  const [subR, topupR, expR, consentR, doneR, linkR, accR, noticeR, olderR, countryR, r7R, pubR, declR, keptR, endR, rrR] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM billing_subscriptions WHERE home_id=?").bind(who.homeId),
    env.DB.prepare("SELECT * FROM topup_settings WHERE home_id=?").bind(who.homeId),
    env.DB.prepare("SELECT id,status,requested_at,delivered_at,pause_until FROM data_export_requests WHERE home_id=? ORDER BY requested_at DESC LIMIT 1").bind(who.homeId),
    env.DB.prepare(WITHDRAWAL_CONSENT_SQL).bind(who.homeId),
    env.DB.prepare("SELECT confirmed_at,status FROM withdrawals WHERE home_id=?").bind(who.homeId),
    env.DB.prepare("SELECT c.tax_source FROM billing_subscriptions b JOIN checkout_consents c ON c.id=b.consent_id WHERE b.home_id=?").bind(who.homeId),
    env.DB.prepare(`SELECT cloud_terms_version,tos_version,privacy_version,accepted_at
      FROM terms_acceptances WHERE user_id=? AND ${acceptanceCounts("terms_acceptances")} ORDER BY accepted_at DESC, rowid DESC LIMIT 1`).bind(who.userId),
    env.DB.prepare(`SELECT notified_at FROM terms_change_notices WHERE user_id=? AND cloud_terms_version=? AND tos_version=? AND privacy_version=?`)
      .bind(who.userId, cur.cloudTerms, cur.termsOfService, cur.privacyPolicy),
    env.DB.prepare(`SELECT accepted_at FROM terms_acceptances WHERE user_id=? AND NOT (cloud_terms_version=? AND tos_version=? AND privacy_version=?)
      AND ${acceptanceCounts("terms_acceptances")} ORDER BY accepted_at DESC, rowid DESC LIMIT 1`).bind(who.userId, cur.cloudTerms, cur.termsOfService, cur.privacyPolicy),
    // Pre-fill for the next checkout: the country of the last CONFIRMED payment (what Stripe collected, else what the customer declared).
    // A completed order is not a payment (an asynchronous payment can still fail): only a consent with its own payment evidence (paid_at,
    // WP5's column from migration 0061, written from the signed webhook) counts, newest PAYMENT first. It lives on the consent, so a later
    // replacement of the home's billing_subscriptions row never erases it (WP4 r2-5).
    env.DB.prepare(`SELECT c.effective_country,c.stripe_country,c.declared_country,c.billing_country FROM checkout_consents c
      WHERE c.user_id=? AND c.paid_at IS NOT NULL AND c.rejected_at IS NULL
      ORDER BY c.paid_at DESC, c.rowid DESC LIMIT 1`).bind(who.userId),
    // The 7-day offer's deadline as frozen on the consent of the home's current contract (Astra WP5-1 #5).
    env.DB.prepare("SELECT c.refund7_until AS r FROM billing_subscriptions b JOIN checkout_consents c ON c.id=b.consent_id WHERE b.home_id=?").bind(who.homeId),
    env.DB.prepare(`SELECT ${publicCancelEndSql("b")} AS at, ${publicCurrentSql("b")} AS cur FROM billing_subscriptions b WHERE b.home_id=?`).bind(who.homeId),
    env.DB.prepare(openDeclarationsSql("(SELECT subscription_id FROM billing_subscriptions WHERE home_id=?)")).bind(who.homeId),
    // Keep my plan committed, Stripe's clear not yet read back.
    env.DB.prepare(`SELECT effective_at FROM cancellation_requests WHERE subscription_id=(SELECT subscription_id FROM billing_subscriptions WHERE home_id=?)
      AND match_state='matched' AND status='kept' AND kept_by='customer' AND stripe_synced=0 ORDER BY effective_at LIMIT 1`).bind(who.homeId),
    // A public cancellation that already ended the plan (an accepted serious reason, or an ordinary end that came due).
    env.DB.prepare(`SELECT MIN(COALESCE(effective_at, completed_at)) AS at FROM cancellation_requests WHERE subscription_id=(SELECT subscription_id FROM billing_subscriptions WHERE home_id=?)
      AND match_state='matched' AND status='completed' AND superseded_by IS NULL`).bind(who.homeId),
    // R16: the first-month refund request for THIS home's current first payment (an older payment's request is not shown), newest first.
    env.DB.prepare(`SELECT id,received_at,eligible,decided_at FROM refund_requests
      WHERE home_id=? AND payment_key=(SELECT first_invoice_id FROM billing_subscriptions WHERE home_id=?) ORDER BY received_at DESC, rowid DESC LIMIT 1`).bind(who.homeId, who.homeId),
  ]);
  const rrRow = (rrR.results[0] ?? null) as { id: string; received_at: number; eligible: number; decided_at: number | null } | null;
  const refundRequest = rrRow ? { id: rrRow.id, status: rrRow.decided_at !== null ? "decided" : rrRow.eligible === 1 ? "eligible" : "pending",
    receivedAt: rrRow.received_at, decidedAt: rrRow.decided_at } : null;
  const refund7Frozen = (r7R.results[0] as { r: number | null } | undefined)?.r ?? null;
  const homeRow = (await env.DB.prepare(`SELECT h.id,h.desired_state,h.grace_until,h.delete_after,h.ready_at,h.ready_legacy,${readyAnchorSql("h")} AS ready_anchor
    FROM cloud_homes h WHERE h.id=?`).bind(who.homeId).first<{ id: string; desired_state: string; grace_until: number | null; delete_after: number | null;
    ready_at: number | null; ready_legacy: number | null; ready_anchor: number | null }>())!;
  const last = (countryR.results[0] ?? null) as { effective_country: string | null; stripe_country: string | null; declared_country: string | null; billing_country: string } | null;
  const iso2 = (c: string | null | undefined) => c && /^[A-Za-z]{2}$/.test(c) ? c.toUpperCase() : null;
  // After a refused order (declared country differs from the billing address) the next reserve pre-fills Stripe's collected country (plan §1.2).
  const retry = await env.DB.prepare("SELECT collected_country,seller,reason,expires_at FROM checkout_retry_routes WHERE account_id=? AND expires_at>?").bind(who.userId, now)
    .first<{ collected_country: string; seller: string; reason: string; expires_at: number }>();
  const sub = (subR.results[0] ?? null) as Awaited<ReturnType<typeof getSub>>;
  const refundWin = sub && sub.first_paid_at !== null ? refundWindow(refund7Frozen, sub.first_paid_at, homeRow) : null;
  const topup = (topupR.results[0] ?? null) as Awaited<ReturnType<typeof getTopup>>;
  const exp = (expR.results[0] ?? null) as { id: string; status: string; requested_at: number; delivered_at: number | null; pause_until: number | null } | null;
  const wd = withdrawalFrom((consentR.results[0] ?? null) as WithdrawalConsent | null, (doneR.results[0] ?? null) as { confirmed_at: number; status: string } | null, now);
  const linkRow = (linkR.results[0] ?? null) as { tax_source: string | null } | null;
  const topupBlocked = linkRow !== null && sellerOfConsent(linkRow) === "link";
  const acceptance = (accR.results[0] ?? null) as AcceptanceRow | null;
  const noticePending = olderR.results.length > 0 && noticeR.results.length === 0;
  const termsState = { noticePending };
  const plan = planFrom(sub?.plan);
  // Confirmed only (Astra CANCEL-SUMMARY-1 #6): an in-app or public cancellation Stripe has not confirmed yet is `pending`, never "Cancelled".
  const pubRow = pubR.results[0] as { at: number | null; cur: number | null } | undefined;
  const ending = sub ? planEnding(sub, pubRow?.at ?? null, true, pubRow?.cur ?? null) : null;
  const terms = termsState.noticePending ? [] : changedSince(acceptance);
  // The public (§312k) cancellation the page shows (the earliest running one), and every declaration Keep my plan can take back now.
  const decls = declR.results as unknown as OpenDeclaration[];
  // The running declaration the page shows (the earliest): open, a serious reason under check, or held ("This wasn't me" pressed).
  // Astra JOURNEY-BCORE-5 #5: parked on a schedule, Stripe is still active: Keep stays offered after the date (the rule Keep applies).
  const parked = !!sub?.subscription_id && await scheduleParked(env, sub.subscription_id);
  // Astra JOURNEY-BCORE-6 #4: parked, a COMPLETED declaration has not ended the plan (Stripe refused its end): it still stands and is shown,
  // ending on its frozen date, being confirmed.
  const shown = decls.find((r) => r.status === "open" || r.status === "reason_pending" || r.status === "held" || (parked && r.status === "completed")) ?? null;
  // Astra JOURNEY-B-2 #10: ONE eligibility for both mechanisms, the rule Keep itself applies (KEEP_STILL_VALID, keepInApp): the home is the
  // current one and not being deleted (no deletion hold waiting), and its subscription has not ended. Never offered when Keep would refuse.
  const deletionWaits = (await env.DB.prepare(`SELECT 1 AS x FROM cloud_recovery_holds WHERE home_id=? AND action='delete'
    AND completed_at IS NULL AND canceled_at IS NULL`).bind(who.homeId).first()) !== null;
  const homeKeepable = !!sub && sub.status !== "canceled" && sub.status !== "disputed" && !["deleting", "deleted"].includes(homeRow.desired_state) && !deletionWaits;
  const keepIds = homeKeepable ? decls.filter((r) => keepableBy(r, who.userId, now, parked)).map((r) => r.id) : [];
  // B5: the in-app cancellation (Cancel plan, or the plan end a deletion journaled) has an id too: its CX reference. Keepable while it runs,
  // before the period end, by its owner, and not while the Cloud is being deleted (keepInApp, the same rule).
  const inAppId = sub && sub.customer_cancel_at !== null ? await inAppCancellationId(env, who.homeId) : null;
  const subPeriodEnd = sub ? sub.current_period_end ?? sub.first_charge_at : null;
  if (inAppId !== null && homeKeepable && (subPeriodEnd === null || subPeriodEnd > now || parked)) keepIds.push(inAppId);
  // Keep my plan pressed on an in-app cancellation and Stripe's clear not confirmed yet. Astra JOURNEY-B-1 #12: read from the Keep's own
  // evidence, never from the cached cancel_at_period_end: the current intent revision is the one a Keep of this subscription made, and Stripe
  // has not confirmed that revision (cancel_synced_rev behind it).
  const inAppKeeping = !!sub && sub.customer_cancel_at === null && sub.cancel_intent_rev > sub.cancel_synced_rev
    && (await env.DB.prepare(`SELECT 1 AS x FROM plan_cancellation_keeps k JOIN plan_cancellations c ON c.reference=k.reference WHERE c.home_id=? AND c.subscription_id=?
      AND k.revision=?`).bind(who.homeId, sub.subscription_id, sub.cancel_intent_rev).first()) !== null;
  // confirmed: Stripe shows the plan ending (cancelAtPeriodEnd); keeping: Keep my plan was pressed and Stripe's clear is not confirmed yet
  // (the plan still ends until it is); pending: a cancellation recorded here that Stripe has not confirmed yet.
  // Astra CANCEL-SUMMARY-2 #6: the state is derived per mechanism, apart from "ends this billing period" (cancelAtPeriodEnd/activeUntil):
  //   a running cancellation (a public one shown, or the in-app one) is confirmed once Stripe shows ITS end (the public date for the current
  //   revision, at any date, also beyond this period; cancel_at_period_end for the in-app one), else pending;
  //   with none running, a Keep Stripe has not confirmed is keeping, even when no end date was ever cached;
  //   any other end Stripe shows (a terms or address-change end, a Dashboard cancel_at) is confirmed.
  const periodEnd = sub ? sub.current_period_end ?? sub.first_charge_at : null;
  const publicAt = pubRow?.at ?? null;
  const cachedAt = sub && (pubRow?.cur ?? null) === null ? sub.cancel_at ?? null : null;
  const confirmedEnds = sub ? [sub.cancel_at_period_end === 1 ? periodEnd : null, publicAt, cachedAt].filter((x): x is number => x !== null) : [];
  const confirmedEnd = confirmedEnds.length ? Math.min(...confirmedEnds) : null;
  const keptUnconfirmedAt = (keptR.results[0] as { effective_at: number | null } | undefined)?.effective_at ?? null;
  const keeping = keptR.results.length > 0 || inAppKeeping;
  const inAppRunning = !!sub && sub.customer_cancel_at !== null;
  const cancelState: "confirmed" | "keeping" | "pending" | null = !sub ? null
    : shown !== null || inAppRunning
      // Parked: Stripe could not carry the end out, so nothing about it is confirmed; it is pending (the date stays the frozen promise).
      ? (!parked && ((shown !== null && publicAt !== null) || (inAppRunning && sub.cancel_at_period_end === 1 && !inAppPending(sub))) ? "confirmed" : "pending")
      : keeping ? "keeping" : confirmedEnd !== null ? "confirmed" : null;
  // Terminal (Astra CANCEL-SUMMARY-1 #7): the subscription is cancelled (status canceled, also an immediate Dashboard cancellation that
  // leaves both cancellation fields empty and the period end in the future), withdrawn, or ended by a public cancellation. Never "next charge".
  // Astra JOURNEY-BCORE-5 #5: a completed declaration whose end Stripe refused (parked: still active) has not ended the plan yet.
  const publicEndedAt = parked ? null : (endR.results[0] as { at: number | null } | undefined)?.at ?? null;
  const endedAts = [wd.done?.confirmed_at ?? null, publicEndedAt].filter((x): x is number => x !== null);
  const ended = !!sub && (sub.status === "canceled" || endedAts.length > 0);
  // Astra CANCEL-SUMMARY-2 #7: the immutable ended_at (migration 0094), never the mutable updated_at a delayed update moves.
  const endedAt = !ended ? null : endedAts.length ? Math.min(...endedAts) : sub!.ended_at ?? sub!.updated_at ?? null;
  // Follow-up 1 #1: why it ended (a disputed plan has ended its service too) and where the refund that came with the end stands.
  const planEnd = sub && (ended || sub.status === "disputed") ? await planEndOf(env, who.homeId, sub) : null;
  // Astra CANCEL-SUMMARY-2 #3: the id the page acts on is chosen from what Keep accepts NOW (keepIds), independently of the declaration shown:
  // the shown one when it is keepable, else the first keepable one (a held declaration, the in-app cancellation), else what is shown.
  const actionable = shown !== null && keepIds.includes(shown.id) ? shown.id : keepIds[0] ?? null;
  const cancelId = actionable ?? shown?.id ?? (cancelState === "keeping" ? null : inAppId);
  const cancelKind = cancelId === null ? null : cancelId === inAppId ? "in_app" : decls.find((x) => x.id === cancelId)?.kind ?? null;
  const cancelEndsAt0 = cancelState === "confirmed" ? (shown !== null && publicAt !== null ? publicAt : confirmedEnd)
    : cancelState === "keeping" ? confirmedEnd ?? keptUnconfirmedAt ?? periodEnd
      // Astra JOURNEY-BCORE-7 #2: an in-app cancellation whose promise awaits Stripe's live period (the cached end had passed) shows no
      // past date: the date is being confirmed.
      : cancelState === "pending" ? (shown?.effective_at ?? (inAppRunning && sub?.cancel_promised_end == null && periodEnd !== null && periodEnd <= now ? null : periodEnd)) : null;
  // Astra JOURNEY-BCORE-3 #11: while a cancellation runs, the date shown is the EARLIEST standing promise (frozen when it was made; the one the
  // resolution enforces), never the mutable current_period_end a renewal moved.
  const promised = !ended && (cancelState === "confirmed" || cancelState === "pending") && sub ? (await promiseOf(env, sub.subscription_id))?.promisedEndAt ?? null : null;
  const earliest = (x: number | null) => promised !== null && (x === null || promised < x) ? promised : x;
  const cancelEndsAt = earliest(cancelEndsAt0);
  // Keeping: until Stripe confirms the clear, the plan still ends (KEEP-MY-PLAN-CONTRACT.md): shown as ending at that date when it falls in
  // this period, whatever the cache holds.
  const keepingEnds = cancelState === "keeping" && cancelEndsAt !== null && (periodEnd === null || cancelEndsAt <= periodEnd);
  return json({
    homeId: who.homeId,
    // Pre-fill only (never decides anything): billingCountry is the ISO-2 of the last confirmed payment; country is the country the customer
    // declared then (the account's stored country). Both null before a first confirmed payment.
    retryCountry: iso2(retry?.collected_country),
    // The next step after a refused order or an address change that needs the other payment page (WP6): where to press "Continue to payment".
    // `payment_not_available` = no path can take payments from that country (the plan simply ends at its period end).
    nextStep: retry ? { kind: retry.seller === "none" ? "payment_not_available" : "continue_to_payment", reason: retry.reason, country: iso2(retry.collected_country),
      path: retry.seller === "link" ? "managed" : retry.seller === "ferrox" ? "direct" : null, until: retry.expires_at,
      planEndsAt: retry.reason === "address_change" ? sub?.current_period_end ?? null : null } : null,
    billingCountry: iso2(last?.effective_country ?? last?.stripe_country), country: iso2(last?.declared_country ?? last?.billing_country),
    // The trader (signed in only): shown on the withdrawal page, with the LEGAL_PHONE secret when it is set.
    trader: traderIdentity(env),
    withdrawal: { available: wd.available, endsAt: wd.available ? wd.endsAt : null, withdrawnAt: wd.done?.confirmed_at ?? null, status: wd.done?.status ?? null },
    subscription: sub ? {
      plan: sub.plan, planName: plan ? PLAN_NAMES[plan] : sub.plan, priceUsd: plan ? PLAN_MONTHLY_USD[plan] : null, status: sub.status,
      // Ending (no next charge) whichever way it was cancelled: see planEnding. The page shows "Cancelled, runs until activeUntil".
      // Ended: cancelAtPeriodEnd true and activeUntil = endedAt, so no page ever reads it as "Active, next charge".
      cancelAtPeriodEnd: ended || ending!.ending || keepingEnds,
      activeUntil: ended ? endedAt : keepingEnds && !ending!.ending ? cancelEndsAt : ending!.ending ? earliest(ending!.until) : ending!.until, serviceStartsAt: sub.service_start_at, firstChargeAt: sub.first_charge_at,
      ended, endedAt,
      // endedReason: "setup_failed_refunded" | "withdrawn" | "cancelled" | "dispute" | null; refundState: "pending" | "sent" | null (plan-end-reason.ts).
      endedReason: planEnd?.reason ?? null, refundState: planEnd?.refundState ?? null,
      waitingForStart: !ended && sub.status === "trialing" && sub.service_start_at !== null && sub.service_start_at > now,
      // B3: the later of the first payment and the server-ready day. Paid but not ready yet: null, and refundWindowStartsWhenReady true (the
      // page says the date shows once the server is ready).
      refundWindowEndsAt: refundWin?.endsAt ?? null,
      refundWindowStartsWhenReady: refundWin?.startsWhenReady ?? false,
      // R16: an outstanding or decided first-month refund request for the current first payment, or null (the page then offers the buttons).
      refundRequest,
      // A cancellation made through the public form: its id (POST /v1/account/cancellations/{id}/keep takes it back), kind and end.
      // keepIds: every declaration of this plan Keep my plan accepts now (normally just `id`).
      // state (Astra CANCEL-SUMMARY-1 #6): "confirmed" | "pending" | "keeping" | null; cancelAtPeriodEnd is true only when confirmed or keeping.
      cancellation: ended ? { state: null, endsAt: null, id: null, kind: null, keepable: false, keepIds: [] }
        : { state: cancelState, endsAt: cancelEndsAt, id: cancelId, kind: cancelKind, keepable: cancelId !== null && keepIds.includes(cancelId), keepIds },
    } : null,
    // available: false for a Link (Managed Payments) contract; the account page then shows no controls to switch it on.
    topup: topup ? { available: !topupBlocked, enabled: topup.enabled === 1 && !topupBlocked, amountUsd: topup.amount_cents / 100, thresholdUsd: topup.threshold_cents / 100, capUsd: topup.cap_cents / 100,
      capPeriod: topup.cap_period, capResets: topup.cap_resets, applied: topup.applied_revision === topup.revision, applyError: topup.apply_error }
      : { available: !topupBlocked, enabled: false, ...TOPUP_DEFAULTS, capPeriod: TOPUP_CAP_PERIOD, capResets: TOPUP_CAP_RESETS, applied: true, applyError: null },
    exportRequest: exp ? { id: exp.id, status: exp.status, requestedAt: exp.requested_at, deliveredAt: exp.delivered_at,
      pausesDeletionUntil: exp.status === "open" ? exp.pause_until : null, pausesDeletion: exp.status === "open" && exp.pause_until !== null } : null,
    terms: { reacceptRequired: terms.length > 0 },
    // B2: the home's lifecycle state, and until when its data is kept once the plan has ended (the retention schedule), else null.
    home: { id: homeRow.id, state: homeRow.desired_state },
    dataKeptUntil: dataKeptUntil(env, homeRow, exp?.status === "open" ? exp.pause_until : null),
    startAgain: false,
  });
}

// ---- The confirmation, kept on the account page ---------------------------------------------------------------------------------

async function confirmation(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  const who = await ownHome(request, env, deps, auth);
  const row = await env.DB.prepare("SELECT payload,created_at FROM billing_notices WHERE home_id=? AND kind='confirmation' ORDER BY created_at DESC LIMIT 1")
    .bind(who.homeId).first<{ payload: string; created_at: number }>();
  if (!row) throw new HTTPError(404, "not_found");
  const data = JSON.parse(row.payload) as { emailSubject?: string; emailText?: string };
  return json({ subject: data.emailSubject ?? "", text: data.emailText ?? "", sentAt: row.created_at });
}

// ---- Document versions: status and fresh acceptance ----------------------------------------------------------------------------

/** The change-notice state for the versions in force: acceptance (and the prompt) only after the 30-day notice was delivered to a customer
 *  who agreed to earlier versions; until the notice's effective date the versions that APPLY stay the earlier ones, even if accepted early. */
async function noticeState(env: Env, userId: string, now: number) {
  const cur = currentVersions();
  const notice = await env.DB.prepare(`SELECT notified_at,effective_at,cancel_set_at,period_end,lifted_at FROM terms_change_notices
    WHERE user_id=? AND cloud_terms_version=? AND tos_version=? AND privacy_version=?`).bind(userId, cur.cloudTerms, cur.termsOfService, cur.privacyPolicy)
    .first<{ notified_at: number; effective_at: number; cancel_set_at: number | null; period_end: number | null; lifted_at: number | null }>();
  const older = await env.DB.prepare(`SELECT cloud_terms_version AS c,tos_version AS t,privacy_version AS p,accepted_at FROM terms_acceptances
    WHERE user_id=? AND NOT (cloud_terms_version=? AND tos_version=? AND privacy_version=?) AND ${acceptanceCounts("terms_acceptances")}
    ORDER BY accepted_at DESC, rowid DESC LIMIT 1`)
    .bind(userId, cur.cloudTerms, cur.termsOfService, cur.privacyPolicy).first<{ c: string; t: string; p: string; accepted_at: number }>();
  const acc = await latestAcceptance(env, userId);
  const acceptedCurrent = changedSince(acc).length === 0 && acc !== null;
  const existingCustomer = older !== null;
  const noticePending = existingCustomer && !notice;
  // What applies today: the newest accepted set whose OWN notice deadline has passed (or that needed no notice), each judged on its own notice,
  // so an accepted-but-not-yet-effective revision is never reported early, however many revisions follow.
  const accs = await env.DB.prepare(`SELECT cloud_terms_version AS c,tos_version AS t,privacy_version AS p,accepted_at FROM terms_acceptances WHERE user_id=?
    AND ${acceptanceCounts("terms_acceptances")} ORDER BY accepted_at DESC, rowid DESC LIMIT 50`).bind(userId).all<{ c: string; t: string; p: string; accepted_at: number }>();
  let effective: { cloudTerms: string; termsOfService: string; privacyPolicy: string; from: number } | null = null;
  for (const a of accs.results) {
    const n = await env.DB.prepare("SELECT effective_at FROM terms_change_notices WHERE user_id=? AND cloud_terms_version=? AND tos_version=? AND privacy_version=?")
      .bind(userId, a.c, a.t, a.p).first<{ effective_at: number }>();
    if (n && now < n.effective_at) continue;
    effective = { cloudTerms: a.c, termsOfService: a.t, privacyPolicy: a.p, from: n ? Math.max(a.accepted_at, n.effective_at) : a.accepted_at };
    break;
  }
  return { cur, notice, acc, acceptedCurrent, existingCustomer, noticePending, effective };
}

async function termsStatus(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  const user = await currentUser(request, deps, auth);
  const cur = currentVersions();
  const acc = await latestAcceptance(env, user.id);
  const st = await noticeState(env, user.id, nowOf(deps));
  // No prompt before the notice: the customer is asked to accept only after the 30-day notice went out.
  const changed = st.noticePending ? [] : changedSince(acc);
  const notice = st.notice;
  return json({ effective: st.effective, noticePending: st.noticePending, current: cur, accepted: acc ? { cloudTerms: acc.cloud_terms_version, termsOfService: acc.tos_version, privacyPolicy: acc.privacy_version,
    acceptedAt: acc.accepted_at } : null, reacceptRequired: changed.length > 0, changed: changed.map((d) => ({ title: d.title, versionId: d.versionId })),
  noticeSentAt: notice?.notified_at ?? null, effectiveAt: notice?.effective_at ?? null,
  // Not accepted by the effective date: the plan ends (does not renew) at the end of this paid period unless accepted before then.
  planEndsAt: changed.length > 0 && notice?.cancel_set_at && !notice.lifted_at ? notice.period_end : null,
  wording: { reaccept: WORDING.reaccept, arbitration: WORDING.arbitration, nonAcceptance: TERMS_NONACCEPTANCE_WORDING } });
}

async function acceptTerms(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  const user = await currentUser(request, deps, auth);
  const body = await readJSON(request, acceptBody);
  const cur = currentVersions(); const dv = body.documentVersions;
  // Acceptance binds to the versions the page showed; a page from before another change is stale.
  if (dv.cloudTerms !== cur.cloudTerms || dv.termsOfService !== cur.termsOfService || dv.privacyPolicy !== cur.privacyPolicy) throw new HTTPError(409, "disclosure_stale");
  const now = nowOf(deps);
  // An existing customer accepts changed versions only after the 30-day notice was delivered (the notice comes first, in code).
  if ((await noticeState(env, user.id, now)).noticePending) throw new HTTPError(409, "notice_pending");
  await env.DB.batch([...archiveCurrentDocs(env, now),
    env.DB.prepare(`INSERT INTO terms_acceptances (id,user_id,cloud_terms_version,tos_version,privacy_version,source,consent_id,wording,accepted_at,client_meta)
      VALUES (?,?,?,?,?,'reaccept',NULL,?,?,?)`).bind(`accept-${crypto.randomUUID()}`, user.id, cur.cloudTerms, cur.termsOfService, cur.privacyPolicy,
      WORDING.reaccept, now, JSON.stringify(clientMeta(body.client, request)))]);
  // Accepted before the paid period ended: the plan carries on (a non-renewal set for non-acceptance is taken back).
  let planContinues = true;
  try { await liftTermsCancel(env, deps, user.id, now); } catch { planContinues = false; /* the sweep lifts it on its next run */ }
  return json({ accepted: true, versions: cur, acceptedAt: now, planContinues });
}

// ---- Cancel plan ----------------------------------------------------------------------------------------------------------------

async function cancelPlan(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  // Authenticate first, configuration after (Astra MAKERKIT7 #1; the worker's Cloud-route gate also does this).
  const body = await readJSON(request, cancelSchema);
  const who = await actor(request, env, deps, auth, body.homeId, "subscribed");
  const config = cfg(env);
  const sub = await getSub(env, who.homeId);
  if (!sub?.subscription_id) throw new HTTPError(404, "not_found");
  if (sub.status === "canceled" || sub.status === "disputed") throw new HTTPError(409, "already_canceled");
  const activeUntil = sub.current_period_end ?? sub.first_charge_at;
  // The receipt's reference (CX-..., one per home and subscription, kept across presses and retries). It only names the cancellation: whether the
  // plan ends is decided below, by the intent and Stripe's read-back, and never depends on this row or on any email.
  const receipt = await cancellationReceipt(env, who.homeId, sub.subscription_id, sub.customer_cancel_at ?? nowOf(deps));
  // Astra JOURNEY-BCORE-4 #6: the date shown is the EARLIEST standing promise (frozen when the plan was cancelled), never the current period's
  // end (a renewal can have moved that). Falls back to the period end only when no promise stands.
  const subId = sub.subscription_id;
  const shownEnd = async (fallback: number | null) => (await promiseOf(env, subId))?.promisedEndAt ?? fallback;
  // Astra JOURNEY-BCORE-5 #6: never while parked: a parked press is journaled below and answered processing.
  if (sub.customer_cancel_at !== null && sub.cancel_synced_rev === sub.cancel_intent_rev && sub.cancel_at_period_end === 1 && !await scheduleParked(env, subId)) {
    const promised = await shownEnd(activeUntil);
    return json({ canceled: true, alreadyScheduled: true, reference: receipt?.reference ?? null, receivedAt: sub.customer_cancel_at, effectiveAt: promised, activeUntil: promised,
      sentence: renewalStopSentence(promised ? new Date(promised).toISOString().slice(0, 10) : null) });
  }
  // The customer's intent is recorded first (durable, revisioned), then synced under the home's lease and confirmed by Stripe's read-back.
  // A re-acceptance syncing at the same moment re-reads the newest intent, so this cancellation always wins.
  // Astra TAXCOUNTRY-8 (coordinator a): cancelling is never gated, so the intent is persisted BEFORE any lease or provider work, bound to the
  // subscription read above (a home that moved to another contract since records nothing on it). A busy home then answers "processing":
  // the intent stands and the billing sweep (cancel_intent_rev ahead of cancel_synced_rev) confirms it. The intent and its generation-bound
  // resolution commit together (Astra JOURNEY-BCORE-2 #1).
  const recorded = await env.DB.batch([q(`${IN_APP_CANCEL_INTENT_SQL} AND subscription_id=?`, nowOf(deps), nowOf(deps), who.homeId, subId),
    ...inAppResolutionQ(who.homeId, nowOf(deps))].map(([sql, binds]) => env.DB.prepare(sql).bind(...(binds ?? []))));
  if (recorded[0].meta.changes !== 1) throw new HTTPError(409, "home_busy"); // the plan changed under the press: nothing recorded, retry
  let end = activeUntil; let pending = false;
  try {
    await withHomeLease(env, who.homeId, async (lease) => {
      try { end = (await syncCancellation(env, deps, who.homeId, lease)).periodEnd ?? end; }
      catch (e) {
        if (!(e instanceof LeaseLost || e instanceof StripeError || e instanceof CancelUnconfirmed)) throw e;
        pending = true;
      }
    }, deps.lease);
  } catch (e) {
    if (e instanceof HomeBusy || e instanceof LeaseLost) pending = true; // recorded: the sweep confirms it
    else throw e;
  }
  void config;
  // Confirmed only when Stripe read back cancel_at_period_end=true (the confirmation email is sent from that same step, in
  // syncCancellation). Anything else is still being done: say so, and the operation retries.
  if (pending) return json({ canceled: false, processing: true });
  // The receipt screen: the reference to quote, when the request arrived, and when the plan ends (the end of the period already paid for).
  const received = (await getSub(env, who.homeId))?.customer_cancel_at ?? receipt?.received_at ?? nowOf(deps);
  end = await shownEnd(end);
  return json({ canceled: true, reference: receipt?.reference ?? null, receivedAt: received, effectiveAt: end, activeUntil: end, sentence: renewalStopSentence(end ? new Date(end).toISOString().slice(0, 10) : null) });
}

/** The cancellation receipt of a home's subscription: created once (the unique index makes a race or a repeated press return the same
 *  reference), read back. Its reference comes from the allocator shared with the public form (allocateCancelRef: unique across both tables,
 *  collisions retried). Null if no reference can be reserved or the table cannot be written; the cancel goes on without a reference. */
async function cancellationReceipt(env: Env, homeId: string, subscriptionId: string, receivedAt: number): Promise<{ reference: string; received_at: number } | null> {
  const read = () => env.DB.prepare("SELECT reference,received_at FROM plan_cancellations WHERE home_id=? AND subscription_id=?").bind(homeId, subscriptionId)
    .first<{ reference: string; received_at: number }>();
  try {
    const existing = await read();
    if (existing) return existing;
    const reference = await allocateCancelRef(env, `plan:${homeId}:${subscriptionId}`, receivedAt);
    await env.DB.prepare(`INSERT OR IGNORE INTO plan_cancellations (reference,home_id,user_id,subscription_id,received_at)
      SELECT ?,id,owner_id,?,? FROM cloud_homes WHERE id=?`).bind(reference, subscriptionId, receivedAt, homeId).run();
    return await read();
  } catch { return null; }
}

// ---- Auto top-up -----------------------------------------------------------------------------------------------------------------

/** Journey A3: true when this top-up change cannot raise spending, so it needs sign-in only: it switches the top-up OFF (or leaves it off), or it
 *  keeps it ON with an amount, threshold and cap each no higher than today's. Switching ON, or raising any of the three, is false (step-up). */
export async function topupReduces(env: Env, homeId: string, body: { enabled: boolean; amountUsd: number; thresholdUsd: number; capUsd: number }): Promise<boolean> {
  if (!body.enabled) return true;
  const current = await getTopup(env, homeId);
  if (!current || current.enabled !== 1) return false;
  return body.amountUsd * 100 <= current.amount_cents && body.thresholdUsd * 100 <= current.threshold_cents && body.capUsd * 100 <= current.cap_cents;
}
/** The worker gate's question for POST /v1/account/topup, from the buffered body: is this change exempt from step-up? Anything it cannot read or
 *  resolve is "no" (the route-level step-up applies). The handler asks topupReduces again with the home it resolves itself. */
export async function topupStepUpExempt(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<boolean> {
  try {
    const parsed = topupBody.safeParse(await request.clone().json());
    if (!parsed.success) return false;
    const user = await currentUser(request, deps, auth);
    const row = await env.DB.prepare("SELECT id FROM cloud_homes WHERE owner_id=? AND desired_state<>'deleted' ORDER BY created_at DESC LIMIT 1").bind(user.id).first<{ id: string }>();
    if (!row || (parsed.data.homeId !== undefined && parsed.data.homeId !== row.id)) return false;
    return await topupReduces(env, row.id, parsed.data);
  } catch { return false; }
}

async function topup(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  if (request.method === "GET") return summary(request, env, deps, auth);
  const body = await readJSON(request, topupBody);
  validateTopup(body);
  const who = await ownHome(request, env, deps, auth, body.homeId);
  const now = nowOf(deps);
  const meta = clientMeta(body.client, request);
  // Under the home's lease (a busy home is told to retry). Applied to Flux auto-recharge at once, so a lower cap or a switch-off takes effect
  // immediately; if Flux cannot take it now, the sweep retries and the page says it is not active yet.
  const applied = await busyAs409(() => withHomeLease(env, who.homeId, async (lease) => {
    // Automatic top-up is a Ferrox charge on the saved payment method. A Link (Managed Payments) subscription only authorizes Link to charge
    // it, so top-ups are not offered to those customers (switching one off is always allowed). Checked INSIDE the lease, against the
    // contract that holds the home now (applyTopup checks it again before anything reaches Flux).
    if (body.enabled && await homeSoldByLink(env, who.homeId)) throw new HTTPError(409, "topup_not_available");
    // The worker gate lets a top-up change through without a second factor only when it cannot raise spending (topupReduces). The settings it
    // compared with may have changed since (a concurrent switch-off makes an "unchanged" request an enable), so the rule is checked again HERE,
    // inside the lease, against the settings this save replaces, immediately before saving (Astra JOURNEY-A-1 A3).
    if (!who.operator && !await topupReduces(env, who.homeId, body) && !await (deps.stepUp ?? (async () => false))(env, request, auth)) {
      throw new HTTPError(403, "step_up_required");
    }
    await saveTopup(env, lease, { homeId: who.homeId, userId: who.userId, enabled: body.enabled, amountCents: body.amountUsd * 100, thresholdCents: body.thresholdUsd * 100,
      capCents: body.capUsd * 100, consentId: null, source: who.operator ? "operator" : "account", ip: meta.claimed.ip ?? meta.observed.ip,
      userAgent: meta.claimed.userAgent ?? meta.observed.userAgent }, now);
    return applyTopup(env, lease, fluxOf(deps), who.homeId, now);
  }, deps.lease));
  return json({ enabled: body.enabled, amountUsd: body.amountUsd, thresholdUsd: body.thresholdUsd, capUsd: body.capUsd, applied,
    authorization: body.enabled ? topupChargeText({ amount: body.amountUsd, threshold: body.thresholdUsd, cap: body.capUsd }) : null });
}

// ---- Export request pauses deletion ---------------------------------------------------------------------------------------------

async function requestExport(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  const body = await readJSON(request, exportBody);
  const who = await ownHome(request, env, deps, auth, body.homeId);
  // A fresh second step (SPEC §5 item 8): the worker gate (STEP_UP_ROUTES) answers first with the step_up body; this is the handler's own check.
  if (!who.operator && !await (deps.stepUp ?? (async () => false))(env, request, auth)) throw new HTTPError(403, "step_up_required");
  const now = nowOf(deps);
  const home = (await env.DB.prepare("SELECT desired_state,generation FROM cloud_homes WHERE id=?").bind(who.homeId).first<{ desired_state: string; generation: number }>())!;
  // Once irreversible deletion is committed there is nothing to export: refuse rather than promise a pause that cannot happen.
  if (home.desired_state === "deleting" || home.desired_state === "deleted") throw new HTTPError(409, "home_deleting");
  const open = await env.DB.prepare("SELECT id,requested_at,pause_until FROM data_export_requests WHERE home_id=? AND status='open' AND pause_until>? ORDER BY requested_at DESC LIMIT 1")
    .bind(who.homeId, now).first<{ id: string; requested_at: number; pause_until: number }>();
  if (open) return json({ requestId: open.id, requestedAt: open.requested_at, pausesDeletionUntil: open.pause_until, existing: true });
  // While the home is suspended (deletion scheduled), one pause per deletion cycle. A later request is still accepted and answered (access
  // and portability requests are never capped), but it does not pause the deletion again: it is recorded with no pause (pause_until NULL).
  let pauses = true;
  if (home.desired_state === "suspended") {
    const used = await env.DB.prepare("SELECT MAX(pause_until) AS p FROM data_export_requests WHERE home_id=? AND cycle=?").bind(who.homeId, home.generation).first<{ p: number | null }>();
    if (used?.p) pauses = false;
  }
  const id = `export-${crypto.randomUUID()}`;
  const pauseUntil = pauses ? now + EXPORT_PAUSE_MAX_MS : null;
  // Accepted only if the home is still not being deleted, in the same statement: the lifecycle's move to "deleting" checks for open requests
  // in its own batch, so either the request is in first (deletion waits) or the deletion is (the request is refused).
  const ins = await env.DB.prepare(`INSERT INTO data_export_requests (id,home_id,user_id,requested_at,pause_until,cycle)
    SELECT ?,id,?,?,?,generation FROM cloud_homes WHERE id=? AND generation=? AND desired_state NOT IN ('deleting','deleted')`)
    .bind(id, who.userId, now, pauseUntil, who.homeId, home.generation).run();
  if (ins.meta.changes !== 1) {
    const st = await env.DB.prepare("SELECT desired_state FROM cloud_homes WHERE id=?").bind(who.homeId).first<{ desired_state: string }>();
    throw new HTTPError(409, st && ["deleting", "deleted"].includes(st.desired_state) ? "home_deleting" : "state_conflict");
  }
  // Automated export (S7): a running home builds the encrypted archive; anything else goes to the operator at once. Never throws.
  await queueExportArchive(env, who.homeId, id, pauseUntil ?? now + EXPORT_PAUSE_MAX_MS, now);
  // Operators see it in the same place as every other open alert.
  await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
    .bind(crypto.randomUUID(), who.homeId, "export_requested", "warning", JSON.stringify({ requestId: id, due: pauseUntil }), now).run();
  const text = pauseUntil !== null
    ? `We received your request for a copy of your Murage Cloud data.\n\nWe send the export within 7 days (by ${isoDate(pauseUntil)}). Until then, or until we send it, we do not delete your server or its data. After that, deletion goes ahead on the usual schedule: ${retentionDaysText(env)} after your server was suspended, and never sooner.\n\nRequest ID: ${id}`
    : `We received your request for a copy of your Murage Cloud data.\n\n${EXPORT_REPEAT_WORDING}\n\nRequest ID: ${id}`;
  try {
    await notify(env, deps, who.homeId, "export_requested", id, { requestId: id, emailText: text, emailHtml: htmlOf(text) });
  } catch { /* recorded; the sweep retries the email */ }
  return json({ requestId: id, requestedAt: now, pausesDeletionUntil: pauseUntil, existing: false,
    state: pauseUntil !== null ? "recorded_pausing_deletion" : "recorded_without_pause" }, 201);
}

async function exportDelivered(request: Request, env: Env, deps: BillingDependencies): Promise<Response> {
  await admin(request, env);
  const body = await readJSON(request, deliveredBody);
  const now = nowOf(deps);
  const row = await env.DB.prepare("SELECT id,home_id,status FROM data_export_requests WHERE id=?").bind(body.requestId).first<{ id: string; home_id: string; status: string }>();
  if (!row) throw new HTTPError(404, "not_found");
  if (row.status === "open" || row.status === "expired") {
    await env.DB.batch([
      env.DB.prepare("UPDATE data_export_requests SET status='delivered',delivered_at=?,closed_at=? WHERE id=?").bind(now, now, row.id),
      env.DB.prepare("UPDATE cloud_alerts SET resolved_at=? WHERE home_id=? AND kind='export_requested' AND resolved_at IS NULL").bind(now, row.home_id),
    ]);
    const text = "We sent the copy of your Murage Cloud data you asked for. Your request is closed.";
    try { await notify(env, deps, row.home_id, "export_delivered", row.id, { requestId: row.id, emailText: text, emailHtml: htmlOf(text) }); } catch { /* sweep retries */ }
  }
  return json({ requestId: row.id, delivered: true });
}

// ---- First-month refund ---------------------------------------------------------------------------------------------------------

/** Reasons a quote can give that are not decisions: a fact is not readable right now. Never told to the customer as a refusal. */
const TEMPORARY_REFUND_REASONS = new Set(["identity_check_unavailable"]);

/** The EU/UK 14-day full refund already opened for the home's current payment (eu14:<invoice>), if any. A request asked again resolves
 *  THAT operation, whatever today's date: its entitlement was fixed at its receipt time (Astra ASTRA-REFUND3 #5). */
async function openedEuUkFullRefund(env: Env, homeId: string, invoiceId?: string) {
  const inv = invoiceId ?? (await pinCurrentPayment(env, homeId))?.invoiceId ?? null;
  const op = inv ? await getRefundOp(env, `eu14:${inv}`) : null;
  return op && op.home_id === homeId ? op : null;
}

/** Astra JOURNEY-A-3 #6: the payment a recorded request was made for, as of its receipt: the snapshot stored with the request (its invoice
 *  and that payment's subscription), else recovered from Stripe by its invoice id (paid, for this home's subscription). null only when that
 *  invoice truly cannot be found (the only case that answers payment_changed). */
interface RequestPayment { pay: PinnedPayment; subscriptionId: string }
async function requestPayment(env: Env, ctx: RefundContext, req: { home_id: string; payment_key: string; payment_snapshot: string | null; subscription_id: string | null }):
  Promise<RequestPayment | null> {
  if (req.payment_snapshot && req.subscription_id) {
    try {
      const pay = JSON.parse(req.payment_snapshot) as PinnedPayment;
      if (pay.invoiceId === req.payment_key && pay.paidCents > 0) return { pay, subscriptionId: req.subscription_id };
    } catch { /* recovered from Stripe below */ }
  }
  let inv: Awaited<ReturnType<RefundContext["stripe"]["getInvoice"]>>;
  try { inv = await ctx.stripe.getInvoice(req.payment_key); }
  catch (e) { if (e instanceof StripeError && e.status === 404) return null; throw e; }
  const homeOf = typeof inv.subscriptionMetadata.home_id === "string" ? inv.subscriptionMetadata.home_id : null;
  if (inv.id !== req.payment_key || inv.status !== "paid" || !(inv.amount_paid > 0) || !inv.subscription || homeOf !== req.home_id) return null;
  const period = inv.lines?.data?.[0]?.period;
  return { subscriptionId: inv.subscription, pay: { invoiceId: inv.id, paymentIntent: inv.payment_intent, paidCents: inv.amount_paid, taxCents: inv.tax ?? 0,
    paidAt: (inv.paid_at ?? inv.created) * 1000, periodStart: typeof period?.start === "number" ? period.start * 1000 : null,
    periodEnd: typeof period?.end === "number" ? period.end * 1000 : null } };
}

/** Astra JOURNEY-A-2 A2: an existing refund operation answers a recorded request only when it concerns that request's own payment (invoice)
 *  and contract (consent). An operation of the account for another payment (or another contract) never consumes the request: the request
 *  stays outstanding, and its alert open, until its own decision is recorded. An operation that predates consent pinning (no consentId in
 *  its detail) is matched by its payment alone. */
function opServesRequest(op: RefundOpRow, req: { payment_key: string; consent_id: string | null }): boolean {
  if (op.invoice_id !== req.payment_key) return false;
  let d: { consentId?: string | null } = {};
  try { d = JSON.parse(op.detail ?? "{}") as { consentId?: string | null }; } catch { d = {}; }
  // Astra JOURNEY-A-3 #5: a consent pinned as null is a contract of its own (no consent), never a wildcard; only an absent key predates pinning.
  return d.consentId === undefined || d.consentId === req.consent_id;
}

async function refundFirstMonth(request: Request, env: Env, deps: BillingDependencies): Promise<Response> {
  await admin(request, env);
  const body = await readJSON(request, refundBody);
  const now = nowOf(deps);
  const ctx = refundCtx(env, deps);
  // Journey A2 (Astra JOURNEY-A-1): a customer's refund request is executed BY ITS ID. It is decided as of the moment it was received (a
  // request received inside the window is never window_expired later, however long it waited for a person), for the payment and contract
  // it was recorded for (anything else is payment_changed). Still operator-only, and every limit below (once per person and payment method,
  // abuse closure, refunds already made) applies exactly as to a request by home.
  const req = body.requestId ? await env.DB.prepare(`SELECT id,home_id,payment_key,consent_id,received_at,refund_op_id,payment_snapshot,subscription_id
    FROM refund_requests WHERE id=?`).bind(body.requestId)
    .first<{ id: string; home_id: string; payment_key: string; consent_id: string | null; received_at: number; refund_op_id: string | null;
      payment_snapshot: string | null; subscription_id: string | null }>() : null;
  if (body.requestId && !req) throw new HTTPError(404, "not_found");
  const homeId = req?.home_id ?? body.homeId!;
  // The receipt time the decision is judged at: the quote, the EU/UK entitlement and the operation opened below all carry it (the operation's
  // created_at is its receipt time, as for a reopened refusal), so the ledger decides the request as received, never as of the day it ran.
  const asOf = req?.received_at ?? now;
  // Astra JOURNEY-A-3 #5: the request's consent is passed as recorded, null included: a pinned null never falls back to the live consent.
  const quoteOpts: Parameters<typeof quoteFirstMonthRefund>[3] = { stripe: ctx.stripe, ...(req ? { processedAt: now, consentId: req.consent_id } : {}) };
  // Astra JOURNEY-A-3 #6: a request whose payment a replacement checkout has since superseded (first_invoice_id changed) is decided on ITS
  // payment: the snapshot recorded at receipt (or recovered from Stripe), its own subscription, never the replacement's. Set by samePayment.
  let replaced = null as RequestPayment | null;
  // Astra JOURNEY-A-2 A2: the request's own payment/contract snapshot (its invoice and consent, as recorded at receipt) is what entitlement
  // selection, the quote and the operation use, never the home's live consent.
  const pinnedReq = () => req ? { invoiceId: req.payment_key, consentId: req.consent_id, snapshot: replaced } : undefined;
  /** An existing operation of the account that does not concern this request's payment and contract: the request stays outstanding. */
  let foreignOp = null as RefundOpRow | null;
  const serves = (op: RefundOpRow) => !req || opServesRequest(op, req);
  const samePayment = async () => {
    if (!req) return;
    const current = await pinCurrentPayment(env, homeId);
    if (current && current.invoiceId === req.payment_key) { replaced = null; return; }
    replaced = await requestPayment(env, ctx, req);
    if (!replaced) throw new HTTPError(409, "payment_changed");
  };
  const payInvoice = async () => replaced?.pay.invoiceId ?? (await pinCurrentPayment(env, homeId))?.invoiceId ?? null;
  /** The request's own snapshot, as of its receipt (Astra JOURNEY-A-4 #4): the superseded payment, else the home's payment samePayment
   *  confirmed is the request's, with its subscription; the consent as recorded (null kept). null: nothing provable to reopen on. */
  const requestSnapshot = async (): Promise<RequestSnapshot | null> => {
    if (!req) return null;
    if (replaced) return { pay: replaced.pay, subscriptionId: replaced.subscriptionId, consentId: req.consent_id, receivedAt: req.received_at };
    const pay = await pinCurrentPayment(env, homeId);
    const subscriptionId = req.subscription_id ?? (await getSub(env, homeId))?.subscription_id ?? null;
    return pay && pay.invoiceId === req.payment_key && subscriptionId ? { pay, subscriptionId, consentId: req.consent_id, receivedAt: req.received_at } : null;
  };
  if (body.dryRun) {
    await samePayment();
    // An EU/UK 14-day full refund already requested for this payment is what a preview shows, also after day 14 (ASTRA-REFUND3 #5).
    const openedAny = await openedEuUkFullRefund(env, homeId, replaced?.pay.invoiceId);
    const opened = openedAny && serves(openedAny) ? openedAny : null;
    const d = opened ? JSON.parse(opened.detail ?? "{}") as { pay?: PinnedPayment; consentId?: string } : null;
    if (opened && d?.pay && d.consentId && opened.subscription_id) {
      // While it is still being paid, its own decided amount is what it pays (not "already refunded").
      const q = await euUkFullRefundQuote(env, homeId, { ownerId: opened.user_id, pay: d.pay, subscriptionId: opened.subscription_id, consentId: d.consentId },
        opened.done_at === null ? opened.id : undefined);
      return json({ quote: q, basis: "eu_uk_full_refund", dryRun: true, pending: opened.done_at === null, ...(q.eligible || opened.done_at === null ? {} : { message: denialText(q.reason) }) } as never);
    }
    // The same entitlement the request below opens: the EU/UK 14-day full refund first, then the 7-day offer (Astra ASTRA-REFUND2 #6).
    const eu = await euUkFullRefundFor(env, homeId, asOf, pinnedReq());
    const quoteR = eu ? await euUkFullRefundQuote(env, homeId, eu) : await quoteFirstMonthRefund(env, homeId, asOf, { ...quoteOpts, ...(replaced ? { pinned: replaced.pay } : {}) });
    return json({ quote: quoteR, basis: eu ? "eu_uk_full_refund" : "seven_day_offer", dryRun: true, ...(quoteR.eligible ? {} : { message: denialText(quoteR.reason) }) } as never);
  }
  // Everything about the contract (the quote, the payment, its subscription) is read INSIDE the home's lease and written in the same lease:
  // a replacement checkout that finishes meanwhile makes this request answer payment_changed, and an operation can never mix one
  // payment with another subscription. The operation is opened for exactly that one payment.
  let quoteR = null as Awaited<ReturnType<typeof quoteFirstMonthRefund>> | null; let ineligible = false;
  const op = await busyAs409(() => withHomeLease(env, homeId, async (lease) => {
    await samePayment();
    // A request already executed is answered from its own operation (resumed if still running), never decided a second time.
    const executed = req?.refund_op_id ? await getRefundOp(env, req.refund_op_id) : null;
    if (executed) return executed.done_at === null ? advanceRefundOp(env, { ...ctx, lease }, executed.id) : executed;
    // An EU/UK 14-day full refund already opened for this payment (asked within its 14 days, still pending or done) is the SAME request:
    // it is resolved first, never recalculated from today's date. A retry on day 15 of a request received on day 13 is not
    // window_expired and is never sent a refusal (Astra ASTRA-REFUND3 #5).
    const opened = await openedEuUkFullRefund(env, homeId, replaced?.pay.invoiceId);
    if (opened && !serves(opened)) { foreignOp = opened; return null; }
    if (opened) return opened.done_at === null ? advanceRefundOp(env, { ...ctx, lease }, opened.id) : opened;
    // An EU, EEA or UK consumer within 14 days of the server's start (its payment) gets the full refund: its own entitlement, opened
    // before (and never through) the 7-day offer's checks; nothing of the offer (identity) is even read.
    const eu = await euUkFullRefundFor(env, homeId, asOf, pinnedReq());
    if (eu) {
      const fullId = `eu14:${eu.pay.invoiceId}`;
      // A superseded payment's refund never ends the plan or takes credits back: both belong to the replacement now (Astra JOURNEY-A-3 #6).
      await fencedBatch(env, lease, [refundOpInsert({ id: fullId, kind: "first_month", homeId: homeId, userId: eu.ownerId, invoiceId: eu.pay.invoiceId,
        paymentIntent: eu.pay.paymentIntent, subscriptionId: eu.subscriptionId, endPlan: !replaced, detail: { pay: eu.pay, consentId: eu.consentId, euUkFull: true } }, asOf)]);
      return advanceRefundOp(env, { ...ctx, lease }, fullId);
    }
    // A request asked again while the customer's earlier one is still open is the SAME request: it resumes from its checkpoint and answers
    // its state. It is never quoted again (its own once-per-customer slot would read as "already refunded") and never sent a refusal
    // (Astra ASTRA-REFUND2 #5). An open request for another of the customer's homes is answered as pending, also without a refusal.
    const ownerRow = await env.DB.prepare("SELECT owner_id FROM cloud_homes WHERE id=?").bind(homeId).first<{ owner_id: string }>();
    const current = req ? null : await pinCurrentPayment(env, homeId);
    const requestInvoice = req ? req.payment_key : current?.invoiceId ?? null;
    // Astra JOURNEY-A-3 #4: this payment's own operation if it has one, else the account's (unless another payment's refusal holds that id).
    const open = ownerRow ? (await firstMonthOpFor(env, ownerRow.owner_id, requestInvoice)).op : null;
    // A legacy refusal (all_credit_used, or a deducted already_refunded: Astra NODEDUCT-1 #2, NODEDUCT-2 #1) is not resumed: a fresh
    // request is quoted below and may reopen it.
    if (open && open.done_at === null && !isLegacyRefusal(open)) {
      if (!serves(open)) { foreignOp = open; return null; } // another payment's (or contract's) request: this one stays outstanding
      return open.home_id === homeId ? advanceRefundOp(env, { ...ctx, lease }, open.id) : open;
    }
    // This payment's request was refused at request time and that refusal no longer stands (held under an open objection, or obsolete
    // after its codes were erased): asking again is the SAME request. It is reopened from its original receipt and judged as of then,
    // never window_expired for a request that was on time (Astra ASTRA-REFUND6 #4).
    const receiptInvoice = await payInvoice();
    const receipt = receiptInvoice ? await refusalReceiptFor(env, receiptInvoice) : null;
    if (receipt && await refusalReceiptReopenable(env, receipt, true)) {
      // Astra JOURNEY-A-4 #4: a recorded request reopens on ITS snapshot (payment, subscription, consent with an explicit null, receipt
      // time), never the home's live state; the operation id comes from the shared invoice-aware allocator.
      const reopened = await reopenRefusedRequest(env, { ...ctx, lease }, receipt, req ? await requestSnapshot() : undefined);
      if (reopened) return advanceRefundOp(env, { ...ctx, lease }, reopened);
    }
    quoteR = await quoteFirstMonthRefund(env, homeId, asOf, { ...quoteOpts, ...(replaced ? { pinned: replaced.pay } : {}) });
    // A check that cannot run right now (identity keys) is not a decision: the request is recorded below exactly like an
    // eligible one, with its receipt time, and the sweep decides it as of that time once the facts are known.
    let temporary = TEMPORARY_REFUND_REASONS.has(quoteR.reason ?? "");
    if (quoteR.reason === "not_first_payment" && quoteR.invoiceId && quoteR.userId) {
      // The refusal is re-checked right before the customer is told (Astra ASTRA-REFUND4 #2): an objection opened since the identity
      // check means the codes it rests on may not be used. The request is then recorded and held (pending), never refused.
      const c = refusalStands(quoteR.invoiceId, quoteR.userId);
      const stands = await env.DB.prepare(`SELECT ${c.sql} AS ok`).bind(...c.binds).first<{ ok: number }>();
      if (!stands?.ok) { quoteR = { ...quoteR, reason: "identity_check_unavailable" }; temporary = true; }
    }
    if ((!quoteR.eligible && !temporary) || !quoteR.userId || !quoteR.invoiceId) {
      // Never a silent refusal: the reason in plain words, recorded under THIS lease (one notice per payment and reason) before the answer
      // is given. A send that fails after the notice is recorded is retried by the sweep; a notice that could not even be recorded fails
      // the request instead of being swallowed.
      const reason = quoteR.reason ?? "not_eligible";
      if (reason !== "not_found" && !TEMPORARY_REFUND_REASONS.has(reason)) {
        const noticeKey = `${reason}:${quoteR.invoiceId ?? "none"}`;
        const noticeId = `refund_declined:${homeId}:${noticeKey}`;
        const text = `About your refund request for Murage Cloud.\n\n${denialText(reason)}`;
        // A "not your first payment" refusal keeps its receipt, written with the people it rests on BEFORE the refusal is claimed and
        // handed to EMAIL (Astra ASTRA-REFUND7 #4): an erasure while the email is in flight finds it and records its invalidation, so
        // the request is reopened from it (the sweep, or asking again), never lost (ASTRA-REFUND6 #4).
        if (reason === "not_first_payment" && quoteR.invoiceId && quoteR.userId) {
          // A fenced batch (lease guard + the INSERT ... SELECT ... WHERE refusal stands), as fencedRun only rewrites INSERT ... VALUES.
          await fencedBatch(env, lease, [refusalReceiptStatement({ invoiceId: quoteR.invoiceId, homeId: homeId, userId: quoteR.userId, receivedAt: asOf })]);
        }
        try {
          await notify(env, { ...deps, lease }, homeId, "refund_declined", noticeKey, { reason, emailText: text, emailHtml: htmlOf(text),
            ...(quoteR.invoiceId ? { invoiceId: quoteR.invoiceId } : {}), ...(quoteR.userId ? { userId: quoteR.userId } : {}) });
        } catch (e) {
          if (e instanceof RefusalWithdrawn && quoteR.userId && quoteR.invoiceId) {
            // The notifier's claim found the refusal no longer stands (an objection landed after the check above, Astra ASTRA-REFUND5
            // #1/#2): nothing was sent; the notice is cancelled and the request is recorded and held as pending, never refused.
            await fencedRun(env, lease, "UPDATE billing_notices SET canceled_at=?,claimed_until=NULL WHERE id=? AND sent_at IS NULL", now, noticeId);
            quoteR = { ...quoteR, reason: "identity_check_unavailable" }; temporary = true;
          } else {
            const recorded = await env.DB.prepare("SELECT 1 AS x FROM billing_notices WHERE id=?").bind(noticeId).first();
            if (!recorded) throw e;
          }
        }
      }
      if (!temporary) { ineligible = true; return null; }
    }
    const own = await getSub(env, homeId);
    const pinned = replaced ? replaced.pay : await pinCurrentPayment(env, homeId);
    const subscriptionId = replaced ? replaced.subscriptionId : own?.subscription_id ?? null;
    if (!pinned || pinned.invoiceId !== quoteR.invoiceId || !subscriptionId) throw new HTTPError(409, "payment_changed");
    // Astra JOURNEY-A-3 #4: the operation's identity is chosen apart from the once-per-customer claim (firstMonthOpFor).
    const { id: opId, op: prior } = await firstMonthOpFor(env, quoteR.userId!, quoteR.invoiceId);
    // This customer's earlier request was decided and turned down (another payment got the offer first): the same answer again, and the
    // once-per-customer slot is not taken for a request that cannot change the outcome.
    if (prior?.decided_at != null && (prior.amount_cents ?? 0) === 0) {
      // Astra NODEDUCT-1 #2: a refusal recorded only because included credit used the fee (all_credit_used, before 2026-10-12) is obsolete:
      // a fresh request for the same payment, eligible now, reopens it under this lease (slot reserved again, decision and completion
      // cleared) and the normal identity and ledger checks decide it. A slot another payment holds keeps the one-per-person answer.
      // Astra NODEDUCT-2 #1: so is an already_refunded zero the old usage deduction caused (its deducted target was covered by another
      // route's refund) while the full invoice is not: the same payment, still owed the rest, is reopened the same way.
      // Astra NODEDUCT-2 #2: a database failure while reopening is thrown (a retryable error, the refusal left as it was), never 409.
      if (isLegacyRefusal(prior) && prior.home_id === homeId && prior.invoice_id === quoteR.invoiceId
        && (prior.basis === "all_credit_used" || (prior.paid_cents === quoteR.paidCents && quoteR.paidCents > quoteR.alreadyRefundedCents))) {
        if (!await reopenLegacyRefusal(env, { ...ctx, lease }, prior, quoteR.refundCents)) throw new HTTPError(409, "already_refunded");
        return advanceRefundOp(env, { ...ctx, lease }, opId);
      }
      if (!serves(prior)) { foreignOp = prior; return null; } // decided for another payment: never this request's decision
      return prior;
    }
    // Claim the once-per-customer slot and open the ledger operation in one batch; a second request for the same customer stops here.
    const g = crypto.randomUUID();
    try {
      await fencedBatch(env, lease, [
        q(`INSERT INTO first_month_refunds (user_id,home_id,invoice_id,amount_cents,used_credit_cents,created_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(user_id) DO NOTHING`, quoteR.userId, homeId, quoteR.invoiceId, quoteR.refundCents, quoteR.usedCreditCents, asOf),
        q("INSERT INTO cloud_write_guards VALUES (?,changes())", g),
        // A request's consent is saved as recorded, an explicit null included (Astra JOURNEY-A-3 #5); a home-level call saves the live one if any.
        // A superseded payment's refund (Astra JOURNEY-A-3 #6) names its own subscription and never ends the plan or takes credits back.
        refundOpInsert({ id: opId, kind: "first_month", homeId: homeId, userId: quoteR.userId!, invoiceId: quoteR.invoiceId, paymentIntent: pinned.paymentIntent,
          subscriptionId, endPlan: !replaced, detail: { pay: pinned, ...(req ? { consentId: req.consent_id } : own?.consent_id ? { consentId: own.consent_id } : {}) } }, asOf),
        q("DELETE FROM cloud_write_guards WHERE id=?", g),
      ]);
    } catch (e) { if (e instanceof LeaseLost) throw e; throw new HTTPError(409, "already_refunded"); }
    return advanceRefundOp(env, { ...ctx, lease }, opId);
  }, deps.lease));
  // Another payment's (or contract's) operation is in the way: nothing is decided for this request, which stays outstanding (its alert open)
  // until its own decision is recorded (Astra JOURNEY-A-2 A2).
  if (req && foreignOp) {
    return json({ refunded: false, pending: true, outstanding: true, requestId: req.id, error: "other_refund_in_progress",
      otherOperation: foreignOp.id, message: "Another refund of this account, for a different payment or contract, is open or decided: this request stays outstanding until it is decided on its own." } as never, 202);
  }
  // The request is decided (refunded, pending at Stripe, or refused with its email): it is no longer outstanding.
  if (req) await refundRequestDecided(env, req.id, homeId, op?.id ?? null, now);
  if (ineligible && quoteR) {
    const reason = quoteR.reason ?? "not_eligible";
    // The refusal email was recorded inside the lease above.
    return json({ error: reason, message: denialText(reason), quote: quoteR } as never, 409);
  }
  if (op?.kind === "first_month" && op.decided_at !== null && (op.amount_cents ?? 0) === 0) {
    // Decided when the claim was made, and turned down: the customer is told why by email (the operation records and sends it).
    const reason = refusalReason(op);
    return json({ error: reason, message: denialText(reason), quote: quoteR } as never, 409);
  }
  if (op?.done_at) return json({ refunded: true, refundId: op.stripe_refund_id, amountCents: op.amount_cents, quote: quoteR } as never);
  // Recorded and retried by the sweep from its last checkpoint (ops is alerted if it keeps failing); the customer is emailed the outcome.
  return json({ refunded: false, pending: true, error: op?.last_error ?? null,
    ...(op?.decided_at == null ? { message: denialText("identity_check_unavailable") } : {}), quote: quoteR } as never, 202);
}

async function abuseClosure(request: Request, env: Env, deps: BillingDependencies): Promise<Response> {
  await admin(request, env);
  const body = await readJSON(request, abuseBody);
  const home = await env.DB.prepare("SELECT owner_id FROM cloud_homes WHERE id=?").bind(body.homeId).first<{ owner_id: string }>();
  if (!home) throw new HTTPError(404, "not_found");
  const now = nowOf(deps);
  await busyAs409(() => withHomeLease(env, body.homeId, (lease) => fencedBatch(env, lease, [
    q(`INSERT INTO abuse_closures (home_id,user_id,evidence,closed_at) VALUES (?,?,?,?)
      ON CONFLICT(home_id) DO UPDATE SET evidence=excluded.evidence`, body.homeId, home.owner_id, body.evidence, now),
    q("UPDATE billing_subscriptions SET abuse_closed_at=COALESCE(abuse_closed_at,?) WHERE home_id=?", now, body.homeId),
  ]), deps.lease));
  return json({ recorded: true, closedAt: now });
}

/** Operator kill switch for NEW purchases from one declared country (plan r13c §1.4). One batch: revision bump, audit row, switch row.
 *  Never touches a running subscription. */
/** POST /v1/admin/orders/{consentId}/release-parked: once the acceptance line is on record again, the parked completion and the events that
 *  waited on it are replayed through the normal handler. 409 while the line is still missing or the order is not parked (or was refunded). */
async function releaseParked(request: Request, env: Env, deps: BillingDependencies, consentId: string): Promise<Response> {
  await admin(request, env);
  cfg(env);
  const r = await replayParkedAcceptance(env, consentId, deps);
  if (!r.released) throw new HTTPError(409, "not_releasable");
  return json(r as never);
}

async function checkoutSwitch(request: Request, env: Env, deps: BillingDependencies): Promise<Response> {
  await admin(request, env);
  const body = await readJSON(request, switchBody);
  return json(await setCountrySwitch(env, body, nowOf(deps)));
}

/** Objections to keeping refund codes (terms r11 section 5(2)). Recording the objection restricts the person's codes in the same write;
 *  7-day requests that would need them wait with their receipt time. The decision itself (and its reasoned reply, within one month) is
 *  the operator's; this route only records that the decision notice was SENT, which is the one checkpoint that lifts the restriction.
 *  Waiting requests are then decided automatically by the sweep. The EU/UK statutory refunds never wait on any of this. */
async function refundIdentityObjection(request: Request, env: Env, deps: BillingDependencies): Promise<Response> {
  await admin(request, env);
  const body = await readJSON(request, objectionBody);
  const now = nowOf(deps);
  if (body.action === "object") {
    // Recorded at once, never refused or made to wait (Astra ASTRA-REFUND6 #3). pending: a refusal email resting on this person's codes
    // was already being handed off; it finishes first and the objection is finalised automatically right after (no retry by anyone).
    const r = await recordObjection(env, body.userId, now);
    return json({ restricted: r.notice_sent_at === null, pending: r.pending_since !== null, objectedAt: r.objected_at });
  }
  const r = await recordObjectionDecision(env, body.userId, body.decision, now);
  if (!r) throw new HTTPError(409, "no_open_objection");
  return json({ restricted: false, decision: r.decision, noticeSentAt: r.notice_sent_at });
}

// ---- EU online withdrawal function (Directive 2023/2673, Art. 11a CRD) ----------------------------------------------------------

const withdrawBody = z.object({ name: z.string().trim().max(120).optional(), confirm: z.literal(true), homeId: homeIdSchema.optional(),
  client: clientSchema.optional() }).strict();

/** Withdrawal is open to an EU/EEA/UK consumer (by Stripe's billing address once known) for 14 days from the day the contract was made
 *  (the completed checkout). The confirmation email states the same clock. */
type WithdrawalConsent = { id: string; eu_region: number; effective_eu_region: number | null;
  early_start: number; delayed_start: number; created_at: number; completed_at: number; contract_made_at: number | null;
  statutory_withdraw_until: number | null; guarantee_withdraw_until: number | null; service_start_at: number | null; paid_at: number | null };
// paid_at: the owning consent's own payment, for the pre-0061 AoE fallback (Astra WP5-2 #3).
const WITHDRAWAL_CONSENT_SQL = `SELECT c.id,c.eu_region,c.effective_eu_region,c.early_start,c.delayed_start,c.created_at,c.completed_at,c.contract_made_at,c.paid_at,
      c.statutory_withdraw_until,c.guarantee_withdraw_until,(SELECT service_start_at FROM billing_subscriptions WHERE home_id=c.home_id) AS service_start_at FROM checkout_consents c
    WHERE c.home_id=? AND c.completed_at IS NOT NULL AND c.rejected_at IS NULL ORDER BY c.created_at DESC LIMIT 1`;
/** Plan §4.1: open while now <= max(statutory_withdraw_until, guarantee_withdraw_until), the guarantee unbounded while the server has not started
 *  (payment or provisioning pending or failed). */
function withdrawalFrom(c: WithdrawalConsent | null, done: { confirmed_at: number; status: string } | null, now: number) {
  const endsAt = c ? withdrawalEndsAt(c) : null;
  return { consent: c, endsAt, done, available: Boolean(c && consentIsEu(c) && !done && withdrawalOpen(c, c.service_start_at, now)) };
}
async function withdrawalState(env: Env, homeId: string, now: number) {
  const c = await env.DB.prepare(WITHDRAWAL_CONSENT_SQL).bind(homeId).first<WithdrawalConsent>();
  const done = await env.DB.prepare("SELECT confirmed_at,status FROM withdrawals WHERE home_id=?").bind(homeId).first<{ confirmed_at: number; status: string }>();
  return withdrawalFrom(c, done, now);
}

async function withdraw(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  const body = await readJSON(request, withdrawBody);
  const who = await ownHome(request, env, deps, auth, body.homeId);
  const now = nowOf(deps);
  const ctx = refundCtx(env, deps);
  const id = `withdrawal-${crypto.randomUUID()}`;
  const opId = `withdrawal:${id}`;
  const meta = clientMeta(body.client, request);
  // The contract (consent, subscription, payment) is read INSIDE the home's lease, together with the write that records it: a replacement
  // checkout cannot slip in between the read and the write, so the operation never combines one contract's payment with another's subscription.
  let c!: NonNullable<Awaited<ReturnType<typeof withdrawalState>>["consent"]>;
  // Immediate acknowledgement on a durable medium, with the date and time. Recorded in the SAME transaction as the withdrawal (Astra
  // MAKERKIT2 #3): a crash, a lost lease or a busy home before it is sent cannot lose it; the sweep sends what is recorded.
  const when = new Date(now).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  type Op = Awaited<ReturnType<typeof advanceRefundOp>>;
  type W = { days_supplied: number; deducted_cents: number; refund_cents: number; basis: string; status: string };
  const ackText = (op: Op | null, w: W | null) => {
    const decided = op?.decided_at !== null && op?.decided_at !== undefined && w !== null;
    const money = !decided
      ? "We refund everything you paid, to the way you paid, within 14 days of today, and charge no fee. We email you the amount when the refund is made.\n"
      : (op!.paid_cents ?? 0) === 0 ? "You have not been charged, so there is nothing to refund.\n"
        : `We refund ${usd(w!.refund_cents)} to the way you paid, within 14 days of today, and charge no fee. ${w!.basis === "seven_day_offer" ? "We applied our 7-day refund offer because it gives you more."
          : w!.deducted_cents > 0 ? `We deducted ${usd(w!.deducted_cents)} for ${w!.days_supplied} day(s) of service supplied after your start-now request.` : "Nothing is deducted."}`
          + `${(op!.target_cents ?? 0) > w!.refund_cents ? ` ${usd((op!.target_cents ?? 0) - w!.refund_cents)} of it was already refunded to you earlier.` : ""}\n`;
    return `We received your withdrawal from your Murage Cloud contract.\n\nWithdrawal reference: ${id}\nReceived: ${when}\n${body.name ? `Name given: ${body.name}\n` : ""}Contract made: ${isoDate(c.contract_made_at ?? c.completed_at)}\n\n`
      + money + "\nYour plan is cancelled and will not renew.";
  };
  const ackData = (text: string) => ({ withdrawalId: id, emailSubject: "Murage Cloud: we received your withdrawal", emailText: text, emailHtml: htmlOf(text) });
  const readW = () => env.DB.prepare("SELECT days_supplied,deducted_cents,refund_cents,basis,status FROM withdrawals WHERE id=?").bind(id).first<W>();
  // The statement is recorded first, then refunded, cancelled and credits taken back by a resumable ledger operation: a Stripe failure
  // never loses the withdrawal and never leaves billing running unnoticed. All under the home's lease (a busy home is told to retry).
  const op = await busyAs409(() => withHomeLease(env, who.homeId, async (lease) => {
    const st = await withdrawalState(env, who.homeId, now);
    if (st.done) throw new HTTPError(409, "already_withdrawn");
    if (!st.available || !st.consent) throw new HTTPError(409, "withdrawal_not_available");
    c = st.consent;
    const sub = await getSub(env, who.homeId);
    await applyServiceLog(env, lease); // the lifecycle's journaled service changes, applied first under this lease
    const supplied = sub?.subscription_id ? (await env.DB.prepare("SELECT MIN(started_at) AS s FROM service_intervals WHERE home_id=? AND subscription_id=?")
      .bind(who.homeId, sub.subscription_id).first<{ s: number | null }>())?.s ?? null : null;
    const g = crypto.randomUUID();
    try {
      await fencedBatch(env, lease, [
        q(`INSERT INTO withdrawals (id,home_id,user_id,consent_id,name,confirmed_at,early_start,days_supplied,deducted_cents,refund_cents,basis,status,ip,user_agent,
            refund_op_id,service_supplied_at) VALUES (?,?,?,?,?,?,?,0,0,0,'pending','received',?,?,?,?) ON CONFLICT DO NOTHING`,
        id, who.homeId, who.userId, c.id, body.name ?? null, now, c.early_start, meta.claimed.ip ?? meta.observed.ip, meta.claimed.userAgent ?? meta.observed.userAgent,
        opId, supplied),
        q("INSERT INTO cloud_write_guards VALUES (?,changes())", g),
        refundOpInsert({ id: opId, kind: "withdrawal", homeId: who.homeId, userId: who.userId, subscriptionId: sub?.subscription_id ?? null, endPlan: true, detail: { withdrawalId: id, confirmedAt: now, consentId: c.id } }, now),
        q("DELETE FROM cloud_write_guards WHERE id=?", g),
        recordNotice(who.homeId, "withdrawal_ack", id, ackData(ackText(null, null)), now),
      ]);
    } catch (e) { if (e instanceof LeaseLost) throw e; throw new HTTPError(409, "already_withdrawn"); }
    const advanced = await advanceRefundOp(env, { ...ctx, lease }, opId);
    // Once the refund is decided, the recorded (not yet sent) acknowledgement states the amount.
    if (advanced?.decided_at !== null && advanced?.decided_at !== undefined) {
      await fencedRun(env, lease, "UPDATE billing_notices SET payload=? WHERE id=? AND sent_at IS NULL", JSON.stringify(ackData(ackText(advanced, await readW()))),
        `withdrawal_ack:${who.homeId}:${id}`);
    }
    return advanced;
  }, deps.lease));
  const w = (await readW())!;
  const decided = op?.decided_at !== null && op?.decided_at !== undefined;
  try { await notify(env, deps, who.homeId, "withdrawal_ack", id, ackData(ackText(op, w))); }
  catch { /* recorded with the withdrawal; retried by the sweep */ }
  return json({ withdrawn: true, withdrawalId: id, receivedAt: now, refundCents: decided ? w.refund_cents : null, basis: decided ? w.basis : null,
    daysSupplied: w.days_supplied, deductedCents: w.deducted_cents, status: op?.done_at ? "completed" : "processing" } as never, 201);
}

export async function legalRoute(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const m = request.method;
  const only = (method: string) => { if (m !== method) throw new HTTPError(405, "method_not_allowed"); };
  if (path === "/v1/legal/disclosure") { only("GET"); return disclosure(request, env, deps); }
  if (path === "/v1/account/cloud") { only("GET"); return summary(request, env, deps, auth); }
  if (path === "/v1/account/confirmation") { only("GET"); return confirmation(request, env, deps, auth); }
  if (path === "/v1/account/terms") { only("GET"); return termsStatus(request, env, deps, auth); }
  if (path === "/v1/account/topup") { if (m !== "GET" && m !== "POST") throw new HTTPError(405, "method_not_allowed"); return topup(request, env, deps, auth); }
  // Astra TAXCOUNTRY-6 P2-d: the orphan customers left by checkout attempts, with their age and review deadline (operator only; erasure
  // stays a manual act at Stripe, README "Orphan Stripe customers").
  if (path === "/v1/admin/customer-orphans") {
    only("GET");
    await admin(request, env);
    const now = nowOf(deps);
    // Astra TAXCOUNTRY-7 P2-e: oldest first, paged with a keyset cursor (?after=<next>&limit=<n>, at most ORPHAN_PAGE_MAX).
    const u = new URL(request.url);
    const limitParam = u.searchParams.get("limit");
    const limit = limitParam === null ? undefined : Number(limitParam);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new HTTPError(400, "invalid_limit");
    const page = await listCustomerOrphans(env, now, { after: u.searchParams.get("after"), limit });
    return json({ orphans: page.orphans, next: page.next, reviewAfterDays: ORPHAN_REVIEW_MS / 86_400_000,
      escalateAfterDays: ORPHAN_ESCALATE_MS / 86_400_000 } as never);
  }
  const journey = await journeyRoute(request, env, deps, auth);
  if (journey) return journey;
  const post: Record<string, () => Promise<Response>> = {
    "/v1/legal/quote": () => quote(request, env, deps, auth),
    "/v1/account/terms/accept": () => acceptTerms(request, env, deps, auth),
    "/v1/account/cancel-plan": () => cancelPlan(request, env, deps, auth),
    "/v1/account/withdraw": () => withdraw(request, env, deps, auth),
    "/v1/account/export-request": () => requestExport(request, env, deps, auth),
    "/v1/admin/export-delivered": () => exportDelivered(request, env, deps),
    "/v1/admin/refund-first-month": () => refundFirstMonth(request, env, deps),
    "/v1/admin/abuse-closure": () => abuseClosure(request, env, deps),
    "/v1/admin/checkout-switch": () => checkoutSwitch(request, env, deps),
    "/v1/admin/refund-identity-objection": () => refundIdentityObjection(request, env, deps),
  };
  // Round 10 (Astra TAXCOUNTRY-9 P1-2): the resolution of a LOST dispute whose movements were not known exactly: the principal it actually
  // returned, with evidence. Releases the held refunds of its payment to the normal decision (capped by the proven amount). 409 unless the
  // dispute is lost, inexact and unresolved.
  const resolveReturned = /^\/v1\/admin\/disputes\/([\w-]{1,128})\/resolve-returned$/.exec(path);
  if (resolveReturned) {
    only("POST");
    await admin(request, env);
    const body = await readJSON(request, resolveReturnedBody);
    const row = await env.DB.prepare("SELECT home_id FROM payment_disputes WHERE dispute_id=?").bind(resolveReturned[1]).first<{ home_id: string }>();
    if (!row) throw new HTTPError(404, "not_found");
    const now = nowOf(deps);
    const done = await busyAs409(() => withHomeLease(env, row.home_id, (lease) => resolveInexactDispute(env, lease,
      { disputeId: resolveReturned[1], returnedCents: body.returnedCents, evidence: body.evidence, by: body.by }, now), deps.lease));
    if (!done) throw new HTTPError(409, "not_resolvable");
    return json({ resolved: true, resolvedAt: now });
  }
  // Astra INTEGRATED-11 P1-2d: THE EVIDENCED TERMINAL RECOVERY of a dispute hold whose event can never be applied (a charge that is not
  // ours, a dispute verified settled in Stripe): who closed it and why are recorded; the 15-minute page names this endpoint. 404 for an
  // unknown event, 409 when its hold is already released (applied or closed). Never re-armed by a redelivery.
  const holdClose = /^\/v1\/admin\/dispute-holds\/([\w-]{1,128})\/close$/.exec(path);
  if (holdClose) {
    only("POST");
    await admin(request, env);
    const body = await readJSON(request, holdCloseBody);
    if (!await env.DB.prepare("SELECT 1 AS x FROM dispute_holds WHERE event_id=?").bind(holdClose[1]).first()) throw new HTTPError(404, "not_found");
    const now = nowOf(deps);
    if (!await closeDisputeHold(env, { eventId: holdClose[1], by: body.by, evidence: body.evidence, homeId: body.homeId }, now)) throw new HTTPError(409, "already_released");
    return json({ closed: true, closedAt: now });
  }
  // Round 10 (Astra TAXCOUNTRY-9 P2-a): the applied receipt of a lost chargeback's credit adjustment (applied by hand: the frozen reversal
  // formula is never changed). `appliedCents` must be what is owed now (409 otherwise: read the alert again).
  // Astra INTEGRATED-10 P1: the adjustment is made under a versioned CLAIM (POST .../claim {by[, evidence]} -> token), and the receipt needs it.
  // THE FLUX-OFF GATE: with Flux off there is no Flux credit to adjust: both answer 503 flux_off before anything is read or written.
  const creditClaim = /^\/v1\/admin\/dispute-credit-obligations\/([\w-]{1,128})\/claim$/.exec(path);
  if (creditClaim) {
    if (!fluxOn(env, { billingFlux: deps.flux })) throw new HTTPError(503, "flux_off");
    only("POST");
    await admin(request, env);
    const body = await readJSON(request, creditClaimBody);
    const row = await env.DB.prepare("SELECT home_id FROM dispute_credit_obligations WHERE dispute_id=?").bind(creditClaim[1]).first<{ home_id: string }>();
    if (!row) throw new HTTPError(404, "not_found");
    const now = nowOf(deps);
    const claim = await busyAs409(() => withHomeLease(env, row.home_id, (lease) => claimDisputeCredit(env, lease,
      { disputeId: creditClaim[1], by: body.by, evidence: body.evidence }, now), deps.lease));
    if (!claim) throw new HTTPError(409, "claim_in_force_or_settled");
    return json(claim);
  }
  const creditApplied = /^\/v1\/admin\/dispute-credit-obligations\/([\w-]{1,128})\/applied$/.exec(path);
  if (creditApplied) {
    if (!fluxOn(env, { billingFlux: deps.flux })) throw new HTTPError(503, "flux_off");
    only("POST");
    await admin(request, env);
    const body = await readJSON(request, creditAppliedBody);
    const row = await env.DB.prepare("SELECT home_id FROM dispute_credit_obligations WHERE dispute_id=?").bind(creditApplied[1]).first<{ home_id: string }>();
    if (!row) throw new HTTPError(404, "not_found");
    const now = nowOf(deps);
    const done = await busyAs409(() => withHomeLease(env, row.home_id, (lease) => markDisputeCreditApplied(env, lease,
      { disputeId: creditApplied[1], token: body.token, appliedCents: body.appliedCents, evidence: body.evidence, by: body.by }, now), deps.lease));
    if (!done) throw new HTTPError(409, "amount_changed");
    return json({ applied: true, appliedAt: now });
  }
  // The repair of an order parked for a missing acceptance line (Astra WP5-2 #1): release and replay now, operator only.
  const parked = /^\/v1\/admin\/orders\/([\w-]{1,128})\/release-parked$/.exec(path);
  if (parked) { only("POST"); return releaseParked(request, env, deps, parked[1]); }
  const handler = post[path];
  if (!handler) return null;
  if (m !== "POST") throw new HTTPError(405, "method_not_allowed");
  return handler();
}
