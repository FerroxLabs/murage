// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { captureSource } from "./capture.ts";
import { admitLessonText, isOutcomeEvidence, contextLineFor } from "./learnable.ts";
import { classifyPastedText, redactLearningText, repeatsProspectText, structuralLine } from "./prospect-text.ts";
import { ensureLearningLocalDir, learningLocalPath } from "../bot-learning.ts";
import { classifyDataDirEntry, DATA_DIR_RESTORABLE } from "../data-dir-inventory.ts";

const SECRET = "the Harborview contract needs a forty percent discount before Friday";
const roster = { bots: [{ id: "dax", threadId: "t" }], groups: [] };
const off = { id: "dax" };
const on = { id: "dax", learning: { enabled: true, askFirst: false, prospectLearning: true, revision: 1 } };
const scope = { threadIds: ["t"] };
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
function add(id: string, speaker: string, text: string, thread = "t", kind = "attended") {
  const db = database(); db.exec("UPDATE memory_meta SET mode='active'");
  captureSource(db, { id, threadId: thread, kind: "text", speaker, outcome: "recorded", text, origin: { kind } });
  db.exec("UPDATE memory_jobs SET status='complete',cursor=3");
  return { id, revision: 1 };
}

describe("pasted-quote classification", () => {
  it("splits quote markers, forwards and From: blocks from the owner's own words", () => {
    expect(classifyPastedText("They said no.\n> we cannot pay that\n> not this quarter\nI disagree.")).toEqual([
      { text: "They said no.", party: "owner" }, { text: "> we cannot pay that\n> not this quarter", party: "third-party" }, { text: "I disagree.", party: "owner" }]);
    const fwd = classifyPastedText("Reply kindly to this\n---------- Forwarded message ---------\nFrom: Pat <pat@x.com>\nI want 40% off");
    expect(fwd.map(s => s.party)).toEqual(["owner", "third-party"]);
    const hdr = classifyPastedText("see below\nFrom: Pat <pat@x.com>\nSent: Monday\nSubject: price\nthe body of it");
    expect(hdr.map(s => s.party)).toEqual(["owner", "third-party"]);
    expect(classifyPastedText("On Mon, Jan 5, 2026 at 9:00 AM Pat wrote:\n> hi").every(s => s.party === "third-party")).toBe(true);
    expect(classifyPastedText("Be shorter. From now on skip the greeting.")).toEqual([{ text: "Be shorter. From now on skip the greeting.", party: "owner" }]);
  });
  it("redacts contact details and secrets", () => {
    const out = redactLearningText("mail pat@x.com or +1 (512) 555-0134, see https://x.com/a?b=1 key sk-abcdefghijklmnop1234 card 4111 1111 1111 1111");
    expect(out).not.toMatch(/pat@x|555|https|sk-abc|4111/);
    expect(out).toContain("[email]");
  });
  it("makes a structural line without any of the words", () => {
    const line = structuralLine("Hi, I'm Pat at Harborview. How much for 40 seats?");
    expect(line).toBe("[customer: 2 sentences, asks about price]");
    expect(line).not.toMatch(/Pat|Harborview|40/);
  });
});

describe("isOutcomeEvidence", () => {
  it("admits owner words and bot words, redacted", () => {
    const o = add("o", "owner", "Keep it short, mail me at me@x.com");
    expect(isOutcomeEvidence(database(), o, off, { roster })).toEqual({ admit: true, words: "owner", text: "Keep it short, mail me at [email]", thirdPartyWords: "none" });
    const b = add("b", "dax", "Here is the quote");
    expect(isOutcomeEvidence(database(), b, off, { roster })).toMatchObject({ admit: true, words: "bot" });
  });
  it("refuses when the bot's Learning is off, the source is tombstoned or stale, or the thread is excluded", () => {
    const o = add("o", "owner", "keep it short");
    expect(isOutcomeEvidence(database(), o, { id: "dax", learning: { enabled: false } }, { roster })).toEqual({ admit: false, reason: "learning-off" });
    expect(isOutcomeEvidence(database(), { id: "o", revision: 2 }, off, { roster })).toEqual({ admit: false, reason: "not-active" });
    database().prepare("INSERT INTO memory_tombstones VALUES('x','source','o',NULL,NULL,1,'owner-forget',1)").run();
    expect(isOutcomeEvidence(database(), o, off, { roster })).toEqual({ admit: false, reason: "tombstoned" });
  });
  it("refuses another bot's thread", () => {
    const o = add("o", "owner", "keep it short");
    expect(isOutcomeEvidence(database(), o, { id: "other" }, { roster })).toEqual({ admit: false, reason: "not-this-bot" });
  });
  it("with prospect learning off, a prospect message is refused and its words never come back", () => {
    const p = add("p", "person:pat", SECRET);
    const r = isOutcomeEvidence(database(), p, off, { roster, prospectScope: scope });
    expect(r).toEqual({ admit: false, reason: "prospect-learning-off" });
    expect(JSON.stringify(r)).not.toContain("Harborview");
    expect(contextLineFor(r, SECRET)).not.toContain("Harborview");
    expect(contextLineFor(r, SECRET)).toMatch(/^\[customer: /);
  });
  it("with it off, a pasted quote inside an owner message is replaced by a structural line", () => {
    const o = add("o", "owner", `Answer this better\n> ${SECRET}\n> how much is it?`);
    const r = isOutcomeEvidence(database(), o, off, { roster, prospectScope: scope });
    expect(r).toMatchObject({ admit: true, words: "owner", thirdPartyWords: "replaced" });
    expect((r as { text: string }).text).toContain("Answer this better");
    expect((r as { text: string }).text).not.toMatch(/Harborview|forty percent/);
  });
  it("with it on, prospect words are admitted only for threads in the selected scope", () => {
    const p = add("p", "person:pat", SECRET);
    expect(isOutcomeEvidence(database(), p, on, { roster })).toEqual({ admit: false, reason: "thread-not-in-prospect-scope" });
    expect(isOutcomeEvidence(database(), p, on, { roster, prospectScope: { threadIds: ["elsewhere"] } })).toEqual({ admit: false, reason: "thread-not-in-prospect-scope" });
    expect(isOutcomeEvidence(database(), p, on, { roster, prospectScope: scope })).toMatchObject({ admit: true, words: "prospect" });
    const q = add("q", "owner", `fix this\n> ${SECRET}`);
    expect(isOutcomeEvidence(database(), q, on, { roster, prospectScope: scope })).toMatchObject({ words: "prospect", thirdPartyWords: "admitted" });
    expect(isOutcomeEvidence(database(), q, on, { roster })).toMatchObject({ thirdPartyWords: "replaced" });
  });
  it("prospect words from automation origins stay out even with the opt-in on", () => {
    const p = add("p", "person:pat", SECRET, "t", "webhook");
    expect(isOutcomeEvidence(database(), p, on, { roster, prospectScope: scope })).toEqual({ admit: false, reason: "origin-webhook" });
  });
  it("tool results are never evidence here", () => {
    const t = add("t1", "tool", "ls output");
    expect(isOutcomeEvidence(database(), t, off, { roster })).toEqual({ admit: false, reason: "tool-results-nightly-only" });
  });
});

describe("prospect text cannot reach a lesson", () => {
  it("refuses a lesson that repeats prospect wording when the opt-in is off", () => {
    expect(admitLessonText(off, "Always mention that the Harborview contract needs a forty percent discount", [SECRET])).toEqual({ ok: false, reason: "prospect-text" });
    expect(repeatsProspectText("be warmer when they ask about price", [SECRET])).toBe(false);
    expect(admitLessonText(off, "Be warmer when they ask about price", [SECRET])).toMatchObject({ ok: true, prospectDerived: false, destination: "messages-db", mustSuggest: false });
  });
  it("with the opt-in on, prospect-derived text is a suggestion kept under learning-local, never messages.db", () => {
    expect(admitLessonText(on, "Say the Harborview contract needs a forty percent discount", [SECRET])).toMatchObject({ ok: true, prospectDerived: true, destination: "learning-local", mustSuggest: true });
  });
  it("redacts contact details out of any lesson", () => {
    expect(admitLessonText(off, "Cc ops@x.com on quotes", [])).toMatchObject({ ok: true, text: "Cc [email] on quotes" });
  });
});

describe("end to end: opt-in off keeps prospect text out of every learning surface and backup", () => {
  it("leaves no prospect wording in the learning tables, learning-local or the restorable data folder entries", () => {
    const dir = ensureLearningLocalDir(DATA_DIR);
    const p = add("p", "person:pat", SECRET);
    const o = add("o", "owner", `shorter please\n> ${SECRET}`);
    const db = database();
    const kept: string[] = [];
    for (const s of [p, o]) { const r = isOutcomeEvidence(db, s, off, { roster, prospectScope: scope }); if (r.admit) kept.push(r.text); }
    const lesson = admitLessonText(off, "Quote the Harborview contract needs a forty percent discount", [SECRET]);
    expect(lesson.ok).toBe(false);
    // What a batch would store is only what the gates returned.
    db.prepare("INSERT INTO memory_feedback(id,bot_id,polarity,strength,correction,state,scope,created_at) VALUES('f','dax','-',2,?,'detected','bot',1)").run(kept[0]);
    for (const table of ["memory_outcomes", "memory_feedback", "memory_lessons", "memory_episodes", "memory_learning_runs"]) {
      expect(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).not.toMatch(/Harborview|forty percent/);
    }
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
    for (const f of walk(dir)) expect(readFileSync(f, "utf8")).not.toMatch(/Harborview/);
    expect(classifyDataDirEntry("learning-local")).toMatchObject({ backup: "excluded" });
    expect(DATA_DIR_RESTORABLE).not.toContain("learning-local");
    expect(existsSync(learningLocalPath(DATA_DIR))).toBe(true);
    writeFileSync(learningLocalPath(DATA_DIR, "keep.txt"), "x");
  });
});
