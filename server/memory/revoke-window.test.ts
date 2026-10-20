// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 revoke-bounded r3: what forgetting promises from its commit, with the background job stopped, and what it costs.
// T2/T3: right after a forget, a deleted conversation or a deleted bot (no job slice run), every engine-facing reader gives the
// answer the installation-wide tombstone pass gives, and still does after a restart inside that window. T4-T6: the commit and
// every slice stay flat from small to large files (revisions, versions, sources, records, receipts, evidence rows), and nothing
// blocks the main loop for more than 50 ms. Then the smaller promises: stances parsed once, copies found by their origin, the
// start-up VACUUM waits for a job, a restore merge carries the deny rows. Every test runs on the build host (hz-test.sh), never on a Mac.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { afterEach as thawAfterEach, beforeEach as thawBeforeEach } from "vitest";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { roomTranscriptWithoutMemory } from "../room-transcript.ts";
import { shownLinesRoots } from "../steer-lineage.ts";
import type { Message } from "../store.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { captureBotDeletion, captureThreadDeletion } from "./capture.ts";
import { COLD_CHECK_ROWS, continuationMemoryRevoked } from "./disclosures.ts";
import { FORGET_INLINE_ROWS, forgetMemory } from "./forget.ts";
import { renderLearnedBlock } from "./lessons.ts";
import { advanceRevocationJob, INLINE_REVOCATION, memoryRevocationIdle, memoryRevocationStats, pipStanceParses, resetMemoryRevocationStats, resetPipStanceParses, runRevocationJobsNow, stopMemoryRevocation, wakeMemoryRevocation } from "./memory-revocation.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { readableMemoryRecord } from "./readable.ts";
import { contentRevoked, LineageAllowance, recordOutputRoots, type Disclosure } from "./replay-lineage.ts";
import { setMemoryMode } from "./repository.ts";
import { applyForgetTombstones, applyMemoryTombstones, mergeDestinationMemoryDeletions } from "./restore.ts";
import { revokeRecordDisclosures } from "./revocation.ts";
import { finishLineageStorageAtStartup } from "./root-set-compaction.ts";
import { migrateMemorySchema } from "./schema.ts";
import { stampFreshSession } from "./testing/writetime-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
const N = (n: number): number => Math.max(1, Math.round(n * Number(process.env.MEASURE_SCALE ?? 1)));
// 1.0.2: this test models a 1.0.1 file (legacy root-set rows) for the read-time judge, which still decides legacy data until S6.
thawBeforeEach(() => thawRootSetWritesForTest(true));
thawAfterEach(() => thawRootSetWritesForTest(false));

const inline = { ...INLINE_REVOCATION };
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "log").mockImplementation(() => {});
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  resetMemoryRevocationStats(); resetPipStanceParses();
});
afterEach(() => { stopMemoryRevocation(); Object.assign(INLINE_REVOCATION, inline); vi.restoreAllMocks(); });
/** The job may not run inside the window: no inline step, no runner. */
const stopJobs = () => { INLINE_REVOCATION.rows = 1; INLINE_REVOCATION.ms = 0; stopMemoryRevocation(); };
/** Runs every job row to its end as the runner would (slices of at most 8 ms, the row written back after each), without the
 * runner's pauses: returns the longest slice's work (before its COMMIT: a file database's commit also pays SQLite's WAL
 * auto-checkpoint, a disk cost every writer shares) and the largest job row seen. */
const sliceMs: number[] = [];
const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))]!;
function drainSlices(db: DatabaseSync): { maxMs: number; maxBytes: number; slices: number; slowest: string } {
  const out = { maxMs: 0, maxBytes: 0, slices: 0, slowest: "" };
  for (;;) {
    const row = db.prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='memory-revocation' ORDER BY rowid LIMIT 1").get();
    if (!row) return out;
    const t0 = performance.now();
    db.exec("BEGIN IMMEDIATE");
    const job = JSON.parse(String(row.intent));
    const at = `${job.phases[0]} ${JSON.stringify(job.c ?? null).slice(0, 80)}`;
    if (advanceRevocationJob(db, job, 4096, 8)) db.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run(String(row.id));
    else { const intent = JSON.stringify(job); out.maxBytes = Math.max(out.maxBytes, intent.length); db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(intent, String(row.id)); }
    const ms = performance.now() - t0;
    sliceMs.push(ms);
    if (ms > out.maxMs) { out.maxMs = ms; out.slowest = `${at} -> ${job.phases[0] ?? "done"}`; }
    out.slices++;
    db.exec("COMMIT");
  }
}
const jobRows = (db: DatabaseSync) => Number(db.prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='memory-revocation'").get()!.n);

function live() {
  const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "private", section: "team-a" }, { id: "bot2", threadId: "private-2", section: "team-a" }], groups: [] };
  reconcileMemoryRoster(roster);
  setMemoryMode("active");
  const registry = new InternalCapabilities();
  const access = () => {
    const generation = registry.begin("bot", "private");
    const token = registry.mint({ botId: "bot", threadId: "private", generation, kind: "memory", depth: 100, skillAuthoring: false });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  };
  return { access, scope: ensureScope("bot", "bot") };
}
const SECRET = "secret CORAL";
function line(thread: string, id: string, role: "user" | "bot", at: number, text: string, parentId?: string): Message {
  const message = { id, role, kind: "text", text, at, ...(parentId ? { parentId } : {}) } as unknown as Message;
  database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(thread, id, at, role, "text", text, JSON.stringify(message));
  return message;
}
function source(id: string, scope: string, thread: string | null, message: string | null, kind: string, speaker: string, payload: Record<string, unknown>) {
  const db = database();
  db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,'h',?,?,'recorded',NULL,'active')").run(id, scope, thread, message, kind, speaker);
  db.prepare("INSERT INTO memory_source_versions VALUES(?,1,'h',?,1)").run(id, JSON.stringify(payload));
}
function record(id: string, scope: string, assertion: string, evidence: string | null) {
  const db = database();
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,?,'active',0,1,NULL,NULL,1)").run(id, scope, SECRET, assertion);
  if (evidence) db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,?)").run(id, evidence, Buffer.byteLength(SECRET));
}

/** A memory where one forgotten reply reaches every kind of reader: a record resting on it and a promoted copy of that record,
 * a copy brought into a project, a lesson learned from it and its copy shared to another bot, a feedback row on it, a later
 * reply in the same conversation (no receipt), a reply in another conversation that carried it, and a receipt citing it. */
function world() {
  const { access, scope } = live();
  const db = database();
  const lines = [line("room-1", "q", "user", 1000, "what is the code?"), line("room-1", "a", "bot", 2000, `The code is ${SECRET}.`, "q"),
    line("room-1", "b", "bot", 3000, `As stated above, ${SECRET}.`, "a"), line("room-1", "own", "user", 4000, "my pin is 4321", "b")];
  const other = [line("room-2", "x", "bot", 5000, `Carried from the room: ${SECRET}.`)];
  source("message:room-1:a", scope, "room-1", "a", "text", "bot", { text: SECRET });
  source("message:room-1:own", scope, "room-1", "own", "text", "owner", { text: "my pin is 4321" });
  source("bring-in:p:1", scope, "proj", "pm-1", "bring-in", "bot", { text: SECRET, kind: "bring-in", broughtFrom: { sources: [{ id: "message:room-1:a", revision: 1 }] } });
  record("R", scope, "assistant-inference", "message:room-1:a");
  record("C", scope, "owner-statement", null);
  db.prepare("INSERT INTO memory_derivations VALUES('R',1,'C',1)").run();
  record("BI", scope, "assistant-inference", "bring-in:p:1");
  const lesson = db.prepare(`INSERT INTO memory_lessons(id,version,parent_id,bot_id,scope,recipients,kind,text,origin,state,evidence,prospect_derived,learning_event_id,created_at,decided_at,spec,where_,thread_id,source_message_id,target_message_id)
    VALUES(?,1,?,?,'bot',NULL,'note','Use the CORAL code','typed','active',?,0,NULL,1,1,NULL,NULL,?,NULL,NULL)`);
  lesson.run("L1", null, "bot", JSON.stringify([{ messageId: "a" }]), "room-1");
  lesson.run("L2", "L1", "bot2", null, null);
  db.prepare("INSERT INTO memory_feedback(id,bot_id,thread_id,message_id,polarity,strength,state,scope,correction,created_at) VALUES('F1','bot','room-1','a','-',2,'detected','chat','say CORAL less',?)").run(Date.now());
  // the reply in room-2 was made with room-1's line in its working context
  recordOutputRoots("room-2", "x", shownLinesRoots(LineageAllowance.tool(1_000_000_000), [{ threadId: "room-1", id: "a", role: "bot" }], undefined, "room-2"));
  db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('cites-a','room-1','d',NULL,'[{\"id\":\"R\",\"version\":1}]','[{\"id\":\"message:room-1:a\",\"revision\":1}]',0,0,0,'delivered',0)").run();
  return { access, lines, other };
}
/** Every reader of the material, as plain data. */
function readers(w: ReturnType<typeof world>) {
  const db = database();
  // refused or readable (the refusal's code names which check refused first, which a pass that marks states moves earlier)
  const read = (id: string) => { try { const r = readableMemoryRecord(id, 1, w.access(), { allowance: LineageAllowance.tool(1_000_000_000) }); return typeof r === "string" ? "refused" : "ok"; } catch (error) { return `throw:${(error as Error).message}`; } };
  const learned = (botId: string) => { const block = renderLearnedBlock(db, { botId, threadId: "room-1", ownerAudience: true, turnsSince: () => 0 }); return { lessons: block.lessonIds, feedback: block.feedbackIds }; };
  const room = (thread: string, lines: Message[]) => {
    const t = roomTranscriptWithoutMemory(LineageAllowance.tool(1_000_000_000), thread, lines, true);
    return t ? { withheld: [...t.withheld].sort(), forgotten: [...t.forgotten].sort(), leaks: t.messages.filter(m => String(m.text).includes("CORAL") || String(m.text).includes("4321")).map(m => m.id) } : "as-is";
  };
  const receipt = db.prepare("SELECT * FROM memory_disclosures WHERE bundle_id='cites-a'").get() as unknown as Disclosure;
  return { R: read("R"), C: read("C"), BI: read("BI"), bot: learned("bot"), bot2: learned("bot2"), room1: room("room-1", w.lines), room2: room("room-2", w.other), receipt: contentRevoked(LineageAllowance.tool(1_000_000_000), receipt, "room-1") };
}
/** The answer the installation-wide pass gives on the same file. */
function globalPass(): void { transaction(db => applyMemoryTombstones(db)); }

const scenarios: Array<[string, () => void]> = [
  ["forgetting the reply", () => { forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:room-1:a" }); }],
  ["forgetting the record resting on it", () => { forgetMemory(ownerMemoryTicket(), { kind: "record", id: "R" }); }],
  ["forgetting the owner's own line", () => { forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:room-1:own" }); }],
  ["deleting the conversation", () => { transaction(db => captureThreadDeletion(db, "room-1")); }],
  ["deleting the bot", () => { transaction(db => captureBotDeletion(db, "bot")); }],
];

it.each(scenarios)("T2/T3 window: right after %s, with no job slice run, every reader answers as the installation-wide pass does, also after a restart", (name, act) => {
  const w = world();
  const before = readers(w);
  stopJobs();
  act();
  stopMemoryRevocation();
  expect(jobRows(database())).toBeGreaterThan(0); // the job is still waiting: this is the window
  const window = readers(w);
  closeDatabase(); // T3: a restart inside the window
  const restarted = readers(w);
  globalPass();
  const global = readers(w);
  expect(window, name).toEqual(global);
  expect(restarted, name).toEqual(global);
  // and the job, run to its end afterwards, changes no answer
  transaction(db => runRevocationJobsNow(db));
  if (name === "forgetting the owner's own line") {
    // 1.0.2: in the window the write-time layer reads the whole scope "checking" (withheld, as the installation-wide pass leaves it) until the job
    // settles which lines the forgotten one reaches. The owner's own line carries nothing the records, lessons and feedback rest on, so once
    // the job ends they read as they did before; the rooms, the copy and the receipt still answer exactly as the installation-wide pass does.
    const settled = readers(w);
    expect({ R: settled.R, C: settled.C, BI: settled.BI, bot: settled.bot, bot2: settled.bot2 }, name).toEqual({ R: before.R, C: before.C, BI: before.BI, bot: before.bot, bot2: before.bot2 });
    expect({ room1: settled.room1, room2: settled.room2, receipt: settled.receipt }, name).toEqual({ room1: global.room1, room2: global.room2, receipt: global.receipt });
  } else expect(readers(w), name).toEqual(global);
  expect(window).not.toEqual(before);
});

it("T2: what the window withholds, by name (the forgotten reply, everything resting on it, the later reply, the carried reply)", () => {
  const w = world();
  stopJobs();
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:room-1:a" });
  stopMemoryRevocation();
  const now = readers(w);
  expect([now.R, now.C, now.BI].every(answer => answer !== "ok")).toBe(true);
  expect(now.bot).toEqual({ lessons: [], feedback: [] });
  expect(now.bot2.lessons).toEqual([]);
  expect(now.room1).toMatchObject({ withheld: ["a", "b"], forgotten: ["a"], leaks: ["own"] });
  expect(now.room2).toMatchObject({ withheld: ["x"], leaks: [] });
  expect(now.receipt).toBe(true);
  // the owner's own line, forgotten, is withheld as forgotten too
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:room-1:own" });
  stopMemoryRevocation();
  expect(readers(w).room1).toMatchObject({ withheld: ["a", "b", "own"], forgotten: ["a", "own"], leaks: [] });
});

it("T2: a reply written after the forget, by a turn that began after it, is not withheld; one whose turn began before is", () => {
  const w = world();
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:room-1:a" });
  const later = Date.now() + 10_000;
  const ask = line("room-1", "q2", "user", later, "and now?", "own");
  const fresh = line("room-1", "c", "bot", later + 1, "Nothing to add.", "q2");
  const raced = line("room-1", "d", "bot", later + 2, `Still ${SECRET}.`, "b"); // its turn began at b, before the forget
  const t = roomTranscriptWithoutMemory(LineageAllowance.tool(1_000_000_000), "room-1", [...w.lines, ask, fresh, raced], true)!;
  expect([...t.withheld].sort()).toEqual(["a", "b", "d"]);
});

// ---- T4: the commit is flat (statements and time do not follow revisions, versions, sources or records) ----
function timed(run: () => void): number { const t0 = performance.now(); run(); return performance.now() - t0; }
it("T4: forgetting a source with 1 or 100k revisions, and a record with 1 or 50k versions, writes the same few rows in its commit", { tags: ["nightly"], timeout: 3_600_000 }, () => {
  const { scope } = live();
  const db = database();
  const make = (id: string, revisions: number) => {
    source(id, scope, "t", `m-${id}`, "text", "owner", { text: "x" });
    if (revisions > 1) db.prepare(`INSERT INTO memory_source_versions WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i+1 FROM n WHERE i<?) SELECT ?,i,'h'||i,'{"text":"x"}',1 FROM n`).run(revisions, id);
    db.prepare("UPDATE memory_sources SET revision=? WHERE id=?").run(revisions, id);
  };
  const versioned = (id: string, versions: number) => {
    source(`src-${id}`, scope, "t", `m-${id}`, "text", "owner", { text: "x" });
    // seeded through a plain connection: the app connection's identity trigger (provenance-stamp.ts ident_records_i) reads every
    // earlier version of a record id on each insert, so seeding 50k versions of one record through it is quadratic (not this lane)
    const raw = new DatabaseSync(join(DATA_DIR, "messages.db"));
    raw.exec("PRAGMA busy_timeout=5000; BEGIN");
    if (versions > 1) raw.prepare(`INSERT INTO memory_source_versions WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i+1 FROM n WHERE i<?) SELECT ?,i,'h'||i,'{"text":"x"}',1 FROM n`).run(versions, `src-${id}`);
    raw.prepare(`INSERT INTO memory_records WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) SELECT ?,i,?,'fact','x','assistant-inference',CASE WHEN i=? THEN 'active' ELSE 'superseded' END,0,1,NULL,NULL,1 FROM n`).run(versions, id, scope, versions);
    raw.prepare(`INSERT INTO memory_evidence WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) SELECT ?,i,?,i,0,1 FROM n`).run(versions, id, `src-${id}`);
    raw.exec("COMMIT"); raw.close();
  };
  make("small", 1); make("large", N(100_000)); versioned("small-r", 1); versioned("large-r", N(50_000));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const tombstones = () => Number(db.prepare("SELECT count(*) AS n FROM memory_tombstones").get()!.n);
  const commit = (target: { kind: "source" | "record"; id: string }) => { const before = tombstones(); const ms = timed(() => forgetMemory(ownerMemoryTicket(), target)); stopMemoryRevocation(); return { ms, rows: tombstones() - before }; };
  const s1 = commit({ kind: "source", id: "small" }), s2 = commit({ kind: "source", id: "large" });
  const r1 = commit({ kind: "record", id: "small-r" }), r2 = commit({ kind: "record", id: "large-r" });
  for (const c of [s1, s2, r1, r2]) expect(c.ms).toBeLessThan(50);
  // the target's own tombstone, the inline rows, and at most the inline budget of the job's first phase
  expect(s2.rows).toBeLessThanOrEqual(1 + FORGET_INLINE_ROWS + INLINE_REVOCATION.rows); expect(r2.rows).toBeLessThanOrEqual(1 + 2 * (FORGET_INLINE_ROWS + INLINE_REVOCATION.rows));
  // flat: bounded by the inline caps, whatever the history (100k revisions, 50k versions)
  expect(s2.rows).toBeLessThanOrEqual(s1.rows + FORGET_INLINE_ROWS + INLINE_REVOCATION.rows); expect(s2.ms).toBeLessThan(s1.ms + 40); expect(r2.ms).toBeLessThan(r1.ms + 40);
  // the job writes the rest, in slices: every revision's import tombstone, every supporting source
  sliceMs.length = 0;
  const drained = drainSlices(db);
  console.log(`RWDIST ${process.platform} scale ${process.env.MEASURE_SCALE ?? 1} slices ${sliceMs.length} p50 ${q(sliceMs, 0.5).toFixed(2)} p95 ${q(sliceMs, 0.95).toFixed(2)} p99 ${q(sliceMs, 0.99).toFixed(2)} max ${q(sliceMs, 1).toFixed(2)} ms; over 30: ${sliceMs.filter(x => x > 30).length}; slowest ${drained.slowest}`);
  expect(drained.maxMs, drained.slowest).toBeLessThan(30); expect(drained.maxBytes).toBeLessThanOrEqual(1024);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_tombstones WHERE target_type='import'").get()!.n)).toBe(1 + N(100_000) + 1 + N(50_000));
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_tombstones WHERE reason='forgotten-supporting-source' AND target_id='src-large-r'").get()!.n)).toBe(N(50_000));
});

it("T4: deleting a conversation of 1k or 100k sources, or a bot of 1k or 50k records, is one deny row in a flat commit", () => {
  // an in-memory database (as T6): the commit and the slices measured are this lane's work, not the disk's
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  migrateMemorySchema(db, "active");
  db.exec("INSERT INTO memory_scopes VALUES('w','workspace','owner','[]',0); INSERT INTO memory_scopes VALUES('sb','bot','b-small','[]',0); INSERT INTO memory_scopes VALUES('lb','bot','b-large','[]',0)");
  const room = (thread: string, n: number) => {
    db.prepare(`INSERT INTO memory_sources WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?) SELECT 'message:'||?||':m'||i,'w',?,'m'||i,NULL,1,'h','text','owner','recorded',NULL,'active' FROM k`).run(n, thread, thread);
    db.prepare(`INSERT INTO memory_source_versions SELECT id,1,'h','{"text":"x"}',1 FROM memory_sources WHERE thread_id=?`).run(thread);
  };
  room("small", 1000); room("large", 100_000);
  const bot = (scope: string, n: number) => db.prepare(`INSERT INTO memory_records WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?) SELECT ?||'-r'||i,1,?,'fact','x','owner-statement','active',0,1,NULL,NULL,1 FROM k`).run(n, scope, scope);
  bot("sb", 1000); bot("lb", 50_000);
  const commit = (run: () => void) => timed(() => { db.exec("BEGIN IMMEDIATE"); run(); db.exec("COMMIT"); });
  const t1 = commit(() => captureThreadDeletion(db, "small")), t2 = commit(() => captureThreadDeletion(db, "large"));
  const b1 = commit(() => captureBotDeletion(db, "b-small")), b2 = commit(() => captureBotDeletion(db, "b-large"));
  const said = JSON.stringify({ t1, t2, b1, b2 });
  for (const ms of [t1, t2, b1, b2]) expect(ms, said).toBeLessThan(50);
  expect(t2, said).toBeLessThan(t1 + 25); expect(b2, said).toBeLessThan(b1 + 25);
  expect(db.prepare("SELECT kind,id FROM memory_deny ORDER BY kind,id").all()).toEqual([{ kind: "scope", id: "lb" }, { kind: "scope", id: "sb" }, { kind: "thread", id: "large" }, { kind: "thread", id: "small" }]);
  const drained = drainSlices(db);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_sources WHERE thread_id='large' AND state!='deleted'").get()!.n)).toBe(0);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_records WHERE scope_id='lb' AND state!='deleted'").get()!.n)).toBe(0);
  expect(drained.maxMs, drained.slowest).toBeLessThan(30);
  expect(drained.maxBytes).toBeLessThanOrEqual(1024); // F2#1: the job row never grows with what it ends
  db.close();
}, 3_600_000);

// ---- T5: 50k vs 500k receipts ----
const RECEIPTS = `INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at)
  WITH RECURSIVE n(i) AS (SELECT ?1 UNION ALL SELECT i+1 FROM n WHERE i<?2) SELECT printf('r%07d',i),?3,'claude',?4,json_array(json_object('id',?5,'version',1)),'[]',?6,?7,0,'delivered',i FROM n`;
it("T5: archiving a record cited by 50k or 500k receipts and a cold check of a 50k or 500k receipt session cost the same", async () => {
  const { access, scope } = live();
  const db = database();
  record("cited-s", scope, "owner-statement", null); record("cited-l", scope, "owner-statement", null);
  const meta = db.prepare("SELECT policy_revision AS p,deletion_epoch AS e FROM memory_meta WHERE id=1").get()!;
  db.prepare(RECEIPTS).run(1, 50_000, "private", "S-small", "cited-s", meta.p, meta.e);
  db.prepare(RECEIPTS).run(50_001, 550_000, "private", "S-large", "cited-l", meta.p, meta.e);
  // the two sessions' lineage rows, as a 1.0.3 fresh start leaves them (S6 rule 26)
  stampFreshSession(db, "private", "claude", "S-small"); stampFreshSession(db, "private", "claude", "S-large");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  // a cold check (a restart: no hold) reads at most COLD_CHECK_ROWS receipts whatever the session's length, then resets it
  // (the reopen and the reader's access are made first: the check itself is what is timed)
  const cold = (session: string) => { closeDatabase(); const a = access(); const why: { reason?: string } = {}; const ms = timed(() => expect(continuationMemoryRevoked(LineageAllowance.tool(1_000_000_000), "private", "claude", session, a, why)).toBe(true)); return { ms, why: why.reason }; };
  const c1 = cold("S-small"), c2 = cold("S-large");
  expect(c1.why).toBe("memory-changed (long-session)"); expect(c2.why).toBe(c1.why);
  expect(c1.ms).toBeLessThan(50); expect(c2.ms).toBeLessThan(c1.ms + 20);
  expect(COLD_CHECK_ROWS).toBeLessThan(50_000);
  // archive: the request flips at most its inline budget, the job the rest
  const archive = (id: string) => timed(() => transaction(d => revokeRecordDisclosures(d, "archive", { recordIds: [id], viaSources: true })));
  const a1 = archive("cited-s"), a2 = archive("cited-l");
  expect(a1).toBeLessThan(50); expect(a2).toBeLessThan(a1 + 20);
  const now = database();
  expect(Number(now.prepare("SELECT count(*) AS n FROM memory_disclosures WHERE state='revoked'").get()!.n)).toBeLessThanOrEqual(2 * INLINE_REVOCATION.rows);
  const drained = drainSlices(now);
  expect(Number(now.prepare("SELECT count(*) AS n FROM memory_disclosures WHERE state!='revoked'").get()!.n)).toBe(0);
  expect(drained.maxMs).toBeLessThan(30);
  expect(drained.maxBytes).toBeLessThanOrEqual(1024);
}, 3_600_000);

it("T5: a deleted bot's job ends the receipts made before its commit, never one made after it (A2#9)", async () => {
  live();
  const db = database();
  ensureScope("bot", "gone");
  const meta = () => db.prepare("SELECT policy_revision AS p,deletion_epoch AS e FROM memory_meta WHERE id=1").get()!;
  const m0 = meta();
  db.prepare(RECEIPTS).run(1, 2_000, "elsewhere", "S0", "x", m0.p, m0.e);
  stopJobs();
  transaction(d => captureBotDeletion(d, "gone"));
  stopMemoryRevocation();
  const m1 = meta();
  db.prepare(RECEIPTS).run(2_001, 2_001, "elsewhere", "S1", "x", m1.p, m1.e); // a valid receipt of another bot, after the commit
  Object.assign(INLINE_REVOCATION, inline);
  wakeMemoryRevocation(database, { pauseMs: 1 });
  await memoryRevocationIdle();
  expect(db.prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get("r0002001")!.state).toBe("delivered");
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_disclosures WHERE state='revoked'").get()!.n)).toBe(2_000);
}, 3_600_000);

// ---- T6: 100k vs 1M evidence rows: the lookups are filled in slices, nothing blocks the loop over 50 ms ----
// (an in-memory database, as the r2 scale tests: what is measured is this lane's work on the loop, not the disk's fsync)
async function evidenceFile(rows: number): Promise<{ maxLoopMs: number; forgetMs: number; maxSliceMs: number; ended: number; lateSlices: number }> {
  resetMemoryRevocationStats();
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  migrateMemorySchema(db, "active");
  db.exec("INSERT INTO memory_scopes VALUES('w','workspace','owner','[]',0)");
  db.exec(`INSERT INTO memory_sources WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM k WHERE i<99) SELECT 'e-s'||i,'w','t','m'||i,NULL,1,'h','text','owner','recorded',NULL,'active' FROM k`);
  db.exec(`INSERT INTO memory_source_versions SELECT id,1,'h','{"text":"x"}',1 FROM memory_sources`);
  db.exec(`INSERT INTO memory_records WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM k WHERE i<999) SELECT 'e-r'||i,1,'w','fact','x','assistant-inference','active',0,1,NULL,NULL,1 FROM k`);
  db.prepare(`INSERT INTO memory_evidence WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM k WHERE i<?) SELECT 'e-r'||(i%1000),1,'e-s'||((i/1000)%100),1,i,i+1 FROM k`).run(rows - 1);
  // an upgraded file: the lookup is empty and not built yet
  db.exec("DELETE FROM memory_evidence_by_source; UPDATE memory_late_build SET ready=0,cursor=NULL WHERE name='evidence'");
  const loop = monitorEventLoopDelay({ resolution: 5 });
  loop.enable();
  wakeMemoryRevocation(() => db, { pauseMs: 1 });
  await memoryRevocationIdle();
  expect(Number(db.prepare("SELECT ready FROM memory_late_build WHERE name='evidence'").get()!.ready)).toBe(1);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_evidence_by_source").get()!.n)).toBe(rows);
  const lateSlices = memoryRevocationStats.lateSlices;
  // the forget's commit (forget.ts: epoch, tombstone, then the forget's own targets) and its job
  const forgetMs = timed(() => {
    db.exec("BEGIN IMMEDIATE");
    db.exec("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1,policy_revision=policy_revision+1 WHERE id=1; INSERT INTO memory_tombstones VALUES('n','source','e-s7',NULL,NULL,2,'owner-forget',0)");
    applyForgetTombstones(db, { sources: [{ id: "e-s7", revision: null }], records: [] });
    db.exec("COMMIT");
  });
  wakeMemoryRevocation(() => db, { pauseMs: 1 });
  await memoryRevocationIdle();
  loop.disable();
  const ended = Number(db.prepare("SELECT count(*) AS n FROM memory_records WHERE state='deleted'").get()!.n);
  db.close();
  return { maxLoopMs: loop.max / 1e6, forgetMs, maxSliceMs: memoryRevocationStats.maxSliceMs, ended, lateSlices };
}
it("T6: with 100k or 1M evidence rows the evidence lookup fills in slices and a forget seeks it, never blocking the loop over 50 ms", async () => {
  const small = await evidenceFile(100_000), large = await evidenceFile(1_000_000);
  const said = JSON.stringify({ small, large });
  for (const run of [small, large]) {
    expect(run.maxSliceMs, said).toBeLessThan(30);
    expect(run.forgetMs, said).toBeLessThan(50);
    expect(run.maxLoopMs, said).toBeLessThan(50);
    expect(run.ended).toBe(1000);
  }
  // the build is sliced: ten times the rows, about ten times the slices, each as short
  expect(large.lateSlices, said).toBeGreaterThan(5 * small.lateSlices);
}, 3_600_000);

// ---- the smaller promises ----
it("F2#2: the stance phase parses each stance once and reconciles only the bots whose stance names what ended", async () => {
  const { scope } = live();
  const db = database();
  source("st-1", scope, "t", "m-st", "text", "owner", { text: "x" });
  for (let i = 0; i < 5; i++) db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','pip-stance',0,'granted',?)").run(`pip-stance:bot${i}`, scope, JSON.stringify({ support: { k: i === 2 ? ["st-1"] : ["other"] }, events: {} }));
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "st-1" });
  await memoryRevocationIdle();
  expect(pipStanceParses).toBe(5);
});

it("F2#5: a copy brought in from a forgotten source is found by its origin, in the forget's own commit", () => {
  const { scope } = live();
  source("orig", scope, "t", "m-orig", "text", "owner", { text: SECRET });
  for (let i = 0; i < 300; i++) source(`bring-in:p:other${i}`, scope, "proj", `pm-o${i}`, "bring-in", "bot", { text: "y", broughtFrom: { sources: [{ id: "unrelated", revision: 1 }] } });
  source("bring-in:p:copy", scope, "proj", "pm-copy", "bring-in", "bot", { text: SECRET, broughtFrom: { sources: [{ id: "orig", revision: 1 }] } });
  stopJobs();
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "orig" });
  stopMemoryRevocation();
  expect(database().prepare("SELECT state FROM memory_sources WHERE id='bring-in:p:copy'").get()!.state).toBe("deleted");
});

it("D11: the start-up VACUUM waits while a revocation job is waiting, and runs once none is", () => {
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db, "active");
  db.exec("INSERT INTO memory_scopes VALUES('w','workspace','o','[]',0); CREATE TABLE filler(x); INSERT INTO filler WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<20000) SELECT randomblob(200) FROM n; DROP TABLE filler;");
  db.prepare("INSERT INTO memory_root_set_compaction(id,total,done,cursor,started_at,finished_at) VALUES(1,0,0,'',1,1)").run();
  db.prepare("INSERT INTO memory_scope_bindings VALUES('memory-revocation:x','w','system','memory-revocation',0,'granted','{}')").run();
  const options = { reclaimMinBytes: 0, reclaimFraction: 0, freeDiskBytes: () => null };
  expect(finishLineageStorageAtStartup(db, options).vacuumed).toBe(false);
  db.exec("DELETE FROM memory_scope_bindings WHERE id='memory-revocation:x'");
  expect(finishLineageStorageAtStartup(db, options).vacuumed).toBe(true);
  db.close();
});

it("restore: merging the destination's deletion ledger carries its deny rows, and the restored file refuses the deleted conversation", () => {
  const make = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "messages.db"));
    db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id)); CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT);");
    migrateMemorySchema(db, "active");
    return db;
  };
  const destination = join(DATA_DIR, "dest"), candidate = join(DATA_DIR, "cand");
  const d = make(destination);
  d.prepare("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('thread','gone-thread',3,1)").run();
  d.close();
  const c = make(candidate);
  c.exec("INSERT INTO memory_scopes VALUES('w','workspace','o','[]',0)");
  c.exec("INSERT INTO memory_sources VALUES('message:gone-thread:m','w','gone-thread','m',NULL,1,'h','text','owner','recorded',NULL,'active'); INSERT INTO memory_source_versions VALUES('message:gone-thread:m',1,'h','{\"text\":\"x\"}',1)");
  c.close();
  mergeDestinationMemoryDeletions(destination, candidate);
  const merged = new DatabaseSync(join(candidate, "messages.db"));
  expect(merged.prepare("SELECT kind,id FROM memory_deny").all()).toEqual([{ kind: "thread", id: "gone-thread" }]);
  expect(merged.prepare("SELECT state FROM memory_sources WHERE id='message:gone-thread:m'").get()!.state).toBe("deleted");
  merged.close();
});
