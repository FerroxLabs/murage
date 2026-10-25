#!/usr/bin/env node
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A release must not be cut from a commit the CI workflow never passed
// (0.1.62 audit C8). The prepare job runs this against the pinned SHA:
//
//   SHA=<40 hex> GH_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/release-ci-gate.mjs
//
// It lists the CI workflow's runs for that exact commit through `gh api` and
// exits 0 only when the newest attempt concluded `success`. A merge to main
// starts CI and Release together, so a run that is still queued or in progress
// is waited for (bounded); no run at all is given a short grace period to
// appear, then refused. Cancelled, skipped, failed and timed-out all refuse.
//
// One narrow exception: a reviewed, approved waiver (docs/releases/ci-waiver-template.md).
// CI_WAIVER names a waiver file; it is honoured only on a workflow_dispatch run,
// only when the file is committed in the pinned commit, names that commit and
// the exact CI run that failed for it, states "Critical: 0", lists the reviewed
// failure classes and carries an approval line. Anything else stays strict.
//
// The latest nightly (nightly.yml: the tests over 60 s on all three OSes and
// the wall-clock budget tests on the build host perf job, tagged out of CI's
// shards in vite.config.ts) must be green too: its newest completed run must
// have concluded success, on the pinned commit or one of its ancestors, and be
// no older than NIGHTLY_MAX_AGE_HOURS (72). No waiver covers it. The release
// builds run beside CI, so both checks wait (CI_WAIT_MINUTES, default 240) for
// a still-running CI or nightly run on the pinned commit to complete.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

/** Newest attempt first: a re-run that went green replaces the red one. */
function newestRun(runs, sha) {
  const mine = (Array.isArray(runs) ? runs : []).filter(run => run?.head_sha === sha);
  return [...mine].sort((a, b) => (Number(b.run_attempt ?? 1) - Number(a.run_attempt ?? 1)) || (Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0)))[0];
}

/** What the runs for `sha` say: pass, fail, wait (still running) or none. */
export function ciVerdict(runs, sha) {
  const newest = newestRun(runs, sha);
  if (!newest) return { state: "none", reason: `no CI run found for ${sha}` };
  if (newest.status !== "completed") return { state: "wait", reason: `CI is ${newest.status ?? "not finished"} for ${sha}` };
  if (newest.conclusion === "success") return { state: "pass", reason: `CI concluded success for ${sha}` };
  return { state: "fail", run: newest, reason: `CI concluded ${newest.conclusion ?? "without a result"} for ${sha}` };
}

/**
 * What the newest completed nightly run says about releasing `sha`.
 * `ancestor(runSha)` answers whether that run's commit is `sha` or one of its ancestors.
 */
export function nightlyVerdict(runs, sha, { ancestor, now = Date.now(), maxAgeHours = 72 } = {}) {
  const done = (Array.isArray(runs) ? runs : []).filter(run => run?.status === "completed");
  const newest = [...done].sort((a, b) => Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0))[0];
  if (!newest) return { ok: false, reason: "no completed nightly run found" };
  const where = `nightly run ${newest.id ?? "?"} on ${newest.head_sha ?? "?"}`;
  if (newest.conclusion !== "success") return { ok: false, run: newest, reason: `the latest ${where} concluded ${newest.conclusion ?? "without a result"}` };
  if (newest.head_sha !== sha && !(ancestor && ancestor(newest.head_sha))) return { ok: false, run: newest, reason: `the latest ${where} is not ${sha} or one of its ancestors` };
  const ageHours = (now - Date.parse(newest.created_at ?? 0)) / 3_600_000;
  if (!(ageHours <= maxAgeHours)) return { ok: false, run: newest, reason: `the latest ${where} is ${Math.round(ageHours)} h old (limit ${maxAgeHours} h)` };
  return { ok: true, run: newest, reason: `the latest ${where} concluded success` };
}

/**
 * Whether a nightly run for exactly `sha` has not completed yet. The gate waits
 * for it (its verdict is the one that matters for this commit) instead of
 * judging an older completed run.
 */
export function nightlyPending(runs, sha) {
  return (Array.isArray(runs) ? runs : []).some(run => run?.head_sha === sha && run.status !== "completed");
}

/**
 * A nightly verdict worth polling again: nothing completed yet, not on this
 * history, or too old (someone can still dispatch a fresh nightly while the
 * builds run). A completed red run is final and never retried.
 */
export function nightlyRetryable(verdict) {
  return !verdict.ok && (!verdict.run || verdict.run.conclusion === "success");
}

/** Files whose change makes an older native-addon-msvc run stale (they match the workflow's own path filter). */
export const NATIVE_ADDON_PATHS = [
  "native", "scripts/build-engine-exclusion.mjs", "scripts/build-fuigo-probe.mjs", "scripts/windows-native-imports.mjs",
  "electron/windows-native.mjs", "electron/backup-windows-acl*.mjs", "electron/backup-remote-*.mjs", "shared/windows-sddl.mjs",
  ".github/workflows/native-addon-msvc.yml",
];

/**
 * The real-Windows owner-only ACL tests (native-addon-msvc.yml, MURAGE_REQUIRE_WINDOWS_NATIVE=1) run only when
 * their files change, so CI never sees them. A release needs the newest completed run on this history green, built
 * from a workflow that really runs those tests, with none of the watched files changed since it ran.
 * `ancestor(runSha)`: that commit is `sha` or an ancestor. `stale(runSha)`: a watched file differs between it and `sha`.
 * `runsAcl(runSha)`: the workflow at that commit sets MURAGE_REQUIRE_WINDOWS_NATIVE.
 */
export function nativeAddonVerdict(runs, sha, { ancestor, stale, runsAcl } = {}) {
  const mine = (Array.isArray(runs) ? runs : []).filter(run => run?.status === "completed" && run.head_sha && (run.head_sha === sha || (ancestor && ancestor(run.head_sha))));
  const newest = [...mine].sort((a, b) => Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0))[0];
  if (!newest) return { ok: false, reason: `no completed native-addon-msvc run on ${sha} or its ancestors (dispatch native-addon-msvc.yml on the release commit)` };
  const where = `native-addon-msvc run ${newest.id ?? "?"} on ${newest.head_sha}`;
  if (newest.conclusion !== "success") return { ok: false, run: newest, reason: `the latest ${where} concluded ${newest.conclusion ?? "without a result"}` };
  if (!(runsAcl && runsAcl(newest.head_sha))) return { ok: false, run: newest, reason: `the workflow in ${where} does not run the ACL tests with MURAGE_REQUIRE_WINDOWS_NATIVE=1` };
  if (newest.head_sha !== sha && (!stale || stale(newest.head_sha))) return { ok: false, run: newest, reason: `files the ACL tests cover changed between ${where} and ${sha}` };
  return { ok: true, run: newest, reason: `the latest ${where} concluded success with the ACL tests required` };
}

// Who may sign a waiver. Sean approves every release exception.
const APPROVER = /^Sean(\s+Donahoe)?$/i;
const SAFE_PATH = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/-]+$/;

function single(text, pattern, label) {
  const hits = [...text.matchAll(pattern)];
  if (hits.length !== 1) throw new Error(hits.length ? `waiver has ${hits.length} "${label}" lines; it must have exactly one` : `waiver has no "${label}" line`);
  return hits[0];
}

/**
 * Reads a waiver file (format in docs/releases/ci-waiver-template.md). Every
 * key line starts at column 0 and appears once; anything else is free prose.
 */
export function parseWaiver(text) {
  const body = String(text ?? "").replace(/\r\n/g, "\n");
  const commit = single(body, /^Commit:[ \t]*(\S*)[ \t]*$/gm, "Commit:")[1];
  const runId = single(body, /^CI run:[ \t]*(\S*)[ \t]*$/gm, "CI run:")[1];
  const critical = single(body, /^Critical:[ \t]*(\S*)[ \t]*$/gm, "Critical:")[1];
  const approval = single(body, /^Approved-by:[ \t]*(.*?)[ \t]*$/gm, "Approved-by:")[1];
  const heading = single(body, /^Reviewed failure classes:[ \t]*$/gm, "Reviewed failure classes:");
  const classes = [];
  for (const line of body.slice(heading.index + heading[0].length).split("\n").slice(1)) {
    const item = /^- +(\S.*?)\s*$/.exec(line);
    if (!item) break;
    classes.push(item[1]);
  }
  const signed = /^([A-Za-z][A-Za-z .'-]*?) on (\d{4}-\d{2}-\d{2})$/.exec(approval);
  // Each class names the test files it covers in backticks; those names are what the gate checks CI's reds against.
  const classTests = classes.map(item => [...item.matchAll(TEST_FILE_IN_CLASS)].map(match => match[1]));
  return { commit, runId, critical, classes, classTests, tests: [...new Set(classTests.flat())], approver: signed?.[1] ?? null, date: signed?.[2] ?? null, approval };
}

const TEST_FILE_IN_CLASS = /`([A-Za-z0-9._/-]+\.test\.[cm]?[jt]sx?)`/g;
const TEST_FILE = /^[A-Za-z0-9._/-]+\.test\.[cm]?[jt]sx?$/;

/**
 * The failing test files a CI job log names: vitest's "FAIL  <file> > <test>" lines (and "FAIL  <file>" for a file that
 * failed as a whole). ANSI colour and the Actions timestamp prefix are stripped first.
 */
export function failedTestsInLog(log) {
  const files = new Set();
  for (const raw of String(log ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/, "");
    const hit = /^\s*FAIL\s+(\S+)(?:\s|$)/.exec(line);
    if (hit && TEST_FILE.test(hit[1])) files.add(hit[1]);
  }
  return [...files];
}

/**
 * Whether every red in the waived CI run lies inside the waiver's named classes. `jobs` are the run's jobs (newest attempt)
 * as [{ name, conclusion, failedTests }] where failedTests is what failedTestsInLog read from that job's log. A job marked
 * non-blocking in its name, and the aggregate job that only reports the others, are not judged. Any other job that did not
 * succeed must have failed on tests, every one of them named by a class: a job that failed with no test named (a build,
 * install or setup failure, a cancel, a timeout) or on a test no class names refuses the waiver.
 */
export function failuresVerdict({ waiver, jobs, aggregateJob = "required CI completion" }) {
  const waived = new Set(waiver.tests ?? []);
  const outside = [];
  for (const job of jobs ?? []) {
    if (["success", "skipped", "neutral"].includes(job.conclusion)) continue;
    if (/non-blocking/i.test(String(job.name)) || job.name === aggregateJob) continue;
    const failed = job.failedTests ?? [];
    if (job.conclusion !== "failure" || failed.length === 0) {
      return { ok: false, reason: `job "${job.name}" ended ${job.conclusion ?? "without a result"} with no failing test named in its log; only named test failures can be waived` };
    }
    for (const file of failed) if (!waived.has(file)) outside.push(`${file} (${job.name})`);
  }
  if (outside.length) return { ok: false, reason: `CI failed outside the waiver's classes: ${outside.join(", ")}` };
  return { ok: true, reason: `every failing test in the run is named by a waiver class` };
}

function realDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Whether a waiver lets a red CI through. `ok` is true only when every rule
 * holds; the reason names the first rule that did not.
 */
export function waiverVerdict({ eventName, waiverPath, waiverText, sha, runs }) {
  const refuse = reason => ({ ok: false, reason });
  if (!waiverPath) return refuse("no waiver given; CI must pass");
  if (eventName !== "workflow_dispatch") return refuse(`a ${eventName || "non-dispatch"} run can never waive CI`);
  if (!SAFE_PATH.test(waiverPath)) return refuse(`waiver path ${JSON.stringify(waiverPath)} is not a plain repository path`);
  if (waiverText == null) return refuse(`waiver ${waiverPath} is not in the dispatch commit`);
  let waiver;
  try { waiver = parseWaiver(waiverText); } catch (error) { return refuse(error.message); }
  if (waiver.commit !== sha) return refuse(`waiver names commit ${waiver.commit || "(none)"}, not the pinned ${sha}`);
  if (!/^[1-9]\d*$/.test(waiver.runId)) return refuse(`waiver CI run ${JSON.stringify(waiver.runId)} is not a run id`);
  const verdict = ciVerdict(runs, sha);
  if (verdict.state !== "fail") return refuse(`CI for ${sha} is not a completed failure (${verdict.reason}); nothing to waive`);
  if (String(verdict.run.id) !== waiver.runId) return refuse(`waiver names CI run ${waiver.runId}, but the CI run that decided ${sha} is ${verdict.run.id}`);
  if (waiver.critical !== "0") return refuse(`waiver states Critical: ${waiver.critical || "(blank)"}; only Critical: 0 can be waived`);
  if (waiver.classes.length === 0) return refuse("waiver lists no reviewed failure classes");
  const unnamed = waiver.classes.filter((_, index) => waiver.classTests[index].length === 0);
  if (unnamed.length) return refuse(`waiver class ${JSON.stringify(unnamed[0])} names no test file; name each covered test file in backticks`);
  if (!waiver.approver || !waiver.date) return refuse(`approval line ${JSON.stringify(waiver.approval)} must read "Approved-by: <name> on YYYY-MM-DD"`);
  if (!APPROVER.test(waiver.approver)) return refuse(`waiver approved by ${waiver.approver}; only Sean can approve a CI waiver`);
  if (!realDate(waiver.date)) return refuse(`approval date ${waiver.date} is not a real date`);
  return {
    ok: true,
    reason: `CI run ${waiver.runId} for ${sha} waived by ${waiverPath} (approved by ${waiver.approver} on ${waiver.date}; ${waiver.classes.length} reviewed failure classes)`,
    waiver: { ...waiver, path: waiverPath, run: verdict.run, sha256: createHash("sha256").update(String(waiverText)).digest("hex") },
  };
}

function listRuns({ repository, workflow, sha }) {
  const result = spawnSync("gh", ["api", `repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=50`, "--jq", ".workflow_runs"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`gh api failed: ${(result.stderr || result.stdout).trim()}`);
  return JSON.parse(result.stdout || "[]");
}

/** The jobs of a run's newest attempt, each with the failing test files its log names (logs only for jobs that did not succeed). */
function listRunJobs({ repository, run }) {
  const attempt = Number(run.run_attempt) > 0 ? Number(run.run_attempt) : 1;
  const result = spawnSync("gh", ["api", "--paginate", `repos/${repository}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`, "--jq", ".jobs[]"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`gh api failed: ${(result.stderr || result.stdout).trim()}`);
  const jobs = String(result.stdout).split("\n").filter(Boolean).map(line => JSON.parse(line));
  return jobs.map(job => {
    if (["success", "skipped", "neutral"].includes(job.conclusion)) return { name: job.name, conclusion: job.conclusion, failedTests: [] };
    const log = spawnSync("gh", ["api", `repos/${repository}/actions/jobs/${job.id}/logs`], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (log.status !== 0) throw new Error(`could not read the log of job "${job.name}": ${(log.stderr || log.stdout).trim()}`);
    return { name: job.name, conclusion: job.conclusion, failedTests: failedTestsInLog(log.stdout) };
  });
}

function listNightlyRuns({ repository, workflow }) {
  const result = spawnSync("gh", ["api", `repos/${repository}/actions/workflows/${workflow}/runs?per_page=30`, "--jq", ".workflow_runs"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`gh api failed: ${(result.stderr || result.stdout).trim()}`);
  return JSON.parse(result.stdout || "[]");
}

/** The waiver as committed in `ref` (not the working tree), or null when it is not there. */
function readCommitted(ref, file) {
  const result = spawnSync("git", ["show", `${ref}:${file}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
}

/** True when `sha` is `ref` or one of its ancestors. */
function isAncestor(sha, ref) {
  return spawnSync("git", ["merge-base", "--is-ancestor", sha, ref]).status === 0;
}

/** True when a watched native-addon file differs between `from` and `to`. Fails closed (true) if git cannot tell. */
function nativeFilesChanged(from, to) {
  const result = spawnSync("git", ["diff", "--quiet", from, to, "--", ...NATIVE_ADDON_PATHS]);
  return result.status !== 0;
}

function record(lines, outputs) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  if (process.env.GITHUB_OUTPUT && Object.keys(outputs).length) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
}

async function main() {
  const sha = String(process.env.SHA ?? "");
  const repository = process.env.GITHUB_REPOSITORY;
  const workflow = process.env.CI_WORKFLOW || "ci.yml";
  const waiverPath = String(process.env.CI_WAIVER ?? "").trim();
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha) || !repository) {
    console.error("::error::release-ci-gate needs SHA (40 hex) and GITHUB_REPOSITORY");
    process.exit(2);
  }
  if (waiverPath && eventName !== "workflow_dispatch") {
    console.error(`::error::a ${eventName || "non-dispatch"} run can never waive CI; refusing`);
    process.exit(1);
  }
  const nightlyWorkflow = process.env.NIGHTLY_WORKFLOW || "nightly.yml";
  const waitMs = Number(process.env.CI_WAIT_MINUTES ?? 240) * 60_000;
  const graceMs = Number(process.env.CI_GRACE_MINUTES ?? 10) * 60_000;
  const started = Date.now();
  const judgeNightly = () => {
    const nightlyRuns = listNightlyRuns({ repository, workflow: nightlyWorkflow });
    return {
      nightlyRuns,
      pending: nightlyPending(nightlyRuns, sha),
      nightly: nightlyVerdict(nightlyRuns, sha, {
        ancestor: runSha => /^[0-9a-f]{40}$/.test(String(runSha)) && isAncestor(runSha, sha),
        maxAgeHours: Number(process.env.NIGHTLY_MAX_AGE_HOURS ?? 72),
      }),
    };
  };
  // Judged again right before the gate passes: CI may have taken hours, and a
  // nightly that was fresh and green at the start can have aged out or been
  // beaten by a newer red one. Strict: no waiting here.
  const recheckNightly = () => {
    const { pending, nightly } = judgeNightly();
    if (nightly.ok && !pending) return;
    console.error(`::error::${pending ? `a ${nightlyWorkflow} run for ${sha} has not completed` : nightly.reason} (rechecked after CI); refusing`);
    process.exit(1);
  };
  // The builds run beside CI, so the nightly may still be running (or about to
  // be dispatched) when this starts: wait, bounded, for it to complete. Only a
  // completed, green, recent nightly on this history passes; a completed red
  // one fails at once.
  for (;;) {
    const { pending, nightly } = judgeNightly();
    if (nightly.ok && !pending) {
      console.log(`ok: ${nightly.reason}`);
      record([`Nightly gate: ${nightly.reason}`], {});
      break;
    }
    const final = !nightly.ok && !pending && !nightlyRetryable(nightly);
    const elapsed = Date.now() - started;
    if (final || elapsed >= waitMs) {
      console.error(`::error::${pending ? `a ${nightlyWorkflow} run for ${sha} has not completed` : nightly.reason}${elapsed >= waitMs ? ` after ${Math.round(elapsed / 60000)} minutes` : ""}; a release needs the latest ${nightlyWorkflow} green (run it on this commit with workflow_dispatch)`);
      process.exit(1);
    }
    console.log(`${pending ? `a ${nightlyWorkflow} run for ${sha} is still running` : nightly.reason}; checking again in 60s`);
    await new Promise(resolve => setTimeout(resolve, 60_000));
  }
  // The Windows ACL tests live in native-addon-msvc.yml, outside ci.yml: required here, no waiver, bounded wait for a running one.
  const nativeWorkflow = process.env.NATIVE_ADDON_WORKFLOW || "native-addon-msvc.yml";
  for (;;) {
    const nativeRuns = listNightlyRuns({ repository, workflow: nativeWorkflow });
    const native = nativeAddonVerdict(nativeRuns, sha, {
      ancestor: runSha => /^[0-9a-f]{40}$/.test(String(runSha)) && isAncestor(runSha, sha),
      stale: runSha => nativeFilesChanged(runSha, sha),
      runsAcl: runSha => (readCommitted(runSha, `.github/workflows/${nativeWorkflow}`) ?? "").includes("MURAGE_REQUIRE_WINDOWS_NATIVE"),
    });
    const pending = nativeRuns.some(run => run?.status !== "completed" && /^[0-9a-f]{40}$/.test(String(run?.head_sha)) && (run.head_sha === sha || isAncestor(run.head_sha, sha)));
    if (native.ok && !pending) { console.log(`ok: ${native.reason}`); record([`Windows ACL gate: ${native.reason}`], {}); break; }
    const elapsed = Date.now() - started;
    if ((!pending && native.run && native.run.conclusion !== "success") || elapsed >= waitMs) {
      console.error(`::error::${pending ? `a ${nativeWorkflow} run on this history has not completed` : native.reason}${elapsed >= waitMs ? ` after ${Math.round(elapsed / 60000)} minutes` : ""}; a release needs ${nativeWorkflow} green on this commit (run it with workflow_dispatch)`);
      process.exit(1);
    }
    console.log(`${pending ? `a ${nativeWorkflow} run is still running` : native.reason}; checking again in 60s`);
    await new Promise(resolve => setTimeout(resolve, 60_000));
  }
  for (;;) {
    const runs = listRuns({ repository, workflow, sha });
    const verdict = ciVerdict(runs, sha);
    if (verdict.state === "pass") {
      recheckNightly();
      console.log(`ok: ${verdict.reason}`);
      record([`CI gate: ${verdict.reason}${waiverPath ? ` (waiver ${waiverPath} not needed)` : ""}`], { waived: "false" });
      return;
    }
    if (verdict.state === "fail") {
      if (!waiverPath) { console.error(`::error::${verdict.reason}; refusing to release a commit CI did not pass`); process.exit(1); }
      // A file cannot name the commit that contains it, so the waiver is read
      // from the commit this run was dispatched from (WAIVER_FROM, github.sha),
      // which must descend from the pinned commit.
      const waiverFrom = /^[0-9a-f]{40}$/.test(process.env.WAIVER_FROM ?? "") ? process.env.WAIVER_FROM : sha;
      if (!isAncestor(sha, waiverFrom)) { console.error(`::error::${verdict.reason}; waiver refused: dispatch commit ${waiverFrom} does not descend from the pinned ${sha}`); process.exit(1); }
      const result = waiverVerdict({ eventName, waiverPath, waiverText: readCommitted(waiverFrom, waiverPath), sha, runs });
      if (!result.ok) { console.error(`::error::${verdict.reason}; waiver refused: ${result.reason}`); process.exit(1); }
      recheckNightly();
      // The waiver covers its named classes only: every red in the run must be one of the test files they name.
      let covered;
      try { covered = failuresVerdict({ waiver: result.waiver, jobs: listRunJobs({ repository, run: verdict.run }) }); }
      catch (error) { covered = { ok: false, reason: error.message }; }
      if (!covered.ok) { console.error(`::error::${verdict.reason}; waiver refused: ${covered.reason}`); process.exit(1); }
      console.log(`ok: ${covered.reason}`);
      const { waiver } = result;
      console.log(`::warning::${result.reason}`);
      record([
        "## CI waiver used",
        "",
        `- Commit: \`${sha}\``,
        `- Failing CI run: [${waiver.runId}](${waiver.run.html_url ?? ""}) (${waiver.run.conclusion})`,
        `- Waiver file: \`${waiver.path}\` (sha256 \`${waiver.sha256}\`)`,
        `- Critical: ${waiver.critical}`,
        `- Approved by ${waiver.approver} on ${waiver.date}`,
        "- Reviewed failure classes:",
        ...waiver.classes.map(item => `  - ${item}`),
      ], {
        waived: "true",
        waiver_path: waiver.path,
        waiver_sha256: waiver.sha256,
        waiver_run: waiver.runId,
        waiver_run_url: String(waiver.run.html_url ?? "").replace(/[\r\n]/g, ""),
        waiver_approval: `${waiver.approver} on ${waiver.date}`,
      });
      return;
    }
    const elapsed = Date.now() - started;
    if (verdict.state === "none" && elapsed >= graceMs) { console.error(`::error::${verdict.reason} after ${Math.round(elapsed / 60000)} minutes; refusing to release an untested commit`); process.exit(1); }
    if (verdict.state === "wait" && elapsed >= waitMs) { console.error(`::error::${verdict.reason} after ${Math.round(elapsed / 60000)} minutes; refusing`); process.exit(1); }
    console.log(`${verdict.reason}; checking again in 60s`);
    await new Promise(resolve => setTimeout(resolve, 60_000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
