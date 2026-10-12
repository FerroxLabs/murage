// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r23: the kernel's own "open for writing" keeps a file whatever else the writers check says; REJOIN never writes over a row another
// process put in the older file; a journal is dropped (after a rewrite, a recovery or a join) only after the same durability barrier
// through the drive's cache; a newer file stranded by an interrupted join is joined, never forgotten; a step that wrote nothing leaves
// no journal; and (Linux, the real addon) one file found open for writing is the answer for the whole set.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeEnginePlans, recoverAll } from "./engine-exec.ts";
import { loadExclusionAddon } from "./engine-exclusion.ts";
import { mutOps, realEngineFs } from "./engine-fs.ts";
import { removeEngineHistoryFiles } from "./engine-history-run.ts";
import { homeKey, Known, Planner, type HomePlanData } from "./engine-plan-core.ts";
import { redoDirectory } from "./engine-redo.ts";
import { builtAddonPath, useFakeExclusion, useRealExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { buildFixture, canaryHits, type Fixture } from "./testing/engine-history-fixtures.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-r23-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let fake: FakeExclusion;
beforeEach(() => { fake = useFakeExclusion(); clearJournals(); });
afterEach(() => { fake.restore(); });

const dump = (value: unknown) => `${JSON.stringify(value)}\n`;
const key = (fx: Fixture) => homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);
const C = (engine: string) => `canary-${engine}-5521`;
const B = (engine: string) => `bystander-${engine}-9917`;
function clearJournals(): void { const dir = redoDirectory(); if (dir && existsSync(dir)) for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true }); }
const journalFiles = (): string[] => { const dir = redoDirectory(); return dir && existsSync(dir) ? readdirSync(dir) : []; };
const rows = (file: string): string[] => readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
const everyRowParses = (file: string): boolean => rows(file).every((line) => { try { JSON.parse(line); return true; } catch { return false; } });
const count = (text: string, row: string) => text.split(row).length - 1;
const ROLLOUT = ["sessions", "2026", "10", "11", "rollout-2026-10-11T10-00-00-019a0000-aaaa-7bbb-8ccc-000000000001.jsonl"];

/** A Kimi home as an earlier attempt left it: the old index set aside, and the new one Kimi started at the name meanwhile. */
function forkedKimi(): { fx: Fixture; index: string; away: string; newer: string[] } {
  const fx = buildFixture("kimi", scratch);
  const index = join(fx.homes[0]!.home, "session_index.jsonl");
  const away = `${index}.murage-deleting`;
  writeFileSync(away, readFileSync(index));
  const newer = [dump({ sessionId: "s3", workDir: "/third", title: "NEWER-ROW-ONE" }), dump({ sessionId: "s4", workDir: "/fourth", title: "NEWER-ROW-TWO" })];
  writeFileSync(index, newer.join(""));
  return { fx, index, away, newer };
}

/** A plan of one file's rows, made by the planner itself. */
function planRows(engine: string, home: string, file: string, format: string, how: "lock" | "exclusive", field: string, values: string[]): Record<string, HomePlanData> {
  const pl = new Planner(realEngineFs(), new Known());
  pl.rewrite(file, { pred: { any: [{ field, op: "in", values }] }, needles: values, format, how });
  return { [homeKey(engine, home)]: { engine, home, steps: pl.steps } as HomePlanData };
}

/** A Fuigo log with one row to clear and one bystander, and its plan. */
function fuigoLog(): { fx: Fixture; log: string; plans: Record<string, HomePlanData> } {
  const fx = buildFixture("fuigo", scratch);
  const home = fx.homes[0]!.home;
  const log = join(home, "logs", "unified.jsonl");
  writeFileSync(log, dump({ sid: "s-1", text: `PRIVATE ${C("fuigo")}` }) + dump({ sid: "s-other", text: B("fuigo") }));
  return { fx, log, plans: planRows("fuigo", home, log, "fuigo-unified", "lock", "sid", ["s-1"]) };
}

// ── Astra r22 P1-1 / Fable r22 P2: a positive kernel answer holds the file ─────────────────────────────────────────────────

describe("a file the kernel says is open for writing is never removed, whatever the process scan saw", () => {
  it("no writer named and no process unreadable (a writer in another pid namespace), the kernel says open: the rollout stays", () => {
    const fx = buildFixture("codex", scratch);
    const rollout = join(fx.homes[0]!.home, ...ROLLOUT);
    fake.onWriters = () => ({ writers: [], unreadable: [], openForWrite: true });
    const first = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(first.failedHomes).toEqual([key(fx)]);
    expect(first.homeReasons?.[key(fx)]).toBe("held");
    expect(existsSync(rollout)).toBe(true);
    // the writer ends: the kernel says so, and the rollout goes
    fake.onWriters = () => ({ writers: [], unreadable: [], openForWrite: false });
    const again = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, first.discovery ?? {});
    expect(again.failedHomes).toEqual([]);
    expect(existsSync(rollout)).toBe(false);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });

  it("only an unreadable root process, the kernel says open (a renamed engine run as root): the rollout stays", () => {
    const fx = buildFixture("codex", scratch);
    const rollout = join(fx.homes[0]!.home, ...ROLLOUT);
    fake.onWriters = () => ({ writers: [], unreadable: [{ pid: 99, uid: 0 }], openForWrite: true });
    const first = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(first.failedHomes).toEqual([key(fx)]);
    expect(first.homeReasons?.[key(fx)]).toBe("held");
    expect(existsSync(rollout)).toBe(true);
  });

  it("Kimi REJOIN: the kernel says the newer index is open for writing: it stays under its private name and nothing is lost", () => {
    const { fx, index, newer } = forkedKimi();
    fake.onWriters = (paths) => ({ writers: [], unreadable: [], openForWrite: paths.some((path) => path.endsWith(".murage-rejoining")) });
    const first = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(first.failedHomes).toEqual([key(fx)]);
    expect(first.homeReasons?.[key(fx)]).toBe("aside");
    expect(existsSync(`${index}.murage-rejoining`)).toBe(true);
    fake.onWriters = () => ({ writers: [], unreadable: [], openForWrite: false });
    const again = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(again.failedHomes).toEqual([]);
    const text = readFileSync(index, "utf8");
    for (const row of newer) expect(count(text, row), row).toBe(1);
    expect(everyRowParses(index)).toBe(true);
  });
});

// ── Astra r22 P1-2 / Fable r22 P2: REJOIN never writes over a row in the older file ───────────────────────────────────────

describe("REJOIN never writes over a row another process put in the older file", () => {
  const late = dump({ sessionId: "s9", workDir: "/ninth", title: "LOST-BYSTANDER" });

  it("a writer of the older file that the check can see: the join does not write at all, and joins once it has gone", () => {
    const { fx, index, away, newer } = forkedKimi();
    // a renamed Kimi opened the OLD index before it was set aside, and keeps it open
    let engineFd: number | null = openSync(away, "a");
    const asked: string[][] = [];
    fake.onWriters = (paths) => {
      asked.push(paths.map((path) => path.slice(index.length)));
      const writers = engineFd !== null && paths.some((path) => path === away) ? [{ pid: 4343, index: 0 }] : [];
      return { writers, unreadable: [] };
    };
    // it appends just before the join's positional write, if the join ever gets there
    const realPwrite = mutOps.pwrite;
    mutOps.pwrite = ((fd: number, bytes: Buffer, position: number) => {
      if (engineFd !== null && bytes.includes("NEWER-ROW-ONE")) { writeSync(engineFd, late); closeSync(engineFd); engineFd = null; }
      return realPwrite(fd, bytes, position);
    }) as typeof mutOps.pwrite;
    let first: ReturnType<typeof removeEngineHistoryFiles>;
    try { first = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions); } finally { mutOps.pwrite = realPwrite; }
    expect(asked.some((paths) => paths.includes(".murage-deleting"))).toBe(true);
    expect(first.failedHomes).toEqual([key(fx)]);
    expect(first.homeReasons?.[key(fx)]).toBe("aside");
    // the writer appends now and ends
    if (engineFd !== null) { writeSync(engineFd, late); closeSync(engineFd); engineFd = null; }
    expect(count(readFileSync(away, "utf8"), late)).toBe(1);
    const again = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(again.failedHomes).toEqual([]);
    const text = readFileSync(index, "utf8");
    for (const row of [...newer, late]) expect(count(text, row), row).toBe(1);
    expect(text).not.toContain(C("kimi"));
    expect(everyRowParses(index)).toBe(true);
    expect(journalFiles()).toEqual([]);
  });

  it("a writer the check cannot see (R7) appends after the join recorded its start and before it writes: the row is never overwritten", () => {
    const { fx, index, away, newer } = forkedKimi();
    const engineFd = openSync(away, "a");
    let appended = false;
    // the append lands right after the join's journal (its start: the older file's end then) is on disk
    const realWrite = mutOps.writeDurable;
    mutOps.writeDurable = ((path: string, bytes: Buffer) => {
      realWrite(path, bytes);
      if (!appended && bytes.includes('"kind":"join"')) { appended = true; writeSync(engineFd, late); }
    }) as typeof mutOps.writeDurable;
    let first: ReturnType<typeof removeEngineHistoryFiles>;
    try { first = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions); } finally { mutOps.writeDurable = realWrite; closeSync(engineFd); }
    expect(appended).toBe(true);
    // the row is still there, whole, in the older file; the join refused and its unwritten journal went
    expect(first.failedHomes).toEqual([key(fx)]);
    expect(first.homeReasons?.[key(fx)]).toBe("aside");
    expect(count(readFileSync(away, "utf8"), late)).toBe(1);
    expect(everyRowParses(away)).toBe(true);
    expect(journalFiles()).toEqual([]);
    // the next attempt joins after the row
    const again = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(again.failedHomes).toEqual([]);
    const text = readFileSync(index, "utf8");
    for (const row of [...newer, late]) expect(count(text, row), row).toBe(1);
    expect(text).toContain(B("kimi"));
    expect(text).not.toContain(C("kimi"));
    expect(everyRowParses(index)).toBe(true);
    expect(existsSync(`${index}.murage-rejoining`)).toBe(false);
    expect(journalFiles()).toEqual([]);
  });
});

// ── Astra r22 P1-3: recovery drops a journal only after the drive's own barrier ─────────────────────────────────────────

describe("a journal is dropped only after the file and its folder are made durable through the drive's cache, in recovery as in a rewrite", () => {
  function record(order: string[], redo: string): () => void {
    const real = { fsyncFile: mutOps.fsyncFile, fsyncDir: mutOps.fsyncDir, unlink: mutOps.unlink, fsync: mutOps.fsync };
    // the barrier calls (F_FULLFSYNC on macOS) are recorded, not the plain fsync of the write
    mutOps.fsyncFile = ((path: string) => { order.push(`barrier file ${path}`); real.fsyncFile(path); }) as typeof mutOps.fsyncFile;
    mutOps.fsyncDir = ((path: string) => { order.push(`barrier dir ${path}`); real.fsyncDir(path); }) as typeof mutOps.fsyncDir;
    mutOps.fsync = ((fd: Parameters<typeof mutOps.fsync>[0]) => { order.push("plain fsync"); real.fsync(fd); }) as typeof mutOps.fsync;
    mutOps.unlink = ((path: string) => { if (path.startsWith(redo)) order.push("drop journal"); real.unlink(path); }) as typeof mutOps.unlink;
    return () => { Object.assign(mutOps, real); };
  }

  it("a row torn by a cut is repaired on the next start, and its journal goes only after the barrier on the file and its folder", () => {
    const { log, plans } = fuigoLog();
    const realPwrite = mutOps.pwrite;
    let cut = false;
    mutOps.pwrite = ((fd: number, bytes: Buffer, position: number) => {
      if (!cut) { cut = true; writeSync(fd as number, bytes, 0, 1, position); throw Object.assign(new Error("EIO"), { code: "EIO" }); }
      return realPwrite(fd, bytes, position);
    }) as typeof mutOps.pwrite;
    try { executeEnginePlans(plans); } finally { mutOps.pwrite = realPwrite; }
    expect(cut).toBe(true);
    expect(journalFiles().length).toBe(1);
    const order: string[] = [];
    const undo = record(order, redoDirectory()!);
    let recovered: ReturnType<typeof recoverAll>;
    try { recovered = recoverAll(); } finally { undo(); }
    expect(recovered.repaired).toBe(1);
    expect(recovered.pending).toEqual([]);
    expect(journalFiles()).toEqual([]);
    const drop = order.indexOf("drop journal");
    expect(drop).toBeGreaterThan(0);
    // after the repair's own sync, the barrier on the file and its folder, and only then the journal goes
    expect(order.slice(order.lastIndexOf("plain fsync", drop), drop)).toEqual(["plain fsync", `barrier file ${log}`, `barrier dir ${dirname(log)}`]);
    expect(readFileSync(log, "utf8")).not.toContain(C("fuigo"));
    expect(readFileSync(log, "utf8")).toContain(B("fuigo"));
    expect(everyRowParses(log)).toBe(true);
  });

  it("a rewrite that completes uses the same barrier before its journal goes", () => {
    const { log, plans } = fuigoLog();
    const order: string[] = [];
    const undo = record(order, redoDirectory()!);
    try { expect(executeEnginePlans(plans).failedHomes).toEqual([]); } finally { undo(); }
    const drop = order.indexOf("drop journal");
    expect(order.slice(order.lastIndexOf("plain fsync", drop), drop)).toEqual(["plain fsync", `barrier file ${log}`, `barrier dir ${dirname(log)}`]);
  });
});

// ── Astra r22 P3 / Fable r22 P3 #8: a newer file stranded by an interrupted join ─────────────────────────────────────────

describe("an interrupted join whose older file has gone never strands the newer file under its private name", () => {
  it("the older file vanished and the engine made a third index at the name: recovery joins the newer one to it, and the journal goes only then", () => {
    const { fx, index, away, newer } = forkedKimi();
    // the join's write is cut after 12 bytes
    const realPwrite = mutOps.pwrite;
    let cut = false;
    mutOps.pwrite = ((fd: number, bytes: Buffer, position: number) => {
      if (!cut && bytes.includes("NEWER-ROW-ONE")) { cut = true; writeSync(fd as number, bytes, 0, 12, position); throw Object.assign(new Error("EIO"), { code: "EIO" }); }
      return realPwrite(fd, bytes, position);
    }) as typeof mutOps.pwrite;
    try { removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions); } finally { mutOps.pwrite = realPwrite; }
    expect(cut).toBe(true);
    expect(existsSync(`${index}.murage-rejoining`)).toBe(true);
    // the older file disappears; Kimi starts a third index at the name
    rmSync(away);
    const third = dump({ sessionId: "s8", workDir: "/eighth", title: "THIRD-ROW" });
    writeFileSync(index, third);
    const recovered = recoverAll();
    expect(recovered.pending).toEqual([]);
    expect(existsSync(`${index}.murage-rejoining`)).toBe(false);
    expect(journalFiles()).toEqual([]);
    const text = readFileSync(index, "utf8");
    for (const row of [third, ...newer]) expect(count(text, row), row).toBe(1);
    expect(everyRowParses(index)).toBe(true);
  });
});

// ── Fable r22 P3 #4: a step that never wrote leaves no journal ──────────────────────────────────────────────────────────

describe("a step that stops before its first write leaves no journal behind", () => {
  it("the row changed between the journal and the hold: nothing is written, the home is planned again, and no journal is left for recovery to act on", () => {
    const { fx, log, plans } = fuigoLog();
    // as Murage takes the lock (after the journal was written), the engine has rewritten the planned row in place
    let changed = false;
    fake.onLock = () => {
      if (changed || !journalFiles().length) return; // the gate's own look at the lock comes before the journal
      changed = true;
      writeFileSync(log, readFileSync(log, "utf8").replace('"sid":"s-1"', '"sid":"s-2"'));
    };
    const ran = executeEnginePlans(plans);
    expect(changed).toBe(true);
    expect(ran.staleHomes).toEqual([key(fx)]);
    expect(readFileSync(log, "utf8")).toContain(C("fuigo"));
    expect(journalFiles()).toEqual([]);
  });
});

// ── Astra r22 note: the kernel's positive answer survives a file that cannot be told (Linux, real addon) ─────────────────

const built = builtAddonPath();
const linux = process.platform === "linux";
const children: ChildProcess[] = [];
const sleepMs = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

describe.skipIf(!built || !linux)("real addon (Linux): one file open for writing is the answer for the set", () => {
  let restore = () => {};
  beforeEach(() => { fake.restore(); restore = useRealExclusion(built!); });
  afterEach(() => { for (const child of children.splice(0)) { try { process.kill(child.pid!, "SIGKILL"); } catch { /* gone */ } } restore(); fake = useFakeExclusion(); });

  it("a FIFO (no lease can be asked) listed before a file another process writes: openForWrite is still true", () => {
    const dir = mkdtempSync(join(scratch, "lease-"));
    const file = join(dir, "f.jsonl");
    const fifo = join(dir, "pipe");
    writeFileSync(file, "x\n");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const ready = join(dir, "ready");
    const writer = spawn("sh", ["-c", `exec 3>>"$F"; : > "$R"; sleep 30`], { env: { ...process.env, F: file, R: ready }, stdio: "ignore" });
    children.push(writer);
    const end = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < end) sleepMs(5);
    const addon = loadExclusionAddon()!;
    expect(addon.writers!([file]).openForWrite).toBe(true);
    expect(addon.writers!([fifo]).openForWrite).toBeNull();
    expect(addon.writers!([fifo, file]).openForWrite).toBe(true);
    expect(addon.writers!([file, fifo]).openForWrite).toBe(true);
  });
});
