// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// No pass on the main thread fills a whole thread (1.0.2 RC3 P1 #1, second part). A thread that is not prepared yet is queued at the front
// of the background fill and answered a bounded way by: the project digest tick (a timer), a branch change (a write), and the newest-row /
// branch-line readers (a request, a turn's late check). The synchronous fill is reachable only from the turn-path readers, which a turn
// reaches after `await prepareThread` (index.ts startTurn / startCardContinuation / the member turn), and from the background fill itself.
import { readFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { database, transaction } from "./database.ts";
import { nextQueuedFill, prepareStats } from "./branch-fill.ts";
import { isPrepared, prepareThread } from "./branch-store.ts";
import { LINE_TEXT } from "./branch-index.ts";
import { Store } from "./store.ts";
import * as messages from "./message-db.ts";
import { drainBranchChanges, startBranchChange } from "./memory/branch-change.ts";
import { runProjectDigests } from "./project-digest.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { createProjectCard } from "./project-cards.ts";
import type { CommsBus } from "./comms-visibility.ts";
import { expectSameReads, measureReads } from "./testing/bounded-reads.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const SERVER = __dirname;
// Other test files build and delete hidden fixture directories (`.e2a-fixtures-*`) under server/ while this scan walks it, so the walk skips
// every dot directory and treats a path that vanished between the listing and the stat as absent.
const isDirectory = (path: string): boolean | null => { try { return statSync(path).isDirectory(); } catch { return null; } };
const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (name.startsWith(".")) return [];
  const directory = isDirectory(path);
  if (directory === null) return [];
  if (directory) return name === "node_modules" ? [] : sources(path);
  return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
});

it("the synchronous fill is called only from the background fill modules; every reader asserts the thread is prepared", () => {
  const callers = sources(SERVER).filter((path) => /\b(prepareThreadSync|prepareSyncOn)\(/.test(readFileSync(path, "utf8")) ).map((path) => relative(SERVER, path).replace(/\\/g, "/")).sort(); // '/' on every platform
  expect(callers).toEqual(["branch-fill.ts", "branch-store.ts", "testing/bounded-reads.ts"]);
  // the three callers this guard was written for never import it again
  for (const file of ["project-digest.ts", "memory/branch-change.ts", "store.ts", "index.ts", "message-db.ts"]) expect(readFileSync(join(SERVER, file), "utf8"), file).not.toMatch(/prepareThreadSync|prepareSyncOn/);
  // inside message-db: the bounded readers (the request and timer entry points) are free of it
  const db = readFileSync(join(SERVER, "message-db.ts"), "utf8");
  const body = (name: string) => { const at = db.indexOf(name); const end = db.indexOf("\n}\n", at); return db.slice(at, end); };
  for (const name of ["export function topRowsOnBranch", "export function* branchLinesNewest", "export function rowPlace", "export function activeTextLines"]) expect(body(name), name).not.toMatch(/prepareThreadSync/);
  // every reader that answers from the indexes asserts the thread is prepared instead of filling it
  for (const name of ["export function turnRows", "export function turnTextRows", "export function newestLines(", "export function rowsNamingImage", "export function recentImagePaths", "export function threadHasKeyed", "export function keyedCardRows"]) expect(body(name), name).toMatch(/requirePrepared\(threadId, "/);
  const store = readFileSync(join(SERVER, "branch-store.ts"), "utf8");
  expect(store.slice(store.indexOf("export function childRowids"), store.indexOf("export function childRowids") + 300)).toMatch(/requirePrepared\(threadId, "childRowids"\)/);
  const branchRowsBody = store.slice(store.indexOf("export function branchRows"), store.indexOf("export function branchRows") + 1800);
  expect(branchRowsBody.slice(0, branchRowsBody.indexOf("\n}\n"))).not.toMatch(/prepareThreadSync\(/);
});

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
let store: Store, side: DatabaseSync, small: string, large: string;
const COUNT = new Map<string, number>();
function chain(threadId: string, count: number) {
  side.prepare("DELETE FROM messages WHERE thread_id=?").run(threadId);
  side.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<CAST(? AS INTEGER))
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT ?, 'c-'||v, 1700000000000+v, CASE v%2 WHEN 1 THEN 'user' ELSE 'bot' END, 'text', 'line '||v,
      json_object('id','c-'||v,'at',1700000000000+v,'role',CASE v%2 WHEN 1 THEN 'user' ELSE 'bot' END,'kind','text','text','line '||v,'parentId',CASE WHEN v=1 THEN NULL ELSE 'c-'||(v-1) END) FROM n`).run(count, threadId);
  side.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(threadId, `c-${count}`);
  side.prepare("DELETE FROM thread_key WHERE thread_id=?").run(threadId);
  COUNT.set(threadId, count);
}
beforeAll(() => {
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
  store = new Store(selection);
  small = store.createBot({ name: "Thousand" }).threadId; large = store.createBot({ name: "Many" }).threadId;
  side = new DatabaseSync(join(DATA_DIR, "messages.db"));
  side.exec("PRAGMA busy_timeout=30000");
  chain(small, 1_000); chain(large, 120_000);
  side.exec("DELETE FROM thread_key; DELETE FROM seg; DELETE FROM msg_branch; DELETE FROM line; DELETE FROM fill_pending; DELETE FROM turn_first");
  store = new Store(selection);
}, 600_000);
afterAll(() => { side?.close(); });

it("the newest-row and branch-line readers on an unprepared thread read the same on both sizes and never fill", async () => {
  expect(isPrepared(small)).toBe(false); expect(isPrepared(large)).toBe(false);
  const before = prepareStats.syncPrepares;
  const read = (t: string) => {
    const user = store.newestLineOnBranch(t, (m) => m.role === "user")?.id;
    const card = store.newestRequestCard(t)?.id;
    const row = store.newestRowOfClass(t, LINE_TEXT)?.message.id;
    const tail = store.activeTextLines(t, 20).messages.map((m) => m.id);
    const lines = [...store.branchLinesNewest(t, LINE_TEXT)].slice(0, 3).map((r) => r.message.id);
    return { user, card, row, tail, lines, direct: messages.topRowsOnBranch(t, `c-${COUNT.get(t)!}`, LINE_TEXT, 2).rows.map((r) => r.message.id) };
  };
  const a = await measureReads(small, join(DATA_DIR, "messages.db"), () => read(small));
  const b = await measureReads(large, join(DATA_DIR, "messages.db"), () => read(large));
  expectSameReads(a.reads, b.reads);
  expect(b.result.user).toBe("c-119999"); expect(b.result.row).toBe("c-120000");
  expect(b.result.tail.at(-1)).toBe("c-120000"); expect(b.result.tail).toHaveLength(20);
  expect(b.result.lines).toEqual(["c-120000", "c-119999", "c-119998"]);
  expect(b.result.direct).toEqual(["c-119999", "c-120000"]);
  expect(prepareStats.syncPrepares).toBe(before);
  expect(isPrepared(small)).toBe(false); expect(isPrepared(large)).toBe(false);
  expect(nextQueuedFill(database())).toBeDefined();
}, 600_000);

it("a project digest tick over an unprepared room reads the same on both sizes, never fills, queues the room, and posts once it is ready", async () => {
  const db = database();
  initializeProjectTables(db);
  const now = Date.parse("2026-09-29T08:00:00Z");
  const posted: Array<{ thread: string; value: unknown }> = [];
  const rooms: string[] = [];
  const runFor = (groupId: string, threadId: string) => {
    channelToProjectRows(db, { groupId, bulletin: "", leadBotId: null, now: now - 2 * 86400000 });
    db.prepare("UPDATE project_settings SET parts='{\"digest\":true}' WHERE group_id=?").run(groupId);
    createProjectCard(db, { groupId, title: "a card", actor: { kind: "owner" }, memberIds: [], now: now - 1000 });
    rooms.push(groupId);
    const group = { id: groupId, threadId, memberIds: [] };
    const bus = { store: { group: (id: string) => id === groupId ? group : undefined, appendMessage: (thread: string, value: unknown) => { posted.push({ thread, value }); }, patchGroup: () => undefined }, broadcast: () => undefined } as unknown as CommsBus;
    return () => runProjectDigests({ db, bus, features: {}, timeZone: "UTC" }, now);
  };
  const tickSmall = runFor("g-small", small), tickLarge = runFor("g-large", large);
  const before = prepareStats.syncPrepares;
  // each tick visits both projects; the first project's thread is the one measured, the other is the same call
  const a = await measureReads(small, join(DATA_DIR, "messages.db"), () => tickSmall());
  const b = await measureReads(large, join(DATA_DIR, "messages.db"), () => tickLarge());
  expect(a.result).toBe(0); expect(b.result).toBe(0);
  expect(posted).toHaveLength(0);
  expect(prepareStats.syncPrepares).toBe(before);
  expect(isPrepared(small)).toBe(false); expect(isPrepared(large)).toBe(false);
  expect(nextQueuedFill(db)).toBeDefined();
  expect(b.reads.rows).toBeLessThanOrEqual(a.reads.rows + 50);
  await prepareThread(small); await prepareThread(large);
  expect(prepareStats.syncPrepares).toBe(before);
  tickSmall();
  expect(posted.some((p) => p.thread === small)).toBe(true);
}, 600_000);

it("a branch change on an unprepared thread costs the same on both sizes, never fills, and is correct once the thread is filled", async () => {
  const db = database();
  // both threads are unprepared again (the digest test filled them)
  for (const t of [small, large]) side.exec(`DELETE FROM thread_key WHERE thread_id='${t}'`);
  expect(isPrepared(large)).toBe(false);
  const before = prepareStats.syncPrepares;
  const change = (t: string) => transaction((d) => startBranchChange(d, t, `c-${COUNT.get(t)! - 4}`, `c-${COUNT.get(t)!}`));
  const a = await measureReads(small, join(DATA_DIR, "messages.db"), () => change(small));
  const b = await measureReads(large, join(DATA_DIR, "messages.db"), () => change(large));
  expectSameReads(a.reads, b.reads);
  expect(prepareStats.syncPrepares).toBe(before);
  expect(isPrepared(large)).toBe(false);
  expect(db.prepare("SELECT COUNT(*) AS n FROM branch_change WHERE thread_id IN (?, ?)").get(small, large)?.n).toBe(2);
  // a second change while the first waits does not fill either
  transaction((d) => startBranchChange(d, large, `c-${COUNT.get(large)! - 4}`, `c-${COUNT.get(large)! - 2}`));
  expect(prepareStats.syncPrepares).toBe(before);
  expect(db.prepare("SELECT from_id AS f FROM branch_change WHERE thread_id = ?").get(large)?.f).toBeNull();
  await drainBranchChanges(db);
  expect(db.prepare("SELECT COUNT(*) AS n FROM branch_change").get()?.n).toBe(0);
  expect(isPrepared(large)).toBe(true);
  expect(prepareStats.syncPrepares).toBe(before);
}, 600_000);

const unprepare = () => { for (const t of [small, large]) side.exec(`DELETE FROM thread_key WHERE thread_id='${t}'`); };

it("every index reader refuses an unprepared thread instead of filling it", () => {
  unprepare();
  const before = prepareStats.syncPrepares;
  expect(isPrepared(large)).toBe(false);
  expect(() => messages.turnRows(large, "t")).toThrow(/not prepared/);
  expect(() => messages.turnTextRows(large, "t")).toThrow(/not prepared/);
  expect(() => messages.newestLines(large, LINE_TEXT, 3)).toThrow(/not prepared/);
  expect(() => messages.rowsNamingImage(large, "/x.png")).toThrow(/not prepared/);
  expect(() => messages.recentImagePaths(large, 3)).toThrow(/not prepared/);
  expect(() => messages.keyedCardRows(large, "setup" as never)).not.toThrow();
  expect(() => messages.childrenOfRow(large, "c-119990")).toThrow(/not prepared/);
  expect(prepareStats.syncPrepares).toBe(before);
  expect(isPrepared(large)).toBe(false);
});

it("a splice and an edit on an unprepared 120,000-message thread fill in slices first, never synchronously, and come out right", async () => {
  unprepare();
  const before = prepareStats.syncPrepares;
  // splice: a row hung after c-119990, whose child c-119991 is re-parented onto it
  expect(isPrepared(large)).toBe(false);
  await store.prepareThread(large);
  expect(isPrepared(large)).toBe(true);
  const spliced = store.insertMessageAfter(large, "c-119990", { role: "bot", kind: "text", text: "spliced in" });
  expect(messages.readMessage(large, "c-119991")?.parentId).toBe(spliced.id);
  expect(messages.readMessage(large, spliced.id)?.parentId).toBe("c-119990");
  expect(store.activeLeaf(large)).toBe("c-120000");
  expect(messages.childrenOfRow(large, "c-119990").map((m) => m.id)).toEqual([spliced.id]);
  // edit: a row saved in front of c-119995 takes its parent, and c-119995 hangs from it
  unprepare();
  expect(() => store.insertMessageAfter(large, "c-119980", { role: "bot", kind: "text", text: "too early" })).toThrow(/not prepared/);
  await store.prepareThread(large);
  const before2 = store.insertMessageBefore(large, "c-119995", { role: "bot", kind: "text", text: "saved before" });
  expect(messages.readMessage(large, "c-119995")?.parentId).toBe(before2.id);
  expect(messages.readMessage(large, before2.id)?.parentId).toBe("c-119994");
  expect(prepareStats.syncPrepares).toBe(before);
}, 600_000);

it("the reply-action late check on an unprepared thread fills in slices first, never synchronously", async () => {
  const { branchActionEvidence, delegatedRows } = await import("./reply-action-evidence.ts");
  unprepare();
  const before = prepareStats.syncPrepares;
  const reply = { ...messages.readMessage(large, "c-120000")!, turnId: "turn-late" };
  // before the await the readers answer from the bounded walk or refuse; none of them fills
  try { branchActionEvidence(store, large, reply, delegatedRows(store, large, () => undefined)); } catch (error) { expect(String(error)).toMatch(/not prepared/); }
  expect(prepareStats.syncPrepares).toBe(before);
  unprepare();
  await store.prepareThread(large);
  const evidence = branchActionEvidence(store, large, reply, delegatedRows(store, large, () => undefined));
  expect(evidence).toBeDefined();
  expect(prepareStats.syncPrepares).toBe(before);
}, 600_000);
