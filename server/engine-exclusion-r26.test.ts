// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r26 (Astra r25c, r26c), as redesigned: check-then-act cannot close either case, so neither acts on a check any more.
//  1. A journal whose barrier was only the fallback is dropped only after the OPERATING SYSTEM has restarted since it was marked (its
//     boot id differs, or with no id its uptime is lower), and the bytes read again are found as written. A restart of Murage alone,
//     any later worker or run in the same boot, keeps it: a read in the same boot may return what the drive's cache still holds.
//  2. An interrupted join is never undone by a cut: both files stay exactly as they are and the journal stays, the home pending
//     ("aside"). No byte is ever taken off a file another program may hold, whatever any check said.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeEnginePlans, recoverAll } from "./engine-exec.ts";
import { loadExclusionAddon } from "./engine-exclusion.ts";
import { mutOps, realEngineFs } from "./engine-fs.ts";
import type { EngineHistoryJob } from "./engine-history-offthread.ts";
import { removeEngineHistoryFiles as removeRaw, runEngineHistoryJob } from "./engine-history-run.ts";
import { homeKey, Known, Planner, UNDO_JOIN_TRIES, type HomePlanData } from "./engine-plan-core.ts";
import { bootOps, listRedo, rebootedSince, redoDirectory, type BootMark } from "./engine-redo.ts";
import { useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { legacyRejoin, buildFixture, canaryHits, type Fixture } from "./testing/engine-history-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const removeEngineHistoryFiles = legacyRejoin(removeRaw);
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-r26-")));
afterAll(() => removeTempDirSync(scratch));

const realBoot = bootOps.current;
const realTells = bootOps.uptimeTellsRestart;
/** The operating system as the journals see it: its boot id and the seconds since it booted. */
let os: BootMark = { boot: "boot-a", uptime: 1_000 };
let fake: FakeExclusion;
beforeEach(() => { fake = useFakeExclusion(); clearJournals(); os = { boot: "boot-a", uptime: 1_000 }; bootOps.current = () => ({ ...os }); });
afterEach(() => { fake.restore(); bootOps.current = realBoot; bootOps.uptimeTellsRestart = realTells; });

/** Murage quits and starts again (or another worker or run starts) in the same boot: only time has passed. */
const murageRestarted = () => { os = { ...os, uptime: os.uptime + 600 }; };
/** The computer restarted: a new boot of the operating system. */
const computerRestarted = () => { os = { boot: `${os.boot}+`, uptime: 30 }; };

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
/** A recovery job as a deletion worker runs it. */
const recoverJob = () => runEngineHistoryJob({ kind: "recover", homes: [], folders: [], memoryFolders: [], sessions: {}, redoDir: redoDirectory()! } as EngineHistoryJob);

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

// ── 1. a fallback journal waits for a restart of the operating system, never of Murage ─────────────────────────────────────

describe.skipIf(process.platform === "win32")("a fallback journal is dropped only after the operating system restarted and the bytes are found as written", () => {
  it("rows: Murage restarted without the computer restarting keeps it, every time; a restart of the computer and a verified read drops it", () => {
    const { log, plans } = fuigoLog();
    withSync(fallback, () => { expect(executeEnginePlans(plans).failedHomes).toEqual([]); });
    expect(readFileSync(log, "utf8")).not.toContain(C("fuigo"));
    expect(journalFiles()).toHaveLength(1);
    expect(listRedo()[0]!.fellBack).toEqual({ boot: "boot-a", uptime: 1_000 }); // the boot it was written in
    for (let restart = 0; restart < 3; restart++) {
      murageRestarted();
      withSync(fallback, () => { expect(recoverJob().failed).toEqual([]); });
      expect(journalFiles(), `restart ${restart}`).toHaveLength(1); // b1f14b645: a greater app-start counter dropped it here
    }
    computerRestarted();
    fake.calls.length = 0;
    withSync(fallback, () => { expect(recoverJob().failed).toEqual([]); });
    expect(fake.calls.filter((call) => call === "pwrite")).toEqual([]); // found as written: nothing written again
    expect(journalFiles()).toEqual([]);
    expect(readFileSync(log, "utf8")).toContain(B("fuigo"));
  });

  it("rows: after the restart the bytes are found lost: repaired again, and the journal is marked with the new boot and kept for the next", () => {
    const { log, original, plans } = fuigoLog();
    withSync(fallback, () => { executeEnginePlans(plans); });
    writeFileSync(log, original); // the modeled power cut: the repaired bytes did not reach the drive
    computerRestarted();
    withSync(fallback, () => { recoverJob(); });
    expect(readFileSync(log, "utf8")).not.toContain(C("fuigo"));
    expect(journalFiles()).toHaveLength(1);
    expect(listRedo()[0]!.fellBack).toEqual({ boot: "boot-a+", uptime: 30 });
    murageRestarted();
    withSync(fallback, () => { recoverJob(); });
    expect(journalFiles()).toHaveLength(1);
    computerRestarted();
    withSync(fallback, () => { recoverJob(); });
    expect(journalFiles()).toEqual([]);
  });

  it("join: Murage restarted never removes the engine's newer file; after a restart of the computer, a read that finds its rows does", () => {
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
    murageRestarted();
    let again!: ReturnType<typeof removeEngineHistoryFiles>;
    withSync(fallback, () => { again = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, first.discovery ?? {}); });
    expect(again.failedHomes).toEqual([key(fx)]);
    expect(existsSync(`${index}.murage-rejoining`)).toBe(true);
    withSync(fallback, () => { recoverJob(); });
    expect(existsSync(`${index}.murage-rejoining`)).toBe(true);
    expect(listRedo().filter((item) => item.kind === "join")).toHaveLength(1);
    computerRestarted();
    let later!: ReturnType<typeof removeEngineHistoryFiles>;
    withSync(fallback, () => { later = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, first.discovery ?? {}); });
    expect(later.failedHomes).toEqual([]);
    expect(existsSync(`${index}.murage-rejoining`)).toBe(false);
    const text = readFileSync(index, "utf8");
    for (const row of newer) expect(text).toContain(row);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });
});

describe("the boot of the operating system", () => {
  it.skipIf(process.platform !== "linux")("Linux: the system's own boot id", () => {
    expect(realBoot().boot).toBe(readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
  });

  it.skipIf(process.platform !== "darwin")("macOS: the system's own boot session id, through the addon", () => {
    // the fake layer stands in for the addon in these tests: the real build is asked directly
    fake.restore();
    try {
      if (!loadExclusionAddon()?.bootId) return; // no addon built here: the uptime rule applies (tested below)
      expect(realBoot().boot).toMatch(/^[0-9A-F-]{36}$/i);
    } finally { fake = useFakeExclusion(); }
  });

  it("a different boot id is a restart, the same is not, whatever the uptime", () => {
    os = { boot: "x", uptime: 5 };
    expect(rebootedSince({ boot: "x", uptime: 9_999 })).toBe(false);
    expect(rebootedSince({ boot: "y", uptime: 1 })).toBe(true);
  });

  it("with no id on either side (Windows), only an uptime lower than the one marked is a restart", () => {
    bootOps.uptimeTellsRestart = () => true;
    os = { boot: null, uptime: 500 };
    expect(rebootedSince({ boot: null, uptime: 400 })).toBe(false);
    expect(rebootedSince({ boot: null, uptime: 600 })).toBe(true);
  });

  it("what cannot be compared is never a restart: an id on one side only, a journal of an earlier build, a boot that cannot be read", () => {
    os = { boot: "x", uptime: 5 };
    expect(rebootedSince({ boot: null, uptime: 600 })).toBe(false);
    os = { boot: null, uptime: 5 };
    expect(rebootedSince({ boot: "y", uptime: 600 })).toBe(false);
    expect(rebootedSince({ boot: null, uptime: -1 })).toBe(false); // an earlier build's start id or counter
    bootOps.current = () => { throw new Error("unreadable"); };
    expect(rebootedSince({ boot: "y", uptime: 600 })).toBe(false);
  });

  it("macOS or Linux with no boot id (an older v7 addon): a lower uptime, as a clock adjustment makes, is never a restart", () => {
    bootOps.uptimeTellsRestart = () => false;
    os = { boot: null, uptime: 100 };
    expect(rebootedSince({ boot: null, uptime: 5_000 })).toBe(false);
  });

  it("macOS addon without bootId: a fallback journal marked without an id survives a clock that steps back, recovery keeps it", () => {
    bootOps.uptimeTellsRestart = () => false;
    os = { boot: null, uptime: 5_000 };
    const dir = redoDirectory()!;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${"b".repeat(32)}.json`), JSON.stringify({ v: 2, kind: "rows", id: "b".repeat(32), path: "/x", dev: "1", ino: "2", engine: "fuigo", home: "/h", how: "lock", format: "fuigo-unified", rows: [], fellBack: { boot: null, uptime: 5_000 } }));
    os = { boot: null, uptime: 30 }; // the clock was set back: uptime is lower, nothing restarted
    recoverAll();
    expect(journalFiles()).toEqual([`${"b".repeat(32)}.json`]);
  });

  it("a journal of an earlier build (a start counter) is kept, never dropped on a restart", () => {
    const dir = redoDirectory()!;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${"a".repeat(32)}.json`), JSON.stringify({ v: 2, kind: "rows", id: "a".repeat(32), path: "/x", dev: "1", ino: "2", engine: "fuigo", home: "/h", how: "lock", format: "fuigo-unified", rows: [], fellBack: 41 }));
    computerRestarted();
    recoverAll();
    expect(journalFiles()).toEqual([`${"a".repeat(32)}.json`]);
  });
});

// ── 2. an interrupted join is never undone by a cut ──────────────────────────────────────────────────────────────────────────

/** A Kimi home as an earlier attempt left it, a join cut half way by a failed write, and the power cut that undid the rename of the
 * newer file (it is public again): recovery finds the interrupted join. */
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

/** Recovery, watching every size either file has on each read Murage makes of it: none may ever be lower than before. */
function recoverWatchingSizes(files: string[], during?: () => void): { ran: ReturnType<typeof recoverAll>; shrank: string[] } {
  const start = new Map(files.map((file) => [file, statSync(file).size]));
  const shrank: string[] = [];
  const real = mutOps.fstat;
  mutOps.fstat = ((fd: never) => {
    during?.();
    for (const file of files) if (statSync(file).size < start.get(file)!) shrank.push(file);
    return real(fd);
  }) as typeof mutOps.fstat;
  let ran!: ReturnType<typeof recoverAll>;
  try { ran = recoverAll(); } finally { mutOps.fstat = real; }
  for (const file of files) if (statSync(file).size < start.get(file)!) shrank.push(file);
  return { ran, shrank };
}

describe.skipIf(process.platform === "win32")("an interrupted join keeps every byte of both files", () => {
  it("Astra r26c: an editor that ignores the lock appends to the older file while Murage looks: nothing is cut, the bystander stays", () => {
    const { index, away, base } = cutJoinUndone();
    const bystander = Buffer.from(dump({ sessionId: "s-by", workDir: "/by", title: B("kimi") }));
    const editor = fake.openForWriting(away);
    let appended = false;
    let result!: ReturnType<typeof recoverWatchingSizes>;
    try {
      result = recoverWatchingSizes([away, index], () => { if (!appended) { appended = true; writeSync(editor.fd, bystander, 0, bystander.length, statSync(away).size); } });
    } finally { editor.close(); }
    expect(appended).toBe(true);
    expect(result.shrank).toEqual([]);
    expect(result.ran.pending).toHaveLength(1);
    expect(readFileSync(away, "utf8")).toContain(B("kimi"));
    expect(statSync(away).size).toBeGreaterThan(base);
    expect(listRedo().filter((item) => item.kind === "join")).toHaveLength(1);
  });

  it("an editor no check can see appends between two looks: nothing is cut", () => {
    const { index, away } = cutJoinUndone();
    const before = statSync(away).size;
    fake.onWriters = () => ({ writers: [], unreadable: [], openForWrite: false });
    const { ran, shrank } = recoverWatchingSizes([away, index], () => appendFileSync(away, dump({ sessionId: "s-ghost", workDir: "/g", title: B("kimi") })));
    expect(shrank).toEqual([]);
    expect(ran.pending).toHaveLength(1);
    expect(statSync(away).size).toBeGreaterThan(before);
  });

  it("no writer and nothing changed (the bytes are the join's own): still nothing is cut; both files stay exactly as they are, the journal stays", () => {
    const { index, away, base } = cutJoinUndone();
    const older = readFileSync(away), newer = readFileSync(index);
    fake.onWriters = () => ({ writers: [], unreadable: [], openForWrite: false });
    for (let attempt = 1; attempt <= UNDO_JOIN_TRIES + 2; attempt++) {
      const { ran, shrank } = recoverWatchingSizes([away, index]);
      expect(shrank, `attempt ${attempt}`).toEqual([]);
      expect(ran.pending, `attempt ${attempt}`).toHaveLength(1);
      expect(readFileSync(away).equals(older), `attempt ${attempt}`).toBe(true);
      expect(readFileSync(index).equals(newer), `attempt ${attempt}`).toBe(true);
    }
    expect(statSync(away).size).toBeGreaterThan(base);
    expect(listRedo().filter((item) => item.kind === "join")).toHaveLength(1);
  });

  it("the cut is gone: the engine file layer has no way to shorten a file", () => {
    expect("ftruncate" in mutOps).toBe(false);
  });

  it("a join that wrote nothing after the older file's end: the journal goes and both files are as they were", () => {
    const fx = buildFixture("kimi", scratch);
    const index = join(fx.homes[0]!.home, "session_index.jsonl");
    const away = `${index}.murage-deleting`;
    writeFileSync(away, readFileSync(index));
    writeFileSync(index, dump({ sessionId: "s3", workDir: "/third", title: "NEWER-ROW-ONE" }));
    const real = { pwrite: mutOps.pwrite };
    mutOps.pwrite = ((fd: number, bytes: Buffer, position: number) => {
      if (bytes.includes("NEWER-ROW-ONE")) throw Object.assign(new Error("EIO"), { code: "EIO" }); // fails before any byte lands
      return real.pwrite(fd, bytes, position);
    }) as typeof mutOps.pwrite;
    try { removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions); } finally { Object.assign(mutOps, real); }
    if (existsSync(`${index}.murage-rejoining`)) renameSync(`${index}.murage-rejoining`, index);
    const older = readFileSync(away), newer = readFileSync(index);
    recoverAll();
    expect(listRedo().filter((item) => item.kind === "join")).toEqual([]);
    expect(readFileSync(away).equals(older)).toBe(true);
    expect(readFileSync(index).equals(newer)).toBe(true);
  });
});
