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

import { ciVerdict, nativeAddonVerdict, nightlyPending, nightlyRetryable, nightlyVerdict, parseWaiver, waiverVerdict } from "./release-ci-gate.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const PATH = "docs/releases/ci-waivers/1.0.2.md";
const run = (over = {}) => ({ id: 4242, head_sha: SHA, status: "completed", conclusion: "failure", run_attempt: 1, created_at: "2026-10-16T10:00:00Z", html_url: "https://github.com/o/r/actions/runs/4242", ...over });
const waiver = ({ commit = SHA, runId = "4242", critical = "0", classes = ["Windows shard timeout: known flake, green on re-run"], approval = "Sean Donahoe on 2026-10-16" } = {}) => [
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
const dispatch = (over = {}) => ({ eventName: "workflow_dispatch", waiverPath: PATH, waiverText: waiver(), sha: SHA, runs: [run()], ...over });

describe("strict by default", () => {
  it("a red CI without a waiver is still a failure", () => {
    expect(ciVerdict([run()], SHA).state).toBe("fail");
    const result = waiverVerdict(dispatch({ waiverPath: "" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no waiver/);
  });
  it("a green CI still passes on its own", () => {
    expect(ciVerdict([run({ conclusion: "success" })], SHA).state).toBe("pass");
  });
});

describe("a valid waiver", () => {
  it("passes a red CI and reports what it waived", () => {
    const result = waiverVerdict(dispatch());
    expect(result.ok).toBe(true);
    expect(result.waiver).toMatchObject({ commit: SHA, runId: "4242", critical: "0", approver: "Sean Donahoe", date: "2026-10-16", path: PATH });
    expect(result.waiver.classes).toEqual(["Windows shard timeout: known flake, green on re-run"]);
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
  it("assemble writes the waiver into the draft notes before uploading", () => {
    const steps = release.jobs.assemble.steps;
    const record = steps.findIndex(s => s.if === "needs.ci-gate.outputs.waived == 'true'");
    expect(record).toBeGreaterThan(-1);
    expect(steps[record].run).toContain("release-notes.md");
    expect(record).toBeLessThan(steps.findIndex(s => s.id === "upload"));
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
  it("builds need only prepare (mac-x64 also mac) and never ci-gate", () => {
    expect(needs("mac")).toEqual(["prepare"]);
    expect(needs("windows")).toEqual(["prepare"]);
    expect(needs("linux")).toEqual(["prepare"]);
    expect(needs("mac-x64")).toEqual(["prepare", "mac"]);
  });
  it("only prepare's deleted preflight probe and assemble hold the release token, and assemble needs the gate and every build", () => {
    expect(needs("assemble")).toEqual(expect.arrayContaining(["prepare", "ci-gate", "mac", "mac-x64", "windows", "linux"]));
    const writers = Object.entries(release.jobs).filter(([, job]) => JSON.stringify(job).includes("RELEASES_PAT")).map(([name]) => name);
    // prepare only reads plus creates and at once deletes a throwaway draft (a token probe, no tag);
    // every real draft, upload and publish step lives in assemble, behind ci-gate.
    expect(writers).toEqual(["prepare", "assemble"]);
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
