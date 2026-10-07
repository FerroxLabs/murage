// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where a prospect-derived lesson lives: learning-local/<bot>/lessons/<id>.json
// under the data folder, never in messages.db (design 11). That folder is
// excluded from backups, restore, bot packages and diagnostics, and B4's
// "forget this learning data" removes the bot's folder with it. Such a lesson
// is only ever a suggestion; applying one is the owner's decision (B7).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureLearningLocalDir, learningLocalPath } from "../bot-learning.ts";
import type { LearningLocalLessonSink, Lesson } from "./lessons.ts";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const segment = (value: string) => { if (!SEGMENT.test(value) || value.includes("..")) throw new Error("INVALID_LEARNING_LOCAL_NAME"); return value; };
const lessonsDir = (dataDir: string, botId: string) => join(learningLocalPath(dataDir, segment(botId)), "lessons");

/** The sink to register with setLearningLocalLessonSink. */
export function createLearningLocalLessonSink(dataDir: string): LearningLocalLessonSink {
  return (lesson: Lesson) => {
    ensureLearningLocalDir(dataDir);
    const dir = lessonsDir(dataDir, lesson.botId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${segment(lesson.id)}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...lesson, state: "suggested", prospectDerived: true }), { mode: 0o600 });
    renameSync(temporary, file);
  };
}

/** The bot's prospect-derived suggestions kept on this computer, oldest first. */
export function listLearningLocalLessons(dataDir: string, botId: string): Lesson[] {
  const dir = lessonsDir(dataDir, botId);
  if (!existsSync(dir)) return [];
  const out: Lesson[] = [];
  for (const name of readdirSync(dir).filter(file => file.endsWith(".json"))) {
    try { out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as Lesson); } catch { /* a damaged file is not a lesson */ }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
