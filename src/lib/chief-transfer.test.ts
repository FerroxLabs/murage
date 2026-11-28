// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { chiefTransferBlocksPatch, chiefTransferRoute, undoTouchesChief, workspaceChiefOf } from "./chief-transfer";

const bots = [{ id: "a", chiefOfStaff: true, chiefScope: "workspace" }, { id: "b" }, { id: "c", chiefOfStaff: true }];
describe("chief transfer routing rule (D2)", () => {
  it("routes a Chief election and a Chief demotion to the sheet, and nothing else", () => {
    expect(workspaceChiefOf(bots)?.id).toBe("a");
    expect(chiefTransferRoute(bots, bots[1]!, "chief")).toEqual({ from: "a", to: "b", source: "role" });
    expect(chiefTransferRoute(bots, bots[0]!, "member")).toEqual({ from: "a", source: "role" });
    expect(chiefTransferRoute(bots, bots[0]!, "leader")).toEqual({ from: "a", source: "role" });
    expect(chiefTransferRoute(bots, bots[0]!, "chief")).toBeNull();
    expect(chiefTransferRoute(bots, bots[1]!, "leader")).toBeNull();
    expect(chiefTransferRoute([{ id: "a" }, { id: "b" }], { id: "b" }, "chief")).toBeNull();
  });
  it("blocks only the patches the server refuses", () => {
    expect(chiefTransferBlocksPatch(bots, "a", { chiefOfStaff: false })).toBe(true);
    expect(chiefTransferBlocksPatch(bots, "a", { hidden: true })).toBe(true);
    expect(chiefTransferBlocksPatch(bots, "a", { chiefTier: "section" })).toBe(true);
    expect(chiefTransferBlocksPatch(bots, "b", { chiefOfStaff: true, chiefTier: "workspace" })).toBe(true);
    expect(chiefTransferBlocksPatch(bots, "b", { hidden: true })).toBe(false);
    expect(chiefTransferBlocksPatch(bots, "b", { chiefOfStaff: true, chiefTier: "section" })).toBe(false);
    expect(chiefTransferBlocksPatch(bots.slice(1), "b", { chiefTier: "workspace" })).toBe(false);
    expect(undoTouchesChief(bots, ["a", "b"])).toBe(true);
    expect(undoTouchesChief(bots, ["b"])).toBe(false);
  });
});
