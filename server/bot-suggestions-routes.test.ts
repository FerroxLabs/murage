// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Learning > Suggestions (lessons that wait for the owner's yes) and the Unsure
// rows (feedback the detector was not sure about), through the real dispatcher
// and database. Apply / Edit / Not now; Yes / No.
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import "./bot-learning-modules.ts";
import { handleBotLearningApi, resetBotLearningApiForTest } from "./bot-learning-api.ts";
import { closeDatabase, database } from "./database.ts";
import { DEFAULT_BOT_LEARNING } from "./bot-learning.ts";
import { addLesson, listLessons } from "./memory/lessons.ts";
import { setLessonRoster, suggestLessonShare } from "./memory/lesson-sharing.ts";
import { inboxSuggestionRows } from "./inbox-learning-suggestions.ts";

const bots = new Map([["ember", { id: "ember", name: "Ember" }], ["dax", { id: "dax", name: "Dax" }]]);
let sequence = 0;
const call = (method: string, target: string, body?: Record<string, unknown>) => handleBotLearningApi({
  method, path: target.split("?")[0]!, url: new URL(`http://localhost${target}`), headers: { "idempotency-key": `key-${++sequence}-abcdefgh` },
  readBody: async () => body ?? {}, bot: id => bots.get(id), saveLearning: () => {},
});
const body = async (promise: ReturnType<typeof call>) => { const answer = (await promise)!; return { status: answer.status, ...(answer.body as any) }; };
const suggest = (botId: string, text: string) => {
  const result = addLesson(database(), { botId, text, origin: "feedback", learning: { ...DEFAULT_BOT_LEARNING, askFirst: true } });
  if (result.status !== "suggested") throw new Error(`expected a suggestion, got ${result.status}`);
  return result.lesson;
};

beforeAll(() => { closeDatabase(); mkdirSync(DATA_DIR, { recursive: true }); resetBotLearningApiForTest(); database(); });
afterAll(() => closeDatabase());
beforeEach(() => { database().exec("DELETE FROM memory_lessons; DELETE FROM memory_feedback; DELETE FROM messages WHERE thread_id='th'"); });

describe("suggestions", () => {
  it("lists only lessons that wait for a decision, for this bot", async () => {
    const mine = suggest("ember", "Lead with the decision in board updates");
    suggest("dax", "Another bot's suggestion");
    addLesson(database(), { botId: "ember", text: "Already active", origin: "typed", learning: DEFAULT_BOT_LEARNING });
    const list = await body(call("GET", "/api/bots/ember/learning/suggestions"));
    expect(list.status).toBe(200);
    expect(list.suggestions).toEqual([expect.objectContaining({ id: mine.id, kind: "lesson", text: "Lead with the decision in board updates", version: 1, origin: "feedback", prospectDerived: false })]);
  });

  it("Apply makes it a lesson that applies from the next turn, needs its version, and counts as learned", async () => {
    const lesson = suggest("ember", "Keep client emails under 120 words");
    const learned = () => Number(database().prepare("SELECT COUNT(*) c FROM memory_learning_events WHERE bot_id='ember' AND kind='lesson-learned'").get()?.c);
    const before = learned();
    const stale = await body(call("POST", `/api/bots/ember/learning/suggestions/${lesson.id}/apply`, { expectedRevision: 9 }));
    expect(stale).toMatchObject({ status: 409, code: "REVISION_CONFLICT" });
    const applied = await body(call("POST", `/api/bots/ember/learning/suggestions/${lesson.id}/apply`, { expectedRevision: 1 }));
    expect(applied).toMatchObject({ status: 200, lesson: { id: lesson.id, state: "active" } });
    expect((await body(call("GET", "/api/bots/ember/learning/suggestions"))).suggestions).toEqual([]);
    expect(learned()).toBe(before + 1);
  });

  it("Edit changes the words and keeps it waiting; Apply then publishes the owner's version", async () => {
    const lesson = suggest("ember", "Reply fast");
    const edited = await body(call("POST", `/api/bots/ember/learning/suggestions/${lesson.id}/edit`, { expectedRevision: 1, text: "Reply within an hour on weekdays" }));
    expect(edited).toMatchObject({ status: 200, lesson: { text: "Reply within an hour on weekdays", state: "suggested", version: 2 } });
    expect((await body(call("POST", `/api/bots/ember/learning/suggestions/${lesson.id}/edit`, { expectedRevision: 1, text: "x" }))).status).toBe(409);
    const applied = await body(call("POST", `/api/bots/ember/learning/suggestions/${lesson.id}/apply`, { expectedRevision: 2 }));
    expect(applied).toMatchObject({ status: 200, lesson: { text: "Reply within an hour on weekdays", state: "active" } });
  });

  it("Not now hides it and records nothing as learned; a suggestion for another bot is not found", async () => {
    const lesson = suggest("ember", "Never use emojis");
    const learned = () => Number(database().prepare("SELECT COUNT(*) c FROM memory_learning_events WHERE kind='lesson-learned'").get()?.c);
    const before = learned();
    expect((await body(call("POST", `/api/bots/dax/learning/suggestions/${lesson.id}/not-now`, { expectedRevision: 1 }))).status).toBe(404);
    expect(await body(call("POST", `/api/bots/ember/learning/suggestions/${lesson.id}/not-now`, { expectedRevision: 1 }))).toMatchObject({ status: 200 });
    expect((await body(call("GET", "/api/bots/ember/learning/suggestions"))).suggestions).toEqual([]);
    expect(listLessons(database(), "ember").find(item => item.id === lesson.id)?.state).toBe("retired");
    expect(learned()).toBe(before);
  });

  it("the inbox gets one row per waiting suggestion, with the bot's name, and nothing else", () => {
    suggest("ember", "Lead with the decision");
    addLesson(database(), { botId: "dax", text: "Active lessons are not inbox items", origin: "typed", learning: DEFAULT_BOT_LEARNING });
    const rows = inboxSuggestionRows(database(), id => bots.get(id)?.name);
    expect(rows).toEqual([expect.objectContaining({ botId: "ember", botName: "Ember", text: "Lead with the decision" })]);
    expect(Object.keys(rows[0]!).sort()).toEqual(["at", "botId", "botName", "kind", "lessonId", "lessonKind", "text", "version"]);
    expect(rows[0]).toMatchObject({ kind: "lesson" });
  });
});

describe("the inbox carries share suggestions too (suggestions only)", () => {
  it("a lesson offered to other bots is one owed row that names who it is for", () => {
    const source = addLesson(database(), { botId: "ember", text: "Lead with the decision", origin: "typed", learning: DEFAULT_BOT_LEARNING });
    if (source.status !== "applied") throw new Error("setup");
    setLessonRoster(() => [{ id: "ember", name: "Ember" }, { id: "dax", name: "Dax" }]);
    let share;
    try { share = suggestLessonShare(database(), { botId: "ember", lessonId: source.lesson.id, recipients: ["dax"] }); } finally { setLessonRoster(null); }
    setLessonRoster(() => [{ id: "ember", name: "Ember" }, { id: "dax", name: "Dax" }]);
    const rows = (() => { try { return inboxSuggestionRows(database(), id => bots.get(id)?.name); } finally { setLessonRoster(null); } })();
    expect(rows).toEqual([expect.objectContaining({ lessonId: share.id, kind: "lesson", scope: "bots", fromName: "Ember", recipients: [{ id: "dax", name: "Dax" }] })]);
  });
});

describe("unsure feedback", () => {
  const unsure = (id: string, over: Record<string, unknown> = {}) => {
    const row = { id, bot: "ember", thread: "th", message: `m-${id}`, target: "b1", polarity: "-", strength: 2, correction: "lead with the decision", confidence: 0.4, state: "unsure", ...over };
    const db = database();
    db.prepare("INSERT OR IGNORE INTO messages(thread_id,id,at,role,kind,text,json) VALUES('th','b1',1,'bot','text','Draft','{}')").run();
    db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,2,'user','text',?,'{}')").run(row.thread, row.message, "hmm ok, lead with the decision");
    db.prepare(`INSERT INTO memory_feedback(id,bot_id,thread_id,message_id,target_message_id,target_turn_id,target_action,polarity,strength,correction,confidence,state,scope,acknowledged_at,created_at)
      VALUES(?,?,?,?,?,NULL,NULL,?,?,?,?,?,'chat',NULL,?)`).run(row.id, row.bot, row.thread, row.message, row.target, row.polarity, row.strength, row.correction, row.confidence, row.state, 5);
  };
  it("lists the owner's words on Unsure rows only, newest first", async () => {
    unsure("fb1"); unsure("fb2", { state: "detected" }); unsure("fb3", { bot: "dax" });
    const list = await body(call("GET", "/api/bots/ember/feedback"));
    expect(list.feedback).toEqual([expect.objectContaining({ id: "fb1", threadId: "th", text: "hmm ok, lead with the decision", revision: 1 })]);
  });
  it("Yes confirms it as feedback and forms the lesson it was holding; No ignores it for good", async () => {
    unsure("fb1"); unsure("fb2", { correction: null, polarity: "+", strength: 1 });
    const yes = await body(call("PATCH", "/api/bots/ember/feedback/fb1", { expectedRevision: 1, answer: "yes" }));
    expect(yes).toMatchObject({ status: 200, answer: "yes" });
    expect(database().prepare("SELECT state FROM memory_feedback WHERE id='fb1'").get()?.state).not.toBe("unsure");
    const no = await body(call("PATCH", "/api/bots/ember/feedback/fb2", { expectedRevision: 1, answer: "no" }));
    expect(no).toMatchObject({ status: 200, answer: "no" });
    expect(database().prepare("SELECT state,correction FROM memory_feedback WHERE id='fb2'").get()).toMatchObject({ state: "ignored", correction: null });
    expect((await body(call("GET", "/api/bots/ember/feedback"))).feedback).toEqual([]);
  });
  it("answering twice, a stale revision, or a bad answer is refused plainly", async () => {
    unsure("fb1");
    expect((await body(call("PATCH", "/api/bots/ember/feedback/fb1", { expectedRevision: 1, answer: "maybe" }))).status).toBe(400);
    expect((await body(call("PATCH", "/api/bots/ember/feedback/fb1", { expectedRevision: 4, answer: "no" }))).status).toBe(409);
    await body(call("PATCH", "/api/bots/ember/feedback/fb1", { expectedRevision: 1, answer: "no" }));
    expect((await body(call("PATCH", "/api/bots/ember/feedback/fb1", { expectedRevision: 1, answer: "yes" }))).status).toBe(409);
    expect((await body(call("PATCH", "/api/bots/dax/feedback/fb1", { expectedRevision: 1, answer: "no" }))).status).toBe(404);
  });
});
