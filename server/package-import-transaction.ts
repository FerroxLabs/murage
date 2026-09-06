import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { writeFileAtomic } from "./atomic.ts";
import { normalizeBotPackagePath } from "./bot-package-manifest.ts";

const MAX_FILES = 1000, MAX_BYTES = 50 * 1024 * 1024;
const TX_DIRECTORY = ".package-import-transaction";
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const journalSchema = z.object({
  version: z.literal(1), id: uuid, phase: z.enum(["staging", "prepared", "committed"]),
  rootIdentity: z.string(), allowedNewBotIds: z.array(uuid).max(MAX_FILES),
  entries: z.array(z.object({ path: z.string(), beforeHash: sha.nullable(), afterHash: sha, beforeBytes: z.number().int().min(0).max(MAX_BYTES), afterBytes: z.number().int().min(0).max(MAX_BYTES) }).strict()).min(1).max(MAX_FILES),
}).strict();
type Journal = z.infer<typeof journalSchema>;
export interface PackageImportTransactionOptions {
  allowedNewBotIds: readonly string[];
  /** Trusted caller must own the installation lease for this whole sync call. */
  assertOwned: () => void;
  checkpoint?: (phase: string) => void;
}
type RecoveryOptions = Pick<PackageImportTransactionOptions, "assertOwned" | "checkpoint">;
export class PackageImportTransactionError extends Error {
  readonly code: string;
  constructor(code: string) { super(`Package import transaction refused (${code}).`); this.code = code; }
}
function fail(code: string): never { throw new PackageImportTransactionError(code); }
function entry(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function syncDirectory(path: string) {
  // Windows directory fsync is unavailable through Node; native power-loss
  // proof remains separate from the process-interruption journal contract.
  if (process.platform === "win32") return;
  const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function rootPaths(dataDir: string) {
  const root = dataDirLeasePaths(dataDir).canonicalDataDir;
  const stat = entry(root);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_PACKAGE_IMPORT_ROOT");
  return { root, tx: join(root, TX_DIRECTORY), identity: `${stat.dev}:${stat.ino}` };
}
function allowedPath(path: string, ids: readonly string[]): boolean {
  try { normalizeBotPackagePath(path); } catch { return false; }
  if (["bots.json", "groups.json", "routines.json"].includes(path)) return true;
  const parts = path.split("/");
  if (!ids.includes(parts[1]) || !uuid.safeParse(parts[1]).success) return false;
  if (parts[0] === "skill-state") return parts.length === 3 && parts[2] === "skills.json";
  return parts[0] === "workspaces" && ((parts.length === 3 && parts[2] === "SOUL.md") ||
    (parts.length >= 5 && parts[2] === "skills" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(parts[3])));
}
function checkedPath(root: string, relative: string) {
  const parts = relative.split("/");
  for (let index = 1; index < parts.length; index++) {
    const stat = entry(join(root, ...parts.slice(0, index)));
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail("UNSAFE_PACKAGE_IMPORT_PATH");
  }
  return join(root, ...parts);
}
function read(path: string): Buffer | null {
  const stat = entry(path);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) fail("UNSAFE_PACKAGE_IMPORT_FILE");
  return readFileSync(path);
}
function replace(root: string, path: string, bytes: Buffer, id: string) {
  const target = checkedPath(root, path), parent = dirname(target);
  // Sync each newly created directory's parent, as file fsync alone cannot
  // make a newly installed workspace directory durable.
  let current = root;
  for (const part of path.split("/").slice(0, -1)) {
    const next = join(current, part);
    if (!entry(next)) { mkdirSync(next, { mode: 0o700 }); syncDirectory(current); }
    current = next;
  }
  const temporary = `${target}.package-${id}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600, flush: true });
    renameSync(temporary, target); syncDirectory(parent);
  } finally {
    // A crash can leave this task-owned sibling, but a later recovery must
    // not remove a replacement from some other transaction.
    if (entry(temporary)) { unlinkSync(temporary); syncDirectory(parent); }
  }
}
function publishJournal(tx: string, journal: Journal) {
  writeFileAtomic(join(tx, "journal.json"), JSON.stringify(journal) + "\n", { mode: 0o600 });
  syncDirectory(tx);
}
function validateJournal(value: unknown, identity: string): Journal {
  const parsed = journalSchema.safeParse(value);
  if (!parsed.success || parsed.data.rootIdentity !== identity) fail("INVALID_PACKAGE_IMPORT_JOURNAL");
  const journal = parsed.data, paths = new Set<string>();
  let oldBytes = 0, newBytes = 0;
  for (const item of journal.entries) {
    if (!allowedPath(item.path, journal.allowedNewBotIds) || paths.has(item.path.toLowerCase())) fail("INVALID_PACKAGE_IMPORT_JOURNAL");
    if (item.path.includes("/") && item.beforeHash !== null) fail("INVALID_PACKAGE_IMPORT_JOURNAL");
    paths.add(item.path.toLowerCase()); oldBytes += item.beforeBytes; newBytes += item.afterBytes;
  }
  if (oldBytes > MAX_BYTES || newBytes > MAX_BYTES) fail("PACKAGE_IMPORT_LIMIT");
  return journal;
}
function cleanup(root: string, tx: string) {
  rmSync(tx, { recursive: true }); syncDirectory(root);
}

/** Synchronous durability boundary. The caller may publish its new in-memory
 * store only after this returns. Existing journal => explicit recovery first. */
export function commitPackageImportFiles(dataDir: string, replacements: ReadonlyMap<string, Buffer>, expectedHashes: ReadonlyMap<string, string | null>, options: PackageImportTransactionOptions): { id: string; status: "committed" } {
  options.assertOwned();
  const { root, tx, identity } = rootPaths(dataDir);
  if (entry(tx)) fail("PACKAGE_IMPORT_RECOVERY_REQUIRED");
  if (!replacements.size || replacements.size > MAX_FILES || expectedHashes.size !== replacements.size || options.allowedNewBotIds.length > MAX_FILES || new Set(options.allowedNewBotIds).size !== options.allowedNewBotIds.length || options.allowedNewBotIds.some(id => !uuid.safeParse(id).success)) fail("INVALID_PACKAGE_IMPORT_INPUT");
  for (const id of options.allowedNewBotIds) for (const base of ["workspaces", "skill-state"]) {
    if (entry(checkedPath(root, `${base}/${id}`))) fail("PACKAGE_IMPORT_BOT_PATH_EXISTS");
  }
  const originals: Array<Buffer | null> = [];
  let beforeBytes = 0, afterBytes = 0;
  const journal: Journal = { version: 1, id: randomUUID(), phase: "staging", rootIdentity: identity, allowedNewBotIds: [...options.allowedNewBotIds], entries: [] };
  for (const [path, bytes] of replacements) {
    if (!Buffer.isBuffer(bytes) || !allowedPath(path, options.allowedNewBotIds) || !expectedHashes.has(path)) fail("INVALID_PACKAGE_IMPORT_INPUT");
    afterBytes += bytes.length;
    if (afterBytes > MAX_BYTES) fail("PACKAGE_IMPORT_LIMIT");
    const before = read(checkedPath(root, path)), beforeHash = before === null ? null : hash(before);
    beforeBytes += before?.length ?? 0;
    if (beforeBytes > MAX_BYTES) fail("PACKAGE_IMPORT_LIMIT");
    if (beforeHash !== expectedHashes.get(path)) fail("PACKAGE_IMPORT_SOURCE_CHANGED");
    originals.push(before);
    journal.entries.push({ path, beforeHash, afterHash: hash(bytes), beforeBytes: before?.length ?? 0, afterBytes: bytes.length });
  }
  validateJournal(journal, identity);
  mkdirSync(tx, { mode: 0o700 });
  // A visible journal is retained on every failure. Startup performs the
  // deterministic old/new recovery before any Store/RoutineManager loads.
  publishJournal(tx, journal); syncDirectory(root);
  mkdirSync(join(tx, "old"), { mode: 0o700 }); mkdirSync(join(tx, "new"), { mode: 0o700 });
  for (const [index, item] of journal.entries.entries()) {
    if (originals[index] !== null) writeFileSync(join(tx, "old", String(index)), originals[index]!, { flag: "wx", mode: 0o600, flush: true });
    writeFileSync(join(tx, "new", String(index)), replacements.get(item.path)!, { flag: "wx", mode: 0o600, flush: true });
  }
  syncDirectory(join(tx, "old")); syncDirectory(join(tx, "new"));
  options.checkpoint?.("staged");
  journal.phase = "prepared"; publishJournal(tx, journal);
  options.checkpoint?.("prepared");
  for (const [index, item] of journal.entries.entries()) {
    options.assertOwned();
    const current = read(checkedPath(root, item.path));
    if ((current === null ? null : hash(current)) !== item.beforeHash) fail("PACKAGE_IMPORT_SOURCE_CHANGED");
    const staged = read(join(tx, "new", String(index)));
    if (!staged || hash(staged) !== item.afterHash) fail("PACKAGE_IMPORT_RETAINED_CHANGED");
    replace(root, item.path, staged, journal.id);
    options.checkpoint?.(`replaced:${index}`);
  }
  journal.phase = "committed"; publishJournal(tx, journal);
  options.checkpoint?.("committed");
  cleanup(root, tx);
  return { id: journal.id, status: "committed" };
}

export function recoverPackageImportTransaction(dataDir: string, options: RecoveryOptions): { status: "none" | "rolled-back" | "committed"; id?: string } {
  options.assertOwned();
  const { root, tx, identity } = rootPaths(dataDir);
  const stat = entry(tx);
  if (!stat) return { status: "none" };
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_PACKAGE_IMPORT_JOURNAL");
  const raw = read(join(tx, "journal.json"));
  if (!raw || raw.length > 1024 * 1024) fail("INVALID_PACKAGE_IMPORT_JOURNAL");
  let value: unknown;
  try { value = JSON.parse(raw.toString("utf8")); } catch { fail("INVALID_PACKAGE_IMPORT_JOURNAL"); }
  const journal = validateJournal(value, identity), committed = journal.phase === "committed";
  const saved: Array<Buffer | null> = [];
  // Validate every target and retained byte before performing any correction.
  for (const [index, item] of journal.entries.entries()) {
    const current = read(checkedPath(root, item.path)), currentHash = current === null ? null : hash(current);
    if (currentHash !== item.beforeHash && (journal.phase === "staging" || currentHash !== item.afterHash)) fail("PACKAGE_IMPORT_TARGET_CHANGED");
    const expected = committed ? item.afterHash : item.beforeHash;
    const bytes = journal.phase === "staging" || expected === null ? null : read(checkedPath(tx, `${committed ? "new" : "old"}/${index}`));
    if (journal.phase !== "staging" && expected !== null && (!bytes || hash(bytes) !== expected)) fail("PACKAGE_IMPORT_RETAINED_CHANGED");
    saved.push(bytes);
  }
  if (journal.phase !== "staging") for (const [index, item] of journal.entries.entries()) {
    options.assertOwned();
    const target = checkedPath(root, item.path), bytes = saved[index];
    const temporary = `${target}.package-${journal.id}.tmp`;
    if (entry(temporary)) { read(temporary); unlinkSync(temporary); syncDirectory(dirname(temporary)); }
    if (bytes !== null) replace(root, item.path, bytes, journal.id);
    else if (entry(target)) { unlinkSync(target); syncDirectory(dirname(target)); }
    options.checkpoint?.(`recovered:${index}`);
  }
  if (!committed) for (const id of journal.allowedNewBotIds) for (const base of ["workspaces", "skill-state"]) {
    // Remove empty task-owned directories only; foreign files are preserved.
    const paths = journal.entries.filter(item => item.path.startsWith(`${base}/${id}/`)).map(item => dirname(item.path));
    for (const relative of paths.sort((a, b) => b.length - a.length)) {
      let current = checkedPath(root, relative);
      const boundary = join(root, base, id);
      while (current.length >= boundary.length) {
        try { rmdirSync(current); syncDirectory(dirname(current)); }
        catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        if (current === boundary) break;
        current = dirname(current);
      }
    }
  }
  cleanup(root, tx);
  return { id: journal.id, status: committed ? "committed" : "rolled-back" };
}
