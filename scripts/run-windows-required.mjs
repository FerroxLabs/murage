// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs every row of ci/WINDOWS-REQUIRED.txt on native Windows and fails unless each named test PASSED (skipped, missing or failed all fail).
// Usage: node scripts/run-windows-required.mjs [--list]   Exit codes: 0 all passed, 1 a row did not pass, 2 not Windows (FAIL windows-required).
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rows = readFileSync(new URL("../ci/WINDOWS-REQUIRED.txt", import.meta.url), "utf8").split("\n").filter(l => l && !l.startsWith("#")).map(l => { const [file, os, name, mutants] = l.split("\t"); return { file, os, name, mutants }; });
if (process.argv.includes("--list")) { for (const r of rows) console.log(`${r.file}\t${r.name}\t${r.mutants}`); process.exit(0); }
if (process.platform !== "win32") { console.error("FAIL windows-required"); process.exit(2); }
let bad = 0;
for (const r of rows) {
  const dir = mkdtempSync(join(tmpdir(), "winreq-")), out = join(dir, "r.json");
  const run = spawnSync(process.execPath, [join("node_modules", "vitest", "vitest.mjs"), "run", r.file, "-t", r.name, "--reporter=json", `--outputFile=${out}`], { stdio: "inherit" });
  let status = "missing", message = "";
  try {
    const j = JSON.parse(readFileSync(out, "utf8"));
    const hits = j.testResults.flatMap(f => f.assertionResults).filter(a => a.title.startsWith(r.name));
    message = hits.flatMap(a => a.failureMessages || []).join(" ").replace(/\s+/g, " ").slice(0, 300);
    status = hits.length ? (hits.every(a => a.status === "passed") ? "passed" : hits.map(a => a.status).join(",")) : "missing";
  } catch { /* no result file */ }
  rmSync(dir, { recursive: true, force: true });
  console.log(`${status === "passed" ? "PASS" : "FAIL"} ${r.name} (${status}, vitest exit ${run.status})${message ? " MESSAGE: " + message : ""}`);
  if (status !== "passed") bad++;
}
process.exit(bad ? 1 : 0);
