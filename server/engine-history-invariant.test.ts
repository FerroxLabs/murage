// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The invariant behind engine-history deletion, checked the same way for all 12 engines:
//
//   * planning only reads, and a read that cannot be done (EIO, EACCES, EMFILE, a cut file, a corrupt zstd frame or SQLite
//     file) gives the home NO plan: nothing in it is touched and the deletion stays pending. The reads to break are the ones
//     a recording run lists (every call the planner makes), never a hand-written list of call sites.
//   * with every read failing, no engine produces a single step (a planner that bypassed the strict reader would).
//   * a crash after any step, or between saving the plan and running it, is finished by the replay: every canary gone from
//     every byte (raw, decompressed zstd, .db and -wal), every bystander intact.
//   * "done" means a fresh, complete plan has no content step left.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { executeEnginePlans } from "./engine-exec.ts";
import { applyFactsDelta, planEngineHistory, removeEngineHistoryFiles } from "./engine-history-run.ts";
import { hasContentSteps, homeKey } from "./engine-plan-core.ts";
import { ALL_KINDS, ERRNO_KINDS, instrument } from "./testing/engine-history-faults.ts";
import { buildFixture, canaryHits, ENGINES, holdDatabasesOpen, idHits, treeDigest, type Fixture } from "./testing/engine-history-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-invariant-")));
const stats: Record<string, { reads: number; steps: number; faultsRun: number; faultsApplied: number; crashes: number }> = {};
afterAll(() => {
  console.log("INVARIANT-STATS", JSON.stringify(stats));
  removeTempDirSync(scratch);
});

const job = (fx: Fixture, extra: Record<string, unknown> = {}) => ({ homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions, kind: "plan" as const, ...extra });
const runAll = (fx: Fixture) => removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, {}, true);
const key = (fx: Fixture) => homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);

describe.each(ENGINES)("engine history deletion invariant: %s", (engine) => {
  const record = () => (stats[engine] ??= { reads: 0, steps: 0, faultsRun: 0, faultsApplied: 0, crashes: 0 });

  it("planning reads and changes nothing, finds content, and lists every read it made", () => {
    const fx = buildFixture(engine, scratch);
    const before = treeDigest(fx.root);
    const watch = instrument();
    const planned = (() => { try { return planEngineHistory(job(fx)); } finally { watch.restore(); } })();
    expect(planned.failedHomes).toEqual([]);
    expect(treeDigest(fx.root)).toBe(before);
    const plan = planned.plans![key(fx)]!;
    expect(hasContentSteps(plan), "the fixture has content to remove").toBe(true);
    expect(watch.log.length).toBeGreaterThan(0);
    record().reads = watch.log.length;
    record().steps = plan.steps.length;
  });

  it("a read that fails gives the home no plan, whatever read and however it fails", () => {
    const fx = buildFixture(engine, scratch);
    const before = treeDigest(fx.root);
    const needles = [...fx.canaries, ...fx.folders, ...Object.values(fx.sessions).flat() as string[]];
    const clean = planEngineHistory(job(fx));
    const reads = (() => { const w = instrument(); try { planEngineHistory(job(fx)); } finally { w.restore(); } return w.log.length; })();
    for (let at = 0; at < reads; at++) {
      for (const kind of ALL_KINDS) {
        const watch = instrument({ at, kind, needles });
        let result: ReturnType<typeof planEngineHistory>;
        try { result = planEngineHistory(job(fx)); } finally { watch.restore(); }
        record().faultsRun++;
        if (!watch.applied()) continue; // this kind does not fit this read (a zstd fault on an lstat...)
        record().faultsApplied++;
        const incomplete = result.failedHomes!.length === 1 && Object.keys(result.plans!).length === 0 && result.failed.length > 0;
        if (ERRNO_KINDS.includes(kind)) expect(incomplete, `${kind} at read ${at}: ${watch.log[at]}`).toBe(true);
        // A cut file can only be noticed when the cut falls inside a line that names the conversation: then the home is
        // incomplete. Anywhere else the read is whole as far as the plan goes, and the plan must be the clean one.
        else expect(incomplete || JSON.stringify(result.plans) === JSON.stringify(clean.plans), `${kind} at read ${at}: ${watch.log[at]} gave a different plan`).toBe(true);
        expect(treeDigest(fx.root)).toBe(before);
      }
    }
  }, 300_000);

  it("a read that fails during a whole deletion removes nothing and keeps it owed; the clean retry removes everything", () => {
    const reads = (() => { const probe = buildFixture(engine, scratch); const w = instrument(); try { planEngineHistory(job(probe)); } finally { w.restore(); } return w.log.length; })();
    for (let at = 0; at < reads; at++) {
      const fx = buildFixture(engine, scratch);
      const before = treeDigest(fx.root);
      const watch = instrument({ at, kind: "EIO" });
      let failedRun: ReturnType<typeof runAll>;
      try { failedRun = runAll(fx); } finally { watch.restore(); }
      expect(failedRun.failed.length, `EIO at read ${at}: ${watch.log[at]}`).toBeGreaterThan(0);
      expect(failedRun.removed).toEqual([]);
      expect(treeDigest(fx.root)).toBe(before);
      const retry = runAll(fx);
      expect(retry.failed).toEqual([]);
      expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
      expect(fx.checkBystanders()).toEqual([]);
    }
  }, 600_000);

  it("with every read failing there is no step at all", () => {
    const fx = buildFixture(engine, scratch);
    const before = treeDigest(fx.root);
    const watch = instrument({ all: "EIO" });
    let planned: ReturnType<typeof planEngineHistory>, whole: ReturnType<typeof runAll>;
    try { planned = planEngineHistory(job(fx)); whole = runAll(fx); } finally { watch.restore(); }
    expect(planned.plans).toEqual({});
    expect(planned.failedHomes).toEqual([key(fx)]);
    expect(whole.failed.length).toBeGreaterThan(0);
    expect(whole.removed).toEqual([]);
    expect(treeDigest(fx.root)).toBe(before);
  });

  it("a whole deletion removes every canary from every byte, keeps the bystanders, and is verified by a fresh empty plan", () => {
    const fx = buildFixture(engine, scratch);
    expect(canaryHits(fx.root, fx.canaries).length, "the fixture really holds the canaries").toBeGreaterThan(0);
    const result = runAll(fx);
    expect(result.failed).toEqual([]);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(idHits(fx)).toEqual([]);
    expect(fx.checkBystanders()).toEqual([]);
    // "done" is evidence: planning again finds nothing left to remove
    const after = planEngineHistory(job(fx, { known: result.discovery }));
    expect(after.failedHomes).toEqual([]);
    expect(Object.values(after.plans!).some(hasContentSteps)).toBe(false);
    // and a second run changes nothing
    const digest = treeDigest(fx.root);
    expect(runAll(fx).failed).toEqual([]);
    expect(treeDigest(fx.root)).toBe(digest);
  });

  it("the engine holding its databases open (their -wal stays) still ends with no canary in any byte, -wal included", () => {
    const fx = buildFixture(engine, scratch);
    const releaseAll = holdDatabasesOpen(fx.root);
    let released = false;
    const release = () => { if (!released) { released = true; releaseAll(); } };
    try {
      if (process.platform === "win32") {
        // Windows cannot move or remove a file another handle has open: the engine's open database is left exactly as it was and
        // the home stays pending (EngineOpenError "held", engine-exec.ts moveAside), so nothing is torn and no bystander is touched.
        // The deletion finishes on the retry once the engine lets go.
        runAll(fx);
        expect(fx.checkBystanders()).toEqual([]);
        release();
        const retry = runAll(fx);
        expect(retry.failed).toEqual([]);
        expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
        expect(fx.checkBystanders()).toEqual([]);
        return;
      }
      const result = runAll(fx);
      expect(result.failed).toEqual([]);
      expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
      expect(fx.checkBystanders()).toEqual([]);
    } finally { release(); }
  });

  it("running a finished plan again changes nothing and fails nothing (every step is idempotent)", () => {
    const fx = buildFixture(engine, scratch);
    const planned = planEngineHistory(job(fx));
    const plans = structuredClone(planned.plans!);
    expect(executeEnginePlans(plans).failed).toEqual([]);
    const digest = treeDigest(fx.root);
    const again = executeEnginePlans(structuredClone(planned.plans!));
    expect(again.failed).toEqual([]);
    expect(treeDigest(fx.root)).toBe(digest);
  });

  it("a crash before any step, or after any step, is finished by the replay, with the marks kept or lost", () => {
    const steps = (() => { const probe = buildFixture(engine, scratch); return planEngineHistory(job(probe)).plans![key(probe)]!.steps.length; })();
    for (const keepMarks of [true, false]) {
      for (let crashAt = 0; crashAt < steps; crashAt++) {
        const fx = buildFixture(engine, scratch);
        const planned = planEngineHistory(job(fx));
        const plans = structuredClone(planned.plans!);
        const marks: Array<[string, number]> = [];
        expect(() => executeEnginePlans(plans, (k, i) => marks.push([k, i]), { beforeStep: (_k, i) => { if (i === crashAt) throw new Error("the worker died"); } })).toThrow("the worker died");
        record().crashes++;
        // the replay works from what was saved: the plan, and the marks that reached the record
        const saved = structuredClone(planned.plans!);
        if (keepMarks) for (const [k, i] of marks) saved[k]!.steps[i]!.done = true;
        const ran = executeEnginePlans(saved);
        expect(ran.failed, `crash at ${crashAt}, marks ${keepMarks ? "kept" : "lost"}`).toEqual([]);
        // verify rounds, as the service runs them: a fact the dead run never reported (a database still owed its checkpoint)
        // shows up as a step in the fresh plan, and the next round does it
        const discovery = structuredClone(planned.discovery!);
        applyFactsDelta(discovery, ran.factsDelta);
        let verify = planEngineHistory(job(fx, { known: discovery }));
        for (let round = 0; round < 3 && Object.values(verify.plans!).some(hasContentSteps); round++) {
          const more = executeEnginePlans(structuredClone(verify.plans!));
          expect(more.failed).toEqual([]);
          applyFactsDelta(discovery, more.factsDelta);
          verify = planEngineHistory(job(fx, { known: discovery }));
        }
        expect(Object.values(verify.plans!).some(hasContentSteps), `crash at ${crashAt}, marks ${keepMarks ? "kept" : "lost"}: content left`).toBe(false);
        expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
        expect(fx.checkBystanders()).toEqual([]);
      }
    }
  }, 600_000);
});

describe("the bystander home", () => {
  it("one engine's deletion never touches another engine's home", () => {
    const a = buildFixture("codex", scratch), b = buildFixture("claude", scratch);
    const beforeB = treeDigest(b.root);
    const result = removeEngineHistoryFiles(a.homes, a.folders, a.memoryFolders, a.sessions, {}, true);
    expect(result.failed).toEqual([]);
    expect(treeDigest(b.root)).toBe(beforeB);
    expect(canaryHits(a.root, a.canaries)).toEqual([]);
  });
});

