// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The release CI gate's one-time waiver: strict by default, and a red CI passes
// only under a committed, approved waiver naming the pinned commit and the exact
// CI run that failed for it, on a hand-started (workflow_dispatch) run.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { slowNightlyRun, realEngineVerdict, ciVerdict, failedTestsInLog, failuresVerdict, FULL_RUN_JOBS, nativeAddonVerdict, nightlyPending, nightlyRetryable, nightlyVerdict, parseWaiver, waiverVerdict } from "./release-ci-gate.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const PATH = "docs/releases/ci-waivers/1.0.2.md";
const run = (over = {}) => ({ id: 4242, head_sha: SHA, status: "completed", conclusion: "failure", run_attempt: 1, created_at: "2026-10-16T10:00:00Z", html_url: "https://github.com/o/r/actions/runs/4242", ...over });
const waiver = ({ commit = SHA, runId = "4242", critical = "0", classes = ["Windows shard timeout: `server/slow.test.ts`, known flake, green on re-run"], approval = "Sean Donahoe on 2026-10-16" } = {}) => [
  "# CI waiver: Murage 1.0.2",
  "",
  commit === null ? "" : `Commit: ${commit}`,
  runId === null ? "" : `CI run: ${runId}`,
  critical === null ? "" : `Critical: ${critical}`,
  "",
  "Reviewed failure classes:",
  ...classes.map(item => `- ${item}`),
  "",
  approval === null ? "" : `Approved-by: ${approval}`,
  "",
  "## Evidence",
  "Free prose.",
].join("\n");
// A full run's jobs, green or with its required completion job red, as the jobs API returns them.
const fullJobs = (required = "failure") => [...FULL_RUN_JOBS.map(name => ({ name, conclusion: "success" })), { name: "required CI completion", conclusion: required }];
const jobsFor = candidate => fullJobs(candidate.conclusion === "success" ? "success" : "failure");
const dispatch = (over = {}) => ({ eventName: "workflow_dispatch", waiverPath: PATH, waiverText: waiver(), sha: SHA, runs: [run()], jobsFor, ...over });

describe("strict by default", () => {
  it("a red CI without a waiver is still a failure", () => {
    expect(ciVerdict([run()], SHA, { jobsFor }).state).toBe("fail");
    const result = waiverVerdict(dispatch({ waiverPath: "" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no waiver/);
  });
  it("a green CI still passes on its own", () => {
    expect(ciVerdict([run({ conclusion: "success" })], SHA, { jobsFor }).state).toBe("pass");
  });
});

describe("a valid waiver", () => {
  it("passes a red CI and reports what it waived", () => {
    const result = waiverVerdict(dispatch());
    expect(result.ok).toBe(true);
    expect(result.waiver).toMatchObject({ commit: SHA, runId: "4242", critical: "0", approver: "Sean Donahoe", date: "2026-10-16", path: PATH });
    expect(result.waiver.classes).toEqual(["Windows shard timeout: `server/slow.test.ts`, known flake, green on re-run"]);
    expect(result.waiver.tests).toEqual(["server/slow.test.ts"]);
    expect(result.waiver.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.reason).toContain(PATH);
  });
  it("names the newest attempt when CI was re-run and failed again", () => {
    const runs = [run({ id: 1, run_attempt: 1 }), run({ id: 4242, run_attempt: 2 })];
    expect(waiverVerdict(dispatch({ runs })).ok).toBe(true);
  });
});

describe("a waiver is refused", () => {
  const refused = (over, pattern) => {
    const result = waiverVerdict(dispatch(over));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(pattern);
  };
  it("for another commit", () => refused({ waiverText: waiver({ commit: OTHER }) }, /not the pinned/));
  it("for another CI run", () => refused({ waiverText: waiver({ runId: "999" }) }, /decided/));
  it("for a run that belongs to another commit", () => refused({ runs: [run(), run({ id: 999, head_sha: OTHER })], waiverText: waiver({ runId: "999" }) }, /decided/));
  it("for an older attempt than the one that decided the commit", () => refused({ runs: [run({ id: 4242, run_attempt: 1 }), run({ id: 5000, run_attempt: 2 })] }, /decided/));
  it("when CI did not fail (still running, or none)", () => {
    refused({ runs: [run({ status: "in_progress", conclusion: null })] }, /not a completed failure/);
    refused({ runs: [] }, /not a completed failure/);
  });
  it("without an approval line", () => refused({ waiverText: waiver({ approval: null }) }, /no "Approved-by:"/));
  it("with an approval missing its date", () => refused({ waiverText: waiver({ approval: "Sean Donahoe" }) }, /must read/));
  it("approved by anyone but Sean", () => refused({ waiverText: waiver({ approval: "Mallory on 2026-10-16" }) }, /only Sean/));
  it("with an impossible approval date", () => refused({ waiverText: waiver({ approval: "Sean on 2026-02-30" }) }, /not a real date/));
  it("on a push event", () => refused({ eventName: "push" }, /push run can never waive/));
  it("on any other non-dispatch event", () => refused({ eventName: "" }, /never waive/));
  it("when the file is not in the dispatch commit", () => refused({ waiverText: null }, /not in the dispatch commit/));
  it("unless Critical is 0", () => {
    refused({ waiverText: waiver({ critical: "1" }) }, /only Critical: 0/);
    refused({ waiverText: waiver({ critical: null }) }, /no "Critical:"/);
  });
  it("with two Critical lines", () => refused({ waiverText: `${waiver()}\nCritical: 2\n` }, /exactly one/));
  it("without reviewed failure classes", () => refused({ waiverText: waiver({ classes: [] }) }, /no reviewed failure classes/));
  it("for a path outside the repository", () => {
    refused({ waiverPath: "../secrets.md" }, /plain repository path/);
    refused({ waiverPath: "/etc/passwd" }, /plain repository path/);
    refused({ waiverPath: "docs/$(id).md" }, /plain repository path/);
  });
});

describe("the waiver template", () => {
  const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "releases", "ci-waiver-template.md"), "utf8");
  it("parses with the same reader, and is refused until filled in", () => {
    const parsed = parseWaiver(template);
    expect(parsed.critical).toBe("0");
    expect(parsed.classes.length).toBe(1);
    expect(waiverVerdict(dispatch({ waiverText: template })).ok).toBe(false);
  });
});

describe("release.yml wiring", () => {
  const release = parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "release.yml"), "utf8"));
  const on = release.on ?? release[true];
  it("ci_waiver is an optional dispatch input only", () => {
    expect(on.workflow_dispatch.inputs.ci_waiver).toMatchObject({ required: false, type: "string" });
    expect(on.push.inputs).toBeUndefined();
  });
  it("the gate receives the waiver only on workflow_dispatch and exposes its outputs", () => {
    const step = release.jobs["ci-gate"].steps.find(s => s.id === "gate");
    expect(step.env.CI_WAIVER).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.ci_waiver || '' }}");
    expect(Object.keys(release.jobs["ci-gate"].outputs)).toEqual(expect.arrayContaining(["waived", "waiver_path", "waiver_run", "waiver_approval"]));
  });
  it("stage hands the CI waiver to assemble before notes and upload", () => {
    const stage = release.jobs.stage.steps;
    const record = stage.find(s => s.name === 'Retain the CI review record for the sole release writer');
    expect(record.env.WAIVER_PATH).toBe('${{ needs.ci-gate.outputs.waiver_path }}');
    expect(record.env.SHA).toBe('${{ needs.prepare.outputs.sha }}');
    expect(record.run).toContain('review.json');
    expect(stage.some(s => s.with?.name === 'release-ci-review-${{ github.run_attempt }}')).toBe(true);
    const steps = release.jobs.assemble.steps;
    const notes = steps.findIndex(s => s.run === 'node scripts/release-guard.mjs notes-file');
    expect(steps[notes].env.REVIEW_FILE).toBe('release-review/review.json');
    expect(steps.findIndex(s => s.run === 'node scripts/release-guard.mjs download')).toBeLessThan(notes);
    expect(notes).toBeLessThan(steps.findIndex(s => s.id === 'upload'));
  });
  it("the Windows job fetches verified Node headers before packaging", () => {
    const steps = release.jobs.windows.steps;
    const headers = steps.findIndex(s => s.name === "Node headers for the engine-exclusion addon");
    expect(headers).toBeGreaterThan(steps.findIndex(s => s.run === "pnpm install --frozen-lockfile"));
    expect(headers).toBeLessThan(steps.findIndex(s => String(s.name ?? "").startsWith("Package")));
    expect(steps[headers].run).toContain("SHASUMS256.txt");
    expect(steps[headers].run).toContain("sha256sum -c");
    expect(steps[headers].run).toContain("NODE_HEADERS_DIR=");
  });
});

describe("the latest nightly must be green", () => {
  const sha = "a".repeat(40);
  const older = "b".repeat(40);
  const now = Date.parse("2026-10-16T12:00:00Z");
  const run = (over) => ({ id: 1, status: "completed", conclusion: "success", head_sha: sha, created_at: "2026-10-16T03:17:00Z", ...over });
  const ancestor = (runSha) => runSha === older;

  it("passes on a green nightly of the pinned commit or an ancestor", () => {
    expect(nightlyVerdict([run()], sha, { ancestor, now }).ok).toBe(true);
    expect(nightlyVerdict([run({ head_sha: older })], sha, { ancestor, now }).ok).toBe(true);
  });

  it("judges the newest completed run, so an older green does not cover a newer red", () => {
    const runs = [run({ id: 1 }), run({ id: 2, conclusion: "failure", created_at: "2026-10-16T09:00:00Z" })];
    const verdict = nightlyVerdict(runs, sha, { ancestor, now });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("concluded failure");
    // a run still in progress is not the latest verdict
    expect(nightlyVerdict([run(), run({ id: 3, status: "in_progress", conclusion: null, created_at: "2026-10-16T11:00:00Z" })], sha, { ancestor, now }).ok).toBe(true);
  });

  it("refuses no run, a cancelled run, a run off this history and a stale run", () => {
    expect(nightlyVerdict([], sha, { ancestor, now }).reason).toBe("no completed nightly run found");
    expect(nightlyVerdict([run({ conclusion: "cancelled" })], sha, { ancestor, now }).ok).toBe(false);
    expect(nightlyVerdict([run({ head_sha: "c".repeat(40) })], sha, { ancestor, now }).reason).toContain("not");
    expect(nightlyVerdict([run({ created_at: "2026-10-10T03:17:00Z" })], sha, { ancestor, now }).reason).toContain("h old");
  });
});

describe("the gate waits for a running nightly", () => {
  const sha = "a".repeat(40);
  const now = Date.parse("2026-10-16T12:00:00Z");
  const run = (over) => ({ id: 1, status: "completed", conclusion: "success", head_sha: sha, created_at: "2026-10-16T03:17:00Z", ...over });
  const running = run({ id: 9, status: "in_progress", conclusion: null, created_at: "2026-10-16T11:00:00Z" });

  it("is pending while a nightly for the pinned commit has not completed", () => {
    expect(nightlyPending([run(), running], sha)).toBe(true);
    expect(nightlyPending([run(), { ...running, status: "queued" }], sha)).toBe(true);
    expect(nightlyPending([run()], sha)).toBe(false);
    expect(nightlyPending([{ ...running, head_sha: "b".repeat(40) }], sha)).toBe(false);
    expect(nightlyPending(undefined, sha)).toBe(false);
  });

  it("retries a missing, stale or off-history nightly but never a completed red one", () => {
    const ancestor = () => false;
    expect(nightlyRetryable(nightlyVerdict([], sha, { ancestor, now }))).toBe(true);
    expect(nightlyRetryable(nightlyVerdict([run({ created_at: "2026-10-10T03:17:00Z" })], sha, { ancestor, now }))).toBe(true);
    expect(nightlyRetryable(nightlyVerdict([run({ head_sha: "c".repeat(40) })], sha, { ancestor, now }))).toBe(true);
    expect(nightlyRetryable(nightlyVerdict([run({ conclusion: "failure" })], sha, { ancestor, now }))).toBe(false);
    expect(nightlyRetryable(nightlyVerdict([run({ conclusion: "cancelled" })], sha, { ancestor, now }))).toBe(false);
    expect(nightlyRetryable(nightlyVerdict([run()], sha, { ancestor, now }))).toBe(false);
  });
});

describe("release.yml: builds run beside CI, the draft waits for the gate", () => {
  const release = parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "release.yml"), "utf8"));
  const needs = job => [release.jobs[job].needs].flat();
  it("builds need prepare and its probe (mac-x64 also mac), and run beside CI", () => {
    expect(needs("mac")).toEqual(["prepare", "preflight"]);
    expect(needs("windows")).toEqual(["prepare", "preflight"]);
    expect(needs("linux")).toEqual(["prepare", "preflight"]);
    expect(needs("mac-x64")).toEqual(["prepare", "preflight", "mac"]);
  });
  it("only assemble holds the release token and waits for verified stage", () => {
    expect(needs("assemble")).toEqual(["prepare"]);
    expect(needs("stage")).toEqual(expect.arrayContaining(["prepare", "ci-gate", "mac", "mac-x64", "windows", "linux"]));
    expect(release.jobs.assemble.steps.some(s => s.run === "node scripts/release-guard.mjs wait-stage")).toBe(true);
    const writers = Object.entries(release.jobs).filter(([, job]) => JSON.stringify(job).includes("RELEASES_PAT")).map(([name]) => name);
    expect(writers).toEqual(["assemble"]);
    expect(release.jobs.assemble.if).not.toMatch(/always\(\)/);
  });
  it("the gate can wait out a 4 h CI", () => {
    expect(release.jobs["ci-gate"]["timeout-minutes"]).toBeGreaterThanOrEqual(260);
  });
});

describe("the nightly is rechecked after the CI wait", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "release-ci-gate.mjs"), "utf8");
  it("runs before the pass branch and before a waiver is honoured", () => {
    const pass = source.indexOf('if (verdict.state === "pass") {');
    expect(source.slice(pass, pass + 120)).toContain("recheckNightly();");
    const waived = source.indexOf("const result = waiverVerdict(");
    expect(source.slice(waived, waived + 400)).toContain("recheckNightly();");
    // and the waived run's reds are checked against the classes before the waiver is recorded as used
    const used = source.indexOf('"## CI waiver used"');
    expect(source.slice(waived, used)).toContain("failuresVerdict({ waiver: result.waiver, jobs: listRunJobs(");
  });
});

describe("the Windows ACL tests (native-addon-msvc) are required", () => {
  const sha = "a".repeat(40);
  const old = "d".repeat(40);
  const ok = { ancestor: () => true, stale: () => false, runsAcl: () => true };
  const native = (over = {}) => run({ id: 7, head_sha: sha, conclusion: "success", ...over });
  it("passes on a green run of the pinned commit", () => {
    expect(nativeAddonVerdict([native()], sha, ok).ok).toBe(true);
  });
  it("passes on a green ancestor run when no watched file changed since", () => {
    expect(nativeAddonVerdict([native({ head_sha: old })], sha, ok).ok).toBe(true);
  });
  it("refuses an ancestor run when a watched file changed since", () => {
    expect(nativeAddonVerdict([native({ head_sha: old })], sha, { ...ok, stale: () => true }).reason).toContain("changed between");
  });
  it("refuses no run, a red run, or a newer red run over an older green one", () => {
    expect(nativeAddonVerdict([], sha, ok).ok).toBe(false);
    expect(nativeAddonVerdict([native({ conclusion: "failure" })], sha, ok).ok).toBe(false);
    expect(nativeAddonVerdict([native({ head_sha: old, created_at: "2026-10-10T00:00:00Z" }), native({ id: 8, conclusion: "failure", created_at: "2026-10-11T00:00:00Z" })], sha, ok).ok).toBe(false);
  });
  it("refuses a run whose workflow did not require the ACL tests", () => {
    expect(nativeAddonVerdict([native()], sha, { ...ok, runsAcl: () => false }).reason).toContain("MURAGE_REQUIRE_WINDOWS_NATIVE");
  });
  it("refuses a run that is not on this history", () => {
    expect(nativeAddonVerdict([native({ head_sha: old })], sha, { ...ok, ancestor: () => false }).ok).toBe(false);
  });
});

describe("a waiver covers only the tests its classes name", () => {
  const LOG = [
    "2026-10-23T13:01:02.1234567Z \x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m server/slow.test.ts\x1b[2m > \x1b[22mtimes out",
    "2026-10-23T13:01:02.1234567Z  FAIL  server/slow.test.ts > another case",
    "2026-10-23T13:01:03.0000000Z  ✓ server/fine.test.ts (3 tests) 20ms",
  ].join("\n");
  const parsed = () => parseWaiver(waiver({ classes: ["Windows timing: `server/slow.test.ts` and `scripts/other.test.mjs`"] }));
  it("reads the failing test files from a job log", () => {
    expect(failedTestsInLog(LOG)).toEqual(["server/slow.test.ts"]);
    expect(parsed().tests).toEqual(["server/slow.test.ts", "scripts/other.test.mjs"]);
  });
  it("passes when every red is a named test, ignoring non-blocking and the aggregate job", () => {
    const jobs = [
      { name: "Vitest shard 4/12 (windows-latest)", conclusion: "failure", failedTests: failedTestsInLog(LOG) },
      { name: "extended (non-blocking) 1/5 (Ubuntu)", conclusion: "failure", failedTests: ["server/flaky.test.ts"] },
      { name: "required CI completion", conclusion: "failure", failedTests: [] },
      { name: "Vitest shard 1/12 (windows-latest)", conclusion: "success", failedTests: [] },
    ];
    expect(failuresVerdict({ waiver: parsed(), jobs }).ok).toBe(true);
  });
  it("refuses a red outside the named classes (the 1.0.3.1 attempt-1 flakes)", () => {
    const jobs = [
      { name: "Vitest shard 4/12 (windows-latest)", conclusion: "failure", failedTests: ["server/slow.test.ts", "server/b11-destination-api.test.ts"] },
    ];
    const result = failuresVerdict({ waiver: parsed(), jobs });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("server/b11-destination-api.test.ts (Vitest shard 4/12 (windows-latest))");
  });
  it("refuses a blocking job that failed, timed out or was cancelled without naming a test", () => {
    for (const conclusion of ["failure", "cancelled", "timed_out"]) {
      const result = failuresVerdict({ waiver: parsed(), jobs: [{ name: "Typecheck", conclusion, failedTests: [] }] });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('job "Typecheck"');
    }
  });
  it("refuses a waiver whose class names no test file", () => {
    const result = waiverVerdict(dispatch({ waiverText: waiver({ classes: ["Windows shard timeout: known flake"] }) }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("names no test file");
  });
});


describe("real engines are required on the exact RC within 72 hours", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const engines = ["claude", "codex", "gemini", "fuigo", "opencode"];
  const jobs = () => engines.map(engine => ({ name: `real-engine (${engine})`, conclusion: "success",
    completed_at: new Date(now - 3600000).toISOString(), steps: [{ name: "Real-engine verdict", conclusion: "success" }] }));
  const green = () => run({ conclusion: "success", created_at: new Date(now - 3600000).toISOString() });
  const judge = (runs = [green()], options = {}) => realEngineVerdict(runs, SHA, { now, jobsFor: jobs, ...options });
  it("accepts five explicit passing engine jobs on the RC", () => expect(judge().state).toBe("pass"));
  it("refuses absent and ancestor-only evidence", () => {
    expect(judge([]).state).toBe("none");
    expect(judge([green(), { ...green(), head_sha: OTHER }]).state).toBe("pass");
    expect(judge([{ ...green(), head_sha: OTHER }]).state).toBe("none");
  });
  it("never treats NOT-RUN, skipped, neutral, failed, or missing jobs as green", () => {
    for (const conclusion of ["NOT-RUN", "skipped", "neutral", "failure", null]) {
      const list = jobs(); list[2].conclusion = conclusion;
      expect(judge(undefined, { jobsFor: () => list }).state).toBe("fail");
    }
    expect(judge(undefined, { jobsFor: () => jobs().slice(1) }).state).toBe("fail");
    expect(judge(undefined, { jobsFor: () => [] }).state).toBe("fail");
  });
  it("requires the verdict step, including when a continued error leaves a job green", () => {
    for (const steps of [[], [{ name: "Real-engine verdict", conclusion: "skipped" }]]) {
      const list = jobs(); list[0].steps = steps;
      expect(judge(undefined, { jobsFor: () => list }).state).toBe("fail");
    }
  });
  it("expires each engine's evidence at 72 hours and refuses invalid or future dates", () => {
    for (const completed_at of [new Date(now - 72 * 3600000 - 1).toISOString(), "invalid", undefined, new Date(now + 1).toISOString()]) {
      const list = jobs(); list[0].completed_at = completed_at;
      expect(judge(undefined, { jobsFor: () => list }).state).toBe("fail");
    }
    const list = jobs(); list[0].completed_at = new Date(now - 72 * 3600000).toISOString();
    expect(judge(undefined, { jobsFor: () => list }).state).toBe("pass");
  });
  it("waits for the RC run and refuses a newer failure over an older pass", () => {
    expect(judge([green(), { ...green(), id: 2, status: "in_progress" }]).state).toBe("wait");
    const newer = { ...green(), id: 2, created_at: new Date(now).toISOString() };
    expect(judge([green(), newer], { jobsFor: r => r.id === 2 ? [] : jobs() }).state).toBe("fail");
  });
  it("the explicit waiver is off by default, dispatch-only, SHA-bound and records a reason", () => {
    expect(judge([]).state).toBe("none");
    const explicitWaiver = `${SHA}: runner unavailable; reviewed by release owner`;
    expect(judge([], { explicitWaiver, eventName: "workflow_dispatch" })).toMatchObject({ state: "waived" });
    for (const options of [{ explicitWaiver }, { explicitWaiver, eventName: "push" },
      { explicitWaiver: "true", eventName: "workflow_dispatch" },
      { explicitWaiver: `${OTHER}: runner unavailable`, eventName: "workflow_dispatch" },
      { explicitWaiver: `${SHA}: `, eventName: "workflow_dispatch" }]) expect(judge([], options).state).toBe("fail");
  });
});

describe("real-engine nightly wiring", () => {
  const nightly = parse(readFileSync(new URL('../.github/workflows/nightly.yml', import.meta.url), 'utf8'));
  const job = nightly.jobs['real-engine'];
  it("runs all five engines in isolated containers on the dedicated real-engine runner, at most two at once", () => {
    expect(job.strategy.matrix.engine).toEqual(['claude', 'codex', 'gemini', 'fuigo', 'opencode']);
    expect(job.strategy['max-parallel']).toBe(2);
    expect(job.strategy['fail-fast']).toBe(false);
    // MAIN RULING 1115-REAL-ENGINE-RUNNER: label stays real-engine; both jobs run only when MURAGE_REAL_ENGINE_RUNNER is 'on' (skipped, never queued, otherwise).
    expect(job['runs-on']).toContain('real-engine');
    expect(job.if).toContain("vars.MURAGE_REAL_ENGINE_RUNNER == 'on'");
    expect(job.if).toContain('always() && !cancelled()');
    expect(nightly.jobs['real-engine-package'].if).toContain("vars.MURAGE_REAL_ENGINE_RUNNER == 'on'");
    expect(nightly.jobs['real-engine-package']['runs-on']).toContain('real-engine');
    expect(job.container.image).toBeTruthy();
    expect(job.container.volumes.every(volume => volume.endsWith(':ro'))).toBe(true);
  });
  it("has a blocking verdict step and preserves NOT-RUN evidence even after failure", () => {
    const verdict = job.steps.find(step => step.name === 'Real-engine verdict');
    expect(verdict.run).toContain('hz-smooth.sh --nightly-real-engine');
    expect(verdict['continue-on-error']).toBeUndefined();
    expect(job['continue-on-error']).toBeUndefined();
    expect(job.steps.find(step => step.name === 'Preserve per-engine verdict').if).toBe('always()');
    expect(job.steps.findIndex(step => step.name === 'Existing engine prerequisites')).toBeLessThan(job.steps.indexOf(verdict));
  });
  it("builds once from this checkout and binds the packaged metadata to the RC", () => {
    expect(job.needs).toEqual(['real-engine-package']);
    const build = nightly.jobs['real-engine-package'].steps.find(step => step.name === 'Build the exact RC package');
    expect(build.env.SOURCE_SHA).toBe('${{ github.sha }}');
    expect(build.run).toContain('--config.extraMetadata.murageSourceSha=$SOURCE_SHA');
    // MAIN RULING INT-CONFLICT-DEFAULT 619386c4b7 60a100f02b: retain both slow and cloud-portal gates; real engines remain separately required.
    expect(nightly.jobs.nightly.needs).toEqual(['slow', 'cloud-portal']);
  });
});


it("an engine waiver cannot cover any independent nightly failure", () => {
  const run = { conclusion: "failure" };
  const jobs = [{ name: "nightly", conclusion: "success" }, { name: "slow", conclusion: "success" },
    { name: "real-engine (fuigo)", conclusion: "failure" }, { name: "package for real engines (RC SHA)", conclusion: "failure" }];
  expect(slowNightlyRun(run, jobs).conclusion).toBe("success");
  expect(slowNightlyRun(run, [...jobs, { name: "portal", conclusion: "failure" }]).conclusion).toBe("failure");
  expect(slowNightlyRun(run, jobs.filter(job => job.name !== "nightly")).conclusion).toBe("failure");
  expect(slowNightlyRun(run, [{ name: "nightly", conclusion: "success" }])).toBe(run);
});
