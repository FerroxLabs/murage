// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Teams (bot-learning batch B11, design section 14): lesson scopes and
// recipients, the Chief suggestion, the team sub-block, precedence and
// conflicts, lineage for Undo, and what never transfers.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BOT_LEARNING } from "../bot-learning.ts";
import { changeLearningEvent } from "./learning-history.ts";
import { lessonsConflict } from "./lesson-lineage.ts";
import {
  applyLessonShare, chiefShareSuggestion, lessonConflicts, setLessonRoster, suggestLessonShare, teamMembersOf, type LessonRosterBot,
} from "./lesson-sharing.ts";
import { addLesson, applySuggestedLesson, listLessons, renderLearnedBlock, setLearningLocalLessonSink, setLessonAdmitter, type Lesson } from "./lessons.ts";
import { migrateMemorySchema } from "./schema.ts";

let db: DatabaseSync;
let clock = 1_700_000_000_000;
const ROSTER: LessonRosterBot[] = [
  { id: "chief", name: "Sage", chiefOfStaff: true, section: "sales" },
  { id: "dax", name: "Dax", section: "sales" },
  { id: "nova", name: "Nova", section: "sales" },
  { id: "echo", name: "Echo", section: "support" },
];
const teach = (botId: string, text: string, extra: Record<string, unknown> = {}): Lesson => {
  const result = addLesson(db, { botId, text, origin: "typed", learning: DEFAULT_BOT_LEARNING, now: clock++, ...extra } as any);
  if (result.status !== "applied") throw new Error(`expected applied, got ${result.status}`);
  return result.lesson;
};
const block = (botId: string, ownerAudience = true) => renderLearnedBlock(db, { botId, threadId: "t1", ownerAudience, now: clock, turnsSince: () => 0 });
const state = (id: string) => db.prepare("SELECT state,text,bot_id FROM memory_lessons WHERE id=? ORDER BY version DESC LIMIT 1").get(id) as any;
const copiesOf = (id: string) => db.prepare("SELECT id,bot_id,state,scope,evidence,origin FROM memory_lessons WHERE parent_id=? AND scope='bot'").all(id) as any[];
const refusal = (work: () => unknown) => { try { work(); } catch (cause) { return cause as Error & { status?: number; code?: string }; } throw new Error("expected a refusal"); };

beforeEach(() => { db = new DatabaseSync(":memory:"); migrateMemorySchema(db); setLessonRoster(() => ROSTER); setLessonAdmitter(null); setLearningLocalLessonSink(null); });
afterEach(() => { setLessonRoster(null); db.close(); });

describe("the suggestion", () => {
  it("names the recipient bots and copies nothing until the owner applies it", () => {
    const source = teach("chief", "Lead with the decision, then the detail");
    const share = suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: ["dax", "nova", "echo"], now: clock++ });
    expect(share).toMatchObject({ state: "suggested", scope: "bots", recipients: ["dax", "nova", "echo"], botId: "chief", parentId: source.id, text: source.text });
    expect(listLessons(db, "dax")).toEqual([]);
    expect(block("dax").text).toBe("");
    // asking twice gives the same suggestion, not a second card
    expect(suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: ["dax"], now: clock++ }).id).toBe(share.id);
  });

  it("the Chief's owner-preference lesson is offered to every other bot by name; another bot's is not", () => {
    const pref = teach("chief", "Use decision-first summaries");
    const offered = chiefShareSuggestion(db, { botId: "chief", lessonId: pref.id, now: clock++ });
    expect(offered).toMatchObject({ state: "suggested", scope: "bots", recipients: ["dax", "nova", "echo"] });
    const other = teach("dax", "Keep it under 100 words");
    expect(chiefShareSuggestion(db, { botId: "dax", lessonId: other.id, now: clock++ })).toBeNull();
  });

  it("refuses unknown bots, the source bot itself, and an empty list", () => {
    const source = teach("chief", "Lead with the decision");
    expect(refusal(() => suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: ["ghost"] })).status).toBe(400);
    expect(refusal(() => suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: ["chief"] })).status).toBe(400);
    expect(refusal(() => suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: [] })).status).toBe(400);
  });

  it("a not-active lesson cannot be shared", () => {
    const source = teach("chief", "Lead with the decision");
    changeLearningEvent(db, source.learningEventId!, "undo", clock++);
    expect(refusal(() => suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: ["dax"] })).status).toBe(409);
  });
});

describe("applying it", () => {
  it("copies to the bots the owner picked, each with its own lesson and ledger row, and nothing else", () => {
    const source = teach("chief", "Lead with the decision, then the detail", { evidence: [{ kind: "source", id: "src-1" }] });
    const share = suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: ["dax", "nova", "echo"], now: clock++ });
    const result = applyLessonShare(db, { botId: "chief", lessonId: share.id, recipients: ["dax", "nova"], now: clock++ });
    expect(result.copies.map(copy => copy.botId).sort()).toEqual(["dax", "nova"]);
    for (const copy of result.copies) expect(copy).toMatchObject({ scope: "bot", state: "active", origin: "suggested", parentId: source.id, evidence: null });
    expect(listLessons(db, "echo")).toEqual([]);
    expect(block("dax").text).toContain("Lead with the decision, then the detail");
    expect(block("echo").text).toBe("");
    // each copy owns a ledger row under its own bot, so "What it learned" lists it there
    const events = db.prepare("SELECT bot_id,detail FROM memory_learning_events WHERE kind='lesson-learned' AND bot_id IN ('dax','nova')").all() as any[];
    expect(events.map(event => event.bot_id).sort()).toEqual(["dax", "nova"]);
    expect(JSON.parse(events[0].detail)).toMatchObject({ origin: "suggested", sharedFrom: "chief" });
    expect(state(share.id).state).toBe("retired");
    // picking a bot the suggestion did not name is refused
    const second = suggestLessonShare(db, { botId: "chief", lessonId: teach("chief", "Short subject lines").id, recipients: ["dax"], now: clock++ });
    expect(refusal(() => applyLessonShare(db, { botId: "chief", lessonId: second.id, recipients: ["echo"] })).status).toBe(400);
  });

  it("is never automatic: a bot with Ask first on still gets an active copy only after the owner applies", () => {
    const source = teach("chief", "Lead with the decision");
    suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: ["dax"], now: clock++ });
    expect(listLessons(db, "dax")).toEqual([]);
    expect(listLessons(db, "chief", { states: ["suggested"] })).toHaveLength(1);
  });

  it("skips a recipient that already holds the same words", () => {
    const source = teach("chief", "Lead with the decision");
    teach("dax", "lead with the decision.");
    const share = suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: ["dax", "nova"], now: clock++ });
    expect(applyLessonShare(db, { botId: "chief", lessonId: share.id, now: clock++ }).copies.map(copy => copy.botId)).toEqual(["nova"]);
  });
});

describe("privacy: what never transfers", () => {
  it("a prospect-derived lesson cannot be shared, by any route", () => {
    setLearningLocalLessonSink(() => {});
    const r = addLesson(db, { botId: "chief", text: "Prospects like short intros", origin: "feedback", learning: { ...DEFAULT_BOT_LEARNING, prospectLearning: true }, prospectDerived: true, now: clock++ });
    expect(r.status).toBe("suggested");
    // it never reached messages.db, so there is nothing to share
    expect(refusal(() => suggestLessonShare(db, { botId: "chief", lessonId: r.status === "suggested" ? r.lesson.id : "", recipients: ["dax"] })).status).toBe(404);
    // and a row that reached the table anyway is still refused, and the Chief suggestion skips it
    const source = teach("chief", "Prospects like short intros too");
    db.prepare("UPDATE memory_lessons SET prospect_derived=1 WHERE id=?").run(source.id);
    const error = refusal(() => suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: ["dax"] }));
    expect(error).toMatchObject({ status: 422, code: "prospect-derived" });
    expect(chiefShareSuggestion(db, { botId: "chief", lessonId: source.id })).toBeNull();
    expect(listLessons(db, "chief", { states: ["suggested"] })).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) c FROM memory_lessons WHERE scope IN ('bots','team')").get()).toMatchObject({ c: 0 });
  });

  it("an applied share never carries a prospect flag, evidence, outcomes, feedback or examples", () => {
    const source = teach("chief", "Lead with the decision", { evidence: { feedbackId: "f1", messageId: "m1", phrase: "too long" } });
    db.prepare("INSERT INTO memory_feedback(id,bot_id,thread_id,message_id,polarity,strength,correction,state,scope,created_at) VALUES('f1','chief','t','m1','-',2,'too long','lesson','bot',1)").run();
    db.prepare("INSERT INTO memory_outcomes(id,bot_id,thread_id,kind,proposed_by,source_event_key,created_at) VALUES('o1','chief','t','won','owner','k1',1)").run();
    const share = suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: ["dax"], now: clock++ });
    applyLessonShare(db, { botId: "chief", lessonId: share.id, now: clock++ });
    const copy = copiesOf(source.id)[0];
    expect(copy.evidence).toBeNull();
    expect(db.prepare("SELECT prospect_derived p FROM memory_lessons WHERE id=?").get(copy.id)).toMatchObject({ p: 0 });
    for (const table of ["memory_feedback", "memory_outcomes", "memory_episodes", "memory_learning_runs"]) expect(db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE bot_id='dax'`).get()).toMatchObject({ c: 0 });
    expect(block("dax").text).not.toContain("too long");
  });

  it("a lesson that came from an outcome mark, or a shared copy, cannot be shared on", () => {
    const waiting = addLesson(db, { botId: "chief", text: "Follow up within two days", origin: "mark", learning: DEFAULT_BOT_LEARNING, now: clock++ });
    if (waiting.status !== "suggested") throw new Error(waiting.status);
    const marked = applySuggestedLesson(db, { botId: "chief", lessonId: waiting.lesson.id, now: clock++ });
    expect(refusal(() => suggestLessonShare(db, { botId: "chief", lessonId: marked.id, recipients: ["dax"] })).code).toBe("outcome-derived");
    const source = teach("chief", "Lead with the decision");
    const share = suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: ["dax"], now: clock++ });
    const copy = applyLessonShare(db, { botId: "chief", lessonId: share.id, now: clock++ }).copies[0]!;
    expect(refusal(() => suggestLessonShare(db, { botId: "dax", lessonId: copy.id, recipients: ["nova"] })).code).toBe("already-shared");
  });

  it("a non-owner audience gets no learned block at all, shared or not", () => {
    const source = teach("chief", "Lead with the decision");
    applyLessonShare(db, { botId: "chief", lessonId: suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: ["dax"], now: clock++ }).id, now: clock++ });
    // a copy shared down from another bot never reaches a customer-facing turn (T1-19)
    expect(block("dax", false).text).toBe("");
  });
});

describe("lineage", () => {
  const shared = () => {
    const source = teach("chief", "Lead with the decision, then the detail");
    const share = suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: ["dax", "nova"], now: clock++ });
    const copies = applyLessonShare(db, { botId: "chief", lessonId: share.id, now: clock++ }).copies;
    return { source, copies };
  };

  it("Undo on the source removes every copy, and the recipients' next turn no longer carries it", () => {
    const { source, copies } = shared();
    expect(block("dax").text).toContain("Lead with the decision");
    changeLearningEvent(db, source.learningEventId!, "undo", clock++);
    for (const copy of copies) { expect(state(copy.id).state).toBe("undone"); expect(db.prepare("SELECT undone_at FROM memory_learning_events WHERE id=?").get(copy.learningEventId)!.undone_at).not.toBeNull(); }
    expect(block("dax").text).toBe("");
    expect(block("nova").text).toBe("");
  });

  it("Keep inside the window brings the source and its copies back together", () => {
    const { source, copies } = shared();
    changeLearningEvent(db, source.learningEventId!, "undo", clock++);
    changeLearningEvent(db, source.learningEventId!, "keep", clock++);
    for (const copy of copies) expect(state(copy.id).state).toBe("active");
    expect(block("nova").text).toContain("Lead with the decision");
  });

  it("Undo on one copy removes only that copy", () => {
    const { source, copies } = shared();
    changeLearningEvent(db, copies[0]!.learningEventId!, "undo", clock++);
    expect(state(source.id).state).toBe("active");
    expect(state(copies[0]!.id).state).toBe("undone");
    expect(state(copies[1]!.id).state).toBe("active");
  });

  it("a copy the owner undid on its own stays undone when the source comes back", () => {
    const { source, copies } = shared();
    changeLearningEvent(db, copies[0]!.learningEventId!, "undo", clock++);
    changeLearningEvent(db, source.learningEventId!, "undo", clock++);
    changeLearningEvent(db, source.learningEventId!, "keep", clock++);
    expect(state(copies[0]!.id).state).toBe("undone");
    expect(state(copies[1]!.id).state).toBe("active");
  });

  it("an unanswered share suggestion is withdrawn when the source is undone", () => {
    const source = teach("chief", "Lead with the decision");
    const share = suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: ["dax"], now: clock++ });
    changeLearningEvent(db, source.learningEventId!, "undo", clock++);
    expect(state(share.id).state).toBe("retired");
  });
});

describe("precedence and conflicts", () => {
  it("detects an opposite pair on the same subject, and nothing else", () => {
    expect(lessonsConflict({ kind: "tone", text: "No emojis in client emails" }, { kind: "tone", text: "Use emojis in client emails" })).toBe(true);
    expect(lessonsConflict({ kind: "tone", text: "Don't lead with the price" }, { kind: "tone", text: "Lead with the price" })).toBe(true);
    expect(lessonsConflict({ kind: "tone", text: "No emojis in client emails" }, { kind: "preference", text: "Use emojis in client emails" })).toBe(false);
    expect(lessonsConflict({ kind: "tone", text: "No emojis in client emails" }, { kind: "tone", text: "Keep subject lines short" })).toBe(false);
    expect(lessonsConflict({ kind: "tone", text: "No emojis in client emails" }, { kind: "tone", text: "No emojis in client emails" })).toBe(false);
  });

  it("two different values for the same setting conflict; different subjects do not", () => {
    const tone = (text: string) => ({ kind: "preference", text });
    expect(lessonsConflict(tone("Keep replies under 3 sentences"), tone("Keep replies under 5 sentences"))).toBe(true);
    expect(lessonsConflict(tone("Write to clients in French"), tone("Write to clients in Spanish"))).toBe(true);
    expect(lessonsConflict(tone("Send the report on Monday"), tone("Send the report on Friday"))).toBe(true);
    expect(lessonsConflict(tone("Send the report on Monday"), tone("Send the invoice on Friday"))).toBe(false);
    expect(lessonsConflict(tone("Keep replies under 3 sentences"), { kind: "tone", text: "Keep replies under 5 sentences" })).toBe(false);
  });

  it("the bot's own lesson beats an inherited one: the block carries only the own, and the conflict is reported", () => {
    teach("dax", "No emojis in client emails", { kind: "tone" });
    const source = teach("chief", "Use emojis in client emails", { kind: "tone" });
    const share = suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: ["dax", "nova"], now: clock++ });
    const copies = applyLessonShare(db, { botId: "chief", lessonId: share.id, now: clock++ }).copies;
    expect(block("dax").text).toContain("No emojis in client emails");
    expect(block("dax").text).not.toContain("Use emojis");
    expect(block("nova").text).toContain("Use emojis in client emails");
    const conflicts = lessonConflicts(db, "dax");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ winner: { text: "No emojis in client emails" }, other: { id: copies.find(copy => copy.botId === "dax")!.id, text: "Use emojis in client emails" }, via: "shared", fromBotId: "chief" });
    expect(lessonConflicts(db, "nova")).toEqual([]);
  });

  it("a conflict stops once the own lesson is undone: the inherited one applies again", () => {
    const own = teach("dax", "No emojis in client emails", { kind: "tone" });
    const source = teach("chief", "Use emojis in client emails", { kind: "tone" });
    applyLessonShare(db, { botId: "chief", lessonId: suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: ["dax"], now: clock++ }).id, now: clock++ });
    changeLearningEvent(db, own.learningEventId!, "undo", clock++);
    expect(lessonConflicts(db, "dax")).toEqual([]);
    expect(block("dax").text).toContain("Use emojis in client emails");
  });
});

describe("team scope and the learned shape", () => {
  it("the team members are the Chief's section; a workspace Chief reaches everyone", () => {
    expect(teamMembersOf("chief")).toEqual(["dax", "nova"]);
    setLessonRoster(() => ROSTER.map(bot => bot.id === "chief" ? { ...bot, chiefScope: "workspace" as const } : bot));
    expect(teamMembersOf("chief")).toEqual(["dax", "nova", "echo"]);
  });

  it("renders as a 'Learned for this team' sub-block for members only, after the bot's own lessons", () => {
    teach("dax", "Keep replies short");
    addLesson(db, { botId: "dax", spec: { kind: "length", value: "brief" }, where: "everywhere", auto: true, origin: "feedback", learning: DEFAULT_BOT_LEARNING, now: clock++ });
    const source = teach("chief", "Sign off with the first name only");
    const share = suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: "team", now: clock++ });
    expect(share).toMatchObject({ scope: "team", state: "suggested", recipients: ["dax", "nova"] });
    expect(block("dax").text).not.toContain("Sign off");
    const applied = applyLessonShare(db, { botId: "chief", lessonId: share.id, now: clock++ });
    expect(applied.team).toMatchObject({ scope: "team", state: "active", recipients: ["dax", "nova"], parentId: source.id });
    const text = block("dax").text;
    expect(text).toContain("Learned for this team:\n- Sign off with the first name only");
    expect(text.indexOf("Keep replies short")).toBeLessThan(text.indexOf("Learned for this team"));
    expect(block("nova").text).toContain("Learned for this team");
    expect(block("echo").text).toBe("");
    // a customer-facing turn gets the bot's own lessons only: no team block, no owner wording (T1-19)
    const channel = block("dax", false).text;
    expect(channel).toContain("Keep replies brief.");
    expect(channel).not.toContain("Keep replies short"); // the typed note stays in the owner's chats
    expect(channel).not.toContain("Learned for this team");
    expect(channel).not.toContain("Sign off");
    expect(channel).not.toContain("owner");
  });

  it("Undo on the source takes the team lesson away; an own lesson wins over a conflicting team one", () => {
    teach("dax", "No emojis in client emails", { kind: "tone" });
    const source = teach("chief", "Use emojis in client emails", { kind: "tone" });
    applyLessonShare(db, { botId: "chief", lessonId: suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: "team", now: clock++ }).id, now: clock++ });
    expect(block("dax").text).not.toContain("Use emojis");
    expect(lessonConflicts(db, "dax")[0]).toMatchObject({ via: "team", fromBotId: "chief" });
    expect(block("nova").text).toContain("Use emojis in client emails");
    changeLearningEvent(db, source.learningEventId!, "undo", clock++);
    expect(block("nova").text).toBe("");
  });

  it("team lessons are counted in the block ids the turn pins", () => {
    const source = teach("chief", "Sign off with the first name only");
    applyLessonShare(db, { botId: "chief", lessonId: suggestLessonShare(db, { botId: "chief", lessonId: source.id, recipients: "team", now: clock++ }).id, now: clock++ });
    expect(block("dax").lessonIds).toContain(listLessons(db, "chief", { states: ["active"] }).find(lesson => lesson.scope === "team")!.id);
  });
});
