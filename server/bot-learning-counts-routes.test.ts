// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GET /api/bots/:id/learning/counts through the real dispatcher: the month
// counts and the "new since I last looked" number behind the settings badge.
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import "./bot-learning-modules.ts";
import { handleBotLearningApi, resetBotLearningApiForTest } from "./bot-learning-api.ts";
import { closeDatabase, database } from "./database.ts";
import { DEFAULT_BOT_LEARNING } from "./bot-learning.ts";
import { addLesson } from "./memory/lessons.ts";

const bots = new Map([["ember", { id: "ember" }], ["dax", { id: "dax" }]]);
const get = async (target: string) => {
  const answer = (await handleBotLearningApi({
    method: "GET", path: target.split("?")[0]!, url: new URL(`http://localhost${target}`), headers: {},
    readBody: async () => ({}), bot: id => bots.get(id), saveLearning: () => {},
  }))!;
  return { status: answer.status, ...(answer.body as any) };
};

beforeAll(() => { closeDatabase(); mkdirSync(DATA_DIR, { recursive: true }); resetBotLearningApiForTest(); database(); });
afterAll(() => closeDatabase());

describe("learning counts route", () => {
  it("answers zeros for a bot that has learned nothing", async () => {
    expect(await get("/api/bots/dax/learning/counts")).toMatchObject({ status: 200, counts: { lessons: 0, memories: 0, wins: 0, undone: 0 }, unseen: 0 });
  });
  it("counts a lesson this month and as unseen since a time before it", async () => {
    addLesson(database(), { botId: "ember", text: "Lead with the decision", origin: "typed", learning: DEFAULT_BOT_LEARNING });
    const now = await get("/api/bots/ember/learning/counts?since=0");
    expect(now).toMatchObject({ status: 200, counts: { lessons: 1 }, unseen: 1 });
    expect(now.counts.month).toMatch(/^\d{4}-\d{2}$/);
    expect(await get(`/api/bots/ember/learning/counts?since=${Date.now() + 60_000}`)).toMatchObject({ unseen: 0 });
    expect(await get("/api/bots/ember/learning/counts")).toMatchObject({ unseen: 0 });
  });
  it("refuses a bad month or since", async () => {
    expect(await get("/api/bots/ember/learning/counts?month=2026-13")).toMatchObject({ status: 400, code: "INVALID_MONTH" });
    expect(await get("/api/bots/ember/learning/counts?since=abc")).toMatchObject({ status: 400, code: "INVALID_SINCE" });
  });
});
