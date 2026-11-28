// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: mem-f6 (1.0.21 memory audit F6). Producer side (capture.ts captureSource/captureMessage): mem-f6. Consumer side (the checkpoint
// debt driver, worker-controller.ts recoverCheckpoints, and the recall view journal, recall-view-schema.ts): recall-fix-j / recall-scope.
//
// What a 20-step turn costs memory. Before: every tool row was captured twice (running, then complete), every tool outcome and the turn's
// own settlement row went through a full job lifecycle (claim, lease, helper, publish) although the capture stage writes nothing for them,
// and a patch with the same payload rewrote the stored payload. The counts below are measured on the real connection with many recall
// views built and a standing queue of other work, and logged as one line (W-F6-COST) so the drop is on record.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeDatabase, database, transaction } from "../database.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { captureMessage } from "./capture.ts";
import { captureWork } from "./chunks.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { forgetMemory } from "./forget.ts";
import { drainRevokeMarker } from "./memory-revocation.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { ioBudget } from "../io-budget.ts";
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { prepareRecallContextSync, stopRecallViewMaintenance } from "./recall-view.ts";
import { setMemoryMode } from "./repository.ts";
import { recordMemorySettlement } from "./settlement.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";
import { freshDataDir } from "./testing/recall-fixture.ts";
import { WritetimeFixture } from "./testing/writetime-fixture.ts";
import { settleFixtureRecallViews } from "../testing/recall-access-fixture.ts";
import type { Message } from "../store.ts";

const VIEWS = 24, QUEUE = 300, STEPS = 20, T = "t-0", TURN = "turn-1";
const roster: MemoryRoster = { memoryRosterRevision: 1, bots: Array.from({ length: VIEWS }, (_, n) => ({ id: `bot-${n}`, threadId: `t-${n}` })), groups: [] };

beforeEach(() => {
  freshDataDir("active"); reconcileMemoryRoster(roster); setMemoryMode("active"); stopRecallViewMaintenance();
  const fixture = new WritetimeFixture(database()).cert(true);
  for (const bot of roster.bots) fixture.ready(bot.threadId, true);
});
afterEach(() => { stopRecallViewMaintenance(); closeDatabase(); });

/** Every statement run on the real connection: how many, how many write transactions, and the row changes of statements that write memory_jobs. */
function meter(db: DatabaseSync) {
  const seen = { statements: 0, commits: 0, jobUpdates: 0, payloadRewrites: 0 };
  const prepare = db.prepare.bind(db), exec = db.exec.bind(db);
  (db as { prepare: (sql: string) => StatementSync }).prepare = (sql: string) => {
    const statement = prepare(sql), jobUpdate = /^\s*UPDATE\s+memory_jobs\b/i.test(sql), payload = /^\s*UPDATE\s+memory_source_versions\b/i.test(sql);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (key === "run" || key === "get" || key === "all") seen.statements++;
        if (key === "run" && jobUpdate) seen.jobUpdates += Number((result as { changes: number | bigint }).changes);
        if (key === "run" && payload) seen.payloadRewrites += Number((result as { changes: number | bigint }).changes);
        return result;
      };
    } });
  };
  (db as { exec: (sql: string) => void }).exec = (sql: string) => { seen.statements++; if (/^\s*COMMIT\b/i.test(sql)) seen.commits++; exec(sql); };
  return { seen, restore: () => { delete (db as { prepare?: unknown }).prepare; delete (db as { exec?: unknown }).exec; } };
}
const count = (db: DatabaseSync, sql: string, ...args: string[]) => Number(db.prepare(sql).get(...args)!.n);
const totals = (db: DatabaseSync) => ({
  changes: count(db, "SELECT total_changes() AS n"),
  journal: count(db, "SELECT COALESCE(MAX(sequence),0) AS n FROM memory_recall_changes"),
  jobs: count(db, "SELECT count(*) AS n FROM memory_jobs"), versions: count(db, "SELECT count(*) AS n FROM memory_source_versions"),
  sources: count(db, "SELECT count(*) AS n FROM memory_sources"), records: count(db, "SELECT count(*) AS n FROM memory_records"),
});
const write = (db: DatabaseSync, message: Partial<Message> & { id: string }) => transaction(() => {
  storeAnchorMessage(db, T, message.id, message.text ?? "", message.role === "user" ? "user" : "bot");
  captureMessage(db, T, { at: 1, ...message } as Message);
});
/** One turn as the server writes it: the prompt, the turn's working row, each tool row first running then complete, the reply, the settlement. */
function runTurn(db: DatabaseSync, running = true) {
  write(db, { id: "prompt", role: "user", kind: "text", text: "Please tidy the notes folder and tell me what changed." });
  recordMemorySettlement(T, TURN, "working");
  for (let step = 0; step < STEPS; step++) {
    const row = { id: `tool-${step}`, role: "bot" as const, kind: "activity" as const, turnId: TURN, parentId: step ? `tool-${step - 1}` : "prompt" };
    if (running) write(db, { ...row, tool: { name: "read_file" } } as never);
    write(db, { ...row, text: `notes-${step}.md: ${step + 3} lines kept`, tool: { name: "read_file", ok: true } } as never);
  }
  write(db, { id: "reply", role: "bot", kind: "text", turnId: TURN, turnTerminal: true, parentId: null, text: "All twenty notes are tidy now." } as never);
  recordMemorySettlement(T, TURN, "completed");
}
const openTurnJobs = (db: DatabaseSync) => db.prepare(`SELECT j.id,s.kind FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision
  WHERE s.thread_id=? AND j.status IN ('pending','partial','deferred','leased') ORDER BY j.rowid`).all(T).map(row => ({ id: String(row.id), kind: String(row.kind) }));
const debts = (db: DatabaseSync) => db.prepare("SELECT id FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='checkpoint-pending' ORDER BY rowid").all().map(row => String(row.id).slice("checkpoint-debt:".length));
/** The worker's part, by the same calls it makes: claim each open job of the turn by id, chunk it, publish it, then every owed checkpoint. */
function settleTurn(db: DatabaseSync) {
  let claimed = 0;
  for (const job of openTurnJobs(db)) {
    const work = claimMemoryJob("worker", Date.now(), undefined, { jobId: job.id });
    if (!work) continue;
    publishMemoryWork(work, "worker", captureWork(work)); claimed++;
  }
  // as the controller does (worker-controller.ts refreshCheckpoint): a marker already gone is not rolled again
  for (const jobId of debts(db)) if (debts(db).includes(jobId)) refreshMemoryCheckpoint(jobId);
  return claimed;
}
/** The thread's working notes as they stand: the head record's text and its member handles. */
const headNotes = (db: DatabaseSync) => {
  const row = db.prepare("SELECT r.text,m.handles FROM memory_checkpoint_heads h JOIN memory_records r ON r.id=h.record_id AND r.version=h.record_version JOIN memory_checkpoint_members m ON m.record_id=r.id AND m.record_version=r.version WHERE h.thread_id=?").get(T)!;
  return { text: String(row.text), handles: JSON.parse(String(row.handles)) as unknown };
};
/** Other work already waiting in another scope, and one recall view per bot: the turn's cost must not ride on either. */
function standingFixture(db: DatabaseSync) {
  const elsewhere = ensureScope("conversation", "elsewhere");
  const source = db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,?,'text','owner','recorded',NULL,'active')");
  const version = db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,1)");
  const job = db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1','pending',0,0,0,0,0)");
  transaction(() => { for (let n = 0; n < QUEUE; n++) { source.run(`queued-${n}`, elsewhere, "elsewhere", `q${n}`, `h${n}`); version.run(`queued-${n}`, `h${n}`, JSON.stringify({ text: `queued ${n}` })); job.run(`queued-job-${n}`, `queued-${n}`); } });
  for (const bot of roster.bots) prepareRecallContextSync(bot.id, bot.threadId, roster);
  settleFixtureRecallViews();
  expect(count(db, "SELECT count(*) AS n FROM memory_recall_views WHERE state='ready'")).toBeGreaterThanOrEqual(VIEWS);
}

it("W-F6-COST a 20-step turn writes one source, one version and one job per tool call, and its tool and turn jobs are born complete: no lease, no publish, whatever is queued", () => {
  const db = database(); standingFixture(db);
  const before = totals(db), { seen, restore } = meter(db);
  let open: Array<{ id: string; kind: string }>, claimed: number, replay: number;
  try {
    runTurn(db);
    open = openTurnJobs(db);
    claimed = settleTurn(db);
    const at = seen.statements; settleFixtureRecallViews(); replay = seen.statements - at;
  } finally { restore(); }
  const after = totals(db);
  const measured = { views: VIEWS, queued: QUEUE, steps: STEPS, statements: seen.statements - replay, viewReplayStatements: replay, commits: seen.commits, rowChanges: after.changes - before.changes,
    journalRows: after.journal - before.journal, jobs: after.jobs - before.jobs, jobUpdates: seen.jobUpdates, claimed, sourceVersions: after.versions - before.versions,
    sources: after.sources - before.sources, records: after.records - before.records, openAfterCapture: open.length };
  console.log("W-F6-COST", JSON.stringify(measured));
  // What people said still goes through the capture stage; nothing else of the turn waits in the queue.
  expect(open.map(job => job.kind)).toEqual(["text", "text"]);
  expect(claimed).toBe(2);
  // One source, one version and one job per message that is captured: the prompt, each tool call once, the reply; the turn row has two (working, settled).
  expect(measured.sources).toBe(STEPS + 3);
  expect(measured.sourceVersions).toBe(STEPS + 4);
  expect(measured.jobs).toBe(STEPS + 4);
  // A lease and a publish for each of the two claimed jobs, and nothing else ever rewrites a job row.
  expect(measured.jobUpdates).toBe(2 * claimed);
  // The standing queue was not touched, and the turn is fully settled: no open job, no owed checkpoint.
  expect(count(db, "SELECT count(*) AS n FROM memory_jobs WHERE id LIKE 'queued-job-%' AND status='pending'")).toBe(QUEUE);
  expect(openTurnJobs(db)).toEqual([]);
  expect(debts(db)).toEqual([]);
  // What the turn is for is unchanged: the two things said are records, the tool outcomes and the turn are not, and the thread's working notes still quote the tools.
  expect(count(db, "SELECT count(*) AS n FROM memory_records WHERE kind='source'")).toBe(2);
  // memv2 E3: the thread's notes are rolled once for the whole turn (f6ae52c670: one checkpoint record per owed job, 22 for this turn)
  expect(count(db, "SELECT count(*) AS n FROM memory_records WHERE kind='checkpoint'")).toBe(1);
  expect(measured.records).toBe(3);
  const notes = String(db.prepare("SELECT r.text FROM memory_checkpoint_heads h JOIN memory_records r ON r.id=h.record_id AND r.version=h.record_version WHERE h.thread_id=?").get(T)!.text);
  expect(notes).toContain("Observed tool outcome (completed)");
  expect(notes).toContain(`notes-${STEPS - 1}.md`);
  const tool = db.prepare("SELECT j.status,j.cursor,j.coverage,j.lease_generation,octet_length(CAST(json_extract(v.payload,'$.text') AS BLOB)) AS bytes FROM memory_jobs j JOIN memory_source_versions v ON v.source_id=j.source_id AND v.revision=j.source_revision WHERE j.source_id=?").get(`message:${T}:tool-3`)!;
  expect({ status: tool.status, covered: tool.cursor === tool.bytes, coverage: JSON.parse(String(tool.coverage)), leases: tool.lease_generation }).toEqual({ status: "complete", covered: true, coverage: { throughByte: tool.bytes, totalBytes: tool.bytes }, leases: 0 });
}, 180_000);

it("W-F6-SAME a patch that changes nothing in the stored payload writes nothing; one that adds metadata still merges it", () => {
  const db = database();
  const row = { id: "said", role: "bot" as const, kind: "activity" as const, turnId: TURN, text: "notes.md: 3 lines", tool: { name: "read_file", ok: true } };
  write(db, row as never);
  const { seen, restore } = meter(db), before = count(db, "SELECT total_changes() AS n");
  try { for (let n = 0; n < 5; n++) transaction(() => captureMessage(db, T, { at: 1, ...row } as never)); } finally { restore(); }
  console.log("W-F6-SAME", JSON.stringify({ patches: 5, payloadRewrites: seen.payloadRewrites, rowChanges: count(db, "SELECT total_changes() AS n") - before }));
  expect(seen.payloadRewrites).toBe(0);
  expect(count(db, "SELECT total_changes() AS n") - before).toBe(0);
  transaction(() => captureMessage(db, T, { at: 1, ...row, actionCheck: { status: "verified" } } as never));
  const payload = JSON.parse(String(db.prepare("SELECT payload FROM memory_source_versions WHERE source_id=?").get(`message:${T}:said`)!.payload));
  expect(payload.actionCheck).toEqual({ status: "verified" });
  expect(count(db, "SELECT count(*) AS n FROM memory_source_versions WHERE source_id=?", `message:${T}:said`)).toBe(1);
});

it("W-F6-RUNNING a tool row still running is not a source; it is captured once, when it has its outcome, and a failed or interrupted one as before", () => {
  const db = database();
  write(db, { id: "run", role: "bot", kind: "activity", turnId: TURN, tool: { name: "read_file" } } as never);
  expect(count(db, "SELECT count(*) AS n FROM memory_sources")).toBe(0);
  expect(count(db, "SELECT count(*) AS n FROM memory_jobs")).toBe(0);
  write(db, { id: "run", role: "bot", kind: "activity", turnId: TURN, text: "boom", tool: { name: "read_file", ok: false, errorDetails: "ENOENT" } } as never);
  const failed = db.prepare("SELECT s.revision,s.kind,s.outcome,j.status FROM memory_sources s JOIN memory_jobs j ON j.source_id=s.id WHERE s.id=?").get(`message:${T}:run`)!;
  expect({ ...failed }).toEqual({ revision: 1, kind: "tool-outcome", outcome: "failed", status: "complete" });
  // an activity row that is not a tool call (a kind memory does not learn from) keeps its excluded row, as before
  write(db, { id: "other", role: "bot", kind: "activity", turnId: TURN, text: "thinking" } as never);
  expect(JSON.parse(String(db.prepare("SELECT payload FROM memory_source_versions WHERE source_id=?").get(`message:${T}:other`)!.payload)).excluded).toBe("unsupported-activity");
});

it("W-F6-FENCE a job is born complete only where a publish would be accepted now: a source off the branch keeps the claimable job that parks and restores with it", () => {
  const db = database();
  transaction(() => { storeAnchorMessage(db, T, "off", "", "bot"); captureMessage(db, T, { id: "off", at: 1, role: "bot", kind: "activity", text: "old branch", tool: { name: "read_file", ok: true } } as never, "retired"); });
  const off = db.prepare("SELECT s.state,j.status FROM memory_sources s JOIN memory_jobs j ON j.source_id=s.id WHERE s.id=?").get(`message:${T}:off`)!;
  expect({ ...off }).toEqual({ state: "retired", status: "pending" });
  expect(debts(db)).toEqual([]);
  // a branch change of the thread still being flipped: every reader withholds its sources (deny.ts), and a publish would be refused
  db.exec("CREATE TABLE IF NOT EXISTS branch_change(thread_id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT NOT NULL, leave_at TEXT, join_at TEXT, leave_done INTEGER NOT NULL DEFAULT 0, join_done INTEGER NOT NULL DEFAULT 0, all_cursor TEXT) WITHOUT ROWID");
  db.prepare("INSERT INTO branch_change(thread_id,to_id) VALUES(?,'leaf')").run(T);
  write(db, { id: "moving", role: "bot", kind: "activity", turnId: TURN, text: "mid change", tool: { name: "read_file", ok: true } } as never);
  recordMemorySettlement(T, "turn-moving", "completed");
  const moving = db.prepare("SELECT s.kind,j.status FROM memory_sources s JOIN memory_jobs j ON j.source_id=s.id WHERE s.id IN (?,?) ORDER BY s.kind").all(`message:${T}:moving`, `turn:${T}:turn-moving`).map(row => ({ ...row }));
  expect(moving).toEqual([{ kind: "tool-outcome", status: "pending" }, { kind: "turn", status: "pending" }]);
  expect(debts(db)).toEqual([]);
  // the change is done: the same rows written now are complete at once, each owing its checkpoint
  db.exec("DELETE FROM branch_change");
  write(db, { id: "settled", role: "bot", kind: "activity", turnId: TURN, text: "after change", tool: { name: "read_file", ok: true } } as never);
  expect(db.prepare("SELECT j.status FROM memory_jobs j WHERE j.source_id=?").get(`message:${T}:settled`)!.status).toBe("complete");
  expect(debts(db)).toHaveLength(1);
});

it("W-F6-REVISED a tool outcome revised before its checkpoint rolled owes one checkpoint, for the revision it has now", () => {
  const db = database();
  const row = { id: "twice", role: "bot" as const, kind: "activity" as const, turnId: TURN, tool: { name: "read_file", ok: true } };
  write(db, { ...row, text: "first answer" } as never);
  const first = debts(db);
  write(db, { ...row, text: "second answer" } as never);
  const second = debts(db);
  expect(first).toHaveLength(1); expect(second).toHaveLength(1); expect(second).not.toEqual(first);
  expect(refreshMemoryCheckpoint(second[0]!).status).toBe("updated");
  expect(debts(db)).toEqual([]);
  const notes = String(db.prepare("SELECT r.text FROM memory_checkpoint_heads h JOIN memory_records r ON r.id=h.record_id AND r.version=h.record_version WHERE h.thread_id=?").get(T)!.text);
  expect(notes).toContain("second answer"); expect(notes).not.toContain("first answer");
});

it("W-F6-FORGET a forget lands at once on a tool outcome whose job was born complete: its owed checkpoint never quotes it, before or after the notes were rolled", () => {
  const db = database(), ticket = ownerMemoryTicket();
  const tool = (id: string, text: string) => write(db, { id, role: "bot", kind: "activity", turnId: TURN, text, tool: { name: "read_file", ok: true } } as never);
  const notes = () => db.prepare("SELECT r.text,r.state FROM memory_checkpoint_heads h JOIN memory_records r ON r.id=h.record_id AND r.version=h.record_version WHERE h.thread_id=?").get(T);
  // a source that is gone has no checkpoint to roll; any other error fails the test by name (FABLE memv2-E 6e1ce27049 M1: a blanket catch
  // here hid whatever skipped a roll, and the test then failed later as "expected '' to contain ..."). Each roll's outcome is returned.
  const rollOwed = () => debts(db).map(jobId => {
    try { const outcome = refreshMemoryCheckpoint(jobId); return outcome.reason ? `${outcome.status}:${outcome.reason}` : outcome.status; }
    catch (error) { if (/^MEMORY_(SOURCE_UNAVAILABLE|COMPLETED_SOURCE_REQUIRED)$/.test(String((error as Error).message))) return "gone"; throw error; }
  });
  // forgotten while the checkpoint is still owed
  tool("secret", "the door code is 4471");
  expect(debts(db)).toHaveLength(1);
  forgetMemory(ticket, { kind: "source", id: `message:${T}:secret` });
  // the forget marks its revoke inline for at most 8 ms (revoke-commit.ts markInline, INLINE_REVOCATION); on a loaded machine the rest is
  // the runner's, and until it is done the thread's later lines read "checking" and the roll waits (deferred:evidence-checking). The
  // runner's drain, as it runs in the background (FABLE memv2-E 6e1ce27049 M1: this test assumed the inline pass always finished)
  expect(drainRevokeMarker(db).pending).toBe(false);
  rollOwed();
  expect(String(notes()?.text ?? "")).not.toContain("4471");
  // never written anywhere, in any state: the owed roll found no evidence it may quote
  expect(count(db, "SELECT count(*) AS n FROM memory_records WHERE text LIKE '%4471%'")).toBe(0);
  expect(notes()).toBeUndefined();
  // forgotten after the notes quoted it: the next roll drops it
  tool("kept", "the bins go out on Tuesday");
  tool("later", "the alarm code is 9902");
  rollOwed();
  // the forgotten job left owing is not in the roll's range: it would read "checking" and hold the roll (consolidate.ts cover)
  expect(String(notes()?.text ?? ""), "the roll is not held by the forgotten job").toContain("9902");
  forgetMemory(ticket, { kind: "source", id: `message:${T}:later` });
  expect(drainRevokeMarker(db).pending).toBe(false);
  expect(count(db, "SELECT count(*) AS n FROM memory_records r WHERE r.text LIKE '%9902%' AND r.state='active' AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=r.id)")).toBe(0);
  tool("after", "the post came at noon");
  expect(rollOwed(), "the roll after the forget wrote the next notes").toContain("updated");
  expect(String(notes()!.text)).not.toContain("9902");
  expect(String(notes()!.text)).toContain("the post came at noon");
});

it("W-E3-FORGET-BATCH one roll covering a thread's owed jobs never quotes a co-owed tool outcome forgotten before the roll", () => {
  const db = database(), ticket = ownerMemoryTicket();
  const tool = (id: string, text: string) => write(db, { id, role: "bot", kind: "activity", turnId: TURN, text, tool: { name: "read_file", ok: true } } as never);
  // three co-owed outcomes; the newest is forgotten while all three still owe the thread's checkpoint. (A forget's pending window
  // covers the thread's lines from the forgotten one on, so lines after it read "checking" and the roll waits: W-F6-FORGET.)
  tool("early", "the plants want water on Friday");
  tool("middle", "the bike lock is in the shed");
  tool("late", "the safe code is 5512");
  // one debt marker for the thread (E3; r4 wrote one per job, so this read 3), naming its first owed job
  expect(debts(db)).toHaveLength(1);
  forgetMemory(ticket, { kind: "source", id: `message:${T}:late` });
  // the marker's roll covers the other owed jobs of the thread (E3): the forgotten one is skipped, never quoted
  const owed = debts(db);
  expect(refreshMemoryCheckpoint(owed[0]!).status).toBe("updated");
  const notes = String(db.prepare("SELECT r.text FROM memory_checkpoint_heads h JOIN memory_records r ON r.id=h.record_id AND r.version=h.record_version WHERE h.thread_id=?").get(T)!.text);
  expect(notes).toContain("the plants want water on Friday");
  expect(notes).toContain("the bike lock is in the shed");
  expect(notes).not.toContain("5512");
  // one roll published both kept jobs and settled the thread's debt; the forgotten job is not published (r4: it kept a marker of its own,
  // whose roll wrote no quote of it either)
  expect(count(db, "SELECT count(*) AS n FROM memory_checkpoint_publications p JOIN memory_jobs j ON j.id=p.job_id WHERE j.source_id IN (?,?)", `message:${T}:early`, `message:${T}:middle`)).toBe(2);
  expect(count(db, "SELECT count(*) AS n FROM memory_checkpoint_publications p JOIN memory_jobs j ON j.id=p.job_id WHERE j.source_id=?", `message:${T}:late`)).toBe(0);
  expect(debts(db)).toEqual([]);
  for (const jobId of debts(db)) { try { refreshMemoryCheckpoint(jobId); } catch { /* a source that is gone has no checkpoint to roll */ } }
  expect(count(db, "SELECT count(*) AS n FROM memory_records WHERE text LIKE '%5512%'")).toBe(0);
  expect(count(db, "SELECT count(*) AS n FROM memory_checkpoint_members WHERE handles LIKE ?", `%message:${T}:late%`)).toBe(0);
});

const toolRow = (db: DatabaseSync, id: string, text: string) => write(db, { id, role: "bot", kind: "activity", turnId: TURN, text, tool: { name: "read_file", ok: true } } as never);
const publishedJobs = (db: DatabaseSync) => count(db, "SELECT count(*) AS n FROM memory_checkpoint_publications p JOIN memory_jobs j ON j.id=p.job_id JOIN memory_sources s ON s.id=j.source_id WHERE s.thread_id=?", T);
const BOUND = 2 * 65536;
const jobOf = (db: DatabaseSync, id: string) => String(db.prepare("SELECT id FROM memory_jobs WHERE source_id=? ORDER BY rowid DESC LIMIT 1").get(`message:${T}:${id}`)!.id);
/** One admitted tick of the real debt driver (worker-controller.ts recoverCheckpoints -> refreshCheckpoint); the helper is not spawned. */
function driverTick() {
  const controller = new MemoryWorkerController();
  const internals = controller as unknown as { tick(): void; nextEligibleWorkAt: number; pendingProjection(): boolean; spawnWithReset(): void };
  vi.spyOn(internals, "pendingProjection").mockReturnValue(false);
  vi.spyOn(internals, "spawnWithReset").mockImplementation(() => {});
  vi.spyOn(controller, "completedSource").mockImplementation(() => {});
  try { internals.nextEligibleWorkAt = 0; ioBudget.withSource("memory-worker", () => internals.tick()); } finally { void controller.stop(); vi.restoreAllMocks(); }
}
/** The helper's part for every open job of the thread (claim by id, chunk, publish), without the checkpoint rolls. */
const settleOpen = (db: DatabaseSync) => {
  // a long text is captured in slices: each publish of a partial job leaves it claimable again
  for (let pass = 0; pass < 64 && openTurnJobs(db).length; pass++)
    for (const job of openTurnJobs(db)) { const work = claimMemoryJob("worker", Date.now(), undefined, { jobId: job.id }); if (work) publishMemoryWork(work, "worker", captureWork(work)); }
  expect(openTurnJobs(db), "every capture of the thread completed").toEqual([]);
}; // terminal.ts: the serving thread's synchronous capture bounds what SQLite parses
it("W-E3-ALL one roll covers EVERY owed job of the thread, past 64, and settles its debt", () => {
  const db = database();
  for (let n = 0; n < 70; n++) toolRow(db, `many-${n}`, `step ${n} kept`);
  // the newest job's own roll, as the capture's refresh asks for it: the marker another job of the thread holds goes with it
  refreshMemoryCheckpoint(String(db.prepare("SELECT id FROM memory_jobs WHERE source_id=?").get(`message:${T}:many-69`)!.id));
  // r4 capped a roll at 64 other jobs: 5 of these 70 still owed a roll of their own
  expect(debts(db), "no job of the thread still owes after the one roll").toEqual([]);
  expect(publishedJobs(db), "every owed job published to the one record").toBe(70);
  expect(count(db, "SELECT count(*) AS n FROM memory_records WHERE kind='checkpoint'")).toBe(1);
  expect(String(headNotes(db).text)).toContain("step 69 kept");
});
it("W-E3-ONE-MARKER a thread's checkpoint debt is one marker, naming a complete job of the thread an older build can roll", () => {
  const db = database();
  runTurn(db);
  const owed = debts(db);
  // r4 wrote one marker per tool and turn job: 21 for this turn
  expect(owed, "one marker for the thread").toHaveLength(1);
  const marker = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(`checkpoint-debt:${owed[0]}`)!;
  const intent = JSON.parse(String(marker.intent));
  const job = db.prepare("SELECT j.status,j.stage,j.source_id,j.source_revision,s.thread_id FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision WHERE j.id=?").get(owed[0]!)!;
  // f6ae52c670's debt driver reads exactly these fields and rolls that job (worker-controller.ts refreshCheckpoint)
  expect({ jobId: intent.jobId, sourceId: intent.sourceId, revision: intent.revision, threadId: intent.threadId }).toEqual({ jobId: owed[0], sourceId: job.source_id, revision: job.source_revision, threadId: T });
  expect({ status: job.status, stage: job.stage }).toEqual({ status: "complete", stage: "capture" });
  settleTurn(db);
  expect(debts(db)).toEqual([]);
  // every job the turn completed published to the thread's notes: the prompt (published by the helper after the tool jobs owed) included
  expect(count(db, `SELECT count(*) AS n FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision WHERE s.thread_id=? AND j.status='complete'
    AND NOT EXISTS(SELECT 1 FROM memory_checkpoint_publications p WHERE p.job_id=j.id)`, T), "a complete job of the turn left unpublished").toBe(0);
});
it("W-E3-MOVE a revised source hands its thread's marker to the next owed job: the other owed jobs are still rolled", () => {
  const db = database();
  toolRow(db, "a", "alpha first"); toolRow(db, "b", "bravo kept"); toolRow(db, "c", "charlie kept");
  const first = debts(db);
  expect(first).toHaveLength(1);
  toolRow(db, "a", "alpha revised");
  const moved = debts(db);
  expect(moved).toHaveLength(1);
  expect(moved).not.toEqual(first);
  refreshMemoryCheckpoint(moved[0]!);
  const notes = String(headNotes(db).text);
  expect(notes, "the thread's other owed jobs kept the debt").toContain("bravo kept");
  expect(notes).toContain("charlie kept");
  expect(notes).toContain("alpha revised");
  expect(notes).not.toContain("alpha first");
  expect(debts(db)).toEqual([]);
});
it("W-E3-RETIRE a source that leaves the branch hands its thread's marker to an active job, which an older build can still roll", () => {
  const db = database();
  toolRow(db, "a", "alpha kept"); toolRow(db, "b", "bravo kept");
  const first = debts(db);
  transaction(() => captureMessage(db, T, { at: 1, id: "a", role: "bot", kind: "activity", turnId: TURN, text: "alpha kept", tool: { name: "read_file", ok: true } } as never, "retired"));
  const moved = debts(db);
  expect(moved).toHaveLength(1);
  const named = db.prepare("SELECT s.id,s.state FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE j.id=?").get(moved[0]!)!;
  // f6ae52c670 refuses a marker whose job's source is not active (MEMORY_CHECKPOINT_SOURCE_UNAVAILABLE) on every pass
  expect({ id: named.id, state: named.state }, "the marker names an active job").toEqual({ id: `message:${T}:b`, state: "active" });
  expect(moved).not.toEqual(first);
  refreshMemoryCheckpoint(moved[0]!);
  expect(String(headNotes(db).text)).toContain("bravo kept");
  expect(debts(db)).toEqual([]);
});
it("W-E3-ANCHOR-GONE a marker whose own job was forgotten holds nothing: the thread's other job owes through its own and the debt driver rolls it, never quoting the forgotten one", () => {
  const db = database(), ticket = ownerMemoryTicket();
  // the owner's prompt waits for the helper while a tool outcome after it takes the thread's marker; then that outcome is forgotten
  write(db, { id: "ask", role: "user", kind: "text", text: "Please water the ferns on Monday." });
  toolRow(db, "gone", "the vault code is 3141");
  const owed = debts(db);
  expect(owed).toHaveLength(1);
  forgetMemory(ticket, { kind: "source", id: `message:${T}:gone` });
  settleOpen(db);
  // the forgotten job's marker can no longer roll: the prompt's publish owes through a marker of its own (checkpoint-debt.ts threadDebtMarker)
  expect(debts(db), "the prompt owes through a marker that can roll").toEqual([...owed, jobOf(db, "ask")]);
  // the roll of the forgotten job itself is refused, as before (consolidate.ts completedSource)
  expect(() => refreshMemoryCheckpoint(owed[0]!)).toThrow();
  driverTick();
  const notes = db.prepare("SELECT r.text FROM memory_checkpoint_heads h JOIN memory_records r ON r.id=h.record_id AND r.version=h.record_version WHERE h.thread_id=?").get(T);
  expect(String(notes?.text ?? ""), "the thread's other owed job was rolled").toContain("water the ferns");
  expect(String(notes!.text)).not.toContain("3141");
  expect(count(db, "SELECT count(*) AS n FROM memory_records WHERE text LIKE '%3141%'")).toBe(0);
  expect(debts(db)).toEqual([]);
});
it("W-E3-HANDOVER the debt driver hands a thread's marker whose own job left the branch to the thread's next owed job and rolls it", () => {
  const db = database();
  toolRow(db, "a", "alpha first"); toolRow(db, "b", "bravo kept");
  // b was owed through a's marker (the thread already owed): no row of its own
  expect(debts(db)).toEqual([jobOf(db, "a")]);
  // a's source leaves without a capture (another writer's flip, as an idle replay of an older build does): a's job can no longer roll
  db.prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(`message:${T}:a`);
  driverTick();
  const notes = db.prepare("SELECT r.text FROM memory_checkpoint_heads h JOIN memory_records r ON r.id=h.record_id AND r.version=h.record_version WHERE h.thread_id=?").get(T);
  expect(String(notes?.text ?? ""), "the thread's other owed job was rolled").toContain("bravo kept");
  expect(String(notes!.text)).not.toContain("alpha first");
  expect(debts(db)).toEqual([]);
});
it("W-E3-STUCK a per-job marker an older build left on a job that can no longer roll does not hold the thread's later debt", () => {
  const db = database();
  toolRow(db, "old", "an older outcome");
  // as f6ae52c670 leaves it: its marker has no thread fields, and its source left the branch without a capture (a forget or an idle
  // replay of that build never removes the marker): the debt driver refuses it at every pass
  const stuck = jobOf(db, "old");
  db.prepare("UPDATE memory_scope_bindings SET intent=json_remove(intent,'$.threadId','$.from') WHERE id=?").run(`checkpoint-debt:${stuck}`);
  db.prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(`message:${T}:old`);
  toolRow(db, "next", "bravo kept"); toolRow(db, "later", "charlie kept");
  const owed = debts(db);
  expect(owed, "the thread's later jobs owe through a marker that can roll").toContain(jobOf(db, "next"));
  refreshMemoryCheckpoint(jobOf(db, "next"));
  const notes = String(headNotes(db).text);
  expect(notes).toContain("bravo kept"); expect(notes).toContain("charlie kept"); expect(notes).not.toContain("an older outcome");
  // the thread's roll drained the stuck row too
  expect(debts(db)).toEqual([]);
});
it("W-E3-SINCE-HEAD a job an older build left owing without a marker is covered by the thread's next roll (the debt starts at the head)", () => {
  const db = database();
  toolRow(db, "a", "alpha kept");
  refreshMemoryCheckpoint(debts(db)[0]!);
  toolRow(db, "b", "bravo first"); toolRow(db, "c", "charlie kept");
  expect(debts(db)).toEqual([jobOf(db, "b")]);
  // f6ae52c670's capture of a revision deletes the revised source's markers and hands nothing over (capture.ts:126 there)
  db.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run(`checkpoint-debt:${jobOf(db, "b")}`);
  toolRow(db, "d", "delta kept");
  refreshMemoryCheckpoint(debts(db)[0]!);
  const notes = String(headNotes(db).text);
  expect(notes, "the job left owing without a marker was rolled").toContain("charlie kept");
  expect(notes).toContain("delta kept"); expect(notes).toContain("alpha kept");
  expect(debts(db)).toEqual([]);
});
it("W-E3-BOUND-RANGE a bounded roll reads a bounded range: past 4,096 jobs written since the debt started it waits whole", () => {
  const db = database();
  toolRow(db, "first", "a first outcome");
  // other threads' work written after it: rows the range walk would step over
  const elsewhere = ensureScope("conversation", "elsewhere");
  const source = db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,?,'text','owner','recorded',NULL,'active')");
  const version = db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,1)");
  const job = db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1','pending',0,0,0,0,0)");
  transaction(() => { for (let n = 0; n < 4100; n++) { source.run(`other-${n}`, elsewhere, "elsewhere", `o${n}`, `h${n}`); version.run(`other-${n}`, `h${n}`, JSON.stringify({ text: `other ${n}` })); job.run(`other-job-${n}`, `other-${n}`); } });
  toolRow(db, "second", "a second outcome");
  expect(refreshMemoryCheckpoint(jobOf(db, "second"), { maxPayloadBytes: BOUND }).status, "the bounded roll waits").toBe("deferred");
  expect(debts(db)).toHaveLength(1);
  expect(refreshMemoryCheckpoint(debts(db)[0]!).status).toBe("updated");
  expect(String(headNotes(db).text)).toContain("a first outcome");
  expect(debts(db)).toEqual([]);
});
it("W-E3-BOUND a bounded roll never parses a co-owed job's payload past the bound: it is size-checked first and the roll waits", () => {
  const db = database();
  toolRow(db, "small", "a small outcome");
  // a reply past the bound, captured by the helper as the worker does (claim, chunk, publish): it owes the thread's checkpoint too
  write(db, { id: "huge", role: "bot", kind: "text", text: `big ${"word ".repeat(30_000)}` } as never);
  settleOpen(db);
  const huge = db.prepare("SELECT j.id,octet_length(v.payload) AS bytes FROM memory_jobs j JOIN memory_source_versions v ON v.source_id=j.source_id AND v.revision=j.source_revision WHERE j.source_id=?").get(`message:${T}:huge`)!;
  expect(Number(huge.bytes)).toBeGreaterThan(BOUND);
  expect(String(db.prepare("SELECT status FROM memory_jobs WHERE id=?").get(huge.id)!.status), "the reply's capture is complete: it owes the checkpoint").toBe("complete");
  const small = String(db.prepare("SELECT id FROM memory_jobs WHERE source_id=?").get(`message:${T}:small`)!.id);
  const parsed: string[] = [], prepare = db.prepare.bind(db);
  (db as { prepare: (sql: string) => StatementSync }).prepare = (sql: string) => {
    const statement = prepare(sql);
    if (!/json_extract\(\s*(v\.)?payload/i.test(sql)) return statement;
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function" || !["get", "all", "run", "iterate"].includes(String(key))) return typeof value === "function" ? value.bind(target) : value;
      return (...args: unknown[]) => { if (args.some(arg => arg === huge.id || arg === `message:${T}:huge`)) parsed.push(sql.replace(/\s+/g, " ").slice(0, 80)); return (value as (...a: unknown[]) => unknown).apply(target, args); };
    } });
  };
  let outcome: ReturnType<typeof refreshMemoryCheckpoint>;
  try { outcome = refreshMemoryCheckpoint(small, { maxPayloadBytes: BOUND }); } finally { delete (db as { prepare?: unknown }).prepare; }
  // r4: the batch read the co-owed job through completedSource (json_extract over its whole payload) before any size check
  expect(parsed, "the oversized payload was parsed").toEqual([]);
  expect(outcome.status).toBe("deferred");
  expect(debts(db), "the debt stays for the controller's roll").toHaveLength(1);
});
it("W-E3-BOUND-COUNT a bounded roll does not take on more than 64 co-owed jobs: it waits whole, and the controller's roll covers them", () => {
  const db = database();
  for (let n = 0; n < 70; n++) toolRow(db, `many-${n}`, `step ${n} kept`);
  const owed = debts(db);
  const bounded = refreshMemoryCheckpoint(owed[owed.length - 1]!, { maxPayloadBytes: BOUND });
  // r4: the bounded roll covered 64 others and published (status "updated")
  expect(bounded.status, "the bounded roll waits").toBe("deferred");
  expect(publishedJobs(db)).toBe(0);
  for (const jobId of debts(db)) if (debts(db).includes(jobId)) refreshMemoryCheckpoint(jobId);
  expect(publishedJobs(db)).toBe(70);
  expect(debts(db)).toEqual([]);
});

// E2-W (memv2 4.1 [P]): born-complete jobs and the one roll per thread (E3) leave the thread's notes byte-equal to what f6ae52c670 wrote
// for the same turn (tool outcomes through claim, lease and publish, one roll per job). Both goldens were printed by this test on f6ae52c670
// (W-E2-NOTES lines in the lane's base log). Without running rows the notes must be identical. With them, the one named difference is E1:
// f6ae52c670 captured the running row first: every tool outcome took a second source revision, and the upsert never updates the speaker,
// so a tool outcome first seen running was quoted as an "Assistant hypothesis" while one first seen complete was an "Observed tool outcome".
// Now a turn with running rows writes exactly the notes of the same turn without them (GOLDEN_COMPLETE).
const dataRevision = (db: DatabaseSync) => count(db, "SELECT data_revision AS n FROM memory_meta WHERE id=1");
it("W-E5-REVISION a turn's capture moves data_revision once per thing said, not once per tool row; a revised or retired source still moves it", () => {
  const db = database();
  // f6ae52c670: one bump per captured revision, 44 for this turn (each tool row running, then complete); E1 alone: 24
  let at = dataRevision(db);
  runTurn(db);
  expect(dataRevision(db) - at, "the prompt, the reply and the turn row twice (working, settled)").toBe(4);
  // a tool outcome revised from a revision something may cite: lineage-backfill.ts citedMemo, keyed on data_revision, marks the old one bad
  const row = { id: "tool-0", role: "bot" as const, kind: "activity" as const, turnId: TURN, parentId: "prompt", tool: { name: "read_file", ok: true } };
  at = dataRevision(db);
  write(db, { ...row, text: "notes-0.md: 2 lines kept" } as never);
  expect(Number(db.prepare("SELECT revision FROM memory_sources WHERE id=?").get(`message:${T}:tool-0`)!.revision)).toBe(2);
  expect(dataRevision(db) - at, "a revised tool outcome").toBe(1);
  // a source that leaves the branch with its words unchanged (the idle replay): no longer active, and the memo must see it, in one bump
  at = dataRevision(db);
  transaction(() => captureMessage(db, T, { at: 1, id: "reply", role: "bot", kind: "text", turnId: TURN, turnTerminal: true, parentId: null, text: "All twenty notes are tidy now." } as Message, "retired"));
  expect(String(db.prepare("SELECT state FROM memory_sources WHERE id=?").get(`message:${T}:reply`)!.state)).toBe("retired");
  expect(dataRevision(db) - at, "a retired source").toBe(1);
  // and a retired tool outcome whose words changed is one commit, one bump
  at = dataRevision(db);
  transaction(() => captureMessage(db, T, { at: 1, ...row, text: "notes-0.md: 1 line kept" } as Message, "retired"));
  expect(dataRevision(db) - at, "retired and revised in one capture").toBe(1);
});

const GOLDEN_COMPLETE = "{\"text\":\"Working evidence; statements are not fulfilled commitments.\\nAssistant hypothesis (recorded): \\\"All twenty notes are tidy now.\\\"\\nObserved tool outcome (completed): \\\"read_file\\\\nnotes-19.md: 22 lines kept\\\"\\nObserved tool outcome (completed): \\\"read_file\\\\nnotes-18.md: 21 lines kept\\\"\\nObserved tool outcome (completed): \\\"read_file\\\\nnotes-17.md: 20 lines kept\\\"\",\"handles\":[{\"sourceId\":\"message:t-0:reply\",\"revision\":1,\"startByte\":0,\"endByte\":30},{\"sourceId\":\"message:t-0:tool-19\",\"revision\":1,\"startByte\":0,\"endByte\":36},{\"sourceId\":\"message:t-0:tool-18\",\"revision\":1,\"startByte\":0,\"endByte\":36},{\"sourceId\":\"message:t-0:tool-17\",\"revision\":1,\"startByte\":0,\"endByte\":36}]}";
const GOLDEN_RUNNING = "{\"text\":\"Working evidence; statements are not fulfilled commitments.\\nAssistant hypothesis (recorded): \\\"All twenty notes are tidy now.\\\"\\nAssistant hypothesis (completed): \\\"read_file\\\\nnotes-19.md: 22 lines kept\\\"\\nAssistant hypothesis (completed): \\\"read_file\\\\nnotes-18.md: 21 lines kept\\\"\\nAssistant hypothesis (completed): \\\"read_file\\\\nnotes-17.md: 20 lines kept\\\"\",\"handles\":[{\"sourceId\":\"message:t-0:reply\",\"revision\":1,\"startByte\":0,\"endByte\":30},{\"sourceId\":\"message:t-0:tool-19\",\"revision\":2,\"startByte\":0,\"endByte\":36},{\"sourceId\":\"message:t-0:tool-18\",\"revision\":2,\"startByte\":0,\"endByte\":36},{\"sourceId\":\"message:t-0:tool-17\",\"revision\":2,\"startByte\":0,\"endByte\":36}]}";
/** The two E1 differences, applied to the shipped notes of the turn with running rows. */
const E1_DELTA = (golden: string) => golden.replaceAll("Assistant hypothesis (completed): \\\"read_file", "Observed tool outcome (completed): \\\"read_file").replaceAll('"revision":2', '"revision":1');
it("W-E2-GOLDEN the shipped notes with running rows differ from those without only by E1's two named differences", () => {
  expect(GOLDEN_RUNNING).not.toBe(GOLDEN_COMPLETE);
  expect(E1_DELTA(GOLDEN_RUNNING)).toBe(GOLDEN_COMPLETE);
});
it.each([["without running rows", false], ["with each tool row first running", true]] as const)("W-E2-EQUAL the notes after a 20-step turn %s are byte-equal to the shipped lifecycle's, and written as one checkpoint record", (_name, running) => {
  const db = database();
  runTurn(db, running);
  settleTurn(db);
  const notes = JSON.stringify(headNotes(db));
  console.log("W-E2-NOTES", running, JSON.stringify(notes));
  const checkpoints = count(db, "SELECT count(*) AS n FROM memory_records WHERE kind='checkpoint'");
  console.log("W-E2-ROLLS", JSON.stringify({ running, checkpointRecords: checkpoints }));
  expect(notes).toBe(GOLDEN_COMPLETE);
  expect(debts(db)).toEqual([]);
  expect(checkpoints).toBe(1);
});

it("W-E3-HANDOVER-ROLLABLE a thread's marker is handed only to a job that can roll, never to a failed tool's born-complete job", () => {
  const db = database();
  toolRow(db, "a", "alpha first");
  // a failed tool call: its job is born complete with nothing covered, and it never owed the checkpoint
  write(db, { id: "f", role: "bot", kind: "activity", turnId: TURN, text: "boom", tool: { name: "read_file", ok: false, errorDetails: "ENOENT" } } as never);
  toolRow(db, "b", "bravo kept");
  toolRow(db, "a", "alpha revised");
  const owed = debts(db);
  expect(owed, "the hand-over passed the failed tool's job by").not.toContain(jobOf(db, "f"));
  expect(owed).toEqual([jobOf(db, "b")]);
  refreshMemoryCheckpoint(owed[0]!);
  const notes = String(headNotes(db).text);
  expect(notes).toContain("bravo kept"); expect(notes).toContain("alpha revised");
  expect(debts(db)).toEqual([]);
});
/** One finished tool row on each of `n` other threads, by the real capture: each thread's debt is a marker of its own, written before T's. */
function busyThreads(db: DatabaseSync, n: number) {
  transaction(() => { for (let k = 0; k < n; k++) {
    const thread = `busy-${k}`, row = { id: "tool", role: "bot" as const, kind: "activity" as const, turnId: `busy-turn-${k}`, text: `busy ${k} kept`, tool: { name: "read_file", ok: true } };
    storeAnchorMessage(db, thread, row.id, row.text, "bot");
    captureMessage(db, thread, { at: 1, ...row } as never);
  } });
}
const threadDebts = (db: DatabaseSync, thread = T) => debts(db).filter(id => db.prepare("SELECT 1 FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE j.id=? AND s.thread_id=?").get(id, thread));
it("W-E3-QUEUE-ONE a thread whose marker sits behind 300 other threads' markers still finds it: its next job adds no second marker", () => {
  const db = database();
  busyThreads(db, 300);
  expect(debts(db), "300 other threads each owe through a marker written before this thread's").toHaveLength(300);
  toolRow(db, "a", "alpha kept");
  expect(threadDebts(db)).toEqual([jobOf(db, "a")]);
  toolRow(db, "b", "bravo kept");
  // r5 read the first 256 markers of the whole queue and only then chose the thread: this one sat past them, so b wrote a second marker
  expect(threadDebts(db), "the thread's one marker, found past 256 others").toEqual([jobOf(db, "a")]);
  expect(debts(db)).toHaveLength(301);
});
it("W-E3-QUEUE-ROLL a roll of a thread whose marker sits behind 300 other threads' markers covers the debt from that marker's start", () => {
  const db = database();
  busyThreads(db, 300);
  toolRow(db, "a", "alpha kept"); toolRow(db, "b", "bravo kept");
  expect(refreshMemoryCheckpoint(jobOf(db, "b")).status).toBe("updated");
  const notes = String(headNotes(db).text);
  expect(notes).toContain("bravo kept");
  // r5's roll read the same first 256 markers: it missed this thread's, so its range started at b and a stayed owed
  expect(notes, "the earlier job of the debt was rolled").toContain("alpha kept");
  expect(threadDebts(db), "the thread's marker went with the roll").toEqual([]);
  expect(debts(db), "the other threads' markers are untouched").toHaveLength(300);
});
it("W-E3-OWED-HELD a capture-owed job its thread's marker covers (the marker sits on an earlier job) stays owed while a gate holds the roll", () => {
  const db = database();
  toolRow(db, "a", "alpha kept"); toolRow(db, "b", "bravo kept");
  expect(debts(db), "b owes through a's marker, with no row of its own").toEqual([jobOf(db, "a")]);
  const controller = new MemoryWorkerController();
  const internals = controller as unknown as { captureOwedCheckpoints: Map<string, number>; recoverCaptureOwedCheckpoints(): void; turnHeld(): boolean };
  const held = vi.spyOn(internals, "turnHeld").mockReturnValue(true);
  vi.spyOn(controller, "completedSource").mockImplementation(() => {});
  try {
    internals.captureOwedCheckpoints.set(jobOf(db, "b"), performance.now() + 60_000);
    internals.recoverCaptureOwedCheckpoints();
    // r5 read only b's own marker when the gate answered null: b was dropped from the capture-owed set while its thread still owed
    expect([...internals.captureOwedCheckpoints.keys()], "b is still owed while the turn holds the roll").toEqual([jobOf(db, "b")]);
    held.mockReturnValue(false);
    internals.recoverCaptureOwedCheckpoints();
    expect([...internals.captureOwedCheckpoints.keys()], "the thread's roll covered b: the entry ends").toEqual([]);
    expect(String(headNotes(db).text)).toContain("bravo kept");
    expect(debts(db)).toEqual([]);
  } finally { void controller.stop(); vi.restoreAllMocks(); }
});
it("W-E3-L7 a thread marker the hand-over cannot take (its job is not of the source it names) is refused, never left silent", () => {
  const db = database();
  toolRow(db, "a", "alpha kept"); toolRow(db, "b", "bravo kept");
  const a = jobOf(db, "a"), id = `checkpoint-debt:${a}`;
  // a's marker names b's source: a's job is not of that source, so it reads as unrollable and the hand-over (moveSourceDebt of b's
  // source) never reaches the marker
  db.prepare("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.sourceId',?) WHERE id=?").run(`message:${T}:b`, id);
  const controller = new MemoryWorkerController();
  const internals = controller as unknown as { refreshCheckpoint(jobId: string): unknown };
  vi.spyOn(controller, "completedSource").mockImplementation(() => {});
  try {
    expect(() => internals.refreshCheckpoint(a), "the debt driver says the marker is invalid").toThrow("MEMORY_CHECKPOINT_DEBT_INVALID");
    expect(debts(db), "the refused marker is kept for the driver's refusal path, not dropped").toEqual([a]);
  } finally { void controller.stop(); vi.restoreAllMocks(); }
  // a refused marker does not hold the thread: its next job writes one that can roll, and that roll takes the refused one with it
  toolRow(db, "c", "charlie kept");
  const c = jobOf(db, "c");
  expect(debts(db), "the thread's next job owes through a marker that can roll").toEqual([a, c]);
  expect(refreshMemoryCheckpoint(c).status).toBe("updated");
  expect(String(headNotes(db).text)).toContain("charlie kept");
  expect(debts(db)).toEqual([]);
});
it("W-E3-HEADLESS a thread with no notes record whose earlier jobs were left owing without a marker: the next debt starts at the oldest of them", () => {
  const db = database();
  toolRow(db, "a", "alpha kept"); toolRow(db, "b", "bravo kept");
  expect(debts(db)).toEqual([jobOf(db, "a")]);
  // as an older build leaves it after rolling only the job its marker named and writing no notes (a turn-only marker has nothing to
  // quote): the marker is gone, a and b are unpublished, and the thread has no notes record
  db.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run(`checkpoint-debt:${jobOf(db, "a")}`);
  expect(count(db, "SELECT count(*) AS n FROM memory_checkpoint_heads WHERE thread_id=? AND record_id IS NOT NULL", T)).toBe(0);
  toolRow(db, "c", "charlie kept");
  expect(refreshMemoryCheckpoint(debts(db)[0]!).status).toBe("updated");
  const notes = String(headNotes(db).text);
  expect(notes).toContain("charlie kept");
  // r5's start with no notes record was the new job itself: a and b were never covered
  expect(notes, "the jobs left owing before the debt started were rolled").toContain("alpha kept");
  expect(notes).toContain("bravo kept");
  expect(debts(db)).toEqual([]);
});
it("W-E3-LEGACY-QUEUE an older build's per-job row (no thread named in it), behind 300 other threads' markers, is still found as the thread's marker by its job's source", () => {
  const db = database();
  busyThreads(db, 300);
  toolRow(db, "a", "alpha kept");
  const a = jobOf(db, "a");
  // as f6ae52c670 writes a marker: jobId, sourceId and revision only
  db.prepare("UPDATE memory_scope_bindings SET intent=json_remove(intent,'$.threadId','$.from') WHERE id=?").run(`checkpoint-debt:${a}`);
  toolRow(db, "b", "bravo kept");
  expect(threadDebts(db), "the older build's row is the thread's marker").toEqual([a]);
  expect(refreshMemoryCheckpoint(a).status).toBe("updated");
  const notes = String(headNotes(db).text);
  expect(notes).toContain("alpha kept"); expect(notes).toContain("bravo kept");
  expect(threadDebts(db)).toEqual([]);
});
it("W-E3-START-RANGE a new debt on notes far behind starts at the thread's oldest unpublished job, so the bounded roll does not re-walk what was rolled", () => {
  const db = database();
  toolRow(db, "first", "a first outcome");
  expect(refreshMemoryCheckpoint(debts(db)[0]!).status).toBe("updated");
  // other threads' work written after the notes' newest quoted job: rows a range walk from there would step over
  const elsewhere = ensureScope("conversation", "elsewhere");
  const source = db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,?,'text','owner','recorded',NULL,'active')");
  const version = db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,1)");
  const job = db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1','pending',0,0,0,0,0)");
  transaction(() => { for (let n = 0; n < 4100; n++) { source.run(`other-${n}`, elsewhere, "elsewhere", `o${n}`, `h${n}`); version.run(`other-${n}`, `h${n}`, JSON.stringify({ text: `other ${n}` })); job.run(`other-job-${n}`, `other-${n}`); } });
  toolRow(db, "second", "a second outcome");
  // r5 started the debt at the notes' newest quoted job ("first", already published): the bounded roll counted 4,100 jobs and waited
  expect(refreshMemoryCheckpoint(jobOf(db, "second"), { maxPayloadBytes: BOUND }).status, "the bounded roll covers the new debt").toBe("updated");
  const notes = String(headNotes(db).text);
  expect(notes).toContain("a second outcome"); expect(notes).toContain("a first outcome");
  expect(debts(db)).toEqual([]);
});
it("W-E3-TURN-ONLY a thread whose jobs are only turn rows (never quoted, never published) does not hold a later debt's start, and a turn row's debt there walks nothing", () => {
  const db = database();
  recordMemorySettlement(T, "turn-a", "completed");
  const [first] = debts(db);
  expect(first).toBeDefined();
  // nothing to quote: the roll writes no notes and no publication, and the thread's head row has no record
  expect(refreshMemoryCheckpoint(first!).status).toBe("deferred");
  expect(debts(db)).toEqual([]);
  const walks: string[] = [], prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => { if (sql.includes("FROM memory_jobs j CROSS JOIN memory_sources s")) walks.push(sql); return prepare(sql); }) as typeof db.prepare);
  try { recordMemorySettlement(T, "turn-b", "completed"); } finally { spy.mockRestore(); }
  expect(walks, "a turn row's debt on a thread rolled to no notes walks no window").toEqual([]);
  db.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run(`checkpoint-debt:${debts(db)[0]}`);
  toolRow(db, "b", "bravo kept");
  const [second] = debts(db);
  const from = Number(JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(`checkpoint-debt:${second}`)!.intent)).from);
  const rowid = (id: string) => Number(db.prepare("SELECT rowid AS n FROM memory_jobs WHERE id=?").get(id)!.n);
  expect(from, "the new debt starts at its own job, not at an earlier turn row's").toBe(rowid(second!));
});
it("W-E3-START-BOUND a debt's start is looked up in a bounded window: a job left owing more than 4,096 jobs back does not make every roll walk to it", () => {
  const db = database();
  toolRow(db, "old", "an old outcome");
  // as an older build leaves it: the job owes with no marker, and the thread has no notes record
  db.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run(`checkpoint-debt:${jobOf(db, "old")}`);
  const elsewhere = ensureScope("conversation", "elsewhere");
  const source = db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,?,'text','owner','recorded',NULL,'active')");
  const version = db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,1)");
  const job = db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1','pending',0,0,0,0,0)");
  transaction(() => { for (let n = 0; n < 4100; n++) { source.run(`other-${n}`, elsewhere, "elsewhere", `o${n}`, `h${n}`); version.run(`other-${n}`, `h${n}`, JSON.stringify({ text: `other ${n}` })); job.run(`other-job-${n}`, `other-${n}`); } });
  toolRow(db, "new", "a new outcome");
  // the start lookup reads only the 4,096 jobs before the new one (r5 started at the new job itself: the same bound, nothing older)
  expect(refreshMemoryCheckpoint(jobOf(db, "new"), { maxPayloadBytes: BOUND }).status, "the bounded roll is not sent back past the window").toBe("updated");
  expect(String(headNotes(db).text)).toContain("a new outcome");
  expect(debts(db)).toEqual([]);
});
it("W-E3-TOMBSTONED a co-owed job whose source has a tombstone while its row still reads active is not covered: never published, never quoted", () => {
  const db = database();
  toolRow(db, "a", "alpha kept"); toolRow(db, "b", "the gate code is 7731"); toolRow(db, "c", "charlie kept");
  // the forget's first write, before its own handling takes the source off the branch (forget.ts: the tombstone row, the source still active)
  db.prepare("INSERT INTO memory_tombstones VALUES('fixture-tombstone','source',?,NULL,NULL,1,'owner-forget',?)").run(`message:${T}:b`, Date.now());
  expect(String(db.prepare("SELECT state FROM memory_sources WHERE id=?").get(`message:${T}:b`)!.state)).toBe("active");
  expect(refreshMemoryCheckpoint(jobOf(db, "c")).status).toBe("updated");
  const notes = String(headNotes(db).text);
  expect(notes).toContain("alpha kept"); expect(notes).not.toContain("7731");
  expect(count(db, "SELECT count(*) AS n FROM memory_checkpoint_publications WHERE job_id=?", jobOf(db, "b")), "the tombstoned job is not published").toBe(0);
  expect(debts(db)).toEqual([]);
});
/** `n` finished tool rows of thread T in one transaction (the real capture): one marker, n owed jobs. */
function bulkRows(db: DatabaseSync, n: number) {
  transaction(() => { for (let k = 0; k < n; k++) {
    const id = `bulk-${k}`, text = `step ${k} kept`;
    storeAnchorMessage(db, T, id, text, "bot");
    captureMessage(db, T, { at: 1, id, role: "bot", kind: "activity", turnId: TURN, text, tool: { name: "read_file", ok: true } } as never);
  } });
}
it("W-E3-CHUNK a thread owing more than one chunk is rolled oldest first, at most 512 jobs per transaction; its marker carries the rest to the next pass", () => {
  const db = database();
  bulkRows(db, 600);
  expect(threadDebts(db)).toHaveLength(1);
  const newest = jobOf(db, "bulk-599");
  // r5 covered all 600 in one transaction, which a background write grant can refuse whole (FABLE/ASTRA memv2-E-fable e61c79df49)
  expect(refreshMemoryCheckpoint(newest), "the first roll covers one chunk and says the thread still owes").toMatchObject({ status: "deferred", reason: "checkpoint-chunk" });
  expect(publishedJobs(db), "one chunk published: the oldest 512").toBe(512);
  expect(String(headNotes(db).text)).toContain("step 511 kept");
  expect(threadDebts(db), "the thread still owes through one marker").toHaveLength(1);
  // the next pass of the real debt driver rolls the rest from the marker
  driverTick();
  expect(publishedJobs(db), "every owed job published").toBe(600);
  const notes = String(headNotes(db).text);
  // the same notes one roll over all 600 writes: the newest four, newest first
  expect(notes.indexOf("step 599 kept")).toBeGreaterThan(-1);
  expect(notes.indexOf("step 599 kept")).toBeLessThan(notes.indexOf("step 596 kept"));
  expect(notes).not.toContain("step 595 kept");
  expect(debts(db)).toEqual([]);
});
it("W-E3-CHUNK-OWED a capture-owed job whose roll covered one chunk stays owed: the controller's next pass rolls the rest", () => {
  const db = database();
  bulkRows(db, 600);
  const newest = jobOf(db, "bulk-599");
  const controller = new MemoryWorkerController();
  const internals = controller as unknown as { captureOwedCheckpoints: Map<string, number>; recoverCaptureOwedCheckpoints(): void };
  const hook = vi.spyOn(controller, "completedSource").mockImplementation(() => {});
  try {
    internals.captureOwedCheckpoints.set(newest, performance.now() + 60_000);
    internals.recoverCaptureOwedCheckpoints(); // the real controller under real write admission: r5's one transaction over all 600 was refused whole (BG_DEFERRED), 0 published
    // the controller rolls the thread's marker, on the debt's first job: it is rolled inside the oldest chunk
    expect(publishedJobs(db)).toBe(513);
    expect(hook, "each job the chunk published gets the derived-work hook, as a whole roll's covered jobs do").toHaveBeenCalledTimes(513);
    expect([...internals.captureOwedCheckpoints.keys()], "a chunked roll keeps the job owed").toEqual([newest]);
    internals.recoverCaptureOwedCheckpoints();
    expect(publishedJobs(db)).toBe(600);
    expect([...internals.captureOwedCheckpoints.keys()]).toEqual([]);
    expect(debts(db)).toEqual([]);
  } finally { void controller.stop(); vi.restoreAllMocks(); }
});
it("W-E3-CHUNK-EMPTY a chunk with nothing to quote still moves the debt past it: the thread's quotable jobs after it are rolled in the next pass", () => {
  const db = database();
  // 520 turn rows (never quoted) and then three quotable outcomes, all owed through the thread's one marker
  for (let n = 0; n < 520; n++) recordMemorySettlement(T, `quiet-${n}`, "completed");
  toolRow(db, "x", "xray kept"); toolRow(db, "y", "yankee kept"); toolRow(db, "z", "zulu kept");
  expect(threadDebts(db)).toHaveLength(1);
  expect(refreshMemoryCheckpoint(jobOf(db, "z")), "a chunk of turn rows quotes nothing and still says the thread owes").toEqual({ status: "deferred", reason: "checkpoint-chunk" });
  expect(threadDebts(db), "the debt is carried past the chunk").toHaveLength(1);
  // the next pass: the debt driver rolls the thread's marker (here on z, the asked-for job, as the chunk left it)
  expect(threadDebts(db)).toEqual([jobOf(db, "z")]);
  expect(refreshMemoryCheckpoint(threadDebts(db)[0]!).status).toBe("updated");
  const notes = String(headNotes(db).text);
  expect(notes, "the quotable jobs after the chunk were rolled").toContain("zulu kept");
  expect(notes).toContain("xray kept");
  expect(debts(db)).toEqual([]);
});
it("W-E3-CHUNK-ASKED-OLDEST the debt driver's roll of a debt's first job, past one chunk, rolls that job inside the oldest chunk, in job order", () => {
  const db = database();
  bulkRows(db, 600);
  const first = jobOf(db, "bulk-0");
  expect(threadDebts(db)).toEqual([first]);
  expect(refreshMemoryCheckpoint(first)).toEqual({ status: "deferred", reason: "checkpoint-chunk", covered: expect.any(Array) });
  expect(publishedJobs(db), "the asked-for job, older than the chunk's last, is rolled in it").toBe(513);
  driverTick();
  expect(publishedJobs(db)).toBe(600);
  const notes = String(headNotes(db).text);
  expect(notes.indexOf("step 599 kept")).toBeGreaterThan(-1);
  expect(notes, "the debt's first job is not quoted ahead of the newer ones").not.toContain("step 0 kept");
  expect(debts(db)).toEqual([]);
});
/** A thread debt past one chunk of turn rows (never quoted), then three quotable outcomes, with a marker no roll can take left on an older job
 * of the thread whose source left the branch as an older build leaves it (no capture saw it, so its job is outside every roll's cover):
 * "legacy" is that build's per-job row (no thread, no start), "thread" a thread marker (its start is capped at its job), "long" a marker
 * whose intent is too long for its start to be read. Returns that job. */
function pinnedDebt(db: DatabaseSync, shape: "legacy" | "thread" | "long") {
  toolRow(db, "old", "an older outcome");
  const stuck = jobOf(db, "old");
  if (shape === "legacy") db.prepare("UPDATE memory_scope_bindings SET intent=json_remove(intent,'$.threadId','$.from') WHERE id=?").run(`checkpoint-debt:${stuck}`);
  if (shape === "long") db.prepare("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.note',?) WHERE id=?").run("n".repeat(5000), `checkpoint-debt:${stuck}`);
  db.prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(`message:${T}:old`);
  // one transaction, as bulkRows: 520 commits in a row would leave the worker's background write admission no room for the debt driver
  transaction(() => { for (let n = 0; n < 520; n++) recordMemorySettlement(T, `quiet-${n}`, "completed"); });
  toolRow(db, "x", "xray kept"); toolRow(db, "y", "yankee kept"); toolRow(db, "z", "zulu kept");
  expect(debts(db), "the stuck marker and the thread's one marker that can roll").toHaveLength(2);
  expect(debts(db)).toContain(stuck);
  return stuck;
}
/** One pass of the real debt driver (worker-controller.ts recoverCheckpoints: the debt index page, each marker through refreshCheckpoint under
 * the worker's write admission), called as the tick calls it once the tick's room gate lets it (driverTick stops at that gate here). */
function debtPass() {
  const controller = new MemoryWorkerController();
  const internals = controller as unknown as { recoverCheckpoints(): void };
  vi.spyOn(controller, "completedSource").mockImplementation(() => {});
  try { ioBudget.withSource("memory-worker", () => internals.recoverCheckpoints()); } finally { void controller.stop(); vi.restoreAllMocks(); }
}
it("W-E3-CHUNK-REFUSED-PIN an older build's refused per-job row on an excluded job does not pin the roll's start: the debt driver gets past an empty chunk within two passes", () => {
  const db = database();
  const stuck = pinnedDebt(db, "legacy");
  const first = debts(db).find(id => id !== stuck)!;
  // pass 1: the driver refuses the stuck row and rolls the thread's marker: one chunk of turn rows, nothing to quote
  debtPass();
  expect(debts(db), "the pass rolled the thread's marker: its chunk moved the debt on").not.toContain(first);
  expect(publishedJobs(db), "the chunk quoted nothing").toBe(0);
  // 6e1ce27049 kept the row, and its job's rowid pinned every later pass to the same chunk (ASTRA memv2-E 6e1ce27049 High)
  expect(debts(db), "the refused row is passed with the chunk").not.toContain(stuck);
  // pass 2: the next pass starts past the chunk and reaches the quotable rows
  debtPass();
  expect(debts(db), "the thread's debt is settled within two passes").toEqual([]);
  const notes = String(headNotes(db).text);
  expect(notes).toContain("zulu kept"); expect(notes).toContain("xray kept"); expect(notes).not.toContain("an older outcome");
});
it.each(["legacy", "thread", "long"] as const)("W-E3-CHUNK-NO-REPEAT no chunk is rolled twice: whatever marker is left behind a chunk with nothing to quote, the next pass starts past it (%s)", shape => {
  const db = database();
  const stuck = pinnedDebt(db, shape);
  const asked = debts(db).find(id => id !== stuck)!;
  expect(refreshMemoryCheckpoint(asked)).toEqual({ status: "deferred", reason: "checkpoint-chunk" });
  // every marker of the thread left now starts past the chunk: one whose start still fell inside it would roll the same chunk again
  const left = db.prepare("SELECT b.id,j.rowid AS at,CASE WHEN octet_length(b.intent)<=4096 THEN json_extract(b.intent,'$.from') END AS start FROM memory_scope_bindings b JOIN memory_jobs j ON j.id=substr(b.id,17) WHERE b.subject_id='checkpoint-pending'").all()
    .map(row => ({ id: String(row.id).slice(16), start: row.start === null ? Number(row.at) : Math.min(Number(row.start), Number(row.at)) }));
  // the chunk: the debt's first job (the asked-for one) and the 512 owed jobs after it, all turn rows
  const chunkEnd = Number(db.prepare("SELECT j.rowid AS n FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.thread_id=? AND s.kind='turn' ORDER BY j.rowid LIMIT 1 OFFSET 512").get(T)!.n);
  expect(left.filter(row => row.start <= chunkEnd), "no marker starts inside the chunk just rolled").toEqual([]);
  const second = refreshMemoryCheckpoint(debts(db)[0]!);
  expect(second.status, "the second pass is not the same chunk again").toBe("updated");
  expect(String(headNotes(db).text)).toContain("zulu kept");
  expect(debts(db)).toEqual([]);
});
