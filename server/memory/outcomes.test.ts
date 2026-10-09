// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { MEMORY_SCHEMA } from "./schema.ts";
import {
  PROPOSAL_TTL_MS, WEAK_SIGNAL_TTL_MS, OWNER_EDIT_SURFACES,
  answerProposal, captureApprovalDecision, captureOwnerEdit, changeOutcome, detectOwnerEditedDraft, detectReask, diffOwnerEdit,
  expireOutcomes, listOutcomes, markOutcome, messageRevision, observeOwnerMessage, outcomeCounts, proposeOutcomeFromAgent,
  recordStopForThread, recordWeakSignal, signalClass,
} from "./outcomes.ts";

let db: DatabaseSync;
const NOW = 1_800_000_000_000;
const learning = (enabled = true) => ({ id: "bot", learning: { enabled, askFirst: false, prospectLearning: false, revision: 0 } });
function addMessage(id: string, role: "bot" | "user", text = "x", threadId = "t1", at = NOW) {
  db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run(threadId, id, at, role, "text", text, JSON.stringify({ id, role, kind: "text", text, at }));
}
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(MEMORY_SCHEMA);
  db.prepare("INSERT INTO memory_meta(id,schema_version,installation_id,mode) VALUES(1,7,?,'active')").run(randomUUID());
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  addMessage("m1", "bot");
  addMessage("u1", "user", "how do we close the Acme deal", "t1", NOW - 10);
});
const feedback = () => db.prepare("SELECT * FROM memory_feedback ORDER BY created_at,id").all() as any[];

it("marks a bot message with one tap: strong, owner-confirmed, no reason or value needed", () => {
  const outcome = markOutcome(db, { botId: "bot", threadId: "t1", messageId: "m1", kind: "won", now: NOW });
  expect(outcome).toMatchObject({ kind: "won", state: "confirmed", messageId: "m1", proposedBy: "owner", confirmedBy: "owner", reason: null, value: null, revision: 1 });
  expect(db.prepare("SELECT confirmed_by,proposed_by FROM memory_outcomes").get()).toMatchObject({ confirmed_by: "owner", proposed_by: "owner" });
});
it("takes an optional value, currency and reason after the tap, and keeps the first row as history", () => {
  const first = markOutcome(db, { botId: "bot", threadId: "t1", messageId: "m1", kind: "won", now: NOW });
  const second = changeOutcome(db, { botId: "bot", id: first.id, change: { value: 4200, currency: "usd", reason: "Signed after the follow-up" }, now: NOW + 1 });
  expect(second).toMatchObject({ kind: "won", value: 4200, currency: "USD", reason: "Signed after the follow-up", revision: 2 });
  expect(listOutcomes(db, { botId: "bot", now: NOW + 2 }).map(row => row.id)).toEqual([second.id]);
  expect(db.prepare("SELECT superseded_by FROM memory_outcomes WHERE id=?").get(first.id)?.superseded_by).toBe(second.id);
});
it("marking the same thing again is a no-op; a different kind supersedes", () => {
  const a = markOutcome(db, { botId: "bot", threadId: "t1", messageId: "m1", kind: "lost", now: NOW });
  expect(markOutcome(db, { botId: "bot", threadId: "t1", messageId: "m1", kind: "lost", now: NOW + 1 }).id).toBe(a.id);
  const b = markOutcome(db, { botId: "bot", threadId: "t1", messageId: "m1", kind: "won", now: NOW + 2 });
  expect(b.id).not.toBe(a.id);
  expect(outcomeCounts(db, "bot")).toMatchObject({ won: 1, lost: 0 });
});
it("an undone mark can be made again", () => {
  const a = markOutcome(db, { botId: "bot", threadId: "t1", messageId: "m1", kind: "good", now: NOW });
  expect(changeOutcome(db, { botId: "bot", id: a.id, change: { revoke: true }, now: NOW + 1 }).state).toBe("revoked");
  expect(listOutcomes(db, { botId: "bot", now: NOW + 2 })).toEqual([]);
  expect(markOutcome(db, { botId: "bot", threadId: "t1", messageId: "m1", kind: "bad", now: NOW + 3 }).kind).toBe("bad");
});
it("refuses a message that is not this bot's reply, a bad kind, and bad details", () => {
  expect(() => markOutcome(db, { botId: "bot", threadId: "t1", messageId: "u1", kind: "won", now: NOW })).toThrow(/reply/);
  expect(() => markOutcome(db, { botId: "bot", threadId: "t1", messageId: "none", kind: "won", now: NOW })).toThrow(/message/);
  expect(() => markOutcome(db, { botId: "bot", threadId: "t1", messageId: "m1", kind: "open" as any, now: NOW })).toThrow(/kind/);
  expect(() => markOutcome(db, { botId: "bot", threadId: "t1", messageId: "m1", kind: "won", value: -3, now: NOW })).toThrow(/value/);
  expect(() => markOutcome(db, { botId: "bot", threadId: "t1", messageId: "m1", kind: "won", value: 5, currency: "dollars", now: NOW })).toThrow(/currency/);
  expect(() => markOutcome(db, { botId: "bot", threadId: "t1", messageId: "m1", kind: "won", reason: "x".repeat(281), now: NOW })).toThrow(/280/);
});
it("redacts a secret typed into a reason", () => {
  const fake = ["sk-ant", "api03", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-"); // secret-scan: fixture
  const outcome = markOutcome(db, { botId: "bot", threadId: "t1", messageId: "m1", kind: "won", reason: `paid, key ${fake}`, now: NOW });
  expect(outcome.reason).not.toContain("abcdefghijklmnopqrstuvwxyz");
});
it("message revisions count every row for that message", () => {
  expect(messageRevision(db, "bot", "m1")).toBe(0);
  const a = markOutcome(db, { botId: "bot", threadId: "t1", messageId: "m1", kind: "won", now: NOW });
  expect(messageRevision(db, "bot", "m1")).toBe(1);
  changeOutcome(db, { botId: "bot", id: a.id, change: { reason: "ok" }, now: NOW + 1 });
  expect(messageRevision(db, "bot", "m1")).toBe(2);
});

it("the agent can only propose: nothing counts until the owner answers", () => {
  const proposed = proposeOutcomeFromAgent(db, { botId: "bot", threadId: "t1", note: "They said they will sign Friday", now: NOW });
  expect(proposed.status).toBe(200);
  const view = (proposed.body as any).outcome;
  expect(view).toMatchObject({ state: "proposed", proposedBy: "bot", confirmedBy: null, note: "They said they will sign Friday", messageId: "u1" });
  expect(outcomeCounts(db, "bot")).toMatchObject({ won: 0, lost: 0, proposed: 1 });
  const answered = answerProposal(db, { botId: "bot", id: view.id, answer: "won", now: NOW + 5 });
  expect(answered).toMatchObject({ state: "confirmed", kind: "won", proposedBy: "bot", confirmedBy: "owner" });
  expect(outcomeCounts(db, "bot")).toMatchObject({ won: 1, proposed: 0 });
});
it("one open proposal per thread, and the same question is never asked twice", () => {
  const a = (proposeOutcomeFromAgent(db, { botId: "bot", threadId: "t1", note: "closed?", now: NOW }).body as any).outcome;
  const b = (proposeOutcomeFromAgent(db, { botId: "bot", threadId: "t1", note: "closed again?", now: NOW + 1 }).body as any);
  expect(b.outcome.id).toBe(a.id);
  expect(b.created).toBe(false);
  answerProposal(db, { botId: "bot", id: a.id, answer: "not-yet", now: NOW + 2 });
  const c = (proposeOutcomeFromAgent(db, { botId: "bot", threadId: "t1", note: "closed?", now: NOW + 3 }).body as any);
  expect(c.created).toBe(false);
  expect(c.outcome.state).toBe("dismissed");
  expect(outcomeCounts(db, "bot")).toMatchObject({ won: 0, lost: 0, proposed: 0 });
});
it("after Not yet the bot does not ask again about that conversation for 7 days, even after new messages (T1-23)", () => {
  const a = (proposeOutcomeFromAgent(db, { botId: "bot", threadId: "t1", note: "closed?", now: NOW }).body as any).outcome;
  answerProposal(db, { botId: "bot", id: a.id, answer: "not-yet", now: NOW + 2 });
  addMessage("u2", "user", "any news on Acme?", "t1", NOW + 1000);
  const again = proposeOutcomeFromAgent(db, { botId: "bot", threadId: "t1", note: "closed now?", now: NOW + 3000 });
  expect(again.status).toBe(429);
  expect((again.body as any).code).toBe("ASKED_RECENTLY");
  expect(db.prepare("SELECT COUNT(*) n FROM memory_outcomes").get()?.n).toBe(1);
  // another conversation is unaffected
  addMessage("w1", "user", "how is Globex", "t2", NOW + 10);
  expect(proposeOutcomeFromAgent(db, { botId: "bot", threadId: "t2", note: "n", now: NOW + 4000 }).status).toBe(200);
  // after the week it may ask once more
  const later = NOW + 8 * 24 * 3600_000;
  addMessage("u3", "user", "Acme update", "t1", later - 10);
  expect(proposeOutcomeFromAgent(db, { botId: "bot", threadId: "t1", note: "closed now?", now: later }).status).toBe(200);
});
it("asks at most once a day per conversation", () => {
  const a = (proposeOutcomeFromAgent(db, { botId: "bot", threadId: "t1", note: "n", now: NOW }).body as any).outcome;
  db.prepare("UPDATE memory_outcomes SET confirmed_by='owner',kind='lost' WHERE id=?").run(a.id);
  addMessage("u2", "user", "next topic", "t1", NOW + 10);
  expect(proposeOutcomeFromAgent(db, { botId: "bot", threadId: "t1", note: "n2", now: NOW + 20 }).status).toBe(429);
});
it("Not yet records no outcome; an answer after expiry is refused", () => {
  const a = (proposeOutcomeFromAgent(db, { botId: "bot", threadId: "t1", note: "n", now: NOW }).body as any).outcome;
  expect(() => answerProposal(db, { botId: "bot", id: a.id, answer: "won", now: NOW + PROPOSAL_TTL_MS + 1 })).toThrow(/expired/);
  expect(db.prepare("SELECT kind,confirmed_by FROM memory_outcomes").get()).toMatchObject({ kind: "open", confirmed_by: null });
});
it("expiry retires old proposals and old weak signals, and nothing else", () => {
  markOutcome(db, { botId: "bot", threadId: "t1", messageId: "m1", kind: "won", now: NOW });
  proposeOutcomeFromAgent(db, { botId: "bot", threadId: "t1", note: "n", now: NOW });
  recordWeakSignal(db, { botId: "bot", threadId: "t1", action: "reask", targetMessageId: "m1", now: NOW }, learning());
  captureApprovalDecision(db, { botId: "bot", threadId: "t1", requestId: "r1", tool: "Bash", approved: true, now: NOW }, learning());
  expireOutcomes(db, NOW + PROPOSAL_TTL_MS + 1);
  expect(db.prepare("SELECT reason FROM memory_outcomes WHERE kind='open'").get()?.reason).toBe("expired");
  expect(db.prepare("SELECT state FROM memory_feedback WHERE target_action='reask'").get()?.state).toBe("detected");
  expireOutcomes(db, NOW + WEAK_SIGNAL_TTL_MS + 1);
  expect(db.prepare("SELECT state FROM memory_feedback WHERE target_action='reask'").get()?.state).toBe("expired");
  expect(db.prepare("SELECT state FROM memory_feedback WHERE target_action LIKE 'approval:%'").get()?.state).toBe("detected");
  expect(outcomeCounts(db, "bot").won).toBe(1);
});

it("records an approval decision from the owner only once, permission-class unless a reason is added", () => {
  const record = (requestId: string, approved: boolean, reason?: string) => captureApprovalDecision(db, { botId: "bot", threadId: "t1", requestId, tool: "Bash", approved, reason, now: NOW }, learning());
  expect(record("r1", true)).toBe(true);
  expect(record("r1", true)).toBe(false);
  record("r2", false, "Never email the client before I read it");
  const rows = feedback();
  expect(rows).toHaveLength(2);
  expect(rows.map(row => [row.polarity, row.strength, signalClass(row)])).toEqual([["+", 1, "permission"], ["-", 2, "quality"]]);
  expect(rows[1].correction).toBe("Never email the client before I read it");
});
it("passive signals are not kept when learning is off for the bot, memory is off, or the thread is excluded", () => {
  expect(captureApprovalDecision(db, { botId: "bot", threadId: "t1", requestId: "r1", tool: "Bash", approved: true, now: NOW }, learning(false))).toBe(false);
  expect(captureApprovalDecision(db, { botId: "bot", threadId: "t1", requestId: "r1", tool: "Bash", approved: true, now: NOW }, null)).toBe(false);
  db.exec("UPDATE memory_meta SET mode='off'");
  expect(captureApprovalDecision(db, { botId: "bot", threadId: "t1", requestId: "r2", tool: "Bash", approved: true, now: NOW }, learning())).toBe(false);
  expect(feedback()).toEqual([]);
});
it("weak signals are weak negatives that never form a lesson alone", () => {
  recordWeakSignal(db, { botId: "bot", threadId: "t1", action: "stop", targetMessageId: "m1", now: NOW }, learning());
  recordWeakSignal(db, { botId: "bot", threadId: "t1", action: "rewind", now: NOW }, learning());
  recordWeakSignal(db, { botId: "bot", threadId: "t1", action: "stop", targetMessageId: "m1", now: NOW }, learning());
  const rows = feedback();
  expect(rows).toHaveLength(2);
  for (const row of rows) expect(row).toMatchObject({ polarity: "-", strength: 1, state: "detected" });
  expect(rows.map(signalClass)).toEqual(["weak", "weak"]);
});

it("spots a re-ask within three turns and ignores a new question", () => {
  const prior = ["please send the Acme proposal to Dana today", "thanks, what else is on my list"];
  expect(detectReask("can you send the Acme proposal to Dana today please", prior)).toBe(0);
  expect(detectReask("what is the weather in Austin tomorrow morning", prior)).toBe(-1);
  expect(detectReask("ok", ["ok"])).toBe(-1);
});
it("diffs an owner edit by words", () => {
  const diff = diffOwnerEdit("Hi Dana, hope you are well. We would love to schedule a quick call this week to go over the proposal.", "Hi Dana, hope you are well. Can we talk this week about the proposal?");
  expect(diff.similarity).toBeGreaterThan(0.4);
  expect(diff.similarity).toBeLessThan(0.95);
  expect(diff.removed.length).toBeGreaterThan(0);
  expect(diff.summary).toMatch(/removed \d+ words?, added \d+ words?/i);
  expect(diffOwnerEdit("same words here", "same words here").similarity).toBe(1);
});
it("captures an owner edit of a bot draft as a clear signal, and skips a no-change or unrelated text", () => {
  const original = "Hi Dana, hope you are well. We would love to schedule a quick call this week to go over the proposal and next steps for your team.";
  const edited = "Hi Dana, hope you are well. Can we talk this week about the proposal and next steps for your team?";
  expect(captureOwnerEdit(db, { botId: "bot", threadId: "t1", surface: "pasted-draft", originalMessageId: "m1", editedMessageId: "u2", original, edited, now: NOW }, learning())).toBe(true);
  expect(captureOwnerEdit(db, { botId: "bot", threadId: "t1", surface: "pasted-draft", originalMessageId: "m1", editedMessageId: "u3", original, edited: original, now: NOW }, learning())).toBe(false);
  expect(captureOwnerEdit(db, { botId: "bot", threadId: "t1", surface: "pasted-draft", originalMessageId: "m1", editedMessageId: "u4", original, edited: "Totally different message about lunch plans for Friday afternoon at noon.", now: NOW }, learning())).toBe(false);
  const rows = feedback();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ polarity: "-", target_message_id: "m1", target_action: "edit:pasted-draft", correction: edited });
  expect(signalClass(rows[0])).toBe("quality");
  expect(rows[0].strength).toBeGreaterThanOrEqual(2);
});
it("finds the bot draft an owner message was edited from", () => {
  const draft = "Hi Dana, hope you are well. We would love to schedule a quick call this week to go over the proposal and next steps for your team.";
  expect(detectOwnerEditedDraft("Hi Dana, hope you are well. Can we talk this week about the proposal and next steps for your team?", [{ id: "m9", text: "short" }, { id: "m1", text: draft }])?.id).toBe("m1");
  expect(detectOwnerEditedDraft("thanks", [{ id: "m1", text: draft }])).toBeNull();
});
it("lists the edit surfaces it inventoried, with the reason for each one not wired", () => {
  expect(OWNER_EDIT_SURFACES.find(surface => surface.id === "pasted-draft")?.wired).toBe(true);
  for (const surface of OWNER_EDIT_SURFACES.filter(item => !item.wired)) expect(surface.why.length).toBeGreaterThan(20);
});
it("watches an owner's new message for a re-ask and a pasted draft", () => {
  const history = [
    { id: "u1", role: "user", kind: "text", text: "please send the Acme proposal to Dana today" },
    { id: "m1", role: "bot", kind: "text", text: "Hi Dana, hope you are well. We would love to schedule a quick call this week to go over the proposal and next steps for your team.", turnTerminal: true },
  ] as any;
  observeOwnerMessage(db, learning(), "t1", { id: "u2", role: "user", kind: "text", text: "can you send the Acme proposal to Dana today please", at: NOW } as any, history, NOW);
  expect(feedback().map(row => row.target_action)).toEqual(["reask"]);
  observeOwnerMessage(db, learning(), "t1", { id: "u3", role: "user", kind: "text", text: "Hi Dana, hope you are well. Can we talk this week about the proposal and next steps for your team?", at: NOW + 1 } as any, history, NOW + 1);
  expect(feedback().map(row => row.target_action).sort()).toEqual(["edit:pasted-draft", "reask"]);
  // a customer or a routine is not the owner
  observeOwnerMessage(db, learning(), "t1", { id: "u4", role: "user", kind: "text", text: "please send the Acme proposal to Dana today", automation: { kind: "schedule" }, at: NOW + 2 } as any, history, NOW + 2);
  expect(feedback()).toHaveLength(2);
});
it("pressing Stop is a weak negative aimed at what the owner last asked, once", () => {
  expect(recordStopForThread(db, learning(), "t1", NOW)).toBe(true);
  expect(recordStopForThread(db, learning(), "t1", NOW + 5)).toBe(false);
  expect(feedback()[0]).toMatchObject({ target_action: "stop", target_message_id: "u1", strength: 1 });
  expect(recordStopForThread(db, null, "t1", NOW)).toBe(false);
});
