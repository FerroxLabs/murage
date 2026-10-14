// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reads the PERF json lines the memory timing test wrote (server/memory/memory-perf.test.ts) and fails the
// nightly job when a budget is missed or a figure is more than 20 percent worse than the previous night's.
// A failure prints the span breakdown, so the person looking sees where the time went without re-running.
//
// usage: node scripts/memory-perf-compare.mjs <results.jsonl> [previous.jsonl]
import { existsSync, readFileSync } from "node:fs";

const [current, previous] = process.argv.slice(2);
if (!current || !existsSync(current)) { console.error("no results file"); process.exit(2); }
const read = file => Object.fromEntries(readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).map(row => [row.name, row]));
const now = read(current), before = previous && existsSync(previous) ? read(previous) : {};

/** Budgets from PROPOSAL-v2 section 10.7. `get` reads the figure out of a result row. */
const BUDGETS = [
  { name: "turn.main-thread", label: "memory before engine send, fresh session, p95 ms (target 250 less 30 unattributed)", get: row => row.fresh.p95, max: 220 },
  { name: "turn.main-thread", label: "memory before engine send, resumed session, p95 ms", get: row => row.resumed.p95, max: 220 },
  { name: "drain", label: "searches unavailable under a backlog", get: row => row.unavailable, max: 0 },
  { name: "drain", label: "longest event-loop delay in the drain, ms", get: row => row.loopMs.max, max: 200 },
  { name: "drain", label: "write-ahead log high-water, MB", get: row => row.walMaxMb, max: 128 },
  { name: "drain", label: "search p95 under a backlog, ms", get: row => row.searchMs.p95, max: 120 },
];
const failures = [];
for (const budget of BUDGETS) {
  const row = now[budget.name];
  if (!row) { failures.push(`${budget.label}: no measurement`); continue; }
  const value = budget.get(row), old = before[budget.name] ? budget.get(before[budget.name]) : undefined;
  const verdict = value > budget.max ? `OVER ${budget.max}` : old !== undefined && old > 0 && value > old * 1.2 && value - old > 5 ? `REGRESSED from ${old}` : "ok";
  console.log(`${verdict === "ok" ? "  " : "!!"} ${budget.label}: ${value}${old === undefined ? "" : ` (previous ${old})`} ${verdict === "ok" ? "" : verdict}`);
  if (verdict !== "ok") failures.push(`${budget.label}: ${value} ${verdict}`);
}
if (failures.length) {
  console.log("\nSpan breakdown:");
  for (const name of ["turn.fresh", "turn.resumed"]) if (now[name]) console.log(name, JSON.stringify(now[name].steps, null, 1));
  if (now.drain) console.log("drain", JSON.stringify(now.drain));
  console.error(`\n${failures.length} timing gate(s) failed:\n${failures.join("\n")}`);
  process.exit(1);
}
