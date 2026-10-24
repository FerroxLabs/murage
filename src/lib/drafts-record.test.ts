// U36 (design U36-DRAFT-SEND-STATE-106, section 7): one case per failure-list row F1 to F31, then the code review rows.
// Two "tabs" are two module instances over ONE fake Storage, with `storage` events dispatched by hand
// (a browser never sends one to the tab that wrote) and one fake navigator.locks shared between them.
// A crash is a setItem that throws, then a fresh module over the same Storage. F31 (route policy) and
// the GET /api/sends route itself are in server/sends-lookup-api.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutboxEntry } from "../state/send-delivery";

type Drafts = typeof import("./drafts");

function sharedStorage() {
  const values = new Map<string, string>();
  const state = { refuse: false as boolean | ((key: string) => boolean), writes: [] as string[] };
  const storage = {
    values,
    state,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      const refuse = typeof state.refuse === "function" ? state.refuse(key) : state.refuse;
      if (refuse) throw new Error("QuotaExceededError");
      state.writes.push(key);
      values.set(key, value);
    },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  return storage;
}
type SharedStorage = ReturnType<typeof sharedStorage>;

/** navigator.locks as one browser has it: one FIFO queue per name, shared by every tab. */
function sharedLocks() {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    request<T>(_name: string, callback: () => T | Promise<T>): Promise<T> {
      const run = chain.then(() => callback());
      chain = run.catch(() => undefined);
      return run;
    },
  };
}
type SharedLocks = ReturnType<typeof sharedLocks>;

interface Tab { mod: Drafts; win: EventTarget; hear: (draftId: string) => void }

/** `locks: null` is a WebView without Web Locks (the per-tab fallback chain). */
async function openTab(storage: SharedStorage, locks: SharedLocks | null): Promise<Tab> {
  vi.resetModules();
  const win = new EventTarget();
  vi.stubGlobal("window", win);
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("navigator", locks ? { locks } : {});
  const mod = await import("./drafts");
  const hear = (draftId: string) => win.dispatchEvent(Object.assign(new Event("storage"), { key: `murage-draft:${draftId}` }));
  return { mod, win, hear };
}

const flush = async (rounds = 6) => { for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const D = "bot:b1:t1";
const record = (storage: SharedStorage, id = D) => JSON.parse(storage.getItem(`murage-draft:${id}`) ?? "null");
const build = (sendId: string, content: { text: string; reply?: string }) => ({
  sendId, kind: "bot" as const, botId: "b1", threadId: "t1", text: content.text, ...(content.reply ? { replyToId: content.reply } : {}), at: Date.now(), attempts: 0,
});
const press = (tab: Tab, id = D) => {
  const view = tab.mod.readComposerDraft(id);
  return tab.mod.beginDraftSend(id, { text: view.text, att: view.att, mode: view.mode }, build);
};
const file = (name: string) => ({ id: name, kind: "file" as const, name, path: `/tmp/${name}`, size: 1 });
const sent = async (tab: Tab, text: string, id = D) => {
  tab.mod.setComposerDraftText(id, text);
  await flush();
  const begun = await press(tab, id);
  if (!begun.ok) throw new Error(`press refused: ${begun.reason}`);
  return begun;
};

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("U36 draft and send state", () => {
  it("F1 two tabs, one draft: the second tab is held and adopts the words; the first ack clears, the second finds nothing", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const b = await openTab(storage, locks);
    a.mod.setComposerDraftText(D, "hello");
    await flush();
    b.hear(D);
    expect(b.mod.readComposerDraft(D).text).toBe("hello");
    const begun = await press(a);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    b.hear(D);
    expect(b.mod.isDraftHeld(D)).toBe(true);
    expect(b.mod.setComposerDraftText(D, "hello there")).toBe(false);
    expect((await press(b)).ok).toBe(false);
    expect(await a.mod.settleDraftSend(D, begun.sendId, undefined, "acked")).toBe(true);
    expect(await b.mod.settleDraftSend(D, begun.sendId, undefined, "acked")).toBe(false);
    expect(record(storage)).toMatchObject({ text: "", last: { s: begun.sendId, o: "acked" } });
    expect(record(storage).out).toBeUndefined();
  });

  it("F2 a late ack from another tab never clears words retyped after the first ack", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const b = await openTab(storage, locks);
    const begun = await sent(a, "hi");
    const seen: string[] = [];
    b.hear(D);
    b.mod.watchDraftSend(D, begun.sendId, begun.attemptId, (outcome) => seen.push(outcome));
    expect(seen).toEqual([]);
    expect(await a.mod.settleDraftSend(D, begun.sendId, undefined, "acked")).toBe(true);
    a.mod.setComposerDraftText(D, "hi");
    await flush();
    b.hear(D);
    expect(seen).toEqual(["acked"]);
    expect(await b.mod.settleDraftSend(undefined, begun.sendId, undefined, "acked")).toBe(false);
    expect(record(storage).text).toBe("hi");
  });

  it("F3 no edit while held (any tab, after a reload); an edit after a failure makes the pin stale and the next Send looks it up first", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const first = await sent(a, "hello");
    expect(a.mod.setComposerDraftText(D, "hello world")).toBe(false);
    const reloaded = await openTab(storage, locks);
    expect(reloaded.mod.isDraftHeld(D)).toBe(true);
    expect(reloaded.mod.setComposerDraftText(D, "hello world")).toBe(false);
    await reloaded.mod.settleDraftSend(D, first.sendId, first.attemptId, "failed");
    expect(record(storage)).toMatchObject({ text: "hello", pin: { s: first.sendId } });
    reloaded.mod.setComposerDraftText(D, "hello world");
    await flush();
    const asked: string[] = [];
    reloaded.mod.setDraftSendLookup(async (threadId, sendId) => { asked.push(`${threadId}/${sendId}`); return "ack"; });
    expect(await press(reloaded)).toEqual({ ok: false, reason: "earlierArrived" });
    expect(asked).toEqual([`t1/${first.sendId}`]);
    expect(record(storage)).toMatchObject({ text: "hello world" });
    expect(record(storage).pin).toBeUndefined();
    const next = await press(reloaded);
    expect(next.ok && next.sendId).not.toBe(first.sendId);
    expect(next.ok).toBe(true);
    // not arrived: a new id, the stale one is never reused for the edited words
    const second = await openTab(storage, locks);
    if (!next.ok) return;
    await second.mod.settleDraftSend(D, next.sendId, next.attemptId, "failed");
    second.mod.setComposerDraftText(D, "hello world, again");
    await flush();
    second.mod.setDraftSendLookup(async () => "none");
    const third = await press(second);
    expect(third.ok && third.sendId !== next.sendId).toBe(true);
  });

  it("F4 offline give-up leaves P with the words; Send again reuses the send id with a new attempt id", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const first = await sent(a, "offline words");
    await a.mod.settleDraftSend(D, first.sendId, first.attemptId, "failed");
    expect(a.mod.readComposerDraft(D)).toMatchObject({ text: "offline words", held: false });
    const again = await press(a);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.sendId).toBe(first.sendId);
    expect(again.attemptId).not.toBe(first.attemptId);
  });

  it("F5 (A8) a reload mid-send keeps H; the fresh module's reconcile settles it from what the server holds, on disk", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const begun = await sent(a, "mid send");
    const reloaded = await openTab(storage, locks);
    expect(reloaded.mod.isDraftHeld(D)).toBe(true);
    expect(reloaded.mod.draftJournal.entries()).toEqual([expect.objectContaining({ sendId: begun.sendId, draft: expect.objectContaining({ draftId: D, attemptId: begun.attemptId }) })]);
    const { createOutbox, createSendDelivery } = await import("../state/send-delivery");
    const post = vi.fn(async () => ({ ok: true }));
    const delivery = createSendDelivery({
      outbox: createOutbox(storage, reloaded.mod.draftJournal), post, now: () => Date.now(), setTimer: () => 0,
      showSending: () => {}, settleSending: () => {}, receipt: () => {}, recover: () => {},
    });
    // hydrate shows the committed row: reconcile is the acknowledgement, nothing is posted again
    delivery.reconcile({ messageSendIds: new Set([begun.sendId]), pendingSendIds: new Set() });
    await flush();
    expect(post).not.toHaveBeenCalled();
    expect(record(storage)).toMatchObject({ text: "", last: { s: begun.sendId, a: begun.attemptId, o: "acked" } });
    expect(record(storage).out).toBeUndefined();
    expect(record(storage).pin).toBeUndefined();
    expect(reloaded.mod.readComposerDraft(D)).toMatchObject({ text: "", held: false });
  });

  it("F6 a server restart: the retry posts the same send id and the committed row settles it once", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const { createOutbox, createSendDelivery } = await import("../state/send-delivery");
    const begun = await sent(a, "restart words");
    if (!begun.ok) return;
    const posts: string[] = [];
    const timers: Array<() => void> = [];
    const delivery = createSendDelivery({
      outbox: createOutbox(storage, a.mod.draftJournal),
      post: async (entry) => { posts.push(entry.sendId); if (posts.length === 1) throw Object.assign(new Error("restarting"), { status: 503 }); return { ok: true }; },
      now: () => Date.now(), setTimer: (fn) => { timers.push(fn); return 0; },
      showSending: () => {}, settleSending: () => {}, receipt: () => {}, recover: () => {},
    });
    delivery.reconcile({ messageSendIds: new Set(), pendingSendIds: new Set() });
    await flush();
    expect(record(storage).out.entry.attempts).toBe(1);
    timers.shift()!();
    await flush();
    expect(posts).toEqual([begun.sendId, begun.sendId]);
    expect(record(storage)).toMatchObject({ text: "", last: { s: begun.sendId, o: "acked" } });
  });

  it("F7 duplicate deliveries (receipt, live frame, other tab, load check) end in one ack; a later draft is never touched", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const b = await openTab(storage, locks);
    const begun = await sent(a, "once");
    expect(await a.mod.settleDraftSend(D, begun.sendId, begun.attemptId, "acked")).toBe(true);
    a.mod.setComposerDraftText(D, "next draft");
    await flush();
    expect(await a.mod.settleDraftSend(undefined, begun.sendId, undefined, "acked")).toBe(false);
    expect(await b.mod.settleDraftSend(D, begun.sendId, undefined, "acked")).toBe(false);
    b.mod.setDraftSendLookup(async () => "ack");
    expect(await b.mod.checkDraftPin(D, begun.sendId)).toBe("dropped");
    expect(record(storage).text).toBe("next draft");
  });

  it("F8 a crash at any point converges: before W1 nothing is sent, after W1 the send is held, a refused settle keeps H", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    a.mod.setComposerDraftText(D, "crash words");
    await flush();
    storage.state.refuse = (key) => key === `murage-draft:${D}`;
    expect(await press(a)).toEqual({ ok: false, reason: "notSaved" });
    storage.state.refuse = false;
    let reloaded = await openTab(storage, locks);
    expect(reloaded.mod.readComposerDraft(D)).toMatchObject({ text: "crash words", held: false });
    expect(reloaded.mod.draftJournal.entries()).toEqual([]);
    const begun = await press(reloaded);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    reloaded = await openTab(storage, locks);
    expect(reloaded.mod.isDraftHeld(D)).toBe(true);
    storage.state.refuse = true;
    expect(await reloaded.mod.settleDraftSend(D, begun.sendId, undefined, "acked")).toBe(false);
    reloaded = await openTab(storage, locks);
    expect(reloaded.mod.readComposerDraft(D)).toMatchObject({ text: "crash words", held: true });
  });

  it("F9 two presses in two tabs: the lock serializes them and exactly one sends", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    a.mod.setComposerDraftText(D, "one send");
    await flush();
    const b = await openTab(storage, locks);
    const results = await Promise.all([press(a), press(b)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "held" }]);
    expect(a.mod.draftJournal.entries()).toHaveLength(1);
  });

  it("F10 edits never touch the pin, and the journal leaves in the same single write that clears", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const begun = await sent(a, "ordered");
    await a.mod.settleDraftSend(D, begun.sendId, begun.attemptId, "failed");
    const pin = record(storage).pin;
    a.mod.setComposerDraftText(D, "ordered!");
    await flush();
    expect(record(storage).pin).toEqual(pin);
    a.mod.setComposerDraftText(D, "ordered");
    await flush();
    const again = await press(a);
    if (!again.ok) throw new Error("refused");
    storage.state.writes.length = 0;
    await a.mod.settleDraftSend(D, again.sendId, undefined, "acked");
    expect(storage.state.writes.filter((key) => key === `murage-draft:${D}`)).toHaveLength(1);
    expect(record(storage)).toMatchObject({ text: "" });
    expect(record(storage).out).toBeUndefined();
    expect(record(storage).pin).toBeUndefined();
  });

  it("F11 storage refusing writes refuses Send (nothing posted); a refused settle keeps H and is retried", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    a.mod.setComposerDraftText(D, "journal first");
    await flush();
    storage.state.refuse = true;
    expect(await press(a)).toEqual({ ok: false, reason: "notSaved" });
    expect(a.mod.draftJournal.entries()).toEqual([]);
    expect(a.mod.readComposerDraft(D).text).toBe("journal first");
    storage.state.refuse = false;
    const begun = await press(a);
    if (!begun.ok) throw new Error("refused");
    storage.state.refuse = true;
    expect(await a.mod.settleDraftSend(D, begun.sendId, undefined, "acked")).toBe(false);
    expect(a.mod.isDraftHeld(D)).toBe(true);
    storage.state.refuse = false;
    a.hear("some-other-draft"); // the next storage event retries the same transition
    await flush();
    expect(a.mod.readComposerDraft(D)).toMatchObject({ text: "", held: false });
  });

  it("F12 an attachment that arrives while held waits in `later` (any tab) and joins the next draft at settle", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const b = await openTab(storage, locks);
    const begun = await sent(a, "with later");
    expect(await b.mod.appendComposerDraftAttachments(D, [file("late.png")])).toBe(true);
    expect(record(storage).later).toEqual([file("late.png")]);
    expect(record(storage).att).toEqual([]);
    await a.mod.settleDraftSend(D, begun.sendId, undefined, "acked");
    expect(record(storage)).toMatchObject({ text: "", att: [file("late.png")] });
    expect(record(storage).later).toBeUndefined();
  });

  it("F13 the reply target and the mode cannot change while held", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    a.mod.setComposerDraftReply(D, "m1");
    await sent(a, "held reply");
    expect(a.mod.setComposerDraftReply(D, "m2")).toBe(false);
    expect(a.mod.setComposerDraftReply(D, undefined)).toBe(false);
    expect(a.mod.setComposerDraftMode(D, "goal")).toBe(false);
    await flush();
    expect(record(storage)).toMatchObject({ reply: "m1", mode: "chat" });
  });

  it("F14 an upgrade from 1.0.4 with sends in flight: a matching snapshot becomes H with its reply; a non-matching one delivers undrafted", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const D2 = "bot:b1:t2";
    const legacy = (sendId: string, draftId: string, text: string, threadId: string, replyToId?: string) => ({
      sendId, kind: "bot", botId: "b1", threadId, text, at: 1, attempts: 0,
      draft: { draftId, text, requestText: text, attachments: [], ...(replyToId ? { replyToId } : {}) },
    });
    storage.setItem("murage-drafts", JSON.stringify({ [D]: "hello", [D2]: "hello world" }));
    storage.setItem("murage-send-outbox", JSON.stringify([legacy("s-old", D, "hello", "t1", "m1"), legacy("s-two", D2, "hello", "t2")]));
    const a = await openTab(storage, locks);
    expect(a.mod.readComposerDraft(D)).toMatchObject({ text: "hello", reply: "m1", held: true });
    await a.mod.migrateLegacyDrafts();
    expect(record(storage)).toMatchObject({ text: "hello", reply: "m1", pin: { s: "s-old" }, out: { a: "legacy", entry: { sendId: "s-old" } } });
    expect(record(storage, D2)).toMatchObject({ text: "hello world", pin: { s: "s-two", fp: "legacy" } });
    expect(record(storage, D2).out).toBeUndefined();
    const outbox = JSON.parse(storage.getItem("murage-send-outbox")!);
    expect(outbox.map((entry: { sendId: string }) => entry.sendId)).toEqual(["s-two"]);
    expect(outbox[0].draft).toBeUndefined();
    expect(JSON.parse(storage.getItem("murage-drafts") ?? "{}")).toEqual({});
    const { createOutbox } = await import("../state/send-delivery");
    const listed = createOutbox(storage, a.mod.draftJournal).list();
    expect(listed.map((entry) => entry.sendId).sort()).toEqual(["s-old", "s-two"]);
    expect(listed.find((entry) => entry.sendId === "s-two")?.draft).toBeUndefined();
    // the late ack of the edited draft's old send never clears the edit
    await a.mod.settleDraftSend(undefined, "s-two", undefined, "acked");
    expect(record(storage, D2).text).toBe("hello world");
  });

  it("F15 a confirmed refused chip settles refused(s): the matching words go (the chip owns them) and the pin retires", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const begun = await sent(a, "chip words");
    a.mod.noteRefusedChips(new Set([begun.sendId]));
    await flush();
    expect(record(storage)).toMatchObject({ text: "", last: { s: begun.sendId, o: "refused" } });
    expect(record(storage).pin).toBeUndefined();
    // and from P
    const second = await sent(a, "chip again");
    await a.mod.settleDraftSend(D, second.sendId, second.attemptId, "failed");
    a.mod.releaseRecoveredSend(second.sendId);
    await flush();
    expect(record(storage)).toMatchObject({ text: "", last: { s: second.sendId, o: "refused" } });
  });

  it("F16 a conversation deleted mid-send: the record goes, delivery finds nothing, hooks settle gone, nothing comes back", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const begun = await sent(a, "deleted words");
    const seen: string[] = [];
    a.mod.watchDraftSend(D, begun.sendId, begun.attemptId, (outcome) => seen.push(outcome));
    a.mod.forgetDeletedDrafts({ threadId: "t1" });
    expect(storage.getItem(`murage-draft:${D}`)).toBeNull();
    expect(seen).toEqual(["gone"]);
    expect(a.mod.draftJournal.entries()).toEqual([]);
    expect(await a.mod.settleDraftSend(D, begun.sendId, begun.attemptId, "failed")).toBe(false);
    expect(a.mod.setComposerDraftText(D, "typed after delete")).toBe(false);
    await flush();
    expect(storage.getItem(`murage-draft:${D}`)).toBeNull();
  });

  it("F17 (A8) a keystroke queued behind the lock is in the snapshot Send writes; from the click the press holds the draft", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    let release!: () => void;
    void locks.request("murage-drafts", () => new Promise<void>((resolve) => { release = resolve; }));
    a.mod.setComposerDraftText(D, "hello wor");
    a.mod.setComposerDraftText(D, "hello world");
    const pressed = press(a);
    // the press hold: from the click, nothing else lands in the draft
    expect(a.mod.isDraftHeld(D)).toBe(true);
    expect(a.mod.setComposerDraftText(D, "hello world, more")).toBe(false);
    expect(a.mod.setComposerDraftReply(D, "m9")).toBe(false);
    expect(a.mod.setComposerDraftMode(D, "goal")).toBe(false);
    expect(a.mod.setComposerDraftAttachments(D, [file("late.png")])).toBe(false);
    await flush();
    release();
    const begun = await pressed;
    expect(begun.ok).toBe(true);
    expect(record(storage)).toMatchObject({ text: "hello world", mode: "chat", att: [], out: { entry: { text: "hello world" } } });
    expect(record(storage).reply).toBeUndefined();
  });

  it("F18 an old attempt's failure after Send again is a no-op; an ack of s settles the new attempt", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const first = await sent(a, "two attempts");
    await a.mod.settleDraftSend(D, first.sendId, first.attemptId, "failed");
    const second = await press(a);
    if (!second.ok) throw new Error("refused");
    expect(await a.mod.settleDraftSend(D, first.sendId, first.attemptId, "failed")).toBe(false);
    expect(record(storage).out.a).toBe(second.attemptId);
    await a.mod.settleDraftSend(D, first.sendId, undefined, "acked");
    expect(record(storage)).toMatchObject({ text: "", last: { s: first.sendId, a: second.attemptId, o: "acked" } });
  });

  it("F19 the reply lives in the record: another tab sends it, and the ack clears it with the words", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    a.mod.setComposerDraftReply(D, "m7");
    a.mod.setComposerDraftText(D, "a reply");
    await flush();
    const b = await openTab(storage, locks);
    expect(b.mod.readComposerDraft(D).reply).toBe("m7");
    const begun = await press(b);
    if (!begun.ok) throw new Error("refused");
    expect(record(storage).out.entry.replyToId).toBe("m7");
    await a.mod.settleDraftSend(D, begun.sendId, undefined, "acked");
    expect(record(storage).reply).toBeUndefined();
    expect(record(storage).text).toBe("");
  });

  it("F20 a pin the server no longer knows (404) stays P, and Send reuses it", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const first = await sent(a, "old pin");
    await a.mod.settleDraftSend(D, first.sendId, first.attemptId, "failed");
    a.mod.setDraftSendLookup(async () => "none");
    expect(await a.mod.checkDraftPin(D, first.sendId)).toBe("none");
    expect(record(storage).pin.s).toBe(first.sendId);
    const again = await press(a);
    expect(again.ok && again.sendId).toBe(first.sendId);
  });

  it("F21 after a 1.0.4 upgrade with edited words, a late ack of the old id never clears them, and the next Send checks it first", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    storage.setItem("murage-drafts", JSON.stringify({ [D]: "edited words" }));
    storage.setItem("murage-draft-send-ids", JSON.stringify({ [D]: "s-legacy" }));
    const a = await openTab(storage, locks);
    await a.mod.migrateLegacyDrafts();
    expect(record(storage).pin).toMatchObject({ s: "s-legacy", fp: "legacy" });
    const asked: string[] = [];
    a.mod.setDraftSendLookup(async (_t, sendId) => { asked.push(sendId); return "ack"; });
    await a.mod.checkPinnedDrafts();
    expect(asked).toEqual([]); // stale pins are not looked up at load, only at Send
    // the Send of the edit checks the old id first: it arrived, so this press is refused and the edit stays
    expect(await press(a)).toEqual({ ok: false, reason: "earlierArrived" });
    expect(asked).toEqual(["s-legacy"]);
    expect(record(storage).text).toBe("edited words");
    expect(record(storage).pin).toBeUndefined();
    // a late ack of that old id (a live frame, another tab) clears nothing either
    await a.mod.settleDraftSend(undefined, "s-legacy", undefined, "acked");
    expect(record(storage).text).toBe("edited words");
  });

  it("F22 Send again while the first POST is still out: the superseded attempt settles only itself; the new one runs after", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const { createOutbox, createSendDelivery } = await import("../state/send-delivery");
    const first = await sent(a, "supersede");
    let rejectFirst!: (error: unknown) => void;
    const posts: string[] = [];
    const delivery = createSendDelivery({
      outbox: createOutbox(storage, a.mod.draftJournal),
      post: (entry) => { posts.push(`${entry.sendId}/${entry.draft?.attemptId}`); return posts.length === 1 ? new Promise((_, reject) => { rejectFirst = reject; }) : Promise.resolve({ ok: true }); },
      now: () => Date.now(), setTimer: () => 0,
      showSending: () => {}, settleSending: () => {}, receipt: () => {}, recover: () => {},
    });
    const asEntry = (): OutboxEntry => a.mod.draftJournal.entries()[0] as OutboxEntry;
    void delivery.submit(asEntry());
    await flush();
    // the first attempt is given up elsewhere (another tab's deadline); the person presses Send again
    await a.mod.settleDraftSend(D, first.sendId, first.attemptId, "failed");
    const second = await press(a);
    if (!second.ok) throw new Error("refused");
    const done = delivery.submit(asEntry());
    await flush();
    expect(record(storage).out.a).toBe(second.attemptId);
    rejectFirst(Object.assign(new Error("dropped"), { status: 500 }));
    await done;
    await flush();
    expect(posts).toEqual([`${first.sendId}/${first.attemptId}`, `${first.sendId}/${second.attemptId}`]);
    expect(record(storage)).toMatchObject({ text: "", last: { s: first.sendId, a: second.attemptId, o: "acked" } });
  });

  it("F23 two tabs adding different attachments at the same n both keep theirs", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const b = await openTab(storage, locks);
    a.mod.setComposerDraftAttachments(D, (prev) => [...prev, file("a.png")]);
    b.mod.setComposerDraftAttachments(D, (prev) => [...prev, file("b.png")]);
    await flush();
    expect(record(storage).att.map((item: { id: string }) => item.id).sort()).toEqual(["a.png", "b.png"]);
  });

  it("F24 with storage refusing writes an undrafted send still delivers from memory, while a drafted one is refused at W1", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    a.mod.setComposerDraftText(D, "drafted");
    await flush();
    storage.state.refuse = true;
    const { createOutbox, createSendDelivery } = await import("../state/send-delivery");
    const posts: string[] = [];
    const delivery = createSendDelivery({
      outbox: createOutbox(storage, a.mod.draftJournal),
      post: async (entry) => { posts.push(entry.sendId); return { ok: true }; },
      now: () => Date.now(), setTimer: () => 0,
      showSending: () => {}, settleSending: () => {}, receipt: () => {}, recover: () => {},
    });
    await delivery.submit({ sendId: "undrafted-1", kind: "bot", botId: "b1", threadId: "t1", text: "/compact", at: Date.now(), attempts: 0 });
    expect(posts).toEqual(["undrafted-1"]);
    expect(await press(a)).toEqual({ ok: false, reason: "notSaved" });
  });

  it("F25 a stalled lookup runs outside the lock with a 5 s deadline: other drafts keep persisting; the press is refused", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    a.mod.setComposerDraftText(D, "stale");
    await vi.advanceTimersByTimeAsync(0);
    const first = await press(a);
    if (!first.ok) throw new Error("refused");
    await a.mod.settleDraftSend(D, first.sendId, first.attemptId, "failed");
    a.mod.setComposerDraftText(D, "stale, edited");
    await vi.advanceTimersByTimeAsync(0);
    a.mod.setDraftSendLookup(() => new Promise(() => {}));
    const pressed = press(a);
    await vi.advanceTimersByTimeAsync(10);
    a.mod.setComposerDraftText("bot:b1:other", "still typing elsewhere");
    expect(await a.mod.persistDraft("bot:b1:other")).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pressed).toEqual({ ok: false, reason: "checkFailed" });
    expect(record(storage)).toMatchObject({ text: "stale, edited", pin: { s: first.sendId } });
  });

  it("F26 a 2xx replay answering {cancelled:true} is cancelled(s): the words stay and the id is never reused", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const { createOutbox, createSendDelivery } = await import("../state/send-delivery");
    const first = await sent(a, "cancelled words");
    const delivery = createSendDelivery({
      outbox: createOutbox(storage, a.mod.draftJournal),
      post: async () => ({ ok: true, cancelled: true }),
      now: () => Date.now(), setTimer: () => 0,
      showSending: () => {}, settleSending: () => {}, receipt: () => {}, recover: () => {},
    });
    await delivery.submit(a.mod.draftJournal.entries()[0] as OutboxEntry);
    await flush();
    expect(record(storage)).toMatchObject({ text: "cancelled words", last: { s: first.sendId, o: "cancelled" } });
    expect(record(storage).pin).toBeUndefined();
    const again = await press(a);
    expect(again.ok && again.sendId !== first.sendId).toBe(true);
  });

  it("F27 an image reference while held whose `later` write fails is never reported as added", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const reference = await import("./image-reference");
    await sent(a, "held");
    const off = reference.registerComposerReferenceTarget({ threadId: "t1", draftId: D, botId: "b1" });
    storage.state.refuse = true;
    const name = "11111111-1111-4111-8111-111111111111.png";
    const request = async () => ({ reference: { id: name, sha256: "a".repeat(64), mime: "image/png", bytes: 68, source: "attachment" }, attachment: { path: `/data/attachments/${name}`, name, mime: "image/png", bytes: 68 } });
    const result = await reference.addImageReference({ source: { kind: "attachment", attachmentId: name } }, request);
    off();
    expect(result.status).toBe("not-saved");
    storage.state.refuse = false;
    expect(record(storage).later).toBeUndefined();
  });

  it("F28 a 409 with no refused chip (the channel switched tasks) is fail(s, a): H to P, the words stay", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const { createOutbox, createSendDelivery } = await import("../state/send-delivery");
    const begun = await sent(a, "switched");
    const recovered: string[] = [];
    const delivery = createSendDelivery({
      outbox: createOutbox(storage, a.mod.draftJournal),
      post: async () => { throw Object.assign(new Error("This channel switched tasks."), { status: 409 }); },
      now: () => Date.now(), setTimer: () => 0,
      showSending: () => {}, settleSending: () => {}, receipt: () => {}, recover: (entry) => recovered.push(entry.sendId),
    });
    await delivery.submit(a.mod.draftJournal.entries()[0] as OutboxEntry);
    await flush();
    expect(record(storage)).toMatchObject({ text: "switched", pin: { s: begun.sendId }, last: { o: "failed" } });
    expect(record(storage).out).toBeUndefined();
    expect(recovered).toEqual([]);
  });

  it("F29 a 1.0.4 upgrade with edited words and an outbox entry but no saved send id: the entry's id is a legacy pin", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    storage.setItem("murage-drafts", JSON.stringify({ [D]: "edited after send" }));
    storage.setItem("murage-send-outbox", JSON.stringify([{ sendId: "s-x", kind: "bot", botId: "b1", threadId: "t1", text: "original", at: 1, attempts: 0, draft: { draftId: D, text: "original", requestText: "original", attachments: [] } }]));
    const a = await openTab(storage, locks);
    await a.mod.migrateLegacyDrafts();
    expect(record(storage)).toMatchObject({ text: "edited after send", pin: { s: "s-x", fp: "legacy" } });
    // the outbox entry delivers once, undrafted; its id never clears the edit
    expect(JSON.parse(storage.getItem("murage-send-outbox")!)).toEqual([expect.objectContaining({ sendId: "s-x" })]);
    expect(JSON.parse(storage.getItem("murage-send-outbox")!)[0].draft).toBeUndefined();
    const asked: string[] = [];
    a.mod.setDraftSendLookup(async (_t, sendId) => { asked.push(sendId); return "none"; });
    const begun = await press(a);
    expect(asked).toEqual(["s-x"]);
    expect(begun.ok && begun.sendId !== "s-x").toBe(true);
    expect(record(storage).text).toBe("edited after send");
    // and a late ack of the old id, in another tab, finds no record that holds it
    const b = await openTab(storage, locks);
    expect(await b.mod.settleDraftSend(undefined, "s-x", undefined, "acked")).toBe(false);
    expect(record(storage).text).toBe("edited after send");
  });

  it("F30 an append racing another tab's W1 picks its target from the record read inside the lock", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const b = await openTab(storage, locks);
    a.mod.setComposerDraftText(D, "racing");
    await flush();
    b.hear(D);
    expect(a.mod.isDraftHeld(D)).toBe(false);
    const [begun, appended] = await Promise.all([press(b), a.mod.appendComposerDraftAttachments(D, [file("race.png")])]);
    if (!begun.ok) throw new Error("refused");
    expect(appended).toBe(true);
    expect(record(storage).later).toEqual([file("race.png")]);
    expect(record(storage).att).toEqual([]);
    await b.mod.settleDraftSend(D, begun.sendId, undefined, "acked");
    expect(record(storage).att).toEqual([file("race.png")]);
  });
});

// Code review round 1 (design section 12). Each case names its finding and F row. Unless it says "fails on base", a case
// fails on 68b9631b1 (the first build of this lane): the finding was a gap in that build.
describe("U36 code review round 1", () => {
  const key = `murage-draft:${D}`;
  const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("F32 (A1) without Web Locks a W1 another tab overwrote inside the verify window is a lost press: nothing posts from here", async () => {
    const storage = sharedStorage();
    const a = await openTab(storage, null);
    a.mod.setComposerDraftText(D, "racing");
    await flush();
    const pressed = press(a);
    await flush(1);
    const ours = record(storage);
    expect(ours.out).toBeDefined();
    // the other tab read E before our write (its cached copy) and wrote its own W1 after ours
    storage.setItem(key, JSON.stringify({ ...ours, out: { ...ours.out, a: "their-attempt" } }));
    expect(await pressed).toEqual({ ok: false, reason: "held" });
    expect(record(storage).out.a).toBe("their-attempt");
    expect(a.mod.isDraftHeld(D)).toBe(true);
    expect(a.mod.draftJournal.entries().map((entry) => entry.draft?.attemptId)).toEqual(["their-attempt"]);
  });

  it("F32 (A1) without Web Locks a settle another tab overwrote is applied again to what that tab wrote", async () => {
    const storage = sharedStorage();
    const a = await openTab(storage, null);
    a.mod.setComposerDraftText(D, "settle twice");
    await flush();
    const begun = await press(a);
    if (!begun.ok) throw new Error(`press refused: ${begun.reason}`);
    const held = record(storage);
    const settling = a.mod.settleDraftSend(D, begun.sendId, undefined, "acked");
    await later(a.mod.DRAFT_VERIFY_WINDOW_MS / 2);
    // another tab's attempt count write, from a read made before our settle, puts H back
    storage.setItem(key, JSON.stringify({ ...held, out: { ...held.out, entry: { ...held.out.entry, attempts: 1 } } }));
    expect(await settling).toBe(true);
    expect(record(storage)).toMatchObject({ text: "", last: { s: begun.sendId, o: "acked" } });
    expect(record(storage).out).toBeUndefined();
  });

  it("F33 (A2) a removal in another tab is gone here: hooks settle gone, nothing is written again unless the owner is still listed", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const b = await openTab(storage, locks);
    const begun = await sent(a, "to delete");
    b.hear(D);
    b.mod.setDraftOwnerCheck(() => false);
    const seen: string[] = [];
    b.mod.watchDraftSend(D, begun.sendId, begun.attemptId, (outcome) => seen.push(outcome));
    await a.mod.forgetDeletedDrafts({ threadId: "t1" });
    b.hear(D);
    expect(seen).toEqual(["gone"]);
    expect(b.mod.isDraftHeld(D)).toBe(false);
    expect(b.mod.setComposerDraftText(D, "typed in b")).toBe(false);
    expect(await b.mod.appendComposerDraftAttachments(D, [file("x.png")])).toBe(false);
    expect(await b.mod.settleDraftSend(D, begun.sendId, begun.attemptId, "failed")).toBe(false);
    expect(await press(b)).toEqual({ ok: false, reason: "gone" });
    await flush();
    expect(storage.getItem(key)).toBeNull();
    // storage was cleared but the conversation is still listed: the owner re-validates and the draft is writable again
    b.mod.setDraftOwnerCheck(() => true);
    expect(b.mod.setComposerDraftText(D, "still here")).toBe(true);
    await flush();
    expect(record(storage).text).toBe("still here");
  });

  it("F33 (A2) deletion runs under the lock too: a tab that read the record before the delete and wrote it back is undone", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const b = await openTab(storage, locks);
    a.mod.setComposerDraftText(D, "words");
    await flush();
    b.hear(D);
    let release!: () => void;
    void locks.request("murage-drafts", () => new Promise<void>((resolve) => { release = resolve; }));
    b.mod.setComposerDraftText(D, "words, edited in b");
    await flush(1); // b's persist waits behind the lock; it has not heard the delete yet
    const deleted = a.mod.forgetDeletedDrafts({ threadId: "t1" });
    expect(storage.getItem(key)).toBeNull();
    release();
    await deleted;
    await flush();
    expect(storage.getItem(key)).toBeNull();
  });

  it("F34 (A3) the starter suggestion fills a draft only if it is empty inside the lock: words that landed first are kept", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const b = await openTab(storage, locks);
    const suggest = (current: { text: string; att: unknown[] }) => (current.text || current.att.length ? null : { text: "a suggestion", attachments: [] });
    let release!: () => void;
    void locks.request("murage-drafts", () => new Promise<void>((resolve) => { release = resolve; }));
    b.mod.setComposerDraftText(D, "my own words");
    await flush(1); // b's edit is queued ahead of the restore
    expect(a.mod.readComposerDraft(D).text).toBe(""); // what a check outside the lock would have seen
    const restored = a.mod.restoreComposerDraftIfEmpty(D, suggest);
    release();
    expect(await restored).toBe(true);
    expect(record(storage).text).toBe("my own words");
    // an empty draft is filled
    expect(await a.mod.restoreComposerDraftIfEmpty("bot:b1:t3", suggest)).toBe(true);
    expect(record(storage, "bot:b1:t3").text).toBe("a suggestion");
  });

  it("F35 (A4) an append dedupes only against where it is stored: one being sent is kept for the next draft, a pending-only one is written", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    a.mod.setComposerDraftAttachments(D, [file("held.png")]);
    const begun = await sent(a, "with a file");
    expect(record(storage).out).toBeDefined();
    expect(await a.mod.appendComposerDraftAttachments(D, [file("held.png")])).toBe(true);
    expect(record(storage).later).toEqual([file("held.png")]);
    await a.mod.settleDraftSend(D, begun.sendId, undefined, "acked");
    expect(record(storage)).toMatchObject({ text: "", att: [file("held.png")] });
    // a chip only in this tab's unsaved edits (its persist was refused) is written by the append, never assumed stored
    const D2 = "bot:b1:t2";
    storage.state.refuse = (k) => k === `murage-draft:${D2}`;
    a.mod.setComposerDraftAttachments(D2, [file("pending.png")]);
    await flush();
    expect(storage.getItem(`murage-draft:${D2}`)).toBeNull();
    storage.state.refuse = false;
    expect(await a.mod.appendComposerDraftAttachments(D2, [file("pending.png")])).toBe(true);
    expect(record(storage, D2).att).toEqual([file("pending.png")]);
  });

  it("F36 (A5) a refused migration write leaves the legacy entry with delivery, refuses Send with notSaved, and is retried on online", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    storage.setItem("murage-drafts", JSON.stringify({ [D]: "hello" }));
    storage.setItem("murage-send-outbox", JSON.stringify([{ sendId: "s-old", kind: "bot", botId: "b1", threadId: "t1", text: "hello", at: 1, attempts: 0, draft: { draftId: D, text: "hello", requestText: "hello", attachments: [] } }]));
    storage.state.refuse = (k) => k.startsWith("murage-draft:");
    const a = await openTab(storage, locks);
    await a.mod.migrateLegacyDrafts();
    expect(record(storage)).toBeNull();
    const { createOutbox } = await import("../state/send-delivery");
    // delivery still owns it: it is listed, so it is delivered (once, the server dedupes s-old)
    expect(createOutbox(storage, a.mod.draftJournal).list().map((entry) => entry.sendId)).toEqual(["s-old"]);
    expect(await press(a)).toEqual({ ok: false, reason: "notSaved" });
    storage.state.refuse = false;
    a.win.dispatchEvent(new Event("online"));
    await flush();
    expect(record(storage)).toMatchObject({ text: "hello", out: { a: "legacy", entry: { sendId: "s-old" } } });
  });

  it("F37 (A6) the press reservation lives in drafts: while a press waits on its lookup, edits are refused and an append waits in `later`", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const first = await sent(a, "v1");
    await a.mod.settleDraftSend(D, first.sendId, first.attemptId, "failed");
    a.mod.setComposerDraftText(D, "v2");
    await flush();
    let answer!: (result: "none") => void;
    a.mod.setDraftSendLookup(() => new Promise((resolve) => { answer = resolve; }));
    const pressed = press(a);
    await flush();
    expect(a.mod.isDraftHeld(D)).toBe(true);
    expect(a.mod.setComposerDraftReply(D, "m2")).toBe(false);
    expect(await a.mod.appendComposerDraftAttachments(D, [file("during.png")])).toBe(true);
    expect(record(storage)).toMatchObject({ att: [], later: [file("during.png")] });
    answer("none");
    const begun = await pressed;
    if (!begun.ok) throw new Error(`press refused: ${begun.reason}`);
    expect(record(storage)).toMatchObject({ text: "v2", att: [], later: [file("during.png")], out: { a: begun.attemptId } });
    expect(record(storage).reply).toBeUndefined();
    await a.mod.settleDraftSend(D, begun.sendId, undefined, "acked");
    expect(record(storage)).toMatchObject({ text: "", att: [file("during.png")] });
    // a press that is refused folds what arrived during it into the draft
    const second = await sent(a, "w1");
    await a.mod.settleDraftSend(D, second.sendId, second.attemptId, "failed");
    a.mod.setComposerDraftText(D, "w2");
    await flush();
    let fail!: (error: unknown) => void;
    a.mod.setDraftSendLookup(() => new Promise((_, reject) => { fail = reject; }));
    const refused = press(a);
    await flush();
    expect(await a.mod.appendComposerDraftAttachments(D, [file("during2.png")])).toBe(true);
    fail(new Error("offline"));
    expect(await refused).toEqual({ ok: false, reason: "checkFailed" });
    await flush();
    expect(record(storage).att.map((item: { id: string }) => item.id)).toEqual(["during.png", "during2.png"]);
    expect(record(storage).later).toBeUndefined();
    expect(a.mod.isDraftHeld(D)).toBe(false);
  });

  it("F38 (A7) another tab acks while this tab's POST is out and then fails for a moment: this tab's hooks and Sending settle", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const b = await openTab(storage, locks);
    const begun = await sent(a, "two tabs");
    const { createOutbox, createSendDelivery } = await import("../state/send-delivery");
    let rejectPost!: (error: unknown) => void;
    const timers: Array<() => void> = [];
    const settledSending: string[] = [];
    const delivery = createSendDelivery({
      outbox: createOutbox(storage, a.mod.draftJournal),
      post: () => new Promise((_, reject) => { rejectPost = reject; }),
      now: () => Date.now(), setTimer: (fn) => { timers.push(fn); return 0; },
      showSending: () => {}, settleSending: (entry) => settledSending.push(entry.sendId), receipt: () => {}, recover: () => {},
    });
    const got: string[] = [];
    void delivery.submit(a.mod.draftJournal.entries()[0] as OutboxEntry, {
      onReceipt: () => got.push("receipt"), onGone: () => got.push("gone"), onFailed: () => { got.push("failed"); return true; },
    });
    await flush();
    await b.mod.settleDraftSend(undefined, begun.sendId, undefined, "acked"); // a live frame in tab b
    a.hear(D);
    rejectPost(Object.assign(new Error("dropped"), { status: 503 }));
    await flush();
    for (const timer of timers.splice(0)) timer();
    await flush();
    expect(got).toEqual(["receipt"]);
    expect(settledSending).toContain(begun.sendId);
    expect(delivery.audit()).toEqual([]);
    expect(record(storage)).toMatchObject({ text: "", last: { s: begun.sendId, o: "acked" } });
  });

  it("F39 (B2, A8 F25) a lookup result is dropped when, during the GET, the words were edited (stale pin) or a new Send began (n)", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const first = await sent(a, "looked up");
    await a.mod.settleDraftSend(D, first.sendId, first.attemptId, "failed");
    let answer!: (result: "ack") => void;
    a.mod.setDraftSendLookup(() => new Promise((resolve) => { answer = resolve; }));
    const checking = a.mod.checkDraftPin(D, first.sendId);
    await flush();
    a.mod.setComposerDraftText(D, "looked up, edited");
    await flush();
    answer("ack");
    expect(await checking).toBe("dropped");
    expect(record(storage)).toMatchObject({ text: "looked up, edited", pin: { s: first.sendId } });
    // a stale pin is not looked up at all
    expect(await a.mod.checkDraftPin(D, first.sendId)).toBe("dropped");
    // n moved during the GET: the press went out with the same id, so the answer is not applied to the new cycle
    a.mod.setComposerDraftText(D, "looked up");
    await flush();
    const again = a.mod.checkDraftPin(D, first.sendId);
    await flush();
    const begun = await press(a);
    if (!begun.ok) throw new Error(`press refused: ${begun.reason}`);
    answer("ack");
    expect(await again).toBe("dropped");
    expect(record(storage).out.a).toBe(begun.attemptId);
  });

  it("A8 F25 a load-check lookup that failed is tried again on `online` and applies then (fails on base)", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const first = await sent(a, "offline at load");
    await a.mod.settleDraftSend(D, first.sendId, first.attemptId, "failed");
    const reloaded = await openTab(storage, locks);
    reloaded.mod.setDraftSendLookup(async () => { throw new Error("offline"); });
    await reloaded.mod.checkPinnedDrafts();
    expect(record(storage)).toMatchObject({ text: "offline at load", pin: { s: first.sendId } });
    reloaded.mod.setDraftSendLookup(async () => "ack");
    reloaded.win.dispatchEvent(new Event("online"));
    await flush();
    expect(record(storage)).toMatchObject({ text: "", last: { s: first.sendId, o: "acked" } });
    expect(record(storage).pin).toBeUndefined();
  });

  it("A8 a P record found at load whose send the server has (lookup: ack) is cleared on disk (fails on base)", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const first = await sent(a, "arrived after all");
    await a.mod.settleDraftSend(D, first.sendId, first.attemptId, "failed");
    const reloaded = await openTab(storage, locks);
    const asked: string[] = [];
    reloaded.mod.setDraftSendLookup(async (_t, sendId) => { asked.push(sendId); return "ack"; });
    await reloaded.mod.checkPinnedDrafts();
    expect(asked).toEqual([first.sendId]);
    expect(record(storage)).toMatchObject({ text: "", last: { s: first.sendId, o: "acked" } });
    expect(record(storage).pin).toBeUndefined();
  });

  it("A8 an H past the 10 min deadline after a reload goes to P and its lookup runs; an arrived send is cleared on disk (fails on base)", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    a.mod.setComposerDraftText(D, "very old send");
    await flush();
    const begun = await a.mod.beginDraftSend(D, { text: "very old send", att: [], mode: "chat" }, (sendId, content) => ({ ...build(sendId, content), at: 1 }));
    if (!begun.ok) throw new Error(`press refused: ${begun.reason}`);
    const reloaded = await openTab(storage, locks);
    const asked: string[] = [];
    reloaded.mod.setDraftSendLookup(async (_t, sendId) => { asked.push(sendId); return "ack"; });
    const { createOutbox, createSendDelivery } = await import("../state/send-delivery");
    const post = vi.fn(async () => ({ ok: true }));
    const delivery = createSendDelivery({
      outbox: createOutbox(storage, reloaded.mod.draftJournal), post, now: () => Date.now(), setTimer: () => 0,
      showSending: () => {}, settleSending: () => {}, receipt: () => {}, recover: () => {},
    });
    delivery.reconcile({ messageSendIds: new Set(), pendingSendIds: new Set() });
    await flush();
    expect(post).not.toHaveBeenCalled();
    expect(asked).toEqual([begun.sendId]);
    expect(record(storage)).toMatchObject({ text: "", last: { s: begun.sendId, o: "acked" } });
    expect(record(storage).out).toBeUndefined();
    expect(record(storage).pin).toBeUndefined();
  });

  it("A8 the overall deadline, drafted: every attempt hangs, and past it the record goes to P with its words and send id (fails on base)", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const begun = await sent(a, "hanging words");
    const { createOutbox, createSendDelivery, OUTBOX_GIVE_UP_MS } = await import("../state/send-delivery");
    const clock = { now: Date.now() };
    const fires: Array<() => void> = [];
    const timers: Array<() => void> = [];
    const recovered: string[] = [];
    const delivery = createSendDelivery({
      outbox: createOutbox(storage, a.mod.draftJournal),
      post: () => new Promise(() => {}),
      now: () => clock.now,
      setTimer: (fn) => { timers.push(fn); return 0; },
      attemptTimer: (fn) => { fires.push(fn); return () => {}; },
      showSending: () => {}, settleSending: () => {}, receipt: () => {}, recover: (entry) => recovered.push(entry.sendId),
    });
    const first = delivery.submit(a.mod.draftJournal.entries()[0] as OutboxEntry);
    await flush();
    clock.now += OUTBOX_GIVE_UP_MS + 1;
    fires[0]!();
    await first;
    await flush();
    expect(record(storage)).toMatchObject({ text: "hanging words", pin: { s: begun.sendId }, last: { s: begun.sendId, a: begun.attemptId, o: "failed" } });
    expect(record(storage).out).toBeUndefined();
    expect(recovered).toEqual([]);
    expect(timers).toHaveLength(0);
  });

  it("B6 F11 a settle the storage refused is retried by the 30 s timer alone (fails on base)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    a.mod.setComposerDraftText(D, "retry me");
    await vi.advanceTimersByTimeAsync(0);
    const begun = await press(a);
    if (!begun.ok) throw new Error(`press refused: ${begun.reason}`);
    storage.state.refuse = true;
    expect(await a.mod.settleDraftSend(D, begun.sendId, undefined, "acked")).toBe(false);
    storage.state.refuse = false;
    await vi.advanceTimersByTimeAsync(a.mod.DRAFT_SETTLE_RETRY_MS - 1);
    expect(record(storage).out).toBeDefined();
    expect(a.mod.isDraftHeld(D)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(record(storage)).toMatchObject({ text: "", last: { s: begun.sendId, o: "acked" } });
    expect(record(storage).out).toBeUndefined();
  });

  it("F40 (B3) a 1.0.4 draft with an empty box takes no legacy pin: the next Send asks nothing", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    storage.setItem("murage-draft-send-ids", JSON.stringify({ [D]: "s-empty" }));
    const a = await openTab(storage, locks);
    await a.mod.migrateLegacyDrafts();
    expect(record(storage)?.pin).toBeUndefined();
    const asked: string[] = [];
    a.mod.setDraftSendLookup(async (_t, sendId) => { asked.push(sendId); return "ack"; });
    const begun = await sent(a, "brand new words");
    expect(asked).toEqual([]);
    expect(begun.sendId).not.toBe("s-empty");
  });
});

describe("U36 code review round 2", () => {
  const key = `murage-draft:${D}`;
  const legacyOutbox = () => JSON.stringify([{ sendId: "s-old", kind: "bot", botId: "b1", threadId: "t1", text: "hello", at: 1, attempts: 0, draft: { draftId: D, text: "hello", requestText: "hello", attachments: [] } }]);

  it("F41 (C1) a 1.0.4 entry delivered undrafted while its migration is refused keeps its draft: the ack waits, then clears the words on disk (fails on base)", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    storage.setItem("murage-drafts", JSON.stringify({ [D]: "hello" }));
    storage.setItem("murage-send-outbox", legacyOutbox());
    storage.state.refuse = (k) => k.startsWith("murage-draft:");
    const a = await openTab(storage, locks);
    await a.mod.migrateLegacyDrafts();
    const { createOutbox } = await import("../state/send-delivery");
    const outbox = createOutbox(storage, a.mod.draftJournal);
    const [entry] = outbox.list();
    expect(entry).toMatchObject({ sendId: "s-old", legacyDraft: { draftId: D } });
    expect(entry.draft).toBeUndefined();
    outbox.settle(entry, "acked");
    await flush();
    // its record is not on disk yet: the entry (the sendId -> draft link) stays, and nothing is cleared
    expect(outbox.has("s-old")).toBe(true);
    expect(record(storage)).toBeNull();
    storage.state.refuse = false;
    a.win.dispatchEvent(new Event("online"));
    await flush();
    expect(record(storage)).toMatchObject({ text: "", last: { s: "s-old", o: "acked" } });
    expect(record(storage).pin).toBeUndefined();
    expect(outbox.has("s-old")).toBe(false);
  });

  it("F42 (C2) a deleted record is gone inside the lock, and a removal event wins over a re-read (fails on base)", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const b = await openTab(storage, locks);
    a.mod.setComposerDraftText(D, "words");
    await flush();
    b.hear(D);
    expect(b.mod.readComposerDraft(D).text).toBe("words");
    b.mod.setDraftOwnerCheck(() => false);
    await a.mod.forgetDeletedDrafts({ threadId: "t1" });
    // b has not heard the delete yet: its edit finds the record it knew missing under the lock and writes nothing
    b.mod.setComposerDraftText(D, "typed in b");
    await flush();
    expect(storage.getItem(key)).toBeNull();
    expect(b.mod.setComposerDraftText(D, "again in b")).toBe(false);
    // a tab that put the key back before the event arrived: the event says removed, so it is removed again
    const c = await openTab(storage, locks);
    c.mod.setDraftOwnerCheck(() => false);
    c.mod.setComposerDraftText(D, "typed in c");
    await flush();
    expect(record(storage).text).toBe("typed in c");
    c.win.dispatchEvent(Object.assign(new Event("storage"), { key, newValue: null }));
    await flush();
    expect(storage.getItem(key)).toBeNull();
    expect(c.mod.setComposerDraftText(D, "again in c")).toBe(false);
  });

  it("F43 (C3) without Web Locks another tab's append to `later` inside the verify window keeps this press: it sends and adopts that attachment (fails on base)", async () => {
    const storage = sharedStorage();
    const a = await openTab(storage, null);
    a.mod.setComposerDraftText(D, "racing");
    await flush();
    const pressed = press(a);
    await flush(1);
    const ours = record(storage);
    expect(ours.out).toBeDefined();
    storage.setItem(key, JSON.stringify({ ...ours, later: [file("other.png")] }));
    expect(await pressed).toMatchObject({ ok: true, sendId: ours.out.entry.sendId, attemptId: ours.out.a });
    expect(a.mod.draftJournal.entries().map((entry) => entry.draft?.attemptId)).toEqual([ours.out.a]);
    expect(await a.mod.settleDraftSend(D, ours.out.entry.sendId, undefined, "acked")).toBe(true);
    expect(record(storage)).toMatchObject({ text: "", att: [file("other.png")] });
  });

  it("F44 (C4) a send reconcile reposts after a reload: another tab acks it while the POST is out, and its Sending line settles (fails on base)", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    const begun = await sent(a, "reloaded");
    const reloaded = await openTab(storage, locks);
    const other = await openTab(storage, locks);
    const { createOutbox, createSendDelivery } = await import("../state/send-delivery");
    let rejectPost!: (error: unknown) => void;
    const timers: Array<() => void> = [];
    const shown: string[] = [], settled: string[] = [];
    const delivery = createSendDelivery({
      outbox: createOutbox(storage, reloaded.mod.draftJournal),
      post: () => new Promise((_, reject) => { rejectPost = reject; }),
      now: () => Date.now(), setTimer: (fn) => { timers.push(fn); return 0; },
      showSending: (entry) => shown.push(entry.sendId), settleSending: (entry) => settled.push(entry.sendId), receipt: () => {}, recover: () => {},
    });
    delivery.reconcile({ messageSendIds: new Set(), pendingSendIds: new Set() });
    await flush();
    expect(shown).toEqual([begun.sendId]);
    await other.mod.settleDraftSend(undefined, begun.sendId, undefined, "acked");
    reloaded.hear(D);
    rejectPost(Object.assign(new Error("dropped"), { status: 503 }));
    await flush();
    for (const timer of timers.splice(0)) timer();
    await flush();
    expect(settled).toContain(begun.sendId);
    expect(delivery.audit()).toEqual([]);
  });

  it("F45 (C5) attachments left in `later` with no send out join the draft at load, and a fold the storage refused is tried again (fails on base)", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    a.mod.setComposerDraftText(D, "crashed mid press");
    await flush();
    storage.setItem(key, JSON.stringify({ ...record(storage), later: [file("orphan.png")] }));
    const reloaded = await openTab(storage, locks);
    await reloaded.mod.migrateLegacyDrafts();
    expect(record(storage)).toMatchObject({ text: "crashed mid press", att: [file("orphan.png")] });
    expect(record(storage).later).toBeUndefined();
    storage.setItem(key, JSON.stringify({ ...record(storage), later: [file("second.png")] }));
    storage.state.refuse = (k) => k === key;
    await reloaded.mod.migrateLegacyDrafts();
    expect(record(storage).later).toEqual([file("second.png")]);
    storage.state.refuse = false;
    reloaded.win.dispatchEvent(new Event("online"));
    await flush();
    expect(record(storage).att.map((item: { id: string }) => item.id)).toEqual(["orphan.png", "second.png"]);
    expect(record(storage).later).toBeUndefined();
  });
});

describe("U36 code review round 3", () => {
  const key = `murage-draft:${D}`;

  it("F46 a 1.0.4 attempt's failure never settles a newer Send again of the same id: that attempt stays out and posts", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    storage.setItem("murage-drafts", JSON.stringify({ [D]: "hello" }));
    storage.setItem("murage-send-outbox", JSON.stringify([{ sendId: "s-old", kind: "bot", botId: "b1", threadId: "t1", text: "hello", at: 1, attempts: 0, draft: { draftId: D, text: "hello", requestText: "hello", attachments: [] } }]));
    storage.state.refuse = (k) => k.startsWith("murage-draft:");
    const a = await openTab(storage, locks);
    await a.mod.migrateLegacyDrafts();
    const { createOutbox } = await import("../state/send-delivery");
    const outbox = createOutbox(storage, a.mod.draftJournal);
    const [legacy] = outbox.list(); // delivered undrafted, its POST still out
    expect(legacy).toMatchObject({ sendId: "s-old", legacyDraft: { draftId: D } });
    storage.state.refuse = false;
    await a.mod.migrateLegacyDrafts();
    expect(record(storage)).toMatchObject({ text: "hello", out: { a: "legacy", entry: { sendId: "s-old" } } });
    // another tab fails the migrated attempt; the person presses Send again: same send id, a new attempt
    await a.mod.settleDraftSend(D, "s-old", "legacy", "failed");
    const again = await press(a);
    if (!again.ok) throw new Error(`press refused: ${again.reason}`);
    expect(again.sendId).toBe("s-old");
    // now the 1.0.4 POST fails: it is about the "legacy" attempt only
    outbox.settle(legacy, "failed");
    await flush();
    expect(record(storage)).toMatchObject({ text: "hello", out: { a: again.attemptId } });
    expect(a.mod.draftJournal.entries().map((entry) => entry.draft?.attemptId)).toEqual([again.attemptId]);
    // and its ack (the server has s-old) still settles whatever holds the send id
    outbox.settle(legacy, "acked");
    await flush();
    expect(record(storage)).toMatchObject({ text: "", last: { s: "s-old", o: "acked" } });
  });

  it("a known record whose read throws is not a deletion: the edit stays and lands once storage reads again", async () => {
    const storage = sharedStorage(), locks = sharedLocks();
    const a = await openTab(storage, locks);
    a.mod.setComposerDraftText(D, "kept");
    await flush();
    const getItem = storage.getItem;
    storage.getItem = (k: string) => { if (k === key) throw new Error("SecurityError"); return getItem(k); };
    expect(a.mod.setComposerDraftText(D, "kept, edited")).toBe(true);
    await flush();
    storage.getItem = getItem;
    expect(record(storage).text).toBe("kept");
    expect(a.mod.setComposerDraftText(D, "kept, edited twice")).toBe(true);
    await flush();
    expect(record(storage).text).toBe("kept, edited twice");
  });
});
