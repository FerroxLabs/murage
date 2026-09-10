import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDirLeasePaths } from "./data-dir-lease.mjs";
import { readRestoreReview } from "./restore-review.mjs";
import { restoredConnectionProfile } from "./restored-connections.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const fail = () => { throw Object.assign(new Error("The saved installation selection requires recovery. Retained data was not changed."), { code: "INSTALLATION_SELECTION_INVALID" }); };
const canonical = value => dataDirLeasePaths(value).canonicalDataDir;
const digest = value => createHash("sha256").update(value).digest("hex");
function entry(file) { try { return lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
function directory(file) { const stat = entry(file); if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(); return stat; }
function identity(file) { const stat = directory(file); return { dev: String(stat.dev), ino: String(stat.ino) }; }
const sameIdentity = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino;
function overlap(a, b) {
  // Match the lease's conservative Darwin path identity.
  if (process.platform === "darwin") { a = a.normalize("NFC").toLowerCase(); b = b.normalize("NFC").toLowerCase(); }
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}
function locations(userData, requestedRoot, id) {
  directory(userData);
  const profile = canonical(userData), requested = canonical(requestedRoot);
  const storage = path.join(profile, "recovered-installations");
  if (entry(storage)) directory(storage);
  if (canonical(storage) !== storage) fail();
  const selector = path.join(profile, `installation-selection-${digest(dataDirLeasePaths(requested).leasePath)}.json`);
  const container = id ? path.join(storage, id) : null;
  return { requested, storage, selector, container, dataDirectory: container ? path.join(container, "data") : null };
}
function bytes(file) {
  const stat = entry(file);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16_384) fail();
  return readFileSync(file, "utf8");
}
function parse(raw) {
  let value; try { value = JSON.parse(raw); } catch { fail(); }
  if (!value || Object.keys(value).sort().join() !== ["version", "id", "requestedRoot", "originalRoot", "containerIdentity", "snapshotId", "archiveSha256", "transactionId"].sort().join() ||
      value.version !== 1 || !uuid.test(value.id) || !uuid.test(value.snapshotId) || !uuid.test(value.transactionId) || !hash.test(value.archiveSha256) ||
      typeof value.requestedRoot !== "string" || typeof value.originalRoot !== "string" || !value.containerIdentity ||
      Object.keys(value.containerIdentity).sort().join() !== "dev,ino" || !/^\d+$/.test(value.containerIdentity.dev) || !/^\d+$/.test(value.containerIdentity.ino)) fail();
  return value;
}
function validRestoredTarget(dataDirectory) {
  directory(dataDirectory);
  if (canonical(dataDirectory) !== dataDirectory) fail();
  const review = readRestoreReview(dataDirectory), connections = restoredConnectionProfile(dataDirectory);
  if (!review || !connections || review.version !== 1 || !["review-required", "reviewed"].includes(review.status) ||
      !uuid.test(review.transactionId) || !uuid.test(review.snapshotId) || !hash.test(review.archiveSha256)) fail();
  return review;
}
function syncParent(file) {
  if (process.platform === "win32") return;
  const fd = openSync(path.dirname(file), "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Selection is scoped to the exact requested root. Never falls back when a
 * selected installation is missing, redirected or lacks its restore barrier. */
export function resolveInstallationSelection(userData, requestedRoot) {
  const initial = locations(userData, requestedRoot), raw = bytes(initial.selector);
  if (raw === null) return { dataDirectory: initial.requested, selected: false };
  const record = parse(raw), places = locations(userData, requestedRoot, record.id);
  if (record.requestedRoot !== places.requested || overlap(places.storage, canonical(record.originalRoot)) ||
      !sameIdentity(identity(places.container), record.containerIdentity) || canonical(places.container) !== places.container ||
      bytes(path.join(places.container, "selection-record.json")) !== raw) fail();
  validRestoredTarget(places.dataDirectory);
  return { dataDirectory: places.dataDirectory, selected: true, originalRoot: record.originalRoot };
}

/** A main-owned plan names a new leaf but performs no write before consent. */
export function planSeparateInstallation(userData, requestedRoot, originalRoot) {
  const id = randomUUID(), places = locations(userData, requestedRoot, id), original = canonical(originalRoot);
  if (overlap(places.storage, original) || overlap(places.storage, places.requested) || entry(places.container)) fail();
  // Existing selector is validated before it can be deliberately replaced.
  resolveInstallationSelection(userData, requestedRoot);
  return Object.freeze({ ...places, userData, originalRoot: original, id, previous: bytes(places.selector) });
}

export function allocateSeparateInstallation(plan) {
  const current = locations(plan.userData, plan.requested, plan.id);
  if (current.dataDirectory !== plan.dataDirectory || bytes(current.selector) !== plan.previous || overlap(current.storage, plan.originalRoot)) fail();
  mkdirSync(current.storage, { recursive: true, mode: 0o700 });
  directory(current.storage);
  if (canonical(current.storage) !== current.storage) fail();
  mkdirSync(current.container, { mode: 0o700 }); // Exclusive; never adopts an existing destination.
  return Object.freeze({ ...plan, containerIdentity: identity(current.container) });
}

/** Publish only after a successful hash-bound restore and actual worker exit.
 * The new container/receipt remains retained if publication fails. */
export function publishInstallationSelection(plan, result) {
  const current = locations(plan.userData, plan.requested, plan.id);
  if (!sameIdentity(identity(current.container), plan.containerIdentity) || canonical(current.container) !== current.container ||
      bytes(current.selector) !== plan.previous || overlap(current.storage, plan.originalRoot)) fail();
  const review = validRestoredTarget(current.dataDirectory);
  if (result?.ok !== true || result.operation !== "restore" || result.status !== "restored-review-required" || result.activationAvailable !== false ||
      result.previousDataDir !== null || result.snapshotId !== review.snapshotId || (result.sha256 ?? result.archiveSha256) !== review.archiveSha256) fail();
  const receipt = path.join(current.container, `.data.restore-${review.transactionId}.receipt.json`);
  if (result.receipt !== receipt) fail();
  let transaction; try { transaction = JSON.parse(bytes(receipt)); } catch { fail(); }
  if (transaction?.version !== 1 || transaction.id !== review.transactionId || transaction.hadOriginal !== false || transaction.phase !== "candidate-installed" ||
      transaction.snapshotId !== review.snapshotId || transaction.archiveSha256 !== review.archiveSha256) fail();
  const record = { version: 1, id: plan.id, requestedRoot: plan.requested, originalRoot: plan.originalRoot, containerIdentity: plan.containerIdentity,
    snapshotId: review.snapshotId, archiveSha256: review.archiveSha256, transactionId: review.transactionId };
  const raw = JSON.stringify(record) + "\n";
  writeFileSync(path.join(current.container, "selection-record.json"), raw, { flag: "wx", mode: 0o600, flush: true });
  const pending = `${current.selector}.${plan.id}.pending`;
  writeFileSync(pending, raw, { flag: "wx", mode: 0o600, flush: true });
  try {
    if (bytes(current.selector) !== plan.previous) fail();
    renameSync(pending, current.selector); syncParent(current.selector);
  } finally { if (entry(pending)) unlinkSync(pending); }
  return { dataDirectory: current.dataDirectory, originalRoot: plan.originalRoot };
}
