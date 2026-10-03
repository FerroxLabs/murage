import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  });
  it("never lets thousands of ordinary owner turns lock out the next one", () => {
    const file = join(directory, "budget.json"), budget = new CoordinationBudget(file);
    for (let i = 0; i < 5000; i++) budget.begin("routine-bot");
    const root = budget.begin("owner-bot");
    expect(budget.advance(root, "owner-bot", "lead").path).toEqual(["owner-bot", "lead"]);
    expect(existsSync(file) ? readFileSync(file, "utf8").length : 0).toBeLessThan(2000);
  });
  it("prunes expired persisted records and still enforces the limit on real fan-out", () => {
    let now = 0;
    const file = join(directory, "budget.json"), budget = new CoordinationBudget(file, () => now);
    budget.advance(budget.begin("a", "root-a"), "a", "x");
    expect(JSON.parse(readFileSync(file, "utf8")).roots).toHaveLength(1);
    now = 24 * 60 * 60_000;
    budget.advance(budget.begin("b", "root-b"), "b", "y");
    expect(JSON.parse(readFileSync(file, "utf8")).roots.map((r: { id: string }) => r.id)).toEqual(["root-b"]);
    const root = budget.begin("c", "root-c");
    for (let i = 0; i < MAX_HANDOFFS_PER_ROOT; i++) budget.advance(root, "c", `t-${i}`);
    expect(() => budget.advance(root, "c", "extra")).toThrow("BUDGET_EXHAUSTED");
  });
  it("quarantines a malformed roots file and starts with defaults", () => {
    const file = join(directory, "budget.json");
    writeFileSync(file, "{truncated");
    const budget = new CoordinationBudget(file, () => 1234);
    expect(existsSync(file)).toBe(false);
    const kept = readdirSync(directory).filter(name => name.startsWith("budget.json.invalid-"));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(directory, kept[0]), "utf8")).toBe("{truncated");
    expect(budget.advance(budget.begin("chief"), "chief", "lead").path).toEqual(["chief", "lead"]);
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
