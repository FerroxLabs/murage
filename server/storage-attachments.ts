// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/storage/attachments (1.0.3, ATTACHMENT-STORE-DESIGN r7, list only):
// the Storage page's list of the files Murage keeps as attachments, with their
// size, date, kind and where each is used.
//
// Read only, and it reads no file bytes: the walk opens the folder and lstats
// each entry, nothing else (R1.2, R1.9). Nothing here decides anything; no
// upload, read or delete path calls it (Remove, 1.0.4, only drops the
// snapshot afterwards). It imports nothing from attachments.ts
// (R0): the folder is handed in.
import { randomBytes } from "node:crypto";
import { promises as fsp, type BigIntStats } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { REMOVED_FOLDER } from "./attachment-read.ts";

/** A stored attachment's name: what uploads write (R1.2). */
export const MANAGED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,5}$/;
export const WALK_MAX_ENTRIES = 100_000;
export const WALK_BATCH = 256;
export const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
export const PAGE_LIMIT_MAX = 100;
export const PAGE_LIMIT_DEFAULT = 50;
/** List-mode caps (R1.6.5). */
export const ITEM_POINTER_READS = 64;
export const ITEM_CONVERSATIONS = 20;
export const PAGE_POINTER_READS = 3000;
const POINTER_BATCH = 32;

export type FileKind = "image" | "document" | "audio" | "video" | "other";
const KINDS: Record<string, FileKind> = {};
for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "svg", "avif", "tif", "tiff"]) KINDS[ext] = "image";
for (const ext of ["mp3", "wav", "m4a", "aac", "ogg", "oga", "opus", "flac", "weba", "aiff"]) KINDS[ext] = "audio";
for (const ext of ["mp4", "mov", "webm", "m4v", "mkv", "avi", "ogv"]) KINDS[ext] = "video";
for (const ext of ["pdf", "txt", "md", "rtf", "doc", "docx", "odt", "xls", "xlsx", "ods", "csv", "tsv", "ppt", "pptx", "odp", "json", "html", "htm", "xml", "yaml", "yml", "epub", "pages", "numbers", "key"]) KINDS[ext] = "document";

/** A row's kind icon, from the name's extension alone (R1.9: no bytes are read to decide it). */
export function kindOf(name: string): FileKind {
  const dot = name.lastIndexOf(".");
  return (dot >= 0 && KINDS[name.slice(dot + 1).toLowerCase()]) || "other";
}

/** The only two filesystem calls the walk makes (L3). */
export interface WalkFs {
  opendir(path: string): Promise<{ read(): Promise<{ name: string } | null>; close(): Promise<void> }>;
  lstat(path: string): Promise<Pick<BigIntStats, "isFile" | "isSymbolicLink" | "size" | "mtimeMs">>;
}
export const realWalkFs: WalkFs = {
  opendir: (path) => fsp.opendir(path, { bufferSize: WALK_BATCH }),
  // bigint, so sizes and times are exact (R1.2)
  lstat: (path) => fsp.lstat(path, { bigint: true }),
};

interface Managed { name: string; bytes: number; modifiedAt: number }
interface Snapshot {
  id: string;
  createdAt: number;
  items: Managed[];
  sorted: Partial<Record<Order, Managed[]>>;
  totals: Totals;
}
export interface Totals {
  count: number;
  bytes: number;
  other: { count: number; bytes: number; unreadable: number; firstError?: string };
  vanished: number;
  truncated: boolean;
}
export type Order = "size" | "newest";

type WalkResult = { ok: true; items: Managed[]; totals: Totals } | { ok: false };

/** R1.2 and R1.3: the inventory walk. */
export async function walkAttachments(dir: string, fs: WalkFs = realWalkFs): Promise<WalkResult> {
  let handle: Awaited<ReturnType<WalkFs["opendir"]>>;
  const totals: Totals = { count: 0, bytes: 0, other: { count: 0, bytes: 0, unreadable: 0 }, vanished: 0, truncated: false };
  try {
    handle = await fs.opendir(dir);
  } catch (error) {
    // A fresh data directory has no folder yet: an empty store, not a failure.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: true, items: [], totals };
    return { ok: false };
  }
  const items: Managed[] = [];
  let examined = 0;
  try {
    for (;;) {
      const batch: string[] = [];
      while (batch.length < WALK_BATCH && examined + batch.length < WALK_MAX_ENTRIES) {
        const entry = await handle.read();
        if (!entry) break;
        batch.push(entry.name);
      }
      if (batch.length === 0) {
        if (examined >= WALK_MAX_ENTRIES && (await handle.read())) totals.truncated = true;
        break;
      }
      examined += batch.length;
      const stats = await Promise.all(batch.map(name => fs.lstat(join(dir, name)).then(
        stat => ({ name, stat }),
        (error: NodeJS.ErrnoException) => ({ name, error: error?.code ?? "EIO" }))));
      for (const entry of stats) {
        // Remove's markers (1.0.4 SL-H) are not a file Murage keeps
        if (entry.name === REMOVED_FOLDER) continue;
        if ("error" in entry) {
          if (entry.error === "ENOENT") totals.vanished++;
          else { totals.other.unreadable++; totals.other.firstError ??= entry.error; }
          continue;
        }
        const bytes = Number(entry.stat.size);
        if (entry.stat.isFile() && !entry.stat.isSymbolicLink() && MANAGED_NAME.test(entry.name)) {
          items.push({ name: entry.name, bytes, modifiedAt: Math.floor(Number(entry.stat.mtimeMs)) });
          totals.count++;
          totals.bytes += bytes;
        } else {
          totals.other.count++;
          totals.other.bytes += bytes;
        }
      }
      // yield between batches so a large folder never holds the event loop
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  } catch {
    return { ok: false };
  } finally {
    await handle.close().catch(() => {});
  }
  return { ok: true, items, totals };
}

export type UsedIn = { state: "used"; labels: string[]; more: boolean } | { state: "unused" } | { state: "unknown" };

export interface UseDeps {
  database: () => DatabaseSync;
  /** Bots in memory, for "Picture of <bot>". */
  bots: () => ReadonlyArray<{ name: string; avatarUrl?: string | null }>;
  /** The sidebar's name for a conversation, when the store has one. */
  threadLabel: (threadId: string) => string | undefined;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); } catch { return false; }
}

/** R1.7: may any item be `unused`? Only when the attachment-name index has reached every row. */
export function coverageComplete(db: DatabaseSync): boolean {
  if (!hasTable(db, "attachment_name") || !hasTable(db, "transcript_index_state")) return false;
  try {
    const state = db.prepare("SELECT done FROM transcript_index_state WHERE name = 'attachment_name'").get() as { done: number } | undefined;
    return Boolean(state?.done);
  } catch { return false; }
}

/** R1.6 in list mode: where one file is used, bounded by the item caps and what is left of the page budget. */
export function lookupUse(name: string, deps: UseDeps, page: { budget: number; complete: boolean; tableExists: boolean }): UsedIn {
  const avatars = deps.bots().filter(bot => bot.avatarUrl === `/api/attachments/${name}`).map(bot => `Picture of ${bot.name}`);
  const confirmed: string[] = [];
  let exhausted = false;
  let failed = false;
  if (page.tableExists) {
    try {
      const db = deps.database();
      const first = db.prepare("SELECT thread_id, id FROM attachment_name WHERE name = ? ORDER BY thread_id, id LIMIT ?");
      const after = db.prepare("SELECT thread_id, id FROM attachment_name WHERE name = ? AND (thread_id, id) > (?, ?) ORDER BY thread_id, id LIMIT ?");
      const pastThread = db.prepare("SELECT thread_id, id FROM attachment_name WHERE name = ? AND thread_id > ? ORDER BY thread_id, id LIMIT ?");
      const confirm = db.prepare("SELECT 1 FROM messages WHERE thread_id = ? AND id = ? AND instr(lower(json), ?) > 0 LIMIT 1");
      let reads = 0;
      let last: { thread: string; id: string } | null = null;
      let lastConfirmed: string | null = null;
      while (reads < ITEM_POINTER_READS && confirmed.length < ITEM_CONVERSATIONS && page.budget > 0) {
        const limit = Math.min(POINTER_BATCH, ITEM_POINTER_READS - reads, page.budget);
        const rows = (!last ? first.all(name, limit)
          // skip the rest of a confirmed conversation (R1.6.4)
          : lastConfirmed === last.thread ? pastThread.all(name, last.thread, limit)
          : after.all(name, last.thread, last.id, limit)) as Array<{ thread_id: string; id: string }>;
        // every pointer row fetched counts against the caps, whether it is confirmed, skipped or stale
        reads += rows.length;
        page.budget -= rows.length;
        let stopped = false;
        for (const row of rows) {
          if (confirmed.length >= ITEM_CONVERSATIONS) { stopped = true; break; }
          last = { thread: row.thread_id, id: row.id };
          if (row.thread_id === lastConfirmed) continue;
          if (confirm.get(row.thread_id, row.id, name)) {
            confirmed.push(row.thread_id);
            lastConfirmed = row.thread_id;
          }
          // otherwise a stale pointer (the row no longer names the file) is dropped
        }
        if (!stopped && rows.length < limit) { exhausted = true; break; }
      }
    } catch {
      failed = true;
    }
  }
  // a failed SQL read is that item's unknown (R1.8), even when something was found first
  if (failed) return { state: "unknown" };
  if (confirmed.length > 0 || avatars.length > 0) {
    const labels = [...new Set([...avatars, ...confirmed.map(thread => deps.threadLabel(thread) ?? "Conversation")])];
    return { state: "used", labels, more: !exhausted };
  }
  if (exhausted && page.complete) return { state: "unused" };
  return { state: "unknown" };
}

export type ListAnswer =
  | { status: 200; body: ListPage | { state: "unreadable"; message: string } }
  | { status: 400 | 409; body: { error: string } };

export interface ListItem { name: string; bytes: number; modifiedAt: number; kind: FileKind; usedIn: UsedIn }
export interface ListPage {
  state: "ok";
  snapshot: string;
  order: Order;
  items: ListItem[];
  nextCursor: string | null;
  totals: Totals;
  /** false while the attachment-name index is still filling: no item can be `unused` (R1.7). */
  coverageComplete: boolean;
}

export const STALE_SNAPSHOT_MESSAGE = "The list changed; reload it.";
export const UNREADABLE_FOLDER_MESSAGE = "Murage could not read its attachments folder.";

export interface ListQuery { order?: string | null; snapshot?: string | null; cursor?: string | null; limit?: string | null }

/** The route's state: at most one snapshot, one walk at a time (R1.3). */
export class AttachmentList {
  private snapshot: Snapshot | null = null;
  private walking: Promise<Snapshot | null> | null = null;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  /** For tests: whether a snapshot is held in memory. */
  get holdsSnapshot(): boolean { return this.snapshot !== null; }
  private readonly options: UseDeps & { dir: string; fs?: WalkFs; now?: () => number };
  constructor(options: UseDeps & { dir: string; fs?: WalkFs; now?: () => number }) { this.options = options; }

  private now() { return (this.options.now ?? Date.now)(); }

  /** Drop the snapshot after a Remove: its later pages would still list the
   * removed files, so a page asked of it answers "The list changed". */
  forget(): void { this.snapshot = null; }

  private walk(): Promise<Snapshot | null> {
    // a request during a walk awaits it
    if (this.walking) return this.walking;
    this.snapshot = null; // a new walk drops the old snapshot
    this.walking = walkAttachments(this.options.dir, this.options.fs).then(result => {
      if (!result.ok) return null;
      const snapshot: Snapshot = { id: randomBytes(12).toString("hex"), createdAt: this.now(), items: result.items, sorted: {}, totals: result.totals };
      this.snapshot = snapshot;
      // dropped after five minutes even when nobody asks again (R1.3)
      clearTimeout(this.expiry);
      this.expiry = setTimeout(() => { if (this.snapshot === snapshot) this.snapshot = null; }, SNAPSHOT_TTL_MS);
      this.expiry.unref?.();
      return snapshot;
    }).finally(() => { this.walking = null; });
    return this.walking;
  }

  async list(query: ListQuery): Promise<ListAnswer> {
    const order = (query.order ?? "size") as Order;
    if (order !== "size" && order !== "newest") return { status: 400, body: { error: "order is size or newest" } };
    const limit = query.limit == null || query.limit === "" ? PAGE_LIMIT_DEFAULT : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) return { status: 400, body: { error: `limit is 1 to ${PAGE_LIMIT_MAX}` } };
    const start = query.cursor == null || query.cursor === "" ? 0 : Number(query.cursor);
    if (!Number.isInteger(start) || start < 0) return { status: 400, body: { error: "bad cursor" } };
    let snap: Snapshot | null;
    if (query.snapshot) {
      snap = this.snapshot;
      if (snap && this.now() - snap.createdAt > SNAPSHOT_TTL_MS) { this.snapshot = null; snap = null; }
      if (this.walking || !snap || snap.id !== query.snapshot) return { status: 409, body: { error: STALE_SNAPSHOT_MESSAGE } };
    } else {
      snap = await this.walk();
      if (!snap) return { status: 200, body: { state: "unreadable", message: UNREADABLE_FOLDER_MESSAGE } };
    }
    if (start > snap.items.length) return { status: 400, body: { error: "bad cursor" } };
    const sorted = snap.sorted[order] ??= [...snap.items].sort(order === "size"
      ? (a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : 1)
      : (a, b) => b.modifiedAt - a.modifiedAt || (a.name < b.name ? -1 : 1));
    const slice = sorted.slice(start, start + limit);
    let complete = false;
    let tableExists = false;
    try {
      const db = this.options.database();
      complete = coverageComplete(db);
      tableExists = hasTable(db, "attachment_name") && hasTable(db, "messages");
    } catch { /* every item is unknown */ }
    const page = { budget: PAGE_POINTER_READS, complete, tableExists };
    const items = slice.map(item => ({ ...item, kind: kindOf(item.name), usedIn: lookupUse(item.name, this.options, page) }));
    const next = start + slice.length;
    return { status: 200, body: { state: "ok", snapshot: snap.id, order, items, nextCursor: next < sorted.length ? String(next) : null, totals: snap.totals, coverageComplete: complete } };
  }
}
