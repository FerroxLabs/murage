// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Forget reaches the copies (bot-learning batch B11, design 14: lineage).
import { beforeEach, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { captureSource } from "./capture.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { forgetBotLearningData } from "./evolution-forgetting.ts";
import { applyLessonShare, setLessonRoster, suggestLessonShare } from "./lesson-sharing.ts";
import { addLesson, renderLearnedBlock } from "./lessons.ts";
import { DEFAULT_BOT_LEARNING } from "../bot-learning.ts";

beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster({ bots: [{ id: "chief", threadId: "thread" }, { id: "dax", threadId: "thread-dax" }], groups: [] });
  setLessonRoster(() => [{ id: "chief", chiefOfStaff: true }, { id: "dax" }]);
});

function shared(evidenceSource: string | null) {
  transaction(db => { captureSource(db, { id: "src", threadId: "thread", messageId: "m-src", kind: "text", speaker: "owner", outcome: "recorded", text: "put the decision first" }); });
  const db = database();
  const added = addLesson(db, { botId: "chief", text: "Lead with the decision", origin: "typed", learning: DEFAULT_BOT_LEARNING, evidence: evidenceSource ? [{ kind: "source", id: evidenceSource }] : undefined });
  if (added.status !== "applied") throw new Error(added.status);
  const share = suggestLessonShare(db, { botId: "chief", lessonId: added.lesson.id, recipients: ["dax"] });
  const copy = applyLessonShare(db, { botId: "chief", lessonId: share.id }).copies[0]!;
  return { db, source: added.lesson, copy };
}
const row = (db: ReturnType<typeof database>, id: string) => db.prepare("SELECT state,text FROM memory_lessons WHERE id=? ORDER BY version DESC LIMIT 1").get(id) as any;

it("forgetting the source's evidence removes the copy and erases its words", () => {
  const { db, source, copy } = shared("src");
  expect(renderLearnedBlock(db, { botId: "dax", threadId: "t", ownerAudience: true, turnsSince: () => 0 }).text).toContain("Lead with the decision");
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "src" });
  expect(row(db, source.id).state).toBe("unsupported");
  expect(row(db, copy.id)).toMatchObject({ state: "stale", text: "" });
  expect(renderLearnedBlock(db, { botId: "dax", threadId: "t", ownerAudience: true, turnsSince: () => 0 }).text).toBe("");
});

it("a source with different evidence leaves the copy alone", () => {
  const { db, copy } = shared(null);
  transaction(d => { captureSource(d, { id: "other", threadId: "thread", messageId: "m-other", kind: "text", speaker: "owner", outcome: "recorded", text: "unrelated" }); });
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "other" });
  expect(row(db, copy.id).state).toBe("active");
});

it("Forget this learning data on the source bot removes the copies it handed out, and leaves the recipient's own lessons", () => {
  const { db, copy } = shared(null);
  const own = addLesson(db, { botId: "dax", text: "Keep it under 100 words", origin: "typed", learning: DEFAULT_BOT_LEARNING });
  if (own.status !== "applied") throw new Error(own.status);
  forgetBotLearningData(db, DATA_DIR, "chief");
  expect(row(db, copy.id)).toMatchObject({ state: "stale", text: "" });
  expect(row(db, own.lesson.id).state).toBe("active");
  expect(db.prepare("SELECT COUNT(*) c FROM memory_lessons WHERE bot_id='chief'").get()).toMatchObject({ c: 0 });
});
