import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const file = "server/highlevel/returned-identities.ts";
const original = readFileSync(file, "utf8");
const line = original.split("\n").find(l => l.includes("// F02_ARRAY_RECURSION"));
if (!line) throw new Error("Missing mutation site");
try {
  writeFileSync(file, original.replace(line, "      // MUTANT: array recursion removed"));
  const run = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "server/highlevel/operations/opportunities.f02.test.ts", "-t", "conflicting", "--maxWorkers=2"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  writeFileSync(".test-tmp/cfix3-hlf2/array-mutant.log", output);
  if (run.status === 0 || run.error || !/AssertionError/u.test(output) || !/array=true/u.test(output)) throw new Error("Array recursion mutant survived or did not reach assertions");
  console.log(`PASS family hook table kills array-recursion mutant, exit ${run.status}`);
} finally { writeFileSync(file, original); }
