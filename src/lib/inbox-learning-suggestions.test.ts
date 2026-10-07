// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Inbox shows lesson suggestions and nothing else of the learning
// screen. These pin the three answers' request shapes and the plain failure.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { SUGGESTION_EDIT_MAX, answerSuggestion, canEditSuggestion, suggestionNote, suggestionSentence, editSuggestion, suggestionPath, suggestionTitle, type LearningSuggestion } from "./inbox-learning-suggestions";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const row: LearningSuggestion = { botId: "ember", botName: "Ember", lessonId: "l/1", version: 4, text: "Lead with the decision", at: 1 };
const keyOk = /^[A-Za-z0-9._:-]{8,128}$/;

describe("answering a suggestion", () => {
  it.each(["apply", "not-now"] as const)("%s posts the revision it was shown, with an idempotency key", async verb => {
    const request = vi.fn(async () => ({}));
    expect(await answerSuggestion(request, row, verb)).toEqual({ ok: true });
    const [path, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/api/bots/ember/learning/suggestions/l%2F1/${verb}`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ expectedRevision: 4 });
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toMatch(keyOk);
  });
  it("a failed answer is one plain line, not the raw error", async () => {
    const result = await answerSuggestion(async () => { throw new Error("HTTP 409\nstack trace"); }, row, "apply");
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.message).not.toMatch(/\n|HTTP|stack/); expect(result.message.length).toBeGreaterThan(5); }
  });
});

describe("editing a suggestion", () => {
  it("posts the new words with the shown revision and returns the row at the next version", async () => {
    const request = vi.fn(async () => ({ lesson: { version: 5 } }));
    const result = await editSuggestion(request, row, "  Lead with the answer  ");
    const [path, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(suggestionPath(row, "edit"));
    expect(JSON.parse(init.body as string)).toEqual({ expectedRevision: 4, text: "Lead with the answer" });
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toMatch(keyOk);
    expect(result).toEqual({ ok: true, suggestion: { ...row, text: "Lead with the answer", version: 5 } });
  });
  it("assumes version + 1 when the answer does not say", async () => {
    const result = await editSuggestion(async () => ({}), row, "x y");
    expect(result.ok && result.suggestion.version).toBe(5);
  });
  it("sends nothing for empty or over-long words", async () => {
    const request = vi.fn(async () => ({}));
    expect((await editSuggestion(request, row, "   ")).ok).toBe(false);
    expect((await editSuggestion(request, row, "a".repeat(SUGGESTION_EDIT_MAX + 1))).ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
  it("a failed edit is one plain line", async () => {
    const result = await editSuggestion(async () => { throw new Error("boom"); }, row, "fine");
    expect(result.ok).toBe(false);
  });
});

describe("the row", () => {
  it("names the bot in a plain sentence", () => { expect(suggestionTitle(row)).toBe("Ember has a suggestion"); });
});

describe("Inbox wiring", () => {
  const inbox = read("../components/Inbox.tsx");
  it("renders the section on decisions and all, beside the backup notice", () => {
    expect(inbox).toContain("learningSuggestions");
    expect(inbox).toContain('t("inboxLearning.section")');
    expect(inbox).toMatch(/view === "decisions" \|\| view === "all"/);
    expect(inbox).toContain("onOpenLearning");
  });
  it("InboxDialog opens the bot's Learning section and closes", () => {
    const dialog = read("../components/InboxDialog.tsx");
    expect(dialog).toContain('type: "select"');
    expect(dialog).toContain('section: "learning"');
    expect(dialog).toContain("onOpenLearning");
  });
});

describe("share and skill or routine suggestions in the Inbox", () => {
  const share: LearningSuggestion = { ...row, scope: "bots", fromName: "Ember", recipients: [{ id: "dax", name: "Dax" }, { id: "nova", name: "Nova" }] };
  const change: LearningSuggestion = { ...row, lessonId: "psug-1", kind: "procedure", targetKind: "routine", label: "Monday report", text: "Verify first.", summary: "Verify first.", reasons: ["outbound"], proposedHash: "h" };
  it("a share row says who learned it and who it is offered to, and is not edited here", () => {
    expect(suggestionNote(share)).toBe("Learned for Ember. Offered to Dax, Nova.");
    expect(canEditSuggestion(share)).toBe(false);
  });
  it("a routine change names the routine and why it waits; Apply names the exact words shown", async () => {
    expect(suggestionSentence(change)).toBe('Improve the routine "Monday report": Verify first.');
    expect(suggestionNote(change)).toBe("It sends or reaches other people, so it waits for you.");
    expect(canEditSuggestion(change)).toBe(false);
    const request = vi.fn(async () => ({}));
    await answerSuggestion(request, change, "apply");
    expect(JSON.parse((request.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ expectedRevision: 4, proposedHash: "h" });
  });
  it("an ordinary lesson is unchanged", () => {
    expect(suggestionNote(row)).toBeNull();
    expect(suggestionSentence(row)).toBe(row.text);
    expect(canEditSuggestion(row)).toBe(true);
  });
});
