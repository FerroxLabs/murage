// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The nine reproductions of Astra's r2 review of the turnctx lane, kept as tests
// (turnctx-review/r2/REPORT.md). Each is written against the public Store and
// message-db API, so it runs unchanged on the commit that was reviewed
// (d270432f3, where it fails) and on the one that closes it. A thread that is
// not prepared yet is prepared the way a turn does (`prepareThread`, absent on
// d270432f3) before it is read.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { ATTACHMENTS_DIR } from "./attachments.ts";
import { database } from "./database.ts";
import { conversationImageAttachments } from "./image-reference-resolver.ts";
import { GROUP_CONTEXT_MESSAGES, roomContextMessages } from "./room-context.ts";
import { readRoomTurnRows } from "./room-turn-rows.ts";
import { runTranscriptBackfill } from "./transcript-backfill.ts";
import { indexStats } from "./branch-index.ts";
import { Store } from "./store.ts";
import { renderLearnedBlock } from "./memory/lessons.ts";
import { setMemoryMode } from "./memory/repository.ts";
import * as messages from "./message-db.ts";
import { measureReads } from "./testing/bounded-reads.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const messagesDb = () => join(DATA_DIR, "messages.db");
const IMAGE = "22222222-2222-4222-8222-222222222222.png";
const TAGGED = "33333333-3333-4333-8333-333333333333.png";
let store: Store, side: DatabaseSync;
const T = { plans: "t-plans", feedback: "t-feedback", room: "t-room", pin: "t-pin", copy: "t-copy", images: "t-images", edit: "t-edit" };

/** Prepare a thread the way a turn does: the derived tables of the lane in force, whatever it is. */
async function prepared(threadId: string) {
  const prepare = (store as unknown as { prepareThread?: (id: string) => Promise<void> }).prepareThread;
  if (prepare) await prepare.call(store, threadId);
}
/** The background pass that fills the older lane's derived tables (a no-op for a lane that prepares per thread). */
async function settle() {
  const gate = { admit: () => ({ admitted: true, retryInMs: 0 }) } as never;
  await runTranscriptBackfill(database(), () => true, { gate });
}

/** `count` rows of a thread linked parent to child: c-1 .. c-count, text rows unless `kinds` says otherwise. */
function chain(threadId: string, count: number, prefix = "c") {
  side.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<CAST(? AS INTEGER))
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT ?, ?||'-'||v, 1700000000000+v, 'user', 'text', 'line '||v,
      json_object('id',?||'-'||v,'at',1700000000000+v,'role','user','kind','text','text','line '||v,'parentId',CASE WHEN v=1 THEN NULL ELSE ?||'-'||(v-1) END) FROM n`).run(count, threadId, prefix, prefix, prefix);
  side.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(threadId, `${prefix}-${count}`);
}
let seq = 0;
function put(threadId: string, row: Record<string, unknown>) {
  const id = String(row.id ?? `x-${++seq}`);
  const full = { id, at: 1700000000000 + (++seq), role: "bot", kind: "text", ...row };
  side.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(threadId, id, full.at, full.role, full.kind, (full as { text?: string }).text ?? null, JSON.stringify(full));
  return id;
}
/** `count` rows of one shape appended without parent links (a room's rows). */
function plain(threadId: string, count: number, shape: { role: string; kind: string; text: string | null; prefix: string; turnId?: string }) {
  side.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<CAST(? AS INTEGER))
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT ?, ?||v, 1700000000000+v, ?, ?, ?, json_object('id',?||v,'at',1700000000000+v,'role',?,'kind',?,'text',?,'turnId',?) FROM n`)
    .run(count, threadId, shape.prefix, shape.role, shape.kind, shape.text, shape.prefix, shape.role, shape.kind, shape.text, shape.turnId ?? null);
}

beforeAll(async () => {
  removeTempDirSync(DATA_DIR);
  mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  store = new Store(selection);
  side = new DatabaseSync(messagesDb());
  side.exec("PRAGMA busy_timeout=30000");
}, 120_000);
afterAll(() => { side?.close(); });

const steps: Array<[string, () => Promise<void>]> = [];
const step = (name: string, run: () => Promise<void>) => { steps.push([name, run]); };

// R1: the two statements of a send and of an output publication must use the index made for them, not the thread index.
step("R1: onboarding dismissal and artifact lookup never scan the thread or the inbox history", async () => {
  chain(T.plans, 4_000, "p");
  for (let i = 0; i < 40; i++) put(T.plans, { role: "bot", kind: "options", text: "Try this", card: { title: `Suggestion ${i}`, options: ["Yes", "No"] }, parentId: `p-${4_000 - i}` });
  put(T.plans, { role: "bot", kind: "text", text: "saved", artifactIds: ["a1"], parentId: "p-3999" });
  side.exec("ANALYZE");
  const run = await measureReads(T.plans, messagesDb(), () => { messages.openOnboardingCards(T.plans); messages.artifactRows(T.plans); });
  // the plan keys are the first 160 characters of a statement: with `seq` selected beside `json` (ROOM-ORDER-DESIGN r8, transcript-seq.ts rowToMessage)
  // the artifact statement's key ends at `'$.artifact`, so it is matched by that and by its index name
  const wanted = run.reads.plans.filter(({ sql }) => /FROM messages/i.test(sql) && /kind = 'options'|\$\.artifact|INDEXED BY messages_inbox_text_artifact\b/.test(sql));
  expect(wanted.length).toBeGreaterThanOrEqual(2);
  const bad: string[] = [];
  for (const { sql, plan } of wanted) for (const detail of plan) if (/\bmessages\b.*\bINDEX (messages_thread|messages_inbox)\b(?!_)|SCAN messages/.test(detail)) bad.push(`${sql.slice(0, 60)} => ${detail}`);
  expect(bad).toEqual([]);
});

// R2: old feedback must not make a turn walk the branch.
step("R2: one old detected feedback record in a 200,000-message thread costs no branch walk", async () => {
  chain(T.feedback, 200_000, "f");
  const db = database();
  db.prepare("INSERT INTO memory_feedback(id,bot_id,thread_id,message_id,target_message_id,polarity,strength,correction,state,scope,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run("fb1", "b", T.feedback, "f-5", "f-4", "-", 3, "shorter please", "detected", "chat", 1000);
  await prepared(T.feedback);
  let asked = 0;
  const member = store.branchMembership(T.feedback);
  const before = indexStats.rowReads + indexStats.segReads;
  const started = performance.now();
  renderLearnedBlock(db, { botId: "b", threadId: T.feedback, ownerAudience: true, now: 1_700_000_000_000,
    turnsSince: () => 1_000, onPath: (id) => { asked++; return member(id); } });
  const elapsed = performance.now() - started;
  expect(asked).toBe(0); // an old signal is dropped by its age before its branch is asked about
  expect(indexStats.rowReads + indexStats.segReads - before).toBeLessThanOrEqual(64);
  expect(elapsed).toBeLessThan(250);
  // and a recent one is judged by key, not by a walk
  const recent = performance.now();
  const reads = indexStats.rowReads + indexStats.segReads;
  renderLearnedBlock(db, { botId: "b", threadId: T.feedback, ownerAudience: true, now: 1_700_000_000_000, turnsSince: () => 0, onPath: (id) => member(id) });
  expect(indexStats.rowReads + indexStats.segReads - reads).toBeLessThanOrEqual(64);
  expect(performance.now() - recent).toBeLessThan(250);
});

// R3: a row spliced in front of another is on the branch.
step("R3: a spliced message is on the branch it was spliced into", async () => {
  const bot = store.createBot({ name: "Splicer" });
  const a = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "A" });
  const b = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "B" });
  const before = store.insertMessageBefore(bot.threadId, b.id, { role: "bot", kind: "text", text: "I before B" });
  (store as unknown as { threads: Map<string, unknown> }).threads.delete(bot.threadId);
  await prepared(bot.threadId);
  const member = store.branchMembership(bot.threadId);
  expect([member(a.id), member(before.id), member(b.id)]).toEqual([true, true, true]);
  // and after an anchor with a fork under it
  const c = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "C" });
  const after = store.insertMessageAfter(bot.threadId, a.id, { role: "bot", kind: "text", text: "I after A" });
  (store as unknown as { threads: Map<string, unknown> }).threads.delete(bot.threadId);
  await prepared(bot.threadId);
  const again = store.branchMembership(bot.threadId);
  expect([again(a.id), again(after.id), again(before.id), again(b.id), again(c.id)]).toEqual([true, true, true, true, true]);
});

// R4: a tool-heavy interval must not hide the conversation; a pinned quote keeps its quoted line.
step("R4: thirty context lines after 8,999 activity rows, and a pin keeps the line it quotes", async () => {
  plain(T.room, 190_000, { role: "user", kind: "text", text: "a line", prefix: "r" });
  put(T.room, { id: "tail-line", role: "bot", kind: "text", text: "the last line" });
  plain(T.room, 8_999, { role: "bot", kind: "activity", text: null, prefix: "act" });
  await prepared(T.room);
  const read = readRoomTurnRows(store, T.room, undefined);
  const lines = roomContextMessages(read.rows, GROUP_CONTEXT_MESSAGES);
  const expected = (side.prepare("SELECT id FROM messages WHERE thread_id=? AND kind='text' AND text IS NOT NULL AND text<>'' ORDER BY rowid DESC LIMIT 30").all(T.room) as Array<{ id: string }>).map((r) => r.id).reverse();
  expect(lines.map((m) => m.id)).toEqual(expected);

  chain(T.pin, 50_000, "q");
  put(T.pin, { id: "quoted-instruction", role: "user", kind: "text", text: "always answer in French" });
  put(T.pin, { id: "the-pin", role: "bot", kind: "text", text: "pinned answer", replyToId: "quoted-instruction" });
  plain(T.pin, 3_000, { role: "user", kind: "text", text: "later talk", prefix: "later" });
  await prepared(T.pin);
  const pinned = readRoomTurnRows(store, T.pin, "the-pin");
  const ids = new Set(pinned.rows.map((m) => m.id));
  expect(ids.has("the-pin")).toBe(true);
  expect(ids.has("quoted-instruction")).toBe(true);
});

// R5: a delegated turn's copy links its introduction and its final answer.
step("R5: the originals of a turn that wrote 5,000 activity rows between its text rows are all found", async () => {
  chain(T.copy, 30_000, "k");
  put(T.copy, { id: "intro", role: "bot", kind: "text", text: "On it.", turnId: "turn-1", parentId: "k-30000" });
  plain(T.copy, 5_001, { role: "bot", kind: "activity", text: null, prefix: "work", turnId: "turn-1" });
  put(T.copy, { id: "final", role: "bot", kind: "text", text: "Done: all of it.", turnId: "turn-1" });
  const first = side.prepare("SELECT rowid AS r FROM messages WHERE thread_id=? AND id='intro'").get(T.copy) as { r: number };
  side.prepare("INSERT OR REPLACE INTO turn_first(thread_id,turn_id,first_rowid) VALUES(?,?,?)").run(T.copy, "turn-1", first.r);
  await prepared(T.copy);
  const originals = (store as unknown as { turnReplyOriginals?: (t: string, turn: string) => string[] }).turnReplyOriginals;
  const ids = originals
    ? originals.call(store, T.copy, "turn-1")
    : store.turnRows(T.copy, "turn-1").filter((m) => m.role === "bot" && m.kind === "text" && !m.copyOf).map((m) => m.id);
  expect(ids).toEqual(["intro", "final"]);
});

// R6: the four paths that used to read or walk a whole thread answer by key on a 200,000-message thread.
step("R6: a card on the branch, an unconfirmed steer and the newest screen frame are found by key", async () => {
  chain(T.edit, 200_000, "e");
  put(T.edit, { id: "e-card", role: "bot", kind: "options", text: "Allow?", parentId: "e-3", card: { title: "Old", options: ["Allow", "Deny"], requestId: "req-old" } });
  put(T.edit, { id: "e-steer", role: "user", kind: "text", text: "steer me", parentId: "e-200000", steerUnconfirmed: true, interjectionId: "ij-1" });
  await settle();
  await prepared(T.edit);
  const reads = await measureReads(T.edit, messagesDb(), () => {
    store.openCardsOnBranch(T.edit);
    store.keyedCards(T.edit, "steer");
    store.newestScreenWithPixels(T.edit);
    return store.branchMembership(T.edit)("e-card");
  });
  expect(reads.reads.scans).toEqual([]);
  expect(reads.reads.rows).toBeLessThanOrEqual(200);
  const loaded = (store as unknown as { threads: { has(id: string): boolean } }).threads.has(T.edit);
  expect(loaded).toBe(false);
});

// R7: editing far back does not process the unchanged history.
step("R7: an edit 6,000 rows from the end of a 200,000-message thread reads about the rows it changes", async () => {
  setMemoryMode("capture");
  await prepared(T.edit);
  const run = await measureReads(T.edit, messagesDb(), () => {
    messages.appendMessage(T.edit, { id: "edited", at: 1_800_000_000_000, role: "user", kind: "text", text: "edited words", parentId: "e-194000" });
  });
  expect(run.reads.rows).toBeLessThanOrEqual(2_000);
});

// R8: an image older than the newest rows still resolves, before and after the fill.
step("R8: an attachment and a legacy <attached-image> tag far back in a 200,000-message thread still resolve", async () => {
  const dir = ATTACHMENTS_DIR;
  writeFileSync(join(dir, IMAGE), Buffer.alloc(8));
  writeFileSync(join(dir, TAGGED), Buffer.alloc(8));
  chain(T.images, 200_000, "i");
  side.prepare("UPDATE messages SET json=json_set(json,'$.attachments',json(?)) WHERE thread_id=? AND id='i-5'").run(JSON.stringify([{ kind: "image", path: join(dir, IMAGE), mime: "image/png" }]), T.images);
  side.prepare("UPDATE messages SET json=json_set(json,'$.text',?), text=? WHERE thread_id=? AND id='i-6'").run(`look\n<attached-image path="${join(dir, TAGGED)}" />\n`, `look\n<attached-image path="${join(dir, TAGGED)}" />\n`, T.images);
  await prepared(T.images);
  const bound = store.boundAttachments(T.images, [join(dir, IMAGE)]);
  expect([...bound.keys()]).toEqual([join(dir, IMAGE)]);
  const allowed = conversationImageAttachments(store, T.images, dir, [IMAGE, TAGGED]);
  expect([...allowed.keys()].sort()).toEqual([IMAGE, TAGGED].sort());
});

it("Astra's r2 reproductions", async () => {
  const failed: string[] = [];
  for (const [name, run] of steps) {
    try { await run(); console.log(`PASS ${name}`); } catch (error) { failed.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  expect(failed).toEqual([]);
}, 1_800_000);
