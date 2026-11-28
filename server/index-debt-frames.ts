// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 MEMORY-V2 W5 (D-R4 1.1-1.3; owner: memv2-D). The pure frame and page arithmetic of the helper index log's ONE ceiling formula,
// kept outside server/memory/ so the ledger door (io-budget admitIndexDebt) can use it without pulling a memory module into the Sentinel
// host boundary bundle (scripts/sentinel-bundle-check.mjs forbids server/memory/** there). memory/index-debt-ceiling.ts re-exports all of it.
// The native meter charges whole OS pages (p = 4, 16 or 64 KiB) while the index's SQLite page is fixed at 4,096 (checkGeometry), so the cost
// of copying F frames is K(F, p) = checkpointCeiling(F, 4096, p): on 16 KiB pages 4x its bytes, on 64 KiB 16x. Every threshold below is
// derived from K, so the same log gets the same decision on every OS (U7), and the bucket is charged in SQLite bytes (F x 4,096).
import { checkpointCeiling, ioMeterPageSize } from "./io-meter.ts";

/** The index's SQLite page (checkGeometry) and its WAL frame (24-byte header + page). */
export const INDEX_SQLITE_PAGE = 4096;
export const INDEX_FRAME_BYTES = INDEX_SQLITE_PAGE + 24;
/** F_C: the most frames a log the envelope allows can hold, floor((MEMW_C_BYTES - 32) / 4120) (index-debt-ceiling-1021.test.ts holds it
 * equal; not imported: index-wal imports memory/index-debt-ceiling.ts). */
export const INDEX_LOG_MAX_FRAMES = 7126;
/** G: the ledger's whole background minute (io-budget BG_MINUTE_BYTES, held equal by the same test; the helper child does not load the ledger). */
export const INDEX_BG_TICKET_BYTES = 12 * 1024 * 1024;

/** K(F, p): the meter's worst case for copying F frames on OS pages of p bytes. */
export function copyCeiling(frames: number, page: number): number { return checkpointCeiling(frames, INDEX_SQLITE_PAGE, page); }
const perFrame = (page: number) => Math.ceil(INDEX_SQLITE_PAGE / page) * page;
/** F_B(p): the most frames one background ticket can copy (max F with K(F, p) <= G). */
export function bgFrames(page: number): number { return Math.max(0, Math.floor((INDEX_BG_TICKET_BYTES - copyCeiling(0, page)) / perFrame(page))); }
/** K_MAX(p): the index-debt grant's cap, one copy of the largest log the envelope allows. */
export function indexDebtCap(page: number): number { return copyCeiling(INDEX_LOG_MAX_FRAMES, page); }
/** The frames a ceiling asks to copy, or null when it is not exactly K(F, p) for a whole F (a stray or forged ask). */
export function framesOfCeiling(ceiling: number, page: number): number | null {
  const rest = ceiling - copyCeiling(0, page);
  if (!Number.isSafeInteger(ceiling) || rest < 0 || rest % perFrame(page) !== 0) return null;
  return rest / perFrame(page);
}
/** Whether F frames are owed through the one index-debt grant: more than a background ticket copies, at most a whole bounded log. */
export function indexDebtFrames(frames: number, page: number): boolean { return frames > bgFrames(page) && frames <= INDEX_LOG_MAX_FRAMES; }

export const validPage = (page: unknown): page is number =>
  typeof page === "number" && Number.isInteger(page) && page >= 4096 && page <= 65536 && (page & (page - 1)) === 0;
/** Test seam (vitest only): the OS page the meter charges in, injected so the 16 and 64 KiB columns run on a 4 KiB host. The helper child
 * reads the same value from MURAGE_W5_TEST_PAGE, which is honoured only under vitest. */
export const indexDebtTestHooks: { page?: number } = {};
/** p: the OS page every W5 decision uses. U4: a page the meter reports outside [4096, 65536] or not a power of two is replaced by the
 * conservative 65,536 (as ioMeterPageSize with no meter). */
export function indexDebtPage(): number {
  let page: number | undefined = indexDebtTestHooks.page;
  if (page === undefined && process.env.VITEST && process.env.MURAGE_W5_TEST_PAGE) page = Number(process.env.MURAGE_W5_TEST_PAGE);
  if (page === undefined) { try { page = ioMeterPageSize(); } catch { page = 65536; } }
  return validPage(page) ? page : 65536;
}
