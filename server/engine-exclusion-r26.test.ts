// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r26 (Astra r25c): a journal whose barrier was only the fallback is dropped only by a LATER START of the server, never by another
// worker of the same run (every deletion job starts a new worker, and a worker's module load is not a start). The start is a counter
// the server claims once, persisted and synced in the data folder, and hands to every worker. And an undo of a join never cuts a row a
// lock-ignoring editor appended after the comparison: just before the cut the writers are asked and the size and tail read again.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConversationDeletions } from "./conversation-deletion.ts";
import { executeEnginePlans, recoverAll } from "./engine-exec.ts";
import { loadExclusionAddon } from "./engine-exclusion.ts";
import { mutOps, realEngineFs } from "./engine-fs.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { removeEngineHistoryFiles, runEngineHistoryJob } from "./engine-history-run.ts";
import { homeKey, Known, Planner, type HomePlanData } from "./engine-plan-core.ts";
import * as redo from "./engine-redo.ts";
import { listRedo, redoDirectory, redoStart } from "./engine-redo.ts";
import { useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { buildFixture, canaryHits, type Fixture } from "./testing/engine-history-fixtures.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-r26-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const start = redoStart as { seq?: number; id?: string };
let fake: FakeExclusion;
beforeEach(() => { fake = useFakeExclusion(); clearJournals(); start.seq = 7; });
afterEach(() => {
  fake.restore();
  start.seq = undefined;
  for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name];
});

const dump = (value: unknown) => `${JSON.stringify(value)}\n`;
const key = (fx: Fixture) => homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);
const C = (engine: string) => `canary-${engine}-5521`;
const B = (engine: string) => `bystander-${engine}-9917`;
function clearJournals(): void { const dir = redoDirectory(); if (dir && existsSync(dir)) for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true }); }
const journalFiles = (): string[] => { const dir = redoDirectory(); return dir && existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : []; };
const withSync = (answer: (fd: number) => unknown, work: () => void) => {
  const addon = loadExclusionAddon()! as unknown as { fullSync: (fd: number) => unknown };
  const before = addon.fullSync;
  addon.fullSync = answer;
  try { work(); } finally { addon.fullSync = before; }
};
const fallback = () => "fallback";
/** What a new worker thread is: a fresh load of every module (at 62e79025c a fresh random start id). The run's counter is the job's. */
const newWorker = () => { start.id = Math.random().toString(16).slice(2).padEnd(32, "0"); };
/** A recovery job as a worker of the server start `appStart` runs it. */
const recoverJob = (appStart: number | undefined) => runEngineHistoryJob({ kind: "recover", homes: [], folders: [], memoryFolders: [], sessions: {}, redoDir: redoDirectory()!, appStart } as EngineHistoryJob);

/** A Fuigo log with one row to clear and one bystander, and its plan. */
function fuigoLog(): { log: string; original: Buffer; plans: Record<string, HomePlanData> } {
  const fx = buildFixture("fuigo", scratch);
  const home = fx.homes[0]!.home;
  const log = join(home, "logs", "unified.jsonl");
  writeFileSync(log, dump({ sid: "s-1", text: `PRIVATE ${C("fuigo")}` }) + dump({ sid: "s-other", text: B("fuigo") }));
  const pl = new Planner(realEngineFs(), new Known());
  pl.rewrite(log, { pred: { any: [{ field: "sid", op: "in", values: ["s-1"] }] }, needles: ["s-1"], format: "fuigo-unified", how: "lock" });
  return { log, original: readFileSync(log), plans: { [homeKey("fuigo", home)]: { engine: "fuigo", home, steps: pl.steps } as HomePlanData } };
}

// ── 1. a fallback journal waits for a later START, never for another worker ─────────────────────────────────────────────

describe.skipIf(process.platform === "win32")("Astra r25c: two workers of the same run never drop a fallback journal", () => {
  it("rows: the next workers of start 7 keep it (no barrier, no read-back drops it); a later start that verifies the bytes drops it", () => {
    const { log, plans } = fuigoLog();
    withSync(fallback, () => { expect(executeEnginePlans(plans).failedHomes).toEqual([]); });
    expect(readFileSync(log, "utf8")).not.toContain(C("fuigo"));
    expect(journalFiles()).toHaveLength(1);
    for (let worker = 0; worker < 3; worker++) {
      newWorker();
      withSync(fallback, () => { expect(recoverJob(7).failed).toEqual([]); });
      expect(journalFiles(), `worker ${worker}`).toHaveLength(1); // 62e79025c: the second worker dropped it with zero barrier calls
    }
    // a worker that was given no counter cannot rank any start: it keeps it too
    newWorker();
    withSync(fallback, () => { recoverJob(undefined); });
    expect(journalFiles()).toHaveLength(1);
    // the real later start reads the rows again, finds them cleared, and drops the journal with nothing written
    newWorker();
    fake.calls.length = 0;
    withSync(fallback, () => { expect(recoverJob(8).failed).toEqual([]); });
    expect(fake.calls.filter((call) => call === "pwrite")).toEqual([]);
    expect(journalFiles()).toEqual([]);
    expect(readFileSync(log, "utf8")).toContain(B("fuigo"));
  });

  it("rows: a later start that finds the bytes lost repairs them and keeps the journal for the start after it", () => {
    const { log, original, plans } = fuigoLog();
    withSync(fallback, () => { executeEnginePlans(plans); });
    writeFileSync(log, original); // the modeled power cut: the repaired bytes did not reach the drive
    newWorker();
    withSync(fallback, () => { recoverJob(8); });
    expect(readFileSync(log, "utf8")).not.toContain(C("fuigo"));
    expect(journalFiles()).toHaveLength(1);
    expect(listRedo()[0]!.fellBack).toBe(8);
    newWorker();
    withSync(fallback, () => { recoverJob(8); }); // another worker of start 8: kept
    expect(journalFiles()).toHaveLength(1);
    newWorker();
    withSync(fallback, () => { recoverJob(9); });
    expect(journalFiles()).toEqual([]);
  });

  it("join: another worker of the same run never removes the engine's newer file; a later start that finds its rows does", () => {
    const fx = buildFixture("kimi", scratch);
    const index = join(fx.homes[0]!.home, "session_index.jsonl");
    const away = `${index}.murage-deleting`;
    writeFileSync(away, readFileSync(index));
    const newer = [dump({ sessionId: "s3", workDir: "/third", title: "NEWER-ROW-ONE" }), dump({ sessionId: "s4", workDir: "/fourth", title: "NEWER-ROW-TWO" })];
    writeFileSync(index, newer.join(""));
    let first!: ReturnType<typeof removeEngineHistoryFiles>;
    withSync(fallback, () => { first = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions); });
    expect(first.failedHomes).toEqual([key(fx)]);
    expect(existsSync(`${index}.murage-rejoining`)).toBe(true);
    // a second deletion job of the same run (a new worker, start 7)
    newWorker();
    let again!: ReturnType<typeof removeEngineHistoryFiles>;
    withSync(fallback, () => { again = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, first.discovery ?? {}); });
    expect(again.failedHomes).toEqual([key(fx)]);
    expect(existsSync(`${index}.murage-rejoining`)).toBe(true); // 62e79025c: removed with the journal, no durability proof
    newWorker();
    withSync(fallback, () => { recoverJob(7); });
    expect(existsSync(`${index}.murage-rejoining`)).toBe(true);
    expect(listRedo().filter((item) => item.kind === "join")).toHaveLength(1);
    // the later start
    newWorker();
    start.seq = 8;
    let later!: ReturnType<typeof removeEngineHistoryFiles>;
    withSync(fallback, () => { later = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, first.discovery ?? {}); });
    expect(later.failedHomes).toEqual([]);
    expect(existsSync(`${index}.murage-rejoining`)).toBe(false);
    const text = readFileSync(index, "utf8");
    for (const row of newer) expect(text).toContain(row);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });
});

describe("the start counter: claimed once per server start, persisted and synced, never behind a journal", () => {
  it("counts up, is written to a new synced file, renamed over the last one and the folder synced, before it is used", () => {
    const dir = join(mkdtempSync(join(scratch, "start-")), "engine-redo");
    const order: string[] = [];
    const real = { writeDurable: mutOps.writeDurable, rename: mutOps.rename, fsyncDir: mutOps.fsyncDir };
    mutOps.writeDurable = ((path: string, bytes: Buffer) => { order.push("writeDurable"); real.writeDurable(path, bytes); }) as typeof mutOps.writeDurable;
    mutOps.rename = ((from: string, to: string) => { order.push("rename"); real.rename(from, to); }) as typeof mutOps.rename;
    mutOps.fsyncDir = ((path: string) => { order.push("fsyncDir"); return real.fsyncDir(path); }) as typeof mutOps.fsyncDir;
    try {
      expect(redo.claimAppStart(dir)).toBe(1);
      expect(order).toEqual(["writeDurable", "rename", "fsyncDir"]);
      expect(redo.claimAppStart(dir)).toBe(2);
    } finally { Object.assign(mutOps, real); }
    expect(JSON.parse(readFileSync(join(dir, redo.APP_START_FILE), "utf8"))).toEqual({ start: 2 });
    expect(readdirSync(dir)).toEqual([redo.APP_START_FILE]);
  });

  it("a counter file lost or cut by a power cut never falls behind a journal it must outrank", () => {
    const dir = join(mkdtempSync(join(scratch, "start-")), "engine-redo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${"a".repeat(32)}.json`), JSON.stringify({ v: 2, kind: "rows", id: "a".repeat(32), path: "/x", dev: "1", ino: "2", engine: "fuigo", home: "/h", how: "lock", format: "fuigo-unified", rows: [], fellBack: 41 }));
    writeFileSync(join(dir, redo.APP_START_FILE), "{\"sta");
    expect(redo.claimAppStart(dir)).toBe(42);
  });

  it("the deletion service claims it once per start and hands the same counter to every worker; the next start has a greater one", async () => {
    const data = mkdtempSync(join(scratch, "data-"));
    const jobs: EngineHistoryJob[] = [];
    engineHistoryTestHooks.createWorker = () => new ScriptedWorker((job, worker) => { jobs.push(job); worker.emit("message", { type: "result", result: { removed: [], failed: [], leftovers: [] } }); }) as unknown as Worker;
    const database = () => { throw new Error("no database in this test"); };
    const run = new ConversationDeletions({ dataDir: data, database, retryDelaysMs: [] });
    await run.reconcile(() => false, () => {});
    await run.reconcile(() => false, () => {});
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.appStart).toBe(1);
    expect(jobs[1]!.appStart).toBe(1); // a second worker of the same run: the same start
    const next = new ConversationDeletions({ dataDir: data, database, retryDelaysMs: [] });
    await next.reconcile(() => false, () => {});
    expect(jobs[2]!.appStart).toBe(2);
    run.dispose(); next.dispose();
  });
});

class ScriptedWorker extends EventEmitter {
  threadId = 12;
  readonly script: (job: EngineHistoryJob, worker: ScriptedWorker) => void;
  constructor(script: (job: EngineHistoryJob, worker: ScriptedWorker) => void) { super(); this.script = script; }
  postMessage(message: EngineHistoryJob) { setImmediate(() => this.script(message, this)); }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}

// ── 2. an undo of a join never cuts a row an editor appended after the comparison ───────────────────────────────────────

/** A Kimi home as an earlier attempt left it, a join cut half way by a failed write, and the power cut that undid the rename of the
 * newer file (it is public again): recovery undoes the join. */
function cutJoinUndone(): { index: string; away: string; base: number } {
  const fx = buildFixture("kimi", scratch);
  const index = join(fx.homes[0]!.home, "session_index.jsonl");
  const away = `${index}.murage-deleting`;
  writeFileSync(away, readFileSync(index));
  writeFileSync(index, dump({ sessionId: "s3", workDir: "/third", title: "NEWER-ROW-ONE" }) + dump({ sessionId: "s4", workDir: "/fourth", title: "NEWER-ROW-TWO" }));
  const base = statSync(away).size;
  const real = { pwrite: mutOps.pwrite };
  let cut = false;
  mutOps.pwrite = ((fd: number, bytes: Buffer, position: number) => {
    if (!cut && bytes.includes("NEWER-ROW-ONE")) { cut = true; writeSync(fd, bytes, 0, 40, position); throw Object.assign(new Error("EIO"), { code: "EIO" }); }
    return real.pwrite(fd, bytes, position);
  }) as typeof mutOps.pwrite;
  try { removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions); } finally { Object.assign(mutOps, real); }
  expect(cut).toBe(true);
  renameSync(`${index}.murage-rejoining`, index);
  return { index, away, base };
}

describe.skipIf(process.platform === "win32")("Astra r25c: an editor that ignores the lock appends after the tail comparison", () => {
  it("the writers are asked just before the cut; the editor is seen, nothing is cut and the bystander stays", () => {
    const { away, base } = cutJoinUndone();
    const bystander = Buffer.from(dump({ sessionId: "s-by", workDir: "/by", title: B("kimi") }));
    const editor = fake.openForWriting(away);
    const real = mutOps.pread;
    let appended = -1;
    // the editor appends right after Murage read the bytes after the join's start (the comparison), before any cut
    mutOps.pread = ((fd: never, length: number, position: number) => {
      const read = real(fd, length, position);
      if (appended < 0 && position === base && length > 0) { writeSync(editor.fd, bystander, 0, bystander.length, statSync(away).size); appended = fake.calls.length; }
      return read;
    }) as typeof mutOps.pread;
    let ran!: ReturnType<typeof recoverAll>;
    try { ran = recoverAll(); } finally { mutOps.pread = real; editor.close(); }
    expect(appended).toBeGreaterThan(0);
    expect(fake.calls.slice(appended)).toContain("writers"); // 62e79025c: zero writer queries, cut to 63 bytes
    expect(ran.pending).toHaveLength(1);
    expect(readFileSync(away, "utf8")).toContain(B("kimi"));
    expect(statSync(away).size).toBeGreaterThan(base);
    expect(listRedo().filter((item) => item.kind === "join")).toHaveLength(1);
  });

  it("an editor no check can see appends at the moment of the writers query: the size read again before the cut refuses", () => {
    const { away, base } = cutJoinUndone();
    const before = statSync(away).size;
    let asked = 0;
    fake.onWriters = () => { if (asked++ === 0) appendFileSync(away, dump({ sessionId: "s-ghost", workDir: "/g", title: B("kimi") })); return { writers: [], unreadable: [], openForWrite: false }; };
    const ran = recoverAll();
    expect(asked).toBe(1);
    expect(ran.pending).toHaveLength(1);
    expect(readFileSync(away, "utf8")).toContain(B("kimi"));
    expect(statSync(away).size).toBeGreaterThan(before);
    expect(before).toBeGreaterThan(base);
    expect(listRedo().filter((item) => item.kind === "join")).toHaveLength(1);
  });

  it("a writers answer that cannot be read refuses too", () => {
    const { away } = cutJoinUndone();
    const before = readFileSync(away);
    fake.onWriters = () => { throw new Error("unreadable"); };
    expect(recoverAll().pending).toHaveLength(1);
    expect(readFileSync(away).equals(before)).toBe(true);
  });

  it("no writer and nothing changed: the join's own bytes come off, after the writers were asked", () => {
    const { away, base } = cutJoinUndone();
    fake.calls.length = 0;
    expect(recoverAll().pending).toEqual([]);
    expect(fake.calls).toContain("writers");
    expect(statSync(away).size).toBe(base);
    expect(listRedo()).toEqual([]);
  });
});
