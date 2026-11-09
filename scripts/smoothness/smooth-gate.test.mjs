// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The smoothness gate's judge against the shipped budgets.json: a release must not pass this gate on a run that broke a
// budget, missed a scenario, or never ran under load.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gate, loadBudgets } from "./smooth-gate.mjs";
import { judge, recordRoomDelete, workerSliceWall } from "./smooth-config.mjs";

const budgets = loadBudgets();
const fixLeg = (leg, r) => leg === "loaded" ? { ...r, load: true, runId: "load-run" } : { ...r, load: false, runId: "idle-run" };
const asLoaded = r => ({ ...r, load: true, runId: `${r.runId ?? "idle"}-loaded` });
const set = (obj, path, value) => { const keys = path.split("."); let o = obj; for (const k of keys.slice(0, -1)) o = o[k] ??= {}; o[keys.at(-1)] = value; };
/** A results file that meets every budget exactly at its edge. */
function greenResults(label = "idle") {
  const r = { label, runId: `${label}-run`, tree: "58cca340d406", engines: "fake", load: label === "load", scenarios: {}, all: {} };
  for (const row of budgets.rows) set(r, row.path, row.op === ">=" ? row.value : row.op === "==" ? row.value : row.value);
  return r;
}

describe("gate() pair validation", () => {
  const idle = () => greenResults();
  it("the same file twice, a cross-tree file, a missing tree or run id, and an idle-recorded load are each a FAIL", () => {
    expect(gate({ idle: asLoaded(idle()), loaded: asLoaded(idle()), budgets }).exit).toBe(1); // idle records load
    expect(gate({ idle: idle(), loaded: idle(), budgets })).toMatchObject({ exit: 1, verdict: { pass: false } }); // same file twice
    expect(gate({ idle: idle(), loaded: { ...asLoaded(idle()), tree: "other" }, budgets }).exit).toBe(1);
    expect(gate({ idle: { ...idle(), tree: undefined }, loaded: { ...asLoaded(idle()), tree: undefined }, budgets }).exit).toBe(1);
    expect(gate({ idle: idle(), loaded: { ...asLoaded(idle()), runId: undefined }, budgets }).exit).toBe(1);
    expect(gate({ idle: idle(), loaded: { ...asLoaded(idle()), load: false }, budgets }).exit).toBe(1); // the rig's own load flag is not overwritten
    expect(gate({ idle: idle(), loaded: asLoaded(idle()), budgets })).toMatchObject({ exit: 0, verdict: { pass: true } });
  });
});
describe("budgets.json", () => {
  it("names every scenario of the design with at least one zero-count row and one latency row where a person waits", () => {
    const scenarios = new Set(budgets.rows.map(r => r.scenario));
    for (const s of ["boot", "routineBurst", "delegation", "room", "trust", "longThread", "deletion", "engineSwitch", "stop", "idle", "all"]) expect(scenarios.has(s), s).toBe(true);
    expect(budgets.rows.filter(r => r.op === "==" && r.value === 0).length).toBeGreaterThanOrEqual(12);
    expect(budgets.rows.filter(r => r.latency).length).toBeGreaterThanOrEqual(10);
    expect(new Set(budgets.rows.map(r => r.id)).size).toBe(budgets.rows.length);
  });
  it("keeps the No limits contract: zero cards for the ordinary commands and the stop line, one for the wipe line (rig v5.8)", () => {
    expect(budgets.rows.find(r => r.id === "S4.unlimited")).toMatchObject({ op: "==", value: 0 });
    expect(budgets.rows.find(r => r.id === "S4.wipeLine")).toMatchObject({ op: "==", value: 1, path: "scenarios.trust.levels.unlimited.wipeCards" });
    expect(budgets.rows.find(r => r.id === "S4.stopLine")).toMatchObject({ op: "==", value: 0, path: "scenarios.trust.levels.unlimited.stopLineCards" });
    expect(budgets.rows.find(r => r.id === "S4.stopLines")).toBeUndefined();
    expect(budgets.rows.find(r => r.id === "S2.withheld")).toMatchObject({ op: "==", value: 0 });
    expect(budgets.rows.find(r => r.id === "ALL.context")).toMatchObject({ op: "==", value: 0 });
  });
});

describe("gate()", () => {
  const fullRoomProof = () => ({ ok: true,
    card: { raised: 3, answered: 3, respondStatus: 200, requestId8: "12345678" },
    interrupt: { sawWorking: true, interruptStatus: 202, settledMs: 1000, settled: true } });
  const proofRows = out => out.rows.filter(row => row.id.startsWith("S3.proof."));
  it("the Windows RSS peak snapshot is one informational line: verdict, rows and exit do not move", () => {
    const plain = gate({ idle: greenResults(), loaded: null, budgets });
    const withPeak = greenResults(); withPeak.rssPeakProcs = { atMs: 1_700_000_000_000, rssMb: 4545, top: [{ name: "claude.exe", mb: 2000 }, { name: "node.exe", mb: 100 }] };
    const out = gate({ idle: withPeak, loaded: null, budgets });
    expect(out.verdict.rows).toEqual(plain.verdict.rows);
    expect({ ...out.verdict, at: 0 }).toEqual({ ...plain.verdict, at: 0 });
    expect(out.exit).toBe(plain.exit);
    expect(out.idle.rows).toEqual(plain.idle.rows);
    expect(out.md).toContain("ALL.rss_peak_procs");
    expect(out.md).toContain("claude.exe 2000 MB, node.exe 100 MB");
    expect(plain.md).not.toContain("rss_peak_procs");
    expect(out.md.split("\n").filter(l => l.startsWith("|") && l.includes("rss_peak_procs"))).toEqual([]);
  });
  it("room proof: no proof rows unless explicitly requested", () => {
    const idle = greenResults(); idle.scenarios.room.proof = fullRoomProof();
    for (const requested of [undefined, false]) {
      idle.roomProofRequested = requested;
      const out = gate({ idle, loaded: asLoaded(idle), budgets });
      expect(proofRows(out.idle)).toEqual([]); expect(out.md).not.toContain("S3.proof.");
      expect(out.exit).toBe(0);
    }
  });
  it.each(["idle", "loaded"])("room proof: requested missing evidence FAILs both rows on %s", leg => {
    const requested = greenResults(); requested.roomProofRequested = true;
    const out = gate({ idle: greenResults(), loaded: greenResults("load"), budgets, [leg]: fixLeg(leg, requested) });
    expect(proofRows(out[leg]).map(row => [row.id, row.pass])).toEqual([["S3.proof.respond", false], ["S3.proof.interrupt", false]]);
    expect(out.exit).toBe(1); expect(out.verdict.pass).toBe(false);
  });
  it.each([
    ["card", "raised", 0, "respond"], ["card", "answered", 0, "respond"],
    ["card", "respondStatus", 403, "respond"], ["card", "respondStatus", null, "respond"],
    ["card", "requestId8", null, "respond"], ["card", "error", "wrong card count", "respond"],
    ["interrupt", "sawWorking", false, "interrupt"], ["interrupt", "interruptStatus", 500, "interrupt"],
    ["interrupt", "settled", false, "interrupt"], ["interrupt", "settledMs", 60_001, "interrupt"],
    ["interrupt", "settledMs", null, "interrupt"],
  ])("room proof: %s.%s=%s FAILs %s despite claimed ok", (block, field, value, failedStep) => {
    const idle = greenResults(); idle.roomProofRequested = true;
    idle.scenarios.room.proof = fullRoomProof(); idle.scenarios.room.proof[block][field] = value;
    const out = gate({ idle, loaded: asLoaded(idle), budgets });
    expect(proofRows(out.idle).find(row => row.id === `S3.proof.${failedStep}`).pass).toBe(false);
    expect(out.exit).toBe(1); expect(out.verdict.pass).toBe(false);
  });
  it("room proof: full evidence PASSes both rows in judge, table and verdict", () => {
    const idle = greenResults(); idle.roomProofRequested = true; idle.scenarios.room.proof = fullRoomProof();
    const out = gate({ idle, loaded: asLoaded(idle), budgets });
    expect(proofRows(judge(budgets, idle)).every(row => row.pass)).toBe(true);
    expect(proofRows(out.idle)).toHaveLength(2); expect(out.exit).toBe(0);
    for (const step of ["respond", "interrupt"]) {
      expect(out.md).toContain(`| S3.proof.${step} |`);
      expect(out.verdict.rows[`S3.proof.${step}`]).toEqual({ pass: true, value: 1 });
      expect(out.verdict.rows[`S3.proof.${step}@load`]).toEqual({ pass: true, value: 1 });
    }
  });
  it("room proof: real-engine request is INVALID even with a claimed full proof", () => {
    const idle = greenResults(); Object.assign(idle, { engines: "real", roomProofRequested: true });
    idle.scenarios.room.proof = fullRoomProof();
    const out = gate({ idle, budgets });
    expect(out.idle.invalid).toContain("requires fake engines"); expect(out.exit).toBe(1);
    expect(proofRows(out.idle).every(row => !row.pass)).toBe(true);
  });
  it("room drain: INFO reports rounds, tail and settlement without changing budgets", () => {
    const idle = greenResults();
    Object.assign(idle.scenarios.room, { done: true, incomplete: false,
      drain: { rounds: ["DONE", "DONE", "DONE", "DONE"], tail: "DONE", done: true } });
    const out = gate({ idle, loaded: asLoaded(idle), budgets });
    expect(out.md).toContain("| S3.drain | room | room drain and settlement (no budget) | rounds=DONE,DONE,DONE,DONE; tail=DONE; measured DONE=true; final DONE=true; incomplete=false; settlement=not needed | info only |");
    expect(out.idle.rows).toHaveLength(budgets.rows.length); expect(out.verdict.rows["S3.drain"]).toBeUndefined();
    expect(out.exit).toBe(0);
    delete idle.scenarios.room.drain; idle.scenarios.room.done = false;
    expect(gate({ idle, budgets }).md).toContain("DONE=false; incomplete=false; settlement=not needed");
  });
  it.each(["5.9", "5.10", "6.0"])("v%s cleanup is INVALID, legFailed is FAIL, finished passes on both legs", rigVersion => {
    for (const leg of ["idle", "loaded"]) {
      const results = { ...greenResults(), rigVersion, phase: "cleanup" };
      const run = () => gate({ idle: greenResults(), loaded: greenResults("load"), budgets, [leg]: fixLeg(leg, results) });
      expect(run()[leg]).toMatchObject({ pass: false, invalid: "run did not finish cleanup (phase: cleanup)" });
      expect(run().md).toContain("INVALID: run did not finish cleanup");
      results.legFailed = true; results.legFailureReason = "cleanup failed fixture";
      for (const phase of ["cleanup", "finished"]) {
        results.phase = phase;
        expect(run()).toMatchObject({ exit: 1, verdict: { pass: false } });
        expect(run()[leg]).toMatchObject({ pass: false, invalid: "cleanup failed fixture" });
      }
      results.legFailed = false;
      expect(run()).toMatchObject({ exit: 0, verdict: { pass: true } });
    }
  });
  it.each([undefined, "running", "cleanup"])("v5.8 phase %s is INVALID despite all green rows", phase => {
    const idle = { ...greenResults(), rigVersion: "5.8", phase };
    expect(judge(budgets, idle)).toMatchObject({ pass: false, invalid: `run did not finish cleanup (phase: ${phase ?? "missing"})` });
    for (const leg of ["idle", "loaded"]) {
      const out = gate({ idle: greenResults(), loaded: greenResults("load"), budgets, [leg]: fixLeg(leg, idle) });
      expect(out.exit).toBe(1); expect(out.verdict.pass).toBe(false);
      expect(out[leg].rows.every(row => row.pass)).toBe(true);
      expect(out.md).toContain(`INVALID: run did not finish cleanup (phase: ${phase ?? "missing"})`);
    }
  });
  it.each(["cleanup", "finished"])("v5.8 rejected DELETE in phase %s FAILs with its saved reason", phase => {
    const idle = { ...greenResults(), rigVersion: "5.8", phase, notes: [] };
    recordRoomDelete(idle, "fixture-room", { status: 409 });
    const snapshot = JSON.parse(JSON.stringify(idle));
    const reason = "cleanup: room fixture-room DELETE 409";
    expect(judge(budgets, snapshot)).toMatchObject({ pass: false, invalid: reason });
    const out = gate({ idle: snapshot, loaded: greenResults("load"), budgets });
    expect(out.exit).toBe(1); expect(out.verdict.pass).toBe(false);
    expect(out.md).toContain(`INVALID: ${reason}`);
  });
  it("v5.8 finished clean results pass the same budgets", () => {
    const idle = { ...greenResults(), rigVersion: "5.8", phase: "finished" };
    expect(judge(budgets, idle).pass).toBe(true);
    expect(gate({ idle, loaded: asLoaded(idle), budgets })).toMatchObject({ exit: 0, verdict: { pass: true } });
  });
  it.each([undefined, "5.7"])("pre-5.8 version %s without phase retains existing judging", rigVersion => {
    const idle = { ...greenResults(), rigVersion };
    if (rigVersion === undefined) delete idle.rigVersion;
    expect(judge(budgets, idle).pass).toBe(true);
    expect(gate({ idle, loaded: asLoaded(idle), budgets })).toMatchObject({ exit: 0, verdict: { pass: true } });
    idle.legFailed = true;
    expect(judge(budgets, idle)).toMatchObject({ pass: false, invalid: "room cleanup failed" });
  });
  it.each([5.9, NaN, "broken", "5.9.0", "", null, undefined])("malformed rigVersion %s is INVALID even when finished", rigVersion => {
    for (const phase of [undefined, "cleanup", "finished"]) {
      const result = { ...greenResults(), rigVersion, phase };
      for (const leg of ["idle", "loaded"]) {
        const out = gate({ idle: greenResults(), loaded: greenResults("load"), budgets, [leg]: fixLeg(leg, result) });
        expect(out[leg]).toMatchObject({ pass: false, invalid: "invalid rigVersion: expected a major.minor string" });
        expect(out).toMatchObject({ exit: 1, verdict: { pass: false } });
      }
    }
  });
  it.each([undefined, "running", "cleanup", "finished"])("absent rigVersion with phase %s requires finished and no legFailed", phase => {
    const result = { ...greenResults(), phase };
    expect(judge(budgets, result).pass).toBe(phase === "finished");
    if (phase !== "finished") expect(judge(budgets, result).invalid).toContain("run did not finish cleanup");
    result.legFailed = true; result.legFailureReason = "fixture restoration failure";
    expect(judge(budgets, result)).toMatchObject({ pass: false, invalid: result.legFailureReason });
  });
  it.each(["0.1", "5.7", "05.07"])("confirmed legacy version %s retains judging despite phase metadata", rigVersion => {
    expect(judge(budgets, { ...greenResults(), rigVersion, phase: "cleanup" }).pass).toBe(true);
  });
  it("drain 5: S3.cardWait is INFO beside S3, with no budget or verdict entry", () => {
    const idle = greenResults();
    idle.scenarios.room.cardRows = [{ waitMs: 900_000 }, { waitMs: 50 }];
    const out = gate({ idle, loaded: asLoaded(idle), budgets });
    expect(out.md).toContain("| S3.cardWait | room | owner card wait (no budget) | 900050 ms; 2 cards | info only |");
    expect(out.md.indexOf("| S3.cardWait |")).toBeGreaterThan(out.md.indexOf("| S3.cards |"));
    expect(out.md.indexOf("| S3.cardWait |")).toBeLessThan(out.md.indexOf("| S4.ask |"));
    expect(out.verdict.pass).toBe(true); expect(out.verdict.rows["S3.cardWait"]).toBeUndefined();
    expect(out.idle.rows).toHaveLength(budgets.rows.length);
  });
  it.each(["fake", "real"])("drain 7: incomplete S3 makes the full %s leg FAIL with partial green numbers", engines => {
    const idle = greenResults(); idle.engines = engines; idle.scenarios.room.incomplete = true;
    const out = gate({ idle, loaded: asLoaded(idle), budgets });
    expect(out.exit).toBe(1); expect(out.verdict.pass).toBe(false);
    for (const id of ["S3.cards", "S3.replies", "S3.first", "S3.last"]) {
      expect(out.idle.rows.find(row => row.id === id)).toMatchObject({ pass: false, value: null, roomIncomplete: true });
    }
    expect(out.md).toContain("not measured (room did not settle) | FAIL");
  });
  it("marks a stale passing file INVALID when the launcher expects another run", () => {
    const idle = { ...greenResults(), runId: "old-pass" };
    const out = gate({ idle, loaded: asLoaded(idle), budgets, expectedRunId: "new-run" });
    expect(out.exit).toBe(1); expect(out.verdict.pass).toBe(false);
    expect(out.md).toContain("INVALID: run id mismatch: expected new-run, found old-pass");
    expect(out.loaded.invalid).toContain("run id mismatch");
    expect(gate({ idle, budgets }).exit).toBe(0);
    expect(gate({ idle: { ...idle, runId: "new-run" }, budgets, expectedRunId: "new-run" }).exit).toBe(0);
    expect(gate({ idle: greenResults(), budgets, expectedRunId: "new-run" }).exit).toBe(1);
    const script = readFileSync(new URL("./smooth-gate.mjs", import.meta.url), "utf8");
    expect(script).toContain("expectedRunId: process.env.SMOOTH_RUN_ID");
    const launcher = readFileSync(new URL("./real-smooth.sh", import.meta.url), "utf8");
    expect(launcher).toContain('export SMOOTH_RUN_ID="$RUN_ID"');
  });
  it("reports WARM window resource and IO numbers only in the information row", () => {
    const idle = { ...greenResults(), mode: "packaged", preflight: { ok: true } };
    idle.scenarios.bootWarm = { window: { from: 100, to: 900 }, measurements: { eld: { max: 9999, secondsOver250: 9 }, ioBudget: 12, ioOverlap: 2, cpu: { p90: 99 }, rssMb: { max: 99999 } } };
    const out = gate({ idle, loaded: asLoaded(idle), budgets });
    expect(out.verdict.pass).toBe(true);
    expect(out.md).toContain("window=100..900; ELD max=9999 ms, over250=9; io=12 (overlapping minute=2); CPU p90=99 cores; RSS max=99999 MB");
  });
  it("gates only the packaged cold boot at the existing budget, never the WARM row", () => {
    const idle = { ...greenResults(), mode: "packaged", preflight: { ok: true }, compileCache: { filesAfterCold: 2 } };
    idle.scenarios.boot = { healthy: { n: 1, p50: 20_000, p90: 20_000, max: 20_000 }, samples: [20_000] };
    idle.scenarios.bootWarm = { healthy: { n: 1, p50: 90_000, p90: 90_000, max: 90_000 }, samples: [90_000] };
    const out = gate({ idle, loaded: asLoaded(idle), budgets });
    expect(out.verdict.pass).toBe(true);
    expect(out.idle.rows.find(r => r.id === "S0.boot")).toMatchObject({ limit: 20_000, value: 20_000, pass: true });
    expect(out.md).toContain("| S0.warm | boot | WARM boot to /api/health (no budget) | n=1, p50=90000 ms, p90=90000 ms, max=90000 ms | info only |");
    expect(out.idle.rows).toHaveLength(budgets.rows.length);
    expect(out.verdict.rows["S0.warm"]).toBeUndefined();
    idle.scenarios.boot.healthy.p90 = 20_001; idle.scenarios.bootWarm.healthy.p90 = 1;
    expect(gate({ idle, loaded: asLoaded(idle), budgets }).verdict.pass).toBe(false);
  });
  it("shows a missing warm measurement and an unfilled cache without changing the verdict", () => {
    const idle = { ...greenResults(), mode: "packaged", preflight: { ok: true }, compileCache: { filesAfterCold: 0 } };
    const out = gate({ idle, loaded: asLoaded(idle), budgets });
    expect(out.verdict.pass).toBe(true);
    expect(out.md).toContain("| not measured; cache did not fill; not a warm boot | info only |");
  });
  it.each([true, false])("shows S3 worker wall evidence (trace present: %s) without a bound or verdict effect", present => {
    const idle = greenResults();
    idle.scenarios.room.workerSliceWall = workerSliceWall(present ? "[turn-trace] phase=memory.indexSlice ms=900000 rowMs=800000 rows=4" : "[eld] t=1");
    const out = gate({ idle, loaded: asLoaded(idle), budgets });
    expect(out.md).toContain(`| S3.workerSliceWall | room | memory.indexSlice wall incl commit (no budget) | ${present ? "count=1, max=900000 ms, p99=900000 ms; rowMs max=800000 ms" : "not measured"} | info only |`);
    expect(out.verdict.pass).toBe(true); expect(out.idle.rows).toHaveLength(budgets.rows.length);
    expect(out.verdict.rows["S3.workerSliceWall"]).toBeUndefined();
    expect(out.md).not.toContain("S0.warm"); // Source-mode boot reporting stays unchanged.
  });
  it.each([undefined, { ok: false, refusal: "desktop secret rejected" }])("rejects a packaged leg without completed preflight even at green budgets", preflight => {
    const idle = { ...greenResults(), mode: "packaged", preflight };
    const out = gate({ idle, loaded: greenResults("load"), budgets });
    expect(out.exit).toBe(1); expect(out.verdict.pass).toBe(false);
    expect(out.idle.invalid).toBe(preflight?.refusal ?? "packaged preflight did not complete");
  });
  it("accepts completed packaged preflight only when all budgets also pass", () => {
    const idle = { ...greenResults(), mode: "packaged", preflight: { ok: true } };
    expect(gate({ idle, loaded: asLoaded(idle), budgets }).verdict.pass).toBe(true);
    idle.scenarios.trust.levels.unlimited.cards = 1;
    expect(gate({ idle, loaded: greenResults("load"), budgets }).exit).toBe(1);
  });
  it("passes a run at the edge of every budget and writes a verdict for the tree", () => {
    const out = gate({ idle: greenResults(), loaded: greenResults("load"), budgets });
    expect(out.exit).toBe(0);
    expect(out.verdict).toMatchObject({ tree: "58cca340d406", pass: true, engines: "fake" });
    expect(out.md).toContain("PASS:");
  });
  it("fails on one broken count, names the row, and the verdict says so", () => {
    const idle = greenResults(); idle.scenarios.trust.levels.unlimited.cards = 3;
    const out = gate({ idle, loaded: greenResults("load"), budgets });
    expect(out.exit).toBe(1);
    expect(out.idle.rows.find(r => r.id === "S4.unlimited")).toMatchObject({ pass: false, value: 3 });
    expect(out.verdict.pass).toBe(false);
    expect(out.md).toMatch(/S4\.unlimited .* FAIL/);
  });
  it("a loaded run keeps the same limit and shows the old factor as information, and a missing loaded run cannot pass the verdict", () => {
    const loaded = greenResults("load"); loaded.scenarios.longThread.firstText.p90 = 4400; loaded.scenarios.routineBurst.cards = 1;
    const out = gate({ idle: greenResults(), loaded, budgets });
    expect(out.loaded.rows.find(r => r.id === "S5.firstText")).toMatchObject({ pass: false, limit: 3000, oldFactor: { limit: 4500, wouldPass: true } });
    expect(out.loaded.rows.find(r => r.id === "S1.cards")).toMatchObject({ pass: false });
    expect(out.exit).toBe(1);
    const alone = gate({ idle: greenResults(), loaded: null, budgets });
    expect(alone.exit).toBe(0); expect(alone.verdict.pass).toBe(false); expect(alone.verdict.load.loaded).toBeNull();
  });
  it("treats a scenario that never ran as failing every one of its rows", () => {
    const idle = greenResults(); delete idle.scenarios.stop;
    const out = gate({ idle, loaded: greenResults("load"), budgets });
    expect(out.idle.rows.filter(r => r.scenario === "stop").every(r => r.pass === false && r.missing)).toBe(true);
  });
});

describe("the judge as a command (what real-smooth.sh and real-smooth.ps1 run)", () => {
  // The Windows leg once got exit 0 with no output and no table: the script-entry check never matched, so the body never ran.
  // The launchers now require the table and its "rows pass" line; this pins that the command always writes both and fails a red run.
  const here = dirname(fileURLToPath(import.meta.url));
  it("writes the table with its rows-pass line and exits 1 on a red run, started by a relative path from another directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "smooth gate "));
    const idle = greenResults(); idle.scenarios.trust.levels.unlimited.cards = 3;
    writeFileSync(join(dir, "results.json"), JSON.stringify(idle));
    const r = spawnSync(process.execPath, [relative(dir, join(here, "smooth-gate.mjs")), "results.json", "--md", "gate.md"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL: \d+ of \d+ rows pass\./);
    expect(existsSync(join(dir, "gate.md"))).toBe(true);
    expect(readFileSync(join(dir, "gate.md"), "utf8")).toMatch(/rows pass\./);
    rmSync(dir, { recursive: true, force: true });
  });
  it("exits 0 with the table on a green run", () => {
    const dir = mkdtempSync(join(tmpdir(), "smooth-gate-"));
    writeFileSync(join(dir, "results.json"), JSON.stringify(greenResults()));
    const r = spawnSync(process.execPath, [join(here, "smooth-gate.mjs"), join(dir, "results.json"), "--md", join(dir, "gate.md")], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "gate.md"), "utf8")).toMatch(/PASS: \d+ of \d+ rows pass\./);
    rmSync(dir, { recursive: true, force: true });
  });
});

// T24 red on rev 4 and v5.8: the two run-start info rows do not exist.
it("T24 run-start ELD info cannot fail a first-send-window pass and no-send stays unmeasured", () => {
  const r = greenResults();
  r.all.eldFromRunStart = { max: 999999, secondsOver250: 999999 };
  const g = gate({ idle: r, loaded: asLoaded(r), budgets });
  expect(g.exit).toBe(0);
  expect(g.md).toContain("ALL.eld_from_run_start"); expect(g.md).toContain("ALL.eld250_from_run_start");
  expect(g.md).toContain("999999 | info only");
  expect(g.idle.rows.some(row => row.id.endsWith("_from_run_start"))).toBe(false);
  r.all.eld = null;
  const noSend = gate({ idle: r, budgets });
  expect(noSend.idle.rows.find(row => row.id === "ALL.eld")).toMatchObject({ missing: true, pass: false });
  expect(noSend.md).toContain("not measured");
});

// F2 fails on 90b8e01c6: a first transport rejection leaves a green leg eligible to pass.
it.each(["call", "roomCall"])("F2 %s rejection keeps the gate red after a later success", async path => {
  const { adapterFixture } = await import("./adapter-fixture.mjs");
  const results = greenResults();
  const f = adapterFixture(results);
  try { await f.send(path); } catch {}
  await f.send(path);
  expect(results.legFailed).toBe(true);
  expect(gate({ idle: results, budgets }).idle.pass).toBe(false);
});
