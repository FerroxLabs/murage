// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs every row of ci/WINDOWS-REQUIRED.txt on native Windows. A row passes only if ALL hold: vitest exited 0 without a signal or spawn error, the
// JSON report exists and parses, it holds no failed test, failed suite, failed file, unhandled error or `success: false`, and the named witness
// ran and PASSED (skipped, todo, missing or failed all fail). Judging by the named assertions alone let a failing hook or an unhandled error pass.
// Usage: node scripts/run-windows-required.mjs [--list]   Exit codes: 0 all passed, 1 a row did not pass, 2 not Windows (FAIL windows-required).
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseRows(text) {
  return text.split("\n").filter(l => l && !l.startsWith("#")).map(l => { const [file, os, name, mutants] = l.split("\t"); return { file, os, name, mutants }; });
}

/** Judge one vitest run. `run` is { status, signal, error }, `reportText` the JSON report file's text (undefined when absent). Returns { ok, status, reasons, message }. */
export function judgeRun(row, run, reportText) {
  const reasons = [];
  let report = null, hits = [], message = "";
  if (run.error) reasons.push(`spawn error: ${run.error.message ?? run.error}`);
  if (run.signal) reasons.push(`killed by signal ${run.signal}`);
  if (run.status !== 0) reasons.push(`nonzero vitest exit ${run.status}`);
  try { report = JSON.parse(reportText); } catch { /* handled below */ }
  if (!Array.isArray(report?.testResults)) reasons.push("no readable vitest report");
  else {
    const files = report.testResults;
    if (report.success === false) reasons.push("report success is false");
    if (report.numFailedTests > 0) reasons.push(`${report.numFailedTests} failed test(s)`);
    if (report.numFailedTestSuites > 0) reasons.push(`${report.numFailedTestSuites} failed suite(s)`);
    if (files.some(f => f.status === "failed")) reasons.push("a test file failed");
    if (files.some(f => f.assertionResults?.some(a => a.status === "failed"))) reasons.push("a test failed");
    const unhandled = Object.entries(report).filter(([k, v]) => /unhandled/i.test(k) && (Array.isArray(v) ? v.length > 0 : Boolean(v)));
    if (unhandled.length) reasons.push(`unhandled error(s) in report (${unhandled.map(([k]) => k).join(",")})`);
    hits = files.flatMap(f => f.assertionResults ?? []).filter(a => typeof a.title === "string" && a.title.startsWith(row.name));
    message = files.flatMap(f => [f.message, ...(f.assertionResults ?? []).flatMap(a => a.failureMessages ?? [])]).filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 300);
    if (!hits.length) reasons.push(`required witness ${row.name} is missing`);
    else if (!hits.every(a => a.status === "passed")) reasons.push(`required witness ${row.name} is ${hits.map(a => a.status).join(",")}`);
  }
  const ok = reasons.length === 0;
  return { ok, status: ok ? "passed" : reasons.join("; "), reasons, message };
}

/** Run every row through `spawn(row, outFile)` (default: vitest) and return the process exit code. `log` receives the PASS/FAIL lines. */
export function runRows(rows, { spawn, readReport, log = console.log }) {
  let bad = 0;
  for (const r of rows) {
    const dir = mkdtempSync(join(tmpdir(), "winreq-")), out = join(dir, "r.json");
    let run;
    try { run = spawn(r, out); } catch (error) { run = { status: null, signal: null, error }; }
    let text;
    try { text = readReport(out); } catch { /* no result file */ }
    rmSync(dir, { recursive: true, force: true });
    const j = judgeRun(r, run, text);
    log(`${j.ok ? "PASS" : "FAIL"} ${r.name} (${j.status}, vitest exit ${run.status})${j.message ? " MESSAGE: " + j.message : ""}`);
    if (!j.ok) bad++;
  }
  return bad ? 1 : 0;
}

const vitestSpawn = (r, out) => spawnSync(process.execPath, [join("node_modules", "vitest", "vitest.mjs"), "run", r.file, "-t", r.name, "--reporter=json", `--outputFile=${out}`], { stdio: "inherit" });

export function main(argv, platform = process.platform, deps = { spawn: vitestSpawn, readReport: p => readFileSync(p, "utf8") }) {
  const rows = parseRows(readFileSync(new URL("../ci/WINDOWS-REQUIRED.txt", import.meta.url), "utf8"));
  if (argv.includes("--list")) { for (const r of rows) console.log(`${r.file}\t${r.name}\t${r.mutants}`); return 0; }
  if (platform !== "win32") { console.error("FAIL windows-required"); return 2; }
  return runRows(rows, deps);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) process.exit(main(process.argv.slice(2)));
