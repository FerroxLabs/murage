// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sharing a lesson through the real dispatcher (bot-learning batch B11): the share is a suggestion,
// the owner picks recipients on Apply, the lessons list shows where a lesson came from and a conflict.
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import "./bot-learning-modules.ts";
import { handleBotLearningApi, resetBotLearningApiForTest } from "./bot-learning-api.ts";
import { closeDatabase, database } from "./database.ts";
import { setLessonRoster } from "./memory/lesson-sharing.ts";

const bots = new Map(["chief", "dax", "nova"].map(id => [id, { id }]));
let sequence = 0;
const call = (method: string, target: string, body?: Record<string, unknown>) => handleBotLearningApi({
  method, path: target.split("?")[0]!, url: new URL(`http://localhost${target}`), headers: { "idempotency-key": `key-${++sequence}-abcdefgh` },
  readBody: async () => body ?? {}, bot: id => bots.get(id), saveLearning: () => {},
});
const body = async (promise: ReturnType<typeof call>) => { const answer = (await promise)!; return { status: answer.status, ...(answer.body as any) }; };

beforeAll(() => {
  closeDatabase(); mkdirSync(DATA_DIR, { recursive: true }); resetBotLearningApiForTest(); database();
  setLessonRoster(() => [{ id: "chief", name: "Sage", chiefOfStaff: true, section: "s" }, { id: "dax", name: "Dax", section: "s" }, { id: "nova", name: "Nova", section: "s" }]);
});
afterAll(() => { setLessonRoster(null); closeDatabase(); });

describe("share a lesson", () => {
  it("offers it as a suggestion naming the bots, applies only to the ones picked, and shows the source on the recipient", async () => {
    await body(call("POST", "/api/bots/dax/lessons", { expectedRevision: 0, text: "No emojis in client emails" }));
    const added = await body(call("POST", "/api/bots/chief/lessons", { expectedRevision: 0, text: "Use emojis in client emails" }));
    const lesson = added.lesson;
    const offered = await body(call("POST", `/api/bots/chief/lessons/${lesson.id}/share`, { expectedRevision: lesson.version }));
    expect(offered).toMatchObject({ status: 201, suggestion: { state: "suggested", scope: "bots", recipients: [{ id: "dax", name: "Dax" }, { id: "nova", name: "Nova" }] } });
    // nothing reached the others yet
    expect((await body(call("GET", "/api/bots/nova/lessons"))).lessons).toEqual([]);
    const listed = await body(call("GET", "/api/bots/chief/learning/suggestions"));
    expect(listed.suggestions).toHaveLength(1);
    expect(listed.suggestions[0]).toMatchObject({ scope: "bots", fromName: "Sage" });
    const applied = await body(call("POST", `/api/bots/chief/learning/suggestions/${offered.suggestion.id}/apply`, { expectedRevision: offered.suggestion.version, recipients: ["dax", "nova"] }));
    expect(applied).toMatchObject({ status: 200, shared: { copies: ["dax", "nova"], team: false } });
    const nova = (await body(call("GET", "/api/bots/nova/lessons"))).lessons;
    expect(nova).toHaveLength(1);
    expect(nova[0]).toMatchObject({ text: "Use emojis in client emails", origin: "suggested", sharedFrom: { id: "chief", name: "Sage" }, conflict: null });
    // dax has its own opposite lesson: its own wins, and the conflict shows on both rows
    const dax = await body(call("GET", "/api/bots/dax/lessons"));
    expect(dax.conflicts).toHaveLength(1);
    const own = dax.lessons.find((item: any) => item.text.startsWith("No emojis")), inherited = dax.lessons.find((item: any) => item.text.startsWith("Use emojis"));
    expect(own.conflict).toMatchObject({ role: "wins", text: "Use emojis in client emails", fromName: "Sage" });
    expect(inherited.conflict).toMatchObject({ role: "loses", text: "No emojis in client emails" });
    // Undo on the source reaches the recipients
    await body(call("DELETE", `/api/bots/chief/lessons/${lesson.id}`, { expectedRevision: lesson.version }));
    expect((await body(call("GET", "/api/bots/nova/lessons"))).lessons.filter((item: any) => item.state === "active")).toEqual([]);
  });

  it("a Chief of Staff's new lesson is offered on its own, always as a suggestion; another bot's is not", async () => {
    const before = (await body(call("GET", "/api/bots/chief/learning/suggestions"))).suggestions.length;
    const revision = (await body(call("GET", "/api/bots/chief/lessons"))).revision;
    await body(call("POST", "/api/bots/chief/lessons", { expectedRevision: revision, text: "Put the decision in the first line" }));
    const waiting = (await body(call("GET", "/api/bots/chief/learning/suggestions"))).suggestions;
    expect(waiting).toHaveLength(before + 1);
    expect(waiting.find((item: any) => item.text === "Put the decision in the first line")).toMatchObject({ state: "suggested", scope: "bots", fromName: "Sage" });
    expect((await body(call("GET", "/api/bots/nova/lessons"))).lessons.some((item: any) => item.text === "Put the decision in the first line")).toBe(false);
    await body(call("POST", "/api/bots/dax/lessons", { expectedRevision: (await body(call("GET", "/api/bots/dax/lessons"))).revision, text: "Reports go out on Fridays" }));
    expect((await body(call("GET", "/api/bots/dax/learning/suggestions"))).suggestions).toEqual([]);
  });

  it("refuses to share a lesson that stays with its bot", async () => {
    const added = await body(call("POST", "/api/bots/chief/lessons", { expectedRevision: (await body(call("GET", "/api/bots/chief/lessons"))).revision, text: "Sign off with the first name" }));
    database().prepare("UPDATE memory_lessons SET prospect_derived=1 WHERE id=?").run(added.lesson.id);
    const refused = await body(call("POST", `/api/bots/chief/lessons/${added.lesson.id}/share`, { expectedRevision: added.lesson.version, recipients: ["dax"] }));
    expect(refused).toMatchObject({ status: 422, code: "prospect-derived" });
  });
});
