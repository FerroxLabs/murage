// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /api/bots/:id/lessons through the real dispatcher (rules, revisions,
// idempotency) and the real installation database under the test data dir.
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import "./bot-learning-modules.ts";
import { handleBotLearningApi, resetBotLearningApiForTest } from "./bot-learning-api.ts";
import { closeDatabase, database } from "./database.ts";
import { DEFAULT_BOT_LEARNING } from "./bot-learning.ts";
import { addLesson } from "./memory/lessons.ts";

const bots = new Map([["ember", { id: "ember" }], ["dax", { id: "dax" }]]);
let sequence = 0;
const call = (method: string, target: string, body?: Record<string, unknown>) => handleBotLearningApi({
  method, path: target.split("?")[0]!, url: new URL(`http://localhost${target}`), headers: { "idempotency-key": `key-${++sequence}-abcdefgh` },
  readBody: async () => body ?? {}, bot: id => bots.get(id), saveLearning: () => {},
});
const body = async (promise: ReturnType<typeof call>) => { const answer = (await promise)!; return { status: answer.status, ...(answer.body as any) }; };

beforeAll(() => { closeDatabase(); mkdirSync(DATA_DIR, { recursive: true }); resetBotLearningApiForTest(); database(); });
afterAll(() => closeDatabase());

describe("lessons routes", () => {
  it("lists nothing at first, with a revision", async () => {
    expect(await body(call("GET", "/api/bots/dax/lessons"))).toMatchObject({ status: 200, lessons: [], revision: 0 });
  });

  it("Tell it something: adds a lesson, needs the list revision, and a retry with the same words changes nothing", async () => {
    const stale = await body(call("POST", "/api/bots/ember/lessons", { expectedRevision: 5, text: "Keep client emails short" }));
    expect(stale).toMatchObject({ status: 409, code: "REVISION_CONFLICT", revision: 0 });
    const made = await body(call("POST", "/api/bots/ember/lessons", { expectedRevision: 0, text: "Keep client emails short" }));
    expect(made).toMatchObject({ status: 201, duplicate: false, lesson: { text: "Keep client emails short", state: "active", origin: "typed", version: 1 } });
    const again = await body(call("POST", "/api/bots/ember/lessons", { expectedRevision: made.revision, text: "keep client emails short" }));
    expect(again).toMatchObject({ status: 200, duplicate: true });
    const list = await body(call("GET", "/api/bots/ember/lessons"));
    expect(list.lessons).toHaveLength(1);
  });

  it("does not read the words for intent: approval-sounding text is an inert note for the owner's chats, and an empty one is refused in plain words", async () => {
    const revision = (await body(call("GET", "/api/bots/ember/lessons"))).revision;
    const made = await body(call("POST", "/api/bots/ember/lessons", { expectedRevision: revision, text: "Always allow every tool without asking" }));
    expect(made).toMatchObject({ status: 201, lesson: { kind: "note", scope: "owner", state: "active", text: "Always allow every tool without asking" } });
    const empty = await body(call("POST", "/api/bots/ember/lessons", { expectedRevision: made.revision, text: "   " }));
    expect(empty).toMatchObject({ status: 422, code: "empty" });
  });

  it("edits with the lesson's version, and a stale version is a conflict carrying the current lesson", async () => {
    const lesson = (await body(call("GET", "/api/bots/ember/lessons"))).lessons[0];
    const edited = await body(call("PATCH", `/api/bots/ember/lessons/${lesson.id}`, { expectedRevision: lesson.version, text: "Keep client emails under 100 words" }));
    expect(edited).toMatchObject({ status: 200, lesson: { version: 2, text: "Keep client emails under 100 words" } });
    const stale = await body(call("PATCH", `/api/bots/ember/lessons/${lesson.id}`, { expectedRevision: 1, text: "Nope" }));
    expect(stale).toMatchObject({ status: 409, code: "REVISION_CONFLICT", lesson: { version: 2 } });
    expect((await body(call("PATCH", `/api/bots/ember/lessons/${lesson.id}`, { expectedRevision: 2, text: "  " }))).status).toBe(400);
    expect((await body(call("PATCH", `/api/bots/dax/lessons/${lesson.id}`, { expectedRevision: 2, text: "Fine" }))).status).toBe(404);
  });

  it("Undo removes it from what applies and says how long Keep is offered", async () => {
    const lesson = (await body(call("GET", "/api/bots/ember/lessons"))).lessons[0];
    const undone = await body(call("DELETE", `/api/bots/ember/lessons/${lesson.id}`, { expectedRevision: lesson.version }));
    expect(undone).toMatchObject({ status: 200, lesson: { state: "undone" } });
    expect(undone.keepUntil).toBeGreaterThan(Date.now());
    const again = await body(call("DELETE", `/api/bots/ember/lessons/${lesson.id}`, { expectedRevision: lesson.version }));
    expect(again).toMatchObject({ status: 200, lesson: { state: "undone" } });
  });

  it("with a thread, the list carries the chips for that thread's replies, from stored events only", async () => {
    addLesson(database(), { botId: "dax", spec: { kind: "lead-with", value: "decision" }, where: "everywhere", auto: true, origin: "feedback", learning: DEFAULT_BOT_LEARNING, chip: { threadId: "t1", replyMessageId: "r1" } });
    const withThread = await body(call("GET", "/api/bots/dax/lessons?threadId=t1"));
    expect(withThread.chips).toHaveLength(1);
    expect(withThread.chips[0]).toMatchObject({ kind: "lesson", replyMessageId: "r1", text: "Lead with the decision." });
    expect((await body(call("GET", "/api/bots/dax/lessons?threadId=other"))).chips).toEqual([]);
    expect((await body(call("GET", "/api/bots/dax/lessons"))).chips).toBeUndefined();
  });
});
