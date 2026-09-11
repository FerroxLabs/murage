// Hold publication until GitHub's own digest for every draft asset matches the
// staged bytes.
//
// Names, upload state and a reported digest are deterministic, so a difference
// fails at once. GitHub computes digests asynchronously, so a digest that is
// not reported yet gets a bounded wait. If any digest is still absent after
// that wait the release is HELD: this exits non-zero, the workflow's Publish
// step never runs, and the draft and its uploads are left untouched.
//
// Resuming does not rebuild anything. Re-run the failed assemble job (the build
// jobs' artifacts are reused and identical or digest-pending uploads are kept),
// or run this against the retained artifacts:
//
//   node scripts/release-digests.mjs verify <version> <release-id> <assets-dir>
//
// RELEASE_DIGEST_POLL_ATTEMPTS / RELEASE_DIGEST_POLL_INTERVAL_MS only change how
// long it waits; no setting turns a missing or wrong digest into a pass.

import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { assertDraft, compareDraftAssets, draftAssetFailure, stagedDigests } from "./release-guard.mjs";

export const DEFAULT_DIGEST_POLL_ATTEMPTS = 6;
export const DEFAULT_DIGEST_POLL_INTERVAL_MS = 10_000;

export class DigestHold extends Error {
  constructor(unreported) {
    super(`HOLD: GitHub reported no digest after the bounded wait for ${unreported.length} asset(s): ${unreported.join(", ")}. ` +
      "Publication is refused and the draft is left untouched. Resume without rebuilding: re-run the failed assemble job, " +
      "or run `node scripts/release-digests.mjs verify <version> <release-id> <assets-dir>` against the retained artifacts.");
    this.name = "DigestHold";
    this.unreported = unreported;
  }
}

/** Poll draft metadata until every digest is reported and matches, a
 * non-waitable difference appears, or the bounded wait ends in a hold. */
export async function verifyDraftDigests({
  expected,
  view,
  attempts = DEFAULT_DIGEST_POLL_ATTEMPTS,
  intervalMs = DEFAULT_DIGEST_POLL_INTERVAL_MS,
  sleep = delay,
}) {
  let assets = view();
  for (let poll = 0; ; poll += 1) {
    const report = compareDraftAssets(expected, assets);
    const failure = draftAssetFailure(report);
    if (failure) throw new Error(`draft assets do not match the staged bytes (${failure})`);
    if (report.unreported.length === 0) return { assets: expected.size, polls: poll };
    if (poll >= attempts) throw new DigestHold(report.unreported);
    await sleep(intervalMs);
    assets = view();
  }
}

/** Verify one retained draft against a staged assets directory. Every view goes
 * through assertDraft, so a published or immutable release is refused. */
export async function verifyRelease({ version, releaseId, assetsDir, run, attempts, intervalMs, sleep }) {
  const id = Number(releaseId);
  const expected = stagedDigests(assetsDir);
  return verifyDraftDigests({
    expected,
    view: () => assertDraft(version, id, run).assets,
    attempts,
    intervalMs,
    sleep,
  });
}

function boundedInteger(name, fallback, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) > max) throw new Error(`${name} must be an integer from 0 to ${max}`);
  return Number(raw);
}

async function main([command, ...args]) {
  if (command !== "verify" || args.length !== 3) {
    throw new Error("usage: release-digests.mjs verify <version> <release-id> <assets-dir>");
  }
  const [version, releaseId, assetsDir] = args;
  const result = await verifyRelease({
    version,
    releaseId,
    assetsDir,
    attempts: boundedInteger("RELEASE_DIGEST_POLL_ATTEMPTS", DEFAULT_DIGEST_POLL_ATTEMPTS, 60),
    intervalMs: boundedInteger("RELEASE_DIGEST_POLL_INTERVAL_MS", DEFAULT_DIGEST_POLL_INTERVAL_MS, 60_000),
  });
  console.log(`ok: the draft has ${result.assets} assets, all digest-verified`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
