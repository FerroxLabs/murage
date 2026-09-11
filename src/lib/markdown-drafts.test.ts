// F4-T4 / adopted U-07: bounded recoverable drafts in renderer IndexedDB.
// The repo has no fake-indexeddb, so the IndexedDB backend is exercised
// against a small in-file fake that keeps IndexedDB's transaction shape:
// asynchronous requests, commit when no request is pending, all-or-nothing
// on abort, and a storage quota that fails the commit.
import { describe, expect, it } from "vitest";
import type { FileRevision } from "../../shared/workspace-files";
import { documentKey, type DocumentIdentity } from "./document-session";
import {
  MARKDOWN_DRAFT_MAX_BYTES,
  MARKDOWN_DRAFT_MAX_COUNT,
  MARKDOWN_DRAFT_OBJECT_STORE,
  createIndexedDbDraftBackend,
  createMarkdownDraftStore,
  createMemoryDraftBackend,
  draftFailureFrom,
  planClearDraft,
  planPreserveDraft,
  type DraftBackend,
  type MarkdownDraftRecord,
} from "./markdown-drafts";

const rev = (name: string) => `rev-${name}-00000000` as FileRevision;
const identity = (path: string, threadId = "thread-1"): DocumentIdentity => ({ scope: { botId: "bot-a", threadId }, relativePath: path });

function record(path: string, over: Partial<MarkdownDraftRecord> = {}): MarkdownDraftRecord {
  const id = identity(path);
  return {
    key: documentKey(id),
    botId: id.scope.botId,
    threadId: id.scope.threadId,
    relativePath: path,
    baseRevision: rev("r0"),
    content: "draft",
    draftRevision: 1,
    bytes: 5,
    updatedAt: 1,
    ...over,
  };
}

describe("bounds", () => {
  it("defaults to 50 drafts and 10 MiB", () => {
    expect(MARKDOWN_DRAFT_MAX_COUNT).toBe(50);
    expect(MARKDOWN_DRAFT_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it("refuses the 51st draft instead of evicting one, but still replaces an existing draft", () => {
    const limits = { maxCount: MARKDOWN_DRAFT_MAX_COUNT, maxBytes: MARKDOWN_DRAFT_MAX_BYTES };
    const fifty = Array.from({ length: 50 }, (_, index) => record(`notes/${index}.md`));
    expect(planPreserveDraft(fifty, record("notes/new.md"), limits)).toEqual({ result: { ok: false, code: "draft-count-exceeded" } });
    const replacement = record("notes/3.md", { content: "newer", draftRevision: 2 });
    expect(planPreserveDraft(fifty, replacement, limits)).toEqual({ put: [replacement], result: { ok: true, record: replacement } });
  });

  it("counts bytes across drafts, net of the draft being replaced", () => {
    const limits = { maxCount: 50, maxBytes: 100 };
    const existing = [record("a.md", { bytes: 60 }), record("b.md", { bytes: 30 })];
    expect(planPreserveDraft(existing, record("c.md", { bytes: 11 }), limits).result).toEqual({ ok: false, code: "draft-bytes-exceeded" });
    expect(planPreserveDraft(existing, record("c.md", { bytes: 10 }), limits).result.ok).toBe(true);
    // Replacing a.md (60) with 70 bytes totals 100: allowed.
    expect(planPreserveDraft(existing, record("a.md", { bytes: 70 }), limits).result.ok).toBe(true);
    expect(planPreserveDraft(existing, record("a.md", { bytes: 71 }), limits).result).toEqual({ ok: false, code: "draft-bytes-exceeded" });
  });

  it("clears only drafts up to the acknowledged draft revision", () => {
    const existing = [record("a.md", { draftRevision: 4 })];
    const key = existing[0]!.key;
    expect(planClearDraft(existing, key, { upToDraftRevision: 3 })).toEqual({ result: { ok: true, cleared: false } });
    expect(planClearDraft(existing, key, { upToDraftRevision: 4 })).toEqual({ delete: [key], result: { ok: true, cleared: true } });
    expect(planClearDraft(existing, key)).toEqual({ delete: [key], result: { ok: true, cleared: true } });
    expect(planClearDraft(existing, "missing")).toEqual({ result: { ok: true, cleared: false } });
  });

  it("maps storage errors to visible failures", () => {
    expect(draftFailureFrom(new DOMException("full", "QuotaExceededError"))).toEqual({ ok: false, code: "storage-quota", message: "full" });
    expect(draftFailureFrom({ name: "NS_ERROR_DOM_QUOTA_REACHED" })).toEqual({ ok: false, code: "storage-quota" });
    expect(draftFailureFrom(new Error("gone"))).toEqual({ ok: false, code: "storage-unavailable", message: "gone" });
  });
});

describe("draft store", () => {
  it("preserves, loads, lists and clears drafts keyed by scope and relative path", async () => {
    const backend = createMemoryDraftBackend();
    let clock = 10;
    const store = createMarkdownDraftStore(backend, { now: () => clock++ });
    const report = identity("outputs/report.md");
    const sameNameOtherTask = identity("outputs/report.md", "thread-2");
    const saved = await store.preserve(report, { baseRevision: rev("r0"), content: "héllo", draftRevision: 3, mode: "rich" });
    expect(saved).toEqual({
      ok: true,
      record: { key: documentKey(report), botId: "bot-a", threadId: "thread-1", relativePath: "outputs/report.md", baseRevision: rev("r0"), content: "héllo", draftRevision: 3, mode: "rich", bytes: 6, updatedAt: 10 },
    });
    await store.preserve(sameNameOtherTask, { baseRevision: rev("r9"), content: "other", draftRevision: 1 });
    expect(await store.load(report)).toMatchObject({ ok: true, record: { content: "héllo", threadId: "thread-1" } });
    expect(await store.load(identity("missing.md"))).toEqual({ ok: true, record: null });
    expect(await store.list()).toMatchObject({ ok: true, bytes: 11, records: [{ threadId: "thread-2" }, { threadId: "thread-1" }] });
    expect(await store.clear(report, { upToDraftRevision: 2 })).toEqual({ ok: true, cleared: false });
    expect(await store.clear(report, { upToDraftRevision: 3 })).toEqual({ ok: true, cleared: true });
    expect(backend.records().map(item => item.threadId)).toEqual(["thread-2"]);
  });

  it("reports a bound refusal without touching the stored drafts", async () => {
    const backend = createMemoryDraftBackend();
    const store = createMarkdownDraftStore(backend, { maxCount: 1, maxBytes: 8 });
    expect((await store.preserve(identity("a.md"), { baseRevision: rev("r0"), content: "12345678", draftRevision: 1 })).ok).toBe(true);
    expect(await store.preserve(identity("b.md"), { baseRevision: rev("r0"), content: "x", draftRevision: 1 })).toEqual({ ok: false, code: "draft-count-exceeded" });
    expect(await store.preserve(identity("a.md"), { baseRevision: rev("r0"), content: "123456789", draftRevision: 2 })).toEqual({ ok: false, code: "draft-bytes-exceeded" });
    expect(backend.records()).toMatchObject([{ relativePath: "a.md", content: "12345678", draftRevision: 1 }]);
  });

  it("applies operations in request order even when the backend is slow", async () => {
    const memory = createMemoryDraftBackend();
    const delays = [30, 0];
    const slow: DraftBackend = {
      async transact(plan, options) {
        await new Promise(resolve => setTimeout(resolve, delays.shift() ?? 0));
        return memory.transact(plan, options);
      },
    };
    const store = createMarkdownDraftStore(slow);
    const preserving = store.preserve(identity("a.md"), { baseRevision: rev("r0"), content: "draft", draftRevision: 1 });
    const clearing = store.clear(identity("a.md"));
    expect(await clearing).toEqual({ ok: true, cleared: true });
    expect((await preserving).ok).toBe(true);
    expect(memory.records()).toEqual([]);
  });

  it("keeps working after a failed operation", async () => {
    const memory = createMemoryDraftBackend();
    let failNext = true;
    const flaky: DraftBackend = {
      async transact(plan, options) {
        if (failNext) {
          failNext = false;
          throw new DOMException("quota", "QuotaExceededError");
        }
        return memory.transact(plan, options);
      },
    };
    const store = createMarkdownDraftStore(flaky);
    expect(await store.preserve(identity("a.md"), { baseRevision: rev("r0"), content: "one", draftRevision: 1 })).toEqual({ ok: false, code: "storage-quota", message: "quota" });
    expect((await store.preserve(identity("a.md"), { baseRevision: rev("r0"), content: "two", draftRevision: 2 })).ok).toBe(true);
  });
});

// ---- minimal IndexedDB fake -------------------------------------------------

class FakeRequest<T> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
}

function fakeIndexedDb(options: { quotaBytes?: number; failOpen?: boolean } = {}) {
  const stores = new Map<string, Map<string, unknown>>();
  let version = 0;
  let opens = 0;
  const size = (data: Map<string, unknown>) => [...data.values()].reduce<number>((total, value) => total + JSON.stringify(value).length, 0);
  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore(name: string) {
      stores.set(name, new Map());
    },
    close() {},
    onversionchange: null as (() => void) | null,
    transaction(name: string, mode: IDBTransactionMode) {
      const committed = stores.get(name);
      if (!committed) throw new DOMException("no store", "NotFoundError");
      const working = new Map(committed);
      let pending = 0;
      let finished = false;
      const tx = {
        error: null as DOMException | null,
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
        aborted: false,
        abort() {
          if (finished) throw new DOMException("finished", "InvalidStateError");
          tx.aborted = true;
          finished = true;
          setTimeout(() => tx.onabort?.(), 0);
        },
        objectStore: () => store,
      };
      const finish = () => {
        if (pending || finished) return;
        finished = true;
        if (options.quotaBytes !== undefined && size(working) > options.quotaBytes) {
          tx.error = new DOMException("The quota has been exceeded.", "QuotaExceededError");
          tx.onerror?.();
          tx.onabort?.();
          return;
        }
        stores.set(name, working);
        tx.oncomplete?.();
      };
      const schedule = (work: () => void) => {
        pending += 1;
        setTimeout(() => {
          pending -= 1;
          if (!tx.aborted) work();
          finish();
        }, 0);
      };
      const writable = () => {
        if (mode !== "readwrite") throw new DOMException("read only", "ReadOnlyError");
      };
      const store = {
        getAll() {
          const request = new FakeRequest<unknown[]>();
          schedule(() => {
            request.result = [...working.values()].map(value => structuredClone(value));
            request.onsuccess?.();
          });
          return request;
        },
        put(value: { key: string }) {
          writable();
          const request = new FakeRequest<string>();
          schedule(() => {
            working.set(value.key, structuredClone(value));
            request.onsuccess?.();
          });
          return request;
        },
        delete(key: string) {
          writable();
          const request = new FakeRequest<undefined>();
          schedule(() => {
            working.delete(key);
            request.onsuccess?.();
          });
          return request;
        },
      };
      return tx;
    },
  };
  const factory = {
    open(_name: string, requested: number) {
      opens += 1;
      const request = new FakeRequest<typeof db>();
      setTimeout(() => {
        if (options.failOpen) {
          request.error = new DOMException("denied", "UnknownError");
          request.onerror?.();
          return;
        }
        request.result = db;
        if (requested > version) {
          version = requested;
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
  return { factory: factory as unknown as IDBFactory, stores, opens: () => opens };
}

describe("IndexedDB backend", () => {
  it("creates the object store once and round-trips drafts through real transactions", async () => {
    const fake = fakeIndexedDb();
    const store = createMarkdownDraftStore(createIndexedDbDraftBackend(fake.factory, "test-drafts"));
    expect((await store.preserve(identity("a.md"), { baseRevision: rev("r0"), content: "draft a", draftRevision: 1 })).ok).toBe(true);
    expect((await store.preserve(identity("b.md"), { baseRevision: rev("r0"), content: "draft b", draftRevision: 1 })).ok).toBe(true);
    expect(await store.load(identity("a.md"))).toMatchObject({ ok: true, record: { content: "draft a" } });
    expect(await store.clear(identity("a.md"))).toEqual({ ok: true, cleared: true });
    expect(await store.list()).toMatchObject({ ok: true, records: [{ relativePath: "b.md" }] });
    expect([...fake.stores.keys()]).toEqual([MARKDOWN_DRAFT_OBJECT_STORE]);
    expect(fake.opens()).toBe(1);
  });

  it("surfaces a storage quota failure and commits nothing from that transaction", async () => {
    const fake = fakeIndexedDb({ quotaBytes: 400 });
    const store = createMarkdownDraftStore(createIndexedDbDraftBackend(fake.factory));
    expect((await store.preserve(identity("a.md"), { baseRevision: rev("r0"), content: "small", draftRevision: 1 })).ok).toBe(true);
    const refused = await store.preserve(identity("a.md"), { baseRevision: rev("r0"), content: "x".repeat(1_000), draftRevision: 2 });
    expect(refused).toMatchObject({ ok: false, code: "storage-quota" });
    // The earlier draft is intact: the failed transaction was all-or-nothing.
    expect(await store.load(identity("a.md"))).toMatchObject({ ok: true, record: { content: "small", draftRevision: 1 } });
  });

  it("enforces the draft bounds inside the transaction", async () => {
    const fake = fakeIndexedDb();
    const store = createMarkdownDraftStore(createIndexedDbDraftBackend(fake.factory), { maxCount: 1 });
    expect((await store.preserve(identity("a.md"), { baseRevision: rev("r0"), content: "a", draftRevision: 1 })).ok).toBe(true);
    expect(await store.preserve(identity("b.md"), { baseRevision: rev("r0"), content: "b", draftRevision: 1 })).toEqual({ ok: false, code: "draft-count-exceeded" });
    expect([...fake.stores.get(MARKDOWN_DRAFT_OBJECT_STORE)!.keys()]).toEqual([documentKey(identity("a.md"))]);
  });

  it("fails visibly without IndexedDB or when it cannot open, and retries the open later", async () => {
    const missing = createMarkdownDraftStore(createIndexedDbDraftBackend(undefined));
    expect(await missing.preserve(identity("a.md"), { baseRevision: rev("r0"), content: "a", draftRevision: 1 })).toMatchObject({ ok: false, code: "storage-unavailable" });
    expect(await missing.load(identity("a.md"))).toMatchObject({ ok: false, code: "storage-unavailable" });

    const denied = fakeIndexedDb({ failOpen: true });
    const store = createMarkdownDraftStore(createIndexedDbDraftBackend(denied.factory));
    expect(await store.list()).toMatchObject({ ok: false, code: "storage-unavailable" });
    expect(await store.list()).toMatchObject({ ok: false, code: "storage-unavailable" });
    expect(denied.opens()).toBe(2);
  });

  it("rejects a read-only plan that tries to write", async () => {
    const fake = fakeIndexedDb();
    const backend = createIndexedDbDraftBackend(fake.factory);
    await expect(backend.transact(() => ({ put: [record("a.md")], result: null }), { write: false })).rejects.toThrow("read-only");
    expect(fake.stores.get(MARKDOWN_DRAFT_OBJECT_STORE)!.size).toBe(0);
  });
});
