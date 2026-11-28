// SPDX-License-Identifier: AGPL-3.0-or-later
// OVERREACH #5: who the server marks as the owner's own turn (the mark the power block reads). Table over every audience the dispatch records.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { decorateOwnerTurnInstance, installOwnerTurnResolver, isOwnerTurn, ownerTurnInput, setOwnerTurnResolver } from "./power-owner-adapter.ts";

afterEach(() => setOwnerTurnResolver(() => false));
const turn = (extra: Partial<SendTurnInput> = {}): SendTurnInput => ({ threadId: "t1", text: "hi", cwd: "/x", ...extra } as SendTurnInput);

describe("isOwnerTurn: the rule over the server's records", () => {
  const owner = { ownerAudience: true, notOwnerAudience: false };
  it.each([
    ["the owner typing in his own chat", { turn: owner, unattendedOrRoutine: false, ownerSurface: undefined, ancestry: false }, true],
    ["the owner's chat the owner can see", { turn: owner, unattendedOrRoutine: false, ownerSurface: true, ancestry: false }, true],
    ["a guest (not the owner's audience)", { turn: { ownerAudience: false, notOwnerAudience: true }, unattendedOrRoutine: false, ownerSurface: undefined, ancestry: false }, false],
    ["an owner-audience record that is also marked not-owner", { turn: { ownerAudience: true, notOwnerAudience: true }, unattendedOrRoutine: false, ownerSurface: undefined, ancestry: false }, false],
    ["a webhook, channel, routine or unproven origin", { turn: owner, unattendedOrRoutine: true, ownerSurface: undefined, ancestry: false }, false],
    ["a room the owner does not see", { turn: owner, unattendedOrRoutine: false, ownerSurface: false, ancestry: false }, false],
    ["an owner turn whose chain had a routine, wake or webhook hop (recorded ancestry)", { turn: owner, unattendedOrRoutine: false, ownerSurface: undefined, ancestry: true }, false],
    ["an owner turn with no recorded ancestry", { turn: owner, unattendedOrRoutine: false, ownerSurface: undefined, ancestry: undefined }, false],
    ["a thread with no turn record", { turn: undefined, unattendedOrRoutine: false, ownerSurface: undefined, ancestry: false }, false],
  ] as const)("%s -> %s", (_name, facts, expected) => { expect(isOwnerTurn(facts)).toBe(expected); });
});

describe("the registry decorator", () => {
  it("marks the turn only when the resolver says owner, and a caller cannot set the mark itself", () => {
    expect(ownerTurnInput(turn({ hostPowerOwnerTurn: true }))).not.toHaveProperty("hostPowerOwnerTurn"); // no resolver installed: wrapped
    setOwnerTurnResolver((id) => id === "t1");
    expect(ownerTurnInput(turn())).toMatchObject({ hostPowerOwnerTurn: true });
    expect(ownerTurnInput(turn({ threadId: "t2", hostPowerOwnerTurn: true }))).not.toHaveProperty("hostPowerOwnerTurn");
  });

  it("every sendTurn through a decorated instance reaches the engine adapter with the mark the resolver gave", () => {
    const sendTurn = vi.fn(async () => ({ turnId: "x" }));
    const live = { adapter: { sendTurn, other: () => "kept" } } as unknown as ProviderInstance;
    setOwnerTurnResolver(() => true);
    const decorated = decorateOwnerTurnInstance(live);
    void decorated.adapter.sendTurn(turn());
    expect(sendTurn).toHaveBeenCalledWith(expect.objectContaining({ hostPowerOwnerTurn: true }));
    expect((decorated.adapter as unknown as { other: () => string }).other()).toBe("kept");
  });
});

describe("the server's installation (index.ts hands over its records), through the decorator", () => {
  const records = new Map<string, { ownerAudience?: boolean; notOwnerAudience?: boolean }>([
    ["dm", { ownerAudience: true }], ["guest", { ownerAudience: false, notOwnerAudience: true }], ["hook", { ownerAudience: true }], ["chain", { ownerAudience: true }],
    ["unseen-room", { ownerAudience: true }], ["no-ancestry", { ownerAudience: true }],
  ]);
  const ancestry = new Map<string, boolean>([["dm", false], ["guest", false], ["hook", false], ["chain", true], ["unseen-room", false]]);
  it.each([
    ["the owner's own chat", "dm", true],
    ["a guest", "guest", false],
    ["a webhook, channel or routine turn (unattended)", "hook", false],
    ["an owner turn after a routine, wake or webhook hop earlier in the chain", "chain", false],
    ["a room the owner does not see", "unseen-room", false],
    ["an owner record with no recorded ancestry", "no-ancestry", false],
    ["a thread the server has no record for", "ghost", false],
  ] as const)("%s", (_name, threadId, expected) => {
    installOwnerTurnResolver({ turn: (id) => records.get(id), unattendedOrRoutine: (id) => id === "hook", ownerSurface: (id) => id === "unseen-room" ? false : undefined, ancestry: (id) => ancestry.get(id) });
    expect(Boolean(ownerTurnInput(turn({ threadId })).hostPowerOwnerTurn)).toBe(expected);
  });
});
