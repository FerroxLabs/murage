import type { DatabaseSync } from "node:sqlite";

export type TurnRead<T> = { kind: "ready"; rows: T[]; epoch: number }
  | { kind: "not_ready"; reason: "schema" | "backfill" | "dirty" | "repair" | "locked"; retryAfterMs: 5000 };
export type TurnIndexPhase = "absent" | "installing" | "backfilling" | "reconciling" | "ready" | "repairing" | "error";

/** PROVISIONAL INTERFACE: §6.2 names `read` without its callback signature.
 * The callback receives the same database snapshot and returns only selected
 * rows; A2 owns readiness, epoch capture and the transaction. */
export function withTurnReadSnapshot<T>(_db: DatabaseSync, _read: (db: DatabaseSync) => T[]): TurnRead<T> {
  throw new Error("not implemented");
}
