// SPDX-License-Identifier: AGPL-3.0-or-later
// The Windows-required runner fails on a nonzero exit, any unhandled error, any failed suite or file, and any missing or non-passing required witness.
// Fixtures are vitest JSON reports plus exit codes handed to runRows through an injected spawn; the all-green case exits zero.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { judgeRun, main, runRows } from "./run-windows-required.mjs";

const row = { file: "server/x.test.ts", os: "win32", name: "D6-R6w", mutants: "m1" };
const passed = { title: "D6-R6w release on crash", status: "passed", failureMessages: [] };
const green = (over = {}) => ({ success: true, numFailedTests: 0, numFailedTestSuites: 0, testResults: [{ name: "x", status: "passed", assertionResults: [passed] }], ...over });
const exec = (report, status = 0, extra = {}) => {
  const lines = [];
  const code = runRows([row], {
    spawn: (_r, out) => { if (report !== undefined) writeFileSync(out, typeof report === "string" ? report : JSON.stringify(report)); return { status, signal: null, ...extra }; },
    readReport: p => readFileSync(p, "utf8"),
    log: l => lines.push(l),
  });
  return { code, lines };
};

it("all-green: exit 0 and a PASS line", () => {
  const { code, lines } = exec(green());
  expect(code).toBe(0);
  expect(lines[0]).toMatch(/^PASS D6-R6w/);
});
it("a failing hook with every named assertion passed fails (failed suite, exit 1)", () => {
  const r = green({ success: false, numFailedTestSuites: 1, testResults: [{ name: "x", status: "failed", message: "afterAll hook failed", assertionResults: [passed] }] });
  const { code, lines } = exec(r, 1);
  expect(code).toBe(1);
  expect(lines[0]).toMatch(/^FAIL/);
});
it("an unhandled error with the named assertion passed fails", () => {
  expect(exec(green({ unhandledErrors: [{ message: "boom" }] }), 1).code).toBe(1);
  expect(exec(green({ unhandledErrors: [{ message: "boom" }] }), 0).code).toBe(1);
});
it("a failed suite fails even when the exit code is zero", () => { expect(exec(green({ numFailedTestSuites: 1 }), 0).code).toBe(1); });
it("a failed file fails even when the exit code is zero and counters are zero", () => {
  expect(exec(green({ testResults: [{ name: "x", status: "failed", assertionResults: [passed] }] }), 0).code).toBe(1);
});
it("a failed sibling test fails even when counters are zero", () => {
  expect(exec(green({ testResults: [{ name: "x", status: "passed", assertionResults: [passed, { title: "other", status: "failed", failureMessages: ["x"] }] }] }), 0).code).toBe(1);
});
it("report success false fails even when the exit code is zero", () => { expect(exec(green({ success: false }), 0).code).toBe(1); });
it("a nonzero exit with every assertion passed fails", () => { expect(exec(green(), 1).code).toBe(1); });
it("a signal-killed or non-spawning vitest fails", () => {
  expect(exec(green(), 0, { signal: "SIGKILL" }).code).toBe(1);
  expect(exec(green(), 0, { error: new Error("ENOENT") }).code).toBe(1);
});
it("a missing report file fails", () => { expect(exec(undefined, 0).code).toBe(1); });
it("an unparseable or shapeless report fails", () => {
  expect(exec("{not json", 0).code).toBe(1);
  expect(exec({ success: true }, 0).code).toBe(1);
});
it("a missing required witness fails", () => {
  expect(exec(green({ testResults: [{ name: "x", status: "passed", assertionResults: [{ title: "other", status: "passed" }] }] }), 0).code).toBe(1);
  expect(exec(green({ testResults: [] }), 0).code).toBe(1);
});
it("a skipped or todo required witness fails", () => {
  for (const status of ["skipped", "pending", "todo", "failed"])
    expect(exec(green({ testResults: [{ name: "x", status: "passed", assertionResults: [{ title: "D6-R6w a", status }] }] }), 0).code, status).toBe(1);
});
it("one non-passing hit among passing hits fails", () => {
  expect(exec(green({ testResults: [{ name: "x", status: "passed", assertionResults: [passed, { title: "D6-R6w b", status: "skipped" }] }] }), 0).code).toBe(1);
});
it("a throwing spawn fails the row", () => {
  // even with a green report left behind, a spawn that threw is a failed row
  const code = runRows([row], { spawn: () => { throw new Error("no vitest"); }, readReport: () => JSON.stringify(green()), log: () => {} });
  expect(code).toBe(1);
});
it("one bad row among good rows fails the run", () => {
  const rows = [row, { ...row, name: "D6-R7w" }];
  const code = runRows(rows, { spawn: (r, out) => { writeFileSync(out, JSON.stringify(green({ testResults: [{ name: "x", status: "passed", assertionResults: r.name === "D6-R6w" ? [passed] : [] }] }))); return { status: 0, signal: null }; }, readReport: p => readFileSync(p, "utf8"), log: () => {} });
  expect(code).toBe(1);
});
it("judgeRun names every reason", () => {
  const j = judgeRun(row, { status: 1, signal: null }, JSON.stringify(green({ success: false, numFailedTests: 1, numFailedTestSuites: 1, unhandledErrors: [1] })));
  expect(j.ok).toBe(false);
  expect(j.reasons.join(" ")).toMatch(/nonzero vitest exit 1.*success is false.*1 failed test.*1 failed suite.*unhandled/);
});
it("not Windows exits 2, --list exits 0", () => {
  expect(main([], "linux")).toBe(2);
  expect(main(["--list"], "linux")).toBe(0);
});
it("the script entry point exits 2 off Windows and 0 for --list", () => {
  const script = fileURLToPath(new URL("./run-windows-required.mjs", import.meta.url));
  if (process.platform !== "win32") expect(spawnSync(process.execPath, [script], { encoding: "utf8" }).status).toBe(2);
  expect(spawnSync(process.execPath, [script, "--list"], { encoding: "utf8" }).status).toBe(0);
});
