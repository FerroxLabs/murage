// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from "vitest";
import { gate, judge, judgeSlope, judgeStorage, loadBudgets, mergeResults, onlyScenario, regression, table, withScenarios } from "./gate.mjs";
import { stats } from "./stats.mjs";
import { SHAPES, shape } from "./shapes.mjs";

const budgets = loadBudgets();
const s = (p50, p90 = p50, max = p90) => ({ n: 5, p50, p90, max });
const MB = 1_000_000;
/** An end-of-run storage measurement in which every storage row holds: M (the messages b-tree) is 100 MB. */
const storage = () => ({
  messagesBytes: 100 * MB, liveBytes: 600 * MB, fileBytes: 650 * MB, eventsBytes: 100 * MB, autoVacuum: 0,
  tables: { messages: 100 * MB, memory_root_sets: 10 * MB, memory_root_set_members: 40 * MB, memory_line_lineage: 20 * MB, memory_disclosures: 20 * MB, memory_disclosure_outputs: 10 * MB, memory_sources: 50 * MB, memory_source_versions: 100 * MB, memory_records: 200 * MB },
  slope: { turns: 500, early: { turns: 50, bytes: 100_000, messages: 100, perMessage: 1000 }, late: { turns: 50, bytes: 120_000, messages: 100, perMessage: 1200 } },
});
/** A results file in which every budget holds. */
function passing() {
  return {
    eldAll: s(20, 40, 90),
    storage: storage(),
    scenarios: {
      serverBoot: { boot: s(600, 700, 800) },
      turnPrep: { acpPool: true, prep: s(100, 200, 250), firstText: s(200, 400, 500), warm: { firstText: s(200, 400, 500) }, eld: s(20, 60, 90) },
      coldStart: { acpPool: false, firstText: s(1500, 2500, 2900) },
      slope: { turn10: { prep: s(100) }, turn100: { prep: s(110) }, turn500: { prep: s(150) }, resets: 0, resumedShare: 1 },
      ui: { flows: { switchConversation: { usable: s(80, 150) }, openLongThread: { usable: s(100, 200) }, settingsEngines: { settled: s(300, 600) }, botSettings: { usable: s(100, 200) }, appStart: { usable: s(500, 900), settled: s(1500, 2000) } } },
      memorySearch: { recall: s(100, 300), recallSuccess: 1, owner: s(80, 120) },
      routineBurst: { start: s(500, 1500) },
      revoke: { indexMode: "ready", freeze: s(100, 150, 200), byState: { ready: { n: 4, freeze: s(100, 150, 200) }, building: { n: 4, freeze: s(120, 180, 240) } } },
      chatDuringPostUpgradeCheck: { accepted: s(50, 200, 400), engineStarted: s(300, 900, 1500), stall: s(20, 80, 200), frozen: s(5000, 20000, 45000), finishedFlag: 1, failedSends: 0, samplesFlag: 1 },
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

  test("the post-upgrade chat scenario fails when a message waits, a stall is long, or the check's percent freezes", () => {
    const r = passing(); r.scenarios.chatDuringPostUpgradeCheck = { accepted: s(50, 200, 1500), engineStarted: s(300, 3500, 4000), stall: s(20, 80, 900), frozen: s(5000, 20000, 90000), finishedFlag: 1, failedSends: 0, samplesFlag: 1 };
    const failed = gate(r, budgets).rows.filter(x => !x.pass).map(x => x.id).sort();
    expect(failed).toEqual(["chatAccepted", "chatEngineStarted", "chatStall", "checkProgress"]);
    delete r.scenarios.chatDuringPostUpgradeCheck;
    expect(gate(r, budgets).rows.find(x => x.id === "chatAccepted")).toMatchObject({ pass: false, why: ["not measured"] });
  });

  test("good timings do not pass when the check never finished, a message failed, or a clock is missing", () => {
    const good = { accepted: s(50, 200, 400), engineStarted: s(300, 900, 1500), stall: s(20, 80, 200), frozen: s(5000, 20000, 45000) };
    const failedFor = over => { const r = passing(); r.scenarios.chatDuringPostUpgradeCheck = { ...good, finishedFlag: 1, failedSends: 0, samplesFlag: 1, ...over }; return gate(r, budgets).rows.filter(x => !x.pass).map(x => x.id); };
    expect(failedFor({})).toEqual([]);
    expect(failedFor({ finishedFlag: 0 })).toEqual(["chatFinished"]);
    expect(failedFor({ failedSends: 9 })).toEqual(["chatFailed"]);
    expect(failedFor({ samplesFlag: 0 })).toEqual(["chatSamples"]);
    // the old shape (timings only) is not enough
    const r = passing(); r.scenarios.chatDuringPostUpgradeCheck = good;
    expect(gate(r, budgets).rows.filter(x => !x.pass).map(x => x.id).sort()).toEqual(["chatFailed", "chatFinished", "chatSamples"]);
  });

  test("the post-upgrade chat is judged on its own unprimed run, and added to a normal run's results", () => {
    const only = onlyScenario(budgets, "chatDuringPostUpgradeCheck");
    expect(only.metrics.map(m => m.id).sort()).toEqual(["chatAccepted", "chatEngineStarted", "chatFailed", "chatFinished", "chatSamples", "chatStall", "checkProgress"]);
    const chat = passing().scenarios.chatDuringPostUpgradeCheck;
    expect(gate({ scenarios: { chatDuringPostUpgradeCheck: chat } }, only).pass).toBe(true);
    const main = passing(); delete main.scenarios.chatDuringPostUpgradeCheck;
    expect(gate(main, budgets).pass).toBe(false);
    expect(gate(withScenarios(main, { scenarios: { chatDuringPostUpgradeCheck: chat } }), budgets).pass).toBe(true);
  });

  test("the growth slope fails when turn 500 costs far more than turn 10", () => {
    expect(judgeSlope({ scenarios: { slope: { turn10: { prep: s(100) }, turn500: { prep: s(171) }, resets: 0, resumedShare: 1 } } }, budgets.slope).pass).toBe(false);
    expect(judgeSlope({ scenarios: { slope: { turn10: { prep: s(100) }, turn500: { prep: s(169) }, resets: 0, resumedShare: 1 } } }, budgets.slope).pass).toBe(true);
    // tiny numbers: the floor keeps noise from failing it
    expect(judgeSlope({ scenarios: { slope: { turn10: { prep: s(10) }, turn500: { prep: s(30) }, resets: 0, resumedShare: 0.95 } } }, budgets.slope).pass).toBe(true);
  });

  test("a slope cut short by the time cap says how far it got", () => {
    const v = judgeSlope({ scenarios: { slope: { turn10: { prep: s(3000) }, turn100: { prep: s(3700) }, reached: 180, last: { prep: s(4100) }, resets: 0, resumedShare: 1 } } }, budgets.slope);
    expect(v.pass).toBe(false);
    expect(v.why[0]).toBe("turn 500 not reached: 180 turns in the time cap, last turns 4100 ms (turn 10 3000 ms)");
  });

  test("a slope measured across resets is not one resumed session", () => {
    const v = judgeSlope({ scenarios: { slope: { turn10: { prep: s(100) }, turn500: { prep: s(100) }, resets: 3, resumedShare: 1 } } }, budgets.slope);
    expect(v.pass).toBe(false);
    expect(v.why.join(" ")).toContain("resets");
  });

  // RC1-FULL-TURN row 3: 81 of 496 turns resumed; t10 1028 / t100 251 (memory's pre=) / t500 995 passed the ratio
  test("a slope where under 90% of the turns resumed the session fails loudly, whatever its ratio", () => {
    const rc1 = { turn10: { prep: s(1028) }, turn100: { prep: s(251) }, turn500: { prep: s(995) }, reached: 496, resets: 0, resumedShare: 80 / 495 };
    const v = judgeSlope({ scenarios: { slope: rc1 } }, budgets.slope);
    expect(v.pass).toBe(false);
    expect(v.why[0]).toBe("only 16% of the turns resumed the session (needs 90%): not one resumed session");
    // the rig's own error reaches the gate row as a rig error
    const r = passing(); r.scenarios.slope = { ...rc1, resumedShare: 0.5, error: "slope invalid: only 247 of 495 turns after the first resumed the session (50% < 90%)" };
    const row = gate(r, budgets).rows.find(x => x.id === "slope");
    expect(row.pass).toBe(false);
    expect(row.why[0]).toBe("rig error: slope invalid: only 247 of 495 turns after the first resumed the session (50% < 90%)");
    // an old results file with no resumed share is not trusted
    expect(judgeSlope({ scenarios: { slope: { turn10: { prep: s(100) }, turn500: { prep: s(100) }, resets: 0 } } }, budgets.slope).why[0]).toContain("resumed share not reported");
    expect(judgeSlope({ scenarios: { slope: { ...rc1, resumedShare: 0.9, turn100: { prep: s(110) }, turn500: { prep: s(150) }, turn10: { prep: s(100) } } } }, budgets.slope).pass).toBe(true);
  });

  // RC1-FULL-TURN row 2: "warm" TTFT ran with acpPool false, every turn a cold engine
  test("the warm first-token row needs the pool on, and the cold-start row has its own budget with the pool off", () => {
    const r = passing(); r.scenarios.turnPrep.acpPool = false;
    const warm = gate(r, budgets).rows.find(x => x.id === "firstToken");
    expect(warm.pass).toBe(false);
    expect(warm.why).toContain("measured with scenarios.turnPrep.acpPool=false, needs true");
    const r2 = passing(); delete r2.scenarios.turnPrep.warm;
    expect(gate(r2, budgets).rows.find(x => x.id === "firstToken")).toMatchObject({ pass: false, why: ["not measured"] });
    const r3 = passing(); r3.scenarios.coldStart.firstText = s(2000, 3100, 3200);
    expect(gate(r3, budgets).rows.find(x => x.id === "coldStart").why).toEqual(["p90 3100 > 3000"]);
    const cold = budgets.metrics.find(m => m.id === "coldStart"), chat = budgets.metrics.find(m => m.id === "chatEngineStarted");
    expect(cold.p90).toBe(chat.p90);
  });

  // RC1-FULL-BACKGROUND row 3: the newest session cited nothing, no action was built, and n=0 passed as "n/a"
  test("a revoke pass that built no actions fails with the rig's error; each index state is its own row", () => {
    const r = passing();
    r.scenarios.revoke = { indexMode: "ready", byState: { ready: { error: "revoke: built 0 archive and 0 forget actions (needs 1 and 2) from session none with 0 citing receipts" } } };
    const rows = gate(r, budgets).rows;
    expect(rows.find(x => x.id === "revokeFreezeReady").why[0]).toBe("rig error: revoke: built 0 archive and 0 forget actions (needs 1 and 2) from session none with 0 citing receipts");
    expect(rows.find(x => x.id === "revokeFreezeBuilding")).toMatchObject({ pass: false, why: ["not measured"] });
    // a building pass whose index became ready before its actions measured nothing in the building state
    const flipped = { indexMode: "building", byState: { ready: { n: 4, freeze: s(90) }, building: { error: "revoke: not measured in the building state: the actions ran in flipped, ready" } } };
    const r2 = passing(); r2.scenarios.revoke = flipped;
    expect(gate(r2, budgets).rows.find(x => x.id === "revokeFreezeBuilding").why[0]).toContain("not measured in the building state");
  });

  test("the building pass merges into the main results (--with); the main file's own states win", () => {
    const main = passing(); main.scenarios.revoke = { indexMode: "ready", byState: { ready: { n: 4, freeze: s(100, 150, 200) } } };
    const building = { label: "x-revb", scenarios: { revoke: { indexMode: "building", byState: { building: { n: 4, freeze: s(300, 400, 900) }, ready: { n: 1, freeze: s(5) } } } } };
    const merged = mergeResults(main, [building]);
    expect(merged.scenarios.revoke.byState.ready.freeze.max).toBe(200);
    expect(merged.scenarios.revoke.byState.building).toMatchObject({ n: 4, from: "x-revb" });
    const row = gate(merged, budgets).rows.find(x => x.id === "revokeFreezeBuilding");
    expect(row).toMatchObject({ pass: false, why: ["max 900 > 250"] });
    expect(main.scenarios.revoke.byState.building).toBeUndefined();
  });

  test("every budget row says exactly what it measures, and the budget numbers are the 2026-10-10 ones", () => {
    for (const m of budgets.metrics) expect(m.description, m.id).toMatch(/\S.{60,}/);
    const n = id => { const m = budgets.metrics.find(x => x.id === id); return [m.p50, m.p90, m.max, m.min]; };
    expect(n("turnPrep")).toEqual([150, 300, undefined, undefined]);
    expect(n("firstToken")).toEqual([300, 600, undefined, undefined]);
    expect(n("revokeFreezeReady")).toEqual([undefined, undefined, 250, undefined]);
    expect(n("revokeFreezeBuilding")).toEqual([undefined, undefined, 250, undefined]);
    expect(n("memorySearchSuccess")).toEqual([undefined, undefined, undefined, 0.95]);
    expect(n("checkProgress")).toEqual([undefined, undefined, 60000, undefined]);
    expect(budgets.slope).toMatchObject({ maxRatio: 1.7, floorMs: 25, minResumedShare: 0.9 });
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

describe("storage gate (STORAGE-AUDIT section 6)", () => {
  const row = (r, id) => gate(r, budgets).rows.find(x => x.id === id);
  const metric = id => budgets.metrics.find(m => m.id === id);
  const STORE = ["storeLineage", "storeReceipts", "storeSources", "storeWhole", "storeReclaim", "storeSlope", "storeEvents"];

  test("the rows and limits are the audit's: lineage 1.0x, receipts 0.5x, sources 2.0x, file 10x of M; 1.25x live; slope 1.3x; events 256 MB", () => {
    expect(STORE.map(id => [metric(id).measure, metric(id).of ?? null, metric(id).max])).toEqual([
      ["group:lineage", "messages", 1.0], ["group:receipts", "messages", 0.5], ["group:sources", "messages", 2.0], ["live", "messages", 10],
      ["file", "live", 1.25], ["slope", null, 1.3], ["events", null, 256 * 1048576]]);
    expect(budgets.storage.groups.receipts).toEqual(["memory_disclosure"]);
    expect(budgets.storage.groups.sources).toEqual(["memory_source"]);
    for (const t of ["memory_line_lineage", "memory_lineage_carry", "memory_thread_flow", "memory_line_capture", "memory_session_lineage", "memory_deny_line", "memory_root_set_members", "memory_root_sets", "memory_output_roots", "memory_session_roots"])
      expect(budgets.storage.groups.lineage.some(p => t.startsWith(p)), t).toBe(true);
    // memory_deny itself (receipt revoke) is not lineage; deny_* tables are
    expect(budgets.storage.groups.lineage.some(p => "memory_deny".startsWith(p))).toBe(false);
  });

  test("every storage row passes on a file inside its limits, with the multiple shown", () => {
    for (const id of STORE) expect(row(passing(), id), id).toMatchObject({ pass: true, why: [] });
    expect(row(passing(), "storeLineage").observed).toBe("0.7x (66.8 MB / 95.4 MB)");
    expect(row(passing(), "storeEvents").observed).toBe("95.4 MB");
    expect(row(passing(), "storeSlope").observed).toBe("1000 → 1200 B/message over 500 turns");
  });

  test("lineage over 1.0x M fails (per-line carries at the owner's room mix)", () => {
    const r = passing(); r.storage.tables.memory_lineage_carry = 700 * MB;
    expect(row(r, "storeLineage")).toMatchObject({ pass: false, why: ["7.7x messages > 1x"] });
  });
  test("receipts over 0.5x M fail (a per-output fan-out)", () => {
    const r = passing(); r.storage.tables.memory_disclosure_outputs = 1400 * MB;
    expect(row(r, "storeReceipts")).toMatchObject({ pass: false, why: ["14.2x messages > 0.5x"] });
  });
  test("sources over 2.0x M fail (a third copy of the text)", () => {
    const r = passing(); r.storage.tables.memory_source_origins = 60 * MB;
    expect(row(r, "storeSources")).toMatchObject({ pass: false, why: ["2.1x messages > 2x"] });
  });
  test("a live file over 10x M fails (the owner's 55x)", () => {
    const r = passing(); r.storage.liveBytes = 5500 * MB;
    expect(row(r, "storeWhole")).toMatchObject({ pass: false, why: ["55x messages > 10x"] });
  });
  test("a file over 1.25x its live bytes after idle maintenance fails (nothing reclaimed)", () => {
    const r = passing(); r.storage.fileBytes = 760 * MB;
    expect(row(r, "storeReclaim")).toMatchObject({ pass: false, why: ["1.267x live > 1.25x"] });
    r.storage.fileBytes = 750 * MB;
    expect(row(r, "storeReclaim").pass).toBe(true);
  });
  test("bytes per new message late over 1.3x early fails; within the floor passes; too few turns fails", () => {
    const r = passing(); r.storage.slope.late.perMessage = 1301;
    expect(row(r, "storeSlope")).toMatchObject({ pass: false, why: ["late 1301 B per message > 1300 B (early 1000 B)"] });
    r.storage.slope.late.perMessage = 1300;
    expect(row(r, "storeSlope").pass).toBe(true);
    // a short early window of page-sized steps: 100 B -> 300 B is within the 256 B floor
    r.storage.slope.early.perMessage = 100; r.storage.slope.late.perMessage = 300;
    expect(row(r, "storeSlope").pass).toBe(true);
    r.storage.slope.late.perMessage = 400;
    expect(row(r, "storeSlope").pass).toBe(false);
    r.storage.slope = { turns: 20, early: { perMessage: 1000 }, late: { perMessage: 1000 } };
    expect(row(r, "storeSlope").why).toEqual(["slope storage: 20 turns (needs 50)"]);
    delete r.storage.slope;
    expect(row(r, "storeSlope").why[0]).toContain("slope storage not measured");
  });
  test("events/ over 256 MB fails", () => {
    const r = passing(); r.storage.eventsBytes = 3000 * MB;
    expect(row(r, "storeEvents")).toMatchObject({ pass: false, why: [`${3000 * MB} B > ${256 * 1048576} B`] });
  });

  test("dbstat unavailable fails every row that needs it, loudly, and the gate with them", () => {
    const r = passing(); r.storage = { ...storage(), error: "dbstat unavailable: no such table: dbstat (the storage gate cannot be judged without it)" };
    delete r.storage.tables; delete r.storage.messagesBytes;
    const verdict = gate(r, budgets);
    expect(verdict.pass).toBe(false);
    for (const id of ["storeLineage", "storeReceipts", "storeSources", "storeWhole"]) expect(verdict.rows.find(x => x.id === id).why, id).toEqual([r.storage.error]);
    // no storage measured at all fails every storage row
    const none = passing(); delete none.storage;
    for (const id of STORE) expect(row(none, id), id).toMatchObject({ pass: false, why: ["storage not measured"] });
  });

  test("a table in two groups, an empty messages table, or an unknown group fails rather than judging", () => {
    const groups = { ...budgets.storage.groups, sources: ["memory_source", "memory_root_set"] };
    expect(judgeStorage(passing(), metric("storeLineage"), { ...budgets.storage, groups }).why[0]).toBe("tables in more than one group: memory_root_sets, memory_root_set_members");
    const r = passing(); r.storage.messagesBytes = 0;
    expect(row(r, "storeLineage").why).toEqual(["messages bytes not measured or zero"]);
    expect(judgeStorage(passing(), { ...metric("storeLineage"), measure: "group:nope" }, budgets.storage).why).toEqual(["no group nope in budgets.json storage.groups"]);
  });
});

describe("scale rig helpers", () => {
  test("nearest-rank percentiles ignore missing samples", () => {
    expect(stats([5, 1, 4, 2, 3, NaN, undefined])).toEqual({ n: 5, p50: 3, p90: 5, max: 5 });
    expect(stats([])).toEqual({ n: 0, p50: null, p90: null, max: null });
  });

  test("shapes: pr and owner have every dimension of extreme, smaller; overrides are numeric only", () => {
    for (const key of Object.keys(SHAPES.extreme)) { expect(SHAPES.pr).toHaveProperty(key); expect(SHAPES.owner).toHaveProperty(key); }
    expect(Object.keys(SHAPES.owner).sort()).toEqual(Object.keys(SHAPES.extreme).sort());
    expect(SHAPES.pr.rowsTotal).toBeLessThan(SHAPES.extreme.rowsTotal);
    expect(SHAPES.pr.vectors).toBeGreaterThan(12_000);
    expect(shape("pr", { SCALE_ROWS_TOTAL: "1234", SCALE_SESSION_TURNS: "9" })).toMatchObject({ rowsTotal: 1234, sessionTurns: [5, 40] });
    expect(() => shape("huge")).toThrow(/unknown shape/);
  });
});
