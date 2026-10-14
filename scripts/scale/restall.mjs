// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Recompute the event-loop stall numbers of a results file from its server log, counting a blocked
// loop by the gap between two one-second [eld] lines (rig.mjs does this itself since it learned to;
// this repairs results from a run that only read the histogram, which reports 0 across a long block).
//   node restall.mjs results.json server-run.log [gate.log]   (rewrites results.json; prints a summary)
// Scenario windows come from results (window) or from the gate log's "scenario X start/done" lines.
import { readFileSync, writeFileSync } from "node:fs";
import { stats } from "./stats.mjs";

const [resultsFile, serverLog, gateLog] = process.argv.slice(2);
const results = JSON.parse(readFileSync(resultsFile, "utf8"));
const lines = [...readFileSync(serverLog, "utf8").matchAll(/\[eld\] t=(\d+) p50=[\d.]+ p99=[\d.]+ max=([\d.]+)/g)].map(m => ({ t: +m[1], max: +m[2] }));
const stalls = lines.map((r, i) => ({ t: r.t, stall: Math.max(r.max, i ? r.t - lines[i - 1].t - 1000 : 0) }));
const window = (from, to) => { const rows = stalls.filter(r => r.t >= from && r.t <= to); return { ...stats(rows.map(r => r.stall)), secondsOver100: rows.filter(r => r.stall > 100).length, secondsOver250: rows.filter(r => r.stall > 250).length }; };

const windows = {};
if (gateLog) {
  const day = new Date(results.startedAt ?? Date.now()).toISOString().slice(0, 10);
  const at = hms => Date.parse(`${day}T${hms}Z`);
  for (const m of readFileSync(gateLog, "utf8").matchAll(/\[rig \S+ (\d\d:\d\d:\d\d)\] scenario (\w+) (start|done)/g)) {
    (windows[m[2]] ??= {})[m[3] === "start" ? "from" : "to"] = at(m[1]) + (m[3] === "done" ? 999 : 0);
  }
}
for (const [name, scenario] of Object.entries(results.scenarios ?? {})) {
  const w = scenario.window ?? windows[name];
  if (w?.from && w?.to) scenario.eld = window(w.from, w.to);
}
// A turn the old rig ended on an earlier turn's trace line has no prep of its own: leave it out of turn prep.
const tp = results.scenarios?.turnPrep;
if (Array.isArray(tp?.turns)) {
  const own = tp.turns.filter(t => Number.isFinite(t.prep));
  if (own.length !== tp.turns.length) Object.assign(tp, { prep: stats(own.map(t => t.prep)), firstText: stats(own.map(t => t.firstText)), wall: stats(own.map(t => t.wall)), misattributed: tp.turns.length - own.length });
}
results.eldAll = window(Date.parse(results.startedAt ?? 0) || 0, Date.parse(results.finishedAt ?? "") || Number.MAX_SAFE_INTEGER);
results.notes = [...(results.notes ?? []), "event-loop stalls recomputed from the server log with gaps between [eld] lines counted (restall.mjs)"];
writeFileSync(resultsFile, JSON.stringify(results, null, 1));
console.log("RESTALL " + JSON.stringify({ eldAll: results.eldAll, turnPrep: results.scenarios?.turnPrep?.eld }));
