// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The smoothness gate's judge (SMOOTHNESS-GATE-105 section 4): every row of budgets.json against a results file, one
// table, exit 1 on any FAIL. With --loaded the loaded run is judged too (latency rows get the loaded factor) and the
// verdict covers both; the release gate (scripts/release-ci-gate.mjs smoothnessVerdict) accepts only a verdict with both.
//
//   node scripts/smoothness/smooth-gate.mjs results.json [--loaded results-load.json] [--budgets budgets.json] [--md out.md] [--verdict ci/smoothness-verdicts/<tree>.json]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, judge, rssPeakLine, table, verdictOf } from "./smooth-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const loadBudgets = (file = join(here, "budgets.json")) => JSON.parse(readFileSync(file, "utf8"));

/** ALL.eld and ALL.eld250 under both rules (SMOOTH-RIG-RESTART-GAP), so the old number is never hidden. */
export function eldBothLine(results) {
  const e = results?.all?.eld; if (!e?.raw) return null;
  const gaps = (e.restarts ?? []).map(r => `${r.gapMs} ms`).join(", ") || "none";
  const warm = (e.excludedWindows ?? []).map(w => `${w.from}..${w.to}`).join(", ");
  return `ALL.eld (${results.label ?? "run"}): fixed max ${e.max} ms, ${e.secondsOver250} s over 250 ms; raw (old rule, restart gaps counted) max ${e.raw.max} ms, ${e.raw.secondsOver250} s over 250 ms; restart gaps left out: ${gaps}${warm ? `; WARM windows and their straddling sample left out: ${warm} (included in raw)` : ""}`;
}

/** Display only: these rows never enter budgets, judged row counts, or the release verdict. */
export function measurementInfoRows(results) {
  const rows = [];
  const mark = results?.firstSend;
  rows.push({ id: "ALL.first_send", scenario: "all", what: "first send attempt",
    value: mark ? `epochMs=${mark.epochMs}; delayMs=${results.firstSendDelayMs}; runId=${mark.runId}; requestId=${mark.requestId}; logByteOffset=${mark.logByteOffset}` : "not measured (no send)" });
  const old = results?.all?.eldFromRunStart;
  for (const [id, key] of [["ALL.eld_from_run_start", "max"], ["ALL.eld250_from_run_start", "secondsOver250"]]) {
    rows.push({ id, scenario: "all", what: "ELD from run start",
      value: old?.[key] ?? "not measured" });
  }
  if (results?.mode === "packaged") {
    const h = results.scenarios?.bootWarm?.healthy;
    const value = h?.n > 0 ? `n=${h.n}, p50=${h.p50} ms, p90=${h.p90} ms, max=${h.max} ms` : "not measured";
    const m = results.scenarios?.bootWarm?.measurements, w = results.scenarios?.bootWarm?.window;
    const measured = m ? `; window=${w?.from}..${w?.to}; ELD max=${m.eld?.max ?? "not measured"} ms, over250=${m.eld?.secondsOver250 ?? "not measured"}; io=${m.ioBudget ?? "not measured"} (overlapping minute=${m.ioOverlap ?? 0}); CPU p90=${m.cpu?.p90 ?? "not measured"} cores; RSS max=${m.rssMb?.max ?? "not measured"} MB` : "";
    rows.push({ id: "S0.warm", scenario: "boot", what: "WARM boot to /api/health",
      value: value + measured + (results.compileCache?.filesAfterCold === 0 ? "; cache did not fill; not a warm boot" : "") });
  }
  const w = results?.scenarios?.room?.workerSliceWall;
  rows.push({ id: "S3.workerSliceWall", scenario: "room", what: "memory.indexSlice wall incl commit",
    value: w?.count > 0 ? `count=${w.count}, max=${w.max} ms, p99=${w.p99} ms; rowMs max=${w.rowMsMax} ms` : "not measured" });
  const cards = results?.scenarios?.room?.cardRows;
  rows.push({ id: "S3.cardWait", scenario: "room", what: "owner card wait",
    value: Array.isArray(cards) ? `${cards.reduce((sum, card) => sum + (card.waitMs ?? 0), 0)} ms; ${cards.length} cards` : "not measured" });
  const room = results?.scenarios?.room, drain = room?.drain;
  rows.push({ id: "S3.drain", scenario: "room", what: "room drain and settlement",
    value: Array.isArray(drain?.rounds) ? `rounds=${drain.rounds.join(",")}; tail=${drain.tail}; measured DONE=${drain.done}; final DONE=${room.done === true}; incomplete=${room.incomplete === true}; settlement=${room.settlement?.settled ?? "not needed"}`
      : room && typeof room.done === "boolean" ? `DONE=${room.done}; incomplete=${room.incomplete === true}; settlement=${room.settlement?.settled ?? "not needed"}` : "not measured" });
  return rows;
}

/** Judge one or two results files; returns { idle, loaded, verdict, md, exit }. */
/** The two legs of a release verdict must be two different runs of ONE tree, the first idle and the second recorded as loaded by the rig itself. */
export function pairInvalid(idle, loaded) {
  if (!loaded) return null;
  if (idle?.load === true) return "the idle result records load";
  if (loaded.load !== true) return "the loaded result does not record load";
  if (typeof idle?.tree !== "string" || !idle.tree || idle.tree !== loaded.tree) return `the two results are not the same tree (${idle?.tree ?? "missing"} vs ${loaded.tree ?? "missing"})`;
  if (typeof idle.runId !== "string" || !idle.runId || typeof loaded.runId !== "string" || !loaded.runId) return "a result has no run id";
  if (idle.runId === loaded.runId) return "the two results are the same run";
  return null;
}
export function gate({ idle, loaded, budgets, expectedRunId }) {
  const opts = {};
  const bad = pairInvalid(idle, loaded);
  const checked = results => {
    const result = judge(budgets, results, opts);
    if (bad) return { ...result, pass: false, invalid: result.invalid ?? bad };
    return expectedRunId && results.runId !== expectedRunId
      ? { ...result, pass: false, invalid: `run id mismatch: expected ${expectedRunId}, found ${results.runId ?? "missing"}` } : result;
  };
  const i = checked(idle);
  const l = loaded ? checked({ ...loaded }) : null;
  const tree = idle.tree ?? loaded?.tree ?? null;
  const verdict = verdictOf({ tree, idle: { ...i, engines: idle.engines }, loaded: l, engines: idle.engines });
  const md = [table(i, `Smoothness gate: ${idle.label ?? "idle run"} (tree ${tree ?? "?"}, engines ${idle.engines ?? "fake"}${idle.load ? ", LOADED" : ""})`, measurementInfoRows(idle)), ...(l ? ["", table(l, `Smoothness gate: ${loaded.label ?? "loaded run"} (80% foreign CPU; same limits)`, measurementInfoRows(loaded))] : [])].join("\n");
  const notes = [...(idle.notes ?? []), ...(loaded?.notes ?? [])];
  const md2 = [md, ...[idle, loaded].filter(Boolean).map(eldBothLine).filter(Boolean), ...[idle, loaded].filter(Boolean).map(rssPeakLine).filter(Boolean)].join("\n\n");
  return { idle: i, loaded: l, verdict, md: notes.length ? `${md2}\n\nNotes: ${notes.length} (see the results files)` : md2, exit: i.pass && (l === null || l.pass) ? 0 : 1 };
}

// The script-entry check must hold on Windows too: there argv[1] is "C:\...\smooth-gate.mjs" while import.meta.url is
// "file:///C:/.../smooth-gate.mjs", so a "file://" + argv[1] compare never matched and the judge silently exited 0.
if (isMainModule(import.meta.url, process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = n => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : undefined; };
  const file = args.find(a => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);
  if (!file) { console.error("usage: smooth-gate.mjs results.json [--loaded results-load.json] [--budgets b.json] [--md out.md] [--verdict out.json]"); process.exit(2); }
  const idle = JSON.parse(readFileSync(file, "utf8"));
  const loaded = opt("--loaded") ? JSON.parse(readFileSync(opt("--loaded"), "utf8")) : null;
  const out = gate({ idle, loaded, budgets: loadBudgets(opt("--budgets")), expectedRunId: process.env.SMOOTH_RUN_ID });
  console.log(out.md);
  if (opt("--md")) writeFileSync(opt("--md"), out.md + "\n");
  if (opt("--verdict")) { mkdirSync(dirname(opt("--verdict")), { recursive: true }); writeFileSync(opt("--verdict"), JSON.stringify(out.verdict, null, 1) + "\n"); }
  if (!loaded) console.log("\n(no --loaded run: the verdict cannot pass the release gate until the loaded run is judged with it)");
  process.exit(out.exit);
}
