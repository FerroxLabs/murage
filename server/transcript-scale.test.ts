// Lane E (1.0.2 scale): bounded transcript work. The loaded-thread cache is an
// LRU, turn prep and terminal capture stop early instead of materialising the
// whole thread, and quote targets resolve one id at a time.
import { statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { database } from "./database.ts";
import { promptRows } from "./external-context-delivery.ts";
import { botMessages, botViewer } from "./bot-read.ts";
import { promptQuoteTargets } from "./prompt-quotes.ts";
import { Store, type Message } from "./store.ts";
import { LruMap } from "./thread-cache.ts";
import { wholeTurnText } from "./memory/capture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("LruMap", () => {
  it("evicts the least recently used entry past the entry cap", () => {
    const lru = new LruMap<string>(2, 1_000, () => 1);
    lru.set("a", "A").set("b", "B");
    lru.get("a");
    lru.set("c", "C");
    expect(lru.keys()).toEqual(["a", "c"]);
  });

  it("evicts past the byte cap but never the entry just inserted", () => {
    const lru = new LruMap<number>(10, 100, (n) => n);
    lru.set("a", 60).set("b", 60);
    expect(lru.keys()).toEqual(["b"]);
    lru.set("huge", 500);
    expect(lru.keys()).toEqual(["huge"]);
    expect(lru.bytes).toBe(500);
    lru.delete("huge");
    expect(lru.bytes).toBe(0);
  });
});

describe("Store transcript scale", () => {
  beforeEach(() => removeTempDirSync(DATA_DIR));

  function thread(store: Store, count: number): { threadId: string; ids: string[] } {
    const bot = store.createBot();
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(store.appendMessage(bot.threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `line ${i}` }).id);
    }
    return { threadId: bot.threadId, ids };
  }

  it("keeps at most the configured number of threads in memory and reloads an evicted one intact", () => {
    const store = new Store(selection);
    store.setThreadCacheLimits(2, 1 << 30);
    const threads = [store.createBot(), store.createBot(), store.createBot(), store.createBot()].map((bot) => bot.threadId);
    for (const id of threads) store.messagesFor(id);
    expect(store.cachedThreadIds()).toEqual(threads.slice(-2));
    const first = store.appendMessage(threads[0]!, { role: "user", kind: "text", text: "after eviction" });
    expect(store.cachedThreadIds().length).toBeLessThanOrEqual(2);
    expect(store.messagesFor(threads[0]!).at(-1)?.id).toBe(first.id);
  });

  it("walks the active branch exactly like an id-map walk, including across an abandoned fork", () => {
    const store = new Store(selection);
    const { threadId, ids } = thread(store, 12);
    // fork: a sibling of ids[8] built on ids[7], then the branch head moves back to ids[10]
    const fork = store.appendMessage(threadId, { role: "user", kind: "text", text: "fork", parentId: ids[7] });
    const rows = store.messagesFor(threadId);
    const viaMap = (leaf: string | null): string[] => {
      const byId = new Map(rows.map((m) => [m.id, m]));
      const out: string[] = [];
      for (let cur = leaf ? byId.get(leaf) : undefined; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) out.push(cur.id);
      return out.reverse();
    };
    expect(store.activePath(threadId).map((m) => m.id)).toEqual(viaMap(store.activeLeaf(threadId)));
    expect(store.activePath(threadId).map((m) => m.id)).toContain(fork.id);
    store.setActiveLeaf(threadId, ids[10]!);
    expect(store.activePath(threadId).map((m) => m.id)).toEqual(viaMap(store.activeLeaf(threadId)));
  });

  it("walkActivePath stops at the first match without touching older rows", () => {
    const store = new Store(selection);
    const { threadId, ids } = thread(store, 500);
    const seen: string[] = [];
    const stopped = store.walkActivePath(threadId, (m) => { seen.push(m.id); return seen.length === 3; });
    expect(stopped).toBe(true);
    expect(seen).toEqual([ids[499], ids[498], ids[497]]);
  });

  it("resolves a quote target through one indexed read and applies the same filters as the whole-thread map", () => {
    const store = new Store(selection);
    const { threadId, ids } = thread(store, 6);
    const action = store.appendMessage(threadId, { role: "user", kind: "text", text: "do a thing", inboundKind: "action" } as Partial<Message> as never);
    store.setThreadCacheLimits(1, 1 << 30);
    store.createBot();
    store.messagesFor(store.createBot().threadId); // evict the thread under test
    expect(store.cachedThreadIds()).not.toContain(threadId);
    for (const hasTools of [true, false]) {
      const lazy = promptQuoteTargets(store, database(), "no-bot", threadId, hasTools, []);
      const eager = new Map(promptRows(botMessages(database(), botViewer("no-bot"), threadId, store.messagesFor(threadId)), hasTools, []).map((m) => [m.id, m]));
      for (const id of [...ids, action.id, "missing"]) expect(lazy.get(id)?.id).toBe(eager.get(id)?.id);
    }
  });

  it("builds a turn's whole text from the turn's own rows on a long branch", () => {
    const store = new Store(selection);
    const { threadId } = thread(store, 300);
    const turnId = "turn-1";
    const from = { botId: "b1", name: "B" };
    store.appendMessage(threadId, { role: "bot", kind: "text", text: "first piece", turnId, from } as never);
    store.appendMessage(threadId, { role: "bot", kind: "activity", text: "tool", turnId, from } as never);
    const last = store.appendMessage(threadId, { role: "bot", kind: "text", text: "second piece", turnId, from } as never);
    expect(wholeTurnText(database(), threadId, last)).toBe("first piece\n\nsecond piece");
  });

  it("an old unanswered card does not widen the page: it rides beside it, cached or not", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const card = store.appendMessage(bot.threadId, { role: "bot", kind: "options", text: "May I?", card: { title: "May I?", options: [], requestId: "req-old", tool: "Bash" } } as never);
    for (let i = 0; i < 300; i++) store.appendMessage(bot.threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `line ${i}` });
    // the old head-span rule would have stretched the page back to the card
    expect(store.newestPageSpan(bot.threadId)).toBeGreaterThan(300);
    for (const cached of [false, true]) {
      const reader = new Store(selection);
      if (cached) reader.messagesFor(bot.threadId);
      expect(reader.branchHeadSpan(bot.threadId)).toBeLessThanOrEqual(1);
      const page = reader.messagePage(bot.threadId, 100)!;
      expect(page.messages).toHaveLength(100);
      expect(page.messages.some((m) => m.id === card.id)).toBe(false);
      expect(reader.openCardsOutside(bot.threadId, page.messages).map((m) => m.id)).toEqual([card.id]);
    }
  });

  it("answered cards, and cards inside the page, are not sent beside it", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.appendMessage(bot.threadId, { role: "bot", kind: "options", text: "old", card: { title: "old", options: [], requestId: "req-a", tool: "Bash", answered: "allow" } } as never);
    for (let i = 0; i < 150; i++) store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `line ${i}` });
    store.appendMessage(bot.threadId, { role: "bot", kind: "options", text: "new", card: { title: "new", options: [], requestId: "req-b", tool: "Bash" } } as never);
    const page = new Store(selection).messagePage(bot.threadId, 100)!;
    expect(new Store(selection).openCardsOutside(bot.threadId, page.messages)).toEqual([]);
  });
});

import { createTaskDelta, FULL_TASK_LIST_EVERY_MS } from "./task-delta.ts";
import { windowsNightly } from "./testing/windows-hosted.ts";

describe("roster bookkeeping and run anchors", () => {
  beforeEach(() => removeTempDirSync(DATA_DIR));
  const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);

  it("a roster save that changes nothing on disk writes nothing; a real change still does", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const save = () => (store as unknown as { saveBotsNow(): void }).saveBotsNow();
    const file = join(DATA_DIR, "bots.json");
    save();
    const written = statSync(file).mtimeMs;
    pause(); save(); pause();
    store.setActivity(bot.id, "working");
    save();
    expect(statSync(file).mtimeMs).toBe(written);
    store.patchBot(bot.id, { name: "Renamed" });
    save();
    expect(statSync(file).mtimeMs).toBeGreaterThan(written);
  });

  it("a run's anchor message is found without loading its thread, and matches the in-memory scan", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    for (let i = 0; i < 4; i++) { store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `row ${i}` }); pause(); }
    const fresh = new Store(selection);
    const warm = new Store(selection);
    const rows = warm.messagesFor(bot.threadId);
    const thresholds = [0, ...rows.map((m) => m.at), rows.at(-1)!.at + 1_000];
    for (const at of thresholds) {
      expect(fresh.firstMessageSince(bot.threadId, at)?.id).toBe(warm.firstMessageSince(bot.threadId, at)?.id);
    }
    expect(fresh.cachedThreadIds()).not.toContain(bot.threadId);
    expect(fresh.firstMessageSince(bot.threadId, rows.at(-1)!.at + 1_000)?.id).toBe(rows.at(-1)!.id);
  });
});

describe("bot frames carry changed tasks only", () => {
  const wired = (busy: boolean[]) => ({ id: "b", busy: busy.some(Boolean), tasks: busy.map((flag, i) => ({ threadId: `t${i}`, busy: flag, title: `Task ${i}` })) });
  type Built = { full: { tasks?: unknown[]; tasksSeq?: number }; delta?: { tasks?: unknown; tasksSeq: number; tasksDelta: { upsert: Array<{ threadId: string }>; count: number; base: number } } };

  it("numbers every frame; a negotiated stream gets only the changed rows, built on the previous number", () => {
    let clock = 1_000;
    const delta = createTaskDelta({ now: () => clock });
    const first = delta.frame("b", wired([false, false, false])) as Built;
    expect(first.full.tasks).toHaveLength(3);
    expect(first.full.tasksSeq).toBe(1);
    expect(first.delta).toBeUndefined();
    expect(delta.seq("b")).toBe(1);
    clock += 10;
    const next = delta.frame("b", wired([false, true, false])) as Built;
    // the whole list for every stream that did not ask for deltas (a 1.0.1 phone or companion)
    expect(next.full.tasks).toHaveLength(3);
    expect(next.delta!.tasks).toBeUndefined();
    expect(next.delta!.tasksDelta).toEqual({ upsert: [{ threadId: "t1", busy: true, title: "Task 1" }], count: 3, base: 1 });
    expect(next.delta!.tasksSeq).toBe(2);
    clock += 10;
    expect((delta.frame("b", wired([false, true, false])) as Built).delta).toMatchObject({ tasksDelta: { upsert: [], count: 3, base: 2 } });
  });

  it("falls back to the whole list when a task is added, removed or reordered, periodically, and when forced", () => {
    let clock = 1_000;
    const delta = createTaskDelta({ now: () => clock });
    delta.frame("b", wired([false, false]));
    expect((delta.frame("b", wired([false, false, false])) as Built).delta).toBeUndefined();
    const reordered = wired([false, false, false]);
    reordered.tasks.reverse();
    expect((delta.frame("b", reordered) as Built).delta).toBeUndefined();
    expect((delta.frame("b", reordered) as Built).delta).toBeDefined();
    expect((delta.frame("b", reordered, true) as Built).delta).toBeUndefined();
    clock += FULL_TASK_LIST_EVERY_MS + 1;
    expect((delta.frame("b", reordered) as Built).delta).toBeUndefined();
    delta.forget("b");
    expect((delta.frame("b", reordered) as Built).delta).toBeUndefined();
  });

  it("P2: an idle bot whose last frame was a delta gets its whole list on a timer, with no further bot event", () => {
    let clock = 1_000;
    const timers: Array<{ run: () => void; ms: number }> = [];
    const repaired: string[] = [];
    const delta = createTaskDelta({ now: () => clock, repair: (id) => repaired.push(id), setTimer: (run, ms) => timers.push({ run, ms }), clearTimer: () => {} });
    delta.frame("b", wired([false, false]));
    clock += 5_000;
    expect((delta.frame("b", wired([true, false])) as Built).delta).toBeDefined();
    expect((delta.frame("b", wired([false, false])) as Built).delta).toBeDefined();
    // one timer per bot, due when the whole list would have been due
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(FULL_TASK_LIST_EVERY_MS - 5_000);
    timers[0]!.run();
    expect(repaired).toEqual(["b"]);
    // the repair frame itself is whole for everyone
    expect((delta.frame("b", wired([false, false]), true) as Built).delta).toBeUndefined();
  });
});

describe("lane E review findings (ui-review/REPORT.md)", () => {
  beforeEach(() => removeTempDirSync(DATA_DIR));
  const ask = (requestId: string) => ({ role: "bot", kind: "options", text: "May I?", card: { title: "May I?", options: [], requestId, tool: "Bash" } }) as never;
  const lines = (store: Store, threadId: string, count: number, tag: string) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) ids.push(store.appendMessage(threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `${tag} ${i}` }).id);
    return ids;
  };
  const readers = (warm: boolean) => { const reader = new Store(selection); if (warm) reader.messagesFor(reader.bots[0]!.threadId); return reader; };

  it("P1: an open card on the active branch rides beside the page; one on a branch edited away from does not", () => {
    const store = new Store(selection);
    const { threadId } = store.createBot();
    const [root] = lines(store, threadId, 1, "start");
    const kept = store.appendMessage(threadId, ask("req-kept"));
    const [edited] = lines(store, threadId, 1, "question");
    const abandoned = store.appendMessage(threadId, ask("req-abandoned"));
    // the owner edits the question: the abandoned card is on the old fork
    store.branchMessage(threadId, edited!, "question, edited");
    lines(store, threadId, 150, "after");
    expect(root).toBeDefined();
    for (const warm of [false, true]) {
      const reader = readers(warm);
      const page = reader.messagePage(threadId, 100)!;
      expect(reader.openCardsOutside(threadId, page.messages).map((m) => m.id)).toEqual([kept.id]);
      // asked again once the branch grew: the remembered answer still holds
      reader.appendMessage(threadId, { role: "user", kind: "text", text: "more" });
      expect(reader.openCardsOutside(threadId, reader.messagePage(threadId, 100)!.messages).map((m) => m.id)).toEqual([kept.id]);
    }
    expect(abandoned.id).not.toBe(kept.id);
  });

  it("P1: switching back to an original branch after another fork passed 500 rows pages the selected branch", () => {
    const store = new Store(selection);
    const { threadId } = store.createBot();
    const original = lines(store, threadId, 10, "original");
    store.branchMessage(threadId, original[5]!, "fork");
    lines(store, threadId, 600, "fork");
    store.setActiveLeaf(threadId, original[9]!);
    // a row spliced in front of the head after the fork grew (text saved before a tool row)
    const spliced = store.insertMessageBefore(threadId, original[9]!, { role: "bot", kind: "text", text: "lead-in" });
    for (const warm of [false, true]) {
      const reader = readers(warm);
      expect(reader.branchHeadSpan(threadId)).toBeGreaterThan(500);
      const page = reader.branchPage(threadId, 100)!;
      expect(page.activeLeafId).toBe(original[9]);
      const byId = new Map(page.messages.map((m) => [m.id, m]));
      const walked: string[] = [];
      for (let cur = byId.get(page.activeLeafId!); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) walked.unshift(cur.id);
      // the selected branch, whole, from what the page holds: never the fork's rows
      expect(walked).toEqual(new Store(selection).activePath(threadId).map((m) => m.id));
      expect(walked.slice(-11)).toEqual([...original.slice(0, 9), spliced.id, original[9]]);
      expect(page.messages.length).toBeLessThanOrEqual(101);
    }
  });

  it("P2: transcripts that grow after loading stay under the byte cap, but a thread in flight is never evicted", () => {
    const store = new Store(selection);
    const bots = [store.createBot(), store.createBot(), store.createBot()];
    for (const bot of bots) store.messagesFor(bot.threadId);
    store.setThreadCacheLimits(20, 200_000);
    // the least recently used thread has a turn running
    store.setActivity(bots[0]!.id, "working");
    expect(store.bot(bots[0]!.id)!.busy).toBe(true);
    // initially empty threads, each growing to ~92 KB after it was cached
    for (const bot of bots) for (let i = 0; i < 3; i++) store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "y".repeat(15_000) });
    expect(store.cachedThreadBytes()).toBeLessThanOrEqual(200_000);
    expect(store.cachedThreadIds()).toEqual([bots[0]!.threadId, bots[2]!.threadId]);
    // a patch that grows a held row is counted too
    const last = store.messagesFor(bots[2]!.threadId).at(-1)!;
    const before = store.cachedThreadBytes();
    store.patchMessage(bots[2]!.threadId, last.id, { text: "z".repeat(20_000) });
    expect(store.cachedThreadBytes() - before).toBe(10_000);
    // past the cap with nothing evictable but the busy thread and the newest: both stay
    store.patchMessage(bots[2]!.threadId, last.id, { text: "z".repeat(60_000) });
    expect(store.cachedThreadIds()).toEqual([bots[0]!.threadId, bots[2]!.threadId]);
    // once the turn ends the busy thread is evictable again, with no further write needed
    store.setActivity(bots[0]!.id, "idle");
    expect(store.cachedThreadIds()).toEqual([bots[2]!.threadId]);
    expect(store.cachedThreadBytes()).toBeLessThanOrEqual(200_000 + 60_000 * 2);
  });

});

describe("lane E round 2 findings (ui-review-r2/REPORT.md)", () => {
  beforeEach(() => removeTempDirSync(DATA_DIR));
  afterEach(() => vi.restoreAllMocks());
  const ask = (requestId: string) => ({ role: "bot", kind: "options", text: "May I?", card: { title: "May I?", options: [], requestId, tool: "Bash" } }) as never;
  const lines = (store: Store, threadId: string, count: number, tag: string) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) ids.push(store.appendMessage(threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `${tag} ${i}` }).id);
    return ids;
  };
  const readers = (warm: boolean) => { const reader = new Store(selection); if (warm) reader.messagesFor(reader.bots[0]!.threadId); return reader; };
  /** The SQL text of every statement prepared while `run` executes. */
  const prepared = <T>(run: () => T): { result: T; sql: string[] } => {
    const sql: string[] = [];
    const original = DatabaseSync.prototype.prepare;
    const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, text: string) { sql.push(text); return original.call(this, text); });
    try { return { result: run(), sql }; } finally { spy.mockRestore(); }
  };
  const stepsUp = (sql: string[]) => sql.filter((text) => text.includes("rowid AS position, json FROM messages WHERE thread_id = ? AND id = ?")).length;

  it("P2 cold branch page: a fork of 600 rows and a row spliced in before an earlier ancestor keep the whole branch, warm or cold", () => {
    const store = new Store(selection);
    const { threadId } = store.createBot();
    const original = lines(store, threadId, 10, "original");
    store.branchMessage(threadId, original[5]!, "fork");
    lines(store, threadId, 600, "fork");
    store.setActiveLeaf(threadId, original[9]!);
    // saved after the fork grew, but in front of an ancestor four rows from the head
    const spliced = store.insertMessageBefore(threadId, original[3]!, { role: "bot", kind: "text", text: "lead-in" });
    const expected = new Store(selection).activePath(threadId).map((m) => m.id);
    expect(expected).toContain(spliced.id);
    for (const warm of [false, true]) {
      const page = readers(warm).branchPage(threadId, 100)!;
      expect(page.activeLeafId).toBe(original[9]);
      expect(page.hasMore).toBe(false);
      expect(page.olderFrom).toBeNull();
      const byId = new Map(page.messages.map((m) => [m.id, m]));
      const walked: string[] = [];
      for (let cur = byId.get(original[9]!); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) walked.unshift(cur.id);
      expect(walked).toEqual(expected);
    }
  });

  it("P2 a branch is paged back by parent links with a continuation cursor, never by storage order", () => {
    const store = new Store(selection);
    const { threadId } = store.createBot();
    const original = lines(store, threadId, 12, "original");
    store.branchMessage(threadId, original[8]!, "fork");
    lines(store, threadId, 300, "fork");
    store.setActiveLeaf(threadId, original[11]!);
    const expected = store.activePath(threadId).map((m) => m.id);
    for (const warm of [false, true]) {
      const reader = readers(warm);
      const held: string[] = [];
      let page = reader.branchPage(threadId, 5)!;
      expect(page.messages).toHaveLength(5);
      for (let guard = 0; guard < 10; guard++) {
        held.unshift(...page.messages.map((m) => m.id));
        // every row of a page is on the branch: storage order would hand back the fork's rows
        expect(page.messages.every((m) => expected.includes(m.id))).toBe(true);
        if (!page.hasMore) break;
        expect(page.olderFrom).toBeTruthy();
        page = reader.branchPage(threadId, 5, page.olderFrom)!;
      }
      expect(held).toEqual(expected);
      expect(reader.branchPage(threadId, 5, "nope")).toBeNull();
    }
  });

  it("P2 the card-on-branch check reads the branch's parent links, not the rows stored since the card", windowsNightly(), () => {
    const store = new Store(selection);
    const { threadId } = store.createBot();
    const [root] = lines(store, threadId, 1, "start");
    const card = store.appendMessage(threadId, ask("req-old"));
    const [x] = lines(store, threadId, 1, "after the card");
    // 3,000 rows of an abandoned fork are stored after the card, then the owner returns to x
    store.branchMessage(threadId, x!, "fork");
    lines(store, threadId, 3_000, "fork");
    store.setActiveLeaf(threadId, x!);
    expect(root).toBeDefined();
    for (const warm of [false, true]) {
      const reader = readers(warm);
      const { result, sql } = prepared(() => reader.openCardsOutside(threadId, [{ id: x }]).map((m) => m.id));
      expect(result).toEqual([card.id]);
      // the branch index answers by key: no parent link is followed, however many rows came after
      expect(stepsUp(sql)).toBe(0);
      // and the next open reads none either
      const again = prepared(() => reader.openCardsOutside(threadId, [{ id: x }]).map((m) => m.id));
      expect(again.result).toEqual([card.id]);
      expect(stepsUp(again.sql)).toBe(0);
    }
  });

  it("P2 the first open of a long thread with an old card reads nothing per row: appends keep the card's branch answer", () => {
    const store = new Store(selection);
    const { threadId } = store.createBot();
    lines(store, threadId, 3, "start");
    const card = store.appendMessage(threadId, ask("req-old"));
    const ids = lines(store, threadId, 400, "after");
    const reader = new Store(selection);
    const page = reader.messagePage(threadId, 100)!;
    const { result, sql } = prepared(() => reader.openCardsOutside(threadId, page.messages).map((m) => m.id));
    expect(result).toEqual([card.id]);
    expect(stepsUp(sql)).toBe(0);
    expect(ids.length).toBe(400);
    // a fork elsewhere is found without a scan of the thread either
    store.branchMessage(threadId, ids[10]!, "fork");
    const walked = prepared(() => new Store(selection).openCardsOutside(threadId, page.messages).map((m) => m.id));
    expect(walked.result).toEqual([card.id]);
    // the branch is 14 rows deep: that many parent links, not the thread
    expect(stepsUp(walked.sql)).toBeLessThanOrEqual(16);
  });

  it("R3: a turn begun before the table existed gets its true first row when the thread is prepared, and its whole text", async () => {
    const store = new Store(selection);
    const { threadId } = store.createBot();
    lines(store, threadId, 3, "start");
    const first = store.appendMessage(threadId, { role: "bot", kind: "text", text: "part one", turnId: "turn-old" } as never);
    // as an upgrade leaves it: none of the derived tables, the thread not prepared
    database().exec("DELETE FROM turn_first; DELETE FROM thread_key; DELETE FROM seg; DELETE FROM msg_branch; DELETE FROM line");
    const next = store.appendMessage(threadId, { role: "bot", kind: "text", text: "part two", turnId: "turn-old" } as never);
    const rows = () => database().prepare("SELECT first_rowid FROM turn_first WHERE thread_id = ? AND turn_id = ?").all(threadId, "turn-old") as Array<{ first_rowid: number }>;
    await store.prepareThread(threadId);
    const firstRowid = (database().prepare("SELECT rowid AS r FROM messages WHERE thread_id = ? AND id = ?").get(threadId, first.id) as { r: number }).r;
    expect(rows()).toEqual([{ first_rowid: firstRowid }]);
    expect(wholeTurnText(database(), threadId, { ...next, turnTerminal: true } as never)).toBe("part one\n\npart two");
  });

  it("P2 open cards and a turn's first row are kept as written, not found by scanning", () => {
    const store = new Store(selection);
    const { threadId } = store.createBot();
    lines(store, threadId, 3, "start");
    const open = store.appendMessage(threadId, ask("req-x"));
    const reply = store.appendMessage(threadId, { role: "bot", kind: "text", text: "a", turnId: "turn-x" } as never);
    const rows = (sql: string, ...args: string[]) => database().prepare(sql).all(...args) as Array<Record<string, unknown>>;
    expect(rows("SELECT id FROM open_card WHERE thread_id = ?", threadId).map((r) => r.id)).toEqual([open.id]);
    expect(rows("SELECT first_rowid FROM turn_first WHERE thread_id = ? AND turn_id = ?", threadId, "turn-x")).toHaveLength(1);
    // answering closes it
    store.patchMessage(threadId, open.id, { card: { title: "May I?", options: [], requestId: "req-x", tool: "Bash", answered: "allow" } as never });
    expect(rows("SELECT id FROM open_card WHERE thread_id = ?", threadId)).toEqual([]);
    expect(reply.id).toBeDefined();
  });
});
