// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What is still owed for deleted conversations reaches the window whenever it connects, and goes when the server says nothing is
// owed (r15 review, finding 8): a notice raised while the window was closed is never broadcast again, and a retry that
// succeeds must clear the notice it answered.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { initialState, reducer, type AppState } from "./store";

const here = dirname(fileURLToPath(import.meta.url));
const sentence = "Codex's copy of this conversation could not be removed yet because Codex was using its history. Murage will try again when it starts.";
const owed = [{ id: "a:codex", text: sentence, tryAgain: true }];
const withNote = (note: AppState["deletionNote"]): AppState => ({ ...initialState, deletionNote: note });

describe("the owed-deletion notice follows the server's list", () => {
  it("a list with a notice shows it, with the retry action", () => {
    const next = reducer(initialState, { type: "deletionOwed", notices: owed });
    expect(next.deletionNote).toEqual({ title: "Deleted. Murage finishes the rest by itself:", items: [sentence], retry: true, owed: true, ids: ["a:codex"], covers: [] });
  });

  it("an empty list clears an owed notice (a retry that worked, or one settled while the window was away)", () => {
    const shown = reducer(initialState, { type: "deletionOwed", notices: owed });
    expect(reducer(shown, { type: "deletionOwed", notices: [] }).deletionNote).toBeNull();
  });

  it("an empty list leaves a different note alone: the one a Delete just showed is not an owed notice", () => {
    const justDeleted = { title: "Deleted. Murage will finish removing these when it can:", items: ["Something, in somewhere."] };
    const state = withNote(justDeleted);
    expect(reducer(state, { type: "deletionOwed", notices: [] })).toBe(state);
  });

  it("an answer that is not a list is ignored, never read as 'nothing owed'", () => {
    const shown = reducer(initialState, { type: "deletionOwed", notices: owed });
    expect(reducer(shown, { type: "deletionOwed", notices: undefined })).toBe(shown);
    expect(reducer(shown, { type: "deletionOwed", notices: { error: "x" } })).toBe(shown);
  });
});

describe("the order of answers: an older list never undoes a newer one (r16b finding 10)", () => {
  const pending = [{ id: "a:codex", text: "Codex is open. Close Codex and Murage will finish removing this conversation from it.", tryAgain: true }];
  const done = [{ id: "a:codex:done", text: "Removed from Codex.", tryAgain: false }];

  it("a slow GET (older rev) that resolves after a newer event is dropped", () => {
    const afterEvent = reducer(initialState, { type: "deletionOwed", notices: done, rev: 12 });
    const afterGet = reducer(afterEvent, { type: "deletionOwed", notices: pending, rev: 11 });
    expect(afterGet).toBe(afterEvent);
    expect(afterGet.deletionNote?.items).toEqual(["Removed from Codex."]);
  });

  it("the inverse: the answer that is newer is applied, whichever way it arrived", () => {
    const afterGet = reducer(initialState, { type: "deletionOwed", notices: pending, rev: 11 });
    expect(afterGet.deletionNote?.retry).toBe(true);
    const afterEvent = reducer(afterGet, { type: "deletionOwed", notices: done, rev: 12 });
    expect(afterEvent.deletionNote).toEqual({ title: "Deleted.", items: ["Removed from Codex."], retry: false, owed: true, ids: ["a:codex:done"], covers: [] });
    expect(afterEvent.owedRev).toBe(12);
  });

  it("the same revision twice (the broadcast and the answer to a question asked at the same moment) is applied once", () => {
    const first = reducer(initialState, { type: "deletionOwed", notices: pending, rev: 20 });
    expect(reducer(first, { type: "deletionOwed", notices: pending, rev: 20 })).toBe(first);
  });

  it("an answer with no revision (an older server) is still applied", () => {
    expect(reducer(initialState, { type: "deletionOwed", notices: pending }).deletionNote?.retry).toBe(true);
  });
});

describe("the window asks, and uses the answer", () => {
  const store = readFileSync(join(here, "store.tsx"), "utf8");
  it("asks the server what is owed on every connect and reconnect, and after every snapshot", () => {
    expect(store).toMatch(/api\("\/api\/deletions\/owed"\)\.then\(\(response\) => \{ if \(alive\) rawDispatch\(\{ type: "deletionOwed", notices: response\?\.notices, rev: response\?\.rev \}\)/);
    expect(store).toMatch(/onOpen: \(\) => \{ rawDispatch\(\{ type: "connected", value: true \}\); requestMemoryWake\("RECONNECT"\); refreshOwed\(\); deleteControl\.current\.kick\(\); \}/);
    expect(store).toMatch(/hydrated = true;\s+refreshOwed\(\);/);
  });
  it("the live frame goes through the same action, so an empty list clears", () => {
    expect(store).toMatch(/case "deletion-owed": \{\s+rawDispatch\(\{ type: "deletionOwed", notices: frame\.notices, rev: frame\.rev \}\);/);
  });
  for (const view of ["ChatView.tsx", "GroupView.tsx"]) {
    it(`${view}: "Try again now" applies the response it gets`, () => {
      const text = readFileSync(join(here, "..", "components", view), "utf8");
      // awaited, so a refused retry reaches the banner's own failure line instead of being swallowed
      expect(text).toContain('const response = await api("/api/deletions/retry", { method: "POST" }); dispatch({ type: "deletionOwed", notices: response?.notices, rev: response?.rev });');
    });
  }
});

describe("a finished line is cleared by ownership, not by whether it offers a retry (r17 finding 12)", () => {
  const done = [{ id: "a:codex:done", text: "Removed from Codex.", tryAgain: false }];

  it("'Removed from Codex.' (no retry action) goes when a newer, empty list says nothing is owed any more", () => {
    const shown = reducer(initialState, { type: "deletionOwed", notices: done, rev: 30 });
    expect(shown.deletionNote?.retry).toBe(false);
    const cleared = reducer(shown, { type: "deletionOwed", notices: [], rev: 31 });
    expect(cleared.deletionNote).toBeNull();
    expect(cleared.owedRev).toBe(31);
  });

  it("an older empty list does not clear it, and a note a Delete showed is never cleared by the owed list", () => {
    const shown = reducer(initialState, { type: "deletionOwed", notices: done, rev: 30 });
    expect(reducer(shown, { type: "deletionOwed", notices: [], rev: 29 })).toBe(shown);
    const justDeleted = withNote({ title: "Deleted.", items: ["Something, in somewhere."], retry: false });
    expect(reducer(justDeleted, { type: "deletionOwed", notices: [], rev: 40 }).deletionNote).toEqual(justDeleted.deletionNote);
  });
});
