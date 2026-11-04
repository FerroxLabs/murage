// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// A namespace import, so each test stands or falls on its own assertion.
import * as core from "./core.mjs";

const budgetsBytes = readFileSync(new URL("./budgets.json", import.meta.url));
const budgets = JSON.parse(budgetsBytes.toString("utf8")).jobs;
const PATHS_SHA = "c".repeat(64);
const pathsSource = readFileSync(new URL("./paths.mjs", import.meta.url), "utf8");
const TREE = "a".repeat(40);
const ok = { found: true, inViewport: true, covered: false, hoverOnly: false };
const click = { input: "click" };
const key = (k) => ({ input: "key", key: k });
const typed = { input: "type" };
const step = (kind, extra = {}) => ({ kind, label: `${kind} x`, taken: true, seen: ok, inputs: [kind === "key" ? key("Enter") : kind === "type" ? typed : click], ...extra });
const goodWalk = (n) => ({ steps: Array.from({ length: n }, () => step("click")), end: { ok: true } });
const mouse = (b) => b.steps.mouse;
const PATH_SHAPES = Object.fromEntries(budgets.map((b) => [b.id, Array(mouse(b)).fill(false)]));
const runSource = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
const walksFor = (n = mouse) => Object.fromEntries(budgets.map((b) => [b.id, goodWalk(n(b))]));
const jobsFor = (walks, mode = "mouse") => budgets.map((b) => core.judgeJob(b, walks[b.id], mode));
const verdict = (over = {}, walks = walksFor()) => core.buildVerdict({ tree: TREE, version: "1.0.17", os: "linux", mode: "mouse", jobs: jobsFor(walks, over.mode ?? "mouse"), budgets, pathsSha256: PATHS_SHA, walks, ...over });
const gate = (vs, extra = {}) => core.gateVerdict(vs, { tree: TREE, now: Date.parse("2026-11-07T12:00:00Z"), budgets, pathsSha256: PATHS_SHA, pathShapes: PATH_SHAPES, ...extra });

describe("budgets.json and the step ruling", () => {
  it("has every job 0 to 10 with the plan's budgets, for each mode separately", () => {
    expect(budgets.map((b) => b.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(budgets.map((b) => core.budgetFor(b, "mouse"))).toEqual([5, 2, 3, 2, 2, 3, 2, 4, 1, 3, 2]);
  });
  it("writes the step definition at the top of its doc", () => {
    const doc = JSON.parse(budgetsBytes.toString("utf8")).doc.join(" ");
    expect(doc).toMatch(/discrete owner input is one step/);
    expect(doc).toMatch(/Typing a run of characters into one field is ONE step/);
    expect(doc).toMatch(/budgeted separately/);
  });
  it("refuses a job with no budget for the mode", () => {
    expect(() => core.budgetFor({ id: 1, steps: { mouse: 2 } }, "keyboard")).toThrow(/no keyboard step budget/);
  });
});

describe("ten-jobs step counting (each owner input is one step)", () => {
  it("counts every Tab, arrow and Enter press as its own step", () => {
    const rec = step("click", { inputs: [key("Tab"), key("Tab"), key("Tab"), key("Enter")] });
    expect(core.countSteps({ steps: [rec] })).toBe(4);
    const menu = step("click", { inputs: [key("ArrowDown"), key("ArrowDown"), key("Enter")] });
    expect(core.countSteps({ steps: [menu] })).toBe(3);
  });
  it("counts click into a field, the typing and the submit Enter as three, however long the text", () => {
    expect(core.countSteps({ steps: [step("type", { inputs: [click, typed, key("Enter")] })] })).toBe(3);
  });
  it("counts a native list choice as its real inputs, not as one free pick", () => {
    expect(core.countSteps({ steps: [step("click", { inputs: [key("Tab"), key("ArrowDown"), key("ArrowDown")] })] })).toBe(3);
  });
  it("does not count waits, checks or steps not taken", () => {
    const walk = { steps: [step("click"), step("key"), step("type"), { kind: "wait", taken: true }, { kind: "expect", taken: true }, step("click", { taken: false })] };
    expect(core.countSteps(walk)).toBe(3);
  });
  it("needs help when a taken step has no recorded inputs", () => {
    expect(core.stepHelpReason(step("click", { inputs: undefined }))).toMatch(/inputs not recorded/);
  });
  it("judges a mode against that mode's budget", () => {
    const b = { id: 1, name: "x", steps: { mouse: 2, keyboard: 4 }, decisions: 1 };
    const walk = { steps: [step("click", { inputs: [key("Tab"), key("Tab"), key("Tab"), key("Enter")] })], end: { ok: true } };
    expect(core.judgeJob(b, walk, "mouse")).toMatchObject({ pass: false, reason: "over budget: 4 steps, mouse budget 2" });
    expect(core.judgeJob(b, walk, "keyboard")).toMatchObject({ pass: true, budget: 4, mode: "keyboard" });
  });
  it("counts decisions only on taken steps marked as a choice", () => {
    expect(core.countDecisions({ steps: [step("click", { decision: true }), step("click"), step("click", { decision: true, taken: false })] })).toBe(1);
  });
});

describe("ten-jobs needs-help detection", () => {
  it("fails a target that is not on screen", () => expect(core.stepHelpReason(step("click", { seen: { ...ok, found: false } }))).toMatch(/not on screen/));
  it("fails a target that needs scrolling", () => expect(core.stepHelpReason(step("click", { seen: { ...ok, inViewport: false } }))).toMatch(/scrolling/));
  it("fails a hover-only target", () => expect(core.stepHelpReason(step("click", { seen: { ...ok, hoverOnly: true } }))).toMatch(/hover/));
  it("fails a target that is turned off", () => expect(core.stepHelpReason(step("click", { seen: { ...ok, disabled: true } }))).toMatch(/turned off/));
  it("does not count or judge an optional screen this machine skipped", () => {
    const walk = { steps: [step("click"), { kind: "skipped", label: "Next", taken: true, seen: { found: false } }], end: { ok: true } };
    expect(core.judgeJob({ id: 9, name: "x", steps: { mouse: 1, keyboard: 1 }, decisions: 0 }, walk, "mouse")).toMatchObject({ pass: true, steps: 1 });
  });
  it("fails a target the keyboard cannot reach", () => expect(core.stepHelpReason(step("click", { seen: { ...ok, unreachable: true } }))).toMatch(/keyboard/));
  it("fails a covered target", () => expect(core.stepHelpReason(step("click", { seen: { ...ok, covered: true } }))).toMatch(/covered/));
  it("fails help or the palette when the path does not name it, passes when it does", () => {
    expect(core.stepHelpReason(step("key", { seen: { ...ok, viaHelp: true, named: false } }))).toMatch(/help or the palette/);
    expect(core.stepHelpReason(step("key", { seen: { ...ok, viaHelp: true, named: true } }))).toBeNull();
  });
  it("fails an error with no next click even inside the budget", () => {
    const j = core.judgeJob(budgets[1], { ...goodWalk(1), error: "Something went wrong" }, "mouse");
    expect(j).toMatchObject({ pass: false, neededHelp: true });
    expect(j.reason).toMatch(/error with no next click/);
  });
  it("fails a walk that never reached its end", () => {
    expect(core.judgeJob(budgets[1], { steps: [step("click")], end: { ok: false, reason: "no reply in 300 s" } }, "mouse")).toMatchObject({ pass: false, neededHelp: false });
  });
  it("passes at the budget and fails one step over", () => {
    expect(core.judgeJob(budgets[3], goodWalk(2), "mouse").pass).toBe(true);
    expect(core.judgeJob(budgets[3], goodWalk(3), "mouse")).toMatchObject({ pass: false, reason: "over budget: 3 steps, mouse budget 2" });
  });
  it("fails on too many decisions", () => {
    const walk = { steps: [step("click", { decision: true }), step("click", { decision: true })], end: { ok: true } };
    expect(core.judgeJob(budgets[1], walk, "mouse").reason).toMatch(/decisions/);
  });
});

describe("ten-jobs visibility from real hit tests", () => {
  const raw = (over = {}) => ({
    rect: { left: 100, top: 100, right: 200, bottom: 130, width: 100, height: 30 }, vw: 1280, vh: 800,
    chain: [{ opacity: "1", visibility: "visible", display: "block" }, { opacity: "1", visibility: "visible", display: "block" }],
    probes: [{ x: 50, y: 15, hit: "self" }], disabled: false, ...over,
  });
  it("sees a plain, uncovered control and returns where to click", () => {
    const { seen, point } = core.judgeSeen(raw());
    expect(core.seenActionable(seen)).toBe(true);
    expect(point).toEqual({ x: 50, y: 15 });
  });
  it("fails a control whose parent has opacity 0", () => {
    const { seen } = core.judgeSeen(raw({ chain: [{ opacity: "1", visibility: "visible" }, { opacity: "0", visibility: "visible" }] }));
    expect(seen.hidden).toBe(true);
    expect(core.seenActionable(seen)).toBe(false);
    expect(core.stepHelpReason(step("click", { seen }))).toMatch(/hidden by its parent/);
  });
  it("fails a control whose parents together fade it out", () => {
    const { seen } = core.judgeSeen(raw({ chain: [{ opacity: "0.2" }, { opacity: "0.1" }].map((c) => ({ ...c, visibility: "visible" })) }));
    expect(seen.hidden).toBe(true);
  });
  it("fails a control that every probe finds covered by something else", () => {
    const { seen, point } = core.judgeSeen(raw({ probes: [{ x: 50, y: 15, hit: "other" }, { x: 50, y: 12, hit: "other" }] }));
    expect(seen.covered).toBe(true);
    expect(point).toBeNull();
    expect(core.stepHelpReason(step("click", { seen }))).toMatch(/covered/);
  });
  it("does not accept covered, hidden or off-screen end evidence", () => {
    expect(core.seenVisible(core.judgeSeen(raw({ probes: [{ x: 1, y: 1, hit: "other" }] })).seen)).toBe(false);
    expect(core.seenVisible(core.judgeSeen(raw({ chain: [{ opacity: "1", visibility: "visible" }, { opacity: "0", visibility: "visible" }] })).seen)).toBe(false);
    expect(core.seenVisible(core.judgeSeen(raw({ rect: { left: 100, top: 900, right: 200, bottom: 930, width: 100, height: 30 } })).seen)).toBe(false);
    expect(core.seenVisible(core.judgeSeen(raw()).seen)).toBe(true);
    // Visible evidence need not be clickable.
    expect(core.seenVisible(core.judgeSeen(raw({ disabled: true })).seen)).toBe(true);
  });
});

describe("ten-jobs job setup", () => {
  it("never clicks through Playwright in a setup (it scrolls the target into view)", () => {
    expect(pathsSource).not.toMatch(/\.click\(/);
    expect(pathsSource).toMatch(/ctx\.setupClick\(/);
  });
  it("lets a setup click only a target the owner can see, at its visible point", () => {
    const m = { seen: { found: true, inViewport: true, covered: false, hoverOnly: false, hidden: false }, xy: { x: 10, y: 20 } };
    expect(core.setupPoint(m, "row")).toEqual({ x: 10, y: 20 });
    expect(() => core.setupPoint({ ...m, seen: { ...m.seen, inViewport: false } }, "row")).toThrow(/setup: row is not on screen/);
    expect(() => core.setupPoint({ ...m, seen: { ...m.seen, covered: true } }, "row")).toThrow(/setup/);
    expect(() => core.setupPoint({ ...m, xy: null }, "row")).toThrow(/setup/);
  });
});

describe("ten-jobs verdict", () => {
  it("is well formed and passes only when every job passes", () => {
    const v = verdict();
    expect(core.verdictProblems(v)).toEqual([]);
    expect(v.pass).toBe(true);
  });
  it("does not pass with a job missing", () => {
    const v = core.buildVerdict({ tree: TREE, os: "linux", mode: "mouse", jobs: jobsFor(walksFor()).slice(1), budgets });
    expect(v).toMatchObject({ pass: false, missingJobs: [0] });
  });
  it("flags a hand-edited verdict that claims a pass it did not earn, or predates the step ruling", () => {
    const v = verdict();
    v.jobs[2] = { ...v.jobs[2], steps: 9 };
    expect(core.verdictProblems(v).join()).toMatch(/over budget/);
    expect(core.verdictProblems({ ...v, tree: "abc" }).join()).toMatch(/full commit sha/);
    expect(core.verdictProblems({ ...verdict(), version: 1 }).join()).toMatch(/step ruling/);
  });
});

describe("ten-jobs release check against budgets.json", () => {
  const at = "2026-11-07T00:00:00Z";
  const legs = (over = {}) => ["darwin", "win32", "linux"].flatMap((os) => ["mouse", "keyboard"].map((mode) => verdict({ os, mode, at, ...over })));
  it("passes with a fresh passing verdict for the exact tree on every OS and mode", () => {
    expect(gate(legs())).toMatchObject({ ok: true });
  });
  it("blocks a missing leg, another tree, an old verdict or a failure; no waiver", () => {
    expect(gate(legs().filter((v) => !(v.os === "darwin" && v.mode === "mouse"))).reason).toMatch(/darwin\/mouse: no verdict/);
    expect(gate(legs({ tree: "b".repeat(40) })).ok).toBe(false);
    expect(gate(legs({ at: "2026-10-30T00:00:00Z" })).reason).toMatch(/older than 168 h/);
    const w = walksFor(); w[0] = goodWalk(7);
    const bad = legs(); bad[0] = verdict({ os: "darwin", mode: "mouse", at }, w);
    expect(gate(bad).reason).toMatch(/job 0 over budget/);
  });
  it("re-judges against budgets.json, never a budget or count written in the verdict", () => {
    const w = walksFor(); w[3] = goodWalk(5); // job 3: budget 2
    const forged = legs(); const v = verdict({ os: "linux", mode: "mouse", at }, w);
    v.jobs = v.jobs.map((j) => (j.id === 3 ? { ...j, budget: 99, steps: 2, pass: true, reason: null } : j)); v.pass = true;
    forged[forged.findIndex((x) => x.os === "linux" && x.mode === "mouse")] = v;
    expect(core.verdictProblems(v)).toEqual([]);
    expect(gate(forged)).toMatchObject({ ok: false });
    expect(gate(forged).reason).toMatch(/linux\/mouse: failed: job 3 over budget: 5 steps, mouse budget 2/);
  });
  it("re-judges decisions too", () => {
    const w = walksFor(); w[6] = { steps: [step("click", { decision: true })], end: { ok: true } }; // job 6: 0 decisions
    const vs = legs(); const v = verdict({ os: "linux", mode: "mouse", at }, w);
    v.jobs = v.jobs.map((j) => ({ ...j, pass: true, reason: null })); v.pass = true;
    vs[vs.findIndex((x) => x.os === "linux" && x.mode === "mouse")] = v;
    expect(gate(vs).reason).toMatch(/job 6 over budget: 1 decisions/);
  });
  it("refuses a verdict without the paths hash, with another tree's paths, or without budgets", () => {
    expect(gate(legs({ pathsSha256: null })).reason).toMatch(/no paths hash/);
    expect(gate(legs({ pathsSha256: "d".repeat(64) })).reason).toMatch(/other paths or budgets/);
    expect(gate(legs(), { budgets: undefined }).ok).toBe(false);
    expect(gate(legs(), { pathsSha256: undefined }).ok).toBe(false);
  });
  it("refuses duplicate job ids, a missing walk and a verdict dated in the future", () => {
    const dup = legs(); dup[0] = { ...dup[0], jobs: [...dup[0].jobs, dup[0].jobs[0]] };
    expect(gate(dup).reason).toMatch(/duplicate job 0/);
    const nowalk = legs(); nowalk[0] = { ...nowalk[0], walks: {} };
    expect(gate(nowalk).reason).toMatch(/lacks the walk for job 0/);
    expect(gate(legs({ at: "2026-11-09T00:00:00Z" })).reason).toMatch(/future/);
  });
  it("uses the newest verdict for a leg, so a later fail replaces an earlier pass", () => {
    const w = walksFor(); w[0] = goodWalk(9);
    const later = verdict({ os: "linux", mode: "mouse", at: "2026-11-07T06:00:00Z" }, w);
    expect(gate([...legs(), later]).ok).toBe(false);
  });
  it("refuses a passing claim whose walk does not cover the path", () => {
    const empty = legs(); empty[0] = { ...empty[0], walks: { ...empty[0].walks, 0: { end: { ok: true } } } };
    expect(gate(empty).reason).toMatch(/job 0 incomplete walk: walk has no steps/);
    const short = legs(); short[0] = { ...short[0], walks: { ...short[0].walks, 0: goodWalk(4) } }; // path has 5
    expect(gate(short).reason).toMatch(/walk has 4 steps, the path has 5/);
    const noInputs = legs(); const w = goodWalk(5); w.steps[1] = { ...w.steps[1], inputs: [] };
    noInputs[0] = { ...noInputs[0], walks: { ...noInputs[0].walks, 0: w } };
    expect(gate(noInputs).ok).toBe(false);
    expect(gate(legs(), { pathShapes: undefined }).ok).toBe(false);
  });
  it("checks a walk record by record", () => {
    expect(core.walkProblem(goodWalk(2), [false, false])).toBeNull();
    expect(core.walkProblem({ steps: [step("click"), { kind: "skipped", taken: true, inputs: [] }], end: { ok: true } }, [false, true])).toBeNull();
    expect(core.walkProblem({ steps: [step("click", { taken: false })], end: { ok: true } }, [false])).toMatch(/not taken/);
    expect(core.walkProblem({ steps: [step("click")] }, [false])).toMatch(/no end check/);
  });
  it("hashes the paths and budgets files together", () => {
    expect(core.gateFilesSha256(Buffer.from("p"), Buffer.from("b"))).toMatch(/^[0-9a-f]{64}$/);
    expect(core.gateFilesSha256(Buffer.from("p"), Buffer.from("b"))).not.toBe(core.gateFilesSha256(Buffer.from("p"), Buffer.from("c")));
  });
});

// MurageMain 11-03 final patch: three rulings. Each test fails on 526f577c4 on an assertion.
const SKIP = { kind: "skipped", label: "x (not on this machine)", taken: true, inputs: [] };
describe("ruling 1: a skip is allowed only where the path marks the step optional", () => {
  it("fails a walk that skips a step the path does not mark optional", () => {
    expect(core.walkProblem({ steps: [SKIP, SKIP], end: { ok: true } }, [false, false])).toMatch(/step 1 was skipped, the path does not mark it optional/);
    expect(core.walkProblem({ steps: [step("click"), SKIP], end: { ok: true } }, [true, false])).toMatch(/step 2 was skipped, the path does not mark it optional/);
  });
  it("accepts a skip at an optional slot", () => {
    expect(core.walkProblem({ steps: [SKIP, step("click")], end: { ok: true } }, [true, false])).toBeNull();
  });
  it("the release check refuses an all-skipped walk that judges as a pass", () => {
    const at = "2026-11-07T00:00:00Z";
    const vs = ["darwin", "win32", "linux"].map((os) => verdict({ os, mode: "mouse", at }));
    const w = walksFor(); w[1] = { steps: [SKIP, SKIP], end: { ok: true } }; // job 1: two steps, none optional
    vs[2] = verdict({ os: "linux", mode: "mouse", at }, w);
    expect(core.judgeJob(budgets[1], w[1], "mouse").pass).toBe(true); // nothing counted, so only the walk check catches it
    expect(gate(vs).reason).toMatch(/linux\/mouse: failed: job 1 incomplete walk: step 1 was skipped, the path does not mark it optional/);
  });
  it("reads the optional flags from the paths in order", () => {
    expect(typeof core.pathShapes).toBe("function");
    expect(core.pathShapes([{ id: 0, path: [{ kind: "click" }, { kind: "click", optional: true }] }, { id: 1, path: [{ kind: "key" }] }])).toEqual({ 0: [false, true], 1: [false] });
    expect(core.walkProblem(goodWalk(2), 2)).toMatch(/no path shape/); // a bare length is no longer enough
  });
});

describe("ruling 2: a mouse native select records one step, only when the choice changed", () => {
  it("makes a pick input only for a real change to the wanted choice", () => {
    expect(typeof core.pickInput).toBe("function");
    expect(core.pickInput("Every day", "Every weekday", "Every weekday")).toEqual({ input: "pick", from: "Every day", to: "Every weekday" });
    expect(core.pickInput("Every weekday", "Every weekday", "Every weekday")).toBeNull();
    expect(core.pickInput("Every day", "Every day", "Every weekday")).toBeNull();
  });
  it("counts a real pick as one step and fails a pick whose choice did not change", () => {
    const real = { steps: [step("click", { inputs: [{ input: "pick", from: "Every day", to: "Every weekday" }] })], end: { ok: true } };
    expect(core.countSteps(real)).toBe(1);
    expect(core.walkProblem(real, [false])).toBeNull();
    const fake = { steps: [step("click", { inputs: [{ input: "pick", from: "Every day", to: "Every day" }] })], end: { ok: true } };
    expect(core.walkProblem(fake, [false])).toMatch(/inputs not recorded/);
    expect(core.judgeJob({ id: 9, name: "x", steps: { mouse: 2, keyboard: null }, decisions: 1 }, fake, "mouse")).toMatchObject({ pass: false, neededHelp: true });
  });
  it("the rig drives the real control and records no click it did not make", () => {
    expect(runSource).not.toMatch(/the choice in the open list/);
    expect(runSource).toMatch(/await el\.selectOption\(\{ label: s\.option \}\);\s*const input = pickInput\(/);
  });
});

describe("ruling 3: the keyboard leg is report only in 1.0.17", () => {
  const at = "2026-11-07T00:00:00Z";
  const mouseLegs = () => ["darwin", "win32", "linux"].map((os) => verdict({ os, mode: "mouse", at }));
  it("budgets.json gives keyboard no budget yet and says why", () => {
    expect(budgets.map((b) => core.budgetFor(b, "keyboard"))).toEqual(Array(11).fill(null));
    expect(core.reportOnlyMode(budgets, "keyboard")).toBe(true);
    expect(core.reportOnlyMode(budgets, "mouse")).toBe(false);
    expect(JSON.parse(budgetsBytes.toString("utf8")).doc.join(" ")).toMatch(/TENJOBS-KEYBOARD-APP/);
  });
  it("judges a keyboard walk with no pass or fail and keeps its steps", () => {
    const j = core.judgeJob(budgets[0], goodWalk(9), "keyboard");
    expect(j).toMatchObject({ reportOnly: true, pass: null, steps: 9, reason: null });
  });
  it("the release check passes on the mouse legs alone and reports keyboard steps", () => {
    const r = gate(mouseLegs());
    expect(r.ok).toBe(true);
    expect(r.legs.filter((l) => l.mode === "keyboard")).toEqual(["darwin", "win32", "linux"].map((os) => ({ os, mode: "keyboard", ok: null, reportOnly: true, why: "no verdict yet", at: null, steps: null })));
    const kb = verdict({ os: "linux", mode: "keyboard", at }, walksFor(() => 7));
    const r2 = gate([...mouseLegs(), kb]);
    expect(r2.ok).toBe(true);
    expect(r2.legs.find((l) => l.os === "linux" && l.mode === "keyboard").steps).toEqual(Object.fromEntries(budgets.map((b) => [b.id, 7])));
  });
  it("reports keyboard steps only from a fresh verdict walked with this tree's paths", () => {
    const other = verdict({ os: "linux", mode: "keyboard", at, pathsSha256: "d".repeat(64) });
    expect(gate([...mouseLegs(), other]).legs.find((l) => l.os === "linux" && l.mode === "keyboard")).toMatchObject({ steps: null, why: /other paths/ });
    const old = verdict({ os: "linux", mode: "keyboard", at: "2026-10-30T00:00:00Z" });
    expect(gate([...mouseLegs(), old]).legs.find((l) => l.os === "linux" && l.mode === "keyboard")).toMatchObject({ steps: null, why: /older than 168 h/ });
  });
  it("still fails closed when no mode has budgets", () => {
    const none = budgets.map((b) => ({ ...b, steps: { mouse: null, keyboard: null } }));
    expect(gate(mouseLegs(), { budgets: none })).toMatchObject({ ok: false, reason: "no mode has budgets to judge" });
  });
});
