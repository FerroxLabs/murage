import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationBudget, MAX_HANDOFFS_PER_ROOT } from "./coordination-budget.ts";
import { resolveCoordinationTarget } from "./coordination-target.ts";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "murage-coordination-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe("bounded Chief coordination", () => {
  it("admits a lead's eight specialists under one owner chain", () => {
    const budget = new CoordinationBudget(join(directory, "budget.json"));
    const root = budget.begin("chief");
    const lead = budget.advance(root, "chief", "lead");
    const children = Array.from({ length: 8 }, (_, i) => budget.advance(lead, "lead", `specialist-${i}`));
    expect(children.map(child => child.path)).toEqual(Array.from({ length: 8 }, (_, i) => ["chief", "lead", `specialist-${i}`]));
    expect(() => budget.advance(children[0], "specialist-0", "fourth-tier")).toThrow("DEPTH_LIMIT");
  });
  it("prevents cycles and fabricated ancestry without consuming a valid path", () => {
    const budget = new CoordinationBudget(join(directory, "budget.json"));
    const root = budget.begin("chief");
    const lead = budget.advance(root, "chief", "lead");
    expect(() => budget.advance(lead, "lead", "chief")).toThrow("CYCLE");
    expect(() => budget.advance({ rootId: root.rootId, path: ["chief", "impostor"] }, "impostor", "target")).toThrow("ANCESTRY_INVALID");
    expect(() => budget.advance(lead, "other", "target")).toThrow("ALLOWANCE_UNAVAILABLE");
  });
  it("shares and preserves the root allowance across restarts and siblings", () => {
    const file = join(directory, "budget.json");
    const original = new CoordinationBudget(file), root = original.begin("chief");
    for (let i = 0; i < 8; i++) original.advance(root, "chief", `lead-${i}`);
    const restored = new CoordinationBudget(file);
    for (let i = 8; i < MAX_HANDOFFS_PER_ROOT; i++) restored.advance(root, "chief", `lead-${i}`);
    expect(() => restored.advance(root, "chief", "extra")).toThrow("BUDGET_EXHAUSTED");
    expect(() => new CoordinationBudget(file).advance(root, "chief", "extra")).toThrow("BUDGET_EXHAUSTED");
  });
  it("fails closed for missing, expired or malformed persisted allowance", () => {
    let now = 0;
    const file = join(directory, "budget.json"), budget = new CoordinationBudget(file, () => now), root = budget.begin("chief");
    expect(() => budget.advance(undefined, "chief", "target")).toThrow("ALLOWANCE_UNAVAILABLE");
    now = 24 * 60 * 60_000;
    expect(() => budget.advance(root, "chief", "target")).toThrow("ALLOWANCE_UNAVAILABLE");
    writeFileSync(file, "{truncated");
    expect(() => new CoordinationBudget(file)).toThrow("STATE_INVALID");
  });
});

describe("Murage target identity", () => {
  const lead = { id: "lead", name: "Katya", section: "Creator Studio", chiefOfStaff: true };
  const rook = { id: "rook", name: "Rook (Video)", section: "Creator Studio" };
  it("resolves stable IDs, display names and unique short labels", () => {
    for (const selector of ["rook", "Rook (Video)", "rook (video)", "Rook"]) {
      expect(resolveCoordinationTarget(lead, [lead, rook], selector).id).toBe("rook");
    }
  });
  it("rejects native session addresses, ambiguity and other teams", () => {
    const outsider = { id: "other", name: "Other", section: "Operations" };
    expect(() => resolveCoordinationTarget(lead, [lead, rook], "rook-88")).toThrow("BOT_NOT_ON_ROSTER");
    expect(() => resolveCoordinationTarget(lead, [lead, rook, { ...rook, id: "second", name: "Rook (Design)" }], "Rook")).toThrow("AMBIGUOUS");
    expect(() => resolveCoordinationTarget(lead, [lead, outsider], outsider.id)).toThrow("BOT_NOT_ON_ROSTER");
    expect(() => resolveCoordinationTarget(lead, [lead, { ...rook, hidden: true }], "rook")).toThrow("BOT_NOT_ON_ROSTER");
  });
});
