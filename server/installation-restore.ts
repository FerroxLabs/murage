import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { z } from "zod";
import { acquireDataDirLeaseForProcess, dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { RESTORE_REVIEW_FILE, readRestoreReview, assertRestoreReviewed } from "../electron/restore-review.mjs";
import { writeFileAtomic } from "./atomic.ts";
import { InstallationSnapshotError } from "./installation-database-snapshot.ts";
import { prepareInstallationRestore } from "./installation-restore-preparation.ts";

type Phase = "prepared" | "original-renamed" | "original-moved" | "candidate-renamed" | "candidate-installed";
const identitySchema = z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict();
const journalSchema = z.object({ version: z.literal(1), id: z.string().uuid(), archiveSha256: z.string().regex(/^[a-f0-9]{64}$/), snapshotId: z.string().uuid(), hadOriginal: z.boolean(), originalIdentity: identitySchema.nullable(), phase: z.enum(["prepared", "original-moved", "candidate-installed"]) }).strict().refine(value => value.hadOriginal === (value.originalIdentity !== null));
type Journal = z.infer<typeof journalSchema>;
function fail(code: string): never { throw new InstallationSnapshotError(code); }
function entry(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function syncParent(path: string) {
  // Directory fsync is not portable through Node on Windows. Process-crash
  // recovery is journaled there too; power-loss durability needs native proof.
  if (process.platform === "win32") return;
  const fd = openSync(dirname(path), "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function rootPaths(dataDir: string) {
  const paths = dataDirLeasePaths(dataDir);
  const root = paths.canonicalDataDir;
  const home = dataDirLeasePaths(homedir()).canonicalDataDir;
  const cwd = dataDirLeasePaths(process.cwd()).canonicalDataDir;
  if (root === home || home.startsWith(root + sep) || root === cwd || cwd.startsWith(root + sep)) fail("BROAD_RESTORE_TARGET_REFUSED");
  const stat = entry(root);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail("UNSAFE_RESTORE_TARGET");
  return { root, journal: `${paths.leasePath}.restore.json` };
}
function transactionPaths(root: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) fail("INVALID_RESTORE_JOURNAL");
  const base = join(dirname(root), `.${basename(root)}.restore-${id}`);
  return { candidate: `${base}.candidate`, previous: `${base}.previous`, retainedCandidate: `${base}.retained`, receipt: `${base}.receipt.json` };
}
function readJournal(path: string): Journal {
  const stat = entry(path);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16_384) fail("INVALID_RESTORE_JOURNAL");
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { fail("INVALID_RESTORE_JOURNAL"); }
  const parsed = journalSchema.safeParse(value);
  if (!parsed.success) fail("INVALID_RESTORE_JOURNAL");
  return parsed.data;
}
function publishJournal(path: string, value: Journal) {
  const temporary = `${path}.${value.id}.pending`;
  writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600, flush: true });
  try { linkSync(temporary, path); }
  finally { unlinkSync(temporary); }
  syncParent(path);
}
function move(from: string, to: string) {
  if (entry(to)) fail("RESTORE_PATH_ALREADY_EXISTS");
  const original = entry(from);
  if (!original?.isDirectory() || original.isSymbolicLink()) fail("UNSAFE_RESTORE_DIRECTORY");
  renameSync(from, to);
  syncParent(to);
}
function directoryIdentity(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_RESTORE_DIRECTORY");
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function isOriginal(path: string, journal: Journal) {
  if (!entry(path) || !journal.originalIdentity) return false;
  const identity = directoryIdentity(path);
  return identity.dev === journal.originalIdentity.dev && identity.ino === journal.originalIdentity.ino;
}
function assertCandidate(path: string, id: string) {
  const file = join(path, RESTORE_REVIEW_FILE), stat = entry(file);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) fail("RESTORE_CANDIDATE_IDENTITY_CHANGED");
  try { if (JSON.parse(readFileSync(file, "utf8"))?.transactionId === id) return; } catch { /* Fail closed. */ }
  fail("RESTORE_CANDIDATE_IDENTITY_CHANGED");
}

/** Commit an explicitly hash-bound archive into a stopped installation.
 * Both old and restored directories are retained on failure; an active
 * journal blocks startup until rollback. Never activates agents. */
export async function restoreInstallation(dataDir: string, archive: string, expectedSha256: string, options: { checkpoint?: (phase: Phase) => void | Promise<void> } = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) fail("ARCHIVE_HASH_REQUIRED");
  const paths = rootPaths(dataDir);
  const lease = acquireDataDirLeaseForProcess(paths.root);
  let inspection: string | undefined;
  let journalCreated = false;
  let candidate: string | undefined;
  try {
    if (entry(paths.journal)) fail("INTERRUPTED_RESTORE_REQUIRES_ROLLBACK");
    if (entry(join(paths.root, RESTORE_REVIEW_FILE))) {
      if (readRestoreReview(paths.root)?.status !== "reviewed") fail("RESTORE_ALREADY_REQUIRES_REVIEW");
      assertRestoreReviewed(paths.root);
    }
    const prepared = await prepareInstallationRestore(archive, dirname(paths.root));
    inspection = prepared.directory;
    if (prepared.sha256 !== expectedSha256) fail("ARCHIVE_HASH_CHANGED");
    const id = randomUUID();
    const tx = transactionPaths(paths.root, id);
    candidate = tx.candidate;
    const markerPath = join(prepared.stateDirectory, RESTORE_REVIEW_FILE);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    writeFileAtomic(markerPath, JSON.stringify({ ...marker, transactionId: id }) + "\n", { mode: 0o600 });
    move(prepared.stateDirectory, tx.candidate);
    const originalIdentity = entry(paths.root) ? directoryIdentity(paths.root) : null;
    const journal: Journal = { version: 1, id, archiveSha256: expectedSha256, snapshotId: prepared.manifest.snapshotId, hadOriginal: originalIdentity !== null, originalIdentity, phase: "prepared" };
    publishJournal(paths.journal, journal);
    journalCreated = true;
    await options.checkpoint?.("prepared");
    if (journal.hadOriginal) move(paths.root, tx.previous);
    await options.checkpoint?.("original-renamed");
    journal.phase = "original-moved";
    writeFileAtomic(paths.journal, JSON.stringify(journal) + "\n", { mode: 0o600 }); syncParent(paths.journal);
    await options.checkpoint?.("original-moved");
    move(tx.candidate, paths.root);
    await options.checkpoint?.("candidate-renamed");
    journal.phase = "candidate-installed";
    writeFileAtomic(paths.journal, JSON.stringify(journal) + "\n", { mode: 0o600 }); syncParent(paths.journal);
    await options.checkpoint?.("candidate-installed");
    if (entry(tx.receipt)) fail("RESTORE_PATH_ALREADY_EXISTS");
    renameSync(paths.journal, tx.receipt); syncParent(tx.receipt);
    return { status: "restored-review-required" as const, snapshotId: journal.snapshotId, archiveSha256: expectedSha256, previousDataDir: journal.hadOriginal ? tx.previous : null, receipt: tx.receipt, activationAvailable: false as const };
  } catch (error) {
    // Publishing may succeed before its directory fsync fails. Never remove
    // candidate data while an externally visible journal can refer to it.
    if (!journalCreated && !entry(paths.journal) && candidate && entry(candidate)) rmSync(candidate, { recursive: true, force: true });
    throw error instanceof InstallationSnapshotError ? error : new InstallationSnapshotError(journalCreated ? "RESTORE_INTERRUPTED_REQUIRES_ROLLBACK" : "RESTORE_PREPARATION_FAILED");
  } finally {
    try { if (inspection) rmSync(inspection, { recursive: true, force: true }); }
    finally { lease.release(); }
  }
}

/** Roll back an interrupted switch, or undo a completed restore still held
 * behind its review marker. Restored candidate data is retained, not deleted. */
export function rollbackInstallationRestore(dataDir: string, options: { checkpoint?: (phase: "rollback-started" | "candidate-retained" | "original-restored") => void } = {}) {
  const paths = rootPaths(dataDir);
  const lease = acquireDataDirLeaseForProcess(paths.root);
  try {
    let journalFile = paths.journal;
    if (!entry(journalFile)) {
      const markerFile = join(paths.root, RESTORE_REVIEW_FILE);
      const stat = entry(markerFile);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail("NO_RESTORE_TO_ROLL_BACK");
      let marker: { transactionId?: unknown };
      try { marker = JSON.parse(readFileSync(markerFile, "utf8")); } catch { fail("INVALID_RESTORE_JOURNAL"); }
      if (typeof marker.transactionId !== "string") fail("NO_RESTORE_TO_ROLL_BACK");
      journalFile = transactionPaths(paths.root, marker.transactionId).receipt;
    }
    const journal = readJournal(journalFile);
    const tx = transactionPaths(paths.root, journal.id);
    // A completed restore's receipt must become a startup barrier BEFORE
    // any rollback rename. The root (and its review marker) may disappear.
    if (journalFile !== paths.journal) {
      renameSync(journalFile, paths.journal); syncParent(paths.journal);
      journalFile = paths.journal;
    }
    options.checkpoint?.("rollback-started");
    if (journal.hadOriginal) {
      if (entry(tx.previous)) {
        if (!isOriginal(tx.previous, journal)) fail("RESTORE_ORIGINAL_IDENTITY_CHANGED");
        if (entry(paths.root)) {
          assertCandidate(paths.root, journal.id);
          move(paths.root, tx.retainedCandidate);
        }
        options.checkpoint?.("candidate-retained");
        move(tx.previous, paths.root);
        options.checkpoint?.("original-restored");
      // The rename may have completed before the process died. Prove the
      // actual original directory is back instead of trusting journal phase.
      } else if (!isOriginal(paths.root, journal)) fail("RESTORE_ORIGINAL_UNAVAILABLE");
    } else if (entry(paths.root)) {
      assertCandidate(paths.root, journal.id);
      move(paths.root, tx.retainedCandidate);
      options.checkpoint?.("candidate-retained");
    }
    const receipt = `${tx.receipt}.rolled-back`;
    if (entry(receipt)) fail("RESTORE_PATH_ALREADY_EXISTS");
    renameSync(journalFile, receipt); syncParent(receipt);
    return { status: "rolled-back" as const, receipt, retainedCandidate: entry(tx.retainedCandidate) ? tx.retainedCandidate : entry(tx.candidate) ? tx.candidate : null };
  } catch (error) { throw error instanceof InstallationSnapshotError ? error : new InstallationSnapshotError("RESTORE_ROLLBACK_FAILED"); }
  finally { lease.release(); }
}
