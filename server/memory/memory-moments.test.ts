// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory moment delivery (bot-learning batch B5m): the "will remember that"
// chip. What the memory worker activates becomes a stamped, chip-ready ledger
// row and one live event; the chip list reads the same rows; Forget is the
// existing undo; the month counts and the badge count come from the ledger.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEMPLATE_COUNTS } from "../../shared/learned-chip.ts";
import { initializeMessageTables } from "../message-tables.ts";
import { changeLearningEvent } from "./learning-history.ts";
import { recordLearningEvent } from "./learning-ledger.ts";
import { addLesson, chipItemsForThread, recordKeptMoment, setLessonAdmitter } from "./lessons.ts";
import { REMEMBERED_REPLY_WAIT_MS, learningCounts, newLearningSince, rememberedMomentsAwaitingReply, rememberedMomentsForJob, threadAwaitsRememberedChip } from "./memory-moments.ts";
import { DEFAULT_BOT_LEARNING } from "../bot-learning.ts";
import { migrateMemorySchema } from "./schema.ts";

let db: DatabaseSync;
const T0 = 1_700_000_000_000;

function message(id: string, role: string, at: number, text = "x", kind = "text") {
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('th',?,?,?,?,?,'{}')").run(id, at, role, kind, text);
}
function jobFor(jobId: string, sourceId: string) {
  db.prepare("INSERT INTO memory_source_versions VALUES(?,1,'h','{}',1)").run(sourceId);
  db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,policy_revision,deletion_epoch) VALUES(?,?,1,'consolidate','1','complete',0,0)").run(jobId, sourceId);
}
/** A source, the job that completed it, one candidate turned active, and its activation event. */
function activation(input: { n: number; text: string; messageId: string; botId?: string | null; now?: number; recordState?: string; source?: string }) {
  const sourceId = input.source ?? `src${input.n}`;
  if (!db.prepare("SELECT 1 FROM memory_scopes WHERE id='sc'").get()) db.exec("INSERT INTO memory_scopes VALUES('sc','conversation','th','[]',0)");
  if (!db.prepare("SELECT 1 FROM memory_sources WHERE id=?").get(sourceId)) {
    db.prepare("INSERT INTO memory_sources VALUES(?,'sc','th',?,NULL,1,'h','text','owner','recorded',NULL,'active')").run(sourceId, input.messageId);
    jobFor(`job${input.n}`, sourceId);
  }
  db.prepare("INSERT INTO memory_records VALUES(?,1,'sc','fact',?,'owner-statement',?,0,1,NULL,NULL,1)").run(`rec${input.n}`, input.text, input.recordState ?? "active");
  return recordLearningEvent(db, { kind: "activated", scopeId: "sc", recordId: `rec${input.n}`, recordVersion: 1, sourceId, sourceRevision: 1, botId: input.botId === undefined ? "ember" : input.botId, now: input.now ?? T0 });
}
const row = (id: string) => db.prepare("SELECT * FROM memory_learning_events WHERE id=?").get(id) as any;

beforeEach(() => {
  db = new DatabaseSync(":memory:"); migrateMemorySchema(db); initializeMessageTables(db); setLessonAdmitter(null);
  message("u1", "user", 1, "My board meets on the first Tuesday"); message("b1", "bot", 2, "Noted. I will plan around that.");
});
afterEach(() => db.close());

describe("rememberedMomentsForJob", () => {
  it("returns the activated entry with bot, thread, source message, event id and text, under the bot's reply", () => {
    const id = activation({ n: 1, text: "The board meets on the first Tuesday", messageId: "u1" });
    const moments = rememberedMomentsForJob(db, "job1", T0 - 1);
    expect(moments).toEqual([{ eventId: id, botId: "ember", threadId: "th", sourceMessageId: "u1", replyMessageId: "b1", text: "The board meets on the first Tuesday", template: expect.any(Number), recordId: "rec1", recordVersion: 1 }]);
    expect(moments[0]!.template).toBeGreaterThanOrEqual(1);
    expect(moments[0]!.template).toBeLessThanOrEqual(TEMPLATE_COUNTS.remembered);
  });
  it("stamps the ledger row, so the chip list can find it, and emits each event once", () => {
    const id = activation({ n: 1, text: "Fact", messageId: "u1" });
    rememberedMomentsForJob(db, "job1", T0 - 1);
    expect(JSON.parse(row(id).detail)).toMatchObject({ chip: 1, group: "remembered", threadId: "th", replyMessageId: "b1", sourceMessageId: "u1" });
    expect(rememberedMomentsForJob(db, "job1", T0 - 1)).toEqual([]);
  });
  it("shows a chip only when a memory was really stored", () => {
    activation({ n: 1, text: "Candidate only", messageId: "u1", recordState: "candidate" });
    activation({ n: 2, text: "Archived", messageId: "u1", recordState: "archived", source: "src1" });
    expect(rememberedMomentsForJob(db, "job1", T0 - 1)).toEqual([]);
    // no event at all (a held candidate), no moment
    db.prepare("INSERT INTO memory_sources VALUES('held','sc','th','u1',NULL,1,'h','text','owner','recorded',NULL,'active')").run();
    jobFor("jobheld", "held");
    expect(rememberedMomentsForJob(db, "jobheld", T0 - 1)).toEqual([]);
  });
  it("skips events from before this run, events with no bot, and ones already undone", () => {
    activation({ n: 1, text: "Old", messageId: "u1", now: T0 - 5000 });
    expect(rememberedMomentsForJob(db, "job1", T0)).toEqual([]);
    activation({ n: 2, text: "No bot", messageId: "u1", botId: null });
    expect(rememberedMomentsForJob(db, "job2", T0 - 1)).toEqual([]);
    const undone = activation({ n: 3, text: "Undone", messageId: "u1" });
    db.prepare("UPDATE memory_learning_events SET undone_at=? WHERE id=?").run(T0 + 1, undone);
    expect(rememberedMomentsForJob(db, "job3", T0 - 1)).toEqual([]);
  });
  it("attaches to the source message itself when it is the bot's own reply, and to the next bot reply after an owner message", () => {
    message("b0", "bot", 0, "Earlier");
    const own = activation({ n: 1, text: "From a reply", messageId: "b1" });
    expect(rememberedMomentsForJob(db, "job1", T0 - 1)[0]).toMatchObject({ eventId: own, replyMessageId: "b1" });
    // Four more replies in between, so a second chip is allowed here (at most one per 5 replies).
    for (let n = 1; n <= 4; n += 1) message(`f${n}`, "bot", 2 + n, `Filler ${n}`);
    message("u2", "user", 10, "Another"); message("a1", "bot", 11, "tool", "activity"); message("b2", "bot", 12, "Reply two");
    activation({ n: 2, text: "Skips tool rows", messageId: "u2" });
    expect(rememberedMomentsForJob(db, "job2", T0 - 1)[0]).toMatchObject({ replyMessageId: "b2" });
  });
  it("with no bot reply anywhere yet there is nowhere to put the chip: nothing is emitted or stamped", () => {
    db.exec("DELETE FROM messages WHERE id='b1'");
    const id = activation({ n: 1, text: "No reply yet", messageId: "u1" });
    expect(rememberedMomentsForJob(db, "job1", T0 - 1)).toEqual([]);
    expect(JSON.parse(row(id).detail).chip).toBeUndefined();
  });
  it("never repeats the previous template for the same bot", () => {
    const seen: number[] = [];
    for (let n = 1; n <= 12; n += 1) { activation({ n, text: `Fact ${n}`, messageId: "u1", now: T0 + n }); seen.push(rememberedMomentsForJob(db, `job${n}`, T0)[0]!.template); }
    seen.slice(1).forEach((value, index) => expect(value).not.toBe(seen[index]));
  });
});

describe("Remembered chips never nag (at most one per 5 bot replies per thread)", () => {
  /** Owner message uN then bot reply bN, for N = 2..9 (u1/b1 exist already). */
  const turns = () => { for (let n = 2; n <= 9; n += 1) { message(`u${n}`, "user", n * 10, `Owner ${n}`); message(`b${n}`, "bot", n * 10 + 1, `Reply ${n}`); } };
  it("folds a memory that lands within 4 replies of the last chip into the count: no chip, no frame", () => {
    turns();
    const first = activation({ n: 1, text: "Board meets monthly", messageId: "u1" });
    expect(rememberedMomentsForJob(db, "job1", T0 - 1).map(m => m.eventId)).toEqual([first]);
    const near = activation({ n: 2, text: "Q4 deadline is Nov 15", messageId: "u5" }); // reply b5: four replies after b1
    expect(rememberedMomentsForJob(db, "job2", T0 - 1)).toEqual([]);
    expect(chipItemsForThread(db, { botId: "ember", threadId: "th", now: T0 }).map(item => item.eventId)).toEqual([first]);
    // delivered once and never retried: asking again still gives nothing
    expect(rememberedMomentsForJob(db, "job2", T0 - 1)).toEqual([]);
    // the Learning screen still counts it
    expect(learningCounts(db, { botId: "ember", now: T0 }).memories).toBe(2);
    expect(JSON.parse(row(near).detail).chip).toBe(0);
  });
  it("allows the next chip once five replies have passed, and a chip on the same reply merges", () => {
    turns();
    activation({ n: 1, text: "A", messageId: "u1" }); rememberedMomentsForJob(db, "job1", T0 - 1);
    const sameReply = activation({ n: 2, text: "B", messageId: "u1", source: "src1" });
    expect(rememberedMomentsForJob(db, "job1", T0 - 1).map(m => m.eventId)).toEqual([sameReply]);
    const later = activation({ n: 3, text: "C", messageId: "u6" }); // reply b6: five replies after b1
    expect(rememberedMomentsForJob(db, "job3", T0 - 1).map(m => m.eventId)).toEqual([later]);
    activation({ n: 4, text: "D", messageId: "u8" }); // b8 is two after b6
    expect(rememberedMomentsForJob(db, "job4", T0 - 1)).toEqual([]);
  });
  it("is per thread: another conversation of the same bot has its own allowance", () => {
    turns();
    activation({ n: 1, text: "A", messageId: "u1" }); rememberedMomentsForJob(db, "job1", T0 - 1);
    db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('other','ou',1,'user','text','x','{}')").run();
    db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('other','ob',2,'bot','text','y','{}')").run();
    db.exec("INSERT INTO memory_scopes VALUES('sc2','conversation','other','[]',0)");
    db.prepare("INSERT INTO memory_sources VALUES('osrc','sc2','other','ou',NULL,1,'h','text','owner','recorded',NULL,'active')").run();
    jobFor("ojob", "osrc");
    db.prepare("INSERT INTO memory_records VALUES('orec',1,'sc2','fact','Other thread fact','owner-statement','active',0,1,NULL,NULL,1)").run();
    recordLearningEvent(db, { kind: "activated", scopeId: "sc2", recordId: "orec", recordVersion: 1, sourceId: "osrc", sourceRevision: 1, botId: "ember", now: T0 + 1 });
    expect(rememberedMomentsForJob(db, "ojob", T0 - 1)).toHaveLength(1);
  });
});

describe("the chip list", () => {
  it("includes a remembered item with the entry text, Forget and no Undo or Edit", () => {
    const id = activation({ n: 1, text: "The board meets on the first Tuesday", messageId: "u1" });
    rememberedMomentsForJob(db, "job1", T0 - 1);
    const items = chipItemsForThread(db, { botId: "ember", threadId: "th", now: T0 });
    expect(items).toEqual([expect.objectContaining({ eventId: id, kind: "remembered", group: "remembered", text: "The board meets on the first Tuesday", state: "active", replyMessageId: "b1",
      actions: { edit: true, undo: false, forget: true, notQuite: false, notExample: false, restorable: false }, recordId: "rec1", recordVersion: 1 })]);
  });
  it("Forget also stops the owner's own source line from coming back into future turns (the extracted fact was not the only copy)", () => {
    const id = activation({ n: 1, text: "Favourite colour is teal", messageId: "u1" });
    db.prepare("INSERT INTO memory_records VALUES('chunk1',1,'sc','source','My favourite colour is teal.','owner-statement','active',0,1,NULL,NULL,1)").run();
    db.prepare("INSERT INTO memory_evidence VALUES('chunk1',1,'src1',1,0,5)").run();
    db.prepare("INSERT INTO memory_projection_receipts(record_id,record_version,index_generation,lexical_status,embedding_status) VALUES('chunk1',1,1,'ready','ready')").run();
    // a source line that belongs to a different message stays
    db.exec("INSERT INTO memory_sources VALUES('other','sc','th','u7',NULL,1,'h','text','owner','recorded',NULL,'active')");
    db.prepare("INSERT INTO memory_source_versions VALUES('other',1,'h','{}',1)").run();
    db.prepare("INSERT INTO memory_records VALUES('chunk2',1,'sc','source','Something else entirely','owner-statement','active',0,1,NULL,NULL,1)").run();
    db.prepare("INSERT INTO memory_evidence VALUES('chunk2',1,'other',1,0,5)").run();
    changeLearningEvent(db, id, "undo", T0 + 10);
    expect(db.prepare("SELECT state FROM memory_records WHERE id='chunk1'").get()).toEqual({ state: "archived" });
    expect(db.prepare("SELECT lexical_status s FROM memory_projection_receipts WHERE record_id='chunk1'").get()?.s).toBe("pending-archive");
    expect(db.prepare("SELECT state FROM memory_records WHERE id='chunk2'").get()).toEqual({ state: "active" });
  });
  it("is not listed before it is stamped (nothing delivered, no chip)", () => {
    activation({ n: 1, text: "Fact", messageId: "u1" });
    expect(chipItemsForThread(db, { botId: "ember", threadId: "th", now: T0 })).toEqual([]);
  });
  it("Forget is the existing undo: the entry is archived, the chip is gone, and it cannot be brought back by Keep", () => {
    const id = activation({ n: 1, text: "Fact", messageId: "u1" });
    rememberedMomentsForJob(db, "job1", T0 - 1);
    expect(changeLearningEvent(db, id, "undo", T0 + 10)).toMatchObject({ ok: true, undone: true });
    expect(db.prepare("SELECT state FROM memory_records WHERE id='rec1'").get()).toEqual({ state: "archived" });
    expect(chipItemsForThread(db, { botId: "ember", threadId: "th", now: T0 + 20 })).toEqual([]);
    expect(() => changeLearningEvent(db, id, "keep")).toThrow();
  });
  it("lessons, kept moments and memory merge under one reply, in the order stored", () => {
    activation({ n: 1, text: "Fact", messageId: "u1" });
    rememberedMomentsForJob(db, "job1", T0 - 1);
    const lesson = addLesson(db, { botId: "ember", spec: { kind: "lead-with", value: "decision" }, where: "everywhere", auto: true, origin: "feedback", learning: DEFAULT_BOT_LEARNING, chip: { threadId: "th", replyMessageId: "b1" }, now: T0 + 1 });
    expect(lesson.status).toBe("applied");
    const items = chipItemsForThread(db, { botId: "ember", threadId: "th", now: T0 + 2 });
    expect(items.map(item => item.kind)).toEqual(["remembered", "lesson"]);
    expect(new Set(items.map(item => item.replyMessageId))).toEqual(new Set(["b1"]));
  });
});

describe("extraction that finishes before the reply is stored", () => {
  beforeEach(() => { message("u9", "user", 100, "My flight lands at nine"); });
  it("waits for the reply, then attaches the chip once, under that reply", () => {
    const id = activation({ n: 1, text: "Flight lands at nine", messageId: "u9" });
    expect(rememberedMomentsForJob(db, "job1", T0 - 1)).toEqual([]);
    expect(JSON.parse(row(id).detail).chip ?? null).toBeNull(); // not given up on
    expect(threadAwaitsRememberedChip("th")).toBe(true);
    expect(rememberedMomentsAwaitingReply(db, "th")).toEqual([]); // still no reply
    message("b9", "bot", 101, "Got it, I will plan around a nine o'clock landing.");
    const moments = rememberedMomentsAwaitingReply(db, "th");
    expect(moments).toMatchObject([{ eventId: id, sourceMessageId: "u9", replyMessageId: "b9", text: "Flight lands at nine" }]);
    expect(JSON.parse(row(id).detail)).toMatchObject({ chip: 1, replyMessageId: "b9" });
    expect(rememberedMomentsAwaitingReply(db, "th")).toEqual([]);
    expect(threadAwaitsRememberedChip("th")).toBe(false);
  });
  it("the wait is bounded: a reply that never lands within it gets no chip, and nothing is left waiting", () => {
    const id = activation({ n: 1, text: "Flight lands at nine", messageId: "u9" });
    rememberedMomentsForJob(db, "job1", T0 - 1);
    message("b9", "bot", 101, "Got it.");
    expect(rememberedMomentsAwaitingReply(db, "th", Date.now() + REMEMBERED_REPLY_WAIT_MS + 1)).toEqual([]);
    expect(threadAwaitsRememberedChip("th")).toBe(false);
    expect(JSON.parse(row(id).detail).chip ?? null).toBeNull();
  });
});

describe("month counts and the badge", () => {
  it("a kept praise moment counts as learned, so the screen moves when the chip shows", () => {
    const MONTH = new Date(2026, 9, 15, 12).getTime();
    recordKeptMoment(db, { botId: "ember", threadId: "th", replyMessageId: "b1", label: "Noted", variant: "praise", exemplarKey: "feedback:f1", now: MONTH });
    expect(learningCounts(db, { botId: "ember", now: MONTH }).lessons).toBe(1);
  });
  const MONTH = new Date(2026, 9, 15, 12).getTime(); // 15 Oct 2026, local
  const LAST_MONTH = new Date(2026, 8, 20, 12).getTime();
  it("counts what was learned and remembered this month, not last month, and not another bot", () => {
    activation({ n: 1, text: "A", messageId: "u1", now: MONTH });
    activation({ n: 2, text: "B", messageId: "u1", now: MONTH + 1, source: "src1" });
    activation({ n: 3, text: "Last month", messageId: "u1", now: LAST_MONTH, source: "src1" });
    activation({ n: 4, text: "Other bot", messageId: "u1", now: MONTH, botId: "dax", source: "src1" });
    addLesson(db, { botId: "ember", text: "Keep it short", origin: "typed", learning: DEFAULT_BOT_LEARNING, now: MONTH });
    addLesson(db, { botId: "ember", text: "Older lesson", origin: "typed", learning: DEFAULT_BOT_LEARNING, now: LAST_MONTH });
    expect(learningCounts(db, { botId: "ember", now: MONTH })).toMatchObject({ month: "2026-10", lessons: 1, memories: 2, undone: 0 });
    expect(learningCounts(db, { botId: "ember", month: "2026-09" })).toMatchObject({ month: "2026-09", lessons: 1, memories: 1 });
  });
  it("counts a won or good mark as a win and an undo as undone", () => {
    const id = activation({ n: 1, text: "A", messageId: "u1", now: MONTH });
    db.prepare("INSERT INTO memory_outcomes(id,bot_id,thread_id,kind,proposed_by,confirmed_by,created_at) VALUES('o1','ember','th','won','owner','owner',?)").run(MONTH);
    db.prepare("INSERT INTO memory_outcomes(id,bot_id,thread_id,kind,proposed_by,confirmed_by,created_at) VALUES('o2','ember','th','lost','owner','owner',?)").run(MONTH);
    db.prepare("UPDATE memory_learning_events SET undone_at=? WHERE id=?").run(MONTH + 5, id);
    expect(learningCounts(db, { botId: "ember", now: MONTH })).toMatchObject({ wins: 1, undone: 1 });
  });
  it("an empty month is all zeros", () => {
    expect(learningCounts(db, { botId: "ember", now: MONTH })).toEqual({ month: "2026-10", lessons: 0, memories: 0, wins: 0, undone: 0 });
  });
  it("the badge counts what is new since the owner last looked, and only what is still kept", () => {
    activation({ n: 1, text: "A", messageId: "u1", now: T0 + 10 });
    const gone = activation({ n: 2, text: "B", messageId: "u1", now: T0 + 20, source: "src1" });
    db.prepare("UPDATE memory_learning_events SET undone_at=? WHERE id=?").run(T0 + 30, gone);
    addLesson(db, { botId: "ember", text: "Keep it short", origin: "typed", learning: DEFAULT_BOT_LEARNING, now: T0 + 40 });
    expect(newLearningSince(db, "ember", T0)).toBe(2);
    expect(newLearningSince(db, "ember", T0 + 15)).toBe(1);
    expect(newLearningSince(db, "ember", T0 + 100)).toBe(0);
    expect(newLearningSince(db, "dax", 0)).toBe(0);
  });
});

describe("praise and win chips keep their own rate", () => {
  it("a memory chip never counts against the once-per-10-turns rate of praise and win chips", () => {
    activation({ n: 1, text: "A", messageId: "u1" });
    rememberedMomentsForJob(db, "job1", T0 - 1);
    const first = recordKeptMoment(db, { botId: "ember", threadId: "th", replyMessageId: "b1", label: "short openers", variant: "win", exemplarKey: "outcome:1", now: T0 + 5 }, { turnsSince: () => 0 });
    expect(first).toMatchObject({ shown: true });
  });
});
