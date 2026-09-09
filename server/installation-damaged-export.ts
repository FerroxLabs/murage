import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, createReadStream, createWriteStream, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, writeSync, type Stats } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { portableArchivePath, type ArchiveLimits } from "./installation-archive.ts";
import { InstallationSnapshotError, withOfflineInstallation } from "./installation-database-snapshot.ts";

const RECORDS = new Set(["config.json", "bots.json", "groups.json", "routines.json", "calendar-calls.json", "webhooks.json", "delegations.json", "delegation-receipts.json", "section-contexts.json", "browser-cleanups.json", "messages.db", "messages.db-wal", "messages.db-shm"]);
const DIRECTORIES = new Set(["attachments", "artifact-files", "workspaces", "skills", "skill-state", "checkpoints", "events"]);
const fail = (code: string): never => { throw new InstallationSnapshotError(code); };
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
 * restore. No JSON parsing, SQLite opening, normalization or credential
 * projection occurs. Damaged config/transcripts can contain secrets. Native
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
    const scratch = mkdtempSync(join(parent, ".murage-damaged-export-"));
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
        const folded = new Set<string>();
        for (const name of readdirSync(source).sort()) {
          if (folded.has(name.toLowerCase())) fail("NONPORTABLE_SNAPSHOT_PATH");
          folded.add(name.toLowerCase());
          copy(`${path}/${name}`, depth + 1);
        }
        return;
      }
      if (!before.isFile() || before.nlink !== 1) fail("UNSAFE_SNAPSHOT_ENTRY");
      if (before.size > maxBytes - bytes) fail("SNAPSHOT_LIMIT_EXCEEDED");
      const to = join(scratch, "preservation", ...path.split("/"));
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      const input = openSync(source, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      let out: number | undefined;
      let size = 0;
      const hash = createHash("sha256");
      try {
        const opened = fstatSync(input);
        if (!same(before, opened) || !opened.isFile() || opened.nlink !== 1) fail("SOURCE_CHANGED");
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
    try {
      check();
      const names = readdirSync(root).sort();
      if (names.length > maxFiles) fail("SNAPSHOT_LIMIT_EXCEEDED");
      const folded = new Set<string>();
      for (const name of names) {
        if (!portableArchivePath(name) || folded.has(name.toLowerCase())) fail("NONPORTABLE_SNAPSHOT_PATH");
        folded.add(name.toLowerCase());
        if (RECORDS.has(name) || DIRECTORIES.has(name) || /^messages-[\w-]+\.json$/.test(name) || /^decisions\.ndjson(?:\.1)?$/.test(name)) copy(name);
        else {
          if (++entries > maxFiles) fail("SNAPSHOT_LIMIT_EXCEEDED");
          manifest.omitted.push({ path: name, reason: ["vm-home", "vm-homes"].includes(name) ? "VM workspace not quiesced; includes native browser credentials" : "Native credential home, connection realm, cache or unrecognized component excluded" });
        }
      }
      for (const name of RECORDS) if (!names.includes(name)) manifest.missing.push(name);
      if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify(names)) fail("SOURCE_CHANGED");
      for (const [path, before] of observed) if (!same(before, lstatSync(path))) fail("SOURCE_CHANGED");
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
      linkSync(file, target);
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
