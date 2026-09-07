import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDirLeasePaths } from "./data-dir-lease.mjs";
import { restoredConnectionProfile } from "./restored-connections.mjs";
import { RestoreReviewRequiredError } from "./restore-errors.mjs";
export { RestoreReviewRequiredError } from "./restore-errors.mjs";

export const RESTORE_REVIEW_FILE = "restore-review.json";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
function exists(file) {
  try { return lstatSync(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw new RestoreReviewRequiredError(); }
}
export function readRestoreReview(dataDir) {
  const file = join(dataDir, RESTORE_REVIEW_FILE), stat = exists(file);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new RestoreReviewRequiredError();
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new RestoreReviewRequiredError(); }
}

/** Presence is fail-closed, including malformed files and dangling links.
 * No archived content or credential can bypass the startup barrier. */
export function assertRestoreReviewed(dataDir) {
  if (exists(`${dataDirLeasePaths(dataDir).leasePath}.restore.json`)) throw new RestoreReviewRequiredError();
  const review = readRestoreReview(dataDir);
  const profile = restoredConnectionProfile(dataDir);
  if (!review && !profile) return;
  if (!review || !profile || review.version !== 1 || review.status !== "reviewed" || review.policyVersion !== 1 ||
      review.connectionProfileId !== profile.id || !uuid.test(review.snapshotId) || !uuid.test(review.transactionId) ||
      !uuid.test(review.activationId) || !hash.test(review.archiveSha256) || !hash.test(review.reviewedTreeHash) ||
      !Number.isSafeInteger(review.activatedAt) || review.activatedAt < 0) throw new RestoreReviewRequiredError();
  // Losing config after activation must not recreate an automatic fleet.
  const file = join(dataDir, "config.json"), stat = exists(file);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 ** 2) throw new RestoreReviewRequiredError();
  let config;
  try { config = JSON.parse(readFileSync(file, "utf8")); } catch { throw new RestoreReviewRequiredError(); }
  if (config?.engineDiscovery !== "explicit" || !config.instances || typeof config.instances !== "object" || Array.isArray(config.instances)) throw new RestoreReviewRequiredError();
}
