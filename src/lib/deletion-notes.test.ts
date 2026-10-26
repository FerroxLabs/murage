// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { BACKUPS_LINE, deletionConsequenceLines, deletionErrorSentence, deletionNote, ENGINE_FILES_LINE, owedNote } from "./deletion-notes.ts";

describe("deletion notes", () => {
  it("counts saved files in the confirmation and always mentions backups", () => {
    expect(deletionConsequenceLines(3)).toEqual(["This also deletes 3 saved files.", BACKUPS_LINE]);
    expect(deletionConsequenceLines(1)).toEqual(["This also deletes 1 saved file.", BACKUPS_LINE]);
    expect(deletionConsequenceLines(0)).toEqual([BACKUPS_LINE]);
    expect(deletionConsequenceLines(null)).toEqual([BACKUPS_LINE]);
  });

  it("names how many messages go, so a long conversation is never deleted without saying so", () => {
    expect(deletionConsequenceLines(0, 1240)).toEqual(["That is 1,240 messages.", BACKUPS_LINE]);
    expect(deletionConsequenceLines(2, 1)).toEqual(["That is 1 message and 2 saved files.", BACKUPS_LINE]);
    expect(deletionConsequenceLines(1, 0)).toEqual(["This also deletes 1 saved file.", BACKUPS_LINE]);
    expect(deletionConsequenceLines(null, null)).toEqual([BACKUPS_LINE]);
  });

  it("lists leftovers in plain words and never shows raw paths", () => {
    expect(deletionNote({ leftovers: [] })).toBeNull();
    expect(deletionNote(undefined)).toBeNull();
    const note = deletionNote({
      leftovers: [{ what: "Files this conversation made", where: "the folder \"Taxes\" you chose" }, { place: "/x/y", reason: "old shape" }],
      failed: ["/Users/someone/.murage/workspaces/b/threads/t"],
    })!;
    expect(note.items).toEqual([
      "Files this conversation made, in the folder \"Taxes\" you chose.",
    ]);
    // files Murage finishes by itself are not a line over the chat (1.0.7)
    expect(deletionNote({ leftovers: [], failed: ["/home/someone/.claude"] })).toBeNull();
    for (const line of [note.title, ...note.items, ...deletionConsequenceLines(2)]) {
      expect(line).not.toMatch(/—|\bsafe(ly)?\b|Composio|\/Users\//i);
    }
  });

  it("says once what Murage does to the coding engines' files, what it does when an engine is using one, and what it does not reach", () => {
    expect(deletionConsequenceLines(0, null, ["Claude Code"])).toEqual([
      BACKUPS_LINE,
      "When you delete a conversation, Murage removes its words from the coding engines' files on this computer. If an engine is using one of those files, Murage leaves that file alone, tells you, and finishes later. Murage never changes another conversation's words. Copies in backups or in an engine's online account are not removed by Murage.",
    ]);
    expect(deletionConsequenceLines(0, null, ["Codex", "Fuigo"]).filter((line) => line === ENGINE_FILES_LINE)).toHaveLength(1);
    expect(deletionConsequenceLines(0, null, [])).toEqual([BACKUPS_LINE]);
    expect(ENGINE_FILES_LINE).not.toMatch(/—|\bsafe(ly|ty)?\b|\bunsafe\b/i);
  });

  it("keeps the server's owed sentences, and never offers Try again now for them (Murage retries by itself)", () => {
    expect(owedNote([])).toBeNull();
    expect(owedNote(undefined)).toBeNull();
    const held = "Another program is using Codex's files. Murage tries again in 10 minutes and finishes removing this conversation by itself.";
    expect(owedNote([{ id: "a:codex", text: held, tryAgain: true }, { nothing: true }])).toMatchObject({ title: "Deleted. Murage finishes the rest by itself:", items: [held], retry: false, owed: true });
    expect(owedNote([{ id: "a:codex:done", text: "Removed from Codex.", tryAgain: false }])).toMatchObject({ title: "Deleted.", items: ["Removed from Codex."], retry: false, owed: true });
  });

  it("never passes the server's own text through when a Delete fails", () => {
    const raw = (status: number | undefined, message: string) => Object.assign(new Error(message), status === undefined ? {} : { status });
    expect(deletionErrorSentence(raw(400, "a bot keeps at least one task"))).toBe("That conversation could not be deleted. Try again in a moment.");
    expect(deletionErrorSentence(raw(409, "this task is running: stop it first"))).toBe("This conversation is still working. Stop it first, then delete it.");
    expect(deletionErrorSentence(raw(404, "no such channel task"))).toBe("That conversation is already gone.");
    expect(deletionErrorSentence(raw(undefined, "Failed to fetch"))).toBe("That conversation could not be deleted. Try again in a moment.");
    expect(deletionErrorSentence("boom")).toBe("That conversation could not be deleted. Try again in a moment.");
    for (const status of [400, 404, 409, 500, undefined]) {
      const line = deletionErrorSentence(raw(status, "a bot keeps at least one task"));
      expect(line).toMatch(/^[A-Z].*\.$/);
      expect(line).not.toMatch(/task|keeps at least|—/);
    }
  });
});
