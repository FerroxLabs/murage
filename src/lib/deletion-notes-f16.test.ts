// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F16 phase 1, the window's side: the owed note keeps the ids of what it shows (so Dismiss can name exactly that), the retry answer
// becomes one short line, and both screens send Dismiss to the server instead of only hiding the note.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { owedNote, retryResultLine } from "./deletion-notes.ts";
import { initialState, reducer } from "../state/store";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const notices = [
  { id: "owed:claude", text: "Claude Code is open. Murage finishes removing these 2 conversations from it once it is closed.", tryAgain: true, covers: ["a1:claude", "b2:claude"] },
  { id: "owed:codex", text: "Codex is open. Murage finishes removing this conversation from it once it is closed.", tryAgain: true, covers: ["a1:codex"] },
];

describe("the owed note keeps what it shows", () => {
  it("keeps the notice ids and the obligations each line covers", () => {
    const note = owedNote(notices) as unknown as { ids: string[]; covers: string[]; items: string[] };
    expect(note.ids).toEqual(["owed:claude", "owed:codex"]);
    expect(note.covers).toEqual(["a1:claude", "b2:claude", "a1:codex"]);
    expect(note.items).toHaveLength(2);
  });
  it("the reducer keeps them on the note", () => {
    const next = reducer(initialState, { type: "deletionOwed", notices, rev: 5 });
    expect((next.deletionNote as unknown as { covers: string[] }).covers).toEqual(["a1:claude", "b2:claude", "a1:codex"]);
  });
  it("its title has no dashes and never says safe", () => {
    expect(owedNote(notices)!.title).not.toMatch(/[–—]|\bsafe/i);
  });
});

describe("the retry answer is one short line", () => {
  it("uses the server's line", () => {
    expect(retryResultLine({ finished: ["codex"], still: [], unchanged: false, line: "Removed from Codex." })).toBe("Removed from Codex.");
  });
  it("says nothing changed when nothing did, and never throws on an old answer", () => {
    expect(retryResultLine({ finished: [], still: [{ engine: "claude", code: "engine-open" }], unchanged: true })).toMatch(/Nothing changed/);
    expect(typeof retryResultLine(undefined)).toBe("string");
  });
});

describe("both screens dismiss through the server", () => {
  for (const file of ["../components/ChatView.tsx", "../components/GroupView.tsx"]) {
    it(file, () => {
      const source = read(file);
      expect(source).toContain('"/api/deletions/dismiss"');
    });
  }
  it("the banner awaits the dismiss and says when it failed", () => {
    const source = read("../components/DeletionNoteBanner.tsx");
    expect(source).toContain("Could not dismiss this. Try again.");
    expect(source).toContain("retryResultLine");
  });
});
