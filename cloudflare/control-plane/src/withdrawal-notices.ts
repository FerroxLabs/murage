// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP9: emailed withdrawal notices. Plan 5.3 (1)-(5b); SUPPORT-DESIGN 4.5 "Execute withdrawal (5a)"; BUILD-PLAN WP9 and C.1.
//
//   POST /v1/admin/withdrawals/intake                    operator (staging stand-in for the support gateway): records a notice with its legal receipt
//   GET  /v1/admin/withdrawals[/{id}]                    the deadline-aware queue (the dated (5a) item, due today, overdue, escalated)
//   POST /v1/admin/withdrawals/{id}/execute              "Execute withdrawal" (5a): the same conditional transition as the confirm click
//   POST /v1/admin/withdrawals/{id}/classify             reclassify by intent: raises classification_rev, kills the confirm/repudiate links
//   POST /v1/admin/withdrawals/{id}/link                 operator links an unmatched notice to an account (P1): only sends a link
//   POST /v1/admin/withdrawals/{id}/acknowledge-alert    stops the day-13 alert retries
//   POST /v1/public/withdrawal/confirm | repudiate | new-link, POST /v1/public/token/lookup   (registered through registerPublicHandlers)
//   POST /v1/account/notices/{id}/confirm                signed-in confirmation of a notice classified `withdrawal`
//
// The notice state machine (one conditional UPDATE per edge, in ONE fenced batch with the token consumption, the authorization record and the
// withdrawal/refund rows; the loser of a race writes nothing):
//   open -> executing   confirm link | signed-in confirm | Execute            (classification='withdrawal', eligibility_at in the window)
//   open -> repudiated  "This wasn't me" (consumes the repudiate token, opens a case, suspends execution)
//   executing -> completed   only when the refund operation is done (the withdrawal itself is complete)
//   repudiated -> executing  the holder confirms signed in (ordinary sign-in, aal1: owner decision r13d; never step-up)
//   repudiated -> kept       no answer by received_at + 14 days
// Rules this file keeps:
//  - received_at is the legal receipt and the withdrawal's effective time; eligibility_at (earlier of received_at and an ACCEPTED sent_at) is the one time
//    every eligibility check uses; the refund deadline runs from received_at.
//  - A notice is "from the holder" only when OUR boundary's SPF and DKIM pass aligned to the sole From domain, the From matches the account address
//    (normalised), that address was the account's since before received_at, and the sender enforces the mailbox. Anything else is (5b).
//  - Execute is refused after execute_by (23:59:59 UTC on date(received_at)+13). Every customer sentence renders from the COMMITTED state.
import { z } from "zod";
import { admin } from "./b3-control";
import { cfg, stubFluxHooks, type BillingDependencies } from "./b5-billing";
import { stripeClient, type StripeClient } from "./b5-stripe";
import { DB_NOW, fence, fencedBatch, HomeBusy, LeaseLost, q, withHomeLease, type HomeLease, type Q } from "./billing-lease";
import { fmtReceived, type Lang } from "./cancellation-strings";
import { senderOrFail, type TransactionalEmailSender } from "./email";
import { HTTPError, errorResponse, json, readBoundedJSON, type JSONValue } from "./http";
import { consentIsEu, type ConsentRow } from "./legal-flows";
import { advanceRefundOp, getRefundOp, refundOpInsert, type RefundContext, type RefundOpRow } from "./legal-refunds";
import { deliver as deliverAlert, MAX_DELIVERY_ATTEMPTS, post as postAlert, raiseAlert, resolveAlert, resolveAlertUnless } from "./ops-monitor";
import { currentPublicHandlers, registerPublicHandlers, type LookupDetails, type PublicRouteHandler } from "./public-routes";
import { commitToken, lostCommitRefusal, readerOf, reserveMail, prepareToken, stillUnused, WHEN_CONSUMED, type IdentityReader, type TokenDeps, type Refusal, type TokenRow, type Verified } from "./public-tokens";
import { parseFrom } from "./mail-address";
import { normalizeEmail } from "./refund-identity";
import { refundLine, refundState } from "./refund-kinds";
import { sellerOfConsent } from "./seller";
import { applyServiceLog } from "./service-intervals";
import { fmtExecuteByDate, t } from "./notice-strings";
import { accountSession, type ControlPlaneAuth } from "./auth";

// --- deps, constants, rows -----------------------------------------------------------------------------------------------------------

export interface NoticeDeps extends TokenDeps {
  stripe?: StripeClient | null;
  mailer?: TransactionalEmailSender | null;
  billing?: BillingDependencies;
  siteOrigin?: string;
  /** The alert webhook's fetch (tests). */
  fetcher?: typeof fetch;
}
let injected: NoticeDeps = {};
/** Production wires `billing` once; tests inject fakes (stripe, reader, mailer, now, fetcher). */
export const setNoticeDeps = (d: NoticeDeps) => { injected = d; };
export const noticeDeps = (): NoticeDeps => injected;

/** WP10 plugs in here (clarify.ts): the ask / correction / clarified mails, the filing of a candidate's renewal stop after a (re)classification, and
 *  its own sweep steps. Nothing in this file imports clarify.ts. */
export interface NoticeExtension {
  renderMail?: (env: Env, d: NoticeDeps, n: NoticeRow, kind: string, claim: MailClaim) => Promise<Mail | "skip" | "limited" | null>;
  afterChange?: (env: Env, d: NoticeDeps, id: string, hint?: { requestedDate?: string }) => Promise<void>;
  sweep?: (env: Env, d: NoticeDeps) => Promise<void>;
  /** r1-8: the withdrawal of this notice ended the plan (its refund operation cancelled the subscription). */
  afterPlanEnded?: (env: Env, d: NoticeDeps, id: string) => Promise<void>;
  /** A cached payload is re-checked (state, revision, recipient) before it is sent. */
  stillValid?: (env: Env, d: NoticeDeps, n: NoticeRow, kind: string, mail: Mail) => Promise<boolean | null>;
}
let extension: NoticeExtension = {};
export const registerNoticeExtension = (e: NoticeExtension) => { extension = e; };
export const clockOf = (d: NoticeDeps) => (d.now ?? Date.now)();

const DAY = 86_400_000;
const HOUR = 3_600_000;
export const ALERT_RETRY_MS = 15 * 60_000;
export const REMINDER_AFTER_MS = 3 * DAY;

export type NoticeState = "open" | "executing" | "completed" | "repudiated" | "kept";
export type Classification = "withdrawal" | "cancellation" | "candidate" | "support" | "unclear";
export type VerificationKind = "trusted" | "same_address_failed" | "other_sender";
export interface NoticeRow {
  id: string; received_at: number; received_basis: string; received_flagged: number; sent_at: number | null; sent_basis: string | null; sent_evidence_ref: string | null;
  sent_accepted_by: string | null; sent_accepted_at: number | null; eligibility_at: number; classification: Classification; classification_rev: number;
  classification_basis: string | null; state: NoticeState; sender: string; sender_count: number; sender_was_account_email: number; sender_auth: string;
  sender_trusted: number; subject_hash: string | null; body_hash: string | null; message_id: string | null; language: Lang;
  match_state: "pending" | "matched" | "unmatched" | "ambiguous"; match_note: string | null; account_id: string | null; supabase_sub: string | null; home_id: string | null;
  consent_id: string | null; subscription_id: string | null; plan_name: string | null; plan_started_at: number | null; verification_kind: VerificationKind | null;
  verification_sent_at: number | null; coalesced_into: string | null; repudiated_at: number | null; case_id: string | null; executed_via: string | null;
  executing_at: number | null; completed_at: number | null; withdrawal_id: string | null; refund_op_id: string | null; execute_by: number; item_raised_at: number | null;
  overdue_at: number | null; alert_raised_at: number | null; alert_acked_at: number | null; alert_acked_by: string | null; alert_attempts: number; alert_last_at: number | null; alert_rev: number | null;
  correction_due: number; last_op: string | null; created_at: number; updated_at: number;
  /** WP10: what the notice was settled with, and the §5.2 cancellation scheduled for it. */
  clarified_action: "withdraw_now" | "cancel_at_end" | null; clarified_at: number | null; cancellation_request_id: string | null;
  /** WP10 r1: the candidate question is still open (set whenever the notice is labelled `candidate`, cleared only by the holder's answer; a later
   *  label never clears it), and the revision the outstanding ask links are bound to (NULL once the notice is labelled `withdrawal`). */
  candidate_obligation: number; ask_rev: number | null;
  /** WP10 r1-5: the end date the operator read out of the message (YYYY-MM-DD), kept so the cancellation follows it. */
  requested_date: string | null;
}
/** WP10 r1-3: what a clarify press needs of its notice AT the consume: open, undecided, unsettled, matched, at the bound revision. The same text
 *  is the consume's guard and the transition's WHERE, so a press that loses a race with a reclassification consumes nothing. */
export const clarifyGuard = (noticeId: string, rev: number): [string, ...unknown[]] =>
  [`EXISTS (SELECT 1 FROM withdrawal_notices WHERE id=? AND state='open' AND clarified_action IS NULL AND classification<>'withdrawal' AND match_state='matched'
    AND classification_rev=?)`, noticeId, rev];
/** r2-1: the bound revision is EXACTLY the notice's current one, for the consume and for the transition alike (a stale ask_rev never passes:
 *  a guard that accepted it while the transition did not consumed the link and authorised nothing). A wrong label still never takes the holder's
 *  choice away: a relabelled candidate keeps its obligation and is sent fresh choices bound to the new revision (WP10 afterChange). */
export const clarifyRevOk = (n: Pick<NoticeRow, "classification_rev" | "candidate_obligation" | "ask_rev" | "classification">, rev: number) =>
  n.classification_rev === rev;
export const load = (env: Env, id: string) => env.DB.prepare("SELECT * FROM withdrawal_notices WHERE id=?").bind(id).first<NoticeRow>();

// --- time -----------------------------------------------------------------------------------------------------------------------------

export const utcDayStart = (ms: number) => Math.floor(ms / DAY) * DAY;
/** 23:59:59 UTC on date(received_at) + 13: one moment for the shown date and the server cutoff. */
export const executeByOf = (receivedAt: number) => utcDayStart(receivedAt) + 13 * DAY + 23 * HOUR + 59 * 60_000 + 59_000;
/** The dated (5a) item appears at the start of day 12, the "refund due today" alert at the start of day 13 (UTC). */
export const itemAtOf = (receivedAt: number) => utcDayStart(receivedAt) + 12 * DAY;
export const alertAtOf = (receivedAt: number) => utcDayStart(receivedAt) + 13 * DAY;
/** The 23:59:59 second itself is still inside. */
export const pastDeadline = (n: Pick<NoticeRow, "execute_by">, now: number) => now >= n.execute_by + 1000;
/** Exclusive end of the statutory window: AoE (UTC-12) end of date(contract made) + 14 (plan 4.1). */
export const windowEndOf = (madeAt: number) => utcDayStart(madeAt) + 15 * DAY + 12 * HOUR;
export const dateOnly = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// --- sender trust (plan 5.3 (1)) ---------------------------------------------------------------------------------------------------------

/** What OUR receiving boundary says. Authentication-Results already inside the message are never part of this. */
export interface BoundaryAuth {
  source: "boundary";
  spf?: { result: string; domain?: string };
  dkim?: { result: string; domain?: string };
  /** Evidence reference that the sending service enforces the From mailbox (the local part), when the provider is not on the list. */
  mailboxEnforcement?: string;
}
/** Providers that enforce the From mailbox and sign with their own domain (the one list of plan 5.3 and the support design). */
export const MAILBOX_ENFORCING_DOMAINS: readonly string[] = ["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com",
  "mac.com", "fastmail.com", "fastmail.fm", "proton.me", "protonmail.com", "pm.me"];
export interface TrustResult { trusted: boolean; failed: string | null; sameAddress: boolean }
/** The sole mailbox of the From field, or null (none, several, or a field that does not parse). The display name is never read (r1-1). */
export const soleFrom = (froms: readonly string[]): string | null => {
  const p = parseFrom(froms);
  return p.valid && p.mailboxes.length === 1 ? p.mailboxes[0].toLowerCase() : null;
};
const domainOf = (addr: string): string | null => {
  const at = addr.lastIndexOf("@");
  if (at <= 0 || at === addr.length - 1) return null;
  try { return new URL(`http://${addr.slice(at + 1).normalize("NFC")}`).hostname.replace(/\.$/, "") || null; } catch { return null; }
};
/** Pure. `account` is the stored address of the matched account and since when it has been that (null: no account). */
export function senderTrusted(boundary: BoundaryAuth | null | undefined, froms: string[], account: { contactEmail: string; heldSince: number } | null, receivedAt: number): TrustResult {
  const parsed = parseFrom(froms);
  const from = soleFrom(froms);
  const norm = from ? normalizeEmail(from) : null;
  const sameAddress = Boolean(norm && account && normalizeEmail(account.contactEmail) === norm);
  const fail = (failed: string): TrustResult => ({ trusted: false, failed, sameAddress });
  if (!from) return fail(parsed.valid && parsed.mailboxes.length > 1 ? "more_than_one_from" : "from_unparseable");
  const fromDomain = domainOf(from);
  if (!fromDomain || !norm) return fail("from_unparseable");
  if (!boundary || boundary.source !== "boundary") return fail("no_boundary_auth");
  // Both sides in their ASCII (IDN) form.
  const aligned = (dm?: string) => Boolean(dm?.trim()) && domainOf(`x@${dm!.trim().toLowerCase()}`) === fromDomain;
  if (boundary.spf?.result !== "pass" || !aligned(boundary.spf.domain)) return fail("spf");
  if (boundary.dkim?.result !== "pass" || !aligned(boundary.dkim.domain)) return fail("dkim");
  if (!account || !sameAddress) return fail("address_mismatch");
  if (!(account.heldSince < receivedAt)) return fail("address_not_held_since");
  const enforcing = MAILBOX_ENFORCING_DOMAINS.includes(fromDomain) || Boolean(boundary.mailboxEnforcement?.trim());
  if (!enforcing) return fail("no_mailbox_enforcement");
  return { trusted: true, failed: null, sameAddress };
}

// --- small helpers ----------------------------------------------------------------------------------------------------------------------

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (x) => x.toString(16).padStart(2, "0")).join("");
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const siteOrigin = (env: Env, d: NoticeDeps) => d.siteOrigin ?? (env as unknown as { SITE_ORIGIN?: string }).SITE_ORIGIN ?? "https://murage.ai";
function stripeOf(env: Env, d: NoticeDeps): StripeClient | null {
  if (d.stripe !== undefined) return d.stripe;
  try { return stripeClient(cfg(env)); } catch { return null; }
}
function mailerOf(env: Env, d: NoticeDeps): TransactionalEmailSender {
  return d.mailer ?? senderOrFail(env);
}
/** The home's billing lease for an interactive action, with a few short retries (a press is not turned away by a race it would win a moment later). */
export async function leased<T>(env: Env, homeId: string, work: (lease: HomeLease) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try { return await withHomeLease(env, homeId, work); }
    catch (e) { if (!(e instanceof HomeBusy) || attempt >= 8) throw e; await new Promise((r) => setTimeout(r, 40 * attempt)); }
  }
}
export const event = (noticeId: string, kind: string, actor: string, detail: unknown, now: number): Q =>
  q("INSERT INTO withdrawal_notice_events (id,notice_id,at,kind,actor,detail) VALUES (?,?,?,?,?,?)", crypto.randomUUID(), noticeId, now, kind, actor, JSON.stringify(detail ?? {}));
export const eventWhen = (cond: string, noticeId: string, kind: string, actor: string, detail: unknown, now: number, ...condBinds: unknown[]): Q =>
  q(`INSERT INTO withdrawal_notice_events (id,notice_id,at,kind,actor,detail) SELECT ?,?,?,?,?,? WHERE ${cond}`, crypto.randomUUID(), noticeId, now, kind, actor, JSON.stringify(detail ?? {}), ...condBinds);
/** `EXISTS(...)` text and binds: this notice is the one THIS operation just changed. */
export const mine = (noticeId: string, opId: string, state: string): [string, string, string, string] =>
  ["EXISTS (SELECT 1 FROM withdrawal_notices WHERE id=? AND last_op=? AND state=?)", noticeId, opId, state];

// --- contract and account lookup ---------------------------------------------------------------------------------------------------------

type ContractRow = ConsentRow & { stripe_subscription_id: string | null };
const madeAtOf = (c: Pick<ConsentRow, "contract_made_at" | "completed_at">) => c.contract_made_at ?? c.completed_at ?? 0;
/** No end yet (plan 4.1: "+infinity while service_start_at is null"). A bindable number, so the same value can sit in SQL. */
export const OPEN_ENDED = Number.MAX_SAFE_INTEGER;
/** WP5's per-consent payment moment (checkout_consents.paid_at, written once), read off the row when that column exists. */
type WithMoments = ContractRow & { paid_at?: number | null };
/** r3-3: a payment moment in milliseconds after 2001-09-09 (rules out seconds, zero and negatives). */
const validPaidAt = (p: unknown): p is number => typeof p === "number" && Number.isSafeInteger(p) && p >= 1_000_000_000_000;
/** The guarantee anchor of one contract (plan 4.1, r1-4; r2-1):
 *  - set: the date the 14-day guarantee runs from (the original purchase from its service start, a replacement for a server that was already
 *    running from its payment), taken only from immutable per-contract evidence;
 *  - pending: genuinely not set yet (the contract's subscription is the home's current one and its payment or provisioning is still pending, or
 *    no subscription exists yet), so the guarantee has no end yet;
 *  - missing: the contract was superseded and its evidence was never kept. Never "+infinity": the statutory window alone applies and a notice
 *    that would need more is a case. */
export type GuaranteeAnchor = { kind: "set"; at: number } | { kind: "pending" } | { kind: "missing" };
const isCurrentSub = async (env: Env, homeId: string, sub: string) =>
  Boolean(await env.DB.prepare("SELECT 1 AS x FROM billing_subscriptions WHERE home_id=? AND subscription_id=?").bind(homeId, sub).first());
const freezeStmt = (consentId: string, sub: string, paidAt: number, source: string, now: number): Q =>
  q("INSERT OR IGNORE INTO contract_deadlines (consent_id,subscription_id,paid_at,source,frozen_at) VALUES (?,?,?,?,?)", consentId, sub, paidAt, source, now);
/** The contract's payment moment from immutable evidence: WP5's consent.paid_at, else the frozen record, else the billing row while it is still
 *  THIS contract's subscription (and that reading is frozen at once). A frozen record for another subscription contradicts the contract's own
 *  record: "conflict" (r3-3), which is missing evidence and a case, never "pending". */
async function contractPaidAt(env: Env, c: WithMoments, sub: string): Promise<number | undefined | "conflict"> {
  if (typeof c.paid_at === "number") return c.paid_at;
  const frozen = await env.DB.prepare("SELECT subscription_id AS s, paid_at AS p FROM contract_deadlines WHERE consent_id=?").bind(c.id).first<{ s: string; p: number }>();
  if (frozen) return frozen.s === sub && validPaidAt(frozen.p) ? frozen.p : "conflict";
  const cur = await env.DB.prepare("SELECT first_paid_at AS p FROM billing_subscriptions WHERE home_id=? AND subscription_id=?").bind(c.home_id, sub).first<{ p: number | null }>();
  // r3-3: only a plausible payment moment (positive integer milliseconds) is ever frozen; the migration 0081 trigger checks the same and more.
  if (cur?.p === null || cur?.p === undefined || !validPaidAt(cur.p)) return undefined;
  const [sql, binds] = freezeStmt(c.id, sub, cur.p, "observed", Date.now());
  await env.DB.prepare(sql).bind(...(binds ?? [])).run();
  return cur.p;
}
/** SQL for the sweep: freeze the payment moment of every contract whose subscription is still the home's current one (r2-1). */
export const FREEZE_PAID_SQL = `INSERT OR IGNORE INTO contract_deadlines (consent_id,subscription_id,paid_at,source,frozen_at)
  SELECT c.id, b.subscription_id, b.first_paid_at, 'billing', ? FROM checkout_consents c JOIN billing_subscriptions b ON b.home_id=c.home_id
  WHERE c.completed_at IS NOT NULL AND b.first_paid_at IS NOT NULL AND typeof(b.first_paid_at)='integer' AND b.first_paid_at>=1000000000000 AND b.subscription_id IS NOT NULL
    AND b.subscription_id=COALESCE(c.stripe_subscription_id,(SELECT l.subscription_id FROM contract_links l WHERE l.consent_id=c.id))
    AND NOT EXISTS (SELECT 1 FROM contract_deadlines x WHERE x.consent_id=c.id)`;
export async function guaranteeAnchor(env: Env, c: ContractRow): Promise<GuaranteeAnchor> {
  const sub = c.stripe_subscription_id ?? (await env.DB.prepare("SELECT subscription_id FROM contract_links WHERE consent_id=?").bind(c.id).first<{ subscription_id: string | null }>())?.subscription_id ?? null;
  if (!sub) return { kind: "pending" };
  const made = madeAtOf(c);
  const replacing = await env.DB.prepare(`SELECT 1 AS x FROM service_intervals WHERE home_id=? AND (subscription_id IS NULL OR subscription_id<>?) AND started_at<? AND (ended_at IS NULL OR ended_at>?)`)
    .bind(c.home_id, sub, made, made).first();
  if (replacing) {
    const paid = await contractPaidAt(env, c, sub);
    if (paid === "conflict") return { kind: "missing" };
    if (paid !== undefined) return { kind: "set", at: paid };
  } else {
    // The lifecycle's service journal may not be applied yet: its first start counts as well. Both are kept per subscription (history).
    const start = await env.DB.prepare(`SELECT MIN(s) AS s FROM (SELECT MIN(started_at) AS s FROM service_intervals WHERE home_id=? AND subscription_id=?
        UNION ALL SELECT MIN(at) AS s FROM service_interval_log WHERE home_id=? AND subscription_id=? AND kind='start')`).bind(c.home_id, sub, c.home_id, sub).first<{ s: number | null }>();
    if (start?.s !== null && start?.s !== undefined) return { kind: "set", at: start.s };
  }
  // Not set: pending only while this contract's subscription is still the home's current one; a superseded contract without kept evidence is missing.
  return await isCurrentSub(env, c.home_id, sub) ? { kind: "pending" } : { kind: "missing" };
}
export interface WithdrawalWindow { end: number; evidence: GuaranteeAnchor["kind"] }
/** Exclusive end of the withdrawal window (plan 4.1): the later of the statutory window (from the contract's conclusion) and the guarantee
 *  window (from its anchor); OPEN_ENDED while the anchor is genuinely pending; the statutory window alone when the evidence is missing. */
export async function withdrawalWindow(env: Env, c: ContractRow): Promise<WithdrawalWindow> {
  const statutory = windowEndOf(madeAtOf(c));
  const a = await guaranteeAnchor(env, c);
  if (a.kind === "pending") return { end: OPEN_ENDED, evidence: "pending" };
  if (a.kind === "missing") return { end: statutory, evidence: "missing" };
  return { end: Math.max(statutory, windowEndOf(a.at)), evidence: "set" };
}
export async function withdrawalWindowEnd(env: Env, c: ContractRow): Promise<number> {
  return (await withdrawalWindow(env, c)).end;
}
export type Eligibility = "eligible" | "not_eligible" | "evidence_missing";
/** At `at` (a notice's eligibility_at): a completed EU/EEA/UK contract made by then whose window had not ended. Past the statutory window with the
 *  guarantee evidence missing: not eligible, and the caller opens a case (r2-1). */
async function eligibilityAt(env: Env, c: ContractRow, at: number): Promise<Eligibility> {
  if (c.completed_at === null || !consentIsEu(c) || madeAtOf(c) > at) return "not_eligible";
  const w = await withdrawalWindow(env, c);
  if (at < w.end) return "eligible";
  return w.evidence === "missing" ? "evidence_missing" : "not_eligible";
}
type Found = { kind: "one"; consent: ContractRow } | { kind: "none"; evidenceMissing: boolean } | { kind: "many" };
/** The contract the notice falls under, found by its OWN window (eligibility_at), never "the latest". */
async function findContract(env: Env, userId: string, at: number): Promise<Found> {
  const rows = (await env.DB.prepare("SELECT * FROM checkout_consents WHERE user_id=? AND completed_at IS NOT NULL").bind(userId).all<ContractRow>()).results;
  const hit: ContractRow[] = [];
  let evidenceMissing = false;
  for (const c of rows) {
    const e = await eligibilityAt(env, c, at);
    if (e === "eligible") hit.push(c);
    else if (e === "evidence_missing") evidenceMissing = true;
  }
  return hit.length === 1 ? { kind: "one", consent: hit[0] } : hit.length === 0 ? { kind: "none", evidenceMissing } : { kind: "many" };
}
interface AccountRef { userId: string; sub: string; contactEmail: string; heldSince: number }
async function accountRows(env: Env, where: string, ...binds: unknown[]): Promise<AccountRef[]> {
  const rows = (await env.DB.prepare(`SELECT s.user_id AS user_id, s.sub AS sub, s.contact_email AS email, s.created_at AS since,
      (SELECT MAX(e.at) FROM account_link_events e WHERE e.sub=s.sub AND e.kind='email_updated') AS moved
    FROM supabase_identities s WHERE s.contact_email IS NOT NULL AND ${where}`).bind(...binds).all<{ user_id: string; sub: string; email: string; since: number; moved: number | null }>()).results;
  return rows.map((r) => ({ userId: r.user_id, sub: r.sub, contactEmail: r.email, heldSince: Math.max(r.since, r.moved ?? 0) }));
}
async function accountByUser(env: Env, userIdOrSub: string): Promise<AccountRef | null> {
  const r = await accountRows(env, "(s.user_id=? OR s.sub=?)", userIdOrSub, userIdOrSub);
  return r.length === 1 ? r[0] : null;
}
/** Every account whose stored address is the sender's, comparing the CANONICAL form of both sides (normalizeEmail: case, Unicode form, the
 *  ASCII form of an IDN domain, googlemail = gmail, Gmail dots, "+tags" where the provider documents them). SQL cannot compute that form, so
 *  the stored addresses are read in pages and compared here; several matches are reported as several (ambiguity is kept). P2 (Astra WP9-1). */
const SENDER_PAGE = 500;
async function accountsBySender(env: Env, from: string): Promise<AccountRef[]> {
  const want = normalizeEmail(from);
  if (!want) return [];
  const hits: AccountRef[] = [];
  for (let after = ""; ;) {
    const page = (await env.DB.prepare(`SELECT sub, contact_email AS email FROM supabase_identities WHERE contact_email IS NOT NULL AND sub>? ORDER BY sub LIMIT ?`)
      .bind(after, SENDER_PAGE).all<{ sub: string; email: string }>()).results;
    for (const r of page) if (normalizeEmail(r.email) === want) hits.push(...await accountRows(env, "s.sub=?", r.sub));
    if (page.length < SENDER_PAGE) return hits;
    after = page[page.length - 1].sub;
  }
}

// --- intake -----------------------------------------------------------------------------------------------------------------------------

const hash = z.string().regex(/^[0-9a-f]{64}$/i);
const authPart = z.strictObject({ result: z.string().max(20), domain: z.string().max(255).optional() });
const intakeBody = z.strictObject({
  receivedAt: z.number().int().positive().optional(),
  receivedBasis: z.string().min(1).max(100).default("gateway"),
  receivedFlagged: z.boolean().optional(),
  from: z.array(z.string().max(320)).max(10),
  boundaryAuth: z.strictObject({ source: z.literal("boundary"), spf: authPart.optional(), dkim: authPart.optional(), mailboxEnforcement: z.string().max(200).optional() }).optional(),
  /** Authentication-Results found INSIDE the message. Accepted so the gateway can pass the raw header; never read. */
  messageAuthResults: z.unknown().optional(),
  sentAt: z.number().int().positive().optional(),
  sentBasis: z.string().max(60).optional(),
  sentEvidenceRef: z.string().max(300).optional(),
  sentAcceptedBy: z.string().max(100).optional(),
  subjectHash: hash.optional(), bodyHash: hash.optional(), messageId: z.string().max(300).optional(),
  language: z.enum(["en", "de"]).default("en"),
  classification: z.enum(["withdrawal", "cancellation", "candidate", "support", "unclear"]),
  classificationBasis: z.string().max(500).optional(),
  /** The operator links the notice to this account (control-plane user id) at intake (P1). */
  accountId: z.string().max(200).optional(),
});
/** Only these count as dispatch evidence (plan 5.3 (1)); a Date header, an unauthenticated lower Received header or a bare claim never does. */
export const ACCEPTED_SENT_BASES = ["provider_received_header", "bounce_report", "customer_provider_record", "postmark"] as const;

interface Matched { account: AccountRef | null; consent: ContractRow | null; state: NoticeRow["match_state"]; note: string }
async function matchNotice(env: Env, from: string | null, override: string | undefined, eligibility: number): Promise<Matched> {
  let account: AccountRef | null = null;
  if (override) {
    account = await accountByUser(env, override);
    if (!account) return { account: null, consent: null, state: "unmatched", note: "account_not_found" };
  } else if (from) {
    const found = await accountsBySender(env, from);
    if (found.length > 1) return { account: null, consent: null, state: "ambiguous", note: "several_accounts" };
    account = found[0] ?? null;
  }
  if (!account) return { account: null, consent: null, state: "unmatched", note: "no_account" };
  const c = await findContract(env, account.userId, eligibility);
  if (c.kind === "none") return { account, consent: null, state: "unmatched", note: c.evidenceMissing ? "deadline_evidence_missing" : "no_eligible_contract" };
  if (c.kind === "many") return { account, consent: null, state: "ambiguous", note: "several_contracts" };
  return { account, consent: c.consent, state: "matched", note: "ok" };
}

const verifyKind = (trusted: boolean, sameAddress: boolean): VerificationKind => trusted ? "trusted" : sameAddress ? "same_address_failed" : "other_sender";
const contractLinkInsert = (c: ContractRow, now: number): Q => q(`INSERT OR IGNORE INTO contract_links (consent_id,home_id,customer_id,session_id,subscription_id,provenance,created_at)
  VALUES (?,?,(SELECT customer_id FROM billing_subscriptions WHERE home_id=?),?,?,'backfill',?)`, c.id, c.home_id, c.home_id, c.stripe_session_id, c.stripe_subscription_id, now);
export const mailInsert = (noticeId: string, kind: string, key: string, now: number): Q => q("INSERT OR IGNORE INTO withdrawal_notice_mail (id,notice_id,kind,mail_key,created_at) VALUES (?,?,?,?,?)", crypto.randomUUID(), noticeId, kind, key, now);

/** r1-6: the verification-mail obligation of one notice, as statements for the SAME batch as the notice itself (or its repair). One
 *  verification email per account and contract (coalescing): a later notice follows a LIVE carrier (open or executing withdrawal) instead
 *  of getting its own mail. A dead carrier never strands a later notice: it gets its own key. */
const LIVE_OWNER = `(SELECT m.notice_id FROM withdrawal_notice_mail m JOIN withdrawal_notices c ON c.id=m.notice_id
  WHERE m.mail_key=? AND c.state IN ('open','executing') AND c.classification='withdrawal' AND c.match_state='matched')`;
//  r1-5: coalescing is about DELIVERY only. A notice from the holder (trusted) follows only a trusted carrier, so the holder is told the
//  withdrawal goes ahead without them; any other notice follows any live carrier. Each notice keeps its own trust, receipt and deadline.
export function verifyOutbox(noticeId: string, userId: string, consentId: string, trusted: boolean, now: number): Q[] {
  const kt = `verify:${userId}:${consentId}:trusted`;
  const ku = `verify:${userId}:${consentId}`;
  // The carrier this notice would follow (SQL, binds), or NULL.
  const carrier: [string, ...unknown[]] = trusted ? [LIVE_OWNER, kt] : [`COALESCE(${LIVE_OWNER},${LIVE_OWNER})`, kt, ku];
  const [cSql, ...cBinds] = carrier;
  const key = trusted ? kt : ku;
  return [
    q(`INSERT OR IGNORE INTO withdrawal_notice_mail (id,notice_id,kind,mail_key,created_at) SELECT ?,?,'verify',?,? WHERE ${cSql} IS NULL`,
      crypto.randomUUID(), noticeId, key, now, ...cBinds),
    // The key is held by a carrier that is no longer live: this notice gets its own mail.
    q(`INSERT OR IGNORE INTO withdrawal_notice_mail (id,notice_id,kind,mail_key,created_at) SELECT ?,?,'verify',?,? WHERE ${cSql} IS NULL
        AND NOT EXISTS (SELECT 1 FROM withdrawal_notice_mail WHERE notice_id=? AND kind LIKE 'verify%')`,
      crypto.randomUUID(), noticeId, `verify:${noticeId}`, now, ...cBinds, noticeId),
    q(`UPDATE withdrawal_notices SET coalesced_into=${cSql} WHERE id=? AND ${cSql}<>?`, ...cBinds, noticeId, ...cBinds, noticeId),
  ];
}
/** r1-5: the followers of a carrier that stopped being a live withdrawal (reclassified, repudiated, kept) are released at once: each gets its own
 *  verification mail (or follows another live carrier) under its own trust. */
async function releaseFollowers(env: Env, carrierId: string, now: number): Promise<void> {
  const rows = (await env.DB.prepare(`SELECT id,account_id,consent_id,sender_trusted FROM withdrawal_notices WHERE coalesced_into=? AND state='open'`).bind(carrierId)
    .all<{ id: string; account_id: string | null; consent_id: string | null; sender_trusted: number }>()).results;
  for (const f of rows) {
    const out = f.account_id && f.consent_id ? verifyOutbox(f.id, f.account_id, f.consent_id, f.sender_trusted === 1, now) : [];
    await env.DB.batch([
      env.DB.prepare("UPDATE withdrawal_notices SET coalesced_into=NULL, updated_at=? WHERE id=? AND coalesced_into=?").bind(now, f.id, carrierId),
      ...out.map(([sql, binds]) => env.DB.prepare(sql).bind(...(binds ?? []))),
      env.DB.prepare("INSERT INTO withdrawal_notice_events (id,notice_id,at,kind,actor,detail) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(), f.id, now, "carrier_released", "system", JSON.stringify({ carrier: carrierId })),
    ]);
  }
}
const unmatchedOutbox = (noticeId: string, now: number): Q => mailInsert(noticeId, "unmatched_reply", `unmatched:${noticeId}`, now);
const UNIQUE = /UNIQUE constraint failed/i;

export interface IntakeResult { id: string; duplicate: boolean }
async function intake(env: Env, d: NoticeDeps, b: z.infer<typeof intakeBody>): Promise<IntakeResult> {
  const now = clockOf(d);
  if (b.messageId) {
    const dup = await duplicateOf(env, b.messageId, now);
    if (dup) return dup;
  }
  const receivedAt = b.receivedAt ?? now;
  const events: Array<[string, unknown]> = [];
  const sentOk = b.sentAt !== undefined && b.sentBasis !== undefined && (ACCEPTED_SENT_BASES as readonly string[]).includes(b.sentBasis)
    && Boolean(b.sentEvidenceRef?.trim()) && Boolean(b.sentAcceptedBy?.trim());
  if (b.sentAt !== undefined && !sentOk) events.push(["sent_claim_ignored", { basis: b.sentBasis ?? null }]);
  const eligibility = sentOk ? Math.min(receivedAt, b.sentAt!) : receivedAt;
  const parsedFrom = parseFrom(b.from);
  const froms = parsedFrom.valid ? parsedFrom.mailboxes.map((x) => x.toLowerCase()) : [];
  const from = soleFrom(b.from);
  const m = await matchNotice(env, from, b.accountId, eligibility);
  const trust = senderTrusted(b.boundaryAuth, b.from, m.account ? { contactEmail: m.account.contactEmail, heldSince: m.account.heldSince } : null, receivedAt);
  // A notice the operator linked by hand (P1) only sends a link: it never becomes the dated (5a) item.
  const trusted = trust.trusted && !b.accountId;
  const kind = verifyKind(trusted, trust.sameAddress);
  const id = hex(16);
  const c = m.consent;
  const auth = JSON.stringify({ boundary: b.boundaryAuth ?? null, failed: trust.failed, fromRaw: b.from, fromValid: parsedFrom.valid, linkedByOperator: Boolean(b.accountId), insideHeaderIgnored: b.messageAuthResults !== undefined });
  const matched = m.state === "matched" && c !== null && m.account !== null;
  const wd = b.classification === "withdrawal";
  const stmts: Q[] = [
    q(`INSERT INTO withdrawal_notices (id,received_at,received_basis,received_flagged,sent_at,sent_basis,sent_evidence_ref,sent_accepted_by,sent_accepted_at,eligibility_at,classification,
        classification_rev,classification_basis,state,sender,sender_count,sender_was_account_email,sender_auth,sender_trusted,subject_hash,body_hash,message_id,language,match_state,match_note,
        account_id,supabase_sub,home_id,consent_id,subscription_id,plan_name,plan_started_at,verification_kind,execute_by,last_op,created_at,updated_at,candidate_obligation)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,'open',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,${b.classification === "candidate" ? 1 : 0})`,
    id, receivedAt, b.receivedBasis, b.receivedFlagged ? 1 : 0, sentOk ? b.sentAt! : null, sentOk ? b.sentBasis! : null, sentOk ? b.sentEvidenceRef! : null, sentOk ? b.sentAcceptedBy! : null,
    sentOk ? now : null, eligibility, b.classification, b.classificationBasis ?? null, froms.join(","), froms.length, trust.sameAddress ? 1 : 0, auth, trusted ? 1 : 0,
    b.subjectHash ?? null, b.bodyHash ?? null, b.messageId ?? null, b.language, m.state, m.note, m.account?.userId ?? null, m.account?.sub ?? null, matched ? c!.home_id : null,
    matched ? c!.id : null, matched ? c!.stripe_subscription_id : null, matched ? c!.plan : null, matched ? (c!.effective_start_at ?? c!.start_at) : null,
    wd && matched ? kind : null, executeByOf(receivedAt), crypto.randomUUID(), now, now),
    ...(matched ? [contractLinkInsert(c!, now)] : []),
    event(id, "received", "gateway", { classification: b.classification, match: m.state, trusted, failed: trust.failed, eligibilityAt: eligibility }, now),
    ...events.map(([k, detail]) => event(id, k, "gateway", detail, now)),
    // r1-6: the notice, its mail obligation and its coalescing assignment commit together (one D1 batch is one transaction): a crash
    // leaves either all of them or none, and a retry of the same message is then either a duplicate WITH its mail, or a fresh intake.
    ...(wd && matched ? verifyOutbox(id, m.account!.userId, c!.id, trusted, now) : []),
    // Plan 5.3 (4): unmatched sender gets the automatic reply with the way to confirm.
    ...(wd && !m.account && from ? [unmatchedOutbox(id, now)] : []),
    // r2-1 / r3-2: a contract whose deadline evidence was not kept is never treated as open-ended: the notice is unmatched and its case is
    // opened and attached IN this batch, so no crash can leave the notice without its case.
    ...(m.note === "deadline_evidence_missing" ? caseStmts(id, "deadline_evidence_missing", now) : []),
  ];
  try { await env.DB.batch(stmts.map(([sql, binds]) => env.DB.prepare(sql).bind(...(binds ?? [])))); }
  catch (e) {
    // The same message taken in concurrently: the other intake won, nothing of this one was written.
    if (b.messageId && e instanceof Error && UNIQUE.test(e.message)) {
      const dup = await duplicateOf(env, b.messageId, now);
      if (dup) return dup;
    }
    throw e;
  }
  await flushMail(env, d, id);
  if (matched && !wd) { try { await extension.afterChange?.(env, d, id); } catch { console.error(JSON.stringify({ message: "notice follow-up failed" })); } }
  return { id, duplicate: false };
}

// --- mail -------------------------------------------------------------------------------------------------------------------------------

/** r2-3: what the links inside a verification mail were issued against: the account's email generation, both selectors and the earlier expiry. */
interface MailLinks { emailGen: string; selectors: [string, string]; expiresAt: number }
/** basis (WP10 r1-7): the committed state a mail was written about; a cached copy whose basis no longer holds is rendered afresh. */
/** clarify (WP10 r3-1): the clarify selectors an ask/correction carries, with the revision they are bound to; a mail whose selectors are no longer
 *  the notice's live links of that revision is rendered afresh, never sent. */
export interface Mail { to: string; subject: string; text: string; reserve?: string; links?: MailLinks; basis?: string; clarify?: { rev: number; selectors: string[] };
  /** WP10 r4-1: the writes a render needs (the links the mail carries, and what goes with them). Rendering writes nothing itself: these run in
   *  ONE batch together with the stored mail, only while the sender still holds its claim on the mail row, and only if every link in `issued`
   *  was stored. A sender whose claim lapsed, or a render overtaken by a change, stores nothing and replaces no link. Never kept in the payload. */
  writes?: Q[]; issued?: string[] }
/** WP10 r4-1: the one sender that holds a mail row: its claim id is written at the claim and every later write of that sender is conditioned on it. */
export interface MailClaim { mailId: string; claimId: string }
/** SQL (`EXISTS (...)` text and binds): this mail row is unsent and THIS sender's claim on it is still the live one. */
export const claimHeld = (c: MailClaim, now: number): Q =>
  q("EXISTS (SELECT 1 FROM withdrawal_notice_mail WHERE id=? AND claim_id=? AND sent_at IS NULL AND claimed_until>?)", c.mailId, c.claimId, now);
const VERIFY_TEXT: Record<VerificationKind, "trusted" | "sameAddress" | "otherSender"> = { trusted: "trusted", same_address_failed: "sameAddress", other_sender: "otherSender" };

/** "Your refund: ..." from the ledger, the site contract's status words (being_prepared -> preparing). */
export function refundView(op: RefundOpRow | null, path: "direct" | "mp"): { status: "preparing" | "sent" | "processed"; date?: number; path: "direct" | "mp"; delayed?: true } | null {
  if (!op) return null;
  const s = refundState(op, path);
  return { status: s.status === "being_prepared" || s.status === "delayed" ? "preparing" : s.status, ...(s.date !== undefined ? { date: s.date } : {}), path, ...(s.status === "delayed" ? { delayed: true as const } : {}) };
}
async function pathOf(env: Env, n: NoticeRow): Promise<"direct" | "mp"> {
  const c = n.consent_id ? await env.DB.prepare("SELECT tax_source FROM checkout_consents WHERE id=?").bind(n.consent_id).first<{ tax_source: string | null }>() : null;
  return c && sellerOfConsent(c) === "link" ? "mp" : "direct";
}
async function refundLineFor(env: Env, n: NoticeRow): Promise<string> {
  const op = n.refund_op_id ? await getRefundOp(env, n.refund_op_id) : null;
  return op ? refundLine(op, n.language, await pathOf(env, n)) : "";
}
const outcomeText = async (env: Env, n: NoticeRow): Promise<string> => {
  const lang = n.language;
  if (n.state === "executing") return `${t("tooLateExecuting", lang)}\n${await refundLineFor(env, n)}`.trim();
  if (n.state === "completed") return `${t("tooLateCompleted", lang, { completed_at: fmtReceived(n.completed_at ?? n.executing_at ?? n.received_at, lang) })}\n${await refundLineFor(env, n)}`.trim();
  return t("stopped", lang);
};

export async function accountIdentity(env: Env, d: NoticeDeps, n: NoticeRow): Promise<{ email: string; updatedAt: string } | null> {
  if (!n.supabase_sub) return null;
  const reader: IdentityReader | null = readerOf(env, d);
  if (!reader) return null;
  try {
    const r = await reader.emailGen(n.supabase_sub);
    return r.email?.trim() && r.updatedAt ? { email: r.email.trim().toLowerCase(), updatedAt: r.updatedAt } : null;
  } catch { return null; }
}
/** The confirm link opens the site's /verify page; the "This wasn't me" link opens /not-me, the page that only ever repudiates (r1-2: the site's
 *  /verify page always calls confirm). The token's own purpose is still checked by the lookup and by each endpoint. */
export const linkOf = (env: Env, d: NoticeDeps, token: string, purpose: "confirm" | "repudiate" = "confirm") =>
  `${siteOrigin(env, d)}/${purpose === "repudiate" ? "not-me" : "verify"}#${token}`;

/** Renders one queued mail from the COMMITTED state. "skip": it no longer applies. null: not ready (reader down, mail limit): stays queued. */
async function renderMail(env: Env, d: NoticeDeps, n: NoticeRow, kind: string, claim: MailClaim): Promise<Mail | "skip" | "limited" | null> {
  const lang = n.language;
  const received = fmtReceived(n.received_at, lang);
  if (kind === "unmatched_reply") {
    const to = n.sender.split(",")[0];
    if (!to || n.sender_count !== 1 || n.match_state === "matched") return "skip";
    return { to, subject: t("subjectUnmatched", lang), text: t("unmatchedReply", lang, { received_at: received }), reserve: to };
  }
  if (/^(ask|correction|clarified|expiry)(:|$)/.test(kind)) return extension.renderMail ? extension.renderMail(env, d, n, kind, claim) : "skip";
  const id = await accountIdentity(env, d, n);
  if (!id) return null;
  if (kind === "ack") {
    // r1-8: "carried out ... your plan has ended and your server is deleted" only on completion evidence: the notice completed (the refund
    // operation is done, the plan ended) AND the refund was submitted. Before that it waits.
    const op = n.refund_op_id ? await getRefundOp(env, n.refund_op_id) : null;
    if (n.state !== "completed" || !op?.refund_submitted_at || op.done_at === null) return null;
    return { to: id.email, subject: t("subjectAck", lang), text: t("ack", lang, { received_at: received, submitted_on: fmtExecuteByDate(op.refund_submitted_at, lang) }) };
  }
  if (kind === "wasnt_me_reply") return { to: id.email, subject: n.state === "repudiated" || n.state === "kept" ? t("subjectStopped", lang) : t("subjectTooLate", lang), text: await outcomeText(env, n) };
  // verify, verify_reminder, verify_newlink, verify_rev*: the verification email with both links. Only while the notice is still a live withdrawal.
  if (n.state !== "open" || n.classification !== "withdrawal" || n.match_state !== "matched" || n.coalesced_into || !n.verification_kind || !n.supabase_sub) return "skip";
  if (!await reserveMail(env, d, id.email)) return "limited";
  const bind = { subjectKind: "notice" as const, subjectId: n.id, accountId: n.supabase_sub, accountEmail: id.email, supabaseUpdatedAt: id.updatedAt, receivedAt: n.received_at };
  // r4-1: the pair is stored with the mail, under the sender's claim (flushMail), never on its own.
  const pc = await prepareToken(env, d, { ...bind, purpose: "confirm" }, { when: claimHeld(claim, clockOf(d)) });
  const pr = await prepareToken(env, d, { ...bind, purpose: "repudiate" }, { when: claimHeld(claim, clockOf(d)) });
  if (!pc || !pr) return "skip";                               // received + 14 days has passed
  const confirm = pc.issued;
  const repud = pr.issued;
  const body = t(VERIFY_TEXT[n.verification_kind], lang, { received_at: received, execute_by_date: fmtExecuteByDate(n.execute_by, lang) });
  return { to: id.email, subject: t("subjectVerify", lang), writes: [pc.write, pr.write], issued: [confirm.selector, repud.selector],
    links: { emailGen: id.updatedAt, selectors: [confirm.selector, repud.selector], expiresAt: Math.min(confirm.expiresAt, repud.expiresAt) },
    text: `${body}\n\n${t("lblConfirm", lang)}: ${linkOf(env, d, confirm.token)}\n${t("lblWasntMe", lang)}: ${linkOf(env, d, repud.token, "repudiate")}` };
}

/** SQL (on a withdrawal_notices row, unaliased): this notice's contract has a withdrawal whose refund was submitted to Stripe, or whose refund
 *  operation is done (nothing was owed). Until then the refund obligation, its deadline and its alert stay with every notice of the contract. */
const DISCHARGED = `EXISTS (SELECT 1 FROM withdrawals w JOIN refund_ops r ON r.id=w.refund_op_id WHERE w.home_id=withdrawal_notices.home_id
  AND w.consent_id=withdrawal_notices.consent_id AND (r.refund_submitted_at IS NOT NULL OR r.done_at IS NOT NULL))`;
/** SQL (on a withdrawal_notices row, unaliased): this notice, as classified NOW, still carries a dated refund obligation: executing, a live trusted
 *  withdrawal, or an overdue candidate. Alerts are raised and retried only while this holds (r2-2). */
const OWED_NOW = `(state='executing' OR (state='open' AND classification='withdrawal' AND sender_trusted=1 AND match_state='matched')
  OR (state='open' AND classification='candidate' AND overdue_at IS NOT NULL)
  OR (state='open' AND candidate_obligation=1 AND clarified_action IS NULL AND overdue_at IS NOT NULL))`;
/** r2-2 (SQL, unaliased): an overdue candidate question still unanswered, whatever undecided label it carries now. Its obligation outlives every
 *  relabel, so its alert follows the notice's current revision (rebased, or raised again) instead of being withdrawn. */
const CANDIDATE_OWED = `(state='open' AND candidate_obligation=1 AND clarified_action IS NULL AND overdue_at IS NOT NULL)`;
/** r3-1: SET clause (and its binds) that re-arms a stale alert for revision `rev`: raised for another revision, or closed by the system only because
 *  the notice was repudiated. An operator's acknowledgement of the SAME revision stands. Every CASE reads the row's old values (SQLite). */
const REARM_WHEN = `alert_raised_at IS NOT NULL AND (alert_rev IS NOT ? OR alert_acked_by='system:resolved')`;
const REARM_SET = `alert_rev=CASE WHEN ${REARM_WHEN} THEN ? ELSE alert_rev END, alert_last_at=CASE WHEN ${REARM_WHEN} THEN NULL ELSE alert_last_at END,
  alert_acked_at=CASE WHEN ${REARM_WHEN} THEN NULL ELSE alert_acked_at END, alert_acked_by=CASE WHEN ${REARM_WHEN} THEN NULL ELSE alert_acked_by END`;
const rearmBinds = (rev: number): unknown[] => [rev, rev, rev, rev, rev];
/** A rendered mail kept for retries, with what it was rendered against. */
interface CachedMail extends Mail { state: NoticeState; rev: number }
/** true: still valid; false: stale (re-render); null: cannot tell now (the identity reader is down). */
async function stillHolds(env: Env, d: NoticeDeps, n: NoticeRow, kind: string, c: CachedMail): Promise<boolean | null> {
  if (c.state !== n.state || c.rev !== n.classification_rev) return false;
  if (kind === "unmatched_reply") return true;
  // WP10's mails (ask, correction, clarified, expiry) are also re-checked against what they say (the committed cancellation state).
  if (/^(ask|correction|clarified|expiry)(:|$)/.test(kind) && extension.stillValid) { const v = await extension.stillValid(env, d, n, kind, c); if (v !== true) return v; }
  const id = await accountIdentity(env, d, n);
  if (!id) return null;
  if (id.email !== c.to.trim().toLowerCase()) return false;
  if (!kind.startsWith("verify")) return true;
  // r2-3: a verification mail holds bearer links. It is sent again only while those links can still be redeemed: the account's email generation
  // is the one they were issued for (an A -> B -> A change keeps the address but kills the links), both selectors are still the live, unused
  // pair of this notice (a reissue replaces them), and neither has expired. Otherwise it is rendered afresh.
  const l = c.links;
  if (!l || l.emailGen !== id.updatedAt || l.expiresAt <= clockOf(d)) return false;
  const live = await env.DB.prepare(`SELECT COUNT(*) AS n FROM verify_tokens WHERE subject_kind='notice' AND subject_id=? AND selector IN (?,?) AND purpose IN ('confirm','repudiate')
    AND used_at IS NULL AND expires_at>? AND email_gen=?`).bind(n.id, l.selectors[0], l.selectors[1], clockOf(d), l.emailGen).first<{ n: number }>();
  return live?.n === 2;
}
// P2 (Astra WP9-1): a kept mail holds complete bearer links, so it is stored sealed: AES-256-GCM under a key derived (SHA-256) from the
// Worker secret NOTICE_MAIL_KEY, the mail row's id as additional data (a sealed payload cannot be moved to another row). Without the secret
// nothing is kept: a retry renders the mail again (new links replace the old pair), never plaintext at rest.
const keyCache = new Map<string, Promise<CryptoKey>>();
function mailKey(env: Env): Promise<CryptoKey> | null {
  const secret = (env as unknown as { NOTICE_MAIL_KEY?: string }).NOTICE_MAIL_KEY?.trim();
  if (!secret) return null;
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.digest("SHA-256", new TextEncoder().encode(`murage-notice-mail-v1:${secret}`))
      .then((raw) => crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]));
    keyCache.set(secret, k);
  }
  return k;
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** null: there is no key, nothing may be kept. */
export async function sealPayload(env: Env, m: CachedMail, rowId: string): Promise<string | null> {
  const key = mailKey(env);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(rowId) }, await key, new TextEncoder().encode(JSON.stringify(m))));
  return `v1:${b64(iv)}:${b64(ct)}`;
}
/** The kept mail, or null (no key, wrong row, tampered, or unreadable): the caller renders it again. */
export async function openPayload(env: Env, stored: string, rowId: string): Promise<CachedMail | null> {
  try {
    let json = stored;
    if (stored.startsWith("v1:")) {
      const key = mailKey(env);
      if (!key) return null;
      const [, iv, ct] = stored.split(":");
      json = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: new TextEncoder().encode(rowId) }, await key, unb64(ct)));
    }
    const p = JSON.parse(json) as Partial<CachedMail>;
    return typeof p.to === "string" && typeof p.text === "string" && typeof p.subject === "string" && typeof p.state === "string" && typeof p.rev === "number" ? p as CachedMail : null;
  } catch { return null; }
}
/** The alert open while NOTICE_MAIL_KEY is missing and withdrawal mail waits on it. */
export const NOTICE_MAIL_KEY_ALERT = "withdrawal.mail_key_missing";
/** Readiness of withdrawal mail: false while NOTICE_MAIL_KEY is not set (nothing can be sent). */
export const noticeMailReady = (env: Env): boolean => mailKey(env) !== null;
const CLAIM_MS = 2 * 60_000;
export const MAIL_ESCALATE_AFTER = 20;
/** r4-2: the final check under the home lease (it reads the identity) must end well inside the two-minute lease; past this it is a failed try. */
export const MAIL_CHECK_MS = 30_000;
class CheckTimeout extends Error { constructor() { super("check_timeout"); } }
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CheckTimeout()), ms); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
/** A write that is applied only if `cond` (`SELECT` returning 1 or 0) holds; otherwise the whole batch it is in is rolled back (CHECK ok=1). */
const guard = (id: string, cond: string, ...binds: unknown[]): Q => q(`INSERT INTO cloud_write_guards (id,ok) VALUES (?,(${cond}))`, id, ...binds);
/** int2-3: the missing-key alert says what is at stake: the statutory clocks keep running while mail waits. It names the earliest deadline
 *  (execute_by) of any notice with mail held unsent, and is refreshed in place (and ops told again) whenever that earliest deadline changes. */
async function raiseMailKeyAlert(env: Env, d: NoticeDeps, now: number): Promise<void> {
  const first = await env.DB.prepare(`SELECT n.id,n.execute_by FROM withdrawal_notice_mail m JOIN withdrawal_notices n ON n.id=m.notice_id
    WHERE m.sent_at IS NULL ORDER BY n.execute_by, n.id LIMIT 1`).first<{ id: string; execute_by: number }>();
  const detail = "NOTICE_MAIL_KEY is not set: withdrawal mails are held unsent until it is. Deadlines are not paused."
    + (first ? ` Earliest affected deadline (execute_by): ${new Date(first.execute_by).toISOString()} (notice ${first.id}).` : "");
  if (await raiseAlert(env, { homeId: "billing", kind: NOTICE_MAIL_KEY_ALERT, severity: "high", detail }, now, d.fetcher)) return;
  // int3-1: a refreshed detail is a new message that must reach ops: re-armed (delivered_at cleared, attempts reset) in the same UPDATE, then sent
  // through the retryable path. If this send fails the alert stays due, so the next ops sweep (and the next flush) sends the changed detail.
  const open = await env.DB.prepare("SELECT id,detail,delivered_at,delivery_attempts FROM cloud_alerts WHERE home_id='billing' AND kind=? AND resolved_at IS NULL")
    .bind(NOTICE_MAIL_KEY_ALERT).first<{ id: string; detail: string | null; delivered_at: number | null; delivery_attempts: number }>();
  if (!open) return;
  let due = open.delivered_at === null && open.delivery_attempts < MAX_DELIVERY_ATTEMPTS;   // an earlier send failed: this flush tries again
  if (open.detail !== detail) {
    const refreshed = await env.DB.prepare("UPDATE cloud_alerts SET detail=?,delivered_at=NULL,delivery_attempts=0 WHERE id=? AND resolved_at IS NULL AND detail IS NOT ?")
      .bind(detail, open.id, detail).run();
    due = refreshed.meta.changes > 0;
  }
  if (due) await deliverAlert(env, open.id, detail, { kind: NOTICE_MAIL_KEY_ALERT, severity: "high", homeId: "billing",
    text: `[murage-cloud] ${NOTICE_MAIL_KEY_ALERT} home=billing: ${detail}`, at: now }, now, d.fetcher);
}
/** Sends every unsent mail (of one notice, or all of them). Each row is CLAIMED exclusively before work, under a fresh claim id; the rendered
 *  mail (links included) is fixed on the row at first render so a retry sends the same links and never replaces a link that may already have
 *  been delivered; a row is never abandoned: after MAIL_ESCALATE_AFTER failed tries (a failed send, or the home lease lost or busy at the
 *  final check) ops is alerted and the retries go on.
 *  r4-1: every write a sender makes after its claim (the links and the stored mail, in ONE batch; the release; the completion) holds only
 *  while that claim id is still the row's live claim. A sender whose claim lapsed and was taken over writes nothing: it cannot replace the
 *  links another sender delivered, nor mark or release that sender's row. */
export async function flushMail(env: Env, d: NoticeDeps, noticeId?: string): Promise<number> {
  const now = clockOf(d);
  const rows = (await env.DB.prepare(`SELECT id,notice_id,kind FROM withdrawal_notice_mail WHERE sent_at IS NULL ${noticeId ? "AND notice_id=?" : ""}
    ORDER BY COALESCE(last_try_at,0), created_at LIMIT 50`).bind(...(noticeId ? [noticeId] : [])).all<{ id: string; notice_id: string; kind: string }>()).results;
  // Fails closed without NOTICE_MAIL_KEY: no row is claimed, no link is issued and nothing is sent, so no retry can lose a mail it could not
  // keep. Every mail stays pending (its kept payload untouched) and ops is told once; the admin readiness check answers 503 meanwhile. Once
  // the key is set, the next flush sends them all and the alert closes.
  if (!mailKey(env)) {
    if (rows.length) await raiseMailKeyAlert(env, d, now);
    return 0;
  }
  await resolveAlert(env, "billing", NOTICE_MAIL_KEY_ALERT, now, d.fetcher);
  let sent = 0;
  for (const m of rows) {
    const claimId = crypto.randomUUID();
    const claim = await env.DB.prepare("UPDATE withdrawal_notice_mail SET claim_id=?, claimed_until=?, last_try_at=? WHERE id=? AND sent_at IS NULL AND (claimed_until IS NULL OR claimed_until<=?)")
      .bind(claimId, now + CLAIM_MS, now, m.id, now).run();
    if (claim.meta.changes !== 1) continue;
    const mine: MailClaim = { mailId: m.id, claimId };
    const OWN = "id=? AND claim_id=? AND sent_at IS NULL";
    const held = async () => (await env.DB.prepare(`SELECT 1 AS x FROM withdrawal_notice_mail WHERE ${OWN} AND claimed_until>?`).bind(m.id, claimId, clockOf(d)).first()) !== null;
    const release = (sql: string, ...b: unknown[]) => env.DB.prepare(`UPDATE withdrawal_notice_mail SET claimed_until=NULL, claim_id=NULL, ${sql} WHERE ${OWN}`).bind(...b, m.id, claimId).run();
    // r4-2 / p2-1 / p3-1: the stuck-mail alert closes only when no escalated mail is left unsent, checked inside the closing UPDATE itself.
    // Runs after every terminal end of a mail (sent, skipped, no notice).
    const reconcileStuckAlert = () => resolveAlertUnless(env, "billing", "withdrawal.mail_stuck", now,
      "SELECT 1 FROM withdrawal_notice_mail WHERE sent_at IS NULL AND escalated_at IS NOT NULL", d.fetcher);
    const fail = async (why: string) => {
      if ((await release("attempts=attempts+1, last_error=?", why)).meta.changes !== 1) return;
      const row = await env.DB.prepare("SELECT attempts,escalated_at FROM withdrawal_notice_mail WHERE id=?").bind(m.id).first<{ attempts: number; escalated_at: number | null }>();
      if (row && row.attempts >= MAIL_ESCALATE_AFTER && row.escalated_at === null) {
        await env.DB.prepare("UPDATE withdrawal_notice_mail SET escalated_at=? WHERE id=? AND escalated_at IS NULL").bind(now, m.id).run();
        await raiseAlert(env, { homeId: "billing", kind: "withdrawal.mail_stuck", severity: "high", detail: `mail ${m.kind} for notice ${m.notice_id} failed ${row.attempts} times (last: ${why})` }, now, d.fetcher);
      }
    };
    try {
      const n = await load(env, m.notice_id);
      if (!n) { await release("sent_at=?, last_error='no_notice'", now); await reconcileStuckAlert(); continue; }
      const stored = (await env.DB.prepare("SELECT payload FROM withdrawal_notice_mail WHERE id=?").bind(m.id).first<{ payload: string | null }>())?.payload ?? null;
      let mail: Mail | "skip" | "limited" | null = null;
      if (stored) {
        // r1-8: a cached mail is sent again only while the state, the classification revision and the recipient it was rendered for still
        // hold; otherwise it is dropped and rendered afresh from the committed state (which may skip it).
        const cached = await openPayload(env, stored, m.id);
        const ok = cached ? await stillHolds(env, d, n, m.kind, cached) : false;
        if (ok === null) { await fail("not_ready"); continue; }
        if (ok) mail = cached;
        else if ((await env.DB.prepare(`UPDATE withdrawal_notice_mail SET payload=NULL WHERE ${OWN}`).bind(m.id, claimId).run()).meta.changes !== 1) continue;   // r4-1: no longer ours
      }
      if (!mail) {
        try { mail = await renderMail(env, d, n, m.kind, mine); } catch { mail = null; }
        if (mail === "skip") { await release("sent_at=?, last_error='skipped'", now); await reconcileStuckAlert(); continue; }
        if (mail === "limited") { await release("last_error='rate_limited'"); continue; }
        if (!mail) { await fail("not_ready"); continue; }
        if (mail.reserve && !await reserveMail(env, d, mail.reserve)) { await release("last_error='rate_limited'"); continue; }
        const keep: CachedMail = { to: mail.to, subject: mail.subject, text: mail.text, state: n.state, rev: n.classification_rev, ...(mail.links ? { links: mail.links } : {}),
          ...(mail.basis !== undefined ? { basis: mail.basis } : {}), ...(mail.clarify ? { clarify: mail.clarify } : {}) };
        const sealed = await sealPayload(env, keep, m.id);
        // The key was checked before any claim; a sealing that still fails sends nothing (the row is retried, never sent unkept).
        if (!sealed) { await fail("mail_key_missing"); continue; }
        // r4-1: ONE batch: the claim is still this sender's (checked first), every link the mail carries is stored, all of them are there
        // (checked after), and the sealed mail is kept with them. Any check failing rolls the whole batch back: no link is replaced.
        const g = crypto.randomUUID();
        const issued = mail.issued ?? [];
        const stmts: Q[] = [
          guard(`${g}-claim`, `SELECT COUNT(*) FROM withdrawal_notice_mail WHERE ${OWN} AND claimed_until>?`, m.id, claimId, clockOf(d)),
          ...(mail.writes ?? []),
          ...(issued.length ? [guard(`${g}-links`, `SELECT COUNT(*)=? FROM verify_tokens WHERE used_at IS NULL AND selector IN (${issued.map(() => "?").join(",")})`, issued.length, ...issued)] : []),
          q(`UPDATE withdrawal_notice_mail SET payload=? WHERE ${OWN}`, sealed, m.id, claimId),
          q("DELETE FROM cloud_write_guards WHERE id LIKE ?", `${g}-%`),
        ];
        try { await env.DB.batch(stmts.map(([sql, binds]) => env.DB.prepare(sql).bind(...(binds ?? [])))); }
        catch (e) {
          if (!/CHECK constraint/i.test(String((e as Error)?.message ?? e))) throw e;
          if (await held()) await fail("not_issued");               // still ours, but a link could not be stored (overtaken): rendered afresh next time
          continue;                                                // otherwise another sender owns the row now: nothing of ours was written
        }
      }
      const out = mail;
      const send = () => mailerOf(env, d).send({ to: out.to, from: { email: env.EMAIL_FROM, name: "Murage" }, subject: out.subject, text: out.text,
        html: `<!doctype html><html><body>${out.text.split("\n\n").map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("")}</body></html>` });
      // WP10 r2-5: the expiry confirmation is rendered from a snapshot that a signed-in answer or withdrawal may overtake while the identity is
      // read. Its final eligibility check and its dispatch run under the home lease every holder settlement takes, so no settlement can commit
      // between them; a mail the committed state no longer supports is discarded (rendered afresh, which skips it), never sent.
      // r3-2: EVERY mail that speaks about the cancellation (ask, correction, clarified, expiry) is checked and dispatched this way, not only
      // the expiry confirmation. The identity read inside the check may outlast the lease: the lease is renewed (fenced) after the check and
      // before the send; a sender whose lease lapsed (whether or not a successor took it and settled meanwhile) is refused (LeaseLost) and
      // the row is retried, re-validated against the committed state.
      // r4-2: the check is bounded (MAIL_CHECK_MS); a lost or busy lease and a check that overran count as failed tries, so a row that keeps
      // losing its lease is escalated like any other stuck mail.
      const serial = /^(ask|correction|clarified|expiry)(:|$)/.test(m.kind) && n.home_id ? n.home_id : null;
      let superseded = false;
      let lost = false;
      try {
        if (serial) {
          await leased(env, serial, async (lease) => {
            const holds = await bounded((async () => {
              if (!await held()) { lost = true; return false; }
              const now2 = await load(env, n.id);
              return Boolean(now2 && now2.state === n.state && now2.classification_rev === n.classification_rev && now2.clarified_action === n.clarified_action
                && (!extension.stillValid || (await extension.stillValid(env, d, now2, m.kind, out)) === true));
            })(), MAIL_CHECK_MS);
            if (!holds) { superseded = !lost; return; }
            await fence(env, lease);
            // Known, not fixed here (Astra WP10-4 P2 #3): the send itself can outlast the renewed lease; that needs a transport that can be cancelled.
            await send();
          });
        } else if (await held()) await send();
        else lost = true;
      } catch (e) {
        if (e instanceof HomeBusy) { await fail("home_busy"); continue; }
        if (e instanceof LeaseLost) { await fail("lease_lost"); continue; }
        if (e instanceof CheckTimeout) { await fail("check_timeout"); continue; }
        await fail("send_failed"); continue;
      }
      if (lost) continue;                                          // r4-1: another sender owns the row now; it sends its own (stored) mail
      if (superseded) {
        // r4-1: nothing is rendered here (a render would mint links nobody receives): the mail is dropped and the next flush renders it afresh
        // from the committed state, which either skips it or sends the form it is still owed in.
        await release("payload=NULL, last_error='superseded'");
        continue;
      }
      const upd = m.kind.startsWith("verify") ? [env.DB.prepare("UPDATE withdrawal_notices SET verification_sent_at=COALESCE(verification_sent_at,?) WHERE id=?").bind(now, n.id)]
        // WP10 r1-6: the correction obligation is discharged only by the mail of the CURRENT revision (an older revision's mail says something else).
        : /^(ask|correction):/.test(m.kind) ? [env.DB.prepare("UPDATE withdrawal_notices SET correction_due=0 WHERE id=? AND classification_rev=?").bind(n.id, Number(m.kind.split(":")[1]))] : [];
      await env.DB.batch([env.DB.prepare(`UPDATE withdrawal_notice_mail SET sent_at=?, claimed_until=NULL, claim_id=NULL, payload=NULL, last_error=NULL WHERE ${OWN}`).bind(now, m.id, claimId), ...upd]);
      sent += 1;
      await reconcileStuckAlert();
    } catch {
      await release("last_error='error'");
    }
  }
  return sent;
}

// --- the one transition: authorize (open -> executing) -------------------------------------------------------------------------------

/** The statements that open the notice's case (one per notice) and record why; idempotent, for any batch (r3-2: the intake's own). */
function caseStmts(noticeId: string, reason: string, now: number): Q[] {
  return [
    q("INSERT OR IGNORE INTO withdrawal_notice_cases (id,notice_id,opened_at,reason) VALUES (?,?,?,?)", `case-${noticeId}`, noticeId, now, reason),
    q("UPDATE withdrawal_notices SET case_id=COALESCE(case_id,?) WHERE id=?", `case-${noticeId}`, noticeId),
    q(`INSERT INTO withdrawal_notice_events (id,notice_id,at,kind,actor,detail) SELECT ?,?,?,?,?,? WHERE NOT EXISTS
      (SELECT 1 FROM withdrawal_notice_events WHERE notice_id=? AND kind='case_opened' AND detail=?)`,
      crypto.randomUUID(), noticeId, now, "case_opened", "system", JSON.stringify({ reason }), noticeId, JSON.stringify({ reason })),
  ];
}
/** Opens the notice's case (one per notice) and records why. Idempotent. */
async function openCase(env: Env, noticeId: string, reason: string, now: number): Promise<void> {
  await env.DB.batch(caseStmts(noticeId, reason, now).map(([sql, binds]) => env.DB.prepare(sql).bind(...(binds ?? []))));
}
/** SQL: a notice whose deadline evidence was missing at intake but which has no case attached (written before r3-2, or a lost repair). */
const ORPHANED_CASE = "match_note='deadline_evidence_missing' AND case_id IS NULL";
/** r3-2: a redelivered message is a duplicate of the notice already taken in; if that notice is missing its case, the case is attached now. */
async function duplicateOf(env: Env, messageId: string, now: number): Promise<IntakeResult | null> {
  const dup = await env.DB.prepare(`SELECT id, CASE WHEN ${ORPHANED_CASE} THEN 1 ELSE 0 END AS orphan FROM withdrawal_notices WHERE message_id=?`).bind(messageId)
    .first<{ id: string; orphan: number }>();
  if (!dup) return null;
  if (dup.orphan === 1) await openCase(env, dup.id, "deadline_evidence_missing", now);
  return { id: dup.id, duplicate: true };
}

/** The subscription the notice's contract was made for: the one frozen on the notice at intake, else the contract's own record (checkout
 *  consent, then the insert-only contract link). Never the home's current subscription. Two records that disagree are a case. */
async function frozenTarget(env: Env, n: NoticeRow, consent: ContractRow): Promise<{ ok: true; subscriptionId: string } | { ok: false; reason: string }> {
  const link = await env.DB.prepare("SELECT subscription_id FROM contract_links WHERE consent_id=?").bind(consent.id).first<{ subscription_id: string | null }>();
  const known = [n.subscription_id, consent.stripe_subscription_id, link?.subscription_id ?? null].filter((x): x is string => Boolean(x));
  if (known.length === 0) return { ok: false, reason: "subscription_unresolved" };
  if (new Set(known).size > 1) return { ok: false, reason: "subscription_conflict" };
  return { ok: true, subscriptionId: known[0] };
}

export type AuthCode = "ok" | "stale" | "not_found" | "not_trusted" | "not_withdrawal" | "not_matched" | "not_open" | "not_eligible" | "deadline_passed" | "already_withdrawn" | "busy"
  | "target_unresolved";
export interface AuthResult { code: AuthCode; won: boolean; notice: NoticeRow | null; lost?: Refusal }
type Via = "link" | "signed_in" | "execute" | "clarify";

/** Confirm, signed-in confirmation and Execute all go through here. The conditional UPDATE is the arbiter; everything after it in the batch is
 *  conditioned on THIS operation's op id, so the loser writes nothing. A token (link path) is consumed by the same batch. */
export async function authorize(env: Env, d: NoticeDeps, noticeId: string, via: Via, opts: { verified?: Verified; fromRepudiated?: boolean; actor?: string; clarifyRev?: number } = {}): Promise<AuthResult> {
  const n = await load(env, noticeId);
  if (!n) return { code: "not_found", won: false, notice: null };
  const now = clockOf(d);
  const from: NoticeState = opts.fromRepudiated ? "repudiated" : "open";
  const refuse = (code: AuthCode): AuthResult => ({ code, won: false, notice: n });
  const clar = opts.clarifyRev !== undefined;
  if (n.state !== from) return refuse("not_open");
  // WP10 (clarify withdraw_now): the notice is an undecided one at exactly the bound revision; the same transition then sets `withdrawal` itself.
  if (clar) {
    if (n.classification === "withdrawal" || n.clarified_action) return refuse("not_open");
    if (!clarifyRevOk(n, opts.clarifyRev!)) return refuse("stale");
  } else if (n.classification !== "withdrawal") return refuse("not_withdrawal");
  if (n.match_state !== "matched" || !n.home_id || !n.consent_id || !n.account_id) return refuse("not_matched");
  // (5a) Execute is only for a notice from the holder; (5b) has no dated step for Sean (the holder's own link or sign-in executes it).
  if (via === "execute" && !n.sender_trusted) return refuse("not_trusted");
  if (via === "execute" && pastDeadline(n, now)) return refuse("deadline_passed");
  const consent = await env.DB.prepare("SELECT * FROM checkout_consents WHERE id=?").bind(n.consent_id).first<ContractRow>();
  const elig = consent ? await eligibilityAt(env, consent, n.eligibility_at) : "not_eligible";
  if (elig === "evidence_missing") await openCase(env, n.id, "deadline_evidence_missing", now);
  if (!consent || elig !== "eligible") return refuse("not_eligible");
  const windowEnd = await withdrawalWindowEnd(env, consent);
  if (await env.DB.prepare("SELECT 1 AS x FROM withdrawals WHERE home_id=?").bind(n.home_id).first()) return refuse("already_withdrawn");
  // r1-3: the refund and the plan end target the notice's OWN contract's subscription, never whatever the home holds now. Unknown or
  // contradictory: nothing executes, a case stays open (the notice stays open with its deadline) until the contract's subscription is known.
  const target = await frozenTarget(env, n, consent);
  if (!target.ok) { await openCase(env, n.id, target.reason, now); return refuse("target_unresolved"); }
  const subscriptionId = target.subscriptionId;
  const opId = crypto.randomUUID();
  let lost: Refusal | undefined;
  const wid = `withdrawal-notice-${n.id}`;
  const refundOp = `withdrawal:${wid}`;
  const path = sellerOfConsent(consent) === "link" ? "mp" : "direct";
  try {
    await leased(env, n.home_id, async (lease) => {
      await applyServiceLog(env, lease);
      const supplied = (await env.DB.prepare("SELECT MIN(started_at) AS s FROM service_intervals WHERE home_id=? AND subscription_id=?")
        .bind(n.home_id, subscriptionId).first<{ s: number | null }>())?.s ?? null;
      const v = opts.verified;
      const cond = (consumedFirst: boolean): [string, ...unknown[]] => consumedFirst ? [`${WHEN_CONSUMED}`, v!.row.selector, v!.opId] : ["1=1"];
      const [consumedSql, ...consumedBinds] = cond(Boolean(v));
      // r1-7: the Execute cutoff is judged AT the transition, on the database's clock (the injected clock in tests, read only now, after the
      // lease was won), never on a time captured before the lease: an Execute that crosses 23:59:59 while it waits writes nothing.
      const tick = d.now ? d.now() : null;
      const extra = (): Q[] => {
        const [mineSql, ...mineBinds] = mine(n.id, opId, "executing");
        return [
          // r3-1: an alert raised for an earlier classification revision, or closed only because the notice was repudiated, is re-armed for THIS
          // revision in the same statement: the executing obligation is never left with an alert the retry step will not send.
          q(`UPDATE withdrawal_notices SET state='executing', executing_at=COALESCE(?,${DB_NOW}), executed_via=?, last_op=?, withdrawal_id=?, refund_op_id=?, updated_at=?,
              subscription_id=COALESCE(subscription_id,?), ${REARM_SET}${clar
              ? ", classification='withdrawal', classification_rev=classification_rev+1, classification_basis='clarified by the holder: withdraw_now', clarified_action='withdraw_now', clarified_at=?, candidate_obligation=0, ask_rev=NULL" : ""}
            WHERE id=? AND state=? AND ${clar ? "classification IN ('candidate','cancellation','support','unclear') AND clarified_action IS NULL" : "classification='withdrawal'"} AND classification_rev=?
              AND match_state='matched' AND eligibility_at<? AND (? = 0 OR COALESCE(?,${DB_NOW}) < execute_by + 1000) AND ${consumedSql}`,
          // r3-1 re-arm: for a clarification the notice becomes the NEXT revision (classification_rev+1), so the alert is re-armed for that one.
          tick, via, opId, wid, refundOp, now, subscriptionId, ...rearmBinds(clar ? opts.clarifyRev! + 1 : n.classification_rev), ...(clar ? [now] : []), n.id, from, clar ? opts.clarifyRev! : n.classification_rev, windowEnd, via === "execute" ? 1 : 0, tick, ...consumedBinds),
          q(`INSERT INTO withdrawal_authorizations (notice_id,via,at,op_id,consent_id) SELECT ?,?,?,?,? WHERE ${mineSql}`, n.id, via, now, opId, consent.id, ...mineBinds),
          // Plain INSERT on purpose: the account's one withdrawal (unique per home) aborts the whole batch, token consumption included.
          q(`INSERT INTO withdrawals (id,home_id,user_id,consent_id,name,confirmed_at,early_start,days_supplied,deducted_cents,refund_cents,basis,status,ip,user_agent,refund_op_id,service_supplied_at)
            SELECT ?,?,?,?,NULL,?,?,0,0,0,'pending','received',NULL,NULL,?,? WHERE ${mineSql}`, wid, n.home_id, n.account_id, consent.id, n.received_at, consent.early_start, refundOp, supplied, ...mineBinds),
          // inheritSubscription:false: exactly this contract's subscription, never the home's current one (a replacement contract).
          refundOpInsert({ id: refundOp, kind: "withdrawal", homeId: n.home_id!, userId: n.account_id!, subscriptionId, inheritSubscription: false, endPlan: true,
            // r1-4: the entitlement this timely notice qualified for, judged at eligibility_at and frozen into the operation: everything paid for the
            // plan comes back. confirmedAt (the receipt) stays the withdrawal's effective time.
            detail: { withdrawalId: wid, confirmedAt: n.received_at, consentId: consent.id, path, withdrawalEntitlement: "eu_uk_full", qualifyingAt: n.eligibility_at },
            when: [mineSql, ...mineBinds] }, now),
          eventWhen(mineSql, n.id, "authorized", opts.actor ?? via, { via, receivedAt: n.received_at, eligibilityAt: n.eligibility_at }, now, ...mineBinds),
        ];
      };
      // The refund operation is conditioned on the same op id (refundOpInsert's `when`).
      const stmts = extra();
      // Clarify: the sibling button (and every other unused clarify link of this notice) dies in the same batch, conditioned on THIS operation having won.
      if (clar) {
        const [mineSql, ...mineBinds] = mine(n.id, opId, "executing");
        stmts.push(q(`UPDATE verify_tokens SET used_at=?, used_by=? WHERE subject_kind='notice' AND subject_id=? AND purpose='clarify' AND used_at IS NULL AND ${mineSql}`,
          now, `inv:${opId}`, n.id, ...mineBinds));
      }
      if (v) {
        if (!(await commitToken(env, v, { lease, extra: () => stmts, ...(clar ? { guard: clarifyGuard(n.id, opts.clarifyRev!) } : {}) })).won) {
          lost = await lostCommitRefusal(env, v);
          // r1-3: refused by the notice guard (reclassified or settled meanwhile), not by the link: nothing was consumed; the notice decides.
          if (clar && lost.code === "link_invalid" && await stillUnused(env, v)) lost = undefined;
        }
      }
      else await fencedBatch(env, lease, stmts);
    });
  } catch (e) {
    if (e instanceof HomeBusy || e instanceof LeaseLost) return refuse("busy");
    if (await env.DB.prepare("SELECT 1 AS x FROM withdrawals WHERE home_id=?").bind(n.home_id).first()) return refuse("already_withdrawn");
    throw e;
  }
  const after = (await load(env, noticeId))!;
  const won = after.last_op === opId && after.state !== from;
  if (won) await carryOut(env, d, noticeId);
  const final = (await load(env, noticeId))!;
  if (!won && after.state === from && via === "execute" && pastDeadline(after, d.now ? d.now() : Date.now())) return { code: "deadline_passed", won: false, notice: final };
  const lostCode: AuthCode = after.state === from ? (clar && !clarifyRevOk(after, opts.clarifyRev!) ? "stale" : "not_eligible") : "not_open";
  return won ? { code: "ok", won: true, notice: final } : { code: lostCode, won: false, notice: final, ...(lost ? { lost } : {}) };
}

/** After the transition committed (and again from the sweep, so a crash resumes exactly once): run the refund operation, queue the acknowledgement
 *  once the refund is SUBMITTED, complete the notice once the withdrawal is done, keep the case open when the refund fails. */
export async function carryOut(env: Env, d: NoticeDeps, id: string): Promise<void> {
  const n = await load(env, id);
  if (!n || n.state !== "executing" || !n.refund_op_id) return;
  const stripe = stripeOf(env, d);
  const now = clockOf(d);
  if (stripe) {
    const billing = d.billing ?? {};
    const ctx: RefundContext = { stripe, flux: billing.flux ?? stubFluxHooks, deps: billing, now };
    try { await advanceRefundOp(env, ctx, n.refund_op_id); } catch { console.error(JSON.stringify({ message: "withdrawal notice refund step failed" })); }
  }
  const op = await getRefundOp(env, n.refund_op_id);
  if (!op) return;
  if (op.done_at !== null) {
    // r1-8: completion and its acknowledgement commit together; the acknowledgement needs the submission date as well.
    const ack = mailInsert(id, "ack", `ack:${id}`, now);
    await env.DB.batch([
      env.DB.prepare("UPDATE withdrawal_notices SET state='completed', completed_at=?, updated_at=? WHERE id=? AND state='executing'").bind(op.done_at, now, id),
      ...(op.refund_submitted_at !== null ? [env.DB.prepare(ack[0]).bind(...(ack[1] ?? []))] : []),
    ]);
  } else if (op.last_error && op.attempts > 0) {
    // The ledger's failure handling alerts; the case stays open and the notice stays `executing`.
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO withdrawal_notice_cases (id,notice_id,opened_at,reason) VALUES (?,?,?,?)").bind(`case-${id}`, id, now, "refund_failed"),
      env.DB.prepare("UPDATE withdrawal_notices SET case_id=COALESCE(case_id,?) WHERE id=?").bind(`case-${id}`, id),
    ]);
  }
  // WP10 r1-8: once the plan is ended by this withdrawal, the notice's own §5.2 cancellation (and its hold link) is retired.
  if (op.canceled_at !== null && n.cancellation_request_id && extension.afterPlanEnded) {
    try { await extension.afterPlanEnded(env, d, id); } catch { console.error(JSON.stringify({ message: "notice cancellation retire failed" })); }
  }
  await flushMail(env, d, id);
}

// --- public handlers ---------------------------------------------------------------------------------------------------------------------

const refundBody = async (env: Env, n: NoticeRow) => refundView(n.refund_op_id ? await getRefundOp(env, n.refund_op_id) : null, await pathOf(env, n));
async function confirmBody(env: Env, n: NoticeRow, won: boolean): Promise<Response> {
  const outcome = n.state === "repudiated" || n.state === "kept" ? "repudiated"
    : won ? "confirmed" : n.state === "executing" ? "already_executing" : n.state === "completed" ? "already_completed" : "refused";
  const body: { [k: string]: JSONValue } = { outcome };
  if (outcome === "refused") return json(body);
  if (outcome !== "repudiated") {
    body.receivedAt = n.received_at;
    if (n.completed_at !== null) body.completedAt = n.completed_at;
    const refund = await refundBody(env, n);
    if (refund) body.refund = refund as unknown as JSONValue;
  }
  return json(body);
}
const authFailure = (code: AuthCode): Response => code === "busy" ? errorResponse(503, "home_busy") : code === "not_found" ? errorResponse(409, "link_invalid", { canResend: false })
  : code === "not_withdrawal" ? errorResponse(409, "not_withdrawal") : code === "target_unresolved" ? errorResponse(409, "target_unresolved") : errorResponse(409, "not_open");

const confirmNotice: PublicRouteHandler = async (env, result) => {
  const n = await load(env, result.row.subjectId);
  if (!n || !n.supabase_sub || n.supabase_sub !== result.row.accountId) return errorResponse(409, "link_invalid", { canResend: false });
  if (!result.ok) return confirmBody(env, n, false);                // already used: the committed state, nothing acted twice
  if (n.state !== "open") return confirmBody(env, n, false);        // repudiated, executing, completed: never acted on by this click
  const r = await authorize(env, injected, n.id, "link", { verified: result });
  // A lost consume is classified on the commit's own clock: used (render the committed state), expired, or replaced.
  if (r.lost && r.lost.code !== "link_used") return r.lost.code === "link_expired" ? errorResponse(409, "link_expired", { canResend: true }) : errorResponse(409, "link_invalid", { canResend: false });
  if (r.code === "ok" || r.code === "not_open") return confirmBody(env, r.notice ?? n, r.won);
  return authFailure(r.code);
};

function repudiateBody(n: NoticeRow, text: string, refund: unknown): Response {
  const outcome = n.state === "repudiated" || n.state === "kept" ? "stopped" : n.state === "executing" ? "too_late_executing" : n.state === "completed" ? "too_late_completed" : "refused";
  if (outcome === "refused") return errorResponse(409, "link_invalid", { canResend: false });
  const body: { [k: string]: JSONValue } = { outcome, kind: "withdrawal", message: text };
  if (n.state === "completed" && n.completed_at !== null) body.effectiveAt = n.received_at;
  if (refund) body.refund = refund as JSONValue;
  return json(body);
}
const repudiateNotice: PublicRouteHandler = async (env, result) => {
  const d = injected;
  const row = result.row;
  const now = clockOf(d);
  let n = await load(env, row.subjectId);
  if (!n || !n.supabase_sub || n.supabase_sub !== row.accountId || !n.home_id) return errorResponse(409, "link_invalid", { canResend: false });
  if (result.ok) {
    const home = n.home_id;
    const noticeId = n.id;
    const opId = crypto.randomUUID();
    try {
      const commit = await leased(env, home, (lease) => commitToken(env, result, { lease, extra: (v) => {
        const consumed: [string, string, string] = [WHEN_CONSUMED, v.row.selector, v.opId];
        const [mineSql, ...mineBinds] = mine(noticeId, opId, "repudiated");
        return [
          q(`UPDATE withdrawal_notices SET state='repudiated', repudiated_at=?, case_id=?, last_op=?, updated_at=? WHERE id=? AND state='open' AND ${consumed[0]}`, now, `case-${noticeId}`, opId, now, noticeId, consumed[1], consumed[2]),
          // A case for EVERY press (stopped, or too late to stop); the reply is rendered from the committed state when it is sent.
          q(`INSERT OR IGNORE INTO withdrawal_notice_cases (id,notice_id,opened_at,reason) SELECT ?,?,?,? WHERE ${consumed[0]}`, `case-${noticeId}`, noticeId, now, "wasnt_me", consumed[1], consumed[2]),
          q(`INSERT OR IGNORE INTO withdrawal_notice_mail (id,notice_id,kind,mail_key,created_at) SELECT ?,?,?,?,? WHERE ${consumed[0]}`, crypto.randomUUID(), noticeId, "wasnt_me_reply", `wasnt-me:${noticeId}`, now, consumed[1], consumed[2]),
          eventWhen(mineSql, noticeId, "repudiated", "holder", { link: true }, now, ...mineBinds),
        ];
      } }));
      if (!commit.won) {
        const lost = await lostCommitRefusal(env, result);
        if (lost.code === "link_expired") return errorResponse(409, "link_expired", { canResend: true });
        if (lost.code === "link_invalid") return errorResponse(409, "link_invalid", { canResend: false });
      }
    } catch (e) {
      if (e instanceof HomeBusy || e instanceof LeaseLost) return errorResponse(503, "home_busy");
      throw e;
    }
    try { await flushMail(env, d, noticeId); } catch { /* queued; the sweep sends it */ }
    n = (await load(env, noticeId))!;
  }
  const text = await outcomeText(env, n);
  return repudiateBody(n, text, n.state === "executing" || n.state === "completed" ? await refundBody(env, n) : null);
};

async function describeNotice(env: Env, row: TokenRow): Promise<LookupDetails> {
  const n = await load(env, row.subjectId);
  if (!n) return {};
  return { ...(n.plan_name ? { planName: n.plan_name } : {}), ...(n.plan_started_at !== null ? { planStartedOn: dateOnly(n.plan_started_at) } : {}), executeByDate: dateOnly(n.execute_by) };
}

/** "Send a new link to my account email": coalesced per account and contract, mail-limited, and only to the CURRENT account email. */
async function newLinkNotice(env: Env, selector: string, d: NoticeDeps): Promise<boolean> {
  const row = await env.DB.prepare("SELECT subject_id FROM verify_tokens WHERE selector=? AND subject_kind='notice'").bind(selector).first<{ subject_id: string }>();
  if (!row) return false;
  const n = await load(env, row.subject_id);
  if (!n || n.state !== "open" || n.classification !== "withdrawal" || n.match_state !== "matched" || !n.verification_kind) return false;
  const now = clockOf(d);
  const target = n.coalesced_into ?? n.id;
  const hourBucket = Math.floor(now / HOUR);
  const r = mailInsert(target, "verify_newlink", `newlink:${target}:${hourBucket}`, now);
  await env.DB.prepare(r[0]).bind(...(r[1] ?? [])).run();
  await flushMail(env, d, target);
  return true;
}

// --- registration -----------------------------------------------------------------------------------------------------------------------

/** Registers this package with the public route shell. WRAPS the handlers WP8 registered: notices are answered here, every other subject goes on to
 *  whatever was registered before. Call it AFTER registerCancellation. */
export function registerWithdrawalNotices(billing?: BillingDependencies): void {
  if (billing) injected = { ...injected, billing };
  const before = { ...currentPublicHandlers() };
  const mineOnly = (h: PublicRouteHandler, prev: PublicRouteHandler | undefined): PublicRouteHandler =>
    async (env, result, call) => (result.row.subjectKind === "notice" ? h(env, result, call) : prev ? prev(env, result, call) : null);
  registerPublicHandlers({
    confirm: mineOnly(confirmNotice, before.confirm),
    repudiate: mineOnly(repudiateNotice, before.repudiate),
    describe: async (env, row) => (row.subjectKind === "notice" ? describeNotice(env, row) : before.describe ? before.describe(env, row) : {}),
    newLink: async (env, selector) => { if (!await newLinkNotice(env, selector, injected) && before.newLink) await before.newLink(env, selector); },
  });
}

// --- queue view ---------------------------------------------------------------------------------------------------------------------------

export type QueueStatus = "waiting" | "item" | "due_today" | "overdue" | "escalated" | "candidate" | "executing" | "case_open" | "completed" | "repudiated" | "kept" | "coalesced" | "not_withdrawal";
/** What the queue knows beyond the row (from SQL): `discharged` = the contract's withdrawal refund is submitted (or nothing was owed and it is
 *  done). Absent: not known, treated as not discharged. */
export type QueueRow = NoticeRow & { discharged?: number | null };
export function queueStatus(n: QueueRow, now: number): QueueStatus {
  if (n.state === "completed") return "completed";
  if (n.state === "kept") return "kept";
  if (n.state === "repudiated") return "repudiated";
  // r1-9: an executing notice whose refund is not submitted by the cutoff is overdue, whatever else is open on it.
  if (n.state === "executing") return n.overdue_at !== null && !n.discharged ? "overdue" : n.case_id ? "case_open" : "executing";
  // r1-4: the candidate question stays in the deadline-aware queue whatever undecided label it carries now.
  if (n.classification === "candidate" || (n.candidate_obligation === 1 && !n.clarified_action && n.classification !== "withdrawal")) return pastDeadline(n, now) ? "overdue" : "candidate";
  if (n.classification !== "withdrawal") return "not_withdrawal";
  // Only a notice from the holder (trusted, matched) has a dated item; (5b) stays escalated with its evidence and is never closed as refused.
  // Coalescing is delivery only (r1-5): a trusted follower keeps its own dated item, alert and deadline.
  if (!n.sender_trusted || n.match_state !== "matched") return "escalated";
  if (n.discharged) return "executing";
  if (pastDeadline(n, now)) return "overdue";
  if (now >= alertAtOf(n.received_at)) return "due_today";
  if (now >= itemAtOf(n.received_at)) return "item";
  return "waiting";
}
function view(n: QueueRow, now: number): { [k: string]: JSONValue } {
  const status = queueStatus(n, now);
  return { id: n.id, status, state: n.state, coalescedInto: n.coalesced_into, classification: n.classification, classificationRev: n.classification_rev, trusted: n.sender_trusted === 1, matchState: n.match_state,
    verificationKind: n.verification_kind, receivedAt: n.received_at, eligibilityAt: n.eligibility_at, executeBy: n.execute_by, executeByDate: fmtExecuteByDate(n.execute_by, "en"),
    ...(status === "item" || status === "due_today" ? { item: t("queueItem", "en", { execute_by_date: fmtExecuteByDate(n.execute_by, "en") }) } : {}),
    overdueAt: n.overdue_at, alertRaisedAt: n.alert_raised_at, alertAckedAt: n.alert_acked_at, caseId: n.case_id, correctionDue: n.correction_due === 1, refundOpId: n.refund_op_id };
}

// --- operator routes ---------------------------------------------------------------------------------------------------------------------

const classifyBody = z.strictObject({ classification: z.enum(["withdrawal", "cancellation", "candidate", "support", "unclear"]), basis: z.string().trim().min(1).max(500),
  expectedRev: z.number().int().positive().optional(), requestedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const linkBody = z.strictObject({ accountId: z.string().min(1).max(200) });
const emptyBody = z.strictObject({});

async function classify(env: Env, d: NoticeDeps, id: string, b: z.infer<typeof classifyBody>): Promise<Response> {
  const n = await load(env, id);
  if (!n) return errorResponse(404, "not_found");
  const now = clockOf(d);
  const refuseWith = async (code: string) => {
    await env.DB.prepare("INSERT INTO withdrawal_notice_events (id,notice_id,at,kind,actor,detail) VALUES (?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), id, now, "reclassify_refused", "operator", JSON.stringify({ requested: b.classification, state: n.state, code, basis: b.basis })).run();
    return errorResponse(409, code, { state: n.state });
  };
  if (n.state !== "open") return refuseWith("not_open");
  if (n.clarified_action) return refuseWith("settled");        // the holder's own clarification stands (WP10); only a new message reopens a question
  if (n.classification === b.classification) {
    // r1-5: the same label with a corrected end date: the date is kept and the cancellation follows it (no new revision: the holder's choices are unchanged).
    if (b.classification === "cancellation" && b.requestedDate && b.requestedDate !== n.requested_date) {
      const r = await env.DB.batch([
        env.DB.prepare("UPDATE withdrawal_notices SET requested_date=?, updated_at=? WHERE id=? AND state='open' AND classification='cancellation' AND classification_rev=? AND clarified_action IS NULL")
          .bind(b.requestedDate, now, id, n.classification_rev),
        env.DB.prepare("INSERT INTO withdrawal_notice_events (id,notice_id,at,kind,actor,detail) SELECT ?,?,?,?,?,? WHERE changes()=1")
          .bind(crypto.randomUUID(), id, now, "requested_date_corrected", "operator", JSON.stringify({ from: n.requested_date, to: b.requestedDate, basis: b.basis })),
      ]);
      if (r[0].meta.changes !== 1) return refuseWith("not_open");
      try { await extension.afterChange?.(env, d, id); } catch { console.error(JSON.stringify({ message: "notice follow-up failed" })); }
    }
    return json({ classification: n.classification, classificationRev: n.classification_rev });
  }
  if (b.expectedRev !== undefined && b.expectedRev !== n.classification_rev) return refuseWith("revision_mismatch");
  const opId = crypto.randomUUID();
  const away = n.classification === "withdrawal";
  const res = await env.DB.batch([
    env.DB.prepare(`UPDATE withdrawal_notices SET classification=?, classification_rev=classification_rev+1, classification_basis=?, last_op=?, updated_at=?,
        correction_due=CASE WHEN (? = 1 OR ? IN ('cancellation','support','unclear')) AND verification_sent_at IS NOT NULL THEN 1 ELSE correction_due END,
        requested_date=CASE WHEN ?='cancellation' AND ? IS NOT NULL THEN ? ELSE requested_date END,
        candidate_obligation=CASE WHEN ?='candidate' THEN 1 ELSE candidate_obligation END, ask_rev=CASE WHEN ?='withdrawal' THEN NULL ELSE ask_rev END,
        verification_kind=CASE WHEN ?='withdrawal' AND verification_kind IS NULL AND match_state='matched' THEN CASE WHEN sender_trusted=1 THEN 'trusted' WHEN sender_was_account_email=1
          THEN 'same_address_failed' ELSE 'other_sender' END ELSE verification_kind END
      WHERE id=? AND state='open' AND classification_rev=?`).bind(b.classification, b.basis, opId, now, away ? 1 : 0, b.classification, b.classification, b.requestedDate ?? null, b.requestedDate ?? null,
        b.classification, b.classification, b.classification, id, n.classification_rev),
        // binds: correction_due (away, label), requested_date (label, date, date), candidate_obligation (label), ask_rev (label), verification_kind (label)
    // The old confirm and repudiate links die with the revision (both pairs refused afterwards).
    env.DB.prepare("DELETE FROM verify_tokens WHERE subject_kind='notice' AND subject_id=? AND purpose IN ('confirm','repudiate') AND EXISTS (SELECT 1 FROM withdrawal_notices WHERE id=? AND last_op=?)").bind(id, id, opId),
    env.DB.prepare("INSERT INTO withdrawal_notice_events (id,notice_id,at,kind,actor,detail) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM withdrawal_notices WHERE id=? AND last_op=?)")
      .bind(crypto.randomUUID(), id, now, "reclassified", "operator", JSON.stringify({ from: n.classification, to: b.classification, rev: n.classification_rev + 1, basis: b.basis }), id, opId),
  ]);
  if (res[0].meta.changes !== 1) return refuseWith("not_open");
  if (away) await releaseFollowers(env, id, now);
  const after = (await load(env, id))!;
  // Put back to withdrawal: fresh links (a new key per revision); the old ones are dead.
  if (b.classification === "withdrawal" && after.match_state === "matched" && after.verification_kind) {
    const r = mailInsert(id, "verify_rev", `verify:${id}:rev${after.classification_rev}`, now);
    await env.DB.prepare(r[0]).bind(...(r[1] ?? [])).run();
    await flushMail(env, d, id);
  }
  // WP10: the candidate's ask email and renewal stop, the correction email, the cancellation behind a `cancellation` label.
  if (b.classification !== "withdrawal") { try { await extension.afterChange?.(env, d, id, { requestedDate: b.requestedDate }); } catch { console.error(JSON.stringify({ message: "notice follow-up failed" })); } }
  return json({ classification: after.classification, classificationRev: after.classification_rev, correctionDue: after.correction_due === 1 });   // as decided; the mail then clears it
}

async function linkNotice(env: Env, d: NoticeDeps, id: string, accountId: string): Promise<Response> {
  const n = await load(env, id);
  if (!n) return errorResponse(404, "not_found");
  if (n.state !== "open" || n.match_state === "matched") return errorResponse(409, "not_open");
  const now = clockOf(d);
  const m = await matchNotice(env, null, accountId, n.eligibility_at);
  if (m.state !== "matched" || !m.account || !m.consent) return errorResponse(409, m.note);
  const c = m.consent;
  const sameAddress = n.sender_count === 1 && normalizeEmail(n.sender) === normalizeEmail(m.account.contactEmail);
  const kind = verifyKind(false, sameAddress);
  const res = await env.DB.batch([
    env.DB.prepare(`UPDATE withdrawal_notices SET match_state='matched', match_note='linked_by_operator', account_id=?, supabase_sub=?, home_id=?, consent_id=?, subscription_id=?, plan_name=?, plan_started_at=?,
        sender_trusted=0, verification_kind=?, updated_at=? WHERE id=? AND state='open' AND match_state<>'matched'`)
      .bind(m.account.userId, m.account.sub, c.home_id, c.id, c.stripe_subscription_id, c.plan, c.effective_start_at ?? c.start_at, kind, now, id),
    env.DB.prepare(contractLinkInsert(c, now)[0]).bind(...(contractLinkInsert(c, now)[1] ?? [])),
    env.DB.prepare("INSERT INTO withdrawal_notice_events (id,notice_id,at,kind,actor,detail) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(), id, now, "linked", "operator", JSON.stringify({ accountId, consentId: c.id })),
  ]);
  if (res[0].meta.changes !== 1) return errorResponse(409, "not_open");
  if (n.classification === "withdrawal") {
    await env.DB.batch(verifyOutbox(id, m.account.userId, c.id, false, now).map(([sql, binds]) => env.DB.prepare(sql).bind(...(binds ?? []))));
    await flushMail(env, d, id);
  } else { try { await extension.afterChange?.(env, d, id); } catch { console.error(JSON.stringify({ message: "notice follow-up failed" })); } }
  return json({ id, matchState: "matched", verificationKind: kind });
}

export async function withdrawalAdminRoute(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const m = /^\/v1\/admin\/withdrawals(?:\/([0-9a-f]{32})(?:\/(execute|classify|link|acknowledge-alert))?|\/(intake))?$/.exec(path);
  const alias = path === "/v1/admin/withdrawal-notices";
  // GET /v1/admin/withdrawals/readiness: 503 notice_mail_key_missing while withdrawal mail cannot be sent (fails closed), else 200.
  if (path === "/v1/admin/withdrawals/readiness") {
    if (request.method !== "GET") throw new HTTPError(405, "method_not_allowed");
    await admin(request, env);
    return noticeMailReady(env) ? json({ ready: true }) : errorResponse(503, "notice_mail_key_missing");
  }
  if (!m && !alias) return null;
  const [, id, action, intakeSeg] = m ?? [];
  const isIntake = alias || intakeSeg === "intake";
  const queue = !isIntake && !id;
  const get = request.method === "GET";
  if (get ? !(queue || (id && !action)) : request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
  await admin(request, env);
  const d = injected;
  const now = clockOf(d);
  if (get) {
    if (id) {
      const n = await env.DB.prepare(`SELECT *, ${DISCHARGED} AS discharged FROM withdrawal_notices WHERE id=?`).bind(id).first<QueueRow>();
      return n ? json(view(n, now)) : errorResponse(404, "not_found");
    }
    // P2 (Astra WP9-1): keyset pages, unresolved cases first (anything not completed or kept, or with an alert still open), then by receipt.
    const url = new URL(request.url);
    const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100));
    const cursor = url.searchParams.get("cursor");
    let after: [number, number, string] | null = null;
    if (cursor) {
      try {
        const c = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/"))) as unknown;
        if (!Array.isArray(c) || c.length !== 3 || ![0, 1].includes(c[0] as number) || !Number.isSafeInteger(c[1]) || typeof c[2] !== "string" || !/^[0-9a-f]{32}$/.test(c[2])) throw new Error();
        after = c as [number, number, string];
      } catch { throw new HTTPError(400, "invalid_cursor"); }
    }
    const rank = `(CASE WHEN state IN ('completed','kept') AND (alert_raised_at IS NULL OR alert_acked_at IS NOT NULL) THEN 1 ELSE 0 END)`;
    const rows = (await env.DB.prepare(`SELECT *, ${DISCHARGED} AS discharged, ${rank} AS queue_rank FROM withdrawal_notices
        ${after ? `WHERE (${rank}, received_at, id) > (?, ?, ?)` : ""} ORDER BY queue_rank, received_at, id LIMIT ?`)
      .bind(...(after ?? []), limit + 1).all<QueueRow & { queue_rank: number }>()).results;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const next = rows.length > limit && last ? btoa(JSON.stringify([last.queue_rank, last.received_at, last.id])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : null;
    return json({ notices: page.map((n) => view(n, now)), next });
  }
  const body = await readBoundedJSON(request);
  if (isIntake) {
    const b = intakeBody.safeParse(body); if (!b.success) throw new HTTPError(400, "invalid_request");
    const r = await intake(env, d, b.data);
    const n = (await load(env, r.id))!;
    return json({ ...view(n, now), duplicate: r.duplicate }, r.duplicate ? 200 : 201);
  }
  if (!id) throw new HTTPError(405, "method_not_allowed");
  if (action === "execute") {
    if (!emptyBody.safeParse(body ?? {}).success) throw new HTTPError(400, "invalid_request");
    const r = await authorize(env, d, id, "execute", { actor: "operator" });
    if (r.code === "ok") return json({ state: r.notice!.state, refund: await refundBody(env, r.notice!) as unknown as JSONValue });
    if (r.code === "not_found") return errorResponse(404, "not_found");
    const n = r.notice;
    // "Execute refuses and the case stays open": the reason and the state, never forced.
    return errorResponse(r.code === "busy" ? 503 : 409, r.code === "not_open" && n?.state === "repudiated" ? "repudiated" : r.code, n ? { state: n.state } : undefined);
  }
  if (action === "classify") { const b = classifyBody.safeParse(body); if (!b.success) throw new HTTPError(400, "invalid_request"); return classify(env, d, id, b.data); }
  if (action === "link") { const b = linkBody.safeParse(body); if (!b.success) throw new HTTPError(400, "invalid_request"); return linkNotice(env, d, id, b.data.accountId); }
  if (!emptyBody.safeParse(body ?? {}).success) throw new HTTPError(400, "invalid_request");
  const res = await env.DB.prepare("UPDATE withdrawal_notices SET alert_acked_at=?, alert_acked_by='operator', updated_at=? WHERE id=? AND alert_raised_at IS NOT NULL AND alert_acked_at IS NULL").bind(now, now, id).run();
  return res.meta.changes === 1 ? json({ acknowledged: true }) : errorResponse(409, "no_open_alert");
}

// --- signed-in confirmation -----------------------------------------------------------------------------------------------------------

/** POST /v1/account/notices/{id}/confirm {} (aal1). Reads the NOTICE's own contract, never the latest; the classification must be `withdrawal`.
 *  A notice the holder repudiated is confirmed here with the same ordinary sign-in (r1-10: plan r13d, owner decision; r13c's step-up is
 *  superseded). Withdrawing is never harder than joining. */
export async function noticeAccountRoute(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response | null> {
  const m = /^\/v1\/account\/notices\/([0-9a-f]{32})\/confirm$/.exec(new URL(request.url).pathname);
  if (!m) return null;
  if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
  const user = await (deps.accountUser ?? (async (r, a) => (await accountSession(r, a))?.user ?? null))(request, auth);
  if (!user) throw new HTTPError(401, "unauthorized");
  if (!emptyBody.safeParse(await readBoundedJSON(request) ?? {}).success) throw new HTTPError(400, "invalid_request");
  const n = await load(env, m[1]);
  if (!n || n.account_id !== user.id) return errorResponse(404, "not_found");
  if (n.state !== "open" && n.state !== "repudiated") return confirmBody(env, n, false);
  const d = { ...injected, ...(deps.now ? { now: deps.now } : {}) };
  const r = await authorize(env, d, n.id, "signed_in", { fromRepudiated: n.state === "repudiated", actor: "holder" });
  if (r.code === "ok" || r.code === "not_open") return confirmBody(env, r.notice ?? n, r.won);
  return authFailure(r.code);
}

// --- sweep ---------------------------------------------------------------------------------------------------------------------------------

/** Cron: reconcile coalesced notices, queue reminders, send queued mail, resume executions, raise the dated item (day 12), the day-13 alert (retried
 *  until acknowledged), mark overdue, close repudiated notices as `kept` at the refund deadline. Each step stands alone. */
export async function sweepWithdrawalNotices(env: Env, billing?: BillingDependencies): Promise<void> {
  const d: NoticeDeps = { ...injected, ...(billing ? { billing } : {}) };
  const now = clockOf(d);
  // r2-1: keep every current contract's payment moment before a replacement can erase it.
  try { await env.DB.prepare(FREEZE_PAID_SQL).bind(now).run(); } catch { console.error(JSON.stringify({ message: "withdrawal notice deadline freeze failed" })); }
  const each = async <T>(sql: string, binds: unknown[], work: (r: T) => Promise<unknown>) => {
    for (const row of (await env.DB.prepare(sql).bind(...binds).all<T>()).results) { try { await work(row); } catch { console.error(JSON.stringify({ message: "withdrawal notice sweep step failed" })); } }
  };
  // An open withdrawal notice of a contract whose withdrawal another notice COMPLETED is covered by it (one withdrawal per contract).
  await env.DB.prepare(`UPDATE withdrawal_notices SET state='completed', completed_at=?, updated_at=? WHERE state='open' AND classification='withdrawal' AND consent_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM withdrawal_notices o WHERE o.consent_id=withdrawal_notices.consent_id AND o.id<>withdrawal_notices.id AND o.state='completed')`).bind(now, now).run();
  // A follower whose carrier is no longer a live withdrawal (repudiated, kept, reclassified) is released: never stranded (r1-5).
  await each<{ carrier: string }>(`SELECT DISTINCT c.id AS carrier FROM withdrawal_notices s JOIN withdrawal_notices c ON c.id=s.coalesced_into WHERE s.state='open'
    AND NOT (c.state IN ('open','executing') AND c.classification='withdrawal' AND c.match_state='matched') LIMIT 100`, [], (r) => releaseFollowers(env, r.carrier, now));
  // r1-6: a live notice with no mail obligation at all (an intake written before the obligation shared its batch) gets it now.
  await each<{ id: string; account_id: string; consent_id: string; sender_trusted: number }>(`SELECT id,account_id,consent_id,sender_trusted FROM withdrawal_notices n
    WHERE state='open' AND classification='withdrawal' AND match_state='matched' AND verification_kind IS NOT NULL AND coalesced_into IS NULL AND account_id IS NOT NULL
    AND consent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM withdrawal_notice_mail m WHERE m.notice_id=n.id AND m.kind LIKE 'verify%') LIMIT 100`, [], async (r) => {
    await env.DB.batch(verifyOutbox(r.id, r.account_id, r.consent_id, r.sender_trusted === 1, now).map(([sql, binds]) => env.DB.prepare(sql).bind(...(binds ?? []))));
  });
  await each<{ id: string }>(`SELECT id FROM withdrawal_notices n WHERE state='open' AND classification='withdrawal' AND match_state='unmatched' AND account_id IS NULL
    AND sender_count=1 AND NOT EXISTS (SELECT 1 FROM withdrawal_notice_mail m WHERE m.notice_id=n.id) LIMIT 100`, [], async (r) => {
    const [sql, binds] = unmatchedOutbox(r.id, now);
    await env.DB.prepare(sql).bind(...(binds ?? [])).run();
  });
  // r3-2: a notice whose missing deadline evidence never got its case (an intake written before the case shared its batch) gets it now.
  await each<{ id: string }>(`SELECT id FROM withdrawal_notices WHERE ${ORPHANED_CASE} LIMIT 100`, [], (r) => openCase(env, r.id, "deadline_evidence_missing", now));
  // One reminder, 3 days after the first verification email, while the links can still work.
  await each<{ id: string }>(`SELECT id FROM withdrawal_notices WHERE state='open' AND classification='withdrawal' AND match_state='matched' AND coalesced_into IS NULL
    AND verification_sent_at IS NOT NULL AND verification_sent_at<=? AND received_at+? > ? LIMIT 100`, [now - REMINDER_AFTER_MS, 14 * DAY, now], async (r) => {
    const x = mailInsert(r.id, "verify_reminder", `verify-reminder:${r.id}`, now);
    await env.DB.prepare(x[0]).bind(...(x[1] ?? [])).run();
  });
  await flushMail(env, d);
  await each<{ id: string }>("SELECT id FROM withdrawal_notices WHERE state='executing' LIMIT 50", [], (r) => carryOut(env, d, r.id));
  // The dated item (day 12), the alert (day 13), overdue (after the cutoff): only for a notice from the holder, never for (5b).
  // r1-5: every notice from the holder keeps its own item and alert, followers included, until the contract's refund is submitted.
  // r1-9: so does every executing notice (any route) until its refund is submitted: the deadline is the refund's, not the button's.
  const owed = `state='executing' AND NOT ${DISCHARGED}`;
  const live = `((state='open' AND classification='withdrawal' AND sender_trusted=1 AND match_state='matched') OR state='executing') AND NOT ${DISCHARGED}`;
  await each<{ id: string; received_at: number }>(`SELECT id,received_at FROM withdrawal_notices WHERE ${live} AND item_raised_at IS NULL`, [], async (r) => {
    if (now < itemAtOf(r.received_at)) return;
    await env.DB.batch([env.DB.prepare("UPDATE withdrawal_notices SET item_raised_at=?, updated_at=? WHERE id=? AND item_raised_at IS NULL AND state IN ('open','executing')").bind(now, now, r.id),
      env.DB.prepare("INSERT INTO withdrawal_notice_events (id,notice_id,at,kind,actor,detail) SELECT ?,?,?,?,?,? WHERE changes() = 1").bind(crypto.randomUUID(), r.id, now, "item_raised", "system", "{}")]);
  });
  await each<{ id: string; received_at: number }>(`SELECT id,received_at FROM withdrawal_notices WHERE ${live} AND alert_raised_at IS NULL`, [], async (r) => {
    if (now < alertAtOf(r.received_at)) return;
    await env.DB.batch([env.DB.prepare(`UPDATE withdrawal_notices SET alert_raised_at=?, alert_rev=classification_rev, updated_at=? WHERE id=? AND alert_raised_at IS NULL
        AND ${OWED_NOW}`).bind(now, now, r.id),
      env.DB.prepare("INSERT INTO withdrawal_notice_events (id,notice_id,at,kind,actor,detail) SELECT ?,?,?,?,?,? WHERE changes() = 1").bind(crypto.randomUUID(), r.id, now, "alert_raised", "system", "{}")]);
  });
  await each<NoticeRow>(`SELECT * FROM withdrawal_notices WHERE ((state='open' AND ((classification='withdrawal' AND sender_trusted=1) OR classification='candidate' OR (candidate_obligation=1 AND clarified_action IS NULL)))
    OR ${owed}) AND NOT ${DISCHARGED} AND overdue_at IS NULL AND execute_by+1000<=? LIMIT 100`, [now], async (n) => {
    const res = await env.DB.prepare("UPDATE withdrawal_notices SET overdue_at=?, alert_raised_at=COALESCE(alert_raised_at,?), alert_rev=COALESCE(alert_rev,classification_rev), updated_at=? WHERE id=? AND overdue_at IS NULL AND state IN ('open','executing')").bind(now, now, now, n.id).run();
    if (res.meta.changes !== 1) return;
    await env.DB.prepare("INSERT INTO withdrawal_notice_events (id,notice_id,at,kind,actor,detail) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(), n.id, now, "overdue", "system", JSON.stringify({ exposure: "refund still owed" })).run();
    await raiseAlert(env, { homeId: n.home_id ?? "billing", kind: "withdrawal.overdue", severity: "high", detail: `notice ${n.id} passed its refund deadline` }, now, d.fetcher);
  });
  if (extension.sweep) { try { await extension.sweep(env, d); } catch { console.error(JSON.stringify({ message: "notice clarify sweep failed" })); } }
  // The alert is stored and retried until acknowledged. It closes by itself only once nothing is owed: the contract's refund is submitted (or
  // nothing was owed), or the notice was stopped (repudiated, kept) or completed. An executing notice without a submitted refund keeps it (r1-9).
  await env.DB.prepare(`UPDATE withdrawal_notices SET alert_acked_at=?, alert_acked_by='system:resolved' WHERE alert_raised_at IS NOT NULL AND alert_acked_at IS NULL
    AND (state IN ('completed','kept','repudiated') OR ${DISCHARGED})`).bind(now).run();
  // WP10 r2-2: an unresolved candidate obligation keeps its alert across relabels: an unacknowledged one is rebased to the current revision, and
  // one already withdrawn (or never raised under its overdue mark) is raised again, so retry-until-ack goes on until the holder answers.
  await each<{ id: string; alert_rev: number | null; classification_rev: number; alert_raised_at: number | null }>(`SELECT id,alert_rev,classification_rev,alert_raised_at
    FROM withdrawal_notices WHERE ${CANDIDATE_OWED} AND NOT ${DISCHARGED} AND alert_acked_at IS NULL AND (alert_raised_at IS NULL OR alert_rev IS NULL OR alert_rev<>classification_rev)
    LIMIT 100`, [], async (r) => {
    await env.DB.batch([env.DB.prepare(`UPDATE withdrawal_notices SET alert_raised_at=COALESCE(alert_raised_at,?), alert_rev=classification_rev, updated_at=? WHERE id=?
        AND alert_acked_at IS NULL AND classification_rev=? AND ${CANDIDATE_OWED}`).bind(now, now, r.id, r.classification_rev),
      env.DB.prepare("INSERT INTO withdrawal_notice_events (id,notice_id,at,kind,actor,detail) SELECT ?,?,?,?,?,? WHERE changes() = 1")
        .bind(crypto.randomUUID(), r.id, now, r.alert_raised_at === null ? "alert_raised" : "alert_rebased", "system", JSON.stringify({ fromRev: r.alert_rev, rev: r.classification_rev }))]);
  });
  // r2-2: an alert belongs to the classification revision it was raised for. A notice that stopped being owed under its current classification
  // (reclassified away, or reclassified at all since) has its alert withdrawn at once: no more "refund due today" for a cancellation. Put back
  // to withdrawal, it is raised afresh for the new revision.
  await each<{ id: string; alert_rev: number | null; classification: string; classification_rev: number }>(`SELECT id,alert_rev,classification,classification_rev FROM withdrawal_notices
    WHERE alert_raised_at IS NOT NULL AND alert_acked_at IS NULL AND state='open' AND (NOT ${OWED_NOW} OR (alert_rev IS NOT NULL AND alert_rev<>classification_rev)) LIMIT 100`, [], async (r) => {
    await env.DB.batch([env.DB.prepare(`UPDATE withdrawal_notices SET alert_raised_at=NULL, alert_rev=NULL, alert_last_at=NULL, updated_at=? WHERE id=? AND alert_acked_at IS NULL
        AND state='open' AND classification_rev=?`).bind(now, r.id, r.classification_rev),
      env.DB.prepare("INSERT INTO withdrawal_notice_events (id,notice_id,at,kind,actor,detail) SELECT ?,?,?,?,?,? WHERE changes() = 1")
        .bind(crypto.randomUUID(), r.id, now, "alert_withdrawn", "system", JSON.stringify({ raisedForRev: r.alert_rev, classification: r.classification, rev: r.classification_rev }))]);
  });
  // r3-1: repair an executing notice whose refund is still unsubmitted but whose alert was left on an older revision or closed by the system
  // (written before authorization re-armed it): re-armed for the current revision, so it is retried below.
  await env.DB.prepare(`UPDATE withdrawal_notices SET alert_rev=classification_rev, alert_last_at=NULL, alert_acked_at=NULL, alert_acked_by=NULL, updated_at=?
    WHERE state='executing' AND alert_raised_at IS NOT NULL AND (alert_rev IS NOT classification_rev OR alert_acked_by='system:resolved') AND NOT ${DISCHARGED}`).bind(now).run();
  await each<NoticeRow>(`SELECT * FROM withdrawal_notices WHERE alert_raised_at IS NOT NULL AND alert_acked_at IS NULL AND ${OWED_NOW} AND NOT ${DISCHARGED}
    AND (alert_rev IS NULL OR alert_rev=classification_rev) AND (alert_last_at IS NULL OR alert_last_at<=?) LIMIT 50`, [now - ALERT_RETRY_MS], async (n) => {
    // r3-1: a revision-bound dispatch claim, validated in ONE conditional UPDATE before anything is sent: the row is still owed under the very
    // state and revision it was read at, unacknowledged and due. A reclassification, repudiation or re-arm in between wins, and nothing is sent.
    // The bookkeeping is the claim itself, so it can never land on (and delay) an alert of another revision. Delivered or not, the next retry
    // waits ALERT_RETRY_MS; only an acknowledgement stops it.
    const claim = await env.DB.prepare(`UPDATE withdrawal_notices SET alert_attempts=alert_attempts+1, alert_last_at=? WHERE id=? AND state=? AND classification_rev=?
        AND alert_rev IS ? AND alert_raised_at IS NOT NULL AND alert_acked_at IS NULL AND (alert_last_at IS NULL OR alert_last_at<=?) AND ${OWED_NOW} AND NOT ${DISCHARGED}`)
      .bind(now, n.id, n.state, n.classification_rev, n.alert_rev, now - ALERT_RETRY_MS).run();
    if (claim.meta.changes !== 1) return;
    const overdue = n.overdue_at !== null;
    const text = `[murage-cloud] ${t(overdue ? "alertOverdue" : "alertDue", "en", { id: n.id, received_at: fmtReceived(n.received_at, "en"), execute_by_date: fmtExecuteByDate(n.execute_by, "en") })}`;
    await postAlert(env, { kind: overdue ? "withdrawal.overdue" : "withdrawal.refund_due_today", severity: "high", notice: n.id, text, at: now }, d.fetcher);
  });
  // Repudiated and unanswered by the refund deadline: the case closes as kept (the notice and its evidence stay on file).
  await each<{ id: string }>("SELECT id FROM withdrawal_notices WHERE state='repudiated' AND received_at+?<=? LIMIT 100", [14 * DAY, now], async (r) => {
    await env.DB.batch([env.DB.prepare("UPDATE withdrawal_notices SET state='kept', updated_at=? WHERE id=? AND state='repudiated'").bind(now, r.id),
      env.DB.prepare("UPDATE withdrawal_notice_cases SET closed_at=?, outcome='kept' WHERE notice_id=? AND closed_at IS NULL AND EXISTS (SELECT 1 FROM withdrawal_notices WHERE id=? AND state='kept')").bind(now, r.id, r.id)]);
  });
}
