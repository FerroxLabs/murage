// SPDX-License-Identifier: AGPL-3.0-or-later
// Supabase user (token `sub`) -> control-plane account ("user".id). The control plane stays the source of truth for
// homes, billing and consent, all keyed by "user".id, so a Supabase identity only ever resolves to one of those rows:
//   - known sub: the account it created.
//   - new sub, no Cloud account holds the email: one is created, logged.
//   - new sub, another CLOUD account already holds the email: refused (409 account_email_taken), logged. NO automatic
//     linking: a verified email in a token is not proof of owning the older account (a Google address can change hands
//     and keep email_verified=true). Sean resolves by hand.
//
// A Cloud account and a phone-companion account (Better Auth email code, the desktop's managed relay) are SEPARATE
// accounts, never linked or compared by email: a member may have both with the same address, and neither sees the
// other. The "user" table backs both and Better Auth signs in by "user".email, so a Cloud account's "user".email is a
// synthetic, undeliverable address (cloudUserEmail) that no email code can reach; its real CONTACT address (receipts,
// notices, the Stripe customer email) is supabase_identities.contact_email, read through accountContactEmail. Route
// scope keeps the two apart (customer-identity.ts): Cloud routes take only the Supabase identity, companion routes only
// a Better Auth session.
//
// The contact address changes through one path only, reconcileEmail: when a token's email differs from the stored one,
// Supabase Auth itself is asked for the user's current confirmed email (GET /auth/v1/user with that token) and the
// stored email moves to THAT, by compare-and-swap on one revision that covers both the email and the conflict state
// (Astra MAKERKIT4 #3). Token timestamps are never an ordering key (Astra MAKERKIT2 #1): an older token naming a former
// address finds Supabase's current address already stored and changes nothing; two requests racing both write
// Supabase's answer, and the loser re-reads both sides. Contract: lanes/cloud-v2/makerkit/CONTRACT.md section 2.
import { HTTPError } from "./http";
import type { SupabaseClaims } from "./supabase-jwt";

export interface CloudAccount { id: string; email: string; name: string; emailVerified: boolean }
/** Supabase Auth's current view of the token's user. Throws HTTPError (401 session gone, 503 unreachable). */
export interface CurrentSupabaseUser { id: string; email: string }
export type CurrentUserLoader = () => Promise<CurrentSupabaseUser>;
type LinkKind = "created" | "refused_email_taken" | "email_updated" | "email_conflict" | "email_conflict_cleared";

interface UserRow { id: string; email: string; name: string; emailVerified: number }
interface MappedRow extends UserRow { emailConflict: string | null; revision: number }
const toAccount = (r: UserRow): CloudAccount => ({ id: r.id, email: r.email, name: r.name, emailVerified: Boolean(r.emailVerified) });
const mappedUser = (db: D1Database, sub: string) =>
  db.prepare(`SELECT u.id AS id, s.contact_email AS email, u.name AS name, 1 AS emailVerified, s.email_conflict AS emailConflict, s.email_revision AS revision
    FROM supabase_identities s JOIN "user" u ON u.id = s.user_id WHERE s.sub=?`).bind(sub).first<MappedRow>();

/** The "user".email of a Cloud account: unique, undeliverable (RFC 2606 .invalid), so it is never a Better Auth login. */
export const cloudUserEmail = (userId: string) => `cloud-${userId}@cloud-account.invalid`;

/** Where to email an account: a Cloud account's contact address, else (a companion account) its "user".email. */
export async function accountContactEmail(db: D1Database, userId: string): Promise<string | null> {
  const row = await db.prepare(`SELECT COALESCE(s.contact_email, u.email) AS email FROM "user" u
    LEFT JOIN supabase_identities s ON s.user_id = u.id WHERE u.id=?`).bind(userId).first<{ email: string }>();
  return row?.email ?? null;
}

/** A request's compare-and-swap can lose to a concurrent one; after this many rounds the caller is told to retry. */
const RECONCILE_ROUNDS = 3;
/** CH1-G: an invite-gated request reads the live identity at most this many times (one admission round each) before it answers 503. */
const ADMISSION_ROUNDS = 2;

/** True while the mapping's revision is still `rev`: an address this round wrote (or read) is answered only then. */
const stillAt = async (db: D1Database, sub: string, rev: number) =>
  Boolean(await db.prepare("SELECT 1 AS ok FROM supabase_identities WHERE sub=? AND email_revision=?").bind(sub, rev).first<{ ok: number }>());

/** ITEM4-PROOF-CURRENT (astra-code3 / grok-code3 Medium): a conflict set or clear moves email_revision but not the address, so the 24 h page
 *  keeps covering the buyer. In the SAME batch as the revision bump, keyed on the identity now being at rev+1 in the state this write set
 *  (`state`, ?4 the conflict), the old revision's open credit.email_unverified_hold is resolved (as the address move does) and the old revision's
 *  auto-send marker is carried to rev+1 with its first_at KEPT and state 'skipped' (nothing is mailed), so the clock still runs from the
 *  original first_at. An account with no marker at rev gets none. */
/** Rule 14: true while the mapping of `sub` holds the win token of the batch that is running. */
const wonBy = (sub: string, win: string) => `EXISTS (SELECT 1 FROM supabase_identities WHERE sub=${sub} AND win_token=${win})`;

function carryAlertCoverage(db: D1Database, userId: string, rev: number, state: string, conflict: string | null, now: number, sub: string, win: string): D1PreparedStatement[] {
  // CH1-G rule 14: ?5 = the sub and ?6 = this batch's win token; the statements run only while this batch's own compare-and-swap stored its token.
  const atNext = `EXISTS (SELECT 1 FROM supabase_identities WHERE user_id=?1 AND email_revision=?2+1 AND ${state}) AND ${wonBy("?5", "?6")}`;
  const bind = (q: D1PreparedStatement) => q.bind(userId, rev, now, conflict, sub, win);
  return [
    // ITEM4-FIX2 section 2: ONLY the OLD revision's page (id format of sweepFluxEmailStuck), so a losing writer never resolves the winner's rev+1 page.
    // The CAST: D1 binds a JS number as REAL, and REAL text is '0.0', never the stored '0'.
    bind(db.prepare(`UPDATE cloud_alerts SET resolved_at=?3 WHERE id='alert:email_unverified_hold:'||?1||':'||CAST(?2 AS INTEGER) AND resolved_at IS NULL AND ${atNext}`)),
    bind(db.prepare(`INSERT INTO flux_email_proof_autosend (account_id,email_revision,state,tries,at,first_at)
        SELECT ?1,?2+1,'skipped',1,?3,m.first_at FROM flux_email_proof_autosend m WHERE m.account_id=?1 AND m.email_revision=?2 AND ${atNext}
      ON CONFLICT(account_id,email_revision) DO NOTHING`)),
  ];
}

/** What one reconcile round did. `miss`: nothing was written (a lost compare-and-swap, or the revision moved before it); `moved`: this round's
 *  own unit committed and the revision then moved on again (the post-commit fence, Astra DOORMINT-6). */
type Attempt = { done: CloudAccount } | "miss" | "moved";

/** CH1-G (rules 9 and 10): an identity event is part of the unit that wrote it. Its id is deterministic (sub, the revision the unit created, kind) and it
 *  is inserted ON CONFLICT DO NOTHING under a predicate that proves the resulting state, so a writer that lost the compare-and-swap to a writer that
 *  reached the same state adds no row, and a CAS miss adds none either. `state` is a SQL condition on the identity row, ?2 = sub, ?4 = the address, ?6 = revision. */
function eventInBatch(db: D1Database, sub: string, userId: string, email: string, kind: LinkKind, newRevision: number, now: number, state: string,
  win: string): D1PreparedStatement {
  // Rule 14 (the fence): ?7 is this batch's win token. The deterministic id stays as a second layer.
  return db.prepare(`INSERT INTO account_link_events (id,sub,user_id,email,kind,at)
      SELECT ?1,?2,?3,?4,'${kind}',?5 WHERE EXISTS (SELECT 1 FROM supabase_identities WHERE sub=?2 AND email_revision=?6 AND win_token=?7 AND ${state})
    ON CONFLICT(id) DO NOTHING`).bind(`${sub}:${newRevision}:${kind}`, sub, userId, email, now, newRevision, win);
}
const noted = (kind: LinkKind, sub: string, userId: string) => console.log(JSON.stringify({ message: "cloud account identity", kind, sub, userId }));

/** One reconcile round against `current` (Supabase's confirmed address, already read by the caller), for the mapping row `user` as it was read. */
async function reconcileOnce(db: D1Database, sub: string, user: MappedRow, current: CurrentSupabaseUser, now: number): Promise<Attempt> {
  const stored = user.email.toLowerCase();
  const rev = user.revision;
  if (current.email === stored) {
    // The token named a former (or not yet confirmed) address; the stored one is current. Answered only while the revision read before
    // Supabase was asked is still the stored one: a delayed answer must never override a reconciliation that landed meanwhile (a cron
    // retry reads A, a member's request moves the address to B, the reader's answer A arrives late): then both sides are read again
    // (Astra DOORMINT-5). The writes below are fenced on the same revision in their own statements.
    if (user.emailConflict === null) return (await stillAt(db, sub, rev)) ? { done: toAccount(user) } : "miss";
    // A conflict recorded earlier is over (the member changed back, or Sean resolved it), unless a newer write came first.
    const win = crypto.randomUUID();
    const cleared = await db.batch([
      db.prepare(`UPDATE supabase_identities SET email_conflict=NULL, email_revision=email_revision+1, win_token=?
        WHERE sub=? AND email_revision=?`).bind(win, sub, rev),
      ...carryAlertCoverage(db, user.id, rev, "email_conflict IS NULL", null, now, sub, win),
      eventInBatch(db, sub, user.id, stored, "email_conflict_cleared", rev + 1, now, "email_conflict IS NULL", win),
    ]).then((r) => r[0]!);
    if ((cleared.meta.changes ?? 0) === 0) return "miss";
    noted("email_conflict_cleared", sub, user.id);
    // Answered only while the clear is still the latest write: another request may have moved the address while the unit committed
    // (Astra DOORMINT-6). Otherwise both sides are read again, within the same rounds.
    return (await stillAt(db, sub, rev + 1)) ? { done: toAccount(user) } : "moved";
  }
  // Move to Supabase's address only if the revision is still the one read and no other Cloud account holds the new
  // address (companion accounts are never consulted); the conflict clears and the revision moves in the same statement.
  // The unique index on contact_email backs the NOT EXISTS against a racing writer: a violation is a lost round.
  // FLUX-ENSURE-EMAIL-VERIFIED (design-ev3 section 2): the inbox proof of the old address is cleared in THIS statement, the only clear there
  // is. The conflict set and clear below keep it (they move the revision, which already retires any code issued before them).
  // ITEM4-PROOF-CURRENT r2.1 fix 2: in the SAME batch, keyed on the identity now being at the new address and revision (the move happened),
  // the old revision's 24 h page (credit.email_unverified_hold) is resolved, and an account whose home went active (an auto-send marker
  // exists) gets the marker for the NEW revision with first_at = the move time and state 'skipped' (nothing is mailed by the move; the
  // card's "Send a new code" still works), so the new revision's 24 h clock runs from the move.
  const atNew = "EXISTS (SELECT 1 FROM supabase_identities WHERE user_id=?1 AND email_revision=?2 AND contact_email=?3)";
  const mwin = crypto.randomUUID();
  const moved = await db.batch([
    db.prepare(`UPDATE supabase_identities SET contact_email=?, email_conflict=NULL, email_revision=email_revision+1, win_token=?,
        email_verified_at=NULL, email_verified_for=NULL
      WHERE sub=? AND user_id=? AND email_revision=? AND lower(contact_email)=?
        AND NOT EXISTS (SELECT 1 FROM supabase_identities WHERE lower(contact_email)=? AND sub<>?)`)
      .bind(current.email, mwin, sub, user.id, rev, stored, current.email, sub),
    // ITEM4-FIX2 section 2: ONLY the OLD revision's page; ?2 is rev+1 here, and the parentheses matter (|| binds tighter than -). The CAST:
    // D1 binds a JS number as REAL, and REAL text is '0.0', never the stored '0'.
    db.prepare(`UPDATE cloud_alerts SET resolved_at=?4 WHERE id='alert:email_unverified_hold:'||?1||':'||CAST((?2-1) AS INTEGER) AND resolved_at IS NULL AND ${atNew} AND ${wonBy("?5", "?6")}`)
      .bind(user.id, rev + 1, current.email, now, sub, mwin),
    db.prepare(`INSERT INTO flux_email_proof_autosend (account_id,email_revision,state,tries,at,first_at) SELECT ?1,?2,'skipped',1,?4,?4
        WHERE ${atNew} AND ${wonBy("?5", "?6")} AND EXISTS (SELECT 1 FROM flux_email_proof_autosend WHERE account_id=?1)
      ON CONFLICT(account_id,email_revision) DO NOTHING`).bind(user.id, rev + 1, current.email, now, sub, mwin),
    eventInBatch(db, sub, user.id, current.email, "email_updated", rev + 1, now, "contact_email=?4", mwin),
  ]).then((r) => r[0]!).catch(() => null);
  if ((moved?.meta.changes ?? 0) > 0) {
    noted("email_updated", sub, user.id);
    // The same fence after the unit committed: a move B -> C that landed meanwhile is never answered as B (Astra DOORMINT-6).
    return (await stillAt(db, sub, rev + 1)) ? { done: { ...toAccount(user), email: current.email, emailVerified: true } } : "moved";
  }
  const again = await mappedUser(db, sub);
  if (!again) throw new HTTPError(401, "unauthorized");
  // A concurrent request wrote first (or the row changed outside this path): read both sides again.
  if (again.revision !== rev || again.email.toLowerCase() !== stored) return "miss";
  // Nothing else wrote: another Cloud account holds the member's current address. Persist the conflict (conditioned on the
  // same revision) so every request for this sub, a token naming the former address included, is refused until it
  // is resolved. Sean resolves by hand.
  const swin = crypto.randomUUID();
  const set = await db.batch([
    db.prepare(`UPDATE supabase_identities SET email_conflict=?, email_revision=email_revision+1, win_token=?
      WHERE sub=? AND email_revision=?`).bind(current.email, swin, sub, rev),
    ...carryAlertCoverage(db, user.id, rev, "email_conflict=?4", current.email, now, sub, swin),
    ...(again.emailConflict !== current.email ? [eventInBatch(db, sub, user.id, current.email, "email_conflict", rev + 1, now, "email_conflict=?4", swin)] : []),
  ]).then((r) => r[0]!);
  if ((set.meta.changes ?? 0) === 0) return "miss";
  if (again.emailConflict !== current.email) noted("email_conflict", sub, user.id);
  throw new HTTPError(409, "account_email_conflict");
}

/** The one path that changes a mapped account's contact email: to Supabase's current confirmed address, never to a
 *  token's. Also the only place an email conflict is set or cleared.
 *
 *  Every write here (email move, conflict set, conflict clear) is conditioned on the email_revision this round read and
 *  increments it, in the same statement or transaction (Astra MAKERKIT4 #3). Comparing the email value alone is not
 *  enough: an address can change away and back while a delayed request waits on Supabase, and a conflict clear must
 *  never erase a newer conflict. A lost comparison reloads the mapping AND asks Supabase again, on every branch. An address is
 *  answered only while the revision this round read (or wrote) is still the stored one, checked after the round's last await: never one a
 *  concurrent request has moved on from. */
async function reconcileEmail(db: D1Database, sub: string, row: MappedRow, now: number, currentUser: CurrentUserLoader): Promise<CloudAccount> {
  let user = row;
  for (let round = 0; round < RECONCILE_ROUNDS; round++) {
    if (round > 0) {
      const again = await mappedUser(db, sub);
      if (!again) throw new HTTPError(401, "unauthorized");
      user = again;
    }
    const current = await currentUser();
    if (current.id !== sub) throw new HTTPError(401, "unauthorized");
    const r = await reconcileOnce(db, sub, user, current, now);
    if (typeof r === "object") return r.done;
  }
  throw new HTTPError(503, "identity_unavailable");
}

/** CH1-G: Supabase's live identity as invite admission read it, and the mapping revision (null: no mapping) it was read against. */
export interface AdmittedIdentity { live: CurrentSupabaseUser; rev: number | null }

/** The mapping's current revision (null: unmapped). Read-only. */
export async function mappedRevision(db: D1Database, sub: string): Promise<number | null> {
  const r = await db.prepare("SELECT email_revision AS rev FROM supabase_identities WHERE sub=?").bind(sub).first<{ rev: number }>();
  return r ? r.rev : null;
}

/** The refusal of a subject whose address another Cloud account holds: ONE conditional insert (its own unit). The event id is deterministic (subject, holder, the
 *  holder's revision, the request's clock) and the insert runs only while this subject is still unmapped AND the holder still holds the address at the revision and win
 *  token read with it. false: nothing was written (the picture changed), so the caller reads again; the refusal is never logged outside this statement. */
async function refuseTaken(db: D1Database, sub: string, email: string, holder: { id: string; holderSub: string; rev: number; win: string | null }, now: number): Promise<boolean> {
  const r = await db.batch([
    db.prepare(`INSERT INTO account_link_events (id,sub,user_id,email,kind,at)
      SELECT ?1,?2,?3,?4,'refused_email_taken',?5
      WHERE NOT EXISTS (SELECT 1 FROM supabase_identities WHERE sub=?2)
        AND EXISTS (SELECT 1 FROM supabase_identities WHERE sub=?6 AND lower(contact_email)=?4 AND email_revision=?7 AND win_token IS ?8)
      ON CONFLICT(id) DO NOTHING`)
      .bind(`${sub}:refused:${holder.holderSub}:${holder.rev}:${now}`, sub, holder.id, email, now, holder.holderSub, holder.rev, holder.win),
  ]).then((x) => x[0]!);
  if ((r.meta.changes ?? 0) === 0) return false;
  noted("refused_email_taken", sub, holder.id);
  return true;
}
const HOLDER_SQL = "SELECT user_id AS id, sub AS holderSub, email_revision AS rev, win_token AS win FROM supabase_identities WHERE lower(contact_email)=?";

/** A first sight of an unmapped subject at `live.email`: the holder lookup, the account and the event are one batch, a compare-and-swap on the
 *  sub (and on the address): a conflict means a concurrent creator won and nothing was written.
 *  - The holder IS this subject (a concurrent request of the same subject created the account and the address between the caller's read and this
 *    lookup): nothing is written and admission runs again ("miss"); the subject is never refused against its own account.
 *  - Another subject holds the address: the refusal and its event are one unit, written only while that holder still holds the address at the revision
 *    and win token read here and this subject is still unmapped; otherwise nothing is written and admission runs again.
 *  - After the creation unit commits, the fence of the other writers applies (stillAt revision 0): a revision that moved is "moved" (terminal 503). */
async function createOnce(db: D1Database, sub: string, email: string, now: number): Promise<Attempt> {
  // Only another CLOUD account can hold the address; a companion (Better Auth) account with it is a separate account.
  const holder = await db.prepare(HOLDER_SQL).bind(email).first<{ id: string; holderSub: string; rev: number; win: string | null }>();
  if (holder) {
    if (holder.holderSub === sub) return "miss";
    if (!(await refuseTaken(db, sub, email, holder, now))) return "miss";
    throw new HTTPError(409, "account_email_taken");
  }
  const id = crypto.randomUUID();
  const at = new Date(now).toISOString();
  const win = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare('INSERT INTO "user" (id,name,email,"emailVerified",image,"createdAt","updatedAt") VALUES (?,?,?,1,NULL,?,?)')
        .bind(id, email, cloudUserEmail(id), at, at),
      db.prepare("INSERT INTO supabase_identities (sub,user_id,via,created_at,contact_email,win_token) VALUES (?,?,'created',?,?,?)")
        .bind(sub, id, now, email, win),
      // Rule 14: the event runs only while this unit's own insert stored this unit's token; its id is deterministic (sub, revision 0, kind).
      eventInBatch(db, sub, id, email, "created", 0, now, "contact_email=?4", win),
    ]);
  } catch { return "miss"; }
  noted("created", sub, id);
  // The same fence as a reconcile's, after the unit committed: a writer that moved the revision meanwhile makes the answer a terminal 503.
  if (!(await stillAt(db, sub, 0))) return "moved";
  return { done: { id, email, name: email, emailVerified: true } };
}

/** CH1-G: an invite-gated request's account, resolved against the live identity admission read (and invite-checked) in this request.
 *  The live read is applied only to the revision it was read against: when the mapping's revision (or its existence) differs, nothing is written
 *  and admission runs again (`readAgain`: a fresh revision, a fresh live read, a fresh invite check). A lost compare-and-swap writes nothing and
 *  does the same. After this many rounds the answer is 503. A unit that committed and was then overtaken answers 503 at once, with no further
 *  read or write (never a 403, never the superseded address); a retry reads the committed row. */
export async function resolveCloudAccountAdmitted(db: D1Database, claims: SupabaseClaims, now: number, first: AdmittedIdentity,
  readAgain: () => Promise<AdmittedIdentity>): Promise<CloudAccount> {
  let adm = first;
  for (let round = 0; round < ADMISSION_ROUNDS; round++) {
    if (round > 0) adm = await readAgain();
    const mapped = await mappedUser(db, claims.sub);
    if ((mapped?.revision ?? null) !== adm.rev) continue;
    const r = mapped ? await reconcileOnce(db, claims.sub, mapped, adm.live, now) : await createOnce(db, claims.sub, adm.live.email, now);
    if (typeof r === "object") return r.done;
    if (r === "moved") throw new HTTPError(503, "identity_busy");
  }
  throw new HTTPError(503, "identity_busy");
}

/** The account's contact address reconciled with Supabase Auth NOW, through the one path that changes it (reconcileEmail), whatever any
 *  token says. `currentUser(sub)` is Supabase's current record of the account's mapped user: GET /auth/v1/user with the member's token on a
 *  request, or the identity reader (GET /auth/v1/admin/users/:sub with the secret key, cloudflare/identity-reader) in the cron sweep, where
 *  there is no token. A stale stored address moves to Supabase's current one first, and that address is returned; a conflict recorded
 *  earlier is cleared when Supabase is back on the stored address, or resolved to Supabase's address when no other Cloud account holds it
 *  any more. null: no Supabase identity maps to this account. Throws as reconcileEmail does (409 while another Cloud account holds the
 *  current address, 401/503 when Supabase cannot answer). Used before every door notice (door.ts), the first attempt and every retry, so a
 *  notice never goes to, or is marked sent for, an address Supabase has not just confirmed (Astra DOORMINT-3, DOORMINT-4). */
export async function reconciledContactEmail(db: D1Database, userId: string, now: number,
  currentUser: (sub: string) => Promise<CurrentSupabaseUser>): Promise<string | null> {
  const row = await db.prepare("SELECT sub FROM supabase_identities WHERE user_id=?").bind(userId).first<{ sub: string }>();
  if (!row) return null;
  const mapped = await mappedUser(db, row.sub);
  if (!mapped) return null;
  return (await reconcileEmail(db, row.sub, mapped, now, () => currentUser(row.sub))).email;
}

/** A mapped account: as stored when the token agrees and nothing is unresolved; otherwise through reconcileEmail. */
function fromMapped(db: D1Database, claims: SupabaseClaims, row: MappedRow, now: number, currentUser: CurrentUserLoader): Promise<CloudAccount> | CloudAccount {
  if (row.emailConflict === null && row.email.toLowerCase() === claims.email) return toAccount(row);
  return reconcileEmail(db, claims.sub, row, now, currentUser);
}

/** The mapped account for a verified token, WITHOUT any write (GET /v1/account/step-up/state): null for an unknown subject, and null whenever
 *  resolveCloudAccount would have to write (a changed address, a recorded email conflict). It never creates, moves or logs anything. */
export async function resolveCloudAccountReadOnly(db: D1Database, claims: SupabaseClaims): Promise<CloudAccount | null> {
  const mapped = await mappedUser(db, claims.sub);
  if (!mapped || mapped.emailConflict !== null || mapped.email.toLowerCase() !== claims.email) return null;
  return toAccount(mapped);
}

export async function resolveCloudAccount(db: D1Database, claims: SupabaseClaims, now: number, currentUser: CurrentUserLoader, retried = false): Promise<CloudAccount> {
  const mapped = await mappedUser(db, claims.sub);
  if (mapped) return fromMapped(db, claims, mapped, now, currentUser);

  // Only another CLOUD account can hold the address; a companion (Better Auth) account with it is a separate account.
  const holder = await db.prepare(HOLDER_SQL).bind(claims.email).first<{ id: string; holderSub: string; rev: number; win: string | null }>();
  if (holder) {
    // The refusal is one gated unit (refuseTaken). When the picture changed first (this subject was mapped meanwhile, or the holder moved on) nothing was
    // written: resolve again, once.
    if (holder.holderSub !== claims.sub && await refuseTaken(db, claims.sub, claims.email, holder, now)) throw new HTTPError(409, "account_email_taken");
    const again = await mappedUser(db, claims.sub);
    if (again) return fromMapped(db, claims, again, now, currentUser);
    if (retried) throw new HTTPError(503, "identity_busy");
    return resolveCloudAccount(db, claims, now, currentUser, true);
  }

  const id = crypto.randomUUID();
  const at = new Date(now).toISOString();
  const win = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare('INSERT INTO "user" (id,name,email,"emailVerified",image,"createdAt","updatedAt") VALUES (?,?,?,1,NULL,?,?)')
        .bind(id, claims.email, cloudUserEmail(id), at, at),
      db.prepare("INSERT INTO supabase_identities (sub,user_id,via,created_at,contact_email,win_token) VALUES (?,?,'created',?,?,?)")
        .bind(claims.sub, id, now, claims.email, win),
      // Rule 14: the created event runs only while this unit's own insert stored this unit's token (deterministic id: sub, revision 0, kind).
      eventInBatch(db, claims.sub, id, claims.email, "created", 0, now, "contact_email=?4", win),
    ]);
  } catch {
    // A concurrent first request for the same sub won: resolve from what it wrote. Anything else (another Cloud account
    // took the email in between) is a refusal, never a link.
    const again = await mappedUser(db, claims.sub);
    if (again) return fromMapped(db, claims, again, now, currentUser);
    throw new HTTPError(409, "account_email_taken");
  }
  noted("created", claims.sub, id);
  return { id, email: claims.email, name: claims.email, emailVerified: true };
}
