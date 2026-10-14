// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The scale gate: judges a rig results file against budgets.json (SCALE-PLAN section 2),
// the growth slope (section 0: turn 500 of a session costs about what turn 10 did), the
// storage rows (STORAGE-AUDIT section 6: table groups as multiples of the messages table,
// measured with dbstat at the end of the run, see storage.mjs), and optionally a stored
// baseline (no p90 more than 15% worse). Exit 1 on any failure.
//
//   node scripts/scale/gate.mjs results.json [--with more.json ...] [--baseline base.json] [--budgets budgets.json] [--md out.md]
//   (--with: another pass of the same tree, e.g. SCALE_REVOKE_INDEX=building; its revoke index state and any scenario
//   the main file lacks are merged in, see mergeResults)
//   node scripts/scale/gate.mjs --compare 1.0.1=a.json 1.0.2-int=b.json [--md BASELINE.md]   (table only, exit 0)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { groupBytes, overlappingTables } from "./storage.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const loadBudgets = (file = join(here, "budgets.json")) => JSON.parse(readFileSync(file, "utf8"));
const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A metric's observed { p50, p90, max } (or { value } for a share), null when missing. */
export function observe(results, metric) {
  if (metric.sum) {
    const parts = metric.sum.map(p => get(results, p));
    if (parts.some(p => !p || num(p.p50) === null)) return null;
    const add = k => parts.reduce((a, p) => a + (num(p[k]) ?? 0), 0);
    return { p50: add("p50"), p90: add("p90"), max: add("max") };
  }
  const v = get(results, metric.path);
  if (v == null) return null;
  if (typeof v === "number") return { value: v };
  if (num(v.p50) === null && num(v.max) === null) return null;
  return { p50: num(v.p50), p90: num(v.p90), max: num(v.max) };
}

/** A rig error on the way to a metric (the scenario, or a part of it, said it measured nothing valid): the first one. */
export function rigError(results, metric) {
  const paths = metric.kind === "slope" ? ["scenarios.slope"] : metric.kind === "storage" ? ["storage"] : metric.sum ?? [metric.path];
  for (const path of paths) {
    const keys = path.split(".");
    for (let i = 2; i <= keys.length; i++) { const e = get(results, keys.slice(0, i).join("."))?.error; if (typeof e === "string" && e) return e; }
  }
  return null;
}
/** The conditions a metric's measurement must have been taken under (budgets.json `requires`): the mismatches. */
export function unmet(results, metric) {
  return Object.entries(metric.requires ?? {}).filter(([path, want]) => get(results, path) !== want).map(([path, want]) => `measured with ${path}=${JSON.stringify(get(results, path) ?? null)}, needs ${JSON.stringify(want)}`);
}

/** Budget verdict for one metric: { pass, observed, why[] }. A missing measurement, a rig error, or a measurement taken
 * under the wrong conditions fails. */
export function judge(results, metric, budgets) {
  const err = rigError(results, metric), wrong = unmet(results, metric);
  const v = metric.kind === "slope" ? judgeSlope(results, budgets.slope) : metric.kind === "storage" ? judgeStorage(results, metric, budgets.storage) : judgeBudget(results, metric);
  const why = [...(err ? [`rig error: ${err}`] : []), ...wrong, ...v.why];
  return { pass: v.pass && !err && !wrong.length, observed: v.observed, why };
}
function judgeBudget(results, metric) {
  const o = observe(results, metric);
  if (!o) return { pass: false, observed: null, why: ["not measured"] };
  const why = [];
  if (metric.atMost !== undefined) { if (!(o.value <= metric.atMost)) why.push(`${o.value} > ${metric.atMost}`); return { pass: !why.length, observed: o, why }; }
  if (metric.min !== undefined) { if (!(o.value >= metric.min)) why.push(`${o.value} < ${metric.min}`); return { pass: !why.length, observed: o, why }; }
  for (const k of ["p50", "p90", "max"]) if (metric[k] !== undefined && (o[k] === null || o[k] > metric[k])) why.push(`${k} ${o[k]} > ${metric[k]}`);
  return { pass: !why.length, observed: o, why };
}

/** Growth: turn prep at turn 500 against turn 10 of the same resumed session, judged only when at least
 * `rule.minResumedShare` of the turns after the first truly resumed it (a share not reported fails too). */
export function judgeSlope(results, rule) {
  const s = get(results, "scenarios.slope");
  const share = num(s?.resumedShare), minShare = rule.minResumedShare ?? 0.9;
  if (s && (share === null || share < minShare)) {
    return { pass: false, observed: { t10: num(s?.turn10?.prep?.p50), t100: num(s?.turn100?.prep?.p50), t500: num(s?.turn500?.prep?.p50), reached: num(s?.reached), resumedShare: share },
      why: [share === null ? "resumed share not reported: the turns are not known to be one resumed session" : `only ${Math.round(share * 100)}% of the turns resumed the session (needs ${Math.round(minShare * 100)}%): not one resumed session`] };
  }
  const t10 = num(s?.turn10?.prep?.p50), t100 = num(s?.turn100?.prep?.p50), t500 = num(s?.turn500?.prep?.p50);
  if (t10 === null || t500 === null) {
    const reached = num(s?.reached), last = num(s?.last?.prep?.p50);
    const why = reached !== null && reached < 500 ? [`turn 500 not reached: ${reached} turns in the time cap, last turns ${last} ms (turn 10 ${t10} ms)`] : ["slope not measured (needs turns 10 and 500)"];
    return { pass: false, observed: { t10, t100, t500, reached, last }, why };
  }
  const limit = Math.max(t10 * rule.maxRatio, t10 + rule.floorMs);
  const why = t500 > limit ? [`turn 500 ${t500} ms > ${Math.round(limit)} ms (turn 10 ${t10} ms)`] : [];
  if ((s.resets ?? 0) > 0) why.push(`${s.resets} session resets: not one resumed session`);
  return { pass: !why.length, observed: { t10, t100, t500, ratio: Math.round((t500 / Math.max(1, t10)) * 100) / 100 }, why };
}

/** One storage row (budgets.json `storage`, STORAGE-AUDIT section 6) against results.storage (storage.mjs measureStorage):
 * `measure` is group:<name> (tables by prefix), live, file, events or slope; `of` is messages (the messages b-tree) or
 * live. dbstat missing, a group listing a table twice, or an empty messages table fails, never passes. */
export function judgeStorage(results, metric, rule = {}) {
  const st = results?.storage;
  if (!st) return { pass: false, observed: null, why: ["storage not measured"] };
  const [kind, name] = String(metric.measure).split(":");
  const needsDbstat = kind === "group" || metric.of === "messages";
  if (needsDbstat && st.error) return { pass: false, observed: null, why: [st.error] };
  if (kind === "slope") {
    const sl = st.slope, minTurns = rule.slopeMinTurns ?? 50, floor = rule.slopeFloorBytes ?? 0;
    if (!sl) return { pass: false, observed: null, why: ["slope storage not measured (the slope scenario did not run)"] };
    if (sl.error) return { pass: false, observed: null, why: [sl.error] };
    const early = sl.early?.perMessage, late = sl.late?.perMessage;
    const observed = { early, late, turns: sl.turns, value: early > 0 && late !== null ? Math.round((late / early) * 100) / 100 : null };
    if (sl.turns < minTurns) return { pass: false, observed, why: [`slope storage: ${sl.turns} turns (needs ${minTurns})`] };
    if (early === null || early === undefined || late === null || late === undefined) return { pass: false, observed, why: ["slope storage: no new messages in the early or late window"] };
    const limit = Math.max(early * metric.max, early + floor);
    return { pass: late <= limit, observed, why: late <= limit ? [] : [`late ${late} B per message > ${Math.round(limit)} B (early ${early} B)`] };
  }
  let bytes;
  if (kind === "group") {
    const prefixes = rule.groups?.[name];
    if (!prefixes) return { pass: false, observed: null, why: [`no group ${name} in budgets.json storage.groups`] };
    const twice = overlappingTables(st.tables, rule.groups);
    if (twice.length) return { pass: false, observed: null, why: [`tables in more than one group: ${twice.join(", ")}`] };
    bytes = groupBytes(st.tables, prefixes);
  } else if (kind === "live") bytes = st.liveBytes;
  else if (kind === "file") bytes = st.fileBytes;
  else if (kind === "events") bytes = st.eventsBytes;
  else return { pass: false, observed: null, why: [`unknown storage measure ${metric.measure}`] };
  if (num(bytes) === null) return { pass: false, observed: null, why: [`${metric.measure} not measured`] };
  if (!metric.of) return { pass: bytes <= metric.max, observed: { value: bytes, bytes }, why: bytes <= metric.max ? [] : [`${bytes} B > ${metric.max} B`] };
  const base = metric.of === "messages" ? st.messagesBytes : metric.of === "live" ? st.liveBytes : null;
  if (!(num(base) > 0)) return { pass: false, observed: { bytes }, why: [`${metric.of} bytes not measured or zero`] };
  const ratio = Math.round((bytes / base) * 1000) / 1000;
  return { pass: ratio <= metric.max, observed: { value: ratio, bytes, base }, why: ratio <= metric.max ? [] : [`${ratio}x ${metric.of} > ${metric.max}x`] };
}

/** Regression against a stored baseline: p90 (or value) more than ratio worse and more than the floor. */
export function regression(results, baseline, metric, rule) {
  if (metric.kind === "slope" || metric.kind === "storage" || !baseline) return null;
  const now = observe(results, metric), then = observe(baseline, metric);
  if (!now || !then) return null;
  if (metric.min !== undefined) return now.value < then.value - 0.05 ? `${now.value} < baseline ${then.value}` : null;
  const a = now.p90 ?? now.max, b = then.p90 ?? then.max;
  if (a === null || b === null) return null;
  return a > b * rule.ratio && a - b > rule.floorMs ? `p90 ${a} vs baseline ${b} (+${Math.round((a / Math.max(1, b) - 1) * 100)}%)` : null;
}

const mb = b => `${Math.round((b / 1048576) * 10) / 10} MB`;
const fmt = (o, metric) => {
  if (!o) return "n/a";
  if (metric.kind === "storage") {
    if (metric.measure === "slope") return o.early === undefined ? "n/a" : `${o.early ?? "?"} → ${o.late ?? "?"} B/message over ${o.turns} turns`;
    if (o.value === undefined) return "n/a";
    return metric.of ? `${o.value}x (${mb(o.bytes)} / ${mb(o.base)})` : mb(o.value);
  }
  if (metric.kind === "slope") return o.t500 === null && o.reached ? `${o.t10 ?? "?"} / ${o.t100 ?? "?"} / not reached (turn ${o.reached}: ${o.last} ms)` : `${o.t10 ?? "?"} / ${o.t100 ?? "?"} / ${o.t500 ?? "?"} ms`;
  if (o.value !== undefined) return String(Math.round(o.value * 100) / 100);
  const u = metric.unit === "cores" ? "" : " ms";
  return metric.p50 === undefined && metric.p90 === undefined ? `max ${o.max}${u}` : `${o.p50} / ${o.p90} / ${o.max}${u}`;
};
export const budgetText = (metric, budgets) => metric.kind === "slope" ? `t500 ≤ ${budgets.slope.maxRatio}× t10`
  : metric.kind === "storage" ? (metric.measure === "slope" ? `late ≤ ${metric.max}× early B/message` : metric.of ? `≤ ${metric.max}× ${metric.of}` : `≤ ${mb(metric.max)}`)
  : metric.atMost !== undefined ? `≤ ${metric.atMost}`
  : metric.min !== undefined ? `≥ ${metric.min}`
  : [metric.p50 !== undefined && `p50 ${metric.p50}`, metric.p90 !== undefined && `p90 ${metric.p90}`, metric.max !== undefined && `max ${metric.max}`].filter(Boolean).join(", ") + (metric.unit === "cores" ? " cores" : " ms");

/** Merge other passes of the same tree into the main results: each revoke index state the main file did not measure,
 * and every scenario it lacks. The main file's own measurements always win. */
export function mergeResults(main, extras = []) {
  const out = { ...main, scenarios: { ...main.scenarios } };
  for (const extra of extras) {
    for (const [name, sc] of Object.entries(extra.scenarios ?? {})) {
      if (name === "revoke" && out.scenarios.revoke) {
        const mine = out.scenarios.revoke.byState ?? {}, theirs = sc.byState ?? {};
        const byState = { ...mine };
        for (const [state, v] of Object.entries(theirs)) if (!mine[state] || (mine[state].error && !v.error)) byState[state] = { ...v, from: extra.label ?? "extra" };
        out.scenarios.revoke = { ...out.scenarios.revoke, byState };
      } else if (!(name in out.scenarios)) out.scenarios[name] = { ...sc, from: extra.label ?? "extra" };
    }
  }
  return out;
}

/** The budgets of one scenario only (a run that measures just that scenario, e.g. the post-upgrade chat on an unprimed data dir). */
export function onlyScenario(budgets, name) {
  const mine = metric => (metric.sum ?? [metric.path]).every(path => path?.startsWith(`scenarios.${name}.`));
  return { ...budgets, metrics: budgets.metrics.filter(mine) };
}
/** The results of a run with the scenarios another run measured added (the post-upgrade chat needs its own unprimed run). A scenario
 * the main run measured is never replaced. */
export function withScenarios(results, extra) {
  return { ...results, scenarios: { ...extra?.scenarios, ...results.scenarios } };
}

export function gate(results, budgets, baseline) {
  const rows = budgets.metrics.map(metric => {
    const v = judge(results, metric, budgets);
    const reg = regression(results, baseline, metric, budgets.regression);
    return { id: metric.id, label: metric.label, observed: fmt(v.observed, metric), budget: budgetText(metric, budgets), pass: v.pass && !reg, why: [...v.why, ...(reg ? [`regression: ${reg}`] : [])] };
  });
  return { pass: rows.every(r => r.pass), rows };
}

export function table(columns, budgets) {
  const head = `| Scenario | ${columns.map(c => c.name).join(" | ")} | Budget | Pass/fail (${columns.map(c => c.name).join(" / ")}) |`;
  const sep = `|${"---|".repeat(columns.length + 3)}`;
  const lines = budgets.metrics.map(metric => {
    const cells = columns.map(c => { const v = judge(c.results, metric, budgets); return { text: fmt(v.observed, metric), pass: v.pass }; });
    return `| ${metric.label} | ${cells.map(c => c.text).join(" | ")} | ${budgetText(metric, budgets)} | ${cells.map(c => (c.pass ? "pass" : "FAIL")).join(" / ")} |`;
  });
  return [head, sep, ...lines].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const budgets = loadBudgets(opt("--budgets"));
  if (args[0] === "--compare") {
    const columns = args.slice(1).filter(a => a.includes("=") && !a.startsWith("--")).map(a => { const [name, file] = a.split("="); return { name, results: JSON.parse(readFileSync(file, "utf8")) }; });
    const md = table(columns, budgets);
    if (opt("--md")) writeFileSync(opt("--md"), md + "\n");
    console.log(md);
    process.exit(0);
  }
  const extras = args.flatMap((a, i) => (a === "--with" ? [JSON.parse(readFileSync(args[i + 1], "utf8"))] : []));
  let results = mergeResults(JSON.parse(readFileSync(args[0], "utf8")), extras);
  if (opt("--also")) results = withScenarios(results, JSON.parse(readFileSync(opt("--also"), "utf8")));
  if (opt("--only")) budgets.metrics = onlyScenario(budgets, opt("--only")).metrics;
  const baseline = opt("--baseline") ? JSON.parse(readFileSync(opt("--baseline"), "utf8")) : undefined;
  const verdict = gate(results, budgets, baseline);
  const md = ["| Scenario | Observed (p50 / p90 / max) | Budget | Result |", "|---|---|---|---|",
    ...verdict.rows.map(r => `| ${r.label} | ${r.observed} | ${r.budget} | ${r.pass ? "pass" : `FAIL: ${r.why.join("; ")}`} |`)].join("\n");
  if (opt("--md")) writeFileSync(opt("--md"), md + "\n");
  console.log(md);
  console.log(verdict.pass ? "SCALE GATE PASS" : `SCALE GATE FAIL (${verdict.rows.filter(r => !r.pass).length} of ${verdict.rows.length})`);
  process.exit(verdict.pass ? 0 : 1);
}
