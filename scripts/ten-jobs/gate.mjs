#!/usr/bin/env node
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The ten-jobs release check: every OS and every budgeted mode need a passing verdict
// for this exact build commit, no older than 168 h, no waiver. A mode with no budgets
// (keyboard in 1.0.17) is report only: its measured steps are printed, never judged.
//   node scripts/ten-jobs/gate.mjs --tree <40-hex sha> [--dir ci/ten-jobs-verdicts] [--report]
// --report prints the result and exits 0 (report mode); without it a failure exits 1.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gateFilesSha256, gateVerdict, pathShapes } from "./core.mjs";
import { PATHS } from "./paths.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const tree = opt("--tree"), dir = opt("--dir", "ci/ten-jobs-verdicts"), report = argv.includes("--report");
const budgetsBytes = readFileSync(new URL("./budgets.json", import.meta.url));
const budgets = JSON.parse(budgetsBytes.toString("utf8")).jobs;
const pathsSha256 = gateFilesSha256(readFileSync(new URL("./paths.mjs", import.meta.url)), budgetsBytes);
const verdicts = [];
let names = [];
try { names = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { /* none yet */ }
for (const f of names) { try { verdicts.push(JSON.parse(readFileSync(join(dir, f), "utf8"))); } catch { console.log(`skipped unreadable ${f}`); } }
const r = gateVerdict(verdicts.filter((v) => v && typeof v === "object" && !v.partial), { tree, budgets, pathsSha256, pathShapes: pathShapes(PATHS) });
for (const l of r.legs) {
  if (l.reportOnly) { console.log(`REPORT ${l.os}/${l.mode} (no pass or fail)${l.steps ? `: steps ${Object.entries(l.steps).map(([id, n]) => `job ${id} ${n}`).join(", ")} (${l.at})` : `: ${l.why}`}`); continue; }
  console.log(`${l.ok ? "ok  " : "FAIL"} ${l.os}/${l.mode}${l.why ? `: ${l.why}` : ` (${l.at})`}`);
}
console.log(`ten-jobs gate: ${r.ok ? "pass" : "fail"}: ${r.reason}${report ? " (report mode)" : ""}`);
process.exit(r.ok || report ? 0 : 1);
