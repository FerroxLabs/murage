import { createHash } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { acquireDataDirLeaseForProcess, dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { validateMemorySchema } from "./memory/schema.ts";
import { InstallationTranscriptGraph } from "./installation-transcript-graph.ts";

export class InstallationSnapshotError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Murage database snapshot refused (${code}). Original installation data was preserved.`);
    this.name = "InstallationSnapshotError";
    this.code = code;
  }
}

function regularFile(path: string, missing = false) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new InstallationSnapshotError("UNSAFE_DATABASE_FILE");
    return stat;
  } catch (error) {
    if (missing && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error instanceof InstallationSnapshotError ? error : new InstallationSnapshotError("DATABASE_UNREADABLE");
  }
}

function count(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { count: number };
  if (!Number.isSafeInteger(row.count) || row.count < 0) throw new InstallationSnapshotError("UNSUPPORTED_DATABASE_SIZE");
  return row.count;
}

export function inspectInstallationDatabase(db: DatabaseSync) {
  const fail = (code: string): never => { throw new InstallationSnapshotError(code); };
  // A private archive is still untrusted input. Reject executable schema and
  // unknown tables instead of allowing triggers to run during preparation.
  let memoryObjects = new Set<string>();
  try { memoryObjects = validateMemorySchema(db); }
  catch { fail("DATABASE_SCHEMA_UNSUPPORTED"); }
  const schema = db.prepare("SELECT type,name,tbl_name FROM sqlite_schema").all();
  for (const item of schema) {
    if (memoryObjects.has(String(item.name))) continue;
    if (item.type === "table" && ["messages", "thread_state"].includes(String(item.name))) continue;
    if (item.type === "index" && ["messages", "thread_state"].includes(String(item.tbl_name)) && (String(item.name).startsWith("sqlite_autoindex_") || item.name === "messages_thread")) continue;
    fail("DATABASE_SCHEMA_UNSUPPORTED");
  }
  for (const [table, columns] of Object.entries({ messages: ["thread_id:TEXT:1", "id:TEXT:2", "at:INTEGER:0", "role:TEXT:0", "kind:TEXT:0", "text:TEXT:0", "json:TEXT:0"], thread_state: ["thread_id:TEXT:1", "active_leaf_id:TEXT:0"] })) {
    const actual = db.prepare(`PRAGMA table_info(${table})`).all().map(column => `${column.name}:${String(column.type).toUpperCase()}:${column.pk}`);
    if (JSON.stringify(actual) !== JSON.stringify(columns)) fail("DATABASE_SCHEMA_UNSUPPORTED");
  }
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok") throw new InstallationSnapshotError("DATABASE_INTEGRITY_FAILED");
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('messages','thread_state')").all();
  if (tables.length !== 2) throw new InstallationSnapshotError("DATABASE_SCHEMA_UNSUPPORTED");
  if (count(db, "SELECT COUNT(*) AS count FROM messages WHERE NOT json_valid(json)")) throw new InstallationSnapshotError("INVALID_MESSAGE_JSON");
  if (count(db, "SELECT COUNT(*) AS count FROM messages WHERE json_type(json) != 'object' OR json_extract(json,'$.id') IS NOT id")) throw new InstallationSnapshotError("INVALID_MESSAGE_IDENTITY");
  if (count(db, "SELECT COUNT(*) AS count FROM messages WHERE json_extract(json,'$.at') IS NOT at OR json_extract(json,'$.role') IS NOT role OR json_extract(json,'$.kind') IS NOT kind OR json_extract(json,'$.text') IS NOT text")) fail("INVALID_MESSAGE_IDENTITY");
  if (count(db, "SELECT COUNT(*) AS count FROM thread_state AS t WHERE active_leaf_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages AS m WHERE m.thread_id=t.thread_id AND m.id=t.active_leaf_id)")) {
    throw new InstallationSnapshotError("INVALID_ACTIVE_BRANCH");
  }
  let thread: string | undefined;
  let graph = new InstallationTranscriptGraph(fail);
  for (const row of db.prepare("SELECT thread_id,json FROM messages ORDER BY thread_id,rowid").iterate()) {
    if (typeof row.thread_id !== "string" || !/^[\w-]{1,160}$/.test(row.thread_id) || typeof row.json !== "string" || Buffer.byteLength(row.json) > 64 * 1024 ** 2) fail("INVALID_RESTORE_MESSAGE");
    if (thread !== row.thread_id) {
      graph.validate();
      graph = new InstallationTranscriptGraph(fail);
      thread = row.thread_id as string;
    }
    graph.add(JSON.parse(row.json as string));
  }
  graph.validate();
  return {
    messages: count(db, "SELECT COUNT(*) AS count FROM messages"),
    threads: count(db, "SELECT COUNT(*) AS count FROM thread_state"),
  };
}

function digestFile(path: string): string {
  const fd = openSync(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytes));
    }
  } finally { closeSync(fd); }
}

/** Database component of an offline installation snapshot, not an installation
 * backup by itself. Takes the same external lease as the running harness,
 * copies WAL-visible committed data through SQLite backup, validates it, then
 * publishes without replacing any existing destination. No runtime Store,
 * migration, provider or scheduler is constructed. Other app-state components
 * must eventually share this offline epoch in the complete backup builder. */
async function snapshotDatabaseWhileOwned(dataDir: string, destination: string) {
  const root = dataDirLeasePaths(dataDir).canonicalDataDir;
  if (!destination || /[\r\n\0]/.test(destination) || [".", "..", ""].includes(basename(destination))) throw new InstallationSnapshotError("INVALID_DESTINATION");
  // Canonicalize the parent, not the file: an existing destination must be
  // refused rather than followed as a symlink or treated as a directory.
  const target = join(dataDirLeasePaths(dirname(destination)).canonicalDataDir, basename(destination));
  if (target === root || target.startsWith(root + sep)) throw new InstallationSnapshotError("DESTINATION_INSIDE_INSTALLATION");
  if (resolve(target) === dirname(target)) throw new InstallationSnapshotError("INVALID_DESTINATION");
  try {
    lstatSync(target);
    throw new InstallationSnapshotError("DESTINATION_EXISTS");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let scratch: string | undefined;
  let source: DatabaseSync | undefined;
  try {
    const file = join(root, "messages.db");
    const identity = regularFile(file, true);
    if (!identity) return { status: "absent" as const };
    for (const suffix of ["-wal", "-shm"]) regularFile(file + suffix, true);
    // Private fresh staging is owned exclusively by this operation. linkSync
    // below refuses any preexisting destination, including dangling symlinks.
    scratch = mkdtempSync(join(dirname(target), ".murage-database-snapshot-"));
    const staged = join(scratch, "messages.db");
    const fd = openSync(staged, "wx", 0o600);
    closeSync(fd);
    source = new DatabaseSync(file, { readOnly: true, timeout: 1000 });
    const current = regularFile(file)!;
    if (current.ino !== identity.ino || current.dev !== identity.dev) throw new InstallationSnapshotError("SOURCE_CHANGED");
    inspectInstallationDatabase(source);
    await backup(source, staged, { rate: 128 });
    source.close();
    source = undefined;
    const copied = new DatabaseSync(staged, { readOnly: true, timeout: 1000 });
    let counts;
    try { counts = inspectInstallationDatabase(copied); }
    finally { copied.close(); }
    const after = regularFile(file)!;
    if (after.ino !== identity.ino || after.dev !== identity.dev) throw new InstallationSnapshotError("SOURCE_CHANGED");
    const sha256 = digestFile(staged);
    const bytes = statSync(staged).size;
    const flush = openSync(staged, "r+"); // Windows FlushFileBuffers requires a writable handle.
    try { fsyncSync(flush); } finally { closeSync(flush); }
    linkSync(staged, target);
    return { status: "copied" as const, ...counts, bytes, sha256 };
  } catch (error) {
    throw error instanceof InstallationSnapshotError ? error : new InstallationSnapshotError(
      (error as NodeJS.ErrnoException).code === "EEXIST" ? "DESTINATION_EXISTS" : "DATABASE_SNAPSHOT_FAILED",
    );
  } finally {
    try { source?.close(); }
    finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }
}

export interface OfflineInstallation {
  readonly dataDir: string;
  snapshotDatabase(destination: string): Promise<Awaited<ReturnType<typeof snapshotDatabaseWhileOwned>>>;
}

/** Keep one ownership epoch around every component of an installation copy.
 * Escaped callbacks are rejected after release. A caller that forgets to await
 * a database copy still cannot release the lease while SQLite is writing. */
export async function withOfflineInstallation<T>(dataDir: string, operation: (installation: OfflineInstallation) => Promise<T>): Promise<T> {
  const root = dataDirLeasePaths(dataDir).canonicalDataDir;
  const lease = acquireDataDirLeaseForProcess(root);
  let active = true;
  const pending = new Set<Promise<unknown>>();
  try {
    return await operation(Object.freeze({
      dataDir: root,
      snapshotDatabase(destination: string) {
        if (!active) return Promise.reject(new InstallationSnapshotError("SNAPSHOT_EPOCH_CLOSED"));
        const result = snapshotDatabaseWhileOwned(root, destination);
        pending.add(result);
        // Attach a rejection handler without manufacturing an unhandled
        // finally() branch if an operation abandons its copy promise.
        void result.then(() => pending.delete(result), () => pending.delete(result));
        return result;
      },
    }));
  } finally {
    active = false;
    try { await Promise.allSettled([...pending]); }
    finally { lease.release(); }
  }
}

export async function snapshotInstallationDatabase(dataDir: string, destination: string) {
  return withOfflineInstallation(dataDir, installation => installation.snapshotDatabase(destination));
}
