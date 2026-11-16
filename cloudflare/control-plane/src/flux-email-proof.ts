// SPDX-License-Identifier: AGPL-3.0-or-later
// FLUX-ENSURE-EMAIL-VERIFIED (design-ev3 r3 with the round 3 changes; reviews grok-ev3.md, astra-ev3.md, grok-runbook.md).
//
// THREAT: a buyer gets linked to someone else's EXISTING Flux Router account (and its credits) by typing or holding that email.
// Flux's ensure-account answers 202 {status: "pending_verification"} when an existing Flux account matches the owner's address and the control
// plane did not say the address is proven (flux-grants.ts FluxEmailUnverified). The owner's homes are then HELD (email_unverified: first key,
// B5 grant ask) until the owner proves the inbox with the code mailed here.
//
// THE ONE PROOF: a flux_email_proof challenge, mailed to the STORED contact_email (supabase_identities.contact_email, never a token's or Supabase's
// address), bound to the account, the Supabase sub, the user id, the exact lower-cased address and the address revision. The ONLY statement that
// writes supabase_identities.email_verified_at is in verifyProof below, in ONE D1 batch, each step conditioned on the one before (the step-up
// pattern of the step-up code verifier in step-up-email.ts):
//   1. spend the guess (at most 5 per issuance);
//   2. consume THIS challenge (id, hash of the submitted code, unconsumed, unexpired, address and revision still the identity's), changes()=1;
//   3. stamp the identity (sub, user id, address, revision, not already stamped for it, no open dispute), changes()=1;
//   4. queue the wake-up, changes()=1 (only on the unproven -> proven transition).
// Never from a JWT claim (the session methods, app_metadata, user_metadata), CloudAccount.emailVerified, OAuth, an admin create, or any operator route. Support
// has no stamp: it can resend the code to the stored address, and dispute a proof (which clears it and blocks stamp and wake).
// It never reads or writes the step-up tables and never calls the step-up send or verify; its limits are the step-up code's, copied. One
// exception, outside verifyProof: a "stamped" verify asks customer-identity.ts grantDoorFromEmailProof to record the door's grant (one code).
// The only clear of a stamp besides a dispute is the address move (cloud-accounts.ts reconcileEmail).
import { z } from "zod";
import { fluxServing } from "./b4-flux-config";
import { senderOrFail, type TransactionalEmailSender } from "./email";
import { ensureFluxAccount, ensureOwnerAccount } from "./flux-grants";
import { LINK_RESOLVES_SQL } from "./flux-link";
import { DB_NOW } from "./billing-lease";
import { errorResponse, HTTPError, json, readBoundedJSON } from "./http";
import { grantDoorFromEmailProof, type Identity } from "./customer-identity";

// Copied from step-up-email.ts (asserted equal in test/flux-email-proof.test.ts), not imported: this module never loads the step-up code.
export const PROOF_CODE_DIGITS = 6;
export const PROOF_CODE_TTL_MS = 600_000;
export const PROOF_MAX_GUESSES = 5;
export const PROOF_SENDS_PER_DAY = 5;
export const PROOF_SEND_GAP_MS = 30_000;
const DAY_MS = 24 * 60 * 60_000;
/** Its own HMAC purpose: a step-up code (murage.stepup-email.v1) can never be replayed here, nor this one there. */
export const PROOF_PURPOSE = "murage.flux-email-proof.v1";
/** The wake-up is tried at most this often by the sweep, at most this many times; then flux.email_wake_exhausted pages (once per revision). */
export const WAKE_MAX_TRIES = 5;
const WAKE_RETRY_GAP_MS = 60_000;
export const HELD_GRANT_ERROR = "grant_held:email_unverified";

export const STATE_PATH = "/v1/account/flux/email-proof";
export const SEND_PATH = "/v1/account/flux/email-proof/send";
export const VERIFY_PATH = "/v1/account/flux/email-proof/verify";
/** Support's routes (admin credential, b4-flux.ts fluxRoute). There is NO stamp route. */
export const OPERATOR_ROUTE = /^\/v1\/internal\/flux\/email-proof\/(resend|dispute|dispute-clear)$/;

export interface FluxProofDependencies {
  emailSender?: (env: Env) => TransactionalEmailSender;
  /** The fetch ensure-account goes through on a wake-up. Default: the global fetch. */
  fluxFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  /** Tests only: runs between the read of the identity and the consume batch (a resend racing the verify). */
  beforeConsume?: () => Promise<void>;
  /** Tests only: false leaves the queued wake-up to the sweep (an interrupted request). */
  inlineWake?: boolean;
  /** Tests only: runs between the auto-send's marker claim and the issuance (an address move in between, M-e). */
  beforeAutoSendIssue?: () => Promise<void>;
  /** Tests only: runs just before the dispute batch (a link committing in between, M-b). */
  beforeDisputeBatch?: () => Promise<void>;
  /** Tests only: runs between dispute-clear's read of the dispute and its batch (a new dispute landing in between). */
  beforeClearBatch?: () => Promise<void>;
  /** ITEM 9 M5: the code mail gives up after this long (default PROOF_SEND_TIMEOUT_MS), so a stalled mailer never holds a request or a sweep. */
  sendTimeoutMs?: number;
}

/** ITEM 9 M5: the longest a request or a sweep waits on a code mail. ITEM 9 r2 H1: past it the delivery is UNKNOWN (the send is not
 *  cancelled and the provider may still deliver it), so the code is kept live, never replaced by an automatic send. */
export const PROOF_SEND_TIMEOUT_MS = 10_000;
class MailTimeout extends Error { constructor() { super("mail_timeout"); } }
async function withinMs<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A late rejection of the abandoned send is swallowed here (nothing waits on it any more).
  work.catch(() => undefined);
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MailTimeout()), ms); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}
export function proofDigits(): string {
  const limit = 4_294_967_296 - (4_294_967_296 % 1_000_000);
  const word = new Uint32Array(1);
  do crypto.getRandomValues(word); while (word[0] >= limit);
  return String(word[0] % 1_000_000).padStart(PROOF_CODE_DIGITS, "0");
}
/** HMAC of the canonically encoded tuple (a JSON array of strings). */
export const proofHash = (secret: string, t: { accountId: string; sub: string; userId: string; address: string; revision: number; id: string; code: string }) =>
  hmacHex(secret, JSON.stringify([PROOF_PURPOSE, t.accountId, t.sub, t.userId, t.address, String(t.revision), t.id, t.code]));

interface IdentityRow { sub: string; user_id: string; contact_email: string | null; email_revision: number; email_conflict: string | null;
  email_verified_at: number | null; email_verified_for: string | null }
const identityOf = (env: Env, accountId: string) => env.DB.prepare(`SELECT sub,user_id,contact_email,email_revision,email_conflict,email_verified_at,email_verified_for
  FROM supabase_identities WHERE user_id=?`).bind(accountId).first<IdentityRow>();
const addressOf = (r: IdentityRow) => r.contact_email?.trim().toLowerCase() ?? "";
const provenFor = (r: IdentityRow) => r.email_verified_at !== null && r.email_verified_for !== null && r.email_verified_for === addressOf(r);
export const disputed = async (env: Env, accountId: string) =>
  Boolean(await env.DB.prepare("SELECT 1 AS x FROM flux_email_proof_disputes WHERE account_id=?").bind(accountId).first());

/** True while at least one live home of the account is held email_unverified: a first-key hold row, a B5 claim held for it, or the account's
 *  hold deadline (flux_email_hold, any path's 202) for its current address revision. */
export async function accountHeld(env: Env, accountId: string): Promise<boolean> {
  return Boolean(await env.DB.prepare(`SELECT 1 AS x FROM cloud_homes h WHERE h.owner_id=?1 AND h.desired_state<>'deleted' AND (
      EXISTS (SELECT 1 FROM flux_first_key_retry r WHERE r.home_id=h.id AND r.hold='email_unverified')
      OR EXISTS (SELECT 1 FROM credit_grants c WHERE c.home_id=h.id AND c.granted_at IS NULL AND c.suppressed_at IS NULL AND c.last_error=?2)
      OR EXISTS (SELECT 1 FROM flux_email_hold f JOIN supabase_identities s ON s.user_id=f.account_id WHERE f.account_id=?1 AND f.email_revision=s.email_revision)) LIMIT 1`)
    .bind(accountId, HELD_GRANT_ERROR).first());
}

/** Contract (c), launch flow A: Flux creates or links ONLY on email_verified:true, so EVERY new buyer proves the address before the first home
 *  links, not only the ones Flux answered 202 for. True while Flux is serving and a live home of the account is being provisioned: its
 *  subscription exists and has not ended. */
export async function accountProvisioning(env: Env, accountId: string, opts: { ignoreServing?: boolean } = {}): Promise<boolean> {
  if (!opts.ignoreServing && !fluxServing(env)) return false;
  return Boolean(await env.DB.prepare(`SELECT 1 AS x FROM cloud_homes h WHERE h.owner_id=? AND ${PAYING_HOME_SQL("h")} LIMIT 1`).bind(accountId).first());
}
/** ITEM 9 M3: a live home (not deleted) with a subscription that has not ended: the paying customer the 24 h page is about. */
const PAYING_HOME_SQL = (h: string) => `${h}.desired_state<>'deleted' AND EXISTS (SELECT 1 FROM billing_subscriptions b WHERE b.home_id=${h}.id
      AND b.subscription_id IS NOT NULL AND b.status NOT IN ('canceled','disputed','incomplete_expired'))`;
/** Already linked to a Flux account (a link made before contract (c), or after the proof): nothing left to prove for the link. */
const linkedAccount = async (env: Env, accountId: string) =>
  Boolean(await env.DB.prepare("SELECT 1 AS x FROM flux_links WHERE owner_user_id=?").bind(accountId).first());

/** THE GATE, one evaluator for the page's code box, its "Open Murage" button and POST /v1/homes/:id/door (so they never disagree): blocked
 *  while the owner's stored address is not proven, the account is not linked yet, and a live home of it is held email_unverified or being
 *  provisioned. An open dispute keeps it blocked (the card is then hidden: support decides). */
export async function proofGate(env: Env, accountId: string, opts: { ignoreServing?: boolean } = {})
  : Promise<{ blocked: boolean; disputed: boolean; identity: IdentityRow | null }> {
  const id = await identityOf(env, accountId);
  const open = { blocked: false, disputed: false, identity: id };
  if (!id || !addressOf(id) || provenFor(id) || await linkedAccount(env, accountId)) return open;
  if (!(await accountHeld(env, accountId)) && !(await accountProvisioning(env, accountId, opts))) return open;
  return { blocked: true, disputed: await disputed(env, accountId), identity: id };
}

/** What the Cloud page shows. `blocked`: the gate above ("Open Murage" stays disabled). `needed`: the code box, while blocked and no dispute is
 *  open. M5 (astra-code1): with it, the account's CURRENT live challenge (unconsumed, unexpired, for the stored address and revision), whoever
 *  asked for it (the auto-send, the page or a support resend), so the newest emailed code can always be entered; null when none is live (the
 *  code ran out: the page offers "Send a new code"). The id is no secret: only the code proves the inbox. Reading it never sends anything. */
export async function proofState(env: Env, accountId: string, now = Date.now()): Promise<{ needed: boolean; blocked: boolean; challengeId: string | null }> {
  const gate = await proofGate(env, accountId);
  const id = gate.identity;
  if (!gate.blocked || !id) return { needed: false, blocked: false, challengeId: null };
  if (gate.disputed) return { needed: false, blocked: true, challengeId: null };
  const live = await env.DB.prepare(`SELECT id FROM flux_email_proof WHERE account_id=? AND consumed_at IS NULL AND expires_at>? AND guesses<? AND address=?
    AND email_revision=?`).bind(accountId, now, PROOF_MAX_GUESSES, addressOf(id), id.email_revision).first<{ id: string }>();
  return { needed: true, blocked: true, challengeId: live?.id ?? null };
}

function rateLimited(retryAfterMs: number): Response {
  const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const res = errorResponse(429, "rate_limited", { retryAfter, retry_after_seconds: retryAfter });
  res.headers.set("retry-after", String(retryAfter));
  return res;
}

const SUBJECT = "Murage Cloud: your code to confirm your email";
/** The code mail. It says it came from Murage Cloud, and that nothing happens if it is ignored. Contract (c): it goes to every new buyer, so it
 *  never says a Flux Router account already uses the address. */
export function proofMailText(code: string): string {
  return `${SUBJECT}\n\nThis email is from Murage Cloud.\n\n`
    + "One more code: it switches on your Flux credit.\n\n"
    + "Type this code in the \"Confirm your email\" box on your My Cloud page. It is not the code for opening Murage.\n\n"
    + `Your code is: ${code}\n\nIt works once, for 10 minutes. Nobody from Murage will ever ask you for this code.\n\n`
    + "If you did not ask for this, you can ignore this email. Nothing happens if you ignore it: no account is connected and nothing changes.";
}

/** `delivery` "unknown": the mailer did not answer within the send timeout; the code stays live (it may well arrive). `live` (only with
 *  keepLive): a live code already exists for the stored address and revision, so nothing was issued or sent. */
export type IssueResult = { kind: "sent"; challengeId: string; expiresAt: number; revision: number; sentAt: number; delivery: "sent" | "unknown" }
  | { kind: "limited"; retryAfterMs: number } | { kind: "live" };

/** Issues a fresh challenge to the STORED contact_email at the current revision (the auto-send at checkout, the page's "Send a new code" and
 *  support's resend). The address is never an input. Refused unless a home is held, the address is unproven and no dispute is open;
 *  `provisioning` (ONLY the auto-send and the page's own resend) also allows it while the account, not linked yet, has a home being provisioned
 *  (accountProvisioning). The quota is the same for all of them. A resend replaces the account's previous challenge (new id, new hash: the old
 *  code stops working). ITEM 9 r2 H1: `keepLive` (every AUTOMATIC send: the checkout's queued send and the sweep) never replaces a live code:
 *  decided inside the reservation INSERT, so it holds against any racing send. Only the buyer's "Send a new code" and support's resend
 *  replace a live code, under the same quota. */
export async function issueChallenge(env: Env, accountId: string, deps: FluxProofDependencies = {},
  opts: { provisioning?: boolean; revision?: number; keepLive?: boolean } = {}): Promise<IssueResult> {
  const now = (deps.now ?? Date.now)();
  const id = await identityOf(env, accountId);
  const address = id ? addressOf(id) : "";
  if (!id || !address) throw new HTTPError(404, "not_found");
  // M-e: the auto-send names the revision it claimed its marker for. The address moved since: nothing is reserved and nothing is sent.
  if (opts.revision !== undefined && id.email_revision !== opts.revision) throw new HTTPError(409, "email_changed");
  if (id.email_conflict !== null) throw new HTTPError(409, "account_email_conflict");
  if (await disputed(env, accountId)) throw new HTTPError(409, "proof_disputed");
  if (provenFor(id)) throw new HTTPError(409, "already_verified");
  if (!(await accountHeld(env, accountId))
    && !(opts.provisioning === true && !(await linkedAccount(env, accountId)) && await accountProvisioning(env, accountId))) throw new HTTPError(409, "not_needed");
  const challengeId = `fp_${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
  const code = proofDigits();
  const hash = await proofHash(env.BETTER_AUTH_SECRET, { accountId, sub: id.sub, userId: id.user_id, address, revision: id.email_revision, id: challengeId, code });
  // ONE transaction: the reservation (fewer than five in 24 h, none in the last 30 s, decided inside the INSERT; with opts.revision, only while
  // the identity is still at that revision, M-e), then the challenge, written only when the reservation took (changes()=1).
  const fence = opts.revision === undefined ? "" : " AND EXISTS (SELECT 1 FROM supabase_identities WHERE user_id=? AND email_revision=?)";
  const liveSql = `SELECT 1 FROM flux_email_proof WHERE account_id=? AND consumed_at IS NULL AND expires_at>? AND guesses<? AND address=? AND email_revision=?`;
  const liveBinds = [accountId, now, PROOF_MAX_GUESSES, address, id.email_revision];
  const keep = opts.keepLive === true ? ` AND NOT EXISTS (${liveSql})` : "";
  const [reserved] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO flux_email_proof_events (id,account_id,kind,at) SELECT ?,?,'code_reserved',?
      WHERE (SELECT COUNT(*) FROM flux_email_proof_events WHERE account_id=? AND kind='code_reserved' AND at>?) < ?
        AND NOT EXISTS (SELECT 1 FROM flux_email_proof_events WHERE account_id=? AND kind='code_reserved' AND at>?)${fence}${keep}`)
      .bind(crypto.randomUUID(), accountId, now, accountId, now - DAY_MS, PROOF_SENDS_PER_DAY, accountId, now - PROOF_SEND_GAP_MS,
        ...(opts.revision === undefined ? [] : [accountId, opts.revision]), ...(opts.keepLive === true ? liveBinds : [])),
    env.DB.prepare(`INSERT INTO flux_email_proof (id,account_id,sub,user_id,address,email_revision,code_hash,expires_at,guesses,sends,consumed_at,created_at)
        SELECT ?,?,?,?,?,?,?,?,0,1,NULL,? WHERE changes()=1
      ON CONFLICT(account_id) DO UPDATE SET id=excluded.id,sub=excluded.sub,user_id=excluded.user_id,address=excluded.address,
        email_revision=excluded.email_revision,code_hash=excluded.code_hash,expires_at=excluded.expires_at,guesses=0,sends=sends+1,consumed_at=NULL,
        created_at=excluded.created_at`)
      .bind(challengeId, accountId, id.sub, id.user_id, address, id.email_revision, hash, now + PROOF_CODE_TTL_MS, now),
  ]);
  if (reserved.meta.changes !== 1) {
    if (opts.revision !== undefined && (await identityOf(env, accountId))?.email_revision !== opts.revision) throw new HTTPError(409, "email_changed");
    if (opts.keepLive === true && await env.DB.prepare(liveSql).bind(...liveBinds).first()) return { kind: "live" };
    const recent = (await env.DB.prepare("SELECT at FROM flux_email_proof_events WHERE account_id=? AND kind='code_reserved' AND at>? ORDER BY at DESC LIMIT ?")
      .bind(accountId, now - DAY_MS, PROOF_SENDS_PER_DAY).all<{ at: number }>()).results;
    const cooldown = recent[0] ? recent[0].at + PROOF_SEND_GAP_MS - now : 0;
    const quota = recent.length >= PROOF_SENDS_PER_DAY ? recent[PROOF_SENDS_PER_DAY - 1].at + DAY_MS - now : 0;
    return { kind: "limited", retryAfterMs: Math.max(cooldown, quota) };
  }
  const text = proofMailText(code);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  try {
    const sender = deps.emailSender?.(env) ?? senderOrFail(env);
    await withinMs(sender.send({ to: id.contact_email!.trim(), from: { email: env.EMAIL_FROM, name: "Murage Cloud" }, subject: SUBJECT, text,
      html: `<!doctype html><html><body>${text.split("\n\n").map((p) => `<p>${esc(p)}</p>`).join("")}</body></html>` }), deps.sendTimeoutMs ?? PROOF_SEND_TIMEOUT_MS);
  } catch (e) {
    if (e instanceof MailTimeout) {
      // ITEM 9 r2 H1: delivery UNKNOWN. The send was not cancelled and may still arrive, so THIS challenge stays live: deleting it would kill
      // a code the buyer may be reading. No automatic send replaces it (keepLive); the buyer's "Send a new code" can, under the quota.
      console.error(JSON.stringify({ message: "flux email proof mail timed out: delivery unknown, the code stays live" }));
      return { kind: "sent", challengeId, expiresAt: now + PROOF_CODE_TTL_MS, revision: id.email_revision, sentAt: now, delivery: "unknown" };
    }
    // The reservation stays spent. Only THIS issuance's challenge is removed. Nothing about the message or the address is logged.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM flux_email_proof WHERE id=? AND account_id=?").bind(challengeId, accountId),
      env.DB.prepare("INSERT INTO flux_email_proof_events (id,account_id,kind,at) VALUES (?,?,'send_failed',?)").bind(crypto.randomUUID(), accountId, now),
    ]);
    console.error(JSON.stringify({ message: "flux email proof mail failed" }));
    throw new HTTPError(503, "email_unavailable");
  }
  return { kind: "sent", challengeId, expiresAt: now + PROOF_CODE_TTL_MS, revision: id.email_revision, sentAt: now, delivery: "sent" };
}

export type VerifyResult = "stamped" | "already_verified" | "refused" | "disputed" | "not_recorded";

/** THE ONLY WRITER of email_verified_at (see the file header). `session` is the signed-in Cloud member of the request: its mapped account and
 *  Supabase sub. Returns what happened; only "stamped" queued a wake-up (run inline unless deps.inlineWake is false; the sweep is the backstop). */
export async function verifyProof(env: Env, session: { accountId: string; sub: string }, input: { challengeId: string; code: string },
  deps: FluxProofDependencies = {}): Promise<VerifyResult> {
  const now = (deps.now ?? Date.now)();
  const { accountId, sub } = session;
  const id = await env.DB.prepare("SELECT sub,user_id,contact_email,email_revision FROM supabase_identities WHERE user_id=? AND sub=?").bind(accountId, sub)
    .first<{ sub: string; user_id: string; contact_email: string | null; email_revision: number }>();
  const address = id?.contact_email?.trim().toLowerCase() ?? "";
  if (!id || !address) return "refused";
  if (await disputed(env, accountId)) return "disputed";
  const expected = await proofHash(env.BETTER_AUTH_SECRET, { accountId, sub, userId: id.user_id, address, revision: id.email_revision, id: input.challengeId, code: input.code });
  if (deps.beforeConsume) await deps.beforeConsume();
  const [, consumed, stamped, woke] = await env.DB.batch([
    // 1. The guess is spent first: at most five per issuance, however many requests race.
    env.DB.prepare(`UPDATE flux_email_proof SET guesses=guesses+1 WHERE id=? AND account_id=? AND consumed_at IS NULL AND expires_at>? AND guesses<?`)
      .bind(input.challengeId, accountId, now, PROOF_MAX_GUESSES),
    // 2. The exact challenge is consumed, only when step 1 spent a guess on it (changes()=1): the hash of THIS code, unconsumed, unexpired, and its
    //    address and revision still the identity's. guesses<=5 here, after the spend in step 1, is "guesses<5 before this guess".
    env.DB.prepare(`UPDATE flux_email_proof SET consumed_at=? WHERE id=? AND account_id=? AND sub=? AND code_hash=? AND consumed_at IS NULL AND expires_at>?
        AND guesses<=? AND address=? AND email_revision=? AND changes()=1`)
      .bind(now, input.challengeId, accountId, sub, expected, now, PROOF_MAX_GUESSES, address, id.email_revision),
    // 3. The stamp, only when step 2 consumed (changes()=1): the identity still at this sub, user, address and revision, not already stamped for
    //    this address (a replay never refreshes the proof time), and no open dispute.
    env.DB.prepare(`UPDATE supabase_identities SET email_verified_at=?, email_verified_for=? WHERE sub=? AND user_id=? AND lower(trim(contact_email))=?
        AND email_revision=? AND (email_verified_at IS NULL OR email_verified_for IS NULL OR email_verified_for<>?)
        AND NOT EXISTS (SELECT 1 FROM flux_email_proof_disputes WHERE account_id=?) AND changes()=1`)
      .bind(now, address, sub, accountId, address, id.email_revision, address, accountId),
    // 4. The wake-up, only on the unproven -> proven transition (step 3 changed a row).
    env.DB.prepare("INSERT OR IGNORE INTO flux_email_wake (account_id,email_revision,created_at,tries) SELECT ?,?,?,0 WHERE changes()=1")
      .bind(accountId, id.email_revision, now),
    // 5. r2.1 fix 3: the 24 h page (sweepFluxEmailStuck) resolves here, AFTER the wake INSERT (whose changes() it never touches), keyed on the
    //    stamped identity at this address and revision, not on changes(): proving before 24 h (no alert yet) still queued the wake above.
    env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=? WHERE kind='credit.email_unverified_hold' AND subject=? AND resolved_at IS NULL
        AND EXISTS (SELECT 1 FROM supabase_identities WHERE user_id=? AND email_revision=? AND lower(trim(contact_email))=? AND email_verified_at IS NOT NULL
          AND email_verified_for=?)`)
      .bind(now, `account:${accountId}`, accountId, id.email_revision, address, address),
  ]);
  if (consumed.meta.changes !== 1) {
    await env.DB.prepare("INSERT INTO flux_email_proof_events (id,account_id,kind,at) VALUES (?,?,'code_refused',?)").bind(crypto.randomUUID(), accountId, now).run()
      .catch(() => undefined);
    return "refused";
  }
  if (stamped.meta.changes !== 1) {
    const after = await identityOf(env, accountId);
    if (after && provenFor(after) && after.email_revision === id.email_revision) return "already_verified";
    return (await disputed(env, accountId)) ? "disputed" : "not_recorded";
  }
  await env.DB.prepare("INSERT INTO flux_email_proof_events (id,account_id,kind,at) VALUES (?,?,'verified',?)").bind(crypto.randomUUID(), accountId, now).run();
  console.log(JSON.stringify({ message: "flux email proof recorded" }));
  if (woke.meta.changes === 1 && deps.inlineWake !== false) {
    // The wake row was inserted just now with tries 0 (step 4): that is this attempt's expected value.
    try { await runWake(env, accountId, id.email_revision, deps, 0); } catch { /* the sweep runs it again */ }
  }
  return "stamped";
}

/** One counted wake try (astra-code3 / grok-code3 Medium): the tries bump and, on the try that reaches WAKE_MAX_TRIES, the ONE
 *  flux.email_wake_exhausted page (a new alert row, stable id, resolved when the account links) are written in the SAME batch, for the
 *  outcome path (runWake) and the exception path (the sweep's catch) alike. A try at the cap can never leave the row out of the sweep with
 *  no page. `stamp` also records last_try_at (the sweep's claim already set it). ITEM4-FIX2 section 4: `expected` is the tries value the caller
 *  read for this attempt; the bump is fenced on it, so a replayed call with the same value moves nothing (and the page stays single). */
async function countWakeTry(env: Env, accountId: string, revision: number, now: number, stamp: boolean, expected: number): Promise<void> {
  const homeOf = "COALESCE((SELECT h.id FROM cloud_homes h WHERE h.owner_id=?2 AND h.desired_state<>'deleted' ORDER BY h.created_at LIMIT 1),'billing')";
  await env.DB.batch([
    env.DB.prepare(`UPDATE flux_email_wake SET tries=tries+1,last_try_at=CASE WHEN ?3 THEN ?4 ELSE last_try_at END WHERE account_id=?1 AND email_revision=?2 AND tries=?5`)
      .bind(accountId, revision, stamp ? 1 : 0, now, expected),
    env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject)
        SELECT ?1,${homeOf},'flux.email_wake_exhausted','high',?3,?4,?5
        WHERE EXISTS (SELECT 1 FROM flux_email_wake WHERE account_id=?2 AND email_revision=?6 AND tries>=?7)
          AND NOT EXISTS (SELECT 1 FROM flux_links WHERE owner_user_id=?2) ON CONFLICT DO NOTHING`)
      .bind(`alert:email_wake_exhausted:${accountId}:${revision}`, accountId, JSON.stringify({ accountId, revision,
        rule: "The email is proven, but the wake-up could not link the Flux account in 5 tries. See the runbook." }), now, `account:${accountId}`,
        revision, WAKE_MAX_TRIES),
  ]);
}

/** The wake-up after a proof (design-ev3 section 5): idempotent, for EVERY live home of the account. It ensures the Flux account ONCE (through
 *  the account's hold deadline: it carries the proof Flux waits for), and ONLY when that returned "linked" (M3) does it delete the account's hold
 *  deadline and the email_unverified hold rows of the first-key bound (real-failure rows, hold NULL, keep their backoff), make the account's
 *  unbound B4 grants due again, lift the B5 claims held for it, drop the wake row and resolve credit.email_unverified_hold. Anything else
 *  (Flux off, no live home, unavailable, another 202, stale) leaves the hold, the wake and the alert in place (M1, M3): a real try
 *  (unavailable, 202) is counted (at most WAKE_MAX_TRIES, then the hold alert is delivered again); the rest are only rescheduled by the sweep.
 *  Never while a dispute is open. A stale row (the address moved) is dropped. `expectedTries` is the tries value the caller read for this
 *  attempt (the sweep's SELECT, or 0 for the inline wake the verify just queued); a direct call without it reads it once here. */
export async function runWake(env: Env, accountId: string, revision: number, deps: FluxProofDependencies = {}, expectedTries?: number): Promise<"done" | "retry" | "blocked"> {
  const now = (deps.now ?? Date.now)();
  const expected = expectedTries ?? (await env.DB.prepare("SELECT tries FROM flux_email_wake WHERE account_id=? AND email_revision=?").bind(accountId, revision)
    .first<{ tries: number }>())?.tries ?? 0;
  if (await disputed(env, accountId)) return "blocked";
  const dropRow = env.DB.prepare("DELETE FROM flux_email_wake WHERE account_id=? AND email_revision=?").bind(accountId, revision);
  const id = await identityOf(env, accountId);
  if (!id || id.email_revision !== revision || !provenFor(id)) { await dropRow.run(); return "done"; }
  const homes = "SELECT id FROM cloud_homes WHERE owner_id=? AND desired_state<>'deleted'";
  const first = await env.DB.prepare(`${homes} ORDER BY created_at LIMIT 1`).bind(accountId).first<{ id: string }>();
  // M3 (grok-code1 Low): Flux off or no live home is NOT linked: the wake and the alert stay (rescheduled, no try counted).
  if (!first || !fluxServing(env)) return "retry";
  const doFetch = deps.fluxFetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const outcome = await ensureOwnerAccount(env, accountId, first.id, (a) => ensureFluxAccount(env, doFetch, a), now, { wake: true });
  if (outcome !== "linked") {
    // TERMINAL (design-pc2): Flux answered 202 to a TRUE call (flux.ensure_verified_refused is open, the 15 min hold written), or the id is
    // linked at Flux under another email (M-d, r2.1 fix 5: flux.link_email_mismatch_unlinked is open). The wake row is dropped: no more tries,
    // no repeat pages, and neither counts toward flux.email_wake_exhausted. The normal callers keep to the hold.
    if (outcome === "verified_refused" || outcome === "link_email_mismatch") { await dropRow.run(); return "done"; }
    if (outcome === "unavailable" || outcome === "email_unverified" || outcome === "refused") {
      await countWakeTry(env, accountId, revision, now, true, expected);
    }
    return "retry";
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM flux_email_hold WHERE account_id=?").bind(accountId),
    env.DB.prepare(`DELETE FROM flux_first_key_retry WHERE hold='email_unverified' AND home_id IN (${homes})`).bind(accountId),
    env.DB.prepare(`UPDATE flux_grants SET last_attempt_at=NULL WHERE status='pending' AND recipient_flux_account_id IS NULL AND home_id IN (${homes})`).bind(accountId),
    env.DB.prepare(`UPDATE credit_grants SET last_error=NULL WHERE last_error=? AND granted_at IS NULL AND home_id IN (${homes})`).bind(HELD_GRANT_ERROR, accountId),
    dropRow,
    env.DB.prepare("UPDATE cloud_alerts SET resolved_at=? WHERE kind='credit.email_unverified_hold' AND subject=? AND resolved_at IS NULL")
      .bind(now, `account:${accountId}`),
    env.DB.prepare(LINK_RESOLVES_SQL).bind(accountId, now),
  ]);
  return "done";
}

/** The 24 h page (design-pc2 alert lifecycle, r2.1 fix 1): a buyer whose home went active (the auto-send marker exists for the CURRENT
 *  revision) and who is still unproven 24 h after the marker's first_at, not linked, no dispute open, with a paying home. ONE alert row per
 *  account and revision (stable id); an open one is never raised twice (the NOT EXISTS sits before the LIMIT, so already-paged accounts never
 *  take the slots); one resolved because the customer ended reopens when a paying home returns (ITEM 9 r2 H3). At most 50 per tick. Resolved by the proof consume (verifyProof step 5) and by an address move (cloud-accounts.ts). */
export const STUCK_AFTER_MS = 24 * 60 * 60_000;
export const STUCK_PER_TICK = 50;
export async function sweepFluxEmailStuck(env: Env, deps: FluxProofDependencies = {}): Promise<number> {
  const now = (deps.now ?? Date.now)();
  // ITEM 9 M3: an open page of a customer who ended (no live home with a subscription that has not ended) is resolved. ITEM 9 r2 H3: a
  // paying home that returns at the same address revision, still unproven past 24 h, REOPENS that same row (fresh raised_at, delivered
  // again). Only a page resolved HERE (marked resolvedBy 'ended') reopens; one resolved any other way (the proof, the link, an address move,
  // by hand) is never raised again for that revision. ITEM 9 r3: such a row (its page of this exact id exists and cannot reopen) is excluded
  // BEFORE the LIMIT, so old non-reopenable rows never take the slots of newer buyers.
  await env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=?, detail=json_set(COALESCE(detail,'{}'),'$.resolvedBy','ended')
    WHERE kind='credit.email_unverified_hold' AND resolved_at IS NULL AND subject LIKE 'account:%'
    AND NOT EXISTS (SELECT 1 FROM cloud_homes h WHERE h.owner_id=substr(cloud_alerts.subject,9) AND ${PAYING_HOME_SQL("h")})`).bind(now).run();
  const r = await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject)
    SELECT 'alert:email_unverified_hold:'||m.account_id||':'||m.email_revision,
      COALESCE((SELECT h.id FROM cloud_homes h WHERE h.owner_id=m.account_id ORDER BY h.created_at LIMIT 1),'billing'),
      'credit.email_unverified_hold','high',
      json_object('accountId',m.account_id,'revision',m.email_revision,'rule','A paying customer has not confirmed the emailed code 24 hours after the home went active. No key is minted and no credit sent until they do.'),
      ?1,'account:'||m.account_id
    FROM flux_email_proof_autosend m JOIN supabase_identities s ON s.user_id=m.account_id AND s.email_revision=m.email_revision
    WHERE m.first_at<=?2
      AND NOT COALESCE(s.email_verified_at IS NOT NULL AND s.email_verified_for=lower(trim(s.contact_email)),0)
      AND NOT EXISTS (SELECT 1 FROM flux_links l WHERE l.owner_user_id=m.account_id)
      AND NOT EXISTS (SELECT 1 FROM flux_email_proof_disputes d WHERE d.account_id=m.account_id)
      AND EXISTS (SELECT 1 FROM cloud_homes h WHERE h.owner_id=m.account_id AND ${PAYING_HOME_SQL("h")})
      AND NOT EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.kind='credit.email_unverified_hold' AND a.subject='account:'||m.account_id AND a.resolved_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM cloud_alerts x WHERE x.id='alert:email_unverified_hold:'||m.account_id||':'||m.email_revision
        AND (x.resolved_at IS NULL OR COALESCE(json_extract(x.detail,'$.resolvedBy'),'')<>'ended'))
    ORDER BY m.first_at LIMIT ${STUCK_PER_TICK}
    ON CONFLICT(id) DO UPDATE SET resolved_at=NULL, raised_at=excluded.raised_at, detail=excluded.detail, delivered_at=NULL, delivery_attempts=0,
      delivery_claim_until=NULL WHERE cloud_alerts.resolved_at IS NOT NULL AND json_extract(cloud_alerts.detail,'$.resolvedBy')='ended'
    ON CONFLICT DO NOTHING`).bind(now, now - STUCK_AFTER_MS).run();
  return r.meta.changes ?? 0;
}

/** Cron: every wake-up left behind (an interrupted request), least recently tried first, bounded. M2 (astra-code1): rows of an account with an
 *  open dispute are not selected, and each row is CLAIMED durably (last_try_at = now, conditional on the read) BEFORE any work, so a row that
 *  is blocked, throws or is rescheduled is not due again for WAKE_RETRY_GAP_MS and blocked rows can never starve the rest. */
export async function sweepFluxEmailWake(env: Env, deps: FluxProofDependencies = {}, limit = 20): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const due = now - WAKE_RETRY_GAP_MS;
  const rows = (await env.DB.prepare(`SELECT account_id,email_revision,last_try_at,tries FROM flux_email_wake w WHERE tries<? AND (last_try_at IS NULL OR last_try_at<=?)
      AND NOT EXISTS (SELECT 1 FROM flux_email_proof_disputes d WHERE d.account_id=w.account_id)
    ORDER BY COALESCE(last_try_at,0), created_at LIMIT ?`).bind(WAKE_MAX_TRIES, due, limit)
    .all<{ account_id: string; email_revision: number; last_try_at: number | null; tries: number }>()).results;
  let done = 0;
  for (const r of rows) {
    const claim = await env.DB.prepare(`UPDATE flux_email_wake SET last_try_at=? WHERE account_id=? AND email_revision=? AND last_try_at IS ?`)
      .bind(now, r.account_id, r.email_revision, r.last_try_at).run();
    if ((claim.meta.changes ?? 0) !== 1) continue; // another sweep took it
    // ITEM4-FIX2 section 4: ONE expected tries value per attempt, the one this SELECT read, for the outcome path and the catch alike.
    const expected = r.tries;
    try { if ((await runWake(env, r.account_id, r.email_revision, deps, expected)) === "done") done++; }
    catch {
      // Already claimed (not due again for the gap); an exception is a counted try.
      await countWakeTry(env, r.account_id, r.email_revision, now, false, expected).catch(() => undefined);
    }
  }
  return done;
}

// ---- launch flow A: the code mailed once at checkout ---------------------------------------------------------------------------------------

/** A failed auto-send is tried again by the sweep no sooner than this (past the 30 s send gap); a "sending" row older than the stale gap was
 *  interrupted and counts as failed. */
const AUTOSEND_RETRY_GAP_MS = 60_000;
const AUTOSEND_STALE_MS = 10 * 60_000;
/** "unknown": the code was issued and stays live, but the mailer did not answer in time (ITEM 9 r2 H1); the marker reads 'sent' (no retry). */
export type AutoSendResult = "sent" | "unknown" | "skipped" | "failed";

async function attemptAutoSend(env: Env, accountId: string, revision: number, deps: FluxProofDependencies, now: number): Promise<AutoSendResult> {
  let sent = false;
  let unknown = false;
  try {
    // ITEM 9 r2 H1: an automatic send never replaces a live code (keepLive): the buyer's own code, or one whose delivery is unknown.
    const r = await issueChallenge(env, accountId, deps, { provisioning: true, revision, keepLive: true });
    if (r.kind === "live") {
      await env.DB.prepare("UPDATE flux_email_proof_autosend SET state='skipped',at=? WHERE account_id=? AND email_revision=?").bind(now, accountId, revision).run();
      return "skipped";
    }
    sent = r.kind === "sent";
    unknown = r.kind === "sent" && r.delivery === "unknown";
  } catch (e) {
    if (e instanceof HTTPError && e.code === "email_changed") {
      // M-e: the address moved after the marker was claimed. Nothing was sent; the marker for the old revision is released.
      await env.DB.prepare("DELETE FROM flux_email_proof_autosend WHERE account_id=? AND email_revision=? AND state='sending'").bind(accountId, revision).run();
      return "skipped";
    }
    sent = false;
  }
  await env.DB.prepare("UPDATE flux_email_proof_autosend SET state=?,at=? WHERE account_id=? AND email_revision=?")
    .bind(sent ? "sent" : "failed", now, accountId, revision).run();
  if (!sent) console.error(JSON.stringify({ message: "flux email proof auto-send failed" }));
  return sent ? (unknown ? "unknown" : "sent") : "failed";
}

/** Launch flow A, step 1, the part that runs under the billing lease (ITEM 9 M5, PROOF-MAIL-AFTER-CHECKPOINT): when a checkout completes, the
 *  ONE auto-send for this account and address revision is ENQUEUED (marker state 'queued'), never mailed here. The mail goes after the
 *  checkpoint (sendQueuedProof through waitUntil) and the sweep sends any queued row the request did not. Queued while the gate is blocked,
 *  OR (ITEM 9 M1) while it would be blocked but for Flux not serving (a credential outage at checkout): the obligation survives the outage
 *  and the code goes once Flux is ready. Nothing when no dispute or conflict allows it, or a marker already exists (a second webhook
 *  delivery, or two racing). first_at, the 24 h page's clock (sweepFluxEmailStuck), is set once here and never moved. Returns the queued
 *  revision, or null. NEVER throws. */
export async function queueAutoSendProof(env: Env, accountId: string, deps: FluxProofDependencies = {}): Promise<number | null> {
  try {
    const m = await autoSendMarkStatement(env, accountId, deps);
    if (!m) return null;
    const mark = await env.DB.prepare(m.stmt[0]).bind(...m.stmt[1]).run();
    return (mark.meta.changes ?? 0) === 1 ? m.revision : null;
  } catch {
    console.error(JSON.stringify({ message: "flux email proof auto-send could not be queued" }));
    return null;
  }
}

/** ITEM 9 r2 H2: the 'queued' marker write for the checkout, as a statement (sql, binds) the caller puts in the SAME fenced batch as the
 *  event's checkpoint (b5-billing.ts processStoredEvent), so the marker commits with the checkpoint or not at all. Null when nothing is owed
 *  (the gate, evaluated ignoring Flux serving, is open, or a dispute or conflict is open). Throws on a read failure (the caller guards). */
export async function autoSendMarkStatement(env: Env, accountId: string, deps: FluxProofDependencies = {})
  : Promise<{ revision: number; stmt: [string, unknown[]] } | null> {
  const now = (deps.now ?? Date.now)();
  const gate = await proofGate(env, accountId, { ignoreServing: true });
  const id = gate.identity;
  if (!gate.blocked || gate.disputed || !id || id.email_conflict !== null) return null;
  return { revision: id.email_revision, stmt: [`INSERT INTO flux_email_proof_autosend (account_id,email_revision,state,tries,at,first_at) VALUES (?1,?2,'queued',1,?3,?3)
      ON CONFLICT(account_id,email_revision) DO NOTHING`, [accountId, id.email_revision, now]] };
}

/** ITEM 9 r2 H2, the second guard: a queued marker is claimed only while no billing lease is held on any of the account's homes (the
 *  checkout's checkpoint and the marker commit together, so this only matters for a marker some other path wrote under a lease). */
const NO_LEASE_HELD_SQL = `NOT EXISTS (SELECT 1 FROM billing_home_leases l JOIN cloud_homes h ON h.id=l.home_id WHERE h.owner_id=? AND l.holder IS NOT NULL
    AND l.lease_until>=${DB_NOW})`;

/** Sends the queued auto-send of (account, revision) at most once: the claim (queued -> sending, conditional) is the only way in, so the
 *  request's waitUntil and any number of sweeps send one mail. Not claimed while a billing lease of the account is held (it stays queued). Not claimed while the gate is open only because Flux is not serving (M1: it
 *  stays queued, moved to the back of the sweep's line); skipped for good when the gate opened for any other reason (proven, linked, ended),
 *  a dispute or conflict is open, or the address moved. NEVER throws. */
export async function sendQueuedProof(env: Env, accountId: string, revision: number, deps: FluxProofDependencies = {}): Promise<AutoSendResult> {
  const now = (deps.now ?? Date.now)();
  try {
    const gate = await proofGate(env, accountId);
    const id = gate.identity;
    const usable = !gate.disputed && !!id && id.email_conflict === null && id.email_revision === revision;
    if (!gate.blocked || !usable) {
      const owed = usable && !fluxServing(env) && (await proofGate(env, accountId, { ignoreServing: true })).blocked;
      await env.DB.prepare(`UPDATE flux_email_proof_autosend SET ${owed ? "" : "state='skipped',"}at=? WHERE account_id=? AND email_revision=? AND state='queued'`)
        .bind(now, accountId, revision).run();
      return "skipped";
    }
    const claim = await env.DB.prepare(`UPDATE flux_email_proof_autosend SET state='sending',at=? WHERE account_id=? AND email_revision=? AND state='queued'
      AND ${NO_LEASE_HELD_SQL}`).bind(now, accountId, revision, accountId).run();
    if ((claim.meta.changes ?? 0) !== 1) return "skipped"; // another sender took it
    if (deps.beforeAutoSendIssue) await deps.beforeAutoSendIssue();
    return await attemptAutoSend(env, accountId, revision, deps, now);
  } catch {
    console.error(JSON.stringify({ message: "flux email proof auto-send failed" }));
    return "failed";
  }
}

/** After the checkpoint (the webhook's lease is released, the event recorded): sends whatever auto-send is queued for the account. */
export async function sendQueuedProofs(env: Env, accountId: string, deps: FluxProofDependencies = {}): Promise<void> {
  try {
    const rows = (await env.DB.prepare("SELECT email_revision AS rev FROM flux_email_proof_autosend WHERE account_id=? AND state='queued'").bind(accountId)
      .all<{ rev: number }>()).results;
    for (const r of rows) await sendQueuedProof(env, accountId, r.rev, deps);
  } catch { console.error(JSON.stringify({ message: "flux email proof auto-send failed" })); }
}

/** Queue, then send at once (direct callers and tests; the checkout itself queues under its lease and sends after the checkpoint). */
export async function autoSendProof(env: Env, accountId: string, deps: FluxProofDependencies = {}): Promise<AutoSendResult> {
  const revision = await queueAutoSendProof(env, accountId, deps);
  if (revision === null) return "skipped";
  return sendQueuedProof(env, accountId, revision, deps);
}

/** Cron: (1) every queued auto-send (the request's own send did not happen, or Flux was not serving), least recently looked at first; then
 *  (2) the ONE retry of a failed (or interrupted) auto-send, claimed by its tries (1 -> 2, conditional) before any work. The retry is skipped,
 *  never sent, when the gate opened, a dispute or conflict is open, the address moved to another revision, or a code is already live (the buyer
 *  pressed "Send a new code": theirs is never replaced). */
export async function sweepFluxEmailAutoSend(env: Env, deps: FluxProofDependencies = {}, limit = 20): Promise<number> {
  const now = (deps.now ?? Date.now)();
  let sent = 0;
  const queued = (await env.DB.prepare("SELECT account_id,email_revision FROM flux_email_proof_autosend WHERE state='queued' ORDER BY at LIMIT ?")
    .bind(limit).all<{ account_id: string; email_revision: number }>()).results;
  for (const r of queued) if ((await sendQueuedProof(env, r.account_id, r.email_revision, deps)) === "sent") sent++;
  const rows = (await env.DB.prepare(`SELECT account_id,email_revision FROM flux_email_proof_autosend WHERE tries=1
      AND ((state='failed' AND at<=?) OR (state='sending' AND at<=?)) ORDER BY at LIMIT ?`)
    .bind(now - AUTOSEND_RETRY_GAP_MS, now - AUTOSEND_STALE_MS, limit).all<{ account_id: string; email_revision: number }>()).results;
  for (const r of rows) {
    const claim = await env.DB.prepare(`UPDATE flux_email_proof_autosend SET tries=2,state='sending',at=? WHERE account_id=? AND email_revision=? AND tries=1
      AND state IN ('failed','sending') AND ${NO_LEASE_HELD_SQL}`).bind(now, r.account_id, r.email_revision, r.account_id).run();
    if ((claim.meta.changes ?? 0) !== 1) continue; // another sweep took it
    const skip = () => env.DB.prepare("UPDATE flux_email_proof_autosend SET state='skipped',at=? WHERE account_id=? AND email_revision=?")
      .bind(now, r.account_id, r.email_revision).run();
    try {
      const gate = await proofGate(env, r.account_id);
      const id = gate.identity;
      const live = id && await env.DB.prepare(`SELECT 1 AS x FROM flux_email_proof WHERE account_id=? AND consumed_at IS NULL AND expires_at>? AND guesses<?
        AND email_revision=?`).bind(r.account_id, now, PROOF_MAX_GUESSES, id.email_revision).first();
      if (!gate.blocked || gate.disputed || !id || id.email_conflict !== null || id.email_revision !== r.email_revision || live) { await skip(); continue; }
      if ((await attemptAutoSend(env, r.account_id, r.email_revision, deps, now)) === "sent") sent++;
    } catch {
      await env.DB.prepare("UPDATE flux_email_proof_autosend SET state='failed',at=? WHERE account_id=? AND email_revision=?")
        .bind(now, r.account_id, r.email_revision).run().catch(() => undefined);
    }
  }
  return sent;
}

// ---- routes -------------------------------------------------------------------------------------------------------------------------------

const verifySchema = z.strictObject({ challengeId: z.string().regex(/^fp_[0-9a-f]{32}$/), code: z.string().regex(/^[0-9]{6}$/) });
async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  return parsed.data;
}

/** The Cloud page's card (signed-in owner, Cloud scope): GET the state, POST send (to the stored address), POST verify. Sign-in only: the code
 *  itself is the second step. Null for any other path. */
export async function fluxEmailProofRoute(request: Request, env: Env, identity: Identity, deps: FluxProofDependencies = {}): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== STATE_PATH && path !== SEND_PATH && path !== VERIFY_PATH) return null;
  if (request.method !== (path === STATE_PATH ? "GET" : "POST")) throw new HTTPError(405, "method_not_allowed");
  const s = await identity.customer(request);
  if (!s || s.unresolved || !s.user.id) throw new HTTPError(401, "unauthorized");
  const accountId = s.user.id;
  if (path === STATE_PATH) return json(await proofState(env, accountId, (deps.now ?? Date.now)()));
  if (path === SEND_PATH) {
    await body(request, z.strictObject({}));
    // The page's own "Send a new code" (a click, never a page load): allowed while a home is being provisioned too; the same quota.
    // ITEM 9 r2 H1: this click may replace a live code (one whose mail never arrived), under the quota.
    const r = await issueChallenge(env, accountId, deps, { provisioning: true });
    if (r.kind === "limited") return rateLimited(r.retryAfterMs);
    if (r.kind === "live") throw new HTTPError(409, "code_live"); // not reachable: no keepLive here
    const now = (deps.now ?? Date.now)();
    return json({ sent: true, challengeId: r.challengeId, digits: PROOF_CODE_DIGITS, expiresIn: Math.max(0, Math.ceil((r.expiresAt - now) / 1000)),
      resendIn: Math.ceil(PROOF_SEND_GAP_MS / 1000) }, 202);
  }
  const input = await body(request, verifySchema);
  const result = await verifyProof(env, { accountId, sub: s.supabase.sub }, input, deps);
  // One code (MurageMain 11-04): the code just typed and stamped here is also the door's second step, for THIS session only. Never on
  // already_verified (no new stamp), a dispute, an address move or a refusal. A failure to record it only means the door asks once.
  if (result === "stamped") await grantDoorFromEmailProof(env, s, input.challengeId).catch(() => false);
  if (result === "stamped" || result === "already_verified") return json({ verified: true });
  if (result === "disputed") throw new HTTPError(409, "proof_disputed");
  if (result === "not_recorded") throw new HTTPError(409, "email_changed");
  throw new HTTPError(403, "code_refused");
}

const ACCOUNT_ID = z.string().trim().min(1).max(128);
const OPERATOR = z.string().trim().min(1).max(200);
/** Support's resend: account and operator only. An address in the body is refused (strict schema): the code always goes to the stored address. */
const resendSchema = z.strictObject({ account_id: ACCOUNT_ID, by: OPERATOR });
const disputeSchema = z.strictObject({ account_id: ACCOUNT_ID, note: z.string().trim().min(3).max(2000), by: OPERATOR });
// `version`: the dispute version support read (flux_account_dispute.version); the clear lifts only that dispute. Left out, the version read at the clear.
const clearSchema = z.strictObject({ account_id: ACCOUNT_ID, by: OPERATOR, version: z.number().int().min(1).optional() });

const audit = (env: Env, a: { accountId: string; act: string; operator: string; revision: number | null; note?: string | null; sentAt?: number | null; at: number }) =>
  env.DB.prepare(`INSERT INTO flux_email_proof_audit (id,account_id,act,operator,email_revision,note,sent_at,message_id,at) VALUES (?,?,?,?,?,?,?,NULL,?)`)
    .bind(crypto.randomUUID(), a.accountId, a.act, a.operator, a.revision, a.note ?? null, a.sentAt ?? null, a.at);

/** Support's routes, after the caller checked the admin credential (b4-flux.ts adminOnly). NONE of them can set email_verified_at: resend
 *  issues a normal challenge to the stored address; dispute clears a proof and blocks stamp and wake (or, on a linked account, only pages);
 *  dispute-clear lifts the block. */
export async function fluxEmailProofOperatorRoute(request: Request, env: Env, act: string, deps: FluxProofDependencies = {}): Promise<Response> {
  if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
  const now = (deps.now ?? Date.now)();
  if (act === "resend") {
    const b = await body(request, resendSchema);
    const r = await issueChallenge(env, b.account_id, deps);
    if (r.kind === "limited") return rateLimited(r.retryAfterMs);
    if (r.kind === "live") throw new HTTPError(409, "code_live"); // not reachable: support's resend replaces a live code (no keepLive)
    // The mailer returns no message id, so none is recorded.
    await audit(env, { accountId: b.account_id, act: "resend", operator: b.by, revision: r.revision, sentAt: r.sentAt, at: now }).run();
    return json({ sent: true, revision: r.revision, sentAt: r.sentAt, expiresAt: r.expiresAt, delivery: r.delivery }, 202);
  }
  if (act === "dispute") {
    const b = await body(request, disputeSchema);
    const id = await identityOf(env, b.account_id);
    if (!id) throw new HTTPError(404, "not_found");
    if (deps.beforeDisputeBatch) await deps.beforeDisputeBatch();
    // M-b: ONE batch, both branches conditional on the link row inside each statement, so exactly one of "link" or "dispute opened" wins.
    const unlinked = "NOT EXISTS (SELECT 1 FROM flux_links WHERE owner_user_id=?)";
    const linkedSql = "EXISTS (SELECT 1 FROM flux_links WHERE owner_user_id=?)";
    const auditSql = (act: string, cond: string) => env.DB.prepare(`INSERT INTO flux_email_proof_audit (id,account_id,act,operator,email_revision,note,sent_at,message_id,at)
      SELECT ?,?,'${act}',?,?,?,NULL,NULL,? WHERE ${cond}`).bind(crypto.randomUUID(), b.account_id, b.by, id.email_revision, b.note, now, b.account_id);
    await env.DB.batch([
      // DISPUTE-FENCE-ACCOUNT: the account-level dispute, for a linked and an unlinked account alike (no unlink, no accounting change). Its version
      // rises on every dispute, a repeat included, so a clear that read an older one lifts nothing. The key rows of the account's homes are held
      // in the same batch; rows made later inherit the hold (b4-flux.ts ensureHomeRow) and the commit points read the table itself.
      env.DB.prepare(`INSERT INTO flux_account_dispute (account_id,version,open,note,by,at) VALUES (?,1,1,?,?,?)
        ON CONFLICT(account_id) DO UPDATE SET version=version+1,open=1,note=excluded.note,by=excluded.by,at=excluded.at`).bind(b.account_id, b.note, b.by, now),
      env.DB.prepare("UPDATE flux_home_keys SET proof_hold=1 WHERE home_id IN (SELECT id FROM cloud_homes WHERE owner_id=?)").bind(b.account_id),
      // Unlinked: the proof is cleared and the dispute opened (a repeat updates it), and the live code stops working too.
      env.DB.prepare(`UPDATE supabase_identities SET email_verified_at=NULL,email_verified_for=NULL WHERE user_id=? AND ${unlinked}`).bind(b.account_id, b.account_id),
      env.DB.prepare(`INSERT INTO flux_email_proof_disputes (account_id,note,by,email_revision,at) SELECT ?,?,?,?,? WHERE ${unlinked}
        ON CONFLICT(account_id) DO UPDATE SET note=excluded.note,by=excluded.by,email_revision=excluded.email_revision,at=excluded.at`)
        .bind(b.account_id, b.note, b.by, id.email_revision, now, b.account_id),
      env.DB.prepare(`UPDATE flux_email_proof SET expires_at=0 WHERE account_id=? AND consumed_at IS NULL AND ${unlinked}`).bind(b.account_id, b.account_id),
      auditSql("dispute", unlinked),
      // CLOUD-DISPUTE-UNLINKED-DIGEST (MurageMain 11-03): an unlinked dispute raises one DIGEST item (never a page), so a stuck buyer is seen.
      // One row per account: a repeat while it is open adds nothing and keeps raised_at; dispute-clear resolves it, and a dispute after
      // the clear reopens the same row with a fresh raised_at (the id is fixed per account, so the open index on subject never meets a twin).
      env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject)
          SELECT ?,COALESCE((SELECT id FROM cloud_homes WHERE owner_id=? ORDER BY created_at LIMIT 1),'billing'),'credit.email_proof_disputed_unlinked','info',?,?,? WHERE ${unlinked}
        ON CONFLICT(id) DO UPDATE SET resolved_at=NULL, raised_at=excluded.raised_at, detail=excluded.detail WHERE cloud_alerts.resolved_at IS NOT NULL`).bind(`alert:email_proof_disputed_unlinked:${b.account_id}`, b.account_id,
        JSON.stringify({ accountId: b.account_id, by: b.by, owner: "MurageCloud", rule: "The email proof of an account that is not linked to Flux yet is disputed. The proof is cleared and the account is blocked until the dispute is cleared. Owner: MurageCloud. Someone follows up with the buyer within a day." }),
        now, `account:${b.account_id}`, b.account_id),
      // Linked: never unlinked here (Sean decides). One paging alert per account.
      env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject)
          SELECT ?,COALESCE((SELECT id FROM cloud_homes WHERE owner_id=? ORDER BY created_at LIMIT 1),'billing'),'credit.email_proof_disputed','high',?,?,? WHERE ${linkedSql}
        ON CONFLICT(id) DO UPDATE SET resolved_at=NULL, raised_at=excluded.raised_at, detail=excluded.detail, delivered_at=NULL, delivery_attempts=0,
          delivery_claim_until=NULL, resolve_notice_due=NULL, resolve_claim_until=NULL, resolve_attempts=0, ageout_notice=NULL
          WHERE cloud_alerts.resolved_at IS NOT NULL`).bind(`alert:email_proof_disputed:${b.account_id}`, b.account_id,
        JSON.stringify({ accountId: b.account_id, by: b.by, rule: "The email proof of an account that is already linked to a Flux account is disputed. The link is left as it is: Sean decides." }),
        now, `account:${b.account_id}`, b.account_id),
      auditSql("dispute_linked", linkedSql),
    ]);
    // [r2, Grok] The branch reported is read from the link row AFTER the batch, never from changes(): a repeat dispute reports the same branch.
    const link = await env.DB.prepare("SELECT 1 AS x FROM flux_links WHERE owner_user_id=?").bind(b.account_id).first();
    if (link) return json({ linked: true, alerted: true, unlinked: false });
    return json({ linked: false, disputed: true });
  }
  const b = await body(request, clearSchema);
  // ONE consistent snapshot (Astra M4): the proof dispute and the account-level dispute are read in ONE batch, so a dispute that changes between
  // two separate reads can never give the clear a version that does not belong to the proof row it read. The clear lifts exactly this snapshot.
  const [seenRead, fenceRead] = await env.DB.batch([
    env.DB.prepare("SELECT note,by,email_revision AS rev,at FROM flux_email_proof_disputes WHERE account_id=?").bind(b.account_id),
    env.DB.prepare("SELECT version FROM flux_account_dispute WHERE account_id=? AND open=1").bind(b.account_id),
  ]);
  const seen = (seenRead!.results[0] ?? null) as { note: string; by: string; rev: number; at: number } | null;
  const fence = (fenceRead!.results[0] ?? null) as { version: number } | null;
  if (!seen && !fence) return json({ cleared: false, reason: "no_dispute" });
  const id = await identityOf(env, b.account_id);
  if (deps.beforeClearBatch) await deps.beforeClearBatch();
  // The snapshot as one condition: the proof dispute is still exactly the row read (or still absent), and the account-level dispute is still open
  // AT THE VERSION support read (b.version, else the one read just now; the version only rises, so a stale clear never lifts a newer dispute,
  // even across a clear and a re-open). Evaluated ONCE, by the audit row (the first statement): every other statement lifts only if that audit
  // row exists, so the clear is all or nothing and an entry is written only for a clear that succeeded (Astra L6).
  const legacy = seen
    ? { sql: "EXISTS (SELECT 1 FROM flux_email_proof_disputes WHERE account_id=?1 AND note=?2 AND by=?3 AND email_revision=?4 AND at=?5)", binds: [seen.note, seen.by, seen.rev, seen.at] }
    : { sql: "NOT EXISTS (SELECT 1 FROM flux_email_proof_disputes WHERE account_id=?1) AND ?2 IS NULL AND ?3 IS NULL AND ?4 IS NULL AND ?5 IS NULL", binds: [null, null, null, null] };
  const wantVersion = b.version ?? fence?.version ?? null;
  const account = wantVersion === null
    ? "NOT EXISTS (SELECT 1 FROM flux_account_dispute WHERE account_id=?1 AND open=1) AND ?6 IS NULL"
    : "EXISTS (SELECT 1 FROM flux_account_dispute WHERE account_id=?1 AND open=1 AND version=?6)";
  const auditId = crypto.randomUUID();
  const mine = "EXISTS (SELECT 1 FROM flux_email_proof_audit WHERE id=?7)";
  // No dispute left for the account: the holds and the alerts lift only then, so a dispute landing in between keeps them.
  const none = "NOT EXISTS (SELECT 1 FROM flux_email_proof_disputes WHERE account_id=?1) AND NOT EXISTS (SELECT 1 FROM flux_account_dispute WHERE account_id=?1 AND open=1)";
  const homes = "SELECT id FROM cloud_homes WHERE owner_id=?1";
  const [audited, , , , , , , leftUnlinked, leftFence] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO flux_email_proof_audit (id,account_id,act,operator,email_revision,note,sent_at,message_id,at)
      SELECT ?7,?1,'dispute_clear',?8,?9,NULL,NULL,NULL,?10 WHERE (${legacy.sql}) AND (${account})`)
      .bind(b.account_id, ...legacy.binds, wantVersion, auditId, b.by, id?.email_revision ?? null, now),
    env.DB.prepare(`DELETE FROM flux_email_proof_disputes WHERE account_id=?1 AND ${mine}`).bind(b.account_id, null, null, null, null, null, auditId),
    env.DB.prepare(`UPDATE flux_account_dispute SET open=0,version=version+1,by=?8,at=?10 WHERE account_id=?1 AND open=1 AND ${mine}`)
      .bind(b.account_id, null, null, null, null, null, auditId, b.by, null, now),
    env.DB.prepare(`UPDATE flux_home_keys SET proof_hold=0 WHERE proof_hold=1 AND home_id IN (${homes}) AND ${mine} AND ${none}`)
      .bind(b.account_id, null, null, null, null, null, auditId),
    // The typed 15-minute wait of a first key or renewal the dispute refused (Opus Low 3): a cleared buyer is not made to wait it out. LINKED
    // accounts only: for an unlinked one the same row is the email-unverified hold itself (accountHeld), which the clear must not drop.
    env.DB.prepare(`DELETE FROM flux_first_key_retry WHERE hold='email_unverified' AND home_id IN (${homes}) AND EXISTS (SELECT 1 FROM flux_links WHERE owner_user_id=?1) AND ${mine} AND ${none}`)
      .bind(b.account_id, null, null, null, null, null, auditId),
    env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=?10 WHERE id=?11 AND resolved_at IS NULL AND ${mine} AND ${none}`)
      .bind(b.account_id, null, null, null, null, null, auditId, null, null, now, `alert:email_proof_disputed_unlinked:${b.account_id}`),
    env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=?10 WHERE id=?11 AND resolved_at IS NULL AND ${mine} AND ${none}`)
      .bind(b.account_id, null, null, null, null, null, auditId, null, null, now, `alert:email_proof_disputed:${b.account_id}`),
    env.DB.prepare("SELECT 1 AS x FROM flux_email_proof_disputes WHERE account_id=?").bind(b.account_id),
    env.DB.prepare("SELECT 1 AS x FROM flux_account_dispute WHERE account_id=? AND open=1").bind(b.account_id),
  ]);
  if ((audited!.meta.changes ?? 0) === 1) return json({ cleared: true });
  if ((leftUnlinked!.results ?? []).length > 0 || (leftFence!.results ?? []).length > 0) {
    return json({ cleared: false, reason: "newer_dispute", message: "A newer dispute arrived. Read it, then decide again." });
  }
  return json({ cleared: false, reason: "no_dispute" });
}
