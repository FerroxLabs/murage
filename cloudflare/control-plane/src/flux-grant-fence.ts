// SPDX-License-Identifier: AGPL-3.0-or-later
// Lane H1: THE GRANT FENCE (migration 0109). Flux holds, per grant id, the highest revision it applied and refuses an older one
// (409 stale_revision, no side effect); the same revision with the same body is a replay (the original 200); the same revision with another
// body is 409 idempotency_mismatch. This module is the control plane's half: ONE owner row per Flux grant id (`invoice_id:kind`, B4 and B5
// alike), claimed by compare-and-set with a fencing epoch BEFORE any I/O, and a per-grant revision allocated under that claim, in D1, before
// the request leaves. Rules:
//  F1 OWNERSHIP. One owner at a time per grant (B4 delivery/revoke, B5 grant/reverse/target, an operator's dispute-credit claim). A claim is
//     taken only when the row is free or its owner's claim has expired (the database clock); every claim raises the epoch. An owner whose
//     claim expired can no longer allocate a revision (its token and epoch no longer match), so it can never send anything new.
//  F2 REVISIONS. A revision is allocated from next_revision, which only grows and never falls below what Flux reported as applied: it is
//     never reused, and any later mutation (a restoration, a re-delivery) is above every earlier one, every revoke ever sent included. A
//     late request of an expired or superseded owner therefore reaches Flux below a revision it already applied and is refused there.
//  F3 OUTCOMES. applied (a receipt): applied_revision rises to it. stale_revision: SUPERSEDED (a later revision already applied): recorded,
//     never retried, reconciled. idempotency_mismatch: a control-plane bug: alerted (high), never retried, reconciled. Anything else that
//     may have executed (timeout, 5xx, lost answer): unknown, reconciled. The owner row is released after the I/O whatever the answer.
//  F4 RECONCILIATION. A grant whose last outcome is unknown, superseded or a mismatch is read back (GET state) by the sweeps, which record
//     Flux's applied revision, state and remaining value here.
// A LEAF: no imports (flux-grants.ts imports it, and the stub-era cutover CLI loads that under Node's type stripping).

/** The database clock in epoch milliseconds: claims and expiries are stamped by the statement itself. */
const NOW = "CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)";

export type FenceOp = "grant" | "reverse" | "target" | "operator";
export interface FenceClaim { grantId: string; token: string; epoch: number }
export type FenceOutcome = "applied" | "superseded" | "mismatch" | "unknown" | "refused";

/** How long an automatic owner (a B4 dispatch, a B5 ask) holds a grant: longer than any request may be in flight (timeouts are 10-15 s). */
export const FENCE_TTL_MS = 5 * 60_000;

/** F1: claim the grant's owner row (compare-and-set: free, or its owner's claim expired). Null when another owner holds it. */
export async function claimGrantFence(db: D1Database, a: { grantId: string; kind: string; ttlMs?: number; homeId?: string; token?: string }): Promise<FenceClaim | null> {
  const token = a.token ?? crypto.randomUUID();
  const res = await db.batch<{ epoch: number }>([
    db.prepare(`INSERT OR IGNORE INTO flux_grant_fence (grant_id,home_id,updated_at) VALUES (?,?,${NOW})`).bind(a.grantId, a.homeId ?? null),
    db.prepare(`UPDATE flux_grant_fence SET epoch=epoch+1,owner_token=?1,owner_kind=?2,owner_expires_at=${NOW}+?3,updated_at=${NOW}
      WHERE grant_id=?4 AND (owner_token IS NULL OR owner_expires_at<=${NOW}) RETURNING epoch`).bind(token, a.kind, a.ttlMs ?? FENCE_TTL_MS, a.grantId),
  ]);
  const row = res[1].results[0];
  return row ? { grantId: a.grantId, token, epoch: row.epoch } : null;
}

/** F2: the next revision of the grant, allocated under the caller's live claim, journaled with what it carries (the body's hash without the
 *  revision). `floor`: the allocated revision is at least this (a B5 reversal target's own revision). Null when the claim is no longer the
 *  owner's (expired and taken over): nothing may be sent.
 *  H2 (Astra P1 "stale B5 targets receive newer wire revisions"): a LOGICAL revision (`logical`, a B5 target's own revision) below one
 *  already allocated for the grant is SUPERSEDED: refused here, atomically with the allocation, so an obsolete target can never ride a newer
 *  wire revision. `guard`: an extra condition the allocation itself checks (the B5 billing lease and the reversal row's current target
 *  revision): refused unless it holds at the instant the revision is taken. The journal row (outcome NULL) is written in the same batch,
 *  BEFORE any I/O: it is the durable mark of a revision that may have been dispatched (F4 discovers it once its owner is gone). */
export async function allocateFenceRevision(db: D1Database, c: FenceClaim, a: { op: FenceOp; bodySha?: string | null; floor?: number; logical?: number;
  guard?: { sql: string; binds: unknown[] } }): Promise<number | null> {
  const res = await db.batch<{ next_revision: number }>([
    db.prepare(`UPDATE flux_grant_fence SET next_revision=MAX(next_revision,applied_revision,?1-1)+1,state_seq=state_seq+1,updated_at=${NOW}
      WHERE grant_id=?2 AND owner_token=?3 AND epoch=?4 AND owner_expires_at>${NOW}
        AND (?5 IS NULL OR NOT EXISTS (SELECT 1 FROM flux_grant_revisions v WHERE v.grant_id=?2 AND v.logical_revision>?5))
        ${a.guard ? `AND (${a.guard.sql})` : ""} RETURNING next_revision`)
      .bind(a.floor ?? 0, c.grantId, c.token, c.epoch, a.logical ?? null, ...(a.guard?.binds ?? [])),
    db.prepare(`INSERT INTO flux_grant_revisions (grant_id,revision,epoch,op,body_sha256,logical_revision,allocated_at)
      SELECT grant_id,next_revision,epoch,?1,?2,?6,${NOW} FROM flux_grant_fence WHERE grant_id=?3 AND owner_token=?4 AND epoch=?5 AND changes()=1`)
      .bind(a.op, a.bodySha ?? null, c.grantId, c.token, c.epoch, a.logical ?? null),
  ]);
  return res[0].results[0]?.next_revision ?? null;
}

/** H2: why an allocation was refused while the caller still holds its claim: "superseded" (a later logical revision, or the guard failed),
 *  else "owner_lost". */
export async function allocationRefusal(db: D1Database, c: FenceClaim): Promise<"superseded" | "owner_lost"> {
  return (await fenceHeld(db, c)) ? "superseded" : "owner_lost";
}

/** H2: a revision allocated but never sent (the caller failed before the request left): journaled as not_sent, so F4 never reads it back. */
export async function abandonFenceRevision(db: D1Database, c: FenceClaim, revision: number): Promise<void> {
  await db.prepare(`UPDATE flux_grant_revisions SET outcome='not_sent',settled_at=${NOW} WHERE grant_id=? AND revision=? AND outcome IS NULL`)
    .bind(c.grantId, revision).run();
}

/** F3: the answer to a request at `revision`, recorded, and the owner row released (only by its own token). `appliedRevision`: what Flux
 *  says it holds (a stale or mismatch answer names it). A mismatch raises one high alert per grant and revision.
 *  H5 (Astra H4 #8): a settlement never clears a SNAPSHOT demand (snapshot_due_revision: a read that observed Flux but could not publish):
 *  while no published snapshot covers both that observation and this revision, the grant stays due, however the request ended. */
export async function settleFenceRevision(db: D1Database, c: FenceClaim, a: { revision: number; outcome: FenceOutcome; appliedRevision?: number;
  homeId?: string; detail?: Record<string, unknown> }): Promise<void> {
  const applied = a.outcome === "applied" ? Math.max(a.revision, a.appliedRevision ?? 0) : a.appliedRevision ?? 0;
  const reconcile = a.outcome === "applied" || a.outcome === "refused" ? 0 : 1;
  await db.batch([
    db.prepare(`UPDATE flux_grant_revisions SET outcome=?1,settled_at=${NOW} WHERE grant_id=?2 AND revision=?3 AND (outcome IS NULL OR outcome='unknown')`)
      .bind(a.outcome, c.grantId, a.revision),
    // H3: every older revision still unresolved is now below what Flux holds: it can never execute any more (Flux refuses it).
    ...(applied > 0 ? [db.prepare(`UPDATE flux_grant_revisions SET outcome='landed_or_superseded',settled_at=${NOW}
      WHERE grant_id=?1 AND revision<?2 AND (outcome IS NULL OR outcome='unknown')`).bind(c.grantId, applied)] : []),
    db.prepare(`UPDATE flux_grant_fence SET applied_revision=MAX(applied_revision,?1),last_revision=?2,last_outcome=?3,state_seq=state_seq+1,
        needs_reconcile=CASE WHEN ?4=1 THEN 1
          WHEN snapshot_due_revision IS NOT NULL AND COALESCE(snapshot_revision,-1)<MAX(snapshot_due_revision,?2) THEN 1
          WHEN ?2>=MAX(applied_revision,?1) THEN 0 ELSE needs_reconcile END,updated_at=${NOW},
        owner_token=CASE WHEN owner_token=?5 THEN NULL ELSE owner_token END,
        owner_kind=CASE WHEN owner_token=?5 THEN NULL ELSE owner_kind END,
        owner_expires_at=CASE WHEN owner_token=?5 THEN NULL ELSE owner_expires_at END
      WHERE grant_id=?6`).bind(applied, a.revision, a.outcome, reconcile, c.token, c.grantId),
    ...(a.outcome === "mismatch" ? [db.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject)
      VALUES (?1,?2,'credit.revision_mismatch','high',?3,${NOW},?4) ON CONFLICT DO NOTHING`)
      .bind(`alert:flux_revision_mismatch:${c.grantId}:${a.revision}`, a.homeId ?? "billing", JSON.stringify({ grantId: c.grantId, revision: a.revision,
        appliedRevision: a.appliedRevision ?? null, ...a.detail,
        rule: "Flux holds this revision with ANOTHER body: a control-plane bug. Never retried; the grant is read back (GET state) and a person decides" }),
        `${c.grantId}:${a.revision}`)] : []),
  ]);
}

/** Releases the owner row without a request (nothing was sent under the claim). */
export async function releaseGrantFence(db: D1Database, c: FenceClaim): Promise<void> {
  await db.prepare("UPDATE flux_grant_fence SET owner_token=NULL,owner_kind=NULL,owner_expires_at=NULL WHERE grant_id=? AND owner_token=?").bind(c.grantId, c.token).run();
}

/** The claim still owns the grant at its epoch and has not expired (F1). */
export async function fenceHeld(db: D1Database, c: FenceClaim): Promise<boolean> {
  return (await db.prepare(`SELECT 1 AS x FROM flux_grant_fence WHERE grant_id=? AND owner_token=? AND epoch=? AND owner_expires_at>${NOW}`)
    .bind(c.grantId, c.token, c.epoch).first()) !== null;
}

export interface FenceRow { grant_id: string; epoch: number; next_revision: number; applied_revision: number; last_outcome: string | null;
  needs_reconcile: number; remote_state: string | null; remote_remaining_microcents: number | null; owner_token: string | null;
  snapshot_revision: number | null; snapshot_due_revision: number | null }
export async function fenceOf(db: D1Database, grantId: string): Promise<FenceRow | null> {
  return db.prepare("SELECT * FROM flux_grant_fence WHERE grant_id=?").bind(grantId).first<FenceRow>();
}

/** What Flux's GET state says of one grant. */
export interface RemoteGrantState { state: string; appliedRevision: number; remainingMicrocents: number | null }
/** F4 (H2, Astra P2 "crash-interrupted mutations escape reconciliation"): a grant is DUE a read-back when its last outcome is unknown,
 *  superseded or a mismatch (needs_reconcile), OR when it holds an ORPHAN revision: one journaled (outcome NULL: possibly dispatched) whose
 *  owner is gone (released, expired, or replaced by a later claim) without settling it (a worker that died between the allocation and the
 *  settlement, an operator claim that expired or was taken over). A live owner's in-flight revision is never an orphan.
 *  H3 (Astra H2 #3/#6): an UNRESOLVED revision (an orphan, or one settled `unknown`: a timeout, a 5xx) keeps the grant due for as long as it is
 *  above what Flux holds: a read that still reports an older revision does not resolve it (the request may land later). It stops being due
 *  only when Flux confirms it or applies a later revision. Binds: none; the fence row is `f`. */
export const FENCE_DUE = `(f.needs_reconcile=1 OR EXISTS (SELECT 1 FROM flux_grant_revisions v WHERE v.grant_id=f.grant_id AND v.revision>f.applied_revision
  AND (v.outcome='unknown' OR (v.outcome IS NULL AND (v.epoch<f.epoch OR f.owner_token IS NULL OR f.owner_expires_at<=${NOW})))))`;
/** F4: the grants due a read-back, the least recently TRIED first (H4, Astra H3 #9: every attempt stamps read_attempted_at, a failing or
 *  empty read included, so grants whose reads keep failing rotate behind the others and never starve them), then the oldest. */
export async function fencesToReconcile(db: D1Database, limit = 20): Promise<{ grant_id: string; home_id: string | null }[]> {
  return (await db.prepare(`SELECT f.grant_id,f.home_id FROM flux_grant_fence f WHERE ${FENCE_DUE}
    ORDER BY COALESCE(f.read_attempted_at,0),f.updated_at,f.grant_id LIMIT ?`).bind(limit)
    .all<{ grant_id: string; home_id: string | null }>()).results;
}
/** F4: the grant is due a read-back before the caller (who has just claimed it) sends anything. */
export async function fenceDue(db: D1Database, grantId: string): Promise<boolean> {
  return (await db.prepare(`SELECT 1 AS x FROM flux_grant_fence f WHERE f.grant_id=? AND ${FENCE_DUE}`).bind(grantId).first()) !== null;
}
/** F4: record what Flux holds. Every journaled revision at or below the applied one that is still unresolved is settled as
 *  `landed_or_superseded` (it can never execute any more). An OPERATOR revision of an expired claim that Flux holds as its applied revision is
 *  alerted (high): an adjustment made under a claim that no longer owned the grant reached Flux and must be reviewed.
 *  H3 (Astra H2 #3): a revision ABOVE what Flux holds is left unresolved (never retired on an early read: it may still land); it keeps the
 *  grant due (FENCE_DUE) until Flux confirms it or applies a later one.
 *  H3 (Astra H2 #6): `seenSeq` is the row's state_seq read BEFORE the GET was sent. The snapshot (remote state, remaining value, the cleared
 *  reconcile demand) is published only if nothing changed the row meanwhile (no allocation, settlement, hand adjustment or other read-back)
 *  and it is not older than what the row already holds; otherwise only the monotone facts are kept (applied revision, settled journal rows)
 *  and the grant stays due. Resolves true when the snapshot was published.
 *  H4 (Astra H3 #8): a snapshot that loses that compare-and-set KEEPS the reconciliation demand (needs_reconcile) unless a snapshot already
 *  published covers it (snapshot_revision at or above the revision it observed): settling the journal alone would leave the row saying
 *  something Flux no longer holds with nothing left due. */
export async function recordReconciled(db: D1Database, grantId: string, r: RemoteGrantState, homeId = "billing", seenSeq?: number | null): Promise<boolean> {
  const fresh = `(state_seq=?5 AND ?2>=applied_revision)`;
  const res = await db.batch<{ state_seq: number }>([
    // Published first (the predicate reads the row as it was): only a snapshot that is still current.
    db.prepare(`UPDATE flux_grant_fence SET remote_state=?3,remote_remaining_microcents=?4,snapshot_revision=?2,needs_reconcile=0,last_outcome='reconciled',
        reconciled_at=${NOW},state_seq=state_seq+1,updated_at=${NOW},
        snapshot_due_revision=CASE WHEN snapshot_due_revision<=?2 THEN NULL ELSE snapshot_due_revision END WHERE grant_id=?1 AND ${fresh} RETURNING state_seq`)
      .bind(grantId, r.appliedRevision, r.state, r.remainingMicrocents, seenSeq ?? -1),
    // H4: not published above and no published snapshot covers this observation: the grant stays due (a fresh read publishes it).
    // H5 (Astra H4 #8): the observation is remembered (snapshot_due_revision), so a later settlement cannot clear the demand.
    db.prepare(`UPDATE flux_grant_fence SET needs_reconcile=1,snapshot_due_revision=MAX(COALESCE(snapshot_due_revision,0),?2)
      WHERE grant_id=?1 AND (snapshot_revision IS NULL OR snapshot_revision<?2)`)
      .bind(grantId, r.appliedRevision),
    db.prepare(`UPDATE flux_grant_revisions SET outcome='landed_or_superseded',settled_at=${NOW}
      WHERE grant_id=?1 AND revision<=?2 AND (outcome IS NULL OR outcome='unknown')`).bind(grantId, r.appliedRevision),
    db.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject)
      SELECT 'alert:flux_stale_claim_adjusted:' || v.grant_id || ':' || v.revision,?3,'credit.stale_claim_adjusted','high',
        json_object('grantId',v.grant_id,'revision',v.revision,'epoch',v.epoch,'currentEpoch',f.epoch,
          'rule','an adjustment issued under an operator claim that has since expired is the revision Flux holds: review it against the grant''s obligation'),${NOW},v.grant_id || ':' || v.revision
      FROM flux_grant_revisions v JOIN flux_grant_fence f ON f.grant_id=v.grant_id
      WHERE v.grant_id=?1 AND v.revision=?2 AND v.op='operator' AND v.epoch<f.epoch AND v.outcome IS NOT 'applied'
      ON CONFLICT DO NOTHING`).bind(grantId, r.appliedRevision, homeId),
    // Monotone, whatever the snapshot's age: Flux holds at least this revision, so nothing at or below it is ever allocated again.
    db.prepare(`UPDATE flux_grant_fence SET applied_revision=MAX(applied_revision,?2),next_revision=MAX(next_revision,?2),updated_at=${NOW} WHERE grant_id=?1`)
      .bind(grantId, r.appliedRevision),
  ]);
  return res[0].results.length === 1;
}
/** H3 (Astra H2 #6): the row's state_seq, read before a GET is sent (the snapshot's fence). */
export async function fenceSeq(db: D1Database, grantId: string): Promise<number | null> {
  return (await db.prepare("SELECT state_seq AS s FROM flux_grant_fence WHERE grant_id=?").bind(grantId).first<{ s: number }>())?.s ?? null;
}
/** F4: one read-back: the row's state_seq is taken BEFORE the GET, and the snapshot is published only if it is still current (H3). Resolves
 *  the state read (or null when it could not be read); a read that fails leaves the grant due. */
export async function reconcileOne(db: D1Database, grantId: string, homeId: string | null | undefined,
  read: (grantId: string) => Promise<RemoteGrantState | null>): Promise<RemoteGrantState | null> {
  const seq = await fenceSeq(db, grantId);
  let r: RemoteGrantState | null;
  try { r = await read(grantId); } finally {
    // H4 (Astra H3 #9): every attempt is stamped, success or failure (never state_seq: the attempt changes nothing the row says of Flux).
    await db.prepare(`UPDATE flux_grant_fence SET read_attempted_at=${NOW} WHERE grant_id=?`).bind(grantId).run();
  }
  if (r) await recordReconciled(db, grantId, r, homeId ?? "billing", seq);
  return r;
}
/** F4, for a sweep: reads back every grant due (bounded) through `read`; a read that fails leaves the grant due. */
export async function reconcileFences(db: D1Database, read: (grantId: string) => Promise<RemoteGrantState | null>, limit = 20): Promise<number> {
  let done = 0;
  for (const { grant_id: grantId, home_id: homeId } of await fencesToReconcile(db, limit)) {
    try { if (await reconcileOne(db, grantId, homeId, read)) done++; } catch { continue; }
  }
  return done;
}

/** The B5 target revision a wire revision carried (journal), or null. */
export async function logicalOf(db: D1Database, grantId: string, wire: number): Promise<number | null> {
  return (await db.prepare("SELECT logical_revision AS l FROM flux_grant_revisions WHERE grant_id=? AND revision=?").bind(grantId, wire)
    .first<{ l: number | null }>())?.l ?? null;
}

/** The body's hash without its revision (the replay identity Flux compares, F2's journal). */
export async function bodyShaWithoutRevision(body: Record<string, unknown>): Promise<string> {
  const { revision: _r, ...rest } = body;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(rest)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
