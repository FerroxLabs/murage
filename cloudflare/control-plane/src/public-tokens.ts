// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP7: the single-use public link (`#selector.secret`). Plan 5.3(2) and (2a); support design 4.5 "M2b link".
//
// One technique for every no-login link (confirm, "This wasn't me", clarify, the 312k hold link):
//   - the link carries `#selector.secret` in the URL fragment only; the site POSTs it; a GET never reaches this module;
//   - the secret is 32 fresh random bytes and is never stored; the row holds the public selector (UNIQUE) and a
//     domain-separated HMAC-SHA256 over the secret and the whole binding (purpose, action, classification_rev, subject, account,
//     account email, Supabase updated_at, received/issued/expiry times). This is `codeHash` of trusted-factors.ts with more fields;
//   - lookup is by selector; the HMAC is recomputed from the presented secret and the ROW's binding and compared in constant time;
//   - a reissue replaces selector and HMAC together, so the previous pair no longer exists; a used link is never reissued;
//   - lifetime: expires_at = min(issued + 7 days, received + 14 days); nothing is issued at or after received + 14 days;
//   - redeem order: shape -> selector -> HMAC + purpose/action -> used -> expired -> identity reader (email AND updated_at unchanged)
//     -> ONE batch: conditional consume (used_at IS NULL AND expires_at > now AND same hmac/email/email_gen) plus the caller's own
//     writes, conditioned on this redeem's op id. Any refusal writes nothing and leaves the link unconsumed.
// Callers (WP8 cancellation, WP9 notices, WP10 clarify): verifyToken -> decide -> commitToken(extra writes in the same batch, under the
// home lease via `lease`), or redeemToken for both at once. Copy rendered to the customer comes from the committed state, not from here.
import { DB_NOW, fencedBatch, q, type HomeLease, type Q } from "./billing-lease";

export const TOKEN_PURPOSES = ["confirm", "repudiate", "clarify"] as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];
export type ClarifyAction = "withdraw_now" | "cancel_at_end";
export type SubjectKind = "notice" | "cancellation";

export const LINK_TTL_MS = 7 * 86_400_000;
/** The refund deadline: nothing is valid past received + 14 days. */
export const RECEIPT_CAP_MS = 14 * 86_400_000;
export const READER_TIMEOUT_MS = 8_000;
/** How long the sweep keeps a link row (its selector for /new-link, and the used tombstone that stops a reissue) after the later of its
 *  expiry and its subject's cap (cap_at). */
export const SWEEP_GRACE_MS = 30 * 86_400_000;
/** The window of the lifetime resend counters (`nlt:` buckets, public-routes.ts): longer than any subject's reissue lifetime (a notice's 14
 *  days, a cancellation hold's cap), so "three in all" never resets while the subject can still get a link. The sweep keeps those buckets this long. */
export const RESEND_TOTAL_WINDOW_MS = 400 * 86_400_000;
const LABEL = "murage/public-token/v1";
const SELECTOR_RE = /^[A-Za-z0-9_-]{22}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const DUMMY_HMAC = "0".repeat(64);

/** What the identity reader (cloudflare/identity-reader) answers: the account's CURRENT Supabase email and updated_at. */
export interface IdentityRead { id: string; email: string; updatedAt: string }
export interface IdentityReader { emailGen(userId: string): Promise<IdentityRead> }
export interface TokenDeps { now?: () => number; reader?: IdentityReader | null; readerTimeoutMs?: number }

export interface TokenBinding {
  purpose: TokenPurpose;
  /** clarify only (the button); undefined for confirm and repudiate. */
  action?: ClarifyAction;
  /** The notice's classification revision; required for clarify, bound in for the others when given. */
  classificationRev?: number;
  subjectKind: SubjectKind;
  subjectId: string;
  /** The Supabase user id. */
  accountId: string;
  accountEmail: string;
  /** That user's Supabase updated_at when the link was issued (the "email generation"). */
  supabaseUpdatedAt: string;
  /** When the notice or request was received (ms): caps the lifetime. */
  receivedAt: number;
  /** The last moment (ms) this link may be valid, replacing the withdrawal cap received + 14 days. Cancellation subjects only: the 312k
   *  "This wasn't me" hold link passes the cancellation's hold_until. The 7-days-from-issue limit still applies to every issue. */
  capAt?: number;
}
export interface IssuedToken { token: string; selector: string; secret: string; expiresAt: number }
export interface TokenRow {
  selector: string; subjectKind: SubjectKind; subjectId: string; purpose: TokenPurpose; action: "" | ClarifyAction;
  classificationRev: number | null; accountId: string; email: string; emailGen: string; receivedAt: number; issuedAt: number;
  expiresAt: number; hmac: string; usedAt: number | null;
}
export type Refusal =
  | { ok: false; code: "link_invalid" | "link_expired" | "identity_changed" | "identity_unavailable" }
  /** A genuine link (HMAC verified) past its expiry; `row` lets a package handle the press (WP8: open the case, send a fresh link). */
  | { ok: false; code: "link_expired"; row: TokenRow }
  /** The link is genuine (HMAC verified) but already consumed; `row` lets the caller render the committed state. */
  | { ok: false; code: "link_used"; row: TokenRow };
export interface Verified {
  ok: true; row: TokenRow; identity: IdentityRead; opId: string;
  /** When the checks ran (before the identity read). Never used to decide the commit: see commitToken. */
  now: number;
  /** An injected clock (tests only). Absent in production, where commitToken uses the database's own time. */
  clock?: () => number;
}

const clock = (d: TokenDeps) => (d.now ?? Date.now)();

// --- primitives -------------------------------------------------------------------------------------------------------------------

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}
/** The one comparison for HMAC values: the runtime's timing-safe primitive (crypto.subtle.timingSafeEqual), never string equality or a
 *  hand-written loop the JIT could shortcut. Lengths are public (an HMAC is always 64 hex); on a length mismatch the same work is done
 *  against itself and the answer is false. */
/** workerd's SubtleCrypto extension (the generated lib types do not declare it). */
type TimingSafeSubtle = SubtleCrypto & { timingSafeEqual(a: ArrayBufferView | ArrayBuffer, b: ArrayBufferView | ArrayBuffer): boolean };
export function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  const sameLength = x.byteLength === y.byteLength;
  if (x.byteLength === 0) return sameLength;
  const same = (crypto.subtle as TimingSafeSubtle).timingSafeEqual(x, sameLength ? y : x);
  return sameLength && same;
}
const randomB64u = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");

type Binding = Pick<TokenRow, "purpose" | "action" | "classificationRev" | "subjectKind" | "subjectId" | "accountId" | "email" | "emailGen" | "receivedAt" | "issuedAt" | "expiresAt">;
/** HMAC over the secret and the full binding. JSON array encoding: no field can bleed into the next. */
const tokenHmac = (env: Env, secret: string, b: Binding) =>
  hmacHex(env.BETTER_AUTH_SECRET, JSON.stringify([LABEL, secret, b.purpose, b.action, b.classificationRev, b.subjectKind, b.subjectId, b.accountId, b.email, b.emailGen, b.receivedAt, b.issuedAt, b.expiresAt]));

interface DbRow { selector: string; subject_kind: SubjectKind; subject_id: string; purpose: TokenPurpose; action: "" | ClarifyAction; classification_rev: number | null; account_id: string; email: string; email_gen: string; received_at: number; issued_at: number; expires_at: number; hmac: string; used_at: number | null }
const toRow = (r: DbRow): TokenRow => ({ selector: r.selector, subjectKind: r.subject_kind, subjectId: r.subject_id, purpose: r.purpose, action: r.action,
  classificationRev: r.classification_rev, accountId: r.account_id, email: r.email, emailGen: r.email_gen, receivedAt: r.received_at, issuedAt: r.issued_at,
  expiresAt: r.expires_at, hmac: r.hmac, usedAt: r.used_at });
async function loadRow(env: Env, selector: string): Promise<TokenRow | null> {
  if (!SELECTOR_RE.test(selector)) return null;
  const r = await env.DB.prepare("SELECT selector,subject_kind,subject_id,purpose,action,classification_rev,account_id,email,email_gen,received_at,issued_at,expires_at,hmac,used_at FROM verify_tokens WHERE selector=?")
    .bind(selector).first<DbRow>();
  return r ? toRow(r) : null;
}

/** The reader as seen from the control plane: the service binding, or a test double. Never a key. */
export function readerOf(env: Env, deps: TokenDeps): IdentityReader | null {
  return deps.reader !== undefined ? deps.reader : (env as unknown as { IDENTITY_READER?: IdentityReader }).IDENTITY_READER ?? null;
}
/** null on ANY failure: error, timeout, no binding, a different user id, an empty email or updated_at. */
async function readIdentity(env: Env, deps: TokenDeps, userId: string): Promise<IdentityRead | null> {
  const reader = readerOf(env, deps);
  if (!reader) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), deps.readerTimeoutMs ?? READER_TIMEOUT_MS); });
    const r = await Promise.race([reader.emailGen(userId), timeout]);
    if (!r || typeof r.id !== "string" || typeof r.email !== "string" || typeof r.updatedAt !== "string") return null;
    if (r.id.toLowerCase() !== userId.toLowerCase() || !r.email.trim() || !r.updatedAt) return null;
    return { id: r.id, email: r.email.trim().toLowerCase(), updatedAt: r.updatedAt };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- issue ------------------------------------------------------------------------------------------------------------------------

/** Issues (or reissues) the link for this subject, purpose and button. Returns null when the cap (capAt, default received + 14 days) has passed or the link was already
 *  used (a used link is never reissued). The returned `token` is shown once, in the email; only its HMAC is kept. Throws on a malformed binding. */
export interface IssueOptions {
  /** Cancellation hold links only (WP8 r2): valid through capAt itself, without the 7-days-from-issue limit. The subject's own state decides
   *  whether the link still acts (a hold is possible only while the cancellation is open and before its hold_until). */
  throughCap?: boolean;
  /** Issue only if this condition holds at the write (an `EXISTS (...)` text and its binds): WP8 r2 issues a hold link only while its mail
   *  delivery is still claimed by the caller, so a sender whose claim lapsed never replaces the link another sender delivered. */
  when?: Q;
}
export async function issueToken(env: Env, deps: TokenDeps, b: TokenBinding, opts: IssueOptions = {}): Promise<IssuedToken | null> {
  const p = await prepareToken(env, deps, b, opts);
  if (!p) return null;
  const r = await env.DB.prepare(p.write[0]).bind(...(p.write[1] ?? [])).run();
  if (r.meta.changes !== 1) return null;
  return p.issued;
}

/** WP10 r4-1: the link and the ONE statement that stores it, without writing anything. The caller runs the statement in its own batch (for
 *  instance together with the mail that carries the link, under that mail's claim), so a link exists only if the mail holding it was stored.
 *  null: past the link cap (nothing can be issued any more). */
export async function prepareToken(env: Env, deps: TokenDeps, b: TokenBinding, opts: IssueOptions = {}): Promise<{ issued: IssuedToken; write: Q } | null> {
  if (!TOKEN_PURPOSES.includes(b.purpose)) throw new Error("invalid_binding");
  if (b.purpose === "clarify" ? (b.action !== "withdraw_now" && b.action !== "cancel_at_end") || !Number.isInteger(b.classificationRev) : b.action !== undefined) throw new Error("invalid_binding");
  if (b.classificationRev !== undefined && !Number.isInteger(b.classificationRev)) throw new Error("invalid_binding");
  const email = b.accountEmail.trim().toLowerCase();
  if (!b.subjectId || !b.accountId || !email || !b.supabaseUpdatedAt || !Number.isFinite(b.receivedAt)) throw new Error("invalid_binding");
  if (b.capAt !== undefined && (b.subjectKind !== "cancellation" || !Number.isFinite(b.capAt))) throw new Error("invalid_binding");
  const now = clock(deps);
  if (opts.throughCap && (b.subjectKind !== "cancellation" || b.capAt === undefined)) throw new Error("invalid_binding");
  const expiresAt = opts.throughCap ? b.capAt! : Math.min(now + LINK_TTL_MS, b.capAt ?? b.receivedAt + RECEIPT_CAP_MS);
  if (expiresAt <= now) return null;
  const selector = randomB64u(16);
  const secret = randomB64u(32);
  const row: Binding = { purpose: b.purpose, action: b.action ?? "", classificationRev: b.classificationRev ?? null, subjectKind: b.subjectKind, subjectId: b.subjectId,
    accountId: b.accountId, email, emailGen: b.supabaseUpdatedAt, receivedAt: b.receivedAt, issuedAt: now, expiresAt };
  const hmac = await tokenHmac(env, secret, row);
  // WP10 r3-1: a link bound to an older classification revision never replaces one bound to a newer revision (a delayed reissue is a no-op).
  // cap_at (cancellation hold links) is kept on the row so the sweep retains the selector and the used tombstone until the subject's own cap
  // has passed: before that, /new-link must still resolve the selector and a used subject must never be issued again.
  const write = q(`INSERT INTO verify_tokens (selector,subject_kind,subject_id,purpose,action,classification_rev,account_id,email,email_gen,received_at,issued_at,expires_at,hmac,cap_at)
    ${opts.when ? `SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${opts.when[0]}` : "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"}
    ON CONFLICT(subject_kind,subject_id,purpose,action) DO UPDATE SET selector=excluded.selector, classification_rev=excluded.classification_rev, account_id=excluded.account_id,
      email=excluded.email, email_gen=excluded.email_gen, received_at=excluded.received_at, issued_at=excluded.issued_at, expires_at=excluded.expires_at, hmac=excluded.hmac,
      cap_at=MAX(COALESCE(verify_tokens.cap_at, excluded.cap_at), COALESCE(excluded.cap_at, verify_tokens.cap_at))
    WHERE verify_tokens.used_at IS NULL
      AND (verify_tokens.classification_rev IS NULL OR excluded.classification_rev IS NULL OR excluded.classification_rev>=verify_tokens.classification_rev)`,
    selector, row.subjectKind, row.subjectId, row.purpose, row.action, row.classificationRev, row.accountId, row.email, row.emailGen, row.receivedAt, row.issuedAt, row.expiresAt, hmac, b.capAt ?? null, ...(opts.when?.[1] ?? []));
  return { issued: { token: `${selector}.${secret}`, selector, secret, expiresAt }, write };
}

// --- read-only look (landing page, lookup) -----------------------------------------------------------------------------------------

async function genuine(env: Env, selector: string, secret: string): Promise<TokenRow | null> {
  const row = await loadRow(env, selector);
  const shaped = SECRET_RE.test(secret);
  // Always compute one HMAC, so a missing selector costs the same as a wrong secret.
  const expected = await tokenHmac(env, shaped ? secret : "-", row ?? { purpose: "confirm", action: "", classificationRev: null, subjectKind: "notice", subjectId: "-", accountId: "-",
    email: "-", emailGen: "-", receivedAt: 0, issuedAt: 0, expiresAt: 0 });
  const same = constantTimeEqual(expected, row?.hmac ?? DUMMY_HMAC);
  return row && shaped && same ? row : null;
}
export type Peek = { state: "refused" } | { state: "open" | "expired" | "used"; row: TokenRow };
/** Read-only: changes nothing, never consumes, never calls the identity reader. `refused`: unknown selector or wrong secret (identical answer). */
export async function peekToken(env: Env, deps: TokenDeps, selector: string, secret: string): Promise<Peek> {
  const row = await genuine(env, selector, secret);
  if (!row) return { state: "refused" };
  if (row.usedAt !== null) return { state: "used", row };
  return { state: clock(deps) >= row.expiresAt ? "expired" : "open", row };
}

// --- redeem -----------------------------------------------------------------------------------------------------------------------

/** All the checks, no writes. `action` is the button the request names (clarify). A token of another purpose or button is link_invalid. */
export async function verifyToken(env: Env, deps: TokenDeps, selector: string, secret: string, purpose: TokenPurpose, action?: ClarifyAction): Promise<Verified | Refusal> {
  const now = clock(deps);
  const row = await genuine(env, selector, secret);
  if (!row || row.purpose !== purpose || row.action !== (action ?? "")) return { ok: false, code: "link_invalid" };
  if (row.usedAt !== null) return { ok: false, code: "link_used", row };
  if (now >= row.expiresAt) return { ok: false, code: "link_expired", row };
  const identity = await readIdentity(env, deps, row.accountId);
  if (!identity) return { ok: false, code: "identity_unavailable" };
  if (identity.email !== row.email || identity.updatedAt !== row.emailGen) return { ok: false, code: "identity_changed" };
  // The reader can take seconds: a link that expired while it ran is expired (commitToken re-checks on the database's clock as well).
  if (clock(deps) >= row.expiresAt) return { ok: false, code: "link_expired", row };
  return { ok: true, row, identity, opId: crypto.randomUUID(), now, ...(deps.now ? { clock: deps.now } : {}) };
}

/** `AND EXISTS(...)` text for a statement that must run only if THIS redeem's consume won. Binds: selector, opId. */
export const WHEN_CONSUMED = "EXISTS (SELECT 1 FROM verify_tokens WHERE selector=? AND used_by=?)";
export const whenConsumed = (v: Pick<Verified, "row" | "opId">): [string, string, string] => [WHEN_CONSUMED, v.row.selector, v.opId];

export interface CommitOptions {
  /** Run the batch fenced by this home lease (cloud_write_guards, as `withdraw()` does). Without it: a plain atomic D1 batch. */
  lease?: HomeLease;
  /** The caller's own writes (state transition, authorization, ledger). Each must be conditioned on WHEN_CONSUMED so the loser of a race writes nothing. */
  extra?: (v: Verified) => Q[];
  /** Tests only: the clock for the expiry check and used_at. Default: the Verified's injected clock, else the DATABASE's time. */
  now?: () => number;
  /** WP10 r1-3: a condition the SUBJECT must still meet at the consume (`EXISTS (...)` text and its binds). It is part of the consume's own
   *  WHERE, so a press that loses a race with a change of the subject consumes nothing and its link stays usable for what it is still good for. */
  guard?: [string, ...unknown[]];
}
/** The serialization point: ONE batch = conditional consume + the caller's writes. won=false: someone else consumed it first, it was reissued, or it
 *  expired meanwhile. Expiry and used_at are decided by the time AT the consume, on the database's clock (one value per statement), never by the
 *  time verifyToken started: a link that expires during the identity read or the handler is refused here, and every write conditioned on
 *  WHEN_CONSUMED then affects nothing. */
export async function commitToken(env: Env, v: Verified, opts: CommitOptions = {}): Promise<{ won: boolean }> {
  const tick = opts.now ?? v.clock;
  const at = tick ? tick() : null;   // null: the database's time (production)
  const consume = q(`UPDATE verify_tokens SET used_at=COALESCE(?,${DB_NOW}), used_by=? WHERE selector=? AND hmac=? AND email=? AND email_gen=? AND used_at IS NULL
      AND expires_at>COALESCE(?,${DB_NOW})${opts.guard ? ` AND ${opts.guard[0]}` : ""}`,
    at, v.opId, v.row.selector, v.row.hmac, v.row.email, v.row.emailGen, at, ...(opts.guard ? opts.guard.slice(1) : []));
  const stmts = [consume, ...(opts.extra?.(v) ?? [])];
  const res = opts.lease ? await fencedBatch(env, opts.lease, stmts)
    : await env.DB.batch(stmts.map(([sql, binds]) => env.DB.prepare(sql).bind(...(binds ?? []))));
  return { won: res[0].meta.changes === 1 };
}

export interface RedeemInput extends CommitOptions { selector: string; secret: string; purpose: TokenPurpose; action?: ClarifyAction }
export type Redeemed = (Verified & { won: true }) | Refusal;
export async function redeemToken(env: Env, deps: TokenDeps, input: RedeemInput): Promise<Redeemed> {
  const v = await verifyToken(env, deps, input.selector, input.secret, input.purpose, input.action);
  if (!v.ok) return v;
  const { won } = await commitToken(env, v, { lease: input.lease, extra: input.extra });
  return won ? { ...v, won: true } : lostCommitRefusal(env, v);
}

/** Why a commit was lost, from the row as it is NOW, on the same clock commitToken used (the injected one in tests, else the database's):
 *  link_used only when this very link (same selector, HMAC and identity binding) is actually consumed; link_expired when it is still unused but
 *  past expires_at; link_invalid when it was replaced (reissue) or removed, or nothing else explains the loss. Callers that use commitToken
 *  directly (WP8, WP9, WP10) call this after { won: false } for the answer to render. */
export async function lostCommitRefusal(env: Env, v: Verified, opts: Pick<CommitOptions, "now"> = {}): Promise<Refusal> {
  const tick = opts.now ?? v.clock;
  const at = tick ? tick() : null;   // null: the database's time (production)
  const r = await env.DB.prepare(`SELECT selector,subject_kind,subject_id,purpose,action,classification_rev,account_id,email,email_gen,received_at,issued_at,
      expires_at,hmac,used_at, (expires_at > COALESCE(?,${DB_NOW})) AS live
    FROM verify_tokens WHERE selector=? AND hmac=? AND email=? AND email_gen=?`)
    .bind(at, v.row.selector, v.row.hmac, v.row.email, v.row.emailGen).first<DbRow & { live: number }>();
  if (!r) return { ok: false, code: "link_invalid" };
  if (r.used_at !== null) return { ok: false, code: "link_used", row: toRow(r) };
  if (!r.live) return { ok: false, code: "link_expired" };
  return { ok: false, code: "link_invalid" };
}

/** The link is still there and unused (a lost commit that was refused by its `guard`, not by the token). */
export async function stillUnused(env: Env, v: Pick<Verified, "row">): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 AS x FROM verify_tokens WHERE selector=? AND hmac=? AND used_at IS NULL").bind(v.row.selector, v.row.hmac).first()) !== null;
}

// --- mail and request limits ------------------------------------------------------------------------------------------------------

export interface MailLimits { perRecipient: number; global: number; windowMs?: number }
export const MAIL_LIMITS: MailLimits = { perRecipient: 3, global: 300, windowMs: 3_600_000 };

/** Takes one slot of a fixed-window counter in ONE conditional upsert. false: the window is full. */
export async function takeSlot(env: Env, bucket: string, limit: number, windowMs: number, now: number): Promise<boolean> {
  const row = await env.DB.prepare(`INSERT INTO public_mail_limits (bucket,window_start,count) VALUES (?,?,1)
    ON CONFLICT(bucket) DO UPDATE SET
      count = CASE WHEN ? - window_start >= ? THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END
    WHERE ? - public_mail_limits.window_start >= ? OR public_mail_limits.count < ?
    RETURNING count`).bind(bucket, now, now, windowMs, now, windowMs, now, now, windowMs, limit).first<{ count: number }>();
  return row !== null;
}

export interface Slot { bucket: string; limit: number; windowMs: number }
const FULL = /CHECK constraint failed/i;
/** Takes one slot in EVERY bucket, or in none: ONE D1 batch (one transaction). Each bucket first gets a guard row in cloud_write_guards
 *  (CHECK ok=1) that is 0 when that window is full, which aborts the whole batch, so a refusal writes nothing and there is no give-back
 *  path that could land in a newer window. Any other error also rolls everything back, and is rethrown. false: some window is full. */
export async function takeSlots(env: Env, slots: Slot[], now: number): Promise<boolean> {
  const g = crypto.randomUUID();
  const stmts: D1PreparedStatement[] = slots.map((s, i) => env.DB.prepare(`INSERT INTO cloud_write_guards (id, ok) VALUES (?,
      (SELECT COUNT(*) = 0 FROM public_mail_limits WHERE bucket=? AND ? - window_start < ? AND count >= ?))`).bind(`${g}-${i}`, s.bucket, now, s.windowMs, s.limit));
  for (const s of slots) {
    stmts.push(env.DB.prepare(`INSERT INTO public_mail_limits (bucket,window_start,count) VALUES (?,?,1)
      ON CONFLICT(bucket) DO UPDATE SET
        count = CASE WHEN ? - window_start >= ? THEN 1 ELSE count + 1 END,
        window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END`).bind(s.bucket, now, now, s.windowMs, now, s.windowMs, now));
  }
  stmts.push(env.DB.prepare("DELETE FROM cloud_write_guards WHERE id LIKE ?").bind(`${g}-%`));
  try {
    await env.DB.batch(stmts);
    return true;
  } catch (e) {
    if (FULL.test(String((e as Error)?.message ?? e)) || FULL.test(String((e as { cause?: unknown })?.cause ?? ""))) return false;
    throw e;
  }
}

/** One verification email to `recipient`: the per-recipient and the global budget, both or neither, in one transaction (takeSlots).
 *  The address is only ever hashed. Applies to first sends, reminders and replacements alike (plan 5.3(2)). */
export async function reserveMail(env: Env, deps: TokenDeps, recipient: string, limits: MailLimits = MAIL_LIMITS): Promise<boolean> {
  const now = clock(deps);
  const w = limits.windowMs ?? 3_600_000;
  const rb = `mr:${(await hmacHex(env.BETTER_AUTH_SECRET, `${LABEL}/mail:${recipient.trim().toLowerCase()}`)).slice(0, 32)}`;
  return takeSlots(env, [{ bucket: rb, limit: limits.perRecipient, windowMs: w }, { bucket: "mg", limit: limits.global, windowMs: w }], now);
}

/** Cron: links 30 days past BOTH their expiry and their subject's cap (cap_at, cancellation hold links; a notice's received + 14 days is always
 *  within its last expiry + 30 days), and counters older than their window (14 days; the lifetime resend counters RESEND_TOTAL_WINDOW_MS). A row that still matters is never swept: until the cap
 *  has passed its selector serves /new-link and its used_at stops issueToken from issuing that subject again; after the cap nothing can be issued.
 *  A cancellation that can still need its hold (reason_pending, or a hold still open) keeps its row regardless of the cap. */
export async function sweepPublicTokens(env: Env, now: number): Promise<void> {
  await env.DB.batch([
    // A cancellation hold link's row (its selector and its consumed tombstone) stays while that cancellation can still need the hold: a
    // reason still being checked, or a hold still open (status open, hold_until not passed), whatever the cap and the grace say (Astra WP8-3 #5).
    env.DB.prepare(`DELETE FROM verify_tokens WHERE expires_at < ? AND (cap_at IS NULL OR cap_at < ?)
      AND NOT (subject_kind='cancellation' AND EXISTS (SELECT 1 FROM cancellation_requests c WHERE c.id=verify_tokens.subject_id
        AND (c.status='reason_pending' OR (c.status='open' AND (c.hold_until IS NULL OR c.hold_until > ?)))))`).bind(now - SWEEP_GRACE_MS, now - SWEEP_GRACE_MS, now),
    env.DB.prepare("DELETE FROM public_mail_limits WHERE window_start < ? AND (bucket NOT LIKE 'nlt:%' OR window_start < ?)").bind(now - RECEIPT_CAP_MS, now - RESEND_TOTAL_WINDOW_MS),
  ]);
}
