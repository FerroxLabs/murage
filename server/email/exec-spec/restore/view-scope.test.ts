// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r3.4d viewMintsScopedTokens (machine-run fault, seed fresh, one move): owner.viewSurface mints a b token on the bot row, and the token's shown
// address must be the address of ITS OWN binding. Before the fix a SurfaceRow carried no address, so the token always displayed null.
// MUTANT M4 (s23-mutants.sh m4): the bot row stops carrying the binding address.

import { describe, expect, it } from "vitest";
import { DOMAIN_ONE } from "./domain.ts";
import { replay, makeRuntime } from "./checker.ts";
import { evalStep, ACTIVE_PREDICATES } from "./predicates.ts";
import { newCoverage } from "./report.ts";
import { SEEDS } from "./seeds.ts";
import { restoreReducer } from "./restore-reducer.ts";

describe("viewMintsScopedTokens driven through the real reducer", () => {
  it("fresh seed, one owner.viewSurface: every minted b token shows its own binding's address, and the predicate is clean", () => {
    const seed = SEEDS.fresh();
    const rt = makeRuntime(DOMAIN_ONE, restoreReducer, newCoverage());
    const r = replay(seed, [{ t: "owner.viewSurface", principal: "owner_desktop" }], rt);
    const bTokens = r.model.env.ghost.tokens.filter(t => t.kind === "b" && t.issuedAtStep === r.model.env.step);
    expect(bTokens.length).toBeGreaterThan(0);
    for (const t of bTokens) {
      const b = r.model.home.local.bindings[t.botId as string];
      expect(b.address).toBeTruthy();
      expect(t.shown.address).toBe(b.address);
    }
    const bad = r.steps.flatMap(s => evalStep(ACTIVE_PREDICATES, s.prev, s.action, s.next)).filter(v => !v.ok && v.invariant === "viewMintsScopedTokens");
    expect(bad).toEqual([]);
  });
});
