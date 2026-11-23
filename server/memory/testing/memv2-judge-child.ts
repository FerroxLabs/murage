// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Test helper for lane I's migration kill harness (owner: lane I). The COMMITTED judge of a kill point (evidence plan row 5; FABLE and
// OPUS H2a on c21dbca0b9: the in-process judge runs inside a rolled-back transaction, so the code under it takes its in-transaction
// branches). The harness copies the cut with SQLite's online backup into a private profile directory and starts this file as a FRESH
// PROCESS whose data directory is that copy from its first line. It opens the copy through the production open and takes the owner
// turn twice (cold, then warm on the same connection) through the same production entry points as the in-process judge, with NO
// transaction open around them: whatever the turn writes (its recall view, its receipt refusals, its import) commits, on the copy only.
// After the two turns it takes P5-shown on the same copy (memv2-psuite-kill.ts pShownCommitted: the owner edits a shown chunk).
// It answers one line (both verdicts and the branch evidence) and exits. It never sees the original profile.
import { writeSync } from "node:fs";
import { IDS, useIdStream } from "./memv2-kill-ids.ts";
import type { JudgeReport, JudgeSpec } from "./memv2-psuite-kill.ts";

const given = JSON.parse(process.env.MEMV2_JUDGE_CHILD ?? "null") as JudgeSpec | null;
if (!given) throw new Error("memv2-judge-child: no MEMV2_JUDGE_CHILD spec");
const spec: JudgeSpec = given;
// the fixture's clock (moved only by the import previews' own aging, PCLOCK) and the probe id stream, before any product module loads
let clock = spec.now;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args: unknown[]) { if (args.length) super(...(args as [number])); else super(clock); }
  static override now() { return clock; }
} as unknown as DateConstructor;
IDS.seed = spec.seed; IDS.inProbe = true; useIdStream(true);

const { DATA_DIR } = await import("../../config.ts");
const { database } = await import("../../database.ts");
const { audienceCacheCounters, audienceStamp } = await import("../audience-cache.ts");
const { authorityStamp } = await import("../authority-epoch.ts");
const { recallAppliedMarkForTest, startRecallViewMaintenance } = await import("../recall-view.ts");
const { JUDGED, PCLOCK, pShownCommitted, pTurnCommitted, viewRoster } = await import("./memv2-psuite-kill.ts");
PCLOCK.set = ms => { clock = ms; };

const db = database();
const evidence: JudgeReport["evidence"] = { inTransaction: [], audienceStamp: [], authorityStamp: [], views: [], viewIds: [], cache: [], fleet: { applied: false, members: 0, made: 0, projectedBefore: 0, projected: 0 } };
const note = () => { evidence.inTransaction.push(db.isTransaction); evidence.audienceStamp.push(audienceStamp(db, viewRoster) !== undefined); evidence.authorityStamp.push(authorityStamp() !== undefined); };
const turn = () => {
  // the evidence is noted inside the turn (at its start, where the production entry points are called from, and at its end)
  const before = audienceCacheCounters(), verdict = pTurnCommitted(spec.subjects, note), after = audienceCacheCounters();
  // what the turn did to the stored audience answers (audience-cache.ts cachedEligible: a hit is an answer read back from the store)
  evidence.cache.push({ hits: after.hits - before.hits, misses: after.misses - before.misses });
  evidence.viewIds.push(db.prepare("SELECT view_id||':'||generation AS v FROM memory_recall_views WHERE state='ready' ORDER BY 1").all().map(row => String(row.v)));
  evidence.views.push(Number(db.prepare("SELECT count(*) AS n FROM memory_recall_views WHERE state='ready'").get()!.n));
  return verdict;
};
// the records the cold turn's own commits make (its admitted control import), and how many of them stand in a recall view's rows
const activeIds = () => new Set(db.prepare("SELECT id FROM memory_records WHERE state='active'").all().map(row => String(row.id)));
const inViews = (ids: readonly string[]) => ids.filter(id => db.prepare("SELECT 1 AS x FROM memory_recall_view_records WHERE record_id=? LIMIT 1").get(id)).length;
const had = activeIds();
const cold = turn();
const made = [...activeIds()].filter(id => !had.has(id)), projectedBefore = inViews(made);
// Between two turns a live process keeps its views current with the fleet applier, a subscriber of the wake bus that the server's start
// registers (recall-view.ts startRecallViewMaintenance, called by prepareRosterRecallViews). The same here: it is started and the event
// loop runs (the bus pumps on setImmediate), so the cold turn's commits are applied by the applier, not by this file: the records the
// cold turn made are in no view's rows before the loop runs and in a view's rows after it. The fleet is read only after the loop ran
// (asking forms the fleet's record, which the applier is to form itself).
startRecallViewMaintenance();
for (let i = 0; i < 64; i++) await new Promise<void>(resolve => setImmediate(resolve));
{ const fleet = recallAppliedMarkForTest(db); evidence.fleet = { applied: fleet.applied !== undefined, members: fleet.members.length, made: made.length, projectedBefore, projected: inViews(made) }; }
const warm = turn();
// then P5-shown, committed on the copy: the owner edits a chunk a turn was shown, and one nothing was shown (after both turns, so
// what it writes is in neither turn's verdict)
clock += 11 * 60_000;
const shown = await pShownCommitted();
writeSync(1, `${JUDGED}${JSON.stringify({ pid: process.pid, dataDir: DATA_DIR, cold, warm, shown, evidence } satisfies JudgeReport)}\n`);
process.exit(0);
