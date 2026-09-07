import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, readSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { acquireDataDirLeaseForProcess, dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { readRestoreReview, RESTORE_REVIEW_FILE } from "../electron/restore-review.mjs";
import { restoredConnectionProfile } from "../electron/restored-connections.mjs";
import { InstallationSnapshotError, inspectInstallationDatabase } from "./installation-database-snapshot.ts";
import { assertInstallationRecords } from "./installation-record-validation.ts";
import { InstallationTranscriptGraph } from "./installation-transcript-graph.ts";
import { portableArchivePath } from "./installation-archive.ts";
import { parseStoredConfig } from "./config.ts";
import type { JsonValue } from "./schema.ts";
import { writeFileAtomic } from "./atomic.ts";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function fail(code: string): never { throw new InstallationSnapshotError(code); }
function entry(file: string) {
  try { return lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function json(file: string, maxBytes = 64 * 1024 ** 2): unknown {
  const stat = entry(file);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) fail("INVALID_REVIEW_FILE");
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fail("INVALID_REVIEW_FILE"); }
}
function records(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(object)) fail("INVALID_REVIEW_RECORDS");
  return value as Array<Record<string, unknown>>;
}
function empty(value: unknown) { return object(value) && Object.keys(value).length === 0; }
function inertMessage(value: unknown) {
  if (!object(value)) fail("INVALID_REVIEW_MESSAGE");
  if (value.queued === true || (object(value.goalRun) && value.goalRun.status === "working")) fail("RESTORE_WORK_NOT_PAUSED");
  if (object(value.card) && (value.card.requestId || value.card.routineRequest || value.card.skillRequest) && !value.card.answered) fail("RESTORE_WORK_NOT_PAUSED");
  for (const key of ["secret", "connector"]) if (object(value[key]) && (value[key].dismissed !== true || value[key].resumed !== false)) fail("RESTORE_WORK_NOT_PAUSED");
}
function validatePaused(root: string) {
  const rawConfig = json(join(root, "config.json"));
  if (rawConfig === undefined) fail("RESTORE_WORK_NOT_PAUSED");
  const config = parseStoredConfig(rawConfig as JsonValue);
  if (config.engineDiscovery !== "explicit" || !config.instances || Object.values(config.instances).some(value => value.enabled !== false)) fail("RESTORE_WORK_NOT_PAUSED");
  for (const bot of records(json(join(root, "bots.json")))) {
    if (bot.busy !== false || bot.autoApprove !== false || bot.autoReview !== "off" || bot.approvePeerComms !== true ||
        bot.computer !== "off" || bot.autoStartVps !== false || bot.browser !== false || bot.composio !== false ||
        bot.speakReplies !== false || !Array.isArray(bot.alwaysAllow) || bot.alwaysAllow.length || !empty(bot.resumeCursors) || bot.lastInstanceId !== undefined) fail("RESTORE_WORK_NOT_PAUSED");
    for (const task of records(bot.tasks)) if (!empty(task.resumeCursors) || task.lastInstanceId !== undefined) fail("RESTORE_WORK_NOT_PAUSED");
  }
  for (const group of records(json(join(root, "groups.json")))) if (group.working !== false || group.busyBotId !== null) fail("RESTORE_WORK_NOT_PAUSED");
  for (const name of ["routines.json", "calendar-calls.json", "webhooks.json", "delegation-receipts.json"]) {
    const value = json(join(root, name)); if (value === undefined) continue;
    assertInstallationRecords(name, value);
    if (!object(value)) continue;
    if (name === "routines.json" && (records(value.routines).some(row => row.enabled !== false) || records(value.runs).some(row => ["queued", "running", "waiting"].includes(String(row.status))))) fail("RESTORE_WORK_NOT_PAUSED");
    if (name === "calendar-calls.json" && records(value.calls).some(row => row.nextRunAt !== null)) fail("RESTORE_WORK_NOT_PAUSED");
    if (name === "webhooks.json" && records(value.webhooks).some(row => row.enabled !== false || row.verificationPending !== true)) fail("RESTORE_WORK_NOT_PAUSED");
  }
  for (const name of ["delegations.json", "browser-cleanups.json"]) if (entry(join(root, name))) fail("RESTORE_WORK_NOT_PAUSED");
  const skillRoot = join(root, "skill-state");
  if (entry(skillRoot)) for (const bot of readdirSync(skillRoot)) {
    if (entry(join(skillRoot, bot, "staged.json"))) fail("RESTORE_WORK_NOT_PAUSED");
    const skills = json(join(skillRoot, bot, "skills.json"));
    if (skills !== undefined && (!object(skills) || Object.values(skills).some(value => !object(value) || value.enabled !== false))) fail("RESTORE_WORK_NOT_PAUSED");
  }
  for (const name of readdirSync(root)) if (/^messages-[a-zA-Z0-9_-]+[.]json$/.test(name)) {
    const value = json(join(root, name)), rows = Array.isArray(value) ? value : object(value) ? value.messages : undefined;
    if (!Array.isArray(rows)) fail("INVALID_REVIEW_MESSAGE");
    const graph = new InstallationTranscriptGraph(fail);
    for (const row of rows as unknown[]) { graph.add(row); inertMessage(row); }
    graph.validate(object(value) ? value.activeLeafId ?? null : null);
  }
  if (entry(join(root, "messages.db"))) {
    const db = new DatabaseSync(join(root, "messages.db"), { readOnly: true });
    try { inspectInstallationDatabase(db); if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name=\'memory_meta\'").get() && db.prepare("SELECT mode FROM memory_meta WHERE id=1").get()?.mode !== "paused") fail("RESTORE_MEMORY_NOT_PAUSED"); for (const row of db.prepare("SELECT json FROM messages").iterate()) inertMessage(JSON.parse(String(row.json))); }
    finally { db.close(); }
  }
}
function fingerprint(root: string) {
  const digest = createHash("sha256");
  let files = 0, bytes = 0;
  function visit(relative: string, depth: number) {
    if (depth > 64) fail("REVIEW_LIMIT_EXCEEDED");
    const file = join(root, relative), stat = lstatSync(file);
    if (stat.isSymbolicLink()) fail("INVALID_REVIEW_FILE");
    digest.update(JSON.stringify([relative, stat.mode & 0o777]) + "\n");
    if (stat.isDirectory()) {
      const names = readdirSync(file).sort();
      if (names.length > 100_000) fail("REVIEW_LIMIT_EXCEEDED");
      for (const name of names) {
        const next = relative ? relative + "/" + name : name;
        if (!portableArchivePath(next)) fail("INVALID_REVIEW_FILE");
        visit(next, depth + 1);
      }
      if (JSON.stringify(names) !== JSON.stringify(readdirSync(file).sort())) fail("SOURCE_CHANGED");
    } else {
      if (!stat.isFile() || stat.nlink !== 1 || ++files > 100_000 || (bytes += stat.size) > 20 * 1024 ** 3) fail("REVIEW_LIMIT_EXCEEDED");
      const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = fstatSync(fd);
        if (opened.dev !== stat.dev || opened.ino !== stat.ino) fail("SOURCE_CHANGED");
        const fileHash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
        for (;;) { const size = readSync(fd, buffer, 0, buffer.length, null); if (!size) break; fileHash.update(buffer.subarray(0, size)); }
        digest.update(JSON.stringify([stat.size, fileHash.digest("hex")]) + "\n");
      } finally { closeSync(fd); }
    }
    const after = lstatSync(file);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail("SOURCE_CHANGED");
  }
  visit("", 0);
  return { sha256: digest.digest("hex"), files, bytes };
}
function installationRoot(dataDir: string) {
  const paths = dataDirLeasePaths(dataDir), root = paths.canonicalDataDir;
  for (const broad of [homedir(), process.cwd()]) { const resolved = resolve(broad); if (resolved === root || resolved.startsWith(root + sep)) fail("BROAD_RESTORE_TARGET_REFUSED"); }
  if (entry(paths.leasePath + ".restore.json")) fail("INTERRUPTED_RESTORE_REQUIRES_ROLLBACK");
  return root;
}
function reviewWhileOwned(root: string) {
  const marker = readRestoreReview(root), profile = restoredConnectionProfile(root);
  if (!marker || marker.version !== 1 || marker.status !== "review-required" || !profile ||
      typeof marker.transactionId !== "string" || !uuid.test(marker.transactionId) ||
      typeof marker.snapshotId !== "string" || !uuid.test(marker.snapshotId) ||
      typeof marker.archiveSha256 !== "string" || !hashPattern.test(marker.archiveSha256)) fail("INVALID_RESTORE_REVIEW");
  const receipt = json(join(dirname(root), "." + basename(root) + ".restore-" + marker.transactionId + ".receipt.json"), 16_384);
  if (!object(receipt) || receipt.version !== 1 || receipt.id !== marker.transactionId || receipt.snapshotId !== marker.snapshotId || receipt.archiveSha256 !== marker.archiveSha256 || receipt.phase !== "candidate-installed") fail("INVALID_RESTORE_REVIEW");
  const before = fingerprint(root);
  validatePaused(root);
  const after = fingerprint(root);
  if (before.sha256 !== after.sha256) fail("SOURCE_CHANGED");
  const reviewHash = createHash("sha256").update(after.sha256).update(JSON.stringify(receipt)).digest("hex");
  return { marker, profile, reviewHash, files: after.files, bytes: after.bytes };
}
export function reviewInstallation(dataDir: string) {
  const root = installationRoot(dataDir), lease = acquireDataDirLeaseForProcess(root);
  try {
    const reviewed = reviewWhileOwned(root);
    return { status: "ready-for-review" as const, reviewHash: reviewed.reviewHash, snapshotId: reviewed.marker.snapshotId, connectionProfileId: reviewed.profile.id, files: reviewed.files, bytes: reviewed.bytes, engines: "disabled", schedules: "paused", pendingWork: "not-replayed", activationAvailable: true };
  } finally { lease.release(); }
}
export function activateInstallation(dataDir: string, expectedReviewHash: string) {
  if (!hashPattern.test(expectedReviewHash)) fail("REVIEW_HASH_REQUIRED");
  const root = installationRoot(dataDir), lease = acquireDataDirLeaseForProcess(root);
  try {
    const reviewed = reviewWhileOwned(root);
    if (reviewed.reviewHash !== expectedReviewHash) fail("REVIEW_STATE_CHANGED");
    const marker = { ...reviewed.marker, snapshotId: reviewed.marker.snapshotId, status: "reviewed", policyVersion: 1, connectionProfileId: reviewed.profile.id, reviewedTreeHash: reviewed.reviewHash, activationId: randomUUID(), activatedAt: Date.now() };
    writeFileAtomic(join(root, RESTORE_REVIEW_FILE), JSON.stringify(marker) + "\n", { mode: 0o600 });
    if (process.platform !== "win32") { const fd = openSync(root, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
    return { status: "reviewed-engines-disabled" as const, activationId: marker.activationId, snapshotId: marker.snapshotId, connectionProfileId: marker.connectionProfileId, engines: "disabled", schedules: "paused", activationAvailable: false };
  } finally { lease.release(); }
}
