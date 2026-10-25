import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { busyRetriesFor, busyRetryDelayMs, createOutbox, deliverEdit, EDIT_DEADLINE_MS, createSendDelivery, isBusyRefusal, isDatabaseBusyAnswer, isDefinitiveFailure, retryWhileBusy, MAX_OUTBOX_ENTRIES, OUTBOX_GIVE_UP_MS, type OutboxEntry } from "./send-delivery";

/** localStorage stand-in that outlives a simulated renderer reload. */
function fakeStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const entry = (sendId: string, over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  sendId, kind: "bot", botId: "b1", threadId: "t1", text: `words ${sendId}`, at: 1_000, attempts: 0,
  draft: { draftId: "bot:b1:t1", attemptId: `a-${sendId}`, text: `words ${sendId}`, requestText: `words ${sendId}`, attachments: [] },
  ...over,
});

/** One "renderer": a delivery over the shared storage, with a recording of what it did. */
function renderer(storage: ReturnType<typeof fakeStorage>, post: (e: OutboxEntry) => Promise<any>, clock = { now: 2_000 }) {
  const log = { sending: [] as string[], settled: [] as string[], receipts: [] as string[], recovered: [] as string[], timers: [] as Array<() => void> };
  const delivery = createSendDelivery({
    outbox: createOutbox(storage),
    post,
    now: () => clock.now,
    setTimer: (fn) => { log.timers.push(fn); return 0; },
    showSending: (e) => log.sending.push(e.sendId),
    settleSending: (e) => log.settled.push(e.sendId),
    receipt: (e) => log.receipts.push(e.sendId),
    recover: (e) => log.recovered.push(e.sendId),
  });
  return { delivery, log, outbox: createOutbox(storage), clock };
}

describe("send outbox", () => {
  it("is written before the post starts and before anything else can clear the composer", async () => {
    const storage = fakeStorage();
    let outboxAtPost: string[] = [];
    const r = renderer(storage, async () => { outboxAtPost = createOutbox(storage).list().map((x) => x.sendId); return { ok: true }; });
    await r.delivery.submit(entry("s1"));
    expect(outboxAtPost).toEqual(["s1"]);
    expect(r.log.sending).toEqual(["s1"]);
  });

  it("leaves the outbox only when the server answered", async () => {
    const storage = fakeStorage();
    const r = renderer(storage, async () => ({ ok: true, queued: true, queueId: "q1" }));
    await r.delivery.submit(entry("s1"));
    expect(createOutbox(storage).list()).toEqual([]);
    expect(r.log.receipts).toEqual(["s1"]);
    expect(r.log.settled).toEqual(["s1"]);
  });

  it("a reload in the middle of a send loses nothing: the new renderer re-posts the same sendId and the text is not restored", async () => {
    const storage = fakeStorage();
    // renderer 1: the POST never answers (the page is reloaded while it is out)
    const first = renderer(storage, () => new Promise(() => {}));
    void first.delivery.submit(entry("s9"));
    expect(first.outbox.list()).toHaveLength(1);

    // renderer 2: a new page over the same storage; the server has no record yet
    const posts: string[] = [];
    const second = renderer(storage, async (e) => { posts.push(e.sendId); return { ok: true, steered: true }; });
    second.delivery.reconcile({ messageSendIds: new Set(), pendingSendIds: new Set() });
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toEqual(["s9"]);
    expect(second.log.sending).toEqual(["s9"]);
    expect(second.log.recovered).toEqual([]);
    expect(createOutbox(storage).list()).toEqual([]);
  });

  it("reload plus server restart: the server lost the request, the same sendId is posted again and runs once", async () => {
    const storage = fakeStorage();
    void renderer(storage, () => new Promise(() => {})).delivery.submit(entry("s2"));
    const seen = new Set<string>();
    let ran = 0;
    const serverPost = async (e: OutboxEntry) => { if (!seen.has(e.sendId)) { seen.add(e.sendId); ran++; } return { ok: true }; };
    const second = renderer(storage, serverPost);
    second.delivery.reconcile({ messageSendIds: new Set(), pendingSendIds: new Set() });
    second.delivery.reconcile({ messageSendIds: new Set(), pendingSendIds: new Set() });
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toBe(1);
  });

  it("drops what the server already holds: a message with that sendId, or a queued record", async () => {
    const storage = fakeStorage();
    const seed = createOutbox(storage);
    seed.add(entry("landed"));
    seed.add(entry("queued"));
    seed.add(entry("missing"));
    const post = vi.fn(async () => ({ ok: true }));
    const r = renderer(storage, post);
    r.delivery.reconcile({ messageSendIds: new Set(["landed"]), pendingSendIds: new Set(["queued"]) });
    await new Promise((x) => setTimeout(x, 0));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ sendId: "missing" }), expect.anything());
    expect(r.log.settled.sort()).toEqual(["landed", "missing", "queued"]);
  });

  it("tells the person only on a definitive refusal (an undrafted send; a drafted one keeps its words in its record)", async () => {
    const storage = fakeStorage();
    const refused = renderer(storage, async () => { throw Object.assign(new Error("too big"), { status: 413 }); });
    await refused.delivery.submit(entry("s3", { draft: undefined }));
    expect(refused.log.recovered).toEqual(["s3"]);
    expect(createOutbox(storage).list()).toEqual([]);
  });

  it("a dropped connection or a server error keeps the words, keeps the line on screen and tries again with the same sendId", async () => {
    const storage = fakeStorage();
    const results: Array<Error | object> = [new TypeError("fetch failed"), Object.assign(new Error("boom"), { status: 502 }), { ok: true }];
    const sendIds: string[] = [];
    const r = renderer(storage, async (e) => {
      sendIds.push(e.sendId);
      const next = results.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    await r.delivery.submit(entry("s4"));
    expect(r.log.recovered).toEqual([]);
    expect(createOutbox(storage).list()).toHaveLength(1);
    expect(r.log.settled).toEqual([]);
    r.log.timers.shift()!();
    await new Promise((x) => setTimeout(x, 0));
    r.log.timers.shift()!();
    await new Promise((x) => setTimeout(x, 0));
    expect(sendIds).toEqual(["s4", "s4", "s4"]);
    expect(r.log.receipts).toEqual(["s4"]);
    expect(createOutbox(storage).list()).toEqual([]);
  });

  it("after the give-up window with no answer the words go back to the person (a resend reuses the same sendId)", async () => {
    const storage = fakeStorage();
    const clock = { now: 2_000 };
    const r = renderer(storage, async () => { throw new TypeError("offline"); }, clock);
    await r.delivery.submit(entry("s5", { at: 1_000, draft: undefined }));
    expect(r.log.recovered).toEqual([]);
    clock.now = 1_000 + OUTBOX_GIVE_UP_MS + 1;
    r.log.timers.shift()!();
    await new Promise((x) => setTimeout(x, 0));
    expect(r.log.recovered).toEqual(["s5"]);
    expect(createOutbox(storage).list()).toEqual([]);
  });

  it("classifies refusals: only a meant 4xx is definitive", () => {
    expect(isDefinitiveFailure(Object.assign(new Error(), { status: 409 }))).toBe(true);
    expect(isDefinitiveFailure(Object.assign(new Error(), { status: 413 }))).toBe(true);
    for (const status of [408, 425, 429, 500, 502, 503]) expect(isDefinitiveFailure(Object.assign(new Error(), { status }))).toBe(false);
    expect(isDefinitiveFailure(new TypeError("fetch failed"))).toBe(false);
  });

  it("a storage write that fails does not stop the send: it is posted and settles normally", async () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    const post = vi.fn(async () => ({ ok: true }));
    const r = renderer(storage as any, post);
    const received: string[] = [];
    await r.delivery.submit(entry("q1"), { onReceipt: (e) => { received.push(e.sendId); } });
    expect(post).toHaveBeenCalledTimes(1);
    expect(r.log.sending).toEqual(["q1"]);
    expect(received).toEqual(["q1"]);
    expect(r.log.recovered).toEqual([]);
    expect(r.outbox.list()).toEqual([]);
  });

  it("with no localStorage at all, a send is still posted, retried with the same sendId, and acknowledged", async () => {
    const posts: string[] = [];
    let first = true;
    const log = { timers: [] as Array<() => void>, receipts: [] as string[] };
    const delivery = createSendDelivery({
      outbox: createOutbox(undefined),
      post: async (e) => { posts.push(e.sendId); if (first) { first = false; throw new TypeError("offline"); } return { ok: true }; },
      now: () => 2_000,
      setTimer: (fn) => { log.timers.push(fn); return 0; },
      showSending: () => {}, settleSending: () => {}, receipt: (e) => log.receipts.push(e.sendId),
      recover: () => { throw new Error("must not give the words back"); },
    });
    await delivery.submit(entry("n1"));
    expect(log.timers).toHaveLength(1);
    log.timers.shift()!();
    await new Promise((x) => setTimeout(x, 0));
    expect(posts).toEqual(["n1", "n1"]);
    expect(log.receipts).toEqual(["n1"]);
  });

  it("never evicts an unresolved send: past the cap a new send is refused and the old ones all stay", async () => {
    const storage = fakeStorage();
    const outbox = createOutbox(storage);
    for (let i = 0; i < MAX_OUTBOX_ENTRIES; i++) expect(outbox.add(entry(`e${i}`))).toBe("ok");
    expect(outbox.add(entry("overflow"))).toBe("full");
    expect(outbox.list()).toHaveLength(MAX_OUTBOX_ENTRIES);
    expect(outbox.has("e0")).toBe(true);
    expect(outbox.has("overflow")).toBe(false);
    expect(createOutbox(storage).list()).toHaveLength(MAX_OUTBOX_ENTRIES);
    // re-adding an entry it already holds is not growth
    expect(outbox.add(entry("e0"))).toBe("ok");
    // a resolved one frees room
    outbox.remove("e1");
    expect(outbox.add(entry("overflow"))).toBe("ok");
  });

  it("a full outbox hands the new send back to the composer instead of posting it", async () => {
    const storage = fakeStorage();
    const seed = createOutbox(storage);
    for (let i = 0; i < MAX_OUTBOX_ENTRIES; i++) seed.add(entry(`e${i}`));
    const post = vi.fn(async () => ({ ok: true }));
    const r = renderer(storage, post);
    await r.delivery.submit(entry("new"));
    expect(post).not.toHaveBeenCalled();
    expect(r.log.recovered).toEqual(["new"]);
    expect(createOutbox(storage).has("e0")).toBe(true);
  });

  it("a POST that never settles is abandoned by its own clock and retried with the same sendId", async () => {
    const storage = fakeStorage();
    const fires: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    const sendIds: string[] = [];
    const log = { timers: [] as Array<() => void>, recovered: [] as string[] };
    const delivery = createSendDelivery({
      outbox: createOutbox(storage),
      post: (e, signal) => { sendIds.push(e.sendId); if (signal) signals.push(signal); return new Promise(() => {}); },
      now: () => 2_000,
      setTimer: (fn) => { log.timers.push(fn); return 0; },
      attemptTimer: (fn) => { fires.push(fn); return () => {}; },
      showSending: () => {}, settleSending: () => {}, receipt: () => {},
      recover: (e) => log.recovered.push(e.sendId),
    });
    const done = delivery.submit(entry("h1"));
    expect(delivery.inFlight("h1")).toBe(true);
    fires[0]!();
    await done;
    expect(signals[0]!.aborted).toBe(true);
    expect(delivery.inFlight("h1")).toBe(false);
    expect(log.recovered).toEqual([]);
    expect(createOutbox(storage).list()).toHaveLength(1);
    expect(log.timers).toHaveLength(1); // a retry is scheduled
    log.timers.shift()!();
    await new Promise((x) => setTimeout(x, 0));
    expect(sendIds).toEqual(["h1", "h1"]);
  });

  it("the overall deadline holds even when every attempt hangs: past it the send fails with its sendId kept for a resend", async () => {
    const storage = fakeStorage();
    const clock = { now: 2_000 };
    const fires: Array<() => void> = [];
    const timers: Array<() => void> = [];
    const failed: Array<{ sendId: string; text: string }> = [];
    const delivery = createSendDelivery({
      outbox: createOutbox(storage),
      post: () => new Promise(() => {}),
      now: () => clock.now,
      setTimer: (fn) => { timers.push(fn); return 0; },
      attemptTimer: (fn) => { fires.push(fn); return () => {}; },
      showSending: () => {}, settleSending: () => {}, receipt: () => {},
      recover: (e) => failed.push({ sendId: e.sendId, text: e.text }),
    });
    const first = delivery.submit(entry("h2", { at: 1_000, draft: undefined }));
    clock.now = 1_000 + OUTBOX_GIVE_UP_MS + 1;
    fires[0]!();
    await first;
    expect(failed).toEqual([{ sendId: "h2", text: "words h2" }]);
    expect(createOutbox(storage).list()).toEqual([]);
    expect(timers).toHaveLength(0);
  });
});

describe("r5: a reconnect that finds the accepted send runs the acknowledgement", () => {
  it("hydration during retry backoff calls the same receipt hook, so the composer stops waiting and its draft clears", async () => {
    const storage = fakeStorage();
    const post = vi.fn(async () => { throw Object.assign(new Error("offline"), { status: 503 }); });
    const r = renderer(storage, post);
    const acknowledged = vi.fn();
    await r.delivery.submit(entry("lost-ack"), { onReceipt: acknowledged });
    expect(r.outbox.has("lost-ack")).toBe(true); // in backoff, a retry is scheduled
    // the server HAD accepted it; hydration shows its line
    r.delivery.reconcile({ messageSendIds: new Set(["lost-ack"]), pendingSendIds: new Set() });
    expect(acknowledged).toHaveBeenCalledTimes(1);
    expect(createOutbox(storage).has("lost-ack")).toBe(false);
    expect(r.log.settled).toContain("lost-ack");
    // the scheduled retry finds nothing left to send
    for (const timer of r.log.timers.splice(0)) timer();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("a queued or refused send on the server counts too, once", async () => {
    const storage = fakeStorage();
    const r = renderer(storage, async () => { throw Object.assign(new Error("offline"), { status: 503 }); });
    const acknowledged = vi.fn();
    await r.delivery.submit(entry("held-ack"), { onReceipt: acknowledged });
    r.delivery.reconcile({ messageSendIds: new Set(), pendingSendIds: new Set(["held-ack"]) });
    r.delivery.reconcile({ messageSendIds: new Set(["held-ack"]), pendingSendIds: new Set() });
    expect(acknowledged).toHaveBeenCalledTimes(1);
  });

  /** A8: the real draft records over one Storage, reloaded as a fresh module, so these tests read the record on disk. */
  const recordsOnDisk = async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v), removeItem: (k: string) => void values.delete(k),
      key: (i: number) => [...values.keys()][i] ?? null, get length() { return values.size; },
    };
    let chain: Promise<unknown> = Promise.resolve();
    const locks = { request: <T,>(_name: string, fn: () => T | Promise<T>): Promise<T> => { const run = chain.then(() => fn()); chain = run.catch(() => undefined); return run; } };
    const open = async () => {
      vi.resetModules();
      vi.stubGlobal("window", new EventTarget());
      vi.stubGlobal("localStorage", storage);
      vi.stubGlobal("navigator", { locks });
      return import("../lib/drafts");
    };
    const D = "bot:b1:t1";
    const drafts = await open();
    drafts.setComposerDraftText(D, "reload words");
    await new Promise((x) => setTimeout(x, 0));
    const begun = await drafts.beginDraftSend(D, { text: "reload words", att: [], mode: "chat" }, (sendId, content) => ({ sendId, kind: "bot", botId: "b1", threadId: "t1", text: content.text, at: Date.now(), attempts: 0 }));
    if (!begun.ok) throw new Error(begun.reason);
    return { storage, begun, reload: open, record: () => JSON.parse(values.get(`murage-draft:${D}`) ?? "null") };
  };

  it("after a reload (no composer hook), reconcile settles the draft record that holds the send as acked, on disk (A8)", async () => {
    const disk = await recordsOnDisk();
    const fresh = await disk.reload();
    const post = vi.fn();
    const second = createSendDelivery({
      outbox: createOutbox(disk.storage, fresh.draftJournal), post, now: () => Date.now(), setTimer: () => 0,
      showSending: () => {}, settleSending: () => {}, receipt: () => {}, recover: () => {},
    });
    second.reconcile({ messageSendIds: new Set([disk.begun.sendId]), pendingSendIds: new Set() });
    await vi.waitFor(() => expect(disk.record()).toMatchObject({ text: "", last: { s: disk.begun.sendId, o: "acked" } }));
    expect(disk.record().out).toBeUndefined();
    expect(post).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("a replayed POST that succeeds with no stored hooks clears the record on disk; a drafted refusal keeps P with its words and recovers nothing (A8)", async () => {
    const ok = await recordsOnDisk();
    const recovered: string[] = [];
    const second = createSendDelivery({
      outbox: createOutbox(ok.storage, (await ok.reload()).draftJournal), post: async () => ({ ok: true }), now: () => Date.now(), setTimer: () => 0,
      showSending: () => {}, settleSending: () => {}, receipt: () => {}, recover: (e) => recovered.push(e.sendId),
    });
    second.reconcile({ messageSendIds: new Set(), pendingSendIds: new Set() });
    await vi.waitFor(() => expect(ok.record()).toMatchObject({ text: "", last: { s: ok.begun.sendId, o: "acked" } }));
    expect(ok.record().out).toBeUndefined();
    const refused = await recordsOnDisk();
    const third = createSendDelivery({
      outbox: createOutbox(refused.storage, (await refused.reload()).draftJournal), post: async () => { throw Object.assign(new Error("too large"), { status: 413 }); }, now: () => Date.now(), setTimer: () => 0,
      showSending: () => {}, settleSending: () => {}, receipt: () => {}, recover: (e) => recovered.push(e.sendId),
    });
    third.reconcile({ messageSendIds: new Set(), pendingSendIds: new Set() });
    await vi.waitFor(() => expect(refused.record()).toMatchObject({ text: "reload words", pin: { s: refused.begun.sendId }, last: { s: refused.begun.sendId, o: "failed" } }));
    expect(refused.record().out).toBeUndefined();
    expect(recovered).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("its own sentences come from the language packs", async () => {
    const source = (await import("node:fs")).readFileSync(new URL("./send-delivery.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/"Earlier messages are still being delivered|"That took too long/);
    expect(source).toContain('t("send.outboxFull")');
    expect(source).toContain('t("send.timedOut")');
  });
});

describe("r8: the refused chip is the one surface for a send id", () => {
  it("forget removes the outbox entry for the id, and leaves an attempt in flight alone", async () => {
    const storage = fakeStorage();
    let release: () => void = () => {};
    const r = renderer(storage, () => new Promise((resolve) => { release = () => resolve({ ok: true }); }));
    const pending = r.delivery.submit(entry("send-r8-0000000000000001"));
    r.delivery.forget("send-r8-0000000000000001");
    expect(r.outbox.has("send-r8-0000000000000001")).toBe(true);
    release();
    await pending;
    const held = renderer(storage, async () => { throw Object.assign(new Error("offline"), { status: 0 }); });
    await held.delivery.submit(entry("send-r8-0000000000000002"));
    expect(held.outbox.has("send-r8-0000000000000002")).toBe(true);
    held.delivery.forget("send-r8-0000000000000002");
    expect(createOutbox(storage).has("send-r8-0000000000000002")).toBe(false);
  });
});

describe("r9: one resolution of a send id against a server refusal", () => {
  it("a 503 then chip reconciliation settles the composer callback and releases the frozen draft", async () => {
    const storage = fakeStorage();
    const released: string[] = [];
    const failed: string[] = [];
    const delivery = createSendDelivery({
      outbox: createOutbox(storage),
      post: async () => { throw Object.assign(new Error("busy"), { status: 503 }); },
      now: () => 2_000,
      setTimer: () => 0,
      showSending: () => {},
      settleSending: () => {},
      receipt: () => {},
      recover: () => {},
      releaseRefused: (sendId) => released.push(sendId),
    });
    await delivery.submit(entry("send-r9-0000000000000001"), { onFailed: (e) => { failed.push(e.sendId); return true; } });
    expect(failed).toEqual([]);
    delivery.resolveRefused("send-r9-0000000000000001");
    expect(failed).toEqual(["send-r9-0000000000000001"]);
    expect(released).toEqual(["send-r9-0000000000000001"]);
    expect(createOutbox(storage).has("send-r9-0000000000000001")).toBe(false);
  });

  it("a refusal recorded while the POST is in flight stops the automatic retry after a 503", async () => {
    const storage = fakeStorage();
    const timers: Array<() => void> = [];
    const released: string[] = [];
    let fail: () => void = () => {};
    let posts = 0;
    const delivery = createSendDelivery({
      outbox: createOutbox(storage),
      post: () => { posts += 1; return new Promise((_, reject) => { fail = () => reject(Object.assign(new Error("busy"), { status: 503 })); }); },
      now: () => 2_000,
      setTimer: (fn) => { timers.push(fn); return 0; },
      showSending: () => {},
      settleSending: () => {},
      receipt: () => {},
      recover: () => {},
      releaseRefused: (sendId) => released.push(sendId),
    });
    const pending = delivery.submit(entry("send-r9-0000000000000002"));
    delivery.resolveRefused("send-r9-0000000000000002");
    fail();
    await pending;
    expect(timers).toHaveLength(0);
    expect(posts).toBe(1);
    expect(released).toEqual(["send-r9-0000000000000002"]);
    expect(createOutbox(storage).has("send-r9-0000000000000002")).toBe(false);
    // Send again is a new attempt and posts.
    void delivery.submit(entry("send-r9-0000000000000002"));
    expect(posts).toBe(2);
  });
});

describe("r10: same send id submitted while its POST is in flight", () => {
  const make = (storage: ReturnType<typeof fakeStorage>, posts: Array<{ resolve: (v: any) => void; reject: (e: unknown) => void }>) => {
    const released: string[] = [];
    const delivery = createSendDelivery({
      outbox: createOutbox(storage),
      post: () => new Promise((resolve, reject) => { posts.push({ resolve, reject }); }),
      now: () => 2_000,
      setTimer: () => 0,
      showSending: () => {},
      settleSending: () => {},
      receipt: () => {},
      recover: () => {},
      releaseRefused: (id) => released.push(id),
    });
    return { delivery, released };
  };

  it("refusal during the POST, then Send again: the original composer thaws and exactly one retry posts after the first resolves", async () => {
    const storage = fakeStorage();
    const posts: Array<{ resolve: (v: any) => void; reject: (e: unknown) => void }> = [];
    const { delivery } = make(storage, posts);
    const id = "send-r10-0000000000000001";
    const log: string[] = [];
    const first = delivery.submit(entry(id), { onFailed: () => { log.push("first-thawed"); return true; }, onReceipt: () => log.push("first-receipt") });
    delivery.resolveRefused(id); // refusal arrives during the POST
    const again = delivery.submit(entry(id), { onFailed: () => { log.push("retry-failed"); return true; }, onReceipt: () => log.push("retry-receipt") });
    expect(log).toEqual(["first-thawed"]);
    expect(posts).toHaveLength(1);
    expect(delivery.audit()).toEqual([]);
    posts[0]!.reject(Object.assign(new Error("busy"), { status: 503 }));
    await first;
    expect(posts).toHaveLength(2);
    posts[1]!.resolve({ ok: true });
    await again;
    expect(log).toEqual(["first-thawed", "retry-receipt"]);
    expect(createOutbox(storage).has(id)).toBe(false);
    expect(delivery.audit()).toEqual([]);
  });

  it("double click on Send again: one retry POST, every hook set settled exactly once", async () => {
    const storage = fakeStorage();
    const posts: Array<{ resolve: (v: any) => void; reject: (e: unknown) => void }> = [];
    const { delivery } = make(storage, posts);
    const id = "send-r10-0000000000000002";
    const log: string[] = [];
    const hooks = (name: string) => ({ onFailed: () => { log.push(`${name}-failed`); return true; }, onReceipt: () => log.push(`${name}-receipt`) });
    const p0 = delivery.submit(entry(id), hooks("a"));
    delivery.resolveRefused(id);
    const p1 = delivery.submit(entry(id), hooks("b"));
    const p2 = delivery.submit(entry(id), hooks("c"));
    expect(delivery.audit()).toEqual([]);
    posts[0]!.reject(Object.assign(new Error("busy"), { status: 503 }));
    await p0;
    expect(posts).toHaveLength(2);
    posts[1]!.resolve({ ok: true });
    await Promise.all([p1, p2]);
    expect(log.sort()).toEqual(["a-failed", "b-failed", "c-receipt"]);
    expect(posts).toHaveLength(2);
    expect(delivery.audit()).toEqual([]);
  });

  it("refusal observed, Send again, then the ORIGINAL 202 arrives: the resend still posts and settles from its own response", async () => {
    const storage = fakeStorage();
    const posts: Array<{ resolve: (v: any) => void; reject: (e: unknown) => void }> = [];
    const { delivery } = make(storage, posts);
    const id = "send-r10-0000000000000003";
    const log: string[] = [];
    const first = delivery.submit(entry(id), { onFailed: () => { log.push("first-thawed"); return true; }, onReceipt: () => log.push("first-receipt") });
    delivery.resolveRefused(id);
    const again = delivery.submit(entry(id), { onFailed: () => { log.push("retry-failed"); return true; }, onReceipt: () => log.push("retry-receipt") });
    posts[0]!.resolve({ ok: true, original: true }); // the delayed 202 of the original
    await first;
    expect(posts).toHaveLength(2);
    expect(log).toEqual(["first-thawed"]);
    posts[1]!.resolve({ ok: true });
    await again;
    expect(posts).toHaveLength(2);
    expect(log).toEqual(["first-thawed", "retry-receipt"]);
    expect(createOutbox(storage).has(id)).toBe(false);
    expect(delivery.audit()).toEqual([]);
  });
});

describe("a busy answer (DATABASE_BUSY, 503 with Retry-After) is retried with the same sendId", () => {
  const busy = (status = 503) => Object.assign(new Error("Busy for a moment, try again"), { status, body: { code: "DATABASE_BUSY", retryable: true, retryAfterSeconds: 1 } });

  it("is not a definitive failure, whatever status carries it (an older server answered 409)", () => {
    expect(isBusyRefusal(busy())).toBe(true);
    expect(isDefinitiveFailure(busy())).toBe(false);
    expect(isDefinitiveFailure(busy(409))).toBe(false);
    // an ordinary conflict is still final
    expect(isDefinitiveFailure(Object.assign(new Error("conflict"), { status: 409, body: { error: "x" } }))).toBe(true);
  });

  it("matches the busy code or any 503, and the comment says so (lane 5.4)", () => {
    expect(isBusyRefusal({ status: 503, body: {} })).toBe(true);
    expect(isBusyRefusal({ status: 200, body: { code: "DATABASE_BUSY" } })).toBe(true);
    expect(isBusyRefusal({ status: 500, body: { code: "OTHER" } })).toBe(false);
    // only the strict check needs the code itself
    expect(isDatabaseBusyAnswer({ status: 503, body: {} })).toBe(false);
    const source = readFileSync(fileURLToPath(new URL("./send-delivery.ts", import.meta.url)), "utf8");
    const at = source.indexOf("export function isBusyRefusal");
    expect(source.slice(Math.max(0, at - 700), at)).toMatch(/OR any 503/);
  });

  it("keeps the outbox entry, retries after the Retry-After, and delivers once with the same sendId", async () => {
    const storage = fakeStorage();
    const posts: string[] = [];
    let answers = 2;
    const r = renderer(storage, async (e) => { posts.push(e.sendId); if (answers-- > 0) throw busy(); return { ok: true }; });
    await r.delivery.submit(entry("s-busy"));
    expect(createOutbox(storage).list().map((x) => x.sendId)).toEqual(["s-busy"]); // kept, not dropped
    expect(r.log.recovered).toEqual([]);
    expect(r.log.receipts).toEqual([]);
    expect(r.log.timers).toHaveLength(1);
    r.log.timers.shift()!();
    await new Promise((res) => setTimeout(res, 0));
    expect(createOutbox(storage).list()).toHaveLength(1);
    r.log.timers.shift()!();
    await new Promise((res) => setTimeout(res, 0));
    expect(posts).toEqual(["s-busy", "s-busy", "s-busy"]);
    expect(createOutbox(storage).list()).toEqual([]);
    expect(r.log.receipts).toEqual(["s-busy"]);
    expect(r.log.recovered).toEqual([]);
  });

  it("waits the Retry-After, at least one second and at most five", () => {
    expect(busyRetryDelayMs(busy())).toBe(1_000);
    expect(busyRetryDelayMs(Object.assign(new Error("x"), { body: { retryAfterSeconds: 3 } }))).toBe(3_000);
    expect(busyRetryDelayMs(Object.assign(new Error("x"), { body: { retryAfterSeconds: 90 } }))).toBe(5_000);
    expect(busyRetryDelayMs(new Error("x"))).toBe(1_000);
  });

  it("retryWhileBusy (the senders that skip the outbox) repeats the same request while busy, then gives up, and passes any other failure straight through", async () => {
    const waits: number[] = [];
    const wait = async (ms: number) => { waits.push(ms); };
    let calls = 0;
    await expect(retryWhileBusy(async () => { if (++calls < 3) throw busy(); return "sent"; }, { wait })).resolves.toBe("sent");
    expect(calls).toBe(3);
    expect(waits).toEqual([1_000, 1_000]);
    calls = 0;
    await expect(retryWhileBusy(async () => { calls++; throw busy(); }, { tries: 3, wait })).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(3);
    calls = 0;
    await expect(retryWhileBusy(async () => { calls++; throw Object.assign(new Error("no"), { status: 403 }); }, { wait })).rejects.toMatchObject({ status: 403 });
    expect(calls).toBe(1);
  });

  it("every owner sender in the store repeats a busy send with its sendId (source check)", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./store.tsx", import.meta.url), "utf8");
    expect(source).toContain("retryWhileBusy(() => api(`/api/bots/${action.botId}/messages`");
    expect(source).toContain("void retryWhileBusy(post)");
  });

  // rc13-boot2 review (Astra High 1): an edit met by a busy answer was dropped, and the editor had already closed on its words
  it("deliverEdit repeats a busy edit under ONE sendId (Retry-After), then says sent once; past its tries it hands the failure back instead of dropping it", async () => {
    const waits: number[] = [], ids: string[] = [];
    const wait = async (ms: number) => { waits.push(ms); };
    let sent = 0, failed: unknown;
    await deliverEdit(async (sendId) => { ids.push(sendId); if (ids.length < 3) throw Object.assign(busy(), { body: { code: "DATABASE_BUSY", retryAfterSeconds: 2 } }); return { ok: true }; }, { sendId: "edit-1", onSent: () => { sent++; }, onFailed: (error) => { failed = error; } }, { wait });
    expect(ids).toEqual(["edit-1", "edit-1", "edit-1"]);
    expect(waits).toEqual([2_000, 2_000]);
    expect(sent).toBe(1);
    expect(failed).toBeUndefined();
    ids.length = 0;
    await deliverEdit(async (sendId) => { ids.push(sendId); throw busy(); }, { sendId: "edit-2", onSent: () => { sent++; }, onFailed: (error) => { failed = error; } }, { tries: 3, wait });
    expect(ids).toEqual(["edit-2", "edit-2", "edit-2"]);
    expect(sent).toBe(1);
    expect(failed).toMatchObject({ status: 503 });
  });

  // astra-boot2-r3 High 2: an unanswered edit stayed "Saving…" for ever
  it("deliverEdit gives the edit back as failed at its deadline when the server never answers, aborting the request; a late answer is ignored", async () => {
    let fire: (() => void) | undefined, deadline = 0, cancelled = false, seenSignal: AbortSignal | undefined;
    const setTimer = (fn: () => void, ms: number) => { fire = fn; deadline = ms; return () => { cancelled = true; }; };
    let answer: ((value: unknown) => void) | undefined;
    let sent = 0; const failures: unknown[] = [];
    const done = deliverEdit((_sendId, signal) => { seenSignal = signal; return new Promise((resolve) => { answer = resolve; }); },
      { sendId: "edit-3", onSent: () => { sent++; }, onFailed: (error) => { failures.push(error); } }, { setTimer });
    expect(deadline).toBe(EDIT_DEADLINE_MS);
    expect(EDIT_DEADLINE_MS).toBeLessThanOrEqual(20_000);
    fire!();
    await done;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ status: 408 });
    expect(seenSignal!.aborted).toBe(true);
    answer!({ ok: true });
    await Promise.resolve();
    expect(sent).toBe(0);
    expect(failures).toHaveLength(1);
    expect(cancelled).toBe(true);
  });

  it("deliverEdit's deadline covers busy repeats: no repeat is posted once it has passed", async () => {
    vi.useFakeTimers();
    try {
      const ids: string[] = []; const failures: unknown[] = [];
      const done = deliverEdit(async (sendId) => { ids.push(sendId); throw busy(); }, { sendId: "edit-4", onFailed: (error) => { failures.push(error); } }, { tries: 100, deadlineMs: 2_500 });
      await vi.advanceTimersByTimeAsync(2_500);
      await done;
      const posted = ids.length;
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ status: 408 });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ids.length).toBe(posted);
      expect(new Set(ids)).toEqual(new Set(["edit-4"]));
    } finally { vi.useRealTimers(); }
  });

  it("deliverEdit stops on the person's Cancel: the request is aborted and neither hook runs", async () => {
    const cancel = new AbortController();
    let seenSignal: AbortSignal | undefined, sent = 0, failed = 0;
    const done = deliverEdit((_sendId, signal) => { seenSignal = signal; return new Promise(() => {}); },
      { sendId: "edit-5", onSent: () => { sent++; }, onFailed: () => { failed++; } }, { signal: cancel.signal, setTimer: () => () => {} });
    await Promise.resolve();
    cancel.abort();
    await done;
    expect(seenSignal!.aborted).toBe(true);
    expect(sent).toBe(0);
    expect(failed).toBe(0);
  });

  it("api() repeats a busy delete or settings write (PUT, PATCH, DELETE); a POST without its own sendId and a read are tried once", () => {
    for (const method of ["PUT", "PATCH", "DELETE", "delete"]) expect(busyRetriesFor(method)).toBeGreaterThan(1);
    for (const method of ["POST", "GET", undefined]) expect(busyRetriesFor(method)).toBe(1);
  });

  it("api() repeats on the server's DATABASE_BUSY answer only, never on another 503", () => {
    expect(isDatabaseBusyAnswer(busy())).toBe(true);
    expect(isDatabaseBusyAnswer(busy(409))).toBe(true);
    expect(isDatabaseBusyAnswer(Object.assign(new Error("Fixture save unavailable"), { status: 503, body: { error: "Fixture save unavailable" } }))).toBe(false);
    expect(isDatabaseBusyAnswer(Object.assign(new Error("gateway"), { status: 503 }))).toBe(false);
  });

  it("the edit goes through deliverEdit with a sendId, api() repeats by method, and the editor keeps the words until acknowledged (source check)", async () => {
    const { readFileSync } = await import("node:fs");
    const store = readFileSync(new URL("./store.tsx", import.meta.url), "utf8");
    expect(store).toContain("void deliverEdit((sendId, signal) => api(`/api/bots/${action.botId}/messages/${action.messageId}/edit`");
    expect(store).toContain("{ signal: action.signal });");
    expect(store).toContain("body: JSON.stringify({ text: action.text, threadId, sendId })");
    expect(store).toContain("busyTries: number = busyRetriesFor(init?.method)");
    expect(store).toContain("return api(path, init, busyTries - 1);");
    const chat = readFileSync(new URL("../components/ChatView.tsx", import.meta.url), "utf8");
    // one draft per message, one edit per message in flight, each answer keyed by its own sendId (lib/edit-drafts.test.ts)
    expect(chat).toContain("const next = beginEdit(editDraftStore.get(botId), messageId, text, newSendId());");
    expect(chat).toContain("if (!next) return;");
    expect(chat).toContain("type: \"editMessage\", botId, threadId: bot.threadId, messageId, text, sendId, signal: stop.signal,");
    expect(chat).toContain("editDraftStore.update(botId, (drafts) => editFailed(drafts, messageId, sendId, editErrorLine(error)));");
    expect(chat).toContain("editDraftStore.update(botId, (drafts) => editSent(drafts, messageId, sendId));");
    // astra-boot2-r3 High 1: drafts live in a per-bot store outside the view; switching bots reopens a waiting draft and never clears one
    expect(chat).toContain("const editDrafts = useSyncExternalStore(editDraftStore.subscribe, () => editDraftStore.get(bot.id));");
    expect(chat).toContain("setEditingId(Object.keys(editDraftStore.get(bot.id))[0] ?? null);");
    expect(chat).not.toContain("setEditDrafts(() => ({}))");
    // astra-boot2-r3 High 2: Cancel while saving aborts the delivery and leaves the words editable
    expect(chat).toContain("editDraftStore.update(botId, (drafts) => stopSaving(drafts, id));");
    expect(chat).toContain("<BubbleEditor initial={editText ?? text} saving={editSaving}");
    expect(chat).toContain("editText={editDrafts[m.id]?.text}");
  });
});
