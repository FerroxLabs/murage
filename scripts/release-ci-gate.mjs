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
import { spawnSync } from "node:child_process";

/** What the runs for `sha` say: pass, fail, wait (still running) or none. */
export function ciVerdict(runs, sha) {
  const mine = (Array.isArray(runs) ? runs : []).filter(run => run?.head_sha === sha);
  if (mine.length === 0) return { state: "none", reason: `no CI run found for ${sha}` };
  // Newest attempt wins: a re-run that went green replaces the red one.
  const newest = [...mine].sort((a, b) => (Number(b.run_attempt ?? 1) - Number(a.run_attempt ?? 1)) || (Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0)))[0];
  if (newest.status !== "completed") return { state: "wait", reason: `CI is ${newest.status ?? "not finished"} for ${sha}` };
  if (newest.conclusion === "success") return { state: "pass", reason: `CI concluded success for ${sha}` };
  return { state: "fail", reason: `CI concluded ${newest.conclusion ?? "without a result"} for ${sha}` };
}

function listRuns({ repository, workflow, sha }) {
  const result = spawnSync("gh", ["api", `repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=50`, "--jq", ".workflow_runs"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`gh api failed: ${(result.stderr || result.stdout).trim()}`);
  return JSON.parse(result.stdout || "[]");
}

async function main() {
  const sha = String(process.env.SHA ?? "");
  const repository = process.env.GITHUB_REPOSITORY;
  const workflow = process.env.CI_WORKFLOW || "ci.yml";
  if (!/^[0-9a-f]{40}$/.test(sha) || !repository) {
    console.error("::error::release-ci-gate needs SHA (40 hex) and GITHUB_REPOSITORY");
    process.exit(2);
  }
  const waitMs = Number(process.env.CI_WAIT_MINUTES ?? 75) * 60_000;
  const graceMs = Number(process.env.CI_GRACE_MINUTES ?? 10) * 60_000;
  const started = Date.now();
  for (;;) {
    const verdict = ciVerdict(listRuns({ repository, workflow, sha }), sha);
    if (verdict.state === "pass") { console.log(`ok: ${verdict.reason}`); return; }
    if (verdict.state === "fail") { console.error(`::error::${verdict.reason}; refusing to release a commit CI did not pass`); process.exit(1); }
    const elapsed = Date.now() - started;
    if (verdict.state === "none" && elapsed >= graceMs) { console.error(`::error::${verdict.reason} after ${Math.round(elapsed / 60000)} minutes; refusing to release an untested commit`); process.exit(1); }
    if (verdict.state === "wait" && elapsed >= waitMs) { console.error(`::error::${verdict.reason} after ${Math.round(elapsed / 60000)} minutes; refusing`); process.exit(1); }
    console.log(`${verdict.reason}; checking again in 60s`);
    await new Promise(resolve => setTimeout(resolve, 60_000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
