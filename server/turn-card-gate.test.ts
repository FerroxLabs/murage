// The turn-card gate on its own: which scopes a Stop record holds back, and that a newer turn's cards are its own.
import { describe, expect, it, vi, afterEach } from "vitest";
import { createTurnCardGate } from "./turn-card-gate.ts";

afterEach(() => vi.restoreAllMocks());

describe("createTurnCardGate", () => {
  it("writes and returns true with no Stop record", () => {
    const gate = createTurnCardGate(); const card = vi.fn();
    expect(gate.write("runtime-error", { threadId: "T", turnId: "P" }, card)).toBe(true);
    expect(card).toHaveBeenCalledTimes(1);
  });
  it("a silent frozen lease holds the card back and logs the fixed line only", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const gate = createTurnCardGate(); const card = vi.fn();
    expect(gate.write("failed-line", { threadId: "T", lease: { frozenEnd: { kind: "silent" } } }, card)).toBe(false);
    expect({ card: card.mock.calls.length, log: info.mock.calls }).toEqual({ card: 0, log: [["[turn] card-suppressed site=failed-line after=owner-stop"]] });
  });
  it("a record matches its turn ids, its generation, and (while current) a turn no other live lease holds", () => {
    const live = new Set(["B1"]);
    const gate = createTurnCardGate({ liveTurnElsewhere: id => live.has(id) });
    gate.noteStop({ threadId: "T", generation: "G", turnIds: ["P"] });
    expect([gate.silenced({ threadId: "T", turnId: "P" }), gate.silenced({ threadId: "T", generation: "G" }),
      gate.silenced({ threadId: "T", turnId: "early" }), gate.silenced({ threadId: "T", turnId: "B1" }),
      gate.silenced({ threadId: "T", generation: "G2" }), gate.silenced({ threadId: "U", turnId: "P" })])
      .toEqual([true, true, true, false, false, false]);
  });
  it("W14/W15 a newer admitted generation ends the hold for new turns and keeps the stopped turn's ids", () => {
    const gate = createTurnCardGate();
    gate.noteStop({ threadId: "T", generation: "G", turnIds: [] });
    gate.attachTurn("G", "P");
    gate.admitted("T", "G2");
    expect([gate.silenced({ threadId: "T", turnId: "P2", generation: "G2" }), gate.silenced({ threadId: "T", turnId: "late" }),
      gate.silenced({ threadId: "T", turnId: "P" })]).toEqual([false, false, true]);
  });
  it("the Stop's own generation admitted again keeps the record current", () => {
    const gate = createTurnCardGate();
    gate.noteStop({ threadId: "T", generation: "G", turnIds: [] });
    gate.admitted("T", "G");
    expect(gate.silenced({ threadId: "T", turnId: "early" })).toBe(true);
  });
  it("W12 a room member Stop is per bot: another member's card still shows", () => {
    const gate = createTurnCardGate();
    gate.noteStop({ threadId: "R", botId: "X", turnIds: [] });
    expect([gate.silenced({ threadId: "R", botId: "X", generation: "gx" }), gate.silenced({ threadId: "R", botId: "Y", generation: "gy" })]).toEqual([true, false]);
    gate.admitted("R", "gy", "Y");
    expect(gate.silenced({ threadId: "R", botId: "X", generation: "gx" })).toBe(true);
  });
  it("Q the bus health warning (murage, no turn, no generation) is never held back", () => {
    const gate = createTurnCardGate();
    gate.noteStop({ threadId: "T", turnIds: [] });
    expect([gate.silenced({ threadId: "T", provider: "murage" }), gate.silenced({ threadId: "T", provider: "acp" })]).toEqual([false, true]);
  });
  it("the record list is bounded (FIFO 1000)", () => {
    const gate = createTurnCardGate();
    for (let i = 0; i <= 1_000; i++) gate.noteStop({ threadId: `T${i}`, generation: `G${i}`, turnIds: [] });
    expect([gate.silenced({ threadId: "T0", generation: "G0" }), gate.silenced({ threadId: "T1000", generation: "G1000" })]).toEqual([false, true]);
  });
});
