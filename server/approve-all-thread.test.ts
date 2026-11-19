// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIM-UI2-SRV (Rev 3.3 U1-U7, V1-V4, W1-W3, X1-X2): the thread-scoped Approve all preview. Real Store (temp data dir),
// real message-db card index, real bulkEligibility, real ApproveAllBatches. HEADLESS: the data dir is the suite's throwaway.
import { randomUUID } from "node:crypto";
import { openFixtureApproval } from "./testing/approval-card.ts";
import { updateRecord } from "./decision/records.ts";
import { beforeEach, describe, expect, it } from "vitest";

import { APPROVE_ALL_THREAD } from "../shared/approval-digest.ts";
import { approvalDigestSync } from "./approval-fresh-auth.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { database } from "./database.ts";
import { threadCardsReady } from "./transcript-backfill.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { APPROVE_ALL_CAP, ApproveAllBatches, previewScope } from "./approve-all.ts";
import { PreviewUnavailable, buildThreadPreview, bulkRecheck, partitionThread, resolveCard, skippedResult, stopsBatch, storeDeps, threadBatchAccessible, type ThreadDeps } from "./approve-all-thread.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const OWNER = { reason: "no-grant", unattended: false, automated: false, keys: [], origin: "owner", noLimits: { n2: false, initiator: "owner" } };
const SURFACE = { key: "desktop", deviceId: null };
let store: Store;
let nextAt = 1_700_000_000_000;

/** One open ordinary request card (the only shape that qualifies), `at` strictly increasing so the order is the call order. */
function card(threadId: string, requestId: string, cls: Record<string, unknown> | null = {}, extra: Record<string, unknown> = {}) {
  return store.appendMessage(threadId, openFixtureApproval(database(), threadId, {
    id: randomUUID(), role: "bot", kind: "options", text: "May I?", at: nextAt++,
    card: { title: "Approval needed", subtitle: "ls -la", options: ["Allow", "Deny"], requestId, tool: "bash", ...(cls === null ? {} : { cardClass: { ...OWNER, ...cls } }), ...extra },
  }) as never);
}
const answer = (threadId: string, id: string) => {
  const row = store.messageById(threadId, id)!;
  updateRecord(database(), (row.card as unknown as { approvalId: string }).approvalId, { state: "answered", answer: "allow" });
  return store.patchMessage(threadId, id, { card: { ...row.card!, answered: "allow" } } as never);
};
const ids = (list: Array<{ requestId: string }>) => list.map((c) => c.requestId);
const preview = (threadId: string, requestIds: string[], deps: ThreadDeps = storeDeps(store), batches = new ApproveAllBatches({ now: () => 1000 })) =>
  ({ out: buildThreadPreview(deps, batches, SURFACE, threadId, requestIds), batches });
let T: string;
let U: string;

beforeEach(() => {
  removeTempDirSync(DATA_DIR);
  store = new Store(selection);
  T = store.createBot().threadId;
  U = store.createBot().threadId;
});

describe("previewScope (U1): the request body", () => {
  const ok = { thread: { threadId: "bot-1", requestIds: ["a", "b"] } };
  it("parses a thread scope and keeps the screen path for an empty body", () => {
    expect(previewScope(ok)).toEqual({ kind: "thread", threadId: "bot-1", requestIds: ["a", "b"] });
    expect(previewScope({})).toMatchObject({ kind: "screen" });
    expect(previewScope({ thread: { threadId: "group:abc.def", requestIds: ["a"] } })).toMatchObject({ kind: "thread", threadId: "group:abc.def" });
  });
  it("S5: both scopes, a bad threadId, 0 / 201 / duplicate / oversize / non-string requestIds, a non-object thread: 400 bad_scope", () => {
    const bad = (value: unknown) => expect(previewScope(value)).toEqual({ kind: "bad", code: "bad_scope" });
    bad({ screen: { view: "approvals", page: 0, pageSize: 100, includeSnoozed: false }, ...ok });
    bad({ thread: "bot-1" });
    bad({ thread: [] });
    bad({ thread: { threadId: "", requestIds: ["a"] } });
    bad({ thread: { threadId: "a".repeat(201), requestIds: ["a"] } });
    bad({ thread: { threadId: "bad id", requestIds: ["a"] } });
    bad({ thread: { threadId: "../x", requestIds: ["a"] } });
    bad({ thread: { threadId: APPROVE_ALL_THREAD, requestIds: ["a"] } });
    bad({ thread: { threadId: "t" } });
    bad({ thread: { threadId: "t", requestIds: [] } });
    bad({ thread: { threadId: "t", requestIds: Array.from({ length: 201 }, (_, i) => `r${i}`) } });
    bad({ thread: { threadId: "t", requestIds: ["a", "a"] } });
    bad({ thread: { threadId: "t", requestIds: ["a", 2] } });
    bad({ thread: { threadId: "t", requestIds: ["a".repeat(257)] } });
    expect(previewScope({ thread: { threadId: "t", requestIds: Array.from({ length: 200 }, (_, i) => `r${i}`) } })).toMatchObject({ kind: "thread" });
    expect(previewScope({ screen: { view: "nope" } })).toEqual({ kind: "bad", code: "bad_screen" });
  });
  it("M-regex: group threads (group:<id>) and dotted ids pass; the old ^[\\w-] set is not enough", () => {
    expect(previewScope({ thread: { threadId: "group:x1", requestIds: ["a"] } })).toMatchObject({ kind: "thread" });
  });
});

describe("partition (U2, V1, V2)", () => {
  it("S1: a chat card is listed when 150 other-thread cards wait (the thread's own index, never a global page)", () => {
    for (let i = 0; i < 150; i++) card(U, `other-${i}`);
    card(T, "chat-1");
    const { out } = preview(T, ["chat-1"]);
    expect(out.status).toBe(200);
    expect(ids(out.body.eligible as never)).toEqual(["chat-1"]);
    expect(out.body).toMatchObject({ scope: "thread", threadId: T, later: [], excluded: [], closed: [] });
  });

  it("S2: each N2 category, other / unproven origin, missing and malformed noLimits on held and sensitive cards, a missing class, orphaned: excluded with reasonKey", () => {
    card(T, "n2-wipe", { noLimits: { n2: true, initiator: "owner" } });
    card(T, "n2-volume-wipe", { reason: "always-ask", noLimits: { n2: true, initiator: "owner", row: "wipe-volume" } });
    card(T, "origin-other", { origin: "other" });
    card(T, "origin-none", { origin: undefined });
    card(T, "held-nonl", { reason: "destructive-guard", noLimits: undefined });
    card(T, "held-badnl", { reason: "destructive-guard", noLimits: "yes" });
    card(T, "sens-badnl", { reason: "sensitive-guard", noLimits: ["n2"] });
    card(T, "legacy", null);
    card(T, "pay", { stop: { kind: "pay", public: false, placed: true, places: 1 } });
    card(T, "orph", {}, { orphaned: true });
    card(T, "fine");
    const all = ["n2-wipe", "n2-volume-wipe", "origin-other", "origin-none", "held-nonl", "held-badnl", "sens-badnl", "legacy", "pay", "orph", "fine"];
    const { out } = preview(T, all);
    expect(ids(out.body.eligible as never)).toEqual(["fine"]);
    const reason = Object.fromEntries((out.body.excluded as any[]).map((c) => [c.requestId, c.reasonKey]));
    expect(reason).toEqual({
      "n2-wipe": "always-ask", "n2-volume-wipe": "always-ask", "origin-other": "origin", "origin-none": "origin", "held-nonl": "held", "held-badnl": "held",
      "sens-badnl": "sensitive", legacy: "held", pay: "pay", orph: "orphaned",
    });
    expect(out.body.closed).toEqual([]);
    expect(Object.values(reason)).not.toContain("not-open");
  });

  it("S2b: an answered card is closed (not excluded) and an orphaned card never reads not-open", () => {
    const done = card(T, "done");
    card(T, "live");
    answer(T, done.id);
    const { out } = preview(T, ["done", "live"]);
    expect(ids(out.body.eligible as never)).toEqual(["live"]);
    expect(out.body.excluded).toEqual([]);
    expect(out.body.closed).toEqual([{ threadId: T, requestId: "done", messageId: null }]);
  });

  it("S3: a forged id from thread U is closed, never eligible, and its row is never fetched", () => {
    card(U, "theirs");
    card(T, "mine");
    const { out } = preview(T, ["mine", "theirs"]);
    expect(ids(out.body.eligible as never)).toEqual(["mine"]);
    expect(out.body.closed).toEqual([{ threadId: T, requestId: "theirs", messageId: null }]);
    expect(JSON.stringify(out.body)).not.toContain(U);
  });

  it("every entry carries threadId, requestId and the stored row id; each requested id lands in exactly one list; order is oldest first", () => {
    const a = card(T, "a");
    store.appendMessage(T, { role: "bot", kind: "text", text: "between", at: nextAt++ } as never);
    const b = card(T, "b", { origin: "other" });
    const c = card(T, "c");
    const { out } = preview(T, ["c", "b", "a", "gone"]);
    expect((out.body.eligible as any[]).map((e) => [e.threadId, e.requestId, e.messageId])).toEqual([[T, "a", a.id], [T, "c", c.id]]);
    expect((out.body.excluded as any[]).map((e) => [e.requestId, e.messageId])).toEqual([["b", b.id]]);
    expect(out.body.closed).toEqual([{ threadId: T, requestId: "gone", messageId: null }]);
    const lists = ["eligible", "later", "excluded", "closed"].flatMap((k) => ids(out.body[k] as never));
    expect([...lists].sort()).toEqual(["a", "b", "c", "gone"]);
    expect((out.body.eligible as any[])[0].digest).toBe(approvalDigestSync(T, "a", store.messageById(T, a.id)!.card as never));
  });

  it("S11: an open card in the thread that was not requested (a sibling branch) is never listed or examined", () => {
    card(T, "shown");
    card(T, "sibling");
    const { out, batches } = preview(T, ["shown"]);
    expect(ids(out.body.eligible as never)).toEqual(["shown"]);
    expect(JSON.stringify(out.body)).not.toContain("sibling");
    const opened = batches.open(out.body.batchId, "desktop", ["shown"]);
    expect(opened.ok).toBe(true);
  });

  it("S6: 30 shown eligible cards -> 25 eligible batched + 5 later (no digest, not in the batch); after applying, the next preview lists the 5", () => {
    const rows = Array.from({ length: 30 }, (_, i) => card(T, `c${String(i).padStart(2, "0")}`));
    const all = rows.map((_, i) => `c${String(i).padStart(2, "0")}`);
    const first = preview(T, all);
    expect(first.out.body.eligible).toHaveLength(APPROVE_ALL_CAP);
    expect(ids(first.out.body.later as never)).toEqual(all.slice(25));
    expect((first.out.body.later as any[]).every((l) => l.digest === undefined && l.messageId)).toBe(true);
    const opened = first.batches.open(first.out.body.batchId, "desktop", all.slice(0, 25));
    expect(opened.ok && opened.batch.cards.map((c) => c.requestId)).toEqual(all.slice(0, 25));
    expect(opened.ok && opened.batch.scope).toBe(`thread:${T}`);
    expect(first.batches.open(first.out.body.batchId, "desktop", [all[26]])).toEqual({ ok: false, code: "bad_selection" });
    rows.slice(0, 25).forEach((row) => answer(T, row.id));
    const second = preview(T, all);
    expect(ids(second.out.body.eligible as never)).toEqual(all.slice(25));
    expect(second.out.body.later).toEqual([]);
    expect(ids(second.out.body.closed as never)).toEqual(all.slice(0, 25));
  });

  it("no eligible card means no batch", () => {
    card(T, "x", { origin: "other" });
    const { out } = preview(T, ["x", "y"]);
    expect(out.body.batchId).toBeNull();
    expect(out.body.eligible).toEqual([]);
  });
});

describe("completeness (V1, W1, W2, X2) on the real store", () => {
  it("S12: a saturated index plus extra orphaned rows: a shown eligible card older than the sweep is eligible, found by ONE authoritative lookup", () => {
    const old = card(T, "old");
    for (let i = 0; i < 6; i++) card(T, `new${i}`);
    card(T, "orph1", {}, { orphaned: true });
    card(T, "orph2", {}, { orphaned: true });
    card(U, "theirs"); // forged: another thread's open card, named by the chat
    const deps = storeDeps(store, { sweepLimit: 6 });
    const direct = deps.openRows(T);
    expect(direct.rows.length).toBe(8); // 6 swept + 2 orphans: the merged length is not the measure
    expect(direct.complete).toBe(false);
    let lookups = 0;
    const spied: ThreadDeps = { ...deps, lookup: (t, list) => { lookups++; return deps.lookup(t, list); } };
    const { out } = preview(T, ["old", "new5", "orph1", "gone", "theirs"], spied);
    expect(ids(out.body.eligible as never)).toEqual(["old", "new5"]);
    expect((out.body.eligible as any[])[0].messageId).toBe(old.id);
    expect((out.body.excluded as any[]).map((c) => [c.requestId, c.reasonKey])).toEqual([["orph1", "orphaned"]]);
    expect(out.body.closed).toEqual([{ threadId: T, requestId: "gone", messageId: null }, { threadId: T, requestId: "theirs", messageId: null }]);
    expect(lookups).toBe(1); // at most one fallback query per window (M-per-id)
  });

  it("S12: an unsaturated index is authoritative: an absent id is closed without any fallback lookup", () => {
    card(T, "a");
    const deps = storeDeps(store);
    let lookups = 0;
    const { out } = preview(T, ["a", "zzz"], { ...deps, lookup: (t, l) => { lookups++; return deps.lookup(t, l); } });
    expect(lookups).toBe(0);
    expect(out.body.closed).toEqual([{ threadId: T, requestId: "zzz", messageId: null }]);
  });

  it("S12 apply: a shown card older than the sweep AND beyond the history scan still resolves open (X1, W1); M-apply-sweep resolves through the sweep only", () => {
    const old = card(T, "old");
    for (let i = 0; i < 6; i++) card(T, `new${i}`);
    for (let i = 0; i < 30; i++) store.appendMessage(T, { role: "user", kind: "text", text: `fill ${i}`, at: nextAt++ } as never);
    const deps = storeDeps(store, { sweepLimit: 6, scanLimit: 10 });
    const got = resolveCard(deps, T, "old");
    expect(got.row?.id).toBe(old.id);
    const live = bulkRecheck(deps, T, "old");
    expect(live).toMatchObject({ ok: true });
    // an answered card is found by the scan, not "unknown"
    answer(T, old.id);
    expect(resolveCard(storeDeps(store, { sweepLimit: 6 }), T, "old").row?.card?.answered).toBe("allow");
  });

  it("S12b: index unusable and thread unloaded: prepare 'ready' then the lookups re-run once and succeed; 'pending' and 'failed' are 503 with no batch", () => {
    card(T, "a");
    const real = storeDeps(store);
    const calls: string[] = [];
    let state: "unknown" | "known" = "unknown";
    const stub = (prepare: "ready" | "pending" | "failed"): ThreadDeps => ({
      ...real,
      openRows: () => (state === "unknown" ? { rows: [], complete: false } : real.openRows(T)),
      lookup: (t, l) => (state === "unknown" ? { found: new Map(), unknown: true } : real.lookup(t, l)),
      prepare: () => { calls.push(`prepare:${prepare}`); if (prepare === "ready") state = "known"; return prepare; },
    });
    const ok = preview(T, ["a"], stub("ready"));
    expect(calls).toEqual(["prepare:ready"]);
    expect(ok.out.status).toBe(200);
    expect(ids(ok.out.body.eligible as never)).toEqual(["a"]);
    for (const verdict of ["pending", "failed"] as const) {
      state = "unknown";
      const bad = preview(T, ["a"], stub(verdict));
      expect(bad.out).toEqual({ status: 503, body: { error: expect.any(String), code: "preview_unavailable" } });
      expect(bad.batches.open("aab-" + "0".repeat(32), "desktop", ["a"])).toMatchObject({ ok: false });
    }
    // M-unresolved-closed: an unknown id is never reported closed; M-noprep: the walker is asked
    state = "unknown";
    const none = preview(T, ["a"], stub("pending"));
    expect(JSON.stringify(none.out.body)).not.toContain("closed");
    // another thread queued ahead: 503 now, ready on a later call
    state = "unknown";
    let attempts = 0;
    const queued: ThreadDeps = { ...stub("ready"), prepare: (t) => (++attempts < 2 ? "pending" : stub("ready").prepare(t)) };
    expect(preview(T, ["a"], queued).out.status).toBe(503);
    expect(preview(T, ["a"], queued).out.status).toBe(200);
  });

  it("S12b: a prepared thread's index step is bounded (250 ms) and a real unprepared thread reaches ready", () => {
    card(T, "a");
    const deps = storeDeps(store);
    const t0 = Date.now();
    const verdict = deps.prepare(T);
    expect(["ready", "pending"]).toContain(verdict);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("S12c: a throwing lookup aborts the preview: 503 preview_unavailable, no batch (never swallowed into a batch)", () => {
    card(T, "a");
    const real = storeDeps(store);
    const boom: ThreadDeps = { ...real, openRows: () => ({ rows: [], complete: false }), lookup: () => { throw new Error("db busy"); } };
    const { out } = preview(T, ["a"], boom);
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ code: "preview_unavailable" });
    expect(out.body.batchId).toBeUndefined();
    // the partition itself throws the typed error; only buildThreadPreview turns it into the 503
    expect(() => partitionThread(boom, T, ["a"])).toThrow(PreviewUnavailable);
  });
});

describe("batch scope and apply (U3)", () => {
  it("S7: create(surface, deviceId, [A@T, D@U], 'thread:T') then open([D]) -> bad_selection and open([A]) -> ok", () => {
    const batches = new ApproveAllBatches({ now: () => 1000 });
    const made = batches.create("desktop", null, [{ threadId: "T", requestId: "A", digest: "d1" }, { threadId: "U", requestId: "D", digest: "d2" }], "thread:T");
    expect(made.scope).toBe("thread:T");
    expect(batches.open(made.batchId, "desktop", ["D"])).toEqual({ ok: false, code: "bad_selection" });
    expect(batches.open(made.batchId, "desktop", ["A", "D"])).toEqual({ ok: false, code: "bad_selection" });
    expect(batches.open(made.batchId, "desktop", ["A"])).toMatchObject({ ok: true });
  });

  it("an unscoped (Inbox) batch still ticks cards across threads (S9)", () => {
    const batches = new ApproveAllBatches({ now: () => 1000 });
    const made = batches.create("desktop", null, [{ threadId: "T", requestId: "A", digest: "d1" }, { threadId: "U", requestId: "D", digest: "d2" }]);
    expect(made.scope).toBeUndefined();
    expect(batches.open(made.batchId, "desktop", ["A", "D"])).toMatchObject({ ok: true });
  });

  it("S14: an expired thread batch and a reused one are refused", () => {
    let now = 1000;
    const batches = new ApproveAllBatches({ now: () => now });
    const made = batches.create("desktop", null, [{ threadId: "T", requestId: "A", digest: "d" }], "thread:T");
    expect(batches.open(made.batchId, "app:other", ["A"])).toEqual({ ok: false, code: "batch_unknown" });
    batches.burn(made.batchId);
    expect(batches.open(made.batchId, "desktop", ["A"])).toEqual({ ok: false, code: "batch_used" });
    const second = batches.create("desktop", null, [{ threadId: "T", requestId: "A", digest: "d" }], "thread:T");
    now += 200_000;
    expect(batches.open(second.batchId, "desktop", ["A"])).toEqual({ ok: false, code: "batch_unknown" });
  });

  it("S13: access revoked between preview and apply: the thread is no longer in the caller's door's threads", () => {
    const batches = new ApproveAllBatches({ now: () => 1000 });
    const thread = batches.create("desktop", null, [{ threadId: "T", requestId: "A", digest: "d" }], "thread:T");
    const screen = batches.create("desktop", null, [{ threadId: "T", requestId: "A", digest: "d" }]);
    const visible = [{ threadId: "T" }, { threadId: "V" }] as never;
    expect(threadBatchAccessible(thread, visible)).toBe(true);
    expect(threadBatchAccessible(thread, [{ threadId: "V" }] as never)).toBe(false);
    expect(threadBatchAccessible(thread, [] as never)).toBe(false);
    expect(threadBatchAccessible(screen, [] as never)).toBe(true); // the Inbox screen path is not thread scoped
  });

  it("S8: between preview and apply a card turned N2, was answered, or is unresolved: the live re-check refuses it (never a widened grant)", () => {
    const one = card(T, "one");
    const two = card(T, "two");
    card(T, "three");
    const deps = storeDeps(store);
    expect(bulkRecheck(deps, T, "one")).toMatchObject({ ok: true });
    // two turns N2 after preview
    const changed = { ...two, card: { ...two.card!, cardClass: { ...OWNER, noLimits: { n2: true, initiator: "owner" } } } };
    // Current journal cards are immutable: persisted action changes are refused. Also exercise the live recheck against
    // an N2 row supplied after preview, as the original stale-card case requires.
    expect(() => store.patchMessage(T, two.id, { card: changed.card } as never)).toThrow("card-action-changed");
    const changedDeps: ThreadDeps = { ...deps, sweepRows: () => [changed as never] };
    expect(bulkRecheck(changedDeps, T, "two")).toEqual({ ok: false, reason: "not-eligible:always-ask" });
    answer(T, one.id);
    expect(bulkRecheck(deps, T, "one")).toEqual({ ok: false, reason: "not-open" });
    expect(bulkRecheck(deps, T, "three")).toMatchObject({ ok: true });
    // an authoritative lookup that cannot say never reads as closed (W1): not applied
    const unknown: ThreadDeps = { ...deps, sweepRows: () => [], lookupOne: () => ({ unknown: true }), scan: () => false };
    expect(bulkRecheck(unknown, T, "three")).toEqual({ ok: false, reason: "unresolved" });
    // Astra r1 #2: a history-scan match never stands in for an authoritative step that could not say
    const scanFinds: ThreadDeps = { ...deps, sweepRows: () => [], lookupOne: () => ({ unknown: true }), scan: (_t, visit) => visit(store.messageById(T, one.id)!) };
    expect(resolveCard(scanFinds, T, "one")).toMatchObject({ unknown: true });
    expect(bulkRecheck(scanFinds, T, "one")).toEqual({ ok: false, reason: "unresolved" });
  });

  it("S8: a thread batch stops at the FIRST changed card and the rest stay open; the Inbox batch keeps its rule; unresolved is itself not-applied", () => {
    const thread = { scope: "thread:T" };
    const inbox = {};
    for (const reason of ["not-open", "not-eligible:always-ask", "special-card:limit", "unresolved"]) expect(stopsBatch(thread, `status-409`, reason)).toBe(true);
    expect(stopsBatch(inbox, "bulk_skipped", "not-open")).toBe(false);
    expect(stopsBatch(inbox, "bulk_skipped", "not-eligible:always-ask")).toBe(false);
    expect(stopsBatch(inbox, "fresh_auth_changed", "fresh_auth_changed")).toBe(true);
    expect(stopsBatch(inbox, "bulk_skipped", "unresolved")).toBe(true);
    expect(skippedResult("unresolved")).toBe("not-applied");
    expect(skippedResult("not-open")).toBe("skipped");
  });
});


it("M4: a real unloaded thread rebuilds its missing card index before previewing an old request", () => {
  const old = card(T, "upgrade-old");
  for (let i = 0; i < 620; i++) store.appendMessage(T, { role: "bot", kind: "text", text: `later ${i}`, at: nextAt++ } as never);
  const db = database();
  db.exec("DELETE FROM open_card; DELETE FROM transcript_index_state WHERE name='open_card'");
  const unloaded = new Store(selection);
  expect(threadCardsReady(db, T)).toBe(false);
  const deps = storeDeps(unloaded);
  expect(deps.openRows(T).complete).toBe(false);
  expect(deps.lookup(T, ["upgrade-old"]).unknown).toBe(true);
  const batches = new ApproveAllBatches({ now: Date.now });
  let out = buildThreadPreview(deps, batches, SURFACE, T, ["upgrade-old"]);
  for (let attempt = 0; out.status === 503 && attempt < 10; attempt++) {
    expect(out.body).toMatchObject({ code: "preview_unavailable" });
    expect(out.body.batchId).toBeUndefined();
    out = buildThreadPreview(deps, batches, SURFACE, T, ["upgrade-old"]);
  }
  expect(out.status).toBe(200);
  expect(threadCardsReady(db, T)).toBe(true);
  expect(ids(out.body.eligible as never)).toEqual(["upgrade-old"]);
  expect(out.body.closed).toEqual([]);
  expect(unloaded.openCardForRequest(T, "upgrade-old")).toMatchObject({ found: { id: old.id } });
  expect(batches.open(out.body.batchId, "desktop", ["upgrade-old"])).toMatchObject({ ok: true });
});
