// A bot's suggestion (a lesson waiting for the owner's yes) is owed in the Inbox's Needs you count, and the sidebar badge
// re-reads only when the server says `inbox.changed`. Answering one writes no message, so the route itself must say so,
// or the page reads 0 while the badge keeps 1 (reported on 1.0.23). Real dispatcher, real database.
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import "./bot-learning-modules.ts";
import { handleBotLearningApi, resetBotLearningApiForTest } from "./bot-learning-api.ts";
import { closeDatabase, database } from "./database.ts";
import { DEFAULT_BOT_LEARNING } from "./bot-learning.ts";
import { addLesson } from "./memory/lessons.ts";
import { onMessagesChanged } from "./inbox-version.ts";

const bots = new Map([["dax", { id: "dax", name: "Dax" }]]);
let sequence = 0;
// what index.ts subscribes announceInboxChanged to: the sidebar's `inbox.changed` frame
const inboxChanged = vi.fn();
onMessagesChanged(inboxChanged);
const call = (method: string, target: string, body?: Record<string, unknown>) => handleBotLearningApi({
  method, path: target.split("?")[0]!, url: new URL(`http://localhost${target}`), headers: { "idempotency-key": `key-${++sequence}-abcdefgh` },
  readBody: async () => body ?? {}, bot: id => bots.get(id), saveLearning: () => {},
});
const suggest = (text: string) => {
  const result = addLesson(database(), { botId: "dax", text, origin: "feedback", learning: { ...DEFAULT_BOT_LEARNING, askFirst: true } });
  if (result.status !== "suggested") throw new Error(`expected a suggestion, got ${result.status}`);
  return result.lesson;
};

beforeAll(() => { closeDatabase(); mkdirSync(DATA_DIR, { recursive: true }); resetBotLearningApiForTest(); database(); });
afterAll(() => closeDatabase());
beforeEach(() => { database().exec("DELETE FROM memory_lessons; DELETE FROM memory_feedback"); inboxChanged.mockClear(); });

it("approving the only suggestion tells the Inbox it changed, once", async () => {
  const lesson = suggest("Keep client emails under 120 words");
  const applied = await call("POST", `/api/bots/dax/learning/suggestions/${lesson.id}/apply`, { expectedRevision: 1 });
  expect(applied).toMatchObject({ status: 200 });
  expect(inboxChanged).toHaveBeenCalledTimes(1);
});

it("Not now tells it too; a read or a refused answer does not", async () => {
  const lesson = suggest("Reply fast");
  await call("GET", "/api/bots/dax/learning/suggestions");
  expect((await call("POST", `/api/bots/dax/learning/suggestions/${lesson.id}/apply`, { expectedRevision: 9 }))!.status).toBe(409);
  expect(inboxChanged).not.toHaveBeenCalled();
  expect((await call("POST", `/api/bots/dax/learning/suggestions/${lesson.id}/not-now`, { expectedRevision: 1 }))!.status).toBe(200);
  expect(inboxChanged).toHaveBeenCalledTimes(1);
});
