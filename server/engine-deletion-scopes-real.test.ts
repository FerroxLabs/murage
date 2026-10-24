// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F16 phase 2 with the REAL engine-exclusion addon and real processes (Linux; skipped where the addon is not built). A process named
// `codex` (a copy of tail, so it runs for as long as the test needs and names a file in its arguments) stands for a live Codex:
//   R1  a live foreign codex whose arguments name the scope keeps it pending, nothing touched
//   R2  a foreign codex in the owner's ~/.codex does not hold a scope deletion back
//   R3  a crash mid-plan: the next start's plan does not repeat a destructive step that finished, and finishes the rest
//   R4  the other conversation of the same bot, in the same scope, stays byte for byte
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { configureScopes, engineState } from "./engine-closed.ts";
import { executeEnginePlans } from "./engine-exec.ts";
import { exclOps } from "./engine-fs.ts";
import { applyFactsDelta, planEngineHistory, removeEngineHistoryFiles } from "./engine-history-run.ts";
import { hasContentSteps, homeKey, stepPath } from "./engine-plan-core.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { builtAddonPath, useRealExclusion } from "./testing/engine-exclusion-fake.ts";
import { canaryHits } from "./testing/engine-history-fixtures.ts";
import { buildScope, OID } from "./testing/engine-scope-fixture.ts";

const addon = builtAddonPath();
const TAIL = ["/usr/bin/tail", "/bin/tail"].find((path) => existsSync(path));
const runs = process.platform === "linux" && addon !== null && TAIL !== undefined;

const BOT = "f25024c1-a18e-4251-acf1-0c1713d9b6d9";
const THREAD = "2e9018ee-1f45-46be-8ed1-7a02fc022807";
const OTHER_THREAD = "9b0e3c1a-0000-4000-8000-000000000001";

describe.skipIf(!runs)("F16 phase 2 with real processes (Linux, real addon)", () => {
  let scratch = "", restore: (() => void) | null = null, codex = "";
  const children: ChildProcess[] = [];
  beforeAll(() => {
    scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-scopes-real-")));
    restore = useRealExclusion(addon!);
    mkdirSync(join(scratch, "bin"));
    codex = join(scratch, "bin", "codex");
    copyFileSync(TAIL!, codex);
    chmodSync(codex, 0o755);
  });
  afterEach(() => { for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } } configureScopes(null); });
  afterAll(() => { restore?.(); removeTempDirSync(scratch); });

  let counter = 0;
  function world() {
    const root = join(scratch, `w-${++counter}`);
    const data = join(root, "data"), native = join(data, "native");
    const folder = join(data, "workspaces", BOT, "threads", THREAD), otherFolder = join(data, "workspaces", BOT, "threads", OTHER_THREAD);
    mkdirSync(folder, { recursive: true });
    mkdirSync(otherFolder, { recursive: true });
    const owner = join(root, "home", ".codex");
    mkdirSync(owner, { recursive: true });
    writeFileSync(join(owner, "history.jsonl"), "");
    const scope = buildScope(native, "codex", BOT, owner, folder, otherFolder);
    configureScopes(native);
    return { native, folder, owner, scope };
  }

  /** A live process named codex that follows `file` (so its arguments name it), seen in the real process list before this returns. */
  async function liveCodex(file: string): Promise<ChildProcess> {
    const child = spawn(codex, ["-f", file], { stdio: "ignore" });
    children.push(child);
    for (let tries = 0; tries < 100; tries++) {
      if (exclOps.processes().some((item) => item.pid === child.pid && (item.argv ?? []).includes(file))) return child;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("the codex stand-in never showed in the process list");
  }

  const sqlIds = (file: string) => { const db = new DatabaseSync(file); try { return (db.prepare("SELECT id FROM threads ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id); } finally { db.close(); } };
  const clean = (scope: ReturnType<typeof world>["scope"]) => {
    for (const file of scope.gone) expect(existsSync(file), file).toBe(false);
    expect(canaryHits(scope.home, [scope.canary])).toEqual([]);
    expect(scope.checkBystander()).toEqual([]);
    expect(sqlIds(join(scope.home, "state_1.sqlite"))).toEqual([OID]);
  };

  it("R1: a live foreign codex whose arguments name the scope keeps the scope pending and untouched", async () => {
    const w = world();
    await liveCodex(join(w.scope.home, ".murage-scope.json"));
    expect(engineState("codex", w.scope.home)).toMatchObject({ state: "open", via: "process" });
    const result = removeEngineHistoryFiles([{ engine: "codex", home: w.scope.home }], [w.folder], [], {});
    expect(result.failedHomes).toContain(homeKey("codex", w.scope.home));
    for (const file of w.scope.gone) expect(existsSync(file), `${file} was removed while a codex named the scope`).toBe(true);
  });

  it("R2: a foreign codex in the owner's ~/.codex leaves the owner's home open and the scope removable", async () => {
    const w = world();
    await liveCodex(join(w.owner, "history.jsonl"));
    expect(engineState("codex", w.owner).state).toBe("open");
    expect(engineState("codex", w.scope.home).state).toBe("closed");
    const result = removeEngineHistoryFiles([{ engine: "codex", home: w.scope.home }], [w.folder], [], {});
    expect(result.failed).toEqual([]);
    clean(w.scope);
  });

  it("R3: a crash mid-plan: the next start's plan repeats no destructive step that finished, and the scope ends clean", async () => {
    const w = world();
    await liveCodex(join(w.owner, "history.jsonl"));
    const homes = [{ engine: "codex" as const, home: w.scope.home }];
    const key = homeKey("codex", w.scope.home);
    const planned = planEngineHistory({ kind: "plan", homes, folders: [w.folder], memoryFolders: [], sessions: {} });
    const steps = planned.plans![key]!.steps;
    // crash right after the history rewrite and the rollout's removal have run, before the rest
    const crashAt = Math.max(steps.findIndex((step) => step.k === "rewrite"), steps.findIndex((step) => step.k === "remove")) + 1;
    expect(crashAt).toBeGreaterThan(1);
    expect(crashAt).toBeLessThan(steps.length);
    const finished: string[] = [];
    expect(() => executeEnginePlans(planned.plans!, (_key, index) => { finished.push(stepPath(steps[index]!)); }, { beforeStep: (_key, index) => { if (index === crashAt) throw new Error("killed"); } })).toThrow("killed");
    expect(finished.length).toBeGreaterThan(0);
    // the next start plans from the saved ids, as a restart does
    const again = planEngineHistory({ kind: "plan", homes, folders: [w.folder], memoryFolders: [], sessions: {}, known: planned.discovery });
    const repeated = again.plans![key]!.steps.filter((step) => step.cls === "content" && step.k !== "ownerCheck" && step.k !== "checkpoint" && finished.includes(stepPath(step)));
    expect(repeated, "a destructive step that finished before the crash was planned again").toEqual([]);
    const ran = executeEnginePlans(again.plans!);
    expect(ran.failed).toEqual([]);
    clean(w.scope);
    // the checkpoints the run verified are settled in the saved ids, as the service saves them
    const discovery = { ...(again.discovery ?? {}) };
    applyFactsDelta(discovery, ran.factsDelta);
    const verify = planEngineHistory({ kind: "plan", homes, folders: [w.folder], memoryFolders: [], sessions: {}, known: discovery });
    expect(hasContentSteps(verify.plans![key]!)).toBe(false);
  });

  it("R4: the other conversation of the same bot, in the same scope, stays byte for byte (with a foreign codex running in ~/.codex)", async () => {
    const w = world();
    await liveCodex(join(w.owner, "history.jsonl"));
    expect(removeEngineHistoryFiles([{ engine: "codex", home: w.scope.home }], [w.folder], [], {}).failed).toEqual([]);
    expect(w.scope.checkBystander()).toEqual([]);
    for (const file of w.scope.kept.keys()) expect(existsSync(file), file).toBe(true);
    expect(sqlIds(join(w.scope.home, "state_1.sqlite"))).toEqual([OID]);
  });
});
