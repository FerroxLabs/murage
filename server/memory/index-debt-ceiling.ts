// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 MEMORY-V2 W5 (D-R4 1.1-1.3; owner: memv2-D). The ONE ceiling formula of the helper index log and the classification of a log at
// open. Pure (no file, no persisted object); the helper's ask (index-wal chargedCheckpoint), the purpose switch (index-debt.ts), the ledger
// door (io-budget admitIndexDebt) and the open rule's classification all use these and no other byte constant.
// The native meter charges whole OS pages (p = 4, 16 or 64 KiB) while the index's SQLite page is fixed at 4,096 (checkGeometry), so the cost
// of copying F frames is K(F, p) = checkpointCeiling(F, 4096, p): on 16 KiB pages 4x its bytes, on 64 KiB 16x. Every threshold below is
// derived from K, so the same log gets the same decision on every OS (U7), and the bucket is charged in SQLite bytes (F x 4,096).
// The pure formula lives in ../index-debt-frames.ts (the ledger door imports it there: the Sentinel host boundary may not inline memory).
export {
  INDEX_SQLITE_PAGE, INDEX_FRAME_BYTES, INDEX_LOG_MAX_FRAMES, INDEX_BG_TICKET_BYTES, copyCeiling, bgFrames, indexDebtCap, framesOfCeiling,
  indexDebtFrames, validPage, indexDebtTestHooks, indexDebtPage,
} from "../index-debt-frames.ts";
import { bgFrames, INDEX_FRAME_BYTES } from "../index-debt-frames.ts";

/** The closed set of quarantine causes written in the fresh file's first wal_check row (privacy 2: a code, never a path, name or text). */
export type QuarantineCause = "quick_check" | "geometry" | "open_rise" | "unrecorded";
export const QUARANTINE_CAUSES: ReadonlySet<string> = new Set(["quick_check", "geometry", "open_rise", "unrecorded"]);

export interface LogFacts {
  /** -shm header when readable (shmOk), else null */
  shm: { mxFrame: number; nBackfill: number } | null;
  /** WAL header: null unreadable; valid + id */
  header: { valid: boolean; id: string | null } | null;
  /** log length by stat; null unreadable */
  walBytes: number | null;
  /** newest wal_check row; null none */
  row: { Lb: number; reserve: number; idb: string | null } | null;
  /** the envelope's whole bound C (MEMW_C_BYTES) */
  cBytes: number;
  page: number;
  sameGeneration(idb: string | null, id: string | null): boolean;
}
export type LogClass =
  | { state: "HU" | "HO"; frames: number }
  | { state: "DM"; frames: number; why: "open_rise_over" | "open_rise_under" | "over_c_row" }
  | { state: "UK"; frames: number; why: "wal_unreadable" | "header" | "over_c_norow" };
/** D-R4 1.2, run after quick_check and the geometry passed (D1/D2 are the open rule's own catch). F = mxFrame - nBackfill from the -shm when
 * readable, else the conservative floor((Lw - 32) / 4120). D3 (a proven rise past the newest row's reserve, or past C) needs a row, a
 * readable -shm and a valid header: the Lw-based count includes a stale tail and would "prove" a breach that is not there. No row is never
 * damage (a file an older build or an unenforced run wrote): it is HU or HO by size. */
export function classifyIndexLog(f: LogFacts): LogClass {
  const lw = f.walBytes;
  const frames = f.shm && f.shm.mxFrame >= f.shm.nBackfill ? f.shm.mxFrame - f.shm.nBackfill
    : lw === null ? 0 : Math.floor(Math.max(0, lw - 32) / INDEX_FRAME_BYTES);
  if (lw === null) return { state: "UK", frames, why: "wal_unreadable" };
  const log = f.shm ? f.shm.mxFrame : frames;
  if (f.row !== null && f.shm !== null && f.header?.valid) {
    const E = 32 + log * INDEX_FRAME_BYTES, base = f.sameGeneration(f.row.idb, f.header.id) ? f.row.Lb : 32;
    if (E - base > f.row.reserve || E > f.cBytes) return { state: "DM", frames, why: frames > bgFrames(f.page) ? "open_rise_over" : "open_rise_under" };
  }
  if (f.row !== null && lw > f.cBytes) return { state: "DM", frames, why: "over_c_row" };
  if (log > 0 && (!f.header || !f.header.valid)) return { state: "UK", frames, why: "header" };
  if (f.row === null && lw > f.cBytes) return { state: "UK", frames, why: "over_c_norow" };
  return { state: frames > bgFrames(f.page) ? "HO" : "HU", frames };
}
