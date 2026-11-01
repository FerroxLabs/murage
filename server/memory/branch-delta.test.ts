// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A branch change (an edit, a switch between versions) moves a few rows from
// one side to the other. Memory updates the sources of those rows and their
// jobs, not every source of the thread, and ends with exactly the states the
// long way (every source judged against the whole new branch) gives, whether the
// change fits the write that moved the head or runs on in slices after it.
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import * as messages from "../message-db.ts";
import { assertSkillProcedureEvidence, prepareMemorySkillReview } from "../skills.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { captureBranchChange, captureSource } from "./capture.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { admissibleActionSources } from "./pip-admission.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { readableMemoryRecord } from "./readable.ts";
import { setMemoryMode } from "./repository.ts";
import { restoreArchivedMemoryRecord } from "./retention.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { branchChangeTuning, drainBranchChanges, pendingBranchChanges, runBranchChangeSlice } from "./branch-change.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); delete branchChangeTuning.sync; delete branchChangeTuning.slice; });
const message = (id: string, parentId: string | null) => ({ id, text: `words of ${id}`, parentId, at: 1, role: "user" as const, kind: "text" as const });
const snapshot = () => ({
  sources: database().prepare("SELECT message_id, state FROM memory_sources ORDER BY message_id").all().map((row) => `${row.message_id}:${row.state}`),
  jobs: database().prepare("SELECT s.message_id AS m, j.status AS status, substr(j.error,1,7) AS parked FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id ORDER BY s.message_id, j.source_revision").all().map((row) => `${row.m}:${row.status}:${row.parked}`),
});

/** A tree: root > a1 > a2 > a3 > a4, a fork b3 > b4 at a2, and c1 > c2 beside a1 under root. */
async function run(): Promise<Array<ReturnType<typeof snapshot>>> {
  const steps: Array<ReturnType<typeof snapshot>> = [];
  const add = async (id: string, parent: string | null) => { messages.appendMessage("t", message(id, parent)); await drainBranchChanges(database()); steps.push(snapshot()); };
  await add("root", null); await add("a1", "root"); await add("a2", "a1"); await add("a3", "a2"); await add("a4", "a3");
  await add("b3", "a2"); await add("b4", "b3");
  await add("c1", "root"); await add("c2", "c1");
  for (const leaf of ["a4", "b4", "c2", "a3", "b3", "root", "a4", "c1", "b4"]) { messages.setActiveLeaf("t", leaf); await drainBranchChanges(database()); steps.push(snapshot()); }
  return steps;
}

it("ends every branch change in the same states whether it fits the write or runs on in slices of one row", async () => {
  const whole = await run();
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture");
  branchChangeTuning.sync = 1; branchChangeTuning.slice = 1;
  const sliced = await run();
  expect(sliced).toEqual(whole);
  // and the states are the branch: after the last switch (to b4) a1, a2, b3, b4 and root are active
  const last = whole.at(-1)!;
  expect(last.sources).toEqual(["a1:active", "a2:active", "a3:retired", "a4:retired", "b3:active", "b4:active", "c1:retired", "c2:retired", "root:active"]);
  // a retired source's open job is parked, an active one's is open
  expect(last.jobs.filter((job) => job.startsWith("a3:") || job.startsWith("c1:")).every((job) => job.includes("cancelled:parked:"))).toBe(true);
  expect(last.jobs.filter((job) => job.startsWith("b4:") || job.startsWith("root:")).every((job) => !job.includes("parked:"))).toBe(true);
});

it("a change longer than the write's share leaves the rest pending, and finishes it in slices", async () => {
  branchChangeTuning.sync = 2; branchChangeTuning.slice = 2;
  let previous: string | null = null;
  for (let i = 1; i <= 12; i++) { messages.appendMessage("t", message(`m${i}`, previous)); previous = `m${i}`; }
  await drainBranchChanges(database());
  // an edit at m3: m4..m12 leave (9 rows, more than the write's 2), the edit joins
  messages.appendMessage("t", message("edit", "m3"));
  expect(pendingBranchChanges(database())).toBe(1);
  await drainBranchChanges(database());
  expect(pendingBranchChanges(database())).toBe(0);
  const states = new Map(database().prepare("SELECT message_id, state FROM memory_sources").all().map((row) => [String(row.message_id), String(row.state)]));
  for (let i = 1; i <= 3; i++) expect(states.get(`m${i}`)).toBe("active");
  for (let i = 4; i <= 12; i++) expect(states.get(`m${i}`)).toBe("retired");
  expect(states.get("edit")).toBe("active");
  // a second change while the first is pending finishes the first
  messages.setActiveLeaf("t", "m12");
  messages.setActiveLeaf("t", "edit");
  await drainBranchChanges(database());
  for (let i = 4; i <= 12; i++) expect(database().prepare("SELECT state FROM memory_sources WHERE message_id = ?").get(`m${i}`)?.state).toBe("retired");
});

// BRANCH-EXCLUDE (designs/BRANCH-EXCLUDE.md rev 3): from this build on, no drain sets a source of an excluded thread active. This is a writer
// guarantee only: sources an older build already flipped wait for BRANCH-EXCLUDE-HEAL, and owner replay is not covered here.
const T = "private";
const roster = { bots: [{ id: "moss", threadId: T }], groups: [] as never[] };
afterEach(() => { setMemoryCaptureRoster(null); });

/** root > a1 > a2 > a3 > a4, with a fork b1 at root where the head rests: the a side is retired, and its evidence is on a2. */
async function forkedThread(): Promise<void> {
  reconcileMemoryRoster(roster); setMemoryCaptureRoster(() => roster as never);
  let previous: string | null = null;
  for (const id of ["root", "a1", "a2", "a3", "a4"]) { messages.appendMessage(T, message(id, previous)); previous = id; }
  transaction((db) => captureSource(db, { id: "tool:a2", threadId: T, messageId: "a2", kind: "tool-outcome", speaker: "tool", outcome: "completed", text: "wrote the file", occurredAt: 1_760_000_000_000, action: { label: "write_file", reportedOutcome: "completed", verification: "tool-reported" } }));
  const db = database(), { id: source, scope_id: scope } = db.prepare("SELECT id, scope_id FROM memory_sources WHERE message_id='a2' AND kind='text'").get()!;
  for (const [id, state] of [["fact", "active"], ["old", "archived"]]) {
    db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','plain','owner-statement',?,0,1,NULL,NULL,1)").run(id!, String(scope), state!);
    db.prepare("INSERT INTO memory_record_details(record_id,record_version,partition,attention,claim_status) VALUES(?,1,'semantic','current','current') ON CONFLICT(record_id,record_version) DO UPDATE SET partition=excluded.partition").run(id!);
    db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,1)").run(id!, String(source));
  }
  messages.appendMessage(T, message("b1", "root"));
  await drainBranchChanges(database());
  expect(activeMessages()).toEqual(["b1", "root"]);
  branchChangeTuning.sync = 1; branchChangeTuning.slice = 1;
}
/** The joining side stops part way: a4 and a3 are flipped, a2 and a1 still wait on the row. */
async function pendingJoin(): Promise<void> {
  await forkedThread();
  messages.setActiveLeaf(T, "a4");
  runBranchChangeSlice(database());
  expect(pendingBranchChanges(database())).toBe(1);
  expect(activeMessages()).toEqual(["a3", "a4", "root"]);
}
const activeMessages = () => [...new Set(database().prepare("SELECT message_id FROM memory_sources WHERE thread_id=? AND state='active' AND message_id IS NOT NULL ORDER BY message_id").all(T).map((row) => String(row.message_id)))];
const activeSources = () => database().prepare("SELECT id FROM memory_sources WHERE thread_id=? AND state='active'").all(T).map((row) => String(row.id));
/** All the drain could have moved: the row with its cursors, and every source state. */
const persisted = () => ({ changes: database().prepare("SELECT * FROM branch_change").all(), sources: database().prepare("SELECT id, state FROM memory_sources ORDER BY id").all() });
const openJobs = () => Number(database().prepare("SELECT count(*) AS n FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.thread_id=? AND j.status NOT IN ('complete','cancelled')").get(T)!.n);
const setExcluded = (excludedThreadIds: string[]) => memoryOwnerRoute("/api/memory/action", { action: "configure", excludedThreadIds }, ownerMemoryTicket(), roster);
function access() {
  const registry = new InternalCapabilities(), generation = registry.begin("moss", T), token = registry.mint({ botId: "moss", threadId: T, generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster as never);
}
/** What each reader of section 1 answers for the evidence on a2. The restore moves the archived record, so one call per test. */
function readers() {
  const db = database(), { id, scope_id: scope } = db.prepare("SELECT id, scope_id FROM memory_sources WHERE message_id='a2' AND kind='text'").get()!;
  const attempt = (act: () => unknown) => { try { act(); return "allowed"; } catch (error) { return error instanceof Error ? error.message : "refused"; } };
  const read = readableMemoryRecord("fact", 1, access(), { allowance: LineageAllowance.tool(1_000_000_000) });
  return {
    pipActions: admissibleActionSources(db, "moss", { threadId: T }).map((source) => source.text),
    skillReview: attempt(() => prepareMemorySkillReview(ownerMemoryTicket(), "moss", "fact", 1)),
    skillEvidence: attempt(() => assertSkillProcedureEvidence({ audienceKey: "bot:moss:owner", allowedScopeIds: [String(scope)] }, [{ kind: "source", id: String(id), revision: 1, scopeId: String(scope) }])),
    recall: typeof read === "string" ? "refused" : "allowed",
    restore: attempt(() => restoreArchivedMemoryRecord(ownerMemoryTicket(), "old", 1)),
  };
}
const REFUSED = { pipActions: [], skillReview: "MEMORY_SKILL_SOURCE_UNAVAILABLE", skillEvidence: "PROCEDURE_EVIDENCE_REVOKED", recall: "refused", restore: "MEMORY_SOURCE_UNAVAILABLE" };
function expectExclusionHolds() {
  expect({ pending: pendingBranchChanges(database()), active: activeSources(), openJobs: openJobs(), readers: readers() }).toEqual({ pending: 0, active: [], openJobs: 0, readers: REFUSED });
}

it("a change still pending when the owner excludes the thread sets nothing active, and no reader of the evidence opens", async () => {
  await pendingJoin();
  await setExcluded([T]);
  await drainBranchChanges(database());
  expectExclusionHolds();
});

it("the same holds for a head that came from nowhere, where every source is judged in turn", async () => {
  await forkedThread();
  transaction((db) => captureBranchChange(db, T, "a4", null));
  runBranchChangeSlice(database());
  expect(pendingBranchChanges(database())).toBe(1);
  await setExcluded([T]);
  await drainBranchChanges(database());
  expectExclusionHolds();
});

it("a thread not yet filled is filled, its row waits, and the row is dropped at the first step", async () => {
  await pendingJoin();
  database().exec("DELETE FROM open_card; DELETE FROM turn_first; DELETE FROM message_image; DELETE FROM thread_key; DELETE FROM seg; DELETE FROM msg_branch; DELETE FROM line; DELETE FROM fill_pending; DELETE FROM transcript_index_state;");
  await setExcluded([T]);
  expect(runBranchChangeSlice(database())).toBe(true); // the fill, no step
  expect(pendingBranchChanges(database())).toBe(1);
  await drainBranchChanges(database());
  expectExclusionHolds();
});

it("a slice that fails after the drop rolls back whole, and the next drain ends the same", async () => {
  await pendingJoin();
  await setExcluded([T]);
  const before = persisted();
  database().exec("CREATE TEMP TRIGGER keep_change BEFORE DELETE ON branch_change BEGIN SELECT RAISE(ABORT, 'fixture stop'); END");
  expect(() => runBranchChangeSlice(database())).toThrow("fixture stop");
  expect(pendingBranchChanges(database())).toBe(1);
  expect(persisted()).toEqual(before);
  database().exec("DROP TRIGGER keep_change");
  await drainBranchChanges(database());
  expectExclusionHolds();
});

/** A real process dies at its COMMIT number `commits` (0 based) of the drain, with that slice written and not committed; this process then opens the same file. */
async function crashDrain(commits: number): Promise<void> {
  closeDatabase();
  const reached = join(DATA_DIR, "crash-reached");
  const child = fork(join(import.meta.dirname, "testing", "branch-drain-crash-child.ts"), [String(commits), reached], { execArgv: ["--experimental-strip-types", "--no-warnings"], env: { ...process.env, MURAGE_DATA_DIR: DATA_DIR }, stdio: "ignore" });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 30_000); // always before the test's own timeout, so no child outlives its data folder
  const [code, signal] = await once(child, "exit").finally(() => clearTimeout(deadline)) as [number | null, NodeJS.Signals | null];
  // the kill itself, not an error on the way there: the child exits 3, 4 or 5 on any other path, and a Windows kill ends a process with code 1
  expect(signal === "SIGKILL" || (process.platform === "win32" && code === 1)).toBe(true);
  expect(existsSync(reached)).toBe(true); // and the kill at the COMMIT, not the deadline's
  expect(database().prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

it("a crash in the drop's own slice leaves the row, and the first drain after the restart drops it", async () => {
  await pendingJoin();
  await setExcluded([T]);
  const before = persisted();
  await crashDrain(0);
  expect(pendingBranchChanges(database())).toBe(1);
  expect(persisted()).toEqual(before);
  await drainBranchChanges(database());
  expectExclusionHolds();
}, 60_000);

it("a crash in the middle of a drain, with the exclusion saved after the restart, still ends with nothing active", async () => {
  await pendingJoin();
  await crashDrain(1); // the slice that flips a2 commits, the one that flips a1 dies
  expect(pendingBranchChanges(database())).toBe(1);
  expect(activeMessages()).toEqual(["a2", "a3", "a4", "root"]);
  await setExcluded([T]);
  expect(activeSources()).toEqual([]);
  await drainBranchChanges(database());
  expectExclusionHolds();
}, 60_000);

it("a plain restart with a pending row and the exclusion saved drops the row at the first drain", async () => {
  await pendingJoin();
  await setExcluded([T]);
  closeDatabase();
  expect(pendingBranchChanges(database())).toBe(1);
  await drainBranchChanges(database());
  expectExclusionHolds();
});

it("a thread brought back before the next slice finishes its change as it always did", async () => {
  await pendingJoin();
  await setExcluded([T]);
  await setExcluded([]);
  await drainBranchChanges(database());
  expect(pendingBranchChanges(database())).toBe(0);
  expect(activeMessages()).toEqual(["a1", "a2"]);
  // and this is the same reader list opening, so a refusal above is the exclusion and not the fixture
  expect(readers()).toEqual({ pipActions: ["write_file"], skillReview: "allowed", skillEvidence: "allowed", recall: "allowed", restore: "allowed" });
});

it("with no exclusion anywhere, a step adds one statement and the change ends as before", async () => {
  await pendingJoin();
  const db = database(), prepare = vi.spyOn(db, "prepare");
  runBranchChangeSlice(db);
  expect(prepare.mock.calls.filter(([sql]) => sql.includes("excludedThreadIds"))).toHaveLength(1);
  prepare.mockRestore();
  await drainBranchChanges(db);
  expect(activeMessages()).toEqual(["a1", "a2", "a3", "a4", "root"]);
});
