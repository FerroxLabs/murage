// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GrokBuild deletion-gate High: dismissing the deletion banner cleared the note locally and then dropped the server's answer (same
// revision as the broadcast already seen), so a deletion that became owed while the dismiss ran vanished from the banner until a
// reconnect. Now a dismiss only clears the lines it showed, through the server's answer, and a failed dismiss leaves the note.
import { describe, expect, it } from "vitest";

import * as notes from "@/lib/deletion-notes";
import { initialState, reducer, type AppState } from "./store";

const A = { id: "owed:claude", text: "Claude Code is open. Close Claude Code and Murage will finish removing this conversation from it.", tryAgain: true, covers: ["d1:claude"] };
const B = { id: "owed:codex", text: "Codex is open. Close Codex and Murage will finish removing this conversation from it.", tryAgain: true, covers: ["d2:codex"] };
type Dismiss = (shown: AppState["deletionNote"], post: (covers: string[]) => Promise<{ notices?: unknown; rev?: unknown } | undefined>, dispatch: (action: never) => void) => Promise<void>;
const dismiss = (notes as unknown as { dismissDeletionNote?: Dismiss }).dismissDeletionNote;

function windowShowing(notices: unknown[], rev: number) {
  let state = reducer(initialState, { type: "deletionOwed", notices, rev });
  const dispatch = (action: Parameters<typeof reducer>[1]) => { state = reducer(state, action); };
  return { dispatch, state: () => state };
}

describe("dismissing the deletion banner", () => {
  it("a deletion owed while the dismiss ran stays on the banner (its broadcast arrived before the answer, same revision)", async () => {
    expect(typeof dismiss, "dismissDeletionNote is missing").toBe("function");
    const w = windowShowing([A], 10);
    const shown = w.state().deletionNote;
    let asked: string[] = [];
    await dismiss!(shown, async (covers) => {
      asked = covers;
      // meanwhile: deletion d2 became owed (rev 11), then the dismiss was saved and broadcast (rev 12), then the answer (rev 12)
      w.dispatch({ type: "deletionOwed", notices: [A, B], rev: 11 });
      w.dispatch({ type: "deletionOwed", notices: [B], rev: 12 });
      return { notices: [B], rev: 12 };
    }, w.dispatch as never);
    expect(asked).toEqual(["d1:claude"]);
    expect(w.state().deletionNote?.ids).toEqual(["owed:codex"]);
    expect(w.state().deletionNote?.items).toEqual([B.text]);
  });

  it("the answer applies when its broadcast was missed, and clears the banner when nothing else is owed", async () => {
    expect(typeof dismiss).toBe("function");
    const w = windowShowing([A], 10);
    await dismiss!(w.state().deletionNote, async () => ({ notices: [B], rev: 12 }), w.dispatch as never);
    expect(w.state().deletionNote?.ids).toEqual(["owed:codex"]);
    const v = windowShowing([A], 10);
    await dismiss!(v.state().deletionNote, async () => ({ notices: [], rev: 12 }), v.dispatch as never);
    expect(v.state().deletionNote).toBeNull();
  });

  it("an answer older than a newer broadcast is dropped; a failed dismiss leaves the note", async () => {
    expect(typeof dismiss).toBe("function");
    const w = windowShowing([A], 10);
    await dismiss!(w.state().deletionNote, async () => { w.dispatch({ type: "deletionOwed", notices: [A, B], rev: 14 }); return { notices: [], rev: 12 }; }, w.dispatch as never);
    expect(w.state().deletionNote?.ids).toEqual(["owed:claude", "owed:codex"]);
    const v = windowShowing([A], 10);
    await expect(dismiss!(v.state().deletionNote, async () => { throw new Error("offline"); }, v.dispatch as never)).rejects.toThrow();
    expect(v.state().deletionNote?.ids).toEqual(["owed:claude"]);
  });

  it("a note that is not an owed one (a Delete just showed it) goes at once, without asking the server", async () => {
    expect(typeof dismiss).toBe("function");
    let state: AppState = { ...initialState, deletionNote: { title: "Deleted. Murage will finish removing these when it can:", items: ["x"] } };
    let posted = false;
    await dismiss!(state.deletionNote, async () => { posted = true; return undefined; }, ((action: Parameters<typeof reducer>[1]) => { state = reducer(state, action); }) as never);
    expect(posted).toBe(false);
    expect(state.deletionNote).toBeNull();
  });
});
