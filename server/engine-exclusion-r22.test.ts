// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r22: a file Murage has taken out of reach by name is removed only once no process can still write to it, whatever that process is
// called (Kimi's newer index after a join, a Codex rollout); a power cut can never turn a half-made join into a lost or torn row; the
// journal of a rewrite is written before the engine's lock is taken and removed only once the rows are on the drive; on Windows the long
// read that decides a removal is made before any file is held, and no file is held longer than the bound; a Claude lock that cannot be
// checked is told as "could not check"; the desktop app is named when it is what is open; the leftovers of a killed Murage are swept;
// and a planning read never creates or removes an engine database's -wal and -shm.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, watch, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { ownerNoticeText } from "./conversation-deletion.ts";
import { processVerdict } from "./engine-closed.ts";
import type { NativeProcess } from "./engine-exclusion.ts";
import { executeEnginePlans, recoverAll } from "./engine-exec.ts";
import { exclOps, fsOps, mutOps, realEngineFs } from "./engine-fs.ts";
import { loadExclusionAddon } from "./engine-exclusion.ts";
import { planEngineHistory, removeEngineHistoryFiles as removeRaw, runEngineHistoryJob } from "./engine-history-run.ts";
import { homeKey, Known, Planner, type HomePlanData } from "./engine-plan-core.ts";
import { redoDirectory } from "./engine-redo.ts";
import { builtAddonPath, useFakeExclusion, useRealExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { legacyRejoin, buildFixture, canaryHits, type Fixture } from "./testing/engine-history-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const removeEngineHistoryFiles = legacyRejoin(removeRaw);
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-r22-")));
afterAll(() => removeTempDirSync(scratch));

let fake: FakeExclusion;
beforeEach(() => { fake = useFakeExclusion(); clearJournals(); });
afterEach(() => { fake.restore(); });

const dump = (value: unknown) => `${JSON.stringify(value)}\n`;
const job = (fx: Fixture) => ({ homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions, kind: "plan" as const });
const key = (fx: Fixture) => homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);
const C = (engine: string) => `canary-${engine}-5521`;
const B = (engine: string) => `bystander-${engine}-9917`;
function clearJournals(): void { const dir = redoDirectory(); if (dir && existsSync(dir)) for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true }); }
const journalFiles = (): string[] => { const dir = redoDirectory(); return dir && existsSync(dir) ? readdirSync(dir) : []; };
const rows = (file: string): string[] => readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
const everyRowParses = (file: string): boolean => rows(file).every((line) => { try { JSON.parse(line); return true; } catch { return false; } });
const count = (text: string, row: string) => text.split(row).length - 1;
const sameInode = (path: string, fd: number): boolean => { try { return lstatSync(path).ino === fstatSync(fd).ino; } catch { return false; } };

/** A Kimi home as an earlier attempt left it: the old index set aside, and the new one Kimi started at the name meanwhile. */
function forkedKimi(): { fx: Fixture; index: string; newer: string[] } {
  const fx = buildFixture("kimi", scratch);
  const index = join(fx.homes[0]!.home, "session_index.jsonl");
  writeFileSync(`${index}.murage-deleting`, readFileSync(index));
  const newer = [dump({ sessionId: "s3", workDir: "/third", title: "NEWER-ROW-ONE" }), dump({ sessionId: "s4", workDir: "/fourth", title: "NEWER-ROW-TWO" })];
  writeFileSync(index, newer.join(""));
  return { fx, index, newer };
}

/** A plan of one file's rows, made by the planner itself. */
function planRows(engine: string, home: string, file: string, format: string, how: "lock" | "exclusive", field: string, values: string[]): Record<string, HomePlanData> {
  const pl = new Planner(realEngineFs(), new Known());
  pl.rewrite(file, { pred: { any: [{ field, op: "in", values }] }, needles: values, format, how });
  return { [homeKey(engine, home)]: { engine, home, steps: pl.steps } as HomePlanData };
}

/** A monotonic clock the test moves (mutOps.now). */
function fakeClock(): { advance: (ms: number) => void; restore: () => void } {
  const real = mutOps.now;
  let t = 10_000;
  mutOps.now = () => t;
  return { advance: (ms) => { t += ms; }, restore: () => { mutOps.now = real; } };
}

// ── Astra r21 P1: REJOIN never unlinks a file a writer still has open ───────────────────────────────────────────────────

describe("REJOIN removes the engine's newer file only when no process can still write to it, whatever that process is called", () => {
  it("a writer the process check cannot name (R7) that opened the newer index before it was moved and appends at the last moment loses nothing", () => {
    const { fx, index, newer } = forkedKimi();
    const late = dump({ sessionId: "s5", workDir: "/fifth", title: "LOST-BYSTANDER" });
    // an unconfigured, renamed Kimi: it has the newer index open, and the process list shows nothing the check knows
    let engineFd: number | null = openSync(index, "a");
    let wrote = false;
    const write = () => { if (!wrote && engineFd !== null) { wrote = true; writeSync(engineFd, late); } };
    // the writer is asked about (or, without that question, the file is about to be unlinked): it appends now
    fake.onWriters = (paths) => {
      if (paths.some((path) => path.endsWith(".murage-rejoining"))) write();
      const writers = engineFd === null ? [] : paths.flatMap((path, index_) => (sameInode(path, engineFd!) ? [{ pid: 4242, index: index_ }] : []));
      return { writers, unreadable: [] };
    };
    const realIdOf = mutOps.idOf;
    let looks = 0;
    mutOps.idOf = ((path: string) => { if (path.endsWith(".murage-rejoining") && ++looks === 2) write(); return realIdOf(path); }) as typeof mutOps.idOf;
    let first: ReturnType<typeof removeEngineHistoryFiles>;
    try { first = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions); } finally { mutOps.idOf = realIdOf; }
    expect(wrote).toBe(true);
    expect(first.failedHomes).toEqual([key(fx)]);
    expect(first.homeReasons?.[key(fx)]).toBe("aside");
    // the newer file is still there under its private name, with the row in it
    expect(count(readFileSync(`${index}.murage-rejoining`, "utf8"), late)).toBe(1);
    closeSync(engineFd!); engineFd = null; // the writer ends
    const again = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(again.failedHomes).toEqual([]);
    const text = readFileSync(index, "utf8");
    for (const row of [...newer, late]) expect(count(text, row), row).toBe(1);
    expect(text).not.toContain(C("kimi"));
    expect(everyRowParses(index)).toBe(true);
    expect(existsSync(`${index}.murage-rejoining`)).toBe(false);
    expect(journalFiles()).toEqual([]);
  });
});

// ── Astra r21 P1: a power cut that undoes the rename of a join's source ───────────────────────────────────────────────────

describe("a power cut in the middle of a join never leaves a torn row or a dropped journal", () => {
  it("the rename that makes the newer file private is on disk before the join's journal; and if a cut undoes it anyway, both files are kept exactly as they are and the home stays pending", () => {
    const { fx, index, newer } = forkedKimi();
    const order: string[] = [];
    const real = { fsyncDir: mutOps.fsyncDir, writeDurable: mutOps.writeDurable, pwrite: mutOps.pwrite };
    mutOps.fsyncDir = ((path: string) => { order.push(`syncdir ${path}`); return real.fsyncDir(path); }) as typeof mutOps.fsyncDir;
    mutOps.writeDurable = ((path: string, bytes: Buffer) => { order.push(bytes.includes('"kind":"join"') ? "journal join" : "journal rows"); real.writeDurable(path, bytes); }) as typeof mutOps.writeDurable;
    // the join's write puts 12 bytes on the disk, then the power goes
    let cut = false;
    mutOps.pwrite = ((fd: number, bytes: Buffer, position: number) => {
      if (!cut && bytes.includes("NEWER-ROW-ONE")) { cut = true; writeSync(fd, bytes, 0, 12, position); throw Object.assign(new Error("EIO"), { code: "EIO" }); }
      return real.pwrite(fd, bytes, position);
    }) as typeof mutOps.pwrite;
    try { removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions); } finally { Object.assign(mutOps, real); }
    expect(cut).toBe(true);
    const journal = order.indexOf("journal join");
    expect(journal).toBeGreaterThan(0);
    expect(order.slice(0, journal)).toContain(`syncdir ${dirname(index)}`); // the private name is durable before the journal says "joining"
    // the cut undid the rename anyway (a drive that lied about its cache): the newer file is back under its plain name
    expect(existsSync(`${index}.murage-rejoining`)).toBe(true);
    renameSync(`${index}.murage-rejoining`, index);
    // nothing is ever cut: both files stay exactly as they are (the join's 12 bytes included), the journal stays, the home is pending
    const older = readFileSync(`${index}.murage-deleting`), newerFile = readFileSync(index);
    const recovered = recoverAll();
    expect(recovered.pending).toHaveLength(1);
    expect(journalFiles()).toHaveLength(1);
    expect(readFileSync(`${index}.murage-deleting`).equals(older)).toBe(true);
    expect(readFileSync(index).equals(newerFile)).toBe(true);
    const again = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(again.failedHomes).toEqual([key(fx)]);
    expect(readFileSync(`${index}.murage-deleting`).equals(older)).toBe(true);
    expect(readFileSync(index).equals(newerFile)).toBe(true);
    for (const row of newer) expect(count(readFileSync(index, "utf8"), row), row).toBe(1); // the engine's newer rows are where it reads them
    expect(everyRowParses(index)).toBe(true);
    expect(journalFiles()).toHaveLength(1);
  });
});

// ── a rewrite's journal: written before the hold, removed only after the rows are durable ─────────────────────────────────

describe("the journal of a rewrite is written before the engine's lock is taken and removed only after the rows are on the drive", () => {
  it("syncs that take 300 ms each (the journal's file and folder) never make the hold run out: the rows are cleared on the first try", () => {
    const fx = buildFixture("fuigo", scratch);
    const home = fx.homes[0]!.home;
    const log = join(home, "logs", "unified.jsonl");
    writeFileSync(log, dump({ sid: "s-1", text: `PRIVATE ${C("fuigo")}` }) + dump({ sid: "s-other", text: B("fuigo") }));
    const plans = planRows("fuigo", home, log, "fuigo-unified", "lock", "sid", ["s-1"]);
    const clock = fakeClock();
    const real = { fsyncDir: mutOps.fsyncDir, writeDurable: mutOps.writeDurable };
    mutOps.fsyncDir = ((path: string) => { clock.advance(300); return real.fsyncDir(path); }) as typeof mutOps.fsyncDir;
    mutOps.writeDurable = ((path: string, bytes: Buffer) => { clock.advance(300); real.writeDurable(path, bytes); }) as typeof mutOps.writeDurable;
    let ran: ReturnType<typeof executeEnginePlans>;
    try { ran = executeEnginePlans(plans); } finally { Object.assign(mutOps, real); clock.restore(); }
    expect(ran.staleHomes).toEqual([]);
    expect(ran.failedHomes).toEqual([]);
    expect(readFileSync(log, "utf8")).not.toContain(C("fuigo"));
    expect(readFileSync(log, "utf8")).toContain(B("fuigo"));
    expect(journalFiles()).toEqual([]);
  });

  it("the journal goes only after the file's folder is synced, after the last write", () => {
    const fx = buildFixture("fuigo", scratch);
    const home = fx.homes[0]!.home;
    const log = join(home, "logs", "unified.jsonl");
    writeFileSync(log, dump({ sid: "s-1", text: `PRIVATE ${C("fuigo")}` }) + dump({ sid: "s-other", text: B("fuigo") }));
    const plans = planRows("fuigo", home, log, "fuigo-unified", "lock", "sid", ["s-1"]);
    const order: string[] = [];
    const real = { fsyncDir: mutOps.fsyncDir, unlink: mutOps.unlink, pwrite: mutOps.pwrite };
    const redo = redoDirectory()!;
    mutOps.fsyncDir = ((path: string) => { order.push(`syncdir ${path}`); return real.fsyncDir(path); }) as typeof mutOps.fsyncDir;
    mutOps.unlink = ((path: string) => { if (path.startsWith(redo)) order.push("drop journal"); real.unlink(path); }) as typeof mutOps.unlink;
    mutOps.pwrite = ((fd: number, bytes: Buffer, position: number) => { order.push("write"); return real.pwrite(fd, bytes, position); }) as typeof mutOps.pwrite;
    try { expect(executeEnginePlans(plans).failedHomes).toEqual([]); } finally { Object.assign(mutOps, real); }
    const drop = order.indexOf("drop journal");
    const lastWrite = order.lastIndexOf("write");
    expect(drop).toBeGreaterThan(lastWrite);
    expect(order.slice(lastWrite, drop)).toContain(`syncdir ${dirname(log)}`);
  });
});

// ── Fable r21 P1 / Astra r21 P2: Windows reads before it holds, and no handle outlives the bound ──────────────────────────

describe("Windows: what decides a removal is read before any file is held, and no file is held longer than 500 ms", () => {
  function windowsClaude(): { fx: Fixture; project: string; plans: Record<string, HomePlanData> } {
    fake.restore();
    fake = useFakeExclusion("win32");
    const fx = buildFixture("claude", scratch);
    const project = join(fx.homes[0]!.home, "projects", fx.folders[0]!.replace(/[^a-zA-Z0-9]/g, "-"));
    writeFileSync(join(project, "sess-claude-2.jsonl"), dump({ type: "user", cwd: fx.folders[0], sessionId: "sess-claude-2", message: C("claude") }));
    return { fx, project, plans: planEngineHistory(job(fx)).plans! };
  }

  it("a transcript whose full read takes 1.2 s is removed (the read is made before the share-none handle is taken)", () => {
    const { fx, project, plans } = windowsClaude();
    const clock = fakeClock();
    const realRead = fsOps.readAt;
    fsOps.readAt = ((fd: never, buffer: Buffer, position: number) => { const got = realRead(fd, buffer, position); if (got > 0) clock.advance(1200); return got; }) as typeof fsOps.readAt;
    let ran: ReturnType<typeof executeEnginePlans>;
    try { ran = executeEnginePlans(structuredClone(plans)); } finally { fsOps.readAt = realRead; clock.restore(); }
    expect(ran.staleHomes).toEqual([]);
    expect(ran.failedHomes).toEqual([]);
    expect(existsSync(project)).toBe(false);
    expect(canaryHits(join(fx.homes[0]!.home, "projects"), [C("claude")])).toEqual([]);
  });

  it("a second file whose open takes 1.2 s: every file is marked within 500 ms of its own handle, and one handle is held at a time", () => {
    const { project, plans } = windowsClaude();
    const clock = fakeClock();
    const realOpen = exclOps.openFile;
    let opens = 0, live = 0, most = 0;
    const ages: number[] = [];
    exclOps.openFile = ((path: string, kind: "exclusive" | "delete" | "shared" | "probe") => {
      const file = realOpen(path, kind);
      if (!file || kind !== "delete") return file;
      if (++opens === 2) clock.advance(1200); // this open took 1.2 s
      const at = mutOps.now();
      live++; most = Math.max(most, live);
      const { markDelete, close } = file;
      file.markDelete = () => { ages.push(mutOps.now() - at); return markDelete(); };
      file.close = () => { live--; close(); };
      return file;
    }) as typeof exclOps.openFile;
    let ran: ReturnType<typeof executeEnginePlans>;
    try { ran = executeEnginePlans(structuredClone(plans)); } finally { exclOps.openFile = realOpen; clock.restore(); }
    expect(opens).toBeGreaterThanOrEqual(2);
    expect(ran.failedHomes).toEqual([]);
    expect(ages.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...ages)).toBeLessThanOrEqual(500);
    expect(most).toBe(1);
    expect(existsSync(project)).toBe(false);
  });
});

// ── Astra r21 P2: an abandoned Claude lock and a process list that cannot be read ───────────────────────────────────────

describe("an abandoned Claude Code lock is replaced only while Claude is seen closed; a check that fails is told as one", () => {
  it("the process list fails while the abandoned lock is being taken over: nothing is written, the lock stays, and the reason is 'could not check'", () => {
    const fx = buildFixture("claude", scratch);
    const home = fx.homes[0]!.home;
    const history = join(home, "history.jsonl");
    const lock = `${history}.lock`;
    mkdirSync(lock);
    const old = Date.now() / 1000 - 60;
    utimesSync(lock, old, old);
    const plans = planEngineHistory(job(fx)).plans!;
    const before = readFileSync(history);
    const realMkdir = mutOps.mkdir;
    mutOps.mkdir = ((path: string) => { if (path.includes(".lock.murage-")) fake.processesFail = true; realMkdir(path); }) as typeof mutOps.mkdir;
    let ran: ReturnType<typeof executeEnginePlans>;
    try { ran = executeEnginePlans(structuredClone(plans)); } finally { mutOps.mkdir = realMkdir; fake.processesFail = false; }
    expect(ran.homeReasons[key(fx)]).toBe("engine-unchecked");
    expect(readFileSync(history).equals(before)).toBe(true);
    expect(existsSync(lock)).toBe(true);
  });
});

// ── Fable r21 P2: the desktop app is named when it is what is open ──────────────────────────────────────────────────────

describe("the owner is told what is open, by its own name", () => {
  it("the Claude app open: '<Engine> or the Claude app is open. Close them ...' (DESIGN-r20 section 7); the engine itself: its own name", () => {
    expect(ownerNoticeText("Claude Code", "engine-open", "Claude")).toBe("Claude Code or the Claude app is open. Murage finishes removing this conversation from Claude Code by itself once they are closed. Nothing is needed from you.");
    expect(ownerNoticeText("Cursor Agent", "engine-open", "Cursor")).toBe("Cursor Agent or the Cursor app is open. Murage finishes removing this conversation from Cursor Agent by itself once they are closed. Nothing is needed from you.");
    expect(ownerNoticeText("Claude Code", "engine-open")).toBe("Claude Code is open. Murage finishes removing this conversation from it by itself once Claude Code is closed. Nothing is needed from you.");
    for (const app of ["Claude", undefined]) expect(ownerNoticeText("Claude Code", "engine-open", app)).not.toMatch(/—|–|\bsafe\b|\bunsafe\b/);
  });
});

// ── Fable r21 P2 / P3: the matchers name only the engine ────────────────────────────────────────────────────────────────

describe("the process check counts only the Claude app's own program on Windows, and only Hermes' real gateway as its daemon", () => {
  const P = (exe: string, argv: string[] = [exe]): NativeProcess => ({ pid: 777, ppid: 1, mine: true, uid: 1000, start: 1, exe, argv, comm: exe.split(/[\\/]/).pop()!.slice(0, 15) });
  const base = "C:\\Users\\u\\AppData\\Local\\AnthropicClaude";

  it("Windows: Chrome's native host and the updater in the app's folder are not the app; the app's claude.exe is", () => {
    expect(processVerdict("claude", [P(`${base}\\app-1.2.3\\resources\\chrome-native-host.exe`, [`${base}\\app-1.2.3\\resources\\chrome-native-host.exe`, "chrome-extension://x/"])], 1).state).toBe("closed");
    expect(processVerdict("claude", [P(`${base}\\Update.exe`, [`${base}\\Update.exe`, "--processStart"])], 1).state).toBe("closed");
    expect(processVerdict("claude", [P(`${base}\\app-1.2.3\\claude.exe`)], 1)).toEqual({ state: "open", app: "Claude" });
  });

  it("Hermes: `gateway` as a word of its own that is not `gateway run` is Hermes in use", () => {
    const python = "/home/u/.hermes/hermes-agent/venv/bin/python";
    expect(processVerdict("hermes", [P(python, [python, "-m", "hermes_cli.main", "-q", "gateway"])], 1).state).toBe("open");
    expect(processVerdict("hermes", [P(python, [python, "-m", "hermes_cli.main", "--profile", "gateway", "chat"])], 1).state).toBe("open");
    expect(processVerdict("hermes", [P(python, [python, "-m", "hermes_cli.main", "gateway", "run"])], 1).state).toBe("closed");
  });
});

// ── real-engine P3: a killed Murage's private lock folders are swept at start-up ───────────────────────────────────────

describe("at start-up the empty private lock folders a killed Murage left next to Claude Code's history are removed", () => {
  it("old and empty: removed; fresh, not empty, or Claude's own public lock: left", () => {
    const fx = buildFixture("claude", scratch);
    const home = fx.homes[0]!.home;
    const history = join(home, "history.jsonl");
    const old = Date.now() / 1000 - 60;
    const stale = `${history}.lock.murage-123-abc1`, fresh = `${history}.lock.murage-124-abc2`, full = `${history}.lock.murage-125-abc3`, pub = `${history}.lock`;
    for (const dir of [stale, fresh, full, pub]) mkdirSync(dir);
    writeFileSync(join(full, "x"), "x");
    for (const dir of [stale, full, pub]) utimesSync(dir, old, old);
    runEngineHistoryJob({ kind: "recover", homes: fx.homes, folders: [], memoryFolders: [], sessions: {} });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(full)).toBe(true);
    expect(existsSync(pub)).toBe(true);
  });
});

// ── real-engine P3: the plan reads an engine's database read only ────────────────────────────────────────────────────

describe("planning never touches the -wal and -shm of an engine's database", () => {
  const watched = async (fx: Fixture, plan: () => void): Promise<string[]> => {
    const sessions = join(fx.homes[0]!.home, "sessions");
    const index = join(sessions, "session_search.sqlite");
    expect(existsSync(index)).toBe(true);
    for (const suffix of ["-wal", "-shm"]) rmSync(`${index}${suffix}`, { force: true });
    const seen: string[] = [];
    let heard = 0;
    const watcher = watch(sessions, (_event, name) => { heard++; if (name && /session_search\.sqlite-(wal|shm)$/.test(String(name))) seen.push(String(name)); });
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      // macOS reports a folder's changes through FSEvents, late and including what happened just before the watch began (the
      // fixture's own database writes, the removal above): wait until the folder is quiet, then count only from the plan on
      for (let rounds = 0, before = -1; rounds < 20 && heard !== before; rounds++) { before = heard; await pause(300); }
      seen.length = 0;
      plan();
      await pause(1000);
    } finally { watcher.close(); }
    return seen;
  };

  it("Fuigo open: its session_search.sqlite is not opened at all (no -wal or -shm made or removed), and the home waits", async () => {
    const fx = buildFixture("fuigo", scratch);
    const close = fake.openEngine("fuigo");
    let planned!: ReturnType<typeof planEngineHistory>;
    const seen = await watched(fx, () => { planned = planEngineHistory(job(fx)); });
    close();
    expect(seen).toEqual([]);
    expect(planned.failedHomes).toEqual([key(fx)]);
    expect(planned.homeReasons?.[key(fx)]).toBe("engine-open");
  });
});

// ── real-engine F1: a Murage killed after a rollout is removed finishes from the saved ids ─────────────────────────────

describe("a Murage killed right after a Codex rollout is removed finishes the history from the ids it saved before it ran", () => {
  it("the replay clears history.jsonl and session_index.jsonl although the rollout that named the thread is gone", () => {
    const fx = buildFixture("codex", scratch);
    const planned = planEngineHistory(job(fx));
    const saved = structuredClone(planned.discovery ?? {}); // saved with the plan, before the first step runs
    let removedRollout = false;
    expect(() => executeEnginePlans(structuredClone(planned.plans!), undefined, {
      beforeStep: (_key, _index, step) => {
        if (removedRollout && step.k !== "remove") throw new Error("killed");
        if (step.k === "remove" && step.target.includes("rollout-")) removedRollout = true;
      },
    })).toThrow("killed");
    expect(removedRollout).toBe(true);
    const home = fx.homes[0]!.home;
    expect(readdirSync(join(home, "sessions", "2026", "10", "11")).some((name) => name.includes("000000000001"))).toBe(false);
    const replay = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, saved);
    expect(replay.failedHomes).toEqual([]);
    expect(readFileSync(join(home, "history.jsonl"), "utf8")).not.toContain(C("codex"));
    expect(readFileSync(join(home, "session_index.jsonl"), "utf8")).not.toContain(C("codex"));
    expect(readFileSync(join(home, "history.jsonl"), "utf8")).toContain(B("codex"));
  });
});

// ── with the REAL addon and real second processes ─────────────────────────────────────────────────────────────────────

const built = builtAddonPath();
const posix = process.platform !== "win32";
const children: ChildProcess[] = [];
const sleepMs = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const waitFor = (check: () => boolean, ms = 10_000): boolean => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; sleepMs(5); } return check(); };
const stop = (child: ChildProcess): void => { try { process.kill(child.pid!, "SIGKILL"); } catch { /* gone */ } waitFor(() => { try { process.kill(child.pid!, 0); return false; } catch { return true; } }, 3000); };

/** A writer the process check cannot name (`zzz-agent`, run by node, not configured): it opens `file` for appending now, writes
 * `row` when `go` appears, and keeps the file open until it is killed. */
function renamedWriter(file: string, row: string, go: string, ready: string): ChildProcess {
  const dir = mkdtempSync(join(scratch, "agent-"));
  const script = join(dir, "zzz-agent");
  writeFileSync(script, `const fs=require("fs");const fd=fs.openSync(${JSON.stringify(file)},"a");fs.writeFileSync(${JSON.stringify(ready)},"1");
const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})){clearInterval(t);fs.writeSync(fd,${JSON.stringify(row)});fs.writeFileSync(${JSON.stringify(go)}+".done","1");}},5);setTimeout(()=>{},120000);`);
  const child = spawn(process.execPath, [script], { stdio: "ignore" });
  children.push(child);
  return child;
}

describe.skipIf(!built || !posix)("real addon: writers() and a file a renamed writer still has open", () => {
  let restore = () => {};
  beforeEach(() => { fake.restore(); restore = useRealExclusion(built!); clearJournals(); });
  afterEach(() => { for (const child of children.splice(0)) stop(child); restore(); fake = useFakeExclusion(); });

  it("writers() names a process with the file open for writing, by its identity, and not a reader, a zombie or this process", () => {
    const addon = loadExclusionAddon()!;
    expect(addon.version()).toBe(9);
    const file = join(mkdtempSync(join(scratch, "w-")), "f.jsonl");
    writeFileSync(file, "x\n");
    const own = openSync(file, "a");
    const writer = spawn("sh", ["-c", `exec 3>>"$F"; sleep 30`], { env: { ...process.env, F: file }, stdio: "ignore" });
    const reader = spawn("sh", ["-c", `exec 3<"$F"; sleep 30`], { env: { ...process.env, F: file }, stdio: "ignore" });
    // a zombie: the subshell exits and its parent (now `sleep`) never waits for it
    const zombieParent = spawn("sh", ["-c", "(exit 0) & exec sleep 30"], { stdio: "ignore" });
    children.push(writer, reader, zombieParent);
    expect(waitFor(() => { const seen = addon.writers!([file]).writers.map((item) => item.pid); return seen.includes(writer.pid!); })).toBe(true);
    const seen = addon.writers!([join(scratch, "not-there"), file]);
    expect(seen.writers.some((item) => item.pid === writer.pid && item.index === 1)).toBe(true);
    expect(seen.writers.some((item) => item.pid === reader.pid)).toBe(false);
    expect(seen.writers.some((item) => item.pid === process.pid)).toBe(false);
    // the zombie is listed by processes() (as ps lists it) and is never a process whose files cannot be read
    const ps = spawnSync("ps", ["-axo", "pid=,ppid=,stat="], { encoding: "utf8" }).stdout;
    const zombie = ps.split("\n").map((line) => line.trim().split(/\s+/)).find((cols) => Number(cols[1]) === zombieParent.pid && /^Z/.test(cols[2] ?? ""));
    if (zombie) {
      expect(addon.processes().some((item) => item.pid === Number(zombie[0]))).toBe(true);
      expect(seen.unreadable.some((item) => item.pid === Number(zombie[0]))).toBe(false);
    }
    closeSync(own);
  });

  it("Kimi: a renamed writer holds the newer index open; the join leaves it under its private name, the writer's later row is kept, and the next attempt joins it", () => {
    const { fx, index, newer } = forkedKimi();
    const late = dump({ sessionId: "s7", workDir: "/seventh", title: "WRITTEN-AFTER-THE-JOIN" });
    const ready = join(fx.root, "ready"), go = join(fx.root, "go");
    const agent = renamedWriter(index, late, go, ready);
    expect(waitFor(() => existsSync(ready))).toBe(true);
    const first = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(first.failedHomes).toEqual([key(fx)]);
    expect(first.homeReasons?.[key(fx)]).toBe("aside");
    writeFileSync(go, "1"); // the writer writes now, through the descriptor it opened before the join
    expect(waitFor(() => existsSync(`${go}.done`))).toBe(true);
    stop(agent);
    const again = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(again.failedHomes).toEqual([]);
    const text = readFileSync(index, "utf8");
    for (const row of [...newer, late]) expect(count(text, row), row).toBe(1);
    expect(everyRowParses(index)).toBe(true);
    expect(text).not.toContain(C("kimi"));
    expect(existsSync(`${index}.murage-rejoining`)).toBe(false);
  });

  // PR_SET_DUMPABLE 0 (Linux): this user's process whose open files cannot be listed, as (sd-pam), ssh-agent or a keyring is on a desktop
  const undumpable = process.platform === "linux" && spawnSync("python3", ["-V"]).status === 0;
  const opaque = (file: string | null, ready: string): ChildProcess => {
    const open = file === null ? "" : `f=open(${JSON.stringify(file)},'a');`;
    const child = spawn("python3", ["-c", `import ctypes,time;${open}ctypes.CDLL(None).prctl(4,0,0,0,0);open(${JSON.stringify(ready)},'w').close();time.sleep(60)`], { stdio: "ignore" });
    children.push(child);
    return child;
  };

  it.skipIf(!undumpable)("Linux: a process of this user whose open files cannot be listed is no obstacle when the kernel says no one writes; one that has the file open for writing keeps it", () => {
    const fx = buildFixture("codex", scratch);
    const home = fx.homes[0]!.home;
    const rollout = join(home, "sessions", "2026", "10", "11", "rollout-2026-10-11T10-00-00-019a0000-aaaa-7bbb-8ccc-000000000001.jsonl");
    // an undumpable writer of the rollout: writers() cannot name it, the kernel still sees it
    const held = join(fx.root, "held-ready");
    const writer = opaque(rollout, held);
    expect(waitFor(() => existsSync(held))).toBe(true);
    expect(existsSync(`/proc/${writer.pid}/fd`) && (() => { try { readdirSync(`/proc/${writer.pid}/fd`); return false; } catch { return true; } })()).toBe(true);
    const addon = loadExclusionAddon()!;
    const seen = addon.writers!([rollout]);
    expect(seen.writers.some((item) => item.pid === writer.pid)).toBe(false);
    expect(seen.unreadable.some((item) => item.pid === writer.pid)).toBe(true);
    expect(seen.openForWrite).toBe(true);
    const first = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(first.failedHomes).toEqual([key(fx)]);
    expect(first.homeReasons?.[key(fx)]).toBe("held");
    expect(existsSync(rollout)).toBe(true);
    stop(writer);
    // an undumpable process of this user that has nothing of the engine's open stays running: the rollout goes
    const idle = join(fx.root, "idle-ready");
    const bystander = opaque(null, idle);
    expect(waitFor(() => existsSync(idle))).toBe(true);
    const after = addon.writers!([rollout]);
    expect(after.unreadable.some((item) => item.pid === bystander.pid)).toBe(true);
    expect(after.openForWrite).toBe(false);
    const again = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, first.discovery ?? {});
    expect(again.failedHomes).toEqual([]);
    expect(existsSync(rollout)).toBe(false);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });

  it("Codex: a renamed writer holds the conversation's rollout open; it is not removed while it is held, and is once the writer ends", () => {
    const fx = buildFixture("codex", scratch);
    const home = fx.homes[0]!.home;
    const rollout = join(home, "sessions", "2026", "10", "11", "rollout-2026-10-11T10-00-00-019a0000-aaaa-7bbb-8ccc-000000000001.jsonl");
    const row = dump({ type: "event", text: "WRITTEN-WHILE-HELD" });
    const ready = join(fx.root, "ready"), go = join(fx.root, "go");
    const agent = renamedWriter(rollout, row, go, ready);
    expect(waitFor(() => existsSync(ready))).toBe(true);
    const first = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(first.failedHomes).toEqual([key(fx)]);
    expect(first.homeReasons?.[key(fx)]).toBe("held");
    expect(existsSync(rollout)).toBe(true); // put back under its name
    writeFileSync(go, "1");
    expect(waitFor(() => existsSync(`${go}.done`))).toBe(true);
    expect(readFileSync(rollout, "utf8")).toContain("WRITTEN-WHILE-HELD"); // it wrote to a file that still has a name
    stop(agent);
    const again = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, first.discovery ?? {});
    expect(again.failedHomes).toEqual([]);
    expect(existsSync(rollout)).toBe(false);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });
});
