// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Learning screen's decisions and requests (design section 16).
import { describe, expect, it, vi } from "vitest";

import type { LearningEvent } from "./memory-learning";
import {
  KEEP_WINDOW_MS, MIN_OUTCOMES_FOR_CHECK, addLesson, answerFeedback, applySuggestion, canCheck, editLesson, editMemoryBody, editSuggestion, fetchLearning,
  fetchLessons, forgetBody, keepDeadline, keepLesson, lessonFrom, lessonRows, lessonSource, conflictLine, sharePicked, marksLine, memoryEntries, monthWithUndone, needMoreLine, newKey, notNowSuggestion,
  outcomesStillNeeded, patchLearning, plainError, recentChanges, restoreOriginal, seeAllLabel, shownRows, startRun, suggestionEditMax, suggestionLine, suggestionWhy, undoLesson, unsureText, usageLine,
  type Lesson,
} from "./learning-screen";

const NOW = 1_700_000_000_000;
const lesson = (over: Partial<Lesson> = {}): Lesson => ({ id: "l1", version: 3, kind: "lesson", text: "Keep emails short", origin: "typed", state: "active", createdAt: NOW - 1000, learningEventId: "ev1", ...over });
const event = (over: Partial<LearningEvent> = {}): LearningEvent => ({
  id: "e1", kind: "activated", record_id: "r1", record_version: 2, created_at: NOW, undone_at: null, kept_at: null,
  record: { id: "r1", version: 2, state: "active", text: "The board meets on the first Tuesday" }, scopeLabel: "", source: null, ...over,
});
const calls = () => { const fn = vi.fn(async (_path: string, _init?: RequestInit) => ({})); return fn; };
const body = (fn: ReturnType<typeof calls>, i = 0) => JSON.parse(String(fn.mock.calls[i][1]?.body));
const headers = (fn: ReturnType<typeof calls>, i = 0) => (fn.mock.calls[i][1]?.headers ?? {}) as Record<string, string>;

describe("the Results line", () => {
  it("lists only the kinds that were marked, bad included", () => {
    expect(marksLine({ won: 3, lost: 2, good: 7, bad: 0, proposed: 4 })).toBe("12 marked: 3 won, 2 lost, 7 good.");
    expect(marksLine({ won: 0, lost: 0, good: 1, bad: 2, proposed: 0 })).toBe("3 marked: 1 good, 2 bad.");
    expect(marksLine({ won: 0, lost: 0, good: 0, bad: 0, proposed: 5 })).toBeNull();
  });
  it("says how many more outcomes are needed below the minimum, and nothing at or above it", () => {
    expect(MIN_OUTCOMES_FOR_CHECK).toBe(3);
    expect(needMoreLine({ won: 0, lost: 0, good: 0, bad: 0, proposed: 0 })).toBe("Not enough examples yet. Confirm 3 more outcomes.");
    expect(needMoreLine({ won: 1, lost: 0, good: 1, bad: 0, proposed: 0 })).toBe("Not enough examples yet. Confirm 1 more outcome.");
    expect(outcomesStillNeeded({ won: 1, lost: 1, good: 0, bad: 0, proposed: 0 })).toBe(1);
    expect(needMoreLine({ won: 1, lost: 1, good: 1, bad: 0, proposed: 0 })).toBeNull();
  });
  it("shows Check for improvements only when the server says ready", () => {
    const state = (ready: boolean) => ({ readiness: { ready, outcomes: 9, examples: 9 } });
    expect(canCheck(state(true))).toBe(true);
    expect(canCheck(state(false))).toBe(false);
    expect(canCheck(null)).toBe(false);
  });
});

describe("which lessons show", () => {
  it("shows active lessons newest first and hides every other state", () => {
    const rows = lessonRows([lesson({ id: "a", createdAt: 1 }), lesson({ id: "b", createdAt: 5 }), lesson({ id: "c", state: "suggested" }), lesson({ id: "d", state: "stale" }), lesson({ id: "e", state: "unsupported" }), lesson({ id: "f", state: "undone" })], {}, NOW);
    expect(rows.map(row => row.lesson.id)).toEqual(["b", "a"]);
  });
  it("keeps an undone lesson for the Keep window only", () => {
    const undone = lesson({ id: "u", state: "undone" });
    const local = { u: { lesson: undone, until: NOW + KEEP_WINDOW_MS } };
    expect(lessonRows([undone], local, NOW)[0]).toMatchObject({ undone: true, keepUntil: NOW + KEEP_WINDOW_MS });
    expect(lessonRows([undone], local, NOW + KEEP_WINDOW_MS + 1)).toEqual([]);
    expect(lessonRows([], local, NOW)).toHaveLength(1); // the list may already omit it
  });
  it("a kept lesson is an ordinary row again", () => {
    const row = lessonRows([lesson({ id: "u" })], { u: { lesson: lesson({ id: "u" }), until: NOW + 5 } }, NOW)[0];
    expect(row.undone).toBe(false);
  });
  it("shows 5, then all after Show more", () => {
    const many = Array.from({ length: 8 }, (_, i) => i);
    expect(shownRows(many, false)).toHaveLength(5);
    expect(shownRows(many, true)).toHaveLength(8);
  });
  it("the Keep deadline never runs past the window", () => {
    expect(keepDeadline({ keepUntil: NOW + 10_000 }, NOW)).toBe(NOW + 10_000);
    expect(keepDeadline({ keepUntil: NOW + 999_999 }, NOW)).toBe(NOW + KEEP_WINDOW_MS);
    expect(keepDeadline({}, NOW)).toBe(NOW + KEEP_WINDOW_MS);
  });
  it("says where a lesson came from", () => {
    expect(lessonFrom("typed", NOW, NOW)).toBe("From Tell it something, today");
    expect(lessonFrom("feedback", NOW, NOW)).toBe("From your chat, today");
    expect(lessonFrom("edit", NOW, NOW)).toBe("From your edit, today");
    expect(lessonFrom("mark", NOW, NOW)).toBe("From your mark, today");
  });
});

describe("suggestions and unsure rows", () => {
  it("explains why a suggestion was made, and marks customer messages", () => {
    expect(suggestionWhy({ origin: "feedback", prospectDerived: false })).toBe("You said something in a chat.");
    expect(suggestionWhy({ origin: "edit", prospectDerived: false })).toBe("You edited a reply.");
    expect(suggestionWhy({ origin: "mark", prospectDerived: false })).toBe("You marked a reply.");
    expect(suggestionWhy({ origin: "feedback", prospectDerived: true })).toBe("From customer messages.");
  });
  it("words an unsure row as a question", () => {
    expect(unsureText({ text: "hmm ok" })).toBe('"hmm ok" Was that feedback?');
  });
});

describe("memory entries and the Forget / Edit choice", () => {
  it("keeps activated, not undone, active, with words, one per record, newest first", () => {
    const entries = memoryEntries([
      event({ id: "old", created_at: 1 }),
      event({ id: "new", created_at: 9 }),
      event({ id: "two", record_id: "r2", record: { id: "r2", version: 1, state: "active", text: "Q4 deadline is Nov 15" }, created_at: 5 }),
      event({ id: "undone", record_id: "r3", undone_at: 4, record: { id: "r3", version: 1, state: "active", text: "x" } }),
      event({ id: "arch", record_id: "r4", record: { id: "r4", version: 1, state: "archived", text: "y" } }),
      event({ id: "blank", record_id: "r5", record: { id: "r5", version: 1, state: "active", text: "  " } }),
      event({ id: "none", record_id: "r6", record: null }),
      event({ id: "sup", kind: "superseded", record_id: "r7", record: { id: "r7", version: 1, state: "active", text: "z" } }),
    ]);
    expect(entries.map(entry => entry.eventId)).toEqual(["new", "two"]);
  });
  it("Forget undoes the activation while the version still matches, else archives what is there", () => {
    expect(forgetBody({ eventId: "e1", recordId: "r1", recordVersion: 2, eventRecordVersion: 2 })).toEqual({ action: "learning-undo", eventId: "e1" });
    expect(forgetBody({ eventId: "e1", recordId: "r1", recordVersion: 3, eventRecordVersion: 2 })).toEqual({ action: "archive", id: "r1", version: 3 });
  });
  it("Edit corrects the current version", () => {
    expect(editMemoryBody({ recordId: "r1", recordVersion: 3 }, "new words")).toEqual({ action: "correct", id: "r1", version: 3, text: "new words" });
  });
  it("See all shows a number only when the page is everything", () => {
    expect(seeAllLabel(27, null)).toBe("See all 27 in Memory");
    expect(seeAllLabel(27, "cursor")).toBe("See all in Memory");
  });
});

describe("recent changes, counts and usage", () => {
  it("shows 10 newest with labels and the right words, Undo only on undoable kinds", () => {
    const events = Array.from({ length: 12 }, (_, i) => event({ id: `e${i}`, created_at: i }));
    events.push(event({ id: "lesson", kind: "lesson-learned", created_at: 99, record: null, lesson: { id: "l", version: 1, text: "Lead with the decision", kind: "lesson", state: "active", origin: "typed" } }));
    events.push(event({ id: "run", kind: "run-completed", created_at: 98 }));
    events.push(event({ id: "gone", created_at: 97, undone_at: 5 }));
    const rows = recentChanges(events, kind => `label:${kind}`);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toMatchObject({ id: "lesson", text: "Lead with the decision", canUndo: true, label: "label:lesson-learned" });
    expect(rows[1]).toMatchObject({ id: "run", canUndo: false });
    expect(rows[2]).toMatchObject({ id: "gone", canUndo: false, undone: true });
  });
  it("adds the undone count only when there is one", () => {
    expect(monthWithUndone("This month: learned 3, remembers 5", 0)).toBe("This month: learned 3, remembers 5");
    expect(monthWithUndone("This month: learned 3, remembers 5", 2)).toBe("This month: learned 3, remembers 5, 2 undone");
  });
  it("prints only the usage memory status reports", () => {
    expect(usageLine(null)).toBeNull();
    expect(usageLine({ mode: "active" })).toBeNull();
    const learning = { allowance: { day: "d", inputUsed: 1, outputUsed: 1, usedPercent: 12.4 } } as any;
    expect(usageLine({ mode: "active", learning })).toBe("Usage today: 12% of the learning allowance.");
  });
  it("shows the harness's plain refusal and a fixed line for anything else", () => {
    expect(plainError(Object.assign(new Error("That is too long. Keep it under 280 characters."), { status: 422 }))).toBe("That is too long. Keep it under 280 characters.");
    expect(plainError(Object.assign(new Error("Error: boom\n  at x.js:1"), { status: 500 }))).toBe("Could not save that. Try again.");
    expect(plainError(new Error("TypeError: x"))).toBe("Could not save that. Try again.");
  });
});

describe("requests carry an Idempotency-Key and the expected revision", () => {
  it("keys fit the server's rule", () => { expect(newKey()).toMatch(/^[A-Za-z0-9._:-]{8,128}$/); });
  it("reads settings with defaults filled in", async () => {
    const state = await fetchLearning(async () => ({ settings: { enabled: true, askFirst: false, prospectLearning: false, prospectThreadIds: ["t1"] }, revision: 4, readiness: { ready: false, outcomes: 1, examples: 0 } }), "b 1");
    expect(state).toMatchObject({ revision: 4, settings: { prospectThreadIds: ["t1"] } });
  });
  it("a toggle sends only that switch", async () => {
    const fn = calls();
    await patchLearning(fn, "b1", 4, { askFirst: true });
    expect(fn.mock.calls[0][0]).toBe("/api/bots/b1/learning");
    expect(fn.mock.calls[0][1]?.method).toBe("PATCH");
    expect(body(fn)).toEqual({ expectedRevision: 4, askFirst: true });
    expect(headers(fn)["Idempotency-Key"]).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
  });
  it("turning customer learning on sends the chosen chats in the same PATCH", async () => {
    const fn = calls();
    await patchLearning(fn, "b1", 4, { prospectLearning: true, prospectThreadIds: ["t1", "t2"] });
    expect(body(fn)).toEqual({ expectedRevision: 4, prospectLearning: true, prospectThreadIds: ["t1", "t2"] });
  });
  it("add uses the list revision; edit and undo use the lesson version", async () => {
    const fn = calls();
    await addLesson(fn, "b1", 7, "Keep client emails under 120 words");
    await editLesson(fn, "b1", { id: "l 1", version: 3 }, "x");
    await undoLesson(fn, "b1", { id: "l 1", version: 3 });
    expect(fn.mock.calls.map(call => [call[0], call[1]?.method])).toEqual([["/api/bots/b1/lessons", "POST"], ["/api/bots/b1/lessons/l%201", "PATCH"], ["/api/bots/b1/lessons/l%201", "DELETE"]]);
    expect(body(fn, 0)).toEqual({ expectedRevision: 7, text: "Keep client emails under 120 words" });
    expect(body(fn, 1)).toEqual({ expectedRevision: 3, text: "x" });
    expect(body(fn, 2)).toEqual({ expectedRevision: 3 });
    for (const i of [0, 1, 2]) expect(headers(fn, i)["Idempotency-Key"]).toBeTruthy();
  });
  it("Keep goes through the memory action with the lesson's event", async () => {
    const fn = calls();
    await keepLesson(fn, lesson());
    expect(fn.mock.calls[0][0]).toBe("/api/memory/action");
    expect(body(fn)).toEqual({ action: "learning-keep", eventId: "ev1" });
  });
  it("suggestion actions send the suggestion's version", async () => {
    const fn = calls();
    const s = { id: "s1", version: 2 };
    await applySuggestion(fn, "b1", s);
    await editSuggestion(fn, "b1", s, "better words");
    await notNowSuggestion(fn, "b1", s);
    expect(fn.mock.calls.map(call => call[0])).toEqual(["/api/bots/b1/learning/suggestions/s1/apply", "/api/bots/b1/learning/suggestions/s1/edit", "/api/bots/b1/learning/suggestions/s1/not-now"]);
    expect(body(fn, 0)).toEqual({ expectedRevision: 2 });
    expect(body(fn, 1)).toEqual({ expectedRevision: 2, text: "better words" });
    expect(body(fn, 2)).toEqual({ expectedRevision: 2 });
    for (const i of [0, 1, 2]) expect(headers(fn, i)["Idempotency-Key"]).toBeTruthy();
  });
  it("answers an unsure row with its revision", async () => {
    const fn = calls();
    await answerFeedback(fn, "b1", { id: "f1", revision: 5 }, "yes");
    expect(fn.mock.calls[0][0]).toBe("/api/bots/b1/feedback/f1");
    expect(body(fn)).toEqual({ expectedRevision: 5, answer: "yes" });
  });
  it("Check for improvements posts a run with revision 0", async () => {
    const fn = calls();
    await startRun(fn, "b1");
    expect(fn.mock.calls[0][0]).toBe("/api/bots/b1/learning/runs");
    expect(body(fn)).toEqual({ expectedRevision: 0 });
  });
  it("Restore undoes every active lesson one by one, then turns both options off", async () => {
    const fn = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/lessons") && !init) return { lessons: [lesson({ id: "a", version: 1 }), lesson({ id: "b", version: 2 }), lesson({ id: "c", state: "undone" })], revision: 1 };
      if (path.endsWith("/learning") && !init) return { settings: { enabled: true, askFirst: true, prospectLearning: true, prospectThreadIds: [] }, revision: 9, readiness: {} };
      return {};
    });
    expect(await restoreOriginal(fn, "b1")).toBe(2);
    const writes = fn.mock.calls.filter(call => call[1]);
    expect(writes.map(call => `${call[1]?.method} ${call[0]}`)).toEqual(["DELETE /api/bots/b1/lessons/a", "DELETE /api/bots/b1/lessons/b", "PATCH /api/bots/b1/learning"]);
    expect(JSON.parse(String(writes[2][1]?.body))).toEqual({ expectedRevision: 9, askFirst: false, prospectLearning: false });
  });
  it("lessons are read with the list revision", async () => {
    const out = await fetchLessons(async () => ({ lessons: [lesson()], revision: 12 }), "b1");
    expect(out.revision).toBe(12);
  });
});

describe("teams: shared lessons and conflicts (B11)", () => {
  it("names the bot a lesson came from, and the team", () => {
    expect(lessonSource(lesson({ sharedFrom: { id: "chief", name: "Sage" } }), NOW)).toBe("Shared from Sage, today");
    expect(lessonSource(lesson({ scope: "team", sharedFrom: { id: "chief", name: "Sage" } }), NOW)).toBe("For the team, from Sage, today");
    expect(lessonSource(lesson(), NOW)).toBe(lessonFrom("typed", NOW - 1000, NOW));
  });
  it("shows precedence on both rows of a conflict, and nothing without one", () => {
    expect(conflictLine(lesson({ conflict: { role: "wins", text: "Use emojis", fromName: "Sage" } }))).toBe("Yours wins over a shared lesson from Sage: Use emojis");
    expect(conflictLine(lesson({ conflict: { role: "loses", text: "No emojis", fromName: "Sage" } }))).toBe("Not used. Your own lesson takes priority: No emojis");
    expect(conflictLine(lesson())).toBeNull();
  });
  it("a share suggestion says who learned it and who it is offered to; Apply sends the owner's pick", async () => {
    const s = { origin: "suggested" as const, prospectDerived: false, scope: "bots" as const, fromName: "Sage", recipients: [{ id: "dax", name: "Dax" }, { id: "nova", name: "Nova" }] };
    expect(suggestionWhy(s)).toBe("Learned for Sage. Offered to Dax, Nova.");
    expect(suggestionWhy({ ...s, scope: "team" })).toBe("Learned for Sage. Offered to the whole team.");
    expect(sharePicked(s, ["nova"])).toEqual(["dax"]);
    const fn = calls();
    await applySuggestion(fn, "chief", { id: "s1", version: 1 }, sharePicked(s, ["nova"]));
    expect(body(fn)).toEqual({ expectedRevision: 1, recipients: ["dax"] });
    await applySuggestion(fn, "chief", { id: "s1", version: 1 });
    expect(body(fn, 1)).toEqual({ expectedRevision: 1 });
  });
});

describe("skill and routine changes (B7c)", () => {
  const change = (over: Partial<NonNullable<LearningEvent["procedure"]>> = {}) => ({ kind: "skill" as const, label: "Weekly brief", via: "automatic", state: "active", ...over });
  it("shows an automatic change under Recent changes with one-tap Undo, and an undone one without it", () => {
    const [auto, undone] = recentChanges([
      event({ id: "a", kind: "guide-applied", record: null, record_id: null, procedure: change(), created_at: NOW }),
      event({ id: "b", kind: "guide-applied", record: null, record_id: null, procedure: change({ kind: "routine", label: "Monday report", state: "undone" }), undone_at: NOW, created_at: NOW - 1 }),
    ], () => "x");
    expect(auto).toMatchObject({ id: "a", label: "Improved automatically", text: "Skill: Weekly brief", canUndo: true, undone: false });
    expect(undone).toMatchObject({ text: "Routine: Monday report", canUndo: false, undone: true });
  });
  it("lists a suggested change and a change the owner applied without Undo on the suggestion", () => {
    const [suggested, applied] = recentChanges([
      event({ id: "s", kind: "guide-suggested", record: null, record_id: null, procedure: change({ via: "suggestion", state: "suggested" }), created_at: NOW }),
      event({ id: "p", kind: "guide-applied", record: null, record_id: null, procedure: change({ via: "suggestion" }), created_at: NOW - 1 }),
    ], () => "x");
    expect(suggested).toMatchObject({ label: "Change suggested", canUndo: false });
    expect(applied).toMatchObject({ label: "Applied", canUndo: true });
  });
  const card = { id: "psug-1", version: 2, kind: "procedure" as const, targetKind: "routine" as const, label: "Monday report", text: "Verify first.", summary: "Verify first.", reasons: ["outbound" as const], origin: "suggested" as const, prospectDerived: false, edited: false, proposedHash: "h", createdAt: NOW };
  it("words a card, its reason and its edit limit", () => {
    expect(suggestionLine(card)).toBe('Improve the routine "Monday report": Verify first.');
    expect(suggestionWhy(card)).toBe("It sends or reaches other people, so it waits for you.");
    expect(suggestionWhy({ ...card, reasons: ["ask-first"] })).toBe("You asked to approve changes first.");
    expect(suggestionEditMax(card)).toBeGreaterThan(280);
  });
  it("Apply names the version and the exact words shown", async () => {
    const fn = calls(); await applySuggestion(fn, "bot1", card);
    expect(body(fn)).toMatchObject({ expectedRevision: 2, proposedHash: "h" });
    const lessonFn = calls(); await applySuggestion(lessonFn, "bot1", { id: "l1", version: 3 });
    expect(body(lessonFn)).toEqual({ expectedRevision: 3 });
  });
});
