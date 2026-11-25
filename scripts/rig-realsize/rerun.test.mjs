// Owner: rig-realsize lane. Witness for ASTRA 1492 / OPUS 1497: a second run that fails early must never yield GREEN.
// At 1cb5223910 the rig wrote every run straight into RIG_OUT, so a run that failed before writing its evidence (exit 2) left
// the previous run's files in place, and the documented replay of that dir read them and said GREEN, exit 0. Now each run
// writes only into RIG_OUT/<RIG_RUN_ID>, a dir it creates, and seals it last; a replay names the run id and reads only that
// sealed dir. This drives the real rig.mts (its real start, failure path and exit code) with the server launch replaced by a
// stub that fails at once, the earliest failure a run can have, and then the real replay CLI.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, expect, it } from "vitest";
import { writeCleanRun } from "./fixture.mjs";
import * as V from "./verdict.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "rig-rerun-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// the server launch (scripts/control-murage.ts) is the only thing replaced: it fails the way a server that never came up does
const stub = join(scratch, "server-stub.mjs");
writeFileSync(stub, `export async function launchVerificationServer() { throw new Error("rig rerun witness: the server did not start"); }\n`);
const hooks = join(scratch, "hooks.mjs");
writeFileSync(hooks, `export async function resolve(specifier, context, next) {
  if (specifier.endsWith("/control-murage.ts")) return { url: ${JSON.stringify(pathToFileURL(stub).href)}, shortCircuit: true };
  return next(specifier, context);
}\n`);
const register = join(scratch, "register.mjs");
writeFileSync(register, `import { register } from "node:module"; register(${JSON.stringify(pathToFileURL(hooks).href)});\n`);

/** One real rig run into the evidence root, failing at its first step. */
function rigRun(root, runId) {
  const env = { ...process.env, RIG_OUT: root, RIG_RUN_ID: runId, RIG_LOAD_CPU: "0", RIG_LOAD_IO: "0" };
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--import", pathToFileURL(register).href, join(HERE, "rig.mts")],
    { env, cwd: scratch, encoding: "utf8", timeout: 60_000 });
  return { exit: run.status, out: `${run.stdout}${run.stderr}` };
}
/** The documented replay of a run. */
function replay(...args) {
  const run = spawnSync(process.execPath, [join(HERE, "verdict.mjs"), ...args], { cwd: scratch, encoding: "utf8" });
  return { exit: run.status, verdict: /^RIG (\w+)/.exec(run.stdout)?.[1] ?? "none", line: `${run.stdout}${run.stderr}` };
}
/** Every file under dir with its content: what "left as it was" means. */
const snapshot = (dir) => Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile())
  .map((d) => join(d.parentPath, d.name)).sort().map((path) => [path, readFileSync(path, "utf8")]));

it("a second run that fails early can never yield GREEN, whatever an earlier run left in the evidence root", () => {
  const root = mkdtempSync(join(scratch, "root-"));
  // an earlier run that passed, its evidence where the 1cb5223910 rig left it: straight in the evidence root
  writeCleanRun(root);
  expect(V.verdictOfEvidence(root).verdict).toBe("GREEN");
  const second = rigRun(root, "run-2");
  expect(second.out).toContain("the server did not start");
  expect(second.exit).toBe(2);
  // the replay of the second run says what the run said: no verdict, exit 2; never the earlier run's GREEN
  const replayed = replay(root, "run-2");
  expect(replayed.verdict).not.toBe("GREEN");
  expect(replayed.exit).toBe(2);
  expect(replay(root)).toMatchObject({ exit: 2, verdict: "none" }); // a root without a run id is not a run
  // the second run wrote only into its own dir, and that dir is unsealed
  expect(readFileSync(join(root, "run-2", "rig.log"), "utf8")).toContain("rig start run=run-2");
  expect(existsSync(join(root, "run-2", V.RUN_COMPLETE))).toBe(false);
});

it("a second run given the id of a finished run is refused before it writes, and the finished run keeps its own verdict", () => {
  const root = mkdtempSync(join(scratch, "root-"));
  const first = writeCleanRun(V.openRun(root, "run-1"));
  V.sealRun(first, "run-1", V.verdictOfEvidence(first).verdict);
  const before = snapshot(root);
  const again = rigRun(root, "run-1");
  expect(again.exit).toBe(2);
  expect(again.out).toContain("cannot start run run-1");
  expect(snapshot(root)).toEqual(before);
  expect(replay(root, "run-1")).toMatchObject({ exit: 0, verdict: "GREEN" });
  // the next run with a fresh id fails early in its own dir and cannot borrow run-1's GREEN
  expect(rigRun(root, "run-2").exit).toBe(2);
  expect(replay(root, "run-2")).toMatchObject({ exit: 2, verdict: "INVALID" });
  expect(readdirSync(root).sort()).toEqual(["run-1", "run-2"]);
});
