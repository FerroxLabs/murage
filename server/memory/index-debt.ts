// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 MEMORY-V2 W5 (MEMORY-V2-DESIGN 4.9 W5, R1; owner: memv2-D. Callers: index-wal.ts chargedCheckpoint (lane A), the grant's transport
// worker-controller.ts bg-grant-request (lane E), the grant itself io-budget.ts admitIndexDebt (memv2-D)).
// An unclean stop can leave the helper's index log with more un-copied pages than the minute ledger ever admits in one background ticket
// (BG_MINUTE_BYTES), and SQLite cannot checkpoint part of a log. Before W5 such a log was quarantined and the index rebuilt from every
// receipt even though quick_check and the geometry had passed. Now the open check copies it under one "index-debt" grant, which the main
// process charges to the background bucket as debt; quarantine stays for proven damage only (D-R4 1.3: quick_check, geometry, or a rise
// past the newest row's reserve that the -shm proves), each with its cause in the fresh file's first wal_check row.
import { setAdmissionPurpose } from "./helper-admission.ts";
import { framesOfCeiling, indexDebtFrames, indexDebtPage } from "./index-debt-ceiling.ts";

/** Runs `fn` (the helper's grant ask and its copy) under the index-debt purpose when it is the open check's copy of more frames than one
 * background ticket copies (D-R4 1.1: F > F_B(p), read back from the ceiling K(F, p) the helper asks for, so ask and door agree); otherwise
 * as it is. A ticket of another purpose held by the helper is settled first and one asked for under this purpose is settled when it ends
 * (helper-admission setAdmissionPurpose), so the grant never outlives the copy. */
export async function withIndexDebtPurpose<T>(opening: boolean, ceiling: number, fn: () => Promise<T>, page: number = indexDebtPage()): Promise<T> {
  const frames = framesOfCeiling(ceiling, page);
  if (!opening || frames === null || !indexDebtFrames(frames, page)) return fn();
  const restore = setAdmissionPurpose("index-debt");
  try { return await fn(); } finally { restore(); }
}
