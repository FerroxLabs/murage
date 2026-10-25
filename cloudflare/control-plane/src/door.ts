// SPDX-License-Identifier: AGPL-3.0-or-later
// The door: "Open Murage" in the members area lands the browser signed in at its Cloud home (lanes/cloud-door/DESIGN.md sections 2, 3, 5).
//
// POST /v1/homes/:id/door, body {}. A Cloud route (customer-identity.ts isCloudScopePath): the caller is the members-area Supabase identity,
// never a Better Auth session. It needs a fresh second factor (STEP_UP_PATTERNS), within 300 s (stepUpMaxAgeFor), checked by the worker's gate
// and again here; a step-up intent claimed for this request (step-up-email.ts) counts: an emailed code from its verification time, a fresh
// trusted authenticator from its proof time.
// The signed-in OWNER of a live home (desired_state ready, checking or payment_problem) whose endpoint is ready gets
//   200 {"url": "<publicOrigin>/enter#t=<payload>.<signature>", "expiresIn": 60}, cache-control: no-store,
// where <payload>.<signature> is the B3 ES256 envelope (b3-signatures.ts signPayload, the same key and encoding as murage-home-key-v1) of
// the strict claim object below. The home verifies it, spends the nonce and lets the browser make or use its own device key and passkey: the
// ticket alone can pair only the first device of an empty home (exactly the bootstrap HMAC's power), and the CP keeps no ticket store.
// Refusals: 401 unauthorized; 403 step_up_required; 404 not_found (not the owner and no such home answer alike); 409 home_not_ready;
// 429 rate_limited with Retry-After (10 a minute and 60 an hour per account, 30 a minute per home). The mint is logged without the ticket.
// The first HANDED-OUT ticket per (account, home) owes the owner a NOTICE (DESIGN.md section 2), never a gate. The row in cloud_door_notices
// is ARMED by the hand-out's last write (stageNotice, handOutDoorTicket, the worker's last step), in one batch with a last ownership/
// generation/readiness recheck, BEFORE the final 55 s check: that write commits the control plane to handing the ticket out, so from it the
// notice is owed whatever happens to the later confirmation of the step-up intent (Astra DOORMINT-7). A refusal before it writes nothing; a
// refusal after it (the clock) takes back only what it armed, while nobody else has touched the row (withdrawNotice). Only an armed row is
// ever sent, by the hand-out or by the cron sweep (sweepDoorNotices); an unarmed one (a withdrawn arming) is never sent, is armed again by
// the next hand-out, and is tidied away after a day (best-effort, never load-bearing). The arming claims the first attempt, made after the
// response (waitUntil), and the sweep retries an armed, unsent row with backoff until it goes out.
// One email per (account, home): the row is the dedupe. The notice's bookkeeping (sent_at, attempts, next_attempt_at) is written on the
// raw binding, never the step-up journal (a claimed intent is finalized before the background send ends). Its address is always the
// account's contact address reconciled with Supabase Auth's current one first (cloud-accounts.ts reconciledContactEmail), on the first
// attempt (the member's token) and on every retry (the identity reader, no token): an unconfirmed address is never mailed (deliverDoorNotice).
// The ticket is stamped and signed after every await of the route but the signature, and is handed out only with >= 55 s left, checked
// again as the very last step of the hand-out (after the step-up intent's finalization and the notice batch): re-minted once, else 503
// door_unavailable. The route's own answer never carries the ticket: a claimed step-up intent is finalized "handing out" and recorded
// delivered only after the hand-out succeeded (DOOR_HANDING_OUT).
//
// DOOR V2 (CLOUD-DOOR-V2-DESIGN.md r4 section 4B with the r4.1 and r4.2 addenda; binding where it differs from the text above):
// - Body: {bind: 64 hex, kind: "browser"|"desktop"} or {}. The mint branches on the home's door_version (stamped by its heartbeats,
//   b3-control.ts heartbeat) and DOOR_V2_REQUIRED ("1": v2 is the only door):
//     v2 home, {bind, kind}: a murage-door-v2 ticket (the v1 claims plus bind, kind and, for a desktop, pairHold); door "v2".
//     v2 home, {}: 400 door_body_required (logged), with and without the flag.
//     not v2, flag off: {} and a browser {bind, kind}: the v1 ticket exactly as before (bind dropped); a desktop: 409 door_needs_update.
//     not v2, flag on: 409 door_needs_update, whatever the body.
// - The second step: within 900 s for a v2 ticket (300 s for a v1 ticket: a v1 home refuses older), and the emailed sign-in or an emailed
//   code granted in THIS Supabase session counts (customer-identity.ts doorRecentProofAt, 3.4).
// - A desktop ticket for a home that has (or ever had) a full-scope device is minted ONLY with a pairHold claim: a completed 72-hour pair
//   hold RESERVED for this ticket (pairing.ts reservePairHold: reserved_by = nonce, reserved_until = expiry + skew), never spent here; the
//   home spends it at exchange. No hold, or one reserved by another ticket: 409 door_needs_hold (with completesAt while a hold is running).
//   The first full-scope device a home ever has needs no hold.
// - The notice is owed per (account, home, Supabase session, bind), and its SEND is paced: at most three emails per (account, home) per
//   clock hour, claimed and reserved atomically (sendOwedNotices); the rest fold into the next email.
import { z } from "zod";
import { signPayload } from "./b3-signatures";
import { boundCustomer, DOOR_ROUTE, DOOR_STEP_UP_MAX_AGE_SECONDS, DOOR_V1_STEP_UP_MAX_AGE_SECONDS, doorRecentProofAt, doorV2Required, stepUpProof, stepUpProofValid,
  type CustomerSession, type Identity } from "./customer-identity";
import { noticeBackoff } from "./b5-billing";
import { reconciledContactEmail, type CurrentSupabaseUser } from "./cloud-accounts";
import { listHomeDevices } from "./devices";
import { senderOrFail, type TransactionalEmailSender } from "./email";
import { HOSTNAME } from "./homes";
import { errorResponse, HTTPError, json, readBoundedJSON } from "./http";
import { reservePairHold, runningPairHold, type PairingDependencies } from "./pairing";
import { READER_TIMEOUT_MS, readerOf, type IdentityReader } from "./public-tokens";
import { ACTIVE_STATES, takeLimit } from "./self-service";
import { CLOCK_SKEW_SECONDS } from "./supabase-jwt";
import { stepUpOpOf } from "./step-up-op";
import { trustedProofAt, type CurrentFactor } from "./trusted-factors";

declare global {
  interface Env {
    /** "1": door v2 is the only door (CLOUD-DOOR-V2-DESIGN.md 4B): no v1 ticket is minted and a home is marked ready only after it advertised v2. */
    DOOR_V2_REQUIRED?: string;
  }
  namespace Cloudflare {
    interface Env {
      DOOR_V2_REQUIRED?: string;
    }
  }
}
export { doorV2Required };

export const DOOR_TICKET_TTL_MS = 60_000;
const DOOR_STEP_UP_MAX_AGE_MS = DOOR_STEP_UP_MAX_AGE_SECONDS * 1000;
const DOOR_V1_STEP_UP_MAX_AGE_MS = DOOR_V1_STEP_UP_MAX_AGE_SECONDS * 1000;
export const DOOR_NOTICE_SUBJECT = "Murage was opened from a new browser sign-in";
/** The subject of a notice owed by a hand-out refused after its arming write, with no hand-out of the row delivered (yet): an attempt. */
export const DOOR_ATTEMPT_SUBJECT = "Someone asked to open Murage from a new browser sign-in";
/** A ticket is handed out only while at least this much of its 60 s is left (else it is minted once more). */
export const DOOR_TICKET_MIN_REMAINING_MS = 55_000;
/** A send in progress owns its claimed notice rows this long (next_attempt_at); a sender that died is retried by the sweep after it. */
export const DOOR_NOTICE_CLAIM_MS = 10 * 60_000;
/** At most this many notice emails per (account, home) per clock hour (cloud_door_notice_slots n = 1..3). */
export const DOOR_NOTICE_SLOTS_PER_HOUR = 3;
const HOUR_MS = 3_600_000;
const DOOR_NOTICE_SWEEP_BATCH = 50;

interface DoorClaimsCommon {
  homeId: string; generation: number; publicOrigin: string; account: string;
  nonce: string; stepUpAt: number; issuedAt: number; expiresAt: number;
}
/** The v1 ticket's claims, exactly these keys in this order (a v1 home refuses any other field). */
export interface DoorClaimsV1 extends DoorClaimsCommon { type: "murage-door-v1" }
/** The v2 ticket's claims (4A.1: the v1 fields, bind, kind, optional pairHold; the v2 home parses nothing else). */
export interface DoorClaimsV2 extends DoorClaimsCommon { type: "murage-door-v2"; bind: string; kind: "browser" | "desktop"; pairHold?: string;
  /** Only a browser ticket for a home advertising the owner factor (door_proof===1): the sign-in carried an emailed code
   *  (`email`, from amr|granted|intent) or a trusted authenticator (`factor`). The home issues the remembered-owner factor on it (§4.1). */
  proof?: "email" | "factor" }
export type DoorClaims = DoorClaimsV1 | DoorClaimsV2;

export interface DoorDependencies {
  emailSender?: (env: Env) => TransactionalEmailSender;
  /** Runs the first notice's send beside the response (the worker passes ctx.waitUntil). Without it the send is started, not awaited. */
  waitUntil?: (work: Promise<unknown>) => void;
  /** Tests only: runs after the first home read (a concurrent change lands here). */
  afterRead?: () => Promise<void>;
  /** Tests only: runs after each signature (attempt 0, then 1 when re-minted, in the route or in handOutDoorTicket), before the freshness check. */
  afterSign?: (attempt: number) => void | Promise<void>;
  /** The sweep's source of Supabase's current address (no token there): the IDENTITY_READER service binding unless given (tests). */
  reader?: IdentityReader | null;
  readerTimeoutMs?: number;
  /** The desktop mint's device check at the home (devices.ts listHomeDevices): the outbound call and the bootstrap-secret unwrapper. */
  homeFetch?: PairingDependencies["homeFetch"];
  keyWrapper?: PairingDependencies["keyWrapper"];
}
/** Supabase Auth's current record of a mapped user. Throws HTTPError 401 (gone) or 503 (cannot answer now). */
type LiveUser = (sub: string) => Promise<CurrentSupabaseUser>;

const BIND = /^[0-9a-f]{64}$/;
const bodySchema = z.union([z.strictObject({ bind: z.string().regex(BIND), kind: z.enum(["browser", "desktop"]) }), z.strictObject({})]);

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
/** 256 random bits, base64url without padding: 43 characters. */
const newNonce = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

function rateLimited(retryAfterSeconds: number): Response {
  const retryAfter = Math.max(1, retryAfterSeconds);
  // The same shape as the emailed step-up's 429 (step-up-email.ts): both spellings and the Retry-After header.
  const res = errorResponse(429, "rate_limited", { retryAfter, retry_after_seconds: retryAfter });
  res.headers.set("retry-after", String(retryAfter));
  return res;
}

/** Which proof the door's second step came from (the mint log line says it; never anything else about it). */
type ProofKind = "intent" | "factor" | "amr" | "granted";

/** When this request's fresh second factor was proved (ms), and by what, or 403 step_up_required. A step-up intent claimed for this very
 *  request counts: an emailed-code approval from its verification (approved_at), and the TRUSTED authenticator in the session from its
 *  proof (an intent claimed by a fresh authenticator keeps any older approved_at). Door v2 (3.4): the emailed sign-in or an emailed code
 *  granted in THIS Supabase session (doorRecentProofAt) counts too. The FRESHEST proof inside the door's window (900 s) wins. An
 *  authenticator's proof time counts only when the gate's own check accepts that factor now (trustedProofAt: on the trusted list, active,
 *  out of its hold, its method's proof fresh, still verified in Supabase's current list), never a timestamp read beside it (Astra
 *  DOORMINT-3). */
async function stepUpAt(request: Request, env: Env, identity: Identity, session: CustomerSession, now: number): Promise<{ at: number; proof: ProofKind }> {
  const accountId = session.user.id;
  const refuse = () => new HTTPError(403, "step_up_required");
  const valid = (at: number | null | undefined): at is number =>
    typeof at === "number" && now - at <= DOOR_STEP_UP_MAX_AGE_MS && at <= now + CLOCK_SKEW_SECONDS * 1000;
  // Supabase's current factor list, asked at most once here and only once every local check has passed (as the gate asks it).
  let factors: Promise<{ factors: CurrentFactor[] }> | null = null;
  const currentFactors = async () => (await (factors ??= identity.supabaseUser(request, env))).factors;
  const trusted = async () => {
    const config = identity.config(env);
    if (!config || session.user.id !== accountId) throw refuse();
    return trustedProofAt(env.DB, accountId, session.supabase, config, now, DOOR_STEP_UP_MAX_AGE_SECONDS, currentFactors);
  };
  const recent = await doorRecentProofAt(env, session, now);
  const proofs: { at: number; proof: ProofKind }[] = [];
  if (recent && valid(recent.at)) proofs.push(recent);
  if (stepUpProof(request) && await stepUpProofValid(request)) {
    const row = await env.DB.prepare("SELECT approved_at FROM cloud_stepup_intents WHERE id=? AND user_id=?")
      .bind(stepUpProof(request)!.intentId, accountId).first<{ approved_at: number | null }>();
    if (!row) throw refuse();
    if (valid(row.approved_at)) proofs.push({ at: row.approved_at, proof: "intent" });
    // A valid emailed approval stands on its own: the authenticator can only make it fresher.
    try { const f = await trusted(); if (valid(f)) proofs.push({ at: f, proof: "factor" }); } catch (e) { if (!proofs.length) throw e; }
  } else if (!await identity.stepUpNeeded(request, env)) {
    try { const f = await trusted(); if (valid(f)) proofs.push({ at: f, proof: "factor" }); } catch (e) { if (!proofs.length) throw e; }
  }
  if (!proofs.length) throw refuse();
  const best = proofs.reduce((a, b) => (b.at > a.at ? b : a));
  // Never later than the ticket itself (a proof inside the clock skew is signed as "now").
  return { at: Math.min(best.at, now), proof: best.proof };
}

interface DoorHome {
  owner_id: string; generation: number; desired_state: string; door_version: string | null; door_proof: number | null;
  hostname: string | null; endpoint_status: string | null; tunnel_id: string | null; dns_record_id: string | null;
}

const HOME_SQL = `SELECT h.owner_id, h.generation, h.desired_state, h.door_version, h.door_proof, e.hostname, e.status AS endpoint_status, e.tunnel_id, e.dns_record_id
  FROM cloud_homes h LEFT JOIN machine_endpoints e ON e.machine_id=h.id AND e.status NOT IN ('deleting','deleted')
  WHERE h.id=? AND h.desired_state<>'deleted'`;
/** The home read at the mint, unchanged and still ready (its door included: a home that changes its door or owner-factor flag between read and recheck is 409). */
const same = (read: DoorHome, now: DoorHome) => ready(now) && now.generation === read.generation && now.desired_state === read.desired_state
  && now.hostname === read.hostname && (now.door_version ?? null) === (read.door_version ?? null) && (now.door_proof ?? 0) === (read.door_proof ?? 0);
const ready = (h: DoorHome) => ACTIVE_STATES.includes(h.desired_state) && Number.isSafeInteger(h.generation) && h.generation >= 1
  && h.endpoint_status === "ready" && Boolean(h.tunnel_id) && Boolean(h.dns_record_id) && Boolean(h.hostname) && HOSTNAME.test(h.hostname ?? "");

async function sendDoorNotice(env: Env, dependencies: DoorDependencies, to: string, delivered: boolean, count: number): Promise<void> {
  // delivered: a hand-out of a claimed row was answered with its ticket, so a browser signed in to the account, with a fresh second step,
  // got the one-time link that opens the home. Otherwise every claimed row is owed by a hand-out refused after its arming write (sent
  // deliberately, conservatively): it describes the ATTEMPT and never asserts that the link was given.
  const subject = delivered ? DOOR_NOTICE_SUBJECT : DOOR_ATTEMPT_SUBJECT;
  const what = delivered
    ? "A browser signed in to your account on murage.ai, with your second step, was just given the one-time link that opens your Murage Cloud home."
    : "Someone signed in to your Murage Cloud account and asked to open your home from a new browser.";
  const more = count > 1 ? ` And ${count - 1} more new sign-in${count - 1 === 1 ? "" : "s"} since the last notice.` : "";
  const text = `${subject}\n\n${what}${more} You get this email once for each new sign-in and device, at most three times an hour.\n\n`
    + "If this was not you, sign in at https://murage.ai/home/cloud, change your password and your second step, then remove any device you do not recognise under Devices.";
  await (dependencies.emailSender?.(env) ?? senderOrFail(env)).send({ to, from: { email: env.EMAIL_FROM, name: "Murage" }, subject, text,
    html: `<!doctype html><html><body>${text.split("\n\n").map((p) => `<p>${p}</p>`).join("")}</body></html>` });
}

/** The binding the notice's bookkeeping is written on: the RAW one. Inside a claimed step-up operation env.DB is its journal, whose every
 *  write is fenced on the intent still executing; the background send ends after the intent is finalized, so its writes would roll back. */
const noticeDb = (env: Env): D1Database => stepUpOpOf(env)?.db ?? env.DB;

/** ONE paced send of the owed notices of (account, home) (4B "Notices", Astra r3 Medium 6). Never throws; true when an email went out.
 *  1. Claim: one statement takes every armed, unsent, due row of (account, home) for this sender (claim_id; next_attempt_at moves past the
 *     claim, so another sender skips them). No rows: nothing to send.
 *  2. Reserve: slot 1, 2 or 3 of the clock hour (INSERT OR IGNORE, the first with changes = 1). No slot: the claimed rows are released to
 *     the next hour's start and nothing is sent.
 *  3. Send ONE email for every claimed row ("and N more" when more than one; the delivered wording only when a claimed row was delivered),
 *     to the account's contact address as Supabase Auth confirms it NOW (`live`, reconciled first: cloud-accounts.ts reconciledContactEmail;
 *     never the stored address unchecked). Sent: sent_at. Failed: backed off (noticeBackoff); the slot stays spent. */
async function sendOwedNotices(db: D1Database, env: Env, dependencies: DoorDependencies, accountId: string, homeId: string, live: LiveUser,
  nowMs = Date.now()): Promise<boolean> {
  const claimId = crypto.randomUUID();
  let claimed: { session_id: string; bind: string; delivered: number; attempts: number }[];
  try {
    claimed = (await db.prepare(`UPDATE cloud_door_notices SET claim_id=?, next_attempt_at=?
      WHERE account_id=? AND home_id=? AND armed=1 AND sent_at IS NULL AND next_attempt_at<=?
      RETURNING session_id, bind, delivered, attempts`).bind(claimId, nowMs + DOOR_NOTICE_CLAIM_MS, accountId, homeId, nowMs)
      .all<{ session_id: string; bind: string; delivered: number; attempts: number }>()).results;
  } catch { return false; }
  if (!claimed.length) return false;
  const attempts = Math.max(...claimed.map((r) => r.attempts));
  const backOff = async () => {
    try {
      await db.prepare("UPDATE cloud_door_notices SET attempts=attempts+1, next_attempt_at=? WHERE claim_id=? AND sent_at IS NULL")
        .bind(Date.now() + noticeBackoff(attempts), claimId).run();
    } catch { /* the claim runs out; the sweep tries again */ }
  };
  const hour = Math.floor(nowMs / HOUR_MS);
  let slot = false;
  try {
    for (let n = 1; n <= DOOR_NOTICE_SLOTS_PER_HOUR && !slot; n++) {
      const r = await db.prepare("INSERT OR IGNORE INTO cloud_door_notice_slots (account_id,home_id,hour,n,at) VALUES (?,?,?,?,?)")
        .bind(accountId, homeId, hour, n, nowMs).run();
      slot = r.meta.changes === 1;
    }
  } catch {
    await backOff();
    return false;
  }
  if (!slot) {
    try {
      await db.prepare("UPDATE cloud_door_notices SET next_attempt_at=? WHERE claim_id=? AND sent_at IS NULL").bind((hour + 1) * HOUR_MS, claimId).run();
    } catch { /* the claim runs out; the next hour's sender takes them */ }
    console.log(JSON.stringify({ message: "door notice deferred", homeId, rows: claimed.length }));
    return false;
  }
  try {
    const to = await reconciledContactEmail(db, accountId, Date.now(), live);
    if (!to) throw new Error("notice_undeliverable");
    await sendDoorNotice(env, dependencies, to, claimed.some((r) => r.delivered === 1), claimed.length);
  } catch {
    // Never the address.
    console.error(JSON.stringify({ message: "door notice failed", homeId, attempts: attempts + 1 }));
    await backOff();
    return false;
  }
  try {
    await db.prepare("UPDATE cloud_door_notices SET sent_at=? WHERE claim_id=? AND sent_at IS NULL").bind(Date.now(), claimId).run();
  } catch { /* sent but not recorded: at least once, the sweep may send it again after the claim */ }
  return true;
}

/** Supabase's current record of `sub` from the identity reader (cloudflare/identity-reader: GET /auth/v1/admin/users/:sub with the secret
 *  key, which only that Worker holds): no reader, a timeout, an error or another user's answer is 503 identity_unavailable. */
function readerUser(env: Env, dependencies: DoorDependencies): LiveUser {
  return async (sub) => {
    const reader = readerOf(env, { reader: dependencies.reader });
    if (!reader) throw new HTTPError(503, "identity_unavailable");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), dependencies.readerTimeoutMs ?? READER_TIMEOUT_MS); });
      const r = await Promise.race([reader.emailGen(sub), timeout]);
      if (!r || typeof r.id !== "string" || typeof r.email !== "string" || r.id.toLowerCase() !== sub.toLowerCase() || !r.email.trim()) throw new Error("bad answer");
      return { id: sub, email: r.email.trim().toLowerCase() };
    } catch {
      throw new HTTPError(503, "identity_unavailable");
    } finally {
      clearTimeout(timer);
    }
  };
}

/** An unarmed row (a withdrawn arming) older than this is tidied away by the sweep (best-effort: a later hand-out arms or re-creates it). */
const DOOR_NOTICE_UNARMED_TTL_MS = 86_400_000;
/** Slots older than a day and sent notice rows older than 30 days are deleted by the sweep. */
const DOOR_NOTICE_SLOT_TTL_MS = 86_400_000;
const DOOR_NOTICE_SENT_TTL_MS = 30 * 86_400_000;

/** Cron: every (account, home) with an ARMED owed notice whose time has come gets one paced send (sendOwedNotices: claim, slot, send), to
 *  the address the identity reader confirms now. An unarmed row (its arming was withdrawn: no ticket was handed out) is never selected.
 *  Returns how many emails went out. */
export async function sweepDoorNotices(env: Env, nowMs = Date.now(), dependencies: DoorDependencies = {}): Promise<number> {
  const db = noticeDb(env);
  for (const [sql, before] of [
    ["DELETE FROM cloud_door_notices WHERE armed=0 AND sent_at IS NULL AND created_at<?", nowMs - DOOR_NOTICE_UNARMED_TTL_MS],
    ["DELETE FROM cloud_door_notice_slots WHERE at<?", nowMs - DOOR_NOTICE_SLOT_TTL_MS],
    ["DELETE FROM cloud_door_notices WHERE sent_at IS NOT NULL AND sent_at<?", nowMs - DOOR_NOTICE_SENT_TTL_MS],
  ] as const) {
    try { await db.prepare(sql).bind(before).run(); } catch { /* tidying only */ }
  }
  const due = await env.DB.prepare(`SELECT account_id, home_id, MIN(next_attempt_at) AS due FROM cloud_door_notices
    WHERE sent_at IS NULL AND armed=1 AND next_attempt_at<=? GROUP BY account_id, home_id ORDER BY due LIMIT ?`).bind(nowMs, DOOR_NOTICE_SWEEP_BATCH)
    .all<{ account_id: string; home_id: string }>();
  let sent = 0;
  const live = readerUser(env, dependencies);
  for (const row of due.results) {
    if (await sendOwedNotices(db, env, dependencies, row.account_id, row.home_id, live, nowMs)) sent++;
  }
  return sent;
}

/** The home's full-scope history for a desktop ticket (r4.2; Astra D1 #1 and #2). Only CONFIRMED enrollment counts, and only the home
 *  knows it: a pairing code the CP issued (cloud_unwrap_log) proves nothing, since it may never have been redeemed. From the home's device
 *  list (which first reconciles the holds the home consumed, devices.ts):
 *  - "had": an active full-scope row, `fullScopeEver: true` (revoked ones included), or a consumed hold: the ticket needs a pair hold;
 *  - "never": `fullScopeEver: false` and no active full-scope row: the first computer never waits;
 *  - "unknown": the answer omits fullScopeEver (an older image). Never read as "never enrolled", and never a hold on that alone: a ready
 *    hold is reserved and claimed when there is one, else the ticket is minted as before and the home's exchange decides. */
type DesktopHistory = "had" | "never" | "unknown";
async function desktopHistory(env: Env, homeId: string, account: { id: string; email: string }, dependencies: DoorDependencies)
  : Promise<{ history: DesktopHistory; consumed: string[] }> {
  const list = await listHomeDevices(env, homeId, account, { homeFetch: dependencies.homeFetch, keyWrapper: dependencies.keyWrapper });
  const consumed = list.consumedHoldIds ?? [];
  if (list.fullScopeEver === true || list.devices.some((d) => d.scope !== "browser") || consumed.length > 0) return { history: "had", consumed };
  return { history: list.fullScopeEver === false ? "never" : "unknown", consumed };
}

/** 409 door_needs_hold: with the running pair hold's end time when one is running, nothing else otherwise. */
async function needsHold(env: Env, homeId: string, generation: number): Promise<HTTPError> {
  const completesAt = await runningPairHold(env.DB, homeId, generation);
  return new HTTPError(409, "door_needs_hold", completesAt !== null ? { completesAt } : undefined);
}

export async function doorRoute(request: Request, env: Env, identity: Identity, requestId: string,
  dependencies: DoorDependencies = {}): Promise<Response | null> {
  const match = DOOR_ROUTE.exec(new URL(request.url).pathname);
  if (!match) return null;
  if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
  // A Cloud route is always bound (the worker authenticated it before the body cap); belt and braces.
  if (!boundCustomer(request)) throw new HTTPError(404, "not_found");
  const session = await identity.customer(request);
  if (!session) throw new HTTPError(401, "unauthorized");
  const account = { id: session.user.id };
  const parsed = bodySchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const body = parsed.data as { bind?: string; kind?: "browser" | "desktop" };
  const homeId = match[1];
  const now = identity.now();
  const stepped = await stepUpAt(request, env, identity, session, now);
  const steppedAt = stepped.at;

  // The account budget counts every mint, whatever the home: it reveals nothing about any home.
  const perAccount = await takeLimit(env, account.id, "door_account", now);
  if (!perAccount.ok) return rateLimited(perAccount.retryAfterSeconds);
  const home = await env.DB.prepare(HOME_SQL).bind(homeId).first<DoorHome>();
  // Somebody else's home and no home are the same answer.
  if (!home || home.owner_id !== account.id) throw new HTTPError(404, "not_found");
  // Counted only for the owner, so a stranger cannot spend the owner's home budget.
  const perHome = await takeLimit(env, homeId, "door_home", now);
  if (!perHome.ok) return rateLimited(perHome.retryAfterSeconds);
  if (!ready(home)) throw new HTTPError(409, "home_not_ready");

  // The 4B mint table.
  const v2 = home.door_version === "v2";
  if (v2 && body.bind === undefined) {
    console.log(JSON.stringify({ message: "door body required", homeId, requestId }));
    throw new HTTPError(400, "door_body_required");
  }
  if (!v2 && (doorV2Required(env) || body.kind === "desktop")) throw new HTTPError(409, "door_needs_update");
  const kind = v2 ? body.kind! : null;
  const bind = v2 ? body.bind! : "";
  // r4.2: a desktop ticket for a home that has had a full-scope device carries a reserved pair hold, or is not minted.
  const known = kind === "desktop" ? await desktopHistory(env, homeId, { id: account.id, email: session.user.email }, dependencies) : null;
  const history: DesktopHistory | null = known?.history ?? null;
  await dependencies.afterRead?.();

  // The final check: the home is still exactly the one read above (owner, generation, state, ready endpoint at that hostname, its door). A
  // change in between: 404 or 409. No notice is owed here: only a handed-out ticket owes one (handOutDoorTicket).
  const current = await env.DB.prepare(HOME_SQL).bind(homeId).first<DoorHome>();
  if (!current || current.owner_id !== account.id) throw new HTTPError(404, "not_found");
  if (!same(home, current)) throw new HTTPError(409, "home_not_ready");
  // An emailed approval is bound to the home's generation and state (step-up-email.ts targetSpec "door"): still this request's, still valid.
  if (stepUpProof(request) && !await stepUpProofValid(request)) throw new HTTPError(403, "step_up_required");

  // The same origin GET /v1/homes returns (homes.ts), from the stored hostname only.
  const publicOrigin = `https://${home.hostname}`;
  // The home refuses a stepUpAt older than issuedAt - 900 s (v2) or - 300 s (v1): never mint one it would refuse.
  const windowMs = v2 ? DOOR_STEP_UP_MAX_AGE_MS : DOOR_V1_STEP_UP_MAX_AGE_MS;
  let reservedWith: string | null = null;
  // The ticket is stamped HERE, after every await above; only the hold's reservation (desktop) and the signature are awaited after it.
  const mint = async (): Promise<DoorTicket> => {
    const issuedAt = identity.now();
    if (issuedAt - steppedAt > windowMs) throw new HTTPError(403, "step_up_required");
    const nonce = newNonce();
    const expiresAt = issuedAt + DOOR_TICKET_TTL_MS;
    const common = { homeId, generation: home.generation, publicOrigin, account: account.id, nonce, stepUpAt: steppedAt, issuedAt, expiresAt };
    let claims: DoorClaims;
    if (!v2) claims = { type: "murage-door-v1", ...common };
    else {
      let pairHold: string | null = null;
      if (history === "had" || history === "unknown") {
        // r4.1: RESERVED for this ticket (never spent here); lapses at expiry + skew. Taken by another ticket, or none: no claim, and for a
        // home that had a full-scope device 409. Unknown history with no ready hold: minted without a claim (the home decides).
        pairHold = await reservePairHold(noticeDb(env), homeId, home.generation, bind, nonce, expiresAt + CLOCK_SKEW_SECONDS * 1000, issuedAt, reservedWith,
          known?.consumed ?? []);
        if (pairHold) reservedWith = nonce;
        else if (history === "had") throw await needsHold(env, homeId, home.generation);
      }
      // §4.1: a browser ticket for a home advertising the owner factor carries proof of this sign-in's second step —
      // amr|granted|intent collapse to "email", a trusted authenticator stays "factor". Desktop tickets never carry it.
      const proof: "email" | "factor" | undefined = home.door_proof === 1 && kind === "browser" ? (stepped.proof === "factor" ? "factor" : "email") : undefined;
      claims = { type: "murage-door-v2", ...common, bind, kind: kind!, ...(pairHold ? { pairHold } : {}), ...(proof ? { proof } : {}) };
    }
    try { return { claims, envelope: await signPayload(env, claims) }; }
    catch {
      console.error(JSON.stringify({ message: "door signer unavailable", requestId }));
      throw new HTTPError(503, "door_unavailable");
    }
  };
  const fresh = (t: { claims: DoorClaims }) => t.claims.expiresAt - identity.now() >= DOOR_TICKET_MIN_REMAINING_MS;
  const handout: DoorHandout = { ticket: await mint(), reminted: false, mint, fresh, afterSign: dependencies.afterSign, requestId, publicOrigin,
    owe: { db: noticeDb(env), env, dependencies, accountId: account.id, homeId, sessionId: session.supabase.sessionId, bind, home, now: identity.now,
      live: () => identity.supabaseUser(request, env) } };
  await dependencies.afterSign?.(0);
  await keepFresh(handout);

  // Never the ticket, its nonce, the bind or the URL.
  console.log(JSON.stringify({ message: "door ticket minted", homeId, account: account.id, requestId, door: v2 ? "v2" : "v1",
    kind: kind ?? "browser", proof: stepped.proof }));
  handouts.set(request, handout);
  // The route's answer is a placeholder that never carries the ticket: the worker's last step (handOutDoorTicket) builds the real answer.
  // A claimed step-up intent is finalized on THIS answer (recordOutcome: 200 with code door_handing_out), so its record says "handing
  // out", not "delivered", until the hand-out has succeeded (Astra DOORMINT-5).
  return json({ error: DOOR_HANDING_OUT });
}

/** The response code a door step-up intent is finalized with while its ticket is being handed out (recordOutcome records it as
 *  response_status 200, response_code door_handing_out). Cleared (delivered/200) only after a successful hand-out, beside its notice's
 *  first attempt (confirmHandout); a hand-out refused after it is recorded as that refusal (index.ts). An intent left handing out (the
 *  refusal could not be recorded, or the worker died) is replayed as a recorded refusal (retry step_up, a fresh intent), never 410. */
export const DOOR_HANDING_OUT = "door_handing_out";

interface DoorTicket { claims: DoorClaims; envelope: { payload: string; signature: string } }
interface DoorHandout {
  ticket: DoorTicket; reminted: boolean; mint: () => Promise<DoorTicket>; fresh: (t: DoorTicket) => boolean;
  afterSign?: DoorDependencies["afterSign"]; requestId: string; publicOrigin: string;
  /** What the hand-out needs to owe (and attempt) the notice of its (account, home, Supabase session, bind). */
  owe: { db: D1Database; env: Env; dependencies: DoorDependencies; accountId: string; homeId: string; sessionId: string; bind: string;
    home: DoorHome; now: () => number; live: () => Promise<CurrentSupabaseUser> };
}
/** The minted ticket of each door request, until the worker hands its answer out (handOutDoorTicket). */
const handouts = new WeakMap<Request, DoorHandout>();

const ticketResponse = (h: DoorHandout) =>
  json({ url: `${h.publicOrigin}/enter#t=${h.ticket.envelope.payload}.${h.ticket.envelope.signature}`, expiresIn: DOOR_TICKET_TTL_MS / 1000 });

const tooSlow = (h: DoorHandout) => {
  console.error(JSON.stringify({ message: "door ticket too slow", requestId: h.requestId }));
  return new HTTPError(503, "door_unavailable");
};

/** At least 55 s left, or minted once more (once per request in all), or 503 door_unavailable. */
async function keepFresh(h: DoorHandout): Promise<void> {
  if (h.fresh(h.ticket)) return;
  if (!h.reminted) {
    // A slow signature: mint once more, never hand out a ticket with less than 55 s left.
    h.reminted = true;
    h.ticket = await h.mint();
    await h.afterSign?.(1);
    if (h.fresh(h.ticket)) return;
  }
  throw tooSlow(h);
}

/** The worker's LAST step for a door answer, after the step-up intent's finalization (recordOutcome) and every other await. The notice is
 *  ARMED first (stageNotice: ONE write that rechecks the home, 404/409 when it changed meanwhile, 503 door_unavailable when it cannot be
 *  written): that write is the control plane's commitment to hand the ticket out, so the notice is owed from it on, whatever happens to
 *  the later confirmation (Astra DOORMINT-7). Only THEN the 55 s check, the last thing before the answer (Astra DOORMINT-5: a slow write
 *  is inside the check). A stale ticket is minted once more (once per request in all) and armed again (idempotent: one row per (account,
 *  home, session, bind)), else 503 door_unavailable. A refusal BEFORE the arming write writes nothing; one after it (too slow twice, the
 *  re-mint's recheck) takes back what this hand-out armed while nobody else has touched the row since (withdrawNotice), else the notice
 *  stays owed and this hand-out makes its first attempt. A ticket handed out records its step-up intent delivered and makes the notice's
 *  first attempt beside the answer (confirmHandout), the two independent. Any other answer, or a request that minted nothing, passes
 *  through unchanged. `intentId`: the step-up intent this request claimed, if any. */
export async function handOutDoorTicket(request: Request, answered: Response, intentId?: string): Promise<Response> {
  const h = handouts.get(request);
  if (!h) return answered;
  handouts.delete(request);
  if (answered.status !== 200) return answered;
  let staged: Staged | null = null;
  try {
    for (;;) {
      staged = await stageNotice(h, staged);
      // THE final check: nothing is awaited between it and the answer.
      if (h.fresh(h.ticket)) break;
      if (h.reminted) throw tooSlow(h);
      // A slow finalization or a slow notice write: mint once more, then arm again and check again.
      h.reminted = true;
      h.ticket = await h.mint();
      await h.afterSign?.(1);
    }
  } catch (e) {
    if (staged?.claim != null && !await withdrawNotice(h, staged)) background(h, firstAttempt(h));
    throw e;
  }
  const res = new Response(ticketResponse(h).body, answered);
  background(h, confirmHandout(h, intentId, staged?.claim ?? null));
  return res;
}

const background = (h: DoorHandout, work: Promise<unknown>) => {
  if (h.owe.dependencies.waitUntil) h.owe.dependencies.waitUntil(work); else void work;
};

/** What this request's arming writes left: `seq`, the row's hand-out count after this request's latest write (a later write by anyone
 *  else changes it); `armedSeq`, the count at which THIS request armed the row (armed 0 -> 1, or inserted it: 1), else null (it was
 *  already armed by another hand-out, which owns its first attempt); `claim`, the next_attempt_at this request's arming set (the row is
 *  due at once: the first attempt's claim takes it), null when it did not arm it; `foreign`, another hand-out wrote the row between two of
 *  this request's writes (its count moved by more than this request's own +1; sticky): this request then never takes its arming back
 *  (Astra DOORMINT-8). */
interface Staged { seq: number; armedSeq: number | null; claim: number | null; foreign: boolean }

/** The hand-out's ARMING write: ONE batch that writes the row of (account, home, Supabase session, bind) only while the home is still the
 *  one the ticket names (owner, generation, state, ready endpoint at that hostname) and re-reads it; a change is 404/409 and writes
 *  nothing, a failed batch 503 and writes nothing. An unsent row is armed (armed=1) and its hand-out count bumped; a row this write arms
 *  (new, or unarmed) is due at once (next_attempt_at = now). A sent row is left alone: the same session and key never owe a second notice. */
async function stageNotice(h: DoorHandout, prior: Staged | null): Promise<Staged | null> {
  const { db, accountId, homeId, sessionId, bind, home } = h.owe;
  const now = h.owe.now();
  const due = Date.now();
  let results: D1Result[];
  try {
    results = await db.batch([
      db.prepare(`INSERT INTO cloud_door_notices (account_id,home_id,session_id,bind,created_at,sent_at,attempts,next_attempt_at,armed,handouts,armed_by)
        SELECT ?,?,?,?,?,NULL,0,?,1,1,1 WHERE EXISTS (SELECT 1 FROM cloud_homes h JOIN machine_endpoints e ON e.machine_id=h.id
          WHERE h.id=? AND h.owner_id=? AND h.generation=? AND h.desired_state=? AND e.status='ready' AND e.hostname=?
            AND e.tunnel_id IS NOT NULL AND e.dns_record_id IS NOT NULL)
        ON CONFLICT (account_id,home_id,session_id,bind) DO UPDATE SET handouts=handouts+1,
          armed_by=CASE WHEN armed=0 THEN handouts+1 ELSE armed_by END,
          next_attempt_at=CASE WHEN armed=0 THEN excluded.next_attempt_at ELSE next_attempt_at END,
          claim_id=CASE WHEN armed=0 THEN NULL ELSE claim_id END,
          armed=1
        WHERE sent_at IS NULL
        RETURNING handouts, armed_by, next_attempt_at`)
        .bind(accountId, homeId, sessionId, bind, now, due, homeId, accountId, home.generation, home.desired_state, home.hostname),
      db.prepare(HOME_SQL).bind(homeId),
    ]);
  } catch {
    console.error(JSON.stringify({ message: "door notice could not be armed", requestId: h.requestId }));
    throw new HTTPError(503, "door_unavailable");
  }
  const [owed, again] = results;
  const current = again.results[0] as DoorHome | undefined;
  if (!current || current.owner_id !== accountId) throw new HTTPError(404, "not_found");
  if (!same(home, current)) throw new HTTPError(409, "home_not_ready");
  const row = owed.results[0] as { handouts: number; armed_by: number | null; next_attempt_at: number } | undefined;
  if (!row) return prior;
  const mine = row.armed_by === row.handouts;
  // This request's write added exactly 1: any other step since its previous write means another hand-out touched the row.
  const foreign = prior !== null && (prior.foreign || row.handouts !== prior.seq + 1);
  return { seq: row.handouts, armedSeq: prior?.armedSeq ?? (mine ? row.handouts : null), claim: prior?.claim ?? (mine ? row.next_attempt_at : null),
    foreign };
}

/** A hand-out refused AFTER its arming write takes back what it armed: only while the row is exactly as this request's LAST write left it
 *  (that count, its own arming, its due time, unsent, not claimed by a sender) and no other hand-out wrote it between this request's writes
 *  (`foreign`). The row is unarmed again (never sent; armed by the next hand-out, or tidied by the sweep after a day). True when taken
 *  back; false (nothing matched, or the write failed) leaves the notice owed. */
async function withdrawNotice(h: DoorHandout, s: Staged): Promise<boolean> {
  const { db, accountId, homeId, sessionId, bind } = h.owe;
  if (s.foreign) return false;
  try {
    const r = await db.prepare(`UPDATE cloud_door_notices SET armed=0
      WHERE account_id=? AND home_id=? AND session_id=? AND bind=? AND handouts=? AND armed_by=? AND armed=1 AND sent_at IS NULL
        AND next_attempt_at=? AND claim_id IS NULL`)
      .bind(accountId, homeId, sessionId, bind, s.seq, s.armedSeq, s.claim).run();
    return r.meta.changes === 1;
  } catch {
    console.error(JSON.stringify({ message: "door notice could not be withdrawn", requestId: h.requestId }));
    return false;
  }
}

/** The owed notices' first paced send for (account, home) (sendOwedNotices), with the member's own record of Supabase's current address. */
const firstAttempt = (h: DoorHandout) =>
  sendOwedNotices(h.owe.db, h.owe.env, h.owe.dependencies, h.owe.accountId, h.owe.homeId, () => h.owe.live());

/** Beside a handed-out answer: the step-up intent this request claimed is recorded delivered/200 (its door_handing_out code cleared), and,
 *  INDEPENDENTLY, the first attempt of the notice this hand-out armed. A failed record leaves the intent handing out (its replay: step_up)
 *  and never touches the notice, which the arming write already owes. */
async function confirmHandout(h: DoorHandout, intentId: string | undefined, claim: number | null): Promise<void> {
  if (intentId) {
    try {
      await h.owe.db.prepare(`UPDATE cloud_stepup_intents SET response_code=NULL
        WHERE id=? AND state='done' AND response_status=200 AND response_code=?`).bind(intentId, DOOR_HANDING_OUT).run();
    } catch {
      console.error(JSON.stringify({ message: "door hand-out could not be confirmed", requestId: h.requestId }));
    }
  }
  // This hand-out's ticket was answered: the notice may say the link was given (independent of the intent's record; a failed write
  // leaves the attempt wording, which is true either way).
  try {
    await h.owe.db.prepare("UPDATE cloud_door_notices SET delivered=1 WHERE account_id=? AND home_id=? AND session_id=? AND bind=? AND sent_at IS NULL")
      .bind(h.owe.accountId, h.owe.homeId, h.owe.sessionId, h.owe.bind).run();
  } catch {
    console.error(JSON.stringify({ message: "door notice delivery could not be recorded", requestId: h.requestId }));
  }
  if (claim !== null) await firstAttempt(h);
}
