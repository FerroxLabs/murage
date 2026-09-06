import { createHash } from "node:crypto";
import { closeSync, constants, createReadStream, createWriteStream, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import * as yauzl from "yauzl";
import { ZipFile as ZipWriter } from "yazl";
import { z } from "zod";
import { stageInstallationState } from "./installation-state-snapshot.ts";
import { dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { InstallationSnapshotError } from "./installation-database-snapshot.ts";

const MAX_MANIFEST_BYTES = 32 * 1024 ** 2;
const manifestSchema = z.object({
  format: z.literal("murage.installation"), version: z.literal(1),
  snapshotId: z.string().uuid(), createdAt: z.string().datetime(),
  restorePolicy: z.literal("paused-review-required"),
  files: z.array(z.object({ path: z.string().min(1).max(4096), bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(100_000),
  omitted: z.array(z.object({ path: z.string().max(4096), reason: z.string().max(512) }).strict()).max(100_000),
  missing: z.array(z.string().max(4096)).max(100_000),
  database: z.discriminatedUnion("status", [
    z.object({ status: z.literal("absent") }).strict(),
    z.object({ status: z.literal("copied"), messages: z.number().int().nonnegative(), threads: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  ]),
}).strict();
export type InstallationArchiveManifest = z.infer<typeof manifestSchema>;
export interface ArchiveLimits { maxBytes?: number; maxFiles?: number; signal?: AbortSignal }
function fail(code: string): never { throw new InstallationSnapshotError(code); }

export function portableArchivePath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && path === path.normalize("NFC") &&
    !/[\\:\x00-\x1f]/.test(path) && path.split("/").every(part =>
      !!part && part !== "." && part !== ".." && Buffer.byteLength(part) <= 255 && !/[ .]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

function limits(options: ArchiveLimits) {
  const maxBytes = options.maxBytes ?? 20 * 1024 ** 3;
  const maxFiles = options.maxFiles ?? 100_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 100_000) fail("INVALID_ARCHIVE_LIMITS");
  return { maxBytes, maxFiles };
}

function validateManifest(value: unknown, options: ArchiveLimits): InstallationArchiveManifest {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) fail("INVALID_ARCHIVE_MANIFEST");
  const manifest = parsed.data;
  const budget = limits(options);
  const names = new Set<string>();
  let total = 0;
  if (manifest.files.length > budget.maxFiles) fail("ARCHIVE_LIMIT_EXCEEDED");
  for (const file of manifest.files) {
    if (!portableArchivePath(file.path) || names.has(file.path.toLowerCase())) fail("UNSAFE_ARCHIVE_PATH");
    names.add(file.path.toLowerCase());
    total += file.bytes;
    if (!Number.isSafeInteger(total) || total > budget.maxBytes) fail("ARCHIVE_LIMIT_EXCEEDED");
  }
  const ordered = [...names].sort();
  for (let index = 1; index < ordered.length; index++) if (ordered[index].startsWith(ordered[index - 1] + "/")) fail("UNSAFE_ARCHIVE_PATH");
  const database = manifest.files.find(file => file.path === "messages.db");
  if (manifest.database.status === "copied") {
    if (!database || database.bytes !== manifest.database.bytes || database.sha256 !== manifest.database.sha256) fail("INVALID_DATABASE_MANIFEST");
  } else if (database) fail("INVALID_DATABASE_MANIFEST");
  return manifest;
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Validate every entry/hash into a fresh private directory. Never extracts
 * to the installation and never trusts archive paths, modes or declared sizes
 * as authority to write elsewhere. Returned state still requires schema,
 * reference, credential and paused-restore reconstruction before activation. */
export async function inspectInstallationArchive(archive: string, outputParent: string, options: ArchiveLimits = {}) {
  const budget = limits(options);
  if (options.signal?.aborted) fail("SNAPSHOT_CANCELLED");
  const before = lstatSync(archive);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("UNSAFE_ARCHIVE_FILE");
  if (before.size > budget.maxBytes + MAX_MANIFEST_BYTES + budget.maxFiles * 1024) fail("ARCHIVE_LIMIT_EXCEEDED");
  const directory = mkdtempSync(join(dataDirLeasePaths(outputParent).canonicalDataDir, ".murage-archive-inspection-"));
  let zip: yauzl.ZipFile | undefined;
  let success = false;
  let manifest: InstallationArchiveManifest | undefined;
  let declared = new Map<string, InstallationArchiveManifest["files"][number]>();
  let inFlight: Promise<void> | undefined;
  const seen = new Set<string>();
  let expanded = 0;
  try {
    zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(archive, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(error) : resolve(value!)));
    if (zip.entryCount > budget.maxFiles + 1) fail("ARCHIVE_LIMIT_EXCEEDED");
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
            if (expected) {
              const target = join(directory, ...name.split("/"));
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
                while (offset < buffer.length) offset += writeSync(fd!, buffer, offset, buffer.length - offset);
              } else chunks.push(buffer);
            }
            if (bytes !== entry.uncompressedSize) fail("ARCHIVE_SIZE_MISMATCH");
            if (expected) {
              if (hash.digest("hex") !== expected.sha256) fail("ARCHIVE_HASH_MISMATCH");
              fsyncSync(fd!);
            } else {
              let value: unknown;
              try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("INVALID_ARCHIVE_MANIFEST"); }
              manifest = validateManifest(value, options);
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
  const parent = dataDirLeasePaths(dirname(destination)).canonicalDataDir;
  const target = join(parent, basename(destination));
  try { lstatSync(target); fail("DESTINATION_EXISTS"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const stage = await stageInstallationState(dataDir, parent, options);
  let scratch: string | undefined;
  let writer: ZipWriter | undefined;
  let output: ReturnType<typeof createWriteStream> | undefined;
  let completed: Promise<void> | undefined;
  const inputs = new Set<Readable>();
  try {
    scratch = mkdtempSync(join(parent, ".murage-archive-write-"));
    const manifest = validateManifest({ ...stage.manifest, format: "murage.installation", files: stage.manifest.files.map(file => ({ ...file, path: file.path.replaceAll("\\", "/").normalize("NFC") })) }, options);
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
          const path = join(stage.directory, "state", original.path);
          const fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
          let stream: ReturnType<typeof createReadStream>;
          try { stream = createReadStream(path, { fd, autoClose: true }); }
          catch (error) { closeSync(fd); throw error; }
          inputs.add(stream);
          stream.once("close", () => inputs.delete(stream));
          callback(null, stream);
        } catch (error) { callback(error, Readable.from([])); }
      });
    }
    writer.end();
    await completed;
    const inspection = await inspectInstallationArchive(file, scratch, options);
    rmSync(inspection.directory, { recursive: true, force: true });
    const fd = openSync(file, "r+"); // Flush the owned scratch file with write access on Windows.
    try { fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(file, target);
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
