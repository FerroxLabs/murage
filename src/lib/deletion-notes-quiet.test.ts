// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.7 (Sean, 10-25/26): engine copies still owed after a Delete sat as a banner on top of EVERY chat ("Claude Code is open. Murage
// finishes removing ...", "Trying again... Still working.") for as long as his own Claude Code, Grok and Fuigo stayed open, all day.
// Now no chat shows them; Settings > Engines shows one quiet line with no action, and Murage retries by itself.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { chatDeletionNote, owedNote, owedSettingsLines } from "./deletion-notes.ts";

const here = dirname(fileURLToPath(import.meta.url));
const claude = { id: "owed:claude", text: "Claude Code is open. Murage finishes removing these 2 conversations from it by itself once Claude Code is closed. Nothing is needed from you.", tryAgain: true, byItself: true, label: "Claude Code", covers: ["d1:claude", "d2:claude"] };
const grok = { id: "owed:grok", text: "Grok is open. Murage finishes removing these 3 conversations from it by itself once Grok is closed. Nothing is needed from you.", tryAgain: true, byItself: true, label: "Grok", covers: ["d2:grok", "d3:grok", "d4:grok"] };
const fuigo = { id: "owed:fuigo", text: "Fuigo is open. Murage finishes removing this conversation from it by itself once Fuigo is closed. Nothing is needed from you.", tryAgain: true, byItself: true, label: "Fuigo", covers: ["d5:fuigo"] };
const synced = { id: "d6:claude:synced", text: "This conversation is removed from Claude Code. Claude Code keeps its files in a synced folder, so your cloud provider may still hold older copies in its version history.", tryAgain: false, covers: ["d6:claude:synced"] };

describe("engine copies still owed are out of the way", () => {
  it("no chat or room shows the owed list; a note a Delete just made still shows where the owner is", () => {
    expect(chatDeletionNote(owedNote([claude, grok, fuigo]))).toBeNull();
    const justDeleted = { title: "Deleted. Murage will finish removing these when it can:", items: ["Files this conversation made, in the folder \"Taxes\" you chose."] };
    expect(chatDeletionNote(justDeleted)).toBe(justDeleted);
    expect(chatDeletionNote(null)).toBeNull();
  });

  it("Settings > Engines sums it up in one quiet sentence, counting each deleted conversation once", () => {
    expect(owedSettingsLines(owedNote([claude, grok, fuigo]))).toEqual([
      "Murage is still removing 5 deleted conversations from Claude Code, Grok and Fuigo. It does this by itself, and nothing is needed from you.",
    ]);
    expect(owedSettingsLines(owedNote([fuigo]))).toEqual(["Murage is still removing a deleted conversation from Fuigo. It does this by itself, and nothing is needed from you."]);
    expect(owedSettingsLines(owedNote([synced]))).toEqual([synced.text]);
    expect(owedSettingsLines(owedNote([]))).toEqual([]);
    expect(owedSettingsLines(null)).toEqual([]);
    for (const line of owedSettingsLines(owedNote([claude, grok, fuigo, synced]))) expect(line).not.toMatch(/—|\bsafe(ly|ty)?\b|\bunsafe\b|Composio|Try again|Still working/i);
  });

  it("the views wire it that way", () => {
    for (const view of ["ChatView.tsx", "GroupView.tsx"]) {
      const text = readFileSync(join(here, "..", "components", view), "utf8");
      expect(text).toContain("const placeDeletionNote = chatDeletionNote(state.deletionNote);");
      expect(text).not.toMatch(/<DeletionNoteBanner note=\{state\.deletionNote\}/);
    }
    const settings = readFileSync(join(here, "..", "components", "EnginesSettings.tsx"), "utf8");
    expect(settings).toContain("const owedLines = owedSettingsLines(state.owedNote);");
  });
});
