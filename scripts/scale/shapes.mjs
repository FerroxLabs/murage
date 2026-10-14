// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The data shapes the scale rig generates (SCALE-PLAN section 1 and section 5, STORAGE-AUDIT section 6).
// "extreme" is the year-3 power user; "pr" is every dimension of it at a small size,
// so a pull request can run the whole rig in minutes; "owner" is the owner's own data
// (about 100k messages in 650 threads, room threads that read other threads' transcripts,
// a file made without auto_vacuum as every install before 1.0.2 was). All are built by
// gen.ts from a seed number, so the same seed and shape always give the same rows.
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
//   roomRowsShare                       share of the spread rows that go to room threads (0 = the plain power-law spread)
//   crossThreadLines                    lines of other threads (the room members' own threads) each room reply is shown
//   autoVacuumOff                       1 = messages.db is made with auto_vacuum=0 (an install from before 1.0.2)
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
    roomRowsShare: 0, crossThreadLines: 0, autoVacuumOff: 0,
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
    roomRowsShare: 0, crossThreadLines: 0, autoVacuumOff: 0,
  },
  // The owner's file (STORAGE-AUDIT, 2026-10-12): 101,526 messages, about 650 threads (14 bot threads, 560 tasks,
  // 4 team rooms, the feed and 71 room tasks), 4,671 receipts, about 185k memory records (checkpoint versions most of
  // them), room replies shown 47 lines of other threads each, auto_vacuum=0.
  owner: {
    bots: 14, teams: 4, tasks: 560, groupTasks: 71,
    rowsTotal: 100_000, sableMainRows: 12_000, sableTaskRows: 8_000, sableTasks: 40, routineRoomRows: 3_000,
    chipsPerTurn: 3, receiptsTotal: 4_700, sessionTurns: [5, 40], revokedFraction: 0.1, rootStride: 1,
    sableActive: 20_000, botActive: 2_000, sableCheckpointVersions: 60_000, botCheckpointVersions: 6_000, waiting: 20,
    vectors: 12_500, pendingJobs: 200,
    hotReceipts: 200, hotChips: 14, hotWindow: 60,
    routines: 10, routineRuns: 2_000,
    slopeTurns: 500, burstRoutines: 10,
    roomRowsShare: 0.35, crossThreadLines: 47, autoVacuumOff: 1,
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

/** The final state the RC receipt writer leaves for one engine session (disclosures.ts linkMemoryDisclosureOutput):
 * each generated row is listed on its turn's receipt and on the session's newest receipt, never on more than two.
 * A row of a turn with no receipt of its own joins the session's newest receipt so far (linkRetainedSessionOutput);
 * a row before the session's first receipt is on none. `turns` in order, each { bot: row ids, receipts: how many
 * receipts the turn made (its frame first, a lookup companion after) }. Returns one output list per receipt, in
 * insertion order. (The old generator listed every later row of the session on every receipt: 20 receipts per row.) */
export function rcReceiptOutputs(turns) {
  const out = [];
  let newest = -1;
  for (const turn of turns) {
    if (turn.receipts > 0) {
      const current = out.length;
      for (let i = 0; i < turn.receipts; i++) out.push([]);
      newest = out.length - 1;
      for (const id of turn.bot) { out[current].push(id); if (newest !== current) out[newest].push(id); }
    } else if (newest >= 0) for (const id of turn.bot) out[newest].push(id);
  }
  return out;
}
