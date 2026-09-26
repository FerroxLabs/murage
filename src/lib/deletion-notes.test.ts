// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { BACKUPS_LINE, deletionConsequenceLines, deletionNote } from "./deletion-notes.ts";

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
});
