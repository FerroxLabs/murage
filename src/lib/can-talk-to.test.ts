import { describe, expect, it } from "vitest";
import type { Bot } from "@/state/store";
import { everyoneState, pickedIds, rowState } from "./can-talk-to";

const bot = (id: string, section: string, extra: Partial<Bot> = {}) => ({ id, name: id, section, ...extra }) as Bot;

describe("Can talk to direction label", () => {
  it("uses the server reach rules: Chief and lead, Chief and individual, same team", () => {
    const chief = bot("chief", "Ops", { chiefOfStaff: true, chiefScope: "workspace" });
    const lead = bot("lead", "Sales", { chiefOfStaff: true });
    const solo = bot("solo", "Solo", { individual: true });
    const mate = bot("mate", "Ops");
    for (const other of [lead, solo, mate]) expect(rowState(chief, other)).toMatchObject({ label: "two-way", canChange: false });
    expect(rowState(bot("sloane", "Creator"), bot("dax", "Sales"))).toMatchObject({ label: "one-way", kind: "none", canChange: true });
  });
  it("tells a created grant from the other bot's own", () => {
    const sloane = bot("sloane", "Creator");
    expect(rowState(sloane, bot("dax", "Sales", { messageAllow: { mode: "list", botIds: ["sloane"], grantedBy: ["sloane"] } }))).toMatchObject({ label: "two-way", kind: "created", canChange: true });
    expect(rowState(sloane, bot("dax", "Sales", { messageAllow: { mode: "list", botIds: ["sloane"] } }))).toMatchObject({ label: "two-way", kind: "fixed-theirs", canChange: false });
    expect(rowState(sloane, bot("dax", "Sales", { messageAllow: { mode: "all" } }))).toMatchObject({ kind: "fixed-theirs", canChange: false });
  });
  it("shows Mixed for Everyone when some can start back", () => {
    const sloane = bot("sloane", "Creator", { messageAllow: { mode: "all" } });
    expect(everyoneState(sloane, [bot("a", "Sales"), bot("b", "Creator")]).label).toBe("mixed");
    expect(everyoneState(sloane, [bot("a", "Sales")]).label).toBe("one-way");
    expect(everyoneState(sloane, [bot("b", "Creator")])).toMatchObject({ label: "two-way", canChange: false });
  });
  it("never resubmits a deleted pick", () => {
    expect(pickedIds(bot("a", "X", { messageAllow: { mode: "list", botIds: ["b", "gone"] } }), [bot("b", "Y")])).toEqual(["b"]);
  });
});
