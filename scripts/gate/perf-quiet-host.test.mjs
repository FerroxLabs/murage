// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../../server/testing/cleanup.ts";
import { assertPerfReport } from "./perf-budget.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), "murage-c6-"));
afterAll(() => removeTempDirSync(fixture));

function runFixture({ marker, load, failing = false, skip = false }) {
  const dir = mkdtempSync(join(fixture, "vitest-"));
  const mock = join(dir, "mock.mjs"), spec = join(dir, "budget.fixture.mjs"), config = join(dir, "config.mjs"), report = join(dir, "results.json");
  // Injection is confined to this disposable fixture; the real harness has no
  // load override. Absolute imports resolve Vitest from the candidate's tree.
  const vitest = JSON.stringify(pathToFileURL(join(root, "node_modules/vitest/dist/index.js")).href);
  writeFileSync(mock, `import os from "node:os"; import { syncBuiltinESMExports } from "node:module"; const loads = ${JSON.stringify(Array.isArray(load) ? load : [load])}; os.loadavg = () => [loads.length > 1 ? loads.shift() : loads[0], 0, 0]; syncBuiltinESMExports();`);
  writeFileSync(spec, `import { describe, it, expect } from ${vitest};
    it('structural neighbour', () => expect(1).toBe(1));
    describe('inherited tag', { tags: ['perf-budget'] }, () => {
      it('wall-clock bound', ctx => { ${skip ? "ctx.skip('fixture skipped bound');" : ""} expect(${failing ? 51 : 49}).toBeLessThan(50); });
    });`);
  writeFileSync(config, `export default { test: { include: [${JSON.stringify(spec)}], setupFiles: [${JSON.stringify(mock)}, ${JSON.stringify(join(root, 'server/testing/perf-budget-setup.ts'))}], sequence: { setupFiles: 'list' }, tags: [{ name: 'perf-budget' }], reporters: ['default', 'json'], outputFile: { json: ${JSON.stringify(report)} } } };`);
  const env = { ...process.env };
  if (marker === undefined) delete env.MURAGE_PERF_QUIET_HOST;
  else env.MURAGE_PERF_QUIET_HOST = marker;
  const run = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", config], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  const output = `${run.stdout}\n${run.stderr}`;
  expect(run.error, output).toBeUndefined();
  return { ...run, output, report: JSON.parse(readFileSync(report, "utf8")) };
}

describe("actual Vitest hook with injected load", () => {
  it("the default suite setup installs the perf-budget hook", () => {
    expect(readFileSync(join(root, "server/testing/setup.ts"), "utf8")).toContain('import "./perf-budget-setup.ts"');
  });
  it("rejects a host that becomes busy during the bound", () => {
    const run = runFixture({ marker: "1", load: [0.5, 2] });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("REFUSED:");
    expect(() => assertPerfReport(run.report)).toThrow();
  }, 90_000);
  it("ordinary loaded runs name skipped bounds and still execute structural neighbours", () => {
    const run = runFixture({ load: 40, failing: true });
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("SKIPPED:");
    expect(run.output).toContain("wall-clock bound");
    expect(run.output).not.toContain("ENFORCED: quiet host");
    expect(run.report.numPassedTests).toBe(1);
    expect(() => assertPerfReport(run.report)).toThrow();
  }, 90_000);
  it("quiet runs execute inherited perf tags and record green enforcement", () => {
    const run = runFixture({ marker: "1", load: 0.5 });
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("ENFORCED: quiet host");
    expect(assertPerfReport(run.report)).toBe(1);
  }, 90_000);
  it("quiet runs fail on the original wall-clock bound", () => {
    const run = runFixture({ marker: "1", load: 0.5, failing: true });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("less than 50");
    expect(() => assertPerfReport(run.report)).toThrow();
  }, 90_000);
  it("a requested quiet run at load 2 refuses before the assertion", () => {
    const run = runFixture({ marker: "1", load: 2 });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("REFUSED:");
    expect(run.output).not.toContain("ENFORCED: quiet host");
  }, 90_000);
  it("a test that skips itself cannot count as an enforced green bound", () => {
    const run = runFixture({ marker: "1", load: 0.5, skip: true });
    expect(run.status, run.output).toBe(0);
    expect(() => assertPerfReport(run.report)).toThrow("not enforced and green");
  }, 90_000);
});

// Exercise the real shell control flow in a disposable copy, changing only the
// fixed host lock path. Fake commands inject load/results; no timing leg runs.
describe.skipIf(process.platform === "win32")("quiet-host wrapper receipt", () => {
  function runWrapper(load, runnerRc = 0, status = "passed") {
    const dir = mkdtempSync(join(fixture, "wrapper-"));
    mkdirSync(join(dir, "scripts/gate"), { recursive: true });
    mkdirSync(join(dir, "bin"));
    const source = readFileSync(new URL("./perf-quiet-host.sh", import.meta.url), "utf8");
    // MAIN RULING 1115-PUB-HYGIENE
    expect(source).toContain('exec 9>"${MURAGE_TIMING_LOCK:-/tmp/murage-timing.lock}"');
    writeFileSync(join(dir, "scripts/gate/perf-quiet-host.sh"), source.replace("/tmp/murage-timing.lock", join(dir, "timing.lock")));
    copyFileSync(new URL("./perf-budget.mjs", import.meta.url), join(dir, "scripts/gate/perf-budget.mjs"));
    const command = (name, body) => writeFileSync(join(dir, "bin", name), `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
    command("git", "echo fixture-sha");
    command("flock", '[[ "$*" == "-x 9" ]]; echo lock >> events');
    const data = JSON.stringify({ success: true, testResults: [{ assertionResults: [{ status, fullName: "fixture bound", tags: ["perf-budget"], meta: { perfQuietHost: true } }] }] });
    command("node", `if [[ "\${1:-}" == node_modules/vitest/vitest.mjs ]]; then
      [[ "\${MURAGE_PERF_QUIET_HOST:-}" == 1 ]]
      [[ "$*" == *--tags-filter=perf-budget* && "$*" == *--no-file-parallelism* ]]
      echo run >> events
      for arg in "$@"; do case "$arg" in --outputFile.json=*) printf '%s' '$REPORT' > "\${arg#*=}";; esac; done
      exit ${runnerRc}
    elif [[ "\${2:-}" == -e ]]; then
      echo load >> events
      echo ${load}
    else
      exec "$REAL_NODE" "$@"
    fi`.replace("$REPORT", data));
    const run = spawnSync("bash", [join(dir, "scripts/gate/perf-quiet-host.sh")], {
      cwd: dir, env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, REAL_NODE: process.execPath }, encoding: "utf8", timeout: 30_000,
    });
    return { ...run, output: `${run.stdout}\n${run.stderr}`, events: readFileSync(join(dir, "events"), "utf8").trim().split("\n") };
  }
  it("locks before checking load and running, then emits one sha/load/PASS receipt", () => {
    const run = runWrapper(0.5);
    expect(run.status, run.output).toBe(0);
    expect(run.events).toEqual(["lock", "load", "run", "load"]);
    expect(run.output.match(/^PERF-QUIET-HOST .*$/gm)).toEqual(["PERF-QUIET-HOST sha=fixture-sha load=0.5 result=PASS"]);
  });
  it("load >= 2 refuses before running and emits a failure receipt", () => {
    const run = runWrapper(2);
    expect(run.status, run.output).toBe(1);
    expect(run.events).toEqual(["lock", "load"]);
    expect(run.output).toContain("REFUSED:");
    expect(run.output).toContain("load=2 result=FAIL");
  });
  it("propagates the runner failure and never emits PASS", () => {
    const run = runWrapper(0.5, 7);
    expect(run.status, run.output).toBe(7);
    expect(run.output).toContain("result=FAIL");
    expect(run.output).not.toContain("result=PASS");
  });
  it("a successful runner exit with a skipped bound still fails the receipt", () => {
    const run = runWrapper(0.5, 0, "pending");
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("not enforced and green");
    expect(run.events).toEqual(["lock", "load", "run", "load"]);
    expect(run.output).toContain("result=FAIL");
  });
});
