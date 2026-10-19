// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Two-size tests (turnctx r3): every read the turnctx lane moved off the whole
// thread -- the sites of d270432f3 (cards, setup lines, steers, approvals, screen
// frames, first and newest rows, since-time reads) and the sites of r3 (branch
// membership, text lines, the replay's lines, the reply-action record, a turn's
// replies, images, splices, the room's rows) -- reads the same statements and the
// same rows on a conversation of 1,000 messages as on one of 200,000, every one
// an index search, and neither is ever loaded whole. The thread is prepared first,
// as a turn does; the sync-prepare counter stays where it was.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { ATTACHMENTS_DIR } from "./attachments.ts";
import { prepareStats } from "./branch-fill.ts";
import { conversationImageAttachments } from "./image-reference-resolver.ts";
import { branchActionEvidence, delegatedRows, ownerLine } from "./reply-action-evidence.ts";
import { checkReplyActionsWith } from "./reply-action-guard.ts";
import { GROUP_CONTEXT_MESSAGES } from "./room-context.ts";
import { readRoomTurnRows } from "./room-turn-rows.ts";
import { Store } from "./store.ts";
import { expectSameReads, measureReads } from "./testing/bounded-reads.ts";
import * as messages from "./message-db.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const messagesDb = () => join(DATA_DIR, "messages.db");
const IMAGE = "44444444-4444-4444-8444-444444444444.png";
const TAGGED = "55555555-5555-4555-8555-555555555555.png";
let store: Store, side: DatabaseSync;
let small: string, large: string;

/** `count` rows linked parent to child: c-1 .. c-count, alternating user and bot text, with the thread's head on the last. */
function chain(threadId: string, count: number) {
  side.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<CAST(? AS INTEGER))
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT ?, 'c-'||v, 1700000000000+v, CASE v%2 WHEN 1 THEN 'user' ELSE 'bot' END, 'text', 'line '||v,
      json_object('id','c-'||v,'at',1700000000000+v,'role',CASE v%2 WHEN 1 THEN 'user' ELSE 'bot' END,'kind','text','text','line '||v,'parentId',CASE WHEN v=1 THEN NULL ELSE 'c-'||(v-1) END) FROM n`).run(count, threadId);
  side.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(threadId, `c-${count}`);
}
let parent = new Map<string, string>();
/** The ids this fixture wrote (the filler is c-N); anything else in a thread is a stray the bot's own housekeeping wrote. */
const mine = new Map<string, Set<string>>();
const note = (threadId: string, id: string) => { (mine.get(threadId) ?? mine.set(threadId, new Set()).get(threadId)!).add(id); return id; };
let seq = new Map<string, number>();
/** One raw row chained onto the thread's head (bypassing the writers: the thread's fill derives everything from it). */
function raw(threadId: string, body: Record<string, unknown>): string {
  const n = (seq.get(threadId) ?? 0) + 1; seq.set(threadId, n);
  const id = note(threadId, String(body.id ?? `x-${n}`));
  const full = { id, at: 1700000100000 + n, role: "bot", kind: "text", parentId: parent.get(threadId), ...body };
  side.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(threadId, id, full.at, full.role, full.kind, (full as { text?: string }).text ?? null, JSON.stringify(full));
  side.prepare("UPDATE thread_state SET active_leaf_id=? WHERE thread_id=?").run(id, threadId);
  parent.set(threadId, id);
  return id;
}

function build(threadId: string, count: number) {
  // the bot's own first rows are not part of the shape under test: both threads start from the same chain
  side.prepare("DELETE FROM messages WHERE thread_id=?").run(threadId);
  side.prepare("DELETE FROM thread_state WHERE thread_id=?").run(threadId);
  chain(threadId, count);
  parent.set(threadId, `c-${count}`);
  // the rows above were stored behind the writers' back, as a database from before the indexes holds them: not prepared
  side.prepare("DELETE FROM thread_key WHERE thread_id=?").run(threadId);
  // rows through the writers: the option cards, filed in open_card and keyed_card as they are written
  store = new Store(selection); // the bot was created before the rows above were stored: a fresh cache reads the thread's own head
  const card = (extra: Record<string, unknown>, text = "card") => note(threadId, store.appendMessage(threadId, { role: "bot", kind: "options", text, card: { title: "Card", options: ["Yes"], ...extra } } as never).id);
  card({ requestId: "req-open" }); card({ setup: { key: "step-1" } }); card({ intake: true }); card({ browserSetup: {} }); card({ skillRequest: { stagedId: "staged-1", gist: "g", warnings: [] } });
  card({ publish: { action: "connect", connect: { state: "needed" } } }); card({}, "suggestion");
  note(threadId, store.appendMessage(threadId, { role: "bot", kind: "text", text: "setup said this", setupEcho: "echo-1" } as never).id);
  const head = side.prepare("SELECT active_leaf_id AS id FROM thread_state WHERE thread_id=?").get(threadId) as { id: string };
  parent.set(threadId, head.id);
  // raw rows: the thread's fill derives their lines, turns, images, steers and classes
  side.prepare("DELETE FROM thread_key WHERE thread_id=?").run(threadId); // the cards above went through the writers: the thread is still filled from its rows
  raw(threadId, { role: "user", text: "steer me", steerUnconfirmed: true, steerId: "st-1" });
  for (let i = 0; i < 5; i++) raw(threadId, { kind: "screen", text: "", ...(i >= 2 ? { png: "AAAA" } : {}) });
  raw(threadId, { kind: "secret", role: "bot", text: "secret" }); raw(threadId, { kind: "connector", role: "bot", text: "connector" });
  raw(threadId, { role: "bot", text: "saved a file", artifactIds: ["a1"] });
  raw(threadId, { role: "user", text: "here", attachments: [{ kind: "image", path: join(ATTACHMENTS_DIR, IMAGE), mime: "image/png" }] });
  raw(threadId, { role: "user", text: `look\n<attached-image path="${join(ATTACHMENTS_DIR, TAGGED)}" />\n` });
  raw(threadId, { role: "user", text: "first ask" });
  raw(threadId, { id: "final-d", role: "bot", text: "I deleted the file.", turnId: "turn-d" });
  raw(threadId, { role: "user", text: "second ask" });
  raw(threadId, { id: "final-s", role: "bot", text: "I saved the file.", turnId: "turn-s" });
  raw(threadId, { role: "user", text: "do the work" });
  raw(threadId, { role: "bot", text: "On it.", turnId: "turn-x" });
  for (let i = 0; i < 40; i++) raw(threadId, { role: "bot", kind: "activity", text: null, turnId: "turn-x", tool: { name: "send_message", ok: true, summary: "sent" } });
  raw(threadId, { id: "final", role: "bot", text: "Done: I sent it.", turnId: "turn-x" });
}

beforeAll(async () => {
  removeTempDirSync(DATA_DIR);
  mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  writeFileSync(join(ATTACHMENTS_DIR, IMAGE), Buffer.alloc(8)); writeFileSync(join(ATTACHMENTS_DIR, TAGGED), Buffer.alloc(8));
  store = new Store(selection);
  small = store.createBot({ name: "Thousand" }).threadId; large = store.createBot({ name: "Two hundred thousand" }).threadId;
  side = new DatabaseSync(messagesDb());
  side.exec("PRAGMA busy_timeout=30000");
  build(small, 1_000);
  build(large, 200_000);
  // the bot's own housekeeping may have written a row of its own into a thread since: the shape under test is only what this fixture wrote
  for (const t of [small, large]) side.prepare(`DELETE FROM messages WHERE thread_id=? AND id NOT LIKE 'c-%' AND id NOT IN (SELECT value FROM json_each(?))`).run(t, JSON.stringify([...mine.get(t)!]));
  side.exec("DELETE FROM thread_key; DELETE FROM seg; DELETE FROM msg_branch; DELETE FROM line; DELETE FROM fill_pending; DELETE FROM turn_first");
  store = new Store(selection); // nothing of either thread in its cache
  const before = prepareStats.syncPrepares;
  await store.prepareThread(small); await store.prepareThread(large);
  expect(prepareStats.syncPrepares).toBe(before);
}, 600_000);
afterAll(() => { side?.close(); });

const loaded = (threadId: string) => (store as unknown as { threads: { has(id: string): boolean } }).threads.has(threadId);
const steps: Array<[string, () => Promise<void>]> = [];
const step = (name: string, run: () => Promise<void>) => { steps.push([name, run]); };
const both = async <T>(read: (threadId: string) => T) => {
  const a = await measureReads(small, messagesDb(), () => read(small)), b = await measureReads(large, messagesDb(), () => read(large));
  try { expectSameReads(a.reads, b.reads); }
  catch { throw new Error(`reads differ: small ${JSON.stringify(a.reads.bySql)} large ${JSON.stringify(b.reads.bySql)} scans ${JSON.stringify([...a.reads.scans, ...b.reads.scans])}`); }
  return [a.result, b.result] as const;
};

// -- the sites of d270432f3 ---------------------------------------------------
step("cards: open request cards on the branch, option cards by family, rows of a rare kind, the onboarding suggestion", async () => {
  const [a, b] = await both((t) => store.openCardsOnBranch(t).map((m) => m.card?.requestId));
  expect(a).toEqual(["req-open"]); expect(b).toEqual(["req-open"]);
  for (const family of ["setup", "intake", "browser", "skill", "publish"] as const) {
    const [x, y] = await both((t) => store.keyedCards(t, family).length);
    expect(x).toBeGreaterThanOrEqual(1); expect([family, y]).toEqual([family, x]);
  }
  const [s, t2] = await both((t) => store.rowsOfKind(t, "secret").length); expect([s, t2]).toEqual([1, 1]);
  const [o, o2] = await both((t) => store.openRequestCardRows(t).length); expect(o).toBeGreaterThanOrEqual(1); expect(o2).toBe(o);
  const [ob, ob2] = await both((t) => messages.openOnboardingCards(t).length); expect(ob).toBeGreaterThanOrEqual(1); expect(ob2).toBe(ob);
  const [ar, ar2] = await both((t) => store.artifactRows(t).length); expect([ar, ar2]).toEqual([1, 1]);
});

step("setup lines and steers filed per thread: echo and steer", async () => {
  const [e1, e2] = await both((t) => store.keyedCards(t, "echo", "echo-1").length); expect([e1, e2]).toEqual([1, 1]);
  const [s1, s2] = await both((t) => store.keyedCards(t, "steer", "st-1").length); expect([s1, s2]).toEqual([1, 1]);
});

step("screen frames, first and newest rows, since-time reads, a row by key", async () => {
  const [p1, p2] = await both((t) => store.newestScreenWithPixels(t)?.png); expect([p1, p2]).toEqual(["AAAA", "AAAA"]);
  const [h1, h2] = await both((t) => [store.hasRow(t, "c-5"), store.hasRows(t), Boolean(store.firstRow(t)), store.newestRowId(t)]);
  expect(h1).toEqual([true, true, true, "final"]); expect(h2).toEqual(h1);
  const [m1, m2] = await both((t) => store.messageById(t, "c-7")?.text); expect([m1, m2]).toEqual(["line 7", "line 7"]);
  const [r1, r2] = await both((t) => { let n = 0; store.scanSince(t, 1700000100000 + 20, () => { n++; return false; }); return n; });
  expect(r1).toBeGreaterThan(0); expect(r2).toBe(r1);
});

// -- the sites of r3 ----------------------------------------------------------
step("branch membership: a row near the start, near the end, a card, a steer; all by key", async () => {
  const [a, b] = await both((t) => { const on = store.branchMembership(t); return ["c-1", "c-5", "final", "x-1", "nothing"].map((id) => on(id)); });
  expect(a).toEqual([true, true, true, true, false]); expect(b).toEqual(a);
});

step("text lines: the newest thirty, the replay's window of lines, the owner's last line", async () => {
  const [a, b] = await both((t) => store.newestTextLines(t, GROUP_CONTEXT_MESSAGES).map((m) => m.id));
  expect(a).toHaveLength(GROUP_CONTEXT_MESSAGES); expect(b).toHaveLength(GROUP_CONTEXT_MESSAGES);
  const [c, d] = await both((t) => { const lines = store.activeTextLines(t, 80); return [lines.messages.length, lines.hasMore, lines.messages.at(-1)?.id]; });
  expect(c).toEqual([80, true, "final"]); expect(d).toEqual(c);
  const [e, f] = await both((t) => ownerLine(store, t)?.message.text); expect([e, f]).toEqual(["do the work", "do the work"]);
});

step("a turn's replies and rows: the originals of the closing turn, every row of it", async () => {
  const [a, b] = await both((t) => store.turnReplyOriginals(t, "turn-x")); expect(a).toHaveLength(2); expect(b).toHaveLength(2); expect(a.at(-1)).toBe("final"); expect(b.at(-1)).toBe("final");
  const [c, d] = await both((t) => store.turnRows(t, "turn-x").length); expect([c, d]).toEqual([42, 42]);
});

step("the reply-action record: a send claimed in the closing turn, a file saved earlier, and a delete never done", async () => {
  const check = (t: string, id: string) => {
    const reply = store.messageById(t, id)!;
    const delegated = delegatedRows(store, t, () => undefined);
    return checkReplyActionsWith(branchActionEvidence(store, t, reply, delegated)).state;
  };
  const [a, b] = await both((t) => check(t, "final")); expect([a, b]).toEqual(["recorded", "recorded"]);
  const [c, d] = await both((t) => check(t, "final-d")); expect([c, d]).toEqual(["flagged", "flagged"]);
  // a file saved before the owner's last line is earlier evidence, found where it last happened
  const [e, f] = await both((t) => check(t, "final-s")); expect([e, f]).toEqual(["earlier", "earlier"]);
});

step("images: an attachment and a legacy tag, wherever they are", async () => {
  const [a, b] = await both((t) => [...conversationImageAttachments(store, t, ATTACHMENTS_DIR, [IMAGE, TAGGED]).keys()].sort());
  expect(a).toEqual([IMAGE, TAGGED].sort()); expect(b).toEqual(a);
  const [c, d] = await both((t) => store.rowAttaching(t, join(ATTACHMENTS_DIR, IMAGE))?.text); expect([c, d]).toEqual(["here", "here"]);
});

step("a room turn's rows: thirty lines, the pin, its quote", async () => {
  const [a, b] = await both((t) => readRoomTurnRows(store, t, "c-3").rows.map((m) => m.id));
  expect(a).toHaveLength(GROUP_CONTEXT_MESSAGES + 1); expect(b).toHaveLength(GROUP_CONTEXT_MESSAGES + 1);
});

step("a row inserted before a recent row and one inserted after a recent anchor", async () => {
  const a = await both((t) => store.insertMessageBefore(t, "final", { role: "bot", kind: "text", text: "inserted before" }).parentId);
  expect(a[0]).toBe(a[1]);
  const b = await both((t) => { const x = store.insertMessageAfter(t, "c-1", { role: "bot", kind: "text", text: "after the first" }); return x.parentId; });
  expect(b[0]).toBe("c-1"); expect(b[1]).toBe("c-1");
  // the spliced rows are on the branch, found by key
  const c = await both((t) => store.branchMembership(t)(store.newestTextLines(t, 1)[0]!.id));
  expect(c).toEqual([true, true]);
  expect(loaded(small)).toBe(false); expect(loaded(large)).toBe(false);
});

it("reads by key, never by thread: the same statements and rows at 1,000 and at 200,000 thread messages, each by index", async () => {
  const sync = prepareStats.syncPrepares;
  const failed: string[] = [];
  for (const [name, run] of steps) {
    try { await run(); } catch (error) { failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  expect(failed).toEqual([]);
  expect(prepareStats.syncPrepares).toBe(sync);
  expect(loaded(small)).toBe(false);
  expect(loaded(large)).toBe(false);
}, 900_000);
