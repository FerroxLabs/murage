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

async function logEvent(db: D1Database, sub: string, userId: string | null, email: string, kind: LinkKind, now: number) {
  await db.prepare("INSERT INTO account_link_events (id,sub,user_id,email,kind,at) VALUES (?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), sub, userId, email, kind, now).run();
  console.log(JSON.stringify({ message: "cloud account identity", kind, sub, userId }));
}

/** A request's compare-and-swap can lose to a concurrent one; after this many rounds the caller is told to retry. */
const RECONCILE_ROUNDS = 3;

/** True while the mapping's revision is still `rev`: an address this round wrote (or read) is answered only then. */
const stillAt = async (db: D1Database, sub: string, rev: number) =>
  Boolean(await db.prepare("SELECT 1 AS ok FROM supabase_identities WHERE sub=? AND email_revision=?").bind(sub, rev).first<{ ok: number }>());

/** The one path that changes a mapped account's contact email: to Supabase's current confirmed address, never to a
 *  token's. Also the only place an email conflict is set or cleared.
 *
 *  Every write here (email move, conflict set, conflict clear) is conditioned on the email_revision this round read and
 *  increments it, in the same statement or transaction (Astra MAKERKIT4 #3). Comparing the email value alone is not
 *  enough: an address can change away and back while a delayed request waits on Supabase, and a conflict clear must
 *  never erase a newer conflict. A lost comparison reloads the mapping AND asks Supabase again, on every branch. An address is
 *  answered only while the revision this round read (or wrote) is still the stored one, checked after the round's last await (the event
 *  log included): never one a concurrent request has moved on from. */
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
    const stored = user.email.toLowerCase();
    const rev = user.revision;
    if (current.email === stored) {
      // The token named a former (or not yet confirmed) address; the stored one is current. Answered only while the revision read before
      // Supabase was asked is still the stored one: a delayed answer must never override a reconciliation that landed meanwhile (a cron
      // retry reads A, a member's request moves the address to B, the reader's answer A arrives late): then both sides are read again
      // (Astra DOORMINT-5). The writes below are fenced on the same revision in their own statements.
      if (user.emailConflict === null) {
        if (await stillAt(db, sub, rev)) return toAccount(user);
        continue;
      }
      // A conflict recorded earlier is over (the member changed back, or Sean resolved it), unless a newer write came first.
      const cleared = await db.prepare(`UPDATE supabase_identities SET email_conflict=NULL, email_revision=email_revision+1
        WHERE sub=? AND email_revision=?`).bind(sub, rev).run();
      if ((cleared.meta.changes ?? 0) === 0) continue;
      await logEvent(db, sub, user.id, stored, "email_conflict_cleared", now);
      // Answered only while the clear is still the latest write: another request may have moved the address while the event was logged
      // (Astra DOORMINT-6). Otherwise both sides are read again, within the same rounds.
      if (await stillAt(db, sub, rev + 1)) return toAccount(user);
      continue;
    }
    // Move to Supabase's address only if the revision is still the one read and no other Cloud account holds the new
    // address (companion accounts are never consulted); the conflict clears and the revision moves in the same statement.
    // The unique index on contact_email backs the NOT EXISTS against a racing writer: a violation is a lost round.
    const moved = await db.prepare(`UPDATE supabase_identities SET contact_email=?, email_conflict=NULL, email_revision=email_revision+1
      WHERE sub=? AND user_id=? AND email_revision=? AND lower(contact_email)=?
        AND NOT EXISTS (SELECT 1 FROM supabase_identities WHERE lower(contact_email)=? AND sub<>?)`)
      .bind(current.email, sub, user.id, rev, stored, current.email, sub).run().catch(() => null);
    if ((moved?.meta.changes ?? 0) > 0) {
      await logEvent(db, sub, user.id, current.email, "email_updated", now);
      // The same fence after the event was logged: a move B -> C that landed meanwhile is never answered as B (Astra DOORMINT-6).
      if (await stillAt(db, sub, rev + 1)) return { ...toAccount(user), email: current.email, emailVerified: true };
      continue;
    }
    const again = await mappedUser(db, sub);
    if (!again) throw new HTTPError(401, "unauthorized");
    // A concurrent request wrote first (or the row changed outside this path): read both sides again.
    if (again.revision !== rev || again.email.toLowerCase() !== stored) continue;
    // Nothing else wrote: another Cloud account holds the member's current address. Persist the conflict (conditioned on the
    // same revision) so every request for this sub, a token naming the former address included, is refused until it
    // is resolved. Sean resolves by hand.
    const set = await db.prepare(`UPDATE supabase_identities SET email_conflict=?, email_revision=email_revision+1
      WHERE sub=? AND email_revision=?`).bind(current.email, sub, rev).run();
    if ((set.meta.changes ?? 0) === 0) continue;
    if (again.emailConflict !== current.email) await logEvent(db, sub, user.id, current.email, "email_conflict", now);
    throw new HTTPError(409, "account_email_conflict");
  }
  throw new HTTPError(503, "identity_unavailable");
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

export async function resolveCloudAccount(db: D1Database, claims: SupabaseClaims, now: number, currentUser: CurrentUserLoader): Promise<CloudAccount> {
  const mapped = await mappedUser(db, claims.sub);
  if (mapped) return fromMapped(db, claims, mapped, now, currentUser);

  // Only another CLOUD account can hold the address; a companion (Better Auth) account with it is a separate account.
  const holder = await db.prepare("SELECT user_id AS id FROM supabase_identities WHERE lower(contact_email)=?").bind(claims.email).first<{ id: string }>();
  if (holder) {
    await logEvent(db, claims.sub, holder.id, claims.email, "refused_email_taken", now);
    throw new HTTPError(409, "account_email_taken");
  }

  const id = crypto.randomUUID();
  const at = new Date(now).toISOString();
  try {
    await db.batch([
      db.prepare('INSERT INTO "user" (id,name,email,"emailVerified",image,"createdAt","updatedAt") VALUES (?,?,?,1,NULL,?,?)')
        .bind(id, claims.email, cloudUserEmail(id), at, at),
      db.prepare("INSERT INTO supabase_identities (sub,user_id,via,created_at,contact_email) VALUES (?,?,'created',?,?)")
        .bind(claims.sub, id, now, claims.email),
    ]);
  } catch {
    // A concurrent first request for the same sub won: resolve from what it wrote. Anything else (another Cloud account
    // took the email in between) is a refusal, never a link.
    const again = await mappedUser(db, claims.sub);
    if (again) return fromMapped(db, claims, again, now, currentUser);
    throw new HTTPError(409, "account_email_taken");
  }
  await logEvent(db, claims.sub, id, claims.email, "created", now);
  return { id, email: claims.email, name: claims.email, emailVerified: true };
}
