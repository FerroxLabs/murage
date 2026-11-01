// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Start-up never waits for a deleted conversation's engine history. Before the port opens the journal is sorted (triage); after it the rows
// go (prepare) and each record gets one attempt in series (drain). These tests run the service against a scripted worker: what each job
// answers is set by the test, so which engine home is busy can change from one attempt to the next.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

import { ConversationDeletions, runConversationDeletion, type DeletionServiceOptions, type PendingConversationDeletion } from "./conversation-deletion.ts";
import { fsOps } from "./engine-fs.ts";
import { engineHistoryTestHooks, runEngineHistoryOffThread, type EngineHistoryJob, type EngineHistoryResult } from "./engine-history-offthread.ts";
import { runEngineHistoryJob } from "./engine-history-run.ts";
import { InstanceHolds } from "./harness/instance-holds.ts";
import { recordFact } from "./health/counters.ts";
import { resetDeletionObserverForTests } from "./health/deletion-observer.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

vi.mock("./health/counters.ts", async (original) => ({ ...(await original<typeof import("./health/counters.ts")>()), recordFact: vi.fn() }));

const BOT = "f25024c1-a18e-4251-acf1-0c1713d9b6d9";
const THREAD = "2e9018ee-1f45-46be-8ed1-7a02fc022807";
const FILE = "0a1b2c3d-1111-4222-8333-444455556666.png";
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-delete-boot-")));
const databases: DatabaseSync[] = [];
afterAll(() => { for (const db of databases) db.close(); removeTempDirSync(scratch); });
let counter = 0;
const fresh = (name: string) => { const dir = join(scratch, `${name}-${++counter}`); mkdirSync(dir, { recursive: true }); return dir; };
const HOME_A = join(scratch, "home-a"), HOME_B = join(scratch, "home-b");
const KEY_A = `codex\0${HOME_A}`, KEY_B = `claude\0${HOME_B}`;

interface Script {
  /** homes a program Murage did not start has open */ busy: Set<string>;
  /** homes whose plan shows something still to remove */ content: Set<string>;
  /** homes whose execute step fails */ failExecute: Set<string>;
  kinds: string[];
  /** runs before a job answers */ gate?: (job: EngineHistoryJob) => Promise<void> | void;
}
let script: Script;

function answer(job: EngineHistoryJob): EngineHistoryResult {
  const none: EngineHistoryResult = { removed: [], failed: [], leftovers: [] };
  if (job.kind === "probe") return { ...none, foreignHomes: Object.fromEntries((job.only ?? []).filter((key) => script.busy.has(key)).map((key) => [key, { kinds: ["other"] }])) };
  if (job.kind === "removeTrees") return { ...none, removed: (job.trees ?? []).map((tree) => tree.target) };
  if (job.kind === "plan" || (job.kind === "openPass" && !job.plans)) {
    const only = job.only ?? [];
    const plans = Object.fromEntries(only.map((key) => {
      const [engine, home] = key.split("\0") as [never, string];
      return [key, { engine, home, steps: script.content.has(key) ? [{ cls: "content", k: "remove", root: home, target: join(home, "x") }] : [] }];
    }));
    return { ...none, plans: plans as never, closedHomes: only };
  }
  if (job.kind === "execute") {
    const keys = Object.keys(job.plans ?? {});
    const bad = keys.filter((key) => script.failExecute.has(key));
    for (const key of keys) if (!bad.includes(key)) script.content.delete(key);
    return { ...none, failed: bad.map((key) => key.split("\0")[1]!), failedHomes: bad, homeReasons: Object.fromEntries(bad.map((key) => [key, "busy"])), staleHomes: [], factsDelta: {} };
  }
  return none;
}

class ScriptWorker extends EventEmitter {
  threadId = 7;
  postMessage(job: EngineHistoryJob) {
    script.kinds.push(job.kind ?? "");
    setImmediate(() => { void Promise.resolve(script.gate?.(job)).then(() => this.emit("message", { type: "result", result: answer(job) })); });
  }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}

beforeEach(() => {
  script = { busy: new Set(), content: new Set(), failExecute: new Set(), kinds: [] };
  engineHistoryTestHooks.createWorker = () => new ScriptWorker() as unknown as Worker;
  resetDeletionObserverForTests();
  vi.mocked(recordFact).mockClear();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name];
});

const record = (over: Partial<PendingConversationDeletion> = {}): PendingConversationDeletion => ({
  id: crypto.randomUUID(), createdAt: 1, threadIds: [THREAD], desks: [{ botId: BOT, threadId: THREAD }], botIds: [], engineSessions: {},
  engineHomes: [{ engine: "codex", home: HOME_A }, { engine: "claude", home: HOME_B }], attachments: [], artifactBlobs: [], leftovers: [], ...over,
});

function service(entries: PendingConversationDeletion[], options: Partial<DeletionServiceOptions> = {}) {
  const dataDir = fresh("data");
  const db = new DatabaseSync(join(dataDir, "messages.db"));
  databases.push(db);
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  writeFileSync(join(dataDir, "pending-deletions.json"), JSON.stringify(entries));
  return { dataDir, deletions: new ConversationDeletions({ dataDir, database: () => db, retryDelaysMs: [], ...options }) };
}
function artifactService() {
  const dataDir = fresh("data");
  const db = new DatabaseSync(join(dataDir, "messages.db"));
  databases.push(db);
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(thread_id,id)); CREATE TABLE artifacts(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL)");
  writeFileSync(join(dataDir, "pending-deletions.json"), JSON.stringify([record({ engineHomes: [] })]));
  return { db, deletions: new ConversationDeletions({ dataDir, database: () => db, retryDelaysMs: [] }) };
}
const redoJournal = (dataDir: string, engine: string, home: string) => {
  const file = join(dataDir, "engine-redo", `${"a".repeat(32)}.json`);
  mkdirSync(join(dataDir, "engine-redo"), { recursive: true });
  writeFileSync(file, JSON.stringify({ v: 2, kind: "rows", engine, home, path: join(home, "history.jsonl"), dev: "1", ino: "2", rows: [], how: "lock", format: "x" }));
  return file;
};
const rows = () => {};
const never = () => false;
const pendingFact = (kind: string) => vi.mocked(recordFact).mock.calls.map(([fact]) => fact as { engineKind?: string; pendingCount?: number }).filter((fact) => fact.engineKind === kind).at(-1)?.pendingCount;

it("two homes busy in turn: each is verified on its own, nothing is shown as owed, and the record stays until one attempt finds both free", async () => {
  const { deletions } = service([record()]);
  const ids = deletions.triage(never, rows);
  await deletions.prepareBoot(ids);

  script.busy = new Set([KEY_A]);
  await deletions.finish(deletions.pending()[0]!);
  expect(deletions.pending()[0]!.homesVerified).toEqual([KEY_B]);
  expect(deletions.pending()[0]!.owed?.items.map((item) => item.home)).toEqual([KEY_A]);
  expect(pendingFact("codex")).toBe(1);
  expect(pendingFact("claude")).toBe(0);

  script.busy = new Set([KEY_B]);
  await deletions.finish(deletions.pending()[0]!);
  expect(deletions.pending()[0]!.homesVerified!.sort()).toEqual([KEY_A, KEY_B].sort());
  expect(deletions.pending()[0]!.owed).toBeUndefined();
  expect(deletions.notices()).toEqual([]);
  expect(pendingFact("codex")).toBe(0);
  expect(pendingFact("claude")).toBe(0);
  expect(deletions.pending(), "a record is never cleared from marks").toHaveLength(1);

  script.busy = new Set();
  await deletions.finish(deletions.pending()[0]!);
  expect(deletions.pending()).toEqual([]);
});

it("a home whose plan shows content again leaves the verified homes; one cleaned in the same attempt stays", async () => {
  const { deletions } = service([record({ homesVerified: [KEY_A, KEY_B] })]);
  deletions.triage(never, rows);
  script.content = new Set([KEY_A]);
  script.failExecute = new Set([KEY_A]);
  script.busy = new Set([KEY_B]);
  await deletions.finish(deletions.pending()[0]!);
  expect(deletions.pending()[0]!.homesVerified).toEqual([KEY_B]);
  expect(deletions.pending()[0]!.owed?.items.map((item) => item.home)).toEqual([KEY_A]);

  script.failExecute = new Set();
  await deletions.finish(deletions.pending()[0]!);
  expect(deletions.pending()[0]!.homesVerified!.sort()).toEqual([KEY_A, KEY_B].sort());
});

it("the plan that finds content takes the home off the verified list in the same save, before any step runs", async () => {
  const { dataDir, deletions } = service([record({ homesVerified: [KEY_A, KEY_B] })]);
  deletions.triage(never, rows);
  script.content = new Set([KEY_A]);
  let saved: PendingConversationDeletion | undefined;
  script.gate = (job) => { if (job.kind === "execute") saved = JSON.parse(readFileSync(join(dataDir, "pending-deletions.json"), "utf8"))[0]; };
  await deletions.finish(deletions.pending()[0]!);
  expect(saved?.enginePlan?.homes[KEY_A], "the plan is saved").toBeDefined();
  expect(saved?.homesVerified).toEqual([KEY_B]);
});

it("an open pass that finds content takes a busy home off the verified list too", async () => {
  const { deletions } = service([record({ homesVerified: [KEY_A, KEY_B] })]);
  deletions.triage(never, rows);
  script.busy = new Set([KEY_B]);
  script.content = new Set([KEY_B]);
  await deletions.finish(deletions.pending()[0]!);
  expect(deletions.pending()[0]?.homesVerified ?? [], "a busy home with content is not verified").not.toContain(KEY_B);
  expect(deletions.pending()[0]!.owed?.items.map((item) => item.home)).toEqual([KEY_B]);
});

it("a home that is no longer one of the record's homes is not reported as verified", async () => {
  const { deletions } = service([record({ homesVerified: [KEY_B, "codex\0/gone"] })]);
  deletions.triage(never, rows);
  script.busy = new Set([KEY_A]);
  await deletions.finish(deletions.pending()[0]!);
  expect(deletions.pending()[0]!.homesVerified).toEqual([KEY_B]);
});

it("a failed prepare arms a retry, and nothing reaches the engine work before the rows are gone", async () => {
  let fails = 1;
  const order: string[] = [];
  const { deletions } = service([record()], { retryDelaysMs: [5, 5], forgetThreads: () => { order.push("forget"); if (fails-- > 0) throw new Error("busy"); } });
  script.gate = (job) => { order.push(job.kind ?? ""); };
  const ids = deletions.triage(never, () => { order.push("rows"); });
  await deletions.prepareBoot(ids);
  expect(deletions.isDeleting(THREAD), "still hidden after a failed prepare").toBe(true);
  await vi.waitFor(() => expect(deletions.pending()).toEqual([]), { timeout: 5_000 });
  expect(deletions.isDeleting(THREAD)).toBe(false);
  const firstEngineJob = order.findIndex((step) => step === "removeTrees" || step === "probe");
  expect(order.lastIndexOf("forget")).toBeLessThan(firstEngineJob);
  deletions.dispose();
});

it("settleDeferred and Try again now cannot finish a record that was never prepared", async () => {
  const deferred = "1a1b2c3d-1111-4222-8333-444455556666.png";
  for (const act of [(service_: ConversationDeletions) => service_.settleDeferred(never), (service_: ConversationDeletions) => service_.retryNow()]) {
    const removedRows: string[] = [];
    const { deletions } = service([record({ deferredAttachments: [deferred], engineHomes: [] })]);
    deletions.triage(never, (id) => { removedRows.push(id); });
    await act(deletions);
    expect(removedRows).toEqual([THREAD]);
  }
});

it("the pass goes to a record with a crash journal first, then the least recently tried, and saves when it tried", async () => {
  const stale = record({ lastTriedAt: 300 }), recent = record({ lastTriedAt: 100 }), never_ = record(), journaled = record({ lastTriedAt: 900, engineHomes: [{ engine: "grok", home: "/journaled" }] });
  const { deletions, dataDir } = service([stale, recent, never_, journaled]);
  redoJournal(dataDir, "grok", "/journaled");
  script.busy = new Set([KEY_A]);
  const finish = vi.spyOn(deletions, "finish");
  const ids = deletions.triage(never, rows);
  await deletions.prepareBoot(ids);
  await deletions.drain(ids);
  expect(finish.mock.calls.map(([entry]) => entry.id)).toEqual([journaled.id, never_.id, recent.id, stale.id]);
  for (const entry of deletions.pending()) expect(entry.lastTriedAt).toBeGreaterThan(1_000);
});

it("a record whose conversation came back during the pass is left alone, never dropped", async () => {
  const entry = record();
  const { deletions } = service([entry]);
  let live = false;
  const ids = deletions.triage(() => live, rows);
  await deletions.prepareBoot(ids);
  live = true;
  const finish = vi.spyOn(deletions, "finish");
  await deletions.drain(ids);
  expect(finish).not.toHaveBeenCalled();
  expect(deletions.pending().map((item) => item.id)).toEqual([entry.id]);
});

it("one failed attempt does not stop the pass", async () => {
  const first = record(), second = record();
  const { deletions } = service([first, second]);
  const ids = deletions.triage(never, rows);
  await deletions.prepareBoot(ids);
  const real = deletions.finish.bind(deletions);
  vi.spyOn(deletions, "finish").mockImplementationOnce(async () => { throw new Error("no"); }).mockImplementation(real);
  expect(await deletions.drain(ids)).toBe(1);
  expect(deletions.pending().map((item) => item.id)).toEqual([first.id]);
});

it("a live thread is dropped at triage as ever, and a journal that cannot be read is left whole", () => {
  const live = record(), other = record({ threadIds: ["other-thread"], desks: [] });
  const { deletions } = service([live, other]);
  expect(deletions.triage((id) => id === THREAD, rows)).toEqual([other.id]);
  expect(deletions.pending().map((item) => item.id)).toEqual([other.id]);

  const broken = service([]);
  writeFileSync(broken.deletions.journal, "{not json");
  expect(broken.deletions.triage(never, rows)).toEqual([]);
  expect(readFileSync(broken.deletions.journal, "utf8")).toBe("{not json");
  expect(script.kinds).not.toContain("recover");
});

it("no records and no crash journal start no worker", async () => {
  const { deletions } = service([]);
  expect(deletions.triage(never, rows)).toEqual([]);
  await deletions.drain([]);
  expect(script.kinds).toEqual([]);
});

it("a crash journal with no record still gets its recover job", async () => {
  const { deletions, dataDir } = service([]);
  redoJournal(dataDir, "codex", HOME_A);
  deletions.triage(never, rows);
  await deletions.drain([]);
  expect(script.kinds).toEqual(["recover"]);
});

it("a crash journal holds its engine's turns from before the port opens until recover has cleared it", async () => {
  const release = vi.fn();
  const holdHomesNow = vi.fn(() => release);
  const { deletions, dataDir } = service([record()], { holdHomesNow });
  const journal = redoJournal(dataDir, "codex", HOME_A);
  let finishRecover!: () => void;
  const recovered = new Promise<void>((resolve) => { finishRecover = resolve; });
  script.gate = async (job) => { if (job.kind === "recover") { await recovered; removeTempDirSync(journal); } };
  deletions.triage(never, rows);
  expect(holdHomesNow).toHaveBeenCalledTimes(1);
  expect(holdHomesNow).toHaveBeenCalledWith([{ engine: "codex", home: HOME_A }]);
  expect(release).not.toHaveBeenCalled();
  finishRecover();
  await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  deletions.dispose();
  expect(release).toHaveBeenCalledTimes(1);
});

it("a crash journal recover could not clear keeps the hold until the pass ends; dispose lets go too", async () => {
  const release = vi.fn();
  const first = service([record({ engineHomes: [] })], { holdHomesNow: () => release });
  redoJournal(first.dataDir, "codex", HOME_A);
  const ids = first.deletions.triage(never, rows);
  await (first.deletions as unknown as { recovery: Promise<void> }).recovery;
  expect(release).not.toHaveBeenCalled();
  await first.deletions.prepareBoot(ids);
  await first.deletions.drain(ids);
  expect(release).toHaveBeenCalledTimes(1);

  const second = vi.fn();
  const other = service([record()], { holdHomesNow: () => second });
  redoJournal(other.dataDir, "codex", HOME_A);
  other.deletions.triage(never, rows);
  other.deletions.dispose();
  expect(second).toHaveBeenCalledTimes(1);
});

it("crash journals that cannot be listed hold every pending home", () => {
  const holdHomesNow = vi.fn(() => () => {});
  const { deletions, dataDir } = service([record()], { holdHomesNow });
  mkdirSync(join(dataDir, "engine-redo"));
  vi.spyOn(fsOps, "readdir").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
  deletions.triage(never, rows);
  expect(holdHomesNow).toHaveBeenCalledWith(record().engineHomes);
  deletions.dispose();
});

it("a boot record's conversation and certain attachments stay out of sight until it is prepared and past its file step; deferred ones are not its to hide", async () => {
  const deferred = "1a1b2c3d-1111-4222-8333-444455556666.png";
  const { deletions } = service([record({ attachments: [FILE], deferredAttachments: [deferred], engineHomes: [] })]);
  const ids = deletions.triage(never, rows);
  expect(deletions.isDeleting(THREAD)).toBe(true);
  expect(deletions.isDeleting("another-thread")).toBe(false);
  expect(deletions.attachmentPending(FILE)).toBe(true);
  expect(deletions.attachmentPending(FILE.toUpperCase())).toBe(true);
  expect(deletions.attachmentPending(deferred)).toBe(false);
  await deletions.prepareBoot(ids);
  expect(deletions.isDeleting(THREAD)).toBe(false);
  expect(deletions.attachmentPending(FILE), "the file is there until the first attempt reaches it").toBe(true);
  await deletions.drain(ids);
  expect(deletions.attachmentPending(FILE)).toBe(false);
});

it("a boot record's saved files leave at triage, before the port opens, and no engine job is needed for that", () => {
  const { deletions, db } = artifactService();
  db.prepare("INSERT INTO artifacts(id,thread_id) VALUES('mine',?),('other','another-thread')").run(THREAD);
  deletions.triage(never, rows);
  expect((db.prepare("SELECT id FROM artifacts").all() as Array<{ id: string }>).map((row) => row.id)).toEqual(["other"]);
  expect(deletions.artifactRowsPending()).toBe(false);
});

it("saved-file rows triage could not remove close Files until prepare has removed them, and a failed prepare keeps it closed", async () => {
  const { deletions, db } = artifactService();
  db.prepare("INSERT INTO artifacts(id,thread_id) VALUES('mine',?)").run(THREAD);
  const statement = db.prepare.bind(db);
  let locked = true;
  vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
    if (locked && sql.startsWith("DELETE FROM artifacts")) throw new Error("database is locked");
    return statement(sql);
  });
  const ids = deletions.triage(never, rows);
  expect(deletions.artifactRowsPending()).toBe(true);
  await deletions.prepareBoot(ids);
  expect(deletions.artifactRowsPending(), "still locked: still closed").toBe(true);
  expect(deletions.isDeleting(THREAD)).toBe(true);
  locked = false;
  await deletions.prepareBoot(ids);
  expect(deletions.artifactRowsPending()).toBe(false);
  expect(statement("SELECT count(*) AS n FROM artifacts").get()).toEqual({ n: 0 });
});

it("the three read paths ask the gate", () => {
  const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
  expect(source).toMatch(/function mayReadThread\([^)]*\): boolean \{\n\s*if \(conversationDeletions\.isDeleting\(threadId\)\) return false;/);
  expect(source).toMatch(/readDecisions\(DATA_DIR, parsedLimit \?\? 200\)\.filter\(\(row\) => !conversationDeletions\.isDeleting\(row\.threadId\)\)/);
  expect(source).toMatch(/const visible = \(\) => !conversationDeletions\.attachmentPending\(/);
  expect(source).toMatch(/path\.startsWith\("\/api\/artifacts\/"\)\) \{\n\s*if \(conversationDeletions\.artifactRowsPending\(\)\) return json\(res, 503/);
});

it("a boot attempt removes folders in the worker; a live delete keeps its one inline step", async () => {
  const boot = service([record({ engineHomes: [] })]);
  const ids = boot.deletions.triage(never, rows);
  await boot.deletions.prepareBoot(ids);
  await boot.deletions.drain(ids);
  expect(script.kinds).toContain("removeTrees");

  script.kinds = [];
  const live = service([]);
  const desk = join(live.dataDir, "workspaces", BOT, "threads", THREAD);
  mkdirSync(desk, { recursive: true });
  await runConversationDeletion(live.deletions, { threadIds: [THREAD] }, () => true);
  expect(existsSync(desk)).toBe(false);
  expect(script.kinds).not.toContain("removeTrees");
});

it("the removeTrees job keeps the confined removal's rules, and a job that cannot run reports every folder failed", async () => {
  const root = fresh("root"), outside = fresh("outside");
  mkdirSync(join(root, "gone", "deep"), { recursive: true });
  symlinkSync(outside, join(root, "link"));
  const result = runEngineHistoryJob({ kind: "removeTrees", trees: [{ root, target: join(root, "gone") }, { root, target: join(root, "absent") }, { root, target: join(root, "link", "inside") }, { root, target: outside }], homes: [], folders: [], memoryFolders: [], sessions: {} });
  expect(result.removed).toEqual([join(root, "gone")]);
  expect(result.failed.sort()).toEqual([join(root, "link", "inside"), outside].sort());
  expect(existsSync(outside)).toBe(true);

  const failed = await runEngineHistoryOffThread({ kind: "removeTrees", trees: [{ root, target: "a" }, { root, target: "b" }], homes: [], folders: [], memoryFolders: [], sessions: {} }, { createWorker: () => { throw new Error("no thread"); } });
  expect(failed.failed).toEqual(["a", "b"]);
});

it("holdNow holds in one step, and letting go twice lets go once", async () => {
  const holds = new InstanceHolds();
  const outer = holds.holdNow(["one"]);
  const inner = holds.holdNow(["one"]);
  outer();
  outer();
  expect(holds.isHeld("one"), "the second hold stands").toBe(true);
  let admitted = false;
  void holds.admit("one", THREAD).then(() => { admitted = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(admitted).toBe(false);
  inner();
  await vi.waitFor(() => expect(admitted).toBe(true));
});
