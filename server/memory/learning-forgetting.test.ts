// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { captureSource } from "./capture.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { pauseRestoredMemory } from "./restore.ts";
import { forgetBotLearningData, purgeForgottenLearning, sweepLearningRetention } from "./evolution-forgetting.ts";
import { ensureLearningLocalDir, learningLocalPath } from "../bot-learning.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster({ bots: [{ id: "bot", threadId: "thread" }], groups: [] }); });
const DAY = 86_400_000;
function seed() {
  transaction(db => { for (const id of ["a", "b"]) captureSource(db, { id, threadId: "thread", messageId: `m-${id}`, kind: "text", speaker: "owner", outcome: "recorded", text: `words ${id}` }); });
  const db = database();
  const lesson = (id: string, state: string, source: string) => db.prepare("INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,evidence,created_at) VALUES(?,1,'bot','bot','note','be brief','feedback',?,?,1)").run(id, state, JSON.stringify([{ kind: "source", id: source, revision: 1 }]));
  lesson("applied", "active", "a"); lesson("pending", "suggested", "a"); lesson("other", "active", "b");
  db.prepare("INSERT INTO memory_feedback(id,bot_id,thread_id,message_id,polarity,strength,correction,state,scope,created_at) VALUES('fa','bot','thread','m-a','-',2,'too long','lesson','bot',1),('fb','bot','thread','m-b','-',2,'too short','lesson','bot',1)").run();
  db.prepare("INSERT INTO memory_episodes(id,bot_id,thread_id,start_message_id,end_message_id,classification,eligible) VALUES('ea','bot','thread','m-a','m-a','owner',1),('eb','bot','thread','m-b','m-b','owner',1)").run();
  db.prepare("INSERT INTO memory_learning_runs(id,bot_id,state,corpus_digest,created_at) VALUES('run','bot','queued','d',1)").run();
  return db;
}

it("forgetting a source removes the learning derived from it, and only that", () => {
  const db = seed();
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "a" });
  const state = (id: string) => db.prepare("SELECT state,text FROM memory_lessons WHERE id=?").get(id)!;
  expect(state("applied")).toMatchObject({ state: "unsupported", text: "" });
  expect(state("pending")).toMatchObject({ state: "stale", text: "" });
  expect(state("other")).toMatchObject({ state: "active" });
  expect(db.prepare("SELECT state,correction FROM memory_feedback WHERE id='fa'").get()).toMatchObject({ state: "expired", correction: null });
  expect(db.prepare("SELECT state,correction FROM memory_feedback WHERE id='fb'").get()).toMatchObject({ state: "lesson", correction: "too short" });
  expect(db.prepare("SELECT eligible,excluded_at IS NOT NULL AS x FROM memory_episodes WHERE id='ea'").get()).toMatchObject({ eligible: 0, x: 1 });
  expect(db.prepare("SELECT eligible FROM memory_episodes WHERE id='eb'").get()).toMatchObject({ eligible: 1 });
  expect(db.prepare("SELECT state,reason,corpus_digest FROM memory_learning_runs WHERE id='run'").get()).toMatchObject({ state: "cancelled", reason: "MEMORY_EVIDENCE_FORGOTTEN", corpus_digest: null });
  expect(purgeForgottenLearning(db)).toEqual({ lessons: 0, feedback: 0, episodes: 0, runs: 0 });
});

it("restore re-applies forgetting to learning rows restored from an older copy", () => {
  const db = seed();
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "a" });
  db.prepare("UPDATE memory_lessons SET state='retired' WHERE id IN ('applied','other')").run();
  db.prepare("INSERT INTO memory_learning_events(id,scope_id,kind,bot_id,created_at) VALUES('ev',(SELECT id FROM memory_scopes LIMIT 1),'lesson-learned','bot',1)").run();
  db.prepare("UPDATE memory_lessons SET state='active',text='be brief',learning_event_id='ev',evidence='[{\"kind\":\"source\",\"id\":\"a\",\"revision\":1}]' WHERE id='pending'").run();
  db.prepare("UPDATE memory_feedback SET state='lesson',correction='too long' WHERE id='fa'").run();
  expect(pauseRestoredMemory(db)).toBe(true);
  expect(db.prepare("SELECT state,text FROM memory_lessons WHERE id='pending'").get()).toMatchObject({ state: "unsupported" });
  expect(db.prepare("SELECT correction FROM memory_feedback WHERE id='fa'").get()).toMatchObject({ correction: null });
});

it("an excluded thread makes its feedback and episodes stop counting", () => {
  const db = seed();
  db.exec(`INSERT INTO memory_scope_bindings VALUES('memory-owner-settings',(SELECT id FROM memory_scopes LIMIT 1),'system','owner-settings',1,'granted','{"excludedThreadIds":["thread"]}')`);
  const r = purgeForgottenLearning(db);
  expect(r.episodes).toBe(2);
  expect(r.feedback).toBe(2);
});

it("Forget this learning data purges one bot's rows and its learning-local folder, nothing else", () => {
  const db = seed();
  db.prepare("INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,created_at) VALUES('x',1,'other-bot','bot','note','keep','typed','active',1)").run();
  const dir = ensureLearningLocalDir(DATA_DIR); mkdirSync(learningLocalPath(DATA_DIR, "bot"), { recursive: true }); mkdirSync(learningLocalPath(DATA_DIR, "other-bot"), { recursive: true });
  writeFileSync(learningLocalPath(DATA_DIR, "bot", "g.json"), "{}"); writeFileSync(learningLocalPath(DATA_DIR, "other-bot", "g.json"), "{}");
  const r = forgetBotLearningData(db, DATA_DIR, "bot");
  expect(r.localRemoved).toBe(true);
  expect(existsSync(learningLocalPath(DATA_DIR, "bot"))).toBe(false);
  expect(existsSync(learningLocalPath(DATA_DIR, "other-bot", "g.json"))).toBe(true);
  expect(db.prepare("SELECT count(*) AS n FROM memory_lessons WHERE bot_id='bot'").get()!.n).toBe(0);
  expect(db.prepare("SELECT count(*) AS n FROM memory_lessons WHERE bot_id='other-bot'").get()!.n).toBe(1);
  expect(() => forgetBotLearningData(db, DATA_DIR, "../escape")).toThrow("INVALID_BOT_ID");
  expect(existsSync(dir)).toBe(true);
});

it("retention sweeps follow design 11 and leave applied lessons and fresh rows alone", () => {
  const db = database(), now = 400 * DAY;
  db.prepare("INSERT INTO memory_outcomes(id,bot_id,kind,proposed_by,confirmed_by,created_at) VALUES('old','b','won','bot',NULL,?),('fresh','b','won','bot',NULL,?),('mine','b','won','owner','owner',?),('owner-old','b','won','owner',NULL,?)").run(now - 31 * DAY, now - 29 * DAY, now - 300 * DAY, now - 300 * DAY);
  const ls = (id: string, state: string, at: number) => db.prepare("INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,created_at,decided_at) VALUES(?,1,'b','bot','note','secret words','feedback',?,?,?)").run(id, state, at, at);
  ls("undone-old", "undone", now - 91 * DAY); ls("stale-new", "stale", now - 10 * DAY); ls("active-old", "active", now - 300 * DAY); ls("sug-old", "suggested", now - 300 * DAY);
  db.prepare("INSERT INTO memory_learning_runs(id,bot_id,state,created_at,finished_at) VALUES('r-old','b','done',1,?),('r-new','b','done',1,?)").run(now - 366 * DAY, now - 100 * DAY);
  ensureLearningLocalDir(DATA_DIR); mkdirSync(learningLocalPath(DATA_DIR, "b", "corpus-1"), { recursive: true }); mkdirSync(learningLocalPath(DATA_DIR, "b", "corpus-2"), { recursive: true });
  const old = new Date(now - 2 * DAY); utimesSync(learningLocalPath(DATA_DIR, "b", "corpus-1"), old, old);
  const r = sweepLearningRetention(db, { now, dataDir: DATA_DIR });
  expect(db.prepare("SELECT id FROM memory_outcomes ORDER BY id").all().map(x => x.id)).toEqual(["fresh", "mine", "owner-old"]);
  const text = (id: string) => db.prepare("SELECT text FROM memory_lessons WHERE id=?").get(id)!.text;
  expect([text("undone-old"), text("stale-new"), text("active-old"), text("sug-old")]).toEqual(["", "secret words", "secret words", "secret words"]);
  expect(db.prepare("SELECT id FROM memory_learning_runs").all().map(x => x.id)).toEqual(["r-new"]);
  expect(existsSync(learningLocalPath(DATA_DIR, "b", "corpus-1"))).toBe(false);
  expect(existsSync(learningLocalPath(DATA_DIR, "b", "corpus-2"))).toBe(true);
  expect(r).toMatchObject({ outcomes: 1, lessonTexts: 1, runs: 1, corpora: 1 });
});
