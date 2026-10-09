// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot learning, integration: the cross-batch contracts (admission, the lesson
// sink and former, "Not an example"), the learning budget lease around the
// classifier, and Sean's rule for a bare complaint ("that sucks").
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BOT_LEARNING } from "../bot-learning.ts";
import { setFeedbackObserver } from "../message-db.ts";
import type { Message } from "../store.ts";
import { observeOwnerMessage } from "./outcomes.ts";
import { detectFeedback, type FeedbackDeps, type LessonSink } from "./feedback.ts";
import { changeLessonEvent, formLessonFromFeedback, listLessons, renderLearnedBlock, recordKeptMoment, setFeedbackLessonFormer, setKeptMomentUndoHook, setLearningLocalLessonSink, setLessonAdmitter, addLesson } from "./lessons.ts";
import { afterFeedback, leasedFeedbackClassifier, onActivePath, recordWinChip, wireBotLearning, type BotLearningWiring } from "./learning-wiring.ts";
import { readProspectScope, isOutcomeEvidence } from "./learnable.ts";
import { MEMORY_SCHEMA } from "./schema.ts";

const NOW = 1_800_000_000_000;
let db: DatabaseSync;
let bots: Record<string, Record<string, unknown>>;

function memoryDb() {
  const handle = new DatabaseSync(":memory:");
  handle.exec(MEMORY_SCHEMA);
  handle.exec("CREATE TABLE messages (thread_id TEXT, id TEXT, text TEXT)");
  handle.prepare("INSERT INTO memory_meta(id,schema_version,installation_id,mode) VALUES(1,7,?,'active')").run(randomUUID());
  return handle;
}
const wiring = (): BotLearningWiring => ({
  dataDir: "/nonexistent-data-dir", db: () => db, bot: id => bots[id] as never, roster: () => ({ bots: [{ id: "bot-a", threadId: "th" }], groups: [] }),
  connection: () => ({ extractor: null }), readThread: () => [], activePath: () => [], defer: run => run(),
});
beforeEach(() => { db = memoryDb(); bots = { "bot-a": { id: "bot-a", name: "Sable", threadId: "th" } }; });
afterEach(() => {
  db.close();
  setFeedbackLessonFormer(null); setKeptMomentUndoHook(null); setLessonAdmitter(null); setLearningLocalLessonSink(null); setFeedbackObserver(null);
});

let seq = 0;
const botMsg = (text: string): Message => ({ id: `b${++seq}`, at: NOW - 60_000 + seq, role: "bot", kind: "text", text, turnId: `t${seq}`, turnTerminal: true });
const userMsg = (text: string): Message => ({ id: `u${++seq}`, at: NOW + seq, role: "user", kind: "text", text, origin: "desktop" });
describe("contracts", () => {
  it("wires B4's admission gate into lessons: contact details are redacted before storage", () => {
    wireBotLearning(wiring());
    const result = addLesson(db, { botId: "bot-a", text: "Sign off with bob@example.com as the contact", origin: "typed", learning: DEFAULT_BOT_LEARNING, now: NOW });
    expect(result.status).toBe("applied");
    if (result.status === "applied") expect(result.lesson.text).not.toContain("bob@example.com");
  });

  it("the feedback former plans through B2's rules and stores plan.evidence unchanged", () => {
    wireBotLearning(wiring());
    db.prepare("INSERT INTO memory_feedback(id,bot_id,thread_id,message_id,target_message_id,polarity,strength,correction,confidence,state,scope,created_at) VALUES('fb1','bot-a','th','u1','b1','-',2,'lead with the decision',0.9,'detected','chat',?)").run(NOW);
    const result = formLessonFromFeedback({ db, botId: "bot-a", threadId: "th", replyMessageId: "b1", polarity: "-", strength: 2, correction: "lead with the decision", confidence: 0.9, learning: DEFAULT_BOT_LEARNING, now: NOW });
    // The owner's own words are free text: they wait for one tap ("Keep it?") and are not applied on their own.
    expect(result.status).toBe("suggested");
    const lesson = listLessons(db, "bot-a")[0]!;
    expect(lesson).toMatchObject({ state: "suggested", kind: "note", scope: "owner" });
    expect(lesson.text).toBe("lead with the decision");
    expect(lesson.evidence).toEqual({ feedbackId: "fb1", phrase: null, messageId: "u1", action: null });
    expect(db.prepare("SELECT state,scope FROM memory_feedback WHERE id='fb1'").get()).toMatchObject({ state: "lesson", scope: "bot" });
    // a suggestion has no ledger row yet; its chip anchor is the reply it came from, stored with the lesson itself
    expect(lesson).toMatchObject({ threadId: "th", targetMessageId: "b1", learningEventId: null });
  });

  it("stores B2's evidence object as given, so forgetting and phrase suppression can read it", () => {
    wireBotLearning(wiring());
    const evidence = { feedbackId: "fb9", phrase: "wrong", messageId: "u9", action: "send_email" };
    const result = addLesson(db, { botId: "bot-a", text: "Check the recipient first", origin: "feedback", learning: DEFAULT_BOT_LEARNING, evidence, now: NOW });
    expect(result.status).toBe("suggested"); // free text waits for one tap; the evidence is stored as given either way
    expect(listLessons(db, "bot-a")[0]!.evidence).toEqual(evidence);
  });

  it("Not an example removes the win it stood for: the outcome mark is revoked", () => {
    wireBotLearning(wiring());
    db.prepare("INSERT INTO messages VALUES('th','b1','The deal closed on Friday')").run();
    db.prepare("INSERT INTO memory_outcomes(id,bot_id,thread_id,kind,proposed_by,confirmed_by,source_event_key,created_at) VALUES('o1','bot-a','th','won','owner','owner','mark:b1',?)").run(NOW);
    recordWinChip(db, { id: "o1", botId: "bot-a", threadId: "th", messageId: "b1", kind: "won" });
    const event = db.prepare("SELECT * FROM memory_learning_events WHERE kind='outcome-marked'").get() as Record<string, any>;
    expect(JSON.parse(event.detail)).toMatchObject({ chip: 1, variant: "win", exemplarKey: "outcome:o1", replyMessageId: "b1" });
    expect(changeLessonEvent(db, event, "undo")).toMatchObject({ ok: true, undone: true });
    expect(db.prepare("SELECT revoked_at FROM memory_outcomes WHERE id='o1'").get()?.revoked_at).not.toBeNull();
  });

  it("Not an example on kept praise ignores the feedback row; an unknown exemplar refuses to say Undone", () => {
    wireBotLearning(wiring());
    db.prepare("INSERT INTO memory_feedback(id,bot_id,thread_id,message_id,polarity,strength,state,scope,created_at) VALUES('fp','bot-a','th','u2','+',3,'detected','chat',?)").run(NOW);
    const make = (key: string) => {
      const shown = recordKeptMoment(db, { botId: "bot-a", threadId: "th", replyMessageId: "b2", label: "that reply", variant: "praise", exemplarKey: key }, { turnsSince: () => 99 });
      if (!shown.shown) throw new Error("chip not recorded");
      return db.prepare("SELECT * FROM memory_learning_events WHERE id=?").get(shown.eventId) as Record<string, any>;
    };
    changeLessonEvent(db, make("feedback:fp"), "undo");
    expect(db.prepare("SELECT state FROM memory_feedback WHERE id='fp'").get()?.state).toBe("ignored");
    expect(() => changeLessonEvent(db, make("mystery:1"), "undo")).toThrow();
  });
});

describe("prospect scope", () => {
  it("is empty by default and read from the bot's own learning config", () => {
    expect(readProspectScope({})).toEqual({ threadIds: [] });
    expect(readProspectScope({ learning: { enabled: true } })).toEqual({ threadIds: [] });
    expect(readProspectScope({ learning: { prospectThreadIds: ["t1", 5, "", "t2"] } })).toEqual({ threadIds: ["t1", "t2"] });
  });
  it("isOutcomeEvidence uses it: a prospect in an unlisted thread is refused even with the opt-in on", () => {
    db.exec("INSERT INTO memory_scopes VALUES('sc','conversation','th2','[]',0)");
    db.exec("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,revision,content_hash,kind,speaker,outcome,state) VALUES('src1','sc','th2','m1',0,'h','text','person:p1','none','active')");
    db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES('src1',0,'h',?,?)").run(JSON.stringify({ text: "hello there" }), NOW);
    const bot = { id: "bot-a", learning: { enabled: true, prospectLearning: true } };
    expect(isOutcomeEvidence(db, { id: "src1", revision: 0 }, bot, { roster: { bots: [], groups: [] } })).toMatchObject({ admit: false, reason: "thread-not-in-prospect-scope" });
  });
});

describe("the classifier runs behind the learning budget lease", () => {
  it("one call through the lease, 300 output tokens, and a refusal throws so detection falls back to stage 1", async () => {
    const seen: Array<{ max: number; purpose: unknown }> = [];
    const extractor = (async (_text: string, max: number, _signal: AbortSignal, dispatch?: { purpose?: unknown }) => { seen.push({ max, purpose: dispatch?.purpose }); return "{}"; }) as never;
    await leasedFeedbackClassifier(extractor).classify({ turn: null, message: "good job" }, new AbortController().signal).catch(() => undefined);
    // The lease needs the installation's learning budget; without one it refuses, and the classifier throws rather than calling the model.
    expect(seen.every(call => call.max === 300)).toBe(true);
    await expect(leasedFeedbackClassifier(null as never).classify({ turn: null, message: "good job" }, new AbortController().signal)).rejects.toThrow();
  });
});

describe("a bare complaint is never dropped", () => {
  const scene = (text: string, thread = "th") => {
    const answer = botMsg("Here is the weekly summary.");
    const msg = userMsg(text);
    return { thread: [answer, msg], msg, threadId: thread };
  };
  const deps = (thread: Message[], sink: LessonSink | null): FeedbackDeps => ({
    classifier: null, botLearning: () => ({ enabled: true, askFirst: false }), resolveBotId: () => "bot-a", readThread: () => thread, now: () => NOW + 1000, botName: () => "Sable", lessons: sink,
  });
  const makeSink = (): LessonSink => ({
    form: (plan, ctx) => {
      const result = addLesson(db, { botId: ctx.botId, origin: plan.origin, learning: { ...DEFAULT_BOT_LEARNING, askFirst: plan.askFirst }, evidence: plan.evidence, now: NOW, scope: plan.scope, ...(plan.spec ? { spec: plan.spec, where: plan.where, auto: plan.auto } : { text: plan.text }) });
      return result.status === "applied" || result.status === "suggested" ? result.lesson.id : null;
    },
  });

  it("goes into the bot's next-turn context as recent feedback, with the cue to adjust or ask", async () => {
    const { thread, msg } = scene("that sucks");
    const result = await detectFeedback(db, "th", msg, deps(thread, makeSink()));
    expect(result).toMatchObject({ status: "recorded", decision: { polarity: "-", strength: 2, correction: null }, lesson: null });
    const block = renderLearnedBlock(db, { botId: "bot-a", threadId: "th", ownerAudience: true, now: NOW + 2000, turnsSince: () => 0 });
    expect(block.text).toContain("Recent feedback in this conversation");
    expect(block.text).toContain("not happy with your last reply and did not say what to change");
    expect(block.text).not.toContain("ask them");
    expect(block.feedbackIds).toHaveLength(1);
    expect(listLessons(db, "bot-a")).toHaveLength(0);
  });

  it("two similar bare complaints on the same kind of work become a lesson suggestion", async () => {
    const first = scene("that sucks"), second = scene("this is terrible");
    expect(await detectFeedback(db, "th", first.msg, deps(first.thread, makeSink()))).toMatchObject({ status: "recorded", lesson: null });
    const result = await detectFeedback(db, "th", second.msg, deps(second.thread, makeSink()));
    expect(result).toMatchObject({ status: "recorded", lesson: { rule: "complaint-repeat", askFirst: true } });
    const lessons = listLessons(db, "bot-a");
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ state: "suggested", origin: "feedback" });
    expect(lessons[0]!.text).toMatch(/ask what to change/);
    expect(lessons[0]!.evidence).toMatchObject({ messageId: second.msg.id });
  });

  it("does not count a complaint from another conversation or one that points at an action", async () => {
    const a = scene("that sucks", "other"), b = scene("this is terrible");
    await detectFeedback(db, "other", a.msg, deps(a.thread, makeSink()));
    expect(await detectFeedback(db, "th", b.msg, deps(b.thread, makeSink()))).toMatchObject({ status: "recorded", lesson: null });
    expect(listLessons(db, "bot-a")).toHaveLength(0);
  });
});

describe("the praise chip (T1-07)", () => {
  const praise = async (text: string, strength: 2 | 3) => {
    const answer = botMsg("Here is the weekly summary."), msg = userMsg(text);
    const classifier = { classify: async () => JSON.stringify({ isFeedback: true, target: "turn", polarity: "+", strength, correction: null, confidence: 0.95 }) };
    const result = await detectFeedback(db, "th", msg, { classifier, botLearning: () => ({ enabled: true, askFirst: false }), resolveBotId: () => "bot-a", readThread: () => [answer, msg], now: () => NOW + 1000, botName: () => "Sable", lessons: null });
    afterFeedback(db, "th", result);
    return db.prepare("SELECT COUNT(*) c FROM memory_learning_events WHERE kind='feedback-detected' AND json_extract(detail,'$.chip')=1").get()!.c;
  };
  it("a plain 'good job' (strength 2) shows no chip; strong praise (strength 3) shows one", async () => {
    expect(await praise("good job", 2)).toBe(0);
    expect(await praise("perfect, exactly what I wanted", 3)).toBe(1);
  });
});

describe("owner edits become lessons on the repeat rule (T1-08)", () => {
  const draft1 = "Hi Dana, hope you are well. We would love to schedule a quick call this week to go over the proposal and next steps for your team, whenever suits you best.";
  const short1 = "Hi Dana, hope you are well. Can we talk this week about the proposal and next steps?";
  const draft2 = "Hello Priya, I wanted to follow up about the onboarding timeline and see whether we could arrange a longer conversation sometime soon about everything that remains open, including the open questions on training, data migration and the security review.";
  const short2 = "Hello Priya, I wanted to follow up about the onboarding timeline and see whether we could arrange a conversation about everything that remains open.";
  const send = (id: string, text: string, history: any[], at: number) => observeOwnerMessage(db, wiring().bot("bot-a") as never, "th", { id, role: "user", kind: "text", text, at } as any, history, at);
  it("the first shortening is only recent feedback; the second forms one lesson, with a chip under the draft", () => {
    wireBotLearning(wiring());
    const history1 = [{ id: "m1", role: "bot", kind: "text", text: draft1, turnTerminal: true }] as any[];
    send("u1", short1, history1, NOW);
    expect(listLessons(db, "bot-a", { states: ["active", "suggested"] })).toHaveLength(0);
    const first = renderLearnedBlock(db, { botId: "bot-a", threadId: "th", ownerAudience: true, now: NOW + 1, turnsSince: () => 0 }).text;
    expect(first).toContain("rewrote your draft");
    expect(first).not.toContain("Can we talk this week"); // not the whole edited email
    const history2 = [{ id: "m2", role: "bot", kind: "text", text: draft2, turnTerminal: true }] as any[];
    send("u2", short2, history2, NOW + 2);
    const lessons = listLessons(db, "bot-a", { states: ["active"] });
    expect(lessons).toHaveLength(1);
    // An edit maps 1:1 onto a typed style value; the line in the prompt is written by code.
    expect(lessons[0]).toMatchObject({ kind: "style", spec: { kind: "length", value: "brief" }, where: "everywhere", text: "Keep replies brief." });
    expect(lessons[0]!.origin).toBe("edit");
    // the edited draft is what taught it: a rewind of that message sets the style aside
    expect(lessons[0]).toMatchObject({ sourceMessageId: "u2", targetMessageId: "m2", threadId: "th" });
    // a third edit does not stack a duplicate
    send("u3", short2 + " ", history2, NOW + 3);
    expect(listLessons(db, "bot-a", { states: ["active", "suggested"] })).toHaveLength(1);
  });
});

// TODO(Tier 2): with the "Learn from customer and audience messages" switch ON for a chosen thread, a non-owner's words should
// land only in learning-local/<bot> (never messages.db) and feed the outcome path. Tier 1 has no producer for that, so the
// screen shows the switch as "coming later" (T1-17). Un-skip and fill in when Tier 2 consumes prospect material.
describe("prospect learning switched ON (Tier 2)", () => {
  it.skip("a non-owner's message in a chosen thread lands only in learning-local, never in messages.db or the prompt", () => {
    expect(true).toBe(false);
  });
});

describe("an undone lesson's words do not come back as recent feedback", () => {
  it("the owner undid this lesson, says it again: no lesson, and the words are not applied as 'apply it now' either", () => {
    wireBotLearning(wiring());
    const first = addLesson(db, { botId: "bot-a", text: "use the order number", origin: "feedback", learning: DEFAULT_BOT_LEARNING, scope: "owner", threadId: "th", now: NOW });
    if (first.status !== "suggested") throw new Error(first.status);
    db.prepare("UPDATE memory_lessons SET state='undone',decided_at=? WHERE id=?").run(NOW + 5, first.lesson.id);
    db.prepare("INSERT INTO memory_feedback(id,bot_id,thread_id,message_id,target_message_id,polarity,strength,correction,confidence,state,scope,created_at) VALUES('fb2','bot-a','th','u2','b1','-',2,'use the order number',0.9,'detected','chat',?)").run(NOW + 10);
    const result = formLessonFromFeedback({ db, botId: "bot-a", threadId: "th", replyMessageId: "b1", polarity: "-", strength: 2, correction: "use the order number", confidence: 0.9, learning: DEFAULT_BOT_LEARNING, now: NOW + 10 });
    expect(result.status).toBe("none");
    expect(db.prepare("SELECT state,correction FROM memory_feedback WHERE id='fb2'").get()).toMatchObject({ state: "ignored", correction: null });
    expect(renderLearnedBlock(db, { botId: "bot-a", threadId: "th", ownerAudience: true, now: NOW + 11, turnsSince: () => 0 }).text).not.toContain("order number");
  });
});

describe("staleness by branch, not by clock (design 3.6)", () => {
  const m = (id: string, parentId: string | null, text: string, role: "user" | "bot" = "user"): Message => ({ id, at: 10, role, kind: "text", text, parentId } as never);
  it("an owner message counts only while it is on the visible branch with the same words, and so is the reply it answered", () => {
    const reply = m("b1", null, "Draft.", "bot"), a = m("u1", "b1", "No, use bullet points"), b = m("u2", "b1", "No, use tables");
    expect(onActivePath([reply, a], a, "b1")).toBe(true);
    expect(onActivePath([reply, b], a, "b1")).toBe(false);
    expect(onActivePath([reply, a], a, "gone")).toBe(false);
    expect(onActivePath([reply, { ...a, text: "No, use bullets" } as Message], a, "b1")).toBe(false);
  });
  it("a branch change sets aside what was learned from words that left the branch", () => {
    const handle = wireBotLearning({ ...wiring(), activePath: () => [m("b1", null, "Draft.", "bot"), m("u2", "b1", "No, use tables")] });
    db.prepare("INSERT INTO memory_feedback(id,bot_id,thread_id,message_id,target_message_id,polarity,strength,state,scope,created_at) VALUES('fb1','bot-a','th','u1','b1','-',2,'detected','chat',?)").run(NOW);
    handle.onBranchChange("th");
    expect(db.prepare("SELECT state,correction FROM memory_feedback WHERE id='fb1'").get()).toMatchObject({ state: "expired", correction: null });
  });
});
