// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every byte read of Murage's attachment folder goes through this module
// (attachment read hardening r3, basic leaf checks). A read refuses links,
// FIFOs, devices, directories and hard-linked files before anything is
// opened, opens without following a link and without waiting for a writer,
// checks the opened handle is the very file that was looked at, reads at most
// a bounded size by handle, and checks again after the read. Every stage runs
// inside one small pool, so attachment I/O never holds more than two libuv
// threads and every stall answers within its deadline.
//
// Not claimed: containment above the leaf. The folder is found by path on
// every operation; this module makes no claim about who can rename the
// folders above it.
import { constants, statSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import * as fsp from "node:fs/promises";
import { basename, join, resolve } from "node:path";

/** No attachment read is larger than this; no 1.0.x writer stores more. */
export const ATTACHMENT_READ_CEILING = 25 * 1024 * 1024;
export const ATTACHMENT_IO_SLOTS = 2;
export const ATTACHMENT_IO_QUEUE = 64;
export const ATTACHMENT_IO_DEADLINE_MS = 10_000;

declare const homeKey: unique symbol;
/** The attachment folder as an opaque value: there is no export that turns it
 * back into a path string for code outside the writer (attachments.ts). */
export type AttachmentsHome = { readonly [homeKey]: true };
const homes = new WeakMap<AttachmentsHome, string>();
const homesByDir = new Map<string, AttachmentsHome>();

export function attachmentsHomeOf(dataDir: string): AttachmentsHome {
  const folder = resolve(dataDir, "attachments");
  let home = homesByDir.get(folder);
  if (!home) {
    home = Object.freeze({}) as AttachmentsHome;
    homes.set(home, folder);
    homesByDir.set(folder, home);
  }
  return home;
}

function folderOf(home: AttachmentsHome): string {
  const folder = homes.get(home);
  if (!folder) throw new Error("not an attachments home");
  return folder;
}

/** The folder path, for the writer only. The gate test fails any caller
 * outside server/attachments.ts. */
export function attachmentsFolderForWriter(home: AttachmentsHome): string {
  return folderOf(home);
}

export type FileIdentity = { dev: bigint; ino: bigint; nlink: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };
export type Refusal = "missing" | "not-regular" | "too-large" | "changed" | "io" | "busy";
export type ReadResult = { ok: true; bytes: Buffer; id: FileIdentity } | { ok: false; reason: Refusal; code?: string };
export type ProbeResult = { ok: true; id: FileIdentity } | { ok: false; reason: Refusal; code?: string };

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const NAME = /^[A-Za-z0-9_-]{1,160}\.[A-Za-z0-9]{1,8}$/;

/** A bare attachment name: no separators, no leading dot, no Windows device
 * name. Checked with no filesystem call. */
export function isAttachmentName(name: string): boolean {
  if (!NAME.test(name)) return false;
  return !RESERVED.test(name.slice(0, name.indexOf(".")));
}

/** The name of a stored attachment path, when the path is exactly a bare
 * name directly inside the folder. No filesystem call. */
export function attachmentNameOf(home: AttachmentsHome, storedPath: string): string | null {
  const name = basename(storedPath);
  if (!isAttachmentName(name)) return null;
  return resolve(storedPath) === join(folderOf(home), name) ? name : null;
}

/** The stored path string for a name (rows, the renderer and engines keep
 * paths as today). */
export function storedPathOf(home: AttachmentsHome, name: string): string {
  return join(folderOf(home), name);
}

/** The folder, inside the attachments folder, that holds one empty marker
 * file per removed name (1.0.4 SL-H). A dotted name, so it is never an
 * attachment name itself. */
export const REMOVED_FOLDER = ".removed";

/** Was this name removed from storage (SL-H H2)? One stat of its marker,
 * asked at the moment of use and never cached. The name is checked first,
 * with no filesystem call: anything that is not a bare attachment name has no
 * marker. Fail closed: only "no such file" means not removed; a disk that
 * cannot answer counts as removed, so a removed file is never served or sent
 * on a stat error. */
export function attachmentRemoved(home: AttachmentsHome, name: string): boolean {
  if (!isAttachmentName(name)) return false;
  try {
    statSync(join(folderOf(home), REMOVED_FOLDER, name));
    return true;
  } catch (error) {
    const code = errno(error);
    return !(code === "ENOENT" || code === "ENOTDIR");
  }
}

// ---------------------------------------------------------------------------
// Test seams

export interface AttachmentFs {
  lstat(path: string): Promise<BigIntStats>;
  open(path: string, flags: number): Promise<AttachmentHandle>;
}
export interface AttachmentHandle {
  stat(): Promise<BigIntStats>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
const realFs: AttachmentFs = {
  lstat: path => fsp.lstat(path, { bigint: true }),
  open: async (path, flags) => {
    const handle = await fsp.open(path, flags);
    return {
      stat: () => handle.stat({ bigint: true }),
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: () => handle.close(),
    };
  },
};
let fs: AttachmentFs = realFs;
export type ReadHookStage = "before-open" | "after-read";
let readHook: ((stage: ReadHookStage, name: string) => void | Promise<void>) | undefined;

export function __setAttachmentFsForTests(fake: AttachmentFs | undefined): void { fs = fake ?? realFs; }
export function __setAttachmentReadHookForTests(hook: typeof readHook): void { readHook = hook; }

// ---------------------------------------------------------------------------
// The pool

interface Slot { readonly expired: () => boolean }
interface Waiter { start: () => void; timer: ReturnType<typeof setTimeout> }
let active = 0;
let stuck = 0;
const queue: Waiter[] = [];
let lastWarn = -Infinity;

const timeoutResult = { ok: false as const, reason: "io" as const, code: "timeout" };
const busyResult = { ok: false as const, reason: "busy" as const };

function warnStuck(): void {
  if (stuck < ATTACHMENT_IO_SLOTS) return;
  const now = Date.now();
  if (now - lastWarn < 60_000) return;
  lastWarn = now;
  console.warn(`[attachments] all ${ATTACHMENT_IO_SLOTS} attachment read slots are held past their deadline; attachment reads answer "busy" until the filesystem responds`);
}

function next(): void {
  while (active < ATTACHMENT_IO_SLOTS && queue.length) queue.shift()!.start();
}

/** Run one whole operation in one slot. The deadline starts now, at enqueue.
 * A waiter not started by its deadline answers busy; a started operation not
 * finished by its deadline answers io/timeout while its slot stays held until
 * the operation (including its close) settles, so a stuck thread is never
 * counted free. The operation sees `expired()` and stops advancing. */
function inSlot<T extends { ok: boolean }>(operation: (slot: Slot) => Promise<T>): Promise<T | typeof busyResult | typeof timeoutResult> {
  const deadline = Date.now() + ATTACHMENT_IO_DEADLINE_MS;
  return new Promise(answer => {
    let settled = false;
    const reply = (value: T | typeof busyResult | typeof timeoutResult) => { if (!settled) { settled = true; answer(value); } };
    const run = () => {
      active++;
      let expired = false, late = false;
      const remaining = Math.max(0, deadline - Date.now());
      const timer = setTimeout(() => { expired = true; late = true; stuck++; warnStuck(); reply(timeoutResult); }, remaining);
      const done = () => {
        clearTimeout(timer);
        if (late) stuck--;
        active--;
        next();
      };
      let running: Promise<T>;
      try { running = operation({ expired: () => expired }); }
      catch { running = Promise.resolve({ ok: false, reason: "io" } as unknown as T); }
      running.then(value => { done(); reply(value); }, () => { done(); reply({ ok: false, reason: "io" } as unknown as T); });
    };
    if (active < ATTACHMENT_IO_SLOTS && queue.length === 0) { run(); return; }
    if (queue.length >= ATTACHMENT_IO_QUEUE) { reply(busyResult); return; }
    const waiter: Waiter = {
      start: () => { clearTimeout(waiter.timer); run(); },
      timer: setTimeout(() => {
        const at = queue.indexOf(waiter);
        if (at >= 0) queue.splice(at, 1);
        reply(busyResult);
      }, Math.max(0, deadline - Date.now())),
    };
    queue.push(waiter);
  });
}

/** Test seam: forget when the stuck-slot warning last fired. */
export function __resetAttachmentPoolForTests(): void { lastWarn = -Infinity; }

/** Test seam: slots held, waiters queued, slots held past their deadline. */
export function attachmentPoolState(): { active: number; queued: number; stuck: number } {
  return { active, queued: queue.length, stuck };
}

// ---------------------------------------------------------------------------
// Leaf checks

const errno = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function identityOf(stat: BigIntStats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

export function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

type Stage<T> = { ok: true; value: T } | { ok: false; reason: Refusal; code?: string };

/** Steps 1 and 2: the folder is a real directory, the entry a plain,
 * single-link file no larger than `maxBytes`. Nothing is opened. */
async function look(folder: string, name: string, maxBytes: number, slot: Slot): Promise<Stage<FileIdentity>> {
  let parent: BigIntStats;
  try { parent = await fs.lstat(folder); }
  catch (error) { return { ok: false, reason: errno(error) === "ENOENT" ? "missing" : "io", code: errno(error) }; }
  if (slot.expired()) return timeoutResult;
  if (!parent.isDirectory() || parent.isSymbolicLink()) return { ok: false, reason: "not-regular", ...(parent.isSymbolicLink() ? { code: "link" } : {}) };
  let entry: BigIntStats;
  try { entry = await fs.lstat(join(folder, name)); }
  catch (error) {
    const code = errno(error);
    return { ok: false, reason: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "io", code };
  }
  if (slot.expired()) return timeoutResult;
  if (entry.isSymbolicLink()) return { ok: false, reason: "not-regular", code: "link" };
  if (!entry.isFile() || entry.nlink !== 1n) return { ok: false, reason: "not-regular" };
  if (entry.size > BigInt(maxBytes)) return { ok: false, reason: "too-large" };
  return { ok: true, value: identityOf(entry) };
}

function boundedMax(maxBytes: number): number {
  return Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? Math.min(maxBytes, ATTACHMENT_READ_CEILING) : 0;
}

/** Steps 1 and 2 only. */
export async function probeAttachment(home: AttachmentsHome, name: string, maxBytes: number): Promise<ProbeResult> {
  if (!isAttachmentName(name)) return { ok: false, reason: "not-regular" };
  const folder = folderOf(home), max = boundedMax(maxBytes);
  const result = await inSlot(async slot => {
    const seen = await look(folder, name, max, slot);
    return seen.ok ? { ok: true as const, id: seen.value } : seen;
  });
  return result;
}

/** Steps 1 to 7: the whole file, read by handle, never past `maxBytes`. */
export async function readAttachmentFile(home: AttachmentsHome, name: string, maxBytes: number): Promise<ReadResult> {
  if (!isAttachmentName(name)) return { ok: false, reason: "not-regular" };
  const folder = folderOf(home), max = boundedMax(maxBytes), path = join(folder, name);
  return inSlot<ReadResult>(async slot => {
    const seen = await look(folder, name, max, slot);
    if (!seen.ok) return seen;
    const before = seen.value;
    await readHook?.("before-open", name);
    if (slot.expired()) return timeoutResult;
    let handle: AttachmentHandle;
    try { handle = await fs.open(path, OPEN_FLAGS); }
    catch (error) {
      const code = errno(error);
      return { ok: false, reason: code === "ELOOP" || code === "EMLINK" || code === "ENXIO" || code === "EISDIR" ? "not-regular" : code === "ENOENT" ? "missing" : "io", code };
    }
    // A late open (it settled after the deadline) is closed here too.
    try {
      if (slot.expired()) return timeoutResult;
      const opened = await handle.stat();
      if (slot.expired()) return timeoutResult;
      if (!opened.isFile() || opened.nlink !== 1n) return { ok: false, reason: "not-regular" };
      if (!sameIdentity(identityOf(opened), before)) return { ok: false, reason: "changed" };
      // size was bounded as a bigint before this conversion
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (slot.expired()) return timeoutResult;
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== bytes.length) return { ok: false, reason: "changed" };
      await readHook?.("after-read", name);
      if (slot.expired()) return timeoutResult;
      const after = await handle.stat();
      if (slot.expired()) return timeoutResult;
      let entry: BigIntStats;
      try { entry = await fs.lstat(path); }
      catch (error) {
        // gone or renamed away: changed; a disk that could not answer: io
        const code = errno(error);
        return code === "ENOENT" || code === "ENOTDIR" ? { ok: false, reason: "changed", code } : { ok: false, reason: "io", code };
      }
      if (slot.expired()) return timeoutResult;
      if (!sameIdentity(identityOf(after), before) || entry.isSymbolicLink() || !sameIdentity(identityOf(entry), before)) return { ok: false, reason: "changed" };
      return { ok: true, bytes, id: before };
    } catch (error) {
      return { ok: false, reason: "io", code: errno(error) };
    } finally {
      // close is part of the operation and keeps its slot until it settles
      await handle.close().catch(() => undefined);
    }
  });
}
