import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, createReadStream, createWriteStream, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import * as yauzl from "yauzl";
import { ZipFile as ZipWriter } from "yazl";
import { z } from "zod";
import { stageInstallationStateWhileOwned, type StateSnapshotManifest } from "./installation-state-snapshot.ts";
import { dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { InstallationSnapshotError, withOfflineInstallation } from "./installation-database-snapshot.ts";
import { BACKUP_SKIP_REASONS, MAX_BACKUP_BYTES, MAX_BACKUP_FILES, MAX_BACKUP_MANIFEST_BYTES, MAX_LISTED_SKIPS } from "../shared/backup-limits.ts";
import { publishNoReplace } from "./publish-file.ts";
import { botNames } from "./backup-skipped-summary.ts";

const MAX_MANIFEST_BYTES = MAX_BACKUP_MANIFEST_BYTES;
const archivedPath = z.string().min(1).max(4096);
const manifestSchema = z.object({
  format: z.literal("murage.installation"), version: z.literal(1),
  snapshotId: z.string().uuid(), createdAt: z.string().datetime(),
  restorePolicy: z.literal("paused-review-required"),
  files: z.array(z.object({ path: archivedPath, bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(MAX_BACKUP_FILES),
  omitted: z.array(z.object({ path: z.string().max(4096), reason: z.string().max(512) }).strict()).max(MAX_BACKUP_FILES),
  missing: z.array(z.string().max(4096)).max(MAX_BACKUP_FILES),
  database: z.discriminatedUnion("status", [
    z.object({ status: z.literal("absent") }).strict(),
    z.object({ status: z.literal("copied"), messages: z.number().int().nonnegative(), threads: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  ]),
  // 0.1.60 (audit A-01): what a bot's own folder holds besides plain files.
  // A shortcut (symbolic link) is stored as its target text and never
  // followed; a second name for the same file (a hard link) is stored once
  // and restored as a copy; a name another system can't hold is stored under
  // a safe spelling with its real last part kept here.
  links: z.array(z.object({ path: archivedPath, target: z.string().min(1).max(4096).refine(value => !value.includes("\0")), type: z.enum(["file", "dir"]) }).strict()).max(MAX_BACKUP_FILES).optional(),
  copies: z.array(z.object({ path: archivedPath, from: archivedPath }).strict()).max(MAX_BACKUP_FILES).optional(),
  names: z.array(z.object({ path: archivedPath, name: z.string().min(1).max(1024).refine(value => value !== "." && value !== ".." && !/[\/\\\0]/.test(value)) }).strict()).max(MAX_BACKUP_FILES).optional(),
  skipped: z.array(z.object({ path: z.string().min(1).max(4096), reason: z.enum(BACKUP_SKIP_REASONS) }).strict()).max(MAX_LISTED_SKIPS).optional(),
  skippedCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
export type InstallationArchiveManifest = z.infer<typeof manifestSchema>;
export interface ArchiveLimits { maxBytes?: number; maxFiles?: number; signal?: AbortSignal;
  /** Flush each extracted file. Only an extraction that becomes an
   * installation needs it; a readback check or an intermediate copy does not. */
  durable?: boolean;
  /** Write each entry out. A readback check only needs every entry's hash,
   * and writing a workspace of small files out again on a USB stick is slow
   * and needs room there. */
  extract?: boolean }
function fail(code: string, path?: string): never { throw new InstallationSnapshotError(code, path ? { path } : undefined); }

export function portableArchivePath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && path === path.normalize("NFC") &&
    !/[\\:\x00-\x1f]/.test(path) && path.split("/").every(part =>
      !!part && part !== "." && part !== ".." && Buffer.byteLength(part) <= 255 && !/[ .]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

function limits(options: ArchiveLimits) {
  // Restore and inspection accept whatever a backup may be made at
  // (shared/backup-limits.ts), so a verified backup is always restorable.
  const maxBytes = options.maxBytes ?? MAX_BACKUP_BYTES;
  const maxFiles = options.maxFiles ?? MAX_BACKUP_FILES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BACKUP_BYTES || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_BACKUP_FILES) fail("INVALID_ARCHIVE_LIMITS");
  return { maxBytes, maxFiles };
}

export function validateInstallationArchiveManifest(value: unknown, options: ArchiveLimits = {}): InstallationArchiveManifest {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) fail("INVALID_ARCHIVE_MANIFEST");
  const manifest = parsed.data;
  validateArchiveFileList(manifest, options);
  return manifest;
}

/** Shared path/budget mechanics; each format keeps its own strict schema. */
export function validateArchiveFileList(manifest: Pick<InstallationArchiveManifest, "files" | "database"> & Partial<Pick<InstallationArchiveManifest, "links" | "copies" | "names">>, options: ArchiveLimits & { maxEntries?: number } = {}) {
  const budget = limits(options);
  const names = new Set<string>();
  let total = 0;
  const links = manifest.links ?? [], copies = manifest.copies ?? [];
  if (manifest.files.length + links.length + copies.length > (options.maxEntries ?? budget.maxFiles)) fail("ARCHIVE_LIMIT_EXCEEDED");
  const claim = (path: string) => {
    if (!portableArchivePath(path) || names.has(path.toLowerCase())) fail("UNSAFE_ARCHIVE_PATH");
    names.add(path.toLowerCase());
  };
  for (const file of manifest.files) {
    claim(file.path);
    total += file.bytes;
    if (!Number.isSafeInteger(total) || total > budget.maxBytes) fail("ARCHIVE_LIMIT_EXCEEDED");
  }
  const stored = new Set(manifest.files.map(file => file.path));
  // Stored shortcuts and extra names live only inside folders of owner work,
  // never at the top of the data folder where Murage's own records are.
  for (const entry of [...links, ...copies]) { claim(entry.path); if (!entry.path.includes("/")) fail("UNSAFE_ARCHIVE_PATH"); }
  for (const copy of copies) {
    if (!stored.has(copy.from)) fail("UNSAFE_ARCHIVE_PATH");
    total += manifest.files.find(file => file.path === copy.from)!.bytes;
    if (!Number.isSafeInteger(total) || total > budget.maxBytes) fail("ARCHIVE_LIMIT_EXCEEDED");
  }
  const ordered = [...names].sort();
  for (let index = 1; index < ordered.length; index++) if (ordered[index].startsWith(ordered[index - 1] + "/")) fail("UNSAFE_ARCHIVE_PATH");
  // A renamed entry names a stored item or a folder above one.
  if (manifest.names?.length) {
    const folders = new Set<string>();
    for (const path of names) { const parts = path.split("/"); for (let index = 1; index < parts.length; index++) folders.add(parts.slice(0, index).join("/")); }
    const seen = new Set<string>();
    for (const entry of manifest.names) {
      const key = entry.path.toLowerCase();
      if (!portableArchivePath(entry.path) || !entry.path.includes("/") || seen.has(key) || (!names.has(key) && !folders.has(key))) fail("UNSAFE_ARCHIVE_PATH");
      seen.add(key);
    }
  }
  const database = manifest.files.find(file => file.path === "messages.db");
  if (manifest.database.status === "copied") {
    if (!database || database.bytes !== manifest.database.bytes || database.sha256 !== manifest.database.sha256) fail("INVALID_DATABASE_MANIFEST");
  } else if (database) fail("INVALID_DATABASE_MANIFEST");
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Make extracted files durable. One flush of the drive (syncfs on Linux,
 * sync on macOS) instead of one per file: a restore of 60,000 files used to
 * spend most of its time in per-file flushes. Falls back to per-file flushes
 * when the tool is not there. */
function flushExtracted(directory: string, files: string[]) {
  if (!files.length) return;
  const tool = ["/bin/sync", "/usr/bin/sync"].find(candidate => { try { return lstatSync(candidate).isFile() || lstatSync(candidate).isSymbolicLink(); } catch { return false; } });
  if (tool && spawnSync(tool, process.platform === "linux" ? ["-f", directory] : [], { stdio: "ignore", env: {}, timeout: 120_000 }).status === 0) return;
  for (const file of files) { const fd = openSync(file, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
}

/** Validate every entry/hash into a fresh private directory. Never extracts
 * to the installation and never trusts archive paths, modes or declared sizes
 * as authority to write elsewhere. Returned state still requires schema,
 * reference, credential and paused-restore reconstruction before activation. */
export async function inspectInstallationArchive(archive: string, outputParent: string, options: ArchiveLimits = {}) {
  return inspectArchiveEntries(archive, outputParent, value => validateInstallationArchiveManifest(value, options), options);
}

/** A distinct format supplies its own strict manifest parser, never a v1 bypass. */
export async function inspectArchiveEntries<T extends Pick<InstallationArchiveManifest, "files">>(archive: string, outputParent: string, parseManifest: (value: unknown) => T, options: ArchiveLimits & { maxEntries?: number } = {}) {
  const budget = limits(options);
  const maxEntries = options.maxEntries ?? budget.maxFiles;
  if (options.signal?.aborted) fail("SNAPSHOT_CANCELLED");
  const before = lstatSync(archive);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("UNSAFE_ARCHIVE_FILE");
  if (before.size > budget.maxBytes + MAX_MANIFEST_BYTES + maxEntries * 1024) fail("ARCHIVE_LIMIT_EXCEEDED");
  const directory = mkdtempSync(join(dataDirLeasePaths(outputParent).canonicalDataDir, ".murage-archive-inspection-"));
  let zip: yauzl.ZipFile | undefined;
  let success = false;
  let manifest: T | undefined;
  let declared = new Map<string, InstallationArchiveManifest["files"][number]>();
  let inFlight: Promise<void> | undefined;
  const seen = new Set<string>();
  let expanded = 0;
  const extracted: string[] = [];
  try {
    zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(archive, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(error) : resolve(value!)));
    if (zip.entryCount > maxEntries + 1) fail("ARCHIVE_LIMIT_EXCEEDED");
    await new Promise<void>((resolve, reject) => {
      const source = zip!;
      const onAbort = () => { source.close(); reject(new InstallationSnapshotError("SNAPSHOT_CANCELLED")); };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const finish = (error?: unknown) => {
        options.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error); else resolve();
      };
      source.once("error", finish);
      source.once("end", () => finish());
      source.on("entry", (entry: yauzl.Entry) => {
        inFlight = (async () => {
          if (options.signal?.aborted) fail("SNAPSHOT_CANCELLED");
          const name = entry.fileName;
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (!portableArchivePath(name) || seen.has(name.toLowerCase()) || (mode !== 0 && mode !== 0o100000) || (entry.externalFileAttributes & 0x10) || entry.isEncrypted()) fail("UNSAFE_ARCHIVE_ENTRY");
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0) fail("ARCHIVE_LIMIT_EXCEEDED");
          if (entry.uncompressedSize > Math.max(1, entry.compressedSize) * 200) fail("ARCHIVE_COMPRESSION_RATIO_EXCEEDED");
          seen.add(name.toLowerCase());
          if (!manifest && name !== "manifest.json") fail("MANIFEST_MUST_BE_FIRST");
          const expected = declared.get(name);
          if (manifest && !expected) fail("UNDECLARED_ARCHIVE_ENTRY");
          const sizeLimit = name === "manifest.json" ? MAX_MANIFEST_BYTES : expected!.bytes;
          if (entry.uncompressedSize > sizeLimit || (expected && entry.uncompressedSize !== expected.bytes)) fail("ARCHIVE_SIZE_MISMATCH");
          const stream = await new Promise<Readable>((resolve, reject) => source.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
          let bytes = 0;
          const hash = createHash("sha256");
          const chunks: Buffer[] = [];
          let fd: number | undefined;
          try {
            const target = join(directory, ...name.split("/"));
            if (expected && options.extract !== false) {
              mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
              fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), 0o600);
            }
            for await (const chunk of stream) {
              if (options.signal?.aborted) fail("SNAPSHOT_CANCELLED");
              const buffer = Buffer.from(chunk);
              bytes += buffer.length;
              if (bytes > sizeLimit) fail("ARCHIVE_SIZE_MISMATCH");
              if (expected) {
                expanded += buffer.length;
                if (expanded > budget.maxBytes) fail("ARCHIVE_LIMIT_EXCEEDED");
                hash.update(buffer);
                // Disk writes are bounded to one decompressed stream chunk.
                let offset = 0;
                if (fd !== undefined) while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
              } else chunks.push(buffer);
            }
            if (bytes !== entry.uncompressedSize) fail("ARCHIVE_SIZE_MISMATCH");
            if (expected) {
              if (hash.digest("hex") !== expected.sha256) fail("ARCHIVE_HASH_MISMATCH");
              if (fd !== undefined && options.durable !== false) { if (process.platform === "win32") fsyncSync(fd); else extracted.push(target); }
            } else {
              let value: unknown;
              try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("INVALID_ARCHIVE_MANIFEST"); }
              manifest = parseManifest(value);
              declared = new Map(manifest.files.map(file => [`state/${file.path}`, file]));
              if (source.entryCount !== manifest.files.length + 1) fail("ARCHIVE_ENTRY_COUNT_MISMATCH");
            }
          } finally { stream.destroy(); if (fd !== undefined) closeSync(fd); }
          source.readEntry();
        })().catch(error => { source.close(); finish(error); });
      });
      source.readEntry();
    });
    if (!manifest || manifest.files.some(file => !seen.has(`state/${file.path}`.toLowerCase()))) fail("MISSING_ARCHIVE_ENTRY");
    flushExtracted(directory, extracted);
    const sha256 = await fileHash(archive);
    const after = lstatSync(archive);
    if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail("ARCHIVE_CHANGED");
    success = true;
    return { directory, manifest, sha256 };
  } catch (error) {
    throw error instanceof InstallationSnapshotError ? error : new InstallationSnapshotError("ARCHIVE_INSPECTION_FAILED");
  } finally {
    zip?.close();
    await inFlight?.catch(() => {});
    if (!success) rmSync(directory, { recursive: true, force: true });
  }
}

/** Write a ZIP64-capable private archive, validate its round trip, and publish
 * by a no-replace hard link. Stored entries avoid surprising compression-ratio
 * failures for repetitive logs; archive compression can be added separately. */
export async function writeInstallationArchive(dataDir: string, destination: string, options: ArchiveLimits = {}) {
  if (!portableArchivePath(basename(destination))) fail("INVALID_DESTINATION");
  try { lstatSync(destination); fail("DESTINATION_EXISTS"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Staged, archived and checked in one offline epoch: owner files are read
  // in place, so the installation must stay closed until the archive is done.
  return withOfflineInstallation(dataDir, async installation => {
    const stage = await stageInstallationStateWhileOwned(installation, dirname(destination), options);
    // Whose folders the left-out items were in, read from the staged roster.
    const bots = stage.manifest.skippedCount ? botNames(join(stage.directory, "state", "bots.json")) : {};
    try { return { ...await writeInstallationStageArchive(stage, destination, { ...options, beforePublish: stage.assertSourceUnchanged }), bots }; }
    finally { rmSync(stage.directory, { recursive: true, force: true }); }
  });
}

/** Serialise an already-owned recovery stage; fidelity callers avoid recapture. */
export async function writeInstallationStageArchive(stage: { directory: string; manifest: StateSnapshotManifest; openFile?: (stored: string) => Readable }, destination: string, options: ArchiveLimits & { beforePublish?: () => void } = {}) {
  if (!portableArchivePath(basename(destination))) fail("INVALID_DESTINATION");
  const parent = dataDirLeasePaths(dirname(destination)).canonicalDataDir;
  const target = join(parent, basename(destination));
  try { lstatSync(target); fail("DESTINATION_EXISTS"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let scratch: string | undefined;
  let writer: ZipWriter | undefined;
  let output: ReturnType<typeof createWriteStream> | undefined;
  let completed: Promise<void> | undefined;
  const inputs = new Set<Readable>();
  try {
    scratch = mkdtempSync(join(parent, ".murage-archive-write-"));
    const manifest = validateInstallationArchiveManifest({ ...stage.manifest, format: "murage.installation", files: stage.manifest.files.map(file => ({ ...file, path: file.path.replaceAll("\\", "/").normalize("NFC") })) }, options);
    const file = join(scratch, "backup.zip");
    writer = new ZipWriter();
    output = createWriteStream(file, { flags: "wx", mode: 0o600 });
    writer.once("error", error => output!.destroy(error));
    completed = pipeline(writer.outputStream as Readable, output, { signal: options.signal });
    // Observe rejection immediately while the input list is assembled.
    void completed.catch(() => {});
    const manifestBytes = Buffer.from(JSON.stringify(manifest) + "\n");
    if (manifestBytes.length > MAX_MANIFEST_BYTES) fail("ARCHIVE_LIMIT_EXCEEDED");
    writer.addBuffer(manifestBytes, "manifest.json", { compress: false, mode: 0o100600 });
    for (let index = 0; index < manifest.files.length; index++) {
      const entry = manifest.files[index];
      const original = stage.manifest.files[index];
      writer.addReadStreamLazy(`state/${entry.path}`, { size: entry.bytes, compress: false, mode: 0o100600 }, callback => {
        try {
          let stream: Readable;
          if (stage.openFile) stream = stage.openFile(original.path.replaceAll("\\", "/"));
          else {
            const path = join(stage.directory, "state", original.path);
            const fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
            try { stream = createReadStream(path, { fd, autoClose: true }); }
            catch (error) { closeSync(fd); throw error; }
          }
          inputs.add(stream);
          stream.once("close", () => inputs.delete(stream));
          callback(null, stream);
        } catch (error) { callback(error, Readable.from([])); }
      });
    }
    writer.end();
    await completed;
    const inspection = await inspectInstallationArchive(file, scratch, { ...options, durable: false, extract: false });
    rmSync(inspection.directory, { recursive: true, force: true });
    options.beforePublish?.();
    const fd = openSync(file, "r+"); // Flush the owned scratch file with write access on Windows.
    try { fsyncSync(fd); } finally { closeSync(fd); }
    publishNoReplace(file, target);
    return { path: target, sha256: inspection.sha256, manifest };
  } catch (error) {
    throw error instanceof InstallationSnapshotError ? error : new InstallationSnapshotError((error as NodeJS.ErrnoException).code === "EEXIST" ? "DESTINATION_EXISTS" : "ARCHIVE_WRITE_FAILED");
  } finally {
    for (const stream of inputs) stream.destroy();
    (writer?.outputStream as Readable | undefined)?.destroy();
    output?.destroy();
    await completed?.catch(() => {});
    try { rmSync(stage.directory, { recursive: true, force: true }); }
    finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
  }
}
