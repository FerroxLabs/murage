import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, createReadStream, createWriteStream, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, writeSync, type Stats } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { portableArchivePath, type ArchiveLimits } from "./installation-archive.ts";
import { InstallationSnapshotError, withOfflineInstallation } from "./installation-database-snapshot.ts";
import { classifyDataDirEntry, DATA_DIR_RECORDS } from "./data-dir-inventory.ts";
import { REBUILDABLE_FOLDERS } from "./installation-state-snapshot.ts";
import { publishNoReplace } from "./publish-file.ts";
import { claimCopyScratch, removeCopy, SettleCopySpaceError, settleFtsCopy, sweepStaleCopyScratch } from "./settle-copy.ts";

// A damaged installation cannot take a consistent SQLite snapshot, so the
// database and its sidecars are copied raw beside every name a backup would
// restore (data-dir-inventory.ts, the one list of top-level names).
const RECORDS = new Set([...DATA_DIR_RECORDS, "messages.db", "messages.db-wal", "messages.db-shm", "connected-app-ledger.db", "connected-app-ledger.db-wal", "connected-app-ledger.db-shm", "phone-calls.db", "phone-calls.db-wal", "phone-calls.db-shm", "phone-calls.db-journal"]);
const preserved = (name: string) => {
  if (RECORDS.has(name)) return true;
  const kind = classifyDataDirEntry(name)?.backup;
  return kind === "record" || kind === "owner-file" || kind === "owner-folder";
};
const fail = (code: string): never => { throw new InstallationSnapshotError(code); };

/** The conversations database and its two side files (SMOOTH-FTS-MERGE R6 section 3, damaged export). */
const DATABASE_FAMILY = ["messages.db", "messages.db-wal", "messages.db-shm"] as const;
/** Why the -wal and -shm are not in an export whose messages.db settled: the WAL is in it now. */
export const DAMAGED_EXPORT_FOLDED_REASON = "Folded into messages.db";
/** Why none of the three is in an export whose messages.db could not be settled (approved wording; replaces the raw copy). */
export const DAMAGED_EXPORT_DATABASE_WITHHELD = "This export does not include your conversations database, because Murage could not prove that deleted conversations are gone from it. The database is still in the data folder on this computer.";
/** The owner-facing log line when the database is left out because the disk is too short to settle it (SMOOTH-FTS-MERGE R6.2). */
export const DAMAGED_EXPORT_SHORT_DISK_LOG = "Murage left your conversations database out of this export because the disk does not have enough free space to clean it first. Free some disk space and export again to include it.";
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

export interface DamagedExportManifest {
  format: "murage.installation-damaged";
  version: 1;
  snapshotId: string;
  createdAt: string;
  restorePolicy: "preservation-only-no-restore";
  complete: false;
  warning: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  omitted: Array<{ path: string; reason: string }>;
  missing: string[];
}

/** Private raw preservation, deliberately incompatible with installation
 * restore. No JSON parsing, normalization or credential projection occurs,
 * and the live files are never opened by SQLite: only the private scratch
 * copy of messages.db is, to settle it (settle-copy.ts), or it is withheld. Damaged config/transcripts can contain secrets. Native
 * credential homes and unquiesced VM workspaces are explicitly omitted.
 * POSIX scratch/output permissions are 0700/0600; Windows ACL isolation must
 * be supplied by the destination's owner and is not established by mode bits. */
export async function writeInstallationDamagedExport(dataDir: string, destination: string, options: ArchiveLimits = {}) {
  const root = dataDirLeasePaths(dataDir).canonicalDataDir;
  if (!portableArchivePath(basename(destination))) fail("INVALID_DESTINATION");
  const parent = dataDirLeasePaths(dirname(destination)).canonicalDataDir;
  if (parent === root || parent.startsWith(root + sep)) fail("DESTINATION_INSIDE_INSTALLATION");
  const target = join(parent, basename(destination));
  try { lstatSync(target); fail("DESTINATION_EXISTS"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const maxBytes = options.maxBytes ?? 20 * 1024 ** 3;
  const maxFiles = options.maxFiles ?? 100_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 100_000) fail("INVALID_SNAPSHOT_LIMITS");
  return withOfflineInstallation(root, async () => {
    if (!lstatSync(root).isDirectory()) fail("INSTALLATION_MISSING");
    // a killed earlier run can leave raw, unsettled copies in this parent (SMOOTH-FTS-MERGE R6 section 3, stale scratch)
    sweepStaleCopyScratch(parent);
    const scratch = mkdtempSync(join(parent, ".murage-damaged-export-"));
    claimCopyScratch(scratch);
    const manifest: DamagedExportManifest = {
      format: "murage.installation-damaged", version: 1, snapshotId: randomUUID(), createdAt: new Date().toISOString(),
      restorePolicy: "preservation-only-no-restore", complete: false,
      warning: "Private raw evidence may contain credentials. Not a complete backup, sanitized report or restorable installation.",
      files: [], omitted: [], missing: [],
    };
    const observed = new Map<string, Stats>();
    let bytes = 0, entries = 0;
    let writer: ZipFile | undefined;
    let output: ReturnType<typeof createWriteStream> | undefined;
    let completed: Promise<void> | undefined;
    const check = () => { if (options.signal?.aborted) fail("SNAPSHOT_CANCELLED"); };
    const copy = (path: string, depth = 0) => {
      check();
      if (++entries > maxFiles || depth > 64) fail("SNAPSHOT_LIMIT_EXCEEDED");
      if (!portableArchivePath(path)) fail("NONPORTABLE_SNAPSHOT_PATH");
      const source = join(root, ...path.split("/"));
      const before = lstatSync(source);
      observed.set(source, before);
      if (before.isSymbolicLink()) { manifest.omitted.push({ path, reason: "Symlink not followed" }); return; }
      if (before.isDirectory()) {
        // What a bot ordinarily makes in its folder never stops this either
        // (0.1.60 audit A-01): rebuildable folders and names a zip can't hold
        // are left in place and listed as omitted.
        if (path.startsWith("workspaces/") && REBUILDABLE_FOLDERS.has(basename(source))) { manifest.omitted.push({ path, reason: "Rebuildable dependency or cache folder left in place" }); return; }
        const folded = new Set<string>();
        for (const name of readdirSync(source).sort()) {
          const child = `${path}/${name}`;
          if (folded.has(name.toLowerCase()) || !portableArchivePath(child)) { manifest.omitted.push({ path: child.replace(/[\x00-\x1f]/g, "?"), reason: "Name another system can't hold; left in place" }); continue; }
          folded.add(name.toLowerCase());
          copy(child, depth + 1);
        }
        return;
      }
      if (!before.isFile()) { manifest.omitted.push({ path, reason: "Not a regular file; left in place" }); return; }
      if (before.size > maxBytes - bytes) fail("SNAPSHOT_LIMIT_EXCEEDED");
      const to = join(scratch, "preservation", ...path.split("/"));
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      const input = openSync(source, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      let out: number | undefined;
      let size = 0;
      const hash = createHash("sha256");
      try {
        const opened = fstatSync(input);
        if (!same(before, opened) || !opened.isFile()) fail("SOURCE_CHANGED");
        out = openSync(to, "wx", 0o600);
        const buffer = Buffer.alloc(64 * 1024);
        for (;;) {
          check();
          const length = readSync(input, buffer, 0, buffer.length, null);
          if (!length) break;
          size += length;
          if (size > maxBytes - bytes) fail("SNAPSHOT_LIMIT_EXCEEDED");
          hash.update(buffer.subarray(0, length));
          let offset = 0;
          while (offset < length) offset += writeSync(out, buffer, offset, length - offset);
        }
        fsyncSync(out);
      } finally { try { if (out !== undefined) closeSync(out); } finally { closeSync(input); } }
      if (size !== before.size || !same(before, lstatSync(source))) fail("SOURCE_CHANGED");
      bytes += size;
      manifest.files.push({ path, bytes: size, sha256: hash.digest("hex") });
    };
    // The raw database copies are settled in the scratch folder or withheld; never published raw. The scratch -shm goes first
    // (SQLite rebuilds the wal index from the -wal), then settleFtsCopy with quick_check. A name is in exactly one list.
    const settleDatabase = () => {
      const copied = DATABASE_FAMILY.filter(name => manifest.files.some(entry => entry.path === name));
      if (!copied.length) return;
      const rawBytes = manifest.files.filter(entry => (DATABASE_FAMILY as readonly string[]).includes(entry.path)).reduce((total, entry) => total + entry.bytes, 0);
      manifest.files = manifest.files.filter(entry => !(DATABASE_FAMILY as readonly string[]).includes(entry.path));
      bytes -= rawBytes;
      const folder = join(scratch, "preservation"), main = join(folder, "messages.db");
      rmSync(join(folder, "messages.db-shm"), { force: true });
      let settled: { bytes: number; sha256: string } | undefined;
      if (copied.includes("messages.db")) {
        try {
          settleFtsCopy(main, { check: true });
          const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024), fd = openSync(main, "r");
          let size = 0;
          try { for (;;) { const length = readSync(fd, buffer, 0, buffer.length, null); if (!length) break; size += length; hash.update(buffer.subarray(0, length)); } }
          finally { closeSync(fd); }
          settled = { bytes: size, sha256: hash.digest("hex") };
        } catch (error) {
          settled = undefined;
          // R6.2 (Low): the omitted reason stays the approved sentence; the owner-facing log says the disk was the cause
          if (error instanceof SettleCopySpaceError) console.warn(`[damaged-export] ${DAMAGED_EXPORT_SHORT_DISK_LOG}`);
        }
      }
      const unlist = (name: string) => {
        manifest.omitted = manifest.omitted.filter(entry => entry.path !== name);
        manifest.missing = manifest.missing.filter(entry => entry !== name);
      };
      if (settled) {
        if (settled.bytes > maxBytes - bytes) fail("SNAPSHOT_LIMIT_EXCEEDED");
        bytes += settled.bytes;
        manifest.files.push({ path: "messages.db", ...settled });
        for (const name of ["messages.db-wal", "messages.db-shm"] as const) if (copied.includes(name)) { unlist(name); manifest.omitted.push({ path: name, reason: DAMAGED_EXPORT_FOLDED_REASON }); }
        for (const name of ["messages.db-wal", "messages.db-shm"] as const) rmSync(join(folder, name), { force: true });
      } else {
        removeCopy(main);
        for (const name of DATABASE_FAMILY) { unlist(name); manifest.omitted.push({ path: name, reason: DAMAGED_EXPORT_DATABASE_WITHHELD }); }
      }
    };
    try {
      check();
      const names = readdirSync(root).sort();
      if (names.length > maxFiles) fail("SNAPSHOT_LIMIT_EXCEEDED");
      const folded = new Set<string>();
      for (const name of names) {
        if (!portableArchivePath(name) || folded.has(name.toLowerCase())) fail("NONPORTABLE_SNAPSHOT_PATH");
        folded.add(name.toLowerCase());
        if (preserved(name)) copy(name);
        else {
          if (++entries > maxFiles) fail("SNAPSHOT_LIMIT_EXCEEDED");
          manifest.omitted.push({ path: name, reason: ["vm-home", "vm-homes"].includes(name) ? "VM workspace not quiesced; includes native browser credentials" : "Native credential home, connection realm, cache or unrecognized component excluded" });
        }
      }
      for (const name of RECORDS) if (!names.includes(name)) manifest.missing.push(name);
      if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify(names)) fail("SOURCE_CHANGED");
      for (const [path, before] of observed) if (!same(before, lstatSync(path))) fail("SOURCE_CHANGED");
      check();
      settleDatabase();
      check();
      const manifestBytes = Buffer.from(JSON.stringify(manifest) + "\n");
      if (manifestBytes.length > 32 * 1024 ** 2) fail("SNAPSHOT_LIMIT_EXCEEDED");
      const file = join(scratch, "preservation.zip");
      writer = new ZipFile();
      output = createWriteStream(file, { flags: "wx", mode: 0o600 });
      writer.once("error", error => output!.destroy(error));
      completed = pipeline(writer.outputStream as Readable, output, { signal: options.signal });
      void completed.catch(() => {});
      writer.addBuffer(manifestBytes, "manifest.json", { compress: false, mode: 0o100600 });
      for (const entry of manifest.files) writer.addFile(join(scratch, "preservation", ...entry.path.split("/")), `preservation/${entry.path}`, { compress: false, mode: 0o100600 });
      writer.end();
      await completed;
      check();
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) { check(); hash.update(chunk); }
      const fd = openSync(file, "r+");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      publishNoReplace(file, target);
      return { path: target, sha256: hash.digest("hex"), manifest };
    } catch (error) {
      throw error instanceof InstallationSnapshotError ? error : new InstallationSnapshotError((error as NodeJS.ErrnoException).code === "EEXIST" ? "DESTINATION_EXISTS" : "DAMAGED_EXPORT_FAILED");
    } finally {
      (writer?.outputStream as Readable | undefined)?.destroy();
      output?.destroy();
      await completed?.catch(() => {});
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
