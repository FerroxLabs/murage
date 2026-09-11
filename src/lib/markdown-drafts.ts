// Recoverable Markdown drafts (F4-T4, adopted U-07).
//
// Drafts live in the renderer's IndexedDB, keyed by scope + relative path.
// They are a crash-recovery copy of unsaved editor text, never a second file
// store: the `.md` on disk stays canonical and a draft is cleared when its
// text is saved or discarded.
//
// Bounds: at most 50 drafts and 10 MiB of draft text. A draft that would
// exceed either bound is refused with a visible error. Nothing is ever
// evicted to make room, because every stored draft is somebody's unsaved
// work. A browser storage quota failure is reported the same way.
//
// Quota checks and writes happen inside one IndexedDB readwrite transaction,
// so two windows cannot both squeeze past the bound, and operations from
// this renderer are applied in the order they were requested.
import type { FileRevision } from "../../shared/workspace-files";
import { documentKey, type DocumentIdentity, type DocumentMode } from "./document-session";

export const MARKDOWN_DRAFT_MAX_COUNT = 50;
export const MARKDOWN_DRAFT_MAX_BYTES = 10 * 1024 * 1024;
export const MARKDOWN_DRAFT_DB_NAME = "murage-markdown-drafts";
export const MARKDOWN_DRAFT_DB_VERSION = 1;
export const MARKDOWN_DRAFT_OBJECT_STORE = "drafts";

export interface MarkdownDraftRecord {
  /** `documentKey(identity)`. */
  key: string;
  botId: string;
  threadId: string;
  relativePath: string;
  /** Disk revision the draft text was based on. */
  baseRevision: FileRevision;
  content: string;
  draftRevision: number;
  mode?: DocumentMode;
  /** UTF-8 bytes of `content`; what the byte bound counts. */
  bytes: number;
  updatedAt: number;
}

export interface MarkdownDraftInput {
  baseRevision: FileRevision;
  content: string;
  draftRevision: number;
  mode?: DocumentMode;
}

export type MarkdownDraftErrorCode =
  | "draft-count-exceeded"
  | "draft-bytes-exceeded"
  | "storage-quota"
  | "storage-unavailable";

export interface MarkdownDraftFailure {
  ok: false;
  code: MarkdownDraftErrorCode;
  message?: string;
}

export type PreserveDraftResult = { ok: true; record: MarkdownDraftRecord } | MarkdownDraftFailure;
export type LoadDraftResult = { ok: true; record: MarkdownDraftRecord | null } | MarkdownDraftFailure;
export type ClearDraftResult = { ok: true; cleared: boolean } | MarkdownDraftFailure;
export type ListDraftsResult = { ok: true; records: MarkdownDraftRecord[]; bytes: number } | MarkdownDraftFailure;

export interface MarkdownDraftLimits {
  maxCount: number;
  maxBytes: number;
}

/** Writes a plan wants applied to the snapshot it was computed from. */
export interface DraftPlan<T> {
  put?: MarkdownDraftRecord[];
  delete?: string[];
  result: T;
}

export interface DraftBackend {
  /** Compute `plan` from a consistent snapshot of every record and apply its
   * writes atomically with that read. `write: false` must not write. */
  transact<T>(plan: (records: readonly MarkdownDraftRecord[]) => DraftPlan<T>, options: { write: boolean }): Promise<T>;
}

const encoder = new TextEncoder();

/** Pure bound check. The same key replaces its previous draft; nothing else
 * is ever removed to make room. */
export function planPreserveDraft(
  records: readonly MarkdownDraftRecord[],
  record: MarkdownDraftRecord,
  limits: MarkdownDraftLimits,
): DraftPlan<PreserveDraftResult> {
  const existing = records.find(item => item.key === record.key);
  const count = records.length + (existing ? 0 : 1);
  if (count > limits.maxCount) {
    return { result: { ok: false, code: "draft-count-exceeded" } };
  }
  const bytes = records.reduce((total, item) => total + item.bytes, 0) - (existing?.bytes ?? 0) + record.bytes;
  if (bytes > limits.maxBytes) {
    return { result: { ok: false, code: "draft-bytes-exceeded" } };
  }
  return { put: [record], result: { ok: true, record } };
}

/** Pure clear. With `upToDraftRevision`, a draft preserved after that revision
 * (typing that continued while a save was in flight) is kept. */
export function planClearDraft(
  records: readonly MarkdownDraftRecord[],
  key: string,
  options: { upToDraftRevision?: number } = {},
): DraftPlan<ClearDraftResult> {
  const existing = records.find(item => item.key === key);
  if (!existing) return { result: { ok: true, cleared: false } };
  if (options.upToDraftRevision !== undefined && existing.draftRevision > options.upToDraftRevision) {
    return { result: { ok: true, cleared: false } };
  }
  return { delete: [key], result: { ok: true, cleared: true } };
}

/** Map a thrown storage error to a visible draft failure. */
export function draftFailureFrom(error: unknown): MarkdownDraftFailure {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
  const message = error instanceof Error || (error && typeof error === "object" && "message" in error)
    ? String((error as { message: unknown }).message)
    : undefined;
  const code: MarkdownDraftErrorCode = name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED"
    ? "storage-quota"
    : "storage-unavailable";
  return { ok: false, code, ...(message ? { message } : {}) };
}

export interface MarkdownDraftStore {
  preserve(identity: DocumentIdentity, draft: MarkdownDraftInput): Promise<PreserveDraftResult>;
  load(identity: DocumentIdentity): Promise<LoadDraftResult>;
  clear(identity: DocumentIdentity, options?: { upToDraftRevision?: number }): Promise<ClearDraftResult>;
  /** Every preserved draft, most recent first (for a recovery list). */
  list(): Promise<ListDraftsResult>;
}

export function createMarkdownDraftStore(
  backend: DraftBackend,
  options: Partial<MarkdownDraftLimits> & { now?: () => number } = {},
): MarkdownDraftStore {
  const limits: MarkdownDraftLimits = {
    maxCount: options.maxCount ?? MARKDOWN_DRAFT_MAX_COUNT,
    maxBytes: options.maxBytes ?? MARKDOWN_DRAFT_MAX_BYTES,
  };
  const now = options.now ?? Date.now;
  // Apply this renderer's operations in request order: a clear requested
  // after a preserve must not land before it.
  let queue: Promise<unknown> = Promise.resolve();
  function run<T>(operation: () => Promise<T>): Promise<T | MarkdownDraftFailure> {
    const next = queue.then(operation).catch(draftFailureFrom);
    queue = next;
    return next;
  }
  return {
    preserve(identity, draft) {
      const record: MarkdownDraftRecord = {
        key: documentKey(identity),
        botId: identity.scope.botId,
        threadId: identity.scope.threadId,
        relativePath: identity.relativePath,
        baseRevision: draft.baseRevision,
        content: draft.content,
        draftRevision: draft.draftRevision,
        ...(draft.mode ? { mode: draft.mode } : {}),
        bytes: encoder.encode(draft.content).byteLength,
        updatedAt: now(),
      };
      return run(() => backend.transact(records => planPreserveDraft(records, record, limits), { write: true }));
    },
    load(identity) {
      const key = documentKey(identity);
      return run(() => backend.transact(records => ({ result: { ok: true as const, record: records.find(item => item.key === key) ?? null } }), { write: false }));
    },
    clear(identity, clearOptions) {
      const key = documentKey(identity);
      return run(() => backend.transact(records => planClearDraft(records, key, clearOptions), { write: true }));
    },
    list() {
      return run(() => backend.transact(records => ({
        result: {
          ok: true as const,
          records: [...records].sort((a, b) => b.updatedAt - a.updatedAt),
          bytes: records.reduce((total, item) => total + item.bytes, 0),
        },
      }), { write: false }));
    },
  };
}

/** In-memory backend. Tests use it; it is not a fallback for real drafts,
 * because memory does not survive the crash drafts exist for. */
export function createMemoryDraftBackend(initial: MarkdownDraftRecord[] = []): DraftBackend & { records(): MarkdownDraftRecord[] } {
  const map = new Map(initial.map(record => [record.key, { ...record }]));
  return {
    records: () => [...map.values()].map(record => ({ ...record })),
    async transact(plan, { write }) {
      const planned = plan([...map.values()].map(record => ({ ...record })));
      if (!write && (planned.put?.length || planned.delete?.length)) throw new Error("read-only draft transaction tried to write");
      for (const key of planned.delete ?? []) map.delete(key);
      for (const record of planned.put ?? []) map.set(record.key, { ...record });
      return planned.result;
    },
  };
}

class DraftStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftStorageUnavailableError";
  }
}

/** The renderer IndexedDB backend. Without IndexedDB every operation fails
 * with `storage-unavailable`; drafts are never silently kept in memory. */
export function createIndexedDbDraftBackend(
  factory: IDBFactory | undefined = globalThis.indexedDB,
  databaseName: string = MARKDOWN_DRAFT_DB_NAME,
): DraftBackend {
  let database: Promise<IDBDatabase> | null = null;
  function open(): Promise<IDBDatabase> {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (!factory) {
        reject(new DraftStorageUnavailableError("IndexedDB is not available"));
        return;
      }
      const request = factory.open(databaseName, MARKDOWN_DRAFT_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(MARKDOWN_DRAFT_OBJECT_STORE)) {
          db.createObjectStore(MARKDOWN_DRAFT_OBJECT_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another window upgrading the schema: step aside and reopen later.
        db.onversionchange = () => {
          db.close();
          database = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new DraftStorageUnavailableError("IndexedDB open failed"));
      request.onblocked = () => reject(new DraftStorageUnavailableError("IndexedDB open is blocked by another window"));
    }).catch(error => {
      database = null;
      throw error;
    });
    return database;
  }
  return {
    async transact(plan, { write }) {
      const db = await open();
      return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        let transaction: IDBTransaction;
        try {
          transaction = db.transaction(MARKDOWN_DRAFT_OBJECT_STORE, write ? "readwrite" : "readonly");
        } catch (error) {
          fail(error);
          return;
        }
        const store = transaction.objectStore(MARKDOWN_DRAFT_OBJECT_STORE);
        let result: unknown;
        const all = store.getAll();
        all.onsuccess = () => {
          try {
            const planned = plan(all.result as MarkdownDraftRecord[]);
            result = planned.result;
            if (!write && (planned.put?.length || planned.delete?.length)) throw new Error("read-only draft transaction tried to write");
            for (const key of planned.delete ?? []) store.delete(key);
            for (const record of planned.put ?? []) store.put(record);
          } catch (error) {
            fail(error);
            try { transaction.abort(); } catch { /* already finished */ }
          }
        };
        transaction.oncomplete = () => {
          if (settled) return;
          settled = true;
          resolve(result as never);
        };
        transaction.onerror = () => fail(transaction.error ?? all.error ?? new DraftStorageUnavailableError("IndexedDB transaction failed"));
        transaction.onabort = () => fail(transaction.error ?? new DraftStorageUnavailableError("IndexedDB transaction aborted"));
      });
    },
  };
}
