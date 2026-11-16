// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r3.4d fix-s1 reducer-driven tests (real restore-reducer.ts, driven directly from seeded states): the key-only Keep success reset (page S1) and the
// stale-target refusal in ownerKeep. Each test names the one-line reducer mutant that must turn it red (sed lines in the lane mutant script, not shipped).

import { describe, expect, it } from "vitest";
import type { HomeEvent, HomeState } from "./model.ts";
import { LOOK_AGAIN_LINE } from "./invariants.current.ts";
import { SEEDS } from "./seeds.ts";
import { reduceRestore } from "./restore-reducer.ts";

const NOW = 1_000_000;
const drive = (s: HomeState, event: HomeEvent) => { const hits: string[] = []; const r = reduceRestore(s, event, { hit: id => void hits.push(id) }); return { ...r, hits }; };
const ownerResult = (acts: { k: string }[]) => acts.filter(a => a.k === "ownerResult") as { k: "ownerResult"; ok: boolean; code?: string }[];
const owner = (s: HomeState, action: object) => drive(s, { e: "owner", nowMs: NOW, action: { principal: "owner_desktop", outcome: { ok: true }, ...action } as never });

describe("fix-s1 reducer-driven (real restore-reducer.ts)", () => {
  // MUTANT keep-key-only-resets-parked-only: the key-only success resets only removal_parked bindings.
  it("a key-only Keep (inbox-less target) on a removing provisioning-unknown bot leaves no binding removing and no lease (S1)", () => {
    const m = SEEDS.provisioningUnknown(); // b1 provisioning, no inbox id: target bot:b1
    const L = m.home.local;
    L.bindings.b1.state = "removing";
    L.leases.rmX = { removalId: "rmX", target: "bot:b1", inboxId: null, botId: "b1", authorityId: "aR", foreign: false, phase: "authorized", attemptId: null, attempts: [], keyTargets: [] } as never;
    L.intents.b1 = { botId: "b1", inboxId: null, keyId: "k1", phase: "committed", deletionProof: false } as never;
    const r = owner(m.home, { t: "owner.keep", botId: "b1", target: "bot:b1", tokenId: null, mode: "bot_section" });
    expect(ownerResult(r.actions)).toEqual([{ k: "ownerResult", ok: true }]);
    expect(r.hits).toContain("keep.ok.key_only");
    expect(r.state.local.bindings.b1.state).toBe("active");
    expect(r.state.local.leases).toEqual({});
    expect(r.state.local.intents.b1).toBeUndefined();
    expect(r.state.local.keptKeys.k1).toBeDefined();
  });

  // MUTANT keep-stale-target-accepted: drop the stale-target refusal in ownerKeep.
  it("Keep on bot:b1 for a bot bound to i1 is refused confirm_expired and changes nothing (active binding)", () => {
    const m = SEEDS.fresh(); // b1 active on i1
    const snap = (s: HomeState) => JSON.stringify([s.local.bindings, s.local.parks, s.local.leases, s.local.keepOps, s.local.keptKeys, s.local.keepGuards]);
    const before = snap(m.home);
    const r = owner(m.home, { t: "owner.keep", botId: "b1", target: "bot:b1", tokenId: null, mode: "bot_section" });
    expect(ownerResult(r.actions)).toEqual([{ k: "ownerResult", ok: false, code: "confirm_expired" }]);
    expect(r.hits).toContain("keep.refuse.confirm_expired");
    expect(r.state.surface.some(row => row.botId === "b1" && row.line === LOOK_AGAIN_LINE)).toBe(true);
    expect(r.actions.filter(a => a.k === "authorize")).toEqual([]);
    expect(snap(r.state)).toBe(before);
  });

  it("Keep on bot:b1 for a parked b1 (park target inbox:i1) is refused confirm_expired and keeps the park", () => {
    const m = SEEDS.legacy1018(); // b1 removing on i1, no lease: boot prep parks it
    const prepped = drive(m.home, { e: "bootPrep", nowMs: NOW, inject: "none" });
    expect(prepped.state.local.parks.b1?.target).toBe("inbox:i1");
    const r = owner(prepped.state, { t: "owner.keep", botId: "b1", target: "bot:b1", tokenId: null, mode: "bot_section" });
    expect(ownerResult(r.actions)).toEqual([{ k: "ownerResult", ok: false, code: "confirm_expired" }]);
    expect(r.state.surface.some(row => row.botId === "b1" && row.line === LOOK_AGAIN_LINE)).toBe(true);
    expect(r.state.local.parks.b1).toBeDefined();
    expect(r.state.local.keptKeys).toEqual(prepped.state.local.keptKeys);
  });
});
