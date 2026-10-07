// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { resolveCoordinationTarget, outOfReachLine } from "./coordination-target.ts";
import { mayMessage } from "./message-allow.ts";
import type { BotRecord } from "./store.ts";

const bot = (id: string, name: string, section: string, extra: Partial<BotRecord> = {}) => ({ id, name, section, ...extra }) as BotRecord;

describe("resolveCoordinationTarget out of reach", () => {
  const sloane = bot("s1", "Sloane", "Creator");
  const dax = bot("d1", "Dax", "Sales");
  const roster = [sloane, dax];
  it("returns the exact owner-actionable line", () => {
    const run = () => resolveCoordinationTarget(sloane, roster, "Dax");
    expect(run).toThrow("Dax isn't in Sloane's team. To let Sloane talk to Dax, open Sloane's settings, Permissions, Can talk to, and add Dax. Or put them in a project together.");
    expect(outOfReachLine("Sloane", "Dax")).toBe("Dax isn't in Sloane's team. To let Sloane talk to Dax, open Sloane's settings, Permissions, Can talk to, and add Dax. Or put them in a project together.");
    expect(() => resolveCoordinationTarget(sloane, roster, "d1")).toThrow(/Can talk to/);
  });
  it("an unknown name still says not on roster", () => {
    expect(() => resolveCoordinationTarget(sloane, roster, "Nobody")).toThrow(/BOT_NOT_ON_ROSTER/);
  });
  it("picked and everyone settings resolve, one direction only", () => {
    const picked: BotRecord = { ...sloane, messageAllow: { mode: "list", botIds: ["d1"] } };
    expect(resolveCoordinationTarget(picked, roster, "Dax", (p) => mayMessage(picked, p)).id).toBe("d1");
    const all: BotRecord = { ...sloane, messageAllow: { mode: "all" } };
    expect(resolveCoordinationTarget(all, roster, "Dax", (p) => mayMessage(all, p)).id).toBe("d1");
    expect(() => resolveCoordinationTarget(dax, [all, dax], "Sloane", (p) => mayMessage(dax, p))).toThrow(/isn't in Dax's team/);
  });
  it("keeps the real refusal reason when the scope, not the team, blocked it", () => {
    const line = "Add Dax to this project to ask Dax here.";
    expect(() => resolveCoordinationTarget(sloane, roster, "Dax", () => false, () => line)).toThrow(line);
    expect(() => resolveCoordinationTarget(sloane, roster, "Dax", () => false, () => line)).not.toThrow(/Can talk to/);
  });
});
