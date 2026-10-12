// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r24: a file whose writers the system will not show (no leases, an unreadable process, a file others may write) gets a definite answer
// after a restart and an owner line that says so; an undo of a join that the engine's rewrite makes impossible to match ends after a
// bounded number of tries; a journal is dropped only after a sync that reported the full barrier or the documented fallback; and (Linux,
// the real addon) the engine lock's wait keeps its wall-clock deadline under a storm of signals.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { owedCodeOf, ownerNoticeText } from "./conversation-deletion.ts";
import { executeEnginePlans, recoverAll } from "./engine-exec.ts";
import { loadExclusionAddon } from "./engine-exclusion.ts";
import { exclOps, mutOps, realEngineFs } from "./engine-fs.ts";
import { removeEngineHistoryFiles } from "./engine-history-run.ts";
import { homeKey, Known, Planner, UNDO_JOIN_TRIES, type HomePlanData } from "./engine-plan-core.ts";
import { listRedo, redoDirectory } from "./engine-redo.ts";
import { builtAddonPath, useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { buildFixture, canaryHits, type Fixture } from "./testing/engine-history-fixtures.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-r24-")));
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
/** The computer restarted after every file here last changed (or not). */
const restarted = (yes: boolean) => { exclOps.bootTimeMs = () => (yes ? Date.now() + 60_000 : Date.now() - 3_600_000); };

// ── Fable r22 #3: "could not check" never stays without a way to finish ───────────────────────────────────────────────

describe("a program whose open files the system will not show: a line that says how it finishes, and a definite answer after a restart", () => {
  it("Linux without leases (NFS, FUSE home) and an undumpable ssh-agent of the owner's: the home waits as 'engine-unseen', and after a restart the rollout goes", () => {
    const fx = buildFixture("codex", scratch);
    const rollout = join(fx.homes[0]!.home, ...ROLLOUT);
    fake.onWriters = () => ({ writers: [], unreadable: [{ pid: 812, uid: 1000 }], openForWrite: null });
    restarted(false);
    const first = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(first.failedHomes).toEqual([key(fx)]);
    expect(first.homeReasons?.[key(fx)]).toBe("engine-unseen");
    expect(existsSync(rollout)).toBe(true);
    // the computer restarts: no process running now can hold a descriptor from before, and the rollout goes
    restarted(true);
    const again = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, first.discovery ?? {});
    expect(again.failedHomes).toEqual([]);
    expect(existsSync(rollout)).toBe(false);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });

  it("macOS (no kernel answer at all) and a process of the owner's whose fd table cannot be read: the same line and the same restart", () => {
    const fx = buildFixture("codex", scratch);
    const rollout = join(fx.homes[0]!.home, ...ROLLOUT);
    fake.onWriters = () => ({ writers: [], unreadable: [{ pid: 640, uid: null }] });
    restarted(false);
    const first = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(first.homeReasons?.[key(fx)]).toBe("engine-unseen");
    restarted(true);
    expect(removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, first.discovery ?? {}).failedHomes).toEqual([]);
    expect(existsSync(rollout)).toBe(false);
  });

  it("a group-writable engine file on macOS (other users' daemons cannot be read): the same line, and after a restart it goes", () => {
    const fx = buildFixture("codex", scratch);
    const rollout = join(fx.homes[0]!.home, ...ROLLOUT);
    chmodSync(rollout, 0o664);
    fake.onWriters = () => ({ writers: [], unreadable: [{ pid: 89, uid: 89 }] });
    restarted(false);
    const first = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(first.homeReasons?.[key(fx)]).toBe("engine-unseen");
    expect(existsSync(rollout)).toBe(true);
    restarted(true);
    expect(removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, first.discovery ?? {}).failedHomes).toEqual([]);
    expect(existsSync(rollout)).toBe(false);
  });

  it("a restart never overrides a writer that is seen, or the kernel's own 'open for writing'", () => {
    const fx = buildFixture("codex", scratch);
    const rollout = join(fx.homes[0]!.home, ...ROLLOUT);
    restarted(true);
    fake.onWriters = () => ({ writers: [], unreadable: [{ pid: 812, uid: 1000 }], openForWrite: true });
    expect(removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions).homeReasons?.[key(fx)]).toBe("held");
    fake.onWriters = () => ({ writers: [{ pid: 4242, index: 0 }], unreadable: [] });
    expect(removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions).homeReasons?.[key(fx)]).toBe("held");
    expect(existsSync(rollout)).toBe(true);
  });

  it("the owner is told what finishes it, in the approved style: no dash, nothing broken, the engine by name; and it is retried every 10 minutes", () => {
    expect(owedCodeOf("engine-unseen")).toBe("engine-unseen");
    const line = ownerNoticeText("Kimi", "engine-unseen");
    expect(line).toBe("Murage will finish removing this conversation from Kimi after your computer restarts. Until then a program of yours may still have Kimi's files open.");
    expect(line).not.toMatch(/—|–|\bunsafe\b|\bsafe\b|\bbroken\b|\bfail|\berror\b|could not/i);
    // the line for an engine that could not be checked stays exactly as it was (703fb7007)
    expect(ownerNoticeText("Kimi", "engine-unchecked")).toBe("Murage will check again within 10 minutes whether Kimi is open.");
  });
});

// ── Fable r22 #5: an undo of a join that the engine's rewrite makes impossible to match ends ────────────────────────────

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

describe("a join undone after a power cut, when the engine has since rewritten its newer file in place", () => {
  it(`is refused ${UNDO_JOIN_TRIES - 1} times (the journal counts them), then the join's own bytes come off the private older file and the journal goes; the next attempt joins whole and nothing is lost`, () => {
    const { fx, index, away, newer } = forkedKimi();
    const base = statSync(away).size;
    const real = { pwrite: mutOps.pwrite };
    let cut = false;
    mutOps.pwrite = ((fd: number, bytes: Buffer, position: number) => {
      if (!cut && bytes.includes("NEWER-ROW-ONE")) { cut = true; writeSync(fd, bytes, 0, 40, position); throw Object.assign(new Error("EIO"), { code: "EIO" }); }
      return real.pwrite(fd, bytes, position);
    }) as typeof mutOps.pwrite;
    try { removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions); } finally { Object.assign(mutOps, real); }
    expect(cut).toBe(true);
    // the cut undid the rename (a drive that lied about its cache), and Kimi then rewrote its index IN PLACE (same inode, new bytes)
    renameSync(`${index}.murage-rejoining`, index);
    const inode = statSync(index).ino;
    const rewritten = [dump({ sessionId: "s4", workDir: "/fourth", title: "REWRITTEN-ROW-FOUR" }), dump({ sessionId: "s5", workDir: "/fifth", title: "REWRITTEN-ROW-FIVE" })];
    writeFileSync(index, rewritten.join(""));
    expect(statSync(index).ino).toBe(inode);
    expect(statSync(away).size).toBeGreaterThan(base);
    for (let refused = 1; refused < UNDO_JOIN_TRIES; refused++) {
      const pending = recoverAll();
      expect(pending.pending.map((item) => item.state)).toEqual(["held"]);
      const joins = listRedo().filter((item) => item.kind === "join");
      expect(joins).toHaveLength(1);
      expect(joins[0]!.kind === "join" && joins[0]!.undo).toBe(refused);
      expect(statSync(away).size).toBeGreaterThan(base); // nothing taken off while it can still be matched
    }
    const last = recoverAll();
    expect(last.pending).toEqual([]);
    expect(journalFiles()).toEqual([]);
    expect(statSync(away).size).toBe(base); // the older file exactly as it was before the join
    expect(everyRowParses(away)).toBe(true);
    expect(readFileSync(index, "utf8")).toBe(rewritten.join("")); // the engine's own file untouched
    const again = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(again.failedHomes).toEqual([]);
    const text = readFileSync(index, "utf8");
    for (const row of rewritten) expect(count(text, row), row).toBe(1);
    for (const row of newer) expect(count(text, row), row).toBe(0); // what the engine itself rewrote away is not brought back
    expect(text).toContain(B("kimi"));
    expect(everyRowParses(index)).toBe(true);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(existsSync(away)).toBe(false);
    expect(journalFiles()).toEqual([]);
  });

  it("on the last try a process that has the older file open for writing still keeps it (and its journal)", () => {
    const { fx, index, away } = forkedKimi();
    const base = statSync(away).size;
    const real = { pwrite: mutOps.pwrite };
    let cut = false;
    mutOps.pwrite = ((fd: number, bytes: Buffer, position: number) => {
      if (!cut && bytes.includes("NEWER-ROW-ONE")) { cut = true; writeSync(fd, bytes, 0, 40, position); throw Object.assign(new Error("EIO"), { code: "EIO" }); }
      return real.pwrite(fd, bytes, position);
    }) as typeof mutOps.pwrite;
    try { removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions); } finally { Object.assign(mutOps, real); }
    renameSync(`${index}.murage-rejoining`, index);
    writeFileSync(index, dump({ sessionId: "s9", workDir: "/ninth", title: "REWRITTEN" }));
    for (let refused = 1; refused < UNDO_JOIN_TRIES; refused++) recoverAll();
    const writer = fake.openForWriting(away);
    try {
      expect(recoverAll().pending).toHaveLength(1);
      expect(statSync(away).size).toBeGreaterThan(base);
      expect(listRedo().filter((item) => item.kind === "join")).toHaveLength(1);
    } finally { writer.close(); }
    expect(recoverAll().pending).toEqual([]);
    expect(statSync(away).size).toBe(base);
  });
});

// ── Astra r22: the journal waits for a sync that says it was the full barrier, or the documented fallback ───────────────

/** A Fuigo log with one row to clear and one bystander, and its plan. */
function fuigoLog(): { log: string; plans: Record<string, HomePlanData> } {
  const fx = buildFixture("fuigo", scratch);
  const home = fx.homes[0]!.home;
  const log = join(home, "logs", "unified.jsonl");
  writeFileSync(log, dump({ sid: "s-1", text: `PRIVATE ${C("fuigo")}` }) + dump({ sid: "s-other", text: B("fuigo") }));
  const pl = new Planner(realEngineFs(), new Known());
  pl.rewrite(log, { pred: { any: [{ field: "sid", op: "in", values: ["s-1"] }] }, needles: ["s-1"], format: "fuigo-unified", how: "lock" });
  return { log, plans: { [homeKey("fuigo", home)]: { engine: "fuigo", home, steps: pl.steps } as HomePlanData } };
}

describe.skipIf(process.platform === "win32")("a journal is dropped only after the full barrier or the documented fallback", () => {
  const withSync = (answer: (fd: number) => unknown, work: () => void) => {
    const addon = loadExclusionAddon()! as unknown as { fullSync: (fd: number) => unknown };
    const before = addon.fullSync;
    addon.fullSync = answer;
    try { work(); } finally { addon.fullSync = before; }
  };

  it("a sync that does not say which barrier it gave keeps the journal (the rows are written; the next start drops it after a full one)", () => {
    const { log, plans } = fuigoLog();
    let ran!: ReturnType<typeof executeEnginePlans>;
    withSync(() => undefined, () => { ran = executeEnginePlans(plans); });
    expect(ran.failedHomes).toHaveLength(1);
    expect(readFileSync(log, "utf8")).not.toContain(C("fuigo"));
    expect(journalFiles()).toHaveLength(1);
    expect(recoverAll().pending).toEqual([]);
    expect(journalFiles()).toEqual([]);
  });

  it("the documented fallback (a macOS file system without F_FULLFSYNC: plain fsync) and the full barrier both let it go", () => {
    for (const said of ["fallback", "full"]) {
      clearJournals();
      const { log, plans } = fuigoLog();
      let ran!: ReturnType<typeof executeEnginePlans>;
      withSync(() => said, () => { ran = executeEnginePlans(plans); });
      expect(ran.failedHomes, said).toEqual([]);
      expect(readFileSync(log, "utf8")).toContain(B("fuigo"));
      expect(journalFiles(), said).toEqual([]);
    }
  });
});

// ── Astra r22: the engine lock's wait keeps its deadline under signals (Linux, the real addon) ────────────────────────────

const built = builtAddonPath();
const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } } });
const sleepMs = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

describe.skipIf(!built || process.platform !== "linux")("the real addon: lock() under a storm of signals", () => {
  it("gives up within its one second of wall clock, however many signals interrupt it, and says which barrier a sync gave", async () => {
    const addonPath = built!;
    const file = join(scratch, "locked.jsonl");
    writeFileSync(file, "x\n");
    const ready = join(scratch, "holder-ready");
    // a holder of the lock (a second process), and a waiter that counts the signals it is sent while it waits
    const holder = spawn(process.execPath, ["-e", `const a=require(${JSON.stringify(addonPath)});const fs=require("fs");const fd=fs.openSync(${JSON.stringify(file)},"r+");if(!a.lock(fd))process.exit(3);fs.writeFileSync(${JSON.stringify(ready)},"1");setTimeout(()=>{},60000);`], { stdio: "ignore" });
    children.push(holder);
    for (let i = 0; i < 400 && !existsSync(ready); i++) sleepMs(25);
    expect(existsSync(ready)).toBe(true);
    const waiter = spawn(process.execPath, ["-e", `const a=require(${JSON.stringify(addonPath)});const fs=require("fs");let n=0;process.on("SIGUSR2",()=>{n++;});const fd=fs.openSync(${JSON.stringify(file)},"r+");process.stdout.write("go\\n");setTimeout(()=>{const t=process.hrtime.bigint();const got=a.lock(fd);const ms=Number(process.hrtime.bigint()-t)/1e6;process.stdout.write(JSON.stringify({got,ms,sync:a.fullSync(fd)})+"\\n");process.exit(0);},200);`], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(waiter);
    let out = "";
    waiter.stdout!.on("data", (chunk) => { out += String(chunk); });
    await new Promise<void>((resolve) => { const tick = () => (out.includes("go") ? resolve() : setTimeout(tick, 5)); tick(); });
    const storm = spawn(process.execPath, ["-e", `const p=${waiter.pid};const end=Date.now()+3000;(function f(){for(let i=0;i<50;i++){try{process.kill(p,"SIGUSR2")}catch{process.exit(0)}}if(Date.now()<end)setImmediate(f);})();`], { stdio: "ignore" });
    children.push(storm);
    await new Promise<void>((resolve) => waiter.on("exit", () => resolve()));
    const result = JSON.parse(out.split("\n").find((line) => line.startsWith("{"))!) as { got: boolean; ms: number; sync: string };
    expect(result.got).toBe(false);
    expect(result.ms).toBeGreaterThanOrEqual(950);
    expect(result.ms).toBeLessThan(1_300);
    expect(result.sync).toBe("full");
  }, 30_000);
});
