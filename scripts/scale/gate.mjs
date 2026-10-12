// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The scale gate: judges a rig results file against budgets.json (SCALE-PLAN section 2),
// the growth slope (section 0: turn 500 of a session costs about what turn 10 did), and
// optionally a stored baseline (no p90 more than 15% worse). Exit 1 on any failure.
//
//   node scripts/scale/gate.mjs results.json [--baseline base.json] [--budgets budgets.json] [--md out.md]
//   node scripts/scale/gate.mjs --compare 1.0.1=a.json 1.0.2-int=b.json [--md BASELINE.md]   (table only, exit 0)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

/** Budget verdict for one metric: { pass, observed, why[] }. A missing measurement fails. */
export function judge(results, metric, budgets) {
  if (metric.kind === "slope") return judgeSlope(results, budgets.slope);
  const o = observe(results, metric);
  if (!o) return { pass: false, observed: null, why: ["not measured"] };
  const why = [];
  if (metric.min !== undefined) { if (!(o.value >= metric.min)) why.push(`${o.value} < ${metric.min}`); return { pass: !why.length, observed: o, why }; }
  for (const k of ["p50", "p90", "max"]) if (metric[k] !== undefined && (o[k] === null || o[k] > metric[k])) why.push(`${k} ${o[k]} > ${metric[k]}`);
  return { pass: !why.length, observed: o, why };
}

/** Growth: turn prep at turn 500 against turn 10 of the same resumed session. */
export function judgeSlope(results, rule) {
  const s = get(results, "scenarios.slope");
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

/** Regression against a stored baseline: p90 (or value) more than ratio worse and more than the floor. */
export function regression(results, baseline, metric, rule) {
  if (metric.kind === "slope" || !baseline) return null;
  const now = observe(results, metric), then = observe(baseline, metric);
  if (!now || !then) return null;
  if (metric.min !== undefined) return now.value < then.value - 0.05 ? `${now.value} < baseline ${then.value}` : null;
  const a = now.p90 ?? now.max, b = then.p90 ?? then.max;
  if (a === null || b === null) return null;
  return a > b * rule.ratio && a - b > rule.floorMs ? `p90 ${a} vs baseline ${b} (+${Math.round((a / Math.max(1, b) - 1) * 100)}%)` : null;
}

const fmt = (o, metric) => {
  if (!o) return "n/a";
  if (metric.kind === "slope") return o.t500 === null && o.reached ? `${o.t10 ?? "?"} / ${o.t100 ?? "?"} / not reached (turn ${o.reached}: ${o.last} ms)` : `${o.t10 ?? "?"} / ${o.t100 ?? "?"} / ${o.t500 ?? "?"} ms`;
  if (o.value !== undefined) return String(Math.round(o.value * 100) / 100);
  const u = metric.unit === "cores" ? "" : " ms";
  return metric.p50 === undefined && metric.p90 === undefined ? `max ${o.max}${u}` : `${o.p50} / ${o.p90} / ${o.max}${u}`;
};
export const budgetText = (metric, budgets) => metric.kind === "slope" ? `t500 ≤ ${budgets.slope.maxRatio}× t10`
  : metric.min !== undefined ? `≥ ${metric.min}`
  : [metric.p50 !== undefined && `p50 ${metric.p50}`, metric.p90 !== undefined && `p90 ${metric.p90}`, metric.max !== undefined && `max ${metric.max}`].filter(Boolean).join(", ") + (metric.unit === "cores" ? " cores" : " ms");

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
  const results = JSON.parse(readFileSync(args[0], "utf8"));
  const baseline = opt("--baseline") ? JSON.parse(readFileSync(opt("--baseline"), "utf8")) : undefined;
  const verdict = gate(results, budgets, baseline);
  const md = ["| Scenario | Observed (p50 / p90 / max) | Budget | Result |", "|---|---|---|---|",
    ...verdict.rows.map(r => `| ${r.label} | ${r.observed} | ${r.budget} | ${r.pass ? "pass" : `FAIL: ${r.why.join("; ")}`} |`)].join("\n");
  if (opt("--md")) writeFileSync(opt("--md"), md + "\n");
  console.log(md);
  console.log(verdict.pass ? "SCALE GATE PASS" : `SCALE GATE FAIL (${verdict.rows.filter(r => !r.pass).length} of ${verdict.rows.length})`);
  process.exit(verdict.pass ? 0 : 1);
}
