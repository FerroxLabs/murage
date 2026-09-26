// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { BACKUPS_LINE, deletionConsequenceLines, deletionErrorSentence, deletionNote } from "./deletion-notes.ts";

describe("deletion notes", () => {
  it("counts saved files in the confirmation and always mentions backups", () => {
    expect(deletionConsequenceLines(3)).toEqual(["This also deletes 3 saved files.", BACKUPS_LINE]);
    expect(deletionConsequenceLines(1)).toEqual(["This also deletes 1 saved file.", BACKUPS_LINE]);
    expect(deletionConsequenceLines(0)).toEqual([BACKUPS_LINE]);
    expect(deletionConsequenceLines(null)).toEqual([BACKUPS_LINE]);
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
      "A few files could not be removed yet. Murage tries again the next time it starts.",
    ]);
    for (const line of [note.title, ...note.items, ...deletionConsequenceLines(2)]) {
      expect(line).not.toMatch(/—|\bsafe(ly)?\b|Composio|\/Users\//i);
    }
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
