// Unsent composer input, kept per conversation (U36, design
// U36-DRAFT-SEND-STATE-106). Each draft is ONE localStorage key,
// `murage-draft:<draftId>`, holding its words, attachments, mode, reply
// target, the send id that owns those words (`pin`) and the journal of the
// send in flight (`out`). Every state change is one setItem under one Web Lock
// on a fresh read, so a crash lands before or after a change, never inside it,
// and every tab sees the same state (a `storage` event carries it across).
// While `out` is set the draft is read-only in every tab and across reloads;
// the words never leave the box on a failure, so nothing is ever restored.
import { useCallback, useEffect, useState, useSyncExternalStore, type SetStateAction } from "react";
import { isAttachment, type Attachment } from "./composer-attachments.js";
import { newSendId } from "./send-id.js";

// Legacy (1.0.4) keys: read once by the migration, then trimmed. A record always wins over them.
const KEY = "murage-drafts";
const ATTACHMENTS_KEY = "murage-draft-attachments";
const SEND_IDS_KEY = "murage-draft-send-ids";
const CHANNEL_MODES_KEY = "murage-draft-channel-modes";
const OUTBOX_KEY = "murage-send-outbox";
const FAILED_SENDS_KEY = "murage-draft-failed-sends";
/** One record per draft. */
export const DRAFT_RECORD_PREFIX = "murage-draft:";
const LOCK_NAME = "murage-drafts";
/** A lookup of a pinned send id gives up after this long; the press is refused, never guessed. */
export const DRAFT_LOOKUP_TIMEOUT_MS = 5_000;
/** A settle write the storage refused is tried again after this long (and on the next storage/online event). */
export const DRAFT_SETTLE_RETRY_MS = 30_000;
/** A conversation's failed list is for retrying by hand, not an archive. */
const MAX_FAILED_SENDS_PER_DRAFT = 20;

type ChannelMode = "chat" | "goal";
export type DraftOutcome = "acked" | "refused" | "failed" | "cancelled";
/** An outbox entry (send-delivery.ts OutboxEntry) as the record keeps it: the draft is the record itself. Declared
 * here, structurally, so this module stays free of the store's path aliases (the server tests import it). */
export interface DraftOutboxEntry {
  sendId: string;
  kind: "bot" | "group";
  botId?: string;
  groupId?: string;
  threadId: string;
  text: string;
  replyToId?: string;
  mode?: "chat" | "goal";
  responderId?: string;
  resend?: true;
  restoreGen?: string;
  stopGen?: string;
  actionId?: string;
  /** A 1.0.4 entry delivery took over undrafted (C1): the draft it came from and its snapshot's fingerprint. */
  legacyDraft?: LegacyDraftOwner;
  at: number;
  attempts: number;
}
/** The draft a 1.0.4 outbox entry was sent from: kept on the entry when delivery strips its `draft`, so its ack or
 * refusal still clears those words (or the record that migrated them) and a later migration still takes its pin. */
export interface LegacyDraftOwner { draftId: string; fp: string; replyToId?: string }
/** What the send delivery lists for a record's send in flight. */
export interface DraftJournalEntry extends DraftOutboxEntry {
  draft?: { draftId: string; attemptId: string; text: string; requestText: string; attachments: Attachment[]; channelMode?: ChannelMode; replyToId?: string };
}
/** The content C of a draft. */
export interface DraftContent { text: string; att: Attachment[]; mode: ChannelMode; reply?: string }
export interface DraftRecord extends DraftContent {
  v: 3;
  /** Send cycle: +1 at every Send; an edit made against an older n is dropped. */
  n: number;
  /** The send id that owns exactly this content; fp "legacy" means the owner is unproven. */
  pin?: { s: string; fp: string; at: number };
  /** The send in flight. `entry` is the one copy of sendId, at and attempts. */
  out?: { a: string; fp: string; entry: DraftOutboxEntry };
  /** Attachments that arrived while `out` was set: they join the next draft. */
  later?: Attachment[];
  /** The last settle, for tabs holding hooks. */
  last?: { s: string; a?: string; o: DraftOutcome };
}

type Store = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem" | "key" | "length">> | undefined;
type Values = Record<string, unknown>;

// ---------------------------------------------------------------- storage

// Reaching for localStorage is itself a failure point: on an origin with
// storage blocked the getter throws, and `typeof` doesn't shield it.
function getStore(): Store {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** No storage at all: records live in this module map. A reload loses everything, the words included, so it cannot duplicate. */
const memoryValues = new Map<string, string>();
const memoryStore: NonNullable<Store> = {
  getItem: (key) => memoryValues.get(key) ?? null,
  setItem: (key, value) => { memoryValues.set(key, value); },
  removeItem: (key) => { memoryValues.delete(key); },
  key: (index) => [...memoryValues.keys()][index] ?? null,
  get length() { return memoryValues.size; },
};
const recordStore = (): NonNullable<Store> => getStore() ?? memoryStore;

// Storage is best-effort for reads: a garbled value reads as "nothing there".
function read(store: Store, key: string): Values {
  try {
    const raw = store?.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Values) : {};
  } catch {
    return {};
  }
}

function storeKeys(store: Store): string[] {
  const keys: string[] = [];
  try {
    const length = typeof store?.length === "number" ? store.length : 0;
    for (let i = 0; i < length; i += 1) {
      const key = store?.key?.(i);
      if (typeof key === "string") keys.push(key);
    }
  } catch { /* unreadable storage lists nothing */ }
  return keys;
}

/** Every draft id that has a record. */
function recordIds(): string[] {
  return storeKeys(recordStore()).filter((key) => key.startsWith(DRAFT_RECORD_PREFIX)).map((key) => key.slice(DRAFT_RECORD_PREFIX.length));
}

// ---------------------------------------------------------------- the record

const EMPTY: DraftContent = { text: "", att: [], mode: "chat" };

function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** fp(C): the fingerprint that ties a send id to exactly this content. */
export function draftFingerprint(content: DraftContent): string {
  return cyrb53(JSON.stringify([content.text, content.att.map((item) => item.id).sort(), content.mode, content.reply ?? null]));
}

const contentOf = (rec: DraftContent): DraftContent => ({ text: rec.text, att: rec.att, mode: rec.mode, ...(rec.reply ? { reply: rec.reply } : {}) });
const emptyRecord = (): DraftRecord => ({ v: 3, n: 0, ...EMPTY });

function isEntryShape(value: unknown): value is DraftOutboxEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return typeof e.sendId === "string" && (e.kind === "bot" || e.kind === "group") && typeof e.threadId === "string"
    && typeof e.text === "string" && typeof e.at === "number" && typeof e.attempts === "number";
}

function parseRecord(raw: string | null): DraftRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, any>;
    if (!value || typeof value !== "object" || value.v !== 3 || typeof value.n !== "number" || typeof value.text !== "string") return null;
    const rec: DraftRecord = {
      v: 3,
      n: value.n,
      text: value.text,
      att: Array.isArray(value.att) ? value.att.filter(isAttachment) : [],
      mode: value.mode === "goal" ? "goal" : "chat",
      ...(typeof value.reply === "string" ? { reply: value.reply } : {}),
    };
    if (value.pin && typeof value.pin.s === "string" && typeof value.pin.fp === "string") rec.pin = { s: value.pin.s, fp: value.pin.fp, at: Number(value.pin.at) || 0 };
    if (value.out && typeof value.out.a === "string" && typeof value.out.fp === "string" && isEntryShape(value.out.entry)) rec.out = { a: value.out.a, fp: value.out.fp, entry: value.out.entry };
    if (Array.isArray(value.later)) { const later = value.later.filter(isAttachment); if (later.length) rec.later = later; }
    if (value.last && typeof value.last.s === "string" && ["acked", "refused", "failed", "cancelled"].includes(value.last.o)) {
      rec.last = { s: value.last.s, o: value.last.o, ...(typeof value.last.a === "string" ? { a: value.last.a } : {}) };
    }
    return rec;
  } catch {
    return null;
  }
}

/** Drafts this tab has seen a stored record for: a later removal of that key by another tab is a deletion (A2). */
const knownStored = new Set<string>();

function readStoredRecord(id: string): DraftRecord | null {
  let rec: DraftRecord | null;
  try { rec = parseRecord(recordStore().getItem(DRAFT_RECORD_PREFIX + id)); } catch { rec = null; }
  if (rec) knownStored.add(id);
  return rec;
}

// ---------------------------------------------------------------- legacy migration (section 6)

interface LegacyOutboxEntry extends Omit<DraftOutboxEntry, "legacyDraft"> {
  draft?: { draftId?: unknown; text?: unknown; attachments?: unknown; channelMode?: unknown; replyToId?: unknown };
  legacyDraft?: unknown;
}

function legacyOutbox(): LegacyOutboxEntry[] {
  try {
    const parsed = JSON.parse(getStore()?.getItem(OUTBOX_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isEntryShape) as LegacyOutboxEntry[] : [];
  } catch {
    return [];
  }
}

const stripDraft = (entry: LegacyOutboxEntry): DraftOutboxEntry => { const { draft: _draft, legacyDraft: _owner, ...rest } = entry; return rest; };
const legacySnapshotFp = (entry: LegacyOutboxEntry): string => {
  const draft = entry.draft ?? {};
  return draftFingerprint({
    text: typeof draft.text === "string" ? draft.text : "",
    att: Array.isArray(draft.attachments) ? draft.attachments.filter(isAttachment) : [],
    mode: draft.channelMode === "goal" ? "goal" : "chat",
    ...(typeof draft.replyToId === "string" ? { reply: draft.replyToId } : {}),
  });
};

/** The attempt id a migrated 1.0.4 send in flight carries (its entry was posted by 1.0.4, before attempt ids). */
const LEGACY_ATTEMPT = "legacy";

/** The draft a 1.0.4 entry belongs to: from its `draft` snapshot, or from the `legacyDraft` delivery kept when it took
 * the entry over undrafted (C1). Undefined for an entry that never carried a draft. */
function legacyOwnerOf(entry: LegacyOutboxEntry): LegacyDraftOwner | undefined {
  if (typeof entry.draft?.draftId === "string") {
    const reply = typeof entry.draft.replyToId === "string" ? entry.draft.replyToId : undefined;
    return { draftId: entry.draft.draftId, fp: legacySnapshotFp(entry), ...(reply ? { replyToId: reply } : {}) };
  }
  const kept = entry.legacyDraft as Record<string, unknown> | null | undefined;
  if (!kept || typeof kept !== "object" || typeof kept.draftId !== "string" || typeof kept.fp !== "string") return undefined;
  return { draftId: kept.draftId, fp: kept.fp, ...(typeof kept.replyToId === "string" ? { replyToId: kept.replyToId } : {}) };
}

/** What a 1.0.4 draft becomes, computed from the legacy keys alone (no write). Ownership is taken only where an
 * outbox snapshot whose words match the box proves it; anything else is a stale "legacy" pin that never clears. */
function legacyRecord(id: string): DraftRecord | null {
  const store = getStore();
  if (!store) return null;
  const text = read(store, KEY)[id];
  const rawAtt = read(store, ATTACHMENTS_KEY)[id];
  const rec: DraftRecord = {
    ...emptyRecord(),
    text: typeof text === "string" ? text : "",
    att: Array.isArray(rawAtt) ? rawAtt.filter(isAttachment) : [],
    mode: read(store, CHANNEL_MODES_KEY)[id] === "goal" ? "goal" : "chat",
  };
  // An entry delivery already took over undrafted (its `legacyDraft`) is matched the same way (C1): its words still get its pin.
  let matched: { entry: LegacyOutboxEntry; owner: LegacyDraftOwner } | undefined;
  let unmatched: LegacyOutboxEntry | undefined;
  for (const entry of legacyOutbox()) {
    const owner = legacyOwnerOf(entry);
    if (owner?.draftId !== id) continue;
    const box = draftFingerprint({ ...contentOf(rec), ...(owner.replyToId ? { reply: owner.replyToId } : {}) });
    if (box === owner.fp) matched = { entry, owner };
    else unmatched = entry;
  }
  if (matched) {
    if (matched.owner.replyToId) rec.reply = matched.owner.replyToId;
    const fp = draftFingerprint(contentOf(rec));
    rec.pin = { s: matched.entry.sendId, fp, at: matched.entry.at };
    rec.out = { a: LEGACY_ATTEMPT, fp, entry: stripDraft(matched.entry) };
  } else if (rec.text || rec.att.length) {
    // An empty box takes no legacy pin (B3): there are no words a later Send could duplicate.
    if (unmatched) {
      // The person edited after Send in 1.0.4: the entry delivers once, undrafted; its id only blocks a duplicate.
      rec.pin = { s: unmatched.sendId, fp: "legacy", at: unmatched.at };
    } else {
      const legacyPin = read(store, SEND_IDS_KEY)[id];
      if (typeof legacyPin === "string") rec.pin = { s: legacyPin, fp: "legacy", at: 0 };
    }
  }
  if (!rec.text && !rec.att.length && rec.mode === "chat" && !rec.pin) return null;
  return rec;
}

function legacyDraftIds(): string[] {
  const store = getStore();
  const ids = new Set<string>();
  for (const key of [KEY, ATTACHMENTS_KEY, CHANNEL_MODES_KEY, SEND_IDS_KEY]) for (const id of Object.keys(read(store, key))) ids.add(id);
  for (const entry of legacyOutbox()) { const owner = legacyOwnerOf(entry); if (owner) ids.add(owner.draftId); }
  return [...ids];
}

/** Best-effort: the legacy keys for a migrated draft go; a record always wins over them anyway. */
function trimLegacy(id: string, rec: DraftRecord | null): void {
  const store = getStore();
  if (!store) return;
  for (const key of [KEY, ATTACHMENTS_KEY, CHANNEL_MODES_KEY, SEND_IDS_KEY]) {
    const values = read(store, key);
    if (!(id in values)) continue;
    delete values[id];
    try {
      if (!Object.keys(values).length && store.removeItem) store.removeItem(key);
      else store.setItem(key, JSON.stringify(values));
    } catch { /* best-effort */ }
  }
  const outbox = legacyOutbox();
  const mine = (entry: LegacyOutboxEntry) => legacyOwnerOf(entry)?.draftId === id;
  if (!outbox.some(mine)) return;
  const next = outbox
    .filter((entry) => !(mine(entry) && rec?.out?.entry.sendId === entry.sendId))
    .map((entry) => (mine(entry) ? stripDraft(entry) : entry));
  try { store.setItem(OUTBOX_KEY, JSON.stringify(next)); } catch { /* best-effort */ }
}

/** The record as a reader sees it, without writing: the stored record, else the legacy view, else empty. */
function viewRecord(id: string): DraftRecord {
  return readStoredRecord(id) ?? legacyRecord(id) ?? emptyRecord();
}

/** A 1.0.4 draft whose migration write the storage refused (A5): retried on the next storage, online or load event. */
let migrationPending = false;

/** Under the lock: the stored record; a draft with none is migrated (one write, then the legacy keys trimmed).
 * Null when that migration write failed, or when the record was deleted in another tab (C2): nothing may act on a
 * record that is not on disk (A5). Its legacy outbox
 * entry stays with the send delivery (classify reads the stored record only), so it is never left with no owner. */
function lockedRecord(id: string): DraftRecord | null {
  const stored = readStoredRecord(id);
  if (stored) return stored;
  // A record this tab knew is missing, and this tab did not forget it: another tab deleted it, and its storage event has
  // not arrived yet (C2). It is gone here now; nothing is written for it (an empty n=0 record would bring it back).
  // Only a key that reads back as absent is a deletion: a read that throws acts on nothing and drops nothing.
  if (knownStored.has(id) && !forgottenDrafts.has(id)) {
    let raw: string | null;
    try { raw = recordStore().getItem(DRAFT_RECORD_PREFIX + id); } catch { return null; }
    if (raw === null) { goneRemotely(id); return null; }
  }
  const migrated = legacyRecord(id);
  if (!migrated) return emptyRecord();
  if (!writeRecord(id, migrated)) { migrationPending = true; return null; }
  trimLegacy(id, migrated);
  return migrated;
}

const forgottenDrafts = new Set<string>();
/** Drafts another tab deleted (their record key was removed under this tab, A2). Nothing is written for one again
 * unless the store still lists its conversation (`setDraftOwnerCheck`): a removal is never undone by a stale tab. */
const remoteGone = new Set<string>();
type OwnerCheck = (draftId: string) => boolean;
let ownerCheck: OwnerCheck | null = null;

/** The store supplies "is this draft's conversation still live". */
export function setDraftOwnerCheck(check: OwnerCheck | null): void { ownerCheck = check; }

/** True when nothing may be written for this draft: deleted here, or deleted in another tab and not re-validated. */
function blocked(id: string): boolean {
  if (forgottenDrafts.has(id)) return true;
  if (!remoteGone.has(id)) return false;
  let live = false;
  try { live = ownerCheck?.(id) === true; } catch { live = false; }
  if (live) remoteGone.delete(id);
  return !live;
}

function writeRecord(id: string, rec: DraftRecord): boolean {
  if (blocked(id)) return false;
  try {
    recordStore().setItem(DRAFT_RECORD_PREFIX + id, JSON.stringify(rec));
    knownStored.add(id);
    return true;
  } catch {
    return false;
  }
}

/** Migrate every 1.0.4 draft to its record (load, before reconcile; again on storage or online after a refused write). */
export async function migrateLegacyDrafts(): Promise<void> {
  migrationPending = false;
  // Attachments left in `later` with no send out (a crash during a press, or a fold the storage refused) join the draft (C5).
  const orphans = recordIds().filter((id) => { const rec = readStoredRecord(id); return Boolean(rec && !rec.out && rec.later?.length); });
  await Promise.all(orphans.map((id) => foldLater(id)));
  const ids = legacyDraftIds();
  if (!ids.length) return;
  await withLock(() => {
    for (const id of ids) {
      if (forgottenDrafts.has(id)) continue;
      if (readStoredRecord(id)) trimLegacy(id, readStoredRecord(id));
      else lockedRecord(id);
    }
  });
  for (const id of ids) changed(id);
}

// ---------------------------------------------------------------- the lock

type LockManager = { request: <T>(name: string, callback: () => T | Promise<T>) => Promise<T> };
let fallbackChain: Promise<unknown> = Promise.resolve();
/** Without Web Locks a write is read back after this long before it counts (A1, section 4b). */
export const DRAFT_VERIFY_WINDOW_MS = 50;

function webLocks(): LockManager | undefined {
  let locks: LockManager | undefined;
  try { locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks; } catch { locks = undefined; }
  return locks && typeof locks.request === "function" ? locks : undefined;
}

/** One Web Lock serializes every read-modify-write of a record across tabs. It is the only thing the lock does.
 * Without one (an odd WebView) the fallback is a per-tab chain, and `confirmed` below closes the cross-tab race. */
function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const locks = webLocks();
  if (locks) return locks.request(LOCK_NAME, fn);
  const run = fallbackChain.then(fn, fn);
  fallbackChain = run.catch(() => undefined);
  return run;
}

/** Fail closed without Web Locks (A1): after a write, wait the verify window and read the record back; the write
 * counts only if it is still the stored value (another tab that read the same old record and wrote after us wins,
 * and this tab treats its own write as lost). With Web Locks, or with no storage at all, a write is final. */
async function confirmed(id: string, next: DraftRecord): Promise<boolean> {
  if (webLocks() || !getStore()) return true;
  await new Promise<void>((resolve) => { setTimeout(resolve, DRAFT_VERIFY_WINDOW_MS); });
  try { return recordStore().getItem(DRAFT_RECORD_PREFIX + id) === JSON.stringify(next); } catch { return false; }
}

// ---------------------------------------------------------------- live state, per tab

interface Pending { text?: string; mode?: ChannelMode; reply?: { value: string | undefined }; adds: Map<string, Attachment>; removes: Set<string> }
export interface DraftView extends DraftContent { held: boolean }
interface Live { rec: DraftRecord; pending: Pending | null; view: DraftView }

const live = new Map<string, Live>();
const listeners = new Map<string, Set<() => void>>();
const heldListeners = new Set<() => void>();

const samePath = (a: Attachment, b: Attachment) => a.kind !== "paste" && b.kind !== "paste" && a.kind === b.kind && a.path === b.path;

function applyOps(base: Attachment[], pending: Pending | null): Attachment[] {
  if (!pending || (!pending.adds.size && !pending.removes.size)) return base;
  const kept = base.filter((item) => !pending.removes.has(item.id));
  for (const item of pending.adds.values()) if (!kept.some((existing) => existing.id === item.id || samePath(existing, item))) kept.push(item);
  return kept;
}

/** This tab's presses between the click and W1 (or the refusal), per draft (A6): the draft is held for them too, so no
 * edit (text, attachments, reply, mode) lands after the click; edits queued before it still drain into W1. */
const pressing = new Set<string>();

function computeView(id: string, rec: DraftRecord, pending: Pending | null): DraftView {
  const reply = pending?.reply ? pending.reply.value : rec.reply;
  return {
    text: pending?.text ?? rec.text,
    att: applyOps(rec.att, pending),
    mode: pending?.mode ?? rec.mode,
    ...(reply ? { reply } : {}),
    held: Boolean(rec.out) || pressing.has(id),
  };
}

function ensureLive(id: string): Live {
  let entry = live.get(id);
  if (!entry) {
    const rec = viewRecord(id);
    entry = { rec, pending: null, view: computeView(id, rec, null) };
    live.set(id, entry);
  }
  return entry;
}

function setPressing(id: string, on: boolean): void {
  if (on) pressing.add(id); else pressing.delete(id);
  const entry = live.get(id);
  if (entry) entry.view = computeView(id, entry.rec, entry.pending);
  notify(id);
}

function notify(id: string): void {
  for (const listener of [...(listeners.get(id) ?? [])]) listener();
  for (const listener of [...heldListeners]) listener();
}

/** Take a record this tab read or wrote (or another tab wrote): pending edits survive only against the same n with no send out. */
function adopt(id: string, rec: DraftRecord | null): void {
  const entry = live.get(id);
  if (entry) {
    const next = rec ?? emptyRecord();
    if (entry.pending && (next.out || next.n !== entry.rec.n || !rec)) entry.pending = null;
    entry.rec = next;
    entry.view = computeView(id, next, entry.pending);
  }
  settleWatches(id, rec);
  notify(id);
}

/** Re-read a record after a change from anywhere. */
function changed(id: string): void {
  adopt(id, forgottenDrafts.has(id) ? null : readStoredRecord(id) ?? (live.has(id) ? viewRecord(id) : null));
}

export function subscribeDraft(id: string, listener: () => void): () => void {
  const set = listeners.get(id) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(id, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(id);
  };
}

/** The draft as this tab shows it: the stored record plus this tab's unsaved edits. */
export function readComposerDraft(id: string): DraftView {
  return ensureLive(id).view;
}

/** Held: a send of this draft is out (in this tab, another tab, or before a reload). Read-only until it settles. */
export function isDraftHeld(id: string): boolean {
  return ensureLive(id).view.held;
}

/** For useSyncExternalStore: every composer re-reads its held flag on any record change. */
export function subscribeDraftHeld(listener: () => void): () => void {
  heldListeners.add(listener);
  return () => { heldListeners.delete(listener); };
}

// ---------------------------------------------------------------- edits and persist

const persistQueued = new Set<string>();

function schedulePersist(id: string): void {
  if (persistQueued.has(id)) return;
  persistQueued.add(id);
  queueMicrotask(() => {
    persistQueued.delete(id);
    void persistDraft(id);
  });
}

function edit(id: string, change: (pending: Pending, view: DraftView) => void): boolean {
  if (blocked(id)) return false;
  const entry = ensureLive(id);
  if (entry.rec.out || pressing.has(id)) return false;
  const pending = entry.pending ?? { adds: new Map(), removes: new Set() };
  change(pending, entry.view);
  entry.pending = pending;
  entry.view = computeView(id, entry.rec, pending);
  notify(id);
  schedulePersist(id);
  return true;
}

export function setComposerDraftText(id: string, text: string): boolean {
  return edit(id, (pending) => { pending.text = text; });
}

export function setComposerDraftMode(id: string, mode: ChannelMode): boolean {
  return edit(id, (pending) => { pending.mode = mode; });
}

export function setComposerDraftReply(id: string, messageId: string | undefined): boolean {
  return edit(id, (pending) => { pending.reply = { value: messageId }; });
}

export function setComposerDraftAttachments(id: string, next: SetStateAction<Attachment[]>): boolean {
  return edit(id, (pending, view) => {
    const previous = view.att;
    const value = typeof next === "function" ? next(previous) : next;
    for (const item of previous) {
      if (value.some((kept) => kept.id === item.id)) continue;
      pending.adds.delete(item.id);
      pending.removes.add(item.id);
    }
    for (const item of value) {
      if (previous.some((existing) => existing.id === item.id)) continue;
      pending.removes.delete(item.id);
      pending.adds.set(item.id, item);
    }
  });
}

/** The pending edits of a live draft folded into a fresh record (attachments as operations, the rest last-writer-wins). */
function drained(entry: Live, rec: DraftRecord): DraftRecord {
  const pending = entry.pending;
  if (!pending) return rec;
  const reply = pending.reply ? pending.reply.value : rec.reply;
  const next: DraftRecord = { ...rec, text: pending.text ?? rec.text, mode: pending.mode ?? rec.mode, att: applyOps(rec.att, pending) };
  if (reply) next.reply = reply; else delete next.reply;
  return next;
}

/** persist(D): write this tab's edits under the lock, only if no send is out and n is the one they were made against. */
export function persistDraft(id: string): Promise<boolean> {
  return withLock(() => {
    const entry = live.get(id);
    if (!entry?.pending || blocked(id)) return false;
    const rec = lockedRecord(id);
    if (!rec) return false; // its migration is not on disk yet: the edits stay in this tab
    if (rec.out || rec.n !== entry.rec.n) {
      entry.pending = null; // an older n, or a send went out elsewhere: the stored words win
      adopt(id, rec);
      return false;
    }
    const next = drained(entry, rec);
    if (!writeRecord(id, next)) return false; // edits stay in this tab; the next edit tries again
    entry.pending = null;
    adopt(id, next);
    return true;
  });
}

/** Fill a draft only if it is empty (a starter profile's first task, A3): `decide` sees the content read INSIDE the lock
 * (this tab's unsaved edits included) and returns what to put in, or null to keep what is there. The check and the
 * insert are one locked section, so a newer edit that already landed is never overwritten. True when the draft now
 * holds the restored content or kept its own; false when a send is out or storage refused the write. */
export function restoreComposerDraftIfEmpty(
  id: string,
  decide: (current: DraftContent) => { text: string; attachments: Attachment[]; channelMode?: ChannelMode } | null,
): Promise<boolean> {
  return withLock(() => {
    if (blocked(id)) return false;
    const rec = lockedRecord(id);
    if (!rec || rec.out || pressing.has(id)) return false;
    const entry = live.get(id);
    const current = contentOf(entry && rec.n === entry.rec.n ? drained(entry, rec) : rec);
    const draft = decide(current);
    if (!draft) return true;
    const next: DraftRecord = { ...rec, text: draft.text, att: draft.attachments, mode: draft.channelMode ?? "chat" };
    if (!writeRecord(id, next)) return false;
    if (entry) entry.pending = null;
    adopt(id, next);
    return true;
  });
}

/** Add attachment chips to a draft from outside its composer ("Use as reference", an upload finishing after navigation).
 * The target is picked from the record read inside the lock: `later` while a send is out, otherwise the draft itself.
 * Resolves true only once that write landed; the same file is not added twice.
 * `keepInTab` (the composer's own uploads): when storage refuses the write and no send is out, the chips join this
 * tab's draft like typed words do (section 3 `live`, F11 "runs in memory"): they show in the box, stay with this
 * draft across navigation in this tab, and are written by the next persist that lands. True then means "in the
 * draft". Without it (image reference) true always means "stored" (A4, F27). */
export function appendComposerDraftAttachments(id: string, added: Attachment[], options: { keepInTab?: boolean } = {}): Promise<boolean> {
  if (added.length === 0) return Promise.resolve(true);
  return withLock(() => {
    if (blocked(id)) return false;
    const keepHere = (items: Attachment[], fresh: DraftRecord | null): boolean => {
      if (!options.keepInTab || blocked(id)) return false;
      // Edits are made against the record read inside the lock: a send cycle another tab finished first is taken
      // (dropping this tab's older edits, as persist would), so the kept chip is never discarded by the n guard.
      const entry = live.get(id);
      if (fresh && entry && entry.rec.n !== fresh.n) adopt(id, fresh);
      return edit(id, (pending, view) => {
        const shown = [...view.att];
        for (const item of items) {
          if (shown.some((existing) => existing.id === item.id || samePath(existing, item))) continue;
          shown.push(item);
          pending.removes.delete(item.id);
          pending.adds.set(item.id, item);
        }
      });
    };
    const rec = lockedRecord(id);
    if (!rec) return keepHere(added, null); // its migration is not on disk yet: like an edit, it stays in this tab
    // While a send is out, or this tab's press is between the click and W1 (A6), they wait in `later`.
    const toLater = Boolean(rec.out) || pressing.has(id);
    const target = toLater ? (rec.later ?? []) : rec.att;
    // Deduplicated against the durable destination only (A4): an attachment being sent, or one only in this tab's
    // unsaved edits, is still written, so true always means "stored".
    const fresh = added.filter((item) => !target.some((existing) => existing.id === item.id || samePath(existing, item)));
    if (!fresh.length) return true;
    const next: DraftRecord = toLater ? { ...rec, later: [...target, ...fresh] } : { ...rec, att: [...rec.att, ...fresh] };
    // A refused `later` write is never kept in the tab: a held draft takes no edits (F27).
    if (!writeRecord(id, next)) return toLater ? false : keepHere(fresh, rec);
    const entry = live.get(id);
    if (!toLater && entry?.pending) for (const item of fresh) entry.pending.removes.delete(item.id);
    adopt(id, next);
    return true;
  });
}

// ---------------------------------------------------------------- send (section 4)

export type DraftSendLookupResult = "ack" | "refused" | "cancelled" | "none";
type Lookup = (threadId: string, sendId: string, signal: AbortSignal) => Promise<DraftSendLookupResult>;
let lookupImpl: Lookup | null = null;

/** The store supplies GET /api/sends/:threadId/:sendId. */
export function setDraftSendLookup(lookup: Lookup | null): void { lookupImpl = lookup; }

function threadOfDraft(id: string, rec?: DraftRecord): string | undefined {
  if (rec?.out?.entry.threadId) return rec.out.entry.threadId;
  const parts = id.split(":");
  return (parts[0] === "bot" || parts[0] === "group") && parts.length >= 3 ? parts.slice(2).join(":") : undefined;
}

/** One lookup, never inside the lock, with a 5 s deadline. "error" keeps everything as it is. */
async function lookupSend(threadId: string | undefined, sendId: string): Promise<DraftSendLookupResult | "error"> {
  if (!threadId) return "none";
  if (!lookupImpl) return "error";
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookupImpl(threadId, sendId, controller.signal),
      new Promise<"error">((resolve) => { timer = setTimeout(() => { controller.abort(); resolve("error"); }, DRAFT_LOOKUP_TIMEOUT_MS); }),
    ]);
  } catch {
    return "error";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const outcomeOf = (result: DraftSendLookupResult): DraftOutcome | null =>
  result === "ack" ? "acked" : result === "refused" ? "refused" : result === "cancelled" ? "cancelled" : null;

/** The transitions of section 4 on one record. Null: nothing in this record is about that send. */
function transition(rec: DraftRecord, s: string, a: string | undefined, o: DraftOutcome): DraftRecord | null {
  const outIs = rec.out?.entry.sendId === s;
  const pinIs = !rec.out && rec.pin?.s === s;
  if (o === "failed") {
    if (!rec.out || !outIs || rec.out.a !== a) return null;
    const next: DraftRecord = { ...rec, att: [...rec.att, ...(rec.later ?? []).filter((item) => !rec.att.some((x) => x.id === item.id))], last: { s, a, o } };
    delete next.out;
    delete next.later;
    return next;
  }
  if (!outIs && !pinIs) return null;
  const owner = rec.out ?? rec.pin!;
  const clear = o !== "cancelled" && draftFingerprint(contentOf(rec)) === owner.fp;
  const base = clear ? { ...EMPTY } : contentOf(rec);
  const later = (rec.later ?? []).filter((item) => !base.att.some((x) => x.id === item.id));
  const next: DraftRecord = { v: 3, n: rec.n, ...base, att: [...base.att, ...later], last: { s, ...(rec.out ? { a: rec.out.a } : {}), o } };
  return next;
}

/** A settle write the storage refused: H stays, and the same transition is tried again later. */
const unsettled = new Map<string, { id?: string; s: string; a?: string; o: DraftOutcome }>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function armRetry(): void {
  if (!retryTimer) retryTimer = setTimeout(retryUnsettled, DRAFT_SETTLE_RETRY_MS);
}

/** Anything waiting on a refused write: settles, 1.0.4 settles (C1) and folds (C5). */
const retryPending = (): boolean => unsettled.size > 0 || legacyUnsettled.size > 0 || foldRetry.size > 0;

function retryUnsettled(): void {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  const all = [...unsettled.values()];
  unsettled.clear();
  for (const item of all) void settleDraftSend(item.id, item.s, item.a, item.o);
  const legacy = [...legacyUnsettled.values()];
  legacyUnsettled.clear();
  for (const item of legacy) void settleLegacySend(item.entry, item.o, item.done);
  for (const id of [...foldRetry]) void foldLater(id);
}

/** Settle a send on its record (or, without an id, on whichever record holds it): ack, refused or cancelled by s,
 * failed by (s, a). A duplicate, late or other-tab outcome applies once or finds nothing. True when a record changed. */
export function settleDraftSend(id: string | undefined, s: string, a: string | undefined, o: DraftOutcome): Promise<boolean> {
  return withLock(async () => {
    let any = false;
    for (const draftId of id ? [id] : recordIds()) {
      if (blocked(draftId)) continue;
      // Without Web Locks a settle another tab overwrote is applied again to what it wrote (A1), a few times at most.
      for (let round = 0; round < 3; round += 1) {
        const rec = lockedRecord(draftId);
        const next = rec && transition(rec, s, a, o);
        if (!next) break;
        if (!writeRecord(draftId, next)) {
          unsettled.set(`${draftId}\u0000${s}\u0000${a ?? ""}\u0000${o}`, { id: draftId, s, a, o });
          armRetry();
          break;
        }
        any = true;
        adopt(draftId, next);
        if (o === "failed") queueMicrotask(() => { void checkDraftPin(draftId, s); });
        if (!(await confirmed(draftId, next))) { adopt(draftId, readStoredRecord(draftId)); continue; }
        break;
      }
    }
    return any;
  });
}

/** 1.0.4 entries delivery took over undrafted whose settle could not land yet (their migration is not on disk). */
const legacyUnsettled = new Map<string, { entry: LegacyOutboxEntry; o: DraftOutcome; done: () => void }>();

/** A 1.0.4 entry delivered undrafted (C1) has settled. The draft it came from is migrated now if it was not (so its words
 * take the entry's pin), and the outcome applies to whatever that record holds of the send: an ack or refusal clears
 * words that still match, a failure keeps them with the pin. `done` runs once this is on disk; until then delivery keeps
 * the entry (its sendId -> draft ownership stays in the outbox key), and it is tried again with the settle retries. */
function settleLegacySend(entry: LegacyOutboxEntry, o: DraftOutcome, done: () => void): Promise<boolean> {
  const owner = legacyOwnerOf(entry);
  if (!owner) { done(); return Promise.resolve(true); }
  return withLock(() => {
    const id = owner.draftId;
    if (blocked(id)) return true; // deleted: nothing to clear
    const rec = lockedRecord(id);
    if (!rec) return blocked(id); // its migration is not on disk yet (or it was deleted elsewhere)
    // This entry is the 1.0.4 attempt, never a newer one (a Send again of the same id): a failure applies only to the
    // migrated "legacy" attempt, while an ack, refusal or cancel is about the send id and settles whatever holds it.
    const a = LEGACY_ATTEMPT;
    const next = transition(rec, entry.sendId, a, o);
    if (next) {
      // The record holds the send's pin on disk now, so delivery may let the entry go even if this write is refused.
      if (writeRecord(id, next)) adopt(id, next);
      else { unsettled.set(`${id}\u0000${entry.sendId}\u0000${a ?? ""}\u0000${o}`, { id, s: entry.sendId, a, o }); armRetry(); }
    }
    return true;
  }).then((landed) => {
    if (landed) done();
    else { legacyUnsettled.set(entry.sendId, { entry, o, done }); armRetry(); }
    return landed;
  }, () => {
    legacyUnsettled.set(entry.sendId, { entry, o, done });
    armRetry();
    return false;
  });
}

/** Look a pinned (or in-flight) send id up on the server and apply what it says, if the record still holds that send at the same n. */
export async function checkDraftPin(id: string, s: string): Promise<DraftSendLookupResult | "error" | "dropped"> {
  // A P pin whose words were edited since (stale, fp differs) is left for Send, where the notice can be shown (B2).
  const stalePin = (rec: DraftRecord) => !rec.out && rec.pin?.s === s && rec.pin.fp !== draftFingerprint(contentOf(rec));
  const captured = await withLock(() => {
    const rec = lockedRecord(id);
    if (!rec || stalePin(rec)) return null;
    const holds = rec.out?.entry.sendId === s || (!rec.out && rec.pin?.s === s);
    return holds ? { n: rec.n, threadId: threadOfDraft(id, rec) } : null;
  });
  // The record no longer holds that send (or its pin is stale): a lookup that failed earlier is not tried again (D5).
  if (!captured) { lookupRetry.delete(`${id}\u0000${s}`); return "dropped"; }
  const result = await lookupSend(captured.threadId, s);
  if (result === "error") { lookupRetry.add(`${id}\u0000${s}`); return result; }
  lookupRetry.delete(`${id}\u0000${s}`);
  if (result === "none") return result;
  const outcome = outcomeOf(result)!;
  const applied = await withLock(() => {
    const rec = lockedRecord(id);
    // The result is about the record as it was captured: a new n, or a pin made stale during the GET, drops it.
    if (!rec || rec.n !== captured.n || stalePin(rec)) return false;
    const next = transition(rec, s, rec.out?.a, outcome);
    if (!next || !writeRecord(id, next)) return false;
    adopt(id, next);
    return true;
  });
  return applied ? result : "dropped";
}

/** Lookups that failed (offline, timed out): tried again on the next `online` or load, with the P records. */
const lookupRetry = new Set<string>();

/** The load check (and `online`): every P record (a failed send whose words are still in the box) is looked up once,
 * and every lookup that failed earlier is tried again. */
export async function checkPinnedDrafts(): Promise<void> {
  const ids = recordIds().filter((id) => {
    const rec = readStoredRecord(id);
    return rec && !rec.out && rec.pin && rec.pin.fp !== "legacy" && rec.pin.fp === draftFingerprint(contentOf(rec));
  });
  const checks = new Map<string, [string, string]>();
  for (const id of ids) { const s = readStoredRecord(id)!.pin!.s; checks.set(`${id}\u0000${s}`, [id, s]); }
  for (const key of lookupRetry) { const [id, s] = key.split("\u0000") as [string, string]; checks.set(key, [id, s]); }
  await Promise.all([...checks.values()].map(([id, s]) => checkDraftPin(id, s)));
}

export type BeginDraftSendResult =
  | { ok: true; sendId: string; attemptId: string; content: DraftContent }
  | { ok: false; reason: "held" | "changed" | "notSaved" | "earlierArrived" | "checkFailed" | "gone" };

const newAttemptId = (): string => newSendId();

/** Send: W1 writes the content, n+1, the pin and the journal in ONE setItem before any POST. A stale pin (the person
 * edited after a failure, or an unproven 1.0.4 pin) is looked up first, outside the lock. `expect` is what the composer
 * showed; the press is refused if the drained draft is not that (nothing is sent that was not shown). */
export async function beginDraftSend(
  id: string,
  expect: Pick<DraftContent, "text" | "att" | "mode">,
  build: (sendId: string, content: DraftContent) => DraftOutboxEntry,
): Promise<BeginDraftSendResult> {
  if (pressing.has(id)) return Promise.resolve({ ok: false, reason: "held" });
  // The press reservation (A6): from here to W1 or the refusal, no edit lands; the edits queued before it drain into W1.
  setPressing(id, true);
  let begun: BeginDraftSendResult | undefined;
  try {
    begun = await pressOnce(id, expect, build);
    return begun;
  } finally {
    setPressing(id, false);
    // Attachments that arrived during a press that did not send wait in `later` with no send out: they join the draft.
    if (!begun?.ok) void foldLater(id);
  }
}

/** Folds a refused write tried again (C5), with the settle retries: the 30 s timer, the next storage or online event. */
const foldRetry = new Set<string>();

function foldLater(id: string): Promise<void> {
  return withLock(() => {
    foldRetry.delete(id);
    if (blocked(id) || pressing.has(id)) return; // a press of this tab still owns its `later`; it folds when the press ends
    const rec = readStoredRecord(id);
    if (!rec || rec.out || !rec.later?.length) return;
    const next: DraftRecord = { ...rec, att: [...rec.att, ...rec.later.filter((item) => !rec.att.some((x) => x.id === item.id))] };
    delete next.later;
    if (writeRecord(id, next)) adopt(id, next);
    else { foldRetry.add(id); armRetry(); }
  });
}

async function pressOnce(
  id: string,
  expect: Pick<DraftContent, "text" | "att" | "mode">,
  build: (sendId: string, content: DraftContent) => DraftOutboxEntry,
): Promise<BeginDraftSendResult> {
  const checked = new Set<string>();
  for (let round = 0; round < 3; round += 1) {
    const step = await withLock(async (): Promise<BeginDraftSendResult | { lookup: string; n: number; threadId?: string }> => {
      if (blocked(id)) return { ok: false, reason: "gone" };
      const entry = ensureLive(id);
      const rec = lockedRecord(id);
      if (!rec) return { ok: false, reason: blocked(id) ? "gone" : "notSaved" }; // deleted elsewhere (C2), or its 1.0.4 migration is not on disk (A5): nothing is sent
      if (rec.out) { entry.pending = null; adopt(id, rec); return { ok: false, reason: "held" }; }
      if (rec.n !== entry.rec.n) { entry.pending = null; adopt(id, rec); return { ok: false, reason: "changed" }; }
      const content = contentOf(drained(entry, rec));
      if (content.text !== expect.text || content.mode !== expect.mode || draftFingerprint({ ...content, reply: undefined }) !== draftFingerprint({ text: expect.text, att: expect.att, mode: expect.mode })) {
        return { ok: false, reason: "changed" };
      }
      const fp = draftFingerprint(content);
      if (rec.pin && rec.pin.fp !== fp && !checked.has(rec.pin.s)) return { lookup: rec.pin.s, n: rec.n, threadId: threadOfDraft(id, rec) };
      const reuse = rec.pin && rec.pin.fp === fp ? rec.pin : null;
      const sendId = reuse?.s ?? newSendId();
      const attemptId = newAttemptId();
      const next: DraftRecord = {
        v: 3,
        n: rec.n + 1,
        ...content,
        pin: { s: sendId, fp, at: reuse?.at ?? Date.now() },
        out: { a: attemptId, fp, entry: build(sendId, content) },
        ...(rec.later?.length ? { later: rec.later } : {}),
        ...(rec.last ? { last: rec.last } : {}),
      };
      if (!writeRecord(id, next)) return { ok: false, reason: "notSaved" }; // nothing posted; the words stay where they are
      entry.pending = null;
      if (!webLocks() && getStore()) {
        // No Web Locks (A1, C3): after the verify window the press is ours only if the stored record still holds THIS
        // attempt (s, a). Another tab's append to `later` keeps it, and the fresh record (with that attachment) is adopted.
        // Another tab's W1 (or a stale write without `out`) means this press is lost, quietly: nothing posts from here,
        // and whatever H is stored belongs to the tab that wrote it.
        await new Promise<void>((resolve) => { setTimeout(resolve, DRAFT_VERIFY_WINDOW_MS); });
        const stored = readStoredRecord(id);
        adopt(id, stored);
        if (!stored?.out || stored.out.entry.sendId !== sendId || stored.out.a !== attemptId) return { ok: false, reason: stored?.out ? "held" : "changed" };
        return { ok: true, sendId, attemptId, content };
      }
      adopt(id, next);
      return { ok: true, sendId, attemptId, content };
    });
    if (!("lookup" in step)) return step;
    const result = await lookupSend(step.threadId, step.lookup);
    if (result === "error") return { ok: false, reason: "checkFailed" };
    const arrived = await withLock(() => {
      const rec = lockedRecord(id);
      if (!rec) return "unsaved" as const;
      if (rec.n !== step.n || rec.out || rec.pin?.s !== step.lookup) return "moved" as const;
      const outcome = outcomeOf(result);
      // Not arrived: the stale id retires and the next round mints a new one. Otherwise the server's answer applies
      // (the words stay, their fingerprint differs from the pin's).
      const next: DraftRecord = outcome ? (transition(rec, step.lookup, undefined, outcome) ?? rec) : (() => { const r = { ...rec }; delete r.pin; return r; })();
      if (!writeRecord(id, next)) return "unsaved" as const;
      adopt(id, next);
      return result === "ack" ? ("arrived" as const) : ("retired" as const);
    });
    if (arrived === "arrived") return { ok: false, reason: "earlierArrived" };
    if (arrived === "unsaved") return { ok: false, reason: "notSaved" };
    checked.add(step.lookup);
  }
  return { ok: false, reason: "changed" };
}

// ---------------------------------------------------------------- hooks: UI only, keyed by (s, a)

type Watch = { s: string; a: string; settle: (outcome: DraftOutcome | "gone") => void };
const watches = new Map<string, Set<Watch>>();

function settleWatches(id: string, rec: DraftRecord | null): void {
  const set = watches.get(id);
  if (!set) return;
  for (const watch of [...set]) {
    if (rec?.out && rec.out.entry.sendId === watch.s && rec.out.a === watch.a) continue;
    set.delete(watch);
    watch.settle(rec?.last && rec.last.s === watch.s && rec.last.a === watch.a ? rec.last.o : "gone");
  }
  if (set.size === 0) watches.delete(id);
}

/** Calls `settle` once, when attempt (s, a) is no longer this draft's send in flight: with its outcome, or "gone". */
export function watchDraftSend(id: string, s: string, a: string, settle: (outcome: DraftOutcome | "gone") => void): () => void {
  const watch: Watch = { s, a, settle };
  const set = watches.get(id) ?? new Set<Watch>();
  set.add(watch);
  watches.set(id, set);
  settleWatches(id, forgottenDrafts.has(id) ? null : readStoredRecord(id));
  return () => { set.delete(watch); };
}

// ---------------------------------------------------------------- the journal the send delivery reads (send-delivery.ts)

export const draftJournal = {
  /** Every record's send in flight, read fresh. */
  entries(): DraftJournalEntry[] {
    const out: DraftJournalEntry[] = [];
    for (const id of recordIds()) {
      if (forgottenDrafts.has(id)) continue;
      const rec = readStoredRecord(id);
      if (!rec?.out) continue;
      out.push({
        ...rec.out.entry,
        draft: {
          draftId: id,
          attemptId: rec.out.a,
          text: rec.text,
          requestText: rec.out.entry.text,
          attachments: rec.att,
          ...(rec.out.entry.kind === "group" ? { channelMode: rec.mode } : {}),
          ...(rec.reply ? { replyToId: rec.reply } : {}),
        },
      });
    }
    return out;
  },
  /** A 1.0.4 outbox entry carrying a draft: "record" when that draft's record holds it (the legacy duplicate loses),
   * otherwise "undrafted" (it delivers once, with no draft to clear). */
  classify(entry: { sendId: string; draft?: { draftId?: unknown } }): "record" | "undrafted" {
    const draftId = entry.draft?.draftId;
    if (typeof draftId !== "string") return "undrafted";
    // The STORED record only (A5): until a migration is on disk, delivery keeps owning the legacy entry.
    return readStoredRecord(draftId)?.out?.entry.sendId === entry.sendId ? "record" : "undrafted";
  },
  /** The draft a 1.0.4 entry carries (its `draft`), kept on the entry when delivery takes it over undrafted (C1). */
  legacyOwner(entry: { sendId: string; draft?: unknown; legacyDraft?: unknown }): LegacyDraftOwner | undefined {
    return legacyOwnerOf(entry as LegacyOutboxEntry);
  },
  /** An undrafted 1.0.4 entry settled (C1): see settleLegacySend. */
  settleLegacy(entry: DraftOutboxEntry, outcome: DraftOutcome, done: () => void): Promise<boolean> {
    return settleLegacySend(entry as LegacyOutboxEntry, outcome, done);
  },
  /** Delivery's hooks for attempt (s, a), settled when that attempt is no longer the record's send in flight, from any
   * tab (A7): with its outcome, or "gone". */
  watch(entry: DraftJournalEntry, settle: (outcome: DraftOutcome | "gone") => void): () => void {
    const draftId = entry.draft?.draftId;
    if (!draftId || !entry.draft?.attemptId) return () => {};
    return watchDraftSend(draftId, entry.sendId, entry.draft.attemptId, settle);
  },
  /** Whether this attempt is still the record's send in flight (W1 wrote it; nothing else has settled it since). */
  holds(entry: DraftJournalEntry): boolean {
    const draftId = entry.draft?.draftId;
    if (!draftId || forgottenDrafts.has(draftId)) return false;
    const rec = readStoredRecord(draftId);
    return rec?.out?.entry.sendId === entry.sendId && rec.out.a === entry.draft?.attemptId;
  },
  settle(entry: DraftJournalEntry, outcome: DraftOutcome): Promise<boolean> {
    return settleDraftSend(entry.draft?.draftId, entry.sendId, entry.draft?.attemptId, outcome);
  },
  /** A failed write only loses the count. */
  bump(entry: DraftJournalEntry): Promise<void> {
    const draftId = entry.draft?.draftId;
    if (!draftId) return Promise.resolve();
    return withLock(() => {
      const rec = lockedRecord(draftId);
      if (!rec?.out || rec.out.entry.sendId !== entry.sendId || rec.out.a !== entry.draft?.attemptId) return;
      const next: DraftRecord = { ...rec, out: { ...rec.out, entry: { ...rec.out.entry, attempts: rec.out.entry.attempts + 1 } } };
      if (writeRecord(draftId, next)) adopt(draftId, next);
    });
  },
};

export type DraftJournal = typeof draftJournal;

// ---------------------------------------------------------------- cross-tab events

/** Another tab removed a record this tab knew (a deletion there, or storage cleared): the draft is gone here too (A2).
 * Unsaved edits are dropped, hooks settle "gone", and nothing is written for it again unless its owner re-validates. */
function goneRemotely(id: string): void {
  knownStored.delete(id);
  remoteGone.add(id);
  const entry = live.get(id);
  if (entry) entry.pending = null;
  adopt(id, null);
}

/** `removed`: the event itself says the key was removed (newValue null). Only a deletion removes a record key, so that
 * is a deletion even if this tab wrote the key again before the event arrived (C2): the payload wins over a re-read, and
 * a record this tab put back is removed again unless its conversation is still listed here. */
function heard(id: string, removed = false): void {
  if (!forgottenDrafts.has(id)) {
    if (removed) {
      goneRemotely(id);
      void withLock(() => {
        if (!blocked(id)) return;
        try { recordStore().removeItem?.(DRAFT_RECORD_PREFIX + id); } catch { /* best-effort */ }
      }).catch(() => undefined);
      return;
    }
    if (knownStored.has(id)) {
      let present = true;
      try { present = recordStore().getItem(DRAFT_RECORD_PREFIX + id) !== null; } catch { present = true; }
      if (!present) { goneRemotely(id); return; }
    }
  }
  changed(id);
}

function onStorage(event: Event): void {
  const { key, newValue } = event as Event & { key?: string | null; newValue?: string | null };
  if (key === null || key === undefined) {
    for (const id of new Set([...live.keys(), ...watches.keys(), ...knownStored])) heard(id);
  } else if (typeof key === "string" && key.startsWith(DRAFT_RECORD_PREFIX)) {
    heard(key.slice(DRAFT_RECORD_PREFIX.length), newValue === null);
  }
  if (retryPending()) retryUnsettled();
  if (migrationPending) void migrateLegacyDrafts().catch(() => undefined);
}

try {
  const target = (globalThis as { window?: EventTarget }).window;
  if (target && typeof target.addEventListener === "function") {
    target.addEventListener("storage", onStorage);
    target.addEventListener("online", () => {
      if (retryPending()) retryUnsettled();
      if (migrationPending) void migrateLegacyDrafts().catch(() => undefined);
      void checkPinnedDrafts().catch(() => undefined);
    });
  }
} catch { /* no window: a test or a worker */ }

// ---------------------------------------------------------------- failed-send retry list (undrafted sends)

export interface FailedComposerSend {
  id: string;
  sendId: string;
  text: string;
  requestText: string;
  replyToId?: string;
  threadId: string;
  /** Channel delivery mode; absent for 1:1 messages and legacy retries. */
  channelMode?: "chat" | "goal";
}
type FailedComposerSendInput = Omit<FailedComposerSend, "id">;
const failedSends = new Map<string, FailedComposerSend[]>();
const failedSendListeners = new Map<string, Set<(sends: FailedComposerSend[]) => void>>();
let failedSendSequence = 0;
// Drafts whose stored failed list has been read into `failedSends`, lazily, per conversation.
const loadedFailedSends = new Set<string>();

function isFailedSend(value: unknown): value is FailedComposerSend {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const send = value as Record<string, unknown>;
  return (
    typeof send.id === "string" &&
    typeof send.sendId === "string" &&
    typeof send.text === "string" &&
    typeof send.requestText === "string" &&
    typeof send.threadId === "string" &&
    (send.replyToId === undefined || typeof send.replyToId === "string") &&
    (send.channelMode === undefined || send.channelMode === "chat" || send.channelMode === "goal")
  );
}

/** Best-effort: a refused write leaves the list in memory for this session. */
function storeFailedSends(id: string, sends: FailedComposerSend[]): void {
  if (forgottenDrafts.has(id)) return;
  const store = getStore();
  const all = read(store, FAILED_SENDS_KEY);
  if (sends.length) all[id] = sends.slice(-MAX_FAILED_SENDS_PER_DRAFT);
  else delete all[id];
  try {
    store?.setItem(FAILED_SENDS_KEY, JSON.stringify(all));
  } catch {
    /* quota / private mode — the list still lives for this session */
  }
}

function publishFailedSends(id: string): void {
  const sends = failedSends.get(id) ?? [];
  for (const listener of failedSendListeners.get(id) ?? []) listener(sends);
}

export function failedComposerSends(id: string): FailedComposerSend[] {
  if (!loadedFailedSends.has(id)) {
    loadedFailedSends.add(id);
    const stored = read(getStore(), FAILED_SENDS_KEY)[id];
    if (Array.isArray(stored) && !failedSends.has(id)) {
      const valid = stored.filter(isFailedSend).slice(-MAX_FAILED_SENDS_PER_DRAFT);
      if (valid.length) failedSends.set(id, valid);
    }
  }
  return failedSends.get(id) ?? [];
}

export function rememberFailedComposerSend(id: string, input: FailedComposerSendInput): FailedComposerSend {
  const failed = { ...input, id: `${Date.now().toString(36)}-${++failedSendSequence}` };
  const sends = [...failedComposerSends(id), failed].slice(-MAX_FAILED_SENDS_PER_DRAFT);
  failedSends.set(id, sends);
  storeFailedSends(id, sends);
  publishFailedSends(id);
  return failed;
}

export function forgetFailedComposerSend(id: string, failedId: string): void {
  const remaining = failedComposerSends(id).filter((failed) => failed.id !== failedId);
  if (remaining.length > 0) failedSends.set(id, remaining);
  else failedSends.delete(id);
  storeFailedSends(id, remaining);
  publishFailedSends(id);
}

export function useFailedComposerSends(id: string): FailedComposerSend[] {
  const [sends, setSends] = useState(() => failedComposerSends(id));
  useEffect(() => {
    setSends(failedComposerSends(id));
    const set = failedSendListeners.get(id) ?? new Set<(next: FailedComposerSend[]) => void>();
    set.add(setSends);
    failedSendListeners.set(id, set);
    return () => {
      set.delete(setSends);
      if (set.size === 0) failedSendListeners.delete(id);
    };
  }, [id]);
  return sends;
}

// ONE recovery surface per sendId: when the server shows a refused chip, the chip owns the words.

function releaseRetryItems(sendIds: ReadonlySet<string>): void {
  const retryDraftIds = new Set<string>([...failedSends.keys(), ...Object.keys(read(getStore(), FAILED_SENDS_KEY))]);
  for (const draftId of retryDraftIds) {
    for (const failed of failedComposerSends(draftId)) if (sendIds.has(failed.sendId)) forgetFailedComposerSend(draftId, failed.id);
  }
}

/** The sends the server currently shows as refused chips: refused(s) on any record that holds one (the chip owns those
 * words), and their retry-list items go. Only a confirmed chip ever reaches refused(s). */
export function noteRefusedChips(sendIds: ReadonlySet<string>): void {
  if (!sendIds.size) return;
  releaseRetryItems(sendIds);
  const holders = recordIds().filter((id) => {
    const rec = readStoredRecord(id);
    return Boolean(rec && ((rec.out && sendIds.has(rec.out.entry.sendId)) || (!rec.out && rec.pin && sendIds.has(rec.pin.s))));
  });
  for (const id of holders) {
    const rec = readStoredRecord(id);
    const s = rec?.out?.entry.sendId ?? rec?.pin?.s;
    if (s) void settleDraftSend(id, s, undefined, "refused");
  }
}

/** A refused chip for this send was confirmed (or the person pressed its Send again or dismissed it). */
export function releaseRecoveredSend(sendId: string, _options: { includeFrozen?: boolean } = {}): void {
  noteRefusedChips(new Set([sendId]));
}

// ---------------------------------------------------------------- delete

/** What was deleted. Composer drafts are keyed `bot:<bot>:<thread>` (and the
 * older `bot:<bot>`) or `group:<channel>:<thread>`. */
export type DeletedDraftOwner = { threadId: string } | { botId: string } | { groupId: string };

export function draftBelongsTo(draftId: string, owner: DeletedDraftOwner): boolean {
  if ("threadId" in owner) return /^(bot|group):[^:]+:/.test(draftId) && draftId.endsWith(`:${owner.threadId}`);
  if ("botId" in owner) return draftId === `bot:${owner.botId}` || draftId.startsWith(`bot:${owner.botId}:`);
  return draftId.startsWith(`group:${owner.groupId}:`);
}

/** Deleting a conversation, a bot or a channel removes every unsent draft it had from browser storage straight away:
 * its record (words, attachments, mode, reply, pin and journal), the 1.0.4 keys and the failed-send list. Nothing is
 * written for it again, so a composer still mounted for a moment, or a send that settles after the delete, cannot put
 * the words back. */
export function forgetDeletedDrafts(owner: DeletedDraftOwner, store: Store = getStore()): Promise<void> {
  const ids = new Set<string>();
  for (const key of [KEY, ATTACHMENTS_KEY, SEND_IDS_KEY, CHANNEL_MODES_KEY, FAILED_SENDS_KEY]) {
    const values = read(store, key);
    const owned = Object.keys(values).filter((id) => draftBelongsTo(id, owner));
    if (!owned.length) continue;
    for (const id of owned) { ids.add(id); delete values[id]; }
    try {
      if (!Object.keys(values).length && store?.removeItem) store.removeItem(key);
      else store?.setItem(key, JSON.stringify(values));
    } catch {
      /* best-effort, like every draft write */
    }
  }
  const records = store ?? memoryStore;
  const removeRecords = () => {
    for (const key of storeKeys(records)) {
      if (!key.startsWith(DRAFT_RECORD_PREFIX)) continue;
      const id = key.slice(DRAFT_RECORD_PREFIX.length);
      if (!draftBelongsTo(id, owner)) continue;
      ids.add(id);
      try { records.removeItem?.(key); } catch { /* best-effort */ }
    }
  };
  // At once (this tab writes nothing for them again), and once more under the lock (A2): a tab that read the record
  // before this removal and writes it back inside its own locked section is undone by the locked removal after it.
  removeRecords();
  for (const id of [...live.keys(), ...failedSends.keys(), ...loadedFailedSends, ...watches.keys(), ...knownStored]) if (draftBelongsTo(id, owner)) ids.add(id);
  for (const id of ids) {
    forgottenDrafts.add(id);
    knownStored.delete(id);
    failedSends.delete(id);
    loadedFailedSends.delete(id);
    adopt(id, null);
    live.delete(id);
  }
  return withLock(removeRecords).catch(() => undefined);
}

// ---------------------------------------------------------------- hooks

function useDraftView(id: string): DraftView {
  const subscribe = useCallback((listener: () => void) => subscribeDraft(id, listener), [id]);
  const snapshot = useCallback(() => readComposerDraft(id), [id]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** A conversation's complete composer draft: [text, setText, attachments, setAttachments]. Edits go to this tab's live
 * draft synchronously (functional updates read it, never a stale render) and are persisted under the lock. */
export function useComposerDraft(
  id: string,
  legacyId?: string,
): [string, (next: string) => void, Attachment[], (next: SetStateAction<Attachment[]>) => void] {
  // The pre-thread `bot:<bot>` draft moves into the first thread opened, once.
  useEffect(() => {
    if (!legacyId || legacyId === id) return;
    const current = readComposerDraft(id);
    if (current.text || current.att.length || current.held) return;
    const legacy = readComposerDraft(legacyId);
    if ((!legacy.text && !legacy.att.length) || legacy.held) return;
    setComposerDraftText(id, legacy.text);
    setComposerDraftAttachments(id, legacy.att);
    setComposerDraftText(legacyId, "");
    setComposerDraftAttachments(legacyId, []);
  }, [id, legacyId]);
  const view = useDraftView(id);
  const setText = useCallback((next: string) => { setComposerDraftText(id, next); }, [id]);
  const setAttachments = useCallback((next: SetStateAction<Attachment[]>) => { setComposerDraftAttachments(id, next); }, [id]);
  return [view.text, setText, view.att, setAttachments];
}

/** Goal mode belongs to the draft (its record), so every tab and a reload agree. */
export function useComposerChannelMode(id: string): [ChannelMode, (next: SetStateAction<ChannelMode>) => void] {
  const view = useDraftView(id);
  const set = useCallback((next: SetStateAction<ChannelMode>) => {
    const value = typeof next === "function" ? next(readComposerDraft(id).mode) : next;
    setComposerDraftMode(id, value);
  }, [id]);
  return [view.mode, set];
}

/** The reply target lives in the draft record, so its fingerprint and the clear rule agree in every tab. */
export function useReplyDraft<T extends { id: string }>(
  _threadId: string,
  draftId: string,
  messages: T[],
) {
  const view = useDraftView(draftId);
  const [picked, setPicked] = useState<T | null>(null);
  const replyTo = view.reply
    ? (messages.find((message) => message.id === view.reply) ?? (picked?.id === view.reply ? picked : null))
    : null;
  const selectReply = useCallback((message: T) => {
    if (setComposerDraftReply(draftId, message.id)) setPicked(message);
  }, [draftId]);
  const clearReply = useCallback(() => { setComposerDraftReply(draftId, undefined); }, [draftId]);
  // The acknowledgement clears the reply with the words (in the record); nothing is left to consume or restore.
  const consumeReply = useCallback(() => { setPicked(null); }, []);
  const restoreReply = useCallback((_message: T, _targetThreadId: string) => {}, []);
  return { replyTo, selectReply, clearReply, consumeReply, restoreReply };
}
