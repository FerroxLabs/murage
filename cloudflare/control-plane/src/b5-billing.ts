// SPDX-License-Identifier: AGPL-3.0-or-later
// B5 billing: Stripe Checkout and Customer Portal sessions, the signed webhook inbox,
// and the translation of Stripe events into the frozen B3 payment inbox.
// Lifecycle (grace, suspend, retention, delete) stays in b3-control.ts; this file only
// feeds it paid / payment_problem / canceled snapshots and sends notices.
import { assertPinnedHome } from "./customer-identity";
import { commitQ, journalDispatch, stepUpOpOf } from "./step-up-op";
import { z } from "zod";
import { DAY_MS, PLANS, PLAN_RANK, billingConfig, BillingConfigError, checkoutRefundKeyError, submitLinksFor, type BillingConfig, type Plan } from "./b5-config";
import { checkoutCharged, invoiceView, StripeError, signStripePayload, STRIPE_API_VERSION, STRIPE_REQUEST_TIMEOUT_MS, customerCreateBody, customerMoveBody, firstCustomerBody, stripeClient, subscriptionPeriod, verifyStripeSignature, type InvoiceView, type InvoiceLineView,
  type EventObjectKind, type StripeClient, type StripeFetch } from "./b5-stripe";
import { admin, CHECKOUT_UNRESOLVED_ALERT, CHECKOUT_UNRESOLVED_ALERT_MS, NO_OTHER_REFUND_OPEN, reserveHomeForUser } from "./b3-control";
import { b3Enabled } from "./b3-config";
import { accountSession, type ControlPlaneAuth } from "./auth";
import { accountContactEmail } from "./cloud-accounts";
import { transactionalSender } from "./email";
import { HTTPError, json, readBoundedBody, readBoundedJSON } from "./http";
import {
  addMonthUtc, archiveCurrentDocs, archivedSnapshot, attachSessionToConsent, buildConfirmationEmail, CLOUD_MEMBERS_PATH, retentionDaysText, buildReminderEmail, buildTermsChangeEmail, buildTermsReminderEmail, changedSince, clientMeta,
  acceptanceCounts, consentIsEu, consentSchema, queueServerReady, serverReadyData, declaredCountryOf, expireExportRequests, htmlOf, isoDate, type AcceptanceRow, getConsent, IncludedCreditUnavailable, latestAcceptance, loadAcceptedDocs,
  planFrom, prepareConsent, recordConsent, traderIdentity, RENEWAL_REMINDER_LEAD_MS, saveTopup, getTopup, TERMS_NOTICE_MS, type ConsentRow, DISPUTE_RETURNED_SQL, disputeReturned,
  disputeCreditAlertQs, DISPUTE_CREDIT_OPEN_SQL,
} from "./legal-flows";
export { disputeCreditAlertQs, DISPUTE_CREDIT_OPEN_SQL } from "./legal-flows";
import { advanceRefundOp, applyRefundEvent, claimRefundObjects, reopenDisputeRemainders, creditNoteAttribution, firstInvoiceStatement, getRefundOp, markAttributionUnresolved, planUnresolvedAlertId, refundOpInsert, resolveRefundSubscription, resumeRefundOpsFor, sweepRefundOps, type RefundContext, type RefundOpRow } from "./legal-refunds";
import { checkoutLocale, countrySwitch, currentPolicyVersion } from "./checkout-policy";
import { countryFor } from "./checkout-strings";
import { aoeDate, aoeEnd, consentRefusal, deadlinesFor, guardVerdict, isLegacySession, isRejectKind, ORDER_WORDS, orderWords, renewalAuthorized, type ConsentBinding, type RejectKind } from "./checkout-moments";
import { disclosureKeyError, renewalSha256, verifyDisclosureToken } from "./disclosure-token";
import { LEGAL_DOCS } from "./legal-docs.generated";
import { classifyReplacedInvoice, cutoverEstimate, invoiceCoveringPaidAt, NONE_SELLER, pathCoverage, periodEndFallback, replacementWords, routeExpiresAt, routeIsValid, usdFor, type CutoverBoundary, type ReplacedInvoiceClass, type RetryRoute } from "./checkout-replacement";
import { sellerFor, sellerMismatch, sellerOfConsent, sellerSettings } from "./seller";
import { sweepJourney } from "./journey";
import { captureRefundIdentity, enrichRefundIdentities, purgeRefundIdentity, REFUSAL_NOTICE_HOLD_MS, refusalNoticeRef, refusalNoticeState, refusalNoticeValid, RefusalWithdrawn,
  REFUSAL_HANDOFF_DEADLINE_MS, refusalHandoffStatements,
  finalisePendingObjections, reconcileRefusalDispatches, refusalSendLock, releaseRefusalSendLock, remindOpenObjections, retentionCutoff, retireRedundantKeys } from "./refund-identity";
import { applyServiceLog } from "./service-intervals";
import { WAKE_HELD_BY_HOLD_SQL } from "./dispute-sql";
import { apiAmountCents, CREDIT_NOTE_KINDS, refundLine, type RefundPath } from "./refund-kinds";
import { DB_NOW, fence, fencedBatch, fencedRun, HomeBusy, LeaseLost, q, renewLeaseStatement, withHomeLease, type HomeLease, type Q } from "./billing-lease";
import { deletionNoticeData, planChangeEnabled, planMovedStatements, resumeLeased, upgradeInvoiceOutcome } from "./members-api";
import { allocateCancelRef } from "./cancel-reference";
import { parkedSql, scheduleParked, stripeEndConfirmed, stripeEndConfirmedSql, stripeEndedQ, STRIPE_ENDED_ON_STATUS, STRIPE_ENDED_SET, SubscriptionParked, writeSubscription } from "./subscription-gateway";
import { promiseOf, recordInvoice } from "./cancel-charges";
import { composeFrozenBody, FluxGrantHeld, FluxGrantTargetUnsupported, FluxHookRetry, FluxNotDispatched, FluxTargetStale, grantsConfigured, grantsGuard, grantsHooks, isHold } from "./flux-grants";
import { allocateFenceRevision, claimGrantFence } from "./flux-grant-fence";
import { bindCustomerQ, bindSessionQ, bootstrapExpired, bootstrapTransitionQ, getBootstrap, issuancePast, PRE_PAYMENT, protectSetEmpty, publishClock,
  purchaseAuthority, reconcileAbandonment, stepUpRefused, type BootstrapGrant } from "./purchase-bootstrap";

/** Same names and shapes as the B4 exports in cloudflare/control-plane/src/b4-flux.ts
 *  (grantMonthlyCredits, changePlan, stopForBilling) plus the two B4 reads/writes the legal flows need.
 *  MERGE STEP (cloud-v2/b4): replace `stubFluxHooks` below with the B4 implementations; see README "B4 merge notes".
 *  Every member is REQUIRED: there is no silent default.
 *  ERROR CONTRACT for grantMonthlyCredits and revokeCredits (Astra STUB-2 #1): resolving means B4 applied it. Throwing FluxHookRetry(code)
 *  means "B4 cannot apply it now": ONLY that is recorded as a failed attempt (attempts/last_error, the ops alert) and retried by the sweep.
 *  ANY other throw (a D1 error, a network error, a bug) is an infrastructure failure: nothing is recorded as an attempt, it propagates, and
 *  the Stripe event or sweep pass that asked fails and is retried as a whole. B4 must therefore wrap its own "not now" answers in
 *  FluxHookRetry and let everything else escape unwrapped. */
/** A router's target receipt: the revision it HOLDS and, when it says so (or its route guarantees it), the target it holds at that revision.
 *  Astra JOURNEY-A-9 #1: settlement needs BOTH the revision and the target to be the ones asked for; a missing target settles nothing. */
export type TargetReceipt = { grantId: string; revision: number; removedMicrocents: number; targetRemovedMicrocents?: number };
export type GrantReversalState = { state: "active" | "reversed" | "tombstoned" | "not_found"; removedMicrocents: number; consumedMicrocents: number };
export interface FluxEntitlementHooks {
  /** Idempotent per (invoiceId, kind ?? "period"): B4 applies a grant for that pair at most once. The caller asks once per invoice and kind
   *  (credit_grants, Astra WP5-3 #3) and asks again with the same pair only after an interruption left the grant's outcome unrecorded.
   *  Throws FluxHookRetry when it cannot be granted now (see the error contract above); any other throw fails the caller. */
  grantMonthlyCredits(env: Env, input: { homeId: string; plan: string; invoiceId: string; periodStart: number;
    periodEnd: number; kind?: "period" | "upgrade_delta"; previousPlan?: string;
    /** Astra JOURNEY-A-8 #2: the grant's pending refund target, applied by B4 IN THE SAME TRANSACTION as the grant (the grant is never live
     *  without it; contract: initial_target, capability grantWithTarget). A hook that cannot do that throws FluxGrantTargetUnsupported (held). */
    initialTarget?: { targetRemovedMicrocents: number; revision: number } },
    /** H3: the billing lease the caller holds; the wire revision is allocated only while it holds and the grant's current intent (its target
     *  revision, or no target) is still the one published. */
    fence?: { lease?: HomeLease }): Promise<unknown>;
  /** Astra WP5-6 #2: takes back what is left of ONE grant, the one grantMonthlyCredits made for (invoiceId, kind), because that invoice's
   *  payment was refunded. `grantId` is `${invoiceId}:${kind}` (creditGrantId). B4 MUST:
   *  - apply it at most once per grantId: a repeat (a retry after an interruption) changes nothing and resolves;
   *  - remove only the UNUSED value of that grant: credit already consumed is never taken back, and nothing is ever re-debited from the
   *    customer's prepaid funds (top-ups, purchased credit) or from any other grant (another invoice, another kind, a replacement order);
   *  - treat it as final for that grantId: a grant for it that arrives later is not applied, and a grantId B4 never granted resolves with
   *    nothing to remove;
   *  - throw FluxHookRetry when it cannot be applied now (the caller records the attempt, keeps the reversal pending and retries it); any
   *    other throw is an infrastructure failure: no attempt is recorded and the caller's pass fails (see the error contract above).
   *  Independent of stopForBilling: the home's service and its current plan are not touched.
   *  Used for every reversal that is NOT refund-driven (a rejected order, an unserved renewal). A refund's credit adjustment is a versioned
   *  target (setReversalTarget), never this. */
  revokeCredits(env: Env, input: { homeId: string; invoiceId: string; kind: "period" | "upgrade_delta"; grantId: string; reason: string }): Promise<unknown>;
  /** Astra JOURNEY-A-6 #2: a REFUND's credit adjustment, a VERSIONED CUMULATIVE TARGET for ONE grant (lanes/cloud-v2/b4/FLUX-REVERSAL-TARGET-
   *  CONTRACT.md): B4 sets what is removed from the grant to min(target, grant - consumed) (more when the target rises, RESTORED when it falls),
   *  applies a revision only if it is newer than the one it holds (an older one is refused: FluxHookRetry, 409 stale_revision) and answers a
   *  receipt for the revision it applied. Consumed credit, prepaid funds and every other grant are never touched. Dispatched only when the
   *  hooks advertise capabilities.reversalTargets (reversalTargetsEnabled); optional until a qualified router exists. */
  setReversalTarget?(env: Env, input: { homeId: string; invoiceId: string; kind: "period" | "upgrade_delta"; grantId: string; reason: string;
    targetRemovedMicrocents: number; revision: number;
    /** Astra JOURNEY-A-9 #2: the grant was finally reversed by a legacy /reverse that the router confirms; this first target ADOPTS that
     *  removal (capability adoptLegacyReversal), so a lower target restores it. */
    adoptLegacyReversal?: boolean },
    /** H2: the billing lease the caller holds; the wire revision is allocated only while it holds and the target revision is still current. */
    fence?: { lease?: HomeLease }): Promise<TargetReceipt>;
  /** Astra JOURNEY-A-9 #2: the router's own account of ONE grant (capability grantState): whether it exists, and whether a legacy /reverse
   *  finally reversed it (`reversed`, with what it removed) or tombstoned it (`tombstoned`: reversed before it existed). FluxHookRetry when
   *  the router cannot be asked. Read before a legacy refund-backed /reverse row is converted into a target. */
  grantReversalState?(env: Env, input: { homeId: string; invoiceId: string; kind: "period" | "upgrade_delta"; grantId: string }): Promise<GrantReversalState>;
  /** What the router behind these hooks is qualified for. reversalTargets: the versioned reversal-target contract (the cutover checklist
   *  qualifies the router first). The stub advertises nothing. */
  readonly capabilities?: { readonly reversalTargets?: boolean };
  changePlan(env: Env, input: { homeId: string; plan: string; billingCustomerId?: string }): Promise<unknown>;
  /** `keepGrants` (Astra JOURNEY-A-6 #1): the Stop ends service only; the invoice's credit is adjusted by its own refund target, so B4 reverses
   *  no grant here. */
  stopForBilling(env: Env, homeId: string, deps?: unknown, options?: { invoiceId?: string; keepGrants?: boolean; line?: string | null }): Promise<unknown>;
  /** Usage summary page ONLY (self-service.ts GET /v1/account/usage), read-only: the face value of INCLUDED Flux credits the home used in
   *  [periodStart, periodEnd] (top-ups excluded), in B4 microcents, counting only usage recorded at or before `usedThrough`. NEVER read for
   *  money: no refund deducts credits used (Sean 2026-10-12; the unused grant is reversed by revokeCredits when a refund runs). Throws when
   *  the usage cannot be read (the page then shows "unavailable"). */
  usedIncludedCreditMicrocents(env: Env, input: { homeId: string; periodStart: number; periodEnd: number; usedThrough: number }): Promise<{ usedMicrocents: number }>;
  /** Auto top-up: apply the customer's authorization to Flux auto-recharge (flux_subscriptions.autorecharge_*). Flux does the charging,
   *  the per-month cap reservation (autorecharge_spent_this_month / month_key) and the single-flight purchase (flux_try_begin_autorecharge).
   *  `revision` only ever grows: B4 must ignore an older revision than the one it holds. */
  setAutoRecharge(env: Env, input: { homeId: string; enabled: boolean; amountMicrocents: number; thresholdMicrocents: number;
    monthlyCapMicrocents: number; revision: number; consentId: string | null }): Promise<unknown>;
  /** Usage summary (self-service.ts): the face value of the INCLUDED Flux credits the plan grants per period, in B4 microcents.
   *  Optional until B4 merges; without it the members area shows usage as unavailable, never a guessed number. */
  includedCreditMicrocents?(env: Env, input: { homeId: string; plan: string }): Promise<{ includedMicrocents: number }>;
  /** True only for the pre-B4 stub. Refunds that must take credits back, and auto top-up, wait for the real hooks. */
  readonly stub?: boolean;
  /** Lane H1, item 1: ensure the home owner's Flux account and its link row before the owner's first grant (flux-grants.ts
   *  ensureOwnerAccount: refusals alerted and not retried, 5xx held and retried). Flux off: no-op. Absent on the stub. */
  ensureAccount?(env: Env, input: { homeId: string }): Promise<void>;
  /** Lane H1, item 3 (fence F4): read back the grants whose last fenced outcome is unknown or superseded. Absent on the stub. */
  reconcileFences?(env: Env, limit?: number): Promise<number>;
}
async function stubLog(env: Env, hook: string, payload: unknown) {
  await env.DB.prepare("INSERT INTO flux_hook_stub_log (hook,payload,at) VALUES (?,?,?)").bind(hook, JSON.stringify(payload), Date.now()).run();
}
/** FluxHookRetry (the ONE way a grant/revoke hook says "B4 cannot apply this now") lives in flux-grants.ts, a leaf module, and is re-exported. */
export { FluxHookRetry, FluxGrantHeld, FluxNotDispatched, FluxGrantTargetUnsupported } from "./flux-grants";
/** The stub's grant log: ONE row per grant id, its count raised on every ask (Astra STUB-1 #6), so a grant pending for weeks and asked
 *  every sweep never grows the log. One atomic upsert on the unique (hook, grant_id) key (migration 0082, Astra STUB-2 #5): two workers
 *  around a lease takeover can never leave two rows for one grant. A failure here is a raw D1 error: it propagates (no attempt recorded). */
async function stubLogGrant(env: Env, input: GrantInput) {
  const grantId = creditGrantId(input.invoiceId, input.kind ?? "period");
  await env.DB.prepare(`INSERT INTO flux_hook_stub_log (hook,grant_id,payload,at) VALUES ('grantMonthlyCredits',?,?,?)
    ON CONFLICT(hook,grant_id) WHERE grant_id IS NOT NULL DO UPDATE SET at=excluded.at,
    payload=json_set(flux_hook_stub_log.payload,'$.count',COALESCE(json_extract(flux_hook_stub_log.payload,'$.count'),1)+1)`)
    .bind(grantId, JSON.stringify({ ...input, grantId, count: 1 }), Date.now()).run();
}
/** The pre-B4 grant stand-in (fails closed: logs the ask, throws FluxHookRetry("flux_not_wired")). NOT WIRED into stubFluxHooks any more
 *  (WP5-P4 D3, Astra WP5-P4-CP #8): kept only as a hook double for the retry/alert machinery tests. */
export async function stubGrantMonthlyCredits(env: Env, input: GrantInput): Promise<never> {
  await stubLogGrant(env, input);
  throw new FluxNotDispatched("flux_not_wired");
}
/** Pre-B4 stand-in for the hooks B4 has not wired yet. FAILS CLOSED where a guess would cost money: the included-credit read throws (no
 *  refund on a guessed 0) and the auto-recharge write throws (no top-up shown as active). The grant, reversal and usage-page hooks are the
 *  WP5-P4 grants client (flux-grants.ts), but `stub: true` with no capability means Flux OFF (Astra JOURNEY-A-10 #1): billing never invokes
 *  a grant or reversal hook of these hooks (fluxDispatchEnabled), whatever token and URL are configured; the obligation stays journaled and
 *  ops is alerted. The usage-page read goes through the client's token guard. */
const grantsClient = grantsHooks();
export const stubFluxHooks: FluxEntitlementHooks = {
  stub: true,
  grantMonthlyCredits: (env, input, fence) => grantsClient.grantMonthlyCredits(env, input, fence),
  changePlan: (env, input) => stubLog(env, "changePlan", input),
  revokeCredits: (env, input) => grantsClient.revokeCredits(env, input),
  stopForBilling: (env, homeId, _deps, options) => stubLog(env, "stopForBilling", { homeId, ...options }),
  usedIncludedCreditMicrocents: async (env, input) => {
    try { return await grantsClient.usedIncludedCreditMicrocents(env, input); } catch { throw new IncludedCreditUnavailable(); }
  },
  setAutoRecharge: async (env, input) => { await stubLog(env, "setAutoRecharge", input); throw new Error("flux_not_wired"); },
};

export type NoticeKind = "payment_failed" | "cancel_scheduled" | "subscription_ended" | "suspended"
  | "deletion_warning" | "deleted" | "refunded" | "dispute_opened" | "welcome" | "provision_failed"
  | "confirmation" | "renewal_reminder" | "export_requested" | "export_delivered" | "withdrawal_ack" | "terms_change" | "checkout_repriced"
  | "refund_declined" | "export_ready" | "hold_started" | "hold_canceled" | "home_needs_attention"
  | "order_rejected" | "payment_received" | "payment_cancelled"
  | "address_change" | "replacement_failed" | "replacement_done" | "refund_request_received" | "invoice_link" | "server_ready" | "pair_hold_ready";
export interface BillingNotifier {
  /** Must resolve only once the notice is durably handed off; rejecting makes the caller retry. */
  notify(env: Env, notice: { id: string; homeId: string; ownerId: string; kind: NoticeKind; data: Record<string, unknown> }, lease?: HomeLease): Promise<void>;
}
const SUBJECTS: Record<NoticeKind, string> = {
  welcome: "Your Murage Cloud is being set up",
  payment_failed: "Murage Cloud: your payment failed",
  cancel_scheduled: "Murage Cloud: your subscription will end",
  subscription_ended: "Murage Cloud: your subscription ended and your home is paused",
  suspended: "Murage Cloud: your home is paused",
  deletion_warning: "Murage Cloud: your home will be deleted soon",
  deleted: "Murage Cloud: your home was deleted",
  refunded: "Murage Cloud: your payment was refunded",
  dispute_opened: "Murage Cloud: a payment dispute was opened",
  provision_failed: "Murage Cloud: we could not set up your home, and your payment is being refunded",
  confirmation: "Murage Cloud: your order confirmation and contract copy",
  renewal_reminder: "Murage Cloud: your plan renews every month (yearly reminder)",
  export_requested: "Murage Cloud: we received your data request",
  export_delivered: "Murage Cloud: your data export was sent",
  withdrawal_ack: "Murage Cloud: we received your withdrawal",
  terms_change: "Murage Cloud: our terms are changing (30-day notice)",
  checkout_repriced: "Murage Cloud: please check out again (the total changed)",
  refund_declined: "Murage Cloud: about your refund request",
  export_ready: "Murage Cloud: your data export is ready to download",
  hold_started: "Murage Cloud: a change to your home is waiting 72 hours",
  hold_canceled: "Murage Cloud: the waiting change to your home was cancelled",
  home_needs_attention: "Murage Cloud: your home needs attention",
  order_rejected: "Murage Cloud: your order was cancelled",
  payment_received: "Murage Cloud: payment received",
  payment_cancelled: "Murage Cloud: your payment did not go through",
  address_change: "Murage Cloud: your billing address changed",
  replacement_failed: "Murage Cloud: your payment didn't go through",
  replacement_done: "Murage Cloud: your plan is switched",
  refund_request_received: "Murage Cloud: we received your refund request",
  invoice_link: "Murage Cloud: your invoice",
  server_ready: "Murage Cloud: your server is ready",
  // Door v2 (r4.2): a completed "Add a computer" pair hold (self-service.ts completeDueHolds).
  pair_hold_ready: "Your new computer can connect now",
};
const PLAIN_BODIES: Partial<Record<NoticeKind, string>> = {
  // The fallback when no evidence was read (Astra JOURNEY-A-10 #5): it promises nothing that is not confirmed. The sweep sends
  // provisionFailedEmail, worded from what is confirmed.
  provision_failed: "We tried several times to set up your Murage Cloud home and could not finish. We are sorry.\n\n"
    + "Your refund is being processed. All of your payment goes back to the card you paid with. We will email you when it is done.\n\n"
    + "We are cancelling your subscription now. Nothing was stored in the home. We are removing it now.\n\n"
    + "You can start again from your Murage Cloud account once this is finished. If you would rather talk to someone, reply to this email.",
  home_needs_attention: "Your Murage Cloud home stopped answering, and the automatic fixes (restart, then reboot) did not bring it back. "
    + "Nothing on it was deleted or rolled back.\n\nOpen your Murage Cloud page in the members area: press Fix it to try again, or Reset my Cloud to rebuild it "
    + "from your last good backup (you can undo a reset for 7 days). Our team has been told.",
};
/** Astra JOURNEY-A-10 #5: the failed-setup email, worded from what is CONFIRMED when it is sent. Refund done: the refund operation(s) done
 *  and the home's entitlement 'refunded'. Subscription: Stripe's own status. Removed, and a new start possible: the home retired to 'deleted'
 *  (only once its payments are settled and its resources released). Anything unconfirmed is said plainly as still in progress. */
export async function provisionFailedEmail(env: Env, homeId: string, outboxId = `provision_failed:${homeId}`): Promise<{ emailSubject: string; emailText: string; emailHtml: string }> {
  const h = await env.DB.prepare("SELECT desired_state AS d,entitlement AS e FROM cloud_homes WHERE id=?").bind(homeId).first<{ d: string; e: string }>();
  const sub = await env.DB.prepare(`SELECT status,subscription_id AS s,${stripeEndConfirmedSql("b")} AS ended FROM billing_subscriptions b WHERE home_id=?`).bind(homeId)
    .first<{ status: string; s: string | null; ended: number }>();
  const open = await env.DB.prepare("SELECT 1 AS x FROM refund_ops WHERE home_id=? AND done_at IS NULL LIMIT 1").bind(homeId).first();
  const failed = await env.DB.prepare("SELECT payload FROM cloud_outbox WHERE id=?").bind(outboxId).first<{ payload: string | null }>();
  let paymentFound = true;
  try { paymentFound = (JSON.parse(failed?.payload ?? "{}") as { refunded?: boolean }).refunded !== false; } catch { /* unreadable: treated as found */ }
  const refunded = h?.e === "refunded" && open === null;
  const pending = !refunded && (h?.e === "refund_pending" || open !== null || paymentFound);
  const removed = h?.d === "deleted";
  const paras = ["We tried several times to set up your Murage Cloud home and could not finish. We are sorry."];
  paras.push(refunded ? "Your payment has been refunded in full to the card you paid with. Refunds usually show up within 5 to 10 business days, depending on your bank."
    : pending ? "Your refund is being processed. All of your payment goes back to the card you paid with. We will email you when it is done."
      : "We could not match your payment automatically. A person on our team is checking it now. If you were charged, you get all of it back.");
  // Astra INTEGRATED-2: "not billed again" only on Stripe's confirmed end (THE checkpoint), never on the local status.
  const subLine = !sub?.s ? null : sub.ended === 1 ? "Your subscription is cancelled, so you will not be billed again."
    : "We are cancelling your subscription now.";
  paras.push([subLine, removed ? "Nothing was stored in the home, and we have removed it." : "Nothing was stored in the home. We are removing it now."]
    .filter((x): x is string => x !== null).join(" "));
  paras.push(`${removed ? "You are welcome to try again from your Murage Cloud account whenever you like."
    : "You can start again from your Murage Cloud account once this is finished."} If you would rather talk to someone, reply to this email.`);
  const emailSubject = refunded ? "Murage Cloud: we could not set up your home, and your payment was refunded"
    : pending ? SUBJECTS.provision_failed : "Murage Cloud: we could not set up your home";
  const emailText = `${emailSubject}\n\n${paras.join("\n\n")}\n\nReference: ${homeId}`;
  return { emailSubject, emailText, emailHtml: htmlOf(emailText) };
}
export const NOTICE_CLAIM_MS = 2 * 60_000;
declare global { interface Env { EMAIL_REPLY_TO?: string } }
/** Where customers' replies to our emails go: the monitored support inbox (EMAIL_REPLY_TO overrides). */
export const supportReplyTo = (env: Env): string => env.EMAIL_REPLY_TO || "support@murage.ai";
/** Poison work: after this many tries a terms notice or a terms-enforcement row is dead-lettered to ops; the rest keep going. */
export const POISON_LIMIT = 8;
/** A billing notice is dead-lettered to ops after this many tries (it then no longer takes a place in every sweep). */
export const NOTICE_DEAD_LIMIT = 20;
async function deadLetterAlert(env: Env, homeId: string, kind: string, detail: Record<string, unknown>, now: number) {
  await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
    .bind(crypto.randomUUID(), homeId, kind, "high", JSON.stringify(detail), now).run();
}
/** The UTC calendar day of a moment (the day a refund deadline is counted from: aoeEnd). */
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** A stable trace id per notice (no personal data in the header). */
export async function noticeTraceId(noticeId: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(noticeId)))].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const noticeBackoff = (attempts: number) => Math.min(6 * 3_600_000, 60_000 * 2 ** Math.min(attempts, 12));
/** The events a paying customer waits on (the order confirmation is sent, then service starts): their retry gap is at most 5 minutes, for
 *  every attempt and for as long as it takes (never given up; lane C design 3 A3). That gap is the time to ELIGIBILITY: the sweep runs every
 *  5 minutes and serves due events earliest-due first, so the observed latency is at most the gap plus one cron period (plus whatever is due
 *  ahead of it), and Stripe's own webhook redeliveries are further attempts outside this schedule. Every other type keeps noticeBackoff. */
const CUSTOMER_WAITING_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded", "invoice.paid"]);
export const CUSTOMER_WAITING_GAP_MS = 5 * 60_000;
/** A customer-waiting event raises its own billing.webhook_stuck alert from this failed attempt on; any other type raises the fleet's
 *  billing.event_stuck from EVENT_STUCK_AT. Both are written in the failure's own batch, from the committed attempt count. */
export const STUCK_ALERT_AT = 3;
export const EVENT_STUCK_AT = 8;
/** The cap of an event type's retry gap. The gap itself is computed in SQL from the committed attempt count (the failure batch in
 *  processStoredEvent: MIN(cap, 60000 * 2^MIN(attempts, 12)), i.e. noticeBackoff capped); backoffFor is the same rule in TypeScript. */
const backoffCapFor = (type: string) => CUSTOMER_WAITING_EVENTS.has(type) ? CUSTOMER_WAITING_GAP_MS : noticeBackoff(12);
export const backoffFor = (type: string, attempts: number) => Math.min(backoffCapFor(type), noticeBackoff(attempts));
/** What the stuck alert tells ops about the retry rule. */
const STUCK_RETRY_RULE = "retried at most 5 minutes apart until it completes; never given up";
/** Default: record the notice, claim it atomically, send through the EMAIL binding, mark it sent. Exactly one sender per notice id: a
 *  concurrent caller finds the claim and gets "notice_in_flight" (so a gate waiting on it retries instead of assuming it went out). */
export const defaultNotifier: BillingNotifier = {
  async notify(env, notice, lease) {
    // Every write of the notice's state (recorded, claimed, sent) is fenced by the home's lease: a sender that lost the lease while the
    // email was going out records nothing, and the next holder sends the notice again (delivery is at least once).
    if (!lease) throw new Error("lease_required");
    const now = Date.now();
    // A notice recorded again (a new decision that refuses once more) clears an earlier cancellation; it is revalidated below anyway.
    await fencedRun(env, lease, `INSERT INTO billing_notices (id,home_id,kind,payload,created_at) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET canceled_at=NULL WHERE billing_notices.sent_at IS NULL AND billing_notices.canceled_at IS NOT NULL`,
      notice.id, notice.homeId, notice.kind, JSON.stringify(notice.data), now);
    // A "not your first payment" refusal is sent only while it still stands, checked in the claim itself, on every path (the request,
    // the refund operation, the sweep's retry of a failed send): an objection or an erasure since the decision, or the request reopened
    // or paid, means this refusal is never sent (Astra ASTRA-REFUND5 #1).
    const refusal = refusalNoticeRef(notice);
    const valid = refusal ? refusalNoticeValid(refusal) : null;
    // A renewal reminder goes out only while the plan it was written for still renews, checked in the claim itself on the first send and on
    // every retry (Astra CANCEL-SUMMARY-1 #5): a reminder for a plan that is ending (or replaced, or no longer active) is never sent.
    const reminder = notice.kind === "renewal_reminder";
    const claimSql = (dispatch: string) => `UPDATE billing_notices SET claimed_until=?,attempts=attempts+1${dispatch} WHERE id=? AND sent_at IS NULL
      AND canceled_at IS NULL AND (claimed_until IS NULL OR claimed_until<?)${valid ? ` AND ${valid.sql}` : ""}${reminder ? ` AND ${reminderStandsSql("billing_notices")}` : ""}`;
    // The refusal's claim also takes the per-person send lock (refund_refusal_sends) in the same batch, and records the dispatch as
    // 'dispatching' under this sender's fence token (`holder`). An objection by anyone the refusal rests on that arrives meanwhile is
    // recorded at once as pending and finalised after this handoff (Astra ASTRA-REFUND5 #2, ASTRA-REFUND6 #3). A dispatch of this notice
    // left by an earlier sender is never simply taken over on a timer: once past its `until` it is reconciled first, and while it stands
    // no new claim is made (ASTRA-REFUND6 #2).
    const holder = refusal ? crypto.randomUUID() : null;
    if (refusal) await reconcileRefusalDispatches(env, now, { noticeId: notice.id, lease });
    const claim = refusal ? (await fencedBatch(env, lease, [
      q(`${claimSql(",dispatch_fence=?,dispatch_state='dispatching'")} AND NOT EXISTS (SELECT 1 FROM refund_refusal_sends WHERE notice_id=billing_notices.id)`,
        now + NOTICE_CLAIM_MS, holder, notice.id, now, ...valid!.binds),
      ...refusalSendLock(refusal, holder!, notice.id)]))[0].meta.changes
      : await fencedRun(env, lease, claimSql(""), now + NOTICE_CLAIM_MS, notice.id, now);
    // Every later write of a refusal's dispatch carries its fence: a sender whose dispatch was reconciled by a takeover writes nothing.
    const mine = holder ? " AND dispatch_fence=?" : "";
    const fenceBind = holder ? [holder] : [];
    if (claim !== 1) {
      const existing = await env.DB.prepare("SELECT sent_at,canceled_at,claimed_until FROM billing_notices WHERE id=?").bind(notice.id)
        .first<{ sent_at: number | null; canceled_at: number | null; claimed_until: number | null }>();
      if (existing?.sent_at) return;
      if (reminder && !existing?.canceled_at && !(existing?.claimed_until && existing.claimed_until >= now)) {
        // The plan no longer renews: the reminder is withdrawn (a later notify of the same reminder, after Keep my plan, records it again).
        // Thrown, never returned: the sweep then leaves the reminder's due time where it is (and counts no failed send).
        if (await fencedRun(env, lease, `UPDATE billing_notices SET canceled_at=?,claimed_until=NULL WHERE id=? AND sent_at IS NULL AND NOT ${reminderStandsSql("billing_notices")}`,
          now, notice.id) === 1) throw new RefusalWithdrawn("reminder_obsolete");
      }
      if (existing?.canceled_at) throw new RefusalWithdrawn(reminder ? "reminder_obsolete" : "refusal_obsolete");
      if (refusal && !(existing?.claimed_until && existing.claimed_until >= now)) {
        const state = await refusalNoticeState(env, refusal);
        if (state === "obsolete") {
          await fencedRun(env, lease, "UPDATE billing_notices SET canceled_at=?,claimed_until=NULL WHERE id=? AND sent_at IS NULL", now, notice.id);
          throw new RefusalWithdrawn("refusal_obsolete");
        }
        if (state === "hold") {
          // Codes under an open objection are never used to refuse: looked at again later, no try counted.
          await fencedRun(env, lease, "UPDATE billing_notices SET next_attempt_at=? WHERE id=? AND sent_at IS NULL", now + REFUSAL_NOTICE_HOLD_MS, notice.id);
          throw new RefusalWithdrawn("refusal_held");
        }
      }
      throw new Error("notice_in_flight");
    }
    try {
      const row = (await env.DB.prepare("SELECT payload,attempts FROM billing_notices WHERE id=?").bind(notice.id).first<{ payload: string; attempts: number }>())!;
      // A rejection email states the refund as the ledger has it NOW, on the first send and on every retry (Astra WP5-2 #4): the unsent payload
      // is re-rendered and saved under this claim and the lease before it goes out.
      if (notice.kind === "order_rejected") {
        const fresh = await refreshedRejectionPayload(env, row.payload);
        if (fresh !== null) {
          await fencedRun(env, lease, "UPDATE billing_notices SET payload=? WHERE id=? AND sent_at IS NULL", fresh, notice.id);
          row.payload = fresh;
        }
      }
      // Astra JOURNEY-B-3 #5: the ready email states the refund deadline generated NOW, at its handoff, with the clock recorded as its sent_at
      // below (the refund window's ready moment) and in the same batch as the frozen deadline it grows, never the queue-time words.
      if (notice.kind === "server_ready") row.payload = await refreshReadyPayload(env, lease, notice.id, notice.homeId, row.payload, now);
      if (notice.kind === "cancel_scheduled") row.payload = await refreshCancelPayload(env, lease, notice.id, notice.homeId, row.payload);
      let handoffAt = now;
      try {
        // A Cloud account's contact address (its "user".email is never a mailbox; cloud-accounts.ts).
        const to = await accountContactEmail(env.DB, notice.ownerId);
        // The one transactional sender (email.ts: the staging sink when engaged, else the EMAIL binding; TRUST-FIRST-FACTOR.md part C).
        const email = transactionalSender(env);
        if (!to || !email) throw new Error("notice_undeliverable");
        // The stored payload is what is sent: the first recorded version of a notice id is the only one.
        const traceId = await noticeTraceId(notice.id);
        const recipient: string = to;
        const compose = (payload: string) => {
          const data = JSON.parse(payload) as Record<string, unknown>;
          // Legal emails (confirmation, reminder, export) carry their own full text; the rest use the short notice layout.
          const own = data as { emailSubject?: string; emailText?: string; emailHtml?: string };
          const subject = own.emailSubject ?? SUBJECTS[notice.kind];
          const plain = PLAIN_BODIES[notice.kind];
          const text = own.emailText ?? (plain ? `${subject}\n\n${plain}\n\nReference: ${notice.homeId}` : `${subject}\n\nHome: ${notice.homeId}\n${Object.entries(data).map(([k, v]) => `${k}: ${String(v)}`).join("\n")}\n\nManage billing from your Murage Cloud account.\n\nReference: ${notice.id}`);
          return { to: recipient, from: { email: env.EMAIL_FROM ?? "noreply@murage.ai", name: "Murage" }, replyTo: supportReplyTo(env), subject,
            text, html: own.emailHtml ?? `<p>${subject.replace(/</g, "&lt;")}</p><pre>${text.replace(/</g, "&lt;")}</pre>`,
            headers: { "X-Notice-ID": traceId } };
        };
        // AT-LEAST-ONCE: Cloudflare's send_email binding offers no idempotency key, and Cloudflare rejects a custom Message-ID
        // (E_HEADER_NOT_ALLOWED) and with it the whole send. A send whose answer was lost is therefore sent again. Only an allowed X- header
        // is set, for tracing a delivery back to its notice.
        // Replies go to the monitored support inbox, never to the no-reply sender: a refused refund says "reply and a person will look at it".
        // The whole message, its trace header included, is prepared BEFORE the handoff (Astra ASTRA-REFUND7 #2): after the fenced handoff
        // write nothing else is awaited before EMAIL, so a sender whose fence a takeover revoked can no longer start a send.
        let message = compose(row.payload);
        // A refusal is handed to EMAIL only while this sender still owns its dispatch (ASTRA-REFUND6 #2): a takeover that reconciled it
        // while this sender was stalled revoked the fence, and nothing is sent. From 'handed_off' on, a takeover records it as unknown.
        // The handoff renews the dispatch rows and the lease in the same write, and EMAIL is started only if the write's answer came back
        // within REFUSAL_HANDOFF_DEADLINE_MS of issuing it (Astra ASTRA-REFUND8 #3): a delayed acknowledgement, during which a takeover
        // could have revoked the fence, sends nothing (the notice is retried; nothing is awaited between this check and EMAIL).
        if (holder) {
          const issuedAt = Date.now();
          if ((await fencedBatch(env, lease, refusalHandoffStatements(notice.id, holder, renewLeaseStatement(lease))))[0].meta.changes !== 1) throw new LeaseLost();
          if (Date.now() - issuedAt > REFUSAL_HANDOFF_DEADLINE_MS) throw new Error("refusal_handoff_late");
        }
        // Astra JOURNEY-B-4 #7: the ready email's moment is its ACTUAL handoff, taken here, after every preparation step and with nothing
        // awaited between it and EMAIL. When preparation carried the clock into another (UTC) day, the payload and its deadline are generated
        // again for that moment first. That one timestamp is both what the email states and its sent_at (the refund clock's ready moment).
        if (notice.kind === "server_ready") {
          let payloadAt = now;
          for (let i = 0; i < 3; i++) {
            handoffAt = Date.now();
            if (utcDay(handoffAt) === utcDay(payloadAt)) break;
            row.payload = await refreshReadyPayload(env, lease, notice.id, notice.homeId, row.payload, handoffAt);
            message = compose(row.payload);
            payloadAt = handoffAt;
          }
          if (utcDay(handoffAt) !== utcDay(payloadAt)) throw new Error("ready_handoff_unstable");
        }
        await email.send(message);
      } catch (e) {
        await fencedRun(env, lease, `UPDATE billing_notices SET claimed_until=NULL,next_attempt_at=?${holder ? ",dispatch_fence=NULL,dispatch_state=NULL" : ""}
          WHERE id=? AND sent_at IS NULL${mine}`, now + noticeBackoff(row.attempts), notice.id, ...fenceBind);
        throw e;
      }
      // A late finalise whose fence a takeover revoked is refused: the takeover already recorded this dispatch as sent-or-unknown.
      // Astra JOURNEY-B-2 #6: the ready email's handoff IS the refund clock's ready moment (readyAnchorSql): in the same batch, the consent's
      // frozen deadline grows to 7 days from it (MAX: never shrinks), so a late handoff extends the window it promised.
      const handedOff = await fencedBatch(env, lease, [
        q(`UPDATE billing_notices SET sent_at=?,claimed_until=NULL${holder ? ",dispatch_fence=NULL,dispatch_state=NULL" : ""} WHERE id=?${mine}`, handoffAt, notice.id, ...fenceBind),
        ...(notice.kind === "server_ready" ? [q(`UPDATE checkout_consents SET refund7_until=MAX(refund7_until,?) WHERE refund7_until IS NOT NULL AND paid_at IS NOT NULL
          AND id=(SELECT consent_id FROM billing_subscriptions WHERE home_id=?)`, aoeEnd(handoffAt, 7), notice.homeId)] : []),
      ]);
      if (handedOff[0].meta.changes !== 1 && holder) throw new LeaseLost();
    } finally {
      // The handoff is over (sent, or failed and backed off): the objection may land now. Only this sender's rows; a crashed sender's
      // rows end at their `until`.
      if (holder) await releaseRefusalSendLock(env, holder, now);
    }
  },
};

export interface BillingDependencies {
  /** Internal: the home's billing lease when the caller already holds it (re-entrant serializer). */
  lease?: HomeLease | null;
  stripeFetch?: StripeFetch; flux?: FluxEntitlementHooks; notifier?: BillingNotifier; now?: () => number;
  /** The scheduled invocation's hard wall (epoch ms), computed once by the cron handler (index.ts): the billing sweep's two bounded
   *  loops (stored-event retries, notice retries) start no attempt that could end past it. Only an upper bound: they run first, each on its
   *  own budget, and are never skipped for time other stages used (Astra MAILRETRY-6 P1). Absent: the run's start + SWEEP_RUN_MS.
   *  Lane F: the customer-create sweep (sweepTaxDispatches) also aborts every Stripe call at it and starts none it could not finish. */
  sweepDeadline?: number;
  /** Set by the scheduled handler, which runs sweepCustomerWaiting itself first in the invocation (Astra MAILRETRY-7 P1): sweepBilling then
   *  does not run those two loops a second time. Absent: sweepBilling runs them first, itself. */
  customerWaitingDone?: boolean;
  /** Overrides EVENT_MAX_MS, the cap of one attempt in the bounded loops (tests). */
  eventMaxMs?: number;
  /** Tests only: how many milliseconds of the injected clock (`now`) pass per real millisecond (an accelerated clock). The bounded loops'
   *  attempt timers wait cap / clockRate real milliseconds, so the budgets, the caps and the clock stay in one time scale. Default 1. */
  clockRate?: number;
  /** The scheduled invocation's ctx.waitUntil (index.ts): an attempt of a bounded loop cut at its cap goes on as a continuation, registered here so the
   *  runtime keeps it alive until it ends (Astra MAILRETRY-4 P2). */
  waitUntil?: (work: Promise<unknown>) => void;
  /** The signed-in account for this request, or null. Default: accountSession (on Cloud routes, the Supabase identity). */
  accountUser?: (request: Request, auth: ControlPlaneAuth) => Promise<{ id: string } | null>;
  /** 2FA step-up for checkout. FAIL CLOSED by default; the worker wires the members-area token's fresh aal2 (index.ts). */
  stepUp?: (env: Env, request: Request, auth: ControlPlaneAuth) => Promise<boolean>;
  /** The trusted second-factor check alone (the worker wires it; stepUp is it OR the purchase bootstrap on the three purchase routes). */
  trustedStepUp?: (env: Env, request: Request, auth: ControlPlaneAuth) => Promise<boolean>;
  /** The first-purchase authorization (purchase-bootstrap.ts purchaseBootstrap), read-only; absent: never (fail closed). */
  purchaseBootstrap?: (env: Env, request: Request, accountId: string | null, homeId: string | null) => Promise<BootstrapGrant | null>;
  /** The refund intake's canonical dry-run quote (journey.ts refundRequest). Default: the EU/UK 14-day entitlement, else the 7-day offer.
   *  Any quote shape the lanes produce is accepted (windowEndsAt, or lane B's deadline / window), see journey.ts intakeWindowOf. */
  refundIntakeQuote?: (env: Env, homeId: string, now: number, pinned: { invoiceId: string; consentId: string | null }) => Promise<RefundIntakeQuote>;
}
/** A refund quote as the intake reads it: eligibility plus the window, in any of the shapes the quote paths produce. */
export interface RefundIntakeQuote { eligible: boolean; reason: string | null; windowEndsAt?: number | null; deadline?: number | null;
  startsWhenReady?: boolean; window?: { deadline?: number | null; endsAt?: number | null; startsWhenReady?: boolean } | null }

export interface SubRow { home_id: string; customer_id: string; subscription_id: string | null; plan: string; previous_plan: string | null;
  price_id: string | null; status: string; cancel_at_period_end: number; current_period_start: number | null;
  current_period_end: number | null; fp_tid: string | null; consent_id: string | null; service_start_at: number | null;
  first_charge_at: number | null; first_invoice_id: string | null; first_paid_at: number | null; first_invoice_cents: number | null; first_payment_intent?: string | null;
  service_supplied_at: number | null; reminder_due_at: number | null; customer_cancel_at: number | null; cancel_intent_rev: number; cancel_synced_rev: number; cancel_terminal_sub: string | null;
  /** Stripe's cancel_at in ms (migration 0092): set by a public cancellation, which never sets cancel_at_period_end. */
  cancel_at?: number | null; updated_at?: number;
  /** When the subscription ended (status canceled), stamped once by a trigger (migration 0094; Astra CANCEL-SUMMARY-2 #7). */
  ended_at?: number | null;
  /** Astra JOURNEY-BCORE-1 #2: the end date the in-app cancellation promised, frozen with the intent (migration 0096). */
  cancel_promised_end?: number | null; }
interface HomeRow { id: string; owner_id: string; desired_state: string; entitlement: string; }

const homeId = z.string().regex(/^[\w-]{1,128}$/);
const fpTid = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
// homeId is honoured only for the operator (admin token); a signed-in customer always acts on their own home.
// consent is required for everyone, the operator included: no charge and no server without both ticked boxes on record.
const checkoutSchema = z.object({ homeId: homeId.optional(), plan: z.enum(PLANS), fp_tid: fpTid.optional(), consent: consentSchema }).strict();
const portalSchema = z.object({ homeId: homeId.optional() }).strict();
const receiptSchema = z.object({ homeId, resourceGeneration: z.number().int().positive(),
  kind: z.enum(["volume_archive", "volume_snapshot", "server_snapshot"]), ref: z.string().regex(/^[\w:./-]{1,200}$/),
  coversVolume: z.boolean() }).strict();

export function cfg(env: Env): BillingConfig {
  try {
    const c = billingConfig(env);
    if (!c) throw new HTTPError(503, "billing_disabled");
    return c;
  } catch (e) {
    if (e instanceof BillingConfigError) throw new HTTPError(503, e.message);
    throw e;
  }
}
export async function readJSON<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  return parsed.data;
}
const getHome = (env: Env, id: string) => env.DB.prepare("SELECT id,owner_id,desired_state,entitlement FROM cloud_homes WHERE id=? AND desired_state<>'deleted'")
  .bind(id).first<HomeRow>();
/** An open public (§312k) cancellation of subscription `?` that Stripe confirmed with a cancel_at (public-cancellation.ts marks
 *  stripe_synced=1 with stripe_cancel_at only after reading Stripe back). */
export const OPEN_PUBLIC_CANCEL = `SELECT 1 FROM cancellation_requests WHERE subscription_id=? AND match_state='matched' AND status='open'
  AND stripe_synced=1 AND stripe_cancel_at IS NOT NULL`;
/** The declaration revision of a subscription (migration 0092): every matched declaration as id:last_op, sorted by id. Every transition
 *  writes a new last_op, so the revision changes with any of them. publicCancelEndSql checks a mutation against it in SQL. */
export function declRevision(rows: { id: string; last_op: string | null }[]): { rev: string; n: number } {
  const parts = rows.map((r) => `${r.id}:${r.last_op ?? "-"}`).sort();
  return { rev: `|${parts.join("|")}|`, n: rows.length };
}
/** The earliest end (ms) Stripe confirmed for the CURRENT declarations of row `b`'s subscription, or NULL (none open, none confirmed yet, or
 *  cleared). Astra CANCEL-SUMMARY-1 #3: only evidence for the current declaration revision counts. (1) The newest confirmed cancel_at
 *  mutation computed for this revision decides, a clear (NULL) included. (2) Without one (Stripe already showed what this revision wants),
 *  the stamps decide, but only once every matched declaration is synced: a reconciliation stamps all of them together after its read-back,
 *  and any transition since unsyncs its row. Otherwise the cancellation is not confirmed yet (pending). */
const declsOf = (b: string) => (a: string) => `cancellation_requests ${a} WHERE ${a}.subscription_id=${b}.subscription_id AND ${a}.match_state='matched'`;
/** Astra CANCEL-SUMMARY-2 #4: the newest cancel_at mutation Stripe confirmed for the CURRENT declaration revision of row `b`'s subscription,
 *  in ms, -1 for a confirmed clear, NULL when there is none. When it exists it is the current truth about Stripe's cancel_at, and it wins
 *  over the cached billing_subscriptions.cancel_at (which a failed stamping or an older event can leave behind). */
export const publicCurrentSql = (b: string) => {
  const decls = declsOf(b);
  return `(SELECT COALESCE(m.value*1000, -1) FROM cancellation_stripe_mutations m WHERE m.subscription_id=${b}.subscription_id AND m.kind='cancel_at'
    AND m.state='confirmed' AND m.decl_rev IS NOT NULL AND m.decl_n=(SELECT COUNT(*) FROM ${decls("c")})
    AND NOT EXISTS (SELECT 1 FROM ${decls("d")} AND instr(m.decl_rev, '|' || d.id || ':' || COALESCE(d.last_op,'-') || '|')=0)
    ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1)`;
};
export const publicCancelEndSql = (b: string) => {
  const decls = declsOf(b);
  const current = publicCurrentSql(b);
  return `(CASE WHEN NOT EXISTS (SELECT 1 FROM ${decls("o")} AND o.status='open') THEN NULL
    WHEN ${current} IS NOT NULL THEN NULLIF(${current}, -1)
    WHEN NOT EXISTS (SELECT 1 FROM ${decls("u")} AND u.stripe_synced=0)
      THEN (SELECT MIN(r.stripe_cancel_at) FROM ${decls("r")} AND r.status='open' AND r.stripe_synced=1 AND r.stripe_cancel_at IS NOT NULL)
    ELSE NULL END)`;
};

/** The public (§312k) declarations of the subscription `subExpr` (an SQL expression) that are still running: open (an end is scheduled),
 *  reason_pending (a serious reason under check) or held ("This wasn't me" pressed). Earliest end first. */
export const openDeclarationsSql = (subExpr: string) => `SELECT id,kind,status,effective_at,account_id,reason_decision,stripe_synced FROM cancellation_requests
  WHERE subscription_id=${subExpr} AND match_state='matched' AND status IN ('open','reason_pending','held','completed')
  ORDER BY effective_at IS NULL, effective_at, received_at, id`;
export interface OpenDeclaration { id: string; kind: string; status: string; effective_at: number | null; account_id: string | null; reason_decision: string | null; stripe_synced: number }
/** Whether `userId` can take this declaration back with Keep my plan now: the SAME rule keepPlan (public-cancellation.ts) applies.
 *  Astra JOURNEY-BCORE-5 #5: while the subscription is PARKED (scheduleParked) Stripe is still active, so the owner may still take it back
 *  locally after its date, also once it was marked completed (its end could not be carried out). */
export const keepableBy = (r: OpenDeclaration, userId: string, now: number, parked = false): boolean =>
  r.account_id === userId && !(r.kind === "extraordinary" && r.reason_decision !== "reject") && r.effective_at !== null
  && (parked ? ["open", "held", "completed"].includes(r.status) : (r.status === "open" || r.status === "held") && r.effective_at > now);

/** Whether the plan ends without renewing, and when (`until`). It ends at the paid period's end when ANY of these holds: Stripe's
 *  cancel_at_period_end (the in-app Cancel plan path, confirmed); an in-app cancellation journaled and not yet synced to Stripe; Stripe's
 *  cancel_at (migration 0092) at or before the period end; an open public cancellation Stripe confirmed (publicAt, publicCancelEndSql) at or
 *  before it. A cancel_at earlier than the period end is that earlier date. Read-only: never gates, lifts or changes anything.
 *  endingSql is the SAME rule as SQL (the renewal-reminder sweep); change both together. `confirmedOnly` (the account page, Astra
 *  CANCEL-SUMMARY-1 #6) leaves out the in-app cancellation not yet synced to Stripe: that one is pending, not confirmed. */
export function planEnding(sub: SubRow, publicAt: number | null, confirmedOnly = false, publicCurrent: number | null = null): { ending: boolean; until: number | null } {
  const periodEnd = sub.current_period_end ?? sub.first_charge_at;
  const ends: number[] = [];
  const atEnd = sub.cancel_at_period_end === 1 || (!confirmedOnly && inAppPending(sub));
  // Current-revision evidence (a confirmed date or a confirmed clear: publicCurrentSql) takes precedence over the cached cancel_at.
  const cached = publicCurrent !== null ? null : sub.cancel_at ?? null;
  for (const at of [cached, publicAt]) if (at !== null && (periodEnd === null || at <= periodEnd)) ends.push(at);
  if (atEnd && periodEnd !== null) ends.push(periodEnd);
  if (ends.length) return { ending: true, until: Math.min(...ends) };
  return { ending: atEnd, until: periodEnd };
}
/** An in-app Cancel plan journaled and not yet confirmed by Stripe (synced). */
export const inAppPending = (sub: SubRow): boolean => sub.customer_cancel_at !== null && sub.cancel_intent_rev > sub.cancel_synced_rev;
/** The in-app Cancel plan intent, journaled: the customer's cancellation is recorded first (durable, revisioned), then synced to Stripe by
 *  syncCancellation under the home's lease. The ONE write every in-app path makes (Cancel plan, and Delete my Cloud: B1), so both get the
 *  same reconciliation, the same confirmation email and the same summary state. Run with fencedRun under the home's lease. */
/** Astra JOURNEY-BCORE-1 #2: the end date the customer is promised (the paid period's end at this moment) is frozen with a NEW intent
 *  (cancel_promised_end) and kept by a repeated press; a renewal never moves it.
 *  Astra JOURNEY-BCORE-7 #2: a NEW freeze never takes a cached period end that has already passed (a renewal the row has not learned yet):
 *  the cancellation is accepted at once (customer_cancel_at, the revision) with its promise left NULL, pending reconciliation, and
 *  syncCancellation freezes it from Stripe's live period (with its obligation) before anything is confirmed. Parked, Stripe cannot be asked
 *  to change anything, so the cached date is frozen as before (Astra JOURNEY-BCORE-6 #2). Binds: (now, now, homeId). */
export const IN_APP_CANCEL_INTENT_SQL = `UPDATE billing_subscriptions SET customer_cancel_at=COALESCE(customer_cancel_at,?),cancel_intent_rev=cancel_intent_rev+1,
  cancel_promised_end=CASE WHEN customer_cancel_at IS NOT NULL AND cancel_promised_end IS NOT NULL THEN cancel_promised_end
    WHEN COALESCE(current_period_end,first_charge_at)>? OR ${parkedSql("billing_subscriptions.subscription_id")} THEN COALESCE(current_period_end,first_charge_at)
    ELSE NULL END WHERE home_id=?`;

/** Astra INTEGRATED-2 #1 (RULE B): THE deletion billing obligation is the Delete request itself (cloud_recovery_holds action 'delete', not
 *  cancelled: open or completed), persisted whether or not a subscription exists yet. A subscription bound to the home later (its claim)
 *  binds to it in the SAME batch: the in-app cancellation intent is journaled on it (IN_APP_CANCEL_INTENT_SQL, once) and its generation-bound
 *  resolution with it, so the in-app cancellation sweep (cancel_intent_rev ahead of cancel_synced_rev) selects it and ends it through the
 *  gateway, and the home is not retired until that end is settled (DELETION_BILLING_OPEN_SQL). */
export const DELETE_REQUESTED_SQL = (homeExpr: string) => `EXISTS (SELECT 1 FROM cloud_recovery_holds dh WHERE dh.home_id=${homeExpr} AND dh.action='delete' AND dh.canceled_at IS NULL)`;
export const deletionBindQs = (homeId: string, now: number): Q[] => [
  q(`${IN_APP_CANCEL_INTENT_SQL} AND subscription_id IS NOT NULL AND customer_cancel_at IS NULL AND ${DELETE_REQUESTED_SQL("billing_subscriptions.home_id")}`, now, now, homeId),
  ...inAppResolutionQ(homeId, now)];

/** Astra JOURNEY-BCORE-2 #7: Stripe timestamps are whole seconds, so an end Stripe shows may differ from a frozen promise by up to a second (and a
 *  clock read a little before the boundary is still "at" it): five seconds is the whole tolerance. There is no larger one. */
export const RESOLUTION_PRECISION_MS = 5_000;
/** Astra JOURNEY-BCORE-2 #1, JOURNEY-BCORE-3 #2: a resolution row (cancel_resolutions) is a generation-bound obligation of ONE cancellation, keyed
 *  (subscription, generation): a public cancellation and an in-app Delete of the same plan each keep their own row, so holding, timing out or
 *  keeping one never stalls or withdraws the other's enforcement (the earliest actionable promise is whatever standing rows say when read). The
 *  upsert re-opens a withdrawn row of the same generation (a held declaration resumed), keeping its schedule_id (parking is cleared only by the
 *  resolver's hourly read: Astra JOURNEY-BCORE-5 #1); a live one is left exactly as it is. The statement after
 *  it withdraws the SAME owner's older open generations (`prefix`: a public request whose end moved), only once the new row stands. */
const RESOLUTION_UPSERT_TAIL = ` ON CONFLICT(subscription_id,generation) DO UPDATE SET home_id=excluded.home_id, source=excluded.source,
  promised_end_at=excluded.promised_end_at, due_at=excluded.due_at, state='open', attempts=0,
  next_attempt_at=excluded.next_attempt_at, last_attempt_at=NULL, last_error=NULL, ended_at=NULL, late_checked_at=NULL,
  created_at=excluded.created_at, resolved_at=NULL
  WHERE cancel_resolutions.state='withdrawn'`;
const RESOLUTION_COLUMNS = "subscription_id,home_id,source,generation,promised_end_at,due_at,state,next_attempt_at,created_at";
/** Withdraws the owner's other OPEN generations once `current` (SQL yielding subscription_id and generation) is an open row. */
const supersedeQ = (prefix: string, current: string, binds: unknown[], now: number): Q => q(`UPDATE cancel_resolutions SET state='withdrawn',resolved_at=?
  WHERE state='open' AND substr(generation,1,length(?))=? AND EXISTS (SELECT 1 FROM (${current}) c JOIN cancel_resolutions n ON n.subscription_id=c.s AND n.generation=c.g
    AND n.state='open' WHERE c.s=cancel_resolutions.subscription_id AND c.g<>cancel_resolutions.generation)`, now, prefix, prefix, ...binds);
/** Astra JOURNEY-BCORE-5 #2, JOURNEY-BCORE-6 #2: THE one way a cancellation's obligation row is written, for both paths. Its promised end is
 *  the cancellation's frozen date, also when that date has already passed: then the obligation is due NOW (next_attempt_at clamps to the
 *  past), never dropped and never moved. `overdue` says when a past date is still an obligation (SQL over the selected row). */
const resolutionQ = (i: { source: "in_app" | "public"; generation: string; promised: string; from: string; overdue: string }, binds: unknown[], now: number): Q =>
  q(`INSERT INTO cancel_resolutions (${RESOLUTION_COLUMNS})
  SELECT subscription_id,home_id,'${i.source}',${i.generation},${i.promised},${i.promised},'open',MAX(${i.promised}-?,0),?
  FROM ${i.from} AND (${i.promised}>? OR ${i.overdue})${RESOLUTION_UPSERT_TAIL}`, RESOLUTION_PRECISION_MS, now, ...binds, now);
/** The in-app cancellation's resolution, written in the SAME fenced batch, right AFTER IN_APP_CANCEL_INTENT_SQL (it reads the intent that
 *  statement just wrote). generation 'in_app:<customer_cancel_at>' names the episode (set by the first press, cleared by Keep). Astra
 *  JOURNEY-BCORE-7 #2: EVERY frozen promise is enforced, parked or not; one already past is an obligation due now (Astra JOURNEY-BCORE-6 #2).
 *  A stale cached period end is never frozen as a new promise in the first place (IN_APP_CANCEL_INTENT_SQL leaves it NULL; syncCancellation
 *  freezes the live one and writes this row then). Spread into the batch (two statements). */
export const inAppResolutionQ = (homeId: string, now: number): Q[] => [resolutionQ({ source: "in_app", generation: "'in_app:'||customer_cancel_at",
  promised: "cancel_promised_end", from: `billing_subscriptions WHERE home_id=? AND subscription_id IS NOT NULL AND customer_cancel_at IS NOT NULL
    AND cancel_promised_end IS NOT NULL AND status NOT IN ('canceled','disputed')`, overdue: "1" }, [homeId], now),
supersedeQ("in_app:", "SELECT subscription_id AS s,'in_app:'||customer_cancel_at AS g FROM billing_subscriptions WHERE home_id=? AND customer_cancel_at IS NOT NULL", [homeId], now)];
/** The public declaration's resolution (generation 'public:<request id>:<effective_at>'), written in the SAME fenced batch as the transition that
 *  gives the request its end (attribution, a rejected reason, a resumed hold); `op` is that transition's op id (nothing is written unless it won).
 *  Astra JOURNEY-BCORE-5 #2: an end already past (a late attribution or resume) is an obligation too, due now: its promised end stays the
 *  declaration's date. Spread into the batch (two statements). */
export const publicResolutionQ = (requestId: string, op: string, now: number): Q[] => [resolutionQ({ source: "public", generation: "'public:'||id||':'||effective_at",
  promised: "effective_at", from: `cancellation_requests WHERE id=? AND last_op=? AND match_state='matched' AND subscription_id IS NOT NULL AND home_id IS NOT NULL
    AND effective_at IS NOT NULL AND status IN ('open','reason_pending','held')`, overdue: "1" }, [requestId, op], now),
supersedeQ(`public:${requestId}:`, "SELECT subscription_id AS s,'public:'||id||':'||effective_at AS g FROM cancellation_requests WHERE id=? AND last_op=? AND effective_at IS NOT NULL",
  [requestId, op], now)];
/** Keep: withdraws the in-app resolution of the episode the Keep clears. Placed in the Keep's batch right after the keep record insert
 *  (plan_cancellation_keeps), so it applies exactly when the clear applied. */
export const withdrawInAppResolutionQ = (subscriptionId: string, episode: number, reference: string, revision: number, now: number): Q =>
  q(`UPDATE cancel_resolutions SET state='withdrawn',resolved_at=? WHERE subscription_id=? AND generation=? AND state IN ('open','terminated')
    AND EXISTS (SELECT 1 FROM plan_cancellation_keeps WHERE reference=? AND revision=?)`, now, subscriptionId, `in_app:${episode}`, reference, revision);
/** Keep: withdraws the public declaration's resolution, in the same batch, only if that declaration was kept by `op`. */
export const withdrawPublicResolutionQ = (requestId: string, op: string, now: number): Q =>
  q(`UPDATE cancel_resolutions SET state='withdrawn',resolved_at=? WHERE state IN ('open','terminated') AND substr(generation,1,length(?))=?
    AND EXISTS (SELECT 1 FROM cancellation_requests WHERE id=? AND last_op=? AND status='kept')`, now, `public:${requestId}:`, `public:${requestId}:`, requestId, op);

/** Where the plan of a home stands for "no further charge" (B1, Delete my Cloud): `ended` (cancelled, withdrawn or disputed: nothing renews),
 *  `ending` (it ends at `endsAt` and is never charged again: an in-app cancel, pending or confirmed, a Stripe end date, a public cancellation
 *  Stripe confirmed), `renewing`, or `none` (no subscription). Read-only. */
/** Astra JOURNEY-BCORE-1 #5: `confirmed` says whether Stripe has CONFIRMED that nothing renews (ended, or Stripe read back the end); an
 *  `ending` plan whose cancellation Stripe has not confirmed yet is ending with confirmation pending, and nobody is told "never charged again". */
export type PlanEndState = { state: "ended" | "ending" | "renewing" | "none"; endsAt: number | null; confirmed: boolean };
export async function planEndState(env: Env, homeId: string): Promise<PlanEndState> {
  const sub = await getSub(env, homeId);
  if (!sub?.subscription_id) return { state: "none", endsAt: null, confirmed: false };
  const wd = await env.DB.prepare("SELECT confirmed_at FROM withdrawals WHERE home_id=?").bind(homeId).first<{ confirmed_at: number }>();
  // Astra INTEGRATED-1 #5, INTEGRATED-2 #2/#5: a local canceled / disputed status (written BEFORE the gateway's end, JOURNEY-BCORE-7 #3) ends
  // the SERVICE; it is not Stripe's word that billing ended. Confirmed is read from THE Stripe-end checkpoint alone (stripeEndConfirmed): until
  // Stripe itself showed the subscription ended (parked, a failed refund / coverage / withdrawal / dispute end), the plan is ended but
  // unconfirmed: "being confirmed", never "no further charge".
  const stripeEnded = await stripeEndConfirmed(env, sub.subscription_id);
  if (sub.status === "canceled" || sub.status === "disputed" || wd || stripeEnded) return { state: "ended",
    endsAt: wd?.confirmed_at ?? sub.ended_at ?? sub.updated_at ?? null, confirmed: stripeEnded };
  const pub = await env.DB.prepare(`SELECT ${publicCancelEndSql("b")} AS at, ${publicCurrentSql("b")} AS cur FROM billing_subscriptions b WHERE b.home_id=?`).bind(homeId)
    .first<{ at: number | null; cur: number | null }>();
  const ending = planEnding(sub, pub?.at ?? null, false, pub?.cur ?? null);
  // Confirmed: Stripe read back an end (the account page's rule, confirmedOnly) and no newer in-app revision waits for Stripe.
  // Astra JOURNEY-BCORE-7 #6: never while PARKED (Stripe may still renew it until ops resolves the schedule): ending, being confirmed, with
  // the frozen date below.
  const confirmed = planEnding(sub, pub?.at ?? null, true, pub?.cur ?? null).ending && sub.cancel_intent_rev === sub.cancel_synced_rev
    && !await scheduleParked(env, sub.subscription_id);
  // Astra JOURNEY-BCORE-3 #11: the end a cancellation stated is the EARLIEST standing promise, never the mutable period end a renewal moved.
  const promised = ending.ending ? (await promiseOf(env, sub.subscription_id))?.promisedEndAt ?? null : null;
  const endsAt = promised !== null && (ending.until === null || promised < ending.until) ? promised : ending.until;
  return ending.ending ? { state: "ending", endsAt, confirmed } : { state: "renewing", endsAt: ending.until, confirmed: false };
}

/** B1: deleting the Cloud ends the plan, through the SAME path as the in-app Cancel plan (IN_APP_CANCEL_INTENT_SQL, then syncCancellation,
 *  which sends the same "your plan is cancelled" confirmation). Astra JOURNEY-B-1 #1: the plan end is a set of statements the caller commits
 *  in ONE fenced batch with the deletion hold itself (deletionPlanEnd), then confirms with Stripe (confirmDeletionPlanEnd), so a deletion is
 *  never scheduled while billing still renews. A plan already ending or ended is left exactly as it is. Never refunds and never moves money:
 *  it only stops the next renewal. A Stripe problem leaves the cancellation recorded and pending; the billing sweep confirms it. */
export type DeletionPlanEnd = { before: PlanEndState; stmts: Q[] };
export async function deletionPlanEnd(env: Env, homeId: string, now: number): Promise<DeletionPlanEnd> {
  const before = await planEndState(env, homeId);
  if (before.state === "ended" || before.state === "none") return { before, stmts: [] };
  // Astra JOURNEY-B-2 #1: "ending" from cached state alone is not enough. A Keep Stripe has not confirmed yet leaves the cached
  // cancel_at_period_end set while the intent says renew, and a public cancellation can still be kept. Only the home's OWN in-app intent,
  // held now, makes a deletion's journal unnecessary; otherwise the deletion writes its own durable intent (and its receipt).
  const sub = await getSub(env, homeId);
  if (before.state === "ending" && sub?.customer_cancel_at !== null && sub?.customer_cancel_at !== undefined) return { before, stmts: [] };
  // Astra JOURNEY-BCORE-2 #1: the generation-bound resolution is written in the same batch as the intent.
  const stmts: Q[] = [q(IN_APP_CANCEL_INTENT_SQL, now, now, homeId), ...inAppResolutionQ(homeId, now)];
  // B5: the same receipt as Cancel plan (its CX reference, from the shared allocator, #16), so the deletion's cancellation is keepable by it.
  if (sub?.subscription_id && !await inAppCancellationId(env, homeId)) {
    const ref = await allocateCancelRef(env, `plan:${homeId}:${sub.subscription_id}`, now).catch(() => null);
    if (ref) stmts.push(q(`INSERT OR IGNORE INTO plan_cancellations (reference,home_id,user_id,subscription_id,received_at)
      SELECT ?,id,owner_id,?,? FROM cloud_homes WHERE id=?`, ref, sub.subscription_id, sub.customer_cancel_at ?? now, homeId));
  }
  return { before, stmts };
}
/** After the batch with deletionPlanEnd's statements committed: Stripe is told (syncCancellation), and the dialog's plan state answered. */
export async function confirmDeletionPlanEnd(env: Env, deps: BillingDependencies, homeId: string, lease: HomeLease, end: DeletionPlanEnd):
  Promise<PlanEndState & { journaled: boolean; cancellationId: string | null }> {
  const { before } = end;
  if (!end.stmts.length) return { ...before, journaled: false, cancellationId: before.state === "ending" ? await inAppCancellationId(env, homeId) : null };
  let endsAt = before.endsAt;
  try { endsAt = (await syncCancellation(env, { ...deps, lease }, homeId, lease)).periodEnd ?? endsAt; }
  catch (e) { if (!(e instanceof StripeError || e instanceof CancelUnconfirmed || e instanceof LeaseLost)) throw e; }
  // Astra JOURNEY-BCORE-1 #5: confirmed only as Stripe read it back (syncCancellation records it); a refusal leaves it pending.
  const after = await planEndState(env, homeId);
  return { state: "ending", endsAt, confirmed: (after.state === "ended" || after.state === "ending") && after.confirmed, journaled: true,
    cancellationId: await inAppCancellationId(env, homeId) };
}
/** deletionPlanEnd committed on its own (one fenced batch) and confirmed: an open deletion asked for again heals a plan end it lacks. */
export async function endPlanForDeletion(env: Env, deps: BillingDependencies, homeId: string, lease: HomeLease, now: number):
  Promise<PlanEndState & { journaled: boolean; cancellationId: string | null }> {
  const end = await deletionPlanEnd(env, homeId, now);
  if (end.stmts.length) await fencedBatch(env, lease, end.stmts);
  return confirmDeletionPlanEnd(env, deps, homeId, lease, end);
}
/** Astra INTEGRATED-2 #1/#3 (RULE B): a Delete's billing obligation reconciled under the home's billing lease before its hold completes (never
 *  a gate: the hold completes whatever this finds). A subscription the home holds now is bound to the deletion and its end asked of Stripe
 *  through the gateway (the in-app intent, synced); unresolved checkout attempts past their grace are reconciled (proven empty settles each
 *  with its marker). What Stripe does not confirm now stays owed: the cancellation sweep retries it and the home is not retired until it is
 *  settled (DELETION_BILLING_OPEN_SQL, CHECKOUT_MAY_SETTLE_SQL). */
export async function reconcileDeletionObligation(env: Env, deps: BillingDependencies, homeId: string, lease: HomeLease, now: number): Promise<void> {
  await fencedBatch(env, lease, deletionBindQs(homeId, now));
  if ((await env.DB.prepare("SELECT 1 AS x FROM checkout_resume_attempts WHERE home_id=? AND state='creating' AND expires_at<=?").bind(homeId, now - STRIPE_ATTEMPT_GRACE_MS).first()) !== null) {
    await reconcileHomeAttempts(env, lease, stripeClient(cfg(env), deps.stripeFetch), homeId, now);
  }
  await endPlanForDeletion(env, deps, homeId, lease, now);
  const sub = await getSub(env, homeId);
  if (sub?.subscription_id && !ENDED(sub) && sub.cancel_intent_rev !== sub.cancel_synced_rev) {
    try { await syncCancellation(env, { ...deps, lease }, homeId, lease); }
    catch (e) { if (!(e instanceof StripeError || e instanceof CancelUnconfirmed || e instanceof SubscriptionParked)) throw e; }
  }
}
/** The CX reference of the home's CURRENT subscription's in-app cancellation, or null. */
export async function inAppCancellationId(env: Env, homeId: string): Promise<string | null> {
  try {
    return (await env.DB.prepare(`SELECT c.reference AS r FROM plan_cancellations c JOIN billing_subscriptions b ON b.home_id=c.home_id AND b.subscription_id=c.subscription_id
      WHERE c.home_id=?`).bind(homeId).first<{ r: string }>())?.r ?? null;
  } catch { return null; }
}
/** Astra JOURNEY-BCORE-2 #8: the ONE charge promise every response, email and view makes. A cancelled plan stops RENEWING; it never promises
 *  that nothing more can appear: `invoice_now` bills usage already served on a final invoice, and only what is charged for time after the end
 *  is refunded. `past`: the end date has gone by. */
export function renewalStopSentence(when: string | null, past = false): string {
  const day = when ?? "the end of the period you paid for";
  return `Renewals ${past ? "stopped" : "stop"} on ${day}. Any usage already served may still appear on a final invoice. Anything charged for time after ${day} is refunded.`;
}
/** The sentence the deletion emails and dialog use for the plan (B1): the end date, that renewals stop, and what can still appear. Null: nothing to say. */
export function planEndSentence(p: PlanEndState): string | null {
  if (p.state === "ended" && !p.confirmed) return "Your plan has ended. We are still confirming this with our payment provider; if a charge reaches you after this, we refund it.";
  if (p.state === "ended") return p.endsAt !== null ? `Your plan has ended. ${renewalStopSentence(isoDate(p.endsAt), true)}` : "Your plan has ended. Renewals have stopped. Any usage already served may still appear on a final invoice. Anything charged for time after the end is refunded.";
  // Astra JOURNEY-BCORE-1 #5: the end is stated as confirmed only once Stripe has confirmed it. Until then the plan is ending and its
  // confirmation is pending; if a charge still lands after the end date, it is refunded.
  const when = p.endsAt !== null ? isoDate(p.endsAt) : null;
  if (p.state === "ending") return p.confirmed ? `Your plan ends ${when ? `on ${when}` : "at the end of the period you paid for"}. ${renewalStopSentence(when)}`
    : `Your plan is set to end ${when ? `on ${when}` : "at the end of the period you paid for"}. We are still confirming this with our payment provider; if a charge for time after that date reaches you, we refund it.`;
  return null;
}
/** Astra JOURNEY-BCORE-1 #5: nothing is charged again, CONFIRMED (ended or ending, and Stripe confirmed it; INTEGRATED-1 #5). */
export const noFurtherCharge = (p: PlanEndState): boolean => (p.state === "ended" || p.state === "ending") && p.confirmed;
/** A renewal reminder (the billing_notices row aliased `n`) still stands: its home's plan is active, renewing (not endingSql), the home is not
 *  going away, and it is the subscription the reminder was written for (payload subscriptionId; older payloads carry none). */
export const reminderStandsSql = (n: string) => `EXISTS (SELECT 1 FROM billing_subscriptions rb JOIN cloud_homes rh ON rh.id=rb.home_id WHERE rb.home_id=${n}.home_id
  AND rb.status='active' AND NOT ${reminderBlockedSql("rb")} AND rh.desired_state NOT IN ('deleted','deleting','suspended')
  AND (json_extract(${n}.payload,'$.subscriptionId') IS NULL OR rb.subscription_id=json_extract(${n}.payload,'$.subscriptionId')))`;
/** Astra CANCEL-SUMMARY-2 #5: whether the plan's renewal is UNRESOLVED for row `b`, whatever the cached end date says: a public cancellation
 *  still running (open, a serious reason under check, held, executing), kept but not confirmed by Stripe, or completed but still awaiting
 *  Stripe's settlement of the end (Astra JOURNEY-B-1 #13: stripe_synced=0, e.g. its termination failed), an in-app cancellation, or an
 *  in-app intent revision Stripe has not confirmed yet (a cancel or a Keep in flight). A renewal reminder is neither selected nor sent then. */
export function renewalUnresolvedSql(b: string): string {
  return `(${b}.customer_cancel_at IS NOT NULL OR ${b}.cancel_intent_rev<>${b}.cancel_synced_rev
    OR EXISTS (SELECT 1 FROM cancellation_requests x WHERE x.subscription_id=${b}.subscription_id AND x.match_state='matched'
      AND (x.status IN ('open','reason_pending','held','executing') OR (x.status IN ('kept','completed') AND x.stripe_synced=0))))`;
}
/** A renewal reminder must not go out for row `b`: the plan is ending (endingSql) or its renewal is unresolved (renewalUnresolvedSql). */
export const reminderBlockedSql = (b: string) => `(${endingSql(b)} OR ${renewalUnresolvedSql(b)})`;
/** planEnding's `ending` as a SQL condition on the billing_subscriptions row aliased `b`. */
export function endingSql(b: string): string {
  const pe = `COALESCE(${b}.current_period_end,${b}.first_charge_at)`;
  const within = (x: string) => `(${x} IS NOT NULL AND (${pe} IS NULL OR ${x}<=${pe}))`;
  return `(${b}.cancel_at_period_end=1 OR (${b}.customer_cancel_at IS NOT NULL AND ${b}.cancel_intent_rev>${b}.cancel_synced_rev)
    OR ${within(`(CASE WHEN ${publicCurrentSql(b)} IS NOT NULL THEN NULL ELSE ${b}.cancel_at END)`)} OR ${within(publicCancelEndSql(b))})`;
}
/** Astra JOURNEY-B-3 #6: THE invoice reversal barrier, one condition for every path that acts on a paid invoice: the monthly grant
 *  (grantOnce) and the plan move Flux learns from it (propagatePlanOnInvoice, propagatePlanFromEvidence). An invoice is reversed when its
 *  credit reversal is journaled (a refund returned its money, Astra WP5-6 #2) or the router reported its grant reversed before it was applied
 *  (not_applied_reversed, final). `kind` null: any kind of that invoice. A reversed invoice never changes Flux nor clears its dirty mark.
 *  Only a FINAL reversal counts (lane A FINAL_REV, Astra JOURNEY-A-8 #3): a non-final refund-backed target follows the money returned and
 *  leaves its grant standing. */
export const invoiceReversedSql = (inv: string, kind: string | null) => `(EXISTS (SELECT 1 FROM credit_reversals rv WHERE rv.invoice_id=${inv}${kind === null ? "" : ` AND rv.kind=${kind}`}
    AND (rv.scope='full' OR rv.final=1))
  OR EXISTS (SELECT 1 FROM credit_grants sg WHERE sg.invoice_id=${inv}${kind === null ? "" : ` AND sg.kind=${kind}`} AND sg.granted_at IS NULL
    AND sg.suppressed_reason='not_applied_reversed'))`;
export async function invoiceReversed(env: Env, invoiceId: string, kind: string | null = null): Promise<boolean> {
  return (await env.DB.prepare(`SELECT 1 AS x WHERE ${invoiceReversedSql("?1", kind === null ? null : "?2")}`).bind(...(kind === null ? [invoiceId] : [invoiceId, kind])).first()) !== null;
}
/** Tells Flux the plan and clears the dirty mark, ONLY on an acknowledged change (Astra JOURNEY-B-3 #7). The pre-B4 stub's changePlan only
 *  logs (Flux is switched off at launch by design), so with it nothing is acknowledged: flux_plan_dirty stays set for the later cutover, and
 *  one alert (and a plain log line) notes the plan change still owed. Returns whether Flux took it; a real hook's failure throws. */
async function tellFluxPlan(env: Env, lease: HomeLease, flux: FluxEntitlementHooks, homeId: string, plan: string, billingCustomerId?: string): Promise<boolean> {
  if (flux.stub) {
    console.log(JSON.stringify({ message: "flux plan change pending: Flux not wired", homeId, plan }));
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
      .bind(`flux.plan_pending:${homeId}:${plan}`, homeId, "flux.plan_change_pending", "warning", JSON.stringify({ plan }), Date.now()).run();
    return false;
  }
  await flux.changePlan(env, { homeId, plan, billingCustomerId });
  await fencedRun(env, lease, "UPDATE billing_subscriptions SET flux_plan_dirty=0 WHERE home_id=? AND plan=?", homeId, plan);
  return true;
}
/** Astra JOURNEY-B-1 #14: the plan Flux caps the home at moves on the VERIFIED renewal invoice of that plan (the invoice gate monthly grants
 *  already use): a plan move still owed to Flux (flux_plan_dirty, left set by customer.subscription.updated for a downgrade) is told here, from
 *  the invoice's own plan line, and the mark is cleared only once Flux has acknowledged it (a failure throws: the event is retried). Astra
 *  JOURNEY-B-3 #6: never for a reversed invoice (invoiceReversed, the barrier grantOnce uses). */
export async function propagatePlanOnInvoice(env: Env, lease: HomeLease, flux: FluxEntitlementHooks, homeId: string, invoicePlan: string, invoiceId: string,
  billingCustomerId?: string): Promise<void> {
  const row = await env.DB.prepare("SELECT plan,flux_plan_dirty FROM billing_subscriptions WHERE home_id=?").bind(homeId).first<{ plan: string; flux_plan_dirty: number }>();
  if (row?.flux_plan_dirty !== 1 || row.plan !== invoicePlan) return;
  if (await invoiceReversed(env, invoiceId)) return;
  await tellFluxPlan(env, lease, flux, homeId, invoicePlan, billingCustomerId);
}
/** Astra JOURNEY-B-2 #7: Stripe does not order invoice.paid and customer.subscription.updated, so the renewal evidence is persisted (the
 *  period grant claim of the verified renewal invoice, credit_grants, written by invoice.paid under the same gates whatever the cached plan
 *  was) and a plan move still owed to Flux is reconciled from it by EITHER event or the billing sweep: the claim of the subscription's
 *  current period, at the plan the row now has, whose invoice is not reversed (invoiceReversedSql: the same barrier as every other path). A
 *  subscription that ended is never propagated. Returns whether Flux acknowledged it; a Flux failure throws (the event or the sweep retries). */
export async function propagatePlanFromEvidence(env: Env, lease: HomeLease, flux: FluxEntitlementHooks, homeId: string, billingCustomerId?: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT plan,flux_plan_dirty,subscription_id,status,current_period_start,customer_id FROM billing_subscriptions WHERE home_id=?").bind(homeId)
    .first<{ plan: string; flux_plan_dirty: number; subscription_id: string | null; status: string; current_period_start: number | null; customer_id: string | null }>();
  if (!row || row.flux_plan_dirty !== 1 || !row.subscription_id || row.status === "canceled" || row.status === "disputed") return false;
  const paid = await env.DB.prepare(`SELECT 1 AS x FROM credit_grants g WHERE g.home_id=? AND g.kind='period' AND g.subscription_id=? AND g.plan=?
    AND g.period_start>=? AND NOT ${invoiceReversedSql("g.invoice_id", null)} LIMIT 1`)
    .bind(homeId, row.subscription_id, row.plan, row.current_period_start ?? 0).first();
  if (!paid) return false;
  return tellFluxPlan(env, lease, flux, homeId, row.plan, billingCustomerId ?? row.customer_id ?? undefined);
}
export const getSub = (env: Env, id: string) => env.DB.prepare("SELECT * FROM billing_subscriptions WHERE home_id=?").bind(id).first<SubRow>();

// ---- Checkout and Portal (called server-to-server by the portal with the admin token) -------------------------

async function isOperator(request: Request, env: Env): Promise<boolean> {
  try { await admin(request, env); return true; } catch { return false; }
}
/** The running home a valid `address_change` route lets this account replace the plan of, or null. The route names the subscription the home
 *  keeps now; an expired route, one for a path nobody serves (seller none) or for another subscription is none. */
export async function replacementHomeFor(env: Env, userId: string, now: number): Promise<{ id: string } | null> {
  return env.DB.prepare(`SELECT h.id AS id FROM checkout_retry_routes r JOIN cloud_homes h ON h.owner_id=r.account_id AND h.desired_state<>'deleted'
    JOIN billing_subscriptions b ON b.home_id=h.id AND b.subscription_id=r.replaces_subscription_id
    WHERE r.account_id=? AND r.reason='address_change' AND r.seller<>? AND r.expires_at>? ORDER BY h.created_at DESC LIMIT 1`).bind(userId, NONE_SELLER, now).first<{ id: string }>();
}
/** Operator (admin token, names a home) or the signed-in customer (their own home, found by owner). */
export async function actor(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth, named: string | undefined,
  pick: "payable" | "subscribed"): Promise<{ homeId: string; operator: boolean }> {
  if (await isOperator(request, env)) {
    if (!named) throw new HTTPError(400, "invalid_request");
    return { homeId: named, operator: true };
  }
  const user = await (deps.accountUser ?? (async (r, a) => (await accountSession(r, a))?.user ?? null))(request, auth);
  if (!user) throw new HTTPError(401, "unauthorized");
  const row = pick === "payable"
    ? (await env.DB.prepare("SELECT id FROM cloud_homes WHERE owner_id=? AND desired_state='payment_pending' ORDER BY created_at DESC LIMIT 1").bind(user.id).first<{ id: string }>())
      // A customer with a valid address-change route pays for a REPLACEMENT of the plan of the home they already run (WP6).
      ?? (await replacementHomeFor(env, user.id, (deps.now ?? Date.now)()))
    : await env.DB.prepare(`SELECT h.id FROM cloud_homes h JOIN billing_subscriptions b ON b.home_id=h.id
        WHERE h.owner_id=? AND h.desired_state<>'deleted' ORDER BY h.created_at DESC LIMIT 1`).bind(user.id).first<{ id: string }>();
  if (!row) throw new HTTPError(404, "not_found");
  // An emailed approval was frozen for one home (step-up-email.ts): resolving another one now voids it.
  assertPinnedHome(request, row.id);
  return { homeId: row.id, operator: false };
}

/** POST /v1/billing/checkout. After an emailed step-up approval the client resends the IDENTICAL request (the same body, including
 *  consent.disclosureToken as first sent) with stepUpIntentId; a refreshed token alone is 403 stepup_request_changed (step-up-email.ts). */
export async function createCheckout(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  const config = cfg(env);
  // Selling needs the refund-identity key; nothing else does (b5-config.ts checkoutRefundKeyError).
  const keyError = checkoutRefundKeyError(env);
  if (keyError) throw new HTTPError(503, keyError);
  const tokenKeyError = disclosureKeyError(env);
  if (tokenKeyError) throw new HTTPError(503, tokenKeyError);
  const parsed = await readJSON(request, checkoutSchema);
  const who = await actor(request, env, deps, auth, parsed.homeId, "payable");
  // A customer acts on the home the server resolves; a homeId they send must BE that home (Astra TRUST-4 P2-4).
  if (!who.operator && parsed.homeId !== undefined && parsed.homeId !== who.homeId) throw new HTTPError(409, "home_mismatch");
  // A trusted step-up, or the first-purchase bootstrap bound to exactly this resolved home (purchase-bootstrap.ts).
  const authority = who.operator ? "operator" as const : await purchaseAuthority(deps, env, request, auth, null, who.homeId);
  if (!authority) throw stepUpRefused();
  const bootstrap = typeof authority === "object" ? authority : null;
  if (bootstrap) {
    // The bootstrap path names its home explicitly (it never acts on a home it was not given), and carries no top-up: the first purchase
    // on the sign-in alone sets up nothing that could charge later (TRUST-FIRST-FACTOR 3a fallback). A top-up asked for at the first purchase
    // is not a dead end (Astra STEPUP-EMAIL-10 #3): the bootstrap does not cover it, so this is the shared step-up refusal with its emailed-code
    // intent, and the exact retry carries that approval (trusted authority, never the bootstrap).
    if (parsed.homeId === undefined || !bootstrap.row || parsed.consent.topup?.enabled) throw stepUpRefused();
  }
  // WP4 r2-3: before anything else, the disclosure token must be the server's own for exactly the submitted siteLanguage, declaredCountry,
  // Stripe locale (from checkoutLanguage), path (the seller of that country) and renewalText (409 disclosure_stale otherwise).
  {
    const c = parsed.consent;
    const declared = c.declaredCountry.trim().toUpperCase();
    // A country nobody may sell in throws its own refusal here (no disclosure, hence no token, exists for it).
    const path = sellerFor(sellerSettings(env), declared) === "link" ? "managed" : "direct";
    verifyDisclosureToken(env, c.disclosureToken, { screenVersion: c.screenVersion, siteLanguage: c.siteLanguage, declaredCountry: declared, path,
      locale: checkoutLocale(declared, c.checkoutLanguage), renewalText: c.renewalText }, (deps.now ?? Date.now)());
  }
  // A paused country is refused before the lease is taken, so the refusal writes nothing at all (not even billing_home_leases); the check
  // is repeated inside the lease (a pause that lands meanwhile still wins).
  if (await countrySwitch(env, declaredCountryOf(parsed.consent)) === "paused") throw new HTTPError(409, "country_paused");
  // The whole checkout runs under the home's billing lease; a home that is busy (another checkout, a webhook, a refund) is told to retry.
  try { return await withHomeLease(env, who.homeId, (lease) => createCheckoutLeased(request, env, deps, lease, config, parsed, who, bootstrap), deps.lease); }
  catch (e) {
    if (e instanceof HomeBusy || e instanceof LeaseLost) throw new HTTPError(409, "home_busy");
    throw e;
  }
}
async function createCheckoutLeased(request: Request, env: Env, deps: BillingDependencies, lease: HomeLease, config: BillingConfig,
  parsed: z.infer<typeof checkoutSchema>, who: { homeId: string; operator: boolean }, bootstrap: BootstrapGrant | null): Promise<Response> {
  const input = { homeId: who.homeId, plan: parsed.plan, fpTid: parsed.fp_tid };
  const home = await getHome(env, input.homeId);
  if (!home) throw new HTTPError(404, "not_found");
  const now = (deps.now ?? Date.now)();
  const stripe = stripeClient(config, deps.stripeFetch);
  let sub = await getSub(env, input.homeId);
  // A valid `address_change` route for THIS subscription is the one thing that lets a running home check out again (a replacement, plan §1.3).
  const routeRow = await env.DB.prepare("SELECT * FROM checkout_retry_routes WHERE account_id=?").bind(home.owner_id).first<RetryRoute>();
  const replacing = routeIsValid(routeRow, sub?.subscription_id ?? null, now) ? routeRow : null;
  if (!replacing && (home.desired_state !== "payment_pending" || home.entitlement !== "pending")) throw new HTTPError(409, "home_not_payable");
  if (!replacing && sub?.subscription_id && ["active", "trialing", "past_due"].includes(sub.status)) throw new HTTPError(409, "already_subscribed");
  // The declared country must be the billing country, and a paused country is refused BEFORE any write (409 country_paused). The seller is
  // decided by the declared country (seller.ts; 409 tax_unavailable where nobody may sell). Then the one button, the region rules, the
  // document versions and the shown text are checked on the server before anything is charged or created. There is no tax quote (r13).
  const declared = declaredCountryOf(parsed.consent);
  if (await countrySwitch(env, declared) === "paused") throw new HTTPError(409, "country_paused");
  const seller = sellerFor(sellerSettings(env), declared);
  // The replacement is for the path the address change needs: any other path would only repeat the problem.
  if (replacing && seller !== replacing.seller) throw new HTTPError(409, "already_subscribed");
  // The bootstrap continues only its own records: no replacement, and a billing row only with the customer it created itself.
  const boot = bootstrap?.row ?? null;
  if (boot && (replacing || (sub !== null && sub.customer_id !== boot.stripe_customer_id))) throw stepUpRefused();
  // A step-up operation's checkout is ONE immutable attempt (Astra STEPUP-EMAIL-5 #3): its id is stable per approved intent, and it fixes
  // the consent, the expiry and the whole Stripe request before the session is created. The exact retry of an interrupted operation (a
  // crash between Stripe's session and the batch recording it) finds it and replays that identical request under the identical
  // idempotency key: Stripe answers with the orphan session, which is then recorded. Nothing is prepared a second time.
  const op = boot ? null : stepUpOpOf(env);
  const attemptId = op ? `stepup-checkout:${op.intentId}` : null;
  if (attemptId) {
    const prior = await env.DB.prepare("SELECT consent_id,expires_at,payload,state,stripe_price_id,idempotency_key,session_id FROM checkout_resume_attempts WHERE id=? AND home_id=?")
      .bind(attemptId, input.homeId).first<CheckoutAttempt>();
    if (prior) {
      try { return await replayCheckoutAttempt(env, lease, stripe, input.homeId, attemptId, prior, now); }
      catch (e) { if (!(e instanceof RelocatedAttempt)) throw e; }
      // Its session was made before the customer moved (now or on an earlier press): a fresh session for the same consent, as Finish
      // checkout makes it, never a dead end (Astra TAXCOUNTRY-3 #6). The step-up operation commits with that session's publication.
      return resumeLeased(env, deps, lease, config, input.homeId, null);
    }
  }
  const consent = prepareConsent(parsed.consent, parsed.plan, now, clientMeta(parsed.consent.client, request),
    { seller, policyVersion: await currentPolicyVersion(env), ipCountryHint: request.headers.get("CF-IPCountry") });
  const fingerprint = await sha256Hex(JSON.stringify([parsed.plan, consent.billingCountry, consent.declaredCountry, consent.locale, consent.siteLanguage, consent.postalCode, consent.earlyStart,
    consent.taxId, consent.topup, consent.renewalText, consent.screenVersion, consent.versions, input.fpTid ?? null, replacing?.replaces_subscription_id ?? null]));
  // One open checkout per home. The same choices again (a double click, a retry, a back button) reuse the open session; changed choices
  // expire it first. Two sessions for one home never exist at once, so two subscriptions cannot be created.
  const open = await env.DB.prepare("SELECT * FROM open_checkouts WHERE home_id=?").bind(input.homeId).first<OpenCheckout>();
  if (open?.state === "open" && open.fingerprint === fingerprint && open.session_id && open.session_url && (open.expires_at ?? 0) > now + 5 * 60_000) {
    const c = await getConsent(env, open.consent_id);
    // Astra TAXCOUNTRY-3 P2-b: the reuse goes through the same settle and preset first. A session made before the customer was moved (the
    // relocation marker: now, or by an earlier request) has been expired by it and is never handed back: a fresh one is issued below.
    // Astra TAXCOUNTRY-5: the preset may move the home to a NEW customer (a switch is a relocation: stale), so the pointer is read again.
    const reusable = sub !== null && c !== null && !(await prepareCheckoutCustomer(env, lease, stripe, { homeId: input.homeId,
      consentId: c.id, country: c.billing_country, postalCode: c.postal_code ?? null, bootstrap: bindingOf(boot) })).stale;
    sub = await getSub(env, input.homeId);
    if (reusable) return json({ sessionId: open.session_id, url: open.session_url, consentId: open.consent_id, locale: c?.checkout_language ?? consent.locale,
      policyVersion: c?.policy_version ?? consent.policyVersion, reused: true });
  }
  if (open?.state === "creating" && open.updated_at > now - 60_000) throw new HTTPError(409, "checkout_in_progress");
  if (open?.state === "completed" && !replacing) throw new HTTPError(409, "already_subscribed");
  await assertNoUnresolvedAttempt(env, lease, stripe, input.homeId, now);
  const claim = open
    ? await fencedRun(env, lease, `UPDATE open_checkouts SET consent_id=?,fingerprint=?,state='creating',session_id=NULL,session_url=NULL,expires_at=NULL,updated_at=?
        WHERE home_id=? AND consent_id=? AND state=?`, consent.id, fingerprint, now, input.homeId, open.consent_id, open.state)
    : await fencedRun(env, lease, `INSERT INTO open_checkouts (home_id,consent_id,fingerprint,state,created_at,updated_at) VALUES (?,?,?,'creating',?,?)
        ON CONFLICT(home_id) DO NOTHING`, input.homeId, consent.id, fingerprint, now, now);
  if (claim !== 1) throw new HTTPError(409, "checkout_in_progress");
  const ownerEmail = await accountContactEmail(env.DB, home.owner_id);
  const owner = ownerEmail === null ? null : { email: ownerEmail };
  await recordConsent(env, lease, consent, { homeId: input.homeId, userId: home.owner_id, email: owner?.email ?? null }, now);
  try {
    const hadCustomer = sub !== null;
    if (!sub && boot) {
      // The bootstrap ALWAYS creates a new Stripe customer for this operation (never one looked up by id or email; Astra TRUST-3 #3), bound
      // to the open row in the same batch that records it, generation-fenced and with eligibility re-checked in that statement.
      // Astra TAXCOUNTRY-7 P2-d: journaled before the call; a binding that fails (issue_until crossed, eligibility lost) or an answer that is
      // lost leaves an orphan record, never an unrecorded customer.
      const createKey = `bootstrap-cust:${boot.user_id}:${boot.generation}`;
      const created = await createFirstCustomer(env, lease, stripe, { homeId: input.homeId, consentId: consent.id, key: createKey,
        body: firstCustomerBody({ email: owner?.email, homeId: input.homeId, fpTid: input.fpTid, country: consent.billingCountry, postalCode: consent.postalCode, createKey }) });
      const customer = { id: created.id };
      // issue_until is judged at this write, not at the handler's start (a deadline crossed during the Stripe call refuses; Astra TRUSTCODE-2 P2-1).
      const at = publishClock(deps);
      const [bound] = await fencedBatch(env, lease, [bindCustomerQ(boot, customer.id, at),
        q(`INSERT INTO billing_subscriptions (home_id,customer_id,plan,fp_tid,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE changes()=1
          ON CONFLICT(home_id) DO NOTHING`, input.homeId, customer.id, input.plan, input.fpTid ?? null, now, now),
        customerHomeQ(customer.id, input.homeId, "bootstrap", now),
        ...firstCreateSettledQs(input.homeId, created.key, created, consent.id, now)]);
      if (bound.meta.changes !== 1) throw await issuancePast(env, boot, at) ? bootstrapExpired() : stepUpRefused();
      boot.stripe_customer_id = customer.id;
      sub = await getSub(env, input.homeId);
      if (sub?.customer_id !== customer.id) throw stepUpRefused();
    } else if (!sub) {
      const user = owner;
      const createKey = `cust:${input.homeId}`;
      const created = await createFirstCustomer(env, lease, stripe, { homeId: input.homeId, consentId: consent.id, key: createKey,
        body: firstCustomerBody({ email: user?.email, homeId: input.homeId, fpTid: input.fpTid, country: consent.billingCountry, postalCode: consent.postalCode, createKey }) });
      const customer = { id: created.id };
      await fencedBatch(env, lease, [q(`INSERT INTO billing_subscriptions (home_id,customer_id,plan,fp_tid,created_at,updated_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(home_id) DO NOTHING`, input.homeId, customer.id, input.plan, input.fpTid ?? null, now, now),
        customerHomeQ(customer.id, input.homeId, "first", now),
        ...firstCreateSettledQs(input.homeId, created.key, created, consent.id, now)]);
      sub = await getSub(env, input.homeId);
    } else if (!replacing) {
      // (A replacement leaves the running subscription's plan alone: it moves only when the new payment is confirmed.)
      await fencedRun(env, lease, "UPDATE billing_subscriptions SET plan=?,fp_tid=COALESCE(?,fp_tid),updated_at=? WHERE home_id=?", input.plan, input.fpTid ?? null, now, input.homeId);
    }
    if (hadCustomer) {
      // Every earlier session of this customer: an open one is expired before a new one exists; a completed one for this home means the
      // payment went through and its webhook is on the way, so no second checkout is started.
      for (const s of (await stripe.listCheckoutSessions(sub!.customer_id)).data ?? []) {
        // A completed session whose order the ledger rejected, cancelled and refunded (a repriced, refused or duplicate checkout), or that
        // this home's record shows cancelled, is history, not a payment on its way (completedSessionSettled: one rule for every caller).
        const settled = s.status === "complete" && await completedSessionSettled(env, input.homeId, s, sub);
        if (s.status === "complete" && s.subscription && !settled && !(replacing && s.subscription === sub!.subscription_id) && (s.metadata?.home_id ?? input.homeId) === input.homeId) throw new HTTPError(409, "checkout_completed");
        if (s.status === "open") await stripe.expireCheckoutSession(s.id);
      }
    }
    if (!replacing) await fencedRun(env, lease, "UPDATE billing_subscriptions SET consent_id=?,first_charge_at=? WHERE home_id=?",
      consent.id, consent.schedule.firstChargeAt, input.homeId);
    const expiresAt = now + CHECKOUT_SESSION_TTL_MS;
    await fence(env, lease);
    // The bootstrap's deadline again, immediately before a session is created: the checks above (and their Stripe calls) took time.
    if (boot && await issuancePast(env, boot, publishClock(deps))) throw bootstrapExpired();
    // A customer created earlier carries the address of an earlier attempt (or none). Immediately before the session exists, under the lease,
    // the home's customer is brought to THIS consent's declared location (a first customer is created with it above). Required: no session
    // on an unverified tax location (Astra TAXCOUNTRY-1 P1). Astra TAXCOUNTRY-5: a rewritable customer is never re-addressed: the home is
    // moved to a NEW customer created with the declared location, and the session names the pointer read again here, under the lease.
    if (hadCustomer) {
      const prepared = await prepareCheckoutCustomer(env, lease, stripe, { homeId: input.homeId, consentId: consent.id,
        country: consent.billingCountry, postalCode: consent.postalCode, bootstrap: bindingOf(boot) });
      if (boot) boot.stripe_customer_id = prepared.customerId;
      sub = await getSub(env, input.homeId);
      if (sub?.customer_id !== prepared.customerId) throw new HTTPError(409, "checkout_superseded");
    }
    // Astra JOURNEY-A-2 A6: a session request is on record BEFORE Stripe is asked, so a crash between Stripe's answer and the write below
    // leaves evidence that a session may exist (it keeps a failed home from being retired until that session's expiry is recorded).
    // Astra JOURNEY-A-3 #2: the request's identity is its idempotency key, journaled with the marker and carried in the session's metadata.
    const issuanceId = `checkout:${consent.id}`;
    await fencedRun(env, lease, "UPDATE checkout_consents SET session_inflight_at=?,session_issuance_id=? WHERE id=?", now, issuanceId, consent.id);
    const sessionInput: SessionInput = { customerId: sub!.customer_id, homeId: input.homeId, plan: input.plan, issuanceId,
      priceId: config.priceByPlan[input.plan], fpTid: input.fpTid ?? sub!.fp_tid ?? undefined, consentId: consent.id,
      // The journaled renewal sentence (the authorization pressed on our page), bound to the session for the webhook (plan §3.2, 2026-10-14).
      renewalSha256: renewalSha256(consent.renewalText),
      // The locale actually sent: de for DE/AT, else the confirmed language (en when Stripe has no such locale). Links go to the marketing site.
      locale: consent.locale, submitLinks: submitLinksFor(env), replaces: replacing?.replaces_subscription_id ?? undefined,
      expiresAtSeconds: Math.floor(expiresAt / 1000), seller,
      // The members area's Cloud page (MakerKit /home/cloud; CONTRACT.md section 4), never MakerKit's own billing pages.
      successUrl: `${config.returnOrigin}${CLOUD_MEMBERS_PATH}?notice=paid&home=${encodeURIComponent(input.homeId)}`,
      cancelUrl: `${config.returnOrigin}${CLOUD_MEMBERS_PATH}?notice=checkout_cancelled&home=${encodeURIComponent(input.homeId)}` };
    // The step-up operation's attempt is written BEFORE the dispatch (an own reservation like every other write of the operation), with
    // the exact Stripe price and the ORIGINAL idempotency key (Astra STEPUP-EMAIL-6 #3): the exact retry and a later /checkout/resume both
    // replay it under that key, never another one, even when the batch recording the session below never lands.
    const idempotencyKey = issuanceId;
    if (attemptId) {
      await fencedRun(env, lease, `INSERT INTO checkout_resume_attempts (id,home_id,consent_id,expires_at,payload,state,created_at,stripe_price_id,idempotency_key)
        VALUES (?,?,?,?,?,'creating',?,?,?)`, attemptId, input.homeId, consent.id, expiresAt, JSON.stringify(sessionInput), now, sessionInput.priceId, idempotencyKey);
    }
    // A step-up operation journals the dispatch first, under its stable identity (step-up-op.ts; a superseded runner stops here).
    await journalDispatch(env, `checkout:${input.homeId}`);
    let session: { id: string; url: string };
    try { session = await stripe.createCheckoutSession(sessionInput, idempotencyKey); }
    catch (e) {
      // A step-up attempt's terminal refusal is reconciled at once (Astra STEPUP-EMAIL-7 #3), and so is a replayed 5xx, which is
      // INDETERMINATE (Astra STEPUP-EMAIL-8 #2): that one never abandons the attempt before its expiry and grace. Anything else as before.
      if (!attemptId || !(terminalStripeRefusal(e) || indeterminateStripeOutcome(e))) throw e;
      session = await reconcileStepUpAttempt(env, lease, stripe, { homeId: input.homeId, attemptId, consentId: consent.id, customerId: sub!.customer_id,
        expiresAt, proven: terminalStripeRefusal(e), matchExpiry: false }, now);
    }
    // The bootstrap's binding of this session is published FIRST in the same batch (generation-fenced, issue_until and eligibility re-checked
    // in the statement, issue_until on the time of this write); the session becomes this home's open checkout only when that binding held.
    const at = boot ? publishClock(deps) : null;
    const published = boot ? [bindSessionQ(boot, { customerId: sub!.customer_id, sessionId: session.id, consentId: consent.id, at })] : [];
    const owned = await fencedBatch(env, lease, [
      ...published,
      q(`UPDATE open_checkouts SET state='open',session_id=?,session_url=?,expires_at=?,updated_at=? WHERE home_id=? AND consent_id=? AND state='creating'${boot ? " AND changes()=1" : ""}`,
        session.id, session.url, expiresAt, now, input.homeId, consent.id),
      // A step-up operation's commitment (step-up-op.ts): ONLY its completed effect, the session recorded as this home's open checkout,
      // in this same transaction. Its preparation writes above (the open row, the consent, the customer) never commit it.
      ...[commitQ(env, `checkout:${input.homeId}`)].filter((x): x is Q => x !== null),
      // The exact Stripe price this consent was sold at: Finish checkout may reuse the consent only for this same price.
      q(`UPDATE checkout_consents SET stripe_session_id=?,stripe_price_id=?,session_inflight_at=NULL,session_issuance_id=NULL,session_expired_at=NULL WHERE id=?${boot ? " AND EXISTS (SELECT 1 FROM open_checkouts WHERE home_id=? AND session_id=? AND state='open')" : ""}`,
        session.id, config.priceByPlan[input.plan], consent.id, ...(boot ? [input.homeId, session.id] : [])),
      checkoutAlertSyncQ(consent.id, now), // Astra JOURNEY-A-4 #5: the marker settled by publication leaves the alert too
      ...(attemptId ? [q("UPDATE checkout_resume_attempts SET state='done',session_id=? WHERE id=?", session.id, attemptId)] : []),
      relocationClearedQ(input.homeId, session.id), // a session made after the customer's move: earlier ones are no longer a hazard
    ]);
    if (boot && owned[0].meta.changes !== 1) {
      // Not this operation's to issue any more (past issue_until, superseded, another record appeared): the session must not stay open.
      try { await stripe.expireCheckoutSession(session.id); await sessionRequestSettled(env, lease, consent.id, issuanceId, now); }
      catch (e) { if (e instanceof LeaseLost) throw e; /* a completion is caught by the duplicate claim */ }
      throw await issuancePast(env, boot, at) ? bootstrapExpired() : stepUpRefused();
    }
    if (owned[published.length].meta.changes !== 1) {
      // A newer submission took this home's checkout over while this one was being created (a slow Stripe call): this session must not
      // stay open beside it.
      try { await stripe.expireCheckoutSession(session.id); await sessionRequestSettled(env, lease, consent.id, issuanceId, now); }
      catch (e) { if (e instanceof LeaseLost) throw e; /* if it cannot be expired, a completion is caught by the duplicate claim */ }
      throw new HTTPError(409, "checkout_superseded");
    }
    return json({ sessionId: session.id, url: session.url, consentId: consent.id, locale: consent.locale, policyVersion: consent.policyVersion });
  } catch (e) {
    // Release the claim so the next submission can start cleanly (the record of this consent stays).
    try { await fencedRun(env, lease, "UPDATE open_checkouts SET state='failed',updated_at=? WHERE home_id=? AND consent_id=? AND state='creating'", now, input.homeId, consent.id); }
    catch (e2) { if (!(e2 instanceof LeaseLost)) throw e2; }
    if (e instanceof StripeError) throw new HTTPError(502, "stripe_unavailable");
    throw e;
  }
}
/** The declared billing location as the Stripe customer's address, set before a Checkout Session is created (staging 2026-10: a Thai buyer
 *  with German as the checkout language was first shown 19% German VAT; Stripe guesses the tax location from the session locale until an
 *  address is known). Stripe API reference (pinned STRIPE_API_VERSION 2025-03-31.basil):
 *  - Managed Payments (docs.stripe.com/payments/managed-payments/update-checkout, "Remove unsupported parameters"): `automatic_tax`,
 *    `customer_update[address]` and `customer_update[name]` are refused on the session; with `customer` set, "that object is updated with any
 *    changes to the customer's name or billing address". The first price Stripe shows is therefore computed on the address SAVED on the
 *    Customer the session names: the Customer is the only input.
 *  - Direct path (docs.stripe.com/tax/checkout/page, "Calculate tax for existing customers", Customer v1): with `automatic_tax[enabled]=true`
 *    and `customer`, Checkout taxes on the customer's saved address until the billing address collected in the session replaces it
 *    (`customer_update[address]=auto`, sent by seller.ts). We never set a shipping address (it would outrank the billing one).
 *  The address the customer enters at Stripe always wins (Stripe recalculates tax on it), and the completion webhook's declared-vs-collected
 *  comparison (sellerMismatch, guardVerdict) is untouched.
 *
 *  THE MODEL (Astra TAXCOUNTRY-5 P1): an address UPDATE whose answer was lost can still be executed by Stripe at any later time (Stripe keeps
 *  idempotency keys at least 24 hours and documents no execution deadline for an indeterminate request; 80 s is only our client's timeout),
 *  so no time bound, replay or read settles it, and a late one could re-address a customer that has started paying. Hence NO CUSTOMER IS EVER
 *  RE-ADDRESSED on this path:
 *  - The home's billing customer, THE POINTER (billing_subscriptions.customer_id), is read under the home's lease. Already at the declared
 *    country and postal code: used as it is.
 *  - PROTECTED (never written, never switched away from): a subscription that still bills here (D1) or at Stripe, a draft/open invoice, the
 *    customer's own money or instrument (customerHolds: a balance other than 0, a default payment method or source, any credit note), or a
 *    (Astra TAXCOUNTRY-6 P2-c: a bootstrap's own customer follows the same rule; its row moves with the pointer). A different country, or a different postal code in the same
 *    country, is refused (409 country_mismatch_existing, the location on file named); the same country with no declared postal code is used.
 *  - REWRITABLE (none of that): a NEW Stripe customer is CREATED with the declared location as its whole address, and the pointer is moved
 *    to it in one fenced compare-and-set (switchCheckoutCustomer). A create that lands late can only produce an unreferenced customer (an
 *    ORPHAN, recorded for ops): it can never change a customer anybody uses. The previous customer is kept and recorded (its receipts stay
 *    listed: journey.ts customersOf). Nothing is ever deleted at Stripe.
 *  The address_change route (a running subscriber's replacement checkout, checkout-replacement.ts) meets a PROTECTED customer (its
 *  subscription still bills): it is never written. The route exists because the customer moved their own address at Stripe; any address
 *  that lands there later is that customer's own earlier request, not ours.
 *  - Sessions made before a switch are never handed back: the switch records the home's DURABLE relocation marker (cloud_ops_state
 *    `tax_relocated:<home>`, naming the customers switched away from), and while it exists every open session of the pointer and of those
 *    customers is expired (confirmed at Stripe) before anything is issued or reused; a saved attempt frozen on an earlier customer is
 *    treated as made before the move. The marker is cleared only by the publication of a session made after it (or by the 48-hour cleanup,
 *    past any session's lifetime). `stale` reports that it was present.
 *  - The receipt (cloud_ops_state `tax_preset:<home>`) is DIAGNOSTIC (declared country, time, lease generation; no postal code).
 *  REQUIRED, fail-closed (Astra TAXCOUNTRY-1): a failed or indeterminate step refuses the session (503 checkout_unavailable, retryable).
 *  Returns the pointer to name in the session (`customerId`) and whether this call switched it (`changed`). */
export const taxPresetKey = (homeId: string) => `tax_preset:${homeId}`;
export const taxRelocatedKey = (homeId: string) => `tax_relocated:${homeId}`;
/** The journal of one customer create, written BEFORE the call (switchCheckoutCustomer): `tax_customer:<home>:<idempotency key>` = the exact
 *  encoded body, the home, consent, lease generation, the customer switched away from and, once Stripe answered, the new customer's id. The
 *  switch batch deletes it; a row left behind only ever becomes an orphan record (sweepTaxDispatches). It never blocks a checkout. */
const customerCreatePrefix = (homeId: string) => `tax_customer:${homeId}:`;
/** ORPHANS, the ops cleanup list: customers created for this home's attempts that the pointer never moved to (a lost answer that landed
 *  later, a switch batch that lost the lease). `customer_orphan:<home>:<attempt key>` = { homeId, consentId, idempotencyKey, customerId
 *  (null when never learnt: find it at Stripe by metadata[checkout_attempt]), createdAt, recordedAt, reason }. NEVER DELETED
 *  AUTOMATICALLY: deleting a Stripe customer is irreversible and cancels every subscription on it, and "unreferenced" is only our ledger's
 *  view, the very view a lost answer leaves incomplete; a person checks each one at Stripe first. */
export const customerOrphanKey = (homeId: string, attempt: string) => `customer_orphan:${homeId}:${attempt}`;
const customerOrphanPrefix = (homeId: string) => `customer_orphan:${homeId}:`;
/** PREVIOUS customers, kept for good: `customer_previous:<home>:<customer>` = { homeId, customerId, replacedBy, consentId, at, evidence (the
 *  reads that proved it held nothing of the customer's own) }. Its receipts stay listed (journey.ts customersOf), and a late completion or
 *  event on it is still this home's (homeKnowsCustomer). */
export const customerPreviousKey = (homeId: string, customerId: string) => `customer_previous:${homeId}:${customerId}`;
export const CUSTOMER_PREVIOUS_PREFIX = "customer_previous:";
/** THE OWNERSHIP LEDGER (Astra TAXCOUNTRY-6 P1): `customer_home:<customer>` = { homeId, role, attempt?, consentId?, at }, one row per Stripe
 *  customer EVER created for a home, written in the same statement batch that first records the customer: the home's first customer (role
 *  `first` / `bootstrap`), every switch attempt's new customer (`attempt`, written whether or not the pointer moved to it), the customer
 *  switched away from (`previous`), and an orphan the sweep records (`orphan`). Never deleted and never rewritten (ON CONFLICT DO NOTHING:
 *  a customer belongs to the one home it was created for). Every webhook routing path asks homeOfCustomer, so a refund, dispute, invoice,
 *  subscription or credit-note event on a historical or orphan customer still reaches its home. */
export const customerHomeKey = (customerId: string) => `customer_home:${customerId}`;
export const customerHomeQ = (customerId: string, homeId: string, role: string, at: number, extra: { attempt?: string; consentId?: string } = {}): Q =>
  q("INSERT INTO cloud_ops_state (key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING", customerHomeKey(customerId),
    JSON.stringify({ homeId, customerId, role, ...extra, at }));
/** The home a Stripe customer belongs to, or null: the pointer (billing_subscriptions), the ownership ledger, then (rows written before the
 *  ledger existed) a previous-customer record, an orphan record or a create journal row naming it. Point lookups and key-range scans only. */
export async function homeOfCustomer(env: Env, customerId: string): Promise<string | null> {
  const pointer = await env.DB.prepare("SELECT home_id FROM billing_subscriptions WHERE customer_id=?").bind(customerId).first<{ home_id: string }>();
  if (pointer) return pointer.home_id;
  const ledger = await env.DB.prepare("SELECT CASE WHEN json_valid(value) THEN json_extract(value,'$.homeId') END AS h FROM cloud_ops_state WHERE key=?")
    .bind(customerHomeKey(customerId)).first<{ h: string | null }>();
  if (ledger?.h) return ledger.h;
  const legacy = await env.DB.prepare(`SELECT json_extract(value,'$.homeId') AS h FROM cloud_ops_state
    WHERE ((key>='customer_previous:' AND key<'customer_previous;') OR (key>='customer_orphan:' AND key<'customer_orphan;') OR (key>='tax_customer:' AND key<'tax_customer;'))
      AND json_valid(value) AND json_extract(value,'$.customerId')=? LIMIT 1`).bind(customerId).first<{ h: string | null }>();
  return legacy?.h ?? null;
}
/** ORPHAN LIFECYCLE (Astra TAXCOUNTRY-6 P2-d). GDPR storage limitation (Art. 5(1)(e)): an orphan customer holds the account's email, the
 *  previous customer's name and a declared country/postal code, created for a checkout attempt that never used it; it has no purpose once
 *  confirmed empty. It is NOT erased automatically (an irreversible Stripe delete on our ledger's possibly incomplete view could destroy a
 *  customer's money or contract): each orphan is listed for ops (GET /v1/admin/customer-orphans, with its age), and one still recorded
 *  ORPHAN_REVIEW_MS after it was recorded raises a `billing.customer_orphan_review` alert asking for the manual erasure workflow in the
 *  README (confirm at Stripe that it has no subscription, invoice, charge, dispute or saved instrument, then delete it there and remove its
 *  record). The record itself (ids and dates only, no address) is kept as the audit trail of that review. */
export const ORPHAN_REVIEW_MS = 30 * 86_400_000;
/** Astra TAXCOUNTRY-7 P2-e: the RETENTION BOUND. An orphan still recorded this long after it was recorded escalates to a high-severity
 *  `billing.customer_orphan_overdue` alert (the review alert went unanswered): no orphan is left unreviewed past 60 days unseen. */
export const ORPHAN_ESCALATE_MS = 60 * 86_400_000;
export const CUSTOMER_ORPHAN_ALERT = "billing.customer_orphan_review";
export const CUSTOMER_ORPHAN_ESCALATION = "billing.customer_orphan_overdue";
/** An orphan record's age key (ms; 0 when unreadable or undated, so it sorts first and counts as overdue). EXACTLY the expression of the
 *  partial index cloud_ops_state_orphan_age (migration 0105), so listing and sweep read the index in age order. */
export const ORPHAN_AGE_SQL = "CASE WHEN json_valid(value) THEN COALESCE(json_extract(value,'$.recordedAt'),json_extract(value,'$.createdAt'),0) ELSE 0 END";
const ORPHAN_RANGE = "key>='customer_orphan:' AND key<'customer_orphan;'";
/** Astra INTEGRATED-7 P3: the planner preferred the primary-key range plus a temporary sort for every page; each orphan query names the
 *  age index (its WHERE implies the index's partial range), so it walks the index in age order with no sort (EXPLAIN QUERY PLAN checked). */
const ORPHAN_FROM = "cloud_ops_state INDEXED BY cloud_ops_state_orphan_age";
/** The orphan queries' SQL (exported for the query-plan test). */
export const ORPHAN_SQL = {
  firstPage: `SELECT key,value,${ORPHAN_AGE_SQL} AS age FROM ${ORPHAN_FROM} WHERE ${ORPHAN_RANGE} ORDER BY ${ORPHAN_AGE_SQL},key LIMIT ?`,
  nextPage: `SELECT key,value,${ORPHAN_AGE_SQL} AS age FROM ${ORPHAN_FROM} WHERE ${ORPHAN_RANGE}
        AND (${ORPHAN_AGE_SQL}>?1 OR (${ORPHAN_AGE_SQL}=?1 AND key>?2)) ORDER BY ${ORPHAN_AGE_SQL},key LIMIT ?3`,
  due: (flag: "reviewAlertedAt" | "escalatedAt") => `SELECT key,value FROM ${ORPHAN_FROM} WHERE ${ORPHAN_RANGE} AND ${ORPHAN_AGE_SQL}<=?
      AND json_valid(value) AND json_extract(value,'$.${flag}') IS NULL ORDER BY ${ORPHAN_AGE_SQL},key LIMIT ?`,
};
/** The ops listing's page size (default and maximum). */
export const ORPHAN_PAGE_DEFAULT = 200;
export const ORPHAN_PAGE_MAX = 1000;
/** The review sweep's work per pass and stage (each orphan is marked once alerted, so every pass makes durable progress: every overdue
 *  orphan is reached whatever their number). */
export const ORPHAN_ALERT_BATCH = 200;
export interface CustomerOrphanView { key: string; homeId: string | null; customerId: string | null; consentId: string | null; idempotencyKey: string | null;
  reason: string | null; createdAt: number | null; recordedAt: number | null; ageDays: number | null; reviewDueAt: number | null; overdue: boolean;
  escalateAt: number | null; escalated: boolean; reviewAlertedAt: number | null; escalatedAt: number | null }
const orphanView = (r: { key: string; value: string }, now: number): CustomerOrphanView => {
  let v: Record<string, unknown> = {};
  try { v = JSON.parse(r.value) as Record<string, unknown>; } catch { /* unreadable: listed with what the key says */ }
  const s = (x: unknown) => typeof x === "string" ? x : null;
  const n = (x: unknown) => typeof x === "number" && Number.isFinite(x) ? x : null;
  const recordedAt = n(v.recordedAt) ?? n(v.createdAt);
  return { key: r.key, homeId: s(v.homeId) ?? (r.key.split(":")[1] || null), customerId: s(v.customerId), consentId: s(v.consentId), idempotencyKey: s(v.idempotencyKey),
    reason: s(v.reason), createdAt: n(v.createdAt), recordedAt, ageDays: recordedAt === null ? null : Math.floor((now - recordedAt) / 86_400_000),
    reviewDueAt: recordedAt === null ? null : recordedAt + ORPHAN_REVIEW_MS, overdue: recordedAt === null || now >= recordedAt + ORPHAN_REVIEW_MS,
    escalateAt: recordedAt === null ? null : recordedAt + ORPHAN_ESCALATE_MS, escalated: recordedAt === null || now >= recordedAt + ORPHAN_ESCALATE_MS,
    reviewAlertedAt: n(v.reviewAlertedAt), escalatedAt: n(v.escalatedAt) };
};
/** Astra TAXCOUNTRY-7 P2-e: ONE PAGE of the orphans, OLDEST FIRST (age, then key), after the keyset cursor `after` (the `next` of the previous
 *  page: "<age>~<key>"), through the age index. `next` is null on the last page. Nothing is ever hidden by count: every orphan is reached by
 *  paging, and the oldest come first. */
export async function listCustomerOrphans(env: Env, now: number, page: { after?: string | null; limit?: number } = {}):
  Promise<{ orphans: CustomerOrphanView[]; next: string | null }> {
  const limit = Math.max(1, Math.min(ORPHAN_PAGE_MAX, Math.floor(page.limit ?? ORPHAN_PAGE_DEFAULT)));
  const cut = page.after ? page.after.indexOf("~") : -1;
  const afterAge = cut > 0 ? Number(page.after!.slice(0, cut)) : null;
  const afterKey = cut > 0 ? page.after!.slice(cut + 1) : null;
  if (page.after && (afterAge === null || !Number.isFinite(afterAge) || !afterKey)) throw new HTTPError(400, "invalid_cursor");
  const rows = (afterAge !== null
    ? await env.DB.prepare(ORPHAN_SQL.nextPage).bind(afterAge, afterKey, limit + 1)
      .all<{ key: string; value: string; age: number }>()
    : await env.DB.prepare(ORPHAN_SQL.firstPage)
      .bind(limit + 1).all<{ key: string; value: string; age: number }>()).results ?? [];
  const shown = rows.slice(0, limit);
  const last = shown[shown.length - 1];
  return { orphans: shown.map((r) => orphanView(r, now)), next: rows.length > limit && last ? `${last.age}~${last.key}` : null };
}
/** Astra TAXCOUNTRY-7 P2-e: the review sweep, in two stages over the age index (oldest first): every orphan recorded ORPHAN_REVIEW_MS ago and
 *  not yet alerted is added to its home's open `billing.customer_orphan_review` alert (warning); every one recorded ORPHAN_ESCALATE_MS ago
 *  and not yet escalated to its home's `billing.customer_orphan_overdue` alert (high). One open alert per home and kind (cloud_alerts_open):
 *  its detail carries the first orphan's fields, `count` (every orphan added) and up to 50 `items`; each orphan is marked
 *  (reviewAlertedAt / escalatedAt) in the SAME batch that counts it, so a pass never counts one twice and the next pass continues where this
 *  one stopped. Returns how many orphans were added to an alert. Never deletes anything. */
export async function alertOverdueOrphans(env: Env, now: number, batch = ORPHAN_ALERT_BATCH): Promise<number> {
  let raised = 0;
  const stages = [
    { ms: ORPHAN_REVIEW_MS, kind: CUSTOMER_ORPHAN_ALERT, flag: "reviewAlertedAt", severity: "warning", action: "manual_erasure_review" },
    { ms: ORPHAN_ESCALATE_MS, kind: CUSTOMER_ORPHAN_ESCALATION, flag: "escalatedAt", severity: "high", action: "manual_erasure_overdue" },
  ] as const;
  for (const st of stages) {
    const due = (await env.DB.prepare(ORPHAN_SQL.due(st.flag)).bind(now - st.ms, batch)
      .all<{ key: string; value: string }>()).results ?? [];
    for (const r of due) {
      const o = orphanView(r, now);
      if (!o.homeId) continue;
      const entry = { orphanKey: o.key, customerId: o.customerId, attempt: o.idempotencyKey, recordedAt: o.recordedAt,
        reviewDueAt: o.reviewDueAt, escalateAt: o.escalateAt, action: st.action };
      const orphanAlertBatch = [
        env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
          .bind(`alert:${st.kind}:${o.key}`, o.homeId, st.kind, st.severity, JSON.stringify({ ...entry, count: 0, items: [] }), now),
        env.DB.prepare(`UPDATE cloud_alerts SET detail=json_set(CASE WHEN json_array_length(detail,'$.items')<50 THEN json_insert(detail,'$.items[#]',json(?1)) ELSE detail END,
            '$.count',COALESCE(json_extract(detail,'$.count'),0)+1,'$.revision',COALESCE(json_extract(detail,'$.revision'),0)+1),delivered_at=NULL,delivery_attempts=0
          WHERE home_id=?2 AND kind=?3 AND resolved_at IS NULL AND json_valid(detail)
            AND EXISTS (SELECT 1 FROM cloud_ops_state WHERE key=?4 AND json_valid(value) AND json_extract(value,'$.${st.flag}') IS NULL)`)
          .bind(JSON.stringify(entry), o.homeId, st.kind, o.key),
        env.DB.prepare(`UPDATE cloud_ops_state SET value=json_set(value,'$.${st.flag}',?) WHERE key=? AND json_valid(value) AND changes()=1`).bind(now, o.key),
      ];
      const res = await env.DB.batch(orphanAlertBatch);
      raised += res[2].meta.changes ?? 0;
    }
  }
  return raised;
}
/** How long the diagnostic receipt and the relocation marker are kept at most (a Checkout session lives 24 hours at most). */
export const TAX_RECORD_RETENTION_MS = 48 * 3_600_000;
/** A customer create journal row older than this is no longer its request's (the request's switch batch is fenced on the lease generation it
 *  was journaled under, and the sweep takes the home's lease before it acts): the sweep turns it into an orphan record. */
export const TAX_DISPATCH_INFLIGHT_MS = 10 * 60_000;
/** The sweep learns a lost create's customer by replaying it under its key only while Stripe surely still holds the key (it keeps keys AT
 *  LEAST 24 hours): a replay of a pruned key would execute as a new create. An older row is recorded with the customer unknown. */
export const CUSTOMER_CREATE_REPLAY_MAX_MS = 20 * 3_600_000;
/** The sweep's backoff per journal row (stamped BEFORE each try, whatever happens): 10 min, 30 min, 2 h, 6 h, then every 24 h. */
export const TAX_DISPATCH_BACKOFF_MS = [10 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 24 * 3_600_000] as const;
/** The sweep's HARD cap per run (Astra TAXCOUNTRY-5 P2): every Stripe call it makes carries an abort at this cap (or at the scheduled
 *  invocation's own deadline, whichever is first), and no call is started with less than TAX_SWEEP_CALL_MIN_MS left. */
export const TAX_DISPATCH_SWEEP_BUDGET_MS = 60_000;
export const TAX_SWEEP_CALL_MIN_MS = 5_000;
interface CustomerCreate { homeId: string; idempotencyKey: string; body: string; createdAt: number; generation: number; consentId: string;
  fromCustomerId: string; customerId?: string | null; attempts?: number; nextAttemptAt?: number;
  /** Astra INTEGRATED-7 P2: when this idempotency key was FIRST used (an execution under a key reused from an orphan record keeps the key's
   *  first use, never its own start), so the replay window is always judged from the key's first use. Absent: createdAt. */
  keyAt?: number }
const normalPostal = (p: string | null) => p === null ? null : p.replace(/\s+/g, "").toUpperCase() || null;
const LIVE_HERE = ["active", "trialing", "past_due"];
/** A Stripe answer that PROVES its key created nothing: an invalid request (400, never idempotency_error, which says the key is bound to
 *  something else), 402, or 404. Never 409 (in flight, or a lock), 429, 401/403 or a 5xx. */
function dispatchRefused(e: unknown): boolean {
  return e instanceof StripeError && !e.meta.inFlight && e.meta.type !== "idempotency_error" && (e.status === 400 || e.status === 402 || e.status === 404);
}
async function readRelocation(env: Env, homeId: string): Promise<{ customerId?: string; from?: string[] } | null> {
  const row = await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key=?").bind(taxRelocatedKey(homeId)).first<{ value: string }>();
  if (!row) return null;
  try { const v = JSON.parse(row.value) as { customerId?: string; from?: unknown }; return { customerId: v.customerId, from: Array.isArray(v.from) ? v.from.filter((x): x is string => typeof x === "string") : [] }; }
  catch { return {}; }
}
/** The publication of a session made after the relocation marker clears it (in the publishing batch, only if that session was published). */
export const relocationClearedQ = (homeId: string, sessionId: string): Q => q(`DELETE FROM cloud_ops_state WHERE key=?
  AND EXISTS (SELECT 1 FROM open_checkouts WHERE home_id=? AND session_id=? AND state='open')`, taxRelocatedKey(homeId), homeId, sessionId);
/** THE SESSION GUARD'S EVIDENCE, shared by every place that asks "is this COMPLETE Checkout session of the home a purchase on its way?"
 *  (Astra TAXCOUNTRY-5 P2-1): it is NOT when its consent was rejected (rejected_at: the rejection path cancels and refunds the order, even
 *  when the rejection came before the session was attached to the consent and completed_at stays NULL), when its subscription was cancelled
 *  and refunded by our ledger (refund_ops), tombstoned (rejected_subscriptions) or is this home's own cancelled one, or when a price-mismatch
 *  refund ended the home's plan. */
export async function completedSessionSettled(env: Env, homeId: string, s: { subscription?: string | null; metadata?: Record<string, string> | null },
  sub: { subscription_id: string | null; status: string } | null): Promise<boolean> {
  const cid = s.metadata?.consent_id ?? null;
  if (cid && (await env.DB.prepare("SELECT 1 AS x FROM checkout_consents WHERE id=? AND home_id=? AND rejected_at IS NOT NULL").bind(cid, homeId).first()) !== null) return true;
  if (!s.subscription) return false;
  if (sub?.subscription_id === s.subscription && sub.status === "canceled") return true;
  // Astra TAXCOUNTRY-6 P2-a: every piece of evidence is about THIS session's subscription; a price-mismatch refund that ended an earlier
  // subscription of the home never settles a later one.
  return (await env.DB.prepare(`SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM refund_ops WHERE cancel_subscription_id=?
      OR (kind='price_mismatch' AND home_id=? AND end_plan=1 AND subscription_id=?))
    OR EXISTS (SELECT 1 FROM rejected_subscriptions WHERE subscription_id=?)`).bind(s.subscription, homeId, s.subscription, s.subscription).first()) !== null;
}
/** A COMPLETE Checkout session of this home that our ledger has neither recorded as a completed purchase nor settled (completedSessionSettled):
 *  a payment that may be in progress. A session naming no consent is unknown, so counted unless settled. */
async function unrecordedCompletion(env: Env, homeId: string, sessions: { status: string | null; subscription?: string | null; metadata?: Record<string, string> | null }[]): Promise<boolean> {
  const sub = await env.DB.prepare("SELECT subscription_id,status FROM billing_subscriptions WHERE home_id=?").bind(homeId).first<{ subscription_id: string | null; status: string }>();
  for (const s of sessions) {
    if (s.status !== "complete" || await completedSessionSettled(env, homeId, s, sub)) continue;
    const cid = s.metadata?.consent_id ?? null;
    if (!cid) return true;
    const known = await env.DB.prepare("SELECT completed_at FROM checkout_consents WHERE id=?").bind(cid).first<{ completed_at: number | null }>();
    if (!known || known.completed_at === null) return true;
  }
  return false;
}
/** Whether `customerId` is one of this home's own customers: the pointer, a previous one (customer_previous), or an orphan of its own
 *  attempts (customer_orphan, or a create journal row that learnt its id). A completed session on any other customer is not this home's
 *  order (the checkout.session.completed handler refuses it as unbound). */
export async function homeKnowsCustomer(env: Env, homeId: string, customerId: string): Promise<boolean> {
  const orphans = customerOrphanPrefix(homeId), creates = customerCreatePrefix(homeId);
  return (await env.DB.prepare(`SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM billing_subscriptions WHERE home_id=? AND customer_id=?)
    OR EXISTS (SELECT 1 FROM cloud_ops_state WHERE key=?)
    OR EXISTS (SELECT 1 FROM cloud_ops_state WHERE (substr(key,1,?)=? OR substr(key,1,?)=?) AND json_valid(value) AND json_extract(value,'$.customerId')=?)`)
    .bind(homeId, customerId, customerPreviousKey(homeId, customerId), orphans.length, orphans, creates.length, creates, customerId).first()) !== null;
}
/** Why this customer must keep its address and stay the home's customer, or null. THE READS THAT PROVE "nothing of the customer's own is
 *  here" (fresh, under the lease, immediately before a switch, and journaled with it as `evidence` on the previous-customer record):
 *  - D1: no subscription of the home that still bills (active, trialing, past_due);
 *  - GET /v1/customers/{id}?expand[]=subscriptions: no subscription that still bills at Stripe; `balance` EXACTLY 0 (the customer credit
 *    balance: anything else, or no number at all, holds); invoice_settings.default_payment_method null and default_source null;
 *  - GET /v1/invoices?customer=&status=draft and =open (limit 1): none;
 *  - GET /v1/credit_notes?customer=&limit=1: none ever issued;
 *  - GET /v1/payment_methods?customer= and /v1/customers/{id}/sources: no instrument attached at all, default or not (Astra TAXCOUNTRY-6
 *    P2-b: a SetupIntent attaches a card without making it a default).
 *  A customer Stripe answers as deleted holds nothing (it can carry no session or money). The same Stripe reads run AGAIN after the new
 *  customer exists, immediately before the pointer moves (switchCheckoutCustomer): anything that appeared meanwhile (a credit note, a card
 *  a SetupIntent attached) makes the customer a holder and the switch is abandoned. */
async function customerHolds(stripe: StripeClient, customerId: string, st: Awaited<ReturnType<StripeClient["customerTaxState"]>>, liveLocal: boolean): Promise<string | null> {
  if (liveLocal) return "subscription_here";
  if (st.deleted) return null;
  if (st.liveSubscription) return "subscription_stripe";
  if (st.balance !== 0) return "customer_balance";
  if (st.defaultPaymentMethod || st.defaultSource) return "payment_method";
  if (await stripe.customerHasPendingInvoice(customerId)) return "pending_invoice";
  if (await stripe.customerHasCreditNotes(customerId)) return "credit_notes";
  if (await stripe.customerHasInstruments(customerId)) return "saved_instrument";
  return null;
}
/** Expires one session and confirms it at Stripe: expired (now or already) is done; complete is 409 checkout_completed; anything else is a
 *  retryable 503 (the caller's durable state, the relocation marker, makes the next request try again). */
export async function expireConfirmed(env: Env, lease: HomeLease, stripe: StripeClient, sessionId: string): Promise<void> {
  await fence(env, lease);
  try { await stripe.expireCheckoutSession(sessionId); return; }
  catch (e) { if (e instanceof LeaseLost || e instanceof HTTPError) throw e; }
  const live = await stripe.retrieveEventObject("checkout_session", sessionId);
  if (live.status === "expired") return;
  if (live.status === "complete") throw new HTTPError(409, "checkout_completed");
  console.warn(JSON.stringify({ message: "checkout session made before a tax relocation not expired yet", homeId: lease.homeId, sessionId }));
  throw new HTTPError(503, "checkout_unavailable");
}
/** While the home's relocation marker exists: every open session of the pointer AND of every customer switched away from is expired
 *  (confirmed) before anything is issued or reused. A session of this home the customer completed before it could be expired is a payment on
 *  its way (unless settled: completedSessionSettled), never followed by a second payable session (Stripe: an expired session cannot be
 *  completed, a complete one cannot be expired). */
async function expireRelocatedSessions(env: Env, lease: HomeLease, stripe: StripeClient, a: { customerId: string; homeId: string }): Promise<boolean> {
  const marker = await readRelocation(env, a.homeId);
  if (!marker) return false;
  for (const customerId of [...new Set([a.customerId, ...(marker.from ?? [])])]) {
    const sessions = await stripe.listAllCheckoutSessions(customerId);
    if (await unrecordedCompletion(env, a.homeId, sessions.filter((s) => (s.metadata?.home_id ?? a.homeId) === a.homeId && !!s.metadata?.consent_id))) {
      throw new HTTPError(409, "checkout_completed");
    }
    for (const s of sessions) if (s.status === "open") await expireConfirmed(env, lease, stripe, s.id);
  }
  return true;
}
/** The bootstrap whose customer the home's pointer is (purchase-bootstrap.ts): its row is moved with the pointer in the same fenced batch. */
export interface BootstrapBinding { userId: string; generation: number }
export const bindingOf = (boot: { user_id: string; generation: number } | null | undefined): BootstrapBinding | null =>
  boot ? { userId: boot.user_id, generation: boot.generation } : null;
export async function prepareCheckoutCustomer(env: Env, lease: HomeLease, stripe: StripeClient, a: { homeId: string; consentId: string;
  country: string; postalCode: string | null; bootstrap?: BootstrapBinding | null }): Promise<{ customerId: string; changed: boolean; stale: boolean }> {
  try {
    await fence(env, lease);
    const row = await env.DB.prepare("SELECT customer_id,subscription_id,status,fp_tid FROM billing_subscriptions WHERE home_id=?").bind(a.homeId)
      .first<{ customer_id: string | null; subscription_id: string | null; status: string; fp_tid: string | null }>();
    if (!row?.customer_id) throw new HTTPError(409, "checkout_not_started");
    const customerId = row.customer_id;
    const done = async (id: string, changed: boolean) => ({ customerId: id, changed, stale: await expireRelocatedSessions(env, lease, stripe, { customerId: id, homeId: a.homeId }) });
    const st = await stripe.customerTaxState(customerId);
    const sameCountry = !st.deleted && st.country === a.country;
    const samePostal = normalPostal(st.postalCode) === normalPostal(a.postalCode);
    // Already exactly the declared location: nothing to create or refuse.
    if (sameCountry && samePostal) return await done(customerId, false);
    const liveLocal = !!row.subscription_id && LIVE_HERE.includes(row.status);
    // The address on file is not touched, and the customer stays. The declared postal code may be omitted (the country decides), but a
    // different one is a different tax location and is refused like a different country. Astra TAXCOUNTRY-6 P2-c: a bootstrap's customer
    // follows the SAME rule (one holding nothing is switched, its bootstrap row moved with the pointer); the 409 of a bootstrap holder says
    // that the step-up challenge is available (`step_up`: a verified member can be helped past the bootstrap's limits).
    const keep = async (holds: string) => {
      if (sameCountry && (a.postalCode === null || samePostal)) return await done(customerId, false);
      const billing = holds === "subscription_here" || holds === "subscription_stripe";
      // Astra TAXCOUNTRY-7 P2-c: THE HOLDER RECOVERY. A customer that holds something of its own (a card, a credit note, a balance) is never
      // switched and never re-addressed silently; its location changes only by the customer's own VERIFIED act, the same protected-customer
      // rule as an address change made at Stripe (customer.updated): a bootstrap request (signed in only) is answered 403 step_up_required
      // with the emailed-code intent for this exact request (index.ts serializer), and the approved retry, a verified operation of this
      // member, moves the customer's billing location to the declared one (moveHolderLocation, journaled before the call) and continues. A
      // customer with a subscription that still bills is never moved here: its move is the address-change flow (replacement checkout).
      if (a.bootstrap && !billing) {
        await fencedRun(env, lease, "INSERT INTO cloud_ops_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", holderMoveKey(a.homeId),
          JSON.stringify({ homeId: a.homeId, customerId, country: a.country, postalCode: normalPostal(a.postalCode), holds, at: Date.now() }));
        console.log(JSON.stringify({ message: "checkout refused: bootstrap holder must verify to move its billing location", homeId: a.homeId, customerId, holds }));
        throw new HTTPError(403, "step_up_required", { country: st.country, postalCode: st.postalCode,
          step_up: { bootstrap: false, reason: HOLDER_MOVE_REASON, holds, country: st.country, postalCode: st.postalCode,
            // The location the request declared (the one the approved retry moves the customer to: the offer row's own values).
            declared: { country: a.country, postalCode: normalPostal(a.postalCode) } } });
      }
      const op = stepUpOpOf(env);
      if (!a.bootstrap && !billing && op && await holderMoveOffered(env, a.homeId, customerId, a.country, a.postalCode)) {
        await moveHolderLocation(env, lease, stripe, { homeId: a.homeId, consentId: a.consentId, customerId, country: a.country, postalCode: a.postalCode,
          fromCountry: st.country, fromPostalCode: st.postalCode, holds, intentId: op.intentId });
        return await done(customerId, false);
      }
      console.log(JSON.stringify({ message: "checkout refused: billing location on file differs", homeId: a.homeId, customerId, holds,
        fileCountry: st.country, toCountry: a.country, postalDiffers: sameCountry }));
      throw new HTTPError(409, "country_mismatch_existing", { country: st.country, postalCode: st.postalCode,
        ...(a.bootstrap ? { step_up: { bootstrap: false, available: true } } : {}) });
    };
    const holds = await customerHolds(stripe, customerId, st, liveLocal);
    if (holds) return await keep(holds);
    const next = await switchCheckoutCustomer(env, lease, stripe, { homeId: a.homeId, consentId: a.consentId, country: a.country, postalCode: a.postalCode,
      from: customerId, fromCountry: st.country, fromName: st.name, fromEmail: st.email, fpTid: row.fp_tid, bootstrap: a.bootstrap ?? null,
      evidence: { liveHere: false, deleted: st.deleted, liveSubscription: st.liveSubscription, balance: st.balance, defaultPaymentMethod: !!st.defaultPaymentMethod,
        defaultSource: !!st.defaultSource, pendingInvoice: st.deleted ? null : false, creditNotes: st.deleted ? null : false, instruments: st.deleted ? null : false,
        bootstrap: !!a.bootstrap },
      recheck: async () => { const again = await stripe.customerTaxState(customerId); return customerHolds(stripe, customerId, again, false); } });
    if ("heldBy" in next) return await keep(next.heldBy);
    return await done(next.created, true);
  } catch (e) {
    if (e instanceof HTTPError || e instanceof LeaseLost) throw e;
    console.warn(JSON.stringify({ message: "checkout customer tax location preset failed", homeId: a.homeId, toCountry: a.country,
      code: e instanceof StripeError ? e.code : "fetch_failed" }));
    throw new HTTPError(503, "checkout_unavailable");
  }
}
/** Astra TAXCOUNTRY-7 P2-d: EVERY customer creation journals before the call, the home's first customer (`cust:<home>`) and a purchase
 *  bootstrap's (`bootstrap-cust:<user>:<generation>`) included, under the same journal as the switch attempts (`tax_customer:<home>:<key>`,
 *  the exact body): a refusal that proves nothing was created deletes the row; a lost answer leaves it for sweepTaxDispatches (replayed under
 *  its key while Stripe surely holds it, then an orphan record unless the pointer is that customer). Returns the created customer's id. */
/** Round 10 (Astra TAXCOUNTRY-9 P2-c): EVERY create attempt has its own journal row keyed by its own idempotency key. The attempt reuses the
 *  newest outstanding row's key (and its journaled body: a replay is the identical request) only while Stripe surely still holds that key
 *  (CUSTOMER_CREATE_REPLAY_MAX_MS): a replayed answer then belongs to exactly that row. Otherwise (no outstanding row: `base`; an outstanding
 *  one too old to replay: `base:r<now>`) it is a NEW attempt under a NEW key, so a later replay can never be mistaken for an earlier
 *  execution. Binding settles only the bound row; every other outstanding row stays for sweepTaxDispatches (an orphan record, never deleted). */
/** Astra INTEGRATED-7 P2: PERMANENT ATTEMPT IDENTITY. A key's use survives its journal row: the sweep's orphan record of an execution keeps
 *  the key, its first use (keyAt) and the journaled body. A key (journal row or orphan record) is reused only while Stripe surely still holds
 *  it, judged from its FIRST use, and only with its exact body; once any trace of the base key exists and none is replayable, the attempt
 *  gets a NEW key (`base:r<now>`), so an expired key is never executed again under the same identity (before: a swept journal row let the
 *  base key be reused after Stripe pruned it, and the new execution's orphan overwrote the earlier one's record). */
async function firstCreateAttempt(env: Env, homeId: string, base: string, body: string, now: number): Promise<{ key: string; body: string; keyAt: number }> {
  const prefix = `${customerCreatePrefix(homeId)}${base}`;
  const orphan = customerOrphanKey(homeId, base);
  const rows = (await env.DB.prepare(`SELECT key,value FROM cloud_ops_state WHERE (key=?1 OR (key>?2 AND key<?3) OR key=?4 OR (key>?5 AND key<?6))
    AND json_valid(value)`).bind(prefix, `${prefix}:r`, `${prefix}:s`, orphan, `${orphan}:`, `${orphan};`).all<{ key: string; value: string }>()).results;
  type Trace = { key: string; keyAt: number; body: string | null };
  const traces: Trace[] = [];
  for (const r of rows) {
    if (r.key.startsWith(prefix)) {
      const d = readCreate(r.value);
      if (d) traces.push({ key: d.idempotencyKey, keyAt: createKeyAt(d), body: d.body });
      else traces.push({ key: r.key.slice(customerCreatePrefix(homeId).length), keyAt: 0, body: null });
      continue;
    }
    try {
      const v = JSON.parse(r.value) as { idempotencyKey?: unknown; keyAt?: unknown; createdAt?: unknown; body?: unknown };
      if (typeof v.idempotencyKey !== "string") { traces.push({ key: base, keyAt: 0, body: null }); continue; }
      const keyAt = typeof v.keyAt === "number" ? v.keyAt : typeof v.createdAt === "number" ? v.createdAt : 0;
      traces.push({ key: v.idempotencyKey, keyAt, body: typeof v.body === "string" ? v.body : null });
    } catch { traces.push({ key: base, keyAt: 0, body: null }); }
  }
  // The newest FIRST use of any key of this base decides: replayable (with its exact body) or a new key.
  traces.sort((x, y) => y.keyAt - x.keyAt);
  const newest = traces[0];
  if (newest && newest.body !== null && now - newest.keyAt < CUSTOMER_CREATE_REPLAY_MAX_MS) return { key: newest.key, body: newest.body, keyAt: newest.keyAt };
  return { key: traces.length ? `${base}:r${now}` : base, body, keyAt: now };
}
async function createFirstCustomer(env: Env, lease: HomeLease, stripe: StripeClient, a: { homeId: string; consentId: string; key: string; body: string }):
  Promise<{ id: string; startedAt: number; earlier: boolean; key: string }> {
  const attempt = await firstCreateAttempt(env, a.homeId, a.key, a.body, Date.now());
  a = { ...a, key: attempt.key, body: attempt.body };
  const journalKey = `${customerCreatePrefix(a.homeId)}${a.key}`;
  const startedAt = Date.now();
  const entry: CustomerCreate = { homeId: a.homeId, idempotencyKey: a.key, body: a.body, createdAt: startedAt, generation: lease.generation, consentId: a.consentId, fromCustomerId: "",
    ...(attempt.keyAt < startedAt ? { keyAt: attempt.keyAt } : {}) };
  // Round 9b (Astra TAXCOUNTRY-8 P2-c): whether an EARLIER create under this key is still outstanding (its row kept: answer lost, not swept).
  let earlier = false;
  try { earlier = await fencedRun(env, lease, "INSERT INTO cloud_ops_state (key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING", journalKey, JSON.stringify(entry)) !== 1; }
  catch (e) {
    if (e instanceof LeaseLost) throw e;
    console.error(JSON.stringify({ message: "checkout first customer create not journaled: nothing sent", homeId: a.homeId, error: String(e) }));
    throw new HTTPError(503, "checkout_unavailable");
  }
  // An answer Stripe REPLAYED from its idempotency cache is the earlier create's own customer; a fresh one (the key pruned) is a NEW customer,
  // and the earlier create's outcome stays unknown: its binding records it as an orphan (firstCreateSettledQs).
  try { const r = await stripe.postCustomerCreate(a.body, a.key); return { id: r.id, startedAt: entry.createdAt, earlier: earlier && !r.replayed, key: a.key }; }
  catch (e) {
    // Astra INTEGRATED-8 P2: a refusal deletes the journal row only when it answers EVERY execution the row stands for: this request was the
    // key's only use (no earlier row: a replay of an orphan-recorded key keeps that record), or Stripe's CACHED answer (Idempotent-Replayed)
    // of the original execution. An uncached 4xx on a replay is a fresh validation failure of THIS request only (Stripe saves no result for
    // it), so the earlier execution's outcome stays unknown: its row (identity: key, first use, body) stays for the sweep, which records it.
    if (dispatchRefused(e) && (!earlier || (e as StripeError).meta.replayed === true)) await fencedRun(env, lease, "DELETE FROM cloud_ops_state WHERE key=?", journalKey);
    else console.warn(JSON.stringify({ message: "checkout first customer create outstanding: answer lost (the sweep records it)", homeId: a.homeId,
      code: e instanceof StripeError ? e.code : "fetch_failed", uncachedReplayError: earlier && e instanceof StripeError && !e.meta.replayed ? e.status : null }));
    throw e;
  }
}
/** The first create's settlement, in the batch that binds it: the customer is an orphan record unless the pointer is it (binding failed:
 *  a deadline crossed, eligibility lost, another customer already bound), and the journal row is settled either way. */
const firstCreateSettledQs = (homeId: string, key: string, customer: { id: string; startedAt: number; earlier: boolean }, consentId: string, now: number): Q[] => [
  // Round 9b (Astra TAXCOUNTRY-8 P2-c): binding a LATER create never deletes an earlier outstanding journal row unrecorded: a row older than
  // this create (not its own) that did not learn this customer is recorded as an orphan with its customer unknown (reason
  // earlier_create_unsettled), in this same fenced batch, before the row is deleted below.
  ...(customer.earlier ? [q(`INSERT INTO cloud_ops_state (key,value) SELECT ?1,json_object('homeId',?2,'consentId',json_extract(value,'$.consentId'),
      'idempotencyKey',?3,'customerId',json_extract(value,'$.customerId'),'createdAt',json_extract(value,'$.createdAt'),'recordedAt',?4,
      'reason','earlier_create_unsettled','boundCustomerId',?5)
    FROM cloud_ops_state WHERE key=?6 AND json_valid(value) AND COALESCE(json_extract(value,'$.createdAt'),0)<?7
      AND COALESCE(json_extract(value,'$.customerId'),'')<>?5
    ON CONFLICT(key) DO NOTHING`, customerOrphanKey(homeId, `${key}:earlier:${customer.startedAt}`), homeId, key, now, customer.id,
    `${customerCreatePrefix(homeId)}${key}`, customer.startedAt)] : []),
  ...firstCreateBindQs(homeId, key, customer.id, consentId, now),
];
const firstCreateBindQs = (homeId: string, key: string, customerId: string, consentId: string, now: number): Q[] => [
  q(`INSERT INTO cloud_ops_state (key,value) SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM billing_subscriptions WHERE home_id=? AND customer_id=?)
    ON CONFLICT(key) DO NOTHING`, customerOrphanKey(homeId, key),
    JSON.stringify({ homeId, consentId, idempotencyKey: key, customerId, createdAt: now, recordedAt: now, reason: "binding_failed" }), homeId, customerId),
  // Astra INTEGRATED-7 P2: the key's record is ANOTHER execution's (an earlier orphan under the same key, another customer): this one is
  // recorded beside it under its own execution's key, never dropped and never written over it.
  q(`INSERT INTO cloud_ops_state (key,value) SELECT ?,? WHERE changes()=0 AND NOT EXISTS (SELECT 1 FROM billing_subscriptions WHERE home_id=? AND customer_id=?)
      AND NOT EXISTS (SELECT 1 FROM cloud_ops_state WHERE key=? AND json_valid(value) AND json_extract(value,'$.customerId') IS ?)
    ON CONFLICT(key) DO NOTHING`, customerOrphanKey(homeId, `${key}:x${now}`),
    JSON.stringify({ homeId, consentId, idempotencyKey: key, customerId, createdAt: now, recordedAt: now, reason: "binding_failed" }), homeId, customerId,
    customerOrphanKey(homeId, key), customerId),
  q(`UPDATE cloud_ops_state SET value=json_set(value,'$.role','orphan') WHERE key=? AND json_valid(value)
    AND NOT EXISTS (SELECT 1 FROM billing_subscriptions WHERE home_id=? AND customer_id=?)`, customerHomeKey(customerId), homeId, customerId),
  // A replay of the same key that DID bind (the next attempt after a lost answer) is the home's customer, not an orphan any more.
  q(`DELETE FROM cloud_ops_state WHERE key=? AND json_valid(value) AND json_extract(value,'$.customerId')=?
    AND EXISTS (SELECT 1 FROM billing_subscriptions WHERE home_id=? AND customer_id=?)`, customerOrphanKey(homeId, key), customerId, homeId, customerId),
  q("DELETE FROM cloud_ops_state WHERE key=?", `${customerCreatePrefix(homeId)}${key}`),
];
/** Astra TAXCOUNTRY-7 P2-c: the holder-recovery offer a bootstrap refusal records (`holder_move:<home>` = { customerId, country, postalCode,
 *  holds, at }): the approved retry of THAT request (a claimed step-up operation) may move exactly that customer to exactly that location,
 *  within HOLDER_MOVE_OFFER_MS. Any other request on a holder is the 409 country_mismatch_existing it always was. */
export const holderMoveKey = (homeId: string) => `holder_move:${homeId}`;
export const HOLDER_MOVE_REASON = "billing_location_on_file";
export const HOLDER_MOVE_OFFER_MS = 24 * 3_600_000;
async function holderMoveOffered(env: Env, homeId: string, customerId: string, country: string, postalCode: string | null): Promise<boolean> {
  const row = await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key=?").bind(holderMoveKey(homeId)).first<{ value: string }>();
  if (!row) return false;
  try {
    const v = JSON.parse(row.value) as { customerId?: string; country?: string; postalCode?: string | null; at?: number };
    return v.customerId === customerId && v.country === country && (v.postalCode ?? null) === normalPostal(postalCode)
      && typeof v.at === "number" && Date.now() - v.at < HOLDER_MOVE_OFFER_MS;
  } catch { return false; }
}
/** The customer's own verified move of its billing location: journaled BEFORE the call (`customer_move:<home>:<key>`: who (the step-up
 *  intent), from and to, what it holds), POST /v1/customers/{id} with the declared location as the whole address under the attempt's key
 *  `customer-move:<consent>:<lease generation>`, read back from Stripe; the offer is consumed and the journal row marked moved in one batch.
 *  Any failure is the retryable 503 of the preset (the journal row stays as the record of the attempt). */
async function moveHolderLocation(env: Env, lease: HomeLease, stripe: StripeClient, a: { homeId: string; consentId: string; customerId: string; country: string;
  postalCode: string | null; fromCountry: string | null; fromPostalCode: string | null; holds: string; intentId: string }): Promise<void> {
  const moveKey = `customer-move:${a.consentId}:${lease.generation}`;
  const journalKey = `customer_move:${a.homeId}:${moveKey}`;
  // Round 9b (Astra TAXCOUNTRY-8 P2-b): an approved move whose answer was lost may still land at Stripe and overwrite a later one. Before
  // this move is journaled, every OTHER outstanding move of the home (no movedAt, not settled) is settled first (round 10: by replay, below),
  // so no earlier request is outstanding behind this one.
  const outstanding = (await env.DB.prepare(`SELECT key,value FROM cloud_ops_state WHERE key>=? AND key<? AND key<>? AND json_valid(value)
    AND json_extract(value,'$.movedAt') IS NULL AND json_extract(value,'$.settledAt') IS NULL`)
    .bind(`customer_move:${a.homeId}:`, `customer_move:${a.homeId};`, journalKey).all<{ key: string; value: string }>()).results;
  // Round 10 (Astra TAXCOUNTRY-9 P2-b): elapsed time plus a read-back never proves an earlier move finished (Stripe documents indeterminate
  // outcomes). Every earlier outstanding move is SETTLED BY REPLAYING ITS OWN REQUEST under its own idempotency key with its journaled body:
  // Stripe answers from its cache (the original result or error) or, if the original never reached it, executes it NOW, so either way it is
  // finished before this move is sent and can never land after it. A replay that is itself indeterminate (no answer, in flight, a 5xx, a
  // rate limit) settles nothing: this move is refused (503, retryable). A move older than CUSTOMER_CREATE_REPLAY_MAX_MS (or journaled
  // without its body) can no longer be replayed safely: it is never assumed settled: this home's moves are HELD and ops alerted (high).
  for (const o of outstanding) {
    const v = JSON.parse(o.value) as { at?: number; customerId?: string; toCountry?: string; moveKey?: string; body?: string };
    const age = Date.now() - (typeof v.at === "number" ? v.at : 0);
    if (typeof v.moveKey !== "string" || typeof v.body !== "string" || age >= CUSTOMER_CREATE_REPLAY_MAX_MS) {
      await fencedBatch(env, lease, [q(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
        `alert:customer_move_unsettled:${o.key}`, a.homeId, "billing.customer_move_unsettled", "high", JSON.stringify({ journal: o.key, customerId: v.customerId ?? null,
          toCountry: v.toCountry ?? null, rule: "an earlier billing-location move of this customer can no longer be settled by replay: no later move is sent until ops confirms at Stripe what it did and marks the journal row settled" }),
        Date.now(), o.key)]);
      console.warn(JSON.stringify({ message: "checkout customer move held: an earlier move cannot be settled by replay", homeId: a.homeId, outstanding: o.key }));
      throw new HTTPError(503, "checkout_unavailable");
    }
    let outcome: "landed" | "refused";
    try { await stripe.postCustomerUpdate(v.customerId ?? a.customerId, v.body, v.moveKey); outcome = "landed"; }
    catch (e) {
      // Astra INTEGRATED-7 P2: a replay's error settles the earlier move only when it is CACHED terminal evidence, Stripe's saved answer of
      // the original execution (Idempotent-Replayed). An uncached 4xx is a fresh validation failure of THIS replay: Stripe saves no result
      // for it (docs.stripe.com/error-low-level), so the original request may still execute later; the move stays outstanding (this move is
      // refused, retryable; past the replay window it is held and alerted above) until a replay proves it or ops reconciles it.
      if (!(e instanceof StripeError) || !e.meta.replayed || e.meta.inFlight || e.status === 429 || e.status >= 500 || e.meta.type === "idempotency_error" || (e.status !== 400 && e.status !== 402 && e.status !== 404)) {
        console.warn(JSON.stringify({ message: "checkout customer move refused: an earlier move is still unsettled", homeId: a.homeId, outstanding: o.key,
          uncachedError: e instanceof StripeError && !e.meta.replayed ? e.status : null }));
        throw new HTTPError(503, "checkout_unavailable");
      }
      outcome = "refused";
    }
    await fencedRun(env, lease, "UPDATE cloud_ops_state SET value=json_set(value,'$.settledAt',?,'$.settledBy','replay','$.landed',?) WHERE key=? AND json_valid(value) AND json_extract(value,'$.movedAt') IS NULL",
      Date.now(), outcome === "landed" ? 1 : 0, o.key);
  }
  const moveBody = customerMoveBody({ country: a.country, postalCode: a.postalCode, moveKey });
  await fencedRun(env, lease, "INSERT INTO cloud_ops_state (key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING", journalKey,
    JSON.stringify({ homeId: a.homeId, customerId: a.customerId, consentId: a.consentId, by: "customer_verified", intentId: a.intentId, holds: a.holds,
      fromCountry: a.fromCountry, toCountry: a.country, postalChanged: normalPostal(a.fromPostalCode) !== normalPostal(a.postalCode), at: Date.now(), generation: lease.generation,
      moveKey, body: moveBody }));
  await fence(env, lease);
  try { await stripe.postCustomerUpdate(a.customerId, moveBody, moveKey); }
  catch (e) {
    // Astra INTEGRATED-7 P2: Stripe's own answer to THIS request refusing it (a 400/402/404 that is not in flight and not an idempotency
    // error) is terminal evidence for this execution: it can never land later. Recorded on the journal row at once, with that answer, so no
    // later move needs a replay (whose fresh validation failure would prove nothing) to settle it.
    if (dispatchRefused(e)) {
      await fencedRun(env, lease, `UPDATE cloud_ops_state SET value=json_set(value,'$.settledAt',?,'$.settledBy','answer','$.landed',0,'$.refusedWith',?)
        WHERE key=? AND json_valid(value) AND json_extract(value,'$.movedAt') IS NULL AND json_extract(value,'$.settledAt') IS NULL`,
        Date.now(), JSON.stringify({ status: (e as StripeError).status, code: (e as StripeError).message, requestId: (e as StripeError).meta.requestId ?? null }), journalKey)
        .catch(() => undefined);
    }
    throw e;
  }
  const back = await stripe.customerTaxState(a.customerId);
  if (back.country !== a.country || normalPostal(back.postalCode) !== normalPostal(a.postalCode)) throw new Error("customer_move_not_read_back");
  await fencedBatch(env, lease, [
    q("UPDATE cloud_ops_state SET value=json_set(value,'$.movedAt',?) WHERE key=? AND json_valid(value)", Date.now(), journalKey),
    q("DELETE FROM cloud_ops_state WHERE key=?", holderMoveKey(a.homeId))]);
  console.log(JSON.stringify({ message: "checkout customer moved its own billing location (verified)", homeId: a.homeId, customerId: a.customerId,
    fromCountry: a.fromCountry, toCountry: a.country }));
}
/** The switch of a rewritable home to a NEW customer created with the declared location (see prepareCheckoutCustomer):
 *  1. JOURNAL BEFORE THE CALL: `tax_customer:<home>:<key>` with the exact body (no row, no call; a journal write that fails sends nothing).
 *  2. POST /v1/customers under the attempt's idempotency key `checkout-customer:<consent>:<lease generation>`: one key per checkout attempt
 *     (a request holds one lease generation; a later request is a new attempt with a new key). THE STRIPE GUARANTEE RELIED ON
 *     (docs.stripe.com/api/idempotent_requests): a POST with an Idempotency-Key is executed at most once per key and its saved result is
 *     returned for every later request with the same key and parameters, so a replay returns the SAME customer. A refusal that proves nothing
 *     was created (dispatchRefused) deletes the row. A LOST ANSWER leaves the row outstanding and refuses (503): the customer is never blocked
 *     by it, since the NEXT attempt simply creates its own customer under its own key; the lost one, if Stripe ever executes it, is an
 *     unreferenced customer with this attempt's address (an orphan: sweepTaxDispatches records it), never a write to a customer in use.
 *  3. ONE fenced batch (lease generation): the new id on the row, the pointer moved by compare-and-set (still the old customer, still with no
 *     subscription that bills), and, only if the pointer moved, the previous-customer record, the row's deletion, the relocation marker and
 *     the diagnostic receipt. A batch that loses the lease leaves the row (with its id, or without: the sweep then learns it by replay) to
 *     become an orphan record; the pointer is unchanged.
 *  Astra TAXCOUNTRY-6: between 2 and 3 the holds-nothing reads run AGAIN (`recheck`): a credit note, a SetupIntent's card or anything else
 *  that reached the old customer while the new one was being created makes it a holder: the pointer is NOT moved, the new customer is
 *  recorded as an orphan at once (reason holder_on_recheck), and the caller refuses as for any holder. The new customer goes on the
 *  ownership ledger (customerHomeQ) in that same batch whatever happens, and so does the previous one. A bootstrap's row (`bootstrap`) is
 *  moved to the new customer in the batch, and the pointer moves only if it did (both or neither). */
async function switchCheckoutCustomer(env: Env, lease: HomeLease, stripe: StripeClient, a: { homeId: string; consentId: string; country: string;
  postalCode: string | null; from: string; fromCountry: string | null; fromName: string | null; fromEmail: string | null; fpTid: string | null;
  evidence: Record<string, unknown>; bootstrap: BootstrapBinding | null; recheck: () => Promise<string | null> }): Promise<{ created: string } | { heldBy: string }> {
  const idempotencyKey = `checkout-customer:${a.consentId}:${lease.generation}`;
  const owner = await env.DB.prepare("SELECT owner_id FROM cloud_homes WHERE id=?").bind(a.homeId).first<{ owner_id: string }>();
  const email = (owner ? await accountContactEmail(env.DB, owner.owner_id) : null) ?? a.fromEmail;
  const body = customerCreateBody({ email, name: a.fromName, homeId: a.homeId, fpTid: a.fpTid, consentId: a.consentId, attempt: idempotencyKey,
    country: a.country, postalCode: a.postalCode });
  const journalKey = `${customerCreatePrefix(a.homeId)}${idempotencyKey}`;
  const entry: CustomerCreate = { homeId: a.homeId, idempotencyKey, body, createdAt: Date.now(), generation: lease.generation, consentId: a.consentId, fromCustomerId: a.from };
  try { await fencedRun(env, lease, "INSERT INTO cloud_ops_state (key,value) VALUES (?,?)", journalKey, JSON.stringify(entry)); }
  catch (e) {
    if (e instanceof LeaseLost) throw e;
    console.error(JSON.stringify({ message: "checkout customer create not journaled: nothing sent", homeId: a.homeId, error: String(e) }));
    throw new HTTPError(503, "checkout_unavailable");
  }
  let created: string, requestId: string | null;
  try { ({ id: created, requestId } = await stripe.postCustomerCreate(body, idempotencyKey)); }
  catch (e) {
    if (dispatchRefused(e)) await fencedRun(env, lease, "DELETE FROM cloud_ops_state WHERE key=?", journalKey);
    else console.warn(JSON.stringify({ message: "checkout customer create outstanding: answer lost (the next attempt creates its own; a late landing is an orphan)",
      homeId: a.homeId, code: e instanceof StripeError ? e.code : "fetch_failed" }));
    throw e;
  }
  const learnt = [
    q("UPDATE cloud_ops_state SET value=json_set(value,'$.customerId',?,'$.requestId',?) WHERE key=? AND json_valid(value)", created, requestId, journalKey),
    customerHomeQ(created, a.homeId, "attempt", Date.now(), { attempt: idempotencyKey, consentId: a.consentId }),
    customerHomeQ(a.from, a.homeId, "previous", Date.now()),
  ];
  // The holds-nothing reads again, now that the new customer exists (a failure leaves the journal row with its id: an orphan for the sweep).
  let heldBy: string | null;
  try { heldBy = await a.recheck(); }
  catch (e) { await fencedBatch(env, lease, learnt).catch(() => undefined); throw e; }
  if (heldBy) {
    const at0 = Date.now();
    await fencedBatch(env, lease, [...learnt,
      q("INSERT INTO cloud_ops_state (key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING", customerOrphanKey(a.homeId, idempotencyKey),
        JSON.stringify({ homeId: a.homeId, consentId: a.consentId, idempotencyKey, customerId: created, createdAt: entry.createdAt, recordedAt: at0, reason: "holder_on_recheck", heldBy })),
      q("DELETE FROM cloud_ops_state WHERE key=?", journalKey)]);
    console.warn(JSON.stringify({ message: "checkout customer switch abandoned: the old customer came to hold something while the new one was created",
      homeId: a.homeId, from: a.from, orphan: created, heldBy }));
    return { heldBy };
  }
  const at = Date.now();
  const marker = await readRelocation(env, a.homeId);
  const from = [...new Set([...(marker?.from ?? []), a.from])].filter((x) => x !== created);
  const moved = "EXISTS (SELECT 1 FROM billing_subscriptions WHERE home_id=? AND customer_id=?)";
  const notLive = "NOT (subscription_id IS NOT NULL AND status IN ('active','trialing','past_due'))";
  const boot = a.bootstrap;
  const res = await fencedBatch(env, lease, [
    learnt[0],
    // The bootstrap row first (only while the pointer is still the old customer with nothing billing), then the pointer only if it moved.
    ...(boot ? [q(`UPDATE cloud_purchase_bootstraps SET stripe_customer_id=? WHERE user_id=? AND generation=? AND home_id=? AND state='open' AND stripe_customer_id=?
      AND EXISTS (SELECT 1 FROM billing_subscriptions WHERE home_id=? AND customer_id=? AND ${notLive})`, created, boot.userId, boot.generation, a.homeId, a.from, a.homeId, a.from)] : []),
    q(`UPDATE billing_subscriptions SET customer_id=?,updated_at=? WHERE home_id=? AND customer_id=? AND ${notLive}
      ${boot ? "AND EXISTS (SELECT 1 FROM cloud_purchase_bootstraps WHERE user_id=? AND generation=? AND home_id=? AND stripe_customer_id=?)" : ""}`,
    created, at, a.homeId, a.from, ...(boot ? [boot.userId, boot.generation, a.homeId, created] : [])),
    learnt[1], learnt[2],
    q(`INSERT INTO cloud_ops_state (key,value) SELECT ?,? WHERE ${moved} ON CONFLICT(key) DO NOTHING`, customerPreviousKey(a.homeId, a.from),
      JSON.stringify({ homeId: a.homeId, customerId: a.from, replacedBy: created, createRequestId: requestId, consentId: a.consentId, at, evidence: a.evidence }), a.homeId, created),
    q(`DELETE FROM cloud_ops_state WHERE key=? AND ${moved}`, journalKey, a.homeId, created),
    q(`INSERT INTO cloud_ops_state (key,value) SELECT ?,? WHERE ${moved} ON CONFLICT(key) DO UPDATE SET value=excluded.value`, taxRelocatedKey(a.homeId),
      JSON.stringify({ customerId: created, from, at }), a.homeId, created),
    q(`INSERT INTO cloud_ops_state (key,value) SELECT ?,? WHERE ${moved} ON CONFLICT(key) DO UPDATE SET value=excluded.value`, taxPresetKey(a.homeId),
      JSON.stringify({ country: a.country, at, generation: lease.generation }), a.homeId, created),
  ]);
  if (res[boot ? 2 : 1].meta.changes !== 1) {
    console.warn(JSON.stringify({ message: "checkout customer switch lost its compare-and-set: the created customer is an orphan", homeId: a.homeId }));
    throw new HTTPError(409, "checkout_superseded");
  }
  console.log(JSON.stringify({ message: "checkout customer switched to the declared location", homeId: a.homeId, from: a.from, to: created,
    fromCountry: a.fromCountry, toCountry: a.country, requestId }));
  return { created };
}
/** The first use of a journaled create's key (Astra INTEGRATED-7 P2): its own start, or the earlier first use of a key it reused. */
const createKeyAt = (d: CustomerCreate) => Math.min(typeof d.keyAt === "number" ? d.keyAt : d.createdAt, d.createdAt);
const readCreate = (value: string): CustomerCreate | null => {
  try { const d = JSON.parse(value) as CustomerCreate; return d && typeof d.body === "string" && typeof d.idempotencyKey === "string" && typeof d.homeId === "string" ? d : null; }
  catch { return null; }
};
/** The billing sweep's share: customer create journal rows older than TAX_DISPATCH_INFLIGHT_MS, due by their own backoff (nextAttemptAt,
 *  stamped before each try whatever happens), the 20 due soonest, each under its home's lease (read again there). A row that learnt its
 *  customer is recorded as an orphan at once (no Stripe call); one that did not is replayed under its own key while Stripe surely holds it
 *  (the same customer if the create ever ran; at worst a new, equally unreferenced one), else recorded with the customer unknown. A
 *  replay that fails in any way, a refusal included, leaves the row uncertain for its next try. Nothing is ever deleted at Stripe.
 *  HARD DEADLINE (Astra TAXCOUNTRY-5 P2): the run ends at min(start + TAX_DISPATCH_SWEEP_BUDGET_MS, the scheduled invocation's deadline);
 *  every Stripe call carries an AbortSignal firing then (stripeFor(signal)), and none is started with less than TAX_SWEEP_CALL_MIN_MS left. */
export async function sweepTaxDispatches(env: Env, stripeFor: (signal: AbortSignal) => StripeClient,
  onHome: (homeId: string, work: (lease: HomeLease) => Promise<void>) => Promise<void>,
  opts: { deadline?: number; budgetMs?: number; callMinMs?: number; fence?: (env: Env, lease: HomeLease) => Promise<void> } = {}): Promise<void> {
  const started = Date.now();
  const fenceLease = opts.fence ?? fence;
  const cap = Math.min(started + (opts.budgetMs ?? TAX_DISPATCH_SWEEP_BUDGET_MS), opts.deadline ?? Number.POSITIVE_INFINITY);
  const callMin = opts.callMinMs ?? TAX_SWEEP_CALL_MIN_MS;
  if (cap - started < callMin) return;
  const signal = AbortSignal.timeout(Math.max(0, cap - started));
  const stripe = stripeFor(signal);
  const due = await env.DB.prepare(`SELECT key,h,n FROM (SELECT key,CASE WHEN json_valid(value) THEN json_extract(value,'$.homeId') END AS h,
    CASE WHEN json_valid(value) THEN COALESCE(json_extract(value,'$.createdAt'),0) ELSE 0 END AS t,
    CASE WHEN json_valid(value) THEN COALESCE(json_extract(value,'$.nextAttemptAt'),0) ELSE 0 END AS na,
    CASE WHEN json_valid(value) THEN COALESCE(json_extract(value,'$.attempts'),0) ELSE 0 END AS n
    FROM cloud_ops_state WHERE substr(key,1,13)='tax_customer:') WHERE h IS NOT NULL AND t<=? AND na<=? ORDER BY na,t,key LIMIT 20`)
    .bind(started - TAX_DISPATCH_INFLIGHT_MS, started).all<{ key: string; h: string; n: number }>();
  for (const r of due.results ?? []) {
    if (cap - Date.now() < callMin) break; // the rest keep their due time for the next run
    const at = Date.now();
    await env.DB.prepare("UPDATE cloud_ops_state SET value=json_set(value,'$.attempts',?,'$.nextAttemptAt',?) WHERE key=? AND json_valid(value)")
      .bind(r.n + 1, at + TAX_DISPATCH_BACKOFF_MS[Math.min(r.n, TAX_DISPATCH_BACKOFF_MS.length - 1)], r.key).run();
    await onHome(r.h, async (lease) => {
      const row = await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key=?").bind(r.key).first<{ value: string }>();
      const d = row ? readCreate(row.value) : null;
      if (!d || Date.now() - (d.createdAt ?? 0) < TAX_DISPATCH_INFLIGHT_MS) return; // settled meanwhile (or unreadable: held for review)
      let customerId = d.customerId ?? null;
      let reason = customerId ? "switch_not_committed" : "answer_lost";
      // Astra INTEGRATED-7 P2: the window runs from the KEY's first use (a reused key keeps it), never from this execution's start.
      if (!customerId && Date.now() - createKeyAt(d) < CUSTOMER_CREATE_REPLAY_MAX_MS) {
        if (cap - Date.now() < callMin) return; // never started without the time to finish: the next run (its backoff is stamped)
        await fenceLease(env, lease);
        // Astra TAXCOUNTRY-6 P3: the fence is awaited (a lease renewal, D1): the headroom is checked AGAIN after it, so a call is never
        // started with less than callMin left whatever the fence cost.
        if (cap - Date.now() < callMin) return;
        // Any failure keeps the row UNCERTAIN, a refusal included (C2 review): a refused replay proves only that THIS request did not run,
        // not what the original did; the row waits for its next try and, past CUSTOMER_CREATE_REPLAY_MAX_MS, is recorded with the customer
        // unknown (in flight, a cached 5xx, aborted at the cap alike).
        customerId = (await stripe.postCustomerCreate(d.body, d.idempotencyKey)).id;
      } else if (!customerId) reason = "key_expired_customer_unknown";
      // The pointer is this customer (its switch committed with the row kept): nothing to record.
      const pointer = customerId ? await env.DB.prepare("SELECT 1 AS x FROM billing_subscriptions WHERE home_id=? AND customer_id=?").bind(d.homeId, customerId).first() : null;
      // Astra INTEGRATED-7 P2: the record keeps this execution's permanent identity (its key, the key's first use, its exact body: a later
      // attempt may replay the key only inside the window from that first use) and NEVER overwrites another execution's record: a record
      // already under this key is another execution's (the journal row is deleted in this same batch, so one execution is recorded once),
      // and this one goes beside it under `<key>:x<createdAt>`.
      const record = JSON.stringify({ homeId: d.homeId, consentId: d.consentId, idempotencyKey: d.idempotencyKey, customerId, createdAt: d.createdAt,
        keyAt: createKeyAt(d), body: d.body, recordedAt: Date.now(), reason });
      await fencedBatch(env, lease, [
        ...(pointer ? [] : [q("INSERT INTO cloud_ops_state (key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING", customerOrphanKey(d.homeId, d.idempotencyKey), record),
          q("INSERT INTO cloud_ops_state (key,value) SELECT ?,? WHERE changes()=0 ON CONFLICT(key) DO NOTHING", customerOrphanKey(d.homeId, `${d.idempotencyKey}:x${d.createdAt}`), record)]),
        ...(customerId ? [customerHomeQ(customerId, d.homeId, pointer ? "attempt" : "orphan", Date.now(), { attempt: d.idempotencyKey, consentId: d.consentId })] : []),
        q("DELETE FROM cloud_ops_state WHERE key=?", r.key)]);
      if (!pointer) console.warn(JSON.stringify({ message: "checkout customer orphan recorded for manual cleanup (never deleted automatically)", homeId: d.homeId, customerId, reason }));
    });
  }
}
/** A saved step-up attempt whose session was made before the customer was moved (Astra TAXCOUNTRY-3 P2/#6): it is closed as 'relocated'
 *  (its session expired at Stripe, its issuance marker settled, the consent keeping the price it was sold at) and the caller continues as
 *  /checkout/resume does: a fresh session for the same consent on the moved customer, in the same request and on every later press. */
export class RelocatedAttempt extends Error { constructor() { super("relocated_attempt"); } }
type SessionInput = Parameters<ReturnType<typeof stripeClient>["createCheckoutSession"]>[0];
export interface CheckoutAttempt { id?: string; consent_id: string; expires_at: number; payload: string; state: string;
  stripe_price_id: string | null; idempotency_key: string | null; session_id?: string | null }
/** Stripe creates a Checkout session only with an expiry at least 30 minutes after that creation (checkout.sessions.create expires_at):
 *  a saved attempt is dispatched again only while its fixed expiry is still that far away, with a minute of margin (Astra STEPUP-EMAIL-7
 *  #3). Past that, only the ORIGINAL operation can exist, and it is reconciled by listing, never re-created. */
export const STRIPE_MIN_SESSION_WINDOW_MS = 31 * 60_000;
/** A Stripe refusal that PROVES its key created nothing: the request is invalid (an expiry too close, a parameter) or the key is
 *  permanently bound to other parameters (idempotency_error), first-hand or replayed from Stripe's cache. Never a request still in flight
 *  (409 idempotency_key_in_use), a rate limit, an authentication fault or an outage, and never a REPLAYED 5xx: Stripe documents a cached
 *  server error as indeterminate (its incident reconciliation can still create the object), see indeterminateStripeOutcome (Astra
 *  STEPUP-EMAIL-8 #2). */
export function terminalStripeRefusal(e: unknown): boolean {
  if (!(e instanceof StripeError) || e.meta.inFlight) return false;
  return e.status === 400 || e.status === 402 || e.status === 404 || e.status === 409;
}
/** A cached (Idempotent-Replayed) Stripe 5xx: the key's outcome is unknown and can stay unknown. Retrying the key replays the same 500, so
 *  the attempt is reconciled through confirmed objects instead (its sessions listed by consent, checkout.session webhooks), and it is never
 *  abandoned on an empty listing before its own expiry plus STRIPE_ATTEMPT_GRACE_MS. */
export function indeterminateStripeOutcome(e: unknown): boolean {
  return e instanceof StripeError && e.meta.replayed === true && e.status >= 500;
}
/** How long after a saved attempt's own session expiry an empty listing is accepted as proof that its key created nothing: any session
 *  its key could still produce would be past its expiry (never payable), and the webhooks of a late one have had time to arrive. */
export const STRIPE_ATTEMPT_GRACE_MS = 60 * 60_000;
/** The 409 a proven no-session attempt ends with: its consent is spent, the member gives a fresh one (the site runs the normal checkout on
 *  consent_stale, members-api.ts); `restart` says so explicitly. Never a 502 loop, never a substituted key. */
const consentRestart = () => new HTTPError(409, "consent_stale", { restart: "checkout" });
/** A step-up checkout attempt saved before its dispatch and never recorded (still 'creating'), for this home's open order: what a later
 *  /checkout/resume recovers FIRST, before any consent staleness check (Astra STEPUP-EMAIL-6 #3). Only attempts with their original key. */
export async function savedStepUpCheckout(env: Env, homeId: string, consentId: string): Promise<(CheckoutAttempt & { id: string }) | null> {
  return env.DB.prepare(`SELECT id,consent_id,expires_at,payload,state,stripe_price_id,idempotency_key,session_id FROM checkout_resume_attempts
    WHERE home_id=? AND consent_id=? AND state='creating' AND id LIKE 'stepup-checkout:%' AND idempotency_key IS NOT NULL
    ORDER BY created_at DESC LIMIT 1`).bind(homeId, consentId).first<CheckoutAttempt & { id: string }>();
}
/** True when an attempt of this consent, of ANY family (a step-up checkout `stepup-checkout:` or a /checkout/resume replacement), was
 *  abandoned with no session (proven to have created none): the consent is spent and only a fresh one can buy (Astra STEPUP-EMAIL-7 #3,
 *  9 #3). /checkout/resume then answers the same actionable 409, never another session under a new key. (A pre-2026-10-14 replacement
 *  attempt retired by resumeAttempt also counts: its consent predates the Stripe-page provenance and is never reusable anyway.) */
export async function checkoutAttemptAbandoned(env: Env, homeId: string, consentId: string): Promise<boolean> {
  return (await env.DB.prepare(`SELECT 1 AS x FROM checkout_resume_attempts WHERE home_id=? AND consent_id=? AND state='abandoned' AND session_id IS NULL
    LIMIT 1`).bind(homeId, consentId).first()) !== null;
}
export const stepUpConsentRestart = () => consentRestart();
/** The ORIGINAL operation of a saved checkout attempt (a step-up attempt, or a /checkout/resume replacement), found by its own order: this
 *  customer's sessions carrying its consent and home (and, for a replacement, its own fixed expiry, since earlier sessions of the same consent
 *  exist), when it may not be dispatched again (past Stripe's creation window, a terminal refusal of its key, or a replayed 5xx).
 *  - one open session: returned, to be recorded under the attempt (never another key);
 *  - one finished session: the attempt is closed with it and that session is returned as `closed` (the caller answers 409 or moves on);
 *  - two: 409 checkout_superseded, adopting neither;
 *  - none: PROOF that the key created nothing only after a proven terminal refusal (`proven`), or once the attempt's own expiry plus
 *    STRIPE_ATTEMPT_GRACE_MS has passed. Then the attempt is abandoned (never dispatched again, under any key) and the member is asked for a
 *    fresh consent (409 consent_stale, restart). Before that the attempt stays UNRESOLVED ('creating'): 409 checkout_in_progress, no restart,
 *    no replacement (Astra STEPUP-EMAIL-8 #2); a later listing or the checkout.session webhook (settleCheckoutAttempt) resolves it.
 *  A listing that cannot be completed throws (StripeError: a retryable 502, the attempt untouched). */
export async function reconcileCheckoutAttempt(env: Env, lease: HomeLease, stripe: ReturnType<typeof stripeClient>,
  a: { homeId: string; attemptId: string; consentId: string; customerId: string; expiresAt: number; proven: boolean; matchExpiry: boolean },
  now: number): Promise<{ id: string; url: string } | { closed: string; status: string | null }> {
  const expirySeconds = Math.floor(a.expiresAt / 1000);
  const original = (await stripe.listAllCheckoutSessions(a.customerId))
    .filter((s) => s.metadata?.consent_id === a.consentId && (s.metadata?.home_id ?? a.homeId) === a.homeId && (!a.matchExpiry || s.expires_at === expirySeconds));
  if (original.length > 1) throw new HTTPError(409, "checkout_superseded");
  if (original.length === 0) {
    if (!a.proven && now < a.expiresAt + STRIPE_ATTEMPT_GRACE_MS) {
      console.log(JSON.stringify({ message: "checkout attempt unresolved: no session yet", homeId: a.homeId }));
      throw new HTTPError(409, "checkout_in_progress");
    }
    // Astra INTEGRATED-2 #3: proven empty, so the attempt's own issuance marker (its key) and the home's unresolved-checkout alert settle in
    // the SAME batch as the abandonment: a deletion waiting on that marker can finish, and nothing is left for the marker sweep to keep.
    await fencedBatch(env, lease, provenEmptyQs(a.consentId, a.attemptId, now));
    console.log(JSON.stringify({ message: "checkout attempt abandoned: no session", homeId: a.homeId }));
    throw consentRestart();
  }
  const found = original[0];
  if (found.status !== "open" || !found.url) {
    await fencedRun(env, lease, "UPDATE checkout_resume_attempts SET state='abandoned',session_id=? WHERE id=?", found.id, a.attemptId);
    return { closed: found.id, status: found.status };
  }
  console.log(JSON.stringify({ message: "checkout attempt reconciled", homeId: a.homeId }));
  return { id: found.id, url: found.url };
}
/** Astra INTEGRATED-2 #3 (RULE B): a session request PROVEN to have created no session (a complete listing of the customer's sessions shows
 *  none of it past its expiry plus STRIPE_ATTEMPT_GRACE_MS, or a terminal refusal of its key): its saved attempt is abandoned, its issuance
 *  marker (the attempt's own key) settled and the home's unresolved-checkout alert reconciled, in ONE batch. Never a consent whose contract
 *  was made. */
/** Astra INTEGRATED-3 #4: a saved attempt's issuance identity (the key its session request was sent under): its idempotency_key, or, for a
 *  /checkout/resume attempt written before resume persisted that column, the issuance id saved in its own request, accepted only when it is
 *  that attempt's own (`resume:<attempt id>`, the identity resumeAttempt validates before any replay). SQL over an attempt row alias. */
export const attemptKeySql = (a: string) => `COALESCE(${a}.idempotency_key, CASE WHEN ${a}.id NOT LIKE 'stepup-checkout:%' AND json_valid(${a}.payload)
  AND json_extract(${a}.payload,'$.issuanceId')='resume:'||${a}.id THEN 'resume:'||${a}.id END)`;
export function provenEmptyQs(consentId: string, attemptId: string, now: number): Q[] {
  return [
    q(`UPDATE checkout_consents SET session_inflight_at=NULL,session_issuance_id=NULL WHERE id=? AND contract_made_at IS NULL
      AND session_issuance_id=(SELECT ${attemptKeySql("ra")} FROM checkout_resume_attempts ra WHERE ra.id=? AND ra.consent_id=?)`, consentId, attemptId, consentId),
    q("UPDATE checkout_resume_attempts SET state='abandoned' WHERE id=? AND state='creating'", attemptId),
    checkoutAlertSyncQ(consentId, now)];
}
/** RULE B, used by a Delete's hold completion: every saved attempt of the home still 'creating' past its expiry plus the grace period is
 *  reconciled by its own order (proven empty settles it with its marker, provenEmptyQs). A failure leaves it for the sweep. */
export async function reconcileHomeAttempts(env: Env, lease: HomeLease, stripe: ReturnType<typeof stripeClient>, homeId: string, now: number): Promise<void> {
  const rows = (await env.DB.prepare("SELECT id,consent_id,expires_at,payload FROM checkout_resume_attempts WHERE home_id=? AND state='creating' ORDER BY created_at")
    .bind(homeId).all<{ id: string; consent_id: string; expires_at: number; payload: string }>()).results ?? [];
  for (const a of rows) {
    if (now < a.expires_at + STRIPE_ATTEMPT_GRACE_MS) continue;
    let customerId: unknown = null;
    try { customerId = (JSON.parse(a.payload) as { customerId?: unknown }).customerId; } catch { customerId = null; }
    if (typeof customerId !== "string" || !customerId) continue;
    try { await reconcileCheckoutAttempt(env, lease, stripe, { homeId, attemptId: a.id, consentId: a.consent_id, customerId, expiresAt: a.expires_at, proven: false, matchExpiry: true }, now); }
    catch (e) { if (e instanceof LeaseLost) throw e; /* consent_stale is the proven-empty answer; anything else waits for the sweep */ }
  }
}
/** Before ANY new order replaces this home's open one (Astra STEPUP-EMAIL-9 #2): every saved attempt of the home still 'creating', of any
 *  family and any consent, must be resolved first, under this lease. Before its own expiry plus STRIPE_ATTEMPT_GRACE_MS it is never
 *  touched: 409 checkout_in_progress (an indeterminate attempt is never abandoned early, and no other provider operation starts beside it).
 *  Past that it is reconciled by its own order: no session (abandoned, its consent spent) or a finished one lets the new order go on; a
 *  completed payment is 409 checkout_completed; one still open stays 409 checkout_in_progress. A listing that fails is a retryable 502. */
async function assertNoUnresolvedAttempt(env: Env, lease: HomeLease, stripe: ReturnType<typeof stripeClient>, homeId: string, now: number): Promise<void> {
  const rows = (await env.DB.prepare("SELECT id,consent_id,expires_at,payload FROM checkout_resume_attempts WHERE home_id=? AND state='creating' ORDER BY created_at")
    .bind(homeId).all<{ id: string; consent_id: string; expires_at: number; payload: string }>()).results ?? [];
  for (const a of rows) {
    if (now < a.expires_at + STRIPE_ATTEMPT_GRACE_MS) throw new HTTPError(409, "checkout_in_progress");
    let customerId: unknown = null;
    try { customerId = (JSON.parse(a.payload) as { customerId?: unknown }).customerId; } catch { customerId = null; }
    if (typeof customerId !== "string" || !customerId) throw new HTTPError(409, "checkout_in_progress");
    try {
      const r = await reconcileCheckoutAttempt(env, lease, stripe, { homeId, attemptId: a.id, consentId: a.consent_id, customerId, expiresAt: a.expires_at,
        proven: false, matchExpiry: true }, now);
      if (!("closed" in r)) throw new HTTPError(409, "checkout_in_progress");
      if (r.status === "complete") throw new HTTPError(409, "checkout_completed");
    } catch (e) {
      if (e instanceof HTTPError && e.code === "consent_stale") continue; // proven empty and abandoned: that consent is spent, not this one
      if (e instanceof StripeError) throw new HTTPError(502, "stripe_unavailable");
      throw e;
    }
  }
}
/** A step-up attempt's reconciliation: a finished original closes it with 409 checkout_completed / checkout_expired. */
async function reconcileStepUpAttempt(env: Env, lease: HomeLease, stripe: ReturnType<typeof stripeClient>,
  a: Parameters<typeof reconcileCheckoutAttempt>[3], now: number): Promise<{ id: string; url: string }> {
  const r = await reconcileCheckoutAttempt(env, lease, stripe, a, now);
  if ("closed" in r) throw new HTTPError(409, r.status === "complete" ? "checkout_completed" : "checkout_expired");
  return r;
}
/** A checkout.session.completed / .expired webhook resolves the saved attempt that created that session (its consent and its own fixed
 *  expiry), whatever its key last answered: completed is 'done', expired is 'abandoned' with the session. Only an unresolved attempt. */
export async function settleCheckoutAttempt(env: Env, lease: HomeLease, homeId: string, session: { id: string | null; consentId: string | null;
  expiresAtSeconds: number | null; completed: boolean }): Promise<void> {
  if (!session.id || !session.consentId || session.expiresAtSeconds === null) return;
  await fencedRun(env, lease, `UPDATE checkout_resume_attempts SET state=?,session_id=? WHERE home_id=? AND consent_id=? AND state='creating'
    AND expires_at/1000=?`, session.completed ? "done" : "abandoned", session.id, homeId, session.consentId, session.expiresAtSeconds);
}
/** The exact retry of an interrupted step-up checkout (see createCheckoutLeased): the attempt's identical request under the identical key,
 *  so Stripe returns the session the interrupted run created (the orphan), recorded now in the batch that commits the operation. A
 *  session that is no longer open is never offered: the attempt is closed (409). Runs under the operation's held billing lease. */
export async function replayCheckoutAttempt(env: Env, lease: HomeLease, stripe: ReturnType<typeof stripeClient>, homeId: string, attemptId: string,
  prior: CheckoutAttempt, now: number): Promise<Response> {
  // An attempt already proven to have no session (abandoned below) asks for a fresh consent, every time.
  if (prior.state === "abandoned" && !prior.session_id) throw consentRestart();
  // An attempt closed because its session was made before the customer moved: the caller issues a fresh session (Astra TAXCOUNTRY-3 #6).
  if (prior.state === "relocated") {
    await fencedRun(env, lease, "UPDATE open_checkouts SET state='failed',updated_at=? WHERE home_id=? AND consent_id=? AND state='creating'", now, homeId, prior.consent_id);
    throw new RelocatedAttempt();
  }
  if (prior.state !== "creating") throw new HTTPError(409, "checkout_superseded");
  const input = JSON.parse(prior.payload) as SessionInput;
  // The attempt is replayed only as it was saved: its own home, consent and price, under its original key (never a substitute).
  if (!prior.idempotency_key || prior.idempotency_key !== `checkout:${prior.consent_id}` || !prior.stripe_price_id
    || input.priceId !== prior.stripe_price_id || input.consentId !== prior.consent_id || input.homeId !== homeId) throw new HTTPError(409, "checkout_superseded");
  const open = await env.DB.prepare("SELECT * FROM open_checkouts WHERE home_id=?").bind(homeId).first<OpenCheckout>();
  // The claim re-checked the order under this lease (its consent and fingerprint are the target): it is still this attempt's.
  if (!open || open.consent_id !== prior.consent_id || open.state === "completed" || open.state === "open") throw new HTTPError(409, "checkout_superseded");
  if (open.state !== "creating" && await fencedRun(env, lease, "UPDATE open_checkouts SET state='creating',updated_at=? WHERE home_id=? AND consent_id=? AND state=?",
    now, homeId, prior.consent_id, open.state) !== 1) throw new HTTPError(409, "checkout_in_progress");
  try {
    await fence(env, lease);
    // The frozen request names the customer of its time, whose address is NOT frozen: the same required preset runs before ANY session is
    // handed back, whatever the attempt's remaining time (Astra TAXCOUNTRY-1 P2, TAXCOUNTRY-2 P2, TAXCOUNTRY-3 P1).
    // `stale`: the home's durable relocation marker stands, so any session made before this request (a replayed or reconciled one) was made
    // before the customer moved.
    const pc = await getConsent(env, prior.consent_id);
    if (!pc) throw new HTTPError(409, "checkout_superseded");
    const prepared = await prepareCheckoutCustomer(env, lease, stripe, { homeId, consentId: prior.consent_id,
      country: pc.billing_country, postalCode: pc.postal_code ?? null });
    // Astra TAXCOUNTRY-5: the frozen request names the customer of its time. Not the pointer any more (the home was moved to a new customer
    // since): any session it yields was made on a customer switched away from, so it is treated exactly like one made before a move.
    const onPrevious = input.customerId !== prepared.customerId;
    const stale = prepared.stale || onPrevious;
    await journalDispatch(env, `checkout:${homeId}`);
    // Dispatched again under the ORIGINAL key only while Stripe could still create the session (its fixed expiry at least 30 minutes
    // away); a terminal refusal of that replay (an invalid request, a permanent idempotency conflict) and an attempt past that window are
    // RECONCILED instead: the original operation is looked up by its own order (this customer's sessions carrying this consent and home).
    // A transient failure stays a retryable 502 with the attempt untouched (Astra STEPUP-EMAIL-7 #3).
    // A replayed 5xx is indeterminate: reconciled too, but an empty listing then leaves the attempt unresolved until its expiry plus the
    // grace period (Astra STEPUP-EMAIL-8 #2).
    let session: { id: string; url: string; replayed?: boolean } | null = null, proven = false;
    if (prior.expires_at - now >= STRIPE_MIN_SESSION_WINDOW_MS) {
      try { session = await stripe.createCheckoutSession(input, prior.idempotency_key); }
      catch (e) { if (!terminalStripeRefusal(e) && !indeterminateStripeOutcome(e)) throw e; proven = terminalStripeRefusal(e); }
    }
    // A session this request's dispatch created is newer than the preset; a replayed or reconciled one was made EARLIER, and so is any
    // session on a customer the home was switched away from.
    const earlier = session === null || session.replayed === true || onPrevious;
    if (session === null) {
      const original = { homeId, attemptId, consentId: prior.consent_id, customerId: input.customerId, expiresAt: prior.expires_at, proven, matchExpiry: false };
      if (stale) {
        // Its original (expired by the relocation sweep) is found by its own order, then closed as relocated below; a completed one is a payment.
        const found = await reconcileCheckoutAttempt(env, lease, stripe, original, now);
        if ("closed" in found && found.status === "complete") throw new HTTPError(409, "checkout_completed");
        session = "closed" in found ? { id: found.closed, url: "" } : found;
      } else session = await reconcileStepUpAttempt(env, lease, stripe, original, now);
    }
    // Astra TAXCOUNTRY-3 P2-a/#6: a session made before the customer moved is never handed back, and never a dead end: it is expired
    // (confirmed at Stripe), the attempt closed as 'relocated' with it (the consent keeps the price it was sold at, its issuance marker is
    // settled) and the caller issues a fresh session for the same consent, as Finish checkout does.
    if (stale && earlier) {
      await expireConfirmed(env, lease, stripe, session.id);
      await fencedBatch(env, lease, [q("UPDATE checkout_resume_attempts SET state='relocated',session_id=? WHERE id=?", session.id, attemptId),
        q(`UPDATE checkout_consents SET session_inflight_at=NULL,session_issuance_id=NULL WHERE id=? AND session_issuance_id=? AND contract_made_at IS NULL`,
          prior.consent_id, prior.idempotency_key),
        q("UPDATE checkout_consents SET stripe_price_id=COALESCE(stripe_price_id,?) WHERE id=? AND contract_made_at IS NULL", prior.stripe_price_id, prior.consent_id),
        checkoutAlertSyncQ(prior.consent_id, now)]);
      console.warn(JSON.stringify({ message: "step-up checkout session made before the tax relocation expired", homeId, sessionId: session.id }));
      throw new RelocatedAttempt();
    }
    const live = await stripe.retrieveEventObject("checkout_session", session.id);
    if (live.status !== "open") {
      // Astra INTEGRATED-1 #1: an EXPIRED session settles its own issuance marker (and the alert) with the attempt, as the expiry webhook would.
      // Astra INTEGRATED-2 #4: a COMPLETE one does not: its payment may still be processing, so the marker (CHECKOUT_MAY_SETTLE_SQL) stays
      // until the completion and payment, or the order's rejection, are recorded (the completion webhook, the marker sweep's completeSettles).
      const expired = live.status === "expired";
      await fencedBatch(env, lease, [q("UPDATE checkout_resume_attempts SET state=?,session_id=? WHERE id=?", expired ? "abandoned" : "done", session.id, attemptId),
        ...(expired ? [q(`UPDATE checkout_consents SET session_inflight_at=NULL,session_issuance_id=NULL WHERE id=? AND session_issuance_id=? AND contract_made_at IS NULL`,
          prior.consent_id, prior.idempotency_key), checkoutAlertSyncQ(prior.consent_id, now)] : [])]);
      throw new HTTPError(409, live.status === "complete" ? "checkout_completed" : "checkout_expired");
    }
    const owned = await fencedBatch(env, lease, [
      q("UPDATE open_checkouts SET state='open',session_id=?,session_url=?,expires_at=?,updated_at=? WHERE home_id=? AND consent_id=? AND state='creating'",
        session.id, session.url, prior.expires_at, now, homeId, prior.consent_id),
      ...[commitQ(env, `checkout:${homeId}`)].filter((x): x is Q => x !== null),
      q("UPDATE checkout_consents SET stripe_session_id=?,stripe_price_id=?,session_expired_at=NULL WHERE id=?", session.id, input.priceId, prior.consent_id),
      // Astra INTEGRATED-1 #1: publication settles the issuance marker of exactly this request (its original key) and reconciles the alert,
      // as normal checkout does, so the marker sweep never expires the session it just published.
      q(`UPDATE checkout_consents SET session_inflight_at=NULL,session_issuance_id=NULL WHERE id=? AND session_issuance_id=?
        AND EXISTS (SELECT 1 FROM open_checkouts WHERE home_id=? AND session_id=? AND state='open')`, prior.consent_id, prior.idempotency_key, homeId, session.id),
      checkoutAlertSyncQ(prior.consent_id, now),
      q("UPDATE checkout_resume_attempts SET state='done',session_id=? WHERE id=?", session.id, attemptId),
      relocationClearedQ(homeId, session.id),
    ]);
    if (owned[0].meta.changes !== 1) {
      try { await stripe.expireCheckoutSession(session.id); } catch { /* a completion is caught by the duplicate claim */ }
      throw new HTTPError(409, "checkout_superseded");
    }
    const c = await getConsent(env, prior.consent_id);
    console.log(JSON.stringify({ message: "step-up checkout attempt replayed", homeId }));
    return json({ sessionId: session.id, url: session.url, consentId: prior.consent_id, locale: c?.checkout_language ?? input.locale,
      policyVersion: c?.policy_version ?? null });
  } catch (e) {
    try { await fencedRun(env, lease, "UPDATE open_checkouts SET state='failed',updated_at=? WHERE home_id=? AND consent_id=? AND state='creating'", now, homeId, prior.consent_id); }
    catch (e2) { if (!(e2 instanceof LeaseLost)) throw e2; }
    if (e instanceof StripeError) throw new HTTPError(502, "stripe_unavailable");
    throw e;
  }
}
/** What an invoice pays for, from its normalized lines (never from billing_reason, never from line order).
 *  renewal: exactly one regular (non-proration) subscription-item line of OUR subscription with one of our prices: a full period.
 *  adjustment: no such line, only prorations (subscription or invoice-item, any source): never a full grant, never a period move.
 *    `debit` is the positive plan line (pinned by `target` when an operation names it), `credit` the price of the negative one.
 *  "ambiguous": more than one candidate that nothing pins (the event is retried and ops see it). null: none of our prices. */
/** Every line of an invoice: the webhook's copy when complete, else all pages from Stripe (a failure throws: the event is retried). */
async function completeLines(inv: InvoiceView, invoiceId: string, stripe: () => StripeClient): Promise<InvoiceLineView[]> {
  return inv.lines.has_more ? stripe().listInvoiceLines(invoiceId) : inv.lines.data;
}
export type InvoiceClass = { kind: "renewal"; line: InvoiceLineView } | { kind: "adjustment"; debit: InvoiceLineView | null; credit: string | null };
export function classifyInvoice(lines: InvoiceLineView[], config: BillingConfig, subscriptionId: string | null, target: string | null): InvoiceClass | "ambiguous" | null {
  const ours = lines.filter((l) => config.planByPrice.has(l.price ?? "") && (l.subscription === null || subscriptionId === null || l.subscription === subscriptionId));
  if (!ours.length) return null;
  const regular = ours.filter((l) => !l.proration && l.source !== "invoice_item");
  if (regular.length === 1) return { kind: "renewal", line: regular[0] };
  if (regular.length > 1) {
    const pinned = target ? regular.filter((l) => l.price === target) : [];
    return pinned.length === 1 ? { kind: "renewal", line: pinned[0] } : "ambiguous";
  }
  const credit = ours.find((l) => (l.amount ?? 0) < 0)?.price ?? null;
  const debits = ours.filter((l) => (l.amount ?? 0) > 0);
  const pinned = target ? debits.filter((l) => l.price === target) : [];
  if (pinned.length === 1) return { kind: "adjustment", debit: pinned[0], credit };
  if (new Set(debits.map((l) => l.price)).size > 1) return "ambiguous";
  return { kind: "adjustment", debit: debits[0] ?? null, credit };
}
interface OpenCheckout { home_id: string; consent_id: string; fingerprint: string; state: string; session_id: string | null; session_url: string | null;
  expires_at: number | null; created_at: number; updated_at: number }
export const CHECKOUT_SESSION_TTL_MS = 60 * 60_000;
const sha256Hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
  .map((b) => b.toString(16).padStart(2, "0")).join("");

/** The portal calls this when a signed-in customer picks a plan, so checkout has a payable home. SIGN-IN ONLY (purchase-bootstrap.ts
 *  rule: one purchase = at most one emailed code, asked at checkout): a fresh account claims the first-purchase bootstrap as before; any
 *  other account gets its one payable home (or 409 home_exists, or its replacement home) with no step-up. Reserving moves no money.
 *  User-scoped (never takes a user or home id from the body). One pending reservation per user; unpaid ones lapse. */
export async function reserveHomeRoute(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  if (!b3Enabled(env)) throw new HTTPError(404, "not_found");
  const user = await (deps.accountUser ?? (async (r, a) => (await accountSession(r, a))?.user ?? null))(request, auth);
  if (!user) throw new HTTPError(401, "unauthorized");
  const authority = await purchaseAuthority(deps, env, request, auth, user.id, null);
  // A bootstrap that does not apply after all (another session's, settlement unproven, the protect-set not empty, or issuance expired while its
  // abandonment is unproven: bootstrap_expired, Astra STEPUP-EMAIL-10 #1) falls back to the sign-in-only reservation below: reserve never answers
  // step_up_required or bootstrap_expired (no approval exists for it, so that refusal would be a dead end). The fallback claims nothing: the
  // bootstrap row, its generation and its home stay as they are, and an unresolved attempt is never reclaimed.
  if (authority && authority !== "trusted") {
    try { return await reserveBootstrap(env, deps, authority, (deps.now ?? Date.now)()); }
    catch (e) { if (!(e instanceof HTTPError && (e.code === "step_up_required" || e.code === "bootstrap_expired"))) throw e; }
  }
  // A valid address-change route: the "reservation" is the home the customer already runs; its plan is replaced, nothing new is reserved (WP6).
  const replacement = await replacementHomeFor(env, user.id, (deps.now ?? Date.now)());
  if (replacement) return json({ homeId: replacement.id, state: "replacement", expiresAt: null, existing: true, replacement: true });
  return reserveHomeForUser(env, user.id);
}

/** Reserve on the sign-in alone (purchase-bootstrap.ts): the same session's live reservation again, or the claim in the home's own batch, or,
 *  once the account's only attempt is proven abandoned, ONE more generation by compare-and-swap. Anything else: 403. */
async function reserveBootstrap(env: Env, deps: BillingDependencies, g: BootstrapGrant, now: number): Promise<Response> {
  let row = g.row;
  if (row?.state === "open" && row.issue_until > now) {
    // A retry from the reserving session before expiry returns the original reservation; nothing new is allocated. The protect-set is
    // checked again in the statement that reads it (only this operation's own records; Astra TRUSTCODE-2 P3-4).
    if (row.session_id !== g.sessionId) throw stepUpRefused();
    const free = protectSetEmpty(g.userId, { homeId: row.home_id, customerId: row.stripe_customer_id });
    const h = await env.DB.prepare(`SELECT id,reservation_expires_at FROM cloud_homes WHERE id=? AND owner_id=? AND desired_state='payment_pending' AND ${free.sql}`)
      .bind(row.home_id, g.userId, ...free.binds).first<{ id: string; reservation_expires_at: number | null }>();
    if (!h) throw stepUpRefused();
    return json({ homeId: h.id, state: "payment_pending", expiresAt: h.reservation_expires_at, existing: true, bootstrap: true });
  }
  // Abandoned? ONE reconciliation (purchase-bootstrap.ts reconcileAbandonment, shared with the webhook), under the home's billing lease so it is
  // serialized with issuance, over every page of the customer's sessions. An open row past issue_until expires only when it holds.
  let release = false;
  if (row && (row.state === "open" || row.state === "expired")) {
    const r = row;
    let terminal: boolean;
    try {
      terminal = await withHomeLease(env, r.home_id, (lease) => reconcileAbandonment(env, lease, r, now, stripeClient(cfg(env), deps.stripeFetch)), deps.lease);
    } catch (e) {
      if (r.state === "open") {
        if (e instanceof StripeError) throw new HTTPError(502, "stripe_unavailable");
        if (e instanceof HomeBusy || e instanceof LeaseLost) throw new HTTPError(409, "home_busy");
        throw e;
      }
      // Already expired, but settlement cannot be confirmed now: no early release (the 25-hour delay applies).
      if (!(e instanceof StripeError || e instanceof HomeBusy || e instanceof LeaseLost)) throw e;
      terminal = false;
    }
    if (r.state === "open" && !terminal) throw bootstrapExpired();
    // Every session terminal and nothing in flight: that generation's unused reservation is released now (P2-3).
    release = terminal;
    row = await getBootstrap(env, g.userId);
  }
  if (row && row.state !== "expired") throw stepUpRefused();
  const res = await reserveHomeForUser(env, g.userId, { sessionId: g.sessionId, now, expected: row?.generation ?? null,
    release: release && row ? row.home_id : null });
  if (res.status !== 201) return res; // 202 waitlisted: nothing was claimed
  return json({ ...await res.json() as Record<string, unknown>, bootstrap: true }, 201);
}

export async function createPortal(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  const config = cfg(env);
  const parsed = await readJSON(request, portalSchema);
  const input = { homeId: (await actor(request, env, deps, auth, parsed.homeId, "subscribed")).homeId };
  const sub = await getSub(env, input.homeId);
  if (!sub) throw new HTTPError(404, "not_found");
  try {
    const stripe = stripeClient(config, deps.stripeFetch);
    // Pinned: the portal configuration it opens (STRIPE_PORTAL_CONFIGURATION, else the account default) must have plan switching OFF, read
    // from Stripe on every open. Plan changes go through /v1/account/plan only (upgrade with a resize; no downgrade). Fails closed.
    const conf = await stripe.getPortalConfiguration(config.portalConfiguration);
    if (conf.features?.subscription_update?.enabled !== false || typeof conf.id !== "string" || !conf.id
      || (config.portalConfiguration !== null && conf.id !== config.portalConfiguration)) {
      await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
        .bind(crypto.randomUUID(), input.homeId, "billing.portal_allows_plan_switch", "high", JSON.stringify({ configuration: conf.id ?? config.portalConfiguration }), Date.now()).run();
      throw new HTTPError(503, "portal_misconfigured");
    }
    // The session opens on exactly the configuration just verified (never "the default", which can change in between). A step-up
    // operation journals the dispatch first (a superseded runner stops here and never discloses a URL).
    await journalDispatch(env, `portal:${input.homeId}`);
    const session = await stripe.createPortalSession({ customerId: sub.customer_id,
      returnUrl: `${config.returnOrigin}${CLOUD_MEMBERS_PATH}`, configuration: conf.id });
    return json({ url: session.url });
  } catch (e) {
    if (e instanceof StripeError) throw new HTTPError(502, "stripe_unavailable");
    throw e;
  }
}

/** A home-side archiver (or an operator) reports that a restorable copy of the data volume exists. */
export async function recordSnapshotReceipt(request: Request, env: Env): Promise<Response> {
  await admin(request, env);
  const input = await readJSON(request, receiptSchema);
  await env.DB.prepare(`INSERT INTO volume_snapshots (home_id,resource_generation,kind,ref,covers_volume,created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(home_id,resource_generation) DO UPDATE SET kind=excluded.kind,ref=excluded.ref,covers_volume=excluded.covers_volume
    WHERE volume_snapshots.covers_volume=0`)
    .bind(input.homeId, input.resourceGeneration, input.kind, input.ref, input.coversVolume ? 1 : 0, Date.now()).run();
  return json({ recorded: true });
}

// ---- Webhook inbox -------------------------------------------------------------------------------------------------

const MAX_WEBHOOK_BYTES = 256 * 1024;
const eventSchema = z.object({ id: z.string().regex(/^evt_[\w]{4,120}$/), type: z.string().max(100), created: z.number().int().positive(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }).loose() }).loose();

// The webhook route is served before the API's own bounded body (index.ts), so it bounds its body itself: a chunked body
// with no declared length is counted as it streams, never buffered whole before the size check (upstream 88060af8f's class).
async function readRaw(request: Request): Promise<string> {
  const bytes = await readBoundedBody(request, MAX_WEBHOOK_BYTES);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export async function stripeWebhook(request: Request, env: Env, deps: BillingDependencies): Promise<Response> {
  const config = cfg(env);
  const raw = await readRaw(request);
  const now = (deps.now ?? Date.now)();
  try {
    await verifyStripeSignature(raw, request.headers.get("stripe-signature"), config.webhookSecret, now);
  } catch (e) {
    if (e instanceof StripeError) throw new HTTPError(400, e.code);
    throw e;
  }
  let event: z.infer<typeof eventSchema>;
  try { event = eventSchema.parse(JSON.parse(raw)); } catch { throw new HTTPError(400, "invalid_event"); }
  const inserted = await env.DB.prepare("INSERT INTO stripe_events (id,type,payload,received_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING")
    .bind(event.id, event.type, raw, now).run();
  const duplicate = inserted.meta.changes === 0;
  // G-F1: the dispute hold, from the event itself, before anything else. INTEGRATED-12: the hold (or its pending attribution) commits before
  // any Stripe lookup; a lookup that fails is retried by processStoredEvent below, which records the failure (attempts, backoff, alert) and
  // answers 500 (Stripe retries too). Never a return before that bookkeeping.
  try { await holdDisputeFirst(env, event, now, disputeHoldLookup(config, deps)); } catch { /* recorded by processStoredEvent below */ }
  const row = await env.DB.prepare("SELECT processed_at FROM stripe_events WHERE id=?").bind(event.id).first<{ processed_at: number | null }>();
  if (row?.processed_at) return json({ received: true, duplicate });
  try {
    await processStoredEvent(env, config, deps, event.id);
  } catch (e) {
    // A lookup miss (an unbound customer, a refund no ledger knows yet) whose retry is already recorded on the stored event: an expected
    // wait, durably queued, retried by the sweep. Acknowledged (2xx, typed) so Stripe does not redeliver an obligation already recorded
    // (Astra MAILRETRY-3 P2), exactly as a parked confirmation is. Never 500 once that record committed.
    if (e instanceof PendingMiss) return json({ received: true, duplicate, outcome: `pending:${e.outcome}` });
    // Stored but not applied: Stripe retries on 500 and the cron sweep retries too.
    throw new HTTPError(500, "event_processing_failed");
  }
  return json({ received: true, duplicate });
}

const STATUS_RANK = { paid: 1, payment_problem: 2, canceled: 3 } as const;
type PayStatus = keyof typeof STATUS_RANK;

/** Version is monotonic in Stripe's own clock, so a delayed retry can never undo a newer state;
 *  within one second the worse state wins. */
export const versionFor = (created: number, status: PayStatus) => created * 1000 + STATUS_RANK[status];

/** Local subscription state only moves forward: claimed < trialing < active/past_due < canceled/disputed, and canceled/disputed are final for
 *  that subscription id. A delayed or retried event can therefore never bring an ended subscription back. Enforced in the SQL of the write. */
const RANK_OF: Record<string, number> = { claimed: 1, trialing: 2, active: 3, past_due: 3, unpaid: 3, canceled: 5, disputed: 5, incomplete_expired: 5 };
export const statusRank = (s: string) => RANK_OF[s] ?? 0;
const RANK_SQL = (col: string) => `(CASE ${col} WHEN 'claimed' THEN 1 WHEN 'trialing' THEN 2 WHEN 'active' THEN 3 WHEN 'past_due' THEN 3 WHEN 'unpaid' THEN 3
  WHEN 'canceled' THEN 5 WHEN 'disputed' THEN 5 WHEN 'incomplete_expired' THEN 5 ELSE 0 END)`;
/** `status=<this>` with binds (rank, status): moves status to the new value only if that is not a step back and the old one is not final. */
const FORWARD_STATUS = `status=CASE WHEN ${RANK_SQL("status")}>=5 THEN status WHEN ?>=${RANK_SQL("status")} THEN ? ELSE status END`;
/** Astra CANCEL-SUMMARY-2 #7: with FORWARD_STATUS, binds (rank, status, now): ended_at is stamped once, in the statement that moves the
 *  status to 'canceled', and never moved afterwards (not a trigger: D1 counts a trigger's writes in meta.changes). */
const FORWARD_ENDED_AT = `ended_at=COALESCE(ended_at,CASE WHEN ${RANK_SQL("status")}<5 AND ?>=${RANK_SQL("status")} AND ?='canceled' THEN ? END)`;
/** Astra JOURNEY-BCORE-3 #4: Stripe showed the subscription ENDED (read now): the local status moves to canceled (forward only, ended_at stamped
 *  once) for exactly that subscription. Run under the home's lease (fencedBatch): the resolver after it ended the subscription, and a Keep that
 *  discovers the end inside its lease. */
export const markEndedQ = (homeId: string, subscriptionId: string, now: number): Q => q(`UPDATE billing_subscriptions SET ${FORWARD_STATUS},${FORWARD_ENDED_AT},
  ${STRIPE_ENDED_SET},updated_at=? WHERE home_id=? AND subscription_id=?`, statusRank("canceled"), "canceled", statusRank("canceled"), "canceled", now, now, homeId, subscriptionId);
const ENDED = (s: { status: string } | null | undefined) => s?.status === "canceled" || s?.status === "disputed";
/** THE parked predicate (subscription-gateway.ts), re-exported for the modules that import it from here. */
export { parkedSql, scheduleParked };

/** Astra TAXCOUNTRY-7 P1-a: every hand-off names the subscription it belongs to (`subscriptionId`, when known): the lifecycle orders events
 *  per subscription line (b3-control.ts processPayments), so the end of one contract never outranks another contract's activation. */
async function submitPayment(env: Env, lease: HomeLease, input: { eventId: string; homeId: string; created: number; status: PayStatus; paymentId: string;
  subscriptionId?: string | null }) {
  const payload = { eventId: input.eventId, homeId: input.homeId, version: versionFor(input.created, input.status),
    status: input.status, paymentId: input.paymentId.slice(0, 128), ...(input.subscriptionId ? { subscriptionId: input.subscriptionId.slice(0, 128) } : {}) };
  await fencedRun(env, lease, "INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL) ON CONFLICT(id) DO NOTHING",
    payload.eventId, payload.homeId, payload.version, JSON.stringify(payload), Date.now());
}

/** Hands the paid entitlement to the lifecycle. Queuing a payment supplies nothing: service is recorded as supplied only when the lifecycle
 *  reports the home ready (service_intervals, written by b3-control's transition). */
/** Astra JOURNEY-A-2 A6: a checkout session Stripe confirmed expired is terminal evidence on its consent. The consent's CURRENT session
 *  (stripe_session_id) sets session_expired_at (an unsubmitted checkout that can no longer be submitted). Astra JOURNEY-A-3 #2: the request
 *  in flight (session_inflight_at) is settled only by the session that names ITS issuance (metadata issuance_id = session_issuance_id): an
 *  older or unrelated session of the same consent expiring, whenever it was created, never settles a newer request. Never a submitted checkout. */
export async function recordSessionExpired(env: Env, lease: HomeLease,
  i: { homeId: string; consentId: string | null; sessionId: string | null; issuanceId: string | null }, now: number): Promise<void> {
  if (!i.sessionId) return;
  await fencedBatch(env, lease, [
    q(`UPDATE checkout_consents SET session_expired_at=COALESCE(session_expired_at,?)
      WHERE home_id=? AND stripe_session_id=? AND contract_made_at IS NULL`, now, i.homeId, i.sessionId),
    ...(i.consentId && i.issuanceId ? [q(`UPDATE checkout_consents SET session_inflight_at=NULL,session_issuance_id=NULL
      WHERE id=? AND home_id=? AND session_inflight_at IS NOT NULL AND session_issuance_id=? AND contract_made_at IS NULL`,
      i.consentId, i.homeId, i.issuanceId)] : []),
    // Astra JOURNEY-A-4 #2: a session from before issuance ids (no metadata issuance_id) cannot settle a request by itself, but its consent's
    // unresolved legacy marker is reconciled against Stripe at the next sweep (due now), which settles it once every session of it is terminal.
    ...(i.consentId && !i.issuanceId ? [q(`INSERT INTO checkout_marker_schedule (consent_id,issuance_id,next_attempt_at,attempts)
      SELECT id,session_issuance_id,0,0 FROM checkout_consents
      WHERE id=? AND home_id=? AND session_inflight_at IS NOT NULL AND session_issuance_id LIKE '${LEGACY_ISSUANCE_PREFIX}%'
      ON CONFLICT(consent_id,issuance_id) DO UPDATE SET next_attempt_at=0`, i.consentId, i.homeId)] : []),
    ...(i.consentId ? [checkoutAlertSyncQ(i.consentId, now)] : []),
  ]);
}
/** A request whose session Stripe confirmed terminal (expired by us, or complete): the marker of exactly that issuance is settled, and the
 *  home's unresolved-checkout alert is reconciled in the same batch (Astra JOURNEY-A-4 #5). */
export async function sessionRequestSettled(env: Env, lease: HomeLease, consentId: string, issuanceId: string, now: number): Promise<void> {
  await fencedBatch(env, lease, [
    q("UPDATE checkout_consents SET session_inflight_at=NULL,session_issuance_id=NULL WHERE id=? AND session_issuance_id=?", consentId, issuanceId),
    checkoutAlertSyncQ(consentId, now)]);
}
/** Astra JOURNEY-A-4 #5: alert membership, written in EVERY transaction that settles a marker (completion, expiry, publication, sweep). A
 *  home has at most one open home.checkout_unresolved alert (cloud_alerts_open); the alert is resolved once no request of the home is
 *  unresolved any more, and kept while another remains. (b3-control's failed-home answer stops sending the customer to support once it is
 *  resolved.)
 *  Astra JOURNEY-A-5 #6: its detail.issuances is REBUILT from every unresolved marker of the home (oldest first; 'none' for a marker with no
 *  issuance id), never pruned from what it listed before, so an open alert never lists nothing while a request is unresolved (a younger one
 *  that was not overdue when the alert was raised included). A changed list bumps detail.revision and requeues delivery (delivered_at NULL,
 *  delivery_attempts 0): ops is told again what the incident now covers. */
const CHECKOUT_MEMBERS_WITH = `WITH m AS (SELECT COALESCE(c.session_issuance_id,'none') AS iss FROM checkout_consents c
    WHERE c.home_id=?1 AND c.session_inflight_at IS NOT NULL ORDER BY c.session_inflight_at,c.id),
  md AS (SELECT COUNT(*) AS n,json_group_array(iss) AS list FROM m)`;
const CHECKOUT_MEMBERS_CHANGED = `json(COALESCE(json_extract(cloud_alerts.detail,'$.issuances'),'[]'))<>(SELECT list FROM md)`;
export const checkoutAlertSyncHomeQ = (homeId: string, now: number): Q => q(`${CHECKOUT_MEMBERS_WITH} UPDATE cloud_alerts SET
    resolved_at=CASE WHEN (SELECT n FROM md)>0 THEN NULL ELSE ?2 END,
    delivered_at=CASE WHEN (SELECT n FROM md)>0 AND ${CHECKOUT_MEMBERS_CHANGED} THEN NULL ELSE delivered_at END,
    delivery_attempts=CASE WHEN (SELECT n FROM md)>0 AND ${CHECKOUT_MEMBERS_CHANGED} THEN 0 ELSE delivery_attempts END,
    detail=CASE WHEN ${CHECKOUT_MEMBERS_CHANGED} THEN json_set(detail,'$.issuances',json((SELECT list FROM md)),
      '$.revision',COALESCE(json_extract(detail,'$.revision'),0)+1) ELSE detail END
  WHERE kind='${CHECKOUT_UNRESOLVED_ALERT}' AND resolved_at IS NULL AND home_id=?1`, homeId, now);
/** The same, for the home of one consent (the settling transactions know the consent). */
export const checkoutAlertSyncQ = (consentId: string, now: number): Q => q(`WITH h AS (SELECT home_id AS id FROM checkout_consents WHERE id=?1),
  m AS (SELECT COALESCE(c.session_issuance_id,'none') AS iss FROM checkout_consents c
    WHERE c.home_id=(SELECT id FROM h) AND c.session_inflight_at IS NOT NULL ORDER BY c.session_inflight_at,c.id),
  md AS (SELECT COUNT(*) AS n,json_group_array(iss) AS list FROM m)
  UPDATE cloud_alerts SET
    resolved_at=CASE WHEN (SELECT n FROM md)>0 THEN NULL ELSE ?2 END,
    delivered_at=CASE WHEN (SELECT n FROM md)>0 AND ${CHECKOUT_MEMBERS_CHANGED} THEN NULL ELSE delivered_at END,
    delivery_attempts=CASE WHEN (SELECT n FROM md)>0 AND ${CHECKOUT_MEMBERS_CHANGED} THEN 0 ELSE delivery_attempts END,
    detail=CASE WHEN ${CHECKOUT_MEMBERS_CHANGED} THEN json_set(detail,'$.issuances',json((SELECT list FROM md)),
      '$.revision',COALESCE(json_extract(detail,'$.revision'),0)+1) ELSE detail END
  WHERE kind='${CHECKOUT_UNRESOLVED_ALERT}' AND resolved_at IS NULL AND home_id=(SELECT id FROM h)`, consentId, now);
/** Astra JOURNEY-A-5 #5: the six-hour escalation, evaluated from the markers alone (no Stripe call, no lease): a home with a request
 *  unresolved for CHECKOUT_UNRESOLVED_ALERT_MS and no open alert gets one, named after its oldest overdue request (a resolved alert of that
 *  very request is reopened); `detail` is that request's reconciliation evidence when the caller has it. Membership follows (sync). */
export const checkoutAlertRaiseQs = (homeId: string, now: number, detail: Record<string, unknown> = {}): Q[] => [
  q(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at)
    SELECT 'alert:checkout_unresolved:'||c.id||':'||COALESCE(c.session_issuance_id,'none'),c.home_id,'${CHECKOUT_UNRESOLVED_ALERT}','high',
      json_patch(json_object('consentId',c.id,'issuanceId',c.session_issuance_id,'requestedAt',c.session_inflight_at,
        'legacy',json(CASE WHEN c.session_issuance_id IS NULL OR substr(c.session_issuance_id,1,${LEGACY_ISSUANCE_PREFIX_LEN})='${LEGACY_ISSUANCE_PREFIX_SQL}' THEN 'true' ELSE 'false' END)),?3),?2
    FROM checkout_consents c WHERE c.home_id=?1 AND c.session_inflight_at IS NOT NULL AND c.session_inflight_at<=?2-${CHECKOUT_UNRESOLVED_ALERT_MS}
      AND NOT EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.home_id=?1 AND a.kind='${CHECKOUT_UNRESOLVED_ALERT}' AND a.resolved_at IS NULL)
    ORDER BY c.session_inflight_at,c.id LIMIT 1
    ON CONFLICT(id) DO UPDATE SET resolved_at=NULL,delivered_at=NULL,delivery_attempts=0,raised_at=excluded.raised_at,detail=excluded.detail`,
    homeId, now, JSON.stringify(detail)),
  checkoutAlertSyncHomeQ(homeId, now),
];

/** Astra JOURNEY-A-4 #2: a creation attempt or consent from before issuance ids (migration 0093) whose session may exist unrecorded carries
 *  this explicit unresolved-legacy marker (session_issuance_id = 'legacy:<consent>'): it never looks "never issued" to retirement. */
export const LEGACY_ISSUANCE_PREFIX = "legacy:";
const LEGACY_ISSUANCE_PREFIX_SQL = "legacy:";
const LEGACY_ISSUANCE_PREFIX_LEN = 7;
/** A request younger than this may still be answered by its own handler (Stripe's call, then the recording batch): the sweep leaves it alone. */
export const SESSION_MARKER_SETTLE_AFTER_MS = 15 * 60_000;
/** Astra JOURNEY-A-4 #3: the sweep's next attempt at one marker, stamped before each attempt whatever its outcome (unresolved, failed, busy
 *  home): 5 min doubling to 1 h, never later than the marker's 6-hour alert point. */
export const sessionMarkerNextAt = (attempts: number, inflightAt: number, now: number) =>
  Math.min(now + Math.min(60 * 60_000, 5 * 60_000 * 2 ** Math.min(attempts, 4)), Math.max(now + 5 * 60_000, inflightAt + CHECKOUT_UNRESOLVED_ALERT_MS));
/** Astra JOURNEY-A-3 #3: one consent's session request in flight reconciled against Stripe, under the home's billing lease, by its issuance id
 *  (the session's metadata issuance_id among every session of the home's customer). Expired: settled exactly as the expiry webhook would. Open
 *  (its URL never reached anyone: the recording batch never ran): expired at Stripe, and settled once Stripe confirms. Complete: settled only
 *  once that completion is recorded (contract_made_at), so a payment on its way keeps the home. Not found, or the listing failed: unresolved.
 *  Astra JOURNEY-A-4 #2: an unresolved LEGACY marker (no issuance id in Stripe) is matched by its consent (metadata consent_id) among the
 *  customer's sessions: open ones are expired, and it settles only once a complete listing shows every one of them terminal (expired, or
 *  complete with the completion recorded). Astra JOURNEY-A-5 #4: a missing customer row or a session that names no consent is never evidence:
 *  the customer and the consent's sessions are recovered from durable identifiers, and without them the marker stays unresolved (alerted).
 *  Terminal evidence only, never age: an unresolved marker older than CHECKOUT_UNRESOLVED_ALERT_MS raises home.checkout_unresolved (one open
 *  alert per home); alerts are reconciled per home in every settling batch (checkoutAlertSyncQ). Returns whether the marker is settled. */
export async function reconcileSessionMarker(env: Env, lease: HomeLease,
  stripe: Pick<StripeClient, "listAllCheckoutSessions" | "expireCheckoutSession" | "getCheckoutSession" | "getSubscription">,
  consentId: string, now: number): Promise<boolean> {
  const c = await env.DB.prepare(`SELECT id,home_id,session_inflight_at AS at,session_issuance_id AS iss,contract_made_at AS made,stripe_subscription_id AS sub
    FROM checkout_consents WHERE id=?`).bind(consentId)
    .first<{ id: string; home_id: string; at: number | null; iss: string | null; made: number | null; sub: string | null }>();
  if (!c || c.at === null) return true;
  let customer = (await getSub(env, c.home_id))?.customer_id ?? null;
  const legacy = c.iss === null || c.iss.startsWith(LEGACY_ISSUANCE_PREFIX);
  let listed = false;
  let detail: Record<string, unknown>;
  // Raised (or kept) whenever the marker stays unresolved without terminal evidence: overdue, or at once when it can never be resolved here.
  let alertNow = false;
  // Astra JOURNEY-A-6 #5 / A-7 #4: a COMPLETE session is terminal only on its OWN disposition evidence, never on a consent's single
  // contract_made_at (which can stand for one session only), in BOTH branches: its completion AND payment recorded for THAT session id (a
  // consent of this home bound to it, contract made, paid), or its order refused for good (its subscription tombstoned for this home). A
  // completed session with neither stays unresolved.
  const recorded = new Set((await env.DB.prepare(`SELECT stripe_session_id AS s FROM checkout_consents WHERE home_id=? AND stripe_session_id IS NOT NULL
    AND contract_made_at IS NOT NULL AND paid_at IS NOT NULL`).bind(c.home_id).all<{ s: string }>()).results.map((r) => r.s));
  const refused = new Set((await env.DB.prepare("SELECT subscription_id AS s FROM rejected_subscriptions WHERE home_id=?").bind(c.home_id)
    .all<{ s: string }>()).results.map((r) => r.s));
  const completeSettles = (s: { id: string; subscription: string | null }) => recorded.has(s.id) || (s.subscription !== null && refused.has(s.subscription));
  if (legacy) {
    // Astra JOURNEY-A-5 #4: the evidence is recovered from DURABLE identifiers, never assumed from their absence. The sessions this consent
    // is known by (its recorded session, its open checkout's, its "Finish checkout" attempts'), and the Stripe customer: the home's row,
    // else the consent's subscription's, else a known session's. No customer recoverable: the marker stays unresolved and ops is alerted.
    const known = (await env.DB.prepare(`SELECT stripe_session_id AS s FROM checkout_consents WHERE id=?1 AND stripe_session_id IS NOT NULL
      UNION SELECT session_id FROM open_checkouts WHERE consent_id=?1 AND session_id IS NOT NULL
      UNION SELECT session_id FROM checkout_resume_attempts WHERE consent_id=?1 AND session_id IS NOT NULL`).bind(c.id).all<{ s: string }>()).results.map((r) => r.s);
    let recoveredFrom: string | null = customer ? "billing_subscription" : null;
    if (!customer && c.sub) {
      try { customer = (await stripe.getSubscription(c.sub)).customer ?? null; if (customer) recoveredFrom = "subscription"; }
      catch (e) { if (!(e instanceof StripeError)) throw e; }
    }
    for (const id of known) {
      if (customer) break;
      try { customer = (await stripe.getCheckoutSession(id)).customer ?? null; if (customer) recoveredFrom = "session"; }
      catch (e) { if (!(e instanceof StripeError)) throw e; }
    }
    type Listed = { id: string; status: string | null; subscription: string | null };
    let mine: Listed[] = [];
    let uncorrelated: Listed[] = [];
    if (customer) {
      try {
        const all = (await stripe.listAllCheckoutSessions(customer)).map((s) => ({ ...s, subscription: typeof s.subscription === "string" ? s.subscription : null }));
        // Ours: the consent's metadata, or a session id this consent is recorded with. Uncorrelated: a session that names no consent and no
        // issuance (made before either was written): it may be this consent's, so it must be terminal too; it is never expired on a guess.
        mine = all.filter((s) => s.metadata?.consent_id === c.id || known.includes(s.id)).map((s) => ({ id: s.id, status: s.status, subscription: s.subscription }));
        uncorrelated = all.filter((s) => !s.metadata?.consent_id && !s.metadata?.issuance_id && !known.includes(s.id))
          .map((s) => ({ id: s.id, status: s.status, subscription: s.subscription }));
        listed = true;
      } catch (e) { if (!(e instanceof StripeError)) throw e; }
    }
    for (const s of mine) {
      if (s.status !== "open") continue;
      await fence(env, lease);
      try { s.status = (await stripe.expireCheckoutSession(s.id)).status; } catch (e) { if (!(e instanceof StripeError)) throw e; }
    }
    for (const s of mine) if (s.status === "expired") await recordSessionExpired(env, lease, { homeId: c.home_id, consentId: null, sessionId: s.id, issuanceId: null }, now);
    const terminal = (s: Listed) => s.status === "expired"
      || (s.status === "complete" && completeSettles(s));
    // Terminal evidence only: a complete listing, every session of the consent terminal, every known session id found in it, and no
    // uncorrelated session still open or awaiting its recorded completion.
    const settles = customer !== null && listed && mine.every(terminal) && known.every((k) => mine.some((s) => s.id === k)) && uncorrelated.every(terminal);
    if (settles) {
      await fencedBatch(env, lease, [
        q("UPDATE checkout_consents SET session_inflight_at=NULL,session_issuance_id=NULL WHERE id=? AND session_issuance_id IS ?", c.id, c.iss),
        checkoutAlertSyncQ(c.id, now)]);
    }
    if (!customer) alertNow = true;
    detail = { sessions: mine, uncorrelated, knownSessions: known, customerFrom: recoveredFrom,
      stripeStatus: !customer ? "customer_unrecoverable" : listed ? "listed" : "unavailable" };
  } else {
    let found: { id: string; status: string | null; subscription: string | null } | null = null;
    if (customer) {
      try {
        const s = (await stripe.listAllCheckoutSessions(customer)).find((x) => x.metadata?.issuance_id === c.iss);
        found = s ? { id: s.id, status: s.status, subscription: typeof s.subscription === "string" ? s.subscription : null } : null;
        listed = true;
      } catch (e) { if (!(e instanceof StripeError)) throw e; }
    }
    if (found?.status === "open") {
      await fence(env, lease);
      try { found = { ...found, status: (await stripe.expireCheckoutSession(found.id)).status }; }
      catch (e) { if (!(e instanceof StripeError)) throw e; }
    }
    if (found?.status === "expired") await recordSessionExpired(env, lease, { homeId: c.home_id, consentId: c.id, sessionId: found.id, issuanceId: c.iss }, now);
    // The same per-session predicate as the legacy branch (Astra JOURNEY-A-7 #4): the consent's contract_made_at alone is never evidence.
    else if (found?.status === "complete" && completeSettles(found)) await sessionRequestSettled(env, lease, c.id, c.iss!, now);
    // Astra INTEGRATED-2 #3: no session of this issuance, and a saved attempt of the SAME key still unresolved: that attempt's own
    // reconciliation decides (past its expiry plus the grace period, proven empty settles the attempt, this marker and the alert in one
    // batch: provenEmptyQs). A marker with no such attempt keeps the rule above: unresolved, alerted, never settled on age.
    else if (!found && listed) {
      // (Astra INTEGRATED-3 #4: matched by the attempt's saved issuance identity, so a /checkout/resume attempt is found too.)
      const a = await env.DB.prepare(`SELECT ra.id AS id,ra.expires_at AS expires_at,ra.payload AS payload FROM checkout_resume_attempts ra WHERE ra.consent_id=?
        AND ${attemptKeySql("ra")}=? AND ra.state='creating' ORDER BY ra.created_at LIMIT 1`).bind(c.id, c.iss).first<{ id: string; expires_at: number; payload: string }>();
      let customerId: unknown = null;
      try { customerId = a ? (JSON.parse(a.payload) as { customerId?: unknown }).customerId : null; } catch { customerId = null; }
      if (a && typeof customerId === "string" && customerId && now >= a.expires_at + STRIPE_ATTEMPT_GRACE_MS) {
        try { await reconcileCheckoutAttempt(env, lease, stripe as ReturnType<typeof stripeClient>, { homeId: c.home_id, attemptId: a.id, consentId: c.id, customerId,
          expiresAt: a.expires_at, proven: false, matchExpiry: true }, now); }
        catch (e) { if (!(e instanceof HTTPError || e instanceof StripeError)) throw e; /* consent_stale: proven empty, settled; else unresolved */ }
      }
    }
    detail = { sessionId: found?.id ?? null, stripeStatus: found?.status ?? (listed ? "not_found" : "unavailable") };
  }
  const left = await env.DB.prepare("SELECT session_inflight_at AS at FROM checkout_consents WHERE id=? AND session_issuance_id IS ?").bind(c.id, c.iss).first<{ at: number | null }>();
  if (!left || left.at === null) return true;
  if (alertNow || now - c.at >= CHECKOUT_UNRESOLVED_ALERT_MS) {
    // One open alert per home (cloud_alerts_open), raised for this request when none is open (with this reconciliation's evidence); its
    // membership is every unresolved request of the home (checkoutAlertSyncHomeQ). An unrecoverable legacy marker raises it at once.
    await fencedBatch(env, lease, [
      q(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM cloud_alerts a
        WHERE a.home_id=?2 AND a.kind=?3 AND a.resolved_at IS NULL)
        ON CONFLICT(id) DO UPDATE SET resolved_at=NULL,delivered_at=NULL,delivery_attempts=0,raised_at=excluded.raised_at,detail=excluded.detail`,
        `alert:checkout_unresolved:${c.id}:${c.iss ?? "none"}`, c.home_id, CHECKOUT_UNRESOLVED_ALERT, "high",
        JSON.stringify({ consentId: c.id, issuanceId: c.iss, requestedAt: c.at, legacy, ...detail }), now),
      checkoutAlertSyncHomeQ(c.home_id, now)]);
  }
  return false;
}

async function activate(env: Env, lease: HomeLease, input: { eventId: string; homeId: string; created: number; paymentId: string; subscriptionId: string | null }, _now: number) {
  await submitPayment(env, lease, { ...input, status: "paid" });
}
/** Astra INTEGRATED-4 #1/#2: THE per-invoice refund coverage, the one rule every retired-home payment is judged by (never subscription-wide,
 *  never "some refund row exists"). For ONE invoice: what was paid (null: not known here), what every decided refund of it already covers
 *  (ledger operations and external refunds alike; a failed or canceled refund covers nothing), and whether its retired-home obligation is
 *  already on record (refund:retired:<invoice> or its no_capacity:<invoice> operation; that operation targets the whole payment and the
 *  invoice ledger caps it to what is still owed, so it covers the remainder). `outstandingCents` null: the payment is unknown, so nothing
 *  proves it covered. */
export async function invoiceRefundCoverage(env: Env, invoiceId: string, paidCents: number | null):
  Promise<{ paidCents: number | null; refundedCents: number; obligationRecorded: boolean; outstandingCents: number | null }> {
  const r = await env.DB.prepare(`SELECT
      (SELECT COALESCE(SUM(COALESCE(amount_cents,0)),0) FROM refund_ops WHERE invoice_id=?1 AND decided_at IS NOT NULL
        AND COALESCE(stripe_refund_status,'') NOT IN ('failed','canceled') AND COALESCE(refund_status,'') NOT IN ('failed','canceled')) AS refunded,
      (EXISTS (SELECT 1 FROM cloud_outbox WHERE id='refund:retired:' || ?1) OR EXISTS (SELECT 1 FROM refund_ops WHERE id='no_capacity:' || ?1)) AS recorded`)
    .bind(invoiceId).first<{ refunded: number; recorded: number }>();
  const refundedCents = r?.refunded ?? 0;
  return { paidCents, refundedCents, obligationRecorded: r?.recorded === 1,
    outstandingCents: paidCents === null ? null : Math.max(0, paidCents - refundedCents) };
}

/** Astra INTEGRATED-3 #1: a payment that settles for a subscription that has ALREADY ENDED (or a plan a refund already ended: INTEGRATED-4 #1),
 *  on a home the customer deleted (deleting or deleted) that was never paid and never served (B3 entitlement 'pending', or 'refund_pending' /
 *  'refunded' for a failed home), is owed back. It is journaled into the payment inbox BEFORE the handler's terminal return, exactly as an
 *  ordinary payment would be, so B3 records its payment-specific refund obligation (refund:retired:<payment id>) atomically with the
 *  acknowledgement. Nothing else: no activation, no grant, no status change. Whether anything is still owed is decided per invoice by
 *  invoiceRefundCoverage (INTEGRATED-4 #2): fully covered, or its obligation already recorded, adds nothing; a partial refund leaves the
 *  remainder owed, and the obligation's ledger decision pays only that remainder. A served or paid home is untouched: its post-promise
 *  charges keep their record-only treatment (recordInvoice). */
async function journalUnservedDeletedPayment(env: Env, lease: HomeLease,
  input: { eventId: string; homeId: string; created: number; paymentId: string; paidCents: number | null }): Promise<void> {
  const retired = await env.DB.prepare(`SELECT 1 AS x FROM cloud_homes h WHERE h.id=? AND h.desired_state IN ('deleting','deleted')
    AND h.entitlement IN ('pending','refund_pending','refunded')`).bind(input.homeId).first();
  if (!retired) return;
  const cov = await invoiceRefundCoverage(env, input.paymentId, input.paidCents);
  if (cov.obligationRecorded || cov.outstandingCents === 0) return;
  await submitPayment(env, lease, { eventId: input.eventId, homeId: input.homeId, created: input.created, paymentId: input.paymentId, status: "paid" });
}

/** The one atomic claim of a home's subscription slot (checkout completion). A REPLACEMENT subscription (a different id) starts from
 *  nothing: the first-payment record, the period and every cancellation field belonged to the old contract. `from`: the running
 *  subscription a replacement checkout may take the slot from (WP6; only ever the one named by its `replaces` metadata). */
function claimStatement(homeIdV: string, incomingSub: string, consentId: string, now: number, from: string | null): Q {
  const fresh = "subscription_id IS NOT NULL AND subscription_id<>?";
  return q(`UPDATE billing_subscriptions SET
          first_invoice_id=CASE WHEN ${fresh} THEN NULL ELSE first_invoice_id END, first_paid_at=CASE WHEN ${fresh} THEN NULL ELSE first_paid_at END,
          first_invoice_cents=CASE WHEN ${fresh} THEN NULL ELSE first_invoice_cents END, first_invoice_tax_cents=CASE WHEN ${fresh} THEN NULL ELSE first_invoice_tax_cents END,
          first_period_start=CASE WHEN ${fresh} THEN NULL ELSE first_period_start END, first_period_end=CASE WHEN ${fresh} THEN NULL ELSE first_period_end END,
          first_payment_intent=CASE WHEN ${fresh} THEN NULL ELSE first_payment_intent END, service_supplied_at=CASE WHEN ${fresh} THEN NULL ELSE service_supplied_at END,
          current_period_start=CASE WHEN ${fresh} THEN NULL ELSE current_period_start END, current_period_end=CASE WHEN ${fresh} THEN NULL ELSE current_period_end END,
          reminder_due_at=CASE WHEN ${fresh} THEN NULL ELSE reminder_due_at END, cancel_at_period_end=CASE WHEN ${fresh} THEN 0 ELSE cancel_at_period_end END,
          customer_cancel_at=CASE WHEN ${fresh} THEN NULL ELSE customer_cancel_at END, cancel_terminal_sub=CASE WHEN ${fresh} THEN NULL ELSE cancel_terminal_sub END,
          cancel_verified_at=CASE WHEN ${fresh} THEN NULL ELSE cancel_verified_at END, cancel_verify_dirty=CASE WHEN ${fresh} THEN 0 ELSE cancel_verify_dirty END,
          service_start_at=CASE WHEN ${fresh} THEN NULL ELSE service_start_at END,
          cancel_at=CASE WHEN ${fresh} THEN NULL ELSE cancel_at END,
          cancel_intent_rev=cancel_intent_rev+CASE WHEN ${fresh} THEN 1 ELSE 0 END,
          ended_at=CASE WHEN status='canceled' AND subscription_id IS NOT ? THEN NULL ELSE ended_at END,
          status=CASE WHEN status='canceled' AND subscription_id IS NOT ? THEN 'claimed' ELSE status END,
          subscription_id=?,consent_id=?,updated_at=? WHERE home_id=? AND (subscription_id IS NULL OR subscription_id=? OR status='canceled'${from ? " OR subscription_id=?" : ""})`,
  ...Array(21).fill(incomingSub), incomingSub, consentId, now, homeIdV, incomingSub, ...(from ? [from] : []));
}

/** The checkout completion's claim of `incomingSub` for the home, with the deletion binding (deletionBindQs) in the same batch: the claim's
 *  own result is the first. */
export const claimQs = (homeIdV: string, incomingSub: string, consentId: string, now: number): Q[] =>
  [claimStatement(homeIdV, incomingSub, consentId, now, null), ...deletionBindQs(homeIdV, now)];

/** A subscription the guard (or a failed asynchronous payment) cancelled: every later event about it is ignored (rejected_subscriptions). */
const isRejectedSub = async (env: Env, subscriptionId: string | null): Promise<boolean> =>
  subscriptionId !== null && (await env.DB.prepare("SELECT 1 AS x FROM rejected_subscriptions WHERE subscription_id=?").bind(subscriptionId).first()) !== null;

/** The rejection email (plan §1.1): what happened, then what happened to the money, from the WP3 ledger's own state (Astra WP5-1 #8): an
 *  unpaid order says nothing was charged; a paid one says the refund is under way and where it stands (refundLine), never "we refunded" before
 *  the ledger says so. */
function rejectionEmail(c: ConsentRow, verdict: RejectKind, collected: string | null, refund: RefundOpRow | null): { emailSubject: string; emailText: string; emailHtml: string } {
  const lang = c.checkout_language;
  const declared = c.declared_country ?? c.billing_country;
  // The refund line in the language the sentence around it is rendered in (a string without German yet is sent in English, whole).
  const lineLang = lang === "de" && ORDER_WORDS.rejectedRefunding.de !== null ? "de" : "en";
  const money = refund ? orderWords("rejectedRefunding", lang, { refund: refundLine(refund, lineLang, refundPathOf(c)) })
    : orderWords("rejectedUnpaid", lang);
  const [subject, body] = verdict === "mismatch" ? [orderWords("mismatchSubject", lang), orderWords("mismatch", lang, { country: collected === null ? "?" : countryFor(collected, lang), declared: countryFor(declared, lang), money })]
    : verdict === "country_paused" ? [orderWords("countryPausedSubject", lang, { country: countryFor(declared, lang) }), orderWords("countryPaused", lang, { country: countryFor(declared, lang), money })]
      // An order whose acceptance could not be recovered (refundParkedOrder): said as it is, never "you did not confirm the renewal".
      : c.acceptance_parked_at ? [orderWords("rejectedConsentSubject", lang), orderWords("orderNotFinished", lang, { money })]
        : [orderWords("rejectedConsentSubject", lang), orderWords("rejectedConsent", lang, { money })];
  return { emailSubject: subject, emailText: body, emailHtml: htmlOf(body) };
}
const refundPathOf = (c: Pick<ConsentRow, "tax_source">): "mp" | "direct" => sellerOfConsent(c) === "link" ? "mp" : "direct";
/** A paid rejection whose ledger row is not readable yet: "being prepared" (never "refunded" before the ledger says so). */
const REFUND_PREPARING = { refund_submitted_at: null, stripe_refund_status: null, refunded_at: null, attempts: 0, done_at: null } as unknown as RefundOpRow;
/** What a rejection email is re-rendered from (stored with its payload): the consent, its refund operation (null: nothing was paid), the verdict
 *  and Stripe's collected country. Ids and a country code only. */
interface RejectionSource { consentId: string | null; opId: string | null; verdict: RejectKind; collected: string | null;
  /** An order refused on its own (refuseUnboundOrder): no consent speaks for it, so the notice is rendered from the session's own language
   *  and seller path, for the home's verified account (Astra DROPDOWN-DIRECT-1 (5)). */
  unbound?: { homeId: string; lang: string | null; path: RefundPath };
  /** The order's invoice and subscription (Astra WP5-3 #4): an initially unpaid rejection resolves the refund a later payment opened from these. */
  invoiceId?: string | null; subscriptionId?: string | null }
/** The refund an initially UNPAID rejection came to owe (its payment cleared later: refundRejectedPayment, refundStrandedPayment), looked up
 *  by the order's invoice or subscription on every send (Astra WP5-3 #4). Null: nothing was charged. A source recorded before these ids
 *  were kept falls back to the consent's own subscription. */
async function laterRefundOf(env: Env, c: ConsentRow, src: Partial<RejectionSource>): Promise<RefundOpRow | null> {
  const invoiceId = src.invoiceId ?? null;
  const subscriptionId = src.subscriptionId ?? (c as { stripe_subscription_id?: string | null }).stripe_subscription_id ?? null;
  if (!invoiceId && !subscriptionId) return null;
  return env.DB.prepare(`SELECT * FROM refund_ops WHERE home_id=? AND kind<>'external' AND COALESCE(paid_cents,0)>0
    AND ((? IS NOT NULL AND invoice_id=?) OR (? IS NOT NULL AND subscription_id=?)) ORDER BY created_at, rowid LIMIT 1`)
    .bind(c.home_id, invoiceId, invoiceId, subscriptionId, subscriptionId).first<RefundOpRow>();
}
/** The rejection email of an order refused on its own (refuseUnboundOrder), through the same words and ledger state as rejectionEmail, with
 *  a neutral reason (no consent of the customer's was at fault: "We could not finish your order on our side, so it was cancelled."), the
 *  truthful money line (being refunded and where that stands, or nothing charged) in the session's language. */
function unboundRejectionEmail(lang: string | null, path: RefundPath, refund: RefundOpRow | null): { emailSubject: string; emailText: string; emailHtml: string } {
  const lineLang = lang === "de" && ORDER_WORDS.rejectedRefunding.de !== null ? "de" : "en";
  const money = refund ? orderWords("rejectedRefunding", lang, { refund: refundLine(refund, lineLang, path) }) : orderWords("rejectedUnpaid", lang);
  const body = orderWords("orderNotFinished", lang, { money });
  return { emailSubject: orderWords("rejectedConsentSubject", lang), emailText: body, emailHtml: htmlOf(body) };
}
/** The refund an order refused on its own came to owe after its payment cleared, by its invoice or subscription (null: nothing charged). */
const laterUnboundRefundOf = (env: Env, homeId: string, src: Partial<RejectionSource>) => (!src.invoiceId && !src.subscriptionId) ? Promise.resolve(null)
  : env.DB.prepare(`SELECT * FROM refund_ops WHERE home_id=? AND kind<>'external' AND COALESCE(paid_cents,0)>0
    AND ((? IS NOT NULL AND invoice_id=?) OR (? IS NOT NULL AND subscription_id=?)) ORDER BY created_at, rowid LIMIT 1`)
    .bind(homeId, src.invoiceId ?? null, src.invoiceId ?? null, src.subscriptionId ?? null, src.subscriptionId ?? null).first<RefundOpRow>();
/** The unsent rejection email re-rendered from the consent and the WP3 ledger as they stand now (Astra WP5-2 #4); null when unchanged or when the
 *  payload carries no source (a notice recorded before this rule keeps its stored text). */
/** Astra JOURNEY-B-3 #5: an unsent ready email's payload generated again for a handoff at `at` (serverReadyData) and saved (fenced) before it
 *  goes out. Returns the payload to send. */
async function refreshReadyPayload(env: Env, lease: HomeLease, noticeId: string, homeId: string, payload: string, at: number): Promise<string> {
  const prev = JSON.parse(payload) as { readyAt?: number };
  const fresh = JSON.stringify(await serverReadyData(env, homeId, typeof prev.readyAt === "number" ? prev.readyAt : at, at));
  if (fresh !== payload) await fencedRun(env, lease, "UPDATE billing_notices SET payload=? WHERE id=? AND sent_at IS NULL", fresh, noticeId);
  return fresh;
}
async function refreshedRejectionPayload(env: Env, payload: string): Promise<string | null> {
  let data: Record<string, unknown>;
  try { data = JSON.parse(payload) as Record<string, unknown>; } catch { return null; }
  const src = data.source as Partial<RejectionSource> | undefined;
  if (src?.unbound && !src.consentId) {
    const u = src.unbound;
    const op = src.opId ? (await getRefundOp(env, src.opId)) ?? REFUND_PREPARING : await laterUnboundRefundOf(env, u.homeId, src);
    const next = JSON.stringify({ ...data, ...unboundRejectionEmail(u.lang, u.path, op) });
    return next === payload ? null : next;
  }
  if (!src?.consentId || !src.verdict || !isRejectKind(src.verdict)) return null;
  const c = await getConsent(env, src.consentId);
  if (!c) return null;
  const op = src.opId ? (await getRefundOp(env, src.opId)) ?? REFUND_PREPARING : await laterRefundOf(env, c, src);
  const next = JSON.stringify({ ...data, ...rejectionEmail(c, src.verdict, src.collected ?? null, op) });
  return next === payload ? null : next;
}

/** The consent a checkout session's metadata names, when it is this home's (else null). */
async function namedConsent(env: Env, session: Obj, homeId: string): Promise<ConsentRow | null> {
  const id = str(rec(session.metadata).consent_id);
  const c = id ? await getConsent(env, id) : null;
  return c && c.home_id === homeId ? c : null;
}
/** The consent this session id was bound to when it was created or reissued (stripe_session_id), for this home. */
const boundConsent = async (env: Env, session: Obj, homeId: string): Promise<ConsentRow | null> => str(session.id)
  ? await env.DB.prepare("SELECT * FROM checkout_consents WHERE stripe_session_id=? AND home_id=? ORDER BY created_at DESC LIMIT 1").bind(str(session.id), homeId).first<ConsentRow>()
  : null;
/** The session is not its consent's own order (bound to another session, or the consent holds another subscription): refused on its own. */
const independentOf = (c: ConsentRow, session: Obj): boolean => {
  const sub = idOf(session.subscription);
  return (!!str(session.id) && !!c.stripe_session_id && c.stripe_session_id !== str(session.id)) || (sub !== null && !!c.stripe_subscription_id && c.stripe_subscription_id !== sub);
};
/** The seller path a checkout session was actually created on: Managed Payments (Link) or direct. */
const sessionPathOf = (session: Obj): RefundPath => str(rec(session.metadata).seller) === "link" || rec(session.managed_payments).enabled === true ? "mp" : "direct";
/** The tombstone reason of an order refused on its own: its kind and the seller path it was taken on ("rejected_consent@mp"). */
const ownRefusalReason = (kind: "rejected_consent" | "duplicate", path: RefundPath) => `${kind}@${path}`;
/** The refusal refuseUnboundOrder tombstoned this subscription with (refused on its own; not replaced, written off or refused through its
 *  consent, whose tombstones carry no "@path"), with the seller path persisted with it; null otherwise. */
async function ownRefusalOf(env: Env, subscriptionId: string | null): Promise<{ kind: "rejected_consent" | "duplicate"; path: RefundPath } | null> {
  if (subscriptionId === null) return null;
  const reason = (await env.DB.prepare("SELECT reason FROM rejected_subscriptions WHERE subscription_id=?").bind(subscriptionId).first<{ reason: string | null }>())?.reason ?? "";
  const m = /^(rejected_consent|duplicate)@(mp|direct)$/.exec(reason);
  return m ? { kind: m[1] as "rejected_consent" | "duplicate", path: m[2] as RefundPath } : null;
}
const refusedOnItsOwn = async (env: Env, subscriptionId: string | null): Promise<boolean> => (await ownRefusalOf(env, subscriptionId)) !== null;
/** Every checkout.session.* event resolves its consent the same way: the named one of this home, else the one bound to the session. */
const sessionConsent = async (env: Env, session: Obj, homeId: string): Promise<ConsentRow | null> =>
  (await namedConsent(env, session, homeId)) ?? boundConsent(env, session, homeId);

/** The invoice of a checkout session (Astra DROPDOWN-DIRECT-2 (1)): Stripe sends it as an id or, expanded, as the object (idOf), and Stripe
 *  documents it as nullable. A paid session that names none is read back from Stripe (the session with its invoice expanded). Null when Stripe
 *  has none yet or cannot be reached: the caller keeps the refund obligation without it and the ledger recovers it later. */
async function sessionInvoiceOf(stripe: StripeClient, session: Obj, paid: boolean): Promise<string | null> {
  const held = idOf(session.invoice);
  const sessionId = str(session.id);
  if (held || !paid || !sessionId) return held;
  try { return await stripe.checkoutSessionInvoice(sessionId); } catch { return null; }
}
/** The refusal operation of this order already opened (a retried event, possibly with its invoice resolved since), else `fresh`: one obligation
 *  per refused order, whichever of its ids was known when it was opened. */
async function refusalOpId(env: Env, homeId: string, kind: string, invoiceId: string | null, subscriptionId: string | null, fresh: string): Promise<string> {
  if (!invoiceId && !subscriptionId) return fresh;
  const held = await env.DB.prepare(`SELECT id FROM refund_ops WHERE home_id=? AND kind=? AND ((? IS NOT NULL AND invoice_id=?) OR (? IS NOT NULL AND subscription_id=?))
    ORDER BY created_at, rowid LIMIT 1`).bind(homeId, kind, invoiceId, invoiceId, subscriptionId, subscriptionId).first<{ id: string }>();
  return held?.id ?? fresh;
}

/** A completed subscription checkout refused ON ITS OWN, without touching any consent (Astra NO-DROPDOWN-1 (3), DROPDOWN-DIRECT-1 (2)):
 *  - "rejected_consent": no consent of this home covers it (none named, none bound to the session: not created by our checkout for this
 *    home), or the consent it names is bound to ANOTHER session (a second checkout for one consent: the bound one may still be paying);
 *  - "duplicate": the consent it names already holds another subscription (one subscription per consent).
 *  Nobody authorized THIS order, so it never becomes a live subscription: the subscription is tombstoned, its payment and session voided for
 *  this home, a paid order is refunded in full through the ledger (which cancels the subscription) and an unpaid one is cancelled (journaled
 *  first, retried by the sweep); ops and the home's account are told (a neutral rejection notice). The shared consent, its bootstrap and its
 *  own order are never marked: their payment proceeds.
 *  Idempotent. */
async function refuseUnboundOrder(env: Env, deps: BillingDependencies, ctx: RefundContext, i: { homeId: string; subscriptionId: string | null; session: Obj; paid: boolean;
  kind?: "rejected_consent" | "duplicate"; why?: string; kept?: string | null }, now: number): Promise<string> {
  const lease = ctx.lease!;
  const kind = i.kind ?? "rejected_consent";
  const sessionId = str(i.session.id);
  const amount = i.paid && typeof i.session.amount_total === "number" ? i.session.amount_total : 0;
  const invoiceId = await sessionInvoiceOf(ctx.stripe, i.session, amount > 0);
  // Astra DROPDOWN-DIRECT-2 (1): a PAID order always keeps its refund obligation, whatever is known now. Its invoice unresolved (or the home's
  // owner unknown), the operation is still opened with the session it was paid through: the ledger recovers the invoice from Stripe on every
  // pass (the sweep included) before it refunds. The customer's notice follows the payment, never the row: paid is "being refunded".
  const refundNow = amount > 0;
  const opId = await refusalOpId(env, i.homeId, kind, invoiceId, i.subscriptionId, `${kind}:${invoiceId ?? i.subscriptionId ?? sessionId ?? "unbound"}`);
  const owner = (await env.DB.prepare("SELECT owner_id FROM cloud_homes WHERE id=?").bind(i.homeId).first<{ owner_id: string }>())?.owner_id ?? null;
  const path = sessionPathOf(i.session);
  const lang = str(i.session.locale);
  const source: RejectionSource = { consentId: null, opId: refundNow ? opId : null, verdict: "rejected_consent", collected: str(rec(rec(i.session.customer_details).address).country),
    invoiceId, subscriptionId: i.subscriptionId, unbound: { homeId: i.homeId, lang, path } };
  const stmts: Q[] = [
    ...(refundNow ? [refundOpInsert({ id: opId, kind, homeId: i.homeId, userId: owner ?? "", invoiceId, paidCents: amount, targetCents: amount, endPlan: false,
      cancelSubscriptionId: i.subscriptionId, subscriptionId: i.subscriptionId, inheritSubscription: false, detail: { path, ...(invoiceId ? {} : { sessionId: sessionId ?? undefined }) } }, now)] : []),
    ...[...new Set([invoiceId, sessionId].filter((x): x is string => x !== null).map((x) => x.slice(0, 128)))].map((paymentId) =>
      q("INSERT INTO cloud_payment_voids (home_id,payment_id,reason,ref,voided_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING", i.homeId, paymentId, kind, opId, now)),
    // The tombstone carries the seller path the order was taken on (Astra DROPDOWN-DIRECT-1 (3)): a payment that clears later is refunded on
    // that path (Managed Payments: POST /v1/refunds), never the direct credit-note route a consent-less refund would otherwise take.
    ...(i.subscriptionId ? [q("INSERT INTO rejected_subscriptions (subscription_id,at,reason,home_id,cancel_pending) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING",
      i.subscriptionId, now, ownRefusalReason(kind, path), i.homeId, refundNow ? 0 : 1)] : []),
    // Only THIS session's checkout: the home's open checkout of the bound session is never failed by it.
    ...(sessionId ? [q("UPDATE open_checkouts SET state='failed',updated_at=? WHERE home_id=? AND session_id=? AND state<>'failed'", now, i.homeId, sessionId)] : []),
    ...await openOrAddAlertStmts(env, i.homeId, kind === "duplicate" ? "checkout.duplicate_subscription" : "checkout.rejected_consent", `alert:${opId}`, "sessionId",
      { sessionId, reason: i.why ?? "no_consent", subscriptionId: i.subscriptionId, kept: i.kept ?? null, paid: refundNow, refundRequested: refundNow, opId: refundNow ? opId : null }, now),
    // The customer is told too (Astra DROPDOWN-DIRECT-1 (5)), consent-independently: journaled with the refusal for the home's verified
    // account (the notice outbox sends to its contact address), re-rendered from the ledger on every send (refreshedRejectionPayload).
    recordNotice(i.homeId, "order_rejected", opId, { ...unboundRejectionEmail(lang, path, refundNow ? REFUND_PREPARING : null), source }, now),
  ];
  await fencedBatch(env, lease, stmts);
  if (refundNow) await advanceRefundOp(env, ctx, opId);
  else if (i.subscriptionId) {
    try { await confirmRejectedCancel(env, lease, ctx.stripe, i.subscriptionId, now); }
    catch (e) { if (e instanceof LeaseLost) throw e; }
  }
  // The email states the cancellation and the refund as the ledger has them now.
  // A paid order is "being refunded" even before its operation can be read (REFUND_PREPARING): never "nothing was charged".
  const op = refundNow ? (await getRefundOp(env, opId)) ?? REFUND_PREPARING : null;
  try { await notify(env, deps, i.homeId, "order_rejected", opId, { ...unboundRejectionEmail(lang, path, op), source }); }
  catch { /* recorded in the batch above; the sweep retries */ }
  return kind === "duplicate" ? "duplicate_subscription" : "rejected_consent";
}

/** The guard turned this order away (plan §1.1: the renewal dropdown, declared = billing country and path, a country paused after the session
 *  was created). One fenced batch: the consent is marked rejected, the subscription is tombstoned, the refund operation (the kind is the
 *  reason) is opened, THIS order's checkout is released, the retry route is set (mismatch, first rejection only), ops and the customer are told.
 *  Then the ledger cancels the subscription (prorate=false, invoice_now=false) and refunds in full. A payment that has not cleared yet opens no
 *  refund (there is nothing to refund): the subscription is cancelled here, and a payment that clears later is refunded by
 *  async_payment_succeeded or invoice.paid (refundStrandedPayment). Idempotent; a retry touches only this consent's own rows (Astra WP5-1 #9). */
async function rejectOrder(env: Env, deps: BillingDependencies, ctx: RefundContext, c: ConsentRow, i: { verdict: RejectKind; homeId: string; subscriptionId: string | null;
  session: Obj; collected: string | null; paid: boolean;
  /** The order was already provisioned (refundParkedOrder, Astra WP5-3 #1): its service is ended explicitly. The refund operation ends THIS
   *  subscription's plan (endPlan, credits revoked) and the lifecycle is told the payment was cancelled, since the tombstone below suppresses
   *  the customer.subscription.deleted handling that would otherwise do it. */
  endService?: boolean;
  /** A parked order whose subscription no longer owns the home (refundParkedOrder, Astra WP5-5 #1): it is refunded and its OWN subscription
   *  cancelled like any rejection, and ops is told through the home's one checkout.parked_order_released alert instead of the usual one. */
  displaced?: { reason: string; currentSubscriptionId: string | null } }, now: number): Promise<string> {
  const lease = ctx.lease ?? deps.lease!;
  const declared = c.declared_country ?? c.billing_country;
  // The consent is rejected: its acknowledged tax preset is not kept (Astra TAXCOUNTRY-2 P3).
  await fencedRun(env, lease, "DELETE FROM cloud_ops_state WHERE key=?", taxPresetKey(i.homeId));
  const amount = i.paid && typeof i.session.amount_total === "number" ? i.session.amount_total : 0;
  const invoiceId = await sessionInvoiceOf(ctx.stripe, i.session, amount > 0);
  // Astra DROPDOWN-DIRECT-2 (1): paid is refunded, whether or not the invoice is known yet (recovered by the ledger, see refuseUnboundOrder).
  const refundable = amount > 0;
  const opId = await refusalOpId(env, i.homeId, i.verdict, invoiceId, i.subscriptionId, `${i.verdict}:${invoiceId ?? i.subscriptionId ?? str(i.session.id) ?? c.id}`);
  const first = c.rejected_at === null;
  const sessionId = str(i.session.id);
  const seller = (() => { try { return i.collected ? sellerFor(sellerSettings(env), i.collected) : null; } catch { return null; } })();
  const source: RejectionSource = { consentId: c.id, opId: refundable ? opId : null, verdict: i.verdict, collected: i.collected, invoiceId, subscriptionId: i.subscriptionId };
  const alert: Q[] = i.displaced
    ? await openOrAddAlertStmts(env, i.homeId, "checkout.parked_order_released", `alert:parked_released:${c.id}`, "consentId",
      // The refund is REQUESTED here, before Stripe is asked (Astra WP5-6 #4): whether it completed is read from the ledger (refund_ops, by
      // opId) when the alert is sent, never stored in the alert.
      { consentId: c.id, reason: i.displaced.reason, subscriptionId: i.subscriptionId, currentSubscriptionId: i.displaced.currentSubscriptionId, opId: refundable ? opId : null,
        refundRequested: refundable }, now)
    // Every rejection kind (checkout.mismatch and the rest) goes through the same helper: the home keeps one open alert per kind, so a second
    // rejected order is added to that alert's list instead of being dropped (Astra WP5-7 #5).
    : await openOrAddAlertStmts(env, i.homeId, `checkout.${i.verdict}`, `alert:${opId}`, "consentId",
      { consentId: c.id, declared, collected: i.collected, subscriptionId: i.subscriptionId, paid: refundable, opId }, now);
  const stmts: Q[] = [
    ...(refundable ? [refundOpInsert({ id: opId, kind: i.verdict, homeId: i.homeId, userId: c.user_id, invoiceId, paidCents: amount, targetCents: amount, endPlan: i.endService === true,
      cancelSubscriptionId: i.subscriptionId, subscriptionId: i.subscriptionId, detail: { path: refundPathOf(c), ...(i.endService ? { revoke: true, consentId: c.id } : {}),
        ...(invoiceId ? {} : { sessionId: str(i.session.id) ?? undefined }) } }, now)] : []),
    // A provisioned order's server is stopped through the lifecycle, as a cancelled payment (the same inbox every payment state goes through).
    ...(i.endService ? [(() => {
      const eventId = `reject:${opId}`.slice(0, 200);
      const payload = { eventId, homeId: i.homeId, version: versionFor(Math.floor(now / 1000), "canceled"), status: "canceled", paymentId: (invoiceId ?? sessionId ?? opId).slice(0, 128),
        ...(i.subscriptionId ? { subscriptionId: i.subscriptionId.slice(0, 128) } : {}) };
      return q("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL) ON CONFLICT(id) DO NOTHING", eventId, i.homeId, payload.version, JSON.stringify(payload), now);
    })()] : []),
    q("UPDATE checkout_consents SET rejected_at=COALESCE(rejected_at,?),rejected_reason=COALESCE(rejected_reason,?) WHERE id=?", now, i.verdict, c.id),
    // The subscription this refused order created is recorded with its consent (an order refused before its completion was attached has
    // none yet), so a payment that clears later is refunded under the consent's own refusal (consentOfSubscription). Never replaces one.
    ...(i.subscriptionId ? [q("UPDATE checkout_consents SET stripe_subscription_id=COALESCE(stripe_subscription_id,?) WHERE id=?", i.subscriptionId, c.id)] : []),
    // A rejected first purchase closes its authorization for good (never reopened by a refund or a retried event).
    bootstrapTransitionQ("closed", PRE_PAYMENT, { homeId: i.homeId, consentId: c.id, now, reason: i.verdict }),
    // Astra WP5-6 #1: this order's payment can never provision the home. Its invoice and its checkout session (the ids a "paid" lifecycle
    // entry names) are tombstoned for this home only; the lifecycle skips such an entry, whenever it was written. Another order's payment
    // (a replacement's) is never named here.
    ...[...new Set([invoiceId, sessionId].filter((x): x is string => x !== null).map((x) => x.slice(0, 128)))].map((paymentId) =>
      q("INSERT INTO cloud_payment_voids (home_id,payment_id,reason,ref,voided_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING", i.homeId, paymentId, i.verdict, opId, now)),
    // Astra WP5-6 #2: credits granted for THIS invoice are taken back when its payment is refunded. One reversal per grant (invoice, kind) is
    // journaled here, from credit_grants; none when nothing was granted. It is executed after the batch (reverseCredits) and retried by the
    // sweep, independently of the refund, which goes ahead regardless. An order whose service is ended (endService) has its plan's credits
    // revoked by its refund operation instead, so it is not journaled twice.
    // Astra JOURNEY-A-8 #3: when the order's money is refunded (refundable), the reversal is REFUND-BACKED: a final versioned target per grant
    // (finalTargetsQ) that follows the money actually returned, so a refund that later fails or needs action gives the credit back. With no
    // money to return it stays the one-shot final reversal.
    ...(!i.endService && invoiceId ? [refundable ? finalTargetsQ(invoiceId, null, i.verdict, opId, now)
      : q(`INSERT OR IGNORE INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at)
      SELECT invoice_id,kind,home_id,?,NULL,? FROM credit_grants WHERE invoice_id=?`, i.verdict, now, invoiceId)] : []),
    // The tombstone. An unpaid order's cancellation is journaled with it (cancel_pending) BEFORE Stripe is asked (Astra WP5-3 #2): the sweep
    // retries it until Stripe confirms. A paid order's cancellation belongs to its refund operation, which retries it the same way.
    ...(i.subscriptionId ? [q("INSERT INTO rejected_subscriptions (subscription_id,at,reason,home_id,cancel_pending) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING",
      i.subscriptionId, now, i.verdict, i.homeId, refundable ? 0 : 1)] : []),
    // Only this order's own checkout: a newer attempt the customer started meanwhile is never failed by a retried rejection.
    q("UPDATE open_checkouts SET state='failed',updated_at=? WHERE home_id=? AND (consent_id=? OR (session_id IS NOT NULL AND session_id=?)) AND state<>'failed'",
      now, i.homeId, c.id, sessionId),
    // The retry route (plan §1.2): from Stripe's collected country only, so the next reserve pre-fills the country line with it. Written on the
    // original rejection only; a retried event never rewrites a route the customer may already have moved on from. An address_change route
    // (WP6) is never replaced by a mismatch route: the running plan it names still needs its replacement.
    ...(first && i.verdict === "mismatch" && i.collected && seller ? [q(`INSERT INTO checkout_retry_routes (account_id,seller,collected_country,reason,replaces_subscription_id,expires_at)
      VALUES (?,?,?,'mismatch',NULL,?) ON CONFLICT(account_id) DO UPDATE SET seller=excluded.seller,collected_country=excluded.collected_country,
      reason=CASE WHEN checkout_retry_routes.reason='address_change' THEN 'address_change' ELSE 'mismatch' END,
      replaces_subscription_id=CASE WHEN checkout_retry_routes.reason='address_change' THEN checkout_retry_routes.replaces_subscription_id ELSE NULL END,
      expires_at=MAX(excluded.expires_at,checkout_retry_routes.expires_at)`, c.user_id, seller, i.collected.toUpperCase(), now + 7 * DAY_MS)] : []),
    ...alert,
    recordNotice(i.homeId, "order_rejected", opId, { ...rejectionEmail(c, i.verdict, i.collected, refundable ? REFUND_PREPARING : null), source }, now),
  ];
  await fencedBatch(env, lease, stmts);
  if (refundable) await advanceRefundOp(env, ctx, opId);
  // The credit reversal journaled above: a failure here never stops the refund or the rejection; the sweep retries it.
  if (!i.endService) {
    try { await reverseCredits(env, lease, ctx.flux, i.homeId, now); }
    catch (e) { if (e instanceof LeaseLost) throw e; }
  }
  if (!refundable && i.subscriptionId) {
    // A cancellation that fails here stays journaled: it never undoes the rejection, and never takes the order out of the retry.
    try { await confirmRejectedCancel(env, lease, ctx.stripe, i.subscriptionId, now); }
    catch (e) { if (e instanceof LeaseLost) throw e; }
  }
  // The email states the refund as the ledger has it now (being prepared, sent, processed or delayed).
  const op = refundable ? (await getRefundOp(env, opId)) ?? REFUND_PREPARING : null;
  try { await notify(env, deps, i.homeId, "order_rejected", opId, { ...rejectionEmail(c, i.verdict, i.collected, op), source }); }
  catch { /* recorded in the batch above; the sweep retries */ }
  return i.verdict;
}

/** A reversal that makes its grant FINAL (alias r): never asked for again. The legacy unversioned reversal (scope 'full': no money behind it),
 *  and since Astra JOURNEY-A-8 #3 a lane B refund-backed reversal (a turned-away order's, an unserved renewal's): a versioned target that
 *  follows the money actually returned (final=1), never /reverse. */
const FINAL_REV = "(r.scope='full' OR r.final=1)";
/** Astra JOURNEY-A-8 #3: a lane B refund-backed reversal of every grant of `invoiceId` (optionally of one home), journaled with its refund
 *  operation: a FINAL versioned target at revision 1 with no coverage yet (removes nothing until the operation's money is returned; the
 *  operation then puts its payment under coverage reconciliation, legal-refunds). An existing coverage target of the grant becomes final;
 *  a legacy full reversal is kept. */
export const finalTargetsQ = (invoiceId: string, homeId: string | null, reason: string, opId: string, now: number): Q =>
  q(`INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at,scope,final,target_revision)
    SELECT invoice_id,kind,home_id,?,?,?,'target',1,1 FROM credit_grants WHERE invoice_id=? AND (? IS NULL OR home_id=?)
    ON CONFLICT(invoice_id,kind) DO UPDATE SET final=1,op_id=COALESCE(credit_reversals.op_id,excluded.op_id) WHERE credit_reversals.scope='target'`,
    reason, opId, now, invoiceId, homeId, homeId);
/** Monthly credit, once per invoice and kind (Astra WP5-3 #3): Stripe may report one invoice in several distinct events, and an event may be
 *  retried after an interruption. The claim is recorded (fenced) before B4 is asked; the grant's record joins `extra` in ONE fenced batch
 *  afterwards. An invoice whose grant is recorded is never granted again (true: granted by this call). A B4 failure never fails the caller:
 *  `extra` (the period and status) is still written, the grant stays claimed and ungranted, and the billing sweep retries it
 *  (retryPendingGrants). Service active with credits pending is the intended state, as for any transient B4 failure. A B4 failure is ONLY a
 *  FluxHookRetry (the hooks' error contract): a D1 failure, a lost lease or any other throw, in the hook or around it, propagates and
 *  nothing of `extra` is written. `subscriptionId`: the subscription the invoice belongs to (the
 *  caller has just checked it owns the home and has not ended); the sweep asks again only while it still does. */
export async function grantOnce(env: Env, lease: HomeLease, flux: FluxEntitlementHooks, input: GrantInput, subscriptionId: string | null, now: number,
  extra: Q[] = []): Promise<boolean> {
  const kind = input.kind ?? "period";
  const held = await env.DB.prepare("SELECT granted_at,suppressed_reason FROM credit_grants WHERE invoice_id=? AND kind=?").bind(input.invoiceId, kind)
    .first<{ granted_at: number | null; suppressed_reason: string | null }>();
  // The router said this grant was reversed before it was applied (not_applied_reversed): that is FINAL (Astra WP5-P4-CP #7). A duplicate
  // invoice event neither clears the suppression nor asks again; only the caller's other writes are made.
  if (held?.granted_at == null && held?.suppressed_reason === "not_applied_reversed") {
    await fencedBatch(env, lease, extra);
    return false;
  }
  // A grant whose invoice was refunded and its reversal journaled (Astra WP5-6 #2) is never asked for again.
  // Astra JOURNEY-B-3 #6: the same barrier the plan propagation uses (invoiceReversed).
  const reversed = await invoiceReversed(env, input.invoiceId, kind);
  const due = held?.granted_at == null && !reversed;
  if (due) {
    // The claim keeps what the sweep needs to ask B4 again with the same input, for the same subscription (migration 0082). The caller has
    // just checked that subscription is live, so a claim suppressed earlier (its input was missing) is runnable again.
    // D1 (WP5-P4): the canonical body (amount, recipient, expiry) is frozen INTO the claim here, once. A body already frozen is never replaced
    // (COALESCE below), so a configuration change between attempts cannot change what is resent.
    // Built from the claim's own facts only (no clock); held (NULL) when it cannot be built yet, e.g. no unfenced Flux link.
    const built = grantsConfigured(env) ? await composeFrozenBody(env, { ...input, kind: kind as "period" | "upgrade_delta" }) : null;
    const frozen = built && !isHold(built) ? built : null;
    await fencedRun(env, lease, `INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,period_start,period_end,previous_plan,subscription_id,body_json,body_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(invoice_id,kind) DO UPDATE SET body_json=COALESCE(credit_grants.body_json,excluded.body_json),
      body_sha256=CASE WHEN credit_grants.body_json IS NULL THEN excluded.body_sha256 ELSE credit_grants.body_sha256 END,
      period_start=COALESCE(credit_grants.period_start,excluded.period_start),
      period_end=COALESCE(credit_grants.period_end,excluded.period_end),previous_plan=COALESCE(credit_grants.previous_plan,excluded.previous_plan),
      subscription_id=COALESCE(credit_grants.subscription_id,excluded.subscription_id),
      suppressed_at=CASE WHEN credit_grants.suppressed_reason='not_applied_reversed' THEN credit_grants.suppressed_at ELSE NULL END,
      suppressed_reason=CASE WHEN credit_grants.suppressed_reason='not_applied_reversed' THEN credit_grants.suppressed_reason ELSE NULL END`,
      input.invoiceId, kind, input.homeId, input.plan, now, input.periodStart, input.periodEnd, input.previousPlan ?? null, subscriptionId,
      frozen?.json ?? null, frozen?.sha256 ?? null);
    return askGrant(env, lease, flux, input, kind, now, extra);
  }
  // A reversed grant is not recorded as granted here: only the caller's other writes are made.
  await fencedBatch(env, lease, [...(reversed ? [] : [q("UPDATE credit_grants SET granted_at=COALESCE(granted_at,?) WHERE invoice_id=? AND kind=?", now, input.invoiceId, kind)]),
    ...heldAlertSync(input.homeId, now), ...extra]);
  return false;
}

type GrantInput = Parameters<FluxEntitlementHooks["grantMonthlyCredits"]>[1];
/** A claim or reversal still pending this long after it was made reaches ops, whatever its attempts (Astra STUB-3 #2). */
const PENDING_ALERT_MS = 2 * 3_600_000;
/** The home's ONE credit.grant_pending alert, rebuilt from credit_grants inside the caller's fenced batch (Astra STUB-1 #4, #5), after the
 *  batch's own grant write. A claim that is ungranted and either suppressed, failed 3 times or answered flux_not_wired is ESCALATED: its
 *  alerted_at is stamped in the same batch, and from then on it stays listed whatever its later errors (Astra STUB-2 #3) until it is granted,
 *  its reversal is CONFIRMED by B4 (reversed_at set; a journaled, unconfirmed reversal keeps it listed, Astra STUB-2 #4), or ops clears it
 *  explicitly (alerted_at=NULL, cleared_at=now, cleared_tries=tries: migration 0082; a cleared claim is listed again only after a new failed
 *  ask or a later suppression, Astra STUB-3 #3) (detail.grantIds, detail.grants with each one's error). A changed list bumps detail.revision and is delivered
 *  again (the WP5-6 #3 rule); the alert is resolved only when the list is empty. Being in the fenced batch, a worker whose lease is gone
 *  can never leave an alert behind. */
const GRANT_ALERT_WITH = `WITH o AS (SELECT c.invoice_id AS i,c.kind AS k,CASE WHEN c.suppressed_reason IS NOT NULL THEN c.suppressed_reason
    WHEN c.tries-c.attempts>=3 THEN 'infra_failing' WHEN c.last_error IS NOT NULL THEN c.last_error
    WHEN c.claimed_at<=?2-${PENDING_ALERT_MS} THEN 'pending_too_long' ELSE 'error' END AS e FROM credit_grants c
    WHERE c.home_id=?1 AND c.granted_at IS NULL AND c.alerted_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM credit_reversals r WHERE r.invoice_id=c.invoice_id AND r.kind=c.kind AND r.reversed_at IS NOT NULL AND ${FINAL_REV})
    ORDER BY c.claimed_at,c.invoice_id,c.kind),
  d AS (SELECT COUNT(*) AS n,json_group_array(i||':'||k) AS ids,json_group_array(json_object('invoiceId',i,'kind',k,'error',e)) AS items FROM o)`;
/** last_error prefix of a LOCAL hold (Astra WP5-P4-CP-2 #3): the claim could not be given a frozen body (recipient_unlinked, a pooled or
 *  unknown plan, an invalid catalogue, ...) or the hook found none (grant_body_missing). Nothing is dispatched, so it is not an ask: tries and
 *  attempts stay as they were, only the scheduling stamp moves; the sweep still revisits it (it stays runnable). */
const HELD = "grant_held:";
/** The home's ONE credit.grant_held alert, reconciled from credit_grants (Astra WP5-P4-CP-2 #4): its detail lists the claims held NOW
 *  (detail.grantId/reason: the oldest; detail.grantIds, detail.grants), a changed list bumps detail.revision and is delivered again, and it is
 *  resolved as soon as none is held (linked and granted, suppressed, or its reversal journaled), so a later hold opens a fresh alert with its
 *  own details. */
const HELD_ALERT_WITH = `WITH h AS (SELECT c.invoice_id||':'||c.kind AS id,substr(c.last_error,${HELD.length + 1}) AS reason FROM credit_grants c
    WHERE c.home_id=?1 AND c.granted_at IS NULL AND c.suppressed_at IS NULL AND substr(COALESCE(c.last_error,''),1,${HELD.length})='${HELD}'
    AND NOT EXISTS (SELECT 1 FROM credit_reversals r WHERE r.invoice_id=c.invoice_id AND r.kind=c.kind AND ${FINAL_REV})
    ORDER BY c.claimed_at,c.invoice_id,c.kind),
  hd AS (SELECT COUNT(*) AS n,json_group_array(id) AS ids,json_group_array(json_object('grantId',id,'reason',reason)) AS items,
    (SELECT id FROM h LIMIT 1) AS fid,(SELECT reason FROM h LIMIT 1) AS freason FROM h)`;
const heldAlertSync = (homeId: string, now: number): Q[] => [
  q(`${HELD_ALERT_WITH} UPDATE cloud_alerts SET detail=(SELECT json_object('grantId',fid,'reason',freason,'grantIds',json(ids),'grants',json(items),
    'revision',COALESCE(json_extract(cloud_alerts.detail,'$.revision'),0)+1) FROM hd),delivered_at=NULL,delivery_attempts=0
    WHERE home_id=?1 AND kind='credit.grant_held' AND resolved_at IS NULL AND (SELECT n FROM hd)>0
    AND COALESCE(json_extract(detail,'$.grants'),'')<>(SELECT items FROM hd)`, homeId),
  q(`${HELD_ALERT_WITH} UPDATE cloud_alerts SET resolved_at=?2 WHERE home_id=?1 AND kind='credit.grant_held' AND resolved_at IS NULL
    AND (SELECT n FROM hd)=0`, homeId, now),
  q(`${HELD_ALERT_WITH} INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at)
    SELECT ?3,?1,'credit.grant_held','high',json_object('grantId',fid,'reason',freason,'grantIds',json(ids),'grants',json(items)),?2 FROM hd
    WHERE n>0 AND NOT EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.home_id=?1 AND a.kind='credit.grant_held' AND a.resolved_at IS NULL)`,
    homeId, now, `alert:credit_grant_held:${homeId}:${crypto.randomUUID()}`),
];
const grantAlertSync = (homeId: string, now: number): Q[] => [
  // Escalation. Uncleared: suppressed, 3 B4 failures, flux_not_wired, 3 infrastructure failures (tries-attempts: asks that ended in neither
  // a grant nor a FluxHookRetry, Astra STUB-3 #2) or ungranted PENDING_ALERT_MS after the claim (not one whose reversal is journaled: that
  // has its own alert). Cleared by ops (cleared_at, Astra STUB-3 #3): only a failed ask after the clearance or a later suppression.
  // A claim HELD locally (last_error 'grant_held:<why>': no body can be frozen yet, nothing was asked) is never escalated here: it has its own
  // credit.grant_held alert (heldAlertSync) and is no B4 failure. The age arm needs the claim VISITED once (last_attempt_at, Astra
  // WP5-P4-CP-3 #2): an untried claim (an interruption right after its INSERT) is never escalated by age before askGrant has classified it
  // as held or not; its own ask's pre-call rebuild runs before its stamp, and its outcome rebuild after. An earlier escalation stays.
  q(`UPDATE credit_grants SET alerted_at=?2 WHERE home_id=?1 AND alerted_at IS NULL AND granted_at IS NULL
    AND substr(COALESCE(last_error,''),1,${HELD.length})<>'${HELD}'
    AND CASE WHEN cleared_at IS NULL THEN (suppressed_at IS NOT NULL OR attempts>=3 OR last_error='flux_not_wired' OR tries-attempts>=3
      OR (claimed_at<=?2-${PENDING_ALERT_MS} AND last_attempt_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM credit_reversals r WHERE r.invoice_id=credit_grants.invoice_id AND r.kind=credit_grants.kind AND ${FINAL_REV})))
    ELSE (tries>COALESCE(cleared_tries,0) OR COALESCE(suppressed_at,0)>cleared_at) END`, homeId, now),
  q(`${GRANT_ALERT_WITH} UPDATE cloud_alerts SET detail=json_object('grantIds',json((SELECT ids FROM d)),'grants',json((SELECT items FROM d)),
    'revision',COALESCE(json_extract(detail,'$.revision'),0)+1),delivered_at=NULL,delivery_attempts=0
    WHERE home_id=?1 AND kind='credit.grant_pending' AND resolved_at IS NULL AND (SELECT n FROM d)>0
    AND COALESCE(json_extract(detail,'$.grants'),'')<>(SELECT items FROM d)`, homeId, now),
  q(`${GRANT_ALERT_WITH} UPDATE cloud_alerts SET resolved_at=?2 WHERE home_id=?1 AND kind='credit.grant_pending' AND resolved_at IS NULL
    AND (SELECT n FROM d)=0`, homeId, now),
  q(`${GRANT_ALERT_WITH} INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at)
    SELECT ?3,?1,'credit.grant_pending','high',json_object('grantIds',json(ids),'grants',json(items)),?2 FROM d
    WHERE n>0 AND NOT EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.home_id=?1 AND a.kind='credit.grant_pending' AND a.resolved_at IS NULL)`,
    homeId, now, `alert:credit_grant:${homeId}:${crypto.randomUUID()}`),
  ...heldAlertSync(homeId, now),
];
/** Asks B4 for one claimed grant under the home's lease. Before the hook is invoked, the claim's scheduling stamp (last_attempt_at) is
 *  written in its own fenced write, apart from attempt accounting (Astra STUB-2 #2): a claim whose ask then fails on infrastructure has still
 *  moved to the back of its home's queue, and its home behind the homes not tried yet, so the next sweep takes other claims and homes first.
 *  Only a FluxHookRetry counts as a failed attempt (Astra STUB-2 #1, the hooks' error contract); every other throw (a lost lease, a D1
 *  failure inside or around the hook) propagates, so the caller's event or sweep fails and is retried with no attempt recorded. Granted ONLY
 *  when the hook resolved. Either way ONE fenced batch records the outcome (granted, or attempts/last_error), the home's alert and `extra`.
 *  True: granted now. */
async function askGrant(env: Env, lease: HomeLease, flux: FluxEntitlementHooks, input: GrantInput, kind: string, now: number,
  extra: Q[]): Promise<boolean> {
  await fence(env, lease);
  // The alert is rebuilt BEFORE this ask is counted (tries): tries-attempts is then exactly the asks that failed on infrastructure, which
  // record no outcome of their own, so 3 of them (or the claim's age) reach ops even while every ask keeps failing raw (Astra STUB-3 #2).
  await fencedBatch(env, lease, [...grantAlertSync(input.homeId, now),
    q("UPDATE credit_grants SET last_attempt_at=?,tries=tries+1 WHERE invoice_id=? AND kind=?", now, input.invoiceId, kind)]);
  let code: string | null = null;
  let suppressed = false;
  let held: string | null = null;
  let bodyHold: string | null = null;
  // D1 rebuild (Astra WP5-P4-CP #1, #5): with the grants client configured, a claim with no frozen body (a claim from the fail-closed stub,
  // or one held for want of a Flux link) gets it rebuilt from its own recorded facts, written ONCE under the lease and never over an existing
  // body. One that still cannot be built is HELD: no router call, one alert. The token guard comes first: absent, nothing is dispatched.
  // Astra JOURNEY-A-10 #1: Flux off (stub or unqualified hooks): HELD before anything else, the hook is never invoked.
  const fluxOff = !fluxDispatchEnabled(flux);
  const guard = !fluxOff && grantsConfigured(env) ? await grantsGuard(env, "grantMonthlyCredits", now) : null;
  if (fluxOff) bodyHold = "flux_off";
  else if (guard) code = guard;
  else if (grantsConfigured(env)) {
    // Lane H1, item 1: an owner with no Flux link gets its Flux account ensured (and the link written) before the first grant. A refusal is
    // alerted and nothing is dispatched (the claim stays held for want of a link); a 5xx or timeout leaves it held, retried by the sweep.
    if (flux.ensureAccount) await flux.ensureAccount(env, { homeId: input.homeId });
    bodyHold = await ensureFrozenBody(env, lease, input, kind, now);
  }
  // Astra JOURNEY-A-7 #3 / A-8 #2: a grant whose payment has money returned (a refund-driven target with coverage) is never published at its
  // full balance, not even for one request: it goes out WITH its latest target in ONE request (initial_target, applied by the router in the
  // grant's own transaction), never grant-then-target. Without a router qualified for targets, or one not advertising grantWithTarget on
  // THIS publish (the hook asks every time; a downgrade mid-flight is refused before any state change), it is HELD here with an alert.
  const st = await env.DB.prepare(`SELECT g.delivery_state AS ds,g.body_json AS body,r.target_revision AS rev,r.covered_cents AS c,r.paid_cents AS p FROM credit_grants g
    LEFT JOIN credit_reversals r ON r.invoice_id=g.invoice_id AND r.kind=g.kind AND r.scope='target' AND COALESCE(r.covered_cents,0)>0 WHERE g.invoice_id=? AND g.kind=?`)
    .bind(input.invoiceId, kind).first<{ ds: string | null; body: string | null; rev: number | null; c: number | null; p: number | null }>();
  const refundTarget = st?.rev != null;
  let initialTarget: { targetRemovedMicrocents: number; revision: number } | null = null;
  if (code === null && bodyHold === null && refundTarget) {
    const t = reversalTargetsEnabled(flux) ? reversalTarget(st!.body, st!.c ?? 0, st!.p ?? 0) : null;
    if (!reversalTargetsEnabled(flux)) bodyHold = "reversal_target_pending";
    else if (t === null) bodyHold = "reversal_target_unknown";
    else initialTarget = { targetRemovedMicrocents: t, revision: Math.max(1, st!.rev!) };
  }
  if (bodyHold) code = `${HELD}${bodyHold}`.slice(0, 80);
  // Astra JOURNEY-A-8 #1: from here the ask may reach the router. Its delivery is AMBIGUOUS until the router answers definitively: stamped
  // before the call (fenced), so a lost response, a timeout or a crash leaves it ambiguous; only an answer that nothing was applied (a 409, a
  // refusal before dispatch) restores what it was. A 503 keeps it ambiguous: the router may have committed and lost its acknowledgement.
  const prevDelivery = st?.ds === "ambiguous" ? "ambiguous" : st?.ds === "dispatched" ? "dispatched" : null;
  let delivery: string | null = prevDelivery;
  let receipt: TargetReceipt | null = null;
  if (code === null) {
    await fencedBatch(env, lease, [q("UPDATE credit_grants SET delivery_state='ambiguous' WHERE invoice_id=? AND kind=? AND granted_at IS NULL", input.invoiceId, kind),
      // The target travels with the grant: the same pre-call stamp a target ask gets (sent_revision, target_microcents), due until its receipt.
      ...(initialTarget ? [q(`UPDATE credit_reversals SET last_attempt_at=?,tries=tries+1,sent_revision=MAX(COALESCE(sent_revision,0),?),target_microcents=?,reversed_at=NULL
        WHERE invoice_id=? AND kind=? AND scope='target' AND target_revision=?`, now, initialTarget.revision, initialTarget.targetRemovedMicrocents, input.invoiceId, kind,
        initialTarget.revision)] : [])]);
    delivery = "ambiguous";
    try {
      // D2 (WP5-P4): the real client resolves the router's {status}; a hook that resolves with nothing (the test doubles, the B4 in-process
      // hooks) means granted. not_applied_reversed is the router saying the grant was reversed first: it is NOT stamped.
      const answer = await flux.grantMonthlyCredits(env, { ...input, ...(initialTarget ? { initialTarget } : {}) }, { lease });
      const a = (typeof answer === "object" && answer !== null ? answer : {}) as { status?: unknown; target?: TargetReceipt };
      suppressed = a.status === "not_applied_reversed";
      if (initialTarget && a.target && a.target.grantId === creditGrantId(input.invoiceId, kind)) receipt = a.target;
    } catch (e) {
      if (!(e instanceof FluxHookRetry)) throw e;
      code = e.code.slice(0, 80);
      if (e instanceof FluxGrantHeld) { held = e.routerCode; delivery = prevDelivery === "ambiguous" ? "ambiguous" : "dispatched"; }
      // Nothing was dispatched (the guard, no frozen body) or the router refused it before any state change (initial_target unsupported):
      // a local hold like the ones above, the grant never sent without its target.
      if (e instanceof FluxNotDispatched || e instanceof FluxGrantTargetUnsupported) {
        delivery = e instanceof FluxGrantTargetUnsupported && code.startsWith("router_400") && prevDelivery !== "ambiguous" ? "dispatched" : prevDelivery;
        if (code === "grant_body_missing" || e instanceof FluxGrantTargetUnsupported) {
          bodyHold = e instanceof FluxGrantTargetUnsupported ? "grant_with_target_unavailable" : code; code = `${HELD}${bodyHold}`.slice(0, 80);
        }
      }
    }
  }
  const grantId = creditGrantId(input.invoiceId, kind);
  // Astra JOURNEY-A-9 #1: the grant's answer carries the receipt of the revision the router HOLDS, which may be an older or conflicting one
  // (a replay after journal recovery: the router holds revision 1 at 0 while this asks revision 1 at 49,000,000). It settles the target ONLY
  // when the revision AND the target held are exactly what was asked. A receipt naming another revision or another target is a CONFLICT:
  // never settled, the row's revision moves above the router's and the target is re-sent through /reversal-target (reverseCredits). One
  // that does not say which target it holds settles nothing either: /reversal-target confirms it (a conflict there is a 409).
  const landed = code === null && !suppressed;
  const receiptMatches = receipt !== null && initialTarget !== null && receipt.revision === initialTarget.revision
    && receipt.targetRemovedMicrocents === initialTarget.targetRemovedMicrocents;
  const receiptConflict = receipt !== null && initialTarget !== null && !receiptMatches
    && (receipt.revision !== initialTarget.revision || receipt.targetRemovedMicrocents !== undefined);
  const settleTarget = landed && receiptMatches;
  await fencedBatch(env, lease, [
    suppressed
      // Never asked again (suppressed_at takes it out of the sweep), listed in the home's pending-grant alert, and its own alert.
      ? q("UPDATE credit_grants SET suppressed_at=?,suppressed_reason='not_applied_reversed',last_error=NULL,last_attempt_at=?,alerted_at=COALESCE(alerted_at,?) WHERE invoice_id=? AND kind=? AND granted_at IS NULL",
        now, now, now, input.invoiceId, kind)
      : code === null
      ? q("UPDATE credit_grants SET granted_at=COALESCE(granted_at,?),last_error=NULL,last_attempt_at=? WHERE invoice_id=? AND kind=?", now, now, input.invoiceId, kind)
      : bodyHold !== null
      // A LOCAL hold is not an ask (Astra WP5-P4-CP-2 #3): the pre-call tries+1 is taken back in this same outcome write (an outcome write that
      // never lands leaves it counted, as for any ask that failed raw), attempts is untouched, last_attempt_at keeps the fairness stamp.
      ? q("UPDATE credit_grants SET tries=MAX(tries-1,0),last_error=?,delivery_state=? WHERE invoice_id=? AND kind=? AND granted_at IS NULL", code, delivery, input.invoiceId, kind)
      : q("UPDATE credit_grants SET attempts=attempts+1,last_error=?,delivery_state=? WHERE invoice_id=? AND kind=? AND granted_at IS NULL", code, delivery, input.invoiceId, kind),
    ...(suppressed ? [alertQ(input.homeId, "credit.grant_suppressed", `alert:credit_grant_suppressed:${grantId}`, { grantId, reason: "not_applied_reversed" }, now)] : []),
    ...(held !== null ? [alertQ(input.homeId, "credit.grant_review", `alert:credit_grant_review:${grantId}`, { grantId, routerStatus: held }, now)] : []),
    // A landed grant's refund target is due again at a new revision (one settled while the grant had not landed removed nothing there).
    ...(code === null && !suppressed ? [q(`UPDATE credit_reversals SET target_revision=target_revision+1,reversed_at=NULL WHERE invoice_id=? AND kind=? AND scope='target'
      AND reversed_at IS NOT NULL AND COALESCE(covered_cents,0)>0`, input.invoiceId, kind)] : []),
    // The router's receipt for the target it applied in the grant's own transaction: settled only while that revision is still the latest.
    ...(settleTarget ? [q(`UPDATE credit_reversals SET applied_revision=?,removed_microcents=?,target_microcents=?,reversed_at=?,last_error=NULL WHERE invoice_id=? AND kind=?
      AND scope='target' AND target_revision=?`, receipt!.revision, receipt!.removedMicrocents, receipt!.targetRemovedMicrocents!, now, input.invoiceId, kind, receipt!.revision),
      q("UPDATE cloud_alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL", now, `alert:credit_reversal:${input.invoiceId}:${kind}`)] : []),
    // A conflicting receipt: the row is due again ABOVE the revision the router holds (never complete), and ops is told.
    ...(landed && receiptConflict ? [q(`UPDATE credit_reversals SET target_revision=MAX(target_revision,?),reversed_at=NULL,last_error='receipt_target_conflict'
      WHERE invoice_id=? AND kind=? AND scope='target'`, receipt!.revision + 1, input.invoiceId, kind),
      ...reversalAlertQs(input.homeId, input.invoiceId, kind, "receipt_target_conflict", now)] : []),
    // A receipt that names this revision but not its target: due, confirmed by /reversal-target on the next pass (no alert: not a fault).
    ...(landed && receipt !== null && !receiptMatches && !receiptConflict ? [q(`UPDATE credit_reversals SET last_error='receipt_target_unconfirmed'
      WHERE invoice_id=? AND kind=? AND scope='target' AND reversed_at IS NULL`, input.invoiceId, kind)] : []),
    // Granted with a target but no receipt for it (a hook that does not answer one): the target stays due (sent by reverseCredits) and ops is told.
    ...(initialTarget && landed && receipt === null ? reversalAlertQs(input.homeId, input.invoiceId, kind, "grant_target_unconfirmed", now) : []),
    ...grantAlertSync(input.homeId, now), ...extra]);
  return code === null && !suppressed;
}
/** The claim's frozen body, rebuilt once if it is missing (fenced, write-once: `body_json IS NULL`, so an existing body is never replaced).
 *  Null: the claim has a body now. Otherwise why it is held. */
async function ensureFrozenBody(env: Env, lease: HomeLease, input: GrantInput, kind: string, now: number): Promise<string | null> {
  const row = await env.DB.prepare("SELECT body_json,last_error FROM credit_grants WHERE invoice_id=? AND kind=?").bind(input.invoiceId, kind)
    .first<{ body_json: string | null; last_error: string | null }>();
  // A claim HELD earlier whose hold no longer applies (Astra WP5-P4-CP-3 #1) loses its marker under the lease BEFORE it is dispatched, and
  // the home's credit.grant_held alert is reconciled in the same fenced batch: a raw failure of the ask that follows then counts as one
  // (tries-attempts, escalation), never hidden behind the obsolete hold. The outcome write still records any FluxHookRetry as before.
  const unhold = row?.last_error?.startsWith(HELD)
    ? [q("UPDATE credit_grants SET last_error=NULL WHERE invoice_id=? AND kind=? AND granted_at IS NULL AND substr(COALESCE(last_error,''),1,?)=?",
      input.invoiceId, kind, HELD.length, HELD), ...heldAlertSync(input.homeId, now)]
    : [];
  if (row?.body_json) { if (unhold.length) await fencedBatch(env, lease, unhold); return null; }
  const built = await composeFrozenBody(env, { ...input, kind: kind === "upgrade_delta" ? "upgrade_delta" : "period" });
  if (isHold(built)) return built.held;
  await fencedBatch(env, lease, [q("UPDATE credit_grants SET body_json=?,body_sha256=? WHERE invoice_id=? AND kind=? AND body_json IS NULL AND granted_at IS NULL",
    built.json, built.sha256, input.invoiceId, kind), ...unhold]);
  return null;
}
/** One alert row, never a second for the same id (and the per-home open-alert index keeps one open per kind). */
const alertQ = (homeId: string, kind: string, id: string, detail: unknown, now: number): Q =>
  q("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING", id, homeId, kind, "high", JSON.stringify(detail), now);
/** A NEW suppression lists its claim in the same fenced write (alerted_at set directly, Astra STUB-4 #3), never by comparing the sweep's cached
 *  time with cleared_at: a clearance that landed while the sweep was in flight cannot hide it. */
/** A claim the sweep may ask B4 again for (alias g): ungranted, not suppressed, and none whose reversal is journaled. */
const GRANT_RUNNABLE = `g.granted_at IS NULL AND g.suppressed_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM credit_reversals r WHERE r.invoice_id=g.invoice_id AND r.kind=g.kind AND ${FINAL_REV})`;
/** Asks B4 again for this home's claimed-but-ungranted grants (a failed or interrupted grantOnce), under the home's lease, from the billing
 *  sweep: the 20 least recently tried first, so claims that keep failing never starve a newer one (Astra STUB-1 #3). A claim's stamp is
 *  written before B4 is asked, so one that fails on infrastructure (which ends this home's pass) is taken last next time (Astra STUB-2 #2). A claim is asked only
 *  while ITS subscription still owns the home and has not ended (Astra STUB-1 #2: a re-subscription never receives an ended contract's
 *  claim, as the invoice.paid handler grants it nothing); otherwise, or with no input to ask with (a claim from before migration 0082), it
 *  is suppressed for good, listed in the home's alert with why, in one fenced batch. */
export async function retryPendingGrants(env: Env, lease: HomeLease, flux: FluxEntitlementHooks, homeId: string, now: number): Promise<void> {
  const sub = await getSub(env, homeId);
  const due = await env.DB.prepare(`SELECT g.invoice_id,g.kind,g.plan,g.period_start,g.period_end,g.previous_plan,g.subscription_id FROM credit_grants g
    WHERE g.home_id=? AND ${GRANT_RUNNABLE} ORDER BY COALESCE(g.last_attempt_at,0),g.claimed_at,g.invoice_id,g.kind LIMIT 20`).bind(homeId)
    .all<{ invoice_id: string; kind: string; plan: string; period_start: number | null; period_end: number | null; previous_plan: string | null; subscription_id: string | null }>();
  for (const g of due.results) {
    const why = g.period_start === null || g.period_end === null || g.subscription_id === null ? "grant_input_missing"
      : !sub || sub.subscription_id !== g.subscription_id || ENDED(sub) ? "subscription_ended" : null;
    if (why) {
      await fencedBatch(env, lease, [q(`UPDATE credit_grants SET suppressed_at=?,suppressed_reason=?,last_attempt_at=?,alerted_at=COALESCE(alerted_at,?) WHERE invoice_id=? AND kind=?
        AND granted_at IS NULL AND suppressed_at IS NULL`, now, why, now, now, g.invoice_id, g.kind), ...grantAlertSync(homeId, now)]);
      continue;
    }
    await askGrant(env, lease, flux, { homeId, plan: g.plan, invoiceId: g.invoice_id, periodStart: g.period_start!, periodEnd: g.period_end!,
      kind: g.kind === "upgrade_delta" ? "upgrade_delta" : "period", ...(g.previous_plan ? { previousPlan: g.previous_plan } : {}) }, g.kind, now, []);
  }
}

/** The id B4 knows one grant by: one invoice and kind (credit_grants' key). */
export const creditGrantId = (invoiceId: string, kind: string) => `${invoiceId}:${kind}`;
/** Raises (or re-raises) a reversal's credit.reversal_pending alert. A resolved alert of the same reversal is REOPENED (new revision, delivered
 *  again) when a new failure follows its resolution (Astra STUB-4 #1); an open one is left alone; the per-home open-alert index is respected. */
const reversalAlertQs = (homeId: string, invoiceId: string, kind: string, error: string, now: number): Q[] => {
  const id = `alert:credit_reversal:${invoiceId}:${kind}`;
  const detail = JSON.stringify({ invoiceId, kind, error });
  return [
    q(`UPDATE cloud_alerts SET resolved_at=NULL,detail=json_set(?2,'$.revision',COALESCE(json_extract(detail,'$.revision'),0)+1),delivered_at=NULL,delivery_attempts=0
      WHERE id=?1 AND resolved_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.home_id=?3 AND a.kind='credit.reversal_pending' AND a.resolved_at IS NULL)`, id, detail, homeId),
    q("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING", id, homeId, "credit.reversal_pending", "high", detail, now),
  ];
};
/** Astra JOURNEY-A-6 #3: a versioned reversal target is dispatched only to REAL hooks whose router advertises the capability (qualified by the
 *  cutover checklist). Otherwise the target stays journaled (pending_capability, alerted) and nothing is sent: no full reversal in its place
 *  and no local "hold" (a flag here cannot restrict spending at the router). With Flux switched off at launch there is no spendable credit. */
export const reversalTargetsEnabled = (flux: FluxEntitlementHooks): boolean =>
  fluxDispatchEnabled(flux) && typeof flux.setReversalTarget === "function";
/** Astra JOURNEY-A-10 #1: Flux is OFF at launch, and OFF means JOURNAL-ONLY. A grant or a reversal of any kind (grant, full reversal, target,
 *  legacy conversion) is dispatched only to hooks that were explicitly switched on (real hooks, never the stub) AND advertise the qualified
 *  router capability. Otherwise the obligation stays journaled, nothing is sent and ops is alerted. The grants client adds its own gate
 *  (CLOUD_FLUX_ROUTES_ENABLED and a qualified client) before any request. */
export const fluxDispatchEnabled = (flux: FluxEntitlementHooks): boolean =>
  flux.stub !== true && flux.capabilities?.reversalTargets === true;

/** The cumulative removal target of one grant, in router microcents: floor(G x min(covered, paid) / paid) (the router clamps it to G -
 *  consumed). Null when it cannot be computed (no frozen amount, no paid amount). */
export function reversalTarget(bodyJson: string | null, covered: number, paid: number): number | null {
  if (covered <= 0) return 0;
  if (!(paid > 0)) return null;
  let amount: unknown;
  try { amount = (JSON.parse(bodyJson ?? "null") as { amount_microcents?: unknown } | null)?.amount_microcents; } catch { return null; }
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) return null;
  return Number(BigInt(amount) * BigInt(Math.min(covered, paid)) / BigInt(paid));
}

type ReversalRow = { invoice_id: string; kind: string; reason: string; attempts: number; tries: number; requested_at: number; scope: string;
  covered_cents: number | null; paid_cents: number | null; target_revision: number; sent_revision: number | null; granted_at: number | null; final: number;
  suppressed_at: number | null; body_json: string | null; g_reason: string | null; g_tries: number | null; g_attempts: number | null; g_last: number | null;
  g_delivery: string | null; applied_revision: number | null; r_removed: number | null; r_last: number | null };
/** Astra JOURNEY-A-7 #1: how long after a grant's last ask its delivery can still be in flight (the client times out after 15 s): only after
 *  this is the router's grant_not_found affirmative evidence that the grant does not exist there. */
export const GRANT_DELIVERY_SETTLE_MS = 15 * 60_000;
/** Astra JOURNEY-A-8 #1: the grant provably never reached the router: the router said so (not_applied_reversed), or no ask of it was ever
 *  dispatched (delivery_state NULL: every visit was a local hold or a refusal before any request, and no ask ended raw). tries == attempts
 *  alone is NEVER this proof: a 503 is a recorded attempt, and the router may have committed the grant before answering it. */
const grantNeverDispatched = (r: Pick<ReversalRow, "g_reason" | "g_tries" | "g_attempts" | "g_delivery">): boolean =>
  r.g_reason === "not_applied_reversed" || (r.g_delivery === null && (r.g_tries ?? 0) - (r.g_attempts ?? 0) <= 0);
/** Some ask of the grant may have been applied without a definitive answer: a 503 or other retry answer, a lost response, a timeout, an
 *  outcome write that never landed. Only the router's own account (a target receipt) settles such a grant's target. */
const grantDeliveryAmbiguous = (r: Pick<ReversalRow, "g_tries" | "g_attempts" | "g_delivery">): boolean =>
  r.g_delivery === "ambiguous" || (r.g_tries ?? 0) - (r.g_attempts ?? 0) > 0;

/** Executes this home's journaled credit reversals (Astra WP5-6 #2): grant -> reversal requested (credit_reversals row) -> reversed
 *  (reversed_at). Each is asked of B4 under the home's lease and recorded once B4 confirms; B4 applies a grantId at most once, so asking
 *  again after an interruption never takes twice. A FluxHookRetry is recorded and retried by the sweep; ops is told when it keeps failing.
 *  Any other throw propagates unrecorded (the hooks' error contract). A refund-driven row (scope 'target') is a versioned target instead
 *  (reverseTarget). */
const REVERSAL_GRANT_COLS = `r.target_revision,r.sent_revision,r.final,g.granted_at,g.suppressed_at,g.body_json,g.suppressed_reason AS g_reason,g.tries AS g_tries,
  g.attempts AS g_attempts,g.last_attempt_at AS g_last,g.delivery_state AS g_delivery,r.applied_revision,r.removed_microcents AS r_removed,r.last_attempt_at AS r_last`;
export async function reverseCredits(env: Env, lease: HomeLease, flux: FluxEntitlementHooks, homeId: string, now: number): Promise<void> {
  // The 20 least recently tried first (Astra STUB-3 #1): each reversal's stamp is written before B4 is asked, so one whose ask fails raw
  // (which ends this pass) is taken after its siblings next time.
  const due = await env.DB.prepare(`SELECT r.invoice_id,r.kind,r.reason,r.attempts,r.tries,r.requested_at,r.scope,r.covered_cents,r.paid_cents,
      ${REVERSAL_GRANT_COLS},r.op_id,o.refunded_at AS op_refunded_at,o.payment_intent AS op_pi,o.invoice_id AS op_invoice,o.subscription_id AS op_sub,o.paid_cents AS op_paid
    FROM credit_reversals r LEFT JOIN credit_grants g ON g.invoice_id=r.invoice_id AND g.kind=r.kind LEFT JOIN refund_ops o ON o.id=r.op_id
    WHERE r.home_id=? AND r.reversed_at IS NULL ORDER BY COALESCE(r.last_attempt_at,0),r.requested_at,r.invoice_id,r.kind LIMIT 20`)
    .bind(homeId).all<ReversalRow & { op_id: string | null; op_refunded_at: number | null; op_pi: string | null; op_invoice: string | null; op_sub: string | null;
      op_paid: number | null }>();
  for (const r of due.results) {
    // One row per grant (PRIMARY KEY invoice_id,kind): a grant with a target is never asked the legacy /reverse (wp5-p5: 409
    // reversal_target_held), only its target.
    if (r.scope === "target") { await reverseTarget(env, lease, flux, homeId, r, now); continue; }
    // Astra JOURNEY-A-8 #3: a refund-backed reversal (journaled with a refund operation) is NEVER the one-shot /reverse: a refund can fail or
    // return to requires_action after it succeeded, and a final reversal could not give the credit back. A row journaled that way before
    // this change becomes a FINAL versioned target in place (the grant is still never asked again) that follows its payment's coverage;
    // once that operation's money has been returned at least once, its payment goes under coverage reconciliation here (re-read by the sweep).
    if (r.op_id !== null) { await convertLegacyReversal(env, lease, flux, homeId, r, now); continue; }
    // Astra JOURNEY-A-10 #1: Flux off: the full reversal stays journaled (pending_capability), alerted, the hook is never invoked.
    if (!fluxDispatchEnabled(flux)) {
      await fencedBatch(env, lease, [
        q("UPDATE credit_reversals SET last_attempt_at=?,last_error='pending_capability' WHERE invoice_id=? AND kind=? AND reversed_at IS NULL", now, r.invoice_id, r.kind),
        ...reversalAlertQs(homeId, r.invoice_id, r.kind, "pending_capability", now)]);
      continue;
    }
    // The fenced pre-call stamp, apart from attempts. tries-attempts counts the asks that failed raw (no outcome recorded): 3 of them, or a
    // reversal pending PENDING_ALERT_MS, tell ops (Astra STUB-3 #2), while the error itself still propagates below.
    const stuck = r.tries - r.attempts >= 3 ? "infra_failing" : r.requested_at <= now - PENDING_ALERT_MS ? "pending_too_long" : null;
    await fence(env, lease);
    // The journaled reversal takes its claim out of the held set: credit.grant_held is reconciled here, whatever B4 then answers (Astra
    // WP5-P4-CP-3 #3).
    await fencedBatch(env, lease, [
      q("UPDATE credit_reversals SET last_attempt_at=?,tries=tries+1 WHERE invoice_id=? AND kind=? AND reversed_at IS NULL", now, r.invoice_id, r.kind),
      ...(stuck ? reversalAlertQs(homeId, r.invoice_id, r.kind, stuck, now) : []),
      ...heldAlertSync(homeId, now),
    ]);
    try {
      await flux.revokeCredits(env, { homeId, invoiceId: r.invoice_id, kind: r.kind === "upgrade_delta" ? "upgrade_delta" : "period",
        grantId: creditGrantId(r.invoice_id, r.kind), reason: r.reason });
      await fencedBatch(env, lease, [
        q("UPDATE credit_reversals SET reversed_at=COALESCE(reversed_at,?),last_error=NULL WHERE invoice_id=? AND kind=? AND scope='full'", now, r.invoice_id, r.kind),
        q("UPDATE cloud_alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL", now, `alert:credit_reversal:${r.invoice_id}:${r.kind}`),
        // A grant that never landed and is now reversed is never asked for again: it leaves the home's pending-grant alert.
        ...grantAlertSync(homeId, now),
      ]);
    } catch (e) {
      // The hooks' error contract (Astra STUB-2 #1): only FluxHookRetry is a failed attempt; a lost lease, a D1 failure or any other throw
      // propagates with nothing recorded (the caller's refund goes ahead regardless; the sweep retries the reversal).
      if (!(e instanceof FluxHookRetry)) throw e;
      const code = e.code.slice(0, 80);
      await fencedRun(env, lease, "UPDATE credit_reversals SET attempts=attempts+1,last_error=? WHERE invoice_id=? AND kind=? AND reversed_at IS NULL", code, r.invoice_id, r.kind);
      if (r.attempts + 1 >= 3 || code === "flux_not_wired") {
        await fencedBatch(env, lease, reversalAlertQs(homeId, r.invoice_id, r.kind, code, now));
      }
    }
  }
}

type LegacyRow = ReversalRow & { op_id: string | null; op_refunded_at: number | null; op_pi: string | null; op_invoice: string | null; op_sub: string | null;
  op_paid: number | null };
/** Astra JOURNEY-A-8 #3 / A-9 #2: a refund-backed reversal journaled before targets (scope 'full' with a refund operation) becomes a FINAL
 *  versioned target in place (the grant is never asked again; it follows its payment's coverage). Its historical /reverse is RECONCILED with
 *  the router first: a row whose /reverse may have been dispatched (tries or attempts) is AMBIGUOUS, never "unexecuted" (a /reverse that
 *  committed and lost its answer leaves reversed_at NULL). In order:
 *  - never dispatched: converted as is (nothing reached the router);
 *  - dispatched within GRANT_DELIVERY_SETTLE_MS: waits (the ask may still be in flight);
 *  - the router cannot be asked (no qualified hooks, no grantState capability, a retry answer): stays pending, alerted;
 *  - the router reports the grant REVERSED: the target starts FROM the removal it applied (applied_revision 0, removed = the router's), and
 *    its first target adopts that removal (adoptLegacyReversal), so a refund that later fails restores the credit; coverage is watched;
 *  - the router reports a tombstone (reversed before the grant existed): pending and alerted for ops (nothing to restore at the router);
 *  - the router holds the grant unreversed, or no grant: converted with sent_revision 0, so it settles ONLY on a router receipt, never
 *    locally at zero (and its first target makes the router refuse a /reverse arriving late). */
async function convertLegacyReversal(env: Env, lease: HomeLease, flux: FluxEntitlementHooks, homeId: string, r: LegacyRow, now: number): Promise<void> {
  const convert = (set: string, args: unknown[], watchAlways: boolean) => fencedBatch(env, lease, [
    q(`UPDATE credit_reversals SET scope='target',final=1,target_revision=MAX(target_revision,1),payment_intent=COALESCE(payment_intent,?),last_attempt_at=?${set}
      WHERE invoice_id=? AND kind=? AND scope='full' AND reversed_at IS NULL`, r.op_pi, now, ...args, r.invoice_id, r.kind),
    ...(r.op_pi && (watchAlways || r.op_refunded_at !== null) ? [coverageWatchQ({ homeId, paymentIntent: r.op_pi, invoiceId: r.op_invoice ?? r.invoice_id,
      subscriptionId: r.op_sub, paidCents: r.op_paid }, now)] : [])]);
  if (r.tries <= 0 && r.attempts <= 0) { await convert(",last_error=NULL", [], false); return; }
  if (r.r_last !== null && now - r.r_last < GRANT_DELIVERY_SETTLE_MS) return;
  const pending = (error: string, attempt: boolean) => fencedBatch(env, lease, [
    q(`UPDATE credit_reversals SET last_attempt_at=?,last_error=?${attempt ? ",attempts=attempts+1" : ""} WHERE invoice_id=? AND kind=? AND scope='full'
      AND reversed_at IS NULL`, now, error, r.invoice_id, r.kind),
    ...reversalAlertQs(homeId, r.invoice_id, r.kind, error, now)]);
  if (!reversalTargetsEnabled(flux)) { await pending("pending_capability", false); return; }
  if (typeof flux.grantReversalState !== "function") { await pending("legacy_reversal_unreconciled", false); return; }
  let st: GrantReversalState;
  try {
    st = await flux.grantReversalState(env, { homeId, invoiceId: r.invoice_id, kind: r.kind === "upgrade_delta" ? "upgrade_delta" : "period",
      grantId: creditGrantId(r.invoice_id, r.kind) });
  } catch (e) {
    if (!(e instanceof FluxHookRetry)) throw e;
    await pending("legacy_reversal_unreconciled", true);
    return;
  }
  if (st.state === "tombstoned") { await pending("legacy_reversal_tombstoned", false); return; }
  if (st.state === "reversed") {
    await convert(",sent_revision=0,applied_revision=0,removed_microcents=?,target_microcents=?,last_error='legacy_reversal_adopted'",
      [st.removedMicrocents, st.removedMicrocents], true);
    return;
  }
  await convert(",sent_revision=0,last_error=NULL", [], false);
}
/** Astra JOURNEY-A-9 #2 cutover guard: refund-backed legacy /reverse rows not yet reconciled into targets. The Flux cutover checklist requires
 *  this to be EMPTY before reversalTargets is wired; the billing sweep reports it as one credit.legacy_reversal_unreconciled alert per home. */
export async function legacyReversalReport(env: Env): Promise<{ unreconciled: number; rows: { homeId: string; grantId: string; dispatched: boolean; lastError: string | null }[] }> {
  const rows = (await env.DB.prepare(`SELECT home_id,invoice_id,kind,tries,attempts,last_error FROM credit_reversals WHERE scope='full' AND op_id IS NOT NULL
    AND reversed_at IS NULL ORDER BY home_id,invoice_id,kind LIMIT 500`).all<{ home_id: string; invoice_id: string; kind: string; tries: number; attempts: number;
    last_error: string | null }>()).results;
  return { unreconciled: rows.length, rows: rows.map((x) => ({ homeId: x.home_id, grantId: creditGrantId(x.invoice_id, x.kind), dispatched: x.tries > 0 || x.attempts > 0,
    lastError: x.last_error })) };
}
/** Raises one alert per home listed by legacyReversalReport and resolves those of homes no longer listed. */
export async function sweepLegacyReversals(env: Env, now: number): Promise<void> {
  const report = await legacyReversalReport(env);
  const homes = new Map<string, string[]>();
  for (const x of report.rows) homes.set(x.homeId, [...(homes.get(x.homeId) ?? []), x.grantId]);
  const open = (await env.DB.prepare("SELECT id,home_id FROM cloud_alerts WHERE kind='credit.legacy_reversal_unreconciled' AND resolved_at IS NULL")
    .all<{ id: string; home_id: string }>()).results;
  const legacyAlertStmts = [
    ...[...homes].map(([h, ids]) => env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
      .bind(`alert:legacy_reversal:${h}`, h, "credit.legacy_reversal_unreconciled", "high", JSON.stringify({ grantIds: ids }), now)),
    ...open.filter((a) => !homes.has(a.home_id)).map((a) => env.DB.prepare("UPDATE cloud_alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL").bind(now, a.id)),
  ];
  if (legacyAlertStmts.length) await env.DB.batch(legacyAlertStmts);
}

/** Astra JOURNEY-A-6 #2/#3: one refund-driven grant's VERSIONED CUMULATIVE TARGET. Settled (reversed_at) only when the router's receipt names
 *  the row's latest revision (target_revision); a receipt for any other revision is not applied, and the latest is sent again. In order:
 *  - nothing ever sent and nothing to remove (coverage 0): settled here with 0 removed (the router holds nothing for it);
 *  - hooks without the qualified capability (the stub, a router not yet qualified): pending_capability, alerted, NOTHING sent;
 *  - the grant has not landed: waits (a grant that never will, never sent: settled with 0 removed);
 *  - no frozen amount to compute T from: held and alerted (grant_amount_unknown);
 *  - otherwise the fenced pre-call stamp (sent_revision, target_microcents) and the ask. */
async function reverseTarget(env: Env, lease: HomeLease, flux: FluxEntitlementHooks, homeId: string, r: ReversalRow, now: number, refreshed = false): Promise<void> {
  const rev = r.target_revision;
  const covered = r.covered_cents ?? 0; const paid = r.paid_cents ?? 0;
  // `held`: the target the router confirmed it holds at `rev` (a receipt), kept so coverage reconciliation can re-check it; a local settlement
  // (nothing reached the router) keeps the target last stamped.
  const settle = (removed: number, extra: Q[] = [], held: number | null = null) => fencedBatch(env, lease, [
    q(`UPDATE credit_reversals SET applied_revision=?,removed_microcents=?,target_microcents=COALESCE(?,target_microcents),reversed_at=?,last_error=NULL
      WHERE invoice_id=? AND kind=? AND scope='target' AND target_revision=?`, rev, removed, held, now, r.invoice_id, r.kind, rev),
    q("UPDATE cloud_alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL", now, `alert:credit_reversal:${r.invoice_id}:${r.kind}`), ...extra]);
  // wp5-p5 / Astra JOURNEY-A-9 #1: the router holds `latest` (a newer revision, or this one with another target): the row's revision is moved
  // above it (the same latest target, at a revision the router will take), kept due, and re-sent once now.
  const refresh = async (latest: number, code: string) => {
    const [bumped] = await fencedBatch(env, lease, [q(`UPDATE credit_reversals SET target_revision=MAX(target_revision,?),reversed_at=NULL,last_error=?
      WHERE invoice_id=? AND kind=? AND scope='target' AND reversed_at IS NULL`, latest + 1, code, r.invoice_id, r.kind)]);
    if (!refreshed && bumped.meta.changes === 1) {
      const fresh = await env.DB.prepare(`SELECT r.invoice_id,r.kind,r.reason,r.attempts,r.tries,r.requested_at,r.scope,r.covered_cents,r.paid_cents,${REVERSAL_GRANT_COLS}
        FROM credit_reversals r LEFT JOIN credit_grants g ON g.invoice_id=r.invoice_id AND g.kind=r.kind WHERE r.invoice_id=? AND r.kind=? AND r.reversed_at IS NULL`)
        .bind(r.invoice_id, r.kind).first<ReversalRow>();
      if (fresh) await reverseTarget(env, lease, flux, homeId, fresh, now, true);
    } else if (refreshed) {
      await fencedBatch(env, lease, reversalAlertQs(homeId, r.invoice_id, r.kind, code, now));
    }
  };
  if (r.sent_revision === null && covered <= 0) { await settle(0); return; }
  if (!reversalTargetsEnabled(flux)) {
    await fencedBatch(env, lease, [
      q("UPDATE credit_reversals SET last_attempt_at=?,last_error='pending_capability' WHERE invoice_id=? AND kind=? AND reversed_at IS NULL", now, r.invoice_id, r.kind),
      ...reversalAlertQs(homeId, r.invoice_id, r.kind, "pending_capability", now)]);
    return;
  }
  // Astra JOURNEY-A-9 #2: a legacy /reverse the router confirmed (convertLegacyReversal): its first target ADOPTS that removal, and only once
  // the payment's coverage is known (until then nothing is restored or removed); pending and alerted meanwhile.
  const adopting = r.applied_revision === 0 && r.r_removed !== null;
  if (adopting && r.covered_cents === null) {
    await fencedBatch(env, lease, [
      q("UPDATE credit_reversals SET last_attempt_at=?,last_error='legacy_reversal_coverage_unknown' WHERE invoice_id=? AND kind=? AND reversed_at IS NULL", now, r.invoice_id, r.kind),
      ...reversalAlertQs(homeId, r.invoice_id, r.kind, "legacy_reversal_coverage_unknown", now)]);
    return;
  }
  // Astra JOURNEY-A-7 #1: a grant not confirmed here is settled locally at 0 ONLY on affirmative evidence that the router never applied it
  // (the router answered not_applied_reversed, or no ask of it ever left without a definitive answer). A suppressed grant whose delivery is
  // ambiguous (an ask that ended without an answer: the router may hold it) is reconciled WITH the router: once its last ask has settled,
  // the target itself is sent; a receipt is the router's own account (the grant exists, and this is what is removed of it). The router's
  // grant_not_found means only "no grant with this id yet" (wp5-p5), never that it was never applied: the target then stays due and
  // alerted (grant_delivery_unconfirmed), and goes out when the grant shows up.
  // Astra JOURNEY-A-8 #1: settled at 0 without a receipt ONLY on explicit non-delivery evidence: the router answered not_applied_reversed, no
  // ask was ever dispatched, or (below) the router answers grant_not_found while no ask of the grant ever went unanswered. A grant of
  // AMBIGUOUS delivery (a 503, a lost response, a timeout) is asked once its last ask has settled, and only a receipt settles it.
  const unconfirmed = r.granted_at === null;
  let ambiguous = false;
  if (unconfirmed) {
    const waitGrant = () => fencedRun(env, lease, "UPDATE credit_reversals SET last_attempt_at=? WHERE invoice_id=? AND kind=? AND reversed_at IS NULL", now, r.invoice_id, r.kind);
    // A grant still to be published carries this target in its own request (askGrant); one never asked again (suppressed, or under a
    // final lane B target) is reconciled here.
    if (r.suppressed_at === null && r.final !== 1) { await waitGrant(); return; }
    if (r.sent_revision === null && grantNeverDispatched(r)) { await settle(0); return; }
    ambiguous = grantDeliveryAmbiguous(r);
    if (ambiguous && r.g_last !== null && now - r.g_last < GRANT_DELIVERY_SETTLE_MS) { await waitGrant(); return; }
  }
  const target = reversalTarget(r.body_json, covered, paid);
  if (target === null) {
    await fencedBatch(env, lease, [
      q("UPDATE credit_reversals SET attempts=attempts+1,last_attempt_at=?,last_error='grant_amount_unknown' WHERE invoice_id=? AND kind=? AND reversed_at IS NULL", now, r.invoice_id, r.kind),
      ...reversalAlertQs(homeId, r.invoice_id, r.kind, "grant_amount_unknown", now)]);
    return;
  }
  const stuck = r.tries - r.attempts >= 3 ? "infra_failing" : r.requested_at <= now - PENDING_ALERT_MS ? "pending_too_long" : null;
  await fence(env, lease);
  const [stamped] = await fencedBatch(env, lease, [
    q(`UPDATE credit_reversals SET last_attempt_at=?,tries=tries+1,sent_revision=MAX(COALESCE(sent_revision,0),?),target_microcents=?
      WHERE invoice_id=? AND kind=? AND scope='target' AND target_revision=? AND reversed_at IS NULL`, now, rev, target, r.invoice_id, r.kind, rev),
    ...(stuck ? reversalAlertQs(homeId, r.invoice_id, r.kind, stuck, now) : []),
    ...heldAlertSync(homeId, now),
  ]);
  if (stamped.meta.changes !== 1) return; // a newer revision was journaled meanwhile: the next pass sends it
  try {
    const receipt = await flux.setReversalTarget!(env, { homeId, invoiceId: r.invoice_id, kind: r.kind === "upgrade_delta" ? "upgrade_delta" : "period",
      grantId: creditGrantId(r.invoice_id, r.kind), reason: r.reason, targetRemovedMicrocents: target, revision: rev, ...(adopting ? { adoptLegacyReversal: true } : {}) }, { lease });
    if (receipt.grantId !== creditGrantId(r.invoice_id, r.kind) || receipt.revision !== rev) {
      await fencedRun(env, lease, "UPDATE credit_reversals SET last_error='receipt_not_latest' WHERE invoice_id=? AND kind=? AND reversed_at IS NULL", r.invoice_id, r.kind);
      return;
    }
    // Astra JOURNEY-A-9 #1: this revision held with ANOTHER target (or a receipt that does not say which): a conflict, never complete. The
    // revision moves above the router's and the correct target is re-sent once now.
    if (receipt.targetRemovedMicrocents !== target) { await refresh(receipt.revision, "receipt_target_conflict"); return; }
    // Applied only while this revision is still the latest (the settle statement's own predicate): a coverage change journaled during the
    // call leaves the row due, and the next pass sends the newer target. A receipt for a grant of ambiguous delivery is the router's proof
    // that the grant landed: it is recorded as granted.
    await settle(receipt.removedMicrocents, unconfirmed ? [q("UPDATE credit_grants SET granted_at=COALESCE(granted_at,?) WHERE invoice_id=? AND kind=?", now, r.invoice_id, r.kind)] : [],
      receipt.targetRemovedMicrocents);
  } catch (e) {
    if (!(e instanceof FluxHookRetry)) throw e;
    const code = e.code.slice(0, 80);
    // wp5-p5: the router holds a newer revision (stale_revision) or this revision with another target (revision_conflict), and says which:
    // the row's revision is refreshed above the router's (the same latest target, at a revision the router will take) and re-sent once now.
    if (e instanceof FluxTargetStale) { await refresh(e.latestRevision, code); return; }
    // The router confirms it holds no grant with this id, and every ask of the grant was answered definitively (refused) or never sent:
    // explicit non-delivery evidence, settled with nothing removed (the grant is never asked again).
    if (unconfirmed && !ambiguous && code === "router_grant_not_found") { await settle(0); return; }
    // A grant of ambiguous delivery the router does not hold (yet): not evidence it was never applied. Due and alerted, never settled.
    if (ambiguous && code === "router_grant_not_found") {
      await fencedBatch(env, lease, [
        q("UPDATE credit_reversals SET attempts=attempts+1,last_error='grant_delivery_unconfirmed' WHERE invoice_id=? AND kind=? AND reversed_at IS NULL", r.invoice_id, r.kind),
        ...reversalAlertQs(homeId, r.invoice_id, r.kind, "grant_delivery_unconfirmed", now)]);
      return;
    }
    await fencedRun(env, lease, "UPDATE credit_reversals SET attempts=attempts+1,last_error=? WHERE invoice_id=? AND kind=? AND reversed_at IS NULL", code, r.invoice_id, r.kind);
    if (r.attempts + 1 >= 3) await fencedBatch(env, lease, reversalAlertQs(homeId, r.invoice_id, r.kind, code, now));
  }
}

/** Astra JOURNEY-A-6 #1/#4: the payment-level coverage watch of one refunded payment (refund_coverage), written by whoever first learns of a
 *  refund on it (a ledger refund operation, a refund webhook) and never deleted by reversal bookkeeping. `endPlan`: an external full refund of
 *  the RETAINED contract was reported; it is sticky, and acted on only by reconcilePaymentCoverage once the listing shows full coverage. */
export const coverageWatchQ = (i: { homeId: string; paymentIntent: string; invoiceId: string | null; subscriptionId: string | null;
  paidCents: number | null; endPlan?: boolean }, now: number): Q =>
  q(`INSERT INTO refund_coverage (home_id,payment_intent,invoice_id,subscription_id,paid_cents,end_plan,changed_at,created_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(home_id,payment_intent) DO UPDATE SET invoice_id=COALESCE(refund_coverage.invoice_id,excluded.invoice_id),
      subscription_id=COALESCE(refund_coverage.subscription_id,excluded.subscription_id),paid_cents=COALESCE(excluded.paid_cents,refund_coverage.paid_cents),
      end_plan=MAX(refund_coverage.end_plan,excluded.end_plan)`,
    i.homeId, i.paymentIntent, i.invoiceId, i.subscriptionId, i.paidCents !== null && i.paidCents > 0 ? i.paidCents : null, i.endPlan ? 1 : 0, now, now);

/** How long after the last coverage change a settled payment is still re-read (a refund can fail days after it succeeded). While any work
 *  on it is pending it is re-read whatever its age. */
export const COVERAGE_TAIL_MS = 120 * 86_400_000;
/** The payments the billing sweep re-reads (hourly each, least recently checked first): any obligation on it unsettled, whatever its age (an
 *  open refund, an unknown paid amount, a target not yet applied at its latest revision, an unfinished service end (end_plan=1 and not ended:
 *  coverage still pending, even with only failed refunds listed, or a cancellation/Stop/notice not finished), a refund operation of the
 *  payment not done); the COVERAGE_TAIL_MS tail after the last coverage change applies only once all of them have settled (Astra JOURNEY-A-7 #5). */
export const COVERAGE_DUE_SQL = `SELECT w.home_id AS h,w.payment_intent AS pi FROM refund_coverage w WHERE COALESCE(w.checked_at,0)<=?1
  AND (w.open_cents>0 OR w.paid_cents IS NULL OR w.changed_at>?2 OR (w.end_plan=1 AND w.ended_at IS NULL)
    OR EXISTS (SELECT 1 FROM credit_reversals r WHERE r.home_id=w.home_id AND r.payment_intent=w.payment_intent AND r.scope='target' AND r.reversed_at IS NULL)
    OR EXISTS (SELECT 1 FROM refund_ops o WHERE o.payment_intent=w.payment_intent AND o.home_id=w.home_id AND o.done_at IS NULL))
  ORDER BY COALESCE(w.checked_at,0),w.home_id LIMIT 20`;

/** `eventCreated`: Stripe's own time of the refund event that asked (Unix seconds), so the lifecycle orders the service end by Stripe's clock;
 *  a sweep pass uses its own. */
type CoverageCtx = { stripe: StripeClient; flux: FluxEntitlementHooks; deps: BillingDependencies; now: number; eventCreated?: number };
/** Astra JOURNEY-A-6 #1/#2/#4: reconciles ONE refunded payment of this home against Stripe's CURRENT refund listing (succeeded refunds only are
 *  money returned; an event's "refunded" flag is never evidence), under the home's lease:
 *  1. the watch is stamped first (a payment whose listing keeps failing waits its turn) and refreshed (covered, open, changed_at);
 *  2. every grant of the payment's invoice (credit_grants: discovered from the PAYMENT, so a grant claimed after the refund is included) gets
 *     its versioned target: a new one at revision 1 once anything is covered; an existing one bumps its revision on any coverage change, down
 *     as well as up (a refund that failed after it succeeded restores credits);
 *  3. an end_plan watch ends the RETAINED contract's service only once the whole payment is covered (cancelled at Stripe, Stop without credit
 *     reversal: the target above adjusts the credit); a ledger refund operation of the payment owns its own end instead;
 *  4. the home's due reversals run (a failure to reach B4 is left to the sweep).
 *  Returns whether service was ended by this pass. */
export async function reconcilePaymentCoverage(env: Env, lease: HomeLease, ctx: CoverageCtx, homeId: string, paymentIntent: string): Promise<boolean> {
  const now = ctx.now;
  const w = await env.DB.prepare("SELECT invoice_id,subscription_id,paid_cents,covered_cents,open_cents,end_plan,ended_at FROM refund_coverage WHERE home_id=? AND payment_intent=?")
    .bind(homeId, paymentIntent).first<{ invoice_id: string | null; subscription_id: string | null; paid_cents: number | null; covered_cents: number; open_cents: number;
      end_plan: number; ended_at: number | null }>();
  if (!w) return false;
  await fencedRun(env, lease, "UPDATE refund_coverage SET checked_at=? WHERE home_id=? AND payment_intent=?", now, homeId, paymentIntent);
  const listed = (await ctx.stripe.listRefunds(paymentIntent)).data.filter((r) => (r.payment_intent ?? paymentIntent) === paymentIntent);
  const amount = (r: { amount: number }) => Number.isSafeInteger(r.amount) && r.amount > 0 ? r.amount : 0;
  const covered = listed.filter((r) => r.status === "succeeded").reduce((n, r) => n + amount(r), 0);
  const open = listed.filter((r) => r.status !== "succeeded" && r.status !== "failed" && r.status !== "canceled").reduce((n, r) => n + amount(r), 0);
  let paid = w.paid_cents;
  if (paid === null && w.invoice_id) { const inv = await ctx.stripe.getInvoice(w.invoice_id); paid = inv.amount_paid > 0 ? inv.amount_paid : null; }
  const stmts: Q[] = [q(`UPDATE refund_coverage SET changed_at=CASE WHEN covered_cents<>?1 OR open_cents<>?2 THEN ?4 ELSE changed_at END,
    covered_cents=?1,open_cents=?2,paid_cents=COALESCE(paid_cents,?3) WHERE home_id=?5 AND payment_intent=?6`, covered, open, paid, now, homeId, paymentIntent)];
  if (w.invoice_id && paid !== null) {
    stmts.push(
      // An existing target follows any coverage change (a new revision, due again).
      q(`UPDATE credit_reversals SET target_revision=target_revision+1,reversed_at=NULL,covered_cents=?1,paid_cents=?2,payment_intent=COALESCE(payment_intent,?3)
        WHERE invoice_id=?4 AND home_id=?5 AND scope='target' AND (covered_cents IS NOT ?1 OR paid_cents IS NOT ?2)`, covered, paid, paymentIntent, w.invoice_id, homeId),
      // Every grant of the payment's invoice, once anything is covered. A grant already under a final (non-refund) reversal keeps it.
      ...(covered > 0 ? [q(`INSERT OR IGNORE INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at,scope,covered_cents,paid_cents,payment_intent,target_revision)
        SELECT invoice_id,kind,home_id,'refunded',(SELECT r.id FROM refund_ops r WHERE r.payment_intent=?1 AND r.kind<>'external' ORDER BY r.created_at LIMIT 1),?2,'target',?3,?4,?1,1
        FROM credit_grants WHERE invoice_id=?5 AND home_id=?6`, paymentIntent, now, covered, paid, w.invoice_id, homeId)] : []));
  }
  await fencedBatch(env, lease, stmts);
  // Astra JOURNEY-A-9 #1: a settled target is re-checked by the TARGET the router confirmed holding (kept at settlement), not only by its
  // revision: one that differs from what this coverage asks for is due again at a new revision (re-sent below).
  if (w.invoice_id && paid !== null) {
    const settled = (await env.DB.prepare(`SELECT r.kind,r.target_microcents AS held,r.covered_cents AS c,r.paid_cents AS p,g.body_json AS body FROM credit_reversals r
      JOIN credit_grants g ON g.invoice_id=r.invoice_id AND g.kind=r.kind WHERE r.invoice_id=? AND r.home_id=? AND r.scope='target' AND r.reversed_at IS NOT NULL
      AND r.sent_revision IS NOT NULL`).bind(w.invoice_id, homeId).all<{ kind: string; held: number | null; c: number | null; p: number | null; body: string | null }>()).results;
    const off = settled.filter((x) => { const t = reversalTarget(x.body, x.c ?? 0, x.p ?? 0); return t !== null && x.held !== t; });
    if (off.length) await fencedBatch(env, lease, off.map((x) => q(`UPDATE credit_reversals SET target_revision=target_revision+1,reversed_at=NULL,last_error='settled_target_mismatch'
      WHERE invoice_id=? AND kind=? AND scope='target' AND reversed_at IS NOT NULL`, w.invoice_id, x.kind)));
  }
  let ended = false;
  if (w.end_plan === 1 && w.ended_at === null) ended = await endOnFullCoverage(env, lease, ctx, homeId, paymentIntent, w, covered, paid);
  try { await reverseCredits(env, lease, ctx.flux, homeId, now); } catch (e) { if (e instanceof LeaseLost) throw e; /* the sweep asks B4 again */ }
  return ended;
}

/** Astra JOURNEY-A-6 #1: an external full refund of the RETAINED contract ends its service only on verified coverage (every cent paid
 *  returned, per the listing). Until then nothing is cancelled and no Stop is issued: the obligation stays on the watch (pending coverage,
 *  alerted once). A replacement that took the home since releases it. Astra JOURNEY-A-7 #2: a ledger operation of the payment discharges it
 *  ONLY when it demonstrably ends THIS subscription itself: end_plan=1 for this subscription and its cancellation done (canceled_at). One that
 *  may still do so (end_plan=1, not cancelled, not done) defers it (checked again next pass). A refusal, a zero-value or declined operation,
 *  or any operation that does not end this plan never discharges it. */
async function endOnFullCoverage(env: Env, lease: HomeLease, ctx: CoverageCtx, homeId: string, paymentIntent: string,
  w: { invoice_id: string | null; subscription_id: string | null }, covered: number, paid: number | null): Promise<boolean> {
  const now = ctx.now;
  const release = (why: string) => fencedBatch(env, lease, [
    q("UPDATE refund_coverage SET end_plan=0 WHERE home_id=? AND payment_intent=? AND ended_at IS NULL", homeId, paymentIntent),
    q("UPDATE cloud_alerts SET resolved_at=?,detail=json_set(detail,'$.released',?) WHERE id=? AND resolved_at IS NULL", now, why, `alert:refund_coverage:${homeId}:${paymentIntent}`)]);
  const sub = await getSub(env, homeId);
  if (!w.subscription_id || !sub?.subscription_id || sub.subscription_id !== w.subscription_id) { await release("not_retained"); return false; }
  const ending = await env.DB.prepare(`SELECT MAX(canceled_at IS NOT NULL) AS ended,MAX(canceled_at IS NULL AND done_at IS NULL) AS pending FROM refund_ops
    WHERE payment_intent=? AND home_id=? AND kind<>'external' AND end_plan=1 AND subscription_id=?`).bind(paymentIntent, homeId, w.subscription_id)
    .first<{ ended: number | null; pending: number | null }>();
  // Astra INTEGRATED-2 #2: discharged by a ledger operation only on Stripe's own end of this subscription (THE checkpoint), never on its
  // canceled_at or a local status: otherwise this watch keeps the end and asks Stripe for it itself.
  if (ending?.ended === 1 && await stripeEndConfirmed(env, w.subscription_id)) { await release("ledger_operation"); return false; }
  if (ending?.pending === 1) return false;
  if (paid === null || covered < paid) {
    await fencedRun(env, lease, "INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      `alert:refund_coverage:${homeId}:${paymentIntent}`, homeId, "refund.coverage_pending", "warning",
      JSON.stringify({ paymentIntent, invoiceId: w.invoice_id, coveredCents: covered, paidCents: paid }), now);
    return false;
  }
  // Astra TAXCOUNTRY-7 P1-a: the end is A's line only (subscriptionId): in the lifecycle it closes A's line and can never outrank the
  // activation of a replacement B paid before this refund was dated, whatever order the webhooks arrive in.
  await submitPayment(env, lease, { eventId: `refund_coverage-${paymentIntent}`, homeId, created: ctx.eventCreated ?? Math.floor(now / 1000), status: "canceled",
    paymentId: paymentIntent, subscriptionId: w.subscription_id });
  // Astra JOURNEY-BCORE-7 #3: the local terminal state, the service stop and the notice come FIRST, independent of Stripe; the subscription's
  // end is asked of Stripe last (a parked one throws SubscriptionParked: the coverage stays unended and this runs again for that end alone).
  await fencedRun(env, lease, "UPDATE billing_subscriptions SET status='canceled',updated_at=?,ended_at=COALESCE(ended_at,?) WHERE home_id=? AND subscription_id=? AND status<>'disputed'",
    now, now, homeId, sub.subscription_id);
  await fence(env, lease);
  await ctx.flux.stopForBilling(env, homeId, undefined, { ...(w.invoice_id ? { invoiceId: w.invoice_id } : {}), keepGrants: true });
  await notify(env, { ...ctx.deps, lease }, homeId, "refunded", paymentIntent, {});
  await endSubscription(env, lease, ctx.stripe, sub);
  await fencedBatch(env, lease, [
    q("UPDATE refund_coverage SET ended_at=? WHERE home_id=? AND payment_intent=? AND ended_at IS NULL", now, homeId, paymentIntent),
    q("UPDATE cloud_alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL", now, `alert:refund_coverage:${homeId}:${paymentIntent}`)]);
  return true;
}

/** Runs the home's journaled credit reversals right away; a failure never stops the refund that journaled them (the sweep retries). */
async function reverseJournaledCredits(env: Env, ctx: RefundContext, homeId: string): Promise<void> {
  try { await reverseCredits(env, ctx.lease!, ctx.flux, homeId, ctx.now); }
  catch (e) { if (e instanceof LeaseLost) throw e; }
}

/** Cancels a rejected order's subscription at Stripe (no proration, no invoice now) and, once Stripe confirms, clears its journal entry. */
async function confirmRejectedCancel(env: Env, lease: HomeLease, stripe: StripeClient, subscriptionId: string, now: number): Promise<void> {
  await fence(env, lease);
  await cancelConfirmed(env, lease, stripe, subscriptionId, NO_PRORATION);
  await fencedRun(env, lease, "UPDATE rejected_subscriptions SET cancel_pending=0,cancel_confirmed_at=COALESCE(cancel_confirmed_at,?) WHERE subscription_id=?", now, subscriptionId);
}

/** Payment cleared for an order the guard had already turned away (an asynchronous method settling late): refunded in full, once. */
async function refundRejectedPayment(env: Env, deps: BillingDependencies, ctx: RefundContext, c: ConsentRow, i: { homeId: string; subscriptionId: string | null; session: Obj }, now: number): Promise<string> {
  const kind = c.rejected_reason as RejectKind;
  if (!isRejectKind(kind)) throw new Error("rejected_reason_unknown");
  const amount = typeof i.session.amount_total === "number" ? i.session.amount_total : 0;
  await refundStrandedPayment(env, { ...ctx, lease: ctx.lease ?? deps.lease }, { homeId: i.homeId, consent: c, kind, invoiceId: idOf(i.session.invoice), amount,
    subscriptionId: i.subscriptionId }, now);
  return `${kind}_payment_refunded`;
}

/** A payment that cleared for a contract that no longer stands is refunded in full, once per invoice, through the ledger: the guard turned the
 *  order away, its asynchronous payment was written off, it was withdrawn while the payment was pending (the withdrawal decided "nothing
 *  charged"), or it lost the home's one-subscription claim. Nothing is opened when the invoice already has an operation of its own (that
 *  operation is the refund) or nothing was paid. Returns true when the payment is (now) covered by a refund operation. */
async function refundStrandedPayment(env: Env, ctx: RefundContext, i: { homeId: string; consent: ConsentRow | null; kind: RejectKind | "late_payment";
  invoiceId: string | null; amount: number; subscriptionId: string | null;
  /** Without a consent: the seller path the payment was taken on (persisted with an order refused on its own). Never guessed as direct. */
  path?: RefundPath }, now: number): Promise<boolean> {
  if (!i.invoiceId || i.amount <= 0) return false;
  // Also covered: the paid refusal of this subscription opened before its invoice was known (Astra DROPDOWN-DIRECT-2 (1)); the ledger resolves
  // that operation's invoice from its session, so the payment is never refunded by a second operation.
  const covered = await env.DB.prepare(`SELECT id,done_at FROM refund_ops WHERE kind<>'external' AND (invoice_id=? OR (invoice_id IS NULL AND ? IS NOT NULL
    AND subscription_id=? AND kind IN ('mismatch','country_paused','rejected_consent','duplicate') AND COALESCE(paid_cents,0)>0)) ORDER BY created_at LIMIT 1`)
    .bind(i.invoiceId, i.subscriptionId, i.subscriptionId).first<{ id: string; done_at: number | null }>();
  if (covered) { if (covered.done_at === null) await advanceRefundOp(env, ctx, covered.id); return true; }
  const userId = i.consent?.user_id ?? (await env.DB.prepare("SELECT owner_id FROM cloud_homes WHERE id=?").bind(i.homeId).first<{ owner_id: string }>())?.owner_id ?? "";
  const opId = `${i.kind}:${i.invoiceId}`;
  await fencedBatch(env, ctx.lease!, [
    refundOpInsert({ id: opId, kind: i.kind, homeId: i.homeId, userId, invoiceId: i.invoiceId, paidCents: i.amount, targetCents: i.amount, endPlan: false,
      cancelSubscriptionId: i.subscriptionId, subscriptionId: i.subscriptionId, inheritSubscription: false, detail: i.consent ? { path: refundPathOf(i.consent), consentId: i.consent.id } : i.path ? { path: i.path } : {} }, now),
    q("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      `alert:stranded:${i.invoiceId}`, i.homeId, "checkout.stranded_payment_refunded", "high",
      JSON.stringify({ opId, kind: i.kind, invoiceId: i.invoiceId, subscriptionId: i.subscriptionId, consentId: i.consent?.id ?? null }), now),
  ]);
  await advanceRefundOp(env, ctx, opId);
  return true;
}
/** The consent a subscription was bought with (the newest consent whose completed checkout created it). */
const consentOfSubscription = (env: Env, homeId: string, subscriptionId: string | null) => subscriptionId
  ? env.DB.prepare("SELECT * FROM checkout_consents WHERE home_id=? AND stripe_subscription_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(homeId, subscriptionId).first<ConsentRow>()
  : Promise.resolve(null);
/** The withdrawal of this subscription decided "nothing charged" (payment still pending when it was decided): a payment that settles later is
 *  owed back in full (Astra WP5-1 #1). */
const withdrawnUnpaid = async (env: Env, homeId: string, subscriptionId: string | null) => subscriptionId !== null && (await env.DB.prepare(`SELECT 1 AS x FROM refund_ops
  WHERE home_id=? AND kind='withdrawal' AND subscription_id=? AND decided_at IS NOT NULL AND invoice_id IS NULL`).bind(homeId, subscriptionId).first()) !== null;

/** Where this consent's completion stands (Astra WP5-1 #2): `completed_at` alone is not "processed". The completion handler has finished the
 *  guard, the subscription claim, the acceptance and the confirmation only when one of these holds:
 *   - rejected: the guard turned the order away (rejected_at; the cancellation and any refund follow from that batch);
 *   - lost: the claim went to another subscription (a duplicate refund operation names this one);
 *   - accepted: the home's subscription row is this consent's subscription, the acceptance is on record and the confirmation was handed off.
 *  Anything else is "pending": a later payment event waits (it is retried) until the completion has finished, never "foreign_subscription". */
async function completionState(env: Env, homeId: string, c: ConsentRow, subscriptionId: string | null): Promise<"rejected" | "lost" | "accepted" | "parked" | "pending"> {
  if (c.rejected_at !== null) return "rejected";
  if (c.acceptance_parked_at) return "parked";
  if (subscriptionId && await env.DB.prepare("SELECT 1 AS x FROM refund_ops WHERE home_id=? AND kind='duplicate' AND cancel_subscription_id=?").bind(homeId, subscriptionId).first()) return "lost";
  const live = await getSub(env, homeId);
  const claimed = subscriptionId !== null && live?.subscription_id === subscriptionId && live.consent_id === c.id;
  const accepted = await env.DB.prepare("SELECT 1 AS x FROM terms_acceptances WHERE consent_id=?").bind(c.id).first();
  return claimed && accepted && c.confirmation_sent_at !== null ? "accepted" : "pending";
}

/** The "Payment received" email (plan §3.3, §4.4), rendered from the deadlines stored with the paid moment and Stripe's own renewal date. */
function paymentNotice(c: Pick<ConsentRow, "checkout_language" | "effective_eu_region" | "eu_region">, d: { statutory: number | null; guarantee: number | null; refund7: number | null },
  renewsAt: number | null): { emailSubject: string; emailText: string; emailHtml: string } {
  const lang = c.checkout_language;
  const later = d.statutory !== null || d.guarantee !== null ? Math.max(d.statutory ?? 0, d.guarantee ?? 0) : null;
  const text = [orderWords("paymentReceived", lang),
    consentIsEu(c) && later !== null ? orderWords("paymentWithdrawUntil", lang, { date: aoeDate(later) }) : "",
    d.refund7 !== null ? orderWords("paymentRefund7Until", lang, { date: aoeDate(d.refund7) }) : "",
    renewsAt !== null ? orderWords("paymentRenewsOn", lang, { date: isoDate(renewsAt) }) : ""].filter(Boolean).join("\n\n");
  return { emailSubject: orderWords("paymentReceivedSubject", lang), emailText: text, emailHtml: htmlOf(text) };
}
/** Stripe's renewal date of a subscription (its current period end): the one we hold for it, else read from Stripe. Null when unknown. */
async function renewalDateOf(env: Env, stripe: () => StripeClient, homeId: string, subscriptionId: string | null): Promise<number | null> {
  if (!subscriptionId) return null;
  const held = await env.DB.prepare("SELECT current_period_end AS e FROM billing_subscriptions WHERE home_id=? AND subscription_id=?").bind(homeId, subscriptionId).first<{ e: number | null }>();
  if (held?.e) return held.e;
  try { const s = await stripe().getSubscription(subscriptionId); return typeof s.current_period_end === "number" ? s.current_period_end * 1000 : null; }
  catch { return null; }
}

/** The moment payment is confirmed (plan §3.3) as statements for ONE fenced batch: paid_at, the guarantee and the 7-day refund, the server start,
 *  each written once (COALESCE guards: a replayed or later event never moves them), and, with `notice`, the "Payment received" obligation in
 *  the same batch as the paid moment it announces (written only by the statement that sets paid_at: one email per order). `extra` joins the
 *  same batch (the first invoice's record: Astra WP5-1 #3). `replacement`: the guarantee runs from paid_at. */
async function paidMomentStatements(env: Env, c: ConsentRow, i: { homeId: string; subscriptionId: string | null; paidAt: number; replacement: boolean;
  notice: false | { renewsAt: number | null }; serviceStartAt?: number | null }, now: number): Promise<Q[]> {
  // `serviceStartAt`: the service start the row WILL hold once the same batch has written it (a cutover's inherited start, WP6 r2-2).
  const existing = i.serviceStartAt != null ? { service_start_at: i.serviceStartAt } : i.subscriptionId ? await env.DB.prepare("SELECT service_start_at FROM billing_subscriptions WHERE home_id=? AND subscription_id=?").bind(i.homeId, i.subscriptionId)
    .first<{ service_start_at: number | null }>() : null;
  // Every server starts at payment: service_start_at is paid_at.
  const serviceStart = existing?.service_start_at ?? i.paidAt;
  const d = deadlinesFor({ resident: consentIsEu(c), completedAt: c.completed_at ?? i.paidAt, paidAt: i.paidAt, serviceStartAt: serviceStart, replacement: i.replacement });
  // What the row will hold (a deadline already written is never moved): the notice states exactly these.
  const kept = { statutory: c.statutory_withdraw_until ?? d.statutoryWithdrawUntil, guarantee: c.guarantee_withdraw_until ?? d.guaranteeWithdrawUntil, refund7: c.refund7_until ?? d.refund7Until };
  return [
    q("UPDATE checkout_consents SET paid_at=? WHERE id=? AND paid_at IS NULL", i.paidAt, c.id),
    ...(i.notice ? [recordNotice(i.homeId, "payment_received", c.id, paymentNotice(c, kept, i.notice.renewsAt), now, true)] : []),
    q(`UPDATE checkout_consents SET statutory_withdraw_until=COALESCE(statutory_withdraw_until,?),
      guarantee_withdraw_until=COALESCE(guarantee_withdraw_until,?),refund7_until=COALESCE(refund7_until,?) WHERE id=?`,
    d.statutoryWithdrawUntil, d.guaranteeWithdrawUntil, d.refund7Until, c.id),
    ...(i.subscriptionId ? [q("UPDATE billing_subscriptions SET service_start_at=COALESCE(service_start_at,?) WHERE home_id=? AND subscription_id=?", i.paidAt, i.homeId, i.subscriptionId)] : []),
    // The first-purchase authorization of THIS order (purchase-bootstrap.ts) is consumed in the batch that records the accepted payment, on
    // every paid path (completed+paid, async success, the first invoice). Final: it never authorizes anything again.
    bootstrapTransitionQ("consumed", PRE_PAYMENT, { homeId: i.homeId, consentId: c.id, now }),
  ];
}
async function recordPaidMoment(env: Env, lease: HomeLease, c: ConsentRow, i: { homeId: string; subscriptionId: string | null; paidAt: number; replacement: boolean;
  notice: false | { renewsAt: number | null } }, now: number, extra: Q[] = []): Promise<void> {
  await fencedBatch(env, lease, [...extra, ...await paidMomentStatements(env, c, i, now)]);
}
/** Sends the recorded "Payment received" notice now (the sweep retries a failed send; the obligation is already on record). */
async function sendPaymentNotice(env: Env, deps: BillingDependencies, homeId: string, consentId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT payload,sent_at FROM billing_notices WHERE id=?").bind(noticeId("payment_received", homeId, consentId)).first<{ payload: string; sent_at: number | null }>();
  if (!row || row.sent_at !== null) return;
  try { await notify(env, deps, homeId, "payment_received", consentId, JSON.parse(row.payload) as Record<string, unknown>); } catch { /* the sweep retries */ }
}


/** The explicit repair step of a parked acceptance: once the consent's acceptance line is on record again, this releases the parking and puts
 *  the parked completion event back in the queue (under the home's lease), so the sweep replays it through the normal, idempotent handler.
 *  Refused (false) while the line is still missing (a replay would only park again) and once the order was cancelled and refunded
 *  (refundParkedOrder). Called by POST /v1/admin/orders/{consentId}/release-parked (replayParkedAcceptance). */
export async function releaseParkedAcceptance(env: Env, consentId: string, deps: BillingDependencies = {}): Promise<boolean> {
  const c = await getConsent(env, consentId);
  if (!c?.acceptance_parked_at || c.rejected_at !== null) return false;
  let line: string | undefined;
  try { line = (JSON.parse(c.wording) as Record<string, string>).acceptance; } catch { line = undefined; }
  line ??= archivedSnapshot(c).lines?.acceptance;
  if (line === undefined && c.start_request_at !== null) return false;
  const now = (deps.now ?? Date.now)();
  await withHomeLease(env, c.home_id, (lease) => fencedBatch(env, lease, [
    q("UPDATE checkout_consents SET acceptance_parked_at=NULL WHERE id=?", consentId),
    q(`UPDATE stripe_events SET processed_at=NULL,error=NULL,next_attempt_at=? WHERE type='checkout.session.completed' AND error='acceptance_parked'
      AND json_extract(payload,'$.data.object.metadata.consent_id')=?`, now, consentId),
    q("UPDATE cloud_alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL", now, `alert:acceptance_missing:${consentId}`),
  ]), deps.lease);
  return true;
}

/** Release AND real replay (Astra WP5-2 #1): the parked completion, then every event of this order still waiting on it (an asynchronous
 *  payment, in the order received), are run now through processStoredEvent, the same path as the webhook and the sweep. A failed replay
 *  stays queued for the sweep. `released: false` when the line is still missing, the consent is not parked, or the order was refunded. */
export async function replayParkedAcceptance(env: Env, consentId: string, deps: BillingDependencies = {}): Promise<{ released: boolean;
  replayed: { eventId: string; outcome: string | null }[] }> {
  if (!await releaseParkedAcceptance(env, consentId, deps)) return { released: false, replayed: [] };
  const config = billingConfig(env);
  if (!config) return { released: true, replayed: [] };
  const queued = await env.DB.prepare(`SELECT id FROM stripe_events WHERE processed_at IS NULL AND type LIKE 'checkout.session.%'
    AND json_extract(payload,'$.data.object.metadata.consent_id')=? ORDER BY CASE WHEN type='checkout.session.completed' THEN 0 ELSE 1 END, received_at`)
    .bind(consentId).all<{ id: string }>();
  const replayed: { eventId: string; outcome: string | null }[] = [];
  for (const e of queued.results) {
    try { await processStoredEvent(env, config, deps, e.id); } catch { /* recorded on the event; the sweep retries it */ }
    const r = await env.DB.prepare("SELECT processed_at,error FROM stripe_events WHERE id=?").bind(e.id).first<{ processed_at: number | null; error: string | null }>();
    replayed.push({ eventId: e.id, outcome: r?.processed_at ? r.error ?? "processed" : `pending:${r?.error ?? "unknown"}` });
  }
  return { released: true, replayed };
}

/** cloud_alerts keeps ONE open alert per home and kind (a unique index), so a plain insert for a second affected order would be dropped
 *  silently (Astra WP5-5 #2). This opens the alert, or adds the new entry to the open one: detail.items lists every entry, `${key}s` lists
 *  their ids, and the top-level fields stay those of the first entry. Adding an entry re-arms delivery (delivered_at cleared, attempts reset)
 *  so ops is told again with the full list. An entry already listed changes nothing. Returned as statements for the caller's fenced batch. */
async function openOrAddAlertStmts(env: Env, homeId: string, kind: string, newId: string, key: string, entry: Record<string, unknown>, now: number): Promise<Q[]> {
  const open = await env.DB.prepare("SELECT id,detail FROM cloud_alerts WHERE home_id=? AND kind=? AND resolved_at IS NULL").bind(homeId, kind)
    .first<{ id: string; detail: string }>();
  if (!open) {
    return [q("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING", newId, homeId, kind, "high",
      JSON.stringify({ ...entry, [`${key}s`]: [entry[key]], items: [entry] }), now)];
  }
  let detail: Record<string, unknown> = {};
  try { detail = JSON.parse(open.detail) as Record<string, unknown>; } catch { detail = {}; }
  // An alert written before this rule (one entry, no list) counts as that one entry.
  const items = Array.isArray(detail.items) ? (detail.items as unknown[]).filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : [{ ...detail }];
  if (items.some((x) => x[key] === entry[key])) return [];
  // `revision` counts the changes to the contents (Astra WP5-6 #3). The sender marks the alert delivered only if the contents it sent are
  // still the contents stored (ops-monitor deliver), so a send of the previous list that finishes after this change never hides it.
  const next = { ...detail, [`${key}s`]: [...items.map((x) => x[key]), entry[key]], items: [...items, entry],
    revision: (typeof detail.revision === "number" ? detail.revision : 0) + 1 };
  // Applied only if the alert is still open and unchanged since it was read; the caller holds the home's lease.
  return [q("UPDATE cloud_alerts SET detail=?,delivered_at=NULL,delivery_attempts=0 WHERE id=? AND resolved_at IS NULL AND detail=?",
    JSON.stringify(next), open.id, open.detail)];
}

/** How long a paid order may stay parked for a missing acceptance line before it is cancelled and refunded automatically. */
export const PARKED_REFUND_AFTER_MS = 24 * 3_600_000;
/** A paid customer is never parked indefinitely (Astra WP5-2 #1): an acceptance that could not be recovered within PARKED_REFUND_AFTER_MS
 *  is turned away through the guard's own fenced path (rejectOrder, kind rejected_consent: the consent rejected, the subscription tombstoned
 *  and cancelled without proration, a full refund through the WP3 ledger, the checkout released, ops and the customer told). Built from the
 *  parked completion event as received. A payment that clears later is refunded by its own event (completionState "rejected"). */
async function refundParkedOrder(env: Env, config: BillingConfig, deps: BillingDependencies, lease: HomeLease, consentId: string, now: number): Promise<void> {
  const c = await getConsent(env, consentId);
  if (!c?.acceptance_parked_at || c.rejected_at !== null || c.home_id !== lease.homeId) return;
  const ev = await env.DB.prepare(`SELECT payload FROM stripe_events WHERE type='checkout.session.completed'
    AND json_extract(payload,'$.data.object.metadata.consent_id')=? ORDER BY received_at DESC LIMIT 1`).bind(consentId).first<{ payload: string }>();
  if (!ev) throw new Error("parked_event_missing");
  const session = rec(rec((JSON.parse(ev.payload) as Obj).data).object);
  const paid = session.payment_status === "paid" || session.payment_status === "no_payment_required";
  const subscriptionId = str(session.subscription);
  // Re-checked under the lease before anything is rejected (Astra WP5-3 #1): a completion that finished after a repair (a distinct completion
  // event, a replay) is an accepted order, and one whose claim was lost is already refunded by its duplicate operation. Either way the
  // parking is released, never refunded on top.
  const state = await completionState(env, c.home_id, { ...c, acceptance_parked_at: null }, subscriptionId);
  // Completed on record (Astra WP5-4 #1): the acceptance is stored and the confirmation was handed off, which the completion handler does only
  // after the claim. Such an order WAS accepted, whoever owns the home now (its subscription may have ended and a replacement taken over).
  // It is released, never rejected: a rejection here would end the replacement's service.
  const completedEarlier = c.confirmation_sent_at !== null
    && await env.DB.prepare("SELECT 1 AS x FROM terms_acceptances WHERE consent_id=?").bind(c.id).first() !== null;
  const current = await getSub(env, c.home_id);
  /** Releases the parking. `why` set: ops is told once, on the home's one checkout.parked_order_released alert (every such order listed). */
  const release = async (why: string | null) => fencedBatch(env, lease, [
    q("UPDATE checkout_consents SET acceptance_parked_at=NULL WHERE id=? AND rejected_at IS NULL", consentId),
    q("UPDATE cloud_alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL", now, `alert:acceptance_missing:${consentId}`),
    ...(why ? await openOrAddAlertStmts(env, c.home_id, "checkout.parked_order_released", `alert:parked_released:${consentId}`, "consentId",
      { consentId, reason: why, subscriptionId, currentSubscriptionId: current?.subscription_id ?? null }, now) : []),
  ]);
  if (state === "accepted" || state === "lost") { await release(null); return; }
  if (completedEarlier) { await release("completed_earlier"); return; }
  // Provisioned already (its payment reached the lifecycle): rejected WITH its service ended, never refunded while left running.
  const provisioned = await env.DB.prepare(`SELECT 1 AS x FROM cloud_payment_inbox WHERE home_id=? AND json_extract(payload,'$.status')='paid'
    AND json_extract(payload,'$.paymentId') IN (?,?)`).bind(c.home_id, idOf(session.invoice) ?? "", str(session.id) ?? "").first() !== null;
  // Ending the service stops the whole home, so it is allowed only while the home's current subscription AND its consent are this order's
  // (Astra WP5-4 #1). Anything else (another contract owns the home, or none does) is still refunded in full: an unprocessed paid entry
  // proves neither that the server was set up nor that service was given, and a paid order is never parked past 24 hours (Astra WP5-5 #1).
  // Only this order's OWN subscription is cancelled and its own invoice refunded through the ledger (endService false: the plan the home
  // has now, its state and its credits are not touched), and ops is told on the home's one parked_order_released alert.
  const owns = subscriptionId !== null && current?.subscription_id === subscriptionId && current.consent_id === c.id;
  const displaced = provisioned && !owns ? { reason: "not_current_subscription", currentSubscriptionId: current?.subscription_id ?? null } : undefined;
  const flux = deps.flux ?? stubFluxHooks;
  await rejectOrder(env, { ...deps, lease }, { stripe: stripeClient(config, deps.stripeFetch), flux, deps: { ...deps, lease }, now, lease }, c, { verdict: "rejected_consent",
    homeId: c.home_id, subscriptionId, session, collected: str(rec(rec(session.customer_details).address).country), paid, endService: provisioned && owns, displaced }, now);
  await fencedRun(env, lease, "UPDATE cloud_alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL", now, `alert:acceptance_missing:${consentId}`);
}

/** Applies the stored top-up authorization to Flux auto-recharge (B4). Returns false (and records why) when it could not be applied yet;
 *  the billing sweep retries. A switch-off that Flux has not taken yet is a high alert: Flux would keep charging. */
export async function applyTopup(env: Env, lease: HomeLease, flux: FluxEntitlementHooks, homeId: string, now: number): Promise<boolean> {
  let t = await getTopup(env, homeId);
  if (!t) return true;
  // Eligibility is enforced HERE, on the leased path every write to Flux auto-recharge takes (checkout, the account page, the sweep): a home
  // whose contract is a Link (Managed Payments) sale never has automatic top-up on, whatever was stored before. A stored "on" is switched
  // off (a new revision, recorded) and Flux is told enabled:false.
  const link = await homeSoldByLink(env, homeId, true);
  if (link && t.enabled === 1) {
    await saveTopup(env, lease, { homeId, userId: t.user_id, enabled: false, amountCents: t.amount_cents, thresholdCents: t.threshold_cents, capCents: t.cap_cents,
      consentId: null, source: "link_not_eligible", ip: null, userAgent: null }, now);
    t = (await getTopup(env, homeId))!;
  }
  if (t.applied_revision === t.revision) return true;
  try {
    await flux.setAutoRecharge(env, { homeId, enabled: t.enabled === 1 && !link, amountMicrocents: t.amount_cents * 10_000, thresholdMicrocents: t.threshold_cents * 10_000,
      monthlyCapMicrocents: t.cap_cents * 10_000, revision: t.revision, consentId: t.consent_id });
    await fencedBatch(env, lease, [
      q("UPDATE topup_settings SET applied_revision=?,applied_at=?,apply_error=NULL WHERE home_id=? AND revision=?", t.revision, now, homeId, t.revision),
      q("UPDATE cloud_alerts SET resolved_at=? WHERE home_id=? AND kind='topup.not_applied' AND resolved_at IS NULL", now, homeId),
    ]);
    return true;
  } catch (e) {
    if (e instanceof LeaseLost) throw e;
    const code = (e instanceof Error ? e.message : "error").slice(0, 80);
    await fencedRun(env, lease, "UPDATE topup_settings SET apply_error=? WHERE home_id=? AND revision=?", code, homeId, t.revision);
    if (!flux.stub && (t.enabled === 0 || (t.applied_revision ?? 0) > 0)) {
      await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
        .bind(crypto.randomUUID(), homeId, "topup.not_applied", "high", JSON.stringify({ revision: t.revision, enabled: t.enabled === 1, error: code }), now).run();
    }
    return false;
  }
}

/** True when the home's contract is a Link (Managed Payments) sale. `completedOnly`: only a checkout that completed counts (an open Link
 *  checkout does not end a running direct contract's top-up). */
export async function homeSoldByLink(env: Env, homeId: string, completedOnly = false): Promise<boolean> {
  const c = await env.DB.prepare(`SELECT c.tax_source FROM billing_subscriptions b JOIN checkout_consents c ON c.id=b.consent_id WHERE b.home_id=?
    ${completedOnly ? "AND c.completed_at IS NOT NULL" : ""}`).bind(homeId).first<{ tax_source: string | null }>();
  return c !== null && sellerOfConsent(c) === "link";
}
/** A Link contract took the home over: any automatic top-up authorization from an earlier direct contract is switched off and Flux told. */
async function disableTopupForLink(env: Env, lease: HomeLease, flux: FluxEntitlementHooks, homeId: string, _userId: string, now: number): Promise<void> {
  if (await getTopup(env, homeId)) await applyTopup(env, lease, flux, homeId, now);
}

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const idOf = (v: unknown): string | null => str(v) ?? (v && typeof v === "object" ? str((v as Obj).id) : null);
const rec = (v: unknown): Obj => (v && typeof v === "object" ? v as Obj : {});

async function resolveHome(env: Env, obj: Obj, extra: { customer?: string | null; subscription?: string | null } = {}): Promise<{ homeId: string; sub: SubRow | null }> {
  // Basil: an invoice names its subscription in parent.subscription_details (invoiceView reads both shapes).
  const invoiceSub = str(obj.object) === "invoice" ? invoiceView(obj).subscription : null;
  const subscription = extra.subscription ?? invoiceSub ?? str(obj.subscription) ?? (str(obj.object) === "subscription" ? str(obj.id) : null);
  const customer = extra.customer ?? idOf(obj.customer);
  let sub: SubRow | null = null;
  if (subscription) sub = await env.DB.prepare("SELECT * FROM billing_subscriptions WHERE subscription_id=?").bind(subscription).first<SubRow>();
  if (!sub && customer) sub = await env.DB.prepare("SELECT * FROM billing_subscriptions WHERE customer_id=?").bind(customer).first<SubRow>();
  if (sub) return { homeId: sub.home_id, sub };
  // Astra TAXCOUNTRY-6 P1: a customer the home was moved away from, or an orphan of its own attempts, is still this home's (the ownership
  // ledger): the event is handled under that home with its CURRENT record as `sub`, so every handler treats the payment as a historical
  // contract's (never the retained one's).
  const owner = customer ? await homeOfCustomer(env, customer) : null;
  if (owner && await getHome(env, owner)) {
    return { homeId: owner, sub: await env.DB.prepare("SELECT * FROM billing_subscriptions WHERE home_id=?").bind(owner).first<SubRow>() };
  }
  const meta = rec(obj.metadata); const details = str(obj.object) === "invoice" ? invoiceView(obj).subscriptionMetadata : rec(rec(obj.subscription_details).metadata);
  const fallback = str(meta.home_id) ?? str(details.home_id) ?? str(obj.client_reference_id);
  if (fallback && await getHome(env, fallback)) return { homeId: fallback, sub: null };
  throw new Error("home_unresolved");
}
const planOf = (config: BillingConfig, priceId: string | null, fallback: string | null): Plan | null =>
  (priceId && config.planByPrice.get(priceId)) || ((PLANS as readonly string[]).includes(fallback ?? "") ? fallback as Plan : null);

export const noticeId = (kind: NoticeKind, homeIdValue: string, key: string) => `${kind}:${homeIdValue}:${key}`;
/** The notice row that `notify` (and, failing that, the sweep) sends, as a statement for the SAME transaction as the action it confirms:
 *  the obligation exists the moment the action does, so a crash, a lost lease or a busy home in between cannot lose a required email
 *  (Astra MAKERKIT2 #3). `afterChange`: insert only if the statement just before it changed exactly one row. */
export const recordNotice = (homeIdValue: string, kind: NoticeKind, key: string, data: Record<string, unknown>, now: number, afterChange = false): Q =>
  q(`INSERT INTO billing_notices (id,home_id,kind,payload,created_at) SELECT ?,?,?,?,? WHERE ${afterChange ? "changes()=1" : "1=1"} ON CONFLICT(id) DO NOTHING`,
    noticeId(kind, homeIdValue, key), homeIdValue, kind, JSON.stringify(data), now);

export async function notify(env: Env, deps: BillingDependencies, homeIdValue: string, kind: NoticeKind, key: string, data: Record<string, unknown>) {
  const home = await env.DB.prepare("SELECT owner_id FROM cloud_homes WHERE id=?").bind(homeIdValue).first<{ owner_id: string }>();
  if (!home) return;
  const notice = { id: noticeId(kind, homeIdValue, key), homeId: homeIdValue, ownerId: home.owner_id, kind, data };
  // Sent under the home's lease (re-entrant when the caller already holds it).
  await withHomeLease(env, homeIdValue, (lease) => (deps.notifier ?? defaultNotifier).notify(env, notice, lease), deps.lease);
}

/** G-F1 (STRIPE-8) / Astra INTEGRATED-11: THE DISPUTE HOLD FIRST, ONE ROW PER EVENT. Written from the dispute EVENT ITSELF before its home is
 *  resolved and outside any lease: from this moment no refund in the hold's SCOPE is decided, submitted or adopted (legal-refunds.ts
 *  disputeHeldFirst), so a refund is never admitted while the bank is already reversing the payment.
 *  - SCOPE, always (a CHECK; never a hold on everyone): the disputed payment intent (named by the event, or found in our own records by the
 *    charge), the invoice it belongs to (our records, else Stripe's InvoicePayment), and only when neither is known the charge's customer when
 *    it is ours. INTEGRATED-12: whatever our own records know is committed as the hold BEFORE any Stripe call; a scope not completely
 *    attributed yet (no invoice known, or nothing at all) is written ATTRIBUTION PENDING (scope_pending) and fences every refund it could
 *    belong to until it is resolved (retried on every pass of its event: a lookup failure throws after the hold committed, recorded on the
 *    event's normal retry path; paged after DISPUTE_HOLD_PAGE_MS; operator-closable with evidence). An event whose charge belongs to nothing
 *    of ours is released at resolution (closed_by system:unmatched) and paged at once as dispute.unmatched.
 *  - PER EVENT (INTEGRATED-11 P1): every event of DISPUTE_HOLD_EVENTS arms its own row (event_id); each is released ONLY by the committed
 *    checkpoint of that same event (processStoredEvent, the fenced batch that marks it processed), or by an operator's evidenced close
 *    (POST /v1/admin/dispute-holds/{eventId}/close). Recording the dispute row, a failed Stripe retrieval, or another event's checkpoint
 *    never releases it; a retry keeps it (a released row is never re-armed by a redelivery: its event is applied or closed).
 *  - charge.dispute.updated is NOT a hold event (INTEGRATED-11 P1-2c): it moves no money and changes no outcome (funds_withdrawn,
 *    funds_reinstated and closed do), and it has no handler (checkpointed as ignored_type), so it never arms a hold nobody releases.
 *  Unreleased after DISPUTE_HOLD_PAGE_MS it pages (sweepDisputeHolds) naming the operator's close. Amounts and closure are never read from
 *  here. Returns whether a hold of this event is in force. */
export const DISPUTE_HOLD_PAGE_MS = 15 * 60_000;
/** INTEGRATED-13 P1-1: THE ESCALATION LADDER of an unreleased hold (its unresolved lifetime is bounded by people, not by time: only its
 *  event's checkpoint, its attribution or an operator's evidenced close releases it): paged at DISPUTE_HOLD_PAGE_MS, escalated (critical)
 *  at 2 hours and again at 6 hours (re-delivered). The refunds it holds also enter the statutory-deadline alerts (legal-refunds.ts). */
export const DISPUTE_HOLD_ESCALATE_MS = [2 * 3_600_000, 6 * 3_600_000] as const;
const DISPUTE_HOLD_EVENTS = new Set(["charge.dispute.created", "charge.dispute.closed", "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated"]);
export interface DisputeHoldLookup {
  charge(id: string): Promise<{ customer: string | null; invoice: string | null; payment_intent: string | null }>;
  invoiceOfPayment(pi: string): Promise<string | null>;
}
export const disputeHoldLookup = (config: BillingConfig, deps: BillingDependencies): DisputeHoldLookup => {
  const st = () => stripeClient(config, deps.stripeFetch);
  return { charge: (id) => st().getCharge(id), invoiceOfPayment: (pi) => st().invoiceOfPayment(pi) };
};
/** The invoice of a payment intent from our own records only (no Stripe call). */
async function localInvoiceOfPayment(env: Env, pi: string): Promise<string | null> {
  const r = await env.DB.prepare(`SELECT invoice_id AS i FROM refund_ops WHERE payment_intent=?1 AND invoice_id IS NOT NULL
      UNION ALL SELECT first_invoice_id FROM billing_subscriptions WHERE first_payment_intent=?1 AND first_invoice_id IS NOT NULL
      UNION ALL SELECT invoice_id FROM refund_coverage WHERE payment_intent=?1 AND invoice_id IS NOT NULL
      UNION ALL SELECT invoice_id FROM payment_disputes WHERE payment_intent=?1 AND invoice_id IS NOT NULL LIMIT 1`).bind(pi).first<{ i: string }>();
  return r?.i ?? null;
}
export async function holdDisputeFirst(env: Env, event: { id: string; type: string; data: { object: unknown } }, now: number,
  lookup?: DisputeHoldLookup): Promise<boolean> {
  if (!DISPUTE_HOLD_EVENTS.has(event.type)) return false;
  const obj = (event.data.object ?? {}) as Obj;
  const chargeId = idOf(obj.charge);
  if (!chargeId) return false; // no charge: the event's processing fails (charge_unresolved) and is retried; nothing to scope a hold by
  const live = await env.DB.prepare("SELECT attributed_at,scope_pending,payment_intent FROM dispute_holds WHERE event_id=?").bind(event.id)
    .first<{ attributed_at: number | null; scope_pending: number; payment_intent: string | null }>();
  if (live && live.attributed_at !== null) return false; // armed once per event; a released row is never re-armed
  if (!live) {
    const processed = await env.DB.prepare("SELECT 1 AS x FROM stripe_events WHERE id=? AND processed_at IS NOT NULL").bind(event.id).first();
    if (processed) return false;
    // INTEGRATED-12 P1-1: OWNERSHIP BEFORE ANY EXTERNAL I/O. Every scope our own records know (by the charge: its payment intent and its
    // invoice, whichever row names them; then by the payment; INTEGRATED-13: and the customer they belong to) is committed as the hold
    // FIRST. Nothing known: the hold is still written, ATTRIBUTION PENDING (scope_pending), before the Stripe lookup that may fail; it fences
    // every refund it could belong to meanwhile (its customer's once the customer is known).
    const local = await localAttribution(env, chargeId, idOf(obj.payment_intent));
    await env.DB.prepare(`INSERT INTO dispute_holds (event_id,charge_id,dispute_id,event_type,payment_intent,invoice_id,customer_id,amount_cents,currency,held_at,scope_pending)
        SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11 WHERE NOT EXISTS (SELECT 1 FROM stripe_events e WHERE e.id=?1 AND e.processed_at IS NOT NULL)
      ON CONFLICT(event_id) DO NOTHING`)
      .bind(event.id, chargeId, str(obj.id) ?? event.id, event.type, local.pi, local.invoice, local.invoice ? null : local.customer, cents(obj.amount),
        str(obj.currency)?.toLowerCase() ?? null, now, local.invoice ? 0 : 1).run();
    const armed = await env.DB.prepare("SELECT attributed_at,scope_pending FROM dispute_holds WHERE event_id=?").bind(event.id)
      .first<{ attributed_at: number | null; scope_pending: number }>();
    if (!armed || armed.attributed_at !== null) return false;
    if (armed.scope_pending === 0) return true;
  } else {
    if (live.scope_pending === 0) return true;
    // INTEGRATED-13 P1-1: EVERY RETRY REFRESHES THE ATTRIBUTION FROM OUR OWN RECORDS FIRST: a local mapping of the charge (its payment, its
    // invoice, its customer) that appeared since the last pass is committed before any Stripe call, and resolves the hold when it names
    // the invoice; a failing Stripe lookup never keeps it from being used.
    const local = await localAttribution(env, chargeId, live.payment_intent ?? idOf(obj.payment_intent));
    if (!await narrowHold(env, event.id, local, now)) return true;
  }
  // INTEGRATED-12 P1-2: the scope is not completely attributed: resolved now, and on EVERY retry of the event until it is (a retry never
  // returns early on a pending hold). A failure THROWS after the hold is committed: the event's failure is recorded on the normal retry path
  // (processStoredEvent), the hold keeps fencing, it pages after DISPUTE_HOLD_PAGE_MS and escalates at 2 and 6 hours (sweepDisputeHolds;
  // operator-closable with evidence).
  // INTEGRATED-13 P1-1: EACH SCOPE IS COMMITTED THE MOMENT IT IS KNOWN, before any further Stripe I/O (narrowHold): the charge's payment
  // intent and customer are durable before the invoice lookup that may fail, so a pending hold keeps only that customer's refunds (and that
  // payment's), never every customer's.
  if (!lookup) return true;
  const cur = await env.DB.prepare("SELECT payment_intent,customer_id FROM dispute_holds WHERE event_id=? AND attributed_at IS NULL AND scope_pending=1")
    .bind(event.id).first<{ payment_intent: string | null; customer_id: string | null }>();
  if (!cur) return true;
  let pi = cur.payment_intent;
  if (!pi) {
    const charge = await lookup.charge(chargeId); // a failure throws: retried; what our records know is already committed
    pi = charge.payment_intent ?? null;
    const invoice = charge.invoice ?? null;
    // The customer scopes a RESOLVED hold only when the charge names neither a payment nor an invoice, and only when it is ours.
    // INTEGRATED-14 P1: "ours" is the immutable ownership history (homeOfCustomer: the pointer, the ownership ledger, previous and orphan
    // records), never only a current pointer: a customer the home was moved away from is still ours, and its dispute still holds.
    const ours = charge.customer ? await homeOfCustomer(env, charge.customer) : null;
    if (!pi && !invoice && !ours) {
      // INTEGRATED-11 P1-2b: nothing of ours: the pending hold is released (by the system, with what was read) and paged as unmatched; the
      // refunds it fenced meanwhile are due again at once.
      await env.DB.batch([
        env.DB.prepare(WAKE_HELD_BY_HOLD_SQL).bind(event.id, now),
        env.DB.prepare(`UPDATE dispute_holds SET attributed_at=?1,closed_by='system:unmatched',close_evidence=?2 WHERE event_id=?3 AND attributed_at IS NULL`)
          .bind(now, `Stripe charge ${chargeId}: no payment intent, no invoice, customer ${charge.customer ?? "none"} has no subscription of ours`, event.id),
        env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject)
          SELECT ?1,'billing','dispute.unmatched','high',json_object('eventId',?2,'type',?3,'chargeId',?4,'disputeId',?5,'customer',?6,
            'rule','a dispute whose charge matches no payment, invoice or customer of ours: no refund is held for it; check the charge in Stripe'),?7,?2
          WHERE NOT EXISTS (SELECT 1 FROM stripe_events e WHERE e.id=?2 AND e.processed_at IS NOT NULL) ON CONFLICT(id) DO NOTHING`)
          .bind(`alert:dispute_unmatched:${event.id}`, event.id, event.type, chargeId, str(obj.id) ?? null, charge.customer ?? null, now),
      ]);
      return false;
    }
    // Committed NOW, before the invoice lookup: the payment, the invoice when the charge names it (resolved), and the charge's customer
    // (narrowing the pending scope to that customer's refunds; the resolved scope of a charge naming neither payment nor invoice).
    if (!await narrowHold(env, event.id, { pi, invoice, customer: charge.customer ?? null, resolved: !pi && !invoice }, now)) return true;
  } else if (!cur.customer_id) {
    // The payment is known but not its customer: the charge names it (narrowing only: a failed READ never stops the invoice lookup below).
    // INTEGRATED-14 P2: only the charge read is caught. What it named (its customer, its invoice) is committed before any further Stripe
    // call; a failure of that commit propagates (the event fails and is retried, the hold keeps its wider scope), never followed by I/O.
    let charge: Awaited<ReturnType<DisputeHoldLookup["charge"]>> | null = null;
    try { charge = await lookup.charge(chargeId); }
    catch { /* the pending hold keeps its wider scope; the invoice lookup below still runs */ }
    if (charge && !await narrowHold(env, event.id, { invoice: charge.invoice ?? null, customer: charge.customer ?? null }, now)) return true;
  }
  const invoice = await localInvoiceOfPayment(env, pi!) ?? await lookup.invoiceOfPayment(pi!); // a failure throws: retried
  // Resolved (an invoice, or none exists for the payment): the hold narrows to its scope, and what it fenced beyond it is due again now.
  await narrowHold(env, event.id, { pi, invoice, resolved: true }, now);
  return true;
}
/** INTEGRATED-13 P1-1: what OUR OWN records know about a disputed charge: its payment intent (`pi`, from the event, else by the charge), its
 *  invoice (by the charge, else by the payment) and its customer (the home that any of them belongs to). No Stripe call. */
async function localAttribution(env: Env, chargeId: string, eventPi: string | null): Promise<{ pi: string | null; invoice: string | null; customer: string | null }> {
  const known = await env.DB.prepare(`SELECT MAX(pi) AS pi,MAX(inv) AS inv FROM (SELECT payment_intent AS pi,invoice_id AS inv FROM payment_disputes WHERE charge_id=?1
      UNION ALL SELECT payment_intent,invoice_id FROM refund_ops WHERE charge_id=?1)`).bind(chargeId).first<{ pi: string | null; inv: string | null }>();
  const pi = eventPi ?? known?.pi ?? null;
  const invoice = known?.inv ?? (pi ? await localInvoiceOfPayment(env, pi) : null);
  const c = await env.DB.prepare(`SELECT b.customer_id AS c FROM billing_subscriptions b WHERE ?2 IS NOT NULL AND b.first_payment_intent=?2
      UNION ALL SELECT b.customer_id FROM refund_ops o JOIN billing_subscriptions b ON b.home_id=o.home_id WHERE o.charge_id=?1 OR (?2 IS NOT NULL AND o.payment_intent=?2)
      UNION ALL SELECT b.customer_id FROM payment_disputes d JOIN billing_subscriptions b ON b.home_id=d.home_id WHERE d.charge_id=?1 OR (?2 IS NOT NULL AND d.payment_intent=?2)
      UNION ALL SELECT b.customer_id FROM refund_coverage r JOIN billing_subscriptions b ON b.home_id=r.home_id WHERE ?2 IS NOT NULL AND r.payment_intent=?2
      LIMIT 1`).bind(chargeId, pi).first<{ c: string }>();
  return { pi, invoice, customer: c?.c ?? null };
}
/** INTEGRATED-13 P1-1: commits what is now known of a PENDING hold's scope, at once (one batch): its payment intent, invoice and customer
 *  where still unknown; `resolved` (or an invoice now known) ends the pending state. The refunds the wider scope held are woken in the same
 *  batch (WAKE_HELD_BY_HOLD_SQL, before the narrowing): those still in scope are held again on their next pass. Nothing new: no write.
 *  Returns whether the hold is STILL pending. */
async function narrowHold(env: Env, eventId: string, s: { pi?: string | null; invoice?: string | null; customer?: string | null; resolved?: boolean },
  now: number): Promise<boolean> {
  const cur = await env.DB.prepare("SELECT payment_intent,invoice_id,customer_id FROM dispute_holds WHERE event_id=? AND attributed_at IS NULL AND scope_pending=1")
    .bind(eventId).first<{ payment_intent: string | null; invoice_id: string | null; customer_id: string | null }>();
  if (!cur) return false;
  const resolved = s.resolved === true || !!(s.invoice ?? cur.invoice_id);
  const adds = (!!s.pi && !cur.payment_intent) || (!!s.invoice && !cur.invoice_id) || (!!s.customer && !cur.customer_id);
  if (!adds && !resolved) return true;
  await env.DB.batch([
    env.DB.prepare(WAKE_HELD_BY_HOLD_SQL).bind(eventId, now),
    // The customer narrows a PENDING scope only: once resolved, a hold its payment or invoice scopes keeps no customer (the customer scopes
    // a resolved hold only when the charge names neither: INTEGRATED-11 P1-2).
    env.DB.prepare(`UPDATE dispute_holds SET payment_intent=COALESCE(payment_intent,?1),invoice_id=COALESCE(invoice_id,?2),
        customer_id=CASE WHEN ?4=1 AND COALESCE(payment_intent,?1,invoice_id,?2) IS NOT NULL THEN NULL ELSE COALESCE(customer_id,?3) END,
        scope_pending=CASE WHEN ?4=1 THEN 0 ELSE 1 END WHERE event_id=?5 AND attributed_at IS NULL AND scope_pending=1`)
      .bind(s.pi ?? null, s.invoice ?? null, s.customer ?? null, resolved ? 1 : 0, eventId),
  ]);
  return !resolved;
}
/** G-F1 / INTEGRATED-11: every hold still unreleased DISPUTE_HOLD_PAGE_MS after it was armed raises ONE high alert per EVENT (selected by
 *  the hold itself, never by a home), naming its scope and the operator's evidenced close; resolved once released (its event's checkpoint
 *  committed, or closed). An unmatched dispute's page is resolved once its event is processed. Bounded, oldest first. */
export async function sweepDisputeHolds(env: Env, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject)
      SELECT 'alert:dispute_hold:' || h.event_id,'billing','dispute.hold_unattributed','high',json_object('eventId',h.event_id,'type',h.event_type,
        'chargeId',h.charge_id,'disputeId',h.dispute_id,'paymentIntent',h.payment_intent,'invoiceId',h.invoice_id,'customerId',h.customer_id,'heldAt',h.held_at,
        'scopePending',h.scope_pending,
        'rule',CASE WHEN h.scope_pending=1 THEN 'a dispute event whose payment or invoice is not attributed yet (the Stripe lookup failed): every refund it could belong to (its customer''s when known, else every refund) is held until the attribution succeeds (Stripe and the sweep retry it)'
          ELSE 'a dispute event of this payment is not applied yet: every refund of its payment (and invoice) is held until the event is processed (Stripe and the sweep retry it)' END,
        'action','POST /v1/admin/dispute-holds/' || h.event_id || '/close {by, evidence[, homeId]} once the dispute is verified in Stripe (or the charge is not ours)'),?1,h.event_id
      FROM dispute_holds h WHERE h.attributed_at IS NULL AND h.paged_at IS NULL AND h.held_at<=?1-${DISPUTE_HOLD_PAGE_MS}
        AND NOT EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.id='alert:dispute_hold:' || h.event_id AND a.resolved_at IS NULL)
      ORDER BY h.held_at LIMIT 50
      ON CONFLICT(id) DO UPDATE SET resolved_at=NULL,detail=excluded.detail,raised_at=excluded.raised_at,delivered_at=NULL,delivery_attempts=0
        WHERE cloud_alerts.resolved_at IS NOT NULL`).bind(now),
    env.DB.prepare(`UPDATE dispute_holds SET paged_at=?1 WHERE attributed_at IS NULL AND paged_at IS NULL AND held_at<=?1-${DISPUTE_HOLD_PAGE_MS}
      AND EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.id='alert:dispute_hold:' || dispute_holds.event_id AND a.resolved_at IS NULL)`).bind(now),
    // INTEGRATED-13 P1-1: the ladder. ONE critical escalation per event, raised at 2 hours and escalated again (re-delivered) at 6 hours,
    // naming its scope, how long it has held, and the operator's evidenced close. Bounded, oldest first.
    env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject)
      SELECT 'alert:dispute_hold_escalated:' || h.event_id,'billing','dispute.hold_escalated','critical',json_object('eventId',h.event_id,'type',h.event_type,
        'level',CASE WHEN h.held_at<=?1-${DISPUTE_HOLD_ESCALATE_MS[1]} THEN '6h' ELSE '2h' END,'heldAt',h.held_at,'heldForMs',?1-h.held_at,
        'chargeId',h.charge_id,'disputeId',h.dispute_id,'paymentIntent',h.payment_intent,'invoiceId',h.invoice_id,'customerId',h.customer_id,'scopePending',h.scope_pending,
        'rule','a dispute hold still unreleased: every refund in its scope (every refund while nothing at all is attributed) waits, and statutory refund deadlines keep running (see refund.statutory_deadline); it is released only by its event being applied, its attribution, or an operator''s evidenced close',
        'action','POST /v1/admin/dispute-holds/' || h.event_id || '/close {by, evidence[, homeId]} once the dispute is verified in Stripe (or the charge is not ours)'),?1,h.event_id
      FROM dispute_holds h WHERE h.attributed_at IS NULL AND h.held_at<=?1-${DISPUTE_HOLD_ESCALATE_MS[0]}
        AND NOT EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.id='alert:dispute_hold_escalated:' || h.event_id AND a.resolved_at IS NULL
          AND json_extract(a.detail,'$.level')=CASE WHEN h.held_at<=?1-${DISPUTE_HOLD_ESCALATE_MS[1]} THEN '6h' ELSE '2h' END)
      ORDER BY h.held_at LIMIT 50
      ON CONFLICT(id) DO UPDATE SET severity=excluded.severity,detail=excluded.detail,raised_at=excluded.raised_at,resolved_at=NULL,delivered_at=NULL,delivery_attempts=0`).bind(now),
    env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=?1 WHERE kind IN ('dispute.hold_unattributed','dispute.hold_escalated') AND resolved_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM dispute_holds h WHERE h.event_id=cloud_alerts.subject AND h.attributed_at IS NULL)`).bind(now),
    env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=?1 WHERE kind='dispute.unmatched' AND resolved_at IS NULL
      AND EXISTS (SELECT 1 FROM stripe_events e WHERE e.id=cloud_alerts.subject AND e.processed_at IS NOT NULL)`).bind(now),
  ]);
}
/** INTEGRATED-11 P1-2d: the operator's EVIDENCED terminal recovery of one unreleased hold (an event that can never be applied: a charge not
 *  ours, a dispute verified settled in Stripe). Records who and why; never re-armed by a later redelivery. Returns false when there is no
 *  unreleased hold of that event. */
export async function closeDisputeHold(env: Env, a: { eventId: string; by: string; evidence: string; homeId?: string }, now: number): Promise<boolean> {
  // INTEGRATED-12 P2-6: the refunds it held are due at once (same batch, before the release), never left on their retry backoff.
  const [, r] = await env.DB.batch([
    env.DB.prepare(`${WAKE_HELD_BY_HOLD_SQL} AND EXISTS (SELECT 1 FROM dispute_holds x WHERE x.event_id=?1 AND x.attributed_at IS NULL)`).bind(a.eventId, now),
    env.DB.prepare(`UPDATE dispute_holds SET attributed_at=?1,closed_by=?2,close_evidence=?3,home_id=COALESCE(?4,home_id) WHERE event_id=?5 AND attributed_at IS NULL
      RETURNING event_id`).bind(now, a.by, a.evidence, a.homeId ?? null, a.eventId),
    env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=?1 WHERE id IN ('alert:dispute_hold:' || ?2,'alert:dispute_hold_escalated:' || ?2) AND resolved_at IS NULL`)
      .bind(now, a.eventId),
  ]);
  return (r.results ?? []).length === 1;
}
/** Round 8b: the dispute events that settle a payment_disputes row from Stripe's current dispute (settleDispute). */
const DISPUTE_SETTLE_EVENTS = ["charge.dispute.closed", "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated"] as const;
const HOME_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired", "customer.updated", "invoice.created", "invoice.paid", "invoice.payment_failed", "customer.subscription.updated",
  "customer.subscription.deleted", "charge.refunded", "charge.dispute.created", ...DISPUTE_SETTLE_EVENTS, "refund.updated", "refund.failed", "charge.refund.updated"]);
/** The home an event belongs to (for its lease), or an outcome for events that touch no home. A home that cannot be resolved THROWS: the
 *  event is retried (Stripe retries on 500, the sweep retries too); it is never handled without the home's lease. */
async function homeOfEvent(env: Env, config: BillingConfig, deps: BillingDependencies, event: z.infer<typeof eventSchema>): Promise<{ homeId: string } | { outcome: string }> {
  const obj = event.data.object as Obj;
  if (!HOME_EVENTS.has(event.type)) return { outcome: "ignored_type" };
  if (event.type.startsWith("refund.") || event.type === "charge.refund.updated") {
    const opId = str(rec(obj.metadata).op_id);
    const row = opId ? await env.DB.prepare("SELECT home_id FROM refund_ops WHERE id=?").bind(opId).first<{ home_id: string }>()
      : await env.DB.prepare("SELECT home_id FROM refund_ops WHERE stripe_refund_id=?").bind(str(obj.id)).first<{ home_id: string }>();
    // Astra JOURNEY-A-6 #4: a refund of a payment under coverage reconciliation (refund_coverage) reaches that home too (its coverage is re-read).
    const pi = idOf(obj.payment_intent);
    const covered = !row && pi ? await env.DB.prepare("SELECT home_id FROM refund_coverage WHERE payment_intent=? LIMIT 1").bind(pi).first<{ home_id: string }>() : null;
    return row ? { homeId: row.home_id } : covered ? { homeId: covered.home_id } : { outcome: "not_a_ledger_refund" };
  }
  if (event.type.startsWith("charge.dispute.")) {
    // A dispute already on record belongs to its row's home; otherwise its charge's customer is resolved.
    const known = str(obj.id) ? await env.DB.prepare("SELECT home_id FROM payment_disputes WHERE dispute_id=?").bind(str(obj.id)).first<{ home_id: string }>() : null;
    if (known) return { homeId: known.home_id };
    const chargeId = idOf(obj.charge);
    if (!chargeId) throw new Error("charge_unresolved");
    const charge = await stripeClient(config, deps.stripeFetch).getCharge(chargeId);
    return { homeId: (await resolveHome(env, {}, { customer: charge.customer })).homeId };
  }
  if (event.type.startsWith("checkout.session.") && obj.mode !== "subscription") return { outcome: "ignored_mode" };
  if (event.type === "customer.updated") {
    // A customer of ours is found by its id; any other customer on the account is none of ours (nothing to retry).
    const customer = str(obj.id);
    const row = customer ? await env.DB.prepare("SELECT home_id FROM billing_subscriptions WHERE customer_id=?").bind(customer).first<{ home_id: string }>() : null;
    return row ? { homeId: row.home_id } : { outcome: "customer_unknown" };
  }
  return { homeId: (await resolveHome(env, obj)).homeId };
}

/** The object each handled event type is about, by the kind of Stripe object retrieved for it. */
function eventObjectKind(type: string): EventObjectKind | null {
  if (type.startsWith("checkout.session.")) return "checkout_session";
  if (type.startsWith("invoice.")) return "invoice";
  if (type.startsWith("customer.subscription.")) return "subscription";
  if (type === "customer.updated") return "customer";
  if (type.startsWith("charge.dispute.")) return "dispute";
  if (type.startsWith("refund.") || type === "charge.refund.updated") return "refund";
  if (type.startsWith("charge.")) return "charge";
  return null;
}
/** An event Stripe rendered in another API version, rebuilt in the pinned version: the same id, type and creation time, its object
 *  retrieved fresh from Stripe at STRIPE_API_VERSION (the current state, which every handler already treats idempotently). An event type
 *  no handler applies is passed through unchanged (it is recorded as ignored and touches nothing). */
async function eventAtPinnedVersion(config: BillingConfig, deps: BillingDependencies, event: z.infer<typeof eventSchema>): Promise<z.infer<typeof eventSchema>> {
  if (!HOME_EVENTS.has(event.type)) return event;
  const kind = eventObjectKind(event.type);
  const id = str((event.data.object as Obj).id);
  if (!kind || !id) throw new Error("event_object_unresolved");
  const object = await stripeClient(config, deps.stripeFetch).retrieveEventObject(kind, id);
  if (str(object.id) !== id) throw new Error("event_object_mismatch");
  return { ...event, api_version: STRIPE_API_VERSION, data: { object } } as z.infer<typeof eventSchema>;
}

/** Outcome of an invoice paid through a reconciliation (also how a later one recognizes it as already applied). */
const PAID_RECOVERED = "paid_recovered";
/** An invoice whose payment was already applied: an ordinary invoice.paid for it completed, or a reconciliation recovered it. Served by
 *  the partial expression index stripe_events_processed_object (migration 0035): keep the expression and the processed_at condition. */
async function paidInvoiceApplied(env: Env, eventId: string, invoiceId: string): Promise<boolean> {
  return (await env.DB.prepare(`SELECT 1 AS x FROM stripe_events e WHERE e.id<>? AND e.processed_at IS NOT NULL AND json_extract(e.payload,'$.data.object.id')=?
    AND ((e.type='invoice.paid' AND e.error IS NULL) OR EXISTS (SELECT 1 FROM stripe_event_reconciliations r WHERE r.event_id=e.id AND r.outcome=?)) LIMIT 1`)
    .bind(eventId, invoiceId, PAID_RECOVERED).first()) !== null;
}
/** Stripe's own payment time of a paid invoice (status_transitions.paid_at, Unix seconds), validated: a positive whole number of seconds
 *  not in the future (five minutes of clock skew allowed). Anything else is unavailable (null). */
export function invoicePaidAt(obj: Obj, nowMs: number): number | null {
  const transitions = obj.status_transitions;
  const paidAt = transitions && typeof transitions === "object" ? (transitions as Obj).paid_at : undefined;
  if (typeof paidAt !== "number" || !Number.isSafeInteger(paidAt) || paidAt <= 0 || paidAt * 1000 > nowMs + 5 * 60_000) return null;
  return paidAt;
}
/** A version-mismatched event is NOT replayed as the action it names: it only triggers a sync of its object's CURRENT state (retrieved under
 *  the lease), through the same idempotent state-based paths as every other event.
 *  - A paid invoice (whatever the event said: created, payment_failed, paid) follows the paid path, dated by Stripe's own payment time
 *    (status_transitions.paid_at, never the trigger's creation time), or is recorded as superseded when its payment was already applied:
 *    never overdue state or a dunning notice.
 *  - An invoice no longer open/uncollectible is not a payment failure any more: superseded.
 *  - A dispute won by us, or a closed inquiry, cancels nothing: superseded.
 *  - Everything else (checkout, subscription state, charge refunds, the refund ledger) is applied from the current object as usual. */
async function reconcileEvent(env: Env, config: BillingConfig, deps: BillingDependencies, current: z.infer<typeof eventSchema>): Promise<string | null> {
  const obj = current.data.object as Obj;
  const status = str(obj.status);
  if (current.type === "charge.dispute.created" && (status === "won" || status === "warning_closed")) return `superseded_dispute_${status}`;
  if (current.type.startsWith("invoice.")) {
    if (status === "paid") {
      if (await paidInvoiceApplied(env, current.id, str(obj.id) ?? "")) return "superseded_invoice_paid";
      // The payment happened when Stripe says the invoice was paid, never when the triggering event was created (an invoice.created or
      // payment_failed days earlier would backdate the first payment, closing the refund window early, and order the paid state behind a
      // failure it actually followed). No authoritative payment time: the event stays pending and is retried, never given a substitute date.
      const paidAt = invoicePaidAt(obj, (deps.now ?? Date.now)());
      if (paidAt === null) throw new Error("invoice_paid_at_unavailable");
      return (await handleEvent(env, config, deps, { ...current, type: "invoice.paid", created: paidAt })) ?? PAID_RECOVERED;
    }
    if (current.type === "invoice.paid" || (current.type === "invoice.payment_failed" && status !== "open" && status !== "uncollectible")) {
      return `superseded_invoice_${status ?? "unknown"}`;
    }
  }
  return handleEvent(env, config, deps, current);
}

const cents = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const DISPUTE_FINAL = new Set(["won", "lost", "warning_closed", "prevented"]);
/** A dispute's balance movements in its own currency (principal only; Stripe's dispute fee is kept apart, never money returned to the
 *  customer). Round 9b: a movement is recorded only when it is known EXACTLY in the dispute's currency. One settled in another currency (with
 *  or without an exchange rate) or with an amount that is not a whole number of cents is never converted: it is left out and `exact` is
 *  false, so the dispute's returned money stays unknown and every refund of the payment is held for an operator. */
export function disputeFunds(d: Obj): { funds: { id: string; direction: "withdrawn" | "reinstated"; cents: number; fee: number }[]; exact: boolean } {
  const currency = str(d.currency)?.toLowerCase();
  const list = Array.isArray(d.balance_transactions) ? d.balance_transactions as Obj[] : [];
  const funds: { id: string; direction: "withdrawn" | "reinstated"; cents: number; fee: number }[] = [];
  let exact = true;
  for (const t of list) {
    const id = str(t?.id); const amount = t?.amount;
    if (!id) { exact = false; continue; }
    if (typeof amount !== "number" || !Number.isSafeInteger(amount)) { exact = false; continue; }
    if (amount === 0) continue;
    if (!currency || !str(t.currency) || str(t.currency)!.toLowerCase() !== currency) { exact = false; continue; }
    funds.push({ id, direction: amount < 0 ? "withdrawn" : "reinstated", cents: Math.abs(amount), fee: typeof t.fee === "number" && Number.isSafeInteger(t.fee) ? t.fee : 0 });
  }
  return { funds, exact };
}
/** Round 9b (Astra TAXCOUNTRY-8 P1-5): a paid period of the SAME contract after the disputed invoice's, from B5's own grant claims (written by
 *  invoice.paid for every paid period, with its subscription and period): the latest such invoice, or null. One that is itself disputed (open
 *  or lost) does not count. When the disputed invoice has no claim (its period unknown), the home's CURRENT payment (C1's payment authority:
 *  the payment_paid hand-off of the highest version) stands in: a later period only if that payment is another claimed invoice of the contract. */
async function laterPaidPeriod(env: Env, homeId: string, subscriptionId: string, invoiceId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT g.invoice_id AS i FROM credit_grants g WHERE g.home_id=?1 AND g.subscription_id=?2 AND g.kind='period' AND g.invoice_id<>?3
      AND NOT EXISTS (SELECT 1 FROM payment_disputes d WHERE d.invoice_id=g.invoice_id AND (d.closed_at IS NULL OR d.outcome='lost'))
      AND CASE WHEN (SELECT period_start FROM credit_grants WHERE invoice_id=?3 AND kind='period') IS NOT NULL
        THEN g.period_start > (SELECT period_start FROM credit_grants WHERE invoice_id=?3 AND kind='period')
        ELSE g.invoice_id=(SELECT json_extract(l.payload,'$.paymentId') FROM cloud_outbox l WHERE l.home_id=?1 AND l.kind='payment_paid'
          ORDER BY CAST(json_extract(l.payload,'$.version') AS INTEGER) DESC,l.rowid DESC LIMIT 1) END
    ORDER BY g.period_start DESC LIMIT 1`).bind(homeId, subscriptionId, invoiceId).first<{ i: string }>();
  return row?.i ?? null;
}
/** Round 9b (dispute credits): the owed credit reversal of a dispute's invoice. The frozen reversal-target contract counts SUCCEEDED REFUNDS
 *  only (T = floor(G x min(succeeded_refunds, paid) / paid)), so a lost chargeback is never folded into a target: the money it returned is
 *  recorded as an obligation (dispute_credit_obligations) with ONE credit.dispute_reversal_owed alert, for ops to apply at the Flux cutover.
 *  It follows the dispute's CURRENT returned money (DISPUTE_RETURNED_SQL): a reinstatement lowers it, a full reinstatement or a win clears it
 *  and resolves the alert (idempotent: re-running with the same state writes the same row). Only for an invoice that carries credit (a grant
 *  claim or a B4 grant). Statements for the caller's fenced batch. */
function disputeCreditObligationQs(disputeId: string, homeId: string, now: number): Q[] {
  const returned = `(SELECT ${DISPUTE_RETURNED_SQL} FROM payment_disputes d WHERE d.dispute_id=?1)`;
  // Astra INTEGRATED-9: B5 grant claims only; a B4 grant's share of the loss is its ledger account's (b4-flux-ledger.ts), never adjusted twice.
  const credited = `EXISTS (SELECT 1 FROM credit_grants g WHERE g.invoice_id=p.invoice_id)`;
  return [
    q(`INSERT INTO dispute_credit_obligations (dispute_id,home_id,invoice_id,returned_cents,exact,state,recorded_at,updated_at)
      SELECT p.dispute_id,p.home_id,p.invoice_id,${returned},p.movement_exact,'owed',?2,?2 FROM payment_disputes p
      WHERE p.dispute_id=?1 AND p.invoice_id IS NOT NULL AND ${returned}>0 AND ${credited}
      ON CONFLICT(dispute_id) DO UPDATE SET returned_cents=excluded.returned_cents,exact=excluded.exact,state='owed',updated_at=excluded.updated_at,
        revision=dispute_credit_obligations.revision+1
      WHERE dispute_credit_obligations.returned_cents<>excluded.returned_cents OR dispute_credit_obligations.state<>'owed'
        OR dispute_credit_obligations.exact<>excluded.exact`, disputeId, now),
    q(`UPDATE dispute_credit_obligations SET returned_cents=0,state='cleared',updated_at=?2,revision=revision+1 WHERE dispute_id=?1 AND state='owed' AND ${returned}=0`, disputeId, now),
    ...disputeCreditAlertQs(homeId, now),
  ];
}
/** Round 10 (Astra TAXCOUNTRY-9 P1-2): how long ops has to resolve a LOST inexact dispute (record the money it returned, with evidence)
 *  before the hold escalates: inside the 14-day statutory refund window, so a refund still owed is never late because of it. */
export const DISPUTE_INEXACT_RESOLVE_MS = 5 * DAY_MS;
/** The inexact dispute's alerts, from its row as it stands: a LOST inexact dispute with no resolution keeps ONE high alert
 *  (dispute.inexact_lost, subject: the dispute) naming its deadline and the resolution route; one past its deadline also opens
 *  dispute.inexact_overdue. A won one (nothing returned: the refund is released and paid in full) and a resolved one resolve both. Persisted
 *  only (claimed delivery: sweepMonitoring sends them). */
async function disputeInexactAlerts(env: Env, lease: HomeLease, disputeId: string, now: number): Promise<void> {
  await fencedBatch(env, lease, disputeInexactAlertQs(disputeId, now));
}
/** The inexact dispute's alerts as statements, decided by the row AS IT STANDS when they run, for the caller's fenced batch: the batch that
 *  changes the hold (a closure, a new movement that invalidates a resolution, an operator's resolution) carries them, so the alerts can never
 *  disagree with the hold. Astra INTEGRATED-7 P2: a hold RENEWED after its alerts were resolved (a new movement invalidated the resolution)
 *  re-arms them as a new revision (the resolved row reopened, revision+1, delivery reset), never left resolved because the fixed alert id is
 *  taken; a held row reopens the dispute.movement_inexact alert the same way. */
export function disputeInexactAlertQs(disputeId: string, now: number): Q[] {
  const held = `d.dispute_id=?1 AND d.movement_exact=0 AND d.resolved_at IS NULL AND d.closed_at IS NOT NULL AND d.outcome='lost'`;
  const info = `'disputeId',d.dispute_id,'invoiceId',d.invoice_id,'resolveBy',d.resolve_by,
    'rule','the dispute''s returned money is not known exactly: every refund of this payment is held (nothing lowered, nothing paid) until ops records the principal the bank actually returned, with evidence',
    'action','POST /v1/admin/disputes/' || d.dispute_id || '/resolve-returned {returnedCents, evidence, by}'`;
  const rearm = `ON CONFLICT(id) DO UPDATE SET resolved_at=NULL,resolve_notice_due=0,raised_at=excluded.raised_at,delivered_at=NULL,delivery_attempts=0,
      detail=json_set(excluded.detail,'$.revision',COALESCE(CASE WHEN json_valid(cloud_alerts.detail) THEN json_extract(cloud_alerts.detail,'$.revision') END,0)+1)
    WHERE cloud_alerts.resolved_at IS NOT NULL`;
  const open = (kind: string, id: string, detail: string, extra = "") => q(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject)
    SELECT ?3,d.home_id,?4,'high',${detail},?2,d.dispute_id FROM payment_disputes d WHERE ${held}${extra} ${rearm}`, disputeId, now, id, kind);
  const close = (id: string) => q(`UPDATE cloud_alerts SET resolved_at=?2,resolve_notice_due=1 WHERE id=?3 AND resolved_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM payment_disputes d WHERE ${held})`, disputeId, now, id);
  return [
    open("dispute.inexact_lost", `alert:dispute.inexact_lost:${disputeId}`, `json_object(${info})`),
    open("dispute.inexact_overdue", `alert:dispute.inexact_overdue:${disputeId}`, `json_object(${info},'overdueSince',d.resolve_by)`, " AND d.resolve_by IS NOT NULL AND ?2>=d.resolve_by"),
    open("dispute.movement_inexact", `alert:dispute_inexact:${disputeId}`, `json_object('disputeId',d.dispute_id,'currency',d.currency,'chargeCurrency',d.charge_currency,
      'rule','refunds of this payment are held: no amount is ever converted')`),
    close(`alert:dispute.inexact_lost:${disputeId}`), close(`alert:dispute.inexact_overdue:${disputeId}`), close(`alert:dispute_inexact:${disputeId}`),
  ];
}
/** Round 10 (P1-2): the billing sweep's look at every LOST inexact dispute still unresolved past its deadline (escalated once), and at
 *  every one whose hold ended (resolved or won: its alerts resolved). */
export async function sweepInexactDisputes(env: Env, onHome: (homeId: string, work: (lease: HomeLease) => Promise<void>) => Promise<void>, now: number): Promise<void> {
  const rows = await env.DB.prepare(`SELECT d.dispute_id AS id,d.home_id AS h FROM payment_disputes d WHERE d.movement_exact=0 AND (
      (d.resolved_at IS NULL AND d.outcome='lost' AND d.closed_at IS NOT NULL AND d.resolve_by<=?1
        AND NOT EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.id='alert:dispute.inexact_overdue:' || d.dispute_id AND a.resolved_at IS NULL))
      OR ((d.resolved_at IS NOT NULL OR (d.closed_at IS NOT NULL AND d.outcome<>'lost'))
        AND EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.id IN ('alert:dispute.inexact_lost:' || d.dispute_id,'alert:dispute.inexact_overdue:' || d.dispute_id) AND a.resolved_at IS NULL)))
    LIMIT 50`).bind(now).all<{ id: string; h: string }>();
  for (const r of rows.results) await onHome(r.h, (lease) => disputeInexactAlerts(env, lease, r.id, now));
}
/** Round 10 (P1-2): THE OPERATOR'S RESOLUTION of a lost inexact dispute: the principal it actually returned (in the charge's currency, whole
 *  cents) with the evidence read (a bank statement line, a Stripe balance transaction). Under the home's lease, in ONE fenced batch: the
 *  resolution (only while the dispute is still a lost, inexact, unresolved one), its credit obligation and alerts, and every unfinished refund
 *  of the payment made due at once (decided, capped or paid against the proven amount by the normal rules). */
export async function resolveInexactDispute(env: Env, lease: HomeLease, a: { disputeId: string; returnedCents: number; evidence: string; by: string }, now: number):
  Promise<boolean> {
  const d = await env.DB.prepare("SELECT invoice_id,payment_intent FROM payment_disputes WHERE dispute_id=?").bind(a.disputeId).first<{ invoice_id: string | null; payment_intent: string | null }>();
  if (!d) return false;
  const returnedBefore = await disputeReturned(env, d.invoice_id, d.payment_intent);
  const [res] = await fencedBatch(env, lease, [
    q(`UPDATE payment_disputes SET resolved_returned_cents=?,resolved_at=?,resolved_by=?,resolved_evidence=?,updated_at=?
      WHERE dispute_id=? AND movement_exact=0 AND resolved_at IS NULL AND closed_at IS NOT NULL AND outcome='lost'`, a.returnedCents, now, a.by, a.evidence, now, a.disputeId),
    q("INSERT INTO cloud_write_guards VALUES (?,changes())", `resolve-dispute:${a.disputeId}:${now}`),
    ...disputeCreditObligationQs(a.disputeId, lease.homeId, now),
    q(`UPDATE refund_ops SET next_attempt_at=?3 WHERE done_at IS NULL AND ((?1 IS NOT NULL AND invoice_id=?1) OR (?2 IS NOT NULL AND payment_intent=?2))`,
      d.invoice_id, d.payment_intent, now),
    ...disputeInexactAlertQs(a.disputeId, now),
    q("DELETE FROM cloud_write_guards WHERE id=?", `resolve-dispute:${a.disputeId}:${now}`),
  ]).catch((e) => { if (e instanceof LeaseLost) throw e; return [{ meta: { changes: 0 } }]; });
  if (res.meta.changes !== 1) return false;
  // Astra INTEGRATED-7 P1: a resolution lower than what the payment's refunds were capped against reopens what they owe.
  await reopenAfterReturnedChange(env, lease, { disputeId: a.disputeId, invoiceId: d.invoice_id, paymentIntent: d.payment_intent, cause: `resolve:${now}` }, returnedBefore, now);
  return true;
}
/** Astra INTEGRATED-7 P1: after any change to a dispute (Stripe's settlement, an operator's resolution): every capped refund of the payment
 *  that already finished is given its remainder when the bank now keeps less than it was capped against (reopenDisputeRemainders: idempotent,
 *  so a crash before this step is repaired by the event's retry or the next change), and ops is alerted (high) whenever the payment's
 *  effective returned money went DOWN or a remainder was opened: inside or outside the 120-day window, a win, an exact or foreign-currency
 *  reinstatement or a lower resolution alike. One alert per change (subject: the dispute and the change), never folded into another. */
async function reopenAfterReturnedChange(env: Env, lease: HomeLease, a: { disputeId: string; invoiceId: string | null; paymentIntent: string | null; cause: string },
  returnedBefore: number, now: number): Promise<void> {
  const returnedAfter = await disputeReturned(env, a.invoiceId, a.paymentIntent);
  const reopened = await reopenDisputeRemainders(env, lease, { invoiceId: a.invoiceId, paymentIntent: a.paymentIntent }, now);
  if (returnedAfter >= returnedBefore && reopened.length === 0) return;
  const subject = `${a.disputeId}:${a.cause}`;
  await fencedBatch(env, lease, [q(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
    `alert:dispute_returned_lowered:${subject}`, lease.homeId, "refund.dispute_returned_lowered", "high", JSON.stringify({ disputeId: a.disputeId, invoiceId: a.invoiceId,
      returnedBeforeCents: returnedBefore, returnedAfterCents: returnedAfter, reopenedRemainders: reopened,
      rule: "the bank keeps less of this payment than its refunds were capped against: what it gave back is owed to the customer; every capped refund of the payment is re-decided (a finished one through a remainder operation), held while the dispute hold stands" }),
    now, subject)]);
}
/** Astra INTEGRATED-10 P1: how long an operator's claim on a dispute credit obligation excludes every other claim. */
export const DISPUTE_CREDIT_CLAIM_MS = 24 * 3_600_000;
/** Astra INTEGRATED-10 P1: the VERSIONED CLAIM an operator takes BEFORE adjusting a dispute credit obligation by hand: a token bound to the
 *  obligation's current revision. Refused (null) while another operator's claim is live (an expired one is taken over only with evidence of
 *  what was found). The receipt (markDisputeCreditApplied) completes it once. */
export async function claimDisputeCredit(env: Env, lease: HomeLease, a: { disputeId: string; by: string; evidence?: string }, now: number):
  Promise<{ token: string; revision: number; returnedCents: number; fence: { grantId: string; epoch: number; revision: number }[] } | null> {
  const token = crypto.randomUUID();
  const [res] = await fencedBatch(env, lease, [
    q(`UPDATE dispute_credit_obligations SET claim_token=?,claim_by=?,claim_revision=revision,claimed_at=?
      WHERE dispute_id=? AND home_id=? AND ${DISPUTE_CREDIT_OPEN_SQL.replaceAll("o.", "")}
        AND (claim_token IS NULL OR (claimed_at<=? AND ? IS NOT NULL))`,
      token, a.by, now, a.disputeId, lease.homeId, now - DISPUTE_CREDIT_CLAIM_MS, a.evidence ?? null),
  ]).catch((e) => { if (e instanceof LeaseLost) throw e; return [{ meta: { changes: 0 } }]; });
  if (res.meta.changes !== 1) return null;
  const row = await env.DB.prepare("SELECT revision,returned_cents,invoice_id FROM dispute_credit_obligations WHERE dispute_id=? AND claim_token=?").bind(a.disputeId, token)
    .first<{ revision: number; returned_cents: number; invoice_id: string }>();
  if (!row) return null;
  // Lane H1, item 3 (Astra INTEGRATED-16 P1, b5-billing.ts:4491): SHARED GRANT OWNERSHIP BEFORE ANY ADJUSTMENT. The claim also takes the
  // fence (flux-grant-fence.ts) of every B5 grant of the disputed invoice, all or nothing, with the claim's own token: while it holds them no
  // automatic sender (B5 grant/reverse/target, B4 delivery/revoke) and no other operator can mutate those grants. Each grant gets a revision
  // allocated under the claim: the adjustment made at Flux must carry it (Flux refuses an older revision once a newer one applied), so an
  // expired claimant's late adjustment is refused there, and the reconciliation (F4) alerts if one ever lands.
  const grants = (await env.DB.prepare("SELECT invoice_id || ':' || kind AS id FROM credit_grants WHERE invoice_id=? AND home_id=? ORDER BY kind")
    .bind(row.invoice_id, lease.homeId).all<{ id: string }>()).results;
  const fence: { grantId: string; epoch: number; revision: number }[] = [];
  const undo = async () => {
    await fencedBatch(env, lease, [
      // H2: revisions allocated under a claim that is undone were never handed to anyone: not_sent (F4 never reads them back).
      q(`UPDATE flux_grant_revisions SET outcome='not_sent',settled_at=? WHERE op='operator' AND outcome IS NULL
        AND grant_id IN (SELECT grant_id FROM flux_grant_fence WHERE owner_token=?)`, Date.now(), token),
      q("UPDATE flux_grant_fence SET owner_token=NULL,owner_kind=NULL,owner_expires_at=NULL WHERE owner_token=?", token),
      q("UPDATE dispute_credit_obligations SET claim_token=NULL,claim_by=NULL,claim_revision=NULL,claimed_at=NULL WHERE dispute_id=? AND claim_token=?", a.disputeId, token),
    ]);
  };
  for (const g of grants) {
    const c = await claimGrantFence(env.DB, { grantId: g.id, kind: "operator", ttlMs: DISPUTE_CREDIT_CLAIM_MS, homeId: lease.homeId, token });
    const revision = c ? await allocateFenceRevision(env.DB, c, { op: "operator" }) : null;
    if (!c || revision === null) { await undo(); return null; }
    fence.push({ grantId: g.id, epoch: c.epoch, revision });
  }
  return { token, revision: row.revision, returnedCents: row.returned_cents, fence };
}
/** Round 10 (Astra TAXCOUNTRY-9 P2-a): the APPLIED RECEIPT of a dispute credit obligation: ops applied the adjustment for `appliedCents`
 *  (which must be what is owed now: a compare-and-set on returned_cents) and records it with its evidence. The alert follows.
 *  Astra INTEGRATED-10 P1: only under the operator's own claim (`token`), at the revision it was claimed for (a change of what is owed since
 *  refuses it), and once: the claim is consumed by the receipt, so a competing operator's receipt never overwrites it. */
export async function markDisputeCreditApplied(env: Env, lease: HomeLease, a: { disputeId: string; token: string; appliedCents: number; evidence: string; by: string }, now: number):
  Promise<boolean> {
  const g = `credit-applied:${a.disputeId}:${now}`;
  // Lane H1, item 3: the receipt counts only while the claim STILL OWNS the fence of every B5 grant of the invoice (no expired claim, no
  // takeover); it then releases them and settles the claim's revisions.
  const owned = `NOT EXISTS (SELECT 1 FROM credit_grants c WHERE c.invoice_id=(SELECT invoice_id FROM dispute_credit_obligations WHERE dispute_id=?1) AND c.home_id=?2
    AND NOT EXISTS (SELECT 1 FROM flux_grant_fence f WHERE f.grant_id=c.invoice_id || ':' || c.kind AND f.owner_token=?3
      AND f.owner_expires_at>CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)))`;
  const [res] = await fencedBatch(env, lease, [
    q(`INSERT INTO cloud_write_guards VALUES (?4, CASE WHEN ${owned} THEN 1 ELSE 0 END)`, a.disputeId, lease.homeId, a.token, `${g}:fence`),
    // Astra INTEGRATED-9: the obligation covers B5 grant claims only (disputeCreditObligationQs); a B4 grant is adjusted through its ledger
    // account, whose operator claim excludes every automatic send (b4-flux-ledger.ts operatorClaim), so nothing B4 can race this receipt.
    q(`UPDATE dispute_credit_obligations SET applied_returned_cents=?,applied_at=?,applied_by=?,applied_evidence=?,updated_at=?,
        claim_token=NULL,claim_by=NULL,claim_revision=NULL,claimed_at=NULL
      WHERE dispute_id=? AND home_id=? AND returned_cents=? AND claim_token=? AND claim_revision=revision`,
      a.appliedCents, now, a.by, a.evidence, now, a.disputeId, lease.homeId, a.appliedCents, a.token),
    q("INSERT INTO cloud_write_guards VALUES (?,changes())", g),
    q(`UPDATE flux_grant_revisions SET outcome='applied_by_hand',settled_at=?1 WHERE op='operator' AND outcome IS NULL
      AND grant_id IN (SELECT grant_id FROM flux_grant_fence WHERE owner_token=?2)`, now, a.token),
    // H4 (Astra H3 #6): the hand adjustment changed what Flux holds without a read: the snapshot fence (state_seq) advances, so a GET begun
    // before this receipt can never publish its older state, and the grant is due a read-back (needs_reconcile) until a fresh one lands.
    q(`UPDATE flux_grant_fence SET owner_token=NULL,owner_kind=NULL,owner_expires_at=NULL,state_seq=state_seq+1,needs_reconcile=1,updated_at=?
      WHERE owner_token=?`, now, a.token),
    ...disputeCreditAlertQs(lease.homeId, now),
    q("DELETE FROM cloud_write_guards WHERE id IN (?,?)", g, `${g}:fence`),
  ]).catch((e) => { if (e instanceof LeaseLost) throw e; return [{ meta: { changes: 0 } }, { meta: { changes: 0 } }]; });
  return res.meta.changes === 1;
}
/** Round 8b: THE DISPUTE CLOSURE. Every charge.dispute.closed / funds_withdrawn / funds_reinstated event settles its payment_disputes row from
 *  the dispute's CURRENT state, retrieved from Stripe under the home's lease (never the event's own snapshot, never ordered by event time):
 *  - the event is recorded once by its id (payment_dispute_events; one after the row's closure is recorded too, after_closure=1);
 *  - each balance movement is recorded once by its balance transaction id (payment_dispute_funds), principal only;
 *  - a final status (won / lost / warning_closed / prevented) closes the row (closed_at kept when ops closed it first) with that outcome:
 *    won, an inquiry closed or a prevented dispute returned nothing (the dispute hold is released, the payment refundable as before); lost
 *    returned the disputed amount less everything reinstated so far (returned_cents), which the refund ledger counts as already returned.
 *    A later reinstatement (a partial win after a loss) lowers it again; Stripe changing its outcome later rewrites it the same way. */
async function settleDispute(env: Env, lease: HomeLease, stripe: ReturnType<typeof stripeClient>, event: z.infer<typeof eventSchema>, disputeId: string,
  now: number): Promise<string> {
  const d = await stripe.retrieveEventObject("dispute", disputeId);
  if (str(d.id) !== disputeId) throw new Error("event_object_mismatch");
  const status = str(d.status) ?? "unknown";
  const final = DISPUTE_FINAL.has(status) ? 1 : 0;
  const before = await env.DB.prepare("SELECT closed_at,reinstated_cents,charge_currency,invoice_id,payment_intent FROM payment_disputes WHERE dispute_id=?").bind(disputeId)
    .first<{ closed_at: number | null; reinstated_cents: number; charge_currency: string | null; invoice_id: string | null; payment_intent: string | null }>();
  const returnedBefore = await disputeReturned(env, before?.invoice_id ?? null, before?.payment_intent ?? null);
  const sum = (direction: "withdrawn" | "reinstated") =>
    `(SELECT COALESCE(SUM(cents),0) FROM payment_dispute_funds WHERE dispute_id=?${direction === "withdrawn" ? 1 : 2} AND direction='${direction}')`;
  // Round 9b (currency): every movement known exactly in the dispute's currency, and the dispute's currency the charge's own. Otherwise the
  // row is marked inexact (sticky): its returned money is never computed from a conversion (returned_cents stays unset) and the payment's
  // refunds are held for an operator (legal-refunds.ts disputeGate).
  const { funds, exact: fundsExact } = disputeFunds(d);
  const dCurrency = str(d.currency)?.toLowerCase() ?? null;
  const exact = fundsExact && !(before?.charge_currency && dCurrency && before.charge_currency !== dCurrency) ? 1 : 0;
  await fencedBatch(env, lease, [
    q(`INSERT INTO payment_dispute_events (event_id,dispute_id,type,status,after_closure,recorded_at) VALUES (?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING`,
      event.id, disputeId, event.type, status, before?.closed_at != null ? 1 : 0, now),
    ...funds.map((f) => q(`INSERT INTO payment_dispute_funds (txn_id,dispute_id,direction,cents,fee_cents,recorded_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(txn_id) DO NOTHING`, f.id, disputeId, f.direction, f.cents, f.fee, now)),
    // ?1 withdrawn marker, ?2 reinstated marker (the same dispute id), ?3 final, ?4 status, ?5 amount, ?6 currency, ?7 now, ?8 exact.
    // Round 10 (Astra TAXCOUNTRY-9 P1-2): an operator's resolution of an inexact dispute holds only for the movements it saw: a NEW event
    // (first recorded now) that moves money or changes the dispute's status of a still-inexact dispute clears it, so its refunds are held
    // again until it is resolved again (?9 event id, ?10 event type). A LOST inexact closure gets its resolution deadline (resolve_by).
    q(`UPDATE payment_disputes SET resolved_at=CASE WHEN resolved_at IS NOT NULL AND (?8=0 OR movement_exact=0)
        AND (SELECT recorded_at FROM payment_dispute_events WHERE event_id=?9)=?7
        AND (?10 IN ('charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated') OR COALESCE(status,'')<>?4) THEN NULL ELSE resolved_at END,
      resolve_by=CASE WHEN ?3=1 AND ?4='lost' AND (?8=0 OR movement_exact=0) THEN COALESCE(resolve_by,?7+${DISPUTE_INEXACT_RESOLVE_MS}) ELSE resolve_by END,
      updated_at=?7 WHERE dispute_id=?1`, disputeId, disputeId, final, status, null, null, now, exact, event.id, event.type),
    q(`UPDATE payment_disputes SET status=?4,amount_cents=COALESCE(?5,amount_cents),currency=COALESCE(?6,currency),
      withdrawn_cents=${sum("withdrawn")},reinstated_cents=${sum("reinstated")},
      closed_at=CASE WHEN ?3=1 THEN COALESCE(closed_at,?7) ELSE closed_at END,
      outcome=CASE WHEN ?3=1 THEN ?4 ELSE outcome END,
      returned_cents=CASE WHEN ?3=1 AND ?4='lost' AND ?8=1 AND movement_exact=1 THEN MAX(0,COALESCE(?5,amount_cents,${sum("withdrawn")})-${sum("reinstated")})
        WHEN ?3=1 AND ?4='lost' THEN NULL WHEN ?3=1 THEN 0 ELSE returned_cents END,
      movement_exact=CASE WHEN ?8=1 THEN movement_exact ELSE 0 END,
      updated_at=?7 WHERE dispute_id=?1`, disputeId, disputeId, final, status, cents(d.amount), dCurrency, now, exact),
    // Round 9b (dispute credits): a lost dispute's owed credit reversal follows its returned money; a reinstatement or win clears it.
    ...disputeCreditObligationQs(disputeId, lease.homeId, now),
    // Round 9b (P1-6): every unfinished refund of this payment is looked at again now (a reinstatement reopens what a loss capped).
    q(`UPDATE refund_ops SET next_attempt_at=?3 WHERE done_at IS NULL AND ((?1 IS NOT NULL AND invoice_id=?1) OR (?2 IS NOT NULL AND payment_intent=?2))`,
      before?.invoice_id ?? null, before?.payment_intent ?? null, now),
    // Astra INTEGRATED-7 P2: the inexact hold's alerts follow the hold in this same batch (a renewed hold re-arms them as a new revision).
    ...disputeInexactAlertQs(disputeId, now),
  ]);
  // Astra INTEGRATED-7 P1: the effective returned money went down (a win, a reinstatement in any currency, a cleared resolution): finished
  // capped refunds get their remainder, and ops is told, inside or outside the 120-day window.
  await reopenAfterReturnedChange(env, lease, { disputeId, invoiceId: before?.invoice_id ?? null, paymentIntent: before?.payment_intent ?? null, cause: event.id },
    returnedBefore, now);
  if (final && status === "lost") {
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
      .bind(`alert:dispute_lost:${disputeId}`, lease.homeId, "dispute.lost", "warning", JSON.stringify({ disputeId, amountCents: cents(d.amount) }), now).run();
  }
  if (!exact) {
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
      .bind(`alert:dispute_inexact:${disputeId}`, lease.homeId, "dispute.movement_inexact", "high", JSON.stringify({ disputeId, currency: dCurrency,
        chargeCurrency: before?.charge_currency ?? null, rule: "refunds of this payment are held: no amount is ever converted" }), now).run();
  }
  await disputeInexactAlerts(env, lease, disputeId, now);
  // A reinstatement after a capped refund of this payment was already completed as final (its reinstatement window had passed): the remainder
  // is never lost silently; ops is told.
  const after = await env.DB.prepare("SELECT reinstated_cents FROM payment_disputes WHERE dispute_id=?").bind(disputeId).first<{ reinstated_cents: number }>();
  if ((after?.reinstated_cents ?? 0) > (before?.reinstated_cents ?? 0) && await env.DB.prepare(`SELECT 1 AS x FROM refund_ops WHERE done_at IS NOT NULL
      AND json_extract(detail,'$.disputeCappedFromCents') IS NOT NULL AND ((?1 IS NOT NULL AND invoice_id=?1) OR (?2 IS NOT NULL AND payment_intent=?2)) LIMIT 1`)
    .bind(before?.invoice_id ?? null, before?.payment_intent ?? null).first()) {
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
      .bind(`alert:dispute_reinstated_final:${disputeId}:${after!.reinstated_cents}`, lease.homeId, "refund.dispute_reinstated_after_final", "high",
        JSON.stringify({ disputeId, reinstatedCents: after!.reinstated_cents, invoiceId: before?.invoice_id ?? null }), now).run();
  }
  return `dispute_${final ? "closed" : "open"}_${status}${before?.closed_at != null ? "_after_closure" : ""}`;
}

/** Astra FLUX-7 / INTEGRATED-10: OPEN DISPUTES ARE POLLED. Stripe retries an undelivered webhook for up to 3 days (live mode); a dispute still
 *  open DISPUTE_POLL_AFTER_MS after it was opened may have lost its closure event for good, which would hold its payment's refunds and leave
 *  plan-ending work unfinished forever. Each such dispute (at most DISPUTE_POLLS_PER_SWEEP per sweep, each at most every DISPUTE_POLL_EVERY_MS)
 *  is read from Stripe and fed through THE SAME closure path the webhook uses (settleDispute, under the home's lease, recorded once under a
 *  poll event id): idempotent against a late webhook (funds by balance transaction, closure kept). A poll that fails is counted and, past the
 *  window, alerted (dispute.poll_failing, one per dispute) until a poll succeeds or the dispute closes. */
export const DISPUTE_POLL_AFTER_MS = 72 * 3_600_000;
export const DISPUTE_POLL_EVERY_MS = 6 * 3_600_000;
const DISPUTE_POLLS_PER_SWEEP = 10;
export async function pollOpenDisputes(env: Env, stripe: ReturnType<typeof stripeClient>,
  onHome: (homeId: string, work: (lease: HomeLease) => Promise<void>) => Promise<void>, now: number): Promise<void> {
  const rows = await env.DB.prepare(`SELECT dispute_id AS id,home_id AS h FROM payment_disputes WHERE closed_at IS NULL AND opened_at<=?1
      AND COALESCE(polled_at,0)<=?2 ORDER BY COALESCE(polled_at,0),opened_at LIMIT ${DISPUTE_POLLS_PER_SWEEP}`)
    .bind(now - DISPUTE_POLL_AFTER_MS, now - DISPUTE_POLL_EVERY_MS).all<{ id: string; h: string }>();
  for (const r of rows.results) {
    let ok = false;
    try {
      await onHome(r.h, async (lease) => {
        const poll = { id: `poll:${r.id}:${now}`, type: "dispute.poll", created: Math.floor(now / 1000), data: { object: { id: r.id } } } as unknown as z.infer<typeof eventSchema>;
        await settleDispute(env, lease, stripe, poll, r.id, now);
        ok = true;
      });
    } catch { /* counted below */ }
    await env.DB.batch([
      env.DB.prepare("UPDATE payment_disputes SET polled_at=?,poll_failures=CASE WHEN ? THEN 0 ELSE poll_failures+1 END WHERE dispute_id=?").bind(now, ok ? 1 : 0, r.id),
      env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject)
        SELECT 'alert:dispute_poll:' || d.dispute_id,d.home_id,'dispute.poll_failing','high',json_object('disputeId',d.dispute_id,'openedAt',d.opened_at,
          'failures',d.poll_failures,'rule','an open dispute past the webhook retry window could not be read from Stripe: its refunds stay held until it closes'),?2,d.dispute_id
        FROM payment_disputes d WHERE d.dispute_id=?1 AND d.closed_at IS NULL AND d.poll_failures>0 ON CONFLICT DO NOTHING`).bind(r.id, now),
      env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=?2 WHERE id='alert:dispute_poll:' || ?1 AND resolved_at IS NULL
        AND EXISTS (SELECT 1 FROM payment_disputes d WHERE d.dispute_id=?1 AND (d.closed_at IS NOT NULL OR d.poll_failures=0))`).bind(r.id, now),
    ]);
  }
}

/** Thrown out of the leased part after its failure was already recorded there (fenced): the outer handler records nothing more. */
class EventFailureRecorded extends Error { constructor(public readonly original: unknown) { super(original instanceof Error ? original.message : "error"); } }

/** Outcomes of homeOfEvent that are properties of the event itself (its type, its checkout mode): settled at once, without a lease. */
const IMMUTABLE_OUTCOMES = new Set(["ignored_type", "ignored_mode"]);
/** A lookup that found no home YET (lane C design 3 A4): the customer's billing row, or a refund's ledger row, can appear later (a checkout
 *  binding its customer, a credit note checkpointing its refund id). Recorded as a retryable miss (noticeBackoff), re-resolved on every try,
 *  and settled as processed only by evidence (customer_unknown: a Stripe customer carrying none of our metadata keys) or by age. */
const RETRYABLE_MISSES = new Set(["customer_unknown", "not_a_ledger_refund"]);
export const MISS_SETTLES_AFTER_MS = 24 * 3_600_000;
/** The metadata keys the control plane sets on every Stripe customer it creates (b5-stripe.ts createCustomer: home_id always, fp_tid when
 *  known). A customer carrying none of them was not created by us, so it can never be bound to a home. */
const OUR_CUSTOMER_METADATA = ["home_id", "fp_tid"];
/** A lookup miss recorded on the event (attempts, error, next_attempt_at committed): thrown only AFTER that record succeeded, so a caller that
 *  sees it knows the obligation is durably queued and the sweep owns its retries (Astra MAILRETRY-3 P2: the webhook acknowledges it). */
export class PendingMiss extends Error { constructor(public readonly outcome: string) { super(outcome); } }
/** The binds of the settlement's guard (Astra MAILRETRY-3 P2): exactly the rows homeOfEvent looks up for this miss, re-checked inside the
 *  checkpoint statement itself, so a binding or a ledger row that appears after the lookup makes the checkpoint change nothing.
 *  customer_unknown: the customer's billing row. not_a_ledger_refund: the refund's ledger row (by op_id when the refund carries one, else by
 *  the refund id) and the coverage row of its payment. A bind of NULL matches nothing. */
function missGuardBinds(outcome: string, obj: Obj): [customer: string | null, opId: string | null, refundId: string | null, paymentIntent: string | null] {
  if (outcome === "customer_unknown") return [str(obj.id), null, null, null];
  if (outcome !== "not_a_ledger_refund") return [null, null, null, null];
  const opId = str(rec(obj.metadata).op_id);
  return [null, opId, opId ? null : str(obj.id), idOf(obj.payment_intent)];
}
function missSettled(outcome: string, obj: Obj, receivedAt: number, now: number): boolean {
  if (now - receivedAt >= MISS_SETTLES_AFTER_MS) return true;
  if (outcome !== "customer_unknown") return false;
  const metadata = rec(obj.metadata);
  return !OUR_CUSTOMER_METADATA.some((k) => typeof metadata[k] === "string" && metadata[k] !== "");
}

export async function processStoredEvent(env: Env, config: BillingConfig, deps: BillingDependencies, eventId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT payload,processed_at,received_at FROM stripe_events WHERE id=?").bind(eventId)
    .first<{ payload: string; processed_at: number | null; received_at: number }>();
  if (!row || row.processed_at) return;
  let event = eventSchema.parse(JSON.parse(row.payload));
  const now = (deps.now ?? Date.now)();
  const codeOf = (e: unknown) => e instanceof Error ? e.message.slice(0, 80) : "error";
  const waiting = CUSTOMER_WAITING_EVENTS.has(event.type);
  const stuckAlertId = `alert:webhook_stuck:${eventId}`;
  let homeId: string | null = null; // the home the event resolves to, once known (the stuck alert's detail names it)
  // Escalation, in the SAME batch as the failure record and AFTER it: everything is read from the committed row (attempts, error), never from
  // a snapshot this worker took earlier (Astra MAILRETRY-DESIGN-3 #6), and only while the event is still pending (a late failure of an event
  // another worker completed meanwhile raises nothing).
  // - A customer-waiting event: ONE alert row per event (its own id, and home_id `stripe_event:<id>`, the fleet's key for non-home alerts,
  //   so the open-alert index is per event), raised from the third failed attempt. Its detail describes the INCIDENT, never the attempts
  //   after it: the monitoring sender acknowledges a delivery only while the stored detail is still the one it sent (ops-monitor.ts deliver),
  //   so the detail changes ONLY when the incident is reopened (Astra MAILRETRY-3 P2). It carries an incident `generation`, 1 when raised and
  //   +1 on every reopening, plus the attempt count and error at that moment (attemptsAtRaise, errorAtRaise); the live attempt count and
  //   error are the event's own row (stripe_events, named by eventId). While open, a failure leaves the row untouched; a resolved row (the
  //   event completed, then was requeued, e.g. releaseParkedAcceptance) is REOPENED as the next generation with its delivery state reset
  //   (A5), so an acknowledgement of the previous generation's send changes nothing. It is resolved in the batch that marks the event
  //   processed, whatever the outcome.
  // - Any other type: the fleet's billing.event_stuck from the eighth (A7), guarded the same way.
  const escalation = (home: string | null): Q[] => [waiting
    ? q(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at)
      SELECT ?,?,'billing.webhook_stuck','high',json_object('eventId',e.id,'type',e.type,'homeId',?,'retryRule',?,'generation',1,
        'attemptsAtRaise',e.attempts,'errorAtRaise',e.error),?
      FROM stripe_events e WHERE e.id=? AND e.processed_at IS NULL AND e.attempts>=?
      ON CONFLICT(id) DO UPDATE SET
        detail=json_set(excluded.detail,'$.generation',COALESCE(json_extract(cloud_alerts.detail,'$.generation'),1)+1),
        raised_at=excluded.raised_at,delivered_at=NULL,delivery_attempts=0,resolved_at=NULL
      WHERE cloud_alerts.resolved_at IS NOT NULL`, stuckAlertId, `stripe_event:${eventId}`, home, STUCK_RETRY_RULE, now, eventId, STUCK_ALERT_AT)
    : q(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at)
      SELECT ?,'billing','billing.event_stuck','high',json_object('eventId',e.id,'type',e.type,'error',e.error,'attempts',e.attempts),?
      FROM stripe_events e WHERE e.id=? AND e.processed_at IS NULL AND e.attempts>=? ON CONFLICT DO NOTHING`, crypto.randomUUID(), now, eventId, EVENT_STUCK_AT)];
  // Written in the same batch that marks the event processed, whatever the outcome (a payment applied, or a terminal one such as
  // ignored_mode, foreign_subscription, plan_ended): a crash can never leave the event done and its alert open.
  // Only once the event IS processed (the checkpoint just before it in the same transaction may have changed nothing: a settled miss whose
  // binding appeared meanwhile).
  const resolveStuck = (): Q[] => waiting ? [q(`UPDATE cloud_alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL
    AND EXISTS (SELECT 1 FROM stripe_events WHERE id=? AND processed_at IS NOT NULL)`, now, stuckAlertId, eventId)] : [];
  // Statements for a plain (unfenced) D1 batch: only where no lease applies (an immutable outcome, a failure before any lease).
  const unfencedStmts = (qs: Q[]) => qs.map(([sql, binds]) => env.DB.prepare(sql).bind(...(binds ?? [])));
  try {
    // G-F1 / INTEGRATED-11: the event's own hold before any other lookup (armed once per event; kept until this event's checkpoint).
    // INTEGRATED-12: inside the failure bookkeeping: a hold whose attribution fails (after it committed) is a recorded, retried failure.
    await holdDisputeFirst(env, event, now, disputeHoldLookup(config, deps));
    // ONE pinned API version (b5-stripe.ts): an event rendered for another version has other shapes and is never replayed as an action.
    // The raw event stays stored as received and ops is told (the webhook endpoint's version is fixed in the Stripe Dashboard). The event
    // is only a TRIGGER to sync the current state of the object it is about (its Checkout Session, invoice, subscription, charge, dispute
    // or refund): see reconcileEvent. A copy retrieved here, before any lease, serves only to find the home; the object applied is
    // retrieved again INSIDE the home's lease. Completion is recorded in stripe_event_reconciliations in the same fenced write that marks the
    // event processed. The webhook and the sweep both come through here, so an event quarantined by an earlier build is recovered too.
    const version = str((event as { api_version?: unknown }).api_version);
    const reconciledFrom = version && version !== STRIPE_API_VERSION ? version : null;
    let lookup = event;
    if (reconciledFrom) {
      await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
        .bind(`alert:webhook_version:${reconciledFrom}`, "billing", "billing.webhook_api_version", "high", JSON.stringify({ expected: STRIPE_API_VERSION, got: reconciledFrom, eventId }), now).run();
      lookup = await eventAtPinnedVersion(config, deps, event);
    }
    const reconciled = (outcome: string | null): Q[] => reconciledFrom ? [q(`INSERT INTO stripe_event_reconciliations (event_id,event_api_version,pinned_api_version,object_id,outcome,reconciled_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM stripe_events WHERE id=? AND processed_at IS NOT NULL) ON CONFLICT(event_id) DO NOTHING`,
      eventId, reconciledFrom, STRIPE_API_VERSION, str((event.data.object as Obj).id) ?? "", outcome, now, eventId)] : [];
    // Every event for a home runs under that home's billing lease (the one serializer); a busy home is retried shortly.
    let target = await homeOfEvent(env, config, deps, lookup);
    if ("outcome" in target) {
      // No home found. A lookup miss is retried (recorded as a failure below) until it is settled by evidence or age (A4); only an outcome
      // that is a property of the event itself, or a settled miss, is checkpointed here, without a lease.
      const obj = lookup.data.object as Obj;
      const miss = RETRYABLE_MISSES.has(target.outcome);
      if (miss && !missSettled(target.outcome, obj, row.received_at, now)) throw new PendingMiss(target.outcome);
      if (!IMMUTABLE_OUTCOMES.has(target.outcome) && !miss) throw new Error("event_outcome_unexpected");
      // One batch (one transaction): the checkpoint, only over a still-pending event (never over a lease holder's completed one), the
      // reconciliation and the stuck alert's resolution. A settled MISS is checkpointed only if, in that same statement, the row whose
      // absence made it a miss is still absent (Astra MAILRETRY-3 P2: a customer bound, or a refund checkpointed, after the lookup).
      const checkpoint = miss
        ? env.DB.prepare(`UPDATE stripe_events SET processed_at=?,error=?,next_attempt_at=NULL WHERE id=? AND processed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM billing_subscriptions WHERE customer_id=?) AND NOT EXISTS (SELECT 1 FROM refund_ops WHERE id=? OR stripe_refund_id=?)
          AND NOT EXISTS (SELECT 1 FROM refund_coverage WHERE payment_intent=?)`).bind(now, target.outcome, eventId, ...missGuardBinds(target.outcome, obj))
        : env.DB.prepare("UPDATE stripe_events SET processed_at=?,error=?,next_attempt_at=NULL WHERE id=? AND processed_at IS NULL").bind(now, target.outcome, eventId);
      const [settled] = await env.DB.batch([checkpoint, ...unfencedStmts([...reconciled(target.outcome), ...resolveStuck()])]);
      if (settled.meta.changes === 1) return;
      // Nothing changed. Either another worker completed the event (nothing more to do), or the binding / ledger row appeared between the
      // lookup and the checkpoint: the event is resolved again, now to its home, and handled normally under that home's lease below.
      const still = await env.DB.prepare("SELECT processed_at FROM stripe_events WHERE id=?").bind(eventId).first<{ processed_at: number | null }>();
      if (!still || still.processed_at !== null || !miss) return;
      target = await homeOfEvent(env, config, deps, lookup);
      if ("outcome" in target) throw new PendingMiss(target.outcome);
    }
    homeId = target.homeId;
    await withHomeLease(env, target.homeId, async (lease) => {
      // Re-read under the lease: another worker (the webhook or the sweep) may have completed this event while this one waited or
      // fetched. A completed event is never applied twice, whatever snapshot this worker holds.
      const current = await env.DB.prepare("SELECT processed_at FROM stripe_events WHERE id=?").bind(eventId).first<{ processed_at: number | null }>();
      if (!current || current.processed_at) return;
      try {
        let outcome: string | null;
        if (reconciledFrom) {
          // The authoritative object, retrieved inside the lease, and checked to belong to the leased home.
          const fresh = await eventAtPinnedVersion(config, deps, event);
          const home = await homeOfEvent(env, config, deps, fresh);
          if (!("homeId" in home) || home.homeId !== lease.homeId) throw new Error("home_changed");
          outcome = await reconcileEvent(env, config, { ...deps, lease }, fresh);
        } else {
          outcome = await handleEvent(env, config, { ...deps, lease }, event);
        }
        // The checkpoint (and a reconciliation's completion) is written under the same lease as the work: a worker that lost the lease
        // cannot mark the event processed.
        // G-F1: the event is applied under its home's lease: its dispute hold (if this event still holds it) is attributed with it, whatever
        // the outcome (a reconciled, superseded or settled event included).
        await fencedBatch(env, lease, [q("UPDATE stripe_events SET processed_at=?,error=?,next_attempt_at=NULL WHERE id=?", now, outcome, eventId), ...reconciled(outcome),
          ...resolveStuck(),
          // INTEGRATED-12 P2-6: what the hold held is due at once; a hold whose scope is still pending is never released by a checkpoint.
          q(`${WAKE_HELD_BY_HOLD_SQL} AND EXISTS (SELECT 1 FROM dispute_holds x WHERE x.event_id=?1 AND x.attributed_at IS NULL AND x.scope_pending=0)
            AND EXISTS (SELECT 1 FROM stripe_events e WHERE e.id=?1 AND e.processed_at IS NOT NULL)`, eventId, now),
          q("UPDATE dispute_holds SET home_id=?,attributed_at=? WHERE event_id=? AND attributed_at IS NULL AND scope_pending=0", lease.homeId, now, eventId)]);
      } catch (e) {
        if (e instanceof LeaseLost || e instanceof HomeBusy) throw e;
        // The failure is recorded under the SAME lease: a worker that lost it meanwhile (another one may have finished this event since)
        // writes no error, no backoff, no attempt count and no alert over the newer holder's. The backoff is derived from the committed
        // attempt count in SQL (the same statement as the pre-lease failure below).
        try {
          await fencedBatch(env, lease, [q("UPDATE stripe_events SET attempts=attempts+1,error=?,next_attempt_at=?+MIN(?,60000*(1<<MIN(attempts+1,12))) WHERE id=? AND processed_at IS NULL",
            codeOf(e), now, backoffCapFor(event.type), eventId), ...escalation(lease.homeId)]);
        } catch (e2) { if (e2 instanceof LeaseLost) throw e2; throw e; }
        throw new EventFailureRecorded(e);
      }
    }, deps.lease);
  } catch (e) {
    // Lost the lease: another worker holds this home now and owns the event's bookkeeping. Nothing is written.
    if (e instanceof LeaseLost) throw e;
    if (e instanceof EventFailureRecorded) throw e.original;
    // Never held the lease (a busy home): nothing is written. The sweep's claim already moved this event's due time; a webhook delivery is
    // redelivered by Stripe and the sweep serves the event when it is due.
    if (e instanceof HomeBusy) throw e;
    // A failure before any lease was taken (the home cannot be resolved yet, a lookup miss, a reconciliation's retrieval failed): no lease to
    // fence against. Pending-guarded, with the escalation in the same transaction, everything derived from the committed row. A PendingMiss
    // is rethrown only once this record has committed (a failing record throws its own error instead).
    await env.DB.batch([env.DB.prepare("UPDATE stripe_events SET attempts=attempts+1,error=?,next_attempt_at=?+MIN(?,60000*(1<<MIN(attempts+1,12))) WHERE id=? AND processed_at IS NULL")
      .bind(codeOf(e), now, backoffCapFor(event.type), eventId), ...unfencedStmts(escalation(homeId))]);
    throw e;
  }
}

// ---- WP6: billing-address change and the replacement checkout (plan r13d §1.3, §3.3, §4.1) ------------------------------------------

const RUNNING_STATUSES = ["active", "trialing", "past_due"];

/** The frozen cutover boundary of a replaced subscription (WP6 r1-5). */
async function cutoverBoundary(env: Env, oldId: string): Promise<CutoverBoundary | null> {
  const r = await env.DB.prepare("SELECT cutover_at,old_invoice_id FROM replacement_cutovers WHERE old_subscription_id=?").bind(oldId)
    .first<{ cutover_at: number; old_invoice_id: string | null }>();
  return r ? { cutoverAt: r.cutover_at, oldInvoiceId: r.old_invoice_id } : null;
}
/** A replaced subscription with no frozen boundary on record (a cutover made before 0071 with nothing owed has no refund operation to backfill
 *  from): recovered from the ORIGINAL replacement payment event, exactly as migration 0071 does, when exactly one is on record (WP6 r2-1).
 *  Persisted (source 'payment_event', old invoice unknown) and returned; null when it cannot be resolved (never invented).
 *  WP6 r3-1: only COMMITTED replacement evidence counts (the view replacement_payment_events: the cutover's own replacement_done obligation
 *  for that home and successor, the successor never rejected for another reason, the order's recorded paid moment not contradicted). A
 *  refunded duplicate or rejected paid attempt never supplies a boundary or a successor: the invoice stays a retryable obligation. */
async function recoverCutoverBoundary(env: Env, lease: HomeLease, oldId: string, now: number): Promise<CutoverBoundary | null> {
  const known = await cutoverBoundary(env, oldId);
  if (known) return known;
  const v = await env.DB.prepare(`SELECT MIN(v.home_id) AS home_id,MIN(v.replacement_subscription_id) AS sub,MIN(v.paid_at) AS paid_at,MIN(t.at) AS at
    FROM rejected_subscriptions t JOIN replacement_payment_events v ON v.old_subscription_id=t.subscription_id
    WHERE t.subscription_id=? AND t.reason='replaced' AND v.home_id IS NOT NULL AND v.replacement_subscription_id IS NOT NULL AND v.paid_at IS NOT NULL
    HAVING COUNT(DISTINCT v.replacement_subscription_id)=1 AND COUNT(DISTINCT v.paid_at)=1 AND COUNT(DISTINCT v.home_id)=1`).bind(oldId)
    .first<{ home_id: string; sub: string; paid_at: number; at: number | null }>();
  if (!v || v.home_id !== lease.homeId) return null;
  await fencedRun(env, lease, `INSERT INTO replacement_cutovers (old_subscription_id,home_id,replacement_subscription_id,cutover_at,old_invoice_id,old_period_start,old_period_end,created_at,source)
    VALUES (?,?,?,?,NULL,NULL,NULL,?,'payment_event') ON CONFLICT(old_subscription_id) DO NOTHING`, oldId, v.home_id, v.sub, v.paid_at, v.at ?? now);
  return cutoverBoundary(env, oldId);
}

/** The refund path of the contract a replaced subscription was bought with (int2-2): "mp" for a Link (Managed Payments) contract, "direct"
 *  otherwise. The same answer the cutover batch records for that contract's own refund (direct when the contract is not on record). */
async function oldContractPath(env: Env, homeId: string, oldId: string): Promise<RefundPath> {
  const sub = await env.DB.prepare("SELECT consent_id FROM billing_subscriptions WHERE home_id=? AND subscription_id=?").bind(homeId, oldId).first<{ consent_id: string | null }>();
  const c = (sub?.consent_id ? await getConsent(env, sub.consent_id) : null) ?? await consentOfSubscription(env, homeId, oldId);
  return c ? refundPathOf(c) : "direct";
}
/** True when the subscription was tombstoned because a replacement took it over (WP6), not rejected for any other reason. */
async function isReplacedSub(env: Env, subscriptionId: string | null): Promise<boolean> {
  if (!subscriptionId) return false;
  const t = await env.DB.prepare("SELECT reason FROM rejected_subscriptions WHERE subscription_id=?").bind(subscriptionId).first<{ reason: string | null }>();
  return t?.reason === "replaced";
}

/** The refund operation for one old-plan invoice judged against the frozen boundary (op `late_payment:<invoice>`, one per invoice whichever
 *  path finds it first): unserved -> the whole invoice; overlap -> the unused fraction from cutover_at, from frozen values. Null otherwise.
 *  `stmts` go in the SAME fenced batch as the refund. `path` is the OLD contract's refund path (int2-2, plan §4.2): a direct (Ferrox) plan is
 *  refunded through a credit note, a Link (Managed Payments) plan through POST /v1/refunds, where credit notes are not available. */
function replacedInvoiceRefund(verdict: ReplacedInvoiceClass, i: { homeId: string; userId: string; oldId: string; invoiceId: string; paidCents: number;
  paymentIntent: string | null; periodStart: number | null; periodEnd: number | null; cutoverAt: number; path: RefundPath }, now: number): { opId: string; stmts: Q[] } | null {
  if (i.paidCents <= 0) return null;
  const opId = `late_payment:${i.invoiceId}`;
  if (verdict === "unserved") return { opId, stmts: [refundOpInsert({ id: opId, kind: "late_payment", homeId: i.homeId, userId: i.userId, invoiceId: i.invoiceId, paidCents: i.paidCents,
    targetCents: i.paidCents, endPlan: false, subscriptionId: i.oldId, inheritSubscription: false, paymentIntent: i.paymentIntent, detail: { path: i.path } }, now),
    ...unservedRenewalUndo(i.homeId, i.invoiceId, opId, now)] };
  if (verdict === "overlap" && i.periodStart !== null && i.periodEnd !== null) {
    const target = apiAmountCents(i.paidCents, i.periodEnd - i.cutoverAt, i.periodEnd - i.periodStart);
    if (target <= 0) return null;
    // A period the old plan partly served is refunded by its unused fraction only. Its credit grant is NOT reversed: the month was partly
    // used, and B4 cannot tell which part of the grant belongs to which days, so taking it all back would charge the customer for days they
    // had. The refund operation and its alert put the invoice in front of ops, who review the credit by hand.
    return { opId, stmts: [refundOpInsert({ id: opId, kind: "cutover", homeId: i.homeId, userId: i.userId, invoiceId: i.invoiceId, paidCents: i.paidCents, targetCents: target,
      endPlan: false, subscriptionId: i.oldId, inheritSubscription: false, paymentIntent: i.paymentIntent, detail: { path: i.path },
      frozen: { cutoverAt: i.cutoverAt, oldInvoiceId: i.invoiceId, oldPeriodStart: i.periodStart, oldPeriodEnd: i.periodEnd } }, now)] };
  }
  return null;
}

/** An old-plan renewal the old plan never served, refunded in full (WP6 meets WP5): if billing already handled it (its credit was granted,
 *  or its payment was handed to the lifecycle), the same undo a rejection does is journaled with the refund. Each credit grant of THIS
 *  invoice gets one reversal (B4 takes back only what is unused of that grant; consumed credit, prepaid funds and every other grant,
 *  the replacement's included, are never touched), and THIS invoice's payment is tombstoned for the home so its "paid" lifecycle entry
 *  provisions nothing. Nothing is written for a renewal billing never handled. Executed after the batch by reverseCredits; the sweep retries. */
function unservedRenewalUndo(homeId: string, invoiceId: string, opId: string, now: number): Q[] {
  const paymentId = invoiceId.slice(0, 128);
  return [
    finalTargetsQ(invoiceId, homeId, "replaced_unserved", opId, now),
    q(`INSERT INTO cloud_payment_voids (home_id,payment_id,reason,ref,voided_at) SELECT ?,?,'replaced_unserved',?,?
      WHERE EXISTS(SELECT 1 FROM credit_grants WHERE invoice_id=? AND home_id=?)
         OR EXISTS(SELECT 1 FROM cloud_payment_inbox WHERE home_id=? AND json_extract(payload,'$.paymentId')=? AND json_extract(payload,'$.status')='paid')
      ON CONFLICT DO NOTHING`, homeId, paymentId, opId, now, invoiceId, homeId, homeId, paymentId),
  ];
}

/** An invoice of a REPLACED subscription paid after the cutover: classified against the FROZEN boundary (payment time and service period,
 *  never event arrival). A period the old plan never served is refunded in full, a period spanning the cutover that the cutover did not
 *  freeze by its unused fraction, a served period or the frozen invoice not at all (WP6 r1-5). Null: not a replaced subscription's payment. */
async function refundLateReplacedPayment(env: Env, deps: BillingDependencies, ctx: RefundContext, config: BillingConfig, inv: InvoiceView, subscriptionId: string): Promise<string | null> {
  if (!await isReplacedSub(env, subscriptionId)) return null;
  const invoiceId = str(inv.id);
  if (!invoiceId || inv.amount_paid <= 0) return null;
  const lease = ctx.lease!;
  const home = await env.DB.prepare("SELECT owner_id FROM cloud_homes WHERE id=?").bind(lease.homeId).first<{ owner_id: string }>();
  if (!home) return null;
  const b = await recoverCutoverBoundary(env, lease, subscriptionId, ctx.now);
  const cls = b ? classifyInvoice(await completeLines(inv, invoiceId, () => ctx.stripe), config, subscriptionId, null) : null;
  const period = cls && cls !== "ambiguous" && cls.kind === "renewal" ? cls.line.period : null;
  const periodStart = period?.start != null ? period.start * 1000 : null; const periodEnd = period?.end != null ? period.end * 1000 : null;
  const verdict: ReplacedInvoiceClass = b ? classifyReplacedInvoice(b, { id: invoiceId, periodStart, periodEnd }) : "unclassified";
  if (verdict === "frozen") return null;
  if (verdict === "served") return "replaced_invoice_served";
  // No boundary (unresolvable), or no readable service period: the money is undecided. A refund already decided for this invoice (by ops, or
  // any refund path) closes it; otherwise it stays a retryable reconciliation obligation, alerted once and never closed (WP6 r2-1).
  if (!b || verdict === "unclassified") {
    // WP6 r3-2: only an explicit, decided replacement-refund decision for THIS invoice (its late_payment operation, or a cutover operation
    // frozen on it), or decided refunds proven to cover the whole paid amount, close it. An unrelated partial, zero or undecided refund row
    // keeps it pending; the remainder is reconciled through the ledger once the boundary is known.
    const decided = await env.DB.prepare(`SELECT
        MAX(CASE WHEN (id=? OR (kind='cutover' AND old_invoice_id=invoice_id)) AND decided_at IS NOT NULL THEN 1 ELSE 0 END) AS explicit,
        COALESCE(SUM(CASE WHEN decided_at IS NOT NULL AND COALESCE(stripe_refund_status,'') NOT IN ('failed','canceled') THEN COALESCE(amount_cents,0) ELSE 0 END),0) AS covered
      FROM refund_ops WHERE invoice_id=?`).bind(`late_payment:${invoiceId}`, invoiceId).first<{ explicit: number | null; covered: number }>();
    if (decided && (decided.explicit === 1 || decided.covered >= inv.amount_paid)) return "refunded_invoice";
    await fencedRun(env, lease, "INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      `alert:late_payment:${invoiceId}`, lease.homeId, b ? "checkout.replaced_invoice_unclassified" : "checkout.replaced_boundary_unresolved", "high",
      JSON.stringify({ invoiceId, subscriptionId, verdict, opId: null }), ctx.now);
    throw new Error(b ? "replaced_invoice_unclassified" : "replaced_boundary_unresolved");
  }
  const refund = replacedInvoiceRefund(verdict, { homeId: lease.homeId, userId: home.owner_id, oldId: subscriptionId, invoiceId, paidCents: inv.amount_paid,
    paymentIntent: inv.payment_intent, periodStart, periodEnd, cutoverAt: b.cutoverAt, path: await oldContractPath(env, lease.homeId, subscriptionId) }, ctx.now);
  // An overlap whose unused fraction rounds to nothing, from known frozen values: decided, nothing owed.
  if (!refund) return "replaced_invoice_nothing_owed";
  await fencedBatch(env, lease, [
    ...refund.stmts,
    q("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      `alert:late_payment:${invoiceId}`, lease.homeId, "checkout.replaced_late_payment", "high",
      JSON.stringify({ invoiceId, subscriptionId, verdict, opId: refund.opId }), ctx.now),
  ]);
  await advanceRefundOp(env, ctx, refund.opId);
  await reverseJournaledCredits(env, ctx, lease.homeId);
  return "replaced_late_payment_refunded";
}

/** A billing-country change, from `customer.updated` or the `invoice.created` backstop: ONE check, path coverage only (the kill switch is
 *  never read here). covered -> declared_country follows, nothing else; the other path covers it, or no path does -> the subscription ends
 *  at its period end (durable intent: the `address_change` route row, read by desiredCancel and synced by syncCancellation), the route
 *  sends the customer to the right page, Email A or B. Idempotent: the same country again writes and sends nothing. */
async function applyAddressChange(env: Env, deps: BillingDependencies, ctx: RefundContext, i: { homeId: string; sub: SubRow | null; country: string | null }): Promise<string> {
  const lease = ctx.lease!; const now = ctx.now;
  const sub = i.sub;
  if (!sub?.subscription_id || !RUNNING_STATUSES.includes(sub.status)) return "no_running_subscription";
  const consent = sub.consent_id ? await getConsent(env, sub.consent_id) : null;
  if (!consent) return "address_no_consent";
  const cov = pathCoverage(sellerSettings(env), sellerOfConsent(consent), i.country);
  if (cov.kind === "unknown") return "address_unknown";
  const country = i.country!.trim().toUpperCase();
  const account = consent.user_id;
  const route = await env.DB.prepare("SELECT * FROM checkout_retry_routes WHERE account_id=?").bind(account).first<RetryRoute>();
  const own = route && route.reason === "address_change" && route.replaces_subscription_id === sub.subscription_id ? route : null;
  if (cov.kind === "covered") {
    await fencedBatch(env, lease, [
      q("UPDATE checkout_consents SET declared_country=? WHERE id=? AND COALESCE(declared_country,'')<>?", country, consent.id, country),
      ...(own ? [q("DELETE FROM checkout_retry_routes WHERE account_id=? AND reason='address_change' AND replaces_subscription_id=?", account, sub.subscription_id),
        q("UPDATE billing_subscriptions SET cancel_intent_rev=cancel_intent_rev+1 WHERE home_id=? AND subscription_id=?", i.homeId, sub.subscription_id)] : []),
    ]);
    // Back on a covered path: the renewal the address change had stopped is restored (a customer's own cancellation still stands).
    if (own) await syncCancellation(env, { ...deps, lease }, i.homeId, lease);
    return "address_covered";
  }
  const seller = cov.kind === "other_path" ? cov.seller : NONE_SELLER;
  const periodEnd = sub.current_period_end;
  const lang = consent.checkout_language;
  const vars = { country: countryFor(country, lang), periodEnd: periodEnd ? isoDate(periodEnd) : periodEndFallback(lang),
    payee: replacementWords(seller === "link" ? "payeeLink" : "payeeDirect", lang) };
  const [subject, body] = cov.kind === "other_path"
    ? [replacementWords("addressChangeASubject", lang), replacementWords("addressChangeA", lang, vars)]
    : [replacementWords("addressChangeBSubject", lang, vars), replacementWords("addressChangeB", lang, vars)];
  const same = own !== null && own.seller === seller && own.collected_country === country;
  const noticeKey = `${sub.subscription_id}:${country}`;
  if (!same) {
    await fencedBatch(env, lease, [
      q(`INSERT INTO checkout_retry_routes (account_id,seller,collected_country,reason,replaces_subscription_id,expires_at) VALUES (?,?,?,'address_change',?,?)
        ON CONFLICT(account_id) DO UPDATE SET seller=excluded.seller,collected_country=excluded.collected_country,reason='address_change',
        replaces_subscription_id=excluded.replaces_subscription_id,expires_at=excluded.expires_at`, account, seller, country, sub.subscription_id, routeExpiresAt(periodEnd, now)),
      q("UPDATE billing_subscriptions SET cancel_intent_rev=cancel_intent_rev+1 WHERE home_id=? AND subscription_id=?", i.homeId, sub.subscription_id),
      recordNotice(i.homeId, "address_change", noticeKey, { emailSubject: subject, emailText: body, emailHtml: htmlOf(body) }, now),
      q("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        `alert:addr:${noticeKey}`, i.homeId, "checkout.address_change", cov.kind === "uncovered" ? "high" : "warning",
        JSON.stringify({ country, seller, subscriptionId: sub.subscription_id, periodEnd }), now),
    ]);
  }
  await syncCancellation(env, { ...deps, lease }, i.homeId, lease);
  if (!same) {
    try { await notify(env, { ...deps, lease }, i.homeId, "address_change", noticeKey, { emailSubject: subject, emailText: body, emailHtml: htmlOf(body) }); }
    catch { /* recorded in the batch above; the sweep retries */ }
  }
  return cov.kind === "other_path" ? "address_other_path" : "address_uncovered";
}

/** A replacement purchase's payment is confirmed (paid_at) while the old subscription still runs: ONE fenced batch moves the claim, freezes
 *  cutover_at (the payment event's `created`) with the old invoice and period, tombstones the old subscription, queues the cutover refund
 *  (op `cutover:<old sub>`, idempotent) and clears the route. A guard row aborts the whole batch if the slot was not taken. Then the old
 *  subscription is cancelled at Stripe (prorate=false, invoice_now=false) and the refund advances. Nothing here reads the kill switch. */
async function moveToReplacement(env: Env, deps: BillingDependencies, ctx: RefundContext, config: BillingConfig,
  i: { homeId: string; consent: ConsentRow; oldSub: SubRow; incomingSub: string; paidAt: number }): Promise<void> {
  const lease = ctx.lease!; const now = ctx.now; const stripe = ctx.stripe;
  const oldId = i.oldSub.subscription_id!;
  // The old contract's paid periods, read from Stripe BEFORE the batch (reads only). The batch freezes the invoice whose period COVERS paidAt
  // (r1-6), and every other paid old invoice is judged against that frozen boundary: one the old plan never served (an old renewal charged
  // while this replacement was being processed, its webhook possibly already applied) is refunded on its own, invoice-keyed.
  const periods: { invoiceId: string; paidCents: number; paymentIntent: string | null; start: number; end: number }[] = [];
  for (const inv of (await stripe.listPaidInvoices(oldId)).data) {
    if (inv.amount_paid <= 0) continue;
    const cls = classifyInvoice(await completeLines(inv, inv.id, () => stripe), config, oldId, null);
    if (cls === "ambiguous" || !cls || cls.kind !== "renewal" || cls.line.period.start === null || cls.line.period.end === null) continue;
    periods.push({ invoiceId: inv.id, paidCents: inv.amount_paid, paymentIntent: inv.payment_intent ?? null, start: cls.line.period.start * 1000, end: cls.line.period.end * 1000 });
  }
  const frozen = invoiceCoveringPaidAt(periods, i.paidAt);
  const boundary: CutoverBoundary = { cutoverAt: i.paidAt, oldInvoiceId: frozen?.invoiceId ?? null };
  // Every refund of the OLD contract (the cutover's own and each later old invoice's) goes through the old contract's refund path (int2-2).
  const oldConsent = (i.oldSub.consent_id ? await getConsent(env, i.oldSub.consent_id) : null) ?? await consentOfSubscription(env, i.homeId, oldId);
  const oldPath: RefundPath = oldConsent ? refundPathOf(oldConsent) : "direct";
  const later = periods.flatMap((p) => {
    const r = replacedInvoiceRefund(classifyReplacedInvoice(boundary, { id: p.invoiceId, periodStart: p.start, periodEnd: p.end }),
      { homeId: i.homeId, userId: i.consent.user_id, oldId, invoiceId: p.invoiceId, paidCents: p.paidCents, paymentIntent: p.paymentIntent, periodStart: p.start, periodEnd: p.end, cutoverAt: i.paidAt, path: oldPath }, now);
    return r ? [r] : [];
  });
  // A Link (Managed Payments) replacement only authorizes Link to charge: a direct contract's automatic top-up is switched off in the SAME
  // batch as the cutover (a durable new revision the sweep retries until Flux has it), and applied right after (r1-7).
  const toLink = sellerOfConsent(i.consent) === "link";
  const est = frozen ? cutoverEstimate(frozen.paidCents, { cutoverAt: i.paidAt, oldPeriodStart: frozen.start, oldPeriodEnd: frozen.end }) : null;
  const lang = i.consent.checkout_language;
  const opId = `cutover:${oldId}`;
  const text = est ? replacementWords("replacementDone", lang, { amount: usdFor(est.cents, lang), days: String(est.days) }) : replacementWords("replacementDoneNoRefund", lang);
  const data = { emailSubject: replacementWords("replacementDoneSubject", lang), emailText: text, emailHtml: htmlOf(text) };
  const [claimSql, claimBinds] = claimStatement(i.homeId, i.incomingSub, i.consent.id, now, oldId);
  // The replacement's paid moment (paid_at, the guarantee from paid_at, the 7-day refund from the inherited service start, the "Payment
  // received" obligation) is frozen IN the cutover batch (WP6 r2-2): whatever is interrupted after it (the old plan's cancellation, the
  // completion), a later invoice.paid or retry finds it written and never recomputes it against the inherited service start.
  const paidMoment = await paidMomentStatements(env, i.consent, { homeId: i.homeId, subscriptionId: i.incomingSub, paidAt: i.paidAt, replacement: true,
    notice: { renewsAt: await renewalDateOf(env, () => stripe, i.homeId, i.incomingSub) }, serviceStartAt: i.oldSub.service_start_at ?? i.paidAt }, now);
  const guard = `cutover-${crypto.randomUUID()}`;
  await fencedBatch(env, lease, [
    [claimSql, claimBinds],
    q("INSERT INTO cloud_write_guards VALUES (?,changes())", guard),
    ...deletionBindQs(i.homeId, now),
    // The server keeps running: no re-provisioning, service_start_at stays the original one.
    q("UPDATE billing_subscriptions SET service_start_at=COALESCE(?,service_start_at) WHERE home_id=? AND subscription_id=?", i.oldSub.service_start_at, i.homeId, i.incomingSub),
    ...paidMoment,
    q("INSERT INTO rejected_subscriptions (subscription_id,at,reason) VALUES (?,?,'replaced') ON CONFLICT DO NOTHING", oldId, now),
    q("DELETE FROM checkout_retry_routes WHERE account_id=? AND reason='address_change' AND replaces_subscription_id=?", i.consent.user_id, oldId),
    ...(frozen && est ? [refundOpInsert({ id: opId, kind: "cutover", homeId: i.homeId, userId: i.consent.user_id, invoiceId: frozen.invoiceId, paidCents: frozen.paidCents,
      targetCents: est.cents, endPlan: false, cancelSubscriptionId: oldId, subscriptionId: oldId, inheritSubscription: false,
      detail: { path: oldPath },
      frozen: { cutoverAt: i.paidAt, oldInvoiceId: frozen.invoiceId, oldPeriodStart: frozen.start, oldPeriodEnd: frozen.end } }, now)] : []),
    // The boundary is persisted even when nothing is owed (zero cents left, no covering invoice): a delayed old invoice is judged against it.
    q(`INSERT INTO replacement_cutovers (old_subscription_id,home_id,replacement_subscription_id,cutover_at,old_invoice_id,old_period_start,old_period_end,created_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(old_subscription_id) DO NOTHING`, oldId, i.homeId, i.incomingSub, i.paidAt, frozen?.invoiceId ?? null, frozen?.start ?? null, frozen?.end ?? null, now),
    ...later.flatMap((r) => r.stmts),
    ...(toLink ? [
      q("UPDATE topup_settings SET enabled=0,revision=revision+1,updated_at=?,apply_error=NULL WHERE home_id=? AND enabled=1", now, i.homeId),
      q(`INSERT INTO topup_events (id,home_id,user_id,enabled,amount_cents,threshold_cents,cap_cents,source,ip,user_agent,created_at)
        SELECT ?,home_id,user_id,0,amount_cents,threshold_cents,cap_cents,'link_not_eligible',NULL,NULL,? FROM topup_settings WHERE home_id=? AND changes()=1`, crypto.randomUUID(), now, i.homeId),
    ] : []),
    // No covering paid invoice while the old period still ran is unexpected (ops looks); after the old period ended (the grace) it is normal.
    ...(frozen || (i.oldSub.current_period_end ?? 0) <= i.paidAt ? [] : [q("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      `alert:${opId}`, i.homeId, "checkout.cutover_no_paid_invoice", "high", JSON.stringify({ oldSubscription: oldId, replacement: i.incomingSub }), now)]),
    recordNotice(i.homeId, "replacement_done", i.incomingSub, data, now),
    q("DELETE FROM cloud_write_guards WHERE id=?", guard),
  ]);
  if (toLink && await getTopup(env, i.homeId)) await applyTopup(env, lease, ctx.flux, i.homeId, now);
  await settleReplaced(env, ctx, oldId, est ? opId : null);
  for (const r of later) await advanceRefundOp(env, ctx, r.opId);
  if (later.length) await reverseJournaledCredits(env, ctx, i.homeId);
  try { await notify(env, { ...deps, lease }, i.homeId, "replacement_done", i.incomingSub, data); }
  catch { /* recorded in the batch above; the sweep retries */ }
}

/** The old subscription of a completed replacement ends at Stripe without proration (confirmed), and its cutover refund advances. Safe to
 *  repeat: a replayed event, the sweep or a crash between the batch and these calls all land here again. */
async function settleReplaced(env: Env, ctx: RefundContext, oldId: string, opId: string | null): Promise<void> {
  if (!await isRejectedSub(env, oldId)) return;
  await fence(env, ctx.lease!);
  await cancelConfirmed(env, ctx.lease!, ctx.stripe, oldId, NO_PRORATION);
  if (opId) await advanceRefundOp(env, ctx, opId);
}

/** The customer's order for a replacement was submitted but the payment has not cleared: the order stands (completed_at, the withdrawal
 *  clock), and nothing moves. */
async function replacementCompletedUnpaid(env: Env, deps: BillingDependencies, config: BillingConfig, c: ConsentRow, i: { homeId: string; sessionId: string }, now: number): Promise<string> {
  const lease = deps.lease!;
  await fencedRun(env, lease, "UPDATE checkout_consents SET statutory_withdraw_until=COALESCE(statutory_withdraw_until,?) WHERE id=?",
    deadlinesFor({ resident: consentIsEu(c), completedAt: c.completed_at ?? now, paidAt: null, serviceStartAt: null, replacement: true }).statutoryWithdrawUntil, c.id);
  const c2 = (await getConsent(env, c.id))!;
  const mail = buildConfirmationEmail(c2, await loadAcceptedDocs(env, c2), { portalOrigin: config.returnOrigin, legalPhone: traderIdentity(env).phone, paid: false, replacement: true });
  await notify(env, deps, i.homeId, "confirmation", i.sessionId, { consentId: c.id, emailSubject: mail.subject, emailText: mail.text, emailHtml: mail.html });
  await fencedBatch(env, lease, [
    q("UPDATE checkout_consents SET confirmation_sent_at=COALESCE(confirmation_sent_at,?) WHERE id=?", now, c.id),
    q("UPDATE open_checkouts SET state='completed',session_id=COALESCE(?,session_id),updated_at=? WHERE home_id=?", i.sessionId, now, i.homeId),
  ]);
  return "replacement_unpaid";
}

/** async_payment_failed or expiry of a replacement: nothing moves. The old plan keeps ending at its period end, the route stays, and the
 *  customer is told. The new subscription (if any) is cancelled without proration and tombstoned. */
async function replacementNotPaid(env: Env, deps: BillingDependencies, ctx: RefundContext, c: ConsentRow,
  i: { homeId: string; oldSub: SubRow; incomingSub: string | null; why: "async_payment_failed" | "expired"; key: string }): Promise<void> {
  const lease = ctx.lease!; const now = ctx.now;
  const lang = c.checkout_language;
  const text = replacementWords("replacementFailed", lang, { periodEnd: i.oldSub.current_period_end ? isoDate(i.oldSub.current_period_end) : periodEndFallback(lang) });
  const data = { emailSubject: replacementWords("replacementFailedSubject", lang), emailText: text, emailHtml: htmlOf(text) };
  if (i.incomingSub) { await fence(env, lease); await cancelConfirmed(env, lease, ctx.stripe, i.incomingSub, NO_PRORATION); }
  await fencedBatch(env, lease, [
    q("UPDATE checkout_consents SET payment_failed_at=COALESCE(payment_failed_at,?) WHERE id=?", now, c.id),
    ...(i.incomingSub ? [q("INSERT INTO rejected_subscriptions (subscription_id,at,reason) VALUES (?,?,?) ON CONFLICT DO NOTHING", i.incomingSub, now, i.why)] : []),
    ...(i.why === "async_payment_failed" ? [q("UPDATE open_checkouts SET state='failed',updated_at=? WHERE home_id=?", now, i.homeId)] : []),
    q("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      `alert:replfail:${i.key}`, i.homeId, `checkout.replacement_${i.why}`, "warning", JSON.stringify({ consentId: c.id, subscriptionId: i.incomingSub, oldSubscription: i.oldSub.subscription_id }), now),
    recordNotice(i.homeId, "replacement_failed", i.key, data, now),
  ]);
  try { await notify(env, { ...deps, lease }, i.homeId, "replacement_failed", i.key, data); }
  catch { /* recorded in the batch above; the sweep retries */ }
}

/** A replacement whose payment cleared but which can no longer be adopted (the home's slot is held by another contract, or the old plan is
 *  disputed): the payment is refunded in full through the ledger and the new subscription cancelled; ops is told. Same op id as the
 *  completion's duplicate path, so the two never refund twice. */
async function replacementUnrecoverable(env: Env, ctx: RefundContext, c: ConsentRow, i: { homeId: string; incomingSub: string; session: Obj; key: string; kept: string | null }): Promise<string> {
  const lease = ctx.lease!;
  const amount = typeof i.session.amount_total === "number" ? i.session.amount_total : 0;
  const opId = `duplicate:${i.key}`;
  await fencedBatch(env, lease, [
    refundOpInsert({ id: opId, kind: "duplicate", homeId: i.homeId, userId: c.user_id, invoiceId: amount > 0 ? idOf(i.session.invoice) : null,
      paidCents: amount, targetCents: amount, endPlan: false, cancelSubscriptionId: i.incomingSub, detail: { path: refundPathOf(c) } }, ctx.now),
    q("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      `alert:replunrec:${i.incomingSub}`, i.homeId, "checkout.replacement_unrecoverable", "high", JSON.stringify({ kept: i.kept, refunded: i.incomingSub, opId }), ctx.now),
  ]);
  await advanceRefundOp(env, ctx, opId);
  return "replacement_refunded";
}

async function handleEvent(env: Env, config: BillingConfig, deps: BillingDependencies, event: z.infer<typeof eventSchema>): Promise<string | null> {
  const obj = event.data.object as Obj;
  const flux = deps.flux ?? stubFluxHooks;
  const stripe = (): StripeClient => stripeClient(config, deps.stripeFetch);
  const now = (deps.now ?? Date.now)();
  // Every event is applied under the lease of the home it belongs to; a handler that resolves a different home stops (and is retried).
  const lease = deps.lease;
  if (!lease) throw new Error("lease_required");
  const resolve = async (o: Obj, extra: { customer?: string | null; subscription?: string | null } = {}) => {
    const r = await resolveHome(env, o, extra);
    if (r.homeId !== lease.homeId) throw new Error("home_changed");
    return r;
  };
  // A subscription the guard cancelled (or whose asynchronous payment failed) never provisions, renews or ends anything again.
  const eventSub = event.type.startsWith("invoice.") ? invoiceView(obj).subscription : event.type.startsWith("customer.subscription.") ? str(obj.id) : null;
  if (await isRejectedSub(env, eventSub)) {
    if (event.type === "invoice.paid") {
      // A subscription a replacement took over still owes its refund obligations: classified against its frozen cutover (WP6), never the
      // stranded-payment full refund below.
      if (eventSub && await isReplacedSub(env, eventSub)) return (await refundLateReplacedPayment(env, deps, { stripe: stripe(), flux, deps, now, lease }, config, invoiceView(obj), eventSub)) ?? "rejected_subscription";
      // The tombstone never discards money: a payment on a cancelled order is refunded in full first (Astra WP5-1 #2).
      const consent = await consentOfSubscription(env, lease.homeId, eventSub);
      // An order refused on its own has no consent of its own: its refund takes the seller path persisted with the refusal.
      const own = consent ? null : await ownRefusalOf(env, eventSub);
      const kind = consent?.rejected_reason && isRejectKind(consent.rejected_reason) ? consent.rejected_reason : own?.kind === "rejected_consent" ? "rejected_consent" : "late_payment";
      await refundStrandedPayment(env, { stripe: stripe(), flux, deps, now, lease }, { homeId: lease.homeId, consent, kind, invoiceId: str(obj.id),
        amount: invoiceView(obj).amount_paid, subscriptionId: eventSub, path: own?.path ?? undefined }, now);
    }
    return "rejected_subscription";
  }
  switch (event.type) {
    case "checkout.session.completed": {
      if (obj.mode !== "subscription") return "ignored_mode";
      const { homeId: id, sub } = await resolve(obj);
      const meta = rec(obj.metadata);
      // The saved attempt that created this session is resolved by it, whatever its key last answered (Astra STEPUP-EMAIL-8 #2).
      await settleCheckoutAttempt(env, lease, id, { id: str(obj.id), consentId: str(meta.consent_id), expiresAtSeconds: typeof obj.expires_at === "number" ? obj.expires_at : null, completed: true });
      // The acknowledged tax preset of this checkout has served its purpose (Astra TAXCOUNTRY-2 P3).
      await fencedRun(env, lease, "DELETE FROM cloud_ops_state WHERE key=?", taxPresetKey(id));
      const paid = obj.payment_status === "paid" || obj.payment_status === "no_payment_required";
      const incomingSub = str(obj.subscription);
      const refundCtx = (): RefundContext => ({ stripe: stripe(), flux, deps, now, lease });
      const address = rec(rec(obj.customer_details).address);
      const collected = str(address.country);
      // The consent this session is for (sessionConsent): the one its metadata names when it is this home's, else the one bound to this
      // session id at creation. Neither: an order nobody authorized on our page. It never becomes a live subscription: tombstoned,
      // cancelled, refunded in full and ops told (refuseUnboundOrder), never thrown back to Stripe to retry (Astra NO-DROPDOWN-1 (3)).
      const named = await namedConsent(env, obj, id);
      const consent = named ?? await boundConsent(env, obj, id);
      if (!consent) return refuseUnboundOrder(env, deps, refundCtx(), { homeId: id, subscriptionId: incomingSub, session: obj, paid }, now);
      // Astra TAXCOUNTRY-5 (e): the session's customer must be this home's: its pointer, a customer it was moved away from, or an orphan of
      // its own attempts (homeKnowsCustomer). A session on any other customer was never issued for this home's pointer: refused like an order
      // nobody authorized (tombstoned, cancelled, refunded in full, ops told), never attached and never allowed to move the pointer.
      const sessionCustomer = idOf(obj.customer);
      if (sessionCustomer && (await getSub(env, id))?.customer_id && !(await homeKnowsCustomer(env, id, sessionCustomer))) {
        return refuseUnboundOrder(env, deps, refundCtx(), { homeId: id, subscriptionId: incomingSub, session: obj, paid, why: "customer_not_bound" }, now);
      }
      // THE GUARD (plan §1.1), evaluated once: a verdict is stored with the consent, and an order already accepted is never re-judged by a
      // retried event (a switch paused later, or a changed answer, cannot unwind an order that was taken).
      const accepted = consent.paid_at !== null || (incomingSub !== null && sub?.subscription_id === incomingSub && sub.consent_id === consent.id);
      const stored = consent.rejected_reason && isRejectKind(consent.rejected_reason) ? consent.rejected_reason : null;
      // Another order for this consent, recognized FIRST (Astra DROPDOWN-DIRECT-1 (2)): the consent already holds a different subscription,
      // or (not yet accepted) it is bound to a different session. That order (A) may still be awaiting its payment; THIS one (B) is refused on
      // its own (refuseUnboundOrder), and nothing of the shared consent is marked: rejectOrder would reject it, and A's later success would
      // then be cancelled and refunded too.
      const otherClaim = incomingSub !== null && !!consent.stripe_subscription_id && consent.stripe_subscription_id !== incomingSub;
      const otherSession = !!str(obj.id) && !!consent.stripe_session_id && consent.stripe_session_id !== str(obj.id);
      if (otherClaim || (otherSession && !accepted)) return refuseUnboundOrder(env, deps, refundCtx(), { homeId: id, subscriptionId: incomingSub, session: obj, paid,
        kind: otherClaim ? "duplicate" : "rejected_consent", why: otherClaim ? "consent_holds_other_subscription" : "session_not_bound", kept: consent.stripe_subscription_id ?? null }, now);
      // The renewal authorization (plan §3.2, owner decision 2026-10-14), judged BEFORE anything is attached to the consent, accepted or
      // activated (Astra NO-DROPDOWN-1 (3)): the journaled consent the metadata names must cover THIS session (same home and owner,
      // recurring_authorized, bound to this session id, the same renewal sentence by hash, the same seller path, the REAL Stripe line item
      // at the price it was sold at, written before the session; on Managed Payments the dropdown answered too). A session created before
      // the change (dropdown, no hash, its consent without Stripe-page provenance, created before the cutoff) is judged by its answer
      // (renewalAuthorized); missing metadata alone never is. Not covered: refused through the tombstone and refund path.
      if (!accepted && !stored) {
        const binding: ConsentBinding = { consent: named, homeId: id, consentSeller: sellerOfConsent(consent), lineItems: null, sha256: renewalSha256,
          ownerId: (await env.DB.prepare("SELECT owner_id FROM cloud_homes WHERE id=?").bind(id).first<{ owner_id: string }>())?.owner_id ?? null,
          configuredPriceId: config.priceByPlan[consent.plan as Plan] ?? null };
        let authorized = renewalAuthorized(obj, binding);
        // Stripe's real line items are read only when every other rule already holds (a refused session costs no Stripe call). A failed
        // read throws: the event is kept and retried, never accepted.
        if (!authorized && !isLegacySession(obj, binding) && str(obj.id) && consentRefusal(obj, binding) === "line_items_mismatch")
          authorized = renewalAuthorized(obj, { ...binding, lineItems: await stripe().checkoutSessionLineItems(str(obj.id)!) });
        if (!authorized) return rejectOrder(env, deps, refundCtx(), consent, { verdict: "rejected_consent", homeId: id, subscriptionId: incomingSub, session: obj, collected, paid }, now);
      }
      const plan = planOf(config, null, str(meta.plan)) ?? (sub?.plan as Plan | undefined) ?? null;
      if (!plan) throw new Error("plan_unresolved");
      // A second subscription for a consent that already holds one is never attached to it: cancelled and refunded in full as a duplicate.
      const refuseDuplicate = async (kept: string | null): Promise<string> => {
        const amount = typeof obj.amount_total === "number" ? obj.amount_total : 0;
        const opId = `duplicate:${idOf(obj.invoice) ?? str(obj.id) ?? event.id}`;
        await fencedBatch(env, lease, [
          refundOpInsert({ id: opId, kind: "duplicate", homeId: id, userId: consent.user_id, invoiceId: paid && amount > 0 ? idOf(obj.invoice) : null,
            paidCents: paid ? amount : 0, targetCents: paid ? amount : 0, endPlan: false, cancelSubscriptionId: incomingSub, detail: { path: refundPathOf(consent) } }, now),
          // Settled by the duplicate refund: a parking left from an earlier attempt is released (never a second, automatic refund).
          q("UPDATE checkout_consents SET acceptance_parked_at=NULL WHERE id=? AND rejected_at IS NULL", consent.id),
          bootstrapTransitionQ("closed", PRE_PAYMENT, { homeId: id, consentId: consent.id, now, reason: "duplicate" }),
          q("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
            crypto.randomUUID(), id, "checkout.duplicate_subscription", "high", JSON.stringify({ kept, refunded: incomingSub, opId }), now),
        ]);
        await advanceRefundOp(env, refundCtx(), opId);
        return "duplicate_subscription";
      };
      const totals = rec(obj.total_details);
      const contractMadeAt = event.created * 1000;
      // amount_total / currency / total_details are the INTEGRATION amounts (kept for refund accounting); what the customer actually paid,
      // when Adaptive Pricing presented another currency, is presentment_details (checkoutCharged). Its tax is not itemized there.
      const paidAs = checkoutCharged(obj);
      const integrationTax = typeof totals.amount_tax === "number" ? totals.amount_tax : null;
      // Moment 1, completed_at: the customer submitted the Stripe page. The contract is made; payment may still be pending.
      const attached = await attachSessionToConsent(env, lease, consent.id, { sessionId: str(obj.id) ?? event.id, subscriptionId: incomingSub,
        country: collected, taxCents: integrationTax,
        totalCents: typeof obj.amount_total === "number" ? obj.amount_total : null, contractMadeAt, currency: paidAs.currency,
        chargedCents: paidAs.amount, chargedTaxCents: paidAs.presented ? null : integrationTax }, now);
      // Astra JOURNEY-A-3 #2: a completed session answers the request it names (its issuance), and only that one.
      const completedIssuance = str(rec(obj.metadata).issuance_id);
      if (completedIssuance) await sessionRequestSettled(env, lease, consent.id, completedIssuance, now);
      // One successful subscription per consent (Astra NO-DROPDOWN-1 (3)): this consent already holds another subscription.
      if (attached.subscriptionTaken) return refuseDuplicate(attached.row.stripe_subscription_id ?? null);
      const c: ConsentRow = attached.row;
      // The acceptance line of this consent cannot be found (neither its wording nor its archived screen holds it): no acceptance is ever
      // invented. The consent is parked durably with ONE alert and the event ends here (no endless retry); nothing is accepted, judged,
      // claimed or provisioned until it is repaired and replayed (releaseParkedAcceptance).
      if (attached.acceptanceMissing) {
        await fencedBatch(env, lease, [
          q("UPDATE checkout_consents SET acceptance_parked_at=COALESCE(acceptance_parked_at,?) WHERE id=?", now, c.id),
          // A parked order freezes its first-purchase authorization: no new checkout on the sign-in alone, and no reclamation.
          bootstrapTransitionQ("parked", ["open", "submitted"], { homeId: id, consentId: c.id, now }),
          q("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
            `alert:acceptance_missing:${c.id}`, id, "checkout.acceptance_line_missing", "high", JSON.stringify({ consentId: c.id, eventId: event.id, sessionId: str(obj.id) }), now),
        ]);
        return "acceptance_parked";
      }
      const linkSale = sellerOfConsent(c) === "link";
      // (the statutory deadline below and every later moment use completed_at as persisted: Stripe's submission time, never a retry's clock)
      const declared = c.declared_country ?? c.billing_country;
      // The guard compares COUNTRIES, deliberately not postal codes (Astra TAXCOUNTRY-4 P1, step 4 kept): the country decides everything this
      // order's legality rests on (the seller path, consumer withdrawal rights, a paused country). The postal code only refines the tax
      // AMOUNT, and Stripe computes that on the address the customer entered on its page and shows it before they pay (the preset only makes
      // the FIRST figure there the declared location's). A purchase completed with another postal code of the declared country is a sale at
      // the customer's own entered address, taxed by Stripe on it, and the customer keeps that address: no checkout ever writes the address
      // of an existing customer (prepareCheckoutCustomer creates a new customer instead), so nothing can land on it later.
      const verdict: RejectKind | null = accepted ? null : stored ?? guardVerdict({ authorized: true, collectedCountry: collected, declaredCountry: declared,
        pathCoversCountry: !sellerMismatch(sellerSettings(env), sellerOfConsent(c), collected), declaredCountryPaused: (await countrySwitch(env, declared)) === "paused" });
      if (verdict) return rejectOrder(env, deps, refundCtx(), c, { verdict, homeId: id, subscriptionId: incomingSub, session: obj, collected, paid }, now);
      // A REPLACEMENT for a running server (metadata.replaces names the subscription the home keeps now; plan §1.3): ownership moves only on
      // confirmed payment. Unpaid: the order stands, nothing moves. Paid: one fenced cutover, then the ordinary completion below finishes it.
      // Handled whatever the old subscription's status (r1-1): an old plan that already ended (the grace after its period end) is still the one
      // the replacement takes over, so an unpaid completion never falls through to claim the cancelled slot, and a paid one restores service.
      // A disputed old plan is never taken over (the claim below refuses it and the payment is refunded in full).
      const replaces = str(meta.replaces);
      if (replaces && incomingSub && sub?.subscription_id === replaces && sub.status !== "disputed") {
        if (!paid) return replacementCompletedUnpaid(env, { ...deps, lease }, config, c, { homeId: id, sessionId: str(obj.id) ?? event.id }, now);
        await moveToReplacement(env, deps, refundCtx(), config, { homeId: id, consent: c, oldSub: sub, incomingSub, paidAt: contractMadeAt });
      } else if (replaces && incomingSub && sub?.subscription_id === incomingSub) {
        await settleReplaced(env, refundCtx(), replaces, (await getRefundOp(env, `cutover:${replaces}`)) ? `cutover:${replaces}` : null);
      }
      // One subscription per home, claimed atomically: of two completions racing for the same home exactly one keeps it. A losing (or later)
      // completion is never tracked: it is cancelled at Stripe and its payment refunded in full through the ledger, and ops is told.
      if (incomingSub) {
        await fencedRun(env, lease, `INSERT OR IGNORE INTO billing_subscriptions (home_id,customer_id,plan,created_at,updated_at) VALUES (?,?,?,?,?)`,
          id, idOf(obj.customer) ?? sub?.customer_id ?? "", plan, now, now);
        // The claim replaces a cancelled subscription's status in the same statement, so a second claimant no longer matches it.
        // A REPLACEMENT subscription (a different id) starts from nothing: the first-payment record, the service-supplied mark, the period and
        // every cancellation field belonged to the old contract and are cleared in this same statement (SQLite reads every right-hand side
        // from the old row). The same id coming back, even through a retried event, keeps its state and never leaves 'canceled'.
        // Astra INTEGRATED-2 #1: a Delete requested before this subscription existed binds it in the claim's own batch (claimQs).
        const claim = (await fencedBatch(env, lease, claimQs(id, incomingSub, c.id, now)))[0].meta.changes;
        // A replacement contract claimed while the home is still being served: the service from now on is supplied under the NEW
        // subscription (a withdrawal of either contract counts only its own days).
        if (claim === 1 && sub?.subscription_id && sub.subscription_id !== incomingSub) await applyServiceLog(env, lease);
        if (claim === 1 && sub?.subscription_id && sub.subscription_id !== incomingSub
          && await env.DB.prepare("SELECT 1 AS x FROM service_intervals WHERE home_id=? AND ended_at IS NULL").bind(id).first()) {
          await fencedBatch(env, lease, [
            q("UPDATE service_intervals SET ended_at=? WHERE home_id=? AND ended_at IS NULL", now, id),
            q("INSERT OR IGNORE INTO service_intervals (home_id,started_at,subscription_id) VALUES (?,?,?)", id, now, incomingSub),
          ]);
        }
        if (claim !== 1) return refuseDuplicate((await getSub(env, id))?.subscription_id ?? null);
      }
      // This subscription already ended (a delayed or retried completion for it): nothing below may start it again.
      if (incomingSub && ENDED(await getSub(env, id)) && (await getSub(env, id))?.subscription_id === incomingSub) {
        // Astra INTEGRATED-3 #1: a paid completion of a deleted, unserved home is owed back even though its subscription already ended.
        if (paid) await journalUnservedDeletedPayment(env, lease, { eventId: event.id, homeId: id, created: event.created, paymentId: idOf(obj.invoice) ?? str(obj.id) ?? event.id,
          paidCents: typeof obj.amount_total === "number" ? obj.amount_total : null });
        return "subscription_ended";
      }
      await fencedRun(env, lease, `INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,price_id,status,fp_tid,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(home_id) DO UPDATE SET customer_id=excluded.customer_id,
          subscription_id=COALESCE(excluded.subscription_id,subscription_id),plan=excluded.plan,price_id=excluded.price_id,
          status=CASE WHEN ${RANK_SQL("status")}>=5 THEN status WHEN ? AND ?>=${RANK_SQL("status")} THEN ? ELSE status END,fp_tid=COALESCE(fp_tid,excluded.fp_tid),updated_at=excluded.updated_at`,
      id, idOf(obj.customer) ?? sub?.customer_id, incomingSub, plan, config.priceByPlan[plan], paid ? "active" : "incomplete",
      str(meta.fp_tid) ?? sub?.fp_tid ?? null, now, now, paid ? 1 : 0, statusRank("active"), "active");
      await fencedRun(env, lease, "UPDATE billing_subscriptions SET consent_id=?,first_charge_at=? WHERE home_id=?", c.id, c.first_charge_at, id);
      // Deadline of the first moment, written once even if payment is pending or the server never starts (plan §4.1).
      await fencedRun(env, lease, "UPDATE checkout_consents SET statutory_withdraw_until=COALESCE(statutory_withdraw_until,?) WHERE id=?",
        deadlinesFor({ resident: consentIsEu(c), completedAt: c.completed_at ?? contractMadeAt, paidAt: null, serviceStartAt: null, replacement: false }).statutoryWithdrawUntil, c.id);
      // This checkout is the home's one subscription now; any other open session for the home is expired.
      const openRow = await env.DB.prepare("SELECT session_id FROM open_checkouts WHERE home_id=?").bind(id).first<{ session_id: string | null }>();
      if (openRow?.session_id && openRow.session_id !== str(obj.id)) {
        await fence(env, lease);
        try { await stripe().expireCheckoutSession(openRow.session_id); } catch { /* already expired or completed: the duplicate guard above covers it */ }
      }
      await fencedRun(env, lease, "UPDATE open_checkouts SET state='completed',session_id=COALESCE(?,session_id),updated_at=? WHERE home_id=?", str(obj.id), now, id);
      // A Link (Managed Payments) contract only authorizes Link to charge the card: an automatic top-up authorization carried over from an
      // earlier direct contract on this home is switched off here, in the same leased handling, and Flux is told (enabled:false).
      if (linkSale) await disableTopupForLink(env, lease, flux, id, c.user_id, now);
      if (c.topup_enabled === 1 && !linkSale && !(await getTopup(env, id))) {
        await saveTopup(env, lease, { homeId: id, userId: c.user_id, enabled: true, amountCents: c.topup_amount_cents ?? 0,
          thresholdCents: c.topup_threshold_cents ?? 0, capCents: c.topup_cap_cents ?? 0, consentId: c.id, source: "checkout", ip: null, userAgent: null }, now);
        await applyTopup(env, lease, flux, id, now);
      }
      // The durable confirmation ("We got your order": a copy of the contract with the ACCEPTED document versions, the withdrawal form, the
      // early-start request and any top-up authorization) must be handed off BEFORE service can start: a failure here throws, Stripe
      // retries, and nothing below has run. It is sent at completed_at whether or not payment has cleared.
      // Paid at completion: the second moment (paid_at, the server start, the guarantee and the 7-day refund) is written FIRST, so the
      // confirmation states the deadlines as stored (Astra WP5-1 #7). The confirmation itself is the "Payment received" email here. The
      // paid moment is Stripe's submission time, the same instant as completed_at.
      if (paid) await recordPaidMoment(env, lease, c, { homeId: id, subscriptionId: incomingSub, paidAt: c.completed_at ?? contractMadeAt,
        replacement: str(meta.replaces) !== null, notice: false }, now);
      const c2 = (await getConsent(env, c.id))!;
      const mail = buildConfirmationEmail(c2, await loadAcceptedDocs(env, c2), { portalOrigin: config.returnOrigin, legalPhone: traderIdentity(env).phone,
        paid, paidAt: paid ? c2.paid_at : null, renewsAt: paid ? await renewalDateOf(env, stripe, id, incomingSub) : null });
      await notify(env, deps, id, "confirmation", str(obj.id) ?? event.id,
        { consentId: c.id, emailSubject: mail.subject, emailText: mail.text, emailHtml: mail.html });
      // The completion has finished (acceptance, claim, confirmation): a parking left from an earlier attempt is released here, so the 24-hour
      // automatic rejection can never refund this order (Astra WP5-3 #1).
      await fencedBatch(env, lease, [
        q("UPDATE checkout_consents SET confirmation_sent_at=COALESCE(confirmation_sent_at,?),acceptance_parked_at=NULL WHERE id=?", now, c.id),
        q("UPDATE cloud_alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL", now, `alert:acceptance_missing:${c.id}`),
      ]);
      // Payment pending (a delayed method): the order stands, nothing is provisioned. async_payment_succeeded confirms the second moment.
      // Its first-purchase authorization is submitted: frozen (no new checkout authority) until the payment clears or fails.
      if (!paid) {
        await fencedBatch(env, lease, [bootstrapTransitionQ("submitted", ["open", "parked"], { homeId: id, consentId: c.id, now })]);
        return "unpaid_session";
      }
      // Moment 2 was recorded above: provisioning.
      await activate(env, lease, { eventId: event.id, homeId: id, created: event.created, paymentId: idOf(obj.invoice) ?? str(obj.id) ?? event.id, subscriptionId: incomingSub }, now);
      return null;
    }
    case "checkout.session.async_payment_succeeded": {
      if (obj.mode !== "subscription") return "ignored_mode";
      const { homeId: id } = await resolve(obj);
      const meta = rec(obj.metadata);
      const consent = await sessionConsent(env, obj, id);
      // An order refused on its own at completion (refuseUnboundOrder: no consent covers it, or its consent belongs to another session or
      // subscription): a payment that clears later is refunded in full, never held behind the other order's completion.
      const own = !consent || independentOf(consent, obj) ? await ownRefusalOf(env, idOf(obj.subscription)) : null;
      if (own) {
        // Refunded on the seller path persisted with the refusal.
        await refundStrandedPayment(env, { stripe: stripe(), flux, deps, now, lease }, { homeId: id, consent: null, kind: own.kind === "duplicate" ? "late_payment" : "rejected_consent",
          invoiceId: idOf(obj.invoice), amount: typeof obj.amount_total === "number" ? obj.amount_total : 0, subscriptionId: idOf(obj.subscription),
          path: own.path }, now);
        return "late_payment_refunded";
      }
      if (!consent) throw new Error("consent_missing");
      // The completion event comes first; this one is retried until it has been applied. An order refused before its completion was
      // attached (the renewal authorization did not cover it) has no completion and never gets one: it is decided below.
      if (consent.completed_at === null && consent.rejected_at === null) throw new Error("completion_pending");
      const incomingSub = idOf(obj.subscription);
      const refundCtx = (): RefundContext => ({ stripe: stripe(), flux, deps, now, lease });
      const paidCents = typeof obj.amount_total === "number" ? obj.amount_total : 0;
      // Every refund this late payment is owed is opened BEFORE any terminal exit or wait below (Astra WP5-1 #1, #2).
      // The guard turned this order away and the payment cleared after all: refunded in full.
      if (consent.rejected_at !== null) return refundRejectedPayment(env, deps, refundCtx(), consent, { homeId: id, subscriptionId: incomingSub, session: obj }, now);
      // A RECORDED obligation is decided before the completion state is read (Astra WP5-2 #2): withdrawn while the payment was pending
      // (decided "nothing charged"), or written off as a failed payment (tombstoned). The home's claim may since have moved to a NEWER checkout,
      // which would leave this event "pending" forever; the refund it is owed never waits on that.
      const withdrawn = await withdrawnUnpaid(env, id, incomingSub);
      // A plan a replacement took over (WP6) is judged exactly as its invoice.paid would be: the session's invoice, classified against the
      // frozen cutover boundary. A served period is not refunded, a period spanning the cutover only by its unused part, the frozen invoice
      // not here (the cutover refund covers it), and an unresolved boundary stays a retryable, alerted obligation. Never the full refund below.
      if (!withdrawn && await isReplacedSub(env, incomingSub)) {
        // int2-1: a paid session is never closed without its invoice judged. The id may arrive as a string or an expanded object; when the
        // event carries none, the session is read from Stripe itself (its invoice expanded). A failed read throws (the event is kept and
        // retried). A session Stripe still shows without an invoice stays pending: alerted, retried on the normal schedule, never acknowledged.
        const sessionId = str(obj.id);
        let sessionInvoice = idOf(obj.invoice);
        if (!sessionInvoice && sessionId) sessionInvoice = await stripe().checkoutSessionInvoice(sessionId);
        const alertId = `alert:replaced_session_invoice:${sessionId ?? event.id}`;
        if (!sessionInvoice) {
          await fencedRun(env, lease, "INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
            alertId, id, "checkout.replaced_session_invoice_missing", "high", JSON.stringify({ sessionId, subscriptionId: incomingSub, eventId: event.id }), now);
          throw new Error("replaced_session_invoice_missing");
        }
        const outcome = await refundLateReplacedPayment(env, deps, refundCtx(), config, await stripe().getInvoice(sessionInvoice), incomingSub!);
        // int3-2: closed after any successful classification, however the invoice arrived (event object, expanded id or a read from Stripe).
        await fencedRun(env, lease, "UPDATE cloud_alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL", now, alertId);
        return outcome ?? "rejected_subscription";
      }
      if (withdrawn || await isRejectedSub(env, incomingSub)) {
        await refundStrandedPayment(env, refundCtx(), { homeId: id, consent, kind: "late_payment", invoiceId: idOf(obj.invoice), amount: paidCents, subscriptionId: incomingSub }, now);
        return "late_payment_refunded";
      }
      const state = await completionState(env, id, consent, incomingSub);
      if (state === "rejected") return refundRejectedPayment(env, deps, refundCtx(), consent, { homeId: id, subscriptionId: incomingSub, session: obj }, now);
      if (state === "parked") throw new Error("acceptance_parked");
      // WP6: a replacement whose payment was pending never claimed the slot (ownership moves only on payment). Its completion has finished once
      // the confirmation was handed off; the cleared payment is then decided below, never left waiting.
      const replaces = str(meta.replaces);
      let live = await getSub(env, id);
      const replacementWaiting = replaces !== null && incomingSub !== null && consent.confirmation_sent_at !== null && live?.subscription_id !== incomingSub;
      // The completion has not finished (a crash before the guard, the claim, the acceptance or the confirmation): wait for it, never decide here.
      if (state === "pending" && !replacementWaiting) throw new Error("completion_pending");
      // The order lost the home's one-subscription claim (its unpaid duplicate refund decided nothing): the late payment is refunded in full.
      if (state === "lost") { await refundStrandedPayment(env, refundCtx(), { homeId: id, consent, kind: "late_payment", invoiceId: idOf(obj.invoice), amount: paidCents, subscriptionId: incomingSub }, now); return "late_payment_refunded"; }
      if (replaces && incomingSub && live?.subscription_id === replaces && live.status !== "disputed") {
        // A replacement's payment cleared: ownership moves now (paid_at), with cutover_at = this event's time. The old plan may have ended
        // meanwhile (the grace): the paid replacement is adopted all the same and service restored below (r1-1).
        await moveToReplacement(env, deps, { stripe: stripe(), flux, deps, now, lease }, config, { homeId: id, consent, oldSub: live, incomingSub, paidAt: event.created * 1000 });
        live = await getSub(env, id);
      } else if (replaces && incomingSub && live?.subscription_id === incomingSub) {
        await settleReplaced(env, { stripe: stripe(), flux, deps, now, lease }, replaces, (await getRefundOp(env, `cutover:${replaces}`)) ? `cutover:${replaces}` : null);
      } else if (replaces && incomingSub) {
        // The slot is no longer the replaced plan (taken by another contract, or the old plan disputed): the replacement cannot be adopted.
        // Its payment is never lost: refunded in full through the ledger and the new subscription cancelled (never foreign_subscription).
        return replacementUnrecoverable(env, { stripe: stripe(), flux, deps, now, lease }, consent, { homeId: id, incomingSub, session: obj, key: idOf(obj.invoice) ?? str(obj.id) ?? event.id, kept: live?.subscription_id ?? null });
      }
      if (!live || !incomingSub || live.subscription_id !== incomingSub) return "foreign_subscription";
      if (ENDED(live)) {
        // Astra INTEGRATED-3 #1: the subscription ended before its payment was processed: a deleted, unserved home's payment is journaled
        // (its refund obligation) BEFORE this terminal return. Nothing starts.
        await journalUnservedDeletedPayment(env, lease, { eventId: event.id, homeId: id, created: event.created, paymentId: idOf(obj.invoice) ?? str(obj.id) ?? event.id,
          paidCents: typeof obj.amount_total === "number" ? obj.amount_total : null });
        return "subscription_ended";
      }
      const paidAt = event.created * 1000;
      // The paid moment and its "Payment received" obligation in one batch (sent once, whichever payment event records the moment first).
      await recordPaidMoment(env, lease, consent, { homeId: id, subscriptionId: incomingSub, paidAt, replacement: str(meta.replaces) !== null,
        notice: { renewsAt: await renewalDateOf(env, stripe, id, incomingSub) } }, now);
      await fencedRun(env, lease, `UPDATE billing_subscriptions SET status=CASE WHEN ${RANK_SQL("status")}>=5 THEN status ELSE 'active' END,updated_at=? WHERE home_id=? AND subscription_id=?`, now, id, incomingSub);
      await activate(env, lease, { eventId: event.id, homeId: id, created: event.created, paymentId: idOf(obj.invoice) ?? str(obj.id) ?? event.id, subscriptionId: incomingSub }, now);
      // "Payment received" (the second moment), after "We got your order" (the first).
      // (A replacement's customer gets "your plan is switched" instead.)
      if (!replaces) await sendPaymentNotice(env, deps, id, consent.id);
      return null;
    }
    case "checkout.session.async_payment_failed": {
      if (obj.mode !== "subscription") return "ignored_mode";
      const { homeId: id } = await resolve(obj);
      const meta = rec(obj.metadata);
      const consent = await sessionConsent(env, obj, id);
      // An order refused and cancelled on its own at completion (refuseUnboundOrder).
      if ((!consent || independentOf(consent, obj)) && await refusedOnItsOwn(env, str(obj.subscription))) return "rejected_subscription";
      if (!consent) throw new Error("consent_missing");
      if (consent.completed_at === null && consent.rejected_at === null) throw new Error("completion_pending");
      const incomingSub = str(obj.subscription);
      // A payment that already cleared is never undone by a stale failure; an order the guard rejected is already cancelled. "Cleared" is the
      // verified payment state (paid_at, or this subscription's recorded first payment), never the local status: a subscription update may
      // report 'active' while a delayed payment is still pending (Astra WP5-1 #4).
      const live0 = await getSub(env, id);
      if (consent.paid_at !== null || (incomingSub !== null && live0?.subscription_id === incomingSub && live0.first_paid_at !== null)) return "already_paid";
      if (consent.rejected_at !== null || await isRejectedSub(env, incomingSub)) return "rejected_subscription";
      const state = await completionState(env, id, consent, incomingSub);
      // (a replacement waiting for its payment never claims the slot: its completion is finished once the confirmation was handed off; WP6)
      if (state === "pending" && !(str(meta.replaces) !== null && consent.confirmation_sent_at !== null)) throw new Error("completion_pending");
      if (state === "parked") throw new Error("acceptance_parked");
      const live = await getSub(env, id);
      const replaces = str(meta.replaces);
      if (replaces && live?.subscription_id === replaces) {
        // A replacement whose payment failed: the old plan is untouched (it still ends at its period end), the route stays.
        await replacementNotPaid(env, deps, { stripe: stripe(), flux, deps, now, lease }, consent, { homeId: id, oldSub: live, incomingSub, why: "async_payment_failed", key: str(obj.id) ?? event.id });
        return "replacement_payment_failed";
      }
      if (state === "lost" || !live || !incomingSub || live.subscription_id !== incomingSub) return "foreign_subscription";
      // The payment never cleared: no server, nothing owed. The subscription is cancelled at Stripe (confirmed) before it is marked cancelled
      // here, the checkout is released so the customer can start again, and the old plan of a replacement is untouched (WP6).
      await fence(env, lease);
      await cancelConfirmed(env, lease, stripe(), incomingSub, NO_PRORATION);
      const text = orderWords("paymentFailed", consent.checkout_language);
      await fencedBatch(env, lease, [
        q("UPDATE checkout_consents SET payment_failed_at=COALESCE(payment_failed_at,?) WHERE id=?", now, consent.id),
        bootstrapTransitionQ("closed", PRE_PAYMENT, { homeId: id, consentId: consent.id, now, reason: "payment_failed" }),
        q("INSERT INTO rejected_subscriptions (subscription_id,at,reason) VALUES (?,?,'async_payment_failed') ON CONFLICT DO NOTHING", incomingSub, now),
        // The cancellation Stripe confirmed is persisted whatever the local status says ('active' from an earlier update included): the order was
        // never paid, so the home is not subscribed and can check out again. Only a dispute keeps its own final state.
        q("UPDATE billing_subscriptions SET status='canceled',updated_at=?,ended_at=COALESCE(ended_at,?) WHERE home_id=? AND subscription_id=? AND status<>'disputed'", now, now, id, incomingSub),
        q("UPDATE open_checkouts SET state='failed',updated_at=? WHERE home_id=? AND (consent_id=? OR session_id=?)", now, id, consent.id, str(obj.id)),
        q("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
          `alert:asyncfail:${incomingSub}`, id, "checkout.async_payment_failed", "warning", JSON.stringify({ consentId: consent.id, subscriptionId: incomingSub }), now),
        recordNotice(id, "payment_cancelled", str(obj.id) ?? event.id, { emailSubject: orderWords("paymentFailedSubject", consent.checkout_language), emailText: text, emailHtml: htmlOf(text) }, now),
      ]);
      try { await notify(env, deps, id, "payment_cancelled", str(obj.id) ?? event.id, { emailSubject: orderWords("paymentFailedSubject", consent.checkout_language), emailText: text, emailHtml: htmlOf(text) }); }
      catch { /* recorded in the batch above; the sweep retries */ }
      return "async_payment_failed";
    }
    case "checkout.session.expired": {
      if (obj.mode !== "subscription") return "ignored_mode";
      const { homeId: id } = await resolve(obj);
      // The page expired unsubmitted (or we expired it): the home's checkout is free again. A completed order is never touched.
      await fencedRun(env, lease, "UPDATE open_checkouts SET state='expired',updated_at=? WHERE home_id=? AND session_id=? AND state='open'", now, id, str(obj.id));
      // The diagnostic tax preset receipt of this home's checkout is not kept past it (Astra TAXCOUNTRY-3 P3).
      await fencedRun(env, lease, "DELETE FROM cloud_ops_state WHERE key=?", taxPresetKey(id));
      // Astra JOURNEY-A-2 A6: the terminal evidence a failed home's retirement needs (b3-control CHECKOUT_MAY_SETTLE_SQL), on the consent.
      await recordSessionExpired(env, lease, { homeId: id, consentId: str(rec(obj.metadata).consent_id), sessionId: str(obj.id),
        issuanceId: str(rec(obj.metadata).issuance_id) }, now);
      // An unresolved saved attempt whose session this is ends with it (Astra STEPUP-EMAIL-8 #2).
      await settleCheckoutAttempt(env, lease, id, { id: str(obj.id), consentId: str(rec(obj.metadata).consent_id), expiresAtSeconds: typeof obj.expires_at === "number" ? obj.expires_at : null, completed: false });
      // The first-purchase authorization of this home, past issue_until, is abandoned only by THE reconciliation (purchase-bootstrap.ts): every
      // page of its customer's sessions terminal and no issuance unresolved, never this one session alone (Astra TRUSTCODE-2 P2-2). A listing
      // that fails leaves the row open; the reserve path reconciles it again.
      const bootRow = await env.DB.prepare("SELECT * FROM cloud_purchase_bootstraps WHERE home_id=? AND state='open'").bind(id).first<NonNullable<BootstrapGrant["row"]>>();
      if (bootRow) {
        try { await reconcileAbandonment(env, lease, bootRow, now, stripe()); }
        catch (e) { if (!(e instanceof StripeError)) throw e; }
      }
      // A replacement session that expired unpaid: nothing moved, the old plan is unchanged, and the customer is told how to try again (plan §1.3 step 4).
      const replaces = str(rec(obj.metadata).replaces);
      const expConsent = replaces && str(rec(obj.metadata).consent_id) ? await getConsent(env, str(rec(obj.metadata).consent_id)!) : null;
      if (replaces && expConsent && expConsent.home_id === id && expConsent.paid_at === null && expConsent.rejected_at === null) {
        const cur = await getSub(env, id);
        if (cur?.subscription_id === replaces) await replacementNotPaid(env, deps, { stripe: stripe(), flux, deps, now, lease }, expConsent,
          { homeId: id, oldSub: cur, incomingSub: null, why: "expired", key: str(obj.id) ?? event.id });
      }
      return null;
    }
    case "customer.updated": {
      const { homeId: id, sub } = await resolve(obj, { customer: str(obj.id) });
      // The live address, not the event's: an older event arriving late must not undo a newer address (Stripe is the order-independent truth).
      const live = str(obj.id) ? await stripe().getCustomer(str(obj.id)!) : null;
      // A cleared live address is "unknown" (no action), never a fallback to the event's stale copy (r1-4).
      return applyAddressChange(env, deps, { stripe: stripe(), flux, deps, now, lease }, { homeId: id, sub, country: live?.address?.country ?? null });
    }
    case "invoice.created": {
      // Backstop for a missed address event: a renewal invoice for a country the current path cannot cover. The same check, nothing more.
      const { homeId: id, sub } = await resolve(obj);
      const inv = invoiceView(obj);
      if (inv.billing_reason !== "subscription_cycle") return "not_a_renewal";
      if (!sub?.subscription_id || inv.subscription !== sub.subscription_id) return "foreign_subscription";
      // The LIVE evidence first, before anything is written or voided (r1-4): the invoice's current state and the customer's current address
      // (a draft invoice's address follows the customer until finalization). A cleared live country is unknown: nothing happens.
      const invoiceId = str(obj.id) ?? event.id;
      const st = stripe();
      const cur = await st.getInvoice(invoiceId);
      const customerId = idOf(obj.customer) ?? sub.customer_id ?? null;
      const liveCustomer = customerId ? await st.getCustomer(customerId) : null;
      const verdict = await applyAddressChange(env, deps, { stripe: st, flux, deps, now, lease }, { homeId: id, sub, country: liveCustomer?.address?.country ?? null });
      if (verdict !== "address_other_path" && verdict !== "address_uncovered") return verdict;
      // The path cannot cover this country: the invoice is held, voided, and the subscription ends now without proration (the period it would bill is not served).
      // A payment that races the void makes the void fail: the event stays retryable and the next attempt finds the invoice paid.
      if (cur.status === "draft" || cur.status === "open") {
        await fence(env, lease);
        await st.setInvoiceAutoAdvance(invoiceId, false, `addr-hold:${invoiceId}`);
        if (cur.status === "draft") await st.finalizeInvoice(invoiceId, `addr-fin:${invoiceId}`);
        await st.voidInvoice(invoiceId, `addr-void:${invoiceId}`);
      }
      // Already collected (r1-2): the period it bills is not served, so it is refunded in full, invoice-keyed, through the ledger. The obligation
      // is written BEFORE the cancellation and before the event is acknowledged.
      const refundOpId = cur.status === "paid" && cur.amount_paid > 0 ? `late_payment:${invoiceId}` : null;
      if (refundOpId) {
        const owner = await env.DB.prepare("SELECT owner_id FROM cloud_homes WHERE id=?").bind(id).first<{ owner_id: string }>();
        await fencedBatch(env, lease, [
          refundOpInsert({ id: refundOpId, kind: "late_payment", homeId: id, userId: owner?.owner_id ?? "", invoiceId, paidCents: cur.amount_paid, targetCents: cur.amount_paid,
            endPlan: false, subscriptionId: sub.subscription_id, inheritSubscription: false, paymentIntent: cur.payment_intent ?? null }, now),
          q("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
            `alert:renewal-paid-uncovered:${invoiceId}`, id, "checkout.renewal_uncovered_paid", "high", JSON.stringify({ invoiceId, opId: refundOpId, verdict }), now),
        ]);
      }
      await fence(env, lease);
      await cancelConfirmed(env, lease, st, sub.subscription_id, NO_PRORATION);
      await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
        .bind(`alert:renewal-uncovered:${invoiceId}`, id, "checkout.renewal_uncovered", "high", JSON.stringify({ invoiceId, status: cur.status, verdict }), now).run();
      if (refundOpId) await advanceRefundOp(env, { stripe: st, flux, deps, now, lease }, refundOpId);
      return `renewal_${verdict}`;
    }
    case "invoice.paid": {
      const { homeId: id, sub } = await resolve(obj);
      // Basil-shaped (or older) invoice, read through one normalizer: subscription from parent.subscription_details, the price from
      // pricing.price_details, the payment intent from invoice.payments (absent from the webhook copy: read from Stripe when needed).
      const inv = invoiceView(obj);
      const incomingSub = inv.subscription;
      const invoiceId = str(obj.id) ?? event.id;
      const ctx = (): RefundContext => ({ stripe: stripe(), flux, deps, now, lease });
      const paymentIntentOf = async () => inv.payment_intent ?? (await stripe().getInvoice(invoiceId)).payment_intent;
      // Withdrawn while the payment was pending (the withdrawal decided "nothing charged"): this late settlement is owed back in full, before
      // any exit below can finish the event (Astra WP5-1 #1).
      if (await withdrawnUnpaid(env, id, incomingSub ?? sub?.subscription_id ?? null)) {
        await refundStrandedPayment(env, ctx(), { homeId: id, consent: await consentOfSubscription(env, id, incomingSub ?? sub?.subscription_id ?? null), kind: "late_payment",
          invoiceId, amount: inv.amount_paid, subscriptionId: incomingSub ?? sub?.subscription_id ?? null }, now);
        return "late_payment_refunded";
      }
      // An invoice of another subscription (a duplicate checkout being refunded) never grants anything. A duplicate whose payment was still
      // pending when it lost the claim (its refund decided nothing) is refunded in full now.
      if (incomingSub && sub?.subscription_id && incomingSub !== sub.subscription_id) {
        // The first invoice of a REPLACEMENT may arrive before the event that moves ownership: it waits (retried), it is not dropped.
        if (str(inv.subscriptionMetadata.replaces) === sub.subscription_id && !await isRejectedSub(env, incomingSub)) throw new Error("replacement_pending");
        if (await env.DB.prepare("SELECT 1 AS x FROM refund_ops WHERE home_id=? AND kind='duplicate' AND cancel_subscription_id=?").bind(id, incomingSub).first()) {
          await refundStrandedPayment(env, ctx(), { homeId: id, consent: await consentOfSubscription(env, id, incomingSub), kind: "late_payment", invoiceId,
            amount: inv.amount_paid, subscriptionId: incomingSub }, now);
        }
        return "foreign_subscription";
      }
      if (await env.DB.prepare("SELECT 1 AS x FROM refund_ops WHERE invoice_id=? AND kind IN ('duplicate','price_mismatch','late_payment','mismatch','country_paused','rejected_consent')").bind(invoiceId).first()) return "refunded_invoice";
      // Astra JOURNEY-BCORE-3 #5-#8: a payment on a subscription with a promised end is RECORDED (one record per invoice, its full line
      // snapshot, no amount) the moment it settles, whenever that is (independent of the termination, also after the resolution).
      const promise = await promiseOf(env, incomingSub ?? sub?.subscription_id ?? null);
      if (promise) await recordInvoice(env, stripe(), promise, inv, now);
      // Every line, all pages: an invoice whose lines cannot be read completely is not classified (the event stays retryable).
      const lines = await completeLines(inv, invoiceId, stripe);
      // The plan an invoice pays for, never by line order: a renewal's own (non-proration) line; for a proration-only invoice (a mid-period
      // change invoiced at once, from any source: /v1/account/plan, the Dashboard) the DEBIT line of the new plan, and the CREDIT line names
      // the plan it moved from. A plan change recorded for this invoice pins the target price.
      // The operation this invoice belongs to, if it is one of ours (a plan change recorded with its invoice id).
      const bound = await env.DB.prepare("SELECT id,from_plan,to_plan FROM plan_changes WHERE invoice_id=? AND home_id=?").bind(invoiceId, id)
        .first<{ id: string; from_plan: string; to_plan: string }>();
      const cls = classifyInvoice(lines, config, sub?.subscription_id ?? incomingSub ?? null, bound ? config.priceByPlan[bound.to_plan as Plan] : null);
      if (cls === "ambiguous") throw new Error("plan_line_ambiguous");
      if (!cls) return "no_subscription_line"; // not one of our subscription prices (never grant or commission on it)
      const line = cls.kind === "renewal" ? cls.line : cls.debit;
      const plan = line ? planOf(config, line.price, sub?.plan ?? null) : (sub?.plan as Plan | undefined) ?? null;
      if (!plan) throw new Error("plan_unresolved");
      const amountPaid = inv.amount_paid;
      // The same gate as checkout.session.completed, on every activation path: a consent on record, the checkout completed, and the
      // durable confirmation handed off. Stripe may deliver this before the checkout event; it is retried until the gate opens.
      const consent = sub?.consent_id ? await getConsent(env, sub.consent_id) : null;
      if (!sub || !consent) throw new Error("consent_missing");
      if (consent.completed_at === null || consent.confirmation_sent_at === null) throw new Error("confirmation_pending");
      const subscriptionNow = incomingSub ?? sub.subscription_id;
      // The first payment's record and the order's paid moment (with its "Payment received" obligation) are ONE fenced batch: an interruption
      // can never leave one without the other (Astra WP5-1 #3).
      const firstHere = amountPaid > 0 && sub.first_invoice_id === null && cls.kind === "renewal" && line !== null;
      const momentDue = consent.paid_at === null && consent.rejected_at === null && cls.kind === "renewal";
      const extra: Q[] = firstHere ? [firstInvoiceStatement(id, { id: invoiceId, paidAt: event.created * 1000, cents: amountPaid, taxCents: inv.tax,
        periodStart: line!.period.start !== null ? line!.period.start * 1000 : null, periodEnd: line!.period.end !== null ? line!.period.end * 1000 : null,
        paymentIntent: await paymentIntentOf() })] : [];
      if (momentDue && (firstHere || sub.first_invoice_id === null || sub.first_invoice_id === invoiceId)) {
        // A repair of an earlier interrupted write fills the consent's clocks from the RECORDED first payment, whatever first_invoice_id says.
        // A REPLACEMENT subscription (its cutover on record) is paid at the frozen cutover boundary, with replacement semantics: its guarantee
        // runs from that payment, never from the inherited service start (WP6 r2-2; a cutover committed before r2 froze no paid moment).
        const cut = subscriptionNow ? await env.DB.prepare("SELECT cutover_at FROM replacement_cutovers WHERE home_id=? AND replacement_subscription_id=?")
          .bind(id, subscriptionNow).first<{ cutover_at: number }>() : null;
        const paidAt = cut ? cut.cutover_at : firstHere ? event.created * 1000 : sub.first_paid_at ?? event.created * 1000;
        const renewsAt = line?.period.end != null ? line.period.end * 1000 : await renewalDateOf(env, stripe, id, subscriptionNow);
        await recordPaidMoment(env, lease, consent, { homeId: id, subscriptionId: subscriptionNow, paidAt, replacement: cut !== null, notice: { renewsAt } }, now, extra);
      } else if (extra.length) {
        await fencedBatch(env, lease, extra);
      }
      if (firstHere) {
        // Who paid, as keyed hashes, for the one-per-person 7-day offer (refund-identity.ts). Best effort here: a Stripe hiccup never holds
        // up activation, and a payment whose keys are missing is captured when a refund is asked for (the offer fails closed until then).
        try {
          const first = await env.DB.prepare("SELECT s.first_invoice_id AS i,s.first_paid_at AS at,s.first_payment_intent AS pi,h.owner_id AS u FROM billing_subscriptions s JOIN cloud_homes h ON h.id=s.home_id WHERE s.home_id=?")
            .bind(id).first<{ i: string | null; at: number | null; pi: string | null; u: string }>();
          if (first?.i && first.at !== null) await captureRefundIdentity(env, stripe(), { homeId: id, userId: first.u, invoiceId: first.i, paidAt: first.at, paymentIntent: first.pi }, now);
        } catch (e) { console.warn("refund_identity_capture_deferred", e instanceof Error ? e.message : "error"); }
      }
      await sendPaymentNotice(env, deps, id, consent.id);
      // A withdrawal (or refund) already ended this plan: the late invoice settles the refund amount, it does not start anything.
      if (await env.DB.prepare("SELECT 1 AS x FROM refund_ops WHERE home_id=? AND end_plan=1 AND subscription_id=?").bind(id, incomingSub ?? sub.subscription_id).first()) {
        // Astra INTEGRATED-4 #1: that refund covers ITS invoice, not this one. A deleted, never-served home's later payment is judged on its
        // own invoice (invoiceRefundCoverage) and journaled before this terminal return; a served home's stays record-only.
        if (amountPaid > 0) await journalUnservedDeletedPayment(env, lease, { eventId: event.id, homeId: id, created: event.created, paymentId: invoiceId, paidCents: amountPaid });
        await resumeRefundOpsFor(env, { stripe: stripe(), flux, deps, now, lease }, id);
        return "plan_ended";
      }
      // A retried event re-reads the subscription now (not the copy from the first attempt). One that ended meanwhile keeps the payment
      // facts recorded above, for refunds, and starts nothing: no activation, no credits, no status change.
      const live = await getSub(env, id);
      if (!live || live.subscription_id !== subscriptionNow || ENDED(live)) {
        // Astra INTEGRATED-3 #1: the payment facts above are records only; a deleted, unserved home's payment on this (ended) subscription is
        // also journaled into the payment inbox here, so its refund obligation is never lost.
        if (live?.subscription_id === subscriptionNow && cls.kind === "renewal" && amountPaid > 0) {
          await journalUnservedDeletedPayment(env, lease, { eventId: event.id, homeId: id, created: event.created, paymentId: invoiceId, paidCents: amountPaid });
        }
        return "subscription_ended";
      }
      if (cls.kind === "adjustment") {
        // An adjustment (a mid-period change invoiced on its own, from any source) never grants a month and never moves the period. Only a
        // VERIFIED upgrade gets its delta: our own recorded plan change, to a higher plan, whose debit line is the new plan's price. Anything
        // else (a Dashboard change, a manually invoiced proration, a quantity change) grants nothing automatically and is an ops alert.
        const verified = bound !== null && cls.debit !== null && amountPaid > 0 && PLAN_RANK[bound.to_plan as Plan] > PLAN_RANK[bound.from_plan as Plan]
          && cls.debit.price === config.priceByPlan[bound.to_plan as Plan] && cls.debit.period.start !== null && cls.debit.period.end !== null;
        if (bound) await upgradeInvoiceOutcome(env, lease, id, invoiceId, null, true, now);
        if (!verified) {
          await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
            .bind(`adjustment:${invoiceId}`, id, "billing.unverified_adjustment", "high", JSON.stringify({ invoiceId, amountPaid, bound: bound?.id ?? null,
              debit: cls.debit?.price ?? null, credit: cls.credit, planChangeEnabled: planChangeEnabled(env) }), now).run();
          return "adjustment_unverified";
        }
        await fence(env, lease);
        if (ENDED(await getSub(env, id))) return "subscription_ended";
        await grantOnce(env, lease, flux, { homeId: id, plan: bound!.to_plan, invoiceId, periodStart: cls.debit!.period.start! * 1000,
          periodEnd: cls.debit!.period.end! * 1000, kind: "upgrade_delta", previousPlan: bound!.from_plan }, subscriptionNow, now);
        return "upgrade_delta";
      }
      // Only an initial or renewal obligation activates service; an adjustment never does (nor restores a home in payment trouble).
      await activate(env, lease, { eventId: event.id, homeId: id, created: event.created, paymentId: invoiceId, subscriptionId: subscriptionNow }, now);
      const period = cls.line.period;
      // Entitlement follows the verified renewal, not the cash: a paid renewal settled entirely by customer credit (amount_paid 0) still
      // grants its month and moves the period. The $0 invoice of a delayed start's trial was already turned away above, and an adjustment
      // never reaches here. Cash-receipt accounting (recordFirstInvoice, refunds) keeps its own amount_paid > 0 gate.
      if (period.start !== null && period.end !== null && (amountPaid > 0 || inv.status === "paid")) {
        await fence(env, lease);
        if (ENDED(await getSub(env, id))) return "subscription_ended";
        // Written only if this worker still holds the lease AND the subscription is still the one this invoice belongs to: a grant that
        // outlived its lease (a subscription deleted meanwhile) can never turn the home back to active. Recorded in the same batch as the grant.
        await grantOnce(env, lease, flux, { homeId: id, plan, invoiceId, periodStart: period.start * 1000, periodEnd: period.end * 1000 }, subscriptionNow, now,
          [q("UPDATE billing_subscriptions SET current_period_start=?,current_period_end=?,status='active',updated_at=? WHERE home_id=? AND subscription_id=? AND status NOT IN ('canceled','disputed')",
            period.start * 1000, period.end * 1000, now, id, subscriptionNow)]);
        await propagatePlanOnInvoice(env, lease, flux, id, plan, invoiceId, idOf(obj.customer) ?? undefined);
      }
      return null;
    }
    case "invoice.payment_failed": {
      const { homeId: id, sub } = await resolve(obj);
      if (await foreignSub(env, invoiceView(obj).subscription, sub)) return "foreign_subscription";
      // An upgrade's own invoice (pending_if_incomplete): its decline fails the plan change only. The paid subscription, its status and the
      // home's entitlement are untouched (members-api.ts).
      const upgrade = await upgradeInvoiceOutcome(env, lease, id, str(obj.id), null, false, now);
      if (upgrade) return upgrade;
      // Classified BEFORE any lifecycle change, from its complete lines (never billing_reason): only a failed initial or renewal obligation
      // makes the subscription past_due and starts the payment-problem grace. A failed adjustment (a separate proration or other invoice)
      // never touches the paid subscription: ops are told.
      const failedId = str(obj.id) ?? event.id;
      const fcls = classifyInvoice(await completeLines(invoiceView(obj), failedId, stripe), config, sub?.subscription_id ?? null, null);
      if (fcls === "ambiguous") throw new Error("plan_line_ambiguous");
      if (fcls === null || fcls.kind === "adjustment") {
        await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
          .bind(`adjfail:${failedId}`, id, "billing.adjustment_payment_failed", "warning", JSON.stringify({ invoiceId: failedId }), now).run();
        return "adjustment_payment_failed";
      }
      await submitPayment(env, lease, { eventId: event.id, homeId: id, created: event.created, status: "payment_problem", paymentId: str(obj.id) ?? event.id,
        subscriptionId: invoiceView(obj).subscription ?? sub?.subscription_id ?? null });
      await fencedRun(env, lease, "UPDATE billing_subscriptions SET status='past_due',updated_at=? WHERE home_id=? AND status NOT IN ('canceled','disputed')", now, id);
      await notify(env, deps, id, "payment_failed", str(obj.id) ?? event.id, { graceDays: 3, nextAttempt: obj.next_payment_attempt ?? "none" });
      return null;
    }
    case "customer.subscription.updated": {
      const { homeId: id, sub } = await resolve(obj);
      if (await foreignSub(env, str(obj.id), sub)) return "foreign_subscription";
      // Only checkout completion (with its atomic claim) makes a subscription the home's; an update arriving first changes nothing.
      if (!sub?.subscription_id) return "subscription_not_retained";
      const item = rec((Array.isArray(rec(obj.items).data) ? rec(obj.items).data as Obj[] : [])[0]);
      const priceId = str(rec(item.price).id);
      const plan = planOf(config, priceId, sub?.plan ?? null);
      if (!plan) throw new Error("plan_unresolved");
      let cancelAtEnd = obj.cancel_at_period_end === true;
      let cancelReason = str(rec(obj.cancellation_details).reason);
      // Stripe's cancel_at (a public cancellation sets it and leaves cancel_at_period_end false). Stored as is, in ms; never cleared while an
      // open public cancellation that Stripe confirmed exists (that would un-cancel on the account page): ops are alerted to the drift instead.
      // cancel_at_period_end and the in-app path's revisions are left exactly as they were.
      const rawCancelAt = obj.cancel_at;
      let stripeCancelAt = typeof rawCancelAt === "number" && rawCancelAt > 0 ? rawCancelAt * 1000 : null;
      // Stripe does not deliver events in order: an update whose cancel_at differs from the one this row holds may be OLDER than the one
      // applied last (the original cancellation's event arriving after Keep my plan's clear would bring back "won't renew" while Stripe
      // renews). The subscription as Stripe has it NOW, read inside this lease, decides; the open-intent drift protection below still applies.
      // Astra JOURNEY-B-1 #11 / JOURNEY-B-2 #5: BOTH cancellation fields are reconciled this way, and no local timestamp is an ordering
      // authority (a Keep's kept_at and Stripe's event `created` come from different clocks). Whenever the event's cancel_at_period_end or
      // cancel_at differs from the row, the live subscription decides, so a stale event can neither restore cancel_at_period_end nor send a
      // "cancel scheduled" notice for a plan Stripe renews.
      if (stripeCancelAt !== (sub.cancel_at ?? null) || cancelAtEnd !== (sub.cancel_at_period_end === 1)) {
        const live = await stripe().getSubscription(sub.subscription_id) as Awaited<ReturnType<StripeClient["getSubscription"]>> & { cancellation_details?: unknown };
        stripeCancelAt = typeof live.cancel_at === "number" && live.cancel_at > 0 ? live.cancel_at * 1000 : null;
        cancelAtEnd = live.cancel_at_period_end === true;
        if (live.cancellation_details !== undefined) cancelReason = str(rec(live.cancellation_details).reason);
      }
      // The customer's own cancellation, made at Stripe, becomes the in-app intent only while the home's intent is SETTLED with Stripe (no
      // revision and no mutation of ours still on the way). While one is (a Keep Stripe has not confirmed yet), Stripe's cancel_at_period_end
      // is our own earlier state, not a new decision: the intent is never restored from it, so the sweep never re-cancels a kept plan.
      const intentSettled = sub.cancel_intent_rev === sub.cancel_synced_rev && (await env.DB.prepare(
        "SELECT 1 AS x FROM sub_mutations WHERE home_id=? AND subscription_id=? AND state='pending' LIMIT 1").bind(id, sub.subscription_id).first()) === null;
      if (cancelAtEnd && cancelReason === "cancellation_requested" && intentSettled) {
        await fencedRun(env, lease, `UPDATE billing_subscriptions SET customer_cancel_at=COALESCE(customer_cancel_at,?) WHERE home_id=?
          AND cancel_intent_rev=cancel_synced_rev`, now, id);
      }
      const changed = sub !== null && sub.plan !== plan;
      // Basil: the period is on the subscription item (subscriptionPeriod reads both shapes).
      const sp = subscriptionPeriod(obj);
      const periodStart = sp.start !== null ? sp.start * 1000 : sub?.current_period_start ?? null;
      const periodEnd = sp.end !== null ? sp.end * 1000 : sub?.current_period_end ?? null;
      // The plan move, the "Flux must learn it" mark and the follow-up work (members-api.ts: the resize an upgrade needs, or the alert for a
      // downgrade) are ONE batch: a crash or a failing Flux call can never leave the plan moved and that work lost.
      await fencedBatch(env, lease, [
        q(`UPDATE billing_subscriptions SET plan=?,previous_plan=CASE WHEN ? THEN plan ELSE previous_plan END,price_id=?,
        ${FORWARD_STATUS},${FORWARD_ENDED_AT},
        ${STRIPE_ENDED_ON_STATUS},
        cancel_verify_dirty=CASE WHEN cancel_terminal_sub=subscription_id AND ?=0 THEN 1 ELSE cancel_verify_dirty END,
        flux_plan_dirty=CASE WHEN ? THEN 1 ELSE flux_plan_dirty END,
        cancel_at_period_end=?,cancel_at=CASE WHEN ? IS NOT NULL THEN ? WHEN EXISTS (${OPEN_PUBLIC_CANCEL}) THEN cancel_at ELSE NULL END,
        current_period_start=?,current_period_end=?,updated_at=? WHERE home_id=? AND subscription_id=?`,
        plan, changed ? 1 : 0, priceId, statusRank(str(obj.status) ?? "active"), str(obj.status) ?? "active",
        statusRank(str(obj.status) ?? "active"), str(obj.status) ?? "active", now, str(obj.status) ?? "active", cancelAtEnd ? 1 : 0, changed ? 1 : 0, cancelAtEnd ? 1 : 0,
        stripeCancelAt, stripeCancelAt, sub.subscription_id, periodStart, periodEnd, now, id, sub.subscription_id),
        ...(changed ? planMovedStatements(id, sub.subscription_id, sub.plan, plan, now, planChangeEnabled(env)) : []),
      ]);
      // Flux is told until it has taken the plan: a redelivery (or a later event) retries it even though the plan no longer "changes".
      // Astra JOURNEY-B-1 #14: a move DOWN (a downgrade at the renewal) changes Flux's cap only on the verified renewal invoice of the new plan
      // (invoice.paid, propagatePlanOnInvoice): here it stays dirty. An upgrade reaches this event only after its own invoice was paid
      // (pending_if_incomplete), so it is told now.
      const moved = await env.DB.prepare("SELECT plan,previous_plan,flux_plan_dirty FROM billing_subscriptions WHERE home_id=?").bind(id)
        .first<{ plan: string; previous_plan: string | null; flux_plan_dirty: number }>();
      const movedDown = moved !== null && moved.previous_plan !== null && (PLAN_RANK[moved.plan as Plan] ?? 0) < (PLAN_RANK[moved.previous_plan as Plan] ?? 0);
      if (moved?.flux_plan_dirty === 1 && !movedDown) {
        await tellFluxPlan(env, lease, flux, id, moved.plan, idOf(obj.customer) ?? undefined);
      } else if (moved?.flux_plan_dirty === 1) {
        // Astra JOURNEY-B-2 #7: the renewal invoice of the cheaper plan may have been paid (and its evidence persisted) before this event.
        await propagatePlanFromEvidence(env, lease, flux, id, idOf(obj.customer) ?? undefined);
      }
      if (stripeCancelAt === null) {
        await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) SELECT ?,?,'cancellation.stripe_drift','high',?,?
          WHERE EXISTS (${OPEN_PUBLIC_CANCEL}) ON CONFLICT DO NOTHING`)
          .bind(`cxdrift:${event.id}`, id, JSON.stringify({ subscriptionId: sub.subscription_id, eventId: event.id }), now, sub.subscription_id).run();
      }
      if (cancelAtEnd && sub && sub.cancel_at_period_end === 0 && intentSettled) {
        const late = cancelledNotice(env, periodEnd, await cancellationReference(env, id, sub.subscription_id), await homeIsDeleting(env, id),
          `${sub.subscription_id}:${sub.customer_cancel_at ?? "stripe"}`);
        await notify(env, deps, id, "cancel_scheduled", late.key, late.data);
      }
      return null;
    }
    case "customer.subscription.deleted": {
      const { homeId: id, sub } = await resolve(obj);
      // Only the retained subscription's own end changes this home. A duplicate (or repriced) subscription's cancellation belongs to its
      // refund operation and never touches the paying one.
      if (await foreignSub(env, str(obj.id), sub)) return "foreign_subscription";
      await submitPayment(env, lease, { eventId: event.id, homeId: id, created: event.created, status: "canceled", paymentId: str(obj.id) ?? event.id,
        subscriptionId: str(obj.id) ?? sub?.subscription_id ?? null });
      await fencedRun(env, lease, "UPDATE billing_subscriptions SET status='canceled',updated_at=?,ended_at=COALESCE(ended_at,?) WHERE home_id=? AND status<>'disputed'", now, now, id);
      // Astra INTEGRATED-2 #2/#5: Stripe's own word that THIS subscription ended: the checkpoint (a disputed row included).
      if (str(obj.id)) await fencedBatch(env, lease, [stripeEndedQ(str(obj.id)!)]);
      await notify(env, deps, id, "subscription_ended", str(obj.id) ?? event.id, { dataKeptDays: 30 });
      return null;
    }
    case "charge.refunded": {
      const { homeId: id, sub } = await resolve(obj);
      // A refund made by the ledger (either refund route, a region hold or a duplicate) is ended and announced by its own operation, once.
      const refundOps = (Array.isArray(rec(obj.refunds).data) ? rec(obj.refunds).data as Obj[] : []).map((r) => str(rec(r.metadata).op_id)).filter(Boolean);
      const pi = idOf(obj.payment_intent);
      // The contract the refunded payment belongs to (its invoice, and that invoice's subscription), resolved and persisted with the refund:
      // never simply the home's current subscription, which may be a replacement contract.
      const owner = await paymentOwner(env, stripe(), sub, pi, idOf(obj.invoice));
      // Refunds NOT made by our ledger (no op_id): Link refunds a Managed Payments sale on its own within 60 days, and a refund can be made
      // from the Dashboard. Each is recorded in the ledger (kind 'external', decided and done) so every later decision on the same payment
      // (first-month refund, withdrawal) counts it and never pays it again; ops is told.
      // Basil-era charges may name only the invoice: the payment is then the invoice's.
      const payment = pi ?? (owner.invoiceId ? (await stripe().getInvoice(owner.invoiceId)).payment_intent : null);
      const external = payment ? await recordExternalRefunds(env, lease, stripe(), { homeId: id, userId: (await getHome(env, id))?.owner_id ?? "", paymentIntent: payment,
        invoiceId: owner.invoiceId, subscriptionId: owner.subscriptionId }, now) : 0;
      // Astra JOURNEY-A-6 #1/#4: EVERY refund of a payment (the retained contract's, a superseded one's, ours or not) goes under payment-level
      // coverage reconciliation (reconcilePaymentCoverage): the credit of that payment's grants follows Stripe's CURRENT listing as a versioned
      // target (succeeded refunds only, proportional on a partial, restored when a refund fails later), never the event's "refunded" flag, and
      // never the replacement's grants, consumed credit or prepaid funds. The credit adjustment is separate from service cancellation.
      const ledger = !external && (refundOps.length > 0 || (!!payment && !!await env.DB.prepare("SELECT 1 AS x FROM refund_ops WHERE payment_intent=? AND kind<>'external'").bind(payment).first()));
      const retained = !!owner.subscriptionId && !!sub?.subscription_id && owner.subscriptionId === sub.subscription_id;
      let ended = false;
      if (payment) {
        const chargeAmount = obj.amount;
        const paidCents = typeof chargeAmount === "number" && chargeAmount > 0 ? chargeAmount : owner.invoiceId ? (await stripe().getInvoice(owner.invoiceId)).amount_paid : null;
        // Only a FULL refund of the RETAINED contract's payment (not one our ledger made: its operation ends its own plan) may end service, and
        // only once the listing shows the whole payment returned: a stale "refunded" with a failed refund cancels nothing, stops nothing.
        // Astra JOURNEY-A-7 #2: an external refund already on record for the payment (a redelivery after its first pass recorded it) still
        // reports the obligation; whether a ledger operation discharges it is decided by endOnFullCoverage (only one that ends this plan).
        const externalOnRecord = refundOps.length === 0 && ledger
          && !!await env.DB.prepare("SELECT 1 AS x FROM refund_ops WHERE payment_intent=? AND home_id=? AND kind='external'").bind(payment, id).first();
        await fencedBatch(env, lease, [coverageWatchQ({ homeId: id, paymentIntent: payment, invoiceId: owner.invoiceId, subscriptionId: owner.subscriptionId,
          paidCents, endPlan: retained && obj.refunded === true && (!ledger || externalOnRecord) }, now)]);
        ended = await reconcilePaymentCoverage(env, lease, { stripe: stripe(), flux, deps, now, eventCreated: event.created }, id, payment);
      }
      if (ledger) return "ledger_refund";
      if (obj.refunded !== true) return "partial_refund_recorded"; // only a full refund ends service
      // Only a full refund of the RETAINED contract's payment ends service. A refund of an earlier contract's payment (one a replacement
      // checkout has since taken over from) affects only that payment's ledger and credits; the replacement keeps running.
      if (!retained) {
        await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
          .bind(`alert:historical_refund:${str(obj.id) ?? event.id}`, id, "refund.historical_payment", "warning",
            JSON.stringify({ chargeId: str(obj.id), paymentIntent: pi, invoiceId: owner.invoiceId, subscriptionId: owner.subscriptionId, retained: sub?.subscription_id ?? null }), now).run();
        return "historical_refund_recorded";
      }
      if (!payment) {
        // No payment to verify the refund against: nothing is cancelled on the event's word; ops is told.
        await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
          .bind(`alert:refund_coverage:${id}:${str(obj.id) ?? event.id}`, id, "refund.coverage_pending", "warning",
            JSON.stringify({ chargeId: str(obj.id), invoiceId: owner.invoiceId, reason: "payment_unresolved" }), now).run();
        return "refund_coverage_pending";
      }
      return ended ? null : "refund_coverage_pending";
    }
    case "charge.dispute.created": case "charge.dispute.closed": case "charge.dispute.funds_withdrawn": case "charge.dispute.funds_reinstated": {
      const chargeId = idOf(obj.charge);
      if (!chargeId) throw new Error("charge_unresolved");
      const charge0 = await stripe().getCharge(chargeId);
      const { homeId: id, sub } = await resolve({}, { customer: charge0.customer });
      // Basil: the charge no longer names its invoice; it is found through the payment's InvoicePayment. The contract the disputed payment
      // belongs to (its invoice's subscription) is kept: never simply the home's current subscription (Astra TAXCOUNTRY-7 P1-b).
      const owner = await paymentOwner(env, stripe(), sub, charge0.payment_intent, charge0.invoice);
      // INTEGRATED-12: the invoice the event's hold attributed (our records or Stripe's InvoicePayment) when the owner lookup names none, so
      // the dispute row keeps the invoice-wide scope the hold had.
      const heldInvoice = owner.invoiceId ? null : (await env.DB.prepare("SELECT invoice_id FROM dispute_holds WHERE event_id=? AND invoice_id IS NOT NULL")
        .bind(event.id).first<{ invoice_id: string }>())?.invoice_id ?? null;
      const charge = { ...charge0, invoice: owner.invoiceId ?? heldInvoice };
      const disputeId = str(obj.id) ?? event.id;
      // THE DISPUTE POLICY (Astra TAXCOUNTRY-7 P1-b; the owner's choice: SCOPED). A dispute affects only the contract its payment belongs to:
      //  - the payment is recorded as disputed (payment_disputes) and its reimbursements are HELD (legal-refunds.ts intend: no new refund or
      //    credit note of a disputed payment, since the bank is already reversing it; never paying the same money back twice);
      //  - the disputed payment's own contract is ended only when it is the home's CURRENT contract (disputed, service stopped, its line closed
      //    in the lifecycle, the subscription ended at Stripe);
      //  - a replaced contract's dispute (or one whose contract cannot be attributed) never touches the current paid service: it is recorded,
      //    held and put in front of ops. Account-wide closure for abuse is NOT automatic: it would need the current contract refunded first
      //    (money rule: a paid service is never cancelled without refund), so it stays an operator decision through the refund routes.
      const current = !!owner.subscriptionId && owner.subscriptionId === sub?.subscription_id;
      const scope = current ? "current" : owner.subscriptionId ? "historical" : "unattributed";
      // Round 9b: the charge's own currency is kept with the row (settleDispute compares the dispute's against it, never converting).
      const chargeCurrency = str((charge0 as unknown as Obj).currency)?.toLowerCase() ?? null;
      await fencedBatch(env, lease, [q(`INSERT INTO payment_disputes (dispute_id,home_id,charge_id,payment_intent,invoice_id,subscription_id,scope,reason,opened_at,
        amount_cents,currency,status,updated_at,charge_currency) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dispute_id) DO UPDATE SET
        charge_currency=COALESCE(payment_disputes.charge_currency,excluded.charge_currency)`, disputeId, id, chargeId, charge0.payment_intent ?? null,
        charge.invoice ?? null, owner.subscriptionId, scope, str(obj.reason) ?? null, now, cents(obj.amount), str(obj.currency)?.toLowerCase() ?? null, str(obj.status) ?? null, now,
        chargeCurrency),
        // INTEGRATED-11 P1-1: recording the dispute NEVER releases the event's hold (only the event's own committed checkpoint does, after
        // settleDispute below succeeded); it only widens the hold to the payment's invoice (P1-3), in case the settlement fails.
        q("UPDATE dispute_holds SET invoice_id=? WHERE event_id=? AND invoice_id IS NULL AND attributed_at IS NULL AND ? IS NOT NULL", charge.invoice ?? null, event.id, charge.invoice ?? null)]);
      // Round 8b: Stripe's closure and fund movements settle the row (whatever order they arrive in; one arriving before the dispute's own
      // creation event opened it above, so nothing is ever lost to ordering).
      if (event.type !== "charge.dispute.created") return settleDispute(env, lease, stripe(), event, disputeId, now);
      // The creation event handled after Stripe already closed the dispute in our favour (its closure came first): nothing to stop.
      const settled = await env.DB.prepare("SELECT closed_at,outcome FROM payment_disputes WHERE dispute_id=?").bind(disputeId).first<{ closed_at: number | null; outcome: string | null }>();
      if (settled?.closed_at != null && settled.outcome !== "lost") return `dispute_already_closed_${settled.outcome ?? "unknown"}`;
      if (charge.invoice && await env.DB.prepare("SELECT 1 AS x FROM refund_ops WHERE invoice_id=? AND kind IN ('duplicate','price_mismatch','late_payment','mismatch','country_paused','rejected_consent')").bind(charge.invoice).first()) {
        // A dispute on a payment the ledger already refunds in full: ops looks at it; the paying subscription is untouched.
        await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
          .bind(crypto.randomUUID(), id, "dispute.refunded_payment", "high", JSON.stringify({ chargeId, invoiceId: charge.invoice }), now).run();
        return "dispute_on_refunded_payment";
      }
      if (!current) {
        await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
          .bind(`alert:dispute:${disputeId}`, id, scope === "historical" ? "dispute.historical_payment" : "dispute.unattributed_payment", "high",
            JSON.stringify({ disputeId, chargeId, paymentIntent: charge0.payment_intent ?? null, invoiceId: charge.invoice ?? null, subscriptionId: owner.subscriptionId,
              current: sub?.subscription_id ?? null, reason: str(obj.reason) ?? "unknown" }), now).run();
        return scope === "historical" ? "historical_dispute_recorded" : "dispute_unattributed";
      }
      // Round 9b (Astra TAXCOUNTRY-8 P1-5): a dispute affects only the disputed payment's obligations. When a LATER period of the same contract
      // is already paid (month two paid, month one disputed), that paid service keeps serving: nothing is cancelled or stopped (a cancellation
      // would need month two refunded first: a paid service is never cancelled without refund). The dispute is recorded and its payment's
      // reimbursements held, as above; ops is told.
      const later = charge.invoice ? await laterPaidPeriod(env, id, owner.subscriptionId!, charge.invoice) : null;
      if (later) {
        await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
          .bind(`alert:dispute:${disputeId}`, id, "dispute.earlier_period", "high", JSON.stringify({ disputeId, chargeId, paymentIntent: charge0.payment_intent ?? null,
            invoiceId: charge.invoice ?? null, subscriptionId: owner.subscriptionId, paidLaterInvoice: later, reason: str(obj.reason) ?? "unknown" }), now).run();
        return "earlier_period_dispute_recorded";
      }
      // Astra JOURNEY-BCORE-7 #3: disputed, the service stop and the notice first; the subscription's end last (retried alone when parked).
      await submitPayment(env, lease, { eventId: event.id, homeId: id, created: event.created, status: "canceled", paymentId: disputeId, subscriptionId: owner.subscriptionId });
      await fencedRun(env, lease, "UPDATE billing_subscriptions SET status='disputed',updated_at=? WHERE home_id=? AND subscription_id=?", now, id, owner.subscriptionId);
      await fence(env, lease);
      // Round 9b: an OPEN dispute ends service only and HOLDS (keepGrants): no credit is reversed while the bank decides. A LOST dispute
      // (money returned) records the invoice's owed credit reversal (settleDispute, disputeCreditObligation); a won one never reversed anything.
      await flux.stopForBilling(env, id, undefined, { ...(charge.invoice ? { invoiceId: charge.invoice } : {}), keepGrants: true, line: owner.subscriptionId });
      await notify(env, deps, id, "dispute_opened", disputeId, { reason: str(obj.reason) ?? "unknown" });
      await endSubscription(env, lease, stripe(), sub);
      return null;
    }
    case "refund.updated": case "refund.failed": case "charge.refund.updated": {
      // Astra JOURNEY-A-6 #1/#4: any refund of a payment under coverage reconciliation re-reads that payment first: a refund that failed after
      // it succeeded lowers the targets (the router restores credits), one that succeeded raises them (and may end a retained contract).
      // Astra JOURNEY-A-8 #3: the ledger is updated FIRST (applyRefundEvent clears an operation's cached success when its refund failed or
      // needs action), THEN the payment's coverage is reconciled from Stripe's current listing and the targets dispatched: nothing is ever
      // reversed on a success that no longer stands. A failure of the ledger step still lets the coverage pass run, then propagates.
      const pi = idOf(obj.payment_intent);
      let result: Awaited<ReturnType<typeof applyRefundEvent>> | undefined; let failure: unknown = null;
      // A ledger refund is complete only once Stripe says it succeeded; a later failure reopens it.
      try {
        result = await applyRefundEvent(env, { stripe: stripe(), flux, deps, now, lease }, { id: str(obj.id), status: str(obj.status), opId: str(rec(obj.metadata).op_id),
          submission: str(rec(obj.metadata).submission), paymentIntent: str(obj.payment_intent) });
      } catch (e) { if (e instanceof LeaseLost) throw e; failure = e; }
      if (pi) await reconcilePaymentCoverage(env, lease, { stripe: stripe(), flux, deps, now, eventCreated: event.created }, lease.homeId, pi);
      if (failure !== null) throw failure;
      return result!;
    }
    default:
      return "ignored_type";
  }
}

/** An event about a subscription other than the one this home keeps (a duplicate or repriced checkout): never applied to the home. */
async function foreignSub(env: Env, incoming: string | null, sub: SubRow | null): Promise<boolean> {
  if (!incoming) return false;
  if (sub?.subscription_id) return incoming !== sub.subscription_id;
  // No retained subscription yet: one the ledger is cancelling (a duplicate or repriced checkout) is not this home's.
  return (await env.DB.prepare("SELECT 1 AS x FROM refund_ops WHERE cancel_subscription_id=?").bind(incoming).first()) !== null;
}

/** Stops further billing after a refund or dispute. A subscription that is already gone is fine (cancelConfirmed reads it back as ended).
 *  Astra JOURNEY-BCORE-7 #3: the caller has already written the local terminal state (canceled / disputed) before this, so the local status
 *  says nothing about Stripe: the end is always asked for (its retry after a parked attempt included). */
export async function endSubscription(env: Env, lease: HomeLease, stripe: StripeClient, sub: SubRow | null) {
  if (!sub?.subscription_id) return;
  await fence(env, lease);
  await cancelConfirmed(env, lease, stripe, sub.subscription_id);
}

/** Cancels a Stripe subscription and returns only once Stripe confirms it: status "canceled" (or "incomplete_expired"), or the subscription
 *  does not exist (404). Any other answer, a 400 included, throws so the caller keeps its checkpoint open and retries. */
export const NO_PRORATION = { prorate: false, invoiceNow: false } as const;
/** Astra JOURNEY-BCORE-6 #1: through the gateway (writeSubscription), under the caller's lease. A PARKED subscription gets no DELETE: this throws
 *  SubscriptionParked, so the caller's checkpoint (a refund operation, a stored Stripe event) stays open and runs again once the hourly
 *  inspection clears the parking (unparkQs). */
/** Astra INTEGRATED-2 #2/#5: Stripe's confirmation (the DELETE's answer, the read-back, a 404) sets THE Stripe-end checkpoint of that
 *  subscription before this returns; nothing else may stand in for it. */
export async function cancelConfirmed(env: Env, lease: HomeLease, stripe: StripeClient, id: string, opts?: { prorate: boolean; invoiceNow: boolean }): Promise<void> {
  const ended = (status: string | null | undefined) => status === "canceled" || status === "incomplete_expired";
  const confirmed = async () => { await fencedBatch(env, lease, [stripeEndedQ(id)]); };
  try {
    const w = await writeSubscription(env, lease, stripe, id, { kind: "cancel_now", opts });
    if (w.parked) throw new SubscriptionParked(id);
    if (ended(w.answer.status)) return confirmed();
  } catch (e) {
    if (!(e instanceof StripeError)) throw e;
    if (e.status === 404) return confirmed();
  }
  let status: string | null;
  try { status = (await stripe.getSubscription(id)).status; }
  catch (e) { if (e instanceof StripeError && e.status === 404) return confirmed(); throw e; }
  if (!ended(status)) throw new Error("subscription_not_canceled");
  return confirmed();
}

// ---- Cron sweep: retries, external revokes, live refunds, notices ----------------------------------------------------------

export const DELETION_WARNING_LEAD_MS = 3 * 86_400_000;

/** Astra JOURNEY-BCORE-1 #3: the in-app cancellation sweep's backoff after failures in a row: none after the first (eligible on the next pass),
 *  then 1, 3, 7, 15 ... minutes (at most 6 hours). A success clears it. */
const CANCEL_SYNC_BACKOFF_BASE_MS = 60_000;
/** Stored events retried per sweep run. */
export const SWEEP_EVENT_BATCH = 50;
/** The share of one sweep run that each of the two bounded loops (stored-event retries, notice retries) may use (lane C design 3 §2, A2):
 *  a loop starts no attempt that could end past its start + this (nor past the invocation's hard wall). Rows not reached keep their due time. */
export const SWEEP_LOOP_BUDGET_MS = 120_000;
/** The invocation's hard wall when the caller gives none (the scheduled handler's own: index.ts SCHEDULED_SWEEP_DEADLINE_MS): a Cron
 *  Trigger invocation runs at most 15 minutes. Only an upper bound on the bounded loops' admission, never a reason to skip them. */
export const SWEEP_RUN_MS = 15 * 60_000;
/** The cron period of the sweep (wrangler.jsonc: every 5 minutes). */
export const SWEEP_PERIOD_MS = 5 * 60_000;
/** The longest a bounded loop waits for one attempt (an event's, a notice's) (A2). */
export const EVENT_MAX_MS = 60_000;
/** How far an event's due time moves when the sweep claims it for an attempt (A1): an attempt that records nothing (a lost or busy lease, a
 *  timeout, a crash) leaves the event behind every other due event instead of first in line again. The event loop runs first in every
 *  sweep, so the claim of one run has expired by the same loop of the run after next at the latest. A normal outcome overwrites it. */
export const EVENT_CLAIM_MS = 5 * 60_000;
/** How far a notice's due time moves when the notice-retry loop claims it (Astra MAILRETRY-3 P1, MAILRETRY-4 P1): the cron period plus the
 *  attempt cap. The notice loop runs second, right after the event loop, so its start moves within a run by up to that loop's budget; one
 *  attempt cap on top of the period keeps a hung notice that was claimed late in one run out of the very next run's loop. The notifier's own
 *  outcome (a failure's backoff, a hold) overwrites it; sent_at ends it. */
export const NOTICE_RETRY_CLAIM_MS = SWEEP_PERIOD_MS + EVENT_MAX_MS;
/** An attempt that did not finish within its cap (attemptWithin). Whoever catches it writes nothing for that attempt: the attempt cannot be
 *  cancelled, but every billing write it still makes is fenced by its home lease, and its claim expires on its own. */
export class AttemptTimeout extends Error { constructor() { super("event_attempt_timeout"); } }
/** One attempt of a bounded loop, waited for at most `maxMs` of the run's clock (A2). `rate` is how many of the clock's milliseconds pass
 *  per real millisecond (1 in production; BillingDependencies.clockRate). On a timeout the loop moves on and records nothing; the attempt
 *  goes on as a CUT CONTINUATION, registered with the invocation (`waitUntil`, Astra MAILRETRY-4 P2) so Cloudflare keeps it alive until it
 *  ends instead of cancelling it unseen, and its later error is logged, never dropped, and handed to `lateFailure` when given (the notice
 *  loop's own failure path: Astra MAILRETRY-6 P2). */
async function attemptWithin(attempt: Promise<void>, maxMs: number, label: string, rate = 1, waitUntil?: (work: Promise<unknown>) => void,
  lateFailure?: (e: unknown) => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = attempt.then(() => "done" as const);
  try {
    const first = await Promise.race([done, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), maxMs / rate); })]);
    if (first === "timeout") {
      const rest = done.then(() => undefined, async (e: unknown) => {
        console.error(JSON.stringify({ message: "timed-out billing sweep step failed", step: label, errorCode: e instanceof Error ? e.message.slice(0, 80) : "error" }));
        // The caller's failure path, the same as within the cap (Astra MAILRETRY-6 P2); an error of its own is logged, never dropped.
        if (lateFailure) {
          try { await lateFailure(e); } catch (e2) {
            console.error(JSON.stringify({ message: "late billing sweep step failure not recorded", step: label, errorCode: e2 instanceof Error ? e2.message.slice(0, 80) : "error" }));
          }
        }
      });
      waitUntil?.(rest);
      throw new AttemptTimeout();
    }
  } finally { clearTimeout(timer); }
}
/** The customer-waiting loops (lane C part C1): stored-event retries, then notice retries, each bounded, claimed per item and time-boxed on its
 *  own budget (at most ~2 x SWEEP_LOOP_BUDGET_MS). The scheduled handler runs this FIRST, before B3 reconcile and the self-service sweep, as
 *  its own guarded step, so no stage before or inside the billing sweep can use up the time they need (Astra MAILRETRY-6 P1, MAILRETRY-7 P1).
 *  Astra MAILRETRY-7 P2 (the notice loop can delay the billing sweep's later money work by up to its 120 s budget) is accepted for C1; C2 covers it. */
export async function sweepCustomerWaiting(env: Env, deps: BillingDependencies = {}): Promise<void> {
  let config: BillingConfig | null;
  try { config = billingConfig(env); } catch { return; }
  if (!config) return;
  const now = (deps.now ?? Date.now)();
  const clock = deps.now ?? Date.now;
  const stepMaxMs = deps.eventMaxMs ?? EVENT_MAX_MS;
  const rate = deps.clockRate ?? 1;
  // The invocation's hard wall: only an upper bound on the two bounded loops' admission (no attempt starts that could run past it). They run
  // first in the invocation, each on its own budget, so no other stage's time is ever spent from it (Astra MAILRETRY-7 P1).
  const wall = deps.sweepDeadline ?? clock() + SWEEP_RUN_MS;
  let failures = 0;
  const guard = async (work: () => Promise<void>) => { try { await work(); } catch { failures++; } };

  // 1. Stored-event retries (bounded, first). Every unprocessed event that is due, however many tries it took so far (no attempt cap), EARLIEST DUE FIRST (lane C design 3 §1). A
  // never-tried event is due at its receipt. It cannot starve either way: an event waits only behind events due earlier, and every attempt
  // re-dues the event it tried later than every event already waiting (a failure at now + its gap, the claim below at now + EVENT_CLAIM_MS).
  const pending = await env.DB.prepare(`SELECT id FROM stripe_events WHERE processed_at IS NULL AND COALESCE(next_attempt_at,received_at)<=?
    ORDER BY COALESCE(next_attempt_at,received_at),received_at LIMIT ${SWEEP_EVENT_BATCH}`).bind(now).all<{ id: string }>();
  // Bounded by its OWN budget (A2): no attempt starts that could end past this loop's start + SWEEP_LOOP_BUDGET_MS (or past the invocation's
  // hard wall); each is waited for at most stepMaxMs. A timeout is a failure of this run and writes nothing from here. Events not reached keep their due time.
  const eventsStopAt = Math.min(wall, clock() + SWEEP_LOOP_BUDGET_MS);
  for (const e of pending.results) {
    const t = clock();
    // Strictly before the stop: workerd's clock does not move between reads without I/O, and a timer fires on its exact due time, so a hung
    // attempt cut at its cap can leave exactly one cap to the stop. That tie admits nothing: one hung start per budget, deterministically.
    if (t + stepMaxMs >= eventsStopAt) break;
    // The claim (A1): scheduling metadata only, written before the attempt, on a still-pending event still due. A failure or a completion
    // overwrites it; an attempt that records nothing leaves it. Claimed meanwhile by another sweep, or completed: skipped. Astra MAILRETRY-11
    // P3: the claim is the attempt's first write, inside its timeout, so the loop's admission bound (start + budget) covers it too.
    // A lookup miss (PendingMiss) was recorded and is retried on its own schedule: an expected wait, not a failure of this run.
    await guard(() => attemptWithin((async () => {
      const claim = await env.DB.prepare("UPDATE stripe_events SET next_attempt_at=? WHERE id=? AND processed_at IS NULL AND COALESCE(next_attempt_at,received_at)<=?")
        .bind(t + EVENT_CLAIM_MS, e.id, t).run();
      if (claim.meta.changes !== 1) return;
      await processStoredEvent(env, config!, deps, e.id).catch((err: unknown) => { if (!(err instanceof PendingMiss)) throw err; });
    })(), stepMaxMs, `event:${e.id}`, rate, deps.waitUntil));
  }
  // 2. Notice retries (bounded, second; Astra MAILRETRY-6 P1). Every notice recorded but not handed off is retried, however old (no age
  // limit drops a required notice). Backoff per notice; after 5 tries a person is told; after NOTICE_DEAD_LIMIT it is tried once a day and
  // ops is told each time, but it is never dropped. (A terms notice with an open obligation is delivered by that obligation, which
  // re-renders it for every attempt.) It runs before every unbounded stage, so none of them can use up its time; any error of its own is a
  // failure of this run, never a reason to skip the stages after it.
  await guard(async () => {
    const unsent = await env.DB.prepare(`SELECT n.id,n.home_id,n.kind,n.payload,n.attempts,h.owner_id FROM billing_notices n JOIN cloud_homes h ON h.id=n.home_id
      WHERE n.sent_at IS NULL AND n.canceled_at IS NULL AND COALESCE(n.next_attempt_at,0)<=?
        AND NOT EXISTS (SELECT 1 FROM terms_notice_obligations o WHERE o.delivered_at IS NULL
          AND n.id = 'terms_change:' || o.home_id || ':' || o.cloud_terms_version || ':' || o.tos_version || ':' || o.privacy_version)
      ORDER BY COALESCE(n.next_attempt_at,0),n.created_at LIMIT 50`).bind(now)
      .all<{ id: string; home_id: string; kind: NoticeKind; payload: string; attempts: number; owner_id: string }>();
    type Unsent = (typeof unsent.results)[number];
    // A failed handoff, recorded the same way whenever it is known (Astra MAILRETRY-6 P2): within the attempt's cap, or later, by the cut
    // continuation of an attempt that timed out. Fenced by the home lease; backoff, attempts and the notice.undelivered / notice.dead
    // escalation at the same thresholds either way.
    const noticeFailed = async (n: Unsent, claimedTo: number | null, e: unknown): Promise<void> => {
      if (e instanceof HomeBusy || e instanceof LeaseLost) return; // someone else is working on this home: not a failed attempt
      if (e instanceof RefusalWithdrawn) return; // a refusal that no longer stands: held or cancelled, never a failed send
      const dead = n.attempts + 1 >= NOTICE_DEAD_LIMIT;
      // A custom notifier may not keep the backoff itself; keep it here too. The notice stays pending, whatever the number of tries. A due
      // time that is still this run's claim is replaced by the backoff; any other (the notifier's own) is only ever moved later.
      const retryAt = now + (dead ? DAY_MS : noticeBackoff(n.attempts + 1));
      try {
        await withHomeLease(env, n.home_id, (lease) => fencedRun(env, lease, "UPDATE billing_notices SET next_attempt_at=CASE WHEN next_attempt_at=? THEN ? ELSE MAX(COALESCE(next_attempt_at,0),?) END,attempts=MAX(attempts,?),dead_at=CASE WHEN ? THEN COALESCE(dead_at,?) ELSE dead_at END WHERE id=? AND sent_at IS NULL",
          claimedTo, retryAt, retryAt, n.attempts + 1, dead ? 1 : 0, now, n.id));
      } catch (e2) { if (!(e2 instanceof HomeBusy || e2 instanceof LeaseLost)) throw e2; }
      if (n.attempts + 1 >= 5) {
        await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
          .bind(crypto.randomUUID(), n.home_id, "notice.undelivered", "high", JSON.stringify({ noticeId: n.id, kind: n.kind }), now).run();
      }
      if (dead) await deadLetterAlert(env, n.home_id, "notice.dead", { noticeId: n.id, kind: n.kind, attempts: n.attempts + 1 }, now);
    };
    // Bounded by its OWN budget only: no retry starts that could end past this loop's start + SWEEP_LOOP_BUDGET_MS (or past the invocation's
    // hard wall), and a hung sender is waited for at most stepMaxMs.
    const noticesStopAt = Math.min(wall, clock() + SWEEP_LOOP_BUDGET_MS);
    for (const n of unsent.results) {
      if (clock() + stepMaxMs >= noticesStopAt) break; // strictly before the stop, as the event loop above
      let claimedTo: number | null = null;
      try {
        await attemptWithin(withHomeLease(env, n.home_id, async (lease) => {
          // The claim (Astra MAILRETRY-4 P1), committed before the handoff: the notice's due time moves NOTICE_RETRY_CLAIM_MS on (more than the
          // cron period plus the attempt cap), so a notice that hangs, times out or records nothing is not first again next run: every other
          // due notice goes before it. The notifier's own outcome overwrites it (a failure's backoff, a hold); sent_at ends it. Claimed
          // meanwhile by another run, or no longer pending: skipped.
          const t = clock();
          if (await fencedRun(env, lease, "UPDATE billing_notices SET next_attempt_at=? WHERE id=? AND sent_at IS NULL AND canceled_at IS NULL AND COALESCE(next_attempt_at,0)<=?",
            t + NOTICE_RETRY_CLAIM_MS, n.id, t) !== 1) return;
          claimedTo = t + NOTICE_RETRY_CLAIM_MS;
          const notifier = deps.notifier ?? defaultNotifier;
          // Astra JOURNEY-B-3 #5: a custom notifier is handed the ready email's words generated at this handoff too (the default notifier
          // generates them itself, with the clock it records as sent_at).
          const payload = n.kind === "server_ready" && notifier !== defaultNotifier ? await refreshReadyPayload(env, lease, n.id, n.home_id, n.payload, (deps.now ?? Date.now)())
            : n.kind === "cancel_scheduled" && notifier !== defaultNotifier ? await refreshCancelPayload(env, lease, n.id, n.home_id, n.payload) : n.payload;
          await notifier.notify(env, { id: n.id, homeId: n.home_id, ownerId: n.owner_id, kind: n.kind, data: JSON.parse(payload) }, lease);
        }), stepMaxMs, `notice:${n.id}`, rate, deps.waitUntil, (late) => noticeFailed(n, claimedTo, late));
      }
      catch (e) {
        // Timed out: a failure of this run, and nothing is written here. The send may still be in flight (a cut continuation, registered
        // with the invocation); the claim above keeps the notice behind the others. If it later fails, the continuation records that failure
        // through noticeFailed (MAILRETRY-6 P2); if it later succeeds, the notifier has recorded the send itself.
        if (e instanceof AttemptTimeout) { failures++; continue; }
        try { await noticeFailed(n, claimedTo, e); } catch { failures++; }
      }
    }
  });
  if (failures) throw new Error("billing_sweep_incomplete");
}
/** The billing sweep. Its two customer-waiting loops (sweepCustomerWaiting) are bounded; the scheduled handler runs them first in the
 *  invocation and tells this sweep so (customerWaitingDone), and every other caller gets them here, first, as before. Every other stage runs
 *  exactly as before lane C (unbounded, in order, as on 56a15e901). A durable per-item scheduler for the WHOLE sweep (every stage bounded and
 *  fair under hangs, poisoned LIMIT windows and busy homes) is lane C2, a separate pre-live lane. */
/** The lifecycle's refund obligations that name their payment's OWN subscription (ended by the refund, never the home's current one). */
const OWN_SUBSCRIPTION_REFUNDS = ["refund:superseded:", "refund:closed_line:", "refund:suspended:", "refund:resume_lapsed:"];
export async function sweepBilling(env: Env, deps: BillingDependencies = {}): Promise<void> {
  let config: BillingConfig | null;
  try { config = billingConfig(env); } catch { return; }
  if (!config) return;
  const now = (deps.now ?? Date.now)();
  const flux = deps.flux ?? stubFluxHooks;
  let failures = 0;
  const guard = async (work: () => Promise<void>) => { try { await work(); } catch { failures++; } };
  // One home's work under its billing lease. A busy home (or a lease lost on the way) is skipped until the next sweep; it is not a failure.
  const onHome = (homeId: string, work: (lease: HomeLease) => Promise<void>) => guard(async () => {
    try { await withHomeLease(env, homeId, work); } catch (e) { if (e instanceof HomeBusy || e instanceof LeaseLost) return; throw e; }
  });

  // 1–2. The customer-waiting loops, unless the scheduled handler already ran them this invocation (then a no-op here).
  if (!deps.customerWaitingDone) await guard(() => sweepCustomerWaiting(env, deps));
  // Lane H1, item 3 (fence F4): grants whose last fenced request has an unknown or superseded outcome are read back (GET state). Flux off: no-op.
  if (fluxDispatchEnabled(flux) && flux.reconcileFences) await guard(async () => { await flux.reconcileFences!(env); });
  // 3. Everything below runs exactly as on 56a15e901: unbounded, in this order. Lane C2 bounds the rest of the sweep.
  // B4 not wired in a live deployment: paid refunds and auto top-up cannot complete (they fail closed). Say so, every sweep, until fixed.
  if (env.CLOUD_B3_MODE === "live" && flux.stub) {
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
      .bind(crypto.randomUUID(), "billing", "flux.not_wired", "high", JSON.stringify({ blocks: ["paid refunds", "monthly credit grants", "credit revocation", "auto top-up"] }), now).run();
  }
  // Orders parked for a missing acceptance line longer than PARKED_REFUND_AFTER_MS: cancelled and refunded in full, never left parked.
  const parked = await env.DB.prepare(`SELECT id,home_id FROM checkout_consents WHERE acceptance_parked_at IS NOT NULL AND acceptance_parked_at<=? AND rejected_at IS NULL
    ORDER BY acceptance_parked_at LIMIT 20`).bind(now - PARKED_REFUND_AFTER_MS).all<{ id: string; home_id: string }>();
  for (const p of parked.results) await onHome(p.home_id, (lease) => refundParkedOrder(env, config!, deps, lease, p.id, now));
  // Rejected orders whose cancellation Stripe has not confirmed yet (Astra WP5-3 #2): asked again, every sweep, until it is confirmed.
  const cancels = await env.DB.prepare("SELECT subscription_id AS s,home_id AS h FROM rejected_subscriptions WHERE cancel_pending=1 AND home_id IS NOT NULL ORDER BY at LIMIT 50")
    .all<{ s: string; h: string }>();
  for (const r of cancels.results) await onHome(r.h, (lease) => confirmRejectedCancel(env, lease, stripeClient(config!, deps.stripeFetch), r.s, now));
  // Session requests whose answer was never recorded (Astra JOURNEY-A-3 #3): reconciled against Stripe by issuance id, oldest first; one
  // Stripe cannot resolve is alerted (home.checkout_unresolved), never settled on age.
  // Astra JOURNEY-A-4 #3: FAIR selection. Each marker's attempt is stamped (checkout_marker_schedule: last/next attempt, with backoff) BEFORE
  // it is tried, whatever then happens (unresolved, a Stripe failure, a busy home whose lease is never taken), and the 20 due soonest are
  // taken: permanently missing sessions wait their backoff and never keep a newer marker from its reconciliation or its 6-hour alert.
  const markers = await env.DB.prepare(`SELECT c.id,c.home_id,c.session_inflight_at AS at,COALESCE(c.session_issuance_id,'') AS iss,COALESCE(s.attempts,0) AS n
    FROM checkout_consents c LEFT JOIN checkout_marker_schedule s ON s.consent_id=c.id AND s.issuance_id=COALESCE(c.session_issuance_id,'')
    WHERE c.session_inflight_at IS NOT NULL AND c.session_inflight_at<=? AND COALESCE(s.next_attempt_at,0)<=?
    ORDER BY COALESCE(s.next_attempt_at,0),c.session_inflight_at,c.id LIMIT 20`).bind(now - SESSION_MARKER_SETTLE_AFTER_MS, now)
    .all<{ id: string; home_id: string; at: number; iss: string; n: number }>();
  for (const m of markers.results) {
    await guard(async () => {
      await env.DB.prepare(`INSERT INTO checkout_marker_schedule (consent_id,issuance_id,last_attempt_at,next_attempt_at,attempts) VALUES (?,?,?,?,1)
        ON CONFLICT(consent_id,issuance_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,next_attempt_at=excluded.next_attempt_at,attempts=attempts+1`)
        .bind(m.id, m.iss, now, sessionMarkerNextAt(m.n, m.at, now)).run();
    });
    await onHome(m.home_id, async (lease) => { await reconcileSessionMarker(env, lease, stripeClient(config!, deps.stripeFetch), m.id, now); });
  }
  // Astra JOURNEY-A-5 #5/#6: the six-hour escalation and the alert's membership are evaluated from the markers themselves, every sweep,
  // whatever happened above: a Stripe call that failed (a fetch rejection included), a home whose lease was busy, a marker still in its
  // backoff. A home with an overdue request and no open alert gets one; an open alert whose list no longer matches the home's unresolved
  // requests is rebuilt (and delivered again). Alerts only: no billing table is written here.
  await guard(async () => {
    const overdue = await env.DB.prepare(`SELECT DISTINCT c.home_id AS h FROM checkout_consents c WHERE c.session_inflight_at IS NOT NULL AND c.session_inflight_at<=?
      AND NOT EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.home_id=c.home_id AND a.kind='${CHECKOUT_UNRESOLVED_ALERT}' AND a.resolved_at IS NULL) LIMIT 50`)
      .bind(now - CHECKOUT_UNRESOLVED_ALERT_MS).all<{ h: string }>();
    const drifted = await env.DB.prepare(`SELECT a.home_id AS h FROM cloud_alerts a WHERE a.kind='${CHECKOUT_UNRESOLVED_ALERT}' AND a.resolved_at IS NULL
      AND (NOT EXISTS (SELECT 1 FROM checkout_consents c WHERE c.home_id=a.home_id AND c.session_inflight_at IS NOT NULL)
        OR json(COALESCE(json_extract(a.detail,'$.issuances'),'[]'))<>(SELECT json_group_array(iss) FROM (SELECT COALESCE(c.session_issuance_id,'none') AS iss
          FROM checkout_consents c WHERE c.home_id=a.home_id AND c.session_inflight_at IS NOT NULL ORDER BY c.session_inflight_at,c.id))) LIMIT 50`).all<{ h: string }>();
    for (const h of new Set([...overdue.results, ...drifted.results].map((r) => r.h))) {
      // Raise, then rebuild membership (each idempotent; cloud_alerts only).
      for (const [sql, binds] of checkoutAlertRaiseQs(h, now)) await env.DB.prepare(sql).bind(...(binds ?? [])).run();
    }
  });
  // Astra TAXCOUNTRY-5: customer create journal rows left behind (a lost answer, a switch that lost its lease) become orphan records for ops
  // (sweepTaxDispatches: fair by per-row backoff, hard-capped per run with every Stripe call aborted at the cap or at this invocation's own
  // deadline, deps.sweepDeadline). The diagnostic preset receipts and the relocation markers are deleted after TAX_RECORD_RETENTION_MS (48
  // hours: past any session's lifetime), and so are address-update journal rows of the retired update model (`tax_dispatch:`, never written
  // since; they hold a postal code). All on the clock they were written with (Date.now()).
  await guard(() => sweepTaxDispatches(env, (signal) => stripeClient(config!, deps.stripeFetch, { signal }), onHome, { deadline: deps.sweepDeadline }));
  // Astra TAXCOUNTRY-6 P2-d: an orphan still recorded past its review deadline is put in front of ops (manual erasure; never automatic).
  await guard(async () => { await alertOverdueOrphans(env, Date.now()); });
  await guard(async () => {
    await env.DB.prepare(`DELETE FROM cloud_ops_state WHERE ((substr(key,1,11)='tax_preset:' OR substr(key,1,14)='tax_relocated:')
      AND (CASE WHEN json_valid(value) THEN COALESCE(json_extract(value,'$.at'),0) ELSE 0 END)<=?)
      OR (substr(key,1,13)='tax_dispatch:' AND (CASE WHEN json_valid(value) THEN COALESCE(json_extract(value,'$.createdAt'),0) ELSE 0 END)<=?)`)
      .bind(Date.now() - TAX_RECORD_RETENTION_MS, Date.now() - TAX_RECORD_RETENTION_MS).run();
  });
  // The schedule of a settled (or superseded) marker is dropped.
  await guard(async () => {
    await env.DB.prepare(`DELETE FROM checkout_marker_schedule WHERE NOT EXISTS (SELECT 1 FROM checkout_consents c WHERE c.id=checkout_marker_schedule.consent_id
      AND c.session_inflight_at IS NOT NULL AND COALESCE(c.session_issuance_id,'')=checkout_marker_schedule.issuance_id)`).run();
  });

  // Astra JOURNEY-A-6 #4: payment-level coverage reconciliation, hourly per payment, least recently checked first (stamped before Stripe is
  // asked): for as long as any work on it is pending (no age cutoff then), and for COVERAGE_TAIL_MS after its last coverage change.
  const coverage = await env.DB.prepare(COVERAGE_DUE_SQL).bind(now - 3_600_000, now - COVERAGE_TAIL_MS).all<{ h: string; pi: string }>();
  for (const c of coverage.results) {
    await onHome(c.h, (lease) => reconcilePaymentCoverage(env, lease, { stripe: stripeClient(config!, deps.stripeFetch), flux, deps, now }, c.h, c.pi).then(() => undefined));
  }
  // Astra JOURNEY-A-9 #2: the cutover guard's report (unreconciled legacy refund-backed /reverse rows), one alert per home.
  await sweepLegacyReversals(env, now);
  // Credit reversals of refunded invoices not yet confirmed by B4 (Astra WP5-6 #2): asked again, every sweep, until B4 confirms.
  // The 50 homes whose pending reversals were least recently tried first (Astra STUB-3 #1): a home whose reversals keep failing, raw or not,
  // never keeps a 51st home out.
  const reversals = await env.DB.prepare(`SELECT home_id AS h FROM credit_reversals WHERE reversed_at IS NULL GROUP BY home_id
    ORDER BY MIN(COALESCE(last_attempt_at,0)),home_id LIMIT 50`).all<{ h: string }>();
  for (const r of reversals.results) await onHome(r.h, (lease) => reverseCredits(env, lease, flux, r.h, now));
  // Monthly grants claimed but not confirmed by B4 (a failed or interrupted grantOnce): asked again, every sweep, until B4 confirms. The 50
  // homes whose runnable claims were least recently tried first, so homes whose claims keep failing never starve another (Astra STUB-1 #3),
  // even when they fail on infrastructure: each claim is stamped before B4 is asked (askGrant, Astra STUB-2 #2).
  const grants = await env.DB.prepare(`SELECT g.home_id AS h FROM credit_grants g WHERE ${GRANT_RUNNABLE} GROUP BY g.home_id
    ORDER BY MIN(COALESCE(g.last_attempt_at,0)),g.home_id LIMIT 50`).all<{ h: string }>();
  for (const r of grants.results) await onHome(r.h, (lease) => retryPendingGrants(env, lease, flux, r.h, now));
  // Ops clearance (migration 0082, Astra STUB-4 #2): a home that still has its credit.grant_pending alert open while a claim of it was cleared
  // (alerted_at NULL, cleared_at set) has the alert rebuilt under its lease, so a home of only suppressed claims is closed or updated too.
  const cleared = await env.DB.prepare(`SELECT DISTINCT g.home_id AS h FROM credit_grants g WHERE g.granted_at IS NULL AND g.alerted_at IS NULL AND g.cleared_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.home_id=g.home_id AND a.kind='credit.grant_pending' AND a.resolved_at IS NULL) ORDER BY g.home_id LIMIT 50`).all<{ h: string }>();
  for (const r of cleared.results) await onHome(r.h, async (lease) => { await fence(env, lease); await fencedBatch(env, lease, grantAlertSync(r.h, now)); });
  // Astra JOURNEY-B-2 #7: a plan move still owed to Flux whose renewal evidence is already persisted (whichever event came first) is finished.
  // Astra JOURNEY-B-3 #8: least recently tried first, each row stamped (flux_plan_attempt_at) BEFORE it is checked, so rows without usable
  // evidence rotate behind the others and never starve one that has it.
  const dirty = await env.DB.prepare(`SELECT home_id AS h FROM billing_subscriptions WHERE flux_plan_dirty=1 AND status NOT IN ('canceled','disputed')
    ORDER BY COALESCE(flux_plan_attempt_at,0),home_id LIMIT 50`).all<{ h: string }>();
  for (const r of dirty.results) {
    await onHome(r.h, async (lease) => {
      await fencedRun(env, lease, "UPDATE billing_subscriptions SET flux_plan_attempt_at=? WHERE home_id=?", now, r.h);
      await propagatePlanFromEvidence(env, lease, flux, r.h);
    });
  }
  // Refund operations (both refund routes, region holds, duplicates): every unfinished step, until done.
  await guard(() => sweepRefundOps(env, { stripe: stripeClient(config!, deps.stripeFetch), flux, deps, now }));
  // Round 10 (Astra TAXCOUNTRY-9 P1-2): lost inexact disputes past their resolution deadline escalate; resolved or won ones close their alerts.
  await guard(() => sweepInexactDisputes(env, onHome, now));
  // G-F1: a dispute hold whose home is still not attributed DISPUTE_HOLD_PAGE_MS after the event pages (and stays held).
  await guard(() => sweepDisputeHolds(env, now));
  // Astra FLUX-7 / INTEGRATED-10: open disputes past the webhook retry window are read from Stripe through the same closure path.
  await guard(() => pollOpenDisputes(env, stripeClient(config!, deps.stripeFetch), onHome, now));
  // First payments whose refund-identity keys were not captured at invoice.paid (a Stripe hiccup there): captured now, so a later
  // checkout by the same person is still recognized even if this customer never asks for a refund. Only with the secret configured.
  // Retention first (24 months from each payment, refund-identity.ts): expired records are purged, and the capture below never picks up a
  // payment that old, so a purged record is never recreated.
  await guard(async () => { await purgeRefundIdentity(env, now); });
  // Cancel-screen feedback is kept 13 months (journey.ts), then deleted here.
  await guard(() => sweepJourney(env, now));
  // Then previous-version keys that no stored payment needs any more are retired (refund-identity.ts retireRedundantKeys).
  await guard(async () => { await retireRedundantKeys(env, now); });
  // Objections to keeping refund codes still undecided near the one-month reply deadline (refund-identity.ts recordObjection).
  await guard(() => remindOpenObjections(env, now));
  // Objections recorded while a refusal was being handed off are finalised once every such dispatch is resolved (ASTRA-REFUND6 #3).
  await guard(() => finalisePendingObjections(env, now));
  // A refund-identity key that stops new sales is said every sweep until fixed (withdrawals and refunds keep running meanwhile).
  const refundKeyError = checkoutRefundKeyError(env);
  if (refundKeyError) {
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
      .bind(crypto.randomUUID(), "billing", "refund_key.checkout_blocked", "high", JSON.stringify({ error: refundKeyError }), now).run();
  }
  if (env.REFUND_KEY_SECRET) {
    const missing = await env.DB.prepare(`SELECT s.home_id,s.first_invoice_id AS i,s.first_paid_at AS at,s.first_payment_intent AS pi,h.owner_id AS u
      FROM billing_subscriptions s JOIN cloud_homes h ON h.id=s.home_id WHERE s.first_invoice_id IS NOT NULL AND s.first_paid_at IS NOT NULL
      AND s.first_paid_at>=? AND NOT EXISTS (SELECT 1 FROM refund_identity_captures c WHERE c.invoice_id=s.first_invoice_id)
      AND NOT EXISTS (SELECT 1 FROM refund_identity_restrictions r WHERE r.user_id=h.owner_id AND r.erased_through IS NOT NULL
        AND s.first_paid_at<=r.erased_through) LIMIT 20`)
      .bind(retentionCutoff(now)).all<{ home_id: string; i: string; at: number; pi: string | null; u: string }>();
    for (const m of missing.results) await guard(async () => { await captureRefundIdentity(env, stripeClient(config!, deps.stripeFetch),
      { homeId: m.home_id, userId: m.u, invoiceId: m.i, paidAt: m.at, paymentIntent: m.pi }, now); });
    // Incomplete captures read again until complete (refund-identity.ts).
    await guard(() => enrichRefundIdentities(env, stripeClient(config!, deps.stripeFetch), now));
  }
  // Top-up authorizations not yet applied to Flux auto-recharge (the stub cannot apply them; nothing is retried against it). Each home on its
  // own, under its lease; a busy home is skipped until the next sweep.
  if (!flux.stub) {
    const unapplied = await env.DB.prepare("SELECT home_id FROM topup_settings WHERE applied_revision IS NULL OR applied_revision<>revision LIMIT 50").all<{ home_id: string }>();
    for (const t of unapplied.results) await onHome(t.home_id, async (lease) => { await applyTopup(env, lease, flux, t.home_id, now); });
  }

  // The lifecycle's journaled service starts and ends not applied yet (the home was busy at the transition): applied under each home's lease.
  const serviceLog = await env.DB.prepare("SELECT DISTINCT home_id FROM service_interval_log WHERE applied_at IS NULL LIMIT 50").all<{ home_id: string }>();
  for (const r of serviceLog.results) await onHome(r.home_id, async (lease) => { await applyServiceLog(env, lease); });
  // Lifecycle moved a home to suspended: the Flux side must stop before anything else happens to it.
  // Astra TAXCOUNTRY-8 P1-2: a revoke names the payment line it suspended (paymentLine). Read under the home's lease: once another
  // subscription took the home (payment_line moved), the old line's late revoke stops nothing of the new contract and is completed as skipped.
  const revokes = await env.DB.prepare("SELECT id,home_id,payload FROM cloud_outbox WHERE kind='external_revoke_required' AND completed_at IS NULL LIMIT 50")
    .all<{ id: string; home_id: string; payload: string }>();
  for (const r of revokes.results) {
    await onHome(r.home_id, async (lease) => {
      await fence(env, lease);
      let revokedLine: string | null = null;
      try { revokedLine = (JSON.parse(r.payload) as { paymentLine?: string | null }).paymentLine ?? null; } catch { /* legacy payload: no line */ }
      const homeLine = await env.DB.prepare("SELECT payment_line FROM cloud_homes WHERE id=?").bind(r.home_id).first<{ payment_line: string | null }>();
      if (revokedLine !== null && homeLine?.payment_line != null && homeLine.payment_line !== revokedLine) {
        await fencedRun(env, lease, "UPDATE cloud_outbox SET completed_at=?,receipt=? WHERE id=?", now,
          JSON.stringify({ fluxStopped: false, skipped: "line_moved", paymentLine: revokedLine, currentLine: homeLine.payment_line }), r.id);
        return;
      }
      // Round 9b: the stop names the line it suspended (billing_hold_line): only a paid invoice of ANOTHER contract may lift that hold.
      await flux.stopForBilling(env, r.home_id, undefined, { line: revokedLine });
      await fencedRun(env, lease, "UPDATE cloud_outbox SET completed_at=?,receipt=? WHERE id=?", now, JSON.stringify({ fluxStopped: true }), r.id);
    });
  }

  // Live mode replaces the B3 fake refund: a paid event that found no capacity is refunded for real, through the SAME refund ledger as every
  // other refund (a leased, resumable operation): the outbox row and the home's "refunded" entitlement are completed only once the operation
  // is done, i.e. once Stripe says the refund succeeded.
  if (env.CLOUD_B3_MODE === "live") {
    const refunds = await env.DB.prepare("SELECT id,home_id,payload FROM cloud_outbox WHERE kind='refund_required' AND completed_at IS NULL LIMIT 20")
      .all<{ id: string; home_id: string; payload: string }>();
    for (const r of refunds.results) {
      await onHome(r.home_id, async (lease) => {
        const payment = JSON.parse(r.payload) as { paymentId: string; version: number; subscriptionId?: string };
        // Astra TAXCOUNTRY-8 P1-4: a superseded payment (another subscription's, refund:superseded:<paymentId>) ends ITS OWN subscription,
        // never the home's current one (which keeps serving).
        // Round 10 (Astra TAXCOUNTRY-9 P1-4/P1-5): so does a payment on a closed line, one refused by a non-billing suspension and one whose
        // resume lapsed (their own subscription, named in the obligation).
        const own = OWN_SUBSCRIPTION_REFUNDS.some((prefix) => r.id.startsWith(prefix)) && payment.subscriptionId ? payment.subscriptionId : null;
        const stripe = stripeClient(config!, deps.stripeFetch);
        const owner = await env.DB.prepare("SELECT owner_id FROM cloud_homes WHERE id=?").bind(r.home_id).first<{ owner_id: string }>();
        if (!owner) throw new Error("home_unknown");
        const opId = `no_capacity:${payment.paymentId}`;
        if (!await getRefundOp(env, opId)) {
          const invoice = await stripe.getInvoice(payment.paymentId);
          if (typeof invoice.amount_paid !== "number") throw new Error("payment_amount_unknown");
          // Astra MAILRETRY-13 P1-5: the operation ends THIS payment's own subscription, never whatever subscription the home has when the
          // operation opens (a new payment may have re-opened the home on its own subscription since the obligation was written); the
          // identity sources and their order are resolveRefundSubscription's.
          // Astra MAILRETRY-14 P2-a: UNRESOLVED (no source names the subscription) means: the money is refunded in full as usual, but the
          // plan's end is NOT done and is never recorded as done. The operation is opened with planUnresolved (the obligation and payment), so
          // every pass resolves it again; until then its end checkpoint (canceled_at) stays open, the operation and this obligation stay
          // open (the home keeps 'refund_pending', it is not retired), and the high alert refund.plan_unresolved stays open. For the owner:
          // check in Stripe whether that payment's subscription is still live; if it is, cancel it there AND record its id in
          // cloud_refund_identities.subscription_id for this obligation (the first identity source): the next pass then confirms the end with
          // Stripe, records it once, closes the operation and resolves the alert. A subscription that becomes resolvable by itself (Stripe's
          // invoice names it, or it is recorded as the home's subscription of this first invoice) is ended the same way, once.
          // Merge (C1 + F): a superseded payment names its own subscription in its obligation (F); every other obligation resolves it (C1).
          const subscriptionId = own ?? await resolveRefundSubscription(env, stripe, r.home_id, r.id, payment.paymentId, invoice);
          await fencedBatch(env, lease, [refundOpInsert({ id: opId, kind: "no_capacity", homeId: r.home_id, userId: owner.owner_id,
            invoiceId: invoice.amount_paid > 0 ? payment.paymentId : null, paidCents: invoice.amount_paid, targetCents: invoice.amount_paid, endPlan: true,
            subscriptionId, inheritSubscription: false, ...(subscriptionId ? {} : { detail: { planUnresolved: { obligationId: r.id, paymentId: payment.paymentId } } }) }, now)]);
        }
        // Astra MAILRETRY-15 P3-b: the plan_unresolved alert is written AFTER the refund step ran, and says where the money actually stands
        // (submitted to Stripe, or still pending), never "refunded" ahead of it; its text follows the operation on every pass while it is open.
        const planUnresolvedAlert = async () => {
          const cur = await getRefundOp(env, opId);
          if (!cur || cur.canceled_at !== null) return;
          let unresolved = false;
          try { unresolved = Boolean((JSON.parse(cur.detail ?? "{}") as { planUnresolved?: unknown }).planUnresolved); } catch { unresolved = false; }
          if (!unresolved) return;
          const money = cur.refund_submitted_at !== null || cur.refunded_at !== null ? "refund submitted to Stripe" : "refund pending (not yet submitted to Stripe)";
          const detail = JSON.stringify({ opId, paymentId: payment.paymentId, action: `${money}; the plan's end is OPEN: if this payment's subscription is live in Stripe, cancel it there and record its id in cloud_refund_identities for this obligation` });
          await fencedBatch(env, lease, [
            q(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
              planUnresolvedAlertId(opId), r.home_id, "refund.plan_unresolved", "high", detail, now, opId),
            q("UPDATE cloud_alerts SET detail=? WHERE id=? AND resolved_at IS NULL", detail, planUnresolvedAlertId(opId)),
          ]);
        };
        let op: Awaited<ReturnType<typeof advanceRefundOp>>;
        try { op = await advanceRefundOp(env, { stripe, flux, deps: { ...deps, lease }, now, lease }, opId); }
        catch (error) { await planUnresolvedAlert().catch(() => undefined); throw error; }
        await planUnresolvedAlert();
        if (!op?.done_at) return; // still waiting for Stripe: the sweep looks again
        await fencedBatch(env, lease, [
          // The home reads 'refunded' only once every refund obligation of it is done, whichever completes last (Astra JOURNEY-A-2 A6,
          // MAILRETRY-12 P2: no payment-version arm; a completion while another obligation is open changes only its own row).
          q(`UPDATE cloud_homes SET entitlement='refunded' WHERE id=? AND entitlement='refund_pending' AND ${NO_OTHER_REFUND_OPEN}`, r.home_id, r.home_id, r.id),
          q("UPDATE cloud_outbox SET completed_at=?,receipt=? WHERE id=?", now, JSON.stringify({ outcome: "refunded", paymentId: payment.paymentId, reason: "no_capacity", opId }), r.id),
        ]);
      });
    }
  }

  // A home that was given up on after provisioning failed: tell the customer plainly (the refund is handled just above).
  // Astra MAILRETRY-11: one notice per failed-setup row, so per payment: the home-scoped row (provision_failed:<home>, written before this
  // change or for a give-up with no payment record) keeps its notice key 'final'; a per-payment row (provision_failed:<home>:<paymentId>)
  // gets 'final:<paymentId>'. Each notice is sent once, whatever other payments of the home were given up before.
  const gaveUp = await env.DB.prepare(`SELECT id,outboxId,key FROM (SELECT o.home_id AS id,o.id AS outboxId,
      CASE WHEN o.id='provision_failed:'||o.home_id THEN 'final' ELSE 'final:'||substr(o.id,length(o.home_id)+19) END AS key
    FROM cloud_outbox o WHERE o.kind='provision_failed') g
    WHERE NOT EXISTS (SELECT 1 FROM billing_notices n WHERE n.id='provision_failed:'||g.id||':'||g.key) LIMIT 20`).all<{ id: string; outboxId: string; key: string }>();
  for (const h of gaveUp.results) await guard(async () => { await notify(env, deps, h.id, "provision_failed", h.key, await provisionFailedEmail(env, h.id, h.outboxId)); });

  // Notices. suspension_notices is the B3 counter that gates deletion (needs 2): a notice counts only once handed off.
  const suspended = await env.DB.prepare(`SELECT id,delete_after,suspension_notices,generation FROM cloud_homes
    WHERE desired_state='suspended' AND suspension_notices<2 LIMIT 50`).all<{ id: string; delete_after: number | null; suspension_notices: number; generation: number }>();
  for (const h of suspended.results) {
    await guard(async () => {
      const first = h.suspension_notices === 0;
      if (!first && !(h.delete_after !== null && now >= h.delete_after - DELETION_WARNING_LEAD_MS)) return;
      await notify(env, deps, h.id, first ? "suspended" : "deletion_warning", String(h.generation),
        { deleteAfter: h.delete_after ? new Date(h.delete_after).toISOString() : "unknown", allDataDeleted: "home, data volume and every backup or snapshot are deleted together; nothing is kept" });
      await env.DB.prepare("UPDATE cloud_homes SET suspension_notices=suspension_notices+1 WHERE id=? AND generation=? AND suspension_notices=?")
        .bind(h.id, h.generation, h.suspension_notices).run();
    });
  }
  // B3: a home whose ready email is owed (its canary passed: ready_pending_at) but not queued yet (the canary step found the home busy, or the
  // queueing failed): queued now, which is the moment its refund clock starts (Astra JOURNEY-B-1 #7). Durable: no age cutoff, the work stays
  // selected until it is done. Homes ready before this existed (ready_at backfilled by migration 0094, no ready_pending_at) are never sent a
  // late "ready" email.
  const readyUnqueued = await env.DB.prepare(`SELECT h.id AS id FROM cloud_homes h WHERE h.ready_pending_at IS NOT NULL
    AND (h.ready_at IS NULL OR NOT EXISTS (SELECT 1 FROM billing_notices n WHERE n.id='server_ready:' || h.id || ':first')) ORDER BY h.ready_pending_at LIMIT 20`)
    .all<{ id: string }>();
  for (const h of readyUnqueued.results) await onHome(h.id, (lease) => queueServerReady(env, lease, h.id, now));
  const deleted = await env.DB.prepare(`SELECT o.home_id AS id FROM cloud_outbox o WHERE o.kind='deleted'
    AND NOT EXISTS (SELECT 1 FROM billing_notices n WHERE n.home_id=o.home_id AND n.kind='deleted') LIMIT 20`).all<{ id: string }>();
  // The deletion receipt (members-api.ts): what was deleted, when, and the backup purge date.
  for (const h of deleted.results) await guard(async () => notify(env, deps, h.id, "deleted", "final", await deletionNoticeData(env, h.id, now)));

  // Yearly renewal reminder: once per home per anniversary of the service start, 30 days ahead, while the plan is still renewing.
  // Each plan carries its next due time, so the sweep reads only plans that are due and every sent reminder moves it a year on:
  // no customer is starved behind the first 200.
  const startedSql = "COALESCE(b.service_start_at,b.first_paid_at,b.created_at)";
  const unscheduled = await env.DB.prepare(`SELECT b.home_id AS id, ${startedSql} AS started FROM billing_subscriptions b
    WHERE b.reminder_due_at IS NULL AND b.status='active' LIMIT 200`).all<{ id: string; started: number }>();
  for (const r of unscheduled.results) {
    let year = 1; while (addMonthUtc(r.started, 12 * year) <= now) year++; // the next anniversary still ahead
    await onHome(r.id, async (lease) => {
      await fencedRun(env, lease, "UPDATE billing_subscriptions SET reminder_due_at=? WHERE home_id=? AND reminder_due_at IS NULL", addMonthUtc(r.started, 12 * year) - RENEWAL_REMINDER_LEAD_MS, r.id);
    });
  }
  const due = await env.DB.prepare(`SELECT b.home_id AS id, b.subscription_id AS sub, b.plan AS plan, ${startedSql} AS started, b.reminder_due_at AS dueAt,
    (SELECT c.tax_source FROM checkout_consents c WHERE c.id=b.consent_id) AS taxSource
    FROM billing_subscriptions b JOIN cloud_homes h ON h.id=b.home_id
    WHERE b.reminder_due_at<=? AND b.status='active' AND NOT ${reminderBlockedSql("b")} AND h.desired_state NOT IN ('deleted','deleting','suspended')
    ORDER BY b.reminder_due_at LIMIT 200`).bind(now).all<{ id: string; sub: string | null; plan: string; started: number; dueAt: number; taxSource: string | null }>();
  for (const r of due.results) {
    await onHome(r.id, async (lease) => {
      const plan = planFrom(r.plan); if (!plan) return;
      // Selected before the lease: under it, the same subscription must still be due, active and renewing (a cancellation can commit in
      // between; Astra CANCEL-SUMMARY-1 #5). Otherwise nothing is sent and the due time stays (Keep my plan brings the reminder back).
      if (!await env.DB.prepare(`SELECT 1 AS x FROM billing_subscriptions b JOIN cloud_homes h ON h.id=b.home_id WHERE b.home_id=? AND b.subscription_id IS ?
        AND b.reminder_due_at=? AND b.status='active' AND NOT ${reminderBlockedSql("b")} AND h.desired_state NOT IN ('deleted','deleting','suspended')`)
        .bind(r.id, r.sub, r.dueAt).first()) return;
      let year = 1; while (addMonthUtc(r.started, 12 * year) <= now) year++;
      const renewsOn = addMonthUtc(r.started, 12 * year);
      if (renewsOn - now <= RENEWAL_REMINDER_LEAD_MS) {
        const mail = buildReminderEmail(plan, { portalOrigin: config!.returnOrigin, renewsOn, seller: sellerOfConsent({ tax_source: r.taxSource }) });
        try {
          await notify(env, { ...deps, lease }, r.id, "renewal_reminder", String(year), { renewsOn: new Date(renewsOn).toISOString().slice(0, 10),
            subscriptionId: r.sub, emailSubject: mail.subject, emailText: mail.text, emailHtml: mail.html });
        } catch (e) { if (e instanceof RefusalWithdrawn) return; throw e; } // the plan stopped renewing at the claim: nothing sent, due time kept
        year++;
      }
      await fencedRun(env, lease, "UPDATE billing_subscriptions SET reminder_due_at=? WHERE home_id=? AND reminder_due_at=?",
        addMonthUtc(r.started, 12 * year) - RENEWAL_REMINDER_LEAD_MS, r.id, r.dueAt);
    });
  }
  // Changed documents: a 30-day notice with full copies to every customer whose accepted versions are not the ones in force. The new
  // versions apply to them only after a fresh acceptance (the account page asks at the next sign-in).
  const cur = { c: LEGAL_DOCS.cloudTerms.versionId, t: LEGAL_DOCS.termsOfService.versionId, p: LEGAL_DOCS.privacyPolicy.versionId };
  // 1. Queue every notice owed, independently of delivering it (fair: a queued customer is never selected again here). Queueing only
  //    records that a notice is owed; it changes no subscription, so it is the one billing-table write made outside a home's lease.
  await env.DB.prepare(`INSERT OR IGNORE INTO terms_notice_obligations (user_id,cloud_terms_version,tos_version,privacy_version,home_id,created_at,next_attempt_at)
    SELECT h.owner_id, ?, ?, ?, MIN(b.home_id), ?, ? FROM billing_subscriptions b JOIN cloud_homes h ON h.id=b.home_id
    WHERE b.status IN ('active','trialing','past_due') AND h.desired_state NOT IN ('deleted','deleting')
      AND EXISTS (SELECT 1 FROM terms_acceptances a WHERE a.user_id=h.owner_id AND NOT (a.cloud_terms_version=? AND a.tos_version=? AND a.privacy_version=?)
        AND ${acceptanceCounts("a")})
      AND NOT EXISTS (SELECT 1 FROM terms_notice_obligations o WHERE o.user_id=h.owner_id AND o.cloud_terms_version=? AND o.tos_version=? AND o.privacy_version=?)
    GROUP BY h.owner_id LIMIT 500`).bind(cur.c, cur.t, cur.p, now, now, cur.c, cur.t, cur.p, cur.c, cur.t, cur.p).run();
  // A notice that did go out by another path completes its obligation, with the effective date counted from when it was actually sent.
  const sentElsewhere = await env.DB.prepare(`SELECT o.user_id AS userId, o.home_id AS homeId, n.sent_at AS sentAt FROM terms_notice_obligations o
    JOIN billing_notices n ON n.id = 'terms_change:' || o.home_id || ':' || o.cloud_terms_version || ':' || o.tos_version || ':' || o.privacy_version
    WHERE o.delivered_at IS NULL AND n.sent_at IS NOT NULL AND o.cloud_terms_version=? AND o.tos_version=? AND o.privacy_version=? LIMIT 100`)
    .bind(cur.c, cur.t, cur.p).all<{ userId: string; homeId: string; sentAt: number }>();
  for (const r of sentElsewhere.results) {
    await onHome(r.homeId, async (lease) => {
      await fencedBatch(env, lease, [
        q(`INSERT INTO terms_change_notices (user_id,cloud_terms_version,tos_version,privacy_version,home_id,notified_at,effective_at)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`, r.userId, cur.c, cur.t, cur.p, r.homeId, r.sentAt, r.sentAt + TERMS_NOTICE_MS),
        q(`UPDATE terms_notice_obligations SET delivered_at=?,dead_at=NULL WHERE user_id=? AND cloud_terms_version=? AND tos_version=? AND privacy_version=?`, r.sentAt, r.userId, cur.c, cur.t, cur.p),
      ]);
    });
  }
  // 2. Deliver the due ones, each on its own under its home's lease. A required notice is NEVER abandoned: after POISON_LIMIT failures it
  //    is retried once a day and ops is told each time (dead_at only marks the escalation; it does not take the row out of this query).
  const owed = await env.DB.prepare(`SELECT user_id AS userId, home_id AS homeId, attempts FROM terms_notice_obligations
    WHERE cloud_terms_version=? AND tos_version=? AND privacy_version=? AND delivered_at IS NULL AND COALESCE(next_attempt_at,0)<=?
    ORDER BY COALESCE(next_attempt_at,0) LIMIT 100`).bind(cur.c, cur.t, cur.p, now).all<{ userId: string; homeId: string; attempts: number }>();
  const obligation = "user_id=? AND cloud_terms_version=? AND tos_version=? AND privacy_version=?";
  for (const u of owed.results) {
    try {
      await withHomeLease(env, u.homeId, async (lease) => {
        // Owed to every customer who agreed to an earlier version, even one who already accepted the new ones early.
        const changed = changedSince(await latestOlderAcceptance(env, u.userId));
        if (changed.length) {
          const alreadyAccepted = changedSince(await latestAcceptance(env, u.userId)).length === 0;
          await env.DB.batch(archiveCurrentDocs(env, now));
          // Counted from THIS send, and the email is rendered again for every attempt: the date the customer reads is always the date
          // recorded as the effective date (a payload kept from an earlier, failed attempt would carry a stale one).
          const effectiveAt = now + TERMS_NOTICE_MS;
          const mail = buildTermsChangeEmail({ portalOrigin: config!.returnOrigin, effectiveAt, changed, alreadyAccepted });
          const payload = { emailSubject: mail.subject, emailText: mail.text, emailHtml: mail.html };
          const noticeKey = `${cur.c}:${cur.t}:${cur.p}`;
          await fencedRun(env, lease, "UPDATE billing_notices SET payload=? WHERE id=? AND sent_at IS NULL", JSON.stringify(payload), `terms_change:${u.homeId}:${noticeKey}`);
          await notify(env, { ...deps, lease }, u.homeId, "terms_change", noticeKey, payload);
          await fencedRun(env, lease, `INSERT INTO terms_change_notices (user_id,cloud_terms_version,tos_version,privacy_version,home_id,notified_at,effective_at)
            VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`, u.userId, cur.c, cur.t, cur.p, u.homeId, now, effectiveAt);
        }
        await fencedRun(env, lease, `UPDATE terms_notice_obligations SET delivered_at=? WHERE ${obligation}`, now, u.userId, cur.c, cur.t, cur.p);
      });
    } catch (e) {
      if (e instanceof HomeBusy || e instanceof LeaseLost) continue;
      failures++;
      const attempts = u.attempts + 1;
      const escalate = attempts >= POISON_LIMIT;
      try {
        await withHomeLease(env, u.homeId, async (lease) => {
          await fencedRun(env, lease, `UPDATE terms_notice_obligations SET attempts=?,next_attempt_at=?,dead_at=CASE WHEN ? THEN COALESCE(dead_at,?) ELSE dead_at END WHERE ${obligation}`,
            attempts, now + (escalate ? DAY_MS : noticeBackoff(attempts)), escalate ? 1 : 0, now, u.userId, cur.c, cur.t, cur.p);
        });
      } catch (e2) { if (!(e2 instanceof HomeBusy || e2 instanceof LeaseLost)) throw e2; }
      if (escalate) await deadLetterAlert(env, u.homeId, "terms.notice_dead", { userId: u.userId, versions: cur, attempts }, now);
    }
  }
  // Changed documents never accepted: at the effective date the plan is set not to renew (the accepted terms run to the end of the paid
  // period), then reminders 7 days before that period ends and when it ends. Accepting in time lifts it. A renewal is not an acceptance.
  await guard(() => enforceTermsNonAcceptance(env, config!, deps, now));
  // Cancellation intents not yet confirmed at Stripe (a busy home, a Stripe error), and every subscription that has ever had a cancellation
  // intent re-read against Stripe at least daily (and at once after a superseded mutation, whose request may still land late): a drift is
  // corrected with a new journaled mutation. Each home on its own.
  // A final (terminal) cancellation that had a renewal request in the last day is re-read on EVERY sweep: that request may still land late.
  const unsynced = await env.DB.prepare(`SELECT home_id,cancel_sync_failures FROM billing_subscriptions b WHERE subscription_id IS NOT NULL AND status NOT IN ('canceled','disputed')
    AND (cancel_synced_rev<>cancel_intent_rev OR (cancel_intent_rev>0 AND (cancel_verify_dirty=1 OR COALESCE(cancel_verified_at,0)<=?
      OR (cancel_terminal_sub=b.subscription_id AND EXISTS (SELECT 1 FROM sub_mutations m WHERE m.subscription_id=b.subscription_id AND m.desired_cancel=0 AND m.created_at>?)))))
    AND COALESCE(cancel_sync_next_at,0)<=? ORDER BY COALESCE(cancel_sync_attempt_at,0), home_id LIMIT 50`)
    .bind(now - DAY_MS, now - DAY_MS, now).all<{ home_id: string; cancel_sync_failures: number }>();
  // Astra JOURNEY-BCORE-1 #3: fair rotation independent of success. Each row's attempt time and its next eligibility (backoff on the failures
  // so far) are persisted BEFORE it is worked on, so rows Stripe keeps refusing go to the back and can never starve the others; the row
  // attempted longest ago goes first. A successful sync clears the backoff (syncCancellation).
  for (const u of unsynced.results) {
    await onHome(u.home_id, async (lease) => {
      // Committed on its own, under the lease, before the attempt: whatever happens to the attempt, the row has moved to the back.
      await fencedRun(env, lease, `UPDATE billing_subscriptions SET cancel_sync_attempt_at=?,cancel_sync_failures=cancel_sync_failures+1,
        cancel_sync_next_at=?+MIN(?*((1<<MIN(cancel_sync_failures,12))-1),?) WHERE home_id=?`, now, now, CANCEL_SYNC_BACKOFF_BASE_MS, 6 * 3_600_000, u.home_id);
      await syncCancellation(env, deps, u.home_id, lease);
    });
  }
  // An export request past its pause stops pausing the deletion; the record says it expired.
  await guard(() => expireExportRequests(env, now));
  if (failures) throw new Error("billing_sweep_incomplete");
}

interface TermsNoticeRow { user_id: string; cloud_terms_version: string; tos_version: string; privacy_version: string; home_id: string; effective_at: number;
  cancel_set_at: number | null; cancel_skipped_at: number | null; period_end: number | null; reminder7_at: number | null; end_notice_at: number | null;
  enforce_attempts: number }
const acceptedNotice = async (env: Env, n: TermsNoticeRow) => (await env.DB.prepare(`SELECT 1 AS x FROM terms_acceptances WHERE user_id=? AND cloud_terms_version=?
  AND tos_version=? AND privacy_version=? AND ${acceptanceCounts("terms_acceptances")}`).bind(n.user_id, n.cloud_terms_version, n.tos_version, n.privacy_version).first()) !== null
  || changedSince(await latestAcceptance(env, n.user_id)).length === 0;

/** The latest acceptance of versions other than the ones in force (what the change notice compares against). */
const latestOlderAcceptance = (env: Env, userId: string) => env.DB.prepare(`SELECT cloud_terms_version,tos_version,privacy_version,accepted_at FROM terms_acceptances
  WHERE user_id=? AND NOT (cloud_terms_version=? AND tos_version=? AND privacy_version=?) AND ${acceptanceCounts("terms_acceptances")} ORDER BY accepted_at DESC, rowid DESC LIMIT 1`)
  .bind(userId, LEGAL_DOCS.cloudTerms.versionId, LEGAL_DOCS.termsOfService.versionId, LEGAL_DOCS.privacyPolicy.versionId).first<AcceptanceRow>();

async function enforceTermsNonAcceptance(env: Env, config: BillingConfig, deps: BillingDependencies, now: number): Promise<void> {
  // Never dropped: a row that keeps failing is retried once a day (enforce_dead_at only marks that ops was told).
  const rows = await env.DB.prepare(`SELECT * FROM terms_change_notices WHERE lifted_at IS NULL AND end_notice_at IS NULL AND effective_at<=?
    AND COALESCE(enforce_next_at,0)<=? ORDER BY COALESCE(enforce_next_at,0), effective_at LIMIT 100`).bind(now, now).all<TermsNoticeRow>();
  let failed = 0;
  const stripe = stripeClient(config, deps.stripeFetch);
  void stripe;
  const key = (n: TermsNoticeRow) => `${n.cloud_terms_version}:${n.tos_version}:${n.privacy_version}`;
  const where = "user_id=? AND cloud_terms_version=? AND tos_version=? AND privacy_version=?";
  for (const n of rows.results) {
    const ids = [n.user_id, n.cloud_terms_version, n.tos_version, n.privacy_version];
    // Each customer on its own, under its home's lease: one failing cancellation backs off without holding back the next. A busy home waits.
    try { await withHomeLease(env, n.home_id, (lease) => enforceOne(n, ids, lease)); }
    catch (e) {
      if (e instanceof HomeBusy || e instanceof LeaseLost) continue;
      failed++;
      const attempts = n.enforce_attempts + 1;
      const escalate = attempts >= POISON_LIMIT;
      try {
        await withHomeLease(env, n.home_id, async (lease) => {
          await fencedRun(env, lease, `UPDATE terms_change_notices SET enforce_attempts=?,enforce_next_at=?,enforce_dead_at=CASE WHEN ? THEN COALESCE(enforce_dead_at,?) ELSE enforce_dead_at END WHERE ${where}`,
            attempts, now + (escalate ? DAY_MS : noticeBackoff(attempts)), escalate ? 1 : 0, now, ...ids);
        });
      } catch (e2) { if (!(e2 instanceof HomeBusy || e2 instanceof LeaseLost)) throw e2; }
      if (escalate) await deadLetterAlert(env, n.home_id, "terms.enforcement_dead", { userId: n.user_id, error: e instanceof Error ? e.message.slice(0, 80) : "error" }, now);
    }
  }
  if (failed) throw new Error("terms_enforcement_incomplete");
  async function enforceOne(n: TermsNoticeRow, ids: string[], lease: HomeLease) {
    const held = { ...deps, lease };
    if (await acceptedNotice(env, n)) { await liftTermsCancel(env, held, n.user_id, now); return; }
    let row = n;
    if (n.cancel_set_at === null && n.cancel_skipped_at === null) {
      const sub = await getSub(env, n.home_id);
      if (!sub?.subscription_id || sub.status === "canceled" || sub.customer_cancel_at !== null) {
        // Already ending (cancelled by the customer, or no plan): nothing to stop, nothing to remind.
        await fencedRun(env, lease, `UPDATE terms_change_notices SET cancel_skipped_at=?,end_notice_at=? WHERE ${where}`, now, now, ...ids);
        return;
      }
      // Intent first (durable, revisioned), then the serialized sync that completes only on Stripe's read-back.
      await fencedBatch(env, lease, [
        q(`UPDATE terms_change_notices SET cancel_set_at=? WHERE ${where} AND cancel_set_at IS NULL`, now, ...ids),
        q("UPDATE billing_subscriptions SET cancel_intent_rev=cancel_intent_rev+1 WHERE home_id=?", n.home_id),
      ]);
      row = { ...row, cancel_set_at: now };
    }
    if (row.cancel_set_at !== null && row.period_end === null) {
      const r = await syncCancellation(env, held, n.home_id, lease);
      const pe = r.periodEnd ?? now;
      await fencedRun(env, lease, `UPDATE terms_change_notices SET period_end=? WHERE ${where}`, pe, ...ids);
      row = { ...row, period_end: pe };
    }
    const periodEnd = row.period_end ?? now;
    if (row.reminder7_at === null && now >= periodEnd - 7 * DAY_MS) {
      const mail = buildTermsReminderEmail({ portalOrigin: config.returnOrigin, retention: retentionDaysText(env), periodEnd, stage: "7d" });
      await notify(env, { ...deps, lease }, n.home_id, "terms_change", `${key(n)}:7d`, { emailSubject: mail.subject, emailText: mail.text, emailHtml: mail.html });
      await fencedRun(env, lease, `UPDATE terms_change_notices SET reminder7_at=? WHERE ${where}`, now, ...ids);
    }
    if (now >= periodEnd) {
      const mail = buildTermsReminderEmail({ portalOrigin: config.returnOrigin, retention: retentionDaysText(env), periodEnd, stage: "end" });
      await notify(env, { ...deps, lease }, n.home_id, "terms_change", `${key(n)}:end`, { emailSubject: mail.subject, emailText: mail.text, emailHtml: mail.html });
      await fencedRun(env, lease, `UPDATE terms_change_notices SET end_notice_at=? WHERE ${where}`, now, ...ids);
      return;
    }
    // Done for now: not looked at again until its next real deadline, so waiting rows never crowd out other customers.
    const next = now < periodEnd - 7 * DAY_MS ? periodEnd - 7 * DAY_MS : periodEnd;
    await fencedRun(env, lease, `UPDATE terms_change_notices SET enforce_next_at=?,enforce_attempts=0 WHERE ${where}`, next, ...ids);
  }
}

/** The customer accepted the versions in force: a non-renewal set for non-acceptance is taken back while the paid period is still running.
 *  Through the intent and the serialized sync, each home under its lease: a cancellation the customer asked for (even one asked at the same
 *  moment) always wins. A busy home throws HomeBusy; the billing sweep lifts it on its next run. */
export async function liftTermsCancel(env: Env, deps: BillingDependencies, userId: string, now: number): Promise<void> {
  const rows = await env.DB.prepare("SELECT * FROM terms_change_notices WHERE user_id=? AND lifted_at IS NULL AND end_notice_at IS NULL").bind(userId).all<TermsNoticeRow>();
  for (const n of rows.results) {
    const inTime = n.cancel_set_at !== null && (n.period_end === null || now < n.period_end);
    await withHomeLease(env, n.home_id, async (lease) => {
      await fencedBatch(env, lease, [
        q("UPDATE terms_change_notices SET lifted_at=? WHERE user_id=? AND cloud_terms_version=? AND tos_version=? AND privacy_version=? AND lifted_at IS NULL",
          now, n.user_id, n.cloud_terms_version, n.tos_version, n.privacy_version),
        q("UPDATE billing_subscriptions SET cancel_intent_rev=cancel_intent_rev+1 WHERE home_id=? AND changes()=1", n.home_id),
      ]);
      if (inTime) await syncCancellation(env, deps, n.home_id, lease);
    }, deps.lease);
  }
}

/** The renewal state the durable intents ask for: the customer's own cancellation, or a terms non-renewal not lifted. */
export async function desiredCancel(env: Env, sub: SubRow): Promise<boolean> {
  if (sub.customer_cancel_at !== null) return true;
  // Astra JOURNEY-B-2 #1: while a deletion of the home waits, its plan ends: renewal is never asked of Stripe then, whatever else is recorded.
  if ((await env.DB.prepare(`SELECT 1 AS x FROM cloud_recovery_holds WHERE home_id=? AND action='delete' AND completed_at IS NULL AND canceled_at IS NULL`)
    .bind(sub.home_id).first()) !== null) return true;
  // An address change that needs the other payment page ends THIS subscription at its period end (WP6, plan §1.3). The route row names the
  // subscription and stays until the replacement is paid (or the subscription has ended), whatever its expiry says.
  if ((await env.DB.prepare(`SELECT 1 AS x FROM checkout_retry_routes r JOIN cloud_homes h ON h.owner_id=r.account_id
    WHERE h.id=? AND r.reason='address_change' AND r.replaces_subscription_id=?`).bind(sub.home_id, sub.subscription_id).first()) !== null) return true;
  return (await env.DB.prepare("SELECT 1 AS x FROM terms_change_notices WHERE home_id=? AND cancel_set_at IS NOT NULL AND lifted_at IS NULL").bind(sub.home_id).first()) !== null;
}
/** The reference of the home's current subscription's cancellation receipt (legal-routes.ts cancelPlan), or null (a cancellation that did not
 *  come through the signed-in button, or a read that fails: the email goes out without it, never later because of it). */
async function cancellationReference(env: Env, homeId: string, subscriptionId?: string | null): Promise<string | null> {
  try {
    const row = await env.DB.prepare(`SELECT c.reference AS r FROM plan_cancellations c JOIN billing_subscriptions b ON b.home_id=c.home_id AND b.subscription_id=c.subscription_id
      WHERE c.home_id=?${subscriptionId ? " AND c.subscription_id=?" : ""}`).bind(...(subscriptionId ? [homeId, subscriptionId] : [homeId])).first<{ r: string }>();
    return row?.r ?? null;
  } catch { return null; }
}
/** The "your plan is cancelled" notice: its key and payload (recorded with the confirmed cancellation, then sent). Astra JOURNEY-BCORE-3 #9: the
 *  key names the subscription AND the cancellation's generation (`episode`: '<subscription>:<customer_cancel_at>'), so Cancel, Keep and Cancel
 *  again in the same period is a second notice, never the first one's id. The payload carries what it was made from (cancelEnd, reference,
 *  episode) so its words can be regenerated at delivery (refreshCancelPayload). */
function cancelledNotice(env: Env, end: number | null, reference: string | null, deleting: boolean, episode: string): { key: string; data: Record<string, unknown> } {
  const until = end ? isoDate(end) : "the end of the period you paid for";
  const stop = renewalStopSentence(end ? isoDate(end) : null);
  // Astra JOURNEY-BCORE-2 #9: a home that is deleted or waiting to be deleted is not told its server keeps running, is suspended later or that
  // its data is kept: the confirmation of the billing end says only what is true of the billing.
  const text = deleting
    ? `Your Murage Cloud plan is cancelled.${reference ? `\n\nYour cancellation reference: ${reference}` : ""}\n\n${stop}\n\nThis confirms the billing end only. What happens to your server and its data is what your deletion request says.`
    : `You cancelled your Murage Cloud plan.${reference ? `\n\nYour cancellation reference: ${reference}` : ""}\n\n${stop} Your server keeps running until ${until}, the end of the period you paid for. After that it is suspended, and we keep your data for ${retentionDaysText(env)}.\n\nChanged your mind? Open your account page before then.`;
  return { key: `${episode}:${end ?? "end"}`, data: { activeUntil: until, emailSubject: "Murage Cloud: your plan is cancelled", emailText: text, emailHtml: htmlOf(text),
    cancelEnd: end, reference, episode } };
}
/** Astra JOURNEY-BCORE-3 #10: a cancellation notice's words regenerated against the COMMITTED lifecycle state at its delivery (a home deleted
 *  or waiting to be deleted since the notice was queued is never told its server keeps running or its data is kept). Saved under the claim and
 *  the lease before it goes out. A payload without its sources (older rows) is sent as it is. */
async function refreshCancelPayload(env: Env, lease: HomeLease, noticeId: string, homeId: string, payload: string): Promise<string> {
  let data: Record<string, unknown>;
  try { data = JSON.parse(payload) as Record<string, unknown>; } catch { return payload; }
  if (!("cancelEnd" in data) || typeof data.episode !== "string") return payload;
  // Astra JOURNEY-BCORE-4 #7: sent only while its cancellation episode still stands (the same subscription, the same customer_cancel_at). A Keep,
  // a new Cancel or a replaced subscription since it was queued retires it: nothing is sent.
  const sub = await getSub(env, homeId);
  if (!sub?.subscription_id || sub.customer_cancel_at === null || `${sub.subscription_id}:${sub.customer_cancel_at}` !== data.episode) {
    await fencedRun(env, lease, "UPDATE billing_notices SET canceled_at=?,claimed_until=NULL WHERE id=? AND sent_at IS NULL", Date.now(), noticeId);
    throw new RefusalWithdrawn("cancel_withdrawn");
  }
  const end = typeof data.cancelEnd === "number" ? data.cancelEnd : null;
  const fresh = JSON.stringify({ ...data, ...cancelledNotice(env, end, typeof data.reference === "string" ? data.reference : null, await homeIsDeleting(env, homeId), data.episode).data });
  if (fresh !== payload) await fencedRun(env, lease, "UPDATE billing_notices SET payload=? WHERE id=? AND sent_at IS NULL", fresh, noticeId);
  return fresh;
}
/** Whether the home is deleted or has a deletion waiting (the committed lifecycle state, never the notice's own assumption). */
async function homeIsDeleting(env: Env, homeId: string): Promise<boolean> {
  try {
    const h = await env.DB.prepare("SELECT desired_state AS d FROM cloud_homes WHERE id=?").bind(homeId).first<{ d: string }>();
    if (h && (h.d === "deleted" || h.d === "deleting")) return true;
    return (await env.DB.prepare("SELECT 1 AS x FROM cloud_recovery_holds WHERE home_id=? AND action='delete' AND completed_at IS NULL AND canceled_at IS NULL").bind(homeId).first()) !== null;
  } catch { return false; }
}
async function notifyCancelled(env: Env, deps: BillingDependencies, homeId: string, n: { key: string; data: Record<string, unknown> }): Promise<void> {
  try { await notify(env, deps, homeId, "cancel_scheduled", n.key, n.data); }
  catch { /* the cancellation stands; the notice was recorded with it and the sweep retries it */ }
}
/** The invoice a payment paid and the subscription (contract) that invoice belongs to. Our own records first (the retained contract's first
 *  payment, journaled first-invoice holds, ledger rows), then Stripe: the invoice (pre-Basil charge.invoice, or Basil's InvoicePayment of the
 *  payment intent) and its parent subscription. A payment no invoice belongs to has no contract (null). */
export async function paymentOwner(env: Env, st: StripeClient, sub: SubRow | null, pi: string | null, invoiceHint: string | null):
  Promise<{ invoiceId: string | null; subscriptionId: string | null }> {
  const fromLedger = pi ? await env.DB.prepare("SELECT invoice_id, subscription_id FROM refund_ops WHERE payment_intent=? AND kind<>'external' AND invoice_id IS NOT NULL LIMIT 1")
    .bind(pi).first<{ invoice_id: string; subscription_id: string | null }>() : null;
  let invoiceId = invoiceHint ?? fromLedger?.invoice_id ?? null;
  if (!invoiceId && pi && sub?.first_payment_intent === pi) invoiceId = sub.first_invoice_id;
  if (!invoiceId && pi) invoiceId = await st.invoiceOfPayment(pi);
  if (!invoiceId) return { invoiceId: null, subscriptionId: null };
  if (sub?.subscription_id && (sub.first_invoice_id === invoiceId || (pi !== null && sub.first_payment_intent === pi))) return { invoiceId, subscriptionId: sub.subscription_id };
  const held = await env.DB.prepare("SELECT subscription_id FROM first_invoice_holds WHERE invoice_id=?").bind(invoiceId).first<{ subscription_id: string }>();
  if (held) return { invoiceId, subscriptionId: held.subscription_id };
  if (fromLedger?.invoice_id === invoiceId && fromLedger.subscription_id) return { invoiceId, subscriptionId: fromLedger.subscription_id };
  return { invoiceId, subscriptionId: (await st.getInvoice(invoiceId)).subscription };
}
/** Records refunds of one payment that our ledger did not make (Link's own refunds, Dashboard refunds) as decided, done 'external'
 *  operations, and adds them to the payment's ledger row. Idempotent per Stripe refund id. Returns how many were new. */
export async function recordExternalRefunds(env: Env, lease: HomeLease, st: ReturnType<typeof stripeClient>, i: { homeId: string; userId: string; paymentIntent: string;
  invoiceId: string | null; subscriptionId: string | null }, now: number): Promise<number> {
  let list = (await st.listRefunds(i.paymentIntent)).data.filter((r) => !r.metadata?.op_id && r.status !== "failed" && r.status !== "canceled");
  const invoiceId = i.invoiceId ?? (await env.DB.prepare("SELECT invoice_id FROM refund_ops WHERE payment_intent=? AND invoice_id IS NOT NULL LIMIT 1").bind(i.paymentIntent)
    .first<{ invoice_id: string }>())?.invoice_id ?? (await env.DB.prepare("SELECT first_invoice_id AS i FROM billing_subscriptions WHERE first_payment_intent=?")
    .bind(i.paymentIntent).first<{ i: string | null }>())?.i ?? null;
  // A refund the ledger already holds is ours, whatever its metadata (Astra WP3-1 #1): a credit note's refund carries no op id, since
  // Stripe does not copy the note's metadata onto it.
  const ours = new Set<string>();
  for (const r of list) {
    if (await env.DB.prepare("SELECT 1 AS x FROM refund_ops WHERE stripe_refund_id=? AND home_id=? AND kind<>'external'").bind(r.id, i.homeId).first()) ours.add(r.id);
  }
  list = list.filter((r) => !ours.has(r.id));
  if (list.length) {
    // Before anything is imported, credit-note ownership is reconciled: every note (all pages) of each invoice a ledger credit-note
    // operation was decided for on this payment is read, and a note carrying an op id is ours, with its refunds. An operation that crashed
    // before its own checkpoint gets the note and refund recorded here. A listing that cannot be completed throws: nothing is imported.
    const kinds = CREDIT_NOTE_KINDS.map(() => "?").join(",");
    const noteInvoices = (await env.DB.prepare(`SELECT DISTINCT invoice_id FROM refund_ops WHERE (payment_intent=? OR invoice_id=?) AND invoice_id IS NOT NULL AND kind IN (${kinds})`)
      .bind(i.paymentIntent, invoiceId, ...CREDIT_NOTE_KINDS).all<{ invoice_id: string }>()).results.map((r) => r.invoice_id);
    for (const inv of noteInvoices) {
      for (const n of (await st.listCreditNotes(inv)).data) {
        // An op id on a note proves nothing by itself (Astra WP3-2 #1): anyone can write metadata, and a copied id could name another
        // home's operation. A note is ours only when a local operation matches it on the leased home, the invoice, the payment and the
        // direct (credit-note) path, and does not already hold a different note. Anything else is imported as external below.
        const ownerOf = await creditNoteOwner(env, lease, i, invoiceId, inv, n);
        if (!ownerOf) continue;
        const owner = ownerOf.id;
        const refundIds = n.refunds ?? (n.refund ? [n.refund] : []);
        for (const id of refundIds) ours.add(id);
        if (n.status !== "void") {
          // The validated note's own creation time is checkpointed with its ids (Astra WP3-2 #5): the operation that follows the refund id
          // later never reaches the note again, and would otherwise date the submission by the refund. Never the discovery time.
          const created = typeof n.created === "number" && n.created > 0 ? n.created * 1000 : null;
          // The note and its refunds are claimed for the owner in the same batch as the checkpoint (Astra WP3-4 #1): a note or refund another
          // operation holds is never adopted on metadata; the owner stays pending (attribution_unresolved) and ops is alerted. Its refunds
          // are not imported either: they are already counted under a ledger decision.
          const claimed = !ownerOf.unresolved && await claimRefundObjects(env, lease, owner, { creditNoteId: n.id, refundIds }, now,
            q(`UPDATE refund_ops SET credit_note_id=?,stripe_refund_id=COALESCE(stripe_refund_id,?),refund_submitted_at=COALESCE(refund_submitted_at,?),
              updated_at=? WHERE id=? AND home_id=? AND kind<>'external' AND credit_note_id IS NULL`, n.id, n.refund, created, now, owner, lease.homeId));
          if (!claimed) {
            const op = await getRefundOp(env, owner);
            if (op) await markAttributionUnresolved(env, lease, op, { creditNoteId: n.id, refundIds, by: "external_refund_import" }, now);
          }
        }
      }
    }
    list = list.filter((r) => !ours.has(r.id));
  }
  let fresh = 0;
  for (const r of list) {
    const opId = `external:${r.id}`;
    if (await env.DB.prepare("SELECT 1 AS x FROM refund_ops WHERE id=?").bind(opId).first()) continue;
    const stmts: Q[] = [
      // The refunded payment's OWN contract (never inherited from the home's current subscription).
      refundOpInsert({ id: opId, kind: "external", homeId: i.homeId, userId: i.userId, invoiceId, paymentIntent: i.paymentIntent, endPlan: false,
        subscriptionId: i.subscriptionId, inheritSubscription: false, detail: { refundId: r.id, by: "outside_ledger" } as never }, now),
      q(`UPDATE refund_ops SET amount_cents=?,basis='external',decided_at=?,submitted_at=?,stripe_refund_id=?,refund_status=?,refunded_at=?,done_at=?,notified_at=?,updated_at=?
        WHERE id=? AND decided_at IS NULL`, r.amount, now, now, r.id, r.status ?? "succeeded", now, now, now, now, opId),
      q("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        `alert:${opId}`, i.homeId, "refund.external", "warning", JSON.stringify({ refundId: r.id, paymentIntent: i.paymentIntent, amount: r.amount }), now),
    ];
    if (invoiceId) {
      stmts.push(q("INSERT OR IGNORE INTO refund_invoice_ledger (invoice_id,version,decided_cents) VALUES (?,0,0)", invoiceId),
        q("UPDATE refund_invoice_ledger SET version=version+1,decided_cents=decided_cents+? WHERE invoice_id=?", r.amount, invoiceId));
    }
    await fencedBatch(env, lease, stmts);
    fresh++;
  }
  return fresh;
}
/** The local operation that owns a credit note listed for invoice `inv`, or null (the note is foreign: its refunds import as external). The
 *  note's op id must name an operation that passes creditNoteMatchesOp (legal-refunds.ts), the rule the operation's own recovery uses too:
 *  the leased home, a checkout kind on the direct path, this invoice and payment, no other checkpointed note or refund, and, for an
 *  operation with no checkpoint, its durable submission, decided amount and submission number matching the note (Astra WP3-3 #1). */
async function creditNoteOwner(env: Env, lease: HomeLease, i: { homeId: string; paymentIntent: string }, paymentInvoice: string | null, inv: string,
  n: { id: string; invoice: string | null; amount: number; refund: string | null; refunds?: string[]; metadata: Record<string, string>; created?: number | null;
    refundTotal?: number | null }): Promise<{ id: string; unresolved: boolean } | null> {
  const opId = n.metadata?.op_id;
  if (!opId || lease.homeId !== i.homeId) return null;
  const op = await env.DB.prepare("SELECT * FROM refund_ops WHERE id=? AND kind<>'external'").bind(opId).first<RefundOpRow>();
  if (!op) return null;
  // A note that would be the operation's but carries several refunds is the operation's problem, not an outside refund (Astra WP3-4 #2):
  // its refunds are never imported, and the operation is held as attribution_unresolved.
  const a = creditNoteAttribution(op, n, { homeId: lease.homeId, invoiceId: inv, paymentIntent: i.paymentIntent, paymentInvoice });
  return a === "foreign" ? null : { id: op.id, unresolved: a === "unresolved" };
}
/** A Stripe failure that PROVES an idempotency key is settled for good (Astra JOURNEY-B-3 #1, JOURNEY-B-4 #1): the cached answer replayed
 *  (Idempotent-Replayed), or a 400 whose error type is idempotency_error (the key was already used, with other parameters: whatever that
 *  first request did is final). Any other 400 (a validation refusal) saves nothing under the key, so the original request sent with it can
 *  still land: it proves nothing. Never one still in flight. */
export const keyAnswered = (e: unknown): e is StripeError => e instanceof StripeError && !e.meta.inFlight
  && (e.meta.replayed === true || (e.status === 400 && e.meta.type === "idempotency_error"));
/** A validation refusal (a 400 that is not an idempotency refusal, not replayed): nothing was saved under the key. */
export const validationRefusal = (e: unknown): e is StripeError => e instanceof StripeError && !e.meta.inFlight && e.status === 400 && !keyAnswered(e);
/** This ATTEMPT was answered by Stripe (a 4xx that is not 409 idempotency_key_in_use: refused before anything was done, so it can never land
 *  later). A 5xx, a network failure or a timeout is OUTSTANDING: its outcome is unknown and it may still land (Astra JOURNEY-BCORE-1 #4). */
export const attemptAnswered = (e: unknown): boolean => e instanceof StripeError && !e.meta.inFlight && e.status >= 400 && e.status < 500;
/** Astra JOURNEY-B-5 #1 / JOURNEY-BCORE-1 #4: how long one OUTSTANDING attempt sent to Stripe can still be on its way: Stripe's documented
 *  request timeout (80 s, the default of Stripe's own client libraries; our client aborts every request at it: b5-stripe.ts) plus a margin
 *  (160 s) for clock skew between workers and work Stripe accepted just before the timeout. Evidence about a pending mutation (a live terminal
 *  state) never retires it while any outstanding attempt under its key is younger than this. Answered attempts are not outstanding. */
export const STRIPE_ATTEMPT_MAX_AGE_MS = STRIPE_REQUEST_TIMEOUT_MS + 160_000;
/** A pending mutation older than this (its row) is reported to ops (cancel.key_unsettled). Reported, NEVER retired on age: a row's age does
 *  not bound the age of its latest attempt (Astra JOURNEY-B-5 #1). */
const UNSETTLED_KEY_ALERT_MS = 86_400_000;
/** The OUTSTANDING attempt times recorded for a mutation (dispatched_at, migration 0096; NULL on older rows: its created_at). An empty list:
 *  every attempt was answered, none can still land. */
export const attemptsOf = (m: { dispatched_at: string | null; created_at: number }): number[] => {
  try { const a = JSON.parse(m.dispatched_at ?? "null") as unknown; if (Array.isArray(a) && a.every((x) => typeof x === "number")) return a; }
  catch { /* unreadable: the creation time */ }
  return [m.created_at];
};
/** Records an attempt (fenced) BEFORE its request is sent: if the answer is lost, the request is outstanding from this moment. */
const DISPATCH_SQL = "UPDATE sub_mutations SET dispatched_at=json_insert(COALESCE(dispatched_at,json_array(created_at)),'$[#]',?) WHERE id=? AND state='pending'";
/** Astra JOURNEY-BCORE-1 #4: an attempt Stripe ANSWERED (attemptAnswered) is taken off the outstanding list again (it is the last one recorded:
 *  the home's lease is held from the dispatch to here). Binds (id, sentAt). */
const ANSWERED_SQL = `UPDATE sub_mutations SET dispatched_at=json_remove(dispatched_at,'$[#-1]') WHERE id=? AND json_type(dispatched_at)='array'
  AND json_extract(dispatched_at,'$[#-1]')=?`;
/** Ops are told once a subscription's cancellation requests have been refused three times (provider_error recorded on its mutations). */
async function providerFailing(env: Env, homeId: string, subId: string, e: StripeError, now: number): Promise<void> {
  const failed = await env.DB.prepare("SELECT COUNT(*) AS n FROM sub_mutations WHERE subscription_id=? AND provider_error IS NOT NULL").bind(subId).first<{ n: number }>();
  if ((failed?.n ?? 0) >= 3) {
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
      .bind(crypto.randomUUID(), homeId, "cancel.provider_failing", "high", JSON.stringify({ subscriptionId: subId, failures: failed?.n, last: e.code }), now).run();
  }
}
export class CancelUnconfirmed extends Error { constructor() { super("cancel_state_unconfirmed"); } }
/** Brings Stripe's cancel_at_period_end to the intent, under the home's lease, through a JOURNAL of subscription mutations (sub_mutations):
 *  1. an outstanding mutation (one a worker started and may have lost its lease in) is settled FIRST by sending its own recorded request
 *     again with its original idempotency key: Stripe applies it now or returns its saved answer, and that key can never change the
 *     subscription afterwards (reading the current state would prove nothing: the request may still be on its way);
 *  2. then Stripe's ACTUAL state is compared with the intent, and only if they differ a NEW mutation is written (own id, own idempotency
 *     key: Stripe replays a reused key's first answer without applying anything), sent and read back; if the read-back disagrees (a racing
 *     request) it is sent again with a fresh key, a few times, and then fails with an alert. Success is reported only after the read-back.
 *  Complete only when Stripe reads back the intent AND the intent revision is still the one synced (a newer intent is synced next).
 *  Every attempt sent under a mutation's key is recorded (dispatched_at) before it is sent. A subscription whose cancel_at_period_end Stripe
 *  refuses to change stays pending with its intent journaled: the refusal is recorded, ops are told after three (cancel.provider_failing),
 *  and nothing is called confirmed. */
export async function syncCancellation(env: Env, deps: BillingDependencies, homeId: string, lease: HomeLease): Promise<{ cancel: boolean; periodEnd: number | null }> {
  const stripe = stripeClient(cfg(env), deps.stripeFetch);
  const clock = () => (deps.now ?? Date.now)();
  const now = clock();
  for (let i = 0; i < 4; i++) {
    const sub = await getSub(env, homeId);
    if (!sub?.subscription_id) return { cancel: true, periodEnd: sub?.current_period_end ?? null };
    if (sub.status === "canceled") {
      // Astra INTEGRATED-3 #3 (RULE A): a local canceled status is not Stripe's word that billing ended. Terminal success needs THE checkpoint;
      // without it Stripe is READ (never written) once: a subscription it shows ended sets the checkpoint (markEndedQ), anything else (still
      // active, parked, a failed read) is unconfirmed: "being confirmed", and the end's owner keeps retrying it through the gateway.
      if (!await stripeEndConfirmed(env, sub.subscription_id)) {
        let live: Awaited<ReturnType<StripeClient["getSubscription"]>>;
        try { live = await stripe.getSubscription(sub.subscription_id); } catch { throw new CancelUnconfirmed(); }
        if (live.status !== "canceled" && live.status !== "incomplete_expired") throw new CancelUnconfirmed();
        await fencedBatch(env, lease, [markEndedQ(homeId, sub.subscription_id, now)]);
      }
      return { cancel: true, periodEnd: sub.current_period_end ?? null };
    }
    const subId = sub.subscription_id;
    // Astra JOURNEY-BCORE-4 #1: parked on an attached schedule: nothing is sent (an operator resolves it); the intent stays journaled, unconfirmed.
    if (await scheduleParked(env, subId)) throw new CancelUnconfirmed();
    // Once a customer's cancellation was confirmed for this subscription id it is final: the intent is cancelled whatever else is recorded.
    const terminal = sub.cancel_terminal_sub === subId;
    const rev = sub.cancel_intent_rev; const want = terminal || await desiredCancel(env, sub);
    // 1. Settle every outstanding mutation, each by its OWN recorded request and original idempotency key, before anything newer is
    //    decided. A request an older holder sent and may not have finished can still land at Stripe after we read the subscription, so
    //    reading the current state proves nothing about it. Sending the same request again with the same key makes Stripe either apply
    //    it now (in front of the newer intent, which follows) or return its saved answer; either way that key can never change the
    //    subscription later. A key still in flight at Stripe answers with an error, and the whole step is retried.
    const open = await env.DB.prepare(`SELECT id,desired_cancel,idempotency_key,created_at,dispatched_at FROM sub_mutations WHERE home_id=? AND subscription_id=? AND state='pending'
      ORDER BY created_at, rowid`).bind(homeId, subId).all<{ id: string; desired_cancel: number; idempotency_key: string; created_at: number; dispatched_at: string | null }>();
    let supersededNow = false;
    // Astra JOURNEY-B-2 #1: while a deletion of the home waits, renewal is never asked of Stripe. A pending renew request (a Keep whose answer
    // was lost) is settled by sending its key with the END instead: Stripe either applies the end under that key (so the old renew request
    // can never land later: its key is spent) or refuses the changed parameters because the key was already used (definitive); either way
    // cancel_at_period_end=false is never sent and that key can never change the subscription afterwards.
    // Astra JOURNEY-B-3 #1 / B-4 #1 / B-5 #1: only an AUTHORITATIVE answer settles a pending renew request: Stripe answered for that key (2xx,
    // a replayed cached answer, a 400 idempotency refusal: the key is spent), or Stripe, read live now, shows the subscription ENDED (nothing
    // can renew it) and no attempt under the key is younger than STRIPE_ATTEMPT_MAX_AGE_MS (answered attempts do not count). A generic failure (429, a fresh 5xx, a network
    // error, still in flight) and a validation 400 prove nothing (neither consumes the key: a delayed attempt can still land), whatever the
    // row's age: the mutation stays pending, nothing is called synced, and the sweep settles it next. A row stuck beyond a day is reported
    // to ops (cancel.key_unsettled) and stays pending.
    const deletionWaits = want && (await env.DB.prepare(`SELECT 1 AS x FROM cloud_recovery_holds WHERE home_id=? AND action='delete' AND completed_at IS NULL
      AND canceled_at IS NULL`).bind(homeId).first()) !== null;
    // `sentAt`: the attempt just sent under the key. Stripe answered it (a 4xx: refused, nothing done) or its outcome is unknown (a network
    // error, still in flight, a 5xx): then it is outstanding from that moment too.
    const unsettled = async (e: unknown, m: { id: string; desired_cancel: number; created_at: number; dispatched_at: string | null }, sentAt: number): Promise<boolean> => {
      if (now - m.created_at >= UNSETTLED_KEY_ALERT_MS) {
        await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
          .bind(`cancel.key_unsettled:${m.id}`, homeId, "cancel.key_unsettled", "high", JSON.stringify({ subscriptionId: subId, mutation: m.id,
            code: e instanceof StripeError ? e.code : "network" }), now).run();
      }
      // Verified terminal state: the subscription has ended at Stripe (it can never be renewed again), and every attempt is too old to still
      // be on its way. Only then is a renew request retired without its key's own answer.
      const outstanding = !(e instanceof StripeError) || e.meta.inFlight === true || e.status >= 500;
      const attempts = [...attemptsOf(m), ...(outstanding ? [sentAt] : [])];
      if (m.desired_cancel !== 0 || (attempts.length && Math.max(...attempts) > clock() - STRIPE_ATTEMPT_MAX_AGE_MS)) return false;
      let live: Awaited<ReturnType<StripeClient["getSubscription"]>>;
      try { live = await stripe.getSubscription(subId); } catch { return false; }
      if (live.status !== "canceled" && live.status !== "incomplete_expired") return false;
      // Astra JOURNEY-BCORE-7 #5: the ended subscription is persisted (markEndedQ) in the SAME batch, before any other fallible step: a Keep
      // that ran this sync answers too_late even when every later read fails.
      await fencedBatch(env, lease, [markEndedQ(homeId, subId, now),
        q("UPDATE sub_mutations SET state='superseded',resolved_at=?,provider_error=? WHERE id=? AND state='pending'", now,
          JSON.stringify({ status: e instanceof StripeError ? e.status : null, code: e instanceof StripeError ? e.code : "network", retired: "terminal", liveStatus: live.status }), m.id)]);
      supersededNow = true;
      return true;
    };
    for (const m of open.results) {
      await fence(env, lease);
      const sentAt = clock();
      await fencedRun(env, lease, DISPATCH_SQL, sentAt, m.id);
      if (deletionWaits && m.desired_cancel === 0) {
        // Astra JOURNEY-BCORE-6 #1: every write through the gateway; parked (between the check above and now): nothing sent, still unconfirmed.
        let parkedNow = false;
        try { parkedNow = (await writeSubscription(env, lease, stripe, subId, { kind: "cancel_at_period_end", value: true, key: m.idempotency_key })).parked; }
        catch (e) {
          if (e instanceof LeaseLost) throw e;
          if (attemptAnswered(e)) await fencedRun(env, lease, ANSWERED_SQL, m.id, sentAt);
          if (!keyAnswered(e) && !await unsettled(e, m, sentAt)) throw e;
        }
        if (parkedNow) throw new CancelUnconfirmed();
        await fencedRun(env, lease, "UPDATE sub_mutations SET state='superseded',resolved_at=? WHERE id=? AND state='pending'", now, m.id);
        supersededNow = true;
        continue;
      }
      let parkedNow = false;
      try { parkedNow = (await writeSubscription(env, lease, stripe, subId, { kind: "cancel_at_period_end", value: m.desired_cancel === 1, key: m.idempotency_key })).parked; }
      catch (e) {
        if (e instanceof LeaseLost) throw e;
        // Still being processed at Stripe under that key (409 idempotency_key_in_use), or a failure that did not settle the key (429, a fresh
        // 5xx, a network error, a validation 400; Astra JOURNEY-B-3 #1, JOURNEY-B-4 #1): its outcome is unknown, so nothing newer is decided.
        // The mutation stays pending; the caller reports "processing" and the sweep settles it next. One exception: an END request refused on
        // validation while the end is still wanted stays pending (if it lands later it only ends the plan, which is wanted) and the intent is
        // carried out below.
        // Astra JOURNEY-BCORE-1 #4: an attempt Stripe answered (a refusal) is not outstanding: it never refreshes the attempt-age gate.
        if (attemptAnswered(e)) await fencedRun(env, lease, ANSWERED_SQL, m.id, sentAt);
        if (!keyAnswered(e)) {
          if (await unsettled(e, m, sentAt)) continue;
          if (want && m.desired_cancel === 1 && validationRefusal(e)) { supersededNow = true; continue; }
          throw e;
        }
        // Stripe CACHES a failed answer against its idempotency key (a 500 included), so sending this key again can only return the same
        // failure, for as long as Stripe keeps the key. The answer is recorded with the mutation (status, code, replayed, request id), the
        // attempt is abandoned, and the intent is carried out below with a FRESH persisted key; Stripe's actual state is read back before
        // anything is called done. The subscription is re-read once more by the next sweep. Repeated failures are escalated to ops.
        await fencedRun(env, lease, "UPDATE sub_mutations SET state='superseded',resolved_at=?,provider_error=? WHERE id=? AND state='pending'", now,
          JSON.stringify({ status: e.status, code: e.code, type: e.meta.type ?? null, replayed: e.meta.replayed ?? false, requestId: e.meta.requestId ?? null }), m.id);
        await providerFailing(env, homeId, subId, e, now);
        supersededNow = true;
        continue;
      }
      if (parkedNow) throw new CancelUnconfirmed();
      await fencedRun(env, lease, "UPDATE sub_mutations SET state='confirmed',resolved_at=? WHERE id=? AND state='pending'", now, m.id);
      if (m.desired_cancel === 0) supersededNow = true; // a renewal request was settled just now: one more read-back by the next sweep
    }
    let got = await stripe.getSubscription(subId);
    // Astra JOURNEY-BCORE-1 #4: the subscription has ENDED at Stripe (authoritative, read now): nothing can renew or be cancelled any more, so
    // nothing is sent (an update of a canceled subscription is refused). The local status is set from Stripe's state, with the intent synced.
    if (got.status === "canceled" || got.status === "incomplete_expired") {
      await fencedRun(env, lease, `UPDATE billing_subscriptions SET ${FORWARD_STATUS},${FORWARD_ENDED_AT},${STRIPE_ENDED_SET},cancel_synced_rev=CASE WHEN cancel_intent_rev=? THEN ? ELSE cancel_synced_rev END,
        cancel_verified_at=?,cancel_verify_dirty=0,cancel_sync_failures=0,cancel_sync_next_at=NULL,updated_at=? WHERE home_id=? AND subscription_id=?`,
      statusRank("canceled"), "canceled", statusRank("canceled"), "canceled", now, rev, rev, now, now, homeId, subId);
      return { cancel: true, periodEnd: typeof got.current_period_end === "number" ? got.current_period_end * 1000 : sub.current_period_end };
    }
    // 2. Stripe's actual state against the intent. A cancellation is applied at once and read back; if a racing request flipped it, it is
    //    applied again with a fresh key, a few times, inside this same leased operation (the repair sweep is not relied on).
    let restart = false;
    for (let attempt = 0; Boolean(got.cancel_at_period_end) !== want; attempt++) {
      if (attempt >= 3) {
        await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
          .bind(crypto.randomUUID(), homeId, "cancel.unconfirmed", "high", JSON.stringify({ subscriptionId: subId, want }), now).run();
        throw new CancelUnconfirmed();
      }
      const mid = crypto.randomUUID();
      const key = `submut:${mid}`;
      await fencedRun(env, lease, "INSERT INTO sub_mutations (id,home_id,subscription_id,desired_cancel,idempotency_key,state,created_at,dispatched_at) VALUES (?,?,?,?,?,'pending',?,'[]')",
        mid, homeId, subId, want ? 1 : 0, key, now);
      await fence(env, lease);
      // A renewal request is refused here, before the Stripe call, if the cancellation became final since the intent was read.
      if (!want && (await getSub(env, homeId))?.cancel_terminal_sub === subId) {
        await fencedRun(env, lease, "UPDATE sub_mutations SET state='superseded',resolved_at=? WHERE id=? AND state='pending'", now, mid);
        restart = true; break; // the intent is read again
      }
      const sentAt = clock();
      await fencedRun(env, lease, DISPATCH_SQL, sentAt, mid);
      let parkedNow = false;
      try { parkedNow = (await writeSubscription(env, lease, stripe, subId, { kind: "cancel_at_period_end", value: want, key })).parked; }
      catch (e) {
        if (e instanceof LeaseLost) throw e;
        if (attemptAnswered(e)) await fencedRun(env, lease, ANSWERED_SQL, mid, sentAt);
        // Stripe refused THIS request on validation (it will not change this subscription's cancel_at_period_end): its only attempt was answered
        // and nothing was saved under its fresh key, so it can never land; it is closed with the refusal recorded. The intent stays journaled
        // and unconfirmed (the caller reports pending, the sweep tries again); repeated refusals are escalated (cancel.provider_failing).
        if (validationRefusal(e)) {
          await fencedRun(env, lease, "UPDATE sub_mutations SET state='superseded',resolved_at=?,provider_error=? WHERE id=? AND state='pending'", now,
            JSON.stringify({ status: e.status, code: e.code, type: e.meta.type ?? null, replayed: false, requestId: e.meta.requestId ?? null }), mid);
          await providerFailing(env, homeId, subId, e, now);
          // Astra JOURNEY-BCORE-2 #5: a refusal (a schedule holds the subscription) just leaves the cancellation pending. The cancellation's own
          // generation-bound resolution (cancel_resolutions, written with the intent) ends the subscription at the promised end; nothing is released early.
        }
        throw e;
      }
      if (parkedNow) throw new CancelUnconfirmed();
      got = await stripe.getSubscription(subId); // read back the end state
      if (Boolean(got.cancel_at_period_end) === want) await fencedRun(env, lease, "UPDATE sub_mutations SET state='confirmed',resolved_at=? WHERE id=? AND state='pending'", now, mid);
      else { supersededNow = true; await fencedRun(env, lease, "UPDATE sub_mutations SET state='superseded',resolved_at=? WHERE id=? AND state='pending'", now, mid); }
    }
    if (restart) continue;
    // Astra JOURNEY-BCORE-2 #2 (outage recovery): the cancellation promised an end (cancel_promised_end, frozen when it was pressed) and Stripe's
    // period now ends LATER than that promise (a renewal happened before this sync could run). The later end is never confirmed or announced
    // as the customer's: the intent stays unconfirmed. The cancellation's resolution is due at its OWN frozen promise (less the precision) and
    // nothing here moves it: Astra JOURNEY-BCORE-3 #1, a later Stripe period never advances the resolution (the resolver also re-checks the
    // date under the lease before any destructive call). A charge for time after the promise is recorded from there (cancel-charges.ts).
    const stripeEnd = typeof got.current_period_end === "number" ? got.current_period_end * 1000 : null;
    // Astra JOURNEY-BCORE-7 #2: a cancellation accepted with its promise pending reconciliation (the cached period end had passed) gets it
    // HERE, from Stripe's live period read just now, frozen with its obligation in one batch, before anything is confirmed or announced.
    if (want && sub.customer_cancel_at !== null && sub.cancel_promised_end == null && stripeEnd !== null) {
      await fencedBatch(env, lease, [q(`UPDATE billing_subscriptions SET cancel_promised_end=?,current_period_end=MAX(COALESCE(current_period_end,0),?)
        WHERE home_id=? AND subscription_id=? AND customer_cancel_at IS NOT NULL AND cancel_promised_end IS NULL AND cancel_intent_rev=?`, stripeEnd, stripeEnd, homeId, subId, rev),
      ...inAppResolutionQ(homeId, now)]);
      continue; // read again: the promise now stands (or a newer intent moved on)
    }
    if (want && sub.customer_cancel_at !== null && sub.cancel_promised_end != null && stripeEnd !== null && stripeEnd > sub.cancel_promised_end + RESOLUTION_PRECISION_MS) {
      throw new CancelUnconfirmed();
    }
    const periodEnd = typeof got.current_period_end === "number" ? got.current_period_end * 1000 : sub.current_period_end;
    // Told once: when this sync is the one that moved the confirmed state to "cancelled" (a later re-verification sends nothing).
    const wasConfirmed = sub.cancel_at_period_end === 1 && sub.cancel_synced_rev === rev;
    const tell = want && sub.customer_cancel_at !== null && !wasConfirmed;
    const notice = tell ? cancelledNotice(env, periodEnd, await cancellationReference(env, homeId, subId), await homeIsDeleting(env, homeId), `${subId}:${sub.customer_cancel_at}`) : null;
    const [written] = await fencedBatch(env, lease, [q(`UPDATE billing_subscriptions SET cancel_at_period_end=?,current_period_end=COALESCE(?,current_period_end),cancel_synced_rev=?,
      cancel_verified_at=?,cancel_verify_dirty=?,cancel_terminal_sub=CASE WHEN customer_cancel_at IS NOT NULL AND ?=1 THEN subscription_id ELSE cancel_terminal_sub END,
      cancel_sync_failures=0,cancel_sync_next_at=NULL,updated_at=? WHERE home_id=? AND cancel_intent_rev=? AND subscription_id=?`,
    // A mutation superseded just now may still be in flight: the subscription stays marked for one more read-back by the next sweep.
    want ? 1 : 0, periodEnd, rev, now, supersededNow ? 1 : 0, want ? 1 : 0, Date.now(), homeId, rev, subId),
    // The confirmation email is recorded in the SAME transaction as the confirmed state (Astra MAKERKIT2 #3).
    ...(notice ? [recordNotice(homeId, "cancel_scheduled", notice.key, notice.data, now, true)] : [])]);
    if ((written.meta.changes ?? 0) === 1) {
      // The cancellation is confirmed HERE, by Stripe's read-back (cancel_at_period_end=true on the retained subscription), and only here is
      // the customer told. Its notice is already recorded; a send that fails is retried by the sweep; the cancellation stands.
      if (notice) await notifyCancelled(env, { ...deps, lease }, homeId, notice);
      return { cancel: want, periodEnd };
    }
    await fence(env, lease); // the intent moved on meanwhile (or the lease went): sync the newest intent
  }
  throw new Error("cancel_intent_churn");
}

export async function billingRoute(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/v1/billing/")) return null;
  if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
  if (path === "/v1/billing/webhook") return stripeWebhook(request, env, deps);
  if (path === "/v1/billing/reserve") return reserveHomeRoute(request, env, deps, auth);
  if (path === "/v1/billing/checkout") return createCheckout(request, env, deps, auth);
  if (path === "/v1/billing/portal") return createPortal(request, env, deps, auth);
  if (path === "/v1/billing/snapshot-receipt") return recordSnapshotReceipt(request, env);
  return null;
}
export { signStripePayload };
