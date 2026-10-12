// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from "vitest";
import { gate, judgeSlope, loadBudgets, regression, table } from "./gate.mjs";
import { stats } from "./stats.mjs";
import { SHAPES, shape } from "./shapes.mjs";

const budgets = loadBudgets();
const s = (p50, p90 = p50, max = p90) => ({ n: 5, p50, p90, max });
/** A results file in which every budget holds. */
function passing() {
  return {
    eldAll: s(20, 40, 90),
    scenarios: {
      serverBoot: { boot: s(600, 700, 800) },
      turnPrep: { prep: s(100, 200, 250), firstText: s(200, 400, 500), eld: s(20, 60, 90) },
      slope: { turn10: { prep: s(100) }, turn100: { prep: s(110) }, turn500: { prep: s(150) }, resets: 0 },
      ui: { flows: { switchConversation: { usable: s(80, 150) }, openLongThread: { usable: s(100, 200) }, settingsEngines: { settled: s(300, 600) }, botSettings: { usable: s(100, 200) }, appStart: { usable: s(500, 900), settled: s(1500, 2000) } } },
      memorySearch: { recall: s(100, 300), recallSuccess: 1, owner: s(80, 120) },
      routineBurst: { start: s(500, 1500) },
      revoke: { freeze: s(100, 150, 200) },
      typing: { cores: s(0.2, 0.6, 0.9) },
    },
  };
}

describe("scale gate", () => {
  test("every budget held passes", () => {
    const verdict = gate(passing(), budgets);
    expect(verdict.rows.filter(r => !r.pass)).toEqual([]);
    expect(verdict.pass).toBe(true);
  });

  test("an absolute budget broken fails with the reason", () => {
    const r = passing(); r.scenarios.turnPrep.prep = s(568, 1012, 2500);
    const row = gate(r, budgets).rows.find(x => x.id === "turnPrep");
    expect(row.pass).toBe(false);
    expect(row.why.join(" ")).toContain("p90 1012 > 300");
  });

  test("a scenario that did not run fails rather than passing silently", () => {
    const r = passing(); delete r.scenarios.routineBurst;
    expect(gate(r, budgets).rows.find(x => x.id === "routineStart")).toMatchObject({ pass: false, why: ["not measured"] });
  });

  test("the growth slope fails when turn 500 costs far more than turn 10", () => {
    expect(judgeSlope({ scenarios: { slope: { turn10: { prep: s(100) }, turn500: { prep: s(171) }, resets: 0 } } }, budgets.slope).pass).toBe(false);
    expect(judgeSlope({ scenarios: { slope: { turn10: { prep: s(100) }, turn500: { prep: s(169) }, resets: 0 } } }, budgets.slope).pass).toBe(true);
    // tiny numbers: the floor keeps noise from failing it
    expect(judgeSlope({ scenarios: { slope: { turn10: { prep: s(10) }, turn500: { prep: s(30) }, resets: 0 } } }, budgets.slope).pass).toBe(true);
  });

  test("a slope cut short by the time cap says how far it got", () => {
    const v = judgeSlope({ scenarios: { slope: { turn10: { prep: s(3000) }, turn100: { prep: s(3700) }, reached: 180, last: { prep: s(4100) }, resets: 0 } } }, budgets.slope);
    expect(v.pass).toBe(false);
    expect(v.why[0]).toBe("turn 500 not reached: 180 turns in the time cap, last turns 4100 ms (turn 10 3000 ms)");
  });

  test("a slope measured across resets is not one resumed session", () => {
    const v = judgeSlope({ scenarios: { slope: { turn10: { prep: s(100) }, turn500: { prep: s(100) }, resets: 3 } } }, budgets.slope);
    expect(v.pass).toBe(false);
    expect(v.why.join(" ")).toContain("resets");
  });

  test("a p90 more than 15% and 20 ms worse than the baseline is a regression", () => {
    const base = passing(), now = passing();
    now.scenarios.ui.flows.switchConversation.usable = s(80, 190);
    const metric = budgets.metrics.find(m => m.id === "switch");
    expect(regression(now, base, metric, budgets.regression)).toContain("+27%");
    now.scenarios.ui.flows.switchConversation.usable = s(80, 165);
    expect(regression(now, base, metric, budgets.regression)).toBeNull();
    expect(gate(passing(), budgets, base).pass).toBe(true);
  });

  test("the compare table has one row per budget and both verdicts", () => {
    const bad = passing(); bad.scenarios.typing.cores = s(2, 3, 4);
    const md = table([{ name: "1.0.1", results: bad }, { name: "1.0.2-int", results: passing() }], budgets);
    expect(md.split("\n")).toHaveLength(budgets.metrics.length + 2);
    expect(md).toContain("| Background CPU while the owner types | 2 / 3 / 4 | 0.2 / 0.6 / 0.9 | p50 0.5, p90 1 cores | FAIL / pass |");
  });
});

describe("scale rig helpers", () => {
  test("nearest-rank percentiles ignore missing samples", () => {
    expect(stats([5, 1, 4, 2, 3, NaN, undefined])).toEqual({ n: 5, p50: 3, p90: 5, max: 5 });
    expect(stats([])).toEqual({ n: 0, p50: null, p90: null, max: null });
  });

  test("shapes: pr has every dimension of extreme, smaller; overrides are numeric only", () => {
    for (const key of Object.keys(SHAPES.extreme)) expect(SHAPES.pr).toHaveProperty(key);
    expect(SHAPES.pr.rowsTotal).toBeLessThan(SHAPES.extreme.rowsTotal);
    expect(SHAPES.pr.vectors).toBeGreaterThan(12_000);
    expect(shape("pr", { SCALE_ROWS_TOTAL: "1234", SCALE_SESSION_TURNS: "9" })).toMatchObject({ rowsTotal: 1234, sessionTurns: [5, 40] });
    expect(() => shape("huge")).toThrow(/unknown shape/);
  });
});
