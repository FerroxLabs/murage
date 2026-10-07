// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { mayMessage, messageAllowBodySchema, normalizeMessageAllow, reverseGrantPatches } from "./message-allow.ts";
import type { BotRecord, GroupRecord } from "./store.ts";

const bot = (id: string, section: string, extra: Partial<BotRecord> = {}) => ({ id, name: id, section, ...extra }) as BotRecord;

describe("messageAllow (SPEC-P 3.12)", () => {
  it("absent or team means canReach alone", () => {
    expect(mayMessage(bot("a", "Ops"), bot("b", "Ops"))).toBe(true);
    expect(mayMessage(bot("a", "Ops"), bot("c", "Sales"))).toBe(false);
    expect(mayMessage(bot("a", "Ops", { messageAllow: { mode: "team" } }), bot("c", "Sales"))).toBe(false);
  });
  it("a list only widens", () => {
    const a = bot("a", "Ops", { messageAllow: { mode: "list", botIds: ["c"] } });
    expect(mayMessage(a, bot("c", "Sales"))).toBe(true);
    expect(mayMessage(a, bot("d", "Sales"))).toBe(false);
    expect(mayMessage(a, bot("b", "Ops"))).toBe(true);
  });
  it("inside a project, membership decides", () => {
    const room = { id: "g", memberIds: ["a", "c"], channelProject: { goal: "x", status: "active", startedAt: 1, updatedAt: 1 } } as unknown as GroupRecord;
    expect(mayMessage(bot("a", "Ops"), bot("c", "Sales"), { projectRoom: room })).toBe(true);
    expect(mayMessage(bot("a", "Ops"), bot("d", "Sales"), { projectRoom: room })).toBe(false);
    const channel = { ...room, channelProject: undefined } as GroupRecord;
    expect(mayMessage(bot("a", "Ops"), bot("c", "Sales"), { projectRoom: channel })).toBe(false);
  });
  it("never itself", () => {
    expect(mayMessage(bot("a", "Ops"), bot("a", "Ops"))).toBe(false);
  });
  it("validates the owner's body", () => {
    expect(messageAllowBodySchema.safeParse({ mode: "list", botIds: ["x"], extra: 1 }).success).toBe(false);
    const known = (id: string) => id !== "ghost";
    expect(normalizeMessageAllow({ mode: "team" }, "a", known)).toBeUndefined();
    expect(normalizeMessageAllow({ mode: "team", botIds: ["b"] }, "a", known)).toEqual({ error: "botIds are only for a list" });
    expect(normalizeMessageAllow({ mode: "list", botIds: ["b", "b"] }, "a", known)).toEqual({ mode: "list", botIds: ["b"] });
    expect(normalizeMessageAllow({ mode: "list", botIds: ["a"] }, "a", known)).toEqual({ error: "a bot cannot list itself" });
  });
  it("everyone reaches every visible bot, one direction at a time", () => {
    const sloane = bot("sloane", "Creator", { messageAllow: { mode: "all" } });
    const dax = bot("dax", "Sales");
    expect(mayMessage(sloane, dax)).toBe(true);
    expect(mayMessage(dax, sloane)).toBe(false);
    expect(mayMessage(sloane, bot("gone", "Sales", { hidden: true }))).toBe(false);
  });
  it("everyone does not widen a turn that is not the owner's", () => {
    const sloane = bot("sloane", "Creator", { messageAllow: { mode: "all" } });
    expect(mayMessage(sloane, bot("dax", "Sales"), { ownerAudience: false })).toBe(false);
    expect(mayMessage(sloane, bot("pal", "Creator"), { ownerAudience: false })).toBe(true);
  });
  it("picked bots are directional too", () => {
    const sloane = bot("sloane", "Creator", { messageAllow: { mode: "list", botIds: ["dax"] } });
    expect(mayMessage(sloane, bot("dax", "Sales"))).toBe(true);
    expect(mayMessage(bot("dax", "Sales"), sloane)).toBe(false);
  });
  it("accepts and stores all; legacy records stay team", () => {
    const known = () => true;
    expect(messageAllowBodySchema.safeParse({ mode: "all" }).success).toBe(true);
    expect(normalizeMessageAllow({ mode: "all" }, "a", known)).toEqual({ mode: "all" });
    expect(normalizeMessageAllow({ mode: "all", botIds: ["b"] }, "a", known)).toEqual({ error: "botIds are only for a list" });
    for (const legacy of [undefined, { mode: "team" as const }]) {
      expect(mayMessage(bot("a", "Ops", { messageAllow: legacy }), bot("c", "Sales"))).toBe(false);
    }
  });
  it("two-way writes a created grant; one-way removes only that", () => {
    const sloane = bot("sloane", "Creator", { messageAllow: { mode: "list", botIds: ["dax"] } });
    const dax = bot("dax", "Sales", { messageAllow: { mode: "list", botIds: ["kit"] } });
    expect(reverseGrantPatches(sloane, [], [dax]).size).toBe(0);
    const on = reverseGrantPatches(sloane, [dax], [dax], { dax: "two-way" });
    expect(on.get("dax")).toEqual({ mode: "list", botIds: ["kit", "sloane"], grantedBy: ["sloane"] });
    dax.messageAllow = on.get("dax");
    expect(mayMessage(dax, sloane)).toBe(true);
    const off = reverseGrantPatches(sloane, [dax], [dax], { dax: "one-way" });
    expect(off.get("dax")).toEqual({ mode: "list", botIds: ["kit"] });
  });
  it("never removes a grant the control did not create, and adding a pick deletes nothing", () => {
    const sloane = bot("sloane", "Creator", { messageAllow: { mode: "list", botIds: ["dax"] } });
    const dax = bot("dax", "Sales", { messageAllow: { mode: "list", botIds: ["sloane"] } });
    expect(reverseGrantPatches(sloane, [], [dax]).size).toBe(0);
    expect(reverseGrantPatches(sloane, [dax], [dax], { dax: "one-way" }).size).toBe(0);
    expect(reverseGrantPatches(sloane, [dax], []).size).toBe(0);
    const everyone = bot("sloane", "Creator", { messageAllow: { mode: "all" } });
    expect(reverseGrantPatches(everyone, [], [dax]).size).toBe(0);
  });
  it("removing a pick revokes the grant this control created", () => {
    const sloane = bot("sloane", "Creator");
    const dax = bot("dax", "Sales", { messageAllow: { mode: "list", botIds: ["sloane"], grantedBy: ["sloane"] } });
    expect(reverseGrantPatches(sloane, [dax], []).get("dax")).toBeUndefined();
    expect(reverseGrantPatches(sloane, [dax], []).has("dax")).toBe(true);
  });
  it("drops deleted bots from a saved list instead of refusing it", () => {
    expect(normalizeMessageAllow({ mode: "list", botIds: ["b", "ghost"] }, "a", (id) => id !== "ghost")).toEqual({ mode: "list", botIds: ["b"] });
  });
});
