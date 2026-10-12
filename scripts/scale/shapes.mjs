// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two data shapes the scale rig generates (SCALE-PLAN section 1 and section 5).
// "extreme" is the year-3 power user; "pr" is every dimension of it at a small size,
// so a pull request can run the whole rig in minutes. Both are built by gen.ts from
// a seed number, so the same seed and shape always give the same rows.
//
// Knobs (all counts):
//   bots, teams, tasks, groupTasks     roster: bots, team rooms, bot task threads, extra room threads
//   rowsTotal                           message rows across every thread (hot session included)
//   sableMainRows                       rows in the longest thread (Sable direct) before the hot session
//   sableTaskRows                       rows spread over Sable's own tasks (Sable is the heaviest bot)
//   sableTasks                          Sable's share of `tasks`
//   routineRoomRows                     rows in the routine-fed room
//   chipsPerTurn                        tool chips per bulk turn (rows per turn = 2 + chips)
//   receiptsTotal                       memory receipts (memory_disclosures) across the install
//   sessionTurns                        [min,max] turns per bulk engine session
//   revokedFraction                     share of bulk receipts that are revoked (older sessions)
//   rootStride                          record a reply root set every N bulk turns (1 = every turn)
//   sableActive, botActive              active memory records in Sable's bot scope / every other bot's
//   sableCheckpointVersions             thread checkpoint versions on Sable's direct thread (all but one archived)
//   botCheckpointVersions               checkpoint versions on every other bot's direct thread
//   waiting                             candidate records waiting for the owner (Sable)
//   vectors                             stored vectors in memory-index.db (past the 12k matrix cap)
//   pendingJobs                         capture jobs left pending (a backlog the worker drains)
//   hotReceipts, hotChips               the resumed Sable session: receipts in it and chips per turn
//   hotWindow                           rows of context each hot turn is shown (root-set growth)
//   routines, routineRuns               routine definitions and the run journal (MAX_RUNS is 2,000)
//   slopeTurns                          turns of the slope scenario (one resumed session)
//   burstRoutines                       routines due at the same minute in the burst scenario
export const SHAPES = {
  extreme: {
    bots: 60, teams: 12, tasks: 4000, groupTasks: 1900,
    rowsTotal: 3_000_000, sableMainRows: 180_000, sableTaskRows: 220_000, sableTasks: 300, routineRoomRows: 130_000,
    chipsPerTurn: 3, receiptsTotal: 500_000, sessionTurns: [5, 40], revokedFraction: 0.1, rootStride: 1,
    sableActive: 50_000, botActive: 800, sableCheckpointVersions: 150_000, botCheckpointVersions: 400, waiting: 111,
    vectors: 20_000, pendingJobs: 4_000,
    hotReceipts: 2_000, hotChips: 14, hotWindow: 60,
    routines: 30, routineRuns: 2_000,
    slopeTurns: 500, burstRoutines: 60,
  },
  pr: {
    bots: 8, teams: 2, tasks: 80, groupTasks: 30,
    rowsTotal: 60_000, sableMainRows: 9_000, sableTaskRows: 6_000, sableTasks: 10, routineRoomRows: 2_600,
    chipsPerTurn: 3, receiptsTotal: 10_000, sessionTurns: [5, 40], revokedFraction: 0.1, rootStride: 1,
    sableActive: 2_000, botActive: 100, sableCheckpointVersions: 10_000, botCheckpointVersions: 40, waiting: 11,
    vectors: 12_500, pendingJobs: 200,
    hotReceipts: 200, hotChips: 29, hotWindow: 60,
    routines: 6, routineRuns: 200,
    slopeTurns: 500, burstRoutines: 8,
  },
};

/** The named shape, with any SCALE_<KNOB> environment override (numbers only). */
export function shape(name, env = process.env) {
  const base = SHAPES[name];
  if (!base) throw new Error(`unknown shape ${name}; use one of ${Object.keys(SHAPES).join(", ")}`);
  const out = { ...base };
  for (const key of Object.keys(base)) {
    const raw = env[`SCALE_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`];
    if (raw !== undefined && typeof base[key] === "number" && Number.isFinite(Number(raw))) out[key] = Number(raw);
  }
  return out;
}
