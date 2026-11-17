// M5: the limit card's gate scope (putLimitLine, extracted from index.ts) over the real turn-card gate. The scope names the
// turn's generation and bot: a late limit line of a stopped turn stays held after a newer turn is admitted, and a room Stop
// for one member never holds back another member's limit line.
import { describe, expect, it, vi, afterEach } from "vitest";
import { source, wiring } from "./decision-wiring/fixture.ts";
import { createTurnCardGate } from "./turn-card-gate.ts";

afterEach(() => vi.restoreAllMocks());

function rig() {
  const appended: { threadId: string; tool: { name: string } }[] = [];
  const turnCardGate = createTurnCardGate();
  // limitCardScope is absent on the parent commit (the base replay): putLimitLine then runs with its old scope.
  const names = ["putLimitLine", ...(source.includes("function limitCardScope(") ? ["limitCardScope"] : [])];
  const built = wiring(names, {
    turnCardGate, murageLine: (line: unknown) => line,
    store: { scanNewest() {}, patchMessage: () => false, appendMessage: (threadId: string, message: { tool: { name: string } }) => { appended.push({ threadId, ...message }); } },
  });
  return { gate: turnCardGate, appended, built };
}
const turn = (generation: string, botId: string) => ({ textActivity: false, text: "", generation, botId });

describe("M5 the limit card's scope carries generation and bot", () => {
  it("under-hold: the stopped turn's late limit line, after a newer turn was admitted, writes no card", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = rig();
    r.gate.noteStop({ threadId: "T", generation: "G", turnIds: [] });
    r.gate.admitted("T", "G2");
    r.built.putLimitLine!("T", turn("G", "B"), "Fixture is at its limit.");
    expect(r.appended).toEqual([]);
  });
  it("under-hold, routine path: the run's scope (no limit turn) still names the stopped generation", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = rig();
    r.gate.noteStop({ threadId: "T", generation: "G", turnIds: [] });
    r.gate.admitted("T", "G2");
    r.built.putLimitLine!("T", undefined, "Fixture backup refused.", r.built.limitCardScope?.("T", { generation: "G", botId: "B" }));
    expect(r.appended).toEqual([]);
  });
  it("over-hold: a room Stop for member X leaves member Y's limit line in place", () => {
    const r = rig();
    r.gate.noteStop({ threadId: "R", botId: "X", turnIds: [] });
    r.built.putLimitLine!("R", turn("gy", "Y"), "Fixture is at its limit.");
    expect(r.appended.map(m => [m.threadId, m.tool.name])).toEqual([["R", "Fixture is at its limit."]]);
  });
  it("control: member X's own limit line stays held", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = rig();
    r.gate.noteStop({ threadId: "R", botId: "X", turnIds: [] });
    r.built.putLimitLine!("R", turn("gx", "X"), "Fixture is at its limit.");
    expect(r.appended).toEqual([]);
  });
  it("a newer turn's own limit line still shows (no over-hold across generations)", () => {
    const r = rig();
    r.gate.noteStop({ threadId: "T", generation: "G", turnIds: [] });
    r.gate.admitted("T", "G2");
    r.built.putLimitLine!("T", turn("G2", "B"), "Fixture is at its limit.");
    expect(r.appended.map(m => m.tool.name)).toEqual(["Fixture is at its limit."]);
  });
});
