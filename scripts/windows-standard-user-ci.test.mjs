// WIN-BACKUP-RT-1018: the real Windows backup round trip is collected only by the standard-user launcher, and the
// ci.yml step that runs it is shaped so a run can never pass by skipping it, lose its exit code or leave its account.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check, select } from "./ci-test-tiers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ROUND_TRIP = "server/installation-windows-backup-roundtrip.test.ts";
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const launcher = readFileSync(new URL("./ci-windows-standard-user.ps1", import.meta.url), "utf8");

/** One step of ci.yml, from its `- name:` line to the next step or job. */
function step(name) {
  const start = ci.indexOf(`      - name: ${name}\n`);
  expect(start, `ci.yml has the step "${name}"`).toBeGreaterThan(-1);
  const rest = ci.slice(start + 1);
  const end = rest.search(/\n {6}- name: |\n {2}[a-z][a-z0-9-]*:\n/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("the Windows round trip runs only as a standard user", () => {
  it("the local user's description fits New-LocalUser's 48-character limit", () => {
    const body = step("Round trip as a standard Windows user");
    const descriptions = [...body.matchAll(/New-LocalUser\b[^\n]*-Description '([^']*)'/g)].map(match => match[1]);
    expect(descriptions, "one New-LocalUser with a quoted -Description").toHaveLength(1);
    expect(descriptions[0].length, `"${descriptions[0]}" is ${descriptions[0].length} characters`).toBeGreaterThan(0);
    expect(descriptions[0].length, `"${descriptions[0]}" is ${descriptions[0].length} characters; Windows allows at most 48`).toBeLessThanOrEqual(48);
  });

  it("the step runs on every Windows run, full and scoped, and prints the exit code before an account cleanup that must succeed", () => {
    const body = step("Round trip as a standard Windows user");
    expect(body).toContain("if: ${{ !cancelled() && matrix.os == 'windows-latest' && matrix.vitest_shard == 1 }}");
    expect(body, "no SilentlyContinue cleanup").not.toMatch(/Remove-LocalUser[^\n]*SilentlyContinue/);
    const printed = body.indexOf("Standard-user round trip exit code:"), removed = body.indexOf("Remove-LocalUser -Name $user -ErrorAction Stop");
    expect(removed, "Remove-LocalUser -ErrorAction Stop").toBeGreaterThan(-1);
    expect(printed, "the exit code is printed before the cleanup").toBeGreaterThan(-1);
    expect(printed).toBeLessThan(removed);
    expect(body).toContain("$remaining = @(Get-LocalUser -ErrorAction Stop | Where-Object { $_.Name -eq $user })");
    expect(body).toContain('if ($remaining.Count -ne 0) { throw "Account cleanup failed: $user remains" }');
    expect(body.indexOf("exit $code"), "the step exits with the test's code after the cleanup").toBeGreaterThan(removed);
  });

  it("the scoped step drops the round trip from its selection and starts no Vitest when nothing remains", () => {
    const body = step("Scoped Vitest confirmation");
    expect(body).toContain(`${ROUND_TRIP}|./${ROUND_TRIP}) continue ;;`);
    expect(body).toContain('echo "scoped selection runs only in the standard-user step"; exit 0');
    expect(body.indexOf("continue ;;")).toBeLessThan(body.indexOf("pnpm exec vitest run"));
    expect(step("Run Vitest shard"), "the shard also skips it by name").toContain(`--skip ${ROUND_TRIP}`);
  });

  it("only the launcher opts in to collection, after its identity line and before Vitest starts", () => {
    const set = launcher.indexOf("$env:MURAGE_TEST_STANDARD_USER_RT = '1'");
    expect(set).toBeGreaterThan(launcher.indexOf("Standard-user round trip as "));
    expect(set).toBeLessThan(launcher.indexOf("node_modules/vitest/vitest.mjs"));
    expect(ci, "the workflow itself never sets it").not.toContain("MURAGE_TEST_STANDARD_USER_RT");
  });

  it("the round-trip file stays a classified Windows gate test", () => {
    expect(check().problems.filter(problem => problem.includes(ROUND_TRIP))).toEqual([]);
    expect(select({ tier: "gate", os: "windows" }).files).toContain(ROUND_TRIP);
  });

  it("vitest collects the round-trip file only with MURAGE_TEST_STANDARD_USER_RT=1", { timeout: 180_000 }, () => {
    const listed = extra => {
      const env = { ...process.env, ...extra };
      if (!extra.MURAGE_TEST_STANDARD_USER_RT) delete env.MURAGE_TEST_STANDARD_USER_RT;
      const run = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "list", "server", "--filesOnly"], { cwd: ROOT, env, encoding: "utf8", maxBuffer: 64 * 1024 ** 2, timeout: 170_000 });
      expect(run.status, `vitest list exited ${run.status}: ${run.stderr?.slice(-2000)}`).toBe(0);
      const files = run.stdout.split(/\r?\n/).map(line => line.trim().replace(/\\/g, "/"));
      expect(files.some(file => file.endsWith("server/installation-windows-backup-elevated.test.ts")), "the listing is real (it names the elevated companion)").toBe(true);
      return files.some(file => file.endsWith(ROUND_TRIP));
    };
    expect(listed({}), "without the variable the round trip is not collected").toBe(false);
    expect(listed({ MURAGE_TEST_STANDARD_USER_RT: "1" }), "with it, it is").toBe(true);
  });
});
