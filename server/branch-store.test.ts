// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The branch index over the real message database: the writers keep it exact
// through appends, forks, rows stored again, inserts before and after; a thread
// stored before it existed is filled in slices that writes interleave with, that
// survive a restart between slices, and that give the answers a parent walk gives.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { fillSlice, threadKey, verifyDerivedRows } from "./branch-index.ts";
import { branchTester, withBranchWalkBudget, isPrepared, prepareStats, prepareThread, prepareThreadSync } from "./branch-store.ts";
import * as messages from "./message-db.ts";
import { Store, type Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { windowsNightly } from "./testing/windows-hosted.ts";

const T = "th";
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); prepareStats.syncPrepares = 0; });
const row = (id: string, parentId: string | null | undefined, extra: object = {}): Message => ({ id, text: `words of ${id}`, ...(parentId === undefined ? {} : { parentId }), at: 1, role: "user", kind: "text", ...extra }) as Message;

/** The ids on the branch ending at `leaf`, by following parent links in the stored JSON (a legacy row with none follows the row before it). */
function walk(leaf: string): Set<string> {
  const db = database();
  const out = new Set<string>();
  for (let cur: string | null = leaf; cur !== null && !out.has(cur);) {
    out.add(cur);
    const r = db.prepare("SELECT rowid AS pos, json FROM messages WHERE thread_id = ? AND id = ?").get(T, cur) as { pos: number; json: string } | undefined;
    if (!r) break;
    const parent = (JSON.parse(r.json) as { parentId?: string | null }).parentId;
    if (parent === undefined) cur = (db.prepare("SELECT id FROM messages WHERE thread_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT 1").get(T, r.pos) as { id: string } | undefined)?.id ?? null;
    else cur = parent;
  }
  return out;
}
const ids = () => (database().prepare("SELECT id FROM messages WHERE thread_id = ? ORDER BY rowid").all(T) as Array<{ id: string }>).map((r) => r.id);
function expectOracleEqualsWalk(label: string) {
  for (const leaf of ids()) {
    const truth = walk(leaf), test = branchTester(T, leaf);
    for (const id of ids()) if (test(id) !== truth.has(id)) throw new Error(`${label}: ${id} on the branch of ${leaf}: expected ${truth.has(id)}`);
  }
}

it("the writers keep the index exact through appends, forks, inserts before and after, and rewrites of a row", () => {
  messages.appendMessage(T, row("a", null));
  messages.appendMessage(T, row("b", "a"));
  messages.appendMessage(T, row("c", "b"));
  messages.appendMessage(T, row("fork", "a")); // an edit of b
  messages.appendMessage(T, row("fork2", "b"));
  expect(isPrepared(T)).toBe(true);
  expectOracleEqualsWalk("appends and forks");
  // insert before b: it takes a's place as b's parent
  messages.insertMessageBefore(T, row("ib", "a"), row("b", "ib"));
  expectOracleEqualsWalk("insert before");
  // insert after b: it takes b's children (c and fork2)
  messages.insertMessageAfter(T, row("ia", "b"), "b", [], [row("c", "ia"), row("fork2", "ia")]);
  expectOracleEqualsWalk("insert after");
  // a row patched keeps its place; a row stored again (same id) keeps it too
  messages.updateMessage(T, row("c", "ia", { text: "patched" }));
  messages.appendMessage(T, row("c", "ia", { text: "stored again" }));
  expectOracleEqualsWalk("rewrites");
  expect(prepareStats.syncPrepares).toBe(0);
});

it("a thread stored before the index is filled in slices that writes interleave with, and gives a parent walk's answers", async () => {
  messages.appendMessage(T, row("r0", null));
  let last = "r0";
  for (let i = 1; i <= 40; i++) { messages.appendMessage(T, row(`r${i}`, last)); last = `r${i}`; }
  messages.appendMessage(T, row("f1", "r10")); messages.appendMessage(T, row("f2", "f1")); messages.appendMessage(T, row("g1", "r10"));
  // as an upgrade leaves it: nothing derived, the thread not prepared
  const db = database();
  db.exec("DELETE FROM thread_key; DELETE FROM seg; DELETE FROM msg_branch; DELETE FROM line; DELETE FROM fill_pending");
  expect(isPrepared(T)).toBe(false);
  const tk0 = (() => { messages.updateMessage(T, row("r40", "r39", { text: "touched" })); return threadKey(db, T)!; })();
  expect(tk0.state).toBe(0);
  let n = 0;
  for (;;) {
    // a slice of five rows, then a write: an append, a splice before, a splice after
    const done = (() => { db.exec("BEGIN IMMEDIATE"); const r = fillSlice(db, T, 5, 1e9); db.exec("COMMIT"); return r.done; })();
    if (done) break;
    n++;
    if (n === 2) messages.appendMessage(T, row("w1", "r40"));
    if (n === 3) messages.insertMessageBefore(T, row("sb", "r20"), row("r21", "sb"));
    if (n === 4) messages.insertMessageAfter(T, row("sa", "r30"), "r30", [], [row("r31", "sa")]);
    if (n === 5) messages.appendMessage(T, row("w2", "f2"));
    expect(n).toBeLessThan(200);
  }
  expect(isPrepared(T)).toBe(true);
  expectOracleEqualsWalk("fill interleaved with writes");
  // a writer after the fill keeps it exact
  messages.appendMessage(T, row("after", "w2"));
  expectOracleEqualsWalk("write after the fill");
});

it("a fill survives the database being closed and opened between slices", () => {
  messages.appendMessage(T, row("r0", null));
  for (let i = 1; i <= 30; i++) messages.appendMessage(T, row(`r${i}`, `r${i - 1}`));
  database().exec("DELETE FROM thread_key; DELETE FROM seg; DELETE FROM msg_branch; DELETE FROM line; DELETE FROM fill_pending");
  for (let slice = 0; slice < 100; slice++) {
    const db = database();
    db.exec("BEGIN IMMEDIATE"); const done = fillSlice(db, T, 4, 1e9).done; db.exec("COMMIT");
    closeDatabase();
    if (done) break;
  }
  expect(isPrepared(T)).toBe(true);
  expectOracleEqualsWalk("restart between slices");
});

it("a parent changed outside a splice sends the thread back to be filled, and the answers stay exact", async () => {
  messages.appendMessage(T, row("a", null)); messages.appendMessage(T, row("b", "a")); messages.appendMessage(T, row("c", "b")); messages.appendMessage(T, row("d", "a"));
  expect(isPrepared(T)).toBe(true);
  messages.updateMessage(T, row("c", "d")); // c moves under d: not a splice
  expect(isPrepared(T)).toBe(false);
  await prepareThread(T);
  expect(isPrepared(T)).toBe(true);
  expectOracleEqualsWalk("general reparent");
});

it("rows with no parentId (a legacy thread) chain to the row stored before them, and a row whose parent is stored later waits for it", () => {
  const db = database();
  const put = (id: string, json: object) => db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(T, id, 1, "user", "text", "x", JSON.stringify({ id, role: "user", kind: "text", text: "x", at: 1, ...json }));
  put("l1", {}); put("l2", {}); put("l3", {});
  put("child", { parentId: "late" }); put("late", { parentId: "l3" }); put("end", { parentId: "child" });
  prepareThreadSync(T);
  expect(prepareStats.syncPrepares).toBe(1);
  expectOracleEqualsWalk("legacy chain and late parent");
});

it("a file whose rowids moved sends every thread back to be filled", () => {
  messages.appendMessage(T, row("a", null)); messages.appendMessage(T, row("b", "a"));
  messages.appendMessage("other", row("o1", null)); messages.appendMessage("other", row("o2", "o1"));
  const db = database();
  expect(verifyDerivedRows(db, 50)).toBe(true);
  // rowids renumbered: the rows of one thread now sit where the other's were
  db.exec("UPDATE messages SET rowid = rowid + 100 WHERE thread_id = 'th'; UPDATE messages SET rowid = rowid - 2 WHERE thread_id = 'other'; UPDATE messages SET rowid = rowid - 98 WHERE thread_id = 'th'");
  expect(verifyDerivedRows(db, 200)).toBe(false);
  expect(isPrepared(T)).toBe(false);
  prepareThreadSync(T);
  expectOracleEqualsWalk("after the derived rows were dropped");
});

it("an edit forked in a thread stored behind the writers' back keeps the rows above the fork on the new branch", async () => {
  const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });
  const first = new Store(selection);
  const { threadId } = first.createBot({ name: "Raw" });
  const db = database();
  db.prepare("DELETE FROM messages WHERE thread_id = ?").run(threadId);
  db.prepare("DELETE FROM thread_key WHERE thread_id = ?").run(threadId);
  db.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<3000)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT ?, 'c-'||v, 1700000000000+v, 'user', 'text', 'line '||v,
      json_object('id','c-'||v,'at',1700000000000+v,'role','user','kind','text','text','line '||v,'parentId',CASE WHEN v=1 THEN NULL ELSE 'c-'||(v-1) END) FROM n`).run(threadId);
  db.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(threadId, "c-3000");
  const store = new Store(selection);
  const edited = store.branchMessage(threadId, "c-2900", "edited words")!;
  expect(edited.parentId).toBe("c-2899");
  // the write does not fill the thread (the branch change waits for the background fill): until then nothing on the new branch is hidden
  const sync = prepareStats.syncPrepares;
  const early = store.branchMembership(threadId);
  expect([early(edited.id), early("c-1"), early("c-2899"), early("c-2850")]).toEqual([true, true, true, true]);
  expect(prepareStats.syncPrepares).toBe(sync);
  await prepareThread(threadId);
  const member = store.branchMembership(threadId);
  expect([member("c-2950"), member("c-2850"), member(edited.id), member("c-1"), member("c-2899")]).toEqual([false, true, true, true, true]);
  expect(prepareStats.syncPrepares).toBe(sync);
});

it("a search over many unfilled threads walks a flat number of rows, however many threads it meets", windowsNightly(), () => {
  const db = database();
  const threads = Array.from({ length: 12 }, (_, i) => `u${i}`);
  for (const t of threads) {
    messages.appendMessage(t, row("m0", null));
    for (let i = 1; i < 400; i++) messages.appendMessage(t, row(`m${i}`, `m${i - 1}`));
  }
  db.exec("DELETE FROM thread_key; DELETE FROM seg; DELETE FROM msg_branch; DELETE FROM line; DELETE FROM fill_pending");
  for (const t of threads) expect(isPrepared(t)).toBe(false);
  const ask = () => threads.map(t => branchTester(t, "m399")("m0")); // the oldest row: the walk goes the whole way
  const spy = vi.spyOn(db, "prepare");
  const free = ask(); const unbudgeted = spy.mock.calls.length; spy.mockClear();
  expect(free.every(known => known === true)).toBe(true);
  const budgeted = withBranchWalkBudget(500, ask); const bounded = spy.mock.calls.length;
  spy.mockRestore();
  expect(budgeted.filter(known => known === true).length).toBe(1); // one thread fits the budget; the rest answer "unknown", never a wrong "no"
  expect(budgeted.filter(known => known === undefined).length).toBe(11);
  expect(bounded).toBeLessThan(unbudgeted / 4);
  // lazy: a row near the leaf is placed after a few steps, not 400
  spy.mockClear();
  const near = vi.spyOn(db, "prepare");
  expect(branchTester(threads[0]!, "m399")("m398")).toBe(true);
  expect(near.mock.calls.length).toBeLessThan(unbudgeted / 12 / 4);
  near.mockRestore();
});
