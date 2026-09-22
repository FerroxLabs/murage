// AN ENGINE THAT IS HERE, READY, AND SIGNED OUT OF.
//
// The server has computed this list on every read of the setup view for as
// long as it has existed, and exactly one component read it: the first-run
// card. So on day two, when a Claude Code login expires, the product said
// nothing at all. The engine is present, enabled and "available", and the
// first thing asked of it fails.
import { describe, expect, it } from "vitest";

import { signedOutEngineRows, withSignedOutEngines } from "./signed-out-engines";
import type { SetupView } from "../../shared/setup";

const agent = (id: string, name: string, signInCommand?: string) =>
  ({ id, name, installed: true, ...(signInCommand ? { signInCommand } : {}) }) as never;

/** `conversationLive` and `next` are what firstRunOwnsMainView reads. */
function view(over: Partial<SetupView> = {}): SetupView {
  return {
    signedOutAgents: [agent("claude", "Claude Code", "claude login")],
    conversationLive: false,
    next: null,
    ...over,
  } as unknown as SetupView;
}

describe("which signed-out engines get reported", () => {
  it("reports one that is here and signed out of, with the command that fixes it", () => {
    expect(signedOutEngineRows(view())).toEqual([
      { id: "claude", name: "Claude Code", signInCommand: "claude login" },
    ]);
  });

  it("carries no command when the driver does not declare one", () => {
    // The driver is the only thing that knows it, so an absent command is a
    // row without one rather than invented copy.
    const rows = signedOutEngineRows(view({ signedOutAgents: [agent("codex", "Codex")] }));
    expect(rows).toEqual([{ id: "codex", name: "Codex" }]);
  });

  it("says nothing before the server has answered", () => {
    expect(signedOutEngineRows(null)).toEqual([]);
    expect(signedOutEngineRows(undefined)).toEqual([]);
  });

  it("says nothing while the first run is still asking for the same sign-in", () => {
    // The signed-out card is already in the Chief's thread. Two surfaces
    // asking for one sign-in is the noise this Inbox was rebuilt to stop.
    expect(signedOutEngineRows(view({ conversationLive: true, next: "flux" as never }))).toEqual([]);
  });

  it("speaks again the moment the first run is over", () => {
    // THE NEGATIVE CONTROL, and it is the one that matters: a gate that
    // never opens turns this back into the thing it replaces, which is
    // silence. `next === null` is the first run having nothing left to do.
    expect(signedOutEngineRows(view({ conversationLive: true, next: null }))).toHaveLength(1);
  });

  it("reports every engine, not just the first", () => {
    const rows = signedOutEngineRows(view({ signedOutAgents: [agent("a", "Claude Code"), agent("b", "Codex")] }));
    expect(rows.map(row => row.name)).toEqual(["Claude Code", "Codex"]);
  });
});

describe("what they do to the numbers", () => {
  const page = { decisions: 2, approvals: 1, questions: 1, connections: 0 };

  it("counts in the umbrella and in connections, or the parts stop summing", () => {
    const next = withSignedOutEngines(page, [{ id: "a", name: "Claude Code" }]);
    expect(next.connections).toBe(1);
    expect(next.decisions).toBe(3);
    // The invariant this Inbox has already broken once: a number on a tab
    // that the sidebar total cannot explain.
    expect(next.approvals + next.questions + next.connections).toBe(next.decisions);
  });

  it("leaves the page exactly alone when there are none", () => {
    // The control. Returning a new object with the same numbers would be
    // harmless; quietly adding zero-length rows to a count would not be.
    expect(withSignedOutEngines(page, [])).toBe(page);
  });

  it("does not touch the counts it has nothing to say about", () => {
    const next = withSignedOutEngines(page, [{ id: "a", name: "A" }, { id: "b", name: "B" }]);
    expect(next.approvals, "an engine is not an approval").toBe(1);
    expect(next.questions, "nor a question").toBe(1);
    expect(next.connections).toBe(2);
  });
});
