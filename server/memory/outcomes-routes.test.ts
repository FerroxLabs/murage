// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The outcome routes and the decision-site watch, against the real database
// (a clean test data directory). The server-level shape (desktop only,
// revision and idempotency rules) is covered in bot-learning-api.test.ts.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { learningRouteHandler, type LearningRouteContext } from "../bot-learning-routes.ts";
import { appendDecision, flushDecisionLog } from "../decision-log.ts";
import { proposeOutcomeFromAgent, setOutcomeBotLookup } from "./outcomes.ts";
import { chipItemsForThread } from "./lessons.ts";
import "./outcomes-routes.ts";

const bot = { id: "bot", name: "Dax", threadId: "t1", learning: { enabled: true, askFirst: false, prospectLearning: false, revision: 0 } };
const call = async (id: Parameters<typeof learningRouteHandler>[0], context: Partial<LearningRouteContext>) =>
  learningRouteHandler(id)!({ botId: "bot", method: "POST", url: new URL("http://x/api"), body: {}, ...context } as LearningRouteContext);

beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  setOutcomeBotLookup(id => (id === "bot" ? bot : null));
  const db = database();
  db.exec("UPDATE memory_meta SET mode='active'");
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t1','m1',1,'bot','text','hi','{}')").run();
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t1','u1',2,'user','text','hello','{}')").run();
});

it("claims every outcome route", () => {
  for (const id of ["outcomes.list", "outcomes.add", "outcomes.change"] as const) expect(learningRouteHandler(id), id).toBeTypeOf("function");
});

it("marks, lists, edits with the revision it was based on, and refuses a stale one", async () => {
  const empty = await call("outcomes.list", { method: "GET" });
  expect(empty.body).toMatchObject({ outcomes: [], counts: { won: 0 } });
  const stale = await call("outcomes.add", { body: { threadId: "t1", messageId: "m1", kind: "won" }, expectedRevision: 3 });
  expect(stale).toMatchObject({ status: 409, body: { code: "REVISION_CONFLICT", revision: 0 } });
  const marked = await call("outcomes.add", { body: { threadId: "t1", messageId: "m1", kind: "won" }, expectedRevision: 0 });
  expect(marked.status).toBe(200);
  const { id, revision } = (marked.body as any).outcome;
  expect(revision).toBe(1);
  const detail = await call("outcomes.change", { method: "PATCH", itemId: id, body: { value: 900, currency: "usd", reason: "Signed" }, expectedRevision: 1 });
  expect(detail).toMatchObject({ status: 200, body: { outcome: { value: 900, currency: "USD", revision: 2 } } });
  expect((await call("outcomes.change", { method: "PATCH", itemId: id, body: { revoke: true }, expectedRevision: 1 })).status).toBe(409);
  const listed = await call("outcomes.list", { method: "GET", url: new URL("http://x/api?threadId=t1") });
  expect((listed.body as any).outcomes).toHaveLength(1);
  expect((listed.body as any).counts.won).toBe(1);
});
it("answers a proposal through the same route, and Not yet keeps the count at zero", async () => {
  const proposed = (proposeOutcomeFromAgent(database(), { botId: "bot", threadId: "t1", note: "closed?" }).body as any).outcome;
  const listed = await call("outcomes.list", { method: "GET", url: new URL("http://x/api?state=proposed") });
  expect((listed.body as any).outcomes.map((row: any) => row.id)).toEqual([proposed.id]);
  const notYet = await call("outcomes.change", { method: "PATCH", itemId: proposed.id, body: { answer: "not-yet" }, expectedRevision: 1 });
  expect(notYet).toMatchObject({ status: 200, body: { outcome: { state: "dismissed" } } });
  expect((await call("outcomes.list", { method: "GET" })).body).toMatchObject({ outcomes: [], counts: { proposed: 0, won: 0 } });
});
it("an outcome the owner confirms from the proposal card earns the win chip under the bot's reply, once; Not yet earns nothing", async () => {
  const wins = () => database().prepare("SELECT detail FROM memory_learning_events WHERE kind='outcome-marked' AND json_extract(detail,'$.chip')=1").all().map((row: any) => JSON.parse(row.detail));
  const first = (proposeOutcomeFromAgent(database(), { botId: "bot", threadId: "t1", note: "closed?" }).body as any).outcome;
  await call("outcomes.change", { method: "PATCH", itemId: first.id, body: { answer: "not-yet" }, expectedRevision: 1 });
  expect(wins()).toEqual([]);
  database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t1','u2',3,'user','text','any news',?)").run("{}");
  const second = (proposeOutcomeFromAgent(database(), { botId: "bot", threadId: "t1", note: "closed?", now: Date.now() + 8 * 24 * 3600_000 }).body as any).outcome; // after the 7 quiet days that follow Not yet
  const answered = await call("outcomes.change", { method: "PATCH", itemId: second.id, body: { answer: "won" }, expectedRevision: 1 });
  expect(answered).toMatchObject({ status: 200, body: { outcome: { kind: "won", state: "confirmed" } } });
  expect(wins()).toEqual([expect.objectContaining({ variant: "win", threadId: "t1", replyMessageId: "m1", exemplarKey: `outcome:${second.id}` })]);
  // answering the same card again never writes a second chip
  await call("outcomes.change", { method: "PATCH", itemId: second.id, body: { answer: "won" }, expectedRevision: 1 });
  expect(wins()).toHaveLength(1);
});
it("refuses unknown fields, a missing bot and a message that is not there", async () => {
  expect((await call("outcomes.add", { body: { threadId: "t1", messageId: "none", kind: "won" }, expectedRevision: 0 })).status).toBe(404);
  expect((await call("outcomes.add", { botId: "other", body: { threadId: "t1", messageId: "m1", kind: "won" }, expectedRevision: 0 })).status).toBe(404);
  const marked = (await call("outcomes.add", { body: { threadId: "t1", messageId: "m1", kind: "good" }, expectedRevision: 0 })).body as any;
  expect((await call("outcomes.change", { method: "PATCH", itemId: marked.outcome.id, body: { surprise: 1 }, expectedRevision: 1 })).status).toBe(400);
});

it("a message in another bot's conversation cannot be marked through this bot", async () => {
  database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t9','m9',3,'bot','text','hi','{}')").run();
  expect((await call("outcomes.add", { body: { threadId: "t9", messageId: "m9", kind: "won" }, expectedRevision: 0 })).status).toBe(404);
  database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('room','m10',4,'bot','text','hi',?)").run(JSON.stringify({ from: { botId: "bot" } }));
  expect((await call("outcomes.add", { body: { threadId: "room", messageId: "m10", kind: "won" }, expectedRevision: 0 })).status).toBe(200);
});

it("the decision site keeps the owner's own answer and nothing else", async () => {
  const row = { threadId: "t1", botId: "bot", botName: "Dax", tool: "Bash", summary: "ls" };
  appendDecision(DATA_DIR, { ...row, requestId: "r1", decision: "user-approved", source: "user" });
  appendDecision(DATA_DIR, { ...row, requestId: "r2", decision: "auto-approved", source: "grant" as any });
  appendDecision(DATA_DIR, { ...row, requestId: "r3", decision: "user-denied", source: "user" });
  appendDecision(DATA_DIR, { ...row, requestId: "r4", decision: "card-shown", source: "no-grant" as any });
  appendDecision(DATA_DIR, { ...row, requestId: "r5", decision: "user-approved", source: "auto-review" });
  appendDecision(DATA_DIR, { ...row, requestId: "r1", decision: "user-approved", source: "user" });
  await flushDecisionLog(DATA_DIR);
  const rows = database().prepare("SELECT id,polarity,strength,target_action FROM memory_feedback ORDER BY id").all();
  expect(rows).toEqual([
    { id: "approval:r1", polarity: "+", strength: 1, target_action: "approval:Bash" },
    { id: "approval:r3", polarity: "-", strength: 1, target_action: "approval:Bash" },
  ]);
});
it("keeps nothing when the bot has learning off, or the bot is unknown", async () => {
  setOutcomeBotLookup(() => ({ ...bot, learning: { ...bot.learning, enabled: false } }));
  appendDecision(DATA_DIR, { threadId: "t1", botId: "bot", requestId: "r1", decision: "user-approved", source: "user" });
  setOutcomeBotLookup(undefined);
  appendDecision(DATA_DIR, { threadId: "t1", botId: "bot", requestId: "r2", decision: "user-approved", source: "user" });
  await flushDecisionLog(DATA_DIR);
  expect(database().prepare("SELECT COUNT(*) n FROM memory_feedback").get()?.n).toBe(0);
});
const chips = () => chipItemsForThread(database(), { botId: "bot", threadId: "t1", now: Date.now() }).filter(item => item.kind === "kept");
it("revoking an outcome removes its already-written win chip", async () => {
  const marked = await call("outcomes.add", { body: { threadId: "t1", messageId: "m1", kind: "won" }, expectedRevision: 0 });
  const { id } = (marked.body as any).outcome;
  expect(chips()).toHaveLength(1);
  const revoked = await call("outcomes.change", { method: "PATCH", itemId: id, body: { revoke: true }, expectedRevision: 1 });
  expect(revoked.status).toBe(200);
  expect(chips()).toEqual([]);
  expect(database().prepare("SELECT undone_at FROM memory_learning_events WHERE kind='outcome-marked' AND json_extract(detail,'$.exemplarKey')=?").get(`outcome:${id}`)?.undone_at).toBeTypeOf("number");
});
it("a mark flipped to lost takes the win chip with it", async () => {
  const marked = await call("outcomes.add", { body: { threadId: "t1", messageId: "m1", kind: "won" }, expectedRevision: 0 });
  expect(chips()).toHaveLength(1);
  const flipped = await call("outcomes.add", { body: { threadId: "t1", messageId: "m1", kind: "lost" }, expectedRevision: (marked.body as any).outcome.revision });
  expect(flipped.status).toBe(200);
  expect(chips()).toEqual([]);
});
