// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Astra r30c: an index an earlier build left aside (.murage-deleting) is recovered IN PLACE. The public index is never renamed, replaced
// or given a private name (no .murage-rejoining): the aside's surviving rows are appended to it under the engine lock with the
// engine closed (journalled, so a crash at any step loses and duplicates nothing), then the aside is deleted. With no public index the
// aside takes the name back.
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { recoverAll } from "./engine-exec.ts";
import { exclOps, mutOps } from "./engine-fs.ts";
import { planEngineHistory, removeEngineHistoryFiles } from "./engine-history-run.ts";
import { redoDirectory } from "./engine-redo.ts";
import { useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { buildFixture, canaryHits, type Fixture } from "./testing/engine-history-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-r30c-")));
afterAll(() => removeTempDirSync(scratch));
let fake: FakeExclusion;
function clearJournals(): void { const dir = redoDirectory(); if (dir && existsSync(dir)) for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true }); }
const journalFiles = (): string[] => { const dir = redoDirectory(); return dir && existsSync(dir) ? readdirSync(dir) : []; };
beforeEach(() => { fake = useFakeExclusion(); clearJournals(); });
afterEach(() => fake.restore());

const dump = (value: unknown) => `${JSON.stringify(value)}\n`;
const B = "bystander-kimi-9917";
const NEWER = "NEWER-ROW-ONE";
const job = (fx: Fixture) => ({ homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions, kind: "plan" as const });
const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** A Kimi home whose legacy aside holds the old index (canary row + bystander) and whose public index is a newer file. */
function legacy(opts: { publicIndex: boolean } = { publicIndex: true }): { fx: Fixture; index: string; away: string } {
  const fx = buildFixture("kimi", scratch);
  const index = join(fx.homes[0]!.home, "session_index.jsonl");
  const away = `${index}.murage-deleting`;
  writeFileSync(away, readFileSync(index));
  if (opts.publicIndex) writeFileSync(index, dump({ sessionId: "s3", workDir: "/third", title: NEWER }) + dump({ sessionId: "s2", workDir: "/other", title: B }));
  else rmSync(index);
  return { fx, index, away };
}
const privateNames = (home: string): string[] => readdirSync(home).filter((name) => /\.murage-(deleting|rejoining)$/.test(name));

describe("a legacy aside is merged into the public index in place", () => {
  it("plans no exclusive recovery and never makes .murage-rejoining or renames the public index", () => {
    const { fx, index, away } = legacy();
    const planned = planEngineHistory(job(fx));
    const steps = planned.plans![Object.keys(planned.plans!)[0]!]!.steps.filter((step) => step.k === "rewrite");
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) expect("how" in step ? step.how : "").toBe("inplace");
    const out = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(out.failedHomes).toEqual([]);
    expect(fake.calls.filter((call) => call.startsWith("renameNoReplace") && (call.includes(index) || call.includes("rejoining")))).toEqual([]);
    expect(privateNames(fx.homes[0]!.home)).toEqual([]);
    expect(existsSync(away)).toBe(false);
    const text = readFileSync(index, "utf8");
    expect(count(text, B)).toBe(1); // the aside's and the public index's copy of the same row: once
    expect(count(text, NEWER)).toBe(1);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });

  it("a bystander row only the aside holds ends up in the public index exactly once", () => {
    const { fx, index } = legacy();
    const only = dump({ sessionId: "s9", workDir: "/ninth", title: "ONLY-IN-ASIDE" });
    writeFileSync(`${index}.murage-deleting`, readFileSync(`${index}.murage-deleting`, "utf8") + only);
    const out = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(out.failedHomes).toEqual([]);
    expect(count(readFileSync(index, "utf8"), "ONLY-IN-ASIDE")).toBe(1);
  });

  it("a missing public index is restored from the aside", () => {
    const { fx, index, away } = legacy({ publicIndex: false });
    const out = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(out.failedHomes).toEqual([]);
    expect(existsSync(away)).toBe(false);
    expect(existsSync(index)).toBe(true);
    const text = readFileSync(index, "utf8");
    expect(count(text, B)).toBe(1);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(privateNames(fx.homes[0]!.home)).toEqual([]);
  });
});

class Dead extends Error {}
const MUTATORS = ["pwrite", "unlink", "rmdir", "link", "mkdir", "writeDurable", "rename", "touch"] as const;

/** Runs the deletion and dies at the `at`-th change to the disk (everything after it refuses too). Returns how many changes there were. */
function runAndDie(fx: Fixture, at: number): { total: number; revive: () => void } {
  const saved = Object.fromEntries(MUTATORS.map((name) => [name, mutOps[name]])) as Record<string, unknown>;
  const savedRename = exclOps.renameNoReplace;
  let total = 0;
  let dead = false;
  const wrap = (real: (...args: never[]) => unknown) => (...args: never[]) => {
    if (dead) throw new Dead("gone");
    if (total++ === at) { dead = true; throw new Dead("cut"); }
    return real(...args);
  };
  for (const name of MUTATORS) (mutOps as unknown as Record<string, unknown>)[name] = wrap(saved[name] as never);
  exclOps.renameNoReplace = wrap(savedRename as never) as unknown as typeof exclOps.renameNoReplace;
  try { removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions); } catch { /* the process is gone */ }
  return { total, revive: () => { Object.assign(mutOps, saved); exclOps.renameNoReplace = savedRename; } };
}

describe("a crash at every step of the in-place merge loses and duplicates nothing", () => {
  for (const withPublic of [true, false]) {
    it(withPublic ? "public index present" : "public index missing", () => {
      const dry = legacy({ publicIndex: withPublic });
      const measured = runAndDie(dry.fx, -1);
      measured.revive();
      expect(measured.total).toBeGreaterThan(0);
      for (let at = 0; at < measured.total; at++) {
        clearJournals();
        const { fx, index, away } = legacy({ publicIndex: withPublic });
        const crashed = runAndDie(fx, at);
        crashed.revive();
        fake.processes = [];
        recoverAll();
        const out = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
        const label = `crash at change ${at}`;
        expect(out.failedHomes, label).toEqual([]);
        expect(existsSync(away), label).toBe(false);
        expect(privateNames(fx.homes[0]!.home), label).toEqual([]);
        const text = readFileSync(index, "utf8");
        expect(count(text, B), label).toBe(1);
        if (withPublic) expect(count(text, NEWER), label).toBe(1);
        expect(canaryHits(fx.root, fx.canaries), label).toEqual([]);
        for (const line of text.split("\n").filter((item) => item.trim() !== "")) expect(() => JSON.parse(line), `${label}: ${line}`).not.toThrow();
        expect(journalFiles(), label).toEqual([]);
      }
    }, 120_000);
  }
});
