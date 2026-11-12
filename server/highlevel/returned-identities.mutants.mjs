// Run in an isolated test checkout/container, never against a live app.
// node server/highlevel/returned-identities.mutants.mjs <evidence-directory>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const directory = process.argv[2];
if (!directory) throw new Error("An evidence directory is required");
mkdirSync(directory, { recursive: true });
const file = "server/highlevel/returned-identities.ts";
const original = readFileSync(file, "utf8");
for (const [name, marker, filter, witness] of [
  ["slot", "// F021_APPROVED_SLOT", "F021 P1 generated slots", "swapped"],
  ["array", "// F02_ARRAY_RECURSION", "generated conflict", "array=true"],
]) {
  const line = original.split("\n").find(line => line.includes(marker));
  if (!line) throw new Error(`Missing mutation site: ${name}`);
  try {
    writeFileSync(file, original.replace(line, `    // MUTANT: ${name} check removed`));
    const report = join(directory, `${name}-mutant.json`);
    const run = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "server/highlevel/returned-identities.test.ts", "-t", filter, "--reporter=json", `--outputFile=${report}`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    writeFileSync(join(directory, `${name}-mutant.log`), `${run.stdout ?? ""}${run.stderr ?? ""}`);
    writeFileSync(join(directory, `${name}-mutant.rc`), `${run.status}\n`);
    if (run.error || run.status !== 1) throw new Error(`${name} mutant survived or failed to run`);
    const results = JSON.parse(readFileSync(report, "utf8"));
    const failed = results.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === "failed");
    if (!failed.some(test => test.fullName.includes(witness) && test.failureMessages.some(message => message.includes("AssertionError")))) throw new Error(`${name} mutant did not reach the required assertions`);
    console.log(`PASS: ${name} mutant killed: ${failed.length} assertions RED`);
  } finally {
    writeFileSync(file, original);
  }
}
