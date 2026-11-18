/** Run only in the isolated test container, from the repo root. Fakes only.
 * Mutation targets are new S9 files; restore them even on a failed run.
 * Usage: node scripts/probes/native-deny/profile-mutants.mjs <report-directory>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const report = resolve(process.argv[2] || ".native-deny-mutant-evidence");
if (report === "/dev" || report.startsWith("/dev/")) throw new Error("report must be in the job directory");
mkdirSync(report, { recursive: true });
const p = "server/native-deny/profile.ts";
const r = "server/native-deny/registry.ts";
const originals = new Map([p, r].map(file => [file, readFileSync(file, "utf8")]));
const mutants = [
  ["M2", p, 'input.level !== "no-limits"', 'false'],
  ["M4", p, 'if (!matchProbeRegistry(committedProbes, {', 'if (false && !matchProbeRegistry(committedProbes, {'],
  ["M9", p, 'if (!matchProbeRegistry(committedProbes, {', 'if (input.engine !== "codex" && !matchProbeRegistry(committedProbes, {'],
  ["M15", p, 'if (input.launchMode.shellMode !== "murage-exec")', 'if (false)'],
  ["M16", p, 'if (input.uid === null || input.uid === 0)', 'if (input.uid === null || (input.uid === 0 && process.env.IS_SANDBOX !== "1"))'],
  ["M18", r, 'row[key] === tuple[key]', '(key === "version" ? row[key] <= tuple[key] : row[key] === tuple[key])'],
  ["M21", p, 'input.level !== "no-limits"', '(input.engine !== "grok" && input.level !== "no-limits")'],
  ["M22", p, 'input.level !== "no-limits"', '(input.engine !== "pi" && input.level !== "no-limits")'],
  ["M28", p, 'input.initiator !== "owner" && !(', 'input.initiator !== "owner" && input.initiator !== "routine" && !('],
];
for (const key of ["readerRev", "adapterRev", "clientRev", "protocolRev", "integrityRev", "configRev"]) {
  mutants.push([`A13-${key}`, r, 'row[key] === tuple[key]', `(key === "${key}" || row[key] === tuple[key])`]);
}
mutants.push(["A13-duplicates", r, 'if (new Set(identities).size !== rows.length) return false;', 'if (false) return false;']);
mutants.push(["A13-metadata", p, 'shellMode: input.launchMode.shellMode,', 'shellMode: input.launchMode.shellMode, ...controls.revisions,']);
const results = [];
try {
  for (const [id, file, from, to] of mutants) {
    const source = originals.get(file);
    if (source.split(from).length !== 2) throw new Error(`${id}: mutation target must occur exactly once`);
    writeFileSync(file, source.replace(from, to));
    const run = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "server/native-deny/profile.test.ts"], {
      encoding: "utf8", timeout: 180_000, maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    const output = `${run.stdout || ""}\n${run.stderr || ""}`;
    writeFileSync(resolve(report, `${id}.log`), output);
    // Import, timeout and syntax failures do not count as killed mutants.
    const killed = run.status !== null && run.status !== 0 && /Tests\s+\d+ failed/.test(output);
    const result = { mutant: id, killed, exitCode: run.status, testSummary: output.match(/Tests[^\n]+/)?.[0] || "no assertion result" };
    results.push(result);
    console.log(JSON.stringify(result));
    writeFileSync(file, source);
  }
} finally {
  for (const [file, source] of originals) writeFileSync(file, source);
  writeFileSync(resolve(report, "summary.json"), JSON.stringify(results, null, 2) + "\n");
}
if (results.length !== mutants.length || results.some(r => !r.killed)) process.exitCode = 1;
