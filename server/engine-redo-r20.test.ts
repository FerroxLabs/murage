// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// T7: a write cut at any byte, or a power cut that keeps only some 512-byte sectors of it, never leaves a row nobody can read. The crash
// journal (engine-redo.ts) is written before the first overwrite of a step; at the next start recoverAll finishes the job, also when the
// engine moved the row meanwhile (Fuigo's trim, a rename-over). The journal itself never holds a byte of what is being cleared.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeEnginePlans, recoverAll } from "./engine-exec.ts";
import { exclOps, mutOps } from "./engine-fs.ts";
import { planEngineHistory } from "./engine-history-run.ts";
import { redoDirectory } from "./engine-redo.ts";
import { sha16 } from "./engine-plan-core.ts";
import { useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { buildFixture, type Fixture } from "./testing/engine-history-fixtures.ts";
import type { DeletionEngine } from "./conversation-deletion.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-r20c-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let fake: FakeExclusion;
beforeEach(() => { fake = useFakeExclusion(); clearJournals(); });
afterEach(() => fake.restore());

const C = (engine: string) => `canary-${engine}-5521`;
const B = (engine: string) => `bystander-${engine}-9917`;
const job = (fx: Fixture) => ({ homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions, kind: "plan" as const });
function clearJournals(): void { const dir = redoDirectory(); if (dir && existsSync(dir)) for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true }); }
const journalFiles = (): string[] => { const dir = redoDirectory(); return dir && existsSync(dir) ? readdirSync(dir) : []; };

/** The file each engine's rewrite changes, and the canaries that must leave it. */
const TARGETS: Array<{ name: string; engine: DeletionEngine; files: (fx: Fixture) => string[]; canaries: string[]; extra?: (fx: Fixture) => void }> = [
  { name: "Claude history (directory lock)", engine: "claude", files: (fx) => [join(fx.homes[0]!.home, "history.jsonl")], canaries: [C("claude"), "ab12cd34ef56ab12"] },
  { name: "Codex history (whole-file lock) and session index (in place)", engine: "codex", files: (fx) => [join(fx.homes[0]!.home, "history.jsonl"), join(fx.homes[0]!.home, "session_index.jsonl")], canaries: [C("codex")] },
  { name: "Fuigo unified log (whole-file lock)", engine: "fuigo", files: (fx) => [join(fx.homes[0]!.home, "logs", "unified.jsonl")], canaries: [C("fuigo")] },
  { name: "Kimi session index (set aside)", engine: "kimi", files: (fx) => [join(fx.homes[0]!.home, "session_index.jsonl"), `${join(fx.homes[0]!.home, "session_index.jsonl")}.murage-deleting`], canaries: [C("kimi")] },
];

class Dead extends Error {}

/** Everything that changes a file refuses from now on: the process is gone. */
function die(saved: Record<string, unknown>): () => void {
  const refuse = () => { throw new Dead("the process is gone"); };
  Object.assign(mutOps, { pwrite: refuse, unlink: refuse, rmdir: refuse, link: refuse, mkdir: refuse, writeDurable: refuse, rename: refuse, touch: refuse });
  const rename = exclOps.renameNoReplace;
  exclOps.renameNoReplace = refuse as unknown as typeof exclOps.renameNoReplace;
  return () => { Object.assign(mutOps, saved); exclOps.renameNoReplace = rename; };
}

/** Lets the abandoned lock of a process that died age out, as it would by the time Murage starts again. */
function ageLocks(fx: Fixture): void {
  const home = fx.homes[0]!.home;
  for (const name of readdirSync(home)) if (name.endsWith(".lock") && existsSync(join(home, name))) { const old = new Date(Date.now() - 60_000); try { utimesSync(join(home, name), old, old); } catch { /* not a folder of ours */ } }
}

const rowsParse = (file: string): boolean => !existsSync(file) || readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").every((line) => { try { return JSON.parse(line) !== undefined; } catch { return false; } });

interface Crash { at: number; keep: number | "sectors"; mask?: boolean[] }

/** Runs the deletion of `fx` and dies at the `crash.at`-th overwrite after `keep` of its bytes (or only some of its sectors) reached the file. */
function runAndCrash(fx: Fixture, crash: Crash | { afterJournalBeforeWrite: true } | { beforeJournalDrop: true }): { spans: number[]; journals: string[]; revive: () => void } {
  const planned = planEngineHistory(job(fx));
  const spans: number[] = [];
  const journals: string[] = [];
  const realPwrite = mutOps.pwrite, realUnlink = mutOps.unlink, realDurable = mutOps.writeDurable;
  const base = { pwrite: mutOps.pwrite, unlink: mutOps.unlink, rmdir: mutOps.rmdir, link: mutOps.link, mkdir: mutOps.mkdir, writeDurable: mutOps.writeDurable, rename: mutOps.rename, touch: mutOps.touch };
  let revive = () => {};
  let dead = false;
  mutOps.writeDurable = ((path: string, bytes: Buffer) => { journals.push(bytes.toString("utf8")); realDurable(path, bytes); }) as typeof mutOps.writeDurable;
  mutOps.pwrite = ((fd: never, bytes: Buffer, position: number) => {
    const index = spans.length;
    spans.push(bytes.length);
    if ("at" in crash && crash.at === index) {
      if (crash.keep === "sectors") {
        // a power cut keeps whole 512-byte sectors, some of them: the others still hold the old bytes
        for (let sector = Math.floor(position / 512), n = 0; sector * 512 < position + bytes.length; sector++, n++) {
          if (!crash.mask![n % crash.mask!.length]) continue;
          const from = Math.max(position, sector * 512), to = Math.min(position + bytes.length, (sector + 1) * 512);
          realPwrite(fd, bytes.subarray(from - position, to - position), from);
        }
      } else if (crash.keep > 0) realPwrite(fd, bytes.subarray(0, crash.keep), position);
      dead = true;
      revive = die(base);
      throw new Dead("cut");
    }
    if ("afterJournalBeforeWrite" in crash && index === 0) { dead = true; revive = die(base); throw new Dead("cut after the journal"); }
    realPwrite(fd, bytes, position);
  }) as typeof mutOps.pwrite;
  if ("beforeJournalDrop" in crash) {
    mutOps.unlink = ((path: string) => { if (!dead && redoDirectory() && path.startsWith(redoDirectory()!)) { dead = true; revive = die(base); throw new Dead("cut before the journal is dropped"); } realUnlink(path); }) as typeof mutOps.unlink;
  }
  try { executeEnginePlans(structuredClone(planned.plans!)); } finally { mutOps.pwrite = realPwrite; mutOps.unlink = realUnlink; mutOps.writeDurable = realDurable; }
  return { spans, journals, revive };
}

function expectWhole(fx: Fixture, target: (typeof TARGETS)[number], label: string, journals: string[], before: string[]): void {
  fake.processes = [];
  const done = recoverAll();
  expect(done.pending, label).toEqual([]);
  target.files(fx).forEach((file, at) => {
    expect(rowsParse(file), `${label}: every row of ${file} parses`).toBe(true);
    // a file the crash never reached (its step had not begun) is as it was; one that was being written is whole and cleared
    if (existsSync(file) && readFileSync(file, "utf8") !== before[at]) for (const canary of target.canaries) expect(readFileSync(file, "utf8").includes(canary), `${label}: ${canary} in ${file}`).toBe(false);
  });
  // nothing of the conversation in the journal folder after, or in any journal at any time
  expect(journalFiles(), label).toEqual([]);
  for (const text of journals) for (const canary of target.canaries) {
    expect(text.includes(canary), `${label}: the journal holds ${canary}`).toBe(false);
    expect(text.includes(createHash("sha256").update(canary).digest("hex")), `${label}: the journal holds the hash of ${canary}`).toBe(false);
    expect(text.includes(sha16(Buffer.from(canary))), `${label}: the journal holds a short hash of ${canary}`).toBe(false);
  }
}

describe("T7: a write cut at every byte of every span, and a power cut keeping only some sectors", () => {
  for (const target of TARGETS) {
    it(`${target.name}: every span, every k from 0 to its length`, () => {
      const dry = buildFixture(target.engine, scratch);
      const measured = runAndCrash(dry, { at: -1, keep: 0 });
      const spans = measured.spans;
      measured.revive();
      expect(spans.length).toBeGreaterThan(0);
      let runs = 0;
      for (const [index, length] of spans.entries()) {
        const ks = length <= 64 ? Array.from({ length: length + 1 }, (_, k) => k) : [0, 1, 2, Math.floor(length / 2), length - 1, length];
        for (const k of ks) {
          clearJournals();
          const fx = buildFixture(target.engine, scratch);
          const before = target.files(fx).map((file) => (existsSync(file) ? readFileSync(file, "utf8") : ""));
          const crashed = runAndCrash(fx, { at: index, keep: k });
          crashed.revive();
          ageLocks(fx);
          expectWhole(fx, target, `${target.engine} span ${index} keep ${k}`, crashed.journals, before);
          // bystanders' rows are byte for byte what they were
          target.files(fx).forEach((file, at) => {
            if (!existsSync(file)) return;
            const after = readFileSync(file, "utf8").split("\n");
            for (const line of before[at]!.split("\n")) if (line.includes(B(target.engine))) expect(after, `${target.engine} span ${index} keep ${k}`).toContain(line);
          });
          runs++;
        }
      }
      expect(runs).toBeGreaterThan(spans.length);
    }, 180_000);

    it(`${target.name}: 100 random sector subsets`, () => {
      const dry = buildFixture(target.engine, scratch);
      const measured = runAndCrash(dry, { at: -1, keep: 0 });
      const spans = measured.spans;
      measured.revive();
      let seed = 20260712;
      const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
      for (let trial = 0; trial < 100; trial++) {
        clearJournals();
        const fx = buildFixture(target.engine, scratch);
        const before = target.files(fx).map((file) => (existsSync(file) ? readFileSync(file, "utf8") : ""));
        const index = Math.floor(random() * spans.length);
        const mask = Array.from({ length: 4 }, () => random() < 0.5);
        const crashed = runAndCrash(fx, { at: index, keep: "sectors", mask });
        crashed.revive();
        ageLocks(fx);
        expectWhole(fx, target, `${target.engine} trial ${trial} span ${index}`, crashed.journals, before);
      }
    }, 180_000);

    it(`${target.name}: cut after the journal is synced and before the first overwrite, and after the last sync and before the journal is removed`, () => {
      for (const crash of [{ afterJournalBeforeWrite: true }, { beforeJournalDrop: true }] as const) {
        clearJournals();
        const fx = buildFixture(target.engine, scratch);
        const before = target.files(fx).map((file) => (existsSync(file) ? readFileSync(file, "utf8") : ""));
        const crashed = runAndCrash(fx, crash);
        expect(journalFiles().length, JSON.stringify(crash)).toBeGreaterThan(0);
        crashed.revive();
        ageLocks(fx);
        expectWhole(fx, target, `${target.engine} ${JSON.stringify(crash)}`, crashed.journals, before);
      }
    });
  }
});

describe("T7: the engine moved the row between the crash and the recovery", () => {
  it("Fuigo trims its log (the oldest rows go, by a rewrite) and Codex replaces its history by rename: the torn row is found by its skeleton and completed", () => {
    for (const [engine, relative] of [["fuigo", ["logs", "unified.jsonl"]], ["codex", ["history.jsonl"]]] as const) {
      clearJournals();
      const fx = buildFixture(engine, scratch);
      const file = join(fx.homes[0]!.home, ...relative);
      // an old row ahead of the conversation's, which the engine's trim will take away
      const old = engine === "fuigo" ? `${JSON.stringify({ sid: "s-old", text: "old row that the trim drops" })}\n` : `${JSON.stringify({ session_id: "sess-old", ts: 1, text: "old row that the trim drops" })}\n`;
      writeFileSync(file, old + readFileSync(file, "utf8"));
      const crashed = runAndCrash(fx, { at: 0, keep: 7 });
      crashed.revive();
      const torn = readFileSync(file, "utf8");
      expect(torn.includes("5521")).toBe(true); // cut in the middle of a value: the row is not finished
      // the engine's own rewrite: a temporary file renamed over the name, without its oldest row
      writeFileSync(`${file}.tmp`, torn.slice(old.length));
      renameSync(`${file}.tmp`, file);
      fake.processes = [];
      expect(recoverAll().pending).toEqual([]);
      const done = readFileSync(file, "utf8");
      expect(rowsParse(file)).toBe(true);
      expect(done).not.toContain(C(engine));
      expect(done).toContain(B(engine));
      expect(done).not.toContain("old row that the trim drops");
      expect(journalFiles()).toEqual([]);
    }
  });

  it("the engine dropped the row altogether: the journal is dropped and nothing is written", () => {
    clearJournals();
    const fx = buildFixture("fuigo", scratch);
    const file = join(fx.homes[0]!.home, "logs", "unified.jsonl");
    const crashed = runAndCrash(fx, { at: 0, keep: 3 });
    crashed.revive();
    const rows = readFileSync(file, "utf8").split("\n");
    writeFileSync(file, rows.filter((line) => !line.includes("s-1")).join("\n"));
    const before = readFileSync(file);
    fake.processes = [];
    expect(recoverAll().pending).toEqual([]);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(journalFiles()).toEqual([]);
  });

  it("a journal whose engine is open stays, and its home is not planned until it is finished", () => {
    clearJournals();
    const fx = buildFixture("fuigo", scratch);
    const crashed = runAndCrash(fx, { at: 0, keep: 3 });
    crashed.revive();
    fake.processes = [];
    const release = fake.openEngine("fuigo");
    const waiting = recoverAll();
    expect(waiting.pending.map((item) => item.state)).toEqual(["open"]);
    expect(journalFiles().length).toBe(1);
    const planned = planEngineHistory(job(fx));
    expect(planned.failedHomes).toEqual([`${fx.homes[0]!.engine}\0${fx.homes[0]!.home}`]);
    expect(planned.homeReasons![`${fx.homes[0]!.engine}\0${fx.homes[0]!.home}`]).toBe("engine-open");
    release();
    const replanned = planEngineHistory(job(fx));
    expect(replanned.failedHomes).toEqual([]);
    expect(journalFiles()).toEqual([]);
    expect(readFileSync(join(fx.homes[0]!.home, "logs", "unified.jsonl"), "utf8")).not.toContain(C("fuigo"));
  });
});
