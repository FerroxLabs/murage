// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Prospect-derived lessons: kept under learning-local/, owner-only files,
// never in messages.db.
import { mkdtempSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DEFAULT_BOT_LEARNING } from "../bot-learning.ts";
import { addLesson, listLessons, setLearningLocalLessonSink, setLessonAdmitter } from "./lessons.ts";
import { createLearningLocalLessonSink, listLearningLocalLessons } from "./lessons-local.ts";
import { migrateMemorySchema } from "./schema.ts";

let db: DatabaseSync;
beforeEach(() => { db = new DatabaseSync(":memory:"); migrateMemorySchema(db); });
afterEach(() => { db.close(); setLearningLocalLessonSink(null); setLessonAdmitter(null); });

it("writes a prospect-derived suggestion under learning-local/<bot>/lessons and nowhere in the database", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "lessons-local-"));
  setLearningLocalLessonSink(createLearningLocalLessonSink(dataDir));
  setLessonAdmitter((_bot, candidate) => ({ ok: true, text: candidate, prospectDerived: true, destination: "learning-local", mustSuggest: true }));
  const result = addLesson(db, { botId: "dax", text: "Customers want a price in the first line", origin: "feedback", learning: DEFAULT_BOT_LEARNING, evidence: [{ kind: "source", id: "s1" }] });
  expect(result).toMatchObject({ status: "suggested", lesson: { prospectDerived: true, state: "suggested" } });
  expect(db.prepare("SELECT COUNT(*) c FROM memory_lessons").get()?.c).toBe(0);
  expect(db.prepare("SELECT COUNT(*) c FROM memory_learning_events").get()?.c).toBe(0);
  expect(listLessons(db, "dax")).toEqual([]);
  const kept = listLearningLocalLessons(dataDir, "dax");
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatchObject({ text: "Customers want a price in the first line", prospectDerived: true, evidence: [{ kind: "source", id: "s1" }] });
  const file = join(dataDir, "learning-local", "dax", "lessons", readdirSync(join(dataDir, "learning-local", "dax", "lessons"))[0]!);
  expect(statSync(file).mode & 0o077).toBe(0);
  expect(statSync(join(dataDir, "learning-local")).mode & 0o077).toBe(0);
  expect(listLearningLocalLessons(dataDir, "nobody")).toEqual([]);
});

it("refuses a bot id that could leave the folder", () => {
  const sink = createLearningLocalLessonSink(mkdtempSync(join(tmpdir(), "lessons-local-")));
  expect(() => sink({ id: "l1", version: 1, botId: "../escape", scope: "bot", kind: "note", spec: null, where: null, threadId: null, sourceMessageId: null, targetMessageId: null, text: "x", origin: "feedback", state: "suggested", evidence: [], prospectDerived: true, learningEventId: null, createdAt: 1, decidedAt: null, parentId: null, recipients: null })).toThrow(/INVALID/);
});
