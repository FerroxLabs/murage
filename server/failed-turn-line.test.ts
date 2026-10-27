// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A failed direct turn is never silent: when the engine's path showed no runtime.error, the owner gets one plain line, on every
// engine, never on a Stop, and never a second line when an error was already shown. The fold in index.ts uses exactly these pieces
// (TurnErrorShown at runtime.error / turn.started / turn.completed, then wantsFailedTurnLine); the structure test below pins that.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { emptyTurnLine, failedTurnLine, TurnErrorShown, turnProducedSomething, turnWroteText, wantsEmptyTurnLine, wantsFailedTurnLine, type FailedTurnContext } from "./failed-turn-line.ts";
import { ASK_STOP_REASONS } from "./drivers/ask-stop.ts";

type Ev =
  | { type: "turn.started"; turnId?: string }
  | { type: "runtime.error"; turnId?: string }
  | { type: "turn.completed"; turnId?: string; ok: boolean; stopReason?: string | null };

const direct: Omit<FailedTurnContext, "errorShown"> = {
  directOwnerTurn: true, replacementOwnsThread: false, delegated: false, routine: false, lateRedispatch: false, failureRowShown: false,
};

/** The fold's three touch points for one thread, as index.ts runs them; returns the fallback lines written. */
function fold(events: Ev[], ctx: Partial<FailedTurnContext> = {}): string[] {
  const shown = new TurnErrorShown();
  const lines: string[] = [];
  for (const event of events) {
    if (event.type === "turn.started") shown.noteStarted("t", event.turnId);
    else if (event.type === "runtime.error") shown.noteError("t", event.turnId);
    else {
      const errorShown = shown.take("t", event.turnId);
      if (wantsFailedTurnLine(event, { ...direct, ...ctx, errorShown })) lines.push(failedTurnLine("Ada"));
    }
  }
  return lines;
}

const LINE = "Ada could not reply this time. Murage ended the turn so you can send your message again.";

// The terminal shape each engine settles a failed turn with when its own path showed nothing (the silent-turns audit of RC
// 274b6bf43: P1/P2 Pi, C1 Claude is_error with no text, X1 Codex failed with no error message, B1 a cloud box that ended on its own).
const ENGINES: Array<[string, string]> = [
  ["Pi, P1 (exits during the handshake)", "failed"],
  ["Pi, P2 (dies mid-turn)", "failed"],
  ["ACP Claude", "exit_before_result"],
  ["ACP Codex", "exit_before_result"],
  ["ACP Fuigo", "exit_before_result"],
  ["Codex, X1 (turn/completed failed, no error message)", "failed"],
  ["Claude, C1 (result is_error, no assistant text)", "error_during_execution"],
  ["HTTP engine (OpenAI chat)", "failed"],
  ["Cloud computer box, B1 (ended on its own)", "error"],
];

describe("failed direct turn fallback line", () => {
  for (const [engine, stopReason] of ENGINES) {
    it(`${engine}: a silent failed turn gets exactly one line`, () => {
      expect(fold([{ type: "turn.started", turnId: "u1" }, { type: "turn.completed", turnId: "u1", ok: false, stopReason }])).toEqual([LINE]);
    });
    it(`${engine}: a failed turn that already showed its error gets no second line`, () => {
      expect(fold([
        { type: "turn.started", turnId: "u1" },
        { type: "runtime.error", turnId: "u1" },
        { type: "turn.completed", turnId: "u1", ok: false, stopReason },
      ])).toEqual([]);
    });
  }

  it("never writes a line for an owner Stop or Murage's Ask stop", () => {
    expect(fold([{ type: "turn.started", turnId: "u1" }, { type: "turn.completed", turnId: "u1", ok: true, stopReason: "cancelled" }])).toEqual([]);
    for (const reason of ASK_STOP_REASONS) {
      expect(fold([{ type: "turn.started", turnId: "u1" }, { type: "turn.completed", turnId: "u1", ok: true, stopReason: reason }])).toEqual([]);
    }
  });

  it("never writes a line for a finished turn", () => {
    expect(fold([{ type: "turn.started", turnId: "u1" }, { type: "turn.completed", turnId: "u1", ok: true, stopReason: "end_turn" }])).toEqual([]);
  });

  it("counts an error emitted before turn.started, or with no turn, as shown", () => {
    expect(fold([{ type: "runtime.error", turnId: "u1" }, { type: "turn.started", turnId: "u1" }, { type: "turn.completed", turnId: "u1", ok: false }])).toEqual([]);
    expect(fold([{ type: "turn.started", turnId: "u1" }, { type: "runtime.error" }, { type: "turn.completed", turnId: "u1", ok: false }])).toEqual([]);
  });

  it("an earlier turn's error does not cover the next turn's silent failure", () => {
    expect(fold([
      { type: "turn.started", turnId: "u1" },
      { type: "runtime.error", turnId: "u1" },
      { type: "turn.completed", turnId: "u1", ok: false },
      { type: "turn.started", turnId: "u2" },
      { type: "turn.completed", turnId: "u2", ok: false },
    ])).toEqual([LINE]);
  });

  it("does not double the paths that have their own line", () => {
    const silent: Ev[] = [{ type: "turn.started", turnId: "u1" }, { type: "turn.completed", turnId: "u1", ok: false, stopReason: "failed" }];
    expect(fold([{ type: "turn.started", turnId: "u1" }, { type: "turn.completed", turnId: "u1", ok: false, stopReason: "submission_refused" }])).toEqual([]);
    expect(fold(silent, { delegated: true })).toEqual([]);
    expect(fold(silent, { routine: true })).toEqual([]);
    expect(fold(silent, { directOwnerTurn: false })).toEqual([]);
    expect(fold(silent, { replacementOwnsThread: true })).toEqual([]);
    expect(fold(silent, { lateRedispatch: true })).toEqual([]);
    // a redelivered event finds the line (or another failure line) already on the turn
    expect(fold(silent, { failureRowShown: true })).toEqual([]);
  });

  it("a failed turn that already wrote text (a 529 overloaded reply, a partial answer) says it did not finish, never a second error", () => {
    // Claude API errors (529, rate limit, credit) end ok:false with no runtime.error: the provider's text is the reply.
    const lines: string[] = [];
    const shown = new TurnErrorShown();
    shown.noteStarted("t", "u1");
    const event = { ok: false, stopReason: "error_during_execution" };
    if (wantsFailedTurnLine(event, { ...direct, errorShown: shown.take("t", "u1") })) lines.push(failedTurnLine("Ada", true));
    expect(lines).toEqual(["Ada did not finish this reply. Murage ended the turn so you can send your message again."]);
  });

  it("names the bot, or says This bot when it has no name", () => {
    expect(failedTurnLine("  ")).toBe("This bot could not reply this time. Murage ended the turn so you can send your message again.");
    expect(failedTurnLine("Ada")).not.toMatch(/—|safe/i);
  });
});

describe("empty finished turn line (Class E, ACP's empty-turn rule)", () => {
  type Row = { role: string; kind: string; actorKind?: string; murageLine?: boolean; text?: string; attachments?: unknown[] };
  const user: Row = { role: "user", kind: "text", text: "hi" };
  const finished = { ok: true, stopReason: "end_turn" };
  const empty = (engine: string, rows: Row[], event: { ok: boolean; stopReason?: string | null } = finished, ctx: Partial<FailedTurnContext> = {}) =>
    wantsEmptyTurnLine(event, { ...direct, errorShown: false, ...ctx, produced: turnProducedSomething(rows) }) ? [emptyTurnLine(engine)] : [];

  for (const engine of ["Claude", "Codex", "Pi"]) {
    it(`${engine}: a finished turn with no reply, image or tool result gets ACP's line`, () => {
      // reasoning only, or a whitespace reply, and Murage's own notes, are not something that came back
      const rows: Row[] = [user, { role: "bot", kind: "text", text: "  " }, { role: "bot", kind: "activity", actorKind: "murage", text: "", }];
      expect(empty(engine, rows)).toEqual([`${engine} finished without a reply, an image or a tool result, so nothing came back.`]);
      expect(empty(engine, rows, { ok: true, stopReason: null })).toHaveLength(1);
    });
  }

  it("a tools-only turn, a reply, an image or a made file is a success and stays quiet", () => {
    expect(empty("Claude", [user, { role: "bot", kind: "activity", text: "" }])).toEqual([]);
    expect(empty("Codex", [user, { role: "bot", kind: "text", text: "done" }])).toEqual([]);
    expect(empty("Pi", [user, { role: "bot", kind: "text", text: "", attachments: [{ name: "a.png" }] }])).toEqual([]);
    expect(empty("Pi", [user, { role: "bot", kind: "screen" }])).toEqual([]);
  });

  it("Murage's retry note, as the fold persists it (murageLine, no actorKind), is not something that came back", () => {
    // index.ts turn.retrying -> pushMessage: an activity row with no provider reply, stamped murageLine, with the turn's id and engine
    const retry = { role: "bot", kind: "activity", murageLine: true, engine: "claude", turnId: "u1", tool: { name: "retrying: attempt 2/3 in 5s: overloaded", ok: true } };
    expect(empty("Claude", [user, retry])).toEqual(["Claude finished without a reply, an image or a tool result, so nothing came back."]);
    // the same row without the stamp would have counted: the stamp is what excludes it
    expect(turnProducedSomething([user, { ...retry, murageLine: undefined }])).toBe(true);
  });

  it("wroteText counts the bot's own text only, never Murage's rows", () => {
    expect(turnWroteText([user, { role: "bot", kind: "text", text: "partial answer" }])).toBe(true);
    expect(turnWroteText([user, { role: "bot", kind: "text", text: "a status line", actorKind: "murage" }])).toBe(false);
    expect(turnWroteText([user, { role: "bot", kind: "text", text: "a held reply note", murageLine: true }])).toBe(false);
    expect(turnWroteText([user, { role: "bot", kind: "text", text: "  " }])).toBe(false);
  });

  it("keeps the same exclusions as the failed-turn line", () => {
    const rows: Row[] = [user];
    expect(empty("Claude", rows, { ok: true, stopReason: "cancelled" })).toEqual([]);
    for (const reason of ASK_STOP_REASONS) expect(empty("Claude", rows, { ok: true, stopReason: reason })).toEqual([]);
    expect(empty("Claude", rows, { ok: false, stopReason: "empty_turn" })).toEqual([]);
    for (const ctx of [{ directOwnerTurn: false }, { replacementOwnsThread: true }, { delegated: true }, { routine: true }, { lateRedispatch: true }, { errorShown: true }, { failureRowShown: true }]) {
      expect(empty("Claude", rows, finished, ctx)).toEqual([]);
    }
  });
});

describe("failed direct turn fallback wiring (index.ts)", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
  const caseBody = (name: string) => {
    const at = src.indexOf(`case "${name}"`);
    return src.slice(at, src.indexOf("\n    case ", at + 10));
  };
  it("notes every shown runtime.error and every turn start", () => {
    expect(caseBody("runtime.error")).toContain("turnErrorShown.noteError(event.threadId, event.turnId)");
    expect(caseBody("turn.started")).toContain("turnErrorShown.noteStarted(event.threadId, event.turnId)");
  });
  it("writes the line as an error row the chat shows, through wantsFailedTurnLine only", () => {
    const body = src.slice(src.indexOf('case "turn.completed": {'));
    expect(body).toContain("turnErrorShown.take(event.threadId, event.turnId)");
    expect(body).toContain("wantsFailedTurnLine(event, lineContext)");
    expect(body).toContain("tool: { name: `error: ${failedTurnLine(bot.name, wroteText)}`, ok: false }");
    expect(body).toContain("const wroteText = turnWroteText(lineRows);");
    expect(body).toContain("store.turnRowsBounded(event.threadId, completedTurnId!)");
    expect(src.match(/failedTurnLine\(/g)).toHaveLength(1);
    expect(body).toContain("wantsEmptyTurnLine(event, { ...lineContext,");
    expect(src.match(/emptyTurnLine\(/g)).toHaveLength(1);
  });
});
