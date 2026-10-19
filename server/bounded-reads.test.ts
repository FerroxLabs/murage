// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The reads behind the card, media and image-reference routes scale with what
// they look for, never with the thread's history: on a conversation of 1,000
// messages and on one of 200,000 each reads the same statements and the same
// rows, every one an index search, and neither is ever loaded whole.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { initializeArtifacts } from "./artifacts.ts";
import { ATTACHMENTS_HOME } from "./attachments.ts";
const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");
import { conversationImageAttachments } from "./image-reference-resolver.ts";
import { imageReferences } from "./image-operations.ts";
import { __resetMediaAssetsForTests, mediaAssetsRoute, type MediaAssetsDeps } from "./media-assets.ts";
import { RoutineRequestService } from "./routine-requests.ts";
import { RoutineManager } from "./routines.ts";
import { Store } from "./store.ts";
import { scopeRow } from "./memory/scope-id.ts";
import { database } from "./database.ts";
import { expectSameReads, measureReads, refillThread } from "./testing/bounded-reads.ts";
import { MEDIA_ROUTES, type MediaResolveResponse } from "../shared/media-assets.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from("IHDR"), u32(3), u32(2), Buffer.from([8, 6, 0, 0, 0]), u32(0), Buffer.alloc(64, 0x11), Buffer.from("IEND")]);
const IMAGE = "11111111-1111-4111-8111-111111111111.png";

let store: Store, side: DatabaseSync, artifactsDb: DatabaseSync, deps: MediaAssetsDeps;
const messagesDb = () => join(DATA_DIR, "messages.db");
let small: { threadId: string; botId: string }, large: { threadId: string; botId: string }, few: string, big: string, edit3k: string;
let next = new Map<string, number>();

/** `count` plain text rows appended behind the writers' back, in order. */
function rows(threadId: string, count: number) {
  const from = (next.get(threadId) ?? 0) + 1, to = from + count - 1;
  side.prepare(`WITH RECURSIVE n(v) AS (VALUES(CAST(? AS INTEGER)) UNION ALL SELECT v+1 FROM n WHERE v<CAST(? AS INTEGER))
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT ?, 'seed-'||v, 1700000000000+v, CASE v%2 WHEN 1 THEN 'user' ELSE 'bot' END, 'text', 'line '||v,
      json_object('id','seed-'||v,'at',1700000000000+v,'role',CASE v%2 WHEN 1 THEN 'user' ELSE 'bot' END,'kind','text','text','line '||v) FROM n`).run(from, to, threadId);
  next.set(threadId, to);
}

/** [count rows][open request card][300 rows][answered request card][100 rows][image row][500 rows] */
function build(threadId: string, count: number) {
  rows(threadId, count);
  store.appendMessage(threadId, { role: "bot", kind: "options", text: "Allow?", card: { title: "Open request", options: ["Allow", "Deny"], requestId: "req-open" } } as never);
  rows(threadId, 300);
  store.appendMessage(threadId, { role: "bot", kind: "options", text: "Allowed", card: { title: "Closed request", options: ["Allow", "Deny"], requestId: "req-closed", answered: "allow" } } as never);
  rows(threadId, 100);
  store.appendMessage(threadId, { role: "bot", kind: "text", text: "", attachments: [{ kind: "image", path: join(ATTACHMENTS_DIR, IMAGE), mime: "image/png" }] });
  rows(threadId, 500);
}

/** A thread whose `count` rows are linked parent to child, as a conversation's are. */
function chain(threadId: string, count: number) {
  side.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<CAST(? AS INTEGER))
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT ?, 'c-'||v, 1700000000000+v, 'user', 'text', 'line '||v,
      json_object('id','c-'||v,'at',1700000000000+v,'role','user','kind','text','text','line '||v,'parentId',CASE WHEN v=1 THEN NULL ELSE 'c-'||(v-1) END) FROM n`).run(count, threadId);
  side.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(threadId, `c-${count}`);
}

const loaded = (threadId: string) => (store as unknown as { threads: { has(id: string): boolean } }).threads.has(threadId);

beforeAll(async () => {
  removeTempDirSync(DATA_DIR);
  store = new Store(selection);
  const a = store.createBot({ name: "Thousand" }), b = store.createBot({ name: "Two hundred thousand" });
  small = { threadId: a.threadId, botId: a.id }; large = { threadId: b.threadId, botId: b.id };
  few = store.createBot({ name: "Few" }).threadId; big = store.createBot({ name: "Big" }).threadId;
  edit3k = store.createBot({ name: "Edit" }).threadId;
  mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  writeFileSync(join(ATTACHMENTS_DIR, IMAGE), PNG);
  store.appendMessage(small.threadId, { role: "user", kind: "text", text: "first" });
  store.appendMessage(large.threadId, { role: "user", kind: "text", text: "first" });
  next.set(small.threadId, 0); next.set(large.threadId, 0);
  side = new DatabaseSync(messagesDb());
  side.exec("PRAGMA busy_timeout=30000");
  build(small.threadId, 1_000);
  build(large.threadId, 200_000);
  // threads whose rows are linked parent to child, as a conversation's are
  chain(few, 3_000);
  chain(big, 200_000);
  chain(edit3k, 3_000);
  // a fresh Store: nothing of either thread in its cache, as for a server that has just started
  store = new Store(selection);
  expect([store.bot(small.botId), store.bot(large.botId)].every(Boolean)).toBe(true);
  artifactsDb = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "murage-bounded-db-")), "messages.db")); initializeArtifacts(artifactsDb);
  deps = { dataDir: DATA_DIR, database: () => artifactsDb, store, artifactScopes: () => [] };
  __resetMediaAssetsForTests();
  // rows stored behind the writers' back are history from before the indexes: each thread is filled the way its first turn fills it, before anything is measured
  for (const threadId of [small.threadId, large.threadId, few, big, edit3k]) refillThread(side, threadId);
}, 300_000);
afterAll(() => { side?.close(); artifactsDb?.close(); });

// The test setup closes the message database after every test, and opening it again on a file of this
// size takes minutes: the steps below run in one test so the file is opened once.
const steps: Array<[string, () => Promise<void>]> = [];
const step = (name: string, run: () => Promise<void>) => { steps.push([name, run]); };

{
  step("finds a request card by its request id, open however far back and settled within the newest rows", async () => {
    const find = (threadId: string, requestId: string) => measureReads(threadId, messagesDb(), () => store.cardForRequest(threadId, requestId));
    for (const [requestId, title] of [["req-open", "Open request"], ["req-closed", "Closed request"]] as const) {
      const a = await find(small.threadId, requestId), b = await find(large.threadId, requestId);
      expect(a.result?.card?.title).toBe(title);
      expect(b.result?.card?.title).toBe(title);
      expectSameReads(a.reads, b.reads);
    }
    // a request nobody raised is searched for in a window, however long the thread
    const missing = await find(large.threadId, "req-none");
    expect(missing.result).toBeUndefined();
    expect(missing.reads.rows).toBeLessThanOrEqual(5_000 + 200);
    expect(missing.reads.scans).toEqual([]);
    expect(loaded(small.threadId)).toBe(false);
    expect(loaded(large.threadId)).toBe(false);
  });

  step("looks back from a row for the nearest earlier one, through the rows between", async () => {
    const lastId = (threadId: string) => `seed-${next.get(threadId)}`;
    const back = (threadId: string) => measureReads(threadId, messagesDb(), () => {
      let found: string | undefined;
      store.scanBefore(threadId, lastId(threadId), (message) => message.card?.requestId === "req-closed" ? ((found = message.id), true) : false);
      return found;
    });
    const a = await back(small.threadId), b = await back(large.threadId);
    expect(a.result).toBeDefined();
    expect(b.result).toBeDefined();
    expectSameReads(a.reads, b.reads);
    expect(loaded(large.threadId)).toBe(false);
  });

  step("serves a conversation's image through the media route from the row that attaches it", async () => {
    const resolve = (threadId: string) => measureReads(threadId, messagesDb(), async () => mediaAssetsRoute({
      method: "POST", path: MEDIA_ROUTES.resolve, url: new URL(`http://127.0.0.1:1${MEDIA_ROUTES.resolve}`), headers: {}, desktop: true,
      readBody: async () => ({ ref: { source: "attachment", threadId, attachmentId: IMAGE } }),
    }, deps));
    const a = await resolve(small.threadId), b = await resolve(large.threadId);
    for (const outcome of [a, b]) {
      expect(outcome.result.status).toBe(200);
      expect((outcome.result.body as MediaResolveResponse).asset.availability).toBe("ready");
    }
    expectSameReads(a.reads, b.reads);
    expect(loaded(large.threadId)).toBe(false);
  });

  step("lets the image tool name an image the conversation shows, 500 rows back, and none it does not", async () => {
    const allowed = (threadId: string) => measureReads(threadId, messagesDb(), async () => ({
      named: conversationImageAttachments(store, threadId, ATTACHMENTS_HOME, [IMAGE]).has(IMAGE),
      unnamed: conversationImageAttachments(store, threadId, ATTACHMENTS_HOME, ["22222222-2222-4222-8222-222222222222.png"]).has("22222222-2222-4222-8222-222222222222.png"),
      reference: (await imageReferences(store, threadId, [IMAGE], () => {})).length,
    }));
    const a = await allowed(small.threadId), b = await allowed(large.threadId);
    for (const outcome of [a, b]) expect(outcome.result).toEqual({ named: true, unnamed: false, reference: 1 });
    expectSameReads(a.reads, b.reads);
    expect(loaded(large.threadId)).toBe(false);
  });

  step("reads the whole branch for an export in short slices, the same rows in the same order", async () => {
    const slices = (threadId: string) => {
      const reader = store.branchReader(threadId), got: string[] = [];
      let longest = 0;
      for (;;) { const at = performance.now(); const slice = reader.next(); longest = Math.max(longest, performance.now() - at); got.push(...slice.messages.map((message) => message.id)); if (slice.done) break; }
      return { got, longest };
    };
    const read = slices(few);
    expect(loaded(few)).toBe(false);
    expect(read.got).toEqual(store.activePath(few).reverse().map((message) => message.id));
    expect(read.got).toHaveLength(3_000);
    // the big one, a slice at a time, none of them long, and never loaded
    const all = slices(big);
    expect(all.got).toHaveLength(200_000);
    expect(all.got[0]).toBe("c-200000");
    expect(all.got.at(-1)).toBe("c-1");
    expect(all.longest).toBeLessThan(100);
    expect(loaded(big)).toBe(false);
  });

  step("resolves a routine request by its request id, the card open however far back", async () => {
    const service = new RoutineRequestService({
      store: store as never,
      routines: new RoutineManager({ file: join(mkdtempSync(join(tmpdir(), "murage-bounded-routines-")), "routines.json"), now: () => Date.now(), botState: () => "ready", createTask: () => null, startTurn: async () => {} }),
      now: () => Date.now(), timeZone: () => "UTC", cloudReady: async () => ({ ready: true }), canPersist: () => ({ ok: true as const }),
    } as never);
    const propose = async (owner: { threadId: string; botId: string }) => {
      const proposed = await service.propose({ botId: owner.botId, threadId: owner.threadId, proposal: { action: "create", routine: { name: "Morning brief", instructions: "Summarize the queue.", schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] } } } as never });
      rows(owner.threadId, 300);
      return proposed.requestId;
    };
    const idA = await propose(small), idB = await propose(large);
    const resolve = (owner: { threadId: string; botId: string }, requestId: string) => measureReads(owner.threadId, messagesDb(), () => service.resolve({ botId: owner.botId, threadId: owner.threadId, requestId, behavior: "deny" }));
    const a = await resolve(small, idA), b = await resolve(large, idB);
    for (const outcome of [a, b]) expect(outcome.result).toMatchObject({ claimed: true });
    expectSameReads(a.reads, b.reads);
    expect(loaded(small.threadId)).toBe(false);
    expect(loaded(large.threadId)).toBe(false);
  });

  step("forks an edit beside the row it replaces and answers branch membership by key", async () => {
    // the edited row is captured, and the capture reads its conversation scope by key: confirmed when this file's scope cache holds it, looked
    // up when not (scope-id.ts). Earlier steps warm one thread and not the other, so both are read once here and compared warm.
    for (const threadId of [edit3k, big]) scopeRow(database(), "conversation", threadId);
    const edit = (threadId: string, count: number) => measureReads(threadId, messagesDb(), () => {
      const edited = store.branchMessage(threadId, `c-${count - 100}`, "edited words");
      const member = store.branchMembership(threadId);
      return { edited, answers: [member(`c-${count - 50}`), member(`c-${count - 150}`), member(edited!.id), member("c-none")] };
    });
    const a = await edit(edit3k, 3_000), b = await edit(big, 200_000);
    for (const outcome of [a, b]) {
      expect(outcome.result.answers).toEqual([false, true, true, false]);
    }
    expect(a.result.edited?.parentId).toBe("c-2899");
    expect(b.result.edited?.parentId).toBe("c-199899");
    expectSameReads(a.reads, b.reads);
    expect(loaded(edit3k)).toBe(false);
    expect(loaded(big)).toBe(false);
    // a row at the very start of a 200,000-row branch is found by walking to it: the one question whose work is the branch's length
    expect(store.branchMembership(big)("c-1")).toBe(true);
    expect(loaded(big)).toBe(false);
    // the fork is the visible branch now: the same answers from the loaded path
    const path = new Set(store.activePath(edit3k).map((message) => message.id));
    expect([path.has("c-2950"), path.has("c-2850"), path.has(a.result.edited!.id), path.has("c-1")]).toEqual([false, true, true, true]);
  });
}

it("reads by key, never by thread: the same statements and rows at 1,000 and at 200,000 thread messages, each by index", async () => {
  for (const [name, run] of steps) {
    try { await run(); } catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  }
}, 900_000);
