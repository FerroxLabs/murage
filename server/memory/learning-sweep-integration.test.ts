// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owner-typed learning text (memory_feedback.correction, outcome reasons, a
// feedback lesson's evidence) is swept when its conversation is deleted, even
// when no memory source was ever captured for it, and when a source is forgotten.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import * as messages from "../message-db.ts";
import { setMemoryMode } from "./repository.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); });
const msg = (id: string, text: string, role: "user" | "bot" = "user") => ({ id, text, parentId: null, at: 1, role, kind: "text" as const });

function seedLearning(thread: string, messageId: string) {
  const db = database();
  db.prepare("INSERT INTO memory_feedback(id,bot_id,thread_id,message_id,polarity,strength,correction,state,scope,created_at) VALUES(?,?,?,?,'-',2,'send it to my private address','lesson','bot',1)").run(`fb-${thread}`, "bot", thread, messageId);
  db.prepare("INSERT INTO memory_outcomes(id,bot_id,thread_id,kind,reason,proposed_by,confirmed_by,source_event_key,created_at) VALUES(?,?,?,'won','closed after Dana called',?,?,?,1)").run(`o-${thread}`, "bot", thread, "owner", "owner", `mark:${messageId}`);
  db.prepare("INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,evidence,created_at) VALUES(?,1,'bot','bot','note','be brief','feedback','active',?,1)")
    .run(`l-${thread}`, JSON.stringify({ feedbackId: `fb-${thread}`, phrase: "wrong", messageId, action: null }));
  return db;
}

it("deleting a conversation sweeps the owner's typed feedback text, outcome reasons and the lesson resting on it", () => {
  messages.appendMessage("gone", msg("m1", "no, send it to my private address"));
  messages.appendMessage("kept", msg("m2", "a different conversation"));
  const db = seedLearning("gone", "m1");
  seedLearning("kept", "m2");
  messages.deleteThread("gone");
  expect(db.prepare("SELECT state,correction FROM memory_feedback WHERE id='fb-gone'").get()).toMatchObject({ state: "expired", correction: null });
  expect(db.prepare("SELECT reason FROM memory_outcomes WHERE id='o-gone'").get()?.reason).toBeNull();
  expect(db.prepare("SELECT state FROM memory_lessons WHERE id='l-gone'").get()?.state).toBe("unsupported");
  // another conversation's learning is untouched
  expect(db.prepare("SELECT correction FROM memory_feedback WHERE id='fb-kept'").get()?.correction).toContain("private address");
  expect(db.prepare("SELECT reason FROM memory_outcomes WHERE id='o-kept'").get()?.reason).toContain("Dana");
  expect(db.prepare("SELECT state FROM memory_lessons WHERE id='l-kept'").get()?.state).toBe("active");
});

it("does so even when memory was off and nothing from that conversation was captured", () => {
  setMemoryMode("off");
  messages.appendMessage("gone", msg("m1", "no, send it to my private address"));
  const db = seedLearning("gone", "m1");
  expect(db.prepare("SELECT 1 FROM memory_sources WHERE thread_id='gone'").get()).toBeUndefined();
  messages.deleteThread("gone");
  expect(db.prepare("SELECT correction FROM memory_feedback WHERE id='fb-gone'").get()?.correction).toBeNull();
  expect(db.prepare("SELECT reason FROM memory_outcomes WHERE id='o-gone'").get()?.reason).toBeNull();
});

// ── T1-16: forgetting is complete ─────────────────────────────────────────
import { existsSync, mkdirSync as mkdir, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forgetBotLearningData, sweepLearningRetention } from "./evolution-forgetting.ts";
import { learningLocalPath } from "../bot-learning.ts";

const ledger = (db: ReturnType<typeof database>, id: string, bot: string, kind: string, detail: Record<string, unknown>) => {
  db.exec("INSERT OR IGNORE INTO memory_scopes VALUES('sc-t1','conversation','sc-t1','[]',0)");
  db.prepare("INSERT INTO memory_learning_events(id,scope_id,kind,bot_id,detail,created_at) VALUES(?, 'sc-t1', ?, ?, ?, 1)").run(id, kind, bot, JSON.stringify(detail));
};

it("T1-16: deleting a conversation empties the text of lessons derived from it and the reply snippets in the ledger", () => {
  messages.appendMessage("gone", msg("m1", "no, lead with the 2-question reframe for Acme's CFO Jane"));
  messages.appendMessage("kept", msg("m2", "a different conversation"));
  const db = seedLearning("gone", "m1");
  db.prepare("UPDATE memory_lessons SET text='lead with the 2-question reframe for Acme CFO Jane' WHERE id='l-gone'").run();
  ledger(db, "ev-gone", "bot", "feedback-detected", { chip: 1, threadId: "gone", replyMessageId: "r1", label: "Dear Jane, about the Acme renewal" });
  ledger(db, "ev-kept", "bot", "feedback-detected", { chip: 1, threadId: "kept", replyMessageId: "r2", label: "A reply in another chat" });
  messages.deleteThread("gone");
  expect(db.prepare("SELECT state,text FROM memory_lessons WHERE id='l-gone'").get()).toMatchObject({ state: "unsupported", text: "" });
  expect(JSON.stringify(db.prepare("SELECT detail FROM memory_learning_events WHERE id='ev-gone'").get())).not.toContain("Acme");
  expect(JSON.stringify(db.prepare("SELECT detail FROM memory_learning_events WHERE id='ev-kept'").get())).toContain("another chat");
});

it("T1-16: deleting a conversation removes learning-local lessons that rested on it", () => {
  messages.appendMessage("gone", msg("m1", "no, send it to Jane"));
  const dir = join(learningLocalPath(DATA_DIR, "bot"), "lessons");
  mkdir(dir, { recursive: true });
  writeFileSync(join(dir, "pl1.json"), JSON.stringify({ id: "pl1", botId: "bot", text: "call Jane first", evidence: { feedbackId: "f", messageId: "m1" } }));
  writeFileSync(join(dir, "pl2.json"), JSON.stringify({ id: "pl2", botId: "bot", text: "unrelated", evidence: { feedbackId: "f", messageId: "other" } }));
  seedLearning("gone", "m1");
  messages.deleteThread("gone");
  expect(existsSync(join(dir, "pl1.json"))).toBe(false);
  expect(readFileSync(join(dir, "pl2.json"), "utf8")).toContain("unrelated");
});

it("T1-16: Forget this learning data removes the bot's rows, ledger rows and learning-local folder; another bot is untouched", () => {
  const db = seedLearning("a", "m1");
  ledger(db, "ev-a", "bot", "lesson-learned", { threadId: "a", label: "snippet of a reply" });
  ledger(db, "ev-b", "other-bot", "lesson-learned", { threadId: "b", label: "other bot snippet" });
  const dir = learningLocalPath(DATA_DIR, "bot", "lessons");
  mkdir(dir, { recursive: true }); writeFileSync(join(dir, "x.json"), "{}");
  const result = forgetBotLearningData(db, DATA_DIR, "bot");
  expect(result.localRemoved).toBe(true);
  expect(db.prepare("SELECT COUNT(*) c FROM memory_lessons WHERE bot_id='bot'").get()?.c).toBe(0);
  expect(db.prepare("SELECT COUNT(*) c FROM memory_feedback WHERE bot_id='bot'").get()?.c).toBe(0);
  expect(db.prepare("SELECT COUNT(*) c FROM memory_learning_events WHERE bot_id='bot'").get()?.c).toBe(0);
  expect(db.prepare("SELECT COUNT(*) c FROM memory_learning_events WHERE bot_id='other-bot'").get()?.c).toBe(1);
  expect(existsSync(learningLocalPath(DATA_DIR, "bot"))).toBe(false);
});

it("T1-16: the route and the retention sweep exist in production wiring", async () => {
  await import("../bot-learning-modules.ts");
  const { learningRouteHandler } = await import("../bot-learning-routes.ts");
  expect(learningRouteHandler("data.forget")).toBeTypeOf("function");
  const db = seedLearning("a", "m1");
  db.prepare("UPDATE memory_lessons SET state='undone',text='old words' WHERE id='l-a'").run();
  expect(sweepLearningRetention(db, { now: Date.now() + 200 * 86_400_000, dataDir: DATA_DIR }).lessonTexts).toBe(1);
  const answer = await learningRouteHandler("data.forget")!({ botId: "bot", method: "DELETE", url: new URL("http://x/api/bots/bot/learning/data"), body: {}, expectedRevision: 0, idempotencyKey: "k1" });
  expect(answer.status).toBe(200);
  expect(db.prepare("SELECT COUNT(*) c FROM memory_lessons WHERE bot_id='bot'").get()?.c).toBe(0);
});
