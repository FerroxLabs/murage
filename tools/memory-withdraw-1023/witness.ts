// q1023-cleanopus witnesses on a COPY of the real store (owner: q1023-cleanopus). usage: node /job/witness.ts <messages.db>
// W-CHECK   the app's read path for an unscoped Murage object (deny-read.ts memoryLookup -> memoryPendingSince, the install-wide pending
//           rule MAIN's LIVE PROOF names: fence cause=checking) reads "shown", never "checking", for a card and for live records.
// W-REPLAY  the start-up deletion replay (capture.ts captureThreadDeletion, what conversation-deletion.ts reconcile calls for each
//           pending deletion) commits NO new revoke job and NO pending row for any deleted conversation (inside a rolled-back tx).
// W-JOBS    no revoke job is open and no pending window is left.
// Counts only are printed.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
const M = "/work/server/memory/";
const { memoryLookup } = await import(M + "deny-read.ts");
const { memoryRefKey } = await import(M + "lineage-types.ts");
const { captureThreadDeletion } = await import(M + "capture.ts");
const db = new DatabaseSync(process.argv[2]!);
db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
const n = (sql: string) => Number(db.prepare(sql).get()!.n);
const say = (k: string, v: unknown) => console.log(`WITNESS ${k} ${JSON.stringify(v)}`);
const pendingRows = () => n("SELECT (SELECT count(*) FROM memory_deny_pending)+(SELECT count(*) FROM memory_deny_pending_scope) AS n");
const openJobs = () => n("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state NOT IN ('done','undone')");
say("before", { openJobs: openJobs(), pending: pendingRows() });

// W-REPLAY first (it rolls back): every deleted conversation of memory_deny, replayed as the boot reconcile would
const threads = db.prepare("SELECT id FROM memory_deny WHERE kind='thread' ORDER BY id").all().map(r => String(r.id));
const jobs0 = n("SELECT count(*) AS n FROM memory_revoke_jobs"), pend0 = pendingRows();
db.exec("BEGIN IMMEDIATE");
let jobsAfterReplay = jobs0, pendAfterReplay = pend0;
try { for (const t of threads) captureThreadDeletion(db, t); jobsAfterReplay = n("SELECT count(*) AS n FROM memory_revoke_jobs"); pendAfterReplay = pendingRows(); }
finally { db.exec("ROLLBACK"); }
say("replay", { threads: threads.length, newJobs: jobsAfterReplay - jobs0, newPending: pendAfterReplay - pend0 });

// W-CHECK: one unscoped card (no mark of its own) and the newest 50 active records of the store
const card = { kind: "card" as const, id: "witness-card-unmarked" };
const recs = db.prepare("SELECT id,version,scope_id FROM memory_records WHERE state='active' ORDER BY rowid DESC LIMIT 50").all()
  .map(r => ({ kind: "record" as const, id: String(r.id), version: Number(r.version), scopeId: String(r.scope_id) }));
const verdicts = memoryLookup(db, [card, ...recs], { audience: null });
const cardVerdict = verdicts.get(memoryRefKey(card));
const tally: Record<string, number> = {};
for (const r of recs) { const v = verdicts.get(memoryRefKey(r)); const k = `${v?.state}${v && "reason" in v ? "/" + v.reason : ""}`; tally[k] = (tally[k] ?? 0) + 1; }
say("check", { card: cardVerdict, records: tally });

const only = process.env.WITNESS ?? "all", on = (w: string) => only === "all" || only === w;
if (on("jobs")) assert.equal(openJobs(), 0, "W-JOBS open revoke jobs");
if (on("jobs")) assert.equal(pendingRows(), 0, "W-JOBS pending windows");
if (on("check")) assert.equal(cardVerdict?.state, "shown", "W-CHECK unscoped card reads checking");
if (on("check")) assert.equal(Object.keys(tally).filter(k => k.startsWith("checking")).length, 0, "W-CHECK a live record reads checking");
if (on("replay")) assert.equal(jobsAfterReplay - jobs0, 0, "W-REPLAY replay commits a new revoke job");
if (on("replay")) assert.equal(pendAfterReplay - pend0, 0, "W-REPLAY replay commits pending windows");
say("PASS", only);
