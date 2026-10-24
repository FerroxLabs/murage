// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A throw anywhere in a turn's start after admission gives the thread back
// (rehearsal 2, 1.0.3: a routine due at boot threw there and kept its slot).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { giveBackAdmitted, startAdmittedTurn, type AdmittedTurnState } from "./admitted-turn.ts";
import { IndependentThreadRuns, type DirectThreadRun } from "./independent-thread-runs.ts";

const giveBackFor = (runs: IndependentThreadRuns<object>, run: DirectThreadRun<object>) => () => { if (runs.current(run)) runs.release(run); };

describe("startAdmittedTurn", () => {
  it("a throw before the background setup releases the thread, and the error still reaches the caller", () => {
    const runs = new IndependentThreadRuns<object>();
    const run = runs.admit("bot", "thread", {});
    expect(() => startAdmittedTurn(() => { throw new TypeError("Cannot read properties of undefined (reading 'size')"); }, giveBackFor(runs, run), () => {}))
      .toThrow(/reading 'size'/);
    expect(runs.get("thread")).toBeUndefined();
    // the next turn on the thread is admitted at once
    expect(runs.admit("bot", "thread", {}).threadId).toBe("thread");
  });

  it("a rejection of the background work releases the thread", async () => {
    const runs = new IndependentThreadRuns<object>();
    const run = runs.admit("bot", "thread", {});
    const lines: string[] = [];
    await startAdmittedTurn(() => Promise.reject(new Error("cleanup failed")), giveBackFor(runs, run), (line) => lines.push(line));
    expect(runs.get("thread")).toBeUndefined();
    expect(lines.join("\n")).toMatch(/cleanup failed/);
  });

  it("a started turn keeps its thread", async () => {
    const runs = new IndependentThreadRuns<object>();
    const run = runs.admit("bot", "thread", {});
    await startAdmittedTurn(() => Promise.resolve(), giveBackFor(runs, run), () => {});
    expect(runs.current(run)).toBe(true);
  });

  it("never releases a newer turn's run", () => {
    const runs = new IndependentThreadRuns<object>();
    const old = runs.admit("bot", "thread", {});
    runs.release(old);
    const newer = runs.admit("bot", "thread", {});
    expect(() => startAdmittedTurn(() => { throw new Error("late"); }, giveBackFor(runs, old), () => {})).toThrow("late");
    expect(runs.current(newer)).toBe(true);
  });

  it("a failing give-back is logged and never replaces the original error", () => {
    const lines: string[] = [];
    expect(() => startAdmittedTurn(() => { throw new Error("original"); }, () => { throw new Error("release failed"); }, (line) => lines.push(line)))
      .toThrow("original");
    expect(lines.join("\n")).toMatch(/release failed/);
  });
});

describe("giveBackAdmitted (the failure handler of a started turn itself failed)", () => {
  const harness = (state: Partial<AdmittedTurnState>, world: { current?: boolean; held?: boolean; failing?: string[] } = {}) => {
    const calls: string[] = [];
    const step = (name: string) => () => { calls.push(name); if (world.failing?.includes(name)) throw new Error(`${name} failed`); };
    const deps = {
      current: () => world.current ?? true, threadHeld: () => world.held ?? false,
      endMarks: step("endMarks"), release: step("release"), markIdle: step("markIdle"), drain: step("drain"),
      report: (error: unknown) => { calls.push(`report:${error instanceof Error ? error.message : String(error)}`); },
    };
    const lines: string[] = [];
    giveBackAdmitted({ keepThread: false, reported: false, ...state }, "setup", new Error("boom"), deps, (line) => lines.push(line));
    return { calls, lines };
  };

  it("a handler that already released the slot and then threw still clears busy, reports and drains (Astra P2 1)", () => {
    const { calls } = harness({}, { current: false, held: false });
    expect(calls).toEqual(["endMarks", "markIdle", "report:boom", "drain"]);
  });

  it("a turn whose engine stop was unconfirmed keeps its thread even when writing the notice threw (Astra P2 2)", () => {
    const { calls } = harness({ keepThread: true });
    expect(calls).toEqual(["endMarks"]);
  });

  it("releases a run it still owns, and never touches a newer turn's busy mark", () => {
    expect(harness({}, { current: true, held: false }).calls).toEqual(["endMarks", "release", "markIdle", "report:boom", "drain"]);
    expect(harness({}, { current: false, held: true }).calls).toEqual(["endMarks", "report:boom", "drain"]);
  });

  it("does not report twice when the handler already reported", () => {
    expect(harness({ reported: true }, { current: false }).calls).toEqual(["endMarks", "markIdle", "drain"]);
  });

  it("a failing step never stops the ones after it: the bot is never left marked busy", () => {
    const { calls, lines } = harness({}, { current: true, failing: ["endMarks", "release"] });
    expect(calls).toEqual(["endMarks", "release", "markIdle", "report:boom", "drain"]);
    expect(lines.join("\n")).toMatch(/endMarks failed[\s\S]*release failed/);
  });

  it("a throw before setup started (phase start) is rethrown to the caller, so it is not reported here", () => {
    const calls: string[] = [];
    giveBackAdmitted({ keepThread: false, reported: false }, "start", new Error("x"), {
      current: () => true, threadHeld: () => false, endMarks: () => calls.push("endMarks"), release: () => calls.push("release"),
      markIdle: () => calls.push("markIdle"), drain: () => calls.push("drain"), report: () => calls.push("report"),
    }, () => {});
    expect(calls).toEqual(["endMarks", "release", "markIdle", "drain"]);
  });
});

describe("server wiring", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");

  it("guards everything after a direct turn's admission", () => {
    const admit = source.indexOf("const run=directRuns.admit(bot.id,threadId,bot,[]");
    expect(admit).toBeGreaterThan(0);
    expect(source.slice(admit, admit + 600)).toMatch(/void startAdmittedTurn\(\(\) => \{/);
    expect(source).toMatch(/\}, \(error, phase\) => \{ allowance\.close\(\); giveBackAdmittedTurn\(run, bot\.id, threadId, admitted, phase, error, opts\?\.onDispatchError\); \}\);/);
    // the unconfirmed-stop branch marks the thread kept before anything in it can throw, and each report is remembered
    expect(source).toMatch(/if\(acceptedTurnCleanupFailed\) \{\s*admitted\.keepThread = true;/);
    // (1.0.4 SETUP-LAST-RESORT 4f168ca49 added the third: a rebuild stopped while its revoke settled). Every report after the admission is one of them.
    const guarded = source.slice(admit, source.indexOf("giveBackAdmittedTurn(run, bot.id, threadId, admitted, phase, error, opts?.onDispatchError)", admit));
    expect(guarded.match(/opts\?\.onDispatchError\?\.\(/g)?.length).toBe(3);
    expect(guarded.match(/opts\?\.onDispatchError\?\.\([^;]*\);\s*admitted\.reported = true;/g)?.length).toBe(3);
  });

  it("creates the routine-run map before the scheduler exists, and starts the scheduler after the last module state", () => {
    const decl = source.indexOf("const routineRunByTurn = new Map");
    expect(decl).toBeGreaterThan(0);
    expect(decl).toBeLessThan(source.indexOf("routines = new RoutineManager("));
    const start = source.indexOf("homeExecutionGate.open()) routines.start();");
    expect(start).toBeGreaterThan(0);
    // routine work dispatches only after the module's last step opens it, right before the scheduler starts
    expect(source.indexOf("let routineDispatchOpen = false;")).toBeLessThan(source.indexOf("routines = new RoutineManager("));
    expect(source).toMatch(/routineDispatchOpen = true;\nif \(!homeExecutionGate \|\| homeExecutionGate\.open\(\)\) routines\.start\(\);/);
    expect(source).toContain("dispatchOpen: () => routineDispatchOpen,");
    // no module-level const, let or var is declared after the scheduler starts
    expect(source.slice(start).split("\n").filter((line) => /^(export\s+)?(const|let|var)\s/.test(line))).toEqual([]);
    // and nothing awaits at module level after it: a due run could otherwise dispatch before the module finished
    expect(source.slice(start).split("\n").filter((line) => /^await\s|^\S.*=\s*await\s/.test(line))).toEqual([]);
  });
});
