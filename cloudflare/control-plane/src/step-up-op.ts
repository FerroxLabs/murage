// SPDX-License-Identifier: AGPL-3.0-or-later
// The claimed step-up operation as its handler sees it (step-up-email.ts; Astra STEPUP-EMAIL-3 #2-#4). The claim consumed the approval,
// created this operation record and acquired the handler's resource lease in ONE D1 batch; the handler then runs AS that lease holder:
//   - billing-lease.ts withHomeLease uses the held billing lease of the approved home (re-entrant, never released by the handler) and
//     refuses any other home (the approval was frozen for that one);
//   - b4-flux.ts takes the Flux home lease under the held holder (re-entrant).
// Explicit phases (cloud_stepup_intents.phase): 'claimed' (lease bookkeeping only, nothing of the operation happened) -> 'dispatched' (an
// external call is journaled under the operation's stable identity BEFORE it is made) -> 'committed' (the operation's own durable effect,
// marked in the SAME transaction as that effect) -> 'delivered' (the token-fenced finalization) or 'compensating' -> 'compensated' (the
// sweep queued the revocation of an undelivered Flux key; the router confirmed it). Completion is never inferred from write counts. An
// operation whose own durable reservation moves its frozen target before dispatch (a Flux mint) records that in reserved_target
// (reserveStatement), so its resumption is not mistaken for somebody else's change.
// The context is keyed by the journaled D1 binding the handler receives (env.DB), so it survives `{ ...env }` copies and is invisible to
// anything the request did not claim. Nothing here is ever set from caller input.
import { HTTPError } from "./http";

export type StepUpLease = { kind: "billing"; homeId: string; holder: string; generation: number } | { kind: "flux"; homeId: string; holder: string } | null;
export interface StepUpOp {
  intentId: string;
  /** The claim's fencing token: every phase change and the finalization require it (exactly one row). */
  token: string;
  lease: StepUpLease;
  /** The raw (unjournaled) binding the phase statements are prepared on. */
  db: D1Database;
  /** The frozen target's SQL (step-up-email.ts targetSpec): the operation's own reservation records what it left the target at. */
  target?: { sql: string; binds: unknown[] };
  /** The target exactly as the claiming statement saw it (still the frozen one, or the operation's own reservation of it). */
  pinned?: string;
  /** Every durable write of the operation is an OWN RESERVATION (Astra STEPUP-EMAIL-5 #1, #3): step-up-email.ts journalD1 runs it only
   *  while the target still holds (frozen, or as this operation's own earlier writes left it) and, in the same transaction, records the
   *  target as that write left it (reserved_target), so a resumption recognises its own changes and refuses anybody else's. */
  reserveOwn?: boolean;
  /** /v1/flux/link/complete: the owner's link revision the approval was frozen at (b4-flux.ts linkRevisionSql), re-checked inside the
   *  link mutation itself. */
  linkRevision?: number | null;
}
const ops = new WeakMap<object, StepUpOp>();
export const bindStepUpOp = (db: D1Database, op: StepUpOp) => { ops.set(db, op); };
export const stepUpOpOf = (env: { DB: D1Database }): StepUpOp | null => ops.get(env.DB) ?? null;

/** The held billing lease for `homeId`; null when the request holds none. A claimed operation that reaches for ANOTHER home's billing
 *  lease is refused: its approval was frozen for one home only. */
export function heldBillingLease(env: { DB: D1Database }, homeId: string): { homeId: string; holder: string; generation: number } | null {
  const op = stepUpOpOf(env);
  if (!op || !op.lease || op.lease.kind !== "billing") return null;
  if (op.lease.homeId !== homeId) throw new HTTPError(403, "step_up_required");
  return op.lease;
}
/** The held Flux lease holder for `homeId`, else null. Another home: refused (see above). */
export function heldFluxHolder(env: { DB: D1Database }, homeId: string): string | null {
  const op = stepUpOpOf(env);
  if (!op || !op.lease || op.lease.kind !== "flux") return null;
  if (op.lease.homeId !== homeId) throw new HTTPError(403, "step_up_required");
  return op.lease.holder;
}

const MINE = "id=? AND exec_token=? AND state='executing'";
/** A runner whose token was superseded (a reconciling retry took the operation over): it must stop and disclose nothing. */
export const superseded = (id: string) => new HTTPError(409, "action_in_progress", { operation: { id } });

/** Journal an external dispatch (a Stripe portal or Checkout session, an export link, a Flux mint) under the operation's stable identity
 *  BEFORE the call is made. Token-fenced: a superseded runner is stopped here. Returns the stable operation identity (the provider
 *  idempotency key), or null outside a claimed operation. */
export async function journalDispatch(env: { DB: D1Database }, ref: string): Promise<string | null> {
  const op = stepUpOpOf(env);
  if (!op) return null;
  const r = await op.db.prepare(`UPDATE cloud_stepup_intents SET phase='dispatched', dispatch_ref=? WHERE ${MINE} AND phase IN ('claimed','dispatched')`)
    .bind(ref.slice(0, 200), op.intentId, op.token).run();
  if (r.meta.changes !== 1) throw superseded(op.intentId);
  return `stepup:${op.intentId}`;
}
/** For an operation that marks its own commitment: the statement to put in the SAME batch as its durable effect, right after the
 *  statement whose single changed row is that effect (it applies only when changes()=1). Null outside a claimed operation. */
export function commitStatement(env: { DB: D1Database }, ref: string | null = null): D1PreparedStatement | null {
  const op = stepUpOpOf(env);
  if (!op) return null;
  return op.db.prepare(`UPDATE cloud_stepup_intents SET phase='committed', dispatch_ref=COALESCE(?, dispatch_ref) WHERE ${MINE}
    AND phase IN ('claimed','dispatched') AND changes()=1`).bind(ref, op.intentId, op.token);
}
/** The same commitment as a billing statement ([sql, binds]) for a fenced billing batch (billing-lease.ts fencedBatch): placed right after
 *  the statement whose single changed row is the operation's completed effect. Null outside a claimed operation. */
export function commitQ(env: { DB: D1Database }, ref: string | null = null): [sql: string, binds?: unknown[]] | null {
  const op = stepUpOpOf(env);
  if (!op) return null;
  return [`UPDATE cloud_stepup_intents SET phase='committed', dispatch_ref=COALESCE(?, dispatch_ref) WHERE ${MINE}
    AND phase IN ('claimed','dispatched') AND changes()=1`, [ref, op.intentId, op.token]];
}
/** The operation's own reservation (a Flux mint's claim moved the frozen target's versions before dispatch): the statement to put in the
 *  SAME batch right after the reserving statements, applied only when changes()=1. The reserving statement itself must have validated the
 *  WHOLE pinned target (pinnedTargetHolds) in its own WHERE, so only a validated own change is ever recorded here, never an intervening
 *  one (Astra STEPUP-EMAIL-7 #2). It records the target as that reservation left it,
 *  so a resumption after an interruption recognises its own change (and still refuses anybody else's). Null outside a claimed operation. */
export function reserveStatement(env: { DB: D1Database }): D1PreparedStatement | null {
  const op = stepUpOpOf(env);
  if (!op || !op.target) return null;
  return op.db.prepare(`UPDATE cloud_stepup_intents SET reserved_target=(${op.target.sql}) WHERE ${MINE} AND phase IN ('claimed','dispatched')
    AND changes()=1`).bind(...op.target.binds, op.intentId, op.token);
}
/** SQL that is true while the operation's target is still exactly the one its claim pinned (a write conditioned on it applies only to that
 *  target: e.g. a desktop code is issued only for the home generation the approval was frozen at). Null outside a claimed operation. */
export function pinnedTargetHolds(env: { DB: D1Database }): { sql: string; binds: unknown[] } | null {
  const op = stepUpOpOf(env);
  if (!op || !op.target || op.pinned === undefined) return null;
  return { sql: `(${op.target.sql}) IS ?`, binds: [...op.target.binds, op.pinned] };
}
/** The home and generation a claimed operation's target was pinned at (a home, desktop or Flux target: elements 1 and 2 of the frozen
 *  array, step-up-email.ts targetSpec). An operation's own reservation never moves a home's generation, so this holds from the claim to
 *  the commitment (Astra STEPUP-EMAIL-7 #2). Undefined outside such an operation. */
export function pinnedHomeGeneration(env: { DB: D1Database }): { homeId: string; generation: number } | undefined {
  const op = stepUpOpOf(env);
  if (!op || typeof op.pinned !== "string") return undefined;
  try {
    const v = JSON.parse(op.pinned) as unknown;
    if (Array.isArray(v) && ["flux", "home", "desktop"].includes(v[0] as string) && typeof v[1] === "string" && Number.isSafeInteger(v[2])) {
      return { homeId: v[1], generation: v[2] as number };
    }
  } catch { /* 'none' or not an array: no home generation pinned */ }
  return undefined;
}
/** The link revision an approved /v1/flux/link/complete was frozen at; undefined outside such an operation. */
export function pinnedLinkRevision(env: { DB: D1Database }): number | null | undefined {
  const op = stepUpOpOf(env);
  return op && op.linkRevision !== undefined ? op.linkRevision : undefined;
}
