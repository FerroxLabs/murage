// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP10: clarification of an undecided emailed notice. Plan 5.3 "Candidate withdrawal", "Candidate is a fallback only", "No answer
// still stops the renewal", "Clarification links", "Signed-in clarification", "The clarify page", "Correction after the trusted email"; BUILD-PLAN WP10, C.1.
//
//   POST /v1/public/clarify { selector, secret, action }            registered through registerPublicHandlers (the shell parses, rate-limits and verifies)
//   GET  /v1/account/notices                                        the signed-in holder's open notices that need an answer (aal1, no step-up)
//   POST /v1/account/notices/{id}/clarify { action, classificationRev }
//
// The state machine this file adds to WP9's (every edge ONE conditional UPDATE in one fenced batch under the home lease; the loser writes nothing):
//   open (candidate | cancellation | support | unclear, rev R) --withdraw_now--> executing   classification:='withdrawal', rev R+1   (authorize(..., 'clarify'))
//   open (same)                                       --cancel_at_end--> open        classification:='cancellation', rev R+1, clarified_action set
// Both consume the link (when there is one), invalidate the sibling button and every other unused clarify link of the notice, and require
// `classification_rev = R` (the revision bound into the link / sent by the page). A notice that is `repudiated`, `kept`, `executing`, `completed`
// or already clarified is never touched. A clarification keeps the notice's ORIGINAL received_at and eligibility_at.
//  - A candidate from the account's own address stops the renewal at once: the §5.2 earliest-end cancellation (original received_at) is filed when the
//    notice is filed, its confirmation (end date + hold link) goes out together with the ask email. No answer: the stop stays, the case stays open, overdue.
//  - Sending a mail never changes a classification. A reclassification raises the revision, so older clarify links answer `stale`.
import { z } from "zod";
import { fencedBatch, HomeBusy, LeaseLost, q, type Q } from "./billing-lease";
import { fmtDate, fmtReceived, type Lang } from "./cancellation-strings";
import { HTTPError, errorResponse, json, readBoundedJSON, type JSONValue } from "./http";
import { accountSession, type ControlPlaneAuth } from "./auth";
import type { BillingDependencies } from "./b5-billing";
import { committedCancellation, fileNoticeCancellation, redateNoticeCancellation, retireNoticeCancellation } from "./public-cancellation";
import { currentPublicHandlers, registerPublicHandlers, type PublicRouteHandler } from "./public-routes";
import { commitToken, lostCommitRefusal, prepareToken, reserveMail, stillUnused, WHEN_CONSUMED, type ClarifyAction, type Verified } from "./public-tokens";
import { t } from "./notice-strings";
import {
  accountIdentity, authorize, claimHeld, clarifyGuard, clarifyRevOk, clockOf, dateOnly, eventWhen, leased, linkOf, load, mailInsert, mine, noticeDeps, registerNoticeExtension, flushMail, executeByOf,
  type Mail, type MailClaim, type NoticeDeps, type NoticeRow,
} from "./withdrawal-notices";

const UNDECIDED = "('candidate','cancellation','support','unclear')";
const isUndecided = (n: Pick<NoticeRow, "classification">) => n.classification !== "withdrawal";

// --- the renewal stop and the cancellation behind a notice ---------------------------------------------------------------------------------

/** The subscription of the notice's OWN contract (frozen on the notice, else the contract's records), never the home's current one. Records that
 *  disagree, or none: null (nothing is filed; WP9's Execute treats the same as a case). */
async function contractSubscription(env: Env, n: NoticeRow): Promise<string | null> {
  const c = n.consent_id ? await env.DB.prepare("SELECT stripe_subscription_id AS s FROM checkout_consents WHERE id=?").bind(n.consent_id).first<{ s: string | null }>() : null;
  const l = n.consent_id ? await env.DB.prepare("SELECT subscription_id AS s FROM contract_links WHERE consent_id=?").bind(n.consent_id).first<{ s: string | null }>() : null;
  const known = [n.subscription_id, c?.s ?? null, l?.s ?? null].filter((x): x is string => Boolean(x));
  return new Set(known).size === 1 ? known[0] : null;
}

/** The §5.2 cancellation for this notice (earliest end, or the date the operator read out of the message), from the ORIGINAL received_at, bound
 *  at insertion to the notice's frozen account, home and contract (r1-1). Idempotent; null when the plan cannot be scheduled yet (the sweep calls
 *  again). r1-2: the automatic stop is for a notice from the account's own address only; the holder's own authenticated choice (a clarify link
 *  bound to the account email, or the signed-in account page) always counts, whatever address the notice came from. */
async function ensureCancellation(env: Env, d: NoticeDeps, n: NoticeRow, requestedDate?: string): Promise<string | null> {
  if (n.cancellation_request_id) return n.cancellation_request_id;
  if (!n.account_id || !n.supabase_sub || !n.home_id) return null;
  if (n.sender_was_account_email !== 1 && n.clarified_action !== "cancel_at_end") return null;
  const subscriptionId = await contractSubscription(env, n);
  if (!subscriptionId) return null;
  const email = (await env.DB.prepare("SELECT contact_email FROM supabase_identities WHERE sub=?").bind(n.supabase_sub).first<{ contact_email: string | null }>())?.contact_email;
  if (!email) return null;
  const id = await fileNoticeCancellation(env, d, { noticeId: n.id, receivedAt: n.received_at, email, language: n.language, userId: n.account_id, supabaseSub: n.supabase_sub,
    homeId: n.home_id, subscriptionId, requestedDate: requestedDate ?? n.requested_date ?? null });
  if (!id) return null;
  const now = clockOf(d);
  const res = await env.DB.prepare("UPDATE withdrawal_notices SET cancellation_request_id=?, updated_at=? WHERE id=? AND cancellation_request_id IS NULL").bind(id, now, n.id).run();
  if (res.meta.changes === 1) await env.DB.prepare("INSERT INTO withdrawal_notice_events (id,notice_id,at,kind,actor,detail) VALUES (?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), n.id, now, "renewal_stop_scheduled", "system", JSON.stringify({ cancellationRequestId: id, kind: requestedDate ?? n.requested_date ? "ordinary_date" : "ordinary_earliest" })).run();
  return id;
}

/** r1-5: the cancellation follows the end date kept on the notice (a corrected date replaces the provisional earliest end, under the lease,
 *  receipt and hold kept). Idempotent; the sweep repeats it until it holds. */
async function followDate(env: Env, d: NoticeDeps, n: NoticeRow, requestId: string | null): Promise<void> {
  if (!requestId || !n.requested_date) return;
  if (await redateNoticeCancellation(env, d, requestId, n.requested_date)) {
    await env.DB.prepare(`INSERT INTO withdrawal_notice_events (id,notice_id,at,kind,actor,detail) SELECT ?,?,?,?,?,? WHERE NOT EXISTS
        (SELECT 1 FROM withdrawal_notice_events WHERE notice_id=? AND kind='renewal_stop_redated' AND detail=?)`)
      .bind(crypto.randomUUID(), n.id, clockOf(d), "renewal_stop_redated", "system", JSON.stringify({ requestedDate: n.requested_date }), n.id, JSON.stringify({ requestedDate: n.requested_date })).run();
  }
}

async function enqueue(env: Env, d: NoticeDeps, noticeId: string, kind: string, key: string): Promise<void> {
  const [sql, binds] = mailInsert(noticeId, kind, key, clockOf(d));
  await env.DB.prepare(sql).bind(...(binds ?? [])).run();
}

/** A (re)classified notice: a candidate is filed (renewal stop + ask email), a `cancellation` gets its §5.2 cancellation, a notice moved away from
 *  `withdrawal` after the verification email went gets its correction. Idempotent; the sweep repeats whatever a crash cut short. */
export async function afterChange(env: Env, d: NoticeDeps, id: string, hint: { requestedDate?: string } = {}): Promise<void> {
  const n = await load(env, id);
  if (!n || n.state !== "open" || n.match_state !== "matched" || !n.home_id || !n.account_id) return;
  if (n.classification === "candidate") {
    // r1-6: moved here from `withdrawal` after the trusted email went: the holder must be told that email no longer applies, whatever happens to
    // the renewal stop, so the superseding two-choice clarification goes even when no stop can be filed (its wording then says the plan continues).
    const retract = n.correction_due === 1 && n.verification_sent_at !== null;
    // A candidate from another address gets no automatic action: its renewal stop is an instruction only the account's own address can give.
    const stopped = n.sender_was_account_email === 1 ? await ensureCancellation(env, d, n) : null;
    if (!stopped && !retract) return;
    await enqueue(env, d, n.id, `ask:${n.classification_rev}`, `ask:${n.id}:${n.classification_rev}`);
  } else if (n.classification === "cancellation" || n.classification === "support" || n.classification === "unclear") {
    // r1-4: a candidate relabelled support or unclear keeps its renewal stop (and its account entry and deadline): a wrong label never
    // suppresses the candidate question; only the holder's answer settles it.
    const stopped = n.classification === "cancellation" || n.candidate_obligation === 1 ? await ensureCancellation(env, d, n, hint.requestedDate) : null;
    await followDate(env, d, n, stopped);
    const retract = n.correction_due === 1 && n.verification_sent_at !== null;
    // r2-1: the relabel moved the revision, so the links already sent answer `stale`. The open candidate question gets FRESH choices bound to the
    // new revision: the owed correction (its label's wording, a fresh withdraw-now link; the account page offers both choices) or, when none is
    // owed, the ask again whenever the holder was asked before or the account's own address stopped the renewal.
    if (retract) await enqueue(env, d, n.id, `correction:${n.classification_rev}`, `correction:${n.id}:${n.classification_rev}`);
    else if (n.candidate_obligation === 1 && (n.ask_rev !== null || (stopped && n.sender_was_account_email === 1))) await enqueue(env, d, n.id, `ask:${n.classification_rev}`, `ask:${n.id}:${n.classification_rev}`);
  }
  await flushMail(env, d, id);
}

// --- mail ----------------------------------------------------------------------------------------------------------------------------------

const labelsOf = (text: string) => [...text.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
const fmtStarted = (n: NoticeRow, lang: Lang) => (n.plan_started_at !== null ? fmtDate(n.plan_started_at, lang) : "");

/** r3-1: the issuance is a revision-fenced conditional write: a link is (re)issued only while the notice is still open, unanswered and at
 *  exactly the revision the mail is written for, in the same statement, and never replaces a link of a newer revision. A render overtaken by a
 *  relabel issues nothing ("stale"), so the newer revision's links stay the only live set. null: past the link cap.
 *  r4-1: nothing is written here. The statements are returned and run by flushMail in ONE batch with the stored mail, each also conditioned on
 *  the sender's live claim on the mail row (claim id, not only the revision): a sender whose claim lapsed while a second sender delivered the
 *  same revision's mail replaces none of the delivered links, and the pair is stored whole or not at all. */
async function clarifyLinks(env: Env, d: NoticeDeps, n: NoticeRow, identity: { email: string; updatedAt: string }, actions: ClarifyAction[], claim: MailClaim)
  : Promise<{ urls: Record<string, string>; selectors: string[]; writes: Q[] } | null | "stale"> {
  const urls: Record<string, string> = {};
  const selectors: string[] = [];
  const writes: Q[] = [];
  const cur = await env.DB.prepare("SELECT 1 AS x FROM withdrawal_notices WHERE id=? AND classification_rev=? AND state='open' AND clarified_action IS NULL AND classification<>'withdrawal'")
    .bind(n.id, n.classification_rev).first();
  if (!cur) return "stale";
  const [held, heldBinds] = claimHeld(claim, clockOf(d));
  const when: [string, unknown[]] = [`EXISTS (SELECT 1 FROM withdrawal_notices WHERE id=? AND classification_rev=? AND state='open' AND clarified_action IS NULL
    AND classification<>'withdrawal') AND ${held}`, [n.id, n.classification_rev, ...(heldBinds ?? [])]];
  for (const action of actions) {
    const p = await prepareToken(env, d, { purpose: "clarify", action, classificationRev: n.classification_rev, subjectKind: "notice", subjectId: n.id, accountId: n.supabase_sub!,
      accountEmail: identity.email, supabaseUpdatedAt: identity.updatedAt, receivedAt: n.received_at }, { when });
    if (!p) return null;  // received + 14 days has passed: no link any more; the signed-in route is the way
    urls[action] = linkOf(env, d, p.issued.token).replace("/verify#", "/clarify#");        // the site's clarify page
    selectors.push(p.issued.selector);
    writes.push(p.write);
  }
  return { urls, selectors, writes };
}

/** r1-7: what the cancellation behind a notice is NOW, from its committed row: none (not filed), pending (filed, not scheduled yet), scheduled
 *  (open: the plan ends at effectiveAt), held (held or kept: the plan continues and renews), ended (being ended or ended; or retired because the
 *  contract had ended or a withdrawal ended it). Every outcome and mail about the cancellation is rendered from this, never from the action. */
type CxState = "none" | "pending" | "scheduled" | "held" | "ended";
interface CxView { state: CxState; effectiveAt: number | null; superseded: string | null }
async function cxView(env: Env, n: Pick<NoticeRow, "cancellation_request_id">): Promise<CxView> {
  if (!n.cancellation_request_id) return { state: "none", effectiveAt: null, superseded: null };
  const c = await committedCancellation(env, n.cancellation_request_id);
  if (!c) return { state: "pending", effectiveAt: null, superseded: null };
  if (c.superseded) return { state: "ended", effectiveAt: c.effectiveAt, superseded: c.superseded };
  if (c.status === "held" || c.status === "kept") return { state: "held", effectiveAt: c.effectiveAt, superseded: null };
  if (c.status === "executing" || c.status === "completed") return { state: "ended", effectiveAt: c.effectiveAt, superseded: null };
  return { state: "scheduled", effectiveAt: c.effectiveAt, superseded: null };
}
const basisOf = (v: CxView) => `${v.state}:${v.effectiveAt ?? ""}:${v.superseded ?? ""}`;

/** r2-3: the ask's words from the cancellation's COMMITTED status, never from the label: the plan's ask (its "no answer: the plan ends and does not
 *  renew" sentence) only while a stop is actually scheduled; held: the plan continues and renews; no stop: the plan continues. r1-6: a superseding
 *  ask retracts the earlier automatic promise in so many words. */
function askBody(v: CxView, retract: boolean, lang: Lang, vars: Record<string, string>): { body: string; actions: ClarifyAction[] } {
  const both: ClarifyAction[] = ["withdraw_now", "cancel_at_end"];
  const pre = retract ? `${t("askRetract", lang)}\n\n` : "";
  if (v.state === "held") return { body: `${pre}${t("askHeld", lang, vars)}`, actions: both };
  if (v.state === "none") return { body: retract ? t("askRetractOther", lang, vars) : t("askOpen", lang, vars), actions: both };
  if (v.state === "scheduled") return { body: `${pre}${t("ask", lang, vars)}`, actions: both };
  // r2-7: filed but not scheduled yet: no end date and no "plan continues"; ended (being ended, ended, or the contract had ended): nothing left to
  // cancel, so only the withdrawal is offered and nothing claims the plan continues.
  if (v.state === "pending") return { body: `${pre}${t("askPending", lang, vars)}`, actions: both };
  return { body: `${pre}${t("askEnded", lang, vars)}`, actions: ["withdraw_now"] };
}

/** ask:<rev>, correction:<rev>, clarified. Rendered from the COMMITTED state at send time; "skip" when it no longer applies. A mail about the
 *  cancellation carries the basis it was rendered on, so a cached copy is rendered afresh once the committed state moved (stillValid). */
async function renderMail(env: Env, d: NoticeDeps, n: NoticeRow, kind: string, claim: MailClaim): Promise<Mail | "skip" | "limited" | null> {
  const lang = n.language;
  const [base, revText] = kind.split(":");
  const rev = Number(revText);
  if (base === "clarified") {
    if (n.clarified_action !== "cancel_at_end") return "skip";
    if (!n.cancellation_request_id) return null;                  // r1-2: the handoff is not done yet: stays queued until it is
    const v = await cxView(env, n);
    if (v.state === "pending") return null;                       // not scheduled yet: stays queued
    if (v.superseded) return "skip";                              // contract ended / withdrawn: nothing of this to confirm
    const id = await accountIdentity(env, d, n);
    if (!id) return null;
    const c = await committedCancellation(env, n.cancellation_request_id);
    if (!c) return null;
    return { to: id.email, subject: t("subjectClarified", lang), text: c.text, basis: basisOf(v) };
  }
  if (base === "expiry") {
    // r1-9: the ask links expired unanswered: the later full confirmation of the renewal stop, from its committed state (held or kept: the plan
    // continues and renews, no cancellation claim; scheduled: the end date; ended: the end).
    if (n.clarified_action || n.state !== "open" || !n.cancellation_request_id) return "skip";
    const v = await cxView(env, n);
    if (v.state === "pending") return null;
    if (v.state === "none" || v.superseded) return "skip";
    const id = await accountIdentity(env, d, n);
    if (!id) return null;
    const c = await committedCancellation(env, n.cancellation_request_id);
    if (!c) return null;
    return { to: id.email, subject: t("subjectClarified", lang), text: c.text, basis: basisOf(v) };
  }
  // ask and correction: only while this is still the revision they were written for, and the notice is still undecided and open.
  if (n.state !== "open" || n.clarified_action || n.match_state !== "matched" || !n.supabase_sub || n.classification_rev !== rev) return "skip";
  const id = await accountIdentity(env, d, n);
  if (!id) return null;
  const vars = { received_at: fmtReceived(n.received_at, lang), plan_name: n.plan_name ?? "", plan_started_on: fmtStarted(n, lang) };
  if (base === "ask") {
    if (n.classification !== "candidate" && n.candidate_obligation !== 1) return "skip";     // r2-1: an open obligation under another undecided label too
    const retract = n.correction_due === 1 && n.verification_sent_at !== null;
    const v = await cxView(env, n);
    const { body, actions } = askBody(v, retract, lang, vars);
    if (!await reserveMail(env, d, id.email)) return "limited";
    const issued = await clarifyLinks(env, d, n, id, actions, claim);
    if (issued === "stale") return "skip";                       // r3-1: overtaken by a relabel; the newer revision's mail carries the live links
    const links = issued?.urls ?? null;
    if (!links && !retract) return "skip";
    // r1-4: these links stay the candidate's choices while the question is open, whatever undecided label it gets later. r4-1: stored with them.
    const writes: Q[] = issued ? [...issued.writes, q("UPDATE withdrawal_notices SET ask_rev=? WHERE id=? AND classification_rev=? AND classification<>'withdrawal' AND (classification='candidate' OR candidate_obligation=1)", rev, n.id, rev)] : [];
    const labels = labelsOf(body);
    const tail = links ? actions.map((a, i) => `${labels[i]}: ${links[a]}`).join("\n") : t("clarifyExpired", lang);   // past the link cap: sign in
    // r2-3: EVERY ask carries the basis it was rendered on, so a cached copy is rendered afresh once the cancellation moved (a hold, an end).
    return { to: id.email, subject: t(retract ? "subjectCorrection" : "subjectAsk", lang), text: `${body}\n\n${tail}`, basis: basisOf(v),
      ...(issued ? { clarify: { rev, selectors: issued.selectors }, writes, issued: issued.selectors } : {}) };
  }
  if (base === "correction") {
    if (n.classification !== "cancellation" && n.classification !== "support" && n.classification !== "unclear") return "skip";
    let key: "correctionCancellation" | "correctionSupport" | "correctionHeld" | "correctionEnded" = "correctionSupport";
    let effectiveAt = "";
    const v = await cxView(env, n);
    if (n.classification === "cancellation") {
      // r1-7: what the cancellation committed, never what the label implies: a held (or kept) one continues the plan; a contract that had already
      // ended has nothing to end; a cancellation that cannot be filed (another address, no holder's choice) leaves the plan running for now.
      if (v.state === "pending" || (v.state === "none" && n.sender_was_account_email === 1)) return null;   // being filed: stays queued
      if (v.state === "held") key = "correctionHeld";
      else if (v.state === "ended" && v.superseded === "contract_ended") key = "correctionEnded";
      else if (v.state === "scheduled" || v.state === "ended") { key = "correctionCancellation"; effectiveAt = fmtDate(v.effectiveAt ?? n.received_at, lang); }
    }
    if (!await reserveMail(env, d, id.email)) return "limited";
    // A correction is owed even past the link cap (r1-6): it then points to the signed-in route instead of a link.
    const issued = await clarifyLinks(env, d, n, id, ["withdraw_now"], claim);
    if (issued === "stale") return "skip";                       // r3-1: overtaken by a relabel
    const body = t(key, lang, { ...vars, effective_at: effectiveAt });
    const [label] = labelsOf(body);
    return { to: id.email, subject: t("subjectCorrection", lang), text: `${body}\n\n${issued ? `${label}: ${issued.urls.withdraw_now}` : t("clarifyExpired", lang)}`, basis: basisOf(v),
      ...(issued ? { clarify: { rev, selectors: issued.selectors }, writes: issued.writes, issued: issued.selectors } : {}) };
  }
  return "skip";
}

/** A cached (already rendered) mail is sent only while it still applies: same state, revision and recipient (WP9 security review), and (r1-7) the
 *  same committed cancellation state it was written about. false: render it afresh from the committed state (which may skip it). */
async function stillValid(env: Env, d: NoticeDeps, n: NoticeRow, kind: string, mail: Mail): Promise<boolean | null> {
  const [base, revText] = kind.split(":");
  if (base === "ask" || base === "correction") {
    if (n.state !== "open" || n.clarified_action || n.match_state !== "matched" || n.classification_rev !== Number(revText)) return false;
    if (base === "ask" && n.classification !== "candidate" && n.candidate_obligation !== 1) return false;
    if (base === "correction" && n.classification !== "cancellation" && n.classification !== "support" && n.classification !== "unclear") return false;
  }
  if (mail.basis !== undefined && mail.basis !== basisOf(await cxView(env, n))) return false;
  // r3-1: the links the mail carries must still be the notice's live clarify links of the revision it was written for (a reissue replaced them).
  if (mail.clarify && mail.clarify.selectors.length > 0) {
    const sel = mail.clarify.selectors;
    const live = await env.DB.prepare(`SELECT COUNT(*) AS n FROM verify_tokens WHERE subject_kind='notice' AND subject_id=? AND purpose='clarify' AND used_at IS NULL
      AND classification_rev=? AND selector IN (${sel.map(() => "?").join(",")})`).bind(n.id, mail.clarify.rev, ...sel).first<{ n: number }>();
    if (live?.n !== sel.length) return false;
  }
  const id = await accountIdentity(env, d, n);
  if (!id) return null;
  return id.email === mail.to.trim().toLowerCase();
}

// --- the answers ---------------------------------------------------------------------------------------------------------------------------

/** cancel_pending (r1-2): the holder's choice is committed but its cancellation is not handed to the §5.2 processing yet (the sweep finishes it);
 *  cancel_scheduled only once that durable handoff exists. */
export type ClarifyOutcome = "withdrawn" | "cancel_pending" | "cancel_scheduled" | "cancel_held" | "cancel_ended" | "stale" | "closed" | "refused";
/** What the page says, from the committed state only (never from the attempted action). */
async function outcomeBody(env: Env, n: NoticeRow, action: ClarifyAction, boundRev: number): Promise<{ [k: string]: JSONValue }> {
  if (n.clarified_action === action) {
    if (action === "withdraw_now") return { outcome: "withdrawn", receivedAt: n.received_at, effectiveAt: n.received_at };
    // r1-7: from the cancellation's committed status. Held or kept: the plan continues (no end is claimed); ended: being ended or ended.
    const v = await cxView(env, n);
    if (v.state === "none" || v.state === "pending") return { outcome: "cancel_pending", receivedAt: n.received_at };
    if (v.state === "held") return { outcome: "cancel_held", receivedAt: n.received_at };
    if (v.state === "ended") return { outcome: "cancel_ended", receivedAt: n.received_at, ...(v.effectiveAt !== null ? { effectiveAt: v.effectiveAt } : {}) };
    return { outcome: "cancel_scheduled", receivedAt: n.received_at, effectiveAt: v.effectiveAt! };
  }
  if (n.clarified_action) return { outcome: "refused" };               // the other button won
  if (!clarifyRevOk(n, boundRev)) return { outcome: "stale" };
  if (n.state !== "open") return { outcome: "closed" };               // repudiated, kept, executing, completed: not reopened by a clarify
  return { outcome: "refused" };
}

type Settled = { kind: "done" } | { kind: "lost"; code: "link_expired" | "link_invalid" } | { kind: "busy" };

/** `cancel_at_end`: ONE fenced batch = consume (when a link), set the classification, bump the revision, invalidate the siblings, queue the confirmation. */
async function settleCancel(env: Env, d: NoticeDeps, n: NoticeRow, rev: number, verified: Verified | undefined, actor: string): Promise<Settled> {
  const now = clockOf(d);
  const opId = crypto.randomUUID();
  let lostCode: "link_expired" | "link_invalid" | null = null;
  try {
    await leased(env, n.home_id!, async (lease) => {
      const consumedSql = verified ? WHEN_CONSUMED : "1=1";
      const consumedBinds = verified ? [verified.row.selector, verified.opId] : [];
      const [mineSql, ...mineBinds] = mine(n.id, opId, "open");
      const [guardSql, ...guardBinds] = clarifyGuard(n.id, rev);
      const stmts: Q[] = [
        q(`UPDATE withdrawal_notices SET classification='cancellation', classification_rev=classification_rev+1, classification_basis='clarified by the holder: cancel_at_end',
            clarified_action='cancel_at_end', clarified_at=?, candidate_obligation=0, last_op=?, updated_at=?
          WHERE id=? AND classification IN ${UNDECIDED} AND ${guardSql} AND ${consumedSql}`, now, opId, now, n.id, ...guardBinds, ...consumedBinds),
        q(`UPDATE verify_tokens SET used_at=?, used_by=? WHERE subject_kind='notice' AND subject_id=? AND purpose='clarify' AND used_at IS NULL AND ${mineSql}`, now, `inv:${opId}`, n.id, ...mineBinds),
        q(`INSERT OR IGNORE INTO withdrawal_notice_mail (id,notice_id,kind,mail_key,created_at) SELECT ?,?,?,?,? WHERE ${mineSql}`, crypto.randomUUID(), n.id, "clarified", `clarified:${n.id}`, now, ...mineBinds),
        eventWhen(mineSql, n.id, "clarified", actor, { action: "cancel_at_end", fromRev: rev, receivedAt: n.received_at, eligibilityAt: n.eligibility_at }, now, ...mineBinds),
      ];
      if (verified) {
        // r1-3: the notice guard is part of the consume itself: a press that loses to a reclassification consumes nothing.
        if (!(await commitToken(env, verified, { lease, extra: () => stmts, guard: clarifyGuard(n.id, rev) })).won) {
          const l = await lostCommitRefusal(env, verified);
          lostCode = l.code === "link_expired" ? "link_expired" : l.code === "link_used" ? null : await stillUnused(env, verified) ? null : "link_invalid";
        }
      } else await fencedBatch(env, lease, stmts);
    });
  } catch (e) {
    if (e instanceof HomeBusy || e instanceof LeaseLost) return { kind: "busy" };
    throw e;
  }
  if (lostCode) return { kind: "lost", code: lostCode };
  const after = await load(env, n.id);
  if (after?.clarified_action === "cancel_at_end" && after.last_op === opId) {
    // Hand to the cancellation processing: the earliest end from the ORIGINAL received_at (already filed for a candidate).
    try { await ensureCancellation(env, d, after); } catch { console.error(JSON.stringify({ message: "clarify cancellation failed" })); }
    try { await flushMail(env, d, n.id); } catch { /* queued; the sweep sends it */ }
  }
  return { kind: "done" };
}

/** The one entry for both routes. `verified` present = a link press; absent = the signed-in holder. */
async function answer(env: Env, d: NoticeDeps, id: string, action: ClarifyAction, rev: number, verified: Verified | undefined, actor: string):
  Promise<{ n: NoticeRow | null; error?: Response; stale?: boolean }> {
  const n = await load(env, id);
  if (!n) return { n: null };
  if (n.clarified_action) return { n };                                  // settled already: the committed choice is what gets rendered
  // Nothing is consumed unless the notice is open, undecided and at exactly the bound revision: a refused press leaves its link untouched.
  if (!clarifyRevOk(n, rev)) return { n, stale: true };
  if (n.state !== "open" || n.clarified_action || !isUndecided(n) || n.match_state !== "matched" || !n.home_id) return { n };
  if (action === "withdraw_now") {
    const r = await authorize(env, d, id, "clarify", { ...(verified ? { verified } : {}), clarifyRev: rev, actor });
    if (r.lost && r.lost.code !== "link_used") return { n: r.notice ?? n, error: r.lost.code === "link_expired" ? errorResponse(409, "link_expired", { canResend: false }) : errorResponse(409, "link_invalid", { canResend: false }) };
    if (r.code === "busy") return { n: r.notice ?? n, error: errorResponse(503, "home_busy") };
    const after = await load(env, id);
    // r1-10: lost to a reclassification (no holder's choice committed meanwhile): the revision conflict, not a 200.
    if (r.code === "stale" || (after && !after.clarified_action && after.state === "open" && !clarifyRevOk(after, rev))) return { n: after, stale: !after?.clarified_action };
    return { n: r.notice ?? after };
  }
  const s = await settleCancel(env, d, n, rev, verified, actor);
  if (s.kind === "busy") return { n, error: errorResponse(503, "home_busy") };
  if (s.kind === "lost") return { n, error: errorResponse(409, s.code, { canResend: false }) };
  const after = await load(env, id);
  // r1-10: the UPDATE lost to a reclassification and no holder's choice committed: report the revision conflict (409 stale_revision signed in).
  if (after && !after.clarified_action && after.state === "open" && !clarifyRevOk(after, rev)) return { n: after, stale: true };
  return { n: after };
}

const clarifyNotice: PublicRouteHandler = async (env, result) => {
  const row = result.row;
  const d = noticeDeps();
  const n = await load(env, row.subjectId);
  if (row.purpose !== "clarify" || row.action === "" || !n || !n.supabase_sub || n.supabase_sub !== row.accountId) return errorResponse(409, "link_invalid", { canResend: false });
  const action = row.action;
  const rev = row.classificationRev ?? -1;
  if (!result.ok) return json(await outcomeBody(env, n, action, rev));          // already used: the committed state, nothing acted twice
  const a = await answer(env, d, n.id, action, rev, result, "holder");
  if (a.error) return a.error;
  if (!a.n) return errorResponse(409, "link_invalid", { canResend: false });
  return json(await outcomeBody(env, a.n, action, rev));
};

// --- signed in (aal1) ----------------------------------------------------------------------------------------------------------------------

/** r2-6: `processing` (account list only): the holder chose the end of the paid month and that cancellation is not scheduled yet. */
export type NoticeKind = "withdrawal" | "candidate" | "correction" | "processing";
/** What the holder is asked, or null when the notice needs no answer: a classified withdrawal not yet confirmed; a candidate; a notice moved away from
 *  `withdrawal` after the verification email went (the correction notice). */
export function kindOf(n: NoticeRow): NoticeKind | null {
  if (n.state !== "open" || n.match_state !== "matched" || n.coalesced_into) return null;
  if (n.classification === "withdrawal") return "withdrawal";
  if (n.clarified_action) return null;
  if (n.classification === "candidate" || n.candidate_obligation === 1) return "candidate";   // r1-4: whatever the label says now
  if ((n.classification === "cancellation" || n.classification === "support" || n.classification === "unclear") && n.verification_sent_at !== null) return "correction";
  return null;
}
const CHOICES: Record<NoticeKind, string[]> = { withdrawal: ["confirm"], candidate: ["withdraw_now", "cancel_at_end"], correction: ["withdraw_now", "cancel_at_end"], processing: [] };

async function listNotices(env: Env, userId: string): Promise<Response> {
  const rows = (await env.DB.prepare("SELECT * FROM withdrawal_notices WHERE account_id=? AND state='open' ORDER BY received_at, id").bind(userId).all<NoticeRow>()).results;
  const notices: JSONValue[] = [];
  for (const n of rows) {
    const cx = await cxView(env, n);
    // r2-6: a settled "end at the end of the paid month" stays visible while its cancellation is still being processed (filed, not scheduled).
    const kind: NoticeKind | null = kindOf(n) ?? (n.clarified_action === "cancel_at_end" && (cx.state === "pending" || cx.state === "none") && n.match_state === "matched" ? "processing" : null);
    if (!kind) continue;
    const eff = cx.state === "scheduled" ? cx.effectiveAt : null;     // r1-7: an end date only while one is actually scheduled
    // expiresAt is informational: the end of the refund-deadline day (UTC). The notice stays answerable here after it (original dates still count).
    notices.push({ id: n.id, kind, classificationRev: n.classification_rev, receivedAt: n.received_at, eligibilityAt: n.eligibility_at, planName: n.plan_name ?? "",
      planStartedOn: n.plan_started_at !== null ? dateOnly(n.plan_started_at) : "", ...(eff !== null && kind !== "withdrawal" ? { effectiveAt: eff } : {}), choices: CHOICES[kind],
      expiresAt: executeByOf(n.received_at) + 1000 });
  }
  return json({ notices });
}

const clarifyBody = z.strictObject({ action: z.enum(["withdraw_now", "cancel_at_end"]), classificationRev: z.number().int().positive() });
/** GET /v1/account/notices and POST /v1/account/notices/{id}/clarify. Ordinary sign-in only: not in STEP_UP_ROUTES (plan 5.3, accepted sign-in-only rule). */
export async function clarifyAccountRoute(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response | null> {
  const m = /^\/v1\/account\/notices(?:\/([0-9a-f]{32})\/clarify)?$/.exec(new URL(request.url).pathname);
  if (!m) return null;
  const id = m[1];
  if (request.method !== (id ? "POST" : "GET")) throw new HTTPError(405, "method_not_allowed");
  const user = await (deps.accountUser ?? (async (r, a) => (await accountSession(r, a))?.user ?? null))(request, auth);
  if (!user) throw new HTTPError(401, "unauthorized");
  if (!id) return listNotices(env, user.id);
  const body = clarifyBody.safeParse(await readBoundedJSON(request));
  if (!body.success) throw new HTTPError(400, "invalid_request");
  const n = await load(env, id);
  if (!n || n.account_id !== user.id) return errorResponse(404, "not_found");
  const d: NoticeDeps = { ...noticeDeps(), ...(deps.now ? { now: deps.now } : {}) };
  const { action, classificationRev } = body.data;
  const a = await answer(env, d, id, action, classificationRev, undefined, "holder");
  if (a.error) return a.error;
  if (a.stale) return errorResponse(409, "stale_revision", { classificationRev: a.n?.classification_rev ?? n.classification_rev });
  return json(await outcomeBody(env, a.n ?? n, action, classificationRev));
}

// --- sweep ---------------------------------------------------------------------------------------------------------------------------------

/** Resumes what a crash cut short: candidates not yet filed, a settled `cancel_at_end` whose cancellation is not yet scheduled, corrections not yet queued. */
async function sweep(env: Env, d: NoticeDeps): Promise<void> {
  const each = async (sql: string, binds: unknown[], work: (id: string) => Promise<unknown>) => {
    for (const r of (await env.DB.prepare(sql).bind(...binds).all<{ id: string }>()).results) { try { await work(r.id); } catch { console.error(JSON.stringify({ message: "clarify sweep step failed" })); } }
  };
  await each(`SELECT id FROM withdrawal_notices WHERE state='open' AND match_state='matched' AND clarified_action IS NULL AND (
      (classification='candidate' AND sender_was_account_email=1 AND (cancellation_request_id IS NULL OR NOT EXISTS (SELECT 1 FROM withdrawal_notice_mail m WHERE m.notice_id=withdrawal_notices.id AND m.kind='ask:'||classification_rev)))
      OR (classification='candidate' AND correction_due=1 AND verification_sent_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM withdrawal_notice_mail m WHERE m.notice_id=withdrawal_notices.id AND m.kind='ask:'||classification_rev))
      OR (candidate_obligation=1 AND classification IN ('support','unclear','cancellation') AND sender_was_account_email=1 AND cancellation_request_id IS NULL)
      OR (candidate_obligation=1 AND classification IN ('support','unclear','cancellation') AND ask_rev IS NOT NULL AND ask_rev<>classification_rev
        AND NOT (correction_due=1 AND verification_sent_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM withdrawal_notice_mail m WHERE m.notice_id=withdrawal_notices.id AND m.kind='ask:'||classification_rev))
      OR (classification IN ('cancellation','support','unclear') AND correction_due=1 AND verification_sent_at IS NOT NULL)) LIMIT 100`, [], (id) => afterChange(env, d, id));
  // r1-9: the ask links expired unanswered: queue the later confirmation once per notice (the mail key is the idempotency).
  await each(`SELECT n.id FROM withdrawal_notices n WHERE n.state='open' AND n.clarified_action IS NULL AND n.cancellation_request_id IS NOT NULL AND n.candidate_obligation=1
      AND EXISTS (SELECT 1 FROM verify_tokens v WHERE v.subject_kind='notice' AND v.subject_id=n.id AND v.purpose='clarify')
      AND NOT EXISTS (SELECT 1 FROM verify_tokens v WHERE v.subject_kind='notice' AND v.subject_id=n.id AND v.purpose='clarify' AND v.used_at IS NULL AND v.expires_at>?)
      AND NOT EXISTS (SELECT 1 FROM withdrawal_notice_mail m WHERE m.mail_key='expiry:'||n.id) LIMIT 100`, [clockOf(d)], async (id) => {
    await enqueue(env, d, id, "expiry", `expiry:${id}`);
    await flushMail(env, d, id);
  });
  // r1-5: a corrected end date the cancellation does not carry yet (a crash or a busy lease cut it short).
  await each(`SELECT n.id FROM withdrawal_notices n JOIN cancellation_requests c ON c.id=n.cancellation_request_id WHERE n.requested_date IS NOT NULL
      AND c.requested_date IS NOT n.requested_date AND c.status IN ('open','held') AND c.superseded_by IS NULL LIMIT 100`, [], async (id) => {
    const n = await load(env, id);
    if (n) await followDate(env, d, n, n.cancellation_request_id);
  });
  // r1-8: a withdrawal that ended the plan while its cancellation is still live (a crash, a busy lease).
  await each(`SELECT n.id FROM withdrawal_notices n JOIN cancellation_requests c ON c.id=n.cancellation_request_id JOIN refund_ops o ON o.id=n.refund_op_id
      WHERE n.state IN ('executing','completed') AND o.canceled_at IS NOT NULL AND c.superseded_by IS NULL AND c.status IN ('open','reason_pending','held','kept') LIMIT 100`, [], (id) => afterPlanEnded(env, d, id));
  await each("SELECT id FROM withdrawal_notices WHERE clarified_action='cancel_at_end' AND cancellation_request_id IS NULL LIMIT 100", [], async (id) => {
    const n = await load(env, id);
    if (n) { await ensureCancellation(env, d, n); await flushMail(env, d, id); }
  });
}

/** r1-8: the notice's withdrawal ended the plan: its cancellation and hold link are retired (the hold could otherwise still promise "the plan
 *  continues" after the plan was cancelled and refunded). Also from the sweep. */
async function afterPlanEnded(env: Env, d: NoticeDeps, id: string): Promise<void> {
  const n = await load(env, id);
  if (n?.cancellation_request_id && (n.state === "executing" || n.state === "completed")) await retireNoticeCancellation(env, d, n.cancellation_request_id, `withdrawal:${n.id}`);
}

// --- wiring --------------------------------------------------------------------------------------------------------------------------------

/** Registers WP10 with the notice module (mail, follow-ups, sweep) and the public route shell (`clarify`, and the lookup details of a clarify link).
 *  WRAPS what WP8 and WP9 registered: other subjects go on to them. Call it AFTER registerWithdrawalNotices. */
export function registerClarify(): void {
  registerNoticeExtension({ renderMail, afterChange, sweep, stillValid, afterPlanEnded });
  const before = { ...currentPublicHandlers() };
  registerPublicHandlers({
    clarify: async (env, result, call) => (result.row.subjectKind === "notice" ? clarifyNotice(env, result, call) : before.clarify ? before.clarify(env, result, call) : null),
    describe: async (env, row) => {
      const base = before.describe ? await before.describe(env, row) : {};
      if (row.subjectKind !== "notice" || row.purpose !== "clarify") return base;
      const n = await load(env, row.subjectId);
      const cx = n ? await cxView(env, n) : null;
      const eff = cx?.state === "scheduled" ? cx.effectiveAt : null;
      return { ...base, ...(eff !== null ? { effectiveAt: eff } : {}) };
    },
  });
}
