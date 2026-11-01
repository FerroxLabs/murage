// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The release CI gate counts only a complete full run on the candidate commit. A scoped dispatch, a skipped completion
// job and an older green run beside a red newer one all refuse; a full run whose failed jobs were re-run green passes.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// A namespace import, so the tests of what the gate decides run on a base without the newer exports.
import * as gate from "./release-ci-gate.mjs";

const { ciVerdict, waiverVerdict } = gate;
const here = dirname(fileURLToPath(import.meta.url));
const ci = parse(readFileSync(join(here, "..", ".github", "workflows", "ci.yml"), "utf8"));

const fallback = expression => JSON.parse(/\|\| '(\[.*?\])'/.exec(expression)[1]);
const oses = fallback(ci.jobs.vitest.strategy.matrix.os);
const allShards = fallback(ci.jobs.vitest.strategy.matrix.vitest_shard);
const shardsOf = os => allShards.filter(shard => !ci.jobs.vitest.strategy.matrix.exclude.some(item => item.os === os && item.vitest_shard === shard));

/** The job names a full run must show, read from ci.yml itself: every job the required completion job needs. */
const neededJobs = ci.jobs.required.needs.flatMap(id => {
  if (id === "quality") return fallback(ci.jobs.quality.strategy.matrix.os).map(os => ci.jobs.quality.name.replace("${{ matrix.os }}", os));
  if (id === "vitest") return oses.flatMap(os => shardsOf(os).map(shard => `Vitest shard ${shard}/${shardsOf(os).length} (${os})`));
  if (id === "human") return ci.jobs.human.strategy.matrix.human_shard.map(shard => ci.jobs.human.name.replace("${{ matrix.human_shard }}", shard));
  return [ci.jobs[id].name];
});

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const job = (name, conclusion = "success") => ({ name, conclusion });
/** A complete run, as the jobs API listed 41242047729: the non-blocking and scoped jobs are there too. */
const fullJobs = () => [
  ...neededJobs.map(name => job(name)),
  ...[1, 2, 3, 4, 5].map(shard => job(`extended (non-blocking) ${shard}/5 (Ubuntu)`)),
  job("Scoped Ubuntu human confirmation", "skipped"),
  job(ci.jobs.required.name),
];
/** A full run with one shard red: the required job ran and failed. */
const redJobs = () => fullJobs().map(item => {
  if (item.name === ci.jobs.required.name) return job(item.name, "failure");
  return item.name === "Vitest shard 3/12 (windows-latest)" ? job(item.name, "failure") : item;
});
/** A vitest_file dispatch, as the jobs API listed 41252882916: the required job is skipped and the shards are scoped ones. */
const scopedJobs = () => [
  ...oses.map(os => job(`quality gates (${os})`)),
  ...oses.map(os => job(`Scoped Vitest confirmation (${os})`)),
  ...[1, 2, 3, 4, 5, 6].map(shard => job(`human specs ${shard}/6 (Ubuntu)`)),
  job("S4 power block (Linux arm64)"),
  job("control-plane check + workerd tests + dry run"),
  job("phone app shell contracts (Ubuntu)"),
  job("package + smoke (Ubuntu 24.04 x64)"),
  job("extended (non-blocking) ${{ matrix.extended_shard }}/5 (Ubuntu)", "skipped"),
  job("Scoped Ubuntu human confirmation", "skipped"),
  job(ci.jobs.required.name, "skipped"),
];

const run = (id, over = {}) => ({ id, head_sha: SHA, status: "completed", conclusion: "success", run_attempt: 1, created_at: "2026-11-01T10:00:00Z", ...over });
/** Decide with each run's jobs given by id, and record which runs were read. */
const decide = (runs, jobs) => ciVerdict(runs, SHA, { jobsFor: item => jobs[item.id] });

describe("what the gate passes", () => {
  it("a full green run on the candidate commit", () => {
    expect(decide([run(1)], { 1: fullJobs() }).state).toBe("pass");
  });
  it("a full run whose failed jobs were re-run green: GitHub lists one run, on its newest attempt", () => {
    const rerun = run(1, { run_attempt: 2, created_at: "2026-10-31T21:06:53Z", run_started_at: "2026-10-31T23:34:46Z" });
    expect(decide([rerun], { 1: fullJobs() }).state).toBe("pass");
  });
  it("a re-run that went green after a newer full run went red: the latest attempt is the green one", () => {
    const rerun = run(1, { run_attempt: 2, created_at: "2026-11-01T09:00:00Z", run_started_at: "2026-11-01T11:00:00Z" });
    const red = run(2, { conclusion: "failure", created_at: "2026-11-01T10:00:00Z" });
    expect(decide([red, rerun], { 1: fullJobs(), 2: redJobs() }).state).toBe("pass");
  });
  it("a full green run with a scoped green confirmation after it", () => {
    const scoped = run(2, { created_at: "2026-11-01T11:00:00Z" });
    expect(decide([scoped, run(1)], { 1: fullJobs(), 2: scopedJobs() }).state).toBe("pass");
  });
  it("a new full run that went green after a red one", () => {
    const red = run(1, { conclusion: "failure", created_at: "2026-11-01T09:00:00Z" });
    expect(decide([run(2), red], { 1: redJobs(), 2: fullJobs() }).state).toBe("pass");
  });
});

describe("what the gate refuses", () => {
  it("a scoped green run: the workflow concluded success and the required job was skipped", () => {
    const verdict = decide([run(1)], { 1: scopedJobs() });
    expect(verdict.state).toBe("fail");
    expect(verdict.reason).toMatch(/no complete full CI run/);
    expect(verdict.reason).toMatch(/scoped/);
  });
  it("a scoped green run after a red full run, whichever has the higher attempt", () => {
    const red = run(1, { conclusion: "failure", created_at: "2026-11-01T09:00:00Z" });
    expect(decide([red, run(2)], { 1: redJobs(), 2: scopedJobs() }).state).toBe("fail");
    const rerunScoped = run(2, { run_attempt: 2 });
    expect(decide([red, rerunScoped], { 1: redJobs(), 2: scopedJobs() }).state).toBe("fail");
  });
  it("an older green run with a red latest attempt, even when the older run has the higher attempt number", () => {
    const older = run(1, { run_attempt: 2, created_at: "2026-11-01T08:00:00Z", run_started_at: "2026-11-01T09:00:00Z" });
    const verdict = decide([older, run(2, { conclusion: "failure" })], { 1: fullJobs(), 2: redJobs() });
    expect(verdict.state).toBe("fail");
    expect(verdict.run.id).toBe(2);
  });
  it("an older green attempt the rerun of the same run replaced with a red one", () => {
    const first = run(1, { run_attempt: 1 });
    const second = run(1, { run_attempt: 2, conclusion: "failure" });
    expect(decide([first, second], { 1: redJobs() }).state).toBe("fail");
  });
  it("a green run with a red scoped run after it, which no waiver covers", () => {
    const scopedRed = run(2, { conclusion: "failure", created_at: "2026-11-01T11:00:00Z" });
    const verdict = decide([run(1), scopedRed], { 1: fullJobs(), 2: scopedJobs() });
    expect(verdict.state).toBe("fail");
    expect(verdict.waivable).toBeUndefined();
  });
  it("a green run whose required job did not pass, or that lacks one needed job", () => {
    const noRequired = fullJobs().filter(item => item.name !== ci.jobs.required.name);
    const noShard = fullJobs().filter(item => item.name !== "Vitest shard 12/12 (windows-latest)");
    const skippedRequired = fullJobs().map(item => (item.name === ci.jobs.required.name ? job(item.name, "skipped") : item));
    for (const jobs of [noRequired, noShard, skippedRequired]) expect(decide([run(1)], { 1: jobs }).state).toBe("fail");
  });
  it("every run when the jobs cannot be read", () => {
    expect(ciVerdict([run(1)], SHA).state).toBe("fail");
    expect(decide([run(1)], { 1: [] }).state).toBe("fail");
  });
  it("no run at all, and runs on another commit only", () => {
    expect(decide([], {}).state).toBe("none");
    expect(decide([run(1, { head_sha: OTHER })], { 1: fullJobs() }).state).toBe("none");
  });
});

describe("what the gate waits for", () => {
  it("a full run being re-run, with a scoped green run newer than it", () => {
    const rerunning = run(1, { status: "in_progress", conclusion: null, run_attempt: 2, created_at: "2026-11-01T09:00:00Z" });
    expect(decide([rerunning, run(2)], { 1: redJobs(), 2: scopedJobs() }).state).toBe("wait");
  });
});

describe("a waiver covers a red full run only", () => {
  const text = id => [`Commit: ${SHA}`, `CI run: ${id}`, "Critical: 0", "", "Reviewed failure classes:", "- flake: `server/slow.test.ts`", "", "Approved-by: Sean Donahoe on 2026-11-01"].join("\n");
  const ask = (id, runs, jobs) => waiverVerdict({ eventName: "workflow_dispatch", waiverPath: "docs/releases/ci-waivers/x.md", waiverText: text(id), sha: SHA, runs, jobsFor: item => jobs[item.id] });

  it("passes for the red full run behind a scoped green confirmation", () => {
    const red = run(1, { conclusion: "failure", created_at: "2026-11-01T09:00:00Z" });
    expect(ask(1, [red, run(2)], { 1: redJobs(), 2: scopedJobs() }).ok).toBe(true);
  });
  it("refuses a red scoped run and a commit with no full run", () => {
    expect(ask(1, [run(1, { conclusion: "failure" })], { 1: scopedJobs() }).reason).toMatch(/not a completed failure of a full run/);
    expect(ask(1, [run(1)], { 1: scopedJobs() }).reason).toMatch(/not a completed failure of a full run/);
  });
});

describe("the gate's job list is ci.yml's", () => {
  it("names every job the required completion job needs, on every OS and shard", () => {
    expect([...gate.FULL_RUN_JOBS ?? []].sort()).toEqual([...neededJobs].sort());
    expect(new Set(neededJobs).size).toBe(neededJobs.length);
    expect(gate.REQUIRED_JOB).toBe(ci.jobs.required.name);
    expect(gate.VITEST_SHARDS).toEqual(Object.fromEntries(oses.map(os => [os, shardsOf(os).length])));
  });
  it("ci.yml still skips the required job on every scoped dispatch, so a scoped run cannot look complete", () => {
    for (const input of ["windows_only", "vitest_file", "human_files"]) {
      expect(Object.keys(ci.on.workflow_dispatch.inputs)).toContain(input);
      expect(ci.jobs.required.if).toContain(`!inputs.${input}`);
    }
    expect(ci.jobs.required.if).toContain("always()");
    expect(ci.jobs.vitest.name).toContain("Vitest shard {0}/{1}");
  });
  it("the gate reads the jobs of each run for its verdict and the waiver", () => {
    const source = readFileSync(join(here, "release-ci-gate.mjs"), "utf8");
    expect(source).toContain("const verdict = ciVerdict(runs, sha, { jobsFor });");
    expect(source).toMatch(/waiverVerdict\(\{[^}]*runs, jobsFor \}\)/);
  });
});
