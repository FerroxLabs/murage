// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.8: a copy owed because Murage's helper cannot load on this system (server/conversation-deletion.ts "helper-unloadable") is not
// finished by itself, so neither the title nor Settings > Engines may say it is. The server's own line is shown as it is.
import { describe, expect, it } from "vitest";

import { OWED_TITLE, OWED_UPDATE_TITLE, owedNote, owedSettingsLines } from "./deletion-notes.ts";

const unloadable = { id: "owed:claude", text: "Murage removed this conversation, but could not clear it from Claude Code's own history on this system. Murage tries again after its next update.", tryAgain: true, waitsForUpdate: true, label: "Claude Code", covers: ["d1:claude"] };
const open = { id: "owed:grok", text: "Grok is open. Murage finishes removing this conversation from it by itself once Grok is closed. Nothing is needed from you.", tryAgain: true, byItself: true, label: "Grok", covers: ["d2:grok"] };

describe("a copy that waits for Murage's next update", () => {
  it("gets a title that promises no finish when it is all that is owed", () => {
    const note = owedNote([unloadable])!;
    expect(note.title).toBe(OWED_UPDATE_TITLE);
    expect(note.title).not.toMatch(/by itself|finishes/);
    expect(note.lines[0]!.waitsForUpdate).toBe(true);
    expect(owedNote([unloadable, open])!.title).toBe(OWED_TITLE);
    expect(owedNote([open])!.title).toBe(OWED_TITLE);
  });

  it("is shown in Settings > Engines in the server's own words, never summed into \"does this by itself\"", () => {
    expect(owedSettingsLines(owedNote([unloadable]))).toEqual([unloadable.text]);
    expect(owedSettingsLines(owedNote([open, unloadable]))).toEqual([
      "Murage is still removing a deleted conversation from Grok. It does this by itself, and nothing is needed from you.",
      unloadable.text,
    ]);
    for (const line of [OWED_UPDATE_TITLE, ...owedSettingsLines(owedNote([unloadable]))]) expect(line).not.toMatch(/—|–|\bsafe(ly|ty)?\b|\bunsafe\b|Composio/i);
  });
});
