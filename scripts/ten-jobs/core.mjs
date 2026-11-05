// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The ten-jobs release gate, pure part: step counting, needs-help judgement,
// the verdict file and the release check. The driver (run.mjs) walks the
// packaged app and hands this module what it saw; nothing here touches an app.
//
// Rules (UX-OVERHAUL-BUILD-PLAN.md section 5, step ruling MurageMain 11-03):
// - A step is one discrete owner input: a click or tap, or one key press (each Tab,
//   arrow, Enter, Esc or shortcut). Typing a run of characters into one field is ONE
//   step. Waits, checks and a job's start state are not steps. Each walk record lists
//   its inputs; the count is the sum of them.
// - Mouse and keyboard runs are budgeted separately: budgets.json steps.mouse / steps.keyboard.
// - A job NEEDS HELP when a step's target is not on the current screen without
//   scrolling or hovering, is hidden by a parent or covered, when the walk opens help
//   or the palette and the job's path does not name it, or when an error with no next
//   click appears.
// - A job is OVER BUDGET when it takes more steps (or decisions) than its budget.
// - A verdict is for one exact build, one OS and one input mode. The release check
//   re-judges every verdict from its walks against budgets.json; it never trusts a
//   budget, step count or pass written inside the verdict.
import { createHash } from "node:crypto";

export const STEP_KINDS = Object.freeze(["click", "key", "type"]);
// "pick": a native select choice the rig set through the real control (MurageMain 11-03). One step, and
// only when the choice actually changed: it carries the choice before and after, and they must differ.
export const INPUTS = Object.freeze(["click", "key", "type", "pick"]);
export const OSES = Object.freeze(["darwin", "win32", "linux"]);
export const MODES = Object.freeze(["mouse", "keyboard"]);
export const MAX_AGE_HOURS = 168;
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** 2: steps are owner inputs (MurageMain ruling 11-03), budgets per mode, walks carried for re-judging. */
export const VERDICT_VERSION = 2;

/** The step budget for one job in one input mode, from budgets.json. */
export function budgetFor(budget, mode) {
  const n = budget?.steps?.[mode];
  // null = report only (MurageMain 11-03: keyboard budgets are set in 1.0.18, row TENJOBS-KEYBOARD-APP).
  if (MODES.includes(mode) && n === null) return null;
  if (!MODES.includes(mode) || !Number.isInteger(n) || n < 0) throw new Error(`job ${budget?.id ?? "?"} has no ${mode} step budget`);
  return n;
}

/** The hash a verdict carries of the gate's own files (the paths walked and the budgets). */
export function gateFilesSha256(pathsBytes, budgetsBytes) {
  return createHash("sha256").update(pathsBytes).update(budgetsBytes).digest("hex");
}

const taken = (walk) => (walk?.steps ?? []).filter((s) => STEP_KINDS.includes(s.kind) && s.taken);
const pickOk = (i) => i.input !== "pick" || (typeof i.from === "string" && typeof i.to === "string" && i.from !== i.to);
const inputsOk = (s) => Array.isArray(s.inputs) && s.inputs.length > 0 && s.inputs.every((i) => INPUTS.includes(i?.input) && pickOk(i));

/**
 * The input for a native select choice the rig set through the real control, or null when the
 * choice did not change to the one wanted (then no step is recorded and the step fails).
 */
export function pickInput(before, after, want) {
  if (typeof after !== "string" || after !== want || before === after) return null;
  return { input: "pick", from: typeof before === "string" ? before : "", to: after };
}

/** Each job's path as its optional flags, in order (paths.mjs `optional`): what walkProblem checks a walk against. */
export function pathShapes(paths) {
  return Object.fromEntries(paths.map((p) => [p.id, p.path.map((s) => s.optional === true)]));
}

/**
 * Why a recorded walk is not complete evidence for its path, or null: one record per path step,
 * every record taken, each a real step with inputs, or a skip where the path marks that step optional,
 * and an end check. `shape` is the job's ordered optional flags from pathShapes(PATHS).
 */
export function walkProblem(walk, shape) {
  if (!walk || typeof walk !== "object" || !Array.isArray(walk.steps)) return "walk has no steps";
  if (!Array.isArray(shape) || shape.length < 1 || !shape.every((o) => typeof o === "boolean")) return "no path shape for the job";
  if (walk.steps.length !== shape.length) return `walk has ${walk.steps.length} steps, the path has ${shape.length}`;
  for (const [i, s] of walk.steps.entries()) {
    if (s?.kind === "skipped") {
      if (!shape[i]) return `step ${i + 1} was skipped, the path does not mark it optional`;
      if (!s.taken) return "a skipped step is not marked taken";
      continue;
    }
    if (!STEP_KINDS.includes(s?.kind)) return `walk has a ${s?.kind} record`;
    if (!s.taken) return `step ${s.label ?? "?"} was not taken`;
    if (!inputsOk(s)) return `step ${s.label ?? "?"}: inputs not recorded`;
    if (!s.seen) return `step ${s.label ?? "?"}: not measured`;
  }
  if (!walk.end || typeof walk.end !== "object") return "walk has no end check";
  return null;
}

/** Owner inputs the walk actually made: every click, every key press, one per typed field. */
export function countSteps(walk) {
  return taken(walk).reduce((n, s) => n + (inputsOk(s) ? s.inputs.length : 0), 0);
}

/** Decisions the walk made: steps where the owner picks between options. */
export function countDecisions(walk) {
  return taken(walk).filter((s) => s.decision).length;
}

/**
 * What an owner can see of one element, judged from raw facts the driver read in the
 * page: its box, the window size, the computed opacity and visibility of the element and
 * every ancestor (element first), and hit tests at probe points inside the box
 * (hit: "self" | "inside" | "ancestor" | "other" | "none").
 */
export function judgeSeen(raw) {
  if (!raw) return { seen: { found: false }, point: null };
  const b = raw.rect ?? {}; const vw = raw.vw, vh = raw.vh;
  const inViewport = b.width > 0 && b.height > 0 && b.top < vh - 1 && b.bottom > 1 && b.left < vw - 1 && b.right > 1;
  const chain = Array.isArray(raw.chain) && raw.chain.length ? raw.chain : [{ opacity: "1", visibility: "visible" }];
  const op = (c) => { const n = Number.parseFloat(c?.opacity); return Number.isFinite(n) ? n : 1; };
  const hoverOnly = op(chain[0]) === 0;
  const effective = chain.reduce((p, c) => p * op(c), 1);
  const hidden = !hoverOnly && (effective < 0.05 || chain[0]?.visibility !== "visible" || chain.some((c) => c?.display === "none"));
  const hit = inViewport ? (raw.probes ?? []).find((p) => ["self", "inside", "ancestor"].includes(p?.hit)) : null;
  const covered = inViewport && !hit;
  return {
    seen: { found: true, inViewport, covered, hoverOnly, hidden, disabled: Boolean(raw.disabled) },
    point: hit ? { x: hit.x, y: hit.y } : null,
  };
}

/** Evidence an owner can see: on screen, not hidden, not covered. */
export const seenVisible = (seen) => Boolean(seen?.found && seen.inViewport && !seen.covered && !seen.hoverOnly && !seen.hidden);
/** A target an owner can act on: visible and turned on. */
export const seenActionable = (seen) => seenVisible(seen) && !seen.disabled;

/** Where a job's setup may click: only a target an owner can act on, at its measured visible point. */
export function setupPoint(m, what) {
  if (!seenActionable(m?.seen) || !m?.xy) throw new Error(`setup: ${what} is not on screen for the owner (${JSON.stringify(m?.seen ?? null)})`);
  return m.xy;
}

/**
 * Why a single step needed help, or null. `seen` is what the driver measured
 * before acting: { found, inViewport, covered, hoverOnly, hidden, disabled, unreachable, viaHelp, named }.
 */
export function stepHelpReason(step) {
  const seen = step?.seen;
  if (!seen) return `step ${step?.label ?? "?"}: not measured`;
  if (!seen.found) return `step ${step.label}: target not on screen`;
  if (!seen.inViewport) return `step ${step.label}: target needs scrolling to find`;
  if (seen.hoverOnly) return `step ${step.label}: target shows only on hover`;
  if (seen.hidden) return `step ${step.label}: target is hidden by its parent`;
  if (seen.disabled) return `step ${step.label}: target is turned off (nothing on screen says why)`;
  if (seen.unreachable) return `step ${step.label}: target cannot be reached by keyboard`;
  if (seen.covered) return `step ${step.label}: target is covered by something else`;
  if (seen.viaHelp && !seen.named) return `step ${step.label}: walk had to open help or the palette, the path does not name it`;
  if (step.taken && !inputsOk(step)) return `step ${step.label}: inputs not recorded`;
  return null;
}

/** Judge one job in one mode from its budgets.json entry and the walk the driver recorded. */
export function judgeJob(budget, walk, mode) {
  const stepBudget = budgetFor(budget, mode);
  const steps = countSteps(walk);
  const decisions = countDecisions(walk);
  let reason = null;
  let neededHelp = false;
  for (const s of walk?.steps ?? []) {
    if (!STEP_KINDS.includes(s.kind)) continue;
    const why = stepHelpReason(s);
    if (why) { reason = why; neededHelp = true; break; }
  }
  if (!neededHelp && walk?.error) { reason = `error with no next click: ${String(walk.error).slice(0, 300)}`; neededHelp = true; }
  if (!neededHelp && !walk?.end?.ok) reason = `end not reached: ${walk?.end?.reason ?? "no end check"}`;
  const reportOnly = stepBudget === null;
  if (!reason && !reportOnly && steps > stepBudget) reason = `over budget: ${steps} steps, ${mode} budget ${stepBudget}`;
  if (!reason && decisions > budget.decisions) reason = `over budget: ${decisions} decisions, budget ${budget.decisions}`;
  return {
    id: budget.id, name: budget.name, mode, steps, budget: stepBudget, decisions, decisionBudget: budget.decisions,
    neededHelp, reason, pass: reportOnly ? null : reason === null, ms: walk?.ms ?? null, ...(reportOnly ? { reportOnly: true } : {}),
  };
}

/** The verdict file for one build, one OS, one mode. */
export function buildVerdict({ tree, version, os, mode, jobs, budgets, at = new Date().toISOString(), pathsSha256 = null, engine = null, walks = {} }) {
  const ids = new Set(jobs.map((j) => j.id));
  const missing = budgets.filter((b) => !ids.has(b.id)).map((b) => b.id);
  return {
    gate: "ten-jobs", version: VERDICT_VERSION, tree, appVersion: version ?? null, os, mode, engine, pathsSha256, at,
    pass: missing.length === 0 && jobs.length > 0 && jobs.every((j) => j.pass === true),
    reportOnly: jobs.length > 0 && jobs.every((j) => j.reportOnly === true),
    missingJobs: missing, jobs, walks,
  };
}

/** Shape problems in a verdict (empty list = well formed). */
export function verdictProblems(v) {
  const p = [];
  if (!v || typeof v !== "object") return ["not an object"];
  if (v.gate !== "ten-jobs") p.push("gate is not ten-jobs");
  if (v.version !== VERDICT_VERSION) p.push(`verdict version ${v.version} is not ${VERDICT_VERSION} (the step ruling)`);
  if (!SHA.test(String(v.tree))) p.push("tree is not a full commit sha");
  if (!OSES.includes(v.os)) p.push(`os ${v.os} unknown`);
  if (!MODES.includes(v.mode)) p.push(`mode ${v.mode} unknown`);
  if (typeof v.pass !== "boolean") p.push("pass is not boolean");
  if (Number.isNaN(Date.parse(v.at))) p.push("at is not a date");
  if (!Array.isArray(v.jobs) || v.jobs.length === 0) p.push("no jobs");
  else for (const j of v.jobs) {
    for (const k of ["id", "steps", "budget", "neededHelp", "pass"]) if (!(k in j)) p.push(`job ${j.id ?? "?"} lacks ${k}`);
    if (j.pass && (j.neededHelp || j.steps > j.budget)) p.push(`job ${j.id} says pass but needed help or went over budget`);
  }
  if (v.pass && (v.missingJobs?.length || v.jobs?.some((j) => !j.pass))) p.push("verdict says pass but a job failed or is missing");
  return p;
}

/**
 * Re-judge one verdict against the canonical budgets.json: every budgeted job exactly
 * once, judged again from its recorded walk in the verdict's mode. The verdict's own
 * budget, step counts and pass flags are never trusted. Returns null or why it fails.
 */
export function rejudgeVerdict(v, budgets, pathsSha256, shapes) {
  if (!SHA256.test(String(v?.pathsSha256))) return "verdict has no paths hash";
  if (v.pathsSha256 !== pathsSha256) return "verdict was walked with other paths or budgets than this tree";
  const seen = new Set();
  for (const j of v.jobs) { if (seen.has(j.id)) return `duplicate job ${j.id}`; seen.add(j.id); }
  const known = new Set(budgets.map((b) => b.id));
  const extra = v.jobs.find((j) => !known.has(j.id)); if (extra) return `job ${extra.id} has no budget`;
  const fails = [];
  for (const b of budgets) {
    if (!seen.has(b.id)) return `verdict lacks job ${b.id}`;
    const walk = v.walks?.[b.id] ?? v.walks?.[String(b.id)];
    if (!walk) return `verdict lacks the walk for job ${b.id}`;
    const j = judgeJob(b, walk, v.mode);
    if (j.reportOnly) { fails.push(`job ${b.id} has no ${v.mode} budget`); continue; }
    if (!j.pass) { fails.push(`job ${b.id} ${j.reason}`); continue; }
    // A pass is only as good as its evidence: the walk must cover the whole path with recorded inputs.
    const wp = walkProblem(walk, shapes?.[b.id] ?? shapes?.[String(b.id)]); if (wp) fails.push(`job ${b.id} incomplete walk: ${wp}`);
  }
  return fails.length ? `failed: ${fails.join("; ").slice(0, 400)}` : null;
}

/**
 * The release check: a passing, well-formed verdict for this exact tree on every OS
 * and every mode, none older than maxAgeHours, each re-judged against budgets.json
 * (required) and walked with this tree's paths (pathsSha256, required). No waiver.
 */
/** A mode whose every budget is null is report only: walked and its steps recorded, never passed or failed. */
export function reportOnlyMode(budgets, mode) {
  return Array.isArray(budgets) && budgets.length > 0 && budgets.every((b) => b?.steps?.[mode] === null);
}

export function gateVerdict(verdicts, { tree, now = Date.now(), maxAgeHours = MAX_AGE_HOURS, oses = OSES, modes = MODES, budgets, pathsSha256, pathShapes: shapes } = {}) {
  if (!SHA.test(String(tree))) return { ok: false, reason: `tree ${tree} is not a full commit sha`, legs: [] };
  if (!Array.isArray(budgets) || budgets.length === 0) return { ok: false, reason: "no budgets.json budgets given", legs: [] };
  if (!SHA256.test(String(pathsSha256))) return { ok: false, reason: "no paths hash given for this tree", legs: [] };
  if (!shapes || typeof shapes !== "object") return { ok: false, reason: "no path shapes given for this tree", legs: [] };
  const judged = modes.filter((m) => !reportOnlyMode(budgets, m));
  if (judged.length === 0) return { ok: false, reason: "no mode has budgets to judge", legs: [] };
  const legs = [];
  for (const os of oses) for (const mode of modes) {
    const mine = verdicts.filter((v) => v?.tree === tree && v.os === os && v.mode === mode && verdictProblems(v).length === 0)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const v = mine[0];
    if (!judged.includes(mode)) {
      // Report only: the measured steps per job, no pass or fail.
      // Only a fresh verdict walked with this tree's paths is reported.
      const why = !v ? "no verdict yet" : v.pathsSha256 !== pathsSha256 ? "verdict was walked with other paths or budgets than this tree"
        : Math.abs(now - Date.parse(v.at)) > maxAgeHours * 3600_000 ? `verdict is older than ${maxAgeHours} h` : null;
      const steps = why ? null : Object.fromEntries(budgets.map((b) => [b.id, countSteps(v.walks?.[b.id] ?? v.walks?.[String(b.id)])]));
      legs.push({ os, mode, ok: null, reportOnly: true, why, at: v?.at ?? null, steps });
      continue;
    }
    let why = null;
    if (!v) why = "no verdict for this tree";
    else if (Date.parse(v.at) > now + 5 * 60_000) why = "verdict is dated in the future";
    else if (now - Date.parse(v.at) > maxAgeHours * 3600_000) why = `verdict is older than ${maxAgeHours} h`;
    else why = rejudgeVerdict(v, budgets, pathsSha256, shapes);
    legs.push({ os, mode, ok: why === null, why, at: v?.at ?? null });
  }
  const bad = legs.filter((l) => l.ok === false);
  const reportOnly = modes.filter((m) => !judged.includes(m));
  const note = reportOnly.length ? ` (${reportOnly.join(", ")} report only)` : "";
  return { ok: bad.length === 0, reason: bad.length ? bad.map((l) => `${l.os}/${l.mode}: ${l.why}`).join(" | ") + note : `ten jobs pass on ${legs.length - legs.filter((l) => l.reportOnly).length} legs${note}`, legs };
}
