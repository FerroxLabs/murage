// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 q1022-startmem (MAIN-RULING 2026-11-25T15:37Z): a memory table that cannot be read, checked or migrated at open never stops the
// app opening. The open carries on with memory set aside for this run (a connection hold: every read and use of memory is refused,
// capture included, because the tables it would write are the ones that failed), chats, bots and files work as usual, and the owner is
// told in one plain line. Before the start carries on, the data folder's top-level files (messages.db and the lists) are copied as
// they are, once, beside it (the rescue copy), so nothing a later repair does can lose what was there.
//
// What still ends the start: a full disk (its own words, nothing changed), a read-only start that would have to migrate, and memory
// written by a NEWER Murage (the install-the-newer-version screen; this build cannot know what that data means).
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statfsSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DiskFloorRefusal, isLowDisk } from "../db-busy.ts";
import { setBootStep } from "../boot-progress.ts";
import { START_FLOOR_BYTES } from "../read-only-start.ts";

/** The connection hold set when memory could not be opened (memory-gate.ts refuses every use of memory under it, capture included). */
export const MEMORY_OPEN_HOLD = "MEMORY_UNREADABLE_AT_OPEN";
/** The one line the owner reads (health `holdMessage`, memory status) once the rescue copy is complete. */
export const MEMORY_OPEN_HOLD_MESSAGE = "Murage could not read its memory when it started, so memory is set aside for now. Your chats, bots and files work as usual and nothing was deleted. A copy of your chats and settings is kept beside your data folder.";
/** The same line while the rescue copy is not complete (no room on the disk for all of it, or it failed): it never claims a copy. */
export const MEMORY_OPEN_HOLD_MESSAGE_NO_COPY = "Murage could not read its memory when it started, so memory is set aside for now. Your chats, bots and files work as usual and nothing was deleted. Murage could not finish a copy of your chats and settings yet: free some disk space and it makes one the next time it starts.";
let rescueKept = false;
/** The owner line for this run: it says a copy is kept only when this data folder's rescue copy is complete. */
export function memoryOpenHoldMessage(): string { return rescueKept ? MEMORY_OPEN_HOLD_MESSAGE : MEMORY_OPEN_HOLD_MESSAGE_NO_COPY; }
/** A start that makes no copy (read-only): the owner line still says a copy is kept when an earlier start completed one. */
export function noteRescueCopyKept(dataDir: string): void { rescueKept = copyKnownComplete(readRescueMarker(dataDir)); }
/** A marker saying complete is trusted only when what it names is there: its folder with every file it kept, and no publish left
 * unfinished beside it (Astra 3826359de9 High: a marker whose own flush failed, and whose putting back to "copying" failed too, can be
 * left saying complete; the next start then checks the copy instead of trusting the word). */
function copyKnownComplete(marker: { path: string | null; state: string; kept: string[] } | null): boolean {
  if (marker?.state !== "complete" || !marker.path || !marker.kept.length) return false;
  const folder = marker.path;
  try { if (!lstatSync(folder).isDirectory()) return false; } catch { return false; }
  return marker.kept.every(name => existsSync(join(folder, name))) && !existsSync(`${folder}.aside.json`) && !existsSync(`${folder}.aside`);
}
/** The one-shot marker (in the data folder): the rescue copy is made once per data folder, never on every start. */
export const RESCUE_MARKER = "memory-rescue.json";

/** Whether a memory open failure is set aside (true) or still ends the start (false). `from` is the memory version the file says. */
export function setsMemoryAside(error: unknown, from: number | null, newest: number): boolean {
  if (isLowDisk(error) || error instanceof DiskFloorRefusal) return false;
  if (from !== null && from > newest) return false;
  return true;
}

/** A short, path-free code for the log line. */
export function memoryOpenFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = /^[A-Z][A-Z0-9_]{3,80}/.exec(message)?.[0];
  if (code) return code;
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  if (typeof errcode === "number") return `SQLITE_${errcode & 0xff}${(errcode & 0xff) === 11 ? "_CORRUPT" : (errcode & 0xff) === 26 ? "_NOTADB" : ""}`;
  return "MEMORY_OPEN_FAILED";
}

/** What the rescue copy holds: every regular file at the top of the data folder (messages.db and its -wal, the bot, group and routine
 * lists, settings) except the earlier memory upgrade snapshots (themselves copies). Folders (files, models, tools) are left out: no
 * memory repair touches them, and copying them before the server listens could outlast the start-up step limit
 * (electron/boot-progress-watch.mjs BOOT_STEP_STALL_MS). In groups, most valuable first: messages.db with its -wal as one group (the
 * file without its log is not the data), then every other file, smallest first, so a disk short of room keeps the chats first. */
function rescueGroups(dataDir: string): Array<Array<{ name: string; bytes: number }>> {
  const files: Array<{ name: string; bytes: number }> = [];
  for (const name of readdirSync(dataDir)) {
    if (name === RESCUE_MARKER || name.startsWith(`${RESCUE_MARKER}.`) || /^messages\.pre-memory-v\d+\.db/.test(name) || name === "messages.db-shm") continue;
    const stat = lstatSync(join(dataDir, name));
    if (stat.isFile()) files.push({ name, bytes: stat.size });
  }
  const chats = files.filter(file => file.name === "messages.db" || file.name === "messages.db-wal");
  const rest = files.filter(file => !chats.includes(file)).sort((a, b) => a.bytes - b.bytes);
  return [...(chats.length ? [chats] : []), ...rest.map(file => [file])];
}
/** The marker, durable and whole: written beside, flushed, then renamed over (a power cut leaves the old marker or the new one, never a
 * torn one). */
function writeRescueMarker(dataDir: string, marker: Record<string, unknown>): void {
  const at = join(dataDir, RESCUE_MARKER), next = `${at}.next`;
  const fd = openSync(next, "w", 0o600);
  try { writeSync(fd, JSON.stringify(marker) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(next, at);
  try { flushFolder(dataDir); }
  catch (error) {
    // the new marker is visible but may not be on the disk: it never stays saying more than is known (Astra 16f2449f12 High); the copy
    // is "copying" again (whatever it holds kept stays kept), so the next start checks it and finishes it
    if (marker.state !== "copying") { const back = openSync(next, "w", 0o600); try { writeSync(back, JSON.stringify({ ...marker, state: "copying" }) + "\n"); fsyncSync(back); } finally { closeSync(back); } renameSync(next, at); }
    throw error;
  }
}

/** A folder's entries made durable (a rename is only on disk once its folder is flushed). Only a folder that cannot be flushed at all
 * (win32 cannot open one; some volumes refuse a folder flush as unsupported) is passed over; any other failure (EIO, ENOSPC) throws, so
 * nothing after it (a marker naming a group kept, a marker saying complete) ever stands on renames that may not be on the disk (Astra
 * bb86046213 High): the copy stays "copying", and the next start puts the group back and makes it again. */
const FOLDER_FLUSH_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR", "EPERM", "EACCES", "EBADF"]);
function flushFolder(dir: string): void {
  // win32 refuses to open a folder (EISDIR/EPERM/EACCES), so it lands here too; an EIO is never passed over on any platform
  const unsupported = (error: unknown) => FOLDER_FLUSH_UNSUPPORTED.has(String((error as NodeJS.ErrnoException).code));
  let fd: number;
  try { fd = openSync(dir, "r"); } catch (error) { if (unsupported(error)) return; throw error; }
  try { fsyncSync(fd); } catch (error) { if (!unsupported(error)) throw error; } finally { closeSync(fd); }
}
/** A file's bytes made durable (a clone or a copy of an empty file has no chunk flush of its own). Opened read-only (a clone keeps the
 * data file's mode, which may be read-only); win32 flushes only a handle opened for writing. */
function flushFile(path: string): void {
  const fd = openSync(path, process.platform === "win32" ? "r+" : "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** The scratch of a rescue folder lives BESIDE it, never in it (Astra 3029be67c8 High): the copy holds the data folder's top-level files
 * by their own names, so a name the copy uses for its scratch (a <name>.part, a <name>.old) can be a data file's own name. Beside it, in
 * folders named after the rescue folder, no data file can take the name: <target>.stage holds the files of a group being written,
 * <target>.aside the earlier files of a group being published, and <target>.aside.json (written before anything moves aside) names the
 * group being published and which of its names the folder held before, so a start stopped anywhere in a publish, or in the putting back
 * of one, can tell the earlier files from the new ones. */
const stageOf = (target: string) => `${target}.stage`, asideOf = (target: string) => `${target}.aside`, journalOf = (target: string) => `${target}.aside.json`;
/** A scratch folder of ours, made if missing; a file or a link in its place (never ours) is removed (the link alone, never its target). */
function scratchFolder(dir: string): string {
  if (existsSync(dir) && !lstatSync(dir).isDirectory()) rmSync(dir, { force: true });
  else { try { if (lstatSync(dir).isSymbolicLink()) rmSync(dir, { force: true }); } catch { /* not there */ } }
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  return dir;
}
const plainNames = (value: unknown): string[] => Array.isArray(value) ? value.filter((name): name is string => typeof name === "string" && basename(name) === name && name !== "." && name !== "..") : [];
/** A start stopped while it published a group, or while it put one back: the earlier files of the group (in <target>.aside) go back
 * unless the marker names the new group kept, so the folder never holds files of two copies (Astra f31d8bae37, 69ac7b7e96). The journal
 * is what makes it safe to stop anywhere (Astra 3029be67c8 High, a second stop during the putting back): it goes LAST, so a stop at any
 * point leaves it, and the next start again removes the new files the earlier copy did not have (the journal says which) and renames back
 * whatever is still aside. */
function putBackAside(target: string, kept: string[]): void {
  const aside = asideOf(target), journal = journalOf(target);
  const held = existsSync(aside) && lstatSync(aside).isDirectory() ? readdirSync(aside) : [];
  let plan: { group: string[]; earlier: string[] } | null = null;
  try { const raw = JSON.parse(readFileSync(journal, "utf8")) as { group?: unknown; earlier?: unknown }; plan = { group: plainNames(raw.group), earlier: plainNames(raw.earlier) }; } catch { /* none, or never written whole */ }
  if (plan && plan.group.length && plan.group.every(name => kept.includes(name))) {
    // the marker names the new group kept: the earlier files were only waiting to be removed
    for (const name of held) rmSync(join(aside, name), { recursive: true, force: true });
  } else {
    if (plan) for (const name of plan.group) if (!plan.earlier.includes(name) && !kept.includes(name)) rmSync(join(target, name), { force: true });
    flushFolder(target);
    for (const name of held) renameSync(join(aside, name), join(target, name));
    flushFolder(target);
  }
  rmSync(journal, { force: true });
  rmSync(aside, { recursive: true, force: true });
  flushFolder(dirname(target));
}

/** The bytes one step of a byte copy moves before the start-up note's step moves on (boot-progress.ts setBootStep): at 8 MiB even a slow
 * disk (a few MB/s) moves the step every few seconds, far inside the shell's 5-minute stall limit (electron/boot-progress-watch.mjs). */
export const RESCUE_CHUNK_BYTES = 8 * 1024 * 1024;
/** The step the note names while the rescue copy runs; the byte copy adds `:<percent>` and moves the step's sequence every chunk. */
export const RESCUE_COPY_STEP = "database.memory-rescue-copy";

/** One file of the rescue copy (MAIN-RULING 2026-11-25T18:04Z: never skipped, never held past the start-up limit). First a copy-on-write
 * clone (APFS clonefile, a reflink on btrfs/XFS; Node's COPYFILE_FICLONE_FORCE): instant, whatever the size. Where the volume cannot
 * clone, a byte copy in RESCUE_CHUNK_BYTES chunks, and every chunk moves the start-up note on (the shell's watch counts a moved step as
 * progress), so a large messages.db on a slow disk keeps the start alive however long it takes. Synchronous on purpose: nothing else of
 * the start (no memory repair, no write to the data folder) runs until the copy is complete. */
function copyOne(from: string, to: string, progress: (bytes: number) => void): "clone" | "bytes" {
  try { copyFileSync(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE); return "clone"; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error; rmSync(to, { force: true }); }
  const input = openSync(from, "r");
  try {
    const output = openSync(to, "wx", 0o600);
    try {
      const buffer = Buffer.allocUnsafe(RESCUE_CHUNK_BYTES);
      for (let position = 0; ;) {
        const read = readSync(input, buffer, 0, buffer.length, position);
        if (read === 0) break;
        for (let written = 0; written < read;) written += writeSync(output, buffer, written, read - written, position + written);
        position += read;
        // durable before the step moves on: a step that says N% copied never stands on bytes still waiting in the page cache, and the
        // flush is one chunk at most (a single flush of gigabytes at the end would be one long step again)
        fsyncSync(output);
        progress(read);
      }
    } finally { closeSync(output); }
  } finally { closeSync(input); }
  return "bytes";
}

function readRescueMarker(dataDir: string): { path: string | null; state: string; attempt: number; kept: string[] } | null {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, RESCUE_MARKER), "utf8")) as { path?: unknown; state?: unknown; attempt?: unknown; kept?: unknown };
    const kept = Array.isArray(raw.kept) ? raw.kept.filter((name): name is string => typeof name === "string" && basename(name) === name && name !== "." && name !== "..") : [];
    return { path: typeof raw.path === "string" ? raw.path : null, state: String(raw.state), attempt: Number.isInteger(raw.attempt) ? Number(raw.attempt) : 1, kept };
  } catch { return null; }
}
const freeBytes = (dir: string) => { const fs = statfsSync(dir); return Number(fs.bavail) * Number(fs.bsize); };

export type RescueResult = { status: "copied"; path: string; method: "clone" | "bytes" | "mixed" } | { status: "partial"; path: string; leftOut: string[] } | { status: "skipped"; reason: string };
/** The rescue copy (MAIN-RULING 2026-11-25T18:04Z: never skipped): the data folder's top-level files, raw, into a new sibling folder, made
 * once per data folder. The marker is written (atomically) BEFORE the copy and again after each group it completes ("kept"), so a start
 * stopped mid-copy, or one that had no room for everything, is seen by the next start, which goes on in the SAME folder: every group kept
 * there stays as it is (a retry never removes a copy of the chats it made before, Astra 0ebe1908fb), only what is not kept (a file cut off
 * mid-copy) is removed, and the rest is copied; every start does so until the copy completes (no attempt limit). A marker that cannot
 * be read is a copy never known complete: made again. Each file is cloned where the volume can (no space taken), else byte-copied, but
 * a byte copy never takes the disk under the start's own floor (read-only-start.ts START_FLOOR_BYTES; below it the start itself would be
 * refused): a group that does not fit is left out, the marker says "partial", the owner line does not claim a copy, and the next start
 * tries again. Never throws: the start goes on either way. */
export function rescueCopyOnce(dataDir: string, now = new Date()): RescueResult {
  rescueKept = false;
  try {
    let attempt = 1, target: string | null = null, kept: string[] = [], lost: string[] = [];
    if (existsSync(join(dataDir, RESCUE_MARKER))) {
      const earlier = readRescueMarker(dataDir);
      if (copyKnownComplete(earlier)) { rescueKept = true; return { status: "skipped", reason: "already-made" }; }
      if (earlier) {
        attempt = earlier.attempt + 1;
        // only the sibling the marker names, and only a real folder (never a link)
        if (earlier.path && dirname(earlier.path) === dirname(dataDir) && basename(earlier.path).startsWith(`${basename(dataDir)}-rescue-`) && existsSync(earlier.path) && lstatSync(earlier.path).isDirectory()) {
          target = earlier.path;
          kept = earlier.kept.filter(name => existsSync(join(earlier.path!, name)));
          lost = earlier.kept.filter(name => !kept.includes(name));
          putBackAside(target, kept);
          // only what a cut-off copy left (in <target>.stage) goes now; every file of the folder stays until its replacement is complete
          rmSync(stageOf(target), { recursive: true, force: true });
        }
      }
    }
    const groups = rescueGroups(dataDir);
    const bytes = groups.flat().reduce((total, file) => total + file.bytes, 0);
    if (!target) {
      // a new folder, never one that is there already (a second start in the same millisecond, a folder left by hand): a suffix, never a skip
      const named = join(dirname(dataDir), `${basename(dataDir)}-rescue-${now.toISOString().replace(/[:.]/g, "-")}`);
      target = named;
      const taken = (path: string) => existsSync(path) || existsSync(stageOf(path)) || existsSync(asideOf(path)) || existsSync(journalOf(path));
      for (let n = 2; taken(target); n++) target = `${named}-${n}`;
    }
    // the marker keeps naming a file it lost until its group is copied again: a stop before that leaves the next start knowing the copy is short
    writeRescueMarker(dataDir, { path: target, at: now.toISOString(), bytes, attempt, kept: [...kept, ...lost], state: "copying" });
    setBootStep(RESCUE_COPY_STEP);
    if (!existsSync(target)) mkdirSync(target, { mode: 0o700 });
    let done = 0;
    const methods = new Set<"clone" | "bytes">(), leftOut: string[] = [];
    for (const group of groups) {
      // a group an earlier start copied stays as it was (its marker names it kept; the chats copied without a log while there was none
      // count, the copy of the chats is then the earlier, pre-repair one). A group the marker named that has lost any of its files (the
      // chats with only their log gone) is not kept: it is copied again whole, so a copy is never called complete without its log
      if (group.some(file => kept.includes(file.name)) && !group.some(file => lost.includes(file.name) || file.name === "messages.db" && lost.includes("messages.db-wal"))) { done += group.reduce((total, file) => total + file.bytes, 0); continue; }
      // every file is written into <target>.stage and renamed over only once the whole group is written: a file already in the folder
      // (a copy from an earlier start the marker does not name) is never removed before its replacement is complete
      const stage = scratchFolder(stageOf(target));
      const part = (name: string) => join(stage, name);
      const cloned: string[] = [];
      try {
        for (const file of group) { rmSync(part(file.name), { force: true }); copyFileSync(join(dataDir, file.name), part(file.name), constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE); cloned.push(file.name); }
        methods.add("clone");
      } catch {
        for (const name of cloned) rmSync(part(name), { force: true });
        cloned.length = 0;
        const need = group.reduce((total, file) => total + file.bytes, 0);
        if (freeBytes(dirname(dataDir)) - need < START_FLOOR_BYTES) { leftOut.push(...group.map(file => file.name)); done += need; continue; }
      }
      if (cloned.length) done += group.reduce((total, file) => total + file.bytes, 0);
      else {
        for (const file of group) {
          rmSync(part(file.name), { force: true });
          methods.add(copyOne(join(dataDir, file.name), part(file.name), moved => {
            done += moved;
            setBootStep(`${RESCUE_COPY_STEP}:${bytes > 0 ? Math.min(99, Math.floor((done * 100) / bytes)) : 0}`);
          }));
        }
      }
      // publish: the new files are durable first (Astra 3029be67c8 High: a marker naming a group kept never stands on bytes or names still
      // in the page cache); the journal names the group and the earlier files it replaces; the earlier files of this group (the chats:
      // both messages.db and its -wal, whatever the live folder has now) move into <target>.aside, the new ones take their names, the
      // folder is flushed, the marker names the group kept, and only then do the earlier ones go
      for (const file of group) flushFile(part(file.name));
      flushFolder(stage);
      const names = group.some(file => file.name === "messages.db") ? [...new Set([...group.map(file => file.name), "messages.db", "messages.db-wal"])] : group.map(file => file.name);
      const aside = names.filter(name => existsSync(join(target!, name)));
      const journal = journalOf(target), asideDir = asideOf(target);
      // the aside folder is made BEFORE the journal and the parent flush after it, so both entries are on the disk before an earlier
      // file moves into it (Astra 16f2449f12 High: a power cut never keeps the journal and loses the folder the earlier files went to)
      if (aside.length) scratchFolder(asideDir);
      const journalNext = `${journal}.next`, fd = openSync(journalNext, "w", 0o600);
      try { writeSync(fd, JSON.stringify({ group: group.map(file => file.name), earlier: aside }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(journalNext, journal);
      flushFolder(dirname(target));
      if (aside.length) {
        for (const name of aside) renameSync(join(target, name), join(asideDir, name));
        flushFolder(asideDir);
        flushFolder(target);
      }
      for (const file of group) renameSync(part(file.name), join(target, file.name));
      flushFolder(target);
      kept = [...kept.filter(name => !group.some(file => file.name === name)), ...group.map(file => file.name)];
      lost = lost.filter(name => !group.some(file => file.name === name) && !(name === "messages.db-wal" && group.some(file => file.name === "messages.db")));
      writeRescueMarker(dataDir, { path: target, at: now.toISOString(), bytes, attempt, kept: [...kept, ...lost], state: "copying" });
      rmSync(asideDir, { recursive: true, force: true });
      rmSync(journal, { force: true });
    }
    rmSync(stageOf(target), { recursive: true, force: true });
    if (leftOut.length) {
      writeRescueMarker(dataDir, { path: target, at: now.toISOString(), bytes, attempt, kept: [...kept, ...lost], leftOut, state: "partial" });
      return { status: "partial", path: target, leftOut };
    }
    const method = methods.size === 1 ? [...methods][0]! : methods.size === 0 ? "clone" : "mixed";
    writeRescueMarker(dataDir, { path: target, at: now.toISOString(), bytes, attempt, kept, method, state: "complete" });
    rescueKept = true;
    return { status: "copied", path: target, method };
  } catch (error) {
    return { status: "skipped", reason: `copy-failed ${error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.message.slice(0, 80) : "unknown"}` };
  } finally { setBootStep("database.memory"); }
}

/** memory_meta itself unreadable (its page torn): every reader of it, and there are many at start (learning-ledger.ts, policy.ts, ...),
 * would end the start. Only for a connection whose memory is set aside: a TEMP memory_meta with this file's columns and one row saying
 * memory is off takes the unqualified name on this connection, so those readers see memory off and nothing reads or writes the torn
 * pages. The file is not changed. Returns whether the stand-in was made. */
export function standInForUnreadableMeta(db: DatabaseSync, schemaVersion: number): boolean {
  try { db.prepare("SELECT * FROM main.memory_meta").all(); return false; } catch { /* unreadable: the stand-in below */ }
  const columns = db.prepare("PRAGMA main.table_info(memory_meta)").all() as Array<{ name: string; type: string }>;
  if (!columns.length) return false;
  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const value = (column: { name: string; type: string }) => column.name === "id" ? 1 : column.name === "mode" ? "off" : column.name === "schema_version" ? schemaVersion : /INT|REAL|NUM/i.test(column.type) ? 0 : "";
  // a read-only start (query_only, database.ts) refuses these too: they only touch this connection's TEMP schema, never the file, so
  // query_only is lifted around them alone and put back
  const queryOnly = Number((db.prepare("PRAGMA query_only").get() as { query_only: number }).query_only) === 1;
  if (queryOnly) db.exec("PRAGMA query_only=OFF");
  try {
    db.exec(`CREATE TEMP TABLE memory_meta(${columns.map(column => `${quote(column.name)} ${/^[A-Z ]*$/i.test(column.type) ? column.type : ""}`).join(",")})`);
    db.prepare(`INSERT INTO temp.memory_meta VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map(value));
  } finally { if (queryOnly) db.exec("PRAGMA query_only=ON"); }
  return true;
}
