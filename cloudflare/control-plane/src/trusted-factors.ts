// SPDX-License-Identifier: AGPL-3.0-or-later
// Trusted second factors for Murage Cloud accounts (Astra SUPPORT5 P1 #2; CONTRACT.md section 3a).
//
// The attack: someone holding a stolen aal2 session enrols their own TOTP factor directly through Supabase's MFA API
// (Supabase checks only the session's AAL before enrolment), verifies it, waits out any notice period, then uses it
// for fresh step-up. "aal2 plus a fresh amr timestamp" cannot tell that factor from the member's.
//
// So the control plane keeps a TRUSTED-FACTOR list per Cloud account, and fresh step-up (money routes, the desktop
// pairing code, every route behind the step-up gate) counts only when the factor that verified the session is on it.
// Which factor verified the session comes from the members area's Custom Access Token Hook: it copies
// auth.sessions.factor_id into the server-set top-level claim `mfa_factor_id` (supabase/custom-access-token-hook-
// oauth-guard.sql). Supabase Auth sets sessions.factor_id only in updateMFASessionAndClaims, to the factor just
// verified (TOTP, phone, WebAuthn, recovery code), in the same transaction that runs the hook; refresh never changes it;
// unenrolling a factor clears it (supabase/auth ce9a8ee: internal/api/token.go L303-L384, internal/api/mfa.go
// L726/L867/L987, internal/api/recovery_codes.go L430, internal/models/sessions.go L349-L381, internal/tokens/service.go
// L671-L745 with hookspgfunc.go L73-L110). So the claim names the LAST factor verified, and that factor's amr method
// timestamp is that verification's time.
//
// Becoming trusted:
//   - No usable trusted factor yet (the first factor, or every trusted factor was removed from Supabase): a single-use
//     8-digit code emailed by the control plane to the account's CURRENT Supabase address (asked of Supabase Auth with
//     the member's token at that moment), then a 24-hour hold before the factor counts. Removing factors never resets
//     this: an account with no usable trusted factor always takes this path.
//   - A usable trusted factor exists: a proof FROM a trusted factor (this session's mfa_factor_id trusted and out of
//     hold, its method verified within the last 5 minutes). No email path then.
//   Every change emails the member at that Supabase address; if the notice cannot be sent, nothing changes. A trust row is
//   staged (grants nothing) until that notice is delivered and Supabase is re-read; only then is it activated.
//   A trusted factor counts only while it is still a verified factor in Supabase's current list.
//
// The first-factor hold waiver (TRUST-FIRST-FACTOR.md revision 2, part B; Astra TRUST-1 #5/#6, TRUST-2 Q1/Q2/F1/F6):
//   The emailed code is ALWAYS required (part A was withdrawn). After it is verified, the 24-hour hold is waived only when the
//   account has NOTHING TO PROTECT: no billing_subscriptions row of any status (via its home), no cloud_homes row in any state,
//   no machine_owners assignment, and no trust history of any state (any cloud_trusted_factors row other than this operation's own
//   staged one, or any trusted_* event). Never hasUsableTrusted, which ignores history. A companion (Better Auth) account is a
//   separate account and is not consulted.
//   One waiver per account, ever: the code request reserves cloud_factor_bootstraps (one row per account; a live reservation of
//   another factor or session is left alone, so a concurrent second first-factor request is held). The verify consumes it in the
//   same batch that spends the code and stages the row, bound to that factor, that session_id and that op (changes()=1). The
//   decision is made again INSIDE the activation UPDATE (usable_at = CASE WHEN <nothing to protect> AND <this op consumed the
//   bootstrap> THEN now ELSE now + 24 h END), never in a separate SELECT (F1). An unconsumed reservation past its expiry (the
//   code's TTL) may be reclaimed by a new request; the same session and factor may resend; a consumed row is never reused (F6).
import { HTTPError, json, readBoundedJSON } from "./http";
import { senderOrFail, type TransactionalEmailSender } from "./email";
import { CLOCK_SKEW_SECONDS, UUID_RE, type StepUpRequirement, type SupabaseAuthConfig, type SupabaseClaims } from "./supabase-jwt";
import { z } from "zod";

export const TRUST_HOLD_MS = 24 * 60 * 60_000;
/** A trusted factor approving another must have been verified this recently. */
export const TRUST_PROOF_MAX_AGE_SECONDS = 300;
const CODE_TTL_MS = 10 * 60_000;
const CODE_MAX_ATTEMPTS = 5;
const CODES_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60_000;
/** A staged trust row older than this (its request crashed or is stuck sending) is replaced by the next attempt. */
const STAGE_STALE_MS = 2 * 60_000;
/** A staged row's usable_at: never, until activation sets the real one. */
const NEVER = Number.MAX_SAFE_INTEGER;
/** Supabase factor_type -> the amr method its verification writes (models.TOTPSignIn "totp", MFAWebAuthn "mfa/webauthn"). */
const METHOD_OF: Readonly<Record<string, string>> = { totp: "totp", webauthn: "mfa/webauthn" };
const ELIGIBLE = new Set(Object.keys(METHOD_OF));

/** "Nothing to protect" (see the header): ownership and trust HISTORY of the Cloud account, as one SQL predicate, so it can sit
 *  inside the statement that acts on it. `own` is the one row excluded: this operation's staged (user_id,factor_id,op) row (F1). */
function nothingToProtect(userId: string, own: { factorId: string; op: string } | null): { sql: string; binds: string[] } {
  return {
    sql: `NOT EXISTS (SELECT 1 FROM cloud_homes WHERE owner_id=?)
      AND NOT EXISTS (SELECT 1 FROM billing_subscriptions bs JOIN cloud_homes bh ON bh.id=bs.home_id WHERE bh.owner_id=?)
      AND NOT EXISTS (SELECT 1 FROM machine_owners WHERE owner_user_id=?)
      AND NOT EXISTS (SELECT 1 FROM cloud_trusted_factors pt WHERE pt.user_id=? AND NOT (pt.state='staged' AND pt.factor_id=? AND pt.op IS ?))
      AND NOT EXISTS (SELECT 1 FROM cloud_factor_trust_events pe WHERE pe.user_id=? AND pe.kind IN ('trusted_email_code','trusted_by_factor'))`,
    binds: [userId, userId, userId, userId, own?.factorId ?? "", own?.op ?? "", userId],
  };
}

interface TrustedRow { factor_id: string; factor_type: string; via: string; trusted_at: number; usable_at: number; state: string; op: string | null }
/** One factor in Supabase's CURRENT list for the member. */
export interface CurrentFactor { id: string; type: string; status: string }

const trustedRows = async (db: D1Database, userId: string) =>
  (await db.prepare("SELECT factor_id,factor_type,via,trusted_at,usable_at,state,op FROM cloud_trusted_factors WHERE user_id=?").bind(userId).all<TrustedRow>()).results;

/** null when this session's last MFA verification came from a trusted factor of this account (an ACTIVE row, out of its
 *  hold) that is STILL a verified factor in Supabase's current list, within maxAgeSeconds; otherwise what the members area
 *  must do (the 403 step_up body). `currentFactors` is asked last, only once every local check has passed: a saved token
 *  keeps its mfa_factor_id after the factor is removed (Astra MAKERKIT8 #2), so the claim alone never authorizes. */
export async function trustedStepUpRequirement(db: D1Database, userId: string, claims: SupabaseClaims, config: SupabaseAuthConfig,
  nowMs: number, maxAgeSeconds: number, currentFactors: () => Promise<readonly CurrentFactor[]>): Promise<StepUpRequirement | null> {
  return (await trustedStepUp(db, userId, claims, config, nowMs, maxAgeSeconds, currentFactors)).need;
}

/** The gate's decision (trustedStepUpRequirement) and, only when it accepts, the proof it accepted: that factor's own method's
 *  timestamp (ms). One function, so nothing reads a proof time the gate would not accept (Astra DOORMINT-3: a factor in its hold,
 *  removed from Supabase, or no longer active never supplies one). */
async function trustedStepUp(db: D1Database, userId: string, claims: SupabaseClaims, config: SupabaseAuthConfig, nowMs: number,
  maxAgeSeconds: number, currentFactors: () => Promise<readonly CurrentFactor[]>): Promise<{ need: StepUpRequirement | null; proofAt: number | null }> {
  const refuse = (need: StepUpRequirement) => ({ need, proofAt: null });
  const now = Math.floor(nowMs / 1000);
  const base = { methods: [...config.stepUpMethods], max_age_seconds: maxAgeSeconds };
  const accepted = claims.amr.filter((e) => config.stepUpMethods.has(e.method) && e.timestamp <= now + CLOCK_SKEW_SECONDS);
  const newest = accepted.reduce<number | null>((m, e) => (m === null || e.timestamp > m ? e.timestamp : m), null);
  if (claims.aal !== "aal2") return refuse({ reason: "aal1", ...base, verified_at: newest });
  const row = claims.mfaFactorId
    ? await db.prepare("SELECT factor_id,factor_type,via,trusted_at,usable_at,state,op FROM cloud_trusted_factors WHERE user_id=? AND factor_id=? AND state='active'")
      .bind(userId, claims.mfaFactorId).first<TrustedRow>()
    : null;
  if (!row) return refuse({ reason: "untrusted_factor", ...base, verified_at: newest });
  const method = METHOD_OF[row.factor_type];
  const proof = method && config.stepUpMethods.has(method)
    ? accepted.find((e) => e.method === method) ?? null
    : null;
  if (!proof || now - proof.timestamp > maxAgeSeconds) return refuse({ reason: "stale", ...base, verified_at: proof?.timestamp ?? newest });
  if (row.usable_at > nowMs) return refuse({ reason: "untrusted_factor", ...base, verified_at: proof.timestamp, pending_until: Math.ceil(row.usable_at / 1000) });
  const live = (await currentFactors()).find((f) => f.id === row.factor_id);
  if (!live || live.status !== "verified" || live.type !== row.factor_type) return refuse({ reason: "untrusted_factor", ...base, verified_at: proof.timestamp });
  return { need: null, proofAt: proof.timestamp * 1000 };
}

/** When the member proved the TRUSTED factor that verified this session (ms): exactly the proof trustedStepUpRequirement accepts with
 *  this window, after every one of its checks (trusted list, active, out of its hold, its own method's proof fresh, still verified in
 *  Supabase's current list); null whenever the gate would refuse. The door (door.ts) signs it into its ticket as stepUpAt. */
export async function trustedProofAt(db: D1Database, userId: string, claims: SupabaseClaims, config: SupabaseAuthConfig, nowMs: number,
  maxAgeSeconds: number, currentFactors: () => Promise<readonly CurrentFactor[]>): Promise<number | null> {
  return (await trustedStepUp(db, userId, claims, config, nowMs, maxAgeSeconds, currentFactors)).proofAt;
}

// ---- Routes (Cloud scope: the worker's gate has authenticated the Supabase member before these run) ----------------------

export interface TrustCustomer { user: { id: string }; supabase: SupabaseClaims }
export interface TrustIdentity {
  customer(request: Request): Promise<TrustCustomer | null>;
  /** Supabase Auth's current record, fetched fresh on every call (never cached). */
  supabaseUser(request: Request, env: Env): Promise<{ id: string; email: string; updatedAt: string; factors: { id: string; type: string; status: string; friendlyName: string }[] }>;
  config(env: Env): SupabaseAuthConfig | null;
  now(): number;
}
export interface TrustDependencies { emailSender?: (env: Env) => TransactionalEmailSender }

const factorId = z.string().regex(UUID_RE).transform((s) => s.toLowerCase());
const codeSchema = z.strictObject({ factorId });
const trustSchema = z.strictObject({ factorId, code: z.string().regex(/^\d{8}$/).optional() });

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}
function eightDigits(): string {
  const limit = 4_294_967_296 - (4_294_967_296 % 100_000_000); // rejection sampling: no modulo bias
  const word = new Uint32Array(1);
  do crypto.getRandomValues(word); while (word[0] >= limit);
  return String(word[0] % 100_000_000).padStart(8, "0");
}
const codeHash = (env: Env, userId: string, factor: string, email: string, code: string) =>
  hmacHex(env.BETTER_AUTH_SECRET, `factor-trust-code:${userId}:${factor}:${email}:${code}`);
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const event = (env: Env, userId: string, factor: string, kind: string, at: number) =>
  env.DB.prepare("INSERT INTO cloud_factor_trust_events (id,user_id,factor_id,kind,at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), userId, factor, kind, at);

async function send(env: Env, deps: TrustDependencies, to: string, subject: string, text: string): Promise<boolean> {
  const sender = deps.emailSender?.(env) ?? senderOrFail(env);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  try {
    await sender.send({ to, from: { email: env.EMAIL_FROM, name: "Murage" }, subject, text,
      html: `<!doctype html><html><body>${text.split("\n\n").map((p) => `<p>${esc(p)}</p>`).join("")}</body></html>` });
    return true;
  } catch {
    console.error(JSON.stringify({ message: "factor trust email failed", subject }));
    return false;
  }
}
// No claim about holds or inbox checks here (Astra TRUST-3 #5): not every newly trusted authenticator is held (a fresh account's first one is
// not; one approved by an already-trusted authenticator is not), and not every one had an emailed code. Each message states what happened.
const IF_NOT_YOU = "If this was not you: do not share any code, sign in at https://murage.ai, change your password, remove every authenticator you do not recognise in your account settings, and contact support.";
const label = (f: { type: string; friendlyName: string }) => `${f.friendlyName ? `"${f.friendlyName}" ` : ""}(${f.type === "totp" ? "authenticator app" : "security key"})`;
const utc = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

/** The member's live state: Supabase's verified factors joined with the trusted list. Only ACTIVE rows count as trust
 *  (a staged row is an approval whose notice has not been delivered yet: it grants nothing, Astra MAKERKIT8 #3). Rows for
 *  factors no longer in Supabase are inert and not shown. */
async function state(request: Request, env: Env, identity: TrustIdentity) {
  const who = await identity.customer(request);
  if (!who) throw new HTTPError(401, "unauthorized");
  const config = identity.config(env);
  if (!config) throw new HTTPError(401, "unauthorized");
  const supa = await identity.supabaseUser(request, env);
  // The user record's generation binds codes and activation (MAKERKIT8 #5); without it nothing can be bound: fail closed.
  if (!supa.updatedAt) throw new HTTPError(503, "identity_unavailable");
  const rows = new Map((await trustedRows(env.DB, who.user.id)).map((r) => [r.factor_id, r]));
  const now = identity.now();
  const factors = supa.factors.filter((f) => f.status === "verified").map((f) => {
    const r = rows.get(f.id);
    const trusted = r?.state === "active" ? r : null;
    const staging = r?.state === "staged" && r.trusted_at > now - STAGE_STALE_MS ? r : null;
    return { ...f, trusted, staging, usable: Boolean(trusted && trusted.usable_at <= now) };
  });
  return { who, config, supa, factors, now, hasUsableTrusted: factors.some((f) => f.usable) };
}
function eligible(factors: Awaited<ReturnType<typeof state>>["factors"], id: string) {
  const f = factors.find((x) => x.id === id);
  if (!f || !ELIGIBLE.has(f.type)) throw new HTTPError(409, "factor_not_eligible");
  return f;
}
const verifiedIn = (factors: readonly CurrentFactor[], id: string, type?: string) =>
  factors.some((f) => f.id === id && f.status === "verified" && (type === undefined || f.type === type));

async function list(request: Request, env: Env, identity: TrustIdentity) {
  const s = await state(request, env, identity);
  return json({
    factors: s.factors.map((f) => ({ id: f.id, type: f.type, friendlyName: f.friendlyName, eligible: ELIGIBLE.has(f.type),
      trust: !f.trusted ? "none" : f.usable ? "trusted" : "pending", usableAt: f.trusted ? Math.ceil(f.trusted.usable_at / 1000) : null })),
    newFactorNeeds: s.hasUsableTrusted ? "trusted_factor" : "email_code",
    sessionFactorId: s.who.supabase.mfaFactorId,
    holdSeconds: TRUST_HOLD_MS / 1000,
    proofMaxAgeSeconds: TRUST_PROOF_MAX_AGE_SECONDS,
  });
}

async function sendCode(request: Request, env: Env, identity: TrustIdentity, deps: TrustDependencies) {
  const parsed = codeSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const s = await state(request, env, identity);
  const f = eligible(s.factors, parsed.data.factorId);
  if (f.trusted) throw new HTTPError(409, "already_trusted");
  // With a usable trusted factor the only way in is a proof from it: the email path would let a stolen session plus
  // a compromised mailbox skip the member's authenticator.
  if (s.hasUsableTrusted) throw new HTTPError(409, "trusted_factor_required");
  const userId = s.who.user.id;
  const code = eightDigits();
  const hash = await codeHash(env, userId, f.id, s.supa.email, code);
  // The daily quota is reserved and the code issued in ONE transaction (Astra MAKERKIT8 P2): the reservation inserts the
  // code_sent event only while fewer than CODES_PER_DAY exist (D1 runs one statement at a time, so the count and the insert
  // cannot interleave with another request), and the code is written only when that reservation took (changes()).
  // The bootstrap reservation (part B) rides in the same batch, only once the code was written (changes()=1 of the code statement)
  // and only while the account has nothing to protect. A live reservation is left alone unless it is this session's own for this
  // factor (an idempotent resend); an unconsumed one past its expiry is reclaimed (F6). Being one statement, the expiry check is the
  // generation fence: of two concurrent reclaimers the second sees the first's fresh expiry and gets nothing. Consumed: never.
  const free = nothingToProtect(userId, null);
  const [reserved, , bootstrap] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO cloud_factor_trust_events (id,user_id,factor_id,kind,at) SELECT ?,?,?,'code_sent',?
      WHERE (SELECT COUNT(*) FROM cloud_factor_trust_events WHERE user_id=? AND kind='code_sent' AND at>?) < ?`)
      .bind(crypto.randomUUID(), userId, f.id, s.now, userId, s.now - DAY_MS, CODES_PER_DAY),
    env.DB.prepare(`INSERT INTO cloud_factor_trust_codes (user_id,factor_id,email,email_gen,code_hash,attempts,expires_at,created_at)
      SELECT ?,?,?,?,?,0,?,? WHERE changes()=1
      ON CONFLICT(user_id) DO UPDATE SET factor_id=excluded.factor_id,email=excluded.email,email_gen=excluded.email_gen,
      code_hash=excluded.code_hash,attempts=0,expires_at=excluded.expires_at,created_at=excluded.created_at`)
      .bind(userId, f.id, s.supa.email, s.supa.updatedAt, hash, s.now + CODE_TTL_MS, s.now),
    env.DB.prepare(`INSERT INTO cloud_factor_bootstraps (user_id,factor_id,session_id,op,requested_at,consumed_at,expires_at)
      SELECT ?,?,?,NULL,?,NULL,? WHERE changes()=1 AND ${free.sql}
      ON CONFLICT(user_id) DO UPDATE SET factor_id=excluded.factor_id,session_id=excluded.session_id,requested_at=excluded.requested_at,
      expires_at=excluded.expires_at
      WHERE cloud_factor_bootstraps.consumed_at IS NULL AND (cloud_factor_bootstraps.expires_at<=?
        OR (cloud_factor_bootstraps.factor_id=excluded.factor_id AND cloud_factor_bootstraps.session_id=excluded.session_id))`)
      .bind(userId, f.id, s.who.supabase.sessionId, s.now, s.now + CODE_TTL_MS, ...free.binds, s.now),
  ]);
  if (reserved.meta.changes !== 1) throw new HTTPError(429, "rate_limited");
  const subject = "Your code to trust an authenticator on your Murage Cloud account";
  const after = bootstrap.meta.changes === 1
    ? "After you enter it, the authenticator is trusted straight away: your account has no homes, payments or other authenticators yet, so there is no 24-hour hold."
    : "After you enter it, the authenticator is trusted 24 hours later.";
  const ok = await send(env, deps, s.supa.email, subject, `${subject}\n\nSomeone signed in to your Murage Cloud account asked to trust the authenticator ${label(f)} for payments and desktop connections.\n\nYour one-time code is: ${code}\n\nIt works once, for 10 minutes. ${after}\n\n${IF_NOT_YOU}`);
  if (!ok) {
    // The reservation stays spent: a failed send still counts toward the day's five. A bootstrap reservation stays too: its owner may
    // resend (same session, same factor), and after its expiry anyone on the account may reclaim it (F6).
    await env.DB.prepare("DELETE FROM cloud_factor_trust_codes WHERE user_id=? AND code_hash=?").bind(userId, hash).run();
    throw new HTTPError(503, "email_unavailable");
  }
  console.log(JSON.stringify({ message: "factor trust code sent", factorId: f.id }));
  return json({ sent: true, expiresIn: CODE_TTL_MS / 1000 }, 202);
}

/**
 * Trust a factor, in three steps so that no authority exists before the member has been told (Astra MAKERKIT8 #3):
 *   1. AUTHORIZE and STAGE: the proof from a trusted factor (still verified in Supabase, MAKERKIT8 #2), or the emailed code
 *      (consumed in the same transaction that stages the row, conditioned on the address and the user record's generation
 *      it was issued for, MAKERKIT8 #5). A staged row grants nothing: every reader counts only state='active'.
 *   2. NOTIFY the member at Supabase's current address. Failure: the staged row is deleted, 503.
 *   3. REVALIDATE with a fresh read of Supabase (same address and generation as the decision was made on, the factor and
 *      the approving factor still verified), then ACTIVATE in one statement bound to this request's staging id (and, for a
 *      factor approval, to the approver's row still being active and usable). Any change: the staged row is deleted, 409.
 * A crash anywhere leaves at most a staged row, which grants nothing and is replaced by the next attempt.
 */
async function trust(request: Request, env: Env, identity: TrustIdentity, deps: TrustDependencies) {
  const parsed = trustSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const s = await state(request, env, identity);
  const f = eligible(s.factors, parsed.data.factorId);
  const userId = s.who.user.id;
  if (f.trusted) return json({ factorId: f.id, trust: f.usable ? "trusted" : "pending", usableAt: Math.ceil(f.trusted.usable_at / 1000), already: true });
  if (f.staging) throw new HTTPError(409, "trust_in_progress");

  const op = crypto.randomUUID();
  const stage = (via: string, condition: string) => env.DB.prepare(`INSERT INTO cloud_trusted_factors (user_id,factor_id,factor_type,via,trusted_at,usable_at,state,op)
    SELECT ?,?,?,?,?,?,'staged',? WHERE ${condition}
    ON CONFLICT(user_id,factor_id) DO UPDATE SET factor_type=excluded.factor_type,via=excluded.via,trusted_at=excluded.trusted_at,
    usable_at=excluded.usable_at,op=excluded.op WHERE cloud_trusted_factors.state='staged' AND cloud_trusted_factors.trusted_at<?`)
    .bind(userId, f.id, f.type, via, s.now, NEVER, op, s.now - STAGE_STALE_MS);
  let via: "trusted_factor" | "email_code";
  let approver: string | null = null;
  /** This op consumed the account's bootstrap (part B): the hold may be waived, subject to the activation re-check. */
  let bootstrapped = false;
  if (s.hasUsableTrusted) {
    // A proof FROM a trusted factor, verified in the last 5 minutes, that is still enrolled. The email path is closed.
    const need = await trustedStepUpRequirement(env.DB, userId, s.who.supabase, s.config, s.now, TRUST_PROOF_MAX_AGE_SECONDS, async () => s.supa.factors);
    if (need) throw new HTTPError(403, "step_up_required", { step_up: { ...need } });
    via = "trusted_factor";
    approver = s.who.supabase.mfaFactorId;
    if ((await stage(via, "1").run()).meta.changes !== 1) throw new HTTPError(409, "trust_in_progress");
  } else {
    if (!parsed.data.code) throw new HTTPError(400, "email_code_required");
    const row = await env.DB.prepare(`UPDATE cloud_factor_trust_codes SET attempts=attempts+1 WHERE user_id=? AND attempts<?
      RETURNING factor_id,email,email_gen,code_hash,expires_at`).bind(userId, CODE_MAX_ATTEMPTS)
      .first<{ factor_id: string; email: string; email_gen: string; code_hash: string; expires_at: number }>();
    const refuse = async () => {
      await event(env, userId, f.id, "code_refused", s.now).run();
      throw new HTTPError(403, "code_refused");
    };
    // Bound to the factor, the address it was sent to and the user record's generation then (both still Supabase's
    // current ones), and its expiry. A->B->A gives the same address back but a new generation.
    if (!row || row.factor_id !== f.id || row.expires_at <= s.now || row.email !== s.supa.email || !row.email_gen || row.email_gen !== s.supa.updatedAt) return refuse();
    if (!sameHex(row.code_hash, await codeHash(env, userId, f.id, s.supa.email, parsed.data.code))) return refuse();
    // Spent and staged in one transaction: only one request can hold the code, and the binding is re-checked in the
    // same statement that spends it.
    // The bootstrap is consumed in the same batch (Astra TRUST-2 Q2), only by THIS factor, THIS session and THIS op's staged row, while
    // the reservation is live and unconsumed and the account still has nothing to protect (verification-time eligibility).
    const free = nothingToProtect(userId, { factorId: f.id, op });
    const [spent, staged, consumed] = await env.DB.batch([
      env.DB.prepare("DELETE FROM cloud_factor_trust_codes WHERE user_id=? AND code_hash=? AND factor_id=? AND email=? AND email_gen=?")
        .bind(userId, row.code_hash, f.id, s.supa.email, s.supa.updatedAt),
      stage("email_code", "changes()=1"),
      env.DB.prepare(`UPDATE cloud_factor_bootstraps SET consumed_at=?,op=?
        WHERE user_id=? AND factor_id=? AND session_id=? AND consumed_at IS NULL AND expires_at>?
        AND EXISTS (SELECT 1 FROM cloud_trusted_factors WHERE user_id=? AND factor_id=? AND op=? AND state='staged')
        AND ${free.sql}`)
        .bind(s.now, op, userId, f.id, s.who.supabase.sessionId, s.now, userId, f.id, op, ...free.binds),
    ]);
    if (spent.meta.changes !== 1) return refuse();
    if (staged.meta.changes !== 1) throw new HTTPError(409, "trust_in_progress");
    via = "email_code";
    bootstrapped = consumed.meta.changes === 1;
  }
  const unstage = () => env.DB.prepare("DELETE FROM cloud_trusted_factors WHERE user_id=? AND factor_id=? AND op=? AND state='staged'").bind(userId, f.id, op).run();

  const subject = "An authenticator was added to the trusted list on your Murage Cloud account";
  // What actually happened: how it was approved, and from when it can be used.
  const when = bootstrapped
    ? "It was approved with the one-time code we emailed to this address. It can approve payments and connect desktops now: your account had no homes, payments or other authenticators, so there is no 24-hour hold (if one was added at this same moment, the hold applies)."
    : via === "email_code"
    ? `It was approved with the one-time code we emailed to this address. It can approve payments and connect desktops from about ${utc(s.now + TRUST_HOLD_MS)} (a 24-hour hold).`
    : "It was approved by an authenticator already on your trusted list, without an emailed code, and can approve payments and connect desktops now.";
  if (!await send(env, deps, s.supa.email, subject, `${subject}\n\nThe authenticator ${label(f)} is being added to your trusted list. ${when}\n\n${IF_NOT_YOU}`)) {
    await unstage();
    throw new HTTPError(503, "email_unavailable");
  }

  // Revalidate against Supabase NOW: nothing the decision rested on may have changed while the notice was sent.
  const fresh = await identity.supabaseUser(request, env).catch(async (e: unknown) => { await unstage(); throw e; });
  if (fresh.email !== s.supa.email || fresh.updatedAt !== s.supa.updatedAt || !verifiedIn(fresh.factors, f.id, f.type)
    || (approver !== null && !verifiedIn(fresh.factors, approver))) {
    await unstage();
    throw new HTTPError(409, "account_changed");
  }
  const at = identity.now();
  // usable_at is decided INSIDE the activation statement (Astra TRUST-2 F1): for the emailed code it is `at` only when this op consumed
  // the account's bootstrap AND the account still has nothing to protect (excluding only this op's own staged row); anything else that
  // appeared since verification (a home, a subscription, a machine assignment, another factor staged) keeps the 24-hour hold.
  const free = nothingToProtect(userId, { factorId: f.id, op });
  const usable = via === "email_code"
    ? {
      sql: `CASE WHEN EXISTS (SELECT 1 FROM cloud_factor_bootstraps b WHERE b.user_id=? AND b.factor_id=? AND b.session_id=? AND b.op=?
        AND b.consumed_at IS NOT NULL) AND ${free.sql} THEN ? ELSE ? END`,
      binds: [userId, f.id, s.who.supabase.sessionId, op, ...free.binds, at, at + TRUST_HOLD_MS],
    }
    : { sql: "?", binds: [at] };
  const activate = env.DB.prepare(`UPDATE cloud_trusted_factors SET state='active',trusted_at=?,usable_at=${usable.sql}
    WHERE user_id=? AND factor_id=? AND op=? AND state='staged'${approver === null ? "" : `
    AND EXISTS (SELECT 1 FROM cloud_trusted_factors a WHERE a.user_id=? AND a.factor_id=? AND a.state='active' AND a.usable_at<=?)`}
    RETURNING usable_at`)
    .bind(...[at, ...usable.binds, userId, f.id, op, ...(approver === null ? [] : [userId, approver, at])]);
  const [activated] = await env.DB.batch([activate,
    env.DB.prepare("INSERT INTO cloud_factor_trust_events (id,user_id,factor_id,kind,at) SELECT ?,?,?,?,? WHERE changes()=1")
      .bind(crypto.randomUUID(), userId, f.id, via === "email_code" ? "trusted_email_code" : "trusted_by_factor", at)]);
  if (activated.meta.changes !== 1) {
    await unstage();
    throw new HTTPError(409, "account_changed");
  }
  const usableAt = (activated.results[0] as { usable_at: number } | undefined)?.usable_at ?? at + TRUST_HOLD_MS;
  console.log(JSON.stringify({ message: "factor trusted", factorId: f.id, via, held: usableAt > at }));
  return json({ factorId: f.id, trust: usableAt > at ? "pending" : "trusted", usableAt: Math.ceil(usableAt / 1000), via }, 201);
}

export async function trustedFactorRoute(request: Request, env: Env, identity: TrustIdentity, deps: TrustDependencies = {}): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === "/v1/account/mfa/factors") {
    if (request.method !== "GET") throw new HTTPError(405, "method_not_allowed");
    return list(request, env, identity);
  }
  if (path === "/v1/account/mfa/trust-code") {
    if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
    return sendCode(request, env, identity, deps);
  }
  if (path === "/v1/account/mfa/trust") {
    if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
    return trust(request, env, identity, deps);
  }
  return null;
}
