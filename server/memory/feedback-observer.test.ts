// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The post-commit observer in message-db.ts, installed by wireBotLearning: an
// owner message written to a bot's thread reaches feedback detection after the
// transaction commits, and a failing observer never fails the write.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import * as messages from "../message-db.ts";
import { wireBotLearning } from "./learning-wiring.ts";
import { setFeedbackLessonFormer, setKeptMomentUndoHook, setLearningLocalLessonSink, setLessonAdmitter } from "./lessons.ts";
import { setMemoryMode } from "./repository.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); });
afterEach(() => { messages.setFeedbackObserver(null); setFeedbackLessonFormer(null); setKeptMomentUndoHook(null); setLessonAdmitter(null); setLearningLocalLessonSink(null); });

const bot = { id: "bot-a", name: "Sable", threadId: "th" };
const wire = () => wireBotLearning({
  dataDir: DATA_DIR, db: () => database(), bot: id => (id === "bot-a" ? bot : undefined), roster: () => ({ bots: [bot], groups: [] }),
  connection: () => ({ extractor: null }), readThread: (threadId, limit) => messages.readThreadNewest(threadId, limit)?.messages ?? [], activePath: threadId => messages.readThreadNewest(threadId, 5000)?.messages ?? [], defer: run => run(),
});
const settle = () => new Promise(resolve => setTimeout(resolve, 50));
const reply = { id: "b1", at: 1_000, role: "bot" as const, kind: "text" as const, text: "Here is the weekly summary.", parentId: null, turnId: "t1", turnTerminal: true };
const owner = (id: string, text: string, at: number) => ({ id, at, role: "user" as const, kind: "text" as const, text, parentId: "b1", origin: "desktop" as const });

it("detects feedback after the owner's message commits, and a bare complaint is recorded as recent feedback", async () => {
  wire();
  messages.appendMessage("th", reply);
  messages.appendMessage("th", owner("u1", "that sucks", 2_000));
  await settle();
  const row = database().prepare("SELECT bot_id,thread_id,message_id,polarity,strength,correction,state FROM memory_feedback").get();
  expect(row).toMatchObject({ bot_id: "bot-a", thread_id: "th", message_id: "u1", polarity: "-", correction: null, state: "detected" });
  expect(Number(row?.strength)).toBeGreaterThanOrEqual(2);
});

it("never lets a failing observer into the write path, and ignores bot lines", async () => {
  messages.setFeedbackObserver(() => { throw new Error("boom"); });
  expect(() => messages.appendMessage("th", reply)).not.toThrow();
  expect(() => messages.appendMessage("th", owner("u1", "that sucks", 2_000))).not.toThrow();
  expect(database().prepare("SELECT COUNT(*) c FROM messages WHERE thread_id='th'").get()?.c).toBe(2);
  let seen = 0;
  messages.setFeedbackObserver(() => { seen++; });
  messages.appendMessage("th", { ...reply, id: "b2" });
  messages.updateMessage("th", owner("u1", "that sucks really", 2_000));
  expect(seen).toBe(1);
});
