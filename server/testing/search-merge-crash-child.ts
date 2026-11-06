// SPDX-License-Identifier: AGPL-3.0-or-later
// T14 child (search-merge-crash.test.ts): a real server-side stack (database.ts, message-db.ts, the real wal-maintenance worker and the
// search merge scheduler) on MURAGE_DATA_DIR. It builds the fixture, deletes the conversation, lets the scheduler run until the named
// stage, prints `STAGE <name>` and then stops posting merge ops and waits. The parent SIGKILLs it there: no orderly close, no checkpoint
// on the way out; the file and its -wal are left exactly as the crash left them.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../config.ts";
import { database, transaction } from "../database.ts";
import { deleteThread, insertMessage } from "../message-db.ts";
import { resumeSearchMerge, searchMergeFastPath, searchMergeTestHooks } from "../search-merge-runner.ts";
import { scrubWalAfterDelete, settleWal, walMaintenanceReady, walMaintenanceTestHooks, walMark, walScrubbed } from "../wal-maintenance.ts";
import type { Message } from "../store.ts";

const stage = process.argv[2] ?? "";
let clock = 1_000;
const msg = (id: string, text: string): Message => ({ id, role: "user", kind: "text", text, at: ++clock });
const say = (line: string) => process.stdout.write(`${line}\n`);
const until = async (ok: () => boolean, ms = 20_000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) throw new Error(`timed out before ${stage}`); await new Promise(r => setTimeout(r, 10)); } };

// scrubbed-then-prove: the worker's 1 s idle tick runs a PASSIVE whenever the log grew, and the next commit after a full copy
// restarts the log (journal_size_limit=0). A tick that lands between the slices restarts the log under the later slices and
// overwrites the frames that held deleted bytes; whether one lands depends on how long the slices take on that machine (macOS
// runners, 11-03). A reader holding a read mark inside the log forbids any restart, so every slice's frames stay in the -wal until
// the kill, on every OS. The reader dies with the process, so the next start sees exactly what a crash leaves.
let pinReader: DatabaseSync | null = null;
async function pinLog() {
  const walFile = join(DATA_DIR, "messages.db-wal");
  for (let attempt = 0; attempt < 50; attempt++) {
    pinReader ??= new DatabaseSync(join(DATA_DIR, "messages.db"));
    pinReader.exec("BEGIN");
    pinReader.prepare("SELECT count(*) AS n FROM sqlite_master").get();
    const mark = walMark(walFile);
    // proven pinned: a full copy and a fresh commit, and the log still carries the same generation (a reader on an empty or
    // fully copied log reads the file alone and pins nothing; that commit then restarts the log and the read is taken again)
    if (mark && mark !== "unknown" && await settleWal({ nudge: true, deadlineAt: Date.now() + 2000 }) && !walScrubbed(walFile, mark)) return;
    pinReader.exec("COMMIT");
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error("could not hold a reader inside the log");
}

async function main() {
  walMaintenanceTestHooks.retryMs = 50;
  searchMergeTestHooks.kickMs = 10;
  searchMergeTestHooks.startPages = 1; // many slices: the kill lands inside a run
  database();
  await until(() => walMaintenanceReady() && searchMergeFastPath());
  // kept and deleted rows in the same transactions (mixed segments)
  searchMergeTestHooks.halt = true;
  for (let r = 0; r < 16; r++) transaction(() => {
    for (let i = 0; i < 30; i++) insertMessage("keep", msg(`k-${r}-${i}`, `kept${r}x${i} alpha bravo charlie ${r * 31 + i}`));
    for (let i = 0; i < 6; i++) insertMessage("gone", msg(`g-${r}-${i}`, "жжж"));
  });
  let slices = 0, settled = false;
  searchMergeTestHooks.onEvent = event => {
    if (event.kind === "first" || event.kind === "slice") slices++;
    if (event.kind === "prove" && event.reply?.settled) settled = true;
    if (stage === "mid-run" && slices >= 3) searchMergeTestHooks.halt = true;
    if ((stage === "after-prove" || stage === "scrubbed-then-prove") && settled) searchMergeTestHooks.halt = true;
  };
  deleteThread("gone");
  if (stage === "after-delete") { say("STAGE after-delete"); return; }
  if (stage === "scrubbed-then-prove") {
    // the deletion's own scrub completes first: the rows' frames are out of the log before any slice runs
    if (!(await scrubWalAfterDelete(10_000))) throw new Error("the initial scrub did not finish");
    say("INITIAL-SCRUB done");
    await pinLog();
  }
  // from here the idle retry does not restart the log: the kill after the proof lands before the post-prove scrub
  if (stage === "after-prove" || stage === "scrubbed-then-prove") walMaintenanceTestHooks.retryMs = 600_000;
  searchMergeTestHooks.halt = false; resumeSearchMerge();
  if (stage === "mid-run") { await until(() => slices >= 3 && !settled); say("STAGE mid-run"); return; }
  await until(() => settled);
  say(`STAGE ${stage}`);
}
main().then(() => setInterval(() => {}, 1000), error => { say(`ERROR ${error instanceof Error ? error.stack : error}`); process.exit(3); });
