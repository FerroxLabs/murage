// SPDX-License-Identifier: AGPL-3.0-or-later
// Round 12 (Astra MAILRETRY-16): the per-call half of the resource ledger (cloud_resource_dispatch_calls), shared by the B3 lifecycle (server
// and volume creates) and the B5 backup path (the Storage Box sub-account create). A call is SETTLED only by
//   (a) the provider's answer to THAT request (its own key: the resource it made, re-found by the key it was labelled with, or a refusal of
//       the request itself), or
//   (b) an operator confirmation that carries evidence (enforced by the table's CHECK constraint as well).
// Astra INTEGRATED-7 P1: elapsed time alone never settles a call. A listing that finds nothing, however long after the dispatch, settles
// nothing (no provider documents a request lifetime): the generation stays open and is re-listed on a decaying schedule until the resource
// is seen or an operator closes the call with evidence. A listing or GET error never settles anything either. Ordering between a settlement and a listing is on the DATABASE's clock (settled_db_at vs a
// DB_NOW anchor read just before the listing), so two workers whose Date.now() disagree never misorder them.
import { DB_NOW } from "./billing-lease";

/** An assumed bound on how long a provider can still act on a create request after it was sent. None of the three providers documents a
 *  server-side request lifetime or offers idempotency keys (build host Cloud API v1, Vultr API v2, build host Storage Box API v1), so this is NOT
 *  a guarantee and nothing is settled by it (Astra INTEGRATED-7 P1); it only sets the floor for an operator's 'recheck' evidence. */
export const PROVIDER_LIFETIME_MS = { hetzner: 60 * 60_000, vultr: 60 * 60_000, storagebox: 60 * 60_000 } as const;
/** Worker clocks can be minutes apart; the lifetime check runs on them (time-travelling tests), so a skew margin is added. */
export const CLOCK_SKEW_MARGIN_MS = 10 * 60_000;
/** The least time an operator's console re-check (evidence kind 'recheck') must follow the dispatch: the largest assumed lifetime plus the
 *  skew margin (70 minutes). The migration's CHECK constraint uses this same value (4200000). It is a floor for operator evidence only:
 *  nothing is settled automatically by elapsed time. */
export const PROVIDER_REQUEST_LIFETIME_MS = Math.max(...Object.values(PROVIDER_LIFETIME_MS)) + CLOCK_SKEW_MARGIN_MS;

export type CallOutcome = "created" | "failed" | "not_sent";
/** An error the provider gave as its answer to the create request itself (a refusal: the request did not execute). */
export const markAnswered = <E>(error: E): E => {
  if (typeof error === "object" && error !== null) (error as { providerAnswered?: boolean }).providerAnswered = true;
  return error;
};
/** An error raised before the create request was sent. */
export const markNotSent = <E>(error: E): E => {
  if (typeof error === "object" && error !== null) (error as { notSent?: boolean }).notSent = true;
  return error;
};
export const isAnswered = (error: unknown) => typeof error === "object" && error !== null && (error as { providerAnswered?: unknown }).providerAnswered === true;
export const isNotSent = (error: unknown) => typeof error === "object" && error !== null && (error as { notSent?: unknown }).notSent === true;
/** An HTTP status that is the provider's refusal of the request (it did not execute): a 4xx other than 408 (the request timed out). */
export const refusalStatus = (status: number) => status >= 400 && status < 500 && status !== 408;

/** Records a call's settlement from an answer (rule a). settled_db_at is the database's clock. No-op on a settled call. */
export async function settleCall(db: D1Database, callId: string, outcome: CallOutcome, at: number, evidence: string | null = null): Promise<void> {
  await db.prepare(`UPDATE cloud_resource_dispatch_calls SET settled_at=?,settled_db_at=${DB_NOW},outcome=?,evidence=? WHERE id=? AND settled_at IS NULL`)
    .bind(at, outcome, evidence, callId).run();
}
/** The database's clock now (the anchor a listing is ordered by). */
export async function dbNow(db: D1Database): Promise<number> {
  return (await db.prepare(`SELECT ${DB_NOW} AS t`).first<{ t: number }>())!.t;
}

/** Round 12 (Astra MAILRETRY-16 P2-a): a Storage Box sub-account create is recorded in the generation's ledger BEFORE it is sent: one call row
 *  (role 'subaccount', unsettled until answered) and the generation re-armed (open, purge owed), so the ledger can never close while a
 *  sub-account of that generation may exist. Returns the call id (the sub-account is labelled with it). */
export async function recordSubaccountCall(db: D1Database, homeId: string, generation: number, at: number, boundMs: number): Promise<string> {
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO cloud_resource_dispatches (home_id,resource_generation,last_dispatch_at) VALUES (?,?,?)
      ON CONFLICT(home_id,resource_generation) DO UPDATE SET last_dispatch_at=MAX(last_dispatch_at,excluded.last_dispatch_at),reclaimed_at=NULL,purged_at=NULL,next_check_at=NULL`)
      .bind(homeId, generation, at),
    db.prepare(`INSERT INTO cloud_resource_dispatch_calls (id,home_id,resource_generation,role,dispatched_at,dispatched_db_at,deadline_at)
      VALUES (?,?,?,'subaccount',?,${DB_NOW},?)`).bind(id, homeId, generation, at, at + boundMs),
  ]);
  return id;
}

export type ConfirmationEvidence =
  /** The provider's request/action log shows this create completed or failed: the log entry's reference (e.g. a build host action id). */
  | { kind: "provider_log"; reference: string }
  /** The provider confirmed the request cancelled (e.g. a support ticket reference). */
  | { kind: "cancellation"; reference: string }
  /** A console re-check made after the provider lifetime bound elapsed since the dispatch: what was checked (who, where, when). */
  | { kind: "recheck"; reference: string };
/** Round 12 (Astra MAILRETRY-16 P2-b): an operator confirmation of an unanswered call, accepted only with evidence, stored on the call row.
 *  Refused (false) without a reference, for an unknown or settled call, or a 'recheck' before the lifetime bound elapsed. The table's CHECK
 *  constraint refuses the same rows to a raw SQL write. */
export async function confirmDispatchCall(db: D1Database, callId: string, evidence: ConfirmationEvidence, now: number): Promise<boolean> {
  const reference = evidence.reference?.trim();
  if (!reference || !["provider_log", "cancellation", "recheck"].includes(evidence.kind)) return false;
  const r = await db.prepare(`UPDATE cloud_resource_dispatch_calls SET settled_at=?,settled_db_at=${DB_NOW},outcome='operator_confirmed',evidence_kind=?,evidence=?
    WHERE id=? AND settled_at IS NULL AND (?<>'recheck' OR ?>=dispatched_at+?)`)
    .bind(now, evidence.kind, reference.slice(0, 500), callId, evidence.kind, now, PROVIDER_REQUEST_LIFETIME_MS).run();
  return r.meta.changes === 1;
}
