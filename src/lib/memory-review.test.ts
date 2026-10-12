// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyInboxWaiting, applyWaitingFrame, applyWaitingSummary, batchSentence, cardTitle, dayLabel, errorSentence, getWaiting, headline, keepAllTargets, keepTogetherLine, reasonSentence,
  resetWaiting, restoreItems, subjectCount, takeExpandRequest, requestExpand, withoutItems, type ReviewItem,
} from "./memory-review";
import { modelSentence, plainOrFallback, workerSentence } from "./memory-words";

const NOW = Date.UTC(2026, 9, 14, 12);
const item = (n: number, over: Partial<ReviewItem> = {}): ReviewItem => ({ id: `id-${n}`, version: 1, text: `Reports go out on Mondays, note ${n}`, group: "everyday", rank: 2, reasons: [], origin: "owner-said", at: NOW - 86_400_000, later: false, scopeLabel: "x", ...over });

describe("the words", () => {
  it("says the card and the header the way the proposal does", () => {
    expect(cardTitle("Sable", 11)).toBe("Sable would like to remember 11 things");
    expect(cardTitle("Sable", 1)).toBe("Sable would like to remember 1 thing");
    expect(headline(11)).toBe("11 waiting for you");
    expect(headline(0)).toBe("Nothing waiting for you.");
    expect(keepTogetherLine(8, 11)).toBe("8 everyday things can be kept together. 3 need you one by one.");
    expect(keepTogetherLine(11, 11)).toBe("11 everyday things can be kept together.");
    expect(keepTogetherLine(0, 3)).toBe("Each of these needs you one by one.");
    expect(keepTogetherLine(0, 0)).toBe("");
  });

  it("says what a Keep all did", () => {
    const r = (status: "kept" | "changed" | "needs-you" | "gone", n: number) => Array.from({ length: n }, (_, i) => ({ id: `${status}${i}`, version: 1, status }));
    expect(batchSentence([...r("kept", 8)])).toBe("8 kept.");
    expect(batchSentence([...r("kept", 7), ...r("changed", 1)])).toBe("7 kept. 1 changed while you were looking, so it is still here.");
    expect(batchSentence([...r("kept", 6), ...r("changed", 2)])).toBe("6 kept. 2 changed while you were looking, so they are still here.");
    expect(batchSentence([...r("kept", 8), ...r("needs-you", 3)])).toBe("8 kept. 3 need you one by one.");
    expect(batchSentence([...r("needs-you", 3)])).toBe("Each of these needs you one by one.");
  });

  it("gives every reason a plain sentence, asks before origins", () => {
    const base = { reasons: [] as ReviewItem["reasons"], origin: "owner-said" as const, at: NOW - 86_400_000 };
    expect(reasonSentence(base, "Sable", NOW)).toMatch(/^You said this on \w+\.$/);
    expect(reasonSentence({ ...base, origin: "bot-worked-out" }, "Sable", NOW)).toMatch(/^Sable worked this out from \w+'s chat\.$/);
    expect(reasonSentence({ ...base, origin: "tool-result" }, "Sable", NOW)).toMatch(/^From a finished action on \w+\.$/);
    expect(reasonSentence({ ...base, reasons: ["sensitive-person"] }, "Sable", NOW)).toBe("About another person, so Sable asks you first.");
    expect(reasonSentence({ ...base, reasons: ["sensitive-money"] }, "Sable", NOW)).toBe("About money, so Sable asks you first.");
    expect(reasonSentence({ ...base, reasons: ["correction", "replaces-pinned"], correction: { targetText: "Invoice on the 1st", targetPinned: true } }, "Sable", NOW)).toBe('Would replace something you pinned: "Invoice on the 1st".');
    expect(reasonSentence({ ...base, reasons: ["source-gone"] }, "Sable", NOW)).toBe("No longer available: the message it came from was deleted.");
    expect(dayLabel(NOW - 20 * 86_400_000, NOW)).toMatch(/\d/);
  });

  it("never shows a code: every server code and unknown failure becomes a sentence", () => {
    const codes = ["MEMORY_VERSION_CONFLICT", "MEMORY_NOT_FOUND", "MEMORY_ACTION_REUSED", "MEMORY_LATER_FULL", "MEMORY_UNDO_UNAVAILABLE", "MEMORY_EVIDENCE_UNAVAILABLE", "MEMORY_CORRECTION_PIN_CHOICE_REQUIRED", "MEMORY_CORRECTION_TARGET_CHANGED", "MEMORY_WORKER_UNAVAILABLE", "SQLITE_BUSY", "INVALID_MEMORY_TEXT", "something odd"];
    for (const code of codes) { const text = errorSentence(new Error(code)); expect(text).not.toMatch(/MEMORY_|SQLITE|INVALID_/); expect(text).not.toBe(code); }
    expect(errorSentence(new TypeError("Failed to fetch"))).toBe("Reconnect to keep this. Nothing has been changed.");
    expect(errorSentence(new Error("MEMORY_VERSION_CONFLICT"))).toBe("This changed while you were looking. Here is the latest.");
    expect(workerSentence("MEMORY_WORKER_UNAVAILABLE")).toBe("Memory is catching up and will try again shortly.");
    expect(workerSentence("MEMORY_SOMETHING_NEW")).not.toMatch(/MEMORY_/);
    expect(workerSentence("Connection unavailable")).toBe("Connection unavailable");
    expect(modelSentence("MEMORY_MODEL_HASH_MISMATCH")).not.toMatch(/MEMORY_/);
    expect(plainOrFallback("MEMORY_X_Y", "fallback")).toBe("fallback");
  });
});

describe("what a press does to the list", () => {
  it("sends the exact (id, version) list of everyday items on screen, leaving out Later and one-by-one", () => {
    const items = [item(1), item(2, { version: 3 }), item(3, { group: "one-by-one", rank: 1 }), item(4, { later: true }), item(5)];
    expect(keepAllTargets(items)).toEqual([{ id: "id-1", version: 1 }, { id: "id-2", version: 3 }, { id: "id-5", version: 1 }]);
  });
  it("takes rows off at once and puts refused ones back in their old place", () => {
    const before = [item(1), item(2), item(3), item(4)];
    const after = withoutItems(before, new Set(["id-1", "id-3"]));
    expect(after.map(entry => entry.id)).toEqual(["id-2", "id-4"]);
    expect(restoreItems(after, before, new Set(["id-3"])).map(entry => entry.id)).toEqual(["id-2", "id-3", "id-4"]);
    expect(restoreItems(after, before, new Set(["id-2"])).map(entry => entry.id)).toEqual(["id-2", "id-4"]);
  });
});

describe("the shared counts", () => {
  beforeEach(() => resetWaiting());
  const summary = (revision: number, waiting: number) => ({ subjects: [{ kind: "bot" as const, id: "a", name: "Sable", waiting, later: 1, everyday: Math.min(waiting, 8) }], total: waiting, later: 1, boot: "b1", revision });

  it("moves the number from a live frame at once and keeps the name and Later count", () => {
    applyWaitingSummary(summary(1, 3));
    applyWaitingFrame({ botId: "a", subject: "bot", waiting: 11, total: 11, revision: 2, boot: "b1" });
    expect(subjectCount(getWaiting(), { kind: "bot", id: "a" })).toMatchObject({ name: "Sable", waiting: 11, later: 1 });
    expect(getWaiting().total).toBe(11);
    applyWaitingFrame({ botId: "a", subject: "bot", waiting: 0, total: 0, revision: 3, boot: "b1" });
    expect(subjectCount(getWaiting(), { kind: "bot", id: "a" })).toMatchObject({ waiting: 0, everyday: 0 });
  });

  it("drops an answer older than one already shown, but not one from a new run", () => {
    applyWaitingSummary(summary(5, 4));
    applyWaitingSummary(summary(3, 9));
    expect(getWaiting().total).toBe(4);
    applyWaitingFrame({ botId: "a", subject: "bot", waiting: 20, total: 20, revision: 2, boot: "b1" });
    expect(getWaiting().total).toBe(4);
    applyWaitingSummary({ ...summary(1, 7), boot: "b2" });
    expect(getWaiting().total).toBe(7);
  });

  it("seeds from the Inbox answer and keeps the Later count it already knew", () => {
    applyWaitingSummary(summary(1, 3));
    applyInboxWaiting([{ kind: "bot", id: "a", name: "Sable", waiting: 11, everyday: 8 }]);
    expect(subjectCount(getWaiting(), { kind: "bot", id: "a" })).toEqual({ kind: "bot", id: "a", name: "Sable", waiting: 11, everyday: 8, later: 1 });
  });

  it("remembers a Review press from the Inbox for the Memory screen, once", () => {
    const subject = { kind: "bot" as const, id: "a", name: "Sable" };
    expect(takeExpandRequest(subject)).toBe(false);
    requestExpand(subject);
    expect(takeExpandRequest({ ...subject, id: "b" })).toBe(false);
    expect(takeExpandRequest(subject)).toBe(true);
    expect(takeExpandRequest(subject)).toBe(false);
  });
});
