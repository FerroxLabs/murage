// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The send fence (DESIGN-WRITETIME 3, "Prompt vs send race"), for the driver submission and the steer send. Kept apart from dispatch.ts so
// drivers/engine-input.ts reaches it without importing the bundle and search modules (that import closed a cycle through memory/index.ts
// and left a module constant uninitialised in the memory worker). Its database and its marker drain are handed in by the modules that own
// them (dispatch.ts, memory-revocation.ts) when they load.
import type { DatabaseSync } from "node:sqlite";
import { fenceVerdict } from "./deny-read.ts";
import type { BuiltPrompt, LineageReader, LineageVerdict } from "./lineage-types.ts";

let fenceDb: (() => DatabaseSync) | null = null;
let drainPending: ((db: DatabaseSync) => void) | null = null;
/** dispatch.ts hands in the server database, memory-revocation.ts its bounded marker drain. */
export function setSendFenceDeps(deps: { db?: () => DatabaseSync; drain?: (db: DatabaseSync) => void }): void {
  if (deps.db) fenceDb = deps.db;
  if (deps.drain) drainPending = deps.drain;
}

/** At a turn's start (memory-bundle build): a revoke the owner just made is walked inline within the bounded drain, so the turn's memory,
 * transcript and send read it settled rather than "checking" (the runner yields to the owner's live turn). Never inside a transaction;
 * a large revoke is left to the runner and its window reads "checking" as before. */
export function drainMarkerForTurn(db: DatabaseSync): void {
  if (!drainPending || db.isTransaction) return;
  try { drainPending(db); } catch { /* the runner finishes it; readers hold its window "checking" */ }
}

/** When deny_generation moved since the prompt was built, its parts are looked up again, and a part now denied or pending refuses the send
 * with MEMORY_CONTEXT_REVOKED (the turn is re-dispatched once and rebuilds its prompt). Shown otherwise. A part reading "checking: pending"
 * (a revoke committed moments ago whose marker the runner has not walked: it yields to a live owner turn, and this send is one) first gets
 * a bounded inline drain of the marker (memory-revocation.ts SEND_FENCE_DRAIN) and is asked again; a large revoke stays pending and the
 * send is refused as before. Fail closed: no database, or a lookup that throws, refuses. */
export function assertSendFence(built: BuiltPrompt, reader: LineageReader, db?: DatabaseSync): void {
  // a prompt resting only on none(reason) parts holds nothing stored that a revoke could reach (fenceVerdict says the same; asked first so
  // such a send never needs the database)
  if (built.parts.length && built.parts.every(part => part.lineageOf.length > 0 && part.lineageOf.every(ref => ref.kind === "none"))) return;
  const file = db ?? fenceDb?.() ?? null;
  let verdict: LineageVerdict;
  try { verdict = file ? fenceVerdict(file, built, reader) : { state: "checking", reason: "lookup-error" }; }
  catch { verdict = { state: "checking", reason: "lookup-error" }; }
  if (file && drainPending && verdict.state === "checking" && verdict.reason === "pending") {
    try { drainPending(file); verdict = fenceVerdict(file, built, reader); } catch { verdict = { state: "checking", reason: "lookup-error" }; }
  }
  if (verdict.state !== "shown") throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { fence: verdict });
}
